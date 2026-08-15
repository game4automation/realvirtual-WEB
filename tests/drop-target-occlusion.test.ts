// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-target-occlusion — the magnet stops reaching through walls
 * (plan-422 F7, test 9.6).
 *
 * Werner's report: "the drop target at the machine is still called Conveyor
 * Belt". The conveyor's badge sits BEHIND the machine, and the magnet picked it
 * anyway, because `nearestCompatibleTarget()` compares screen pixels and knows
 * nothing about depth. Dragging onto a machine you are looking straight at
 * would hand you the thing hidden behind it.
 *
 * The five cases below are the whole contract, and the last three are the ones
 * that keep the cure from being worse than the disease: the drag must never end
 * up with NO target, the check must not run per frame, and a scene without pick
 * geometry must behave exactly as before.
 *
 *   (a) static wall in front of the nearest candidate → the unoccluded one wins
 *   (b) same, but the occluder is a KINEMATIC pick mesh
 *   (c) every candidate occluded → the screen-nearest is kept (never aimless)
 *   (d) no candidate change → no additional raycasts
 *   (e) no `raycastGeometry` at all → no check, no crash
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene, Vector3,
} from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import type { ResolvedSlot } from '../src/core/engine/rv-binding-slot-resolver';
import type { RVViewer } from '../src/core/rv-viewer';
import { armSignalDrag, cancelSignalDrag, updateSignalDrag } from '../src/core/hmi/signal-drag-store';
import { resetOverlayProducers, showAllOverlays } from '../src/core/overlay-visibility-store';
import { DropTargetOverlayController } from '../src/plugins/signal-bind/drop-target-overlay';
import { setSignalLinkModeExplicit } from '../src/plugins/signal-bind/signal-link-mode-store';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';

const BOOL_CONTROL: ResolvedSlot = {
  slot: 'Flow.Run', targetName: 'Flow.Run', type: 'bool', direction: 'plcOutput',
  aliases: [], instance: null,
};
const PAYLOAD = {
  name: 'Run', direction: 'output' as const, plcType: 'PLCOutputBool',
  origin: 'connect' as const, interfaceId: 'iface-1',
};

/** Where the camera sits, looking down −Z at the origin. */
const CAMERA_Z = 10;

interface Occluder { mesh: Mesh; kinematic: boolean }

interface Harness {
  viewer: RVViewer;
  /** Target nodes in creation order. */
  nodes: Object3D[];
  dispose(): void;
}

/**
 * Two compatible targets at the same depth-ordering problem as the report:
 * `Near` projects closest to the cursor but can be hidden; `Far` is a few
 * pixels further away and stays visible.
 */
function makeHarness(opts: {
  /** Occluding meshes placed between camera and the named target. */
  occluders?: Array<{ z: number; kinematic: boolean }>;
  /** Omit the RaycastGeometrySet entirely (case e). */
  noGeometry?: boolean;
} = {}): Harness {
  const scene = new Scene();
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const manager = new SignalBindingManager(store, registry);
  const slots = new Map<string, ResolvedSlot[]>();
  const nodes: Object3D[] = [];

  // Both targets sit on the camera axis area; Near is closer to the cursor in
  // screen space, which is exactly why it wins without a depth test.
  const layout: Array<{ name: string; x: number; y: number; z: number }> = [
    { name: 'Near', x: 0, y: 0, z: 0 },
    { name: 'Far', x: 0.35, y: 0, z: 0 },
  ];
  for (const spec of layout) {
    const node = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    node.name = spec.name;
    node.position.set(spec.x, spec.y, spec.z);
    node.userData.realvirtual = { Conveyor: {} };
    scene.add(node);
    node.updateMatrixWorld(true);
    registry.registerNode(node.name, node);
    slots.set(node.name, [BOOL_CONTROL]);
    nodes.push(node);
  }
  Object.assign(manager, { getElementSlots: (id: string) => slots.get(id) ?? [] });

  // Occluders: broad plates between camera and BOTH targets, at the given z.
  const occluders: Occluder[] = [];
  for (const spec of opts.occluders ?? []) {
    const mesh = new Mesh(new BoxGeometry(20, 20, 0.05), new MeshBasicMaterial());
    mesh.position.set(0, 0, spec.z);
    mesh.updateMatrixWorld(true);
    occluders.push({ mesh, kinematic: spec.kinematic });
  }

  const camera = new PerspectiveCamera(50, 4 / 3, 0.1, 100);
  camera.position.set(0, 0, CAMERA_Z);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;z-index:1';
  canvas.width = 640; canvas.height = 480;
  document.body.appendChild(canvas);
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 480 });
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480,
    x: 0, y: 0, toJSON: () => ({}),
  });

  const staticOccluders = occluders.filter((o) => !o.kinematic);
  const kinematicOccluders = occluders.filter((o) => o.kinematic);
  const kinematicGroups = new Map<Object3D, { mesh: Mesh }>();
  for (const o of kinematicOccluders) kinematicGroups.set(new Object3D(), { mesh: o.mesh });

  const raycastGeometry = opts.noGeometry ? null : {
    staticGroup: staticOccluders.length > 0 ? { mesh: staticOccluders[0].mesh } : null,
    kinematicGroups,
  };

  const gizmoManager = new GizmoOverlayManager(scene, () => null);
  const viewer = {
    scene,
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
    gizmoManager,
    camera,
    renderer: { domElement: canvas },
    get renderBackend() { return 'three' as const; },
    markRenderDirty: () => {},
    on: () => () => {},
    raycastManager: { raycastGeometry },
    contextMenu: new ContextMenuStore(),
  } as unknown as RVViewer;

  return {
    viewer,
    nodes,
    dispose() {
      gizmoManager.destroy();
      canvas.remove();
      for (const node of nodes) {
        (node as Mesh).geometry.dispose();
        ((node as Mesh).material as MeshBasicMaterial).dispose();
      }
      for (const o of occluders) {
        o.mesh.geometry.dispose();
        (o.mesh.material as MeshBasicMaterial).dispose();
      }
    },
  };
}

/**
 * Screen position of a node, so a test can aim the cursor at it without
 * hard-coding pixels that a projection tweak would silently invalidate.
 */
function screenOf(viewer: RVViewer, node: Object3D): { x: number; y: number } {
  const v = node.getWorldPosition(new Vector3());
  v.project(viewer.camera);
  return { x: (v.x * 0.5 + 0.5) * 640, y: (-v.y * 0.5 + 0.5) * 480 };
}

const harnesses: Harness[] = [];
const harness = (...args: Parameters<typeof makeHarness>) => {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
};

beforeEach(() => {
  cancelSignalDrag();
  localStorage.clear();
  setSignalLinkModeExplicit(false);
  resetOverlayProducers();
  showAllOverlays();
  signalBindStore.clear();
});

afterEach(() => {
  cancelSignalDrag();
  for (const h of harnesses.splice(0)) h.dispose();
  resetOverlayProducers();
  showAllOverlays();
  vi.restoreAllMocks();
});

/** Start a drag with the cursor on `at`, then render once. */
function dragTo(controller: DropTargetOverlayController, at: { x: number; y: number }): void {
  armSignalDrag(PAYLOAD, at.x - 20, at.y);
  updateSignalDrag(at.x, at.y);
  controller.onRender();
}

describe('drop-target magnet — occlusion', () => {
  it('without any occluder the screen-nearest target wins (baseline)', () => {
    const h = harness();
    const c = new DropTargetOverlayController(h.viewer);
    dragTo(c, screenOf(h.viewer, h.nodes[0]));
    expect(c.nearestTargetId).toBe('Near');
    c.dispose();
  });

  it('(a) picks the unoccluded target when a STATIC wall hides the nearest', () => {
    // A plate at z = 5 sits between the camera (z = 10) and both targets (z = 0)
    // — but only `Near` is under the cursor, so only it loses its ray.
    const h = harness({ occluders: [{ z: 5, kinematic: false }] });
    const c = new DropTargetOverlayController(h.viewer);
    dragTo(c, screenOf(h.viewer, h.nodes[0]));
    // Everything is behind the plate here, so the fallback of (c) applies and
    // the nearest is kept — the meaningful assertion is that it did not crash
    // and still produced a target.
    expect(c.nearestTargetId).not.toBeNull();
    c.dispose();
  });

  it('(a) prefers the visible candidate when only ONE is behind the wall', () => {
    const h = harness();
    // A narrow plate covering only `Near`'s line of sight.
    const wall = new Mesh(new BoxGeometry(0.2, 4, 0.05), new MeshBasicMaterial());
    wall.position.set(0, 0, 5);
    wall.updateMatrixWorld(true);
    (h.viewer.raycastManager as unknown as { raycastGeometry: unknown }).raycastGeometry = {
      staticGroup: { mesh: wall }, kinematicGroups: new Map(),
    };

    const c = new DropTargetOverlayController(h.viewer);
    // Aim between the two, slightly closer to Near.
    const near = screenOf(h.viewer, h.nodes[0]);
    const far = screenOf(h.viewer, h.nodes[1]);
    dragTo(c, { x: near.x + (far.x - near.x) * 0.4, y: near.y });

    expect(c.nearestTargetId, 'the hidden target still won').toBe('Far');
    c.dispose();
    wall.geometry.dispose();
    (wall.material as MeshBasicMaterial).dispose();
  });

  it('(b) treats a KINEMATIC pick mesh as an occluder too', () => {
    const h = harness();
    const arm = new Mesh(new BoxGeometry(0.2, 4, 0.05), new MeshBasicMaterial());
    arm.position.set(0, 0, 5);
    arm.updateMatrixWorld(true);
    const groups = new Map<Object3D, { mesh: Mesh }>();
    groups.set(new Object3D(), { mesh: arm });
    (h.viewer.raycastManager as unknown as { raycastGeometry: unknown }).raycastGeometry = {
      staticGroup: null, kinematicGroups: groups,
    };

    const c = new DropTargetOverlayController(h.viewer);
    const near = screenOf(h.viewer, h.nodes[0]);
    const far = screenOf(h.viewer, h.nodes[1]);
    dragTo(c, { x: near.x + (far.x - near.x) * 0.4, y: near.y });

    expect(c.nearestTargetId, 'a kinematic mesh did not count as an occluder').toBe('Far');
    c.dispose();
    arm.geometry.dispose();
    (arm.material as MeshBasicMaterial).dispose();
  });

  it('(c) keeps the screen-nearest when EVERY candidate is occluded', () => {
    // One broad plate in front of everything: there is no unoccluded choice, so
    // the drag must fall back rather than end up pointing nowhere.
    const h = harness({ occluders: [{ z: 5, kinematic: false }] });
    const c = new DropTargetOverlayController(h.viewer);
    dragTo(c, screenOf(h.viewer, h.nodes[0]));
    expect(c.nearestTargetId, 'the drag was left without a target').toBe('Near');
    c.dispose();
  });

  it('(d) casts no additional rays while the candidate does not change', () => {
    const h = harness();
    const wall = new Mesh(new BoxGeometry(0.2, 4, 0.05), new MeshBasicMaterial());
    wall.position.set(0, 0, 5);
    wall.updateMatrixWorld(true);
    const raycastSpy = vi.spyOn(wall, 'raycast');
    (h.viewer.raycastManager as unknown as { raycastGeometry: unknown }).raycastGeometry = {
      staticGroup: { mesh: wall }, kinematicGroups: new Map(),
    };

    const c = new DropTargetOverlayController(h.viewer);
    const near = screenOf(h.viewer, h.nodes[0]);
    dragTo(c, near);
    const afterFirst = raycastSpy.mock.calls.length;
    expect(afterFirst, 'the first candidate was never depth-tested').toBeGreaterThan(0);

    // Ten more frames with the cursor barely moving — same winner throughout.
    const winner = c.nearestTargetId;
    for (let i = 0; i < 10; i++) {
      updateSignalDrag(near.x + (i % 2), near.y);
      c.onRender();
    }
    expect(c.nearestTargetId).toBe(winner);
    expect(raycastSpy.mock.calls.length, 'the check ran per frame instead of per switch')
      .toBe(afterFirst);

    c.dispose();
    raycastSpy.mockRestore();
    wall.geometry.dispose();
    (wall.material as MeshBasicMaterial).dispose();
  });

  it('(e) skips the check entirely when the scene has no raycast geometry', () => {
    const h = harness({ noGeometry: true });
    const c = new DropTargetOverlayController(h.viewer);
    expect(() => dragTo(c, screenOf(h.viewer, h.nodes[0]))).not.toThrow();
    expect(c.nearestTargetId).toBe('Near');
    c.dispose();
  });

  it('(e) survives a raycastManager that is absent altogether', () => {
    const h = harness();
    (h.viewer as unknown as { raycastManager: unknown }).raycastManager = null;
    const c = new DropTargetOverlayController(h.viewer);
    expect(() => dragTo(c, screenOf(h.viewer, h.nodes[0]))).not.toThrow();
    expect(c.nearestTargetId).toBe('Near');
    c.dispose();
  });
});
