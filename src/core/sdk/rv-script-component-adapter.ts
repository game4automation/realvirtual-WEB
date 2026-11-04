// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { snapshotUserMessage } from './rv-des-snapshot-messages';

import { desScriptMayReadLiveGeometry, lintDesSafety } from './rv-des-lint';

/**
 * rv-script-component-adapter.ts — hangs one script component's closure
 * handler set (`setup(self)` → `{ continuous, des, onSignal, onReset }`) onto
 * BOTH simulation kernels (plan-210 §6/§6b/§9 "DES-Runner-Adapter").
 *
 *  - **continuous** — the owner (simulation loop / phase-2 loader wiring)
 *    calls `tick(dt)` per fixed step: the adapter advances its virtual clock,
 *    drains the event heap (`time <= now` — §6b delta-cycle drain) and then
 *    invokes `continuous.fixedUpdate(dt)` when the script declared one.
 *  - **des** — when the PRIVATE DES runner is loaded, the owner passes a
 *    ScriptHook-backed `SdkScheduler` (see the private
 *    `rv-des-script-hook.ts`); due events call back through the public
 *    `ScriptHookDispatcher` contract, which this adapter implements.
 *
 * Event-driven handlers (timer hooks via `des.on`, `sensor.on`, `signal.on`)
 * therefore run in BOTH kernels from one handler set (§6b point 2 —
 * "write once, run both speeds"); `continuous.fixedUpdate` remains the
 * optional continuous-only path (flagged by the DES lint).
 *
 * The adapter owns ONE `RVEventHeap` per component instance — the single
 * time source for that component's timers. There is no wall clock anywhere:
 * `now` only advances through `tick(dt)` (continuous) or the DES scheduler.
 */

import type { ScriptTimerTable } from '../../plugins/des/rv-des-script-participant';
import type { SdkComponent } from './rv-component-sdk';
import { DES_FRAME_HOOK_WRITE_CODE, type SdkStatRow } from './rv-sdk-self';
import { RVEventHeap } from './rv-event-heap';
import { scaleSimDt } from '../engine/rv-speed-override';
import {
  createHeapScheduler,
  RV_EVERY_HOOK,
  type ScriptHookDispatcher,
  type ScriptMuRef,
  type ScriptPortDesc,
  type SdkScheduler,
} from './rv-script-hook';

export interface ScriptComponentAdapterOptions {
  /** Kernel mode the adapter serves. Default 'continuous'. */
  mode?: 'continuous' | 'des';
  /**
   * DES mode only: the ScriptHook-backed scheduler minted by the private DES
   * runner (`makeScriptHookScheduler(dispatcher)` with THIS adapter as the
   * dispatcher). Required in DES mode.
   */
  desScheduler?: SdkScheduler;
  /**
   * DES mode alternative to `desScheduler` (plan-2212): a factory that receives
   * THIS adapter as the `ScriptHookDispatcher` and returns the ScriptHook-backed
   * scheduler. Production wiring uses it so the queued `Script.Hook` payload
   * names the adapter itself — the snapshot pipeline identifies a script by
   * its adapter (`scriptParticipants().idOf`).
   */
  makeDesScheduler?: (dispatcher: ScriptHookDispatcher) => SdkScheduler;
  /**
   * DES mode only (plan-2212 F7): what the undeclared-state check does with a
   * finding at `attach()`. `'strict'` (default) disables the component and
   * throws; `'warn'` only reports through `onLintWarning` and keeps the script
   * running. The web-component registry passes `'strict'` for `DesSafe`
   * components and `'warn'` otherwise.
   */
  lintPolicy?: 'strict' | 'warn';
  /** Receives the `'warn'` policy finding (default: console.warn). */
  onLintWarning?: (code: string, message: string) => void;
  /**
   * DES mode only (plan-2212 Phase 4): true while the DES run ANIMATES (not in
   * FastForward, not in a batch). Only then does `tick`/`lateTick` call the
   * script's frame hooks (`continuous.fixedUpdate` / `lateFixedUpdate`), and
   * only for display: see {@link RVScriptComponentAdapter.tick}. Absent = the
   * frame hooks never run in DES mode.
   */
  displayFrames?: () => boolean;
  /** Continuous mode: inject a heap (tests); default: the adapter owns one. */
  heap?: RVEventHeap;
  /** Reports handler failures (default: console.warn). Disable decisions stay
   *  with the poison backoff — a plain guest exception does NOT disable. */
  onHandlerError?: (path: string, message: string) => void;
}

/** The guest state of one script as a DES snapshot carries it (plan-261 / plan-2212). */
export interface ScriptGuestState {
  rng: number;
  fsmState?: string;
  persist?: unknown;
  legacy?: unknown;
  timers: ScriptTimerTable;
  /** Published `self.statValue` rows (plan-2212 Phase 3); absent = none published. */
  stats?: SdkStatRow[];
}

/**
 * Kernel adapter for ONE script component. Create it FIRST (it provides the
 * `scheduler` for the `SdkEnvironment`), then `attach()` the component built
 * by `createSdkComponent()`.
 */
export class RVScriptComponentAdapter implements ScriptHookDispatcher {
  readonly mode: 'continuous' | 'des';
  /** The component's timer heap (continuous drain source). */
  readonly heap: RVEventHeap;
  /** The `SdkScheduler` to pass as `SdkEnvironment.scheduler`. */
  readonly scheduler: SdkScheduler;

  private component: SdkComponent | null = null;
  private virtualNow = 0;
  private disposed = false;
  private runRngSeed: number | null = null;
  private nextRunRngSeed?: () => number | null;
  private seededByReset = false;
  private appliedByReset: number | null = null;
  private v2Seeded = false;
  private readonly onHandlerError: (path: string, message: string) => void;
  private readonly lintPolicy: 'strict' | 'warn';
  private readonly onLintWarning: (code: string, message: string) => void;
  private undeclaredStateFinding: string | null = null;
  private readonly displayFrames: (() => boolean) | null;
  private displayRefusals = 0;
  private warnedDisplayWrite = false;
  /** plan-2212 Phase 4b: settle-gate verdict of the attached component (null = not decided yet). */
  private liveGeometry: boolean | null = null;

  constructor(opts: ScriptComponentAdapterOptions = {}) {
    this.mode = opts.mode ?? 'continuous';
    this.heap = opts.heap ?? new RVEventHeap();
    this.onHandlerError = opts.onHandlerError
      ?? ((path, message) => console.warn(`[sdk-adapter] handler '${path}' failed: ${message}`));

    this.displayFrames = opts.displayFrames ?? null;
    this.lintPolicy = opts.lintPolicy ?? 'strict';
    this.onLintWarning = opts.onLintWarning
      ?? ((code, message) => console.warn(`[sdk-adapter] ${code}: ${message}`));

    if (this.mode === 'des') {
      const scheduler = opts.desScheduler ?? opts.makeDesScheduler?.(this);
      if (!scheduler) {
        throw new Error('RVScriptComponentAdapter: DES mode requires a desScheduler (private ScriptHook backend)');
      }
      this.scheduler = scheduler;
    } else {
      this.scheduler = createHeapScheduler(this.heap, () => this.virtualNow);
      // Every due heap event dispatches through the SAME contract the DES
      // kernel uses — identical hook semantics in both kernels.
      this.heap.addListener((ev) =>
        this.dispatchScriptHook(ev.hook, (ev.mu ?? null) as ScriptMuRef | null, ev.data));
    }
  }

  /** Current virtual time in seconds (continuous: accumulated `tick(dt)`). */
  get now(): number {
    return this.mode === 'des' ? this.scheduler.now : this.virtualNow;
  }

  /** True after `dispose()` — the adapter never ticks or dispatches again. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Attach the component whose handlers this adapter drives. */
  attach(component: SdkComponent): void {
    if (this.mode === 'des' && component.source !== undefined) {
      const errors = lintDesSafety(component.source, { desSafe: true, checkState: true })
        .filter(d => d.rule === 'des-script-undeclared-state');
      if (errors.length && this.lintPolicy === 'warn') {
        // plan-2212 F7: not declared DesSafe → the finding is a warning, the
        // script keeps running on the DES clock (a snapshot may still refuse it).
        this.onLintWarning('des-script-undeclared-state',
          `${snapshotUserMessage('des-script-undeclared-state').text} ${errors[0].message}`);
        // plan-2212 Phase 3: the closure state the check found is not captured -
        // a DES snapshot of this script refuses visibly instead of losing it.
        this.undeclaredStateFinding = errors[0].message;
      } else if (errors.length) {
        component.disable(`${snapshotUserMessage('des-script-undeclared-state').text} [des-script-undeclared-state] ${errors[0].message}`);
        this.component = null;
        throw Object.assign(new Error(errors[0].message), { code: 'des-script-undeclared-state', userMessage: snapshotUserMessage('des-script-undeclared-state').text });
      }
    }
    this.component = component;
    this.liveGeometry = null;
  }

  /**
   * plan-2212 Phase 3: the undeclared-state finding of a script that runs on the
   * DES clock under the `'warn'` lint policy, else null. Such a script keeps
   * running, but its undeclared closure state cannot be captured: a DES snapshot
   * refuses it (`des-script-undeclared-state`) instead of losing that state.
   */
  get undeclaredState(): string | null {
    return this.undeclaredStateFinding;
  }

  /** Detach the current component (its handlers are no longer invoked). */
  detach(): void {
    this.component = null;
    this.liveGeometry = null;
  }

  /**
   * Auto-teardown terminus for the adapter (phase 2): clears every pending
   * heap event, detaches the component and refuses any further tick/dispatch.
   * A disposed adapter can never deliver a ghost hook into a swapped-in
   * successor instance (§10). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.heap.clear();
    try { this.scheduler.everyTimers?.cancelAll(); } catch { /* kernel already gone */ }
    this.component = null;
  }

  /**
   * Continuous fixed tick: advance virtual time, drain due timer events
   * (`time <= now`), then run the optional `continuous.fixedUpdate(dt)`.
   *
   * DES mode (plan-2212 Phase 4 — "frame hooks: display only, never state"):
   * the DES runner owns time, so nothing advances or drains here. While the
   * run animates (`displayFrames()`), `continuous.fixedUpdate(dt)` still runs
   * for DISPLAY: `self.now` is the DES time, reads work, and every host op
   * that would change DES state or results is refused (timers, setState,
   * statValue/stat, signal/component/scene writes, subscriptions, material
   * flow — see `DISPLAY_HOST_OPS`); the `self.random()` position is put back
   * afterwards. In FastForward and in a batch the frame hooks are not called
   * at all, so a run's state and KPIs are the same in every profile.
   */
  tick(dt: number): void {
    if (this.disposed) return;
    if (this.mode === 'des') {
      if (this.displayFrames?.() === true) this.invokeDisplay('continuous.fixedUpdate', dt);
      return;
    }
    this.virtualNow += scaleSimDt(dt);
    this.heap.drainUntil(this.virtualNow);
    this.invoke('continuous.fixedUpdate', dt);
  }

  /** Optional late pass (`continuous.lateFixedUpdate`); DES mode: display only, like {@link tick}. */
  lateTick(dt: number): void {
    if (this.disposed) return;
    if (this.mode === 'des') {
      if (this.displayFrames?.() === true) this.invokeDisplay('continuous.lateFixedUpdate', dt);
      return;
    }
    this.invoke('continuous.lateFixedUpdate', dt);
  }

  /** Host ops refused in DES frame hooks so far (plan-2212 Phase 4; tests / diagnostics). */
  get displayWriteRefusals(): number {
    return this.displayRefusals;
  }

  /** Forward a signal edge to the script's optional `onSignal(name, value)`. */
  onSignal(name: string, value: boolean | number): void {
    this.invoke('onSignal', name, value);
  }

  /**
   * plan-2212: the component was minted with `seed` as its initial RNG seed
   * (`env.seed`, set before `setup()` ran). A following `setRunRngSeed(seed)`
   * of the same run then leaves the stream alone instead of restarting it.
   */
  markRunSeeded(seed: number): void {
    if (this.disposed) return;
    this.runRngSeed = seed;
    this.seededByReset = true;
    this.appliedByReset = seed;
    this.v2Seeded = true;
  }

  /** Select the run seed, or restore the path seed when returning to v1. */
  setRunRngSeed(seed: number | null, next?: () => number | null): void {
    const c = this.component;
    if (this.disposed || !c) return;
    this.runRngSeed = seed;
    this.nextRunRngSeed = next;
    const alreadySeeded = seed !== null && this.seededByReset && seed === this.appliedByReset;
    this.seededByReset = false;
    if (alreadySeeded) return;
    if (seed !== null) {
      c.callHandler('__rv.rng.set', seed | 0);
      this.v2Seeded = true;
    } else if (this.v2Seeded) {
      const initial = c.callHandler('__rv.rng.initial');
      if (initial.ok && typeof initial.value === 'number') c.callHandler('__rv.rng.set', initial.value | 0);
      this.v2Seeded = false;
    }
  }

  /** Reset: clear pending timers, zero the clock, call optional `onReset()`. */
  reset(): void {
    if (this.disposed) return;
    this.heap.clear();
    // Continuous: the cleared heap held the pending every slices - drop their
    // (now dead) records. DES: the queue is the runner's, records stay.
    if (this.mode === 'continuous') {
      this.scheduler.everyTimers?.clear();
      const c = this.component;
      if (c && c.ok && c.hasHandler('__rv.every.clear')) c.callHandler('__rv.every.clear');
    }
    this.virtualNow = 0;
    const seed = this.nextRunRngSeed ? this.nextRunRngSeed() : this.runRngSeed;
    this.seededByReset = false;
    if (seed !== null) {
      this.setRunRngSeed(seed, this.nextRunRngSeed);
      this.seededByReset = true;
      this.appliedByReset = seed;
    }
    this.invoke('onReset');
  }

  /**
   * True when the attached script declares any DES-dispatched handler
   * (`des.on` timer hooks or the station handshake handlers). Conservative:
   * an adapter with NO component attached yet reports `true` (unknown — the
   * handlers may still arrive), a disposed or failed component `false`.
   *
   * The private DES runner uses this for the FastForward settle gating: script
   * hooks dispatch OUTSIDE the MaterialFlowAdapter path and have no
   * `samplesLiveGeometry` opt-in channel, so while at least one active script
   * component with DES hooks exists the per-event-time tween settle stays on.
   */
  hasDesHooks(): boolean {
    if (this.disposed) return false;
    const c = this.component;
    if (!c) return true; // not attached yet → conservative
    if (!c.ok) return false; // failed VM never dispatches
    return (
      c.hasHandler('des.on')
      || c.hasHandler('des.canAccept')
      || c.hasHandler('des.onAccept')
      || c.hasHandler('des.onDownstreamReady')
    );
  }

  /**
   * plan-2212 Phase 4b (A): true when this script may read LIVE geometry and the
   * DES runner must therefore settle running tweens at every event time.
   * The exact settle gate that replaced counting every script with DES hooks:
   *  - unattached → true (unknown, conservative); disposed / failed VM → false;
   *  - no DES-dispatched handler ({@link hasDesHooks} false) → false;
   *  - the script declares `des: { samplesLiveGeometry: true }` → true (opt-in);
   *  - otherwise the conservative static check of its source decides
   *    (`desScriptMayReadLiveGeometry`): false ONLY when the source provably uses
   *    nothing that can reach a transform; no source / check not loaded → true.
   * Decided once per attached component (the source and the opt-in are fixed).
   */
  samplesLiveGeometry(): boolean {
    if (this.disposed) return false;
    const c = this.component;
    if (!c) return true;
    if (!c.ok) return false;
    if (!this.hasDesHooks()) return false;
    if (this.liveGeometry === null) this.liveGeometry = this.decideLiveGeometry(c);
    return this.liveGeometry;
  }

  private decideLiveGeometry(c: SdkComponent): boolean {
    if (c.hasHandler('__rv.des.samplesLiveGeometry')) {
      const optIn = c.callHandler('__rv.des.samplesLiveGeometry');
      if (!optIn.ok || optIn.value !== false) return true;   // opted in, or unreadable → settle
    }
    if (typeof c.source !== 'string') return true;
    return desScriptMayReadLiveGeometry(c.source).mayRead;
  }

  /**
   * Deliver a due hook event into the VM (`des.on(hook, mu, data)`).
   * IMPLEMENTS ScriptHookDispatcher — called by the continuous heap drain AND
   * by the private DES `Script.Hook` action.
   */
  dispatchScriptHook(hook: string, mu: ScriptMuRef | null, data?: unknown): void {
    if (this.disposed) return;
    if (hook === RV_EVERY_HOOK) {
      // plan-2212 Phase 4c: a recurring slice. The host re-arms the next slice
      // BEFORE the user hook runs (the order the guest used); the guest looks up
      // hook + data under the pid (no payload crosses) and calls the user hook.
      // A script that cannot receive the slice (no VM, disabled) is not
      // re-armed - exactly like the former guest-side chain.
      const c = this.component;
      if (!c || !c.ok || !c.hasHandler('des.on')) return;
      const timers = this.scheduler.everyTimers;
      const pid = (data as { pid?: unknown } | null | undefined)?.pid;
      const rec = timers?.fire(pid);
      if (!rec) return;   // cancelled: stale slice
      const r = c.callHandler('des.on', RV_EVERY_HOOK, null, { pid: rec.pid }, this.now);
      if (!r.ok) {
        clearDispatchNow(c);
        if (r.error && r.error.name !== 'ContextDisabledError') this.onHandlerError('des.on', r.error.message);
      } else if (r.value === false) {
        // The guest holds no entry for this pid (one-sided record): drop it, deterministically.
        timers!.cancel(rec.pid);
      }
      return;
    }
    // plan-2212 Phase 4b (C): the current time rides along, so `self.now` inside
    // the dispatch needs no host call (same value: time does not move in a dispatch).
    this.invoke('des.on', hook, mu ?? null, data ?? null, this.now);
  }

  // ── DES station dispatch (phase 1b) ──────────────────────────────────────
  // The DES runner talks to a script component like to any material-flow
  // station: canAccept → onAccept → (later) onDownstreamReady. Ports cross as
  // value descriptors (`ScriptPortDesc`) — the guest hydrates them into full
  // `Port` handles whose reads resolve through the component's ports backend
  // by id (same snap-graph id space on both sides).

  /**
   * Back-pressure probe (`des.canAccept(mu, port)`). Defaults to TRUE when
   * the script declares no handler (accept-all, like a plain DES station);
   * FALSE when the handler fails (safe back-pressure).
   */
  stationCanAccept(mu: ScriptMuRef | null, port?: ScriptPortDesc | null): boolean {
    const c = this.component;
    if (this.disposed || !c || !c.ok) return false;
    if (!c.hasHandler('des.canAccept')) return true;
    const r = c.callHandler('des.canAccept', mu ?? null, port ?? null, this.now);
    if (!r.ok) {
      clearDispatchNow(c);
      if (r.error && r.error.name !== 'ContextDisabledError') {
        this.onHandlerError('des.canAccept', r.error.message);
      }
      return false;
    }
    return r.value !== false;
  }

  /**
   * Hand an MU to the component (`des.onAccept(mu, port)`). Returns the
   * handler's verdict (`false` = rejected); TRUE when no handler exists.
   */
  stationOnAccept(mu: ScriptMuRef | null, port?: ScriptPortDesc | null): boolean {
    const c = this.component;
    if (this.disposed || !c || !c.ok) return false;
    if (!c.hasHandler('des.onAccept')) return true;
    const r = c.callHandler('des.onAccept', mu ?? null, port ?? null, this.now);
    if (!r.ok) {
      clearDispatchNow(c);
      if (r.error && r.error.name !== 'ContextDisabledError') {
        this.onHandlerError('des.onAccept', r.error.message);
      }
      return false;
    }
    return r.value !== false;
  }

  /** A blocked output freed (`des.onDownstreamReady(port)`). */
  stationOnDownstreamReady(port?: ScriptPortDesc | null): void {
    const c = this.component;
    if (this.disposed || !c || !c.ok || !c.hasHandler('des.onDownstreamReady')) return;
    const r = c.callHandler('des.onDownstreamReady', port ?? null, this.now);
    if (!r.ok) clearDispatchNow(c);
    if (!r.ok && r.error && r.error.name !== 'ContextDisabledError') {
      this.onHandlerError('des.onDownstreamReady', r.error.message);
    }
  }

  // ── Snapshot / restore of the guest script state (plan-261 Phase 1) ──────

  /**
   * Capture the component's internal guest state for a DES snapshot:
   *  - `rng`: the seeded `self.random()` position (`_rs`, via `__rv.rng.get`),
   *  - `fsmState`: the `self.setState(...)` FSM state (via `__rv.state.get`),
   *  - `legacy`: the JSON value returned by the script's optional `onSnapshot()`
   *    hook — the ONLY supported channel for persistent closure state (B7:
   *    `self.prop` is read-only configuration in the QuickJS path and is never
   *    marshalled back to the host).
   *
   *  - `stats`: the rows published with `self.statValue` (plan-2212 Phase 3),
   *    so a restore shows the snapshot's KPI values before the next event.
   *
   * Returns null when the component is disposed / disabled / has no VM.
   */
  captureScriptState(): ScriptGuestState | null {
    const c = this.component;
    if (this.disposed || !c || !c.ok) return null;
    const rngRes = c.callHandler('__rv.rng.get');
    if (!rngRes.ok || typeof rngRes.value !== 'number') return null;
    const out: ScriptGuestState = { rng: rngRes.value | 0, timers: this.captureEveryTable(c) };
    const st = c.callHandler('__rv.state.get');
    if (st.ok && typeof st.value === 'string') out.fsmState = st.value;
    const captured = c.callHandler('__rv.persist.get');
    if (!captured.ok || typeof captured.value !== 'string') throw new Error(captured.error?.message ?? 'invalid guest snapshot text');
    // The host contract validation (allowlist/alias/codecs) runs again in the Script participant.
    const fields = JSON.parse(captured.value) as { persist?: unknown; legacy?: unknown };
    if ('persist' in fields) out.persist = fields.persist;
    if ('legacy' in fields) out.legacy = fields.legacy;
    const stats = c.bridge?.captureStatRows?.();
    if (stats && stats.length > 0) out.stats = stats;
    return out;
  }

  /**
   * Re-inject a captured guest state: RNG position and FSM state FIRST, then
   * the script's optional `onRestore(state)` hook (synchronous by contract).
   * Applied BEFORE any `onRestored()`-style follow-up so a hook that calls
   * `self.random()` continues the restored stream (no off-by-one).
   */
  restoreScriptState(saved: ScriptGuestState): void {
    const c = this.component;
    if (this.disposed || !c || !c.ok) return;
    const apply = (name: string, value: unknown) => {
      const result = c.callHandler(name, value);
      if (!result.ok) throw new Error(result.error?.message ?? `script restore failed: ${name}`);
    };
    apply('__rv.rng.set', saved.rng);
    if (typeof saved.fsmState === 'string') apply('__rv.state.set', saved.fsmState);
    if ('persist' in saved) apply('__rv.persist.set', JSON.stringify(saved.persist));
    // plan-2212 Phase 4c: one table, split by pid - the clock into the host records,
    // hook + data into the guest map. Format unchanged, so a pre-4c snapshot restores too.
    this.scheduler.everyTimers?.replace({ next: saved.timers.next,
      items: saved.timers.items.map(t => ({ pid: t.pid, interval: t.interval, hook: t.hook, current: t.current })) });
    if (c.hasHandler('__rv.every.set')) {
      apply('__rv.every.set', JSON.stringify(saved.timers.items.map(t => ({ pid: t.pid, hook: t.hook, data: t.data }))));
    }
    // plan-2212 Phase 3: the published KPI rows are state - written back before
    // `onRestore` (which may publish on top). No `stats` = none were published.
    c.bridge?.restoreStatRows?.(saved.stats ?? []);
    if ('legacy' in saved && c.hasHandler('onRestore')) apply('onRestore', saved.legacy);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * plan-2212 Phase 4c: the `self.every` table of a snapshot, joined by pid from
   * the host clock (interval, current slice, id counter) and the guest map (hook,
   * data - the trusted validator refuses a non-plain payload, as before 4c). The
   * format is the pre-4c one. A pid present on one side only is dropped
   * (deterministic, host creation order); a host record without guest data has
   * no data to restore - its queued slice is then refused by the queue check.
   */
  private captureEveryTable(c: SdkComponent): ScriptTimerTable {
    const host = this.scheduler.everyTimers?.export() ?? { next: 1, items: [] };
    let guest: { pid: number; hook: string; data: unknown }[] = [];
    if (c.hasHandler('__rv.every.get')) {
      // Live host pids only: a guest-only leftover (host record gone) is dropped
      // BEFORE validation, so its payload can never block the snapshot (review 2).
      const r = c.callHandler('__rv.every.get', host.items.map(rec => rec.pid));
      if (!r.ok || typeof r.value !== 'string') throw new Error(r.error?.message ?? 'invalid guest timer text');
      guest = JSON.parse(r.value) as typeof guest;
    }
    const byPid = new Map(guest.map(g => [g.pid, g] as const));
    const items: ScriptTimerTable['items'] = [];
    for (const rec of host.items) {
      const g = byPid.get(rec.pid);
      if (!g) continue;
      items.push({ pid: rec.pid, interval: rec.interval, hook: rec.hook, data: g.data, current: rec.current });
    }
    return { next: host.next, items };
  }

  /**
   * Run one DES frame hook behind the display-only fence (plan-2212 Phase 4):
   * the bridge refuses state-changing host ops, the guest RNG position is
   * restored, and a refused write is reported ONCE per instance as a
   * `des-frame-hook-write` warning — never as a handler failure, so it can
   * neither disable the script nor spam the log every frame.
   */
  private invokeDisplay(path: string, ...args: unknown[]): void {
    const c = this.component;
    if (!c || !c.ok || !c.hasHandler(path)) return;
    const rng = c.callHandler('__rv.rng.get');
    c.bridge.setDisplayOnly(true);
    let r: ReturnType<SdkComponent['callHandler']>;
    try {
      r = c.callHandler(path, ...args);
    } finally {
      c.bridge.setDisplayOnly(false);
    }
    if (rng.ok && typeof rng.value === 'number') {
      const after = c.callHandler('__rv.rng.get');
      if (!after.ok || after.value !== rng.value) c.callHandler('__rv.rng.set', rng.value);
    }
    const refused = c.bridge.takeDisplayRefusals();
    if (refused.length > 0) {
      this.displayRefusals += refused.length;
      if (!this.warnedDisplayWrite) {
        this.warnedDisplayWrite = true;
        this.onLintWarning(DES_FRAME_HOOK_WRITE_CODE,
          `frame hook '${path}' tried to change state during a DES run (${[...new Set(refused)].join(', ')}); `
          + 'frame hooks are display only there - move the change into a DES event (self.in/at/every, sink/sensor callbacks).');
      }
      return;
    }
    if (!r.ok && r.error && r.error.name !== 'ContextDisabledError') {
      this.onHandlerError(path, r.error.message);
    }
  }

  private invoke(path: string, ...args: unknown[]): void {
    const c = this.component;
    if (!c || !c.ok || !c.hasHandler(path)) return;
    const r = c.callHandler(path, ...args);
    if (!r.ok && path === 'des.on') clearDispatchNow(c);
    if (!r.ok && r.error && r.error.name !== 'ContextDisabledError') {
      this.onHandlerError(path, r.error.message);
    }
  }
}

/**
 * plan-2212 Phase 4b (C): after a FAILED dispatch, drop the guest's dispatch
 * time. An uncatchable abort (call deadline) skips the guest's own `finally`;
 * without this `self.now` could answer a stale time outside a dispatch.
 */
function clearDispatchNow(c: SdkComponent): void {
  if (c.hasHandler('__rv.dispatch.clear')) c.callHandler('__rv.dispatch.clear');
}
