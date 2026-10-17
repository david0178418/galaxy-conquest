import { expect, test } from 'bun:test';
import { parseCampaignSave, isSupportedCampaignSave } from './campaign-save';
import type { CampaignSave } from './campaign-save';
import { CAMPAIGN_RULES, applyCampaignEncounterResult, commitExpedition, commitFactionTurn, resolveCampaignTurn } from './campaign-state';
import type { CampaignState } from './campaign-state';
import { InvalidSaveError } from './save-state';
import { createDefaultEncounterSetup } from './campaign-setup';
import { createCampaignBattle } from './campaign-encounter';
import { captureConquestSave } from './game-save';
import { units } from './game';

const makeSave = function (): CampaignSave {
	const map = { width: 100, height: 100, planets: [
		['One', 20, 20, 10, 'blue', 0, 1] as const, ['Two', 70, 70, 10, 'red', 0, 1] as const,
	] };
	const campaign: CampaignState = { turn: 1, phase: 'planning', rules: CAMPAIGN_RULES,
		systems: [{ id: 'home', name: 'Home', x: 0, y: 0, map }, { id: 'away', name: 'Away', x: 100, y: 0, map }],
		planets: ['home', 'away'].flatMap(function (systemId) {
			return ['One', 'Two'].map(function (name) {
				return { id: `${systemId}:${name}`, systemId, name, factionId: systemId === 'home' ? 'blue' as const : 'red' as const,
					baselinePoints: 100, developmentBonusPoints: 0, depletion: 0, capturedTurn: null, lastAppliedTurn: 0 };
			});
		}), expeditions: [], readyFactions: [], encounter: null, resolvedEncounters: [] };
	return { schemaVersion: 1, mode: 'campaign', profileId: 'profile', savedAt: 100, campaign };
};
const startEncounter = function (save: CampaignSave): CampaignSave {
	const state = commitExpedition(save.campaign, { id: 'first', factionId: 'blue', sourceSystemId: 'home', destinationSystemId: 'away',
		contributions: [{ planetId: 'home:One', points: 40 }] });
	return { ...save, campaign: resolveCampaignTurn(commitFactionTurn(commitFactionTurn(state, 'blue'), 'red'), 1) };
};

test('planning, committed, active encounter and resolved campaign saves round-trip without spending twice', function () {
	const initial = makeSave();
	expect(parseCampaignSave(initial, 'profile')).toEqual(initial);
	const active = startEncounter(initial);
	expect(active.campaign.phase).toBe('encounter');
	const restored = parseCampaignSave(active);
	expect(restored).toEqual(active);
	expect(restored.campaign.planets.find(function (planet) { return planet.id === 'home:One'; })?.depletion).toBe(40);
	const result = { encounterId: 'encounter:first', captureEvents: [], ownership: [
		{ planetId: 'away:One', factionId: 'red' as const }, { planetId: 'away:Two', factionId: 'red' as const },
	] };
	const resolved = { ...active, campaign: applyCampaignEncounterResult(restored.campaign, result) };
	expect(parseCampaignSave(resolved)).toEqual(resolved);
	expect(applyCampaignEncounterResult(parseCampaignSave(resolved).campaign, result)).toEqual(resolved.campaign);
});

test('campaign saves reject unsupported versions, wrong modes/profiles and unrecognized tactical formats', function () {
	const valid = makeSave();
	for (const input of [null, {}, { ...valid, schemaVersion: 0 }, { ...valid, schemaVersion: 2 }, { ...valid, mode: 'skirmish' },
		{ ...valid, tactical: { unsupported: true } }, { ...valid, savedAt: Infinity }]) {
		expect(isSupportedCampaignSave(input)).toBe(false);
		expect(function () { parseCampaignSave(input); }).toThrow(InvalidSaveError);
	}
	expect(function () { parseCampaignSave(valid, 'other'); }).toThrow(InvalidSaveError);
});

test('campaign validation rejects broken identities, budgets, phase and turn idempotency records', function () {
	const active = startEncounter(makeSave());
	const state = active.campaign;
	const firstPlanet = state.planets[0];
	const firstOrder = state.expeditions[0];
	if (!firstPlanet || !firstOrder || !state.encounter) throw new Error('Missing fixture entities');
	const invalidStates = [
		{ ...state, planets: [...state.planets, firstPlanet] },
		{ ...state, readyFactions: ['blue', 'blue'] },
		{ ...state, phase: 'planning' },
		{ ...state, encounter: null },
		{ ...state, planets: [{ ...firstPlanet, lastAppliedTurn: state.turn }, ...state.planets.slice(1)] },
		{ ...state, planets: [{ ...firstPlanet, developmentBonusPoints: 99 }, ...state.planets.slice(1)] },
		{ ...state, expeditions: [{ ...firstOrder, points: 41 }] },
		{ ...state, expeditions: [{ ...firstOrder, arrivalTime: 2 }] },
		{ ...state, expeditions: [{ ...firstOrder, contributions: [{ planetId: 'away:One', points: 40 }] }] },
		{ ...state, encounter: { ...state.encounter, attackerPoints: 39 } },
		{ ...state, encounter: { ...state.encounter, planets: state.encounter.planets.map(function (planet) { return { ...planet, points: 999 }; }) } },
		{ ...state, resolvedEncounters: [{ encounterId: state.encounter.id, captureEvents: [], ownership: [{ planetId: 'away:One', factionId: 'red' }] }] },
	];
	for (const campaign of invalidStates) expect(isSupportedCampaignSave({ ...active, campaign })).toBe(false);
});

test('excess absolute depletion remains supported after maximum capacity drops', function () {
	const save = makeSave();
	const depleted = { ...save, campaign: { ...save.campaign, planets: save.campaign.planets.map(function (planet) {
		return { ...planet, depletion: 150 };
	}) } };
	expect(parseCampaignSave(depleted)).toEqual(depleted);
});

test('saved active encounters cannot bypass earlier unresolved due arrivals', function () {
	const initial = makeSave();
	const first = commitExpedition(initial.campaign, { id: 'a', factionId: 'blue', sourceSystemId: 'home', destinationSystemId: 'away',
		contributions: [{ planetId: 'home:One', points: 20 }] });
	const second = commitExpedition(first, { id: 'z', factionId: 'blue', sourceSystemId: 'home', destinationSystemId: 'away',
		contributions: [{ planetId: 'home:One', points: 20 }] });
	const state = resolveCampaignTurn(commitFactionTurn(commitFactionTurn(second, 'blue'), 'red'), 1);
	if (!state.encounter) throw new Error('Missing encounter');
	expect(isSupportedCampaignSave({ ...initial, campaign: state })).toBe(true);
	const corrupt = { ...state, encounter: { ...state.encounter, id: 'encounter:z', expeditionId: 'z' },
		expeditions: state.expeditions.map(function (order) {
			return { ...order, status: order.id === 'z' ? 'encounter' as const : 'traveling' as const };
		}) };
	expect(isSupportedCampaignSave({ ...initial, campaign: corrupt })).toBe(false);
});

test('historical capture events must alternate owners and agree with recorded final ownership', function () {
	const active = startEncounter(makeSave());
	const result = { encounterId: 'encounter:first', captureEvents: [], ownership: [
		{ planetId: 'away:One', factionId: 'red' as const }, { planetId: 'away:Two', factionId: 'red' as const },
	] };
	const state = applyCampaignEncounterResult(active.campaign, result);
	const recapture = { ...result, captureEvents: [
		{ planetId: 'away:One', factionId: 'blue' as const }, { planetId: 'away:One', factionId: 'red' as const },
	] };
	const recaptured = applyCampaignEncounterResult(active.campaign, recapture);
	expect(isSupportedCampaignSave({ ...active, campaign: recaptured })).toBe(true);
	for (const captureEvents of [
		[{ planetId: 'away:One', factionId: 'blue' }],
		[{ planetId: 'away:One', factionId: 'red' }, { planetId: 'away:Two', factionId: 'blue' }, { planetId: 'away:One', factionId: 'red' }, { planetId: 'away:Two', factionId: 'red' }],
	]) expect(isSupportedCampaignSave({ ...active, campaign: { ...state, resolvedEncounters: [{ ...result, captureEvents }] } })).toBe(false);
});

test('galaxy coordinates support negative positions without changing travel arithmetic', function () {
	const save = makeSave();
	const campaign = { ...save.campaign, systems: save.campaign.systems.map(function (system) {
		return { ...system, x: system.x - 150, y: -100 };
	}) };
	const active = startEncounter({ ...save, campaign });
	expect(parseCampaignSave(active)).toEqual(active);
});


test('allocation drafts round-trip with validated budgets, targets and active encounter identity', function () {
	const active = startEncounter(makeSave());
	const encounter = active.campaign.encounter;
	if (!encounter) throw new Error('Missing active encounter');
	const setup = createDefaultEncounterSetup(encounter);
	const save: CampaignSave = { ...active, encounterState: { phase: 'allocation', encounterId: encounter.id, setup } };
	expect(parseCampaignSave(save)).toEqual(save);
	for (const input of [
		{ ...save, encounterState: { ...save.encounterState, encounterId: 'other' } },
		{ ...save, campaign: makeSave().campaign },
		{ ...save, encounterState: { phase: 'allocation', encounterId: encounter.id, setup: { ...setup, defenders: [] } } },
		{ ...save, encounterState: { phase: 'allocation', encounterId: encounter.id, setup: { ...setup, beachheads: [{ planetId: 'away:One', troops: 999, ships: 0 }] } } },
		{ ...save, encounterState: { phase: 'allocation', encounterId: encounter.id, setup: { ...setup, beachheads: [{ planetId: 'home:One', troops: 1, ships: 0 }] } } },
	]) expect(isSupportedCampaignSave(input)).toBe(false);
});

test('tactical snapshots resume existing forces and point commitments without reseeding', async function () {
	const active = startEncounter(makeSave());
	const encounter = active.campaign.encounter;
	if (!encounter) throw new Error('Missing active encounter');
	const setup = createDefaultEncounterSetup(encounter);
	const battle = await createCampaignBattle(active.campaign, setup);
	try {
		const first = units(battle.world)[0];
		if (!first) throw new Error('Missing deployed forces');
		first.components.unit.hp = 0.5;
		const game = captureConquestSave(battle.world, battle.map, 'skirmish', 1, 'profile').game;
		const save: CampaignSave = { ...active, encounterState: { phase: 'battle', encounterId: encounter.id, setup, game,
			captureEvents: battle.runtime.getCaptureEvents() } };
		const restored = parseCampaignSave(save);
		expect(restored).toEqual(save);
		if (restored.encounterState?.phase !== 'battle') throw new Error('Missing battle snapshot');
		const resumed = await createCampaignBattle(restored.campaign, restored.encounterState.setup, restored.encounterState.game,
			restored.encounterState.captureEvents);
		try {
			expect(units(resumed.world).map(function (item) { return item.components.unit; })).toEqual(game.units.map(function (item) { return item.unit; }));
			expect(restored.campaign.planets.find(function (planet) { return planet.id === 'home:One'; })?.depletion).toBe(40);
		} finally { await resumed.world.dispose(); }
		for (const encounterState of [
			{ ...save.encounterState, phase: 'battle', encounterId: encounter.id, setup, game: { ...game, scenario: 'invasion' }, captureEvents: [] },
			{ phase: 'battle', encounterId: encounter.id, setup, game: { ...game, match: { ...game.match, winner: 'blue' } }, captureEvents: [] },
			{ phase: 'battle', encounterId: encounter.id, setup, game, captureEvents: [{ planetId: 'away:One', factionId: 'blue' }] },
			{ phase: 'battle', encounterId: encounter.id, setup, game: { ...game, map: { ...game.map, width: 101 } }, captureEvents: [] },
		]) expect(isSupportedCampaignSave({ ...save, encounterState })).toBe(false);
	} finally { await battle.world.dispose(); }
});

test('capture history must replay into tactical ownership including transient recaptures', async function () {
	const active = startEncounter(makeSave());
	const encounter = active.campaign.encounter;
	if (!encounter) throw new Error('Missing active encounter');
	const setup = createDefaultEncounterSetup(encounter);
	const battle = await createCampaignBattle(active.campaign, setup);
	try {
		const snapshot = captureConquestSave(battle.world, battle.map, 'skirmish', 1, 'profile').game;
		const captureEvents = [{ planetId: 'away:One', factionId: 'blue' as const }, { planetId: 'away:One', factionId: 'red' as const }];
		const game = { ...snapshot, match: { ...snapshot.match, captures: 2 } };
		const save: CampaignSave = { ...active, encounterState: { phase: 'battle', encounterId: encounter.id, setup, game, captureEvents } };
		expect(isSupportedCampaignSave(save)).toBe(true);
		expect(isSupportedCampaignSave({ ...save, encounterState: { ...save.encounterState, captureEvents: [] } })).toBe(false);
		expect(isSupportedCampaignSave({ ...save, encounterState: { ...save.encounterState, captureEvents: [captureEvents[0], captureEvents[0]] } })).toBe(false);
	} finally { await battle.world.dispose(); }
});

test('campaign tactical restoration rejects sparse collections without changing skirmish parsing', async function () {
	const active = startEncounter(makeSave());
	const encounter = active.campaign.encounter;
	if (!encounter) throw new Error('Missing encounter');
	const setup = createDefaultEncounterSetup(encounter);
	const battle = await createCampaignBattle(active.campaign, setup);
	try {
		const game = captureConquestSave(battle.world, battle.map, 'skirmish', 1, 'profile').game;
		const wrapper = { phase: 'battle', encounterId: encounter.id, setup, game, captureEvents: [] };
		const games = [
			{ ...game, units: new Array(1) },
			{ ...game, planets: new Array(game.planets.length) },
			{ ...game, map: { ...game.map, planets: new Array(game.map.planets.length) } },
			{ ...game, match: { ...game.match, notices: new Array(1) } },
			{ ...game, orderBook: { ...game.orderBook, active: new Array(1) } },
			{ ...game, orderBook: { ...game.orderBook, active: [{ id: 1, owner: 'blue', target: game.planets[0]?.id,
				state: 'pending', departures: new Array(1) }] } },
		];
		for (const sparse of games) {
			expect(isSupportedCampaignSave({ ...active, encounterState: { ...wrapper, game: sparse } })).toBe(false);
			expect(function () { parseCampaignSave({ ...active, encounterState: { ...wrapper, game: sparse } }); }).toThrow(InvalidSaveError);
		}
	} finally { await battle.world.dispose(); }
});

test('a genuine battle containing a neutral planet round-trips and restores', async function () {
	const original = makeSave();
	const initial = { ...original, campaign: { ...original.campaign, planets: original.campaign.planets.map(function (planet) {
		return planet.id === 'away:Two' ? { ...planet, factionId: null } : planet;
	}) } };
	const active = startEncounter(initial);
	const encounter = active.campaign.encounter;
	if (!encounter) throw new Error('Missing encounter');
	const setup = createDefaultEncounterSetup(encounter);
	const battle = await createCampaignBattle(active.campaign, setup);
	try {
		const game = captureConquestSave(battle.world, battle.map, 'skirmish', 1, 'profile').game;
		expect(game.planets.some(function (item) { return item.planet.owner === 'neutral'; })).toBe(true);
		const save: CampaignSave = { ...active, encounterState: { phase: 'battle', encounterId: encounter.id, setup, game, captureEvents: [] } };
		const loaded = parseCampaignSave(save);
		expect(loaded).toEqual(save);
		if (loaded.encounterState?.phase !== 'battle') throw new Error('Missing saved battle');
		const restored = await createCampaignBattle(loaded.campaign, loaded.encounterState.setup, loaded.encounterState.game, loaded.encounterState.captureEvents);
		try {
			expect(captureConquestSave(restored.world, restored.map, 'skirmish', 1, 'profile').game).toEqual({ ...game, match: { ...game.match, paused: true } });
		} finally { await restored.world.dispose(); }
	} finally { await battle.world.dispose(); }
});
