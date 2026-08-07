# realvirtual WEB MCP Tools

Browser-based 3D viewer for industrial digital twins. The `web_*` tools read and control the
running Three.js scene directly — no Unity required. Unity tools (when connected) modify the
Unity scene; both can run side by side (`drive_list` vs `web_drive_list`).

**Deep guides on demand:** `web_help(topic)` — topics: `editor` (kinematize/materialize CAD),
`layout` (build conveyor lines, heights), `simulation` (debugging), `plc`, `des`.
Read the matching guide before starting a multi-step workflow.

## Tool domains

Names follow `web_<domain>_<action>`:

| Domain | Tools | Purpose |
|--------|-------|---------|
| (root) | `web_status`, `web_logs`, `web_errors`, `web_help`, `web_measure`, `web_render` | Orientation, console logs, alarms, guides; `web_measure` = distances/gaps BETWEEN parts, `web_render` = offscreen render from any camera pose (`beauty` or `idmask` segmentation + color→path legend), never touching the user's viewport |
| `node` | `web_node_find`, `web_node_tree`, `web_node_bounds`, `web_node_shape` | Scene-graph search, structure, measurement — the source of the node paths all other tools take; `_shape` gives PCA shape class + functional (rotation) axis |
| `component` | `web_component_get`, `_get_all`, `_list`, `_set` | Read/write component config (rv_extras) |
| `view` | `web_view_pick`, `_gaze`, `_isolate`, `_source_markers` | Point at things (pick/gaze also select the hit node), de-clutter, overlays |
| `camera` | `web_camera_get`, `_set`, `_focus`, `_orbit`, `_projection` | Drive the real viewport camera (animated), incl. perspective/iso switch |
| `select` | `web_select`, `web_selection_get`, `web_select_similar` | Selection = same highlights/panels as user clicks |
| `screenshot` | `web_screenshot`, `_burst`, `_annotated`, `_analyze` | Single frame, motion montage, labelled markers, 4-view shape analysis |
| `drive`/`signal`/`sensor` | `web_drive_list/_jog/_stop/_speed_override`, `web_signal_list/_status/_set_bool/_set_float`, `web_sensor_list` | Runtime actuation & diagnosis |
| `sim` | `web_sim_play_pause`, `web_sim_reset`, `web_transport_status`, `web_logic_flow` | Simulation control & material flow |
| `mode` | `web_mode_set` | Switch workspace: hmi / planner / des |
| `layout` | `web_layout_place/_move/_remove/_list`, `web_layout_snap_list/_suggest/_attach` | Build layouts (planner mode) |
| `library` | `web_library_list`, `web_library_describe` | Parts catalog |
| `scene` | `web_scene_new/_save/_open/_list/_export`, `web_scene_query` | Layout persistence; `_query` runs a READ-ONLY JS expression over a frozen scene snapshot — the escape hatch for geometry/material questions no dedicated tool answers |
| `editor` | `web_editor_*` (~30 tools) | Asset Editor: op-logged GLB authoring — lifecycle, transforms, pivots, kinematics, materials, `_kinematize`, `_materialize`, `_verify_drive`, `_shortcut` (keyboard chords: "S>I", "K", "H", …) |
| `des`/`plc` | `web_des_*`, `web_plc_*` | Event simulation / virtual PLC (internal builds) |

## Hard rules

- **Node paths** come from `web_node_find` / `web_node_tree` — always pass full paths.
- **Units:** positions/sizes in meters; drive positions/limits in mm (linear) or degrees (rotary);
  rotations in degrees.
- **Mode gates:** `web_layout_*` needs planner mode (`web_mode_set`); `web_editor_*` needs the
  editor (`web_editor_open`, NOT `web_mode_set`). Tools return an actionable error otherwise.
- **Editor edits are op-logged:** every `web_editor_*` change is undoable (`web_editor_undo`)
  and shows live in the UI panels — iterate freely, verify with `web_editor_verify_drive`
  BEFORE `web_editor_save`.
- `web_layout_place` drops parts on the ground (`y` ignored) — heights via `web_layout_move`
  (rules: `web_help("layout")`).

## Core workflows (details via web_help)

- **Kinematize + materialize CAD** (`web_help("editor")`): `web_editor_open` → perceive
  (`web_node_tree`, `web_camera_focus`, `web_screenshot_annotated`, `web_node_bounds`,
  `web_select_similar`) → `web_editor_kinematize` → `web_editor_verify_drive` →
  `web_editor_materialize` → `web_editor_save`.
- **Build a layout** (`web_help("layout")`): `web_mode_set(planner)` → `web_library_list` →
  `web_layout_place` → `web_layout_snap_attach` chain → `web_component_set` →
  `web_sim_play_pause` → `web_scene_save`.
- **Debug motion/flow** (`web_help("simulation")`): `web_drive_list` → `web_signal_status` →
  actuate (`web_drive_jog` / `web_signal_set_*`) → `web_screenshot_burst`.

## Connection

Every tool runs **in the browser**; this server only proxies. The viewer tab connects out to
whichever bridge is hosting it — realvirtual CONNECT (`/webviewer` on the gateway port, the
default) or the standalone Node bridge — and the tool surface is identical either way.

- **"WebViewer not connected"** = no viewer tab is attached (tab closed, not loaded, or still
  reconnecting). It reconnects on its own with backoff; retry the call.
- **One tab owns the bridge.** Opening a second viewer takes ownership and disconnects the first.
- **Data is fresh on every call** — nothing is cached or polled.
- **Tools appear and disappear with the tab.** The list is whatever the attached viewer announces,
  so it changes with the viewer's mode and build.

## Result sizes

Image tools (`web_screenshot`, `_burst`, `_annotated`, `_analyze`) are budgeted before they are
sent: an over-large frame is downscaled and re-encoded, and one that still does not fit returns
`{ error, imageBudgetExceeded: { bytes, budgetBytes, width, height } }` instead of a picture. If
you see it, ask for less — a tighter `path`/crop, fewer `paths`, a smaller `tileSize`. The same
applies to text results: a reply that would exceed the frame budget is replaced by an error naming
the size, so narrow the query rather than retrying it unchanged.

<!--
Maintainers: this file is the MCP server's `instructions` string. Node reads it from disk at
startup, CONNECT embeds it at build time (Connect.csproj → EmbeddedResource
`realvirtual.Connect.webviewer.mcp.md`) — so a change here only reaches CONNECT clients after
realvirtual-Connect.exe is rebuilt. Keep it transport-neutral: it is served by both bridges.
-->

