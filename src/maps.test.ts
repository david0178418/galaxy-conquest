import { expect, test } from 'bun:test';
import { CONFIG } from './config';
import { createGame, dispatch, planets, shipsAt } from './game';
import {
	carrierSeeds,
	CARRIER_CREW,
	CARRIER_DOCKED_SHIPS,
	CARRIER_PLACEMENT_OFFSET,
	CARRIER_PRODUCTION_MULTIPLIER,
	CARRIER_RADIUS,
	generateMap,
	LAB_MAP,
	MAP_SIZES,
} from './maps';
import type { PlanetSeed } from './maps';

for (const size of ['small', 'medium', 'large'] as const) {
	test(`${size} scatters most worlds beyond the original grid jitter`, function () {
		const { width, height, columns, rows } = MAP_SIZES[size];
		const map = generateMap(size, 8041);
		const scattered = map.planets.filter(function ([, x, y]) {
			const cellWidth = width / columns;
			const cellHeight = height / rows;
			const columnCenter = (Math.floor(x / cellWidth) + 0.5) * cellWidth;
			const rowCenter = (Math.floor(y / cellHeight) + 0.5) * cellHeight;
			return Math.abs(x - columnCenter) > 40 || Math.abs(y - rowCenter) > 40;
		});
		expect(scattered.length).toBeGreaterThan(map.planets.length / 2);
	});
	test(`${size} maps have the requested count, spacing, bounds, and fair paired starts across seeds`, function () {
		for (let seed = 0; seed < 200; seed++) {
			const map = generateMap(size, seed);
			expect(map.planets).toHaveLength(MAP_SIZES[size].count);
			expect(
				new Set(
					map.planets.map(function ([name]) {
						return name;
					}),
				).size,
			).toBe(map.planets.length);
			for (const [index, planet] of map.planets.entries()) {
				const [, x, y, radius, owner, troops, rate] = planet;
				expect(x - radius).toBeGreaterThan(60);
				expect(y - radius).toBeGreaterThan(60);
				expect(x + radius).toBeLessThan(map.width - 60);
				expect(y + radius).toBeLessThan(map.height - 60);
				for (const other of map.planets.slice(index + 1)) {
					expect(Math.hypot(x - other[1], y - other[2])).toBeGreaterThanOrEqual(
						216,
					);
				}
				const mirror = map.planets.find(function (other) {
					return (
						Math.abs(other[1] - (map.width - x)) < 0.001 &&
						Math.abs(other[2] - (map.height - y)) < 0.001
					);
				});
				if (!mirror) throw new Error('Missing mirrored world');
				expect(mirror[3]).toBe(radius);
				expect(mirror[5]).toBe(troops);
				expect(mirror[6]).toBe(rate);
				expect(mirror[4]).toBe(
					owner === 'blue' ? 'red' : owner === 'red' ? 'blue' : 'neutral',
				);
			}
			for (const side of ['blue', 'red'] as const) {
				expect(
					map.planets.filter(function (planet) {
						return planet[4] === side;
					}),
				).toHaveLength(1);
			}
		}
	});
	test(`${size} launches the exact preview, supports commands, and restarts without mutating its map`, async function () {
		const preview = generateMap(size, 8041);
		const before = structuredClone(preview);
		const world = await createGame('skirmish', preview);
		try {
			expect(
				planets(world).map(function ({ components: { planet } }): PlanetSeed {
					return [
						planet.name,
						planet.x,
						planet.y,
						planet.radius,
						planet.owner,
						planet.troops,
						planet.rate,
					];
				}),
			).toEqual([...preview.planets]);
			const home = planets(world).find(function ({ components: { planet } }) {
				return planet.owner === 'blue';
			});
			const neutral = planets(world).find(function ({
				components: { planet },
			}) {
				return planet.owner === 'neutral';
			});
			if (!home || !neutral) throw new Error('Missing playable worlds');
			expect(shipsAt(world, home.id, 'blue')).toHaveLength(3);
			expect(
				dispatch(world, [home.id], neutral.id, 0.5, 'combined'),
			).toBeGreaterThan(0);
			world.update(CONFIG.step);
			expect(world.getResource('match').time).toBeCloseTo(CONFIG.step);
			expect(preview).toEqual(before);
		} finally {
			await world.dispose();
		}
		const restarted = await createGame('skirmish', preview);
		try {
			expect(
				planets(restarted).map(function ({ components: { planet } }) {
					return planet.troops;
				}),
			).toEqual(
				before.planets.map(function (planet) {
					return planet[5];
				}),
			);
			expect(restarted.getResource('match').time).toBe(0);
		} finally {
			await restarted.dispose();
		}
	});
}

test('seeds reproduce maps and rerolls vary the layout', function () {
	expect(generateMap('medium', 8041)).toEqual(generateMap('medium', 8041));
	expect(generateMap('medium', 8042).planets).not.toEqual(
		generateMap('medium', 8041).planets,
	);
});

test('carriers are opt-in and seed mirrored, clear starting placements without changing worlds', function () {
	for (const size of ['small', 'medium', 'large'] as const) {
		for (let seed = 0; seed < 200; seed++) {
			const generated = generateMap(size, seed);
			const map = { ...generated, carriers: true } as const;
			const before = structuredClone(map.planets);
			const seeds = carrierSeeds(map);
			expect(seeds).toHaveLength(2);
			expect(carrierSeeds(map)).toEqual(seeds);
			expect(map.planets).toEqual(before);
			expect(generated.planets).toHaveLength(MAP_SIZES[size].count);
			const blueHome = map.planets.find(function (planet) {
				return planet[4] === 'blue';
			});
			const redHome = map.planets.find(function (planet) {
				return planet[4] === 'red';
			});
			const blueCarrier = seeds.find(function (carrier) {
				return carrier[4] === 'blue';
			});
			const redCarrier = seeds.find(function (carrier) {
				return carrier[4] === 'red';
			});
			if (!blueHome || !redHome || !blueCarrier || !redCarrier)
				throw new Error('Missing a starting home or carrier');
			expect(blueCarrier[0]).toBe('Blue carrier');
			expect(redCarrier[0]).toBe('Red carrier');
			for (const carrier of seeds) {
				expect(carrier[3]).toBe(CARRIER_RADIUS);
				expect(carrier[5]).toBe(CARRIER_CREW);
				expect(carrier[6]).toBe(2.6 * CARRIER_PRODUCTION_MULTIPLIER);
				expect(carrier[1]).toBeGreaterThanOrEqual(CARRIER_RADIUS);
				expect(carrier[2]).toBeGreaterThanOrEqual(CARRIER_RADIUS);
				expect(carrier[1]).toBeLessThanOrEqual(map.width - CARRIER_RADIUS);
				expect(carrier[2]).toBeLessThanOrEqual(map.height - CARRIER_RADIUS);
				for (const planet of map.planets) {
					expect(
						Math.hypot(carrier[1] - planet[1], carrier[2] - planet[2]),
					).toBeGreaterThanOrEqual(
						CARRIER_RADIUS +
							32 +
							Math.max(27, planet[3] + 32),
					);
				}
			}
			expect(
				Math.hypot(blueCarrier[1] - blueHome[1], blueCarrier[2] - blueHome[2]),
			).toBeCloseTo(CARRIER_PLACEMENT_OFFSET);
			expect(
				Math.hypot(redCarrier[1] - redHome[1], redCarrier[2] - redHome[2]),
			).toBeCloseTo(CARRIER_PLACEMENT_OFFSET);
			expect(
				Math.hypot(blueCarrier[1] - redCarrier[1], blueCarrier[2] - redCarrier[2]),
			).toBeGreaterThanOrEqual(2 * CARRIER_RADIUS);
			expect(blueCarrier[1] - blueHome[1]).toBeCloseTo(
				redHome[1] - redCarrier[1],
			);
			expect(blueCarrier[2] - blueHome[2]).toBeCloseTo(
				redHome[2] - redCarrier[2],
			);
			expect(map.planets).toHaveLength(MAP_SIZES[size].count);
		}
	}
	expect(carrierSeeds(generateMap('medium', 8041))).toEqual([]);
	expect(carrierSeeds({ ...generateMap('medium', 8041), carriers: false })).toEqual(
		[],
	);
	expect(CARRIER_DOCKED_SHIPS).toBe(3);
});

test('LAB_MAP gets one carrier per faction with clear selection targets', function () {
	const map = { ...LAB_MAP, carriers: true } as const;
	const seeds = carrierSeeds(map);
	expect(seeds).toHaveLength(2);
	expect(
		seeds.map(function (carrier) {
			return carrier[4];
		}),
	).toEqual(['blue', 'red']);
	for (const carrier of seeds) {
		expect(carrier[5]).toBe(CARRIER_CREW);
		for (const planet of map.planets)
			expect(
				Math.hypot(carrier[1] - planet[1], carrier[2] - planet[2]),
			).toBeGreaterThanOrEqual(
				CARRIER_RADIUS + 32 + Math.max(27, planet[3] + 32),
			);
	}
});
