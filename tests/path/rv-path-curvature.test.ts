// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-558 §9.2 — `RVPath.curvatureIntervals()` + cache invalidation by live edit. */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras, RVPathComponent } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
});

describe('RVPath.curvatureIntervals (plan-558 §9.2)', () => {
  it('a line reports one interval with radius ∞', () => {
    const p = parsePathExtras({ type: 'Path', id: 'L', segments: [{ kind: 'line', from: [0, 0, 0], to: [4, 0, 0] }] }, 'L')!;
    expect(p.curvatureIntervals()).toEqual([{ s0: 0, s1: 4, radiusM: Infinity }]);
  });

  it('an arc reports its radius over its arc length', () => {
    const p = parsePathExtras({ type: 'Path', id: 'A', segments: [{ kind: 'arc', center: [0, 0, 0], radius: 2.5, startAngle: 0, degrees: 90, plane: 'XZ' }] }, 'A')!;
    const iv = p.curvatureIntervals();
    expect(iv.length).toBe(1);
    expect(iv[0].radiusM).toBe(2.5);
    expect(iv[0].s1 - iv[0].s0).toBeCloseTo((Math.PI / 2) * 2.5, 12);
  });

  it('an S-curve (two arcs) reports two contiguous intervals with the same R; mixed paths stay contiguous', () => {
    const p = parsePathExtras({
      type: 'Path', id: 'S', segments: [
        { kind: 'line', from: [-1, 0, 0], to: [0, 0, 0] },
        { kind: 'arc', center: [0, 0, 2], radius: 2, startAngle: -90, degrees: 30, plane: 'XZ' },
        { kind: 'arc', center: [2, 0, -1.4641016], radius: 2, startAngle: 150, degrees: -30, plane: 'XZ' },
      ],
    }, 'S')!;
    const iv = p.curvatureIntervals();
    expect(iv.length).toBe(3);
    expect(iv[0].radiusM).toBe(Infinity);
    expect(iv[1].radiusM).toBe(2);
    expect(iv[2].radiusM).toBe(2);
    expect(iv[1].s0).toBeCloseTo(iv[0].s1, 12);
    expect(iv[2].s0).toBeCloseTo(iv[1].s1, 12);
    expect(iv[2].s1).toBeCloseTo(p.length, 12);
  });

  it('the result is cached per path object (same array on repeated calls)', () => {
    const p = parsePathExtras({ type: 'Path', id: 'L', segments: [{ kind: 'line', from: [0, 0, 0], to: [1, 0, 0] }] }, 'L')!;
    expect(p.curvatureIntervals()).toBe(p.curvatureIntervals());
  });

  it('a live edit (reapplyConfig) replaces the path: fresh geometry id, fresh curvature', () => {
    const node = new Object3D();
    node.name = 'Curve';
    node.userData.realvirtual = {
      Path: { segments: [{ kind: 'arc', center: [0, 0, 0], radius: 3, startAngle: 0, degrees: 90, plane: 'XZ' }] },
    };
    const comp = new RVPathComponent(node);
    comp.init({} as never);
    const before = comp.path!;
    expect(before.curvatureIntervals()[0].radiusM).toBe(3);
    (node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.segments =
      [{ kind: 'arc', center: [0, 0, 0], radius: 5, startAngle: 0, degrees: 90, plane: 'XZ' }];
    comp.reapplyConfig();
    const after = comp.path!;
    expect(after).not.toBe(before);
    expect(after.geometryId).not.toBe(before.geometryId);
    expect(after.curvatureIntervals()[0].radiusM).toBe(5);
    expect(getDefaultPathNetwork().get('Curve')).toBe(after);
  });
});
