// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-672 Phase 0, half 2 — THE SEGMENT DRAW.
 *
 * The plan's §2.4 answers "how does a per-node ID get into the shader" with:
 * NOT per triangle (WebGL2 / GLSL ES 3.00 has no `gl_PrimitiveID`), but ONE FLAT
 * DRAW PER (chunk, ID) through a **flat geometry view** — a separate
 * `BufferGeometry` carrying the SAME attribute buffers and the SAME index as the
 * chunk, with `groups` of its own built from the CSR intervals of the node
 * table.
 *
 * That idea rests on three claims this file settles, because NFR4 makes breaking
 * any of them very expensive:
 *
 *  **C1 — it draws.** A geometry view over a chunk's buffers renders, and two
 *  groups built from two different owners' segment intervals produce two
 *  different IDs in the right places, in EXACT bytes (not the perceptual
 *  palette). If this fails, the segmentation half of the plan collapses onto
 *  Alternative 2 (one ray per pixel).
 *
 *  **C2 — the chunk is untouched.** `contract-bake-picking.md` §1.5: the index order
 *  of a chunk is DATA after the bake (nr. 3), no second acceleration tree on a
 *  chunk geometry (§2.3 nr. 1), no `dispose()` outside `BakedAsset.dispose()`
 *  (nr. 1), no re-parenting (nr. 4), hiding only via `.visible` (nr. 5). A
 *  geometry view SHARES buffers, so "did we touch it" is not self-evident: the
 *  index bytes, `drawRange`, `groups`, the attribute object identities, the
 *  attribute `version`s and the absence of a `boundsTree` are snapshotted before
 *  the pass and compared after it.
 *
 *  **C3 — the draw count is survivable.** R3: "the draw count of the ID pass
 *  explodes on large models", cap 4 096. The number is not a guess — it is Σ over
 *  chunks of the maximal runs of equal `segOwner`, and it is countable straight
 *  from the bake. Counted for Station and, when the private sibling is there, for
 *  a Mauser-class model.
 *
 * And the cost: a full ID pass (render + readback) at 320×240 and 640×480 against
 * the plan's ≤ 6 ms budget, inside `renderAuxiliaryPass`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Box3,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  type BufferAttribute,
  type InterleavedBufferAttribute,
  type Material,
  type WebGLRenderer,
} from 'three';
import { readRenderTargetPixelsFlipped } from '../../src/core/engine/rv-offscreen-capture';
import { segmentRange } from '../../src/core/engine/rv-pick-structure';
import type { BakedAsset, BakedChunk } from '../../src/core/engine/rv-bake-chunk';
import { createTestViewer, type TestViewerHandle } from '../../tests/helpers/create-test-viewer';
import { loadBakedGLB } from '../../tests/helpers/load-baked-glb';
import { devAssetAvailable } from '../../tests/fixtures/dev-asset-available';
import { createDepthTarget } from './view-distance';

const STATION = '/demo-realvirtual/LaserWeldingAssemblyStation.glb';
const MAUSER = '/private-models/mauser3dhmi/MauserCageline30.glb';

const NEAR = 0.02;
const FAR = 10;
const FOV = 40;

/** The plan's own ceiling for the ID pass (R3). */
const DRAW_CAP = 4096;

// ─── the flat geometry view ─────────────────────────────────────────────

/**
 * A flat view on `chunk.geometry`: the SAME attribute objects, the SAME index
 * object, `groups` of its own.
 *
 * Three things make it legal under NFR4, and all three are properties of this
 * function rather than of a comment:
 *
 *  - `setAttribute` / `setIndex` store the SAME `BufferAttribute` objects, so no
 *    buffer is copied, re-sorted or re-uploaded — the GPU buffer behind them is
 *    the one the chunk already has;
 *  - `addGroup` writes only into THIS geometry's `groups` array;
 *  - nothing here writes to the chunk geometry, calls `computeBoundsTree`, or
 *    disposes anything. Disposing a VIEW must never happen either while the
 *    chunk lives — see {@link releaseView}.
 */
function createGeometryView(chunk: BakedChunk): BufferGeometry {
  const src = chunk.geometry;
  const view = new BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    view.setAttribute(name, src.attributes[name] as BufferAttribute | InterleavedBufferAttribute);
  }
  if (src.index) view.setIndex(src.index);
  // The chunk's bounds are valid for the view (same vertices); computing fresh
  // ones would read the shared position buffer for nothing.
  view.boundingSphere = src.boundingSphere;
  view.boundingBox = src.boundingBox;
  return view;
}

/**
 * Drop a geometry view WITHOUT `dispose()` — the one real trap of this approach.
 *
 * `BufferGeometry.dispose()` dispatches `'dispose'`, and three's
 * `WebGLGeometries` listens on the GEOMETRY and deletes the GL buffers of its
 * attributes — which here are the CHUNK's buffers. Disposing a view would
 * therefore free the live chunk's GPU buffers from under the renderer, which is
 * §1.5 nr. 1 ("never dispose a chunk geometry outside `BakedAsset.dispose()`")
 * breached through the back door. So a view is unreferenced, never disposed;
 * the JS object is a few hundred bytes and the GC takes it. This function
 * exists to make that a call site instead of a footnote.
 */
function releaseView(view: BufferGeometry): void {
  view.groups.length = 0;
  // Deliberately NO view.dispose(). See above.
}

// ─── C2: the fingerprint ────────────────────────────────────────────────

interface ChunkFingerprint {
  indexObject: object | null;
  indexCount: number;
  indexHash: number;
  indexHead: number[];
  indexTail: number[];
  drawRange: { start: number; count: number };
  groups: string;
  attributeNames: string;
  attributeObjects: object[];
  hasBoundsTree: boolean;
  positionVersion: number;
  indexVersion: number;
}

/** FNV-1a over the whole index — cheap, and it catches a re-sort. */
function hashIndex(arr: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    h = Math.imul(h ^ (v & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193);
  }
  return h >>> 0;
}

function fingerprint(chunk: BakedChunk): ChunkFingerprint {
  const geo = chunk.geometry as BufferGeometry & { boundsTree?: unknown };
  const idx = geo.index;
  const arr = idx ? (idx.array as ArrayLike<number>) : null;
  const names = Object.keys(geo.attributes).sort();
  const pos = geo.getAttribute('position') as BufferAttribute | undefined;
  const slice = (from: number, to: number): number[] => {
    if (!arr) return [];
    const out: number[] = [];
    for (let i = from; i < to; i++) out.push(arr[i]);
    return out;
  };
  return {
    indexObject: idx ?? null,
    indexCount: idx ? idx.count : 0,
    indexHash: arr ? hashIndex(arr) : 0,
    indexHead: slice(0, Math.min(12, arr ? arr.length : 0)),
    indexTail: arr ? slice(Math.max(0, arr.length - 12), arr.length) : [],
    drawRange: { start: geo.drawRange.start, count: geo.drawRange.count },
    groups: JSON.stringify(geo.groups),
    attributeNames: names.join(','),
    attributeObjects: names.map((n) => geo.attributes[n] as object),
    hasBoundsTree: geo.boundsTree !== undefined && geo.boundsTree !== null,
    positionVersion: pos ? pos.version : -1,
    indexVersion: idx ? idx.version : -1,
  };
}

function expectUntouched(before: ChunkFingerprint, after: ChunkFingerprint, what: string): void {
  expect(after.indexObject, `${what}: index object replaced`).toBe(before.indexObject);
  expect(after.indexCount, `${what}: index length`).toBe(before.indexCount);
  // §1.5 nr. 3 — "the index order of a chunk is DATA after the bake".
  expect(after.indexHash, `${what}: index CONTENT changed (re-sorted or rewritten)`).toBe(before.indexHash);
  expect(after.indexHead, `${what}: first triangles`).toEqual(before.indexHead);
  expect(after.indexTail, `${what}: last triangles`).toEqual(before.indexTail);
  expect(after.drawRange, `${what}: drawRange`).toEqual(before.drawRange);
  expect(after.groups, `${what}: groups`).toBe(before.groups);
  expect(after.attributeNames, `${what}: attribute set`).toBe(before.attributeNames);
  expect(after.attributeObjects, `${what}: attribute objects replaced`).toEqual(before.attributeObjects);
  // §2.3 nr. 1 — no second acceleration structure on a chunk geometry.
  expect(before.hasBoundsTree, `${what}: a boundsTree was there BEFORE the pass`).toBe(false);
  expect(after.hasBoundsTree, `${what}: a boundsTree appeared on a chunk`).toBe(false);
  // A changed `version` is three's "re-upload this buffer" flag: a silent
  // mutation bumps it even when the bytes happen to match.
  expect(after.positionVersion, `${what}: position attribute version bumped`).toBe(before.positionVersion);
  expect(after.indexVersion, `${what}: index version bumped`).toBe(before.indexVersion);
}

// ─── the ID draw plan, read from the pick structure ─────────────────────

interface OwnerRun { owner: number; start: number; count: number }

interface ChunkDrawPlan {
  chunk: BakedChunk;
  /** One entry per maximal run of equal key, in index order. */
  runs: OwnerRun[];
  /** Triangles in segments with no key (they stay ID 0 = background). */
  unownedTriangles: number;
  /** Distinct keys in the chunk, regardless of contiguity. */
  distinct: number;
}

/**
 * WHICH FIELD IS "THE SEGMENT'S IDENTITY" — the question Phase 0 had to ask.
 *
 * The pick structure carries TWO per-segment node references, and the plan's
 * §2.4 names only one of them:
 *
 *  - `segOwner` — the PICK OWNER: `findPickOwner` walks from the geometry's node
 *    UP to the nearest ancestor that carries `userData.realvirtual`, i.e. the
 *    nearest COMPONENT-CARRYING node. That is literally the plan's primary ID
 *    level ("der komponententragende Knoten (der Besitzer)") and the level a
 *    signal hangs on.
 *  - `segNode` — the SURVIVING NODE whose triangle run the segment is. One
 *    ordinal per node that actually contributed geometry to this chunk.
 *
 * They are NOT interchangeable, and the difference is the whole finding of this
 * half of the spike. Both are measured.
 */
type SegmentKey = 'owner' | 'node';

/**
 * The ID draw plan of one chunk under one identity choice.
 *
 * Segments tile the chunk's index in order (`segmentRange`'s P1 guarantee), so
 * consecutive segments with the SAME key merge into ONE draw. Because segments
 * are sorted by `indexStart` == pre-order ordinal of their node, a key's
 * subtree tends to be contiguous — whether that merge actually happens is what
 * decides R3, so it is computed here instead of assumed away.
 */
function planChunkDraws(chunk: BakedChunk, key: SegmentKey): ChunkDrawPlan {
  const pick = chunk.pick;
  const keyOf = (s: number): number => (key === 'owner' ? pick.segOwner[s] : pick.segNode[s]);
  const runs: OwnerRun[] = [];
  const distinct = new Set<number>();
  let unowned = 0;
  let s = 0;
  while (s < pick.segmentCount) {
    const k = keyOf(s);
    let e = s;
    while (e + 1 < pick.segmentCount && keyOf(e + 1) === k) e++;
    const range = segmentRange(pick, s, e);
    if (range) {
      if (k >= 0) {
        runs.push({ owner: k, start: range.indexStart, count: range.indexCount });
        distinct.add(k);
      } else {
        unowned += range.indexCount / 3;
      }
    }
    s = e + 1;
  }
  return { chunk, runs, unownedTriangles: unowned, distinct: distinct.size };
}

interface AssetDrawPlan {
  key: SegmentKey;
  plans: ChunkDrawPlan[];
  draws: number;
  distinctIds: number;
  chunks: number;
  worstChunk: number;
  medianChunk: number;
  /** Chunks that collapse to a SINGLE id — where segment granularity buys nothing. */
  singleIdChunks: number;
  unownedTriangles: number;
  segments: number;
}

function assetDrawPlan(asset: BakedAsset, key: SegmentKey): AssetDrawPlan {
  const plans = asset.chunks.map((c) => planChunkDraws(c, key));
  const ids = new Set<number>();
  for (const p of plans) for (const r of p.runs) ids.add(r.owner);
  const perChunk = plans.map((p) => p.runs.length).sort((a, b) => b - a);
  return {
    key,
    plans,
    draws: plans.reduce((a, p) => a + p.runs.length, 0),
    distinctIds: ids.size,
    chunks: asset.chunks.length,
    worstChunk: perChunk[0] ?? 0,
    medianChunk: perChunk.length ? perChunk[perChunk.length >> 1] : 0,
    singleIdChunks: plans.filter((p) => p.distinct === 1).length,
    unownedTriangles: plans.reduce((a, p) => a + p.unownedTriangles, 0),
    segments: asset.chunks.reduce((a, c) => a + c.pick.segmentCount, 0),
  };
}

// ─── ID encoding (plan §2.4, exact bytes) ───────────────────────────────

/** 16-bit ID into R and G, class byte into B. NOT the 48-colour palette. */
function idMaterial(id: number, classByte: number): MeshBasicMaterial {
  const mat = new MeshBasicMaterial();
  // setRGB in LinearSRGB + a linear target + toneMapped:false is what makes the
  // byte arrive unchanged; anything else re-encodes it (plan-740's 2.5 m → 6.08 m).
  mat.color.setRGB((id & 0xff) / 255, ((id >> 8) & 0xff) / 255, classByte / 255);
  mat.toneMapped = false;
  mat.fog = false;
  mat.vertexColors = false;
  return mat;
}

function decodeId(px: Uint8Array, offset: number): { id: number; cls: number } {
  return { id: px[offset] | (px[offset + 1] << 8), cls: px[offset + 2] };
}

// ─── harness ────────────────────────────────────────────────────────────

interface Stats { n: number; median: number; p95: number; min: number }
function stats(v: number[]): Stats {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return {
    n: s.length,
    median: s.length ? q(0.5) : NaN,
    p95: s.length ? q(0.95) : NaN,
    min: s.length ? s[0] : NaN,
  };
}
const ms = (x: number) => x.toFixed(3);

function frameNodes(objects: readonly Mesh[], aspect: number): PerspectiveCamera {
  const box = new Box3();
  for (const o of objects) box.expandByObject(o);
  const centre = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
  const span = box.isEmpty() ? 1 : Math.max(0.05, box.getSize(new Vector3()).length());
  const cam = new PerspectiveCamera(FOV, aspect, Math.max(1e-4, span * 0.005), span * 20);
  cam.position.copy(centre).add(new Vector3(span * 0.9, span * 0.7, span * 0.9));
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);
  return cam;
}

/**
 * Build a complete ID pass for `asset` in a PRIVATE scene.
 *
 * One `Mesh` per chunk over a geometry view, one `group` per owner run, one flat
 * material per run. The meshes are NOT parented to the chunk and the chunk is
 * never moved (§1.5 nr. 4) — each takes a COPY of its chunk mesh's world matrix
 * and lives in a scene of its own, so the viewer's graph is not touched at all.
 */
function buildIdScene(plan: AssetDrawPlan, cap = DRAW_CAP): {
  scene: Scene; meshes: Mesh[]; views: BufferGeometry[]; materials: Material[]; draws: number; capped: boolean;
} {
  const scene = new Scene();
  const meshes: Mesh[] = [];
  const views: BufferGeometry[] = [];
  const materials: Material[] = [];
  let draws = 0;
  let capped = false;
  let nextId = 1;
  for (const chunkPlan of plan.plans) {
    if (chunkPlan.runs.length === 0) continue;
    if (draws >= cap) { capped = true; break; }
    const view = createGeometryView(chunkPlan.chunk);
    const mats: Material[] = [];
    for (const run of chunkPlan.runs) {
      if (draws >= cap) { capped = true; break; }
      view.addGroup(run.start, run.count, mats.length);
      const m = idMaterial(nextId & 0xffff, (nextId >> 16) & 0xff);
      nextId++;
      mats.push(m);
      materials.push(m);
      draws++;
    }
    const mesh = new Mesh(view, mats);
    const src = chunkPlan.chunk.templateMesh;
    mesh.matrixAutoUpdate = false;
    if (src) {
      src.updateMatrixWorld(true);
      mesh.matrix.copy(src.matrixWorld);
      mesh.matrixWorld.copy(src.matrixWorld);
    }
    mesh.frustumCulled = true;
    scene.add(mesh);
    meshes.push(mesh);
    views.push(view);
  }
  scene.matrixWorldAutoUpdate = false;
  return { scene, meshes, views, materials, draws, capped };
}

function tearDownIdScene(built: ReturnType<typeof buildIdScene>): void {
  for (const m of built.materials) m.dispose();
  for (const v of built.views) releaseView(v);
  built.scene.clear();
}

// ─── fixtures ───────────────────────────────────────────────────────────

let station: TestViewerHandle | null = null;
let stationAsset: BakedAsset;
let renderer: WebGLRenderer;

beforeAll(async () => {
  station = await createTestViewer('webgl', { desRunner: false, width: 800, height: 600 });
  renderer = station.viewer.renderer as unknown as WebGLRenderer;
  const bytes = await (await fetch(STATION)).arrayBuffer();
  const result = await loadBakedGLB(STATION, station.viewer.scene, { data: bytes });
  stationAsset = result.bakedAsset!;
  console.info(
    `[672-P0] Station baked: ${stationAsset.chunks.length} chunks, `
    + `${stationAsset.chunks.reduce((a, c) => a + c.triangles, 0)} triangles, `
    + `${stationAsset.nodeTable.nodes.length} surviving nodes, `
    + `${stationAsset.nodeTable.rowChunk.length} CSR rows`,
  );
}, 600_000);

afterAll(() => { station?.dispose(); station = null; });

// ─── C1 + C2 ────────────────────────────────────────────────────────────

/**
 * THE GRANULARITY FINDING, measured before anything is drawn.
 *
 * §2.4 of the plan rests on "the pick structure knows the owner per segment, so
 * segment granularity gives per-component IDs where mesh granularity gives one
 * colour per chunk". That is a claim about a real bake, and this is the number
 * that confirms or refutes it — for BOTH candidate identity fields.
 */
function printGranularity(model: string, asset: BakedAsset): void {
  const byOwner = assetDrawPlan(asset, 'owner');
  const byNode = assetDrawPlan(asset, 'node');
  const row = (p: AssetDrawPlan) =>
    `${p.key.padEnd(5)}: ${p.draws} draws, ${p.distinctIds} distinct ids, `
    + `worst chunk ${p.worstChunk}, median chunk ${p.medianChunk}, `
    + `${p.singleIdChunks}/${p.chunks} chunks collapse to ONE id, `
    + `${p.unownedTriangles} tris unowned`;
  console.info(
    `[672-P0] GRANULARITY on ${model} — ${asset.chunks.length} chunks, ${byOwner.segments} segments, `
    + `${asset.nodeTable.nodes.length} surviving nodes:\n  ${row(byOwner)}\n  ${row(byNode)}`,
  );
}

describe('plan-672 P0 · the granularity a segment ID can actually reach', () => {
  it('segOwner vs segNode on Station — which one is "segment granularity"?', () => {
    printGranularity('LaserWeldingAssemblyStation', stationAsset);
    const byOwner = assetDrawPlan(stationAsset, 'owner');
    const byNode = assetDrawPlan(stationAsset, 'node');
    // Reported, not gated: the comparison IS the deliverable. A hard assertion
    // here would turn a finding into a failure and hide the numbers.
    expect(byOwner.draws + byNode.draws).toBeGreaterThan(0);
  });
});

describe('plan-672 P0 · C1/C2 — a flat geometry view over a chunk draws, and changes nothing', () => {
  it('two segment intervals from the node table produce two exact IDs', () => {
    // The chunk with the most distinct segment ids: where the claim is hardest.
    // `segNode` rather than `segOwner`, because the measurement above shows
    // owner granularity collapses to one id per chunk on this model — see the
    // GRANULARITY line and the spike report.
    const candidates = stationAsset.chunks
      .map((c) => planChunkDraws(c, 'node'))
      .filter((p) => p.runs.length >= 2)
      .sort((a, b) => b.runs.length - a.runs.length);
    expect(candidates.length, 'Station must have a chunk with ≥ 2 distinct segment nodes').toBeGreaterThan(0);
    const plan = candidates[0];
    const chunk = plan.chunk;

    const before = fingerprint(chunk);
    const view = createGeometryView(chunk);
    const matA = idMaterial(0x1234, 7);
    const matB = idMaterial(0x89ab, 9);
    const S = 192;
    const rt = createDepthTarget(S, S, 'rgba8');
    try {
      const [a, b] = plan.runs;
      view.addGroup(a.start, a.count, 0);
      view.addGroup(b.start, b.count, 1);
      const mesh = new Mesh(view, [matA, matB]);
      mesh.matrixAutoUpdate = false;
      if (chunk.templateMesh) {
        chunk.templateMesh.updateMatrixWorld(true);
        mesh.matrix.copy(chunk.templateMesh.matrixWorld);
        mesh.matrixWorld.copy(chunk.templateMesh.matrixWorld);
      }
      const scene = new Scene();
      scene.add(mesh);
      scene.matrixWorldAutoUpdate = false;

      const cam = frameNodes([mesh], 1);
      const prevTarget = renderer.getRenderTarget();
      const prevClear = new Color();
      renderer.getClearColor(prevClear);
      const prevAlpha = renderer.getClearAlpha();
      let px: Uint8Array;
      try {
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 1); // ID 0 = background, per §2.3
        renderer.clear();
        renderer.render(scene, cam);
        px = readRenderTargetPixelsFlipped(renderer, rt, S, S);
      } finally {
        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClear, prevAlpha);
        scene.clear();
      }

      const seen = new Map<number, { px: number; cls: number }>();
      for (let i = 0; i < S * S; i++) {
        const { id, cls } = decodeId(px, i * 4);
        const e = seen.get(id);
        if (e) e.px++; else seen.set(id, { px: 1, cls });
      }
      const table = [...seen.entries()]
        .sort((x, y) => y[1].px - x[1].px)
        .map(([id, v]) => `0x${id.toString(16)}(cls ${v.cls}) ${v.px}px`);
      console.info(
        `[672-P0] ID DRAW on chunk '${chunk.key}' (${chunk.triangles} tris, `
        + `${chunk.pick.segmentCount} segments, ${plan.runs.length} owner runs, `
        + `drew runs of ${a.count / 3} + ${b.count / 3} tris): ${table.join(', ')}`,
      );

      expect(seen.has(0x1234), 'owner A must be visible with its exact ID bytes').toBe(true);
      expect(seen.has(0x89ab), 'owner B must be visible with its exact ID bytes').toBe(true);
      expect(seen.get(0x1234)!.cls, 'class byte of A').toBe(7);
      expect(seen.get(0x89ab)!.cls, 'class byte of B').toBe(9);
      // Exact bytes, not a palette: nothing in between may appear.
      const strays = [...seen.keys()].filter((id) => id !== 0 && id !== 0x1234 && id !== 0x89ab);
      expect(strays, `unexpected IDs: ${strays.map((s) => `0x${s.toString(16)}`).join(',')}`).toEqual([]);
    } finally {
      matA.dispose(); matB.dispose(); rt.dispose(); releaseView(view);
    }

    expectUntouched(before, fingerprint(chunk), `chunk ${chunk.key} after an ID draw`);
  });

  it('a FULL ID pass over every chunk leaves every chunk geometry byte-identical', () => {
    const plan = assetDrawPlan(stationAsset, 'node');
    const before = stationAsset.chunks.map(fingerprint);
    const built = buildIdScene(plan);
    const S = 320;
    const rt = createDepthTarget(S, Math.round(S * 0.75), 'rgba8');
    try {
      const cam = frameNodes(built.meshes, 4 / 3);
      const ran = station!.viewer.renderAuxiliaryPass((r) => {
        r.setRenderTarget(rt);
        r.setClearColor(0x000000, 1);
        r.clear();
        r.render(built.scene, cam);
        readRenderTargetPixelsFlipped(r, rt, S, Math.round(S * 0.75));
      });
      expect(ran, 'the auxiliary pass must run').toBe(true);
      console.info(`[672-P0] full ID pass drew ${built.draws} groups over ${built.meshes.length} chunk views`);
    } finally {
      rt.dispose();
      tearDownIdScene(built);
    }
    stationAsset.chunks.forEach((c, i) => expectUntouched(before[i], fingerprint(c), `chunk[${i}] ${c.key}`));
  });

  /**
   * THE MEMORY OF THE GEOMETRY VIEWS — the plan's fifth Phase 0 bullet.
   *
   * A byte estimate would be a guess. The thing worth knowing is STRUCTURAL and
   * can be proven: a view holds the IDENTICAL `BufferAttribute` and index
   * objects, so it allocates NO vertex or index bytes at all — whatever the
   * model's size. What it does allocate is one `BufferGeometry` plus its
   * `groups` array per chunk, which is why the figure reported here is a count,
   * not a size: views and groups, with the per-chunk geometry bytes they do NOT
   * duplicate, for scale.
   */
  it('a geometry view allocates ZERO vertex/index bytes (identical attribute objects)', () => {
    const plan = assetDrawPlan(stationAsset, 'node');
    const built = buildIdScene(plan);
    try {
      let sharedBytes = 0;
      let checked = 0;
      built.views.forEach((view, i) => {
        const chunk = stationAsset.chunks[i];
        for (const name of Object.keys(chunk.geometry.attributes)) {
          // Object identity, not deep equality: a copy would pass `toEqual`.
          expect(view.getAttribute(name), `${chunk.key}.${name} must be the SAME object`)
            .toBe(chunk.geometry.attributes[name]);
          const arr = (chunk.geometry.attributes[name] as BufferAttribute).array;
          sharedBytes += arr.byteLength;
          checked++;
        }
        expect(view.index, `${chunk.key}.index must be the SAME object`).toBe(chunk.geometry.index);
        sharedBytes += chunk.geometry.index?.array.byteLength ?? 0;
      });
      console.info(
        `[672-P0] GEOMETRY VIEWS on Station: ${built.views.length} views, ${built.draws} groups, `
        + `${checked} attributes shared by identity; `
        + `${(sharedBytes / (1024 * 1024)).toFixed(1)} MB of vertex+index data NOT duplicated `
        + '(a view allocates one BufferGeometry + its groups array, nothing else)',
      );
      expect(built.views.length).toBeGreaterThan(0);
    } finally {
      tearDownIdScene(built);
    }
  });

  it('the chunk geometries are still renderable afterwards (no buffer was freed)', () => {
    // The teardown above drops the views WITHOUT disposing them. If that rule
    // were broken, three would have deleted the chunks' GL buffers and the very
    // next viewport frame would draw nothing. So: render the real scene again
    // and demand pixels.
    const S = 128;
    const rt = createDepthTarget(S, S, 'rgba8');
    try {
      const cam = frameNodes(
        stationAsset.chunks.map((c) => c.templateMesh).filter((m): m is Mesh => !!m),
        1,
      );
      const px = new Uint8Array(S * S * 4);
      const ran = station!.viewer.renderAuxiliaryPass((r, scene) => {
        r.setRenderTarget(rt);
        r.setClearColor(0x000000, 1);
        r.clear();
        r.render(scene, cam);
        r.readRenderTargetPixels(rt, 0, 0, S, S, px);
      });
      expect(ran).toBe(true);
      const lit = px.reduce((a, v, i) => (i % 4 === 3 ? a : a + (v > 0 ? 1 : 0)), 0);
      console.info(`[672-P0] viewer scene after the ID pass: ${lit} non-black colour bytes of ${S * S * 3}`);
      expect(lit, 'the baked scene must still draw after an ID pass').toBeGreaterThan(0);
    } finally {
      rt.dispose();
    }
  });
});

// ─── C3: the draw count, and the cost ───────────────────────────────────

function printDrawPlan(model: string, plan: AssetDrawPlan): void {
  console.info(
    `[672-P0] ID DRAW COUNT on ${model} (key=${plan.key}): ${plan.draws} draws over ${plan.chunks} chunks `
    + `(${plan.segments} segments, ${plan.distinctIds} distinct ids; `
    + `worst chunk ${plan.worstChunk} draws, median chunk ${plan.medianChunk}; `
    + `${plan.unownedTriangles} triangles unowned → ID 0) — cap ${DRAW_CAP} → `
    + `${plan.draws <= DRAW_CAP ? 'within' : 'OVER'}`,
  );
}

describe('plan-672 P0 · C3 — the ID pass draw count and its cost', () => {
  it('Station: the draw count against the 4096 cap', () => {
    const plan = assetDrawPlan(stationAsset, 'node');
    printDrawPlan('LaserWeldingAssemblyStation', plan);
    expect(plan.draws, 'Station must need at least one ID draw').toBeGreaterThan(0);
  });

  it('Station: one ID pass at 320x240 and 640x480, render + readback', () => {
    const plan = assetDrawPlan(stationAsset, 'node');
    const built = buildIdScene(plan);
    try {
      const rows: string[] = [];
      for (const [w, h] of [[320, 240], [640, 480]] as const) {
        const rt = createDepthTarget(w, h, 'rgba8');
        const cam = frameNodes(built.meshes, w / h);
        const submit: number[] = [];
        const total: number[] = [];
        try {
          for (let i = 0; i < 25; i++) {
            const ran = station!.viewer.renderAuxiliaryPass((r) => {
              const t0 = performance.now();
              r.setRenderTarget(rt);
              r.setClearColor(0x000000, 1);
              r.clear();
              r.render(built.scene, cam);
              const t1 = performance.now();
              readRenderTargetPixelsFlipped(r, rt, w, h);
              const t2 = performance.now();
              if (i >= 5) { submit.push(t1 - t0); total.push(t2 - t0); }
            });
            expect(ran).toBe(true);
          }
        } finally {
          rt.dispose();
        }
        const st = stats(total);
        const su = stats(submit);
        rows.push(
          `${w}x${h}: median ${ms(st.median)} ms, p95 ${ms(st.p95)} ms, min ${ms(st.min)} ms `
          + `[submit ${ms(su.median)} ms] (n=${st.n}, ${built.draws} draws)`,
        );
      }
      console.info(`[672-P0] ID PASS COST on Station (${built.draws} draws):\n  ${rows.join('\n  ')}`);
      console.info(
        '[672-P0] GATE (ID pass + readback ≤ 6 ms at 320x240 on Station): see the first row above',
      );
    } finally {
      tearDownIdScene(built);
    }
  });

  /**
   * The same pass with an ASYNCHRONOUS readback.
   *
   * The depth half of this spike found that ~90 % of a pass's cost is the
   * SYNCHRONOUS `readRenderTargetPixels` stalling the main thread, not the
   * pixels or the draws (the cost barely moves between 320×240 and 640×480).
   * If that holds for the ID pass too, then the plan's two budgets are about
   * the wrong quantity and the mitigation in NFR2 ("keep the resolution small")
   * is the wrong lever — so it is measured here rather than inferred.
   */
  it('Station: the same ID pass with an ASYNC readback', async () => {
    const plan = assetDrawPlan(stationAsset, 'node');
    const built = buildIdScene(plan);
    const [w, h] = [320, 240];
    const rt = createDepthTarget(w, h, 'rgba8');
    const r = renderer as WebGLRenderer & {
      readRenderTargetPixelsAsync?: (
        t: typeof rt, x: number, y: number, ww: number, hh: number, buf: Uint8Array,
      ) => Promise<unknown>;
    };
    try {
      const cam = frameNodes(built.meshes, w / h);
      const main: number[] = [];
      const latency: number[] = [];
      for (let i = 0; i < 15; i++) {
        const buf = new Uint8Array(w * h * 4);
        let pending!: Promise<unknown>;
        const t0 = performance.now();
        const ran = station!.viewer.renderAuxiliaryPass((rr) => {
          rr.setRenderTarget(rt);
          rr.setClearColor(0x000000, 1);
          rr.clear();
          rr.render(built.scene, cam);
          pending = r.readRenderTargetPixelsAsync!(rt, 0, 0, w, h, buf);
          rr.setRenderTarget(null);
        });
        expect(ran).toBe(true);
        const t1 = performance.now();
        await pending;
        const t2 = performance.now();
        if (i >= 5) { main.push(t1 - t0); latency.push(t2 - t0); }
        expect(buf.some((v) => v !== 0), 'the async ID readback returned an all-zero buffer').toBe(true);
      }
      const m = stats(main);
      const l = stats(latency);
      console.info(
        `[672-P0] ID PASS ASYNC on Station (${built.draws} draws, ${w}x${h}):\n  `
        + `main thread  : median ${ms(m.median)} ms, p95 ${ms(m.p95)} ms (n=${m.n})\n  `
        + `pixel latency: median ${ms(l.median)} ms, p95 ${ms(l.p95)} ms`,
      );
      console.info(
        '[672-P0] GATE revisited — ID pass main-thread cost with an ASYNC readback vs 6 ms: '
        + `${ms(m.median)} ms → ${m.median <= 6 ? 'PASS' : 'FAIL'}`,
      );
    } finally {
      rt.dispose();
      tearDownIdScene(built);
    }
  }, 300_000);
});

// ─── the large model ────────────────────────────────────────────────────

// The availability probe runs in `beforeAll`, NOT at module scope.
// `tests/fixtures/dev-asset-available.ts` documents a top-level `await` as the
// normal pairing with `describe.skipIf`, and it is — for ONE file. With two
// measurement files in one serial browser session the second one's top-level
// await lands after the first file's suite context is gone, and vitest 4.0.18
// fails the whole file with "Vitest failed to find the current suite"
// (reproduced 2026-10-24). So: no module-scope await here, and the skip is a
// runtime `ctx.skip()` instead of a collection-time one.
let mauserAvailable = false;

describe('plan-672 P0 · C3 on a Mauser-class model', () => {
  let big: TestViewerHandle | null = null;
  let bigAsset: BakedAsset;

  beforeAll(async () => {
    mauserAvailable = await devAssetAvailable(MAUSER);
    if (!mauserAvailable) {
      console.info('[672-P0] Mauser-class model unavailable (no private sibling) — skipping');
      return;
    }
    big = await createTestViewer('webgl', { desRunner: false, width: 800, height: 600 });
    const bytes = await (await fetch(MAUSER)).arrayBuffer();
    const result = await loadBakedGLB(MAUSER, big.viewer.scene, { data: bytes });
    bigAsset = result.bakedAsset!;
    console.info(
      `[672-P0] Mauser baked: ${bigAsset.chunks.length} chunks, `
      + `${bigAsset.chunks.reduce((a, c) => a + c.triangles, 0)} triangles, `
      + `${bigAsset.nodeTable.nodes.length} surviving nodes, `
      + `${bigAsset.nodeTable.rowChunk.length} CSR rows`,
    );
  }, 900_000);

  afterAll(() => { big?.dispose(); big = null; });

  it('the draw count against the 4096 cap — this is where R3 is decided', (ctx) => {
    if (!mauserAvailable) { ctx.skip(); return; }
    printGranularity('MauserCageline30', bigAsset);
    const plan = assetDrawPlan(bigAsset, 'node');
    printDrawPlan('MauserCageline30', plan);
    expect(plan.draws).toBeGreaterThan(0);
  });

  it('one ID pass at 320x240, capped at 4096 draws', (ctx) => {
    if (!mauserAvailable) { ctx.skip(); return; }
    const plan = assetDrawPlan(bigAsset, 'node');
    const built = buildIdScene(plan);
    const before = bigAsset.chunks.map(fingerprint);
    const [w, h] = [320, 240];
    const rt = createDepthTarget(w, h, 'rgba8');
    try {
      const cam = frameNodes(built.meshes, w / h);
      const total: number[] = [];
      for (let i = 0; i < 20; i++) {
        const ran = big!.viewer.renderAuxiliaryPass((r) => {
          const t0 = performance.now();
          r.setRenderTarget(rt);
          r.setClearColor(0x000000, 1);
          r.clear();
          r.render(built.scene, cam);
          readRenderTargetPixelsFlipped(r, rt, w, h);
          if (i >= 5) total.push(performance.now() - t0);
        });
        expect(ran).toBe(true);
      }
      const st = stats(total);
      console.info(
        `[672-P0] ID PASS COST on MauserCageline30 (${built.draws} draws, capped=${built.capped}): `
        + `${w}x${h} median ${ms(st.median)} ms, p95 ${ms(st.p95)} ms (n=${st.n})`,
      );
    } finally {
      rt.dispose();
      tearDownIdScene(built);
    }
    bigAsset.chunks.forEach((c, i) => expectUntouched(before[i], fingerprint(c), `mauser chunk[${i}] ${c.key}`));
  });
});
