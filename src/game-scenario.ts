import type { Scenario } from './config';
import type { Game } from './game';
import { carrierSeeds, CARRIER_DOCKED_SHIPS, type StarMap } from './maps';

type ScenarioDependencies = Pick<
	typeof import('./game'),
	'notify' | 'planets' | 'spawnShip'
>;

export const seedFreshGame = function (
	world: Game,
	map: StarMap,
	spawnShip: ScenarioDependencies['spawnShip'],
): void {
	for (const [name, x, y, radius, owner, troops, rate] of [...map.planets, ...carrierSeeds(map)]) {
		const carrier = !map.planets.some(function (seed) { return seed[0] === name; });
		const planet = world.spawn({
			planet: {
				...(carrier ? { carrier: { destination: null, heading: 0 } } : {}),
				name,
				x,
				y,
				radius,
				owner,
				troops,
				rate,
				guns: 0,
				production: 'troops',
				progress: 0,
			},
		});
		if (owner !== 'neutral')
			for (let n = 0; n < (carrier ? CARRIER_DOCKED_SHIPS : 3); n++) spawnShip(world, planet.id, owner);
	}
};

export const initializeLabScenario = function (
	world: Game,
	scenario: Scenario,
	{ notify, planets, spawnShip }: ScenarioDependencies,
): void {
	if (scenario === 'skirmish') return;
	world.getResource('match').ai = false;
	const sol = planets(world).find(function (entity) {
		return entity.components.planet.name === 'Sol';
	});
	if (!sol) return;
	sol.components.planet.owner = 'red';
	sol.components.planet.troops = 18;
	sol.components.planet.production = 'troops';
	if (scenario === 'blockade') {
		for (let n = 0; n < 4; n++) spawnShip(world, sol.id, 'blue');
		notify(
			world,
			'Sol: your ships hold orbit; land troops to take the surface',
			'blue',
		);
		return;
	}
	sol.components.planet.guns = 2;
	spawnShip(world, sol.id, 'red');
	const terra = planets(world).find(function (entity) {
		return entity.components.planet.name === 'Terra';
	});
	if (terra)
		for (let n = 0; n < 5; n++) spawnShip(world, terra.id, 'blue');
	notify(
		world,
		'Sol is defended: compare troops alone with an escorted invasion',
		'neutral',
	);
};
