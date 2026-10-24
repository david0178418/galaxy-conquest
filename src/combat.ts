import type { SystemRegistrarOf } from 'ecspresso';
import { CONFIG } from './config';
import type { Side } from './config';
import type { Engagement, Game, GameOptions } from './game';

// Return only scheduling capabilities so createGame owns the phase and edges.
type ScheduledSystem = Pick<
	ReturnType<SystemRegistrarOf<Game>['addSystem']>,
	'inPhase' | 'withRef' | 'after'
>;

type CombatDependencies = Pick<
	typeof import('./game'),
	'notify' | 'orbitalUnits' | 'opponent' | 'shipsAt' | 'units'
>;
type UnitEntity = ReturnType<CombatDependencies['units']>[number];

const hurt = function (
	world: Game,
	entity: UnitEntity,
	damage: number,
	lost: Set<number>,
	notify: CombatDependencies['notify'],
): number {
	const unit = entity.components.unit;
	if (damage <= 0 || unit.hp <= 0) return damage;
	const taken = Math.min(unit.hp, damage);
	unit.hp -= taken;
	if (unit.hp <= 0 && unit.kind === 'transport' && !lost.has(entity.id)) {
		lost.add(entity.id);
		const match = world.getResource('match');
		match.transportsLost++;
		match.troopsLost += unit.cargo;
		const planet = world.getComponent(unit.target, 'planet');
		const place = planet ? planet.name : 'Transit';
		notify(
			world,
			`${place}: ${unit.cargo} ${unit.owner === 'blue' ? 'your' : 'enemy'} troops lost ${unit.phase === 'orbit' ? 'in orbit' : 'in transit'}`,
			unit.owner,
		);
	}
	return damage - taken;
};
const damageOrbit = function (
	world: Game,
	id: number,
	side: Side,
	damage: number,
	lost: Set<number>,
	{ notify, orbitalUnits }: CombatDependencies,
): void {
	const planet = world.getComponent(id, 'planet');
	if (!planet || damage <= 0) return;
	// Ships absorb fire before fixed defenses and exposed transports.
	const targets = orbitalUnits(world, id, side);
	for (const entity of targets.filter(function (entry) {
		return entry.components.unit.kind === 'ship';
	}))
		damage = hurt(world, entity, damage, lost, notify);
	if (planet.owner === side && planet.guns > 0) {
		const taken = Math.min(planet.guns * CONFIG.gunHealth, damage);
		planet.guns = Math.max(0, planet.guns - taken / CONFIG.gunHealth);
		damage -= taken;
	}
	for (const entity of targets.filter(function (entry) {
		return (
			entry.components.unit.kind === 'transport' &&
			entry.components.unit.age >= CONFIG.arrivalGrace
		);
	}))
		damage = hurt(world, entity, damage, lost, notify);
};
interface PassShot {
	shooterId: number;
	target: UnitEntity;
	damage: number;
	from: { x: number; y: number };
	to: { x: number; y: number };
	owner: Side;
}
type TargetCandidate = { entity: UnitEntity; dist: number };
const preferTarget = function (
	current: TargetCandidate | undefined,
	next: TargetCandidate,
): TargetCandidate {
	if (!current) return next;
	const currentShip = current.entity.components.unit.kind === 'ship';
	const nextShip = next.entity.components.unit.kind === 'ship';
	if (currentShip !== nextShip) return nextShip ? next : current;
	if (next.dist < current.dist) return next;
	if (next.dist === current.dist && next.entity.id < current.entity.id)
		return next;
	return current;
};
export const planPasses = function (
	world: Game,
	dt: number,
	units: CombatDependencies['units'],
	searchPadding = 0,
): PassShot[] {
	const travelers = units(world).filter(function (entity) {
		const unit = entity.components.unit;
		return unit.phase === 'travel' && unit.hp > 0;
	});
	const travelersById = new Map(
		travelers.map(function (entity) {
			return [entity.id, entity] as const;
		}),
	);
	const shooters = travelers
		.filter(function (entity) {
			return entity.components.unit.kind === 'ship';
		})
		.sort(function (a, b) {
			return a.id - b.id;
		});
	const spatialIndex = world.getResource('spatialIndex');
	const candidates: number[] = [];
	const volley: PassShot[] = [];
	for (const shooter of shooters) {
		const origin = shooter.components.unit;
		const from = { x: origin.x, y: origin.y };
		let best: { entity: UnitEntity; dist: number } | undefined;
		candidates.length = 0;
		spatialIndex.queryRadiusInto(
			from.x,
			from.y,
			CONFIG.engagementRange + searchPadding,
			candidates,
		);
		for (const targetId of candidates) {
			const target = travelersById.get(targetId);
			if (!target) continue;
			const unit = target.components.unit;
			if (
				target.id === shooter.id ||
				unit.hp <= 0 ||
				unit.owner === origin.owner
			)
				continue;
			const dist = Math.hypot(from.x - unit.x, from.y - unit.y);
			if (dist > CONFIG.engagementRange) continue;
			best = preferTarget(best, { entity: target, dist });
		}
		if (!best) continue;
		const to = best.entity.components.unit;
		volley.push({
			shooterId: shooter.id,
			target: best.entity,
			damage: CONFIG.shipDamage * dt,
			from,
			to,
			owner: origin.owner,
		});
	}
	return volley;
};
const applyPassVolley = function (
	world: Game,
	volley: readonly PassShot[],
	lost: Set<number>,
	shots: Engagement[],
	notify: CombatDependencies['notify'],
): void {
	for (const shot of volley) {
		const before = shot.target.components.unit.hp;
		hurt(world, shot.target, shot.damage, lost, notify);
		if (shot.target.components.unit.hp < before)
			shots.push({
				x1: shot.from.x,
				y1: shot.from.y,
				x2: shot.to.x,
				y2: shot.to.y,
				owner: shot.owner,
			});
	}
};

export const registerCombat = function (
	systems: SystemRegistrarOf<Game>,
	active: () => boolean,
	dependencies: CombatDependencies,
	onCapture?: GameOptions['onCapture'],
): ScheduledSystem {
	const { notify, orbitalUnits, opponent, shipsAt, units } = dependencies;
	return systems
		.addSystem('combat-and-landing')
		.addQuery('planets', { with: ['planet'], mutates: ['planet'] })
		.setProcess(function ({ queries, dt, ecs }) {
			if (!active()) return;
			const match = ecs.getResource('match');
			const shots: Engagement[] = [];
			const lost = new Set<number>();
			for (const {
				id,
				components: { planet: p },
			} of queries.planets) {
				const blueDamage =
					shipsAt(ecs, id, 'blue').length * CONFIG.shipDamage +
					(p.owner === 'blue' ? p.guns * CONFIG.gunDamage : 0);
				const redDamage =
					shipsAt(ecs, id, 'red').length * CONFIG.shipDamage +
					(p.owner === 'red' ? p.guns * CONFIG.gunDamage : 0);
				damageOrbit(ecs, id, 'blue', redDamage * dt, lost, dependencies);
				damageOrbit(ecs, id, 'red', blueDamage * dt, lost, dependencies);
			}
			// The index holds pre-movement positions; include one step of target travel.
			const volley = planPasses(ecs, dt, units, CONFIG.travelSpeed * dt);
			applyPassVolley(ecs, volley, lost, shots, notify);
			match.engagements = shots;
			for (const {
				id,
				components: { planet: p },
			} of queries.planets) {
				for (const {
					id: unitId,
					components: { unit: u },
				} of orbitalUnits(ecs, id)) {
					if (u.kind !== 'transport' || u.hp <= 0) continue;
					const enemy = opponent(u.owner);
					if (
						shipsAt(ecs, id, enemy).length > 0 ||
						(p.owner === enemy && p.guns > 0)
					)
						continue;
					if (p.owner === u.owner) p.troops += u.cargo;
					else if (u.cargo > p.troops) {
						const previousOwner = p.owner;
						p.troops = u.cargo - p.troops;
						p.owner = u.owner;
					if (p.carrier) {
						p.carrier.destination = null;
						const transferred = new Set<number>();
						for (const entry of units(ecs)) {
							const stored = entry.components.unit;
							if (stored.target === id && stored.phase === 'docked') { stored.owner = u.owner; transferred.add(entry.id); }
						}
						const book = ecs.getResource('orderBook');
						for (const order of book.active) {
							order.departures = order.departures.filter(function (d) { return !transferred.has(d.unitId); });
							// Paused dispatch already reserves real units; detach old inventory control.
							if (order.owner === previousOwner && order.state === 'pending') order.departures = order.departures.filter(function (d) { return d.source !== id; });
						}
					}
						onCapture?.({ planetId: id, previousOwner, owner: u.owner }, ecs);
						p.progress = 0;
						p.production = 'troops';
						const match = ecs.getResource('match');
						match.captures++;
						if (u.owner === 'blue' && match.firstCapture === null)
							match.firstCapture = match.time;
						notify(ecs, `${p.name} captured`, u.owner);
					} else {
						p.troops -= u.cargo;
						notify(
							ecs,
							`${p.name}: ${u.cargo} troops met ground resistance`,
							u.owner,
						);
					}
					u.hp = 0;
					ecs.commands.removeEntity(unitId);
				}
			}
			for (const { id, components: { planet: p } } of queries.planets) {
				if (!p.carrier || p.owner === 'neutral' || shipsAt(ecs, id, opponent(p.owner)).length > 0) continue;
				for (const entry of shipsAt(ecs, id, p.owner)) {
					entry.components.unit.phase = 'docked';
					entry.components.unit.x = p.x;
					entry.components.unit.y = p.y;
				}
			}
			for (const entity of units(ecs))
				if (entity.components.unit.hp <= 0)
					ecs.commands.removeEntity(entity.id);
		});
};
