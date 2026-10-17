import { expect, test } from 'bun:test';
import { createDefaultEncounterSetup, ENCOUNTER_COSTS, validateCampaignEncounterSetup } from './campaign-setup';
import type { CampaignEncounter } from './campaign-state';

const encounter: CampaignEncounter = {
	id: 'battle', expeditionId: 'expedition', systemId: 'away', attacker: 'blue', attackerPoints: 100,
	planets: [
		{ planetId: 'a', name: 'A', factionId: 'red', points: 100.5 },
		{ planetId: 'b', name: 'B', factionId: 'blue', points: 25 },
		{ planetId: 'c', name: 'C', factionId: null, points: 10 },
	],
};

test('default setup allocates both local factions independently and keeps neutral forces on the ground', function () {
	const setup = createDefaultEncounterSetup(encounter);
	expect(setup.costs).toEqual({ troops: 1, ships: 6, guns: 5 });
	expect(setup.defenders).toEqual([
		{ planetId: 'a', forces: { troops: 50, ships: 5, guns: 4 } },
		{ planetId: 'b', forces: { troops: 14, ships: 1, guns: 1 } },
		{ planetId: 'c', forces: { troops: 10, ships: 0, guns: 0 } },
	]);
	expect(setup.beachheads).toEqual([{ planetId: 'a', troops: 52, ships: 8 }]);
	expect(function () { validateCampaignEncounterSetup(encounter, setup); }).not.toThrow();
});

test('custom costs persist in setup and defaults never overspend', function () {
	const costs = { troops: 2, ships: 7, guns: 3 };
	const setup = createDefaultEncounterSetup(encounter, costs);
	expect(setup.costs).toEqual(costs);
	expect(setup.costs).not.toBe(costs);
	expect(function () { validateCampaignEncounterSetup(encounter, setup); }).not.toThrow();
	expect(function () { createDefaultEncounterSetup(encounter, { ...costs, ships: 0 }); }).toThrow();
});

test('setup rejects missing duplicate unknown and overspent defenses and shared invasion overspending', function () {
	const setup = createDefaultEncounterSetup(encounter);
	for (const defenders of [[], [...setup.defenders, ...setup.defenders],
		[{ planetId: 'missing', forces: { troops: 0, ships: 0, guns: 0 } }],
		setup.defenders.map(function (item) { return { ...item, forces: { ...item.forces, troops: 101 } }; }),
		setup.defenders.map(function (item) { return item.planetId === 'c' ? { ...item, forces: { troops: 0, ships: 1, guns: 0 } } : item; }),
	]) {
		expect(function () { validateCampaignEncounterSetup(encounter, { ...setup, defenders }); }).toThrow();
	}
	expect(function () { validateCampaignEncounterSetup(encounter, { ...setup, costs: ENCOUNTER_COSTS, beachheads: [
		{ planetId: 'a', troops: 60, ships: 0 }, { planetId: 'b', troops: 60, ships: 0 },
	] }); }).toThrow();
});
