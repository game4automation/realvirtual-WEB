# Signal Architecture — GLB Import to React UI

This document describes the complete signal data flow in realvirtual WEB: how signals are imported from GLB files, wired between components, driven by behavior models, updated by external interfaces, and bound to React UI components.

Signal references authored in Unity are stored as node paths. How those paths are written, how
they are resolved, and how Three.js name deduplication can break them is covered separately in
[doc-node-paths.md](doc-node-paths.md) — read it when a signal resolves to nothing without
raising an error.

---

## 1. Overview

### Live signal binding and override (current state)

`SignalBindPlugin` is a core plugin and supports both Planner placements and
eligible GLB component nodes. It contributes one `button-group` UI slot —
`SignalLinkModeButton`, order 64, shown in the `hmi`, `planner`, `des` and
`editor` mode contexts — and **gates its scene-click path on that mode**: the
`object-clicked` handler returns immediately unless `isSignalLinkModeActive()`,
so outside signal linking a click never surfaces the binding popover. The mode
is active on the explicit toggle (persisted under `rv-layout-signal-link-mode`)
or for the duration of a running signal drag; see
`signal-link-mode-store.ts`.

A binding targets a schema-declared component
slot. An authored component reference resolves to a registered model signal.
An empty command slot writes through the component's command contract, while an
empty feedback slot reads through its feedback contract. Empty slots do not
create signal nodes, store entries, or component references.

Source identity is `{ interfaceId, topic?, signal }`. Discovery registers the
full provider key in `SignalStore`, so liveness is evaluated per binding rather
than inferred from a signal value. Disconnect keeps discovery metadata, applies
an 800 ms simulation-time hold per slot, then neutralises only a dead control
slot. Pending discovery and duplicate-provider conflicts are separate states.

Routing roles come from the slot's schema-declared PLC type. Authored model
signals retain that type in `SignalStore`; direct command and feedback slots
carry it in the resolver result. Synthetic `Flow.*` signals remain explicit
behavior-owned signals.
PLC outputs are control sources (interface to realvirtual); PLC inputs receive
feedback (realvirtual to interface). Feedback never activates `liveControlled` and
is never neutralised. One full provider signal key accepts only one feedback
writer.

Slot resolution is per slot, so one authored reference does not hide empty
slots on the same component. An empty PLC output slot becomes
`direct-property` when its component implements matching command and neutralize
methods. An empty PLC input slot becomes `direct-feedback` when its component
implements the feedback-source contract. A declared slot without its required
runtime contract remains visible as `unavailable` with a diagnostic reason.

Only the first authored `Drive_*` behavior on a drive is active. Additional
drive behaviors are reported and skipped. Attaching the same behavior again is
idempotent; changing to a different behavior requires reloading the model.

The effective command priority is remote ownership, operator force, live
binding, then internal simulation. Mid-step activation stops the internal drive
command and redispatches level signals with the effective forced value; edge
signals such as `StartDrive` are not synthesised.

### Inline signal linking (Property Inspector)

Signal linking lives inline in the Property Inspector. Every schema field of
type `componentRef` with a declared `signal` (introspected via
`getSignalSlotFields()` in `rv-component-registry.ts`) renders as a
`SignalSlotRow` inside its component section — also when the loaded GLB
carries no value for it. Slot discovery in `resolveBindableSlots()` is
generic: any registered schema type with `componentRef + signal` fields
yields slots; `SLOT_DESCRIPTORS` remains only the alias source and the
synthetic fallback for behavior slots (Conveyor `Flow.*`). Schema authors
should be aware that adding a `componentRef + signal` field to ANY registered
schema automatically creates an inspector slot row.

#### Slot scope: which subtree a bind target owns

`resolveBindableSlots()` takes a `SlotScope` deciding how far down the subtree
it collects:

- `'aggregate'` — the whole subtree belongs to the target. Used for Planner
  placements: a placement is offered as ONE bind target, so the slots of its
  inner component nodes must surface on it.
- `'own'` — the walk stops at descendants that carry bindable components of
  their own, because `findSignalBindTarget()` offers each of those as its own
  target. Nested chains (a robot's `A1/A2/…/A6`, a drive per axis) would
  otherwise repeat every axis below on every ancestor.

`findSignalBindTarget()` picks the scope (`slotScopeForTarget()`) and registers
it on the binding manager, so every later call — badge scan, row models,
`applyMappings` — resolves the element the same way. An unregistered element
defaults to `'aggregate'`.

The two-column contract of `SignalSlotRow` (`src/core/hmi/rv-signal-slot-row.tsx`)
holds on every surface: LEFT is always the slot name (prefixed with the owning
component when the same slot name repeats within the surface — see
`computeRowQualifiers()`); RIGHT is always the assignment — an internal model signal chip, a CONNECT signal chip, or
"not linked". A slot assigned to an internal signal additionally shows that
signal's own external CONNECT mapping as a chain indicator
(`slot ← internal ← CONNECT`). The word "Direct" does not appear in the UI;
command/feedback slots without a model signal explain force unavailability in
a row tooltip. The 3D badge popover (`SignalBindPopover`) renders the same
rows from the same shared row-model builder
(`src/plugins/signal-bind/slot-row-models.ts`), so both surfaces always show
identical slot sets and states. The former "Signals (CONNECT)" inspector
section was removed; Auto-assign and Unbind-all are component-section actions
(`componentActionRegistry`) with a two-click confirm.

Signal-slot keys are removed from the generic FieldRow pipeline entirely —
`SignalSlotRow` is their only render path, and slot rows never call the
field-edit/reset callbacks. Without a `SignalBindingManager` (feature flag
off), rows render the GLB wiring read-only with no link/picker/drop
affordances.

#### Provenance: two blocks, never merged

The signal-badge tooltip answers "who uses this signal?" in **two separate
blocks**, because the two answers come from unrelated mechanisms and a merged
list would imply an equivalence that does not exist:

- **Drives these slots** — manual `SignalMapping` records: an operator
  explicitly linked this signal onto those slots. Source:
  `SignalBindingManager.getLinksForSource()`, a reverse index over the persisted
  mappings. Each row reads `<componentType> · <slot label>`, with the leaf node
  name as a dim right-hand qualifier.
- **Referenced by** — GLB name coupling: a component's `componentRef` field
  resolves to this signal because the authored model says so. Source:
  `NodeRegistry.getComponentsForSignal()`. Each row reads
  `<componentType> · <short node path>`.

Unlinking a signal removes a **Drives these slots** entry and cannot touch a
**Referenced by** entry — the latter lives in the GLB and is not editable from
the viewer. The blocks also differ in gating: the driven-slots block is
structural and always rendered, `Referenced by` follows the optional
`fields.binding` tooltip setting.

**Why those two titles** (plan-353 F4). The outgoing block used to be called
just `Drives`, which is too short to read as a direction — next to `Referenced
by` it looked like a variant of the same list rather than its opposite. The
titles now name the direction, and both come from `signal-vocabulary.ts`
(`PROVENANCE_DRIVES_TITLE` / `PROVENANCE_REFERENCED_TITLE`) rather than from
string literals at the render sites.

`Referenced by` is deliberately the **same** word as the property inspector's
footer: both list reverse references to the selected object
(`getComponentsForSignal` vs. `getReferencesTo`), so one term for one relation
is the rule being followed, not a collision. What was ambiguous was the pairing
inside the tooltip, and that is what the rename fixed.

**Row text is the display pair, not the raw key.** `getLinksForSource()` returns
`componentType` and `label` alongside the identity `slot`, both taken from the
binding's already-resolved slot (`resolved.componentType` / `resolved.label`,
the label SSOT from plan-341 Phase 4) — no second lookup, no second
humanisation. Component types are printed verbatim (`Drive_DestinationMotor`,
not "Drive"). Both fields are optional: a binding without a `componentType`
renders the bare label rather than inventing a placeholder like "Component", and
a binding without a `label` falls back to the raw slot key.

Both are resolved **lazily, only while the tooltip is open** (`tipOpen` gate in
`SignalBadge`): the registry walk, the reverse-index lookup and the activity
derivation never run on the row or tick path, so a panel with hundreds of signal
rows pays nothing for provenance it is not showing. The only exception is the
remote-override flag behind the authority note, which is a cheap boolean read
and runs while closed so a forced chip is never silently overridden.

#### Drop affordance: base state plus hover override

`drop-target-registry.ts` runs a three-state machine per registered entry, not a
two-state one. The BASE state answers "could this row ever take the payload?",
and hover overrides it only while the pointer is on the row:

```
beginCandidates(payload)   accepts → base = 'candidate'   (registry-wide)
                           rejects → base = null          (never dimmed)
hover enter                        → 'valid' | 'invalid'
hover leave                        → back to BASE, not to null
endDrag()                          → all → null
```

The state is published as the `data-rv-drop-state` DOM attribute. A surface that
mounts mid-drag (a popover opening 250 ms in) picks the base state up in
`attach()`; unmounting the hovered entry invalidates the hover pointer first so
the `leave` transition still carries the entry's identity.

`slotRejectReason()` in `drop-accept.ts` is the ONE rule behind every verdict —
drag hover, drop, picker click and picker Enter all call it, so they cannot
drift. It reports the **first** failing cause in a fixed order, so the user sees
the most fundamental reason rather than a downstream symptom:

| Order | `DropRejectReason` | Cause |
|-------|--------------------|-------|
| 1 | `unavailable` | the slot has no runtime contract (reject-only row) |
| 2 | `no-provider` | a `connect` payload without provider identity (an `internal` model signal legitimately has none) |
| 3 | `type` | Bool↔bool, Int↔int, Float↔float, **plus an Int signal on a Float slot** (`kindFitsSlot`); a Float signal on an Int slot stays rejected, and an underivable PLC type is rejected, not waved through |
| 4 | `direction` | a PLC `output` binds only to `plcOutput`, an `input` only to `plcInput`; `unknown` is rejected |

The Int-signal-on-Float-slot pair in row 3 is not a concession, it is the policy
the two layers underneath have always run: `SignalBindingManager._slotConflict`
calls only bool↔numeric and a float source on an int slot a conflict, and the
CONNECT gateway's `SignalCoercion.IsAllowed` permits `bool↔int` and `int→float`.
Real PLCs address drive setpoints and positions as DINT (`%QD4012`), so the drop
rule refusing them was the one layer out of step — a link the UI offered could
never be refused further down, but a link it refused was perfectly runnable.

The pair is accepted on both slot directions, and only the control leg is
lossless: on a `plcOutput` slot (PLC→viewer, e.g. `Destination`, `TargetSpeed`)
the integer widens exactly; on a `plcInput` slot (viewer→PLC, e.g. a position
feedback) the float is truncated by the integer signal's consumers
(`SignalStore.getInt`, `SignalValues.Coerce` at the gateway) — which is what a
PLC holding that value in a DINT expects.

`unavailable` rows and rows disabled by element eligibility are registered as
**reject-only targets**: they take part in the registry so they can state their
reason. Previously they were absent from it, which is why the pointer simply
died on them with no explanation.

An invalid target is **never red**. Since the colour rule below, saturated red
means "PLC input is TRUE", so a rejection is carried by icon (`LinkOff` in the
row's existing 14 px gutter), a struck-through assignment cell and the reason
text — never by hue. The generic `DROP_TARGET_SX` (green/red) remains for the
node-link domain, which has no signal values on screen.

#### Registry contract

`createDropTargetRegistry<T, R>()` mints one isolated registry per drag domain;
`T` is the payload, `R` the domain-specific rejection reason. The module never
inspects `R`.

- `DropTargetInput<T, R>` is a union: the current `DropTargetV2`
  (`reject` / `describe` / `onDrop`) and the legacy `DropTargetLegacy`
  (`accepts` / `onDrop`), which the node-link domain still uses. A legacy
  rejection normalizes onto a module-private `unique symbol` that is never
  emitted, so `R` stays sound without a cast — a legacy target has no
  `describe()` and therefore takes part in no transition at all, while still
  receiving its `data-rv-drop-state`.
- `DropTransition<R>` is the stream shape: `enter` (with `rect: DOMRect` and
  `reason: R | null`), `leave`, and exactly one `outcome`
  (`accepted` / `rejected` / `none`) per drag. `rect` is present on both `enter`
  variants and is never null, so emission does not depend on layout being
  measurable. It currently has **no consumer**: the panel leader line it was
  added for is gone, and nothing else in `src/` reads it. Keep that in mind
  before treating it as load-bearing.
- Lifecycle: `beginCandidates(payload)` sets every base state,
  `refreshEntry(handle)` re-evaluates one entry after its availability changed
  mid-drag, `endDrag()` is the user-side end and emits `outcome: 'none'` unless
  an outcome already went out, `disposeDrag()` is the teardown path (plugin
  unload, model switch) and emits **nothing** by contract. `subscribe(cb)`
  returns the unsubscribe.
- **`dropAt()` ordering — a registry guarantee, not a consumer's job**
  (plan-341 §2.3 invariants 2+3, completed by plan-353 F1). The drop first
  EVALUATES the target (the outcome must carry an identity that clearing the
  hover would erase), then CLEARS the hover, and only then emits. The observable
  contract for any subscriber: when `outcome` arrives, no element carries a
  hover value in `data-rv-drop-state` — a still-registered target shows its drag
  BASE state (`candidate`, or no attribute for a non-candidate), because
  `clearHover()` restores the base rather than blanking it. The emitted order on
  a hovered drop is therefore `enter → leave → outcome`. Previously the emit
  came first and the announcer's `settled` latch papered over the trailing
  `leave`; that latch is still there but is now redundant by design (see below).
- Performance: `reject()` is called at most once per hover **transition**, never
  per `pointermove`. `__rvDropDiag.rejectCalls` counts the calls for the
  benchmark assertion.

#### Screen-reader announcer

One `aria-live="polite"` region for the whole shell (`drag-announcer.ts`,
mounted ref-counted so React StrictMode cannot leave two behind), never one per
row — a live region must exist before its text changes.

Five moments are spoken: **grabbed**, **over a valid target**, **over an invalid
target**, **linked**, **cancelled**. Four of them come from the registry
transition stream; `grabbed` cannot, because the registry emits nothing at
`beginCandidates()` and never sees the payload's name, so it is read from the
drag store's `armed → dragging` promotion instead.

A 100 ms debounce covers a pointer sweeping across rows on its way elsewhere; a
`leave` DROPS the pending sentence rather than replacing it, and identical
consecutive sentences are not repeated. The first `outcome` of a drag latches the
listener shut.

That latch used to be load-bearing: `dropAt()` emitted the outcome and cleared
the hover afterwards, so the trailing `leave` would swallow the success sentence
inside the debounce window. Since plan-353 F1 the registry clears first and the
`leave` arrives BEFORE the outcome, so the sentence survives on ordering alone.
The latch is kept as a **redundant-by-design** second line of defence — it costs
one boolean and still mutes a `leave` from a foreign emitter (a target
unmounting, an overlay tearing down) after the drag has been decided. Do not
read its presence as evidence that the registry still misbehaves.

Rejection sentences quote `dropRejectText()` **verbatim**, so the row tooltip,
the picker's `aria-disabled` option and the announcer say literally the same
words. There is no `aria-grabbed` / `aria-dropeffect`: both are deprecated since
ARIA 1.1 and mis-announced by current readers; the live region plus the keyboard
path in `SignalSearchOverlay` replaces them.

#### Colour rule and its boundary

Two axes, never mixed (`signal-colors.ts`): **hue carries direction** (green =
PLCOutput, red = PLCInput), **intensity carries state** (`weak` = FALSE/zero,
`strong` = TRUE/non-zero). Every stage is a literal measured colour rather than
an opacity derivation, so the contrast does not float with whatever 3D pixels sit
behind the glass.

The bar is **WCAG 2.1 SC 1.4.11 Non-text Contrast (3:1)** against the worst-case
backdrop `#505050`, not the 4.5:1 text bar: a value chip is a state indicator
next to a label that already names the state in words. Prose — labels,
descriptions, reasons — keeps the stricter 4.5:1 requirement (WCAG 2.1 SC
1.4.3).

The consequence is binding: because saturated red means "PLC input is TRUE", red
may not additionally mean fault or invalid drop target. Faults and rejections are
carried by icon plus label. The four warning-level slot status tokens therefore
share ONE amber (`#ffa726`) and are told apart by icon and label alone.

The boundary to the 3D layer is deliberate. `SIGNAL_BADGE_STATE_COLOR` and
`port-marker-texture` show the **binding state of a whole element** and the drop
affordance — not a signal value — and keep their own palette and semantics. The
2D `STATE_COLOR` in `SignalBindPopover` is the same taxonomy in the panel
palette: the two records hold different values for the same states on purpose,
tuned against the scene and against the panel background respectively. Their
LABELS, by contrast, are one shared record (see the vocabulary section below).

#### The drag stack (what replaced the leader line)

Dragging a signal chip onto a slot is carried by four modules, not by a drawn
connector line — the panel leader line was removed and nothing in `src/`
references it any more:

- **`src/core/hmi/signal-drag-store.ts`** — the module-level state machine
  `idle → armed → dragging`. Shift+pointerdown on a chip arms;
  `SIGNAL_DRAG_THRESHOLD_PX = 4` promotes armed to dragging (so a Shift+click
  stays a click and neither forces nor drags); ESC cancels via
  `cancelSignalDrag()`; the lifecycle path `disposeSignalDrag()` tears down
  silently and emits no outcome. While dragging it adds
  `body.rv-signal-dragging`, suppresses hover tooltips, and pushes positions to
  `subscribeSignalDragPos()` subscribers only.
- **`src/core/hmi/SignalDragGhost.tsx`** — the cursor-following ghost. It
  writes a DOM transform directly from the position subscription, so a
  pointermove costs no React re-render.
- **`src/plugins/signal-bind/scene-drag-open.ts`** — auto-opens the bind
  popover for the element under the pointer after
  `AUTO_OPEN_DEBOUNCE_MS = 250` ms, so the drop can land straight on a slot
  row. Raycasts are throttled to `RAYCAST_THROTTLE_MS = 50`, and the drop
  overlay's magnet target is consulted **first** — the raycast only serves
  geometry hits outside the magnet radius. A cancelled drag closes an
  auto-opened popover again; a successful drop keeps it open.
- **`src/plugins/signal-bind/drop-target-overlay.ts`** — the in-scene marker
  layer, capped at `MAX_HIGHLIGHTS = 50` targets nearest to the camera, with
  `NEAREST_MAGNET_RADIUS_PX = 42` as the magnet radius for the active marker.

#### During a drag the scene shows only compatible plugs

While a signal drag runs, `SignalBadgeController` deactivates itself and removes
its badges, leaving the payload-filtered `drop-target-overlay` as the only marker
layer in the scene. `enumerateAllBindableTargets()` takes no payload and cannot
filter, so leaving both layers up made every bindable plug light up for a signal
only a few of them could accept.

The controller subscribes to the **drag phase** (`subscribeSignalDrag`), not to
the link mode's `active` flag: with signal linking explicitly switched on,
`active` stays true across drag start and end, so a link-mode subscription would
never learn that a drag is running.

### Vocabulary: which word means what

Four taxonomies describe "is this connected, and who writes it?". They coexist
because each has a different SUBJECT; the shared wordings live in
`src/core/hmi/signal-vocabulary.ts`.

| Term | Taxonomy | Subject | Where it appears |
|------|----------|---------|------------------|
| `Not linked` | `ElementBindingState.unbound` | one element | 3D badge label (`userData.rvSignalBadgeLabel`), popover header, announcer sentence start |
| `– not linked` | same lexeme, value register | one slot | slot-row assignment cell |
| `Live controlled` | `ElementBindingState.live` | one element (aggregate) | 3D badge label (`userData.rvSignalBadgeLabel`), popover header |
| `Pending — waiting for CONNECT` | `ElementBindingState.pending` | one element | 3D badge label (`userData.rvSignalBadgeLabel`), popover header |
| `Source disconnected` | `ElementBindingState.disconnected` | one element | 3D badge label (`userData.rvSignalBadgeLabel`), popover header |
| `Conflict` | `ElementBindingState.conflict` | one element | 3D badge label (`userData.rvSignalBadgeLabel`), popover header |
| `live`, `live · hold`, `live · local` | `SlotLiveness` + authority | one slot's binding | slot-row status token (level 6/7) |
| `pending`, `disconnected`, `conflict` | `SlotLiveness` | one slot's binding | slot-row status token (level 5/4/1) |
| `bound` | slot authority | one slot | slot-row status token (level 8, the fallback) |
| `forced`, `remote` | slot authority / remote layer | one slot's write lock | slot-row status token (level 3/2) |
| `live`, `supplied`, `local`, `stale`, `no source` | `SignalActivity` | one signal's supply | `activityLabel()`; `activityStatusHint()` renders `stale` / `no data` in the CONNECT signal list |

Reading the overlaps:

- **`Live controlled` (element) vs. `live` (slot)** can be on screen together —
  the popover header states the element is live-controlled while its rows carry a
  per-slot `live` token. That is a level distinction, not a duplicate: the header
  aggregates, the token is per binding. The registers are kept apart on purpose
  (sentence-case status label vs. lowercase chip token).
- **`SignalActivity.live` (signal) vs. the two above** is a third level, upstream
  of any binding: it says the signal is supplied at all. It keeps its own
  lowercase compact wording; folding it into `Live controlled` would erase
  exactly that distinction.
- **`Not linked` vs. `– not linked`** is one lexeme in two sentence positions. A
  standalone status label and a sentence start are capitalised, a value cell after
  a dash is not. Both constants live in `signal-vocabulary.ts`, so the casing is
  one decision rather than three literals.
- **Element-state labels are ONE record.** `BINDING_STATE_LABEL` backs both the
  3D badge sprite (`SIGNAL_BADGE_STATE_LABEL`) and the popover header
  (`STATE_LABEL`) by alias, so a badge and the popover it opens cannot word the
  same element differently.
- **Authority sentences are ONE set, at two lengths.** `AUTHORITY_SENTENCE`
  states the bare fact; the roomier slot-row tooltip appends the consequence
  clause from `AUTHORITY_CONSEQUENCE` (`authorityExplanation()`), the compact
  signal-tooltip note does not. The note is therefore a prefix of the tooltip,
  never a rewording of it. None of the sentences names CONNECT: an `internal`
  mapping relaying a model signal claims `bound` just the same.

### Internal signal sources (`sourceKind`)

A `SignalMapping` carries an optional `sourceKind: 'connect' | 'internal'`.
Mappings persisted before this field exist without it and are interpreted as
`'connect'` at every read site through `mappingSourceKind()`
(`rv-layout-store.ts`). An `'internal'` mapping relays FROM a SignalStore model
signal INTO the slot — the raw `componentRef` field in the GLB extras is never
rewritten. Internal bindings are their own provider: they are live as soon as
the source signal exists in the store, also during an active CONNECT session,
and they receive the same simulation-time hold when the source vanishes
(model switch). The picker offers both groups — "CONNECT (live)" from the
connect store and "Model signals" from the SignalStore (provider-less
entries), excluding the slot's own target signal.

The persisted Slot → Signal record is identified by `componentPath`, `kind`,
and `slot`; its `signal` field names the assigned source and `sourceKind`
defines how that name is resolved. For a `mapped-signal` row, `targetName`
continues to identify the authored model-side destination. Assigning another
internal signal therefore adds a runtime relay instead of replacing the
authored destination or mutating the GLB.

The relay flush (`_flushWrites`) is a drain loop: the pending-write object is
swapped against a fresh one before each `setMany`, so writes queued by a chain
binding during the synchronous notify still land in the same tick. A cycle cap
(`MAX_FLUSH_DRAIN_CYCLES`) bounds pathological relay cycles with a dev
warning.

Node-target persistence (`SignalLinks.Mappings` + `persistFieldOp`) keys its
runtime adapter by `Object3D` identity (WeakMap). A model reload creates new
node objects, so runtime state never leaks across reloads — the new adapter
re-seeds from the node's `SignalLinks.Mappings` rv_extras on first read.

### Recorded-drive handoff

Recording playback yields as one unit when any drive in its recording becomes
live-controlled. The scheduler checks this every simulation tick, even while
playback is paused or excluded by `ActiveOnly`, then stops playback and clears
`positionOverwrite` on every bound recording drive. The current frame and time
accumulator are preserved so the recording remains resumable after the live
binding is removed.

While any recorded drive remains live-controlled, both normal playback starts
and named replay sequences are rejected. `ReplayRecording` therefore reports
`IsReplaying=false` for a rejected trigger. Feedback-only bindings do not take
control and do not stop playback.

### First-link notice

`first-link-notice.ts` exists because the handoff above is invisible to a user
who has just linked their first signal: claiming a slot raises `liveControlled`,
the model's internal control stops driving it, and in the demo model that halts
the single LogicStep sequence plus the drives replay
(`rv-drives-playback.ts` bails out as soon as ONE recorded drive is live
controlled). Read without explanation, the stopped model looks like a defect.

`noteSignalMappingsWritten(prev, next)` fires the one-time overlay on the
`0 → n` transition, once per page load. It is wired only to mappings written
through the UI — restoring persisted mappings on model load goes through
`syncNodeSignalBindingPersistence`, never `write()`, so loading a prepared scene
stays silent.

```
 GLB (rv_extras)              CONNECT / Interface (WS/MQTT/TcHmi)
      │                                    │
      │ PLCOutputBool, PLCInputFloat...    │ import_answer / data messages
      │ ConnectSignal refs                 │ bufferIncoming()
      ▼                                    ▼
┌──────────────────────────────────────────────────────────────┐
│                       SIGNALSTORE                            │
│  byName:    Map<signalName, boolean | number>                │
│  pathToName: Map<hierarchyPath, signalName>                  │
│  subscribe(name, cb) → unsubscribe                           │
│  set(name, value) — equality check, then notify              │
│  setMany(batch) — atomic: all values first, then listeners   │
│  version — monotonic counter for polling optimization        │
└─────┬──────────┬──────────┬──────────┬───────────────────────┘
      │          │          │          │
   WIRING    DRIVES     SENSORS    LOGICSTEPS
   Connect   Behaviors  AABB/Ray   WaitFor/Set
   Signal    read/write collision  signal conditions
      │          │          │          │
      └──────────┴──────────┴──────────┘
                     │
              ┌──────┴──────┐
              │ REACT HOOKS │
              │ useSignal   │  ← event-driven (per-change)
              │ useSignalTick│ ← polling (200ms, version check)
              │ useDrives   │  ← model-loaded event
              │ useSensorSt │  ← sensor-changed event
              └─────────────┘
                     │
                     ▼
              React Components
              (re-render on change)
```

---

## 2. GLB Import — rv_extras to SignalStore

### 2.1 Signal Types in rv_extras

The Unity GLB exporter embeds signal definitions in each node's `userData.realvirtual`:

```json
{
  "PLCOutputBool": {
    "Status": { "Value": false },
    "Name": "ConveyorStart"
  },
  "PLCInputFloat": {
    "Status": { "Value": 100.0 },
    "Name": "DriveSpeed"
  }
}
```

**Six signal types** are recognized:

| rv_extras Key | SignalType | Direction | Meaning |
|---------------|-----------|-----------|---------|
| `PLCOutputBool` | bool | output (PLC writes) | Viewer reads this signal |
| `PLCInputBool` | bool | input (Viewer writes) | Viewer writes this signal |
| `PLCOutputFloat` | float | output | Numeric output from PLC |
| `PLCInputFloat` | float | input | Numeric input to PLC |
| `PLCOutputInt` | int | output | Integer output from PLC |
| `PLCInputInt` | int | input | Integer input to PLC |

**Direction convention** (from PLC perspective, identical to Unity C#):
- **Output** = PLC writes → Viewer reads (e.g., sensor state, encoder position)
- **Input** = Viewer writes → PLC reads (e.g., start button, speed setpoint)

### 2.2 Two-Phase Loading (Awake/Start)

The scene loader (`rv-scene-loader.ts`) processes components in two phases, mirroring Unity's `Awake()`/`Start()` lifecycle:

**Phase 1 — Awake (Construct + Register):**

```
traverseAndRegister(root):
  for each node with userData.realvirtual:
    1. Parse signal types → signalStore.register(name, path, initialValue)
    2. Construct component via registered factory (ComponentRegistry)
    3. Apply schema: map rv_extras fields → TypeScript instance properties
    4. Add to pending[] for Phase 2
```

**Phase 2 — Start (Initialize + Wire):**

```
initializeComponents(pending):
  for each pending component:
    1. Resolve ComponentRefs → signal addresses, sensor/drive instances
    2. Call component.init(context) → components wire their signals
```

**Why two phases?** ComponentRefs (e.g., Drive referencing a Sensor) can only be resolved after ALL nodes are constructed. Phase 2 runs after the full tree is built, so forward references work.

### 2.3 Signal Name Resolution

When registering a signal, the name is determined by priority:

1. Explicit `Name` field in rv_extras (highest priority)
2. Node alias (handles Three.js name deduplication like `Sensor_1`, `Sensor_2`)
3. Node name (fallback)

**Step 2 uses the RAW glTF name** — the spelling the file authored, before Three.js sanitized
it. That is the spelling the live interface (MQTT / realvirtual CONNECT) addresses, so a
Siemens symbol `MC04.01I00W` on a node Three.js had to deduplicate registers as `MC04.01I00W`
and not `MC0401I00W`.

> **Behaviour change (plan-734, was a bug).** Before this, step 2 handed over the *sanitized*
> spelling, so a deduplicated signal node with an empty `Name` field registered under a name the
> PLC could never write to. A signal is affected only if all three hold: no explicit `Name`
> field, its node name collides file-globally after sanitization, **and** the raw name contains
> whitespace or one of `[ ] . : /`. Measured across all 25 private project GLBs: **zero**
> signals change name.
>
> If such a signal did exist, one thing would not follow it: a layout-planner binding saved
> *before* the fix stores the SignalStore **name** (`SignalMapping.signal`,
> `carrierSignalName`), and the store has a path alias but no *name* alias. The binding would be
> reported as orphaned — fail-closed, no data loss, no crash — and has to be re-bound once. The
> raw name is the correct one; the old binding pointed at a name that never worked.

---

## 3. SignalStore — Central Signal Bus

### 3.1 Data Structure

Simplified — the real class carries more fields (provider provenance, writer
identity, shadow telemetry); this is the shape that explains the dual-key
lookup:

```typescript
class SignalStore {
  private byName = new Map<string, boolean | number>();    // PRIMARY lookup
  private pathToName = new Map<string, string>();           // path → name mapping
  private listeners = new Map<string, Set<Callback>>();     // per-signal subscribers
  private _version = 0;                                     // monotonic change counter
}
```

**Dual-key design:**
- **byName**: Primary access — all reads/writes use signal name
- **pathToName**: Secondary — maps hierarchy paths to signal names (built by `buildIndex()` after load)

### 3.2 Core API

**Reading:**

```typescript
get(name: string): boolean | number | undefined
getBool(name: string): boolean           // coerced
getFloat(name: string): number           // coerced
getByPath(path: string): ...             // resolves path → name → value
```

**Writing:**

```typescript
set(name: string, value: boolean | number): void
  // 1. Equality check — skip if value unchanged
  // 2. Update byName map
  // 3. Increment version counter
  // 4. Notify all listeners for this signal

setMany(updates: Record<string, boolean | number>): void
  // ATOMIC batch: all values written first, then ALL listeners notified
  // Used by interfaces to flush incoming buffer in one shot
```

**Subscribing:**

```typescript
subscribe(name: string, cb: (value) => void): () => void
  // Returns unsubscribe function
  // Callback fires ONLY on actual value change (equality check in set())

subscribeByPath(path: string, cb): () => void
  // Resolves path to name, then subscribes by name
```

### 3.3 Writer identity and shadow telemetry

Production writers use `SignalStore.createWriter(writerId, writerKind)` instead
of retaining the raw `set`, `setByPath`, or `setMany` methods. The writer handle
keeps the existing write semantics and carries a stable identity such as an
interface id, plugin id, component path, behavior scope, or SDK component path.
Built-in writer kinds are `hmi`, `plugin`, `behavior`, `component`, `remote`,
`replay`, `sdk`, `mcp`, `debug`, and `interface`.

This is observation only. Phase 0 does not assign authority, rank writers, or
reject writes. `getWriterInventory()` returns one runtime row per
`(signal, writerId)` pair with a write count and optional slot context;
`resetWriterInventory()` clears only that inventory. Repeated writes reuse the
existing row, so the steady-state write path does not allocate telemetry
objects. A raw compatibility write is reported as writer `unknown`; development
builds attach a one-time stack hint for that pair.

### 3.4 Slot authority — slot level above the channel level

`src/core/engine/rv-slot-authority.ts` names WHO writes a slot. It works on
two distinct levels that must not be conflated:

- **Channel level** (`SignalChannelId` = the SignalStore signal name): values,
  forces, and provider provenance live here. The SignalBindingManager's
  feedback-writer claim (`_claimFeedbackWriter`) also stays on this level —
  exactly one writer per full interface signal key; a second direct-feedback
  binding onto the same key becomes a `conflict`.
- **Slot level** (`SlotId`): write authority lives here. A `SlotId` is the
  NUL-separated 4-tuple `elementId`, `componentPath`, `componentType`, `slot`
  (`makeSlotId()`; NUL because Unity node names regularly contain spaces).
  The `componentType` segment is derived from the active registry instance on
  bind — it is folded into the key only and never persisted; stored
  `SignalMapping`s keep their `componentPath` + `slot` shape, and legacy
  mappings without `kind`/`componentPath` normalize onto the same canonical
  id through the `bind()` backfill path.

A bidirectional index links the levels: `SlotId → SignalChannelId` plus an
incrementally maintained reverse index `SignalChannelId → SlotId[]`. Two slots
bound onto one channel are two authority entries sharing that channel
(fan-out is explicit).

Authority is the union `none | component | bound | forced` (pure derivation in
`deriveSlotAuthority()`); `component` is the claimless default. Claims form a
latent stack: a live binding claims `bound` (released on unbind/disconnect),
an operator force overlays `forced` without displacing the bound claim, and
releasing the force restores `bound` and redispatches the live source value
(the binding manager's `wasForced` edge). Remote ownership (multiuser) is a
separate upstream layer, not a fifth authority value.

SlotIds are allocated only on bind/unbind/claim and cached on the binding —
never in the 60 Hz tick. Per-tick readers of the live-control gate keep a
cached boolean `liveControlled` instance field maintained by the service
(`setInstanceLiveControlled()`); `rv-live-control.ts` remains as a thin
re-export adapter. The viewer owns the lifecycle: `RVViewer.clearModel()`
calls `resetSlotAuthority()` unconditionally on every model switch.

#### Remote ownership and authority ranking

Remote ownership (multiuser) is the upstream layer above the slot authority
union. The full ranking is `remote > forced > bound > component`. The
`MultiuserPlugin` raises the layer via `setRemoteOwnershipActive(true)`
BEFORE the first snapshot signal dispatch (atomic snapshot: any listener
fired by a snapshot value already observes remote-owned drives), keeps it
raised across transport drops (reconnect resumes the same authority), clears
it on `leaveSession()`, and `resetSlotAuthority()` clears it on every model
switch so a new model never inherits foreign ownership.

The remote-vs-force ranking is configured per viewer
(`RVViewerOptions.authorityRanking`):

- `strict` (default) — `remote > forced`: while a remote owner is active, a
  remote write passes THROUGH an operator force (`SignalStore` updates both
  the value and the force pin). The ranking check runs only in the
  already-forced branch of the write path — ordinary writes never pay for it.
- `legacy` — the previous behavior (`forced > remote`) as a pure rollback
  lever without a code revert.

Only the session owner publishes feedback: the `SignalBindingManager` checks
`isOwner` on both the component instance and the drive before any
feedback/write-back to a source — non-owner multiuser clients stay silent.

**Version-skew rollout note:** mixed client versions inside one multiuser
session apply DIFFERENT force rankings (old clients keep `forced > remote`).
Update all clients of a session together when rolling out a viewer version
that changes the ranking or its default.

#### Write gate — shadow first, enforce prepared

Every classified local-simulation write (`component`/`behavior`/`sdk` writer
kinds, excluding the binding relay itself) is checked against the slot
authority using the reverse index `SignalChannelId → SlotId[]`. Conflicts are
recorded deduplicated as `(SlotId, writer, reason)` in the same telemetry
infrastructure as the writer inventory (`SignalStore.getWriteConflicts()`,
cleared by `resetWriterInventory()`); repeated conflicting writes only bump a
counter — the steady-state write path allocates nothing and creates no new
entries. Writes to a forced channel are recorded with reason
`authority-forced`; writes hitting a bound slot claim with reason
`authority-bound`.

The gate mode is `RVViewerOptions.signalWriteGate` / the per-model
`SignalStore.signalWriteGate` property:

- `shadow` (default) — conflicts are recorded, **nothing is rejected**.
- `enforce` — prepared but still not part of any rollout: classified
  writers whose write contradicts the slot authority are dropped. `unknown`
  writers (raw legacy `set`/`setMany` calls) are NEVER rejected, only
  recorded — the raw store API stays legacy-compatible.

Two different things hide behind that last sentence, and they take effect at
different lines:

- a **raw** legacy write uses the `UNKNOWN_WRITER` fallback, whose kind is
  `plugin`. It is not a local-simulation kind, so it leaves the gate on the very
  first check and is never even recorded;
- a **classified** writer that happens to carry the id `unknown` (kind
  `component`) does reach the gate, IS recorded as a conflict, and is still not
  rejected. That exception is what keeps a legacy path from disappearing
  silently once `enforce` goes hot — while leaving it visible in the conflict
  log, which is how such a path gets found and fixed.

#### Slot write roles — command authority vs. feedback authority

A bound slot does not automatically mean "the component must keep its hands
off". Two kinds of slot are bound for opposite reasons:

- a **control** slot is commanded by the PLC (`PLCOutput…` → drive, conveyor),
  so a local write really would fight the binding;
- a **feedback** slot reports model state back (`PLCInput…` ← sensor, position).
  The component is the *producer* of that value; the binding only forwards it.
  Rejecting the component here would empty the very signal being mirrored.

The role is derived in exactly one place, `SignalBindingManager._deriveSlotRole()`
(four stages: direct slot kind → providerless legacy mode → registered store
type → descriptor fallback; otherwise `unknown`). Since plan-353 it is
**mirrored** into the authority service — `registerSlotWriteRole()` on bind and
on every role change, `clearSlotWriteRole()` on unbind, and the whole map is
dropped by `resetSlotAuthority()` on a model switch. The mirror is a
publication, never a second derivation.

`getSlotWriteRole()` defaults to **`control`** for anything unregistered, which
is the conservative direction: a forgotten mirror can only ever be too strict
(the pre-plan-353 behaviour), never grant a right by accident. `unknown` behaves
like `control` for the same reason.

**Fan-out conflict rule (channel-wide, order-independent):** a channel write is
ranked over ALL slots indexed against the channel in a single pass — there is no
early return, because returning at the first claimed slot let a `bound` slot
registered earlier hide a `forced` slot registered later, and mislabelled the
conflict as `authority-bound` either way. The rule:

1. any `forced` slot — or a channel-level operator force — decides
   `authority-forced`, whatever the roles are;
2. otherwise, with at least one `bound` slot and a local-sim writer: every
   `control`/`unknown` bound slot rejects. The write is allowed only when **all**
   bound slots on the channel are `feedback`;
3. otherwise nothing claims the channel → `ok`.

The recorded conflict names the slot of the **deciding** authority, not the
first one seen. The all-feedback case is not logged at all: it is permitted
behaviour, and filling the shadow log with it would bury the conflicts the log
exists to surface.

`SignalStore.canWriteSlot(slotId, writer)` is the synchronous UI companion. Both
it and the write path go through **one** internal decider that returns a scalar
reason code; the `{ allowed, reason }` object is allocated only in
`canWriteSlot()`, at the UI boundary, so the hot path stays allocation-free and
the answer the operator reads cannot drift from the one the store acts on.
`allowed` states whether a write by this writer reaches the store now and
`reason` names the dominating authority —
`authority-forced`, `authority-bound`, `authority-remote`, or `ok`. These
reasons are deliberately distinct from the plan-317 slot-availability reasons
("no model signal"). Three surfaces render them: the inline signal-slot rows of
the property inspector and the 3D badge popover — both through the shared row
builder `slot-row-models.ts`, so they never diverge — plus the signal badge
tooltip (`buildAuthorityNote()`, including the "Force overridden by remote
owner" hint).

**Authority on unbound slots.** A SlotId, its claim entry and its channel-index
entry exist only while a binding is live, so neither `getSlotAuthority()` nor
`canWriteSlot()` can answer for a slot without one. The row builder derives that
case from raw state through the pure `deriveSlotAuthority()`: no claim means
`component`, unless the operator forces the slot's own model signal — a force
needs no binding and would otherwise stay invisible on every unbound slot. The
claimless `component` label is shown only where the row carries an actual
assignment (a model signal or a mapping); on an unlinked row it would merely
restate "– not linked".

### 3.5 Path Resolution (Suffix Matching)

After `buildIndex()`, paths support suffix matching:

```typescript
// Full path: "DemoCell/Signals/ConveyorStart"
// All of these resolve to the same signal:
store.getByPath("DemoCell/Signals/ConveyorStart")  // exact match
store.getByPath("Signals/ConveyorStart")            // suffix match
store.getByPath("ConveyorStart")                    // shortest suffix
```

This allows components to reference signals by short names without knowing the full hierarchy.

---

## 4. Signal Wiring — ConnectSignal

### 4.1 Purpose

`ConnectSignal` (`rv-connect-signal.ts`) creates a one-way signal bridge: when the source signal changes, the value is copied to the target signal (this node's own signal path).

This mirrors Unity's `ConnectSignal` component which wires signals across the hierarchy.

### 4.2 rv_extras Format

```json
{
  "ConnectSignal": {
    "ConnectedSignal": {
      "type": "ComponentReference",
      "path": "Signals/SourceSignal",
      "componentType": "PLCOutputBool"
    }
  }
}
```

### 4.3 Wiring Flow

```typescript
// In init() (Phase 2 — Start):
init(context) {
  const sourceAddr = resolvedRef.signalAddress;  // resolved from ComponentRef
  const thisPath = this.node.userData.rvPath;

  // 1. Subscribe to source signal
  this._unsub = store.subscribeByPath(sourceAddr, (value) => {
  writer.setByPath(thisPath, value);  // copy to self
  });

  // 2. Sync initial value immediately
  const initial = store.getByPath(sourceAddr);
if (initial !== undefined) writer.setByPath(thisPath, initial);
}
```

### 4.4 Wiring Helpers

`rv-signal-wiring.ts` provides shorthand functions that eliminate repetitive subscription boilerplate:

```typescript
// Subscribe a boolean signal to a setter function
wireBoolSignal(store, signalAddress, setter, debugLabel)

// Resolve ComponentRef first, then wire
wireRefBoolSignal(registry, store, componentRef, setter, debugLabel)
```

Used by sensors, safety doors, and other components that need to bind PLC signals to internal state.

---

## 5. Behavior Models — Components Using Signals

### 5.1 Drive

**File:** `rv-drive.ts`

Drives don't directly subscribe to signals. Instead, **DriveBehaviors** read signals and control the drive:

```
DriveBehavior (e.g., Drive_Simple, Drive_Cylinder)
  │
  │ init(): wire signals (JogForward, JogBackward, TargetSpeed, etc.)
  │
  │ update(dt):
  │   read wired signals
  │   set drive.jogForward / drive.targetSpeed / etc.
  │
  ▼
RVDrive
  │
  │ update(dt):
  │   [1] call behaviors[].update(dt)     // behaviors set targets
  │   [2] apply physics (acceleration, limits)
  │   [3] applyToNode()                    // write to Three.js transform
  │   [4] onAfterUpdate?.()               // feedback signals
```

**Signal pattern:**
- **Input signals** (PLC → Drive): JogForward, JogBackward, TargetSpeed, DriveTo
- **Output signals** (Drive → PLC): CurrentPosition, CurrentSpeed, AtTarget, IsAtLimit

### 5.2 Sensor

**File:** `rv-sensor.ts`

Sensors detect MU (Moving Unit) presence via AABB intersection or raycast.

```
init():
  store.register(sensorName, sensorPath, false)
  wireBoolSignal(store, SignalOccupied, setter)

update(dt):
  occupied = checkCollision(MUs)    // AABB or raycast
  store.set(sensorName, occupied)   // → listeners notified → PLC reads this
```

### 5.3 LogicStep

**File:** `rv-logic-step.ts`

LogicSteps form a sequencer (SerialContainer/ParallelContainer):

```
State machine: Idle → Active → Waiting → Finished

Subclasses:
  LogicStep_SetSignalBool:   store.set(signalName, value)    on activate
  LogicStep_WaitForSignalBool: poll store.get(signalName)     each tick
  LogicStep_WaitForSensor:    poll store.get(sensorSignal)    each tick
```

LogicSteps read signals via `store.get()` in their tick function (polling, not subscription) because they need to check conditions synchronously within the simulation loop.

### 5.4 Source / Sink

- **Source**: Subscribes to a start signal → spawns MU when signal goes true
- **Sink**: Destroys MUs that enter its AABB zone

### 5.5 TransportSurface

- Reads a boolean start signal to enable/disable conveyor motion
- Speed comes from a linked Drive's current speed

---

## 6. External Interfaces — CONNECT / Live Mode

### 6.1 Buffer-Flush Pattern

All external interfaces (WebSocket Realtime, MQTT, TwinCAT HMI, CONNECT) use the same pattern defined in `base-industrial-interface.ts`:

```
┌─────────────────────────────────────────────────────────┐
│  Async Protocol Callbacks                                │
│  (WebSocket.onmessage, MQTT.on('message'), etc.)         │
│                                                          │
│  → bufferIncoming({ signalName: value, ... })            │
│    writes to pendingIncoming Map (dedup, last-wins)      │
└──────────────────────┬──────────────────────────────────┘
                       │
  ─── 60 Hz Simulation Loop ───────────────────────────────
                       │
  onFixedUpdatePre(dt):│  ← BEFORE drive physics
    flush pendingIncoming → signalStore.setMany(batch)
    pendingIncoming.clear()
                       │
  [Drive Physics, Sensor Updates, LogicStep Ticks]
                       │
  onFixedUpdatePost(dt):│ ← AFTER drive physics
    drain dirtyOutgoing → sendSignals(outgoing)
    dirtyOutgoing.clear()
                       │
  ─────────────────────────────────────────────────────────
```

**Why buffered?** Async protocol callbacks arrive on the event loop at arbitrary times. The buffer ensures all signal updates are applied atomically at a consistent point in the simulation frame — synchronized with drive physics.

### 6.2 Signal Registration

Registration is **conditional**, not unconditional
(`registerDiscoveredSignals()` in `base-industrial-interface.ts`). A
discovered name that already resolves to a path in the store — most importantly
a GLB **model** signal carrying its real scene path — is skipped:

```typescript
// base-industrial-interface.ts (simplified)
for (const sig of signals) {
  // A model signal already owns this name and its scene path — leave it alone.
  if (this.signalStore.getPath(sig.name) !== undefined) continue;
  signalStore.register(sig.name, `__iface__/${sig.name}`, sig.initialValue, plcType);
}
```

`register()` overwrites `nameToPath`, so re-registering a model signal under the
synthetic `__iface__/` placeholder would clobber `getPath()` and path resolution
for it. The interface only needs the *value* in the store, which the model
signal already provides; live values still flow through `set()`. A pure
interface-only symbol has no path yet and keeps the `__iface__/` placeholder as
before. When both a GLB value and an interface value exist for one name, the
interface value overwrites it on every flush (live-mode override).

Independently of that, every discovered signal is registered for **provenance**
via `signalStore.registerSignalProvider({ interfaceId, topic?, signal }, isConnected)`,
so liveness is evaluated per provider key rather than inferred from a value.

### 6.3 Outgoing Signal Tracking (realvirtual → PLC)

The method is `subscribeToOutgoingSignals()`, and it filters on
`direction === 'input'` — PLC **inputs** are the signals the PLC reads and
realvirtual writes:

```typescript
// simplified
subscribeToOutgoingSignals(signals) {
  for (const sig of signals) {
    if (sig.direction !== 'input') continue;   // only what realvirtual writes
    store.subscribe(sig.name, (value) => {
      // Don't echo back values we just received from the PLC
      if (this.pendingIncoming.has(sig.name)) return;
      this.dirtyOutgoing.set(sig.name, value);
    });
  }
}
```

### 6.4 CONNECT Integration

CONNECT uses the **existing WebSocket Realtime v2 protocol** — from realvirtual WEB's perspective, it's identical to connecting to Unity. realvirtual WEB doesn't know (or care) whether signals come from Unity or CONNECT:

```
Unity + PLC:     PLC → Unity → WebSocket v2 → realvirtual WEB
CONNECT + PLC:   PLC → CONNECT → WebSocket v2 → realvirtual WEB
```

Same protocol, same SignalStore, same React hooks, same behavior models.

---

## 7. React UI Binding — SignalStore to Components

### 7.1 useSignal — Event-Driven Binding

**File:** `hooks/use-signal.ts`

The primary hook for binding a React component to a single signal. The three
listings in §7.1–7.3 are **simplified** — they show the mechanism, not the
shipped source (which adds store-swap handling on model load/clear, type
narrowing and diagnostics):

```typescript
function useSignal(addr: string): boolean | number | undefined {
  const viewer = useViewer();
  const [value, setValue] = useState(() => viewer.signalStore?.get(addr));

  useEffect(() => {
    const store = viewer.signalStore;
    if (!store) { setValue(undefined); return; }

    setValue(store.get(addr));                    // sync initial
    return store.subscribe(addr, setValue);       // re-render on change
  }, [viewer, addr]);

  return value;
}
```

**Characteristics:**
- Re-renders **immediately** on every signal change
- Unsubscribes on unmount or addr change
- Re-subscribes on `model-loaded` / `model-cleared`

**Use case:** Control panels, status indicators, real-time displays

### 7.2 useSignalWrite — Write-Only Binding

```typescript
function useSignalWrite(addr: string): (v: boolean | number) => void {
  const viewer = useViewer();
  return useCallback(
    (v) => writerForCurrentStore().set(addr, v),
    [viewer]
  );
}
```

**Use case:** Buttons, sliders, input fields that write to PLC signals

### 7.3 useSignalTick — Polling Binding

**File:** `hooks/use-signal-tick.ts`

For UI that doesn't need instant updates (dashboards, badges):

```typescript
function useSignalTick(store: SignalStore, intervalMs = 200): number {
  const [tick, setTick] = useState(0);
  const lastVersion = useRef(-1);

  useEffect(() => {
    const id = setInterval(() => {
      if (store.version !== lastVersion.current) {
        lastVersion.current = store.version;
        setTick(t => t + 1);  // force re-render
      }
    }, intervalMs);
    return () => clearInterval(id);
  }, [store, intervalMs]);

  return tick;
}
```

**Characteristics:**
- Polls every 200ms (configurable)
- Skips re-render if no signals changed (version counter optimization)
- Lower CPU cost than per-signal subscriptions for many signals

**Use case:** Property Inspector

### 7.4 Component-Specific Hooks

| Hook | Data Source | Trigger | Use Case |
|------|-----------|---------|----------|
| `useDrives()` | `viewer.drives` | `model-loaded` event | Drive list in TopBar |
| `useSensorState(path)` | Viewer event | `sensor-changed` event | Sensor status indicator |
| `useInterfaceStatus(id)` | Viewer events | `interface-connected/disconnected` | Connection badge |
| `useDriveChartOpen()` | Viewer event | `drive-chart-toggle` | Drive chart overlay open/close state |
| `useSensorChartOpen()` | Viewer event | `sensor-chart-toggle` | Sensor chart overlay open/close state |
| `useKpiData()` | SignalStore + timer | Periodic polling | KPI dashboard cards |

### 7.5 Pattern Selection Guide

| Scenario | Hook | Why |
|----------|------|-----|
| Single signal, instant update | `useSignal` | Event-driven, minimal latency |
| Write a signal from UI | `useSignalWrite` | Stable callback ref, no re-render |
| Dashboard with many values | `useSignalTick` | Polling avoids per-signal subscription overhead |
| Drive/Sensor list | `useDrives` / `useSensorState` | Event-based, not signal-based |
| Drive/Sensor chart overlay state | `useDriveChartOpen` / `useSensorChartOpen` | Toggle chart panel visibility |

The actual chart data sampling / ring-buffer lives inside `DriveRecorderPlugin` / `SensorRecorderPlugin`, not in these hooks. `useDriveChartOpen()` / `useSensorChartOpen()` only return whether the chart overlay is open.

---

## 8. Component Registry — Auto-Mapping C# to TypeScript

### 8.1 Schema-Based Mapping

The ComponentRegistry (`rv-component-registry.ts`) maps C# component types to TypeScript implementations:

```typescript
registry.register('Drive', {
  factory: (node, extras) => new RVDrive(node, extras),
  schema: {
    TargetSpeed:   { type: 'number', default: 100 },
    Acceleration:  { type: 'number', default: 200 },
    Direction:     { type: 'enum', enumMap: DriveDirectionMap, default: 0 },
    JogForward:    { type: 'componentRef' },  // resolved in Phase 2
    JogBackward:   { type: 'componentRef' },
  }
});
```

### 8.2 Schema Types

| Schema Type | rv_extras Value | TypeScript Result |
|-------------|----------------|-------------------|
| `number` | `42.5` | `Number(42.5)` |
| `boolean` | `true` | `Boolean(true)` |
| `string` | `"hello"` | `String("hello")` |
| `vector3` | `{x, y, z}` | `new Vector3()` (with coord transform) |
| `componentRef` | `{type, path, componentType}` | Resolved to signal address or component instance in Phase 2 |
| `componentRefArray` | `[{...}, {...}]` | Array of resolved refs |
| `enum` | `1` | Looked up via `enumMap` |

### 8.3 ComponentRef Resolution

In Phase 2, ComponentRefs are resolved based on their `componentType`:

```
PLCOutputBool/Float/Int → resolves to signal address (string)
PLCInputBool/Float/Int  → resolves to signal address (string)
Sensor                  → resolves to RVSensor instance
Drive                   → resolves to RVDrive instance
IKPath/IKTarget         → resolves to component instance
Other                   → resolves to node path (string)
```

---

## 9. Signal Lifecycle — Complete Example

A conveyor start button pressed in the realvirtual WEB React UI:

```
1. User clicks button in React HMI
   └─ useSignalWrite("ConveyorStart") → store.set("ConveyorStart", true)

2. SignalStore.set()
   └─ equality check (was false, now true) → update + notify
   └─ version++ (for polling hooks)
   └─ notify listeners:
       ├─ Interface subscriber → dirtyOutgoing.set("ConveyorStart", true)
       ├─ ConnectSignal subscriber → copies to linked signals
       └─ React useSignal subscriber → setValue(true) → re-render

3. onFixedUpdatePost (60Hz, after physics)
   └─ Interface.sendSignals({ "ConveyorStart": true })
   └─ WebSocket/MQTT/TcHmi → PLC receives the signal

4. PLC sets ConveyorSpeed = 500mm/s (output signal)

5. Interface receives PLC response
   └─ bufferIncoming({ "ConveyorSpeed": 500 })

6. onFixedUpdatePre (next frame, before physics)
   └─ signalStore.setMany({ "ConveyorSpeed": 500 })
   └─ Drive_Simple behavior reads ConveyorSpeed → sets drive.targetSpeed
   └─ TransportSurface starts moving MUs

7. React hooks update
   └─ useSignal("ConveyorSpeed") → re-renders speed display
   └─ useSignalTick → version changed → Inspector badge updates
```

---

## 10. Key Design Principles

### Signal-Agnostic Components

Drives, sensors, and LogicSteps read/write signals by name. They don't know whether the signal comes from:
- GLB defaults (standalone simulation)
- Unity via WebSocket (live mode)
- CONNECT via WebSocket (direct PLC)
- MQTT broker (IoT mode)
- TwinCAT HMI server (Beckhoff direct)

This makes adding new signal sources trivial — implement `BaseIndustrialInterface`, connect to SignalStore, done.

### Accessing SignalStore from Plugins

Plugins that extend `BaseViewerPlugin` can access signals via the
`PluginContext` live-getter:

```typescript
// ctx.signals is a live getter — returns null before model load.
// Prefer this in init() callbacks and onTick() handlers:
const signals = this.context.signals;
if (signals) {
  signals.setMany({ ConveyorStart: true, Speed: 500 });
}
```

The context preserves the existing `get`, `set`, `setMany`, and `subscribe`
surface, but its write methods are a per-plugin writer handle automatically
bound to the plugin id. The getter stays live across model reloads and returns
`null` before a model is loaded.

### Subscription vs Polling

| Pattern | When to Use | Cost |
|---------|------------|------|
| `subscribe()` | Single signal, instant response needed | 1 callback per change per listener |
| `version` polling | Many signals, periodic UI refresh | 1 interval timer, 1 integer compare |
| Direct `get()` | Synchronous read in simulation loop | Zero overhead (Map.get) |

### Atomic Batch Updates

`setMany()` ensures all interface signals are applied in one shot before any listener fires. This prevents intermediate states where some signals are updated but others aren't — critical for coordinated PLC logic.

### No Signal Validation

Type coercion happens on read (`getBool`, `getFloat`), not on write. Any value can be set for any signal. This matches Unity's behavior where signals are dynamically typed.
