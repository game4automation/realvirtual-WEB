# Behavior Modelling — Continuous & DES (a beginner's guide)

This guide explains how the material-flow components in `src/behaviors/` work — conveyors,
turntables, sources, sinks — so you can **read** them and **write** your own. No prior knowledge
of the engine is assumed; read it top to bottom once and the code will make sense.

## The big idea: one definition, two simulations

A factory line can be simulated two very different ways:

- **Continuous** — time advances in tiny fixed steps (60 times a second). Parts physically slide
  along belt surfaces, sensors fire when a part's box overlaps them, drives jog motors. This is
  what you see when you press play.
- **DES (discrete-event)** — time *jumps* from one event to the next ("part arrives in 4.2 s",
  "rotation finishes in 0.8 s"). Nothing moves frame-by-frame; the simulation asks each component
  *"can you accept this part?"* and hands parts along a chain. This runs thousands of times faster
  and is used for throughput analysis.

The clever part: **you write the component once and it runs in both.** The decision logic ("should
the belt run?", "which output port do I send this part to?") is written a single time. Only *how
that decision is triggered* (a 60 Hz tick vs. a scheduled event) and *what effect it has* (jog a
belt vs. schedule an arrival) differ — and those live in two small adapter blocks.

**Supporting both is optional — it depends on the use case.** The `continuous` and `des` blocks are
independent; implement only the one(s) you need:

- **Both** — for a conveyor/turntable you want to run live in play mode *and* fast-forward for
  throughput analysis. (Conveyor, Turntable.)
- **Continuous only** — a purely visual or play-mode component that never participates in DES.
  Leave out the `des` block.
- **DES only** — a component whose continuous behaviour is already owned by a dedicated engine
  object, so the behavior must NOT also drive it. Source/Sink use `inert: true` with only a `des`
  block; the engine `RVSource`/`RVSink` runs play mode.

A component with only one adapter simply does nothing in the other paradigm — no harm done. Add the
second adapter later if a use case needs it.

## Anatomy of a component

A component is **one call** to `defineLibraryComponent(def)` in one file. The `def` is a plain
object with named blocks. Here is the skeleton (Conveyor, simplified):

**Simplified** — the `SIGNALS` contract below is cut to two entries so the
skeleton stays readable. The real Conveyor declares four
(`Run`, `Occupied`, `Running`, `PartCount`), which is the full material-flow
contract described under *The interlock* further down.

```ts
import { defineLibraryComponent, createTransitTimer, type RV } from './_shared/behavior-kit';

const SIGNALS = { Run:'PLCInputBool', Occupied:'PLCOutputBool' } as const;  // simplified PLC contract

interface ConveyorLocal { belt: RV.Node | null; partAtSensor: boolean; /* … */ }
type ConveyorSelf = RV.Self<ConveyorLocal, typeof SIGNALS>;

const def = {
  type:   'Conveyor',          // stable id — the rv_extras key AND the DES action namespace
  kind:   'conveyor',          // family: conveyor | router | source | sink | …
  models: ['*Conveyor*'],      // which placed assets bind this (glob on the GLB/asset name)
  schema:  {},                 // GLB params (value ?? default). Conveyor has none — timing is derived
  signalNamespace: 'Flow',     // type-neutral interop namespace → signals become `Flow.<key>`
  signals: SIGNALS,            // auto-declared PLC signals → typed self.sig.X accessors
  state:   () => ({ belt:null, partAtSensor:false /* … */ }),  // per-instance memory → self.local

  logic:   { shouldFlow, onPartAtSensor },          // shared brain — no time, no physics
  setup(self)              { /* mode-agnostic init: find nodes, set defaults, build menu */ },
  continuous: { setup, fixedUpdate },               // adapter: 60 Hz physics
  des:        { onAccept, onArrival, onDownstreamReady }, // adapter: scheduled events
};

export const ConveyorFlow = def;                    // the raw def — DES runner & tests read it
export default defineLibraryComponent(def);         // the runnable Behavior — auto-discovered
```

### The blocks, one by one

| Block | What it is | Runs in |
|---|---|---|
| `type` / `kind` / `models` | identity + which assets bind it | — |
| `schema` | parameters parsed from the GLB `rv_extras` (`value ?? default`) | both |
| `signals` | the PLC signal contract — auto-declared, reachable as typed `self.sig.<key>` | both |
| `state` | a factory for the component's per-instance memory → `self.local` (typed) | both |
| `logic` | the **shared brain**: flow decisions + state-machine transitions. Touches only `self` — never time or geometry | both |
| `setup(self)` | **mode-agnostic init**, run by BOTH simulations before their adapter: resolve nodes, set signal defaults, stamp the inspector badge, build the right-click menu | both |
| `continuous` | the **physics adapter**: `setup` wires triggers (sensor subscription, drive handles); `fixedUpdate(self, dt)` reads triggers and applies physical effects (jog belt, move drive) | continuous only |
| `des` | the **event adapter**: hooks (`onAccept`, `onArrival`, `onDownstreamReady`, …) react to scheduled events and schedule effects (`self.in(delay, 'Arrival', mu)`) | DES only |
| `reset(self)` | **mode-agnostic** — fired when the simulation is reset: restore `self.local` / state-machine / counters / timers to the start (like a reload). Don't re-resolve nodes (`setup` already did). | both |
| `start(self)` | **mode-agnostic** — fired right after a reset, to (re)start from the clean state (e.g. re-assert `Run = true`). | both |
| `resetStat(self)` | **mode-agnostic** — fired on a statistics-only reset: clear stat accumulators without changing simulation state. Mostly a DES concern. | both |

`reset` / `start` / `resetStat` are all optional. A definition that omits them simply doesn't react to
the corresponding lifecycle event (the rotary Drive / belt still snap back via the engine's own
`RVDrive.reset()`). A continuous component that owns a state machine (Conveyor, Turntable, ChainTransfer)
should at least implement `reset` so a sim restart looks like a fresh load. The three blocks are wired
to the viewer events `simulation-reset` / `simulation-start` / `simulation-resetstat`, which
`resetSimulation()` emits in the order reset → resetstat → start.

The golden rule: **decisions go in `logic`, init goes in `setup`, and the two adapters are as thin
as possible.** If you find yourself writing the same decision in `continuous` and `des`, it belongs
in `logic`.

## Why `setup` is "mode-agnostic" — the two run paths

This trips up newcomers, so read carefully. The same `def` is started two different ways:

```
CONTINUOUS                                  DES
──────────                                  ───
factory bind(rv):                           DESRunner:
  createSelf(rv, def)   ← declares signals    createSelf(rv, def)   ← declares signals
  def.setup(self)       ← YOUR setup          def.setup(self)       ← YOUR setup (same!)
  def.continuous.setup(self)                  (no continuous block)
  rv.onFixedUpdate(() => def.continuous.fixedUpdate(self, dt))
                                              events call def.des.onAccept / onArrival / …
```

Both paths call `createSelf` (which declares your `signals`) and then `def.setup`. **Only the
continuous path runs `continuous.*`; only the DES path runs `des.*`.** That is why anything BOTH
simulations need — resolving the belt node, setting `Run = true`, building the timing model — must
live in `setup`, not in `continuous.setup`. If you put it in `continuous.setup`, the DES path never
sees it.

`inert: true` (Source/Sink) is a special case: `setup` still runs, but **no `fixedUpdate` is
registered** — because for those the continuous physics is owned by a different engine object
(`RVSource`/`RVSink`), and the behavior would otherwise double up. They carry only a `des` adapter.

## Reading `Conveyor.ts`

A conveyor is a **zone-accumulation** belt: one part per zone. It runs unless a part is sitting at
its exit sensor *and* the next zone downstream is still full — then it stops so parts queue up
instead of crashing into each other. That rule is called **ZPA** (Zoned Part Accumulation).

Walk the file:

1. **`SIGNALS`** — the four PLC signals (`Run`, `Occupied`, `Running`, `PartCount`). Declared once;
   used everywhere through `self.sig.Run.get()` etc. (typed: `get()` returns a real `boolean`, so
   no `=== true` noise).
2. **`logic.shouldFlow`** — the ZPA rule, one line:
   `self.sig.Run.get() && !(partAtSensor && downstreamOccupied)`. This is the shared brain; both
   adapters call it.
3. **`setup`** — finds the belt + sensor node (`self.findTransport()/findSensor()`), bails out with
   `self.disable(...)` if they're missing, sets `Run = true` (the one non-default), builds the DES
   timing model with `createTransitTimer`, and adds the Run/Stop right-click menu. Runs on **both**
   paths.
4. **`continuous.setup`** — the physics wiring: a belt handle, the downstream interlock object, and
   a subscription to the sensor so `partAtSensor` updates when a part arrives.
5. **`continuous.fixedUpdate`** — every tick: publish surface occupancy, ask `shouldFlow`, jog the
   belt accordingly.
6. **`des`** — the event version of the same flow. `onAccept` schedules an `Arrival` after the part's
   **full-belt** transit time (`createTransitTimer` computed it as belt length ÷ drive speed);
   `onArrival` marks the part present at the discharge point and tries to release it;
   `onDownstreamReady` retries a part that was parked because the next zone was full.

Notice `continuous.fixedUpdate` and `des.onArrival` both end in the **same** `shouldFlow` /
`tryRelease` logic — that's the "write once" payoff.

## Reading `Turntable.ts`

A turntable is a **router**: a part arrives, the table rotates to align with a free output, then
discharges. It's bigger than a conveyor because it's a genuine **state machine** (FSM) with seven
states: `idle → aligning_in → receiving → holding → rotating_out → discharging → discharge_clearing
→ idle`.

How to read it:

- **`CONFIG` + `SIGNALS`** — constants and the PLC contract. Note `signalNamespace: 'Flow'`:
  a turntable publishes `Flow.Run/Occupied/…` (NOT `Turntable.*`) because it joins a material-flow
  line and must speak the same type-neutral interop signal names as its neighbours (see *The
  interlock* below).
- **The small helpers** (`setBelt`, `blockAllInputs`, `openInputPort`, `publishOccupied`, …) — these
  are the FSM's vocabulary. Each is one or two lines.
- **`logic`** — the FSM transitions: `tryReceive` (pick a waiting input, rotate to it), `tryDispatch`
  (pick a free output, rotate to it), `onRotationDone`, `finishCycle`, `abortToIdle`. These are the
  decisions both simulations share.
- **`setup`** — resolves the rotary drive + sensor (hard-required) and the belt (optional), sets
  `Run = true`, initialises the shared `self.prop` fields the DES path reads, builds the Reset menu.
- **`continuous.fixedUpdate`** — the FSM *driver*: it polls `drive.isAtTarget()` to detect when a
  rotation finished, refreshes the neighbour topology periodically, and `switch`es on `self.state`
  to apply the per-state effect (jog belt on/off, advance the clear timer).
- **`des`** — the same router as scheduled events: `onAccept` picks the output and schedules a
  `RotateComplete` after `|Δangle| / RotationSpeed` seconds (no physical drive — DES only consumes
  *time*); `onRotateComplete` discharges; `onDownstreamReady` retries a held part.

The angle math (`alignToInputAngle`, `dispatchToOutputAngle`) and the snap-graph topology
(`classifyConnections`, `listOwnSnaps`) live in `_shared/` because they are real, reusable geometry
— not trivial one-liners.

## The `self` context (quick reference)

Every block receives the same per-instance `self`, a facade over the runtime:

| Member | Purpose |
|---|---|
| `self.sig.<Key>.get() / .set(v)` | typed access to a `signals`-block signal (from the `signals` block) |
| `self.signals.get/set/on`, `self.signal(name, opts)` | raw signal bus (for dynamic / cross-type names) |
| `self.local` | your per-instance memory (typed by the `state` factory) |
| `self.prop` | snapshot-safe key/value bag (survives DES snapshots; used for cross-adapter shared state) |
| `self.state`, `self.setState(name)` | the FSM string |
| `self.findTransport() / findSensor() / findRotaryDrive()` | resolve a convention node under the root |
| `self.attachBelt(node) / attachDrive(node)` | a lazy belt/drive handle (`run`, `moveTo`, `isAtTarget`) |
| `self.addComponent(node, type, wiring?)` | Unity-style AddComponent: attach a drive behavior model (`Drive_Simple`, `Drive_DestinationMotor`) to a drive node. Pass `wiring` to connect slots to signals created with `self.addSignal` (the explicit, readable form used by Conveyor/Turntable); slots left unwired are created from the component schema's `signal:` markers. Either way the result is identical to a GLB import (rv_extras stamp with ComponentReferences) |
| `self.addSignal(node, slot, plcType, opts?)` | Unity-style AddSignal: create ONE signal for this component. The leaf lands in the component root's single `Signals` folder as `<node>.<slot>` (or under `opts.at` for any other hierarchy level), is registered in store + hierarchy and returns a handle whose `path` wires straight into a component property |
| `self.surfaceOccupied(node)` | is a MU physically on this surface? |
| `self.downstreamInterlock()` | the cached `{ occupied() }` reader for the downstream neighbour |
| `self.declareFlowSignals()` | declare the standard 4 material-flow signals `Flow.*` (when not using a `signals` block) |
| `self.disable(reason)` | abort binding (warns, skips the adapters) |
| `self.outputs() / inputs() / freeOutputs(mu?)` | port connections from the snap graph. `freeOutputs(mu?: MU): Port[]` takes the MU being routed as an optional argument, so a router can pick a port that fits *this* part (see `ChainTransfer.ts`, `self.freeOutputs(mu)[0]`) |
| `self.transfer(mu, port?)` | hand a MU downstream (DES handshake; continuous: inert) |
| `self.spawn()` | mint a new MU (Source) |
| `self.in(delay, hook, mu?) / at(time, hook, mu?)` | schedule a DES event (continuous: inert) |
| `self.stamp(type, fields)` | write the inspector/hierarchy badge |
| `self.contextMenu(target, items)` | right-click actions |

Because signals work the same in both runners (live subscriptions in continuous, edge-events in
DES), the `logic` layer runs unchanged in both — and a **live PLC can override** any signal in
either mode.

## The interlock is a name convention (not an interface)

Components coordinate through **named signals, not object references** — so the same logic works in
continuous, live-PLC, and DES modes. There is no compile-time interface; you join the line simply by
publishing the agreed signal name:

- each component publishes `Flow.Occupied` (its root); a router additionally publishes
  `Flow.Occupied@<portId>` per input port, keyed by the **stable snap id**.
- an upstream component reads its downstream neighbour's `Flow.Occupied[@id]`. No successor →
  treated as **blocked** (a part holds at the end of the line instead of vanishing).
- the **ZPA release rule**: run unless a part is held locally **and** the downstream zone is occupied.

The signal name is type-neutral on purpose: it is the generic material-**flow** interlock, not a
conveyor-specific one. The full interop contract is `Flow.Run` / `Flow.Occupied` / `Flow.Running` /
`Flow.PartCount`, and the single source of truth for the name is the exported `FLOW_OCCUPIED`
constant in `transport-links.ts` — no module hand-builds the string.

**Runtime symbol = the PLC binding name.** You author against the unscoped name (`Flow.Occupied`,
`self.sig.Occupied`), but at runtime each placed instance's signals are **prefixed with the asset's
de-duplicated name** and the scope is joined with a dot — so the actual `SignalStore` symbol (and the
PLC binding name) is `<asset>.Flow.Occupied`, e.g. `RollConveyor-2m.Flow.Occupied`, unique per
placement (`RollConveyor-2m`, `RollConveyor-2m_2`, …). The scoping is automatic (`scopeSignalName`);
the dot separator is consistent throughout (the hierarchy *node path* keeps `/` for `getByPath`, but
that is not the symbol). A standalone-loaded asset (no LayoutObject) gets the unscoped `Flow.Occupied`.

Any component that publishes `Flow.Occupied` joins the line — a conveyor, a turntable, a sink
(which publishes `false` so the line discharges into it), or a customer machine. The snap graph
defines *who* the neighbour is; the signal name defines *how* they coordinate. (This is why
conveyor, turntable and sink all use `signalNamespace: 'Flow'`.)

### `Flow.Occupied` is a continuous interlock + observability signal — NOT the DES interlock authority

The **internal** DES back-pressure handshake is **topology-/event-based** (`canAccept(mu)` +
`onDownstreamReady`), not signal-driven. `Flow.Occupied` is the continuous-mode interlock and the
external/observability surface (a live PLC can read or override it), but inside the DES solver it is
**not** the authority that decides whether a downstream accepts a part. Reasons:

- **Determinism** — the topology handshake is a synchronous in-event call chain
  (`releaseMU → onDownstreamReady → tryTransferMU`); a signal path would add a scheduled slip + an
  extra queue hop + tie-break reordering, meaningless in FastForward and reorder-prone.
- **Expressiveness** — `canAccept(mu)` carries MU identity, capacity, failure and port routing (a
  router's aligned port); a boolean `Occupied` bit cannot.
- **Unblock semantics** — `onDownstreamReady` is per-edge, FIFO, MU-preserving; a signal edge is a
  broadcast with no MU/edge identity (thundering-herd re-probe).
- **Snapshot/worker FastForward** — signal subscriptions are in-process closures that are **not**
  re-subscribed on restore, so a signal-driven interlock would silently fail in the worker.

One exception is read-only and deliberate: the **router output selection** (`Turntable.freeOutputs()`)
reads the downstream **root** signal `flowOccupiedRootSignal(ownerRoot.name)` (= `/${ownerRoot.name}.Flow.Occupied`)
to pick a free discharge port. The
back-pressure *authority* is still the `canAccept`/`onDownstreamReady` handshake — the signal only
informs the routing choice (see `tests/turntable-output-selection.test.ts`).

Consequence: `def.des.onSignalChanged` stays reserved for **external** signals only (live-PLC drives
the DES: Run/Stop, E-Stop, zone lock, downtime) as a wake-up trigger of the handshake — never as the
internal interlock itself.

## Zone occupancy is surface-based

A zone is **occupied** when a MU is physically on its belt surface — not merely at a point sensor.
`self.surfaceOccupied(beltNode)` detects this, and the component publishes `Flow.Occupied` from
it **every tick** (one good per zone). This is distinct from the local point sensor, which drives a
separate `partAtSensor` discharge trigger (and the part counter) and does **not** publish occupancy:

- **published occupancy** (surface) = what the upstream neighbour reads as back-pressure.
- **local sensor trigger** = what gates discharge in the ZPA rule.

## Shared building blocks

| Module (in `_shared/`) | Provides |
|---|---|
| `behavior-kit.ts` | the one-stop import: `defineLibraryComponent`, the `RV.*` types, `createTransitTimer` |
| `define-library-component.ts` | the factory itself (badge, schema registration, the continuous bind) |
| `transit-timing.ts` | `createTransitTimer(self, belt)` — conveyor DES transit time (full belt length ÷ belt-drive `TargetSpeed`) + entry/exit tween. The sensor position plays no part in the timing |
| `transport-links.ts` | the interlock: `FLOW_OCCUPIED` (SSOT), `createDownstreamInterlock`, `linkOf`, `portIds`, `declareFlowSignalsWith` |
| `lazy-drive.ts` | `attachBelt` / `attachDrive` — drive handles that resolve on demand |
| `surface-occupancy.ts` | `isSurfaceOccupied(viewer, node)` |
| `snap-graph-helpers.ts` | port topology: `classifyConnections`, `listOwnSnaps`, `findOutputPairings` |
| `turntable-angle-math.ts` | rotary alignment / dispatch angles |
| `aas-link.ts` | attach an Asset Administration Shell link to a node at runtime, in the same representation the GLB loader emits for an authored Unity `AASLink` |
| `drive-des.ts` | the generic drive-level DES motion primitive: given a target axis position, compute the move time, schedule the completion event and build the tween. DES-only — guard on `self.mode === 'des'` |
| `mu-reference.ts` | the MU's mutable travel state: its `forward` direction and the derived leading-edge ("Bug") offset used to place parts at transfer edges |
| `robot-ik-des.ts` | DES tweens for robot axis moves (`RVRobotIK` axis phases → `TweenSpec`) |

Trivial one-line rules and small constants stay **inline in the component** (so it reads top to
bottom); only genuinely reusable, non-trivial machinery goes in `_shared/`.

## Authoring a new component (step by step)

1. Create `src/behaviors/MyThing.ts`. Import from `./_shared/behavior-kit`.
2. Declare your `SIGNALS` contract and a `state` shape (with an interface for typed handles).
3. Write the `def`: `type` / `kind` / `models`, `schema`, `signals`, `state`, then:
   - put flow + state-machine decisions in **`logic`** (shared by both simulations);
   - resolve nodes + set defaults + build the menu in **`setup`** (runs on both paths);
   - wire triggers + apply physical effects in **`continuous`**;
   - add the event-driven version in **`des`**.
4. Export the default — `export default defineLibraryComponent(def);` — which is what
   auto-discovery picks up. **Additionally** export the raw def
   (`export const MyThingFlow = def;`) when the DES runner or your tests need to reach
   into `def.logic` / `def.des` / `def.setup` directly, as Conveyor and Turntable do.
   It is not universal: `Source.ts` and `Sink.ts` export only the default (they pass
   `{ inert: true }` and have no separate `*Flow` export).
5. Coordinate with neighbours by publishing/reading `Flow.Occupied[@id]` (set `signalNamespace: 'Flow'`).
6. Add a test under `tests/` (a continuous parity test + a `tests/des/` timing test).

### What the three bottom lines mean

```ts
export const MyThingFlow = def;                 // 1
const MyThingBehavior = defineLibraryComponent(def);  // 2
export default MyThingBehavior;                 // 3
```

1. exports the **raw definition** — the DES runner and the unit tests reach into `def.logic` /
   `def.des` / `def.setup` directly (they don't go through the runnable Behavior). **Optional:**
   `Source.ts` and `Sink.ts` skip this line entirely and export only the default.
2. `defineLibraryComponent(def)` turns the data `def` into a runnable **Behavior**: it registers the
   schema + inspector badge and builds the `bind()` the continuous runner calls. Pass
   `{ inert: true }` for a source/sink, or `{ badge, capabilities }` to override the defaults.
3. the **default export** is what auto-discovery picks up — the BehaviorManager globs
   `behaviors/*.ts`, takes the default-exported Behavior, and binds it to any placed asset whose
   name matches `models[]`.

## See also

- `doc-webviewer.md` — architecture and component overview
- `doc-extending-webviewer.md` — plugin system and custom components
- `doc-lifecycle.md` — model load, fixed-step loop, dispose
