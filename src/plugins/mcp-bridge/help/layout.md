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
