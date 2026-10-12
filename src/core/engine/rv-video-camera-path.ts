// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-video-camera-path — camera movements for the deterministic video capture
 * (plan-537 F5), as pure math.
 *
 * A path is a pure function `pose(t)` of the PRESENTATION time t (seconds since
 * the first encoded frame). Nothing here touches a viewer: the capture engine
 * resolves the inputs (model bounds, current pose, saved camera bookmarks)
 * into plain numbers and builds the path from them, so the movement itself is
 * testable without a renderer and identical between two runs.
 *
 * Three kinds:
 * - **orbit** — circle around a centre at a fixed radius and height above it,
 *   `sweepDeg` (default 360) over the whole duration, optional ease in/out.
 * - **presets** — an ordered list of poses; hold each one, then move to the
 *   next over its transition time (position and target eased together).
 * - **fixed** — one pose for the whole video.
 *
 * Axis convention: Y up (Three.js). Orbit azimuth 0° puts the camera on +Z
 * of the centre (the `front` view of `web_camera_view`), +90° on +X.
 */

import { Box3, Vector3 } from 'three';

/** One camera pose: position, look-at target and optional vertical fov (deg). */
export interface CameraPathPose {
  position: Vector3;
  target: Vector3;
  /** Perspective vertical fov in degrees; null keeps the camera's own. */
  fov: number | null;
}

/** A resolved, evaluable camera path. */
export interface CameraPath {
  readonly kind: 'orbit' | 'presets' | 'fixed';
  /** Write the pose at presentation time `t` (s) into `out` and return it. */
  pose(t: number, out: CameraPathPose): CameraPathPose;
  /**
   * Presentation times (s, ascending) of the CUTS of the path (plan-554 F3b): only a boundary
   * whose transition time is ZERO jumps; a boundary with a positive transition is continuous.
   * The motion blur holds the post-cut pose for a shutter that contains a cut.
   */
  cutTimes(): number[];
}

/**
 * The presentation time a motion-blur sub-time evaluates the camera path at (plan-554 F3b):
 * `frameTime + offset` (offset ≤ 0, inside the trailing shutter), clamped to the latest cut in
 * `(frameTime + offset, frameTime]` — a cut inside the shutter holds the post-cut pose — and to
 * 0 (frame 0 has no past).
 */
export function cameraSubTime(frameTime: number, offset: number, cuts: readonly number[]): number {
  let t = frameTime + offset;
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (c > t && c <= frameTime) t = c;
  }
  return t < 0 ? 0 : t;
}

/** Fresh pose object (allocate once, reuse per frame). */
export function createCameraPathPose(): CameraPathPose {
  return { position: new Vector3(), target: new Vector3(), fov: null };
}

export type CameraPathEasing = 'none' | 'inOut';

/** Cubic ease in/out — monotonic on [0, 1], 0 → 0, 1 → 1. */
export function easeInOut(u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function clamp01(u: number): number {
  return u <= 0 ? 0 : u >= 1 ? 1 : u;
}

// ─── Orbit ────────────────────────────────────────────────────────────────

export interface OrbitPathParams {
  center: Vector3;
  /** Horizontal distance from the centre (m). */
  radius: number;
  /** Camera height above the centre (m). */
  height: number;
  /** Azimuth at t = 0 in degrees (0 = +Z, 90 = +X). */
  startDeg: number;
  /** Total swept angle over `duration` in degrees (+ = counter-clockwise from above). */
  sweepDeg: number;
  /** Seconds the sweep takes (normally the encoded video duration). */
  duration: number;
  easing: CameraPathEasing;
  fov: number | null;
}

/** Orbit around `center` — position on a horizontal circle, always looking at the centre. */
export function createOrbitPath(p: OrbitPathParams): CameraPath {
  const center = p.center.clone();
  const dur = p.duration > 0 ? p.duration : 1;
  const start = (p.startDeg * Math.PI) / 180;
  const sweep = (p.sweepDeg * Math.PI) / 180;
  return {
    kind: 'orbit',
    pose(t, out) {
      const u = clamp01(t / dur);
      const e = p.easing === 'inOut' ? easeInOut(u) : u;
      const a = start + sweep * e;
      out.position.set(
        center.x + p.radius * Math.sin(a),
        center.y + p.height,
        center.z + p.radius * Math.cos(a),
      );
      out.target.copy(center);
      out.fov = p.fov;
      return out;
    },
    cutTimes: () => [],
  };
}

/** Azimuth (deg, orbit convention) of `position` around `center`. */
export function azimuthDeg(position: Vector3, center: Vector3): number {
  return (Math.atan2(position.x - center.x, position.z - center.z) * 180) / Math.PI;
}

/**
 * Distance at which a sphere of `radius` fills the view of a perspective
 * camera with vertical fov `fovDeg` and aspect `aspect` (the tighter of the
 * two axes wins), times `margin`.
 */
export function fitDistanceForSphere(radius: number, fovDeg: number, aspect: number, margin = 1.1): number {
  const vHalf = (fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * (aspect > 0 ? aspect : 1));
  const half = Math.min(vHalf, hHalf);
  const r = radius > 0 ? radius : 1;
  return (r / Math.sin(half)) * margin;
}

/** Bounding-sphere radius of a box (0 for an empty box). */
export function boxRadius(box: Box3): number {
  if (box.isEmpty()) return 0;
  return box.getSize(new Vector3()).length() / 2;
}

// ─── Presets ──────────────────────────────────────────────────────────────

/** One keyframe of a preset path. */
export interface PresetKeyframe {
  position: Vector3;
  target: Vector3;
  /** Seconds to move FROM the previous keyframe to this one (ignored for the first). */
  transition: number;
  /** Seconds to stay on this keyframe after arriving. */
  hold: number;
}

export interface PresetPathParams {
  keyframes: PresetKeyframe[];
  fov: number | null;
  /** Ease every transition in and out (default true). */
  easing?: CameraPathEasing;
}

/** Default transition (s) between two presets. */
export const DEFAULT_PRESET_TRANSITION = 3;
/** Default hold (s) on a preset. */
export const DEFAULT_PRESET_HOLD = 1;

/** Total time of a preset path (first hold + every transition + hold after it). */
export function presetPathDuration(keyframes: readonly PresetKeyframe[]): number {
  let total = 0;
  for (let i = 0; i < keyframes.length; i++) {
    if (i > 0) total += Math.max(0, keyframes[i].transition);
    total += Math.max(0, keyframes[i].hold);
  }
  return total;
}

/**
 * Hold keyframe 0, move to keyframe 1 over its transition, hold it, … After the
 * last hold the camera stays on the last keyframe.
 */
export function createPresetPath(p: PresetPathParams): CameraPath {
  if (p.keyframes.length === 0) throw new Error('A preset path needs at least one view');
  const frames = p.keyframes.map((k) => ({
    position: k.position.clone(),
    target: k.target.clone(),
    transition: Math.max(0, k.transition),
    hold: Math.max(0, k.hold),
  }));
  const ease = (p.easing ?? 'inOut') === 'inOut';
  // A keyframe reached with a zero transition is a cut at the end of the previous hold.
  const cuts: number[] = [];
  {
    let cursor = 0;
    for (let i = 0; i < frames.length; i++) {
      if (i > 0) {
        if (frames[i].transition === 0) cuts.push(cursor);
        cursor += frames[i].transition;
      }
      cursor += frames[i].hold;
    }
  }
  return {
    kind: 'presets',
    cutTimes: () => cuts.slice(),
    pose(t, out) {
      out.fov = p.fov;
      let cursor = 0;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (i > 0 && f.transition > 0) {
          if (t < cursor + f.transition) {
            const prev = frames[i - 1];
            const u = clamp01((t - cursor) / f.transition);
            const e = ease ? easeInOut(u) : u;
            out.position.lerpVectors(prev.position, f.position, e);
            out.target.lerpVectors(prev.target, f.target, e);
            return out;
          }
          cursor += f.transition;
        }
        if (t < cursor + f.hold || i === frames.length - 1) {
          out.position.copy(f.position);
          out.target.copy(f.target);
          return out;
        }
        cursor += f.hold;
      }
      return out;
    },
  };
}

// ─── Fixed ────────────────────────────────────────────────────────────────

/** One pose for the whole video. */
export function createFixedPath(position: Vector3, target: Vector3, fov: number | null = null): CameraPath {
  const pos = position.clone();
  const tgt = target.clone();
  return {
    kind: 'fixed',
    pose(_t, out) {
      out.position.copy(pos);
      out.target.copy(tgt);
      out.fov = fov;
      return out;
    },
    cutTimes: () => [],
  };
}
