import ECSpresso from 'ecspresso';
import { COLORS } from './config';
import {
	carrierSeeds,
	CARRIER_CREW,
	CARRIER_DOCKED_SHIPS,
	generateMap,
	isMapSize,
	MAP_SIZES,
} from './maps';
import type { MapSize, StarMap } from './maps';
import { createProfilePicker } from './profile-picker';
import type { ProfilePickerState } from './profile-picker';
import type { ProfileRepository, ProfileSummary } from './profile-storage';

const element = function <T extends HTMLElement>(
	id: string,
	constructor: { new (...args: never[]): T },
): T {
	const found = document.getElementById(id);
	if (!(found instanceof constructor)) throw new Error(`Missing ${id}`);
	return found;
};
const svgElement = function (
	tag: string,
	attributes: Readonly<Record<string, string | number>>,
): SVGElement {
	const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [name, value] of Object.entries(attributes))
		node.setAttribute(name, String(value));
	return node;
};
const freshMap = function (
	size: MapSize,
	carriersEnabled = false,
): StarMap {
	const seed = crypto.getRandomValues(new Uint32Array(1))[0];
	if (seed === undefined) throw new Error('Could not generate a map seed');
	const map = generateMap(size, seed);
	return carriersEnabled ? { ...map, carriers: true } : map;
};

const initialState = function (): Record<string, never> {
	return {};
};
const flowBuilder = ECSpresso.create().withScreens(function (screens) {
	return screens
		.add('title', { initialState })
		.add('setup', { initialState })
		.add('playing', { initialState });
});
type FrontMenu = ReturnType<typeof flowBuilder.build>;

export const createFrontMenu = async function (options: {
	start: (map: StarMap) => Promise<void>;
	continue: (profileId: string) => Promise<void>;
	profiles: ProfileRepository | undefined;
	initialProfiles: ProfileSummary[];
	initialSelectedProfileId: string | null;
	storageMessage: string | null;
	beforeProfileChange: () => Promise<void>;
	onProfileChange: (profileId: string | null) => void;
	onPlaying: () => void;
	onMenu: () => void;
}): Promise<FrontMenu> {
	const root = element('front-menu', HTMLDivElement);
	const title = element('title-screen', HTMLElement);
	const setup = element('setup', HTMLElement);
	const app = element('app', HTMLDivElement);
	const newGame = element('new-game', HTMLButtonElement);
	const start = element('start-conquest', HTMLButtonElement);
	const profileBadge = element('profile-badge', HTMLButtonElement);
	const profileBadgeName = element('profile-badge-name', HTMLElement);
	const profileBadgeOrb = element('profile-badge-orb', HTMLElement);
	const profileDialog = element('profile-dialog', HTMLDialogElement);
	const closeProfiles = element('close-profiles', HTMLButtonElement);
	const menuProfileStatus = element('menu-profile-status', HTMLParagraphElement);
	const profileDialogListeners = new AbortController();
	let restoreBadgeFocus = false;
	const closeProfileDialog = function (): void {
		if (!profileDialog.open) return;
		restoreBadgeFocus = true;
		profileDialog.close();
	};
	profileBadge.addEventListener(
		'click',
		function () {
			if (!profileDialog.open) profileDialog.showModal();
		},
		{ signal: profileDialogListeners.signal },
	);
	closeProfiles.addEventListener('click', closeProfileDialog, {
		signal: profileDialogListeners.signal,
	});
	const profileList = element('profile-list', HTMLDivElement);
	const profileCount = element('profile-count', HTMLSpanElement);
	const profileCreateForm = element('profile-create-form', HTMLFormElement);
	const profileName = element('profile-name', HTMLInputElement);
	const createProfileButton = element('create-profile', HTMLButtonElement);
	const continueButton = element('continue-conquest', HTMLButtonElement);
	const profileSaveTime = element('profile-save-time', HTMLSpanElement);
	const profileStatus = element('profile-status', HTMLParagraphElement);
	const status = element('setup-status', HTMLDivElement);
	const summary = element('summary', HTMLDivElement);
	const detail = element('size-detail', HTMLParagraphElement);
	const carrierToggle = element('carriers-toggle', HTMLInputElement);
	const preview = document.getElementById('map-preview');
	const stars = document.getElementById('stars');
	if (!(preview instanceof SVGElement) || !(stars instanceof SVGElement))
		throw new Error('Missing menu artwork');
	const sizeButtons = [
		...root.querySelectorAll<HTMLButtonElement>('[data-size]'),
	];
	let size: MapSize = 'medium';
	let carriersEnabled = false;
	carrierToggle.checked = carriersEnabled;
	let map = freshMap(size);
	let starting = false;
	let disposed = false;
	const flow = flowBuilder.build();
	const focusProfileBadge = function (): void {
		if (!restoreBadgeFocus || disposed || profileBadge.disabled) return;
		restoreBadgeFocus = false;
		profileBadge.focus();
	};
	const renderProfileControls = function (
		profileState: ProfilePickerState,
	): void {
		const selected = profileState.selectedProfile;
		const name = selected?.name ??
			(profileState.available ? 'Choose profile' : 'Storage unavailable');
		profileBadgeName.textContent = name;
		profileBadgeOrb.textContent = Array.from(name)[0]?.toUpperCase() ?? 'P';
		profileBadge.setAttribute(
			'aria-label',
			`Active profile: ${name}. Open profile selection`,
		);
		profileBadge.disabled = starting || profileState.busy;
		menuProfileStatus.textContent = profileStatus.textContent;
		focusProfileBadge();

		newGame.disabled =
			!profileState.available ||
			profileState.busy ||
			starting ||
			!selected;
		start.disabled = !profileState.available || !selected || starting;
		for (const button of sizeButtons) button.disabled = starting;
		carrierToggle.disabled = starting;
		element('reroll', HTMLButtonElement).disabled = starting;
		element('back', HTMLButtonElement).disabled = starting;
	};
	const profilePicker = createProfilePicker({
		elements: {
			list: profileList,
			count: profileCount,
			createForm: profileCreateForm,
			nameInput: profileName,
			createButton: createProfileButton,
			continueButton,
			saveTime: profileSaveTime,
			status: profileStatus,
		},
		profiles: options.profiles,
		initialProfiles: options.initialProfiles,
		initialSelectedProfileId: options.initialSelectedProfileId,
		storageMessage: options.storageMessage,
		beforeProfileChange: options.beforeProfileChange,
		onProfileChange: function (profileId) {
			options.onProfileChange(profileId);
			if (profileId !== null) closeProfileDialog();
		},
		continueProfile: async function (profileId) {
			await options.continue(profileId);
			if (disposed) return;
			await flow.setScreen('playing', {});
		},
		isStarting: function () {
			return starting;
		},
		setStarting: function (value) {
			starting = value;
		},
		onStateChange: renderProfileControls,
	});
	profileDialog.addEventListener(
		'close',
		function () {
			restoreBadgeFocus = true;
			focusProfileBadge();
		},
		{ signal: profileDialogListeners.signal },
	);
	const renderProfiles = function (): void {
		renderProfileControls(profilePicker.render());
	};
	const renderPreview = function (): void {
		const carriers = carrierSeeds(map);
		preview.setAttribute('viewBox', `0 0 ${map.width} ${map.height}`);
		preview.setAttribute(
			'aria-label',
			`Generated ${size} map with ${map.planets.length} worlds${carriers.length > 0 ? ' and one carrier per side' : ''}, one starting world per side`,
		);
		preview.replaceChildren();
		for (let i = 0; i < 100; i++)
			preview.append(
				svgElement('circle', {
					cx: (i * 137.57) % map.width,
					cy: (i * 83.37) % map.height,
					r: 1.8,
					fill: '#55758e',
					opacity: 0.6,
				}),
			);
		for (const [name, x, y, planetRadius, owner] of map.planets) {
			const radius = planetRadius;
			const node = svgElement('g', {});
			const label = svgElement('title', {});
			label.textContent = `${name} · ${owner === 'blue' ? 'You' : owner === 'red' ? 'Rival' : 'Neutral'}`;
			node.append(label);
			if (owner !== 'neutral')
				node.append(
					svgElement('circle', {
						cx: x,
						cy: y,
						r: radius + 27,
						fill: COLORS[owner],
						'fill-opacity': 0.07,
						stroke: COLORS[owner],
						'stroke-width': 3,
						'stroke-opacity': 0.6,
					}),
				);
			node.append(
				svgElement('circle', {
					cx: x,
					cy: y,
					r: radius,
					fill: COLORS[owner],
					'fill-opacity': owner === 'neutral' ? 0.6 : 1,
				}),
			);
			preview.append(node);
		}
		for (const [name, x, y, radius, owner] of carriers) {
			const node = svgElement('g', { class: 'carrier-marker' });
			const label = svgElement('title', {});
			label.textContent = `${name} · ${CARRIER_CREW} crew · ${CARRIER_DOCKED_SHIPS} docked ships`;
			node.append(label);
			node.append(
				svgElement('circle', {
					cx: x,
					cy: y,
					r: radius,
					fill: COLORS[owner],
					'fill-opacity': 0.16,
					stroke: COLORS[owner],
					'stroke-dasharray': '5 4',
					'stroke-width': 3,
				}),
				svgElement('polygon', {
					points: `${x},${y - 10} ${x + 10},${y} ${x},${y + 10} ${x - 10},${y}`,
					fill: COLORS[owner],
					stroke: '#e8f7ff',
					'stroke-width': 1.5,
				}),
			);
			preview.append(node);
		}
		const count = document.createElement('strong');
		count.textContent = `${map.planets.length} worlds`;
		const hasCarriers = carriers.length > 0;
		summary.replaceChildren(
			count,
			' · 1 rival',
			document.createElement('br'),
			hasCarriers ? 'One world and carrier per side' : 'One starting world per side',
		);
		detail.textContent = MAP_SIZES[size].detail;
		element('setup-title', HTMLHeadingElement).textContent = 'Choose your star system.';
		const intro = setup.querySelector('.intro');
		if (intro) intro.textContent = 'A new star map. The same objective: conquer every rival world.';
		start.textContent = 'Start conquest →';
		for (const button of sizeButtons) {
			const label = button.querySelector('small');
			if (label && isMapSize(button.dataset.size)) label.textContent = `${MAP_SIZES[button.dataset.size].count} worlds`;
		}
		for (const button of sizeButtons)
			button.setAttribute('aria-pressed', String(button.dataset.size === size));
	};
	for (let i = 0; i < 110; i++)
		stars.append(
			svgElement('circle', {
				cx: (i * 137.57) % 720,
				cy: (i * 83.37) % 420,
				r: i % 9 === 0 ? 1.3 : 0.65,
				fill: '#9eb6cc',
				opacity: 0.15 + (i % 4) * 0.1,
			}),
		);
	const showMenu = function (screen: 'title' | 'setup'): void {
		closeProfileDialog();
		options.onMenu();
		app.hidden = true;
		root.hidden = false;
		title.hidden = screen !== 'title';
		setup.hidden = screen !== 'setup';
		root.scrollTop = 0;
		if (screen === 'title') newGame.focus();
		else
			sizeButtons
				.find(function (button) {
					return button.dataset.size === size;
				})
				?.focus();
	};
	flow.onScreenEnter('title', function () {
		showMenu('title');
		void profilePicker.refresh();
	});
	flow.onScreenEnter('setup', function () {
		showMenu('setup');
	});
	flow.onScreenEnter('playing', function () {
		closeProfileDialog();
		root.hidden = true;
		app.hidden = false;
		options.onPlaying();
	});
	newGame.addEventListener('click', function () {
		if (newGame.disabled) return;
		status.textContent = '';
		renderPreview();
		void flow.setScreen('setup', {});
	});
	carrierToggle.addEventListener('change', function () {
		if (starting) return;
		carriersEnabled = carrierToggle.checked;
		map = { ...map, carriers: carriersEnabled };
		renderPreview();
	});
	element('back', HTMLButtonElement).addEventListener('click', function () {
		if (!starting) void flow.setScreen('title', {});
	});
	for (const button of sizeButtons)
		button.addEventListener('click', function () {
			if (
				starting ||
				!isMapSize(button.dataset.size) ||
				button.dataset.size === size
			)
				return;
			size = button.dataset.size;
			map = freshMap(size, carriersEnabled);
			renderPreview();
			status.textContent = `${MAP_SIZES[size].label} map generated: ${map.planets.length} worlds.`;
		});
	element('reroll', HTMLButtonElement).addEventListener('click', function () {
		if (starting) return;
		map = freshMap(size, carriersEnabled);
		renderPreview();
		status.textContent = 'New layout generated.';
	});
	start.addEventListener('click', async function () {
		const selected = profilePicker.getState().selectedProfile;
		if (starting || !selected || !options.profiles) return;
		starting = true;
		renderProfiles();
		status.textContent = 'Preparing your star system…';
		try {
			await profilePicker.reload();
			const currentProfile = profilePicker.getState().selectedProfile;
			if (!currentProfile)
				throw new Error('The selected profile is no longer available.');
			if (
				currentProfile.hasSave &&
				!window.confirm(
					`Starting a new conquest will replace ${currentProfile.name}'s saved conquest. Continue?`,
				)
			) {
				status.textContent = '';
				return;
			}
			await options.start(map);
			await flow.setScreen('playing', {});
			status.textContent = '';
		} catch (error) {
			console.error('Could not start conquest', error);
			status.textContent =
				error instanceof Error
					? error.message
					: 'Could not start conquest. Please try again.';
		} finally {
			starting = false;
			renderProfiles();
		}
	});
	renderProfiles();
	renderPreview();
	await flow.initialize();
	await flow.setScreen('title', {});
	const disposeFlow = flow.dispose.bind(flow);
	flow.dispose = async function (): Promise<void> {
		if (disposed) return;
		disposed = true;
		profileDialogListeners.abort();
		closeProfileDialog();
		profilePicker.dispose();
		await disposeFlow();
	};
	return flow;
};
