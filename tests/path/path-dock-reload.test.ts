// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Quaternion, Vector3 } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { clearShared } from '../helpers/agv-harness';
import { makeRig } from './path-network-rig';
import type { RVViewer } from '../../src/core/rv-viewer';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../../src/core/hmi/scene/rv-scene-edits';
import { jsonNodes, toArrayBuffer } from '../helpers/nested-placement-fixture';
import { setPlacementMeta, setAssetReference } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../../src/core/connect/snap-scanner';
import { refreshWorldMatricesDeep } from '../../src/core/engine/rv-node-transform';
import { FleetAuthoringSource } from '../../src/core/fleet/scene/fleet-authoring-source';
import { readFleetScene } from '../../src/core/fleet/scene/fleet-scene-model';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import type { CommandImpl } from '../../src/core/hmi/rv-command-registry';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { createPathNetworkCommandDescriptors } from '../../src/plugins/path-network/path-network-commands';
import { resolveStationDock } from '../../src/plugins/path-network/path-network-dock';
import { validateSceneNetwork } from '../../src/plugins/path-network/path-network-validation';

const ASSET = 'blob:rv-test/plan-636-conveyor.glb';
const impls = new Map(createPathNetworkCommandDescriptors().map(d => [d.id, d.eagerImpl as CommandImpl<unknown, unknown>]));
async function run(viewer: RVViewer, id: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const impl = impls.get(id)!;
  const ctx = { viewer, doc: null, selection: [], mode: 'planner' as const, handle: null };
  const enabled = impl.enabled(ctx, args);
  if (enabled !== true) throw new Error(enabled.reason);
  return impl.run(ctx, args);
}

function conveyor(twoPorts: boolean): Group {
  const asset = new Group();
  asset.name = 'Conveyor';
  const port = new Object3D();
  port.name = 'Snap-ZB-path';
  port.position.z = 0.5;
  asset.add(port);
  if (twoPorts) {
    // A second Z port beside the first: both face the lane, so only the explicit
    // `port` argument (persisted as DockPort) decides between them.
    const second = new Object3D();
    second.name = 'Snap-ZN-path';
    second.position.set(0.6, 0, 0.5);
    asset.add(second);
  }
  return asset;
}

/** Create the dock through the command rig, then export only authored nodes.
 * The reference owns TransferStation; only the delayed asset owns the ports.
 */
async function layout(twoPorts = false): Promise<ArrayBuffer> {
  clearShared();
  const rig = makeRig();
  try {
    const snaps = new SnapPointRegistry();
    Object.assign(rig.stub, { getPlugin: (id: string) => id === 'snap-point'
      ? { getRegistry: () => snaps } : id === 'path-visualizer' ? rig.plugin : undefined });
    Object.assign(rig.stub.registry, { findNodeForUser: (path: string) => {
      const node = rig.nodes.get(path);
      return node ? { node, via: 'runtime' } : null;
    } });
    const fleet = new Object3D();
    fleet.name = 'Fleet';
    fleet.userData.realvirtual = { Fleet: { DesignVehicleLengthMm: 1750, DesignVehicleWidthMm: 860, DesignLoadOffsetMm: 274 } };
    const station = new Object3D();
    station.name = 'Station';
    station.position.set(8, 0, -4);
    station.userData.realvirtual = { TransferStation: { PathId: '', DockPort: '' } };
    const asset = conveyor(twoPorts);
    station.add(asset);
    rig.root.add(fleet, station);
    rig.nodes.set('Root/Station', station);
    scanAndRegisterSnaps(asset, snaps, station);
    FleetAuthoringSource.of(rig.stub as never).invalidate();
    const viewer = rig.stub as unknown as RVViewer;
    await run(viewer, 'layout.path.place', { block: 'straight', lengthM: 20 });
    const dock = await run(viewer, 'layout.path.dock', { station: 'Root/Station',
      ...(twoPorts ? { port: 'Snap-ZN-path' } : {}) }) as { stubPathId: string };
    expect(dock.stubPathId).toBe('PN_K1');
    expect(validateSceneNetwork(viewer).issues.filter(i => i.code.startsWith('path-dock-'))).toEqual([]);
    station.remove(asset);
    setNodeId(station, 'plan636-station');
    setAssetReference(station, { assetId: 'cat:plan636-conveyor', path: ASSET });
    // Copy extras, not runtime component instances or visualizer helper nodes.
    const authored = (node: Object3D): Object3D => {
      const copy = new Group();
      copy.name = node.name;
      copy.position.copy(node.position);
      copy.quaternion.copy(node.quaternion);
      copy.scale.copy(node.scale);
      copy.userData = JSON.parse(JSON.stringify(node.userData));
      for (const child of node.children) copy.add(authored(child));
      return copy;
    };
    return await objectToGlb(authored(rig.root));
  } finally {
    rig.plugin.dispose();
    setActiveEditTarget(null);
    clearShared();
    resetProblemsForTests();
  }
}

let handle: TestViewerHandle | undefined;
let release: (() => void) | undefined;
afterEach(async () => {
  release?.();
  if (handle) await handle.viewer.whenSceneReady();
  vi.restoreAllMocks();
  handle?.dispose();
  handle = undefined;
  release = undefined;
  setActiveEditTarget(null);
  clearShared();
  resetProblemsForTests();
});

async function load(twoPorts = false) {
  const bytes = await layout(twoPorts);
  handle = await createTestViewer('webgl');
  const viewer = handle.viewer;
  viewer.loop.setPaused('plan636-test', true);
  const visualizer = new PathVisualizerPlugin();
  viewer.use(new SnapPointPlugin());
  viewer.use(visualizer);
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const loading = new Promise<void>(resolve => { started = resolve; });
  const loader = { loadAsync: async (url: string) => {
    expect(url).toBe(ASSET);
    started();
    await gate;
    return { scene: conveyor(twoPorts) };
  } } as unknown as GLTFLoader;
  viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => viewer.placementUberMaterial,
    isWebGPU: () => viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  await viewer.loadModel('plan636-layout.glb', { data: bytes });
  await loading;
  viewer.emit('mode-changed', { from: null, to: 'planner' });
  let now = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const poll = () => { now += 600; visualizer.onRender(); visualizer.onRender(); };
  const issues = () => validateSceneNetwork(viewer).issues.filter(i => i.code.startsWith('path-dock-'));
  const problems = () => getProblems().filter(p => p.code?.startsWith('path-dock-'));
  poll();
  expect(issues()).toEqual([]);
  expect(problems()).toEqual([]);
  expect(viewer.scene.getObjectByName('Snap-ZB-path')).toBeUndefined();
  const source = FleetAuthoringSource.of(viewer);
  const before = source.reads;
  let events = 0;
  let readsAtEvent = -1;
  const off = viewer.on('layout-content-added', () => { events++; readsAtEvent = source.reads; });
  release!();
  await viewer.whenSceneReady();
  await viewer.placements.whenMaterialized();
  off();
  expect(events).toBe(1);
  expect(readsAtEvent, 'event handlers invalidate without traversing').toBe(before);
  poll();
  expect(issues()).toEqual([]);
  expect(problems()).toEqual([]);
  expect(source.reads).toBe(before + 1);
  const station = source.model().stations[0].node;
  const resolved = resolveStationDock(viewer, station);
  expect(resolved).not.toHaveProperty('reason');
  expect(source.reads, 'repeated consumers share the same snapshot').toBe(before + 1);
  return { viewer, station, poll, issues, problems };
}

describe('plan-636 9.5: dock reload with asynchronous placement', () => {
  it('skips pending ports, re-reads once after content-added, and resolves the dock', async () => {
    const { viewer, station } = await load();
    expect(station.userData.realvirtual.TransferStation).toMatchObject({ PathId: 'PN_K1', DockPort: 'Snap-ZB-path' });
    expect(await run(viewer, 'layout.path.validate')).toMatchObject({ envelopeSource: 'design' });
  }, 180_000);

  it('keeps PathId and the explicitly selected second DockPort through a command-created GLB round trip', async () => {
    const { viewer, station } = await load(true);
    expect(station.userData.realvirtual.TransferStation).toMatchObject({ PathId: 'PN_K1', DockPort: 'Snap-ZN-path' });
    expect(readFleetScene(viewer.scene, viewer.registry).stations).toMatchObject([
      { pathId: 'PN_K1', dockPort: 'Snap-ZN-path' },
    ]);
    const resolved = resolveStationDock(viewer, station);
    if ('reason' in resolved) throw new Error(resolved.reason);
    expect(resolved.ports).toHaveLength(2);
    expect(resolved.port.object3D.name).toBe('Snap-ZN-path');
  }, 180_000);

  it('publishes a missing stub after a TransferStation field event', async () => {
    const { viewer, station, poll, issues, problems } = await load();
    station.userData.realvirtual.TransferStation.PathId = 'PN_K99';
    viewer.emit('component-field-changed', { nodePath: viewer.registry!.getPathForNode(station)!, componentType: 'TransferStation', fieldName: 'PathId' });
    poll();
    expect(issues().map(i => i.code)).toEqual(['path-dock-stub-missing']);
    expect(problems().map(p => p.code)).toEqual(['path-dock-stub-missing']);
  }, 180_000);

  it('invalidates an incomplete design vehicle and falls back to no envelope', async () => {
    const { viewer, poll } = await load();
    const fleet = viewer.scene.getObjectByName('Fleet')!;
    fleet.userData.realvirtual.Fleet.DesignVehicleWidthMm = 0;
    viewer.emit('component-field-changed', { nodePath: viewer.registry!.getPathForNode(fleet)!, componentType: 'Fleet', fieldName: 'DesignVehicleWidthMm' });
    poll();
    expect(getProblems().filter(p => p.code === 'fleet-design-vehicle-incomplete')).toHaveLength(1);
    expect(await run(viewer, 'layout.path.validate')).toMatchObject({ envelopeSource: 'none' });
  }, 180_000);

  it('detects moves, undo/redo and a seat-centred rotation through the 500 ms poll, then re-docks', async () => {
    // The move goes through a document transformNode op on the reference node (the
    // editor / MCP route): the 500 ms dock signature must see it without markDirty().
    // A planner placement record is not needed for this — the signature reads world poses.
    const { viewer, station, poll, issues, problems } = await load();
    const doc = new RvDocument({ id: 'plan636-moves', name: 'Dock moves', mode: 'scene',
      executor: new RvUnifiedExecutor(viewer, 'scene') });
    setActiveEditTarget({ available: true, persistsTo: 'scene', documentKey: doc,
      setField: () => { throw new Error('unused'); }, unsetField: () => { throw new Error('unused'); },
      withTransaction: (label, fn) => doc.withTransaction(label, fn) });
    const nodePath = viewer.registry!.getPathForNode(station)!;
    type T = { position: [number, number, number]; quaternion: [number, number, number, number] };
    const original: T = { position: station.position.toArray() as [number, number, number],
      quaternion: station.quaternion.toArray() as [number, number, number, number] };
    const moved: T = { ...original, position: [original.position[0], original.position[1], original.position[2] + 0.2] };
    let serial = 0;
    // The baked asset under the reference node is matrix-frozen (rv-freeze-static);
    // write sides refresh the frozen subtree after a transform (gizmo:
    // refreshWorldMatricesDeep). The scene transformNode executor does not, so the
    // rig does it after every op / undo / redo — what the 500 ms check must see is
    // the moved world pose, nothing else.
    const settle = () => refreshWorldMatricesDeep(station);
    const move = async (t: T, prev: T) => { await doc.applyOp({ id: `plan636-move-${++serial}`, ts: Date.now(), schemaV: 1,
      kind: 'transformNode', nodePath, transform: t, prev } as never); settle(); };
    const undo = async () => { await doc.undo(); settle(); };
    const redo = async () => { await doc.redo(); settle(); };
    const aligned = () => { poll(); expect(problems()).toEqual([]); expect(issues()).toEqual([]); };
    const misaligned = (short: string) => {
      poll();
      expect(problems().map(p => p.code)).toEqual(['path-dock-misaligned']);
      expect(issues()).toMatchObject([{ code: 'path-dock-misaligned', short }]);
      expect(issues()).toHaveLength(1);
    };
    await move(moved, original);
    misaligned('Dock 200 mm');
    await undo();
    aligned();
    await redo();
    misaligned('Dock 200 mm');
    await undo();
    aligned();
    // Rotate 2° about the port/seat at local z=0.5 so its world position stays put:
    // the load centre stays aligned and the angle label is reported.
    const angle = 2 * Math.PI / 180;
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle).multiply(station.quaternion.clone());
    const seatLocal = new Vector3(0, 0, 0.5);
    const seatWorldBefore = seatLocal.clone().applyQuaternion(station.quaternion).add(station.position);
    const pos = seatWorldBefore.clone().sub(seatLocal.clone().applyQuaternion(q));
    const rotated: T = { position: pos.toArray() as [number, number, number], quaternion: q.toArray() as [number, number, number, number] };
    await move(rotated, original);
    misaligned('Dock 2.0°');
    await undo();
    await move(moved, original);
    misaligned('Dock 200 mm');
    await run(viewer, 'layout.path.dock', { station: nodePath });
    aligned();
  }, 180_000);

  it('command-written placement-content override survives save and a delayed reload', async () => {
    const STATION_ID = 'plan636-inner-station';
    const contentAsset = (): Group => {
      const asset = new Group();
      asset.name = 'Conveyor';
      const inner = new Group();
      inner.name = 'InnerStation';
      setNodeId(inner, STATION_ID);
      inner.userData.realvirtual = { ...(inner.userData.realvirtual ?? {}), TransferStation: { PathId: '', DockPort: '' } };
      const port = new Object3D();
      port.name = 'Snap-ZB-path';
      port.position.z = 0.5;
      inner.add(port);
      asset.add(inner);
      return asset;
    };
    const layoutDoc = async (): Promise<ArrayBuffer> => {
      const root = new Group();
      root.name = 'Layout';
      const fleet = new Object3D();
      fleet.name = 'Fleet';
      fleet.userData.realvirtual = { Fleet: { DesignVehicleLengthMm: 1750, DesignVehicleWidthMm: 860, DesignLoadOffsetMm: 274 } };
      const ref = new Object3D();
      ref.name = 'Placement';
      ref.position.set(8, 0, -4);
      setNodeId(ref, 'plan636-placement');
      setAssetReference(ref, { assetId: 'cat:plan636-conveyor', path: ASSET });
      setPlacementMeta(ref, {});
      root.add(fleet, ref);
      return objectToGlb(root);
    };
    // One boot: a (optionally gated) fake loader, the real path/snap plugins.
    const boot = async (bytes: ArrayBuffer, gated: boolean) => {
      handle = await createTestViewer('webgl');
      const viewer = handle.viewer;
      viewer.loop.setPaused('plan636-test', true);
      const visualizer = new PathVisualizerPlugin();
      viewer.use(new SnapPointPlugin());
      viewer.use(visualizer);
      const gate = new Promise<void>(resolve => { release = resolve; });
      const loader = { loadAsync: async (url: string) => {
        expect(url).toBe(ASSET);
        if (gated) await gate;
        return { scene: contentAsset() };
      } } as unknown as GLTFLoader;
      viewer.placements.setModelCache(new ModelCache(loader, {
        uber: () => viewer.placementUberMaterial,
        isWebGPU: () => viewer.isWebGPU,
        pickPort: () => createPickBuildPort({ createWorker: () => null }),
      }));
      await viewer.loadModel('plan636-content.glb', { data: bytes });
      viewer.emit('mode-changed', { from: null, to: 'planner' });
      return { viewer, visualizer };
    };
    const firstBytes = await layoutDoc();

    // 1. Author: ungated boot, then dock the station INSIDE the placement through the command.
    const a = await boot(firstBytes, false);
    await a.viewer.whenSceneReady();
    await a.viewer.placements.whenMaterialized();
    const inner = a.viewer.scene.getObjectByName('InnerStation')!;
    expect(inner, 'the station lives in placement content').toBeDefined();
    const doc = new RvDocument({ id: 'plan636-override', name: 'Override', mode: 'scene',
      executor: new RvUnifiedExecutor(a.viewer, 'scene') });
    setActiveEditTarget({ available: true, persistsTo: 'scene', documentKey: doc,
      setField: () => { throw new Error('unused'); }, unsetField: () => { throw new Error('unused'); },
      withTransaction: (label, fn) => doc.withTransaction(label, fn) });
    await run(a.viewer, 'layout.path.place', { block: 'straight', lengthM: 20 });
    const dock = await run(a.viewer, 'layout.path.dock', { station: a.viewer.registry!.getPathForNode(inner)! }) as { stubPathId: string };
    expect(dock.stubPathId).toBe('PN_K1');

    // 2. Save through the production bake: the dock must land as a placement override, not inside the asset.
    const registry = a.viewer.registry!;
    const baked = await bakeIntoGlb(firstBytes.slice(0), materialise(doc.ops), makeRegistryBakeResolver(registry, []),
      { expectedNames: registry.getGltfNodeNames() });
    const glbJson = (jsonNodes(baked.glb) as { name?: string; extras?: { realvirtual?: Record<string, unknown> } }[]);
    const overrides = glbJson.find(n => n.name === 'Placement')?.extras?.realvirtual?.AssetOverrides as
      { byAddress?: Record<string, Record<string, Record<string, unknown>>> } | undefined;
    expect(overrides?.byAddress?.[`#${STATION_ID}`]?.TransferStation).toEqual({ PathId: 'PN_K1', DockPort: 'Snap-ZB-path' });
    setActiveEditTarget(null);
    a.visualizer.dispose();
    release?.();
    handle?.dispose();
    handle = undefined;
    release = undefined;
    clearShared();
    resetProblemsForTests();

    // 3. Reload the saved file with a delayed placement.
    const b = await boot(toArrayBuffer(baked.glb).slice(0), true);
    expect(b.viewer.scene.getObjectByName('InnerStation')).toBeUndefined();
    let now = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const poll = () => { now += 600; b.visualizer.onRender(); b.visualizer.onRender(); };
    const dockIssues = () => validateSceneNetwork(b.viewer).issues.filter(i => i.code.startsWith('path-dock-'));
    poll();
    expect(dockIssues()).toEqual([]);
    expect(getProblems().filter(p => p.code?.startsWith('path-dock-'))).toEqual([]);
    release!();
    await b.viewer.whenSceneReady();
    await b.viewer.placements.whenMaterialized();
    const station = b.viewer.scene.getObjectByName('InnerStation')!;
    expect(station.userData.realvirtual.TransferStation).toMatchObject({ PathId: 'PN_K1', DockPort: 'Snap-ZB-path' });
    poll();
    expect(readFleetScene(b.viewer.scene, b.viewer.registry).stations).toMatchObject([{ pathId: 'PN_K1', dockPort: 'Snap-ZB-path' }]);
    expect(dockIssues()).toEqual([]);
    expect(getProblems().filter(p => p.code?.startsWith('path-dock-'))).toEqual([]);
  }, 180_000);
});
