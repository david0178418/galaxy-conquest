import { expect, test } from 'bun:test';
import { campaignWinner, commitCampaignRival, createCampaign } from './campaign-scenario';
import { parseCampaignSave } from './campaign-save';
import { applyCampaignEncounterResult, commitExpedition, commitFactionTurn, resolveCampaignTurn } from './campaign-state';
import type { CampaignState } from './campaign-state';

const finish = function (state: CampaignState): CampaignState {
	return resolveCampaignTurn(commitFactionTurn(commitFactionTurn(state, 'blue'), 'red'), state.turn);
};

test('fixture has two owned three-planet systems and round-trips campaign validation', function () {
	const state = createCampaign();
	expect(state.systems).toHaveLength(2);
	expect(state.planets).toHaveLength(6);
	expect(state.planets.filter(function (planet) { return planet.factionId === 'blue'; })).toHaveLength(3);
	expect(state.planets.every(function (planet) { return planet.baselinePoints === 100; })).toBe(true);
	const save = { schemaVersion: 1, mode: 'campaign' as const, profileId: 'p', savedAt: 100, campaign: state };
	expect(parseCampaignSave(save)).toEqual(save);
	expect(createCampaign()).toEqual(state);
});

test('rival commits half its source budget once, using stable planets without overspending', function () {
	const start = createCampaign();
	const next = commitCampaignRival(start);
	expect(next.expeditions).toHaveLength(1);
	expect(next.expeditions[0]?.id).toBe('rival:1');
	expect(next.expeditions[0]?.points).toBe(150);
	expect(next.expeditions[0]?.arrivalTime).toBe(1);
	expect(next.expeditions[0]?.contributions).toEqual([{ planetId: 'sirius:1', points: 100 }, { planetId: 'sirius:2', points: 50 }]);
	expect(commitCampaignRival(next)).toBe(next);
	expect(start.planets.every(function (planet) { return planet.depletion === 0; })).toBe(true);
	expect(commitCampaignRival(commitFactionTurn(start, 'red')).expeditions).toHaveLength(0);
});

test('rival targets nearest hostile system and breaks equal distances with stable identities', function () {
	const start = createCampaign();
	const home = start.systems.find(function (system) { return system.id === 'sol'; });
	if (!home) throw new Error('Missing fixture home');
	const tied = { ...start, systems: [...start.systems, { ...home, id: 'alpha', name: 'Alpha', x: 200, y: 200 }],
		planets: [...start.planets, ...start.planets.filter(function (planet) { return planet.systemId === 'sol'; }).map(function (planet) {
			return { ...planet, id: `alpha:${planet.id}`, systemId: 'alpha' };
		})] };
	expect(commitCampaignRival(tied).expeditions[0]?.destinationSystemId).toBe('alpha');
	const nearer = { ...tied, systems: tied.systems.map(function (system) { return system.id === 'sol' ? { ...system, x: 190 } : system; }) };
	expect(commitCampaignRival(nearer).expeditions[0]?.destinationSystemId).toBe('sol');
});

test('zero and individually unspendable fractional budgets produce no order', function () {
	const state = createCampaign();
	for (const remainder of [0, 0.9]) {
		const depleted = { ...state, planets: state.planets.map(function (planet) { return { ...planet, depletion: 100 - remainder }; }) };
		expect(commitCampaignRival(depleted)).toBe(depleted);
	}
});

test('rival floors half an odd balance and can issue another order on the next completed turn', function () {
	const start = createCampaign();
	const odd = { ...start, planets: start.planets.map(function (planet) {
		return planet.id === 'sirius:1' ? { ...planet, depletion: 1 } : planet;
	}) };
	expect(commitCampaignRival(odd).expeditions[0]?.points).toBe(149);
	const battle = finish(commitCampaignRival(start));
	const defenders = battle.planets.filter(function (planet) { return planet.systemId === 'sol'; });
	const nextTurn = applyCampaignEncounterResult(battle, { encounterId: 'encounter:rival:1', captureEvents: [],
		ownership: defenders.map(function (planet) { return { planetId: planet.id, factionId: planet.factionId }; }) });
	const next = commitCampaignRival(nextTurn);
	expect(next.turn).toBe(2);
	expect(next.expeditions.at(-1)?.id).toBe('rival:2');
	expect(next.expeditions.at(-1)?.points).toBe(88);
	expect(commitCampaignRival(next)).toBe(next);
});

test('planet loss does not eliminate a faction while relief remains in flight or an encounter is active', function () {
	const start = createCampaign();
	const sent = commitCampaignRival(start);
	const lost = { ...sent, planets: sent.planets.map(function (planet) { return { ...planet, factionId: 'blue' as const }; }) };
	expect(campaignWinner(lost)).toBeNull();
	const resolved = { ...lost, expeditions: lost.expeditions.map(function (item) { return { ...item, status: 'resolved' as const }; }) };
	expect(campaignWinner(resolved)).toBe('blue');
	expect(campaignWinner({ ...resolved, phase: 'encounter' })).toBeNull();
	expect(campaignWinner({ ...resolved, planets: resolved.planets.map(function (planet) { return { ...planet, factionId: 'red' as const }; }) })).toBe('red');
});

test('the last encounter result returns to planning and then declares campaign victory', function () {
	const start = createCampaign();
	const state = finish(commitExpedition(start, { id: 'attack', factionId: 'blue', sourceSystemId: 'sol', destinationSystemId: 'sirius',
		contributions: [{ planetId: 'sol:1', points: 100 }] }));
	expect(campaignWinner(state)).toBeNull();
	const target = state.planets.filter(function (planet) { return planet.systemId === 'sirius'; });
	const final = applyCampaignEncounterResult(state, { encounterId: 'encounter:attack',
		captureEvents: target.map(function (planet) { return { planetId: planet.id, factionId: 'blue' as const }; }),
		ownership: target.map(function (planet) { return { planetId: planet.id, factionId: 'blue' as const }; }) });
	expect(final.phase).toBe('planning');
	expect(campaignWinner(final)).toBe('blue');
});
