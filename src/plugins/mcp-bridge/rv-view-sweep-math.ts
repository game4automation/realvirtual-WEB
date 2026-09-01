// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-view-sweep-math — pure pose ring and note aggregation (plan-705 Phase 2).
 *
 * The maths behind `web_view_sweep`: where the 4..8 contact-sheet views sit
 * around a target, and how a list of per-ray hits becomes one readable note.
 * Pure by design — no viewer, no canvas, no WebGL — so the whole geometry and
 * ranking contract is provable in plain unit tests.
 *
 * The yaw convention is the one `web_camera_orbit` already uses
 * (`theta = atan2(offset.x, offset.z)`, + = counter-clockwise seen from above),
 * so an agent that reads a cell label and then orbits does not have to flip signs.
 */

import { Vector3 } from 'three';
import { MAX_PITCH_DEG, type CameraPose } from './rv-camera-fly-math';

const DEG = Math.PI / 180;

/** Contact sheets below 4 views leave sides blind, above 8 they stop paying for themselves. */
export const MIN_SWEEP_COUNT = 4;
export const MAX_SWEEP_COUNT = 8;

/** Default number of views — six covers a machine all round in ONE call (plan-705). */
export const DEFAULT_SWEEP_COUNT = 6;

/** Slight bird's eye by default: multi-view VLM work reads elevated views better (plan-705 §8.2). */
export const DEFAULT_SWEEP_PITCH_DEG = 20;

/** Default cap on the nodes reported per view. */
export const DEFAULT_TOP_N = 5;

/** Hard cap on `topN` — keeps the `extra` metadata away from the image byte budget. */
export const MAX_TOP_N = 10;

export interface SweepPose extends CameraPose {
  index: number;
  /** Absolute, 0..360, counter-clockwise from +Z. */
  yawDeg: number;
  pitchDeg: number;
  /** Cell caption, e.g. `#2  yaw 120°`. */
  label: string;
}

export interface SweepOptions {
  count?: number;
  pitchDeg?: number;
  yawStartDeg?: number;
}

export interface ViewNote {
  index: number;
  label: string;
  yawDeg: number;
  pitchDeg: number;
  /** MEASURED pose (getCameraState() after the settle), not the planned one — D-A14. */
  cameraPosition: [number, number, number];
  topNodes: Array<{ path: string; coverage: number }>;
  /** Share of rays that hit nothing (background), 0..1. */
  background: number;
  /** Number of rays fired — this is what makes `coverage` interpretable. */
  samples: number;
  /**
   * Distance measured ↔ planned pose in metres. Only set when it exceeds the
   * tolerance, so the normal case costs no tokens. A value here means somebody
   * moved the camera during the sweep (plan-705 D-A14).
   */
  poseDrift?: number;
}

const r3 = (n: number): number => +n.toFixed(3);
const r2 = (n: number): number => +n.toFixed(2);

const clampInt = (n: number | undefined, lo: number, hi: number, dflt: number): number => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), lo), hi);
};

/** `count` evenly spaced poses on one latitude circle around `center`. */
export function sweepPoses(
  center: Vector3,
  radius: number,
  opts: SweepOptions = {},
): SweepPose[] {
  const count = clampInt(opts.count, MIN_SWEEP_COUNT, MAX_SWEEP_COUNT, DEFAULT_SWEEP_COUNT);
  const rawPitch = typeof opts.pitchDeg === 'number' && Number.isFinite(opts.pitchDeg)
    ? opts.pitchDeg : DEFAULT_SWEEP_PITCH_DEG;
  const pitchDeg = Math.min(Math.max(rawPitch, -MAX_PITCH_DEG), MAX_PITCH_DEG);
  const start = typeof opts.yawStartDeg === 'number' && Number.isFinite(opts.yawStartDeg)
    ? opts.yawStartDeg : 0;
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1;

  const step = 360 / count;
  const poses: SweepPose[] = [];
  for (let i = 0; i < count; i++) {
    const yawDeg = ((start + i * step) % 360 + 360) % 360;
    const yaw = yawDeg * DEG;
    const pitch = pitchDeg * DEG;
    const position = new Vector3(
      center.x + r * Math.sin(yaw) * Math.cos(pitch),
      center.y + r * Math.sin(pitch),
      center.z + r * Math.cos(yaw) * Math.cos(pitch),
    );
    poses.push({
      index: i,
      yawDeg,
      pitchDeg,
      position,
      target: center.clone(),
      label: `#${i}  yaw ${Math.round(yawDeg)}°`,
    });
  }
  return poses;
}

/** Grid sample points as canvas fractions 0..1 — n×n, margin 1/(2n). */
export function sampleGrid(n: number): Array<[number, number]> {
  const size = Math.max(1, Math.round(n));
  const pts: Array<[number, number]> = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      pts.push([(col + 0.5) / size, (row + 0.5) / size]);
    }
  }
  return pts;
}

/**
 * Hit list → note. Pure: takes only `(path|null)[]`, the planned pose and
 * optionally the MEASURED camera position — no viewer, no canvas.
 *
 * Ranking is hit count descending, ties keeping first-seen order so the result
 * is deterministic. `measured` becomes `cameraPosition`; if it sits further than
 * `driftToleranceM` from the planned position, `poseDrift` is reported as well
 * (plan-705 D-A14) rather than quietly presenting a pose the frame does not show.
 */
export function summarizeViewHits(
  pose: SweepPose,
  hits: ReadonlyArray<string | null>,
  topN: number = DEFAULT_TOP_N,
  measured?: Vector3,
  driftToleranceM?: number,
): ViewNote {
  const samples = hits.length;
  const counts = new Map<string, number>();
  let misses = 0;
  for (const h of hits) {
    if (!h) { misses++; continue; }
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const cap = clampInt(topN, 1, MAX_TOP_N, DEFAULT_TOP_N);
  const topNodes = [...counts.entries()]
    .sort((a, b) => b[1] - a[1]) // Array.prototype.sort is stable → first-seen wins ties
    .slice(0, cap)
    .map(([path, n]) => ({ path, coverage: samples > 0 ? r2(n / samples) : 0 }));

  const pos = measured ?? pose.position;
  const note: ViewNote = {
    index: pose.index,
    label: pose.label,
    yawDeg: r2(pose.yawDeg),
    pitchDeg: r2(pose.pitchDeg),
    cameraPosition: [r3(pos.x), r3(pos.y), r3(pos.z)],
    topNodes,
    background: samples > 0 ? r2(misses / samples) : 0,
    samples,
  };
  if (measured) {
    const tol = typeof driftToleranceM === 'number' && driftToleranceM >= 0 ? driftToleranceM : 1e-3;
    const drift = measured.distanceTo(pose.position);
    if (drift > tol) note.poseDrift = r3(drift);
  }
  return note;
}
