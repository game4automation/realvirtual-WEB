// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 structure hardening (2026-09-17) — deferral does not hang on the
 * layout-planner plugin any more.
 *
 * `RVViewer` owns the placement instancer (`viewer.placements`). A runtime
 * `loadModel` of a layout document ALWAYS defers its `AssetReference` +
 * `PlacementMeta` occurrences; with no planner to claim them the core
 * materialises them after the load: ONE `BakedAsset` per asset, N instances,
 * no CAD hierarchy / source mesh of an occurrence in the scene graph, and the
 * occurrences' drives / sensors registered exactly where a planner-registered
 * placement puts them (`integratePlacedContent`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { getDeferredPlacement, setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { collectPlacementNodes } from '../src/core/hmi/scene/rv-scene-glb-read';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { withComponent, group } from './fixtures/bake-fixture';

const ASSET_URL = 'blob:rv-test/no-planner-machine.glb';
const MISSING_URL = 'blob:rv-test/no-planner-missing.glb';
const CATALOG_ID = 'cat:no-planner-machine';

function box(name: string, pos: [number, number, number], color: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color }));
  mesh.name = name;
  mesh.position.set(...pos);
  return mesh;
}

/** Machine: frame + Drive-A{arm} + Sensor-1{beam}. */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(box('frame', [0, 0.5, 0], 0x336699));
  const drive = withComponent(group('Drive-A'), 'Drive', { Direction: 'LinearX', TargetSpeed: 100 });
  drive.add(box('arm', [2, 0.5, 0], 0x993333));
  root.add(drive);
  const sensor = withComponent(group('Sensor-1'), 'Sensor', { UseRaycast: false });
  sensor.add(box('beam', [0, 0.5, 2], 0x339933));
  root.add(sensor);
  return root;
}

interface Spec { id: string; name: string; position: [number, number, number]; url?: string; assetId?: string; visible?: boolean }

async function documentBytes(specs: Spec[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  for (const s of specs) {
    const node = new Object3D();
    node.name = s.name;
    node.position.set(...s.position);
    setNodeId(node, s.id);
    setAssetReference(node, { assetId: s.assetId ?? CATALOG_ID, path: s.url ?? ASSET_URL });
    setPlacementMeta(node, s.visible === false ? { visible: false } : {});
    root.add(node);
  }
  return objectToGlb(root);
}

const SPECS: Spec[] = [
  { id: 'plc_1', name: 'Machine', position: [0, 0, 0] },
  { id: 'plc_2', name: 'Machine_2', position: [5, 0, 0] },
  { id: 'plc_3', name: 'Machine_3', position: [10, 0, 2], visible: false },
];

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

async function bootAndLoad(specs: Spec[]): Promise<{ handle: TestViewerHandle; decodes: string[] }> {
  const h = await createTestViewer('webgl');
  handle = h;
  expect(h.viewer.getPlugin('layout-planner'), 'this viewer has NO planner plugin').toBeFalsy();
  const decodes: string[] = [];
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      decodes.push(url);
      if (url === MISSING_URL) throw new Error('404');
      return { scene: makeAsset() };
    },
  } as unknown as GLTFLoader;
  h.viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => h.viewer.placementUberMaterial,
    isWebGPU: () => h.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  await h.viewer.loadModel('layout.glb', { data: await documentBytes(specs) });
  await h.viewer.placements.whenMaterialized();
  return { handle: h, decodes };
}

describe('layout document in a viewer WITHOUT the layout planner (plan-753)', () => {
  it('3 occurrences → 1 BakedAsset, 3 instances, no source meshes, drives + sensors registered', async () => {
    const { handle: h, decodes } = await bootAndLoad(SPECS);
    const viewer = h.viewer;
    const model = (viewer as unknown as { currentModel: Object3D }).currentModel;

    // ONE decode, ONE bake, three instances sharing the chunk geometry.
    expect(decodes).toEqual([ASSET_URL]);
    const stats = viewer.placements.getBakeStats();
    expect(stats.assets).toBe(1);
    expect(stats.instances).toBe(3);

    const roots = collectPlacementNodes(model).map((e) => e.node);
    expect(roots).toHaveLength(3);
    const instances = roots.map((r) => viewer.bakeRegistry.instanceOf(r)!);
    for (const inst of instances) {
      expect(inst, 'every occurrence is a bake instance').not.toBeNull();
      expect(inst.identity, 'a planner occurrence is a CLONED placement').toBe(false);
      expect(inst.baked).toBe(instances[0].baked);
      expect(inst.chunks.length).toBeGreaterThan(0);
    }
    const geometries = (i: typeof instances[number]): Set<unknown> => new Set(i.chunks.map((m) => m.geometry));
    expect(geometries(instances[1])).toEqual(geometries(instances[0]));
    expect(geometries(instances[2])).toEqual(geometries(instances[0]));

    // No CAD hierarchy of an occurrence and nothing masked — after plan-754
    // the merged leaves are REMOVED, so a plain traverse must not find them.
    let cadLeaves = 0; let masked = 0;
    model.traverse((n) => {
      if (n.name === 'frame' || n.name === 'arm' || n.name === 'beam') cadLeaves++;
      const m = n as Mesh;
      if (m.isMesh && m.layers.mask === 0) masked++;
    });
    expect({ cadLeaves, masked }).toEqual({ cadLeaves: 0, masked: 0 });
    for (const r of roots) expect(getDeferredPlacement(r)).toBeNull();

    // Runtime registration — the paths a planner-registered placement gets.
    const reg = viewer.registry!;
    for (const r of roots) {
      const path = reg.getPathForNode(r)!;
      expect(path, `${r.name} is registered`).toBeTruthy();
      expect(reg.getNode(`${path}/Drive-A`), `${path}/Drive-A`).toBeTruthy();
      expect(reg.getNode(`${path}/Sensor-1`), `${path}/Sensor-1`).toBeTruthy();
      expect(r.userData._layoutObject).toBe(true);
      expect(r.matrixWorldAutoUpdate).toBe(true);
    }
    expect(viewer.drives.filter((d) => d.node.name === 'Drive-A')).toHaveLength(3);
    expect(reg.getAll('Sensor').length).toBe(3);
    expect(reg.getAll('Drive').length).toBe(3);

    // The saved visibility flag of the reference is honoured.
    expect(roots[0].visible).toBe(true);
    expect(roots[2].visible).toBe(false);

    // Document change: instances released FIRST, then the bakes retired.
    const baked = instances[0].baked;
    viewer.clearModel();
    expect(viewer.bakeRegistry.stats().instances).toBe(0);
    expect(baked.disposed).toBe(true);
    expect(viewer.placements.getBakeStats().assets).toBe(0);
  });

  it('an unloadable asset becomes the missing-reference placeholder; the others still land', async () => {
    const { handle: h } = await bootAndLoad([
      SPECS[0],
      { id: 'plc_gone', name: 'Gone', position: [3, 0, 3], url: MISSING_URL, assetId: 'cat:gone' },
    ]);
    const viewer = h.viewer;
    const model = (viewer as unknown as { currentModel: Object3D }).currentModel;
    const byName = new Map(collectPlacementNodes(model).map((e) => [e.node.name, e.node]));
    expect(viewer.bakeRegistry.instanceOf(byName.get('Machine')!)).not.toBeNull();
    const gone = byName.get('Gone')!;
    expect(viewer.bakeRegistry.instanceOf(gone)).toBeNull();
    expect(gone.children.length, 'the hole you can see').toBe(1);
    expect(gone.children[0].type).toBe('LineSegments');
  });

  it('the viewer always defers runtime loads — the flag does not ask for a plugin', async () => {
    const source = (await import('../src/core/rv-viewer.ts?raw')).default as string;
    expect(source).toContain('deferPlacements: true,');
    expect(source).not.toContain("deferPlacements: !!this.getPlugin('layout-planner')");
    expect(source).toContain('this.placements.materializeDeferred(collectDeferredPlacements(result.root, this._currentModelScope))');
  });
});
