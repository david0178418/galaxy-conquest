import ECSpresso from 'ecspresso';
import { createRenderer2DPlugin, createSpriteComponents } from 'ecspresso/plugins/rendering/renderer2D';
import { Application, Container, Graphics, Sprite, Texture, CanvasSource } from 'pixi.js';
import { COLORS, type Owner, type Side } from './config';
import type { Camera } from './camera';
import type { StarMap } from './maps';
import { isBlockaded, planets, shipsAt, orderUnits, unitPoint } from './game';
import type { Game, Order } from './game';
import { createRenderCandidates, type RenderSelection } from './render-candidates';
import { createShipPainter } from './ship-art';
import { canvasViewport, visibleMapViewport, mapClipInsets, dashedLine, shipDetailZoom, planetPlatformOrbitRadius } from './render-geometry';

interface RendererState {
	world: Game;
	map: StarMap;
	camera: Camera;
	fitScale: number;
	highlighted: Order | undefined;
}
interface RendererInspection {
	ships: number; totalShips: number; candidates: number; indexEntries: number; platforms: number; travelLines: number; textures: number; entities: number; tickerStarted: boolean; width: number; height: number; resolution: number;
}
interface RendererDependencies {
	canvas: HTMLCanvasElement;
	getState: () => RendererState;
	getPixelRatio: () => number;
	getViewport: () => { width: number; height: number };
	measure?: <T>(name: string, action: () => T) => T;
}
interface PlatformView {
	entityId: number;
	sprite: Sprite;
	textureKey: string;
}

const makeTexture = function (size: number, resolution: number, paint: (context: CanvasRenderingContext2D) => void): Texture {
	const canvas = document.createElement('canvas');
	canvas.width = size * resolution;
	canvas.height = size * resolution;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas 2D is required to prepare ship textures');
	context.scale(resolution, resolution);
	context.translate(size / 2, size / 2);
	paint(context);
	return new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
};

// Presentation-only ECS; no Pixi objects or renderer entities enter game saves.
export const createPixiRenderer = async function (dependencies: RendererDependencies): Promise<{
	draw: () => void;
	reset: () => void;
	inspect: () => RendererInspection;
	dispose: () => Promise<void>;
}> {
	const app = new Application();
	await app.init({ canvas: dependencies.canvas, width: 1, height: 1,
		preference: 'webgl', backgroundAlpha: 0, antialias: false,
		autoStart: false, sharedTicker: false, autoDensity: false, eventMode: 'none',
		eventFeatures: { move: false, click: false, wheel: false, globalMove: false } });
	const root = new Container();
	root.eventMode = 'none';
	app.stage.addChild(root);
	const presentation = ECSpresso.create()
		.withPlugin(createRenderer2DPlugin({ app, rootContainer: root, startLoop: false,
			renderLayers: ['background', 'routes', 'ships', 'effects'] }))
		.build();
	const background = new Graphics();
	const routes = new Graphics();
	const effects = new Graphics();
	const travelLines = new Container();
	const textures = new Map<string, Texture>();
	const fleet = new Map<number, { entityId: number; display: Container; hull: Sprite; badge: Sprite | undefined }>();
	const routeViews = new Map<number, Sprite>();
	const candidates = await createRenderCandidates();
	let counts = { totalShips: 0, candidates: 0, indexEntries: 0 };
	const platformViews = new Map<number, PlatformView[]>();
	let currentWorld: Game | undefined;
	let currentMap: StarMap | undefined;
	let disposal: Promise<void> | undefined;
	let disposed = false;
	try {
		await presentation.initialize();
		// Recreated hulls must retain unit order rather than append above survivors.
		for (const layer of root.children) layer.sortableChildren = true;
		for (const [graphics, renderLayer] of [[background, 'background'], [routes, 'routes'], [effects, 'effects']] as const) {
			presentation.spawn({ graphics, renderLayer });
		}
		presentation.spawn({ container: travelLines, renderLayer: 'routes' });
	} catch (error) {
		await candidates.dispose();
		await presentation.dispose().finally(function () {
			for (const graphics of [background, routes, effects]) graphics.destroy();
			travelLines.destroy({ children: true });
			app.destroy(false, { children: true });
		});
		throw error;
	}
	const texture = function (owner: Side, kind: 'ship' | 'transport', detail: 1 | 2 | 3): Texture {
		const key = `${owner}:${kind}:${detail}`;
		const cached = textures.get(key);
		if (cached) return cached;
		const created = makeTexture(32, 4, function (context) {
			const painter = createShipPainter(context);
			if (kind === 'ship') painter.warship(owner, detail === 3 ? 2.5 : detail === 2 ? 1.75 : 1);
			else painter.transport(owner, detail === 3 ? 2.5 : detail === 2 ? 1.75 : 1);
		});
		textures.set(key, created);
		return created;
	};
	const platformTextureKey = function (owner: Owner, detail: 1 | 2 | 3): string {
		return `platform:${owner}:${detail}`;
	};
	const platformTexture = function (owner: Owner, detail: 1 | 2 | 3): Texture {
		const key = platformTextureKey(owner, detail);
		const cached = textures.get(key);
		if (cached) return cached;
		const created = makeTexture(32, 4, function (context) {
			createShipPainter(context).defensePlatform(
				owner,
				detail === 3 ? 2.5 : detail === 2 ? 1.75 : 1,
			);
		});
		textures.set(key, created);
		return created;
	};
	// A one-world-unit stroke with transparent shoulders. Mipmaps preserve its
	// coverage when zoomed out, without full-frame multisample antialiasing.
	const travelTexture = function (): Texture {
		const cached = textures.get('travel-line');
		if (cached) return cached;
		const canvas = document.createElement('canvas');
		canvas.width = 8;
		canvas.height = 32;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas 2D is required to prepare route textures');
		context.fillStyle = '#ffffff';
		context.fillRect(0, 12, 8, 8);
		const created = new Texture({ source: new CanvasSource({ resource: canvas,
			resolution: 8, autoGenerateMipmaps: true, scaleMode: 'linear' }) });
		textures.set('travel-line', created);
		return created;
	};
	const cargoTextures = new Map<string, Texture>();
	const cargoTexture = function (owner: Side, cargo: number): Texture {
		const key = `${owner}:cargo:${cargo}`;
		const cached = cargoTextures.get(key);
		if (cached) return cached;
		// Loaded saves permit larger cargo values than normal production. Leave
		// room for the complete label, as the original Canvas text was unclipped.
		const created = makeTexture(Math.max(20, String(cargo).length * 7 + 2), 3, function (context) {
			context.fillStyle = '#10202b';
			context.beginPath();
			context.arc(0, 0, 8, 0, Math.PI * 2);
			context.fill();
			context.strokeStyle = COLORS[owner];
			context.lineWidth = 1;
			context.stroke();
			context.fillStyle = owner === 'blue' ? '#dcf7ff' : '#ffebe5';
			context.font = 'bold 10px ui-monospace, monospace';
			context.textAlign = 'center';
			context.textBaseline = 'middle';
			context.fillText(String(cargo), 0, 0);
		});
		cargoTextures.set(key, created);
		return created;
	};
	const clearFleet = function (): void {
		for (const { entityId, display } of fleet.values()) {
			presentation.removeEntity(entityId);
			display.destroy({ children: true });
		}
		fleet.clear();
		for (const route of routeViews.values()) route.destroy();
		routeViews.clear();
		candidates.reset();
		counts = { totalShips: 0, candidates: 0, indexEntries: 0 };
		for (const views of platformViews.values()) {
			for (const view of views) {
				presentation.removeEntity(view.entityId);
				view.sprite.destroy();
			}
		}
		platformViews.clear();
		for (const shared of cargoTextures.values()) shared.destroy(true);
		cargoTextures.clear();
	};
	const reset = function (): void { clearFleet(); currentWorld = undefined; };
	const draw = function (): void {
		if (disposed) return;
		const { world, map, camera, fitScale, highlighted } = dependencies.getState();
		if (world !== currentWorld) { clearFleet(); currentWorld = world; }
		const viewport = dependencies.getViewport();
		if (viewport.width <= 0 || viewport.height <= 0) return;
		const frame = visibleMapViewport(camera, viewport.width, viewport.height, map.width, map.height);
		const frameCamera = { ...camera, x: camera.x - frame.x, y: camera.y - frame.y };
		const resolution = Math.min(dependencies.getPixelRatio() || 1, 3);
		if (app.screen.width !== frame.width || app.screen.height !== frame.height || app.renderer.resolution !== resolution) {
			app.renderer.resize(frame.width, frame.height, resolution);
		}
		const box = canvasViewport(frameCamera, frame.width, frame.height);
		const style = dependencies.canvas.style;
		style.left = `${box.left}px`; style.top = `${box.top}px`;
		style.width = `${box.width}px`; style.height = `${box.height}px`;
		// Preserve the old map-canvas clip without a full-frame GPU stencil pass.
		const clip = mapClipInsets(frameCamera, frame.width, frame.height, map.width, map.height);
		style.clipPath = `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px)`;
		root.position.set(frameCamera.x, frameCamera.y);
		root.scale.set(camera.scale);
		if (map !== currentMap) {
			background.clear();
			for (let i = 0; i < 460; i++) {
				background.rect((i * 137.57) % map.width, (i * 83.37) % map.height, i % 5 === 0 ? 1.8 : 1, i % 5 === 0 ? 1.8 : 1)
					.fill(i % 4 === 0 ? '#738ea45c' : '#42627b55');
			}
			currentMap = map;
		}
		routes.clear(); effects.clear();
		const match = world.getResource('match');
		const zoom = camera.scale / fitScale;
		for (const { id, components: { planet: p } } of planets(world)) {
			if (p.carrier?.destination) {
				routes.moveTo(p.x, p.y).lineTo(p.carrier.destination.x, p.carrier.destination.y).stroke({ color: COLORS[p.owner], alpha: 0.6, width: 1.5 / camera.scale });
				routes.circle(p.carrier.destination.x, p.carrier.destination.y, 5 / camera.scale).stroke({ color: COLORS[p.owner], width: 1 / camera.scale });
			}
			routes.circle(p.x, p.y, p.radius + 20).stroke({ color: '#4d739517', width: 1 });
			const platformCount = Math.max(0, Math.ceil(p.guns));
			const existingPlatforms = platformViews.get(id) ?? [];
			while (existingPlatforms.length > platformCount) {
				const removed = existingPlatforms.pop();
				if (!removed) continue;
				presentation.removeEntity(removed.entityId);
				removed.sprite.destroy();
			}
			if (platformCount > 0) {
				const orbitRadius = planetPlatformOrbitRadius(p.radius);
				routes.circle(p.x, p.y, orbitRadius).stroke({
					color: COLORS[p.owner],
					alpha: 0.13,
					width: 1,
				});
				const detail = shipDetailZoom(zoom);
				const key = platformTextureKey(p.owner, detail);
				for (let index = 0; index < platformCount; index++) {
					let view = existingPlatforms[index];
					if (!view) {
						const sprite = new Sprite(platformTexture(p.owner, detail));
						sprite.anchor.set(0.5);
						const entity = presentation.spawn({
							...createSpriteComponents(sprite),
							renderLayer: 'ships',
						});
						view = { entityId: entity.id, sprite, textureKey: key };
						existingPlatforms.push(view);
					}
					if (view.textureKey !== key) {
						view.sprite.texture = platformTexture(p.owner, detail);
						view.textureKey = key;
					}
					const angle =
						match.time * 0.12 + (Math.PI * 2 * index) / platformCount;
					const transform = presentation.getComponent(
						view.entityId,
						'localTransform',
					);
					if (transform) {
						transform.x = p.x + Math.cos(angle) * orbitRadius;
						transform.y = p.y + Math.sin(angle) * orbitRadius;
						transform.rotation = angle;
						presentation.markChanged(view.entityId, 'localTransform');
					}
				}
				platformViews.set(id, existingPlatforms);
			} else platformViews.delete(id);
			const blue = shipsAt(world, id, 'blue').length;
			const red = shipsAt(world, id, 'red').length;
			if ((blue > 0 && p.owner !== 'blue') || (red > 0 && p.owner !== 'red')) {
				const color = blue > 0 && p.owner !== 'blue' ? COLORS.blue : COLORS.red;
				const radius = p.radius + 17;
				if (isBlockaded(world, id)) {
					// Canvas lineDashOffset = -time*10; dash starts advance clockwise.
					for (let start = (match.time * 10) % 12 - 12; start < Math.PI * 2 * radius; start += 12) {
						const a = Math.max(0, start) / radius;
						const b = Math.min(Math.PI * 2 * radius, start + 6) / radius;
						if (b > a) routes.moveTo(p.x + Math.cos(a) * radius, p.y + Math.sin(a) * radius)
							.arc(p.x, p.y, radius, a, b).stroke({ color, width: 2 });
					}
				} else routes.circle(p.x, p.y, radius).stroke({ color, width: 1 });
			}
			if ((blue > 0 || (p.owner === 'blue' && p.guns > 0)) && (red > 0 || (p.owner === 'red' && p.guns > 0))) {
				const angle = match.time * 4;
				routes.moveTo(p.x + Math.cos(angle) * (p.radius + 19), p.y + Math.sin(angle) * (p.radius + 19))
					.lineTo(p.x - Math.cos(angle) * (p.radius + 19), p.y - Math.sin(angle) * (p.radius + 19))
					.stroke({ color: '#ffe3a9', width: 1.7 });
			}
		}
		if (highlighted) {
			for (const entity of orderUnits(world, highlighted)) {
				const u = entity.components.unit;
				const target = world.getComponent(u.target, 'planet');
				if (!target) continue;
				const point = unitPoint(u, target, match.time, entity.id);
				const segments = highlighted.state === 'pending'
					? dashedLine(point, target, 8 / camera.scale, 5 / camera.scale)
					: [[point, target]] as const;
				for (const [from, to] of segments) routes.moveTo(from.x, from.y).lineTo(to.x, to.y);
			}
			routes.stroke({ color: COLORS.blue, width: 2 / camera.scale });
		}
		const select = function (): RenderSelection { return candidates.select(world, camera, viewport.width, viewport.height, zoom >= 3.5, map); };
		const selected = dependencies.measure ? dependencies.measure('render.index', select) : select();
		counts = { totalShips: selected.all.length, candidates: selected.candidates, indexEntries: selected.entries };
		// Lines are independent of hull candidates: either endpoint can be offscreen.
		const traveling = new Set<number>();
		for (const { id, components: { unit: u } } of selected.all) {
			if (u.hp <= 0 || u.phase !== 'travel') continue;
			const target = world.getComponent(u.target, 'planet');
			if (!target) continue;
			traveling.add(id);
			const point = unitPoint(u, target, match.time, id);
			let route = routeViews.get(id);
			if (!route) {
				route = new Sprite(travelTexture());
				route.anchor.set(0, 0.5);
				route.alpha = 0x22 / 255;
				travelLines.addChild(route);
				routeViews.set(id, route);
			}
			const dx = target.x - point.x;
			const dy = target.y - point.y;
			route.position.set(point.x, point.y);
			route.rotation = Math.atan2(dy, dx);
			route.width = Math.hypot(dx, dy);
			route.height = 4;
			route.tint = COLORS[u.owner];
		}
		for (const [id, route] of routeViews) {
			if (traveling.has(id)) continue;
			route.destroy(); routeViews.delete(id);
		}
		const live = new Set<number>();
		for (const [drawOrder, { id, components: { unit: u } }] of selected.visible.entries()) {
			const target = world.getComponent(u.target, 'planet');
			if (!target) continue;
			live.add(id);
			const point = unitPoint(u, target, match.time, id);
			let view = fleet.get(id);
			if (!view) {
				const hull = new Sprite(); hull.anchor.set(0.5);
				const entity = presentation.spawn({ ...createSpriteComponents(hull), renderLayer: 'ships' });
				view = { entityId: entity.id, display: hull, hull, badge: undefined };
				fleet.set(id, view);
			}
			view.hull.texture = texture(u.owner, u.kind, shipDetailZoom(zoom));
			const showCargo = u.kind === 'transport' && zoom >= 3.5;
			if (showCargo && !view.badge) {
				// Sprite children are deprecated in Pixi v8. Promote only ships that
				// need a badge, preserving their existing order within the fleet layer.
				const parent = view.hull.parent;
				const index = parent?.getChildIndex(view.hull);
				presentation.removeComponent(view.entityId, 'sprite');
				const container = new Container();
				view.badge = new Sprite();
				view.badge.anchor.set(0.5);
				view.hull.position.set(0);
				view.hull.rotation = 0;
				view.hull.scale.set(1);
				container.addChild(view.hull, view.badge);
				presentation.addComponent(view.entityId, 'container', container);
				// renderer2D gates sync on changed worldTransform, even for a newly
				// attached display component. Paused promotion needs an initial sync.
				presentation.markChanged(view.entityId, 'worldTransform');
				if (parent && index !== undefined) parent.setChildIndex(container, index);
				view.display = container;
			}
			view.display.zIndex = drawOrder + 1;
			if (view.badge) view.badge.visible = showCargo;
			if (showCargo && view.badge) {
				view.badge.texture = cargoTexture(u.owner, u.cargo);
				view.badge.rotation = -point.angle;
				view.badge.scale.set(1 / camera.scale);
			}
			const transform = presentation.getComponent(view.entityId, 'localTransform');
			if (transform) {
				transform.x = point.x; transform.y = point.y; transform.rotation = point.angle;
				presentation.markChanged(view.entityId, 'localTransform');
			}
		}
		for (const [id, view] of fleet) {
			if (live.has(id)) continue;
			presentation.removeEntity(view.entityId);
			view.display.destroy({ children: true });
			fleet.delete(id);
		}
		for (const shot of match.engagements) {
			effects.moveTo(shot.x1, shot.y1).lineTo(shot.x2, shot.y2).stroke({ color: COLORS[shot.owner], alpha: 0.35, width: 6, cap: 'round' });
			effects.moveTo(shot.x1, shot.y1).lineTo(shot.x2, shot.y2).stroke({ color: COLORS[shot.owner], alpha: 0.95, width: 2, cap: 'round' });
		}
		// Transform propagation and scene wiring run even while gameplay is paused.
		presentation.update(0);
		app.render();
	};
	const dispose = function (): Promise<void> {
		if (disposal) return disposal;
		disposed = true;
		clearFleet();
		disposal = Promise.all([candidates.dispose(), presentation.dispose()]).then(function () {}).finally(function () {
			// The plugin detaches display components; the adapter owns destruction.
			for (const graphics of [background, routes, effects]) graphics.destroy();
			travelLines.destroy({ children: true });
			app.destroy(false, { children: true });
			for (const shared of textures.values()) shared.destroy(true);
			textures.clear();
		});
		return disposal;
	};
	const inspect = function (): RendererInspection {
		return { ships: fleet.size, ...counts, platforms: [...platformViews.values()].reduce(function (count, views) { return count + views.length; }, 0),
			travelLines: travelLines.children.length, textures: textures.size + cargoTextures.size, entities: presentation.entityCount,
			tickerStarted: app.ticker.started, width: app.screen.width, height: app.screen.height, resolution: app.renderer.resolution };
	};
	return { draw, reset, inspect, dispose };
};
