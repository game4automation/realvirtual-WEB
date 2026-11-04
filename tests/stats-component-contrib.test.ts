// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { registerComponent, type ComponentContext, type RVComponent } from '../src/core/engine/rv-component-registry';
import { disposeLoadedSubtree } from '../src/core/engine/rv-scene-loader';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { StatsRegistry, setActiveStatsRegistry, type StatsSectionRegistrar } from '../src/core/stats/rv-stats-registry';
import { createTestViewer } from './helpers/create-test-viewer';
import { setupPlanner, internals } from './_layout-planner-async-harness';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../src/core/engine/rv-model-cache';

const seen: Array<StatsSectionRegistrar | undefined> = [];
class StatsProbe implements RVComponent {
  isOwner = true;
  private unregister?: () => void;
  constructor(readonly node: Object3D) {}
  init(ctx: ComponentContext): void {
    seen.push(ctx.statsRegistry);
    this.unregister = ctx.statsRegistry?.register({
      id: `component:${ctx.registry.getPathForNode(this.node)}:StatsProbe`,
      title: 'Probe', rows: () => [{ key: 'parts', label: 'Parts', value: 3 }],
    });
  }
  dispose(): void { this.unregister?.(); }
}
// unwrapGltfRoot promotes this empty fixture's Probe to the asset root.
// Root components must explicitly opt into being carried onto a placement.
registerComponent({ type: 'StatsProbe', schema: {}, capabilities: { carriesToPlacementRoot: true }, create: node => new StatsProbe(node) });
async function fixture(): Promise<ArrayBuffer> {
  const root = new Group(); root.name = 'StatsAsset';
  const node = new Object3D(); node.name = 'Probe';
  node.userData.realvirtual = { StatsProbe: {} };
  root.add(node);
  return objectToGlb(root);
}
afterEach(() => { seen.length = 0; setActiveStatsRegistry(null); });

it('real GLB loading registers once across reload and clearModel removes the section', async () => {
  const h = await createTestViewer('webgl', { desRunner: false });
  try {
    const data = await fixture();
    await h.viewer.loadModel('stats.glb', { data });
    expect(seen).toContain(h.viewer.componentStats);
    expect(h.viewer.stats.list()).toHaveLength(1);
    await h.viewer.loadModel('stats.glb', { data: data.slice(0) });
    expect(h.viewer.stats.list()).toHaveLength(1);
    h.viewer.clearModel();
    expect(h.viewer.stats.list()).toHaveLength(0);
  } finally { h.dispose(); }
}, 60_000);

it('planner placement registers and removing it unregisters', async () => {
  localStorage.removeItem('rv-layout-autosave');
  const h = setupPlanner();
  const registry = new StatsRegistry();
  setActiveStatsRegistry(registry);
  const url = URL.createObjectURL(new Blob([await fixture()], { type: 'model/gltf-binary' }));
  const cache = new ModelCache(gltfLoader as unknown as GLTFLoader, { pickPort: () => createPickBuildPort({ createWorker: () => null }) });
  h.plugin.placements.setModelCache(cache);
  try {
    await internals(h.plugin)._catalogsLoaded;
    const id = await h.plugin.placeComponent({ id: 'stats-probe', name: 'StatsAsset', category: 'custom', glbUrl: url }, [0, 0, 0]);
    expect(seen).toEqual([registry]);
    expect(registry.list()).toHaveLength(1);
    h.plugin.removePlacementById(id);
    expect(registry.list()).toHaveLength(0);
  } finally {
    h.plugin.dispose(); cache.dispose(); URL.revokeObjectURL(url);
    localStorage.removeItem('rv-layout-autosave');
  }
}, 60_000);

it('a headless load without an active slot still initializes the component', async () => {
  setActiveStatsRegistry(null);
  // Baked like every runtime load (bake-test-path-enforced); the probe fixture draws nothing, so no chunks.
  const result = await loadBakedGLB('stats-headless.glb', new Scene(), {
    data: await fixture(), loadKinematicsSidecar: false, expectChunks: false,
  });
  try { expect(seen).toEqual([undefined]); } finally { disposeLoadedSubtree(result.registry, result.root); }
}, 60_000);
