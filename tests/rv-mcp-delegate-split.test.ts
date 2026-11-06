// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-713 T1 — the delegate-split equivalence gate.
 *
 * Phase 1 moves 45 of the 51 tools that sat directly on `McpBridgePlugin` into
 * three new domain delegates. A code move is only a code move if nothing an
 * agent or a bridge can observe changes, so this test compares the announced
 * catalogue against the baseline frozen in Phase 0 — BEFORE the move — field by
 * field: name, description, inputSchema, readOnlyHint, timeoutMs.
 *
 * The plan's review explicitly rejected pinning tool ORDER: the bridges announce
 * a list, no consumer is promised an order, and pinning one turns every
 * instance-list reshuffle into a false failure. Everything else is verbatim.
 *
 * It also carries the DISPATCH smoke: a schema comparison cannot see a delegate
 * that is announced but never wired into `_sendDiscover`'s instance list, which
 * is precisely the failure mode a split introduces. One call per delegate
 * through the real `_handleCall` closes that gap.
 *
 * `RV_UPDATE_MCP_BASELINE=1 npx vitest run tests/rv-mcp-delegate-split.test.ts`
 * rewrites the baseline through the narrow Node-side command in vite.config.ts.
 * Do that only when the tool surface changed ON PURPOSE, in the same commit.
 */

import { describe, it, expect } from 'vitest';
import { commands } from '@vitest/browser/context';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { generateToolSchemasMulti, buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { allSchemas, allInstances, delegateCensus } from './helpers/mcp-schemas';
import { buildBaseline, toBaselineTools, type DiscoverBaseline } from './helpers/mcp-baseline';
import BASELINE_RAW from './fixtures/mcp-discover-baseline.json?raw';

/** The substring every path-list parameter description carries since 2026-11-01. */
const PATH_LIST_JSON_HINT = 'or a JSON array of strings for names containing commas';

/**
 * The Node-side writer, reached the same way `rv-mcp-docs-drift.test.ts` reaches
 * its own: `commands` is typed as an empty registry, and a module augmentation
 * for it does not survive this project's tsconfig. Never throws — without
 * `RV_UPDATE_MCP_BASELINE=1` this is a no-op and the comparisons below are the
 * whole test.
 */
async function writeBaselineBack(contents: string): Promise<boolean> {
  try {
    const cmd = (commands as unknown as Record<string, (...a: unknown[]) => Promise<{
      written: boolean; reason?: string;
    }>>)['writeMcpBaseline'];
    if (typeof cmd !== 'function') return false;
    const out = await cmd(contents);
    return out.written || out.reason === 'already up to date';
  } catch {
    return false;
  }
}

const baseline = JSON.parse(BASELINE_RAW) as DiscoverBaseline;

/**
 * Tools that did not exist when the baseline was frozen, declared by hand.
 *
 * The baseline stays frozen at the PRE-SPLIT catalogue on purpose, and
 * regenerating it for every later phase would throw away both things it is for:
 * the Phase-1 proof that the move changed nothing, and the Phase-0 payload
 * figure T4b measures against. So an addition is declared here instead — one
 * line per tool, in the same commit that adds it.
 *
 * The list is exhaustive in both directions below: a tool that appears without
 * being listed fails, and a listed tool that is not announced fails too. That is
 * what keeps it a declaration rather than a suppression.
 */
const ADDED_SINCE_BASELINE: string[] = [
  // 2026-09-24: the Display panel's Groups list became testable over MCP
  // (the Festo `Cover` that the persisted exclusion filter hid).
  // plan-740 Phase 2. The agent camera gains its own capture verb: up to five
  // aligned channels (beauty / idmask / edges / xray) from ONE pose in ONE
  // call, plus the Set-of-Mark sidecar.
  'web_eye',
  // 2026-09-11. Six orthographic views of a part as one mosaic per channel,
  // rendered through the same agent-eye channels as `web_eye`; a sibling of
  // `web_view_sweep` in McpViewTools, nothing retired.
  'web_view_ortho',
  // plan-479 Phase 6. Sets and clears a document's connectRef / scriptRef /
  // knowledgeRef — the manifest edit the dashboard's reference slots make, now
  // reachable from an agent. Deliberately NOT a fourth action of
  // `web_document_update`: that one is destructive and operates on files.
  // plan-486. The prompt queue's two verbs: `list` looks, `claim` takes the
  // oldest open task and marks it claimed. Additive — nothing is retired, and
  // no existing tool changes shape. `claim` is the only new WRITE, and it is a
  // write on a browser-tab queue, not on the model.
  'web_prompt_claim',
  // plan-753 (Phase 3 residual). Per-phase timings of the last planner
  // placements (decode / bake / pick-mesh / BVH / clipping), so the ~30 s a
  // 140 MB GLB used to take per placement can be attributed instead of guessed.
  // Read-only diagnostics beside `web_layout_place`; nothing retired.
  'web_layout_timings',
  // plan-729. Cartesian paths for rigid-body mechanisms (Delta pick & place):
  // five authoring writes beside the existing `web_editor_mechanism_*` family
  // plus one read of the path state. Nothing retired.
  // plan-501. Drive sizing from a sampled trajectory: import (write), run (write),
  // inspect and export (reads) beside the mechanism family. Nothing retired.
  // plan-506. Read and write a document's DESCRIPTION (summary + Markdown in the
  // GLB's scene extras, beside Classification) — document-scoped, any document
  // of the open project, through the same store path as the dashboard editor.
  // plan-517. Read-only component schema: the type list without argument, fields
  // (rv-odt.json) plus authoring rules (specification.md, lazy chunk) with `type`.
  // A new delegate of its own (McpComponentSchemaTool); nothing retired.
  'web_component_schema',
  // plan-760 Phase 2. The Quick Edit Groups section's four verbs as views of
  // `editor.group*` (private impl, command-bound): assign / remove / rename /
  // dissolve of PLAIN groups beside the kinematic family. Nothing retired.
  // plan-539 F15. Simulation / PLC mode of the loaded model (get / set) —
  // the toggle next to the simulation controls as a tool. Nothing retired.
  // plan-537. Deterministic frame-by-frame MP4 recording of the 3D canvas.
  // Nothing retired.
  'web_record_video',
  // plan-545. PLC auto-map: model PLC signals -> S7 / PLCSIM interface signals
  // (check / apply). A new delegate (McpSignalAutoMapTools); nothing retired.
  // plan-761. The render-mode pill's shading switch (simple / default / toon)
  // as a tool, bound to `view.renderMode` in McpRuntimeTools beside
  // `web_view_source_markers`. Nothing retired.
  // plan-566. The signal cross-reference list ("Used by") as a read-only tool —
  // a new delegate (McpSignalUsageTools); nothing retired.
  // plan-567. Remove / move a workpiece carrier in Commissioning — two writes in
  // McpRuntimeTools beside web_transport_status (which now also lists mus[].id).
  // plan-589 Phase 2. The signal editor's two verbs as views of
  // `editor.signalSetField` / `editor.signalSetBinding` in McpEditorTools: edit a
  // PLC signal's own fields (never its NAME), and set / change / remove its PLC
  // binding in ONE CONNECT container. Nothing retired.
  // plan-589 Phase 3. The reconcile report as a READ (a new verb of
  // McpSignalAutoMapTools), plus the one repair it offers as a view of
  // `editor.signalsCreateFromInterface` in McpEditorTools. Nothing retired.
  // plan-590. The signal rename as a view of `editor.signalRename` (dry run =
  // preview), plus the two Problems actions of a failed / unknown rename as views
  // of `editor.signalRenameRepair` / `editor.signalRenameRecheck` — all three in
  // McpEditorTools. Nothing retired.
  // plan-591. The quality axis (resolution / antialias / shadow map / AO /
  // reflection) as a tool, bound to `view.visualPreset` in McpRuntimeTools
  // beside `web_view_render_mode`. Nothing retired.
  // 8a34c524 (2026-10-08), absorbed at the 6.4.0 release. Session-only collision
  // roles (McpCollisionTools): watch subtrees, read the latched pairs, reset.
  // Nothing retired.
  // plan-764. OpenUSD export of the open document with the realvirtual extras
  // 1:1 (McpExportTools, a new delegate) — the card's "Export USD…" as a tool.
  // Nothing retired.
  'web_export_usd',
  // plan-764 Phase 2. "Apply USD extras…" as two calls on the same delegate
  // (McpExportTools): preview (read-only) and commit. Nothing retired.
  // plan-629. The congestion trace along the path network (McpTraceTools, a new
  // delegate): the top-N bottleneck buckets (read) and the band / time-range
  // switch (write). Nothing retired.
  // plan-621. The SolidCraft live sync (McpEditorTools): connect / resync /
  // disconnect, views of the solidcraft.* commands. Nothing retired.
  // plan-641 Phases 0-2. The reduced command interface (McpCommandTools, a new
  // delegate): list / execute / batch over the command registry; and the macro
  // recorder (McpMacroTools, a new delegate): record, list, get, annotate, save,
  // replay as a job, status, cancel. Nothing retired — the bound web_editor_*
  // tools stay as aliases.
  'web_commands',
  'web_execute',
  'web_batch',
  // plan-2007 Phase 0: the read door over read-only commands (McpCommandTools).
  'web_query',
  'web_macro_record_start',
  'web_macro_record_stop',
  'web_macro_list',
  'web_macro_get',
  'web_macro_annotate',
  'web_macro_save',
  'web_macro_replay',
  'web_macro_status',
  'web_macro_cancel',
  // plan-641 Phases 4-5. Geometry checks + the part library (McpCheckTools, a new
  // delegate) and the assertion line of a macro (McpMacroTools). Nothing retired.
  'web_check_gap',
  'web_check_contact',
  'web_macro_assert',
  // plan-641 Phase 2b. Import of a macro from the project folder or inline JSON
  // (McpMacroTools). Nothing retired.
  'web_macro_import',
  // plan-650 Phase 4. Parametric component families in the asset editor: define a family
  // (schema + rule code + parts root), set its values (one regeneration = one undo step),
  // inspect the build plan / hashes / limits. Nothing retired.
  'web_editor_parametric_define',
  'web_editor_parametric_set',
  'web_editor_parametric_inspect',
  // plan-655: the part LIBRARIES of the open project (project.json.libraries[]) —
  // list (read), attach / detach (views of library.attach / library.detach).
  // plan-773 Phases 1-2 (McpRobotTools, a new delegate). Four read tools as the web
  // pendant of Unity's `ik_get_chain` / `ik_get_state` / `ik_verify_fk`, plus the two
  // rigging verbs: `_rig_diagnose` (read-only, works on an UNRIGGED node) and
  // `_rig_from_library`, which writes a complete RobotIK in one call instead of seven
  // fields by hand. Nothing retired — there was no robot tool before.
  // plan-773 Phase 3: the path half of the same delegate — a path under the robot,
  // its waypoints, their order, and the solve that drives the robot onto one. The
  // listing is read-only; the six authoring verbs are `edit`. Nothing retired.
  // plan-773 Phase 5: the export half — one read tool that turns a path into a
  // vendor robot program (ABB RAPID, SEW MOVI-C) and hands the file(s) back
  // inline. Read-only: it re-solves every waypoint but writes nothing.
  // Nothing retired.
  // plan-664 Phase 2 (McpSensorDataTools, a new delegate). One read tool for the
  // ray sensors: the current scan frame out of the sensor data channel plus the
  // sensor's configuration, or the list of registered ray sensors without a path.
  // Unbound — there is no button it is a view of. Nothing retired.
  // plan-675 Phase 1. UV generation for geometry without texture coordinates
  // (McpEditorTools), a view of the macro command `editor.generateUVs`. Nothing retired.
].sort();

/**
 * Baseline tools RETIRED on purpose, with the name that replaced each.
 *
 * The counterpart of the additions list, and it carries the replacement rather
 * than just the name because that is the claim being made: F8 retires DUPLICATE
 * PAIRS, so every entry here must still be reachable under another name. The
 * test below checks exactly that, which is what stops this list from becoming a
 * way to delete a capability quietly.
 */
const RETIRED_SINCE_BASELINE: Record<string, string> = {
  web_signal_set_bool: 'web_execute',
  web_signal_set_float: 'web_execute',
  web_drive_jog: 'web_execute',
  web_sim_play_pause: 'web_execute',
  web_view_render_mode: 'web_execute',
  web_view_visual_preset: 'web_execute',
  web_sim_reset: 'web_execute',
  web_drive_stop: 'web_execute',
  web_drive_speed_override: 'web_execute',
  web_mu_delete: 'web_execute',
  web_mu_move: 'web_execute',
  web_library_attach: 'web_execute',
  web_library_detach: 'web_execute',
  web_layout_place: 'web_execute',
  web_layout_move: 'web_execute',
  web_layout_remove: 'web_execute',
  web_layout_snap_attach: 'web_execute',
  web_robot_rig_from_library: 'web_execute',
  web_robot_path_create: 'web_execute',
  web_robot_target_add: 'web_execute',
  web_robot_target_set: 'web_execute',
  web_robot_target_remove: 'web_execute',
  web_robot_target_reorder: 'web_execute',
  web_robot_solve_target: 'web_execute',
  web_robot_program_export: 'web_query',
  web_signal_bind: 'web_execute',
  web_signal_unbind: 'web_execute',
  web_knowledge_set: 'web_execute',
  web_document_info_set: 'web_execute',
  web_editor_undo: 'web_execute',
  web_editor_redo: 'web_execute',
  web_editor_transform: 'web_execute',
  web_editor_zero_position: 'web_execute',
  web_editor_rotate90: 'web_execute',
  web_editor_to_ground: 'web_execute',
  web_editor_pivot: 'web_execute',
  web_editor_rename: 'web_execute',
  web_editor_delete: 'web_execute',
  web_editor_set_visible: 'web_execute',
  web_editor_separate: 'web_execute',
  web_editor_generate_uvs: 'web_execute',
  web_editor_create_empty: 'web_execute',
  web_editor_reparent: 'web_execute',
  web_editor_add_component: 'web_execute',
  web_editor_remove_component: 'web_execute',
  web_editor_set_field: 'web_execute',
  web_editor_mechanism_create: 'web_execute',
  web_editor_mechanism_add_joint: 'web_execute',
  web_editor_mechanism_assign_drive: 'web_execute',
  web_editor_mechanism_jog: 'web_execute',
  web_editor_mechanism_set_anchor_snap: 'web_execute',
  web_editor_mechanism_set_axis: 'web_execute',
  web_editor_mechanism_add_body: 'web_execute',
  web_editor_mechanism_set_mass: 'web_execute',
  web_editor_mechanism_set_limits: 'web_execute',
  web_editor_mechanism_statics: 'web_execute',
  web_editor_mechanism_fix: 'web_execute',
  web_editor_solidcraft_connect: 'web_execute',
  web_editor_solidcraft_resync: 'web_execute',
  web_editor_solidcraft_disconnect: 'web_execute',
  web_editor_create_kinematic: 'web_execute',
  web_editor_assign_to_kinematic: 'web_execute',
  web_editor_group_assign: 'web_execute',
  web_editor_group_remove: 'web_execute',
  web_editor_group_rename: 'web_execute',
  web_editor_group_dissolve: 'web_execute',
  web_editor_add_signal: 'web_execute',
  web_editor_convert_signal: 'web_execute',
  web_editor_toggle_signal_direction: 'web_execute',
  web_editor_signal_set_field: 'web_execute',
  web_editor_signal_set_binding: 'web_execute',
  web_editor_signals_create_from_interface: 'web_execute',
  web_editor_signal_rename: 'web_execute',
  web_editor_signal_rename_repair: 'web_execute',
  web_editor_signal_rename_recheck: 'web_execute',
  web_editor_add_logic_step: 'web_execute',
  web_editor_shortcut: 'web_execute',
  web_editor_assign_material: 'web_execute',
  web_editor_materialize: 'web_execute',
  // plan-2007 Phase 4C: runtime and remaining read-only queries.
  web_drive_list: 'web_query',
  web_sensor_list: 'web_query',
  web_sensor_read: 'web_query',
  web_transport_status: 'web_query',
  web_logic_flow: 'web_query',
  web_trace_top: 'web_query',
  web_collision_status: 'web_query',
  web_group_list: 'web_query',
  web_knowledge_get: 'web_query',
  web_knowledge_list: 'web_query',
  web_document_info_get: 'web_query',
  web_import_usd_extras: 'web_query',
  web_link_compose: 'web_query',
  web_part_lookup: 'web_query',
  web_prompt_list: 'web_query',
  // plan-2007 Phase 4B: sixteen queries; timings stays because clear mutates its buffers.
  web_layout_list: 'web_query',
  web_layout_export: 'web_query',
  web_layout_snap_list: 'web_query',
  web_layout_snap_suggest: 'web_query',
  web_library_list: 'web_query',
  web_catalog_list: 'web_query',
  web_catalog_describe: 'web_query',
  web_signal_bindings_list: 'web_query',
  web_signal_sources_list: 'web_query',
  web_signal_reconcile: 'web_query',
  web_signal_usage: 'web_query',
  web_des_components: 'web_query',
  web_des_stats: 'web_query',
  web_des_bottleneck: 'web_query',
  web_plc_status: 'web_query',
  web_des_status: 'web_query',
  web_editor_mechanism_inspect: 'web_query',
  web_editor_mechanism_forces: 'web_query',
  web_editor_mechanism_path_inspect: 'web_query',
  web_editor_mechanism_snap_list: 'web_query',
  web_editor_mechanism_trajectory_export: 'web_query',
  web_editor_mechanism_trajectory_inspect: 'web_query',
  web_editor_mechanism_validate: 'web_query',
  web_robot_list: 'web_query',
  web_robot_get_chain: 'web_query',
  web_robot_get_state: 'web_query',
  web_robot_verify_fk: 'web_query',
  web_robot_rig_diagnose: 'web_query',
  web_robot_path_inspect: 'web_query',
  web_editor_list_kinematics: 'web_query',
  web_editor_material_presets: 'web_query',
  web_editor_material_stats: 'web_query',
  web_editor_project_files: 'web_query',
  web_editor_project_info: 'web_query',
  // plan-2007 Phase 3: mechanism authoring and sizing use registry commands.
  web_editor_mechanism_set_anchor: 'web_execute',
  web_editor_mechanism_add_target: 'web_execute',
  web_editor_mechanism_path_create: 'web_execute',
  web_editor_mechanism_path_add_waypoint: 'web_execute',
  web_editor_mechanism_path_remove_waypoint: 'web_execute',
  web_editor_mechanism_path_move_waypoint: 'web_execute',
  web_editor_mechanism_trajectory_import: 'web_execute',
  web_editor_mechanism_trajectory_run: 'web_execute',
  // plan-2007 Phase 2B: document, USD and signal auto-map commands.
  web_document_new: 'web_execute',
  web_document_update: 'web_execute',
  web_document_bind: 'web_execute',
  web_import_usd_extras_commit: 'web_execute',
  web_signal_automap: 'web_execute',
  // plan-2007 Phase 2A: component fields, kinematize and imports.
  web_component_set: 'web_execute',
  web_editor_kinematize: 'web_execute',
  web_editor_import_glb: 'web_execute',
  web_editor_import_cad: 'web_execute',
  // plan-2007 Phase 1: registry commands replace these tools (including later additions).
  web_group_set_visible: 'web_execute',
  web_group_set_listed: 'web_execute',
  web_trace_set: 'web_execute',
  web_collision_watch: 'web_execute',
  web_collision_reset: 'web_execute',
  web_mode_set: 'web_execute',
  web_des_step: 'web_execute',
  web_des_set_mode: 'web_execute',
  web_plc_deploy: 'web_execute',
  web_plc_run: 'web_execute',
  web_plc_stop: 'web_execute',
  web_view_isolate: 'web_execute',
  web_view_source_markers: 'web_execute',
  web_sim_mode: 'web_execute',
  // (empty.) The baseline was RE-FROZEN on 2026-08-19 with the terminology
  // rework: asset = document = model, one concept, hard rename with no aliases.
  // web_model_list/_open, web_scene_save/_new/_export, web_library_assets/
  // _update/_list/_describe became web_document_list/_open/_save/_new/_update,
  // web_catalog_list/_describe and web_layout_export (web_document_list also
  // absorbs the former web_library_assets file listing). The Phase-0/Phase-1
  // history this file used to prove lives in git; from here the declarations
  // start again at zero against the re-frozen surface.
  // 2026-09-15. `web_render` IS a duplicate retirement in the F8 sense: it was
  // the single-channel alias of `web_eye`, and its one unique feature — a
  // cameraPosition/cameraTarget pose for that call only — went with it by
  // decision, because the agent camera is now the single source of pose truth
  // (web_camera_get -> web_camera_set -> web_eye covers it in three calls).
  web_render: 'web_eye',
  // These two are NOT duplicates, and the entries below should be read as what
  // they are: a deliberate NARROWING. `web_view_pick`/`_gaze` were the only ray
  // hit-tests, so the world-point-and-normal answer is gone from the agent
  // surface (`web_editor_mechanism_snap_list` still returns bore axes, circle
  // centres and vertices under a canvas point, but only for joint authoring).
  // They were removed because they were the tools an agent reached for to ask
  // "what is this" — one ray, no occlusion information, and silently wrong when
  // the pick frame and the rendered frame disagreed on aspect. `web_view_sweep`
  // answers the same question with occlusion-correct coverage, which is why
  // it is named as the replacement for both.
  web_view_pick: 'web_view_sweep',
  web_view_gaze: 'web_view_sweep',
  // 2026-09-15, same session. `web_screenshot_annotated` goes as a DUPLICATE in
  // the F8 sense: `web_eye` with channels=idmask and explicit group `paths`
  // renders the same Set-of-Mark frame, the same legend and the same per-group
  // coverage. What the labelled shot additionally did was diff the requested
  // paths against the visible ones and report `notVisible: true` per path;
  // idmask lists only what IS visible, so that diff is the caller's now.
  web_screenshot_annotated: 'web_eye',
};

/**
 * Baseline tools whose DESCRIPTION changed deliberately, and what it must now say.
 *
 * Separate from the additions above because it is a weaker claim and has to look
 * like one: for these two the schema, the annotations and the timeout are still
 * compared verbatim, and only the description is exempt — against a substring
 * that pins WHY it was allowed to change. A blanket exemption would let the next
 * edit rewrite the description into anything at all.
 */
const REDESCRIBED_SINCE_BASELINE: Record<string, string> = {
  // plan-2007 Phase 5: agent descriptions point to the command doors and ids.
  web_document_save: 'layout.export',
  web_project_tree: 'editor.projectFiles',
  web_project_folder: 'document.delete',
  // plan-2005: the existing speed description includes simulation time as well as drives.
  // Phase 4A: descriptions now point to the read-only command ids.
  web_editor_test_start: 'mechanism.forces',
  web_editor_test_stop: 'mechanism.forces',
  // plan-525: BoxCollider and WebPhysicsZone became authorable — the add tool
  // names both and the one rule an agent cannot guess (a box on a mesh lands on
  // a new child `Collider`, whose path is returned).
  // 2026-09-17 field session (100-conveyor build): move/remove recorded no op,
  // so a save dropped them — both now say they are persisted; and a bare
  // play/pause call paused a running simulation, so the text says it TOGGLES.
  // plan-743: the workspace root is gone — the dashboard lists LINKED project
  // folders, so both project verbs had to stop talking about 'the configured
  // workspace'. Declared here on 2026-09-11 by /tidy: the code landed on
  // origin/main without this entry and left the gate red.
  web_project_list: 'List the LINKED PROJECTS of this browser',
  web_project_open: 'OPEN a linked project IN PLACE',
  // plan-736 renamed the row field `section` → `folder` (a place, not a type)
  // and kept `section` as a deprecated alias for one release; plan-744 F9
  // removed the alias. Both listings announce `folder` alone now, and the
  // pinned substring is the part that matters: an agent reading `folder` is
  // reading the only field there is. `rg` found no `section` consumer outside
  // this repo before the removal — not in CONNECT's C#, not in
  // `unity_mcp_server.py`.
  web_document_list: 'the first path segment (`""` at the root) — a place, not a type',
  // plan-744 F7: `library/Custom` stopped being the save-as fallback, so the
  // tool that named it as the destination had to stop naming it. The prose is
  // exempt; the schema, annotations and timeout are still compared verbatim.
  web_editor_save: 'the project ROOT when it has none',
  // d86eedf2 (2026-09-23): `web_editor_open` resolves the project's document
  // rows (id, name, project-relative path) instead of guessing
  // library/<relPath>. Landed without this entry and left the gate red;
  // declared on 2026-09-24.
  web_editor_open: 'a document id or a document name from web_document_list',
  // plan-740 Phase 1: every camera verb now drives the AGENT's own camera body
  // instead of the visible viewport, so each had to say whose camera it moves —
  // an agent that still reads "the visible viewport camera moves" would keep
  // sequencing its work around a camera it no longer drives. `web_camera_orbit`,
  // `_view` and `_fly` additionally dropped the "Refused while FPV,
  // camera-follow or XR own the camera" sentence, because they no longer refuse
  // (D-A7); that guard moved onto the double-click attach.
  web_camera_get: 'AGENT camera state',
  web_camera_set: 'Move the AGENT camera',
  web_camera_focus: 'with the AGENT camera',
  web_camera_orbit: 'Orbit the AGENT camera',
  web_camera_view: 'Move the AGENT camera to a NAMED view',
  web_camera_fly: 'Fly the AGENT camera',
  web_camera_projection: 'Switch the AGENT camera',
  // Same plan, the framing half only: selection and the isolate dimming stay
  // SHARED with the human (D-U3), the camera move that used to come with them
  // belongs to the agent now.
  web_node_bounds: 'frames them with the AGENT camera',
  // plan-740 Phase 3 (D-U10): the last five perception tools stopped reading
  // the human's drawing buffer. Each had to say so, because the picture they
  // return is a DIFFERENT picture now — from the agent pose, at a size the
  // agent chose, unaffected by the operator's open UI windows. The sweep
  // additionally dropped its whole animation vocabulary ("flies", "restores
  // the starting pose") and its raycast-sample caveat: coverage comes off the
  // ID mask of the very frame in the cell now.
  web_view_sweep: 'OFFSCREEN through the AGENT camera',
  web_screenshot_burst: 'from the AGENT camera',
  web_screenshot_analyze: 'from the AGENT camera direction',
  web_editor_verify_drive: 'aims the AGENT camera',
  // plan-472: the answer gained a `cog` block (the mechanism's centre of
  // gravity) and the description finally names `comLocalMm`, which was always
  // serialised and never documented. Both are pure ADDITIONS to the payload —
  // no field moved, no field left — so the schema, annotations and timeout are
  // still compared verbatim and only the prose is exempt. The pinned substring
  // is the part an agent acts on: a centre of gravity that arrives whether or
  // not anybody has a 3D marker switched on.
  // 2026-09-15: `web_render`, `web_view_pick` and `web_view_gaze` were removed,
  // so the three descriptions that pointed at them had to stop. Each now names
  // the tool that actually answers the question.
  web_node_find: 'web_eye channels=idmask',
  // Same session: `web_screenshot` pointed at `web_screenshot_annotated` for
  // labelled markers, which no longer exists.
  web_screenshot: 'for labelled markers web_eye with channels=idmask',
  // plan-753 Phase 3: the status answer gained the render diagnostics of the
  // loaded model (arena stats) and the bake stats of the planner placements
  // (baked assets, chunks, instances) — pure ADDITIONS to the payload, no field
  // moved or left, so the schema, annotations and timeout are still compared
  // verbatim and only the prose is exempt. The pinned substring is the new
  // block an agent orients on before reaching for `web_layout_timings`.
  // plan-2005 F9: lean by default — the render blocks moved behind detail:"render";
  // the bake sentence above is kept verbatim in the render half of the text.
  web_status: 'bake stats of the planner placements',
  // plan-753 part 2 (scene-ready contract): the open verb waits for the placed
  // references within a budget and says so; `web_status` (above, still pinned
  // by its bake sentence) additionally announces `placements` (state, pending).
  web_document_open: '`placements.pending` > 0: references still loading',
  // plan-754 Phase 3 (2026-09-18, F11): the hierarchy became the scene graph and
  // the bake became destructive, so the node tree now REPORTS the literal
  // three.js graph — chunk meshes and runtime objects included — and flags them
  // `chunk` / `runtime` with a computed, non-registry path. An agent reading the
  // old text would take every path it is handed as addressable and get refused
  // by the first write tool. Pure ADDITIONS to the payload (two optional flags,
  // no field moved or left), so schema, annotations and timeout are still
  // compared verbatim and only the prose is exempt.
  web_node_tree: 'This IS the three.js graph',
  // Same phase, the selection half. Selection identity is the `Object3D` since
  // Phase 2 (D10), so a chunk mesh, a light or an overlay can be selected and
  // has no path; `nodes[]` shipped then with its description deliberately left
  // alone for this pass. `paths` keeps its exact old meaning — what the document
  // can address — and the text now says which of the two fields is which.
  web_selection_get: 'either path or runtime:true',
  // plan-504: the Mechanism section's Anchor A/B pick dispatches the same
  // command as this tool, with the picked point as `pickJson` — so the tool
  // takes exactly ONE source now (candidateId OR pickJson) and says so.
  // 2026-10-04 (spike plc-st-welding): the virtual PLC runs several programs (one
  // per PLCProgram node). The tools address ONE program, so the text says which,
  // and status lists them all. Also shortened to stay under the payload ceiling.
  // 2026-10-02 (editor wireframe view): the shortcut table gained "Shift+Z", and
  // plan-543 gave web_help the `operator-panel` guide. Both landed without this
  // declaration and left the gate red; declared on 2026-10-05. plan-766 F3 adds
  // "T" (transform gizmo) behind it — the pinned substring is unchanged.
  web_help: 'operator-panel (build an operator panel window as JSON',
  // plan-641 Nachtrag 2026-10-21 (aa116719): descriptions name the COMMAND id instead of
  // the alias tools that tools/list hides now; the pin is the command id sentence.
  // plan-655: one parts list (catalog AND project parts) — the id hint stays.
  // plan-2005 F7/F8: the filters are honoured and named (they used to be
  // dropped silently by the dispatcher); web_signal_list answers an object
  // with total/truncated now, and web_logs defaults to info and above.
  web_logs: 'filtered BEFORE the limit',
  web_signal_list: '{signals:[{name,value,type}], total, truncated}',
  // `web_des_status` and `web_drive_speed_override` were declared here on
  // 2026-10-27 and removed again the same day, by plan-2007 Phase 4A/4B rather
  // than by a second thought: both tools now live BEHIND a door
  // (`des.status` behind `web_query`, `sim.speedOverride` behind `web_execute`),
  // so neither is announced in `allSchemas()` any more.
  // A re-description exempts the prose of an ANNOUNCED tool from the frozen
  // comparison; for a tool that has no announcement left it points at nothing, and
  // the guard says so (`is declared re-described but is not announced`). Both are
  // in `RETIRED_SINCE_BASELINE` with their door, which is the declaration that
  // fits a moved tool — and it is the stronger one, because it pins WHERE an old
  // caller has to go instead of merely excusing a text.
  // plan-774 / plan-757 Phase 2: a placed reference is BAKED in its parent, so
  // inside it only component nodes are addressable and only their field values
  // can change (instance overrides) — geometry, structure, materials and
  // mechanisms need a descend. An agent reading the old text would try to move a
  // part inside a placement and be refused (`nested-transform-refused`), so the
  // verb that goes in there had to say what it is for.
  web_editor_descend: 'only its component nodes are addressable',
  // Same phase, the status half: placements are materialised ASYNCHRONOUSLY by
  // the instancer, so the editor status gained `placementsReady` /
  // `placementsPending` — the one pair that tells an agent whether what it is
  // about to read or save is complete. A pure ADDITION to the answer payload: no
  // field moved or left, and the schema, annotations and timeout are still
  // compared verbatim, only the prose is exempt.
  web_editor_status: 'placementsReady / placementsPending',
};

/**
 * Baseline tools that gained an OPTIONAL parameter, with the parameter's name.
 *
 * A stronger change than a re-description, so it is declared separately and
 * checked harder: the test below proves the extension is ADDITIVE — every
 * parameter the baseline announced is still there with the same type and
 * description, and the required list is untouched. An agent written against the
 * frozen schema therefore still works, which is the only property that makes
 * adding a parameter to a live tool acceptable at all.
 */
const EXTENDED_SINCE_BASELINE: Record<string, string[]> = {
  // plan-740 D-U8: the agent's camera has its own LENS, independent of the
  // viewport's, so `fov` and `aspect` set what every later capture is framed
  // through. Both optional; `durationMs` stayed in place (now ignored) rather
  // than being removed, precisely so the frozen schema still validates.
  web_camera_set: ['aspect', 'fov'],
  // 2026-09-17: `onto` rests a part on a placement's real transport surface
  // (the guessed 0.62 m floated pallets above 0.50 m rollers); `flow` picks the
  // direction of the new part on a bidi turntable snap, so a feeder INTO a
  // turntable side no longer needs a second corner turntable.
  // plan-675 D4: optional `ry` — the yaw; onto a curve it defaults to the tangent there.
  // plan-655 F3: the one parts list gained optional filters; no field of the
  // answer moved (it gained `source` and, per kind, `library` / `documentId` + `path`).
  // plan-660 Phase 4 (integration 8): `limit`, and `source` may name a Library provider
  // (SimReady via CONNECT) — without it the answer is catalog + project exactly as before.
  // plan-757 F12: fan-out to every placed instance of an asset — the path is
  // the address (D9). Optional; `name` and `value` and the result fields
  // `name` / `value` / `previous` are unchanged.
  // plan-504: the panel's anchor pick travels as `pickJson` (optional) — the
  // alternative source to a listed snap candidate.
  // plan-508 F6: `cacheLast` (optional) sizes the new `cache` block — the asset
  // blob-cache outcomes. No field of the answer moved or left.
  // plan-2005 F9: `detail` (optional) — basic (default, lean) | render | full.
  web_status: ['cacheLast', 'detail'],
  // plan-2005 F7: optional `category` (comma list) and `since` (seconds back).
  web_logs: ['category', 'since'],
  // plan-2005 F8: optional `filter` (name substring) and `limit`.
  web_signal_list: ['filter', 'limit'],
  // 2026-10-04 (spike plc-st-welding): optional `program` (name or path) picks one
  // of several PLC programs; without it the tools address the program selected in
  // the editor — exactly the single program of before.
};

/**
 * Baseline parameters that went from REQUIRED to optional, declared (plan-504).
 *
 * Still additive for every old caller: a call that passes the parameter is
 * exactly as valid as before. Declared separately because it is the one change
 * to the `required` list these tests otherwise freeze.
 */
const RELAXED_SINCE_BASELINE: Record<string, string[]> = {
  // `candidateId` OR the new `pickJson` — the command's run() demands exactly one.
};

/** The frozen `required` list minus the declared relaxations. */
function requiredNow(name: string, frozen: string[] | undefined): string[] | undefined {
  const relaxed = RELAXED_SINCE_BASELINE[name];
  return relaxed && frozen ? frozen.filter((r) => !relaxed.includes(r)) : frozen;
}

/**
 * Baseline PARAMETERS whose description changed deliberately, mapped to the
 * substring the new text must contain.
 *
 * The weakest of the three declarations and the narrowest: the parameter keeps
 * its name, its type and its optionality — only its prose moved, and only
 * because it would otherwise LIE. `durationMs` is the whole reason this exists:
 * plan-740 made the camera verbs instant, so a parameter still documented as
 * "Animation duration in ms" would have agents budgeting waits for an animation
 * that no longer happens. It is kept rather than removed precisely so a caller
 * written against the frozen schema still validates — which is exactly the
 * property this file is here to defend.
 */
const REPARAMETERISED_SINCE_BASELINE: Record<string, Record<string, string>> = {
  // plan-2007 Phase 5: argument hints name the replacement queries.
  web_camera_set: { durationMs: 'Ignored since the agent camera moves instantly' },
  web_camera_fly: { durationMs: 'Ignored since the agent camera moves instantly' },
  // plan-740 Phase 3, the same "kept rather than removed" reasoning as
  // `durationMs`: the sweep renders offscreen and moves no camera, so there is
  // no starting pose to return to and no fixed marker angle to choose. Dropping
  // the parameters would break a caller written against the frozen schema for
  // no benefit, so they stay and say that they do nothing.
  web_view_sweep: { restore: 'Ignored since the sweep renders offscreen', paths: PATH_LIST_JSON_HINT },
  web_editor_verify_drive: { keepView: 'agent camera' },
  // 2026-09-17: `y` said "ignored on place" — it is honoured now (0 = ground),
  // so the old text would lie. Name, type and requiredness are unchanged.
  // d86eedf2 (2026-09-23): `relPath` accepts a project-relative path, a
  // document id or a document name as well. Name, type and requiredness are
  // unchanged. Declared on 2026-09-24 (see REDESCRIBED_SINCE_BASELINE).
  web_editor_open: { relPath: 'document id or name from web_document_list' },
  // plan-504: ids are generation-bound (`snap<gen>-<i>`) and the param is
  // optional next to `pickJson`, so the old example "snap0" would lie.
  // 2026-10-02 / plan-543 (see REDESCRIBED_SINCE_BASELINE): the parameter texts name
  // the new values; name, type and requiredness are unchanged.
  web_help: { topic: 'operator-panel' },
  // plan-641 Nachtrag 2026-10-21 (aa116719): the id source names the command id.
  // 2026-11-01: path lists also accept a JSON array of strings (rv-path-list), the
  // only way to pass a CAD name that contains a comma. Name, type and requiredness
  // are unchanged; a comma string still means what it meant.
  web_measure: { paths: PATH_LIST_JSON_HINT },
  web_node_shape: { paths: PATH_LIST_JSON_HINT },
  web_node_bounds: { paths: PATH_LIST_JSON_HINT },
  web_camera_focus: { paths: PATH_LIST_JSON_HINT },
  web_select: { paths: PATH_LIST_JSON_HINT },
  web_screenshot_analyze: { paths: PATH_LIST_JSON_HINT },
};

/**
 * Baseline tools whose ANNOTATIONS changed deliberately, with the new value.
 *
 * The narrowest declaration of the four and the one with teeth: `readOnlyHint`
 * is not prose, it is what CONNECT's write gate reads (`McpServerSetup.cs`
 * L385). A tool flipped to `true` becomes reachable without write access, so
 * this list is the place where somebody has to say out loud that a tool stopped
 * mutating — and the test below refuses a stale entry that pins a value which
 * never moved.
 */
const REANNOTATED_SINCE_BASELINE: Record<string, { readOnlyHint: boolean }> = {
  // plan-740 P3.1 / D-A8 / review finding I3. It flew the viewport through six
  // animated poses and froze the orbit controls to do it; now it renders six
  // offscreen frames from temporary agent poses and touches no camera at all.
  web_view_sweep: { readOnlyHint: true },
};

/** The baseline's description for one parameter, or undefined. */
function frozenParamDescription(
  baselineTools: DiscoverBaseline['tools'], tool: string, param: string,
): string | undefined {
  const props = baselineTools.find((t) => t.name === tool)?.inputSchema.properties as
    Record<string, { description?: string }> | undefined;
  return props?.[param]?.description;
}

describe('plan-713 T1 — delegate split is observationally neutral', () => {
  const schemas = allSchemas();
  const live = buildBaseline(schemas, delegateCensus());

  it('writes the baseline back when RV_UPDATE_MCP_BASELINE=1 (read-only otherwise)', async () => {
    // Without the flag this is a no-op and the assertions below do the work.
    expect(typeof await writeBaselineBack(`${JSON.stringify(live, null, 2)}\n`)).toBe('boolean');
  });

  it('announces the baseline tools plus exactly the declared additions', () => {
    const liveNames = live.tools.map((t) => t.name);
    const baseNames = baseline.tools.map((t) => t.name);
    expect(liveNames.filter((n) => !baseNames.includes(n)).sort(),
      'tools added since the baseline — declare them in ADDED_SINCE_BASELINE')
      .toEqual(ADDED_SINCE_BASELINE);
    expect(baseNames.filter((n) => !liveNames.includes(n)).sort(),
      'tools LOST since the baseline — declare them in RETIRED_SINCE_BASELINE')
      .toEqual(Object.keys(RETIRED_SINCE_BASELINE).filter((n) => baseNames.includes(n)).sort());
  });

  it('every retired tool still has its replacement announced', () => {
    const names = new Set(allSchemas().map((s) => s.name));
    for (const [gone, replacement] of Object.entries(RETIRED_SINCE_BASELINE)) {
      expect(names.has(gone), `${gone} is declared retired but is still announced`).toBe(false);
      expect(names.has(replacement),
        `${gone} was retired as a duplicate of ${replacement}, which must still exist`).toBe(true);
    }
  });

  it('every tool the baseline froze is still byte-identical', () => {
    // One deep comparison over the sorted arrays: a per-tool loop would report
    // the first mismatch only, and a split that shifts a description on ten
    // tools should show all ten. Restricted to the frozen names, so a later
    // phase's NEW tool cannot be mistaken for a changed old one — and, more to
    // the point, so adding one can never quietly relax this comparison.
    const added = new Set(ADDED_SINCE_BASELINE);
    const retired = new Set(Object.keys(RETIRED_SINCE_BASELINE));
    // The declared re-descriptions are normalised to the baseline's text FIRST,
    // so everything else about them — schema, annotations, timeout — is still
    // part of the deep comparison below rather than excused along with the prose.
    const baseDescription = new Map(baseline.tools.map((t) => [t.name, t.description]));
    const baseTool = new Map(baseline.tools.map((t) => [t.name, t]));
    const survivors = toBaselineTools(schemas)
      .filter((t) => !added.has(t.name))
      .map((t) => (t.name in REDESCRIBED_SINCE_BASELINE || t.name in EXTENDED_SINCE_BASELINE
        ? { ...t, description: baseDescription.get(t.name) ?? t.description }
        : t))
      // An extended tool's SCHEMA is compared by the additivity test below
      // instead — a deep-equal here could only ever be satisfied by pretending
      // the new parameter is not there.
      .map((t) => (t.name in EXTENDED_SINCE_BASELINE
        ? { ...t, inputSchema: baseTool.get(t.name)?.inputSchema ?? t.inputSchema }
        : t))
      // A declared parameter re-description is normalised back the same way a
      // tool re-description is: the prose is exempt, everything structural about
      // the parameter is still compared here (and pinned again below).
      .map((t) => {
        const params = REPARAMETERISED_SINCE_BASELINE[t.name];
        if (!params || t.name in EXTENDED_SINCE_BASELINE) return t;
        const props = { ...(t.inputSchema.properties as Record<string, { description?: string }>) };
        for (const param of Object.keys(params)) {
          const frozenText = frozenParamDescription(baseline.tools, t.name, param);
          if (props[param] && frozenText !== undefined) {
            props[param] = { ...props[param], description: frozenText };
          }
        }
        return { ...t, inputSchema: { ...t.inputSchema, properties: props } };
      })
      // A declared annotation change is normalised back to the frozen value the
      // same way, so the deep comparison still covers this tool's description,
      // schema and timeout. The new value itself is pinned by its own test.
      .map((t) => (t.name in REANNOTATED_SINCE_BASELINE
        ? { ...t, readOnlyHint: baseTool.get(t.name)?.readOnlyHint }
        : t));
    expect(survivors).toEqual(baseline.tools.filter((t) => !retired.has(t.name)));
  });

  it('the tool count is the baseline plus additions minus retirements', () => {
    expect(live.toolCount).toBe(
      baseline.toolCount + ADDED_SINCE_BASELINE.length - baseline.tools.filter((t) => t.name in RETIRED_SINCE_BASELINE).length,
    );
  });

  it('each declared extension is ADDITIVE — nothing an old caller relied on moved', () => {
    const byName = new Map(allSchemas().map((s) => [s.name, s]));
    for (const [name, param] of Object.entries(EXTENDED_SINCE_BASELINE)) {
      const frozen = baseline.tools.find((t) => t.name === name);
      const now = byName.get(name);
      expect(frozen, `${name} is not in the baseline`).toBeTruthy();
      expect(now, `${name} is declared extended but is not announced`).toBeTruthy();

      const before = frozen!.inputSchema.properties as Record<string, { description?: string }>;
      const after = now!.inputSchema.properties as Record<string, { description?: string }>;
      const reprosed = REPARAMETERISED_SINCE_BASELINE[name] ?? {};
      // Every old parameter survives, unchanged in type AND description — bar a
      // separately declared prose change, whose own test pins what it must say.
      for (const [key, spec] of Object.entries(before)) {
        const expected = key in reprosed
          ? { ...spec, description: (after[key] as { description?: string } | undefined)?.description }
          : spec;
        expect(after[key], `${name}.${key} was dropped or altered`).toEqual(expected);
      }
      // Exactly the declared parameters are new.
      expect(Object.keys(after).filter((k) => !(k in before)).sort()).toEqual([...param].sort());
      // And they are OPTIONAL — a new required parameter breaks every old caller.
      expect(now!.inputSchema.required, `${name}: ${param.join(', ')} must not be required`)
        .toEqual(requiredNow(name, frozen!.inputSchema.required as string[] | undefined));
    }
  });

  it('each declared parameter re-description keeps the parameter itself intact', () => {
    const byName = new Map(allSchemas().map((s) => [s.name, s]));
    for (const [name, params] of Object.entries(REPARAMETERISED_SINCE_BASELINE)) {
      const frozen = baseline.tools.find((t) => t.name === name);
      const now = byName.get(name);
      expect(frozen, `${name} is not in the baseline`).toBeTruthy();
      expect(now, `${name} is declared reparameterised but is not announced`).toBeTruthy();
      const before = frozen!.inputSchema.properties as Record<string, { type?: string; description?: string }>;
      const after = now!.inputSchema.properties as Record<string, { type?: string; description?: string }>;

      for (const [param, must] of Object.entries(params)) {
        expect(before[param], `${name}.${param} was never in the baseline`).toBeTruthy();
        expect(after[param], `${name}.${param} was removed, not re-described`).toBeTruthy();
        // The point of the whole exemption: name, type and optionality hold, so
        // a caller written against the frozen schema still validates.
        expect(after[param].type, `${name}.${param} changed type`).toBe(before[param].type);
        expect(now!.inputSchema.required).toEqual(requiredNow(name, frozen!.inputSchema.required as string[] | undefined));
        expect(after[param].description, `${name}.${param} must mention "${must}"`).toContain(must);
        // A stale entry here would sit forever exempting prose that never moved.
        expect(after[param].description, `${name}.${param} did not actually change`)
          .not.toBe(before[param].description);
      }
    }
  });

  it('each declared annotation change is real and is the value claimed', () => {
    const byName = new Map(allSchemas().map((s) => [s.name, s]));
    for (const [name, want] of Object.entries(REANNOTATED_SINCE_BASELINE)) {
      const frozen = baseline.tools.find((t) => t.name === name);
      const now = byName.get(name);
      expect(frozen, `${name} is not in the baseline`).toBeTruthy();
      expect(now, `${name} is declared reannotated but is not announced`).toBeTruthy();
      // The claim: it says exactly this now …
      expect(now!.annotations?.readOnlyHint, `${name}.readOnlyHint`).toBe(want.readOnlyHint);
      // … and it really is a change. A stale entry here would sit forever
      // exempting an annotation that never moved — and this one gates writes.
      expect(frozen!.readOnlyHint, `${name}.readOnlyHint did not actually change`)
        .not.toBe(want.readOnlyHint);
    }
  });

  it('each declared re-description actually says the thing it was allowed for', () => {
    const byName = new Map(allSchemas().map((s) => [s.name, s]));
    for (const [name, must] of Object.entries(REDESCRIBED_SINCE_BASELINE)) {
      const live = byName.get(name);
      expect(live, `${name} is declared re-described but is not announced`).toBeTruthy();
      expect(live!.description, `${name} must mention "${must}"`).toContain(must);
      // And it really is a CHANGE — a stale entry here would otherwise sit
      // forever exempting a description that never moved.
      const frozen = baseline.tools.find((t) => t.name === name);
      expect(frozen, `${name} is not in the baseline — declare it as an ADDITION`).toBeTruthy();
      expect(live!.description).not.toBe(frozen!.description);
    }
  });


  /**
   * plan-713 T4b — the discover payload, REPORTED and PINNED (F11).
   *
   * The plan asked for this as a pass/fail at "≥ 25 % smaller than the Phase-0
   * baseline". The Phase-0 measurement showed that gate is not reachable by any
   * consolidation §2.2 permits: every qualifying merge plus the whole
   * `web_scene_*` retirement came to 6.9 %, because the payload is not spread
   * thinly over many small tools — the `editor` domain alone is ~40 % of it
   * across 55 tools, and the lever there is description LENGTH, not tool count.
   * Chasing 25 % would have meant merging tools that fail criterion 2, 3 or 4,
   * which trades a real property (each tool has one result shape) for a number.
   *
   * So F11 takes the "dokumentierter Befund" branch the plan itself provides,
   * and the test becomes a RATCHET instead of a target: the payload may not grow
   * past a pinned ceiling without somebody choosing to raise it. That catches
   * the failure this gate actually exists for — fifteen tools added over a year,
   * each one "just a little description" — which the 25 % assertion never would
   * have, since it would simply have stayed red.
   */
  describe('T4b — discover payload is measured and pinned, not gated at 25 %', () => {
    /**
     * Ceiling for the announced payload, in bytes.
     *
     * Phase 0 froze 88 119 B over 140 tools. Phase 2-4 add six tools and retire
     * two; the ceiling is set a little above the measured result so ordinary
     * wording edits do not fail CI, and RAISING it is the deliberate act.
     *
     * Raised 96 000 -> 98 500 on 2026-09-11 for `web_view_ortho` (eight
     * parameters; measured 97.3 kB over 147 tools).
     *
     * Raised 98 500 -> 100 000 on 2026-09-13 for `web_document_bind` (plan-479
     * Phase 6; three parameters, measured 99.1 kB over 148 tools). The tool's
     * description was cut from 132 to under 110 words BEFORE the pin was moved
     * — the raise pays for a genuinely new tool, not for loose wording.
     */
    // 2026-09-24: raised for the three `web_group_*` tools (measured 100.6 kB
    // over 151 tools with their descriptions already cut to one sentence each).
    // 2026-09-26: raised 101 500 -> 105 500 for the six plan-729 mechanism path
    // tools (measured 104.9 kB over 154 tools, descriptions cut to one sentence
    // plus the mandatory mechanism/Kinematic demarcation BEFORE the raise).
    // 2026-09-26: raised 105 500 -> 108 000 for the four plan-501 drive-sizing tools
    // (measured 107.6 kB over 158 tools; one sentence each plus the mandatory
    // mechanism/Kinematic demarcation).
    // plan-506: raised for `web_document_info_get` / `_set` (two tools, their
    // descriptions cut to three sentences each before the pin was moved).
    // 2026-09-27: merge of plan-506 into plan-729/501 — raised 108 000 -> 109 500
    // (measured 109.2 kB over 160 tools = both sides' tools together).
    // plan-517: raised 109 500 -> 110 000 for `web_component_schema` (one optional
    // parameter, a one-sentence description; measured 109 702 B over 161 tools).
    // plan-760 Phase 2: raised 110 000 -> 112 000 for the four group verbs
    // `web_editor_group_assign/_remove/_rename/_dissolve` (one sentence each,
    // descriptions cut BEFORE the raise; measured 111 804 B over 165 tools).
    // plan-539 F15: raised 112 000 -> 112 500 for `web_sim_mode` (one optional
    // parameter, description cut before the raise; measured 112 347 B over 166 tools).
    // plan-537: raised 112 500 -> 114 500 for `web_record_video` (18 optional
    // primitive parameters — the recording options; descriptions cut to a few
    // words each BEFORE the raise; measured 114 144 B over 167 tools, which
    // includes the already-landed `web_editor_shortcut` Shift+Z wording).
    // plan-545: raised 114 500 -> 115 000 for `web_signal_automap` (two optional
    // string parameters, description cut before the raise; measured 114 832 B over 168 tools).
    // 2026-10-06: merge of plan-486 onto main — raised 115 000 -> 115 500 for
    // `web_prompt_list` / `web_prompt_claim` (one sentence each; claim keeps its
    // fenced-DATA warning; measured 115 434 B over 170 tools).
    // plan-761: raised 115 500 -> 116 000 for `web_view_render_mode` (one required
    // string parameter; description cut to two sentences and the web_status
    // addition to a clause BEFORE the raise; measured 115 960 B over 171 tools).
    // plan-566: raised 116 000 -> 116 500 for `web_signal_usage` (one required
    // string parameter, a one-sentence description; ~390 B over 172 tools).
    // plan-567: raised 116 500 -> 117 500 for `web_mu_delete` / `web_mu_move` (six
    // parameters, descriptions cut to one sentence each BEFORE the raise; measured
    // 117 421 B without the collision tools, +1 073 B over 174 tools).
    // plan-591: raised 117 500 -> 118 250 for `web_view_visual_preset` (one required
    // and one optional string parameter; description cut to two sentences and the
    // `web_status` addition to a single clause BEFORE the raise). MEASURED, not
    // estimated: 123 040 B without plan-591 and 123 759 B with it over 185 tools,
    // i.e. a delta of exactly 719 B — the raise is that delta plus 31 B of slack.
    //
    // NOTE: this assertion is ALREADY red on main, by far more than any one plan.
    // The measurement above shows 123 040 B before plan-591 against a pin of
    // 117 500 — the pin was last set to 117 421 B "without the collision tools"
    // (plan-567, see above), and the tools added since without moving it are what
    // make up the ~5.5 kB gap. plan-591 therefore raises it by exactly its OWN
    // measured delta rather than absorbing that gap: the test stays red by the
    // same pre-existing excess and by nothing this plan added.
    //
    // 6.4.0 release: raised 118 250 -> 124 000 to close that pre-existing gap on
    // purpose. MEASURED 123 759 B over 185 tools (collision tools and every tool
    // added since plan-567 included); the raise is that figure plus 241 B of slack.
    // From here on each plan raises it by its own measured delta again.
    // plan-764: raised 124 000 -> 124 250 for `web_export_usd` (two optional string
    // parameters, a three-sentence description). MEASURED 124 236 B over 186 tools,
    // i.e. +477 B against the 123 759 B above; the raise is the overshoot plus 14 B.
    // plan-764 Phase 2: raised 124 250 -> 125 650 for `web_import_usd_extras` (one
    // required string) and `web_import_usd_extras_commit` (one required string, two
    // optional booleans). ESTIMATED, not yet measured (no test run allowed in the
    // executor window): +1 384 B for the two baseline entries over 188 tools, i.e.
    // ~125 620 B; the orchestrator replaces this with the measured figure.
    // (plan-629 measured it: 125 620 B over 188 tools, exactly the estimate.)
    // plan-629: raised 125 650 -> 126 800 for `web_trace_top` (three optional
    // parameters) and `web_trace_set` (four optional parameters). MEASURED
    // 126 761 B over 190 tools against 125 620 B with the delegate switched off,
    // i.e. +1 141 B; the raise is that delta plus 9 B of rounding.
    // plan-621: raised 126 800 -> 127 950 for `web_editor_solidcraft_connect` (two optional
    // parameters) and the parameterless `_resync` / `_disconnect`, descriptions cut to one or two
    // sentences BEFORE the raise. MEASURED 127 915 B over 193 tools against 126 761 B above,
    // i.e. +1 154 B; the raise is that delta plus 35 B of rounding.
    // plan-641 Phases 0-2: raised 127 950 -> 132 800 for the twelve new tools
    // `web_commands` / `web_execute` / `web_batch` and the nine `web_macro_*` (24
    // parameters together), descriptions cut to one or two sentences and parameter
    // texts to a few words BEFORE the raise (first measurement 135 261 B). MEASURED
    // 132 786 B over 205 tools against 127 915 B above, i.e. +4 871 B; the raise is
    // that delta plus 14 B of rounding.
    // plan-641 Phases 4-5: raised 132 800 -> 134 830 for `web_check_gap` / `web_check_contact`
    // (two required + two optional parameters each), `web_part_lookup` (one) and
    // `web_macro_assert` (four required + the three optional meta parameters), descriptions cut
    // to one sentence BEFORE the raise (first measurement 135 314 B). MEASURED 134 816 B over
    // 209 tools against 132 786 B above, i.e. +2 030 B; the raise is that delta plus 14 B.
    // +147 B aus origin/main (plan-642/644) nach Merge in plan-641: raised 134 830 -> 134 991.
    // The growth is plan-642's longer `web_editor_solidcraft_connect` description and `design`
    // parameter text (plan-644 touches no MCP tool); origin/main kept its own pin at 127 950,
    // so no main-side pin was overwritten. MEASURED 134 977 B over 209 tools (+161 B against
    // 134 816 B above, +147 B over the old pin); the raise is the measured figure plus 14 B.
    // plan-641 Phase 2b: raised 134 991 -> 135 500 for `web_macro_import` (three optional
    // parameters) and the optional `files` parameter of `web_macro_list`, descriptions cut to one
    // sentence BEFORE the raise (first measurement 135 583 B). MEASURED 135 486 B over 210 tools
    // against 134 977 B over 209 (same HEAD, the tools file at HEAD), i.e. +509 B; the raise is
    // that figure plus 14 B.
    // plan-650 Phase 4: raised 135 500 -> 137 362 for `web_editor_parametric_define` (five
    // parameters), `_set` (two) and `_inspect` (three), descriptions cut to one sentence BEFORE the
    // raise (first measurement 138 641 B). MEASURED 137 348 B over 213 tools against 135 486 B over
    // 210, i.e. +1 862 B; the raise is that figure plus 14 B.
    // plan-655: raised 137 362 -> 138 567 for `web_library_list` / `_attach` / `_detach` and the
    // two optional filters of `web_catalog_list`, descriptions cut to one sentence BEFORE the raise
    // (first measurement 139 507 B). MEASURED 138 553 B over 216 tools against 137 348 B over 213,
    // i.e. +1 205 B; the raise is that figure plus 14 B.
    // Integration 8 (2026-10-23): origin/main b8ee991c already measured 139 113 B (red against
    // 138 567 — growth after plan-655 that nobody pinned); plan-660 Phase 4 adds `limit` on
    // `web_catalog_list` and the provider-id wording of its `source` / description (+133 B).
    // MEASURED 139 246 B over 216 tools; the raise is that figure plus 14 B.
    // plan-773 Phases 1-2: raised 139 260 -> 143 905 for the six `web_robot_*` tools
    // (McpRobotTools — four reads taking one or three optional parameters, `_rig_diagnose`,
    // and `_rig_from_library` with three). Descriptions cut BEFORE the raise, twice: the
    // first measurement was 144 555 B with `_rig_from_library` over the 110-word budget, so
    // all six were shortened. MEASURED 143 891 B over 222 tools against 139 246 B over 216,
    // i.e. +4 645 B — ~774 B per tool, close to the catalogue average and not a new outlier.
    // The raise is that figure plus 14 B.
    // plan-773 Phase 3: raised 143 905 -> 150 348 for the seven path tools
    // (`web_robot_path_create` / `_path_inspect` / `_target_add` / `_target_set` / `_target_remove` /
    // `_target_reorder` / `_solve_target`). Parameter descriptions cut BEFORE the raise (first
    // measurement 150 445 B). MEASURED 150 334 B over 229 tools against 143 891 B over 222,
    // i.e. +6 443 B — ~920 B per tool, above the ~774 B of plan-773 Phases 1-2 because `_target_add`
    // and `_target_set` carry five and four optional parameters each (a pose in two halves, a field
    // bag and the unreachable opt-out), and because each description has to state the F10 promise
    // that a pose and its joint angles are written together or not at all. The raise is that
    // figure plus 14 B.
    // plan-773 Phase 5: raised 150 348 -> 151 557 for `web_robot_program_export` — ONE tool with five
    // parameters (vendor plus four optional). Description cut BEFORE the raise (first measurement
    // 151 627 B). MEASURED 151 543 B over 230 tools against 150 334 B over 229, i.e. +1 209 B for one
    // tool — above the ~920 B of Phase 3 and the reason is in the description rather than in the
    // parameters: the refusals are the feature. A tool that silently emitted a degraded program would
    // be shorter and would be the defect plan-773 R1 exists for, so the words that name the four
    // refusal conditions earn their bytes. The raise is that figure plus 14 B.
    // plan-664 Phase 2: raised 151 557 -> 152 083 for `web_sensor_read` — ONE read tool with ONE
    // optional parameter. Description cut BEFORE the raise (first measurement 152 107 B).
    // MEASURED 152 069 B over 231 tools against 151 543 B over 230, i.e. +526 B for one tool —
    // well BELOW the ~774 B catalogue average, which is what a one-parameter reader should cost.
    // The bytes that stayed are the three facts an agent cannot guess: the unit is mm, no hit is
    // -1 (not 0 and not the max range), and the reported time is the MEASUREMENT time rather than
    // the delivery time — the last one is the contract the AGV coupling of Phase 3 reads. The
    // raise is that figure plus 14 B.
    // plan-675 Phase 1: raised 139 260 -> 139 825 for `web_editor_generate_uvs` (three optional
    // parameters), description cut to one sentence BEFORE the raise (first measurement 140 378 B).
    // MEASURED 139 811 B over 217 tools against 139 246 B over 216, i.e. +565 B; the raise is that
    // figure plus 14 B.
    // plan-675 Phase 4 (D4): raised 139 825 -> 139 912 for the optional `ry` of `web_layout_place`
    // (one-line description). MEASURED 139 898 B over 217 tools, i.e. +87 B; the raise is that
    // figure plus 14 B.
    // Merge of plan-675 onto plan-773/plan-664 (2026-10-24): both raises above were taken against
    // 139 246 B; re-measured on the merged tree. MEASURED 152 811 B over 232 tools against
    // 152 069 B over 231, i.e. +742 B for `web_editor_generate_uvs` plus the `ry` of
    // `web_layout_place`. The ceiling is that figure plus 14 B.
    // plan-2007 Phase 0: + `web_query` and the `background` param of web_execute → 153 474 B.
    const PAYLOAD_CEILING_BYTES = 153_500;

    it('reports the payload against the Phase-0 baseline', () => {
      const bytes = JSON.stringify(toBaselineTools(schemas)).length;
      const delta = bytes - baseline.payloadBytes;
      const pct = ((delta / baseline.payloadBytes) * 100).toFixed(1);
      // The measurement IS the deliverable of F11 — printed so a reviewer reading
      // CI output sees the number without re-deriving it.
      // eslint-disable-next-line no-console
      console.info(
        `[T4b] discover payload ${bytes} B over ${schemas.length} tools `
        + `(Phase-0 baseline ${baseline.payloadBytes} B over ${baseline.toolCount}; ${pct} %)`,
      );
      expect(bytes).toBeGreaterThan(0);
    });

    it('stays under the pinned ceiling', () => {
      const bytes = JSON.stringify(toBaselineTools(schemas)).length;
      expect(
        bytes,
        `Discover payload ${bytes} B exceeds the pinned ceiling ${PAYLOAD_CEILING_BYTES} B. `
        + 'Shorten descriptions, or raise the pin deliberately in this file.',
      ).toBeLessThanOrEqual(PAYLOAD_CEILING_BYTES);
    });

    it('retiring editor aliases reduces the editor share of the payload', () => {
      // Recorded as an assertion so the Phase-0 conclusion stays checkable rather
      // than becoming a paragraph nobody re-measures. If this ever stops being
      // true, the consolidation question is worth reopening.
      const total = JSON.stringify(toBaselineTools(schemas)).length;
      const editor = JSON.stringify(
        toBaselineTools(schemas).filter((t) => t.name.startsWith('web_editor_')),
      ).length;
      const baselineEditor = JSON.stringify(baseline.tools.filter((t) => t.name.startsWith('web_editor_'))).length;
      expect(editor / total).toBeLessThan(baselineEditor / JSON.stringify(baseline.tools).length);
    });
  });

  describe('dispatch smoke — every announced instance is actually wired', () => {
    it('the dispatcher resolves every announced tool to a callable method', () => {
      const dispatcher = buildMultiDispatcher(allInstances());
      const unwired: string[] = [];
      for (const s of schemas) {
        const entry = dispatcher.get(s.name);
        if (!entry) { unwired.push(`${s.name}: not in dispatcher`); continue; }
        const method = (entry.instance as Record<string, unknown>)[entry.methodKey];
        if (typeof method !== 'function') unwired.push(`${s.name}: ${entry.methodKey} not callable`);
      }
      expect(unwired, unwired.join('\n')).toEqual([]);
    });

    it('the announced schemas and the dispatcher come from ONE instance list', () => {
      // generateToolSchemasMulti and buildMultiDispatcher both throw on a
      // duplicate name, so building both over the same list is the guard R9
      // asks for — and doing it here means a collision fails CI instead of
      // `ws.onopen`, where it would take the whole catalogue down on every
      // reconnect.
      const instances = allInstances();
      expect(() => generateToolSchemasMulti(instances)).not.toThrow();
      expect(() => buildMultiDispatcher(instances)).not.toThrow();
      expect(buildMultiDispatcher(instances).size).toBe(schemas.length);
    });

    it('the plugin instance list matches the one the tests lint', () => {
      // The single most likely way a split goes wrong: a new delegate reaches
      // `_sendDiscover` but not the shared test list (or the reverse), leaving
      // its tools announced-but-unlinted — the exact gap plan-716 had to close
      // for McpProjectTools.
      const plugin = new McpBridgePlugin();
      const fromPlugin = generateToolSchemasMulti(plugin.mcpToolInstances)
        .map((s) => s.name).sort();
      expect(fromPlugin).toEqual(schemas.map((s) => s.name).sort());
    });
  });
});
