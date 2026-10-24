import ECSpresso, {
	defineSystemRef,
	type FilteredEntity,
	type WithComponents,
	type WithResources,
} from 'ecspresso';
import {
	createSpatialIndexPlugin,
	spatialIndexSystems,
} from 'ecspresso/plugins/spatial/spatial-index';
import { createDiagnosticsPlugin, type DiagnosticsResourceTypes } from 'ecspresso/plugins/debug/diagnostics';
import { CONFIG } from './config';
import { runAI } from './ai';
import { registerCombat } from './combat';
import { registerMovement, registerTravelerCleanup } from './movement';
import { initializeLabScenario, seedFreshGame } from './game-scenario';
import { LAB_MAP } from './maps';
import type { StarMap } from './maps';
import type {
	DispatchFilter,
	Owner,
	Production,
	Scenario,
	Side,
} from './config';
import type { GameSnapshot } from './save-state';

export interface Carrier {
	destination: { x: number; y: number } | null;
	heading: number;
}
export interface Planet {
	carrier?: Carrier;
	name: string;
	x: number;
	y: number;
	radius: number;
	owner: Owner;
	troops: number;
	guns: number;
	rate: number;
	production: Production;
	progress: number;
}
export interface Unit {
	owner: Side;
	kind: 'ship' | 'transport';
	x: number;
	y: number;
	target: number;
	phase: 'travel' | 'orbit' | 'docked';
	hp: number;
	cargo: number;
	age: number;
}
export interface Departure {
	phase?: 'orbit' | 'docked';
	unitId: number;
	source: number;
	x: number;
	y: number;
	age: number;
}
export interface Order {
	id: number;
	owner: Side;
	target: number;
	state: 'pending' | 'outbound' | 'returning';
	departures: Departure[];
}
export interface OrderBook {
	nextId: number;
	active: Order[];
}
export interface Notice {
	text: string;
	time: number;
	side: Owner;
}
export interface Engagement {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	owner: Side;
}
export interface Match {
	time: number;
	paused: boolean;
	winner: Side | null;
	ai: boolean;
	aiClock: number;
	orders: number;
	captures: number;
	transportsLost: number;
	troopsLost: number;
	firstCapture: number | null;
	notices: Notice[];
	engagements: Engagement[];
}
export interface CaptureEvent {
	planetId: number;
	previousOwner: Owner;
	owner: Side;
}
export interface GameOptions {
	evaluateWinner?: (world: Game) => Side | null;
	onCapture?: (event: CaptureEvent, world: Game) => void;
	seed?: (world: Game, map: StarMap) => void;
}
const economySystem = defineSystemRef('economy');
const movementSystem = defineSystemRef('movement');
const combatSystem = defineSystemRef('combat');
const strategySystem = defineSystemRef('strategy');
const spatialIndexPlugin = createSpatialIndexPlugin({
	cellSize: 64,
	phases: ['fixedUpdate'],
	ordering: { fixedUpdate: { after: [economySystem], before: [movementSystem] } },
});
type SpatialIndexConfig = NonNullable<typeof spatialIndexPlugin['_cfg']>;
type GameConfig = WithResources<
	WithComponents<SpatialIndexConfig, { planet: Planet; unit: Unit }>,
	DiagnosticsResourceTypes & { match: Match; orderBook: OrderBook; diagnosticsLifetime: { dispose: () => void }; mapBounds: { width: number; height: number } }
>;
export type Game = ECSpresso<GameConfig>;
type PlanetEntity = FilteredEntity<GameConfig['components'], 'planet'>;
type UnitEntity = FilteredEntity<GameConfig['components'], 'unit'>;
type UnitPoint = { x: number; y: number; angle: number };
type LocalTransform = GameConfig['components']['localTransform'];

const localTransformAt = function (x: number, y: number): LocalTransform {
	return { x, y, rotation: 0, scaleX: 1, scaleY: 1 };
};
const syncUnitPosition = function (
	world: Game,
	unitId: number,
	x: number,
	y: number,
): void {
	const localTransform = world.getComponent(unitId, 'localTransform');
	if (localTransform) {
		localTransform.x = x;
		localTransform.y = y;
		return;
	}
	world.addComponent(unitId, 'localTransform', localTransformAt(x, y));
};
const makeWorld = function (map: StarMap): Game {
	const match: Match = {
		time: 0,
		paused: false,
		winner: null,
		ai: true,
		aiClock: 0,
		orders: 0,
		captures: 0,
		transportsLost: 0,
		troopsLost: 0,
		firstCapture: null,
		notices: [],
		engagements: [],
	};
	const orderBook: OrderBook = { nextId: 1, active: [] };
	return ECSpresso.create()
		.withPlugin(spatialIndexPlugin)
		.withPlugin(createDiagnosticsPlugin({ enableTimingOnInit: false }))
		.withResource('diagnosticsLifetime', { dispose: function (): void {} })
		.withComponentTypes<{ planet: Planet; unit: Unit }>()
		.withResource('match', match)
		.withResource('mapBounds', { width: map.width, height: map.height })
		.withResource('orderBook', orderBook)
		.withFixedTimestep(CONFIG.step)
		.build();
};
const restoreSnapshot = function (world: Game, snapshot: GameSnapshot): void {
	const planetIds = new Map<number, number>();
	const entityIds = new Map<number, number>();
	for (const saved of snapshot.planets) {
		const restored = world.spawn({ planet: structuredClone(saved.planet) });
		planetIds.set(saved.id, restored.id);
		entityIds.set(saved.id, restored.id);
	}
	for (const saved of snapshot.units) {
		const target = planetIds.get(saved.unit.target);
		if (target === undefined) throw new Error('Saved unit target is missing');
		const unit = structuredClone(saved.unit);
		unit.target = target;
		const restored = world.spawn({
			unit,
			localTransform: localTransformAt(unit.x, unit.y),
			...(unit.phase === 'travel' ? { circleCollider: { radius: 0 } } : {}),
		});
		entityIds.set(saved.id, restored.id);
	}
	const match = world.getResource('match');
	Object.assign(match, structuredClone(snapshot.match), {
		paused: true,
		engagements: [],
	});
	const orderBook = world.getResource('orderBook');
	orderBook.nextId = snapshot.orderBook.nextId;
	orderBook.active = snapshot.orderBook.active.map(function (savedOrder) {
		const target = planetIds.get(savedOrder.target);
		if (target === undefined) throw new Error('Saved order target is missing');
		return {
			...structuredClone(savedOrder),
			target,
			departures: savedOrder.departures.map(function (savedDeparture) {
				const source = planetIds.get(savedDeparture.source);
				const unitId = entityIds.get(savedDeparture.unitId);
				if (source === undefined || unitId === undefined)
					throw new Error('Saved order reference is missing');
				return { ...savedDeparture, source, unitId };
			}),
		};
	});
	// Rebuild the plugin's derived spatial data with gameplay paused.
	world.update(CONFIG.step);
};
export const planets = function (world: Game): PlanetEntity[] {
	return world.getEntitiesWithQuery(['planet']);
};
export const units = function (world: Game): UnitEntity[] {
	return world.getEntitiesWithQuery(['unit']);
};
export const orbitalUnits = function (
	world: Game,
	planetId: number,
	side?: Side,
): UnitEntity[] {
	return units(world).filter(function ({ components: { unit } }) {
		return (
			unit.target === planetId &&
			unit.phase === 'orbit' &&
			unit.hp > 0 &&
			(!side || unit.owner === side)
		);
	});
};
export const shipsAt = function (
	world: Game,
	planetId: number,
	side: Side,
): UnitEntity[] {
	return orbitalUnits(world, planetId, side).filter(function (entity) {
		return entity.components.unit.kind === 'ship';
	});
};
export const dockedShips = function (world: Game, host: number, side?: Side): UnitEntity[] {
	return units(world).filter(function ({ components: { unit } }) {
		return unit.target === host && unit.phase === 'docked' && unit.kind === 'ship' && unit.hp > 0 && (!side || unit.owner === side);
	});
};
export const availableShips = function (world: Game, host: number, side: Side): UnitEntity[] {
	return [...shipsAt(world, host, side), ...dockedShips(world, host, side)];
};
// Launch locally to contest a blockade without assigning a new destination.
export const launchCarrierShips = function (world: Game, id: number, fraction = 1, side: Side = 'blue'): number {
	const host = world.getComponent(id, 'planet');
	if (!host?.carrier || host.owner !== side || world.getResource('match').winner || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return 0;
	const stored = dockedShips(world, id, side);
	const launching = stored.slice(0, Math.ceil(stored.length * fraction));
	for (const entity of launching) {
		entity.components.unit.phase = 'orbit';
		entity.components.unit.x = host.x;
		entity.components.unit.y = host.y;
	}
	return launching.length;
};
export const moveCarrier = function (world: Game, id: number, destination: { x: number; y: number }, side: Side = 'blue'): boolean {
	const p = world.getComponent(id, 'planet');
	const bounds = world.getResource('mapBounds');
	if (destination.x < 0 || destination.y < 0 || destination.x > bounds.width || destination.y > bounds.height) return false;
	if (!p?.carrier || p.owner !== side || world.getResource('match').winner || !Number.isFinite(destination.x) || !Number.isFinite(destination.y)) return false;
	p.carrier.destination = { ...destination };
	return true;
};
export const unitPoint = function (
	unit: Unit,
	planet: Planet,
	time: number,
	id: number,
): UnitPoint {
	if (unit.phase === 'docked') return { x: planet.x, y: planet.y, angle: planet.carrier?.heading ?? 0 };
	if (unit.phase !== 'orbit') {
		return {
			x: unit.x,
			y: unit.y,
			angle: Math.atan2(planet.y - unit.y, planet.x - unit.x),
		};
	}
	const orbitAngle =
		time * (unit.owner === 'blue' ? 0.45 : -0.45) + id * 2.399;
	const reach = planet.radius + (unit.kind === 'ship' ? 20 : 32);
	return {
		x: planet.x + Math.cos(orbitAngle) * reach,
		y: planet.y + Math.sin(orbitAngle) * reach,
		angle: orbitAngle + Math.PI / 2,
	};
};
export const opponent = function (side: Side): Side {
	return side === 'blue' ? 'red' : 'blue';
};
export const isBlockaded = function (world: Game, planetId: number): boolean {
	const planet = world.getComponent(planetId, 'planet');
	if (!planet || planet.owner === 'neutral') return false;
	return (
		shipsAt(world, planetId, opponent(planet.owner)).length > 0 &&
		shipsAt(world, planetId, planet.owner).length === 0 &&
		planet.guns <= 0
	);
};
export const notify = function (
	world: Game,
	text: string,
	side: Owner = 'neutral',
): void {
	const match = world.getResource('match');
	match.notices = [{ text, time: match.time, side }, ...match.notices].slice(
		0,
		5,
	);
};
export const spawnShip = function (
	world: Game,
	planetId: number,
	owner: Side,
): UnitEntity | undefined {
	const p = world.getComponent(planetId, 'planet');
	if (!p) return;
	return world.spawn({
		localTransform: localTransformAt(p.x, p.y),
		unit: {
			owner,
			kind: 'ship',
			x: p.x,
			y: p.y,
			target: planetId,
			phase: p.carrier && p.owner === owner ? 'docked' : 'orbit',
			hp: CONFIG.shipHealth,
			cargo: 0,
			age: 0,
		},
	});
};
export const setProduction = function (
	world: Game,
	ids: readonly number[],
	production: Production,
	side: Side = 'blue',
): void {
	for (const id of ids) {
		const p = world.getComponent(id, 'planet');
		if (!p || p.owner !== side || (p.carrier && production === 'guns') || p.production === production) continue;
		p.production = production;
		p.progress = 0;
	}
};
export const dispatch = function (
	world: Game,
	sources: readonly number[],
	target: number,
	fraction: number,
	filter: DispatchFilter = 'combined',
	side: Side = 'blue',
): number {
	const match = world.getResource('match');
	if (
		match.winner ||
		!Number.isFinite(fraction) ||
		fraction <= 0 ||
		fraction > 1 ||
		!world.getComponent(target, 'planet')
	)
		return 0;
	let sent = 0;
	const departures: Departure[] = [];
	for (const id of new Set(sources)) {
		const p = world.getComponent(id, 'planet');
		if (!p || id === target) continue;
		if (p.owner === side && !p.carrier && isBlockaded(world, id)) {
			if (side === 'blue')
				notify(world, `${p.name}: blockade prevents departure`, side);
			continue;
		}
		const available = availableShips(world, id, side);
		if (filter !== 'troops') {
			for (const entity of available.slice(
				0,
				Math.ceil(available.length * fraction),
			)) {
				const unit = entity.components.unit;
				departures.push({
					unitId: entity.id,
					phase: unit.phase === 'docked' ? 'docked' : 'orbit',
					source: id,
					x: unit.x,
					y: unit.y,
					age: unit.age,
				});
				// A redirected escort belongs only to its newest order.
				for (const order of world.getResource('orderBook').active)
					order.departures = order.departures.filter(function (departure) {
						return departure.unitId !== entity.id;
					});
				Object.assign(unit, {
					target,
					phase: 'travel',
					age: 0,
					x: p.x + Math.cos(entity.id * 2.399) * 16,
					y: p.y + Math.sin(entity.id * 2.399) * 16,
				});
				syncUnitPosition(world, entity.id, unit.x, unit.y);
				world.addComponent(entity.id, 'circleCollider', { radius: 0 });
				sent++;
			}
		}
		if (p.owner !== side || filter === 'ships') continue;
		let cargo = Math.floor(p.troops * fraction);
		p.troops -= cargo;
		while (cargo > 0) {
			const count = Math.min(cargo, CONFIG.dropshipCapacity);
			const transport = world.spawn({
				localTransform: localTransformAt(
					p.x + Math.cos(sent * 2.399) * 16,
					p.y + Math.sin(sent * 2.399) * 16,
				),
				circleCollider: { radius: 0 },
				unit: {
					owner: side,
					kind: 'transport',
					x: p.x + Math.cos(sent * 2.399) * 16,
					y: p.y + Math.sin(sent * 2.399) * 16,
					target,
					phase: 'travel',
					hp: CONFIG.transportHealth,
					cargo: count,
					age: 0,
				},
			});
			departures.push({
				unitId: transport.id,
				source: id,
				x: p.x,
				y: p.y,
				age: 0,
			});
			cargo -= count;
			sent++;
		}
	}
	if (sent > 0) {
		const book = world.getResource('orderBook');
		book.active.push({
			id: book.nextId++,
			owner: side,
			target,
			state: match.paused ? 'pending' : 'outbound',
			departures,
		});
		if (side === 'blue') match.orders++;
	}
	pruneOrders(world);
	return sent;
};

// Completed ships remain part of an escorted order while transports are waiting
// to land. Once every surviving member has arrived, the order leaves the drawer.
export const orderUnits = function (world: Game, order: Order): UnitEntity[] {
	const departures = new Map(
		order.departures.map(function (departure) {
			return [departure.unitId, departure] as const;
		}),
	);
	return units(world).filter(function ({ id, components: { unit } }) {
		const departure = departures.get(id);
		if (!departure) return false;
		const target =
			order.state === 'returning' ? departure.source : order.target;
		return unit.hp > 0 && unit.owner === order.owner && unit.target === target;
	});
};
export const activeOrders = function (
	world: Game,
	planetIds: readonly number[] = [],
	side: Side = 'blue',
): Order[] {
	return world.getResource('orderBook').active.filter(function (order) {
		if (order.owner !== side) return false;
		const members = orderUnits(world, order);
		const active = members.some(function ({ components: { unit } }) {
			return unit.phase === 'travel' || unit.kind === 'transport';
		});
		return (
			active &&
			(planetIds.length === 0 ||
				planetIds.includes(order.target) ||
				order.departures.some(function (departure) {
					return planetIds.includes(departure.source);
				}))
		);
	});
};
const pruneOrders = function (world: Game): void {
	const book = world.getResource('orderBook');
	const live = new Set([
		...activeOrders(world),
		...activeOrders(world, [], 'red'),
	]);
	book.active = book.active.filter(function (order) {
		return live.has(order);
	});
};
export const cancelOrder = function (
	world: Game,
	orderId: number,
	side: Side = 'blue',
): boolean {
	if (world.getResource('match').winner) return false;
	const order = activeOrders(world, [], side).find(function (candidate) {
		return candidate.id === orderId;
	});
	if (!order || order.state === 'returning') return false;
	for (const entity of orderUnits(world, order)) {
		const departure = order.departures.find(function (entry) {
			return entry.unitId === entity.id;
		});
		if (!departure) continue;
		const unit = entity.components.unit;
		const source = world.getComponent(departure.source, 'planet');
		if (!source) continue;
		if (order.state === 'pending' && (source.owner === side || unit.kind === 'ship')) {
			if (unit.kind === 'transport') {
				source.troops += unit.cargo;
				world.removeEntity(entity.id);
			} else {
				Object.assign(unit, {
					target: departure.source,
					phase: source.carrier && source.owner === side && departure.phase === 'docked' ? 'docked' : 'orbit',
					x: source.carrier ? source.x : departure.x,
					y: source.carrier ? source.y : departure.y,
					age: departure.age,
				});
				syncUnitPosition(world, entity.id, unit.x, unit.y);
				world.removeComponent(entity.id, 'circleCollider');
			}
		} else {
			// Orbit positions are rendered from time, rather than the stored arrival
			// coordinates. Start a recalled waiting transport/escort at that point.
			const destination = world.getComponent(unit.target, 'planet');
			if (!destination) continue;
			const point = unitPoint(
				unit,
				destination,
				world.getResource('match').time,
				entity.id,
			);
			Object.assign(unit, {
				target: departure.source,
				phase: 'travel',
				x: point.x,
				y: point.y,
				age: 0,
			});
			syncUnitPosition(world, entity.id, unit.x, unit.y);
			world.addComponent(entity.id, 'circleCollider', { radius: 0 });
		}
	}
	if (order.state === 'pending') {
		const book = world.getResource('orderBook');
		book.active = book.active.filter(function (candidate) {
			return candidate !== order;
		});
	} else order.state = 'returning';
	return true;
};

const aiDependencies = {
	dispatch,
	isBlockaded,
	planets,
	setProduction,
	shipsAt,
	availableShips,
	dockedShips,
	units,
};

export const createGame = async function (
	scenario: Scenario = 'skirmish',
	map: StarMap = LAB_MAP,
	snapshot?: GameSnapshot,
	options: GameOptions = {},
): Promise<Game> {
	const world = makeWorld(map);
	const active = function (): boolean {
		const m = world.getResource('match');
		return !m.paused && !m.winner;
	};
	world
		.addSystem('production')
		.inPhase('fixedUpdate')
		.withRef(economySystem)
		.addQuery('planets', { with: ['planet'], mutates: ['planet'] })
		.withResources(['match', 'orderBook'])
		.setProcess(function ({ queries, dt, ecs, resources: { match, orderBook } }) {
			if (!active()) return;
			for (const order of orderBook.active)
				if (order.state === 'pending') order.state = 'outbound';
			match.time += dt;
			for (const {
				id,
				components: { planet: p },
			} of queries.planets) {
				if (p.owner === 'neutral') continue;
				if (p.carrier) {
					p.guns = 0;
					if (p.production === 'guns') { p.production = 'troops'; p.progress = 0; }
				}
				p.progress +=
					p.rate * CONFIG.productionRateMultiplier * dt;
				const cost = CONFIG.cost[p.production];
				while (p.progress >= cost) {
					p.progress -= cost;
					if (p.production === 'troops') p.troops++;
					else if (p.production === 'guns') p.guns++;
					else spawnShip(ecs, id, p.owner);
				}
			}
		});
	// Fixed-step pipeline: production -> spatial rebuild -> movement ->
	// combat/landing -> strategy/victory -> traveler collider cleanup. Removal
	// commands play back after this phase; cleanup sees same-tick AI redirects.
	registerMovement(world, { active, units, syncUnitPosition })
		.inPhase('fixedUpdate')
		.withRef(movementSystem)
		.after(spatialIndexSystems.rebuild.fixedUpdate);
	registerCombat(world, active, { notify, orbitalUnits, opponent, shipsAt, units }, options.onCapture)
		.inPhase('fixedUpdate')
		.withRef(combatSystem)
		.after(movementSystem);
	world
		.addSystem('strategy-and-victory')
		.inPhase('fixedUpdate')
		.withRef(strategySystem)
		.after(combatSystem)
		.withResources(['match'])
		.setProcess(function ({ ecs, dt, resources: { match } }) {
			if (!active()) return;
			pruneOrders(ecs);
			if (options.evaluateWinner) match.winner = options.evaluateWinner(ecs);
			else {
				const owners = new Set(planets(ecs).map(function (e) { return e.components.planet.owner; }));
				if (!owners.has('red')) match.winner = 'blue';
				else if (!owners.has('blue')) match.winner = 'red';
			}
			match.aiClock += dt;
			if (match.ai && match.aiClock >= CONFIG.aiInterval) {
				match.aiClock = 0;
				runAI(ecs, aiDependencies);
			}
		});
	registerTravelerCleanup(world)
		.inPhase('fixedUpdate')
		.after(strategySystem);
	world.disableSystemGroup('diagnostics');
	await world.initialize();
	if (snapshot) {
		restoreSnapshot(world, snapshot);
		return world;
	}
	if (options.seed) options.seed(world, map);
	else {
		seedFreshGame(world, map, spawnShip);
		initializeLabScenario(world, scenario, { notify, planets, spawnShip });
	}
	return world;
};
