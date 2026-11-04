// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-655 F10 (SOL finding 2) — a Source whose MU template sits under a
 * SCALED parent (a SolidCraft body authored in millimetres under 0.001) spawns
 * MUs with the template's WORLD size, and the MU box matches it.
 */
import { describe, it, expect } from 'vitest';
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { RVMovingUnit } from '../src/core/engine/rv-mu';

function build(parentScale: number): { source: RVSource; world: Object3D } {
  const world = new Object3D();
  const mmBody = new Object3D();
  mmBody.scale.setScalar(parentScale);
  world.add(mmBody);
  const template = new Object3D();
  template.name = 'Carton';
  template.add(new Mesh(new BoxGeometry(600 * 0.001 / parentScale, 400 * 0.001 / parentScale, 300 * 0.001 / parentScale), new MeshBasicMaterial()));
  // A second mesh forces the clone path at scale 1 too (comparable answers).
  template.add(new Mesh(new BoxGeometry(0.1 * 0.001 / parentScale, 0.1 * 0.001 / parentScale, 0.1 * 0.001 / parentScale), new MeshBasicMaterial()));
  mmBody.add(template);
  const sourceNode = new Object3D();
  sourceNode.name = 'Source';
  mmBody.add(sourceNode);
  world.updateMatrixWorld(true);
  const source = new RVSource(sourceNode);
  source.muName = template.name;
  source.sourceIsTemplate = false;
  source.spawnParent = world;
  source.spawnMode = 'Interval';
  source.spawnInterval = 0.01;
  source.setTemplate(template);
  return { source, world };
}

describe('plan-655 F10 — Source template under a scaled parent', () => {
  for (const scale of [1, 0.001]) {
    it(`spawns an MU of the template's world size (parent scale ${scale})`, () => {
      const { source, world } = build(scale);
      const mu = source.update(1, true) as RVMovingUnit;
      expect(mu).toBeTruthy();
      world.updateMatrixWorld(true);
      const size = new Box3().setFromObject(mu.node).getSize(new Vector3());
      expect(size.x).toBeCloseTo(0.6, 4);
      expect(size.y).toBeCloseTo(0.4, 4);
      expect(size.z).toBeCloseTo(0.3, 4);
      mu.updateAABB();
      expect(mu.aabb.halfSize.x).toBeCloseTo(0.3, 4);
      expect(mu.aabb.halfSize.z).toBeCloseTo(0.15, 4);
    });
  }
});
