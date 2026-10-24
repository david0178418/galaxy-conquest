import { expect, test } from 'bun:test';
import { CONFIG } from './config';
import { availableShips, cancelOrder, createGame, dispatch, dockedShips, isBlockaded, launchCarrierShips, moveCarrier, planets, setProduction, shipsAt, spawnShip, units, type Game } from './game';
import { LAB_MAP, type StarMap } from './maps';
import { CARRIER_SPEED } from './movement';
import { captureConquestSave } from './game-save';
import { parseConquestSave } from './save-state';

const map: StarMap = { ...LAB_MAP, carriers: true };
type Host = ReturnType<typeof planets>[number];
const setup = async function (): Promise<{ world: Game; blue: Host; red: Host }> {
	const world = await createGame('skirmish', map);
	world.getResource('match').ai = false;
	for (const e of planets(world)) e.components.planet.rate = 0;
	const blue = planets(world).find(function (e) { return e.components.planet.carrier && e.components.planet.owner === 'blue'; });
	const red = planets(world).find(function (e) { return e.components.planet.carrier && e.components.planet.owner === 'red'; });
	if (!blue || !red) throw new Error('Missing carriers');
	return { world, blue, red };
};
const advance = function (world: Game, seconds: number): void {
	for (let i = 0; i < Math.round(seconds / CONFIG.step); i++) world.update(CONFIG.step);
};

test('carriers are opt-in, carry hidden inventory, move slowly, stop and obey pause', async function () {
	const normal = await createGame();
	try { expect(planets(normal).some(function (e) { return Boolean(e.components.planet.carrier); })).toBe(false); }
	finally { await normal.dispose(); }
	const { world, blue } = await setup();
	try {
		const p = blue.components.planet;
		const x = p.x, y = p.y;
		expect(dockedShips(world, blue.id, 'blue')).toHaveLength(3);
		expect(shipsAt(world, blue.id, 'blue')).toHaveLength(0);
		expect(CARRIER_SPEED).toBeLessThan(CONFIG.travelSpeed * 0.5);
		moveCarrier(world, blue.id, { x: x + 60, y });
		world.getResource('match').paused = true;
		advance(world, 2);
		expect(p.x).toBe(x);
		world.getResource('match').paused = false;
		advance(world, 2);
		expect(p.x).toBeCloseTo(x + CARRIER_SPEED * 2, 6);
		for (const e of dockedShips(world, blue.id)) expect(e.components.unit.x).toBe(p.x);
		advance(world, 12);
		expect(p.x).toBe(x + 60);
		expect(p.carrier?.destination).toBeNull();
		expect(moveCarrier(world, blue.id, { x: NaN, y })).toBe(false);
	} finally { await world.dispose(); }
});

test('carrier production is slow and platforms are unavailable through commands', async function () {
	const { world, blue } = await setup();
	try {
		blue.components.planet.rate = 2.6 * 0.25;
		const crew = blue.components.planet.troops;
		advance(world, 13);
		expect(blue.components.planet.troops).toBe(crew + 1);
		setProduction(world, [blue.id], 'guns');
		expect(blue.components.planet.production).toBe('troops');
		setProduction(world, [blue.id], 'ships');
		advance(world, 74);
		expect(dockedShips(world, blue.id)).toHaveLength(4);
		expect(shipsAt(world, blue.id, 'blue')).toHaveLength(0);
		expect(blue.components.planet.guns).toBe(0);
	} finally { await world.dispose(); }
});

test('moving carrier blockade denies docking and boarding; local launch clears it and relief docks', async function () {
	const { world, blue } = await setup();
	try {
		const p = blue.components.planet;
		const enemy = spawnShip(world, blue.id, 'red');
		if (!enemy) throw new Error('Missing enemy');
		expect(isBlockaded(world, blue.id)).toBe(true);
		const relief = spawnShip(world, blue.id, 'blue');
		if (!relief) throw new Error('Missing relief');
		// Outside relief must fight before docking, not enter the hangar on arrival.
		relief.components.unit.phase = 'orbit';
		moveCarrier(world, blue.id, { x: p.x + 100, y: p.y });
		const oldX = p.x;
		advance(world, 0.1);
		expect(p.x).toBeGreaterThan(oldX);
		expect(relief.components.unit.phase).toBe('orbit');
		expect(enemy.components.unit.x).toBe(p.x);
		const storedHealth = dockedShips(world, blue.id).map(function (e) { return e.components.unit.hp; });
		expect(storedHealth).toEqual([CONFIG.shipHealth, CONFIG.shipHealth, CONFIG.shipHealth]);
		expect(launchCarrierShips(world, blue.id)).toBe(3);
		advance(world, 4);
		expect(shipsAt(world, blue.id, 'red')).toHaveLength(0);
		expect(dockedShips(world, blue.id).length).toBeGreaterThan(0);
		expect(isBlockaded(world, blue.id)).toBe(false);
	} finally { await world.dispose(); }
});

test('carrier launch exception preserves ordinary planetary blockade departure restriction', async function () {
	const { world, blue, red } = await setup();
	try {
		spawnShip(world, blue.id, 'red');
		expect(dispatch(world, [blue.id], red.id, 1, 'ships')).toBe(3);
		const home = planets(world).find(function (e) { return !e.components.planet.carrier && e.components.planet.owner === 'blue'; });
		if (!home) throw new Error('Missing home');
		for (const e of shipsAt(world, home.id, 'blue')) world.removeEntity(e.id);
		spawnShip(world, home.id, 'red');
		expect(dispatch(world, [home.id], red.id, 1)).toBe(0);
	} finally { await world.dispose(); }
});

test('transport intercepts moving, turning and stopping carrier and unloads once', async function () {
	const { world, blue } = await setup();
	try {
		const home = planets(world).find(function (e) { return e.components.planet.name === 'Terra'; });
		if (!home) throw new Error('Missing home');
		const p = blue.components.planet;
		p.x = home.components.planet.x + 160; p.y = home.components.planet.y;
		moveCarrier(world, blue.id, { x: p.x + 300, y: p.y - 200 });
		const crew = p.troops;
		const cargo = home.components.planet.troops;
		expect(dispatch(world, [home.id], blue.id, 1, 'troops')).toBeGreaterThan(0);
		advance(world, 1);
		const traveler = units(world).find(function (e) { return e.components.unit.kind === 'transport'; });
		if (!traveler) throw new Error('Missing transport');
		expect(traveler.components.unit.y).toBeLessThan(home.components.planet.y);
		moveCarrier(world, blue.id, { x: p.x + 100, y: p.y - 100 });
		advance(world, 50);
		expect(p.troops).toBe(crew + cargo);
		expect(units(world).filter(function (e) { return e.components.unit.kind === 'transport'; })).toHaveLength(0);
		advance(world, 2);
		expect(p.troops).toBe(crew + cargo);
	} finally { await world.dispose(); }
});

for (const cargo of [4, 5, 6]) test(`boarding threshold ${cargo} and docked fleet ownership`, async function () {
	const { world, blue, red } = await setup();
	try {
		const p = blue.components.planet;
		p.troops = 5;
		const stored = dockedShips(world, blue.id).map(function (e) { return e.id; });
		// A previously launched ship is independent of capture.
		dispatch(world, [blue.id], red.id, 1 / 3, 'ships');
		const launched = units(world).find(function (e) { return stored.includes(e.id) && e.components.unit.phase === 'travel'; });
		moveCarrier(world, blue.id, { x: p.x + 100, y: p.y });
		world.spawn({ unit: { owner: 'red', kind: 'transport', x: p.x, y: p.y, target: blue.id, phase: 'orbit', hp: 2, cargo, age: 1 } });
		advance(world, 0.05);
		expect(p.owner).toBe(cargo > 5 ? 'red' : 'blue');
		expect(p.troops).toBe(Math.abs(cargo - 5));
		if (cargo > 5) {
			expect(p.carrier?.destination).toBeNull();
			expect(dockedShips(world, blue.id, 'red')).toHaveLength(2);
			expect(moveCarrier(world, blue.id, { x: 0, y: 0 })).toBe(false);
		}
		expect(launched?.components.unit.owner).toBe('blue');
		expect(launched?.components.unit.target).toBe(red.id);
	} finally { await world.dispose(); }
});

test('boarding and friendly unloading wait while hostile external ships resist', async function () {
	const { world, blue } = await setup();
	try {
		const p = blue.components.planet;
		const crew = p.troops;
		const blocker = spawnShip(world, blue.id, 'red');
		world.spawn({ unit: { owner: 'blue', kind: 'transport', x: p.x, y: p.y, target: blue.id, phase: 'orbit', hp: 2, cargo: 10, age: 0 } });
		advance(world, 0.05);
		expect(p.troops).toBe(crew);
		if (blocker) world.removeEntity(blocker.id);
		advance(world, 0.05);
		expect(p.troops).toBe(crew + 10);
	} finally { await world.dispose(); }
});

test('recall follows current carrier and paused cancellation refunds once at current host', async function () {
	const { world, blue, red } = await setup();
	try {
		world.getResource('match').paused = true;
		const crew = blue.components.planet.troops;
		dispatch(world, [blue.id], red.id, 1);
		const pending = world.getResource('orderBook').active[0];
		if (!pending) throw new Error('Missing pending order');
		expect(cancelOrder(world, pending.id)).toBe(true);
		expect(cancelOrder(world, pending.id)).toBe(false);
		expect(blue.components.planet.troops).toBe(crew);
		expect(dockedShips(world, blue.id)).toHaveLength(3);
		world.getResource('match').paused = false;
		dispatch(world, [blue.id], red.id, 1, 'ships');
		advance(world, 1);
		const order = world.getResource('orderBook').active[0];
		if (!order) throw new Error('Missing order');
		moveCarrier(world, blue.id, { x: blue.components.planet.x + 120, y: blue.components.planet.y });
		expect(cancelOrder(world, order.id)).toBe(true);
		advance(world, 35);
		expect(dockedShips(world, blue.id)).toHaveLength(3);
		expect(availableShips(world, blue.id, 'blue')).toHaveLength(3);
	} finally { await world.dispose(); }
});

test('carrier-only holding survives but launched ships alone do not', async function () {
	const { world, blue } = await setup();
	try {
		for (const e of planets(world)) if (!e.components.planet.carrier && e.components.planet.owner === 'blue') e.components.planet.owner = 'red';
		advance(world, 0.05);
		expect(world.getResource('match').winner).toBeNull();
		blue.components.planet.owner = 'red';
		advance(world, 0.05);
		expect(world.getResource('match').winner).toBe('red');
	} finally { await world.dispose(); }
});

test('moving carrier, docked identities, blockade and orders survive validated save/load', async function () {
	const world = await createGame('skirmish', map);
	let restored: Game | undefined;
	try {
		world.getResource('match').ai = false;
		const blue = planets(world).find(function (e) { return e.components.planet.carrier && e.components.planet.owner === 'blue'; });
		const red = planets(world).find(function (e) { return e.components.planet.carrier && e.components.planet.owner === 'red'; });
		if (!blue || !red) throw new Error('Missing carriers');
		spawnShip(world, blue.id, 'red');
		moveCarrier(world, blue.id, { x: blue.components.planet.x + 100, y: blue.components.planet.y });
		dispatch(world, [blue.id], red.id, 0.5, 'troops');
		advance(world, 2);
		const save = parseConquestSave(captureConquestSave(world, map, 'skirmish', 2, 'test'));
		restored = await createGame('skirmish', map, save.game);
		const carried = planets(restored).find(function (e) { return e.components.planet.name === blue.components.planet.name; });
		if (!carried) throw new Error('Missing restored carrier');
		expect(carried.components.planet).toEqual(blue.components.planet);
		expect(dockedShips(restored, carried.id)).toHaveLength(3);
		expect(isBlockaded(restored, carried.id)).toBe(true);
		expect(restored.getResource('orderBook').active).toHaveLength(1);
		expect(restored.getResource('match').paused).toBe(true);
	} finally { await restored?.dispose(); await world.dispose(); }
});

test('docked escorts remain recallable while their transports are underway, including after save/load', async function () {
	const world = await createGame('skirmish', map);
	let loaded: Game | undefined;
	try {
		world.getResource('match').ai = false;
		const home = planets(world).find(function (e) { return e.components.planet.name === 'Terra'; });
		const carrier = planets(world).find(function (e) { return e.components.planet.name === 'Blue carrier'; });
		if (!home || !carrier) throw new Error('Missing hosts');
		dispatch(world, [home.id], carrier.id, 1);
		advance(world, 5);
		const escorts = dockedShips(world, carrier.id).length;
		expect(escorts).toBe(6);
		const saved = parseConquestSave(captureConquestSave(world, map, 'skirmish', 1, 'escorts'));
		loaded = await createGame('skirmish', map, saved.game);
		const order = loaded.getResource('orderBook').active[0];
		if (!order) throw new Error('Missing combined order');
		expect(order.departures).toHaveLength(8);
		expect(cancelOrder(loaded, order.id)).toBe(true);
		const loadedHost = planets(loaded).find(function (e) { return e.components.planet.name === 'Blue carrier'; });
		if (!loadedHost) throw new Error('Missing loaded host');
		expect(dockedShips(loaded, loadedHost.id)).toHaveLength(3);
		expect(units(loaded).filter(function (e) { return e.components.unit.phase === 'travel' && e.components.unit.owner === 'blue'; })).toHaveLength(8);
	} finally { await loaded?.dispose(); await world.dispose(); }
});

test('AI launches carrier defenders locally and does not donate them to another blockade', async function () {
	const { world, red } = await setup();
	try {
		const home = planets(world).find(function (e) { return e.components.planet.name === 'Vega'; });
		if (!home) throw new Error('Missing rival home');
		for (const entry of shipsAt(world, home.id, 'red')) world.removeEntity(entry.id);
		spawnShip(world, home.id, 'blue');
		spawnShip(world, red.id, 'blue');
		spawnShip(world, red.id, 'blue');
		world.getResource('match').ai = true;
		world.getResource('match').aiClock = CONFIG.aiInterval;
		advance(world, CONFIG.step);
		expect(shipsAt(world, red.id, 'red')).toHaveLength(3);
		expect(units(world).some(function (e) { return e.components.unit.owner === 'red' && e.components.unit.phase === 'travel'; })).toBe(false);
	} finally { await world.dispose(); }
});

test('pending cancellation restores external ships without bypassing carrier docking restrictions', async function () {
	const { world, blue, red } = await setup();
	try {
		const own = spawnShip(world, blue.id, 'blue');
		if (!own) throw new Error('Missing ship');
		own.components.unit.phase = 'orbit';
		spawnShip(world, blue.id, 'red');
		world.getResource('match').paused = true;
		dispatch(world, [blue.id], red.id, 1, 'ships');
		const order = world.getResource('orderBook').active[0];
		if (!order) throw new Error('Missing order');
		cancelOrder(world, order.id);
		expect(dockedShips(world, blue.id)).toHaveLength(3);
		expect(shipsAt(world, blue.id, 'blue')).toHaveLength(1);
		const hostileSource = spawnShip(world, red.id, 'blue');
		if (!hostileSource) throw new Error('Missing external ship');
		dispatch(world, [red.id], blue.id, 1, 'ships');
		const next = world.getResource('orderBook').active[0];
		if (!next) throw new Error('Missing external order');
		cancelOrder(world, next.id);
		expect(hostileSource.components.unit.phase).toBe('orbit');
		expect(hostileSource.components.unit.target).toBe(red.id);
	} finally { await world.dispose(); }
});
