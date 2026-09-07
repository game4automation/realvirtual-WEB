// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PerfTestPlugin — Automated performance test triggered via `?perf` URL param.
 *
 * Two scenarios (plan-465):
 *
 *   - `scenario=model` (default, unchanged): samples FPS on whatever model is
 *     loaded, runs a GPU benchmark, shows the overlay.
 *   - `scenario=line`: builds the synthetic transport line, runs it to steady
 *     state and reports the per-frame probe. This is the cell the scaling
 *     matrix and the soak runner drive.
 *
 * The line scenario deliberately reaches the perf machinery through the DEV-only
 * globals `window.__rvSyntheticLine`, `__rvPerfProbe` and `__rvSyntheticLoad`
 * instead of importing the modules. This plugin ships as a lazily-imported
 * production chunk; a static import would drag the whole perf harness into the
 * production build, and the plan's bundle budget for it is exactly 0 KB.
 *
 * `window.__PERF_RESULTS__` stays backward compatible — `e2e/perf-smoke.spec.ts`
 * reads the same fields it always did; the line run merely adds `plan`, `probe`
 * and `stationarity` next to them.
 */

import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import { debug, logInfo } from '../../core/engine/rv-debug';

const DEFAULT_MODEL_DURATION_S = 5;
const DEFAULT_SMOKE_DURATION_S = 30;
/** §1.3: the supported-scale criteria are defined over a 5-minute window. */
const DEFAULT_OBSERVATION_S = 300;
const SAMPLE_INTERVAL_MS = 500;
/** §1.3 PASS thresholds — identical to the badge the overlay has always shown. */
const FRAME_P95_LIMIT_MS = 33.3;
const FRAME_P99_LIMIT_MS = 66;

export interface PerfResults {
  model: string;
  loadTime: string;
  glbSize: string;
  fps: { min: number; avg: number; max: number };
  frameTime: { min: number; avg: number; max: number };
  benchmark: { uncappedFps: number; avgFrameMs: number; headroom: number };
  renderer: { triangles: number; drawCalls: number; geometries: number; textures: number };
  timestamp: string;
  pass: boolean;
  /** `model` or `line`. */
  scenario?: string;
  /** `supported` or `smoke` (line scenario only). */
  mode?: string;
  /** Why a line run failed, when it did. */
  reason?: string;
  /** The `SyntheticLinePlan` the run was built from. */
  plan?: unknown;
  /** `RVPerfProbe.reportJSON()`. */
  probe?: unknown;
  /** Steady-state evidence for the observation window. */
  stationarity?: StationarityResult;
  /** Produced-vs-arrived rates for the in-browser load generator. */
  load?: unknown;
  /** What the run was measured IN — every switch that changes the frame. */
  env?: PerfEnvironment;
  /** Seconds spent filling the line before the observation window opened. */
  fillPhaseS?: number;
}

/**
 * The measurement environment, recorded in every report.
 *
 * A perf number without this is unreadable: the same 2400-MU cell is a
 * different experiment with the demo model standing next to the line, with
 * shadows on, or with the dev debug telemetry running.
 */
export interface PerfEnvironment {
  /** `off` whenever the page carries `?perf` — see `main.ts`. */
  debugPlugins: 'off';
  shadows: 'on' | 'off';
  effects: 'on' | 'off';
  /** `off` = the loaded GLB was cleared before the line was built. */
  model: 'on' | 'off';
  /** Model that was loaded (and possibly cleared again). */
  modelUrl?: string;
}

/** Belt occupancy AND throughput — occupancy alone cannot tell a full line from a dead one. */
export interface StationarityResult {
  reached: boolean;
  reason: string;
  targetMUs: number;
  liveMUs: number;
  /** MUs spawned per second over the window. */
  spawnRate: number;
  /** MUs consumed per second over the window. */
  sinkRate: number;
  /** Rate the configuration asks for (`lanes / sourceIntervalS`). */
  requiredSpawnRate: number;
  windowS: number;
  sensorEverTriggered: boolean;
}

interface LineParams {
  scenario: 'model' | 'line';
  mode: 'supported' | 'smoke';
  durationS: number;
  load: 'none' | 'browser' | 'connect';
  /** `?shadows=on|off` — a measurement AXIS, default `on` (production behaviour). */
  shadows: boolean;
  /** `?effects=on|off` — MU spawn/vanish clip effects, a measurement AXIS. */
  effects: boolean;
  /**
   * `?keepmodel=on|off` — keep the loaded GLB standing next to the synthetic
   * line. NOT `?model=`: that name is already the viewer's model SELECTOR, and
   * `?model=off` makes `main.ts` try to fetch a GLB called "off".
   *
   * Default OFF for `scenario=line` (plan-465 fix 2026-09-06). The first sweep
   * measured the line ON TOP of `DemoRealvirtualWeb.glb`: 265 meshes, ~1.75 M
   * triangles and 528 draw calls, against 4 128 triangles and 24 instanced
   * draws of actual line. Draw calls and the shadow pass were then properties
   * of the demo model, not of the MU count the matrix claims to sweep. The GLB
   * control cell is `scenario=model`, which is unaffected.
   */
  keepModel: boolean;
  cfg: Record<string, unknown>;
}

/** `on`/`off` URL flag with an explicit default. Anything else counts as `on`. */
function flag(p: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = p.get(key);
  if (raw === null) return fallback;
  return !(raw === 'off' || raw === 'false' || raw === '0');
}

declare global {
  interface Window { __PERF_RESULTS__?: PerfResults }
}

interface SyntheticLineHookLike {
  build(cfg?: Record<string, unknown>): { valid: boolean; reason?: string; fillTimeS: number; sourceIntervalS: number; [k: string]: unknown };
  dispose(): void;
}
interface PerfProbeHookLike {
  start(): void;
  stop(): void;
  reset(): void;
  reportJSON(): Record<string, unknown>;
}
interface SyntheticLoadHookLike {
  start(cfg?: Record<string, unknown>): Promise<void> | void;
  stop(): void;
  stats(): unknown;
}

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read every line parameter off the URL. Exported for the runner's own sanity checks. */
export function readPerfParams(search: string): LineParams {
  const p = new URLSearchParams(search);
  const scenario = p.get('scenario') === 'line' ? 'line' : 'model';
  const mode = p.get('mode') === 'smoke' ? 'smoke' : 'supported';
  const loadRaw = p.get('load');
  const load = loadRaw === 'browser' || loadRaw === 'connect' ? loadRaw : 'none';
  const defaultDuration = scenario === 'line'
    ? (mode === 'smoke' ? DEFAULT_SMOKE_DURATION_S : DEFAULT_OBSERVATION_S)
    : DEFAULT_MODEL_DURATION_S;
  const keepModel = flag(p, 'keepmodel', scenario !== 'line');
  // The line is parked far from the origin ONLY to stay clear of a loaded
  // model's transport surfaces. With the model stripped there is nothing to
  // avoid, and parking it 1.4 km away just leaves it outside the camera's
  // framing (plan-465 fix 2026-09-06).
  const defaultOrigin = keepModel ? 1000 : 0;
  const cfg: Record<string, unknown> = {
    targetMUs: num(p, 'mu', 2400),
    sensorsPerSegment: num(p, 'sensors', 1),
    lanes: num(p, 'lanes', 24),
    plcs: num(p, 'plcs', 2),
    segments: num(p, 'segments', 9),
    segmentLengthM: num(p, 'seglen', 5),
    speedMmS: num(p, 'speed', 1000),
    muTemplates: num(p, 'templates', 1),
    muLengthMm: num(p, 'mulen', 200),
    muGapMm: num(p, 'mugap', 100),
    seed: num(p, 'seed', 465),
    originX: num(p, 'originx', defaultOrigin),
    originZ: num(p, 'originz', defaultOrigin),
    // A line with no signal source still binds its signals; only `load=none`
    // leaves the belts jogging free, which is the matrix's zero column.
    signalBinding: load === 'none' ? 'none' : load,
  };
  return {
    scenario,
    mode,
    durationS: num(p, 'duration', defaultDuration),
    load,
    shadows: flag(p, 'shadows', true),
    effects: flag(p, 'effects', true),
    keepModel,
    cfg,
  };
}

export class PerfTestPlugin implements RVViewerPlugin {
  readonly id = 'perf-test';
  readonly order = 9999; // run last

  /** plan-435 §2.10 abort generation — bumped by `onDeactivate`. */
  private _generation = 0;
  private _startTimer: ReturnType<typeof setTimeout> | null = null;
  private _sampleTimer: ReturnType<typeof setInterval> | null = null;
  private _overlay: HTMLElement | null = null;
  /** True while a synthetic line is standing — `onDeactivate` must tear it down. */
  private _lineBuilt = false;
  private _loadStarted = false;
  private _probeRunning = false;

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    // Small delay to let first frames settle (JIT, shader compile, etc.)
    if (this._startTimer !== null) clearTimeout(this._startTimer);
    this._startTimer = setTimeout(() => {
      this._startTimer = null;
      void this.run(viewer);
    }, 1000);
  }

  /**
   * plan-435: the run owns timers and a body-level overlay the fallback cannot
   * reach. plan-465 adds three more owned resources — the synthetic line, the
   * probe's loop wrappers and the load generator's interval — every one of which
   * would otherwise outlive the plugin and keep mutating a scene that no longer
   * has a perf run in it.
   */
  onDeactivate(): void {
    this._generation++;
    if (this._startTimer !== null) { clearTimeout(this._startTimer); this._startTimer = null; }
    if (this._sampleTimer !== null) { clearInterval(this._sampleTimer); this._sampleTimer = null; }
    this._overlay?.remove();
    this._overlay = null;
    this.teardownPerfResources();
  }

  private teardownPerfResources(): void {
    if (this._probeRunning) { this.probeHook()?.stop(); this._probeRunning = false; }
    if (this._loadStarted) { this.loadHook()?.stop(); this._loadStarted = false; }
    if (this._lineBuilt) { this.lineHook()?.dispose(); this._lineBuilt = false; }
  }

  /** Re-arm the measurement for the model that is still loaded. */
  onActivate(viewer: RVViewer): void {
    if (!viewer.lastLoadResult) return;
    this.onModelLoaded(viewer.lastLoadResult, viewer);
  }

  dispose(): void {
    this.onDeactivate();
  }

  private lineHook(): SyntheticLineHookLike | undefined {
    return (globalThis as { __rvSyntheticLine?: SyntheticLineHookLike }).__rvSyntheticLine;
  }
  private probeHook(): PerfProbeHookLike | undefined {
    return (globalThis as { __rvPerfProbe?: PerfProbeHookLike }).__rvPerfProbe;
  }
  private loadHook(): SyntheticLoadHookLike | undefined {
    return (globalThis as { __rvSyntheticLoad?: SyntheticLoadHookLike }).__rvSyntheticLoad;
  }

  /** Poll for the dev-only perf globals; resolves false on timeout or abort. */
  private async waitForHooks(timeoutMs: number, aborted: () => boolean): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (aborted()) return false;
      if (this.lineHook() && this.probeHook()) return true;
      await this.sleep(100);
    }
    return false;
  }

  private async run(viewer: RVViewer): Promise<void> {
    const params = readPerfParams(window.location.search);
    if (params.scenario === 'line') {
      await this.runLine(viewer, params);
      return;
    }
    await this.runModel(viewer, params);
  }

  /**
   * Take the loaded GLB out of the experiment WITHOUT tearing the viewer down.
   *
   * `viewer.clearModel()` would be the obvious call and is the wrong one: it
   * nulls `signalStore` and `transportManager`, and the synthetic line needs
   * both (it fails with "Cannot read properties of null (reading
   * 'createWriter')"). So this removes exactly what the model contributes to a
   * measurement — its scene root (render + shadow pass) and its entries in the
   * lists the fixed update walks (drives, surfaces, sensors, sources, sinks and
   * the MUs its own sources already spawned) — and leaves the store, the
   * manager and the registry standing for the line to build into.
   *
   * Not covered, and deliberately so: a model's logic engine, IK and robot
   * runtimes keep ticking. They are cheap next to 2400 MUs, and reaching into
   * them from a perf plugin would be a teardown path with no other caller.
   */
  private stripLoadedModel(viewer: RVViewer): void {
    const tm = viewer.transportManager;
    if (tm) {
      for (let i = tm.mus.length - 1; i >= 0; i--) tm.removeMU(tm.mus[i]);
      tm.surfaces.length = 0;
      tm.sensors.length = 0;
      tm.sources.length = 0;
      tm.sinks.length = 0;
      tm.notifyTopologyChanged();
    }
    viewer.drives.length = 0;
    const root = viewer.currentModelRoot;
    root?.parent?.remove(root);
    viewer.markShadowsDirty?.();
    viewer.markRenderDirty?.();
  }

  /**
   * Put the page into the configuration the report will claim it measured.
   *
   * Three switches, all of which the first sweep got wrong by omission:
   *  - the loaded GLB is CLEARED for `scenario=line` unless `?model=on`;
   *  - shadows follow `?shadows=`, so the shadow pass is an axis rather than a
   *    silent constant (the product's own "shadows dirty on every MU-count
   *    change" behaviour is deliberately left alone — see the plan);
   *  - the MU clip effects follow `?effects=`.
   */
  private applyEnvironment(viewer: RVViewer, params: LineParams): PerfEnvironment {
    const modelUrl = viewer.currentModelUrl ?? undefined;
    if (!params.keepModel) this.stripLoadedModel(viewer);
    const renderer = (viewer as unknown as { renderer?: { shadowMap?: { enabled: boolean; needsUpdate: boolean } } }).renderer;
    if (renderer?.shadowMap && renderer.shadowMap.enabled !== params.shadows) {
      renderer.shadowMap.enabled = params.shadows;
      renderer.shadowMap.needsUpdate = true;
    }
    const tm = viewer.transportManager as unknown as { spawnVanishEffects?: boolean } | undefined;
    if (tm) tm.spawnVanishEffects = params.effects;
    return {
      debugPlugins: 'off',
      shadows: params.shadows ? 'on' : 'off',
      effects: params.effects ? 'on' : 'off',
      model: params.keepModel ? 'on' : 'off',
      ...(modelUrl !== undefined ? { modelUrl } : {}),
    };
  }

  // ── Scenario: synthetic line ───────────────────────────────────────────

  private async runLine(viewer: RVViewer, params: LineParams): Promise<void> {
    const generation = this._generation;
    const aborted = () => generation !== this._generation;

    // The dev-only hooks are installed near the END of `main.ts init()`, while
    // this plugin is armed by `onModelLoaded` — which can fire first. Poll rather
    // than assume an ordering that is not guaranteed.
    // Generous: a COLD Vite dev server transforms the whole engine module graph
    // on demand, and the perf hooks sit at the end of that chain.
    const ready = await this.waitForHooks(180_000, aborted);
    const line = this.lineHook();
    const probe = this.probeHook();
    if (!ready || !line || !probe) {
      this.publish(viewer, {
        scenario: 'line',
        mode: params.mode,
        pass: false,
        reason: 'dev-only perf hooks are missing — the line scenario needs a DEV build',
      });
      return;
    }

    // The measurement environment is established BEFORE the line is built, so
    // nothing that follows is measured against a scene that is still changing.
    const env = this.applyEnvironment(viewer, params);

    let plan: { valid: boolean; reason?: string; fillTimeS: number; sourceIntervalS: number; [k: string]: unknown };
    try {
      plan = line.build(params.cfg);
      this._lineBuilt = true;
    } catch (err) {
      this.publish(viewer, {
        scenario: 'line',
        mode: params.mode,
        pass: false,
        env,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (params.load === 'browser') {
      await this.loadHook()?.start({ lineSignals: [] });
      this._loadStarted = true;
    }

    probe.start();
    this._probeRunning = true;

    // Warmup: the line must physically fill before any number means anything.
    const warmupS = params.mode === 'smoke' ? 2 : plan.fillTimeS + 30;
    const fillT0 = performance.now();
    await this.sleep(warmupS * 1000);
    if (aborted()) return;
    const fillPhaseS = (performance.now() - fillT0) / 1000;

    // POINT THE CAMERA AT THE LINE (plan-465 fix 2026-09-06). The line is parked
    // at (1000, 0, 1000) so it cannot interact with a loaded model's belts — and
    // the camera, framed on that model at boot, never saw it. Every MU was
    // frustum-culled: the first sweep reported 120 triangles for 120 live MUs
    // and measured a GPU cost of essentially zero. A render measurement of an
    // off-screen scene is not a render measurement.
    //
    // AFTER the warmup, not right after `build()`: the framing walks VISIBLE
    // meshes, and an MU pool's InstancedMesh does not exist until its source has
    // spawned the first part. Framing an unfilled line finds an empty box and
    // silently leaves the camera where it was.
    viewer.frameSceneContent();

    // §2.6 wants the reset HERE, not before the warmup (plan-465 fix
    // 2026-09-06). Resetting before meant every percentile in the report was
    // computed over fill-phase frames as well — the first 2400-MU report showed
    // `durationMs` 374 s for a 120 s observation window, and its p99 was the
    // scene coming up, not the line running. The probe keeps its wrappers; only
    // the accumulators and the clock are re-baselined.
    probe.reset();

    const windowS = params.mode === 'smoke'
      ? params.durationS
      : Math.max(params.durationS, DEFAULT_OBSERVATION_S);
    const timeoutS = params.mode === 'smoke'
      ? windowS
      : plan.fillTimeS * 2 + DEFAULT_OBSERVATION_S;

    const stationarity = await this.observe(viewer, params, plan, windowS, timeoutS, aborted);
    if (aborted()) return;

    probe.stop();
    this._probeRunning = false;
    const probeReport = probe.reportJSON();
    const loadStats = this._loadStarted ? this.loadHook()?.stats() : undefined;

    const frame = (probeReport.frameMs ?? {}) as { p50?: number; p95?: number; p99?: number; max?: number };
    const p95 = frame.p95 ?? Number.POSITIVE_INFINITY;
    const p99 = frame.p99 ?? Number.POSITIVE_INFINITY;

    // A smoke run proves the machinery works; it makes NO claim about scale, so
    // it must not be graded against the 30 fps criterion (SOL R2#5).
    const pass = params.mode === 'smoke'
      ? stationarity.reached
      : stationarity.reached && p95 <= FRAME_P95_LIMIT_MS && p99 <= FRAME_P99_LIMIT_MS;

    const reason = pass
      ? undefined
      : !stationarity.reached
        ? stationarity.reason
        : `frame p95 ${p95.toFixed(1)} ms / p99 ${p99.toFixed(1)} ms exceeds ${FRAME_P95_LIMIT_MS} / ${FRAME_P99_LIMIT_MS} ms`;

    this.publish(viewer, {
      scenario: 'line',
      mode: params.mode,
      pass,
      ...(reason !== undefined ? { reason } : {}),
      plan,
      probe: probeReport,
      stationarity,
      env,
      fillPhaseS,
      ...(loadStats !== undefined ? { load: loadStats } : {}),
      frameTime: {
        min: Math.round(frame.p50 ?? 0),
        avg: Math.round(frame.p50 ?? 0),
        max: Math.round(frame.max ?? 0),
      },
    });
  }

  /**
   * Watch the line until it is stationary, or until `timeoutS` expires.
   *
   * Three conditions, all required (§1.3, SOL R1#3 / R2#5): the belt is as full
   * as configured, the sources really produce at the configured rate, and the
   * sinks really consume what the sources make. Occupancy alone would call a
   * completely stalled line — 0 spawns, 0 sinks, MUs frozen in place — a perfect
   * steady state.
   */
  private async observe(
    viewer: RVViewer,
    params: LineParams,
    plan: { fillTimeS: number; sourceIntervalS: number; [k: string]: unknown },
    windowS: number,
    timeoutS: number,
    aborted: () => boolean,
  ): Promise<StationarityResult> {
    const tm = viewer.transportManager;
    const target = Number(params.cfg.targetMUs) || 0;
    const lanes = Number(params.cfg.lanes) || 1;
    const requiredSpawnRate = plan.sourceIntervalS > 0 ? lanes / plan.sourceIntervalS : 0;

    const t0 = performance.now();
    const spawned0 = tm?.totalSpawned ?? 0;
    const consumed0 = tm?.totalConsumed ?? 0;
    let sensorEverTriggered = false;

    const deadline = t0 + timeoutS * 1000;
    const windowEnd = t0 + windowS * 1000;
    while (performance.now() < Math.min(windowEnd, deadline)) {
      if (aborted()) break;
      if (!sensorEverTriggered && tm) {
        for (const sensor of tm.sensors) { if (sensor.occupied) { sensorEverTriggered = true; break; } }
      }
      await this.sleep(SAMPLE_INTERVAL_MS);
    }

    const elapsedS = (performance.now() - t0) / 1000;
    const liveMUs = tm?.mus.length ?? 0;
    const spawnRate = elapsedS > 0 ? ((tm?.totalSpawned ?? 0) - spawned0) / elapsedS : 0;
    const sinkRate = elapsedS > 0 ? ((tm?.totalConsumed ?? 0) - consumed0) / elapsedS : 0;

    let reached: boolean;
    let reason: string;
    if (params.mode === 'smoke') {
      // Function criterion only — 30 s is far too short to fill a large line.
      reached = spawnRate > 0 && sensorEverTriggered;
      reason = reached
        ? 'smoke: spawns observed, sensor triggered'
        : `smoke: spawnRate ${spawnRate.toFixed(2)}/s, sensorTriggered ${sensorEverTriggered}`;
    } else {
      const occupancyOk = liveMUs >= 0.9 * target && liveMUs <= 1.1 * target;
      const spawnOk = spawnRate >= 0.9 * requiredSpawnRate;
      const sinkOk = sinkRate >= 0.9 * spawnRate;
      reached = occupancyOk && spawnOk && sinkOk;
      reason = reached
        ? 'stationary'
        : `occupancy ${liveMUs}/${target} ${occupancyOk ? 'ok' : 'FAIL'}, `
          + `spawn ${spawnRate.toFixed(2)}/${requiredSpawnRate.toFixed(2)} per s ${spawnOk ? 'ok' : 'FAIL'}, `
          + `sink ${sinkRate.toFixed(2)}/${spawnRate.toFixed(2)} per s ${sinkOk ? 'ok' : 'FAIL'}`;
    }

    return {
      reached, reason, targetMUs: target, liveMUs, spawnRate, sinkRate,
      requiredSpawnRate, windowS: elapsedS, sensorEverTriggered,
    };
  }

  // ── Scenario: model (legacy behaviour) ─────────────────────────────────

  private async runModel(viewer: RVViewer, params: LineParams): Promise<void> {
    const durationS = params.durationS;
    // The GLB control cell keeps its model by default (`keepModel` defaults to
    // true outside `scenario=line`) but still records the environment, so it is
    // comparable with a synthetic cell measured by the same instrument.
    const env = this.applyEnvironment(viewer, params);
    const generation = this._generation;
    const aborted = () => generation !== this._generation;
    const modelUrl = viewer.currentModelUrl ?? 'unknown';
    let modelName: string;
    if (modelUrl.startsWith('blob:')) {
      const titleMatch = document.title.match(/^(.+?) - realvirtual/i);
      modelName = titleMatch?.[1] ?? localStorage.getItem('rv-webviewer-last-model')?.split('/').pop()?.replace(/\.glb$/i, '') ?? 'demo';
    } else {
      modelName = (modelUrl.split('/').pop() ?? modelUrl).split('?')[0].replace(/\.glb$/i, '');
    }
    const loadInfo = viewer.lastLoadInfo ?? { glbSize: '--', loadTime: '--' };

    // Run the probe alongside the legacy FPS sampling when it is available.
    // This is what makes the GLB control cell comparable to a synthetic cell
    // (plan-465 Phase 4): without per-frame percentiles from the same
    // instrument, a real model and the synthetic line are measured with two
    // different rulers and the control loses its point.
    const probe = this.probeHook();
    if (probe) { probe.reset(); probe.start(); this._probeRunning = true; }

    // Open drives chart so UI overhead is included in measurements
    viewer.toggleDriveChart(true);
    await new Promise((r) => setTimeout(r, 500));
    if (aborted()) { viewer.toggleDriveChart(false); this.teardownPerfResources(); return; }

    debug('render', `[perf] Starting ${durationS}s FPS sampling (drives chart open)...`);

    const fpsSamples: number[] = [];
    const ftSamples: number[] = [];
    const totalSamples = Math.max(1, Math.floor((durationS * 1000) / SAMPLE_INTERVAL_MS));

    await new Promise<void>((resolve) => {
      let count = 0;
      this._sampleTimer = setInterval(() => {
        if (aborted()) { resolve(); return; }
        fpsSamples.push(viewer.currentFps);
        ftSamples.push(viewer.currentFrameTime);
        count++;
        if (count >= totalSamples) {
          if (this._sampleTimer !== null) clearInterval(this._sampleTimer);
          this._sampleTimer = null;
          resolve();
        }
      }, SAMPLE_INTERVAL_MS);
    });

    viewer.toggleDriveChart(false);
    if (aborted()) return;

    // The probe stops BEFORE the GPU benchmark: `runBenchmark` deliberately
    // renders uncapped, and those frames describe the benchmark rather than the
    // scene under normal load.
    if (this._probeRunning && probe) { probe.stop(); this._probeRunning = false; }

    debug('render', '[perf] Running GPU benchmark...');
    const benchmark = await viewer.runBenchmark(120);
    if (aborted()) return;

    const stats = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        min: Math.round(sorted[0] ?? 0),
        avg: Math.round(sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length)),
        max: Math.round(sorted[sorted.length - 1] ?? 0),
      };
    };

    const probeReport: Record<string, unknown> | undefined = probe ? probe.reportJSON() : undefined;

    const fps = stats(fpsSamples);
    this.publish(viewer, {
      scenario: 'model',
      env,
      ...(probeReport !== undefined ? { probe: probeReport } : {}),
      model: modelName,
      loadTime: loadInfo.loadTime,
      glbSize: loadInfo.glbSize,
      fps,
      frameTime: stats(ftSamples),
      benchmark: {
        uncappedFps: benchmark.uncappedFps,
        avgFrameMs: Math.round(benchmark.avgFrameMs * 10) / 10,
        headroom: benchmark.headroom,
      },
      pass: fps.avg >= 30,
    });
  }

  // ── Output ─────────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Fill in every legacy field so `e2e/perf-smoke.spec.ts` keeps working verbatim. */
  private publish(viewer: RVViewer, partial: Partial<PerfResults>): void {
    const rendererInfo = viewer.getRendererInfo?.() ?? {
      triangles: 0, drawCalls: 0, geometries: 0, textures: 0,
    };
    const results: PerfResults = {
      model: 'synthetic-line',
      loadTime: '--',
      glbSize: '--',
      fps: { min: 0, avg: 0, max: 0 },
      frameTime: { min: 0, avg: 0, max: 0 },
      benchmark: { uncappedFps: 0, avgFrameMs: 0, headroom: 0 },
      renderer: {
        triangles: rendererInfo.triangles,
        drawCalls: rendererInfo.drawCalls,
        geometries: rendererInfo.geometries,
        textures: rendererInfo.textures,
      },
      timestamp: new Date().toISOString(),
      pass: false,
      ...partial,
    };
    window.__PERF_RESULTS__ = results;
    logInfo('[perf] Results: ' + JSON.stringify(results, null, 2));
    this.showOverlay(results);
  }

  private showOverlay(r: PerfResults): void {
    this._overlay?.remove();   // a re-armed run replaces its predecessor
    const el = document.createElement('div');
    const pass = r.pass;
    el.style.cssText = `
      position:fixed; top:16px; left:16px; z-index:99999;
      background:rgba(0,0,0,0.85); color:#e0e0e0; padding:16px 20px;
      border-radius:8px; font:13px/1.6 monospace; min-width:280px;
      border-left:4px solid ${pass ? '#4caf50' : '#f44336'};
    `;
    const probe = r.probe as { frameMs?: { p50: number; p95: number; p99: number; max: number } } | undefined;
    // The percentile line is ADDED to the model overlay, not swapped in for it:
    // the FPS/benchmark rows are what people have read off this badge for years.
    const percentiles = probe?.frameMs
      ? `<div>Frame p50/p95/p99: <b>${probe.frameMs.p50.toFixed(1)}</b> / `
        + `<b>${probe.frameMs.p95.toFixed(1)}</b> / <b>${probe.frameMs.p99.toFixed(1)}</b> ms</div>`
      : '';
    const detail = r.scenario === 'line'
      ? percentiles
      : `<div>FPS: <b>${r.fps.min}</b> / <b>${r.fps.avg}</b> / <b>${r.fps.max}</b> (min/avg/max)</div>`
        + `<div>Frame: ${r.frameTime.min}ms / ${r.frameTime.avg}ms / ${r.frameTime.max}ms</div>`
        + percentiles
        + `<div>Benchmark: ${r.benchmark.uncappedFps} fps (${r.benchmark.headroom}% headroom)</div>`;
    el.innerHTML = `
      <div style="font-size:15px;font-weight:bold;margin-bottom:8px">
        <span style="color:${pass ? '#4caf50' : '#f44336'}">${pass ? 'PASS' : 'FAIL'}</span>
        &nbsp; ${r.model}${r.scenario === 'line' ? ` (${r.mode})` : ''}
      </div>
      <div>Load: ${r.loadTime} &middot; ${r.glbSize}</div>
      ${detail}
      ${r.reason ? `<div style="color:#ffb74d;font-size:11px;margin-top:6px">${r.reason}</div>` : ''}
      <div style="color:#888;font-size:11px;margin-top:6px">
        ${r.renderer.triangles.toLocaleString()} tris &middot; ${r.renderer.drawCalls} draws &middot;
        ${r.renderer.geometries} geo &middot; ${r.renderer.textures} tex
      </div>
    `;
    document.body.appendChild(el);
    this._overlay = el;
  }
}
