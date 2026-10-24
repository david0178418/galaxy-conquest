import type { Point } from './camera';

interface MapInputDependencies {
	board: HTMLElement;
	events: Window;
	getPlanetId: (target: EventTarget | null) => number | undefined;
	selectPlanet: (id: number) => void;
	dispatchPlanet: (id: number) => void;
	moveTo?: (point: Point) => void;
	panBy: (delta: Point) => void;
	zoomAt: (anchor: Point, factor: number) => void;
}

export const createMapInput = function (dependencies: MapInputDependencies): {
	cancel: () => void;
	dispose: () => void;
} {
	const { board, events } = dependencies;
	const listeners = new AbortController();
	const { signal } = listeners;
	const localPoint = function (event: PointerEvent): Point {
		const rect = board.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};
	const pointers = new Map<number, Point>();
	let gestureMoved = false;
	let holdHandled = false;
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelHold = function (): void {
		clearTimeout(holdTimer);
		holdTimer = undefined;
	};
	let gestureStart: Point | undefined;
	const midpoint = function (a: Point, b: Point): Point {
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	};
	board.addEventListener('pointerdown', function (event) {
		if (event.pointerType === 'mouse' && event.button === 2) {
			const id = dependencies.getPlanetId(event.target);
			if (id !== undefined) {
				event.preventDefault();
				dependencies.dispatchPlanet(id);
			}
			return;
		}
		if (event.button !== 0) return;
		if (pointers.size === 0) {
			gestureMoved = false;
			holdHandled = false;
			gestureStart = localPoint(event);
		}
		pointers.set(event.pointerId, localPoint(event));
		if (pointers.size > 1) {
			gestureMoved = true;
			cancelHold();
		} else if (event.pointerType === 'touch' || event.pointerType === 'pen') {
			const id = dependencies.getPlanetId(event.target);
			if (id !== undefined) {
				holdTimer = setTimeout(function () {
					holdTimer = undefined;
					holdHandled = true;
					dependencies.dispatchPlanet(id);
				}, 500);
			}
		}
	}, { signal });
	board.addEventListener('pointermove', function (event) {
		const previous = pointers.get(event.pointerId);
		if (!previous) return;
		const current = localPoint(event);
		if (
			gestureStart &&
			Math.hypot(current.x - gestureStart.x, current.y - gestureStart.y) > 6
		)
			gestureMoved = true;
		if (gestureMoved) {
			cancelHold();
			board.setPointerCapture(event.pointerId);
			const other = [...pointers.entries()].find(function ([id]) {
				return id !== event.pointerId;
			})?.[1];
			if (other) {
				const before = midpoint(previous, other);
				const after = midpoint(current, other);
				const distance = Math.hypot(previous.x - other.x, previous.y - other.y);
				if (distance > 0)
					dependencies.zoomAt(
						before,
						Math.hypot(current.x - other.x, current.y - other.y) / distance,
					);
				dependencies.panBy({ x: after.x - before.x, y: after.y - before.y });
			} else
				dependencies.panBy({ x: current.x - previous.x, y: current.y - previous.y });
			board.classList.add('dragging');
		}
		pointers.set(event.pointerId, current);
	}, { signal });
	const endPointer = function (event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		cancelHold();
		if (event.type !== 'pointerup') gestureMoved = true;
		pointers.delete(event.pointerId);
		if (pointers.size === 0) board.classList.remove('dragging');
	};
	events.addEventListener('pointerup', endPointer, { signal });
	events.addEventListener('pointercancel', endPointer, { signal });
	board.addEventListener('lostpointercapture', function (event) {
		if (event.target === board && !board.hasPointerCapture(event.pointerId))
			endPointer(event);
	}, { signal });
	board.addEventListener(
		'click',
		function (event) {
			if ((gestureMoved || holdHandled) && event.detail !== 0) {
				event.stopImmediatePropagation();
				event.preventDefault();
			}
		},
		{ capture: true, signal },
	);
	board.addEventListener('contextmenu', function (event) {
		event.preventDefault();
	}, { signal });
	const cancelGesture = function (): void {
		cancelHold();
		const captured = [...pointers.keys()];
		pointers.clear();
		for (const id of captured) {
			if (board.hasPointerCapture(id)) board.releasePointerCapture(id);
		}
		gestureMoved = true;
		board.classList.remove('dragging');
	};
	events.addEventListener('blur', cancelGesture, { signal });
	board.addEventListener(
		'wheel',
		function (event) {
			event.preventDefault();
			const multiplier =
				event.deltaMode === 1
					? 16
					: event.deltaMode === 2
						? board.clientHeight
						: 1;
			if (event.deltaY !== 0) {
				const rect = board.getBoundingClientRect();
				const sensitivity = event.ctrlKey || event.metaKey ? 0.01 : 0.002;
				dependencies.zoomAt(
					{ x: event.clientX - rect.left, y: event.clientY - rect.top },
					Math.exp(-event.deltaY * multiplier * sensitivity),
				);
			} else {
				dependencies.panBy({ x: -event.deltaX * multiplier, y: 0 });
			}
		},
		{ passive: false, signal },
	);
	board.addEventListener('keydown', function (event) {
		const deltas: Record<string, Point> = {
			ArrowLeft: { x: 50, y: 0 },
			ArrowRight: { x: -50, y: 0 },
			ArrowUp: { x: 0, y: 50 },
			ArrowDown: { x: 0, y: -50 },
		};
		const delta = deltas[event.key];
		if (!delta) return;
		event.preventDefault();
		dependencies.panBy(delta);
	}, { signal });
	board.addEventListener('click', function (event) {
		const id = dependencies.getPlanetId(event.target);
		if (id !== undefined) dependencies.selectPlanet(id);
		else {
			const rect = board.getBoundingClientRect();
			dependencies.moveTo?.({ x: event.clientX - rect.left, y: event.clientY - rect.top });
		}
	}, { signal });
	return {
		cancel: cancelGesture,
		dispose: function (): void {
			listeners.abort();
			cancelGesture();
		},
	};
};
