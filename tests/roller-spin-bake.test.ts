// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.6 + the spike-S1 / SOL-R2 follow-up tests — the animated roller
 * mantle through the real recipe: `ModelCache.getOrLoadBaked` → prepareAndBake
 * (TransportSurface pre-bake hook → dedup → uber → bake) → `BakeRegistry.instantiate`
 * ×4, then `bindRollerSpin` per instance.
 *
 *  - groups / figures on the surface node, U canonicalisation (flipped rollers = one group)
 *  - isolation per placement after the bake, template untouched, one image (M2/M3)
 *  - draw calls animated == static (M4)
 *  - dedup: an unmarked twin is not folded into the marked material (M5, `roller-spin-dedup-marker`)
 *  - two ratios → two groups → two chunks, separate offsets (R2-1, `roller-spin-groups`)
 *  - same image + marker, different tiling → kept apart (R2-2)
 *  - offset = frac(−φ·repeatU) with repeatU = 4 (R2-4)
 *  - release → clones disposed, template intact, the rest keeps running (M6, `roller-spin-dispose`)
 *  - toon stand-in on a chunk mesh is handed back and re-applied (`roller-spin-render-mode`)
 *  - Problems: unbound (0 / 2 surfaces), under-surface, mixed
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BufferGeometry, Group, Mesh, MeshStandardMaterial, MeshToonMaterial, PerspectiveCamera, Scene,
  UnsignedByteType, Vector3, WebGLRenderer, WebGLRenderTarget, type Material, type Object3D,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeRegistry, type PlacementInstance } from '../src/core/engine/rv-bake-registry';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import {
  bindRollerSpin, installRollerSpin, prepareRollerSpin, isSpinMaterial, RV_ROLLER_SPIN_KEY, RV_SPIN_GROUP_KEY,
  type RollerSpinBinding, type RollerSpinData, type RollerSpinHost, type SpinSurface,
} from '../src/core/engine/rv-roller-spin';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { makeCurve, R_MID, spinMaterial, type CurveOpts } from './helpers/roller-spin-fixture';

function fakeLoader(make: () => Group): GLTFLoader {
  return { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: make() }) } as unknown as GLTFLoader;
}

interface Built { registry: BakeRegistry; scene: Scene; roots: Group[]; instances: PlacementInstance[] }

let seq = 0;
async function build(o: CurveOpts, n = 4): Promise<Built> {
  const uber = new RVUberMaterial(false);
  const cache = new ModelCache(fakeLoader(makeCurve(o)), {
    uber: () => uber,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  });
  const baked = await cache.getOrLoadBaked(`blob:rv-675/curve-${++seq}.glb`);
  const registry = new BakeRegistry();
  const scene = new Scene();
  const roots: Group[] = [];
  const instances: PlacementInstance[] = [];
  for (let i = 0; i < n; i++) {
    const root = new Group(); root.name = `Curve_${i}`; root.position.x = i * 1.5;
    scene.add(root);
    instances.push(registry.instantiate(baked, root));
    roots.push(root);
  }
  scene.updateMatrixWorld(true);
  return { registry, scene, roots, instances };
}

const surfaceNodeOf = (root: Object3D): Object3D | null => {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.userData?.[RV_ROLLER_SPIN_KEY]) hit = n; });
  return hit;
};
const meshesOf = (inst: PlacementInstance): Mesh[] => [...inst.chunks, ...inst.keep];
const stub = (speed: number, Radial = true): SpinSurface => ({ speed, Radial, rollerSpin: null });

function bind(inst: PlacementInstance, surface: SpinSurface, extra?: Partial<Parameters<typeof bindRollerSpin>[2]>): RollerSpinBinding | null {
  return bindRollerSpin(inst.root, meshesOf(inst), { surfaceOf: () => surface, ...extra });
}

let sharedRenderer: WebGLRenderer | null = null;
function drawCalls(scene: Scene): number {
  if (!sharedRenderer) {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    sharedRenderer = new WebGLRenderer({ canvas });
    sharedRenderer.info.autoReset = false;
  }
  const r = sharedRenderer;
  const cam = new PerspectiveCamera(60, 1, 0.01, 100);
  cam.position.set(2.25, 3, 4); cam.lookAt(2.25, 0, 0); cam.updateMatrixWorld();
  const target = new WebGLRenderTarget(64, 64, { type: UnsignedByteType });
  r.setRenderTarget(target);
  r.info.reset();
  r.render(scene, cam);
  const calls = r.info.render.calls;
  r.setRenderTarget(null); target.dispose();
  return calls;
}

/** Expected offset after `t` s at `speedDeg` °/s: frac(−φ·repeatU), φ = ω·r/ρ·t/2π. */
function expectedOffset(speedDeg: number, rMidMm: number, rhoMm: number, t: number, repeatU = 1): number {
  const phi = (speedDeg * Math.PI / 180) * (rMidMm / rhoMm) * t / (2 * Math.PI);
  const x = -phi * repeatU;
  return x - Math.floor(x);
}
const near = (a: number, b: number, eps = 1e-6): boolean => Math.min(Math.abs(a - b), 1 - Math.abs(a - b)) < eps;

beforeEach(() => resetProblemsForTests());

describe('plan-675 Phase 3 — roller spin through the bake', () => {
  it('pre-bake: one speed group with the roller figures on the surface node of EVERY instance; flipped rollers stay one group', async () => {
    for (const flipHalf of [false, true]) {
      const b = await build({ flipHalf }, 2);
      for (const inst of b.instances) {
        const node = surfaceNodeOf(inst.root);
        expect(node, 'the surface node carries the figures').not.toBeNull();
        const data = node!.userData[RV_ROLLER_SPIN_KEY] as RollerSpinData;
        expect(data.radial).toBe(true);
        expect(data.mixed).toBe(false);
        expect(data.groups).toHaveLength(1);
        expect(data.groups[0].count).toBe(4);
        expect(data.groups[0].rhoMm).toBeCloseTo(25, 0);
        expect(data.groups[0].rMidMm).toBeCloseTo(R_MID * 1000, -1);
      }
      // One textured spin chunk in the template.
      const spinChunks = b.instances[0].baked.chunks.filter((c) => isSpinMaterial(c.material));
      expect(spinChunks, `flipHalf=${flipHalf}`).toHaveLength(1);
    }
  });

  it('U canonicalisation: after the pre-bake every roller U grows right-handed about its PHYSICAL turning axis (flipped ones negated)', () => {
    const root = makeCurve({ flipHalf: true, rollers: 6 })();
    root.updateMatrixWorld(true);
    const transport = root.getObjectByName('Transport')!;
    prepareRollerSpin(root, transport, (transport.userData.realvirtual as Record<string, Record<string, unknown>>).TransportSurface);
    root.updateMatrixWorld(true);
    const rollers = root.getObjectByName('Rollers')!.children as Mesh[];
    for (const r of rollers) {
      const g = r.geometry as BufferGeometry;
      const pos = g.getAttribute('position'); const uv = g.getAttribute('uv'); const idx = g.getIndex()!;
      const centre = new Vector3().setFromMatrixPosition(r.matrixWorld);
      const rv = centre.clone().setY(0).normalize();
      // radial, A = +Y: d = A × r, a_phys = up × d = −r̂
      const aPhys = rv.clone().negate();
      let vote = 0;
      for (let t = 0; t < idx.count / 3; t += 3) {
        const [i0, i1, i2] = [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)];
        const du1 = uv.getX(i1) - uv.getX(i0), du2 = uv.getX(i2) - uv.getX(i0);
        const dv1 = uv.getY(i1) - uv.getY(i0), dv2 = uv.getY(i2) - uv.getY(i0);
        if (Math.abs(du1) > 0.5 || Math.abs(du2) > 0.5) continue;
        const det = du1 * dv2 - du2 * dv1; if (Math.abs(det) < 1e-12) continue;
        const p0 = new Vector3().fromBufferAttribute(pos, i0).applyMatrix4(r.matrixWorld);
        const p1 = new Vector3().fromBufferAttribute(pos, i1).applyMatrix4(r.matrixWorld);
        const p2 = new Vector3().fromBufferAttribute(pos, i2).applyMatrix4(r.matrixWorld);
        const e1 = p1.clone().sub(p0), e2 = p2.clone().sub(p0);
        const tt = e1.multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(1 / det);
        const rr = p0.add(p1).add(p2).multiplyScalar(1 / 3).sub(centre);
        rr.addScaledVector(aPhys, -rr.dot(aPhys));
        vote += Math.sign(aPhys.dot(rr.cross(tt)));
      }
      expect(vote, r.name).toBeGreaterThan(0);
    }
  });

  it('M2/M3/R2-4: 4 placements isolate after the bake — offsets per speed (one stands), template untouched, image shared; repeatU = 4', async () => {
    for (const repeatU of [1, 4]) {
      const b = await build({ repeatU });
      const templChunk = b.instances[0].baked.chunks.find((c) => isSpinMaterial(c.material))!;
      const templMat = templChunk.material as MeshStandardMaterial;
      const templMap = templMat.map!;
      const data = surfaceNodeOf(b.instances[0].root)!.userData[RV_ROLLER_SPIN_KEY] as RollerSpinData;
      const g = data.groups[0];
      const speeds = [0, 7, 13, -5];
      const handles = b.instances.map((inst, i) => bind(inst, stub(speeds[i]))!);
      const N = 120; const dt = 1 / 60;
      for (let t = 0; t < N; t++) for (const h of handles) h.tick(dt);
      handles.forEach((h, i) => {
        expect(h.maps.length, 'map + ORM-less material: one map').toBeGreaterThanOrEqual(1);
        for (const m of h.maps) expect(near(m.offset.x, expectedOffset(speeds[i], g.rMidMm, g.rhoMm, N * dt, repeatU), 1e-6)).toBe(true);
        expect(h.maps[0].source).toBe(templMap.source);
      });
      expect(handles[0].maps[0].offset.x).toBe(0);
      expect(new Set(handles.flatMap((h) => h.materials)).size).toBe(4);
      expect(templChunk.material).toBe(templMat);
      expect(templMat.map).toBe(templMap);
      expect(templMap.offset.x).toBe(0);
      for (const h of handles) h.dispose();
    }
  });

  it('stop keeps the offset, reset rewinds it', async () => {
    const b = await build({}, 1);
    const s = stub(20);
    const h = bind(b.instances[0], s)!;
    for (let i = 0; i < 30; i++) h.tick(1 / 60);
    const x = h.maps[0].offset.x;
    expect(x).not.toBe(0);
    (s as { speed: number }).speed = 0;
    for (let i = 0; i < 30; i++) h.tick(1 / 60);
    expect(h.maps[0].offset.x).toBe(x);
    h.reset();
    expect(h.maps[0].offset.x).toBe(0);
    expect(h.phase).toBe(0);
    h.dispose();
  });

  it('M4: draw calls with the animated mantle equal those with the static textured mantle', async () => {
    const stat = await build({ marker: false });
    const statCalls = drawCalls(stat.scene);
    const anim = await build({ marker: true });
    const handles = anim.instances.map((inst, i) => bind(inst, stub(10 * i))!);
    for (const h of handles) h.tick(0.5);
    const animCalls = drawCalls(anim.scene);
    console.log(`[plan-675 M4] draw calls static ${statCalls}, animated ${animCalls}`);
    expect(animCalls).toBe(statCalls);
    for (const h of handles) h.dispose();
  });

  it('M5 (roller-spin-dedup-marker): an unmarked twin on the same map keeps its own material and does not spin', async () => {
    const b = await build({ unmarkedTwin: true }, 1);
    const tex = b.instances[0].baked.chunks.filter((c) => !!(c.material as MeshStandardMaterial).map);
    expect(tex.length).toBe(2);
    expect(tex.filter((c) => isSpinMaterial(c.material))).toHaveLength(1);
    const h = bind(b.instances[0], stub(20))!;
    h.tick(1);
    const twinChunk = b.instances[0].chunks.find((m) => !isSpinMaterial(m.material as Material) && !!(m.material as MeshStandardMaterial).map)!;
    expect((twinChunk.material as MeshStandardMaterial).map!.offset.x).toBe(0);
    h.dispose();
  });

  it('R2-1 (roller-spin-groups): two ratios from one material → two groups, two chunks, separate offsets, roller-spin-mixed', async () => {
    const b = await build({ otherRadius: 0.035, rollers: 4 }, 1);
    const data = surfaceNodeOf(b.instances[0].root)!.userData[RV_ROLLER_SPIN_KEY] as RollerSpinData;
    expect(data.groups).toHaveLength(2);
    expect(data.mixed).toBe(true);
    const spinChunks = b.instances[0].baked.chunks.filter((c) => isSpinMaterial(c.material));
    expect(spinChunks).toHaveLength(2);
    expect(new Set(spinChunks.map((c) => c.material.userData[RV_SPIN_GROUP_KEY]))).toEqual(new Set([0, 1]));
    const h = bind(b.instances[0], stub(30))!;
    h.tick(1);
    expect(h.materials).toHaveLength(2);
    const offs = h.materials.map((m) => (m as MeshStandardMaterial).map!.offset.x);
    expect(offs[0]).not.toBeCloseTo(offs[1], 4);
    expect(getProblems().some((p) => p.code === 'roller-spin-mixed')).toBe(true);
    h.dispose();
  });

  it('R2-2: same image + same marker but different tiling stay two materials through the dedup', () => {
    const root = new Group();
    const a = spinMaterial(true, 1);
    const c = a.clone(); c.map = a.map!.clone(); c.map.repeat.set(2, 4); // same image, other tiling
    const g = new BufferGeometry();
    root.add(new Mesh(g, a), new Mesh(g, c));
    const r = deduplicateMaterials(root);
    expect(r.uniqueCount).toBe(2);
  });

  it('Problems: no surface / two surfaces → roller-spin-unbound; rollers under the surface → roller-spin-under-surface', async () => {
    for (const surfaces of [0, 2] as const) {
      resetProblemsForTests();
      const b = await build({ surfaces }, 1);
      expect(surfaceNodeOf(b.instances[0].root)).toBeNull();
      expect(bind(b.instances[0], stub(10))).toBeNull();
      expect(getProblems().some((p) => p.code === 'roller-spin-unbound'), `surfaces=${surfaces}`).toBe(true);
    }
    resetProblemsForTests();
    const u = await build({ rollersUnderSurface: true }, 1);
    const data = surfaceNodeOf(u.instances[0].root)?.userData[RV_ROLLER_SPIN_KEY] as RollerSpinData | undefined;
    expect(data?.underSurface).toBe(4);
    bind(u.instances[0], stub(10));
    expect(getProblems().some((p) => p.code === 'roller-spin-under-surface' || p.code === 'roller-spin-unbound')).toBe(true);
  });

  it('linear surface: ratio 1/ρ, offset follows v / (2πρ)', async () => {
    const b = await build({ linear: true }, 1);
    const data = surfaceNodeOf(b.instances[0].root)!.userData[RV_ROLLER_SPIN_KEY] as RollerSpinData;
    expect(data.radial).toBe(false);
    expect(data.groups[0].k).toBeCloseTo(1 / data.groups[0].rhoMm, 6);
    const h = bind(b.instances[0], stub(500, false))!;
    h.tick(0.1);
    const phi = 500 * 0.1 / (2 * Math.PI * data.groups[0].rhoMm);
    expect(near(h.maps[0].offset.x, (-phi) - Math.floor(-phi))).toBe(true);
    h.dispose();
  });

  it('M6 (roller-spin-dispose): releasing one placement disposes its clones, the template survives, the others keep running', async () => {
    const b = await build({});
    const listeners: Record<string, Array<(e?: unknown) => void>> = {};
    const surfaces = b.instances.map((inst, i) => ({ ...stub(10 * (i + 1)), node: surfaceNodeOf(inst.root)! }));
    const host: RollerSpinHost = {
      on: ((evt: string, cb: (e?: unknown) => void) => { (listeners[evt] ??= []).push(cb); return () => {}; }) as RollerSpinHost['on'],
      bakeRegistry: b.registry as unknown as RollerSpinHost['bakeRegistry'],
      transportManager: { surfaces },
    };
    const off = installRollerSpin(host);
    for (const root of b.roots) for (const cb of listeners['layout-content-added'] ?? []) cb({ root });
    const bindings = surfaces.map((s) => s.rollerSpin!);
    expect(bindings.every(Boolean)).toBe(true);
    const templChunk = b.instances[0].baked.chunks.find((c) => isSpinMaterial(c.material))!;
    const templMat = templChunk.material as MeshStandardMaterial;
    let templDisposed = false; templMat.addEventListener('dispose', () => { templDisposed = true; });
    const victim = bindings[1];
    const disposed: string[] = [];
    for (const m of victim.materials) m.addEventListener('dispose', () => disposed.push(m.uuid));
    for (const t of victim.maps) t.addEventListener('dispose', () => disposed.push(t.uuid));
    b.registry.release(b.instances[1]);
    expect(disposed.length).toBe(victim.materials.length + victim.maps.length);
    expect(surfaces[1].rollerSpin).toBeNull();
    expect(templDisposed).toBe(false);
    expect(templChunk.material).toBe(templMat);
    bindings[2].tick(1);
    expect(bindings[2].maps[0].offset.x).not.toBe(0);
    off();
  });

  it('render mode (roller-spin-render-mode): a toon stand-in is handed back, the clone swapped in, the render mode re-applied; a later toon shares the clone maps', async () => {
    const b = await build({}, 1);
    const inst = b.instances[0];
    const chunk = inst.chunks.find((m) => isSpinMaterial(m.material as Material))!;
    const original = chunk.material as MeshStandardMaterial;
    const toon = new MeshToonMaterial({ map: original.map });
    chunk.userData._rvToonOriginal = original;
    chunk.material = toon;
    let reapplied = 0;
    const h = bind(inst, stub(10), { reapplyRenderMode: () => { reapplied++; } })!;
    expect(reapplied).toBe(1);
    expect(chunk.userData._rvToonOriginal).toBeUndefined();
    expect(h.materials).toContain(chunk.material);
    // What the toon manager does on (re)conversion: the toon material takes the map BY REFERENCE.
    const clone = chunk.material as MeshStandardMaterial;
    const toon2 = new MeshToonMaterial({ map: clone.map });
    h.tick(1);
    expect(toon2.map!.offset.x).toBe(clone.map!.offset.x);
    expect(toon2.map!.offset.x).not.toBe(0);
    h.dispose();
    expect(chunk.material).toBe(original);
  });
});
