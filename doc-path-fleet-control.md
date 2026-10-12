# Path-Based Vehicles & Fleet Control (AGV/FTS)

> **Applies to:** Path and fleet runtime APIs are in Community. DES execution requires the commercial beta DES feature; browser asset authoring may require commercial modules.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

How autonomous vehicles ride the path graph, how traffic works in both
simulation kernels, and — most importantly — **where project-specific logic
(work plans, dispatching, stations) hooks in**. The engine ships mechanics
only; everything order-shaped is project code, in TypeScript or JS-in-GLB.

Origin: plan-268 (substrate, vehicle, traffic), plan-921 (task control, docks,
destination routing, DES queueing parity, authoring).

Related docs: `doc-behavior-modelling.md` (the one-definition/two-kernels
component model), `doc-extending-webviewer.md` §13 (the per-model plugin
loading mechanism this builds on).

---

## 1. The layer cake

```
┌────────────────────────────────────────────────────────────────────┐
│ PROJECT LOGIC (yours)                                              │
│   Work plans, order pools, dispatching, station behavior           │
│   → TypeScript project plugin  OR  JS-in-GLB script                │
├────────────────────────────────────────────────────────────────────┤
│ CONTROL SEAMS (engine, stable API)                                 │
│   AgvFleet (tasks) · PathDockRegistry (stations) ·                 │
│   PathNetworkRouter (junctions) · ZoneRegistry (mutual exclusion)  │
├────────────────────────────────────────────────────────────────────┤
│ VEHICLE MECHANICS (engine — src/behaviors/Agv.ts)                  │
│   Ramped accel to TargetSpeed · car-following headway ·            │
│   zone claims · shortest-path destination routing · service stops  │
├────────────────────────────────────────────────────────────────────┤
│ PATH SUBSTRATE (engine — rv-path*.ts)                              │
│   rv_extras.Path segments (line/arc) · arc-length addressing ·     │
│   graph via successors · PathTraveler · path visualizer            │
└────────────────────────────────────────────────────────────────────┘
```

The engine never decides *where* a vehicle should go or *what happens* at a
station. It guarantees the physics-free driving model: no raycasts, no
colliders, deterministic, DES-capable.

---

## 2. Paths (authoring)

A path is a node carrying `rv_extras.Path` — a chain of `line`/`arc` segments
in world meters, graph-linked by ids:

```jsonc
{
  "id": "PathSouth",
  "segments": [ { "kind": "line", "from": [-5,0,-3], "to": [5,0,-3] } ],
  "successors": ["PathEast"],      // graph edges (junction = >1 successor)
  "closed": false,                  // circulating loop (no end node)
  "zone": "EastCurve",              // control-point zone (optional)
  "zoneCapacity": 1
}
```

`Path` is a fully **authorable, generic component** (plan-921): create an
empty node, add `Path`, edit `segments`/`successors` — via inspector, the
generic MCP tools (`web_editor_add_component`, `web_editor_set_field`,
`web_component_set`) or directly in a GLB. `parsePathExtras()` in
`src/core/engine/rv-path.ts` is the executable SSOT of the schema. Every
registered path renders as a ground polyline (`path-visualizer-plugin.ts`:
teal, zoned = orange, chevron = travel direction at the hand-off point).

Field edits re-register live (`RVPathComponent.reapplyConfig()` — id changes,
re-linking and zone re-definition included).

### 2.1 Planner editing, snappoints, re-projection (plan-447)

**Visualisation.** `path-visualizer-plugin.ts` owns EXACTLY ONE renderer per
path (`pathId → LineSegments2`, fat lines with screen-space constant width).
Hovering a path widens and re-colours that path only; planner mode raises the
base width and adds drag handles. Never build a second path renderer — extend
this plugin.

**Snappoints.** Every OPEN path exposes two snappoints, derived from the
segment data by `getPathEndpoints()` (rv-path.ts): start = flow `in`, end =
flow `out`, axis code from the dominant component of the outward vector. They
live in the ordinary `SnapPointRegistry` (`PathSnapSource`,
`src/plugins/snap-point/path-snap-source.ts`), so the marker renderer, the
magnetic controller and the snap tools treat them like any other port. A closed
loop has no free ends and therefore no snappoints.

**Editing.** In planner mode each chain vertex (and both free chain ends) is a
draggable handle; arcs get a CENTER and a RADIUS handle — a free arc-endpoint
drag is underdetermined without a tangent constraint and is an explicit
non-goal. Dragging a shared vertex updates BOTH adjacent line segments in one
step, so the chain never tears. The pure maths lives in
`src/core/engine/rv-path-edit.ts` (`derivePathHandles` / `movePathHandle` /
`snapDragTarget`); handles are picked as AUX RAYCAST TARGETS
(`addAuxRaycastTarget`, [public picking and cleanup contract](doc-extending-webviewer.md#picking-and-cleanup)) — never via layer bits.
While dragging, only the preview geometry is rebuilt; on release the new
segment list is committed as an ordinary `setField` op on the generic `'json'`
field `segments`, so undo/redo and the save roundtrip come for free.

**Rastung targets (F4).** An endpoint drag rasts onto the nearest compatible
point within ~0.35 m. The visualizer enumerates the free ends of every
other path itself; STATION snappoints come from the snap-point plugin, which
pushes them in through `PathVisualizerPlugin.addSnapCandidateSource()` (core
must not import a plugin registry). A dragged path START (flow `in`) only sees
`out`/`bidi` ports and vice versa; occupied ports are skipped.

**Who owns the pointer.** A handle grab belongs to the visualizer alone: it
wires its `pointerdown` in `init()` (before the layout-planner, which wires in
`onModelLoaded`) and calls `stopImmediatePropagation()` on a hit -- plain
`stopPropagation` does NOT stop a sibling listener on the same canvas. The
planner additionally bails out of its marquee while a handle drag is in flight
(`canvas-interaction.ts`), the same belt-and-braces as the FloorGizmo pair.

**Three invariants a live edit must not break** (each has a test in
`tests/path/`):

1. **Zone claims survive.** `reapplyConfig()` uses
   `ZoneRegistry.redefine(zoneId, capacity)` — capacity HARD-overwritten (a
   SHRINK must take effect; `define()` is max-wins), holders untouched.
   `undefine()` (definition AND holders) stays the MODEL-CLEAR route
   (`dispose()`). Freeing a held claim mid-edit would put two vehicles into one
   exclusive zone.
2. **Travelers are re-projected, not re-pointed by accident.** `RVPath` is
   readonly and gets REPLACED, so every traveler on the edited path re-fetches
   through `network.get(pathId)` and gets `traveler.path` REASSIGNED
   (`reprojectTravelersOnPath`, rv-path-network.ts). `s` is clamped into the
   new length (closed paths wrap); a vehicle parked at the end (`atEnd`,
   waiting for a dock's `release()`) STAYS at the end. The fleet iteration is
   owned by `SpacingController.forEachOnPath(pathId, fn)` — the only
   fleet-wide registry of live travelers.
3. **Everyone learns about it through one channel.**
   `RVPathNetwork.onPathChanged(pathId)` / `notifyPathChanged(pathId)`. The
   payload is the ID, never the (already replaced) object. An id rename
   announces both the old and the new id.

## 3. The vehicle (`Agv` library component)

Binds automatically to placed assets whose name matches `*Agv*`/`*AGV*`.
Config (rv_extras / `web_component_set`):

| Field | Meaning |
|---|---|
| `PathId` | starting path (else: first Path node under the root) |
| `StartPosition` | initial arc position, mm |
| `TargetSpeed` / `Acceleration` / `UseAcceleration` | drive-parity ramp (mm/s, mm/s²) — continuous acceleration up to max speed |
| `SafetyDistance` / `MinGap` / `LookAhead` / `HeadwayGain` | distance control (see §5) |
| `Destination` / `ServiceTime` | declarative one-shot task (no callbacks): drive there, wait, idle |

Signals per instance: `<Name>.Agv.Run` (command in — stop/resume anywhere,
ramped), `.Moving`, `.Position` (mm), `.AtNode` (pulse), `.Blocked`.

## 4. Tasks — the low-level control primitive

One command shape, deliberately minimal (`src/core/engine/rv-agv-fleet.ts`):

```ts
interface AgvTask {
  destination: string;    // ANY path segment id — vehicle stops at its END
  serviceSec?: number;    // time at the destination
  onArrive?:     (agvId, task) => void;  // service START
  onServiceEnd?: (agvId, task) => void;  // service END — assign next task here
  data?: unknown;         // your payload (order id, …)
}
```

Semantics:

- No task → the vehicle **cruises** (`successors[0]` forever — the plain demo
  behavior).
- `fleet.get(id).assign(task)` → drive to the destination by **shortest
  driving distance**, stop at the segment end, `onArrive`, wait `serviceSec`,
  `onServiceEnd`. Assigning the next task inside `onServiceEnd` chains a work
  plan seamlessly; without one the vehicle parks **idle** and the fleet's
  `onIdle` channel fires (your dispatch trigger).
- `clear()` → back to cruising. Simulation reset clears imperative tasks
  (re-assign on `simulation-start`); the declarative config task re-arms.

Junction resolution order (installed per vehicle, identical for the look-ahead
prediction and the actual hand-off):

1. **Central router** (`network.setRouter(...)` — the "superordinate control")
2. **Shortest driving distance** to the task destination (Dijkstra over path
   lengths, memoised, invalidated on graph change — `nextHopToward`)
3. `successors[0]`

## 5. Traffic — both kernels

**Legacy step mode (`UseAcceleration = false`, continuous):** 1D arc-length car-following. The follower ramps down
to standstill at `SafetyDistance` behind its leader (hard floor `MinGap` —
never penetration), restarts smoothly; zones are claimed within `LookAhead`
before entry (queue-order aware: a follower never claims across its leader).
Service/destination stops are positioning stops — the drive ramp decelerates
into them.

**Since plan-558 both kernels run the SAME trajectory-based moving block**
(`rv-movement-authority.ts`, see doc-webviewer.md › Path Simulation): closed-form
speed profiles (braking exactly into the stop, curve and docking limits), a
follower keeps `SafetyGap` behind the leader's rear along its planned
trajectory, zones are claimed before the front enters and released when the
rear has left, a release wakes the waiters. The DES kernel schedules one leg
event per plan (no per-segment occupancy rule, no re-poll); queues close up
with a constant gap. The continuous car-following above remains the
`UseAcceleration = false` mode.

Rule of thumb for layouts: give every merge one common zone (the merging
pieces and the successor) — the load-time check reports merges without one in
the Problems panel. Splitting long paths into pieces is no longer needed.

## 6. Docks — the generic path↔station adapter

`src/core/engine/rv-path-dock.ts`. A dock binds ANY handling endpoint (a DES
work station, a conveyor head/tail, a charging bay, plain project code) to a
path segment's end — and **the dock owns the stay**:

```ts
getDefaultPathDockRegistry().register('StationPath7', {
  onVehicleArrive(agvId, release) {
    // your handling: timer, DES event, MU handshake, PLC wait …
    somethingAsync().then(release);   // release() → vehicle drives on
  },
});
```

- Acts on **every** vehicle that completes the segment (like a station on a
  conveyor line) — place docks on dedicated station segments.
- A dock **overrides** the task's `serviceSec` at that segment (the station
  knows its handling time better than the fleet order does). Task callbacks
  still fire around the stay.
- Works in both kernels; `release()` is idempotent and may be synchronous.

## 7. Where project code hooks in

**Native TypeScript:** bind a module under your project's `plugins/` folder through
`documents[].scriptRef`. Start with the public
[project plugin example](doc-project-plugin-example.md), including the registration
pair, compilation and cleanup. No private repository or collecting index is required.

For engine-level fleet logic, the public source APIs are
[`rv-agv-fleet.ts`](src/core/engine/rv-agv-fleet.ts),
[`rv-path-dock.ts`](src/core/engine/rv-path-dock.ts) and
[`rv-path-network.ts`](src/core/engine/rv-path-network.ts). Integrate those as a
viewer-build extension so it uses the host's registry instances. Do not bundle
copies of these singleton registries into a runtime project module. Build-time
private project packs are a maintainer integration route, not a Community prerequisite.

Dispose the unsubscribe functions returned by event/fleet subscriptions when your
plugin unregisters. See [Extending WEB](doc-extending-webviewer.md) for the distinction
between application extensions and project modules.

**JS-in-GLB (sandboxed, ships with the file — for light logic):** a
`WebComponent` script declaring `routing.*` handlers (`selectNextPath`,
`onArrive`, `requestDispatch`) and using the `paths` SDK backend (id-based
descriptors, zone claim/release — the SAME registries the engine uses). See
`rv-sdk-paths.ts`.

Both meet the same seams; a registered central router always wins the junction
decision.

## 8. Known limitations (plan-921 state)

Projects that need arcade vehicle dynamics can use `PathTraveler` directly while retaining `RVPathNetwork`, its central router and `nextHopToward` routing; the private `agv-maze` project is an example. It omits the `Agv` behavior's acceleration, spacing and fleet-task/DES coupling. Its player decides whether to stop before `advance()` and reports node arrival itself, because a routing hook cannot hold a traveler at a junction. Moving meshes are loaded separately from the document's static batching pipeline, and project teardown releases the router, paths and owned rendering resources.

- **Scene-based projects**: model-plugin matching is keyed to the loaded MODEL
  name; a planner SCENE loads under its scene body URL, so project plugins do
  not (yet) fire for pure-scene projects. Pending: match on the ACTIVE
  project as a fallback.
- **Double-load ghosting**: loading the same saved scene twice in one session
  (URL autoload + explicit open) adopts placements twice — ghost travelers
  block the headway chain. Pending: tree-idempotent adoption / full teardown
  of the previous generation.
- DES `Run` toggling is boundary-granular (mid-leg stop is continuous-only —
  by design, see §5).
