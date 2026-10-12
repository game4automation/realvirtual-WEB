// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 §9.7 — scale extremes in the REAL viewer (baked load, real
 * OrbitControls, real NavigationController): a synthetic 500 m ground, a 5 mm
 * cube at its edge, a 10 m pole 500 m away from the cube, a node moved by a
 * transform and a drive without limits.
 *
 *  (1) initial fit: nothing clipped by near / far.
 *  (2) wheel over the cube to < 5 cm: the camera never enters it, near stays
 *      below the distance, the cube is VISIBLE (red pixels in the rendered image).
 *  (3) F on the cube: >= 60 % of the smaller image edge.
 *  (4) near and far at once: camera 0.5 mm in front of the cube, the pole
 *      500 m away is still inside the frustum (R3-4).
 *  (5) Phase-3 constants (F10) from SceneScale: ground checker, shadow camera,
 *      FPV, orientation-gizmo axis click — here for 500 m; 0.33 m and 10 m in own viewers.
 *  (6) pick p95 <= 1 ms over >= 200 surface picks on the baked scene (PickMetrics).
 *  (7) a node moved by a transform (layout event) is inside far on the next frame.
 *  (8) real simulation run: a drive without limits carries a part far outside
 *      the load bounds → inside far after <= 500 ms, without a layout event (R3-1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Box3, BoxGeometry, Frustum, Matrix4, Mesh, MeshStandardMaterial, Vector3,
  type DirectionalLight, type OrthographicCamera, type PerspectiveCamera, type WebGLRenderer,
} from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { group, withComponent } from '../fixtures/bake-fixture';
import type { SurfaceHit } from '../../src/core/engine/rv-raycast-manager';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import { FpvPlugin } from '../../src/plugins/fpv-plugin';
import { OrientationGizmoPlugin } from '../../src/plugins/rv-orientation-gizmo-plugin';
import {
  fpvScaleDefaults, groundSquareSize, shadowCameraFor,
} from '../../src/core/engine/rv-scale-constants';

const W = 640;
const H = 480;

let handle: TestViewerHandle | null = null;
const paths: Record<string, string> = {};

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

interface Internals {
  _cameraManager: { cancelCameraAnimation(): void; isCameraAnimating: boolean };
  _activeCamera: PerspectiveCamera | OrthographicCamera;
  dirLight: DirectionalLight;
}
function internals(v: RVViewer = handle!.viewer): Internals {
  return v as unknown as Internals;
}
function cam(v: RVViewer = handle!.viewer): PerspectiveCamera {
  return internals(v)._activeCamera as PerspectiveCamera;
}
function canvas(): HTMLCanvasElement {
  return handle!.viewer.renderer.domElement as HTMLCanvasElement;
}
function wheel(x: number, y: number, deltaY: number): void {
  const r = canvas().getBoundingClientRect();
  canvas().dispatchEvent(new WheelEvent('wheel', {
    clientX: r.left + x, clientY: r.top + y, deltaY, deltaMode: 0, bubbles: true, cancelable: true,
  }));
}
function toPixel(p: Vector3): { x: number; y: number } {
  const c = cam();
  c.updateMatrixWorld();
  const v = p.clone().project(c);
  return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H };
}
async function setPose(pos: Vector3, tgt: Vector3): Promise<void> {
  const v = handle!.viewer;
  internals()._cameraManager.cancelCameraAnimation();
  cam().position.copy(pos);
  v.controls.target.copy(tgt);
  v.controls.update();
  await frames(4);
}
/** Render one frame and count red-dominant pixels in a square around (x, y) (canvas px, top-left origin). */
function redPixelsAround(x: number, y: number, half: number): { red: number; total: number } {
  const v = handle!.viewer;
  v.renderFrameForCapture();
  const gl = (v.renderer as unknown as WebGLRenderer).getContext();
  const dpr = gl.drawingBufferWidth / W;
  const x0 = Math.max(0, Math.round((x - half) * dpr));
  const y0 = Math.max(0, Math.round((H - (y + half)) * dpr));
  const w = Math.min(gl.drawingBufferWidth - x0, Math.round(2 * half * dpr));
  const h = Math.min(gl.drawingBufferHeight - y0, Math.round(2 * half * dpr));
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let red = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r > 90 && r > g * 2 && r > b * 2) red++;
  }
  return { red, total: w * h };
}

const CUBE_POS = new Vector3(245, 0.0025, 245);
const POLE_POS = new Vector3(-255, 5, 245);   // 500 m from the cube

/** 500 m ground, 5 mm red cube at the edge, 10 m pole 500 m away, a mover and a drive without limits. */
function makeScene() {
  const root = group('Extremes');
  const grey = new MeshStandardMaterial({ color: 0x8899aa });
  const ground = new Mesh(new BoxGeometry(500, 0.1, 500), grey);
  ground.name = 'Ground500';
  ground.position.set(0, -0.05, 0);
  root.add(ground);
  const red = new MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 1 });
  const cube = withComponent(new Mesh(new BoxGeometry(0.005, 0.005, 0.005), red), 'Kinematic', { GroupName: '' });
  cube.name = 'Cube5mm';
  cube.position.copy(CUBE_POS);
  root.add(cube);
  const green = new MeshStandardMaterial({ color: 0x22aa22 });
  const pole = withComponent(new Mesh(new BoxGeometry(2, 10, 2), green), 'Kinematic', { GroupName: '' });
  pole.name = 'Pole';
  pole.position.copy(POLE_POS);
  root.add(pole);
  // Moved by a transform later (a Drive keeps the node through the bake).
  const mover = withComponent(group('Mover'), 'Drive', { Direction: 'LinearX', TargetSpeed: 0 });
  mover.position.set(-100, 0.5, -100);
  const moverBox = new Mesh(new BoxGeometry(1, 1, 1), green);
  moverBox.name = 'MoverBox';
  mover.add(moverBox);
  root.add(mover);
  // 1 km/s, no limits — started only in (8).
  const slide = withComponent(group('Slide'), 'Drive', { Direction: 'LinearX', TargetSpeed: 1_000_000, JogForward: false });
  slide.position.set(0, 1, -200);
  const part = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), green);
  part.name = 'SlidePart';
  slide.add(part);
  root.add(slide);
  return root;
}

function nodeByName(name: string) {
  return handle!.viewer.registry!.getNode(paths[name])!;
}

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: W, height: H, ground: true });
  const v = handle.viewer;
  await v.loadModel('scale-extremes-515.glb', { data: await objectToGlb(makeScene()) });
  v.scene.traverse((o) => {
    const p = v.registry!.getPathForNode(o);
    if (p) paths[o.name] = p;
  });
  await frames(3);
}, 60_000);

afterAll(() => {
  handle?.dispose();
  handle = null;
});

describe('plan-515 §9.7 — 500 m scene with a 5 mm cube (real viewer, baked)', () => {
  it('the fixture baked and registered the nodes', () => {
    const v = handle!.viewer;
    for (const n of ['Cube5mm', 'Pole', 'Mover', 'Slide']) expect(paths[n], n).toBeTruthy();
    const s = v.sceneScale.get();
    expect(s.empty).toBe(false);
    expect(s.maxDim).toBeGreaterThan(500);
  });

  it('(1) initial fit: no content corner is clipped by near / far', () => {
    const v = handle!.viewer;
    const c = cam();
    c.updateMatrixWorld();
    const s = v.sceneScale.get();
    let minD = Infinity, maxD = 0, maxAbsZ = 0;
    const corners: Vector3[] = [];
    // The ground (a bare CAD part — no path after the bake) plus the pole.
    const gb = new Box3(new Vector3(-250, -0.1, -250), new Vector3(250, 0, 250));
    gb.union(new Box3().setFromCenterAndSize(POLE_POS, new Vector3(2, 10, 2)));
    for (const x of [gb.min.x, gb.max.x]) for (const y of [gb.min.y, gb.max.y]) for (const z of [gb.min.z, gb.max.z]) corners.push(new Vector3(x, y, z));
    for (const p of corners) {
      const d = p.distanceTo(c.position);
      minD = Math.min(minD, d); maxD = Math.max(maxD, d);
      maxAbsZ = Math.max(maxAbsZ, Math.abs(p.clone().project(c).z));
    }
    console.log(`[plan-515] (1) initial fit: scene radius ${s.radius.toFixed(1)} m, camera→corners ${minD.toFixed(1)}..${maxD.toFixed(1)} m, ` +
      `near ${c.near.toExponential(2)} far ${c.far.toFixed(1)}, max |ndc z| ${maxAbsZ.toFixed(5)}`);
    expect(c.near).toBeLessThan(minD);
    expect(c.far).toBeGreaterThan(maxD);
    expect(maxAbsZ).toBeLessThan(1);
  });

  it('(2) wheel over the cube to < 5 cm: never inside, near < distance, cube visible', async () => {
    const v = handle!.viewer;
    const cube = nodeByName('Cube5mm');
    const cubeBox = new Box3().setFromObject(cube);
    const centre = cubeBox.getCenter(new Vector3());
    // Start 0.5 m away (the cube covers a few pixels), looking at it.
    await setPose(centre.clone().add(new Vector3(0.3, 0.25, 0.3)), centre);
    const hitOut: SurfaceHit = { point: new Vector3(), distance: 0, blocked: false, path: null };
    const r = canvas().getBoundingClientRect();
    let { x, y } = toPixel(centre);
    expect(v.raycastManager!.raycastSurface(r.left + x, r.top + y, hitOut), 'the cube is under the cursor').toBe(true);
    expect(cubeBox.clone().expandByScalar(1e-6).containsPoint(hitOut.point)).toBe(true);
    const inside = cubeBox.clone().expandByScalar(-1e-7);
    let d = cam().position.distanceTo(centre);
    let steps = 0;
    while (d >= 0.05 && steps < 80) {
      ({ x, y } = toPixel(centre));
      wheel(x, y, -100);
      await frame();
      steps++;
      const c = cam();
      expect(inside.containsPoint(c.position), 'camera inside the cube').toBe(false);
      d = c.position.distanceTo(centre);
      const surf = c.position.distanceTo(hitOut.point);
      expect(c.near, 'near below the distance to the surface').toBeLessThan(surf);
    }
    await frames(3);
    ({ x, y } = toPixel(centre));
    const px = redPixelsAround(x, y, 4);
    console.log(`[plan-515] (2) ${steps} notches: camera→cube ${d.toFixed(4)} m, near ${cam().near.toExponential(2)}, ` +
      `red pixels ${px.red}/${px.total} around (${x.toFixed(0)}, ${y.toFixed(0)})`);
    expect(d).toBeLessThan(0.05);
    expect(px.red).toBeGreaterThan(px.total / 2);
  });

  it('(3) F on the cube: >= 60 % of the smaller image edge', async () => {
    const v = handle!.viewer;
    await setPose(new Vector3(300, 100, 300), new Vector3(0, 0, 0));
    v.selectionManager.select(paths.Cube5mm);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true }));
    for (let i = 0; i < 180 && internals()._cameraManager.isCameraAnimating; i++) await frame();
    await frames(2);
    v.selectionManager.clear();
    const c = cam();
    c.updateMatrixWorld();
    const box = new Box3().setFromObject(nodeByName('Cube5mm'));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const bx of [box.min.x, box.max.x]) for (const by of [box.min.y, box.max.y]) for (const bz of [box.min.z, box.max.z]) {
      const p = toPixel(new Vector3(bx, by, bz));
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const extent = Math.max(maxX - minX, maxY - minY) / Math.min(W, H);
    const px = redPixelsAround((minX + maxX) / 2, (minY + maxY) / 2, 20);
    console.log(`[plan-515] (3) F on the 5 mm cube: ${(extent * 100).toFixed(1)} % of the smaller edge, ` +
      `distance ${c.position.distanceTo(box.getCenter(new Vector3())).toFixed(4)} m, near ${c.near.toExponential(2)}, far ${c.far.toFixed(1)}, red ${px.red}/${px.total}`);
    expect(extent).toBeGreaterThanOrEqual(0.6);
    expect(px.red).toBeGreaterThan(px.total / 2);
  });

  it('(4) near and far at once: 0.5 mm in front of the cube, the pole 500 m away is inside the frustum', async () => {
    const box = new Box3().setFromObject(nodeByName('Cube5mm'));
    const centre = box.getCenter(new Vector3());
    // Camera on the cube's +X face, 0.5 mm off it, looking toward the pole (−X).
    const pos = new Vector3(box.max.x + 0.0005, centre.y, centre.z);
    await setPose(pos, centre);
    const c = cam();
    c.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
    const poleDist = c.position.distanceTo(POLE_POS);
    console.log(`[plan-515] (4) camera 0.5 mm before the cube: near ${c.near.toExponential(3)} m, far ${c.far.toFixed(1)} m, pole at ${poleDist.toFixed(1)} m`);
    expect(c.near).toBeLessThan(0.0005);
    expect(poleDist).toBeGreaterThanOrEqual(499);
    expect(c.far).toBeGreaterThan(poleDist);
    expect(frustum.containsPoint(POLE_POS)).toBe(true);
    // And the cube face itself is in front of near.
    expect(c.position.x - box.max.x).toBeGreaterThan(c.near);
  });

  it('(5) Phase-3 constants follow SceneScale (500 m): checker, shadow camera, FPV, gizmo', async () => {
    const v = handle!.viewer;
    const s = v.sceneScale.get();
    // Ground checker: 1-2-5 ≈ min(0.5 m, maxDim/10) → the familiar 0.5 m; the texture repeat matches it.
    expect(v.groundSquareSize).toBe(groundSquareSize(s));
    expect(v.groundSquareSize).toBe(0.5);
    const ground = v.groundMesh!;
    const map = (ground.material as MeshStandardMaterial).map!;
    expect(map.repeat.x).toBeCloseTo(ground.scale.x * 200 / (8 * 0.5), 9);
    // Shadow camera.
    const sc = internals().dirLight.shadow.camera;
    const fit = shadowCameraFor(s.maxDim, { pad: 0, near: 0, far: 0, sunDist: 0 });
    expect(sc.right).toBeCloseTo(fit.pad, 9);
    expect(sc.near).toBeCloseTo(fit.near, 12);
    expect(sc.far).toBeCloseTo(fit.far, 9);
    // FPV: human scale for a 500 m scene.
    const fpv = new FpvPlugin();
    try {
      fpv.onModelLoaded({} as LoadResult, v);
      expect([fpv.eyeHeight, fpv.speed, fpv.sprintSpeed]).toEqual([1.7, 2.5, 5]);
    } finally { fpv.dispose(); }
    // Gizmo axis click from close up (3 m): pre-515 behaviour — the 5 m floor, no
    // back-off to 2·radius (711 m) on a big scene.
    await setPose(new Vector3(2, 1, 2), new Vector3(0, 0, 0));
    const camDist = cam().position.distanceTo(v.controls.target);
    const gizmo = new OrientationGizmoPlugin();
    const anim = vi.spyOn(v, 'animateCameraTo').mockImplementation(() => {});
    try {
      gizmo.onModelLoaded({} as LoadResult, v);
      (gizmo as unknown as { _executeAction(h: string): void })._executeAction('pos-x');
      const [pos, tgt] = anim.mock.calls[0] as unknown as [Vector3, Vector3];
      const dist = pos.distanceTo(tgt);
      console.log(`[plan-515] (5) 500 m: square ${v.groundSquareSize} m, shadow pad ${sc.right.toFixed(1)} near ${sc.near} far ${sc.far.toFixed(1)}, gizmo axis distance ${dist.toFixed(2)} m (camera was ${camDist.toFixed(2)} m, 2r = ${(2 * s.radius).toFixed(1)})`);
      expect(dist).toBeCloseTo(Math.max(camDist, 5), 6);
      expect(dist).toBeLessThan(10);
    } finally { anim.mockRestore(); gizmo.dispose(); }
  });

  it('(6) pick p95 <= 1 ms over >= 200 surface picks on the baked scene', async () => {
    const v = handle!.viewer;
    await setPose(new Vector3(260, 40, 260), new Vector3(200, 0, 200));
    const pm = (v as unknown as { _pickMetrics: { reset(): void } })._pickMetrics;
    pm.reset();
    const out: SurfaceHit = { point: new Vector3(), distance: 0, blocked: false, path: null };
    const r = canvas().getBoundingClientRect();
    let hits = 0;
    const N = 400;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const x = 20 + ((i * 37) % (W - 40));
      const y = 20 + ((i * 53) % (H - 40));
      if (v.raycastManager!.raycastSurface(r.left + x, r.top + y, out)) hits++;
    }
    const meanMs = (performance.now() - t0) / N;
    const snap = v.getPickMetrics();
    console.log(`[plan-515] (6) ${N} surface picks (${hits} hits): p95 ${snap.raycastP95Ms.toFixed(4)} ms over ${snap.raycastP95Samples} batched samples, ` +
      `mean incl. resolution ${meanMs.toFixed(4)} ms, raycastCount ${snap.raycastCount}`);
    expect(hits).toBeGreaterThanOrEqual(200);
    expect(snap.raycastCount).toBeGreaterThanOrEqual(200);
    expect(snap.raycastP95Samples).toBeGreaterThan(0);
    expect(snap.raycastP95Ms).toBeLessThanOrEqual(1);
  });

  it('(7) a node moved by a transform far outside the load bounds is inside far on the next frame', async () => {
    const v = handle!.viewer;
    await setPose(new Vector3(300, 100, 300), new Vector3(0, 0, 0));
    const mover = nodeByName('Mover');
    mover.position.set(0, 0.5, 900);
    mover.updateMatrixWorld(true);
    v.emit('layout-transform-update', { path: paths.Mover, position: [0, 0.5, 900], rotation: [0, 0, 0] });
    await frames(2);
    const s = v.sceneScale.get();
    const p = mover.getWorldPosition(new Vector3());
    const c = cam();
    console.log(`[plan-515] (7) moved to z=900: scene radius ${s.radius.toFixed(1)} m, far ${c.far.toFixed(1)} m, camera→mover ${c.position.distanceTo(p).toFixed(1)} m, square ${v.groundSquareSize} m`);
    expect(s.center.distanceTo(p)).toBeLessThanOrEqual(s.radius);
    expect(c.far).toBeGreaterThan(c.position.distanceTo(p));
    // The derived constants followed the new scale.
    expect(v.groundSquareSize).toBe(groundSquareSize(s));
    expect(internals().dirLight.shadow.camera.far).toBeCloseTo(shadowCameraFor(s.maxDim, { pad: 0, near: 0, far: 0, sunDist: 0 }).far, 6);
  });

  it('(8) real simulation run: a drive without limits → inside far after <= 500 ms, no layout event (R3-1)', async () => {
    const v = handle!.viewer;
    const layoutEvents: string[] = [];
    const offs = (['layout-content-added', 'layout-transform-update', 'layout-drag-end', 'model-loaded', 'model-cleared'] as const)
      .map((name) => v.on(name as 'model-loaded', () => { layoutEvents.push(name); }));
    try {
      const drive = v.drives.find((d) => d.node.name === 'Slide') as RVDrive | undefined;
      expect(drive, 'the drive was built').toBeTruthy();
      expect(v.isSimulationPaused).toBe(false);
      const partWorld = new Vector3();
      drive!.jogForward = true;
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) {
        await frame();
        drive!.node.getWorldPosition(partWorld);
        if (Math.abs(partWorld.x) > 1500) break;
      }
      drive!.jogForward = false;
      drive!.stop();
      await frame();
      drive!.node.getWorldPosition(partWorld);
      expect(Math.abs(partWorld.x), 'the part left the load bounds by far').toBeGreaterThan(1500);
      const movingBefore = v.sceneScale.stats.movingComputes;
      const tStop = performance.now();
      while (performance.now() - tStop < 560) await frame();
      const s = v.sceneScale.get();
      const c = cam();
      console.log(`[plan-515] (8) sim run: part at x=${partWorld.x.toFixed(0)} m (LinearX = −X in three); scene radius ${s.radius.toFixed(1)} m, far ${c.far.toFixed(1)} m, ` +
        `camera→part ${c.position.distanceTo(partWorld).toFixed(1)} m, moving recomputes +${v.sceneScale.stats.movingComputes - movingBefore}`);
      expect(layoutEvents).toEqual([]);
      expect(s.center.distanceTo(partWorld)).toBeLessThanOrEqual(s.radius + 1e-6);
      expect(c.far).toBeGreaterThan(c.position.distanceTo(partWorld));
    } finally {
      for (const off of offs) off();
    }
  }, 30_000);
});

// ─── 0.33 m model: Phase-3 constants in their own viewer ──────────────────

describe('plan-515 Phase 3 — derived constants for a 0.33 m model', () => {
  let small: TestViewerHandle | null = null;
  afterAll(() => { small?.dispose(); small = null; });

  it('checker 5 cm, shadow camera, FPV eye/speed, gizmo axis click stays close (not >= 5 m)', async () => {
    small = await createTestViewer('webgl', { width: 480, height: 360, ground: true });
    const v = small.viewer;
    const root = group('Small');
    const mat = new MeshStandardMaterial({ color: 0x8899aa });
    const body = new Mesh(new BoxGeometry(0.33, 0.2, 0.25), mat);
    body.name = 'Body';
    body.position.set(0, 0.1, 0);
    root.add(body);
    await v.loadModel('small-033.glb', { data: await objectToGlb(root) });
    await frames(3);
    const s = v.sceneScale.get();
    expect(s.maxDim).toBeCloseTo(0.33, 6);
    // Checker: 0.033 → 0.05 m.
    expect(v.groundSquareSize).toBe(0.05);
    const g = v.groundMesh!;
    expect((g.material as MeshStandardMaterial).map!.repeat.x).toBeCloseTo(g.scale.x * 200 / (8 * 0.05), 9);
    // Shadow camera.
    const sc = internals(v).dirLight.shadow.camera;
    expect(sc.right).toBeCloseTo(0.396, 6);
    expect(sc.near).toBeCloseTo(0.00033, 9);
    expect(sc.far).toBeCloseTo(1.32, 6);
    // FPV: eye 0.165 m, 0.11 m/s, sprint 0.22 m/s (store defaults untouched).
    const fpv = new FpvPlugin();
    try {
      fpv.onModelLoaded({} as LoadResult, v);
      const d = fpvScaleDefaults(s, { eyeHeight: 0, speed: 0, sprintSpeed: 0 });
      // float32 geometry: 0.33 m is 0.33 ± 1e-8
      expect(fpv.eyeHeight).toBeCloseTo(0.165, 6);
      expect(fpv.speed).toBeCloseTo(0.11, 6);
      expect(fpv.sprintSpeed).toBeCloseTo(0.22, 6);
      expect(d.eyeHeight).toBe(fpv.eyeHeight);
    } finally { fpv.dispose(); }
    // Gizmo axis click from the initial fit.
    const camDist = cam(v).position.distanceTo(v.controls.target);
    const gizmo = new OrientationGizmoPlugin();
    const anim = vi.spyOn(v, 'animateCameraTo').mockImplementation(() => {});
    try {
      gizmo.onModelLoaded({} as LoadResult, v);
      (gizmo as unknown as { _executeAction(h: string): void })._executeAction('pos-y');
      const [pos, tgt] = anim.mock.calls[0] as unknown as [Vector3, Vector3];
      const dist = pos.distanceTo(tgt);
      console.log(`[plan-515] 0.33 m: square ${v.groundSquareSize} m, shadow pad ${sc.right.toFixed(3)} near ${sc.near.toExponential(2)} far ${sc.far.toFixed(2)}, ` +
        `FPV eye ${fpv.eyeHeight.toFixed(3)} m speed ${fpv.speed.toFixed(3)} m/s, gizmo axis distance ${dist.toFixed(3)} m (camera was ${camDist.toFixed(3)} m, 2r ${(2 * s.radius).toFixed(3)} m)`);
      expect(dist).toBeLessThan(5);
      expect(dist).toBeCloseTo(Math.max(camDist, 2 * s.radius), 4);
    } finally { anim.mockRestore(); gizmo.dispose(); }
  }, 60_000);
});

// ─── 10 m machine: ordinary models keep the pre-515 checker and gizmo ─────

describe('plan-515 Phase 3 — a 10 m machine keeps the familiar constants', () => {
  let machine: TestViewerHandle | null = null;
  afterAll(() => { machine?.dispose(); machine = null; });

  it('checker 0.5 m, gizmo axis click from close up keeps the 5 m floor', async () => {
    machine = await createTestViewer('webgl', { width: 480, height: 360, ground: true });
    const v = machine.viewer;
    const root = group('Machine10');
    const body = new Mesh(new BoxGeometry(10, 3, 2), new MeshStandardMaterial({ color: 0x8899aa }));
    body.name = 'Body';
    body.position.set(0, 1.5, 0);
    root.add(body);
    await v.loadModel('machine-10m.glb', { data: await objectToGlb(root) });
    await frames(3);
    const s = v.sceneScale.get();
    expect(s.maxDim).toBeCloseTo(10, 5);
    expect(v.groundSquareSize).toBe(0.5);
    const g = v.groundMesh!;
    expect((g.material as MeshStandardMaterial).map!.repeat.x).toBeCloseTo(g.scale.x * 200 / (8 * 0.5), 9);
    // Close up: camera ~2 m from the target at the model root -> pre-515 5 m floor.
    internals(v)._cameraManager.cancelCameraAnimation();
    cam(v).position.set(1.2, 1.2, 1.2);
    v.controls.target.set(0, 0, 0);
    v.controls.update();
    await frames(2);
    const camDist = cam(v).position.distanceTo(v.controls.target);
    const gizmo = new OrientationGizmoPlugin();
    const anim = vi.spyOn(v, 'animateCameraTo').mockImplementation(() => {});
    try {
      gizmo.onModelLoaded({} as LoadResult, v);
      (gizmo as unknown as { _executeAction(h: string): void })._executeAction('pos-z');
      const [pos, tgt] = anim.mock.calls[0] as unknown as [Vector3, Vector3];
      const dist = pos.distanceTo(tgt);
      console.log(`[plan-515] 10 m: square ${v.groundSquareSize} m, gizmo axis distance ${dist.toFixed(3)} m (camera was ${camDist.toFixed(3)} m, 2r ${(2 * s.radius).toFixed(3)} m)`);
      expect(dist).toBeCloseTo(Math.max(camDist, 5), 4);
    } finally { anim.mockRestore(); gizmo.dispose(); }
  }, 60_000);
});
