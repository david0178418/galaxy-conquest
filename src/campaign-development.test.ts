import { expect, test } from 'bun:test';
import { captureDevelopment, completeDevelopmentTurn, developmentMaximum } from './campaign-development';
import type { PlanetDevelopment } from './campaign-development';
import { availablePoints } from './campaign-points';

const policy = Object.freeze({ growthFraction: 0.02, capFraction: 0.2, captureLossFraction: 0.5 });
const recovery = Object.freeze({ fractionOfMaximum: 0.1 });
const planet: PlanetDevelopment = Object.freeze({
	baselinePoints: 100, developmentBonusPoints: 0, depletion: 100,
	factionId: 'blue', capturedTurn: null, lastAppliedTurn: 0,
});

test('held turns grow by baseline percentage, recover after growth and stop at cap', function () {
	const first = completeDevelopmentTurn(planet, 1, policy, recovery);
	expect(first.developmentBonusPoints).toBe(2);
	expect(first.depletion).toBeCloseTo(89.8);
	expect(developmentMaximum(first)).toBe(102);
	let state = first;
	for (let turn = 2; turn <= 20; turn++) state = completeDevelopmentTurn(state, turn, policy, recovery);
	expect(state.developmentBonusPoints).toBe(20);
	expect(state.depletion).toBe(0);
	expect(planet.depletion).toBe(100);
	expect(planet.lastAppliedTurn).toBe(0);
});

test('capture and recapture each halve only accumulated bonus and preserve absolute depletion', function () {
	const developed = { ...planet, developmentBonusPoints: 20, depletion: 115 };
	const captured = captureDevelopment(developed, 'red', 1, policy);
	expect(captured.developmentBonusPoints).toBe(10);
	expect(captured.depletion).toBe(115);
	expect(availablePoints(developmentMaximum(captured), captured.depletion)).toBe(0);
	expect(captureDevelopment(captured, 'red', 1, policy)).toBe(captured);
	const recaptured = captureDevelopment(captured, 'blue', 1, policy);
	expect(recaptured.developmentBonusPoints).toBe(5);
	expect(recaptured.depletion).toBe(115);
	expect(recaptured.capturedTurn).toBe(1);
	const completed = completeDevelopmentTurn(recaptured, 1, policy, recovery);
	expect(completed.developmentBonusPoints).toBe(5);
	expect(completed.depletion).toBe(104.5);
	expect(availablePoints(developmentMaximum(completed), completed.depletion)).toBe(0.5);
	const next = completeDevelopmentTurn(completed, 2, policy, recovery);
	expect(next.developmentBonusPoints).toBe(7);
	expect(next.depletion).toBeCloseTo(93.8);
});

test('repeated boundaries apply neither recovery nor development twice and reject time jumps', function () {
	const completed = completeDevelopmentTurn(planet, 1, policy, recovery);
	expect(completeDevelopmentTurn(completed, 1, policy, recovery)).toBe(completed);
	expect(function () { completeDevelopmentTurn(completed, 0, policy, recovery); }).toThrow();
	expect(function () { completeDevelopmentTurn(completed, 3, policy, recovery); }).toThrow();
	expect(function () { captureDevelopment(completed, 'red', 1, policy); }).toThrow();
	expect(function () { captureDevelopment(completed, 'red', 0, policy); }).toThrow();
	const captured = captureDevelopment(planet, 'red', 2, policy);
	expect(function () { completeDevelopmentTurn(captured, 1, policy, recovery); }).toThrow();
	expect(function () { captureDevelopment(captured, 'blue', 1, policy); }).toThrow();
});

test('fractional bonuses remain unrounded and neutral planets recover without held growth', function () {
	const fractional = { ...planet, baselinePoints: 25, depletion: 30, developmentBonusPoints: 0.5 };
	const captured = captureDevelopment(fractional, 'red', 1, policy);
	expect(captured.developmentBonusPoints).toBe(0.25);
	const completed = completeDevelopmentTurn(captured, 1, policy, recovery);
	expect(completed.depletion).toBe(27.475);
	const neutral = completeDevelopmentTurn({ ...planet, factionId: null }, 1, policy, recovery);
	expect(neutral.developmentBonusPoints).toBe(0);
	expect(neutral.depletion).toBe(90);
});

test('malformed states and policies fail without changing the original state', function () {
	for (const invalid of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		for (const field of ['baselinePoints', 'developmentBonusPoints', 'depletion', 'lastAppliedTurn', 'capturedTurn'] as const) {
			expect(function () { completeDevelopmentTurn({ ...planet, [field]: invalid }, 1, policy, recovery); }).toThrow();
		}
	}
	for (const invalid of [-0.1, 1.1, NaN, Infinity]) {
		for (const field of ['growthFraction', 'capFraction', 'captureLossFraction'] as const) {
			expect(function () { captureDevelopment(planet, 'red', 1, { ...policy, [field]: invalid }); }).toThrow();
		}
		expect(function () { completeDevelopmentTurn(planet, 0, policy, { fractionOfMaximum: invalid }); }).toThrow();
	}
	expect(function () { completeDevelopmentTurn({ ...planet, factionId: ' ' }, 1, policy, recovery); }).toThrow();
	expect(function () { captureDevelopment(planet, '', 1, policy); }).toThrow();
	expect(function () { completeDevelopmentTurn(planet, 0.5, policy, recovery); }).toThrow();
	expect(function () { completeDevelopmentTurn({ ...planet, developmentBonusPoints: 21 }, 1, policy, recovery); }).toThrow();
	expect(function () { developmentMaximum({ ...planet, baselinePoints: Number.MAX_SAFE_INTEGER, developmentBonusPoints: 1 }); }).toThrow();
	expect(planet).toEqual({ baselinePoints: 100, developmentBonusPoints: 0, depletion: 100, factionId: 'blue', capturedTurn: null, lastAppliedTurn: 0 });
});
