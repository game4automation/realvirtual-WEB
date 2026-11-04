// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-trigger-host.ts — the live side of the maintenance triggers
 * (plan-522 Phase 7a), owned by the MaintenancePlugin.
 *
 * Per load it resolves every trigger's signal / drive ONCE, subscribes to the
 * signals (resolve-then-subscribe, the current value is the baseline — G2),
 * re-binds signals that register late, accumulates counters in FixedUpdate-post
 * without allocation (G4), combines the triggers of a procedure (Any / All,
 * G5/G6), writes the output signals through ONE named SignalWriter per
 * procedure with an `isExternallyControlled` check before every write (G8) and
 * reports what it cannot do in the Problems panel instead of the console.
 *
 * Time base: Δ`viewer.simTime` in standalone (a DES jump counts, a pause does
 * not), monotone wall time when live; a negative Δ is never counted. A
 * simulation reset keeps every counter (E7.3) but re-bases positions, signal
 * baselines and debounce timers on the first fixed step after it (G3).
 *
 * Not in 7a: persistence, Calendar, ValueSignal / ResetSignal / DoneSignal,
 * raise() and commands (7b).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { MaintenanceProcedure, MaintenanceTriggerDef } from '../../core/maintenance-parser';
import { signalValueKindOf, signalTypeFitsKind } from '../../core/maintenance-parser';
import {
  accumulate,
  applySignalValue,
  completeTrigger,
  createTriggerState,
  decidingIndex,
  isCountingKind,
  levelOf,
  rebaseTrigger,
  remainingFractionOf,
  remainingOf,
  tickDebounce,
  unitOfKind,
  type MaintenanceLevel,
  type MaintenanceTriggerCombine,
  type TriggerRules,
  type TriggerState,
} from '../../core/maintenance-trigger-eval';
import { createSignalWriter, type SignalStore, type SignalWriter } from '../../core/engine/rv-signal-store';
import { isExternallyControlled } from '../../core/engine/rv-logic-engine';
import { clearProblemsOfCode, reportProblem, clearProblem } from '../../core/hmi/problems-store';
import { MAINTENANCE_PROCEDURE_TYPE } from '../../core/engine/rv-maintenance-components';

/** Problem codes this host reports (cleared on every load). */
export const MAINTENANCE_PROBLEM_CODES = Object.freeze({
  invalid: 'maintenance-trigger-invalid',
  unresolved: 'maintenance-trigger-unresolved',
  type: 'maintenance-trigger-type',
  external: 'maintenance-output-external',
  placement: 'maintenance-in-placement-unsupported',
});

/** How often (s, trigger time) a moving counter republishes tiles and RemainingSignal. */
const PUBLISH_INTERVAL = 0.25;

/** The part of a drive the counters read. */
interface DriveLike { currentPosition: number }

/** Runtime of one trigger. Fields are mutated in place (no allocation per step). */
export interface TriggerRun {
  readonly def: MaintenanceTriggerDef;
  readonly rules: TriggerRules;
  readonly state: TriggerState;
  /** Enabled, without authoring issue, source resolved, type fits (G5). */
  participating: boolean;
  /** The signal is not registered yet: re-resolved on every late registration (G2). */
  pending: boolean;
  signalName: string | null;
  signalUnsub: (() => void) | null;
  drive: DriveLike | null;
  lastPosition: number;
  /** Evaluated level / remaining fraction (CombineInput). */
  level: MaintenanceLevel;
  remainingFraction: number;
}

/** One output signal of a procedure. */
interface OutputRun {
  readonly key: 'due' | 'overdue' | 'state' | 'remaining';
  readonly ref: Record<string, unknown>;
  readonly scope: Object3D | null;
  /** Canonical signal name; null while the reference does not resolve to a registered signal. */
  name: string | null;
}

/** Runtime of one procedure with triggers or outputs. */
export interface ProcedureRun {
  readonly procedure: MaintenanceProcedure;
  readonly runs: TriggerRun[];
  readonly combine: MaintenanceTriggerCombine;
  /** Reused participant list (no allocation per evaluation). */
  readonly participants: TriggerRun[];
  level: MaintenanceLevel;
  deciding: TriggerRun | null;
  readonly outputs: OutputRun[];
  writer: SignalWriter | null;
}

/** A tile-ready view of one procedure's trigger state. */
export interface ProcedureTriggerView {
  level: MaintenanceLevel;
  /** The deciding trigger, null without participants. */
  deciding: TriggerRun | null;
}

/** Read the viewer's sim clock when it has one (tests may not). */
function simTimeOf(viewer: RVViewer | null): number | null {
  const t = (viewer as { simTime?: unknown } | null)?.simTime;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

function wallSeconds(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

export class MaintenanceTriggerHost {
  private viewer: RVViewer | null = null;
  private store: SignalStore | null = null;
  private _procs: ProcedureRun[] = [];
  /** Every trigger run of every procedure, flat (fixed-step loop). */
  private _runs: TriggerRun[] = [];
  /** Trigger time in seconds (sum of counted Δt). */
  private _clock = 0;
  private _lastSim = 0;
  private _lastWall = 0;
  private _clockLive = false;
  private _rebasePending = true;
  private _publishTimer = 0;
  private _valueDirty = false;
  private _signalAddedOff: (() => void) | null = null;
  private _forceOff: (() => void) | null = null;
  private _reportedExternal = new Set<string>();
  private _reportedPlacements = new Set<string>();

  /** Live state of the viewer (kept by the plugin from interface events). */
  live = false;

  /** Called when a procedure's level, deciding trigger or counter changed (tiles). */
  onChange: (() => void) | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /** Build the runs of a fresh model and resolve every reference once. */
  setup(viewer: RVViewer, procedures: readonly MaintenanceProcedure[]): void {
    this.clear();
    this.viewer = viewer;
    this.store = (viewer as { signalStore?: SignalStore | null }).signalStore ?? null;
    this._clock = 0;
    this._rebasePending = true;
    this._publishTimer = 0;
    this._valueDirty = false;
    for (const procedure of procedures) {
      const defs = procedure.triggers ?? [];
      const outRefs = procedure.outputs;
      if (defs.length === 0 && !outRefs) continue;
      const pr: ProcedureRun = {
        procedure,
        runs: [],
        combine: procedure.triggerCombine ?? 'Any',
        participants: [],
        level: 0,
        deciding: null,
        outputs: [],
        writer: null,
      };
      for (const def of defs) {
        const run = this._createRun(pr, def);
        pr.runs.push(run);
        this._runs.push(run);
      }
      if (outRefs) {
        const scope = procedure.node ?? null;
        for (const key of ['due', 'overdue', 'state', 'remaining'] as const) {
          const ref = outRefs[key];
          if (!ref) continue;
          const address = this._resolveSignalAddress(ref, scope);
          const out: OutputRun = { key, ref, scope, name: address ? this._nameFor(address) : null };
          if (!out.name) this._reportOutputUnresolved(pr, out);
          pr.outputs.push(out);
        }
        if (this.store) {
          pr.writer = createSignalWriter(this.store, `component:MaintenanceProcedure:${procedure.name}`, 'component');
        }
      }
      this._procs.push(pr);
    }
    this._armLateBinding();
    // G8: an output skipped while forced is written again once the force is released.
    if (this.store && this._procs.some((pr) => pr.outputs.length > 0)) {
      this._forceOff = this.store.subscribeForce(() => {
        for (const pr of this._procs) this._writeOutputs(pr);
      });
    }
    this._rebase();
    for (const pr of this._procs) this._evaluate(pr, true);
  }

  /** Drop everything of the current model (unsubscribe, clear problems). */
  clear(): void {
    for (const run of this._runs) {
      run.signalUnsub?.();
      run.signalUnsub = null;
    }
    this._signalAddedOff?.();
    this._signalAddedOff = null;
    this._forceOff?.();
    this._forceOff = null;
    this._procs = [];
    this._runs = [];
    this._reportedExternal.clear();
    this._reportedPlacements.clear();
    for (const code of Object.values(MAINTENANCE_PROBLEM_CODES)) clearProblemsOfCode(code);
    this.viewer = null;
    this.store = null;
  }

  /** `simulation-reset`: counters stay (E7.3), baselines restart on the next fixed step (G3). */
  onSimulationReset(): void {
    this._rebasePending = true;
  }

  /** The procedure runs (tests, tiles). */
  get procedures(): readonly ProcedureRun[] {
    return this._procs;
  }

  /** Trigger time in seconds. */
  get clock(): number {
    return this._clock;
  }

  /** Level + deciding trigger of a procedure; level 0 when it has no triggers. */
  viewOf(procedure: MaintenanceProcedure): ProcedureTriggerView {
    const pr = this._procs.find((p) => p.procedure === procedure);
    return pr ? { level: pr.level, deciding: pr.deciding } : { level: 0, deciding: null };
  }

  /** Done (step-by-step completion): every trigger of the procedure starts again. */
  complete(procedure: MaintenanceProcedure | null): void {
    const pr = procedure ? this._procs.find((p) => p.procedure === procedure) : undefined;
    if (!pr) return;
    for (const run of pr.runs) {
      completeTrigger(run.rules, run.state);
      if (run.drive) run.lastPosition = run.drive.currentPosition;
    }
    this._evaluate(pr, true);
  }

  /** Set the counter of the procedure's first counting trigger (tests, MCP, demos). */
  setCounterValue(procedureName: string, value: number): void {
    const pr = this._procs.find((p) => p.procedure.name === procedureName);
    const run = pr?.runs.find((r) => isCountingKind(r.rules.kind));
    if (!pr || !run || !Number.isFinite(value)) return;
    run.state.value = Math.max(0, value);
    run.state.latched = false;
    this._evaluate(pr, true);
  }

  /** A placement brought content (G11): a procedure inside it is not supported in Phase 7 — say so once. */
  onPlacementContent(root: Object3D): void {
    const viewer = this.viewer;
    let found: Object3D | null = null;
    root.traverse((n) => {
      if (found) return;
      const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv && rv[MAINTENANCE_PROCEDURE_TYPE] != null) found = n;
    });
    if (!found) return;
    const path = viewer?.registry?.getPathForNode?.(root) ?? root.name;
    if (this._reportedPlacements.has(path)) return;
    this._reportedPlacements.add(path);
    reportProblem({
      id: `${MAINTENANCE_PROBLEM_CODES.placement}:${path}`,
      severity: 'warning',
      code: MAINTENANCE_PROBLEM_CODES.placement,
      title: 'Maintenance procedure in a placement is not evaluated',
      detail: `Placement "${path}" contains a maintenance procedure ("${(found as Object3D).name}"). Guides and triggers work for procedures in the main model only; open the asset itself to use it.`,
      nodePath: path,
    });
  }

  // ─── Fixed step ─────────────────────────────────────────────────────

  /** Counters, debounce and overdue time; allocation-free. */
  fixedUpdate(dt: number): void {
    const runs = this._runs;
    if (this._procs.length === 0) return;
    const live = this.live;
    if (this._rebasePending || live !== this._clockLive) {
      // Rebase step: no Δ counted (G3 / G4).
      this._rebase();
      return;
    }
    let dtS: number;
    if (live) {
      const now = wallSeconds();
      dtS = now - this._lastWall;
      this._lastWall = now;
    } else {
      const st = simTimeOf(this.viewer);
      if (st === null) dtS = dt;
      else { dtS = st - this._lastSim; this._lastSim = st; }
    }
    if (!(dtS > 0) || !Number.isFinite(dtS)) dtS = 0;
    this._clock += dtS;
    const now = this._clock;

    let anyChange = false;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run.participating) continue;
      const rules = run.rules;
      let travel = 0;
      if (run.drive) {
        const pos = run.drive.currentPosition;
        const d = Math.abs(pos - run.lastPosition);
        run.lastPosition = pos;
        if (Number.isFinite(d)) travel = d;
      }
      let changed = false;
      if (isCountingKind(rules.kind)) {
        const active = rules.kind === 'RunTime'
          ? (run.signalName !== null ? (run.state.prev === true || (typeof run.state.prev === 'number' && run.state.prev !== 0)) : travel > 1e-9)
          : false;
        changed = accumulate(rules, run.state, dtS, travel, active, live ? 1 : rules.acceleration);
      } else {
        changed = tickDebounce(rules, run.state, now)
          || (run.state.fired && rules.overdueAfter > 0 && run.level < 3);
      }
      if (changed) anyChange = true;
    }
    if (anyChange) {
      for (let p = 0; p < this._procs.length; p++) this._evaluate(this._procs[p], false);
    }
    if (this._valueDirty) {
      this._publishTimer += dtS > 0 ? dtS : dt;
      if (this._publishTimer >= PUBLISH_INTERVAL) {
        this._publishTimer = 0;
        this._valueDirty = false;
        for (let p = 0; p < this._procs.length; p++) this._writeRemaining(this._procs[p]);
        this.onChange?.();
      }
    }
  }

  // ─── Internal: setup ────────────────────────────────────────────────

  private _createRun(pr: ProcedureRun, def: MaintenanceTriggerDef): TriggerRun {
    const run: TriggerRun = {
      def,
      rules: def.rules,
      state: createTriggerState(),
      participating: false,
      pending: false,
      signalName: null,
      signalUnsub: null,
      drive: null,
      lastPosition: 0,
      level: 0,
      remainingFraction: 1,
    };
    const where = `${pr.procedure.name} / ${def.legacy ? 'trigger fields' : def.name}`;
    if (def.issues.length > 0) {
      reportProblem({
        id: `${MAINTENANCE_PROBLEM_CODES.invalid}:${pr.procedure.name}:${def.name}`,
        severity: 'warning',
        code: MAINTENANCE_PROBLEM_CODES.invalid,
        title: 'Maintenance trigger is not evaluated',
        detail: `${where}: ${def.issues.join('; ')}`,
        nodePath: this._pathOf(def.node),
      });
      return run;
    }
    if (!def.enabled) return run;
    // Drive (Travel, RunTime fallback).
    if (def.driveRef && (def.rules.kind === 'Travel' || (def.rules.kind === 'RunTime' && !def.signalRef))) {
      run.drive = this._resolveDrive(def.driveRef, def.scopeNode);
      if (!run.drive) {
        this._reportUnresolved(pr, run, `drive "${def.drivePath}" not found`);
        return run;
      }
      run.lastPosition = run.drive.currentPosition;
    }
    if (def.signalRef && def.rules.kind !== 'Travel' && def.rules.kind !== 'Interval') {
      const address = this._resolveSignalAddress(def.signalRef, def.scopeNode);
      const name = address ? this._nameFor(address) : null;
      if (!name) {
        run.pending = true;
        this._reportUnresolved(pr, run, `signal "${def.signalPath}" not registered (yet) — bound as soon as it appears`);
        return run;
      }
      this._bindSignal(pr, run, name);
      return run;
    }
    run.participating = true;
    return run;
  }

  /** Subscribe to a resolved signal; the current value is the baseline (G2). */
  private _bindSignal(pr: ProcedureRun, run: TriggerRun, name: string): void {
    const store = this.store;
    if (!store) return;
    // G1: the live type decides when the stored reference did not name one.
    const plcType = store.getType(name) ?? '';
    const value = store.get(name);
    const typeOk = plcType
      ? signalTypeFitsKind(run.rules.kind, plcType)
      : !(typeof value === 'boolean' && run.rules.kind === 'Threshold')
        && !(typeof value === 'number' && (run.rules.kind === 'Signal' || run.rules.kind === 'RunTime'));
    clearProblem(`${MAINTENANCE_PROBLEM_CODES.unresolved}:${pr.procedure.name}:${run.def.name}`);
    if (!typeOk) {
      const vk = plcType ? signalValueKindOf(plcType) : typeof value === 'boolean' ? 'Bool' : 'number';
      reportProblem({
        id: `${MAINTENANCE_PROBLEM_CODES.type}:${pr.procedure.name}:${run.def.name}`,
        severity: 'warning',
        code: MAINTENANCE_PROBLEM_CODES.type,
        title: 'Maintenance trigger reads a signal of the wrong type',
        detail: `${pr.procedure.name} / ${run.def.name}: ${run.rules.kind} cannot read "${name}" (${plcType || vk})`,
        nodePath: this._pathOf(run.def.node),
      });
      return;
    }
    run.signalName = name;
    run.pending = false;
    const state = run.state;
    const rules = run.rules;
    run.signalUnsub = store.subscribe(name, (v) => {
      if (this._rebasePending) return; // re-sampled on the rebase step (G3)
      if (applySignalValue(rules, state, v, this._clock)) this._evaluate(pr, false);
    });
    if (value !== undefined) applySignalValue(rules, state, value, this._clock);
    run.participating = true;
  }

  private _reportUnresolved(pr: ProcedureRun, run: TriggerRun, what: string): void {
    reportProblem({
      id: `${MAINTENANCE_PROBLEM_CODES.unresolved}:${pr.procedure.name}:${run.def.name}`,
      severity: 'warning',
      code: MAINTENANCE_PROBLEM_CODES.unresolved,
      title: 'Maintenance trigger source not found',
      detail: `${pr.procedure.name} / ${run.def.legacy ? 'trigger fields' : run.def.name}: ${what}`,
      nodePath: this._pathOf(run.def.node),
    });
  }

  /** Listen for late signal registrations while anything is still pending (G2). */
  private _armLateBinding(): void {
    const store = this.store;
    if (!store || this._signalAddedOff) return;
    if (!this._hasPending()) return;
    this._signalAddedOff = store.onSignalAdded(() => this._onSignalAdded());
  }

  private _hasPending(): boolean {
    for (const run of this._runs) if (run.pending) return true;
    for (const pr of this._procs) for (const o of pr.outputs) if (!o.name) return true;
    return false;
  }

  /**
   * A signal name appeared: re-resolve every pending reference through the
   * scoped resolver (never a suffix guess — two machines may share a path
   * tail) and bind the ones that now name a registered signal.
   */
  private _onSignalAdded(): void {
    if (!this.store) return;
    for (const pr of this._procs) {
      for (const run of pr.runs) {
        if (!run.pending || !run.def.signalRef) continue;
        const address = this._resolveSignalAddress(run.def.signalRef, run.def.scopeNode);
        const name = address ? this._nameFor(address, true) : null;
        if (!name) continue;
        this._bindSignal(pr, run, name);
        if (run.participating) this._evaluate(pr, true);
      }
      let boundOutput = false;
      for (const o of pr.outputs) {
        if (o.name) continue;
        const address = this._resolveSignalAddress(o.ref, o.scope);
        const name = address ? this._nameFor(address, true) : null;
        if (!name) continue;
        o.name = name;
        clearProblem(this._outputProblemId(pr, o));
        boundOutput = true;
      }
      if (boundOutput) this._writeOutputs(pr);
    }
    if (!this._hasPending()) {
      this._signalAddedOff?.();
      this._signalAddedOff = null;
    }
  }

  private _outputProblemId(pr: ProcedureRun, o: OutputRun): string {
    return `${MAINTENANCE_PROBLEM_CODES.unresolved}:${pr.procedure.name}:output:${o.key}`;
  }

  private _reportOutputUnresolved(pr: ProcedureRun, o: OutputRun): void {
    const label = typeof o.ref['path'] === 'string' && o.ref['path'] ? o.ref['path'] as string : String(o.ref['address'] ?? '');
    reportProblem({
      id: this._outputProblemId(pr, o),
      severity: 'warning',
      code: MAINTENANCE_PROBLEM_CODES.unresolved,
      title: 'Maintenance output signal not found',
      detail: `${pr.procedure.name}: output "${o.key}" → signal "${label}" not registered (yet) — written as soon as it appears`,
      nodePath: pr.procedure.node ? this._pathOf(pr.procedure.node) : undefined,
    });
  }

  /** Signal address of a stored reference (any PLC type), or null. */
  private _resolveSignalAddress(ref: Record<string, unknown>, scope: Object3D | null): string | null {
    const registry = this.viewer?.registry;
    if (!registry) return null;
    const ct = typeof ref['componentType'] === 'string' ? ref['componentType'] as string : '';
    const typed = ct.includes('PLC') || ct.includes('Signal') ? ct : 'PLCSignal';
    try {
      const r = registry.resolve({ ...ref, type: 'ComponentReference', componentType: typed } as never, scope, scope);
      return typeof r.signalAddress === 'string' && r.signalAddress ? r.signalAddress : null;
    } catch {
      return null;
    }
  }

  /**
   * Canonical signal name of an address: exact path, the store's path
   * resolution (the logic engine's rule, at load) or the address as a name.
   * `strict` (late registration) skips the store's suffix resolution — a
   * signal of another machine with the same path tail must not be taken.
   */
  private _nameFor(address: string, strict = false): string | null {
    const store = this.store;
    if (!store) return null;
    const exact = store.exactNameForPath?.(address) ?? store.exactNameForPath?.(address.replace(/ /g, '_'));
    if (exact) return exact;
    if (!strict) {
      const resolved = store.nameForPath(address);
      if (resolved) return resolved;
    }
    return store.get(address) !== undefined ? address : null;
  }

  private _resolveDrive(ref: Record<string, unknown>, scope: Object3D): DriveLike | null {
    try {
      const r = this.viewer?.registry?.resolve({ ...ref, type: 'ComponentReference', componentType: 'Drive' } as never, scope, scope) as { drive?: unknown } | undefined;
      const d = r?.drive as DriveLike | undefined;
      return d && typeof d.currentPosition === 'number' ? d : null;
    } catch {
      return null;
    }
  }

  private _pathOf(node: Object3D): string | undefined {
    return this.viewer?.registry?.getPathForNode?.(node) ?? undefined;
  }

  // ─── Internal: rebase + evaluation ──────────────────────────────────

  /** Baselines after load / reset / live switch (G3): counters stay, no Δ counted. */
  private _rebase(): void {
    this._rebasePending = false;
    this._clockLive = this.live;
    this._lastSim = simTimeOf(this.viewer) ?? 0;
    this._lastWall = wallSeconds();
    const store = this.store;
    let any = false;
    for (const run of this._runs) {
      if (run.drive) run.lastPosition = run.drive.currentPosition;
      if (!run.signalName || !store) continue;
      rebaseTrigger(run.state);
      const v = store.get(run.signalName);
      if (v !== undefined) applySignalValue(run.rules, run.state, v, this._clock);
      any = true;
    }
    if (any) for (const pr of this._procs) this._evaluate(pr, false);
  }

  /**
   * Levels of every trigger, the procedure level and its deciding trigger
   * (G5/G6). A level or deciding change writes the outputs and notifies at
   * once; a counter move only marks the throttled publish.
   */
  private _evaluate(pr: ProcedureRun, force: boolean): void {
    const now = this._clock;
    const parts = pr.participants;
    parts.length = 0;
    for (let i = 0; i < pr.runs.length; i++) {
      const run = pr.runs[i];
      if (!run.participating) { run.level = 0; continue; }
      if (isCountingKind(run.rules.kind) && !(run.rules.interval > 0)) { run.level = 0; continue; }
      run.level = levelOf(run.rules, run.state, now);
      run.remainingFraction = remainingFractionOf(run.rules, run.state, run.level);
      parts.push(run);
    }
    const idx = decidingIndex(pr.combine, parts);
    const deciding = idx >= 0 ? parts[idx] : null;
    const level: MaintenanceLevel = deciding ? deciding.level : 0;
    const changed = force || level !== pr.level || deciding !== pr.deciding;
    pr.level = level;
    pr.deciding = deciding;
    if (changed) {
      this._writeOutputs(pr);
      this.onChange?.();
    } else {
      this._valueDirty = true;
    }
  }

  private _remainingValue(pr: ProcedureRun): number {
    const d = pr.deciding;
    return d ? remainingOf(d.rules, d.state, d.level) : -1;
  }

  private _writeOutputs(pr: ProcedureRun): void {
    for (const o of pr.outputs) {
      switch (o.key) {
        case 'due': this._write(pr, o, pr.level >= 2); break;
        case 'overdue': this._write(pr, o, pr.level >= 3); break;
        case 'state': this._write(pr, o, pr.level); break;
        case 'remaining': this._write(pr, o, this._remainingValue(pr)); break;
      }
    }
  }

  private _writeRemaining(pr: ProcedureRun): void {
    for (const o of pr.outputs) if (o.key === 'remaining') this._write(pr, o, this._remainingValue(pr));
  }

  /** One output write: skipped (and reported once) when the signal is externally controlled (G8). */
  private _write(pr: ProcedureRun, o: OutputRun, value: boolean | number): void {
    const store = this.store;
    if (!store || !pr.writer || !o.name || store.get(o.name) === value) return;
    if (isExternallyControlled(store, o.name)) {
      const id = `${MAINTENANCE_PROBLEM_CODES.external}:${pr.procedure.name}:${o.name}`;
      if (!this._reportedExternal.has(id)) {
        this._reportedExternal.add(id);
        reportProblem({
          id,
          severity: 'info',
          code: MAINTENANCE_PROBLEM_CODES.external,
          title: 'Maintenance output not written',
          detail: `${pr.procedure.name}: "${o.name}" is controlled externally (bound, forced or remote) — the maintenance state is not written there.`,
        });
      }
      return;
    }
    pr.writer.set(o.name, value);
  }
}

/** Display unit of a trigger run's counter ('' = a count, null = no counter). */
export function unitOfRun(run: TriggerRun | null): 'km' | 'h' | '' | null {
  return run ? unitOfKind(run.rules.kind) : null;
}
