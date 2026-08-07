// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-render-backend.ts — Optional, swappable 3D render backend (plan-256).
 *
 * realvirtual WEB renders its 3D scene with Three.js by default. This module
 * lets a *non-Three* backend (e.g. an NVIDIA Omniverse RTX WebRTC stream) take
 * over the 3D pixels while HMI, SignalStore and all adapters stay identical.
 *
 * ── Render-pause ≠ Sim-pause (KRITISCH, plan-256 §2.5) ──────────────────────
 * The SimulationLoop drives *both* rendering (`onRender`) and fixed-update /
 * signal-flush (`onFixedUpdate`) from the same RAF/setAnimationLoop callback.
 * Switching to a non-Three backend must NOT stop the loop or pause the
 * simulation — that would freeze the WS signal-flush and the live HMI values.
 * Therefore this controller only exposes a `renderPaused` flag that the viewer
 * consults to *skip the Three GPU render calls*. `onFixedUpdate` keeps running,
 * SignalStore and the WebSocket adapter are untouched.
 *
 * The Three.js pipeline in `rv-viewer.ts` is intentionally left completely
 * unchanged (no extraction into a `three-backend.ts`). The Omniverse backend is
 * an additive video-overlay layer that lives in the private repo and is loaded
 * only behind the `__RV_INTERNAL__`-gated dynamic import (see internal-plugins).
 */

/** Identifier of a render backend. `three` is always available (built-in). */
export type RenderBackendId = 'three' | 'omniverse';

/** Lifecycle status of a non-Three backend, surfaced in the HMI toggle. */
export type RenderBackendStatus =
  | 'idle'        // three active / no stream backend mounted
  | 'connecting'  // backend mounting, negotiating the stream
  | 'streaming'   // stream is live
  | 'loading'     // stream live, but the render side is loading/converting a scene
  | 'waiting'     // backend mounted but the source/stream is not available yet
  | 'error';      // backend failed to mount

/** Capability bundle handed to a backend factory when the backend is mounted. */
export interface RenderBackendContext {
  /** DOM mount point for the backend's overlay (the viewer container). */
  container: HTMLElement;
  /** Report a status transition (drives the HMI status label). `detail` is an
   *  optional human-readable line (e.g. "Converting GLB…", an error message). */
  reportStatus(status: RenderBackendStatus, detail?: string): void;
}

/**
 * Options for a single WEB→backend drive-value message (plan-256). Mirror of the
 * Kit-side `setDriveValue` payload contract; all fields optional so the Kit
 * extension's own defaults apply when omitted (primPath `/World/Axis`, mode
 * `rotate`, axis `1`, scale `1.0`).
 */
export interface DriveValueOptions {
  /** USD prim to drive on the Kit side. */
  primPath?: string;
  /** Whether the value rotates or translates the prim. */
  mode?: 'rotate' | 'translate';
  /** Axis index (0=X, 1=Y, 2=Z). */
  axis?: 0 | 1 | 2;
  /** Multiplier applied to `value` on the Kit side. */
  scale?: number;
}

/**
 * Configures the per-tick WEB→backend drive bridge (plan-256): which local value
 * mirrors to the streamed 3D prim while a non-Three backend is active. Additive —
 * the Three path and the signal flush are untouched.
 */
export interface RenderBackendDriveBridgeConfig {
  /** Master switch. Default `true` (harmless while Three is active). */
  enabled?: boolean;
  /** Signal name to push (SignalStore). When set it wins over `driveName`. */
  signalName?: string;
  /** Drive to read `currentPosition` from (by name). When unset, the first drive. */
  driveName?: string;
  /** `setDriveValue` payload options forwarded to the backend. */
  drive?: DriveValueOptions;
}

/** Minimal structural view of a drive for the bridge value source. */
export interface DriveValueSource {
  readonly name: string;
  readonly currentPosition: number;
}

/** Minimal structural view of the signal store for the bridge value source. */
export interface SignalValueSource {
  get(name: string): boolean | number | undefined;
}

/**
 * Resolve the value to push this tick: a configured signal (number, or bool→0/1)
 * takes precedence, otherwise the named drive's `currentPosition`, otherwise the
 * first drive's. Returns `undefined` when no source resolves (nothing is sent).
 */
export function readDriveBridgeValue(
  cfg: RenderBackendDriveBridgeConfig,
  drives: readonly DriveValueSource[],
  signals?: SignalValueSource | null,
): number | undefined {
  if (cfg.signalName) {
    const v = signals?.get(cfg.signalName);
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return undefined;
  }
  const drive = cfg.driveName
    ? drives.find((d) => d.name === cfg.driveName)
    : drives[0];
  return drive ? drive.currentPosition : undefined;
}

/**
 * Push one drive value to the active non-Three backend, if any. No-op while
 * Three is active, while disabled, when no backend implements `sendDriveValue`,
 * or when `readValue()` yields `undefined`. The backend itself applies the
 * dirty-guard (only sends on change), so this may be called every tick.
 */
export function pushRenderBackendDriveValue(
  controller: RenderBackendController,
  cfg: RenderBackendDriveBridgeConfig,
  readValue: () => number | undefined,
): void {
  if (controller.backend === 'three') return;
  if (cfg.enabled === false) return;
  const backend = controller.active;
  if (!backend?.sendDriveValue) return;
  const value = readValue();
  if (value === undefined) return;
  backend.sendDriveValue(value, cfg.drive);
}

/**
 * A non-Three render backend instance. Created lazily by a registered factory
 * when the user switches to it, disposed when switching away.
 *
 * CONTRACT: `dispose()` MUST release every resource it created — in particular
 * the WebRTC `PeerConnection` / streaming-library instance — so repeated
 * `three ↔ omniverse` switches leave no orphaned connections.
 */
export interface RenderBackend {
  readonly id: RenderBackendId;
  /** Build the overlay + start streaming. May resolve after the stream begins. */
  mount(): void | Promise<void>;
  /** Tear down the overlay, close the stream, free all resources. Idempotent. */
  dispose(): void;
  /**
   * Optional: push a drive/signal value to the backend's 3D scene (plan-256,
   * WEB→Kit `setDriveValue`). Backends that can drive their prim implement this;
   * others omit it. Implementations SHOULD dirty-guard (send only on change).
   */
  sendDriveValue?(value: number, opts?: DriveValueOptions): void;
  /**
   * Optional: ask the backend to render a GLB by URL (plan-256 "Weg A"). The
   * backend projects it to its native format internally (e.g. Kit converts
   * GLB→USD via omni.kit.asset_converter) and loads it. rv_extras stay in the
   * GLB (SSOT); the projection is geometry only. Resolves when the render side
   * confirms load (or rejects on error).
   */
  loadGlb?(url: string, opts?: { addLights?: boolean }): Promise<void>;
}

/** Factory that constructs a backend from the viewer-provided context. */
export type RenderBackendFactory = (ctx: RenderBackendContext) => RenderBackend;

/**
 * A plugin that needs to react when the active render backend changes.
 *
 * The concrete interactive 3D plugins (measurement, ik-target-edit, snap-point,
 * clipping, webxr, gaussian-splat, drive-axis-gizmo, …) rely on
 * `viewer.camera()` / `viewer.renderer` / raycasting against the Three scene.
 * Under a non-Three backend that interaction is meaningless, so they must
 * no-op. The viewer additionally neutralises them centrally: while
 * `shouldRenderThree()` is false the per-frame `onRender` plugin dispatch is
 * skipped and the WebGL canvas is `display:none` (so no pointer events reach
 * the raycaster). This hook is the *explicit* per-plugin signal for anything
 * that needs to tear down beyond that (open gizmos, drag handlers).
 */
export interface RenderBackendAwarePlugin {
  onRenderBackendChanged?(backend: RenderBackendId, viewer: unknown): void;
}

/**
 * Owns the render-backend state: which backend is active, whether the Three
 * renderer is paused, the registered backend factories, and the active
 * non-Three instance. Deliberately DOM-light and framework-free so it is unit
 * testable in isolation (mirrors how `SimulationLoop` is tested directly).
 */
export class RenderBackendController {
  private _backend: RenderBackendId = 'three';
  private _renderPaused = false;
  private _status: RenderBackendStatus = 'idle';
  private _statusDetail = '';
  private readonly _factories = new Map<RenderBackendId, RenderBackendFactory>();
  private _active: RenderBackend | null = null;
  private readonly _backendListeners = new Set<(b: RenderBackendId) => void>();
  private readonly _statusListeners = new Set<(s: RenderBackendStatus) => void>();

  /** Currently active render backend. */
  get backend(): RenderBackendId { return this._backend; }

  /** The live non-Three backend instance, or `null` while Three is active. */
  get active(): RenderBackend | null { return this._active; }

  /** True while the Three GPU render calls are being skipped. */
  get renderPaused(): boolean { return this._renderPaused; }

  /** Status of the active non-Three backend (`idle` while Three is active). */
  get status(): RenderBackendStatus { return this._status; }

  /** Human-readable detail for the current status (progress/error line, may be empty). */
  get statusDetail(): string { return this._statusDetail; }

  /**
   * True when the Three.js `renderer.render(...)` calls (and the per-frame
   * plugin `onRender` dispatch) should execute this frame. False when a
   * non-Three backend is active OR rendering is explicitly paused. The
   * simulation loop / signal-flush are NOT gated by this — see file header.
   */
  shouldRenderThree(): boolean {
    return this._backend === 'three' && !this._renderPaused;
  }

  /**
   * True when the interactive 3D plugins (raycast/gizmo/camera manipulation)
   * are meaningful. False under any non-Three backend.
   */
  shouldRunThreePlugins(): boolean {
    return this._backend === 'three';
  }

  /**
   * Pause the Three renderer WITHOUT touching the simulation loop. Only the
   * `renderer.render(...)` calls are skipped; `onFixedUpdate` / SignalStore /
   * adapters keep running. Deliberately named apart from the sim-pause
   * mechanisms (`isSimulationPaused()`, `simulationPauseReasons()`).
   */
  pauseRendering(): void { this._renderPaused = true; }

  /** Resume the Three renderer. */
  resumeRendering(): void { this._renderPaused = false; }

  /** Register a factory for a non-Three backend (called from internal-plugins). */
  registerFactory(id: RenderBackendId, factory: RenderBackendFactory): void {
    this._factories.set(id, factory);
  }

  /** Whether a backend is usable: `three` always; others only once registered. */
  hasBackend(id: RenderBackendId): boolean {
    return id === 'three' || this._factories.has(id);
  }

  /** Subscribe to backend switches. Returns an unsubscribe function. */
  onBackendChange(cb: (b: RenderBackendId) => void): () => void {
    this._backendListeners.add(cb);
    return () => { this._backendListeners.delete(cb); };
  }

  /** Subscribe to status changes of the active backend. Returns unsubscribe. */
  onStatusChange(cb: (s: RenderBackendStatus) => void): () => void {
    this._statusListeners.add(cb);
    return () => { this._statusListeners.delete(cb); };
  }

  /**
   * Switch the active render backend.
   *
   * `three` → resumes Three rendering, disposes any active non-Three backend.
   * A non-Three id → pauses Three rendering, instantiates the registered
   * factory and mounts it. The previous non-Three backend is always disposed
   * first, so repeated switches never leak stream/PeerConnection instances.
   *
   * @param container Required when switching to a non-Three backend (mount point).
   * @throws if the requested non-Three backend has no registered factory.
   */
  async setBackend(next: RenderBackendId, container?: HTMLElement): Promise<void> {
    if (next === this._backend && next === 'three') return;
    if (next !== 'three' && !this._factories.has(next)) {
      this._setStatus('error');
      throw new Error(`[render-backend] '${next}' is not registered (internal tier only)`);
    }

    // Always dispose the previous non-Three backend before switching — this is
    // what guarantees no orphaned WebRTC PeerConnections across switch cycles.
    if (this._active) {
      this._active.dispose();
      this._active = null;
    }

    this._backend = next;

    if (next === 'three') {
      this.resumeRendering();
      this._setStatus('idle');
    } else {
      // Stop Three GPU work; the sim loop + signal flush keep running.
      this.pauseRendering();
      this._setStatus('connecting');
      if (!container) {
        this._setStatus('error');
        throw new Error(`[render-backend] '${next}' requires a container element`);
      }
      const factory = this._factories.get(next)!;
      this._active = factory({
        container,
        reportStatus: (s, d) => this._setStatus(s, d),
      });
      await this._active.mount();
    }

    for (const cb of this._backendListeners) {
      try { cb(next); } catch (e) { console.error('[render-backend] backend listener error:', e); }
    }
  }

  /** Tear down the active backend and drop all listeners (viewer dispose). */
  dispose(): void {
    if (this._active) {
      this._active.dispose();
      this._active = null;
    }
    this._backendListeners.clear();
    this._statusListeners.clear();
    this._backend = 'three';
    this._renderPaused = false;
    this._status = 'idle';
    this._statusDetail = '';
  }

  private _setStatus(s: RenderBackendStatus, detail = ''): void {
    if (s === this._status && detail === this._statusDetail) return;
    this._status = s;
    this._statusDetail = detail;
    for (const cb of this._statusListeners) {
      try { cb(s); } catch (e) { console.error('[render-backend] status listener error:', e); }
    }
  }
}
