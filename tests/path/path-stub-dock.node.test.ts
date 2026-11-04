// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { computeStubDock, hostByRay, validateStationDocks, type StubDockInput } from '../../src/core/engine/rv-path-stub-dock';
import { placedTemplate, poseAtArcLength, poseForPort } from '../../src/core/engine/rv-path-blocks';
import type { PathGraphEntry } from '../../src/core/engine/rv-path-network-ops';

const line = (id = 'host', z = 0): PathGraphEntry => ({ id, nodeName: id, block: '', successors: [], segments: [{ kind: 'line', from: [0, 0, z], to: [20, 0, z] }] });
const input = (side = 1): StubDockInput => ({ host: line(), seat: [8, side * 4.2], portDir: [0, -side], radiusM: 1.5, loadOffsetM: 0.3 });
function dock(i: StubDockInput) {
  const result = computeStubDock(i);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  const at = poseAtArcLength(i.host.segments, result.s)!;
  const stub = placedTemplate({ kind: 'stub', radiusM: i.radiusM, stubStraightM: result.stubStraightM, side: result.side }, poseForPort(at), at.position[1]).find(p => p.role === 'stub')!.specs[0];
  if (stub.kind !== 'line') throw new Error('Expected stub line');
  return { result, stub };
}
const tilted = (degrees: number): [number, number] => [Math.sin(degrees * Math.PI / 180), -Math.cos(degrees * Math.PI / 180)];

describe('synthetic stub dock oracle (plan-636 9.2a)', () => {
  it.each([-1, 1])('reproduces the hand-calculated oracle on side %s', side => {
    const { result, stub } = dock(input(side));
    expect(result.side).toBe(side < 0 ? 'left' : 'right');
    expect(result.s).toBeCloseTo(9.5, 10);
    expect(result.stubStraightM).toBeCloseTo(2.4, 10);
    expect(Math.abs(stub.from[2])).toBeCloseTo(3.9, 10);
    expect(Math.hypot(stub.from[0] - 8, stub.from[2] - side * 3.9)).toBeLessThanOrEqual(0.001);
  });

  it('rejects 1.5 degrees but accepts 0.9 degrees', () => {
    expect(computeStubDock({ ...input(), portDir: tilted(1.5) })).toMatchObject({ ok: false, reason: 'dock-not-perpendicular' });
    expect(computeStubDock({ ...input(), portDir: tilted(0.9) })).toMatchObject({ ok: true });
  });

  it.each([-5, 5])('uses the true axis for a 0.9 degree port and %s m offset', loadOffsetM => {
    const i: StubDockInput = { ...input(), seat: [8, 10], portDir: tilted(0.9), loadOffsetM };
    const { stub } = dock(i);
    const dx = stub.to[0] - stub.from[0], dz = stub.to[2] - stub.from[2];
    const length = Math.hypot(dx, dz);
    expect(Math.hypot(stub.from[0] - dx / length * loadOffsetM - i.seat[0], stub.from[2] - dz / length * loadOffsetM - i.seat[1])).toBeLessThanOrEqual(0.001);
    const path: PathGraphEntry = { ...line('stub'), segments: [stub] };
    const check = { stationId: 'station', stubPathId: 'stub', seat: i.seat, portDir: i.portDir, loadOffsetM };
    expect(validateStationDocks([check], [path])).toEqual([]);
    const displaced: PathGraphEntry = { ...path, segments: [{ ...stub, from: [stub.from[0] + 0.015, stub.from[1], stub.from[2]], to: [stub.to[0] + 0.015, stub.to[1], stub.to[2]] }] };
    expect(validateStationDocks([check], [displaced])).toMatchObject([{ code: 'path-dock-misaligned', key: 'station', severity: 'warning', short: 'Dock 15 mm' }]);
  });

  it('rejects insufficient straight length', () => {
    expect(computeStubDock({ ...input(), seat: [8, 1.55], loadOffsetM: 0 })).toMatchObject({ ok: false, reason: 'dock-too-close' });
  });

  it('rejects a foot on an arc and a mouth beyond the straight', () => {
    const host = line();
    host.segments = [{ kind: 'line', from: [0, 0, 0], to: [5, 0, 0] }, { kind: 'arc', center: [5, 0, 2], radius: 2, startAngle: -90, degrees: 90 }];
    expect(computeStubDock({ ...input(), host, seat: [6, -4] })).toMatchObject({ ok: false, reason: 'dock-host-not-straight' });
    expect(computeStubDock({ ...input(-1), host, seat: [4, -4] })).toMatchObject({ ok: false, reason: 'dock-host-not-straight' });
  });

  it('includes preceding arc lengths when docking on a later straight', () => {
    const host = line();
    host.segments.unshift({ kind: 'arc', center: [0, 0, 2], radius: 2, startAngle: -180, degrees: 90 });
    expect(dock({ ...input(), host }).result.s).toBeCloseTo(Math.PI + 9.5, 9);
  });

  it('reports missing stubs and angle-only discrepancies with station keys', () => {
    const check = { stationId: 'station', stubPathId: 'missing', seat: [8, 4.2] as [number, number], portDir: tilted(2.4), loadOffsetM: 0.3 };
    expect(validateStationDocks([check], [])).toMatchObject([{ code: 'path-dock-stub-missing', key: 'station', severity: 'warning' }]);
    expect(validateStationDocks([{ ...check, stubPathId: null }], [])).toEqual([]);
    const { stub } = dock(input());
    expect(validateStationDocks([check], [{ ...line('missing'), segments: [stub] }])).toMatchObject([{ code: 'path-dock-misaligned', short: 'Dock 2.4°' }]);
  });
});

describe('hostByRay', () => {
  it('selects the nearer parallel host regardless of input order', () => {
    expect(hostByRay([line('far'), line('near', 2)], [8, 4], [0, -1], 10)).toEqual({ pathId: 'near', lambda: 2 });
  });
  it('breaks sub-millimeter ties by id in either input order', () => {
    const a = line('A'), b = line('B', 0.0005);
    for (const paths of [[b, a], [a, b]]) expect(hostByRay(paths, [8, 4], [0, -1], 10)).toEqual({ pathId: 'A', lambda: 4 });
  });
  it('returns no host for misses, backwards hits and excessive depth', () => {
    for (const from of [[21, 4], [8, -4]] as [number, number][]) expect(hostByRay([line()], from, [0, -1], 10)).toEqual({ reason: 'dock-no-host' });
    expect(hostByRay([line()], [8, 4], [0, -1], 3)).toEqual({ reason: 'dock-no-host' });
  });
  it.each([{ startAngle: 0, degrees: 180 }, { startAngle: 180, degrees: 180, clockwise: true }, { startAngle: 180, degrees: -180 }])('rejects the first hit on an arc: %j', angles => {
    const arc: PathGraphEntry = { ...line('arc'), segments: [{ kind: 'arc', center: [8, 0, 1], radius: 1, ...angles }] };
    expect(hostByRay([line(), arc], [8, 4], [0, -1], 10)).toEqual({ reason: 'dock-host-not-straight' });
  });
  it('discards circle hits outside the angular span', () => {
    const arc: PathGraphEntry = { ...line('arc'), segments: [{ kind: 'arc', center: [8, 0, 1], radius: 1, startAngle: -30, degrees: 60 }] };
    expect(hostByRay([arc, line()], [8, 4], [0, -1], 10)).toEqual({ pathId: 'host', lambda: 4 });
  });
});
