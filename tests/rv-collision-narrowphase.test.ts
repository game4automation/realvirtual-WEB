// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.2 — THE regression test of this plan.
 *
 * The torus/rod case fails the moment the narrowphase uses
 * `intersectsRanges: () => true` instead of `intersectsTriangles`: the bounding
 * boxes and several BVH leaf ranges overlap, but no triangle pair does. The
 * rotation cases guard the direction of the `bvhcast` matrix — a flipped matrix
 * produces wrong answers silently.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, TorusGeometry, Mesh, MeshBasicMaterial, MathUtils } from 'three';
import type { BufferGeometry } from 'three';
import { meshesIntersect } from '../src/core/engine/rv-collision-manager';
import { withBVH } from './collision-fixture';

const MAT = new MeshBasicMaterial();

function placed(geo: BufferGeometry, x = 0, degY = 0, s = 1, bvh = true): Mesh {
  if (bvh) withBVH(geo);
  const m = new Mesh(geo, MAT);
  m.position.x = x;
  m.rotation.y = MathUtils.degToRad(degY);
  m.scale.setScalar(s);
  m.updateMatrixWorld(true);
  return m;
}

describe('narrowphase', () => {
  it('detects a real overlap', () => {
    expect(meshesIntersect(
      placed(new BoxGeometry(1, 1, 1)),
      placed(new BoxGeometry(1, 1, 1), 0.5),
    )).toBe(true);
  });

  it('rejects a clear gap', () => {
    expect(meshesIntersect(
      placed(new BoxGeometry(1, 1, 1)),
      placed(new BoxGeometry(1, 1, 1), 3),
    )).toBe(false);
  });

  it('rejects overlapping leaf AABBs with separated triangles (torus hole)', () => {
    // A thin rod through the hole of a torus: the world boxes and several BVH
    // leaf ranges overlap, no triangle pair intersects.
    const torus = placed(new TorusGeometry(1, 0.15, 12, 48));
    const rod = placed(new BoxGeometry(0.1, 0.1, 4));
    expect(meshesIntersect(torus, rod)).toBe(false);
    // Sanity: the boxes really DO overlap, so a box-only check would say true.
    torus.geometry.computeBoundingBox();
    rod.geometry.computeBoundingBox();
    expect(torus.geometry.boundingBox!.intersectsBox(rod.geometry.boundingBox!)).toBe(true);
  });

  it('stays correct under rotation (matrix direction guard)', () => {
    expect(meshesIntersect(
      placed(new BoxGeometry(1, 1, 1), 0, 45),
      placed(new BoxGeometry(1, 1, 1), 3, 45),
    )).toBe(false);
    expect(meshesIntersect(
      placed(new BoxGeometry(1, 1, 1), 0, 45),
      placed(new BoxGeometry(1, 1, 1), 0.7, 45),
    )).toBe(true);
  });

  it('stays correct under non-uniform placement + scale', () => {
    // A tiny box far inside a big one — only a correct matrix finds this.
    expect(meshesIntersect(
      placed(new BoxGeometry(1, 1, 1), 0, 0, 4),
      placed(new BoxGeometry(1, 1, 1), 1.5),
    )).toBe(true);
  });

  it('reports a possible hit when a mesh carries no boundsTree (F14 fallback)', () => {
    expect(meshesIntersect(
      placed(new BoxGeometry(1, 1, 1)),
      placed(new BoxGeometry(1, 1, 1), 3, 0, 1, /* bvh */ false),
    )).toBe(true);
  });
});
