// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { beforeAll, describe, expect, it } from 'vitest';
import { Box3, Matrix4, Mesh, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { readMUColliderTemplate } from '../src/core/engine/rv-mu-collider-template';
import { devAssetAvailable } from './fixtures/dev-asset-available';

// The pure build module lives in the private sibling; a public checkout has none (glob stays empty).
const privateModel = import.meta.glob<{ LOGO_SCALE: number; scaleLogo: (nodes: unknown[], k: number) => void }>(
  '../../realvirtual-WebViewer-Private~/scripts/festo-logo-model.mjs', { eager: true });
const model = Object.values(privateModel)[0];
const LOGO_SCALE = model?.LOGO_SCALE ?? 0.75;
const scaleLogo = (nodes: unknown[], k: number) => model!.scaleLogo(nodes, k);
const URL = '/private-assets/festo/Festo.glb';
const AVAILABLE = await devAssetAvailable(URL);
const TOLERANCE = 1e-6;

// ORIGINAL: Festo-src.glb from commit 7565a89. Mesh POSITION accessor min/max
// transformed by the arm matrix into LogoSource's frame; collider half-axes = size/2.
const ORIGINAL = [
  {
    name: 'LogoArm0',
    min: [-0.010444616480205202, -0.010444616080722072, -0.010444616080722072],
    max: [0.02088923235383258, -0.0016711383326856863, -0.0016711383326856863],
    half: [0.015666923810441068, 0.004386738666923499, 0.004386738666923499],
  },
  {
    name: 'LogoArm1',
    min: [-0.010444616080722072, -0.010444616480205202, -0.010444616080722072],
    max: [-0.0016711383326856863, 0.02088923235383258, -0.0016711383326856863],
    half: [0.004386738666923499, 0.015666923810441068, 0.004386738666923499],
  },
  {
    name: 'LogoArm2',
    min: [-0.010444616080722072, -0.010444616080722072, -0.010444616480205202],
    max: [-0.0016711383326856863, -0.0016711383326856863, 0.02088923235383258],
    half: [0.004386738666923499, 0.004386738666923499, 0.015666923810441068],
  },
];

describe.skipIf(!AVAILABLE)('Festo delivered logo scale', () => {
  let root: Object3D;
  beforeAll(async () => {
    const { scene } = await new GLTFLoader().loadAsync(URL);
    root = scene.getObjectByName('LogoSource')!;
    expect(root, 'LogoSource is present').toBeDefined();
    root.updateWorldMatrix(true, true);
  }, 120_000);

  for (const original of ORIGINAL) {
    it(`${original.name} mesh bounds equal 0.75 x original in the MU frame`, () => {
      const arm = root.children.find(child => child.name === original.name);
      expect(arm, `${original.name} is a child of LogoSource`).toBeDefined();
      const inverse = root.matrixWorld.clone().invert();
      const bounds = new Box3();
      arm!.traverse(node => {
        if (!(node instanceof Mesh)) return;
        node.geometry.computeBoundingBox();
        const matrix = new Matrix4().multiplyMatrices(inverse, node.matrixWorld);
        bounds.union(node.geometry.boundingBox!.clone().applyMatrix4(matrix));
      });
      expect(bounds.isEmpty()).toBe(false);
      for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
        expect(Math.abs(bounds.min[axis] - original.min[i] * LOGO_SCALE)).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.abs(bounds.max[axis] - original.max[i] * LOGO_SCALE)).toBeLessThanOrEqual(TOLERANCE);
      }
    });

    it(`${original.name} collider half-axes equal 0.75 x original`, () => {
      // Match traversal order by name rather than fixed source/rebuilt glTF indices.
      const colliderNodes: Object3D[] = [];
      root.traverse(node => {
        const box = node.userData.realvirtual?.BoxCollider;
        if (box && box.isTrigger !== true && box.enabled !== false) colliderNodes.push(node);
      });
      const index = colliderNodes.findIndex(node => node.name === original.name);
      expect(index).toBeGreaterThanOrEqual(0);
      const template = readMUColliderTemplate(root);
      expect(template).toBeDefined();
      const half = template!.shapes[index].halfExtents;
      for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
        expect(Math.abs(half[axis] - original.half[i] * LOGO_SCALE)).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  }
});

interface TestNode {
  name: string;
  children?: number[];
  matrix?: number[];
  extras?: { realvirtual: { BoxCollider: { size: { x: number; y: number; z: number } } } };
}

function fixture(): TestNode[] {
  const arms = [2, 0, 1].map(i => ({
    name: `LogoArm${i}`,
    matrix: Array.from({ length: 16 }, (_, index) => index + 1),
    extras: { realvirtual: { BoxCollider: { size: { x: 2, y: 4, z: 6 } } } },
  }));
  // Shuffled names/indices, with an unrelated node outside LogoSource.
  return [{ name: 'Unrelated' }, ...arms, { name: 'LogoSource', children: [1, 2, 3] }];
}

describe.skipIf(!model)('scaleLogo pure model transform', () => {
  it('scales matrix 0-10 and 12-14 only, preserving collider sizes and matrix representation', () => {
    expect(LOGO_SCALE).toBe(0.75);
    const nodes = fixture();
    const before = structuredClone(nodes);
    scaleLogo(nodes, LOGO_SCALE);
    for (const index of [1, 2, 3]) {
      const arm = nodes[index], original = before[index];
      for (let i = 0; i < 16; i++) {
        expect(arm.matrix![i]).toBe(original.matrix![i] * ([11, 15].includes(i) ? 1 : LOGO_SCALE));
      }
      expect(arm.extras!.realvirtual.BoxCollider.size).toEqual(original.extras!.realvirtual.BoxCollider.size);
      expect(arm).not.toHaveProperty('scale');
    }
    expect(nodes[0]).toEqual(before[0]);
  });

  for (const name of ['LogoArm0', 'LogoArm1', 'LogoArm2']) {
    it(`throws when ${name} is missing from LogoSource children`, () => {
      const nodes = fixture();
      nodes[4].children = nodes[4].children!.filter(i => nodes[i].name !== name);
      expect(() => scaleLogo(nodes, LOGO_SCALE)).toThrow(name);
    });
    it(`throws when ${name} has no matrix`, () => {
      const nodes = fixture();
      delete nodes.find(node => node.name === name)!.matrix;
      expect(() => scaleLogo(nodes, LOGO_SCALE)).toThrow(`${name} has no 4x4 matrix`);
    });
  }

  it('throws when LogoSource is missing', () => {
    expect(() => scaleLogo([], LOGO_SCALE)).toThrow('missing LogoSource');
  });
});
