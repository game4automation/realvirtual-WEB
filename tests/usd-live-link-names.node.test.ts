// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { exportRuntimeStage } from '../src/core/usd/runtime-stage-export';
import { RESERVED_PRIM_NAMES } from '../src/core/usd/usd-prim-names';
import { mountPrims } from './helpers/usd-live-link-stage';

function named(name: string): Object3D { const node = new Object3D(); node.name = name; return node; }

describe('Live-Link sibling names in the mount file', () => {
  it('avoids exporter Geometry collisions and maps every snapshot index to the written prim', async () => {
    const root = named('Cell');
    const mesh = new Mesh(new BoxGeometry(), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    mesh.name = 'Part'; mesh.add(named('Geometry')); root.add(mesh);
    for (const name of RESERVED_PRIM_NAMES) root.add(named(name));
    const stage = await exportRuntimeStage({ root, templates: [], exclude: new Set(), preplaced: [] });
    const prims = mountPrims(stage.usdz); // rejects duplicate sibling paths
    expect([...prims.keys()]).toContain('/Root/Scenes/Scene/Cell/Part/Geometry');
    expect([...prims.keys()]).toContain('/Root/Scenes/Scene/Cell/Part/Geometry_1');
    for (const path of stage.primPaths) expect(prims.has(path), path).toBe(true);
    for (const name of RESERVED_PRIM_NAMES) expect(stage.primPaths).toContain(`/Root/Scenes/Scene/Cell/${name}_1`);
    expect(root.children[0].children[0].name).toBe('Geometry');
  });
  it('keeps A/Body and B/Body unsuffixed and allocates duplicates only among siblings', async () => {
    const root = named('Cell'), a = named('A'), b = named('B');
    root.add(a, b); a.add(named('Body'), named('Body')); b.add(named('Body'));
    const stage = await exportRuntimeStage({ root, templates: [], exclude: new Set(), preplaced: [] });
    expect(stage.primPaths).toEqual([
      '/Root/Scenes/Scene/Cell', '/Root/Scenes/Scene/Cell/A',
      '/Root/Scenes/Scene/Cell/A/Body', '/Root/Scenes/Scene/Cell/A/Body_2',
      '/Root/Scenes/Scene/Cell/B', '/Root/Scenes/Scene/Cell/B/Body',
    ]);
    const prims = mountPrims(stage.usdz);
    for (const path of stage.primPaths) expect(prims.has(path), path).toBe(true);
  });
});
