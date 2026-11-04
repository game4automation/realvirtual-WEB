// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-628 §9.1 / §9.1b — block geometry, tangent-true alignment, ids, rigid motion (pure). */

import { describe, it, expect } from 'vitest';
import {
  alignToPort, applyRigidXZ, blockSpecs, blockTemplate, coalesceSpecs, cutSpecs, directionOf,
  nextFreeId, sameGeometry, specEnds, type RigidXZ,
} from '../../src/core/engine/rv-path-blocks';
import { specListLength, type Vec3Tuple } from '../../src/core/engine/rv-path-edit';
import { parsePathExtras, type PathSegmentSpec } from '../../src/core/engine/rv-path';

const dist = (a: Vec3Tuple, b: Vec3Tuple): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function angleDeg(a: Vec3Tuple, b: Vec3Tuple): number {
  const c = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return (Math.atan2(c, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180) / Math.PI;
}
function sample(specs: PathSegmentSpec[], n = 64): Vec3Tuple[] {
  const p = parsePathExtras({ segments: specs }, 'x')!;
  const out: Vec3Tuple[] = [];
  for (let i = 0; i <= n; i++) { const v = p.getAbsPosition((p.length * i) / n); out.push([v.x, v.y, v.z]); }
  return out;
}

describe('path blocks geometry', () => {
  it('curve 90 left continues the port tangent and ends rotated by 90° to the LEFT (−Z for +X)', () => {
    const port = { position: [2, 0, 0] as Vec3Tuple, tangent: [1, 0, 0] as Vec3Tuple };
    const specs = alignToPort(blockSpecs({ kind: 'curve', radiusM: 1.5, degrees: 90, side: 'left' }), port);
    const e = specEnds(specs)!;
    expect(dist(e.start.position, port.position)).toBeLessThan(1e-9);
    expect(angleDeg(e.start.tangent, port.tangent)).toBeLessThan(1e-6);
    expect(angleDeg(e.end.tangent, port.tangent)).toBeCloseTo(90, 6);
    // left of +X is −Z (up × forward)
    expect(e.end.tangent[2]).toBeCloseTo(-1, 9);
    expect(e.end.position[0]).toBeCloseTo(3.5, 9);
    expect(e.end.position[2]).toBeCloseTo(-1.5, 9);
  });

  it('curve right mirrors to +Z', () => {
    const e = specEnds(blockSpecs({ kind: 'curve', side: 'right' }))!;
    expect(e.end.tangent[2]).toBeCloseTo(1, 9);
  });

  it('aligns to a 30° port exactly (no cardinal snapping, B8)', () => {
    const port = { position: [1, 0.5, 2] as Vec3Tuple, tangent: directionOf(30) };
    for (const spec of [{ kind: 'straight' as const }, { kind: 'curve' as const, degrees: 45, side: 'right' as const }]) {
      const e = specEnds(alignToPort(blockSpecs(spec), port))!;
      expect(dist(e.start.position, port.position)).toBeLessThan(1e-9);
      expect(angleDeg(e.start.tangent, port.tangent)).toBeLessThan(1e-6);
    }
  });

  it('lengths follow the parameters; stub depth = arcR + straight = 3.0 m (PalletYard)', () => {
    expect(specListLength(blockSpecs({ kind: 'straight' }))).toBeCloseTo(2, 12);
    expect(specListLength(blockSpecs({ kind: 'curve', radiusM: 1.5, degrees: 90 }))).toBeCloseTo(1.5 * Math.PI / 2, 12);
    const [stub, mouth] = blockTemplate({ kind: 'stub', side: 'left' });
    const s0 = specEnds(stub.specs)!.start;
    const m1 = specEnds(mouth.specs)!.end;
    expect(m1.position).toEqual([expect.closeTo(0, 9), 0, expect.closeTo(0, 9)]);
    expect(m1.tangent[0]).toBeCloseTo(1, 9);
    expect(Math.abs(s0.position[2])).toBeCloseTo(3.0, 9);
    expect(specEnds(stub.specs)!.end.position).toEqual(specEnds(mouth.specs)!.start.position);
  });

  it('id generator picks the smallest free PN_S<n> over network ids AND node names (P4)', () => {
    expect(nextFreeId('PN_S', new Set(['PN_S1', 'PN_S3']))).toBe('PN_S2');
    expect(nextFreeId('PN_S', new Set(['PN_S1', 'PN_S2']))).toBe('PN_S3');
  });

  it('cut + coalesce restore a line and an arc exactly', () => {
    const line: PathSegmentSpec[] = [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }];
    const parts = cutSpecs(line, [3, 5, 5.6])!;
    expect(parts.map(specListLength).map((x) => +x.toFixed(9))).toEqual([3, 2, 0.6, 4.4]);
    expect(coalesceSpecs(parts.flat())).toEqual(line);
    const arc = blockSpecs({ kind: 'curve', side: 'right' });
    const ap = cutSpecs(arc, [1])!;
    expect(sameGeometry(coalesceSpecs(ap.flat()), arc)).toBe(true);
    expect(coalesceSpecs(ap.flat())).toHaveLength(1);
    expect(cutSpecs(line, [0.0005])).toBeNull();
  });
});

describe('rigid XZ motion (§9.1b)', () => {
  const pieces: PathSegmentSpec[] = [
    { kind: 'line', from: [1, 0, 1], to: [3, 0, 1] },
    ...alignToPort(blockSpecs({ kind: 'curve', side: 'left' }), { position: [3, 0, 1], tangent: [1, 0, 0] }),
    ...alignToPort(blockSpecs({ kind: 'curve', side: 'right', degrees: 45 }), { position: [4.5, 0, -0.5], tangent: [0, 0, -1] }),
  ];
  for (const deg of [0, 15, 90, -135, 180]) {
    it(`sampled points move like the specs for ${deg}°`, () => {
      const m: RigidXZ = { dx: 0.7, dz: -2.1, dHeadingDeg: deg, pivot: [2, 1] };
      const before = sample(pieces);
      const after = sample(applyRigidXZ(pieces, m));
      const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
      for (let i = 0; i < before.length; i++) {
        const [x, y, z] = before[i];
        const rx = (x - 2) * c - (z - 1) * s + 2 + 0.7;
        const rz = (x - 2) * s + (z - 1) * c + 1 - 2.1;
        expect(dist(after[i], [rx, y, rz])).toBeLessThan(1e-9);
      }
      expect(specListLength(applyRigidXZ(pieces, m))).toBeCloseTo(specListLength(pieces), 12);
    });
  }
});
