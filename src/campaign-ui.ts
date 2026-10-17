import type { CampaignState, ExpeditionOrder } from './campaign-state';
import type { CampaignEncounterSetup } from './campaign-setup';
import { validateAttackerAllocation, validateDefenderAllocation } from './campaign-allocation';
import { availablePoints } from './campaign-points';
import { developmentMaximum } from './campaign-development';
import { campaignWinner } from './campaign-scenario';

const node = function <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (text !== undefined) element.textContent = text;
	if (className) element.className = className;
	return element;
};
const amount = function (value: number): string { return value.toLocaleString(undefined, { maximumFractionDigits: 1 }); };
const actionButton = function (text: string, action: () => void): HTMLButtonElement {
	const button = node('button', text);
	button.type = 'button';
	button.addEventListener('click', action);
	return button;
};
const numberField = function (label: string, value: number, maximum: number, change: (value: number) => void): HTMLLabelElement {
	const wrapper = node('label', label);
	const input = node('input');
	input.type = 'number'; input.min = '0'; input.max = String(maximum); input.step = '1'; input.value = String(value);
	input.addEventListener('input', function () { change(input.valueAsNumber); });
	wrapper.append(input);
	return wrapper;
};

export const createCampaignView = function (options: {
	order: (order: Omit<ExpeditionOrder, 'id' | 'factionId'>) => Promise<void>;
	endTurn: () => Promise<void>;
	setup: (setup: CampaignEncounterSetup) => Promise<void>;
	launch: (setup: CampaignEncounterSetup) => Promise<void>;
	exit: () => Promise<void>;
}): {
	root: HTMLElement;
	render: (state: CampaignState, setup: CampaignEncounterSetup | undefined) => void;
	dispose: () => void;
} {
	const root = node('main', undefined, 'campaign-shell');
	root.id = 'campaign'; root.hidden = true;
	document.body.append(root);
	let selectedSystem: string | undefined;
	let pending = false;
	let setupWrites: Promise<void> = Promise.resolve();
	let latestDraft: CampaignEncounterSetup | undefined;
	const status = node('p', '', 'campaign-status');
	status.setAttribute('role', 'status');
	const run = async function (action: () => Promise<void>): Promise<void> {
		if (pending) return;
		pending = true; root.inert = true; status.textContent = 'Saving…';
		try {
			await setupWrites.catch(async function (error: unknown): Promise<void> {
				if (!latestDraft) throw error;
				await options.setup(latestDraft);
				setupWrites = Promise.resolve();
			});
			await action(); status.textContent = 'Saved locally · campaign slot';
		}
		catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not save campaign.'; }
		finally { pending = false; root.inert = false; }
	};
	const render = function (state: CampaignState, setup: CampaignEncounterSetup | undefined): void {
		latestDraft = setup;
		root.replaceChildren();
		const header = node('header', undefined, 'campaign-header');
		const heading = node('div');
		heading.append(node('p', 'ORBITAL COMMAND · CAMPAIGN PREVIEW', 'campaign-eyebrow'), node('h1', `Galaxy · Turn ${state.turn}`));
		const menu = actionButton('Save & menu', function () { void run(options.exit); });
		const controls = node('div', undefined, 'campaign-header-actions');
		if (!state.encounter) {
			const end = actionButton('End turn', function () { void run(options.endTurn); });
			end.className = 'campaign-primary'; end.disabled = Boolean(campaignWinner(state));
			controls.append(end);
		}
		controls.append(menu);
		header.append(heading, controls); root.append(header);
		const winner = campaignWinner(state);
		if (winner) root.append(node('p', winner === 'blue' ? 'Campaign won · The galaxy is yours.' : 'Campaign lost · Your territory and expeditions are gone.', 'campaign-outcome'));
		if (state.encounter && setup) renderAllocation(state, setup);
		else renderGalaxy(state, Boolean(winner));
		root.append(status);
	};
	const renderGalaxy = function (state: CampaignState, finished: boolean): void {
		selectedSystem ??= state.systems[0]?.id;
		root.append(node('p', 'Commit expeditions, then end the turn. Battles freeze the galaxy; surviving battle units reset afterward.', 'campaign-intro'));
		const galaxy = node('section', undefined, 'campaign-galaxy');
		galaxy.setAttribute('aria-label', 'Galaxy systems');
		const minX = Math.min(...state.systems.map(function (system) { return system.x; }));
		const maxX = Math.max(...state.systems.map(function (system) { return system.x; }));
		for (const system of state.systems) {
			const owned = state.planets.filter(function (planet) { return planet.systemId === system.id; });
			const blue = owned.filter(function (planet) { return planet.factionId === 'blue'; }).length;
			const button = actionButton(system.name, function () { selectedSystem = system.id; render(state, undefined); });
			button.className = `campaign-star ${blue === owned.length ? 'blue' : blue === 0 ? 'red' : 'mixed'}`;
			button.style.left = `${22 + (system.x - minX) / Math.max(1, maxX - minX) * 56}%`;
			button.setAttribute('aria-pressed', String(selectedSystem === system.id));
			button.append(node('small', `${blue}/${owned.length} worlds held`));
			galaxy.append(button);
		}
		root.append(galaxy);
		const source = state.systems.find(function (system) { return system.id === selectedSystem; }) ?? state.systems[0];
		if (!source) return;
		selectedSystem = source.id;
		const content = node('div', undefined, 'campaign-columns');
		const overview = node('section', undefined, 'campaign-panel');
		overview.append(node('p', 'SYSTEM OVERVIEW', 'campaign-eyebrow'), node('h2', source.name));
		const local = state.planets.filter(function (planet) { return planet.systemId === source.id; });
		for (const planet of local) {
			const maximum = developmentMaximum(planet);
			const row = node('div', undefined, 'campaign-planet');
			row.append(node('strong', `${planet.name} · ${planet.factionId === 'blue' ? 'You' : planet.factionId === 'red' ? 'Rival' : 'Neutral'}`),
				node('span', `${amount(availablePoints(maximum, planet.depletion))} / ${amount(maximum)} points`),
				node('small', `Baseline ${amount(planet.baselinePoints)} · Development +${amount(planet.developmentBonusPoints)} · Depletion ${amount(planet.depletion)}`));
			overview.append(row);
		}
		overview.append(node('p', 'Each turn: +2% baseline capacity (up to +20%), then 10% recovery. Capture halves development; depletion persists.', 'campaign-muted'));
		content.append(overview);
		const orders = node('section', undefined, 'campaign-panel');
		orders.append(node('p', 'EXPEDITION ORDERS', 'campaign-eyebrow'), node('h2', 'Commit resources'));
		const owned = local.filter(function (planet) { return planet.factionId === 'blue'; });
		if (owned.length && !finished && state.phase === 'planning' && !state.readyFactions.includes('blue')) {
			const form = node('form');
			const destinationLabel = node('label', 'Destination');
			const destination = node('select');
			for (const system of state.systems.filter(function (item) { return item.id !== source.id; })) {
				const option = node('option', system.name); option.value = system.id; destination.append(option);
			}
			destinationLabel.append(destination); form.append(destinationLabel);
			const contributions = new Map<string, number>();
			const summary = node('p', '0 points committed', 'campaign-muted');
			const submit = node('button', 'Commit expedition'); submit.type = 'submit'; submit.disabled = true;
			for (const planet of owned) {
				const available = Math.floor(availablePoints(developmentMaximum(planet), planet.depletion));
				form.append(numberField(`${planet.name} · ${available} available`, 0, available, function (value) {
					contributions.set(planet.id, value);
					const total = [...contributions.values()].reduce(function (sum, points) { return sum + points; }, 0);
					summary.textContent = `${amount(total)} points committed · ${amount(owned.reduce(function (sum, item) { return sum + availablePoints(developmentMaximum(item), item.depletion); }, 0) - total)} defense points remain`;
					submit.disabled = !Number.isSafeInteger(total) || total <= 0 || !form.checkValidity();
				}));
			}
			form.append(summary, node('p', 'Spending weakens this system’s initial defense and is lost even if the expedition fails. Friendly arrivals replenish depleted points; surplus is discarded.', 'campaign-muted'), submit);
			form.addEventListener('submit', function (event) {
				event.preventDefault();
				if (!form.reportValidity()) return;
				const targetId = destination.value;
				void run(function () { return options.order({ sourceSystemId: source.id, destinationSystemId: targetId,
					contributions: [...contributions].filter(function ([, points]) { return points > 0; }).map(function ([planetId, points]) { return { planetId, points }; }) }); });
			});
			orders.append(form);
		} else orders.append(node('p', owned.length ? 'No further orders are available here.' : 'Select a system with your planets to fund an expedition.', 'campaign-muted'));
		content.append(orders); root.append(content);
		const flights = node('section', undefined, 'campaign-flights');
		flights.append(node('h2', 'Expeditions'));
		const active = state.expeditions.filter(function (expedition) { return expedition.status !== 'resolved'; });
		for (const flight of active) flights.append(node('p', `${flight.factionId === 'blue' ? 'Your' : 'Rival'} expedition · ${state.systems.find(function (system) { return system.id === flight.sourceSystemId; })?.name} → ${state.systems.find(function (system) { return system.id === flight.destinationSystemId; })?.name} · ${flight.points} points · arrival turn ${Math.ceil(flight.arrivalTime)}`));
		if (!active.length) flights.append(node('p', 'No expeditions in transit.', 'campaign-muted'));
		root.append(flights);
	};
	const renderAllocation = function (state: CampaignState, initial: CampaignEncounterSetup): void {
		const encounter = state.encounter;
		if (!encounter) return;
		let draft = structuredClone(initial);
		root.append(node('p', `${encounter.attacker === 'blue' ? 'Your expedition has arrived' : 'Rival invasion incoming'} · ${state.systems.find(function (system) { return system.id === encounter.systemId; })?.name}. Galaxy turn ${state.turn} is frozen.`, 'campaign-intro'));
		const form = node('form', undefined, 'campaign-allocation');
		const validation = node('p', '', 'campaign-status'); validation.setAttribute('role', 'status');
		const submit = node('button', 'Launch encounter'); submit.type = 'submit'; submit.className = 'campaign-primary';
		const defenseSummaries = new Map<string, HTMLElement>();
		const check = function (): boolean {
			const attack = validateAttackerAllocation(encounter.attackerPoints, draft.beachheads, encounter.planets.map(function (planet) { return planet.planetId; }), draft.costs);
			const defenses = draft.defenders.map(function (defender) {
				const planet = encounter.planets.find(function (item) { return item.planetId === defender.planetId; });
				const result = validateDefenderAllocation(planet?.points ?? -1, defender.forces, draft.costs);
				const summary = defenseSummaries.get(defender.planetId);
				if (summary) summary.textContent = result.valid ? `${amount(result.spent)} allocated · ${amount(result.remaining)} unused` : result.reason;
				return result;
			});
			const invalid = !attack.valid ? attack : defenses.find(function (result) { return !result.valid; });
			validation.textContent = invalid && !invalid.valid ? invalid.reason : `Attacker: ${attack.valid ? attack.spent : 0} / ${encounter.attackerPoints} points allocated. Unallocated expedition points are lost.`;
			submit.disabled = Boolean(invalid);
			return !invalid;
		};
		const persist = function (): void {
			if (!check()) return;
			const savedDraft = structuredClone(draft);
			latestDraft = savedDraft;
			setupWrites = setupWrites.catch(function () {}).then(function () { return options.setup(savedDraft); });
			void setupWrites.then(function () { status.textContent = 'Allocation saved locally'; }).catch(function (error: unknown) { status.textContent = error instanceof Error ? error.message : 'Allocation could not be saved'; });
		};
		const defenseSection = node('section', undefined, 'campaign-panel');
		defenseSection.append(node('h2', 'Planetary defenses'));
		for (const defender of draft.defenders) {
			const planet = encounter.planets.find(function (item) { return item.planetId === defender.planetId; });
			if (!planet) continue;
			const row = node('fieldset'); row.disabled = planet.factionId !== 'blue';
			row.append(node('legend', `${planet.name} · ${amount(planet.points)} points · ${planet.factionId === 'blue' ? 'You' : 'Rival'}`));
			for (const kind of ['troops', 'ships', 'guns'] as const) {
				row.append(numberField(`${kind === 'guns' ? 'Platforms' : kind} (${draft.costs[kind]} pt)`, defender.forces[kind], Math.floor(planet.points / draft.costs[kind]), function (value) {
					draft = { ...draft, defenders: draft.defenders.map(function (item) { return item.planetId === defender.planetId ? { ...item, forces: { ...item.forces, [kind]: value } } : item; }) };
					persist();
				}));
			}
			const summary = node('p', '', 'campaign-muted');
			defenseSummaries.set(defender.planetId, summary);
			row.append(summary);
			defenseSection.append(row);
		}
		form.append(defenseSection);
		const attackSection = node('section', undefined, 'campaign-panel');
		attackSection.append(node('h2', `Invasion · ${encounter.attackerPoints} points`), node('p', 'Split the shared budget among beachheads. Every force enters from the same off-screen edge. Initial invasion forces cannot be recalled.', 'campaign-muted'));
		for (const planet of encounter.planets) {
			const allocation = draft.beachheads.find(function (item) { return item.planetId === planet.planetId; });
			const row = node('fieldset'); row.disabled = encounter.attacker !== 'blue'; row.append(node('legend', planet.name));
			for (const kind of ['troops', 'ships'] as const) row.append(numberField(`${kind} (${draft.costs[kind]} pt)`, allocation?.[kind] ?? 0, Math.floor(encounter.attackerPoints / draft.costs[kind]), function (value) {
				const previousAllocation = draft.beachheads.find(function (item) { return item.planetId === planet.planetId; }) ?? { planetId: planet.planetId, troops: 0, ships: 0 };
				const next = { ...previousAllocation, [kind]: value };
				draft = { ...draft, beachheads: [...draft.beachheads.filter(function (item) { return item.planetId !== planet.planetId; }), next].filter(function (item) { return item.troops !== 0 || item.ships !== 0; }) };
				persist();
			}));
			attackSection.append(row);
		}
		form.append(attackSection, validation, submit);
		form.addEventListener('submit', function (event) { event.preventDefault(); if (form.reportValidity() && check()) void run(function () { return options.launch(draft); }); });
		root.append(form); check();
	};
	return { root, render, dispose: function (): void { root.remove(); } };
};
