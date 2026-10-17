import { availablePoints, recoverDepletion } from './campaign-points';
import type { PointRecoveryPolicy } from './campaign-points';

export interface PlanetDevelopment {
	readonly baselinePoints: number;
	readonly developmentBonusPoints: number;
	readonly depletion: number;
	readonly factionId: string | null;
	readonly capturedTurn: number | null;
	/** Last completed boundary. New campaigns start at zero; the first boundary is one. */
	readonly lastAppliedTurn: number;
}

export interface DevelopmentPolicy {
	readonly growthFraction: number;
	readonly capFraction: number;
	readonly captureLossFraction: number;
}

const requireAmount = function (value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error('Development points must be finite nonnegative numbers within the safe range.');
};

const requireTurn = function (turn: number): void {
	if (!Number.isSafeInteger(turn) || turn < 0)
		throw new Error('Galaxy turns must be nonnegative safe integers.');
};

const requireFaction = function (factionId: string | null): void {
	if (factionId !== null && !factionId.trim()) throw new Error('Faction identities must not be empty.');
};

const validatePolicy = function (policy: DevelopmentPolicy): void {
	for (const fraction of [policy.growthFraction, policy.capFraction, policy.captureLossFraction]) {
		if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
			throw new Error('Development policy fractions must be between zero and one.');
	}
};

export const developmentMaximum = function (planet: PlanetDevelopment): number {
	requireAmount(planet.baselinePoints);
	requireAmount(planet.developmentBonusPoints);
	const maximum = planet.baselinePoints + planet.developmentBonusPoints;
	requireAmount(maximum);
	return maximum;
};

const validatePlanet = function (planet: PlanetDevelopment, policy: DevelopmentPolicy): void {
	validatePolicy(policy);
	availablePoints(developmentMaximum(planet), planet.depletion);
	requireFaction(planet.factionId);
	requireTurn(planet.lastAppliedTurn);
	if (planet.capturedTurn !== null) requireTurn(planet.capturedTurn);
	if (planet.developmentBonusPoints > planet.baselinePoints * policy.capFraction)
		throw new Error('Development bonus exceeds its configured cap.');
};

/** Each actual ownership change loses the configured share of accumulated bonus only. */
export const captureDevelopment = function (
	planet: PlanetDevelopment,
	factionId: string | null,
	turn: number,
	policy: DevelopmentPolicy,
): PlanetDevelopment {
	validatePlanet(planet, policy);
	requireFaction(factionId);
	requireTurn(turn);
	if (turn < planet.lastAppliedTurn || (planet.capturedTurn !== null && turn < planet.capturedTurn))
		throw new Error('Capture cannot move backwards in galaxy time.');
	if (planet.factionId === factionId) return planet;
	if (turn === planet.lastAppliedTurn)
		throw new Error('Cannot capture during an already completed galaxy turn.');
	return {
		...planet,
		factionId,
		capturedTurn: turn,
		developmentBonusPoints: planet.developmentBonusPoints * (1 - policy.captureLossFraction),
	};
};

/**
 * Apply one consecutive completed galaxy turn, growing capacity before recovery.
 * Capture turns recover but do not grow. Tactical duration never enters this calculation.
 */
export const completeDevelopmentTurn = function (
	planet: PlanetDevelopment,
	turn: number,
	policy: DevelopmentPolicy,
	recoveryPolicy: PointRecoveryPolicy,
): PlanetDevelopment {
	validatePlanet(planet, policy);
	requireTurn(turn);
	// Validate recovery policy even on an idempotent replay.
	recoverDepletion(planet.depletion, developmentMaximum(planet), recoveryPolicy);
	if (planet.capturedTurn !== null && planet.capturedTurn > turn)
		throw new Error('Cannot complete a boundary before the latest capture.');
	if (turn < planet.lastAppliedTurn) throw new Error('Galaxy turn boundaries cannot move backwards.');
	if (turn === planet.lastAppliedTurn) return planet;
	if (turn !== planet.lastAppliedTurn + 1) throw new Error('Galaxy turn boundaries must be applied consecutively.');
	const developmentBonusPoints = planet.factionId === null || planet.capturedTurn === turn
		? planet.developmentBonusPoints
		: Math.min(
			planet.baselinePoints * policy.capFraction,
			planet.developmentBonusPoints + planet.baselinePoints * policy.growthFraction,
		);
	const developed = { ...planet, developmentBonusPoints };
	return {
		...developed,
		depletion: recoverDepletion(planet.depletion, developmentMaximum(developed), recoveryPolicy),
		lastAppliedTurn: turn,
	};
};
