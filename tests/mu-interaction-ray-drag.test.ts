// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2215 §9.19 — MU drag with a world-space ray (Phase 7, flystick bridge).
 *
 * `startDragFromRay` / `updateDragFromRay` sit beside the pointer variants; the
 * pointer variant converts its screen position into a ray and runs the SAME
 * drag step. A pointer drag and a ray drag with the equivalent ray therefore
 * end with the carrier at the same position; abort restores the pose in both
 * ways. A ray drag is not a pointer gesture: pointer events (cancel, a move
 * while the pointer pick is blocked by a render strategy) do not end it.
 *
 * Viewer double and scene as in mu-interaction-plugin.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2, Vector3,
} from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import type { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ConnectionHoldController, __setConnectionHoldsForTests } from '../src/core/engine/rv-connection-hold';
import { MuInteractionPlugin, ensureMuCommandsRegistered } from '../src/plugins/mu-interaction-plugin';
import { classifiedScene, palletRow } from './_mu-preplaced-fixture';
import type { RVViewer } from '../src/core/rv-viewer';

function surfaceAt(scene: Scene, name: string, x: number): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, -0.1, 0);
  scene.add(node);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2, 0.05, 0.5)));
  s.TransportDirection.set(1, 0, 0);
  s.Radial = false;
  s.TextureScale = 1;
  s.HeightOffsetOverride = 0;
  s.reapplyConfig();
  s.initTransport();
  s.drive = { currentSpeed: 0, name: 'd' } as unknown as RVDrive;
  return s;
}

interface Fixture { viewer: RVViewer; plugin: MuInteractionPlugin; clone: RVMovingUnit; camera: PerspectiveCamera }

const plugins: MuInteractionPlugin[] = [];
beforeEach(() => {
  __setConnectionHoldsForTests(new ConnectionHoldController());
  ensureMuCommandsRegistered();
});
afterEach(() => {
  for (const p of plugins.splice(0)) p.dispose();
  __setConnectionHoldsForTests(null);
  commandRegistry.attachViewer(undefined);
});

/** A paused line with two belts and one clone carrier on BeltA; plugin active in Commissioning. */
function setup(): Fixture {
  const { root } = palletRow(1, 1);
  const { scene, tm } = classifiedScene(root);
  tm.surfaces.push(surfaceAt(scene, 'BeltA', 0), surfaceAt(scene, 'BeltB', 6));
  tm.activatePreplaced();
  const node = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
  node.name = 'Clone';
  node.position.set(1.5, 0, 0);
  scene.add(node);
  const clone = new RVMovingUnit(node, 'src', new Vector3(0.05, 0.05, 0.05));
  tm.mus.push(clone);
  const canvas = document.createElement('canvas');
  const camera = new PerspectiveCamera(50, 4 / 3, 0.01, 100);
  camera.position.set(3, 6, 6);
  camera.lookAt(3, 0, 0);
  camera.updateMatrixWorld(true);
  const viewer = {
    transportManager: tm as RVTransportManager,
    scene,
    registry: new NodeRegistry(),
    contextMenu: new ContextMenuStore(),
    camera,
    controls: { enabled: true },
    renderer: { domElement: canvas },
    keyboardScope: null,
    keyboardScopeIsPrimary: true,
    currentModelRoot: scene,
    pointerPickBlocked: false,
    get modes() { return { activeMode: 'commissioning' }; },
    get simulationKernel() { return { mode: 'continuous' }; },
    raycastManager: {
      addAuxRaycastTarget: () => {},
      removeAuxRaycastTarget: () => {},
      raycastForRVNodeDetailed: () => null,
    },
    selectionManager: {
      getSnapshot: () => ({ selectedPaths: [], primaryPath: null }),
      selectPaths: () => {}, select: () => {}, toggle: () => {}, refreshHighlight: () => {},
    },
    markRenderDirty: () => {},
    on: () => () => {},
  } as unknown as RVViewer;
  const plugin = new MuInteractionPlugin();
  plugins.push(plugin);
  plugin.init(viewer);
  plugin.onModeActivate('commissioning', viewer);
  plugin.onRender();
  return { viewer, plugin, clone, camera };
}

/**
 * The pointer position of a world point for the detached test canvas: its rect
 * is 0 x 0, which the plugin treats as 1 x 1 — so clientX/Y are the NDC mapped to 0..1.
 */
function pointerOf(f: Fixture, world: Vector3): { clientX: number; clientY: number; pointerId: number } {
  const p = world.clone().project(f.camera);
  return { clientX: (p.x + 1) / 2, clientY: (1 - p.y) / 2, pointerId: 7 };
}

/** The ray the pointer variant builds for that position. */
function rayOf(f: Fixture, at: { clientX: number; clientY: number }): { origin: Vector3; dir: Vector3 } {
  const rc = new Raycaster();
  rc.setFromCamera(new Vector2(at.clientX * 2 - 1, -at.clientY * 2 + 1), f.camera);
  return { origin: rc.ray.origin.clone(), dir: rc.ray.direction.clone() };
}

const TARGET = new Vector3(6.3, -0.05, 0.1);
const VIA = new Vector3(3, -0.05, 0);

describe('MU drag by ray equals the pointer drag (plan-2215 9.19)', () => {
  it('pointer and equivalent ray put the carrier at the same end position', () => {
    const a = setup();
    const via = pointerOf(a, VIA);
    const end = pointerOf(a, TARGET);
    expect(a.plugin.startDrag(a.clone, via)).toBe(true);
    a.plugin.updateDrag(end);
    a.plugin.finishDrag(end);
    expect(a.plugin.dragging).toBe(false);
    const byPointer = a.clone.node.getWorldPosition(new Vector3());
    // The carrier moved onto BeltB.
    expect(byPointer.x).toBeGreaterThan(5);

    const b = setup();
    const r0 = rayOf(b, pointerOf(b, VIA));
    const r1 = rayOf(b, pointerOf(b, TARGET));
    expect(b.plugin.startDragFromRay(b.clone, r0.origin, r0.dir)).toBe(true);
    expect(b.clone.heldBy).toBe('user');
    b.plugin.updateDragFromRay(r1.origin, r1.dir);
    b.plugin.finishDrag();
    expect(b.plugin.dragging).toBe(false);
    const byRay = b.clone.node.getWorldPosition(new Vector3());
    expect(byRay.distanceTo(byPointer)).toBeLessThan(1e-9);
  });

  it('abort restores the pose in both ways', () => {
    for (const viaRay of [false, true]) {
      const f = setup();
      const pos = f.clone.node.position.clone();
      const parent = f.clone.node.parent;
      const at = pointerOf(f, TARGET);
      if (viaRay) {
        const r = rayOf(f, at);
        expect(f.plugin.startDragFromRay(f.clone, r.origin, r.dir)).toBe(true);
      } else {
        expect(f.plugin.startDrag(f.clone, at)).toBe(true);
      }
      f.plugin.abortDrag();
      expect(f.plugin.dragging).toBe(false);
      expect(f.clone.heldBy).toBeNull();
      expect(f.clone.node.parent).toBe(parent);
      expect(f.clone.node.position.equals(pos)).toBe(true);
      expect((f.viewer.controls as { enabled: boolean }).enabled).toBe(true);
    }
  });

  it('a ray drag ignores pointer events; a pointer drag is still dropped by a blocked pointer pick', () => {
    const f = setup();
    const r = rayOf(f, pointerOf(f, VIA));
    expect(f.plugin.startDragFromRay(f.clone, r.origin, r.dir)).toBe(true);
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: -1 }));
    (f.viewer as unknown as { pointerPickBlocked: boolean }).pointerPickBlocked = true;
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 5, clientY: 5 }));
    expect(f.plugin.dragging).toBe(true);
    f.plugin.abortDrag();

    const g = setup();
    expect(g.plugin.startDrag(g.clone, pointerOf(g, VIA))).toBe(true);
    (g.viewer as unknown as { pointerPickBlocked: boolean }).pointerPickBlocked = true;
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 5, clientY: 5 }));
    expect(g.plugin.dragging).toBe(false);
    expect(g.clone.heldBy).toBeNull();
  });

  it('a ray drag cannot start on another carrier while a pointer drag runs', () => {
    const f = setup();
    const node = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    node.name = 'Clone2';
    node.position.set(2.5, 0, 0);
    f.viewer.scene.add(node);
    const other = new RVMovingUnit(node, 'src', new Vector3(0.05, 0.05, 0.05));
    f.viewer.transportManager!.mus.push(other);

    expect(f.plugin.startDrag(f.clone, pointerOf(f, VIA))).toBe(true);
    const r = rayOf(f, pointerOf(f, new Vector3(2.5, 0, 0)));
    expect(f.plugin.startDragFromRay(other, r.origin, r.dir)).toBe(false);
    expect(other.heldBy).toBeNull();

    // The first session is intact and still ends cleanly.
    f.plugin.abortDrag();
    expect(f.plugin.dragging).toBe(false);
    expect(f.clone.heldBy).toBeNull();
    expect((f.viewer.controls as { enabled: boolean }).enabled).toBe(true);
  });
});
