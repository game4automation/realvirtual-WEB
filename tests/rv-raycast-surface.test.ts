// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 §9.3 — `RaycastManager.raycastSurface`, the navigation pick.
 *
 *  - an opaque unowned segment in front of a selectable part → `blocked = true`
 *    with the BLOCKER's distance (R2-5: RAYCAST_BLOCKED is a surface);
 *  - a transparent chunk passes, a hidden node is skipped;
 *  - a visible part whose type is NOT hover-enabled is still a surface (R2-5);
 *  - isolation still gates, background answers false;
 *  - `raycastForRVNodeDetailed` answers exactly as before for the same cases;
 *  - the optional caller-owned `out.ray` receives the pick ray, hit or not;
 *  - measurement (R2-7): per-pick p95 and heap growth on a baked scene.
 */
import { afterEach, describe, it, expect } from 'vitest';
import {
  Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, SphereGeometry, Vector3,
} from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RaycastManager, type SurfaceHit } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { PickMetrics } from '../src/core/engine/rv-pick-metrics';
import { bakeAndPlace, group, uberBakeGeometry, uberMesh, withComponent } from './fixtures/bake-fixture';
import { sampleAllocations } from './helpers/heap-sampling';

registerComponentSchema('TestNavSurf', {}, { pick: 'select' });
registerComponentSchema('TestNavNoHover', {}, { pick: 'select' });

const uber = new RVUberMaterial(false);
const SIZE = 200;

let canvas: HTMLCanvasElement | null = null;
afterEach(() => { canvas?.remove(); canvas = null; });

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  c.style.cssText = `position:fixed;left:0;top:0;width:${SIZE}px;height:${SIZE}px;`;
  document.body.appendChild(c);
  canvas = c;
  return c;
}

/** Camera on +Z looking down −Z: the canvas centre is the ray (0,0,10) → −Z. */
function makeCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(40, 1, 0.01, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

async function place(root: Object3D, opts: { survives?: (n: Object3D) => boolean } = {}) {
  const scene = new Scene();
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry, { uber, ...opts });
  scene.add(placed.template);
  scene.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const cam = makeCamera();
  const rm = new RaycastManager(
    { domElement: makeCanvas() }, () => cam, scene, registry,
    { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
  rm.addBackend(new PickBackend(bakeRegistry));
  rm.enableHoverType('TestNavSurf', true);
  const out: SurfaceHit = { point: new Vector3(), distance: 0, blocked: false, path: null };
  const surface = (x = SIZE / 2, y = SIZE / 2): boolean => rm.raycastSurface(x, y, out);
  const detailed = (x = SIZE / 2, y = SIZE / 2) => rm.raycastForRVNodeDetailed({ clientX: x, clientY: y });
  return { placed, rm, registry, out, surface, detailed, cam, scene };
}

function pathOf(registry: NodeRegistry, n: Object3D): string {
  return registry.getPathForNode(n)!;
}

describe('RaycastManager.raycastSurface (plan-515)', () => {
  it('writes the pick ray into an optional out.ray — for a hit and for background', async () => {
    const root = group('Asset');
    const part = withComponent(group('Part'), 'TestNavSurf');
    part.add(uberMesh(uber, 'partMesh', [0, 0, 0]));
    root.add(part);
    const { rm, cam } = await place(root);
    const out: SurfaceHit = {
      point: new Vector3(), distance: 0, blocked: false, path: null,
      ray: { origin: new Vector3(), direction: new Vector3() },
    };
    expect(rm.raycastSurface(SIZE / 2, SIZE / 2, out)).toBe(true);
    expect(out.ray!.origin.distanceTo(cam.position)).toBeLessThan(1e-9);
    expect(out.ray!.direction.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
    // The hit lies ON the ray it reports.
    const onRay = out.ray!.origin.clone().addScaledVector(out.ray!.direction, out.distance);
    expect(onRay.distanceTo(out.point)).toBeLessThan(1e-6);
    // Background (corner pixel): false, but the ray is still written.
    out.ray!.direction.set(0, 0, 0);
    expect(rm.raycastSurface(2, 2, out)).toBe(false);
    expect(out.ray!.direction.length()).toBeCloseTo(1, 9);
    expect(out.ray!.direction.x).toBeLessThan(0);
  });

  it('a blocker in front of a selectable part is a BLOCKED surface at the blocker distance', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestNavSurf');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);
    const { surface, out, detailed } = await place(root, { survives: (n) => n.name === 'Cover' });

    expect(surface()).toBe(true);
    expect(out.blocked).toBe(true);
    expect(out.path).toBeNull();
    expect(out.distance).toBeCloseTo(9.5, 4); // front face of the cover (z = +0.5)
    expect(out.point.z).toBeCloseTo(0.5, 4);
    // Selection semantics unchanged: blocked selects nothing.
    expect(detailed()).toBeNull();
  });

  it('a transparent chunk passes: the surface is the part behind the glass', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    const glass = uberMesh(uber, 'glass', [0, 0, 0]);
    glass.material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    glass.userData._rvUberBaked = false;
    cover.add(glass);
    const inner = withComponent(group('Inner'), 'TestNavSurf');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);
    const { surface, out, detailed, placed, registry } = await place(root, { survives: (n) => n.name === 'Cover' });

    expect(surface()).toBe(true);
    expect(out.blocked).toBe(false);
    expect(out.path).toBe(pathOf(registry, placed.node('Inner')));
    expect(out.distance).toBeCloseTo(12.5, 4);
    expect(detailed()?.path).toBe(pathOf(registry, placed.node('Inner')));
  });

  it('a hidden node is skipped', async () => {
    const root = group('Asset');
    const cover = withComponent(group('Cover'), 'TestNavSurf');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestNavSurf');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);
    const { surface, out, placed, registry, detailed } = await place(root);

    expect(surface()).toBe(true);
    expect(out.path).toBe(pathOf(registry, placed.node('Cover')));
    placed.node('Cover').visible = false;
    expect(surface()).toBe(true);
    expect(out.path).toBe(pathOf(registry, placed.node('Inner')));
    expect(detailed()?.path).toBe(pathOf(registry, placed.node('Inner')));
  });

  it('a visible part whose type is NOT hover-enabled is still a surface (R2-5)', async () => {
    const root = group('Asset');
    const part = withComponent(group('Part'), 'TestNavNoHover');
    part.add(uberMesh(uber, 'partMesh', [0, 0, 0]));
    root.add(part);
    const { surface, out, detailed, placed, registry } = await place(root);

    expect(detailed(), 'hover-type gate still applies to selection').toBeNull();
    expect(surface()).toBe(true);
    expect(out.blocked).toBe(false);
    expect(out.path).toBe(pathOf(registry, placed.node('Part')));
  });

  it('isolation still gates the surface', async () => {
    const root = group('Asset');
    const part = withComponent(group('Part'), 'TestNavSurf');
    part.add(uberMesh(uber, 'partMesh', [0, 0, 0]));
    root.add(part);
    const { surface, rm, detailed } = await place(root);
    expect(surface()).toBe(true);
    rm.setIsolationGate(() => false);
    expect(surface()).toBe(false);
    expect(detailed()).toBeNull();
  });

  it('background answers false', async () => {
    const root = group('Asset');
    const part = withComponent(group('Part'), 'TestNavSurf');
    part.add(uberMesh(uber, 'partMesh', [0, 0, 0]));
    root.add(part);
    const { surface, detailed } = await place(root);
    expect(surface(2, 2)).toBe(false); // corner of the view: misses the unit box
    expect(detailed(2, 2)).toBeNull();
  });
});

describe('raycastSurface — measurement (R2-7)', () => {
  it('reports per-pick p95 and heap growth on a baked scene of a few thousand triangles', async () => {
    const root = group('Asset');
    let tris = 0;
    // 5 × 5 spheres, half owned, half unowned (blocking) — ~13k triangles.
    for (let i = 0; i < 25; i++) {
      const owned = i % 2 === 0;
      const g = owned ? withComponent(group(`S${i}`), 'TestNavSurf') : group(`S${i}`);
      const geo = uberBakeGeometry(new SphereGeometry(0.4, 24, 12));
      tris += (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
      const m = new Mesh(geo, uber);
      m.userData._rvUberBaked = true;
      m.position.set((i % 5) - 2, Math.floor(i / 5) - 2, 0);
      g.add(m);
      root.add(g);
    }
    const { rm, out } = await place(root, { survives: (n) => /^S\d+$/.test(n.name) });
    const metrics = new PickMetrics();
    rm.setMetrics(metrics);

    // Warm-up.
    for (let i = 0; i < 50; i++) rm.raycastSurface(20 + (i % 160), 20 + ((i * 7) % 160), out);

    const N = 1000;
    const samples = new Float64Array(N);
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const x = 20 + ((i * 37) % 160);
      const y = 20 + ((i * 53) % 160);
      const t0 = performance.now();
      if (rm.raycastSurface(x, y, out)) hits++;
      samples[i] = performance.now() - t0;
    }
    const sorted = Array.from(samples).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(N * 0.95)];
    const p50 = sorted[Math.floor(N * 0.5)];
    // Batched mean (immune to the performance.now() quantisation).
    const tb = performance.now();
    for (let i = 0; i < N; i++) rm.raycastSurface(20 + ((i * 37) % 160), 20 + ((i * 53) % 160), out);
    const meanMs = (performance.now() - tb) / N;

    // Heap growth — Chromium only, coarse unless precise memory info is on.
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    let heapPerPick: number | null = null;
    let probeDelta: number | null = null;
    if (mem) {
      // Sensitivity probe: does usedJSHeapSize see ~10 MB of fresh objects at all?
      const p0 = mem.usedJSHeapSize;
      const keep: Array<{ a: number; b: number }> = [];
      for (let i = 0; i < 250_000; i++) keep.push({ a: i, b: i });
      probeDelta = mem.usedJSHeapSize - p0;
      keep.length = 0;
      const M = 20000;
      const h0 = mem.usedJSHeapSize;
      for (let i = 0; i < M; i++) rm.raycastSurface(20 + ((i * 37) % 160), 20 + ((i * 53) % 160), out);
      const h1 = mem.usedJSHeapSize;
      heapPerPick = (h1 - h0) / M;
    }
    // Allocation per navigation pick via the V8 sampling heap profiler (R2-7).
    const M = 5000;
    rm.setMetrics(null);
    const idle = await sampleAllocations(() => { let acc = 0; for (let i = 0; i < M; i++) acc += i; if (acc < 0) console.log(acc); });
    const alloc = await sampleAllocations(() => {
      for (let i = 0; i < M; i++) rm.raycastSurface(20 + ((i * 37) % 160), 20 + ((i * 53) % 160), out);
    });
    rm.setMetrics(metrics);
    if (alloc) {
      console.log(`[plan-515] raycastSurface allocations: ~${(alloc.totalBytes / M).toFixed(0)} B/pick ` +
        `(idle loop ${idle ? (idle.totalBytes / M).toFixed(1) : 'n/a'} B/iter); top frames per pick: ` +
        alloc.top.map((t) => `${t.frame} ${(t.bytes / M).toFixed(0)}B`).join(' | '));
    } else {
      console.log('[plan-515] CDP heap sampling unavailable');
    }
    const snap = metrics.snapshot();
    console.log(`[plan-515] raycastSurface on ${tris} tris: hits ${hits}/${N}, ` +
      `p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms, batched mean ${meanMs.toFixed(4)} ms, ` +
      `PickMetrics p95 ${snap.raycastP95Ms.toFixed(4)} ms (${snap.raycastP95Samples} samples), ` +
      `heap/pick ${heapPerPick === null ? 'n/a' : heapPerPick.toFixed(1) + ' B'} (probe: 250k objects → +${probeDelta} B)`);
    expect(hits).toBeGreaterThan(N / 4);
    expect(p95).toBeLessThan(1);
    expect(meanMs).toBeLessThan(1);
  });
});
