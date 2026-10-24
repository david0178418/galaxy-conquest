import { expect, test } from 'bun:test';
import type { Point } from './camera';
import { interceptPoint } from './interception';

const expectInterceptsAtEqualTime = function (
	pursuer: Point,
	speed: number,
	target: Point,
	velocity: Point,
	intercept: Point,
): void {
	const time = Math.hypot(intercept.x - pursuer.x, intercept.y - pursuer.y) / speed;
	expect(intercept.x).toBeCloseTo(target.x + velocity.x * time);
	expect(intercept.y).toBeCloseTo(target.y + velocity.y * time);
};

test('leads a moving target to a point both units reach at the same time', function () {
	const pursuer = { x: 0, y: 0 };
	const target = { x: 10, y: 0 };
	const velocity = { x: 0, y: 3 };
	const speed = 5;
	const intercept = interceptPoint(pursuer, speed, target, velocity);

	expect(intercept.x).toBeCloseTo(10);
	expect(intercept.y).toBeCloseTo(7.5);
	expectInterceptsAtEqualTime(pursuer, speed, target, velocity, intercept);
});

test('updates the intercept after the target turns', function () {
	const pursuer = { x: 0, y: 0 };
	const target = { x: 10, y: 0 };
	const speed = 5;
	const previousCourse = interceptPoint(pursuer, speed, target, { x: 1, y: 0 });
	const turnedCourse = interceptPoint(pursuer, speed, target, { x: 0, y: 1 });

	expect(turnedCourse).not.toEqual(previousCourse);
	expectInterceptsAtEqualTime(pursuer, speed, target, { x: 0, y: 1 }, turnedCourse);
});

test('handles stationary and coincident targets', function () {
	const stationaryTarget = { x: 8, y: -3 };
	expect(interceptPoint({ x: 0, y: 0 }, 4, stationaryTarget, { x: 0, y: 0 })).toEqual(stationaryTarget);

	const coincident = { x: 2, y: 5 };
	expect(interceptPoint(coincident, 4, coincident, { x: 1, y: 2 })).toEqual(coincident);
});

test('returns the present target when it is unreachable and solves equal-speed closing motion', function () {
	const pursuer = { x: 0, y: 0 };
	const target = { x: 10, y: 0 };
	const unreachable = interceptPoint(pursuer, 1, target, { x: 2, y: 0 });
	expect(unreachable).toEqual(target);

	const equalSpeedTarget = { x: 10, y: 0 };
	const equalSpeedVelocity = { x: -3, y: 4 };
	const equalSpeedIntercept = interceptPoint(pursuer, 5, equalSpeedTarget, equalSpeedVelocity);
	expect(Number.isFinite(equalSpeedIntercept.x)).toBe(true);
	expect(Number.isFinite(equalSpeedIntercept.y)).toBe(true);
	expectInterceptsAtEqualTime(pursuer, 5, equalSpeedTarget, equalSpeedVelocity, equalSpeedIntercept);
});

test('falls back to a finite present position for invalid or zero pursuer speed', function () {
	const pursuer = { x: 0, y: 0 };
	const target = { x: 10, y: 0 };
	expect(interceptPoint(pursuer, 0, target, { x: 0, y: 1 })).toEqual(target);
	expect(interceptPoint(pursuer, Number.NaN, target, { x: 0, y: 1 })).toEqual(target);
	expect(interceptPoint(pursuer, 5, target, { x: Number.POSITIVE_INFINITY, y: 1 })).toEqual(target);
	expect(interceptPoint({ x: Number.NaN, y: 0 }, 5, target, { x: 0, y: 1 })).toEqual(target);

	const fallback = interceptPoint(pursuer, 5, { x: Number.NaN, y: Number.POSITIVE_INFINITY }, { x: 0, y: 0 });
	expect(fallback).toEqual(pursuer);
	expect(Number.isFinite(fallback.x)).toBe(true);
	expect(Number.isFinite(fallback.y)).toBe(true);
});
