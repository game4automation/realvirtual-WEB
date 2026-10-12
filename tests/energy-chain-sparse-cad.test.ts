// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { ExtrudeGeometry, Shape, Mesh, MeshStandardMaterial, SkinnedMesh, Vector3 } from 'three';
import { calibrate } from '../src/core/engine/rv-energy-chain-path';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';
import { chainHarness, transformRef } from './energy-chain-fixture';

// CAD tessellation puts vertices at the ends of straight faces, unlike the
// uniformly sampled point-cloud fixtures. The unequal ends model a carriage
// whose rest pose is offset from the fixed chain end.
function sparseChain(movingEnd: number): ExtrudeGeometry {
  const c = 0.251, outer = 0.0725, inner = 0.0375;
  const shape = new Shape();
  shape.moveTo(0, -outer);
  shape.lineTo(c, -outer);
  shape.absarc(c, 0, outer, -Math.PI / 2, Math.PI / 2, false);
  shape.lineTo(movingEnd, outer);
  shape.lineTo(movingEnd, inner);
  shape.lineTo(c, inner);
  shape.absarc(c, 0, inner, Math.PI / 2, -Math.PI / 2, true);
  shape.lineTo(0, -inner);
  shape.closePath();
  return new ExtrudeGeometry(shape, { depth: 0.042, bevelEnabled: false, steps: 1, curveSegments: 20 });
}

describe('energy chain calibration of sparse CAD triangles', () => {
  it.each([-1, 1])('keeps the opposite end fixed and the bend radius stable (moving side %s)', (movingSide) => {
    const h = chainHarness();
    h.chain.clear();
    const authored = sparseChain(0);
    h.chain.add(new Mesh(authored, new MeshStandardMaterial()));
    h.follower.position.set(0, movingSide * 0.055, 0);
    h.scene.updateMatrixWorld(true);
    const fields = { Follower: transformRef('Root/Slide'), Bones: 48 };
    h.chain.userData.realvirtual = { EnergyChain: fields };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', fields) as RVEnergyChain;
    let skin: SkinnedMesh | undefined;
    h.chain.traverse(n => { if ((n as SkinnedMesh).isSkinnedMesh) skin = n as SkinnedMesh; });
    expect(chain.diagnosis).toBe('ok');
    expect(skin).toBeDefined();
    expect(skin!.geometry).not.toBe(authored);
    expect(skin!.geometry.getAttribute('position').count).toBeGreaterThan(authored.getAttribute('position').count);
    freezeStaticMatrices(h.root, [h.follower]);
    const position = skin!.geometry.getAttribute('position');
    const original = new Vector3(), deformed = new Vector3();
    for (const travel of [-0.2, 0, 0.2, 0.35]) {
      h.follower.position.x = travel;
      h.scene.updateMatrixWorld(true);
      chain.updatePose(0.016);
      h.scene.updateMatrixWorld(true);
      let bendVertices = 0, fixedVertices = 0, movingVertices = 0;
      for (let i = 0; i < position.count; i++) {
        original.fromBufferAttribute(position, i);
        skin!.applyBoneTransform(i, deformed.copy(original));
        if (deformed.x > chain.bendCenter + 0.006) {
          const radius = Math.hypot(deformed.x - chain.bendCenter, deformed.y);
          expect(radius).toBeGreaterThan(0.0375 * 0.9);
          expect(radius).toBeLessThan(0.0725 * 1.1);
          bendVertices++;
        }
        if (Math.abs(original.x) < 1e-6 && original.y * movingSide < -0.06) {
          expect(deformed.distanceTo(original)).toBeLessThan(0.0002);
          fixedVertices++;
        }
        if (Math.abs(original.x) < 1e-6 && original.y * movingSide > 0.06) {
          expect(deformed.x).toBeCloseTo(travel, 3);
          movingVertices++;
        }
      }
      expect(bendVertices).toBeGreaterThan(10);
      expect(fixedVertices).toBeGreaterThan(0);
      expect(movingVertices).toBeGreaterThan(0);
    }
    chain.dispose();
    expect(authored.getAttribute('skinIndex')).toBeUndefined();
  });

  it.each([0, 0.1])('measures straight strands instead of a bend slice (end offset %s m)', (end) => {
    const geometry = sparseChain(end);
    const points = geometry.getAttribute('position').array as Float32Array;
    const indices = Uint32Array.from({ length: points.length / 3 }, (_, i) => i);
    const result = calibrate({ points, triangles: indices });
    expect(result.status).toBe('ok');
    expect(result.axis).toBe('X');
    expect(result.bendDir).toBe(1);
    expect(result.bendRadiusMm).toBeCloseTo(55, 1);
    expect(result.linkHeightMm).toBeCloseTo(35, 1);
    expect(result.lowEnd).toBeCloseTo(0, 5);
    expect(result.highEnd).toBeCloseTo(end, 5);
    expect(result.chainLengthMm).toBeCloseTo((0.502 - end) * 1000 + Math.PI * 55, 1);
    geometry.dispose();
  });

  it('leaves sparse source geometry unchanged during calibration', () => {
    const geometry = sparseChain(0);
    const points = geometry.getAttribute('position').array as Float32Array;
    const copy = points.slice();
    calibrate({ points, triangles: Uint32Array.from({ length: points.length / 3 }, (_, i) => i) });
    expect(points).toEqual(copy);
    geometry.dispose();
  });
});
