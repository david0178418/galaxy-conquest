import { expect, test } from 'bun:test';
import { availablePoints, commitPoints, recoverDepletion } from './campaign-points';
import type { PointBalance } from './campaign-points';

const balances: readonly PointBalance[] = Object.freeze([
	Object.freeze({ planetId: 'a', systemId: 'home', factionId: 'blue', maximumPoints: 100, depletion: 0 }),
	Object.freeze({ planetId: 'b', systemId: 'home', factionId: 'blue', maximumPoints: 40, depletion: 0 }),
	Object.freeze({ planetId: 'c', systemId: 'away', factionId: 'blue', maximumPoints: 30, depletion: 0 }),
	Object.freeze({ planetId: 'd', systemId: 'home', factionId: 'red', maximumPoints: 20, depletion: 0 }),
	Object.freeze({ planetId: 'e', systemId: 'home', factionId: null, maximumPoints: 10, depletion: 0 }),
]);

test('commitments debit partial and full contributions without changing inputs', function () {
	const contributions = Object.freeze([
		Object.freeze({ planetId: 'a', points: 30 }),
		Object.freeze({ planetId: 'b', points: 40 }),
	]);
	const committed = commitPoints(balances, 'home', 'blue', contributions);
	expect(committed.totalPoints).toBe(70);
	expect(committed.debits).toEqual(contributions);
	expect(committed.balances.map(function (balance) { return availablePoints(balance.maximumPoints, balance.depletion); }))
		.toEqual([70, 0, 30, 20, 10]);
	expect(balances[0]?.depletion).toBe(0);
	expect(committed.debits[0]).not.toBe(contributions[0]);
	expect(committed.balances[2]).not.toBe(balances[2]);
});

test('successive commitments use reduced balances and cannot spend the same points again', function () {
	const first = commitPoints(balances, 'home', 'blue', [{ planetId: 'a', points: 60 }]);
	expect(function () {
		commitPoints(first.balances, 'home', 'blue', [{ planetId: 'a', points: 60 }]);
	}).toThrow();
	const second = commitPoints(first.balances, 'home', 'blue', [{ planetId: 'a', points: 40 }]);
	expect(second.balances[0]?.depletion).toBe(100);
	expect(commitPoints(second.balances, 'home', 'blue', [{ planetId: 'a', points: 0 }]).totalPoints).toBe(0);
});

test('a later invalid contribution rejects the entire commitment', function () {
	expect(function () {
		commitPoints(balances, 'home', 'blue', [{ planetId: 'a', points: 50 }, { planetId: 'b', points: 41 }]);
	}).toThrow();
	expect(balances[0]?.depletion).toBe(0);
});

test('contributions reject foreign systems, foreign ownership, neutral and missing planets', function () {
	for (const planetId of ['c', 'd', 'e', 'missing', '']) {
		expect(function () { commitPoints(balances, 'home', 'blue', [{ planetId, points: 0 }]); }).toThrow();
	}
	expect(function () { commitPoints(balances, '', 'blue', []); }).toThrow();
	expect(function () { commitPoints(balances, 'home', ' ', []); }).toThrow();
});

test('duplicate identities and contributions cannot mask overspending', function () {
	expect(function () { commitPoints([...balances, ...balances], 'home', 'blue', []); }).toThrow();
	expect(function () {
		commitPoints(balances, 'home', 'blue', [{ planetId: 'a', points: 60 }, { planetId: 'a', points: 60 }]);
	}).toThrow();
});

test('unsafe, negative, fractional and nonfinite spending values are rejected', function () {
	for (const points of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		expect(function () { commitPoints(balances, 'home', 'blue', [{ planetId: 'a', points }]); }).toThrow();
	}
	const large = balances.slice(0, 2).map(function (balance) {
		return { ...balance, maximumPoints: Number.MAX_SAFE_INTEGER };
	});
	expect(function () {
		commitPoints(large, 'home', 'blue', large.map(function (balance) {
			return { planetId: balance.planetId, points: balance.maximumPoints };
		}));
	}).toThrow();
});

test('absolute depletion survives capture and maximum changes, including above the maximum', function () {
	const original = { planetId: 'a', systemId: 'home', factionId: 'blue', maximumPoints: 100, depletion: 80 };
	const captured = { ...original, factionId: 'red', maximumPoints: 60 };
	const recaptured = { ...captured, factionId: 'blue', maximumPoints: 100 };
	expect(availablePoints(original.maximumPoints, original.depletion)).toBe(20);
	expect(captured.depletion).toBe(80);
	expect(availablePoints(captured.maximumPoints, captured.depletion)).toBe(0);
	expect(recaptured.depletion).toBe(80);
	expect(availablePoints(recaptured.maximumPoints, recaptured.depletion)).toBe(20);
	let depletion = captured.depletion;
	for (const expected of [74, 68, 62, 56]) {
		depletion = recoverDepletion(depletion, captured.maximumPoints, { fractionOfMaximum: 0.1 });
		expect(depletion).toBe(expected);
		expect(availablePoints(captured.maximumPoints, depletion)).toBe(Math.max(0, 60 - expected));
	}
});

test('fractional recovery remains available for subsequent whole-point purchases', function () {
	const depletion = recoverDepletion(25, 25, { fractionOfMaximum: 0.1 });
	expect(depletion).toBe(22.5);
	const recovered = [{ planetId: 'a', systemId: 'home', factionId: 'blue', maximumPoints: 25, depletion }];
	const spent = commitPoints(recovered, 'home', 'blue', [{ planetId: 'a', points: 2 }]);
	expect(spent.balances[0]?.depletion).toBe(24.5);
	expect(availablePoints(25, spent.balances[0]?.depletion ?? NaN)).toBe(0.5);
	expect(function () { commitPoints(spent.balances, 'home', 'blue', [{ planetId: 'a', points: 1 }]); }).toThrow();
	expect(recovered[0]?.depletion).toBe(22.5);
});

test('recovery uses explicit current-maximum fraction and stops at zero depletion', function () {
	const policy = { fractionOfMaximum: 0.1 };
	expect(recoverDepletion(80, 100, policy)).toBe(70);
	expect(recoverDepletion(5, 100, policy)).toBe(0);
	expect(recoverDepletion(0, 100, policy)).toBe(0);
	expect(recoverDepletion(100, 0, policy)).toBe(100);
	expect(recoverDepletion(20, 100, { fractionOfMaximum: 0 })).toBe(20);
	expect(recoverDepletion(120, 100, { fractionOfMaximum: 1 })).toBe(20);
});

test('balances reject negative, nonfinite and excessive values while accepting fractions', function () {
	for (const invalid of [-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		for (const balance of [
			{ planetId: 'a', systemId: 'home', factionId: 'blue', maximumPoints: invalid, depletion: 0 },
			{ planetId: 'a', systemId: 'home', factionId: 'blue', maximumPoints: 100, depletion: invalid },
		]) {
			expect(function () { commitPoints([balance], 'home', 'blue', []); }).toThrow();
			expect(function () { availablePoints(balance.maximumPoints, balance.depletion); }).toThrow();
			expect(function () { recoverDepletion(balance.depletion, balance.maximumPoints, { fractionOfMaximum: 0.1 }); }).toThrow();
		}
	}
	expect(availablePoints(10.5, 0.25)).toBe(10.25);
	for (const fractionOfMaximum of [-1, NaN, Infinity, -Infinity, 1.1]) {
		expect(function () { recoverDepletion(0, 100, { fractionOfMaximum }); }).toThrow();
	}
});

test('fractional recovery exhaustion clears floating residue so all whole points can be spent', function () {
	let depletion = 11;
	for (let turn = 1; turn <= 10; turn++) {
		depletion = recoverDepletion(depletion, 11, { fractionOfMaximum: 0.1 });
	}
	expect(depletion).toBe(0);
	const committed = commitPoints([
		{ planetId: 'a', systemId: 'home', factionId: 'blue', maximumPoints: 11, depletion },
	], 'home', 'blue', [{ planetId: 'a', points: 11 }]);
	expect(committed.totalPoints).toBe(11);
	expect(committed.balances[0]?.depletion).toBe(11);
	expect(recoverDepletion(1.100000001, 11, { fractionOfMaximum: 0.1 })).toBeCloseTo(0.000000001, 15);
	expect(recoverDepletion(0.000000000000001, 11, { fractionOfMaximum: 0 })).toBe(0.000000000000001);
});

test('tiny positive recovery against a huge maximum preserves meaningful depletion', function () {
	const fractionOfMaximum = 1e-30;
	const recovered = recoverDepletion(1, Number.MAX_SAFE_INTEGER, { fractionOfMaximum });
	expect(recovered).toBe(1 - Number.MAX_SAFE_INTEGER * fractionOfMaximum);
	expect(recovered).toBeGreaterThan(0.99);
	expect(recoverDepletion(1.25, Number.MAX_SAFE_INTEGER, { fractionOfMaximum })).toBeGreaterThan(1.24);
});
