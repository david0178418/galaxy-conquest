// Deterministic browser evidence scenarios. Loaded only through the diagnostics opt-in.
import { CONFIG } from './config';
import { createGame, dispatch, moveCarrier, planets, spawnShip, type Game } from './game';
import { LAB_MAP, type StarMap } from './maps';

export type CarrierPreview = 'intercept' | 'blockade' | 'capture';
export const createCarrierPreview = async function (scenario: CarrierPreview): Promise<{ game: Game; map: StarMap }> {
	const map = { ...LAB_MAP, carriers: true };
	const game = await createGame('skirmish', map);
	game.getResource('match').ai = false;
	const host = planets(game).find(function (e) { return e.components.planet.carrier && e.components.planet.owner === 'blue'; });
	const sol = planets(game).find(function (e) { return e.components.planet.name === 'Sol'; });
	if (!host || !sol) { await game.dispose(); throw new Error('Carrier preview setup missing'); }
	const p = host.components.planet;
	p.x = 680; p.y = 620;
	sol.components.planet.owner = 'blue';
	sol.components.planet.troops = 20;
	if (scenario === 'intercept') {
		moveCarrier(game, host.id, { x: 1000, y: 850 });
		spawnShip(game, sol.id, 'blue');
		dispatch(game, [sol.id], host.id, 1);
	} else if (scenario === 'blockade') {
		spawnShip(game, host.id, 'red');
		spawnShip(game, host.id, 'red');
		game.spawn({ unit: { owner: 'blue', kind: 'transport', x: p.x, y: p.y, target: host.id, phase: 'orbit', hp: CONFIG.transportHealth, cargo: 10, age: 0 } });
		moveCarrier(game, host.id, { x: 900, y: 620 });
	} else {
		p.troops = 5;
		dispatch(game, [host.id], sol.id, 1 / 3, 'ships');
		game.spawn({ unit: { owner: 'red', kind: 'transport', x: p.x + 80, y: p.y, target: host.id, phase: 'travel', hp: CONFIG.transportHealth, cargo: 6, age: 0 }, localTransform: { x: p.x + 80, y: p.y, rotation: 0, scaleX: 1, scaleY: 1 }, circleCollider: { radius: 0 } });
		moveCarrier(game, host.id, { x: 900, y: 620 });
	}
	// Synchronize carried coordinates before the initial save/installation.
	game.update(CONFIG.step);
	game.getResource('match').paused = true;
	return { game, map };
};
