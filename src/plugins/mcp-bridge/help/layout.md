# Layout building (Layout Planner)

Build connected material-flow layouts in the browser. Requires planner mode: `web_mode_set("planner")`.

## Build a conveyor line

1. `web_mode_set` (`mode=planner`)
2. `web_library_list` — parts catalog (catalogId, name, footprintMm); `web_library_describe` for build docs
3. `web_layout_place` — drop the first part at a world position (meters)
4. `web_layout_snap_list` (placement id) — the part's free snap points (open ports)
5. `web_layout_snap_suggest` (id, snapName) — which parts fit that snap *(optional)*
6. `web_layout_snap_attach` (targetId, catalogId, snapName) — attach the next part auto-aligned; repeat to chain the line
7. `web_component_set` — configure behavior (drive `TargetSpeed`, source spawn interval, …)
8. `web_layout_list` — review positions + world bounds
9. `web_mode_set` (`mode=hmi`) + `web_sim_play_pause` — run it
10. `web_scene_save` — persist the layout

`web_layout_move` is the manual alternative to snap-attach when you need free positioning.

## Heights: putting a pallet / MU onto a conveyor

`web_layout_place` drops every part on the **ground plane** — its `y` argument is ignored.
To rest a pallet on a conveyor, place it, then `web_layout_move` it to the conveyor's
**transport-surface height**:

- The transport surface (roller top) is a **logical plane**, NOT the bounding-box top from
  `web_layout_list` — the box top includes side frames/guides above the rollers; a pallet
  placed there floats.
- Standard **Roll Conveyor**: transport surface ≈ **y = 0.62 m**.
- A pallet's origin is its **underside** — `web_layout_move(..., y = surfaceHeight)` rests it
  exactly on the surface; do not add half the pallet height.
- Reuse the conveyor's `bounds.center` x/z from `web_layout_list` to center the pallet;
  only the height comes from the transport surface.

## Scenes

`web_scene_new` (clean reset) · `web_scene_save` (persist, optional name) ·
`web_scene_list` / `web_scene_open` (switch) · `web_scene_export` (raw JSON, no persist).

## Tool reference

<!-- BEGIN GENERATED: tool-reference layout — do not edit; run `npm run gen:mcp-docs` -->
_15 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_layout_list` | read | — | List placed layout components: id, catalogId, label, position (m), rotation (deg), world bounds (center + size). |
| `web_layout_move` | write | `id` string **req**, `x` number **req**, `y` number **req**, `z` number **req**, `rx` number, `ry` number, `rz` number | Move/rotate a placement (position meters, rotation degrees XYZ). |
| `web_layout_place` | write | `catalogId` string **req**, `x` number **req**, `y` number **req**, `z` number **req** | Place a library component on the ground plane (planner mode; catalogId from web_library_list). |
| `web_layout_remove` | write | `id` string **req** | Remove a placed component by id (from web_layout_list). |
| `web_layout_snap_attach` | write | `targetId` string **req**, `catalogId` string **req**, `targetSnapName` string | Attach a library component onto a free snap of a placement, auto-aligned — THE way to build connected conveyor lines. |
| `web_layout_snap_list` | read | `id` string **req** | List the free (unoccupied) snap points of a placement (id from web_layout_list): snapName, typeId, flow, axis, dirCode per open port. |
| `web_layout_snap_suggest` | read | `targetId` string **req**, `targetSnapName` string | Suggest library components compatible with a free snap (same typeId + compatible flow). |
| `web_library_describe` | read | `catalogId` string **req** | Describe one library component for building: purpose, material-flow direction, snap connections, key config. |
| `web_library_list` | read | — | List the parts catalog: catalogId, name, category, footprintMm [x,z], short description. |
| `web_scene_export` | read | — | Export the current layout as raw JSON (placements + catalogs + grid) without persisting anything. |
| `web_scene_list` | read | — | List the project documents plus the built-in sources. |
| `web_scene_new` | write | — | Create a new empty DOCUMENT in the project and open it, returning its documentId. |
| `web_scene_open` | write | `id` string **req** | Open a document by id. DEPRECATED ALIAS of web_model_open (plan-716). |
| `web_scene_query` | read | `expression` string **req**, `root` string | READ-ONLY JavaScript query over a frozen plain-data snapshot of the scene — the escape hatch for any geometric/material question no dedicated tool answers. |
| `web_scene_save` | write | `name` string | Save the current document. DEPRECATED ALIAS (plan-716) — the name says "scene", the op is a document write. |
<!-- END GENERATED: tool-reference layout -->
