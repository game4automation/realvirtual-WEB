// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-camera-presets-math — named view directions, as pure geometry (plan-713 F9).
 *
 * The whole of a preset is a DIRECTION and an UP vector. Where the camera ends
 * up along that direction is a fit, and the fit is not computed here: §2.5 takes
 * the D-A5 approach from plan-705 — call `fitToNodes` once, then read the pose
 * back with `getCameraState` — rather than carrying a second copy of the
 * viewer's framing formula that would drift from it silently.
 *
 * So this module answers "which way am I looking, and from how far in the
 * ABSENCE of a fit", and the tool overrides the distance with the measured one.
 * That split is what makes the interesting part testable without a renderer.
 *
 * ## Axis convention
 *
 * Y is up (Three.js / glTF). `top` therefore looks along −Y, `front` along −Z
 * (the camera sits at +Z, which is what "front" means for an imported CAD
 * assembly in this codebase), and `iso` is the three-quarter view the view cube
 * calls Iso. `home` is `iso` — an alias rather than a fourth diagonal, because
 * two nearly-identical default views is a thing users notice and cannot explain.
 */

import { Box3, Vector3 } from 'three';

/** Every preset `web_camera_view` accepts. */
export const CAMERA_PRESETS = [
  'iso', 'top', 'front', 'back', 'left', 'right', 'home',
] as const;

export type CameraPreset = (typeof CAMERA_PRESETS)[number];

/** True when `raw` names a preset. Narrow before use — the tool reports the list. */
export function isCameraPreset(raw: string): raw is CameraPreset {
  return (CAMERA_PRESETS as readonly string[]).includes(raw);
}

/**
 * Unit direction FROM the target TO the camera, per preset.
 *
 * Stated as the eye-offset rather than the view direction because that is the
 * form the caller needs: `position = target + dir * distance`. The inverse
 * spelling reads the same and is wrong half the time.
 */
export function presetDirection(preset: CameraPreset): Vector3 {
  switch (preset) {
    case 'top':   return new Vector3(0, 1, 0);
    case 'front': return new Vector3(0, 0, 1);
    case 'back':  return new Vector3(0, 0, -1);
    case 'left':  return new Vector3(-1, 0, 0);
    case 'right': return new Vector3(1, 0, 0);
    case 'iso':
    case 'home':
    default:
      // The view cube's Iso: equal parts front, right and above.
      return new Vector3(1, 1, 1).normalize();
  }
}

/**
 * The up vector a preset needs.
 *
 * Only `top` differs, and it has to: looking straight down −Y with up = +Y is
 * degenerate, and Three.js resolves it by producing an arbitrary roll. −Z puts
 * "north" at the top of the frame, which is what a plan view means.
 */
export function presetUp(preset: CameraPreset): Vector3 {
  return preset === 'top' ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
}

export interface PresetPose {
  position: Vector3;
  target: Vector3;
  /** Distance used — replaced by the measured fit distance where one exists. */
  distance: number;
  up: Vector3;
}

/**
 * A provisional pose for `preset` around `box`.
 *
 * The distance is a bounding-sphere fallback for the case where no fit can be
 * measured (an empty scene, a headless test). It is deliberately generous:
 * a preset that lands INSIDE the geometry is useless, whereas one that is a
 * little too far away is still the right view.
 *
 * An empty box yields a unit-radius pose about the origin rather than NaN —
 * `Box3.getBoundingSphere` on an empty box produces an infinite centre, and a
 * camera at infinity is a black frame with no error attached.
 */
export function presetPose(preset: CameraPreset, box: Box3): PresetPose {
  const empty = box.isEmpty();
  const target = empty ? new Vector3(0, 0, 0) : box.getCenter(new Vector3());
  const size = empty ? new Vector3(1, 1, 1) : box.getSize(new Vector3());
  const radius = Math.max(size.length() * 0.5, 1e-3);
  // 2.5x the bounding radius clears the widest diagonal at a 45° vertical FOV
  // with margin on every preset, including the axis-aligned ones where the
  // silhouette is at its widest.
  const distance = radius * 2.5;
  const dir = presetDirection(preset);
  return {
    position: target.clone().addScaledVector(dir, distance),
    target,
    distance,
    up: presetUp(preset),
  };
}

/**
 * Re-place a measured fit onto a preset's direction.
 *
 * The D-A5 step: `fitToNodes` produced a correct DISTANCE for these bounds in
 * the viewer's own projection and aspect, and this keeps that number while
 * swapping the direction for the preset's. The result is a preset view framed
 * exactly as tightly as the viewer's own Focus would frame it — with no second
 * fit formula anywhere.
 */
export function applyMeasuredDistance(
  pose: PresetPose,
  measured: { position: Vector3; target: Vector3 },
): PresetPose {
  const distance = measured.position.distanceTo(measured.target);
  if (!Number.isFinite(distance) || distance <= 1e-6) return pose;
  const dir = pose.position.clone().sub(pose.target);
  if (dir.lengthSq() <= 1e-12) return pose;
  dir.normalize();
  return {
    ...pose,
    distance,
    // The measured TARGET wins too: `fitToNodes` centres on what it framed,
    // which for a multi-node selection is not the same point as the AABB
    // centre this module started from.
    target: measured.target.clone(),
    position: measured.target.clone().addScaledVector(dir, distance),
  };
}
