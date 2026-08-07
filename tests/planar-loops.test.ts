// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { findPlanarLoops, findPlanarLoopsInMesh } from '../src/core/engine/rv-planar-loops';

const Y = new Vector3(0, 1, 0);

function loopYs(loops: Vector3[][]): number[] {
  return loops.map((l) => l[0].y).sort((a, b) => a - b);
}

describe('findPlanarLoops', () => {
  it('finds both rim loops of a capped cylinder perpendicular to Y', () => {
    const geo = new CylinderGeometry(1, 1, 2, 16);
    const loops = findPlanarLoops(geo, Y);
    expect(loops.length).toBe(2);
    expect(loopYs(loops)).toEqual([-1, 1]);
    for (const loop of loops) {
      expect(loop.length).toBe(16);
      for (const p of loop) {
        expect(Math.abs(p.y - loop[0].y)).toBeLessThan(1e-6);
        expect(Math.hypot(p.x, p.z)).toBeCloseTo(1, 5);
      }
    }
  });

  it('finds boundary loops of an open-ended cylinder', () => {
    const geo = new CylinderGeometry(1, 1, 2, 12, 1, true);
    const loops = findPlanarLoops(geo, Y);
    expect(loops.length).toBe(2);
    expect(loopYs(loops)).toEqual([-1, 1]);
    expect(loops[0].length).toBe(12);
  });

  it('returns successive points (each consecutive pair is a mesh edge)', () => {
    const geo = new CylinderGeometry(1, 1, 2, 16);
    const loops = findPlanarLoops(geo, Y);
    const expectedChord = 2 * Math.sin(Math.PI / 16);
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const d = loop[i].distanceTo(loop[(i + 1) % loop.length]);
        expect(d).toBeCloseTo(expectedChord, 5);
      }
    }
  });

  it('finds top and bottom square loops of a box, skipping smooth face diagonals', () => {
    const geo = new BoxGeometry(2, 2, 2);
    const loops = findPlanarLoops(geo, Y);
    expect(loops.length).toBe(2);
    expect(loopYs(loops)).toEqual([-1, 1]);
    for (const loop of loops) expect(loop.length).toBe(4);
  });

  it('finds no loops for an axis with no perpendicular planar loops', () => {
    const geo = new CylinderGeometry(1, 1, 2, 16);
    const tilted = new Vector3(1, 1, 0).normalize();
    expect(findPlanarLoops(geo, tilted).length).toBe(0);
  });

  it('accepts a non-normalized axis', () => {
    const geo = new CylinderGeometry(1, 1, 2, 16);
    expect(findPlanarLoops(geo, new Vector3(0, 42, 0)).length).toBe(2);
  });
});

describe('findPlanarLoopsInMesh', () => {
  it('handles a rotated + translated mesh with a world-space axis', () => {
    const mesh = new Mesh(new CylinderGeometry(1, 1, 2, 16), new MeshBasicMaterial());
    mesh.rotation.z = Math.PI / 2; // local Y now points along world -X
    mesh.position.set(5, 3, -2);
    const loops = findPlanarLoopsInMesh(mesh, new Vector3(1, 0, 0));
    expect(loops.length).toBe(2);
    const xs = loops.map((l) => l[0].x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(4, 5);
    expect(xs[1]).toBeCloseTo(6, 5);
    for (const loop of loops)
      for (const p of loop) expect(Math.hypot(p.y - 3, p.z + 2)).toBeCloseTo(1, 5);
  });
});
