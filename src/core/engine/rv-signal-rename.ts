// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-rename.ts — the PLANNER of a signal rename (plan-590 Phase 3).
 *
 * `planSignalRename(viewer, path, newName, env)` answers, WITHOUT changing
 * anything, what renaming the PLC signal at `path` to `newName` would touch:
 * one {@link SignalRenameStep} per write (and one informational step for the
 * path references that stay valid), the wire effects CONNECT computes in its
 * dry run, warnings, and the BLOCKERS that make the rename fail closed
 * (plan §2.3). The coordinator (`rv-signal-rename-coordinator.ts`) executes a
 * plan; the dialog and the command show one.
 *
 * Reference kinds (plan §2.3):
 *
 *  | kind             | written how                                         |
 *  |------------------|-----------------------------------------------------|
 *  | `signal-name`    | `rv_extras.<PLC*>.Name` (setField, model document)   |
 *  | `string-field`   | a fixed string signal field whose value IS the name  |
 *  | `operator-panel` | every `signal` key of `WebOperatorPanel.Config`      |
 *  | `metadata`       | every `<signal>` tag of `RuntimeMetadata.content`    |
 *  | `plc-program`    | `PLCProgram.Code` — pragma replaced / added (PLC seam)|
 *  | `signal-link`    | node `SignalLinks.Mappings` (`signal`, `carrierSignalName`) |
 *  | `placed-mapping` | planner placement mappings (journal, no document)    |
 *  | `historian`      | historian trend selection (journal)                  |
 *  | `connect`        | the gateway configuration (`POST /config/signals/rename`) |
 *  | `path-reference` | nothing — a `ComponentReference {path}` stays valid  |
 *
 * Completeness scope (plan Entscheidungs-Log): the OPEN document, its scene
 * overlay, the planner placements, the historian selection and the ACTIVE
 * CONNECT configuration. Assets that are not loaded, other scenes and other
 * projects are not searched — {@link SIGNAL_RENAME_SCOPE} says so in the preview.
 *
 * Performance contract: one pass over the registry nodes plus O(1) store
 * lookups; the path-reference count comes from the cached usage index. Target
 * < 100 ms at 20 000 signals (`signal-rename-plan.perf.test.ts`).
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import { IFACE_PATH_PREFIX, type SignalStore } from './rv-signal-store';
import {
  SIGNAL_TYPES, isGeneratedSignalData, isSignalNameTaken, resolveSignalName, trackedSignalOf,
} from './rv-signal-construction';
import { instanceScopeNode } from './rv-instance-scope';
import { isStringSignalField, type SignalUsage } from './rv-signal-usage-index';
import type {
  ConnectSignalRenameOutcome, ConnectSignalRenameStatus, ConnectSignalRenameWireChange,
} from '../hmi/connect-store';

// ─── Ports (what the planner / coordinator read and write) ───────────────

/** Structural slice of a signal mapping (`SignalMapping`, layout planner) — no plugin import. */
export interface SignalRenameMapping {
  signal: string;
  sourceKind?: 'connect' | 'internal';
  carrierSignalName?: string;
  [key: string]: unknown;
}

/** CONNECT, as the rename needs it (default: `connect-store`). */
export interface SignalRenameConnectPort {
  /** True while a gateway is connected — only then is its configuration searched. */
  isConnected(): boolean;
  /** The locally cached interface list — used to tell an OLD gateway's references apart. */
  interfaces(): ReadonlyArray<{
    id: string;
    signals?: ReadonlyArray<{ name: string }>;
    topics?: ReadonlyArray<{ signals?: ReadonlyArray<{ name: string }> | null }> | null;
  }>;
  renameSignal(
    oldName: string, newName: string, renameRevision: string | null, preview: boolean, operationId: string | null,
  ): Promise<ConnectSignalRenameOutcome>;
  fetchStatus(operationId: string): Promise<ConnectSignalRenameStatus | null>;
}

/** Planner placements with their signal mappings (default: the layout-planner store). */
export interface SignalRenamePlacedPort {
  list(): ReadonlyArray<{ id: string; label?: string; signalMappings?: readonly SignalRenameMapping[] }>;
  update(id: string, mappings: SignalRenameMapping[]): void;
}

/** Historian trend selection (default: `historian-store`). */
export interface SignalRenameHistorianPort {
  selected(): readonly string[];
  setSelected(names: string[]): void;
}

/** Field access of one document — what the PLC adapter writes `PLCProgram.Code` through. */
export interface SignalRenameCodeTarget {
  /** Awaitable setField in THIS document; rejects when the op was refused. */
  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): Promise<void>;
  /** Current value of a field in this document's live tree. */
  readField(nodePath: string, componentType: string, fieldName: string): unknown;
}

/** One ST program edit of a rename (computed by the PLC adapter). */
export interface SignalRenamePlcEdit {
  nodePath: string;
  programName: string;
  prevCode: string;
  nextCode: string;
  /** `pragma-replaced`: the `@signal` pragma held the old name; `pragma-added`: the identifier did. */
  change: 'pragma-replaced' | 'pragma-added';
  /** 1-based declaration lines that changed. */
  lines: number[];
}

/** What the PLC adapter says about a rename. */
export interface SignalRenamePlcPlan {
  edits: SignalRenamePlcEdit[];
  blockers: string[];
  warnings?: string[];
}

/**
 * The PLC seam of the rename (plan-590 §2.3 "ST-Programm"). The private PLC
 * plugin registers it ({@link registerSignalRenamePlcAdapter}); without the
 * private PLC there are no ST programs to rename and the seam is absent.
 */
export interface SignalRenamePlcAdapter {
  /** Side-effect-free: the program edits and blockers of renaming `oldName` → `newName`. */
  planRename(scene: Object3D | null | undefined, oldName: string, newName: string): SignalRenamePlcPlan;
  /**
   * Write `code` into `PLCProgram.Code` of `nodePath` in THE GIVEN document —
   * awaitable, errors propagate. With `expect`, the code is compiled first and
   * the write refused unless `externals[].signalName ?? name` contains
   * `expect.signal` (and not `expect.absent`).
   */
  writePlcCode(
    doc: SignalRenameCodeTarget, nodePath: string, code: string,
    expect?: { signal: string; absent?: string },
  ): Promise<void>;
  /**
   * Point an open editor buffer of `nodePath` at `code` (after a write, undo or
   * redo) — only when the buffer still shows `replaces` (never over unsaved work).
   */
  refreshBuffer?(nodePath: string, code: string, replaces?: string): void;
}

let _plcAdapter: SignalRenamePlcAdapter | null = null;

/** Register (or clear) the PLC seam. Called by the private PLC plugin. */
export function registerSignalRenamePlcAdapter(adapter: SignalRenamePlcAdapter | null): void {
  _plcAdapter = adapter;
}

/** The registered PLC seam, or null without the private PLC. */
export function getSignalRenamePlcAdapter(): SignalRenamePlcAdapter | null {
  return _plcAdapter;
}

/** What the planner reads besides the viewer. Every port is optional. */
export interface SignalRenamePlanEnvironment {
  connect?: SignalRenameConnectPort | null;
  placed?: SignalRenamePlacedPort | null;
  historian?: SignalRenameHistorianPort | null;
  /** Default: the registered seam ({@link getSignalRenamePlcAdapter}); `null` = no PLC. */
  plc?: SignalRenamePlcAdapter | null;
}

/** The part of the viewer the planner reads. */
export interface SignalRenameViewerLike {
  readonly registry: NodeRegistry | null | undefined;
  readonly signalStore: SignalStore | null | undefined;
  readonly scene?: Object3D | null;
  /** The cached usage index (plan-566) — the path-reference count comes from it. */
  readonly signalUsage?: { usages(name: string): readonly SignalUsage[] } | null;
}

// ─── Plan ────────────────────────────────────────────────────────────────

export type SignalRenameStepKind =
  | 'signal-name'
  | 'string-field'
  | 'operator-panel'
  | 'metadata'
  | 'plc-program'
  | 'signal-link'
  | 'placed-mapping'
  | 'historian'
  | 'connect'
  | 'path-reference';

/** Display order of the step kinds (preview groups). */
export const SIGNAL_RENAME_STEP_KINDS: readonly SignalRenameStepKind[] = [
  'signal-name', 'string-field', 'operator-panel', 'metadata', 'plc-program',
  'signal-link', 'placed-mapping', 'historian', 'connect', 'path-reference',
];

/** Which document a field step writes: the model (asset / scene) or the scene overlay. */
export type SignalRenameDocRole = 'model' | 'overlay';

/** One step of a rename. */
export interface SignalRenameStep {
  kind: SignalRenameStepKind;
  /** Primary text (node, program, placement, interface). */
  label: string;
  /** Secondary text (component.field, "pragma added", "3 path references stay valid", …). */
  detail?: string;
  /** False for an informational step (path references). */
  write: boolean;
  /** Field steps: the document that carries the write. */
  doc?: SignalRenameDocRole;
  nodePath?: string;
  componentType?: string;
  field?: string;
  value?: unknown;
  prev?: unknown;
  /** placed-mapping */
  placedId?: string;
  /** plc-program */
  programName?: string;
  /** path-reference: how many references. */
  count?: number;
}

/** CONNECT side of a plan. */
export interface SignalRenameConnectInfo {
  /**
   * `not-connected` — no gateway, nothing searched; `no-references` — the
   * gateway does not know the name; `rename` — the gateway renames;
   * `unsupported` — an old gateway without the endpoint; `error` — the dry run failed.
   */
  state: 'not-connected' | 'no-references' | 'rename' | 'unsupported' | 'error';
  changedInterfaces: Array<{ id: string; topics?: string[] | null }>;
  changedMappings: number;
  inactiveProfiles: string[];
  liveInGateway: boolean;
}

/** The plan of one rename (plan §2.4 `SignalRenamePlan`, extended). */
export interface SignalRenamePlan {
  oldName: string;
  newName: string;
  /** Registry path of the signal node. */
  nodePath: string;
  /** PLC type of the signal (`PLCInputBool`, …). */
  signalType: string;
  steps: SignalRenameStep[];
  wireChanges: ConnectSignalRenameWireChange[];
  warnings: string[];
  blockers: string[];
  /** The CONNECT revision the apply must echo; null without a CONNECT step. */
  renameRevision: string | null;
  /** Every model path that registers the old name. */
  owners: string[];
  /** Completeness scope — shown in the preview. */
  scope: string;
  connect: SignalRenameConnectInfo;
  /** Number of steps per kind (writes, and path references counted by reference). */
  counts: Record<SignalRenameStepKind, number>;
  /** True when CONNECT reported wire effects — the apply needs `confirmWireChange`. */
  requiresWireConfirmation: boolean;
  /** True when there is no blocker. */
  ok: boolean;
}

/** The completeness scope of a rename (plan Entscheidungs-Log). */
export const SIGNAL_RENAME_SCOPE =
  'Searched: the open document, its scene overlay, planner bindings, the historian selection and the active '
  + 'CONNECT configuration. Assets that are not loaded, other scenes and other projects are not searched.';

/** userData marker of FMU-generated signals (`RV_FMU_SIGNAL` in rv-fmu.ts — not imported: rv-fmu registers a component on import). */
const FMU_SIGNAL_MARKER = '_rvFmuSignal';

/** First PLC extras record on a node. */
function plcExtrasOf(node: Object3D): { type: string; data: Record<string, unknown> } | null {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const type of SIGNAL_TYPES) {
    const data = rv[type];
    if (data && typeof data === 'object') return { type, data: data as Record<string, unknown> };
  }
  return null;
}

function leaf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function hasFmuMarker(node: Object3D): boolean {
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if ((cur.userData as Record<string, unknown> | undefined)?.[FMU_SIGNAL_MARKER] === true) return true;
  }
  return false;
}

/** Validate a new signal name on its own (no store): `null` when acceptable, else the reason. */
export function validateSignalRenameName(newName: string): string | null {
  if (typeof newName !== 'string' || newName.length === 0) return 'The new name is empty.';
  if (newName.trim() !== newName) return 'The new name must not start or end with white space.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(newName)) return 'The new name contains control characters.';
  return null;
}

// ─── Rewrites (pure) ─────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Deep copy of `x` with every `signal: oldName` replaced; counts the replacements. */
function replacePanelSignals(x: unknown, oldName: string, newName: string, counter: { n: number }): unknown {
  if (Array.isArray(x)) return x.map((v) => replacePanelSignals(v, oldName, newName, counter));
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (k === 'signal' && v === oldName) { out[k] = newName; counter.n++; }
      else out[k] = replacePanelSignals(v, oldName, newName, counter);
    }
    return out;
  }
  return x;
}

/** Result of {@link rewriteOperatorPanelConfig}. */
export type OperatorPanelRewrite =
  | { kind: 'unchanged' }
  | { kind: 'changed'; value: unknown; count: number }
  | { kind: 'error'; reason: string };

/**
 * Field-exact rewrite of a `WebOperatorPanel.Config` (plan §2.3): every
 * `signal` key holding `oldName` gets `newName`. A JSON TEXT config keeps its
 * formatting — only the string literals of those keys change — and the
 * result is verified against the structural rewrite. A config that does not
 * parse, or that cannot be rewritten in place, is an error (fail closed) —
 * but only when it mentions the old name at all.
 */
export function rewriteOperatorPanelConfig(config: unknown, oldName: string, newName: string): OperatorPanelRewrite {
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    const counter = { n: 0 };
    const value = replacePanelSignals(config, oldName, newName, counter);
    return counter.n > 0 ? { kind: 'changed', value, count: counter.n } : { kind: 'unchanged' };
  }
  if (typeof config !== 'string' || config.trim() === '') return { kind: 'unchanged' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    return config.includes(oldName)
      ? { kind: 'error', reason: 'the operator panel config is not valid JSON' }
      : { kind: 'unchanged' };
  }
  const counter = { n: 0 };
  const expected = replacePanelSignals(parsed, oldName, newName, counter);
  if (counter.n === 0) return { kind: 'unchanged' };
  const re = new RegExp(`("signal"\\s*:\\s*)${escapeRegExp(JSON.stringify(oldName))}`, 'g');
  const text = config.replace(re, (_m, prefix: string) => `${prefix}${JSON.stringify(newName)}`);
  let check: unknown;
  try { check = JSON.parse(text); } catch { check = undefined; }
  if (JSON.stringify(check) !== JSON.stringify(expected)) {
    return { kind: 'error', reason: 'the operator panel config cannot be rewritten in place (unusual escaping)' };
  }
  return { kind: 'changed', value: text, count: counter.n };
}

/**
 * Rewrite every `<signal>oldName</signal>` of a metadata content string
 * (white space inside the tag and the tag spelling are kept). Returns the new
 * content and the number of replaced tags.
 */
export function rewriteMetadataContent(content: string, oldName: string, newName: string): { value: string; count: number } {
  let count = 0;
  const value = content.replace(/(<signal>)(\s*)([^<]*?)(\s*)(<\/signal>)/gi,
    (m: string, open: string, a: string, name: string, b: string, close: string) => {
      if (name !== oldName) return m;
      count++;
      return `${open}${a}${newName}${b}${close}`;
    });
  return { value, count };
}

/**
 * Rewrite the mappings of one carrier: `signal` when it names the old signal
 * (an `internal` mapping always; a `connect` mapping only when CONNECT renames
 * too), `carrierSignalName` always. Returns null when nothing changes.
 */
export function rewriteSignalMappings(
  mappings: readonly SignalRenameMapping[], oldName: string, newName: string, connectRenames: boolean,
): SignalRenameMapping[] | null {
  let changed = false;
  const next = mappings.map((m) => {
    let out = m;
    const kind = m.sourceKind ?? 'connect';
    if (m.signal === oldName && (kind === 'internal' || connectRenames)) {
      out = { ...out, signal: newName };
      changed = true;
    }
    if (m.carrierSignalName === oldName) {
      out = { ...out, carrierSignalName: newName };
      changed = true;
    }
    return out;
  });
  return changed ? next : null;
}

/** Rewrite a historian selection; null when the old name is not selected. */
export function rewriteHistorianSelection(selected: readonly string[], oldName: string, newName: string): string[] | null {
  if (!selected.includes(oldName)) return null;
  const out: string[] = [];
  for (const s of selected) {
    const v = s === oldName ? newName : s;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** True when the local CONNECT interface cache names `name` (signals or topic signals). */
function localConnectReferences(port: SignalRenameConnectPort, name: string): boolean {
  for (const iface of port.interfaces()) {
    if (iface.signals?.some((s) => s.name === name)) return true;
    for (const t of iface.topics ?? []) if (t.signals?.some((s) => s.name === name)) return true;
  }
  return false;
}

// ─── The planner ─────────────────────────────────────────────────────────

function emptyCounts(): Record<SignalRenameStepKind, number> {
  const out = {} as Record<SignalRenameStepKind, number>;
  for (const k of SIGNAL_RENAME_STEP_KINDS) out[k] = 0;
  return out;
}

/**
 * Plan the rename of the PLC signal at `path` to `newName` (plan-590 F5).
 * Side-effect free: the only call out is CONNECT's DRY RUN (`preview: true`).
 */
export async function planSignalRename(
  viewer: SignalRenameViewerLike,
  path: string,
  newName: string,
  env: SignalRenamePlanEnvironment = {},
): Promise<SignalRenamePlan> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const steps: SignalRenameStep[] = [];
  const connect: SignalRenameConnectInfo = {
    state: 'not-connected', changedInterfaces: [], changedMappings: 0, inactiveProfiles: [], liveInGateway: false,
  };
  let wireChanges: ConnectSignalRenameWireChange[] = [];
  let renameRevision: string | null = null;

  const registry = viewer.registry ?? null;
  const store = viewer.signalStore ?? null;
  const node = registry?.getNode(path) ?? null;
  const ext = node ? plcExtrasOf(node) : null;

  const finish = (oldName: string, signalType: string, owners: string[]): SignalRenamePlan => {
    const counts = emptyCounts();
    for (const s of steps) counts[s.kind] += s.kind === 'path-reference' ? (s.count ?? 1) : 1;
    return {
      oldName, newName, nodePath: path, signalType, steps, wireChanges, warnings, blockers,
      renameRevision, owners, scope: SIGNAL_RENAME_SCOPE, connect, counts,
      requiresWireConfirmation: wireChanges.length > 0,
      ok: blockers.length === 0,
    };
  };

  if (!registry || !store || !node || !ext) {
    blockers.push(`"${path}" is not a PLC signal of the open document.`);
    return finish('', '', []);
  }

  const tracked = trackedSignalOf(store, node);
  const oldName = tracked?.name ?? resolveSignalName(node, ext.data, tracked?.override).runtime;
  const owners = store.registeredPaths(oldName).filter((p) => !p.startsWith(IFACE_PATH_PREFIX));

  // ── Blockers that need no further look ──
  const nameProblem = validateSignalRenameName(newName);
  if (nameProblem) blockers.push(nameProblem);
  else if (newName === oldName) blockers.push('The new name is the current name.');
  else if (isSignalNameTaken(store, newName)) blockers.push(`A signal named "${newName}" already exists.`);
  if (isGeneratedSignalData(ext.data)) {
    blockers.push('This signal is generated at load time (component behavior, material flow) and cannot be renamed.');
  }
  if (hasFmuMarker(node)) blockers.push('This signal belongs to an FMU and cannot be renamed.');
  if (instanceScopeNode(node)) {
    blockers.push('This signal lies inside a placement — rename it in the asset that defines it.');
  }
  if (owners.length > 1) {
    blockers.push(`The name "${oldName}" is registered by ${owners.length} model nodes: ${owners.join(', ')}. `
      + 'Rename the duplicates first.');
  }
  if (store.isRenamePending(oldName) || store.isRenamePending(newName)) {
    blockers.push('Another rename of this signal is in progress.');
  }

  // ── CONNECT dry run (the only call out; preview changes nothing) ──
  const port = env.connect ?? null;
  if (!port || !port.isConnected()) {
    warnings.push('CONNECT is not connected — its configuration is neither searched nor changed.');
  } else if (!nameProblem && newName !== oldName) {
    let outcome: ConnectSignalRenameOutcome;
    try {
      outcome = await port.renameSignal(oldName, newName, null, true, null);
    } catch (e) {
      outcome = { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    switch (outcome.kind) {
      case 'ok': {
        const r = outcome.result;
        renameRevision = r.renameRevision;
        wireChanges = [...(r.wireChanges ?? [])];
        connect.changedInterfaces = [...(r.changedInterfaces ?? [])];
        connect.changedMappings = r.changedMappings ?? 0;
        connect.inactiveProfiles = [...(r.inactiveProfiles ?? [])];
        connect.liveInGateway = !!r.liveInGateway;
        if (connect.changedInterfaces.length > 0 || connect.changedMappings > 0 || connect.liveInGateway) {
          connect.state = 'rename';
          const ids = connect.changedInterfaces.map((c) => c.id);
          steps.push({
            kind: 'connect', write: true,
            label: ids.length > 0 ? ids.join(', ') : 'CONNECT gateway',
            detail: [
              ids.length > 0 ? `${ids.length} interface${ids.length === 1 ? '' : 's'}` : null,
              connect.changedMappings > 0 ? `${connect.changedMappings} mapping${connect.changedMappings === 1 ? '' : 's'}` : null,
              connect.liveInGateway ? 'live value moves' : null,
            ].filter(Boolean).join(' · '),
          });
        } else {
          connect.state = 'no-references';
        }
        if (connect.inactiveProfiles.length > 0) {
          warnings.push(`Inactive CONNECT profiles still use "${oldName}" and are not changed: ${connect.inactiveProfiles.join(', ')}.`);
        }
        break;
      }
      case 'unsupported':
        connect.state = 'unsupported';
        if (localConnectReferences(port, oldName)) {
          blockers.push('This CONNECT version cannot rename signals, and its configuration uses this signal — update CONNECT.');
        } else {
          warnings.push('This CONNECT version cannot rename signals; its configuration does not use this signal.');
        }
        break;
      case 'name-collision':
        connect.state = 'error';
        blockers.push(`CONNECT already has a signal named "${newName}".`);
        break;
      case 'validation':
        connect.state = 'error';
        blockers.push(`CONNECT rejected the rename: ${outcome.detail}`);
        break;
      default:
        connect.state = 'error';
        blockers.push(`CONNECT is not reachable — the rename cannot be checked against its configuration${
          outcome.kind === 'error' ? ` (${outcome.message})` : ''}.`);
    }
  }
  const connectRenames = connect.state === 'rename';

  // ── Model document: the name itself ──
  steps.push({
    kind: 'signal-name', write: true, doc: 'model', label: leaf(path), detail: `${ext.type}.Name`,
    nodePath: path, componentType: ext.type, field: 'Name', value: newName,
    prev: typeof ext.data.Name === 'string' ? ext.data.Name : undefined,
  });

  // ── One pass over the registry: string fields, panels, metadata, node mappings ──
  registry.forEachNode((nodePath, n) => {
    if (registry.getPathForNode(n) !== nodePath) return; // alias
    const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const componentType in rv) {
      const data = rv[componentType];
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const rec = data as Record<string, unknown>;
      if (componentType === 'WebOperatorPanel') {
        const r = rewriteOperatorPanelConfig(rec.Config, oldName, newName);
        if (r.kind === 'changed') {
          steps.push({
            kind: 'operator-panel', write: true, doc: 'model', label: leaf(nodePath),
            detail: `${r.count} panel field${r.count === 1 ? '' : 's'}`,
            nodePath, componentType, field: 'Config', value: r.value, prev: rec.Config,
          });
        } else if (r.kind === 'error') {
          blockers.push(`Operator panel "${nodePath}": ${r.reason}.`);
        }
        continue;
      }
      if (componentType === 'RuntimeMetadata') {
        const content = rec.content;
        if (typeof content === 'string' && content.includes(oldName)) {
          const r = rewriteMetadataContent(content, oldName, newName);
          if (r.count > 0) {
            if (newName.includes('<')) blockers.push(`Metadata of "${nodePath}" cannot carry a name containing "<".`);
            steps.push({
              kind: 'metadata', write: true, doc: 'model', label: leaf(nodePath),
              detail: `${r.count} <signal> tag${r.count === 1 ? '' : 's'}`,
              nodePath, componentType, field: 'content', value: r.value, prev: content,
            });
          }
        }
        continue;
      }
      if (componentType === 'SignalLinks') {
        const mappings = rec.Mappings;
        if (Array.isArray(mappings)) {
          const next = rewriteSignalMappings(mappings as SignalRenameMapping[], oldName, newName, connectRenames);
          if (next) {
            steps.push({
              kind: 'signal-link', write: true, doc: 'overlay', label: leaf(nodePath), detail: 'SignalLinks.Mappings',
              nodePath, componentType, field: 'Mappings', value: next, prev: mappings,
            });
          }
        }
        continue;
      }
      if (componentType !== 'WebSensor' && componentType !== 'ConnectSignal') continue;
      for (const field in rec) {
        if (rec[field] !== oldName || !isStringSignalField(componentType, field)) continue;
        steps.push({
          kind: 'string-field', write: true, doc: 'model', label: leaf(nodePath), detail: `${componentType}.${field}`,
          nodePath, componentType, field, value: newName, prev: oldName,
        });
      }
    }
  });

  // ── Path references (informational): the cached usage index ──
  const usages = viewer.signalUsage?.usages(oldName) ?? [];
  const pathRefs = usages.filter((u) => !u.byName && (u.kind === 'component-field' || u.kind === 'logic-step'));
  if (pathRefs.length > 0) {
    steps.push({
      kind: 'path-reference', write: false, label: 'Path references', count: pathRefs.length,
      detail: `${pathRefs.length} reference${pathRefs.length === 1 ? '' : 's'} by path stay valid`,
    });
  }
  // A connect bridge in the index that CONNECT does not rename (old gateway, not connected) stays behind.
  if (!connectRenames && usages.some((u) => u.kind === 'connect-mapping')) {
    warnings.push(`CONNECT bridges use "${oldName}" and are not changed.`);
  }

  // ── PLC programs (private seam) ──
  const plc = env.plc === undefined ? getSignalRenamePlcAdapter() : env.plc;
  if (plc && !nameProblem && newName !== oldName) {
    let res: SignalRenamePlcPlan;
    try {
      res = plc.planRename(viewer.scene ?? null, oldName, newName);
    } catch (e) {
      res = { edits: [], blockers: [`The PLC programs could not be checked: ${e instanceof Error ? e.message : String(e)}`] };
    }
    for (const b of res.blockers) blockers.push(b);
    for (const w of res.warnings ?? []) warnings.push(w);
    for (const e of res.edits) {
      steps.push({
        kind: 'plc-program', write: true, doc: 'model', label: e.programName,
        detail: e.change === 'pragma-added' ? 'pragma added' : 'pragma updated',
        nodePath: e.nodePath, componentType: 'PLCProgram', field: 'Code', value: e.nextCode, prev: e.prevCode,
        programName: e.programName,
      });
    }
  }

  // ── Planner placements (journal) ──
  for (const p of env.placed?.list() ?? []) {
    if (!p.signalMappings || p.signalMappings.length === 0) continue;
    const next = rewriteSignalMappings(p.signalMappings, oldName, newName, connectRenames);
    if (!next) continue;
    steps.push({
      kind: 'placed-mapping', write: true, label: p.label ?? p.id, detail: 'planner bindings',
      placedId: p.id, value: next, prev: p.signalMappings.map((m) => ({ ...m })),
    });
  }

  // ── Historian (journal) ──
  const selected = env.historian?.selected() ?? [];
  const nextSelection = rewriteHistorianSelection(selected, oldName, newName);
  if (nextSelection) {
    steps.push({
      kind: 'historian', write: true, label: 'Historian', detail: 'trend selection',
      value: nextSelection, prev: [...selected],
    });
    warnings.push(`Historian: new values are recorded under "${newName}"; the history of "${oldName}" stays under the old name.`);
  }

  return finish(oldName, ext.type, owners);
}
