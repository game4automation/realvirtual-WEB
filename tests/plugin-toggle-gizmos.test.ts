// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-436 T1–T6 — the three migrated gizmo plugins under the USER toggle.
 *
 * Every toggle here runs through `viewer.setPluginUserEnabled()`, never through
 * a direct `onDeactivate()`/`onActivate()` call: the ordering and bookkeeping of
 * the host (slots, `_modelLoadedIds`, the "present hook wins" rule) is exactly
 * what these tests are about.
 *
 * The central one is T3: with `onActivate` present the host replays NO
 * `onModelLoaded`, and a `selection-changed` event does not repeat itself for an
 * unchanged selection — so a plugin that does not PULL its state comes back
 * empty and the switch looks broken.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene,
} from 'three';
import { createCoreViewer, loadResult, resetModeStorage } from './helpers/core-toggle-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SelectionManager } from '../src/core/engine/rv-selection-manager';
import { GizmoOverlayManager, type GizmoHandle } from '../src/core/engine/rv-gizmo-manager';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { ConnectionGizmoPlugin } from '../src/plugins/connection-gizmo-plugin';
import { DriveAxisGizmoPlugin } from '../src/plugins/drive-axis-gizmo-plugin';
import { IKPathVisualizerPlugin } from '../src/plugins/ik-path-visualizer-plugin';
import {
  RVConnectionRegistry, STOP_ON_EXIT_TYPE, __setConnectionSystemForTests, getConnectionSystem,
} from '../src/core/engine/rv-connection-registry';
import {
  setDriveDragDriver, type DriveDragDriver,
} from '../src/core/engine/drive-drag-driver';
import { ikEditStore, type IKEditActive, type IKEditController } from '../src/core/hmi/ik-edit-store';
import { setOverlayVisible } from '../src/core/overlay-visibility-store';

/** Scene name of a built drive-axis gizmo group (see drive-axis-gizmo-plugin). */
const DRIVE_GIZMO_NAME = '__rvDriveAxisGizmo';

// ─── Harness ────────────────────────────────────────────────────────────────

/**
 * `createCoreViewer()` plus the 3D surface these three plugins touch: a real
 * Scene, NodeRegistry, GizmoOverlayManager and SelectionManager, and a REAL
 * event dispatcher (the core harness stubs `emit` with a spy, which would never
 * reach a `viewer.on('selection-changed')` subscriber).
 */
function createWorld() {
  const base = createCoreViewer();
  const { viewer, internals, modes } = base;
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  const scene = new Scene();
  const registry = new NodeRegistry();
  const camera = new PerspectiveCamera();
  camera.position.set(0, 2, 5);
  const gizmoManager = new GizmoOverlayManager(scene);
  const selectionManager = new SelectionManager();
  const markRenderDirty = vi.fn();
  // `camera` and `showDriveAxisGizmo` are prototype GETTERS on RVViewer — a
  // plain assignment throws. Everything else is a class field (absent on a
  // `Object.create(prototype)` instance) and assigns normally.
  Object.defineProperty(viewer, 'camera', { value: camera, writable: true, configurable: true });
  Object.defineProperty(viewer, 'showDriveAxisGizmo', { value: true, writable: true, configurable: true });
  Object.assign(internals, {
    scene, registry, gizmoManager, selectionManager, markRenderDirty,
    highlighter: { clearSelection: vi.fn(), highlightSelection: vi.fn() },
    // `use()` hands `this._pluginContext.forPlugin(id)` to init — the core
    // harness's bare `{}` would throw there and swallow init entirely.
    _pluginContext: { forPlugin: (id: string) => ({ id }) },
    on(event: string, cb: (d?: unknown) => void) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => { set.delete(cb); };
    },
    emit(event: string, data?: unknown) {
      listeners.get(event)?.forEach((cb) => cb(data));
    },
  });
  selectionManager.init(viewer as never);
  modes.setMode('hmi');
  return { ...base, scene, registry, camera, gizmoManager, selectionManager, markRenderDirty };
}

type World = ReturnType<typeof createWorld>;

function addNode(w: World, name: string, parent: Object3D = w.scene): { node: Object3D; path: string } {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  const path = NodeRegistry.computeNodePath(node);
  w.registry.registerNode(path, node);
  return { node, path };
}

function addDrive(w: World, name: string, direction: DriveDirection) {
  const { node, path } = addNode(w, name);
  node.add(new Mesh(new BoxGeometry(0.2, 0.2, 0.2))); // real AABB for the base scale
  const drive = new RVDrive(node);
  drive.Direction = direction;
  drive.initDrive();
  w.registry.register('Drive', path, drive);
  w.scene.updateMatrixWorld(true);
  return { node, path, drive };
}

/**
 * A duck-typed RobotIK + one path with two targets. The visualizer only reads
 * `getPaths()`, `getOpwParams()`, `targets[].node` and `InterpolationToTarget`;
 * a null OPW params short-circuits the reachability solver.
 */
function addRobot(w: World, name: string) {
  const robot = addNode(w, name);
  const t0 = addNode(w, `${name}_T0`, robot.node);
  const t1 = addNode(w, `${name}_T1`, robot.node);
  t1.node.position.set(1, 0, 0);
  const targets = [
    { node: t0.node, InterpolationToTarget: 'Linear' },
    { node: t1.node, InterpolationToTarget: 'Linear' },
  ];
  const ikPath = { targets };
  const robotIK = {
    node: robot.node,
    WristType: 'Spherical',
    getPaths: () => [ikPath],
    getOpwParams: () => null,
    getJointChain: () => null,
  };
  w.registry.register('RobotIK', robot.path, robotIK);
  w.scene.updateMatrixWorld(true);
  return { ...robot, targetPaths: [t0.path, t1.path] };
}

// ─── Private-state accessors (assertions need the internals) ────────────────

interface ConnGizmoInternals { handles: Map<string, GizmoHandle> }
interface DriveGizmoInternals {
  entries: Map<string, unknown>;
  shared: { shaftGeo: { addEventListener(t: string, cb: () => void): void; attributes: unknown } } | null;
  _dragListenersAttached: boolean;
}
interface IkVisInternals {
  shown: Map<unknown, { markers: GizmoHandle[]; targetNodes: Object3D[] }>;
  hiddenMarkerPath: string | null;
}

const connOf = (p: ConnectionGizmoPlugin) => p as unknown as ConnGizmoInternals;
const driveOf = (p: DriveAxisGizmoPlugin) => p as unknown as DriveGizmoInternals;
const ikOf = (p: IKPathVisualizerPlugin) => p as unknown as IkVisInternals;

/** Live listener count of the connection registry (its own private Set). */
const connSubs = (reg: RVConnectionRegistry) =>
  (reg as unknown as { listeners: Set<() => void> }).listeners.size;

/** Live listener count of the IK edit store. */
const ikEditSubs = () =>
  (ikEditStore as unknown as { _listeners: Set<() => void> })._listeners.size;

const driveGizmos = (scene: Scene) => scene.children.filter((c) => c.name === DRIVE_GIZMO_NAME);

const markerOpacity = (handle: GizmoHandle): number =>
  ((handle.root as Mesh).material as MeshBasicMaterial).opacity;

const DRAG_DRIVER: DriveDragDriver = {
  preview: () => {}, release: () => {}, cancel: () => {},
};

function activeEdit(path: string): IKEditActive {
  return {
    path, name: path, interpolation: 'Linear', speedToTarget: 1, linearSpeed: 500,
    linearAccel: 100, enableBlending: false, blendRadius: 0, waitForSeconds: 0,
    pickAndPlace: false, reachable: true, solutionCount: 0, solutionIndex: -1,
    poseMm: [0, 0, 0], poseDeg: [0, 0, 0],
  };
}
const NO_CONTROLLER = {} as IKEditController;

beforeEach(() => {
  resetModeStorage();
  __setConnectionSystemForTests(new RVConnectionRegistry());
});

afterEach(() => {
  ikEditStore.clear();
  setDriveDragDriver(null);
  setOverlayVisible('gizmos', true);
  __setConnectionSystemForTests(null);
});

// ─── T1 — connection-gizmo ──────────────────────────────────────────────────

describe('plan-436 T1 — connection-gizmo', () => {
  it('drops cables + subscription on OFF and rebuilds from the pull store on ON', async () => {
    const w = createWorld();
    const plugin = new ConnectionGizmoPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());

    const a = addNode(w, 'StationA');
    const b = addNode(w, 'StationB');
    const registry = getConnectionSystem();
    registry.addConnection({ id: 'e1', source: a.path, target: b.path, type: STOP_ON_EXIT_TYPE });
    plugin.onRender(); // flush the coalesced rebuild

    expect(connOf(plugin).handles.size).toBe(1);
    expect(connSubs(registry)).toBe(1);

    w.viewer.setPluginUserEnabled('connection-gizmo', false);
    expect(connOf(plugin).handles.size).toBe(0);
    expect(connSubs(registry)).toBe(0);

    w.viewer.setPluginUserEnabled('connection-gizmo', true);
    // Rebuilt straight from getConnectionSystem().all() — no event involved.
    expect([...connOf(plugin).handles.keys()]).toEqual(['e1']);
    expect(connSubs(registry)).toBe(1);
  });

  it('picks up edges added while it was switched off', async () => {
    const w = createWorld();
    const plugin = new ConnectionGizmoPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());
    const a = addNode(w, 'StationA');
    const b = addNode(w, 'StationB');

    w.viewer.setPluginUserEnabled('connection-gizmo', false);
    getConnectionSystem().addConnection({ id: 'late', source: a.path, target: b.path, type: STOP_ON_EXIT_TYPE });
    expect(connOf(plugin).handles.size).toBe(0);

    w.viewer.setPluginUserEnabled('connection-gizmo', true);
    expect([...connOf(plugin).handles.keys()]).toEqual(['late']);
  });
});

// ─── T2 — drive-axis-gizmo teardown boundaries ──────────────────────────────

describe('plan-436 T2 — drive-axis-gizmo', () => {
  it('keeps the SHARED geometries alive and removes the global drag listeners', async () => {
    const w = createWorld();
    const plugin = new DriveAxisGizmoPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());
    // Editor-like: a registered drag driver is what attaches the window listeners.
    setDriveDragDriver(DRAG_DRIVER);

    const drive = addDrive(w, 'Slider', DriveDirection.LinearX);
    w.selectionManager.select(drive.path);
    expect(driveGizmos(w.scene)).toHaveLength(1);
    expect(driveOf(plugin)._dragListenersAttached).toBe(true);

    const shared = driveOf(plugin).shared;
    expect(shared).not.toBeNull();
    let disposeCount = 0;
    shared!.shaftGeo.addEventListener('dispose', () => { disposeCount++; });

    const removeSpy = vi.spyOn(window, 'removeEventListener');
    w.viewer.setPluginUserEnabled('drive-axis-gizmo', false);

    // The gizmo is gone …
    expect(driveGizmos(w.scene)).toHaveLength(0);
    expect(driveOf(plugin).entries.size).toBe(0);
    // … but the shared GPU resources are NOT freed (plan-249 §10.2).
    expect(disposeCount).toBe(0);
    expect(driveOf(plugin).shared).toBe(shared);
    expect(shared!.shaftGeo.attributes).toBeDefined();
    // … and the global pointer/keyboard listeners are off.
    expect(driveOf(plugin)._dragListenersAttached).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    removeSpy.mockRestore();

    // Only dispose() may free them.
    plugin.dispose();
    expect(disposeCount).toBe(1);
  });
});

// ─── T3 — the core test: restore WITHOUT a new selection event ──────────────

describe('plan-436 T3 — restore without a new event', () => {
  it('brings back the drive gizmo and the IK paths on ON alone', async () => {
    const w = createWorld();
    const driveGizmo = new DriveAxisGizmoPlugin();
    const ikVis = new IKPathVisualizerPlugin();
    w.viewer.use(driveGizmo);
    w.viewer.use(ikVis);
    await w.load(loadResult());

    const drive = addDrive(w, 'Slider', DriveDirection.LinearX);
    const robot = addRobot(w, 'Robot');
    w.selectionManager.selectPaths([drive.path, robot.path]);
    expect(driveGizmos(w.scene)).toHaveLength(1);
    expect(ikOf(ikVis).shown.size).toBe(1);

    w.viewer.setPluginUserEnabled('drive-axis-gizmo', false);
    w.viewer.setPluginUserEnabled('ik-path-visualizer', false);
    expect(driveGizmos(w.scene)).toHaveLength(0);
    expect(ikOf(ikVis).shown.size).toBe(0);

    // No selection change, no model reload — the state must be PULLED.
    w.viewer.setPluginUserEnabled('drive-axis-gizmo', true);
    w.viewer.setPluginUserEnabled('ik-path-visualizer', true);
    expect(driveGizmos(w.scene)).toHaveLength(1);
    expect(ikOf(ikVis).shown.size).toBe(1);
  });

  it('never replays onModelLoaded for a plugin that has onActivate', async () => {
    const w = createWorld();
    const plugin = new ConnectionGizmoPlugin();
    const spy = vi.spyOn(plugin, 'onModelLoaded');
    w.viewer.use(plugin);
    await w.load(loadResult());
    expect(spy).toHaveBeenCalledTimes(1);

    w.viewer.setPluginUserEnabled('connection-gizmo', false);
    w.viewer.setPluginUserEnabled('connection-gizmo', true);
    // Invariant 2 (plan-435): onActivate wins, the fallback replay is skipped.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─── T3b — the state belongs to the CURRENT selection and honours the gates ──

describe('plan-436 T3b — selection changed while off, and the visibility gates', () => {
  it('restores the state of the NEW selection, not the one from before', async () => {
    const w = createWorld();
    const plugin = new DriveAxisGizmoPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());

    const first = addDrive(w, 'SliderA', DriveDirection.LinearX);
    const second = addDrive(w, 'SliderB', DriveDirection.LinearY);
    w.selectionManager.select(first.path);
    expect([...driveOf(plugin).entries.keys()]).toEqual([first.path]);

    w.viewer.setPluginUserEnabled('drive-axis-gizmo', false);
    // The subscription is gone — this change goes UNSEEN by the plugin.
    w.selectionManager.select(second.path);
    expect(driveOf(plugin).entries.size).toBe(0);

    w.viewer.setPluginUserEnabled('drive-axis-gizmo', true);
    expect([...driveOf(plugin).entries.keys()]).toEqual([second.path]);
  });

  it('builds nothing when showDriveAxisGizmo is off', async () => {
    const w = createWorld();
    const plugin = new DriveAxisGizmoPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());
    const drive = addDrive(w, 'Slider', DriveDirection.LinearX);
    w.selectionManager.select(drive.path);
    expect(driveGizmos(w.scene)).toHaveLength(1);

    w.viewer.setPluginUserEnabled('drive-axis-gizmo', false);
    (w.viewer as unknown as { showDriveAxisGizmo: boolean }).showDriveAxisGizmo = false;
    w.viewer.setPluginUserEnabled('drive-axis-gizmo', true);

    expect(driveOf(plugin).entries.size).toBe(0);
    expect(driveGizmos(w.scene)).toHaveLength(0);
  });

  it('builds nothing when the gizmos overlay category is hidden', async () => {
    const w = createWorld();
    const plugin = new DriveAxisGizmoPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());
    const drive = addDrive(w, 'Slider', DriveDirection.LinearX);
    w.selectionManager.select(drive.path);
    expect(driveGizmos(w.scene)).toHaveLength(1);

    w.viewer.setPluginUserEnabled('drive-axis-gizmo', false);
    setOverlayVisible('gizmos', false);
    w.viewer.setPluginUserEnabled('drive-axis-gizmo', true);

    // attachRuntime re-reads the store, so the gate is honoured immediately.
    expect(driveOf(plugin).entries.size).toBe(0);
    expect(driveGizmos(w.scene)).toHaveLength(0);
  });
});

// ─── T4 — repeatability ─────────────────────────────────────────────────────

describe('plan-436 T4 — two full off/on cycles', () => {
  it('keeps subscription, scene-object and handle counts constant', async () => {
    const w = createWorld();
    const connGizmo = new ConnectionGizmoPlugin();
    const driveGizmo = new DriveAxisGizmoPlugin();
    const ikVis = new IKPathVisualizerPlugin();
    w.viewer.use(connGizmo);
    w.viewer.use(driveGizmo);
    w.viewer.use(ikVis);
    await w.load(loadResult());

    const a = addNode(w, 'StationA');
    const b = addNode(w, 'StationB');
    const registry = getConnectionSystem();
    registry.addConnection({ id: 'e1', source: a.path, target: b.path, type: STOP_ON_EXIT_TYPE });
    connGizmo.onRender();
    const drive = addDrive(w, 'Slider', DriveDirection.LinearX);
    const robot = addRobot(w, 'Robot');
    w.selectionManager.selectPaths([drive.path, robot.path]);

    const baseline = {
      sceneChildren: w.scene.children.length,
      driveGizmos: driveGizmos(w.scene).length,
      driveEntries: driveOf(driveGizmo).entries.size,
      cables: connOf(connGizmo).handles.size,
      ikVisuals: ikOf(ikVis).shown.size,
      connSubs: connSubs(registry),
      ikEditSubs: ikEditSubs(),
    };
    expect(baseline.driveGizmos).toBe(1);
    expect(baseline.cables).toBe(1);
    expect(baseline.ikVisuals).toBe(1);

    const ids = ['connection-gizmo', 'drive-axis-gizmo', 'ik-path-visualizer'];
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const id of ids) w.viewer.setPluginUserEnabled(id, false);
      for (const id of ids) w.viewer.setPluginUserEnabled(id, true);
    }

    expect({
      sceneChildren: w.scene.children.length,
      driveGizmos: driveGizmos(w.scene).length,
      driveEntries: driveOf(driveGizmo).entries.size,
      cables: connOf(connGizmo).handles.size,
      ikVisuals: ikOf(ikVis).shown.size,
      connSubs: connSubs(registry),
      ikEditSubs: ikEditSubs(),
    }).toEqual(baseline);

    // And the selection subscriptions are single, not stacked: one event must
    // reach each handler exactly once.
    const onSelection = vi.spyOn(driveGizmo as never, 'onSelection' as never);
    const onSelectionChanged = vi.spyOn(ikVis as never, 'onSelectionChanged' as never);
    w.selectionManager.select(drive.path);
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelectionChanged).toHaveBeenCalledTimes(1);
  });
});

// ─── T6 — model swapped while the plugin was off ───────────────────────────

describe('plan-436 T6 — model change during the off state', () => {
  it('comes back with the state of the NEW model, not the old one', async () => {
    const w = createWorld();
    const connGizmo = new ConnectionGizmoPlugin();
    const driveGizmo = new DriveAxisGizmoPlugin();
    w.viewer.use(connGizmo);
    w.viewer.use(driveGizmo);
    await w.load(loadResult());

    const oldA = addNode(w, 'OldA');
    const oldB = addNode(w, 'OldB');
    getConnectionSystem().addConnection({ id: 'old', source: oldA.path, target: oldB.path, type: STOP_ON_EXIT_TYPE });
    connGizmo.onRender();
    const oldDrive = addDrive(w, 'OldSlider', DriveDirection.LinearX);
    w.selectionManager.select(oldDrive.path);
    expect([...connOf(connGizmo).handles.keys()]).toEqual(['old']);
    expect([...driveOf(driveGizmo).entries.keys()]).toEqual([oldDrive.path]);

    w.viewer.setPluginUserEnabled('connection-gizmo', false);
    w.viewer.setPluginUserEnabled('drive-axis-gizmo', false);

    // Model swap while both are off: clear, wipe the scene/registry state a
    // real clearModel() would drop, then load a different model.
    w.clear();
    w.selectionManager.clear();
    getConnectionSystem().clearModel();
    w.scene.remove(oldA.node, oldB.node, oldDrive.node);
    const newA = addNode(w, 'NewA');
    const newB = addNode(w, 'NewB');
    getConnectionSystem().addConnection({ id: 'fresh', source: newA.path, target: newB.path, type: STOP_ON_EXIT_TYPE });
    const newDrive = addDrive(w, 'NewSlider', DriveDirection.RotationZ);
    await w.load(loadResult());
    w.selectionManager.select(newDrive.path);

    w.viewer.setPluginUserEnabled('connection-gizmo', true);
    w.viewer.setPluginUserEnabled('drive-axis-gizmo', true);

    expect([...connOf(connGizmo).handles.keys()]).toEqual(['fresh']);
    expect([...driveOf(driveGizmo).entries.keys()]).toEqual([newDrive.path]);
    expect(driveGizmos(w.scene)).toHaveLength(1);
  });
});

// ─── T5 — ik-path-visualizer: the actively edited marker stays hidden ───────

describe('plan-436 T5 — ik-path-visualizer active marker', () => {
  it('re-hides the actively edited marker after switching back on', async () => {
    const w = createWorld();
    const plugin = new IKPathVisualizerPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());

    const robot = addRobot(w, 'Robot');
    w.selectionManager.select(robot.path);
    const activePath = robot.targetPaths[0];
    ikEditStore.setActive(activeEdit(activePath), NO_CONTROLLER);

    const before = [...ikOf(plugin).shown.values()][0];
    expect(markerOpacity(before.markers[0])).toBe(0);
    expect(markerOpacity(before.markers[1])).toBeGreaterThan(0);
    // The store path and the plugin's bookkeeping now agree — exactly the state
    // in which `syncActiveMarker()` early-returns (L102).
    expect(ikOf(plugin).hiddenMarkerPath).toBe(activePath);

    w.viewer.setPluginUserEnabled('ik-path-visualizer', false);
    w.viewer.setPluginUserEnabled('ik-path-visualizer', true);

    const after = [...ikOf(plugin).shown.values()][0];
    expect(after).not.toBe(before); // visuals were genuinely rebuilt
    expect(markerOpacity(after.markers[0])).toBe(0);
    expect(markerOpacity(after.markers[1])).toBeGreaterThan(0);
  });

  it('follows an edit-store change that happened while it was off', async () => {
    const w = createWorld();
    const plugin = new IKPathVisualizerPlugin();
    w.viewer.use(plugin);
    await w.load(loadResult());

    const robot = addRobot(w, 'Robot');
    w.selectionManager.select(robot.path);
    ikEditStore.setActive(activeEdit(robot.targetPaths[0]), NO_CONTROLLER);

    w.viewer.setPluginUserEnabled('ik-path-visualizer', false);
    ikEditStore.setActive(activeEdit(robot.targetPaths[1]), NO_CONTROLLER);
    w.viewer.setPluginUserEnabled('ik-path-visualizer', true);

    const after = [...ikOf(plugin).shown.values()][0];
    expect(ikOf(plugin).hiddenMarkerPath).toBe(robot.targetPaths[1]);
    expect(markerOpacity(after.markers[1])).toBe(0);
    expect(markerOpacity(after.markers[0])).toBeGreaterThan(0);
  });
});
