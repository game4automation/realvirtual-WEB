// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-raytraced-host — the viewer-side lifecycle of the `raytraced` render mode
 * (plan-762 F7): one {@link RaytracedModeController} per viewer owns the
 * backend instance, the epoch token, the per-entry {@link RaytracedSceneHost}
 * and the fatal-error rule. `rv-viewer.ts` only forwards its events and
 * calls into it (renderMode setter, render loop, resize, dispose).
 *
 * Epoch rule: every `enter()` and every `exit()` bumps the epoch. An entry
 * checks its epoch after `await factory()` AND after `await setup()`; a stale
 * result is disposed (or was already disposed by the `exit()` that made it
 * stale — the backend is held from the moment the factory resolved, so
 * `dispose()` may run while `setup()` is pending, exactly once). Host
 * callbacks of a stale entry are no-ops.
 *
 * Engine layer: no import of rv-viewer / rv-plugin, nothing but `import type`
 * from three. The viewer passes its state in through {@link RaytracedControllerDeps}.
 */

import type { Texture } from 'three';
import {
  inactiveRaytracedStats,
  RAYTRACED_BUILD_STATUS,
  RAYTRACED_UNAVAILABLE_MESSAGE,
  type RaytracedBackend,
  type RaytracedBackendFactory,
  type RaytracedGBuffer,
  type RaytracedHostEvent,
  type RaytracedSceneHost,
  type RaytracedStats,
} from './rv-raytraced-hook';

/** What the controller needs from the TSL post pipeline (`TslPostPipeline` satisfies it). */
export interface RaytracedPipelineLike {
  setRaytraced(irradiance: Texture | null): void;
  setRaytracedIrradiance(irradiance: Texture | null): void;
  /** Composite reprojection (plan-767 F9); optional for pipelines without it (tests). */
  setRaytracedReprojection?(viewProjection: Float32Array | null, geometry: Texture | null): void;
  /** Traced specular (plan-767 run 3); optional for pipelines without it (tests). */
  setRaytracedSpecular?(specular: Texture | null): void;
  readonly raytracedIrradiance: Texture;
  readonly raytracedGBuffer: RaytracedGBuffer | null;
}

/** The scene-side getters of the host (the controller adds the lifecycle-bound ones). */
export type RaytracedSceneAccess = Pick<
  RaytracedSceneHost,
  'renderer' | 'scene' | 'camera' | 'modelRoot' | 'environment' | 'groundPlane' | 'deviceLimits'
>;

/** Viewer state and actions the controller depends on. */
export interface RaytracedControllerDeps {
  /** The registered backend factory (`getRaytracedBackend`). */
  factory(): RaytracedBackendFactory | null;
  /** Create (if needed) and return the TSL post pipeline; `null` when unavailable. */
  ensurePipeline(): RaytracedPipelineLike | null;
  /** The current pipeline without creating one. */
  pipeline(): RaytracedPipelineLike | null;
  /** `viewer.renderMode === 'raytraced'`. */
  isModeActive(): boolean;
  /** A model is loaded AND its placements are materialised (no load in flight). */
  sceneReady(): boolean;
  /**
   * Resolves when no load is in flight and no placement materialises
   * (`viewer.whenSceneReady`). `placements-materialized` fires while the load
   * gate may still be closed, so the wait joins on this, not on the event alone.
   */
  whenSceneReady(): Promise<void>;
  /** Switch the viewer to the default mode (`setRenderMode(viewer, 'default')`). */
  fallbackToDefault(): void;
  /** Mark the viewer dirty (render-on-demand). */
  requestRender(): void;
  /** Show / clear the mode's status text. */
  status(text: string | null): void;
  /** Subscribe to a viewer event (`model-cleared`, `placements-materialized`, `topology` sources). */
  subscribe(event: RaytracedHostEvent, cb: () => void): () => void;
  scene: RaytracedSceneAccess;
  /** Defaults to `console.warn`. */
  warn?(message: string): void;
  /** Defaults to a `setTimeout(0)` macrotask (F7: let the status frame render). */
  yieldMacrotask?(): Promise<void>;
}

/** Where the mode stands — part of `web_status.raytraced`. */
export type RaytracedPhase = 'idle' | 'waiting-scene' | 'loading' | 'building' | 'ready';

/** `web_status.raytraced`: the backend stats plus the viewer-side phase. */
export type RaytracedStatus = RaytracedStats & { phase: RaytracedPhase };

const defaultYield = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeDispose(backend: RaytracedBackend | null): void {
  if (!backend) return;
  try { backend.dispose(); } catch { /* dispose never throws by contract — be defensive anyway */ }
}

export class RaytracedModeController {
  private readonly _deps: RaytracedControllerDeps;
  private _epoch = 0;
  private _backend: RaytracedBackend | null = null;
  private _entering = false;
  private _ready = false;
  private _phase: RaytracedPhase = 'idle';
  private _lastError: string | null = null;
  private _irradiance: Texture | null = null;
  /** Reprojection of the bound irradiance (plan-767 F9): forward VP copy + G-buffer copy. */
  private readonly _reprojVP = new Float32Array(16);
  private _reprojOn = false;
  private _reprojGeometry: Texture | null = null;
  /** Traced specular history read side (plan-767 run 3); null = raster specular. */
  private _specular: Texture | null = null;
  /** Host subscriptions of the live entry — dropped on exit. */
  private _subs: Array<() => void> = [];
  private readonly _resizeListeners = new Set<() => void>();
  private _disposed = false;

  constructor(deps: RaytracedControllerDeps) {
    this._deps = deps;
  }

  /** Bumps on every enter / exit. */
  get epoch(): number { return this._epoch; }
  /** Setup finished; the composite runs and `frame()` dispatches. */
  get ready(): boolean { return this._ready; }
  get phase(): RaytracedPhase { return this._phase; }
  /** The live backend (also during a pending `setup()`), `null` otherwise. */
  get backend(): RaytracedBackend | null { return this._backend; }

  /**
   * Enter the mode. No-op while an entry is in flight or a backend lives.
   * Without a ready scene it only records the wish ({@link onSceneReady}
   * enters later). Resolves when this entry finished (ready, stale or failed).
   */
  async enter(): Promise<void> {
    if (this._disposed || this._backend || this._entering) return;
    const epoch = ++this._epoch;
    this._lastError = null;
    if (!this._deps.sceneReady()) {
      // F7: never build a BVH of an empty / half-placed scene. Re-try when the
      // scene settles; with no model at all the next `placements-materialized`
      // ({@link onSceneReady}) starts the wait again.
      this._phase = 'waiting-scene';
      void this._deps.whenSceneReady().then(() => {
        if (epoch !== this._epoch || this._phase !== 'waiting-scene') return;
        if (this._deps.isModeActive() && this._deps.sceneReady()) void this.enter();
      });
      return;
    }
    const factory = this._deps.factory();
    if (!factory) { this._fatal(epoch, RAYTRACED_UNAVAILABLE_MESSAGE); return; }
    if (!this._deps.ensurePipeline()) {
      this._fatal(epoch, 'the TSL post pipeline is not available');
      return;
    }
    this._entering = true;
    this._phase = 'loading';
    let backend: RaytracedBackend;
    try {
      backend = await factory();
    } catch (err) {
      if (epoch === this._epoch) this._entering = false;
      this._fatal(epoch, `backend load failed: ${errorText(err)}`);
      return;
    }
    if (epoch !== this._epoch) { safeDispose(backend); return; }
    // Held from here on: an exit() during setup() disposes it (exactly once).
    this._backend = backend;
    const host = this._createHost(epoch);
    this._phase = 'building';
    this._deps.status(RAYTRACED_BUILD_STATUS);
    this._deps.requestRender();
    await (this._deps.yieldMacrotask ?? defaultYield)();
    if (epoch !== this._epoch) return;
    try {
      await backend.setup(host);
    } catch (err) {
      this._fatal(epoch, `setup failed: ${errorText(err)}`);
      return;
    }
    if (epoch !== this._epoch) return; // the exit() that made it stale disposed it
    const pipeline = this._deps.ensurePipeline();
    if (!pipeline) { this._fatal(epoch, 'the TSL post pipeline is not available'); return; }
    this._entering = false;
    this._ready = true;
    this._phase = 'ready';
    this._deps.status(null);
    pipeline.setRaytraced(this._irradiance ?? pipeline.raytracedIrradiance);
    pipeline.setRaytracedReprojection?.(this._reprojOn ? this._reprojVP : null, this._reprojOn ? this._reprojGeometry : null);
    pipeline.setRaytracedSpecular?.(this._specular);
    this._deps.requestRender();
  }

  /** Leave the mode: epoch++, composite off, backend disposed. Idempotent. */
  exit(): void {
    this._epoch++;
    const wasLive = this._backend !== null || this._entering || this._phase !== 'idle';
    this._entering = false;
    this._ready = false;
    this._phase = 'idle';
    this._irradiance = null;
    this._reprojOn = false;
    this._reprojGeometry = null;
    this._specular = null;
    for (const off of this._subs) off();
    this._subs = [];
    this._resizeListeners.clear();
    this._deps.pipeline()?.setRaytraced(null);
    const backend = this._backend;
    this._backend = null;
    safeDispose(backend);
    if (wasLive) {
      this._deps.status(null);
      this._deps.requestRender();
    }
  }

  /** `model-cleared`: the backend goes, the mode stays; the next ready scene re-enters. */
  onModelCleared(): void {
    if (this._phase === 'idle' && !this._backend) return;
    this.exit();
    if (this._deps.isModeActive()) this._phase = 'waiting-scene';
  }

  /** `placements-materialized`: (re-)enter when the mode is active and nothing lives. */
  onSceneReady(): void {
    if (!this._deps.isModeActive() || this._backend || this._entering) return;
    void this.enter();
  }

  /** The render loop's call in the TSL branch (F17-gated by the viewer). Never throws. */
  frame(): void {
    const backend = this._backend;
    if (!backend || !this._ready) return;
    try {
      backend.frame();
    } catch (err) {
      this._fatal(this._epoch, `frame failed: ${errorText(err)}`);
    }
  }

  /**
   * The render loop's call right after the TSL pipeline render of a frame in
   * which {@link frame} ran (plan-767 F3 / M3). Optional on the backend. Never throws.
   */
  afterRender(): void {
    const backend = this._backend;
    if (!backend || !this._ready || !backend.afterRender) return;
    try {
      backend.afterRender();
    } catch (err) {
      this._fatal(this._epoch, `afterRender failed: ${errorText(err)}`);
    }
  }

  /** Drawing-buffer resize (pixels). 0×0 is ignored. */
  resize(width: number, height: number): void {
    if (!(width > 0) || !(height > 0)) return;
    const backend = this._backend;
    if (!backend) return;
    try {
      backend.resize(width, height);
    } catch (err) {
      this._fatal(this._epoch, `resize failed: ${errorText(err)}`);
      return;
    }
    for (const cb of this._resizeListeners) cb();
  }

  /** WebGPU device lost: the renderer is dead — drop the backend quietly. */
  onDeviceLost(): void {
    this._lastError = 'WebGPU device lost';
    this.exit();
  }

  /** Viewer teardown. */
  dispose(): void {
    this.exit();
    this._disposed = true;
  }

  /** `web_status.raytraced` (F12): `active: false` without a backend. */
  stats(): RaytracedStatus {
    const backend = this._backend;
    if (!backend) return { ...inactiveRaytracedStats(this._epoch), lastError: this._lastError, phase: this._phase };
    let s: RaytracedStats;
    try {
      s = backend.stats();
    } catch (err) {
      s = { ...inactiveRaytracedStats(this._epoch), lastError: errorText(err) };
    }
    return {
      ...s,
      active: true,
      ready: this._ready,
      epoch: this._epoch,
      lastError: s.lastError ?? this._lastError,
      phase: this._phase,
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * F7 fatal rule: only the live entry may fall back. Warn, leave the mode's
   * backend at once, then — one microtask later, never inside the render
   * loop's pass — switch to the default mode if the user did not change it.
   */
  private _fatal(epoch: number, reason: string): void {
    if (epoch !== this._epoch) return;
    (this._deps.warn ?? ((m: string) => console.warn(m)))(`[RVViewer] Ray traced mode failed: ${reason} — falling back to Shaded.`);
    const wasActive = this._deps.isModeActive();
    this.exit();
    this._lastError = reason;
    const after = this._epoch;
    if (!wasActive) return;
    queueMicrotask(() => {
      if (this._epoch === after && this._deps.isModeActive()) this._deps.fallbackToDefault();
    });
  }

  private _createHost(epoch: number): RaytracedSceneHost {
    const live = (): boolean => epoch === this._epoch;
    const scene = this._deps.scene;
    return {
      renderer: scene.renderer,
      scene: scene.scene,
      camera: () => scene.camera(),
      modelRoot: () => scene.modelRoot(),
      environment: () => scene.environment(),
      groundPlane: () => scene.groundPlane(),
      deviceLimits: () => scene.deviceLimits(),
      gbuffer: () => (live() && this._ready ? this._deps.pipeline()?.raytracedGBuffer ?? null : null),
      setIrradianceTexture: (texture) => {
        if (!live()) return;
        this._irradiance = texture;
        if (this._ready) this._deps.pipeline()?.setRaytracedIrradiance(texture);
      },
      setIrradianceReprojection: (viewProjection, geometry) => {
        if (!live()) return;
        this._reprojOn = viewProjection !== null && geometry !== null;
        if (viewProjection) this._reprojVP.set(viewProjection.subarray(0, 16));
        this._reprojGeometry = geometry;
        if (this._ready) {
          this._deps.pipeline()?.setRaytracedReprojection?.(this._reprojOn ? this._reprojVP : null, this._reprojOn ? geometry : null);
        }
      },
      setSpecularTexture: (texture) => {
        if (!live()) return;
        this._specular = texture;
        if (this._ready) this._deps.pipeline()?.setRaytracedSpecular?.(texture);
      },
      requestRender: () => { if (live()) this._deps.requestRender(); },
      onFatal: (reason) => this._fatal(epoch, reason),
      on: (event, cb) => {
        if (!live()) return () => {};
        let off: () => void;
        if (event === 'resize') {
          this._resizeListeners.add(cb);
          off = () => { this._resizeListeners.delete(cb); };
        } else {
          off = this._deps.subscribe(event, cb);
        }
        this._subs.push(off);
        return off;
      },
    };
  }
}
