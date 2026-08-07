// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-solution-utils.ts — Pure helpers for the interactive IK SOLUTION
 * selection (the "Lösung 2/6" stepper in the IK target quick-edit).
 *
 * A solver returns a full configuration set for one TCP pose (Pieper: 8 fixed
 * branches shoulder×elbow×wrist, Cobot: up to 24 converged seeds). The UI works
 * on the REACHABLE subset: `reachableSolutions` filters + dedupes it while
 * preserving the solver's branch order (Pieper branch identity stays stable
 * while dragging), and `closestSolutionIndex` locates the currently applied
 * configuration inside that subset with the same wrap-aware L2 metric the
 * closest-selection uses.
 */

import type { IKSolution } from './rv-ik-solver';

/** Angles closer than this per axis (deg) count as the same configuration. */
const DEDUPE_EPS_DEG = 0.05;

/** Wrap-aware absolute angle difference in degrees (0..180). */
function wrapDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Wrap-aware squared L2 distance between two 6-axis joint sets (deg²). */
export function solutionDistanceSq(a: readonly number[], b: readonly number[]): number {
  let err = 0;
  for (let i = 0; i < 6; i++) {
    const d = wrapDelta(a[i] ?? 0, b[i] ?? 0);
    err += d * d;
  }
  return err;
}

/**
 * The reachable configurations of a solve, deduped (wrap-aware, per-axis
 * epsilon) and in the solver's original order. Returns copies — safe to keep
 * across further solver calls that reuse output buffers.
 */
export function reachableSolutions(solutions: readonly IKSolution[]): number[][] {
  const out: number[][] = [];
  for (const s of solutions) {
    if (!s.reachable) continue;
    const dup = out.some((kept) => {
      for (let i = 0; i < 6; i++) {
        if (wrapDelta(kept[i] ?? 0, s.angles[i] ?? 0) > DEDUPE_EPS_DEG) return false;
      }
      return true;
    });
    if (!dup) out.push([...s.angles]);
  }
  return out;
}

/**
 * Index of the configuration closest to `reference` (wrap-aware L2), or -1
 * for an empty list. Mirrors ikSolverRegistry.selectClosest so the located
 * index always names the configuration that selection would apply.
 */
export function closestSolutionIndex(
  solutions: readonly (readonly number[])[],
  reference: readonly number[],
): number {
  let best = -1;
  let bestErr = Infinity;
  for (let i = 0; i < solutions.length; i++) {
    const err = solutionDistanceSq(solutions[i], reference);
    if (err < bestErr) { bestErr = err; best = i; }
  }
  return best;
}
