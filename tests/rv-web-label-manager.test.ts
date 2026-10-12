// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-529 §9.3 / §9.3b — `WebLabelManager`: constant Billboard screen size
 * (view-space depth, FOV, viewport, zoom, orthographic, parent scale), the
 * distance fade over ALL registered labels (a faded label comes back), the
 * global `labels` toggle, and the "nothing changed → false" contract.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { Object3D, OrthographicCamera, PerspectiveCamera, Vector3, type Camera } from 'three';
import { WebLabelManager, fadeForDistance } from '../src/core/engine/rv-web-label-manager';
import { RVWebLabel } from '../src/core/engine/rv-web-label';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { setOverlayVisible } from '../src/core/overlay-visibility-store';
import { sampleAllocations, bytesInModules } from './helpers/heap-sampling';

const VH = 600;

function makeLabel(mgr: WebLabelManager, extras: Record<string, unknown>, parent?: Object3D): RVWebLabel {
  const node = new Object3D();
  node.name = 'L';
  if (parent) parent.add(node);
  const label = new RVWebLabel(node);
  applySchema(label as unknown as Record<string, unknown>, RVWebLabel.schema, { Text: 'Hello', ...extras });
  label.init({ webLabelManager: mgr } as unknown as ComponentContext);
  return label;
}

/** Projected on-screen height of a billboard sprite in CSS px. */
function projectedHeightPx(label: RVWebLabel, camera: Camera, vh: number): number {
  const obj = label.visual!.object;
  obj.updateWorldMatrix(true, false);
  const center = new Vector3().setFromMatrixPosition(obj.matrixWorld);
  const scale = new Vector3().setFromMatrixScale(obj.matrixWorld);
  // Camera-up in world space → the sprite's vertical extent.
  camera.updateMatrixWorld();
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(scale.y / 2);
  const a = center.clone().add(up).project(camera);
  const b = center.clone().sub(up).project(camera);
  return (Math.abs(a.y - b.y) / 2) * vh;
}

function persp(): PerspectiveCamera {
  const c = new PerspectiveCamera(50, 800 / VH, 0.01, 1000);
  c.position.set(0, 0, 10);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

afterEach(() => setOverlayVisible('labels', true));

describe('Billboard constant screen size (SOL #7)', () => {
  it('projected height is constant at two depths, centre and off-centre', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const near = makeLabel(mgr, { FontSize: 20 });
    const far = makeLabel(mgr, { FontSize: 20 });
    const off = makeLabel(mgr, { FontSize: 20 });
    far.node.position.set(0, 0, -40);
    off.node.position.set(3, 2, 0);
    for (const l of [near, far, off]) l.node.updateMatrixWorld(true);
    mgr.update(cam, VH);
    const target = near.visual!.screenHeightPx;
    expect(target).toBeGreaterThan(20);
    expect(projectedHeightPx(near, cam, VH)).toBeCloseTo(target, 3);
    expect(projectedHeightPx(far, cam, VH)).toBeCloseTo(target, 3);
    // Off-centre: view-space depth (not Euclidean distance) keeps it constant.
    expect(projectedHeightPx(off, cam, VH)).toBeCloseTo(target, 1);
  });

  it('stays constant after an FOV, viewport and zoom change', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const l = makeLabel(mgr, {});
    l.node.updateMatrixWorld(true);
    mgr.update(cam, VH);
    const target = l.visual!.screenHeightPx;
    cam.fov = 30; cam.updateProjectionMatrix();
    expect(mgr.update(cam, VH)).toBe(true);
    expect(projectedHeightPx(l, cam, VH)).toBeCloseTo(target, 3);
    cam.zoom = 2.5; cam.updateProjectionMatrix();
    mgr.update(cam, VH);
    expect(projectedHeightPx(l, cam, VH)).toBeCloseTo(target, 3);
    mgr.update(cam, 900);
    expect(projectedHeightPx(l, cam, 900)).toBeCloseTo(target, 3);
  });

  it('orthographic camera (with zoom)', () => {
    const mgr = new WebLabelManager();
    const cam = new OrthographicCamera(-4, 4, 3, -3, 0.01, 100);
    cam.position.set(0, 0, 10); cam.lookAt(0, 0, 0); cam.zoom = 1.7; cam.updateProjectionMatrix();
    const l = makeLabel(mgr, { FontSize: 18 });
    l.node.updateMatrixWorld(true);
    mgr.update(cam, VH);
    expect(projectedHeightPx(l, cam, VH)).toBeCloseTo(l.visual!.screenHeightPx, 3);
  });

  it('under a parent scaled ×2 the on-screen size does not change', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const parent = new Object3D();
    parent.scale.setScalar(2);
    const l = makeLabel(mgr, {}, parent);
    parent.updateMatrixWorld(true);
    mgr.update(cam, VH);
    expect(projectedHeightPx(l, cam, VH)).toBeCloseTo(l.visual!.screenHeightPx, 3);
  });
});

describe('fade + visibility over all registered labels (SOL #8)', () => {
  it('fadeForDistance: 1 below 80 %, linear to 0 at 100 %', () => {
    expect(fadeForDistance(5, 0)).toBe(1);
    expect(fadeForDistance(7.9, 10)).toBe(1);
    expect(fadeForDistance(9, 10)).toBeCloseTo(0.5, 9);
    expect(fadeForDistance(10, 10)).toBe(0);
    expect(fadeForDistance(12, 10)).toBe(0);
  });

  it('near → far → near: fades, hides and reappears; hidden is not effectively visible', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const l = makeLabel(mgr, { MaxDistance: 20 });
    l.node.updateMatrixWorld(true);
    mgr.update(cam, VH); // 10 m
    expect(l.visual!.object.visible).toBe(true);
    expect((l.visual!.material as { opacity: number }).opacity).toBe(1);
    cam.position.set(0, 0, 18); cam.updateMatrixWorld();
    mgr.update(cam, VH);
    expect((l.visual!.material as { opacity: number }).opacity).toBeCloseTo(0.5, 6);
    cam.position.set(0, 0, 25); cam.updateMatrixWorld();
    expect(mgr.update(cam, VH)).toBe(true);
    expect(l.visual!.object.visible).toBe(false);
    expect(mgr.isEffectivelyVisible(l)).toBe(false);
    cam.position.set(0, 0, 5); cam.updateMatrixWorld();
    mgr.update(cam, VH);
    expect(l.visual!.object.visible).toBe(true);
    expect((l.visual!.material as { opacity: number }).opacity).toBe(1);
  });

  it('toggle off/on while out of range stays hidden until back in range', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const l = makeLabel(mgr, { MaxDistance: 20 });
    l.node.updateMatrixWorld(true);
    cam.position.set(0, 0, 30); cam.updateMatrixWorld();
    mgr.update(cam, VH);
    expect(l.visual!.object.visible).toBe(false);
    setOverlayVisible('labels', false);
    mgr.update(cam, VH);
    setOverlayVisible('labels', true);
    mgr.update(cam, VH);
    expect(l.visual!.object.visible).toBe(false);
    cam.position.set(0, 0, 10); cam.updateMatrixWorld();
    mgr.update(cam, VH);
    expect(l.visual!.object.visible).toBe(true);
  });

  it("setOverlayVisible('labels', false) hides every label, true shows them", () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const a = makeLabel(mgr, {});
    const b = makeLabel(mgr, { Mode: 'Plate' });
    a.node.updateMatrixWorld(true); b.node.updateMatrixWorld(true);
    mgr.update(cam, VH);
    expect(a.visual!.object.visible && b.visual!.object.visible).toBe(true);
    setOverlayVisible('labels', false);
    expect(mgr.update(cam, VH)).toBe(true);
    expect(a.visual!.object.visible || b.visual!.object.visible).toBe(false);
    setOverlayVisible('labels', true);
    mgr.update(cam, VH);
    expect(a.visual!.object.visible && b.visual!.object.visible).toBe(true);
  });

  it('a hidden owner hides the label', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const parent = new Object3D();
    const l = makeLabel(mgr, {}, parent);
    parent.updateMatrixWorld(true);
    mgr.update(cam, VH);
    parent.visible = false;
    mgr.update(cam, VH);
    expect(mgr.isEffectivelyVisible(l)).toBe(false);
  });
});

describe('update() contract', () => {
  it('returns false when nothing moved; clear() disposes and empties', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const l = makeLabel(mgr, {});
    l.node.updateMatrixWorld(true);
    expect(mgr.update(cam, VH)).toBe(true);
    expect(mgr.update(cam, VH)).toBe(false);
    expect(mgr.update(cam, VH)).toBe(false);
    cam.position.set(0, 0, 12); cam.updateMatrixWorld();
    expect(mgr.update(cam, VH)).toBe(true);
    expect(mgr.size).toBe(1);
    mgr.clear();
    expect(mgr.size).toBe(0);
    expect(l.visual).toBeNull();
    expect(l.node.children.length).toBe(0);
  });

  it('allocates nothing in its own module per frame (V8 sampling heap profiler)', async () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    for (let i = 0; i < 20; i++) {
      const l = makeLabel(mgr, { MaxDistance: 50, Mode: i % 2 ? 'Plate' : 'Billboard' });
      l.node.position.set(i * 0.3, 0, 0);
      l.node.updateMatrixWorld(true);
    }
    const N = 3000;
    let k = 0;
    const frame = () => {
      cam.position.set(Math.sin(k) * 3, 1, 10 + (k % 7)); k++;
      mgr.update(cam, VH);
    };
    const report = await sampleAllocations(() => { for (let i = 0; i < N; i++) frame(); }, 32,
      () => { for (let i = 0; i < 500; i++) frame(); });
    if (!report) {
      console.log('[plan-529] CDP heap sampling unavailable — allocation check skipped');
      return;
    }
    const own = bytesInModules(report, /rv-web-label-manager/);
    console.log(`[plan-529] WebLabelManager.update: ~${(own / N).toFixed(2)} B/frame in own module (20 labels)`);
    expect(own / N).toBeLessThan(16);
  });
});

describe('Billboard under a frozen owner (static sweep)', () => {
  it('rebuilds the sprite world matrix from the scale it sets', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    const parent = new Object3D();
    parent.position.set(0.5, 0, 0);
    parent.updateMatrixWorld(true);
    const label = makeLabel(mgr, { Text: '3020 Suction roller', FontSize: 14 }, parent);
    const sprite = label.visual!.object;
    // The static sweep computes every world matrix once, then freezes the
    // owner AND the already-attached sprite.
    parent.updateMatrixWorld(true);
    parent.matrixAutoUpdate = false;
    parent.matrixWorldAutoUpdate = false;
    sprite.matrixAutoUpdate = false;
    sprite.matrixWorldAutoUpdate = false;
    expect(mgr.update(cam, VH)).toBe(true);
    const e = sprite.matrixWorld.elements;
    const worldX = Math.hypot(e[0], e[1], e[2]);
    const worldY = Math.hypot(e[4], e[5], e[6]);
    expect(worldX).toBeCloseTo(sprite.scale.x, 6);
    expect(worldY).toBeCloseTo(sprite.scale.y, 6);
    expect(worldX / worldY).toBeCloseTo(label.visual!.aspect, 6);
    // Position (offset) went through the frozen parent as well.
    expect(e[12]).toBeCloseTo(0.5, 6);
  });
});

describe('labels are pick targets of their node (hover = hover the object, click = select)', () => {
  function pickSpy() {
    const added: Array<[Object3D, Object3D]> = [];
    const removed: Object3D[] = [];
    return {
      added, removed,
      pick: {
        addAuxRaycastTarget: (m: Object3D, o: Object3D) => { added.push([m, o]); },
        removeAuxRaycastTarget: (m: Object3D) => { removed.push(m); },
      },
    };
  }
  function canvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 800; c.height = VH;
    Object.defineProperty(c, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 800, height: VH, right: 800, bottom: VH, x: 0, y: 0, toJSON() {} }) });
    return c;
  }

  it('register → the visual is an aux target owned by the label node; unregister removes it', () => {
    const mgr = new WebLabelManager();
    const spy = pickSpy();
    mgr.bindHost({ getCamera: persp, getCanvas: canvas, pick: spy.pick });
    const label = makeLabel(mgr, { FontSize: 20 });
    expect(spy.added).toHaveLength(1);
    expect(spy.added[0][0]).toBe(label.visual!.object);
    expect(spy.added[0][1]).toBe(label.node);
    mgr.unregister(label);
    expect(spy.removed).toEqual([label.visual!.object]);
  });

  it('a rebuilt visual (Mode switch) swaps the registration on the next update', () => {
    const mgr = new WebLabelManager();
    const spy = pickSpy();
    mgr.bindHost({ getCamera: persp, getCanvas: canvas, pick: spy.pick });
    const label = makeLabel(mgr, { FontSize: 20 });
    const first = label.visual!.object;
    (label as unknown as { Mode: string }).Mode = 'Plate';
    label.reapplyConfig();
    mgr.update(persp(), VH);
    const second = label.visual!.object;
    expect(second).not.toBe(first);
    expect(spy.removed).toContain(first);
    expect(spy.added[spy.added.length - 1][0]).toBe(second);
  });

  it('labelAt finds an UNLINKED visible label under the point (hitTest(linkedOnly=false))', () => {
    const mgr = new WebLabelManager();
    const cam = persp();
    mgr.bindHost({ getCamera: () => cam, getCanvas: canvas });
    const label = makeLabel(mgr, { FontSize: 20 }); // no Url → not linked
    mgr.update(cam, VH);
    expect(mgr.isEffectivelyVisible(label)).toBe(true);
    // The label sits at the origin, the camera looks at it from +z: screen centre.
    expect(mgr.isLinkAt(400, VH / 2)).toBe(false);
    expect(mgr.labelAt(400, VH / 2)).toBe(label);
  });
});

describe('refreshPickTargets re-registers every visual (raycast manager created after the labels)', () => {
  it('adds each visual again with its node as owner', () => {
    const mgr = new WebLabelManager();
    const added: Array<[Object3D, Object3D]> = [];
    mgr.bindHost({
      getCamera: persp,
      getCanvas: () => document.createElement('canvas'),
      pick: { addAuxRaycastTarget: (m: Object3D, o: Object3D) => { added.push([m, o]); }, removeAuxRaycastTarget: () => {} },
    });
    const a = makeLabel(mgr, { FontSize: 20 });
    const b = makeLabel(mgr, { FontSize: 20 });
    added.length = 0;
    mgr.refreshPickTargets();
    expect(added).toEqual([[a.visual!.object, a.node], [b.visual!.object, b.node]]);
  });
});

describe('hover / selection feedback on the label (border + pin)', () => {
  function emphasisHost(opts: { hovered?: () => Object3D | null; selected?: (n: Object3D) => boolean; hit?: boolean }) {
    const scene = new Object3D();
    const host = {
      getHoveredNode: opts.hovered ?? (() => null),
      isSelected: opts.selected ?? (() => false),
      colors: () => ({ hover: 0x4aa3ff, selection: 0x1e88ff }),
      castDown: (_o: Vector3, _n: Object3D, out: Vector3) => { if (!opts.hit) return false; out.set(0, -1, 0); return true; },
      getScene: () => scene,
    };
    return { host, scene };
  }
  const pinsIn = (scene: Object3D) => scene.children.filter((c) => c.name === '__rvWebLabelPin');
  const border = (label: RVWebLabel) => (label as unknown as { _emphasis: string | null })._emphasis;

  it('hovering the node (or a descendant) draws the hover border; a hit below adds the pin', () => {
    const mgr = new WebLabelManager();
    let hovered: Object3D | null = null;
    const { host, scene } = emphasisHost({ hovered: () => hovered, hit: true });
    mgr.bindHost({ getCamera: persp, getCanvas: () => document.createElement('canvas'), emphasis: host });
    const label = makeLabel(mgr, { FontSize: 20 });
    const child = new Object3D(); label.node.add(child);
    mgr.update(persp(), VH);
    expect(border(label)).toBeNull();
    expect(pinsIn(scene)).toHaveLength(0);

    hovered = child;
    expect(mgr.update(persp(), VH)).toBe(true);
    expect(border(label)).toBe('#4aa3ff');
    expect(pinsIn(scene)).toHaveLength(1);

    hovered = null;
    mgr.update(persp(), VH);
    expect(border(label)).toBeNull();
    expect(pinsIn(scene)).toHaveLength(0);
  });

  it('selection wins over hover and uses the selection colour; no hit below → border only', () => {
    const mgr = new WebLabelManager();
    const { host, scene } = emphasisHost({ hovered: () => label.node, selected: (n) => n === label.node, hit: false });
    mgr.bindHost({ getCamera: persp, getCanvas: () => document.createElement('canvas'), emphasis: host });
    const label = makeLabel(mgr, { FontSize: 20 });
    mgr.update(persp(), VH);
    expect(border(label)).toBe('#1e88ff');
    expect(pinsIn(scene)).toHaveLength(0);
  });

  it('unregister removes the pin', () => {
    const mgr = new WebLabelManager();
    const { host, scene } = emphasisHost({ hovered: () => label.node, hit: true });
    mgr.bindHost({ getCamera: persp, getCanvas: () => document.createElement('canvas'), emphasis: host });
    const label = makeLabel(mgr, { FontSize: 20 });
    mgr.update(persp(), VH);
    expect(pinsIn(scene)).toHaveLength(1);
    mgr.unregister(label);
    expect(pinsIn(scene)).toHaveLength(0);
  });
});
