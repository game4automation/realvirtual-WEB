// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 Phase 5 — the pure geometry of the path-network planner UI:
 * tangent-true ghost snap (M5: no cardinal rounding), free ghost, append
 * port, projection (junction tool / slide, side after E3), 15° raster and
 * the heading-delta sign the block gizmo hands to `layout.path.move`.
 */

import { describe, it, expect } from 'vitest';
import { specEnds, headingOf, applyRigidXZ } from '../../src/core/engine/rv-path-blocks';
import { specListLength, type Vec3Tuple } from '../../src/core/engine/rv-path-edit';
import {
  appendPortFor,
  ghostPlacement,
  headingDelta,
  isJunctionEntry,
  nearestFreePort,
  PATH_CATALOG,
  placeArgsFor,
  projectableLine,
  snapAngle,
  type FreePort,
} from '../../src/plugins/path-network/path-network-ui-model';

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const entry = (id: string) => PATH_CATALOG.find((e) => e.id === id)!;

describe('plan-628 Phase 5 ui model', () => {
  it('catalog: unique ids; junction entries are diverge/merge/stub only', () => {
    expect(new Set(PATH_CATALOG.map((e) => e.id)).size).toBe(PATH_CATALOG.length);
    expect(PATH_CATALOG.filter((e) => isJunctionEntry(e.spec)).map((e) => e.id)).toEqual(['diverge', 'merge', 'stub']);
  });

  it('ghost at an END port starts there with the port tangent — 30° stays 30° (no cardinal rounding, M5)', () => {
    const port: FreePort = { pathId: 'A', end: 'end', position: [3, 0, 1], headingDeg: 30 };
    const g = ghostPlacement(entry('straight-2').spec, [3.2, 0, 1.1], 0, [port])!;
    expect(g.mode).toBe('port');
    const e = specEnds(g.specs)!;
    expect(dist(e.start.position, port.position)).toBeLessThan(1e-9);
    expect(headingOf(e.start.tangent)).toBeCloseTo(30, 6);
    expect(specListLength(g.specs)).toBeCloseTo(2, 9);
    expect(placeArgsFor(entry('straight-2').spec, g)).toEqual({ block: 'straight', lengthM: 2, atPath: 'A', atEnd: 'end' });
  });

  it('ghost at a START port ENDS there (built backwards), tangent continuous', () => {
    const port: FreePort = { pathId: 'A', end: 'start', position: [0, 0, 0], headingDeg: 90 };
    const g = ghostPlacement(entry('curve-90-l').spec, [0.1, 0, 0], 0, [port])!;
    expect(g.mode).toBe('port');
    const e = specEnds(g.specs)!;
    expect(dist(e.end.position, port.position)).toBeLessThan(1e-9);
    expect(headingOf(e.end.tangent)).toBeCloseTo(90, 6);
  });

  it('outside the 0.35 m radius the ghost is free at the pointer with the R heading', () => {
    const port: FreePort = { pathId: 'A', end: 'end', position: [0, 0, 0], headingDeg: 0 };
    expect(nearestFreePort([port], [0.36, 0, 0])).toBeNull();
    const g = ghostPlacement(entry('straight-1').spec, [5, 0.5, -2], 45, [port])!;
    expect(g.mode).toBe('free');
    const e = specEnds(g.specs)!;
    expect(dist(e.start.position, [5, 0.5, -2])).toBeLessThan(1e-9);
    expect(headingOf(e.start.tangent)).toBeCloseTo(45, 6);
    expect(placeArgsFor(entry('straight-1').spec, g)).toMatchObject({ block: 'straight', x: 5, z: -2, y: 0.5, headingDeg: 45 });
  });

  it('nearest of two ports wins', () => {
    const a: FreePort = { pathId: 'A', end: 'end', position: [0, 0, 0], headingDeg: 0 };
    const b: FreePort = { pathId: 'B', end: 'end', position: [0.3, 0, 0], headingDeg: 0 };
    expect(nearestFreePort([a, b], [0.2, 0, 0])?.pathId).toBe('B');
  });

  it('append port: the END of the selection first, else its start; foreign ports ignored', () => {
    const ports: FreePort[] = [
      { pathId: 'X', end: 'end', position: [9, 0, 9], headingDeg: 0 },
      { pathId: 'A', end: 'start', position: [0, 0, 0], headingDeg: 0 },
      { pathId: 'B', end: 'end', position: [4, 0, 0], headingDeg: 0 },
    ];
    expect(appendPortFor(ports, ['A', 'B'])?.pathId).toBe('B');
    expect(appendPortFor(ports.slice(0, 2), ['A', 'B'])).toMatchObject({ pathId: 'A', end: 'start' });
    expect(appendPortFor(ports, ['Q'])).toBeNull();
  });

  it('projection: s, distance and side (left of +X travel = −Z, E3)', () => {
    const line = projectableLine([{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }])!;
    const l = line.project([4, 0, -0.5])!;
    expect(l.s).toBeCloseTo(4, 4);
    expect(l.distance).toBeCloseTo(0.5, 4);
    expect(l.side).toBe('left');
    expect(line.project([7, 0, 0.3])!.side).toBe('right');
    expect(line.project([-3, 0, 0])!.s).toBeCloseTo(0, 6);
  });

  it('projection on an arc finds the closest point', () => {
    const line = projectableLine([{ kind: 'arc', center: [0, 0, 0], radius: 2, startAngle: 0, degrees: 90, clockwise: false, plane: 'XZ' } as never]);
    expect(line).not.toBeNull();
    const p = line!.project([0, 0, 0])!;
    expect(p.distance).toBeCloseTo(2, 3);
    const mid = line!.length / 2;
    const q = line!.project([3 * Math.cos(Math.PI / 4), 0, 3 * Math.sin(Math.PI / 4)])!;
    // the closest point of a quarter circle from a radial point is its foot on the radius
    expect(q.distance).toBeCloseTo(1, 2);
    expect(Math.abs(q.s - mid) < line!.length / 2 + 1e-9).toBe(true);
  });

  it('15° raster, Shift = free', () => {
    expect(snapAngle(22, false)).toBe(15);
    expect(snapAngle(23, false)).toBe(30);
    expect(snapAngle(-8, false)).toBe(-15);
    expect(snapAngle(22, true)).toBe(22);
  });

  it('heading delta has the sign of moveBlock: rotating the drag point by +d moves the block heading by +d', () => {
    const pivot: [number, number] = [1, 2];
    const a: Vec3Tuple = [3, 0, 2];
    const d = 30;
    // applyRigidXZ with dHeadingDeg = d rotates the point the same way moveBlock rotates the block
    const [moved] = applyRigidXZ([{ kind: 'line', from: a, to: [a[0] + 1, 0, a[2]] }], { dx: 0, dz: 0, dHeadingDeg: d, pivot });
    const b = (moved as { from: Vec3Tuple }).from;
    expect(headingDelta(pivot, a, b)).toBeCloseTo(d, 6);
  });
});
