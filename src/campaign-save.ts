import * as z from 'zod/mini';
import type { CampaignState, CampaignEncounterResult } from './campaign-state';
import { validateCampaignEncounterSetup } from './campaign-setup';
import type { CampaignEncounterSetup } from './campaign-setup';
import type { GameSnapshot } from './save-state';
import { availablePoints } from './campaign-points';
import { gameSnapshotSchema, InvalidSaveError } from './save-state';

export const CAMPAIGN_SAVE_SCHEMA_VERSION = 1;

export type SavedCampaignEncounter =
	| { phase: 'allocation'; encounterId: string; setup: CampaignEncounterSetup }
	| { phase: 'battle'; encounterId: string; setup: CampaignEncounterSetup; game: GameSnapshot; captureEvents: CampaignEncounterResult['captureEvents'] };

export interface CampaignSave {
	schemaVersion: number;
	mode: 'campaign';
	profileId: string;
	savedAt: number;
	campaign: CampaignState;
	encounterState?: SavedCampaignEncounter;
}

const id = z.string().check(z.minLength(1), z.maxLength(128), z.refine(function (value) { return value.trim().length > 0; }));
const amount = z.number().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));
const galaxyCoordinate = z.number().check(z.gte(-Number.MAX_SAFE_INTEGER), z.lte(Number.MAX_SAFE_INTEGER));
const integer = amount.check(z.refine(Number.isSafeInteger));
const positiveInteger = integer.check(z.gt(0));
const fraction = z.number().check(z.gte(0), z.lte(1));
const side = z.enum(['blue', 'red']);
const owner = z.nullable(side);
const contribution = z.object({ planetId: id, points: integer });
const planet = z.object({
	id, systemId: id, name: id, factionId: owner,
	baselinePoints: amount, developmentBonusPoints: amount, depletion: amount,
	capturedTurn: z.nullable(integer), lastAppliedTurn: integer,
});
const expedition = z.object({
	id, factionId: side, sourceSystemId: id, destinationSystemId: id,
	contributions: z.array(contribution).check(z.maxLength(100)),
	points: positiveInteger, departureTurn: positiveInteger, arrivalTime: amount,
	status: z.enum(['traveling', 'encounter', 'resolved']),
});
const encounter = z.object({
	id, expeditionId: id, systemId: id, attacker: side, attackerPoints: positiveInteger,
	planets: z.array(z.object({ planetId: id, name: id, factionId: owner, points: amount })).check(z.minLength(1), z.maxLength(100)),
});
const result = z.object({
	encounterId: id,
	captureEvents: z.array(z.object({ planetId: id, factionId: side })).check(z.maxLength(10000)),
	ownership: z.array(z.object({ planetId: id, factionId: owner })).check(z.minLength(1), z.maxLength(100)),
});
const unique = function (values: readonly string[]): boolean { return new Set(values).size === values.length; };

const hasCampaignIntegrity = function (state: CampaignState): boolean {
	const systems = new Map(state.systems.map(function (system) { return [system.id, system] as const; }));
	const planets = new Map(state.planets.map(function (item) { return [item.id, item] as const; }));
	const expeditions = new Map(state.expeditions.map(function (item) { return [item.id, item] as const; }));
	if (systems.size !== state.systems.length || planets.size !== state.planets.length || expeditions.size !== state.expeditions.length ||
		!unique(state.readyFactions) || !unique(state.resolvedEncounters.map(function (item) { return item.encounterId; }))) return false;
	for (const system of state.systems) {
		const local = state.planets.filter(function (item) { return item.systemId === system.id; });
		if (local.length !== system.map.planets.length || !unique(local.map(function (item) { return item.name; })) ||
			!unique(system.map.planets.map(function (seed) { return seed[0]; })) ||
			local.some(function (item) { return !system.map.planets.some(function (seed) { return seed[0] === item.name; }); })) return false;
	}
	for (const item of state.planets) {
		if (!systems.has(item.systemId) || item.lastAppliedTurn !== state.turn - 1 ||
			(item.capturedTurn !== null && item.capturedTurn > state.turn) ||
			item.developmentBonusPoints > item.baselinePoints * state.rules.development.capFraction ||
			item.baselinePoints + item.developmentBonusPoints > Number.MAX_SAFE_INTEGER) return false;
	}
	for (const item of state.expeditions) {
		const source = systems.get(item.sourceSystemId);
		const destination = systems.get(item.destinationSystemId);
		if (!source || !destination || source.id === destination.id || item.departureTurn > state.turn ||
			!unique(item.contributions.map(function (entry) { return entry.planetId; })) ||
			item.points !== item.contributions.reduce(function (total, entry) { return total + entry.points; }, 0) ||
			item.contributions.some(function (entry) { return planets.get(entry.planetId)?.systemId !== source.id; }) ||
			item.arrivalTime !== item.departureTurn - 1 + Math.max(1, Math.hypot(destination.x - source.x, destination.y - source.y) / state.rules.travelSpeed)) return false;
		if (item.status !== 'traveling' && item.arrivalTime > state.turn) return false;
	}
	const active = state.expeditions.filter(function (item) { return item.status === 'encounter'; });
	if (state.phase === 'planning' ? state.readyFactions.length > 2 : state.readyFactions.length !== 2) return false;
	if ((state.phase === 'encounter') !== (state.encounter !== null)) return false;
	if (!state.encounter) {
		if (active.length !== 0) return false;
	} else {
		const current = state.encounter;
		const order = expeditions.get(current.expeditionId);
		const local = state.planets.filter(function (item) { return item.systemId === current.systemId; });
		const firstDue = state.expeditions.filter(function (item) {
			return item.status !== 'resolved' && item.arrivalTime <= state.turn;
		}).toSorted(function (a, b) {
			return a.arrivalTime - b.arrivalTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
		})[0];
		if (active.length !== 1 || !order || firstDue?.id !== order.id || order.status !== 'encounter' ||
			current.id !== `encounter:${order.id}` || current.systemId !== order.destinationSystemId ||
			current.attacker !== order.factionId || current.attackerPoints !== order.points ||
			current.planets.length !== local.length || !unique(current.planets.map(function (item) { return item.planetId; })) ||
			current.planets.every(function (item) { return item.factionId === current.attacker; })) return false;
		for (const input of current.planets) {
			const saved = planets.get(input.planetId);
			if (!saved || saved.systemId !== current.systemId || saved.name !== input.name || saved.factionId !== input.factionId ||
				input.points !== availablePoints(saved.baselinePoints + saved.developmentBonusPoints, saved.depletion)) return false;
		}
	}
	for (const resolved of state.resolvedEncounters) {
		const order = state.expeditions.find(function (item) { return resolved.encounterId === `encounter:${item.id}`; });
		if (!order || order.status !== 'resolved' || state.encounter?.id === resolved.encounterId ||
			!unique(resolved.ownership.map(function (item) { return item.planetId; }))) return false;
		const local = state.planets.filter(function (item) { return item.systemId === order.destinationSystemId; });
		if (local.length !== resolved.ownership.length || resolved.captureEvents.some(function (item) {
			return planets.get(item.planetId)?.systemId !== order.destinationSystemId;
		}) || resolved.ownership.some(function (item) {
			return planets.get(item.planetId)?.systemId !== order.destinationSystemId;
		})) return false;
		const lastCaptures = new Map<string, 'blue' | 'red'>();
		for (const event of resolved.captureEvents) {
			if (lastCaptures.get(event.planetId) === event.factionId) return false;
			lastCaptures.set(event.planetId, event.factionId);
		}
		const finalOwners = new Map(resolved.ownership.map(function (item) { return [item.planetId, item.factionId] as const; }));
		for (const [planetId, factionId] of lastCaptures) {
			if (finalOwners.get(planetId) !== factionId) return false;
		}
	}
	return true;
};

export const campaignStateSchema = z.object({
	turn: positiveInteger,
	phase: z.enum(['planning', 'resolving', 'encounter']),
	rules: z.object({
		travelSpeed: z.number().check(z.gt(0), z.lte(Number.MAX_SAFE_INTEGER)),
		development: z.object({ growthFraction: fraction, capFraction: fraction, captureLossFraction: fraction }),
		recovery: z.object({ fractionOfMaximum: fraction }),
	}),
	systems: z.array(z.object({ id, name: id, x: galaxyCoordinate, y: galaxyCoordinate, map: gameSnapshotSchema.shape.map })).check(z.minLength(1), z.maxLength(100)),
	planets: z.array(planet).check(z.minLength(1), z.maxLength(10000)),
	expeditions: z.array(expedition).check(z.maxLength(10000)),
	readyFactions: z.array(side).check(z.maxLength(2)),
	encounter: z.nullable(encounter),
	resolvedEncounters: z.array(result).check(z.maxLength(10000)),
}).check(z.refine(hasCampaignIntegrity)) satisfies z.ZodMiniType<CampaignState>;

const setupSchema = z.strictObject({
	costs: z.object({ troops: positiveInteger, ships: positiveInteger, guns: positiveInteger }),
	defenders: z.array(z.object({ planetId: id, forces: z.object({ troops: integer, ships: integer, guns: integer }) })).check(z.maxLength(100)),
	beachheads: z.array(z.object({ planetId: id, troops: integer, ships: integer })).check(z.maxLength(100)),
}) satisfies z.ZodMiniType<CampaignEncounterSetup>;
const isRecord = function (input: unknown): input is Record<string, unknown> {
	return typeof input === 'object' && input !== null && !Array.isArray(input);
};
const isDenseArray = function (input: unknown): input is unknown[] {
	return Array.isArray(input) && Array.from({ length: input.length }, function (_, index) {
		return Object.hasOwn(input, index);
	}).every(Boolean);
};
// Legacy skirmish saves intentionally retain sparse-array semantics. Campaign
// restoration iterates these collections, so reject holes before legacy refinements.
const hasDenseSnapshotCollections = function (input: unknown): boolean {
	if (!isRecord(input) || !isRecord(input.map) || !isRecord(input.match) || !isRecord(input.orderBook) ||
		!isDenseArray(input.planets) || !isDenseArray(input.units) || !isDenseArray(input.map.planets) ||
		!isDenseArray(input.match.notices) || !isDenseArray(input.orderBook.active)) return false;
	return input.map.planets.every(isDenseArray) && input.orderBook.active.every(function (order) {
		return isRecord(order) && isDenseArray(order.departures);
	});
};
const campaignSnapshotSchema = z.pipe(z.unknown().check(z.refine(hasDenseSnapshotCollections, { abort: true })), gameSnapshotSchema);
const savedEncounterSchema = z.discriminatedUnion('phase', [
	z.strictObject({ phase: z.literal('allocation'), encounterId: id, setup: setupSchema }),
	z.strictObject({ phase: z.literal('battle'), encounterId: id, setup: setupSchema, game: campaignSnapshotSchema,
		captureEvents: z.array(z.object({ planetId: id, factionId: side })).check(z.maxLength(10000)) }),
]) satisfies z.ZodMiniType<SavedCampaignEncounter>;

const hasSavedEncounterIntegrity = function (save: CampaignSave): boolean {
	const saved = save.encounterState;
	if (!saved) return true;
	const encounter = save.campaign.encounter;
	if (save.campaign.phase !== 'encounter' || !encounter || encounter.id !== saved.encounterId) return false;
	try { validateCampaignEncounterSetup(encounter, saved.setup); } catch { return false; }
	if (saved.phase === 'allocation') return true;
	const system = save.campaign.systems.find(function (item) { return item.id === encounter.systemId; });
	const game = saved.game;
	if (!system || game.scenario !== 'skirmish' || game.map.width !== system.map.width || game.map.height !== system.map.height ||
		game.map.planets.length !== encounter.planets.length || game.planets.length !== encounter.planets.length ||
		game.match.captures !== saved.captureEvents.length) return false;
	const ownership = new Map(encounter.planets.map(function (item) { return [item.planetId, item.factionId] as const; }));
	for (const event of saved.captureEvents) {
		if (!ownership.has(event.planetId) || ownership.get(event.planetId) === event.factionId) return false;
		ownership.set(event.planetId, event.factionId);
	}
	for (const input of encounter.planets) {
		const seed = system.map.planets.find(function (item) { return item[0] === input.name; });
		const snapshotSeed = game.map.planets.find(function (item) { return item[0] === input.name; });
		const snapshotPlanet = game.planets.find(function (item) { return item.planet.name === input.name; })?.planet;
		const defender = saved.setup.defenders.find(function (item) { return item.planetId === input.planetId; });
		if (!seed || !snapshotSeed || !snapshotPlanet || !defender ||
			snapshotSeed[1] !== seed[1] || snapshotSeed[2] !== seed[2] || snapshotSeed[3] !== seed[3] || snapshotSeed[6] !== seed[6] ||
			snapshotSeed[4] !== (input.factionId ?? 'neutral') || snapshotSeed[5] !== defender.forces.troops ||
			(snapshotPlanet.owner === 'neutral' ? null : snapshotPlanet.owner) !== ownership.get(input.planetId)) return false;
	}
	const winner = game.match.winner;
	if (winner !== null) {
		const viable = function (factionId: 'blue' | 'red'): boolean {
			return game.planets.some(function (item) { return item.planet.owner === factionId; }) ||
				game.units.some(function (item) { return item.unit.owner === factionId && item.unit.kind === 'transport' && item.unit.cargo > 0; });
		};
		if (!viable(winner) || viable(winner === 'blue' ? 'red' : 'blue')) return false;
	}
	return true;
};

const campaignSaveSchema = z.strictObject({
	schemaVersion: z.literal(CAMPAIGN_SAVE_SCHEMA_VERSION), mode: z.literal('campaign'),
	profileId: id, savedAt: z.number().check(z.gt(0)), campaign: campaignStateSchema,
	encounterState: z.optional(savedEncounterSchema),
}).check(z.refine(hasSavedEncounterIntegrity)) satisfies z.ZodMiniType<CampaignSave>;

export const parseCampaignSave = function (input: unknown, expectedProfileId?: string): CampaignSave {
	if (typeof input === 'object' && input !== null && 'schemaVersion' in input &&
		typeof input.schemaVersion === 'number' && input.schemaVersion > CAMPAIGN_SAVE_SCHEMA_VERSION)
		throw new InvalidSaveError('This campaign was created by a newer game version. Its profile data was kept unchanged.');
	const parsed = campaignSaveSchema.safeParse(input);
	if (!parsed.success || (expectedProfileId !== undefined && parsed.data.profileId !== expectedProfileId))
		throw new InvalidSaveError('Could not validate this saved campaign. Its profile data was kept unchanged.');
	return parsed.data;
};

export const isSupportedCampaignSave = function (input: unknown, expectedProfileId?: string): boolean {
	try { parseCampaignSave(input, expectedProfileId); return true; } catch { return false; }
};
