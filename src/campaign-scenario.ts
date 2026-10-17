import type { Side } from './config';
import type { StarMap } from './maps';
import { CAMPAIGN_RULES, commitExpedition } from './campaign-state';
import type { CampaignPlanet, CampaignState, CampaignSystem } from './campaign-state';
import { availablePoints } from './campaign-points';
import { developmentMaximum } from './campaign-development';

const compareIds = function (a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; };
const systemMap = function (factionId: Side, names: readonly [string, string, string]): StarMap {
	return { width: 1000, height: 700, planets: [
		[names[0], 200, 230, 32, factionId, 0, 1.8],
		[names[1], 750, 230, 35, factionId, 0, 2.2],
		[names[2], 500, 530, 30, factionId, 0, 1.5],
	] };
};

/** Minimal deterministic two-system fixture; tactical starting units come from point allocation. */
export const createCampaign = function (): CampaignState {
	const systems: CampaignSystem[] = [
		{ id: 'sol', name: 'Sol', x: 100, y: 100, map: systemMap('blue', ['Terra', 'Vega', 'Luna']) },
		{ id: 'sirius', name: 'Sirius', x: 200, y: 100, map: systemMap('red', ['Sirius', 'Rigel', 'Altair']) },
	];
	const planets: CampaignPlanet[] = systems.flatMap(function (system) {
		return system.map.planets.map(function (seed, index) {
			return { id: `${system.id}:${index + 1}`, systemId: system.id, name: seed[0],
				factionId: system.id === 'sol' ? 'blue' as const : 'red' as const,
				baselinePoints: 100, developmentBonusPoints: 0, depletion: 0, capturedTurn: null, lastAppliedTurn: 0 };
		});
	});
	return { turn: 1, phase: 'planning', rules: structuredClone(CAMPAIGN_RULES), systems, planets,
		expeditions: [], readyFactions: [], encounter: null, resolvedEncounters: [] };
};

/** Commit at most one rival expedition. Retry identity and source spending live in the domain. */
export const commitCampaignRival = function (state: CampaignState): CampaignState {
	const id = `rival:${state.turn}`;
	if (state.phase !== 'planning' || state.readyFactions.includes('red') || state.expeditions.some(function (item) { return item.id === id; })) return state;
	const routes = state.systems.flatMap(function (source) {
		const local = state.planets.filter(function (planet) { return planet.systemId === source.id; });
		const owned = local.filter(function (planet) { return planet.factionId === 'red'; });
		if (owned.length === 0 || local.some(function (planet) { return planet.capturedTurn === state.turn; })) return [];
		const available = owned.reduce(function (total, planet) { return total + availablePoints(developmentMaximum(planet), planet.depletion); }, 0);
		if (Math.floor(available / 2) === 0) return [];
		return state.systems.filter(function (destination) {
			return destination.id !== source.id && state.planets.some(function (planet) { return planet.systemId === destination.id && planet.factionId !== 'red'; });
		}).map(function (destination) {
			return { source, destination, owned, budget: Math.floor(available / 2), distance: Math.hypot(destination.x - source.x, destination.y - source.y) };
		});
	}).toSorted(function (a, b) {
		return a.distance - b.distance || compareIds(a.source.id, b.source.id) || compareIds(a.destination.id, b.destination.id);
	});
	for (const route of routes) {
		let remaining = route.budget;
		const contributions = route.owned.toSorted(function (a, b) { return compareIds(a.id, b.id); }).flatMap(function (planet) {
			const points = Math.min(remaining, Math.floor(availablePoints(developmentMaximum(planet), planet.depletion)));
			remaining -= points;
			return points > 0 ? [{ planetId: planet.id, points }] : [];
		});
		// Fractional recovery remains on each planet; it cannot fund a whole-point debit elsewhere.
		if (contributions.length === 0) continue;
		return commitExpedition(state, { id, factionId: 'red', sourceSystemId: route.source.id,
			destinationSystemId: route.destination.id, contributions });
	}
	return state;
};

/** Wait until every due arrival resolves before declaring victory; in-flight relief keeps a faction alive. */
export const campaignWinner = function (state: CampaignState): Side | null {
	if (state.phase !== 'planning') return null;
	const alive = function (factionId: Side): boolean {
		return state.planets.some(function (planet) { return planet.factionId === factionId; }) ||
			state.expeditions.some(function (item) { return item.factionId === factionId && item.status !== 'resolved'; });
	};
	const blue = alive('blue');
	const red = alive('red');
	return blue && !red ? 'blue' : red && !blue ? 'red' : null;
};
