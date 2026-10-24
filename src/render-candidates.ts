import ECSpresso from 'ecspresso';
import { createSpatialIndexPlugin } from 'ecspresso/plugins/spatial/spatial-index';
import type { Camera, Point } from './camera';
import { units, unitPoint, type Game } from './game';

type UnitEntity = ReturnType<typeof units>[number];
export interface WorldViewport {
	left: number; top: number; right: number; bottom: number;
}
export const worldViewport = function (camera: Camera, width: number, height: number): WorldViewport {
	return { left: -camera.x / camera.scale, top: -camera.y / camera.scale,
		right: (width - camera.x) / camera.scale, bottom: (height - camera.y) / camera.scale };
};
export const pointInViewport = function (point: Point, viewport: WorldViewport, margin: number): boolean {
	return point.x + margin >= viewport.left && point.x - margin <= viewport.right &&
		point.y + margin >= viewport.top && point.y - margin <= viewport.bottom;
};
// A rotated 32-world-unit texture fits inside this radius. Cargo badges remain
// screen-sized, including labels from saves with more than the normal cargo.
export const unitRenderMargin = function (cargo: number, scale: number, showCargo: boolean): number {
	return Math.max(23, showCargo ? Math.max(20, String(cargo).length * 7 + 2) / 2 / scale : 0);
};

export interface RenderSelection {
	all: UnitEntity[]; visible: UnitEntity[]; candidates: number; entries: number;
}
export interface RenderCandidates {
	select: (world: Game, camera: Camera, width: number, height: number, showCargo: boolean, map?: { width: number; height: number }) => RenderSelection;
	reset: () => void;
	dispose: () => Promise<void>;
}
export const createRenderCandidates = async function (): Promise<RenderCandidates> {
	// The combat index deliberately excludes orbiters and is rebuilt before some
	// gameplay mutations. This separate world has bounds only, no gameplay systems.
	const indexWorld = ECSpresso.create()
		.withPlugin(createSpatialIndexPlugin({ cellSize: 128, phases: ['postUpdate'] }))
		.build();
	await indexWorld.initialize();
	const groups = new Map<string, { id: number; members: UnitEntity[] }>();
	const byId = new Map<number, UnitEntity[]>();
	const reset = function (): void {
		for (const group of groups.values()) indexWorld.removeEntity(group.id);
		groups.clear(); byId.clear();
	};
	const select = function (world: Game, camera: Camera, width: number, height: number, showCargo: boolean, map?: { width: number; height: number }): RenderSelection {
		const all = units(world).filter(function (entity) { return entity.components.unit.phase !== 'docked'; });
		const viewport = worldViewport(camera, width, height);
		// At fit the canvas already clips to the complete map. Indexing cannot
		// remove visible work there; avoid paying its maintenance cost.
		if (map && viewport.left <= 0 && viewport.top <= 0 && viewport.right >= map.width && viewport.bottom >= map.height) {
			reset();
			return { all, visible: all.filter(function (entity) {
				return entity.components.unit.hp > 0 && world.getComponent(entity.components.unit.target, 'planet') !== undefined;
			}), candidates: all.length, entries: 0 };
		}
		for (const group of groups.values()) group.members.length = 0;
		let margin = 23;
		for (const entity of all) {
			const unit = entity.components.unit;
			const target = world.getComponent(unit.target, 'planet');
			if (unit.hp <= 0 || !target) continue;
			margin = Math.max(margin, unitRenderMargin(unit.cargo, camera.scale, showCargo && unit.kind === 'transport'));
			const orbit = unit.phase === 'orbit';
			const key = orbit ? `planet:${unit.target}` : `unit:${entity.id}`;
			const x = orbit ? target.x : unit.x;
			const y = orbit ? target.y : unit.y;
			// One conservative bound per planet covers both ship and transport orbits.
			const radius = orbit ? target.radius + 32 : 0;
			let group = groups.get(key);
			if (!group) {
				const entry = indexWorld.spawn({
					worldTransform: { x, y, rotation: 0, scaleX: 1, scaleY: 1 },
					circleCollider: { radius },
				});
				group = { id: entry.id, members: [] };
				groups.set(key, group);
				byId.set(entry.id, group.members);
			} else if (group.members.length === 0) {
				const transform = indexWorld.getComponent(group.id, 'worldTransform');
				const bounds = indexWorld.getComponent(group.id, 'circleCollider');
				if (transform) { transform.x = x; transform.y = y; }
				if (bounds) bounds.radius = radius;
			}
			group.members.push(entity);
		}
		for (const [key, group] of groups) {
			if (group.members.length) continue;
			indexWorld.removeEntity(group.id);
			byId.delete(group.id); groups.delete(key);
		}
		indexWorld.update(0);
		const ids = indexWorld.getResource('spatialIndex').queryRect(
			viewport.left - margin, viewport.top - margin, viewport.right + margin, viewport.bottom + margin);
		const candidates = new Set<number>();
		for (const id of ids) for (const entity of byId.get(id) ?? []) candidates.add(entity.id);
		const time = world.getResource('match').time;
		const visible = all.filter(function (entity) {
			if (!candidates.has(entity.id)) return false;
			const unit = entity.components.unit;
			const target = world.getComponent(unit.target, 'planet');
			return target !== undefined && pointInViewport(unitPoint(unit, target, time, entity.id), viewport,
				unitRenderMargin(unit.cargo, camera.scale, showCargo && unit.kind === 'transport'));
		});
		return { all, visible, candidates: candidates.size, entries: groups.size };
	};
	return { select, reset, dispose: function (): Promise<void> { reset(); return indexWorld.dispose(); } };
};
