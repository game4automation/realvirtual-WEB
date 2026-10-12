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
  /** plan-473 F4: whether the run measured what it claims to (§1.3). */
  validity?: RunValidity;
  /** Produced-vs-arrived rates for the in-browser load generator. */
  load?: unknown;
  /** What the run was measured IN — every switch that changes the frame. */
  env?: PerfEnvironment;
  /** Seconds spent filling the line before the observation window opened. */
  fillPhaseS?: number;
  /** plan-492: what the cell matrix cost — placements, bakes, chunks, BVH. */
  cellMatrix?: unknown;
  /** plan-492: the per-pass frame counters of the last measured frame. */
  frameStats?: unknown;
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
  /** plan-469: the A/B prototypes actually armed for this run (`none` if any). */
  proto?: string;
  /** plan-469: whether the region-attribution hooks were installed. */
  hooks?: 'on' | 'off';
  /** plan-469 Phase 0d: `primitive` belts or `library` conveyor GLBs. */
  geometry?: 'primitive' | 'library';
  /** plan-469 Phase 0d: `primitive` box MU or the `cartonbox` library asset. */
  muAsset?: 'primitive' | 'cartonbox' | 'pallet';
  /** plan-469 Phase 0d: six-axis robots standing beside the line. */
  robots?: number;
  robotMotion?: 'static' | 'erratic';
  /** plan-473 F4: the ambient-occlusion backend the frame was rendered with.
   *  AO is a DEFAULT-ON post pass and was never protocolled, so two reports
   *  could differ by a full screen-space pass without saying so. */
  aoMode?: 'off' | 'gtao' | 'n8ao';
  /** `off` = the loaded GLB was cleared before the line was built. */
  model: 'on' | 'off';
  /** Model that was loaded (and possibly cleared again). */
  modelUrl?: string;
}

// ── plan-473 F4: run validity ───────────────────────────────────────────

/** Occupancy band around the configured target (±10 %, §1.3). */
export const VALIDITY_OCCUPANCY_TOL = 0.10;
/** Throughput band, both for source-vs-reference and sink-vs-source (±15 %). */
export const VALIDITY_RATE_TOL = 0.15;
/** Share of the observation window that may be lost simulation time (5 %). */
export const VALIDITY_LOST_SIM_TOL = 0.05;

/** One of the four §1.3 conditions, reported individually. */
export interface RunValidityCheck {
  name: 'occupancy' | 'sourceThroughput' | 'sinkThroughput' | 'simTimeLoss';
  ok: boolean;
  /** The measured numbers behind the verdict, for the report. */
  detail: string;
}

/**
 * Verdict on whether a run MEASURED WHAT IT CLAIMS TO — the plan-473 F4
 * replacement for `stationary`.
 *
 * The old criterion graded the source against `lanes / sourceIntervalS`, the
 * rate the configuration ASKS for, while the line physically tops out near half
 * of that. Every cell therefore reported FAIL and the flag became unreadable.
 * The four conditions below grade the run against what is ACHIEVABLE instead,
 * and — unlike a pure occupancy test — a completely stalled line
 * (`source = sink = 0`) is explicitly invalid.
 */
export interface RunValidity {
  valid: boolean;
  reason: string;
  checks: RunValidityCheck[];
  /** True when no reference rate was supplied, so `sourceThroughput` could only
   *  be graded as "> 0". A reference run establishes the number (§4 Phase 1);
   *  later runs pass it in via `?refrate=`. */
  referenceMissing: boolean;
}

export interface RunValidityInput {
  /** Configured MU target of the cell. */
  targetMUs: number;
  /** MUs alive at the end of the observation window. */
  liveMUs: number;
  /** MUs spawned per second over the window. */
  spawnRate: number;
  /** MUs consumed per second over the window. */
  sinkRate: number;
  /** Source rate a REFERENCE run of this configuration reached, or `null` when
   *  none is known yet. Never the configured rate — that is the broken
   *  criterion this replaces. */
  referenceSpawnRate: number | null;
  /** `clampedSeconds + droppedBacklogSeconds` of the window (probe figure). */
  lostSimSeconds: number;
  /** Length of the observation window in seconds. */
  windowS: number;
}

/**
 * Grade one run against the four §1.3 conditions. Pure — the unit test in
 * `tests/perf/run-validity-gate.test.ts` drives it directly.
 */
export function evaluateRunValidity(input: RunValidityInput): RunValidity {
  const { targetMUs, liveMUs, spawnRate, sinkRate, referenceSpawnRate, lostSimSeconds, windowS } = input;
  const checks: RunValidityCheck[] = [];

  const occLo = targetMUs * (1 - VALIDITY_OCCUPANCY_TOL);
  const occHi = targetMUs * (1 + VALIDITY_OCCUPANCY_TOL);
  checks.push({
    name: 'occupancy',
    ok: targetMUs > 0 && liveMUs >= occLo && liveMUs <= occHi,
    detail: `${liveMUs} live vs target ${targetMUs} (band ${occLo.toFixed(0)}..${occHi.toFixed(0)})`,
  });

  // A stalled line fails HERE: `spawnRate > 0` is a hard precondition, so
  // `source = sink = 0` can never be graded as a valid steady state.
  const referenceMissing = referenceSpawnRate === null || !(referenceSpawnRate > 0);
  const sourceOk = spawnRate > 0 && (referenceMissing
    || Math.abs(spawnRate - (referenceSpawnRate as number)) <= VALIDITY_RATE_TOL * (referenceSpawnRate as number));
  checks.push({
    name: 'sourceThroughput',
    ok: sourceOk,
    detail: referenceMissing
      ? `${spawnRate.toFixed(2)}/s, no reference rate supplied (graded > 0 only)`
      : `${spawnRate.toFixed(2)}/s vs reference ${(referenceSpawnRate as number).toFixed(2)}/s `
        + `(±${(VALIDITY_RATE_TOL * 100).toFixed(0)} %)`,
  });

  checks.push({
    name: 'sinkThroughput',
    ok: spawnRate > 0 && Math.abs(sinkRate - spawnRate) <= VALIDITY_RATE_TOL * spawnRate,
    detail: `${sinkRate.toFixed(2)}/s vs source ${spawnRate.toFixed(2)}/s `
      + `(±${(VALIDITY_RATE_TOL * 100).toFixed(0)} %)`,
  });

  checks.push({
    name: 'simTimeLoss',
    ok: windowS > 0 && lostSimSeconds <= VALIDITY_LOST_SIM_TOL * windowS,
    detail: `${lostSimSeconds.toFixed(2)} s lost of ${windowS.toFixed(1)} s window `
      + `(limit ${(VALIDITY_LOST_SIM_TOL * 100).toFixed(0)} %)`,
  });

  const failed = checks.filter((c) => !c.ok);
  return {
    valid: failed.length === 0,
    reason: failed.length === 0
      ? (referenceMissing ? 'valid (no reference rate — source graded > 0 only)' : 'valid')
      : failed.map((c) => `${c.name} FAIL: ${c.detail}`).join('; '),
    checks,
    referenceMissing,
  };
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
  scenario: 'model' | 'line' | 'cells';
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
  /**
   * `?proto=refslowpick,refaabb,walk,bounds` — A/B switches. Dev-only; empty in
   * production. `walk`/`bounds` arm a plan-469 prototype; `refslowpick`/`refaabb`
   * are plan-473 REFERENCE switches that turn a production optimisation off, so
   * an ABBA pair measures the optimisation's price against the very same build.
   * `fastpath` and `union` are gone (plan-473 F3).
   */
  proto: string[];
  /** `?hooks=on|off` — plan-469: install the region-attribution hooks (default
   *  `on`). The `off` cell is what prices the instrumentation itself. */
  hooks: boolean;
  /** plan-492 `?cells=` — lanes of the cell matrix (`scenario=cells` only). */
  cells: number;
  /** plan-492 `?cellconv=` — conveyors per lane. */
  cellConv: number;
  /** plan-492 `?cellmotion=` — none | conveyor | robot | all | sparse. */
  cellMotion: string;
  /** `?refrate=<n>` — plan-473 F4: the source rate a REFERENCE run of this exact
   *  configuration reached, in MU/s. `null` when unknown; the run-validity gate
   *  then grades the source as "> 0" only and says so in the report. */
  referenceSpawnRate: number | null;
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
  /** plan-469 Phase 0d — must be awaited before `build()` for library assets.
   *  Optional so an older hook (or a test double) still satisfies the shape. */
  preload?(cfg?: Record<string, unknown>): Promise<string[]>;
  build(cfg?: Record<string, unknown>): { valid: boolean; reason?: string; fillTimeS: number; sourceIntervalS: number; [k: string]: unknown };
  dispose(): void;
}
interface PerfProbeHookLike {
  /** plan-469: set BEFORE `start()` — false leaves the manager's region hooks
   *  null, which is the production state and the overhead reference cell. */
  regionHooksEnabled?: boolean;
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
  const rawScenario = p.get('scenario');
  const scenario = rawScenario === 'line' ? 'line' : rawScenario === 'cells' ? 'cells' : 'model';
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
  const muAssetRaw = p.get('muasset');
  const muAsset = muAssetRaw === 'cartonbox' ? 'cartonbox' : muAssetRaw === 'pallet' ? 'pallet' : 'primitive';
  // A library MU is scaled to `mulen` along the belt, so a pallet must default
  // to its real length (MU_ASSET_PITCH_MM in rv-synthetic-assets.ts) or it would
  // be a 200 mm pallet. Explicit `mulen`/`mugap` still win.
  const palletDefaults = muAsset === 'pallet';
  const cfg: Record<string, unknown> = {
    targetMUs: num(p, 'mu', 2400),
    sensorsPerSegment: num(p, 'sensors', 1),
    lanes: num(p, 'lanes', 24),
    plcs: num(p, 'plcs', 2),
    segments: num(p, 'segments', 9),
    segmentLengthM: num(p, 'seglen', 5),
    speedMmS: num(p, 'speed', 1000),
    muTemplates: num(p, 'templates', 1),
    muLengthMm: num(p, 'mulen', palletDefaults ? 1200 : 200),
    muGapMm: num(p, 'mugap', palletDefaults ? 300 : 100),
    seed: num(p, 'seed', 465),
    originX: num(p, 'originx', defaultOrigin),
    originZ: num(p, 'originz', defaultOrigin),
    // plan-469 Phase 0d realistic-scene axes. Every default reproduces the
    // plan-465 cell EXACTLY, so an existing invocation measures what it always
    // measured (regression-free by construction).
    geometry: p.get('geometry') === 'library' ? 'library' : 'primitive',
    muAsset,
    robots: Math.max(0, num(p, 'robots', 0)),
    robotMotion: p.get('robotmotion') === 'erratic' ? 'erratic' : 'static',
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
    proto: (p.get('proto') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    hooks: flag(p, 'hooks', true),
    cells: Math.max(1, Math.floor(num(p, 'cells', 4))),
    cellConv: Math.max(1, Math.floor(num(p, 'cellconv', 3))),
    cellMotion: p.get('cellmotion') ?? 'none',
    referenceSpawnRate: p.get('refrate') === null || !Number.isFinite(Number(p.get('refrate')))
      ? null
      : Number(p.get('refrate')),
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
  /** True while a cell matrix is standing — `onDeactivate` must tear it down. */
  private _cellMatrixBuilt = false;
  private _loadStarted = false;
  private _probeRunning = false;
  private _cellMatrixViewer: RVViewer | null = null;
  /** True while a cells run is in flight — see the re-entrancy note in `runCells`. */
  private _cellsRunning = false;

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
    if (this._cellMatrixBuilt) {
      this._cellMatrixBuilt = false;
      const viewer = this._cellMatrixViewer;
      this._cellMatrixViewer = null;
      if (viewer) {
        void import('../../core/engine/perf/rv-cell-matrix').then((m) => m.disposeCellMatrix(viewer));
      }
    }
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
    if (params.scenario === 'cells') {
      await this.runCells(viewer, params);
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
    const tm = viewer.transportManager as unknown as {
      spawnVanishEffects?: boolean;
      refSlowPick?: boolean;
    } | undefined;
    if (tm) tm.spawnVanishEffects = params.effects;
    // plan-469 Phase 0c: arm the requested A/B prototypes. Unknown names are
    // ignored on purpose — a typo must not silently measure something else, so
    // the applied set is echoed back into the report's `env`.
    const applied = this.applyPrototypes(tm, params.proto);
    return {
      debugPlugins: 'off',
      shadows: params.shadows ? 'on' : 'off',
      effects: params.effects ? 'on' : 'off',
      proto: applied.join(',') || 'none',
      hooks: params.hooks ? 'on' : 'off',
      aoMode: (viewer as unknown as { aoMode?: 'off' | 'gtao' | 'n8ao' }).aoMode ?? 'off',
      geometry: params.cfg.geometry as 'primitive' | 'library',
      muAsset: params.cfg.muAsset as 'primitive' | 'cartonbox' | 'pallet',
      robots: params.cfg.robots as number,
      robotMotion: params.cfg.robotMotion as 'static' | 'erratic',
      model: params.keepModel ? 'on' : 'off',
      ...(modelUrl !== undefined ? { modelUrl } : {}),
    };
  }

  /**
   * plan-469 Phase 0c — arm the named prototypes and return the names that were
   * actually recognised. `walk`/`bounds` live below the manager (`rv-mu.ts`), so
   * they are set through the module-level flag object.
   */
  private applyPrototypes(
    tm: { refSlowPick?: boolean } | undefined,
    names: readonly string[],
  ): string[] {
    const flags = (globalThis as {
      __rvProtoFlags?: { oneWalk: boolean; poolBounds: boolean; refAabb: boolean };
    }).__rvProtoFlags;
    const applied: string[] = [];
    // Always start from the production state, so a reload without `?proto=`
    // really measures production.
    if (tm) tm.refSlowPick = false;
    if (flags) { flags.oneWalk = false; flags.poolBounds = false; flags.refAabb = false; }
    for (const name of names) {
      switch (name) {
        // plan-473: REFERENCE switches — they turn the production optimisation
        // OFF so an ABBA pair has a comparison side. `fastpath` and `union` are
        // gone (F3: the fast path is production, the union cache is deleted).
        case 'refslowpick': if (tm) { tm.refSlowPick = true; applied.push(name); } break;
        case 'refaabb': if (flags) { flags.refAabb = true; applied.push(name); } break;
        case 'walk': if (flags) { flags.oneWalk = true; applied.push(name); } break;
        case 'bounds': if (flags) { flags.poolBounds = true; applied.push(name); } break;
        default: console.warn(`[perf] unknown ?proto= name "${name}" — ignored`); break;
      }
    }
    return applied;
  }

  // ── Scenario: cell matrix (plan-492) ───────────────────────────────────

  /**
   * Build N customer-shaped cells on the production placement path and price
   * the result.
   *
   * Unlike the line scenario this does NOT go through a dev-only window hook:
   * the generator is a module under `src/core/engine/perf/`, imported here
   * dynamically so it stays out of the production bundle exactly like the rest
   * of this plugin.
   *
   * The run opens the EMPTY document first (plan-492 R10). `stripLoadedModel()`
   * would have been cheaper and is deliberately not used: it leaves a model's
   * logic engine, IK and robot runtimes ticking, so the "empty" baseline would
   * quietly contain whatever the previously loaded GLB brought with it.
   */
  private async runCells(viewer: RVViewer, params: LineParams): Promise<void> {
    // RE-ENTRANCY. This run opens the empty document itself, and `loadModel`
    // fires `onModelLoaded` — which arms this very plugin again one second
    // later. Without this guard the second arming tears the first run's
    // document out from under it mid-build, and the first symptom is a null
    // `bakeRegistry` in an unrelated stack.
    if (this._cellsRunning) return;
    this._cellsRunning = true;
    const generation = this._generation;
    const aborted = (): boolean => generation !== this._generation;
    const env = this.applyEnvironment(viewer, { ...params, keepModel: true });

    const [{ buildCellMatrix, cellMatrixStats }, { getEmptyGlbUrl }] = await Promise.all([
      import('../../core/engine/perf/rv-cell-matrix'),
      import('../../core/hmi/scene/empty-glb'),
    ]);
    if (aborted()) return;

    try {
      await viewer.loadModel(getEmptyGlbUrl());
    } catch (err) {
      this.publish(viewer, {
        scenario: 'cells', mode: params.mode, pass: false, env,
        reason: `could not open the empty document: ${err instanceof Error ? err.message : String(err)}`,
      });
      this._cellsRunning = false;
      return;
    }
    if (aborted()) { this._cellsRunning = false; return; }

    let stats;
    try {
      stats = await buildCellMatrix(viewer, {
        cells: params.cells,
        conveyorsPerLane: params.cellConv,
        motion: params.cellMotion as never,
      });
    } catch (err) {
      this.publish(viewer, {
        scenario: 'cells', mode: params.mode, pass: false, env,
        reason: err instanceof Error ? err.message : String(err),
      });
      this._cellsRunning = false;
      return;
    }
    this._cellMatrixBuilt = true;
    this._cellMatrixViewer = viewer;
    if (aborted()) return;

    // The probe is a DEV-only global installed near the end of `main.ts init()`;
    // on a cold Vite server that can be later than this plugin's first arming.
    await this.waitForHooks(180_000, aborted);
    const probe = this.probeHook();
    probe?.start();
    this._probeRunning = !!probe;

    // FORCE A CONTINUOUS FRAME RATE for the measurement window. The viewer
    // renders on demand, so a static matrix (`cellmotion=none`) would render a
    // handful of frames and every percentile would be computed over a sample of
    // three — and `renderer.info` would describe whichever frame happened last,
    // not a frame of the scene under test.
    const stopPump = this.pumpFrames(viewer, aborted);

    try {
      // Warmup: shader compilation, the first shadow pass and the BVH hand-over
      // all land in the first frames.
      await this.sleep(2000);
      if (aborted()) return;
      probe?.reset();
      await this.sleep(Math.max(1, params.durationS) * 1000);
      if (aborted()) return;
    } finally {
      stopPump();
      this._cellsRunning = false;
    }

    probe?.stop();
    this._probeRunning = false;
    const probeReport = probe?.reportJSON() ?? {};
    const frame = (probeReport.frameMs ?? {}) as { p50?: number; p95?: number; p99?: number; max?: number };
    const final = cellMatrixStats(viewer) ?? stats;

    // The gate the runner grades on lives in the runner; a cell run "passes"
    // here when the scene it measured is the scene it claims: one bake per
    // asset, the expected placement count, no sensors and a complete pick
    // structure on every chunk.
    const built = final.placements === params.cells * (params.cellConv + 1);
    const pass = built && final.bakes === 2 && final.activeSensors === 0 && final.pickOk;

    this.publish(viewer, {
      scenario: 'cells',
      mode: params.mode,
      pass,
      ...(pass ? {} : { reason: `cell matrix invalid: placements=${final.placements} bakes=${final.bakes} sensors=${final.activeSensors} pickOk=${final.pickOk}` }),
      cellMatrix: final,
      frameStats: viewer.getRendererInfo?.()?.frame,
      probe: probeReport,
      env,
      frameTime: {
        min: Math.round(frame.p50 ?? 0),
        avg: Math.round(frame.p50 ?? 0),
        max: Math.round(frame.max ?? 0),
      },
    });
  }

  /**
   * Ask for a rendered frame every animation frame until the returned function
   * is called. Returns the stopper.
   */
  private pumpFrames(viewer: RVViewer, aborted: () => boolean): () => void {
    let running = true;
    const tick = (): void => {
      if (!running || aborted()) return;
      viewer.markRenderDirty?.();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { running = false; };
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
      // Library assets are fetched and parsed BEFORE the build (which is
      // synchronous) and before the probe starts, so a 15 MB GLB parse is never
      // charged to the measurement window.
      if (params.cfg.geometry === 'library' || params.cfg.muAsset !== 'primitive') {
        await line.preload?.(params.cfg);
      }
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

    // plan-469: decided BEFORE `start()`, which is where the probe installs (or
    // does not install) the manager's region hooks.
    probe.regionHooksEnabled = params.hooks;
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

    // An EXPLICIT `?duration=` is honoured in BOTH modes (plan-469 Phase 0d).
    // The old 300 s floor guarded against a report claiming the §1.3 verdict
    // over a window too short to see drift — but `readPerfParams` already
    // DEFAULTS `durationS` to `DEFAULT_OBSERVATION_S` in supported mode, so the
    // guard only ever fired against an operator who asked for something shorter
    // on purpose. A campaign comparing a dozen configurations on one machine
    // cannot afford 300 s per run, and silently measuring five times longer than
    // asked is worse than a documented shorter window: `window (s)` is in every
    // report, so each verdict states the window it was reached over.
    const windowS = params.durationS;
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

    // plan-473 F4: the run-validity gate. Only now is the probe's lost-sim-time
    // figure final, so the verdict is formed here and written back onto the
    // `stationarity` payload the report and the runner already consume.
    let validity: RunValidity | undefined;
    if (params.mode !== 'smoke') {
      validity = evaluateRunValidity({
        targetMUs: stationarity.targetMUs,
        liveMUs: stationarity.liveMUs,
        spawnRate: stationarity.spawnRate,
        sinkRate: stationarity.sinkRate,
        referenceSpawnRate: params.referenceSpawnRate,
        lostSimSeconds: Number(probeReport.lostSimSeconds ?? 0),
        windowS: stationarity.windowS,
      });
      stationarity.reached = validity.valid;
      stationarity.reason = validity.reason;
    }

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
      ...(validity !== undefined ? { validity } : {}),
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

    // plan-473 F4: `supported` mode no longer decides here. The verdict needs
    // the probe's lost-simulation-time figure, which is only final once the
    // probe is stopped, so `runLine` grades the run via `evaluateRunValidity`
    // and writes the result back onto this object. Smoke mode keeps its own
    // wiring criterion — it makes no scale claim and has no target occupancy.
    let reached = true;
    let reason = 'graded after the run (plan-473 F4)';
    if (params.mode === 'smoke') {
      // Function criterion only — 30 s is far too short to fill a large line.
      reached = spawnRate > 0 && sensorEverTriggered;
      reason = reached
        ? 'smoke: spawns observed, sensor triggered'
        : `smoke: spawnRate ${spawnRate.toFixed(2)}/s, sensorTriggered ${sensorEverTriggered}`;
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
