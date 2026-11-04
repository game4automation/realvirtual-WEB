// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mjcf-problems.ts — the Problems vocabulary of the MJCF writer
 * (plan-673 Phase 3's open point, closed in Phase 4).
 *
 * ── Why this file is public while the writer is not ───────────────────────
 * `writeMjcf()` is a PURE function in the private tree: it returns the document
 * plus a list of findings and leaves the reporting to its caller, because only
 * the caller knows which document the findings belong to. This module is that
 * caller's vocabulary.
 *
 * It lives in the public core on purpose, and the reason is mechanical rather
 * than philosophical: `tests/problems-clear-per-load.node.test.ts` scans the
 * PUBLIC `src/` for every Problems code a module reports, and fails when one is
 * missing from `tests/helpers/problem-code-classification.ts` — or listed there
 * while no longer existing. Reporting these thirteen codes from the private
 * plugin would keep them out of that scan, i.e. out of the one test that proves
 * a code has a defined lifecycle. Twelve private codes already live that way
 * (`physics2d-fail-off` and friends); these do not, because a degraded physics
 * document is a statement about the OPEN DOCUMENT and the panel has to drop it
 * when that document goes.
 *
 * A code string is not intellectual property. The writer keeps its logic and
 * its numbers private and imports the strings from here, so there is exactly
 * one spelling of each.
 *
 * ── The retire class ──────────────────────────────────────────────────────
 * `clear-model`: {@link clearMjcfProblems} is called from
 * `RVViewer.clearModel()`, the step every load starts with. A re-export of the
 * same document therefore replaces its own findings instead of stacking them.
 */

import { reportProblem, clearProblem, clearProblemsOfCode } from '../hmi/problems-store';

/** A `MechanismBody` fell back to a coarser mass source than the authored one. */
export const MJCF_PROBLEM_MASS_DEGRADED = 'mjcf-mass-degraded';
/** A moving body has no mass at all — MuJoCo rejects it. */
export const MJCF_PROBLEM_NO_MASS = 'mjcf-body-no-mass';
/** A dynamic axis without a force limit cannot saturate, so it cannot refuse. */
export const MJCF_PROBLEM_NO_FORCE_LIMIT = 'mjcf-axis-no-force-limit';
/** A collision primitive with a zero or negative extent. */
export const MJCF_PROBLEM_SHAPE_DEGENERATE = 'mjcf-shape-degenerate';
/** A `KinematicJoint` whose body A is not an ancestor of body B. */
export const MJCF_PROBLEM_JOINT_UNPARENTED = 'mjcf-joint-unparented';
/** A joint type MuJoCo has no single-axis equivalent for (spherical, universal). */
export const MJCF_PROBLEM_JOINT_UNSUPPORTED = 'mjcf-joint-unsupported';
/** A non-uniformly scaled frame — MJCF has no scale. */
export const MJCF_PROBLEM_SCALED_FRAME = 'mjcf-scaled-frame';
/** A body that carries mass but no collision geometry. */
export const MJCF_PROBLEM_NO_GEOMETRY = 'mjcf-body-no-geometry';
/** A mesh geom MuJoCo will silently convexify — the central design trap. */
export const MJCF_PROBLEM_MESH_CONVEXIFIED = 'mjcf-mesh-convexified';
/** A geom without a `ContactProfile`, i.e. without a declared friction. */
export const MJCF_PROBLEM_NO_PROFILE = 'mjcf-geom-no-profile';
/** The role declares a priority the node does not carry — a pad that is not a pad. */
export const MJCF_PROBLEM_PRIORITY_NOT_APPLIED = 'mjcf-profile-priority-not-applied';
/** A `Drive_Gear` whose master could not be resolved. */
export const MJCF_PROBLEM_GEAR_UNRESOLVED = 'mjcf-gear-unresolved';
/** The region exists but is switched off — nothing was written. */
export const MJCF_PROBLEM_REGION_DISABLED = 'mjcf-region-disabled';

/**
 * Every code the writer can raise, in one frozen list — the SSOT the private
 * writer imports and the classification test enumerates.
 */
export const MJCF_PROBLEM_CODES = Object.freeze([
  MJCF_PROBLEM_MASS_DEGRADED,
  MJCF_PROBLEM_NO_MASS,
  MJCF_PROBLEM_NO_FORCE_LIMIT,
  MJCF_PROBLEM_SHAPE_DEGENERATE,
  MJCF_PROBLEM_JOINT_UNPARENTED,
  MJCF_PROBLEM_JOINT_UNSUPPORTED,
  MJCF_PROBLEM_SCALED_FRAME,
  MJCF_PROBLEM_NO_GEOMETRY,
  MJCF_PROBLEM_MESH_CONVEXIFIED,
  MJCF_PROBLEM_NO_PROFILE,
  MJCF_PROBLEM_PRIORITY_NOT_APPLIED,
  MJCF_PROBLEM_GEAR_UNRESOLVED,
  MJCF_PROBLEM_REGION_DISABLED,
] as const);

/** The shape `writeMjcf()` returns — repeated here so this file imports nothing private. */
export interface MjcfProblemLike {
  readonly code: string;
  /** Node path from the region root (`''` = the region node itself). */
  readonly node: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

/** Ids this module raised, so a re-report of one document clears only its own. */
const raisedByDocument = new Map<string, Set<string>>();

function problemId(documentKey: string, p: MjcfProblemLike): string {
  return `${p.code}:${documentKey}:${p.node}`;
}

/**
 * Publish the findings of ONE physics document.
 *
 * `documentKey` identifies the region the document was written for — its node
 * path is the natural choice. Two regions in one model therefore keep their
 * findings apart, and re-writing a region replaces exactly its own.
 *
 * `nodePathPrefix` turns the writer's region-relative node paths into paths the
 * panel can select (the writer reports `Robot/A2`, the panel needs
 * `Cell/Region/Robot/A2`). Empty for a region at the scene root.
 *
 * Severity is the writer's: it already distinguishes a refusal from a
 * degradation, and re-deciding that here would be a second opinion about
 * numbers only the writer has seen.
 */
export function reportMjcfProblems(
  documentKey: string,
  problems: readonly MjcfProblemLike[],
  nodePathPrefix = '',
): void {
  clearMjcfProblemsOf(documentKey);
  if (problems.length === 0) return;
  const raised = new Set<string>();
  for (const p of problems) {
    const id = problemId(documentKey, p);
    // A document can raise the same code on several nodes, and the id carries
    // the node — but the SAME code on the SAME node twice (a mass degraded on
    // two counts, say) must not double the panel row.
    if (raised.has(id)) continue;
    raised.add(id);
    const nodePath = p.node
      ? (nodePathPrefix ? `${nodePathPrefix}/${p.node}` : p.node)
      : (nodePathPrefix || documentKey);
    reportProblem({
      id,
      code: p.code,
      severity: p.severity,
      title: titleOf(p),
      detail: p.message,
      nodePath,
    });
  }
  raisedByDocument.set(documentKey, raised);
}

/** Drop the findings of one document (it is being rewritten or removed). */
export function clearMjcfProblemsOf(documentKey: string): void {
  const raised = raisedByDocument.get(documentKey);
  if (!raised) return;
  for (const id of raised) clearProblem(id);
  raisedByDocument.delete(documentKey);
}

/** Drop every MJCF finding of the model (model switch) — the `clear-model` half. */
export function clearMjcfProblems(): void {
  raisedByDocument.clear();
  for (const code of MJCF_PROBLEM_CODES) clearProblemsOfCode(code);
}

/**
 * One headline per code.
 *
 * The writer's `message` always carries the node, the source AND the number, so
 * the title only has to say WHAT happened — never a second, shorter version of
 * the same sentence.
 */
function titleOf(p: MjcfProblemLike): string {
  const where = p.node || 'the physics region';
  switch (p.code) {
    case MJCF_PROBLEM_MASS_DEGRADED: return `Mass of ${where} came from a coarser source than authored`;
    case MJCF_PROBLEM_NO_MASS: return `${where} moves but has no mass`;
    case MJCF_PROBLEM_NO_FORCE_LIMIT: return `Axis ${where} has no force limit`;
    case MJCF_PROBLEM_SHAPE_DEGENERATE: return `Collision primitive on ${where} is degenerate`;
    case MJCF_PROBLEM_JOINT_UNPARENTED: return `Joint on ${where} connects unparented bodies`;
    case MJCF_PROBLEM_JOINT_UNSUPPORTED: return `Joint type on ${where} has no MJCF equivalent`;
    case MJCF_PROBLEM_SCALED_FRAME: return `${where} carries a scale MJCF cannot express`;
    case MJCF_PROBLEM_NO_GEOMETRY: return `${where} has mass but no collision geometry`;
    case MJCF_PROBLEM_MESH_CONVEXIFIED: return `Collision mesh on ${where} will be convexified`;
    case MJCF_PROBLEM_NO_PROFILE: return `${where} has no declared contact profile`;
    case MJCF_PROBLEM_PRIORITY_NOT_APPLIED: return `Contact role on ${where} needs a priority to take effect`;
    case MJCF_PROBLEM_GEAR_UNRESOLVED: return `Gear coupling on ${where} could not be resolved`;
    case MJCF_PROBLEM_REGION_DISABLED: return 'Physics region is switched off';
    default: return `Physics document finding on ${where}`;
  }
}
