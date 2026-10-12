// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 2b (F8) — the embed facade places references.
 *
 * `RVEmbedViewer` has no `RVViewer`; since Phase 2b it owns the SAME engine
 * `PlacementInstancer` over a `PlacementHost` built from its load result. A
 * runtime load grafts nothing (D7), so without the instancer a document that
 * references another asset would be a scene of empty reference nodes. Smoke:
 * a layout with ONE reference (`data:` url, real loader, real recipe) →
 * `loadModel` resolves with the placement materialised, its drive registered
 * and ticking through the facade's own `step()`; a second load releases it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Group } from 'three';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { findByName, innerDataUrl, plainBytes, referenceNode } from './helpers/nested-placement-fixture';

let viewer: RVEmbedViewer | null = null;
afterEach(() => { viewer?.dispose(); viewer = null; });

async function layoutBytes(innerUrl: string): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  root.add(referenceNode('Cell_1', 'plc-cell', innerUrl, true, [10, 0, 0], 'cat:cell'));
  return objectToGlb(root);
}

describe('RVEmbedViewer — a reference is a placement in the embed too (F8)', () => {
  it('loadModel resolves scene-complete: the placement is an instance, its drive is registered and ticks', async () => {
    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    const result = await viewer.loadModel('layout.glb', await layoutBytes(await innerDataUrl()));

    const instancer = viewer.placementInstancer;
    expect(instancer.state).toBe('idle');
    expect(instancer.progress).toMatchObject({ total: 1, materialized: 1, pending: 0, missing: 0 });
    const cell = findByName(result.root, 'Cell_1')!;
    const inst = instancer.instanceOf(cell);
    expect(inst, 'the reference node is a placement instance').not.toBeNull();
    expect(inst!.chunks.length, 'chunk meshes of the placed asset').toBeGreaterThan(0);
    let chunks = 0;
    cell.traverse((o) => { if (o.userData?.[RV_BAKE_CHUNK_KEY] === true) chunks++; });
    expect(chunks).toBe(inst!.chunks.length);

    // Runtime registration through the host: registry path, drive list of THIS load result.
    expect(result.registry.getNode('Layout/Cell_1/Slide')).toBeTruthy();
    const slideDrive = result.drives.find((d) => d.node.name === 'Slide');
    expect(slideDrive, 'the placed drive joined result.drives').toBeTruthy();

    // The facade's own fixed-step pipeline moves it (JogForward authored in the asset).
    const slide = findByName(cell, 'Slide')!;
    const x0 = slide.position.x;
    for (let i = 0; i < 60; i++) viewer.step(1 / 60, { render: false });
    expect(Math.abs(slide.position.x - x0)).toBeGreaterThan(0.1);
  });

  it('a second load releases the previous document\'s placements (nothing leaks between documents)', async () => {
    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    await viewer.loadModel('layout.glb', await layoutBytes(await innerDataUrl()));
    expect(viewer.placementInstancer.getBakeStats().instances).toBe(1);
    await viewer.loadModel('plain.glb', await plainBytes());
    expect(viewer.placementInstancer.getBakeStats()).toMatchObject({ assets: 0, instances: 0 });
    expect(viewer.placementInstancer.progress).toMatchObject({ total: 0, materialized: 0, pending: 0 });
  });
});
