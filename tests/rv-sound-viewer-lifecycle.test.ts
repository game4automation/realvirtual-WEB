// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 fix round 1 (#1, #14) — the Sound lifecycle on a REAL viewer, with
 * nothing disposed by hand: load model A → load model B → drop a placement with a
 * Sound → remove it → dispose the viewer. `RVViewer.clearModel()` disposes no
 * components generically, so the SoundSystem plugin must take the old Sounds out
 * itself; a placement removal reaches `RVSound.dispose()` through
 * `disposeComponentsInSubtree`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { disposePlacedRoot, integratePlacedContent } from '../src/core/engine/rv-placement-integrate';
import { getRegisteredSounds, type RVSound } from '../src/core/engine/rv-sound';
import { SoundSystemPlugin } from '../src/plugins/sound-system-plugin';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { withComponent, group } from './fixtures/bake-fixture';

const CATALOG_ID = 'cat:sound-lifecycle';
const ASSET_URL = 'blob:rv-test/sound-lifecycle.glb';

function box(name: string, pos: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x336699 }));
  mesh.name = name;
  mesh.position.set(...pos);
  return mesh;
}

/** A document with one sounding axis (Drive + Sound on the same node). */
async function modelBytes(rootName: string, axisName: string): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = rootName;
  root.add(box('Frame', [0, 0, 0]));
  const axis = new Object3D();
  axis.name = axisName;
  axis.userData.realvirtual = {
    Drive: { Direction: 'LinearX', TargetSpeed: 100 },
    Sound: { Kind: 'Drive', Variant: 'Large', Volume: 1 },
  };
  axis.add(box('Slide', [0, 0.5, 0]));
  root.add(axis);
  return objectToGlb(root);
}

/** A planner asset: frame + a sounding transport drive. */
function makeAsset(): Group {
  const root = group('Conveyor');
  root.add(box('frame', [0, 0.5, 0]));
  const drive = withComponent(group('Transport'), 'Drive', { Direction: 'LinearX', TargetSpeed: 100 });
  drive.userData.realvirtual.Sound = { Kind: 'Drive', Variant: 'Small', Volume: 1 };
  drive.add(box('roll', [0, 0.8, 0]));
  root.add(drive);
  return root;
}

function ownSounds(h: TestViewerHandle): RVSound[] {
  return [...getRegisteredSounds()].filter((s) => s.scene === h.viewer.scene);
}

let handle: TestViewerHandle | null = null;
afterEach(() => {
  handle?.dispose();
  handle = null;
  clearAllProblems();
});

describe('Sound lifecycle on a real viewer (fix round 1 #1)', () => {
  it('model A → model B → placement add/remove → dispose: no Sound outlives its owner', async () => {
    const h = await createTestViewer('webgl');
    handle = h;
    const v = h.viewer;
    const plugin = new SoundSystemPlugin();
    v.use(plugin);
    const loader = { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeAsset() }) } as unknown as GLTFLoader;
    v.placements.setModelCache(new ModelCache(loader, {
      uber: () => v.placementUberMaterial,
      isWebGPU: () => v.isWebGPU,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    }));

    // ── Model A
    await v.loadModel('sound-a.glb', { data: await modelBytes('ModelA', 'AxisA') });
    await v.whenSceneReady();
    const a = ownSounds(h);
    expect(a).toHaveLength(1);
    expect(a[0].node.name).toBe('AxisA');
    expect(a[0].active).toBe(true);
    expect(plugin.sounds).toEqual(a);
    expect(plugin.sceneStore.getSnapshot().count).toBe(1);

    // ── Model B: A's Sound is gone (not in the hub, drive released), only B's is left.
    await v.loadModel('sound-b.glb', { data: await modelBytes('ModelB', 'AxisB') });
    await v.whenSceneReady();
    expect(getRegisteredSounds().has(a[0])).toBe(false);
    expect(a[0].drive).toBeNull();
    const b = ownSounds(h);
    expect(b.map((s) => s.node.name)).toEqual(['AxisB']);
    expect(plugin.sounds).toEqual(b);
    expect(plugin.sceneStore.getSnapshot().count).toBe(1);

    // ── Placement add: its Sound joins this viewer.
    const model = (v as unknown as { currentModel: Object3D }).currentModel;
    const ref = { catalogId: CATALOG_ID, glbUrl: ASSET_URL };
    const baked = await v.placements.resolveBaked(ref);
    const root = v.placements.createRoot(baked);
    model.add(root);
    v.placements.materialize(root, baked, { id: 'plc_sound', label: 'Conveyor', catalogId: CATALOG_ID });
    integratePlacedContent(v, root);
    const withPlacement = ownSounds(h);
    expect(withPlacement).toHaveLength(2);
    expect(plugin.sceneStore.getSnapshot().count).toBe(2);
    const placed = withPlacement.find((s) => s !== b[0])!;
    expect(placed.variant).toBe('Small');

    // ── Placement remove: its Sound leaves, B's stays.
    disposePlacedRoot(v, root);
    expect(getRegisteredSounds().has(placed)).toBe(false);
    expect(ownSounds(h)).toEqual(b);
    expect(plugin.sceneStore.getSnapshot().count).toBe(1);

    // ── Viewer dispose: nothing of this viewer stays in the page-wide hub.
    h.dispose();
    handle = null;
    expect(getRegisteredSounds().has(b[0])).toBe(false);
    expect(plugin.sounds).toEqual([]);
    expect(plugin.sceneStore.getSnapshot().count).toBe(0);
  });
});
