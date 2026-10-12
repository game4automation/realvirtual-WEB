// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-agent-eye.ts — the MCP agent's own camera body (plan-740 Phase 1).
 *
 * Until now every `web_camera_*` call moved the VISIBLE viewport camera, so the
 * moment a human touched the orbit controls the agent's idea of "where I am
 * looking" and the picture it got no longer agreed. The AgentEye is that state
 * pulled out into a body of its own: a pose (position, target, fov, aspect,
 * projection) that only the agent moves, that no user input ever touches, and
 * that survives an F5 within the same tab.
 *
 * Deliberately dependency-light — three.js and one pure key helper. It must
 * stay importable from the plugin-free embed bundle, so:
 *   - NO `.tsx` import (that would drag React/MUI in — D-A3 / R2-A-N1),
 *   - no `RVViewer` import; the viewport pose arrives through a callback.
 *
 * The ortho frustum is computed HERE and not through
 * `CameraManager.syncOrthoFrustum`: that one reads `controls.target` and the
 * viewport's own perspective camera, neither of which the agent body has
 * (D-A9). `fov` stays the width measure in orthographic mode — the sidecar
 * reports the resulting {@link AgentEye.orthoHalfHeight} in metres.
 */

import { PerspectiveCamera, OrthographicCamera, Vector3 } from 'three';

/** Projection of the agent camera. Mirrors the viewer's `ProjectionType`. */
export type EyeProjection = 'perspective' | 'orthographic';

/** Vertical field of view clamp, degrees (D-A9). */
export const EYE_FOV_MIN = 5;
export const EYE_FOV_MAX = 120;
/** Aspect (width / height) clamp (D-A9). */
export const EYE_ASPECT_MIN = 0.2;
export const EYE_ASPECT_MAX = 5;
/** Default aspect of a freshly spawned body — 4:3, a neutral vision-model frame. */
export const EYE_DEFAULT_ASPECT = 4 / 3;

/** sessionStorage key prefix; the model key is appended (D-A3). */
export const AGENT_EYE_STORAGE_PREFIX = 'rv.agentEye.';

/**
 * The persisted pose. Flat like `CameraBookmark` so JSON round-trips without a
 * schema: six coordinates plus the lens.
 */
export interface AgentPose {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
  /** Vertical FOV in degrees, clamped 5..120. In ortho it is the width measure. */
  fov: number;
  /** Width / height, clamped 0.2..5. */
  aspect: number;
  projection: EyeProjection;
}

/** Everything a caller can observe about the body. */
export interface AgentEyeState {
  pose: AgentPose;
  /** True while the human viewport follows the body (CameraManager follow mode). */
  attached: boolean;
  /** `Date.now()` of the spawn this pose belongs to. */
  spawnedAt: number;
}

/** The viewport pose a fresh body spawns at (D-A18). */
export interface ViewportPoseSnapshot {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  projection: EyeProjection;
}

/** Lens patch accepted by {@link AgentEye.setLens}. */
export interface EyeLens {
  fov?: number;
  aspect?: number;
  projection?: EyeProjection;
}

export interface AgentEyeOptions {
  /** Where a fresh body spawns. Called only on the spawning `ensure()`. */
  getViewportState: () => ViewportPoseSnapshot;
  /**
   * Per-model persistence key (`deriveModelKey`). A function is re-read on
   * every access so the plugin can hand over a live viewer lookup; `null`
   * disables persistence entirely rather than writing under a bogus key.
   */
  modelKey?: string | null | (() => string | null);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate a parsed storage blob before it is trusted as a pose.
 *
 * Everything finite, the lens inside its clamp range, the projection one of the
 * two enum values. Anything else is discarded — a corrupt entry must not be
 * able to produce a NaN camera matrix that then poisons every render.
 */
export function isValidPose(v: unknown): v is AgentPose {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  for (const k of ['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const) {
    if (!isFin(p[k])) return false;
  }
  if (!isFin(p.fov) || p.fov < EYE_FOV_MIN || p.fov > EYE_FOV_MAX) return false;
  if (!isFin(p.aspect) || p.aspect < EYE_ASPECT_MIN || p.aspect > EYE_ASPECT_MAX) return false;
  if (p.projection !== 'perspective' && p.projection !== 'orthographic') return false;
  return true;
}

/** Read a persisted pose; never throws (Safari private mode raises here). */
function readPose(key: string): AgentPose | null {
  try {
    const raw = sessionStorage.getItem(AGENT_EYE_STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidPose(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write a pose; a failing write is silently dropped (D-A3, quota/SecurityError). */
function writePose(key: string, pose: AgentPose): void {
  try {
    sessionStorage.setItem(AGENT_EYE_STORAGE_PREFIX + key, JSON.stringify(pose));
  } catch { /* storage unavailable — the body simply does not survive F5 */ }
}

/**
 * The agent's camera body: a pose plus the two three.js cameras that realise
 * it. Nothing here renders — {@link camera} hands out a configured camera for
 * whoever does (the gizmo, the pick unprojection, later the offscreen capture).
 */
export class AgentEye {
  private readonly opts: AgentEyeOptions;
  private _pose: AgentPose | null = null;
  private _attached = false;
  private _spawnedAt = 0;
  private readonly _persp = new PerspectiveCamera(45, EYE_DEFAULT_ASPECT, 0.01, 1000);
  private readonly _ortho = new OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  private readonly _listeners = new Set<(state: AgentEyeState) => void>();

  // Pre-allocated temps — `unproject` and the gizmo update run per frame while
  // attached, and the follow tick must stay GC-free.
  private readonly _tmpPos = new Vector3();
  private readonly _tmpTarget = new Vector3();
  private readonly _tmpDir = new Vector3();
  private readonly _tmpUnproject = new Vector3();

  constructor(opts: AgentEyeOptions) {
    this.opts = opts;
  }

  /** Whether a body currently exists (no spawn is triggered by asking). */
  get exists(): boolean { return this._pose !== null; }

  /** True while the human viewport follows this body. Set by the plugin. */
  get attached(): boolean { return this._attached; }
  set attached(v: boolean) {
    if (this._attached === v) return;
    this._attached = v;
    this._emit();
  }

  /** The persistence key right now, or null when persistence is off. */
  get modelKey(): string | null {
    const k = this.opts.modelKey;
    return (typeof k === 'function' ? k() : k) ?? null;
  }

  /**
   * The body, spawning it at the current viewport pose on first call (D-A18).
   * A pose persisted for the same model key wins over the viewport pose, so an
   * F5 mid-session puts the agent back where it was.
   */
  ensure(): AgentEyeState {
    if (!this._pose) {
      const key = this.modelKey;
      const stored = key ? readPose(key) : null;
      this._pose = stored ?? this._spawnPose();
      this._spawnedAt = Date.now();
      this._apply();
      // Only a fresh spawn is written back; a loaded pose is already stored.
      if (!stored) this._persist();
      this._emit();
    }
    return this.state;
  }

  /**
   * Adopt a pose persisted for the CURRENT model key, without spawning one if
   * there is none. What a model load does (§2.6): a model the agent already
   * worked on gets its cone back, a fresh one stays bodiless until the first
   * `web_camera_*` call.
   *
   * Returns true when a pose was adopted.
   */
  loadPersisted(): boolean {
    const key = this.modelKey;
    const stored = key ? readPose(key) : null;
    if (!stored) return false;
    this._pose = stored;
    this._spawnedAt = Date.now();
    this._apply();
    this._emit();
    return true;
  }

  /** Snapshot of the current state. The pose is a copy — mutate via the setters. */
  get state(): AgentEyeState {
    const pose = this._pose ?? this._spawnPose();
    return { pose: { ...pose }, attached: this._attached, spawnedAt: this._spawnedAt };
  }

  /** The current pose (copy). Spawns nothing — call {@link ensure} for that. */
  get pose(): AgentPose { return { ...(this._pose ?? this._spawnPose()) }; }

  /** Patch position/target (and, if given, lens fields). Clamped, persisted, emitted. */
  setPose(patch: Partial<AgentPose>): AgentEyeState {
    this.ensure();
    const p = this._pose!;
    for (const k of ['px', 'py', 'pz', 'tx', 'ty', 'tz'] as const) {
      const v = patch[k];
      if (isFin(v)) p[k] = v;
    }
    if (patch.fov !== undefined || patch.aspect !== undefined || patch.projection !== undefined) {
      this._applyLens({ fov: patch.fov, aspect: patch.aspect, projection: patch.projection });
    }
    this._commit();
    return this.state;
  }

  /** Aim the body at a world point, keeping its position. */
  lookAt(x: number, y: number, z: number): AgentEyeState {
    return this.setPose({ tx: x, ty: y, tz: z });
  }

  /**
   * Change the lens. `fov` and `aspect` are clamped ON SET, not on load, so a
   * caller that reads the pose back never sees an out-of-range value it then
   * has to defend against (D-A9).
   */
  setLens(lens: EyeLens): AgentEyeState {
    this.ensure();
    this._applyLens(lens);
    this._commit();
    return this.state;
  }

  private _applyLens(lens: EyeLens): void {
    const p = this._pose!;
    if (isFin(lens.fov)) p.fov = clamp(lens.fov, EYE_FOV_MIN, EYE_FOV_MAX);
    if (isFin(lens.aspect)) p.aspect = clamp(lens.aspect, EYE_ASPECT_MIN, EYE_ASPECT_MAX);
    if (lens.projection === 'perspective' || lens.projection === 'orthographic') {
      p.projection = lens.projection;
    }
  }

  /** Distance from the eye to its look-at target, in metres. */
  get distance(): number {
    const p = this._pose ?? this._spawnPose();
    return Math.hypot(p.px - p.tx, p.py - p.ty, p.pz - p.tz);
  }

  /**
   * Half-height of the orthographic frustum in metres — `dist · tan(fov/2)`
   * (D-A9). Reported in the sidecar because `fov` alone means nothing in ortho.
   */
  get orthoHalfHeight(): number {
    const p = this._pose ?? this._spawnPose();
    return this.distance * Math.tan((p.fov * Math.PI) / 360);
  }

  /**
   * The configured camera for the current projection. Same object every call —
   * callers must not keep it across a projection change; ask again instead.
   */
  camera(): PerspectiveCamera | OrthographicCamera {
    this.ensure();
    return this._pose!.projection === 'orthographic' ? this._ortho : this._persp;
  }

  /**
   * World-space ray through an image position, `x`/`y` as fractions 0..1 with
   * (0,0) = top-left — the same frame the agent's captures use. Writes into the
   * caller's vectors when given, so a pick loop allocates nothing.
   *
   * In orthographic mode every ray is parallel to the view direction and the
   * origin slides across the near plane, which is exactly what an ortho pick
   * has to do.
   */
  unproject(x: number, y: number, outOrigin?: Vector3, outDir?: Vector3): { origin: Vector3; direction: Vector3 } {
    const cam = this.camera();
    cam.updateMatrixWorld(true);
    const origin = outOrigin ?? new Vector3();
    const direction = outDir ?? new Vector3();
    const ndcX = clamp(x, 0, 1) * 2 - 1;
    const ndcY = -(clamp(y, 0, 1) * 2 - 1);
    if (cam instanceof OrthographicCamera) {
      // Near-plane point + the camera's forward axis: parallel projection.
      this._tmpUnproject.set(ndcX, ndcY, -1).unproject(cam);
      origin.copy(this._tmpUnproject);
      direction.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    } else {
      this._tmpUnproject.set(ndcX, ndcY, 0.5).unproject(cam);
      origin.copy(cam.position);
      direction.copy(this._tmpUnproject).sub(cam.position).normalize();
    }
    return { origin, direction };
  }

  /**
   * The four frustum corners at `depth` metres in front of the eye, in CAMERA
   * LOCAL space, order top-left, top-right, bottom-right, bottom-left. Written
   * into `out` (length 12) when given so the gizmo can rewrite its vertex
   * buffer in place instead of rebuilding geometry (§2.4.2 / S6).
   */
  frustumCornersFor(depth: number, out?: number[]): number[] {
    const p = this._pose ?? this._spawnPose();
    const halfH = p.projection === 'orthographic'
      ? this.orthoHalfHeight
      : depth * Math.tan((p.fov * Math.PI) / 360);
    const halfW = halfH * p.aspect;
    const z = -depth;
    const dst = out ?? new Array<number>(12);
    dst[0] = -halfW; dst[1] = halfH; dst[2] = z;
    dst[3] = halfW; dst[4] = halfH; dst[5] = z;
    dst[6] = halfW; dst[7] = -halfH; dst[8] = z;
    dst[9] = -halfW; dst[10] = -halfH; dst[11] = z;
    return dst;
  }

  /**
   * Drop the body. The next `ensure()` spawns a fresh one at the then-current
   * viewport pose — what a model change does (D-A18). The persisted entry for
   * the old model key is deliberately LEFT in place: reloading that model
   * should still bring the agent back to where it was.
   */
  reset(): void {
    this._pose = null;
    this._spawnedAt = 0;
    this._attached = false;
    this._emit();
  }

  /** Subscribe to pose/attach changes. Returns the unsubscribe function. */
  onChange(cb: (state: AgentEyeState) => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  // ─── internals ────────────────────────────────────────────────────

  private _spawnPose(): AgentPose {
    const v = this.opts.getViewportState();
    const pos = v.position, tgt = v.target;
    return {
      px: isFin(pos?.[0]) ? pos[0] : 0,
      py: isFin(pos?.[1]) ? pos[1] : 0,
      pz: isFin(pos?.[2]) ? pos[2] : 0,
      tx: isFin(tgt?.[0]) ? tgt[0] : 0,
      ty: isFin(tgt?.[1]) ? tgt[1] : 0,
      tz: isFin(tgt?.[2]) ? tgt[2] : 0,
      fov: clamp(isFin(v.fov) ? v.fov : 45, EYE_FOV_MIN, EYE_FOV_MAX),
      aspect: EYE_DEFAULT_ASPECT,
      projection: v.projection === 'orthographic' ? 'orthographic' : 'perspective',
    };
  }

  /** Push the pose into the two cameras. */
  private _apply(): void {
    const p = this._pose!;
    this._tmpPos.set(p.px, p.py, p.pz);
    this._tmpTarget.set(p.tx, p.ty, p.tz);
    this._tmpDir.copy(this._tmpTarget).sub(this._tmpPos);
    // Degenerate pose (eye on its target) yields a NaN look-at basis; nudge the
    // target along -Z instead of poisoning every matrix downstream.
    if (this._tmpDir.lengthSq() < 1e-12) this._tmpTarget.set(p.px, p.py, p.pz - 1);

    this._persp.position.copy(this._tmpPos);
    this._persp.fov = p.fov;
    this._persp.aspect = p.aspect;
    this._persp.lookAt(this._tmpTarget);
    this._persp.updateProjectionMatrix();
    this._persp.updateMatrixWorld(true);

    const halfH = this.orthoHalfHeight;
    const halfW = halfH * p.aspect;
    this._ortho.position.copy(this._tmpPos);
    this._ortho.left = -halfW;
    this._ortho.right = halfW;
    this._ortho.top = halfH;
    this._ortho.bottom = -halfH;
    this._ortho.lookAt(this._tmpTarget);
    this._ortho.updateProjectionMatrix();
    this._ortho.updateMatrixWorld(true);
  }

  private _persist(): void {
    const key = this.modelKey;
    if (key && this._pose) writePose(key, this._pose);
  }

  private _commit(): void {
    this._apply();
    this._persist();
    this._emit();
  }

  private _emit(): void {
    if (this._listeners.size === 0) return;
    const s = this.state;
    for (const cb of this._listeners) {
      try { cb(s); } catch { /* a faulty listener must not stall the agent */ }
    }
  }
}
