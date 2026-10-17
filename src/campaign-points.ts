/** Arithmetic inputs only; these are not campaign persistence contracts. */
export interface PointBalance {
	readonly planetId: string;
	readonly systemId: string;
	readonly factionId: string | null;
	readonly maximumPoints: number;
	readonly depletion: number;
}

export interface PointContribution {
	readonly planetId: string;
	readonly points: number;
}

export interface PointCommitment {
	readonly balances: readonly PointBalance[];
	readonly debits: readonly PointContribution[];
	readonly totalPoints: number;
}

const requireId = function (value: string): void {
	if (!value.trim()) throw new Error('Point identities must not be empty.');
};

const requireBalance = function (value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
		throw new Error('Balances must be finite nonnegative numbers within the safe range.');
};

/** Absolute depletion survives maximum changes, including depletion above the maximum. */
export const availablePoints = function (maximumPoints: number, depletion: number): number {
	requireBalance(maximumPoints);
	requireBalance(depletion);
	return Math.max(0, maximumPoints - depletion);
};

const requirePoints = function (value: number): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error('Committed points must be nonnegative safe integers.');
};

/**
 * Validate the complete debit before constructing any updated balances.
 * Purchases use whole points; fractional recovery remains in the planetary balance.
 */
export const commitPoints = function (
	balances: readonly PointBalance[],
	sourceSystemId: string,
	factionId: string,
	contributions: readonly PointContribution[],
): PointCommitment {
	requireId(sourceSystemId);
	requireId(factionId);
	const byId = new Map<string, PointBalance>();
	for (const balance of balances) {
		requireId(balance.planetId);
		requireId(balance.systemId);
		if (balance.factionId !== null) requireId(balance.factionId);
		requireBalance(balance.maximumPoints);
		requireBalance(balance.depletion);
		if (byId.has(balance.planetId)) throw new Error('Duplicate planetary balance.');
		byId.set(balance.planetId, balance);
	}
	const debits = new Map<string, number>();
	let totalPoints = 0;
	for (const contribution of contributions) {
		requireId(contribution.planetId);
		requirePoints(contribution.points);
		if (debits.has(contribution.planetId)) throw new Error('Duplicate planetary contribution.');
		const balance = byId.get(contribution.planetId);
		if (!balance) throw new Error('The contributing planet does not exist.');
		if (balance.systemId !== sourceSystemId)
			throw new Error('Contributions must come from the source system.');
		if (balance.factionId !== factionId)
			throw new Error('Contributions must come from owned planets.');
		if (contribution.points > availablePoints(balance.maximumPoints, balance.depletion))
			throw new Error('The contribution exceeds available planetary points.');
		totalPoints += contribution.points;
		requirePoints(totalPoints);
		debits.set(contribution.planetId, contribution.points);
	}
	return {
		balances: balances.map(function (balance) {
			const depletion = balance.depletion + (debits.get(balance.planetId) ?? 0);
			requireBalance(depletion);
			return { ...balance, depletion };
		}),
		debits: contributions.map(function (contribution) { return { ...contribution }; }),
		totalPoints,
	};
};

export interface PointRecoveryPolicy {
	/** Fraction of the current maximum recovered per application; supplied by the caller. */
	readonly fractionOfMaximum: number;
}

/**
 * Reduce absolute depletion once without rounding or changing the maximum.
 * The caller owns end-of-turn scheduling and idempotency; no clock is consulted.
 */
export const recoverDepletion = function (
	depletion: number,
	maximumPoints: number,
	policy: PointRecoveryPolicy,
): number {
	requireBalance(depletion);
	requireBalance(maximumPoints);
	if (!Number.isFinite(policy.fractionOfMaximum) || policy.fractionOfMaximum < 0 ||
		policy.fractionOfMaximum > 1)
		throw new Error('Recovery fraction must be between zero and one.');
	const recoveredPoints = maximumPoints * policy.fractionOfMaximum;
	const remaining = Math.max(0, depletion - recoveredPoints);
	// Repeated fractional subtraction can leave a few ulps at exhaustion. Scale
	// cancellation cleanup to the subtraction operands, never the planetary maximum:
	// a huge maximum with tiny recovery must not erase meaningful depletion.
	const cancellationTolerance = 16 * Number.EPSILON * Math.max(depletion, recoveredPoints);
	return recoveredPoints > 0 && remaining <= cancellationTolerance ? 0 : remaining;
};
