import { expect, test } from 'bun:test';
import { createCampaign } from './campaign-scenario';
import { applyCampaignEncounterResult, commitExpedition, commitFactionTurn, resolveCampaignTurn } from './campaign-state';
import type { CampaignState } from './campaign-state';
import { ENCOUNTER_COSTS } from './campaign-setup';
import type { CampaignEncounterSetup } from './campaign-setup';
import { createCampaignBattle } from './campaign-encounter';
import type { CampaignBattle } from './campaign-encounter';
import { parseCampaignSave } from './campaign-save';
import type { CampaignSave } from './campaign-save';
import { captureConquestSave } from './game-save';
import { planets, units } from './game';
import { CONFIG } from './config';

const saved = function (campaign: CampaignState, encounterState?: CampaignSave['encounterState']): CampaignSave {
	return parseCampaignSave({ schemaVersion: 1, mode: 'campaign', profileId: 'flow', savedAt: 100, campaign,
		...(encounterState ? { encounterState } : {}) });
};
const resolve = function (state: CampaignState): CampaignState {
	return resolveCampaignTurn(commitFactionTurn(commitFactionTurn(state, 'blue'), 'red'), state.turn);
};
const start = function (): CampaignState {
	const fixture = createCampaign();
	const initial = { ...fixture, planets: fixture.planets.map(function (planet) {
		return planet.systemId === 'sirius' ? { ...planet, depletion: 90 } : planet;
	}) };
	const planning = saved(initial).campaign;
	const order = { id: 'flow', factionId: 'blue' as const, sourceSystemId: 'sol', destinationSystemId: 'sirius',
		contributions: [{ planetId: 'sol:1', points: 100 }, { planetId: 'sol:2', points: 50 }] };
	const committed = saved(commitExpedition(planning, order)).campaign;
	expect(commitExpedition(committed, order)).toBe(committed);
	return resolve(committed);
};
const setup = function (state: CampaignState, successful: boolean): CampaignEncounterSetup {
	const encounter = state.encounter;
	if (!encounter) throw new Error('Expected an active encounter');
	return { costs: ENCOUNTER_COSTS,
		defenders: encounter.planets.map(function (planet) {
			return { planetId: planet.planetId, forces: { troops: 10, ships: 0, guns: 0 } };
		}),
		beachheads: successful ? encounter.planets.map(function (planet) {
			return { planetId: planet.planetId, troops: 50, ships: 0 };
		}) : [{ planetId: 'sirius:1', troops: 1, ships: 0 }],
	};
};
const snapshot = function (battle: CampaignBattle): ReturnType<typeof captureConquestSave>['game'] {
	return captureConquestSave(battle.world, battle.map, 'skirmish', 1, 'flow').game;
};
const finishBattle = function (battle: CampaignBattle): void {
	for (let tick = 0; tick < 3000 && !battle.world.getResource('match').winner; tick++) battle.world.update(CONFIG.step);
	expect(battle.world.getResource('match').winner).not.toBeNull();
};

test('split invasion saves at every boundary, produces during combat and returns ownership without survivor rewards', async function () {
	const active = start();
	const allocation = setup(active, true);
	const draft = saved(active, { phase: 'allocation', encounterId: 'encounter:flow', setup: allocation });
	expect(draft.encounterState?.phase).toBe('allocation');
	const battle = await createCampaignBattle(draft.campaign, allocation);
	let restored: CampaignBattle | undefined;
	try {
		battle.world.getResource('match').ai = false;
		expect(units(battle.world)).toHaveLength(15);
		expect(units(battle.world).every(function (entity) { return entity.components.unit.x === -64; })).toBe(true);
		expect(new Set(units(battle.world).map(function (entity) { return entity.components.unit.target; })).size).toBe(3);
		expect(battle.world.getResource('orderBook').active).toEqual([]);
		for (let tick = 0; tick < 200; tick++) battle.world.update(CONFIG.step);
		expect(planets(battle.world).every(function (entity) { return entity.components.planet.troops > 10; })).toBe(true);
		expect(battle.world.getResource('match').time).toBeGreaterThan(9);
		expect(active.planets.find(function (planet) { return planet.id === 'sol:1'; })?.depletion).toBe(100);
		expect(active.planets.find(function (planet) { return planet.id === 'sirius:1'; })?.depletion).toBe(90);
		const midbattle = saved(active, { phase: 'battle', encounterId: 'encounter:flow', setup: allocation,
			game: snapshot(battle), captureEvents: battle.runtime.getCaptureEvents() });
		const resumed = midbattle.encounterState;
		if (!resumed || resumed.phase !== 'battle') throw new Error('Expected saved battle');
		restored = await createCampaignBattle(midbattle.campaign, resumed.setup, resumed.game, resumed.captureEvents);
		expect(units(restored.world).map(function (entity) { return entity.components.unit; }))
			.toEqual(units(battle.world).map(function (entity) { return entity.components.unit; }));
		expect(restored.world.getResource('match').paused).toBe(true);
		restored.world.getResource('match').paused = false;
		finishBattle(restored);
		expect(restored.world.getResource('match').winner).toBe('blue');
		expect(restored.runtime.getCaptureEvents()).toHaveLength(3);
		expect(planets(restored.world).some(function (entity) { return entity.components.planet.troops > 0; })).toBe(true);
		const completed = saved(active, { phase: 'battle', encounterId: 'encounter:flow', setup: allocation,
			game: snapshot(restored), captureEvents: restored.runtime.getCaptureEvents() });
		expect(completed.encounterState?.phase).toBe('battle');
		const result = restored.runtime.getResult(restored.world);
		const returned = saved(applyCampaignEncounterResult(completed.campaign, result)).campaign;
		expect(returned.turn).toBe(2);
		expect(returned.phase).toBe('planning');
		expect(returned.planets.filter(function (planet) { return planet.systemId === 'sirius'; })
			.every(function (planet) { return planet.factionId === 'blue' && planet.depletion === 80 && planet.developmentBonusPoints === 0; })).toBe(true);
		expect(returned.planets.find(function (planet) { return planet.id === 'sol:1'; })?.depletion).toBeCloseTo(89.8);
		expect(returned.planets.find(function (planet) { return planet.id === 'sol:2'; })?.depletion).toBeCloseTo(39.8);
		expect(applyCampaignEncounterResult(returned, result)).toBe(returned);
		expect(resolveCampaignTurn(returned, 1)).toBe(returned);
		const repeated = saved(resolve(returned)).campaign;
		expect(repeated.turn).toBe(3);
		expect(repeated.planets.find(function (planet) { return planet.id === 'sirius:1'; })?.developmentBonusPoints).toBe(2);
		expect(repeated.planets.find(function (planet) { return planet.id === 'sirius:1'; })?.depletion).toBeCloseTo(69.8);
		expect(repeated.expeditions[0]?.points).toBe(150);
	} finally { await battle.world.dispose(); await restored?.world.dispose(); }
});

test('failed first landing spends committed expedition once, cleans remnants and preserves defending ownership', async function () {
	const active = start();
	const allocation = setup(active, false);
	const battle = await createCampaignBattle(active, allocation);
	try {
		battle.world.getResource('match').ai = false;
		finishBattle(battle);
		expect(battle.world.getResource('match').winner).toBe('red');
		expect(battle.runtime.getCaptureEvents()).toEqual([]);
		expect(units(battle.world).filter(function (entity) { return entity.components.unit.owner === 'blue'; })).toEqual([]);
		const result = battle.runtime.getResult(battle.world);
		const returned = saved(applyCampaignEncounterResult(active, result)).campaign;
		expect(returned.planets.filter(function (planet) { return planet.systemId === 'sirius'; })
			.every(function (planet) { return planet.factionId === 'red' && planet.developmentBonusPoints === 2; })).toBe(true);
		expect(returned.planets.find(function (planet) { return planet.id === 'sol:1'; })?.depletion).toBeCloseTo(89.8);
		expect(returned.planets.find(function (planet) { return planet.id === 'sol:2'; })?.depletion).toBeCloseTo(39.8);
		expect(returned.expeditions[0]?.points).toBe(150);
		expect(returned.expeditions[0]?.status).toBe('resolved');
		expect(applyCampaignEncounterResult(returned, result)).toBe(returned);
	} finally { await battle.world.dispose(); }
});
