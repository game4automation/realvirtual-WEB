// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-621 Phase 2 (§9.2) — the `replaceNodeGeometry` op, keyed-amend
 * coalescing of transaction entries (Spike (b) V2) and the `'solidcraft'`
 * namespace of the CAD-GLB cache.
 *
 *  1. `replaceNodeGeometry`: only `mesh.geometry` changes; undo/redo through
 *     the stash, redo/undo after a save and draft replay through the cache;
 *     picking follows the new triangles; the geometries the op built are
 *     disposed exactly once.
 *  2. Keyed amend: consecutive sync transactions with the same key become ONE
 *     undo entry, absolute setters fold, every foreign history move breaks the
 *     chain, the clean point is never amended, reference-rewrite ranges move
 *     with their ops (the spike's tests, ported and hardened against the real
 *     geometry op instead of the `setMaterial` stand-in).
 *  3. Cache: `'solidcraft'` entries are isolated, legacy keys stay byte-identical,
 *     and the GLB writer is deterministic (the cache SHA is a content hash).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
  type Intersection,
  type Object3D,
} from 'three';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer, op, ref } from './helpers/spike-610-ref-fixture';
import {
  foldKeyedComposite,
  makeAssetComposite,
  referenceRewriteRangesOf,
  type RvCompositeOp,
  type RvOp,
  type RvReplaceNodeGeometryOp,
} from '../src/core/ops/rv-unified-ops';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor, type RvExecutor } from '../src/core/ops/rv-unified-executors';
import { needsRecomposeToUndo, undoViaRecompose } from '../src/core/ops/rv-document-projection';
import { CadGeometryUnavailableError } from '../src/core/editor/rv-asset-executors';
import { InstancePickIndex } from '../src/core/engine/rv-instance-pick-index';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  cadGlbFileName,
  cadGlbOpfsKey,
  clearCadGlbCache,
  getCadGlb,
  putCadGlb,
  sha256Hex,
} from '../src/core/import/rv-cad-glb-cache';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import type { CADLinkExtras } from '../src/core/editor/rv-asset-ops';
import '../src/core/engine/rv-transport-surface';

const DRIVE_T = 'realvirtual.Drive';
const SC = 'solidcraft' as const;
const KEY = { key: 'solidcraft-sync:s1', windowMs: 60_000 };
type Doc = ReturnType<typeof scratchAssetDocument>;
type V3 = [number, number, number];

const T = (x: number, y = 0, z = 0) => ({
  position: [x, y, z] as V3,
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as V3,
});
const pos = (n: { position: { toArray(): number[] } }) => n.position.toArray().map((v) => Math.round(v * 1e6) / 1e6);

/** A box of edge `size`, its vertices shifted by `dx` — distinct geometry per (size, dx). */
function box(size: number, dx = 0): BufferGeometry {
  return new BoxGeometry(size, size, size).translate(dx, 0, 0);
}
/** The one-mesh GLB a sync plugin would hand in. */
async function glbOf(geometry: BufferGeometry): Promise<ArrayBuffer> {
  return objectToGlb(new Mesh(geometry));
}
/** Local x extent of a geometry (what the test reads to tell geometries apart). */
function xRange(g: BufferGeometry): [number, number] {
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  return [Math.round(bb.min.x * 1e4) / 1e4, Math.round(bb.max.x * 1e4) / 1e4];
}

/**
 * The plan-610 fixture plus one mesh body with a live Drive on it — the node a
 * live sync swaps geometries on — and a real editor pick index.
 */
function fixture() {
  const f = makeSpikeViewer();
  const axis = f.add(f.model, 'Axis');
  const belt = f.add(f.model, 'Belt');
  const slide = f.add(f.model, 'Slide');
  const material = new MeshStandardMaterial({ name: 'body-mat' });
  const body = new Mesh(box(1), material);
  body.name = 'Body';
  body.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };
  f.model.add(body);
  f.register();
  const drive = f.drive(axis);
  const slideDrive = f.drive(slide);
  const bodyDrive = f.drive(body);
  const surface = f.component(belt, 'TransportSurface', { DriveReference: ref('Axis', DRIVE_T) });
  const pick = new InstancePickIndex(f.registry);
  pick.addSubtree(f.model);
  const bvhBuilds: Object3D[] = [];
  Object.assign(f.viewer, {
    instancePickIndex: pick,
    buildMeshBvhsAsync: (root: Object3D) => { bvhBuilds.push(root); },
  });
  const original = body.geometry;
  return { ...f, axis, belt, slide, body, material, drive, slideDrive, bodyDrive, surface, pick, bvhBuilds, original };
}
type Fx = ReturnType<typeof fixture>;

/** Per-instance call counts of `dispose` / `disposeBoundsTree` on every BufferGeometry. */
function trackDisposal() {
  const disposed = new Map<BufferGeometry, number>();
  const trees = new Map<BufferGeometry, number>();
  const proto = BufferGeometry.prototype as BufferGeometry & { disposeBoundsTree?: () => void };
  const hadTree = Object.prototype.hasOwnProperty.call(proto, 'disposeBoundsTree');
  const origTree = proto.disposeBoundsTree;
  const spy = vi.spyOn(BufferGeometry.prototype, 'dispose').mockImplementation(function (this: BufferGeometry) {
    disposed.set(this, (disposed.get(this) ?? 0) + 1);
  });
  proto.disposeBoundsTree = function (this: BufferGeometry) {
    trees.set(this, (trees.get(this) ?? 0) + 1);
  };
  return {
    disposed: (g: BufferGeometry) => disposed.get(g) ?? 0,
    trees: (g: BufferGeometry) => trees.get(g) ?? 0,
    restore() {
      spy.mockRestore();
      if (hadTree) proto.disposeBoundsTree = origTree;
      else delete (proto as { disposeBoundsTree?: unknown }).disposeBoundsTree;
    },
  };
}

const geometryOps = (doc: Doc) => doc.ops.flatMap((o) => (o.kind === 'composite' ? o.ops : [o]))
  .filter((o): o is RvReplaceNodeGeometryOp => o.kind === 'replaceNodeGeometry');

beforeEach(async () => {
  await clearCadGlbCache();
  await __clearDraftStoresForTests();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ══════════════════════════════════════════════════════════════════════
// 1. The op
// ══════════════════════════════════════════════════════════════════════

describe('replaceNodeGeometry', () => {
  it('swaps only mesh.geometry; node, material and components survive', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    f.body.position.set(0.5, 0.25, 0);
    f.body.updateMatrixWorld(true);
    const extrasBefore = JSON.stringify(f.body.userData.realvirtual);

    const result = await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);

    expect(result).not.toBeNull();
    expect(f.registry.getNode('Asset/Body')).toBe(f.body);
    expect(f.body.geometry).not.toBe(f.original);
    expect(xRange(f.body.geometry)).toEqual([-1, 1]);
    expect(f.body.geometry.boundingSphere).not.toBeNull();
    expect(f.body.material).toBe(f.material);
    expect(pos(f.body)).toEqual([0.5, 0.25, 0]);
    expect(JSON.stringify(f.body.userData.realvirtual)).toBe(extrasBefore);
    expect(new Map(f.registry.getComponentsAt('Asset/Body') ?? []).get('Drive')).toBe(f.bodyDrive);
    // The op carries hashes only, both of them mandatory.
    const [g] = geometryOps(doc);
    expect(g).toMatchObject({ nodePath: 'Asset/Body', sha256: result!.sha256, prevSha256: result!.prevSha256, quality: 'source', converter: SC });
    expect(g.prevSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
    // The mesh's BVH is rebuilt for the new geometry.
    expect(f.bvhBuilds).toContain(f.body);
    doc.dispose();
  });

  it('a GLB with the current geometry is not an edit (same hash → no op)', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    const bytes = await glbOf(box(2));
    await doc.replaceNodeGeometry('Asset/Body', bytes, SC);
    expect(await doc.replaceNodeGeometry('Asset/Body', bytes, SC)).toBeNull();
    expect(doc.ops).toHaveLength(1);
    doc.dispose();
  });

  it('refuses a node without exactly one mesh, and a GLB without exactly one mesh — nothing queued', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    await expect(doc.replaceNodeGeometry('Asset/Slide', await glbOf(box(2)), SC)).rejects.toThrow(/exactly one mesh/);
    const two = new Mesh(box(1));
    two.add(new Mesh(box(2)));
    await expect(doc.replaceNodeGeometry('Asset/Body', await objectToGlb(two), SC)).rejects.toThrow(/exactly one mesh/);
    expect(doc.ops).toHaveLength(0);
    expect(f.body.geometry).toBe(f.original);
    doc.dispose();
  });

  it('undo restores previous geometry, redo re-applies', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
    const installed = f.body.geometry;
    await doc.undo();
    expect(f.body.geometry).toBe(f.original); // the exact instance, from the stash
    await doc.redo();
    expect(f.body.geometry).toBe(installed); // redo re-installs without a cache read
    expect(xRange(f.body.geometry)).toEqual([-1, 1]);
    doc.dispose();
  });

  it('coalesces two replaces on the same node within the window into one undo step', async () => {
    const t = trackDisposal();
    try {
      const f = fixture();
      const doc = scratchAssetDocument(f.viewer);
      const first = await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
      const intermediate = f.body.geometry;
      const second = await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(3)), SC);
      expect(doc.ops).toHaveLength(1);
      expect(geometryOps(doc)[0]).toMatchObject({ prevSha256: first!.prevSha256, sha256: second!.sha256 });
      // The intermediate geometry is unreachable from the merged op: freed at once.
      expect(t.disposed(intermediate)).toBe(1);
      await doc.undo();
      expect(f.body.geometry).toBe(f.original);
      await doc.redo();
      expect(xRange(f.body.geometry)).toEqual([-1.5, 1.5]);
      doc.dispose();
    } finally { t.restore(); }
  });

  it('replays from CAD-GLB cache after draft reload', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
    await doc.whenIdle();
    const ops = JSON.parse(JSON.stringify(doc.toDraft().ops)) as RvOp[];
    doc.dispose();

    const g = fixture();
    const restored = scratchAssetDocument(g.viewer);
    await restored.replayOps(ops);
    expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
    expect(xRange(g.body.geometry)).toEqual([-1, 1]);
    expect(g.body.material).toBe(g.material);
    // Undo after the replay: the stash is empty, prevSha256 comes from the cache.
    await restored.undo();
    expect(xRange(g.body.geometry)).toEqual([-0.5, 0.5]);
    restored.dispose();
  });

  it('missing cache entry raises CadGeometryUnavailableError', async () => {
    // Replay: collected (the rest of the draft keeps replaying), the node untouched.
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    const missing = op({
      kind: 'replaceNodeGeometry', nodePath: 'Asset/Body', sha256: 'f'.repeat(64),
      quality: 'source', converter: SC, prevSha256: 'e'.repeat(64),
    });
    await doc.replayOps([missing]);
    const collected = doc.executor.takeMissingCadGeometry();
    expect(collected).toHaveLength(1);
    expect(collected[0].cadlink).toMatchObject({ Sha256: 'f'.repeat(64), Converter: SC });
    expect(f.body.geometry).toBe(f.original);
    doc.dispose();

    // Undo after a save flushed the stash and the cache was evicted: the undo
    // REJECTS with the defined error and the entry stays undoable.
    const g = fixture();
    const doc2 = scratchAssetDocument(g.viewer);
    await doc2.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
    await doc2.markSaved(doc2.base);
    await clearCadGlbCache();
    await expect(doc2.undo()).rejects.toBeInstanceOf(CadGeometryUnavailableError);
    expect(doc2.ops).toHaveLength(1);
    expect(xRange(g.body.geometry)).toEqual([-1, 1]);
    doc2.dispose();
  });

  it('rebuilds pick structure: raycast hits new triangles, not old ones', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    const hits = (x: number) => {
      const out: Intersection<Object3D>[] = [];
      f.pick.raycast(new Raycaster(new Vector3(x, 0, 10), new Vector3(0, 0, -1)), out);
      return out.filter((h) => h.object === f.body).length;
    };
    expect(hits(0)).toBeGreaterThan(0);
    expect(hits(5)).toBe(0);
    await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(1, 5)), SC);
    expect(hits(0)).toBe(0);
    expect(hits(5)).toBeGreaterThan(0);
    await doc.undo();
    expect(hits(0)).toBeGreaterThan(0);
    expect(hits(5)).toBe(0);
    doc.dispose();
  });

  it('old geometry stays alive for undo and is disposed exactly once on flushTrash', async () => {
    const t = trackDisposal();
    try {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(100_000);
      const f = fixture();
      const doc = scratchAssetDocument(f.viewer);
      await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
      const b = f.body.geometry;
      vi.setSystemTime(110_000); // beyond the primitive window: a second entry
      await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(3)), SC);
      const c = f.body.geometry;
      expect(doc.ops).toHaveLength(2);
      expect(t.disposed(b)).toBe(0); // held for undo
      await doc.undo();
      expect(f.body.geometry).toBe(b);
      await doc.redo();
      expect(f.body.geometry).toBe(c);

      await doc.markSaved(doc.base); // flushTrash
      expect(t.disposed(b)).toBe(1);
      expect(t.trees(b)).toBe(1);
      expect(t.disposed(c)).toBe(0); // live
      expect(t.disposed(f.original)).toBe(0); // never owned by the op (may be shared)
      doc.executor.flushTrash();
      doc.dispose();
      expect(t.disposed(b)).toBe(1);
    } finally { t.restore(); }
  });

  it('the first swap of an importCad body uses the import\'s own key as prevSha256 (no snapshot)', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    const cadlink: CADLinkExtras = {
      File: 'part.3mf', Sha256: 'a1'.repeat(32), Quality: 'source', ImportScaleFactor: 0.001,
      ZIsUpVector: false, Converter: SC,
    };
    const rootPath = await doc.importCad({ glb: await glbOf(box(1, 3)), cadlink });
    const importedMesh = singleMesh(f.registry.getNode(rootPath)!);
    const importedVertices = importedMesh.geometry.getAttribute('position').count;
    const r = await doc.replaceNodeGeometry(rootPath, await glbOf(box(2)), SC);
    expect(r!.prevSha256).toBe(cadlink.Sha256);
    await doc.markSaved(doc.base); // the import's geometry object is no longer reachable from a stash
    await doc.undo();
    const back = singleMesh(f.registry.getNode(rootPath)!).geometry;
    expect(back.getAttribute('position').count).toBe(importedVertices);
    expect(xRange(back)).toEqual([2.5, 3.5]);
    doc.dispose();
  });
});

function singleMesh(node: Object3D): Mesh {
  const out: Mesh[] = [];
  node.traverse((o) => { if ((o as Mesh).isMesh) out.push(o as Mesh); });
  expect(out).toHaveLength(1);
  return out[0];
}

// ══════════════════════════════════════════════════════════════════════
// 2. Keyed amend coalescing
// ══════════════════════════════════════════════════════════════════════

/** One sync step = one transaction; V2 passes the key, V0 does not. */
async function syncStep(doc: Doc, body: () => Promise<void>, keyed: boolean): Promise<void> {
  await doc.withTransaction('SolidCraft sync', body, keyed ? { coalesce: KEY } : undefined);
}
const apply = (doc: Doc, ops: RvOp[]) => async () => { for (const o of ops) await doc.applyOp(o as never); };

/** A recording stub — the document guards without a scene. */
class StubExecutor implements RvExecutor {
  released: string[] = [];
  async applyForward(o: RvOp): Promise<void> { if (o.kind === 'composite') for (const c of o.ops) await this.applyForward(c); }
  async applyInverse(o: RvOp): Promise<void> { if (o.kind === 'composite') for (let i = o.ops.length - 1; i >= 0; i--) await this.applyInverse(o.ops[i]); }
  releaseAbsorbed(ids: readonly string[]): void { this.released.push(...ids); }
}
const stubDoc = () => {
  const executor = new StubExecutor();
  return { executor, doc: new RvDocument({ id: 'd', name: 'D', mode: 'asset', executor }) };
};
let stubX = 0;
const tf = (x: number) => op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(x), prev: T(x - 1) });
const stubStep = (doc: RvDocument, extra?: Parameters<RvDocument['withTransaction']>[2], key = KEY) =>
  doc.withTransaction('sync', async () => { await doc.applyOp(tf(++stubX)); }, { coalesce: key, ...extra });

describe('keyed amend coalescing (Spike b, SOL R3 #3)', () => {
  it('two sync composites with the same key inside the sliding window become ONE undo step; undo returns to the state before the first', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    for (let i = 1; i <= 3; i++) {
      await syncStep(doc, async () => {
        await doc.applyOp(op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(i), prev: T(i - 1) }) as never);
        await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(1 + i)), SC);
      }, true);
    }
    expect(doc.ops).toHaveLength(1);
    expect((doc.ops[0] as RvCompositeOp).ops.map((o) => o.kind)).toEqual(['transformNode', 'replaceNodeGeometry']);
    expect(doc.document.coalesceStats).toEqual({ merged: 2, absorbed: 4 });
    // Memory: one displaced geometry held (the pre-sync original), nothing else.
    expect(doc.executor.stashStats.geometries).toBe(1);
    await doc.undo();
    expect(pos(f.slide)).toEqual([0, 0, 0]);
    expect(f.body.geometry).toBe(f.original);
    expect(doc.ops).toHaveLength(0);
    await doc.redo();
    expect(pos(f.slide)).toEqual([3, 0, 0]);
    expect(xRange(f.body.geometry)).toEqual([-2, 2]);
    doc.dispose();
  });

  it('sliding window: 6 steps at 250 ms stay one entry; a pause > windowMs starts a new one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    const { doc, executor } = stubDoc();
    const key = { key: 'solidcraft-sync:w', windowMs: 1000 };
    // 6 × 250 ms = 1.5 s in total: only a SLIDING window (anchored at the last
    // merged step) keeps this one entry; one anchored at the first would split.
    for (let i = 0; i < 6; i++) { vi.setSystemTime(10_000 + i * 250); await stubStep(doc, undefined, key); }
    expect(doc.opCount).toBe(1);
    expect(executor.released).toHaveLength(5);
    vi.setSystemTime(10_000 + 5 * 250 + 1001);
    await stubStep(doc, undefined, key);
    expect(doc.opCount).toBe(2);
    // Exactly at the window edge still merges.
    vi.setSystemTime(10_000 + 5 * 250 + 1001 + 1000);
    await stubStep(doc, undefined, key);
    expect(doc.opCount).toBe(2);
  });

  it('a WEB edit / undo / redo between two sync composites breaks the chain', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    const move = (x: number, prev: number) => op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(x), prev: T(prev) });
    await syncStep(doc, apply(doc, [move(1, 0)]), true);
    await doc.applyOp(op({ kind: 'transformNode', nodePath: 'Asset/Axis', transform: T(0, 7), prev: T(0) }) as never);
    await syncStep(doc, apply(doc, [move(2, 1)]), true);
    expect(doc.ops).toHaveLength(3);
    await doc.undo();
    expect(pos(f.slide)).toEqual([1, 0, 0]);
    expect(pos(f.axis)).toEqual([0, 7, 0]);

    // Undo + redo between two steps: the next step never amends an older entry.
    const g = fixture();
    const doc2 = scratchAssetDocument(g.viewer);
    await syncStep(doc2, apply(doc2, [move(1, 0)]), true);
    await doc2.undo();
    await doc2.redo();
    await syncStep(doc2, apply(doc2, [move(2, 1)]), true);
    expect(doc2.ops).toHaveLength(2);
    // Undo alone breaks it too (the next step lands on the entry below).
    await doc2.undo();
    await syncStep(doc2, apply(doc2, [move(5, 1)]), true);
    expect(doc2.ops).toHaveLength(2);
    expect((doc2.ops[0] as RvCompositeOp).ops).toHaveLength(1);
    doc.dispose();
    doc2.dispose();
  });

  it('save (markSaved) between two sync composites is not bridged; baseline ids never absorbed', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    await syncStep(doc, async () => { await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC); }, true);
    const saved = doc.ops[0] as RvCompositeOp;
    const savedJson = JSON.stringify(saved);
    await doc.markSaved(doc.base);
    expect(doc.dirty).toBe(false);
    await syncStep(doc, async () => { await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(3)), SC); }, true);
    expect(doc.ops).toHaveLength(2);
    expect(doc.dirty).toBe(true);
    expect(JSON.stringify(doc.ops[0])).toBe(savedJson); // the saved entry is untouched
    await doc.undo();
    expect(xRange(f.body.geometry)).toEqual([-1, 1]);
    expect(doc.dirty).toBe(false);

    // Same at the document level: the saved top keeps its identity and payload.
    const { doc: rv } = stubDoc();
    await stubStep(rv);
    rv.markSaved();
    const top = rv.ops[0];
    await stubStep(rv);
    expect(rv.opCount).toBe(2);
    expect(rv.ops[0]).toBe(top);
  });

  it('entries with journalId never merge; composites without coalesce never merge (regression)', async () => {
    const { doc } = stubDoc();
    await stubStep(doc, { meta: { journalId: 'j1' } });
    await stubStep(doc);
    expect(doc.opCount).toBe(2);
    await stubStep(doc);
    await stubStep(doc, { meta: { journalId: 'j2' } });
    expect(doc.opCount).toBe(3);

    const { doc: plain } = stubDoc();
    await plain.withTransaction('a', async () => { await plain.applyOp(tf(++stubX)); });
    await plain.withTransaction('b', async () => { await plain.applyOp(tf(++stubX)); });
    expect(plain.opCount).toBe(2);

    // A different key (a new session) never merges.
    const { doc: keys } = stubDoc();
    await stubStep(keys);
    await stubStep(keys, undefined, { key: 'solidcraft-sync:s2', windowMs: 60_000 });
    expect(keys.opCount).toBe(2);

    // A keyed transaction NESTED in an un-keyed one is the outer edit, not a sync step.
    const { doc: nested } = stubDoc();
    await stubStep(nested);
    await nested.withTransaction('outer', async () => { await stubStep(nested); });
    expect(nested.opCount).toBe(2);

    // A failed (rolled back) step records nothing and keeps the chain.
    const { doc: failing } = stubDoc();
    await stubStep(failing);
    await expect(failing.withTransaction('sync', async () => { await failing.applyOp(tf(++stubX)); throw new Error('parse'); }, { coalesce: KEY }))
      .rejects.toThrow('parse');
    await stubStep(failing);
    expect(failing.opCount).toBe(1);

    // replayOps (draft restore), restoreHistory and rollbackTo break the chain.
    const { doc: replay } = stubDoc();
    await stubStep(replay);
    await replay.replayOps([tf(++stubX)]);
    await stubStep(replay);
    expect(replay.opCount).toBe(3);
    const { doc: restore } = stubDoc();
    await stubStep(restore);
    restore.restoreHistory(restore.captureHistory());
    await stubStep(restore);
    expect(restore.opCount).toBe(2);
    const { doc: rollback } = stubDoc();
    await stubStep(rollback);
    await stubStep(rollback);
    expect(rollback.opCount).toBe(1);
    await rollback.withTransaction('x', async () => { await rollback.applyOp(tf(++stubX)); });
    await rollback.rollbackTo(1);
    await stubStep(rollback);
    expect(rollback.opCount).toBe(2);
  });

  it('structure run (createNode, rename with reference rewrite, reparentNode, deleteNode): ranges shifted correctly; apply/undo/redo/draft-replay equal to V0', async () => {
    const steps = (): RvOp[][] => [
      [op({ kind: 'createNode', nodePath: 'Asset/Body1', transform: T(0) }),
        op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(1), prev: T(0) })],
      [makeAssetComposite('Rename', [
        op({ kind: 'renameNode', nodePath: 'Asset/Axis', name: 'AxisB', prevName: 'Axis' }),
        op({ kind: 'setField', nodePath: 'Asset/Belt', componentType: 'TransportSurface', fieldName: 'DriveReference',
          value: ref('AxisB', DRIVE_T), prev: ref('Axis', DRIVE_T) }),
      ], { referenceRewrite: true }) as RvOp,
      op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(2), prev: T(1) })],
      [op({ kind: 'reparentNode', nodePath: 'Asset/Body1', newParentPath: 'Asset/Slide', transform: T(0),
        prevParentPath: 'Asset', prevIndex: 4, prevTransform: T(0) }),
      op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(3), prev: T(2) })],
      [op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(4), prev: T(3) })],
      [op({ kind: 'deleteNode', nodePath: 'Asset/Slide/Body1' }),
        op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(5), prev: T(4) })],
    ];
    const snap = (fx: Fx) => ({
      names: fx.model.children.map((c) => c.name),
      slideChildren: fx.slide.children.map((c) => c.name),
      slide: pos(fx.slide),
      axisName: fx.axis.name,
      refSame: fx.surface.DriveReference === fx.drive,
    });
    const run = async (keyed: boolean) => {
      const fx = fixture();
      const doc = scratchAssetDocument(fx.viewer);
      const states: Record<string, unknown> = {};
      for (const s of steps()) await syncStep(doc, apply(doc, s), keyed);
      states.apply = snap(fx);
      const entries = doc.ops.length;
      const log = JSON.parse(JSON.stringify(doc.ops));
      while (doc.document.canUndo()) await doc.undo();
      states.undo = snap(fx);
      while (doc.document.canRedo()) await doc.redo();
      states.redo = snap(fx);
      const gx = fixture();
      const doc2 = scratchAssetDocument(gx.viewer);
      await doc2.replayOps(log);
      states.replay = snap(gx);
      while (doc2.document.canUndo()) await doc2.undo();
      states.replayUndo = snap(gx);
      const entry = doc.ops[0] as RvCompositeOp;
      const stats = doc.document.coalesceStats;
      doc.dispose(); doc2.dispose();
      return { states, entries, entry, stats };
    };
    const v0 = await run(false);
    const v2 = await run(true);
    expect(v0.entries).toBe(5);
    expect(v2.entries).toBe(1);
    expect(v2.states).toEqual(v0.states);
    expect((v0.states.undo as { names: string[] }).names).toEqual(['Axis', 'Belt', 'Slide', 'Body']);
    expect((v0.states.apply as { refSame: boolean }).refSame).toBe(true);
    expect((v0.states.undo as { refSame: boolean }).refSame).toBe(true);
    expect(v2.entry.ops.map((o) => o.kind)).toEqual([
      'createNode', 'transformNode', 'renameNode', 'setField', 'transformNode',
      'reparentNode', 'transformNode', 'deleteNode', 'transformNode',
    ]);
    expect(referenceRewriteRangesOf(v2.entry)).toEqual([[2, 4]]);
    // Step 4 (pure motion) folded into step 3's transform; nothing else could fold.
    expect(v2.stats).toEqual({ merged: 4, absorbed: 1 });

    // Pure fold: a rewrite range in BOTH entries — the top's stays, next's moves.
    const rangeA = makeAssetComposite('a', [
      op({ kind: 'renameNode', nodePath: 'Asset/Axis', name: 'A1', prevName: 'Axis' }),
      op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(1), prev: T(0) }),
    ], { referenceRewriteRanges: [[0, 1]] });
    const rangeB = makeAssetComposite('b', [
      op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(2), prev: T(1) }),
      op({ kind: 'renameNode', nodePath: 'Asset/A1', name: 'A2', prevName: 'A1' }),
    ], { referenceRewriteRanges: [[1, 2]] });
    const fold = foldKeyedComposite(rangeA, rangeB)!;
    expect(fold.merged.ops.map((o) => o.kind)).toEqual(['renameNode', 'transformNode', 'renameNode']);
    expect(referenceRewriteRangesOf(fold.merged)).toEqual([[0, 1], [2, 3]]);
  });

  it('REAL replaceNodeGeometry: absorb -> undo -> redo; absorbed intermediate geometry + BVH disposed exactly once', async () => {
    const t = trackDisposal();
    try {
      const f = fixture();
      const doc = scratchAssetDocument(f.viewer);
      const installed: BufferGeometry[] = [];
      for (let i = 1; i <= 4; i++) {
        await syncStep(doc, async () => { await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(1 + i)), SC); }, true);
        installed.push(f.body.geometry);
      }
      const [g1, g2, g3, g4] = installed;
      expect(doc.ops).toHaveLength(1);
      // g1..g3 were intermediate: each disposed exactly once, BVH included.
      for (const g of [g1, g2, g3]) {
        expect(t.disposed(g)).toBe(1);
        expect(t.trees(g)).toBe(1);
      }
      expect(t.disposed(g4)).toBe(0);
      expect(t.disposed(f.original)).toBe(0);
      expect(doc.executor.stashStats.geometries).toBe(1);

      await doc.undo();
      expect(f.body.geometry).toBe(f.original);
      await doc.redo();
      expect(f.body.geometry).toBe(g4);
      await doc.undo();
      await doc.redo();
      doc.executor.flushTrash();
      doc.executor.flushTrash();
      for (const g of [g1, g2, g3]) expect(t.disposed(g)).toBe(1);
      expect(t.disposed(g4)).toBe(0); // live
      expect(t.disposed(f.original)).toBe(0); // not the op's to dispose
      doc.dispose();
    } finally { t.restore(); }
  });

  it('save -> undo of a replaceNodeGeometry materialises prevSha256 from cache; cache miss -> defined error', async () => {
    const f = fixture();
    const doc = scratchAssetDocument(f.viewer);
    await syncStep(doc, async () => { await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC); }, true);
    await syncStep(doc, async () => { await doc.replaceNodeGeometry('Asset/Body', await glbOf(box(3)), SC); }, true);
    expect(doc.ops).toHaveLength(1);
    await doc.markSaved(doc.base); // flushTrash: the original geometry object is gone from the stash
    expect(doc.executor.stashStats.geometries).toBe(0);
    await doc.undo();
    expect(f.body.geometry).not.toBe(f.original); // rebuilt…
    expect(xRange(f.body.geometry)).toEqual([-0.5, 0.5]); // …from the snapshot in the cache
    await doc.redo();
    expect(xRange(f.body.geometry)).toEqual([-1.5, 1.5]);

    await doc.markSaved(doc.base);
    await clearCadGlbCache();
    await expect(doc.undo()).rejects.toBeInstanceOf(CadGeometryUnavailableError);
    expect(doc.ops).toHaveLength(1);
    expect(xRange(f.body.geometry)).toEqual([-1.5, 1.5]);
    doc.dispose();
  });

  it('Drive on a moving node: folding transformNode/setField keeps Drive.Offset/home pose consistent (commutativity risk)', async () => {
    const steps = (): RvOp[][] => [1, 2, 3, 4].map((i) => [
      op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(i), prev: T(i - 1) }),
      op({ kind: 'setField', nodePath: 'Asset/Slide', componentType: 'Drive', fieldName: 'Offset', value: i * 10, prev: i === 1 ? undefined : (i - 1) * 10 }),
      op({ kind: 'setField', nodePath: 'Asset/Axis', componentType: 'Drive', fieldName: 'TargetSpeed', value: i * 100, prev: i === 1 ? undefined : (i - 1) * 100 }),
    ]);
    const snap = (fx: Fx) => ({
      slide: pos(fx.slide),
      offset: fx.slideDrive.Offset,
      axisSpeed: fx.drive.TargetSpeed,
      base: (fx.slideDrive as unknown as { basePosition?: { toArray(): number[] } }).basePosition?.toArray()
        .map((v) => Math.round(v * 1e6) / 1e6) ?? null,
    });
    const run = async (keyed: boolean) => {
      const fx = fixture();
      const doc = scratchAssetDocument(fx.viewer);
      for (const s of steps()) await syncStep(doc, apply(doc, s), keyed);
      const states: Record<string, unknown> = { apply: snap(fx) };
      const log = JSON.parse(JSON.stringify(doc.ops));
      while (doc.document.canUndo()) await doc.undo();
      states.undo = snap(fx);
      while (doc.document.canRedo()) await doc.redo();
      states.redo = snap(fx);
      const gx = fixture();
      const doc2 = scratchAssetDocument(gx.viewer);
      await doc2.replayOps(log);
      states.replay = snap(gx);
      const entry = doc.ops[0] as RvCompositeOp;
      doc.dispose(); doc2.dispose();
      return { states, entries: log.length, entry };
    };
    const v0 = await run(false);
    const v2 = await run(true);
    expect(v0.entries).toBe(4);
    expect(v2.entries).toBe(1);
    expect(v2.states).toEqual(v0.states);
    // The Axis setField commutes with everything on Slide and folds; the Slide
    // transform never jumps a Slide setField (a re-apply may move the node).
    const kinds = v2.entry.ops.map((o) => `${o.kind}:${(o as { nodePath?: string }).nodePath}`);
    expect(kinds.filter((k) => k === 'setField:Asset/Axis')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'transformNode:Asset/Slide').length).toBeGreaterThan(1);

    // Pure: replaceNodeGeometry never jumps a setField on its own node either
    // (collider / sensor bounds are measured from the geometry on re-apply).
    const a = makeAssetComposite('s1', [
      op({ kind: 'replaceNodeGeometry', nodePath: 'Asset/Body', sha256: 'b', prevSha256: 'a', quality: 'source', converter: SC }),
      op({ kind: 'setField', nodePath: 'Asset/Body', componentType: 'BoxCollider', fieldName: 'Size', value: 1, prev: 0 }),
    ]);
    const b = makeAssetComposite('s2', [
      op({ kind: 'replaceNodeGeometry', nodePath: 'Asset/Body', sha256: 'c', prevSha256: 'b', quality: 'source', converter: SC }),
    ]);
    expect(foldKeyedComposite(a, b)!.merged.ops).toHaveLength(3);
    // …while a transform of the same node does not block it.
    const c = makeAssetComposite('s3', [
      op({ kind: 'replaceNodeGeometry', nodePath: 'Asset/Body', sha256: 'b', prevSha256: 'a', quality: 'source', converter: SC }),
      op({ kind: 'transformNode', nodePath: 'Asset/Body', transform: T(1), prev: T(0) }),
    ]);
    const folded = foldKeyedComposite(c, b)!;
    expect(folded.merged.ops).toHaveLength(2);
    expect(folded.merged.ops[0]).toMatchObject({ sha256: 'c', prevSha256: 'a' });
    // Different cache namespaces are different targets.
    const d = makeAssetComposite('s4', [
      op({ kind: 'replaceNodeGeometry', nodePath: 'Asset/Body', sha256: 'z', prevSha256: 'b', quality: 'fine', converter: SC }),
    ]);
    expect(foldKeyedComposite(c, d)!.merged.ops).toHaveLength(3);
  });

  it('bound document (plan-711 undoViaRecompose) undoes a merged entry correctly', async () => {
    // A document projected into the scene and back: the merged sync entry is
    // asset-lineage, so from the scene projection it can only be undone by a
    // re-projection (reload the base, replay the log WITHOUT it).
    let fx = fixture();
    const viewer = new Proxy({}, {
      get: (_t, p) => (fx.viewer as unknown as Record<string | symbol, unknown>)[p],
    }) as unknown as typeof fx.viewer;
    const doc = new RvDocument({ id: 'bound', name: 'Bound', mode: 'asset', executor: new RvUnifiedExecutor(viewer, 'asset') });
    const move = (x: number, prev: number) => op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: T(x), prev: T(prev) });
    await doc.applyOp(op({ kind: 'transformNode', nodePath: 'Asset/Axis', transform: T(0, 7), prev: T(0) }));
    for (let i = 1; i <= 3; i++) {
      await doc.withTransaction('sync', async () => { await doc.applyOp(move(i, i - 1)); }, { coalesce: KEY });
    }
    expect(doc.opCount).toBe(2);
    const merged = doc.ops[1];
    expect(needsRecomposeToUndo(merged, 'asset')).toBe(false);

    doc.setProjection('scene');
    expect(needsRecomposeToUndo(merged, 'scene')).toBe(true);
    // The reload stands in for the scene bake of the log BELOW the entry: the
    // Axis edit is in those bytes (an asset op is not replayed into the scene
    // projection — `projectedOps` filters it), the merged entry is not.
    const outcome = await undoViaRecompose({
      doc,
      reload: async () => { fx = fixture(); fx.axis.position.set(0, 7, 0); fx.axis.updateMatrixWorld(true); },
    });
    expect(outcome.ok).toBe(true);
    expect(doc.opCount).toBe(1);
    expect(doc.redoBranch()).toEqual([merged]);
    expect(pos(fx.axis)).toEqual([0, 7, 0]);
    expect(pos(fx.slide)).toEqual([0, 0, 0]);

    doc.setProjection('asset');
    await doc.redo();
    expect(pos(fx.slide)).toEqual([3, 0, 0]);
    // The recompose broke the chain: a further step is its own entry.
    await doc.withTransaction('sync', async () => { await doc.applyOp(move(4, 3)); }, { coalesce: KEY });
    expect(doc.opCount).toBe(3);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. CAD-GLB cache converter
// ══════════════════════════════════════════════════════════════════════

const bytesOf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const textOf = (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);

describe('CAD-GLB cache converter (SOL #7)', () => {
  it("'solidcraft' entries are isolated from 'connect'/'browser'; legacy keys byte-identical", async () => {
    expect(cadGlbFileName('abc', 'source')).toBe('v2.abc.source.glb');
    expect(cadGlbFileName('abc', 'source', 'browser')).toBe('v2.abc.source.glb');
    expect(cadGlbFileName('abc', 'source', 'connect')).toBe('v2.abc.source.connect.glb');
    expect(cadGlbFileName('abc', 'source', 'solidcraft')).toBe('v2.abc.source.solidcraft.glb');
    const keys = new Set([
      await cadGlbOpfsKey('abc', 'source'),
      await cadGlbOpfsKey('abc', 'source', 'connect'),
      await cadGlbOpfsKey('abc', 'source', 'solidcraft'),
    ]);
    expect(keys.size).toBe(3);
    // No quality preset can forge the suffix (dots are sanitised).
    expect(cadGlbFileName('abc', 'source.solidcraft')).not.toBe(cadGlbFileName('abc', 'source', 'solidcraft'));

    await putCadGlb('shaS', 'source', bytesOf('BROWSER'));
    await putCadGlb('shaS', 'source', bytesOf('CONNECT'), 'connect');
    await putCadGlb('shaS', 'source', bytesOf('SOLIDCRAFT'), 'solidcraft');
    expect(textOf(await getCadGlb('shaS', 'source'))).toBe('BROWSER');
    expect(textOf(await getCadGlb('shaS', 'source', 'connect'))).toBe('CONNECT');
    expect(textOf(await getCadGlb('shaS', 'source', 'solidcraft'))).toBe('SOLIDCRAFT');
    await putCadGlb('shaT', 'source', bytesOf('ONLY-BROWSER'));
    expect(await getCadGlb('shaT', 'source', 'solidcraft')).toBeNull();
  });

  it('objectToGlb is deterministic for identical input (same SHA)', async () => {
    const a = await sha256Hex(await glbOf(box(2, 1)));
    const b = await sha256Hex(await glbOf(box(2, 1)));
    const c = await sha256Hex(await glbOf(box(2, 1.001)));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // …and so is the snapshot of a live node's geometry: two documents over the
    // same base record the same prevSha256.
    const f = fixture();
    const g = fixture();
    const d1 = scratchAssetDocument(f.viewer);
    const d2 = scratchAssetDocument(g.viewer);
    const r1 = await d1.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
    const r2 = await d2.replaceNodeGeometry('Asset/Body', await glbOf(box(2)), SC);
    expect(r1!.prevSha256).toBe(r2!.prevSha256);
    expect(r1!.sha256).toBe(r2!.sha256);
    d1.dispose(); d2.dispose();
  });
});
