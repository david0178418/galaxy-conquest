import { expect, test } from 'bun:test';
import { CONFIG } from './config';
import type { Side } from './config';
import { cancelOrder, createGame, dispatch, isBlockaded, planets, spawnShip, units } from './game';
import type { Game, GameOptions } from './game';
import { captureConquestSave } from './game-save';
import type { StarMap } from './maps';
import { campaignEntryEdge, campaignFactionIsViable, createCampaignBattle, createCampaignEncounterRuntime, evaluateCampaignWinner } from './campaign-encounter';
import { createDefaultEncounterSetup } from './campaign-setup';
import { CAMPAIGN_RULES } from './campaign-state';
import type { CampaignState } from './campaign-state';

const map: StarMap = {
	width: 600, height: 600,
	planets: [['Home', 100, 100, 20, 'blue', 10, 1], ['Target', 500, 500, 20, 'red', 10, 1]],
};
const input = { encounterId: 'encounter:one', planets: [
	{ name: 'Home', planetId: 'system:home' }, { name: 'Target', planetId: 'system:target' },
] };
const named = function (world: Game, name: string): ReturnType<typeof planets>[number] {
	const found = planets(world).find(function (entity) { return entity.components.planet.name === name; });
	if (!found) throw new Error('Missing test planet');
	return found;
};
const quiet = async function (options: GameOptions = {}): Promise<Game> {
	const world = await createGame('skirmish', map, undefined, options);
	world.getResource('match').ai = false;
	for (const entity of units(world)) world.removeEntity(entity.id);
	return world;
};
const transport = function (world: Game, owner: Side, cargo: number): ReturnType<typeof units>[number] {
	return world.spawn({ unit: {
		owner, cargo, kind: 'transport', x: -400, y: -400,
		target: named(world, 'Target').id, phase: 'travel', hp: CONFIG.transportHealth, age: 0,
	} });
};

test('planetless loaded attacker remains viable and source-free invasion has no recall order', async function () {
	const runtime = createCampaignEncounterRuntime(input);
	const world = await quiet(runtime.options);
	try {
		named(world, 'Home').components.planet.owner = 'neutral';
		transport(world, 'blue', 5);
		world.update(CONFIG.step);
		expect(world.getResource('match').winner).toBeNull();
		expect(campaignFactionIsViable(world, 'blue')).toBe(true);
		expect(world.getResource('orderBook').active).toEqual([]);
		expect(cancelOrder(world, 1)).toBe(false);
	} finally { await world.dispose(); }
});

test('planetless faction loses ships and empty transports but loaded relief keeps defender alive', async function () {
	for (const owner of ['blue', 'red'] as const) {
		const world = await quiet(createCampaignEncounterRuntime(input).options);
		try {
			const lostPlanet = named(world, owner === 'blue' ? 'Home' : 'Target');
			lostPlanet.components.planet.owner = owner === 'blue' ? 'red' : 'blue';
			spawnShip(world, lostPlanet.id, owner);
			const relief = transport(world, owner, 1);
			expect(evaluateCampaignWinner(world)).toBeNull();
			relief.components.unit.cargo = 0;
			world.update(CONFIG.step);
			expect(world.getResource('match').winner).toBe(owner === 'blue' ? 'red' : 'blue');
			expect(units(world).filter(function (entity) { return entity.components.unit.owner === owner; })).toEqual([]);
		} finally { await world.dispose(); }
	}
});

test('blockade does not eliminate a faction that owns a producing planet', async function () {
	const world = await quiet(createCampaignEncounterRuntime(input).options);
	try {
		const target = named(world, 'Target');
		spawnShip(world, target.id, 'blue');
		expect(isBlockaded(world, target.id)).toBe(true);
		world.update(CONFIG.step);
		expect(world.getResource('match').winner).toBeNull();
		expect(target.components.planet.progress).toBeGreaterThan(0);
	} finally { await world.dispose(); }
});

test('failed first landing ends the invasion even while attacker ships survive', async function () {
	const world = await quiet(createCampaignEncounterRuntime(input).options);
	try {
		named(world, 'Home').components.planet.owner = 'neutral';
		const target = named(world, 'Target');
		spawnShip(world, target.id, 'blue');
		transport(world, 'blue', target.components.planet.troops).components.unit.phase = 'orbit';
		world.update(CONFIG.step);
		expect(world.getResource('match').winner).toBe('red');
		expect(target.components.planet.owner).toBe('red');
		expect(units(world)).toEqual([]);
	} finally { await world.dispose(); }
});

test('skirmish retains planet-only victory even when a loaded transport survives', async function () {
	const world = await quiet();
	try {
		named(world, 'Home').components.planet.owner = 'neutral';
		transport(world, 'blue', 5);
		world.update(CONFIG.step);
		expect(world.getResource('match').winner).toBe('red');
	} finally { await world.dispose(); }
});

test('campaign and skirmish preserve local recall to an enemy-held source', async function () {
	for (const options of [createCampaignEncounterRuntime(input).options, {}]) {
		const world = await quiet(options);
		try {
			const source = named(world, 'Home');
			dispatch(world, [source.id], named(world, 'Target').id, 0.5, 'troops');
			source.components.planet.owner = 'red';
			expect(cancelOrder(world, 1)).toBe(true);
			expect(world.getResource('orderBook').active[0]?.state).toBe('returning');
		} finally { await world.dispose(); }
	}
});

test('capture and recapture stay chronological across snapshot restore and return stable identities', async function () {
	const runtime = createCampaignEncounterRuntime(input);
	const world = await quiet(runtime.options);
	let restored: Game | undefined;
	try {
		named(world, 'Target').components.planet.troops = 0;
		transport(world, 'blue', 5).components.unit.phase = 'orbit';
		transport(world, 'red', 20);
		world.update(CONFIG.step);
		expect(runtime.getCaptureEvents()).toEqual([{ planetId: 'system:target', factionId: 'blue' }]);
		const snapshot = captureConquestSave(world, map, 'skirmish', 1, 'profile').game;
		const resumed = createCampaignEncounterRuntime({ ...input, captureEvents: runtime.getCaptureEvents() });
		restored = await createGame('skirmish', map, snapshot, resumed.options);
		expect(resumed.getCaptureEvents()).toEqual(runtime.getCaptureEvents());
		const relief = units(restored).find(function (entity) { return entity.components.unit.owner === 'red'; });
		if (!relief) throw new Error('Missing restored relief');
		relief.components.unit.phase = 'orbit';
		restored.getResource('match').paused = false;
		restored.update(CONFIG.step);
		expect(resumed.getCaptureEvents()).toEqual([
			{ planetId: 'system:target', factionId: 'blue' }, { planetId: 'system:target', factionId: 'red' },
		]);
		const unfinished = restored;
		expect(function () { resumed.getResult(unfinished); }).toThrow('not finished');
		named(restored, 'Home').components.planet.owner = 'red';
		restored.update(CONFIG.step);
		expect(resumed.getResult(restored)).toEqual({ encounterId: input.encounterId,
			captureEvents: resumed.getCaptureEvents(), ownership: [
				{ planetId: 'system:home', factionId: 'red' }, { planetId: 'system:target', factionId: 'red' },
			] });
		const copied = resumed.getCaptureEvents();
		copied.pop();
		expect(resumed.getCaptureEvents()).toHaveLength(2);
	} finally {
		await world.dispose();
		await restored?.dispose();
	}
});

test('invalid encounter identity mappings and impossible all-eliminated states fail explicitly', async function () {
	expect(function () { createCampaignEncounterRuntime({ ...input, planets: [] }); }).toThrow();
	expect(function () { createCampaignEncounterRuntime({ ...input, planets: [...input.planets, ...input.planets] }); }).toThrow();
	expect(function () { createCampaignEncounterRuntime({ ...input, captureEvents: [{ planetId: 'missing', factionId: 'blue' }] }); }).toThrow();
	const world = await quiet();
	try {
		for (const entity of planets(world)) entity.components.planet.owner = 'neutral';
		expect(function () { evaluateCampaignWinner(world); }).toThrow('no viable faction');
	} finally { await world.dispose(); }
});

const invasionState = function (): CampaignState {
	return {
		turn: 1, phase: 'encounter', rules: CAMPAIGN_RULES, readyFactions: ['blue', 'red'], planets: [], resolvedEncounters: [],
		systems: [{ id: 'home', name: 'Home', x: 0, y: 0, map }, { id: 'away', name: 'Away', x: 100, y: 0, map }],
		expeditions: [{ id: 'expedition', factionId: 'blue', sourceSystemId: 'home', destinationSystemId: 'away',
			contributions: [{ planetId: 'source', points: 100 }], points: 100, departureTurn: 1, arrivalTime: 1, status: 'encounter' }],
		encounter: { id: 'battle', expeditionId: 'expedition', systemId: 'away', attacker: 'blue', attackerPoints: 100,
			planets: [{ planetId: 'away:home', name: 'Home', factionId: 'red', points: 0 },
				{ planetId: 'away:target', name: 'Target', factionId: 'red', points: 0 }] },
	};
};

test('travel direction chooses one common entry edge on every axis and diagonal ties', function () {
	const origin = { x: 0, y: 0 };
	expect(campaignEntryEdge(origin, { x: 100, y: 20 })).toBe('left');
	expect(campaignEntryEdge(origin, { x: -100, y: 20 })).toBe('right');
	expect(campaignEntryEdge(origin, { x: 20, y: 100 })).toBe('top');
	expect(campaignEntryEdge(origin, { x: 20, y: -100 })).toBe('bottom');
	expect(campaignEntryEdge(origin, { x: 100, y: 100 })).toBe('left');
});

test('factory replaces free skirmish units and splits source-free troops into transports on a shared edge', async function () {
	const state = invasionState();
	if (!state.encounter) throw new Error('Missing encounter fixture');
	const setup = { ...createDefaultEncounterSetup(state.encounter), beachheads: [
		{ planetId: 'away:home', troops: 21, ships: 2 }, { planetId: 'away:target', troops: 11, ships: 1 },
	] };
	const battle = await createCampaignBattle(state, setup);
	try {
		expect(battle.entryEdge).toBe('left');
		expect(units(battle.world)).toHaveLength(8);
		expect(units(battle.world).map(function (entity) { return entity.components.unit.cargo; }).filter(function (cargo) { return cargo > 0; }))
			.toEqual([10, 10, 1, 10, 1]);
		for (const entity of units(battle.world)) {
			expect(entity.components.unit.x).toBe(-64);
			expect(entity.components.unit.phase).toBe('travel');
			expect(battle.world.hasComponent(entity.id, 'circleCollider')).toBe(true);
		}
		expect(new Set(units(battle.world).map(function (entity) { return entity.components.unit.y; })).size).toBeGreaterThan(1);
		expect(battle.world.getResource('orderBook').active).toEqual([]);
		expect(planets(battle.world).map(function (entity) { return entity.components.planet.troops; })).toEqual([0, 0]);
	} finally { await battle.world.dispose(); }
});

test('inbound snapshot restore preserves forces and runtime events without replaying setup', async function () {
	const state = invasionState();
	if (!state.encounter) throw new Error('Missing encounter fixture');
	const setup = createDefaultEncounterSetup(state.encounter);
	const battle = await createCampaignBattle(state, setup);
	let restored: Game | undefined;
	try {
		battle.world.getResource('match').ai = false;
		for (let index = 0; index < 10; index++) battle.world.update(CONFIG.step);
		const snapshot = captureConquestSave(battle.world, battle.map, 'skirmish', 1, 'profile').game;
		const resumed = await createCampaignBattle(state, setup, snapshot, battle.runtime.getCaptureEvents());
		restored = resumed.world;
		expect(units(restored).map(function (entity) { return entity.components.unit; }))
			.toEqual(units(battle.world).map(function (entity) { return entity.components.unit; }));
		expect(restored.getResource('match').time).toBe(battle.world.getResource('match').time);
		expect(resumed.runtime.getCaptureEvents()).toEqual([]);
		expect(resumed.map).toEqual(battle.map);
	} finally { await battle.world.dispose(); await restored?.dispose(); }
});

test('factory invasion lands, retains production and returns a completed ownership result', async function () {
	const state = invasionState();
	if (!state.encounter) throw new Error('Missing encounter fixture');
	const setup = { ...createDefaultEncounterSetup(state.encounter), beachheads: [
		{ planetId: 'away:home', troops: 50, ships: 0 }, { planetId: 'away:target', troops: 50, ships: 0 },
	] };
	const battle = await createCampaignBattle(state, setup);
	try {
		battle.world.getResource('match').ai = false;
		for (let index = 0; index < 2000 && !battle.world.getResource('match').winner; index++) battle.world.update(CONFIG.step);
		expect(battle.world.getResource('match').winner).toBe('blue');
		expect(battle.runtime.getCaptureEvents()).toHaveLength(2);
		expect(battle.runtime.getResult(battle.world).ownership.every(function (item) { return item.factionId === 'blue'; })).toBe(true);
		expect(planets(battle.world).some(function (entity) { return entity.components.planet.troops > 0; })).toBe(true);
	} finally { await battle.world.dispose(); }
});
