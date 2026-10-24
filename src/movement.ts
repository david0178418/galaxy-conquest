import type { SystemRegistrarOf } from 'ecspresso';
import { CONFIG } from './config';
import { planPasses } from './combat';
import type { Game } from './game';
import { interceptPoint } from './interception';

// Below the slowest ordinary unit (transport = 0.5 travel speed), at every pace.
export const CARRIER_SPEED = CONFIG.travelSpeed * 0.25;
export const CARRIER_ARRIVAL_TOLERANCE = 0.01;

// Return only scheduling capabilities so createGame owns the phase and edges.
type ScheduledSystem = Pick<
	ReturnType<SystemRegistrarOf<Game>['addSystem']>,
	'inPhase' | 'withRef' | 'after'
>;

type MovementDependencies = {
	active: () => boolean;
	units: typeof import('./game')['units'];
	syncUnitPosition: (world: Game, unitId: number, x: number, y: number) => void;
};

export const registerMovement = function (
	systems: SystemRegistrarOf<Game>,
	{ active, units, syncUnitPosition }: MovementDependencies,
): ScheduledSystem {
	return systems
		.addSystem('travel')
		.addQuery('hosts', { with: ['planet'], mutates: ['planet'] })
		.addQuery('units', { with: ['unit'], mutates: ['unit'] })
		.setProcess(function ({ queries, dt, ecs }) {
			if (!active()) return;
			for (const { components: { planet: p } } of queries.hosts) {
				const carrier = p.carrier;
				if (!carrier?.destination) continue;
				const dx = carrier.destination.x - p.x, dy = carrier.destination.y - p.y;
				const distance = Math.hypot(dx, dy);
				if (distance <= CARRIER_ARRIVAL_TOLERANCE || distance <= CARRIER_SPEED * dt) {
					p.x = carrier.destination.x; p.y = carrier.destination.y; carrier.destination = null;
				} else {
					carrier.heading = Math.atan2(dy, dx);
					p.x += dx / distance * CARRIER_SPEED * dt; p.y += dy / distance * CARRIER_SPEED * dt;
				}
			}
			// Decide from one position snapshot so iteration order cannot release a ship.
			const fighting = new Set(planPasses(ecs, 0, units).map(function (shot) {
				return shot.shooterId;
			}));
			for (const entity of queries.units) {
				const u = entity.components.unit;
				const p = ecs.getComponent(u.target, 'planet');
				if (!p) {
					ecs.commands.removeEntity(entity.id);
					continue;
				}
				if (u.phase === 'docked' || u.phase === 'orbit') {
					if (p.carrier) { u.x = p.x; u.y = p.y; syncUnitPosition(ecs, entity.id, p.x, p.y); }
					u.age += dt;
					continue;
				}
				const speed = CONFIG.travelSpeed * (u.kind === 'transport' ? 0.5 : 1);
				const velocity = p.carrier?.destination ? { x: Math.cos(p.carrier.heading) * CARRIER_SPEED, y: Math.sin(p.carrier.heading) * CARRIER_SPEED } : { x: 0, y: 0 };
				const predicted = interceptPoint(u, speed, p, velocity);
				const destination = p.carrier?.destination;
				const aim = destination && Math.hypot(predicted.x - p.x, predicted.y - p.y) > Math.hypot(destination.x - p.x, destination.y - p.y) ? destination : predicted;
				const dx = aim.x - u.x, dy = aim.y - u.y;
				const distance = Math.hypot(dx, dy);
				if (Math.hypot(p.x - u.x, p.y - u.y) <= p.radius + CONFIG.arrivalClearance) {
					u.phase = 'orbit';
					u.age = 0;
					continue;
				}
				if (fighting.has(entity.id)) continue;
				const reach = p.radius + CONFIG.arrivalClearance;
				const travel = Math.min(distance, speed * dt);
				if (distance === 0) continue;
				u.x += (dx / distance) * travel;
				u.y += (dy / distance) * travel;
				syncUnitPosition(ecs, entity.id, u.x, u.y);
				if (Math.hypot(p.x - u.x, p.y - u.y) <= reach) {
					u.phase = 'orbit';
					u.age = 0;
				}
			}
		});
};

export const registerTravelerCleanup = function (systems: SystemRegistrarOf<Game>): ScheduledSystem {
	return systems
		.addSystem('traveler-spatial-cleanup')
		.setProcessEach(
			{ with: ['unit', 'circleCollider'] },
			function ({ entity, ecs }) {
				if (
					entity.components.unit.phase !== 'travel' &&
					entity.components.unit.hp > 0
				)
					ecs.commands.removeComponent(entity.id, 'circleCollider');
			},
		);
};
