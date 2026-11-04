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
 *
 * `solutionsWithinLimits` is the third filter and the newest (plan-772 Phase 5):
 * the analytic solvers do not know the rig's joint limits, so "reachable" means
 * *the geometry closes*, not *the robot may stand there*. A configuration whose
 * drive limits refuse it in every 360° representation is therefore dropped
 * BEFORE a selection happens — see the module header of `rv-axis-angle-utils.ts`
 * for why the representation search is shared with the replay's unwrap.
 */

import type { IKSolution } from './rv-ik-solver';
import { firstLimitViolation, type AxisAngleDrive } from './rv-axis-angle-utils';

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

/** What {@link solutionsWithinLimits} kept, and what it refused. */
export interface LimitFilteredSolutions {
  /** The admissible configurations, in the input order (same array objects). */
  kept: number[][];
  /** How many configurations were dropped because a joint limit refused them. */
  rejected: number;
  /** Axis indices (0-based) that caused a rejection, ascending, deduped. */
  rejectedAxes: number[];
}

/**
 * Drop the configurations the rig's joint limits refuse.
 *
 * "Reachable" is the solver's word for *the geometry closes*. The analytic
 * solvers are given no limits at all (`numHaltonSeeds` is 0 by default, so the
 * limits only ever shaped the Halton scatter), so a branch that puts A3 at
 * +120° on a rig whose A3 ends at +65° comes back reachable and, until this
 * filter, could be SELECTED while an admissible branch sat next to it.
 *
 * Admissible means *some* 360° representation fits — the same search the replay
 * uses when it unwraps a stored `AxisPos`, so a kept configuration is one the
 * drive can really be commanded to.
 *
 * ## What this does NOT fix
 *
 * Rejecting is not searching. If EVERY reachable configuration violates a
 * limit, the pose stays "unreachable" even though a limit-aware solver might
 * have found an admissible configuration for the same TCP pose. Closing that
 * would mean handing the limits to the solver (an ABI change in the Rust
 * crate), which plan-772 deliberately does not do — Phase 5 is TypeScript only.
 */
export function solutionsWithinLimits(
  solutions: readonly number[][],
  drives: readonly AxisAngleDrive[],
  reference?: readonly number[],
): LimitFilteredSolutions {
  const kept: number[][] = [];
  const axes = new Set<number>();
  for (const s of solutions) {
    const bad = firstLimitViolation(s, drives, reference);
    if (bad < 0) kept.push(s);
    else axes.add(bad);
  }
  return {
    kept,
    rejected: solutions.length - kept.length,
    rejectedAxes: [...axes].sort((a, b) => a - b),
  };
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
