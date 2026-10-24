# Galaxy Conquest — current game design

This document describes standalone star system combat. It supersedes the initial v0.1 concept. The [README](../README.md) covers running the game and operating its controls. Tuning values below are defaults, not promises about balance.

## Intent and boundaries

Preserve the speed and clarity of a Galcon-like game while adding production choices, vulnerable troop transport, orbital combat, and blockades. Decisions center on what to produce, where to produce it, and where to send it. Battles resolve automatically without manual targeting, formations, activated abilities, or individual-unit selection.

The player is blue; one computer rival is red; neutral planets are unclaimed. Tactical ships and transports are individual entities. A dispatch groups units for order tracking and recall, but does not create a separately managed fleet. Planet surfaces and carrier crews hold troop counts; defense platforms are planet-bound counts.

There is no networking, controller support, audio, research, upgrades, diplomacy, construction queue, transport inventory, resource harvesting, account, cloud sync, or save export/import.

## Skirmish

The core loop is to capture planets, increase production, specialize planets in troops/ships/defense platforms, and dispatch forces to reinforce, blockade, or invade. The optional carrier setting in skirmish setup is off by default. When enabled, each side starts with one carrier that can also be captured by boarding. Carriers are part of standalone star-system combat, with no campaign layer. A skirmish ends when one faction owns no planets or carriers; its surviving ships and transports do not keep it alive. Neutral planets need not all be conquered.

New games preview a seeded, mirrored map and launch that exact layout. Restart replays the layout. Mirrored pairs have equal resources and at least 216 world units between centers.

| Size | Planets | Map width × height |
| --- | ---: | --- |
| Small | 12 | 1040 × 1080 |
| Medium | 18 | 1200 × 1320 |
| Large | 30 | 1560 × 1716 |

Each side starts with one planet, 44 troops, three ships, no platforms, troop production, and production rate 2.6. Other planets are neutral, with no ships or platforms, and do not produce until captured. Neutral tiers have 8/14/24 troops and production rates 1.7/2.2/3.4 respectively.

With carriers enabled, each side also starts with one carrier with 20 crew and three docked ships. Its current production rate is 25% of the standard home-planet rate. That multiplier is provisional implementation tuning; it is not a balance conclusion.

The Prototype lab uses a fixed eighteen-planet 1200 × 1320 map. Its skirmish starts with AI enabled. Blockade and invasion scenarios start with AI disabled: Sol has a red surface with 18 troops; the blockade adds four blue orbital ships, while the invasion adds two red platforms and a red ship there, plus five extra blue ships at Terra. Restart restores the chosen scenario; pace persists.

## Tactical rules

These rules apply to standalone star system battles.

### Production and forces

Owned planets produce one selected type continuously. Neutral planets do not produce. Production progress increases by `planet rate × 0.125` per simulation second; completing a unit consumes its cost. Switching types discards partial progress but preserves completed units. Capture resets progress and selects troops.

| Unit | Cost | Health | Damage per simulation second | Role |
| --- | ---: | ---: | ---: | --- |
| Troop | 1 | Numerical ground attrition | One defending troop per attacking troop | Hold or capture surfaces; travel only as cargo |
| Ship | 6 | 6 | 1.8 | Mobile orbital combat, escort, interception, blockade |
| Defense platform | 5 | 4 per platform | 2.4 per surviving platform | Planet-bound orbital defense |
| Transport | Free when troops dispatch | 2 | 0 | Carry up to 10 troops; consumed on landing |

Platforms may be fractionally damaged; their damage output scales with the remaining count. The interface rounds the count up and displays platform turrets on a slowly turning outer orbit. This motion follows simulation time and stops while paused. Ships and transports have individual health; troop cargo is lost when its transport is destroyed.

### Carriers

A carrier is an indestructible, boardable mobile holding. It has no defense platforms, independent weapons, crew capacity limit, or docked-ship capacity limit. Crew is its troop stock: troop production adds crew, and ship production adds ships to its docked inventory. Docked ships do not fight or count as external combatants until launched. A selected carrier moves to a fixed map location when the player clicks empty space; targeting a planet or carrier dispatches its crew and ships through the existing entity gestures. Ships and transports sent to a moving carrier continually update a predictive intercept as the carrier moves or changes course.

Carrier speed is 25% of ordinary ship travel speed (5.9375 world units per simulation second), which is half transport speed (11.875). A carrier stops when it reaches its selected location. Its **Launch docked ships** action launches the selected share into local space even during blockade. Blockade still prevents docking until hostile ships are cleared, while the carrier may continue moving. These permissions do not change ordinary planets’ departure restriction during blockade.

When boarding succeeds, ownership of the carrier and all ships still docked in it transfers together, and carrier movement stops. Ships launched before capture keep their owners and remain independent. An owned carrier counts as a surviving holding for victory; losing the last planet does not end the battle while the faction still owns a carrier.

### Dispatch, movement, and orders

Select one or more sources and a destination planet or carrier. The default send amount is 50%, with 25% and 100% also available. Filters select combined forces, ships only, or troops only. For each source, ships round up and troops round down after applying the fraction. Platforms never depart. A friendly orbital presence above a hostile surface can be a ship-only source. On touch, hold an entity for 500 ms to dispatch; with a mouse, right-click it. When a single owned carrier is selected, clicking empty map space instead sets its movement destination.

Orders reserve troops and ships immediately, including during pause, so repeated sends use the remaining stock. A paused launch can be cancelled before the next simulation step, restoring its reservation. Recall redirects surviving escorts and loaded transports from their current positions to each unit's original departure planet. Waiting invasion transports and their escorts remain recallable until landing completes. Returns follow normal arrival/combat rules if their source has changed hands. Returning orders cannot be recalled again.

Ships travel at **23.75** world units per simulation second; transports at **11.875** (half ship speed). Arrivals enter orbit within `planet radius + 22` units of the center. Escorts can arrive before their transports. There is no arbitrary mid-flight retargeting, path planning, or formation control.

### Interception, orbit, and landing

Traveling ships automatically target hostile travelers within **48** world units, preferring ships over transports, then nearest distance, then entity identity for ties. Ships stop moving while they have such a target and resume their destination afterward. Transports cannot shoot and continue moving while under fire. Orbiting ships, waiting transports, and platforms do not participate in passing combat. A passer does not join the orbit, establish a blockade, or prevent a landing. Orders to moving carriers use a continuously updated predictive intercept; carriers themselves do not receive intercept orders.

At planets and carriers, opposing orbital ships deal damage simultaneously from their pre-damage strengths. Only planets have defense platforms; they fire for their owner, with damage reaching ships first, then the planet owner's platforms, then exposed transports. A newly arrived transport has **0.75 simulation seconds** of protection from orbital damage; this is not protection from transit fire. Hostile ships or enemy-owned platforms prevent landing until destroyed. Friendly reinforcement transports must also wait for hostile orbital resistance to clear.

Safe transports unload automatically and disappear. Friendly cargo adds troops to the surface. Hostile cargo subtracts defenders one for one; ownership changes only if an attacking troop survives. Equal troop counts leave the existing owner with zero troops. A capture resets production to troops and clears partial progress. Winning orbit alone cannot capture a surface.

A blockade exists when an owned planet has hostile orbital ships, no friendly orbital ships, and no remaining platforms. It prevents departures from the surface owner, while production continues. Newly produced ships and platforms immediately contest the blockaders; outside reinforcements can break the blockade. The attacker can redirect its own blockading ships. A dashed hostile ring marks blockade; a solid hostile ring indicates hostile presence before complete control. A carrier can keep moving while blockaded, and its owner can launch docked ships into local space to fight blockaders; new docking waits until hostile resistance is cleared. Ordinary planets retain their departure restriction.

### Time, AI, and information

The tactical simulation advances in fixed **0.05-second** steps at 0.5×, 1×, or 2× pace. Pause freezes movement, production, combat, and AI while leaving navigation, selection, production changes, dispatch, cancellation, and recall available. There is no catch-up for paused time. Hiding the tab pauses tactical play; returning resumes it only if it was running before hiding.

The rival evaluates tactical decisions every **2.8 simulation seconds**, using the same unit costs and combat rules. It favors nearby lightly defended targets, switches between troops and ships, builds ships under hostile orbital pressure, and sends ship-only attacks to clear resistance. It normally retains 25% of a source, increasing its troop commitment when necessary to exceed the current garrison. It can pool troops to finish an invasion and pool ships to relieve a blockade with more ships than the blockaders. Existing inbound cargo reduces additional troop demand. With carriers enabled, it produces on carriers, uses their inventory for entity dispatch, and launches docked ships locally to contest blockaders. It has no strategic carrier movement strategy, so AI carriers stay stationary; this is an intentional limitation. The heuristic is not a prediction of future production, interception, or survival along a route; it does not guarantee winning decisions.

The map distinguishes ownership, surface troops or carrier crew, docked ships (▣), orbital ships (◆), and platforms (✣). Orders shows routes involving the current selection; Show all preserves selection until it changes. Selecting a row highlights its route. The lab records first player capture time, player orders, total captures, and combined transport/cargo losses; production shares, blockade duration, average match length, and stalemate frequency are not currently collected.

## Profiles, saves, and distribution

Up to ten local profiles share the browser/site's IndexedDB storage. First use creates a selected Player profile. Each profile has one star system battle save slot. Rename preserves saves; confirmed deletion removes the profile and its saves. New-game replacement and destructive profile actions require confirmation.

Skirmish snapshots retain map, units, production, orders, match state, and pace; Continue restores paused. Carrier maps, positions, courses, crew, docked ships, and ownership are included. Existing saves without carriers remain compatible.

Manual save and a periodic 15-second autosave operate during play, including pause; relevant actions also schedule or persist saves. The game header and menu show saving, saved, and failure status. Invalid snapshots cannot be continued and validation does not rewrite the stored data. Tactical safety limits include 100,000 troops/cargo, production rates up to 10,000, production progress below 10,000, map dimensions up to 10,000, positions within ±20,000, and planet radii up to 1,000; these are format safety limits, not balance limits.

Storage is browser- and origin-local, can be blocked/partitioned in embedded contexts, and can be lost through clearing or eviction. The production PWA caches build assets for offline play after an online caching visit; profiles and saves remain subject to those storage limits. Updates wait for all game windows to close. Development does not register a service worker. See the README for installation and deployment.

## Implementation references

| Area | Source |
| --- | --- |
| Tactical tuning, simulation, commands | [config.ts](../src/config.ts), [game.ts](../src/game.ts) |
| Movement, combat, tactical AI | [movement.ts](../src/movement.ts), [combat.ts](../src/combat.ts), [ai.ts](../src/ai.ts) |
| Maps and lab setup | [maps.ts](../src/maps.ts), [game-scenario.ts](../src/game-scenario.ts) |
| Screens, interaction, save lifecycle | [main.ts](../src/main.ts), [front-menu.ts](../src/front-menu.ts) |
| Persistence and validation | [profile-storage.ts](../src/profile-storage.ts), [save-state.ts](../src/save-state.ts) |
| Presentation and culling | [pixi-renderer.ts](../src/pixi-renderer.ts), [render-candidates.ts](../src/render-candidates.ts) |

## Playtest questions and acceptance limits

The carrier starting force and production multiplier are provisional tuning. Their balance and gameplay feel remain open for playtesting. Other questions concern whether the behavior works well for players:

- Can a new player expand, understand the two combat layers, and identify why an invasion failed?
- Do troops, ships, and platforms each create useful choices without repetitive production switching or defensive stalemates?
- Does half-speed troop transport make escorts and interception readable and useful without making expansion too slow?
- Are blockade-source selection, dispatch filters, multi-source orders, cancellation, and recall discoverable on touchscreens?

Automated simulation, persistence, geometry, and UI-state regressions support correctness. Recorded renderer/culling evidence uses automated Chromium with SwiftShader, not physical GPU or phone throughput. Physical touch comfort, combat readability, balance, and match duration still require playtesting. The renderer migration has recorded owner acceptance. Performance evidence and its environment limits remain in the technical documents linked from the README.
