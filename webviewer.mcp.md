# realvirtual WEB MCP Tools

Browser-based 3D viewer for industrial digital twins. The `web_*` tools read and control the
running Three.js scene directly — no Unity required. Unity tools (when connected) modify the
Unity scene; both can run side by side (`drive_list` vs `web_drive_list`).

**Deep guides on demand:** `web_help(topic)` — topics: `editor` (kinematize/materialize CAD
tool reference), `kinematize` (the full CAD-to-kinematic-model recipe: perception, knowledge
folder, axes with visual verification, materials), `layout` (build conveyor lines, heights),
`simulation` (debugging), `plc`, `des`.
Read the matching guide before starting a multi-step workflow — for kinematizing a raw CAD
import that guide is `kinematize`.

## Tool domains

Names follow `web_<domain>_<action>`:

| Domain | Tools | Purpose |
|--------|-------|---------|
| (root) | `web_status`, `web_logs`, `web_errors`, `web_help`, `web_describe`, `web_measure`, `web_render`, `web_ping` | Orientation, console logs, alarms, guides; `web_measure` = distances/gaps BETWEEN parts, `web_render` = offscreen render from any camera pose (`beauty` or `idmask` segmentation + color→path legend), never touching the user's viewport; `web_ping` is the timer-free liveness probe to reach for when other tools time out |
| `node` | `web_node_find`, `web_node_tree`, `web_node_bounds`, `web_node_shape` | Scene-graph search, structure, measurement — the source of the node paths all other tools take; `_shape` gives PCA shape class + functional (rotation) axis |
| `component` | `web_component_get`, `_get_all`, `_list`, `_set` | Read/write component config (rv_extras) |
| `view` | `web_view_pick`, `_gaze`, `_isolate`, `_source_markers`, `_sweep` | Point at things (pick/gaze also select the hit node), de-clutter, overlays; `_sweep` returns ONE contact sheet of 4–8 views around a part plus a note per view — understanding an unknown assembly in a single call |
| `camera` | `web_camera_get`, `_set`, `_focus`, `_orbit`, `_projection`, `_fly` | Drive the real viewport camera (animated), incl. perspective/iso switch; `_fly` moves RELATIVE (forward/right/up in metres, yaw/pitch in degrees, `ground=true` to walk) — use it to travel THROUGH a long line, where orbiting a fixed point is the wrong metaphor |
| `select` | `web_select`, `web_selection_get`, `web_select_similar` | Selection = same highlights/panels as user clicks |
| `screenshot` | `web_screenshot`, `_burst`, `_annotated`, `_analyze` | Single frame, motion montage, labelled markers, 4-view shape analysis |
| `drive`/`signal`/`sensor` | `web_drive_list/_jog/_stop/_speed_override`, `web_signal_list/_status/_set_bool/_set_float`, `web_sensor_list` | Runtime actuation & diagnosis |
| `signal` (binding) | `web_signal_bindings_list`, `web_signal_sources_list`, `web_signal_bind`, `web_signal_unbind` | Wire an external PLC to the model — see *Bind a PLC to a model* below |
| `sim` | `web_sim_play_pause`, `web_sim_reset`, `web_transport_status`, `web_logic_flow` | Simulation control & material flow |
| `mode` | `web_mode_set` | Switch workspace: hmi / planner / des |
| `layout` | `web_layout_place/_move/_remove/_list`, `web_layout_snap_list/_suggest/_attach` | Build layouts (planner mode) |
| `catalog` | `web_catalog_list`, `web_catalog_describe` | Parts catalog of the layout planner — placeable TEMPLATES (`catalogId`), not project documents |
| `document` | `web_document_list`, `web_document_open`, `_save`, `_new`, `_update` | **THE document family.** Asset = document = model — one concept, the GLB document of the open project; `scenes/`, `models/`, `library/` are storage places, not types. `_list` is the one list (every GLB the project owns with sizes, plus the read-only built-in SOURCES and, under `published`, the dev-only documents no delivered channel ships); `_open` loads any of them into the viewport; `_save`/`_new` write; `_update` deletes/renames saved custom documents |
| `project` | `web_project_list`, `web_project_open`, `web_project_tree`, `web_project_folder` | Which project the project-relative paths (`cad/`, `library/`, `knowledge/`, `models/`) resolve against; `_open` switches IN PLACE, so the bridge connection survives. `_tree` navigates the project's folder/document tree exactly as the dashboard shows it; `_folder` creates/renames/moves folders through the same tree verdicts, so document ids never change and references keep resolving |
| `scene` | `web_scene_query` | READ-ONLY JS expression over a frozen scene snapshot — the escape hatch for geometry/material questions no dedicated tool answers. (The old `web_scene_new/_save/_export` document verbs are retired: they are `web_document_new/_save` and `web_layout_export` now) |
| `editor` | `web_editor_*` (~30 tools) | Asset Editor: op-logged GLB authoring — lifecycle, transforms, pivots, kinematics, materials, `_kinematize`, `_materialize`, `_verify_drive`, `_shortcut` (keyboard chords: "S>I", "K", "H", …) |
| `des`/`plc` | `web_des_*`, `web_plc_*` | Event simulation / virtual PLC (internal builds) |
| `knowledge` | `web_knowledge_set`, `web_knowledge_get`, `web_knowledge_list` | Your memory of this machine, one Markdown note per node, stored inside the GLB — see *Remember what you worked out* below |
| `link` | `web_link_compose` | Hand out a URL instead of just opening things: with no arguments it snapshots what is open (document/model + active mode + option) into a shareable deep link; with arguments it validates each against the live catalogues and composes one. Read-only, mints no share, and copies nothing from the current address bar — access keys never leak into a composed link |

### Full roster

The table above says what each domain is FOR; the one below is the complete inventory, generated
from the decorators so it cannot fall behind the code. Parameters per tool: `web_help(topic)`.

<!-- BEGIN GENERATED: tool-domains — do not edit; run `npm run gen:mcp-docs` -->
_145 tools across 25 domains, generated from the @McpTool decorators — do not edit by hand. Purpose and workflow live in the prose above and in `web_help(topic)`._

| Domain | # | Tools |
|--------|---|-------|
| `(root)` | 8 | `web_describe`, `web_errors`, `web_help`, `web_logs`, `web_measure`, `web_ping`, `web_render`, `web_status` |
| `camera` | 7 | `web_camera_fly`, `web_camera_focus`, `web_camera_get`, `web_camera_orbit`, `web_camera_projection`, `web_camera_set`, `web_camera_view` |
| `catalog` | 2 | `web_catalog_describe`, `web_catalog_list` |
| `component` | 4 | `web_component_get`, `web_component_get_all`, `web_component_list`, `web_component_set` |
| `des` | 6 | `web_des_bottleneck`, `web_des_components`, `web_des_set_mode`, `web_des_stats`, `web_des_status`, `web_des_step` |
| `document` | 5 | `web_document_list`, `web_document_new`, `web_document_open`, `web_document_save`, `web_document_update` |
| `drive` | 4 | `web_drive_jog`, `web_drive_list`, `web_drive_speed_override`, `web_drive_stop` |
| `editor` | 58 | `web_editor_add_component`, `web_editor_add_logic_step`, `web_editor_add_signal`, `web_editor_assign_material`, `web_editor_assign_to_kinematic`, `web_editor_back`, `web_editor_close`, `web_editor_convert_signal`, `web_editor_create_empty`, `web_editor_create_kinematic`, `web_editor_delete`, `web_editor_descend`, `web_editor_import_cad`, `web_editor_import_glb`, `web_editor_kinematize`, `web_editor_list_kinematics`, `web_editor_material_presets`, `web_editor_material_stats`, `web_editor_materialize`, `web_editor_mechanism_add_body`, `web_editor_mechanism_add_joint`, `web_editor_mechanism_assign_drive`, `web_editor_mechanism_create`, `web_editor_mechanism_fix`, `web_editor_mechanism_forces`, `web_editor_mechanism_inspect`, `web_editor_mechanism_jog`, `web_editor_mechanism_set_anchor`, `web_editor_mechanism_set_anchor_snap`, `web_editor_mechanism_set_axis`, `web_editor_mechanism_set_limits`, `web_editor_mechanism_set_mass`, `web_editor_mechanism_snap_list`, `web_editor_mechanism_statics`, `web_editor_mechanism_validate`, `web_editor_open`, `web_editor_pivot`, `web_editor_project_files`, `web_editor_project_info`, `web_editor_redo`, `web_editor_remove_component`, `web_editor_rename`, `web_editor_reparent`, `web_editor_rotate90`, `web_editor_save`, `web_editor_separate`, `web_editor_set_field`, `web_editor_set_visible`, `web_editor_shortcut`, `web_editor_status`, `web_editor_test_start`, `web_editor_test_stop`, `web_editor_to_ground`, `web_editor_toggle_signal_direction`, `web_editor_transform`, `web_editor_undo`, `web_editor_verify_drive`, `web_editor_zero_position` |
| `knowledge` | 3 | `web_knowledge_get`, `web_knowledge_list`, `web_knowledge_set` |
| `layout` | 8 | `web_layout_export`, `web_layout_list`, `web_layout_move`, `web_layout_place`, `web_layout_remove`, `web_layout_snap_attach`, `web_layout_snap_list`, `web_layout_snap_suggest` |
| `link` | 1 | `web_link_compose` |
| `logic` | 1 | `web_logic_flow` |
| `mode` | 1 | `web_mode_set` |
| `node` | 4 | `web_node_bounds`, `web_node_find`, `web_node_shape`, `web_node_tree` |
| `plc` | 4 | `web_plc_deploy`, `web_plc_run`, `web_plc_status`, `web_plc_stop` |
| `project` | 4 | `web_project_folder`, `web_project_list`, `web_project_open`, `web_project_tree` |
| `scene` | 1 | `web_scene_query` |
| `screenshot` | 4 | `web_screenshot`, `web_screenshot_analyze`, `web_screenshot_annotated`, `web_screenshot_burst` |
| `select` | 2 | `web_select`, `web_select_similar` |
| `selection` | 1 | `web_selection_get` |
| `sensor` | 1 | `web_sensor_list` |
| `signal` | 8 | `web_signal_bind`, `web_signal_bindings_list`, `web_signal_list`, `web_signal_set_bool`, `web_signal_set_float`, `web_signal_sources_list`, `web_signal_status`, `web_signal_unbind` |
| `sim` | 2 | `web_sim_play_pause`, `web_sim_reset` |
| `transport` | 1 | `web_transport_status` |
| `view` | 5 | `web_view_gaze`, `web_view_isolate`, `web_view_pick`, `web_view_source_markers`, `web_view_sweep` |
<!-- END GENERATED: tool-domains -->

## Hard rules

- **Start with `web_describe`.** One read-only call gives the active mode, the open document
  (including `busy` and `nodeCount`), the selection, the runtime, which tool families are
  blocked and why, and the ONE recommended next action. Call it again whenever a result
  surprises you. It complements `web_help` — that stays the workflow guide.
- **Write results carry a `verified` block — read it.** It reports what actually changed,
  not what was requested. `noop: true` means the tool reported success and NOTHING
  observable happened: treat it as a failure the tool did not notice, not as success. For
  editor tools `changed` counts op kinds, which is how you tell "the group was named"
  (`setField×1`) from "its members actually moved" (`reparentNode×8`). `ambiguous: true`
  means another call overlapped on the same scope, so the change cannot be attributed to
  yours. A result with `error` never carries `verified`.
- **Node paths** come from `web_node_find` / `web_node_tree` — always pass full paths.
- **`web_node_tree` starts at the MODEL ROOT** when you omit `root`, not at the raw Three.js
  scene (it falls back to the scene only when no model is loaded). Child paths are unchanged —
  `Robot/Base/Joint` is the same string either way — so only the root entry itself and the depth
  you reach per call differ from the pre-plan-715 behaviour. Pass `root` explicitly to start
  anywhere else, including runtime siblings such as the planner's `_layoutRoot`.
- **`locked: true` on a node means the model root.** It cannot be renamed, transformed, deleted,
  reparented or hidden: its name is the first segment of every node path and its pose is the
  asset origin. `web_editor_rename` / `web_editor_transform` / `web_editor_set_visible` answer
  with an error on it. Its components and metadata ARE editable (`web_component_set`) — that is
  the intended way to attach asset-level data.
- **Units:** positions/sizes in meters; drive positions/limits in mm (linear) or degrees (rotary);
  rotations in degrees.
- **Mode gates:** `web_layout_*` needs planner mode (`web_mode_set`); `web_editor_*` needs the
  editor (`web_editor_open`, NOT `web_mode_set`). Tools return an actionable error otherwise.
- **Editor edits are op-logged:** every `web_editor_*` change is undoable (`web_editor_undo`)
  and shows live in the UI panels — iterate freely, verify with `web_editor_verify_drive`
  BEFORE `web_editor_save`. The log is ONE vocabulary (`RvOp`) over one document class, shared
  with scene edits, so undo/redo and the dirty state behave identically in both — a multi-step
  tool call is one `composite` op and therefore ONE undo step, never N.
- **Ops queued during a base swap are dropped, not queued:** while a CAD re-import replaces the
  document's base, an edit is rejected outright — not applied and not recorded. Re-issue it
  after the import reports done rather than assuming it landed.
- **`web_editor_open` never continues the open SCENE — it opens an asset.** A human switching
  into the Editor while a saved scene is on screen keeps that scene's living document (one op
  log, one undo stack across the switch, plan-711). That path is a *transition*, and
  `web_editor_open` does not take it: it resolves an empty document or a library/project asset,
  and an explicit request always outranks what is on screen. So do not expect scene edits made
  with `web_component_set` / `web_layout_*` to appear in the editor session you open, or editor
  edits to show up in the scene afterwards — they are two documents. Edit the scene with the
  scene tools and save it (`web_document_save`), or edit the asset in the editor and save it
  (`web_editor_save`); pick one per task rather than mixing them and assuming continuity.
- `web_layout_place` drops parts on the ground (`y` ignored) — heights via `web_layout_move`
  (rules: `web_help("layout")`).

## Core workflows (details via web_help)

- **Kinematize + materialize CAD** (`web_help("editor")`): `web_editor_open` → perceive
  (`web_node_tree`, `web_camera_focus`, `web_screenshot_annotated`, `web_node_bounds`,
  `web_select_similar`) → `web_editor_kinematize` → `web_editor_verify_drive` →
  `web_editor_materialize` → `web_editor_save`.
- **Build a rigid-body mechanism** (`web_help("editor")`): `web_editor_mechanism_create` →
  `web_editor_mechanism_add_joint` (omit `bodyAPath` for a world anchor) →
  `web_editor_mechanism_assign_drive` → `web_editor_mechanism_validate` →
  `web_editor_mechanism_jog`. Use this for closed loops (four-bar, scissor, Delta) —
  NOT for a single hinge or carriage, which is a kinematic axis (`web_editor_kinematize`).
  `_validate` and `_jog` are transient: no ops, no undo entries.
- **Understand an unknown assembly:** `web_view_sweep(paths)` — ONE contact sheet of 4–8 views
  plus a note per view (visible top nodes with coverage, background share, measured camera
  position) → pick the interesting cell → `web_camera_set(<its cameraPosition>)` →
  `web_screenshot`. Replaces the orbit → screenshot → orbit loop at roughly a fifth of the
  vision tokens. `topNodes` is a raycast SAMPLE, so thin parts (railings, cable trays) can be
  missed — check `samples` and `background` before concluding something is absent.
- **Travel through a long line:** `web_camera_fly(forward, right, up, yawDeg, pitchDeg)` moves
  RELATIVE to where the camera is, and `ground=true` walks at eye height over the surface
  below. `web_camera_orbit` circles a fixed point and is the wrong tool for an 80 m line.
- **Build a layout** (`web_help("layout")`): `web_mode_set(planner)` → `web_catalog_list` →
  `web_layout_place` → `web_layout_snap_attach` chain → `web_component_set` →
  `web_sim_play_pause` → `web_document_save`.
- **Debug motion/flow** (`web_help("simulation")`): `web_drive_list` → `web_signal_status` →
  actuate (`web_drive_jog` / `web_signal_set_*`) → `web_screenshot_burst`.
- **Bind a PLC to a model:** `web_signal_bindings_list` (what slots exist, what is on them) →
  `web_signal_sources_list` (what the PLC offers) → `web_signal_bind` per pair.
  This is the autobinding path: match by NAME and COMMENT — both lists carry the comment
  authored in Unity, which is usually the only place a tag's meaning is written down.
  - **Address a slot by `targetId` + `componentPath` + `slot`.** A Planner placement
    aggregates its subtree, so one target can carry the same slot name on several
    components; `targetId + slot` alone is refused rather than guessed.
  - **`web_signal_bind` validates exactly like a manual drag** (type, direction, provider
    identity) and returns the same sentence a user would see on the same refusal.
  - **`persisted: true` in the answer means it will survive a reload.** The tool checks it
    CAN save before it changes anything, so a bind either sticks or does not happen.
  - Broken links ride along in the `orphans` section of `web_signal_bindings_list`, with a
    `candidateComponentPath` where the component merely moved. Repairing is deliberately NOT
    a tool: it stays a human click in the bindings overview panel, because a repair that
    picked the wrong component would silently rewire a machine.
  - Both mutating tools need CONNECT's write switch (*Details ▸ MCP server ▸ Allow write
    access*); without it they are not offered and calling them by name is refused.
- **Remember what you worked out:** `web_knowledge_list` at the START of a session (what did
  earlier sessions establish?) → `web_knowledge_get` on the nodes that matter →
  `web_knowledge_set` when you have learned something durable.
  - **One overwritable note per node.** `set` replaces the whole note; it does not append.
    Read first if you mean to extend.
  - **Write facts, not state.** "Axis 3 is a hydraulic clamp despite the name; upper limit is
    mechanical" is worth a note. "Currently jogging forward" is not — it will be wrong in a
    minute and nothing will correct it.
  - **`confidence` is not decoration.** `observed` means you measured or saw it; `inferred` and
    `unverified` mark a guess. A guess written as fact is how a later session inherits a wrong
    belief with no way to spot it. `updatedAt` is written for you and is the only staleness
    signal a reader gets.
  - **Check `persistedTo` in the answer.** `asset` = in the asset document, call
    `web_editor_save`. `scene` = optimistic; the debounced scene autosave carries it, and a
    model switch CANCELS that timer rather than flushing it. `none` = the workspace persists
    nothing (a transient Example or shared link) and the note dies on reload — do not keep
    writing notes into it.
  - **Over 4000 characters is an error, not a shortening.** Truncated knowledge reads as
    complete knowledge, so the tool refuses and stores nothing. The count is UTF-16 code
    units, so astral emoji cost two each.
  - The note lives in `rv_extras` on the glTF node and travels with the GLB. It is deliberately
    invisible to `web_component_get` (no live instance is created for it) — read it with
    `web_knowledge_get`. A Unity re-export of the model DROPS notes; see `doc-ai-integration.md`.
  - `web_knowledge_set` needs CONNECT's write switch; `_get` and `_list` do not.
- **Check a model before it ships** (offline — no viewer, no MCP, no three.js):
  `npm run audit:instruction-targets -- <model.glb> [--json]` resolves every
  `CustomRuntimeInstruction` step target straight from the GLB's JSON chunk and reports each as
  `resolvable`, `unresolvable` or `path not in GLB`. It counts twice — under the pre-plan-734
  alias rule and under the current one — so a single run shows before and after. Exit 0 = clean,
  1 = unresolvable targets, 2 = the file is missing or not a GLB. Run it before a customer
  delivery; details in `doc-node-paths.md` § *Checking a GLB before it ships*.

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

## Files: everything is project-relative

There is ONE store, the **open project**, and every path a tool takes or reports is relative to it.
A folder project keeps those files on disk, a browser project in OPFS; the paths are the same
either way, and no tool takes an absolute path (the browser cannot supply one).

- **Reading:** `web_editor_import_glb` / `web_editor_import_cad` take a project-relative `relPath`
  (e.g. `library/imports/part.glb`).
- **Writing:** `web_render` and `web_screenshot_annotated` take `savePath`. A bare name lands in
  `captures/`; a path that names its own folders is taken as given (`knowledge/<Asset>/views/x.png`).
- **Locating:** `web_editor_project_info` reports the open project, whether it is writable, the
  asset's `library/`-relative path and the conventional `knowledge/<Asset>` and `captures` paths.

With no writable project open these tools return an error rather than writing anywhere else. Put
files INTO a project through the app (import, drag-and-drop), not through the OS file manager: a
browser project has no folder on disk to drop into.

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

