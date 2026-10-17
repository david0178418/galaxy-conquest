# PixiJS ship renderer

Issue #44 uses ECSpresso 0.24.1's `createRenderer2DPlugin` in a presentation-only world. PixiJS is pinned to **8.19.0**, the same version used by that ECSpresso release's development dependency and within its `^8.0.0` optional peer range. PixiJS remains actively maintained; its v8 application, texture, and ticker APIs are documented at https://pixijs.com/8.x/guides/components/application.

The original hull paths, owner palettes, and detail thresholds are preserved in `ship-art.ts`. Canvas rasterizes each side/kind/detail combination once into a shared texture, rather than submitting every ship's paths each frame. Ordinary ships use retained ECS sprite components; cargo badges are lazy, upright child sprites with a constant screen size. The revised fit baseline uses four shared textures for 1,500 ships and 300 travel lines; all twelve hull variants are created only as needed. Large cargo values from compatible saves retain their full label. Travel lines are retained, tinted sprites using one shared mipmapped stroke texture, keeping the original one-world-unit width and opacity without rebuilding their geometry every frame. Orbital rings, order highlights and engagement beams use Graphics; stars are retained until the map changes. Defense platforms, added after this migration, are retained sprites: one per platform, with the count rounded up, on the outer orbit from `planetPlatformOrbitRadius`. Their angle follows simulation time, so the motion pauses with the match. Shared platform textures use the key `platform:${owner}:${detail}`. A faint owner-colored ring marks that orbit. Full-frame MSAA is disabled; baked ship textures and filtered travel-line textures supply their own edge smoothing.

The existing RAF in `main.ts` is the only loop owner. `startLoop: false`, `autoStart: false`, and a private, stopped Pixi ticker prevent a second simulation or render loop. Each draw synchronizes the presentation world with `unitPoint()`, runs transform propagation with `presentation.update(0)`, and calls `app.render()`. Rendering and camera controls continue while gameplay is paused. Pixi pointer processing is disabled; DOM planet buttons and the existing map input still own selection, pan, pinch, zoom, and dispatch.

The single backing canvas covers the visible map/viewport intersection at the device pixel ratio (capped at 3), rather than allocating transparent viewport margins or rasterizing the whole map at every zoom. Its bounds round outward to CSS pixels; the existing clip trims fractional map edges, and an entirely offscreen map uses a clipped 1×1 surface. Its CSS box cancels the enclosing DOM map transform, while the Pixi root applies the same camera in logical coordinates. CSS clipping preserves the old logical map boundary without a GPU stencil pass. Planet bodies and the HUD remain DOM overlays. Platform turrets are Pixi sprites, while the planet still shows the rounded platform count in the DOM. Regression checks cover viewport alignment, map-edge clipping, detail thresholds, and dashed routes with offscreen endpoints.

No render spatial index is introduced. The existing combat index excludes orbiting ships and remains unchanged. Pixi clips rasterization to the viewport, but CPU synchronization still processes every unit. Issue #43's candidate-query work is still separate; this migration neither implements it nor maintains a competing render index.

Ownership: the adapter owns one Application, its presentation world, Graphics, sprites, and texture sources. Removing a unit removes its presentation entity and destroys its sprite children and travel-line sprite without destroying shared textures. Game replacement clears ship, route, and platform sprites and destroys cargo textures. The twelve hull textures, platform textures, single travel-line texture, and Application are reused. Disposal is idempotent, awaits presentation teardown, destroys the Application/Graphics, and destroys all shared texture sources. Pixi objects never enter gameplay components or saved snapshots.

## Evidence and remaining acceptance

See `performance/renderer/` for identical paused mixed-fleet saves before and after migration at distant (0.5× fit), normal (fit), and close (5× fit) zoom, desktop 1280×800 and mobile-layout 390×844, DPR 2. The visual fixture is recorded alongside those screenshots. It includes both owners, both silhouettes, orbital ships, travelers, and cargo. Additional screenshots cover mobile pending-order highlighting and resumed combat. These are Chromium automation with a desktop user agent, not physical phone/touch testing or owner acceptance.

Canvas performance parity is the minimum acceptance criterion; a speedup is optional because standardizing fleet presentation on ECSpresso/PixiJS also provides value. The original SwiftShader comparison below regressed; subsequent revisions and repeated assessments are recorded chronologically below. No physical-GPU speedup or resolution of late-game simulation/autosave hitches is claimed.

## Initial crowded production comparison (before revision)

The [raw reports](performance/renderer/comparison.json) repeat #42's exact 1,500-unit LAB_MAP fixture at 1× pace, 1280×800 CSS pixels, DPR 2, fit scale 0.4431818181818182, Chromium 154/Linux with ANGLE SwiftShader. One tab ran at a time, with one second of warmup before a 31-second capture and no input during the capture. The Canvas capture used PR #45's production build; Pixi used this migration with CSS map clipping. Final browser checks cleared the task-origin service worker/cache before loading the rebuilt bundle. Earlier exploratory captures with two tabs or a GPU stencil mask are excluded.

| Metric, ms | Canvas p50 / p95 / p99 / max | Pixi p50 / p95 / p99 / max |
| --- | --- | --- |
| RAF interval | 66.7 / 83.4 / 100.0 / 116.6 | 100.1 / 116.7 / 116.8 / 133.4 |
| Synchronous draw | 2.1 / 3.7 / 4.7 / 7.3 | 2.7 / 3.6 / 5.1 / 10.7 |
| Simulation update | 1.3 / 3.0 / 7.0 / 8.6 | 2.9 / 4.1 / 5.8 / 8.1 |
| HUD refresh | 1.1 / 1.7 / 2.3 / 2.4 | 1.4 / 1.6 / 2.6 / 3.3 |
| Save capture, two samples | 2.9 / 3.1 / 3.1 / 3.1 | 3.3 / 4.5 / 4.5 / 4.5 |
| Save validate/clone sync, two samples | 5.1 / 5.4 / 5.4 / 5.4 | 6.2 / 6.9 / 6.9 / 6.9 |

Canvas recorded 435 RAF intervals and Pixi 287. Both captured two periodic autosaves; offsets are in the raw reports. Median cadence regressed about 50%, despite similar synchronous drawing spans. Graphics submission, browser compositing and software GPU work are outside that synchronous span; these data do not isolate which is responsible. Simulation code is unchanged, and larger RAF intervals can put more fixed steps into one update. The existing dt clamp can also reduce simulated progress during slow frames. These sequential runs remain subject to host variance and do not establish physical-GPU performance. Autosave and simulation costs remain separate and unresolved by a renderer switch.

Memory observations are ownership/count checks, not a GPU-memory profiler: the fit fixture retained 1,500 sprites, 1,503 presentation entities, three shared hull textures and one stopped ticker. Repeated fixture installation retained those counts, the same canvas, and the same WebGL context. At this viewport, the backing color image is 2560×1600 (about 16.4 MB RGBA), compared with Canvas's 2400×2640 (about 25.3 MB) at fit and 3600×3960 (about 57 MB) at close zoom. These estimates exclude depth/MSAA, browser surfaces, allocations and driver overhead; they are not total resident GPU memory.

Browser validation also saved and reloaded the mixed fleet, preserving 10 warships, 10 transports, pending/active orders and simulation time while resuming paused. Starting a new generated conquest through the normal setup flow reused the same canvas/context and replaced the old fleet. Page disposal removed the diagnostics API/panel and caused `gl.isContextLost()` to become true, confirming the task-owned WebGL context was released. Native click/right-click dispatch, route highlighting, keyboard pan, mouse drag, wheel zoom, pause/resume and desktop/mobile resize were exercised. Physical touch/pinch feel is unmeasured. Focused self-review repaired the deprecated Sprite-child pattern by promoting only badge-bearing ships to Containers, then rechecked close zoom, commands and combat. No independent renderer agent was used, per the owner's request to implement #44 personally.

To repeat mixed-fleet screenshots, use an isolated test origin/profile and install `performance/renderer/visual-fixture.json` as a schema-v1 `game` snapshot in a dedicated profile, then Continue normally. It starts paused at time 5 on LAB_MAP with 20 units and no orders. Desktop fit camera is x=374.0909090909091, y=130, scale=0.4431818181818182; distant camera x=507.04545454545456, y=265, scale=0.2215909090909091; close camera x=-509.5454545454545, y=-869, scale=2.215909090909091. Mobile close is x=-560, y=-355, scale=1.425. For the command/combat screenshots, select Sol, right-click Deneb, highlight the waiting order in Orders, close the drawer, then resume briefly and pause. Remove the dedicated fixture profile afterward.

## Regression investigation and revision

The [isolated renderer ablations](performance/renderer/renderer-ablation.json) identify graphics workload/configuration as the main source of the initial regression in this software-GPU environment. WebGL reported four MSAA samples with antialiasing enabled. Replacing ECSpresso synchronization with direct position/rotation/scale copies left RAF intervals around 116.7 ms; synchronization itself cost roughly 0.2–0.6 ms. Disabling antialiasing brought the isolated interval to about 50 ms. Hiding route Graphics also improved cadence; skipping `app.render()` while retaining CPU/ECS work restored approximately 16.7 ms. These short exploratory ablations exclude simulation, HUD and saving and are causal diagnostics, not full-game performance claims. They do not establish a performance bug in ECSpresso's renderer2D plugin. Pixi's [performance guidance](https://pixijs.com/8.x/guides/production/performance-tips/) also identifies antialiasing as a cost to consider.

The revision disables full-frame MSAA and replaces rebuilt travel-line Graphics with retained sprites using a shared, filtered, mipmapped stroke texture. The stroke retains the original one-world-unit core width, owner tint and opacity, with transparent shoulders for filtering. Each ship's existing presentation record owns its optional route sprite. No second unit index or loop is added. Order highlights, orbital rings and engagement beams remain Graphics; their edges can appear less smooth without MSAA and require owner appearance acceptance.

Visual review found a separate integration correctness issue when zooming from an already rendered fit view to close view while paused. Lazy promotion from Sprite to Container must reset the hull's child transform and explicitly mark `worldTransform` changed: renderer2D otherwise skips initial synchronization of the newly attached container when the world transform is unchanged. The repair was checked with staged paused zoom, upright cargo labels, dispatch, order selection and resumed combat. This does not explain the timed fit-view regression, where cargo containers are absent.

## Repeated full-game reassessment

The [six raw captures](performance/renderer/reassessment.json) use immutable production builds of Canvas `b6f1f93`, initial Pixi `aabde39`, and the revised renderer. One tab ran serially on the same isolated origin: revised / Canvas / initial Pixi, then the same order again. Each uses the same 1,500-unit LAB_MAP baseline, AI off, 1× pace, fit zoom, 1280×800/DPR 2, Chromium 154/Linux with SwiftShader, one-second warmup, 31-second capture, no input and two autosaves. The later paused-container repair does not affect this fit-view fixture.

| Build / repeat | RAF p50 / p95 / p99 / max, ms | Synchronous draw p50 / p95, ms | RAF intervals |
| --- | --- | --- | --- |
| Revised 1 | 66.7 / 83.4 / 83.4 / 100.0 | 2.5 / 3.5 | 452 |
| Canvas 1 | 66.7 / 83.4 / 83.5 / 100.1 | 2.0 / 2.9 | 436 |
| Initial Pixi 1 | 100.0 / 116.7 / 133.3 / 133.3 | 3.1 / 4.3 | 296 |
| Revised 2 | 83.4 / 100.1 / 116.7 / 116.7 | 3.4 / 5.6 | 354 |
| Canvas 2 | 66.7 / 83.4 / 83.4 / 100.0 | 2.0 / 2.5 | 442 |
| Initial Pixi 2 | 100.0 / 116.7 / 133.3 / 133.4 | 3.2 / 4.3 | 296 |

The revised median interval is 17–33% lower than initial Pixi. It matches Canvas once and is about 25% slower once; there is no reliable improvement over Canvas. Revised p95 intervals also improved over initial Pixi in both runs. Host variance remains material. All synchronous draw samples were below 50 ms; RAF includes graphics/compositor/software-GPU work beyond the synchronous span. Simulation, HUD and save capture/validation remain separately recorded and are not resolved by this change. Hardware-GPU and physical-phone results remain unmeasured. This reassessment left the PR in draft pending that evidence and owner appearance acceptance. The cleanup below, and the owner's acceptance on 2026-10-17, closed that gate for the recorded SwiftShader tail.

Current visual evidence: [distant](performance/renderer/revised-distant.png), [normal](performance/renderer/revised-normal.png), [close](performance/renderer/revised-close.png), [mobile close](performance/renderer/revised-mobile.png), and [mobile resumed combat](performance/renderer/revised-combat-mobile.png). Earlier `after-*` screenshots describe the initial version. The current close captures include the paused-container repair.

Lifecycle checks on the revision: arrival of a warship and transport removed both route sprites, retained the orbiting warship, and removed the landed transport (ships 3→2, routes 2→0, presentation entities 7→6). Repeated crowded baseline replacement retained 1,500 ship views, 300 route sprites, four shared textures, 1,504 presentation entities, the same canvas/context and a stopped ticker. Page disposal released that context (`isContextLost() === true`) and removed diagnostics. `bun run check` passed lint, all 63 tests, typechecking and production build after the paused-container repair.

## Final cleanup and accepted parity result

Final cleanup limits the backing canvas to the visible map/viewport intersection. At the crowded desktop fit view, this is 532×585 CSS pixels at unchanged DPR 2, instead of 1280×800. The backing color image falls from about 16.4 MB to 5.0 MB RGBA (excluding other surfaces and driver allocations). Camera translation is adjusted by the surface origin, with the existing clip preserving fractional map edges. This avoids transparent margins without reducing resolution or adding unit culling. Geometry tests cover fit, partial pan, viewport coverage and a completely offscreen map.

The [four complete cleanup captures](performance/renderer/parity.json) compare the final implementation with Canvas on main `8a99247`, which adds the fullscreen icons. Main has moved on since that capture. The method remains one serial tab, 1280×800/DPR 2, Chromium/SwiftShader, the same #42 1,500-unit fit fixture, one-second warmup, 31-second capture, two autosaves each, no interactions. Run order is Pixi / Canvas / Pixi / Canvas.

| Build / repeat | RAF p50 / p95 / p99 / max, ms | Draw p50 / p95, ms | RAF intervals |
| --- | --- | --- | --- |
| Final Pixi 1 | 50.0 / 66.7 / 66.8 / 66.8 | 2.6 / 4.0 | 555 |
| Canvas 1 | 66.7 / 83.4 / 83.4 / 83.5 | 2.0 / 2.5 | 456 |
| Final Pixi 2 | 66.7 / 83.4 / 100.1 / 100.1 | 3.4 / 5.1 | 457 |
| Canvas 2 | 66.7 / 83.4 / 83.4 / 83.4 | 2.0 / 2.5 | 452 |

Median and p95 match or improve Canvas in both pairs. The second Pixi p99 remains one refresh interval worse. The owner explicitly accepted this tail difference and authorized merge after checks on 2026-10-17; exact p99 equality is not a remaining gate. Standardizing rendering provides value without requiring a speedup. No hardware-GPU or physical-phone performance is claimed, and simulation/autosave costs remain separately recorded.

Additional [exploratory batching and atlas trials](performance/renderer/cleanup-experiments.json) did not establish a repeatable improvement and were removed. All completed trial reports are retained; the final atlas Canvas repeat did not start because the temporary origin reached its profile limit, so it has no measurement. No experimental batching or atlas code remains.

Final crop evidence: [normal](performance/renderer/cleanup-normal.png), [distant](performance/renderer/cleanup-distant.png), [close](performance/renderer/cleanup-close.png), [mobile close](performance/renderer/cleanup-mobile.png). Staged paused zoom preserves upright cargo labels and aligned DOM planets; selection, keyboard pan and resize were exercised. World replacement reused the same canvas/context and resized back to the fit map bounds; disposal released the context. At that revision, `bun run check` passed lint, 64 tests, strict typechecking, and the production build, including the fullscreen icons from `8a99247`.

The migration shipped in #47. Defense-platform orbit sprites followed in #48 and added one geometry test, so the suite is now 65 tests. Issue #43 remains open. This renderer still has no spatial index, and CPU synchronization still visits every unit.
