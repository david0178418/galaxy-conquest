import { expect, test } from 'bun:test';
import { createGame } from './game';
import type { Planet, Unit } from './game';
import { captureConquestSave } from './game-save';
import { carrierSeeds, LAB_MAP } from './maps';
import { parseConquestSave, SAVE_SCHEMA_VERSION } from './save-state';
import type { ConquestSave } from './save-state';

const fixture = async function (): Promise<ConquestSave> {
	const world = await createGame('skirmish', LAB_MAP);
	try {
		const save = captureConquestSave(world, LAB_MAP, 'skirmish', 1, 'carrier-test', 1);
		save.game.map = { ...LAB_MAP, carriers: true };
		// Keep this validator fixture independent of scenario inventory tuning.
		save.game.units = [];
		save.game.orderBook = { nextId: 1, active: [] };
		carrierSeeds(save.game.map).forEach(function (seed, index) {
			save.game.planets.push({
				id: 100000 + index,
				planet: {
					name: seed[0], x: seed[1], y: seed[2], radius: seed[3],
					owner: seed[4], troops: seed[5], rate: seed[6],
					guns: 0, production: 'ships', progress: 0.5,
					carrier: { destination: null, heading: 0 },
				},
			});
		});
		return save;
	} finally {
		await world.dispose();
	}
};
const carrierRow = function (save: ConquestSave): { id: number; planet: Planet } {
	const row = save.game.planets.find(function (entry) { return entry.planet.carrier !== undefined; });
	if (!row) throw new Error('Missing carrier');
	return row;
};
const dockShip = function (save: ConquestSave): Unit {
	const host = carrierRow(save);
	if (host.planet.owner === 'neutral') throw new Error('Neutral carrier');
	const unit: Unit = {
		owner: host.planet.owner, kind: 'ship', phase: 'docked', target: host.id,
		x: host.planet.x, y: host.planet.y, hp: 1, cargo: 0, age: 0,
	};
	save.game.units.push({ id: 200000, unit });
	return unit;
};

test('schema version 1 retains ordinary saves with omitted or disabled carriers', async function () {
	const world = await createGame('invasion');
	try {
		const save = captureConquestSave(world, LAB_MAP, 'invasion', 1, 'legacy', 1);
		expect(SAVE_SCHEMA_VERSION).toBe(1);
		expect(parseConquestSave(save)).toBe(save);
		save.game.map = { ...save.game.map, carriers: false };
		expect(parseConquestSave(save)).toBe(save);
	} finally {
		await world.dispose();
	}
});

test('moving captured carriers and synchronized docked inventory retain their current state', async function () {
	const save = await fixture();
	const host = carrierRow(save).planet;
	host.owner = 'red';
	host.x = 120;
	host.y = 240;
	host.troops = 100000;
	host.carrier = { destination: { x: save.game.map.width, y: 0 }, heading: -4.5 };
	dockShip(save);
	const before = structuredClone(save);
	expect(parseConquestSave(save)).toBe(save);
	expect(save).toEqual(before);
});

test('carrier validation rejects missing identities, forged geometry, armament and malformed motion', async function () {
	const saved = await fixture();
	const changes: ((save: ConquestSave) => void)[] = [
		function (save): void { save.game.map = { ...save.game.map, carriers: false }; },
		function (save): void { save.game.planets.pop(); },
		function (save): void { carrierRow(save).planet.name = 'Forged carrier'; },
		function (save): void { carrierRow(save).planet.radius++; },
		function (save): void { carrierRow(save).planet.rate++; },
		function (save): void { carrierRow(save).planet.owner = 'neutral'; },
		function (save): void { carrierRow(save).planet.guns = 0.5; },
		function (save): void { carrierRow(save).planet.production = 'guns'; },
		function (save): void { carrierRow(save).planet.x = save.game.map.width + 1; },
		function (save): void { carrierRow(save).planet.y = -1; },
		function (save): void { carrierRow(save).planet.carrier = { destination: null, heading: Infinity }; },
		function (save): void { carrierRow(save).planet.carrier = { destination: { x: NaN, y: 0 }, heading: 0 }; },
		function (save): void { carrierRow(save).planet.carrier = { destination: { x: 0, y: save.game.map.height + 1 }, heading: 0 }; },
		function (save): void { delete carrierRow(save).planet.carrier; },
		function (save): void {
			const ordinary = save.game.planets.find(function (entry) { return entry.planet.carrier === undefined; });
			if (!ordinary) throw new Error('Missing ordinary planet');
			ordinary.planet.carrier = { destination: null, heading: 0 };
		},
		function (save): void {
			const ordinary = save.game.planets.find(function (entry) { return entry.planet.carrier === undefined; });
			if (!ordinary) throw new Error('Missing ordinary planet');
			ordinary.planet.x++;
		},
	];
	for (const change of changes) {
		const save = structuredClone(saved);
		change(save);
		expect(function () { parseConquestSave(save); }).toThrow();
	}
	const malformed = structuredClone(saved);
	Object.assign(carrierRow(malformed).planet, { carrier: { destination: null } });
	expect(function () { parseConquestSave(malformed); }).toThrow();
	Object.assign(malformed.game.map, { carriers: 'true' });
	expect(function () { parseConquestSave(malformed); }).toThrow();
});

test('docked inventory requires ships at a current friendly carrier position', async function () {
	const saved = await fixture();
	dockShip(saved);
	const changes: ((unit: Unit, save: ConquestSave) => void)[] = [
		function (unit): void { unit.kind = 'transport'; },
		function (unit): void { unit.owner = unit.owner === 'blue' ? 'red' : 'blue'; },
		function (unit): void { unit.x++; },
		function (unit): void { unit.y++; },
		function (unit): void { unit.cargo = 1; },
		function (unit): void { unit.target = 999999; },
		function (unit, save): void {
			const ordinary = save.game.planets.find(function (entry) { return entry.planet.carrier === undefined; });
			if (!ordinary) throw new Error('Missing ordinary planet');
			unit.target = ordinary.id;
			unit.x = ordinary.planet.x;
			unit.y = ordinary.planet.y;
		},
	];
	for (const change of changes) {
		const save = structuredClone(saved);
		const row = save.game.units[0];
		if (!row) throw new Error('Missing ship');
		change(row.unit, save);
		expect(function () { parseConquestSave(save); }).toThrow();
	}
});

test('carrier capture invalidates pending old-owner sources but preserves launched and inbound orders', async function () {
	const save = await fixture();
	const host = carrierRow(save);
	const ship = dockShip(save);
	const ordinary = save.game.planets.find(function (entry) { return entry.planet.carrier === undefined; });
	if (!ordinary) throw new Error('Missing ordinary planet');
	save.game.orderBook = { nextId: 2, active: [{
		id: 1, owner: ship.owner, target: ordinary.id, state: 'pending',
		departures: [{ unitId: 200000, source: host.id, x: host.planet.x, y: host.planet.y, age: 0 }],
	}] };
	// A docked inventory item cannot also be reserved in a live departure.
	expect(function () { parseConquestSave(save); }).toThrow();
	ship.phase = 'travel';
	ship.target = ordinary.id;
	expect(parseConquestSave(save)).toBe(save);
	host.planet.owner = ship.owner === 'blue' ? 'red' : 'blue';
	expect(function () { parseConquestSave(save); }).toThrow();
	const order = save.game.orderBook.active[0];
	if (!order) throw new Error('Missing order');
	order.state = 'outbound';
	expect(parseConquestSave(save)).toBe(save);
	order.state = 'returning';
	ship.target = host.id;
	expect(parseConquestSave(save)).toBe(save);
	order.state = 'outbound';
	order.target = host.id;
	order.departures = [{ unitId: 200000, source: ordinary.id, x: ordinary.planet.x, y: ordinary.planet.y, age: 0 }];
	expect(parseConquestSave(save)).toBe(save);
});

test('actual carrier worlds save and restore moving hosts with docked inventory', async function () {
	const map = { ...LAB_MAP, carriers: true };
	const world = await createGame('skirmish', map);
	let restored: Awaited<ReturnType<typeof createGame>> | undefined;
	try {
		const save = captureConquestSave(world, map, 'skirmish', 1, 'roundtrip', 1);
		const host = carrierRow(save);
		host.planet.x += 10;
		host.planet.carrier = { destination: { x: map.width / 2, y: map.height / 2 }, heading: 1.25 };
		for (const row of save.game.units) {
			if (row.unit.target === host.id && row.unit.phase === 'docked') {
				row.unit.x = host.planet.x;
				row.unit.y = host.planet.y;
			}
		}
		const valid = parseConquestSave(save);
		restored = await createGame('skirmish', map, valid.game);
		const loaded = parseConquestSave(captureConquestSave(restored, map, 'skirmish', 1, 'roundtrip', 1));
		expect(loaded.game.planets.map(function (entry) { return entry.planet; }))
			.toEqual(valid.game.planets.map(function (entry) { return entry.planet; }));
		const inventory = function (saved: ConquestSave): unknown[] {
			const names = new Map(saved.game.planets.map(function (entry) {
				return [entry.id, entry.planet.name] as const;
			}));
			return saved.game.units.map(function (entry) {
				return { ...entry.unit, target: names.get(entry.unit.target) };
			});
		};
		expect(inventory(loaded)).toEqual(inventory(valid));
	} finally {
		await world.dispose();
		await restored?.dispose();
	}
});
