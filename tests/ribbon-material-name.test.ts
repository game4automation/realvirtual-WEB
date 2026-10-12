// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-material-name.test.ts — `MaterialName` resolution against the document (plan-496).
 *
 * The browser has no ribbon texture library of its own; the roller textures live in the private
 * repository and a public viewer would show nothing. So a NAME is resolved against the materials of
 * the LOADED DOCUMENT, and Unity's GLB export makes sure the named materials are in it (the roller
 * override lands on the renderers, the band material on a `_MaterialDonor` quad).
 *
 * The two rules pinned here are the ones that make Unity and the browser agree:
 *
 * 1. exact match first, then case-insensitively, first match wins — the same rule as
 *    `RibbonMaterialLibrary.TryGet`, never a substring match;
 * 2. `MaterialName` beats the legacy `Material` node reference, on both sides.
 *
 * And the two failure modes that are easy to get wrong: a material without a map must still be
 * usable (a project material is not necessarily textured), and two materials that LOOK identical but
 * carry different names must stay distinguishable — the index is keyed by name, not by appearance.
 */

import { describe, it, expect } from 'vitest';
import { Mesh, MeshStandardMaterial, Object3D, PlaneGeometry } from 'three';
import {
  collectMaterialsByName, findMaterialByName, registerMaterialIndex,
} from '../src/core/engine/rv-pre-bake';
import { ribbonHarness, transformRef } from './ribbon-fixture';
import type { RVRibbonPath } from '../src/core/engine/rv-ribbon-path';

/** A mesh carrying one named material, parented under `parent`. */
function meshWithMaterial(parent: Object3D, nodeName: string, materialName: string,
                          extra: Partial<MeshStandardMaterial> = {}): Mesh {
  const material = new MeshStandardMaterial({ ...extra });
  material.name = materialName;
  const mesh = new Mesh(new PlaneGeometry(0.01, 0.01), material);
  mesh.name = nodeName;
  parent.add(mesh);
  return mesh;
}

describe('document material index', () => {
  it('finds a material by its exact name', () => {
    const root = new Object3D();
    meshWithMaterial(root, 'Donor', 'Paper');
    expect(findMaterialByName(root, 'Paper')?.name).toBe('Paper');
  });

  it('falls back to a case-insensitive match', () => {
    const root = new Object3D();
    meshWithMaterial(root, 'Donor', 'Paper');
    expect(findMaterialByName(root, 'pApEr')?.name).toBe('Paper');
  });

  it('never matches a substring', () => {
    const root = new Object3D();
    meshWithMaterial(root, 'Donor', 'Paper');
    expect(findMaterialByName(root, 'Pap')).toBeNull();
    expect(findMaterialByName(root, 'PaperWhite')).toBeNull();
  });

  it('returns null for a missing name and for an empty one', () => {
    const root = new Object3D();
    meshWithMaterial(root, 'Donor', 'Paper');
    expect(findMaterialByName(root, 'Helix')).toBeNull();
    expect(findMaterialByName(root, '')).toBeNull();
  });

  it('resolves an UNTEXTURED project material just as well', () => {
    const root = new Object3D();
    const mesh = meshWithMaterial(root, 'Donor', 'PlainSteel');
    expect((mesh.material as MeshStandardMaterial).map).toBeNull();
    expect(findMaterialByName(root, 'PlainSteel')).toBe(mesh.material);
  });

  it('keeps two identical-looking materials apart by name', () => {
    const root = new Object3D();
    const a = meshWithMaterial(root, 'A', 'Paper', { roughness: 0.85 });
    const b = meshWithMaterial(root, 'B', 'Film', { roughness: 0.85 });
    expect(findMaterialByName(root, 'Paper')).toBe(a.material);
    expect(findMaterialByName(root, 'Film')).toBe(b.material);
    expect(findMaterialByName(root, 'Paper')).not.toBe(b.material);
  });

  it('takes the FIRST occurrence of a duplicated name, like three.js GLTFLoader', () => {
    const root = new Object3D();
    const first = meshWithMaterial(root, 'A', 'Paper');
    meshWithMaterial(root, 'B', 'Paper');
    expect(collectMaterialsByName(root).get('Paper')).toBe(first.material);
  });

  it('prefers a REGISTERED index over a subtree scan and finds it from a descendant', () => {
    // This is what a baked document does: the index was taken BEFORE the dedup/uber passes
    // replaced and renamed the materials, and the meshes below no longer carry those names.
    const root = new Object3D();
    const child = new Object3D();
    root.add(child);
    const baked = meshWithMaterial(child, 'Chunk', '__rvUberMaterial');
    const original = new MeshStandardMaterial();
    original.name = 'Paper';
    registerMaterialIndex(root, new Map([['Paper', original]]));

    expect(findMaterialByName(child, 'Paper')).toBe(original);
    expect(findMaterialByName(child, '__rvUberMaterial')).toBeNull();
    expect(baked.material).not.toBe(original);
  });
});

describe('RibbonPath.MaterialName', () => {
  /** A two-roller web plus a donor mesh carrying `materialName`, under the harness root. */
  function harnessWithMaterial(materialName: string, overrides: Record<string, unknown> = {}) {
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 100, driven: true },
      { name: 'B', xMm: 1000, yMm: 0, radiusMm: 100 },
    ]);
    const donor = meshWithMaterial(h.root, 'Web_MaterialDonor', materialName, { roughness: 0.25 });
    h.registry.registerNode('Root/Web_MaterialDonor', donor);
    h.scene.updateMatrixWorld(true);
    const path = h.buildPath(overrides) as RVRibbonPath;
    return { h, path, donor };
  }

  it('uses the document material the name points at', () => {
    const { path, donor } = harnessWithMaterial('Paper', { MaterialName: 'Paper' });
    const band = (path as unknown as { _band: { groupMaterial(g: number): MeshStandardMaterial | null } })._band;
    const used = band.groupMaterial(0)!;
    // A CLONE, never the document material itself: the band scales and scrolls its textures.
    expect(used).not.toBe(donor.material);
    expect(used.roughness).toBeCloseTo(0.25, 6);
  });

  it('wins over the legacy Material node reference', () => {
    const h = ribbonHarness([
      { name: 'A', xMm: 0, yMm: 0, radiusMm: 100, driven: true },
      { name: 'B', xMm: 1000, yMm: 0, radiusMm: 100 },
    ]);
    const legacy = meshWithMaterial(h.root, 'Legacy', 'LegacyDonor', { roughness: 0.9, metalness: 0.1 });
    h.registry.registerNode('Root/Legacy', legacy);
    meshWithMaterial(h.root, 'Web_MaterialDonor', 'Paper', { roughness: 0.25, metalness: 0.7 });
    h.scene.updateMatrixWorld(true);

    const path = h.buildPath({
      MaterialName: 'Paper',
      Material: transformRef('Root/Legacy'),
    }) as RVRibbonPath;
    const band = (path as unknown as { _band: { groupMaterial(g: number): MeshStandardMaterial | null } })._band;
    const used = band.groupMaterial(0)!;
    expect(used.metalness).toBeCloseTo(0.7, 6);
    expect(used.roughness).toBeCloseTo(0.25, 6);
  });

  it('falls back to the default band pattern when the name is not in the document', () => {
    const { path } = harnessWithMaterial('Paper', { MaterialName: 'NoSuchMaterial' });
    const band = (path as unknown as { _band: { groupMaterial(g: number): MeshStandardMaterial | null } })._band;
    // The generated paper-white pattern, so a wrong name never leaves an invisible web.
    expect(band.groupMaterial(0)!.map).not.toBeNull();
  });
});
