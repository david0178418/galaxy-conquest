import { createGame, planets, spawnShip, units } from './game';
import type { Game, GameOptions } from './game';
import type { Side } from './config';
import { CONFIG } from './config';
import type { CampaignEncounterResult, CampaignState } from './campaign-state';
import type { StarMap, PlanetSeed } from './maps';
import type { GameSnapshot } from './save-state';
import { seedFreshGame } from './game-scenario';
import { validateCampaignEncounterSetup } from './campaign-setup';
import type { CampaignEncounterSetup } from './campaign-setup';

type CampaignCapture = CampaignEncounterResult['captureEvents'][number];

export interface CampaignEncounterRuntimeInput {
	readonly encounterId: string;
	readonly planets: readonly { readonly planetId: string; readonly name: string }[];
	readonly captureEvents?: readonly CampaignCapture[];
}

export interface CampaignEncounterRuntime {
	readonly options: GameOptions;
	getCaptureEvents(): CampaignCapture[];
	getResult(world: Game): CampaignEncounterResult;
}

/** A blockaded planet remains viable: its production can still change the battle. */
export const campaignFactionIsViable = function (world: Game, factionId: Side): boolean {
	return planets(world).some(function (entity) { return entity.components.planet.owner === factionId; }) ||
		units(world).some(function (entity) {
			const unit = entity.components.unit;
			return unit.owner === factionId && unit.hp > 0 && unit.kind === 'transport' && unit.cargo > 0;
		});
};

export const evaluateCampaignWinner = function (world: Game): Side | null {
	const blue = campaignFactionIsViable(world, 'blue');
	const red = campaignFactionIsViable(world, 'red');
	if (!blue && !red) throw new Error('Campaign encounter has no viable faction');
	if (blue && red) return null;
	const winner = blue ? 'blue' : 'red';
	for (const entity of units(world)) {
		if (entity.components.unit.owner === winner) continue;
		entity.components.unit.hp = 0;
		world.commands.removeEntity(entity.id);
	}
	return winner;
};

/** Rebuild this adapter with saved capture events when restoring the tactical snapshot. */
export const createCampaignEncounterRuntime = function (input: CampaignEncounterRuntimeInput): CampaignEncounterRuntime {
	if (!input.encounterId.trim()) throw new Error('Encounter identity must not be empty');
	const planetIds = new Set<string>();
	const names = new Map<string, string>();
	for (const planet of input.planets) {
		if (!planet.planetId.trim() || !planet.name.trim() || planetIds.has(planet.planetId) || names.has(planet.name))
			throw new Error('Encounter planet identities and names must be nonempty and unique');
		planetIds.add(planet.planetId);
		names.set(planet.name, planet.planetId);
	}
	if (planetIds.size === 0) throw new Error('Encounter must identify its planets');
	const captureEvents: CampaignCapture[] = (input.captureEvents ?? []).map(function (event) {
		if (!planetIds.has(event.planetId)) throw new Error('Saved capture event identifies an unknown planet');
		return { ...event };
	});
	const options: GameOptions = {
		evaluateWinner: evaluateCampaignWinner,
		onCapture: function (event, world) {
			const planet = world.getComponent(event.planetId, 'planet');
			const planetId = planet && names.get(planet.name);
			if (!planetId) throw new Error('Captured tactical planet has no campaign identity');
			captureEvents.push({ planetId, factionId: event.owner });
		},
	};
	const getCaptureEvents = function (): CampaignCapture[] {
		return captureEvents.map(function (event) { return { ...event }; });
	};
	const getResult = function (world: Game): CampaignEncounterResult {
		if (!world.getResource('match').winner) throw new Error('Campaign encounter is not finished');
		const ownership = planets(world).map(function (entity) {
			const planetId = names.get(entity.components.planet.name);
			if (!planetId) throw new Error('Tactical planet has no campaign identity');
			const owner = entity.components.planet.owner;
			return { planetId, factionId: owner === 'neutral' ? null : owner };
		});
		if (ownership.length !== planetIds.size || new Set(ownership.map(function (planet) { return planet.planetId; })).size !== planetIds.size)
			throw new Error('Tactical planet identities do not match the campaign encounter');
		return { encounterId: input.encounterId, captureEvents: getCaptureEvents(), ownership };
	};
	return { options, getCaptureEvents, getResult };
};

export type CampaignEntryEdge = 'left' | 'right' | 'top' | 'bottom';

export const campaignEntryEdge = function (
	source: { readonly x: number; readonly y: number },
	destination: { readonly x: number; readonly y: number },
): CampaignEntryEdge {
	const dx = destination.x - source.x;
	const dy = destination.y - source.y;
	return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom');
};

export interface CampaignBattle {
	readonly world: Game;
	readonly map: StarMap;
	readonly runtime: CampaignEncounterRuntime;
	readonly entryEdge: CampaignEntryEdge;
}

export const createCampaignBattle = async function (
	state: CampaignState,
	setup: CampaignEncounterSetup,
	snapshot?: GameSnapshot,
	captureEvents?: readonly CampaignCapture[],
): Promise<CampaignBattle> {
	const encounter = state.encounter;
	if (!encounter || state.phase !== 'encounter') throw new Error('No campaign encounter is active');
	validateCampaignEncounterSetup(encounter, setup);
	const expedition = state.expeditions.find(function (item) { return item.id === encounter.expeditionId; });
	const source = state.systems.find(function (system) { return system.id === expedition?.sourceSystemId; });
	const destination = state.systems.find(function (system) { return system.id === encounter.systemId; });
	if (!source || !destination) throw new Error('Encounter travel systems are missing');
	const entryEdge = campaignEntryEdge(source, destination);
	const map: StarMap = { ...destination.map, planets: destination.map.planets.map(function (seed): PlanetSeed {
		const planet = encounter.planets.find(function (item) { return item.name === seed[0]; });
		const defender = setup.defenders.find(function (item) { return item.planetId === planet?.planetId; });
		if (!planet || !defender) throw new Error('Encounter planet geometry is missing');
		return [seed[0], seed[1], seed[2], seed[3], planet.factionId ?? 'neutral', defender.forces.troops, seed[6]];
	}) };
	const runtime = createCampaignEncounterRuntime({ encounterId: encounter.id, planets: encounter.planets, captureEvents });
	const options: GameOptions = { ...runtime.options, seed: function (world, battleMap) {
		// The campaign allocations replace skirmish's three free ships per owned planet.
		seedFreshGame(world, battleMap, function () { return undefined; });
		for (const planet of planets(world)) {
			const identity = encounter.planets.find(function (item) { return item.name === planet.components.planet.name; });
			const defender = setup.defenders.find(function (item) { return item.planetId === identity?.planetId; });
			if (!defender) throw new Error('Defense allocation is missing');
			planet.components.planet.guns = defender.forces.guns;
			const owner = planet.components.planet.owner;
			if (owner !== 'neutral')
				for (let index = 0; index < defender.forces.ships; index++) spawnShip(world, planet.id, owner);
		}
		for (const [beachheadIndex, beachhead] of setup.beachheads.entries()) {
			const identity = encounter.planets.find(function (item) { return item.planetId === beachhead.planetId; });
			const target = planets(world).find(function (item) { return item.components.planet.name === identity?.name; });
			if (!target) throw new Error('Beachhead target is missing');
			const transportCount = Math.ceil(beachhead.troops / CONFIG.dropshipCapacity);
			const count = beachhead.ships + transportCount;
			const verticalEdge = entryEdge === 'left' || entryEdge === 'right';
			const length = verticalEdge ? battleMap.height : battleMap.width;
			for (let index = 0; index < count; index++) {
				const position = length * (beachheadIndex + 1) / (setup.beachheads.length + 1) +
					(count === 1 ? 0 : (index / (count - 1) - 0.5) * Math.min(32, length / (setup.beachheads.length + 1)));
				const x = verticalEdge ? (entryEdge === 'left' ? -64 : battleMap.width + 64) : position;
				const y = verticalEdge ? position : (entryEdge === 'top' ? -64 : battleMap.height + 64);
				const ship = index < beachhead.ships;
				world.spawn({
					localTransform: { x, y, rotation: 0, scaleX: 1, scaleY: 1 }, circleCollider: { radius: 0 },
					unit: { owner: encounter.attacker, kind: ship ? 'ship' : 'transport', x, y,
						target: target.id, phase: 'travel', hp: ship ? CONFIG.shipHealth : CONFIG.transportHealth,
						cargo: ship ? 0 : Math.min(CONFIG.dropshipCapacity, beachhead.troops - (index - beachhead.ships) * CONFIG.dropshipCapacity), age: 0 },
				});
			}
		}
	} };
	const world = await createGame('skirmish', map, snapshot, options);
	return { world, map, runtime, entryEdge };
};
