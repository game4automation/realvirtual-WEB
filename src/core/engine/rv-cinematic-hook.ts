// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cinematic-hook — the seam between the deterministic video capture
 * (plan-537, `rv-video-capture.ts`) and an optional path-traced frame source
 * (plan-550, "cinematic" quality).
 *
 * The core never imports a renderer: a commercial build registers a factory
 * with {@link registerCinematicRenderer} from its feature adapter, and the
 * capture asks {@link getCinematicRenderer} for it when a recording with
 * `quality: 'cinematic'` starts. Without a registration (community build) the
 * capture refuses cinematic with {@link CINEMATIC_UNAVAILABLE_MESSAGE}.
 *
 * The factory is called lazily, inside the capture, so the tracer code (and
 * its dependencies) is only loaded for a cinematic recording — never on
 * startup, never in the entry chunk.
 *
 * Engine layer: no import of rv-viewer / rv-plugin (eslint boundaries). The
 * frame source receives plain three.js objects.
 */

import type { Camera, Object3D, Scene } from 'three';

// ─── Constants ────────────────────────────────────────────────────────────

/** Samples per pixel of a cinematic frame when none are given (spike: ≈ 22 s per 1080p frame on a GTX 1060). */
export const CINEMATIC_DEFAULT_SAMPLES = 64;

/** Upper bound for `samples` — a guard against typos, not a quality limit. */
export const CINEMATIC_MAX_SAMPLES = 16384;

/** Denoiser mode: OIDN with albedo/normal guides (`aux`), colour only (`noaux`), or none. */
export type CinematicDenoise = 'aux' | 'noaux' | 'off';

/**
 * The equirect HDR the viewer's environment preset is built from
 * (`RVVisualSettingsManager.loadEnvMap`, relative to the deploy base). The
 * viewer only keeps the PMREM-filtered result; the path tracer needs the raw
 * equirect, so it loads this file itself.
 */
export const DEFAULT_ENVIRONMENT_HDR = 'envmaps/empty_warehouse_01_1k.hdr';

/** Error text of a cinematic request in a build without the commercial renderer. */
export const CINEMATIC_UNAVAILABLE_MESSAGE =
  'Cinematic render is a commercial feature — it is not available in this build.';

/**
 * Looks of the cinematic render (plan-553 F1): `studio` (cyclorama + softboxes, the default),
 * `viewer` (the viewer's environment preset and lights — the plan-550 behaviour), `hall` and
 * `outdoor`. The look DATA lives with the frame source; the core only knows the names.
 */
export const CINEMATIC_LOOKS = ['studio', 'viewer', 'hall', 'outdoor'] as const;
export type CinematicLookName = (typeof CINEMATIC_LOOKS)[number];
export const CINEMATIC_DEFAULT_LOOK: CinematicLookName = 'studio';

/** Vignette strength (corner darkening, 0..0.5) when none is given (plan-553 F2). */
export const CINEMATIC_DEFAULT_VIGNETTE = 0.15;
/** Aperture of the opt-in depth of field when none is given (plan-553 F6). */
export const CINEMATIC_DEFAULT_FSTOP = 5.6;

/** Motion blur (plan-554 F1): on by default, 180° shutter, 8 sub-frames. */
export const CINEMATIC_DEFAULT_MOTION_BLUR = true;
export const CINEMATIC_DEFAULT_SHUTTER_DEG = 180;
export const CINEMATIC_DEFAULT_BLUR_SUBFRAMES = 8;
/** Range of the sub-frame count K (plan-554 F1). */
export const CINEMATIC_MIN_BLUR_SUBFRAMES = 2;
export const CINEMATIC_MAX_BLUR_SUBFRAMES = 32;

/** Resolved motion-blur mode of a run (plan-554 F7): the algorithm that ran, or `off`. */
export type CinematicBlurMode = 'pathA-v1' | 'off';

/** Rule the frame source uses for its random sequence (recorded in the resume manifest). */
export const CINEMATIC_SEED_RULE = 'stable-noise/v1: the sample sequence restarts every frame; same scene + camera give the same image';

// ─── Types ────────────────────────────────────────────────────────────────

/** What the frame source traces: the live viewer objects (read only — the source copies them). */
export interface CinematicSceneHost {
  /** The viewer scene (lights, environment intensity / rotation, background). */
  scene: Scene;
  /** Root of the loaded model — the only subtree that is traced. */
  modelRoot: Object3D;
  /** The capture camera (pose set by the capture before every frame). */
  camera: Camera;
  /** The viewer's tone mapping (three.js constant) and exposure, applied to the traced image. */
  toneMapping?: { mapping: number; exposure: number };
}

export interface CinematicSetupOptions {
  width: number;
  height: number;
  /** Samples per pixel per frame. */
  samples: number;
  denoise: CinematicDenoise;
  /** Absolute URL of the equirect HDR to light the scene with. */
  hdrUrl: string;
  /** Absolute URL of the folder holding the OIDN weights (`…/oidn/`). */
  weightsBaseUrl: string;
  // ── plan-553: look, output and materials (all optional — absent = the plan-550 behaviour) ──
  /** The look; absent = `viewer` (the plan-550 setup). */
  look?: CinematicLookName;
  /** Vignette strength 0..0.5 on the final 8-bit frame; 0 / absent disables. */
  vignette?: number;
  /** Depth of field with the PhysicalCamera; the focus distance comes per frame ({@link CinematicFrameContext.focusDistance}). */
  dof?: boolean;
  /** Aperture f-number for `dof` (default {@link CINEMATIC_DEFAULT_FSTOP}). */
  fStop?: number;
  /** Physical material presets (glass, brushed metal, paint, rubber) + glowing lamps on the traced copy. */
  materialPresets?: boolean;
  /** Project overrides (`cinematic-materials.json` content): name pattern → preset / params. */
  materialOverrides?: CinematicMaterialOverrides | null;
  /**
   * Camera positions / targets of the path (world, m), frame 0 first — sampled by the capture so
   * the look can orient the cyclorama and the softboxes independently of the resume point.
   */
  cameraSamples?: Array<{ position: [number, number, number]; target: [number, number, number] }>;
  /**
   * plan-554: motion blur of a VIDEO (absent / null = off — a still never blurs). The sub-time
   * offsets follow from `fps` and `shutterDeg`; the frame source decides in `setup()` whether it
   * can blur ({@link CinematicSetupInfo.motionBlur}) — for the whole run.
   */
  motionBlur?: { shutterDeg: number; subFrames: number; fps: number } | null;
}

/** What a frame source resolved the motion blur to in `setup()` (plan-554 F5/F7). */
export interface CinematicBlurResolution {
  /** `pathA-v1` = blurred, `off` = sharp frames (requested off, or a fallback). */
  resolved: CinematicBlurMode;
  /** Why a requested blur fell back to `off`; null when it runs or was not requested. */
  reason: string | null;
  /** Effective sub-frames K_eff (1 = no blur). */
  subFrames: number;
}

/**
 * plan-554 F2: the READ-ONLY snapshot hook of the motion blur. The capture calls it inside
 * `advance(i)` of every RENDERED frame — never during the resume fast-forward, never with blur
 * off (N3): `beginFrame` before the first sim step ("end of the previous frame"), `afterStep`
 * after every single `fixedUpdate`, `afterRender` after `captureRenderFrame` ("render end").
 * Implementations must not write the viewer's scene graph (no `updateMatrixWorld`).
 */
export interface CinematicMotionRecorder {
  beginFrame(): void;
  afterStep(): void;
  afterRender(): void;
}

/** Content of a project's `cinematic-materials.json` (plan-553 F3c). */
export interface CinematicMaterialOverrides {
  version?: number;
  rules: Array<{
    /** Case-insensitive regular expression tested against the mesh name and the material name. */
    match: string;
    /** Preset name (`glass`, `brushedMetal`, `paint`, `rubber`) or `none` (keep the material as is). */
    preset: string;
    /** Optional MeshPhysicalMaterial number / colour fields applied after the preset (e.g. `{ "roughness": 0.2 }`). */
    params?: Record<string, number | string | boolean>;
  }>;
}

/**
 * What a look request resolves to (plan-553 F7) — computed BEFORE the fingerprint, so a resume
 * compares the effective look, not just its name.
 */
export interface CinematicResolvedLook {
  look: CinematicLookName;
  /** HDR path relative to the deploy base (e.g. `envmaps/studio.hdr`); null = {@link DEFAULT_ENVIRONMENT_HDR}. */
  hdr: string | null;
  /** The resolved look parameters (intensities, rotation, lights, floor, tone mapping, exposure). */
  params: Record<string, unknown>;
  lookVersion: number;
  materialVersion: number;
  /** Capabilities the look falls back from (F0), e.g. `dof→unsupported`; [] when none. */
  fallbacks: string[];
}

/** The look-related part of a recording request (plan-553 F7). */
export interface CinematicLookRequest {
  look: CinematicLookName;
  dof: boolean;
  fStop: number;
  vignette: number;
  materialPresets: boolean;
  materialOverrides: CinematicMaterialOverrides | null;
}

/** Static description of a frame source (cheap — no GPU work). */
export interface CinematicRendererInfo {
  /** Short renderer name, e.g. `three-gpu-pathtracer/webgpu`. */
  renderer: string;
  tracerVersion: string;
  denoiserVersion: string;
}

/** Result of {@link CinematicFrameSource.setup}. */
export interface CinematicSetupInfo {
  tracedMeshes: number;
  triangles: number;
  /** Meshes left out on purpose (overlays, sensor visualisation, …), counted per reason. */
  skipped: Record<string, number>;
  /**
   * Meshes that SHOULD be traced but could not be copied (e.g. a CPU buffer
   * that is no longer readable). Never silently dropped: the capture reports
   * them and the CLI writes them into the manifest.
   */
  missing: string[];
  /** GPU adapter description when the browser exposes it. */
  adapter: string;
  setupMs: number;
  /** plan-553: the look that was built. */
  look?: string;
  /** plan-553: traced meshes / buckets per material preset (incl. `lamp`). */
  materialPresets?: Record<string, number>;
  /** plan-553: presets that could not be applied as specified (F0 fallbacks, unknown override presets). */
  degraded?: string[];
  /** plan-554: the resolved motion blur of this run (the capture fills `off` for a source without it). */
  motionBlur?: CinematicBlurResolution;
}

/** Per-frame statistics of a rendered cinematic frame. */
export interface CinematicFrameStats {
  samples: number;
  /** Wall-clock ms of the whole frame (sync + trace + denoise + PNG). */
  ms: number;
  traceMs: number;
  denoiseMs: number;
  /** What changed in the traced scene before this frame. */
  sceneChange: 'none' | 'transforms' | 'materials' | 'topology';
  /** plan-554: sub-frames the samples were spread over (absent = a sharp frame). */
  blurSubFrames?: number;
  /** plan-554: traced meshes interpolated across the shutter (0 = only the camera moved). */
  blurMoving?: number;
}

export interface CinematicFrameResult {
  /** The finished frame as PNG bytes. */
  png: Uint8Array;
  stats: CinematicFrameStats;
}

/** Per-frame context: the watchdog and the abort signal. */
export interface CinematicFrameContext {
  /** A frame whose sample count does not grow for this long is a stall (ms). */
  stallTimeoutMs: number;
  /**
   * The run's abort signal. A video passes it for information only: its contract is "stop AFTER
   * the current frame" (the capture checks the signal between frames). The frame source honours
   * it INSIDE a frame only when {@link abortInFrame} is set.
   */
  signal?: AbortSignal;
  /**
   * plan-557 F7: abort INSIDE this frame when `signal` fires — set by the still image only. The
   * source checks the signal between sample blocks and denoise steps and races every wait (GPU
   * idle, sample read-back, denoise, PNG encode) against the signal and `stallTimeoutMs`; it then
   * rejects with an `AbortError` ({@link createAbortError}) and is spent (the caller disposes it).
   * Absent / false = the video behaviour, unchanged.
   */
  abortInFrame?: boolean;
  /** plan-557 F9: sample progress of this frame (`done` of `total` samples per pixel), optional. */
  onProgress?: (done: number, total: number) => void;
  /**
   * plan-553 F6: focus distance of this frame (m) — `|position − target|` of the camera-path pose
   * (orbit: the orbit centre, fixed: the target, presets: the interpolated target). Used with `dof`.
   */
  focusDistance?: number;
  /**
   * plan-554 F3b: places the capture camera at `frameTime + offsetSec` of the camera path (offset
   * ≤ 0 inside the shutter; frame 0 clamped to 0, a cut inside the shutter holds the post-cut pose)
   * and returns that pose's focus distance. Present only for a blurred video frame; the source
   * calls it with 0 at the end to put the frame's own pose back.
   */
  cameraAt?: (offsetSec: number) => number;
}

/**
 * A path-traced frame source. Lifecycle: `setup` once (copies the scene,
 * builds the acceleration structures), `renderFrame` per video frame (after
 * the capture advanced the simulation and placed the camera), `dispose` once
 * (always — also after an error).
 */
export interface CinematicFrameSource {
  readonly info: CinematicRendererInfo;
  /**
   * plan-553 F7: resolves a look request without GPU work (cheap, deterministic). The capture calls
   * it before the fingerprint; a source without it is treated as the plan-550 `viewer` look.
   */
  resolveLook?(request: CinematicLookRequest): CinematicResolvedLook;
  setup(host: CinematicSceneHost, options: CinematicSetupOptions): Promise<CinematicSetupInfo>;
  renderFrame(frameIndex: number, ctx: CinematicFrameContext): Promise<CinematicFrameResult>;
  /**
   * plan-554: the snapshot hook of a run whose setup resolved the motion blur to a mode other
   * than `off`, else null. Asked once, after `setup()`.
   */
  motionRecorder?(): CinematicMotionRecorder | null;
  /** Releases tracer → denoiser → GPU device, in that order; must not throw. */
  dispose(): Promise<void>;
}

export type CinematicRendererFactory = () => Promise<CinematicFrameSource>;

/**
 * A failure after which the recording can be RESUMED: a stalled frame, a lost
 * GPU device. Every frame written before it is valid; the CLI exits with code 3.
 */
export class CinematicResumableError extends Error {
  readonly resumable = true;
  constructor(message: string) {
    super(message);
    this.name = 'CinematicResumableError';
  }
}

/** True for an error the recording can resume after (also across realms / serialisation). */
export function isResumableCinematicError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { resumable?: unknown }).resumable === true;
}

// ─── Registry ─────────────────────────────────────────────────────────────

let _factory: CinematicRendererFactory | null = null;

/** Registers THE cinematic frame source (last wins). Called by the commercial feature adapter. */
export function registerCinematicRenderer(factory: CinematicRendererFactory | null): void {
  _factory = factory;
}

/** The registered factory, or null in a build without the commercial renderer. */
export function getCinematicRenderer(): CinematicRendererFactory | null {
  return _factory;
}

// ─── Watchdog rule (plan-550 F11) ────────────────────────────────────────

/** Minimum stall timeout of a frame (ms). */
export const CINEMATIC_MIN_STALL_MS = 120_000;
/** Stall timeout of the FIRST frame, which also compiles the kernels (ms). */
export const CINEMATIC_FIRST_FRAME_STALL_MS = 300_000;

/**
 * Stall timeout for the next frame: 10 × the expected seconds per frame, at
 * least {@link CINEMATIC_MIN_STALL_MS}; before any frame was measured,
 * {@link CINEMATIC_FIRST_FRAME_STALL_MS}.
 */
export function cinematicStallTimeoutMs(lastFrameMs: number | null): number {
  if (lastFrameMs == null || !(lastFrameMs > 0)) return CINEMATIC_FIRST_FRAME_STALL_MS;
  return Math.max(CINEMATIC_MIN_STALL_MS, Math.round(10 * lastFrameMs));
}

// ─── Hidden tab (plan-551 F8/F22) ─────────────────────────────────────────

let _shownAt = 0;
let _visibilityListening = false;

function ensureVisibilityClock(): void {
  if (_visibilityListening || typeof document === 'undefined') return;
  _visibilityListening = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _shownAt = performance.now();
  });
}

/**
 * Milliseconds a watchdog armed at `since` has been running while the page was VISIBLE.
 * While the tab is hidden it returns 0, and after the tab comes back the clock restarts at
 * that moment — a hidden tab (whose GPU work and timers the browser throttles) never counts
 * as a stalled frame. Used by both stall watchdogs: the capture loop's backstop and the
 * frame source's sample / denoiser checks.
 */
export function watchdogElapsedMs(since: number, now: number = performance.now()): number {
  ensureVisibilityClock();
  if (typeof document !== 'undefined' && document.hidden) return 0;
  return now - Math.max(since, _shownAt);
}

// ─── Abortable waits (plan-557 F7) ───────────────────────────────────────

/** An Error named `AbortError` (what a cancelled still image rejects with). */
export function createAbortError(message = 'Cancelled.'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** True for an abort (an `AbortError` Error or DOMException). */
export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

export interface RaceAbortableOptions<T> {
  /** Rejects with an `AbortError` the moment it fires (also when already aborted). */
  signal?: AbortSignal;
  /** Rejects after this many ms of VISIBLE time (hidden-tab time does not count); ≤ 0 / absent = no timeout. */
  timeoutMs?: number;
  /** The error of a timeout (default: a plain Error naming the timeout). */
  onTimeout?: () => Error;
  /** Receives the value of `p` when it resolves AFTER the race was lost (dispose / release it here). */
  onLate?: (value: T) => void;
  /** Message of the AbortError (default `Cancelled.`). */
  abortMessage?: string;
}

/**
 * Races `p` against an abort signal and a visible-time timeout (plan-557 F7). Whatever loses is
 * never left dangling: a late rejection of `p` is swallowed (it never surfaces as an
 * `unhandledrejection`), a late resolution is handed to `onLate` so the caller can release what
 * it produced (a throwing `onLate` is logged, never rethrown). When `p` wins, its value or error
 * passes through unchanged. Without signal and timeout, `p` itself.
 */
export function raceAbortable<T>(p: Promise<T>, o: RaceAbortableOptions<T> = {}): Promise<T> {
  const { signal, timeoutMs, onTimeout, onLate, abortMessage } = o;
  const timed = typeof timeoutMs === 'number' && timeoutMs > 0;
  if (!signal && !timed) return p;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort(): void {
      if (settled) return;
      finish();
      reject(createAbortError(abortMessage));
    }
    p.then(
      (v) => {
        if (settled) {
          // A throwing onLate must not become an unhandled rejection of this detached chain.
          try { onLate?.(v); } catch (e) { console.warn('[cinematic] late release after a lost race failed:', e); }
          return;
        }
        finish();
        resolve(v);
      },
      (e: unknown) => {
        if (settled) return; // lost the race — nothing waits for this error any more
        finish();
        reject(e);
      },
    );
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timed) {
      const ms = timeoutMs as number;
      const armedAt = performance.now();
      const arm = (delay: number): void => {
        timer = setTimeout(() => {
          if (settled) return;
          const elapsed = watchdogElapsedMs(armedAt);
          if (elapsed >= ms) {
            finish();
            reject(onTimeout ? onTimeout() : new Error(`Timed out after ${Math.round(ms / 1000)} s.`));
          } else {
            arm(Math.max(Math.min(1000, ms), ms - elapsed));
          }
        }, delay);
      };
      arm(ms);
    }
  });
}

/**
 * Yields one macrotask WITHOUT a timer: a `MessageChannel` round trip is not subject to the
 * timer throttling of background tabs (≤ 1/s, 1/min after five minutes), `setTimeout` is.
 */
export function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}
