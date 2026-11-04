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
 * them "not yet migrated". plan-773 Phase 3 Nachtrag (2026-10-23) made it
 * shrink again rather than grow: its seven IK authoring writes are views of
 * `ik.*` commands, 67 of 144.
 */

import { movedToolOf } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  listToolEntries,
  type BindingBranch,
  type BranchBinding,
  type ParamEntry,
  type ToolCommandBinding,
} from '../src/core/engine/rv-mcp-tools';
import { CommandRegistry, type CommandArgType } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered, PIVOT_BRANCHES, PIVOT_BINDING, SHORTCUT_BRANCHES, ASSIGN_TO_KINEMATIC_BRANCHES } from '../src/core/hmi/editor-command-descriptors';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { ensureMechanismCommandsRegistered } from '../src/core/hmi/mechanism-command-descriptors';
import { ensureMuCommandsRegistered } from '../src/plugins/mu-interaction-plugin';
import { ensureSolidCraftCommandsRegistered } from '../src/core/hmi/solidcraft-command-descriptors';
import { ensureKnowledgeCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-knowledge-tools';
import { ensureDocumentInfoCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-document-info-tools';
import { ensureSignalBindCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { ensureGenerateUVsCommandRegistered, ensureSeparateCommandRegistered } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { ensureLibraryCommandsRegistered } from '../src/core/library/library-commands';
import { ensureIkCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';

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
const DOC_LIFECYCLE =
  'document / project lifecycle flow (picker, save card, dirty prompt, folder permission) with its own '
  + 'confirmation dialogs, answered for MCP by the dialog policy — not a one-click action with an enabled() rule';
const AGENT_ONLY =
  'agent-only routine without a UI counterpart';
/** plan-641: switching a macro recording on / off. */
const MACRO_SESSION =
  'agent-only macro recording session (plan-641): switches the recorder of MCP command calls on / off — a session '
  + 'toggle with no UI counterpart in Stufe 1, it changes no model state itself';
/**
 * plan-773 Phase 3 Nachtrag (2026-10-23): the seven IK authoring tools are
 * BOUND, so nothing of them is left here.
 *
 * Phase 3 had put them on this list with the reason that an `ik.*` command
 * would have "no second caller and no button to glow". That weighed two of the
 * three things a binding buys and missed the third: a bound tool is not listed
 * separately in `tools/list`, so the surface an agent reads shrinks instead of
 * growing by seven — and this list is meant to shrink with every migration.
 * They are now views of `ik.robot.rig` / `ik.path.create` / `ik.target.add` /
 * `_set` / `_remove` / `_reorder` / `_solve` (`rv-mcp-robot-tools.ts`).
 */

/**
 * Write tools WITHOUT a command binding, each with its reason (plan-499 Phase 4
 * final, plan-504). Phase 0 started with all 89 measured write tools; plan-499
 * bound 34, plan-504 the eleven Mechanism section tools (45). Adding a write
 * tool means binding it to a command or adding it here with a reason
 * (webviewer.mcp.md).
 */
/**
 * Bound tools that are READ-ONLY, each with the reason a binding was worth it
 * anyway (plan-773 Phase 5, 2026-10-24).
 *
 * Every binding before this one was a write, because the migration's purpose
 * was to give a write tool the enablement rule and the button its UI
 * counterpart already had. A read tool had nothing to gain — so "bound implies
 * write" held by construction rather than by design.
 *
 * `web_robot_program_export` is the first tool for which the other two reasons
 * apply on their own: it has a real UI counterpart (the Export button on the
 * IKPath inspector, plan-773 F19), and a binding is what gives the button and
 * the tool ONE implementation — which is the whole point of putting the licence
 * gate (E3), the F21 forward-kinematics check and the E9 refusals on a path
 * both callers must traverse. Annotating it as a write to satisfy the old
 * invariant would be worse than widening the invariant: it writes nothing, and
 * a client that gates writes would refuse a read.
 */
export const BOUND_READ_ONLY_TOOLS: Readonly<Record<string, string>> = {};

export const NO_UI_WRITE_TOOLS: Readonly<Record<string, string>> = {
  // ── USD export (plan-764) ──
  web_export_usd: 'the document card\'s "Export USD…" verb and this tool run the same bound provider export '
    + '(ActiveDocumentFileExport.run from the view seam, not a command-registry entry); it writes a file into '
    + 'the project and changes no document or scene state',
  // ── Video recording (plan-537) ──
  web_record_video: 'internal recording tool (CLI npm run record + MCP); no UI button by design, '
    + 'it writes an MP4 into the project and changes no scene state',
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
  // ── document / project lifecycle ──
  web_editor_open: DOC_LIFECYCLE, web_editor_close: DOC_LIFECYCLE, web_editor_save: DOC_LIFECYCLE,
  web_editor_descend: DOC_LIFECYCLE, web_editor_back: DOC_LIFECYCLE,
  web_document_open: DOC_LIFECYCLE, web_document_save: DOC_LIFECYCLE,
  web_project_open: DOC_LIFECYCLE, web_project_folder: DOC_LIFECYCLE,
  // ── agent routines / multi-target ops ──
  web_editor_verify_drive: AGENT_ONLY + ' (select axis, aim the agent camera, jog, capture frames)',
  // ── prompt queue — plan-486 follow-up (plan-761) ──
  // The agent's end of the prompt queue: the UI only ENQUEUES a task on a node
  // (the prompt field), nothing in the UI claims one. A claim mutates the
  // browser-tab task store, never the scene.
  web_prompt_claim: AGENT_ONLY + ' (plan-486 prompt queue: the UI enqueues, only the agent claims; a browser-tab store mutation, not a scene action)',
  // ── runtime sessions / kernels ──
  web_editor_test_start: 'in-place test SESSION lifecycle (async materialise / attach / restore, arms force recording) — it owns the test-run lock every authoring command refuses on; its toolbar Play/Stop is a session toggle, not an edit',
  web_editor_test_stop: 'in-place test SESSION lifecycle (restores the authoring state) — the counterpart of web_editor_test_start, a session toggle, not an edit',
  // ── plan-641: the reduced command interface + macros ──
  web_execute: 'generic dispatcher OF the command registry (commandRegistry.execute by id) — it is the own MCP door of the registry, '
    + 'so binding it to one command would be a contradiction; every rule, refusal and undo step comes from the command it names',
  web_batch: 'runs several registry commands in order through the same wrapper as web_execute (one dispatch per step) — '
    + 'a sequence of commands, not one command with an enablement rule',
  web_macro_record_start: MACRO_SESSION,
  web_macro_record_stop: MACRO_SESSION,
  web_macro_annotate: 'edits the note (reason / source) of a recorded macro line — macro metadata of the document, no model change and no button',
  web_macro_save: 'writes a recorded macro as readable JSON into the project folder (macros/<name>.macro.json); changes no document or scene state',
  web_macro_replay: 'starts a replay JOB that runs the recorded command lines one by one through the registry (each line IS a command '
    + 'dispatch) — a job lifecycle (status / cancel), not one command',
  web_macro_cancel: 'stops a running replay / batch job between two lines — a job control without an enablement rule, no model change',
  web_macro_import: 'takes a macro from the project folder or inline JSON into the book of the open document — macro metadata, '
    + 'no model change and no button',
  // ── plan-650 parametric families ──
  web_editor_parametric_define: AGENT_ONLY + ' (plan-650: defines a parametric family — schema, rule code and parts root '
    + 'in one step plus the first variant; there is no button, the inspector only edits the values of an existing family)',
  web_editor_parametric_set: 'parameter mask = inspector FIELD INPUTS (rv-parametric-values-field) — values typed or picked per '
    + 'parameter, committed at the end of an edit; a form, not a button',
  web_macro_assert: 'adds an assertion line (a geometry check with an expectation) to a macro — macro metadata of the document, '
    + 'measured read-only; no model change and no button',
  // ── plan-773: the seven `web_robot_*` writes are BOUND to `ik.*` — see above ──
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
    '{"keys":"T"}': 'editor.toggleTransformTool',
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
ensureSessionOverlayCommandsRegistered(registry);
ensureComponentCommandsRegistered(registry);
ensureQueryCommandsRegistered(registry);
ensureDocumentCommandsRegistered(registry);
ensureSignalAutomapCommandsRegistered(registry);
ensureDesPlcCommandsRegistered(registry);
ensureMechanismCommandsRegistered(registry);
ensureMuCommandsRegistered(registry);
ensureSolidCraftCommandsRegistered(registry);
ensureKnowledgeCommandsRegistered(registry);
ensureDocumentInfoCommandsRegistered(registry);
ensureSignalBindCommandsRegistered(registry);
ensureSeparateCommandRegistered(registry);
ensureGenerateUVsCommandRegistered(registry);
ensureLibraryCommandsRegistered(registry);
ensureIkCommandsRegistered(registry);

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

const FORMER_BINDINGS: Record<string, readonly string[]> = {
  web_signal_set_bool: ['signal.setBool'],
  web_signal_set_float: ['signal.setFloat'],
  web_drive_jog: ['drive.jog'],
  web_sim_play_pause: ['sim.playPause'],
  web_view_render_mode: ['view.renderMode'],
  web_view_visual_preset: ['view.visualPreset'],
  web_sim_reset: ['sim.reset'],
  web_drive_stop: ['drive.stop'],
  web_drive_speed_override: ['sim.speedOverride'],
  web_mu_delete: ['mu.delete'],
  web_mu_move: ['mu.move'],
  web_library_attach: ['library.attach'],
  web_library_detach: ['library.detach'],
  web_layout_place: ['layout.place'],
  web_layout_move: ['layout.move'],
  web_layout_remove: ['layout.remove'],
  web_layout_snap_attach: ['layout.snapAttach'],
  web_robot_rig_from_library: ['ik.robot.rig'],
  web_robot_path_create: ['ik.path.create'],
  web_robot_target_add: ['ik.target.add'],
  web_robot_target_set: ['ik.target.set'],
  web_robot_target_remove: ['ik.target.remove'],
  web_robot_target_reorder: ['ik.target.reorder'],
  web_robot_solve_target: ['ik.target.solve'],
  web_robot_program_export: ['ik.program.export'],
  web_signal_bind: ['signal.bind'],
  web_signal_unbind: ['signal.unbind'],
  web_knowledge_set: ['knowledge.set'],
  web_document_info_set: ['document.infoSet'],
  web_editor_undo: ["editor.undo"],
  web_editor_redo: ["editor.redo"],
  web_editor_transform: ["editor.transform"],
  web_editor_zero_position: ["editor.zeroPosition"],
  web_editor_rotate90: ["editor.rotate90"],
  web_editor_to_ground: ["editor.toGround"],
  web_editor_pivot: PIVOT_BRANCHES.map((b) => b.id),
  web_editor_rename: ["editor.rename"],
  web_editor_delete: ["editor.delete"],
  web_editor_set_visible: ["editor.setVisible"],
  web_editor_separate: ["editor.separate"],
  web_editor_generate_uvs: ["editor.generateUVs"],
  web_editor_create_empty: ["editor.createEmpty"],
  web_editor_reparent: ["editor.reparent"],
  web_editor_add_component: ["editor.addComponent"],
  web_editor_remove_component: ["editor.removeComponent"],
  web_editor_set_field: ["editor.setField"],
  web_editor_mechanism_create: ["mechanism.create"],
  web_editor_mechanism_add_joint: ["mechanism.addJoint"],
  web_editor_mechanism_assign_drive: ["mechanism.assignDrive"],
  web_editor_mechanism_jog: ["mechanism.jog"],
  web_editor_mechanism_set_anchor_snap: ["mechanism.setAnchorSnap"],
  web_editor_mechanism_set_axis: ["mechanism.setAxis"],
  web_editor_mechanism_add_body: ["mechanism.addBody"],
  web_editor_mechanism_set_mass: ["mechanism.setMass"],
  web_editor_mechanism_set_limits: ["mechanism.setLimits"],
  web_editor_mechanism_statics: ["mechanism.statics"],
  web_editor_mechanism_fix: ["mechanism.fix"],
  web_editor_solidcraft_connect: ["solidcraft.connect"],
  web_editor_solidcraft_resync: ["solidcraft.resync"],
  web_editor_solidcraft_disconnect: ["solidcraft.disconnect"],
  web_editor_create_kinematic: ["editor.createKinematic"],
  web_editor_assign_to_kinematic: ASSIGN_TO_KINEMATIC_BRANCHES.map((b) => b.id),
  web_editor_group_assign: ["editor.groupAssign"],
  web_editor_group_remove: ["editor.groupRemove"],
  web_editor_group_rename: ["editor.groupRename"],
  web_editor_group_dissolve: ["editor.groupDissolve"],
  web_editor_add_signal: ["editor.addSignal"],
  web_editor_convert_signal: ["editor.convertSignal"],
  web_editor_toggle_signal_direction: ["editor.toggleSignalDirection"],
  web_editor_signal_set_field: ["editor.signalSetField"],
  web_editor_signal_set_binding: ["editor.signalSetBinding"],
  web_editor_signals_create_from_interface: ["editor.signalsCreateFromInterface"],
  web_editor_signal_rename: ["editor.signalRename"],
  web_editor_signal_rename_repair: ["editor.signalRenameRepair"],
  web_editor_signal_rename_recheck: ["editor.signalRenameRecheck"],
  web_editor_add_logic_step: ["editor.addLogicStep"],
  web_editor_shortcut: SHORTCUT_BRANCHES.map((b) => b.id),
  web_editor_assign_material: ["editor.assignMaterial"],
  web_editor_materialize: ["editor.materialize"],
};

describe('parity gate (metadata)', () => {
  it('every former binding has exactly its command targets and no decorated alias', () => {
    for (const [name, ids] of Object.entries(FORMER_BINDINGS)) {
      expect(entries.some((e) => e.name === name), name).toBe(false);
      expect(movedToolOf(name)?.movedTo, name).toEqual(ids);
      for (const id of ids) expect(registry.get(id), id).toBeDefined();
    }
  });
  it('every write tool is bound or explicitly allow-listed with a reason', () => {
    expect(entries.length).toBe(74);
    expect(entries.filter((e) => e.command)).toEqual([]);
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
  // plan-764: the allow-listed `web_export_usd` (118 writes / 59 bound / 59 allow-listed).
  // plan-764 Phase 2: the allow-listed `web_import_usd_extras_commit` (119 / 59 / 60);
  // its preview `web_import_usd_extras` is read-only.
  // plan-629: the allow-listed `web_trace_set` (120 / 59 / 61); `web_trace_top` is read-only.
  // plan-621: the three BOUND SolidCraft tools `web_editor_solidcraft_connect` / `_resync` /
  // `_disconnect` (views of `solidcraft.connect` / `.resync` / `.disconnect`; 123 / 62 / 61).
  // plan-641 Phases 0-2: `web_editor_transform` becomes BOUND (view of `editor.transform`),
  // eight new writes are allow-listed (web_execute, web_batch, web_macro_record_start / _stop /
  // _annotate / _save / _replay / _cancel) — 131 / 63 / 68.
  // plan-641 Phases 4-5: the allow-listed `web_macro_assert` (132 / 63 / 69); `web_check_gap`,
  // `web_check_contact` and `web_part_lookup` are read-only.
  // plan-641 Phase 2b: the allow-listed `web_macro_import` (133 / 63 / 70).
  // plan-641 Nachtrag 2026-10-21: `web_knowledge_set` becomes BOUND (view of the macro
  // command `knowledge.set`) — 133 / 64 / 69; `web_document_info_set` BOUND (view of
  // `document.infoSet`, not a macro command) — 133 / 65 / 68; `web_signal_bind` / `_unbind`
  // BOUND (macro commands `signal.bind` / `signal.unbind`) — 133 / 67 / 66; `web_editor_separate`
  // BOUND (macro command `editor.separate`, partial via `skipped`) — 133 / 68 / 65;
  // merged with plan-650 (+2 allow-listed writes) — 135 / 68 / 67.
  // plan-655: the two BOUND library tools `web_library_attach` / `_detach` (views of
  // `library.attach` / `library.detach` — the Add-library dialog and Remove library)
  // — 137 / 70 / 67, allow-list unchanged; `web_library_list` is read-only.
  // plan-773 Phases 1-2: the allow-listed `web_robot_rig_from_library` — 138 / 70 / 68. The other
  // five `web_robot_*` tools are read-only (the rig DIAGNOSIS included: it derives and reports
  // without writing).
  // plan-773 Phase 3: six more allow-listed writes — `web_robot_path_create`, `_target_add`,
  // `_target_set`, `_target_remove`, `_target_reorder`, `_solve_target` — 144 / 70 / 74.
  // `web_robot_path_inspect` is read-only.
  // plan-773 Phase 3 Nachtrag (2026-10-23): all SEVEN of those writes become BOUND — views of
  // `ik.robot.rig` / `ik.path.create` / `ik.target.add` / `_set` / `_remove` / `_reorder` /
  // `_solve` — so the allow-list SHRINKS by seven for the first time since plan-641:
  // 144 / 77 / 67. No tool is added or removed, which is why the write count stays at 144.
  it('Phase 6: 36 writes, no bound tools, 36 allow-listed', () => {
    const writes = entries.filter((e) => e.readOnly === false);
    const bound = writes.filter((e) => e.command);
    // plan-2007 Phase 3: eight more mechanism writes moved to commands (114 / 78 / 36).
    expect(writes.length).toBe(36);
    expect(bound.length).toBe(0);
  // plan-675 (merged onto plan-773): `web_editor_generate_uvs` BOUND (macro command
  // `editor.generateUVs`, partial via `skipped`) — 145 / 78 / 67, allow-list unchanged.
    expect(Object.keys(NO_UI_WRITE_TOOLS).length).toBe(36);
    expect(Object.keys(NO_UI_WRITE_TOOLS).length).toBe(writes.length - bound.length);
    for (const e of bound) expect(NO_UI_WRITE_TOOLS[e.name], e.name).toBeUndefined();
  });

  it('no allow-list entry is a placeholder: every reason is specific (no "not yet migrated")', () => {
    for (const [name, reason] of Object.entries(NO_UI_WRITE_TOOLS)) {
      expect(reason, name).not.toMatch(/not yet migrated|TODO|later/i);
      expect(reason.length, name).toBeGreaterThan(30);
    }
  });

  it('bound tools are writes (or a NAMED read-only view), and every bound command exists eagerly', () => {
    for (const e of entries.filter((x) => x.command)) {
      if (e.readOnly === true) {
        // Not a hole in the gate: `gate()` above still checks this tool's
        // annotations against its descriptor (readOnly must match on BOTH
        // sides), its params, its arity and its args schema. This list only
        // records that a read-only binding was intended, so a second one is an
        // edit someone made on purpose rather than a tool that slipped in with
        // the wrong annotation.
        expect(BOUND_READ_ONLY_TOOLS[e.name]?.trim(), `${e.name} is bound but read-only and not named`).toBeTruthy();
      } else {
        expect(e.readOnly, e.name).toBe(false);
      }
      const ids = typeof e.command === 'string' ? [e.command] : (e.command as BranchBinding).branches.map((b) => b.id);
      for (const id of ids) expect(registry.get(id), `${e.name} → ${id}`).toBeDefined();
    }
  });

  it('every named read-only binding is actually bound (the list cannot carry a stale name)', () => {
    for (const name of Object.keys(BOUND_READ_ONLY_TOOLS)) {
      const e = entries.find((x) => x.name === name);
      expect(e, name).toBeDefined();
      expect(e?.command, name).toBeTruthy();
      expect(e?.readOnly, name).toBe(true);
    }
  });

  it('plan-621: the three SolidCraft tools are 1:1 views of solidcraft.* — editor scope, no undo label of their own', () => {
    const sc = Object.keys(FORMER_BINDINGS).filter((name) => name.startsWith('web_editor_solidcraft_')).map((name) => ({ name, command: movedToolOf(name)!.movedTo[0] }));
    expect(Object.fromEntries(sc.map((e) => [e.name, e.command]))).toEqual({
      web_editor_solidcraft_connect: 'solidcraft.connect',
      web_editor_solidcraft_resync: 'solidcraft.resync',
      web_editor_solidcraft_disconnect: 'solidcraft.disconnect',
    });
    for (const id of ['solidcraft.connect', 'solidcraft.resync', 'solidcraft.disconnect']) {
      const d = registry.get(id)!;
      expect(d.scope, id).toBe('editor');
      expect(d.undoLabel, id).toBeUndefined();
    }
  });

  it('plan-504 / plan-2007: eleven mechanism aliases and eight migrated commands share the registry', () => {
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
    expect(mech).toEqual([]);
    for (const [name, id] of Object.entries(expected)) expect(movedToolOf(name)?.movedTo).toEqual([id]);
    expect(mech.find((e) => e.name === 'web_editor_mechanism_set_anchor')).toBeUndefined();
    // Eleven bindings, the UI-only batch, and eight migrated commands.
    const ids = registry.list().map((d) => d.id).filter((id) => id.startsWith('mechanism.'));
    expect(ids.sort()).toEqual([
      ...Object.values(expected), 'mechanism.addBodies',
      'mechanism.setAnchor', 'mechanism.targetCreate', 'mechanism.pathCreate',
      'mechanism.pathAddWaypoint', 'mechanism.pathRemoveWaypoint', 'mechanism.pathMoveWaypoint',
      'mechanism.trajectoryImport', 'mechanism.trajectoryRun',
      // plan-2007 Phase 4A: the seven read-only mechanism queries (web_query).
      'mechanism.inspect', 'mechanism.forces', 'mechanism.pathInspect', 'mechanism.snapList',
      'mechanism.trajectoryExport', 'mechanism.trajectoryInspect', 'mechanism.validate',
    ].sort());
    expect(registry.get('mechanism.addBodies')?.mcp).toBeUndefined();
    // candidateId is optional on both snap consumers; pickJson is new and optional (additive wire change).
    const snap = registry.get('mechanism.setAnchorSnap')!.mcp!;
    expect(snap.params.find((p) => p.name === 'candidateId')?.required).toBe(false);
    expect(snap.params.find((p) => p.name === 'pickJson')?.required).toBe(false);
    const axis = registry.get('mechanism.setAxis')!.mcp!;
    expect(axis.params.find((p) => p.name === 'candidateId')?.required).toBe(false);
  });

  it('negative controls fail the gate', () => {
    const pivot: GateEntry = {
      name: 'web_editor_pivot', readOnly: false, command: PIVOT_BINDING,
      params: [
        { name: 'path', type: 'string', required: true, description: '' },
        { name: 'mode', type: 'string', required: true, description: '' },
        { name: 'targetPath', type: 'string', required: false, description: '' },
      ],
    };
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
