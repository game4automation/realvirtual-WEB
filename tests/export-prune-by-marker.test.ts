// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The save keeps authored content whatever its name (data-loss finding, 2026-11-04).
 *
 * The export prune, the loader strip and the editor ops used to drop nodes BY
 * NAME (`*_sensorRay`, `*_sensorViz`, `_tankFillViz`, `__rvEnergyChainBones`,
 * `__raycastBVH*`) — an authored node with such a name vanished on save. Now:
 * only MARKER-confirmed runtime helpers leave the file, and old files with
 * unmarked sensor viz are migrated on LOAD by one narrow rule
 * (`isLegacySensorVizChild`, rv-sensor-viz-names.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { stripPersistedSensorViz } from '../src/core/engine/rv-prepare-and-bake';
import { detectRenamedNodes } from '../src/core/engine/rv-glb-parse';
import { isLegacySensorVizChild, isSensorRuntimeVizName } from '../src/core/engine/rv-sensor-viz-names';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { CADLinkExtras } from '../src/core/editor/rv-asset-ops';

function mesh(name: string, color = 0x808080): Mesh {
  const m = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color }));
  m.name = name;
  return m;
}

/** Authored node with a component and a child. */
function lampWithChild(name: string): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { Lamp: {} };
  n.add(mesh(`${name}Child`));
  return n;
}

/** Every authored name collision the old name rules dropped. */
const AUTHORED = ['Odd_sensorRay', 'OddL_sensorRay', '_tankFillViz', '__rvEnergyChainBones', '__raycastBVH_auth'];

function authoredDocument(): Group {
  const root = new Group();
  root.name = 'Asset';
  root.add(mesh('Base'));
  root.add(mesh('Odd_sensorRay'));            // plain leaf, no extras
  root.add(lampWithChild('OddL_sensorRay'));  // Lamp + child
  root.add(lampWithChild('_tankFillViz'));
  const bones = new Object3D();
  bones.name = '__rvEnergyChainBones';
  bones.add(mesh('BoneChild'));
  root.add(bones);
  root.add(mesh('__raycastBVH_auth'));
  return root;
}

function namesIn(root: Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((n) => out.add(n.name));
  return out;
}

async function reparse(glb: ArrayBuffer): Promise<Object3D> {
  return (await new GLTFLoader().parseAsync(glb, '')).scene;
}

function ctx(): ComponentContext {
  return {
    signalStore: { register: () => {}, set: () => {}, setByPath: () => {} },
    transportManager: { sensors: [] },
  } as unknown as ComponentContext;
}

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

describe('save keeps authored nodes with helper names', () => {
  it('save + reload: every authored collision survives (plain leaf, Lamp + child, tank-fill, bones, BVH name)', async () => {
    const glb = await exportAssetGlb(authoredDocument(), 'Asset');
    const names = namesIn(await reparse(glb));
    for (const n of AUTHORED) expect(names.has(n), n).toBe(true);
    for (const n of ['OddL_sensorRayChild', '_tankFillVizChild', 'BoneChild']) expect(names.has(n), n).toBe(true);
  });

  it('the load strip (bake path) leaves them all, so the runtime view draws them', async () => {
    const tree = await reparse(await exportAssetGlb(authoredDocument(), 'Asset'));
    expect(stripPersistedSensorViz(tree)).toBe(0);
    const names = namesIn(tree);
    for (const n of AUTHORED) expect(names.has(n), n).toBe(true);
  });

  it('an authoring load keeps them in the editor tree', async () => {
    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('authored.glb', { data: await exportAssetGlb(authoredDocument(), 'Asset'), preserveHierarchy: true });
    const names = namesIn(handle.viewer.currentModelRoot!);
    for (const n of AUTHORED) expect(names.has(n), n).toBe(true);
  });
});

describe('real runtime helpers are not saved', () => {
  it('a real sensor viz and a real tank-fill overlay leave the file', async () => {
    const root = new Group();
    root.name = 'Asset';
    const barrier = new Object3D();
    barrier.name = 'Barrier';
    root.add(barrier);
    const s = new RVSensor(barrier, new AABB());
    s.UseRaycast = true;
    s.RayCastLength = 500;
    s.init(ctx());
    const vessel = mesh('Vessel');
    const overlay = mesh('Vessel_fillOverlay');
    overlay.userData._tankFillViz = true; // what rv-tank-fill sets at creation
    vessel.add(overlay);
    root.add(vessel);
    expect(barrier.children.some((c) => isSensorRuntimeVizName(c.name))).toBe(true);

    const names = namesIn(await reparse(await exportAssetGlb(root, 'Asset')));
    expect([...names].filter((n) => isSensorRuntimeVizName(n))).toEqual([]);
    expect(names.has('Vessel_fillOverlay')).toBe(false);
    expect(names.has('Vessel')).toBe(true);
  });
});

describe('legacy migration of old files (load only, exact old shape)', () => {
  /** An old file: a Sensor node carrying persisted, unmarked viz children. */
  function legacyFile(): Group {
    const root = new Group();
    root.name = 'Old';
    const barrier = new Object3D();
    barrier.name = 'Barrier';
    barrier.userData.realvirtual = { Sensor: { UseRaycast: true, RayCastLength: 500 } };
    barrier.add(mesh('Housing'));
    barrier.add(mesh('Barrier_sensorRay'), mesh('Barrier_sensorRay_1'), mesh('Barrier_sensorViz'));
    root.add(barrier);
    const plain = new Object3D();
    plain.name = 'Plain'; // NO Sensor component
    plain.add(mesh('Plain_sensorRay'));
    root.add(plain);
    return root;
  }

  it('the rule takes only a viz-shaped leaf directly under a Sensor node', () => {
    const root = legacyFile();
    const barrier = root.getObjectByName('Barrier')!;
    const plain = root.getObjectByName('Plain')!;
    expect(isLegacySensorVizChild(barrier.getObjectByName('Barrier_sensorRay')!, barrier)).toBe(true);
    expect(isLegacySensorVizChild(barrier.getObjectByName('Housing')!, barrier)).toBe(false);
    expect(stripPersistedSensorViz(root)).toBe(3);
    expect(barrier.children.map((c) => c.name)).toEqual(['Housing']);
    expect(plain.children.map((c) => c.name), 'no Sensor on the parent: authored').toEqual(['Plain_sensorRay']);
  });

  it('three dedups parent and child independently: two `Barrier` sensors still lose their legacy beams', async () => {
    const root = new Group();
    root.name = 'Old';
    for (let i = 0; i < 2; i++) {
      const b = new Object3D();
      b.name = 'Barrier';
      b.position.x = i * 2;
      b.userData.realvirtual = { Sensor: { UseRaycast: true, RayCastLength: 500 } };
      b.add(mesh('Barrier_sensorRay'));
      root.add(b);
    }
    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('dup.glb', { data: await objectToGlb(root), preserveHierarchy: true });
    const model = handle.viewer.currentModelRoot!;
    const barriers: Object3D[] = [];
    model.traverse((n) => { if (n.userData.realvirtual?.Sensor) barriers.push(n); });
    expect(barriers.map((b) => b.name).sort()).toEqual(['Barrier', 'Barrier_1']);
    for (const b of barriers) {
      const beams = b.children.filter((c) => isSensorRuntimeVizName(c.name));
      expect(beams.length, `${b.name}: one beam`).toBe(1);
      expect(beams[0].userData._rvRuntimeVisual, `${b.name}: the fresh, marked one`).toBe(true);
    }
    const saved = namesIn(await reparse(await exportAssetGlb(model, 'Old')));
    expect([...saved].filter((n) => isSensorRuntimeVizName(n)), 'no beam saved again').toEqual([]);
  });

  it('a convention-named sensor with a legacy beam: load + save + bake -> exactly one sensor, beam gone', async () => {
    const root = new Group();
    root.name = 'Old';
    const infeed = new Object3D();
    infeed.name = 'Sensor-Infeed'; // no extras: the naming scan makes it a Sensor
    infeed.add(mesh('Body'));
    infeed.add(mesh('Sensor-Infeed_sensorRay')); // visible legacy beam, ALSO matches `Sensor-<id>`
    root.add(infeed);
    root.add(mesh('Floor'));

    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('conv.glb', { data: await objectToGlb(root), preserveHierarchy: true });
    expect(handle.viewer.transportManager!.sensors.map((s) => s.node.name)).toEqual(['Sensor-Infeed']);
    const saved = await exportAssetGlb(handle.viewer.currentModelRoot!, 'Old');
    expect([...namesIn(await reparse(saved))].filter((n) => isSensorRuntimeVizName(n))).toEqual([]);
    handle.dispose();

    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('conv-baked.glb', { data: await objectToGlb(root) });
    expect(handle.viewer.transportManager!.sensors.map((s) => s.node.name), 'bake path').toEqual(['Sensor-Infeed']);
  });

  it('a viz-shaped leaf with OTHER glTF extras (partNumber, description) is authored: survives load, strip and save with its metadata', async () => {
    const root = new Group();
    root.name = 'Old';
    const infeed = new Object3D();
    infeed.name = 'Sensor-Infeed';
    infeed.add(mesh('Body'));
    const leaf = mesh('Sensor-Infeed_sensorRay');
    leaf.userData.partNumber = 'PN-4711';                 // written by an external authoring tool
    leaf.userData.description = 'Lens cover';
    infeed.add(leaf);
    root.add(infeed);
    const bytes = await objectToGlb(root);

    // GLTFLoader round trip: the extras arrive as userData; the strip (bake path) keeps it.
    const parsed = await reparse(bytes);
    expect(stripPersistedSensorViz(parsed)).toBe(0);
    expect(parsed.getObjectByName('Sensor-Infeed_sensorRay')?.userData.partNumber).toBe('PN-4711');

    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('meta.glb', { data: bytes, preserveHierarchy: true });
    const kept = handle.viewer.currentModelRoot!.getObjectByName('Sensor-Infeed_sensorRay');
    expect(kept?.userData._rvRuntimeVisual, 'the authored leaf, not a fresh beam').not.toBe(true);
    expect(kept?.userData.description).toBe('Lens cover');
    const saved = await reparse(await exportAssetGlb(handle.viewer.currentModelRoot!, 'Old'));
    const savedLeaf = saved.getObjectByName('Sensor-Infeed_sensorRay');
    expect(savedLeaf, 'saved').toBeDefined();
    expect(savedLeaf!.userData.partNumber).toBe('PN-4711');
    expect(savedLeaf!.userData.description).toBe('Lens cover');
  });

  it('the SHIPPED welding file: every real old beam (extras only `name`) is still removed on load', async (tctx) => {
    let bytes: ArrayBuffer | null = null;
    for (const url of ['/demo-realvirtual/LaserWeldingAssemblyStation.glb', '/public/demo-realvirtual/LaserWeldingAssemblyStation.glb']) {
      try {
        const res = await fetch(url);
        if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) { bytes = await res.arrayBuffer(); break; }
      } catch { /* next */ }
    }
    if (!bytes) { tctx.skip('demo GLB not served'); return; }
    // As the loader does: parse, then stamp the authored names (three dedups file-wide).
    const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '');
    detectRenamedNodes(gltf.parser as unknown as Parameters<typeof detectRenamedNodes>[0]);
    const parsed = gltf.scene;
    let before = 0;
    parsed.traverse((n) => { if (isSensorRuntimeVizName(n.name)) before++; });
    expect(before, 'the shipped file still carries legacy beams').toBe(22);
    expect(stripPersistedSensorViz(parsed)).toBe(22);
    let after = 0;
    parsed.traverse((n) => { if (isSensorRuntimeVizName(n.name)) after++; });
    expect(after).toBe(0);
  }, 120_000);

  it('authoring load of an old file: the legacy viz is removed, the sensor draws exactly one fresh, marked beam', async () => {
    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('old.glb', { data: await objectToGlb(legacyFile()), preserveHierarchy: true });
    const model = handle.viewer.currentModelRoot!;
    const barrier = model.getObjectByName('Barrier')!;
    const beams = barrier.children.filter((c) => isSensorRuntimeVizName(c.name));
    expect(beams.map((c) => c.name)).toEqual(['Barrier_sensorRay']);
    expect(beams[0].userData._rvRuntimeVisual).toBe(true);
    expect(model.getObjectByName('Plain')!.children.map((c) => c.name)).toEqual(['Plain_sensorRay']);
  });
});

// ─── Editor import: the fourth GLB entry (parseGlbSubtree) migrates too ──

function mockEditorViewer(): { viewer: RVViewer; model: Group } {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  registry.registerNode(NodeRegistry.computeNodePath(model), model);
  const viewer = {
    scene, registry, signalStore: null, transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return { viewer, model };
}

describe('editor import migrates legacy sensor viz (no fourth path)', () => {
  it('importCad of an old GLB: the legacy beam is gone after save + reload, the authored leaf with metadata stays', async () => {
    const tree = new Group();
    tree.name = 'Machine';
    const barrier = new Object3D();
    barrier.name = 'Barrier';
    barrier.userData.realvirtual = { Sensor: { UseRaycast: true, RayCastLength: 500 } };
    barrier.add(mesh('Housing'));
    barrier.add(mesh('Barrier_sensorRay'));               // legacy beam (old auto-generated shape)
    const authored = mesh('Barrier_sensorRay_7');        // same shape, but authored metadata
    authored.userData.partNumber = 'PN-7';
    barrier.add(authored);
    tree.add(barrier);

    const { viewer, model } = mockEditorViewer();
    const doc = scratchAssetDocument(viewer);
    try {
      const cadlink: CADLinkExtras = {
        File: 'machine.glb', Sha256: `legacy-${Date.now()}-${Math.random()}`, Quality: 'standard', ImportScaleFactor: 1, ZIsUpVector: false,
      };
      await doc.importCad({ glb: await objectToGlb(tree), cadlink });
      await doc.whenIdle();
      const imported = model.getObjectByName('Barrier')!;
      expect(imported.children.map((c) => c.name).sort(), 'import migrated').toEqual(['Barrier_sensorRay_7', 'Housing']);

      const saved = await exportAssetGlb(model, 'Asset');
      handle = await createTestViewer('webgl');
      await handle.viewer.loadModel('reloaded.glb', { data: saved, preserveHierarchy: true });
      const reloaded = handle.viewer.currentModelRoot!.getObjectByName('Barrier')!;
      const unmarkedViz = reloaded.children.filter((c) => isSensorRuntimeVizName(c.name) && c.userData._rvRuntimeVisual !== true);
      expect(unmarkedViz.map((c) => c.name), 'only the authored leaf').toEqual(['Barrier_sensorRay_7']);
      expect(unmarkedViz[0].userData.partNumber).toBe('PN-7');
    } finally {
      doc.dispose();
    }
  });
});
