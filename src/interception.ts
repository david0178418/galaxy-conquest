import type { Point } from './camera';

export const INTERCEPT_RELATIVE_TOLERANCE = 1e-12;

const isFinitePoint = function (point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y);
};

const fallbackPoint = function (pursuer: Point, target: Point): Point {
	if (isFinitePoint(target)) return target;
	if (isFinitePoint(pursuer)) return pursuer;
	return { x: 0, y: 0 };
};

export const interceptPoint = function (
	pursuer: Point,
	speed: number,
	target: Point,
	velocity: Point,
): Point {
	const fallback = fallbackPoint(pursuer, target);
	if (
		!isFinitePoint(pursuer) ||
		!isFinitePoint(target) ||
		!isFinitePoint(velocity) ||
		!Number.isFinite(speed) ||
		speed <= 0
	)
		return fallback;

	const relativeX = target.x - pursuer.x;
	const relativeY = target.y - pursuer.y;
	const distanceScale = Math.max(Math.abs(relativeX), Math.abs(relativeY));
	if (!Number.isFinite(distanceScale)) return fallback;
	if (distanceScale === 0) return target;

	const velocityScale = Math.max(Math.abs(velocity.x), Math.abs(velocity.y), speed);
	const positionX = relativeX / distanceScale;
	const positionY = relativeY / distanceScale;
	const targetVelocityX = velocity.x / velocityScale;
	const targetVelocityY = velocity.y / velocityScale;
	const pursuerSpeed = speed / velocityScale;
	const targetSpeedSquared = targetVelocityX * targetVelocityX + targetVelocityY * targetVelocityY;
	const pursuerSpeedSquared = pursuerSpeed * pursuerSpeed;
	const a = targetSpeedSquared - pursuerSpeedSquared;
	const b = 2 * (positionX * targetVelocityX + positionY * targetVelocityY);
	const c = positionX * positionX + positionY * positionY;
	let scaledTime: number;

	if (Math.abs(a) <= INTERCEPT_RELATIVE_TOLERANCE * Math.max(targetSpeedSquared, pursuerSpeedSquared)) {
		// At equal speeds, the linear equation has a positive solution only while closing.
		if (b >= 0) return fallback;
		scaledTime = -c / b;
	} else {
		const fourAC = 4 * a * c;
		const discriminant = b * b - fourAC;
		const discriminantTolerance = INTERCEPT_RELATIVE_TOLERANCE * (b * b + Math.abs(fourAC));
		if (discriminant < -discriminantTolerance) return fallback;

		const squareRoot = Math.sqrt(Math.max(0, discriminant));
		const q = -0.5 * (b + (b < 0 ? -squareRoot : squareRoot));
		const candidateTimes = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
		let earliestTime: number | undefined;
		for (const candidateTime of candidateTimes) {
			if (
				Number.isFinite(candidateTime) &&
				candidateTime > 0 &&
				(earliestTime === undefined || candidateTime < earliestTime)
			)
				earliestTime = candidateTime;
		}
		if (earliestTime === undefined) return fallback;
		scaledTime = earliestTime;
	}
	if (!Number.isFinite(scaledTime) || scaledTime <= 0) return fallback;

	const time = (scaledTime * distanceScale) / velocityScale;
	const predictedX = target.x + velocity.x * time;
	const predictedY = target.y + velocity.y * time;
	if (!Number.isFinite(predictedX) || !Number.isFinite(predictedY)) return fallback;
	return { x: predictedX, y: predictedY };
};
