// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorMonitorPlugin follows placements (Codex contract review, contract-plugins R3).
 *
 * Sensors of placements materialised by the PlacementInstancer AFTER the main
 * load (plan-757: every reference is a placement) must be monitored —
 * `component-event` {componentType:'sensor', kind:'changed'} plus an
 * `eventHistory` entry — and a removed placement must release its listeners.
 * The main-model sensor keeps exactly one listener (no double attach when the
 * main load and a placement event overlap).
 *
 * Codex follow-up: the monitor follows the transport manager's ONE
 * registration point (`addSensor` / `removeSensors` / `clearSensors` →
 * `onSensorsChanged`), not placement announcements — so editor component adds,
 * separate/merge rebuilds (undo/redo) and a gated model's late activation are
 * covered too. No test here emits a synthetic `layout-content-*` event.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BufferAttribute, BufferGeometry, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { disposePlacedRoot } from '../src/core/engine/rv-placement-integrate';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { buildInitContext, type InitContextDeps } from '../src/core/engine/rv-init-context';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { RVViewer as RVViewerClass } from '../src/core/rv-viewer';
import { isSensorRuntimeVizName } from '../src/core/engine/rv-sensor-viz-names';
import { classifySubtree } from '../src/core/editor/rv-mesh-merge';
import { SensorMonitorPlugin } from '../src/plugins/sensor-monitor-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { withComponent, group } from './fixtures/bake-fixture';

const ASSET_URL = 'blob:rv-test/sensor-monitor-machine.glb';

interface ComponentEvent { componentType: string; kind: string; path: string; payload?: { occupied: boolean } }

function box(name: string, pos: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x339933 }));
  mesh.name = name;
  mesh.position.set(...pos);
  return mesh;
}

/** Placed asset: frame + `PlacedSensor{beam}`. */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(box('frame', [0, 0.5, 0]));
  const sensor = withComponent(group('PlacedSensor'), 'Sensor', { UseRaycast: false });
  sensor.add(box('beam', [0, 0.5, 2]));
  root.add(sensor);
  return root;
}

/** Document: own geometry with `MainSensor` + one planner reference `Machine_1`. */
async function documentBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  root.add(box('floor', [0, -0.5, 0]));
  const main = withComponent(group('MainSensor'), 'Sensor', { UseRaycast: false });
  main.add(box('mainBeam', [-3, 0.5, 0]));
  root.add(main);
  const ref = new Object3D();
  ref.name = 'Machine_1';
  ref.position.set(5, 0, 0);
  setNodeId(ref, 'plc_sm_1');
  setAssetReference(ref, { assetId: 'cat:sensor-monitor-machine', path: ASSET_URL });
  setPlacementMeta(ref, {});
  root.add(ref);
  return objectToGlb(root);
}

function muNode(name: string): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  return new RVMovingUnit(node, 'src', new Vector3(0.05, 0.05, 0.05));
}

function listenerCount(sensor: RVSensor): number {
  return (sensor as unknown as { feedbackListeners: unknown[] }).feedbackListeners.length;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

describe('SensorMonitorPlugin follows placements (real viewer)', () => {
  it('monitors a placed sensor, releases it on removal, main sensor emits exactly once', async () => {
    const h = await createTestViewer('webgl');
    handle = h;
    const viewer = h.viewer;
    const plugin = new SensorMonitorPlugin();
    viewer.use(plugin);
    const loader = {
      loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeAsset() }),
    } as unknown as GLTFLoader;
    viewer.placements.setModelCache(new ModelCache(loader, {
      uber: () => viewer.placementUberMaterial,
      isWebGPU: () => viewer.isWebGPU,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    }));
    viewer.setSimulationPaused('sensor-monitor-test', true);
    const events: ComponentEvent[] = [];
    viewer.on('component-event', (e: unknown) => {
      const ev = e as ComponentEvent;
      if (ev.componentType === 'sensor') events.push(ev);
    });

    await viewer.loadModel('layout.glb', { data: await documentBytes() });
    await viewer.placements.whenMaterialized();
    await viewer.whenSceneReady();

    const tm = viewer.transportManager!;
    const main = tm.sensors.find((s) => s.node.name === 'MainSensor')!;
    const placed = tm.sensors.find((s) => s.node.name === 'PlacedSensor')!;
    expect(main, 'main-model sensor registered').toBeTruthy();
    expect(placed, 'placed sensor registered').toBeTruthy();

    // Placed sensor: occupancy change → component-event + eventHistory.
    const placedPath = (placed.node.userData?.rv as Record<string, unknown> | undefined)?.['path'] as string
      ?? placed.node.name;
    placed.applyPhysicsResult(muNode('Box_1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ componentType: 'sensor', kind: 'changed', path: placedPath, payload: { occupied: true } });
    expect(plugin.eventHistory.last()).toMatchObject({ sensorPath: placedPath, occupied: true });

    // Main sensor: exactly ONE event (no duplicate listener after the placement event).
    main.applyPhysicsResult(muNode('Box_2'));
    expect(events).toHaveLength(2);
    expect(events[1].payload?.occupied).toBe(true);
    expect(events.filter((e) => e.path === events[1].path)).toHaveLength(1);
    expect(plugin.monitoredCount).toBe(2);

    // Remove the placement: listeners released, no further event.
    const placedListenersBefore = listenerCount(placed);
    const placementRoot = findByName(viewer.currentModelRoot!, 'Machine_1')!;
    expect(placementRoot).toBeTruthy();
    disposePlacedRoot(viewer as unknown as Parameters<typeof disposePlacedRoot>[0], placementRoot);
    expect(tm.sensors.includes(placed)).toBe(false);
    expect(plugin.monitoredCount).toBe(1);
    expect(listenerCount(placed)).toBe(placedListenersBefore - 1);
    placed.applyPhysicsResult(null);
    expect(events).toHaveLength(2);

    // The main sensor still reports.
    main.applyPhysicsResult(null);
    expect(events).toHaveLength(3);
    expect(events[2].payload?.occupied).toBe(false);
  });
});

// ─── Editor executors: add component, separate / merge with undo / redo ──

function tri(offset: number): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}

function twoIslands(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    10, 0, 0, 11, 0, 0, 10, 1, 0,
  ]), 3));
  g.setIndex([0, 1, 2, 3, 4, 5]);
  return g;
}

/** The editor-redo-components rig, with a REAL transport manager and a recording emit. */
/** An AUTHORED node whose name collides with the Sensor-viz rule: a Lamp + a child mesh. */
function oddSensorRayNode(name = 'Odd_sensorRay'): Object3D {
  const odd = new Object3D();
  odd.name = name;
  odd.userData.realvirtual = { Lamp: {} };
  const lens = new Mesh(tri(20), new MeshStandardMaterial({ color: 0x00ff00 }));
  lens.name = 'OddLens';
  odd.add(lens);
  return odd;
}

/** A PLAIN authored mesh named like a viz: no extras, no children, no marker. */
function plainOddMesh(): Mesh {
  const odd = new Mesh(tri(30), new MeshStandardMaterial({ color: 0xffff00 }));
  odd.name = 'Odd_sensorRay';
  return odd;
}

function makeEditorViewer(opts?: { oddUnderAsm?: boolean; plainOddUnderAsm?: boolean; authoredHelperName?: string; asmRayLeaf?: boolean }): { viewer: RVViewer; tm: RVTransportManager; events: ComponentEvent[] } {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const islands = new Mesh(twoIslands(), new MeshStandardMaterial({ color: 0x808080 }));
  islands.name = 'Islands';
  model.add(islands);
  const asm = new Object3D();
  asm.name = 'Asm';
  const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
  m1.name = 'M1';
  const m2 = new Mesh(tri(5), new MeshStandardMaterial({ color: 0x0000ff }));
  m2.name = 'M2';
  asm.add(m1, m2);
  if (opts?.oddUnderAsm) asm.add(oddSensorRayNode());
  if (opts?.plainOddUnderAsm) asm.add(plainOddMesh());
  if (opts?.authoredHelperName) asm.add(oddSensorRayNode(opts.authoredHelperName));
  if (opts?.asmRayLeaf) {
    // Authored, extras-free leaf in EXACTLY the legacy viz shape for a sensor on Asm.
    const leaf = new Mesh(tri(50), new MeshStandardMaterial({ color: 0x00ffff }));
    leaf.name = 'Asm_sensorRay';
    asm.add(leaf);
  }
  model.add(asm);
  model.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const tm = new RVTransportManager();
  const events: ComponentEvent[] = [];
  const viewer = {
    scene,
    registry,
    signalStore: new SignalStore(),
    transportManager: tm,
    drives: [] as unknown[],
    logicRunState: 'active',
    initContext(this: { registry: NodeRegistry; signalStore: unknown; transportManager: unknown }) {
      return buildInitContext({
        registry: this.registry,
        signalStore: this.signalStore as InitContextDeps['signalStore'],
        transportManager: this.transportManager as InitContextDeps['transportManager'],
        scene,
      });
    },
    get currentModelRoot() { return model; },
    instancePickIndex: { addSubtree() {}, removeSubtree() {}, bumpResolutionEpoch() {} },
    buildMeshBvhsAsync() {},
    registerDeferredLogic() {},
    markRenderDirty() {}, markShadowsDirty() {},
    emit(name: string, data: unknown) { if (name === 'component-event') events.push(data as ComponentEvent); },
    on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined,
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  return { viewer, tm, events };
}

function tracked(plugin: SensorMonitorPlugin): Map<RVSensor, unknown> {
  return (plugin as unknown as { tracked: Map<RVSensor, unknown> }).tracked;
}

/** The ONE live sensor is the only tracked one, and each occupancy change reports exactly once. */
function expectMonitoredOnce(plugin: SensorMonitorPlugin, tm: RVTransportManager, events: ComponentEvent[], tag: string): RVSensor {
  expect(tm.sensors, `${tag}: one live sensor`).toHaveLength(1);
  const sensor = tm.sensors[0];
  expect([...tracked(plugin).keys()], `${tag}: tracked set = live set`).toEqual([sensor]);
  const before = events.length;
  sensor.applyPhysicsResult(muNode(`mu-${tag}`));
  sensor.applyPhysicsResult(null);
  expect(events.length - before, `${tag}: one event per change`).toBe(2);
  expect(events[before].payload?.occupied).toBe(true);
  return sensor;
}

describe('SensorMonitorPlugin follows the transport manager (editor executors)', () => {
  it('addComponent Sensor after load is monitored; separateMesh undo / redo: replacement monitored once, old released', async () => {
    const { viewer, tm, events } = makeEditorViewer();
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(plugin.monitoredCount).toBe(0);
    const doc = scratchAssetDocument(viewer);
    try {
      doc.addComponent('Asset/Islands', 'Sensor', { UseRaycast: false });
      await doc.whenIdle();
      const seen = new Set<RVSensor>([expectMonitoredOnce(plugin, tm, events, 'add')]);
      await doc.separateMesh('Asset/Islands', 'islands');
      seen.add(expectMonitoredOnce(plugin, tm, events, 'separate'));
      await doc.undo();
      seen.add(expectMonitoredOnce(plugin, tm, events, 'undo'));
      await doc.redo();
      seen.add(expectMonitoredOnce(plugin, tm, events, 'redo'));
      // separate / undo / redo REBUILD the component: replacement sensors appeared.
      expect(seen.size).toBeGreaterThan(1);
      // Every sensor that left the transport list carries no monitor listener any more.
      for (const s of seen) if (!tm.sensors.includes(s)) expect(tracked(plugin).has(s)).toBe(false);
    } finally {
      doc.dispose();
      plugin.dispose();
    }
  });
});

/** No sensor registered, none tracked. */
function expectNoSensor(plugin: SensorMonitorPlugin, tm: RVTransportManager, tag: string): void {
  expect(tm.sensors, `${tag}: no live sensor`).toHaveLength(0);
  expect(plugin.monitoredCount, `${tag}: nothing tracked`).toBe(0);
}

describe('SensorMonitorPlugin: a sensor removed on its own deregisters itself', () => {
  it('addComponent Sensor → removeComponent, 3 cycles: membership and tracking back to 0 each time', async () => {
    const { viewer, tm, events } = makeEditorViewer();
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const doc = scratchAssetDocument(viewer);
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        doc.addComponent('Asset/Islands', 'Sensor', { UseRaycast: false });
        await doc.whenIdle();
        const sensor = expectMonitoredOnce(plugin, tm, events, `add#${cycle}`);
        doc.removeComponent('Asset/Islands', 'Sensor');
        await doc.whenIdle();
        expectNoSensor(plugin, tm, `remove#${cycle}`);
        const before = events.length;
        sensor.applyPhysicsResult(muNode(`stale-${cycle}`));
        expect(events.length, `remove#${cycle}: a removed sensor reports nothing`).toBe(before);
      }
    } finally {
      doc.dispose();
      plugin.dispose();
    }
  });

  it('addComponent Sensor undo / redo: 0 after undo, exactly one after redo', async () => {
    const { viewer, tm, events } = makeEditorViewer();
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const doc = scratchAssetDocument(viewer);
    try {
      doc.addComponent('Asset/Islands', 'Sensor', { UseRaycast: false });
      await doc.whenIdle();
      expectMonitoredOnce(plugin, tm, events, 'add');
      for (let cycle = 0; cycle < 3; cycle++) {
        await doc.undo();
        expectNoSensor(plugin, tm, `undo#${cycle}`);
        await doc.redo();
        expectMonitoredOnce(plugin, tm, events, `redo#${cycle}`);
      }
    } finally {
      doc.dispose();
      plugin.dispose();
    }
  });

  it('dispose after a teardown already removed the sensor is a no-op (no second notification)', () => {
    const tm = new RVTransportManager();
    const scene = new Scene();
    const node = withComponent(group('S'), 'Sensor', { UseRaycast: false });
    scene.add(node);
    const registry = new NodeRegistry();
    registry.registerNode('S', node);
    const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.2, 0.2, 0.2)));
    sensor.UseRaycast = false;
    sensor.init(buildInitContext({ registry, signalStore: new SignalStore(), transportManager: tm, scene }) as never);
    expect(tm.sensors).toEqual([sensor]);
    const removedSeen: RVSensor[] = [];
    const off = tm.onSensorsChanged((_added, removed) => { removedSeen.push(...removed); });
    expect(tm.removeSensors((s) => s === sensor)).toEqual([sensor]);
    sensor.dispose();
    sensor.dispose();
    expect(removedSeen).toEqual([sensor]);
    expect(tm.sensors).toHaveLength(0);
    off();
  });
});

// ─── mergeMesh over a subtree with a Sensor: the runtime viz is no merge source ──

/** Names of the Sensor runtime viz nodes below `node` (box + its `_edges` outline, marker-confirmed), sorted. */
function sensorVizUnder(node: Object3D): string[] {
  const out: string[] = [];
  node.traverse((n) => {
    if (n !== node && isSensorRuntimeVizName(n.name) && n.userData._rvRuntimeVisual === true) out.push(n.name);
  });
  return out.sort();
}

/** The authored `Odd_sensorRay` below `node`, intact: Lamp extras + its child mesh. */
function expectOddIntact(node: Object3D, tag: string, name = 'Odd_sensorRay'): void {
  let odd: Object3D | null = null;
  node.traverse((n) => { if (!odd && n.name === name) odd = n; });
  expect(odd, `${tag}: ${name} present`).not.toBeNull();
  expect((odd! as Object3D).userData.realvirtual?.Lamp, `${tag}: Lamp extras kept`).toBeDefined();
  expect((odd! as Object3D).children.map((c) => c.name), `${tag}: its child kept`).toContain('OddLens');
}

describe('mergeMesh over a subtree with a Sensor (runtime helpers are no merge source)', () => {
  it('classifySubtree skips the MARKED sensor viz: neither candidate nor kept', () => {
    const root = new Object3D();
    root.name = 'Asm';
    const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
    m1.name = 'M1';
    const viz = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    viz.name = 'Asm_sensorViz';
    viz.userData._rvRuntimeVisual = true; // what RVSensor sets at creation
    root.add(m1, viz);
    const c = classifySubtree(root, (n) => n.name);
    expect(c.candidates.map((x) => x.mesh.name)).toEqual(['M1']);
    expect(c.kept.map((k) => k.node.name)).toEqual([]);
  });

  it('classifySubtree: an AUTHORED name collision is classified normally (protected), the marked viz is skipped', () => {
    const root = new Object3D();
    root.name = 'Asm';
    const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
    m1.name = 'M1';
    const viz = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    viz.name = 'Asm_sensorRay';
    viz.userData._rvRuntimeVisual = true;
    root.add(m1, viz, oddSensorRayNode());
    const c = classifySubtree(root, (n) => n.name);
    expect(c.candidates.map((x) => x.mesh.name)).toEqual(['M1']);
    expect(c.kept.map((k) => [k.node.name, k.role])).toEqual([['Odd_sensorRay', 'protected']]);
  });

  it('classifySubtree: a PLAIN authored leaf named like a viz (no marker) is a normal candidate', () => {
    const root = new Object3D();
    root.name = 'Asm';
    const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
    m1.name = 'M1';
    root.add(m1, plainOddMesh());
    const c = classifySubtree(root, (n) => n.name);
    expect(c.candidates.map((x) => x.mesh.name).sort()).toEqual(['M1', 'Odd_sensorRay']);
  });

  it('plain authored Odd_sensorRay: sensor init leaves it, merge takes it as a source, undo / redo restore it', async () => {
    const { viewer, tm, events } = makeEditorViewer({ plainOddUnderAsm: true });
    const registry = (viewer as unknown as { registry: NodeRegistry }).registry;
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const doc = scratchAssetDocument(viewer);
    const warn = vi.spyOn(console, 'warn');
    const oddUnder = (n: Object3D): Object3D | null => {
      let hit: Object3D | null = null;
      n.traverse((c) => { if (!hit && c.name === 'Odd_sensorRay') hit = c; });
      return hit;
    };
    try {
      doc.addComponent('Asset/Asm', 'Sensor', { UseRaycast: false });
      await doc.whenIdle();
      expect(oddUnder(registry.getNode('Asset/Asm')!), 'sensor init left the authored leaf').not.toBeNull();
      expectMonitoredOnce(plugin, tm, events, 'add');
      const vizBefore = sensorVizUnder(registry.getNode('Asset/Asm')!);

      const plan = await doc.mergeMesh('Asset/Asm');
      expect(plan).not.toBeNull();
      expect(plan!.sourcePaths, 'the authored leaf is a merge source').toContain('Asset/Asm/Odd_sensorRay');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('apply failed')), 'the merge op applied').toEqual([]);
      expect((registry.getNode('Asset/Asm') as Mesh).isMesh).toBe(true);
      expect(sensorVizUnder(registry.getNode('Asset/Asm')!)).toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'merge');

      await doc.undo();
      expect(oddUnder(registry.getNode('Asset/Asm')!), 'undo restores the authored leaf').not.toBeNull();
      expectMonitoredOnce(plugin, tm, events, 'undo');
      await doc.redo();
      expect((registry.getNode('Asset/Asm') as Mesh).isMesh).toBe(true);
      expectMonitoredOnce(plugin, tm, events, 'redo');
    } finally {
      warn.mockRestore();
      doc.dispose();
      plugin.dispose();
    }
  });

  it('merge / undo / redo with an authored Odd_sensorRay (Lamp + child): preserved as kept, the real viz still skipped', async () => {
    const { viewer, tm, events } = makeEditorViewer({ oddUnderAsm: true });
    const registry = (viewer as unknown as { registry: NodeRegistry }).registry;
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const doc = scratchAssetDocument(viewer);
    const warn = vi.spyOn(console, 'warn');
    try {
      doc.addComponent('Asset/Asm', 'Sensor', { UseRaycast: false });
      await doc.whenIdle();
      expectMonitoredOnce(plugin, tm, events, 'add');
      expectOddIntact(registry.getNode('Asset/Asm')!, 'sensor init');
      const vizBefore = sensorVizUnder(registry.getNode('Asset/Asm')!);
      expect(vizBefore.length).toBeGreaterThan(0);

      const plan = await doc.mergeMesh('Asset/Asm');
      expect(plan).not.toBeNull();
      expect(plan!.kept.some((k) => k.path.endsWith('/Odd_sensorRay') && k.role === 'protected'), 'Odd kept as protected').toBe(true);
      expect(plan!.sourcePaths.some((p) => p.includes('Odd_sensorRay') || isSensorRuntimeVizName(p.split('/').pop()!))).toBe(false);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('apply failed')), 'the merge op applied').toEqual([]);
      const merged = registry.getNode('Asset/Asm') as Mesh;
      expect(merged.isMesh).toBe(true);
      expectOddIntact(merged, 'merge');
      expect(sensorVizUnder(merged)).toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'merge');

      await doc.undo();
      expectOddIntact(registry.getNode('Asset/Asm')!, 'undo');
      expect(sensorVizUnder(registry.getNode('Asset/Asm')!)).toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'undo');

      await doc.redo();
      expectOddIntact(registry.getNode('Asset/Asm')!, 'redo');
      expect(sensorVizUnder(registry.getNode('Asset/Asm')!)).toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'redo');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('apply failed'))).toEqual([]);
    } finally {
      warn.mockRestore();
      doc.dispose();
      plugin.dispose();
    }
  });

  it('merge applies, the viz is not a source and is a runtime helper of the output; undo / redo keep monitoring exact', async () => {
    const { viewer, tm, events } = makeEditorViewer();
    const registry = (viewer as unknown as { registry: NodeRegistry }).registry;
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const doc = scratchAssetDocument(viewer);
    const warn = vi.spyOn(console, 'warn');
    try {
      doc.addComponent('Asset/Asm', 'Sensor', { UseRaycast: false });
      await doc.whenIdle();
      expectMonitoredOnce(plugin, tm, events, 'add');
      const vizBefore = sensorVizUnder(registry.getNode('Asset/Asm')!);
      expect(vizBefore.length, 'the Sensor drew its viz').toBeGreaterThan(0);

      const plan = await doc.mergeMesh('Asset/Asm');
      expect(plan).not.toBeNull();
      expect(plan!.sourcePaths.some((p) => isSensorRuntimeVizName(p.split('/').pop()!)), 'viz is no source').toBe(false);
      const unapplied = warn.mock.calls.filter((c) => String(c[0]).includes('forward apply failed'));
      expect(unapplied, 'the merge op applied').toEqual([]);
      const merged = registry.getNode('Asset/Asm') as Mesh;
      expect(merged.isMesh, 'Asm was replaced by the merged mesh').toBe(true);
      expect(sensorVizUnder(merged), 'one viz set, rebuilt on the output').toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'merge');

      await doc.undo();
      expect((registry.getNode('Asset/Asm') as Mesh).isMesh ?? false, 'undo restores the assembly').toBe(false);
      expect(sensorVizUnder(registry.getNode('Asset/Asm')!)).toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'undo');

      await doc.redo();
      expect((registry.getNode('Asset/Asm') as Mesh).isMesh).toBe(true);
      expect(sensorVizUnder(registry.getNode('Asset/Asm')!)).toEqual(vizBefore);
      expectMonitoredOnce(plugin, tm, events, 'redo');
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('apply failed'))).toEqual([]);
    } finally {
      warn.mockRestore();
      doc.dispose();
      plugin.dispose();
    }
  });
});

describe('mergeMesh: only MARKER-confirmed nodes are runtime helpers (every category)', () => {
  const HELPER_NAMES = ['_tankFillViz', '__raycastBVH_0', '__rvEnergyChainBones', 'Asm_sensorViz'];

  it('classifySubtree: authored nodes carrying a helper NAME (Lamp + child) are protected; marked helpers of each category are skipped', () => {
    const root = new Object3D();
    root.name = 'Asm';
    const m1 = new Mesh(tri(0), new MeshStandardMaterial({ color: 0xff0000 }));
    m1.name = 'M1';
    root.add(m1);
    for (const name of HELPER_NAMES) root.add(oddSensorRayNode(name));
    const marked = (name: string, ud: Record<string, unknown>): Mesh => {
      const m = new Mesh(tri(40), new MeshStandardMaterial());
      m.name = name;
      Object.assign(m.userData, ud);
      return m;
    };
    // The markers each category carries where it is created.
    root.add(marked('Vessel_fillOverlay', { _tankFillViz: true }));        // rv-tank-fill / pipe-flow / process industry
    const bones = new Object3D();                                           // rv-energy-chain bone container
    bones.name = '__rvEnergyChainBones';
    bones.userData._rvGizmo = true;
    bones.add(marked('BoneMesh', {}));
    root.add(bones);
    root.add(marked('Asm_sensorRay', { _rvRuntimeVisual: true }));         // RVSensor
    root.add(marked('Legacy_bvh', { _rvRaycastBVH: true }));               // legacy raycast BVH helper
    root.add(marked('Hover', { _highlightOverlay: true }));                // overlays / gizmos
    const c = classifySubtree(root, (n) => n.name);
    expect(c.candidates.map((x) => x.mesh.name)).toEqual(['M1']);
    expect(c.kept.map((k) => [k.node.name, k.role]).sort()).toEqual(HELPER_NAMES.map((n) => [n, 'protected']).sort());
  });

  it('merge / undo / redo with an authored _tankFillViz (Lamp + child): kept as protected, intact', async () => {
    const { viewer } = makeEditorViewer({ authoredHelperName: '_tankFillViz' });
    const registry = (viewer as unknown as { registry: NodeRegistry }).registry;
    const doc = scratchAssetDocument(viewer);
    const warn = vi.spyOn(console, 'warn');
    try {
      const plan = await doc.mergeMesh('Asset/Asm');
      expect(plan).not.toBeNull();
      expect(plan!.kept.some((k) => k.path === 'Asset/Asm/_tankFillViz' && k.role === 'protected')).toBe(true);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('apply failed'))).toEqual([]);
      expect((registry.getNode('Asset/Asm') as Mesh).isMesh).toBe(true);
      expectOddIntact(registry.getNode('Asset/Asm')!, 'merge', '_tankFillViz');
      await doc.undo();
      expectOddIntact(registry.getNode('Asset/Asm')!, 'undo', '_tankFillViz');
      await doc.redo();
      expectOddIntact(registry.getNode('Asset/Asm')!, 'redo', '_tankFillViz');
    } finally {
      warn.mockRestore();
      doc.dispose();
    }
  });
});

describe('adding a Sensor never takes an authored child (legacy migration is load-only)', () => {
  it('addComponent Sensor on a node with an authored `<node>_sensorRay` leaf, then undo / redo: the leaf stays', async () => {
    const { viewer, tm } = makeEditorViewer({ asmRayLeaf: true });
    const registry = (viewer as unknown as { registry: NodeRegistry }).registry;
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const doc = scratchAssetDocument(viewer);
    const leafUnderAsm = (): Object3D | undefined => registry.getNode('Asset/Asm')!.children
      .find((c) => c.name === 'Asm_sensorRay' && c.userData._rvRuntimeVisual !== true);
    try {
      expect(leafUnderAsm()).toBeDefined();
      doc.addComponent('Asset/Asm', 'Sensor', { UseRaycast: true, RayCastLength: 500 });
      await doc.whenIdle();
      expect(tm.sensors).toHaveLength(1);
      expect(leafUnderAsm(), 'add keeps the authored leaf').toBeDefined();
      await doc.undo();
      expect(leafUnderAsm(), 'undo keeps it').toBeDefined();
      await doc.redo();
      expect(leafUnderAsm(), 'redo keeps it').toBeDefined();
    } finally {
      doc.dispose();
      plugin.dispose();
    }
  });
});

// ─── Gated model: sensors initialised by activateGatedLogic ──

describe('SensorMonitorPlugin follows the transport manager (gated activation)', () => {
  it('a sensor initialised later by activateGatedLogic emits its component-event', async () => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    const sensorNode = withComponent(group('GatedSensor'), 'Sensor', { UseRaycast: false });
    sensorNode.add(box('beam', [0, 0.5, 0]));
    root.add(sensorNode);
    scene.add(root);
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const tm = new RVTransportManager();
    const context = buildInitContext({ registry, signalStore: new SignalStore(), transportManager: tm, scene });
    const extras = processExtras(root, context, { logicRunState: 'gated' });
    expect(extras.deferredLogic).not.toBeNull();
    expect(tm.sensors, 'gated: the sensor is not initialised yet').toHaveLength(0);

    const events: ComponentEvent[] = [];
    const fakeViewer = {
      logicRunState: 'gated',
      _signatureState: 'invalid',
      _signatureModelName: 'gated-sensor.glb',
      _signatureSignerOrganization: undefined,
      _loadGeneration: 1,
      _lastLoadResult: {},
      _deferredLogic: [extras.deferredLogic!],
      _publishSignatureUiState: vi.fn(),
      _attachLogicSystems: vi.fn(),
      transportManager: tm,
      emit: (name: string, data: unknown) => { if (name === 'component-event') events.push(data as ComponentEvent); },
    };
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, fakeViewer as unknown as RVViewer);
    expect(plugin.monitoredCount).toBe(0);
    try {
      const activate = RVViewerClass.prototype.activateGatedLogic as unknown as (this: typeof fakeViewer) => Promise<boolean>;
      await expect(activate.call(fakeViewer)).resolves.toBe(true);
      expect(tm.sensors).toHaveLength(1);
      tm.sensors[0].applyPhysicsResult(muNode('Late'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ componentType: 'sensor', kind: 'changed', payload: { occupied: true } });
      expect(plugin.monitoredCount).toBe(1);
    } finally {
      plugin.dispose();
      localStorage.clear();
    }
  });
});

// ─── Bookkeeping on the real transport manager ──

function createSensor(name: string, parent?: Object3D): RVSensor {
  const node = new Object3D();
  node.name = name;
  parent?.add(node);
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.2, 0.2, 0.2)));
  sensor.UseRaycast = false;
  return sensor;
}

function tmViewer(tm: RVTransportManager): { viewer: RVViewer; events: ComponentEvent[] } {
  const events: ComponentEvent[] = [];
  const viewer = {
    transportManager: tm,
    emit: (name: string, data: unknown) => { if (name === 'component-event') events.push(data as ComponentEvent); },
  };
  return { viewer: viewer as unknown as RVViewer, events };
}

describe('SensorMonitorPlugin listener bookkeeping (transport manager)', () => {
  it('attach is idempotent across a replayed onModelLoaded', () => {
    const tm = new RVTransportManager();
    const main = createSensor('Main');
    tm.addSensor(main);
    const { viewer, events } = tmViewer(tm);
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    plugin.onModelLoaded({} as LoadResult, viewer);
    main.applyPhysicsResult(muNode('M'));
    expect(events).toHaveLength(1);
    expect(listenerCount(main)).toBe(1);
    // A late sensor is announced ONCE although onModelLoaded ran twice.
    const late = createSensor('Late');
    tm.addSensor(late);
    late.applyPhysicsResult(muNode('L'));
    expect(events).toHaveLength(2);
    plugin.dispose();
    expect(listenerCount(main)).toBe(0);
    expect(listenerCount(late)).toBe(0);
  });

  it('removeSensors / clearSensors release the listeners; onModelCleared unsubscribes', () => {
    const tm = new RVTransportManager();
    const main = createSensor('Main');
    tm.addSensor(main);
    const { viewer, events } = tmViewer(tm);
    const plugin = new SensorMonitorPlugin();
    plugin.onModelLoaded({} as LoadResult, viewer);
    const placed = createSensor('Placed', new Object3D());
    tm.addSensor(placed);
    expect(plugin.monitoredCount).toBe(2);
    const listBefore = tm.sensors;
    expect(tm.removeSensors((s) => s === placed)).toEqual([placed]);
    expect(tm.sensors).not.toBe(listBefore); // reassigned: identity-keyed caches invalidate as before
    expect(listenerCount(placed)).toBe(0);
    placed.applyPhysicsResult(muNode('P'));
    expect(events).toHaveLength(0);
    expect(tm.removeSensors(() => false)).toEqual([]);

    tm.clearSensors();
    expect(plugin.monitoredCount).toBe(0);
    expect(listenerCount(main)).toBe(0);

    tm.addSensor(main);
    expect(plugin.monitoredCount).toBe(1);
    plugin.onModelCleared();
    expect(listenerCount(main)).toBe(0);
    tm.addSensor(createSensor('AfterClear'));
    expect(plugin.monitoredCount).toBe(0);
  });
});
