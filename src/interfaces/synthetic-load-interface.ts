// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SyntheticLoadInterface — in-browser signal load generator (plan-465, F4a).
 *
 * DEV-ONLY. Registered only behind an `import.meta.env.DEV` guard, so it costs
 * 0 KB in a production bundle.
 *
 * Purpose: isolate the SignalStore's own cost. The CONNECT cell measures the
 * whole chain (MQTT publisher -> worker -> WebSocket -> coalescing -> flush ->
 * store), which is the number that matters to a customer but which cannot say
 * WHERE the time goes. This interface produces the same store traffic with no
 * network at all, so the difference between the two cells is the transport.
 *
 * It is a real {@link BaseIndustrialInterface} rather than a loop calling
 * `store.setMany` directly, precisely so it travels the production buffer/flush
 * path — `bufferIncoming()` into `pendingIncoming`, committed in
 * `onFixedUpdatePre` (base-industrial-interface.ts). Measuring a shortcut would
 * measure the shortcut.
 *
 * With `lineSignals` configured it also acts as a stand-in PLC for the synthetic
 * line: it toggles `LINE/PLC<p>/Conv<i>/Run` on the same rhythm the Python
 * publisher uses, so the `load=browser` matrix column exercises the same
 * component bindings as `load=connect`.
 */

import {
  BaseIndustrialInterface,
  type SignalDescriptor,
} from './base-industrial-interface';
import type { InterfaceSettings } from './interface-settings-store';

/** Signal-name prefix owned by the load generator. */
export const SYNTHETIC_LOAD_PREFIX = 'LOAD/';

export interface SyntheticLoadConfig {
  /** Simulated PLCs — filler signals are spread evenly across them. */
  plcs: number;
  /** Filler signals per PLC. */
  signalsPerPlc: number;
  /** Cycle time in ms; one batch is produced per cycle. */
  cycleMs: number;
  /** Fraction of the filler signals that actually change per cycle (0..1). */
  changeRatio: number;
  /**
   * Line signals to drive like a PLC would (`LINE/PLC<p>/Conv<i>/Run`).
   * Empty = pure store load with no component effect.
   */
  lineSignals: string[];
  /** Seconds a conveyor is held stopped when its turn comes. */
  stopSeconds: number;
  /** Seconds between two stop events on the same conveyor. */
  stopPeriodSeconds: number;
}

export const DEFAULT_SYNTHETIC_LOAD: SyntheticLoadConfig = {
  plcs: 2,
  signalsPerPlc: 500,
  cycleMs: 50,
  changeRatio: 0.2,
  lineSignals: [],
  stopSeconds: 2,
  stopPeriodSeconds: 10,
};

/** What the runner reads back to separate "produced" from "arrived". */
export interface SyntheticLoadStats {
  /** Cycles executed since `resetStats()`. */
  cycles: number;
  /** Signal writes handed to `bufferIncoming` (the PRODUCED rate). */
  produced: number;
  /** Signal writes actually committed to the store (post-dedup ARRIVED rate). */
  committed: number;
  /** Flush durations in ms, most recent first is not guaranteed — use the sum/count. */
  flushMsTotal: number;
  flushes: number;
  flushMsMax: number;
  /** Wall ms since `resetStats()`. */
  elapsedMs: number;
}

export class SyntheticLoadInterface extends BaseIndustrialInterface {
  readonly id = 'synthetic-load';
  readonly protocolName = 'Synthetic Load (dev)';

  config: SyntheticLoadConfig = { ...DEFAULT_SYNTHETIC_LOAD };

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _cursor = 0;
  private _cycles = 0;
  private _produced = 0;
  private _committed = 0;
  private _flushMsTotal = 0;
  private _flushes = 0;
  private _flushMsMax = 0;
  private _startedAt = 0;
  /** Preallocated batch object — the cycle must not allocate a fresh record. */
  private readonly _batch: Record<string, boolean | number> = {};
  private _names: string[] = [];

  configure(cfg: Partial<SyntheticLoadConfig>): void {
    this.config = { ...this.config, ...cfg };
    this._names = [];
    for (let plc = 0; plc < this.config.plcs; plc++) {
      for (let k = 0; k < this.config.signalsPerPlc; k++) {
        this._names.push(`${SYNTHETIC_LOAD_PREFIX}PLC${plc}/S${k}`);
      }
    }
  }

  /** Signal names this generator owns (filler only — line signals are foreign). */
  get signalNames(): readonly string[] { return this._names; }

  protected async doConnect(_settings: InterfaceSettings): Promise<void> {
    if (this._names.length === 0) this.configure({});
    this.resetStats();
    this.startTimer();
  }

  protected doDisconnect(): void {
    this.stopTimer();
  }

  /** Nothing leaves the browser — outgoing writes are counted and dropped. */
  protected sendSignals(_signals: Record<string, boolean | number>): void { /* no remote side */ }

  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    if (this._names.length === 0) this.configure({});
    return this._names.map((name) => ({
      name,
      type: 'float' as const,
      // PLC output = the PLC writes it, the viewer reads it. That is what a load
      // generator simulates, and it keeps the base class from subscribing the
      // store back to us (which would turn every write into an echo).
      direction: 'output' as const,
      initialValue: 0,
    }));
  }

  /**
   * Flush timing: the base implementation commits `pendingIncoming` into the
   * store. Wrapping it here is the only place where "how long does a batch of
   * N changes cost the store" can be measured against the real commit path.
   */
  override onFixedUpdatePre(dt: number): void {
    const pending = this.pendingIncoming.size;
    if (pending === 0) { super.onFixedUpdatePre(dt); return; }
    const t0 = performance.now();
    super.onFixedUpdatePre(dt);
    const ms = performance.now() - t0;
    this._committed += pending;
    this._flushMsTotal += ms;
    this._flushes++;
    if (ms > this._flushMsMax) this._flushMsMax = ms;
  }

  private startTimer(): void {
    this.stopTimer();
    this._timer = setInterval(() => this.cycle(), this.config.cycleMs);
  }

  private stopTimer(): void {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * One PLC scan: write `changeRatio * N` filler signals plus, when configured,
   * the line's Run bits. The cursor walks the name list so every signal is
   * touched in turn instead of hammering the same few — a store keyed by name
   * behaves differently for 100 hot keys than for 1000 rotating ones.
   */
  private cycle(): void {
    const cfg = this.config;
    const names = this._names;
    for (const key in this._batch) delete this._batch[key];

    const changes = Math.max(1, Math.round(names.length * cfg.changeRatio));
    for (let i = 0; i < changes && names.length > 0; i++) {
      const name = names[this._cursor];
      this._cursor = (this._cursor + 1) % names.length;
      this._batch[name] = this._cycles + i;
      this._produced++;
    }

    if (cfg.lineSignals.length > 0) {
      const periodCycles = Math.max(1, Math.round((cfg.stopPeriodSeconds * 1000) / cfg.cycleMs));
      const stopCycles = Math.max(1, Math.round((cfg.stopSeconds * 1000) / cfg.cycleMs));
      const phase = this._cycles % periodCycles;
      // One conveyor at a time is stopped, rotating through the list — a global
      // stop would drain the line and destroy steady state.
      const victim = Math.floor(this._cycles / periodCycles) % cfg.lineSignals.length;
      for (let i = 0; i < cfg.lineSignals.length; i++) {
        this._batch[cfg.lineSignals[i]] = !(i === victim && phase < stopCycles);
        this._produced++;
      }
    }

    this.bufferIncoming(this._batch);
    this._cycles++;
  }

  resetStats(): void {
    this._cycles = 0;
    this._produced = 0;
    this._committed = 0;
    this._flushMsTotal = 0;
    this._flushes = 0;
    this._flushMsMax = 0;
    this._startedAt = performance.now();
  }

  stats(): SyntheticLoadStats {
    return {
      cycles: this._cycles,
      produced: this._produced,
      committed: this._committed,
      flushMsTotal: this._flushMsTotal,
      flushes: this._flushes,
      flushMsMax: this._flushMsMax,
      elapsedMs: performance.now() - this._startedAt,
    };
  }

  override dispose(): void {
    this.stopTimer();
    super.dispose();
  }
}
