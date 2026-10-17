import * as z from 'zod/mini';
import type { Owner, Production, Scenario, Side } from './config';
import type {
	Departure,
	Match,
	Notice,
	Order,
	OrderBook,
	Planet,
	Unit,
} from './game';
import type { StarMap, PlanetSeed } from './maps';

export const SAVE_SCHEMA_VERSION = 1;
const MAX_SAVED_STOCK = 100_000;
const MAX_SAVED_CARGO = 100_000;
const MAX_SAVED_PRODUCTION_RATE = 10_000;
const MAX_SAVED_PRODUCTION_PROGRESS = 10_000;
const MAX_SAVED_COORDINATE = 20_000;
const MAX_SAVED_PLANET_RADIUS = 1_000;

export interface GameSnapshot {
	map: StarMap;
	scenario: Scenario;
	pace: 0.5 | 1 | 2;
	match: Omit<Match, 'engagements'>;
	planets: { id: number; planet: Planet }[];
	units: { id: number; unit: Unit }[];
	orderBook: OrderBook;
}

export interface ConquestSave {
	schemaVersion: number;
	profileId: string;
	savedAt: number;
	game: GameSnapshot;
}

const isRecord = function (value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
};
// Validate array elements with the original every() semantics: skip holes, but
// reject explicit undefined. Keep the input so array/tuple extension fields survive.
const savedArray = function <T extends z.ZodMiniType>(element: T): z.ZodMiniCustom<z.output<T>[]> {
	return z.custom<z.output<T>[]>(function (value) {
		return Array.isArray(value) && value.every(function (item: unknown) {
			return element.safeParse(item).success;
		});
	});
};
// Schema validation proves the output type without replacing the accepted input.
// This preserves all extension properties, including own enumerable __proto__.
const unchanged = function <T extends z.ZodMiniType>(schema: T): z.ZodMiniCustom<z.output<T>> {
	return z.custom<z.output<T>>(function (value) {
		return schema.safeParse(value).success;
	});
};
// Loose objects accept additional save fields.
// Schemas are checked against simulation types rather than defining a second model.
const nonnegativeNumber = z.number().check(z.gte(0));
const safeInteger = nonnegativeNumber.check(z.refine(Number.isSafeInteger));
const idSchema = safeInteger.check(z.gt(0));
const stockSchema = safeInteger.check(z.lte(MAX_SAVED_STOCK));
const coordinateSchema = z.number().check(z.gte(-MAX_SAVED_COORDINATE), z.lte(MAX_SAVED_COORDINATE));
const radiusSchema = z.number().check(z.gt(0), z.lte(MAX_SAVED_PLANET_RADIUS));
const rateSchema = nonnegativeNumber.check(z.lte(MAX_SAVED_PRODUCTION_RATE));
const sideSchema = z.enum(['blue', 'red']) satisfies z.ZodMiniType<Side>;
const ownerSchema = z.enum(['blue', 'red', 'neutral']) satisfies z.ZodMiniType<Owner>;
const productionSchema = z.enum(['troops', 'ships', 'guns']) satisfies z.ZodMiniType<Production>;
const scenarioSchema = z.enum(['skirmish', 'blockade', 'invasion']) satisfies z.ZodMiniType<Scenario>;
const planetSeedSchema = z.tuple([
	z.string(), nonnegativeNumber, nonnegativeNumber, radiusSchema,
	ownerSchema, stockSchema, rateSchema,
]) satisfies z.ZodMiniType<PlanetSeed>;
const mapSchema = z.looseObject({
	width: z.number().check(z.gt(0), z.lte(10000)),
	height: z.number().check(z.gt(0), z.lte(10000)),
	planets: savedArray(planetSeedSchema).check(z.minLength(2), z.maxLength(100)),
}).check(z.refine(function (map) {
	return map.planets.every(function (seed) {
		return seed[1] <= map.width && seed[2] <= map.height;
	});
})) satisfies z.ZodMiniType<StarMap>;
const planetSchema = z.looseObject({
	name: z.string(),
	x: nonnegativeNumber,
	y: nonnegativeNumber,
	radius: radiusSchema,
	owner: ownerSchema,
	troops: stockSchema,
	guns: nonnegativeNumber.check(z.lte(MAX_SAVED_STOCK)),
	rate: rateSchema,
	production: productionSchema,
	progress: nonnegativeNumber.check(z.lt(MAX_SAVED_PRODUCTION_PROGRESS)),
}) satisfies z.ZodMiniType<Planet>;
const unitSchema = z.looseObject({
	owner: sideSchema,
	kind: z.enum(['ship', 'transport']),
	x: coordinateSchema,
	y: coordinateSchema,
	target: idSchema,
	phase: z.enum(['travel', 'orbit']),
	hp: z.number().check(z.gt(0), z.lte(10000)),
	cargo: safeInteger.check(z.lte(MAX_SAVED_CARGO)),
	age: nonnegativeNumber,
}).check(z.refine(function (unit) {
	return unit.kind === 'transport' || unit.cargo === 0;
})) satisfies z.ZodMiniType<Unit>;
const noticeSchema = z.looseObject({
	text: z.string(), time: nonnegativeNumber, side: ownerSchema,
}) satisfies z.ZodMiniType<Notice>;
const matchSchema = z.looseObject({
	time: nonnegativeNumber,
	paused: z.boolean(),
	winner: z.nullable(sideSchema),
	ai: z.boolean(),
	aiClock: nonnegativeNumber,
	orders: safeInteger,
	captures: safeInteger,
	transportsLost: safeInteger,
	troopsLost: safeInteger,
	firstCapture: z.nullable(nonnegativeNumber),
	notices: savedArray(noticeSchema).check(z.maxLength(100)),
}).check(z.refine(function (match) {
	return match.firstCapture === null || match.firstCapture <= match.time;
})) satisfies z.ZodMiniType<Omit<Match, 'engagements'>>;
const departureSchema = z.looseObject({
	unitId: idSchema,
	source: idSchema,
	x: coordinateSchema,
	y: coordinateSchema,
	age: nonnegativeNumber,
}) satisfies z.ZodMiniType<Departure>;
const orderSchema = z.looseObject({
	id: idSchema,
	owner: sideSchema,
	target: idSchema,
	state: z.enum(['pending', 'outbound', 'returning']),
	departures: savedArray(departureSchema).check(z.maxLength(10000)),
}) satisfies z.ZodMiniType<Order>;
const orderBookSchema = z.looseObject({
	nextId: idSchema,
	active: savedArray(orderSchema).check(z.maxLength(10000)),
}) satisfies z.ZodMiniType<OrderBook>;

const sameSeedGeometry = function (planet: Planet, seed: PlanetSeed): boolean {
	return (
		planet.name === seed[0] &&
		planet.x === seed[1] &&
		planet.y === seed[2] &&
		planet.radius === seed[3] &&
		planet.rate === seed[6]
	);
};
const hasUniqueIds = function (
	items: readonly { id: number }[],
	seen: Set<number>,
): boolean {
	for (const item of items) {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
	}
	return true;
};
const hasSnapshotIntegrity = function (value: GameSnapshot): boolean {
	if (value.planets.length !== value.map.planets.length) return false;
	// filter() skips holes, as the original parser's narrowing pass did.
	const planetRows = value.planets.filter(function () { return true; });
	const unitRows = value.units.filter(function () { return true; });
	const allIds = new Set<number>();
	if (!hasUniqueIds(planetRows, allIds) || !hasUniqueIds(unitRows, allIds)) return false;
	const planetsByName = new Map(
		planetRows.map(function (entry) {
			return [entry.planet.name, entry.planet] as const;
		}),
	);
	if (
		planetsByName.size !== planetRows.length ||
		!value.map.planets.every(function (seed) {
			const current = planetsByName.get(seed[0]);
			return current !== undefined && sameSeedGeometry(current, seed);
		})
	)
		return false;
	const planetIds = new Set(planetRows.map(function (entry) {
		return entry.id;
	}));
	const orderBook = value.orderBook;
	const nextOrderId = orderBook.nextId;
	const activeOrders = orderBook.active;
	const unitsById = new Map(unitRows.map(function (entry) {
		return [entry.id, entry.unit] as const;
	}));
	if (
		unitRows.some(function (entry) {
			return !planetIds.has(entry.unit.target);
		})
	)
		return false;
	const orderIds = new Set<number>();
	const assignedUnits = new Set<number>();
	if (
		activeOrders.some(function (order) {
			if (
				orderIds.has(order.id) ||
				order.id >= nextOrderId ||
				!planetIds.has(order.target)
			)
				return true;
			orderIds.add(order.id);
			return order.departures.some(function (departure) {
				if (
					!planetIds.has(departure.source) ||
					assignedUnits.has(departure.unitId)
				)
					return true;
				assignedUnits.add(departure.unitId);
				const unit = unitsById.get(departure.unitId);
				if (!unit) return true;
				const expectedTarget =
					order.state === 'returning' ? departure.source : order.target;
				return unit.owner !== order.owner || unit.target !== expectedTarget;
			});
		})
	)
		return false;
	return true;
};

export class InvalidSaveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSaveError';
	}
}

export const gameSnapshotSchema = z.looseObject({
	map: mapSchema,
	scenario: scenarioSchema,
	pace: z.union([z.literal(0.5), z.literal(1), z.literal(2)]),
	match: matchSchema,
	planets: savedArray(z.looseObject({ id: idSchema, planet: planetSchema })),
	units: savedArray(z.looseObject({ id: idSchema, unit: unitSchema })).check(z.maxLength(10000)),
	orderBook: orderBookSchema,
}).check(z.refine(hasSnapshotIntegrity)) satisfies z.ZodMiniType<GameSnapshot>;
const conquestSaveSchema = z.looseObject({
	schemaVersion: z.literal(SAVE_SCHEMA_VERSION),
	profileId: z.string().check(z.minLength(1)),
	savedAt: z.number().check(z.gt(0)),
	game: gameSnapshotSchema,
}) satisfies z.ZodMiniType<ConquestSave>;

const validatedSaveSchema = unchanged(conquestSaveSchema);

const migrateSave = function (value: unknown): unknown {
	if (!isRecord(value) || typeof value.schemaVersion !== 'number')
		throw new InvalidSaveError('This saved conquest is missing its format version.');
	const current: unknown = value;
	const version = value.schemaVersion;
	if (!Number.isSafeInteger(version) || version < 1)
		throw new InvalidSaveError('This saved conquest has an invalid format version.');
	while (version < SAVE_SCHEMA_VERSION) {
		switch (version) {
			// Add explicit version-to-version conversions here when the save format changes.
			default:
				throw new InvalidSaveError('This saved conquest version cannot be migrated.');
		}
	}
	if (version > SAVE_SCHEMA_VERSION)
		throw new InvalidSaveError(
			'This saved conquest was created by a newer game version. Keep its profile and open it with that version.',
		);
	return current;
};

export const parseConquestSave = function (
	input: unknown,
	expectedProfileId?: string,
): ConquestSave {
	const value = migrateSave(input);
	const result = validatedSaveSchema.safeParse(value);
	if (!result.success ||
		(expectedProfileId !== undefined && result.data.profileId !== expectedProfileId))
		throw new InvalidSaveError(
			'Could not validate this saved conquest. Its profile data was kept unchanged.',
		);
	return result.data;
};

export const isSupportedConquestSave = function (
	input: unknown,
	expectedProfileId?: string,
): boolean {
	try {
		parseConquestSave(input, expectedProfileId);
		return true;
	} catch {
		return false;
	}
};
