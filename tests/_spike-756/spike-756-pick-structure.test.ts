// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
// SPIKE plan-756 — throw-away, not product code

import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Triangle, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import {
  buildPickStructure, buildTreeBottomUp, buildTreeMorton, buildTreeSAH, raycastNearest, bruteNearest, rayStats,
  type PickStructure, type PickTree, type SegmentIn,
} from './spike-pick-structure';
import { makeRandom, mergeScene, makeThinSheet, makeFilletPart, type Merged } from './spike-geometry';

const MAUSER_URL = '/private-models/mauser3dhmi/mausercagelinenosource.glb';
const REL_TOL = 1e-4;

function log(row: Record<string, unknown>): void { console.log('SPIKE756 ' + JSON.stringify(row)); }
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r5 = (v: number): number => Math.round(v * 100000) / 100000;

function timerResolutionMs(): number {
  let best = Infinity;
  for (let k = 0; k < 20; k++) {
    const a = performance.now(); let b = a;
    while (b === a) b = performance.now();
    if (b - a < best) best = b - a;
  }
  return best;
}

// ─── rays ────────────────────────────────────────────────────────────────

function randomRays(m: Merged, n: number, seed: number): Float64Array {
  const rnd = makeRandom(seed);
  const { min, max } = m.bounds;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
  const rad = 0.75 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]); // 1.5 × half diagonal
  const out = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z);
    const ox = cx + rad * s * Math.cos(phi), oy = cy + rad * s * Math.sin(phi), oz = cz + rad * z;
    const tx = min[0] + rnd() * (max[0] - min[0]), ty = min[1] + rnd() * (max[1] - min[1]), tz = min[2] + rnd() * (max[2] - min[2]);
    const l = Math.hypot(tx - ox, ty - oy, tz - oz);
    out.set([ox, oy, oz, (tx - ox) / l, (ty - oy) / l, (tz - oz) / l], i * 6);
  }
  return out;
}

/** Exactly axis-parallel rays through an existing vertex: 0·∞ in the slab test + edge/vertex hits. */
function axisRays(m: Merged, n: number, seed: number): Float64Array {
  const rnd = makeRandom(seed);
  const out = new Float64Array(n * 6);
  const nv = m.position.length / 3;
  for (let i = 0; i < n; i++) {
    const v = Math.floor(rnd() * nv) * 3, axis = i % 3, neg = (i & 8) !== 0;
    const o = [m.position[v], m.position[v + 1], m.position[v + 2]], d = [0, 0, 0];
    d[axis] = neg ? -1 : 1;
    o[axis] = neg ? m.bounds.max[axis] + 1 : m.bounds.min[axis] - 1;
    out.set([o[0], o[1], o[2], d[0], d[1], d[2]], i * 6);
  }
  return out;
}

/** Thin-sheet only: chords that run inside / along the 0.5 mm gap between the two skins. */
function grazingRays(n: number, seed: number): Float64Array {
  const rnd = makeRandom(seed);
  const out = new Float64Array(n * 6), r = 1.00025;
  for (let i = 0; i < n; i++) {
    const a1 = rnd() * Math.PI, a2 = Math.min(Math.PI, a1 + 0.02 + rnd() * 0.3);
    const p1 = [r * Math.cos(a1), r * Math.sin(a1), rnd() * 2], p2 = [r * Math.cos(a2), r * Math.sin(a2), rnd() * 2];
    const l = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    const d = [(p2[0] - p1[0]) / l, (p2[1] - p1[1]) / l, (p2[2] - p1[2]) / l];
    out.set([p1[0] - 0.5 * d[0], p1[1] - 0.5 * d[1], p1[2] - 0.5 * d[2], d[0], d[1], d[2]], i * 6);
  }
  return out;
}

// ─── timing ──────────────────────────────────────────────────────────────

interface RayTiming { rays: number; meanMs: number; K: number; p50: number; p95: number; p99: number; maxMs: number }

function timeRays(n: number, fn: (i: number) => void): RayTiming {
  for (let i = 0; i < Math.min(n, 500); i++) fn(i);                 // warm-up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  const meanMs = (performance.now() - t0) / n;
  // performance.now() is coarse in a non-isolated page → time K repetitions of the SAME ray
  const K = meanMs < 0.25 ? 16 : 1;
  const m = meanMs > 2 ? Math.min(n, 2000) : n;
  const samples = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const t = performance.now();
    for (let k = 0; k < K; k++) fn(i);
    samples[i] = (performance.now() - t) / K;
  }
  samples.sort();
  const q = (p: number): number => samples[Math.min(m - 1, Math.floor(p * m))];
  return { rays: m, meanMs: r5(meanMs), K, p50: r5(q(0.5)), p95: r5(q(0.95)), p99: r5(q(0.99)), maxMs: r5(samples[m - 1]) };
}

const same = (a: number, b: number): boolean =>
  (a === Infinity && b === Infinity) || (a !== Infinity && b !== Infinity && Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b)));

// ─── oracle ──────────────────────────────────────────────────────────────

function makeOracleGeometry(m: Merged): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.position, 3));   // positions are never modified by MeshBVH
  g.setIndex(new BufferAttribute(m.index.slice(), 1));              // own index copy (non-indirect build reorders it)
  return g;
}
function bvhBytes(bvh: MeshBVH): number {
  const any = bvh as unknown as { _roots: ArrayBuffer[]; _indirectBuffer?: { byteLength: number } | null };
  return any._roots.reduce((s, r) => s + r.byteLength, 0) + (any._indirectBuffer ? any._indirectBuffer.byteLength : 0);
}

const _ray = new Ray();
function oracleDistance(bvh: MeshBVH, rays: Float64Array, i: number): number {
  const o = i * 6;
  _ray.origin.set(rays[o], rays[o + 1], rays[o + 2]); _ray.direction.set(rays[o + 3], rays[o + 4], rays[o + 5]);
  const h = bvh.raycastFirst(_ray, DoubleSide);
  return h ? h.distance : Infinity;
}

/** Brute force with three's own Ray.intersectTriangle (what three-mesh-bvh uses per triangle). */
function bruteThree(m: Merged, rays: Float64Array, i: number): { distance: number; triangle: number } {
  const o = i * 6;
  _ray.origin.set(rays[o], rays[o + 1], rays[o + 2]); _ray.direction.set(rays[o + 3], rays[o + 4], rays[o + 5]);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), p = new Vector3();
  let best = Infinity, tri = -1;
  const pos = m.position, idx = m.index;
  for (let t = 0; t < idx.length; t += 3) {
    a.fromArray(pos, idx[t] * 3); b.fromArray(pos, idx[t + 1] * 3); c.fromArray(pos, idx[t + 2] * 3);
    if (_ray.intersectTriangle(a, b, c, false, p)) {
      const d = p.distanceTo(_ray.origin);
      if (d < best) { best = d; tri = t / 3; }
    }
  }
  return { distance: best, triangle: tri };
}

function classify(m: Merged, rays: Float64Array, i: number, mine: number, orc: number): string {
  const o = i * 6;
  const wt = bruteNearest(m.position, m.index, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5]);
  if (!same(wt.distance, mine)) return 'REAL BUG: structure != brute-force (same watertight test)';
  const mt = bruteThree(m, rays, i);
  const prefix = same(mt.distance, orc) ? '' : '[oracle BVH != brute-force three.intersectTriangle] ';
  const tri = wt.distance <= mt.distance ? wt.triangle : mt.triangle;
  if (tri < 0) return prefix + 'unexplained';
  const A = new Vector3().fromArray(m.position, m.index[3 * tri] * 3), B = new Vector3().fromArray(m.position, m.index[3 * tri + 1] * 3),
    C = new Vector3().fromArray(m.position, m.index[3 * tri + 2] * 3);
  const T = new Triangle(A, B, C);
  const d = Math.min(wt.distance, mt.distance);
  const P = new Vector3(rays[o] + d * rays[o + 3], rays[o + 1] + d * rays[o + 4], rays[o + 2] + d * rays[o + 5]);
  const bc = new Vector3();
  const ok = T.getBarycoord(P, bc);
  const who = wt.distance < mt.distance ? 'watertight hits, three misses/farther' : 'three hits, watertight misses/farther';
  const longest = Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A));
  if (!ok || T.getArea() < 1e-9 * longest * longest + 1e-18) return `${prefix}degenerate/needle triangle (${who})`;
  if (Math.min(bc.x, bc.y, bc.z) < 1e-4) return `${prefix}edge/vertex hit (${who})`;
  const nrm = new Vector3(); T.getNormal(nrm);
  const cos = Math.abs(nrm.x * rays[o + 3] + nrm.y * rays[o + 4] + nrm.z * rays[o + 5]);
  if (cos < 1e-4) return `${prefix}grazing/coplanar triangle (${who})`;
  return `${prefix}other triangle-test difference (${who}, minBary=${Math.min(bc.x, bc.y, bc.z).toExponential(2)}, cos=${cos.toExponential(2)})`;
}

// ─── the run ─────────────────────────────────────────────────────────────

interface RunCfg {
  clusterSizes: number[];
  nRays: number;
  extraRaySets?: { name: string; rays: Float64Array }[];
  bruteCheck: number;
}

async function run(m: Merged, cfg: RunCfg): Promise<number> {
  const geo = m.label;
  const geomBytes = m.position.byteLength + m.index.byteLength;
  const triCount = m.index.length / 3;
  const segSizes = m.perMesh.map((s) => s.indexCount / 3).sort((a, b) => a - b);
  log({
    row: 'geometry', geo, triangles: triCount, vertices: m.position.length / 3, sourceMeshes: m.meshes,
    skippedTransparentMeshes: m.skippedTransparent, positionBytes: m.position.byteLength, indexBytes: m.index.byteLength,
    geometryBytes: geomBytes, bounds: m.bounds,
    trisPerMesh: { p50: segSizes[segSizes.length >> 1], p90: segSizes[Math.floor(segSizes.length * 0.9)], max: segSizes[segSizes.length - 1],
      meshesLE128: segSizes.filter((x) => x <= 128).length },
  });
  let realBugs = 0;

  const raySets = [{ name: 'random-through-bounds', rays: randomRays(m, cfg.nRays, 756) },
    { name: 'axis-parallel-through-vertex', rays: axisRays(m, 1000, 757) }, ...(cfg.extraRaySets ?? [])];

  // oracle
  const og = makeOracleGeometry(m);
  let t = performance.now();
  const bvh = new MeshBVH(og);
  log({ row: 'oracle-build', geo, options: 'default (CENTER, maxLeafTris 10)', ms: r3(performance.now() - t), bvhBytes: bvhBytes(bvh), pctOfGeometry: r3((100 * bvhBytes(bvh)) / geomBytes) });
  await tick();
  {
    const og2 = makeOracleGeometry(m);
    t = performance.now();
    const b2 = new MeshBVH(og2, { indirect: true });
    log({ row: 'oracle-build', geo, options: '{indirect:true}', ms: r3(performance.now() - t), bvhBytes: bvhBytes(b2), pctOfGeometry: r3((100 * bvhBytes(b2)) / geomBytes) });
    og2.dispose();
  }
  await tick();
  const oracleD = raySets.map((rs) => {
    const n = rs.rays.length / 6, d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = oracleDistance(bvh, rs.rays, i);
    return d;
  });
  for (let k = 0; k < raySets.length; k++) {
    const n = raySets[k].rays.length / 6;
    const tm = timeRays(n, (i) => { oracleDistance(bvh, raySets[k].rays, i); });
    let hits = 0; for (let i = 0; i < n; i++) if (oracleD[k][i] !== Infinity) hits++;
    log({ row: 'oracle-rays', geo, raySet: raySets[k].name, hitRate: r3(hits / n), ...tm });
    await tick();
  }

  let reference: Float64Array[] | null = null;
  let classified = false;
  const segModes: { name: string; segs: SegmentIn[] }[] = [
    { name: 'per-source-mesh', segs: m.perMesh }, { name: 'one-segment', segs: [{ indexStart: 0, indexCount: m.index.length }] }];

  for (const sm of segModes) for (const C of cfg.clusterSizes) {
    let ps!: PickStructure;
    for (let rep = 0; rep < 2; rep++) {
      ps = buildPickStructure(m.position, m.index.slice(), sm.segs, { clusterTris: C });
      log({ row: 'build', geo, segmentation: sm.name, segments: sm.segs.length, clusterTris: C, rep, clusterCount: ps.clusterCount,
        meanTrisPerCluster: r3(triCount / ps.clusterCount), ...Object.fromEntries(Object.entries(ps.timings).map(([k, v]) => [k, r3(v as number)])) });
      await tick();
    }
    if (C === 128) {
      const p2 = buildPickStructure(m.position, m.index.slice(), sm.segs, { clusterTris: C, order: 'segments' });
      log({ row: 'build-per-segment-order', geo, segmentation: sm.name, clusterTris: C, totalMs: r3(p2.timings.total),
        largestSingleSegmentBlockMs: r3(p2.timings.maxSegmentMs), largestSegmentTris: p2.timings.maxSegmentTris, transientBytes: p2.timings.transientBytes });
      if (sm.name === 'per-source-mesh') {
        const p3 = buildPickStructure(m.position, m.index.slice(), sm.segs, { clusterTris: C, skipSortSmall: false });
        log({ row: 'build-no-skip-small', geo, segmentation: sm.name, clusterTris: C, ...Object.fromEntries(Object.entries(p3.timings).map(([k, v]) => [k, r3(v as number)])) });
      }
      await tick();
    }

    const trees: PickTree[] = [buildTreeBottomUp(ps, 1), buildTreeMorton(ps, 1), buildTreeSAH(ps, 1)];
    if (C === 128) trees.push(buildTreeBottomUp(ps, 4), buildTreeSAH(ps, 4));
    for (const tree of trees) {
      const planSegExtra = ps.segCount * 8; // segNode + segOwner of §2.3, not allocated by the spike
      const total = ps.bytes + tree.bytes;
      const base = { geo, segmentation: sm.name, clusterTris: C, tree: tree.kind, leafClusters: tree.leafClusters };
      log({ row: 'bytes', ...base, treeNodes: tree.nodeCount, treeDepth: tree.maxDepth, treeBuildMs: r3(tree.buildMs),
        segAndClusterBytes: ps.bytes, treeBytes: tree.bytes, structureBytes: total, pctOfGeometry: r3((100 * total) / geomBytes),
        pctInclPlanSegNodeOwner: r3((100 * (total + planSegExtra)) / geomBytes) });

      for (let k = 0; k < raySets.length; k++) {
        const rays = raySets[k].rays, n = rays.length / 6;
        const mine = new Float64Array(n);
        rayStats.tris = 0; rayStats.boxes = 0; rayStats.maxStack = 0;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const o = i * 6;
          const h = raycastNearest(ps, tree, m.position, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5], true);
          mine[i] = h ? h.distance : Infinity;
        }
        const countedMs = (performance.now() - t0) / n;
        let hits = 0, hitMiss = 0, distDiff = 0, maxDiff = 0, maxRel = 0, vsRef = 0;
        const bad: number[] = [];
        for (let i = 0; i < n; i++) {
          const a = mine[i], b = oracleD[k][i];
          if (a !== Infinity) hits++;
          if ((a === Infinity) !== (b === Infinity)) { hitMiss++; bad.push(i); continue; }
          if (a === Infinity) continue;
          const d = Math.abs(a - b), rel = d / Math.max(a, b);
          if (d > maxDiff) maxDiff = d; if (rel > maxRel) maxRel = rel;
          if (rel > REL_TOL) { distDiff++; bad.push(i); }
        }
        let vsRefBeyondTies = 0, vsRefMaxRel = 0;
        if (reference && reference[k]) for (let i = 0; i < n; i++) if (mine[i] !== reference[k][i]) {
          vsRef++;
          const rel = Math.abs(mine[i] - reference[k][i]) / Math.max(mine[i], reference[k][i]);
          if (!(rel <= 1e-9)) vsRefBeyondTies++; else if (rel > vsRefMaxRel) vsRefMaxRel = rel;
        }
        log({ row: 'parity', ...base, raySet: raySets[k].name, rays: n, hitRate: r3(hits / n), hitMissDiffers: hitMiss,
          distanceDiffersRel1e4: distDiff, maxAbsDistanceDiff: maxDiff, maxRelDistanceDiff: maxRel,
          notBitIdenticalToFirstConfig: reference ? vsRef : 'n/a (this is the first config)', vsFirstConfigBeyond1e9: vsRefBeyondTies, vsFirstConfigMaxRelTie: vsRefMaxRel,
          meanTrisTested: r3(rayStats.tris / n), meanBoxesTested: r3(rayStats.boxes / n), maxStack: rayStats.maxStack, msPerRayWithCounters: r5(countedMs) });

        if (!classified) {
          const classes: Record<string, number> = {};
          for (const i of bad.slice(0, 40)) {
            const c = classify(m, rays, i, mine[i], oracleD[k][i]);
            classes[c] = (classes[c] ?? 0) + 1; if (c.startsWith('REAL BUG')) realBugs++;
          }
          log({ row: 'mismatch-classes', ...base, raySet: raySets[k].name, mismatches: bad.length, classified: Math.min(40, bad.length), classes });
          // independent traversal check against brute force with the same triangle test
          let bruteBad = 0, bruteBitDiff = 0;
          for (let i = 0; i < Math.min(cfg.bruteCheck, n); i++) {
            const o = i * 6;
            const bf = bruteNearest(m.position, m.index, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5]);
            if (bf.distance !== mine[i]) { bruteBitDiff++; if (!(Math.abs(bf.distance - mine[i]) / Math.max(bf.distance, mine[i]) <= 1e-9)) bruteBad++; }
          }
          realBugs += bruteBad;
          log({ row: 'brute-check', ...base, raySet: raySets[k].name, raysChecked: Math.min(cfg.bruteCheck, n), notBitIdenticalToBruteForce: bruteBitDiff, differsBeyond1e9: bruteBad });
          await tick();
        } else if (vsRefBeyondTies > 0) realBugs += vsRefBeyondTies;

        if (k === 0 || tree.kind.startsWith('C')) {
          const tm = timeRays(n, (i) => {
            const o = i * 6;
            raycastNearest(ps, tree, m.position, rays[o], rays[o + 1], rays[o + 2], rays[o + 3], rays[o + 4], rays[o + 5], false);
          });
          log({ row: 'ray-time', ...base, raySet: raySets[k].name, ...tm });
        }
        if (!reference) reference = [];
        if (!reference[k]) reference[k] = mine;
        await tick();
      }
      classified = true;
    }
  }
  og.dispose();
  return realBugs;
}

describe('SPIKE plan-756 — flat-cluster pick structure', () => {
  it('environment', () => {
    log({ row: 'env', hardwareConcurrency: navigator.hardwareConcurrency, userAgent: navigator.userAgent,
      crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null,
      timerResolutionMs: timerResolutionMs(), deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null });
  });

  it('synthetic worst cases', async () => {
    const sheet = makeThinSheet();
    expect(await run(sheet, { clusterSizes: [128], nRays: 10000, bruteCheck: 300, extraRaySets: [{ name: 'grazing-in-gap', rays: grazingRays(2000, 758) }] })).toBe(0);
    const fillet = makeFilletPart();
    expect(await run(fillet, { clusterSizes: [128], nRays: 10000, bruteCheck: 300 })).toBe(0);
  }, 1_800_000);

  it('Mauser cage line (real GLB)', async () => {
    let t = performance.now();
    const res = await fetch(MAUSER_URL);
    expect(res.ok).toBe(true);
    let buf: ArrayBuffer | null = await res.arrayBuffer();
    log({ row: 'load', step: 'fetch', ms: r3(performance.now() - t), bytes: buf.byteLength });
    t = performance.now();
    let gltf: { scene: import('three').Object3D } | null = await new GLTFLoader().parseAsync(buf, '/private-models/mauser3dhmi/');
    buf = null;
    log({ row: 'load', step: 'GLTFLoader.parseAsync', ms: r3(performance.now() - t) });
    t = performance.now();
    const merged = mergeScene('Mauser mausercagelinenosource.glb (all opaque meshes, world space)', gltf.scene);
    log({ row: 'load', step: 'merge', ms: r3(performance.now() - t) });
    gltf.scene.traverse((o) => { const g = (o as import('three').Mesh).geometry; if (g) g.dispose(); });
    gltf = null;
    await tick();
    expect(await run(merged, { clusterSizes: [64, 128, 256], nRays: 10000, bruteCheck: 100 })).toBe(0);
  }, 7_200_000);
});
