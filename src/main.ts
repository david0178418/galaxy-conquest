import { createPerformanceDiagnostics, type PerformanceDiagnostics, type DiagnosticsReport } from './performance-diagnostics';
import { createCrowdedBaseline } from './performance-scenario';
import { createPixiRenderer } from './pixi-renderer';
import { createMapInput } from './map-input';
import { createOrdersDrawer } from './orders-drawer';
import { zoomCamera } from './camera';
import type { Camera, Point } from './camera';
import { CONFIG, COLORS } from './config';
import { LAB_MAP } from './maps';
import type { StarMap } from './maps';
import { createFrontMenu } from './front-menu';
import type { DispatchFilter, Production, Scenario } from './config';
import { captureConquestSave } from './game-save';
import {
	createGame,
	dispatch,
	isBlockaded,
	planets,
	setProduction,
	shipsAt,
	units,
} from './game';
import type { Game } from './game';
import { openProfileRepository } from './profile-storage';
import type { ProfileRepository, ProfileSummary } from './profile-storage';
import { createCampaignView } from './campaign-ui';
import { createCampaign, commitCampaignRival, campaignWinner } from './campaign-scenario';
import { commitExpedition, commitFactionTurn, resolveCampaignTurn, applyCampaignEncounterResult } from './campaign-state';
import type { CampaignState } from './campaign-state';
import { createDefaultEncounterSetup } from './campaign-setup';
import type { CampaignEncounterSetup } from './campaign-setup';
import { createCampaignBattle } from './campaign-encounter';
import type { CampaignEncounterRuntime } from './campaign-encounter';
import { CAMPAIGN_SAVE_SCHEMA_VERSION } from './campaign-save';
import type { CampaignSave } from './campaign-save';

const element = function <T extends HTMLElement>(
	id: string,
	constructor: { new (...args: never[]): T },
): T {
	const found = document.getElementById(id);
	if (!(found instanceof constructor)) throw new Error(`Missing ${id}`);
	return found;
};
const board = element('board', HTMLElement);
const app = element('app', HTMLDivElement);
const mapWorld = element('map-world', HTMLDivElement);
const planetPanel = element('planet-panel', HTMLElement);
const productionControls = element('production-controls', HTMLDivElement);
const dispatchControls = element('dispatch-controls', HTMLDivElement);
const dispatchFilterControls = element(
	'dispatch-filter-controls',
	HTMLDivElement,
);
const dispatchInfo = element('dispatch-info', HTMLSpanElement);
const canvas = element('space', HTMLCanvasElement);
const planetLayer = element('planets', HTMLDivElement);
const pause = element('pause', HTMLButtonElement);
const scenarioSelect = element('scenario', HTMLSelectElement);
const aiInput = element('ai', HTMLInputElement);
const speedSelect = element('speed', HTMLSelectElement);
const instruction = element('instruction', HTMLSpanElement);
const selectionName = element('selection-name', HTMLHeadingElement);
const selectionInfo = element('selection-info', HTMLParagraphElement);
const orbitalInfo = element('orbital-info', HTMLParagraphElement);
const productionInfo = element('production-info', HTMLSpanElement);
const banner = element('banner', HTMLDivElement);
const events = element('events', HTMLDivElement);
const metrics = element('metrics', HTMLDivElement);
const blueCount = element('blue-count', HTMLElement);
const redCount = element('red-count', HTMLElement);
const clock = element('clock', HTMLDivElement);
const multiButton = element('multi', HTMLButtonElement);
const saveGameButton = element('save-game', HTMLButtonElement);
const saveStatus = element('save-status', HTMLSpanElement);
const menuSaveStatus = element('save-status-menu', HTMLParagraphElement);
const campaignReturn = document.createElement('button');
campaignReturn.id = 'campaign-return';
campaignReturn.textContent = 'Return to galaxy';
campaignReturn.hidden = true;
const bannerMessage = document.createElement('span');
banner.replaceChildren(bannerMessage, campaignReturn);
const productionButtons = [
	...document.querySelectorAll<HTMLButtonElement>('[data-production]'),
];
const amountButtons = [
	...document.querySelectorAll<HTMLButtonElement>('[data-amount]'),
];
const filterButtons = [
	...document.querySelectorAll<HTMLButtonElement>('[data-filter]'),
];
interface PlanetView {
	button: HTMLButtonElement;
	count: HTMLSpanElement;
	orbit: HTMLSpanElement;
	mark: HTMLSpanElement;
	progress: HTMLElement;
}
type GamePace = 0.5 | 1 | 2;
interface GameInstallation {
	game: Game;
	map: StarMap;
	scenario: Scenario;
	profileId: string;
	pace: GamePace;
	paused: boolean;
	hiddenPause: boolean;
	savedAt: number;
	campaign?: { save: CampaignSave; runtime: CampaignEncounterRuntime };
}
const views = new Map<number, PlanetView>();
let activeMap: StarMap = LAB_MAP;
let profileRepository: ProfileRepository | undefined;
let initialProfiles: ProfileSummary[] = [];
let activeProfileId: string | null = null;
let profileStorageMessage: string | null = null;
let hasActiveConquest = false;
let queuedAutosave: number | undefined;
let campaignSession: CampaignSave | undefined;
let campaignRuntime: CampaignEncounterRuntime | undefined;
const campaignPreviewEnabled = new URLSearchParams(location.search).get('campaign') === '1';
try {
	profileRepository = await openProfileRepository();
	initialProfiles = await profileRepository.listProfiles();
	const storedSelection = await profileRepository.getSelectedProfileId();
	activeProfileId = initialProfiles.some(function (profile) {
		return profile.id === storedSelection;
	})
		? storedSelection
		: (initialProfiles[0]?.id ?? null);
	if (activeProfileId !== storedSelection)
		await profileRepository.setSelectedProfileId(activeProfileId);
} catch (error) {
	profileRepository?.close();
	profileRepository = undefined;
	profileStorageMessage = error instanceof Error
		? error.message
		: 'Browser storage could not open. Open the standalone game to use local profiles.';
}
let world: Game = await createGame();
let diagnostics: PerformanceDiagnostics | undefined;
let diagnosticsEnabled = new URLSearchParams(location.search).get('diagnostics') === '1';
let selected: number[] = [];
let inspected: number | undefined;
let fraction = 0.5;
let filter: DispatchFilter = 'combined';
let multi = false;
let scenario: Scenario = 'skirmish';
let speed: GamePace = 1;
let busy = false;
let disposed = false;
let raf = 0;
let noticeUntil = 0;
let orderMessage = '';
let lastNoticeKey = '';
let hiddenPause = false;
const icons: Record<Production, string> = {
	troops: '▥',
	ships: '◆',
	guns: '✣',
};
const timeLabel = function (seconds: number): string {
	return `${Math.floor(seconds / 60)
		.toString()
		.padStart(2, '0')}:${Math.floor(seconds % 60)
		.toString()
		.padStart(2, '0')}`;
};
const feedback = function (text: string): void {
	orderMessage = text;
	noticeUntil = performance.now() + 2600;
};
const saveErrorMessage = function (error: unknown): string {
	const message =
		error instanceof Error
			? error.message
			: 'Browser storage could not complete the request.';
	return window.top !== window.self
		? `${message} Open the standalone game to use local saves.`
		: message;
};
const updateSaveStatus = function (message: string): void {
	saveStatus.textContent = message;
	menuSaveStatus.textContent = message;
};
const savedStatus = function (savedAt: number): string {
	return `Saved ${new Date(savedAt).toLocaleString()}`;
};
const sameMap = function (left: StarMap, right: StarMap): boolean {
	return (
		left.width === right.width &&
		left.height === right.height &&
		left.planets.length === right.planets.length &&
		left.planets.every(function (planet, index) {
			const match = right.planets[index];
			return (
				match !== undefined &&
				planet.every(function (value, field) {
					return value === match[field];
				})
			);
		})
	);
};
const saveCurrentProfile = async function (): Promise<void> {
	if (!hasActiveConquest) return;
	if (!profileRepository || activeProfileId === null)
		throw new Error('Select a local profile before saving this conquest.');
	const profileId = activeProfileId;
	if (campaignSession) {
		const session = campaignSession;
		const encounterState = session.encounterState;
		const save: CampaignSave = { ...session, savedAt: Date.now(),
			...(encounterState?.phase === 'battle' && campaignRuntime ? { encounterState: {
				...encounterState, game: captureConquestSave(world, activeMap, 'skirmish', speed, profileId).game,
				captureEvents: campaignRuntime.getCaptureEvents(),
			} } : {}),
		};
		try {
			await profileRepository.saveCampaign(save);
			if (campaignSession === session) campaignSession = save;
			updateSaveStatus(savedStatus(save.savedAt));
		} catch (error) { updateSaveStatus(`Save failed · ${saveErrorMessage(error)}`); throw error; }
		return;
	}
	const capture = function (): ReturnType<typeof captureConquestSave> { return captureConquestSave(
		world,
		activeMap,
		scenario,
		speed,
		profileId,
	); };
	const save = diagnostics ? diagnostics.measure('save.capture', capture) : capture();
	updateSaveStatus('Saving…');
	try {
		// Async saveProfile validates/clones synchronously before its first await.
		const repository = profileRepository;
		const write = function (): Promise<void> { return repository.saveProfile(save); };
		await (diagnostics ? diagnostics.measure('save.validateCloneSync', write) : write());
		if (activeProfileId === profileId) updateSaveStatus(savedStatus(save.savedAt));
	} catch (error) {
		const message = saveErrorMessage(error);
		updateSaveStatus(`Save failed · ${message}`);
		feedback(`Save failed: ${message}`);
		throw error;
	}
};
const queueAutosave = function (): void {
	if (busy || !hasActiveConquest || frontMenu.getCurrentScreen() !== 'playing') return;
	if (queuedAutosave !== undefined) window.clearTimeout(queuedAutosave);
	queuedAutosave = window.setTimeout(function () {
		queuedAutosave = undefined;
		if (busy) return;
		void saveCurrentProfile().catch(function () {});
	}, 800);
};
const saveBeforeLeavingGame = async function (): Promise<boolean> {
	if (busy) return false;
	busy = true;
	app.inert = true;
	if (queuedAutosave !== undefined) {
		window.clearTimeout(queuedAutosave);
		queuedAutosave = undefined;
	}
	const match = world.getResource('match');
	const wasPaused = match.paused;
	mapInput.cancel();
	match.paused = true;
	try {
		await saveCurrentProfile();
		return true;
	} catch {
		match.paused = wasPaused;
		refresh();
		return false;
	} finally {
		busy = false;
		app.inert = false;
	}
};
const selectPlanet = function (id: number): void {
	if (
		busy ||
		frontMenu.getCurrentScreen() !== 'playing' ||
		world.getResource('match').winner
	)
		return;
	const p = world.getComponent(id, 'planet');
	if (!p) return;
	const selectable =
		p.owner === 'blue' || shipsAt(world, id, 'blue').length > 0;
	if (selected.includes(id)) {
		selected = selected.filter(function (value) {
			return value !== id;
		});
		inspected = undefined;
	} else if (multi) {
		if (selectable) selected = [...selected, id];
		else feedback('Finish source selection before choosing a destination.');
	} else {
		selected = selectable ? [id] : [];
		inspected = p.owner === 'blue' ? undefined : id;
	}
	refresh();
};
const sendToPlanet = function (id: number): void {
	if (
		busy ||
		frontMenu.getCurrentScreen() !== 'playing' ||
		world.getResource('match').winner
	)
		return;
	const p = world.getComponent(id, 'planet');
	if (!p) return;
	if (multi) feedback('Finish source selection before sending units.');
	else if (selected.length === 0)
		feedback('Select a blue planet or orbital ring first.');
	else {
		const shipsOnly = selected.every(function (source) {
			return world.getComponent(source, 'planet')?.owner !== 'blue';
		});
		const sent = dispatch(
			world,
			selected,
			id,
			fraction,
			shipsOnly ? 'ships' : filter,
		);
		feedback(
			sent > 0
				? `${sent} ${sent === 1 ? 'unit' : 'units'} launched → ${p.name}`
				: 'No units launched. Check stock, filter, or blockade.',
		);
		if (sent > 0) queueAutosave();
	}
	refresh();
};
const mountPlanets = function (): void {
	planetLayer.replaceChildren();
	views.clear();
	for (const {
		id,
		components: { planet: p },
	} of planets(world)) {
		const button = document.createElement('button');
		button.className = 'planet';
		button.dataset.planet = p.name;
		button.style.left = `${p.x}px`;
		button.style.top = `${p.y}px`;
		button.innerHTML =
			'<span class="surface"></span><span class="count"></span><span class="name"></span><span class="orbit-count"></span><span class="production-mark"></span><span class="production-progress"><i></i></span>';
		const count = button.querySelector('.count');
		const name = button.querySelector('.name');
		const orbit = button.querySelector('.orbit-count');
		const mark = button.querySelector('.production-mark');
		const progress = button.querySelector('i');
		if (
			!(count instanceof HTMLSpanElement) ||
			!(name instanceof HTMLSpanElement) ||
			!(orbit instanceof HTMLSpanElement) ||
			!(mark instanceof HTMLSpanElement) ||
			!(progress instanceof HTMLElement)
		)
			throw new Error('Planet template incomplete');
		name.textContent = p.name;
		planetLayer.append(button);
		views.set(id, { button, count, orbit, mark, progress });
	}
};
const refresh = function (): void {
	if (diagnostics) diagnostics.measure('hud', refreshContent);
	else refreshContent();
};
const refreshContent = function (): void {
	const match = world.getResource('match');
	const all = planets(world);
	selected = selected.filter(function (id) {
		return (
			world.getComponent(id, 'planet')?.owner === 'blue' ||
			shipsAt(world, id, 'blue').length > 0
		);
	});
	if (
		selected.length === 0 &&
		inspected !== undefined &&
		shipsAt(world, inspected, 'blue').length > 0 &&
		!multi
	)
		selected = [inspected];
	for (const {
		id,
		components: { planet: p },
	} of all) {
		const view = views.get(id);
		if (!view) continue;
		const blue = shipsAt(world, id, 'blue').length;
		const red = shipsAt(world, id, 'red').length;
		const guns = Math.ceil(p.guns);
		const blocked = isBlockaded(world, id);
		const hitSize = Math.max(54, (p.radius + 32) * 2);
		view.button.style.width = `${hitSize}px`;
		view.button.style.height = `${hitSize}px`;
		view.button.style.setProperty('--owner', COLORS[p.owner]);
		view.button.style.setProperty('--diameter', `${p.radius * 2}px`);
		const highlighted = selected.includes(id) || inspected === id;
		view.button.classList.toggle('selected', highlighted);
		view.button.setAttribute('aria-pressed', String(highlighted));
		view.button.setAttribute(
			'aria-label',
			`${p.name}, ${p.owner === 'blue' ? 'your' : p.owner === 'red' ? 'rival' : 'neutral'} planet, ${p.troops} troops, ${blue} your ships, ${red} rival ships, ${guns} defense platforms${blocked ? ', blockaded' : ''}`,
		);
		view.count.textContent = String(p.troops);
		view.orbit.replaceChildren();
		for (const [side, count] of [
			['blue', blue],
			['red', red],
		] as const) {
			if (count === 0) continue;
			const span = document.createElement('span');
			span.style.color = COLORS[side];
			span.textContent = `◆${count} `;
			view.orbit.append(span);
		}
		if (guns > 0) view.orbit.append(`✣${guns}`);
		view.mark.textContent = p.owner === 'neutral' ? '' : icons[p.production];
		view.progress.style.width = `${(p.progress / CONFIG.cost[p.production]) * 100}%`;
	}
	planetPanel.hidden = selected.length === 0 && inspected === undefined;
	dispatchControls.hidden = selected.length === 0;
	const ownedSelected = selected.flatMap(function (id) {
		const p = world.getComponent(id, 'planet');
		return p?.owner === 'blue' ? [p] : [];
	});
	productionControls.hidden = ownedSelected.length === 0;
	const shipsOnly = selected.length > 0 && ownedSelected.length === 0;
	dispatchFilterControls.hidden = shipsOnly;
	dispatchInfo.textContent = shipsOnly
		? 'orbiting ships only'
		: 'defense platforms stay behind';
	const first = selected[0] ?? inspected;
	const p =
		first === undefined ? undefined : world.getComponent(first, 'planet');
	selectionName.textContent =
		selected.length > 1
			? `${selected.length} sources selected`
			: p
				? p.name
				: 'No source selected';
	selectionInfo.textContent =
		selected.length === 0 || (selected.length === 1 && p?.owner !== 'blue')
			? p
				? `${p.owner === 'blue' ? 'Your' : p.owner === 'red' ? 'Rival' : 'Neutral'} world · ${p.troops} troops · ${first === undefined ? 0 : shipsAt(world, first, 'red').length} rival ships · ${Math.ceil(p.guns)} defense platforms`
				: 'Tap or left-click a blue planet to select.'
			: `${ownedSelected.reduce(function (sum, p) {
					return sum + p.troops;
				}, 0)} troops · ${selected.reduce(function (sum, id) {
					return sum + shipsAt(world, id, 'blue').length;
				}, 0)} ships · ${Math.ceil(
					ownedSelected.reduce(function (sum, p) {
						return sum + p.guns;
					}, 0),
				)} defense platforms${p && p.owner !== 'blue' ? ' · orbit only' : ''}`;
	orbitalInfo.hidden = !(selected.length === 1 && shipsOnly);
	orbitalInfo.textContent =
		first === undefined
			? ''
			: `${shipsAt(world, first, 'blue').length} your orbiting ships · hold or right-click a destination to send`;
	productionInfo.textContent =
		p && p.owner === 'blue' && selected.length === 1
			? `${(p.rate * CONFIG.productionRateMultiplier).toFixed(1)} work / sec`
			: 'on selected worlds';
	for (const button of productionButtons) {
		button.disabled = ownedSelected.length === 0 || Boolean(match.winner);
		button.setAttribute(
			'aria-pressed',
			String(
				ownedSelected.length > 0 &&
					ownedSelected.every(function (p) {
						return p.production === button.dataset.production;
					}),
			),
		);
	}
	instruction.textContent = multi
		? 'Tap or left-click sources · finish selection to send'
		: selected.length
			? 'Hold or right-click a destination to send'
			: 'Select a blue planet or orbital ring';
	multiButton.setAttribute('aria-pressed', String(multi));
	multiButton.textContent = multi ? '✓ Finish selection' : '＋ Multi-select';
	blueCount.textContent = String(
		all.filter(function (e) {
			return e.components.planet.owner === 'blue';
		}).length,
	);
	redCount.textContent = String(
		all.filter(function (e) {
			return e.components.planet.owner === 'red';
		}).length,
	);
	clock.textContent = timeLabel(match.time);
	pause.textContent = match.paused ? '▷' : 'Ⅱ';
	pause.setAttribute('aria-label', match.paused ? 'Resume game' : 'Pause game');
	pause.setAttribute('aria-pressed', String(match.paused));
	pause.title = match.paused
		? 'Resume game'
		: 'Pause action to issue orders and change production';
	const result = match.winner
		? campaignSession
			? `${match.winner === 'blue' ? 'Encounter won' : 'Encounter lost'} · Return to the galaxy to resolve the turn.`
			: match.winner === 'blue'
			? 'All rival worlds captured. You win. Restart to play again.'
			: 'Your last world has fallen. Restart to try again.'
		: '';
	bannerMessage.textContent =
		result ||
		(performance.now() < noticeUntil
			? orderMessage
			: match.paused
				? 'Paused · commands remain available'
				: '');
	banner.style.display = bannerMessage.textContent ? 'block' : 'none';
	campaignReturn.hidden = !campaignSession || !match.winner;
	const key = match.notices
		.map(function (n) {
			return `${n.time}:${n.text}`;
		})
		.join('|');
	if (key !== lastNoticeKey) {
		lastNoticeKey = key;
		events.replaceChildren(
			...match.notices.slice(0, 3).map(function (n) {
				const row = document.createElement('p');
				row.style.borderColor = COLORS[n.side];
				row.textContent = `${timeLabel(n.time)} ${n.text}`;
				return row;
			}),
		);
	}
	metrics.textContent = `First capture: ${match.firstCapture === null ? '—' : `${match.firstCapture.toFixed(1)}s`} · Orders: ${match.orders} · Captures: ${match.captures} · Transports lost: ${match.transportsLost} (${match.troopsLost} troops, both sides)`;
	aiInput.checked = match.ai;
	drawer.update(
		world,
		selected.length > 0 ? selected : inspected === undefined ? [] : [inspected],
	);
};

const ordersPanel = element('orders-drawer', HTMLElement);
const drawer = createOrdersDrawer(
	{
		toggle: element('orders-toggle', HTMLButtonElement),
		panel: ordersPanel,
		close: element('close-orders', HTMLButtonElement),
		title: element('orders-title', HTMLHeadingElement),
		showAll: element('show-all-orders', HTMLButtonElement),
		list: element('orders-list', HTMLUListElement),
		empty: element('orders-empty', HTMLParagraphElement),
	},
	function () {
		fieldGuide.hidden = true;
		settings.setAttribute('aria-expanded', 'false');
		settings.setAttribute('aria-label', 'Open game menu');
	},
	function (message) {
		feedback(message);
		queueAutosave();
		refresh();
	},
);

// The simulation and both render layers share one world-space transform.
let camera: Camera = { x: 0, y: 0, scale: 1 };
let fitScale = 1;
const applyCamera = function (): void {
	mapWorld.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
};
const fitMap = function (): void {
	const width = board.clientWidth;
	const height = board.clientHeight;
	if (width === 0 || height === 0) return;
	const top = width < 700 ? 200 : 130;
	const bottom = 85;
	fitScale = Math.max(
		0.1,
		Math.min(
			(width - 48) / activeMap.width,
			(height - top - bottom) / activeMap.height,
		),
	);
	camera = {
		x: (width - activeMap.width * fitScale) / 2,
		y: top + (height - top - bottom - activeMap.height * fitScale) / 2,
		scale: fitScale,
	};
	applyCamera();
};
const zoomAt = function (anchor: Point, factor: number): void {
	camera = zoomCamera(camera, anchor, factor, fitScale * 0.5, fitScale * 5);
	applyCamera();
};
const mapInput = createMapInput({
	board,
	events: window,
	getPlanetId: function (target): number | undefined {
		const button =
			target instanceof Element ? target.closest('button.planet') : null;
		return [...views].find(function ([, view]) {
			return view.button === button;
		})?.[0];
	},
	selectPlanet,
	dispatchPlanet: sendToPlanet,
	panBy: function (delta): void {
		camera = { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
		applyCamera();
	},
	zoomAt,
});
const renderer = await createPixiRenderer({
	getViewport: function () { return { width: board.clientWidth, height: board.clientHeight }; },
	canvas,
	getPixelRatio: function (): number {
		return devicePixelRatio;
	},
	getState: function () {
		return {
			world,
			map: activeMap,
			camera,
			fitScale,
			highlighted: drawer.highlighted(),
		};
	},
});
const resizeObserver = new ResizeObserver(fitMap);
resizeObserver.observe(board);
const fieldGuide = element('field-guide', HTMLElement);
const settings = element('settings', HTMLButtonElement);
const toggleGuide = function (): void {
	if (fieldGuide.hidden && !ordersPanel.hidden) drawer.close();
	fieldGuide.hidden = !fieldGuide.hidden;
	settings.setAttribute('aria-expanded', String(!fieldGuide.hidden));
	settings.setAttribute(
		'aria-label',
		fieldGuide.hidden ? 'Open game menu' : 'Close game menu',
	);
	if (fieldGuide.hidden) settings.focus();
	else element('close-guide', HTMLButtonElement).focus();
};
settings.addEventListener('click', toggleGuide);
element('close-guide', HTMLButtonElement).addEventListener(
	'click',
	toggleGuide,
);

const helpDialog = element('help-dialog', HTMLDialogElement);
const howToPlay = element('how-to-play', HTMLButtonElement);
// The title and in-game menu share one authored set of instructions.
element('title-instructions', HTMLElement).replaceChildren(
	...Array.from(element('play-instructions', HTMLElement).children, function (node) {
		return node.cloneNode(true);
	}),
);
howToPlay.addEventListener('click', function () {
	helpDialog.showModal();
	helpDialog.scrollTop = 0;
});
element('close-help', HTMLButtonElement).addEventListener('click', function () {
	helpDialog.close();
});
helpDialog.addEventListener('close', function () {
	howToPlay.focus();
});

const fullscreenButtons = [
	element('fullscreen', HTMLButtonElement),
	element('title-fullscreen', HTMLButtonElement),
];
const titleFullscreenStatus = element('title-fullscreen-status', HTMLElement);
let fullscreenPending = false;
const syncFullscreen = function (): void {
	const active = Boolean(document.fullscreenElement);
	const label = active ? 'Exit fullscreen' : 'Enter fullscreen';
	for (const button of fullscreenButtons) {
		button.setAttribute('aria-pressed', String(active));
		button.setAttribute('aria-label', label);
		button.innerHTML = `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">${active
			? '<path d="M5 16h3v3h2v-5H5v2zm3-8H5V5h5v2H7v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>'
			: '<path d="M5 14h2v3h3v2H5v-5zm2-4H5V5h5v2H7v3zm7 7h3v-3h2v5h-5v-2zm3-7V7h-3V5h5v5h-2z"/>'}</svg>`;
		button.disabled = fullscreenPending || !document.fullscreenEnabled;
		button.title = document.fullscreenEnabled
			? label
			: 'Fullscreen unavailable in this browser';
	}
};
const toggleFullscreen = async function (): Promise<void> {
	if (fullscreenPending) return;
	fullscreenPending = true;
	titleFullscreenStatus.textContent = '';
	syncFullscreen();
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
		else await document.documentElement.requestFullscreen();
	} catch {
		const message = 'Fullscreen could not change. Check browser permissions.';
		if (app.hidden) titleFullscreenStatus.textContent = message;
		else {
			feedback(message);
			refresh();
		}
	} finally {
		fullscreenPending = false;
		syncFullscreen();
	}
};
for (const button of fullscreenButtons)
	button.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreen);
syncFullscreen();

const installGame = async function (
	installation: GameInstallation,
): Promise<void> {
	if (disposed) {
		await installation.game.dispose();
		return;
	}
	mapInput.cancel();
	const previousWorld = world;
	renderer.reset();
	diagnostics?.dispose();
	diagnostics = undefined;
	world = installation.game;
	campaignSession = installation.campaign?.save;
	campaignRuntime = installation.campaign?.runtime;
	attachDiagnostics();
	try {
		world.getResource('match').paused = installation.paused;
		activeProfileId = installation.profileId;
		activeMap = installation.map;
		mapWorld.style.width = `${activeMap.width}px`;
		mapWorld.style.height = `${activeMap.height}px`;
		hiddenPause = installation.hiddenPause;
		hasActiveConquest = true;
		scenario = installation.scenario;
		speed = installation.pace;
		speedSelect.value = String(speed);
		scenarioSelect.value = activeMap === LAB_MAP ? scenario : 'generated';
		selected = [];
		inspected = undefined;
		multi = false;
		drawer.reset();
		noticeUntil = 0;
		lastNoticeKey = '';
		fitMap();
		mountPlanets();
		refresh();
		updateSaveStatus(savedStatus(installation.savedAt));
		saveGameButton.disabled = false;
		for (const control of [scenarioSelect, aiInput, element('restart', HTMLButtonElement), element('setup-game', HTMLButtonElement)])
			control.disabled = Boolean(campaignSession);
	} finally {
		await previousWorld.dispose();
	}
};

const restart = async function (
	next: Scenario = scenario,
	map: StarMap = activeMap,
	replacementConfirmed = false,
): Promise<void> {
	if (busy) return;
	busy = true;
	app.inert = true;
	if (queuedAutosave !== undefined) {
		window.clearTimeout(queuedAutosave);
		queuedAutosave = undefined;
	}
	mapInput.cancel();
	let replacement: Game | undefined;
	try {
		if (hasActiveConquest && !replacementConfirmed) {
			if (!profileRepository || activeProfileId === null)
				throw new Error('Select a local profile before replacing this conquest.');
			const profiles = await profileRepository.listProfiles();
			const profile = profiles.find(function (candidate) {
				return candidate.id === activeProfileId;
			});
			if (!profile) throw new Error('The active profile is no longer available.');
			if (
				!window.confirm(
					`Restarting will replace ${profile.name}'s active conquest with a new one. Continue?`,
				)
			) {
				scenarioSelect.value = activeMap === LAB_MAP ? scenario : 'generated';
				return;
			}
		}
		replacement = await createGame(next, map);
		replacement.getResource('match').paused = document.hidden;
		const profileId = activeProfileId;
		if (!profileRepository || profileId === null)
			throw new Error('Local profile storage is unavailable. The previous conquest was kept.');
		const nextSave = captureConquestSave(
			replacement,
			map,
			next,
			speed,
			profileId,
		);
		try {
			await profileRepository.saveProfile(nextSave);
		} catch (error) {
			const message = saveErrorMessage(error);
			updateSaveStatus(`Save failed · ${message}`);
			throw new Error(
				`The new conquest could not be saved. The previous game and save were kept. ${message}`,
				{ cause: error },
			);
		}
		const gameToInstall = replacement;
		replacement = undefined;
		await installGame({
			game: gameToInstall,
			map,
			scenario: next,
			profileId,
			pace: speed,
			paused: document.hidden,
			hiddenPause: document.hidden,
			savedAt: nextSave.savedAt,
		});
	} catch (error) {
		if (replacement) await replacement.dispose();
		throw error;
	} finally {
		busy = false;
		app.inert = false;
	}
};
for (const button of productionButtons)
	button.addEventListener('click', function () {
		const value = button.dataset.production;
		if (value === 'troops' || value === 'ships' || value === 'guns') {
			setProduction(world, selected, value);
			queueAutosave();
		}
		refresh();
	});
for (const button of amountButtons)
	button.addEventListener('click', function () {
		const value = Number(button.dataset.amount);
		if (![0.25, 0.5, 1].includes(value)) return;
		fraction = value;
		for (const item of amountButtons)
			item.setAttribute('aria-pressed', String(item === button));
	});
for (const button of filterButtons)
	button.addEventListener('click', function () {
		const value = button.dataset.filter;
		if (value !== 'combined' && value !== 'ships' && value !== 'troops') return;
		filter = value;
		for (const item of filterButtons)
			item.setAttribute('aria-pressed', String(item === button));
	});
multiButton.addEventListener('click', function () {
	multi = !multi;
	refresh();
});
element('clear', HTMLButtonElement).addEventListener('click', function () {
	selected = [];
	inspected = undefined;
	multi = false;
	refresh();
});
pause.addEventListener('click', function () {
	const match = world.getResource('match');
	match.paused = !match.paused;
	queueAutosave();
	refresh();
});
element('restart', HTMLButtonElement).addEventListener('click', function () {
	void restart().catch(function (error) {
		feedback(saveErrorMessage(error));
	});
});
scenarioSelect.addEventListener('change', function () {
	const next = scenarioSelect.value;
	if (next === 'skirmish' || next === 'blockade' || next === 'invasion')
		void restart(next, LAB_MAP).catch(function (error) {
			feedback(saveErrorMessage(error));
		});
});
speedSelect.addEventListener('change', function () {
	const nextSpeed = Number(speedSelect.value);
	if (nextSpeed !== 0.5 && nextSpeed !== 1 && nextSpeed !== 2) return;
	speed = nextSpeed;
	queueAutosave();
});
aiInput.addEventListener('change', function () {
	world.getResource('match').ai = aiInput.checked;
	queueAutosave();
});
let previous = performance.now();
let lastRefresh = 0;
const frame = function (now: number): void {
	if (disposed) return;
	const dt = Math.min(Math.max((now - previous) / 1000, 0), 0.1);
	previous = now;
	diagnostics?.frame(now);
	if (!busy && frontMenu.getCurrentScreen() === 'playing') {
		// Keep rendering and command input live while simulation time is frozen.
		if (!world.getResource('match').paused) {
			if (diagnostics) diagnostics.measure('simulation', function () { world.update(dt * speed); });
			else world.update(dt * speed);
		}
		if (diagnostics) diagnostics.measure('draw', function () { renderer.draw(); });
		else renderer.draw();
		if (now - lastRefresh > 100) {
			refresh();
			lastRefresh = now;
		}
	}
	raf = requestAnimationFrame(frame);
};
world.getResource('match').paused = true;
saveGameButton.disabled = true;
const continueProfile = async function (profileId: string): Promise<void> {
	if (!profileRepository) throw new Error('IndexedDB local storage is unavailable.');
	const save = await profileRepository.loadSave(profileId);
	if (!save) throw new Error('This profile has no saved conquest to continue.');
	let replacement: Game | undefined;
	try {
		replacement = await createGame(
			save.game.scenario,
			save.game.map,
			save.game,
		);
		replacement.getResource('match').paused = true;
		const restoredMap = sameMap(save.game.map, LAB_MAP)
			? LAB_MAP
			: structuredClone(save.game.map);
		const gameToInstall = replacement;
		replacement = undefined;
		await installGame({
			game: gameToInstall,
			map: restoredMap,
			scenario: save.game.scenario,
			profileId,
			pace: save.game.pace,
			paused: true,
			hiddenPause: false,
			savedAt: save.savedAt,
		});
	} catch (error) {
		if (replacement) await replacement.dispose();
		throw error;
	}
};
const campaignSaveForState = function (state: CampaignState, profileId: string): CampaignSave {
	return { schemaVersion: CAMPAIGN_SAVE_SCHEMA_VERSION, mode: 'campaign', profileId, savedAt: Date.now(), campaign: state,
		...(state.encounter ? { encounterState: { phase: 'allocation' as const, encounterId: state.encounter.id, setup: createDefaultEncounterSetup(state.encounter) } } : {}),
	};
};
const persistCampaign = async function (save: CampaignSave): Promise<void> {
	if (!profileRepository) throw new Error('Local profile storage is unavailable.');
	await profileRepository.saveCampaign(save);
	campaignSession = save;
	activeProfileId = save.profileId;
	hasActiveConquest = true;
};
const renderCampaign = function (): void {
	if (!campaignSession) return;
	campaignView.render(campaignSession.campaign, campaignSession.encounterState?.setup);
};
const enterCampaignBattle = async function (setup: CampaignEncounterSetup): Promise<void> {
	const session = campaignSession;
	if (!session || !profileRepository) throw new Error('No campaign is active.');
	const resumed = session.encounterState?.phase === 'battle' ? session.encounterState : undefined;
	const battle = await createCampaignBattle(session.campaign, setup, resumed?.game, resumed?.captureEvents);
	let installed = false;
	try {
		battle.world.getResource('match').paused = resumed ? true : document.hidden;
		const pace = resumed?.game.pace ?? 1;
		const snapshot = captureConquestSave(battle.world, battle.map, 'skirmish', pace, session.profileId).game;
		const encounter = session.campaign.encounter;
		if (!encounter) throw new Error('No encounter is active.');
		const save: CampaignSave = { ...session, savedAt: Date.now(), encounterState: { phase: 'battle', encounterId: encounter.id, setup,
			game: snapshot, captureEvents: battle.runtime.getCaptureEvents() } };
		await profileRepository.saveCampaign(save);
		await installGame({ game: battle.world, map: battle.map, scenario: 'skirmish', profileId: session.profileId, pace,
			paused: snapshot.match.paused, hiddenPause: document.hidden, savedAt: save.savedAt, campaign: { save, runtime: battle.runtime } });
		installed = true;
		await frontMenu.setScreen('playing', {});
	} finally { if (!installed) await battle.world.dispose(); }
};
const campaignView = createCampaignView({
	order: async function (order) {
		if (!campaignSession) return;
		const state = commitExpedition(campaignSession.campaign, { ...order, id: crypto.randomUUID(), factionId: 'blue' });
		await persistCampaign(campaignSaveForState(state, campaignSession.profileId));
		renderCampaign();
	},
	endTurn: async function () {
		if (!campaignSession || campaignWinner(campaignSession.campaign)) return;
		const state = campaignSession.campaign;
		const committed = commitFactionTurn(commitFactionTurn(commitCampaignRival(state), 'red'), 'blue');
		const next = resolveCampaignTurn(committed, state.turn);
		await persistCampaign(campaignSaveForState(next, campaignSession.profileId));
		renderCampaign();
	},
	setup: async function (setup) {
		const session = campaignSession;
		if (!session?.campaign.encounter || session.encounterState?.phase !== 'allocation') return;
		await persistCampaign({ ...session, savedAt: Date.now(), encounterState: { phase: 'allocation', encounterId: session.campaign.encounter.id, setup } });
	},
	launch: enterCampaignBattle,
	exit: async function () { await saveCurrentProfile(); await frontMenu.setScreen('title', {}); },
});
campaignReturn.addEventListener('click', async function () {
	if (busy || !campaignSession || !campaignRuntime || !world.getResource('match').winner) return;
	busy = true; campaignReturn.disabled = true;
	try {
		const state = applyCampaignEncounterResult(campaignSession.campaign, campaignRuntime.getResult(world));
		await persistCampaign(campaignSaveForState(state, campaignSession.profileId));
		campaignRuntime = undefined;
		await frontMenu.setScreen('campaign', {});
	} catch (error) { feedback(saveErrorMessage(error)); }
	finally { busy = false; campaignReturn.disabled = false; }
});
const openCampaignSave = async function (save: CampaignSave): Promise<void> {
	campaignSession = save; campaignRuntime = undefined; hasActiveConquest = true; activeProfileId = save.profileId;
	if (save.encounterState?.phase === 'battle') await enterCampaignBattle(save.encounterState.setup);
	else {
		if (save.campaign.phase === 'resolving') {
			await persistCampaign(campaignSaveForState(resolveCampaignTurn(save.campaign, save.campaign.turn), save.profileId));
		} else if (save.campaign.encounter && !save.encounterState) {
			await persistCampaign(campaignSaveForState(save.campaign, save.profileId));
		}
		await frontMenu.setScreen('campaign', {});
	}
};
const frontMenu = await createFrontMenu({
	start: async function (map) {
		await restart('skirmish', map, true);
	},
	continue: continueProfile,
	campaign: campaignPreviewEnabled ? {
		start: async function (profileId): Promise<void> {
			const save = campaignSaveForState(createCampaign(), profileId);
			if (!profileRepository) throw new Error('Local profile storage is unavailable.');
			await profileRepository.saveCampaign(save);
			await openCampaignSave(save);
		},
		continue: async function (profileId): Promise<void> {
			if (!profileRepository) throw new Error('Local profile storage is unavailable.');
			const save = await profileRepository.loadCampaignSave(profileId);
			if (!save) throw new Error('This profile has no campaign to continue.');
			await openCampaignSave(save);
		},
	} : undefined,
	profiles: profileRepository,
	initialProfiles,
	initialSelectedProfileId: activeProfileId,
	storageMessage: profileStorageMessage,
	beforeProfileChange: async function () {
		await saveCurrentProfile();
	},
	onProfileChange: function (profileId) {
		activeProfileId = profileId;
		campaignSession = undefined;
		campaignRuntime = undefined;
		hasActiveConquest = false;
		updateSaveStatus(profileId ? 'No active conquest' : 'Not saved');
		saveGameButton.disabled = true;
	},
	onMenu: function () {
		campaignView.root.hidden = true;
		campaignReturn.hidden = true;
		mapInput.cancel();
		world.getResource('match').paused = true;
		hiddenPause = false;
	},
	onCampaign: function () {
		mapInput.cancel();
		world.getResource('match').paused = true;
		campaignReturn.hidden = true;
		campaignView.root.hidden = false;
		renderCampaign();
		campaignView.root.querySelector('button')?.focus();
	},
	onPlaying: function () {
		campaignView.root.hidden = true;
		fitMap();
		refresh();
		board.focus();
		void saveCurrentProfile().catch(function () {});
	},
});

const autosaveTimer = window.setInterval(function () {
	if (busy || frontMenu.getCurrentScreen() !== 'playing') return;
	void saveCurrentProfile().catch(function () {});
}, 15_000);
saveGameButton.addEventListener('click', function () {
	if (busy) return;
	void saveCurrentProfile().catch(function () {});
});
element('profiles-game', HTMLButtonElement).addEventListener('click', async function () {
	if (busy || !(await saveBeforeLeavingGame())) return;
	drawer.reset();
	fieldGuide.hidden = true;
	settings.setAttribute('aria-expanded', 'false');
	settings.setAttribute('aria-label', 'Open game menu');
	await frontMenu.setScreen('title', {});
});
element('setup-game', HTMLButtonElement).addEventListener('click', async function () {
	if (busy) return;
	if (!(await saveBeforeLeavingGame())) return;
	drawer.reset();
	fieldGuide.hidden = true;
	settings.setAttribute('aria-expanded', 'false');
	settings.setAttribute('aria-label', 'Open game menu');
	await frontMenu.setScreen('setup', {});
});
document.addEventListener('visibilitychange', function () {
	if (frontMenu.getCurrentScreen() !== 'playing') return;
	if (document.hidden) {
		mapInput.cancel();
		hiddenPause = !world.getResource('match').paused;
		world.getResource('match').paused = true;
	} else if (hiddenPause) {
		world.getResource('match').paused = false;
		hiddenPause = false;
	}
});
window.addEventListener('keydown', function (event) {
	if (frontMenu.getCurrentScreen() !== 'playing' || busy) return;
	if (event.key === 'Escape') {
		if (!ordersPanel.hidden) {
			drawer.close();
			return;
		}
		if (!fieldGuide.hidden) toggleGuide();
		selected = [];
		inspected = undefined;
		multi = false;
		refresh();
	}
	if (event.code === 'Space' && event.target === document.body) {
		event.preventDefault();
		pause.click();
	}
});
const attachDiagnostics = function (): void {
	if (!diagnosticsEnabled) return;
	diagnostics = createPerformanceDiagnostics(world, function () {
		const all = units(world);
		return { renderer: renderer.inspect(), scenario, map: activeMap, pace: speed, camera, simulationTime: world.getResource('match').time,
			ships: all.filter(function (entity) { return entity.components.unit.kind === 'ship'; }).length,
			transports: all.filter(function (entity) { return entity.components.unit.kind === 'transport'; }).length,
			screen: frontMenu.getCurrentScreen(), viewport: {
			width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
			userAgent: navigator.userAgent, paused: world.getResource('match').paused,
			visibility: document.visibilityState };
	});
	diagnostics.setEnabled(true);
};
// Developer API is exposed only with the explicit URL opt-in.
if (diagnosticsEnabled) {
	let baselineProfileId: string | undefined;
	const api = {
		enable: function (enabled: boolean): void {
			diagnosticsEnabled = enabled;
			diagnostics?.dispose(); diagnostics = undefined;
			attachDiagnostics();
		},
		report: function (): DiagnosticsReport | undefined { return diagnostics?.report(); },
		reset: function (): void { diagnostics?.reset(); },
		baseline: async function (): Promise<void> {
			if (disposed || busy || !profileRepository)
				throw new Error('Baseline requires idle local storage');
			if (!(await saveBeforeLeavingGame()))
				throw new Error('Current conquest could not be saved');
			busy = true;
			let replacement: Game | undefined;
			try {
				// Reuse this session's dedicated profile; preserve all existing conquests.
				if (!baselineProfileId) {
					const profile = await profileRepository.createProfile('Performance baseline v1');
					baselineProfileId = profile.id;
				}
				const snapshot = createCrowdedBaseline();
				replacement = await createGame(snapshot.scenario, snapshot.map, snapshot);
				const save = captureConquestSave(replacement, LAB_MAP, 'skirmish', 1, baselineProfileId);
				await profileRepository.saveProfile(save);
				await profileRepository.setSelectedProfileId(baselineProfileId);
				const game = replacement;
				replacement = undefined;
				await installGame({ game, map: LAB_MAP, scenario: 'skirmish',
					profileId: baselineProfileId, pace: 1, paused: false,
					hiddenPause: false, savedAt: save.savedAt });
				if (disposed) return;
				await frontMenu.setScreen('playing', {});
				world.getResource('match').paused = false;
				diagnostics?.reset();
			} finally {
				await replacement?.dispose();
				busy = false;
			}
		},
	};
	Object.defineProperty(window, 'conquestDiagnostics', { value: api, configurable: true });
	attachDiagnostics();
}
raf = requestAnimationFrame(frame);
window.addEventListener('pagehide', function (event) {
	if (event.persisted) return;
	disposed = true;
	diagnostics?.dispose();
	diagnostics = undefined;
	Reflect.deleteProperty(window, 'conquestDiagnostics');
	mapInput.dispose();
	void renderer.dispose();
	cancelAnimationFrame(raf);
	if (autosaveTimer !== undefined) window.clearInterval(autosaveTimer);
	if (queuedAutosave !== undefined) window.clearTimeout(queuedAutosave);
	resizeObserver.disconnect();
	void world.dispose();
	void frontMenu.dispose();
	campaignView.dispose();
	profileRepository?.close();
});
