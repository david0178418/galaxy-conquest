import type { Side } from './config';
import type { StarMap } from './maps';
import { availablePoints, commitPoints } from './campaign-points';
import type { PointContribution, PointRecoveryPolicy } from './campaign-points';
import { captureDevelopment, completeDevelopmentTurn, developmentMaximum } from './campaign-development';
import type { DevelopmentPolicy, PlanetDevelopment } from './campaign-development';

export interface CampaignRules {
	readonly travelSpeed: number;
	readonly development: DevelopmentPolicy;
	readonly recovery: PointRecoveryPolicy;
}
export const CAMPAIGN_RULES: CampaignRules = {
	travelSpeed: 100,
	development: { growthFraction: 0.02, capFraction: 0.2, captureLossFraction: 0.5 },
	recovery: { fractionOfMaximum: 0.1 },
};
export interface CampaignSystem {
	readonly id: string;
	readonly name: string;
	readonly x: number;
	readonly y: number;
	readonly map: StarMap;
}
export interface CampaignPlanet extends PlanetDevelopment {
	readonly id: string;
	readonly systemId: string;
	/** Unique tactical map planet name in this system. */
	readonly name: string;
	readonly factionId: Side | null;
}
export interface ExpeditionOrder {
	/** Globally unique caller-supplied idempotency key, also the expedition identity. */
	readonly id: string;
	readonly factionId: Side;
	readonly sourceSystemId: string;
	readonly destinationSystemId: string;
	readonly contributions: readonly PointContribution[];
}
export interface CampaignExpedition extends ExpeditionOrder {
	readonly points: number;
	readonly departureTurn: number;
	readonly arrivalTime: number;
	readonly status: 'traveling' | 'encounter' | 'resolved';
}
export interface EncounterPlanet {
	readonly planetId: string;
	readonly name: string;
	readonly factionId: Side | null;
	readonly points: number;
}
export interface CampaignEncounter {
	readonly id: string;
	readonly expeditionId: string;
	readonly systemId: string;
	readonly attacker: Side;
	readonly attackerPoints: number;
	readonly planets: readonly EncounterPlanet[];
}
export interface CampaignEncounterResult {
	readonly encounterId: string;
	readonly captureEvents: readonly { readonly planetId: string; readonly factionId: Side }[];
	/** Complete final ownership only. Tactical units never become campaign points. */
	readonly ownership: readonly { readonly planetId: string; readonly factionId: Side | null }[];
}
export interface CampaignState {
	readonly turn: number;
	readonly phase: 'planning' | 'resolving' | 'encounter';
	readonly rules: CampaignRules;
	readonly systems: readonly CampaignSystem[];
	readonly planets: readonly CampaignPlanet[];
	readonly expeditions: readonly CampaignExpedition[];
	readonly readyFactions: readonly Side[];
	readonly encounter: CampaignEncounter | null;
	readonly resolvedEncounters: readonly CampaignEncounterResult[];
}

const compareIds = function (a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; };
const requireId = function (id: string): void { if (!id.trim()) throw new Error('Campaign identity must not be empty.'); };
const requireSide = function (side: Side): void {
	if (side !== 'blue' && side !== 'red') throw new Error('Unknown campaign faction.');
};
const sameOrder = function (a: ExpeditionOrder, b: ExpeditionOrder): boolean {
	return a.factionId === b.factionId && a.sourceSystemId === b.sourceSystemId &&
		a.destinationSystemId === b.destinationSystemId && a.contributions.length === b.contributions.length &&
		a.contributions.every(function (item, index) {
			const other = b.contributions[index];
			return other !== undefined && item.planetId === other.planetId && item.points === other.points;
		});
};

export const commitExpedition = function (state: CampaignState, order: ExpeditionOrder): CampaignState {
	requireId(order.id);
	requireSide(order.factionId);
	const existing = state.expeditions.find(function (item) { return item.id === order.id; });
	if (existing) {
		if (!sameOrder(existing, order)) throw new Error('Order identity was already used with different contributions.');
		return state;
	}
	if (state.phase !== 'planning' || state.readyFactions.includes(order.factionId))
		throw new Error('Orders are frozen after faction commitment.');
	const source = state.systems.find(function (system) { return system.id === order.sourceSystemId; });
	const destination = state.systems.find(function (system) { return system.id === order.destinationSystemId; });
	if (!source || !destination || source.id === destination.id) throw new Error('An expedition requires distinct known systems.');
	if (state.planets.some(function (planet) { return planet.systemId === source.id && planet.capturedTurn === state.turn; }))
		throw new Error('Conquered systems can issue orders on the next galaxy turn.');
	if (!Number.isFinite(state.rules.travelSpeed) || state.rules.travelSpeed <= 0) throw new Error('Travel speed must be positive.');
	const travelTime = Math.max(1, Math.hypot(destination.x - source.x, destination.y - source.y) / state.rules.travelSpeed);
	const arrivalTime = state.turn - 1 + travelTime;
	if (!Number.isFinite(arrivalTime) || arrivalTime > Number.MAX_SAFE_INTEGER) throw new Error('Invalid expedition arrival time.');
	const committed = commitPoints(state.planets.map(function (planet) {
		return { planetId: planet.id, systemId: planet.systemId, factionId: planet.factionId,
			maximumPoints: developmentMaximum(planet), depletion: planet.depletion };
	}), source.id, order.factionId, order.contributions);
	if (committed.totalPoints === 0) throw new Error('An expedition must commit points.');
	const debits = new Map(committed.balances.map(function (balance) { return [balance.planetId, balance.depletion] as const; }));
	const expedition: CampaignExpedition = { ...order, contributions: committed.debits, points: committed.totalPoints,
		departureTurn: state.turn, arrivalTime, status: 'traveling' };
	return { ...state, planets: state.planets.map(function (planet) {
		const depletion = debits.get(planet.id);
		if (depletion === undefined) throw new Error('Missing committed planetary balance.');
		return { ...planet, depletion };
	}), expeditions: [...state.expeditions, expedition] };
};

export const commitFactionTurn = function (state: CampaignState, factionId: Side): CampaignState {
	requireSide(factionId);
	if (state.readyFactions.includes(factionId)) return state;
	if (state.phase !== 'planning') throw new Error('The galaxy turn is already resolving.');
	return { ...state, readyFactions: [...state.readyFactions, factionId] };
};

const resolveArrivals = function (initial: CampaignState): CampaignState {
	let state = initial;
	const due = state.expeditions.filter(function (item) { return item.status === 'traveling' && item.arrivalTime <= state.turn; })
		.toSorted(function (a, b) { return a.arrivalTime - b.arrivalTime || compareIds(a.id, b.id); });
	for (const expedition of due) {
		const destination = state.planets.filter(function (planet) { return planet.systemId === expedition.destinationSystemId; });
		if (destination.length === 0) throw new Error('Destination system has no planets.');
		if (destination.every(function (planet) { return planet.factionId === expedition.factionId; })) {
			let remaining = expedition.points;
			const depleted = destination.toSorted(function (a, b) { return b.depletion - a.depletion || compareIds(a.id, b.id); });
			const reductions = new Map<string, number>();
			for (const planet of depleted) {
				const amount = Math.min(planet.depletion, remaining);
				remaining -= amount;
				reductions.set(planet.id, planet.depletion - amount);
			}
			state = { ...state, planets: state.planets.map(function (planet) {
				return { ...planet, depletion: reductions.get(planet.id) ?? planet.depletion };
			}), expeditions: state.expeditions.map(function (item) {
				return item.id === expedition.id ? { ...item, status: 'resolved' as const } : item;
			}) };
			continue;
		}
		const encounter: CampaignEncounter = { id: `encounter:${expedition.id}`, expeditionId: expedition.id,
			systemId: expedition.destinationSystemId, attacker: expedition.factionId, attackerPoints: expedition.points,
			planets: destination.map(function (planet) {
				return { planetId: planet.id, name: planet.name, factionId: planet.factionId,
					points: availablePoints(developmentMaximum(planet), planet.depletion) };
			}) };
		return { ...state, phase: 'encounter', encounter, expeditions: state.expeditions.map(function (item) {
			return item.id === expedition.id ? { ...item, status: 'encounter' as const } : item;
		}) };
	}
	const planets = state.planets.map(function (planet) {
		return { ...planet, ...completeDevelopmentTurn(planet, state.turn, state.rules.development, state.rules.recovery), factionId: planet.factionId };
	});
	if (!Number.isSafeInteger(state.turn + 1)) throw new Error('Galaxy turn limit reached.');
	return { ...state, planets, turn: state.turn + 1, phase: 'planning', readyFactions: [], encounter: null };
};

export const resolveCampaignTurn = function (state: CampaignState, turn: number): CampaignState {
	if (!Number.isSafeInteger(turn) || turn < 1 || turn > state.turn) throw new Error('Invalid galaxy turn boundary.');
	if (turn < state.turn || state.phase === 'encounter') return state;
	if (!state.readyFactions.includes('blue') || !state.readyFactions.includes('red'))
		throw new Error('Both factions must commit before resolution.');
	return resolveArrivals({ ...state, phase: 'resolving' });
};

export const applyCampaignEncounterResult = function (state: CampaignState, result: CampaignEncounterResult): CampaignState {
	const prior = state.resolvedEncounters.find(function (item) { return item.encounterId === result.encounterId; });
	if (prior) {
		const sameCaptures = prior.captureEvents.length === result.captureEvents.length && prior.captureEvents.every(function (event, index) {
			const other = result.captureEvents[index];
			return other !== undefined && event.planetId === other.planetId && event.factionId === other.factionId;
		});
		const sameOwnership = prior.ownership.length === result.ownership.length && prior.ownership.every(function (item) {
			return result.ownership.filter(function (other) { return other.planetId === item.planetId && other.factionId === item.factionId; }).length === 1;
		});
		if (!sameCaptures || !sameOwnership) throw new Error('Encounter result identity was reused with a different outcome.');
		return state;
	}
	const encounter = state.encounter;
	if (state.phase !== 'encounter' || !encounter || encounter.id !== result.encounterId)
		throw new Error('Encounter result does not match the active encounter.');
	const ownership = new Map<string, Side | null>();
	for (const item of result.ownership) {
		if (item.factionId !== null) requireSide(item.factionId);
		if (ownership.has(item.planetId) || !encounter.planets.some(function (planet) { return planet.planetId === item.planetId; }))
			throw new Error('Encounter ownership must identify each destination planet once.');
		ownership.set(item.planetId, item.factionId);
	}
	if (ownership.size !== encounter.planets.length) throw new Error('Encounter outcome is missing planetary ownership.');
	let planets = state.planets;
	for (const event of result.captureEvents) {
		requireSide(event.factionId);
		if (!ownership.has(event.planetId)) throw new Error('Capture event identifies an unknown destination planet.');
		const captured = planets.find(function (planet) { return planet.id === event.planetId; });
		if (!captured || captured.factionId === event.factionId) throw new Error('Capture events must change actual ownership.');
		planets = planets.map(function (planet) {
			return planet.id !== event.planetId ? planet : {
				...planet, ...captureDevelopment(planet, event.factionId, state.turn, state.rules.development), factionId: event.factionId,
			};
		});
	}
	if (planets.some(function (planet) { return ownership.has(planet.id) && ownership.get(planet.id) !== planet.factionId; }))
		throw new Error('Final ownership does not match the ordered capture events.');
	return resolveArrivals({ ...state, planets, phase: 'resolving', encounter: null,
		expeditions: state.expeditions.map(function (item) {
			return item.id === encounter.expeditionId ? { ...item, status: 'resolved' as const } : item;
		}), resolvedEncounters: [...state.resolvedEncounters, structuredClone(result)] });
};
