// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-video-capture — deterministic, frame-by-frame video export (plan-537).
 *
 * The real-time loop is stopped; for every video frame the simulation advances
 * by exactly `1/fps` through the production fixed tick (`60/fps` steps of
 * 1/60 s), the camera is placed from a camera path, the frame is rendered
 * through the full viewer pipeline (`renderFrameForCapture`) and handed to a
 * WebCodecs `VideoEncoder` with an explicit timestamp. `mediabunny` (lazy
 * import) writes the MP4 in memory. Nothing depends on real-time FPS, rAF or
 * the compositor, so a hidden tab or a minimised RDP desktop records the same
 * video as a focused window (F9).
 *
 * Time model (F2e): fps ∈ {30, 60}, frames = seconds × fps (integer); warmup =
 * whole fixed steps; frame i shows the sim state after
 * `warmupSteps + (i+1)·60/fps` steps and the camera at `t_i = i/fps`.
 *
 * Quality (F11): `standard` = exactly what the viewer draws; `high` = 2×
 * supersampling (capped by the GPU limits), AO/bloom at full render
 * resolution, a 4096² shadow map and an exact box downscale; `max` = high +
 * Halton-jittered sub-renders averaged per frame (spatial AA, no temporal
 * artefacts — the sim does not advance between sub-renders).
 *
 * Determinism (F8): same options + same start state → same frame count, same
 * timestamps and the same sim time per frame. Visual identity is NOT
 * guaranteed for models with unseeded randomness (e.g. Source RandomDistance).
 *
 * The capture owns the viewer through `beginCapture()` / `endCapture()` (try /
 * finally): loop, size, DPR, camera, selection and suspended effects always
 * come back, also after an error, an abort or a deadline (F2b/F2g/F10).
 *
 * Cinematic (plan-550): `quality: 'cinematic'` swaps the frame SOURCE, not the
 * loop. Sim steps, camera path, raster tick, abort and restore stay shared; per
 * frame the registered path tracer (rv-cinematic-hook, commercial builds only)
 * renders a PNG that goes to `options.frameSink` instead of the encoder. A run
 * may start at `startFrame` (resume): the frames before it are fast-forwarded
 * with the same per-frame sequence (step + pose + raster tick), only the trace
 * is skipped. `muxVideoFrames` turns the PNGs into the MP4 afterwards.
 *
 * Motion blur (plan-554): with a resolved blur the rendered frames run their sim steps one by
 * one under a read-only snapshot hook (`CinematicMotionRecorder`, no extra ticks) and hand the
 * frame source a `cameraAt(offset)` that evaluates the camera PATH at each shutter sub-time.
 *
 * Frame hook (plan-556): `frameHook` is called once per video frame, after the frame was rendered
 * and before the simulation steps again, with a SAME-TASK snapshot of exactly the frame that is
 * encoded (raster: `createImageBitmap(frameSource)`; cinematic: the decoded tracer PNG). The HMI
 * recording lays it under the page and screenshots the page (CLI) or grabs the tab (dialog).
 * `frameHookEncode`: `before` = encode the canvas frame, then hook (layer); `skip` = no encoder at
 * all (composite — the CLI muxes its own frames); `replace` = encode the VideoFrame the hook
 * returns instead (the dialog's tab grab). No hook = the plan-537 path unchanged (N2).
 */

import { Box3, Vector3, type Object3D, type OrthographicCamera, type PerspectiveCamera, type Scene } from 'three';
import {
  cameraSubTime,
  createCameraPathPose,
  createFixedPath,
  createOrbitPath,
  createPresetPath,
  fitDistanceForSphere,
  boxRadius,
  azimuthDeg,
  DEFAULT_PRESET_HOLD,
  DEFAULT_PRESET_TRANSITION,
  type CameraPath,
  type PresetKeyframe,
} from './rv-video-camera-path';
import { loadVisualSettings } from '../hmi/visual-settings-store';
import { computeContentBoundsInto } from './rv-scene-scale';
import { isCameraPreset, presetDirection } from '../../plugins/mcp-bridge/rv-camera-presets-math';
import {
  CINEMATIC_DEFAULT_BLUR_SUBFRAMES,
  CINEMATIC_DEFAULT_FSTOP,
  CINEMATIC_DEFAULT_LOOK,
  CINEMATIC_DEFAULT_MOTION_BLUR,
  CINEMATIC_DEFAULT_SHUTTER_DEG,
  CINEMATIC_MAX_BLUR_SUBFRAMES,
  CINEMATIC_MIN_BLUR_SUBFRAMES,
  CINEMATIC_DEFAULT_SAMPLES,
  CINEMATIC_DEFAULT_VIGNETTE,
  CINEMATIC_FIRST_FRAME_STALL_MS,
  CINEMATIC_LOOKS,
  CINEMATIC_MAX_SAMPLES,
  CINEMATIC_SEED_RULE,
  CINEMATIC_UNAVAILABLE_MESSAGE,
  CinematicResumableError,
  DEFAULT_ENVIRONMENT_HDR,
  cinematicStallTimeoutMs,
  createAbortError,
  getCinematicRenderer,
  raceAbortable,
  watchdogElapsedMs,
  yieldMacrotask,
  type CinematicBlurResolution,
  type CinematicDenoise,
  type CinematicFrameSource,
  type CinematicMotionRecorder,
  type CinematicFrameStats,
  type CinematicLookName,
  type CinematicLookRequest,
  type CinematicMaterialOverrides,
  type CinematicResolvedLook,
  type CinematicSceneHost,
  type CinematicSetupInfo,
  type CinematicSetupOptions,
} from './rv-cinematic-hook';

// ─── Public types ─────────────────────────────────────────────────────────

export type VideoQuality = 'standard' | 'high' | 'max' | 'cinematic';
export type VideoCodecChoice = 'avc' | 'hevc' | 'av1' | 'vp9';

/** Camera movement of a recording (F5). */
export type CameraPathSpec =
  | {
    kind: 'orbit';
    /** Node path whose bounds centre is orbited; default = model bounds centre. */
    target?: string;
    /** Explicit orbit centre (world, m) — wins over `target` and `fromCurrentView` (a resolved path, plan-551 F20). */
    center?: [number, number, number];
    /**
     * Orbit from the current view (plan-551 F3): centre = the OrbitControls target, radius =
     * horizontal camera↔target distance, height = camera.y − target.y, start = current azimuth.
     * A top-down view (horizontal radius < 1 % of the fit radius) falls back to the fit radius.
     */
    fromCurrentView?: boolean;
    /** Horizontal radius (m); default = fit distance × radiusScale. */
    radius?: number;
    /** Multiplier on the fitted radius (default 1). */
    radiusScale?: number;
    /** Camera height above the centre (m); default 0.45 × radius. */
    height?: number;
    /** Start azimuth (deg, 0 = +Z); default = the current camera's azimuth. */
    startDeg?: number;
    /** Swept angle over the video (deg, default 360). */
    sweepDeg?: number;
    easing?: 'none' | 'inOut';
    fov?: number;
  }
  | {
    kind: 'presets';
    /** Ordered views: iso|top|front|back|left|right|home, cam1|cam2|cam3 (bottom-bar bookmarks), current. */
    views: Array<{ view: string; transition?: number; hold?: number }>;
    fov?: number;
  }
  | {
    kind: 'fixed';
    /** Explicit pose (world, m) instead of the current view — a resolved path (plan-551 F20). */
    position?: [number, number, number];
    target?: [number, number, number];
    fov?: number;
  };

export interface VideoRecordOptions {
  /** Output width in physical pixels (even). Default 1920. */
  width?: number;
  /** Output height in physical pixels (even). Default 1080. */
  height?: number;
  /** 30 or 60. Default 60. */
  fps?: number;
  /** Encoded duration in sim seconds; seconds × fps must be an integer. */
  seconds: number;
  /** Sim seconds run (and not encoded) before frame 0, rounded to whole 1/60 steps. Default 3. */
  warmupSeconds?: number;
  /** Bits per second; default by resolution and fps (1080p60 = 40 Mbit/s). */
  bitrate?: number;
  /** Default 'avc' (H.264). */
  codec?: VideoCodecChoice;
  /** Default 'high'. */
  quality?: VideoQuality;
  /** Requested supersample factor for high/max (default 2, capped by the GPU). */
  supersample?: number;
  /** Jittered sub-renders per frame for `max` (default 4). */
  jitter?: number;
  /** Camera path (default orbit). */
  path?: CameraPathSpec;
  /**
   * Reset the simulation to its load state right before the capture takes over — in the same
   * task, after the camera path was resolved from the current view (plan-551 F19: a cinematic
   * recording from the viewer starts like the CLI, from the load state, so a resume can
   * fast-forward deterministically).
   */
  resetSimulation?: boolean;
  /** Stops between frames; the viewer is restored, no bytes are returned (F10). */
  signal?: AbortSignal;
  /** Wall-clock deadline in ms (checked per frame and in every encoder wait, F2g). */
  deadlineMs?: number;
  /** Memory budget for the in-memory MP4 in bytes (default 512 MiB, F2f). */
  maxBytes?: number;
  /** Called after each encoded frame; a returned promise is awaited. */
  onProgress?: (frame: number, total: number) => void | Promise<void>;
  /**
   * plan-556: called once per video frame with a same-task snapshot of the encoded 3D frame,
   * awaited (bounded by `frameHookTimeoutMs`, abortable) before the next sim step.
   */
  frameHook?: FrameHook;
  /** What the raster encoder does around the hook (default `before`). Ignored for cinematic. */
  frameHookEncode?: FrameHookEncode;
  /** Bound of one hook call in ms of visible time (default {@link FRAME_HOOK_TIMEOUT_MS}). */
  frameHookTimeoutMs?: number;
  // ── cinematic (plan-550) ──
  /** cinematic: samples per pixel per frame (default 64). */
  samples?: number;
  /** cinematic: OIDN denoiser mode (default 'aux'). */
  denoise?: CinematicDenoise;
  /** cinematic: URL of an equirect HDR replacing the look's environment (wins over the look HDR). */
  hdr?: string;
  /** cinematic: look (plan-553 F1, default `studio`; `viewer` = the plan-550 setup). */
  look?: CinematicLookName;
  /** cinematic: depth of field (plan-553 F6, default off). */
  dof?: boolean;
  /** cinematic: aperture f-number of the depth of field (default 5.6). */
  fStop?: number;
  /** cinematic: vignette strength 0..0.5 (default 0.15; 0 disables). */
  vignette?: number;
  /** cinematic: physical material presets + glowing lamps (default true). */
  materialPresets?: boolean;
  /** cinematic: project material overrides (the parsed `cinematic-materials.json`). */
  materialOverrides?: CinematicMaterialOverrides | null;
  /**
   * cinematic: motion blur (plan-554 F1) — on by default with a 180° trailing shutter and 8
   * sub-frames; `shutterDeg: 0` or `enabled: false` = sharp frames (the plan-553 render path).
   */
  motionBlur?: { enabled?: boolean; shutterDeg?: number; subFrames?: number };
  /** cinematic: first frame to render (resume); the frames before it are fast-forwarded. */
  startFrame?: number;
  /** cinematic (required): receives every finished frame as PNG; a returned promise is awaited. */
  frameSink?: (index: number, png: Uint8Array, stats: CinematicFrameStats) => void | Promise<void>;
  /** cinematic: the recording's fingerprint, before the warmup — throw to refuse (resume guard). */
  onCinematicContext?: (context: CinematicContext) => void | Promise<void>;
  /** cinematic: called once after the traced scene was built. */
  onCinematicSetup?: (info: CinematicSetupInfo) => void | Promise<void>;
}

/** Raster encoder behaviour around a {@link FrameHook} (plan-556). */
export type FrameHookEncode = 'before' | 'skip' | 'replace';

/** What a frame hook receives (plan-556). */
export interface FrameHookInfo {
  /**
   * The encoded 3D frame (raster: snapshot of the frame source taken in the render task;
   * cinematic: the decoded tracer PNG). The hook may transfer it (`bitmaprenderer`); it is closed
   * after the hook returns.
   */
  snapshot: ImageBitmap;
  /** cinematic: the tracer PNG of this frame. */
  png?: Uint8Array;
  /** `viewer.simTime` of the frame, in ms (the recording clock of the HMI settle). */
  simTimeMs: number;
  /** Encoder timestamp and duration of the frame (µs) — a `replace` frame must carry them. */
  timestampUs: number;
  durationUs: number;
  /** The recording's abort signal. */
  signal?: AbortSignal;
}

/**
 * Per-frame hook (plan-556). Returns nothing, or — with `frameHookEncode: 'replace'` — the
 * VideoFrame to encode instead of the canvas frame (the hook creates it, the encoder closes it).
 */
export type FrameHook = (index: number, info: FrameHookInfo) => void | VideoFrame | null | Promise<void | VideoFrame | null>;

/** Default bound of one frame-hook call (ms of visible time). */
export const FRAME_HOOK_TIMEOUT_MS = 60_000;

/**
 * Fingerprint of a cinematic recording (plan-550 F10): everything that makes a
 * resumed run differ from the frames already on disk. The CLI stores it in the
 * manifest and refuses a resume naming the first differing field.
 */
export interface CinematicContext {
  model: string | null;
  /** Structure hash of the loaded model (mesh names, vertex / index counts, sampled positions). */
  modelHash: string;
  /** HDR the scene is lit with (`override` or the look's deploy-relative path) and the SHA-256 of its bytes. */
  hdr: string;
  hdrHash: string;
  /**
   * plan-553 F7: the RESOLVED look — name, resolved parameters, look / material-preset algorithm
   * versions, F0 fallbacks, output options and the hash of the override content.
   */
  look: {
    name: string;
    params: Record<string, unknown>;
    lookVersion: number;
    materialVersion: number;
    fallbacks: string[];
    dof: boolean;
    fStop: number | null;
    vignette: number;
    materialPresets: boolean;
    overridesHash: string | null;
  };
  environment: { intensity: number; rotation: [number, number, number]; background: string | null; toneMapping: number | null; exposure: number | null };
  lights: Array<{ color: string; intensity: number; direction: [number, number, number] }>;
  /**
   * The RESOLVED camera at the first, middle and last frame (rounded): position (3), target (3),
   * vertical fov, projection (0 = perspective, 1 = orthographic) and zoom (plan-551 F20).
   */
  cameraPoses: number[][];
  renderer: string;
  tracerVersion: string;
  denoiserVersion: string;
  seedRule: string;
  /** Components whose randomness is not seeded (a resumed run may differ visually). */
  unseededRandomness: string[];
}

export interface VideoRecordResult {
  bytes: Uint8Array;
  frames: number;
  seconds: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
  bitrate: number;
  hardwareAcceleration: string;
  quality: VideoQuality;
  supersample: number;
  jitter: number;
  warmupSteps: number;
  /** Wall-clock seconds the capture took. */
  renderSeconds: number;
  /** viewer.simTime right after the warmup. */
  simStart: number;
  /** viewer.simTime after the last frame. */
  simEnd: number;
  /** cinematic only: what was rendered (the frames went to `frameSink`; `bytes` is empty). */
  cinematic?: {
    startFrame: number;
    framesRendered: number;
    setup: CinematicSetupInfo;
    context: CinematicContext;
    avgFrameMs: number;
  };
}

/** Normalised, validated options. */
export interface NormalizedVideoOptions {
  width: number;
  height: number;
  fps: 30 | 60;
  seconds: number;
  frames: number;
  stepsPerFrame: number;
  warmupSteps: number;
  bitrate: number;
  codec: VideoCodecChoice;
  quality: VideoQuality;
  supersample: number;
  jitter: number;
  path: CameraPathSpec;
  deadlineMs: number;
  maxBytes: number;
  /** cinematic: samples per pixel (0 otherwise). */
  samples: number;
  denoise: CinematicDenoise;
  hdr: string | null;
  startFrame: number;
  /** cinematic: the look request (plan-553); null otherwise. */
  look: CinematicLookRequest | null;
  /** cinematic: the requested motion blur (plan-554); null otherwise. */
  motionBlur: MotionBlurRequest | null;
}

/** A normalised motion-blur request (plan-554 F1). Off = `{ enabled: false, shutterDeg: 0, subFrames: 1 }`. */
export interface MotionBlurRequest {
  enabled: boolean;
  /** Open shutter in degrees of one frame interval (trailing: [T − shutter/360/fps, T]). */
  shutterDeg: number;
  /** Requested sub-frames K (the source caps it to K_eff = min(K, ⌊samples / 4⌋)). */
  subFrames: number;
}

/**
 * What the capture needs from the viewer — the capture hooks RVViewer exposes
 * (beginCapture / captureStep / setCaptureCameraPose / captureRenderFrame /
 * endCapture) plus a few read-only accessors. Structural on purpose: the engine
 * layer must not depend on the viewer module (eslint boundaries).
 */
export interface VideoCaptureHost {
  readonly isCapturing: boolean;
  readonly captureAbortReason: string | null;
  readonly simTime: number;
  readonly camera: PerspectiveCamera | OrthographicCamera;
  readonly renderer: { domElement: HTMLCanvasElement | OffscreenCanvas; toneMapping?: number; toneMappingExposure?: number };
  readonly registry: {
    getNode(path: string): Object3D | null;
    forEachNode?(callback: (path: string, node: Object3D) => void): void;
    getComponentsAt?(path: string): Array<[string, unknown]>;
  } | null;
  readonly currentModelRoot: Object3D | null;
  /** The viewer scene — needed by the cinematic source only. */
  readonly scene?: Scene;
  /** Resolves when no async BVH build holds geometry buffers (cinematic source only). */
  whenBvhIdle?(timeoutMs?: number): Promise<void>;
  readonly currentModelUrl?: string | null;
  getCameraState(): { position: Vector3; target: Vector3 };
  capturePreflight(): string | null;
  /** Simulation reset to the load state (used with `resetSimulation: true`, plan-551 F19). */
  resetSimulation?(): void;
  getCaptureGpuLimits(): { maxTextureSize: number; maxRenderbufferSize: number; maxViewportWidth: number; maxViewportHeight: number };
  beginCapture(opts: {
    width: number; height: number; supersample?: number; frameDt: number;
    fullResPost?: boolean; shadowMapSize?: number | null;
    /** plan-557 F2c: WebLabel reference height (px); absent = the output height (video). */
    labelReferenceHeight?: number | null;
  }): void;
  captureStep(steps: number, fixedDt?: number): void;
  setCaptureCameraPose(position: Vector3, target: Vector3, fov?: number | null): void;
  captureRenderFrame(timeSec: number, frameDt: number, jitterX?: number, jitterY?: number): boolean;
  endCapture(): void;
}

// ─── Constants ────────────────────────────────────────────────────────────

export const FIXED_STEP_HZ = 60;
export const DEFAULT_VIDEO_BUDGET_BYTES = 512 * 1024 * 1024;
/** Render-size cap for supersampling (pixels, 8K UHD). */
export const MAX_RENDER_PIXELS = 7680 * 4320;
export const MAX_RENDER_DIM = 7680;
/** Shadow map edge during high / max captures. */
export const CAPTURE_SHADOW_MAP_SIZE = 4096;
/** Encoder queue length that triggers backpressure (F3). */
const MAX_ENCODE_QUEUE = 6;

// ─── Validation & estimates ──────────────────────────────────────────────

/** Default bitrate: 1080p60 = 40 Mbit/s, scaled by pixel rate^0.6 (4K30 ≈ 60 Mbit/s). */
export function defaultBitrate(width: number, height: number, fps: number): number {
  const ratio = (width * height * fps) / (1920 * 1080 * 60);
  return Math.max(2_000_000, Math.round(40_000_000 * Math.pow(ratio, 0.6)));
}

/** Estimated MP4 size in bytes (bitrate × seconds / 8). */
export function estimateVideoBytes(bitrate: number, seconds: number): number {
  return Math.ceil((bitrate * seconds) / 8);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Validate and normalise options; throws a clear Error on anything unsupported (F2e/F2f). */
export function normalizeVideoOptions(o: VideoRecordOptions): NormalizedVideoOptions {
  const width = Math.round(num(o.width, 1920));
  const height = Math.round(num(o.height, 1080));
  if (width < 16 || height < 16 || width > 8192 || height > 8192) {
    throw new Error(`Size ${width}x${height} is out of range (16..8192 px).`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`Size ${width}x${height}: width and height must be even (4:2:0 video).`);
  }
  const fpsRaw = num(o.fps, 60);
  if (fpsRaw !== 30 && fpsRaw !== 60) throw new Error(`fps ${fpsRaw} is not supported — use 30 or 60.`);
  const fps = fpsRaw as 30 | 60;
  const seconds = num(o.seconds, NaN);
  if (!(seconds > 0)) throw new Error('seconds must be a positive number.');
  const framesExact = seconds * fps;
  const frames = Math.round(framesExact);
  if (Math.abs(framesExact - frames) > 1e-6 || frames < 1) {
    throw new Error(`seconds × fps = ${framesExact} is not a whole number of frames.`);
  }
  const warmupSeconds = num(o.warmupSeconds, 3);
  if (warmupSeconds < 0) throw new Error('warmupSeconds must not be negative.');
  const warmupSteps = Math.round(warmupSeconds * FIXED_STEP_HZ);
  const bitrate = Math.round(num(o.bitrate, defaultBitrate(width, height, fps)));
  if (!(bitrate >= 100_000)) throw new Error('bitrate must be at least 100000 bit/s.');
  const codec = (o.codec ?? 'avc') as VideoCodecChoice;
  if (!['avc', 'hevc', 'av1', 'vp9'].includes(codec)) throw new Error(`Unknown codec "${codec}" — use avc, hevc, av1 or vp9.`);
  const quality = (o.quality ?? 'high') as VideoQuality;
  if (!['standard', 'high', 'max', 'cinematic'].includes(quality)) throw new Error(`Unknown quality "${quality}" — use standard, high, max or cinematic.`);
  const cinematic = quality === 'cinematic';
  // Cinematic renders path-traced PNG frames: no supersampling, no jitter, no encoder,
  // no in-memory MP4 (the MP4 is muxed from the files afterwards).
  const supersample = quality === 'standard' || cinematic ? 1 : Math.max(1, Math.min(4, Math.floor(num(o.supersample, 2))));
  const jitter = quality === 'max' ? Math.max(1, Math.min(16, Math.floor(num(o.jitter, 4)))) : 0;
  let samples = 0;
  let denoise: CinematicDenoise = 'off';
  let startFrame = 0;
  let look: CinematicLookRequest | null = null;
  let motionBlur: MotionBlurRequest | null = null;
  if (cinematic) {
    samples = num(o.samples, CINEMATIC_DEFAULT_SAMPLES);
    if (!Number.isInteger(samples) || samples < 1 || samples > CINEMATIC_MAX_SAMPLES) {
      throw new Error(`samples must be an integer between 1 and ${CINEMATIC_MAX_SAMPLES}.`);
    }
    denoise = (o.denoise ?? 'aux') as CinematicDenoise;
    if (!['aux', 'noaux', 'off'].includes(denoise)) throw new Error(`Unknown denoise "${denoise}" — use aux, noaux or off.`);
    startFrame = num(o.startFrame, 0);
    if (!Number.isInteger(startFrame) || startFrame < 0 || startFrame >= frames) {
      throw new Error(`startFrame ${startFrame} is outside 0..${frames - 1}.`);
    }
    look = normalizeLookRequest(o);
    motionBlur = normalizeMotionBlur(o.motionBlur);
  } else if (
    o.startFrame !== undefined || o.samples !== undefined || o.denoise !== undefined || o.hdr !== undefined
    || o.look !== undefined || o.dof !== undefined || o.fStop !== undefined || o.vignette !== undefined
    || o.materialPresets !== undefined || o.materialOverrides !== undefined || o.motionBlur !== undefined
  ) {
    throw new Error('samples, denoise, hdr, look, dof, fStop, vignette, materialPresets, materialOverrides, motionBlur and startFrame need quality "cinematic".');
  }
  const maxBytes = num(o.maxBytes, DEFAULT_VIDEO_BUDGET_BYTES);
  const estimate = estimateVideoBytes(bitrate, seconds);
  if (!cinematic && estimate > maxBytes) {
    throw new Error(
      `Estimated video size ${(estimate / 1048576).toFixed(0)} MB exceeds the in-memory limit of ${(maxBytes / 1048576).toFixed(0)} MB — shorten the video or lower the bitrate.`,
    );
  }
  const path: CameraPathSpec = o.path ?? { kind: 'orbit' };
  if (path.kind !== 'orbit' && path.kind !== 'presets' && path.kind !== 'fixed') {
    throw new Error(`Unknown camera path "${(path as { kind?: string }).kind}" — use orbit, presets or fixed.`);
  }
  if (path.kind === 'presets' && (!Array.isArray(path.views) || path.views.length === 0)) {
    throw new Error('A presets path needs at least one view.');
  }
  return {
    width, height, fps, seconds, frames,
    stepsPerFrame: FIXED_STEP_HZ / fps,
    warmupSteps, bitrate, codec, quality, supersample, jitter, path,
    deadlineMs: num(o.deadlineMs, 0),
    maxBytes,
    samples,
    denoise,
    hdr: cinematic && typeof o.hdr === 'string' && o.hdr ? o.hdr : null,
    startFrame,
    look,
    motionBlur,
  };
}

/**
 * Validates the plan-554 motion-blur options (defaults: on, 180°, 8 sub-frames). Shutter 0 or
 * `enabled: false` = off — the canonical off form `{ enabled: false, shutterDeg: 0, subFrames: 1 }`,
 * so every way of switching it off hashes the same.
 */
export function normalizeMotionBlur(o: VideoRecordOptions['motionBlur']): MotionBlurRequest {
  const v = o ?? {};
  if (typeof v !== 'object') throw new Error('motionBlur must be an object { enabled, shutterDeg, subFrames }.');
  const shutterDeg = num(v.shutterDeg, CINEMATIC_DEFAULT_SHUTTER_DEG);
  if (!(shutterDeg >= 0 && shutterDeg <= 360)) throw new Error('motionBlur.shutterDeg must be between 0 and 360.');
  const subFrames = num(v.subFrames, CINEMATIC_DEFAULT_BLUR_SUBFRAMES);
  if (!Number.isInteger(subFrames) || subFrames < CINEMATIC_MIN_BLUR_SUBFRAMES || subFrames > CINEMATIC_MAX_BLUR_SUBFRAMES) {
    throw new Error(`motionBlur.subFrames must be an integer between ${CINEMATIC_MIN_BLUR_SUBFRAMES} and ${CINEMATIC_MAX_BLUR_SUBFRAMES}.`);
  }
  const enabled = (v.enabled ?? CINEMATIC_DEFAULT_MOTION_BLUR) !== false && shutterDeg > 0;
  if (!enabled) return { enabled: false, shutterDeg: 0, subFrames: 1 };
  return { enabled: true, shutterDeg: Math.round(shutterDeg * 100) / 100, subFrames };
}

/** Validates the plan-553 look options of a cinematic recording (defaults: studio, vignette 0.15, DoF off, presets on). */
export function normalizeLookRequest(o: Pick<VideoRecordOptions, 'look' | 'dof' | 'fStop' | 'vignette' | 'materialPresets' | 'materialOverrides'>): CinematicLookRequest {
  const look = (o.look ?? CINEMATIC_DEFAULT_LOOK) as CinematicLookName;
  if (!(CINEMATIC_LOOKS as readonly string[]).includes(look)) throw new Error(`Unknown look "${look}" — use ${CINEMATIC_LOOKS.join(', ')}.`);
  const fStop = num(o.fStop, CINEMATIC_DEFAULT_FSTOP);
  if (!(fStop >= 0.5 && fStop <= 64)) throw new Error('fStop must be between 0.5 and 64.');
  const vignette = num(o.vignette, CINEMATIC_DEFAULT_VIGNETTE);
  if (!(vignette >= 0 && vignette <= 0.5)) throw new Error('vignette must be between 0 and 0.5.');
  const overrides = o.materialOverrides ?? null;
  if (overrides !== null) {
    if (typeof overrides !== 'object' || !Array.isArray(overrides.rules)) throw new Error('materialOverrides needs a "rules" array.');
    for (const r of overrides.rules) {
      if (!r || typeof r.match !== 'string' || typeof r.preset !== 'string') throw new Error('Every materialOverrides rule needs "match" and "preset" strings.');
      try { new RegExp(r.match, 'i'); } catch { throw new Error(`materialOverrides: "${r.match}" is not a valid regular expression.`); }
    }
  }
  return {
    look,
    dof: o.dof === true,
    fStop: Math.round(fStop * 100) / 100,
    vignette: Math.round(vignette * 1000) / 1000,
    materialPresets: o.materialPresets !== false,
    materialOverrides: overrides,
  };
}

/**
 * Largest integer supersample factor ≤ `requested` whose render size fits the
 * GPU limits and the 8K render cap (F11).
 */
export function computeSupersample(
  width: number, height: number, requested: number,
  limits: { maxTextureSize: number; maxRenderbufferSize: number; maxViewportWidth: number; maxViewportHeight: number },
): number {
  const maxW = Math.min(limits.maxTextureSize, limits.maxRenderbufferSize, limits.maxViewportWidth, MAX_RENDER_DIM);
  const maxH = Math.min(limits.maxTextureSize, limits.maxRenderbufferSize, limits.maxViewportHeight, MAX_RENDER_DIM);
  let ss = Math.max(1, Math.floor(requested));
  while (ss > 1 && (width * ss > maxW || height * ss > maxH || width * ss * height * ss > MAX_RENDER_PIXELS)) ss--;
  return ss;
}

/** What a raster quality asks of the capture frame (F11) — shared by the video and the still. */
export interface RasterQualityConfig {
  /** Supersample factor after the GPU / 8K cap (1 = none). */
  supersample: number;
  /** Jittered sub-renders per frame (0 = none). */
  jitter: number;
  /** AO / bloom at full render resolution. */
  fullResPost: boolean;
  /** Shadow-map edge during the capture, or null (unchanged). */
  shadowMapSize: number | null;
}

/**
 * The capture configuration of a quality (plan-557 F5): `standard` = what the viewer draws,
 * `high` = supersampled (default 2, capped by the GPU limits) with full-resolution post and a
 * {@link CAPTURE_SHADOW_MAP_SIZE} shadow map, `max` = high + jittered sub-renders (default 4),
 * `cinematic` = none of it (the frames come from the path tracer). `limits` is only read when a
 * supersample factor > 1 is requested.
 */
export function rasterQualityConfig(
  quality: VideoQuality, width: number, height: number,
  limits: () => { maxTextureSize: number; maxRenderbufferSize: number; maxViewportWidth: number; maxViewportHeight: number },
  requested: { supersample?: number; jitter?: number } = {},
): RasterQualityConfig {
  if (quality === 'cinematic') return { supersample: 1, jitter: 0, fullResPost: false, shadowMapSize: null };
  const wantSs = quality === 'standard' ? 1 : Math.max(1, Math.min(4, Math.floor(num(requested.supersample, 2))));
  const jitter = quality === 'max' ? Math.max(1, Math.min(16, Math.floor(num(requested.jitter, 4)))) : 0;
  const supersample = wantSs > 1 ? computeSupersample(width, height, wantSs, limits()) : 1;
  const hq = quality !== 'standard';
  return { supersample, jitter, fullResPost: hq, shadowMapSize: hq ? CAPTURE_SHADOW_MAP_SIZE : null };
}

/** Halton sequence value (base b, index i ≥ 1). */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** `n` fixed Halton(2,3) sub-pixel offsets in [-0.5, 0.5) of the render grid. */
export function jitterOffsets(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 1; i <= n; i++) out.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);
  return out;
}

// ─── Encoder ladder (F3) ──────────────────────────────────────────────────

interface AvcLevel { idc: number; maxFs: number; maxMbps: number }
/** H.264 levels (Table A-1): max frame size and max macroblock rate. */
const AVC_LEVELS: AvcLevel[] = [
  { idc: 31, maxFs: 3600, maxMbps: 108000 },
  { idc: 32, maxFs: 5120, maxMbps: 216000 },
  { idc: 40, maxFs: 8192, maxMbps: 245760 },
  { idc: 42, maxFs: 8704, maxMbps: 522240 },
  { idc: 50, maxFs: 22080, maxMbps: 589824 },
  { idc: 51, maxFs: 36864, maxMbps: 983040 },
  { idc: 52, maxFs: 36864, maxMbps: 2073600 },
  { idc: 60, maxFs: 139264, maxMbps: 4177920 },
  { idc: 61, maxFs: 139264, maxMbps: 8355840 },
  { idc: 62, maxFs: 139264, maxMbps: 16711680 },
];

/** Smallest H.264 levels that fit the size and frame rate, ascending. */
export function avcLevelsFor(width: number, height: number, fps: number): number[] {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const maxDim = Math.max(Math.ceil(width / 16), Math.ceil(height / 16));
  return AVC_LEVELS
    .filter((l) => mbs <= l.maxFs && mbs * fps <= l.maxMbps && maxDim * maxDim <= l.maxFs * 8)
    .map((l) => l.idc);
}

function hex2(n: number): string { return n.toString(16).toUpperCase().padStart(2, '0'); }

/** Codec strings to try, best first. */
export function codecLadder(codec: VideoCodecChoice, width: number, height: number, fps: number): string[] {
  if (codec === 'avc') {
    const levels = avcLevelsFor(width, height, fps);
    const out: string[] = [];
    for (const l of levels) out.push(`avc1.6400${hex2(l)}`); // High
    for (const l of levels) out.push(`avc1.4D40${hex2(l)}`); // Main
    for (const l of levels) out.push(`avc1.42E0${hex2(l)}`); // Constrained Baseline
    return out;
  }
  if (codec === 'hevc') return ['hvc1.1.6.L123.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L156.B0'];
  if (codec === 'av1') return ['av01.0.08M.08', 'av01.0.09M.08', 'av01.0.12M.08', 'av01.0.13M.08'];
  return ['vp09.00.40.08', 'vp09.00.41.08', 'vp09.00.50.08', 'vp09.00.51.08'];
}

/** Minimal surface of the WebCodecs VideoEncoder class the ladder needs (mockable). */
export interface VideoEncoderStatic {
  isConfigSupported(config: VideoEncoderConfig): Promise<VideoEncoderSupport>;
}

/**
 * Walk the codec ladder × hardware preference until `isConfigSupported` says
 * yes (F3). Throws a clear error when nothing is supported.
 */
export async function selectEncoderConfig(
  opts: { codec: VideoCodecChoice; width: number; height: number; fps: number; bitrate: number },
  Encoder: VideoEncoderStatic | undefined = (globalThis as { VideoEncoder?: VideoEncoderStatic }).VideoEncoder,
): Promise<VideoEncoderConfig> {
  if (!Encoder || typeof Encoder.isConfigSupported !== 'function') {
    throw new Error('This browser has no WebCodecs VideoEncoder — record in Chrome or Edge.');
  }
  const tried: string[] = [];
  for (const codec of codecLadder(opts.codec, opts.width, opts.height, opts.fps)) {
    for (const hw of ['prefer-hardware', 'prefer-software'] as const) {
      const config: VideoEncoderConfig = {
        codec,
        width: opts.width,
        height: opts.height,
        bitrate: opts.bitrate,
        framerate: opts.fps,
        bitrateMode: 'variable',
        latencyMode: 'quality',
        hardwareAcceleration: hw,
        ...(opts.codec === 'avc' ? { avc: { format: 'avc' as const } } : {}),
      };
      tried.push(`${codec}/${hw}`);
      try {
        const support = await Encoder.isConfigSupported(config);
        if (support.supported) return { ...config, ...(support.config ?? {}) } as VideoEncoderConfig;
      } catch {
        /* an invalid string for this browser — try the next rung */
      }
    }
  }
  throw new Error(`No supported ${opts.codec} encoder configuration for ${opts.width}x${opts.height}@${opts.fps} (tried ${tried.length}: ${tried.slice(0, 4).join(', ')}…).`);
}

// ─── Camera path resolution ──────────────────────────────────────────────

/**
 * Bounds of what is DRAWN (visible meshes only — hidden source templates, the
 * ground plane and overlays do not inflate the orbit), of a node or the model.
 */
function modelBounds(viewer: VideoCaptureHost, target?: string): Box3 {
  const box = new Box3().makeEmpty();
  if (target) {
    const node = viewer.registry?.getNode(target) ?? null;
    if (!node) throw new Error(`Orbit target "${target}" not found.`);
    computeContentBoundsInto(node, box);
    if (box.isEmpty()) throw new Error(`Orbit target "${target}" has no visible geometry.`);
    return box;
  }
  const root = viewer.currentModelRoot;
  if (root) computeContentBoundsInto(root, box);
  if (box.isEmpty()) box.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  return box;
}

function cameraFov(viewer: VideoCaptureHost): number {
  const cam = viewer.camera as PerspectiveCamera;
  return cam.isPerspectiveCamera ? cam.fov : 45;
}

/**
 * Resolve a path spec against the viewer (model bounds, current pose, saved
 * bookmarks) into a pure {@link CameraPath}. `aspect` = output width / height,
 * `duration` = encoded seconds.
 */
export function resolveCameraPath(viewer: VideoCaptureHost, spec: CameraPathSpec, aspect: number, duration: number): CameraPath {
  const state = viewer.getCameraState();
  const curPos = state.position.clone();
  const curTarget = state.target.clone();
  const fovOpt = typeof spec.fov === 'number' && spec.fov > 0 ? spec.fov : null;
  if (spec.kind === 'fixed') {
    const pos = isVec3(spec.position) ? new Vector3(...spec.position) : curPos;
    const tgt = isVec3(spec.target) ? new Vector3(...spec.target) : curTarget;
    return createFixedPath(pos, tgt, fovOpt);
  }
  const fov = fovOpt ?? cameraFov(viewer);

  if (spec.kind === 'orbit') {
    const explicitCenter = isVec3(spec.center);
    const fromView = !explicitCenter && spec.fromCurrentView === true;
    const explicitRadius = typeof spec.radius === 'number' && spec.radius > 0;
    // The fit distance needs the model bounds; an explicit centre with an explicit radius does not.
    const box = !explicitCenter || !explicitRadius ? modelBounds(viewer, fromView ? undefined : spec.target) : null;
    const center = explicitCenter
      ? new Vector3(...(spec.center as [number, number, number]))
      : fromView ? curTarget.clone() : (box as Box3).getCenter(new Vector3());
    const scale = typeof spec.radiusScale === 'number' && spec.radiusScale > 0 ? spec.radiusScale : 1;
    const fitRadius = (): number => fitDistanceForSphere(boxRadius(box as Box3), fov, aspect, 1.05) * scale;
    let radius: number;
    let viewHeight: number | null = null;
    if (explicitRadius) {
      radius = spec.radius as number;
    } else if (fromView) {
      const horizontal = Math.hypot(curPos.x - center.x, curPos.z - center.z);
      const fit = fitRadius();
      // Straight down (or nearly): the azimuth is undefined and the orbit would spin in place.
      radius = horizontal < 0.01 * fit ? fit : horizontal;
      viewHeight = curPos.y - center.y;
    } else {
      radius = fitRadius();
    }
    const height = typeof spec.height === 'number' ? spec.height : viewHeight ?? radius * 0.45;
    const startDeg = typeof spec.startDeg === 'number' ? spec.startDeg : azimuthDeg(curPos, center);
    return createOrbitPath({
      center, radius, height, startDeg,
      sweepDeg: typeof spec.sweepDeg === 'number' ? spec.sweepDeg : 360,
      duration, easing: spec.easing === 'inOut' ? 'inOut' : 'none', fov: fovOpt,
    });
  }

  // presets
  const box = modelBounds(viewer);
  const center = box.getCenter(new Vector3());
  const dist = fitDistanceForSphere(boxRadius(box), fov, aspect, 1.05);
  const bookmarks = loadVisualSettings().cameras ?? [];
  const keyframes: PresetKeyframe[] = spec.views.map((v, i) => {
    const name = String(v.view ?? '').trim().toLowerCase();
    const transition = i === 0 ? 0 : (typeof v.transition === 'number' ? v.transition : DEFAULT_PRESET_TRANSITION);
    const hold = typeof v.hold === 'number' ? v.hold : DEFAULT_PRESET_HOLD;
    if (name === 'current') return { position: curPos.clone(), target: curTarget.clone(), transition, hold };
    const cam = /^cam([1-9])$/.exec(name);
    if (cam) {
      const bm = bookmarks[Number(cam[1]) - 1];
      if (!bm) throw new Error(`Camera bookmark ${name} is empty — save it in the bottom bar first.`);
      return { position: new Vector3(bm.px, bm.py, bm.pz), target: new Vector3(bm.tx, bm.ty, bm.tz), transition, hold };
    }
    if (isCameraPreset(name)) {
      const dir = presetDirection(name);
      // Straight down is degenerate with up = +Y; a tiny +Z lean keeps north up
      // (the same framing `web_camera_view top` gets from its −Z up vector).
      if (name === 'top') dir.set(0, 1, 1e-3).normalize();
      return { position: center.clone().addScaledVector(dir, dist), target: center.clone(), transition, hold };
    }
    throw new Error(`Unknown view "${v.view}" — use iso|top|front|back|left|right|home, cam1..cam3 or current.`);
  });
  return createPresetPath({ keyframes, fov: fovOpt });
}

function isVec3(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Resolve an orbit or fixed spec against the CURRENT view into an explicit, absolute spec
 * (centre / radius / height / start angle, or position / target) — the form a resumable
 * recording stores, so a resume replays the stored camera instead of re-reading the view
 * (plan-551 F19/F20). Presets are returned unchanged.
 */
export function resolveExplicitCameraSpec(viewer: VideoCaptureHost, spec: CameraPathSpec, aspect: number): CameraPathSpec {
  if (spec.kind === 'presets') return spec;
  const fov = typeof spec.fov === 'number' && spec.fov > 0 ? spec.fov : cameraFov(viewer);
  const path = resolveCameraPath(viewer, spec, aspect, 1);
  const pose = path.pose(0, createCameraPathPose());
  const r = (n: number): number => Math.round(n * 1e6) / 1e6;
  const vec = (v: Vector3): [number, number, number] => [r(v.x), r(v.y), r(v.z)];
  if (spec.kind === 'fixed') {
    return { kind: 'fixed', position: vec(pose.position), target: vec(pose.target), fov: r(fov) };
  }
  const c = pose.target;
  const out: CameraPathSpec = {
    kind: 'orbit',
    center: vec(c),
    radius: r(Math.hypot(pose.position.x - c.x, pose.position.z - c.z)),
    height: r(pose.position.y - c.y),
    startDeg: r(azimuthDeg(pose.position, c)),
    sweepDeg: typeof spec.sweepDeg === 'number' ? spec.sweepDeg : 360,
    fov: r(fov),
  };
  if (spec.easing) out.easing = spec.easing;
  return out;
}

/** Seconds a presets path takes (for callers that want the video to match it). */
export function presetSpecDuration(spec: { views: Array<{ transition?: number; hold?: number }> }): number {
  let total = 0;
  spec.views.forEach((v, i) => {
    if (i > 0) total += Math.max(0, v.transition ?? DEFAULT_PRESET_TRANSITION);
    total += Math.max(0, v.hold ?? DEFAULT_PRESET_HOLD);
  });
  return total;
}

// ─── Downscale / jitter accumulation (F11) ───────────────────────────────

const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Box filter: mean of the ss×ss source texels of this output pixel (linear light), × weight. */
const FS_BOX = `#version 300 es
precision highp float;
uniform highp sampler2D uSrc;
uniform int uSS;
uniform float uWeight;
out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uSS;
  vec3 sum = vec3(0.0);
  for (int y = 0; y < 8; y++) {
    if (y >= uSS) break;
    for (int x = 0; x < 8; x++) {
      if (x >= uSS) break;
      sum += texelFetch(uSrc, base + ivec2(x, y), 0).rgb;
    }
  }
  outColor = vec4(sum / float(uSS * uSS) * uWeight, uWeight);
}`;

/** Final pass: linear accumulation → sRGB-encoded output pixel. */
const FS_OUT = `#version 300 es
precision highp float;
uniform highp sampler2D uAcc;
out vec4 outColor;
vec3 enc(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  outColor = vec4(enc(texelFetch(uAcc, ivec2(gl_FragCoord.xy), 0).rgb), 1.0);
}`;

/**
 * Exact ss→1 box downscale of the render canvas into an output canvas, with
 * optional averaging of several jittered sub-renders. Linear-light averaging:
 * the source is uploaded as sRGB (decoded on fetch), accumulated in a float
 * (or sRGB8) target, and encoded back to sRGB on output.
 */
export class RVFrameDownscaler {
  readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly progBox: WebGLProgram;
  private readonly progOut: WebGLProgram;
  private readonly srcTex: WebGLTexture;
  private readonly accTex: WebGLTexture;
  private readonly fbo: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uSS: WebGLUniformLocation | null;
  private readonly uWeight: WebGLUniformLocation | null;
  /** True when the accumulation target is floating point. */
  readonly floatAccumulation: boolean;

  constructor(readonly width: number, readonly height: number, readonly ss: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('Video capture: WebGL2 is not available for the downscale pass.');
    this.gl = gl;
    this.progBox = this._program(FS_BOX);
    this.progOut = this._program(FS_OUT);
    this.uSS = gl.getUniformLocation(this.progBox, 'uSS');
    this.uWeight = gl.getUniformLocation(this.progBox, 'uWeight');
    this.vao = gl.createVertexArray()!;
    this.srcTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.accTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.accTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.fbo = gl.createFramebuffer()!;
    let float = !!gl.getExtension('EXT_color_buffer_float');
    if (float) {
      // RGBA16F: renderable with EXT_color_buffer_float AND blendable without
      // EXT_float_blend (32F blending would need it).
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accTex, 0);
      float = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    }
    if (!float) {
      // sRGB8 fallback: blending happens in linear light, storage is 8-bit sRGB.
      gl.bindTexture(gl.TEXTURE_2D, this.accTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accTex, 0);
    }
    this.floatAccumulation = float;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Start a new output frame (clears the accumulation). */
  begin(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Add one sub-render: `source` (the viewer canvas, read in the SAME task as
   * its render) box-filtered by ss and weighted by `weight`.
   */
  add(source: HTMLCanvasElement | OffscreenCanvas, weight: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    // Flip so texture row 0 = bottom, matching gl_FragCoord of the targets.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.progBox);
    gl.uniform1i(this.uSS, this.ss);
    gl.uniform1f(this.uWeight, weight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  /** Resolve the accumulation into the output canvas (ready for `new VideoFrame`). */
  finish(): OffscreenCanvas {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.progOut);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accTex);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.srcTex);
    gl.deleteTexture(this.accTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteProgram(this.progBox);
    gl.deleteProgram(this.progOut);
    gl.deleteVertexArray(this.vao);
    (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  }

  private _program(fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(`Video capture shader: ${gl.getShaderInfoLog(sh)}`);
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Video capture program: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.useProgram(prog);
    const loc = gl.getUniformLocation(prog, fs === FS_BOX ? 'uSrc' : 'uAcc');
    gl.uniform1i(loc, 0);
    return prog;
  }
}

// ─── Session ──────────────────────────────────────────────────────────────

/** Viewers with a recording in flight — the lock from the first await on (F2b). */
const _sessions = new WeakSet<object>();

/** True while `recordVideo` runs on this viewer. */
export function isRecording(viewer: VideoCaptureHost): boolean {
  return _sessions.has(viewer) || viewer.isCapturing;
}

/** Yield one macrotask without timers (not throttled in background tabs). */
const yieldToEventLoop = yieldMacrotask;

class CaptureAbort extends Error {}

/**
 * Record a video of the loaded model (plan-537). Returns the MP4 bytes and
 * the frame/time stamps. Throws with a clear message on invalid options, an
 * unsupported state, an encoder failure, the deadline, the byte budget or an
 * abort — the viewer is restored in every case.
 */
export async function recordVideo(
  viewer: VideoCaptureHost,
  options: VideoRecordOptions,
  deps: { VideoEncoder?: typeof VideoEncoder } = {},
): Promise<VideoRecordResult> {
  const opts = normalizeVideoOptions(options);
  const cinematicFactory = opts.quality === 'cinematic' ? getCinematicRenderer() : null;
  if (opts.quality === 'cinematic') {
    if (!cinematicFactory) throw new Error(CINEMATIC_UNAVAILABLE_MESSAGE);
    if (typeof options.frameSink !== 'function') throw new Error('A cinematic recording needs a frameSink (the CLI writes one PNG per frame).');
  }
  const pre = isRecording(viewer) ? 'A video capture is already running on this viewer.' : viewer.capturePreflight();
  if (pre) throw new Error(pre);
  _sessions.add(viewer);
  const t0 = performance.now();
  const deadlineAt = opts.deadlineMs > 0 ? t0 + opts.deadlineMs : Infinity;
  const signal = options.signal;

  let encoder: VideoEncoder | null = null;
  let output: { cancel(): Promise<void>; finalize(): Promise<void> } | null = null;
  let finalized = false;
  let downscaler: RVFrameDownscaler | null = null;
  let began = false;
  let encoderError: unknown = null;
  let budgetError: Error | null = null;
  let encodedBytes = 0;
  let cinematicSource: CinematicFrameSource | null = null;
  const cinematicPose = createCameraPathPose();

  const check = (): void => {
    if (encoderError) throw encoderError instanceof Error ? encoderError : new Error(String(encoderError));
    if (budgetError) throw budgetError;
    if (signal?.aborted) throw new CaptureAbort('Recording aborted.');
    const abort = viewer.captureAbortReason;
    if (abort) throw new CaptureAbort(`Recording aborted: ${abort}.`);
    if (performance.now() > deadlineAt) {
      throw new Error(`Recording exceeded its deadline of ${(opts.deadlineMs / 1000).toFixed(0)} s.`);
    }
  };

  try {
    // ── Take over the viewer FIRST, before any await: the live loop stops in
    // the same task as the call, so the start state is the state the caller
    // saw (determinism) — encoder setup and the muxer import happen inside. ──
    const raster = rasterQualityConfig(
      opts.quality, opts.width, opts.height, () => viewer.getCaptureGpuLimits(),
      { supersample: opts.supersample, jitter: opts.jitter },
    );
    const ss = raster.supersample;
    const frameDt = 1 / opts.fps;
    const path = resolveCameraPath(viewer, opts.path, opts.width / opts.height, opts.seconds);
    const cinematic = opts.quality === 'cinematic';
    // plan-551 F19: the camera was read from the current view above; the sim restarts from its
    // load state now, in the same task as the take-over, so nothing ticks in between.
    if (options.resetSimulation) {
      if (typeof viewer.resetSimulation !== 'function') throw new Error('This viewer cannot reset its simulation.');
      viewer.resetSimulation();
    }
    viewer.beginCapture({
      width: opts.width, height: opts.height, supersample: ss, frameDt,
      fullResPost: raster.fullResPost, shadowMapSize: raster.shadowMapSize,
    });
    began = true;

    if (cinematic) {
      // ── Cinematic frame source (plan-550): same sim / camera / restore, other frame sink ──
      const source = await cinematicFactory!();
      cinematicSource = source;
      check();
      // plan-553 F7: the look is resolved BEFORE the fingerprint; `--hdr` wins over the look HDR.
      const resolved = resolveCinematicLook(source, opts.look!);
      const hdrUrl = cinematicHdrUrl(opts.hdr, resolved);
      // A worker BVH build transfers (detaches) a mesh's CPU buffers while it runs; neither
      // the fingerprint nor the scene copy may read geometry inside that window (plan-550 F4).
      await viewer.whenBvhIdle?.();
      check();
      const context = await cinematicContext(viewer, source, path, opts, hdrUrl, resolved);
      if (options.onCinematicContext) await options.onCinematicContext(context);
      check();

      // Warmup — identical to the raster path (one raster render, not written).
      viewer.captureStep(opts.warmupSteps, 1 / FIXED_STEP_HZ);
      path.pose(0, cinematicPose);
      viewer.setCaptureCameraPose(cinematicPose.position, cinematicPose.target, cinematicPose.fov);
      if (!viewer.captureRenderFrame(opts.warmupSteps / FIXED_STEP_HZ, frameDt)) {
        throw new Error('The warmup frame failed to render.');
      }
      const simStartC = viewer.simTime;
      const warmupSecC = opts.warmupSteps / FIXED_STEP_HZ;
      // One video frame: sim step, camera, raster tick (render-time state such as
      // plugin onRender, dissolve and follow advances exactly as in a normal run).
      // plan-554 F2: with a motion recorder the frame's steps run ONE BY ONE (same count, same
      // dt — no extra tick) and the read-only hook records the state before the first step,
      // after every step and after the raster tick. Without it (blur off, fast-forward) the
      // sequence is the plan-553 one (N3).
      const advance = (i: number, motion: CinematicMotionRecorder | null = null): void => {
        if (motion) {
          motion.beginFrame();
          for (let k = 0; k < opts.stepsPerFrame; k++) {
            viewer.captureStep(1, 1 / FIXED_STEP_HZ);
            motion.afterStep();
          }
        } else {
          viewer.captureStep(opts.stepsPerFrame, 1 / FIXED_STEP_HZ);
        }
        path.pose(i / opts.fps, cinematicPose);
        viewer.setCaptureCameraPose(cinematicPose.position, cinematicPose.target, cinematicPose.fov);
        if (!viewer.captureRenderFrame(warmupSecC + (i + 1) / opts.fps, frameDt)) {
          throw new Error(`Frame ${i} failed to render — recording stopped.`);
        }
        motion?.afterRender();
      };
      // Fast-forward to the resume point (F9): the same sequence, nothing traced.
      for (let i = 0; i < opts.startFrame; i++) {
        check();
        advance(i);
        if (i % 30 === 29) await yieldToEventLoop();
      }

      await viewer.whenBvhIdle?.(); // nothing new may have started during the fast-forward
      check();
      const blurRequest = opts.motionBlur?.enabled ? opts.motionBlur : null;
      const rawSetup = await source.setup(...cinematicSetupInput(viewer, {
        width: opts.width, height: opts.height, samples: opts.samples, denoise: opts.denoise,
        hdrUrl, look: opts.look!, cameraSamples: sampleCameraPath(path, opts),
        motionBlur: blurRequest ? { shutterDeg: blurRequest.shutterDeg, subFrames: blurRequest.subFrames, fps: opts.fps } : null,
      }));
      // plan-554 F5/F7: the resolved blur is decided ONCE, here, for the whole run.
      const setup: CinematicSetupInfo = { ...rawSetup, motionBlur: resolveSetupBlur(blurRequest, rawSetup.motionBlur) };
      const motion = setup.motionBlur!.resolved !== 'off' ? source.motionRecorder?.() ?? null : null;
      if (blurRequest && setup.motionBlur!.resolved !== 'off' && !motion) {
        setup.motionBlur = { resolved: 'off', reason: 'the frame source offers no motion recorder', subFrames: 1 };
      }
      // A resume compares the resolved mode here — after setup, before the first frame (F7).
      if (options.onCinematicSetup) await options.onCinematicSetup(setup);
      const cuts = path.cutTimes();
      const subPose = createCameraPathPose();

      let lastMs: number | null = null;
      let msSum = 0;
      let rendered = 0;
      for (let i = opts.startFrame; i < opts.frames; i++) {
        check();
        advance(i, motion);
        const stallTimeoutMs = cinematicStallTimeoutMs(lastMs);
        // plan-553 F6: focus on the pose's target (orbit centre / fixed target / interpolated preset target).
        const focusDistance = cinematicPose.position.distanceTo(cinematicPose.target);
        // plan-554 F3b: every sub-time evaluates the camera PATH (no camera interpolation).
        const frameTime = i / opts.fps;
        const cameraAt = motion
          ? (offsetSec: number): number => {
            path.pose(cameraSubTime(frameTime, offsetSec, cuts), subPose);
            viewer.setCaptureCameraPose(subPose.position, subPose.target, subPose.fov);
            return subPose.position.distanceTo(subPose.target);
          }
          : undefined;
        const result = await withBackstop(source.renderFrame(i, { stallTimeoutMs, signal, focusDistance, ...(cameraAt ? { cameraAt } : {}) }), stallTimeoutMs + 60_000, i);
        await options.frameSink!(i, result.png, result.stats);
        if (options.frameHook) {
          // plan-556 F5/F7: the tracer PNG is decoded (never re-encoded) and laid under the HMI.
          const snapshot = await createImageBitmap(new Blob([result.png as BlobPart], { type: 'image/png' }));
          const returned = await runFrameHook(options, i, {
            snapshot, png: result.png, simTimeMs: viewer.simTime * 1000,
            timestampUs: Math.round(i * (1e6 / opts.fps)), durationUs: Math.round(1e6 / opts.fps), signal,
          });
          returned?.close();
          check();
        }
        lastMs = result.stats.ms;
        msSum += result.stats.ms;
        rendered++;
        if (options.onProgress) await options.onProgress(i, opts.frames);
        await yieldToEventLoop();
      }
      return {
        bytes: new Uint8Array(0),
        frames: opts.frames,
        seconds: opts.seconds,
        fps: opts.fps,
        width: opts.width,
        height: opts.height,
        codec: 'png',
        bitrate: 0,
        hardwareAcceleration: 'n/a',
        quality: opts.quality,
        supersample: 1,
        jitter: 0,
        warmupSteps: opts.warmupSteps,
        renderSeconds: +((performance.now() - t0) / 1000).toFixed(3),
        simStart: simStartC,
        simEnd: viewer.simTime,
        cinematic: {
          startFrame: opts.startFrame,
          framesRendered: rendered,
          setup,
          context,
          avgFrameMs: rendered ? Math.round(msSum / rendered) : 0,
        },
      };
    }

    // plan-556: with a frame hook the encoder runs before it (layer), not at all (composite —
    // the CLI muxes its own frames) or on the frame the hook returns (the dialog's tab grab).
    const hookMode: FrameHookEncode | null = options.frameHook ? (options.frameHookEncode ?? 'before') : null;
    if (hookMode !== null && !['before', 'skip', 'replace'].includes(hookMode)) {
      throw new Error(`Unknown frameHookEncode "${String(hookMode)}" — use before, skip or replace.`);
    }
    const EncoderCtor = deps.VideoEncoder ?? (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
    let config: VideoEncoderConfig | null = null;
    let target: { buffer: ArrayBuffer | null } | null = null;
    let muxChain: Promise<void> = Promise.resolve();
    let enc: VideoEncoder | null = null;
    if (hookMode !== 'skip') {
      config = await selectEncoderConfig(opts, EncoderCtor);
      if (!EncoderCtor) throw new Error('This browser has no WebCodecs VideoEncoder — record in Chrome or Edge.');
      check();
      const mb = await import('mediabunny');
      check();
      const bufferTarget = new mb.BufferTarget();
      target = bufferTarget;
      const out = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: bufferTarget });
      output = out;
      const muxCodec = opts.codec;
      const source = new mb.EncodedVideoPacketSource(muxCodec);
      out.addVideoTrack(source, { frameRate: opts.fps });
      await out.start();

      encoder = new EncoderCtor!({
        output: (chunk, meta) => {
          // F2f: the ACTUAL bytes, summed per chunk — the estimate only gates the start.
          encodedBytes += chunk.byteLength;
          if (encodedBytes > opts.maxBytes && !budgetError) {
            budgetError = new Error(
              `The encoded video exceeded the in-memory limit of ${(opts.maxBytes / 1048576).toFixed(0)} MB — shorten it or lower the bitrate.`,
            );
          }
          if (budgetError || encoderError) return;
          try {
            const packet = mb.EncodedPacket.fromEncodedChunk(chunk);
            // Never left rejecting: a muxer error surfaces through check().
            muxChain = muxChain
              .then(() => source.add(packet, meta))
              .catch((e: unknown) => { if (!encoderError) encoderError = e; });
          } catch (e) {
            if (!encoderError) encoderError = e;
          }
        },
        error: (e) => { encoderError = e; },
      });
      encoder.configure(config);
      enc = encoder;
    }

    const waitQueue = async (): Promise<void> => {
      const e = enc;
      if (!e) return;
      while (e.encodeQueueSize > MAX_ENCODE_QUEUE) {
        check();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          e.addEventListener('dequeue', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
    };

    const canvas = viewer.renderer.domElement as HTMLCanvasElement;
    const subRenders = opts.jitter > 0 ? opts.jitter : 1;
    const offsets = opts.jitter > 0 ? jitterOffsets(opts.jitter) : [[0, 0] as [number, number]];
    const useDownscaler = ss > 1 || opts.jitter > 0;
    if (useDownscaler) downscaler = new RVFrameDownscaler(opts.width, opts.height, ss);
    const pose = createCameraPathPose();

    // ── Warmup: whole fixed steps, one render (not encoded) ──
    viewer.captureStep(opts.warmupSteps, 1 / FIXED_STEP_HZ);
    path.pose(0, pose);
    viewer.setCaptureCameraPose(pose.position, pose.target, pose.fov);
    if (!viewer.captureRenderFrame(opts.warmupSteps / FIXED_STEP_HZ, frameDt)) {
      throw new Error('The warmup frame failed to render.');
    }
    const simStart = viewer.simTime;
    const warmupSec = opts.warmupSteps / FIXED_STEP_HZ;
    const usPerFrame = 1e6 / opts.fps;
    const keyEvery = 2 * opts.fps;

    for (let i = 0; i < opts.frames; i++) {
      check();
      viewer.captureStep(opts.stepsPerFrame, 1 / FIXED_STEP_HZ);
      path.pose(i / opts.fps, pose);
      viewer.setCaptureCameraPose(pose.position, pose.target, pose.fov);
      const clock = warmupSec + (i + 1) / opts.fps;
      let frameSource: HTMLCanvasElement | OffscreenCanvas = canvas;
      if (downscaler) {
        downscaler.begin();
        for (let s = 0; s < subRenders; s++) {
          const [jx, jy] = offsets[s];
          if (!viewer.captureRenderFrame(clock, s === 0 ? frameDt : 0, jx, jy)) {
            throw new Error(`Frame ${i} failed to render — recording stopped (no broken frame was encoded).`);
          }
          downscaler.add(canvas, 1 / subRenders);
        }
        frameSource = downscaler.finish();
      } else if (!viewer.captureRenderFrame(clock, frameDt)) {
        throw new Error(`Frame ${i} failed to render — recording stopped (no broken frame was encoded).`);
      }
      const timestampUs = Math.round(i * usPerFrame);
      const durationUs = Math.round(usPerFrame);
      // plan-556 F5: the snapshot is taken at CALL time, in the render task — the very pixels the
      // encoder gets (accumulated / downscaled for high and max), never a later canvas state.
      const snapP = hookMode !== null ? createImageBitmap(frameSource) : null;
      if (enc && hookMode !== 'replace') {
        // Built in the SAME task as the render — no preserveDrawingBuffer needed.
        const frame = new VideoFrame(frameSource, { timestamp: timestampUs, duration: durationUs });
        try {
          enc.encode(frame, { keyFrame: i % keyEvery === 0 });
        } finally {
          frame.close();
        }
        await waitQueue();
      }
      if (snapP) {
        const snapshot = await snapP;
        const returned = await runFrameHook(options, i, {
          snapshot, simTimeMs: viewer.simTime * 1000, timestampUs, durationUs, signal,
        });
        check();
        if (hookMode === 'replace') {
          if (!returned) throw new Error(`The frame hook returned no frame for frame ${i} — recording stopped.`);
          const frame = restampFrame(returned, timestampUs, durationUs, opts.width, opts.height, i);
          try {
            enc!.encode(frame, { keyFrame: i % keyEvery === 0 });
          } finally {
            frame.close();
          }
          await waitQueue();
        } else {
          returned?.close();
        }
      }
      if (options.onProgress) await options.onProgress(i, opts.frames);
      await yieldToEventLoop();
    }
    const simEnd = viewer.simTime;

    if (!enc || !output || !config || !target) {
      // plan-556 composite: no encoder — the frames went to the hook.
      return {
        bytes: new Uint8Array(0),
        frames: opts.frames,
        seconds: opts.seconds,
        fps: opts.fps,
        width: opts.width,
        height: opts.height,
        codec: 'none',
        bitrate: 0,
        hardwareAcceleration: 'n/a',
        quality: opts.quality,
        supersample: ss,
        jitter: opts.jitter,
        warmupSteps: opts.warmupSteps,
        renderSeconds: +((performance.now() - t0) / 1000).toFixed(3),
        simStart,
        simEnd,
      };
    }
    const out = output;

    // ── Flush (deadline-checked) ──
    check();
    const remaining = deadlineAt - performance.now();
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = enc.flush();
    if (Number.isFinite(remaining)) {
      await Promise.race([
        flush,
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error(`Recording exceeded its deadline of ${(opts.deadlineMs / 1000).toFixed(0)} s while flushing the encoder.`)),
            Math.max(0, remaining),
          );
        }),
      ]).finally(() => { if (deadlineTimer) clearTimeout(deadlineTimer); });
    } else {
      await flush;
    }
    check();
    await muxChain;
    check();
    await out.finalize();
    finalized = true;
    const buffer = target.buffer;
    if (!buffer) throw new Error('The MP4 muxer produced no output.');

    return {
      bytes: new Uint8Array(buffer),
      frames: opts.frames,
      seconds: opts.seconds,
      fps: opts.fps,
      width: opts.width,
      height: opts.height,
      codec: config.codec,
      bitrate: opts.bitrate,
      hardwareAcceleration: String(config.hardwareAcceleration ?? 'no-preference'),
      quality: opts.quality,
      supersample: ss,
      jitter: opts.jitter,
      warmupSteps: opts.warmupSteps,
      renderSeconds: +((performance.now() - t0) / 1000).toFixed(3),
      simStart,
      simEnd,
    };
  } finally {
    if (cinematicSource) {
      // The source disposes tracer → denoiser → device itself; guarded so a
      // throwing dispose can never skip endCapture (F11).
      try { await cinematicSource.dispose(); } catch (e) { console.warn('[video-capture] cinematic dispose failed:', e); }
    }
    if (began) viewer.endCapture();
    downscaler?.dispose();
    if (encoder && encoder.state !== 'closed') {
      try { encoder.close(); } catch { /* already closed */ }
    }
    if (output && !finalized) {
      try { await output.cancel(); } catch { /* nothing to cancel */ }
    }
    _sessions.delete(viewer);
  }
}

// ─── Frame hook (plan-556) ─────────────────────────────────────────────────

/**
 * Calls the frame hook bounded by its timeout (visible time) and the abort signal; the snapshot
 * is closed afterwards whatever happened. A frame a hook returns after losing the race is closed.
 */
async function runFrameHook(options: VideoRecordOptions, i: number, info: FrameHookInfo): Promise<VideoFrame | null> {
  const timeoutMs = num(options.frameHookTimeoutMs, FRAME_HOOK_TIMEOUT_MS);
  try {
    const r = await raceAbortable(Promise.resolve().then(() => options.frameHook!(i, info)), {
      signal: info.signal,
      timeoutMs,
      abortMessage: 'Recording aborted.',
      onTimeout: () => new Error(`The frame hook of frame ${i} did not finish within ${Math.round(timeoutMs / 1000)} s — recording stopped.`),
      onLate: (v) => { if (v) v.close(); },
    });
    return r ?? null;
  } catch (e) {
    // An abort of the race is the recording's abort (CLI exit code / dialog message).
    if (info.signal?.aborted) throw new CaptureAbort('Recording aborted.');
    throw e;
  } finally {
    info.snapshot.close();
  }
}

/**
 * A replacement frame with the run's deterministic timestamp / duration (plan-556 F10 encoder
 * seam). Consumes `frame`: returned as is when its stamps match, else re-wrapped and closed. A
 * frame of another display size refuses the run.
 */
export function restampFrame(frame: VideoFrame, timestampUs: number, durationUs: number, width: number, height: number, index: number): VideoFrame {
  if (frame.displayWidth !== width || frame.displayHeight !== height) {
    const got = `${frame.displayWidth}x${frame.displayHeight}`;
    frame.close();
    throw new Error(`Frame ${index} from the frame hook is ${got}, expected ${width}x${height} — recording stopped.`);
  }
  if (frame.timestamp === timestampUs && frame.duration === durationUs) return frame;
  const stamped = new VideoFrame(frame, { timestamp: timestampUs, duration: durationUs });
  frame.close();
  return stamped;
}

// ─── Cinematic helpers (plan-550) ─────────────────────────────────────────

/**
 * Rejects with a resumable error when `p` has not settled after `ms` of VISIBLE time (a hung
 * GPU wait). Time the tab spends hidden does not count (plan-551 F22): when the timer fires
 * while hidden, or too soon after the tab came back, it re-arms for the rest.
 */
export function withBackstop<T>(p: Promise<T>, ms: number, frame: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armedAt = performance.now();
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const arm = (delay: number): void => {
        timer = setTimeout(() => {
          const elapsed = watchdogElapsedMs(armedAt);
          if (elapsed >= ms) {
            reject(new CinematicResumableError(`Frame ${frame} did not finish within ${Math.round(ms / 1000)} s (GPU hang?).`));
          } else {
            arm(Math.max(1000, ms - elapsed));
          }
        }, delay);
      };
      arm(ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** JSON with sorted keys — the override content hash must not depend on key order. */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Structure hash of the model: mesh names (UUIDs masked), vertex / index counts
 * and a few sampled position values, in traversal order. Cheap (no full buffer hash) and
 * stable across reloads of the same file; a buffer that cannot be read
 * contributes its counts only.
 */
export async function modelStructureHash(root: Object3D | null): Promise<string> {
  if (!root) return 'none';
  const parts: string[] = [];
  root.traverse((o) => {
    const m = o as Object3D & { isMesh?: boolean; geometry?: { attributes?: Record<string, { count: number; array?: ArrayLike<number> }>; index?: { count: number } | null } };
    // Runtime overlays (`__*`: hover, highlight, MU pools) come and go — not model content.
    if (!m.isMesh || !m.geometry || o.name.startsWith('__')) return;
    const pos = m.geometry.attributes?.position;
    const n = pos?.count ?? 0;
    let sample = '';
    const arr = pos?.array;
    const buf = (arr as unknown as { buffer?: { detached?: boolean } } | undefined)?.buffer;
    if (arr && arr.length > 0 && !buf?.detached) {
      const pick = (k: number): string => (Number.isFinite(arr[k]) ? round4(arr[k] as number).toString() : 'x');
      sample = [0, 1, 2, arr.length - 3, arr.length - 2, arr.length - 1].map(pick).join(',');
    }
    // Baked chunk names carry per-load texture UUIDs (`tex:<uuid>`) — not content.
    const name = o.name.replace(UUID_RE, '*');
    parts.push(`${name}|${n}|${m.geometry.index?.count ?? -1}|${sample}`);
  });
  return (await sha256Hex(new TextEncoder().encode(parts.join('\n')))).slice(0, 32);
}

/** Components of the model that use unseeded randomness (resume may differ visually, F9). */
export function findUnseededRandomness(viewer: VideoCaptureHost): string[] {
  const out: string[] = [];
  const reg = viewer.registry;
  if (!reg?.forEachNode || !reg.getComponentsAt) return out;
  reg.forEachNode((path) => {
    for (const [type, inst] of reg.getComponentsAt!(path)) {
      if (type === 'Source' && (inst as { RandomDistance?: boolean }).RandomDistance === true) out.push(`${path}: Source.RandomDistance`);
      else if (/Erratic/i.test(type)) out.push(`${path}: ${type}`);
    }
  });
  return out.slice(0, 50);
}

/**
 * The resolved look of a request (plan-553 F7). A frame source without `resolveLook` (plan-550)
 * renders the viewer setup, whatever was asked for — recorded as such in the fingerprint.
 */
export function resolveCinematicLook(source: Pick<CinematicFrameSource, 'resolveLook'>, request: CinematicLookRequest): CinematicResolvedLook {
  if (typeof source.resolveLook === 'function') return source.resolveLook(request);
  return { look: 'viewer', hdr: null, params: {}, lookVersion: 0, materialVersion: 0, fallbacks: ['look→viewer (frame source without looks)'] };
}

/**
 * The resolved motion blur of a run (plan-554 F7): `off` without a request (no reason — nothing
 * fell back), the source's answer when it gave one, else `off` naming the missing support.
 */
export function resolveSetupBlur(request: MotionBlurRequest | null, reported: CinematicBlurResolution | undefined): CinematicBlurResolution {
  if (!request || !request.enabled) return { resolved: 'off', reason: null, subFrames: 1 };
  if (!reported) return { resolved: 'off', reason: 'the frame source does not support motion blur', subFrames: 1 };
  return reported;
}

/** Absolute URL of the HDR a cinematic render is lit with: the override, else the look's HDR, else the default. */
export function cinematicHdrUrl(override: string | null, resolved: Pick<CinematicResolvedLook, 'hdr'>): string {
  return override ?? new URL(resolved.hdr ?? DEFAULT_ENVIRONMENT_HDR, document.baseURI).href;
}

/**
 * The arguments of {@link CinematicFrameSource.setup} for the current viewer (plan-557: shared
 * by the video and the still) — the live scene, model root, camera and tone mapping, plus the
 * output, look and camera samples.
 */
export function cinematicSetupInput(
  viewer: VideoCaptureHost,
  o: {
    width: number; height: number; samples: number; denoise: CinematicDenoise; hdrUrl: string;
    look: CinematicLookRequest;
    cameraSamples: Array<{ position: [number, number, number]; target: [number, number, number] }>;
    /** plan-554: the motion blur of a video (absent / null = off; a still never passes it). */
    motionBlur?: CinematicSetupOptions['motionBlur'];
  },
): [CinematicSceneHost, CinematicSetupOptions] {
  return [{
    scene: viewer.scene!,
    modelRoot: viewer.currentModelRoot!,
    camera: viewer.camera,
    ...(typeof viewer.renderer.toneMapping === 'number'
      ? { toneMapping: { mapping: viewer.renderer.toneMapping, exposure: viewer.renderer.toneMappingExposure ?? 1 } }
      : {}),
  }, {
    width: o.width, height: o.height, samples: o.samples, denoise: o.denoise,
    hdrUrl: o.hdrUrl, weightsBaseUrl: new URL('oidn/', document.baseURI).href,
    look: o.look.look,
    vignette: o.look.vignette,
    dof: o.look.dof,
    fStop: o.look.fStop,
    materialPresets: o.look.materialPresets,
    materialOverrides: o.look.materialOverrides,
    cameraSamples: o.cameraSamples,
    ...(o.motionBlur ? { motionBlur: o.motionBlur } : {}),
  }];
}

/** Camera positions / targets of the path at 17 evenly spaced frames, frame 0 first (plan-553 F1). */
export function sampleCameraPath(path: CameraPath, opts: Pick<NormalizedVideoOptions, 'frames' | 'fps'>): Array<{ position: [number, number, number]; target: [number, number, number] }> {
  const pose = createCameraPathPose();
  const out: Array<{ position: [number, number, number]; target: [number, number, number] }> = [];
  const n = 16;
  for (let k = 0; k <= n; k++) {
    const frame = Math.round((k / n) * Math.max(0, opts.frames - 1));
    path.pose(frame / opts.fps, pose);
    out.push({
      position: [round4(pose.position.x), round4(pose.position.y), round4(pose.position.z)],
      target: [round4(pose.target.x), round4(pose.target.y), round4(pose.target.z)],
    });
  }
  return out;
}

async function cinematicContext(
  viewer: VideoCaptureHost, source: CinematicFrameSource, path: CameraPath, opts: NormalizedVideoOptions, hdrUrl: string,
  resolved: CinematicResolvedLook,
): Promise<CinematicContext> {
  let hdrHash = 'unreadable';
  try {
    const res = await fetch(hdrUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    hdrHash = await sha256Hex(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`The environment HDR could not be loaded (${hdrUrl}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const scene = viewer.scene;
  const lights: CinematicContext['lights'] = [];
  scene?.updateMatrixWorld(true);
  scene?.traverse((o) => {
    const l = o as Object3D & { isDirectionalLight?: boolean; intensity: number; color: { getHexString(): string }; target: Object3D };
    if (!l.isDirectionalLight || !l.visible || !(l.intensity > 0)) return;
    const p = new Vector3().setFromMatrixPosition(l.matrixWorld);
    const t = new Vector3().setFromMatrixPosition(l.target.matrixWorld);
    const d = p.sub(t).normalize();
    lights.push({ color: l.color.getHexString(), intensity: round4(l.intensity), direction: [round4(d.x), round4(d.y), round4(d.z)] });
  });
  const bg = scene?.background as { isColor?: boolean; getHexString?(): string } | null | undefined;
  const pose = createCameraPathPose();
  const cameraPoses: number[][] = [];
  const cam = viewer.camera as { isOrthographicCamera?: boolean; zoom?: number };
  const ortho = cam.isOrthographicCamera === true;
  for (const i of [0, Math.floor(opts.frames / 2), opts.frames - 1]) {
    path.pose(i / opts.fps, pose);
    // plan-551 F20: the resolved camera, fov + projection + zoom included, guards a resume.
    const fov = pose.fov ?? cameraFov(viewer);
    cameraPoses.push([...pose.position.toArray(), ...pose.target.toArray(), fov, ortho ? 1 : 0, cam.zoom ?? 1].map(round4));
  }
  const rot = scene?.environmentRotation;
  return {
    model: viewer.currentModelUrl ?? null,
    modelHash: await modelStructureHash(viewer.currentModelRoot),
    hdr: opts.hdr ? 'override' : (resolved.hdr ?? DEFAULT_ENVIRONMENT_HDR),
    hdrHash,
    look: {
      name: resolved.look,
      params: resolved.params,
      lookVersion: resolved.lookVersion,
      materialVersion: resolved.materialVersion,
      fallbacks: resolved.fallbacks,
      dof: opts.look?.dof === true,
      fStop: opts.look?.dof ? opts.look.fStop : null,
      vignette: opts.look?.vignette ?? 0,
      materialPresets: opts.look?.materialPresets !== false,
      overridesHash: opts.look?.materialOverrides
        ? (await sha256Hex(new TextEncoder().encode(stableJson(opts.look.materialOverrides)))).slice(0, 32)
        : null,
    },
    environment: {
      intensity: round4(scene?.environmentIntensity ?? 1),
      rotation: rot ? [round4(rot.x), round4(rot.y), round4(rot.z)] : [0, 0, 0],
      background: bg?.isColor && bg.getHexString ? bg.getHexString() : null,
      toneMapping: typeof viewer.renderer.toneMapping === 'number' ? viewer.renderer.toneMapping : null,
      exposure: typeof viewer.renderer.toneMappingExposure === 'number' ? round4(viewer.renderer.toneMappingExposure) : null,
    },
    lights,
    cameraPoses,
    renderer: source.info.renderer,
    tracerVersion: source.info.tracerVersion,
    denoiserVersion: source.info.denoiserVersion,
    seedRule: CINEMATIC_SEED_RULE,
    unseededRandomness: findUnseededRandomness(viewer),
  };
}

// ─── Still image (plan-557) ───────────────────────────────────────────────

/** Samples per pixel of a cinematic still when none are given (dialog default, plan-557 F4). */
export const CINEMATIC_STILL_DEFAULT_SAMPLES = 256;
/** Largest edge of a still image (px). */
export const MAX_STILL_EDGE = 8192;
/** Measured in plan-550: 26.7 s per 1080p frame at 64 spp (GTX 1060, aux denoiser) — the still backstop scales it. */
export const CINEMATIC_SEC_PER_FRAME_1080P_64 = 26.7;

/** Refusal of a cinematic still with an orthographic camera (plan-557 F2b). */
export const STILL_ORTHO_MESSAGE = 'Cinematic needs the perspective camera — switch the projection.';
/** Refusal when another tab of this site holds the cinematic renderer (the `acquire` hook returned null). */
export const STILL_BUSY_MESSAGE = 'The cinematic renderer is busy — a cinematic recording runs in another tab of this site. Finish or stop it first.';
/** Message of the AbortError a cancelled still rejects with. */
export const STILL_CANCELLED_MESSAGE = 'Still image cancelled.';

/** Something held for the duration of a still (the cinematic Web Lock); released in `finally`. */
export interface CaptureLease { release(): void }

/** Phase a still reports through `onPhase` (the overlay text, the cancel hint). */
export type StillPhase = 'setup' | 'render' | 'encode';

export interface StillCaptureOptions {
  /** Output width in physical pixels, 16..8192 (odd allowed). */
  width: number;
  /** Output height in physical pixels, 16..8192 (odd allowed). */
  height: number;
  /** Default 'high'. */
  quality?: VideoQuality;
  /** Requested supersample factor for high / max (default 2, capped by the GPU). */
  supersample?: number;
  /** Jittered sub-renders for `max` (default 4). */
  jitter?: number;
  /**
   * WebLabel screen size reference (plan-557 F2c): `output` = relative to the output height (the
   * video contract, default); `viewport` = as on screen (the canvas CSS height scaled to the output).
   */
  labelReference?: 'output' | 'viewport';
  /** Cancels the still: nothing is returned, the viewer is restored. */
  signal?: AbortSignal;
  /**
   * Runs right AFTER the viewer was taken over (the state is frozen) — the cinematic lock is
   * acquired here. Resolving null refuses the still with {@link STILL_BUSY_MESSAGE}; the lease is
   * released in `finally`.
   */
  acquire?: () => Promise<CaptureLease | null>;
  /** cinematic: sample progress of the one frame. */
  onProgress?: (done: number, total: number) => void;
  /** Phase changes (setup → render → encode). */
  onPhase?: (phase: StillPhase) => void;
  /** cinematic: timeout of every async setup phase (ms, default {@link CINEMATIC_FIRST_FRAME_STALL_MS}). */
  setupTimeoutMs?: number;
  /**
   * plan-556 F5b (CLI `--still`): reset the simulation to its load state in the take-over task —
   * the image then shows a defined state instead of the state of the click.
   */
  resetSimulation?: boolean;
  /** plan-556 F5b: whole fixed 1/60 s steps run after the (optional) reset, before the image (`--at`). */
  steps?: number;
  /**
   * plan-556: called with the finished image before the viewer is released (the HMI composite /
   * layer of a still): `snapshot` = the image as a bitmap (closed afterwards), `png` = its bytes.
   */
  frameHook?: (info: { snapshot: ImageBitmap; png: Uint8Array; simTimeMs: number; signal?: AbortSignal }) => void | Promise<void>;
  // ── cinematic ──
  /** cinematic: samples per pixel (default {@link CINEMATIC_STILL_DEFAULT_SAMPLES}). */
  samples?: number;
  /** cinematic: OIDN denoiser mode (default 'aux'). */
  denoise?: CinematicDenoise;
  /** cinematic: URL of an equirect HDR replacing the look's environment. */
  hdr?: string;
  look?: CinematicLookName;
  dof?: boolean;
  fStop?: number;
  vignette?: number;
  materialPresets?: boolean;
  materialOverrides?: CinematicMaterialOverrides | null;
}

export interface StillCaptureResult {
  /** The image as PNG bytes. */
  png: Uint8Array;
  width: number;
  height: number;
  quality: VideoQuality;
  supersample: number;
  jitter: number;
  /** cinematic: samples per pixel; 0 for raster. */
  samples: number;
  /** Wall-clock seconds the still took. */
  renderSeconds: number;
  /** viewer.simTime of the image (unchanged by the still). */
  simTime: number;
}

/** Normalised, validated still options. */
export interface NormalizedStillOptions {
  width: number;
  height: number;
  quality: VideoQuality;
  supersample: number;
  jitter: number;
  samples: number;
  denoise: CinematicDenoise;
  hdr: string | null;
  look: CinematicLookRequest | null;
  labelReference: 'output' | 'viewport';
  setupTimeoutMs: number;
  /** Fixed steps before the image (0 = none). */
  steps: number;
}

/** Largest `steps` of a still (one hour of sim time). */
export const MAX_STILL_STEPS = FIXED_STEP_HZ * 3600;

/** Validate and normalise still options; throws a clear Error on anything unsupported (plan-557 F3). */
export function normalizeStillOptions(o: StillCaptureOptions): NormalizedStillOptions {
  const width = num(o.width, NaN);
  const height = num(o.height, NaN);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > MAX_STILL_EDGE || height > MAX_STILL_EDGE) {
    throw new Error(`Size ${o.width}x${o.height} is out of range (whole pixels, 16..${MAX_STILL_EDGE} px).`);
  }
  if (width * height > MAX_RENDER_PIXELS) {
    throw new Error(`Size ${width}x${height} exceeds the render limit of ${(MAX_RENDER_PIXELS / 1e6).toFixed(1)} megapixels.`);
  }
  const quality = (o.quality ?? 'high') as VideoQuality;
  if (!['standard', 'high', 'max', 'cinematic'].includes(quality)) throw new Error(`Unknown quality "${quality}" — use standard, high, max or cinematic.`);
  const cinematic = quality === 'cinematic';
  let samples = 0;
  let denoise: CinematicDenoise = 'off';
  let look: CinematicLookRequest | null = null;
  if (cinematic) {
    samples = num(o.samples, CINEMATIC_STILL_DEFAULT_SAMPLES);
    if (!Number.isInteger(samples) || samples < 1 || samples > CINEMATIC_MAX_SAMPLES) {
      throw new Error(`samples must be an integer between 1 and ${CINEMATIC_MAX_SAMPLES}.`);
    }
    denoise = (o.denoise ?? 'aux') as CinematicDenoise;
    if (!['aux', 'noaux', 'off'].includes(denoise)) throw new Error(`Unknown denoise "${denoise}" — use aux, noaux or off.`);
    look = normalizeLookRequest(o);
  } else if (
    o.samples !== undefined || o.denoise !== undefined || o.hdr !== undefined || o.look !== undefined || o.dof !== undefined
    || o.fStop !== undefined || o.vignette !== undefined || o.materialPresets !== undefined || o.materialOverrides !== undefined
  ) {
    throw new Error('samples, denoise, hdr, look, dof, fStop, vignette, materialPresets and materialOverrides need quality "cinematic".');
  }
  const labelReference = o.labelReference ?? 'output';
  if (labelReference !== 'output' && labelReference !== 'viewport') throw new Error(`Unknown labelReference "${String(labelReference)}" — use output or viewport.`);
  const setupTimeoutMs = num(o.setupTimeoutMs, CINEMATIC_FIRST_FRAME_STALL_MS);
  const steps = num(o.steps, 0);
  if (!Number.isInteger(steps) || steps < 0 || steps > MAX_STILL_STEPS) {
    throw new Error(`steps must be a whole number between 0 and ${MAX_STILL_STEPS}.`);
  }
  return {
    steps,
    width, height, quality,
    // The REQUESTED factors (same rules as the video) — the GPU cap is applied when the capture starts.
    supersample: quality === 'standard' || cinematic ? 1 : Math.max(1, Math.min(4, Math.floor(num(o.supersample, 2)))),
    jitter: quality === 'max' ? Math.max(1, Math.min(16, Math.floor(num(o.jitter, 4)))) : 0,
    samples, denoise,
    hdr: cinematic && typeof o.hdr === 'string' && o.hdr ? o.hdr : null,
    look,
    labelReference,
    setupTimeoutMs: setupTimeoutMs > 0 ? setupTimeoutMs : CINEMATIC_FIRST_FRAME_STALL_MS,
  };
}

/**
 * Fits a size into the still limits (edges ≤ {@link MAX_STILL_EDGE}, pixels ≤
 * {@link MAX_RENDER_PIXELS}) keeping the aspect ratio — the "Viewport" choice of a large or
 * high-DPI screen (plan-557 F3). `scaled` tells whether it had to shrink.
 */
export function fitStillSize(width: number, height: number): { width: number; height: number; scaled: boolean } {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const scale = Math.min(1, MAX_STILL_EDGE / w, MAX_STILL_EDGE / h, Math.sqrt(MAX_RENDER_PIXELS / (w * h)));
  if (scale >= 1) return { width: w, height: h, scaled: false };
  return { width: Math.max(16, Math.floor(w * scale)), height: Math.max(16, Math.floor(h * scale)), scaled: true };
}

/**
 * Overall backstop of a cinematic still (plan-557 F6): at least the first-frame stall + 60 s,
 * else 3 × the expected trace time (pixels × samples, scaled from the 1080p / 64 spp
 * measurement) + 300 s — 1024 spp in 4K takes half an hour and must not be cut off. Hangs are
 * caught much earlier by the stall timeout raced against every wait.
 */
export function stillBackstopMs(width: number, height: number, samples: number): number {
  const expectedSec = ((width * height) / (1920 * 1080)) * (samples / 64) * CINEMATIC_SEC_PER_FRAME_1080P_64;
  return Math.max(CINEMATIC_FIRST_FRAME_STALL_MS + 60_000, Math.round((3 * expectedSec + 300) * 1000));
}

/** The on-screen WebLabel reference of a viewport still: canvas CSS height × output / drawing buffer (plan-557 F2c). */
function viewportLabelHeight(viewer: VideoCaptureHost, outputHeight: number): number | null {
  const canvas = viewer.renderer.domElement as HTMLCanvasElement;
  const css = typeof canvas.clientHeight === 'number' ? canvas.clientHeight : 0;
  const buffer = canvas.height;
  if (!(css > 0) || !(buffer > 0)) return null;
  return css * (outputHeight / buffer);
}

/**
 * One image of the 3D scene EXACTLY as it is now (plan-557): the current simulation state —
 * no step, no warmup, no reset — and the current camera, as PNG. Raster (standard / high / max)
 * uses the video's capture frame and quality configuration; cinematic traces one frame with the
 * registered path tracer.
 *
 * The viewer is taken over SYNCHRONOUSLY, before the first `await` (F2): the live loop stops in
 * the caller's task, so a running simulation cannot tick between the click and the image. The
 * cinematic lock (`acquire`), the renderer import, the BVH wait and the scene setup all happen
 * afterwards, raced against the signal and a setup timeout; a cancelled still rejects with an
 * `AbortError`. The viewer, the frame source and the lease are released in every case.
 */
export async function captureStill(viewer: VideoCaptureHost, options: StillCaptureOptions): Promise<StillCaptureResult> {
  const o = normalizeStillOptions(options);
  const cinematic = o.quality === 'cinematic';
  const factory = cinematic ? getCinematicRenderer() : null;
  // ── Still preflight: refusals that leave the viewer untouched ──
  if (cinematic && !factory) throw new Error(CINEMATIC_UNAVAILABLE_MESSAGE);
  if (cinematic && (viewer.camera as OrthographicCamera).isOrthographicCamera === true) throw new Error(STILL_ORTHO_MESSAGE);
  const pre = isRecording(viewer) ? 'A video capture is already running on this viewer.' : viewer.capturePreflight();
  if (pre) throw new Error(pre);
  const signal = options.signal;
  if (signal?.aborted) throw createAbortError(STILL_CANCELLED_MESSAGE);
  // Read BEFORE beginCapture: the take-over changes size and DPR.
  const labelReferenceHeight = o.labelReference === 'viewport' ? viewportLabelHeight(viewer, o.height) : null;

  _sessions.add(viewer);
  const t0 = performance.now();
  let began = false;
  let lease: CaptureLease | null = null;
  let source: CinematicFrameSource | null = null;
  let downscaler: RVFrameDownscaler | null = null;
  const check = (): void => {
    if (signal?.aborted) throw createAbortError(STILL_CANCELLED_MESSAGE);
    const abort = viewer.captureAbortReason;
    if (abort) throw new CaptureAbort(`Still image aborted: ${abort}.`);
  };
  const disposeLate = (s: CinematicFrameSource): void => {
    void s.dispose().catch((e: unknown) => console.warn('[video-capture] late cinematic dispose failed:', e));
  };
  /** One async setup phase, raced against the signal and the setup timeout (F7, R2-2). */
  const setupPhase = <T>(p: Promise<T>, what: string, onLate?: (v: T) => void): Promise<T> => raceAbortable(p, {
    signal,
    timeoutMs: o.setupTimeoutMs,
    abortMessage: STILL_CANCELLED_MESSAGE,
    onTimeout: () => new CinematicResumableError(`The cinematic scene setup did not finish within ${Math.round(o.setupTimeoutMs / 1000)} s (${what}).`),
    onLate,
  });

  try {
    // ── Take over the viewer FIRST, before any await (F2): the state the caller saw is the image. ──
    const raster = rasterQualityConfig(
      o.quality, o.width, o.height, () => viewer.getCaptureGpuLimits(),
      { supersample: o.supersample, jitter: o.jitter },
    );
    // plan-556 F5b: a defined state — reset in the take-over task, then exactly `steps` fixed steps.
    if (options.resetSimulation) {
      if (typeof viewer.resetSimulation !== 'function') throw new Error('This viewer cannot reset its simulation.');
      viewer.resetSimulation();
    }
    viewer.beginCapture({
      width: o.width, height: o.height, supersample: raster.supersample,
      // frameDt 0: no render-time animation advances for the still.
      frameDt: 0,
      fullResPost: raster.fullResPost, shadowMapSize: raster.shadowMapSize,
      labelReferenceHeight,
    });
    began = true;
    if (o.steps > 0) viewer.captureStep(o.steps, 1 / FIXED_STEP_HZ);

    if (options.acquire) {
      lease = await raceAbortable(options.acquire(), {
        signal, abortMessage: STILL_CANCELLED_MESSAGE, onLate: (l) => { l?.release(); },
      });
      if (!lease) throw new Error(STILL_BUSY_MESSAGE);
    }
    check();

    let png: Uint8Array;
    if (cinematic) {
      options.onPhase?.('setup');
      const src = await setupPhase(factory!(), 'loading the renderer', disposeLate);
      source = src;
      check();
      const look = o.look!;
      const resolved = resolveCinematicLook(src, look);
      const hdrUrl = cinematicHdrUrl(o.hdr, resolved);
      // A worker BVH build detaches CPU buffers while it runs — the scene copy must wait (plan-550 F4).
      if (viewer.whenBvhIdle) await setupPhase(viewer.whenBvhIdle(), 'waiting for the BVH build');
      check();
      // One raster tick on the frozen state (world matrices, render-time state) — like the video warmup render.
      if (!viewer.captureRenderFrame(0, 0)) throw new Error('The still image failed to render.');
      const cam = viewer.getCameraState();
      const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
      const cameraSamples = [{
        position: [r4(cam.position.x), r4(cam.position.y), r4(cam.position.z)] as [number, number, number],
        target: [r4(cam.target.x), r4(cam.target.y), r4(cam.target.z)] as [number, number, number],
      }];
      // A setup that resolves after a cancel / timeout is disposed at once (its GPU device included).
      await setupPhase(
        src.setup(...cinematicSetupInput(viewer, {
          width: o.width, height: o.height, samples: o.samples, denoise: o.denoise, hdrUrl, look, cameraSamples,
        })),
        'building the path-traced scene',
        () => disposeLate(src),
      );
      check();
      options.onPhase?.('render');
      const frame = await withBackstop(raceAbortable(src.renderFrame(0, {
        stallTimeoutMs: CINEMATIC_FIRST_FRAME_STALL_MS,
        signal,
        abortInFrame: true,
        focusDistance: cam.position.distanceTo(cam.target),
        onProgress: options.onProgress,
      }), { signal, abortMessage: STILL_CANCELLED_MESSAGE }), stillBackstopMs(o.width, o.height, o.samples), 0);
      check();
      png = frame.png;
      if (options.frameHook) {
        const snapshot = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
        await runStillHook(options, { snapshot, png, simTimeMs: viewer.simTime * 1000, signal });
        check();
      }
    } else {
      options.onPhase?.('render');
      const canvas = viewer.renderer.domElement;
      // One render on the frozen state first (shadows, post buffers) — the video's warmup render.
      if (!viewer.captureRenderFrame(0, 0)) throw new Error('The still image failed to render.');
      let image: HTMLCanvasElement | OffscreenCanvas = canvas;
      if (raster.supersample > 1 || raster.jitter > 0) {
        downscaler = new RVFrameDownscaler(o.width, o.height, raster.supersample);
        const subRenders = raster.jitter > 0 ? raster.jitter : 1;
        const offsets = raster.jitter > 0 ? jitterOffsets(raster.jitter) : [[0, 0] as [number, number]];
        downscaler.begin();
        for (let s = 0; s < subRenders; s++) {
          const [jx, jy] = offsets[s];
          if (!viewer.captureRenderFrame(0, 0, jx, jy)) throw new Error('The still image failed to render.');
          downscaler.add(canvas, 1 / subRenders);
        }
        image = downscaler.finish();
      } else if (!viewer.captureRenderFrame(0, 0)) {
        throw new Error('The still image failed to render.');
      }
      // Copied in the SAME task as the render — no preserveDrawingBuffer needed.
      const out = new OffscreenCanvas(o.width, o.height);
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('No 2D context for the still image.');
      ctx.drawImage(image, 0, 0, o.width, o.height);
      // plan-556: the snapshot for the HMI underlay, taken in the render task (copy at call time).
      const snapP = options.frameHook ? createImageBitmap(out) : null;
      options.onPhase?.('encode');
      const blob = await raceAbortable(out.convertToBlob({ type: 'image/png' }), { signal, abortMessage: STILL_CANCELLED_MESSAGE });
      check();
      png = new Uint8Array(await blob.arrayBuffer());
      if (snapP) {
        await runStillHook(options, { snapshot: await snapP, png, simTimeMs: viewer.simTime * 1000, signal });
        check();
      }
    }
    return {
      png,
      width: o.width,
      height: o.height,
      quality: o.quality,
      supersample: raster.supersample,
      jitter: raster.jitter,
      samples: o.samples,
      renderSeconds: +((performance.now() - t0) / 1000).toFixed(3),
      simTime: viewer.simTime,
    };
  } finally {
    // Restore first — independent of how long the frame source takes to release its device.
    if (began) viewer.endCapture();
    downscaler?.dispose();
    if (source) {
      try { await source.dispose(); } catch (e) { console.warn('[video-capture] cinematic dispose failed:', e); }
    }
    if (lease) {
      try { lease.release(); } catch (e) { console.warn('[video-capture] lease release failed:', e); }
    }
    _sessions.delete(viewer);
  }
}

/** The still's frame hook, abortable, bounded like a video frame hook; the snapshot is closed afterwards. */
async function runStillHook(
  options: StillCaptureOptions,
  info: { snapshot: ImageBitmap; png: Uint8Array; simTimeMs: number; signal?: AbortSignal },
): Promise<void> {
  try {
    await raceAbortable(Promise.resolve().then(() => options.frameHook!(info)), {
      signal: info.signal,
      timeoutMs: FRAME_HOOK_TIMEOUT_MS,
      abortMessage: STILL_CANCELLED_MESSAGE,
      onTimeout: () => new Error(`The still image hook did not finish within ${Math.round(FRAME_HOOK_TIMEOUT_MS / 1000)} s.`),
    });
  } finally {
    info.snapshot.close();
  }
}

export interface MuxFramesOptions {
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** Returns frame `i` as an image blob (PNG). */
  getFrame: (index: number) => Promise<Blob>;
  bitrate?: number;
  codec?: VideoCodecChoice;
  maxBytes?: number;
  onProgress?: (frame: number, total: number) => void;
  /** Aborts the mux (plan-551 F12/F23): checked per frame and raced against every encoder / muxer wait. */
  signal?: AbortSignal;
}

export interface MuxFramesResult {
  bytes: Uint8Array;
  frames: number;
  codec: string;
  bitrate: number;
  hardwareAcceleration: string;
}

/** Error text of an aborted mux. */
export const MUX_ABORTED_MESSAGE = 'Recording aborted while muxing the MP4.';

/**
 * Encode a sequence of image frames (the PNGs of a cinematic run) into an MP4
 * with WebCodecs + mediabunny, timestamps `i / fps` — the same encoder ladder
 * and muxer as `recordVideo` (plan-550 F3).
 *
 * plan-551 F23: every wait (encoder queue, flush, the mux chain, finalize) races the abort
 * signal and an encoder error, so a cancel never hangs; after an abort the encoder and the
 * muxer are closed and nothing is written. The ACTUAL encoded bytes are counted like the
 * raster path; above `maxBytes` the mux stops with the budget error.
 */
export async function muxVideoFrames(
  o: MuxFramesOptions,
  deps: { VideoEncoder?: typeof VideoEncoder; mediabunny?: typeof import('mediabunny') } = {},
): Promise<MuxFramesResult> {
  if (!(o.frames >= 1) || !Number.isInteger(o.frames)) throw new Error('frames must be a positive integer.');
  if (o.fps !== 30 && o.fps !== 60) throw new Error(`fps ${o.fps} is not supported — use 30 or 60.`);
  const codec = o.codec ?? 'avc';
  const bitrate = Math.round(o.bitrate ?? defaultBitrate(o.width, o.height, o.fps));
  const maxBytes = o.maxBytes ?? DEFAULT_VIDEO_BUDGET_BYTES;
  const seconds = o.frames / o.fps;
  const budgetMessage = `The encoded video exceeded the in-memory limit of ${(maxBytes / 1048576).toFixed(0)} MB — shorten it or lower the bitrate.`;
  if (estimateVideoBytes(bitrate, seconds) > maxBytes) {
    throw new Error(`Estimated video size exceeds the in-memory limit of ${(maxBytes / 1048576).toFixed(0)} MB — lower the bitrate.`);
  }
  const signal = o.signal;
  if (signal?.aborted) throw new Error(MUX_ABORTED_MESSAGE);
  const EncoderCtor = deps.VideoEncoder ?? (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  const config = await selectEncoderConfig({ codec, width: o.width, height: o.height, fps: o.fps, bitrate }, EncoderCtor);
  const mb = deps.mediabunny ?? await import('mediabunny');
  if (signal?.aborted) throw new Error(MUX_ABORTED_MESSAGE);
  const target = new mb.BufferTarget();
  const out = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new mb.EncodedVideoPacketSource(codec);
  out.addVideoTrack(source, { frameRate: o.fps });
  await out.start();
  let muxChain: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let encodedBytes = 0;
  // Settles the moment the run must stop (abort, encoder error, byte cap) — every wait races it.
  let stopNow: ((e: Error) => void) | null = null;
  const stopped = new Promise<never>((_, reject) => { stopNow = reject; });
  stopped.catch(() => { /* observed through the races below */ });
  const fail = (e: unknown): void => {
    if (!failure) failure = e;
    stopNow?.(e instanceof Error ? e : new Error(String(e)));
  };
  const onAbort = (): void => fail(new Error(MUX_ABORTED_MESSAGE));
  signal?.addEventListener('abort', onAbort, { once: true });
  const check = (): void => {
    if (signal?.aborted) throw new Error(MUX_ABORTED_MESSAGE);
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  };
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped]);
  const encoder = new EncoderCtor!({
    output: (chunk, meta) => {
      if (failure) return;
      encodedBytes += chunk.byteLength;
      if (encodedBytes > maxBytes) { fail(new Error(budgetMessage)); return; }
      try {
        const packet = mb.EncodedPacket.fromEncodedChunk(chunk);
        muxChain = muxChain.then(() => (failure ? undefined : source.add(packet, meta))).catch((e: unknown) => fail(e));
      } catch (e) {
        fail(e);
      }
    },
    error: (e) => fail(e),
  });
  let finalized = false;
  try {
    encoder.configure(config);
    const canvas = new OffscreenCanvas(o.width, o.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context for the frame mux.');
    const usPerFrame = 1e6 / o.fps;
    for (let i = 0; i < o.frames; i++) {
      check();
      const blob = await race(o.getFrame(i));
      const bmp = await race(createImageBitmap(blob));
      try {
        if (bmp.width !== o.width || bmp.height !== o.height) {
          throw new Error(`Frame ${i} is ${bmp.width}x${bmp.height}, expected ${o.width}x${o.height}.`);
        }
        ctx.drawImage(bmp, 0, 0);
      } finally {
        bmp.close();
      }
      check();
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) });
      try {
        encoder.encode(frame, { keyFrame: i % (2 * o.fps) === 0 });
      } finally {
        frame.close();
      }
      // Backpressure without timers (plan-551 F8): the encoder's `dequeue` event (a
      // MessageChannel round trip where it is missing), never `setTimeout` — timers of a hidden
      // tab are throttled to ≥ 1 s. A stuck queue still ends on abort / error (`race`).
      while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        check();
        const target = encoder as unknown as { addEventListener?: EventTarget['addEventListener'] };
        await race(typeof target.addEventListener === 'function'
          ? new Promise<void>((resolve) => target.addEventListener!('dequeue', () => resolve(), { once: true }))
          : yieldMacrotask());
      }
      o.onProgress?.(i, o.frames);
    }
    check();
    await race(encoder.flush());
    check();
    await race(muxChain);
    check();
    await race(out.finalize());
    check();
    finalized = true;
    if (!target.buffer) throw new Error('The MP4 muxer produced no output.');
    return {
      bytes: new Uint8Array(target.buffer),
      frames: o.frames,
      codec: config.codec,
      bitrate,
      hardwareAcceleration: String(config.hardwareAcceleration ?? 'no-preference'),
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (encoder.state !== 'closed') {
      try { encoder.close(); } catch { /* already closed */ }
    }
    if (!finalized) {
      try { await out.cancel(); } catch { /* nothing to cancel */ }
    }
  }
}

/** Default MP4 file name for a recording (`<model>-<YYYYMMDD-HHMMSS>.mp4`). */
export function defaultVideoFileName(base: string, now = new Date()): string {
  return defaultCaptureFileName(base, 'mp4', now);
}

/** Default file name of a capture (`<model>-<YYYYMMDD-HHMMSS>.<ext>`, plan-557 F8). */
export function defaultCaptureFileName(base: string, ext: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const safe = (base || 'recording').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'recording';
  return `${safe}-${stamp}.${ext.replace(/^\./, '')}`;
}

/** Trigger a browser download of the bytes (CLI receives it via Playwright's download event). */
export function downloadVideo(bytes: Uint8Array, fileName: string): void {
  downloadBytes(bytes, fileName, 'video/mp4');
}

/** Trigger a browser download of `bytes` as `fileName` with the given MIME type (plan-557 F8). */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
