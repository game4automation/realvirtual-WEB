// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-material-donor-bake.test.ts — what happens to a `_MaterialDonor` in the bake (plan-496).
 *
 * The Unity GLB export adds a one-millimetre quad named `<path>_MaterialDonor` for every
 * `RibbonPath.MaterialName`, because UnityGLTF exports only materials that sit on a RENDERER and a
 * band mesh does not exist while authoring. The donor has done its job the moment the document
 * material index has been taken — from then on it is a quad nobody wants to see or click.
 *
 * The destructive bake makes that free: a node nobody claims is NOT BUILT. So the hook must
 * deliberately NOT claim the donor `keep` (which is what it does for a legacy `Material` node, whose
 * material the band reads from the live graph). The two assertions below are exactly that
 * difference — zero draw calls for a donor, a surviving mesh for a legacy donor — plus the one that
 * matters to the user: the band still gets the material.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import '../src/core/engine/rv-scene-loader'; // side effect: capabilities, schemas, built-in hooks
import { runPreBakeHooks, collectMaterialsByName, findMaterialByName, registerMaterialIndex } from '../src/core/engine/rv-pre-bake';
import { registerBuiltInPreBakeHooks } from '../src/core/engine/rv-pre-bake-hooks';
import { bakeAndPlace } from './fixtures/bake-fixture';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';

const DONOR_MATERIAL = 'Paper';

function donorMesh(name: string, materialName: string): Mesh {
  const material = new MeshStandardMaterial({ roughness: 0.25 });
  material.name = materialName;
  const mesh = new Mesh(new BoxGeometry(0.001, 0.001, 0.001), material);
  mesh.name = name;
  return mesh;
}

/** A path node with a `Material` reference plus the referenced mesh, under a staged root. */
function buildTree(donorName: string, extraPathFields: Record<string, unknown> = {}): {
  root: Object3D; donor: Mesh;
} {
  const root = new Object3D();
  root.name = 'Machine';
  const holder = new Object3D();
  holder.name = '_rvLoadStaging';
  holder.add(root);

  const path = new Object3D();
  path.name = 'Web';
  path.userData.realvirtual = {
    RibbonPath: {
      Rollers: [],
      RibbonWidthMm: 500,
      Material: { type: 'ComponentReference', path: donorName, componentType: 'UnityEngine.Transform' },
      ...extraPathFields,
    },
  };
  root.add(path);

  const donor = donorMesh(donorName, DONOR_MATERIAL);
  root.add(donor);
  root.updateMatrixWorld(true);
  return { root, donor };
}

describe('_MaterialDonor in the bake (plan-496)', () => {
  it('hides the donor and does not claim it, so the bake builds no geometry for it', async () => {
    registerBuiltInPreBakeHooks();
    const { root, donor } = buildTree('Web_MaterialDonor', { MaterialName: DONOR_MATERIAL });

    // The index is taken BEFORE the bake, exactly as `prepareAndBake` does it.
    const index = collectMaterialsByName(root);
    runPreBakeHooks(root);

    expect(donor.visible).toBe(false);
    expect(donor.parent, 'the donor is removed from the tree once its material is indexed').toBeNull();
    const role = (donor.userData?.realvirtual as Record<string, unknown> | undefined)?.BakeRole;
    expect(role, 'a donor must NOT be claimed keep').toBeUndefined();
    const cfg = (root.children.find((c) => c.name === 'Web')!.userData.realvirtual as Record<string, unknown>)
      .RibbonPath as Record<string, unknown>;
    expect(cfg.Material, 'the reference that would keep the donor alive is dropped with it').toBeUndefined();

    const bakeRegistry = new BakeRegistry();
    const placed = await bakeAndPlace(root, bakeRegistry);
    const drawn: Object3D[] = [];
    placed.template.traverse((n) => { if ((n as Mesh).isMesh) drawn.push(n); });
    expect(drawn, 'the donor quad must not reach the scene as a drawable mesh').toHaveLength(0);
    expect(placed.baked.chunks, 'no chunk, so no draw call').toHaveLength(0);

    // ... and the material is still resolvable, which is the whole point of the donor.
    registerMaterialIndex(placed.template, index);
    expect(findMaterialByName(placed.template, DONOR_MATERIAL)?.name).toBe(DONOR_MATERIAL);
  });

  it('still claims a LEGACY Material node, whose material the band reads from the live graph', async () => {
    registerBuiltInPreBakeHooks();
    const { root, donor } = buildTree('LegacyDonor');

    runPreBakeHooks(root);

    expect(donor.visible).toBe(true);
    const role = (donor.userData?.realvirtual as Record<string, unknown> | undefined)?.BakeRole;
    expect(role, 'a legacy donor must survive the bake - the band copies its material at init')
      .toBe('keep');
  });

  it('registers the material under the authored NAME as well, not only under the node path', () => {
    registerBuiltInPreBakeHooks();
    const { root } = buildTree('Web_MaterialDonor', { MaterialName: DONOR_MATERIAL });
    const result = runPreBakeHooks(root);
    expect(result.materials.get(DONOR_MATERIAL)?.name).toBe(DONOR_MATERIAL);
  });
});
