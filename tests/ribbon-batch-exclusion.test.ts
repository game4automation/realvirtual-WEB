// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.7a — the web must stay out of the static pipelines.
 *
 * Both are the same failure in two places: a `RibbonPath` rewrites its band buffer
 * whenever a roll changes size, a `RibbonWinder` scales its roll every tick, and every
 * roller spins. Baked into a static arena, or frozen by `freezeStaticMatrices`,
 * the whole machine would stand still while the numbers kept moving — which is
 * the exact symptom the `Chain` entries in both lists exist for.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { isBatchSafe } from '../src/core/engine/rv-batched-render';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';

function mesh(name: string): Mesh {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const m = new Mesh(geo, new MeshStandardMaterial());
  m.name = name;
  return m;
}

/** A root with one plain static mesh and one node per web component type. */
function scene(): { root: Object3D; plain: Mesh; byKey: Map<string, Mesh> } {
  const root = new Object3D();
  root.name = 'Root';
  const plain = mesh('Frame');
  root.add(plain);

  const byKey = new Map<string, Mesh>();
  for (const key of ['RibbonPath', 'RibbonWinder', 'RibbonRoller', 'RibbonDancer']) {
    const node = new Object3D();
    node.name = key;
    node.userData.realvirtual = { [key]: {} };
    const child = mesh(`${key}_Mesh`);
    node.add(child);
    root.add(node);
    byKey.set(key, child);
  }
  root.updateMatrixWorld(true);
  return { root, plain, byKey };
}

describe('web components and the static pipelines', () => {
  it('RibbonPath/RibbonWinder/RibbonRoller/RibbonDancer subtrees are excluded from the batched arena', () => {
    const { root, plain, byKey } = scene();
    // The control: an ordinary frame mesh IS batch-safe, so the assertions
    // below are about the exclusion and not about some unrelated rejection.
    expect(isBatchSafe(plain, root)).toBe(true);
    for (const [key, child] of byKey) {
      expect(isBatchSafe(child, root), `${key} subtree must not be batched`).toBe(false);
    }
  });

  it('freeze-static keeps winder and roller nodes dynamic', () => {
    const { root, plain, byKey } = scene();
    const result = freezeStaticMatrices(root);
    expect(result.total).toBeGreaterThan(0);

    // The plain frame mesh is frozen…
    expect(plain.matrixWorldAutoUpdate).toBe(false);
    // …and every web node, plus its whole subtree, stays live.
    for (const [key, child] of byKey) {
      expect(child.matrixWorldAutoUpdate, `${key} mesh must stay dynamic`).toBe(true);
      expect(child.parent!.matrixWorldAutoUpdate, `${key} node must stay dynamic`).toBe(true);
    }
    // Their common ancestor is kept alive too (the mover closure).
    expect(root.matrixWorldAutoUpdate).toBe(true);
  });
});
