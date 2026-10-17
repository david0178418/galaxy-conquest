export interface AllocationCosts {
	troops: number;
	ships: number;
	guns: number;
}

export interface InvasionForces {
	troops: number;
	ships: number;
}

export interface DefenseForces extends InvasionForces {
	guns: number;
}

export interface BeachheadAllocation extends InvasionForces {
	planetId: string;
}

export type AllocationValidation =
	| { valid: true; spent: number; remaining: number }
	| { valid: false; reason: string };

const isCount = function (value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
};

const isCost = function (value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
};

const isBudget = function (value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
};

const checkBudget = function (budget: number, spent: number): AllocationValidation {
	if (!Number.isSafeInteger(spent)) return { valid: false, reason: 'Allocation cost exceeds the safe integer range' };
	if (spent > budget) return { valid: false, reason: 'Allocation exceeds the available points' };
	return { valid: true, spent, remaining: budget - spent };
};

export const validateDefenderAllocation = function (
	budget: number,
	forces: Readonly<DefenseForces>,
	costs: Readonly<AllocationCosts>,
): AllocationValidation {
	if (!isBudget(budget)) return { valid: false, reason: 'Budget must be finite, nonnegative, and within the safe numeric range' };
	if (![costs.troops, costs.ships, costs.guns].every(isCost))
		return { valid: false, reason: 'Unit costs must be positive safe integers' };
	if (![forces.troops, forces.ships, forces.guns].every(isCount))
		return { valid: false, reason: 'Force counts must be nonnegative safe integers' };
	return checkBudget(budget, forces.troops * costs.troops + forces.ships * costs.ships + forces.guns * costs.guns);
};

// These checks describe setup spending, not whether the resulting invasion can win.
// In particular, a ship-only beachhead is a valid allocation.
export const validateAttackerAllocation = function (
	budget: number,
	beachheads: readonly Readonly<BeachheadAllocation>[],
	planetIds: readonly string[],
	costs: Readonly<Pick<AllocationCosts, 'troops' | 'ships'>>,
): AllocationValidation {
	if (!isBudget(budget)) return { valid: false, reason: 'Budget must be finite, nonnegative, and within the safe numeric range' };
	if (![costs.troops, costs.ships].every(isCost))
		return { valid: false, reason: 'Unit costs must be positive safe integers' };
	if (beachheads.length === 0) return { valid: false, reason: 'Choose at least one beachhead' };
	const knownTargets = new Set(planetIds);
	const allocatedTargets = new Set<string>();
	let spent = 0;
	for (const beachhead of beachheads) {
		if (beachhead.planetId.trim().length === 0 || !knownTargets.has(beachhead.planetId))
			return { valid: false, reason: 'Beachhead target must identify a known planet' };
		if (allocatedTargets.has(beachhead.planetId))
			return { valid: false, reason: 'Each beachhead must target a different planet' };
		allocatedTargets.add(beachhead.planetId);
		if (![beachhead.troops, beachhead.ships].every(isCount))
			return { valid: false, reason: 'Force counts must be nonnegative safe integers' };
		if (beachhead.troops === 0 && beachhead.ships === 0)
			return { valid: false, reason: 'Each beachhead must include a force' };
		spent += beachhead.troops * costs.troops + beachhead.ships * costs.ships;
	}
	return checkBudget(budget, spent);
};
