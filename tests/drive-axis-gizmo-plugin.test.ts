// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveAxisGizmoPlugin lifecycle/selection tests (plan-249 §9.2, refined §10.6).
 *
 * Mock-viewer pattern follows camera-follow-plugin.test.ts (Map<event, Set<cb>>
 * + synthetic 'selection-changed' emits) with a REAL NodeRegistry instance and
 * a real Scene — no DOM/WebGL needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BoxGeometry, ConeGeometry, CylinderGeometry, Line, LineDashedMaterial, Mesh,
  Object3D, PerspectiveCamera, Scene, TorusGeometry, Vector3,
} from 'three';
import { DriveAxisGizmoPlugin } from '../src/plugins/drive-axis-gizmo-plugin';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';

const GIZMO_NAME = '__rvDriveAxisGizmo';

interface World {
  plugin: DriveAxisGizmoPlugin;
  viewer: { scene: Scene; registry: NodeRegistry; camera: PerspectiveCamera; showDriveAxisGizmo: boolean };
  scene: Scene;
  registry: NodeRegistry;
  select: (paths: string[]) => void;
  render: () => void;
}

function createWorld(): World {
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  const scene = new Scene();
  const registry = new NodeRegistry();
  const camera = new PerspectiveCamera();
  camera.position.set(0, 2, 5);
  const viewer = {
    scene, registry, camera,
    showDriveAxisGizmo: true,
    on(event: string, cb: (d?: unknown) => void) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(cb);
      return () => set!.delete(cb);
    },
    emit(event: string, data?: unknown) {
      listeners.get(event)?.forEach((cb) => cb(data));
    },
  };
  const plugin = new DriveAxisGizmoPlugin();
  plugin.init(viewer as never);
  const select = (paths: string[]) =>
    viewer.emit('selection-changed', { selectedPaths: paths, primaryPath: paths[paths.length - 1] ?? null });
  const render = () => { scene.updateMatrixWorld(true); plugin.onRender(); };
  return { plugin, viewer, scene, registry, select, render };
}

/** Register a plain (drive-less) node in the hierarchy + registry. */
function addNode(world: World, parent: Object3D, name: string): { node: Object3D; path: string } {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  const path = NodeRegistry.computeNodePath(node);
  world.registry.registerNode(path, node);
  return { node, path };
}

/** Register a node carrying an initialized RVDrive component. */
function addDrive(
  world: World, parent: Object3D, name: string,
  direction: DriveDirection, reverse = false,
): { node: Object3D; path: string; drive: RVDrive } {
  const { node, path } = addNode(world, parent, name);
  node.add(new Mesh(new BoxGeometry(0.2, 0.2, 0.2))); // real AABB for base scale
  const drive = new RVDrive(node);
  drive.Direction = direction;
  drive.ReverseDirection = reverse;
  drive.initDrive();
  world.registry.register('Drive', path, drive);
  return { node, path, drive };
}

function gizmos(scene: Scene): Object3D[] {
  return scene.children.filter((c) => c.name === GIZMO_NAME);
}

function countGeometries(root: Object3D): { cones: number; cylinders: number; tori: number } {
  let cones = 0, cylinders = 0, tori = 0;
  root.traverse((o) => {
    if (o.userData?.driveGizmoHandle) return; // invisible drag pickers are not part of the visible shape
    const g = (o as Mesh).geometry;
    if (g instanceof ConeGeometry) cones++;
    else if (g instanceof CylinderGeometry) cylinders++;
    else if (g instanceof TorusGeometry) tori++;
  });
  return { cones, cylinders, tori };
}

function firstMesh(root: Object3D): Mesh {
  let found: Mesh | null = null;
  root.traverse((o) => { if (!found && (o as Mesh).isMesh) found = o as Mesh; });
  return found as unknown as Mesh;
}

function findByName(root: Object3D, name: string): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((o) => { if (o.name === name) out.push(o); });
  return out;
}

describe('DriveAxisGizmoPlugin', () => {
  it('builds a double-arrow gizmo (2 cones + 1 cylinder) for a linear drive', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'Slider', DriveDirection.LinearX);
    w.select([path]);
    const g = gizmos(w.scene);
    expect(g).toHaveLength(1);
    expect(countGeometries(g[0])).toEqual({ cones: 2, cylinders: 1, tori: 0 });
  });

  it('builds a dashed axis line + torus ring + direction tip for a rotary drive', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'Turntable', DriveDirection.RotationZ);
    w.select([path]);
    const g = gizmos(w.scene);
    expect(g).toHaveLength(1);
    expect(countGeometries(g[0])).toEqual({ cones: 1, cylinders: 0, tori: 1 });
    // Dashed CAD-style centreline through the pivot
    let dashedLines = 0;
    g[0].traverse((o) => {
      if (o instanceof Line && (o as Line).material instanceof LineDashedMaterial) dashedLines++;
    });
    expect(dashedLines).toBe(1);
  });

  it('puts EVERY gizmo object on HIGHLIGHT_OVERLAY_LAYER (F6)', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'Axis1', DriveDirection.RotationY);
    w.select([path]);
    const expectedMask = 1 << HIGHLIGHT_OVERLAY_LAYER;
    gizmos(w.scene)[0].traverse((o) => {
      expect(o.layers.mask).toBe(expectedMask);
    });
  });

  it('skips Virtual drives (F11)', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'VirtualDrive', DriveDirection.Virtual);
    w.select([path]);
    expect(gizmos(w.scene)).toHaveLength(0);
  });

  it('multi-select shows one gizmo per drive; partial deselect removes only the dropped one (F8)', () => {
    const w = createWorld();
    const a = addDrive(w, w.scene, 'DriveA', DriveDirection.LinearX);
    const b = addDrive(w, w.scene, 'DriveB', DriveDirection.RotationZ);
    w.select([a.path, b.path]);
    expect(gizmos(w.scene)).toHaveLength(2);

    w.select([b.path]); // partial deselect: A drops out, B must SURVIVE (no rebuild flicker)
    const remaining = gizmos(w.scene);
    expect(remaining).toHaveLength(1);
    expect(countGeometries(remaining[0]).tori).toBe(1); // it is B's rotary gizmo

    w.select([]);
    expect(gizmos(w.scene)).toHaveLength(0);
  });

  it('subtree fallback: parent selection with EXACTLY ONE drive in the subtree shows its gizmo (F10)', () => {
    const w = createWorld();
    const group = addNode(w, w.scene, 'Machine');
    const inner = addNode(w, group.node, 'Frame');
    addDrive(w, inner.node, 'Lift', DriveDirection.LinearZ);
    w.select([group.path]);
    expect(gizmos(w.scene)).toHaveLength(1);
  });

  it('subtree fallback: parent selection with TWO drives shows nothing (plan-249 §10.3)', () => {
    const w = createWorld();
    const group = addNode(w, w.scene, 'Robot');
    addDrive(w, group.node, 'Axis1', DriveDirection.RotationZ);
    addDrive(w, group.node, 'Axis2', DriveDirection.RotationY);
    w.select([group.path]);
    expect(gizmos(w.scene)).toHaveLength(0);
  });

  it('subtree descent stops at nested drive boundaries', () => {
    const w = createWorld();
    const group = addNode(w, w.scene, 'Gantry');
    const outer = addDrive(w, group.node, 'OuterAxis', DriveDirection.LinearX);
    addDrive(w, outer.node, 'InnerAxis', DriveDirection.LinearY); // nested BELOW a drive
    // Descent finds OuterAxis and stops there — InnerAxis is not counted,
    // so exactly one drive is found and its gizmo appears.
    w.select([group.path]);
    expect(gizmos(w.scene)).toHaveLength(1);
    expect(countGeometries(gizmos(w.scene)[0]).cones).toBe(2); // OuterAxis (linear)
  });

  it('onRender positions/orients the gizmo from the drive node world transform', () => {
    const w = createWorld();
    const { node, path } = addDrive(w, w.scene, 'Pusher', DriveDirection.LinearX);
    node.position.set(1, 2, 3);
    w.select([path]);
    w.render();
    const g = gizmos(w.scene)[0];
    expect(g.visible).toBe(true);
    expect(g.position.x).toBeCloseTo(1, 6);
    expect(g.position.y).toBeCloseTo(2, 6);
    expect(g.position.z).toBeCloseTo(3, 6);
    // Group local +Y must map onto the world axis: LinearX → (-1, 0, 0).
    const dir = new Vector3(0, 1, 0).applyQuaternion(g.quaternion);
    expect(dir.x).toBeCloseTo(-1, 6);
    expect(dir.y).toBeCloseTo(0, 6);
    expect(dir.z).toBeCloseTo(0, 6);
  });

  it('keeps a screen-constant size for a large part regardless of camera distance (F7)', () => {
    const w = createWorld();
    // Huge part → object-relative base scale exceeds the screen cap at both
    // distances, so the screen cap binds and the on-screen size stays constant.
    const { node, path } = addDrive(w, w.scene, 'BigGantry', DriveDirection.LinearY);
    node.add(new Mesh(new BoxGeometry(40, 40, 40)));
    w.select([path]);

    w.viewer.camera.position.set(0, 0, 6);
    w.render();
    const s1 = gizmos(w.scene)[0].scale.x;
    const d1 = w.viewer.camera.position.length();

    w.viewer.camera.position.set(0, 0, 24);
    w.render();
    const s2 = gizmos(w.scene)[0].scale.x;
    const d2 = w.viewer.camera.position.length();

    // Screen-constant ⇒ world scale grows linearly with distance ⇒ s/d equal.
    expect(s1 / d1).toBeCloseTo(s2 / d2, 6);
    // And it is genuinely screen-capped, not object-sized (a 40 m box would
    // otherwise yield a base scale of ~18 world units).
    expect(s1).toBeLessThan(2);
  });

  it('null-parent guard: a detached drive node hides its gizmo for the frame without crashing (§10.1)', () => {
    const w = createWorld();
    const { node, path } = addDrive(w, w.scene, 'Detach', DriveDirection.LinearZ);
    w.select([path]);
    w.render();
    expect(gizmos(w.scene)[0].visible).toBe(true);
    node.removeFromParent(); // kinematic re-parenting window
    expect(() => w.plugin.onRender()).not.toThrow();
    expect(gizmos(w.scene)[0].visible).toBe(false);
  });

  it('onModelCleared removes all gizmos', () => {
    const w = createWorld();
    const a = addDrive(w, w.scene, 'A', DriveDirection.LinearX);
    const b = addDrive(w, w.scene, 'B', DriveDirection.RotationX);
    w.select([a.path, b.path]);
    expect(gizmos(w.scene)).toHaveLength(2);
    w.plugin.onModelCleared();
    expect(gizmos(w.scene)).toHaveLength(0);
  });

  it('settings toggle off hides gizmos; toggling back on restores the current selection (F9)', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'Toggled', DriveDirection.LinearY);
    w.select([path]);
    expect(gizmos(w.scene)).toHaveLength(1);

    w.viewer.showDriveAxisGizmo = false;
    w.render();
    expect(gizmos(w.scene)).toHaveLength(0);

    // Selecting while OFF builds nothing.
    w.select([path]);
    expect(gizmos(w.scene)).toHaveLength(0);

    // Turning back ON re-applies the last selection snapshot.
    w.viewer.showDriveAxisGizmo = true;
    w.render();
    expect(gizmos(w.scene)).toHaveLength(1);
  });

  it('deselect keeps shared resources alive — reselect builds a working gizmo (§10.2)', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'Reuse', DriveDirection.RotationZ);
    w.select([path]);
    const firstGeo = firstMesh(gizmos(w.scene)[0]).geometry;
    w.select([]);
    expect(gizmos(w.scene)).toHaveLength(0);
    w.select([path]);
    const g = gizmos(w.scene);
    expect(g).toHaveLength(1);
    // Shared geometry instance is reused (not disposed + recreated).
    const secondGeo = firstMesh(g[0]).geometry;
    expect(secondGeo).toBe(firstGeo);
  });

  it('live-editing Direction (reapplyConfig) updates the gizmo on the next frame (§10.4)', () => {
    const w = createWorld();
    const { path, drive } = addDrive(w, w.scene, 'Edited', DriveDirection.LinearX);
    w.select([path]);
    w.render();
    expect(countGeometries(gizmos(w.scene)[0]).tori).toBe(0); // linear shape

    // Asset-editor live edit: Direction switches to rotary + reapplyConfig.
    drive.Direction = DriveDirection.RotationZ;
    drive.reapplyConfig();
    w.render();
    const g = gizmos(w.scene);
    expect(g).toHaveLength(1);
    expect(countGeometries(g[0]).tori).toBe(1); // rebuilt as rotary

    // Live edit to Virtual hides the gizmo without crashing.
    drive.Direction = DriveDirection.Virtual;
    drive.reapplyConfig();
    expect(() => w.render()).not.toThrow();
    expect(gizmos(w.scene)[0].visible).toBe(false);
  });

  it('linear drive with UseLimits shows two end-stop disks at their true offsets', () => {
    const w = createWorld();
    const { path, drive } = addDrive(w, w.scene, 'Limited', DriveDirection.LinearX);
    drive.UseLimits = true;
    drive.LowerLimit = -100; // mm
    drive.UpperLimit = 300;  // mm
    w.select([path]);
    w.render();
    const g = gizmos(w.scene)[0];
    // shaft + 2 end-stop washer disks
    expect(countGeometries(g)).toEqual({ cones: 2, cylinders: 3, tori: 0 });
    const ticks = findByName(g, '__rvDriveLimitTick');
    expect(ticks).toHaveLength(2);
    // currentPosition = 0 → lower disk at -0.1 m, upper at +0.3 m (mm→m),
    // expressed in gizmo design space (divided by the group scale).
    const s = g.scale.x;
    const ys = ticks.map((t) => t.position.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-0.1 / s, 5);
    expect(ys[1]).toBeCloseTo(0.3 / s, 5);
  });

  it('rotary drive shows a current-angle dot that follows the position', () => {
    const w = createWorld();
    const { path, drive } = addDrive(w, w.scene, 'Rotor', DriveDirection.RotationY);
    w.select([path]);
    w.render();
    const g = gizmos(w.scene)[0];
    const dots = findByName(g, '__rvDrivePosDot');
    expect(dots).toHaveLength(1);
    // position 0° → ring parameter 0 → (R, 0, 0) in ring-local space (R = 0.5)
    expect(dots[0].position.x).toBeCloseTo(0.5, 5);
    expect(dots[0].position.y).toBeCloseTo(0, 5);
    drive.currentPosition = 90;
    w.render();
    expect(dots[0].position.x).toBeCloseTo(0, 5);
    expect(dots[0].position.y).toBeCloseTo(0.5, 5);
  });

  it('rotary drive with UseLimits clamps the ring arc to the limit range (owned geometry)', () => {
    const w = createWorld();
    const { path, drive } = addDrive(w, w.scene, 'LimitedRot', DriveDirection.RotationZ);
    drive.UseLimits = true;
    drive.LowerLimit = -45;
    drive.UpperLimit = 90;
    w.select([path]);
    let torus: TorusGeometry | null = null;
    gizmos(w.scene)[0].traverse((o) => {
      if (o.userData?.driveGizmoHandle) return; // skip the invisible drag picker torus
      const geo = (o as Mesh).geometry;
      if (geo instanceof TorusGeometry) torus = geo;
    });
    expect(torus).not.toBeNull();
    expect((torus as unknown as TorusGeometry).parameters.arc)
      .toBeCloseTo((135 * Math.PI) / 180, 5);
  });

  it('pulses the gizmo scale while the drive is moving', () => {
    const w = createWorld();
    const { path, drive } = addDrive(w, w.scene, 'Mover', DriveDirection.LinearZ);
    w.select([path]);
    // Freeze time where sin(t * PULSE_FREQ) = 1 → pulse factor exactly 1.05.
    const t = (Math.PI / 2) / 0.008;
    const spy = vi.spyOn(performance, 'now').mockReturnValue(t);
    try {
      w.render();
      const staticScale = gizmos(w.scene)[0].scale.x;
      drive.jogForward = true;
      w.render();
      const movingScale = gizmos(w.scene)[0].scale.x;
      expect(movingScale).toBeCloseTo(staticScale * 1.05, 5);
    } finally {
      spy.mockRestore();
    }
  });

  it('dispose removes gizmos and unsubscribes from selection', () => {
    const w = createWorld();
    const { path } = addDrive(w, w.scene, 'Bye', DriveDirection.LinearX);
    w.select([path]);
    expect(gizmos(w.scene)).toHaveLength(1);
    w.plugin.dispose();
    expect(gizmos(w.scene)).toHaveLength(0);
    w.select([path]); // no listener anymore → nothing happens
    expect(gizmos(w.scene)).toHaveLength(0);
  });
});
