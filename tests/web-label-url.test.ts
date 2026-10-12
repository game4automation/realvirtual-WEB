// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-529 §9.4 / §9.3b — WebLabel links in the REAL viewer, with real raycasts
 * and real pointer event sequences on the canvas:
 *
 *  - `isSafeExternalUrl`: http/https only;
 *  - a Billboard with a URL opens `window.open(url,'_blank','noopener,noreferrer')`
 *    synchronously even when an opaque, owner-less chunk is in front of it;
 *  - a Plate behind an opaque owner-less chunk is NOT clicked; behind a
 *    transparent object it IS; in the open it is; with every pick type disabled
 *    the occlusion query still blocks (it ignores the hover-type gate);
 *  - two labels open their own URLs; a label on a scene button opens its URL,
 *    a click beside it still reaches the button;
 *  - hidden by the toggle or by distance → not clickable; back → clickable;
 *  - works with the simulation paused (no `logicRunState` dependency);
 *  - a label without URL falls through to normal picking;
 *  - drag, long-press, `pointercancel` and a gesture consumed upstream (the
 *    `stopImmediatePropagation` the transform gizmo / marquee use) do not open;
 *  - hover shows the pointer cursor only over linked labels;
 *  - camera move and viewport resize re-size the Billboard with the simulation
 *    paused (the manager runs in the render path — SOL R2-1).
 */
import { afterAll, afterEach, beforeAll, describe, it, expect, vi, type MockInstance } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3, type PerspectiveCamera } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { isSafeExternalUrl } from '../src/core/hmi/help-url';
import { setOverlayVisible } from '../src/core/overlay-visibility-store';
import { RVWebLabel, WEB_LABEL_TYPE } from '../src/core/engine/rv-web-label';

const W = 800;
const H = 600;
let handle: TestViewerHandle | null = null;

const URL_BEHIND_WALL = 'https://example.com/billboard-behind-wall';
const URL_PLATE_BLOCKED = 'https://example.com/plate-blocked';
const URL_PLATE_OPEN = 'https://example.com/plate-open';
const URL_PLATE_GLASS = 'https://example.com/plate-behind-glass';
const URL_OTHER = 'https://example.com/other';
const URL_BUTTON = 'https://example.com/button';
const URL_FAR = 'https://example.com/far';

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

function canvas(): HTMLCanvasElement {
  return handle!.viewer.renderer.domElement as HTMLCanvasElement;
}

function box(name: string, pos: [number, number, number], size: [number, number, number], opts: { transparent?: boolean } = {}): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({
    color: 0x888888, transparent: !!opts.transparent, opacity: opts.transparent ? 0.3 : 1,
  }));
  m.name = name;
  m.position.set(...pos);
  return m;
}

function labelNode(name: string, pos: [number, number, number], extras: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(...pos);
  n.userData.realvirtual = { WebLabel: extras };
  return n;
}

/** Client coordinates of a world point. */
function clientOf(p: Vector3): { x: number; y: number } {
  const cam = handle!.viewer.camera;
  cam.updateMatrixWorld();
  const v = p.clone().project(cam);
  const r = canvas().getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}

function worldOfNode(name: string): Vector3 {
  let found: Object3D | null = null;
  handle!.viewer.scene.traverse((o) => { if (!found && o.name === name) found = o; });
  if (!found) throw new Error(`no node ${name}`);
  return new Vector3().setFromMatrixPosition((found as Object3D).matrixWorld);
}

/** Centre of a label's visual (sprite / plate) in client coordinates. */
function labelClient(name: string): { x: number; y: number } {
  const label = labelByName(name);
  const obj = label.visual!.object;
  obj.updateWorldMatrix(true, false);
  return clientOf(new Vector3().setFromMatrixPosition(obj.matrixWorld));
}

function labelByName(name: string): RVWebLabel {
  const reg = handle!.viewer.registry!;
  const hit = reg.getAll<RVWebLabel>(WEB_LABEL_TYPE).find((e) => e.instance.node.name === name);
  if (!hit) throw new Error(`no WebLabel on ${name}`);
  return hit.instance;
}

function pointer(type: string, x: number, y: number, init: Partial<PointerEventInit> = {}): PointerEvent {
  const ev = new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, isPrimary: true, ...init,
  });
  canvas().dispatchEvent(ev);
  return ev;
}

function click(p: { x: number; y: number }, init: Partial<PointerEventInit> = {}): void {
  pointer('pointerdown', p.x, p.y, init);
  pointer('pointerup', p.x, p.y, { ...init, buttons: 0 });
}

let openSpy: MockInstance<typeof window.open>;
let origCapture: HTMLCanvasElement['setPointerCapture'];
let origRelease: HTMLCanvasElement['releasePointerCapture'];

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: W, height: H });
  const root = new Group();
  root.name = 'LabelScene';
  // Opaque, owner-less walls (plain meshes → baked chunks without a pick owner).
  root.add(box('WallA', [-3, 0, 2], [1.6, 1.6, 0.2]));
  root.add(labelNode('BehindWallBillboard', [-3, 0, 0], { Text: 'Behind wall', Url: URL_BEHIND_WALL, FontSize: 24 }));
  root.add(box('WallB', [3, 0, 2], [1.6, 1.6, 0.2]));
  root.add(labelNode('BlockedPlate', [3, 0, 0], { Mode: 'Plate', Text: 'Blocked', Url: URL_PLATE_BLOCKED, PlateWidth: 600, PlateHeight: 300 }));
  root.add(labelNode('OpenPlate', [0, 2, 0], { Mode: 'Plate', Text: 'Open', Url: URL_PLATE_OPEN, PlateWidth: 600, PlateHeight: 300 }));
  root.add(box('Glass', [0, -2, 2], [1.6, 1.6, 0.2], { transparent: true }));
  root.add(labelNode('GlassPlate', [0, -2, 0], { Mode: 'Plate', Text: 'Glass', Url: URL_PLATE_GLASS, PlateWidth: 600, PlateHeight: 300 }));
  root.add(labelNode('Other', [3, 2.5, 0], { Text: 'Other', Url: URL_OTHER, FontSize: 24 }));
  root.add(labelNode('NoLink', [-3, 2.5, 0], { Text: 'No link', FontSize: 24 }));
  root.add(labelNode('Far', [-3, -2.5, 0], { Text: 'Far', Url: URL_FAR, FontSize: 24, MaxDistance: 30 }));
  // A scene button carrying a label above its cap (offset in mm).
  const btn = new Object3D();
  btn.name = 'PushBtn';
  btn.position.set(0, 0, 0);
  btn.userData.realvirtual = {
    PushButton3D: {},
    WebLabel: { Text: 'Button', Url: URL_BUTTON, FontSize: 24, Offset: { x: 0, y: 600, z: 0 } },
  };
  const simple = new Object3D(); simple.name = 'SimpleButton'; btn.add(simple);
  const base = box('Base', [0, 0, 0], [0.8, 0.8, 0.2]);
  base.userData.realvirtual = { SceneButtonBase: {} };
  simple.add(base);
  const cap = box('Button', [0, 0, 0.15], [0.5, 0.5, 0.1]);
  cap.userData.realvirtual = { SceneButtonMoveable: {} };
  simple.add(cap);
  root.add(btn);

  await handle.viewer.loadModel('labels.glb', { data: await objectToGlb(root) });
  await handle.viewer.whenSceneReady();
  // Pause the simulation: every link must work without a running logic.
  handle.viewer.setSimulationPaused('p529', true);
  const v = handle.viewer as unknown as { _cameraManager: { cancelCameraAnimation(): void } };
  v._cameraManager.cancelCameraAnimation();
  handle.viewer.camera.position.set(0, 0, 12);
  handle.viewer.controls.target.set(0, 0, 0);
  handle.viewer.controls.update();
  await frames(4);
  // Synthetic pointer ids cannot be captured.
  origCapture = canvas().setPointerCapture;
  origRelease = canvas().releasePointerCapture;
  canvas().setPointerCapture = () => {};
  canvas().releasePointerCapture = () => {};
}, 90_000);

afterAll(() => {
  if (handle) {
    canvas().setPointerCapture = origCapture;
    canvas().releasePointerCapture = origRelease;
  }
  handle?.dispose();
  handle = null;
});

afterEach(() => {
  openSpy?.mockRestore();
  setOverlayVisible('labels', true);
});

function spyOpen(): void {
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
}

describe('isSafeExternalUrl', () => {
  it('accepts http/https, rejects javascript:, data:, file:, relative, malformed', () => {
    expect(isSafeExternalUrl('https://grabcad.com/library')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
    expect(isSafeExternalUrl('  https://example.com  ')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/x', '/relative/path', 'example.com', 'http//x', '', '   ', null, 42]) {
      expect(isSafeExternalUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe('link clicks in the real viewer', () => {
  it('fixture: all labels built and effectively visible', () => {
    const mgr = handle!.viewer.webLabelManager;
    expect(mgr.size).toBe(8);
    expect(mgr.isEffectivelyVisible(labelByName('OpenPlate'))).toBe(true);
    expect(mgr.isEffectivelyVisible(labelByName('BehindWallBillboard'))).toBe(true);
  });

  it('Billboard with URL opens synchronously even behind an opaque owner-less chunk', () => {
    spyOpen();
    // Sanity: the wall really is an opaque blocker at that pixel.
    const p = labelClient('BehindWallBillboard');
    const out = { point: new Vector3(), distance: 0, blocked: false, path: null as string | null };
    expect(handle!.viewer.raycastManager!.raycastSurface(p.x, p.y, out)).toBe(true);
    expect(out.blocked).toBe(true);
    click(p);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(URL_BEHIND_WALL, '_blank', 'noopener,noreferrer');
  });

  it('a Plate behind an opaque owner-less chunk is NOT clicked; in the open and behind glass it is', () => {
    spyOpen();
    click(labelClient('BlockedPlate'));
    expect(openSpy).not.toHaveBeenCalled();
    click(labelClient('OpenPlate'));
    expect(openSpy).toHaveBeenLastCalledWith(URL_PLATE_OPEN, '_blank', 'noopener,noreferrer');
    click(labelClient('GlassPlate'));
    expect(openSpy).toHaveBeenLastCalledWith(URL_PLATE_GLASS, '_blank', 'noopener,noreferrer');
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('with every pick type disabled the occlusion query still blocks correctly', () => {
    spyOpen();
    const rm = handle!.viewer.raycastManager! as unknown as { _isTypeEnabled: (t: string) => boolean };
    const orig = rm._isTypeEnabled;
    rm._isTypeEnabled = () => false;
    try {
      click(labelClient('BlockedPlate'));
      expect(openSpy).not.toHaveBeenCalled();
      click(labelClient('OpenPlate'));
      expect(openSpy).toHaveBeenCalledWith(URL_PLATE_OPEN, '_blank', 'noopener,noreferrer');
    } finally {
      rm._isTypeEnabled = orig;
    }
  });

  it('two labels open their own URL', () => {
    spyOpen();
    click(labelClient('Other'));
    click(labelClient('BehindWallBillboard'));
    expect(openSpy.mock.calls.map((c) => c[0])).toEqual([URL_OTHER, URL_BEHIND_WALL]);
  });

  it('label on a scene button opens the URL; a click beside it still reaches the button', () => {
    spyOpen();
    const clicked: string[] = [];
    const off = handle!.viewer.on('object-clicked', (d) => { clicked.push(d.path); });
    click(labelClient('PushBtn'));
    expect(openSpy).toHaveBeenCalledWith(URL_BUTTON, '_blank', 'noopener,noreferrer');
    expect(clicked).toEqual([]);
    // Beside the label: on the button base.
    const base = clientOf(worldOfNode('Base').add(new Vector3(0.3, -0.3, 0.11)));
    // Let the hover sample settle on the button (the click path reads hover).
    pointer('pointermove', base.x, base.y, { buttons: 0 });
    click(base);
    off();
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(clicked.some((p) => p.includes('PushBtn'))).toBe(true);
  });

  it('hidden by the toggle or by distance → not clickable; back → clickable again', async () => {
    spyOpen();
    setOverlayVisible('labels', false);
    await frames(2);
    click(labelClient('OpenPlate'));
    expect(openSpy).not.toHaveBeenCalled();
    setOverlayVisible('labels', true);
    await frames(2);
    click(labelClient('OpenPlate'));
    expect(openSpy).toHaveBeenCalledTimes(1);

    // Distance: move the camera far out along the view axis.
    const cam = handle!.viewer.camera;
    const farLabel = labelByName('Far');
    const at = labelClient('Far');
    cam.position.set(0, 0, 60);
    handle!.viewer.controls.update();
    handle!.viewer.markRenderDirty();
    await frames(3);
    expect(handle!.viewer.webLabelManager.isEffectivelyVisible(farLabel)).toBe(false);
    click(labelClient('Far'));
    expect(openSpy).toHaveBeenCalledTimes(1);
    cam.position.set(0, 0, 12);
    handle!.viewer.controls.update();
    handle!.viewer.markRenderDirty();
    await frames(3);
    expect(handle!.viewer.webLabelManager.isEffectivelyVisible(farLabel)).toBe(true);
    click(at);
    expect(openSpy).toHaveBeenLastCalledWith(URL_FAR, '_blank', 'noopener,noreferrer');
  });

  it('a label without URL falls through to normal picking (no open)', () => {
    spyOpen();
    click(labelClient('NoLink'));
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('input sequences', () => {
  it('mouse click and touch tap open once', () => {
    spyOpen();
    click(labelClient('OpenPlate'));
    click(labelClient('OpenPlate'), { pointerType: 'touch' });
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('an orbit / drag across a label does not open', () => {
    spyOpen();
    const p = labelClient('OpenPlate');
    pointer('pointerdown', p.x - 40, p.y);
    pointer('pointermove', p.x, p.y);
    pointer('pointerup', p.x, p.y, { buttons: 0 });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('a gesture consumed upstream (gizmo drag / marquee: stopImmediatePropagation) does not open', () => {
    spyOpen();
    const consume = (e: Event) => e.stopImmediatePropagation();
    canvas().addEventListener('pointerup', consume, { capture: true });
    try {
      click(labelClient('OpenPlate'));
    } finally {
      canvas().removeEventListener('pointerup', consume, { capture: true });
    }
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('a touch long-press does not open; pointercancel does not open', async () => {
    spyOpen();
    const p = labelClient('OpenPlate');
    pointer('pointerdown', p.x, p.y, { pointerType: 'touch' });
    await new Promise((r) => setTimeout(r, 650));
    pointer('pointerup', p.x, p.y, { pointerType: 'touch', buttons: 0 });
    expect(openSpy).not.toHaveBeenCalled();
    // Close a context menu the long-press may have opened.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    pointer('pointerdown', p.x, p.y);
    pointer('pointercancel', p.x, p.y, { buttons: 0 });
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('hover shows the pointer cursor only over linked labels', () => {
    const p = labelClient('OpenPlate');
    pointer('pointermove', p.x, p.y, { buttons: 0 });
    expect(canvas().style.cursor).toBe('pointer');
    const empty = clientOf(new Vector3(-5.5, 3.8, 0));
    pointer('pointermove', empty.x, empty.y, { buttons: 0 });
    expect(canvas().style.cursor).toBe('');
    const nl = labelClient('NoLink');
    pointer('pointermove', nl.x, nl.y, { buttons: 0 });
    expect(canvas().style.cursor).not.toBe('pointer');
  });
});

describe('tick independence (§9.3b)', () => {
  it('camera move and viewport resize re-size the Billboard with the simulation paused', async () => {
    const v = handle!.viewer;
    // A label click selects AND frames its object (a7396494): the flight of the click
    // tests above would still be moving the camera and override the positions set here.
    v.cancelCameraAnimation();
    const label = labelByName('Other');
    const sprite = label.visual!.object;
    const s0 = sprite.scale.y;
    v.camera.position.set(0, 0, 20);
    v.controls.update();
    v.markRenderDirty();
    await frames(3);
    const s1 = sprite.scale.y;
    expect(s1).toBeGreaterThan(s0 * 1.4);
    // Viewport resize: a taller canvas → the same px height is fewer world units.
    const cam = v.camera as PerspectiveCamera;
    handle!.container.style.height = `${H * 2}px`;
    v.renderer.setSize(W, H * 2);
    cam.aspect = W / (H * 2);
    cam.updateProjectionMatrix();
    v.markRenderDirty();
    await frames(3);
    expect(sprite.scale.y).toBeCloseTo(s1 / 2, 3);
    handle!.container.style.height = `${H}px`;
    v.renderer.setSize(W, H);
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    v.camera.position.set(0, 0, 12);
    v.controls.update();
    v.markRenderDirty();
    await frames(3);
  });
});
