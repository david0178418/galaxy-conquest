# Performance diagnostics

Open the game with `?diagnostics=1`. This explicitly enables the developer overlay and `window.conquestDiagnostics` console API. Normal URLs expose neither; ECS timing and its collector system are disabled. No save schema, simulation rules, renderer, or camera controls change.

- `conquestDiagnostics.enable(false)` removes the panel, stops its 500 ms timer, clears application samples, and disables ECS timing/collection. `enable(true)` starts a fresh application window.
- `conquestDiagnostics.reset()` clears application samples before a capture.
- `conquestDiagnostics.report()` returns a JSON-compatible snapshot with context, counts, p50/p95/p99/max, counts above 50 ms, and save-event offsets/durations. Each metric keeps its latest 7,200 samples; save events keep their latest 100 entries.
- World replacement starts a new collector. Disable, page disposal, and world disposal clean up the overlay/timer. Pause leaves RAF/drawing/HUD measurement active while simulation samples stop.

`raf` measures actual animation callback timestamps **before** the game's 100 ms dt clamp and pace multiplier. It includes scheduling, browser rendering/compositing, and other work between callbacks. The displayed RAF median FPS is `1000 / p50`. ECS update-cadence FPS comes from the plugin, can differ from RAF, and becomes stale while paused. Neither is a GPU timer.

`simulation` measures the complete synchronous `world.update()` call, including all fixed steps, queries, commands, and diagnostics inside ECS. `draw` measures `renderer.draw()`, and `hud` measures every `refresh()` call, including interaction-triggered refreshes. `save.capture` covers snapshot capture/cloning. `save.validateCloneSync` covers the synchronous portion of the async repository call, including validation/cloning before its first await; it excludes queued IndexedDB work/completion. These costs are distinct, not additive percentiles.

`phase.*` and `system.*` sample ECSpresso 0.24.1's latest getters after each update. A system value covers its process callback; a phase includes scheduling/query overhead but excludes subsequent command playback. The library overwrites these timings on each invocation: multiple fixed steps are **not summed**, and a frame without a fixed step can retain the preceding fixed-step values. Use `simulation` for whole-update totals. The plugin's render resource is collected before the render phase completes, so the report reads world timing getters directly. ECS update-cadence FPS needs a warm-up after enable/resume.

## Repeatable crowded baseline v1

Use a separate browser profile/origin if the local profile quota is full. Run:

```js
await conquestDiagnostics.baseline();
```

This saves the current conquest, creates a dedicated `Performance baseline v1` local profile on first use in this page, and reuses that profile on subsequent calls. It installs the pure fixture from `src/performance-scenario.ts`, resets the camera to fit, starts playing at 1×, and clears diagnostics. Delete this dedicated profile through the normal Profiles UI after measuring. Existing profiles are retained.

The fixture uses the exact fixed `LAB_MAP` (18 planets, 1200 × 1320), scenario skirmish, AI off, production troops, no orders/defenses. There are exactly **1,500 units**: 600 blue warships orbit Terra, 600 red warships orbit Vega, and 300 blue transports carry 10 troops each toward Terra. Transport index `i = 1200..1499` starts at `x = 60 + (i % 20) * 3`, `y = 60 + floor((i - 1200) / 20) * 3`. All ages/progress/clocks start at zero, HP uses CONFIG defaults, IDs are deterministic. Transports stay in flight and fleet counts stay constant for the 31-second capture; this is tested over 30 simulated seconds. This measures a stable crowded rendering/economy workload, not active battle effects or dense hostile traveler combat.

For before/after renderer comparisons, use the same browser, viewport **1280 × 800 CSS px**, DPR **2**, browser zoom **100%**, pace **1×**, fitted camera **x=374.0909090909091, y=130, scale=0.4431818181818182**, no selection/order highlight, no input or tab changes during capture. Re-run the fixture for each capture, rather than continuing an older match. Do not resize after starting.

Build using `bun run build`, serve `dist/` over HTTP, and open a clean browser context with `?diagnostics=1`. Development serving also works, but avoid HMR during measurements. Allow initial loading/caching to settle. This console helper measures enabled and disabled RAF cadence with the same small external observer:

```js
const measureBaseline = async function (enabled) {
	conquestDiagnostics.enable(enabled);
	await conquestDiagnostics.baseline();
	conquestDiagnostics.reset();
	return new Promise(function (resolve) {
		const started = performance.now();
		const raf = [];
		let previous;
		const tick = function (now) {
			if (previous !== undefined) raf.push(now - previous);
			previous = now;
			if (performance.now() - started < 31000) requestAnimationFrame(tick);
			else resolve({ enabled, elapsedMs: performance.now() - started,
				raf, report: conquestDiagnostics.report() });
		};
		requestAnimationFrame(tick);
	});
};
const enabled = await measureBaseline(true);
const disabled = await measureBaseline(false);
console.log(JSON.stringify({ enabled, disabled }));
conquestDiagnostics.enable(true);
```

Keep the tab visible. A 31-second window spans at least two periodic 15-second autosave opportunities; the autosave timer is page-relative, so offsets vary. Exclude setup/initial saves by resetting after fixture installation. Compare percentiles/max and sample counts, and retain raw results. Alternate/repeat runs before attributing small changes to instrumentation or a renderer. Disabled runs intentionally have no application timing report; the external RAF observer remains identical.

## Recorded baseline

See [the recorded results](performance/baseline-2026-10-17.json) for production-build measurements and environment metadata. These are automated T3 collaborative Chromium/Linux results using **SwiftShader software rendering**, not a physical phone or GPU benchmark. The capture is the Canvas renderer at source `f09ffa1`, before the PixiJS migration. Later renderer measurements are in [renderer-migration.md](renderer-migration.md). CPU spans measure synchronous JavaScript; for this Canvas capture, raster and compositing may occur later, so low draw-call time cannot explain the entire RAF interval. Physical device/GPU throughput, touch feel, sustained thermal performance, and owner acceptance remain unmeasured.

The first production capture (31.04 s, 468 simulation/draw calls) recorded:

| Metric (ms) | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| Actual RAF interval | 66.70 | 83.30 | 83.40 | 83.40 |
| Simulation update | 1.10 | 3.00 | 5.90 | 11.90 |
| Canvas draw call | 2.00 | 2.90 | 4.20 | 10.70 |
| HUD refresh | 1.00 | 1.40 | 2.00 | 2.60 |
| Save capture (2 samples) | 2.80 | 2.80 | 2.80 | 2.80 |
| Save validation/cloning sync (2 samples) | 4.40 | 5.60 | 5.60 | 5.60 |

Autosaves occurred at approximately 9.01 s and 24.02 s after reset. The second 31-second capture was paused at completion for the [diagnostic screenshot](performance/crowded-diagnostics.png); it also retains 1,200 warships and 300 transports. JSON includes both captures and per-system/per-phase distributions.

Overhead measurement: the identical external RAF observer recorded enabled mean **66.45 ms** versus disabled **84.10 ms** (467 versus 369 intervals), with disabled p50/p95/p99/max **83.30/100/116.70/149.90 ms**. Enabled was about 21% faster in this sequential pair, which is evidence of host variance, not a diagnostic speedup or proof of zero overhead. There is no defensible isolated full-browser overhead estimate from this pair.

For a separate reproducible ECS-only CPU comparison, run `bun scripts/measure-diagnostics-overhead.ts`. [The recorded alternating 10-pair run](performance/ecs-overhead-2026-10-17.json) found median **0.9338 ms/update enabled** versus **0.9446 ms disabled** (−0.0108 ms, −1.14%); again below this run's variability. This companion excludes the application collector, percentile sorting, the overlay, browser rendering, and the HUD; it does not establish browser/GPU overhead.

Browser lifecycle evidence: disable yielded zero panels and zero tracked 500 ms diagnostic timers; replacement yielded one of each; while paused, simulation sample count stayed fixed and RAF samples increased; resume restarted simulation sampling. Final page disposal removed the panel, timer, and developer API. A fresh normal URL had no panel or developer API. Those checks describe the diagnostics behavior that has since shipped.
