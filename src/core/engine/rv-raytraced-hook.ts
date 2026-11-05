// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-raytraced-hook — the seam between the viewer's `raytraced` render mode
 * (plan-762) and an optional backend implementation.
 *
 * The core never imports a tracer: a commercial build registers a factory with
 * {@link registerRaytracedBackend} from its feature adapter. The render-mode
 * gate (`RenderModeContext.backendRegistered`, rv-render-modes.ts) reads
 * {@link getRaytracedBackend}; without a registration (community
 * build) the mode is not offered anywhere and a request for it is refused with
 * {@link RAYTRACED_UNAVAILABLE_MESSAGE}.
 *
 * Division of labour (plan-762 § 2):
 *  - the CORE renders the primary hit as a G-buffer (MRT in the TSL scene
 *    pass), hands it to the backend as a {@link RaytracedGBuffer} and
 *    composites `diffuseAlbedo × irradiance + specular` before tone mapping;
 *  - the BACKEND (private) owns the trace scene, the BVH, the compute kernel
 *    and the irradiance history, and publishes the history's read side through
 *    {@link RaytracedSceneHost.setIrradianceTexture}.
 *
 * Frame order: the viewer calls {@link RaytracedBackend.frame} BEFORE the
 * scene pass of the frame, so the backend reads the G-buffer of the PREVIOUS
 * pass together with that pass's camera matrices (spike 0.c). Since plan-767
 * the composite reprojects: it samples the irradiance at the position the
 * current pixel had in that previous pass ({@link RaytracedSceneHost.setIrradianceReprojection}).
 *
 * Engine layer: no import of rv-viewer / rv-plugin (eslint boundaries), and
 * nothing but `import type` from three.
 */

import type { Camera, Color, Euler, Object3D, Scene, Texture } from 'three';

// ─── Constants ────────────────────────────────────────────────────────────

/** Refusal text when the ray traced mode is requested on a WebGPU viewer without a registered backend. */
export const RAYTRACED_UNAVAILABLE_MESSAGE = 'Ray traced rendering is not available in this build.';

/** EMA cap while something changes (camera at rest, transforms / topology moving) — F10. */
export const RAYTRACED_HISTORY_CAP = 64;

/** `historyFrames` at which the backend stops keeping the viewer dirty (F11). */
export const RAYTRACED_TARGET_SAMPLES = 256;

/** Fractions of the pixels one kernel dispatch may trace (F16, TDR guard). */
export const RAYTRACED_PIXEL_BUDGETS = [1, 1 / 2, 1 / 4, 1 / 8] as const;

/** Default pixel budget per dispatch (spike 0.g). */
export const RAYTRACED_DEFAULT_PIXEL_BUDGET = 1 / 4;

/** Diffuse bounces per sample: default and upper bound (F9). */
export const RAYTRACED_DEFAULT_BOUNCES = 1;
export const RAYTRACED_MAX_BOUNCES = 3;

/** `performance.measure` names — they land in `web_layout_timings.measures` (F12). */
export const RAYTRACED_MEASURE_BVH = 'rv:raytraced-bvh';
export const RAYTRACED_MEASURE_UPDATE = 'rv:raytraced-update';
export const RAYTRACED_MEASURE_KERNEL = 'rv:raytraced-kernel';
/** `performance.measure` name of the per-render transform refit (`afterRender`, plan-767 F3). */
export const RAYTRACED_MEASURE_REFIT = 'rv:raytraced-refit';

/** Status text shown (and logged) right before the blocking structure build (F7). */
export const RAYTRACED_BUILD_STATUS = 'Building ray tracing structure…';

// ─── G-buffer ─────────────────────────────────────────────────────────────

/**
 * The G-buffer of the LAST rendered scene pass (plan-762 F5).
 *
 * Owned and mutated IN PLACE by the TSL post pipeline after every
 * `pipeline.render()`: the matrices, the size and `generation` describe the
 * pass whose textures are listed here. A backend that compares frames must
 * copy what it compares (e.g. `viewProjectionInverse`).
 *
 * Texture conventions (spikes 0.a / 0.d):
 *  - `depth`   — `DepthTexture`, `depth32float`, standard depth [0, 1] (not
 *    reversed), sky = 1.0 exactly. World position =
 *    `viewProjectionInverse · (ndc.x, ndc.y, depth, 1) / w` with
 *    `ndc = ((x + 0.5) / W · 2 − 1, 1 − (y + 0.5) / H · 2)`, x/y = texel
 *    coordinates with row 0 at the top (the same for perspective and ortho —
 *    the ray origin is the reconstructed position, never `cameraPosition`).
 *  - `diffuse` — RGBA16F, linear, `diffuseColor.rgb × (1 − metalness)`.
 *  - `normal`  — RGBA8, `directionToColor(normalWorld)` (world space; unpack
 *    with `n = rgb · 2 − 1`).
 *  - `specular` — RGBA16F. Raster layout: the raster direct + indirect
 *    specular radiance. Traced-specular layout (`specularMaterial`, plan-767
 *    run 3): rgb = F0 (`specularColorBlended`), a = roughness — the backend
 *    traces the specular itself and the composite multiplies its history by
 *    the analytic environment BRDF (Karis) of these values.
 *
 * Every pass texture is single-sampled (`samples: 0` — mandatory, spike 0.a).
 */
export interface RaytracedGBuffer {
  readonly depth: Texture;
  readonly diffuse: Texture;
  readonly normal: Texture;
  readonly specular: Texture;
  /** `true` when `specular` holds the traced-specular layout (rgb = F0, a = roughness) — see {@link RaytracedSceneHost.setSpecularTexture}. */
  readonly specularMaterial?: boolean;
  /** Column-major `(projection · view)⁻¹` of the pass camera (16 floats). */
  readonly viewProjectionInverse: Float32Array;
  /**
   * Column-major `projection · view` of the pass camera (16 floats) — the forward matrix a
   * backend keeps to reproject later pixels into this pass (plan-767 F6).
   */
  readonly viewProjection: Float32Array;
  /** World position of the pass camera. */
  readonly cameraPosition: [number, number, number];
  readonly isOrthographic: boolean;
  /** Pass render-target size in pixels (drawing-buffer size). */
  readonly width: number;
  readonly height: number;
  /**
   * Bumps on every graph build (new pass, new texture objects) AND on every
   * size change. A backend rebinds all textures AND resets its history when
   * it differs from the value it bound (spike 0.c — a stale binding reads
   * zeros silently).
   */
  readonly generation: number;
}

// ─── Host ─────────────────────────────────────────────────────────────────

/** The environment the kernel samples — the same source as the viewer's IBL. */
export interface RaytracedEnvironment {
  /** URL of the raw equirect HDR (the viewer keeps only the PMREM result). */
  hdrUrl: string;
  /** `scene.environmentRotation`. */
  rotation: Euler;
  /** `scene.environmentIntensity`; 0 when the current mode has no environment. */
  intensity: number;
}

/** The viewer's ground plane as a receiver / occluder quad for the trace scene (F8). */
export interface RaytracedGroundPlane {
  /** Centre of the square floor disc (world, metres). */
  x: number;
  y: number;
  z: number;
  /** Full side length of the square (metres). */
  extent: number;
  /** Ground albedo (material tint = colour × brightness), linear. Live object — copy it. */
  color: Color;
}

/** Device limits of the real WebGPU device (spike 0.f: check buffers against them). */
export interface RaytracedDeviceLimits {
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxStorageBuffersPerShaderStage: number;
  maxComputeWorkgroupStorageSize: number;
}

/** Topology / content signals the backend can subscribe to (F8). */
export type RaytracedHostEvent = 'model-cleared' | 'placements-materialized' | 'resize' | 'topology';

/**
 * Everything the backend may read from the viewer. One host object per mode
 * entry: after that entry ended (exit, model cleared, fatal error) its
 * callbacks become no-ops, so a late call of a stale backend cannot touch a
 * newer one.
 */
export interface RaytracedSceneHost {
  /** The initialised three/webgpu `Renderer` (typed loosely: the engine layer imports no three/webgpu). */
  readonly renderer: unknown;
  readonly scene: Scene;
  /** The ACTIVE camera (changes on a persp/ortho swap — read it per frame). */
  camera(): Camera;
  /** Root of the loaded model, `null` when none. Changes on reload. */
  modelRoot(): Object3D | null;
  environment(): RaytracedEnvironment;
  /** `null` when the ground is hidden (then no floor quad). */
  groundPlane(): RaytracedGroundPlane | null;
  /** `null` until the first MRT scene pass rendered (spike 0.a: never dispatch before). */
  gbuffer(): RaytracedGBuffer | null;
  /** `null` on a device without these limits (webgpu-gl, tests). */
  deviceLimits(): RaytracedDeviceLimits | null;
  /** Bind the irradiance (history read side, `rgba16float`, rgb = E, a = N). `null` → black placeholder with N = 0 (the composite shows the raster output). No graph rebuild. */
  setIrradianceTexture(texture: Texture | null): void;
  /**
   * Composite reprojection (plan-767 F9). `viewProjection` = the forward `projection · view`
   * (column-major, 16 floats, copied) of the G-buffer the bound irradiance was computed on;
   * `geometry` = a copy of that G-buffer, `rgba32float`, rgb = the packed world normal
   * (`directionToColor`), a = the standard depth, same size as the irradiance. The composite then
   * samples the irradiance at the reprojected position of each pixel and validates the tap
   * against `geometry` (invalid → raster output). `null` → no reprojection (same pixel). Bound
   * to the DISPATCH: frames rendered without one keep the last values. No graph rebuild.
   */
  setIrradianceReprojection(viewProjection: Float32Array | null, geometry: Texture | null): void;
  /**
   * Traced specular (plan-767 run 3, optional). A texture = the specular history read side
   * (`rgba16float`, rgb = specular radiance DIVIDED by the environment BRDF of the G-buffer
   * F0 / roughness, a = its history length N): the G-buffer switches its `specular` attachment to
   * the material layout (graph rebuild once → new `generation`) and the composite uses
   * `diffuse × irradiance + envBrdf × specular`, reprojected like the irradiance. `null` → raster
   * specular (the default layout). Re-binding the other ping-pong side is no rebuild.
   */
  setSpecularTexture?(texture: Texture | null): void;
  /** Keep the viewer rendering next frame (render-on-demand; F11). */
  requestRender(): void;
  /** Report an unrecoverable error: the viewer warns and falls back to the default mode. */
  onFatal(reason: string): void;
  /** Subscribe to a host signal; returns the unsubscribe function. */
  on(event: RaytracedHostEvent, cb: () => void): () => void;
}

// ─── Backend ──────────────────────────────────────────────────────────────

/** Diagnostics of the mode — `web_status.raytraced` (F12). */
export interface RaytracedStats {
  /** A backend exists (setup pending or done). */
  active: boolean;
  /** Setup finished; the composite runs. */
  ready: boolean;
  /** Mode-entry epoch (F7). */
  epoch: number;
  bvhBuildMs: number;
  lastUpdateMs: number;
  kernelMs: number;
  triangles: number;
  instances: number;
  /** Global sample measure `kernelDispatches × pixelBudget` (F11). */
  historyFrames: number;
  /** `historyFrames` at which render-on-demand resumes. */
  targetSamples: number;
  /** Fraction of the pixels per dispatch (one of {@link RAYTRACED_PIXEL_BUDGETS}). */
  pixelBudget: number;
  bounces: number;
  /** EMA cap of the last frame (`null` = uncapped progressive mean). */
  cap: number | null;
  lastError: string | null;
  /** Last refit (transform update after the render) time in ms (optional backend diagnostics, plan-767). */
  refitMs?: number;
  /** Largest refit time since mode entry, ms. */
  refitMsMax?: number;
  /** Longest backend stall (frame / afterRender / repack wall time > 50 ms) since mode entry, ms; 0 = none. */
  stallMsMax?: number;
  /**
   * Convergence measure of render-on-demand (plan-767 F14): dispatches since the last motion
   * (camera, moved objects, topology) × pixel budget. Rendering stops at `targetSamples`;
   * motion resets this counter, not the history.
   */
  samplesSinceMotion?: number;
  /** Newest backend events, oldest first (≤ 32): resets, repacks, refits, stalls, kernel rebuilds. */
  events?: ReadonlyArray<{ t: number; kind: string; reason?: string; ms?: number }>;
  /** Event counters since mode entry; `resets` per reason. */
  counters?: { resets: Record<string, number>; repacks: number; stalls: number; refits: number; rebinds?: number };
  /** Free-form backend diagnostics (trace-scene pools, topology reasons, …). */
  diagnostics?: Record<string, unknown>;
}

/**
 * The private backend. Lifecycle (F7):
 *  - `setup(host)` once per mode entry; the viewer checks its epoch after it
 *    resolves and disposes a stale result. `dispose()` may be called while
 *    `setup()` is pending: the backend checks its `disposed` flag after every
 *    await and creates nothing afterwards (the synchronous BVH build itself is
 *    not abortable — documented limit).
 *  - `frame()` once per TSL-branch render, BEFORE the scene pass; never
 *    throws (errors go to `host.onFatal`). Not called in isolate / XR /
 *    wireframe / video capture (F17).
 *  - `afterRender()` (optional, plan-767 F3 / review M3) once per TSL-branch
 *    render in which `frame()` ran, right AFTER the pipeline render: the
 *    backend syncs its transforms / BVH to the state just drawn, so BVH(t)
 *    pairs with G-buffer(t) at the next dispatch. Never throws.
 *  - `resize(w, h)` on a drawing-buffer change (pixels; 0×0 never arrives).
 */
export interface RaytracedBackend {
  setup(host: RaytracedSceneHost): Promise<void>;
  frame(): void;
  afterRender?(): void;
  resize(width: number, height: number): void;
  resetHistory(): void;
  stats(): RaytracedStats;
  /** Idempotent, never throws, allowed during `setup()`. */
  dispose(): void;
}

/** Stats of a viewer without a live backend (`active: false`). */
export function inactiveRaytracedStats(epoch = 0): RaytracedStats {
  return {
    active: false,
    ready: false,
    epoch,
    bvhBuildMs: 0,
    lastUpdateMs: 0,
    kernelMs: 0,
    triangles: 0,
    instances: 0,
    historyFrames: 0,
    targetSamples: RAYTRACED_TARGET_SAMPLES,
    pixelBudget: RAYTRACED_DEFAULT_PIXEL_BUDGET,
    bounces: RAYTRACED_DEFAULT_BOUNCES,
    cap: RAYTRACED_HISTORY_CAP,
    lastError: null,
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────

/**
 * Lazily creates the backend. Called on mode entry only, so the tracer code is
 * never loaded on startup (dynamic import inside the factory body).
 */
export type RaytracedBackendFactory = () => Promise<RaytracedBackend>;

let _factory: RaytracedBackendFactory | null = null;

/** Register (or, with `null`, unregister) the ray traced backend factory. */
export function registerRaytracedBackend(factory: RaytracedBackendFactory | null): void {
  _factory = factory;
}

/** The registered backend factory, or `null` when this build has none. */
export function getRaytracedBackend(): RaytracedBackendFactory | null {
  return _factory;
}
