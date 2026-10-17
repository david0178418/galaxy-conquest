# Planet Conquest RTS — Initial Game Design

**Working title:** Planet Conquest RTS (shipped as Galaxy Conquest)
**Version:** 0.1 — concept / handoff draft
**Status:** Initial design draft. Current behavior is in the [README](../README.md).
**Inspiration:** The fast, minimal, planet-to-planet real-time strategy of *Galcon*

> **Design intent:** Preserve the speed and clarity of a Galcon-like game while adding strategic depth through three kinds of planetary production, vulnerable troop transportation, two layers of combat, and orbital blockades. Complexity should come from **what to produce, where to produce it, and where to send it**—not from commanding individual units in battle.

> **Prototype status:** When this draft and the game disagree, follow the game. Orbital guns are defense platforms, and dropships are transports. Transports carry 10 troops, launch without a separate cost, and disappear on landing. Switching production discards partial progress. A blockade is hostile orbiting ships, no friendly orbiting ships, and no defense platforms; it blocks departures only. Traveling ships stop while they shoot hostile travelers within 48 units, then resume the same destination. Transports take that fire and keep flying. Orbiting ships, transports, and defense platforms do not join passing combat. Recall returns a dispatch to its departure worlds. There is no arbitrary mid-course retarget and no controller support. Send amounts are 25%, 50%, and 100%.

## 1. High-level concept

Players control planets that continuously generate military units. They expand by sending units between planets, defending territory, and conquering opponents. Unlike a single-unit Galcon-style game, planets can produce different kinds of forces:

- **Ground troops** conquer planets and defend them against landings.
- **Capital ships** fight in space, escort invasions, and establish blockades.
- **Orbital defense guns** provide powerful, immobile protection for a planet.
- **Dropships** carry ground troops between planets and can be destroyed en route or during orbital engagements. **Dropships are created automatically when troops are dispatched**, rather than being managed as a separate production line in the initial design.

Conquering an occupied planet involves two contests: winning access to orbit and defeating its defenders on the ground. A player can win the space battle without winning the planet, leaving an enemy planet **blockaded**.

The game remains a real-time strategy game on a single map, with short decisions, simple orders, and automatically resolved battles.

## 2. Design pillars

1. **Galcon-like immediacy.** Selecting a source and a destination should remain the main interaction. Expansion should start almost immediately.
2. **Strategic choices over micromanagement.** Planetary production and allocation of forces carry the depth; no manual targeting, formations, unit abilities, or loading operations in the MVP.
3. **Readable at a glance.** Ownership, current production, orbital strength, ground strength, and blockades should be understandable without opening elaborate panels.
4. **Individual moving units, no fleet management.** Ships and transports travel as independent units. A single send order may launch many at once, but it does **not** create a persistent or separately selectable entity called a “fleet.”
5. **Offense should remain viable.** Defense matters, but orbital guns and large garrisons must not routinely force stalemates.
6. **Minimal economic abstraction.** Each planet supplies its own production; no global currency, supply lines, buildings, or resource harvesting in the initial version.

## 3. Core gameplay loop

1. **Acquire planets** to increase total production.
2. **Choose a production type** for each controlled planet.
3. **Accumulate units** as planets continuously produce their selected type.
4. **Dispatch units** from one or more planets to reinforce, contest, blockade, or invade a destination.
5. **Resolve orbital combat automatically** as hostile ships or transports encounter orbital defenders.
6. **Land troops automatically** when orbital conditions permit; resolve ground combat and possibly change ownership.
7. **Reallocate production and forces** in response to expansion, threats, and blockades.

There is no separate construction queue or tactical battle screen.

## 4. Planets and production

### Planet attributes

Each planet has:

- **Owner:** player, opponent, or neutral.
- **Production rate:** how quickly it converts time into units (potentially tied to planet size, as in Galcon).
- **Selected production type:** ground troops, capital ships, or orbital guns.
- **Stored units:** troops on the surface, capital ships stationed in orbit, and orbital guns fixed in defense.
- **Status:** normal, contested, or blockaded, derived from units present.

### Production rules — proposed defaults

- Each planet produces **one selected type at a time**.
- Production accrues automatically and continuously.
- Switching type is a single action and requires no building or research.
- Different unit types have different production costs/times.
- Stored units are preserved when production changes.
- **No manual dropship production** in the MVP. The three selectable production types are troops, capital ships, and guns; dropships remain a fourth distinct *unit type* created by transportation orders.
- The handling of partially completed production on switching should be deliberately simple; provisional default: progress toward the old unit is discarded. This is a tuning decision, not a settled rule.

**Strategic implication:** A planet focusing on guns hardens its position but contributes little to attacks. A troop-producing planet needs space access and transportation to project power. A ship-producing planet can attack or blockade but cannot occupy enemy ground by itself.

## 5. Unit roles

| Unit | Produced by | Movement | Main function | Main weakness |
|---|---|---|---|---|
| **Ground troops** | Planet production | Only aboard dropships | Capture and hold planets | Cannot independently travel or fight in orbit |
| **Capital ships** | Planet production | Fly between planets | Space combat, escort, blockade | Cannot capture a planet alone |
| **Dropships** | Automatically created when troops launch | Fly between planets, then land/disappear | Deliver troops | Fragile; destruction loses embarked troops |
| **Orbital guns** | Planet production | Fixed to their planet | Efficient orbital defense | Cannot move or assist other planets |

All combat units may have simple strength/health values, but they should **not** have activated abilities in the MVP.

### Working assumptions

- Capital ships can remain at friendly planets and defend their orbit.
- Orbital guns can engage hostile capital ships and dropships near their planet, but have no interplanetary range.
- Ground troops remain on the planet until launched or destroyed in ground combat.
- Unit statistics are intentionally unspecified at this stage; role clarity matters more than choosing numbers before playtesting.

## 6. Commands and movement

### Core interaction

As in Galcon, the player selects one or more owned source planets, chooses a destination planet, and sends some proportion of available mobile forces. A special case is addressed below: ships maintaining a blockade can be redirected from that orbit even though the underlying planet is not owned.

A **send order is a command to individual units**, not the creation of a fleet object:

- Selected capital ships depart independently toward the destination.
- Selected troops are placed into automatically generated dropships, which depart toward the same destination.
- Guns stay behind.
- Units may be launched together and appear as a loose stream or group, but each is a moving unit in its own right.
- On arrival, each unit participates in the appropriate orbital or landing behavior.

No formation editor, rally-formation controller, or persistent fleet panel is required.

### Redeploying blockade ships

A player must not lose control of capital ships simply because they are stationed above an enemy-held planet. Selecting the **friendly orbital presence / blockade ring** at that planet can act as a source for a new ship-only destination order. This selects the player's ships currently in that orbit; it does **not** create or select a fleet object. This is a narrow extension of the planet-to-planet send interaction, not a new tactical control layer.

### Selecting what to send — proposed MVP control

Preserve a familiar **send percentage** (for example, 25% / 50% / 100% or an equivalent gesture) and add a lightweight **dispatch filter**:

- **Combined** (default): send the chosen proportion of available capital ships **and** ground troops.
- **Ships only:** useful for space superiority or blockade without risking troops.
- **Troops only:** useful for reinforcement or when the route is already secure.

The filter is an order option, **not** a fleet type or organizational entity. It should be accessible without a multi-step dialog. If the filter proves too costly for usability, prototype a context-sensitive alternative.

**Initial scope decision:** Orders target planets, not arbitrary coordinates; launched units do not require mid-flight micromanagement.

## 7. Automatic dropship creation

This is an explicit simplification intended to avoid transport logistics overwhelming the game.

**Proposed default behavior:**

1. The player orders a number of ground troops to another planet.
2. The game automatically creates enough dropships to carry those troops.
3. Each dropship has a fixed capacity—for example, **10 troops** (illustrative, not final).
4. Dropships travel as visible, independent units toward the destination.
5. If a dropship is destroyed, its embarked troops are lost.
6. When it safely lands, its troops are added to the destination's ground forces or committed to ground combat.
7. The dropship is **consumed / disappears on landing**; it does not have to be recalled or reassigned.

The prototype does not require separate production, storage, or loading orders. Transports are consumed on landing, and they are not stockpiled afterward. Before landing, Recall turns surviving escorts and loaded transports back toward their own departure worlds. Creation stays automatic and free beyond having the troops to carry, so the cargo is the scarce resource and vulnerability is the reason to protect it.

**Open balance question:** If troop transport proves too cheap, charge a small amount of planet production for launching troops or fold transport cost into ground troop production. Avoid adding transport stockpiles unless testing shows a compelling strategic benefit.

## 8. Orbital combat, landing, and capture

Combat is automatic. A planet's surface and orbit are distinct control layers.

### Phase A: Orbital contest

- Incoming hostile capital ships engage defending capital ships and orbital guns.
- Hostile dropships are exposed to orbital defenses and may be destroyed.
- Supporting ships and dropships may arrive together, but are **not grouped into a game entity**.
- Orbital battle resolution should be simple and predictable; numerical attrition is an acceptable first implementation.
- Multiple send orders can converge on the same planet; arriving units interact with whatever units are currently present.

### Phase B: Landing

- Hostile dropships **cannot safely unload while effective enemy orbital resistance remains**.
- Once orbit is clear enough for landing, surviving dropships automatically deliver their troops.
- Friendly troop transports reinforce an owned planet on arrival if they can land safely.
- A dropship that arrives before an escort must survive exposure while waiting for an opening; the game should avoid arbitrary, unfair arrival-order losses from tiny differences in movement timing.

### Phase C: Ground contest

- Landed attacking troops fight the defending ground troops using automatic attrition.
- If the attacking troops eliminate the defenders and survivors remain, the planet changes owner.
- If defenders prevail, the planet remains under its original owner, even if its orbit is enemy-controlled.
- A planet with no ground defenders can be captured by at least one surviving attacking troop after orbit is secure.

### Multiple owners and active combat

The MVP should support two opposing players plus neutral planets; more complex multi-party targeting rules are deferred. Ownership changes only after ground capture, not after winning an orbital battle.

## 9. Orbital blockades

A **blockade** occurs when hostile capital ships establish effective control of a planet's orbit while its original owner still holds the surface.

This is a **state of the map**, not a new unit or a special command.

### Proposed rules

- Blockading ships remain in orbit and may continue to defend their position.
- The surface owner retains the planet and its ground troops.
- The owner cannot dispatch units through a hostile blockade while it is effective.
- The planet may continue producing units. Newly produced orbital defenses or capital ships immediately face the blockading force; new troops remain on the surface.
- Friendly reinforcements can attempt to break the blockade from outside.
- The attacker can deliver additional troops to complete the invasion once its orbital control permits landing.
- When the hostile orbital force is destroyed or driven away, the blockade ends.

**Purpose:** Space power can isolate and suppress a planet without automatically conquering it. This gives capital ships an offensive role beyond escorting troop carriers.

### Keep blockades legible

Show a clear blockade indicator around the planet; do not require players to inspect hidden status screens. The game must also make it clear **who owns the ground** versus **who controls orbit**.

### Rules needing playtest validation

- How long blockade-capable ships stay in orbit after capturing orbital superiority.
- How hostile units intercept new departures and arrivals.
- Whether production continues completely normally under blockade (provisional yes).
- Whether blockaded planets can ever dispatch an emergency breakout force as a special rule (provisional no special command; newly produced ships automatically fight).

## 10. Neutral planets and early expansion

To preserve Galcon's fast opening:

- Neutral planets should generally have **ground defenders but little or no orbital defense**.
- The player can invade them using automatically transported troops, without first assembling a large space force.
- Planet size, defenders, and production potential create tradeoffs between easy expansion and valuable targets.
- Some defended neutral planets can appear later as map variants, but should not be the default for early matches.

An ideal opening has players acquiring their first new planets within seconds, not waiting through several production cycles to assemble three types of units.

## 11. Information and interface

### Map-first information

Each planet should visibly communicate:

- Owner (color).
- Relative production rate or planet size.
- Current production selection (small icon or ring segment).
- At-a-glance combat strength, with enough distinction between **orbital** and **ground** strength.
- A conspicuous blockade / contested-orbit state.

Detailed counts can appear on selection or hover; displaying all three stockpiles on every planet at all times may create clutter.

### Suggested minimum controls

- Select one or more source planets.
- Select a destination.
- Set send proportion.
- Switch planet production among troops / capital ships / orbital guns.
- Optionally choose combined / ships-only / troops-only for the next send order.

Aim for mouse/touch/controller interactions that work without hotkey memorization. No tactical selection of an individual capital ship or dropship is required, even though each exists independently in the game world.

## 12. Illustrative situations

**Rapid neutral expansion:** A starting planet produces troops. The player sends 50% of them to a weak neutral world. Dropships appear automatically and land unopposed in orbit. The surviving troops capture it. The new planet starts producing immediately.

**Defensive specialization:** A threatened border planet switches production to orbital guns while safer interior planets produce ships and troops. The guns delay an assault, buying time for reinforcements.

**Blockade without conquest:** An attacker sends capital ships but no troops. They defeat the planet's ships and guns and remain in orbit. The enemy retains its ground garrison and production but cannot project new forces until the blockade is broken.

**Failed invasion:** Attacking ships win orbit, but too many troop-carrying dropships are lost or the ground defenders are too strong. The planet is not captured. Surviving attacking ships may continue blockading it while another troop wave is prepared.

**Breaking a blockade:** An ally-owned planet produces capital ships and sends them to a blockaded world. Incoming ships engage the blockaders, potentially restoring the defender's orbital access.

## 13. Match structure and victory

**Proposed MVP:** real-time skirmish on a bounded 2D star map with two players (human vs. AI is sufficient initially) and several neutral planets.

- Both players begin with controlled planets and modest garrisons.
- Expansion increases the player's combined production capacity.
- A player wins when the opponent controls **no planets**.
- Orbital occupation alone does not count as ground ownership or victory.
- Match length should be kept short enough that production choices can be changed and tested repeatedly.

Other game modes, upgrades, technology trees, diplomacy, and long-form progression are beyond the initial scope.

## 14. MVP / vertical-slice scope

Implement in this order:

1. **Galcon-like base:** Planet map, ownership, continuous production, selection, percentage sends, moving unit visuals, and simple ground capture.
2. **Three production choices:** Ground troops, capital ships, and orbital guns with distinct production costs.
3. **Automatic dropships:** Generate visible, vulnerable transports when sending troops; unload/disappear on landing.
4. **Two-layer combat:** Orbital resistance followed by ground capture.
5. **Blockades:** Persistently hostile orbit over an enemy-controlled surface, breakout and reinforcement interactions.
6. **Low-friction dispatch filters and UI:** Mixed / ships / troops, production icons, orbit-versus-ground indicators.
7. **Basic AI and balancing:** Expansion, concentration of force, production switching, defense, and blockade-breaking.

**Explicitly exclude in this slice:** fleets as managed entities, transport inventories, ship upgrades, tactical formations, special abilities, manual targeting, economic resources, construction queues, and logistics networks.

## 15. Playtest questions and success criteria

The design succeeds if:

- A new player can expand to a neutral planet without learning transport logistics.
- Sending units remains a one- or two-step action most of the time.
- Players regularly make consequential choices among troops, ships, and guns.
- Ships-only blockades and troop-carrying invasions feel tactically different.
- Orbital guns reward defense without making offensive play routinely uneconomical.
- Players can recognize why an invasion failed: lost orbit, transports shot down, or insufficient troops.
- Maintaining several planets does not require constant repetitive switching or multi-stage cargo commands.

Useful instrumentation:

- Time to first neutral capture and average match length.
- Production share by unit type over time.
- Planet captures per minute; average duration of blockades.
- Percent of invasions failing in orbit versus on the ground.
- Dropships destroyed and troops lost during transit.
- Number of player actions per successful capture.
- Percentage of games that devolve into mutually fortified stalemates.

## 16. Open decisions for iteration

These were not blockers for the first prototype. The prototype-status note at the top records the rows that have since shipped. The rest remain tuning questions.

| Question | Initial recommendation | Reason to revisit |
|---|---|---|
| Cost of dropships? | Create automatically at launch, no separate cost | Troop projection may prove too efficient |
| Dropship capacity? | Start at 10 troops per transport | Affects vulnerability, visual density, and battle outcomes |
| Dropship reuse? | Disposable on landing | Reuse adds return trips and logistics |
| Sending unit types? | Combined / ships / troops filter plus send percentage | Controls may still be too complex for mobile or controller |
| Ships and transports arrival speeds? | Similar initially; avoid tiny arrival-order penalties | Could add escort/interception depth later |
| Switching production progress? | Discard partial progress | May punish frequent switches too harshly |
| Planet production specialization? | One type per planet at a time | Mixed production could reduce micromanagement if switching is excessive |
| What constitutes orbital superiority? | Blockade requires hostile orbiting ships, no friendly orbiting ships, and no defense platforms. Landings also wait while the surface owner still has defense platforms | Whether defense platforms should count as orbital control still needs playtesting |
| New ship production during blockade? | Spawn into immediate combat | May create awkward or endless attrition |
| Can players control ships in transit? | Recall returns each dispatch to its departure worlds. No arbitrary mid-course retarget | A fuller retarget could become useful if travel times feel long |
| Can blockading ships leave orbit? | Yes: use their orbital presence as an order source, with no fleet object | Test whether the blockade-ring control is discoverable and unobtrusive |
| Strength / unit balance? | Tune in a playable simulation before adding more systems | Risks defense stalemate or one dominant unit choice |

## 17. Implementation notes (engine-agnostic)

- Model **planet ownership**, **surface troops**, and **orbit occupants** separately. Winning one layer must not automatically change the other.
- Model moving capital ships and dropships as individual entities. An order can assign the same destination to many entities; it need not instantiate a fleet.
- Model embarked troops as a numeric payload on each dropship to avoid simulating individual walking soldiers in space.
- Orbital guns are planet-bound entities or equivalent fixed defensive stock. Surface troops can also be represented as counts for performance and UI simplicity.
- Prefer deterministic, timestep-based combat for easier balancing, testing, multiplayer synchronization, and replays.
- The blockade indicator should be derived from current hostile orbital control rather than maintained as an independently authoritative flag.
- Keep production costs, travel speed, capacity, combat strength, and targeting rules data-driven so they can be rapidly adjusted.

---

## Design summary

**A Galcon-like strategy game in which planets switch between producing troops, capital ships, and orbital guns; troops automatically travel in vulnerable dropships; orbital battles determine access to planets; ground battles determine ownership; and victorious capital ships can blockade worlds they cannot yet conquer.**

The central constraint for future iteration is to **add decisions, not chores**. Every proposed mechanic should be tested against whether it preserves the original game's rapid planet-to-planet command flow.
