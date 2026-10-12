# Layout building (Layout Planner)

Build connected material-flow layouts in the browser. Requires planner mode: `web_mode_set("planner")`.

## Build a conveyor line

1. `web_mode_set` (`mode=planner`)
2. `web_catalog_list` — parts catalog (catalogId, name, footprintMm); `web_catalog_describe` for build docs
3. `web_layout_place` — drop the first part at a world position (meters)
4. `web_layout_snap_list` (placement id) — the part's free snap points (open ports)
5. `web_layout_snap_suggest` (id, snapName) — which parts fit that snap *(optional)*
6. `web_layout_snap_attach` (targetId, catalogId, snapName) — attach the next part auto-aligned; repeat to chain the line
7. `web_component_set` — configure behavior (drive `TargetSpeed`, source spawn interval, …)
8. `web_layout_list` — review positions + world bounds
9. `web_mode_set` (`mode=hmi`) + `web_sim_play_pause` — run it
10. `web_document_save` — persist the layout

`web_layout_move` is the manual alternative to snap-attach when you need free positioning.
`web_layout_move` and `web_layout_remove` are booked like UI edits — `web_document_save` keeps them.

Catalog ids look like `realvirtual-library-pallethandling-rollconveyor-2m-glb` — always take them
from `web_catalog_list`, never from memory.

## Flow direction on a turntable

A conveyor's snaps carry a flow (`Snap-ZN` = in, `Snap-ZP` = out); a turntable's four snaps are
`bidi`. The natural match on a turntable SIDE snap (`Snap-XN`/`Snap-XP`) and on `Snap-ZP` yields a
conveyor leading AWAY; only `Snap-ZN` yields one feeding in. To build a feeder INTO any turntable
side pass `flow="in"` to `web_layout_snap_attach`; the answer reports the resulting `flow`.
Extend a feeder backwards by attaching onto the free `Snap-ZN` of its last conveyor.

## Heights: putting a pallet / MU onto a conveyor

`web_layout_place(catalogId, 0, 0, 0, onto=<conveyor placement id>)` — the part is centred on that
placement and rests on its real **transport surface** (the top of its `TransportSurface` node). The
answer reports `surfaceHeight`. Never guess a height:

- The transport surface (roller top) is NOT the bounding-box top from `web_layout_list` — the box
  includes side frames/guides above the rollers; a pallet placed there floats.
- Standard **Roll Conveyor**: transport surface = **y 0.50 m** (box top 0.64 m).
- To measure any other part: `web_node_bounds` on its `Transport-Z` node, `world.max[1]`.
- A pallet's origin is its **underside** — its `y` IS the surface height; do not add half its height.
- Without `onto`, `y` is honoured as given (0 = ground).
- Pallet GLBs carry a `Source` component: a placed pallet IS the source and spawns MUs.
- `PalletSink` has no snaps — place it by coordinates at the end of the track, at surface height.

## Running it

`web_sim_play_pause(paused=false)` — always pass `paused`; a bare call TOGGLES and the simulation is
usually already running. Check the flow with `web_transport_status` (spawned / consumed / blocked).

## Documents

Asset = document = model — ONE concept, the GLB document of the open project; the folder it
sits in (scenes/models/library) is a storage place, not a type.

`web_document_new` (clean reset) · `web_document_save` (persist; with a name saves a NEW
document and returns its id; the answer names the `path` it wrote — compare it with what you opened) · `web_layout_export` (raw planner JSON, no persist).

To LIST or SWITCH documents: `web_document_list` (every GLB the project owns plus the
built-in and published sources, with sizes; filter + optional nodeCount) and
`web_document_open(document=<id|name|path>)`. Delete/rename a saved custom document with
`web_document_update`. The parts CATALOG (`web_catalog_list`) is different: those are
placeable templates, not project documents.

## Tool reference

<!-- BEGIN GENERATED: tool-reference layout — do not edit; run `npm run gen:mcp-docs` -->
_20 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_catalog_describe` | read | `catalogId` string **req** | Describe one parts-catalog entry for building: purpose, material-flow direction, snap connections, key config. |
| `web_catalog_list` | read | — | List the placeable PARTS CATALOG of the layout planner: catalogId, name, category, footprintMm [x,z], short description. |
| `web_document_bind` | write | `document` string **req**, `field` string **req**, `ref` string | BIND or UNBIND one reference field of a document — the project.json edit the dashboard's reference slots make. |
| `web_document_info_get` | read | `document` string | Read the DESCRIPTION of a document (summary + Markdown, stored in its GLB). |
| `web_document_info_set` | write | `document` string **req**, `summary` string, `description` string | Write the DESCRIPTION of any document of the open project into its GLB. |
| `web_document_list` | read | `filter` string, `withNodeCount` boolean | List the DOCUMENTS of the open project — THE one list. |
| `web_document_new` | write | `name` string, `folder` string | Create a new empty DOCUMENT in the project and open it, returning its documentId and path. |
| `web_document_open` | write | `document` string **req** | LOAD a document into the viewer, or clear it. |
| `web_document_save` | write | `name` string | Save the current document. With name: saves a NEW named document and returns its documentId; without: saves the open one in place with compare-and-swap. |
| `web_document_update` | write | `action` string **req**, `relPath` string **req**, `newName` string, `toFolder` string | Delete, rename or move a saved DOCUMENT or attachment file of the open project (path from web_document_list / web_project_tree — any folder, not just library/). |
| `web_layout_export` | read | — | Export the current planner layout as raw JSON (placements + catalogs + grid) without persisting anything. |
| `web_layout_list` | read | — | List placed layout components: id, catalogId, label, position (m), rotation (deg), world bounds (center + size). |
| `web_layout_move` | write | `id` string **req**, `x` number **req**, `y` number **req**, `z` number **req**, `rx` number, `ry` number, `rz` number | Move/rotate a placement (position meters, rotation degrees XYZ; omitted rotation axes keep their current value). |
| `web_layout_place` | write | `catalogId` string **req**, `x` number **req**, `y` number **req**, `z` number **req**, `onto` string | Place a catalog component (planner mode; catalogId from web_catalog_list). |
| `web_layout_remove` | write | `id` string **req** | Remove a placed component by id (from web_layout_list). |
| `web_layout_snap_attach` | write | `targetId` string **req**, `catalogId` string **req**, `targetSnapName` string, `flow` string | Attach a catalog component onto a free snap of a placement, auto-aligned — THE way to build connected conveyor lines. |
| `web_layout_snap_list` | read | `id` string **req** | List the free (unoccupied) snap points of a placement (id from web_layout_list): snapName, typeId, flow, axis, dirCode per open port. |
| `web_layout_snap_suggest` | read | `targetId` string **req**, `targetSnapName` string | Suggest library components compatible with a free snap (same typeId + compatible flow). |
| `web_layout_timings` | read | `clear` boolean | Placement performance timings: per-phase decode records (fetch/parse/uber-bake of a GLB, once per asset per document), per-phase chunk-bake records (roles/split/stage/pi… |
| `web_scene_query` | read | `expression` string **req**, `root` string | READ-ONLY JavaScript query over a frozen plain-data snapshot of the scene — the escape hatch for any geometric/material question no dedicated tool answers. |
<!-- END GENERATED: tool-reference layout -->
