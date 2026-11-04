// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MCP tool convention lint — enforces the agent-discoverability rules:
 *
 *  1. Names follow `web_<domain>_<action>` with an approved domain vocabulary
 *     (alphabetical clustering is how agents find tools).
 *  2. Descriptions are verb-first and fit the token budget (<= 110 words).
 *  3. No duplicate names across the delegate classes (also thrown at runtime).
 *  4. Every tool carries an explicit `readOnly` classification (plan-327 AP3).
 *
 * A failing test means a new tool degrades agent discovery — fix the name or
 * description, or (deliberately) extend the domain whitelist below AND the
 * domain table in webviewer.mcp.md.
 */

import { describe, it, expect } from 'vitest';
import { createLibraryCommandDescriptors } from '../src/core/library/library-commands';
import { createQueryCommandDescriptors } from '../src/core/hmi/query-commands';
import { createPlannerCommandDescriptors } from '../src/plugins/layout-planner/planner-commands';
import { createDocumentCommandDescriptors } from '../src/core/hmi/document-commands';
// The instance list moved to tests/helpers/mcp-schemas.ts with plan-707: three
// tests need it now, and three private copies is how one of them goes stale.
import { allSchemas } from './helpers/mcp-schemas';

/** Approved domain vocabulary (second name segment). Extend deliberately. */
const DOMAINS = new Set([
  'node', 'component', 'view', 'camera', 'select', 'selection', 'screenshot',
  'drive', 'signal', 'sensor', 'sim', 'transport', 'logic', 'mode',
  'layout', 'scene', 'editor', 'des', 'plc',
  // plan-537: `web_record_video` — producing a video file is not a view or a
  // screenshot (it steps the simulation and writes an MP4), so it gets its own verb.
  'record',
  // plan-394. Deliberately NOT folded into `node`: that domain means structural
  // navigation throughout (find/tree/bounds), and a durable note is not that.
  'knowledge',
  // 2026-08-19 rework — asset = document = model, ONE concept. `document` is
  // the domain for the project's GLB documents (list/open/save/new/update);
  // `catalog` is the planner's placeable parts catalogue (the former
  // `web_library_*` pair). The old `model` and `library` domains are gone; a
  // PROJECT still decides what project-relative paths resolve against, a
  // DOCUMENT is what is loaded in the viewport.
  'document', 'catalog', 'project',
  // plan-437 — `web_link_compose` composes deep-link URLs INTO the viewer. Not
  // folded into `scene`/`model`: those domains OPEN something, and handing out
  // an address for it is the opposite direction. A domain rather than a root
  // tool because the name parses as domain+action anyway and leaves room for
  // later `web_link_*` tools.
  'link',
  // plan-486 — the prompt queue a user fills by right-clicking a node in the
  // viewer and typing an order. Deliberately NOT folded into `knowledge`: a
  // note describes a machine durably, a prompt task is a one-way ORDER to a
  // coding agent with a lifecycle (open → claimed) and is consumed once.
  'prompt',
  // 41179349 — `web_group_list/_set_visible/_set_listed`: the Display panel's Groups
  // list as the panel sees it. Not folded into `scene` or `node`: a group is a
  // registry row with its own visibility and listing state, not a scene-graph node.
  'group',
  // plan-567 — `web_mu_delete` / `web_mu_move`: a workpiece carrier taken off
  // the line or set elsewhere by hand (Commissioning). Not folded into
  // `transport`: that domain READS the material flow, these two act on one
  // carrier by its engine id.
  'mu',
  // plan-655 — `web_library_list/_attach/_detach`: the external part CATALOGS a
  // project subscribes to (`project.json.libraries[]`). Back as a domain with a
  // NARROWER meaning than the one retired in the 2026-08-19 rework: there,
  // `web_library_*` was the placeable parts list itself (now `web_catalog_list`);
  // here a library is the catalog SOURCE you attach, its parts stay in `catalog`.
  'library',
  // 8a34c524 (2026-10-08) — `web_collision_watch/_status/_reset`: session-only
  // collision roles and the latched contact pairs. Not folded into `node` or
  // `scene`: the tools manage a watch with its own lifecycle (watch → status →
  // reset), not a property of one node. Absorbed at the 6.4.0 release.
  'collision',
  // plan-764 — `web_export_usd`: a file in another FORMAT than the document's
  // own GLB. Not folded into `document`: that domain lists, opens and saves the
  // project's GLB documents; an export leaves the document as it is and writes
  // a foreign-format file beside it.
  'export',
  // plan-764 Phase 2 — `web_import_usd_extras` / `_commit`: data from a file in
  // another FORMAT taken INTO the open document (preview, then commit). The
  // mirror of `export`; not `document`, which lists/opens/saves GLB documents.
  'import',
  // plan-629 — `web_trace_top` / `web_trace_set`: the congestion trace (blocked /
  // utilization share per path bucket over sim time). Not folded into `sim`: that
  // domain CONTROLS the run (play / reset / speed / mode); the trace is a
  // measurement overlay that only reads the vehicles.
  'trace',
  // plan-641 — `web_macro_*`: recording, listing, saving and replaying macros
  // (lists of command calls with reasons). Not folded into `editor`: a macro is
  // ABOUT the document and runs in every projection, and its replay is a job
  // with its own lifecycle (replay → status → cancel).
  'macro',
  // plan-641 Phase 4 — `web_check_gap` / `web_check_contact`: mesh-exact geometry
  // checks in a pose. Not folded into `node` (that domain navigates and reads one
  // node) nor `measure` (a root tool, AABB only): a check compares TWO nodes and is
  // what an assertion line of a macro replays.
  'check',
  // plan-641 Phase 5 — `web_part_lookup`: the shipped part library (type code →
  // stroke, moving / fixed sub-parts). Not `knowledge`: that domain is the durable
  // notes OF the open model; the part library is shipped reference data.
  'part',
  // plan-773 Phases 1-3 — `web_robot_list` / `_get_chain` / `_get_state` /
  // `_verify_fk` / `_rig_diagnose` / `_rig_from_library`, plus the path half
  // (`_path_create`, `_path_inspect`, `_target_add` / `_set` / `_remove` /
  // `_reorder`, `_solve_target`): the IK rig of a six-axis
  // robot. Not folded into `component` (that domain reads and writes ONE field of
  // ONE component, and a rig is six ordered references plus seven measured
  // constants that are each wrong alone) and not into `drive` (that one runs an
  // axis; this one describes the kinematics above it). It is the same split
  // decision `mechanism` made for the rigid-body joint graph.
  'robot',
]);

/**
 * Root-level tools allowed without a domain segment. `web_measure` and `web_eye` come from
 * McpObserveTools, which was missing from this lint entirely until plan-327 AP3 added the
 * delegate below — four tools were unchecked, and one dead name (`web_find`) survived here for
 * exactly that reason.
 */
const ROOT_TOOLS = new Set([
  'web_status', 'web_logs', 'web_errors', 'web_help', 'web_measure',
  // plan-740: `web_eye` is the agent camera's capture verb. Root-level because
  // the picture is not about one domain, it IS the way every domain is looked
  // at.
  'web_eye',
  // plan-707: state-aware orientation. Root-level like web_status and web_help,
  // because "where am I" is not a question about one domain.
  'web_describe',
  // plan-716 Phase 5: the throttle probe. Root-level for the same reason —
  // "is the tab alive" is not a question about drives, scenes or projects, and
  // it is deliberately the one tool with no imports and no timers.
  'web_ping',
  // plan-641 — the reduced command interface (the SolidCraft way): list the
  // registry, execute one command, execute several. Root-level because they are
  // not about one domain — every model change of every domain runs through them.
  'web_commands', 'web_execute', 'web_batch',
  // plan-2007 F3: the read door — runs read-only registry commands only.
  'web_query',
]);

const MAX_DESCRIPTION_WORDS = 110;

describe('MCP tool conventions', () => {
  const schemas = allSchemas();

  it('has a meaningful number of tools', () => {
    expect(schemas.length).toBeGreaterThan(50);
  });

  it('every name is web_<domain>_<action> with an approved domain', () => {
    const bad: string[] = [];
    for (const s of schemas) {
      if (ROOT_TOOLS.has(s.name)) continue;
      // web_<domain> alone is the domain's primary action (web_screenshot, web_select).
      const m = /^web_([a-z0-9]+)(?:_[a-z0-9_]+)?$/.exec(s.name);
      if (!m || !DOMAINS.has(m[1])) bad.push(s.name);
    }
    expect(bad, `Names outside the domain vocabulary: ${bad.join(', ')}`).toEqual([]);
  });

  /**
   * plan-740 T7 — the camera verbs stopped refusing, so they must stop SAYING
   * they refuse.
   *
   * `web_camera_orbit`, `_view` and `_fly` each carried "Refused while FPV,
   * camera-follow or XR own the camera". Since the agent has its own camera
   * body those three own the USER viewport only, and the tools move regardless
   * (D-A7); the refusal lives on the double-click attach now. A stale sentence
   * here is worse than no sentence: an agent reads it and does not even try.
   *
   * `web_view_sweep` is deliberately NOT exempt — it keeps the guard until
   * Phase 3 moves it offscreen, so if it still carried the phrase this test
   * would (correctly) fail and force the wording to be honest about scope.
   */
  it('no description still claims the old FPV / follow / XR refusal', () => {
    const offenders = schemas
      .filter((s) => /Refused while FPV/i.test(s.description ?? ''))
      .map((s) => s.name);
    expect(offenders, `stale refusal wording on: ${offenders.join(', ')}`).toEqual([]);
  });

  /**
   * plan-740 — the camera verbs answer about the AGENT camera now. An agent
   * that reads "the visible viewport camera moves" will keep sequencing
   * screenshots around a camera it no longer drives.
   */
  it('the camera verbs name the agent camera in their description', () => {
    for (const name of [
      'web_camera_get', 'web_camera_set', 'web_camera_focus',
      'web_camera_orbit', 'web_camera_view', 'web_camera_fly', 'web_camera_projection',
    ]) {
      const t = schemas.find((s) => s.name === name);
      expect(t, `${name} must exist`).toBeTruthy();
      expect(t!.description, `${name} must say whose camera it moves`).toMatch(/AGENT/);
    }
  });

  it('web_find stays deleted (renamed to web_node_find)', () => {
    expect(schemas.some((s) => s.name === 'web_find')).toBe(false);
    expect(schemas.some((s) => s.name === 'web_node_find')).toBe(true);
  });

  it('covers every announced delegate, including McpObserveTools', () => {
    const names = new Set(schemas.map((s) => s.name));
    // These four were announced to agents but linted by nothing before plan-327 AP3.
    for (const observed of ['web_measure', 'web_node_shape', 'web_scene_query']) {
      expect(names.has(observed), `${observed} must be covered by this lint`).toBe(true);
    }
    // 105 → 111 with the six `web_editor_mechanism_*` tools (plan-404 Phase 5).
    // 111 → 115 with the four `web_signal_*` binding tools (plan-425 Phase 3).
    // 115 → 118 with the three `web_knowledge_*` tools (plan-394 Phase 2).
    // 118 → 119 with `web_describe` (plan-707 Phase 1).
    // 119 → 124 with the five `McpProjectTools` (plan-716 Phase 5): they were
    // ANNOUNCED all along and merely missing from the shared list, so this is a
    // coverage gain, not five new tools.
    // 124 → 136 with plan-706: ten more `web_editor_mechanism_*` (inspect,
    // snap_list, set_anchor_snap, set_axis, add_body, set_mass, set_limits,
    // forces, statics, fix) plus `web_editor_test_start` / `_stop`. Counted from
    // the code after the plan-707 merge, not taken from the plan — 705, 706 and
    // 707 all edit this line, and the second one to land must re-count.
    // 137 → 138 with `web_link_compose` (plan-437 Phase 2).
    // 138 → 140 with `web_camera_fly` and `web_view_sweep` (plan-705). Counted
    // from the code, not taken from the plan — the plan was written when this
    // line still read 111, and 705/706/707 all edit it.
    // 140 → 143 with plan-713 Phase 2: `web_library_assets`, `web_library_update`
    // (McpSceneTools) and `web_editor_project_files` (McpEditorTools). Three NEW
    // tools, unlike the Phase-1 move, which left this line alone on purpose.
    // 143 → 145 → 143 with plan-713 Phase 3: `web_editor_descend` / `_back` added
    // (F10), `web_scene_open` / `web_scene_list` retired (F8). Net zero, and the
    // coincidence is worth stating so nobody reads the unchanged number as "no
    // Phase-3 change reached the roster".
    // 143 -> 144 with plan-713 Phase 4: `web_camera_view` (F9).
    // 144 -> 143 with the 2026-08-19 terminology rework: `web_library_assets`
    // merged INTO `web_document_list` (one list — asset = document = model);
    // everything else was a hard rename (model/scene → document, library
    // catalogue → catalog, web_scene_export → web_layout_export).
    // 143 -> 145 with the project-tree rework (same day): `web_project_tree`
    // (navigate folders/documents as the dashboard shows them) and
    // `web_project_folder` (create/rename/move folders through the dashboard's
    // own tree verdicts and `applyTreeMove`).
    // 145 -> 147 with plan-722: `web_editor_list_circles` /
    // `web_editor_pivot_to_circle` (McpEditorTools). NOT mechanism tools despite
    // sharing `mechanism-snap.ts` — they belong to the axis-group Kinematic
    // workflow, which is why they carry no `mechanism` segment and do not move
    // the roster count in mechanism-mcp-inspect.test.ts.
    // 147 -> 145 with plan-724: both of those are gone again. The circle
    // ENUMERATION they were built on is deleted — Pivot to Circle is a hover
    // now, and a hover has no agent-callable half. `web_editor_mechanism_snap_list`
    // still returns `circle-center` candidates from the same fit maths, but
    // cursor-bound: there is no longer a way to list every bore of a path.
    // 145 -> 146 with plan-740 Phase 2: `web_eye`, the agent camera's capture
    // verb. `web_render` was kept alongside it as a single-channel alias.
    // 146 -> 147 with `web_view_ortho` (2026-09-11): the six orthographic views
    // of a part as one mosaic per eye channel, next to `web_view_sweep`.
    // 147 -> 148 with plan-479 Phase 6: `web_document_bind` (McpProjectTools).
    // A document's connectRef/scriptRef/knowledgeRef set and cleared through MCP —
    // its own tool rather than a fourth action of `web_document_update`, which is
    // destructive and operates on FILES; a binding deletes nothing.
    // 148 -> 145: `web_render`, `web_view_pick` and `web_view_gaze` removed.
    // The alias earned nothing `web_eye` does not already do, and the two ray
    // picks were the sharp tools an agent reached for instead of
    // `web_view_sweep`, which answers "what is this" with occlusion-correct
    // coverage per view rather than a single ray.
    // 145 -> 144: `web_screenshot_annotated` removed too. `web_eye` with
    // channels=idmask and explicit group `paths` renders the same Set-of-Mark
    // frame and legend, so the labelled shot was a second way to ask one
    // question. The one thing it did that the caller must now do itself: it
    // diffed the requested paths against the visible ones and said
    // `notVisible: true` per path, where idmask reports only what IS visible.
    // 144 -> 145 with `web_layout_timings` (plan-753): the placement
    // performance rings (decode, chunk-bake, scene-registration, long tasks)
    // read through one root-level `layout` tool.
    // 145 -> 148 with the three `web_group_*` tools (41179349): list, set_visible,
    // set_listed — the Groups panel's eye and exclusion filter as tools.
    // 148 -> 150 with plan-506: `web_document_info_get` / `_set`, the
    // document description (summary + Markdown) stored in the GLB.
    // 150 -> 156 with plan-729: six tools for Cartesian mechanism paths —
    // `web_editor_mechanism_add_target`, `web_editor_mechanism_path_create`,
    // `web_editor_mechanism_path_add_waypoint`, `web_editor_mechanism_path_remove_waypoint`,
    // `web_editor_mechanism_path_move_waypoint` (writes) and
    // `web_editor_mechanism_path_inspect` (read).
    // 156 -> 160 with plan-501: drive sizing from a sampled trajectory —
    // `web_editor_mechanism_trajectory_import`, `web_editor_mechanism_trajectory_run` (writes),
    // `web_editor_mechanism_trajectory_inspect` and `web_editor_mechanism_trajectory_export` (reads).
    // 160 -> 161 with plan-517: `web_component_schema` (read) — component
    // fields from rv-odt.json plus the authoring rules of specification.md.
    // 161 -> 165 with plan-760 Phase 2: the Quick Edit Groups section's verbs
    // `web_editor_group_assign`, `_remove`, `_rename`, `_dissolve` (writes,
    // views of `editor.group*`).
    // 165 -> 166 with plan-539 F15: `web_sim_mode` (Simulation / PLC mode, get / set).
    // 166 -> 167 with plan-537: `web_record_video` (deterministic MP4 recording).
    // 167 -> 168 with plan-545: `web_signal_automap` (PLC auto-map check / apply).
    // 168 -> 170 with plan-486: `web_prompt_list` / `web_prompt_claim`
    // (McpPromptTools), the browser-side prompt queue a user fills from the
    // context menu; the only delegate with no viewer accessor.
    // 170 -> 171 with plan-761: `web_view_render_mode` (write, view of
    // `view.renderMode` — the render-mode pill's shading segments).
    // 171 -> 172 with plan-566: `web_signal_usage` (read) — the signal
    // cross-reference list of the inspector's "Used by" section.
    // 172 -> 174 with plan-567: `web_mu_delete` / `web_mu_move` (writes, views
    // of `mu.delete` / `mu.move` — Delete key, context menu and the drag).
    // 174 -> 176 with plan-589 Phase 2: `web_editor_signal_set_field` /
    // `web_editor_signal_set_binding` (writes, views of `editor.signalSetField` /
    // `editor.signalSetBinding` — the inspector's "Signal" and "PLC binding" sections).
    // 176 -> 178 with plan-589 Phase 3: `web_signal_reconcile` (read — the
    // reconcile report) and `web_editor_signals_create_from_interface` (write,
    // view of `editor.signalsCreateFromInterface` — the report's one repair).
    // 178 -> 181 with plan-590: `web_editor_signal_rename` (write, view of
    // `editor.signalRename` — the inspector's rename dialog) and its two Problems
    // actions `web_editor_signal_rename_repair` / `_recheck` (writes, views of
    // `editor.signalRenameRepair` / `editor.signalRenameRecheck`).
    // 181 -> 182 with plan-591: `web_view_visual_preset` (write, view of
    // `view.visualPreset` — the two quality rows of the render-mode menu).
    // NOTE (2026-10-11, still true): the LIVE count is three HIGHER than this pin.
    // The extra three are `web_collision_watch` / `_status` / `_reset`, introduced
    // by commit 8a34c524 (2026-10-08) WITHOUT updating this pin; they are neither
    // plan-589's nor plan-590's nor plan-591's and are deliberately not absorbed
    // here. plan-591 therefore raised the pin by exactly its OWN one tool, so this
    // assertion stays red by exactly those same three and by nothing else. Until
    // that commit's own follow-up fixes them, 185 is live against a pin of 182.
    // 182 -> 185 at the 6.4.0 release: the three collision tools are absorbed
    // deliberately (domain `collision` above) so the release ships a green suite.
    // 185 -> 186 with plan-764: `web_export_usd` (write — a file into the project).
    // 186 -> 188 with plan-764 Phase 2: `web_import_usd_extras` (read — preview)
    // and `web_import_usd_extras_commit` (write — replaces the open document file).
    // 188 -> 190 with plan-629: `web_trace_top` (read) and `web_trace_set` (write).
    // 190 -> 193 with plan-621: `web_editor_solidcraft_connect` / `_resync` / `_disconnect` (writes).
    // 193 -> 205 with plan-641 Phases 0-2: `web_commands` (read), `web_execute`,
    // `web_batch` (writes) and the nine `web_macro_*` tools (record_start, record_stop,
    // annotate, save, replay, cancel = writes; list, get, status = reads).
    // 205 -> 209 with plan-641 Phases 4-5: `web_check_gap`, `web_check_contact`,
    // `web_part_lookup` (reads) and `web_macro_assert` (write — a macro line).
    // 209 -> 210 with plan-641 Phase 2b: `web_macro_import` (write — a macro into the book).
    // 210 -> 213 with plan-650 Phase 4: `web_editor_parametric_define` / `_set` (writes) and
    // `web_editor_parametric_inspect` (read).
    // 213 -> 216 with plan-655: `web_library_list` (read), `web_library_attach` /
    // `_detach` (writes, views of `library.attach` / `library.detach`).
    // 216 -> 222 with plan-773 Phases 1-2: `web_robot_list`, `_get_chain`, `_get_state`,
    // `_verify_fk`, `_rig_diagnose` (reads — the web pendants of Unity's `ik_*` tools plus
    // the read-only rig derivation) and `web_robot_rig_from_library` (write — the one call
    // that builds a RobotIK instead of seven fields set by hand).
    // 222 -> 229 with plan-773 Phase 3: `web_robot_path_inspect` (read) and the six writes
    // that author a robot program — `web_robot_path_create`, `_target_add`, `_target_set`,
    // `_target_remove`, `_target_reorder`, `_solve_target`. The three robotics components
    // stay un-authorable; this family is the way in (decision E6).
    // 229 -> 230 with plan-773 Phase 5: `web_robot_program_export` (read — it re-solves every
    // waypoint but writes nothing) turns a path into a vendor robot program. It is BOUND to
    // `ik.program.export`, so it does not appear in `tools/list`; this count is the announced
    // catalogue before the alias filter, which is why it still rises by one.
    // 230 -> 231 with plan-664 Phase 2: `web_sensor_read` (read — the current scan
    // frame of a Rangefinder / LaserScanner out of the sensor data channel, plus
    // the sensor's configuration). Unbound: there is no button it is a view of,
    // and nothing to undo.
    // 231 -> 233: plan-2007 Phase 0 adds `web_query` (the read door, read-only); the
    // second one arrived on main before plan-2007 (measured 2026-10-27).
    // plan-2007 Phase 1 moves 14 write tools to registry commands.
    // plan-2007 Phase 2A moves four more write tools to registry commands.
    // Phase 2B retires five further writing tools.
    // plan-2007 Phase 3: eight mechanism writes moved to commands.
    // Phase 4A: 18 read-only queries moved behind web_query:
    // web_editor_mechanism_inspect -> mechanism.inspect
    // web_editor_mechanism_forces -> mechanism.forces
    // web_editor_mechanism_path_inspect -> mechanism.pathInspect
    // web_editor_mechanism_snap_list -> mechanism.snapList
    // web_editor_mechanism_trajectory_export -> mechanism.trajectoryExport
    // web_editor_mechanism_trajectory_inspect -> mechanism.trajectoryInspect
    // web_editor_mechanism_validate -> mechanism.validate
    // web_robot_list -> ik.robot.list
    // web_robot_get_chain -> ik.robot.chain
    // web_robot_get_state -> ik.robot.state
    // web_robot_verify_fk -> ik.robot.verifyFk
    // web_robot_rig_diagnose -> ik.robot.rigDiagnose
    // web_robot_path_inspect -> ik.path.inspect
    // web_editor_list_kinematics -> editor.listKinematics
    // web_editor_material_presets -> editor.materialPresets
    // web_editor_material_stats -> editor.materialStats
    // web_editor_project_files -> editor.projectFiles
    // web_editor_project_info -> editor.projectInfo
    // Phase 4B moves 16 read-only tools behind web_query:
    // web_layout_list -> layout.list
    // web_layout_export -> layout.export
    // web_layout_snap_list -> layout.snapList
    // web_layout_snap_suggest -> layout.snapSuggest
    // web_library_list -> library.list
    // web_catalog_list -> library.catalogList
    // web_catalog_describe -> library.catalogDescribe
    // web_signal_bindings_list -> signal.bindingsList
    // web_signal_sources_list -> signal.sourcesList
    // web_signal_reconcile -> signal.reconcile
    // web_signal_usage -> signal.usage
    // web_des_components -> des.components
    // web_des_stats -> des.stats
    // web_des_bottleneck -> des.bottleneck
    // web_plc_status -> plc.status
    // web_des_status -> des.status
    // Phase 4C: 15 read-only tools become queries (168 -> 153).
    // web_drive_list -> drive.list
    // web_sensor_list -> sensor.list
    // web_sensor_read -> sensor.read
    // web_transport_status -> transport.status
    // web_logic_flow -> logic.flow
    // web_trace_top -> trace.top
    // web_collision_status -> collision.status
    // web_group_list -> group.list
    // web_knowledge_get -> knowledge.get
    // web_knowledge_list -> knowledge.list
    // web_document_info_get -> document.infoGet
    // web_import_usd_extras -> document.usdExtrasPreview
    // web_link_compose -> link.compose
    // web_part_lookup -> part.lookup
    // web_prompt_list -> prompt.list
    expect(schemas.length).toBe(74);
  });

  /**
   * plan-724 T3 — the retirement itself, not just the arithmetic.
   *
   * A count is satisfied by any two tools disappearing, or by two appearing
   * while two others go. The names have to be asserted, or a later change that
   * happened to balance out would leave a dead tool announced to agents.
   */
  it('the retired circle tools stay gone', () => {
    const names = schemas.map((s) => s.name);
    expect(names).not.toContain('web_editor_list_circles');
    expect(names).not.toContain('web_editor_pivot_to_circle');
  });

  /**
   * plan-713 F3 — `destructiveHint` is announced, and only where it is meant.
   *
   * The hint's whole value is that it is rare: a client that shows a
   * confirmation for it must be able to trust that a tool carrying it can
   * destroy something the caller did not name. If every write carried it the
   * client would have to ignore it, which is the same as not having it.
   */
  describe('destructive classification', () => {
    const destructive = schemas.filter((s) => s.annotations?.destructiveHint === true);

    it('document.delete is a destructive write', () => {
      const d = createDocumentCommandDescriptors().find(d => d.id === 'document.delete');
      expect(d).toMatchObject({ readOnly: false, destructive: true });
    });

    it('nothing read-only is marked destructive', () => {
      const bad = destructive.filter((s) => s.annotations?.readOnlyHint === true).map((s) => s.name);
      expect(bad, `read-only tools cannot be destructive: ${bad.join(', ')}`).toEqual([]);
    });

    it('the hint stays rare — every carrier is listed here deliberately', () => {
      expect(destructive.map((s) => s.name).sort()).toEqual([]);
    });
  });

  /**
   * plan-713 F2, renamed 2026-08-19 — the two listings answer different questions.
   *
   * `web_catalog_list` is the placeable PLANNER CATALOGUE (`catalogId` —
   * templates you can place); `web_document_list` is the project's own GLB
   * documents. They were a single tool in the plan until the review found the
   * double semantics, so the separation is pinned here rather than left to the
   * descriptions.
   */
  it('the catalogue listing and the document listing stay distinct', () => {
    // plan-2007: the library reads live in the query family (out of the embed graph).
    const catalogue = createQueryCommandDescriptors().find((d) => d.id === 'library.catalogList');
    const documents = schemas.find((s) => s.name === 'web_document_list');
    expect(catalogue?.readOnly).toBe(true);
    expect(catalogue?.argsSchema).toEqual({ source: 'string', query: 'string', limit: 'number' });
    expect(documents?.description).toContain('document');
    expect(Object.keys(documents!.inputSchema.properties)).not.toContain('catalogId');
    expect(documents!.annotations?.readOnlyHint).toBe(true);
  });

  // plan-707 — the instance list is shared now, and the whole point of sharing it
  // is that a delegate cannot be announced, linted and documented from three
  // different lists. This pins the count of that ONE list.
  it('the shared instance list covers every linted delegate', () => {
    const names = new Set(schemas.map((s) => s.name));
    for (const t of ['web_status', 'web_editor_open',
      'web_describe', 'web_help',
      // plan-716 Phase 5 — the announced-but-unlinted delegate. `web_document_list`
      // is THE one document list; leaving it out of this list left it out of
      // the generated reference too, which is where an agent looks for it.
      'web_document_list', 'web_document_open', 'web_project_list', 'web_project_open',
      'web_ping',
      // plan-437 — the link composer. Announced and documented from this one
      // list like everything else.
      'web_query']) {
      expect(names.has(t), `${t} must come from the shared allSchemas() list`).toBe(true);
    }
  });

  // plan-327 AP3 — this is THE drift protection. `annotations.readOnlyHint` is the single
  // classification source: it feeds the write gate and tools/list in both bridges. There is no
  // second list to compare against on purpose (that comparison would be tautological), so the
  // guarantee has to be produced here, where the classification is authored.
  describe('side-effect classification', () => {
    it('every tool is classified explicitly — no implicit defaults', () => {
      const unclassified = schemas
        .filter((s) => s.annotations?.readOnlyHint === undefined)
        .map((s) => s.name);
      expect(
        unclassified,
        `Add { readOnly: true | false } to @McpTool for: ${unclassified.join(', ')}`,
      ).toEqual([]);
    });

    it('read-only means it changes nothing an operator can see', () => {
      const readOnly = new Set(
        schemas.filter((s) => s.annotations?.readOnlyHint === true).map((s) => s.name),
      );

      // Orientation and measurement must stay reachable for a read-only client: without these
      // it cannot obtain a single node path, which is what every other tool takes as input.
      for (const n of ['web_node_find', 'web_node_tree', 'web_help', 'web_status',
        'web_measure', 'web_node_shape', 'web_component_get', 'web_signal_list',
        // plan-394: reading a stored note observes nothing an operator can see.
        'web_query',
        // plan-707 F4: web_describe aggregates existing getters and moves
        // neither selection, panels nor camera — unlike web_node_bounds below.
        'web_describe',
        // plan-437: composing a URL is string work over live getters — it opens
        // nothing, mints no share and moves no viewport.

        // plan-740: every capture renders OFFSCREEN through the agent camera.
        // `web_view_sweep` joined this group in Phase 3 (D-A8 / review finding
        // I3) — it used to fly the viewport through six poses, and now moves no
        // camera at all. `web_screenshot` stays here as the human view.
        'web_eye', 'web_view_sweep', 'web_screenshot',
        'web_screenshot_burst', 'web_screenshot_analyze']) {
        expect(readOnly.has(n), `${n} must be read-only`).toBe(true);
      }

      // Mutations, obviously.
      for (const n of ['web_signal_set_bool', 'web_drive_jog', 'web_sim_reset',
        'web_editor_save', 'web_layout_place',
        // plan-394: writes rv_extras into the document and thence into the GLB.
        'web_knowledge_set',
        // plan-740 D-A8 / I2: the captures moved offscreen, but this still
        // DRAGS THE DRIVE through its range. CONNECT takes readOnlyHint blind
        // for its write gate, so this is the one that must not drift.
        'web_editor_verify_drive',
        // plan-761: switches the shading of the whole viewport AND persists it
        // (the Visual tab's `renderMode`) — a write, not a viewport-transient.
        'web_view_render_mode']) {
        expect(readOnly.has(n), `${n} must NOT be read-only`).toBe(false);
      }

      // The transient/viewport group stays a write on purpose: it persists nothing, but a
      // watching operator sees the view jump — a surprise on a running plant, not a feature.
      for (const n of ['web_camera_set', 'web_camera_focus', 'web_camera_orbit',
        'web_camera_projection',
        'web_select', 'web_select_similar']) {
        expect(readOnly.has(n), `${n} is viewport-transient and must be gated as a write`).toBe(false);
      }

      // Reading the camera or the selection changes nothing.
      expect(readOnly.has('web_camera_get')).toBe(true);
      expect(readOnly.has('web_selection_get')).toBe(true);

      // web_node_bounds focuses the camera by default (focus=true) and an MCP annotation is per
      // tool, not per argument — so it cannot be advertised as read-only.
      expect(readOnly.has('web_node_bounds')).toBe(false);
    });
  });

  /**
   * plan-706 T6 / R1 — the Mechanism ↔ Kinematic name collision.
   *
   * Two unrelated systems share a vocabulary: the rigid-body MECHANISM is a
   * joint graph with loop closure, the `Kinematic` is an axis GROUP. An agent
   * that picks the wrong one builds an unsolvable joint graph where a single
   * axis was wanted — and gets no error, because both requests are legal. With
   * sixteen mechanism tools sitting next to four kinematic ones, review
   * discipline is not a mitigation; a machine check is.
   */
  describe('mechanism vs. kinematic — the names must disambiguate themselves', () => {
    const mechanismTools = schemas.filter((s) => s.name.includes('mechanism'));
    const kinematicTools = schemas.filter((s) => /kinemati/i.test(s.name));

    it('both authoring families have moved out of the decorated tool roster', () => {
      expect(mechanismTools.length).toBe(0);
      // Phase 6A retired the remaining authoring aliases.
      expect(kinematicTools.length).toBe(0);
    });

    it('every mechanism description carries the demarcation', () => {
      const bad = mechanismTools
        .filter((s) => !(s.description.includes('NOT')
          && (s.description.includes('Kinematic') || s.description.includes('axis-group'))))
        .map((s) => s.name);
      expect(
        bad,
        `add "NOT the axis-group Kinematic system" to: ${bad.join(', ')}`,
      ).toEqual([]);
    });

    it('no mechanism description points at kinematize as if it were a synonym', () => {
      // `web_execute("editor.kinematize", …)` CREATES axis groups. Naming it inside a
      // mechanism description reads as "the same thing, other spelling"; the
      // demarcation points at the read tool instead.
      const bad = mechanismTools
        .filter((s) => s.description.includes('kinematize'))
        .map((s) => s.name);
      expect(bad, `these must reference editor.listKinematics instead: ${bad.join(', ')}`)
        .toEqual([]);
    });

    it('the kinematic tools only mention mechanisms to send you away', () => {
      for (const s of kinematicTools) {
        if (!/mechanism/i.test(s.description)) continue;
        expect(
          /not a? (rigid-body )?mechanism|NOT the .*mechanism/i.test(s.description),
          `${s.name} mentions "mechanism" outside a demarcation`,
        ).toBe(true);
      }
    });
  });

  it('descriptions are verb-first and within the word budget', () => {
    const bad: string[] = [];
    for (const s of schemas) {
      const words = s.description.trim().split(/\s+/);
      const first = words[0] ?? '';
      if (words.length > MAX_DESCRIPTION_WORDS) bad.push(`${s.name}: ${words.length} words`);
      if (!/^[A-Z]/.test(first) || ['The', 'A', 'An', 'This'].includes(first)) {
        bad.push(`${s.name}: not verb-first ("${first}")`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('superseded tools are gone', () => {
    const names = new Set(schemas.map((s) => s.name));
    for (const gone of ['web_component_add', 'web_hierarchy', 'web_place', 'web_move',
      'web_remove', 'web_placement_list', 'web_snap_list', 'web_snap_suggest',
      'web_snap_attach', 'web_set_mode', 'web_set_source_markers', 'web_analyze_object',
      'web_components_by_type', 'web_view_bounds',
      // plan-713 F8 — the two genuine duplicate pairs. One implementation each,
      // reachable under a second name that bought nothing but a second thing
      // for an agent to choose between.
      'web_scene_open',   // → web_document_open
      'web_scene_list',   // → web_document_list
      // 2026-08-19 rework — asset = document = model, hard rename, no aliases.
      'web_model_list',      // → web_document_list
      'web_model_open',      // → web_document_open
      'web_scene_save',      // → web_document_save
      'web_scene_new',       // → web_document_new
      'web_scene_export',    // → web_layout_export (it exports the planner snapshot)
      'web_library_assets',  // merged into web_document_list
      'web_library_update',  // → web_document_update
      // 'web_library_list' is BACK since plan-655 with the narrower meaning
      // (attached catalogs, not their parts) — see the `library` domain above.
      'web_library_describe']) { // → web_catalog_describe
      expect(names.has(gone), `${gone} should be renamed/removed`).toBe(false);
    }
  });

  /**
   * What the retirements replaced the old names WITH must still be there.
   *
   * A superseded entry says a name is gone; on its own that is also satisfied by
   * deleting the capability. Pinning the replacements is what stops a later
   * cleanup pass from removing a capability in the belief it is removing an
   * alias.
   */
  it('the retired names have live replacements', () => {
    const queries = [...createLibraryCommandDescriptors(), ...createQueryCommandDescriptors(), ...createPlannerCommandDescriptors()];
    for (const id of ['library.catalogList', 'library.catalogDescribe', 'layout.export']) {
      expect(queries.find((d) => d.id === id)?.readOnly).toBe(true);
    }
    const names = new Set(schemas.map((s) => s.name));
    for (const kept of ['web_document_list', 'web_document_open', 'web_document_save',
      'web_execute', 'web_query']) {
      expect(names.has(kept), `${kept} replaces a retired name and must exist`).toBe(true);
    }
  });
});
