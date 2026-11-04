// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-command-descriptors — EAGER descriptors of the asset editor's
 * commands (plan-499).
 *
 * Open on purpose: the MCP bridge needs label, button key, args shape and
 * capability of a command before (and without) the private editor code. The
 * implementations are loaded lazily from
 * `@rv-private/plugins/asset-editor/editor-commands`; in the community build
 * that alias is the stub, whose `impls` is empty, and the build flag
 * `__RV_HAS_PRIVATE__` makes the descriptors unavailable up front.
 *
 * Also here, because both the tool decorators (open) and the parity gate read
 * them: the multiplexer BRANCH TABLES (`web_editor_pivot`, `web_editor_shortcut`,
 * `web_editor_assign_to_kinematic`) and the shared reason texts — the private
 * implementations import the texts from this file, so the tooltip, the tool
 * result and the tests quote one string.
 */

import {
  commandRegistry,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
  type CommandScope,
} from './rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../editor/rv-editor-guard-core';
import { inspectorFieldKey } from './inspector-field-touch';
import { parsePathList as parseSharedPathList } from './rv-path-list';
// The id lives in `problems-store` because a Problems entry's `action` must name it and that store
// is deliberately dependency-free (importing THIS module there would drag the command registry
// into the core bundle). One spelling, imported by both sides.
import {
  SIGNAL_RENAME_COMMAND,
  SIGNAL_RENAME_RECHECK_COMMAND,
  SIGNAL_RENAME_REPAIR_COMMAND,
  SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
} from './problems-store';
import { isMissingWireValue, type BindingBranch, type BranchBinding } from '../engine/rv-mcp-tools';
import { PARAMETRIC_USE_COMMAND, parametricUseImpl } from '../editor/rv-parametric-uses';
// plan-2227: type-only — the implementations (and the component) load on demand.
import type { SignalConnectorCreateBitsArgs, SignalConnectorSetModeArgs } from './signal-connector-commands';

// ─── Reasons (formulated on the ARGS — plan-499 spike finding 4) ─────────

/** A command that needs one target node got none. */
export const NEEDS_TARGET = 'Needs a target object';
/** A command that needs a list of nodes got an empty one. */
export const NEEDS_OBJECTS = 'Needs at least one object';
export const NEEDS_CHILDREN_PIVOT = 'Needs child objects (pivot moves, children stay in place)';
export const NEEDS_CHILDREN_ALIGN = 'Needs child objects (orientation changes, children stay in place)';
export const OWN_MESH_PIVOT = 'The object itself has a mesh — moving its pivot would move the geometry';
export const OWN_MESH_ALIGN = 'The object itself has a mesh — re-orienting its pivot would move the geometry';
export const NOT_FOR_LOGIC_STEP = 'Not available for LogicStep objects';
export const NOT_ON_LOGIC_STEP = 'Not available on a LogicStep object';
export const NEEDS_KINEMATIC_NAME = 'Needs a kinematic name';
export const NEEDS_GROUP_MEMBERS = 'Needs a kinematic axis whose group has members';
export const NEEDS_TARGET_OBJECT = 'Needs a second object to take the pivot from';
export const CIRCLE_INVALID = 'Needs a circle: worldCenter and a non-zero worldAxis, three numbers each';
export const AXIS_INVALID = 'axis must be x|y|z';
export const EMPTY_NAME = 'Empty name';
/** Refusal shown for every structural verb aimed at the GLB root (plan-715 F4). */
export const MODEL_ROOT_LOCKED =
  'The model root is locked: it cannot be renamed, transformed, hidden, deleted or reparented '
  + '(its name is the first segment of every node path and its pose is the asset origin). '
  + 'Edit its components/metadata instead, or target a child node.';
/** In-place test run owns the scene (plan-410 / plan-462 B3). */
export const ERR_TEST_RUN_ACTIVE =
  'A test run is active (in-place test session): edits made now are rolled back '
  + 'together with the test scene when the run stops, so they would be lost silently. '
  + 'Stop the test run first, then repeat the edit.';
/** Material assignment without paths and without a selection. */
export const NO_PATHS_NO_SELECTION =
  'No paths given and nothing selected — select objects first';
/** A selection-driven shortcut (S>I, H, Delete…) with nothing selected. */
export const NOTHING_SELECTED = 'Nothing selected — select first (web_select)';
/** Quick Edit "Signals": a new signal hangs under a PLAIN object (plan-499 Phase 4). */
export const SIGNAL_NEEDS_PLAIN_PARENT = 'Signals attach to plain objects (no Drive / Kinematic / LogicStep)';
/** Convert / flip act on a signal node. */
export const NEEDS_SIGNAL_OBJECT = 'Needs a signal object';
export const SIGNAL_ALREADY_TYPE = 'Already this datatype';
export const SIGNAL_TARGET_INVALID = 'target must be Bool | Int | Float';
/**
 * plan-589 F5 / plan-590 — why `editor.signalSetField` refuses `Name`.
 *
 * The SignalStore registration, every model binding and every CONNECT entry couple by the signal
 * name, so changing it is a refactoring across all three, not a field write: `editor.signalRename`
 * (plan-590) plans it, previews it and carries every reference along.
 */
export const SIGNAL_NAME_READONLY =
  'The name is not a plain field — rename the signal with editor.signalRename, '
  + 'which updates every reference';
export { SIGNAL_RENAME_COMMAND, SIGNAL_RENAME_RECHECK_COMMAND, SIGNAL_RENAME_REPAIR_COMMAND };
/** plan-590 — another rename (or its undo / redo) is running. */
export const SIGNAL_RENAME_BUSY = 'Another signal rename is running';
/** plan-590 — a rename whose CONNECT outcome is unknown locks further renames until re-checked. */
export const SIGNAL_RENAME_LOCKED =
  'A previous signal rename has an unknown CONNECT outcome — re-check it in Problems first';
/** plan-590 — repair / re-check name a journal entry this session does not know. */
export function signalRenameJournalUnknown(journalId: string): string {
  return `No signal rename with journal id "${journalId}" in this session`;
}
/** plan-589 — the fields `editor.signalSetField` may write. `Name` is deliberately absent. */
export const SIGNAL_EDITABLE_FIELDS = ['Comment', 'OriginDataType', 'Type'] as const;
/** Quick Edit "Logic Steps": the lone starter vs. the step palette. */
export const LOGIC_STEP_NEEDS_PLAIN = 'Only on a plain object (no components yet)';
export const LOGIC_STEP_NEEDS_CONTAINER = 'Add these inside a LogicSteps Container';
/** The six creatable signal component types. */
export const SIGNAL_CREATE_TYPES: readonly string[] = [
  'PLCOutputBool', 'PLCOutputInt', 'PLCOutputFloat', 'PLCInputBool', 'PLCInputInt', 'PLCInputFloat',
];

/** `Node not found: <path>` — shared text. */
export function nodeNotFound(path: string): string {
  return `Node not found: ${path}`;
}

// ─── Args ───────────────────────────────────────────────────────────────

/** Paths as a command receives them: the wire's separated string, a list (views), or null = "use the selection". */
export type PathsArg = string | readonly string[] | null | undefined;

/**
 * Normalise a {@link PathsArg} — THE shared rule of `rv-path-list.ts`: a list, a
 * JSON array string (for names containing commas; invalid JSON throws), else the
 * legacy split (newline input keeps commas literal, single-line input also splits
 * on `,` and `;`).
 */
export function parsePathList(arg: PathsArg): string[] {
  return parseSharedPathList(arg);
}

export interface PathArgs { readonly path: string | null | undefined }
/** plan-661: add a `WebPhysicsZone2D` (with its BoxCollider) to a node. */
export const PHYSICS_ZONE2D_ADD_COMMAND = 'physicszone2d.add';
/** plan-661: set the node references (Surface / Guides / KinematicDrives) of a 2D zone. */
export const PHYSICS_ZONE2D_SET_REFERENCES_COMMAND = 'physicszone2d.setReferences';
export interface PhysicsZone2DAddArgs {
  readonly path: string | null | undefined;
  /** Jam | BufferTable | Diverter | Merge (default Jam). */
  readonly kind?: string | null;
  readonly propsJson?: string | null;
}
export interface PhysicsZone2DSetReferencesArgs {
  readonly path: string | null | undefined;
  /** Node path of the discharge surface; '' clears it, absent keeps it. */
  readonly surface?: string | null;
  /** Guide rail node paths; empty clears, absent keeps. */
  readonly guides?: PathsArg;
  /** Switch drive node paths; empty clears, absent keeps. */
  readonly kinematicDrives?: PathsArg;
}
export interface PathsArgs { readonly paths: PathsArg }
export interface Rotate90Args { readonly path: string | null | undefined; readonly axis: string; readonly sign?: number | null }
export interface PivotToObjectArgs { readonly path: string | null | undefined; readonly targetPath: string | null | undefined }
/** The circle in WORLD space — a picked circle usually lies on a baked chunk without a node path. */
export interface PivotToCircleArgs {
  readonly path: string | null | undefined;
  readonly worldCenter: readonly number[] | null | undefined;
  readonly worldAxis: readonly number[] | null | undefined;
}
/**
 * plan-641 — `editor.transform`: a node's LOCAL TRS, partial. Position in metres, rotation
 * in degrees (XYZ Euler), scale; an omitted (null) component keeps its current value.
 */
export interface TransformArgs {
  readonly path: string | null | undefined;
  readonly px?: number | null; readonly py?: number | null; readonly pz?: number | null;
  readonly rx?: number | null; readonly ry?: number | null; readonly rz?: number | null;
  readonly sx?: number | null; readonly sy?: number | null; readonly sz?: number | null;
}
export interface RenameArgs { readonly path: string | null | undefined; readonly name: string }
export interface SetVisibleArgs { readonly paths: PathsArg; readonly visible: boolean }
export interface CreateEmptyArgs { readonly parentPath?: string | null; readonly name?: string | null }
export interface ReparentArgs { readonly paths: PathsArg; readonly newParentPath?: string | null }
/**
 * plan-641 Phase 3 — `editor.clone`: deep copy of the subtree at `path`. `parentPath` omitted =
 * next to the source (its parent), `''` = the asset root; `name` omitted = the source's name
 * (deduped `_N`). The new path comes back in `created`.
 */
export interface CloneArgs { readonly path: string | null | undefined; readonly name?: string | null; readonly parentPath?: string | null }
/** plan-641 Phase 3 — `editor.reorder`: put `path` at sibling slot `index` (0 = first) under its parent. */
export interface ReorderArgs { readonly path: string | null | undefined; readonly index: number }
/**
 * plan-641 Phase 3 — `editor.materialDefine`: a NAMED free PBR material (hex colour, roughness,
 * metalness, opacity 0..1) applied to every mesh under `paths` (omitted = the selection).
 */
export interface MaterialDefineArgs {
  readonly name: string | null | undefined; readonly color: string | null | undefined;
  readonly roughness?: number | null; readonly metalness?: number | null; readonly opacity?: number | null;
  readonly paths?: PathsArg;
}
export interface AddComponentArgs { readonly path: string | null | undefined; readonly type: string; readonly propsJson?: string | null }
export interface RemoveComponentArgs { readonly path: string | null | undefined; readonly componentType: string }
export interface SetFieldArgs {
  readonly path: string | null | undefined; readonly componentType: string;
  readonly fieldName: string; readonly valueJson: string;
}
export interface CreateKinematicArgs { readonly name?: string | null }
export interface AssignToKinematicArgs {
  readonly name: string | null | undefined;
  readonly paths: PathsArg;
  /** true = the tool semantics (the kinematic must exist); false = the K picker (creates it when new). */
  readonly requireExisting: boolean;
}
/** plan-760 F13 — the four plain-group verbs (names are RESOLVED group names). */
export interface GroupAssignArgs { readonly name: string | null | undefined; readonly paths?: PathsArg }
export interface GroupRemoveArgs { readonly name: string | null | undefined; readonly paths?: PathsArg }
export interface GroupRenameArgs { readonly name: string | null | undefined; readonly newName: string | null | undefined }
export interface GroupDissolveArgs { readonly name: string | null | undefined }
export interface AssignMaterialArgs {
  readonly paths?: PathsArg; readonly presetId?: string | null; readonly color?: string | null;
  readonly metalness?: number | null; readonly roughness?: number | null; readonly opacity?: number | null;
}
export interface MaterializeArgs { readonly assignmentsJson?: string | null }
export interface AddSignalArgs { readonly parentPath: string | null | undefined; readonly sigType: string; readonly name?: string | null }
export interface ConvertSignalArgs { readonly path: string | null | undefined; readonly target: string }
/**
 * plan-589 F3 — edit ONE field of a PLC signal node. `Name` is rejected on purpose: the model, the
 * bindings and the CONNECT entries all couple by it, so changing it is a refactoring (plan-590), not
 * a field write. The name is set when the signal is created (`editor.addSignal`).
 */
export interface SignalSetFieldArgs {
  readonly path: string | null | undefined;
  readonly field: string;
  readonly value?: string | null;
}
/**
 * plan-589 F4 — set, change or remove the PLC binding of a model signal on ONE interface (for MQTT:
 * in one topic). Single-signal, single-interface by design; atomic multi-writes are plan-590.
 */
export interface SignalSetBindingArgs {
  readonly name: string | null | undefined;
  readonly interfaceId: string | null | undefined;
  readonly topic?: string | null;
  readonly protocolAddress?: string | null;
  readonly dataType?: string | null;
  readonly remove?: boolean | null;
}
/**
 * plan-589 F7 — create model signals for the `plc-only` rows of one interface.
 *
 * `names` empty / absent means "every creatable `plc-only` row of this interface", which is what
 * the Problems action and the panel button dispatch. The CONNECT name is taken VERBATIM as the new
 * signal's `Name`: authored signals stay raw, so the authored runtime name IS the local name and
 * `Cell.Start` must come out as exactly `mapped` afterwards — no scope is added and none is
 * stripped. Types the model cannot register (CONNECT Text/String) are reported as unsupported and
 * not created.
 */
export interface SignalsCreateFromInterfaceArgs {
  readonly interfaceId: string | null | undefined;
  /** Parent node the new signal components hang under; null = the current selection. */
  readonly parentPath?: string | null;
  /** The CONNECT names to create; a list or the wire's separated string ({@link parsePathList}). */
  readonly names?: PathsArg;
}
/**
 * plan-590 F10 — rename the PLC signal at `path` to `newName` across the model, the scene overlay,
 * planner bindings, the historian selection and CONNECT. `dryRun` returns the preview and changes
 * nothing; a rename with wire effects (a name that travels on the wire) needs `confirmWireChange`.
 */
export interface SignalRenameArgs {
  readonly path: string | null | undefined;
  readonly newName: string | null | undefined;
  readonly dryRun?: boolean | null;
  readonly confirmWireChange?: boolean | null;
}
/** plan-590 F7 — the journal entry a Problems action (repair / re-check) acts on. */
export interface SignalRenameJournalArgs { readonly journalId: string | null | undefined }
export interface AddLogicStepArgs { readonly path: string | null | undefined; readonly stepType: string }
export interface CountArgs { readonly count?: number | null }
export interface SeedsArgs { readonly seeds: readonly string[] | null }
export interface SelectedArgs { readonly selected: readonly string[] | null }
/** `on` omitted / null = flip the current state (the key press); a boolean sets it. */
export interface WireframeArgs { readonly on?: boolean | null }
/** Same shape as {@link WireframeArgs}: omitted / null flips, a boolean sets (plan-766 F3). */
export interface TransformToolArgs { readonly on?: boolean | null }

/** plan-766 F3 — the transform-tool toggle's command id (T key, toolbar, web_editor_shortcut). */
export const TOGGLE_TRANSFORM_TOOL_COMMAND = 'editor.toggleTransformTool';

// ─── Module shape ───────────────────────────────────────────────────────

/** Shape of the (private or stub) implementation module. */
export interface EditorCommandsModule {
  readonly impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>>;
}

export interface EditorDescriptorOptions {
  /** Module loader — production: the `@rv-private` alias. Tests inject the stub. */
  readonly load: () => Promise<EditorCommandsModule>;
  /** Eager capability — production: `__RV_HAS_PRIVATE__`. */
  readonly available: boolean;
}

// ─── Descriptor table ───────────────────────────────────────────────────

/**
 * plan-760 F13 — the group verbs' command ids, exported so the tool
 * decorators bind by constant (same convention as `ASSIGN_TO_KINEMATIC_BINDING`
 * for the multiplexers: one spelling, in one place).
 */
export const GROUP_ASSIGN_COMMAND = 'editor.groupAssign';
export const GROUP_REMOVE_COMMAND = 'editor.groupRemove';
export const GROUP_RENAME_COMMAND = 'editor.groupRename';
export const GROUP_DISSOLVE_COMMAND = 'editor.groupDissolve';

type P = CommandMcpMirror['params'][number];
const req = (name: string, type = 'string'): P => ({ name, type, required: true });
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

interface Spec {
  readonly id: string;
  readonly timeoutMs?: number;
  readonly lazyImpl?: () => Promise<CommandImpl<never, unknown>>;
  readonly toolClass?: CommandDescriptor['toolClass'];
  readonly label: string | ((args: never) => string);
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly buttonKey?: (args: never) => string;
  readonly undoLabel?: string;
  readonly shortcut?: string;
  readonly mcp?: CommandMcpMirror;
  /** Open inline implementation (no private code needed). */
  readonly openImpl?: CommandImpl<never, unknown>;
  /**
   * plan-641 — the command changes the model: an MCP call of it becomes a macro line.
   * The implementation must provide `resolveArgs` (M4) and resolve after the change (M8).
   */
  readonly macro?: boolean;
  /**
   * Document gate. Default `'editor'`. `'none'` for a command that also runs outside the asset
   * editor and resolves its document itself (the signal rename writes to the scene there).
   */
  readonly scope?: CommandScope;
}

const lower = (v: unknown): string => String(v ?? '').toLowerCase();

const SPECS: readonly Spec[] = [
  {
    id: 'editor.kinematize', label: 'Kinematize', undoLabel: 'Kinematize', macro: true, timeoutMs: 60_000,
    argsSchema: { paths: 'string', groupName: 'string', direction: 'string', speed: 'number', lowerLimit: 'number', upperLimit: 'number', startPosition: 'number', centerPivot: 'boolean' },
    lazyImpl: async () => (await import('../../plugins/mcp-bridge/rv-mcp-editor-tools')).editorKinematizeImpl as CommandImpl<never, unknown>,
  },
  {
    id: 'editor.importGlb', label: 'Import GLB', undoLabel: 'Import GLB', macro: true, timeoutMs: 120_000,
    argsSchema: { relPath: 'string' },
    lazyImpl: async () => (await import('../../plugins/mcp-bridge/rv-mcp-editor-tools')).editorImportGlbImpl as CommandImpl<never, unknown>,
  },
  {
    id: 'editor.importCad', label: 'Import CAD', undoLabel: 'Import CAD', macro: true, timeoutMs: 600_000,
    argsSchema: { relPath: 'string', quality: 'string' },
    lazyImpl: async () => (await import('../../plugins/mcp-bridge/rv-mcp-editor-tools')).editorImportCadImpl as CommandImpl<never, unknown>,
  },
  // ── Transform ──
  {
    // plan-641: the field input of the Transform section as ONE command, so an agent's
    // matrix edit is a macro line like every other model change.
    id: 'editor.transform', macro: true, label: 'Set transform', undoLabel: 'Set transform',
    argsSchema: {
      path: 'string', px: 'number', py: 'number', pz: 'number',
      rx: 'number', ry: 'number', rz: 'number', sx: 'number', sy: 'number', sz: 'number',
    },
    mcp: {
      tool: 'web_editor_transform',
      params: [
        req('path'), opt('px', 'number'), opt('py', 'number'), opt('pz', 'number'),
        opt('rx', 'number'), opt('ry', 'number'), opt('rz', 'number'),
        opt('sx', 'number'), opt('sy', 'number'), opt('sz', 'number'),
      ],
    },
  },
  {
    id: 'editor.zeroPosition', macro: true, label: 'Zero Position', argsSchema: { paths: 'string' },
    buttonKey: () => 'qe.zero-position',
    mcp: { tool: 'web_editor_zero_position', params: [req('paths')] },
  },
  {
    id: 'editor.rotate90', macro: true, label: (a: Rotate90Args) => `Rotate ${String(a?.axis ?? '').toUpperCase()}`,
    argsSchema: { path: 'string', axis: 'string', sign: 'number' },
    buttonKey: (a: Rotate90Args) => `qe.rotate-${lower(a?.axis)}`,
    mcp: { tool: 'web_editor_rotate90', params: [req('path'), req('axis'), opt('sign', 'integer')] },
  },
  {
    id: 'editor.toGround', macro: true, label: 'To Ground', argsSchema: { path: 'string' },
    buttonKey: () => 'qe.to-ground',
    mcp: { tool: 'web_editor_to_ground', params: [req('path')] },
  },
  { id: 'editor.pivotToBottom', macro: true, label: 'Pivot to Bottom', argsSchema: { path: 'string' }, buttonKey: () => 'qe.pivot-bottom' },
  {
    id: 'editor.pivotToObjectCenter', macro: true, label: 'Pivot to Object', argsSchema: { path: 'string', targetPath: 'string' },
    buttonKey: () => 'qe.pivot-to-object',
  },
  {
    // UI-only (no tool, like `mechanism.addBodies`): the Quick Edit button
    // starts the circle pick, whose commit dispatches with the circle.
    id: 'editor.pivotToCircle', macro: true, label: 'Pivot to Circle', undoLabel: 'Pivot to circle',
    argsSchema: { path: 'string', worldCenter: 'number[]', worldAxis: 'number[]' },
    buttonKey: () => 'qe.pivot-to-circle',
  },
  { id: 'editor.centerKinematicToGroup', macro: true, label: 'Center to Group', argsSchema: { path: 'string' } },
  { id: 'editor.alignYUp', macro: true, label: 'Align Y Up', argsSchema: { path: 'string' }, buttonKey: () => 'qe.align-y-up' },

  // ── Structure ──
  {
    id: 'editor.rename', macro: true, label: 'Rename', argsSchema: { path: 'string', name: 'string' },
    mcp: { tool: 'web_editor_rename', params: [req('path'), req('name')] },
  },
  {
    id: 'editor.delete', macro: true, label: 'Delete', argsSchema: { paths: 'string' }, shortcut: 'Delete',
    mcp: { tool: 'web_editor_delete', params: [req('paths')] },
  },
  {
    id: 'editor.setVisible', macro: true, label: (a: SetVisibleArgs) => (a?.visible === false ? 'Hide' : 'Show'),
    argsSchema: { paths: 'string', visible: 'boolean' },
    mcp: { tool: 'web_editor_set_visible', params: [req('paths'), req('visible', 'boolean')] },
  },
  { id: 'editor.hide', macro: true, label: 'Hide', argsSchema: { paths: 'string[]' }, shortcut: 'H' },
  { id: 'editor.show', macro: true, label: 'Show', argsSchema: { paths: 'string[]' }, shortcut: 'Shift+H' },
  {
    id: 'editor.createEmpty', macro: true, label: (a: CreateEmptyArgs) => (a?.parentPath ? 'Empty Child' : 'Empty at Root'),
    argsSchema: { parentPath: 'string', name: 'string' },
    buttonKey: (a: CreateEmptyArgs) => (a?.parentPath ? 'qe.empty-child' : 'qe.empty-root'),
    mcp: { tool: 'web_editor_create_empty', params: [opt('parentPath'), opt('name')] },
  },
  {
    id: 'editor.groupIntoEmpty', macro: true, label: 'Group into Empty', argsSchema: { paths: 'string[]' },
    buttonKey: () => 'qe.group-into-empty',
  },
  {
    id: 'editor.reparent', macro: true, label: 'Reparent', argsSchema: { paths: 'string', newParentPath: 'string' },
    mcp: { tool: 'web_editor_reparent', params: [req('paths'), opt('newParentPath')] },
  },
  // plan-641 Phase 3: registry-only (reached via web_execute / web_batch — no new MCP tool).
  {
    id: 'editor.clone', macro: true, label: 'Clone', argsSchema: { path: 'string', name: 'string', parentPath: 'string' },
  },
  {
    id: 'editor.reorder', macro: true, label: 'Reorder', argsSchema: { path: 'string', index: 'number' },
  },

  // ── Components / kinematics ──
  {
    id: 'editor.addComponent', macro: true, label: (a: AddComponentArgs) => `Add ${a?.type ?? 'component'}`,
    argsSchema: { path: 'string', type: 'string', propsJson: 'string' },
    buttonKey: (a: AddComponentArgs) => `qe.add-${lower(a?.type)}`,
    mcp: { tool: 'web_editor_add_component', params: [req('path'), req('type'), opt('propsJson')] },
  },
  {
    id: PHYSICS_ZONE2D_ADD_COMMAND, macro: true,
    label: (a: PhysicsZone2DAddArgs) => `Add 2D Physics Zone${a?.kind ? ` (${a.kind})` : ''}`,
    undoLabel: 'Add 2D Physics Zone',
    argsSchema: { path: 'string', kind: 'string', propsJson: 'string' },
  },
  {
    id: PHYSICS_ZONE2D_SET_REFERENCES_COMMAND, macro: true, label: 'Set 2D Physics Zone references',
    undoLabel: 'Set 2D Physics Zone references',
    argsSchema: { path: 'string', surface: 'string', guides: 'string[]', kinematicDrives: 'string[]' },
  },
  {
    id: 'editor.removeComponent', macro: true, label: 'Remove component', argsSchema: { path: 'string', componentType: 'string' },
    mcp: { tool: 'web_editor_remove_component', params: [req('path'), req('componentType')] },
  },
  {
    id: 'editor.setField', macro: true, label: 'Set field',
    argsSchema: { path: 'string', componentType: 'string', fieldName: 'string', valueJson: 'string' },
    // The Inspector row of the field IS the button (inspector-field-touch.ts):
    // the MCP choreography hovers/presses it and leaves the afterglow on it.
    buttonKey: (a: SetFieldArgs) => inspectorFieldKey(String(a?.path ?? ''), String(a?.componentType ?? ''), String(a?.fieldName ?? '')),
    mcp: {
      tool: 'web_editor_set_field',
      params: [req('path'), req('componentType'), req('fieldName'), req('valueJson')],
    },
  },
  // ── Signals / Logic Steps (Quick Edit; plan-499 Phase 4) ──
  {
    id: 'editor.addSignal', macro: true, label: (a: AddSignalArgs) => `Add ${a?.sigType ?? 'signal'}`,
    argsSchema: { parentPath: 'string', sigType: 'string', name: 'string' },
    buttonKey: (a: AddSignalArgs) => `qe.signal-${String(a?.sigType ?? '')}`,
    mcp: { tool: 'web_editor_add_signal', params: [req('parentPath'), req('sigType'), opt('name')] },
  },
  {
    id: 'editor.convertSignal', macro: true, label: (a: ConvertSignalArgs) => `To ${a?.target ?? ''}`,
    argsSchema: { path: 'string', target: 'string' },
    buttonKey: (a: ConvertSignalArgs) => `qe.signal-to-${lower(a?.target)}`,
    mcp: { tool: 'web_editor_convert_signal', params: [req('path'), req('target')] },
  },
  {
    id: 'editor.toggleSignalDirection', macro: true, label: 'Flip signal direction', argsSchema: { path: 'string' },
    buttonKey: () => 'qe.signal-flip',
    mcp: { tool: 'web_editor_toggle_signal_direction', params: [req('path')] },
  },
  {
    id: 'editor.signalSetField', macro: true,
    label: (a: SignalSetFieldArgs) => `Set signal ${a?.field ?? 'field'}`,
    undoLabel: 'Edit signal',
    argsSchema: { path: 'string', field: 'string', value: 'string' },
    // The Inspector row of the field IS the button (same convention as `editor.setField`).
    buttonKey: (a: SignalSetFieldArgs) =>
      inspectorFieldKey(String(a?.path ?? ''), 'Signal', String(a?.field ?? '')),
    mcp: {
      tool: 'web_editor_signal_set_field',
      params: [req('path'), req('field'), opt('value')],
    },
  },
  // plan-641: deliberately NOT `macro: true` — the binding lives in CONNECT, not in the
  // document's op log, so a recorded line would always classify `noop` and never replay.
  {
    id: 'editor.signalSetBinding',
    toolClass: 'signal',
    label: (a: SignalSetBindingArgs) => (a?.remove ? 'Remove PLC binding' : 'Set PLC binding'),
    argsSchema: {
      name: 'string', interfaceId: 'string', topic: 'string',
      protocolAddress: 'string', dataType: 'string', remove: 'boolean',
    },
    mcp: {
      tool: 'web_editor_signal_set_binding',
      params: [
        req('name'), req('interfaceId'), opt('topic'),
        opt('protocolAddress'), opt('dataType'), opt('remove', 'boolean'),
      ],
    },
  },
  {
    id: SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
    macro: true,
    label: 'Create model signals',
    undoLabel: 'Create model signals',
    // `names` follows the `paths` convention: a list in the UI, a separated string on the wire.
    argsSchema: { interfaceId: 'string', parentPath: 'string', names: 'string' },
    buttonKey: () => 'connect.signals-create-from-interface',
    mcp: {
      tool: 'web_editor_signals_create_from_interface',
      params: [req('interfaceId'), opt('parentPath'), opt('names')],
    },
  },
  // ── plan-590: signal rename (Inspector "Signal" name field, Problems actions) ──
  // scope 'none': a rename runs in the asset editor (AssetDocument) AND in the scene (SceneStore);
  // the implementation resolves the document through `signalRenameEnvironmentFor`.
  {
    id: SIGNAL_RENAME_COMMAND,
    macro: true,
    label: (a: SignalRenameArgs) => (a?.dryRun ? 'Preview signal rename' : 'Rename signal'),
    undoLabel: 'Rename signal',
    scope: 'none',
    argsSchema: { path: 'string', newName: 'string', dryRun: 'boolean', confirmWireChange: 'boolean' },
    buttonKey: (a: SignalRenameArgs) => `signal.rename:${String(a?.path ?? '')}`,
    mcp: {
      tool: 'web_editor_signal_rename',
      params: [req('path'), req('newName'), opt('dryRun', 'boolean'), opt('confirmWireChange', 'boolean')],
    },
  },
  {
    id: SIGNAL_RENAME_REPAIR_COMMAND, label: 'Repair signal rename', scope: 'none',
    argsSchema: { journalId: 'string' },
    mcp: { tool: 'web_editor_signal_rename_repair', params: [req('journalId')] },
  },
  {
    id: SIGNAL_RENAME_RECHECK_COMMAND, label: 'Re-check signal rename', scope: 'none',
    argsSchema: { journalId: 'string' },
    mcp: { tool: 'web_editor_signal_rename_recheck', params: [req('journalId')] },
  },
  {
    id: 'editor.addLogicStep', macro: true, label: (a: AddLogicStepArgs) => `Add ${String(a?.stepType ?? 'LogicStep').replace('LogicStep_', '')}`,
    argsSchema: { path: 'string', stepType: 'string' },
    buttonKey: (a: AddLogicStepArgs) => `qe.logic-${String(a?.stepType ?? '')}`,
    mcp: { tool: 'web_editor_add_logic_step', params: [req('path'), req('stepType')] },
  },
  {
    id: 'editor.createKinematic', macro: true, label: 'Add Kinematic', argsSchema: { name: 'string' },
    buttonKey: () => 'qe.add-kinematic',
    mcp: { tool: 'web_editor_create_kinematic', params: [opt('name')] },
  },
  {
    id: 'editor.assignToKinematic', macro: true, label: 'Assign to Kinematic', shortcut: 'K',
    argsSchema: { name: 'string', paths: 'string[]', requireExisting: 'boolean' },
  },

  // ── Groups (Quick Edit Groups section; plan-760 F13) ──
  {
    id: GROUP_ASSIGN_COMMAND, macro: true, label: 'Add to Group', argsSchema: { name: 'string', paths: 'string' },
    buttonKey: () => 'qe.group-assign',
    mcp: { tool: 'web_editor_group_assign', params: [req('name'), opt('paths')] },
  },
  {
    id: GROUP_REMOVE_COMMAND, macro: true, label: 'Remove from Group', argsSchema: { name: 'string', paths: 'string' },
    buttonKey: () => 'qe.group-remove',
    mcp: { tool: 'web_editor_group_remove', params: [req('name'), opt('paths')] },
  },
  {
    id: GROUP_RENAME_COMMAND, macro: true, label: 'Rename Group', argsSchema: { name: 'string', newName: 'string' },
    buttonKey: () => 'qe.group-rename',
    mcp: { tool: 'web_editor_group_rename', params: [req('name'), req('newName')] },
  },
  {
    id: GROUP_DISSOLVE_COMMAND, macro: true, label: 'Dissolve Group', argsSchema: { name: 'string' },
    buttonKey: () => 'qe.group-dissolve',
    mcp: { tool: 'web_editor_group_dissolve', params: [req('name')] },
  },

  // ── Materials ──
  {
    id: 'editor.assignMaterial', macro: true, label: 'Assign material',
    argsSchema: {
      paths: 'string', presetId: 'string', color: 'string',
      metalness: 'number', roughness: 'number', opacity: 'number',
    },
    buttonKey: (a: AssignMaterialArgs) => (a?.presetId ? `mat.preset-${a.presetId}` : 'mat.assign'),
    mcp: {
      tool: 'web_editor_assign_material',
      params: [
        opt('paths'), opt('presetId'), opt('color'),
        opt('metalness', 'number'), opt('roughness', 'number'), opt('opacity', 'number'),
      ],
    },
  },
  {
    id: 'editor.materialize', macro: true, label: 'Materialize', argsSchema: { assignmentsJson: 'string' },
    mcp: { tool: 'web_editor_materialize', params: [opt('assignmentsJson')] },
  },
  // plan-641 Phase 3: registry-only (reached via web_execute / web_batch — no new MCP tool).
  {
    id: 'editor.materialDefine', macro: true, label: (a: MaterialDefineArgs) => `Material ${a?.name ?? ''}`.trim(),
    argsSchema: {
      name: 'string', color: 'string', roughness: 'number', metalness: 'number', opacity: 'number', paths: 'string',
    },
  },

  // ── History / selection ──
  {
    id: 'editor.undo', label: 'Undo', argsSchema: { count: 'number' }, shortcut: 'Ctrl+Z',
    mcp: { tool: 'web_editor_undo', params: [opt('count', 'integer')] },
  },
  {
    id: 'editor.redo', label: 'Redo', argsSchema: { count: 'number' }, shortcut: 'Ctrl+Y',
    mcp: { tool: 'web_editor_redo', params: [opt('count', 'integer')] },
  },
  {
    id: 'selection.clear', label: 'Clear selection', argsSchema: {}, shortcut: 'Escape',
    // Nothing private about clearing a selection — the implementation is open.
    openImpl: {
      enabled: () => true,
      run: (ctx) => {
        ctx.viewer.selectionManager.clear();
        return { selected: 0 };
      },
    },
  },
  {
    // View state, not a document edit: no op, no undo. The swap itself is open
    // viewer code (rv-wireframe-view.ts), so the implementation is too.
    id: 'editor.wireframe', label: 'Wireframe', argsSchema: { on: 'boolean' }, shortcut: 'Shift+Z',
    buttonKey: () => 'editor.wireframe',
    openImpl: {
      enabled: () => true,
      run: (ctx, args: WireframeArgs) => {
        const on = typeof args?.on === 'boolean' ? args.on : !ctx.viewer.wireframe;
        ctx.viewer.wireframe = on;
        return { wireframe: on };
      },
    } as CommandImpl<never, unknown>,
  },
  {
    // plan-766 F3: arms / disarms the transform gizmo. A tool state, not a
    // document edit: no op, no undo. The store is private editor code, so the
    // implementation lives in the private `editor-commands`.
    id: TOGGLE_TRANSFORM_TOOL_COMMAND, label: 'Transform Tool', argsSchema: { on: 'boolean' }, shortcut: 'T',
    buttonKey: () => 'editor.transform-tool',
  },
  {
    // plan-650 Phase 5b: declared child families of a parametric family (Uses),
    // one undo step incl. the regenerate. Registry-only (web_execute), open impl.
    id: PARAMETRIC_USE_COMMAND, macro: true, label: (a: { remove?: boolean | null }) => (a?.remove ? 'Remove child family' : 'Use child family'),
    undoLabel: 'Change child families',
    argsSchema: { path: 'string', family: 'string', glbUrl: 'string', familyNodeId: 'string', docHash: 'string', assetPath: 'string', remove: 'boolean' },
    openImpl: parametricUseImpl as CommandImpl<never, unknown>,
  },
  {
    // plan-2227: Mode + unused slots cleared, one undo step (also behind editor.setField 'Mode').
    id: 'signalConnector.setMode', macro: true,
    label: (a: SignalConnectorSetModeArgs) => `Mode ${a?.mode ?? ''}`.trim(),
    undoLabel: 'Set SignalConnector mode',
    argsSchema: { path: 'string', mode: 'string', componentType: 'string' },
    buttonKey: (a: SignalConnectorSetModeArgs) => inspectorFieldKey(String(a?.path ?? ''), String(a?.componentType ?? 'SignalConnector'), 'Mode'),
    lazyImpl: async () => (await import('./signal-connector-commands')).signalConnectorSetModeImpl as CommandImpl<never, unknown>,
  },
  {
    // plan-2227 R9: children Bit00… with one bit connector each, one undo step.
    id: 'signalConnector.createBits', macro: true,
    label: (a: SignalConnectorCreateBitsArgs) => `Create bit connectors${a?.mode ? ` (${a.mode})` : ''}`,
    undoLabel: 'Create bit connectors',
    argsSchema: {
      path: 'string', mode: 'string', word: 'string', bits: 'string', signals: 'string[]',
      width: 'string', signed: 'boolean', invert: 'boolean',
    },
    buttonKey: () => 'signal-connector.create-bits',
    lazyImpl: async () => (await import('./signal-connector-commands')).signalConnectorCreateBitsImpl as CommandImpl<never, unknown>,
  },
  { id: 'select.identical', label: 'Select identical', argsSchema: { seeds: 'string[]' }, shortcut: 'S>I' },
  { id: 'select.sameMaterial', label: 'Select same material', argsSchema: { seeds: 'string[]' }, shortcut: 'S>M' },
  { id: 'select.invert', label: 'Invert selection', argsSchema: { selected: 'string[]' }, shortcut: 'S>V' },
];

/** Every editor command id (for `preload` on editor activation). */
export const EDITOR_COMMAND_IDS: readonly string[] = SPECS.map((s) => s.id);

/** Build the editor descriptors against a module loader (testable seam). */
export function createEditorCommandDescriptors(opts: EditorDescriptorOptions): CommandDescriptor<never, unknown>[] {
  const implOf = (id: string) => () =>
    opts.load().then((m) => (m.impls?.[id] ?? null) as CommandImpl<never, unknown> | null);
  return SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id,
    label: s.label,
    readOnly: false,
    ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
    ...(s.toolClass ? { toolClass: s.toolClass } : {}),
    ...(s.shortcut ? { shortcut: s.shortcut } : {}),
    ...(s.undoLabel ? { undoLabel: s.undoLabel } : {}),
    scope: s.scope ?? 'editor',
    available: s.openImpl ? true : opts.available,
    unavailableReason: ERR_EDITOR_UNAVAILABLE,
    ...(s.buttonKey ? { buttonKey: s.buttonKey } : {}),
    ...(s.mcp ? { mcp: s.mcp } : {}),
    ...(s.macro ? { macro: true } : {}),
    argsSchema: s.argsSchema,
    impl: s.openImpl
      ? () => Promise.resolve(s.openImpl as CommandImpl<never, unknown>)
      : s.lazyImpl ?? implOf(s.id),
  }));
}

/** Production loader: the private implementation, or the community stub. */
const loadEditorCommands = (): Promise<EditorCommandsModule> =>
  import('@rv-private/plugins/asset-editor/editor-commands') as Promise<EditorCommandsModule>;

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the editor descriptors. */
export function ensureEditorCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createEditorCommandDescriptors({ load: loadEditorCommands, available: __RV_HAS_PRIVATE__ })) {
    registry.register(d);
  }
}

// ─── Branch tables (multiplexer bindings) ───────────────────────────────

type Wire = Readonly<Record<string, unknown>>;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** Throw the branch refusal for a missing required wire value. */
function need(w: Wire, name: string, message: string): string {
  if (isMissingWireValue(w[name])) throw new Error(message);
  return str(w[name]).trim();
}

/** `web_editor_pivot` — `mode` selects the command. */
export const PIVOT_BRANCHES: readonly BindingBranch[] = [
  { when: { mode: 'bottom' }, id: 'editor.pivotToBottom', args: (w) => ({ path: str(w['path']) }), buttonKey: 'qe.pivot-bottom' },
  {
    when: { mode: 'object_center' }, id: 'editor.pivotToObjectCenter', requires: ['targetPath'],
    args: (w) => ({ path: str(w['path']), targetPath: need(w, 'targetPath', 'object_center needs targetPath') }),
    buttonKey: 'qe.pivot-to-object',
  },
  { when: { mode: 'group_center' }, id: 'editor.centerKinematicToGroup', args: (w) => ({ path: str(w['path']) }) },
  { when: { mode: 'align_y_up' }, id: 'editor.alignYUp', args: (w) => ({ path: str(w['path']) }), buttonKey: 'qe.align-y-up' },
];

export const PIVOT_BINDING: BranchBinding = {
  branches: PIVOT_BRANCHES,
  normalize: (w) => ({ ...w, mode: str(w['mode']).trim().toLowerCase() }),
};

/** Normalise a `web_editor_shortcut` key combo to its table spelling. */
export function normalizeShortcutKeys(keys: unknown): string {
  const combo = str(keys).toUpperCase().replace(/\s+/g, '').replace(/BACKSPACE/, 'DELETE');
  if (combo === 'CTRL+SHIFT+Z') return 'CTRL+Y';
  if (combo === 'K>NAME') return 'K';
  return combo;
}

/** `web_editor_shortcut` — the key combo selects the command. Selection-driven args are null = "the call's selection". */
export const SHORTCUT_BRANCHES: readonly BindingBranch[] = [
  { when: { keys: 'S>I' }, id: 'select.identical', args: () => ({ seeds: null }) },
  { when: { keys: 'S>M' }, id: 'select.sameMaterial', args: () => ({ seeds: null }) },
  { when: { keys: 'S>V' }, id: 'select.invert', args: () => ({ selected: null }) },
  {
    when: { keys: 'K' }, id: 'editor.assignToKinematic', requires: ['arg'],
    args: (w) => ({ name: need(w, 'arg', 'K needs arg = kinematic/group name'), paths: null, requireExisting: false }),
  },
  { when: { keys: 'H' }, id: 'editor.hide', args: () => ({ paths: null }) },
  { when: { keys: 'SHIFT+H' }, id: 'editor.show', args: () => ({ paths: null }) },
  { when: { keys: 'DELETE' }, id: 'editor.delete', args: () => ({ paths: null }) },
  { when: { keys: 'CTRL+Z' }, id: 'editor.undo', args: () => ({ count: 1 }) },
  { when: { keys: 'CTRL+Y' }, id: 'editor.redo', args: () => ({ count: 1 }) },
  { when: { keys: 'ESCAPE' }, id: 'selection.clear', args: () => ({}) },
  // The key flips; an agent passes arg "on" / "off" to set it deterministically.
  { when: { keys: 'SHIFT+Z' }, id: 'editor.wireframe', args: (w) => ({ on: onOffArg(w['arg']) }), buttonKey: 'editor.wireframe' },
  // plan-766 F3 — the transform tool, same on/off/flip arg as Shift+Z.
  { when: { keys: 'T' }, id: TOGGLE_TRANSFORM_TOOL_COMMAND, args: (w) => ({ on: onOffArg(w['arg']) }), buttonKey: 'editor.transform-tool' },
];

/** `arg` of the SHIFT+Z / T shortcuts: "on"/"off" (also true/false, 1/0); anything else = flip. */
function onOffArg(arg: unknown): boolean | null {
  const v = str(arg).trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return null;
}

export const SHORTCUT_BINDING: BranchBinding = {
  branches: SHORTCUT_BRANCHES,
  normalize: (w) => ({ ...w, keys: normalizeShortcutKeys(w['keys']) }),
};

/** `web_editor_assign_to_kinematic` — one branch: the TOOL semantics (the kinematic must exist). */
export const ASSIGN_TO_KINEMATIC_BRANCHES: readonly BindingBranch[] = [
  {
    when: {}, id: 'editor.assignToKinematic',
    args: (w) => ({ name: str(w['groupName']).trim(), paths: parsePathList(str(w['paths'])), requireExisting: true }),
  },
];

export const ASSIGN_TO_KINEMATIC_BINDING: BranchBinding = { branches: ASSIGN_TO_KINEMATIC_BRANCHES };
