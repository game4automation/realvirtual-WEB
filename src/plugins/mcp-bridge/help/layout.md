# Layout building (Layout Planner)

> Dotted names like `editor.setField(…)` / `sim.playPause` are registry commands: run them with
> `web_execute(command="<id>", args={…})` (or `web_batch`). Their old alias tools are not in tools/list.

Build connected material-flow layouts in the browser. Requires planner mode: `web_execute("workspace.setMode", {"mode":"planner"})`.

## Build a conveyor line

1. `web_execute("workspace.setMode", {"mode":"planner"})`
2. `web_query("library.catalogList", {})` — every placeable part (catalogId, name, `source`, footprintMm); `web_query("library.catalogDescribe", {"catalogId":"conveyor"})` for build docs.
   Nothing from a library listed? Attach one first: `web_execute("library.attach", {"projectId":"prj_realvirtual_library"})` (see *Libraries and parts*)
3. `layout.place` — drop the first part at a world position (meters)
4. `web_query("layout.snapList", {"id":"conveyor-1"})` (placement id) — the part's free snap points (open ports)
5. `web_query("layout.snapSuggest", {"targetId":"conveyor-1"})` (id, snapName) — which parts fit that snap *(optional)*
6. `layout.snapAttach` (targetId, catalogId, snapName) — attach the next part auto-aligned; repeat to chain the line
7. `web_execute("component.setFields", {"path":"Cell/Conveyor","type":"Drive","props":"{\"TargetSpeed\":500}"})` — configure behavior
8. `web_query("layout.list", {})` — review positions + world bounds
9. `web_execute("workspace.setMode", {"mode":"hmi"})` + `sim.playPause` — run it
10. `web_document_save` — persist the layout

`layout.move` is the manual alternative to snap-attach when you need free positioning.
`layout.move` and `layout.remove` are booked like UI edits — `web_document_save` keeps them.

Catalog ids of the realvirtual library are its document ids, e.g. `pallethandling-rollconveyor-2m`
(the old `realvirtual-library-pallethandling-rollconveyor-2m-glb` form still resolves in existing
files) — always take them from `web_query("library.catalogList", {})`, never from memory.

## Libraries and parts

Three origins of placeable parts, ONE list (`web_query("library.catalogList", {})`, field `source`):

- **Project parts** (`source: "project"`) — every document of the open project, wherever it sits
  (a part saved under `library/Interroll/` is one). catalogId `project:<path>`; the `documentId`
  works too and survives a rename / move (`document.rename` / `document.move` via `web_execute`).
- **Library project parts** (`source: "library"`, with `libraryProjectId`) — the documents of another
  PROJECT the open project uses as a library, named by its project id in `project.json.libraries[]`.
  The standard realvirtual library is the project `prj_realvirtual_library` (CartonBox, pallets,
  roller conveyors …). Attach: `web_execute("library.attach", {"projectId":"prj_realvirtual_library"})`;
  remove: `web_execute("library.detach", {"projectId":"…"})` — its placements stay and show as
  missing until it is attached again. Place with `layout.place(catalogId, …, libraryProjectId)` so
  two libraries' equal document ids never mix. `web_query("library.list", {})` lists every library
  project with `scope` (direct | transitive — only direct ones are placeable), `state` (ready,
  pending, locked, unknown, error) and `neededBy`. A `locked` library needs **Grant**, an `unknown`
  one **Locate folder…** — both are clicks in the Problems panel (`library.grant` / `library.locate`
  need the user's click; an agent cannot grant folder access).
  A library part is read-only inside the project; per-placement changes are overrides. Changing the
  library itself is the Inspector's **Edit in library** (a confirmation naming the library + a
  write-access click — not available to an agent); **Copy into project** forks the part into the
  open project and points the placement at the copy (one Undo step). A library document in the
  editor is saved into its library only after that confirmation; until then a save answers with
  the reason (`blocked`).
- **Catalog parts** (`source: "catalog"`) — entries of an external catalog (`catalog.json`, a GitHub
  scan) the project subscribes to: `web_execute("library.attach", {"url":"https://…/catalog.json"})`
  (loaded first — a 404 is reported and nothing is written), `library.detach` with the same `url`.
  The legacy `{"url":"/library/catalog.json"}` still works and attaches `prj_realvirtual_library`.

In the UI: planner library ▸ *Manage libraries…* opens the same Add library… dialog (Projects / URL /
GitHub tabs).

`layout.place` AND `layout.snapAttach` accept every origin. Example — a closed ring of four 90° curves
with a carton on it:

1. `web_execute("library.attach", {"projectId":"prj_realvirtual_library"})`
2. `web_query("library.catalogList", {"source":"project","query":"RM8320"})` → the curve's catalogId
3. `layout.place(catalogId, 0, 0, 0)` → id A; `web_query("layout.snapList", {"id":"A"})` → its free output snap
4. `layout.snapAttach(targetId=A, catalogId)` three times along the free output snaps → the ring closes
5. `layout.place(catalogId="pallethandling-cartonbox", onto=A)` — the CartonBox part is a Source;
   `web_execute("component.setFields", {"path":"<its path>","type":"Source","props":"{\"LimitNumber\":true,\"MaxNumberMUs\":1}"})` spawns exactly
   one carton (`MaxNumberMUs` alone is ignored); `sim.playPause`

## Flow direction on a turntable

A conveyor's snaps carry a flow (`Snap-ZN` = in, `Snap-ZP` = out); a turntable's four snaps are
`bidi`. The natural match on a turntable SIDE snap (`Snap-XN`/`Snap-XP`) and on `Snap-ZP` yields a
conveyor leading AWAY; only `Snap-ZN` yields one feeding in. To build a feeder INTO any turntable
side pass `flow="in"` to `layout.snapAttach`; the answer reports the resulting `flow`.
Extend a feeder backwards by attaching onto the free `Snap-ZN` of its last conveyor.

## Heights: putting a pallet / MU onto a conveyor

`layout.place(catalogId, 0, 0, 0, onto=<conveyor placement id>)` — the part is centred on that
placement and rests on its real **transport surface** (the top of its `TransportSurface` node). The
answer reports `surfaceHeight`. Never guess a height:

- The transport surface (roller top) is NOT the bounding-box top from `web_query("layout.list", {})` — the box
  includes side frames/guides above the rollers; a pallet placed there floats.
- Standard **Roll Conveyor**: transport surface = **y 0.50 m** (box top 0.64 m).
- To measure any other part: `web_node_bounds` on its `Transport-Z` node, `world.max[1]`.
- A pallet's origin is its **underside** — its `y` IS the surface height; do not add half its height.
- Without `onto`, `y` is honoured as given (0 = ground).
- Pallet GLBs carry a `Source` component: a placed pallet IS the source and spawns MUs.
- `PalletSink` has no snaps — place it by coordinates at the end of the track, at surface height.

## Path network (AGV paths as blocks)

Path blocks are commands, not tools: run them with `web_execute` / `web_batch`
(`web_commands` lists the args). Each one is ONE undo step and needs the simulation in the
reset state (else `sim-locked`).

- `layout.path.list` — blocks, paths (length, zone, successors), free ports, layer visibility.
- `layout.path.place {block:"straight"|"curve", lengthM, radiusM, degrees, side, atPath, atEnd}` —
  attach at a free end (`atEnd` "end"/"start"), or free with `x`, `z`, `headingDeg`. Ends link automatically.
- `layout.path.junction {kind:"diverge"|"merge"|"stub", pathId, s, side, twin}` — `s` in m on the
  path; the front piece gets a new id (`renamedFront`), the original id stays on the rest.
- `layout.path.move {blockId, dx, dz, dHeadingDeg, chain}`; a junction slides with `s`. `chain: true`
  moves the downstream chain rigidly with the block (stops at junction blocks and loops).
- `layout.path.remove {ids}` (comma-separated); removing a junction heals its host.
- `layout.path.setParams {blockId, lengthM, radiusM, degrees, side, chain}` / `layout.path.reset` —
  change an unedited block / back to its template. With `chain: true` the chain behind the block
  follows its new end tangentially; without it a successor edge that no longer fits is released.
- `layout.path.replace {blockId, block:"straight"|"curve", lengthM, radiusM, degrees, side, chain}` —
  a straight/curve becomes the other kind at the same start pose; block id and path id stay. Not on
  junctions (`wrong-kind`) or edited blocks (`block-edited`).
- `layout.path.copy {ids}` (read only) answers `clip` (JSON of the straight/curve blocks, inner edges
  only; junction and generated blocks are left out and listed in `skipped`); `layout.path.paste {clip, dx, dz, dHeadingDeg, pivotX, pivotZ}` inserts it with new ids,
  rotated about the pivot, then shifted. A free start landing on a free end links automatically.
- `layout.path.validate {front, rear, width}` — issues (open ends, link gaps, kinks, merges) sorted by
  severity; the envelope (m) comes from the fleet, else from the args, else the merge check is `skipped`.
  In the planner the same issues show live in Problems and as rings on the layer.

**Always tangential.** No command writes an edge whose ends are more than 5 mm apart or whose
tangents differ by more than 2°: such an op is refused as a whole with `not-tangential` (nothing
is written). Moving a block is the one exception — it releases such an edge instead of failing.

**Generated paths are read-only.** Paths and blocks a generator wrote (`Generated.owner`, e.g. the
PalletYard network; `layout.path.list` shows `owner`) refuse every write with `composition-owned`
— remove, move, setParams, reset, replace, a junction on them, or a link that would change their
successors. Change them through their generator (e.g. the PalletYard size); add your own blocks
next to them.

Hide the layer: `web_execute("group.setVisible", {"name":"Path Network","visible":false})`.

Sides: `left` / `right` are relative to the travel direction (on a path driving +X, `right` is +Z).
A junction needs 1.8 m lead-in + 0.6 m run-out on its host, else `host-too-short`. In the planner
the same blocks come from the *Path network* tool (click or drag a tile); details in
`doc-path-fleet-control.md` §2.3.

## Running it

`sim.playPause(paused=false)` — always pass `paused`; a bare call TOGGLES and the simulation is
usually already running. Check the flow with `web_query("transport.status", {})` (spawned / consumed / blocked).

## Documents

Asset = document = model — ONE concept, the GLB document of the open project; the folder it
sits in (scenes/models/library) is a storage place, not a type.

`web_execute("document.create", {})` (clean reset) · `web_document_save` (persist; with a name saves a NEW
document and returns its id; the answer names the `path` it wrote — compare it with what you opened) · `web_query("layout.export", {})` (raw planner JSON, no persist).

To LIST or SWITCH documents: `web_document_list` (every GLB the project owns plus the
built-in and published sources, with sizes; filter + optional nodeCount) and
`web_document_open(document=<id|name|path>)`. Rename a saved document with
`web_execute("document.rename", {"relPath":"Part.glb","newName":"Renamed"})`, move it with
`web_execute("document.move", {"relPath":"Part.glb","toFolder":"parts"})`, or delete it with
`web_execute("document.delete", {"relPath":"Part.glb"})`. The parts CATALOG (`web_query("library.catalogList", {})`) is different: those are
placeable templates, not project documents.

## Tool reference

<!-- BEGIN GENERATED: tool-reference layout — do not edit; run `npm run gen:mcp-docs` -->
_5 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_document_list` | read | `filter` string, `withNodeCount` boolean | List the DOCUMENTS of the open project — THE one list. |
| `web_document_open` | write | `document` string **req** | LOAD a document into the viewer, or clear it. |
| `web_document_save` | write | `name` string | Save the current document. With name: saves a NEW named document and returns its documentId; without: saves the open one in place with compare-and-swap. |
| `web_layout_timings` | read | `clear` boolean | Placement performance timings: per-phase decode records (fetch/parse/uber-bake of a GLB, once per asset per document), per-phase chunk-bake records (roles/split/stage/pi… |
| `web_scene_query` | read | `expression` string **req**, `root` string | READ-ONLY JavaScript query over a frozen plain-data snapshot of the scene — the escape hatch for any geometric/material question no dedicated tool answers. |
<!-- END GENERATED: tool-reference layout -->
