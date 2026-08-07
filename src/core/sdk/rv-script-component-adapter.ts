// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

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

import type { SdkComponent } from './rv-component-sdk';
import { RVEventHeap } from './rv-event-heap';
import {
  createHeapScheduler,
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
  /** Continuous mode: inject a heap (tests); default: the adapter owns one. */
  heap?: RVEventHeap;
  /** Reports handler failures (default: console.warn). Disable decisions stay
   *  with the poison backoff — a plain guest exception does NOT disable. */
  onHandlerError?: (path: string, message: string) => void;
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
  private readonly onHandlerError: (path: string, message: string) => void;

  constructor(opts: ScriptComponentAdapterOptions = {}) {
    this.mode = opts.mode ?? 'continuous';
    this.heap = opts.heap ?? new RVEventHeap();
    this.onHandlerError = opts.onHandlerError
      ?? ((path, message) => console.warn(`[sdk-adapter] handler '${path}' failed: ${message}`));

    if (this.mode === 'des') {
      if (!opts.desScheduler) {
        throw new Error('RVScriptComponentAdapter: DES mode requires a desScheduler (private ScriptHook backend)');
      }
      this.scheduler = opts.desScheduler;
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
    this.component = component;
  }

  /** Detach the current component (its handlers are no longer invoked). */
  detach(): void {
    this.component = null;
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
    this.component = null;
  }

  /**
   * Continuous fixed tick: advance virtual time, drain due timer events
   * (`time <= now`), then run the optional `continuous.fixedUpdate(dt)`.
   * No-op in DES mode (the DES runner owns time there).
   */
  tick(dt: number): void {
    if (this.mode === 'des' || this.disposed) return;
    this.virtualNow += dt;
    this.heap.drainUntil(this.virtualNow);
    this.invoke('continuous.fixedUpdate', dt);
  }

  /** Optional late pass (`continuous.lateFixedUpdate`). */
  lateTick(dt: number): void {
    if (this.mode === 'des' || this.disposed) return;
    this.invoke('continuous.lateFixedUpdate', dt);
  }

  /** Forward a signal edge to the script's optional `onSignal(name, value)`. */
  onSignal(name: string, value: boolean | number): void {
    this.invoke('onSignal', name, value);
  }

  /** Reset: clear pending timers, zero the clock, call optional `onReset()`. */
  reset(): void {
    if (this.disposed) return;
    this.heap.clear();
    this.virtualNow = 0;
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
   * Deliver a due hook event into the VM (`des.on(hook, mu, data)`).
   * IMPLEMENTS ScriptHookDispatcher — called by the continuous heap drain AND
   * by the private DES `Script.Hook` action.
   */
  dispatchScriptHook(hook: string, mu: ScriptMuRef | null, data?: unknown): void {
    if (this.disposed) return;
    this.invoke('des.on', hook, mu ?? null, data ?? null);
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
    const r = c.callHandler('des.canAccept', mu ?? null, port ?? null);
    if (!r.ok) {
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
    const r = c.callHandler('des.onAccept', mu ?? null, port ?? null);
    if (!r.ok) {
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
    const r = c.callHandler('des.onDownstreamReady', port ?? null);
    if (!r.ok && r.error && r.error.name !== 'ContextDisabledError') {
      this.onHandlerError('des.onDownstreamReady', r.error.message);
    }
  }

  // ── Snapshot / restore of the guest script state (plan-261 Phase 1) ──────

  /**
   * Capture the component's internal guest state for a DES snapshot:
   *  - `rng`: the seeded `self.random()` position (`_rs`, via `__rv.rng.get`),
   *  - `fsmState`: the `self.setState(...)` FSM state (via `__rv.state.get`),
   *  - `state`: the JSON value returned by the script's optional `onSnapshot()`
   *    hook — the ONLY supported channel for persistent closure state (B7:
   *    `self.prop` is read-only configuration in the QuickJS path and is never
   *    marshalled back to the host).
   *
   * Returns null when the component is disposed / disabled / has no VM.
   */
  captureScriptState(): { rng: number; fsmState?: string; state?: unknown } | null {
    const c = this.component;
    if (this.disposed || !c || !c.ok) return null;
    const rngRes = c.callHandler('__rv.rng.get');
    if (!rngRes.ok || typeof rngRes.value !== 'number') return null;
    const out: { rng: number; fsmState?: string; state?: unknown } = { rng: rngRes.value | 0 };
    const st = c.callHandler('__rv.state.get');
    if (st.ok && typeof st.value === 'string') out.fsmState = st.value;
    if (c.hasHandler('onSnapshot')) {
      const r = c.callHandler('onSnapshot');
      if (r.ok) out.state = r.value ?? null;
      else if (r.error && r.error.name !== 'ContextDisabledError') {
        this.onHandlerError('onSnapshot', r.error.message);
      }
    }
    return out;
  }

  /**
   * Re-inject a captured guest state: RNG position and FSM state FIRST, then
   * the script's optional `onRestore(state)` hook (synchronous by contract).
   * Applied BEFORE any `onRestored()`-style follow-up so a hook that calls
   * `self.random()` continues the restored stream (no off-by-one).
   */
  restoreScriptState(saved: { rng: number; fsmState?: string; state?: unknown }): void {
    const c = this.component;
    if (this.disposed || !c || !c.ok) return;
    this.invoke('__rv.rng.set', saved.rng | 0);
    if (typeof saved.fsmState === 'string') this.invoke('__rv.state.set', saved.fsmState);
    if (saved.state !== undefined && c.hasHandler('onRestore')) {
      this.invoke('onRestore', saved.state ?? null);
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private invoke(path: string, ...args: unknown[]): void {
    const c = this.component;
    if (!c || !c.ok || !c.hasHandler(path)) return;
    const r = c.callHandler(path, ...args);
    if (!r.ok && r.error && r.error.name !== 'ContextDisabledError') {
      this.onHandlerError(path, r.error.message);
    }
  }
}
