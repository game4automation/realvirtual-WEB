// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVFmu — the `Fmu` component (plan-498): an FMI 2.0 Co-Simulation unit
 * attached to a node in the web asset editor.
 *
 * What it is in the viewer:
 *  - a node with the extras `Fmu { StepSize, Tolerance, AllowViewerToFmu,
 *    FmuEmbed, FmuVariables }` — the package BYTES are not here, they live in
 *    the binary resource store under `FmuEmbed.sha256`
 *    (`rv-binary-resources.ts`);
 *  - one signal child per supported variable, created HERE on every load and
 *    every attach via `addSignal({ at: <node>, leafName: <variable> })`:
 *    path `<node>/Signals/<variable>`, wire name `<node>.<variable>` (placement-
 *    scoped by `addSignal`). The children are runtime products — stamped
 *    `userData._rvFmuSignal` and pruned by the asset writer, never saved;
 *  - a state machine the provisioning plugin (plan-498 Phase 3) drives. In
 *    Phase 1 an instance is `unsupported` (no package / bytes missing) or
 *    `standalone` (the FMU cannot run in the browser).
 *
 * Signal direction follows the PLC convention: an FMU OUTPUT (and a
 * calculated parameter) is produced by the FMU and READ by the viewer →
 * `PLCOutput*`; an FMU INPUT (and a tunable parameter) is WRITTEN by the
 * viewer → `PLCInput*`. Real → Float, Integer/Enumeration → Int, Boolean →
 * Bool; String variables get no signal and are listed as unsupported.
 *
 * No per-frame work: the component has no fixed-update part at all.
 */

import { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, PlcSignalType, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec, setComponentInstance } from './rv-component-registry';
import { addSignal } from './rv-signal-construction';
import { NodeRegistry } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import { binaryResources } from './rv-binary-resources';
import { unitDefsFromBaseUnits, type UnitDef } from './rv-units';
import { validateFmuExtras, type FmuEmbedShape, type FmuVariableShape } from './rv-extras-validator';
import {
  clearFmuProblems,
  reportFmuError,
  reportFmuMetadataDrift,
  reportFmuNotRunnable,
  reportFmuOverridesOrphaned,
  reportFmuUnsupported,
  reportFmuVariablesUnsupported,
} from '../hmi/problems-store';

// ─── Types ──────────────────────────────────────────────────────────────

// FmuState, FMU_STATE_COLORS and FMU_TYPE live in the dependency-free
// rv-fmu-constants.ts (plan-510: the inspector header reads the state without
// importing this engine module) and are re-exported here unchanged.
import { FMU_STATE_COLORS, FMU_TYPE, type FmuState } from './rv-fmu-constants';
export { FMU_STATE_COLORS, FMU_TYPE, type FmuState };

/** `userData` stamp on the `Signals` container (when the FMU created it) and every FMU signal leaf. */
export const RV_FMU_SIGNAL = '_rvFmuSignal';

/**
 * `userData` stamp on the viewer-owned control leaves of an FMU (plan-502 F12:
 * `Restart`). Such a leaf ALSO carries {@link RV_FMU_SIGNAL}, so the asset
 * writer prunes it exactly like a variable leaf; it is never part of
 * `signalNames` (never announced to CONNECT).
 */
export const RV_FMU_CONTROL = '_rvFmuControl';

/** Leaf name of the restart control signal (wire `<node>.Restart`). */
export const FMU_RESTART_LEAF = 'Restart';


/** One created signal child. */
export interface FmuSignalEntry {
  variable: string;
  /** Registered (wire) signal name — what CONNECT receives in Phase 3. */
  name: string;
  path: string;
  plcType: PlcSignalType;
  valueReference: number;
}

// ─── Variable → signal mapping ──────────────────────────────────────────

/**
 * The signal type of one FMI variable, or `null` when it gets no signal:
 *  - `'unsupported'` for a type the viewer has no signal for (String);
 *  - `null` for a variable that is not exposed (a non-tunable parameter).
 *
 * The causality/type table is the shared fixture expectation of plan-498
 * (viewer and CONNECT tests).
 */
export function fmuSignalTypeOf(v: FmuVariableShape): PlcSignalType | 'unsupported' | null {
  const written = v.causality === 'input' || (v.causality === 'parameter' && v.variability === 'tunable');
  const read = v.causality === 'output' || v.causality === 'calculatedParameter';
  if (!written && !read) return null;
  let kind: 'Bool' | 'Float' | 'Int';
  switch (v.type) {
    case 'Real': kind = 'Float'; break;
    case 'Integer':
    case 'Enumeration': kind = 'Int'; break;
    case 'Boolean': kind = 'Bool'; break;
    default: return 'unsupported';
  }
  return `${written ? 'PLCInput' : 'PLCOutput'}${kind}` as PlcSignalType;
}

// ─── Start-value override rules (plan-502 §2.3) ─────────────────────────

/**
 * A start-value override may be stored for this variable: causality
 * `parameter` or `input` (never `calculatedParameter`, output, local) and not
 * `constant`. Mirrored by CONNECT's `FmiStartOverrideRules.IsAllowed`.
 */
export function fmuOverrideAllowed(v: Pick<FmuVariableShape, 'causality' | 'variability'>): boolean {
  return (v.causality === 'parameter' || v.causality === 'input') && v.variability !== 'constant';
}

/** The running FMU accepts a live write: an input or a tunable parameter. */
export function fmuLiveWritable(v: Pick<FmuVariableShape, 'causality' | 'variability'>): boolean {
  return v.causality === 'input' || (v.causality === 'parameter' && v.variability === 'tunable');
}

/** Overridable but not live-writable (a `fixed` parameter): a change needs an instance restart. */
export function fmuRestartRequired(v: Pick<FmuVariableShape, 'causality' | 'variability'>): boolean {
  return fmuOverrideAllowed(v) && !fmuLiveWritable(v);
}

/**
 * Canonical string form of an override value for the variable's type, or null
 * when the value does not fit (non-finite Real, non-int32 Integer/Enumeration,
 * Boolean other than true/false/1/0, an enumeration value outside its items).
 * Strings pass unchanged. What CONNECT re-validates (422 `fmu-override-invalid`).
 */
export function normalizeFmuOverrideValue(v: FmuVariableShape, raw: unknown): string | null {
  switch (v.type) {
    case 'Real': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
      return Number.isFinite(n) ? String(n) : null;
    }
    case 'Integer':
    case 'Enumeration': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
      if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return null;
      if (v.type === 'Enumeration' && v.enumItems && v.enumItems.length > 0 && !v.enumItems.some((it) => it.value === n)) return null;
      return String(n);
    }
    case 'Boolean': {
      if (raw === true || raw === 'true' || raw === 1 || raw === '1') return 'true';
      if (raw === false || raw === 'false' || raw === 0 || raw === '0') return 'false';
      return null;
    }
    default:
      return typeof raw === 'string' ? raw : null;
  }
}

/** A stored override that is not applied, and why. */
export interface FmuOrphanedOverride {
  name: string;
  value: string;
  reason: 'unknown-variable' | 'not-overridable' | 'invalid-value';
}

/** What changed between two effective override maps (plan-502 `overrides-changed`). */
export interface FmuOverridesChange {
  /** Changed names of variables that need a restart (fixed parameters). */
  restartRequired: string[];
  /** Changed names of live-writable variables (inputs, tunable parameters). */
  live: string[];
}

/** The initial value of a signal from the variable's `start` attribute (or a start-value override). */
export function fmuSeedOf(v: FmuVariableShape, plcType: PlcSignalType, override?: string): boolean | number {
  const start = (override ?? v.start)?.trim();
  if (plcType.endsWith('Bool')) return start === 'true' || start === '1';
  if (start === undefined || start === '') return 0;
  const n = plcType.endsWith('Int') ? Number.parseInt(start, 10) : Number.parseFloat(start);
  return Number.isFinite(n) ? n : 0;
}

// ─── Instance identity ──────────────────────────────────────────────────

/**
 * Document id of the document CURRENTLY open in the planner — the first segment of every
 * `instanceKey`. The provisioning plugin (Phase 3) installs a provider that
 * answers with the project document id; without it the key uses a constant.
 * An instance reads the provider ONCE, at `init()`, so its key (and with it its
 * Problems entries and its CONNECT interface) stays stable while it lives.
 */
let _documentIdProvider: () => string = () => 'document';

/** Install the document-id provider of {@link RVFmu.instanceKey}. */
export function setFmuDocumentIdProvider(provider: (() => string) | null): void {
  _documentIdProvider = provider ?? (() => 'document');
}

/**
 * The document-independent part of an instance key (plan-498 decision log):
 *  - main model: `<assetRelativeNodePath>` (path below the model root);
 *  - inside a placement: `<_layoutId>#<path below the placement root>`;
 *  - inside a nested placement: `<_layoutNestedId>#<path below it>` — the
 *    reload-stable occurrence chain, never a uuid.
 * The INNERMOST placement root wins, so two nested occurrences are distinct.
 */
export function fmuInstanceLocalKey(node: Object3D): string {
  const segments: string[] = [];
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    const ud = cur.userData ?? {};
    const nested = typeof ud._layoutNestedId === 'string' && ud._layoutNestedId ? ud._layoutNestedId as string : null;
    const record = typeof ud._layoutId === 'string' && ud._layoutId ? ud._layoutId as string : null;
    if (cur !== node && (nested || record)) {
      return `${nested ?? record}#${segments.join('/')}`;
    }
    if (cur === node && (nested || record)) {
      // The FMU sits ON a placement root: the key is the placement itself.
      return `${nested ?? record}#`;
    }
    // Stop at the model root (the node whose parent is the scene / staging
    // parent — the same boundary NodeRegistry.computeNodePath uses).
    if (!cur.parent || !cur.parent.parent) break;
    segments.unshift(cur.name);
  }
  return segments.join('/');
}

// ─── Module-wide instance list (for the Phase-3 provisioning plugin) ────

const _instances = new Set<RVFmu>();
const _listeners = new Set<() => void>();
let _instanceSnapshot: readonly RVFmu[] = [];

function notifyInstances(): void {
  _instanceSnapshot = [..._instances];
  for (const l of _listeners) {
    try { l(); } catch (e) { console.warn('[Fmu] instance listener failed:', e); }
  }
}

/** Every live `Fmu` instance (main model, placements, editor). Stable between changes. */
export function getFmuInstances(): readonly RVFmu[] {
  return _instanceSnapshot;
}

/** Subscribe to instance add/remove and state changes. Returns the unsubscribe. */
export function subscribeFmuInstances(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

type OverridesListener = (fmu: RVFmu, change: FmuOverridesChange) => void;
type RestartListener = (fmu: RVFmu, reason: 'reset') => void;
const _overrideListeners = new Set<OverridesListener>();
const _restartListeners = new Set<RestartListener>();

/**
 * Subscribe to `overrides-changed` (plan-502): fired by {@link RVFmu.reapplyConfig}
 * — i.e. by every setField/unsetField, Undo/Redo and draft replay — when the
 * EFFECTIVE start-value map of an instance changed. The provisioning plugin is
 * the only consumer that acts on it.
 */
export function subscribeFmuOverridesChanged(listener: OverridesListener): () => void {
  _overrideListeners.add(listener);
  return () => { _overrideListeners.delete(listener); };
}

/** Subscribe to restart requests of instances (`simulation-reset` with `RestartOnReset`). */
export function subscribeFmuRestartRequests(listener: RestartListener): () => void {
  _restartListeners.add(listener);
  return () => { _restartListeners.delete(listener); };
}

/** The `RVFmu` on a node, if any. */
export function fmuOf(node: Object3D | null | undefined): RVFmu | null {
  const inst = node?.userData?._rvFmu as RVFmu | undefined;
  return inst instanceof RVFmu ? inst : null;
}

// ─── Component ──────────────────────────────────────────────────────────

export class RVFmu implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json).
  static readonly schema: ComponentSchema = loadSchemaFromSpec(FMU_TYPE);

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated
  StepSize = 0.01;
  Tolerance = 0.000001;
  AllowViewerToFmu = true;
  FmuEmbed: Record<string, unknown> = {};
  FmuVariables: unknown[] = [];
  /** plan-502 — start-value overrides by variable name (raw extras; read through {@link startOverrides}). */
  FmuStartOverrides: Record<string, unknown> = {};
  /** plan-502 — a simulation reset (Play/Reset) restarts the running instance. */
  RestartOnReset = true;
  /**
   * plan-512 F11 — the package's `UnitDefinitions` (unit name → FMI BaseUnit
   * exponents / factor / offset). Absent in GLBs attached before plan-512:
   * the unit kernel's built-in table covers them.
   */
  FmuUnits: Record<string, unknown> = {};

  /** Package SHA-256 ('' when no package is attached). */
  sha256 = '';
  state: FmuState = 'unsupported';
  lastError?: string;
  /** Phase 3 — CONNECT interface id / lease id of this instance. */
  interfaceId?: string;
  leaseId?: string;
  /** Phase 3 — what CONNECT's parse disagrees on (null = no drift); reported as `fmu-metadata-drift`. */
  metadataDrift: string | null = null;
  /** Registered wire names of every created signal child. */
  signalNames: string[] = [];
  /** Variables without a signal, formatted `name (Type)`. */
  unsupportedVariables: string[] = [];
  /** Shape-checked package record (null = no package). */
  embed: FmuEmbedShape | null = null;
  /** Shape-checked variables. */
  variables: FmuVariableShape[] = [];
  /** plan-512 — {@link FmuUnits} resolved to unit definitions (malformed entries dropped). */
  units: Record<string, UnitDef> = {};
  /** Created signal children. */
  readonly signals: FmuSignalEntry[] = [];
  /** plan-502 — every stored override (shape-checked, orphans included). */
  storedOverrides: Record<string, string> = {};
  /** plan-502 — the overrides that apply: allowed variable, valid value (canonical strings). */
  startOverrides: Record<string, string> = {};
  /** plan-502 — stored overrides that do not apply (conflict rows, `fmu-override-orphaned`). */
  orphanedOverrides: FmuOrphanedOverride[] = [];
  /** plan-502 — wire name of the `Restart` control signal ('' when none was created). */
  restartSignalName = '';
  /** plan-502 — CONNECT `/status` details of the running worker (undefined = unknown). */
  startGeneration?: number;
  simTime?: number;
  /** plan-502 — a restart is under way; the plugin waits for this `startGeneration`. */
  expectedGeneration?: number;
  /** plan-502 — `Date.now()` of the last transition to `running` (restart storm guard). */
  runningSince?: number;

  private _localKey = '';
  private _documentId: string | null = null;
  private _nodePath = '';
  private _store: SignalStore | null = null;
  private _registry: NodeRegistry | null = null;
  private _leaves: Object3D[] = [];
  private _ownContainer: Object3D | null = null;
  private _offModelCleared: (() => void) | null = null;
  private _offReset: (() => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  /** `<documentId>#<local key>` (plan-498 decision log, "Instanzidentität"). */
  get instanceKey(): string {
    return `${this._documentId ?? _documentIdProvider()}#${this._localKey}`;
  }

  /** The package bytes are in the binary resource store. */
  get hasPackage(): boolean {
    return this.sha256 !== '' && binaryResources.has(this.sha256);
  }

  /** Registry path of the FMU node (set at `init()`). */
  get nodePath(): string {
    return this._nodePath;
  }

  /** Model name from the package metadata ('' without a package). */
  get modelName(): string {
    return this.embed?.modelName ?? '';
  }

  /** The viewer may write the FMU inputs (CONNECT `AllowWebToPlc`). */
  get allowViewerToFmu(): boolean {
    return this.AllowViewerToFmu !== false;
  }

  /** The variable record by name. */
  variable(name: string): FmuVariableShape | undefined {
    return this.variables.find((v) => v.name === name);
  }

  /** The applied override of a variable (canonical string), or undefined. */
  overrideOf(name: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.startOverrides, name) ? this.startOverrides[name] : undefined;
  }

  /** An applied override is stored for this variable. */
  isOverridden(name: string): boolean {
    return this.overrideOf(name) !== undefined;
  }

  /** The variable accepts live writes (see {@link fmuLiveWritable}). */
  liveWritable(name: string): boolean {
    const v = this.variable(name);
    return !!v && fmuLiveWritable(v);
  }

  /** A changed start value of this variable needs an instance restart (see {@link fmuRestartRequired}). */
  restartRequired(name: string): boolean {
    const v = this.variable(name);
    return !!v && fmuRestartRequired(v);
  }

  /** The signal entry of a variable (undefined when it has no signal). */
  signalOf(name: string): FmuSignalEntry | undefined {
    return this.signals.find((s) => s.variable === name);
  }

  /**
   * The shared change path of the config fields (plan-502 decision log "Wer löst
   * den Neustart aus?"): called by the schema reapply of BOTH executors after
   * every setField/unsetField, Undo/Redo and draft replay. Re-reads the override
   * map (default `{}`), re-seeds the children of changed variables while no
   * CONNECT instance owns them, and reports `overrides-changed`.
   */
  reapplyConfig(): void {
    if (!_instances.has(this)) return;
    const before = this.startOverrides;
    this._readOverrides();
    const change: FmuOverridesChange = { restartRequired: [], live: [] };
    const names = new Set([...Object.keys(before), ...Object.keys(this.startOverrides)]);
    for (const name of names) {
      if (before[name] === this.startOverrides[name]) continue;
      const v = this.variable(name);
      if (!v) continue;
      if (fmuRestartRequired(v)) change.restartRequired.push(name);
      else change.live.push(name);
      this._reseed(v);
    }
    this._reportProblems();
    notifyInstances();
    if (change.restartRequired.length > 0 || change.live.length > 0) {
      for (const l of [..._overrideListeners]) {
        try { l(this, change); } catch (e) { console.warn('[Fmu] overrides listener failed:', e); }
      }
    }
  }

  /** Mirror CONNECT's `/status` details (plugin). Notifies only on a change. */
  setRuntimeStatus(startGeneration: number | undefined, simTime: number | undefined): void {
    if (this.startGeneration === startGeneration && this.simTime === simTime) return;
    this.startGeneration = startGeneration;
    this.simTime = simTime;
    notifyInstances();
  }

  /** Subscribe to the `Restart` control signal (no-op unsubscribe when there is none). */
  subscribeRestartSignal(cb: (value: boolean) => void): () => void {
    const store = this._store;
    if (!store || !this.restartSignalName) return () => {};
    return store.subscribe(this.restartSignalName, (v) => cb(v === true || v === 1));
  }

  /** Put the `Restart` control signal back to false (after the plugin consumed an edge). */
  resetRestartSignal(): void {
    if (this._store && this.restartSignalName) this._store.set(this.restartSignalName, false);
  }

  init(ctx: ComponentContext): void {
    Object.defineProperty(this.node.userData, '_rvFmu', {
      value: this, writable: true, configurable: true, enumerable: false,
    });
    this._store = ctx.signalStore;
    this._registry = ctx.registry;
    this._nodePath = ctx.registry.getPathForNode(this.node) ?? NodeRegistry.computeNodePath(this.node);
    this._localKey = fmuInstanceLocalKey(this.node);
    this._documentId = _documentIdProvider();

    const check = validateFmuExtras({
      FmuEmbed: this.FmuEmbed, FmuVariables: this.FmuVariables, FmuStartOverrides: this.FmuStartOverrides,
      FmuUnits: this.FmuUnits,
    });
    if (check.issues.length > 0) {
      console.warn(`[Fmu] ${this.node.name}: ${check.issues.join('; ')}`);
    }
    this.embed = check.embed;
    this.variables = check.variables;
    this.sha256 = check.embed?.sha256 ?? '';
    this.units = unitDefsFromBaseUnits(this.FmuUnits);
    this._readOverrides();

    if (this.embed) this._createSignals();

    // The viewer does not dispose main-model components on a model switch
    // (clearModel); an FMU must leave the instance list and the Problems panel
    // with its model. Placements and editor removals dispose explicitly.
    this._offModelCleared?.();
    const off = ctx.events?.on('model-cleared', () => this.dispose());
    this._offModelCleared = typeof off === 'function' ? off : null;
    // plan-502 F12 — a simulation reset (Play/Reset) restarts a RUNNING instance.
    this._offReset?.();
    const offReset = ctx.events?.on('simulation-reset', () => this._onSimulationReset());
    this._offReset = typeof offReset === 'function' ? offReset : null;

    _instances.add(this);
    this._setState(this._initialState(), this._initialError());
  }

  /** Move to a new state (the provisioning plugin's entry point). */
  setState(state: FmuState, error?: string): void {
    this._setState(state, error);
  }

  /** Record (or clear, with null) a disagreement between CONNECT's and the viewer's parse. */
  setMetadataDrift(detail: string | null): void {
    if (this.metadataDrift === detail) return;
    this.metadataDrift = detail;
    this._reportProblems();
    notifyInstances();
  }

  dispose(): void {
    this._offModelCleared?.();
    this._offModelCleared = null;
    this._offReset?.();
    this._offReset = null;
    if (!_instances.has(this) && this.signals.length === 0) return; // already disposed
    _instances.delete(this);
    clearFmuProblems(this.instanceKey);
    this._removeSignals();
    this._store = null;
    this._registry = null;
    if (this.node.userData._rvFmu === this) delete this.node.userData._rvFmu;
    notifyInstances();
  }

  // ─── private ──────────────────────────────────────────────────────────

  private _onSimulationReset(): void {
    if (!this.RestartOnReset || this.state !== 'running') return;
    for (const l of [..._restartListeners]) {
      try { l(this, 'reset'); } catch (e) { console.warn('[Fmu] restart listener failed:', e); }
    }
  }

  /** Split the stored map into applied overrides and orphans. */
  private _readOverrides(): void {
    const raw = validateFmuExtras({ FmuStartOverrides: this.FmuStartOverrides }).startOverrides;
    const applied: Record<string, string> = {};
    const orphans: FmuOrphanedOverride[] = [];
    for (const name of Object.keys(raw).sort()) {
      const value = raw[name];
      const v = this.variable(name);
      if (!v) { orphans.push({ name, value, reason: 'unknown-variable' }); continue; }
      if (!fmuOverrideAllowed(v)) { orphans.push({ name, value, reason: 'not-overridable' }); continue; }
      const canonical = normalizeFmuOverrideValue(v, value);
      if (canonical === null) { orphans.push({ name, value, reason: 'invalid-value' }); continue; }
      applied[name] = canonical;
    }
    this.storedOverrides = raw;
    this.startOverrides = applied;
    this.orphanedOverrides = orphans;
  }

  /**
   * Seed the child of a variable with `override ?? start` — only while no
   * CONNECT instance owns the value (the viewer never writes start values into
   * a running FMU; CONNECT applies them at initialisation, plan-502 R2).
   */
  private _reseed(v: FmuVariableShape): void {
    const store = this._store;
    const entry = this.signalOf(v.name);
    if (!store || !entry) return;
    if (this.state === 'running' || this.state === 'starting') return;
    store.set(entry.name, fmuSeedOf(v, entry.plcType, this.overrideOf(v.name)));
  }

  private _initialState(): FmuState {
    if (!this.embed) return 'unsupported';
    if (!this.hasPackage) return 'unsupported';
    return 'standalone';
  }

  private _initialError(): string | undefined {
    if (!this.embed) return 'No FMU package attached.';
    if (!this.hasPackage) return 'The FMU package bytes are missing (the document was saved without them).';
    return undefined;
  }

  private _setState(state: FmuState, error?: string): void {
    this.state = state;
    this.lastError = error;
    this._reportProblems();
    notifyInstances();
  }

  private _reportProblems(): void {
    const subject = {
      instanceKey: this.instanceKey,
      nodePath: this._nodePath,
      label: this.node.name,
      modelName: this.modelName,
    };
    clearFmuProblems(subject.instanceKey);
    if (this.state === 'unsupported') {
      reportFmuUnsupported({ ...subject, reason: this.lastError ?? 'The FMU cannot be used.' });
    } else if (this.state === 'standalone') {
      reportFmuNotRunnable(subject);
    } else if (this.state === 'error') {
      reportFmuError({ ...subject, reason: this.lastError ?? 'The FMU failed in CONNECT.' });
    }
    if (this.metadataDrift) reportFmuMetadataDrift({ ...subject, detail: this.metadataDrift });
    reportFmuVariablesUnsupported({ ...subject, variables: this.unsupportedVariables });
    reportFmuOverridesOrphaned({
      ...subject,
      overrides: this.orphanedOverrides.map((o) => `${o.name} = ${o.value} (${o.reason})`),
    });
  }

  private _createSignals(): void {
    const store = this._store;
    const registry = this._registry;
    if (!store || !registry) return;
    const hadContainer = this.node.children.some((c) => c.name === 'Signals');
    const source = `FMU · ${this.modelName || this.node.name}`;
    for (const v of this.variables) {
      const plcType = fmuSignalTypeOf(v);
      if (plcType === null) continue;
      if (plcType === 'unsupported') {
        this.unsupportedVariables.push(`${v.name} (${v.type})`);
        continue;
      }
      const comment = [v.description, v.unit ? `[${v.unit}]` : '', `${v.causality} · vr ${v.valueReference}`]
        .filter(Boolean).join(' ');
      const handle = addSignal(this.node, `${this.node.name}.${v.name}`, plcType, store, registry, {
        at: this.node,
        leafName: v.name,
        ownerPath: this._nodePath,
        seed: fmuSeedOf(v, plcType, this.overrideOf(v.name)),
        comment,
        // Only the viewer-written direction is meaningful to force.
        forceable: plcType.startsWith('PLCInput'),
      });
      (handle.node.userData as Record<string, unknown>)[RV_FMU_SIGNAL] = true;
      // plan-512 F2: the unit travels as structured meta (the `[unit]` fragment
      // in the comment stays for display). `unitDef` is THIS package's own
      // definition, so two FMUs spelling a unit alike never share a meaning.
      const unitDef = v.unit ? this.units[v.unit] : undefined;
      store.setSignalMeta(handle.name, {
        source,
        ...(v.unit ? { unit: v.unit } : {}),
        ...(unitDef ? { unitDef } : {}),
      });
      this._leaves.push(handle.node);
      this.signals.push({
        variable: v.name, name: handle.name, path: handle.path, plcType, valueReference: v.valueReference,
      });
      this.signalNames.push(handle.name);
    }
    this._createRestartSignal(source);
    const container = this.node.children.find((c) => c.name === 'Signals') ?? null;
    if (container && !hadContainer) {
      (container.userData as Record<string, unknown>)[RV_FMU_SIGNAL] = true;
      this._ownContainer = container;
      // Addressable like a GLB-authored `Signals` folder (not a "runtime" row).
      const containerPath = `${this._nodePath}/Signals`;
      if (!registry.getNode(containerPath)) registry.registerNode(containerPath, container);
    }
  }

  /**
   * plan-502 F12 — the viewer-owned `Restart` control signal (PLCInputBool,
   * wire `<node>.Restart`). A rising edge restarts the instance (plugin); it is
   * never announced to CONNECT. Skipped when a variable already owns the name.
   */
  private _createRestartSignal(source: string): void {
    const store = this._store;
    const registry = this._registry;
    if (!store || !registry) return;
    if (this.variables.some((v) => v.name === FMU_RESTART_LEAF)) {
      console.warn(`[Fmu] ${this.node.name}: a variable named "${FMU_RESTART_LEAF}" exists — no restart control signal.`);
      return;
    }
    const handle = addSignal(this.node, `${this.node.name}.${FMU_RESTART_LEAF}`, 'PLCInputBool', store, registry, {
      at: this.node,
      leafName: FMU_RESTART_LEAF,
      ownerPath: this._nodePath,
      seed: false,
      comment: 'Restart the FMU instance on a rising edge (viewer control, not an FMU variable)',
      forceable: true,
    });
    const ud = handle.node.userData as Record<string, unknown>;
    ud[RV_FMU_SIGNAL] = true;
    ud[RV_FMU_CONTROL] = true;
    store.setSignalMeta(handle.name, { source });
    this._leaves.push(handle.node);
    this.restartSignalName = handle.name;
  }

  private _removeSignals(): void {
    const store = this._store;
    const registry = this._registry;
    // Longest names first: a prefix sweep of `A.x` must not run before `A.x2`
    // is gone — both are ours, but the order keeps each sweep exact.
    const names = [...this.signalNames, ...(this.restartSignalName ? [this.restartSignalName] : [])]
      .sort((a, b) => b.length - a.length);
    for (const name of names) store?.unregisterByPrefix(name);
    for (const leaf of this._leaves) {
      registry?.unregisterSubtree(leaf);
      leaf.removeFromParent();
    }
    if (this._ownContainer && this._ownContainer.children.length === 0) {
      registry?.unregisterSubtree(this._ownContainer);
      this._ownContainer.removeFromParent();
    }
    this._ownContainer = null;
    this._leaves = [];
    this.signals.length = 0;
    this.signalNames = [];
    this.restartSignalName = '';
    this.unsupportedVariables = [];
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: FMU_TYPE,
  displayName: 'FMU',
  schema: RVFmu.schema,
  capabilities: {
    // Addable through the generic "Add component" path too — without a package
    // it lands in `unsupported` with the inspector action "FMU anhängen…".
    authorable: true,
    // A geometry-less FMU node must survive the destructive bake.
    claimsNode: true,
    bake: 'merge',
    pick: 'select',
    ui: {
      filter: 'FMU',
      category: 'logic',
      badge: '#ab47bc',
      tooltip: 'fmu',
    },
  },
  create: (node) => new RVFmu(node),
  afterCreate: (inst, node) => {
    setComponentInstance(node, inst);
  },
});
