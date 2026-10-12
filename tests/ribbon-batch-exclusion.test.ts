// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.7a — the web must stay out of the static pipelines.
 *
 * Both are the same failure in two places: a `RibbonPath` rewrites its band buffer
 * whenever a roll changes size, a `RibbonWinder` scales its roll every tick, and every
 * roller spins. Staged into a bake chunk, or frozen by `freezeStaticMatrices`,
 * the whole machine would stand still while the numbers kept moving — which is
 * the exact symptom the `Chain` entries in both lists exist for.
 */

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
// plan-753 Phase 1: the exclusion is no longer a key list but the component's
// declared `bake:'keep'` role, resolved through the registry — which knows a
// type only once its module has registered. Importing the loader registers the
// production set (exactly what the viewer does), so this test sees the same
// roles as a real load instead of stamping extras nobody has declared.
import '../src/core/engine/rv-scene-loader';
import { bakeFateOf } from './helpers/bake-fate';
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
  it('RibbonPath/RibbonWinder/RibbonRoller/RibbonDancer subtrees are keep meshes of the bake (never in a chunk)', async () => {
    const { root, plain, byKey } = scene();
    // The control: an ordinary frame mesh IS staged into the static chunk, so
    // the assertions below are about the role and not about some unrelated
    // rejection.
    expect(await bakeFateOf(plain, root)).toBe('static');
    for (const [key, child] of byKey) {
      expect(await bakeFateOf(child, root), `${key} subtree must not be baked into a chunk`).toBe('keep');
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
