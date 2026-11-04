# Path-Based Vehicles & Fleet Control (AGV/FTS)

> **Applies to:** Path and fleet runtime APIs are in Community. DES is part of the Community edition (AGPL); browser asset authoring may require commercial modules.
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
  "zoneCapacity": 1,
  "connectCheck": true              // false = deliberate crossing, skipped by the successor check
}
```

`Path` is a fully **authorable, generic component** (plan-921): create an
empty node, add `Path`, edit `segments`/`successors` — via inspector, the
generic MCP tools (`web_editor_add_component`, `web_editor_set_field`,
`web_execute("component.setFields", {path, type, props})`) or directly in a GLB. `parsePathExtras()` in
`src/core/engine/rv-path.ts` is the executable SSOT of the schema. Every
registered path renders as a ground polyline (`path-visualizer-plugin.ts`:
teal, zoned = orange, chevron = travel direction at the hand-off point).

Field edits re-register live (`RVPathComponent.reapplyConfig()` — id changes,
re-linking and zone re-definition included).

### 2.1 Planner editing, snappoints, re-projection (plan-447)

**Visualisation.** `path-visualizer-plugin.ts` owns EXACTLY ONE renderer per
path (`pathId → LineSegments2`, fat lines with screen-space constant width).
Every path is drawn in one plain green (straights, curves, zoned or not).
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
point within ~0.35 m. Rasting onto another path END writes the `successors` link on release
(§ 2.2). The visualizer enumerates the free ends of every
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

1. **Zone claims survive.** `reapplyConfig()` moves the path's zone
   DECLARATION from the old `RVPath` object to the new one
   (`ZoneRegistry.replaceDeclaration`, plan-647): the own declaration is set
   HARD (a SHRINK must take effect against the own earlier value; other paths
   declaring the same zone still count, MAX-WINS), holders untouched — also
   when the path leaves its zone (the old zone stays "undeclared" with the
   vehicle inside). The swap is finished before the availability notification
   goes out. An unparsable payload keeps the declaration until it is repaired
   or the path is disposed. Freeing a held claim mid-edit would put two
   vehicles into one exclusive zone. See §10 for the declarants.
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

### 2.1a Structural verbs: sweep, append, remove, split (plan-453)

The plan-447 handles MOVE a path; four verbs RESHAPE it — they change the
LENGTH of the segment list (or an arc's opening angle):

| Verb | Command (`PathVisualizerPlugin`) | Pointer affordance | Effect |
|------|----------------------------------|--------------------|--------|
| Arc opening angle | `setArcSweep(pathId, segIndex, degrees)` | sweep handle at the arc END (`s<i>`, arc colour) | only `degrees` changes, magnitude clamped to [1°, 360°], sign kept; the point runs on the circle |
| Append | `appendPathSegment(pathId, 'start' \| 'end')` | green `+` beyond a free end of the selected path | same kind AND same dimensions as the neighbour, continued tangentially (a line repeats its vector, an arc continues on its own circle); empty list → 1 m line along +X |
| Remove | `removePathEndSegment(pathId, end)` | red `−` further out | only at a chain END, never the last segment, never on a closed path |
| Split | `splitPathSegment(pathId, segIndex, t01)` | Alt-click on the selected path (≤ 8 px) | geometry-neutral: a line splits at `p`, an arc divides its signed sweep (`startAngle + σ·t`); pieces < 1 mm are refused |

The pure maths is in `rv-path-edit.ts` (`setArcDegrees`, `appendSegment`,
`removeEndSegment`, `splitSegment`, plus the reads `projectToSegment`,
`locateArcLength`, `pickSegmentPoint`); the plugin maps pointer rays onto the
arc's OWN plane (XZ, XY or YZ — not the fixed floor plane of the plan-447
drags). The "selected path" is the one the viewer selection resolves to (the
node, an ancestor carrying a Path, or the first Path below a selected layout
instance) — or the path whose handle was grabbed last, because a bare path node
is not selectable in the planner.

**Only in the reset state.** Every verb — and the sweep handle and endpoint
chrome themselves — exists only while `isStructuralPathEditAllowed(viewer)`
holds: the runtime is `detached`, OR it is `paused` (read from
`SimulationRuntime.state`, never from the DES manager's own pause flag, which
`reset()` clears) AND `viewer.simTime === 0` AND the DES render clock
`=== 0`. The render clock matters because the DES event time stands still
between events: paused a few ticks after Play, before the first event at
t > 0, vehicles are visibly under way with `simTime` still 0. Operation:
pause, reset, edit. A refused verb returns `{ ok: false, reason: 'sim-locked' }`
and changes nothing. There is no re-projection question for structural
verbs — nothing is moving.

**One transaction, then a reset.** A verb writes `segments` (and, for a
change at the chain START, the `StartPosition` of every Agv whose RESOLVED
start path — fleet handle `startPathId` — is this path, by ±ΔL, clamped at 0)
as ONE transaction labelled `Path verb: …`. Inside the document queue each
write re-checks the lock; a lock that flipped in between rolls the transaction
back (`sim-locked`), an executor failure too (`commit-failed`). After success
the verb calls `resetSimulation()`: vehicles, MUs and zones re-derive from the
NEW geometry. That works because the Agv reset re-resolves its start path from
the network (configured `PathId` first, else the old start path's id) and
recomputes the start position from the configuration — `reapplyConfig()`
replaced the `RVPath` object, the old one is gone.

**Undo / redo obey the same lock.** The plugin adds a history GUARD to the scene
document (`RvDocument.addHistoryGuard`, an additive hook next to the one
journal interceptor of the signal rename): an undo / redo of a `Path verb: …`
entry outside the reset state is refused (stacks and scene unchanged); inside
it, the entry is applied and followed by the same `resetSimulation()`.
Ordinary entries (a plan-447 handle drag) are not affected.

### 2.2 Path topology: successors written on snap, checked on load (plan-633)

`successors` stays the stored truth of the network topology — Unity exports, MCP `setField`
and the inspector keep writing it. What is new: the planner writes it when two ends snap, and
a core service checks it after every load. Both use ONE criterion
(`src/core/connect/path-link-tolerance.ts`, shared with plan-628):

```ts
PATH_LINK_TOLERANCE = { distM: 0.005, tangentDeg: 2 }   // both bounds inclusive
```

END(A) continues into START(B) when the two points are at most **5 mm** apart and the
**travel tangents** (`PathEndpoint.tangent`, both pointing along travel — not the opposed
`outward` vectors) differ by at most **2°**. Never START/START, never END/END, never a path onto
itself, never a closed path (it has no free ends).

**Topology from geometry** (`src/core/connect/path-topology.ts`):

- `pairPathEnds(network)` — ALL directed links END → START within the tolerance. Not
  exclusive: a branch (A → B, A → C) and a merge (B → D, C → D) are complete, and the result
  is the same whatever the order of the paths (sorted by `from`, then `to`). This is the
  contract plan-628's auto-link builds on. Candidates come from a `SpatialGridXZ` over the
  path starts (plan-644): each END queries the search radius `max(PATH_END_NEAR_MISS_M,
  distM + PATH_LINK_BOUND_EPS)`, so links and near misses are both covered; the hits are visited
  in the old pair order with the unchanged 3D tests — same findings, same order as the former
  O(P²) scan (`tests/connect/path-topology-grid.node.test.ts`). A tolerance or coordinates the
  grid cannot serve keep the O(P²) scan.
- `analysePathEnd(network, pathId, 'start' | 'end')` — the links and near misses of ONE end
  (tagged `kind: 'link' | 'near-miss'`), exactly the subset of `analysePathEnds` touching it, in
  the same order; O(P).
- `diffSuccessors(network, pairs)` — per path: **missing** (geometric link not declared),
  **extra** (declared, no matching end in either direction), **reversed** (declared, but the
  geometry runs the other way — reported once, on the declaring path) and **unknown** ids.
- `planSuccessorChanges(path, ops)` — several `add` / `remove` changes of one path folded in
  order (the list form of `planSuccessorChange`); `applied[k]` tells which op changed the list,
  null when none did.
- `applySuccessorLink(write, target)` — the write seam: `rv_extras.Path.successors` on the node,
  `RVPathComponent.reapplyConfig()` (a FRESH `RVPath` replaces the old one — the `readonly`
  `successorIds` array is never mutated), then an awaitable `setField` op on the active edit
  target. Inside a transaction it joins it; a refused op reverts the runtime write.

**Writing on snap (planner).** Releasing an endpoint drag in `path-visualizer-plugin.ts` that
rasted onto another path end writes the link in the direction the ends imply: our END onto
their START → `ours.successors += theirs`; our START onto their END → `theirs.successors +=
ours`. A link of the dragged end that the drag pulled apart is removed. Before and after the
write only the dragged end is analysed (`analysePathEnd`), and the changes are folded per source
path with `planSuccessorChanges`. Nothing is written when
the drag rasted START onto START / END onto END, or when the ends meet but the directions differ
by more than 2° — the planner never writes what the check would report.
`PathVisualizerPlugin.whenCommitted()` reports the outcome (`successorChanges`, `linkSkipped:
'same-end' | 'tolerance'`). `segments` and every `successors` write are ONE transaction of the
active edit target: one undo step, and a failed commit leaves nothing half written (the
transaction rolls back what it applied, the runtime returns to the pre-drag state).

**Checking on load.** `viewer.pathTopologyCheck` (`src/core/connect/path-topology-check.ts`) is a
core service, mode-independent and without the snap-point plugin. It runs after
`viewer.whenSceneReady()` — stored `addNode(Path)` nodes and placed references are created after
`model-loaded` — triggered by `model-loaded`, `scene-loaded`, `placements-materialized`, layout
content added/removed and live path edits; all triggers until the scene is ready collapse into one
check. A load superseded (`model-cleared`) or failed while it waited reports nothing. It never
corrects anything; it reports to the Problems panel:

| Code | Severity | When |
|---|---|---|
| `path-successor-mismatch` | warning | per path with missing / extra / reversed / unknown successors (id `path-successor-mismatch:<pathId>`) |
| `path-end-near-miss` | info | an END stops 5…30 mm before a START (`PATH_END_NEAR_MISS_M`) — not connected geometrically (id `path-end-near-miss:<from>><to>`) |

Both codes are cleared on every run and on `model-cleared`. The shipped scenes (AGVDemo, Course,
AGVFactory, PalletYard) report **0** of either (`tests/connect/path-topology-scenes.node.test.ts`).

**Opt-out.** A deliberate crossing or bridge whose ends touch other paths without being
connected sets `"connectCheck": false` in `rv_extras.Path`. The path is then left out of the
check in both directions — its own successors are not checked, and links to or from it are
neither expected nor reported. Only an explicit `false` opts out.

### 2.3 Building the network from blocks (plan-628)

A path network can be authored from **blocks** instead of single paths: straight and curve pieces
that snap tangent-true onto free ends, and junction blocks (diverge, merge, stub) that are set ONTO
an existing path. A block is a unit — it is selected, moved, rotated and removed as one — but what
it stores is ordinary `rv_extras.Path` children, so the drive, traffic and DES code see plain paths.

**Persistence.** Everything lives under one empty node `PathNetwork` in the layout document:
`PathNetwork/PN_Block_<n>` carries `rv_extras.PathBlock` (`kind`, `params`, `pose` = `[x, z, headingDeg]`,
`y`, `hostPathId` / `frontPathId` for junctions, `edited`), its children are the paths
(`PN_S<n>` straights, `PN_C<n>` curves, `<host>_F<k>` for the front piece a junction cuts off a
foreign path). The block node's own transform stays identity (segments are world-space); a
non-identity transform is reported as `path-block-transform-not-identity`. Unity ignores
`PathBlock` (unknown component), the paths stay valid there.

**Code.** Pure core: `src/core/engine/rv-path-blocks.ts` (templates, tangent alignment, rigid XZ
move, ids), `rv-path-network-ops.ts` (`placeBlock`, `placeJunction`, `moveBlock`,
`relocateJunction`, `removeBlock` with healing, auto-link via `isPathLink` / `PATH_LINK_TOLERANCE`
from plan-633), `rv-path-network-validate.ts` (issues). Viewer side:
`src/plugins/path-network/` — `path-network-commands.ts` (the `layout.path.*` commands),
`path-network-scene.ts` (snapshot from the nodes, `NetworkEdit` → document ops),
`path-network-validation.ts` (live publisher + rings), `path-network-ui-*.ts` +
`PathNetworkToolbar.tsx` (planner UI).

**Commands, not tools.** Every change is one `layout.path.*` command (`list`, `place`, `junction`,
`dock`, `move`, `remove`, `setParams`, `replace`, `copy`, `paste`, `reset`, `validate`), reachable from MCP through `web_execute` /
`web_batch` (no `web_layout_path_*` tools). Each writing command is ONE transaction labelled
`Path verb: …` — one undo step, refused with `sim-locked` unless the simulation is in the reset
state (the 453 lock), followed by snap sync, `onPathNetworkChanged()` and `resetSimulation()`.
Refusals of the pure ops come back as reasons: `host-too-short` (without an envelope, a junction needs 1.8 m lead-in +
0.6 m run-out on its host), `closed-host`, `imported-path`, `path-in-block`, `wrong-kind`,
`not-tangential`, `composition-owned` (see below).

#### Docking a stub to a station (plan-636)

`layout.path.dock` creates a stub for a node carrying `TransferStation`. In an authoring mode,
right-click that node and choose **Dock stub to path network**, or use the button in its
TransferStation inspector section. Automatic docking while dragging or dropping a catalog item
is not yet implemented. This action authors geometry; it does not implement material transfer.

| Argument | Meaning |
| --- | --- |
| `station` | Required node path or unique name resolved by `findNodeForUser`. |
| `pathId` | Optional host path id; otherwise reuse the old stub's host on re-dock, or search by ray. |
| `port` | Optional port node name, used only when `TransferStation.DockPort` is empty. |
| `radiusM` | Positive mouth radius in metres; default `1.5`. |
| `maxDepthM` | Positive ray search depth in metres; default `10`; applies only to automatic host search. |

A dock port is a placement snap with `typeId = 'path'` in the station node's subtree,
including materialized placement content. Derived path-end snaps (`path-snap:` ids) are excluded;
the world normal must have a nonzero XZ projection. Occupancy does not exclude a port from
re-docking. There is no new snap type or pairing rule. Selection uses saved `DockPort`, then
the `port` argument, then the sole eligible port. Multiple ports require a choice; duplicate
port names are always ambiguous. The **Dock port** select lists these names and **(auto)**;
a saved name that disappeared is shown as **(missing)**.

The seat is the world position of resolved `TransferStation.SeatNode`, otherwise the port.
Direction comes from the port's world frame, projected onto XZ, not its name's N/P flow sign.
The host search casts from the seat in that direction: the first forward hit within the depth
wins, with hits less than 1 mm apart ordered by path id. A foreground arc is refused, not skipped.
The seat's perpendicular foot and the mouth must fit on the same straight host segment.

The actual stub axis `a` points perpendicular to the host toward the lane. With load offset
`offsetM` (§12), the vehicle root at the stub start is `H = seat + a * offsetM`; its load centre
is `H - a * offsetM`. The port may differ from that axis by at most 1.0°. The straight must be
at least 0.10 m long before the 90° mouth. Geometry is checked against the placed template
within 1 mm in XZ; elevation comes from the host.

<svg viewBox="0 0 760 240" role="img" aria-labelledby="dock-title dock-desc" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;color:inherit">
<title id="dock-title">Station seat and docked stub, top view</title>
<desc id="dock-desc">A positive load offset separates the station seat from the vehicle root at the stub start. The straight continues toward the lane, then a 90 degree mouth joins the host in its travel direction.</desc>
<g fill="none" stroke="currentColor" stroke-width="2">
<rect x="20" y="75" width="85" height="90" rx="6"/>
<path d="M75 120 H210" stroke-dasharray="6 4"/>
<path d="M210 120 H500 Q560 120 560 180 M560 30 V225"/>
<path d="M550 210 L560 225 L570 210 M195 112 L210 120 L195 128"/>
<circle cx="75" cy="120" r="5"/><circle cx="210" cy="120" r="5"/>
</g>
<g fill="currentColor" font-family="sans-serif" font-size="14">
<text x="20" y="60">Station seat</text><text x="112" y="100">Load offset</text>
<text x="170" y="155">Stub start H</text><text x="300" y="105">Stub straight</text>
<text x="370" y="195">90° mouth</text><text x="580" y="80">Host lane</text>
<text x="580" y="215">Travel direction</text>
</g>
</svg>

The command writes `TransferStation.PathId` to the new stub straight's id and `DockPort` to
the selected port name together with all network changes in **one undo step**,
`Path verb: Dock stub to station`. For placement content, station fields use the placement
override mechanism. Re-docking removes the existing stub block, heals its host and creates
the replacement atomically. An existing `PathId` pointing to a non-stub path is refused;
a missing referenced path permits a fresh dock. A failed dock leaves the document unchanged.

The result contains `blockId`, `stubPathId`, `hostPathId`, `s` (host arc length in metres),
`side` (`left`/`right`), `stubStraightM`, `dockPort`, `loadOffsetMm`, `loadOffsetSource`
(`vehicle`/`design`/`none`) and `envelopeSource` (`fleet`/`design`/`explicit`/`none`).
`replacedBlockId` appears only on replacement; optional `warnings` contains
`load-offset-ambiguous`, `load-offset-missing` and/or `stub-shorter-than-body`.

Refusal codes are `no-transfer-station`, `station-not-editable`, `dock-snaps-unavailable`,
`dock-port-missing`, `dock-port-unknown`, `dock-port-ambiguous`, `dock-no-host`,
`dock-host-not-straight`, `dock-not-perpendicular`, `dock-too-close`,
`dock-internal-mismatch` (also nonpositive radius/depth), and `already-docked-foreign`.
Normal network-operation refusals still apply, including `host-too-short`, `imported-path`,
`composition-owned` and the simulation lock `sim-locked`.

Live checks use stations with a resolvable dock port and nonempty `PathId`.
`path-dock-stub-missing` (**Docked stub missing**) means that path no longer exists.
For an existing path whose first segment is a line, `path-dock-misaligned`
(**Station dock misaligned**) compares the load centre at that line's start with the seat:
more than **10 mm in XZ** or **1.0°** between port direction and line axis warns.
These are quiet warnings, so Problems does not open automatically. A dock-pose signature
checked every 500 ms catches station movement and rotation, including undo/redo.

**The network is always tangential (plan-628 8.10, E52).** No authoring action writes a connected
edge with a kink or a gap. The op runner of `rv-path-network-ops.ts` checks every edge an op WRITES
(new, or with an end whose geometry changed) against `isPathLink` (≤ 5 mm, ≤ 2°,
`nonTangentialWrites`) before the edit is produced. A violation refuses the whole op with
`not-tangential` (text `NOT_TANGENTIAL_TEXT`); for `moveBlock` (drag drop, R, MCP `layout.path.move`)
the policy is *release* instead: such an edge is dropped in the same edit and both ends stay open.
`linkEnds` refuses ends that meet but turn by more than 2° as `not-tangential` (more than 5 mm apart
stays `invalid-link`). Deleting a junction whose host no longer continues seamlessly leaves the front
and the rest with open ends instead of linking them across the kink. An edge that already had the
same non-tangential geometry in the loaded data and is only redirected (for example the predecessor
of a host that gets a junction) is inherited, not written — `path-kink` stays the guard that reports
such loaded or foreign data.

**Blocks loaded from a file are fully editable (plan-628 8.7).** Move, rotate, parameters and
*Reset to template* are plain `setField` steps and work on loaded nodes like on added ones. Delete
works too: a loaded node has no `__rvAdded`, so the command books `removeNode` with
`authored: true`. That op folds into the `removedNodes` category of `materialise()`
(`rv-scene-edits.ts`), is replayed on load before the added nodes (`RVViewer._loadSceneInner`,
phase *4b-removals*) and is baked on save by dropping the subtree from the re-exported GLB
(`rv-scene-glb-bake.ts`, full path). Undo re-creates block, paths and the predecessor's link as
authored nodes again. `imported-path` is now only refused for nodes outside the document's own
`PathNetwork` (for example bare `Path` nodes under `Course`, or network content of a placement).

The removal core is generic and lives in `rv-scene-loader.ts`:

| Function | Does |
|---|---|
| `isAuthoredRemovalEligible(node)` | THE policy: a node inside a `PathNetwork` subtree that carries `PathBlock` or `Path`. The one line plan-681 may widen (e.g. to every `rv_extras.Path` node) |
| `isAuthoredSubtreeRemovable(root)` | the policy for a whole subtree (every node must pass) |
| `removeAuthoredSubtree(registry, path)` | removes when eligible (or `__rvAdded`), else a no-op returning `false` |
| `disposeLoadedSubtree(registry, node)` | the primitive without policy: dispose components, unregister, detach |

The scene executor (`removeNode` with `authored`), the load replay and the bake all ask the same
predicate; every other authored node keeps the old protection (`removeNode` on it stays a no-op).
What is persisted is only the node path list `removedNodes` — no identity schema, no reference
rewriting.

**Generated networks are blocks too — and composition-owned (plan-628 8.6).** A scene generator
writes its path graph in the same block form an author builds. The PalletYard generator
(`projects/DiscreteEventSimulation/tools/pallet-yard.mjs`, private) groups `composeYard(n).pathGraph`
with `composeYardBlocks()` (`yard-compose.ts`, pure, no own geometry): each lane straight is a
`straight` block, each end half circle a 180° `curve` block, each junction a `stub` block (twin when
two stations share it) owning its `_In` / `_Out` merge pieces plus every stich dock and mouth. Every
piece maps onto a block, path ids, successors, zones, docks and vehicle starts stay exactly the
pre-block graph, every block reads as its template (not *edited*) and there is no kink — so the
path-network window shows the yard as blocks (click selects one, chevrons, read-only card), and the
DES result is unchanged. The `PathNetwork` node is a top-level node of the document (a direct child
of the model root, the document's OWN network — author blocks land in it too); it is not marked.
Every generated `PathBlock` and `Path` node carries `extras.realvirtual.Generated = { owner }`. The
snapshot reads it as `owner` (`compositionOwnerOf`), and the op runner refuses every write to such an
entry with `composition-owned` (`COMPOSITION_OWNED_TEXT`; up front in `removePaths`, the block ops
and the junction host check, and in the edit diff for everything else — so also an auto-link that
would change a generated path's successors). The UI shows no gizmo on a generated block; marquee,
copy, replace and the length handle skip it (8.11). `layout.path.list` reports `owner`. Changes come
from the generator (the PalletYard size of plan-681 Phase 3 is to replace the owner-marked nodes
under the `PathNetwork` root at runtime and leave unmarked author blocks alone).

**Path ends are standard snaps (plan-628 8.2/8.3).** Every free end of a block is a snap of the
ordinary registry (`typeId` `path`, `path-snap-source.ts`) drawn with the same marker as a GLB
port. A connected end (END with a successor, START listed as a successor) is `occupied` and shows
no marker; occupancy is re-derived after every network change. Hovering a path line reveals its
free ends: the snap controller has a pointer-owner resolver (`setPointerOwnerResolver`) that maps
the visualizer's line pick to the path's snap holder. The holders hang under the empty overlay
container `__pathSnapHolders` in the viewer scene — the marker sprite is attached to the end
node, and a holder outside the scene draws nothing. Any placement port named
`Snap-<axis><N|P|B>-path` is an attach target of the *Path network* tool: the ghost aligns position
AND heading to the port's exact world frame (`pathPlacementPorts`, not the cardinal axis code);
an emitting port (`P`, `B`) starts the block there, a consuming port (`N`) ends it there.

**Sides.** Left of the travel direction `f` is `up × f = (f.z, 0, −f.x)`; on a path driving +X,
`left` is −Z and `right` is +Z. Checked against the rendered picture in plan-628 Phase 7.

**Layer.** Lines, handles and rings sit under `__pathNetworkLayer`; the synthetic group
`Path Network` (`PATH_NETWORK_GROUP`, registered as soon as a path exists) hides all of it and
makes it unpickable.

**Live validation.** In an authoring mode (`planner`, `des`) every `network-changed`, undo/redo,
model load and topology change marks the network dirty; the next frame runs the pure checks and
publishes them to Problems plus one ring per located issue under `__pathMarkers`. Leaving the mode
clears both. Since plan-628 8.11g errors and warnings also carry a short label next to their ring
(`Kink 5.0°`, `Gap 12 mm`, `R 0.40 m < 0.50 m`; `PathNetworkIssue.short`), and hovering any ring
shows its headline and detail next to the cursor (info rings such as open ends have no permanent
label). Only ERRORS are news for the Problems panel: info and warning entries are reported with
`quiet: true` (`ProblemEntry.quiet`), so the panel no longer opens by itself — and no longer covers
the left toolbar — while a network is being built. They are listed and counted as before.

| Code | Severity | When |
|---|---|---|
| `path-open-end` | info | an end with no successor |
| `path-unreachable-start` | info | a start nothing leads into (stations are not known yet — plan-636) |
| `path-link-gap` | error | a successor whose start is more than 5 mm (`PATH_LINK_TOLERANCE.distM`) from the end |
| `path-kink` | error | the ends meet, but the end and start tangents differ by more than `PATH_KINK_TOLERANCE_DEG` (2°) |
| `path-dangling-successor` | warning | a successor id that does not exist |
| `path-radius-too-tight` | warning | an arc radius below `PATH_MIN_RADIUS_WIDTH_FACTOR` (0.5) × the body width — only with an envelope (fleet, design or explicit); without one there is no radius rule and nothing is checked |
| `agv-merge-without-zone` / `agv-merge-entry-too-short` | warning | merge checks against the fleet envelope (618 ids) |
| `agv-merge-check-skipped` | info | no usable fleet, design or explicit envelope — merge checks not run |
| `path-merge-zones-too-close` | warning | free track between two merge zones shorter than the vehicle front |
| `path-block-transform-not-identity` | warning | a block node was transformed directly |

**Planner UI.** Tool *Path network* in the authoring toolbar (planner and DES): a catalog panel
(straight 1/2 m, curves 45°/90° left/right, diverge, merge, stub). Click a tile to arm it, or drag
the tile onto the canvas (`PATH_BLOCK_DRAG_TYPE`). The ghost snaps tangent-true within 0.35 m of a
free end; a junction tool hovers a point on a path (24 px pick tolerance) and shows the side. With a
block selected, a straight/curve tile appends at its free end. Single click selects a block
(gizmo: move handle + rotate knob, 15° raster, Shift free), double click enters it and selects the
single path with the 453 handles, Escape leaves. Delete removes (junctions heal their host).
While the simulation runs, the panel is greyed out.

**Deleting, selection and shortcuts (plan-628 8.9).** Everything below goes through the same
`layout.path.*` commands, so every action is one undo step and is refused while the simulation runs.

| Gesture | Effect |
|---|---|
| Click on a path line | selects its block (the selected block is drawn wider than a hovered one) |
| Hover | the whole block under the pointer is drawn hovered (`PathVisualizerPlugin.setBlockHover`) |
| Shift/Ctrl-click | adds the block to the selection or takes it out again (`toggleBlock`); with several blocks selected the gizmo is hidden |
| Delete / Backspace | ONE `layout.path.remove` of every selected block (`removeSelected`, `ids` comma-separated) |
| R / Shift+R | turns the selected straight/curve by ±90° about its START point together with its downstream chain (`rotateSelected` → `layout.path.move` with `chain: true`, `ROTATE_SELECTED_STEP_DEG`, 8.10): the edges inside the chain stay, the edge to the predecessor is released (open end + ring, freed snaps pinned) — never a kink; a block without predecessor turns its whole chain; a junction refuses (it turns with its host). The same applies to the context-menu *Rotate* items |
| Right-click on a block | the viewer's context menu (`viewer.contextMenu.openItems`, the app's one menu): *Delete*, *Delete chain from here*, *Select chain from here*, *Rotate 90° / −90°*, *Reset to template* (when edited). While the simulation runs the menu shows only the lock hint |
| Escape | disarm tool → leave entered block → clear selection; an open context menu owns the keyboard |
| Ctrl+Z / Ctrl+Y | the global scene undo / redo; the selection drops blocks that no longer exist |

"Chain" is the 8.8 set (`chainMoveSet`: the block, its hosted junctions and every straight/curve
block downstream, stopping at junctions and loops). A multi-block remove skips a junction whose host
an earlier step of the same remove already took away (it was healed with the host), instead of
refusing it. Removing a block unlinks every predecessor and the freed ends get their free standard
snap back. A refusal (simulation running, a command refusal) is shown as a toast at the bottom edge
(`PATH_NETWORK_TOAST_ID`) and in the panel. The Block card in the panel shows the primary block
(Reset to template, Rotate, Select chain, Delete) or, with several selected, how many and one
*Delete N blocks* button.

Deleting an op-created node also drops its field overrides from the scene fold (`materialise()`,
`rv-scene-edits.ts`): before 8.9 the `successors` write of an earlier link stayed in the overlay for a
node that no longer existed, and the next autosave bake failed with `NodeNotFoundError`.

**Library entries (plan-628 8.1).** In every authoring mode the path network UI puts a built-in
catalog `path-blocks` ("Path Network") into the planner library: straight 2 m, curve 90°, diverge,
merge, stub. Such an entry is procedural — `LibraryCatalogEntry.pathBlock = { kind, params }`, no
GLB (`normalizeCatalogEntry` passes the field through, so a JSON catalog can list path blocks too).
The planner never builds a GLB draft or placement mode for it: `LayoutPlannerPlugin.setPathBlockEntryHandler`
hands a card click (`pick`) and a card drag (`beginDrag` / `endDrag`) to the path network UI, which
arms the same tool as the toolbar tile (`pickLibraryEntry` / `beginLibraryDrag`; foreign parameters
get a transient tool entry). The result is exactly the block `layout.path.place` (or
`layout.path.junction`) writes — one undo step.

**"Next part" at a snap (plan-628 8.4).** Clicking a free `path`-typed snap (a path end, or a
`Snap-…-path` port of a placement) opens the ordinary snap picker (`SnapPointPickerPopup`) with an
extra *Path blocks* section — Straight, Curve L, Curve R, Branch, Merge, Stub — above the compatible
library parts. A choice calls `PathNetworkInteraction.placeAtSnap(entryId, snapId)`: straight and
curve go through `layout.path.place` at that end (chained by the command's auto-link, tangent-true;
at a placement port as the exact free pose), a junction goes through `layout.path.junction` on the
path the snap sits on (diverge in the middle, merge / stub as close to the clicked end as lead-in +
run-out allow; `host-too-short` is shown in the picker). The new block is selected. The picker at
any other snap is unchanged.

**Dragging a block takes the chain along (plan-628 8.8, E35).** Dragging the move handle moves the
block AND its downstream chain rigidly: `chainMoveSet(net, blockId)` (`rv-path-network-ops.ts`)
follows the successor edges out of straight/curve paths, takes every downstream straight/curve
block with its hosted junctions, and stops at a junction block, a block-free path and at blocks
already taken (a loop moves once). The command is `layout.path.move` with `chain: true` (default
false = the block alone). **Shift** drags the block alone (P6). Edges inside the moved set stay;
the port edges to the rest are released and re-formed by auto-link at the drop. On release the
moving set's free ends re-snap tangent-true onto the nearest free end or `path` placement port
within 0.35 m (`dropSnap` in `path-network-ui-model.ts`: the corrected rigid motion puts the end
exactly on the port with its heading); the preview shows the snapped pose and a point marker. The
selected block's free end snaps and the ends a move freed stay revealed with the standard marker
(`SnapPointPlugin.setPinnedPathSnaps` → `SnapPointController.setPinnedOwners`); a freed end also
carries its `path-open-end` / `path-unreachable-start` ring. Rotation through the knob stays a
single-block move (its port edges release, P6).

**Rectangle select (plan-628 8.11a, E57).** The planner's rubber-band marquee selects path blocks
together with placements. The marquee has ONE extension point: `BoxSelectHitProvider`
(`box-select-hit.ts`), registered through `LayoutPlannerPlugin.registerBoxSelectHitProvider`. On a
selection commit the controller hands every provider a `BoxSelectQuery` of the same rectangle
(`intersectsWorldSegments`: any overlap, the rule the placements use) and the release modifiers. The
path network UI registers `PathNetworkInteraction.boxSelectProvider`: a block is hit when any of its
path lines touches the rectangle; replace / Shift = add / Ctrl = toggle apply to its block
selection. The two holders stay separate (placements in `viewer.selectionManager`, blocks in
`selectedBlocks`); a full merge of both selection models is not part of 628. Nodes owned by a
composition generator (`extras.realvirtual.Generated.owner`, plan-681; `isCompositionOwnedNode`) are
never hit.

With blocks AND planner items selected:

| Action | Effect |
|---|---|
| Delete / Backspace, menu *Delete … + N items* | `layout.path.remove` of the blocks and `layout.remove` of the planner selection inside ONE outer transaction (`inOneStep`, label `Path verb: delete selection`) — one undo step; a refusal of either rolls both back |
| Drag a selected block | moves the whole selection rigidly: every selected straight/curve block (`layout.path.move`, one after the other, each alone) and the selected placements (`layout.move`), ONE undo step. An edge between two moved blocks is released by the first move and re-linked at the second drop; an edge to an unselected block stays released (open end + ring) — never a kink (8.10). A junction whose host is not selected stays where it is |
| Shift/Ctrl-click on a block | adds / removes it; the planner items stay selected |

A drag on a placement's floor gizmo still moves the placements only.

**Click layout (plan-628 8.11b).** With exactly one straight/curve block selected whose path END is
free, the floor answers clicks (`PathNetworkUiState.clickLayout`): hovering shows the ghost of what
a click would place, a click (press-release < 5 px; a longer drag stays the marquee) places it and
selects the new block, so consecutive clicks build a run. The geometry is pure
(`clickLayoutPlan` / `clickConnectPlan` in `path-network-ui-model.ts`):

| Click | Places |
|---|---|
| within `CLICK_LAYOUT_STRAIGHT_DEG` (5°) of the travel direction | a straight, length on the `CLICK_LAYOUT_LENGTH_STEP_M` (0.25 m) raster |
| elsewhere on the floor | a tangential curve (angle on the `CLICK_LAYOUT_ANGLE_STEP_DEG` 15° raster — 45° and 90° included — side from the click, radius = the library curve entry's default, `clickLayoutDefaultRadius`) plus the straight towards the click |
| on a foreign free start (within `CLICK_LAYOUT_TARGET_PX`, 16 px) | an exact tangential connection: a straight when aligned, else one curve + one straight (curve first or straight first, radius solved, ≥ `CLICK_LAYOUT_MIN_CONNECT_RADIUS_M`); the last block's end lands on the start and auto-link writes the edge. No solution (an S-bend): an open end placed towards it |

Every click is `layout.path.place` per block, attached at the previous path's END, inside ONE outer
transaction (one undo step; the 8.10 guard applies to each). The press on a foreign free start is
claimed with `preventDefault`, so the snap picker of that end does not open. Escape clears the
selection and with it the click layout.

**Typed dimensions (plan-628 8.11c).** While the click-layout preview (or an armed straight/curve
catalog tool) is shown, digits open a prompt at the cursor. The number fills the field the preview
suggests — LENGTH (m) on a straight preview, ANGLE (°) on a curve preview — shown as
`Length: 3.5 m` / `Angle: 90°`. **Tab** switches the field (a value already typed is kept, so
`2` Tab `90` = 90° curve + 2 m straight); a trailing `m` forces the length, `°` or `d` the angle.
**Enter** places (one undo step), **Backspace** edits, **Escape** clears the prompt (a second Escape
clears the selection). A typed length replaces the straight after a curve, a typed angle the curve
(angle without length = the curve alone). With an armed tool the typed length / angle replaces the
tile's `lengthM` / `degrees` (`parseTypedDimension`).

**Length / radius handle (plan-628 8.11d).** A single selected straight shows an orange cube at its
END, a curve at its arc MIDPOINT (`paramHandle` in `path-network-ui-model.ts`; the midpoint of an arc
with the same angle lies on one fixed ray from the block start for every radius). Dragging it
changes `lengthM` / `radiusM` on the `PARAM_DRAG_STEP_M` (0.25 m) raster (Shift = free, minimum
0.25 m); the block's ghost and the value at the cursor show the result, the downstream chain previews
its rigid follow motion. The release is ONE `layout.path.setParams` with `chain: true`: the block keeps
its start pose (the predecessor edge is untouched), its downstream chain (the 8.8 `chainMoveSet`
without the block) moves by `endFollowMotion(oldEnd, newEnd)` — rotate about the old end by the
heading change, then translate — so the edge block → chain and the edges inside the chain stay
tangential. Port edges of the chain to the rest are released and re-formed by auto-link (a loop that
can no longer close opens; never a kink). Parameters stay editable only on an unedited block (P2a):
grabbing the handle of an edited block shows the refusal toast ("Reset to template first"). Not on
generated (composition-owned) blocks.

**Replace with … (plan-628 8.11e).** The block context menu of a single straight/curve has a
*Replace with …* submenu: Straight (2 m), Curve left, Curve right (90°, the library radius; a curve
flipping its side keeps radius and angle) — the choice equal to the block is left out
(`replaceOptions`). It is ONE `layout.path.replace {blockId, block, …, chain: true}` (`replaceBlock`):
same start pose, the block and its path keep their ids, the predecessor edge stays, the downstream
chain moves onto the new end like the length handle. Without `chain` (MCP / macros) the chain stays
and a successor edge that no longer fits is released. Junction blocks and edited blocks are refused
(`wrong-kind` / `block-edited`) — the menu offers *Replace* only for straight/curve blocks.

**Copy / paste (plan-628 8.11f).** Ctrl+C keeps the selected straight/curve blocks in the path
network's clipboard (`copyBlocks`: world geometry, inner edges only; junction and generated blocks
are not copied, a block hosting junctions is copied as its template line). Ctrl+V is ONE
`layout.path.paste {clip, dx, dz, dHeadingDeg, pivotX, pivotZ}` (`pasteBlocks`): new ids
(`PN_Block_<n>`, `PN_S<n>` / `PN_C<n>`), inner edges kept, the pasted blocks become the selection.
With the cursor on a free path END / emitting `path` port (16 px) the copy's first free start takes
that end's position and heading and auto-link writes the edge (docked, tangential); otherwise the copy
lands with that start at the cursor, heading and relative layout unchanged (`clipAnchor`,
`pasteMotion`). `layout.path.copy {ids}` (read only) answers the clip JSON for agents. The key event
travels on to the planner, whose own clipboard copies / pastes the selected placements in the same
gesture — two clipboards, two undo steps for a mixed selection (the planner's paste builds its
placements outside the path-verb transaction).

**Direction chevrons (plan-628 8.11h).** Every drawn path ends in a travel-direction chevron
(`path-visualizer-plugin.ts`, `CHEVRON_LEN` 0.25 m) — placed, clicked, pasted and loaded blocks alike.

**Planner and DES build the same way.** The path network UI, the snap picker, the library catalog,
the keyboard (Delete, R, Escape), the context menu and the scene undo are mode-independent: every
authoring mode (`AUTHORING_MODES` = `planner`, `des`) runs the same code paths. `?mode=des&scene=empty`
opens DES on an empty document; as in the planner, building starts once the simulation is paused
and reset (toolbar *Reset* or Shift+R with nothing selected). Walked by mouse and keyboard in both
modes in plan-628 Lauf 4 (8.10).

## 3. The vehicle (`Agv` library component)

Binds automatically to placed assets whose name matches `*Agv*`/`*AGV*`.
Config (rv_extras / `web_execute("component.setFields", {path, type, props})`):

| Field | Meaning |
|---|---|
| `PathId` | starting path (else: first Path node under the root) |
| `StartPosition` | initial arc position, mm |
| `TargetSpeed` / `Acceleration` / `UseAcceleration` | drive-parity ramp (mm/s, mm/s²) — continuous acceleration up to max speed |
| `SafetyDistance` / `MinGap` / `LookAhead` / `HeadwayGain` | distance control (see §5) |
| `Destination` / `ServiceTime` | declarative one-shot task (no callbacks): drive there, wait, idle |
| `AllowReverse` | the vehicle may serve `approach: 'reverse'` tasks (stub manoeuvre, §5.1) — default off |
| `ReverseSpeed` | cruise speed of the reverse leg, mm/s (default 300; 0 = `DockingSpeed`) |
| `Active` | the vehicle is in service for the next run — default on |

`Active` is evaluated at setup and reset only. When false, the vehicle is
released through the plan-648 release path (fleet handle, spacing, zones,
planner and owner entry), hidden, and is not a traffic obstacle. The continuous
gate is in `fixedUpdate`, not `trafficMuted`: muting also blocks reset and
would prevent reactivation.

Signals per instance: `<Name>.Agv.Run` (command in — stop/resume anywhere,
ramped), `.Moving`, `.Position` (mm), `.AtNode` (pulse), `.Blocked`,
`.Reverse` (the applied plan drives rear first) and `.FieldRear` (the active
scanner field is the rear field — set together with `.Reverse` when the
vehicle has scanner fields).

The `<Name>.` prefix comes from the placement. Vehicles EMBEDDED in a document
(not placed — the AGVFactory demo's eight AGVs) have no placement root and share
ONE `Agv.Run`, `Agv.Moving`, … today; the Problems panel lists each such name once
as `instance-signal-collision` with every vehicle's node path (warning only —
behaviour is unchanged). An `InstanceScope` component on each vehicle root
separates them: its name (or the name of its `PrefixNode`) becomes the prefix,
exactly like a placement name (spec §7d.15, `doc-signal-architecture.md` §2.4).
Path ids stay global: two path nodes with the same id are reported as
`path-id-collision` (both node paths), and routing keeps using the last one
registered.

**Camera.** "Sit on selected part" looks along the vehicle's +Z axis (travel
direction) for an `Agv` with a `Path`; other parts keep -Z. Camera follow has
one owner: `selection` for user follow of the selected part, or `agent-eye`
for the MCP agent. Starting either releases the other; deselecting ends only
a selection-owned follow. The CameraBar derives its state from the plugin mode.

## 4. Tasks — the low-level control primitive

One command shape, deliberately minimal (`src/core/engine/rv-agv-fleet.ts`):

```ts
interface AgvTask {
  destination: string;    // ANY path segment id — vehicle stops at its END
  serviceSec?: number;    // time at the destination
  onArrive?:     (agvId, task) => void;  // service START
  onServiceEnd?: (agvId, task) => void;  // service END — assign next task here
  data?: unknown;         // your payload (order id, …)
  approach?: 'forward' | 'reverse';      // 'reverse' = stub manoeuvre, §5.1
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

**Unreachable service stops are missed (plan-634).** A service stop (task
destination, dock, turn point of a stub manoeuvre) must be reachable with the
vehicle's OWN deceleration when it is planned: the planner computes the braking
point `s + v²/(2·Deceleration)` before the route walk, and a forward service
stop more than 1 mm before it is **missed** — the walk drives on, no plan ever
stops beyond the end of its piece. The vehicle comes back on the next visit:
a task destination over the normal routing (one lap later on a ring), a dock on
its next pass, a stub turn point over the existing go-around lap. A missed stop
is reported once per OCCURRENCE (path + odometer of its end), however often the
vehicle re-plans during the overrun; the next occurrence of the same piece
(next lap, closed path) is checked afresh. Typical cause: a task assigned while
the vehicle is already less than its braking distance before the end of the
destination piece. A missed destination on a DEAD END has no later visit: the
arrival serves nothing and the Problems panel shows
`agv-service-stop-missed-no-return` (warning) — assign such tasks earlier.
Counters on `MovementAuthority.stats`: `serviceStopsMissed` (missed
occurrences), `serviceOvershoot` (applied service plans stopping beyond their
stop — stays 0), `serviceUndershoot` (service plans that stop SHORT of the stop
because of the docking crawl / static limits — pre-existing, counted only) and
`turnGuardTrips` (§5.1).

Rule of thumb for layouts: give every merge one common zone (the merging
pieces and the successor) — the load-time check reports merges without one in
the Problems panel. Splitting long paths into pieces is no longer needed.

The load-time check also measures every merge ENTRY (plan-595): a vehicle
waiting for the merge zone stops with its front a few centimetres before the
start of the zone run on its branch. If that run is too short for the bodies
of the fleet (the envelope of front, rear and width of all vehicles), a body
rooted on another branch or on the merge piece reaches the waiting one. The
check samples every incoming branch symmetrically, straight, oblique and
curved alike, and reports `agv-merge-entry-too-short` as a warning — forward
behaviour does not change. Lengthen the merge-zone piece before the junction.

The entry check is countable (plan-618), so "no short entry" can be told apart
from "nothing was checked". `getMergeEntryCheckStats()` (`src/behaviors/Agv.ts`)
returns `last` — the state of the LAST check, re-initialised on every vehicle
setup: zoned merges found, branches tested, short entries, the envelope used,
`skipped` (`'no-vehicles'` / `'empty-envelope'` / `null`) and handles without a
body. After all vehicles are set up, `last.shortEntries` is the number of
deviations of the run (the check is geometric). Two counters run since the last
`resetMergeEntryCheckStats()`, without run semantics: `checks` and
`stubRejections` (reverse tasks rejected for a short entry). If zoned merges
exist but no body is known, the check does not pass silently: it reports
`agv-merge-check-skipped` (warning). A regular setup never gets there, because
every vehicle has a body (explicit, mesh or fallback). When the last vehicle is
torn down, `last` returns to `'no-vehicles'` and both codes are cleared. The
zone stop itself assumes that the zone geometry encloses the participants'
bodies. Width and rear overhang are not part of it; this check covers that gap
as a report, and the stop is deliberately unchanged.

**Claims follow the route (plan-686).** A vehicle holds only zones its body may
occupy or its current route still runs through. Claims drop off the route where
the route changes — a task change, a routing re-decision, a path edit, a
direction change — so they are given back there: at a reverse direction change
(`setDirection`, the reverse route is known) and in the plan build that follows
a route change (`planZones` step 4; the route only ever comes into being in the
plan build). Given back is each held zone that

- lies on no piece of the new route (zones ahead on the route stay held, also
  beyond the current stop and on a ring revisit),
- was not claimed or confirmed by that plan build (window, start-up, own and
  overhang claims, companions),
- is no protected manoeuvre companion (the stub zone `K` while the merge zone
  `M` is approached, §5.1 — read from the host's `zoneCompanions`), and
- cannot be occupied by the body. The occupancy check is conservative: an
  undirected shortest-path search over the pieces from the vehicle's pose
  (radius = the longer of front / rear reach + rear clearance + stop margin +
  the actual clamping distance of the plan beyond its piece), OR a body disc
  around the pose (`hypot(reach, width/2)`, widened by half the widest body of
  the fleet) against 5 cm samples of the zone's centre lines.

A dropped claim the body still covers at that moment (the rear still in the old
merge after a task change, the front near the next merge at a turn point) is
registered as **orphaned** and released by a later plan build once the body has
cleared it. Anything else a plan build finds — a claim on no route without a
route change, never registered — is the **safety net**: it is released all the
same, counted in `stats.staleClaimsUnexpected` and warned once per vehicle and
zone in the console, so a new orphan source shows up instead of being fixed
silently (the counter must stay 0). `stats.staleClaimsReleased` counts all
releases.

Typical case (PalletYard at 180 s takt, Phase-0 measurement): a forklift claims
the NEXT merge zone inside its claim window, then gets a reverse task into a
stub before it (task change) — the route now ends at the turn point and the
direction change makes every key "exit unknown". Before plan-686 that claim
stayed until a later route drove through the zone, and a vehicle waiting in the
gap between both merges closed a hold-and-wait cycle. The release runs only
where the authority handles the vehicle: external vehicles and vehicles whose
plan build is skipped (a standing hold, a dock stay) keep their claims until
their next own plan build — that delays a release, it never blocks for good.

**Diagnosis: `findZoneWaitCycles()`.** A read-only query (tests, measurements,
soak samples — no hook in the plan path, no state, no Problems entry) that
returns every circular wait over capacity-1 zones: nodes are vehicles standing
at the end of their plan with stop cause `zone`; an edge `v -> h` means `v`
waits for a zone `h` holds, or — for a FREE zone — `h` waits for it actively
and earlier than `v` (FIFO). Each cycle is `{ vehicles, zones }`, rotated to
the smallest id, `zones[i]` = the zone `vehicles[i]` waits for; the list is
sorted. `describeZoneHolds(id)` lists a vehicle's held zones (with the
odometer key of the run end, `Infinity` = exit not routed yet) and its waits.

### Fleet wait edges and blockage diagnosis

Traffic dependencies are available as data, separately from movement decisions:

| Edge kind | Waiter and resource | Dependency owner |
|-----------|---------------------|------------------|
| `zone-holder` | Stopped vehicle waiting for a zone | Vehicle holding that zone |
| `zone-fifo` | Stopped vehicle queued for a zone | Earlier FIFO waiter, even while the zone is free |
| `follow` | Vehicle stopped behind its leader, resource `leader:<id>` | The leader (`stopLeaderId`) |

`MovementAuthority.zoneWaitEdges({ holders: 'nodes' })` preserves the zone detector's
original scope: holders among stopped zone-waiting vehicles. `findZoneWaitCycles()`
uses this shared extraction and returns the zone cycles. The blockage checker uses
`zoneWaitEdges({ holders: 'all' })`, which also names holders stopped for another
reason, and combines those edges with follow, fleet reservation and other sources.
That permits mixed cycles, such as a zone waiter whose holder waits for its station
reservation. Both modes keep zone waiters restricted to stopped vehicles with a
zone stop reason. Capacity > 1 and external-holder edges carry `analysed: false`;
they remain visible but are excluded from cycle analysis.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 85" role="img" aria-label="Vehicle A waits on Zone 1 held by B; B waits on Zone 2 held by A">
<g fill="none" stroke="currentColor" stroke-width="2"><path d="M75 40 H590 M583 35 L590 40 L583 45"/></g>
<g fill="currentColor" text-anchor="middle" font-family="sans-serif" font-size="16">
<text x="35" y="45">A</text><text x="170" y="28">Zone 1</text><text x="330" y="28">B</text><text x="480" y="28">Zone 2</text><text x="625" y="45">A</text>
</g>
</svg>

A zone cycle is a graph fact, not yet a blockage finding: the checker also requires
armed members and no progress beyond their idle budgets. A follow dependency by
itself is ordinary traffic; prolonged missing progress outside a cycle is a stall.
See [Blockage checker](doc-web-debugging.md#blockage-checker) for commands, coverage
and declarations of legitimate waiting.

Fleet `WaitWatch` retains its human-readable `WaitCause` fields (`order`,
`waitingFor`, `heldBy`, `extra`) and timeout formatting. Optional structured fields
`waiterId`, `resourceId`, `ownerIds` and `nodePath` supply stable graph identities;
labels are not parsed into dependencies. `WaitRegistry` pulls active `fleet:<kind>`
edges alongside reservations and authority edges on demand. Existing
`fleet-wait-timeout:<vehicle>:<kind>` Problems and historical timeout counts retain
their original behavior; blockage findings supplement them.

### 5.1 Travel direction — the stub manoeuvre (plan-595)

A forklift-style vehicle serves a handling position forks first and leaves
forward. The planner models reverse travel as **forward travel in a mirrored
route frame**: a plan carries a direction (`+1` front first, `−1` rear first);
a reverse plan walks its route over the predecessors and maps piece-local
coordinates to `L − s`, so speed profiles, the odometer and every v²
computation are the same as forward. Only the leading and trailing body ends
swap: zones are claimed before the LEADING end enters and released when the
TRAILING end has left, the follower gap is leading end + trailing end of the
vehicle ahead + `SafetyGap`, and the scanner field sits at the leading end
(the overlay moves to the rear and points outward). Curve limits are mirrored
with the route, `ReverseSpeed` caps the reverse leg, and hold plans (Run off,
safe hold) keep the cruise and curve limits of their direction.

**Authoring rule — the stub points outward.** A stub is authored FROM the
handling position TOWARD the lane: a chain of single-successor pieces that
runs into a merge piece (a piece with two or more predecessors). Then:

- **Turn point = END of the merge piece.** The vehicle drives forward to the
  end of the merge piece, stops, reverses along the merge piece and the stub
  chain to the stub START (the handling position), is served there and leaves
  forward. There is no separate search for a turning place.
- **Split zones.** Give the stub its OWN capacity-1 zone `K`; only a short
  mouth piece belongs to the lane's merge zone `M`. If the stub zone were the
  merge zone, a vehicle standing in the dock would block the lane for its whole
  stay. Every piece of the reverse route needs a capacity-1 zone.
- **Enough length before the junction.** The merge-zone run before the
  junction must be long enough for the bodies (see the entry check above). A
  reverse task to a stub whose merge entry fails that check is **rejected
  before the approach**: the task is not started and the Problems panel shows
  `agv-reverse-stub-refused`.
- **No idling in the stub.** A vehicle that stays idle in the stub after its
  task holds `K` for good. Always assign a follow-up task or `clear()` from
  `onServiceEnd`.

**The cycle.** `assign({ destination: <stub>, approach: 'reverse' })` on a
vehicle with `AllowReverse`:

1. Forward approach to the end of the merge piece. The merge zone `M` is
   claimed only **together with** the stub zone `K` (all or none). A vehicle
   whose stub is taken waits OUTSIDE `M` — so nobody stands in the merge while
   the vehicle in the stub needs `M` to leave (no wait cycle).
2. Standstill at the turn point, direction change, reverse leg at
   `ReverseSpeed`. A vehicle that was already inside `M` when the task came
   claims `K` at the turn point; if `K` is taken it drives on and comes back on
   the next lap instead of waiting inside `M`. A refused direction change is
   retried every 0.5 s (logged once), never dropped. A task that comes when the
   turn point is no longer reachable with the own deceleration (closer than the
   braking distance) misses it: the vehicle goes around and turns on the next
   lap (plan-634). The direction changes only when the planned position is the
   end of the merge piece (1 mm); otherwise the vehicle stays where it is, no
   retry, `stats.turnGuardTrips` counts it and the Problems panel shows
   `agv-turn-point-overshoot` with the deviation in mm.
3. Arrival at the stub START, one dock call / service stay as usual (the task's
   `serviceState` is booked).
4. Back to forward travel at standstill, out over the mouth and the merge
   piece; `K` and `M` are released when the trailing end has left them.

Without `AllowReverse`, or for a destination that is not a stub, the task is
approached forward (with a console warning).

**Abort contract.** `clear()` / `assign()` during the manoeuvre: during the
forward approach the manoeuvre is simply dropped (the stub zone it claimed is
given back); during the reverse leg the vehicle goes on to the handling
position and leaves at once without a service; during the dock stay the stay
ends at once and a late `release()` of the dock is void. The new task applies
once the vehicle stands with direction `+1` in the stub. A simulation reset /
re-setup ends every manoeuvre (an imperative reverse task that survives a
re-setup starts its manoeuvre afresh).

**Safety rules behind it.** Reverse travel runs only on exclusively held
track: a direction change is accepted only at standstill, on a route whose
pieces all carry capacity-1 zones and whose start zone the vehicle holds.
Opposite-direction vehicles are therefore never projected as leaders — but the
scanner field still sees them as obstacles (held at the closest point they
reach), so the protective field remains an independent second layer.

**Engine API** (`src/core/engine/rv-movement-authority.ts`):
`setDirection(id, dir, route)` changes the direction of the NEXT plan — it only
marks the vehicle dirty; the caller requests the re-plan (the `Agv` does).
`planDirOf(id)` reads the direction of the applied plan. Fleet logic should use
the task API (`approach`), not `setDirection` directly.

Limits: no reverse travel across junctions, one direction change per stub
visit, vehicles of the legacy step mode (`UseAcceleration = false`) have no
direction.

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

## 8. Congestion trace (plan-629)

The congestion trace shows WHERE the network jams as two colour bands along the
paths. The colour is relative to the CURRENT run, never a fixed scale: the
lowest loaded bucket is yellow, the run's maximum red, linear in between
(recomputed on every re-colour); a bucket without load or without data stays
neutral grey. The Display panel shows the range as a legend (lowest % -
gradient - max %) under the time-range chip. It names no cause: the place says
it.

- **Blocked** (`Spur Blockierung`, right of the travel direction): share of the
  time a vehicle stands (|v| < 0.01 m/s) although it wants to move - `Run` set,
  phase driving / cruising, not at a service or dead-end stop. Zone waits,
  headway, horizon, scanner field and safe holds all count; servicing at the
  goal and idling without a task do not. A live / legacy vehicle also counts
  its `Agv.Blocked` signal.
- **Utilization** (`Spur Auslastung`, left): share of the time at least one
  vehicle body covers the bucket.

**Buckets:** every path piece is split into `max(1, round(L / 2 m))` equal
buckets. **Sampling:** a fixed sim-time grid `t_k = k * 0.5 s`, counted as
integers, divided only on read - so DES FastForward, Animated, Hybrid and Step
give bit-identical numbers, and the continuous kernel gives the same counters
for any fixed `dt`.

**Time range:** the "Zeitraum" chips under the two overlay rows - *Letzte
Stunde* (default), *Letzter Tag* or *Gesamt* (since the start / last reset of
the run), all in SIM time; persisted as `rv-trace-settings`. Both sliding
windows are always counted, each a ring of 60 slots (60 s / 24 min per slot),
so a day fits in bounded storage (2 x 60 x buckets per view) and switching shows
the full history at once. A window "breathes" by at most one slot (W/60).
*Gesamt* is zeroed by every sim reset. The legend follows the chosen range.

**Sources** (per vehicle, `AgvHandle.traceSource`):

- `planned` (DES and continuous with planner) - the movement authority's plan,
  read analytically at `t_k`; body interval `[s - rear, s + front]` in the
  path's geometric `s`. No drawn pose is read.
- `legacy` - the continuous step mode: the traveler's position and speed.
- `live` - an interface moves the vehicle (`isWired`): the node's world pose,
  projected onto the nearest path within 1.5 m lateral; equal distance to two
  pieces -> the smaller piece id. Reads only pose and `Agv.*` signals, so it
  works with whatever moves the node.

**Reset:** a sim reset, a DES reset (time backwards), a kernel switch and a
model change start the trace at the current time with zero counters; a change
of the path geometry rebuilds the buckets and measures from NOW (nothing is
re-sampled).

**Simplifications (deliberate):** the body interval is clamped to the vehicle's
current piece (error at most one body length at piece boundaries); legacy and
live vehicles carry their own per-vehicle time offset in the continuous kernel
(at most N * dt * v, a few cm - far below a bucket).

Agents read the numbers with `web_query("trace.top", {view:"blocked", range:"window", n:10})` and switch the bands with
`web_execute("trace.set", {blocked:true})` (see `webviewer.mcp.md`, `web_help(simulation)`).

## 9. Known limitations (plan-921 state)

Projects that need arcade vehicle dynamics can use `PathTraveler` directly while retaining `RVPathNetwork`, its central router and `nextHopToward` routing; the private `agv-maze` project is an example. It omits the `Agv` behavior's acceleration, spacing and fleet-task/DES coupling. Its player decides whether to stop before `advance()` and reports node arrival itself, because a routing hook cannot hold a traveler at a junction. Moving meshes are loaded separately from the document's static batching pipeline, and project teardown releases the router, paths and owned rendering resources.

- **Scene-based projects** (resolved): project plugins are matched through the
  open project's document row (`scriptRef`) and project folder
  (`rv-model-plugin-manager.ts`), so a planner scene of a project loads its
  project plugins too; matching by model name is only the fallback.
- **Double-load ghosting**: loading the same saved scene twice in one session
  (URL autoload + explicit open) adopted placements twice — ghost travelers
  blocked the headway chain. Since plan-647 every model switch empties all
  traffic registries (§10), so nothing of a previous load survives the next
  one. Still open: an adoption that runs twice WITHIN one load (no
  `clearModel()` in between) — re-check before removing this entry.
- DES `Run` toggling is boundary-granular (mid-leg stop is continuous-only —
  by design, see §5).
- Zone wait cycles (plan-686, §5): `findZoneWaitCycles()` analyses only zones
  of capacity 1 and only authority-planned vehicles — a cycle through a zone of
  higher capacity or through an external holder is not reported. There is no
  automatic resolution (no yield / backoff) and no automatic Problems entry: a
  remaining cycle is fixed at its cause. "Claims follow the route" removes the
  cycles closed by an orphaned claim; it is not a general proof that legitimate
  claims can never form a cycle.

### Fleet size and throughput (plan-2063)

| n | Sim-h | Vehicles | Stations | Events/s | Sim-h/wall-h | Heap peak / after GC MB |
|---|---|---|---|---|---|---|
| 1 | 8 | 2 | 6 | 91,894 | 113,879 | 170.86 / 65.49 |
| 2 | 8 | 3 | 12 | 109,436 | 70,658 | 175.11 / 66.84 |
| 4 | 8 | 6 | 24 | 129,160 | 38,606 | 178.99 / 69.32 |
| 8 | 8 | 12 | 48 | 138,520 | 18,970 | 239.63 / 73.07 |
| 16 | 8 | 24 | 96 | 168,091 | 16,644 | 276.02 / 79.95 |
| 8 | 80 | 12 | 48 | 161,242 | 22,349 | 427.83 / 73.10 |

Reference conditions for this table: CODER, AMD Ryzen 9 9950X (16C/32T), 64 GB RAM, Windows 11, High performance power plan, Node v26.13.0, headless Chromium (Playwright) in the vitest browser harness; WebViewer origin/main 9a1b2ed7 + measurement fix 75c4a183; 2026-11-01; quiet machine (about 6% CPU beforehand). This machine is the reference hardware; other computers will differ. Values are rounded medians; 8 Sim-h = 28,800 Sim-s (3 repeats), 80 Sim-h = 288,000 Sim-s (2 repeats). MB is decimal. Heap peak is sampled; after GC is retained heap.

Events/s rises from 91,894 at n=1 to 168,091 at n=16. The short 8-hour runs take less than 2 wall-clock seconds and are affected by JIT warm-up; the longer n=8 run reaches a steadier 161,242 Events/s versus 138,520 for 8 hours. This is not evidence that larger models inherently cost less per event. At n=8 the sampled heap peak grows from 239.63 MB (8 hours) to 427.83 MB (80 hours), while heap after GC stays nearly flat: 73,073,608 versus 73,104,408 bytes (73.07 versus 73.10 MB). These runs show garbage peaks without evidence of a retained-heap leak; they do not prove absence of leaks in all workloads.

The acceptance criterion is FastForward >= 100 Sim-h per wall-clock hour, snapshot < 1 s and < 50 MB, and heap < 1 GB. No measured value breaches these thresholds, including the repeat maxima for heap and snapshot and minima for speed. The cited snapshot threshold measurements cover the vehicle-free warehouse. Measurements reach n=16 (24 vehicles, 96 stations), the maximum of `composeYard`; no performance limit was found within that range. This does not establish support for larger models. These are pure headless DES computation measurements without rendering. Browser rendering and Animated mode were not measured. See plan-465 for the unmeasured rendering scope and [DES measurement details](doc-web-debugging.md#4f-des-performance-measurement-plan-2063) for report fields, repeat ranges and model counts.

Vehicle installations support snapshot capture and restore; see [DES snapshot contract](doc-des-snapshot.md#phase-8-guards-and-additions). On the measured yard models (n=1 to n=16, reference machine, 2026-11-02) saving takes 4 to 40 ms, restoring 6 to 103 ms, and the file is 32 to 396 KB. The vehicle-free synthetic warehouse has different orders of magnitude; its timings and sizes must not be transferred to vehicle installations.

## 10. Lifetime of the traffic registries (plan-647)

The traffic world lives in module-wide singletons — not in the model. Who
empties what, and when:

| Registry | Model switch (`clearModel()`) | Placement removed | Live edit of a path |
|---|---|---|---|
| Path network (`rv-path-network.ts`) | emptied by `resetTrafficRegistries()`; listeners stay | its paths unregister (`RVPathComponent.dispose`) | path object replaced, travelers re-projected (§2.1) |
| Zones (`rv-zone-registry.ts`) | emptied with declarations and claims; availability listeners stay | its paths withdraw their OWN declaration; the zone and every claim stay while another path declares it | declaration moved to the new object (§2.1) |
| Spacing controller | emptied | its vehicles leave (Agv teardown) | unchanged |
| Dock registry (`rv-path-dock.ts`) | emptied | the dock on each of its paths is unbound (`unbindPath`) | unchanged |
| Movement authorities `des` / `continuous` (+ event clock) | emptied | its vehicles unregister (Agv teardown) | re-planned |
| Fleet (`rv-agv-fleet.ts`) | handles dropped (`resetHandles`); ALL subscribers stay | its vehicles unregister (Agv teardown) | unchanged |

- **One reset point.** `resetTrafficRegistries()`
  (`src/core/engine/rv-traffic-registries.ts`) is called by `RVViewer.clearModel()`
  as its LAST step, after `'model-cleared'` (the Agv teardowns release their
  own entries first — see doc-lifecycle.md §6.1), by the embed's
  `resetEmbedEngineRegistries()` and by the test helper `clearShared()` (which
  additionally drops the fleet subscribers). The Agv's diagnostics (merge-entry
  check statistics, fleet step counters) hang on the same point through
  `onTrafficRegistriesReset()` — the viewer registers them, the engine does not
  import the behaviour. `resetSimulation()` empties nothing (the model and its
  paths stay). `trafficRegistryStats()` reports every registry's size (tests,
  diagnosis).
- **Zone declarants.** A zone is declared by the `RVPath` OBJECTS of the paths
  that carry it (`declare` / `redeclare` / `withdraw`); the effective capacity
  is the maximum over the declarations, no declaration → capacity 1. Identity,
  not id: two placements with equal path ids stay two declarants. Removing a
  placement whose path shares a zone with another placement therefore keeps the
  other placement's claims; the LAST declaration to go (dispose) takes the zone
  and its holders with it.
- **Claim walks declare only the current object.** An Agv walking its route
  declares a zone with the walked path object only while
  `getDefaultPathNetwork().get(path.id) === path`. A stale object — replaced by
  a live edit, renamed or removed, e.g. the `startPath` a reset re-seeds — only
  makes sure the zone exists, so it can never revive an old capacity. Paths
  registered directly in the network (no component) declare through the walk as
  before and fall with the next model switch.
- **Running DES.** `clearModel()` disposes the simulation kernel before it
  drops it, which cancels a running FastForward synchronously; the old DES
  manager queue does not keep driving the old model.
- `define` / `redefine` / `undefine` remain as deprecated wrappers (one shared
  anonymous declarant); engine code uses the declarant API.

## 11. Ownership on the kernel switch (plan-648)

Every vehicle exists TWICE: the continuous behaviour binding and the DES
runner instance. Both key the shared traffic state — fleet handle, spacing
entry, zone claims, planner registration — on the same id
(`travelerIdOf(self)` in `Agv.ts`, today the root name). Before plan-648 the
DES instances took the fleet handles when DES started and kept them after the
switch back: project tasks went to the DES instance that nobody ticked, the
ticked continuous instance stood at its old service stop (LOP #219), and every
switch leaked one zone holder.

**The contract — one owner per vehicle id:**

- **Active traffic kernel.** `rv-traffic-registries.ts` holds
  `getActiveTrafficKernel()`: `'continuous'`, `'des'` or `null` (unbound — no
  `SimulationKernel` set a mode; direct `DESRunner` use in tests, or between a
  model clear and the next kernel: every instance may acquire, the first one
  wins). The `SimulationKernel` constructor sets `'continuous'`,
  `resetTrafficRegistries()` sets `null`.
- **`acquire`** (`Agv.ts`): only for an instance of the active kernel. A
  foreign owner of the id is released first, then the instance is entered as
  owner BEFORE anything is registered (a synchronous fleet subscriber already
  sees the right owner), then the fleet handle, spacing and start-zone claim;
  the planner registration follows in the kernel's start kick (continuous:
  `continuous.setup` / activation; DES: `des.onGenerate`).
- **`release`**: fleet step, spacing, zones, planner, handle, owner entry —
  and only when the instance IS the owner. A teardown or release of the other
  instance deletes nothing. It also bumps the service / manoeuvre epochs, so an
  old dock `release()` or service end of the previous owner is void.
- **Muted instances.** A continuous binding whose kernel is not active does
  not tick, reset, start or reset its statistics (`defineLibraryComponent`
  mutes definitions that declare `trafficOwned: true` — only the Agv); its
  setup builds only local state (no handle, claim, pose or `Run`). The DES
  instance runs only while the DES runner ticks.
- **Restart from the start pose.** The new owner never takes state over: task
  back to the declarative start task, no stay, no manoeuvre, not frozen, start
  path and position re-resolved, pose, claim, planner. The simulation reset of
  the continuous owner runs the same path (it keeps its handle).
- **Handle kind.** `AgvHandle.kernel` (read only) names the kernel of the
  instance behind the handle; after every switch it equals the active mode.

**The switch** (`SimulationKernel.setMode`, see doc-lifecycle.md §6.4):

1. `old.clearMUs()`
2. `old.suspend()` — continuous: every binding releases its id, then the
   continuous authority is cleared (vehicles + clock); DES: FastForward
   stopped, every owning instance releases, the DES planner is cleared, then
   the queue is cleared for good
3. active traffic kernel = target mode
4. `incoming.start()` — continuous: every live binding WITHOUT its id
   (suspended, or bound while DES ran — late placement, DES boot) restarts and
   acquires; DES: `def.setup` re-runs per instance (the ONE activation point:
   acquire), `des.onGenerate` only kicks
5. commit, `simulation-mode-changed` — project plugins (PalletYard) re-bind;
   the vehicles already own their ids

A throwing `incoming.start()` suspends the half-started executor, restores the
active kernel (also when that suspend throws) and starts the old executor
again — a functional restart from the start pose, not a resume.

## Dispatch core (`src/core/fleet/core/`)

The dispatch core is independent of the viewer and simulation kernel.

- `orders.ts` defines transport orders and `OrderPool`, including priority/time/id
  ordering and the event source: a station offers an MU when it becomes ready.
- `dispatcher.ts` provides `FleetDispatcher`: order → destination (direct, else
  storage group of the source) → nearest feasible vehicle with battery admission
  → reservations. Retrieval requires the configured rule and a free receiving
  destination. Idle vehicles charge, join the charger queue, or park.
- `strategies.ts` resolves the built-in names `nearest-feasible` and
  `threshold-opportunity`, estimates forklift consumption from travel and lift
  work, and defines the `RetrievalRule` callback.
- `order-sources.ts` provides clock-driven `TaktSource` production and
  `PauseSource` shipping pauses, including live retiming.

### Seeded RNG and stochastic timing (plan-2051, plan-2060)

All randomness is seeded and reproducible: the same master seed gives the same
run, a different seed a different one.

- **PRNG**: `src/core/rv-rng-distribution.ts` — `SFC32Legacy` (exported also as
  the identical constructor `SFC32`, today's frozen generator; 128-bit state,
  `getState()` / `setState()`, splitmix64 seed hash so adjacent seeds are
  uncorrelated) plus `exponential`, `normal`, `uniform`, `erlang`, `weibull`.
  Time values are clamped to at least 0.001 s. It lives in core (not
  `plugins/des/`) because both the fleet startup code and the DES body use it.
- **Reference v2 primitive**: `SFC32v2.fromSeed64(bigint)` implements PractRand
  sfc32 with twelve warm-up draws. `next()` returns a u32; `nextFloat()` returns
  u32 / 2^32. `getState()` / `setState()` include the independent `counter`.
  `tests/des/fixtures/rng-v2/sfc32-practrand-vectors.json` pins its warm-up state
  and outputs against the independent PractRand Python reference and simblob check.
- **Stream seed contract**: `seedKey64(masterSeed, id, purpose)` in
  `src/core/rv-rng-streams.ts` implements plan-2060 §2.3: `rv-rng-v2\0`, the
  truncated seed modulo 2^64 as eight little-endian bytes, then each NFC UTF-8
  field prefixed by its u32 little-endian byte length; FNV-1a 64 followed by the
  SplitMix64 finalizer. Non-finite seeds throw. Independent Python golden tuples
  live in `tests/des/fixtures/rng-v2/seedkey-vectors.json`.
- **Run version**: manager and runner expose `rngVersion` (default 1) and
  `setRngVersion(v)`; both 1 and 2 are selectable (plan-2061 release). Batch slots set it
  before seed/reset and restore the pre-batch value on completion or abort; new
  experiments are pinned to v2 (`NEW_EXPERIMENT_RNG_VERSION`), archives without a pin
  stay v1, and ordinary runs outside a batch stay on v1. Other values throw
  `rng-version-unknown:`, before mutation. Reasserting the same version is inert. A
  version change is guarded when manager time is positive or events remain queued
  (`rng-version-run-in-progress`). Pin rules, error codes and the script contract:
  [doc-des-randomness.md](doc-des-randomness.md).
- **Named streams (v2, released; plan-2061)**: `DESManager.stream(componentId,
  purpose)` returns one stable `RngStreamHandle` per (id, purpose), seeded by
  `seedKey64(masterSeed, id, purpose)`; reseeding replaces only the generator state,
  so held handles stay valid. The id is the DES component id,
  `<plan-769 node address>@<component type>` (`desComponentId()` in
  `src/plugins/des/rv-des-identity.ts`), so adding or reordering other components
  does not move a stream. Duplicate ids throw `des-rng-duplicate-id:` (on selecting v2
  and on registration under v2). Consumers: `DESComponent.rngFor(purpose)` (`default`
  is `self.rng`; Downtime uses `downtime:mtbf` / `downtime:mttr`) and
  `deriveFleetRngFactory` in `src/plugins/fleet-plugin.ts` (id = `plantId`, purpose
  `takt:<outputId>` per TaktSource output). Under v2 `DESManager.snapshot()` and
  `restore()` carry the component streams in the `des.rng` document (`streams` array of
  `{id, purpose, seedKey64, state}`); the fleet takt streams are saved by the `fleet.takt`
  part itself (per output, `setState` on restore), not in `des.rng` (plan-2061 Phase 3,
  see `doc-des-snapshot.md`). Under v1 `stream()` returns the legacy stream and is not
  keyed by id.
  Script `self.random`: [doc-des-randomness.md](doc-des-randomness.md).
- **DES components**: each `DESComponent` gets `manager.createComponentRng(entityId)`
  = `new SFC32(masterSeed + entityId)`. Material-flow behaviours read it as
  `self.rng` (null outside DES); the DES snapshot stores its state.
- **Downtime**: fixed MTBF/MTTR by default. With `Stochastic` on, the first
  failure, every repair and every next failure are exponential draws with mean
  MTBF / MTTR from `self.rng`. DES only.
- **TaktSource**: a `TaktPlan` with `stochastic: true` and an RNG set via
  `setRng()` draws every interval after a release as `exponential(rng, interval)`
  (Poisson releases); the first release stays at its phase. Without the flag or
  without an RNG the takt is fixed. Each run restarts from the RNG state at
  `setRng()` time.
- **Fleet takt seed**: `deriveFleetRng(plantId, runner, root)` in
  `src/plugins/fleet-plugin.ts` returns `new SFC32(masterSeed + fleetRngStream(plantId))`.
  The stream offset lies far above any DES entity id and hashes the plant id.
  Under DES the seed is `runner.masterSeed`; in the continuous kernel it is the
  scene DESManager's positive seed, else 42, so both kernels produce the same
  takt stream for the same scene seed. A fresh RNG is set on every bind.

PalletYard uses these modules through
`src/plugins/models/PalletYard/dispatch-policy.ts`. Stations come from its config;
retrieval defaults to `legacy-fifo`, with `when-inbound-free` also available.

## Execution core (`src/core/fleet/exec/`, plan-559 Phase 5)

`job-runner.ts` provides `FleetJobRunner`, the FIXED forklift executor (no
registrable steps): it turns the dispatcher's jobs into `AgvTask`s, docks, fork
strokes and hand-overs. The sequence per handling stich is fork first (forward to
the turn point, pre-stroke there at standstill — wait `fork`), back in (reverse
task), touch / lift / set down in the dock, out forward, and the fork moves to
travel height only after the movement authority released the stich zone (wait
`exit`). A refused drop waits in the dock (`target`), a vehicle in the charger
queue waits at the wait point (`charge`). Every wait goes through `WaitWatch`
(`fleet-wait-timeout:<vehicle>:<kind>`, limits per kind, default 60/60/3600/3600 s;
`0` = unwatched).

The runner is kernel-neutral: it talks to `FleetKernelAdapters { kind, clock,
lift, handover }` (`backends.ts`), composed directly by the binding (no registry):

| Kernel | Clock | Lift | Hand-over |
|---|---|---|---|
| DES | `src/plugins/des/fleet/des-sim-clock.ts` (`DES.Callback` events, lifecycle restarts) | `des-lift.ts` (runner tween + clock event) | `des-handover.ts` `DesHandoverBackend` (end probe, carrier / floor owners, pose drop, seat reconcile) |
| continuous | `ContinuousSimClock` | `src/core/fleet/continuous/lift.ts` | the project's continuous hand-over until Phase 7 |

In DES, a live planning change is a clock event at the current instant with
`PLANNING_PRIORITY`: after all model events at that instant and before the
checkpoint. This deliberately changes the previous ordering among model events
by frame timing, making runs with the same protocol reproducible. Continuous
mode applies at the next fixed tick (POST). `FleetPlugin.replayChanges(log)`
replays a recorded protocol on the active run clock; the underlying
`PlanningRegistry.replayChanges(log, schedule)` accepts an owner-provided scheduler.
Rows run in `(simTime, seq)` order, preserve their log fields, and expire on reset.
Replay calls `onLive` with `alreadyScheduled: true`; owners must apply directly
without scheduling a second event. Custom DES model priorities must stay above
`PLANNING_PRIORITY` (the two lowest Int32 priorities are reserved for planning
and checkpoints).

The project supplies a `FleetSite` (stations, stich → turn point, the wait point,
start paths) and the live configuration objects (fork values, battery, takt,
pauses); PalletYard does this in `createYardRun` (`yard-runtime.ts`).

Two guards ride on the hand-over of every task:

- **Task ownership (SOL #8, S1).** Every task carries `data.__fleetOwner`. An
  effective task change (`AgvFleet.onTaskChanged`) that is not the runner's own
  is a hijack: the step is aborted (lift stroke, pick dock, waits); a pick not
  yet loaded goes back to the pool with its reservations freed, a loaded pick or
  retrieve fails (`fleet-task-hijacked:<vehicle>`, the MU stays on the fork). The
  vehicle returns when it is idle again (`onIdle`), after a foreign `clear()` at once.
- **Hold check (plan-634).** The hold target of a task handed to a moving vehicle
  (its destination, or the stub's turn point for a reverse task) is compared with
  the braking distance from the movement authority's plan at that instant. An
  unbrakeable target is counted (`unbrakeableHolds`) and not treated as reached —
  the vehicle passes it and is served on its next visit. In the PalletYard M3 run
  the count equals the engine's `serviceStopsMissed` (3, all charge jobs).

## 12. Fleet scene components (plan-559 Phase 3)

The scene layer of the generic fleet core: six web-only components a scene author puts
on nodes (inspector or `web_execute("component.setFields", {path, type, props})`). They are pure data — no factory, no
runtime behaviour yet; the order core (plan-559 Phase 4) reads them. Source:
[`src/core/fleet/scene/fleet-components.ts`](src/core/fleet/scene/fleet-components.ts).

| Component | Put it on | Fields (unit) |
|-----------|-----------|---------------|
| `Fleet` | one node of the scene | `Enabled`; `VehicleSelection` (`nearest-feasible`); `Charging` (`threshold-opportunity`); wait limits per kind in sim-s, 0 = never reported: `WaitLimitSec` 60 (fork / stub-exit step waits), `TargetWaitLimitSec` 3600 (drop place occupied), `ChargeWaitLimitSec` 3600 (no free charger), `StandstillLimitSec` 120 (vehicle standing in a traffic halt) |
| `TransferStation` | a conveyor (or its placement's reference node), or a floor-slot stub | `StationName`; `Role` `pick`/`drop`/`storage`/`both`; `PathId` (stub path id, empty = the `Path` on this node); `PartnerType` `Conveyor`/`Floor`; `Partner` (conveyor node, empty = this node); `PartnerEnd` `tail`/`head`; `HandlingHeightMm` (mm); `Approach` `reverse`/`forward`; `Group`; `SeatNode` (floor pose, empty = stub end) |
| `Charger` | a charging stub | `PathId`; `ChargeRatePerMin` (%/min) |
| `WaitPoint` | a wait stub | `PathId`; `Capacity` (vehicles); `Precedence` `charge-queue-first`/`arrival-order` |
| `ForkliftProfile` | the vehicle asset | `Lift` (drive); `ForkAnchor` (seat node of the load); `LiftRangeMm`, `HandlingDeltaMm`, `TravelHeightMm` (mm); `LiftSpeedEmptyMmS`, `LiftSpeedLoadedMmS` (mm/s); `PreLift`; `LowerAfterExit` |
| `BatteryProfile` | the vehicle asset | `StartSoc`, `Threshold`, `Target`, `ReserveToCharger` (%); `DrivePerMin`, `IdlePerMin` (%/min); `LiftPerM` (%/m); `TravelSlack` (factor); `ChargerWaitReserveSec` (s) |

Three rules to know:

- **Stubs by path-id string.** A reference from the layout into a placement is dead at
  init (559 M1), so a station names its stub by `PathId`, never by a reference. A
  `TransferStation` on a conveyor placement's reference node names the layout's stub —
  the PalletYard pattern.
- **Not material flow.** None of the six is a `defineMaterialFlow` type, so DES
  auto-connect never sees them and none can accept an MU.
- **Bake survival by reference.** `Partner`, `SeatNode`, `Lift` and `ForkAnchor` claim
  their target node (`merge`), so a bare fork anchor or floor seat survives the
  destructive bake without plugin `bakeClaims()`.

`readFleetScene(root, registry)`
([`fleet-scene-model.ts`](src/core/fleet/scene/fleet-scene-model.ts)) reads them into
one typed model — schema defaults applied, numbers clamped to their bounds, references
resolved through `NodeRegistry.resolve` (scope = the node's enclosing registered scope),
every list sorted by registry path. It is a pure read and is meant to run late, after
`placements-materialized`, and again on `layout-content-added`. Problems it does not
guess about land in `issues` (`fleet-duplicate`, `fleet-missing-path`,
`fleet-unresolved-reference`). `profilesOfVehicle(model, agvNode)` finds a vehicle's
profiles on the Agv node or an ancestor up to its instance root;
`batteryConfigOf(profile, chargePerMin)` builds the core battery model.

### 12.1 Fleet authoring source and design vehicle (plan-636)

`Fleet` also exposes `DesignVehicleLengthMm` (0–20000), `DesignVehicleWidthMm` (0–10000)
and `DesignLoadOffsetMm` (−5000–5000), all in **mm**, default **0**.
Length and width must both be positive; `0/0` means unset. Setting only one produces
`fleet-design-vehicle-incomplete` and no design envelope. `designEnvelopeOf` converts once
to metres: `front = rear = lengthMm / 2000`, `width = widthMm / 1000` — a symmetric body.
`TransferStation.DockPort` stores the chosen port name (empty = automatic choice);
for docking, `SeatNode` falls back to the port, as described in §2.3.

`resolvePathEnvelope` uses **registered fleet bodies > Fleet design vehicle > explicit
envelope > none**, reporting `fleet`, `design`, `explicit` or `none`. This feeds junction/dock
sizing and authoring validation (`layout.path.validate` accepts explicit `front`, `rear`,
`width` in metres). With no envelope, junctions retain the 1.8 m merge lead-in fallback;
body-dependent merge checks are skipped. The design fields do not change runtime vehicle bodies.

The load offset is measured from each resolved `ForkliftProfile.ForkAnchor` relative to its
`Agv` root: `-agv.worldToLocal(forkAnchorWorld).z * 1000`. The root is the profile node's
own Agv, or the first Agv below it in node-path order within the same instance scope.
Positive means the load is behind the root. Measurable profiles are ordered by id:

- With measurements agreeing within 10 mm, the first profile supplies the value (`vehicle`).
- If their range exceeds 10 mm, `fleet-load-offset-ambiguous` lists the values. A **positive**
  `Fleet.DesignLoadOffsetMm` then wins (`design`); otherwise the first profile still wins.
- Without a measurable vehicle, a nonzero `DesignLoadOffsetMm` supplies the value (`design`).
- Otherwise the offset is zero (`none`); if forklift profiles exist,
  `fleet-load-offset-missing` warns that neither an anchor nor a design offset is available.

Both offset issues appear as quiet Problems warnings and, without the `fleet-` prefix, in
the dock command's `warnings`. There is no command load-offset override.

[`FleetAuthoringSource`](src/core/fleet/scene/fleet-authoring-source.ts) is the shared lazy
reader of `readFleetScene(viewer.scene, viewer.registry)` for these authoring operations.
The path visualizer attaches it; `model-loaded`, `layout-content-added`,
`layout-content-removed` and `component-field-changed` for `Fleet`, `TransferStation` or
`ForkliftProfile` (including numbered component instances) invalidate the cached model and
offset and mark live validation dirty. Event handlers do not traverse a loading scene;
the next consumer reads it. Without event subscriptions, headless consumers read afresh.
