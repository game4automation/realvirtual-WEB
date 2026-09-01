// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-chain-path.ts — the curve evaluator behind the `Chain` component (plan-733).
 *
 * Unity is the single source of truth for BOTH the geometry and the frames of a
 * chain spline. The exporter bakes `ChainUnitySpline` into an arc-length
 * equidistant sample table — position, tangent and up vector per sample — and
 * this module does nothing but interpolate it. No spline mathematics is
 * duplicated in TypeScript, so there is no Unity/Web parity risk in the curve
 * itself and no parallel-transport / Frenet-flip problem: the up vectors come
 * from `SplineContainer.EvaluateUpVector` in Unity.
 *
 * ## Contract of the baked table (rv_extras `Chain.Spline`)
 *
 * - `samples`: flat `[px,py,pz, tx,ty,tz, ux,uy,uz] * N`, arc-length equidistant,
 *   sample `i` at arc-length fraction `i / (N - 1)`.
 * - **Frame: the Chain node's LOCAL space.** Unity evaluates the spline in world
 *   space; the exporter converts into the chain node's local frame. Chain
 *   elements are parented to the chain node, so a pose is written as a plain
 *   local transform and the whole chain moves with its parent for free.
 * - **Units: metres** (glTF convention), while every Chain/ChainElement config
 *   field stays in millimetres exactly as in Unity. The single conversion point
 *   is `RVChain` (`lengthMm = table.lengthM * 1000`); nothing here multiplies by
 *   1000.
 * - `closed: true` means the curve loops; the exporter repeats the start sample
 *   as the LAST entry so that fraction 1 and fraction 0 evaluate identically.
 *   Nothing in this module depends on that beyond documentation — the wrap is a
 *   modulo on the POSITION, never on the sample index.
 *
 * ## Wrap semantics — Unity parity, deliberately not "nicer"
 *
 * `ChainElement.SetPosition()` has NO `closed` branch: it wraps by modulo on
 * open and closed splines alike, and it converts a negative position through a
 * sign special case rather than the usual `((x % L) + L) % L`. Both are
 * replicated verbatim in {@link relativePosition}; see its doc comment.
 */

import { Quaternion, Vector3 } from 'three';
import { lookRotation } from './rv-pose-align';

/** Floats per baked sample: position(3) + tangent(3) + up(3). */
export const CHAIN_SAMPLE_STRIDE = 9;

/** Wire shape of the `Spline` block inside the `Chain` rv_extras. */
export interface ChainSplineExtras {
  /** The curve loops (last sample repeats the first). */
  closed?: boolean;
  /** True arc length in METRES. */
  length?: number;
  /** Flat `[px,py,pz, tx,ty,tz, ux,uy,uz] * N`, arc-length equidistant. */
  samples?: readonly number[] | Float32Array;
}

/**
 * Unity's `ChainElement.SetPosition()` position→fraction conversion, replicated
 * exactly:
 *
 * ```csharp
 * if (Mathf.Abs(Position) > relevantLength) Position = Position % relevantLength;
 * RelativePosition = Position < 0 ? (1 - Mathf.Abs(Position) / relevantLength)
 *                                 : (Position / relevantLength);
 * ```
 *
 * Two properties that look like bugs but are the contract:
 * 1. **No `closed` check.** An open spline wraps just like a closed one — an
 *    element leaving the end reappears at the start. Clamping instead would
 *    stack every element on the last sample.
 * 2. **The negative branch is `1 - |p|/L`, not `(p % L + L) % L`.** For
 *    `|p| <= L` the two agree; the modulo above only runs when `|p| > L`, so
 *    they agree everywhere. Keeping Unity's exact shape means a future change on
 *    either side is a visible diff rather than a silent drift.
 *
 * Returns a fraction in `[0, 1]`. Degenerate `relevantLength` (0, negative, NaN)
 * yields `0` instead of NaN/Infinity (F5: inert, never a crash).
 */
export function relativePosition(position: number, relevantLength: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(relevantLength) || relevantLength <= 0) return 0;
  let p = position;
  // JS `%` keeps the sign of the dividend, exactly like C# `%`.
  if (Math.abs(p) > relevantLength) p = p % relevantLength;
  const rel = p < 0 ? (1 - Math.abs(p) / relevantLength) : (p / relevantLength);
  // Float safety only — the algebra above is already inside [0, 1].
  return rel < 0 ? 0 : (rel > 1 ? 1 : rel);
}

/**
 * Unity's `ChainOrientation.Vertical` tangent flip, verbatim from
 * `ChainElement.SetPosition()` / `UpdateKinematicTransformsJob.Execute()`:
 *
 * ```csharp
 * if (tangent.z < 0 || (tangent.z == 0 && tangent.x > 0)) align = -align;
 * ```
 *
 * **The condition below is that test transcribed into glTF space, not copied.**
 * The exporter (`GLBComponentSerializer.ToGltf`) converts Unity's left-handed
 * frame to glTF's right-handed one by negating X on positions, tangents and up
 * vectors — `diag(-1, 1, 1)`. The tangent this function receives is therefore
 * already mirrored: `gltf.z == unity.z`, but `gltf.x == -unity.x`. Substituting
 * `unity.x = -gltf.x` into Unity's `tangent.x > 0` yields `gltf.x < 0`, while the
 * `z` half is unaffected. Copying Unity's literal `x > 0` would agree everywhere
 * except on exactly the case the second half exists for — a horizontal tangent
 * (`z == 0`) on a vertical chain — where it would flip the wrong side.
 *
 * Mutates `up` in place and returns it. Known limitation (documented in
 * `chain.md` on the Unity side): the heuristic assumes the classic 4-anchor
 * vertical loop and can pick the wrong side on free-form vertical splines. It is
 * taken over 1:1 rather than "improved" — Unity parity beats elegance here.
 */
export function applyVerticalFlip(tangent: Vector3, up: Vector3): Vector3 {
  // Unity: `tangent.z < 0 || (tangent.z == 0 && tangent.x > 0)` on UNITY-space
  // tangents. Here the X axis is export-negated, hence `x < 0`.
  if (tangent.z < 0 || (tangent.z === 0 && tangent.x < 0)) up.negate();
  return up;
}

// ── Pre-allocated scratch (no allocation in the per-tick pose path) ──
const _p0 = new Vector3();
const _p1 = new Vector3();
const _t0 = new Vector3();
const _t1 = new Vector3();
const _u0 = new Vector3();
const _u1 = new Vector3();
const _tan = new Vector3();
const _up = new Vector3();

/**
 * An immutable, arc-length equidistant sample table with O(1) lookup.
 *
 * Built via {@link ChainPathTable.from}, which returns `null` for anything
 * degenerate (missing block, fewer than two samples, non-finite length) so the
 * caller can go inert with a warning instead of producing NaN poses.
 */
export class ChainPathTable {
  /** Number of samples (>= 2 by construction). */
  readonly count: number;
  /** True arc length in METRES (as exported). */
  readonly lengthM: number;
  /** Whether the curve loops. Informational — the wrap is on the position. */
  readonly closed: boolean;

  private readonly _pos: Float32Array;
  private readonly _tan: Float32Array;
  private readonly _up: Float32Array;

  private constructor(pos: Float32Array, tan: Float32Array, up: Float32Array, lengthM: number, closed: boolean) {
    this._pos = pos;
    this._tan = tan;
    this._up = up;
    this.count = pos.length / 3;
    this.lengthM = lengthM;
    this.closed = closed;
  }

  /**
   * Parse the `Spline` block of the `Chain` rv_extras. Defensive by design:
   * anything that is not a usable table returns `null` (F5).
   */
  static from(extras: unknown): ChainPathTable | null {
    if (!extras || typeof extras !== 'object') return null;
    const spec = extras as ChainSplineExtras;
    const raw = spec.samples;
    if (!raw || typeof (raw as { length?: number }).length !== 'number') return null;
    const n = Math.floor(raw.length / CHAIN_SAMPLE_STRIDE);
    if (n < 2) return null;

    const pos = new Float32Array(n * 3);
    const tan = new Float32Array(n * 3);
    const up = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const s = i * CHAIN_SAMPLE_STRIDE;
      for (let k = 0; k < 3; k++) {
        pos[i * 3 + k] = Number(raw[s + k]) || 0;
        tan[i * 3 + k] = Number(raw[s + 3 + k]) || 0;
        up[i * 3 + k] = Number(raw[s + 6 + k]) || 0;
      }
    }

    const declared = Number(spec.length);
    // A missing/degenerate `length` is not fatal: the fraction-based sampling
    // never reads it. It is only the mm scale of the chain, so fall back to the
    // polyline length of the baked samples rather than refusing the table.
    let lengthM = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (lengthM === 0) {
      for (let i = 1; i < n; i++) {
        const dx = pos[i * 3] - pos[(i - 1) * 3];
        const dy = pos[i * 3 + 1] - pos[(i - 1) * 3 + 1];
        const dz = pos[i * 3 + 2] - pos[(i - 1) * 3 + 2];
        lengthM += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }

    return new ChainPathTable(pos, tan, up, lengthM, spec.closed === true);
  }

  /** Read sample `i` (clamped) into the three out-vectors. */
  private _read(i: number, p: Vector3, t: Vector3, u: Vector3): void {
    const j = (i < 0 ? 0 : (i > this.count - 1 ? this.count - 1 : i)) * 3;
    p.set(this._pos[j], this._pos[j + 1], this._pos[j + 2]);
    t.set(this._tan[j], this._tan[j + 1], this._tan[j + 2]);
    u.set(this._up[j], this._up[j + 1], this._up[j + 2]);
  }

  /**
   * Interpolate the table at an arc-length FRACTION in `[0, 1]`. Position, tangent
   * and up are linearly interpolated between the two neighbouring samples; the
   * direction vectors are re-normalised afterwards (a lerp of two unit vectors is
   * not a unit vector). Allocation-free — writes into the caller's vectors.
   */
  sampleAt(fraction: number, outPos: Vector3, outTangent: Vector3, outUp: Vector3): void {
    const f = !Number.isFinite(fraction) ? 0 : (fraction < 0 ? 0 : (fraction > 1 ? 1 : fraction));
    const fi = f * (this.count - 1);
    const i0 = Math.min(Math.floor(fi), this.count - 1);
    const i1 = Math.min(i0 + 1, this.count - 1);
    const t = fi - i0;

    this._read(i0, _p0, _t0, _u0);
    this._read(i1, _p1, _t1, _u1);

    outPos.copy(_p0).lerp(_p1, t);
    outTangent.copy(_t0).lerp(_t1, t);
    outUp.copy(_u0).lerp(_u1, t);
    if (outTangent.lengthSq() > 1e-12) outTangent.normalize();
    if (outUp.lengthSq() > 1e-12) outUp.normalize();
  }

  /** Interpolate at an arc-length DISTANCE in metres (see {@link sampleAt}). */
  sampleAtDistance(distanceM: number, outPos: Vector3, outTangent: Vector3, outUp: Vector3): void {
    this.sampleAt(this.lengthM > 0 ? distanceM / this.lengthM : 0, outPos, outTangent, outUp);
  }

  /**
   * The full Unity pose for a chain element: `position` (mm, already including
   * drive position, start offset and element offset) mapped through
   * {@link relativePosition} over `relevantLengthMm`, sampled on the table, and
   * turned into `Quaternion.LookRotation(tangent, up)`.
   *
   * `relevantLengthMm` is `ScaledOnFixedLength ? FixedLength : Length` — Unity
   * scales the FRACTION by the fixed length while the sample table stays tied to
   * the real arc length, so a `FixedLength` below the real length makes the chain
   * cycle faster over the same geometry. That is Unity's actual behaviour and is
   * reproduced rather than "corrected".
   *
   * When `vertical` is true the Unity flip of {@link applyVerticalFlip} is applied
   * to the up vector before building the rotation. Allocation-free.
   */
  poseAt(
    position: number,
    relevantLengthMm: number,
    vertical: boolean,
    outPos: Vector3,
    outQuat: Quaternion,
  ): void {
    this.sampleAt(relativePosition(position, relevantLengthMm), outPos, _tan, _up);
    if (vertical) applyVerticalFlip(_tan, _up);
    lookRotation(_tan, _up, outQuat);
  }
}
