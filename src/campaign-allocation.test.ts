import { expect, test } from 'bun:test';
import { validateAttackerAllocation, validateDefenderAllocation } from './campaign-allocation';
import { availablePoints, recoverDepletion } from './campaign-points';

const costs = { troops: 2, ships: 5, guns: 8 };
const planets = ['sol', 'terra'];

test('defender allocation uses its own budget and configurable costs', function () {
	expect(validateDefenderAllocation(30, { troops: 6, ships: 2, guns: 1 }, costs))
		.toEqual({ valid: true, spent: 30, remaining: 0 });
	expect(validateDefenderAllocation(29, { troops: 6, ships: 2, guns: 1 }, costs).valid).toBe(false);
	expect(validateDefenderAllocation(0, { troops: 0, ships: 0, guns: 0 }, costs))
		.toEqual({ valid: true, spent: 0, remaining: 0 });
	expect(validateDefenderAllocation(30, { troops: 6, ships: 2, guns: 1 }, { troops: 1, ships: 2, guns: 3 }))
		.toEqual({ valid: true, spent: 13, remaining: 17 });
});

test('split beachheads consume one shared budget without mutating inputs', function () {
	const beachheads = Object.freeze([
		Object.freeze({ planetId: 'sol', troops: 5, ships: 1 }),
		Object.freeze({ planetId: 'terra', troops: 0, ships: 2 }),
	]);
	expect(validateAttackerAllocation(25, beachheads, planets, costs))
		.toEqual({ valid: true, spent: 25, remaining: 0 });
	expect(validateAttackerAllocation(24, beachheads, planets, costs).valid).toBe(false);
});

test('ship-only and troop-only invasions are allocation choices', function () {
	expect(validateAttackerAllocation(20, [{ planetId: 'sol', troops: 0, ships: 3 }], planets, costs))
		.toEqual({ valid: true, spent: 15, remaining: 5 });
	expect(validateAttackerAllocation(20, [{ planetId: 'sol', troops: 10, ships: 0 }], planets, costs))
		.toEqual({ valid: true, spent: 20, remaining: 0 });
});

test('recovered fractional balances buy whole forces and retain fractional points', function () {
	const depletion = recoverDepletion(25, 25, { fractionOfMaximum: 0.1 });
	const budget = availablePoints(25, depletion);
	expect(budget).toBe(2.5);
	expect(validateDefenderAllocation(budget, { troops: 1, ships: 0, guns: 0 }, costs))
		.toEqual({ valid: true, spent: 2, remaining: 0.5 });
	expect(validateAttackerAllocation(budget, [{ planetId: 'sol', troops: 1, ships: 0 }], planets, costs))
		.toEqual({ valid: true, spent: 2, remaining: 0.5 });
	expect(validateDefenderAllocation(budget, { troops: 2, ships: 0, guns: 0 }, costs).valid).toBe(false);
	expect(validateAttackerAllocation(budget, [{ planetId: 'sol', troops: 2, ships: 0 }], planets, costs).valid).toBe(false);
	expect(validateDefenderAllocation(0.5, { troops: 0, ships: 0, guns: 0 }, costs))
		.toEqual({ valid: true, spent: 0, remaining: 0.5 });
});

test('launch requires nonempty forces and unique known nonempty targets', function () {
	expect(validateAttackerAllocation(20, [], planets, costs).valid).toBe(false);
	expect(validateAttackerAllocation(20, [{ planetId: 'sol', troops: 0, ships: 0 }], planets, costs).valid).toBe(false);
	for (const planetId of ['unknown', '', '   ']) {
		expect(validateAttackerAllocation(20, [{ planetId, troops: 1, ships: 0 }], [...planets, ''], costs).valid).toBe(false);
	}
	expect(validateAttackerAllocation(20, [
		{ planetId: 'sol', troops: 1, ships: 0 },
		{ planetId: 'sol', troops: 1, ships: 0 },
	], planets, costs).valid).toBe(false);
});

test('invalid numeric inputs cannot bypass either allocation budget', function () {
	for (const budget of [-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		expect(validateDefenderAllocation(budget, { troops: 0, ships: 0, guns: 0 }, costs).valid).toBe(false);
		expect(validateAttackerAllocation(budget, [{ planetId: 'sol', troops: 1, ships: 0 }], planets, costs).valid).toBe(false);
	}
	for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		for (const key of ['troops', 'ships', 'guns'] as const) {
			expect(validateDefenderAllocation(20, { troops: 0, ships: 0, guns: 0, [key]: value }, costs).valid).toBe(false);
			expect(validateDefenderAllocation(20, { troops: 0, ships: 0, guns: 0 }, { ...costs, [key]: value }).valid).toBe(false);
		}
		for (const key of ['troops', 'ships'] as const) {
			expect(validateAttackerAllocation(20, [{ planetId: 'sol', troops: 1, ships: 0, [key]: value }], planets, costs).valid).toBe(false);
			expect(validateAttackerAllocation(20, [{ planetId: 'sol', troops: 1, ships: 0 }], planets, { ...costs, [key]: value }).valid).toBe(false);
		}
	}
	expect(validateDefenderAllocation(20, { troops: 0, ships: 0, guns: 0 }, { ...costs, guns: 0 }).valid).toBe(false);
	expect(validateAttackerAllocation(20, [{ planetId: 'sol', troops: 1, ships: 0 }], planets, { troops: 0, ships: 5 }).valid).toBe(false);
});

test('individually valid numbers cannot overflow the computed cost', function () {
	const budget = Number.MAX_SAFE_INTEGER;
	expect(validateDefenderAllocation(budget, { troops: budget, ships: 0, guns: 0 }, costs).valid).toBe(false);
	expect(validateAttackerAllocation(budget, [
		{ planetId: 'sol', troops: 0, ships: budget },
	], planets, costs).valid).toBe(false);
	expect(validateAttackerAllocation(budget, [
		{ planetId: 'sol', troops: budget - 1, ships: 0 },
		{ planetId: 'terra', troops: 2, ships: 0 },
	], planets, { troops: 1, ships: 1 }).valid).toBe(false);
});
