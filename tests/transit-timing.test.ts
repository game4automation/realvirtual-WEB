// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transit-timing.test.ts — unit gate for `_shared/transit-timing.ts`.
 *
 * `createTransitTimer(self, belt)` resolves the DES transit model from the real
 * belt geometry and the Transport Drive — there are no per-component schema
 * fields. This test pins:
 *   - speed from the belt drive's TargetSpeed, with the no-drive fallback;
 *   - length from the belt world-bounds longest extent, scaled metres → mm (×1000);
 *   - transitTime = length / speed over the FULL belt (the sensor plays no part);
 *   - the speed/length guards (never divide by zero; finite transit);
 *   - entry/exit endpoints along the longest axis;
 *   - the tween(mu) shape (kind 'position', from = entry, to = exit, target = mu.visual).
 *
 * Geometry is built at METRE scale because the GLB/Three scene unit is metres —
 * a 1 m box is a 1000 mm belt. Pure TypeScript — no GLB, no private DES build;
 * only the small `self` surface the helper reads (`drive(node)`) is mocked.
 */

import { describe, it, expect } from 'vitest';
import { Mesh, BoxGeometry, Object3D } from 'three';
import { createTransitTimer } from '../src/behaviors/_shared/transit-timing';
import { DEFAULT_TRANSPORT_SPEED_MM_S } from '../src/core/engine/rv-constants';
import {
  type MaterialFlowSelf,
  type MU,
  type SelfDrive,
} from '../src/core/material-flow/material-flow-self';

// ─── Minimal `self` surface the helper reads (drive(node) only) ─────────────

type DriveMap = Map<Object3D, Partial<SelfDrive>>;

function makeSelf(drives: DriveMap = new Map()): MaterialFlowSelf<unknown> {
  // createTransitTimer reads ONLY `drive(node)`; everything else is unused.
  const self = {
    drive(ref: unknown): SelfDrive | null {
      return (drives.get(ref as Object3D) as SelfDrive | undefined) ?? null;
    },
  };
  return self as unknown as MaterialFlowSelf<unknown>;
}

/**
 * A belt node carrying real geometry so `Box3.expandByObject` yields finite
 * world bounds. Dimensions are in METRES (the scene unit): `BoxGeometry(w,h,d)`
 * is centred on the origin → world bounds span [-w/2,+w/2] once world matrices
 * are updated. A 1 m box therefore resolves to a 1000 mm belt length.
 */
function makeBeltMesh(wMetres: number, hMetres: number, dMetres: number): Object3D {
  const mesh = new Mesh(new BoxGeometry(wMetres, hMetres, dMetres));
  mesh.name = 'Transport-X';
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('createTransitTimer — geometry + drive resolution', () => {
  it('straight 1 m belt @ 200 mm/s → 1000 mm, 5 s, endpoints span X', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2); // 1 m long → 1000 mm
    const drives: DriveMap = new Map([[belt, { TargetSpeed: 200 }]]);
    const timer = createTransitTimer(makeSelf(drives), belt);

    expect(timer.length).toBeCloseTo(1000, 1); // 1 m × 1000 = 1000 mm
    expect(timer.speed).toBe(200);
    expect(timer.transitTime).toBeCloseTo(5, 6); // 1000 / 200
    expect(timer.entryPos[0]).toBeCloseTo(-0.5, 6); // world metres
    expect(timer.exitPos[0]).toBeCloseTo(0.5, 6);
  });

  it('transitTime follows length / speed (2 m @ 500 mm/s → 4 s)', () => {
    const belt = makeBeltMesh(2.0, 0.1, 0.2); // → 2000 mm
    const drives: DriveMap = new Map([[belt, { TargetSpeed: 500 }]]);
    const timer = createTransitTimer(makeSelf(drives), belt);

    expect(timer.length).toBeCloseTo(2000, 1);
    expect(timer.transitTime).toBeCloseTo(4, 6); // 2000 / 500
  });

  it('length scales metres → mm (1.5 m → 1500 mm)', () => {
    const belt = makeBeltMesh(1.5, 0.1, 0.2);
    const timer = createTransitTimer(makeSelf(), belt);
    expect(timer.length).toBeCloseTo(1500, 1);
  });

  it('speed falls back to the default transport speed when the belt has no drive', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2);
    const timer = createTransitTimer(makeSelf(), belt);
    expect(timer.speed).toBe(DEFAULT_TRANSPORT_SPEED_MM_S);
    expect(timer.transitTime).toBeCloseTo(1000 / DEFAULT_TRANSPORT_SPEED_MM_S, 6);
  });

  it('speed falls back to the default transport speed when the drive TargetSpeed is 0', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2);
    const drives: DriveMap = new Map([[belt, { TargetSpeed: 0 }]]);
    const timer = createTransitTimer(makeSelf(drives), belt);
    expect(timer.speed).toBe(DEFAULT_TRANSPORT_SPEED_MM_S);
  });

  it('drive TargetSpeed wins when positive', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2);
    const drives: DriveMap = new Map([[belt, { TargetSpeed: 750 }]]);
    const timer = createTransitTimer(makeSelf(drives), belt);
    expect(timer.speed).toBe(750);
  });

  it('empty-bounds belt (no geometry) → finite transit, entry = exit = world position', () => {
    const belt = new Object3D();
    belt.name = 'Transport-X';
    belt.position.set(3, 4, 5);
    belt.updateMatrixWorld(true);

    const timer = createTransitTimer(makeSelf(), belt);
    // length falls back to 1 mm; default speed → still finite & > 0.
    expect(Number.isFinite(timer.transitTime)).toBe(true);
    expect(timer.transitTime).toBeGreaterThan(0);
    expect(timer.entryPos).toEqual([3, 4, 5]);
    expect(timer.exitPos).toEqual([3, 4, 5]);
  });

  it('longest-axis selection: Z-dominant belt spans Z', () => {
    const belt = makeBeltMesh(0.2, 0.1, 1.8); // Z is longest
    const timer = createTransitTimer(makeSelf(), belt);
    expect(timer.length).toBeCloseTo(1800, 1); // 1.8 m × 1000 (float32 geometry)
    expect(timer.entryPos[2]).toBeCloseTo(-0.9, 4);
    expect(timer.exitPos[2]).toBeCloseTo(0.9, 4);
    expect(timer.entryPos[0]).toBeCloseTo(0, 6); // X centred
  });

  it('refresh() recomputes after a drive-speed change', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2); // 1000 mm
    const drive: Partial<SelfDrive> = { TargetSpeed: 200 };
    const timer = createTransitTimer(makeSelf(new Map([[belt, drive]])), belt);
    expect(timer.transitTime).toBeCloseTo(5, 6); // 1000 / 200

    (drive as { TargetSpeed: number }).TargetSpeed = 1000;
    timer.refresh();
    expect(timer.speed).toBe(1000);
    expect(timer.transitTime).toBeCloseTo(1, 6); // 1000 / 1000
  });
});

describe('createTransitTimer.tween — spec shape', () => {
  it('returns a position tween from entry to exit, target = mu.visual', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2);
    const timer = createTransitTimer(makeSelf(), belt);

    const visual = { marker: 'mu-visual' };
    const mu = { id: 1, visual } as unknown as MU;
    const spec = timer.tween(mu);

    expect(spec.tween.kind).toBe('position');
    if (spec.tween.kind === 'position') {
      expect(spec.tween.target).toBe(visual);
      expect(spec.tween.from).toEqual(timer.entryPos);
      expect(spec.tween.to).toEqual(timer.exitPos);
    }
  });

  it('tween target is null when the MU has no visual', () => {
    const belt = makeBeltMesh(1.0, 0.1, 0.2);
    const timer = createTransitTimer(makeSelf(), belt);

    const mu = { id: 2 } as unknown as MU;
    const spec = timer.tween(mu);
    expect(spec.tween.kind).toBe('position');
    if (spec.tween.kind === 'position') {
      expect(spec.tween.target).toBeNull();
    }
  });
});
