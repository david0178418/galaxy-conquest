import { MAP } from './config';
import type { Owner } from './config';

export type PlanetSeed = readonly [
	name: string,
	x: number,
	y: number,
	radius: number,
	owner: Owner,
	troops: number,
	rate: number,
];
export interface StarMap {
	readonly width: number;
	readonly height: number;
	readonly planets: readonly PlanetSeed[];
	readonly carriers?: boolean;
}

export const CARRIER_CREW = 20;
export const CARRIER_DOCKED_SHIPS = 3;
export const CARRIER_PRODUCTION_MULTIPLIER = 0.25;
export const CARRIER_RADIUS = 24;
export const CARRIER_PLACEMENT_OFFSET = 140;
const CARRIER_HIT_RADIUS = CARRIER_RADIUS + 32;

const CARRIER_PLACEMENT_DIRECTIONS = Array.from(
	{ length: 72 },
	function (_, index) {
		const angle = (index * Math.PI * 2) / 72;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	},
);

export const carrierSeeds = function (map: StarMap): readonly PlanetSeed[] {
	if (map.carriers !== true) return [];
	const blueHome = map.planets.find(function (planet) {
		return planet[4] === 'blue';
	});
	const redHome = map.planets.find(function (planet) {
		return planet[4] === 'red';
	});
	if (!blueHome || !redHome) return [];
	const isClear = function (x: number, y: number): boolean {
		return (
			x >= CARRIER_RADIUS &&
			y >= CARRIER_RADIUS &&
			x <= map.width - CARRIER_RADIUS &&
			y <= map.height - CARRIER_RADIUS &&
			map.planets.every(function (planet) {
				const hitRadius = Math.max(27, planet[3] + 32);
				return (
					Math.hypot(x - planet[1], y - planet[2]) >=
					CARRIER_HIT_RADIUS + hitRadius
				);
			})
		);
	};
	const placement = CARRIER_PLACEMENT_DIRECTIONS.find(function (direction) {
		const blueX = blueHome[1] + direction.x * CARRIER_PLACEMENT_OFFSET;
		const blueY = blueHome[2] + direction.y * CARRIER_PLACEMENT_OFFSET;
		const redX = redHome[1] - direction.x * CARRIER_PLACEMENT_OFFSET;
		const redY = redHome[2] - direction.y * CARRIER_PLACEMENT_OFFSET;
		return (
			Math.hypot(blueX - redX, blueY - redY) >= 2 * CARRIER_RADIUS &&
			isClear(blueX, blueY) &&
			isClear(redX, redY)
		);
	});
	if (!placement) return [];
	return [
		[
			'Blue carrier',
			blueHome[1] + placement.x * CARRIER_PLACEMENT_OFFSET,
			blueHome[2] + placement.y * CARRIER_PLACEMENT_OFFSET,
			CARRIER_RADIUS,
			'blue',
			CARRIER_CREW,
			2.6 * CARRIER_PRODUCTION_MULTIPLIER,
		],
		[
			'Red carrier',
			redHome[1] - placement.x * CARRIER_PLACEMENT_OFFSET,
			redHome[2] - placement.y * CARRIER_PLACEMENT_OFFSET,
			CARRIER_RADIUS,
			'red',
			CARRIER_CREW,
			2.6 * CARRIER_PRODUCTION_MULTIPLIER,
		],
	];
};

export const LAB_MAP: StarMap = {
	...MAP,
	planets: [
		['Polaris', 234, 180, 25, 'neutral', 8, 1.7],
		['Vega', 521, 198, 31, 'red', 44, 2.6],
		['Altair', 942, 165, 25, 'neutral', 8, 1.7],
		['Rhea', 277, 414, 25, 'neutral', 8, 1.7],
		['Deneb', 668, 418, 28, 'neutral', 14, 2.2],
		['Io', 930, 389, 25, 'neutral', 8, 1.7],
		['Nyx', 98, 600, 28, 'neutral', 14, 2.2],
		['Sol', 514, 570, 36, 'neutral', 24, 3.4],
		['Eris', 1077, 617, 28, 'neutral', 14, 2.2],
		['Tethys', 214, 801, 28, 'neutral', 14, 2.2],
		['Atlas', 535, 831, 36, 'neutral', 24, 3.4],
		['Dione', 1084, 841, 28, 'neutral', 14, 2.2],
		['Luna', 337, 991, 25, 'neutral', 8, 1.7],
		['Astra', 638, 1032, 28, 'neutral', 14, 2.2],
		['Ceres', 866, 1024, 25, 'neutral', 8, 1.7],
		['Mira', 244, 1192, 25, 'neutral', 8, 1.7],
		['Terra', 532, 1229, 31, 'blue', 44, 2.6],
		['Lyra', 1069, 1186, 25, 'neutral', 8, 1.7],
	],
};

export const MAP_SIZES = {
	small: {
		label: 'Small',
		count: 12,
		width: 1040,
		height: 1080,
		columns: 4,
		rows: 3,
		detail: 'Close borders. Early encounters.',
	},
	medium: {
		label: 'Medium',
		count: 18,
		width: 1200,
		height: 1320,
		columns: 4,
		rows: 5,
		detail: 'Room to expand. Space to maneuver.',
	},
	large: {
		label: 'Large',
		count: 30,
		width: 1560,
		height: 1716,
		columns: 5,
		rows: 6,
		detail: 'A wider frontier. More worlds to contest.',
	},
} as const;
export type MapSize = keyof typeof MAP_SIZES;

export const isMapSize = function (value: unknown): value is MapSize {
	return value === 'small' || value === 'medium' || value === 'large';
};

const NEUTRAL_NAMES = [
	'Polaris',
	'Altair',
	'Rhea',
	'Deneb',
	'Io',
	'Nyx',
	'Sol',
	'Eris',
	'Tethys',
	'Atlas',
	'Dione',
	'Luna',
	'Astra',
	'Ceres',
	'Mira',
	'Lyra',
	'Rigel',
	'Sirius',
	'Titan',
	'Orion',
	'Helios',
	'Oberon',
	'Elara',
	'Callisto',
	'Nereid',
	'Triton',
	'Phoebe',
	'Hyperion',
] as const;

// Start with spaced pairs, then scatter them while preserving clearance and symmetry.
// A seed reproduces the exact preview; starting a game never rolls another map.
export const generateMap = function (size: MapSize, seed: number): StarMap {
	const { width, height, columns, rows, count } = MAP_SIZES[size];
	let state = seed >>> 0;
	const random = function (): number {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 4294967296;
	};
	const cells = Array.from(
		{ length: (columns * rows) / 2 },
		function (_, index) {
			return {
				x:
					(((index % columns) + 0.5) * width) / columns + (random() - 0.5) * 40,
				y:
					((Math.floor(index / columns) + 0.5) * height) / rows +
					(random() - 0.5) * 40,
				rank: random(),
			};
		},
	)
		.sort(function (a, b) {
			return a.rank - b.rank;
		})
		.slice(0, count / 2);
	// Repeated local moves break up rows and columns without risking a failed fill.
	// Check both halves of each pair, including the pair's own mirrored position.
	for (let pass = 0; pass < 24; pass++) {
		for (const point of cells) {
			const x = point.x + ((random() - 0.5) * width) / columns;
			const y = point.y + ((random() - 0.5) * height) / rows;
			if (x < 100 || x > width - 100 || y < 100 || y > height - 100)
				continue;
			if (Math.hypot(width - 2 * x, height - 2 * y) < 216) continue;
			const clear = cells.every(function (other) {
				return (
					other === point ||
					(Math.hypot(x - other.x, y - other.y) >= 216 &&
						Math.hypot(x - (width - other.x), y - (height - other.y)) >= 216)
				);
			});
			if (clear) {
				point.x = x;
				point.y = y;
			}
		}
	}
	cells.sort(function (a, b) {
		return (
			Math.hypot(b.x - width / 2, b.y - height / 2) -
			Math.hypot(a.x - width / 2, a.y - height / 2)
		);
	});
	const layout = cells.flatMap(function (point, index): PlanetSeed[] {
		const tier = random();
		const radius = tier < 0.55 ? 25 : tier < 0.9 ? 28 : 36;
		const troops = tier < 0.55 ? 8 : tier < 0.9 ? 14 : 24;
		const rate = tier < 0.55 ? 1.7 : tier < 0.9 ? 2.2 : 3.4;
		if (index === 0)
			return [
				['Terra', point.x, point.y, 31, 'blue', 44, 2.6],
				['Vega', width - point.x, height - point.y, 31, 'red', 44, 2.6],
			];
		const first = NEUTRAL_NAMES[(index - 1) * 2];
		const second = NEUTRAL_NAMES[(index - 1) * 2 + 1];
		if (!first || !second) throw new Error('Map exceeds available world names');
		return [
			[first, point.x, point.y, radius, 'neutral', troops, rate],
			[
				second,
				width - point.x,
				height - point.y,
				radius,
				'neutral',
				troops,
				rate,
			],
		];
	});
	return { width, height, planets: layout };
};
