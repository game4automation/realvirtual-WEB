// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * zone-box-handles.test.ts — plan-521 §9.6 (private asset editor) and the
 * editor half of §9.4.
 *
 *  - a face-handle drag changes Size AND Center so the opposite face stays put;
 *    ONE undo restores both fields, one redo re-applies both;
 *  - a cancelled drag (Escape) writes no op and restores the preview;
 *  - save → reload keeps the Zone fields byte-identical, and the saved GLB
 *    carries neither the box gizmo nor the handles;
 *  - the editor's LogicStep palette (behind `web_editor_add_logic_step`) knows
 *    `LogicStep_WaitForZone`.
 *
 * The drag is driven with real PointerEvents through a real camera projection,
 * the ops through a real AssetDocument — only the viewer is a narrow fake.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Group, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVZone } from '../src/core/engine/rv-zone';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { ZoneBoxHandles, type ZoneHandleId } from '@rv-private/plugins/asset-editor/zone-box-handles';
import { LOGIC_STEP_PALETTE } from '@rv-private/plugins/asset-editor/kinematics/create-actions';

const W = 400;
const H = 300;

interface Rig {
  viewer: RVViewer;
  doc: AssetDocument;
  handles: ZoneBoxHandles;
  node: Object3D;
  root: Group;
  canvas: HTMLCanvasElement;
  camera: PerspectiveCamera;
  zone: RVZone;
  select(path: string | null): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function makeRig(): Rig {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const node = new Object3D();
  node.name = 'Stopper';
  node.userData.realvirtual = { Zone: { Center: { x: 0, y: 0, z: 0 }, Size: { x: 200, y: 200, z: 200 }, Block: true } };
  root.add(node);
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  // A live instance like the editor load constructs it — the preview writes it.
  const zone = new RVZone(node);
  zone.Size.set(200, 200, 200);
  zone.Block = true;
  const gizmos = new GizmoOverlayManager(scene);
  zone.init({
    transportManager: new RVTransportManager(), signalStore: new SignalStore(), gizmoManager: gizmos,
  } as unknown as ComponentContext);
  registry.register('Zone', 'Asset/Stopper', zone);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px`;
  document.body.appendChild(canvas);
  const camera = new PerspectiveCamera(50, W / H, 0.01, 100);
  // Oblique view: the centre handle must not hide behind the ±Z face handles.
  camera.position.set(1.2, 0.9, 1.5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  let primary: string | null = null;
  const listeners = new Set<() => void>();
  const selectionManager = {
    get primaryPath() { return primary; },
    subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const viewer = {
    scene, registry, camera,
    renderer: { domElement: canvas },
    controls: { enabled: true },
    selectionManager,
    signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  const doc = scratchAssetDocument(viewer);
  const handles = new ZoneBoxHandles(viewer, doc);
  handles.install();
  cleanups.push(() => {
    handles.uninstall();
    doc.dispose();
    zone.dispose();
    gizmos.destroy();
    canvas.remove();
  });
  return {
    viewer, doc, handles, node, root, canvas, camera, zone,
    select(path) { primary = path; for (const fn of listeners) fn(); },
  };
}

/** Client-pixel position of a world point. */
function screenOf(camera: PerspectiveCamera, world: Vector3): { x: number; y: number } {
  const p = world.clone().project(camera);
  return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
}

function pointer(type: string, at: { x: number; y: number }, extra: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, { clientX: at.x, clientY: at.y, button: 0, pointerId: 7, bubbles: true, cancelable: true, ...extra });
  window.dispatchEvent(e);
  return e;
}

function zoneField(node: Object3D, field: 'Center' | 'Size'): { x: number; y: number; z: number } {
  return ((node.userData.realvirtual as Record<string, Record<string, unknown>>).Zone[field]) as { x: number; y: number; z: number };
}

function handleAt(r: Rig, id: ZoneHandleId): { x: number; y: number } {
  r.handles.update();
  const w = r.handles.handleWorldPosition(id, new Vector3());
  expect(w, `handle ${id} attached`).not.toBeNull();
  return screenOf(r.camera, w!);
}

describe('Zone box handles (plan-521 §9.6)', () => {
  it('attach to a selected Zone node only', () => {
    const r = makeRig();
    expect(r.handles.attachedPath).toBeNull();
    r.select('Asset/Stopper');
    expect(r.handles.attachedPath).toBe('Asset/Stopper');
    r.select('Asset');
    expect(r.handles.attachedPath).toBeNull();
  });

  it('+X face drag: Size and Center change, the opposite face stays; one undo restores both, redo re-applies both', async () => {
    const r = makeRig();
    r.select('Asset/Stopper');
    const start = handleAt(r, '+x');
    const down = pointer('pointerdown', start);
    expect(down.defaultPrevented).toBe(true); // claimed — the marquee never sees it
    expect((r.viewer.controls as { enabled: boolean }).enabled).toBe(false);
    // Drag the +X face from x = 0.1 m to x = 0.2 m (face plane through it).
    pointer('pointermove', screenOf(r.camera, new Vector3(0.2, 0, 0)));
    // Live preview on the instance, document untouched.
    expect(r.zone.Size.x).toBeCloseTo(300, 1);
    expect(zoneField(r.node, 'Size').x).toBe(200);
    pointer('pointerup', screenOf(r.camera, new Vector3(0.2, 0, 0)));
    await r.handles.whenIdle();
    expect((r.viewer.controls as { enabled: boolean }).enabled).toBe(true);

    const size = zoneField(r.node, 'Size');
    const center = zoneField(r.node, 'Center');
    expect(size.x).toBeCloseTo(300, 1);
    expect(center.x).toBeCloseTo(50, 1);
    expect(center.x - size.x / 2).toBeCloseTo(-100, 2); // opposite face ±0.01 mm
    expect(size.y).toBe(200);
    expect(r.doc.document.opCount).toBe(1); // ONE composite undo unit for both fields

    await r.doc.undo();
    expect(zoneField(r.node, 'Size').x).toBe(200);
    expect(zoneField(r.node, 'Center').x).toBe(0);
    expect(r.doc.document.opCount).toBe(0);

    await r.doc.redo();
    expect(zoneField(r.node, 'Size').x).toBeCloseTo(300, 1);
    expect(zoneField(r.node, 'Center').x).toBeCloseTo(50, 1);
  });

  it('Shift snaps to 5 mm and the size never drops below 1 mm', async () => {
    const r = makeRig();
    r.select('Asset/Stopper');
    pointer('pointerdown', handleAt(r, '-x'));
    // Far past the opposite face: clamps to the 1 mm minimum.
    pointer('pointermove', screenOf(r.camera, new Vector3(0.5, 0, 0)));
    expect(r.zone.Size.x).toBe(1);
    pointer('pointermove', screenOf(r.camera, new Vector3(-0.1234, 0, 0)), { shiftKey: true });
    expect(r.zone.Size.x % 5).toBe(0);
    pointer('pointerup', screenOf(r.camera, new Vector3(-0.1234, 0, 0)));
    await r.handles.whenIdle();
    const size = zoneField(r.node, 'Size');
    const center = zoneField(r.node, 'Center');
    expect(center.x + size.x / 2).toBeCloseTo(100, 2); // the +X face stayed
  });

  it('centre handle moves Center only; Escape mid-drag cancels without an op', async () => {
    const r = makeRig();
    r.select('Asset/Stopper');
    // A target in the image plane through the centre (the drag plane).
    const camDir = r.camera.getWorldDirection(new Vector3());
    const target = new Vector3(0.05, 0.05, 0);
    target.addScaledVector(camDir, -target.dot(camDir));
    pointer('pointerdown', handleAt(r, 'center'));
    pointer('pointermove', screenOf(r.camera, target));
    expect(r.zone.Center.x).toBeCloseTo(target.x * 1000, 0);
    expect(r.zone.Size.x).toBe(200);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(r.zone.Center.x).toBe(0); // preview restored
    pointer('pointerup', screenOf(r.camera, target));
    await r.handles.whenIdle();
    expect(r.doc.document.opCount).toBe(0);
    expect(zoneField(r.node, 'Center').x).toBe(0);

    pointer('pointerdown', handleAt(r, 'center'));
    pointer('pointermove', screenOf(r.camera, target));
    pointer('pointerup', screenOf(r.camera, target));
    await r.handles.whenIdle();
    expect(r.doc.document.opCount).toBe(1); // Center only
    expect(zoneField(r.node, 'Center').x).toBeCloseTo(target.x * 1000, 0);
    expect(zoneField(r.node, 'Center').y).toBeCloseTo(target.y * 1000, 0);
    expect(zoneField(r.node, 'Size').x).toBe(200);
  });

  it('save → reload: Zone fields identical, no gizmo and no handles in the GLB', async () => {
    const r = makeRig();
    r.select('Asset/Stopper');
    r.handles.update();
    // The live gizmo hangs under the zone node; the handles are in the scene.
    expect(r.node.children.some((c) => c.userData._rvGizmo === true)).toBe(true);
    const authored = JSON.parse(JSON.stringify((r.node.userData.realvirtual as Record<string, unknown>).Zone));

    const glb = await exportAssetGlb(r.root, 'Asset');
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    let stopper: Object3D | null = null;
    let gizmoNodes = 0;
    gltf.scene.traverse((n) => {
      if (n.name === 'Stopper') stopper = n;
      if (n.name.startsWith('_zoneBoxHandles') || n.userData?._rvGizmo) gizmoNodes++;
    });
    expect(stopper).not.toBeNull();
    const reloaded = (stopper!.userData.realvirtual as Record<string, unknown>).Zone;
    expect(reloaded).toEqual(authored);
    expect(stopper!.children).toHaveLength(0);
    expect(gizmoNodes).toBe(0);
  });
});

describe('LogicStep palette (plan-521 §9.4)', () => {
  it('web_editor_add_logic_step / the Quick Edit palette know LogicStep_WaitForZone', () => {
    expect(LOGIC_STEP_PALETTE.map((p) => p.type)).toContain('LogicStep_WaitForZone');
  });
});
