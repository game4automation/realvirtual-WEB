// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.7 (R5) — components that OWN a mesh through a reference, after
 * the destructive bake.
 *
 * R5 asks whether a component that rewrites a material or a transform per tick
 * still has something of its own to rewrite once the bake has merged the model.
 * Three shapes, three answers:
 *
 *  - a MANTLE (`RibbonRoller`/`Winder`/`Dancer`, all `bake: 'keep'`) keeps its
 *    own mesh and its own material object. That is what makes two identical
 *    mantles — one deduped material between them — scroll independently: the
 *    component clones the material onto ITS mesh (`_bindTextureSpin`, pinned
 *    per-roller in `ribbon-spin-mode.test.ts`), and after the bake there are
 *    still two meshes to clone onto, not one shared chunk;
 *  - `RibbonWinder.RollMesh` may point OUTSIDE that keep subtree. The reference
 *    is tagged `chunk` (D7), so the target becomes a boundary with a chunk mesh
 *    of its own — a drawable the winder scales as a unit;
 *  - `Chain.ChainElement` is the same tag, and the element is CLONED per link at
 *    runtime: the clone must carry the chunk mesh and SHARE its geometry (D21),
 *    or a 60-link chain would allocate 60 copies of it.
 */
import { describe, it, expect } from 'vitest';
import { Box3, MeshStandardMaterial, Object3D, Vector3, type Mesh } from 'three';
// Side effect: registers the component capabilities the classification reads.
import '../src/core/engine/rv-scene-loader';
import { computeSurvival } from '../src/core/engine/rv-bake-survival';
import { buildPreBakeRegistry } from '../src/core/engine/rv-pre-bake';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { bakeTree, group, makeTexture, texturedMesh, uberMesh, withComponent } from './fixtures/bake-fixture';
import { refTo } from './helpers/bake-survival';

const uber = new RVUberMaterial(false);

/** The destructive bake as `ModelCache._bake` runs it: survival model, then bake. */
async function bakeDestructive(root: Object3D): Promise<BakedAsset> {
  root.updateMatrixWorld(true);
  const survival = computeSurvival(root, buildPreBakeRegistry(root));
  const asset = await bakeTree(root, {
    uber,
    destructive: true,
    survives: survival.survives,
    incomingRoles: survival.incoming,
  });
  return asset;
}

/** The node at `path` inside a template graph, or a failing expectation. */
function templateNode(asset: BakedAsset, name: string): Object3D {
  const found = asset.template.getObjectByName(name);
  expect(found, `"${name}" missing from the template`).toBeTruthy();
  return found!;
}

function worldBox(node: Object3D): Vector3 {
  node.updateMatrixWorld(true);
  const size = new Vector3();
  new Box3().setFromObject(node).getSize(size);
  return size;
}

describe('reference mesh owners after the destructive bake (plan-754 §9.7)', () => {
  it('two identical mantles keep two meshes, so they can scroll independently', async () => {
    // ONE material between the two mantles — the state the scene-wide dedup
    // leaves behind, and the exact premise of R5.
    const shared = new MeshStandardMaterial({ map: makeTexture() });
    const root = group('Line');
    const build = (name: string, x: number): Mesh => {
      const roller = withComponent(group(name), 'RibbonRoller', { SpinMode: 'Texture', RadiusMm: 60 });
      roller.position.x = x;
      const mantle = texturedMesh(`${name}_Mantle`, shared);
      roller.add(mantle);
      root.add(roller);
      return mantle;
    };
    const mantleA = build('RollerA', 0);
    const mantleB = build('RollerB', 4);
    // Something the bake can actually merge, so the asset is not all-keep.
    root.add(uberMesh(uber, 'Frame', [8, 0, 0]));

    const asset = await bakeDestructive(root);

    // Both mantles are KEEP meshes: the originals, MOVED into the template.
    const kept = asset.keep.map((k) => k.mesh as Object3D);
    expect(kept).toContain(mantleA);
    expect(kept).toContain(mantleB);
    expect(mantleA).not.toBe(mantleB);
    expect(mantleA.parent?.name).toBe('RollerA');
    expect(mantleB.parent?.name).toBe('RollerB');
    // Still one shared material — the bake does not clone it, and must not.
    expect(mantleA.material).toBe(shared);
    expect(mantleB.material).toBe(shared);

    // What the roller does at init, on the meshes the bake left it: clone the
    // material and the map per roller. Two meshes → two clones → two offsets.
    for (const mantle of [mantleA, mantleB]) {
      const mat = (mantle.material as MeshStandardMaterial).clone();
      mat.map = mat.map!.clone();
      mantle.material = mat;
    }
    const mapA = (mantleA.material as MeshStandardMaterial).map!;
    const mapB = (mantleB.material as MeshStandardMaterial).map!;
    expect(mapA).not.toBe(mapB);
    mapA.offset.x = 0.25;
    expect(mapB.offset.x).toBe(0);
  });

  it('RibbonWinder.RollMesh gets a drawable of its own on a boundary', async () => {
    const root = group('Asset');
    // The roll body is modelled as a separate CAD part, OUTSIDE the winder's
    // keep subtree — the case the `chunk` tag on `RollMesh` exists for.
    const rollBody = group('RollBody');
    rollBody.add(uberMesh(uber, 'rollSkin'));
    const winder = withComponent(group('Winder'), 'RibbonWinder', {
      RollMesh: refTo('RollBody'),
      RadiusMm: 400,
    });
    root.add(rollBody, winder, uberMesh(uber, 'Frame', [6, 0, 0]));

    const asset = await bakeDestructive(root);

    // The tag made it a boundary: its own chunk, its own surviving node.
    expect(asset.chunks.map((c) => c.ownerPath)).toContain('RollBody');
    const rollTemplate = templateNode(asset, 'RollBody');
    const chunk = asset.chunks.find((c) => c.ownerPath === 'RollBody')!;
    expect(chunk.triangles).toBeGreaterThan(0);
    expect(chunk.templateMesh?.parent).toBe(rollTemplate);

    // …and scaling that node scales real geometry, which is all the winder does.
    const before = worldBox(rollTemplate);
    rollTemplate.scale.set(2, 1, 2);
    const after = worldBox(rollTemplate);
    expect(after.x).toBeCloseTo(before.x * 2, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
  });

  it('a Chain element clone carries its chunk mesh and shares the geometry', async () => {
    const root = group('Asset');
    const element = group('Element');
    element.add(uberMesh(uber, 'link'));
    const chain = withComponent(group('Chain1'), 'Chain', { ChainElement: refTo('Element') });
    root.add(element, chain, uberMesh(uber, 'Frame', [6, 0, 0]));

    const asset = await bakeDestructive(root);

    const elementTemplate = templateNode(asset, 'Element');
    const chunk = asset.chunks.find((c) => c.ownerPath === 'Element')!;
    expect(chunk, 'the element must be its own boundary').toBeTruthy();
    expect(chunk.templateMesh?.parent).toBe(elementTemplate);

    // Runtime clone per link: `Object3D.clone(true)` shares geometry by
    // reference, so N links cost N matrices, not N geometries.
    const clone = elementTemplate.clone(true);
    const cloneMeshes: Mesh[] = [];
    clone.traverse((n) => { if ((n as Mesh).isMesh) cloneMeshes.push(n as Mesh); });
    expect(cloneMeshes.length).toBe(1);
    expect(cloneMeshes[0]).not.toBe(chunk.templateMesh);
    expect(cloneMeshes[0].geometry).toBe(chunk.geometry);
    expect(cloneMeshes[0].material).toBe(chunk.material);
  });
});
