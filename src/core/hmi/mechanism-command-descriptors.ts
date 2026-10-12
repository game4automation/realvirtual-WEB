// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mechanism-command-descriptors — EAGER descriptors of the rigid-body
 * MECHANISM commands (plan-504).
 *
 * The Quick Edit "Mechanism (Rigid-Body)" section and eleven of the twelve
 * `web_editor_mechanism_*` write tools are views of these commands: one
 * `enabled()` rule per action (tooltip == tool `{error}`), one `run()`, one
 * afterglow target. Open on purpose, exactly like `editor-command-descriptors`:
 * the MCP bridge needs label, button key, args shape and capability before the
 * private editor code is loaded; the implementations come lazily from
 * `@rv-private/plugins/asset-editor/mechanism/mechanism-commands` (community
 * stub: `impls = {}` → `ERR_EDITOR_UNAVAILABLE`).
 *
 * Args ARE the wire args (plan-504 F12): the parity gate compares the MCP
 * mirror and the args shape 1:1 against the decorators, so vectors travel as
 * the same JSON strings the tools take, and the implementation parses them.
 * The one command without a tool is `mechanism.addBodies` (the panel's batch
 * "Add Bodies (n)").
 *
 * Button keys are ROW-exact (`mech.add-body:<path>`, `mech.axis:<path>#<key>`),
 * so with several body or joint rows mounted only the addressed one glows. For
 * actions whose button disappears on success (Add Body, Fix) the key names the
 * surrounding ROW container, which stays and carries the afterglow.
 *
 * Also here, because both open and private code read them: the reason texts,
 * the limits input parser (the panel form and a node test), the forces
 * serialisation shared by `web_editor_mechanism_forces` and `mechanism.statics`,
 * and the row-expander seam the MCP choreography uses to open a collapsed
 * mechanism row before it presses a button inside it.
 */

import {
  commandRegistry,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
} from './rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../editor/rv-editor-guard-core';
import type { MechanismForcesSnapshot } from '../engine/rv-kinematic-registry';

// ─── Reasons (tooltip == tool result; formulated on the ARGS) ────────────

/**
 * The one refusal every mechanism tool gives when the private solver is not
 * loaded. It names the ALTERNATIVE, not just the absence: an agent that reads
 * only "not available" retries three times before giving up, whereas the
 * axis-group system is right there.
 */
export const MECHANISM_UNAVAILABLE =
  'Rigid-body mechanisms are not available in this build (private bundle missing). '
  + 'Axis-group kinematics are available via web_editor_create_kinematic.';
export const NEEDS_NODE = 'Needs an existing node';
export const NEEDS_JOINT = 'Needs a joint component on this node';
export const NEEDS_SOLVED_JOINT = 'Needs a solved joint (rebuild the mechanism first)';
export const NEEDS_BODY = 'Needs a link with a MechanismBody';
export const HAS_BODY_ALREADY = 'This link already has a MechanismBody';
export const NEEDS_DRIVE_NODE = 'Needs a node with a Drive component';
export const NEEDS_MASS_FIELD = 'Pass a density preset, a pinned mass or a centre of mass';
export const LIMITS_ORDER = 'Lower limit must be below the upper limit';
/** A limits field that does not parse as a number (the form's inline error). */
export const LIMITS_NUMBER = 'Enter a number';
export const NEEDS_ALL_BODIES = 'Add a body to every link first';
export const NEEDS_VALID_MASS =
  'Some links have a body without a valid mass — check density or pinned mass';
export const STATICS_INVALID = 'Statics solved, but the result is not valid for these masses';
export const NEEDS_ANCHOR_SOURCE = 'Needs a snap candidate or a picked point';
export const NEEDS_AXIS_SOURCE = 'Needs a snap candidate, a picked axis or a world direction';
export const NO_FIX_FOR_CODE = 'No auto-fix for this finding code';
export const NEEDS_LINKS = 'Needs at least one link';

/** The key of the first joint component on a node — what an omitted componentType means. */
export const DEFAULT_JOINT_KEY = 'KinematicJoint';

// ─── Args (== the @McpParam wire args, name / type / required) ───────────

export interface MechCreateArgs { readonly path: string }
export interface MechAddJointArgs {
  readonly path: string; readonly jointType: string; readonly bodyBPath: string;
  readonly bodyAPath?: string | null; readonly anchorAJson?: string | null;
  readonly anchorBJson?: string | null; readonly axisAJson?: string | null;
}
/** `drivePath` omitted / empty / null = clear (the authored "passive joint" form). */
export interface MechAssignDriveArgs {
  readonly path: string; readonly componentType: string; readonly drivePath?: string | null;
}
export interface MechJogArgs { readonly path: string; readonly value: number; readonly componentType?: string | null }
export interface MechSetAnchorSnapArgs {
  readonly path: string; readonly componentType: string; readonly side: string;
  readonly candidateId?: string | null; readonly assignBody?: boolean | null;
  /** UI pick: `{nodePath, worldPosition:[x,y,z], worldNormal:[x,y,z]}` (see `pickResultToJson`). */
  readonly pickJson?: string | null;
}
export interface MechSetAxisArgs {
  readonly path: string; readonly componentType: string; readonly candidateId?: string | null;
  readonly axisWorldJson?: string | null; readonly secondaryAxisWorldJson?: string | null;
  readonly snapToPrincipal?: boolean | null;
}
export interface MechAddBodyArgs { readonly path: string; readonly densityPreset?: string | null }
export interface MechSetMassArgs {
  readonly path: string; readonly densityPreset?: string | null; readonly densityKgM3?: number | null;
  /** Pinned mass in kg, or "null" to drop the override. */
  readonly massKg?: string | null;
  /** `{x,y,z}` link-local mm as JSON, or "null" to drop the override. */
  readonly comJson?: string | null;
}
export interface MechSetLimitsArgs {
  readonly path: string; readonly componentType: string; readonly useLimits: boolean;
  readonly lower?: number | null; readonly upper?: number | null;
}
export interface MechStaticsArgs { readonly mechanismPath: string }
export interface MechFixArgs { readonly path: string; readonly code: string }
/** UI batch "Add Bodies (n)" — a JSON string array of link paths. No MCP tool. */
export interface MechAddBodiesArgs { readonly pathsJson: string }

// ─── Button keys (row-exact) ────────────────────────────────────────────

const s = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const jointKey = (path: unknown, componentType: unknown): string =>
  `${s(path)}#${s(componentType).trim() || DEFAULT_JOINT_KEY}`;

/** Row container of a link (Add Body lands here — the button itself disappears). */
export const bodyRowKey = (path: string): string => `mech.body-row:${path}`;
/** Row container of a finding (Fix lands here — the row stays 3 s with a success text). */
export const findingRowKey = (jointPath: string, code: string): string => `mech.finding-row:${jointPath}#${code}`;
/** The "Add Bodies (n)" button of one mechanism (UI-only command — the view passes it). */
export const addBodiesKey = (mechanismPath: string): string => `mech.add-bodies:${mechanismPath}`;
export const staticsKey = (mechanismPath: string): string => `mech.statics:${mechanismPath}`;

/** `set_mass` targets ONE control: density → mass → com, in this priority. */
export function setMassButtonKey(a: MechSetMassArgs | undefined): string {
  const path = s(a?.path);
  if (s(a?.densityPreset).trim()) return `mech.density:${path}`;
  if (s(a?.massKg).trim()) return `mech.pin-mass:${path}`;
  if (s(a?.comJson).trim()) return `mech.pin-com:${path}`;
  return `mech.density:${path}`;
}

// ─── Limits input (the panel form; pure, node-tested) ──────────────────

/** Parse a decimal typed with `,` or `.`; null when it is not a finite number. Rounded to 1e-6. */
export function parseDecimalInput(text: string | number | null | undefined): number | null {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text * 1e6) / 1e6 : null;
  const t = s(text).trim().replace(/\s+/g, '');
  if (!t) return null;
  // One decimal separator; a comma is a decimal comma, never a thousands separator.
  if ((t.match(/[.,]/g) ?? []).length > 1) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

export type LimitsInputResult =
  | { readonly ok: true; readonly useLimits: boolean; readonly lower?: number; readonly upper?: number }
  | { readonly ok: false; readonly reason: string; readonly field: 'lower' | 'upper' | 'order' };

/**
 * Validate the limits form. `useLimits=false` ignores the bounds (a switched-off
 * limit is valid whatever the fields say); otherwise both must parse and
 * `lower < upper` ({@link LIMITS_ORDER} — the same text `enabled()` returns).
 */
export function validateLimitsInput(input: {
  readonly useLimits: boolean; readonly lower: string | number | null | undefined; readonly upper: string | number | null | undefined;
}): LimitsInputResult {
  if (!input.useLimits) return { ok: true, useLimits: false };
  const lower = parseDecimalInput(input.lower);
  if (lower === null) return { ok: false, reason: LIMITS_NUMBER, field: 'lower' };
  const upper = parseDecimalInput(input.upper);
  if (upper === null) return { ok: false, reason: LIMITS_NUMBER, field: 'upper' };
  if (lower >= upper) return { ok: false, reason: LIMITS_ORDER, field: 'order' };
  return { ok: true, useLimits: true, lower, upper };
}

// ─── Forces serialisation (web_editor_mechanism_forces + mechanism.statics) ──

/** What the serialisation reads from the force recorder (structural; open plugin). */
export interface ForceRecorderLike {
  readonly recording: boolean;
  metrics(id: string): { peak: number; rms: number; holding: number | null; sampleCount: number };
}

/**
 * One forces snapshot as the tools answer it, with the recorder's sizing
 * figures. `_forces` and `_statics` both answer with this: the only difference
 * between "what did the cycle need" and "what does holding it need" is which
 * evaluation filled the numbers, not what the caller has to parse.
 */
export function mechanismForcesJson(
  snapshot: MechanismForcesSnapshot,
  recorder: ForceRecorderLike,
  opts: { channelId?: string; series?: unknown } = {},
): Record<string, unknown> {
  return {
    ok: true,
    mechanismPath: snapshot.mechanismPath,
    status: snapshot.status,
    statusText: snapshot.statusText,
    dynamicsValid: snapshot.dynamicsValid,
    redundant: snapshot.redundant,
    recording: recorder.recording,
    channels: snapshot.channels.map((c) => {
      const m = recorder.metrics(c.id);
      return {
        id: c.id, label: c.label, kind: c.kind, unit: c.unit, value: c.value,
        peak: m.peak, rms: m.rms, holding: m.holding, sampleCount: m.sampleCount,
        ...(opts.series && c.id === opts.channelId ? { series: opts.series } : {}),
      };
    }),
    joints: snapshot.joints,
  };
}

// ─── Row expander seam (MCP choreography → private section) ─────────────

let rowExpander: ((targetPath: string) => boolean) | null = null;

/**
 * The Mechanism section registers how it opens itself and the mechanism row
 * that contains `targetPath` (a mechanism, joint or link path). Returns the
 * unregister function; a newer registration replaces an older one.
 */
export function registerMechanismRowExpander(fn: (targetPath: string) => boolean): () => void {
  rowExpander = fn;
  return () => { if (rowExpander === fn) rowExpander = null; };
}

/**
 * Open the section and the row owning `targetPath` so the button the
 * choreography is about to press is mounted. False when no section is mounted
 * or no row owns the path. Never throws.
 */
export function expandMechanismRow(targetPath: string): boolean {
  try { return rowExpander ? rowExpander(targetPath) : false; } catch { return false; }
}

// ─── Descriptor table ───────────────────────────────────────────────────

/** Shape of the (private or stub) implementation module. */
export interface MechanismCommandsModule {
  readonly impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>>;
}

export interface MechanismDescriptorOptions {
  /** Module loader — production: the `@rv-private` alias. Tests inject a double. */
  readonly load: () => Promise<MechanismCommandsModule>;
  /** Eager capability — production: `__RV_HAS_PRIVATE__`. */
  readonly available: boolean;
}

type P = CommandMcpMirror['params'][number];
const req = (name: string, type = 'string'): P => ({ name, type, required: true });
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

interface Spec {
  readonly id: string;
  readonly label: string | ((args: never) => string);
  readonly undoLabel?: string | ((args: never) => string);
  /** 'none' for the transient ones (jog, statics): they work outside an authoring document too. */
  readonly scope: 'editor' | 'none';
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly buttonKey: (args: never) => string;
  readonly mcp?: CommandMcpMirror;
}

const SPECS: readonly Spec[] = [
  {
    id: 'mechanism.create', label: 'Add mechanism', undoLabel: 'Create mechanism', scope: 'editor',
    argsSchema: { path: 'string' },
    buttonKey: () => 'mech.create',
    mcp: { tool: 'web_editor_mechanism_create', params: [req('path')] },
  },
  {
    id: 'mechanism.addJoint', label: (a: MechAddJointArgs) => `Add ${s(a?.jointType) || 'joint'} joint`,
    undoLabel: (a: MechAddJointArgs) => `Add ${s(a?.jointType)} joint`, scope: 'editor',
    argsSchema: {
      path: 'string', jointType: 'string', bodyBPath: 'string', bodyAPath: 'string',
      anchorAJson: 'string', anchorBJson: 'string', axisAJson: 'string',
    },
    buttonKey: () => 'mech.add-joint',
    mcp: {
      tool: 'web_editor_mechanism_add_joint',
      params: [req('path'), req('jointType'), req('bodyBPath'), opt('bodyAPath'), opt('anchorAJson'), opt('anchorBJson'), opt('axisAJson')],
    },
  },
  {
    id: 'mechanism.assignDrive',
    label: (a: MechAssignDriveArgs) => (s(a?.drivePath).trim() ? 'Assign drive' : 'Clear drive'),
    undoLabel: (a: MechAssignDriveArgs) => (s(a?.drivePath).trim() ? 'Assign drive to joint' : 'Clear joint drive'),
    scope: 'editor',
    argsSchema: { path: 'string', componentType: 'string', drivePath: 'string' },
    buttonKey: (a: MechAssignDriveArgs) => `mech.assign-drive:${jointKey(a?.path, a?.componentType)}`,
    mcp: { tool: 'web_editor_mechanism_assign_drive', params: [req('path'), req('componentType'), opt('drivePath')] },
  },
  {
    // Transient: a live drive value and one solve — no undo entry.
    id: 'mechanism.jog', label: 'Jog joint', scope: 'none',
    argsSchema: { path: 'string', value: 'number', componentType: 'string' },
    buttonKey: (a: MechJogArgs) => `mech.jog:${jointKey(a?.path, a?.componentType)}`,
    mcp: { tool: 'web_editor_mechanism_jog', params: [req('path'), req('value', 'number'), opt('componentType')] },
  },
  {
    id: 'mechanism.setAnchorSnap',
    label: (a: MechSetAnchorSnapArgs) => `Set anchor ${s(a?.side).trim().toUpperCase() || 'A'}`,
    undoLabel: (a: MechSetAnchorSnapArgs) => `Set anchor ${s(a?.side).trim().toUpperCase()}`,
    scope: 'editor',
    argsSchema: {
      path: 'string', componentType: 'string', side: 'string',
      candidateId: 'string', assignBody: 'boolean', pickJson: 'string',
    },
    buttonKey: (a: MechSetAnchorSnapArgs) =>
      `mech.anchor-${s(a?.side).trim().toLowerCase() || 'a'}:${jointKey(a?.path, a?.componentType)}`,
    mcp: {
      tool: 'web_editor_mechanism_set_anchor_snap',
      params: [req('path'), req('componentType'), req('side'), opt('candidateId'), opt('assignBody', 'boolean'), opt('pickJson')],
    },
  },
  {
    id: 'mechanism.setAxis', label: 'Set joint axis', undoLabel: 'Set joint axis', scope: 'editor',
    argsSchema: {
      path: 'string', componentType: 'string', candidateId: 'string',
      axisWorldJson: 'string', secondaryAxisWorldJson: 'string', snapToPrincipal: 'boolean',
    },
    buttonKey: (a: MechSetAxisArgs) => `mech.axis:${jointKey(a?.path, a?.componentType)}`,
    mcp: {
      tool: 'web_editor_mechanism_set_axis',
      params: [req('path'), req('componentType'), opt('candidateId'), opt('axisWorldJson'), opt('secondaryAxisWorldJson'), opt('snapToPrincipal', 'boolean')],
    },
  },
  {
    id: 'mechanism.addBody', label: 'Add Body', undoLabel: 'Add mechanism body', scope: 'editor',
    argsSchema: { path: 'string', densityPreset: 'string' },
    buttonKey: (a: MechAddBodyArgs) => bodyRowKey(s(a?.path)),
    mcp: { tool: 'web_editor_mechanism_add_body', params: [req('path'), opt('densityPreset')] },
  },
  {
    id: 'mechanism.setMass', label: 'Set body mass', undoLabel: 'Set body mass properties', scope: 'editor',
    argsSchema: { path: 'string', densityPreset: 'string', densityKgM3: 'number', massKg: 'string', comJson: 'string' },
    buttonKey: (a: MechSetMassArgs) => setMassButtonKey(a),
    mcp: {
      tool: 'web_editor_mechanism_set_mass',
      params: [req('path'), opt('densityPreset'), opt('densityKgM3', 'number'), opt('massKg'), opt('comJson')],
    },
  },
  {
    id: 'mechanism.setLimits', label: 'Apply limits',
    undoLabel: (a: MechSetLimitsArgs) => (a?.useLimits ? 'Set joint limits' : 'Disable joint limits'),
    scope: 'editor',
    argsSchema: { path: 'string', componentType: 'string', useLimits: 'boolean', lower: 'number', upper: 'number' },
    buttonKey: (a: MechSetLimitsArgs) => `mech.limits-apply:${jointKey(a?.path, a?.componentType)}`,
    mcp: {
      tool: 'web_editor_mechanism_set_limits',
      params: [req('path'), req('componentType'), req('useLimits', 'boolean'), opt('lower', 'number'), opt('upper', 'number')],
    },
  },
  {
    // Analysis: replaces the holding figures, no pose change, no undo entry.
    id: 'mechanism.statics', label: 'Statics', scope: 'none',
    argsSchema: { mechanismPath: 'string' },
    buttonKey: (a: MechStaticsArgs) => staticsKey(s(a?.mechanismPath)),
    mcp: { tool: 'web_editor_mechanism_statics', params: [req('mechanismPath')] },
  },
  {
    id: 'mechanism.fix', label: (a: MechFixArgs) => `Fix ${s(a?.code)}`,
    undoLabel: (a: MechFixArgs) => `Fix ${s(a?.code)}`, scope: 'editor',
    argsSchema: { path: 'string', code: 'string' },
    buttonKey: (a: MechFixArgs) => findingRowKey(s(a?.path), s(a?.code)),
    mcp: { tool: 'web_editor_mechanism_fix', params: [req('path'), req('code')] },
  },
  {
    // UI-only batch (no tool): one transaction, one undo step for n links.
    id: 'mechanism.addBodies', label: 'Add Bodies', undoLabel: 'Add mechanism bodies', scope: 'editor',
    argsSchema: { pathsJson: 'string' },
    buttonKey: () => 'mech.add-bodies',
  },
];

/** Every mechanism command id (for `preload` on editor activation). */
export const MECHANISM_COMMAND_IDS: readonly string[] = SPECS.map((sp) => sp.id);

/** Build the mechanism descriptors against a module loader (testable seam). */
export function createMechanismCommandDescriptors(opts: MechanismDescriptorOptions): CommandDescriptor<never, unknown>[] {
  const implOf = (id: string) => () =>
    opts.load().then((m) => (m.impls?.[id] ?? null) as CommandImpl<never, unknown> | null);
  return SPECS.map((sp): CommandDescriptor<never, unknown> => ({
    id: sp.id,
    label: sp.label,
    readOnly: false,
    ...(sp.undoLabel ? { undoLabel: sp.undoLabel } : {}),
    scope: sp.scope,
    available: opts.available,
    unavailableReason: ERR_EDITOR_UNAVAILABLE,
    buttonKey: sp.buttonKey,
    ...(sp.mcp ? { mcp: sp.mcp } : {}),
    argsSchema: sp.argsSchema,
    impl: implOf(sp.id),
  }));
}

/** Production loader: the private implementation, or the community stub. */
const loadMechanismCommands = (): Promise<MechanismCommandsModule> =>
  import('@rv-private/plugins/asset-editor/mechanism/mechanism-commands') as Promise<MechanismCommandsModule>;

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the twelve mechanism descriptors. */
export function ensureMechanismCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createMechanismCommandDescriptors({ load: loadMechanismCommands, available: __RV_HAS_PRIVATE__ })) {
    registry.register(d);
  }
}
