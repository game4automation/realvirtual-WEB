// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.2 — the PARITY GATE, part a (metadata).
 *
 * Every MCP write tool is either a view of a command (its decorator carries
 * `command:`) or stands on {@link NO_UI_WRITE_TOOLS} with a reason. For a 1:1
 * binding the tool name, param names, types and `required` match the command's
 * MCP mirror, the annotations match, and the args schema is the wire shape. For
 * a multiplexer every branch is checked on its own: the command exists, its
 * annotations match, `when`/`requires` name declared params, the wire → command
 * transformation yields exactly the command's args shape, a missing required
 * value is refused, and the branch → command mapping equals a hand-kept
 * expectation table (never derived from the resolver). Four negative controls
 * prove the gate can fail.
 *
 * The allow-list STARTED as the measured full list of write tools (Phase 0) and
 * shrank with every migration; after plan-499 Phase 4 it held 55 of 89, after
 * plan-504 (the Mechanism section) 44 of 89, after plan-506 45 of 90 (the
 * document description is a text field) — each with a reason and none of
 * them "not yet migrated".
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  listToolEntries,
  type BindingBranch,
  type BranchBinding,
  type ParamEntry,
  type ToolCommandBinding,
} from '../src/core/engine/rv-mcp-tools';
import { CommandRegistry, type CommandArgType } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered, PIVOT_BRANCHES } from '../src/core/hmi/editor-command-descriptors';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureMechanismCommandsRegistered } from '../src/core/hmi/mechanism-command-descriptors';
import { ensureMuCommandsRegistered } from '../src/plugins/mu-interaction-plugin';

// ─── The allow-list (measured, shrinking) ───────────────────────────────

// Reason categories (plan-499 Phase 4). Every entry names WHY the tool is not a
// view of a command — no "not yet migrated" is left. A reason is either "there is
// no button to be a view of" or "the UI counterpart is not a one-click action
// with an enablement rule that could drift"; the last group is an explicit scope
// boundary with its own follow-up (see the plan's Restarbeit).
const VIEWPORT_SELECT =
  'viewport gesture, not a button: selection comes from picking / marquee / a hierarchy row and is the INPUT '
  + 'of commands (captured in the call context), not a command itself';
const AGENT_CAMERA =
  'moves the AGENT camera (split view / screenshots), which has no UI of its own — the user camera is '
  + 'navigated with the mouse, so there is no button to press or to glow';
const VIEW_SETTING =
  'display setting / view state (a switch or eye toggle) — a state setter without an enablement rule, so '
  + 'nothing can drift between tool and UI; settings toggles are not commands (as the planner toggles, §4 Phase 3)';
const DOC_LIFECYCLE =
  'document / project lifecycle flow (picker, save card, dirty prompt, folder permission) with its own '
  + 'confirmation dialogs, answered for MCP by the dialog policy — not a one-click action with an enabled() rule';
const FILE_IMPORT =
  'file import from the open project (relPath, provider conversion, long-running) — the UI path is a file '
  + 'picker / drag-and-drop, not a button';
const FIELD_INPUT =
  'numeric / text form input (a field editor per value, not a button); the op log books it undoably either way';
const AGENT_ONLY =
  'agent-only routine without a UI counterpart';
/** plan-504: the one mechanism write tool that stays a direct tool. */
const FIELD_INPUT_ANCHOR =
  'field input: millimetre anchor coordinates typed as JSON — there is no field editor to be a view of; '
  + 'the Anchor A/B pick buttons cover web_editor_mechanism_set_anchor_snap';
/** plan-729: path / waypoint authoring — no mechanism.* command (merge with plan-504, see the reason). */
const MECHANISM_PATH_AUTHORING =
  'plan-729 path / waypoint authoring: the Paths & Targets rows and the tool call the same planners (planCreateTarget / planCreatePath / planAddWaypoint / planRemoveWaypoint / planReorderWaypoints) through commitMechanismPlan without a solver rebuild; there is no mechanism.* command descriptor for them, so neither side carries an enablement rule or a button key';
/** plan-501: CSV import of a sampled path. */
const MECHANISM_TRAJECTORY_IMPORT =
  'plan-501 trajectory import: a CSV text / project file payload parsed by the bridge (parseTrajectoryCsv) and written as one undoable composite — the panel\'s "Import CSV" is a file picker, not a button with an enablement rule';
/** plan-501: the offline sizing run. */
const MECHANISM_TRAJECTORY_RUN =
  'plan-501 offline sizing run: a transient, cancellable bridge computation (runTrajectory) that changes no document — the panel\'s Run sizing / Cancel toggles the same bridge run, a session toggle, not an edit';

/**
 * Write tools WITHOUT a command binding, each with its reason (plan-499 Phase 4
 * final, plan-504). Phase 0 started with all 89 measured write tools; plan-499
 * bound 34, plan-504 the eleven Mechanism section tools (45). Adding a write
 * tool means binding it to a command or adding it here with a reason
 * (webviewer.mcp.md).
 */
export const NO_UI_WRITE_TOOLS: Readonly<Record<string, string>> = {
  // ── PLC auto-map (plan-545) ──
  web_signal_automap: 'the ConnectPanel auto-map strip (Check / Apply) and this tool call the same '
    + 'connect-store actions (checkAutoMap / applyAutoMap); interface config, not a command-registry entry',
  // ── Video recording (plan-537) ──
  web_record_video: 'internal recording tool (CLI npm run record + MCP); no UI button by design, '
    + 'it writes an MP4 into the project and changes no scene state',
  // ── Simulation / PLC mode (plan-539 F15) ──
  web_sim_mode: 'the TopBar Simulation / PLC toggle and this tool call the same controller '
    + '(viewer.connectionMode.setMode); not yet a command-registry entry',
  // ── selection / measurement ──
  web_select: VIEWPORT_SELECT,
  web_node_bounds: 'measurement (read); its only write is selecting the measured nodes — a viewport pick, no button',
  web_select_similar:
    'works in EVERY workspace on the viewer mesh universe; the Select ▸ menu and its select.* commands are '
    + 'editor-scoped (bound via web_editor_shortcut S>I / S>M / S>V) — binding this tool would take the '
    + 'viewer-mode selection away',
  // ── agent camera ──
  web_camera_projection: AGENT_CAMERA, web_camera_set: AGENT_CAMERA, web_camera_focus: AGENT_CAMERA,
  web_camera_orbit: AGENT_CAMERA, web_camera_view: AGENT_CAMERA, web_camera_fly: AGENT_CAMERA,
  // ── view state / settings ──
  web_view_isolate: VIEW_SETTING, web_view_source_markers: VIEW_SETTING,
  web_group_set_visible: VIEW_SETTING, web_group_set_listed: VIEW_SETTING,
  web_mode_set: 'workspace switch (mode dropdown) — navigation, not an action on the document; the mode manager owns its guards',
  // ── document / project lifecycle ──
  web_editor_open: DOC_LIFECYCLE, web_editor_close: DOC_LIFECYCLE, web_editor_save: DOC_LIFECYCLE,
  web_editor_descend: DOC_LIFECYCLE, web_editor_back: DOC_LIFECYCLE,
  web_document_open: DOC_LIFECYCLE, web_document_save: DOC_LIFECYCLE, web_document_new: DOC_LIFECYCLE,
  web_document_update: DOC_LIFECYCLE, web_document_bind: DOC_LIFECYCLE,
  web_project_open: DOC_LIFECYCLE, web_project_folder: DOC_LIFECYCLE,
  // ── import ──
  web_editor_import_glb: FILE_IMPORT, web_editor_import_cad: FILE_IMPORT,
  // ── form input ──
  web_editor_transform: FIELD_INPUT, web_component_set: FIELD_INPUT,
  web_knowledge_set: 'knowledge note = an inspector TEXT FIELD (rv-node-knowledge-field-renderer), durable agent memory — not a button',
  // plan-506: same shape as web_knowledge_set, one level up — a document, not a node.
  web_document_info_set: 'description = a detail-pane TEXT FIELD (DocumentInfoEditor), summary + Markdown committed on blur — not a button',
  web_signal_bind: 'signal-binding editor: target + component path + slot + source picked in the binding dialog — a form, not a button',
  web_signal_unbind: 'signal-binding editor: target + component path + slot picked in the binding dialog — a form, not a button',
  // ── agent routines / multi-target ops ──
  web_editor_kinematize: 'compound agent macro (group + Drive + direction/speed/limits + pivot) in one undo step — the UI reaches it in several Quick Edit steps, each a command',
  web_editor_verify_drive: AGENT_ONLY + ' (select axis, aim the agent camera, jog, capture frames)',
  web_editor_separate:
    'multi-target mesh operation with a per-mesh partial-success report (separated / skipped) — a command '
    + 'refuses with ONE reason, this tool must continue past individual meshes; the context menu runs the same mesh-separator op',
  // ── prompt queue — plan-486 follow-up (plan-761) ──
  // The agent's end of the prompt queue: the UI only ENQUEUES a task on a node
  // (the prompt field), nothing in the UI claims one. A claim mutates the
  // browser-tab task store, never the scene.
  web_prompt_claim: AGENT_ONLY + ' (plan-486 prompt queue: the UI enqueues, only the agent claims; a browser-tab store mutation, not a scene action)',
  // 8a34c524 (2026-10-08), absorbed at the 6.4.0 release: the session-only collision check.
  web_collision_watch: AGENT_ONLY + ' (session-only collision roles for an agent check; nothing is saved into the model and there is no UI counterpart)',
  web_collision_reset: AGENT_ONLY + ' (clears the latched pairs / roles of web_collision_watch; session-only, no UI counterpart)',
  // ── runtime sessions / kernels ──
  web_editor_test_start: 'in-place test SESSION lifecycle (async materialise / attach / restore, arms force recording) — it owns the test-run lock every authoring command refuses on; its toolbar Play/Stop is a session toggle, not an edit',
  web_editor_test_stop: 'in-place test SESSION lifecycle (restores the authoring state) — the counterpart of web_editor_test_start, a session toggle, not an edit',
  web_des_step: 'discrete-event kernel stepping, only meaningful in DES mode — a kernel control without an enablement rule (the DES toolbar is outside the four plan-499 surfaces)',
  web_des_set_mode: 'DES sub-mode selector (animated / hybrid / fastforward / step) — a mode setter without an enablement rule',
  web_plc_deploy: 'virtual PLC: compiles Structured Text source passed as a parameter — the UI is a code editor, not a button',
  web_plc_run: 'virtual PLC scan-cycle state (run) — a kernel state setter without an enablement rule; errors are reported by the compiler/scan, not as a precondition',
  web_plc_stop: 'virtual PLC scan-cycle state (warm stop) — a kernel state setter without an enablement rule',
  // ── mechanism authoring (plan-504: the other eleven are bound) ──
  web_editor_mechanism_set_anchor: FIELD_INPUT_ANCHOR,
  // ── plan-729 Cartesian paths / plan-501 drive sizing (unbound, each with its reason) ──
  web_editor_mechanism_add_target: MECHANISM_PATH_AUTHORING,
  web_editor_mechanism_path_create: MECHANISM_PATH_AUTHORING,
  web_editor_mechanism_path_add_waypoint: MECHANISM_PATH_AUTHORING,
  web_editor_mechanism_path_remove_waypoint: MECHANISM_PATH_AUTHORING,
  web_editor_mechanism_path_move_waypoint: MECHANISM_PATH_AUTHORING,
  web_editor_mechanism_trajectory_import: MECHANISM_TRAJECTORY_IMPORT,
  web_editor_mechanism_trajectory_run: MECHANISM_TRAJECTORY_RUN,
};

/** Hand-kept branch → command expectation (NOT derived from the resolver). */
const EXPECTED_BRANCHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  web_editor_pivot: {
    '{"mode":"bottom"}': 'editor.pivotToBottom',
    '{"mode":"object_center"}': 'editor.pivotToObjectCenter',
    '{"mode":"group_center"}': 'editor.centerKinematicToGroup',
    '{"mode":"align_y_up"}': 'editor.alignYUp',
  },
  web_editor_shortcut: {
    '{"keys":"S>I"}': 'select.identical',
    '{"keys":"S>M"}': 'select.sameMaterial',
    '{"keys":"S>V"}': 'select.invert',
    '{"keys":"K"}': 'editor.assignToKinematic',
    '{"keys":"H"}': 'editor.hide',
    '{"keys":"SHIFT+H"}': 'editor.show',
    '{"keys":"DELETE"}': 'editor.delete',
    '{"keys":"CTRL+Z"}': 'editor.undo',
    '{"keys":"CTRL+Y"}': 'editor.redo',
    '{"keys":"ESCAPE"}': 'selection.clear',
    '{"keys":"SHIFT+Z"}': 'editor.wireframe',
  },
  web_editor_assign_to_kinematic: {
    '{}': 'editor.assignToKinematic',
  },
};

// ─── The gate ───────────────────────────────────────────────────────────

interface GateEntry {
  readonly name: string;
  readonly params: readonly ParamEntry[];
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly command?: ToolCommandBinding;
  /** `method.length` — bound bodies take the call context as trailing parameter. */
  readonly arity?: number;
}

const wireType = (t: string): CommandArgType => (t === 'integer' ? 'number' : t as CommandArgType);

function sample(type: string): unknown {
  switch (type) {
    case 'number': case 'integer': return 1;
    case 'boolean': return true;
    default: return 'X';
  }
}

/** A wire object with every required param, the branch's `when` values and its `requires`. */
function wireFixture(entry: GateEntry, br: BindingBranch, omit?: string): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  for (const p of entry.params) if (p.required) w[p.name] = sample(p.type);
  for (const r of br.requires ?? []) {
    const p = entry.params.find((x) => x.name === r);
    w[r] = sample(p?.type ?? 'string');
  }
  Object.assign(w, br.when);
  if (omit) delete w[omit];
  return w;
}

function typeOk(v: unknown, t: CommandArgType): boolean {
  if (v === null || v === undefined) return true; // null = "take it from the context"
  if (t === 'string[]') return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (t === 'number[]') return Array.isArray(v) && v.every((x) => typeof x === 'number');
  return typeof v === t;
}

/** Throws with every problem found. `expected` is the hand-kept branch table. */
export function gate(
  entries: readonly GateEntry[],
  registry: CommandRegistry,
  expected: typeof EXPECTED_BRANCHES,
  allowList: Readonly<Record<string, string>>,
): void {
  const problems: string[] = [];
  const writeNames = new Set(entries.filter((e) => e.readOnly === false).map((e) => e.name));
  for (const e of entries) {
    if (e.readOnly !== false && !e.command) continue;
    if (!e.command) {
      if (!allowList[e.name]?.trim()) problems.push(`${e.name} has no binding and no allow-list reason`);
      continue;
    }
    if (allowList[e.name]) problems.push(`${e.name} is bound but still on the allow-list`);
    if (e.arity !== undefined && e.arity !== e.params.length + 1) {
      problems.push(`${e.name}: signature — a bound body must take ctx?: McpCallContext as its last parameter`);
    }
    const annotationsMatch = (id: string): void => {
      const d = registry.get(id)!;
      if (d.readOnly !== (e.readOnly ?? false) || !!d.destructive !== !!e.destructive) {
        problems.push(`${e.name} → ${id}: annotations differ (readOnly/destructive)`);
      }
    };
    if (typeof e.command === 'string') {
      const desc = registry.get(e.command);
      if (!desc) { problems.push(`${e.name}: unknown command ${e.command}`); continue; }
      annotationsMatch(e.command);
      const mirror = { tool: e.name, params: e.params.map((p) => ({ name: p.name, type: p.type, required: p.required })) };
      if (JSON.stringify(desc.mcp) !== JSON.stringify(mirror)) {
        problems.push(`${e.name}: mcp mirror of ${e.command} differs from the decorator`);
      }
      const shape = Object.fromEntries(e.params.map((p) => [p.name, wireType(p.type)]));
      if (JSON.stringify(desc.argsSchema) !== JSON.stringify(shape)) {
        problems.push(`${e.name}: argsSchema of ${e.command} is not the wire shape (type)`);
      }
      continue;
    }
    const binding = e.command as BranchBinding;
    const table = expected[e.name];
    if (!table) { problems.push(`${e.name}: no expectation table for its branches (mapping)`); continue; }
    const seen = new Set<string>();
    for (const br of binding.branches) {
      const key = JSON.stringify(br.when);
      seen.add(key);
      const label = `${e.name}: branch ${key} → ${br.id}`;
      if (table[key] !== br.id) problems.push(`${label}: mapping differs from the expectation table (${table[key] ?? 'none'})`);
      const desc = registry.get(br.id);
      if (!desc) { problems.push(`${label}: unknown command`); continue; }
      annotationsMatch(br.id);
      for (const k of [...Object.keys(br.when), ...(br.requires ?? [])]) {
        if (!e.params.some((p) => p.name === k)) problems.push(`${label}: "${k}" is not a declared param`);
      }
      const norm = binding.normalize ?? ((w: Record<string, unknown>) => w);
      let args: unknown;
      try {
        args = br.args(norm(wireFixture(e, br)));
      } catch (err) {
        problems.push(`${label}: args threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const a = (args ?? {}) as Record<string, unknown>;
      const keys = Object.keys(a).sort();
      const schemaKeys = Object.keys(desc.argsSchema).sort();
      if (JSON.stringify(keys) !== JSON.stringify(schemaKeys)) {
        problems.push(`${label}: args keys ${keys.join(',')} ≠ argsSchema ${schemaKeys.join(',')}`);
      }
      for (const [k, t] of Object.entries(desc.argsSchema)) {
        if (!typeOk(a[k], t)) problems.push(`${label}: "${k}" has the wrong type (want ${t})`);
      }
      for (const r of br.requires ?? []) {
        let threw = false;
        try { br.args(norm(wireFixture(e, br, r))); } catch { threw = true; }
        if (!threw) problems.push(`${label}: missing required "${r}" is not refused`);
      }
    }
    for (const key of Object.keys(table)) {
      if (!seen.has(key)) problems.push(`${e.name}: expected branch ${key} is missing (mapping)`);
    }
  }
  for (const name of Object.keys(allowList)) {
    if (!writeNames.has(name) && !entries.some((e) => e.name === name)) {
      problems.push(`allow-list names a tool that does not exist: ${name}`);
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));
}

// ─── Fixtures ───────────────────────────────────────────────────────────

let entries: GateEntry[] = [];
const registry = new CommandRegistry();
ensureEditorCommandsRegistered(registry);
ensurePlannerCommandsRegistered(registry);
ensureSimCommandsRegistered(registry);
ensureViewCommandsRegistered(registry);
ensureMechanismCommandsRegistered(registry);
ensureMuCommandsRegistered(registry);

beforeAll(async () => {
  const { McpBridgePlugin } = await import('../src/plugins/mcp-bridge-plugin');
  const plugin = new McpBridgePlugin();
  entries = plugin.mcpToolInstances.flatMap((inst) => listToolEntries(inst).map((te) => ({
    name: te.name,
    params: te.params,
    readOnly: te.readOnly,
    destructive: te.destructive,
    command: te.command,
    arity: te.command ? (inst as unknown as Record<string, (...a: unknown[]) => unknown>)[te.methodKey].length : undefined,
  })));
}, 240_000);

// ─── Tests ──────────────────────────────────────────────────────────────

describe('parity gate (metadata)', () => {
  it('every write tool is bound or explicitly allow-listed with a reason', () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(() => gate(entries, registry, EXPECTED_BRANCHES, NO_UI_WRITE_TOOLS)).not.toThrow();
  });

  // 89 -> 96 writes / 44 -> 51 allow-listed with plan-729 (five path tools) and
  // plan-501 (trajectory_import, trajectory_run) on top of plan-504; plan-506
  // adds `web_document_info_set` (97 writes / 52 allow-listed); plan-760 Phase 2
  // adds the four BOUND group verbs `web_editor_group_*` (101 writes / 49 bound,
  // allow-list unchanged).
  // plan-539 F15 adds the allow-listed `web_sim_mode` (102 writes / 53 allow-listed);
  // plan-537 the allow-listed `web_record_video` (103 writes / 54 allow-listed);
  // plan-545 the allow-listed `web_signal_automap` (104 writes / 55 allow-listed);
  // plan-761 the BOUND `web_view_render_mode` (view of `view.renderMode`;
  // 105 writes / 50 bound, allow-list unchanged);
  // plan-486 follow-up (plan-761): the allow-listed `web_prompt_claim`, which
  // plan-486 had added as a write without an entry here (106 writes / 56 allow-listed).
  // plan-567: the two BOUND carrier tools `web_mu_delete` / `web_mu_move` (views
  // of `mu.delete` / `mu.move`; 108 writes / 52 bound, allow-list unchanged).
  // plan-589 Phase 2: the two BOUND signal tools `web_editor_signal_set_field` /
  // `web_editor_signal_set_binding` (views of `editor.signalSetField` /
  // `editor.signalSetBinding`; 110 writes / 54 bound, allow-list unchanged).
  // plan-589 Phase 3: the BOUND `web_editor_signals_create_from_interface` (view of
  // `editor.signalsCreateFromInterface`; 111 writes / 55 bound, allow-list unchanged).
  // plan-590: the three BOUND rename tools `web_editor_signal_rename` / `_repair` / `_recheck`
  // (views of `editor.signalRename` / `editor.signalRenameRepair` / `editor.signalRenameRecheck`;
  // 114 writes / 58 bound, allow-list unchanged).
  // plan-591: the BOUND `web_view_visual_preset` (view of `view.visualPreset` — the two
  // quality rows of the render-mode menu; 115 writes / 59 bound, allow-list unchanged).
  // NOTE (2026-10-11, still true): the LIVE count is two HIGHER than this pin. The extra two
  // are `web_collision_watch` and `web_collision_reset`, introduced by commit 8a34c524
  // (2026-10-08) without a binding and without an allow-list entry; they are neither
  // plan-589's nor plan-590's nor plan-591's and are deliberately not absorbed here — which is
  // also why the gate above still throws for `web_collision_watch`. plan-591 raised the pin by
  // exactly its OWN one tool, so both assertions stay red by exactly those same two and by
  // nothing else, until that commit's own follow-up fixes them.
  // 6.4.0 release: the two collision write tools absorbed as allow-listed (117 writes / 59
  // bound / 58 allow-listed) — the NOTE above is resolved.
  it('allow-list final: measured counts after plan-504 + plan-506 + plan-729/501 + plan-760 + plan-539 + plan-537 + plan-545 + plan-761 + plan-486 + plan-567 + plan-589 + plan-590 + plan-591 + 6.4.0 collision (117 writes, 59 bound, 58 allow-listed)', () => {
    const writes = entries.filter((e) => e.readOnly === false);
    const bound = writes.filter((e) => e.command);
    expect(writes.length).toBe(117);
    expect(bound.length).toBe(59);
    expect(Object.keys(NO_UI_WRITE_TOOLS).length).toBe(58);
    expect(Object.keys(NO_UI_WRITE_TOOLS).length).toBe(writes.length - bound.length);
    for (const e of bound) expect(NO_UI_WRITE_TOOLS[e.name], e.name).toBeUndefined();
  });

  it('no allow-list entry is a placeholder: every reason is specific (no "not yet migrated")', () => {
    for (const [name, reason] of Object.entries(NO_UI_WRITE_TOOLS)) {
      expect(reason, name).not.toMatch(/not yet migrated|TODO|later/i);
      expect(reason.length, name).toBeGreaterThan(30);
    }
  });

  it('bound tools are writes, and every bound command exists eagerly in the registry', () => {
    for (const e of entries.filter((x) => x.command)) {
      expect(e.readOnly, e.name).toBe(false);
      const ids = typeof e.command === 'string' ? [e.command] : (e.command as BranchBinding).branches.map((b) => b.id);
      for (const id of ids) expect(registry.get(id), `${e.name} → ${id}`).toBeDefined();
    }
  });

  it('plan-504: the eleven mechanism tools are 1:1 views of mechanism.* (set_anchor stays a field input)', () => {
    const expected: Record<string, string> = {
      web_editor_mechanism_create: 'mechanism.create',
      web_editor_mechanism_add_joint: 'mechanism.addJoint',
      web_editor_mechanism_assign_drive: 'mechanism.assignDrive',
      web_editor_mechanism_jog: 'mechanism.jog',
      web_editor_mechanism_set_anchor_snap: 'mechanism.setAnchorSnap',
      web_editor_mechanism_set_axis: 'mechanism.setAxis',
      web_editor_mechanism_add_body: 'mechanism.addBody',
      web_editor_mechanism_set_mass: 'mechanism.setMass',
      web_editor_mechanism_set_limits: 'mechanism.setLimits',
      web_editor_mechanism_statics: 'mechanism.statics',
      web_editor_mechanism_fix: 'mechanism.fix',
    };
    const mech = entries.filter((e) => e.name.startsWith('web_editor_mechanism_') && e.readOnly === false);
    expect(Object.fromEntries(mech.filter((e) => e.command).map((e) => [e.name, e.command]))).toEqual(expected);
    expect(mech.find((e) => e.name === 'web_editor_mechanism_set_anchor')?.command).toBeUndefined();
    // Twelve descriptors: the eleven bindings plus the UI-only batch.
    const ids = registry.list().map((d) => d.id).filter((id) => id.startsWith('mechanism.'));
    expect(ids.sort()).toEqual([...Object.values(expected), 'mechanism.addBodies'].sort());
    expect(registry.get('mechanism.addBodies')?.mcp).toBeUndefined();
    // candidateId is optional on both snap consumers; pickJson is new and optional (additive wire change).
    const snap = entries.find((e) => e.name === 'web_editor_mechanism_set_anchor_snap')!;
    expect(snap.params.find((p) => p.name === 'candidateId')?.required).toBe(false);
    expect(snap.params.find((p) => p.name === 'pickJson')?.required).toBe(false);
    const axis = entries.find((e) => e.name === 'web_editor_mechanism_set_axis')!;
    expect(axis.params.find((p) => p.name === 'candidateId')?.required).toBe(false);
  });

  it('negative controls fail the gate', () => {
    const pivot = entries.find((e) => e.name === 'web_editor_pivot')!;
    const table = { web_editor_pivot: EXPECTED_BRANCHES.web_editor_pivot };
    const withBranch = (patch: Partial<BindingBranch>, when?: Record<string, string>): GateEntry[] => {
      const base = PIVOT_BRANCHES.find((b) => b.when['mode'] === (when?.['mode'] ?? 'object_center'))!;
      const branches = PIVOT_BRANCHES.map((b) => (b === base ? { ...b, ...patch } : b));
      return [{ ...pivot, command: { ...(pivot.command as BranchBinding), branches } }];
    };
    // unknown command
    expect(() => gate(withBranch({ id: 'editor.doesNotExist' }), registry, table, {})).toThrow(/unknown command/);
    // wrong type
    expect(() => gate(withBranch({ args: () => ({ path: 42, targetPath: 'X' }) }), registry, table, {})).toThrow(/type/);
    // a required value that the branch needs but does not declare
    expect(() => gate(withBranch({ requires: [] }), registry, table, {})).toThrow(/targetPath/);
    // wrong mapping (expectation table)
    expect(() => gate(withBranch({ id: 'editor.alignYUp' }, { mode: 'bottom' }), registry, table, {})).toThrow(/mapping/);
    // and an unbound write tool without a reason
    expect(() => gate([{ name: 'web_x', params: [], readOnly: false }], registry, {}, {})).toThrow(/no binding/);
  });
});
