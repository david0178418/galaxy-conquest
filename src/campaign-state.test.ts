import { expect, test } from 'bun:test';
import { applyCampaignEncounterResult, CAMPAIGN_RULES, commitExpedition, commitFactionTurn, resolveCampaignTurn } from './campaign-state';
import type { CampaignState, CampaignPlanet, ExpeditionOrder } from './campaign-state';
import type { StarMap } from './maps';

const map: StarMap = { width: 100, height: 100, planets: [
	['One', 20, 20, 10, 'blue', 0, 1], ['Two', 70, 70, 10, 'red', 0, 1],
] };
const makePlanet = function (id: string, systemId: string, name: string, factionId: 'blue' | 'red'): CampaignPlanet {
	return { id, systemId, name, factionId, baselinePoints: 100, developmentBonusPoints: 20,
		depletion: 0, capturedTurn: null, lastAppliedTurn: 0 };
};
const initial = function (): CampaignState {
	return { turn: 1, phase: 'planning', rules: CAMPAIGN_RULES,
		systems: [{ id: 'home', name: 'Home', x: 0, y: 0, map }, { id: 'away', name: 'Away', x: 100, y: 0, map }],
		planets: [makePlanet('h1', 'home', 'One', 'blue'), makePlanet('h2', 'home', 'Two', 'blue'),
			makePlanet('a1', 'away', 'One', 'red'), makePlanet('a2', 'away', 'Two', 'red')],
		expeditions: [], readyFactions: [], encounter: null, resolvedEncounters: [] };
};
const order = function (id: string, points = 30): ExpeditionOrder {
	return { id, factionId: 'blue', sourceSystemId: 'home', destinationSystemId: 'away', contributions: [{ planetId: 'h1', points }] };
};
const finish = function (state: CampaignState): CampaignState {
	return resolveCampaignTurn(commitFactionTurn(commitFactionTurn(state, 'blue'), 'red'), state.turn);
};

test('commitment is atomic, idempotent and frozen after both factions commit', function () {
	const start = initial();
	const committed = commitExpedition(start, order('one'));
	expect(start.planets[0]?.depletion).toBe(0);
	expect(committed.planets[0]?.depletion).toBe(30);
	expect(commitExpedition(committed, order('one'))).toBe(committed);
	expect(function () { commitExpedition(committed, order('one', 31)); }).toThrow();
	expect(function () { commitExpedition(committed, order('two', 100)); }).toThrow();
	expect(committed.planets[0]?.depletion).toBe(30);
	const ready = commitFactionTurn(committed, 'blue');
	expect(function () { commitExpedition(ready, order('two')); }).toThrow();
	expect(function () { resolveCampaignTurn(ready, 1); }).toThrow();
	const next = finish(committed);
	expect(next.phase).toBe('encounter');
	expect(next.turn).toBe(1);
	expect(next.planets[0]?.depletion).toBe(30);
	expect(resolveCampaignTurn(next, 1)).toBe(next);
});

test('travel has a one-turn minimum and respects fractional multi-turn arrival time', function () {
	const start = initial();
	const distant = { ...start, systems: start.systems.map(function (system) {
		return system.id === 'away' ? { ...system, x: 250 } : system;
	}) };
	let state = commitExpedition(distant, order('long'));
	expect(state.expeditions[0]?.arrivalTime).toBe(2.5);
	state = finish(state);
	state = finish(state);
	expect(state.turn).toBe(3);
	expect(state.encounter).toBeNull();
	state = finish(state);
	expect(state.encounter?.expeditionId).toBe('long');
	expect(state.turn).toBe(3);
});

test('arrivals sort by exact time then stable identity and later encounters wait', function () {
	let state = commitExpedition(commitExpedition(initial(), order('z')), order('a'));
	state = finish(state);
	expect(state.encounter?.expeditionId).toBe('a');
	expect(state.expeditions.find(function (item) { return item.id === 'z'; })?.status).toBe('traveling');
	expect(resolveCampaignTurn(state, 1)).toBe(state);
	const outcome = { encounterId: 'encounter:a', captureEvents: [], ownership: [
		{ planetId: 'a1', factionId: 'red' as const }, { planetId: 'a2', factionId: 'red' as const },
	] };
	const resumed = applyCampaignEncounterResult(state, outcome);
	expect(resumed.encounter?.expeditionId).toBe('z');
	expect(resumed.turn).toBe(1);
	expect(applyCampaignEncounterResult(resumed, outcome)).toBe(resumed);
	expect(function () { applyCampaignEncounterResult(resumed, { ...outcome, ownership: [] }); }).toThrow();
});

test('capture preserves depletion, applies bonus loss, and an intended hostile later arrival becomes friendly', function () {
	const start = initial();
	let state: CampaignState = { ...start, planets: start.planets.map(function (planet) {
		return planet.systemId === 'away' ? { ...planet, depletion: 110 } : planet;
	}) };
	state = commitExpedition(commitExpedition(state, order('a', 30)), order('b', 30));
	state = finish(state);
	expect(state.encounter?.planets[0]?.points).toBe(10);
	const resolved = applyCampaignEncounterResult(state, { encounterId: 'encounter:a', captureEvents: [{ planetId: 'a1', factionId: 'blue' }, { planetId: 'a2', factionId: 'blue' }], ownership: [
		{ planetId: 'a1', factionId: 'blue' }, { planetId: 'a2', factionId: 'blue' },
	] });
	expect(resolved.turn).toBe(2);
	expect(resolved.encounter).toBeNull();
	expect(resolved.expeditions.every(function (item) { return item.status === 'resolved'; })).toBe(true);
	const first = resolved.planets.find(function (planet) { return planet.id === 'a1'; });
	const second = resolved.planets.find(function (planet) { return planet.id === 'a2'; });
	expect(first?.developmentBonusPoints).toBe(10);
	expect(first?.depletion).toBe(69);
	expect(second?.depletion).toBe(99);
	expect(first?.capturedTurn).toBe(1);
	expect(first?.lastAppliedTurn).toBe(1);
	expect(state.planets.find(function (planet) { return planet.id === 'a1'; })?.depletion).toBe(110);
});

test('friendly transfers reduce highest depletion first with planet ID ties and discard excess', function () {
	const start = initial();
	const friendly = { ...start, planets: start.planets.map(function (planet) {
		return planet.systemId === 'away' ? { ...planet, factionId: 'blue' as const, depletion: 20 } : planet;
	}) };
	const next = finish(finish(commitExpedition(friendly, order('friendly', 100))));
	expect(next.encounter).toBeNull();
	expect(next.planets.filter(function (planet) { return planet.systemId === 'away'; })
		.map(function (planet) { return planet.depletion; })).toEqual([0, 0]);
	expect(next.planets[0]?.depletion).toBe(76);
});

test('invalid ownership results and newly conquered source orders fail without state changes', function () {
	const battle = finish(finish(commitExpedition(initial(), order('a'))));
	expect(function () { applyCampaignEncounterResult(battle, { encounterId: 'encounter:a', captureEvents: [{ planetId: 'a1', factionId: 'blue' }, { planetId: 'a2', factionId: 'blue' }], ownership: [] }); }).toThrow();
	expect(function () { applyCampaignEncounterResult(battle, { encounterId: 'other', captureEvents: [], ownership: [] }); }).toThrow();
	const captured = { ...initial(), planets: initial().planets.map(function (planet) {
		return planet.systemId === 'home' ? { ...planet, capturedTurn: 1 } : planet;
	}) };
	expect(function () { commitExpedition(captured, order('new')); }).toThrow();
	expect(battle.resolvedEncounters).toHaveLength(0);
});

test('brief capture and recapture apply two penalties even when final ownership is unchanged', function () {
	const battle = finish(commitExpedition(initial(), order('brief')));
	const result = { encounterId: 'encounter:brief', captureEvents: [
		{ planetId: 'a1', factionId: 'blue' as const }, { planetId: 'a1', factionId: 'red' as const },
	], ownership: [
		{ planetId: 'a1', factionId: 'red' as const }, { planetId: 'a2', factionId: 'red' as const },
	] };
	const resolved = applyCampaignEncounterResult(battle, result);
	expect(resolved.planets.find(function (planet) { return planet.id === 'a1'; })?.developmentBonusPoints).toBe(5);
	expect(resolved.planets.find(function (planet) { return planet.id === 'a1'; })?.capturedTurn).toBe(1);
	expect(applyCampaignEncounterResult(resolved, { ...result, ownership: result.ownership.toReversed() })).toBe(resolved);
	expect(function () {
		applyCampaignEncounterResult(battle, { ...result, captureEvents: [{ planetId: 'a1', factionId: 'red' }] });
	}).toThrow();
	expect(function () {
		applyCampaignEncounterResult(battle, { ...result, captureEvents: [{ planetId: 'unknown', factionId: 'blue' }] });
	}).toThrow();
	expect(function () {
		applyCampaignEncounterResult(battle, { ...result, captureEvents: [{ planetId: 'a1', factionId: 'blue' }] });
	}).toThrow();
	expect(battle.planets.find(function (planet) { return planet.id === 'a1'; })?.developmentBonusPoints).toBe(20);
});

test('due arrivals prioritize precise arrival time before identity', function () {
	const start = initial();
	const delayed = { ...start, systems: [...start.systems, { id: 'far', name: 'Far', x: -50, y: 0, map }],
		planets: [...start.planets, makePlanet('f1', 'far', 'One', 'blue'), makePlanet('f2', 'far', 'Two', 'blue')] };
	let state = commitExpedition(delayed, { ...order('a'), sourceSystemId: 'far', contributions: [{ planetId: 'f1', points: 30 }] });
	state = finish(state);
	state = commitExpedition(state, order('z'));
	state = finish(state);
	expect(state.encounter?.expeditionId).toBe('a');
	expect(state.expeditions.find(function (item) { return item.id === 'a'; })?.arrivalTime).toBe(1.5);
	expect(state.expeditions.find(function (item) { return item.id === 'z'; })?.arrivalTime).toBe(2);
});

test('idle completion applies growth and recovery once and allows captured sources next turn', function () {
	const state = { ...initial(), planets: initial().planets.map(function (planet) {
		return planet.systemId === 'home' ? { ...planet, capturedTurn: 1, depletion: 20 } : planet;
	}) };
	const next = finish(state);
	expect(next.turn).toBe(2);
	expect(next.planets[0]?.depletion).toBe(8);
	expect(resolveCampaignTurn(next, 1)).toBe(next);
	expect(commitExpedition(next, order('eligible', 10)).expeditions).toHaveLength(1);
});
