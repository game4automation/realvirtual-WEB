// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 Phase 1b (§9.6) — the embed navigates like the main viewer.
 *
 * One page: the REAL main viewer plus two `RVEmbedViewer`s whose canvases sit
 * in shadow roots (as inside `<rv-embed>`), all showing the same GLB.
 *
 *  (a) the same wheel sequence as navigation-controls.browser.test.ts (off-
 *      centre zoom in, a zoom out, more zoom in; `wheelZoomToCursor` on in all
 *      three viewers — the default anchor, decision 2026-09-29) gives the same camera poses and
 *      the same surface hits in the main viewer and in BOTH embeds. Tolerance
 *      1 µm: the three viewers run the same controller and the same pick
 *      backend over the same baked geometry with the same camera (fov 50,
 *      640×480); the only numeric difference is the canvas offset subtracted in
 *      the client→NDC conversion (~1e-16 relative per notch). 1 µm is still
 *      ~1000× below one pixel at these distances (1 px ≈ 1–5 mm at 0.3–5 m),
 *      so a real divergence (other step, other pick, other ray) cannot hide in it.
 *  (b) wheel on one embed moves neither the other embed nor the main viewer
 *      (no shared state).
 *  (c) after suspendContext() / resumeContext(newCanvas) the embed still picks
 *      the same surface and zooms through the NEW canvas; the old canvas is dead.
 *  (d) dispose() leaves no DOM listener behind (add/remove spies on every
 *      Node / Window target, keyed by target, type, capture and listener).
 *  (e) keyboard scoping (R3-2): F / Shift+F / Escape act only in the viewer the
 *      key event passed through — main viewer, embed A, embed B — including the
 *      shadow-DOM retargeting at the document and the main viewer's scoped
 *      Escape-exits-isolate.
 *  Phase 2: the same right-drag orbit, background grab, middle-drag pan,
 *      one-finger touch orbit and two-finger pinch + pan give the same camera
 *      poses and pivots in the main viewer and both embeds — in the DEFAULT
 *      mode (orbit about controls.target, pan in the target plane) and with
 *      `navigateAroundCursorPoint` (surface pivot, the background grab keeps
 *      it); a drag in one embed moves nothing else; a passive embed (controls
 *      disabled) ignores drags.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import type { SurfaceHit } from '../../src/core/engine/rv-raycast-manager';
import type { NavigationController } from '../../src/core/engine/rv-navigation-controller';
import { RVEmbedViewer } from '../../src/embed/rv-embed-viewer';

const W = 640;
const H = 480;
const TOL = 1e-6;

let main: TestViewerHandle | null = null;
let glb: ArrayBuffer;

interface EmbedHandle {
  host: HTMLDivElement;
  root: ShadowRoot;
  canvas: HTMLCanvasElement;
  viewer: RVEmbedViewer;
}
const embeds: EmbedHandle[] = [];

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

/** Same scene as navigation-controls.browser.test.ts. */
function makeScene(): Group {
  const root = new Group();
  root.name = 'NavScene';
  const mat = new MeshStandardMaterial({ color: 0x8899aa });
  const floor = new Mesh(new BoxGeometry(4, 0.1, 4), mat);
  floor.name = 'Floor';
  floor.position.set(0, -0.05, 0);
  root.add(floor);
  for (let i = 0; i < 9; i++) {
    const b = new Mesh(new BoxGeometry(0.4, 0.6, 0.4), mat);
    b.name = `Box${i}`;
    b.position.set((i % 3) - 1, 0.3, Math.floor(i / 3) - 1);
    root.add(b);
    const s = new Mesh(new SphereGeometry(0.15, 24, 12), mat);
    s.name = `Ball${i}`;
    s.position.set((i % 3) - 1, 0.75, Math.floor(i / 3) - 1);
    root.add(s);
  }
  return root;
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:absolute; left:0; top:0; width:${W}px; height:${H}px; display:block;`;
  return canvas;
}

async function createEmbed(top: number): Promise<EmbedHandle> {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed; left:${W + 10}px; top:${top}px; width:${W}px; height:${H}px;`;
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const canvas = makeCanvas();
  root.appendChild(canvas);
  const viewer = new RVEmbedViewer({ canvas, width: W, height: H });
  await viewer.loadModel('nav-515-embed.glb', glb.slice(0));
  return { host, root, canvas, viewer };
}

// ─── per-viewer adapters ───────────────────────────────────────────

interface Nav {
  name: string;
  canvas(): HTMLCanvasElement;
  camera(): PerspectiveCamera;
  target(): Vector3;
  surface(x: number, y: number, out: SurfaceHit): boolean;
  setPose(pos: [number, number, number], tgt: [number, number, number]): Promise<void>;
  advance(n: number): Promise<void>;
  controls(): { enableDamping: boolean };
  controller(): NavigationController;
}

function mainNav(): Nav {
  const v = main!.viewer;
  const internals = v as unknown as { _cameraManager: { cancelCameraAnimation(): void }; perspCamera: PerspectiveCamera };
  return {
    name: 'main',
    canvas: () => v.renderer.domElement as HTMLCanvasElement,
    camera: () => internals.perspCamera,
    target: () => v.controls.target,
    surface: (x, y, out) => {
      const r = (v.renderer.domElement as HTMLCanvasElement).getBoundingClientRect();
      return v.raycastManager!.raycastSurface(r.left + x, r.top + y, out);
    },
    setPose: async (pos, tgt) => {
      internals._cameraManager.cancelCameraAnimation();
      internals.perspCamera.position.set(...pos);
      v.controls.target.set(...tgt);
      v.controls.update();
      await frames(4);
    },
    advance: (n) => frames(n),
    controls: () => v.controls,
    controller: () => v.navController!,
  };
}

function embedNav(e: EmbedHandle, name: string): Nav {
  const cam = (): PerspectiveCamera => (e.viewer as unknown as { sceneCamera: PerspectiveCamera }).sceneCamera;
  const advance = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) e.viewer.step(1 / 60);
  };
  return {
    name,
    canvas: () => e.viewer.renderer.domElement,
    camera: cam,
    target: () => e.viewer.controls.target,
    surface: (x, y, out) => {
      const r = e.viewer.renderer.domElement.getBoundingClientRect();
      return e.viewer.raycastManager!.raycastSurface(r.left + x, r.top + y, out);
    },
    setPose: async (pos, tgt) => {
      e.viewer.cameraManager.cancelCameraAnimation();
      cam().position.set(...pos);
      e.viewer.controls.target.set(...tgt);
      e.viewer.controls.update();
      await advance(4);
    },
    advance,
    controls: () => e.viewer.controls,
    controller: () => e.viewer.navController!,
  };
}

function wheel(nav: Nav, x: number, y: number, deltaY: number): WheelEvent {
  const cv = nav.canvas();
  const r = cv.getBoundingClientRect();
  const ev = new WheelEvent('wheel', {
    clientX: r.left + x, clientY: r.top + y, deltaY, deltaMode: 0, bubbles: true, cancelable: true, composed: true,
  });
  cv.dispatchEvent(ev);
  return ev;
}

function newHit(): SurfaceHit {
  return { point: new Vector3(), distance: 0, blocked: false, path: null };
}

interface Sample { pos: Vector3; tgt: Vector3; hit: Vector3 | null; blocked: boolean }

const START_POS: [number, number, number] = [3, 2.5, 4];
const START_TGT: [number, number, number] = [0, 0.3, 0];
/** Zoom in ×5, out ×1, in ×4 — both directions, never near the zoom-out cap. */
const SEQUENCE = [-100, -100, -100, -100, -100, 100, -100, -100, -100, -100];

/** An off-centre pixel (>= 120 px from the centre) over geometry in the MAIN viewer. */
function offCentrePixel(nav: Nav): { x: number; y: number } {
  const out = newHit();
  for (let y = 40; y < H - 40; y += 20) {
    for (let x = W - 60; x > 40; x -= 20) {
      if (Math.hypot(x - W / 2, y - H / 2) < 120) continue;
      if (nav.surface(x, y, out)) return { x, y };
    }
  }
  throw new Error('no off-centre pixel over geometry');
}

async function runSequence(nav: Nav, px: { x: number; y: number }): Promise<Sample[]> {
  await nav.setPose(START_POS, START_TGT);
  const samples: Sample[] = [];
  for (const d of SEQUENCE) {
    wheel(nav, px.x, px.y, d);
    await nav.advance(2);
    const out = newHit();
    const got = nav.surface(px.x, px.y, out);
    samples.push({
      pos: nav.camera().position.clone(),
      tgt: nav.target().clone(),
      hit: got ? out.point.clone() : null,
      blocked: out.blocked,
    });
  }
  return samples;
}

function expectSameSamples(a: Sample[], b: Sample[], label: string): number {
  expect(b.length).toBe(a.length);
  let maxErr = 0;
  for (let i = 0; i < a.length; i++) {
    const ep = a[i].pos.distanceTo(b[i].pos);
    const et = a[i].tgt.distanceTo(b[i].tgt);
    expect(ep, `${label} notch ${i}: camera position`).toBeLessThanOrEqual(TOL);
    expect(et, `${label} notch ${i}: orbit target`).toBeLessThanOrEqual(TOL);
    expect(b[i].hit === null, `${label} notch ${i}: hit / background`).toBe(a[i].hit === null);
    expect(b[i].blocked, `${label} notch ${i}: blocked`).toBe(a[i].blocked);
    let eh = 0;
    if (a[i].hit && b[i].hit) {
      eh = a[i].hit!.distanceTo(b[i].hit!);
      expect(eh, `${label} notch ${i}: surface hit`).toBeLessThanOrEqual(TOL);
    }
    maxErr = Math.max(maxErr, ep, et, eh);
  }
  return maxErr;
}

let mainSamples: Sample[] = [];
let pixel = { x: 0, y: 0 };

beforeAll(async () => {
  main = await createTestViewer('webgl', { width: W, height: H });
  glb = await objectToGlb(makeScene());
  await main.viewer.loadModel('nav-515.glb', { data: glb.slice(0) });
  main.viewer.fov = 50; // the embed's fixed fov
  await frames(3);
  embeds.push(await createEmbed(0));
  embeds.push(await createEmbed(H + 10));
  // Controller defaults in the main viewer AND the embeds: the wheel anchors at
  // the cursor (the parity sequence is an OFF-CENTRE zoom), orbit / pan about
  // controls.target.
  for (const nav of [main.viewer.navController!, ...embeds.map((e) => e.viewer.navController!)]) {
    expect(nav.wheelZoomToCursor).toBe(true);
    expect(nav.navigateAroundCursorPoint).toBe(false);
  }
}, 60_000);

afterAll(() => {
  for (const e of embeds) {
    e.viewer.dispose();
    e.host.remove();
  }
  embeds.length = 0;
  main?.dispose();
  main = null;
});

describe('plan-515 Phase 1b — embed navigation = main viewer', () => {
  it('every embed carries its own controller, picker and scene scale', () => {
    const [a, b] = embeds;
    for (const e of embeds) {
      expect(e.viewer.navController).not.toBeNull();
      expect(e.viewer.raycastManager).not.toBeNull();
      expect(e.viewer.sceneScale.get().empty).toBe(false);
      expect(e.viewer.keyboardScope).toBe(e.canvas);
    }
    expect(a.viewer.navController).not.toBe(b.viewer.navController);
    expect(a.viewer.raycastManager).not.toBe(b.viewer.raycastManager);
    expect(a.viewer.sceneScale).not.toBe(b.viewer.sceneScale);
    // Same content → same scale in both embeds and the main viewer.
    const ms = main!.viewer.sceneScale.get();
    const as = a.viewer.sceneScale.get();
    expect(as.center.distanceTo(ms.center)).toBeLessThan(TOL);
    expect(Math.abs(as.radius - ms.radius)).toBeLessThan(TOL);
  });

  it('(a) the same wheel sequence gives the same camera poses and surface hits', async () => {
    const m = mainNav();
    pixel = offCentrePixel(m);
    mainSamples = await runSequence(m, pixel);
    // Sanity: the sequence really zoomed (and the hit stayed a surface).
    expect(mainSamples[4].pos.distanceTo(mainSamples[4].hit!)).toBeLessThan(
      new Vector3(...START_POS).distanceTo(mainSamples[4].hit!),
    );
    const zoomsA0 = embeds[0].viewer.navController!.stats.zooms;
    const errA = expectSameSamples(mainSamples, await runSequence(embedNav(embeds[0], 'A'), pixel), 'embed A');
    const errB = expectSameSamples(mainSamples, await runSequence(embedNav(embeds[1], 'B'), pixel), 'embed B');
    expect(embeds[0].viewer.navController!.stats.zooms - zoomsA0).toBe(SEQUENCE.length);
    // The embed's clipping comes from the same function: near below the hit distance.
    const camA = embedNav(embeds[0], 'A').camera();
    expect(camA.near).toBeLessThan(camA.position.distanceTo(mainSamples[SEQUENCE.length - 1].hit!));
    console.log(`[plan-515 1b] (a) pixel (${pixel.x},${pixel.y}), max deviation main↔A ${errA.toExponential(2)} m, main↔B ${errB.toExponential(2)} m`);
  });

  it('(b) wheel in one embed moves neither the other embed nor the main viewer', async () => {
    const a = embedNav(embeds[0], 'A');
    const b = embedNav(embeds[1], 'B');
    const m = mainNav();
    await b.setPose(START_POS, START_TGT);
    const bPos = b.camera().position.clone();
    const mPos = m.camera().position.clone();
    await a.setPose(START_POS, START_TGT);
    const ev = wheel(a, pixel.x, pixel.y, -100);
    expect(ev.defaultPrevented).toBe(true);
    await a.advance(2);
    await b.advance(2);
    await frames(2);
    expect(a.camera().position.distanceTo(bPos)).toBeGreaterThan(1e-3);
    // The main viewer's own render loop keeps calling controls.update() (float
    // noise ~1e-17); a wheel that leaked would move it by centimetres.
    expect(b.camera().position.distanceTo(bPos)).toBeLessThan(1e-9);
    expect(m.camera().position.distanceTo(mPos)).toBeLessThan(1e-9);
  });

  it('(c) after resumeContext() the embed picks and zooms through the NEW canvas', async () => {
    const e = embeds[0];
    const oldCanvas = e.canvas;
    const oldController = e.viewer.navController;
    e.viewer.suspendContext();
    expect(e.viewer.navController).toBeNull();
    expect(e.viewer.raycastManager).toBeNull();
    // What <rv-embed> does: a fresh canvas in place of the lost one.
    const canvas = makeCanvas();
    oldCanvas.replaceWith(canvas);
    e.canvas = canvas;
    e.viewer.resumeContext(canvas);
    expect(e.viewer.navController).not.toBeNull();
    expect(e.viewer.navController).not.toBe(oldController);
    expect(e.viewer.keyboardScope).toBe(canvas);
    // A new controller starts at the defaults.
    expect(e.viewer.navController!.wheelZoomToCursor).toBe(true);
    expect(e.viewer.navController!.navigateAroundCursorPoint).toBe(false);

    const nav = embedNav(e, 'A');
    await nav.setPose(START_POS, START_TGT);
    const out = newHit();
    expect(nav.surface(pixel.x, pixel.y, out)).toBe(true);
    const mainOut = newHit();
    await mainNav().setPose(START_POS, START_TGT);
    expect(mainNav().surface(pixel.x, pixel.y, mainOut)).toBe(true);
    expect(out.point.distanceTo(mainOut.point)).toBeLessThanOrEqual(TOL);

    // The dead canvas no longer navigates; the new one does.
    const deadEv = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    oldCanvas.dispatchEvent(deadEv);
    expect(deadEv.defaultPrevented).toBe(false);
    const zooms = e.viewer.navController!.stats.zooms;
    wheel(nav, pixel.x, pixel.y, -100);
    await nav.advance(2);
    expect(e.viewer.navController!.stats.zooms).toBe(zooms + 1);
    expect(nav.camera().position.distanceTo(new Vector3(...START_POS))).toBeGreaterThan(1e-3);
  });

  it('(d) dispose() leaves no DOM listener behind', async () => {
    type Key = string;
    const live = new Map<Key, number>();
    const ids = new WeakMap<object, number>();
    let nextId = 1;
    const idOf = (o: object): number => {
      let id = ids.get(o);
      if (id === undefined) { id = nextId++; ids.set(o, id); }
      return id;
    };
    const keyOf = (target: EventTarget, type: string, listener: unknown, options: unknown): Key | null => {
      // DOM targets only (the AbortSignal / controls dispatchers are not DOM listeners).
      if (!(target instanceof Node) && target !== window) return null;
      if (!listener || (typeof listener !== 'function' && typeof listener !== 'object')) return null;
      const capture = typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture;
      return `${idOf(target)}|${type}|${capture}|${idOf(listener as object)}`;
    };
    const proto = EventTarget.prototype;
    const origAdd = proto.addEventListener;
    const origRemove = proto.removeEventListener;
    const add = vi.spyOn(proto, 'addEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
      const k = keyOf(this, type, listener, options);
      const once = typeof options === 'object' && options !== null && (options as AddEventListenerOptions).once;
      if (k && !once && !live.has(k)) live.set(k, 1);
      return origAdd.call(this, type, listener, options);
    });
    const remove = vi.spyOn(proto, 'removeEventListener').mockImplementation(function (this: EventTarget, type, listener, options) {
      const k = keyOf(this, type, listener, options);
      if (k) live.delete(k);
      return origRemove.call(this, type, listener, options);
    });
    let added = 0;
    try {
      const e = await createEmbed(2 * (H + 10));
      // Exercise the paths that add listeners on demand: resume + a load.
      e.viewer.suspendContext();
      const canvas = makeCanvas();
      e.canvas.replaceWith(canvas);
      e.viewer.resumeContext(canvas);
      added = live.size;
      e.viewer.dispose();
      e.host.remove();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
    console.log(`[plan-515 1b] (d) DOM listeners added ${added}, left after dispose ${live.size}`);
    expect(added).toBeGreaterThan(5); // controller, picker, controls, keyboard, focus
    expect([...live.keys()]).toEqual([]);
  });
});

describe('plan-515 Phase 1b — keyboard scope: main viewer + two embeds (R3-2)', () => {
  function key(target: EventTarget, k: string, extra: KeyboardEventInit = {}): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', {
      key: k, code: k === 'Escape' ? 'Escape' : `Key${k.toUpperCase()}`,
      bubbles: true, cancelable: true, composed: true, ...extra,
    });
    target.dispatchEvent(ev);
    return ev;
  }

  it('a canvas press focuses the embed canvas (its keyboard scope)', () => {
    const e = embeds[1];
    const cv = e.viewer.renderer.domElement;
    const cap = cv.setPointerCapture;
    const rel = cv.releasePointerCapture;
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    try {
      cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, pointerId: 9 }));
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true, button: 0, pointerId: 9 }));
    } finally { cv.setPointerCapture = cap; cv.releasePointerCapture = rel; }
    expect(cv.tabIndex).toBe(0);
    expect(e.root.activeElement).toBe(cv);
    expect(document.activeElement).toBe(e.host); // retargeted at the document
  });

  it('F / Shift+F act only in the viewer the key passed through', () => {
    const v = main!.viewer;
    v.selectionManager.clear();
    const mainScene = vi.spyOn(v, 'frameSceneContent');
    const mainFit = vi.spyOn(v, 'fitToNodes');
    const [a, b] = embeds;
    const aScene = vi.spyOn(a.viewer, 'frameSceneContent');
    const bScene = vi.spyOn(b.viewer, 'frameSceneContent');
    try {
      const ev = key(a.viewer.renderer.domElement, 'f');
      expect(ev.defaultPrevented).toBe(true);
      expect(aScene).toHaveBeenCalledTimes(1);
      expect(a.viewer.cameraManager.isCameraAnimating).toBe(true); // it really frames
      expect(bScene).not.toHaveBeenCalled();
      expect(mainScene).not.toHaveBeenCalled();

      key(b.viewer.renderer.domElement, 'F', { shiftKey: true });
      expect(bScene).toHaveBeenCalledTimes(1);
      expect(aScene).toHaveBeenCalledTimes(1);
      expect(mainScene).not.toHaveBeenCalled();

      key(main!.container, 'f');
      expect(mainScene).toHaveBeenCalledTimes(1);
      key(document.body, 'f'); // outside every viewer → the primary (main) viewer
      expect(mainScene).toHaveBeenCalledTimes(2);
      expect(aScene).toHaveBeenCalledTimes(1);
      expect(bScene).toHaveBeenCalledTimes(1);
      expect(mainFit).not.toHaveBeenCalled();

      // A passive embed (controls disabled, e.g. <rv-embed> before takeover) ignores F.
      a.viewer.controls.enabled = false;
      a.viewer.cameraManager.cancelCameraAnimation();
      key(a.viewer.renderer.domElement, 'f');
      expect(a.viewer.cameraManager.isCameraAnimating).toBe(false);
    } finally {
      a.viewer.controls.enabled = true;
      a.viewer.cameraManager.cancelCameraAnimation();
      b.viewer.cameraManager.cancelCameraAnimation();
      mainScene.mockRestore();
      mainFit.mockRestore();
      aScene.mockRestore();
      bScene.mockRestore();
    }
  });

  it('Escape-exits-isolate of the main viewer is scoped like F', () => {
    const v = main!.viewer;
    // This model carries no Group component (no GroupRegistry → isolateNodes is
    // a no-op), so the isolate state is set directly; the handler under test
    // only reads the flag and calls exitIsolate().
    const internals = v as unknown as { _selectionIsolateActive: boolean };
    const exit = vi.spyOn(v, 'exitIsolate');
    internals._selectionIsolateActive = true;
    try {
      key(embeds[0].viewer.renderer.domElement, 'Escape');
      key(embeds[1].viewer.renderer.domElement, 'Escape');
      expect(exit).not.toHaveBeenCalled();
      expect(v.isSelectionIsolateActive).toBe(true);
      key(main!.container, 'Escape');
      expect(exit).toHaveBeenCalledTimes(1);
      expect(v.isSelectionIsolateActive).toBe(false);
      internals._selectionIsolateActive = true;
      key(document.body, 'Escape'); // outside every viewer → the primary viewer
      expect(exit).toHaveBeenCalledTimes(2);
      expect(v.isSelectionIsolateActive).toBe(false);
    } finally {
      exit.mockRestore();
      v.exitIsolate();
    }
  });
});

describe('plan-515 Phase 2 — embed orbit / pan / touch = main viewer (§9.6)', () => {
  function ptr(nav: Nav, type: string, x: number, y: number, buttons: number, button: number, pointerId = 1, pointerType = 'mouse'): void {
    const cv = nav.canvas();
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new PointerEvent(type, {
      clientX: r.left + x, clientY: r.top + y, pointerId, pointerType, button, buttons,
      bubbles: true, cancelable: true, composed: true, isPrimary: pointerId === 1 || pointerId === 31,
    }));
  }

  /**
   * The same drag sequence in every viewer: right-drag orbit about the surface
   * point under the cursor, a background grab that keeps that pivot, a
   * middle-drag pan, a one-finger touch orbit, a two-finger pinch + pan.
   * Inertia off (damping) and two ticks per input, so every input is applied
   * alone in its own tick in all viewers — the rotation sequence is identical.
   */
  async function runDragSequence(nav: Nav, px: { x: number; y: number }, bg: { x: number; y: number }): Promise<Sample[]> {
    await nav.setPose(START_POS, START_TGT);
    const controls = nav.controls();
    const cv = nav.canvas();
    const cap = cv.setPointerCapture;
    const rel = cv.releasePointerCapture;
    cv.setPointerCapture = () => {};
    cv.releasePointerCapture = () => {};
    controls.enableDamping = false;
    const samples: Sample[] = [];
    const sample = (): void => {
      samples.push({ pos: nav.camera().position.clone(), tgt: nav.target().clone(), hit: nav.controller().pivot.clone(), blocked: false });
    };
    try {
      // (1) right-drag orbit about the surface point
      ptr(nav, 'pointerdown', px.x, px.y, 2, 2);
      await nav.advance(2);
      for (let i = 1; i <= 5; i++) { ptr(nav, 'pointermove', px.x + 9 * i, px.y + 4 * i, 2, -1); await nav.advance(2); sample(); }
      ptr(nav, 'pointerup', px.x + 45, px.y + 20, 0, 2);
      await nav.advance(2);
      // (2) background grab: same pivot
      ptr(nav, 'pointerdown', bg.x, bg.y, 2, 2);
      await nav.advance(2);
      for (let i = 1; i <= 4; i++) { ptr(nav, 'pointermove', bg.x + 6 * i, bg.y - 3 * i, 2, -1); await nav.advance(2); sample(); }
      ptr(nav, 'pointerup', bg.x + 24, bg.y - 12, 0, 2);
      await nav.advance(2);
      // (3) middle-drag pan
      ptr(nav, 'pointerdown', px.x, px.y, 4, 1);
      await nav.advance(2);
      for (let i = 1; i <= 5; i++) { ptr(nav, 'pointermove', px.x - 8 * i, px.y + 5 * i, 4, -1); await nav.advance(2); sample(); }
      ptr(nav, 'pointerup', px.x - 40, px.y + 25, 0, 1);
      await nav.advance(2);
      // (4) one-finger touch orbit
      ptr(nav, 'pointerdown', px.x, px.y, 1, 0, 31, 'touch');
      await nav.advance(2);
      for (let i = 1; i <= 4; i++) { ptr(nav, 'pointermove', px.x + 7 * i, px.y - 2 * i, 1, -1, 31, 'touch'); await nav.advance(2); sample(); }
      // (5) second finger: pinch (spread) + two-finger pan
      const ax = px.x + 28, ay = px.y - 8;
      ptr(nav, 'pointerdown', ax + 40, ay, 1, 0, 32, 'touch');
      await nav.advance(2);
      for (let i = 1; i <= 4; i++) {
        ptr(nav, 'pointermove', ax - 10 * i, ay + 3 * i, 1, -1, 31, 'touch');
        await nav.advance(2);
        ptr(nav, 'pointermove', ax + 40 + 10 * i, ay + 3 * i, 1, -1, 32, 'touch');
        await nav.advance(2);
        sample();
      }
      ptr(nav, 'pointerup', ax - 40, ay + 12, 0, 0, 31, 'touch');
      ptr(nav, 'pointerup', ax + 80, ay + 12, 0, 0, 32, 'touch');
      await nav.advance(2);
      sample();
    } finally {
      controls.enableDamping = true;
      cv.setPointerCapture = cap;
      cv.releasePointerCapture = rel;
    }
    return samples;
  }

  function allNavs(): Array<{ navigateAroundCursorPoint: boolean }> {
    return [main!.viewer.navController!, ...embeds.map((e) => e.viewer.navController!)];
  }

  it('default mode: the same orbit / pan / touch sequence gives the same poses in the main viewer and both embeds; orbit about controls.target', async () => {
    const m = mainNav();
    for (const n of allNavs()) expect(n.navigateAroundCursorPoint).toBe(false);
    await m.setPose(START_POS, START_TGT);
    const px = offCentrePixel(m);
    const out = newHit();
    let bg = { x: -1, y: -1 };
    for (let y = 8; y < H - 8 && bg.x < 0; y += 12) {
      for (let x = 8; x < W - 8; x += 12) { if (!m.surface(x, y, out)) { bg = { x, y }; break; } }
    }
    expect(bg.x).toBeGreaterThanOrEqual(0);
    const ms = await runDragSequence(m, px, bg);
    // Sanity: the orbit turned about the fixed start target (no surface pivot).
    const T0 = new Vector3(...START_TGT);
    expect(ms[0].hit!.distanceTo(T0)).toBeLessThan(1e-9);
    expect(ms[4].tgt.distanceTo(T0)).toBeLessThan(1e-6);
    expect(ms[4].pos.distanceTo(new Vector3(...START_POS))).toBeGreaterThan(0.1);
    const errA = expectSameSamples(ms, await runDragSequence(embedNav(embeds[0], 'A'), px, bg), 'embed A (default)');
    const errB = expectSameSamples(ms, await runDragSequence(embedNav(embeds[1], 'B'), px, bg), 'embed B (default)');
    console.log(`[plan-515 default] embed parity (${ms.length} samples): max deviation main↔A ${errA.toExponential(2)} m, main↔B ${errB.toExponential(2)} m`);
  });

  it('navigateAroundCursorPoint: the same orbit / pan / touch sequence gives the same poses and pivots in the main viewer and both embeds', async () => {
    // The surface-pivot behaviour is the option since 2026-09-29.
    for (const n of allNavs()) n.navigateAroundCursorPoint = true;
    try {
      await surfacePivotParity();
    } finally {
      for (const n of allNavs()) n.navigateAroundCursorPoint = false;
    }
  });

  async function surfacePivotParity(): Promise<void> {
    const m = mainNav();
    await m.setPose(START_POS, START_TGT);
    const px = offCentrePixel(m);
    // A background pixel for the second grab (the same in every viewer: same camera, same content).
    const out = newHit();
    let bg = { x: -1, y: -1 };
    for (let y = 8; y < H - 8 && bg.x < 0; y += 12) {
      for (let x = 8; x < W - 8; x += 12) { if (!m.surface(x, y, out)) { bg = { x, y }; break; } }
    }
    expect(bg.x).toBeGreaterThanOrEqual(0);
    const H0 = newHit();
    expect(m.surface(px.x, px.y, H0)).toBe(true);
    const ms = await runDragSequence(m, px, bg);
    // Sanity: the orbit really used the surface point, the background grab kept it.
    expect(ms[0].hit!.distanceTo(H0.point)).toBeLessThan(1e-9);
    expect(ms[5].hit!.distanceTo(H0.point)).toBeLessThan(1e-9);
    expect(ms[4].pos.distanceTo(new Vector3(...START_POS))).toBeGreaterThan(0.1);
    const pinch0 = ms[18].pos.distanceTo(ms[18].tgt);
    expect(ms[ms.length - 1].pos.distanceTo(ms[ms.length - 1].tgt)).toBeLessThan(pinch0); // the pinch zoomed in
    const errA = expectSameSamples(ms, await runDragSequence(embedNav(embeds[0], 'A'), px, bg), 'embed A');
    const errB = expectSameSamples(ms, await runDragSequence(embedNav(embeds[1], 'B'), px, bg), 'embed B');
    console.log(`[plan-515 P2] embed parity (${ms.length} samples: orbit, background orbit, pan, touch orbit, pinch+pan): ` +
      `max deviation main↔A ${errA.toExponential(2)} m, main↔B ${errB.toExponential(2)} m`);
  }

  it('a drag in one embed moves neither the other embed nor the main viewer', async () => {
    const a = embedNav(embeds[0], 'A');
    const b = embedNav(embeds[1], 'B');
    const m = mainNav();
    await b.setPose(START_POS, START_TGT);
    await a.setPose(START_POS, START_TGT);
    const bPos = b.camera().position.clone();
    const mPos = m.camera().position.clone();
    const cv = a.canvas();
    const cap = cv.setPointerCapture;
    cv.setPointerCapture = () => {};
    try {
      ptr(a, 'pointerdown', 320, 240, 2, 2);
      for (let i = 1; i <= 4; i++) { ptr(a, 'pointermove', 320 + 12 * i, 240, 2, -1); await a.advance(1); }
      ptr(a, 'pointerup', 368, 240, 0, 2);
      await a.advance(30);
    } finally { cv.setPointerCapture = cap; }
    await b.advance(2);
    await frames(2);
    expect(a.camera().position.distanceTo(bPos)).toBeGreaterThan(1e-3);
    expect(b.camera().position.distanceTo(bPos)).toBeLessThan(1e-9);
    expect(m.camera().position.distanceTo(mPos)).toBeLessThan(1e-9);
  });

  it('the embed OrbitControls get no DOM input of their own; a passive embed (controls disabled) ignores drags', async () => {
    const a = embedNav(embeds[0], 'A');
    const e = embeds[0];
    expect(e.viewer.controls.mouseButtons).toEqual({ LEFT: -1, MIDDLE: -1, RIGHT: -1 });
    expect(e.viewer.controls.touches).toEqual({ ONE: -1, TWO: -1 });
    await a.setPose(START_POS, START_TGT);
    const pos = a.camera().position.clone();
    e.viewer.controls.enabled = false;
    try {
      ptr(a, 'pointerdown', 320, 240, 2, 2);
      ptr(a, 'pointermove', 400, 260, 2, -1);
      await a.advance(3);
      ptr(a, 'pointerup', 400, 260, 0, 2);
      await a.advance(3);
      expect(a.camera().position.distanceTo(pos)).toBeLessThan(1e-12);
    } finally {
      e.viewer.controls.enabled = true;
    }
  });
});
