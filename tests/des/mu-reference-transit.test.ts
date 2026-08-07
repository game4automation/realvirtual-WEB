// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-reference-transit.test.ts — the parameterized MU REFERENCE POINT ("Bug") and
 * the snap-anchored, leading-edge transit path.
 *
 * Covers two coupled fixes:
 *  - `muBugOffset(mu, dir)` = half the MU's extent along the travel direction (the
 *    origin → leading-edge offset), cached on the MU.
 *  - `createTransitTimer().tween(mu)` rides the MU's ORIGIN one bug-offset BEHIND
 *    the input/output SNAP plane, so the LEADING EDGE follows the snaps. That kills
 *    the conveyor overhang (the part no longer hangs over the belt end) AND the
 *    conv→conv hand-off jump (consecutive belts share a snap, so the origin path is
 *    continuous: belt_N.from == belt_{N-1}.to).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { muBugOffset, setMuForward, muForward } from '../../src/behaviors/_shared/mu-reference';
import { createTransitTimer } from '../../src/behaviors/_shared/transit-timing';
import type { MaterialFlowSelf, MU, TweenSpec } from '../../src/core/material-flow/material-flow-self';

/** An MU with a visual node carrying a box of the given world size (sx,sy,sz m). */
function makeMu(sx: number, sy: number, sz: number): MU {
  const node = new Object3D();
  node.add(new Mesh(new BoxGeometry(sx, sy, sz), new MeshBasicMaterial()));
  node.updateMatrixWorld(true);
  return { id: 1, visual: { node } } as unknown as MU;
}

/** A minimal transport `self`: a belt drive (speed), and input/output port snaps at
 *  the given world Z (the flow runs +Z). */
function makeSelf(inSnapZ: number, outSnapZ: number, speedMmS: number): { self: MaterialFlowSelf<unknown>; belt: Object3D } {
  const belt = new Mesh(new BoxGeometry(0.2, 0.1, 2.0)); // long in +Z (the flow axis)
  belt.name = 'Transport-Z'; belt.updateMatrixWorld(true);
  const inSnap = new Object3D(); inSnap.position.set(0, 0, inSnapZ); inSnap.updateMatrixWorld(true);
  const outSnap = new Object3D(); outSnap.position.set(0, 0, outSnapZ); outSnap.updateMatrixWorld(true);
  const self = {
    drive: () => ({ TargetSpeed: speedMmS }),
    inputs: () => [{ snapNode: inSnap }],
    outputs: () => [{ snapNode: outSnap }],
  } as unknown as MaterialFlowSelf<unknown>;
  return { self, belt };
}

describe('mu.forward + muBugOffset — the Bug reference point', () => {
  it('bug offset = half the part FORWARD (local +Z) dimension, CONSTANT under re-orientation', () => {
    const mu = makeMu(0.8, 0.5, 1.2); // forward dim = local +Z = 1.2
    setMuForward(mu, 0, 1); // forward +Z
    expect(muBugOffset(mu)).toBeCloseTo(0.6, 3); // half of 1.2
    // Re-orient to +X (the turntable corner): the part TURNS so its 1.2 side still
    // leads, so the bug stays 0.6 — it never reads the rotated world AABB.
    setMuForward(mu, 1, 0);
    expect(muBugOffset(mu)).toBeCloseTo(0.6, 3);
  });

  it('defaults to +Z forward when unset', () => {
    const mu = makeMu(0.8, 0.5, 1.2);
    expect(muForward(mu)).toEqual([0, 1]);
    expect(muBugOffset(mu)).toBeCloseTo(0.6, 3); // default +Z → half of 1.2
  });

  it('setMuForward normalises and ignores a degenerate (0,0) input', () => {
    const mu = makeMu(1, 1, 2);
    setMuForward(mu, 0, 3);
    expect(muForward(mu)).toEqual([0, 1]); // normalised
    setMuForward(mu, 0, 0); // degenerate → unchanged
    expect(muForward(mu)).toEqual([0, 1]);
  });

  it('returns 0 when the MU has no visual', () => {
    expect(muBugOffset({ id: 2 } as unknown as MU)).toBe(0);
  });

  it('caches the bounds size on the MU (geometry is constant)', () => {
    const mu = makeMu(1, 1, 2);
    setMuForward(mu, 0, 1);
    muBugOffset(mu);
    expect((mu as unknown as { _bugSize?: number[] })._bugSize).toEqual([1, 1, 2]);
  });
});

/** Narrow the TweenSpec union to the 'position' variant (createTransitTimer
 *  always builds position tweens; the union also carries drive/path — plan-268). */
type PositionSpec = Extract<TweenSpec['tween'], { kind: 'position' }>;
const asPos = (t: TweenSpec['tween']): PositionSpec => {
  expect(t.kind).toBe('position');
  return t as PositionSpec;
};

/** A position tween's endpoint is a [x,y,z] tuple. */
const z = (v: number | readonly [number, number, number]): number => (v as readonly [number, number, number])[2];

describe('transit tween — leading-edge (Bug) path anchored to the snaps', () => {
  it('rides the MU ORIGIN one bug-offset behind the snap plane (leading edge AT the snaps)', () => {
    // Input snap z=0, output snap z=2 (+Z flow). A 1.2 m-long part → bug = 0.6.
    const { self, belt } = makeSelf(0, 2, 1000);
    const spec = asPos(createTransitTimer(self, belt).tween(makeMu(0.8, 0.5, 1.2)).tween);
    // Origin path = snaps − bug*dir; leading edge (origin + bug) lands ON the snaps.
    expect(z(spec.from)).toBeCloseTo(-0.6, 3); // origin at entry: 0 − 0.6
    expect(z(spec.to)).toBeCloseTo(1.4, 3);    // origin at exit: 2 − 0.6 → lead edge 1.4+0.6 = 2.0 = output snap
  });

  it('transit time uses the snap-to-snap distance / speed', () => {
    const { self, belt } = makeSelf(0, 2, 1000); // 2 m @ 1000 mm/s → 2 s
    expect(createTransitTimer(self, belt).transitTime).toBeCloseTo(2, 3);
  });

  it('hands off CONTINUOUSLY: belt_N.from == belt_{N-1}.to at a shared snap (no jump)', () => {
    const mu = makeMu(0.8, 0.5, 1.2);
    // Belt 1: snaps 0 → 2. Belt 2: snaps 2 → 4 (shares the z=2 join).
    const m1 = makeSelf(0, 2, 1000); const belt1 = createTransitTimer(m1.self, m1.belt);
    const m2 = makeSelf(2, 4, 1000); const belt2 = createTransitTimer(m2.self, m2.belt);
    const exit1 = z(asPos(belt1.tween(mu).tween).to);    // origin leaving belt 1
    const entry2 = z(asPos(belt2.tween(mu).tween).from);  // origin entering belt 2
    // The MU leaves belt 1 and enters belt 2 at the SAME origin position → no teleport.
    expect(entry2).toBeCloseTo(exit1, 6);
  });

  it('falls back to the bounds path with 0 bug when the MU has no visual', () => {
    const { self, belt } = makeSelf(0, 2, 1000);
    const spec = asPos(createTransitTimer(self, belt).tween({ id: 9 } as unknown as MU).tween);
    // No visual → bug 0 → origin rides the snaps directly (entry 0, exit 2).
    expect(z(spec.from)).toBeCloseTo(0, 3);
    expect(z(spec.to)).toBeCloseTo(2, 3);
  });
});
