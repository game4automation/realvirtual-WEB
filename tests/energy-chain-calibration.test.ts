// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.2 of plan-362 — auto-calibration against the REAL difficulties.
 *
 * The fixtures are generated, but they carry exactly the properties of the
 * reference chain that make the heuristic hard:
 *   - the geometry is split over TWO meshes with different local offsets
 *     (strands in one, bend in the other), merged into the bind frame the way
 *     the component does it;
 *   - vertex noise, so the transverse clusters are not exact;
 *   - degenerate variants: an ambiguous axis (cube) and a bend-only subtree
 *     whose cross-section never shows two strands.
 *
 * Everything is in metres (like a Unity GLB export) and calibrated with the
 * default `unitsToMm = 1000`, so the mm results are what a user would read.
 */

import { describe, expect, it } from 'vitest';
import { calibrate } from '../src/core/engine/rv-energy-chain-path';

interface ChainSpec {
  rMm: number;
  linkMm: number;
  lengthMm: number;
  noiseMm?: number;
  widthMm?: number;
}

/** Deterministic pseudo-noise so a red test is reproducible. */
function makeRng(seed = 12345): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Two source meshes, each in its OWN local frame with a translation offset —
 * mesh A holds both straight strands, mesh B the half-circle bend. The caller
 * composes them into the bind frame exactly as `RVEnergyChain` does when it
 * gathers the vertex cloud, which is what makes this fixture a real test of
 * the multi-mesh contract rather than of a single ideal cloud.
 */
function makeTwoMeshChain(spec: ChainSpec): Float32Array {
  const { rMm, linkMm, lengthMm } = spec;
  const noise = (spec.noiseMm ?? 0) / 1000;
  const width = (spec.widthMm ?? 42) / 1000;
  const R = rMm / 1000;
  const h = linkMm / 1000;
  const L = lengthMm / 1000;

  const strandLen = (L - Math.PI * R) / 2;   // rest pose: both strands equal
  const zStart = 0;
  const c = zStart + strandLen;              // bend center along +Z
  const rng = makeRng();
  const jitter = () => (noise > 0 ? (rng() * 2 - 1) * noise : 0);

  // Mesh A — strands, authored around its own origin, offset by `offsetA`.
  const offsetA: [number, number, number] = [0, 0.5, -0.25];
  const meshA: number[] = [];
  const zSteps = 60, ySteps = 5, xSteps = 3;
  for (const vBase of [-R, R]) {
    for (let zi = 0; zi <= zSteps; zi++) {
      const z = zStart + (strandLen * zi) / zSteps;
      for (let yi = 0; yi <= ySteps; yi++) {
        const y = vBase - h / 2 + (h * yi) / ySteps;
        for (let xi = 0; xi <= xSteps; xi++) {
          const x = -width / 2 + (width * xi) / xSteps;
          meshA.push(x - offsetA[0], y - offsetA[1], z - offsetA[2]);
        }
      }
    }
  }

  // Mesh B — the half-circle bend, in a DIFFERENT local frame.
  const offsetB: [number, number, number] = [0.01, -0.3, 1.75];
  const meshB: number[] = [];
  const tSteps = 40, rSteps = 5;
  for (let ti = 0; ti <= tSteps; ti++) {
    const theta = (Math.PI * ti) / tSteps;
    for (let ri = 0; ri <= rSteps; ri++) {
      const r = R - h / 2 + (h * ri) / rSteps;
      const z = c + r * Math.sin(theta);
      const y = -r * Math.cos(theta);
      for (let xi = 0; xi <= xSteps; xi++) {
        const x = -width / 2 + (width * xi) / xSteps;
        meshB.push(x - offsetB[0], y - offsetB[1], z - offsetB[2]);
      }
    }
  }

  // Compose into the bind frame (mesh-local + offset) and add vertex noise.
  const out = new Float32Array(meshA.length + meshB.length);
  let w = 0;
  for (let i = 0; i < meshA.length; i += 3) {
    out[w++] = meshA[i] + offsetA[0] + jitter();
    out[w++] = meshA[i + 1] + offsetA[1] + jitter();
    out[w++] = meshA[i + 2] + offsetA[2] + jitter();
  }
  for (let i = 0; i < meshB.length; i += 3) {
    out[w++] = meshB[i] + offsetB[0] + jitter();
    out[w++] = meshB[i + 1] + offsetB[1] + jitter();
    out[w++] = meshB[i + 2] + offsetB[2] + jitter();
  }
  return out;
}

/** Ambiguous drive axis — nothing to measure, must not be guessed. */
function makeCube(): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= 8; i++)
    for (let j = 0; j <= 8; j++)
      for (let k = 0; k <= 8; k++)
        pts.push(i * 0.02, j * 0.02, k * 0.02);
  return new Float32Array(pts);
}

/** Only the half-circle bend: the cross-section never shows two strands. */
function makeBendOnly(): Float32Array {
  const R = 0.055, h = 0.035, width = 0.042;
  const pts: number[] = [];
  for (let ti = 0; ti <= 40; ti++) {
    const theta = (Math.PI * ti) / 40;
    for (let ri = 0; ri <= 5; ri++) {
      const r = R - h / 2 + (h * ri) / 5;
      for (let xi = 0; xi <= 3; xi++) {
        pts.push(-width / 2 + (width * xi) / 3, -r * Math.cos(theta), r * Math.sin(theta));
      }
    }
  }
  return new Float32Array(pts);
}

describe('energy chain calibration', () => {
  it('recovers R, link height and L from a two-mesh chain with offsets and noise', () => {
    const cal = calibrate({
      points: makeTwoMeshChain({ rMm: 55, linkMm: 35, lengthMm: 815, noiseMm: 0.2 }),
    });
    expect(cal.status).toBe('ok');
    expect(cal.bendRadiusMm).toBeCloseTo(55, 0);
    expect(cal.linkHeightMm).toBeCloseTo(35, 0);
    expect(cal.chainLengthMm).toBeCloseTo(815, -1);   // 5 mm tolerance under noise
    expect(cal.axis).toBe('Z');
  });

  it('reproduces the reference-case AABB relations exactly without noise', () => {
    const cal = calibrate({ points: makeTwoMeshChain({ rMm: 55, linkMm: 35, lengthMm: 815 }) });
    expect(cal.status).toBe('ok');
    expect(cal.axisIndex).toBe(2);          // Z
    expect(cal.upIndex).toBe(1);            // Y
    expect(cal.bendDir).toBe(1);            // bend at the larger Z
    expect(cal.bendRadiusMm).toBeCloseTo(55, 3);
    expect(cal.linkHeightMm).toBeCloseTo(35, 3);
    expect(cal.chainLengthMm).toBeCloseTo(815, 2);
    // Both strands end at the same place in the rest pose: l1 == l2.
    expect(cal.lowEnd).toBeCloseTo(cal.highEnd, 6);
    expect((cal.bendCenter - cal.lowEnd) * 1000).toBeCloseTo((815 - Math.PI * 55) / 2, 1);
  });

  it('degrades instead of guessing on an ambiguous axis', () => {
    expect(calibrate({ points: makeCube() }).status).toBe('degraded-calibration');
  });

  it('degrades when the cross-section yields only one cluster', () => {
    expect(calibrate({ points: makeBendOnly() }).status).toBe('degraded-calibration');
  });

  it('degrades on an empty or near-empty cloud instead of throwing', () => {
    expect(calibrate({ points: new Float32Array(0) }).status).toBe('degraded-calibration');
    expect(calibrate({ points: new Float32Array([0, 0, 0, 1, 1, 1]) }).status)
      .toBe('degraded-calibration');
  });

  it('always reports a reason when it degrades', () => {
    for (const pts of [makeCube(), makeBendOnly(), new Float32Array(0)]) {
      const cal = calibrate({ points: pts });
      expect(cal.status).toBe('degraded-calibration');
      expect(typeof cal.reason).toBe('string');
      expect(cal.reason!.length).toBeGreaterThan(0);
    }
  });

  it('honours a forced axis instead of measuring one', () => {
    const cal = calibrate({
      points: makeTwoMeshChain({ rMm: 55, linkMm: 35, lengthMm: 815 }),
      axis: 'Z',
    });
    expect(cal.axis).toBe('Z');
    // A forced axis skips the ambiguity gate — a cube then calibrates as far as
    // the cross-section allows, and degrades there instead.
    expect(calibrate({ points: makeCube(), axis: 'X' }).status).toBe('degraded-calibration');
  });

  it('finds the same geometry for a chain whose bend sits at the smaller u', () => {
    // Mirror the whole cloud along Z: the bend now sits at the MIN end.
    const src = makeTwoMeshChain({ rMm: 55, linkMm: 35, lengthMm: 815 });
    const mirrored = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      mirrored[i] = src[i];
      mirrored[i + 1] = src[i + 1];
      mirrored[i + 2] = -src[i + 2];
    }
    const cal = calibrate({ points: mirrored });
    expect(cal.status).toBe('ok');
    expect(cal.bendDir).toBe(-1);
    expect(cal.bendRadiusMm).toBeCloseTo(55, 3);
    expect(cal.chainLengthMm).toBeCloseTo(815, 2);
  });
});
