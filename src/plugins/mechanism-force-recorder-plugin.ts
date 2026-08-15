// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MechanismForceRecorderPlugin — the force-over-time record behind the drive
 * sizing panel (plan-412 §2.6, Phase 4/5).
 *
 * ── Why a recorder and not the panel bridge ─────────────────────────────────
 * The Mechanism section polls `MechanismUiBridge.list()` every 500 ms for
 * structure and convergence. Running the SERIES through that same poll was
 * plan-412's Alternative 5 and it was rejected: at 500 ms a 10 Hz recording
 * loses four samples out of five, and a peak that lands between two polls is a
 * peak the user never sees — in a feature whose entire purpose is to report the
 * peak. So the ring buffers live here, on the recorder's own clock, and the
 * bridge is asked only for the CURRENT tick's values.
 *
 * ── What "current" means ────────────────────────────────────────────────────
 * `forcesSnapshot()` reads what the last fixed step already computed; it never
 * triggers a solve. The recorder therefore cannot change the numbers by
 * observing them, and the arrows, the chart and the sizing figures all read the
 * same tick.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 * Lazily registered on first use (the `ensureSensorRecorder` pattern,
 * `SensorChartOverlay.tsx`). A model switch clears everything: series ids are
 * node paths, and a path that means a different joint in a different model would
 * silently continue somebody else's curve. A `stop()` does NOT clear — the last
 * cycle stays on screen until the next run, which is the whole point of
 * recording it (§3.3).
 *
 * ── Recording follows the TEST SESSION, and it does so HERE (plan-706 F13) ───
 * That coupling used to live in a React `useEffect` inside
 * `MechanismForceChart.tsx`, and that component renders only inside the expanded
 * Mechanism row of the Quick Edit panel. The consequence was a defect rather
 * than a design: a test session started any other way — notably by an agent
 * through `web_editor_test_start` — recorded NOTHING, because the only thing
 * listening was a component nobody had opened.
 *
 * So the subscription sits in the plugin's `init`, where it holds regardless of
 * what is rendered. There is exactly ONE trigger for recording, and it is the
 * session state; the panel keeps its manual toggle and otherwise only MIRRORS
 * `recorder.recording`.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { RingBuffer } from '../core/engine/rv-ring-buffer';
import {
  getMechanismUiBridge,
  type MechanismForcesSnapshot,
} from '../core/engine/rv-kinematic-registry';
import { getTestSessionState, subscribeTestSession } from '@rv-private/plugins/asset-editor/test-session-store';

/** Plugin id — the panel looks the recorder up under this. */
export const MECHANISM_FORCE_RECORDER_ID = 'mechanism-force-recorder';

/** Samples kept per series. 3000 at 10 Hz = five minutes of run time. */
export const FORCE_BUFFER_CAPACITY = 3000;

/** Sampling rate in Hz — the same divider the sensor recorder uses. */
export const FORCE_SAMPLE_RATE = 10;

/** One recorded scalar channel. */
export interface ForceSeries {
  /** Stable id from the bridge — unique across mechanisms. */
  readonly id: string;
  readonly mechanismPath: string;
  label: string;
  kind: 'drive' | 'joint-force' | 'joint-torque';
  unit: 'N' | 'N·m';
  /** Samples, aligned index-for-index with {@link MechanismForceRecorder.timeBuffer}. */
  readonly values: RingBuffer<number>;
}

/** The three sizing figures plan-412 §2.3.2 defines. */
export interface ForceMetrics {
  /** `max |τ|` over the window. */
  peak: number;
  /** Time-weighted `sqrt( Σ τᵢ²·Δtᵢ / Σ Δtᵢ )`. */
  rms: number;
  /** From the statics export only — never from a dynamic zero crossing. */
  holding: number | null;
  /** Finite samples the figures were computed from. */
  sampleCount: number;
  unit: 'N' | 'N·m';
}

const EMPTY_METRICS: ForceMetrics = {
  peak: 0, rms: 0, holding: null, sampleCount: 0, unit: 'N·m',
};

/**
 * Ring buffers plus the three sizing figures. Deliberately free of any viewer
 * or bridge reference: the arithmetic in {@link metrics} is the part that has to
 * be right, and it is testable with a hand-written sequence.
 */
export class MechanismForceRecorder {
  /** Simulation seconds at each sample. Shared by every series. */
  readonly timeBuffer: RingBuffer<number>;
  readonly series: ForceSeries[] = [];

  private readonly _byId = new Map<string, ForceSeries>();
  private readonly _holding = new Map<string, number>();
  private readonly _capacity: number;
  private readonly _interval: number;
  private _elapsed = 0;
  private _sinceLast = 0;
  private _recording = false;
  private _paused = false;

  constructor(capacity = FORCE_BUFFER_CAPACITY, sampleRate = FORCE_SAMPLE_RATE) {
    this._capacity = capacity;
    this._interval = 1 / sampleRate;
    this.timeBuffer = new RingBuffer<number>(capacity);
  }

  /** True while samples are actually being taken (armed and not paused). */
  get recording(): boolean { return this._recording && !this._paused; }
  /** True when a window is open but frozen. */
  get paused(): boolean { return this._paused; }
  /** Simulation seconds accumulated since the last {@link clear}. */
  get elapsed(): number { return this._elapsed; }

  /**
   * Begin a window. The elapsed clock restarts, because a chart whose x axis
   * counts from the last model load rather than from the run the user just
   * started is a chart nobody can read a cycle time off.
   */
  start(): void {
    this.clear();
    this._recording = true;
    this._paused = false;
  }

  /**
   * Freeze the window. Neither the samples nor the figures are discarded —
   * "what did that cycle need?" is a question asked AFTER the cycle.
   */
  stop(): void {
    this._recording = false;
    this._paused = false;
  }

  /**
   * Pause: no samples and NO TIME (§2.3.2). Advancing the clock through a pause
   * would stretch one Δt across the whole break and let a single sample outvote
   * the entire rest of the run in the time-weighted RMS.
   */
  setPaused(paused: boolean): void {
    this._paused = paused;
  }

  /**
   * Take one fixed step. `supply` is only invoked on an actual sample tick, so
   * the bridge is queried at 10 Hz and not at 60.
   */
  sample(dt: number, supply: () => readonly MechanismForcesSnapshot[]): void {
    if (!this.recording) return;
    this._elapsed += dt;
    this._sinceLast += dt;
    if (this._sinceLast < this._interval) return;
    this._sinceLast -= this._interval;

    const snapshots = supply();
    const seen = new Set<string>();
    this.timeBuffer.push(this._elapsed);

    for (const snapshot of snapshots) {
      // An invalid snapshot still gets a sample — as a GAP. Skipping it entirely
      // would slide every later value one slot along the shared time buffer and
      // silently re-date the whole curve.
      for (const channel of snapshot.channels) {
        const series = this._ensureSeries(snapshot.mechanismPath, channel.id, channel.label,
          channel.kind, channel.unit);
        series.values.push(snapshot.dynamicsValid ? channel.value : Number.NaN);
        seen.add(channel.id);
      }
    }

    // A series that vanished this tick (its mechanism was removed) keeps its
    // alignment with the time buffer instead of freezing at its last value.
    for (const series of this.series) {
      if (!seen.has(series.id)) series.values.push(Number.NaN);
    }
  }

  /** Record a holding figure from a statics evaluation (F8). */
  setHolding(seriesId: string, value: number): void {
    this._holding.set(seriesId, Math.abs(value));
  }

  /** Drop every holding figure — a new pose makes the old ones wrong. */
  clearHolding(): void {
    this._holding.clear();
  }

  getSeries(seriesId: string): ForceSeries | undefined {
    return this._byId.get(seriesId);
  }

  /** Every series belonging to one mechanism (the panel's namespace filter). */
  seriesFor(mechanismPath: string): ForceSeries[] {
    return this.series.filter((s) => s.mechanismPath === mechanismPath);
  }

  /**
   * Peak and time-weighted RMS over the recorded window (§2.3.2).
   *
   * Δtᵢ is the REAL distance to the previous sample and the value at the later
   * end of that interval carries it (a right-endpoint sum). Uniform sampling
   * makes that identical to the naive mean of squares; non-uniform sampling —
   * a dropped frame, a pause, a mechanism that only became valid mid-run — is
   * exactly where the naive version starts over-weighting whichever samples
   * happened to be dense, which for a duty-cycle figure is the difference
   * between a motor that fits and one that overheats.
   *
   * NaN samples are gaps, not zeros: they are skipped, and so is the interval
   * that ends on one.
   */
  metrics(seriesId: string): ForceMetrics {
    const series = this._byId.get(seriesId);
    if (!series) return { ...EMPTY_METRICS, holding: this._holding.get(seriesId) ?? null };

    const times = this.timeBuffer.toArray();
    const values = series.values.toArray();
    // Both buffers wrap independently; only the overlapping tail is aligned.
    const n = Math.min(times.length, values.length);
    const tOffset = times.length - n;
    const vOffset = values.length - n;

    let peak = 0;
    let weighted = 0;
    let totalDt = 0;
    let count = 0;
    let lastTime: number | null = null;

    for (let i = 0; i < n; i++) {
      const t = times[tOffset + i];
      const v = values[vOffset + i];
      if (!Number.isFinite(v)) { lastTime = Number.isFinite(t) ? t : lastTime; continue; }
      count++;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
      if (lastTime !== null) {
        const dt = t - lastTime;
        if (dt > 0) {
          weighted += v * v * dt;
          totalDt += dt;
        }
      }
      lastTime = t;
    }

    // A single sample has no interval to weight; its own magnitude is the only
    // honest RMS, and reporting 0 there would read as "this axis is unloaded".
    const rms = totalDt > 0 ? Math.sqrt(weighted / totalDt) : peak;
    return {
      peak,
      rms: count === 0 ? 0 : rms,
      holding: this._holding.get(seriesId) ?? null,
      sampleCount: count,
      unit: series.unit,
    };
  }

  /** Drop every buffer, series and figure. Model switch and rebuild. */
  clear(): void {
    this.timeBuffer.clear();
    this.series.length = 0;
    this._byId.clear();
    this._holding.clear();
    this._elapsed = 0;
    this._sinceLast = 0;
  }

  private _ensureSeries(
    mechanismPath: string, id: string, label: string,
    kind: ForceSeries['kind'], unit: ForceSeries['unit'],
  ): ForceSeries {
    const existing = this._byId.get(id);
    if (existing) {
      existing.label = label;
      existing.unit = unit;
      return existing;
    }
    const series: ForceSeries = {
      id, mechanismPath, label, kind, unit,
      values: new RingBuffer<number>(this._capacity),
    };
    // A series discovered mid-run is padded so index i still means time[i].
    // Without this, a mechanism created later would draw its curve shifted
    // backwards onto somebody else's timestamps.
    const missing = Math.max(0, this.timeBuffer.count - 1);
    for (let i = 0; i < missing; i++) series.values.push(Number.NaN);
    this._byId.set(id, series);
    this.series.push(series);
    return series;
  }
}

/**
 * The viewer plugin around {@link MechanismForceRecorder}: it owns the sampling
 * tick, arms the private-side analysis, and knows which mechanisms exist.
 */
export class MechanismForceRecorderPlugin implements RVViewerPlugin {
  readonly id = MECHANISM_FORCE_RECORDER_ID;
  readonly recorder = new MechanismForceRecorder();

  /** Mechanism node paths this recorder is armed on. */
  private _paths: string[] = [];

  private _unsubSession: (() => void) | null = null;
  /** Last observed session state — only the TRANSITION into/out of `running` acts. */
  private _wasRunning = false;

  /**
   * Subscribe to the in-place test session (plan-706 F13).
   *
   * Two guards, and both are load-bearing:
   *
   *  * **Only the TRANSITION acts.** Re-running `start()` while the session
   *    merely stays `running` would clear the ring buffers on every
   *    notification, which is indistinguishable from never recording at all.
   *  * **Idempotent against the session's own call.** `InPlaceTestSession`
   *    already starts and stops the recorder directly (`recordForces`, added by
   *    the "the test run owns force recording" fix). This subscription is the
   *    same RULE — recording follows the session — expressed where nothing has
   *    to be rendered for it to hold, and it must therefore converge with that
   *    call rather than fight it: starting an already-recording window would
   *    wipe the samples the direct call just began collecting.
   *
   * The two are redundant on the normal path today. That is deliberate for now
   * (the direct call lives outside this plan's scope); it is safe because both
   * express the identical rule and neither can act twice.
   */
  init(_viewer: RVViewer): void {
    this._wasRunning = getTestSessionState() === 'running';
    this._unsubSession = subscribeTestSession(() => {
      const running = getTestSessionState() === 'running';
      if (running === this._wasRunning) return;
      this._wasRunning = running;
      if (running && !this.recorder.recording) this.start();
      else if (!running && this.recorder.recording) this.stop();
    });
  }

  onModelLoaded(_result: LoadResult, _viewer: RVViewer): void {
    // A new model means new nodes behind the same paths. Nothing recorded from
    // the old one may survive into the new one's chart.
    this._disarm();
    this.recorder.clear();
  }

  onModelCleared(): void {
    this._disarm();
    this.recorder.clear();
  }

  onFixedUpdatePost(dt: number): void {
    this.recorder.sample(dt, () => this._readSnapshots());
  }

  /** Mechanisms currently armed. */
  get armedPaths(): readonly string[] { return this._paths; }

  /**
   * Arm every mechanism in the model and begin a window.
   *
   * Arming is separate from recording on the private side but joined here on
   * purpose: the force analysis costs an RNEA per tick, and the only reason to
   * pay it is that somebody is watching the result.
   */
  start(): void {
    const bridge = getMechanismUiBridge();
    if (!bridge) return;
    this._paths = bridge.list().map((m) => m.nodePath);
    for (const path of this._paths) {
      bridge.setForceAnalysis(path, true);
      bridge.resetForces(path);
    }
    this.recorder.start();
  }

  /** End the window and stop paying for the analysis. Buffers are kept. */
  stop(): void {
    this.recorder.stop();
    this._disarm();
  }

  /**
   * Run a statics evaluation and file the result as the holding figures (F8).
   * Returns the snapshot so the caller can report the status.
   */
  captureStatics(mechanismPath: string): MechanismForcesSnapshot | null {
    const bridge = getMechanismUiBridge();
    if (!bridge) return null;
    const snapshot = bridge.solveStatics(mechanismPath);
    if (!snapshot || !snapshot.dynamicsValid) return snapshot;
    for (const channel of snapshot.channels) {
      this.recorder.setHolding(channel.id, channel.value);
    }
    return snapshot;
  }

  dispose(): void {
    this._unsubSession?.();
    this._unsubSession = null;
    this._disarm();
    this.recorder.clear();
  }

  private _disarm(): void {
    const bridge = getMechanismUiBridge();
    if (bridge) {
      for (const path of this._paths) bridge.setForceAnalysis(path, false);
    }
    this._paths = [];
  }

  private _readSnapshots(): MechanismForcesSnapshot[] {
    const bridge = getMechanismUiBridge();
    if (!bridge) return [];
    const out: MechanismForcesSnapshot[] = [];
    for (const path of this._paths) {
      const snapshot = bridge.forcesSnapshot(path);
      if (snapshot) out.push(snapshot);
    }
    return out;
  }
}

/**
 * Install the recorder if it is not there yet — the `ensureSensorRecorder`
 * shape, and the ONE place that decides the plugin exists.
 *
 * It lived in `MechanismForceChart.tsx` until plan-706, which meant the recorder
 * came into being only when somebody expanded a panel row. `web_editor_test_start`
 * calls this first for exactly that reason: the session subscription in
 * {@link MechanismForceRecorderPlugin.init} cannot fire for a plugin that was
 * never registered. The TSX re-exports this name for its existing callers.
 */
export function ensureForceRecorder(viewer: RVViewer): MechanismForceRecorderPlugin {
  let plugin = viewer.getPlugin<MechanismForceRecorderPlugin>(MECHANISM_FORCE_RECORDER_ID);
  if (!plugin) {
    plugin = new MechanismForceRecorderPlugin();
    viewer.use(plugin, 'core');
  }
  return plugin;
}
