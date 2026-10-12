// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.3 — the bake's SEGMENTS and the asset's NODE TABLE (step 1c).
 *
 * What the structure promises, and is asserted here on real `bake()` output:
 *
 *  - Items are ordered by the pre-order ordinal of a mesh's nearest SURVIVING
 *    ancestor-or-self (P1), so `segNode` is non-decreasing inside a chunk and
 *    the subtree of EVERY surviving node is one contiguous run of segments per
 *    chunk — which is exactly what one CSR row expresses.
 *  - The price the user agreed to (Q11): a PICK NODE's own window may be split
 *    into several, because a plain surviving subtree with a pick node of its own
 *    sits between two of its runs in pre-order. The window table is still
 *    correct — every window boundary is a segment boundary, so the in-segment
 *    Morton permutation cannot move a triangle across one.
 *  - plan-755 partition objects own no segments (§2.4a.9): they are created
 *    after the ordinals exist, so a segment's node is always a real node.
 *  - `bake()` resolves only when every chunk HAS a structure: a job the port
 *    cannot deliver at all rejects the bake and publishes nothing, while a dead
 *    worker is recovered from the chunk's re-staged arrays.
 */

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { registerCapabilities } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  RV_PARTITION_KEY,
  RV_SYNTHETIC_KEY,
  type BakedAsset,
  type BakedChunk,
} from '../src/core/engine/rv-bake-chunk';
import { bake } from '../src/core/engine/rv-bake-pipeline';
import {
  createPickBuildPort,
  type PickBuildEpoch,
  type PickBuildJob,
  type PickBuildJobResult,
  type PickBuildPort,
  type PickBuildResponse,
  type PickBuildWorkerPort,
} from '../src/core/engine/rv-pick-build-port';
import { handlePickBuildRequest } from '../src/core/engine/rv-pick-build-worker';
import { pickMemoryStats } from '../src/core/engine/rv-bake-registry';
import { isSegmentOnly, nodeTableBytes, pickStructureBytes } from '../src/core/engine/rv-pick-structure';
import { bakeTree, chunkByKey, group, inlinePickPort, uberMesh, withComponent } from './fixtures/bake-fixture';

// A pick-only test type, decoupled from any real component's role.
registerCapabilities('TestPickNT', { pick: 'select' });

const uber = new RVUberMaterial(false);

/** The segment that owns index entry `i` (= `faceIndex * 3`), or -1. */
function segmentOfIndex(pick: BakedChunk['pick'], i: number): number {
  for (let s = 0; s < pick.segmentCount; s++) {
    if (i >= pick.segIndexStart[s] && i < pick.segIndexStart[s] + pick.segIndexCount[s]) return s;
  }
  return -1;
}

/** Mark `node` with plan-755 partition labels (the ONE bake contract). */
function partition<T extends Object3D>(node: T, ...labels: string[]): T {
  node.userData[RV_PARTITION_KEY] = labels;
  return node;
}

/** The rows of `ordinal` in the CSR table. */
function rowsOf(asset: BakedAsset, ordinal: number): Array<{ chunk: number; first: number; last: number }> {
  const t = asset.nodeTable;
  const out: Array<{ chunk: number; first: number; last: number }> = [];
  for (let r = t.rowStart[ordinal]; r < t.rowStart[ordinal + 1]; r++) {
    out.push({ chunk: t.rowChunk[r], first: t.rowFirstSeg[r], last: t.rowLastSeg[r] });
  }
  return out;
}

/** Segment indices of `ordinal`'s SUBTREE inside chunk `ci`, read from scratch. */
function subtreeSegments(asset: BakedAsset, ordinal: number, ci: number): number[] {
  const end = asset.nodeTable.subtreeEnd[ordinal];
  const pick = asset.chunks[ci].pick;
  const out: number[] = [];
  for (let s = 0; s < pick.segmentCount; s++) {
    const n = pick.segNode[s];
    if (n >= ordinal && n <= end) out.push(s);
  }
  return out;
}

/**
 * Every invariant of §2.3 at once, for every surviving node and every chunk of
 * one baked asset. Called from each fixture below, so a new fixture cannot get
 * away with only the property it was written for.
 */
function assertTableConsistent(asset: BakedAsset): void {
  const t = asset.nodeTable;
  expect(t.chunks).toEqual(asset.chunks);
  expect(t.rowStart).toHaveLength(t.nodes.length + 1);
  expect(t.subtreeEnd).toHaveLength(t.nodes.length);
  expect(t.rowStart[t.nodes.length]).toBe(t.rowChunk.length);

  for (const chunk of asset.chunks) {
    // Every chunk has a structure — there is no "pending" state (F1).
    expect(chunk.pick, chunk.key).toBeTruthy();
    expect(chunk.pick.triangleCount).toBe(chunk.triangles);
    expect(chunk.pick.blocks).toBe(chunk.blocks);
    const pick = chunk.pick;
    // Segments: sorted by indexStart, tiling the chunk, ordinals non-decreasing
    // (== pre-order), every node ordinal a REAL surviving node.
    let cursor = 0;
    let lastNode = -1;
    for (let s = 0; s < pick.segmentCount; s++) {
      expect(pick.segIndexStart[s], `${chunk.key} seg ${s}`).toBe(cursor);
      expect(pick.segIndexCount[s] % 3).toBe(0);
      expect(pick.segIndexCount[s]).toBeGreaterThan(0);
      cursor += pick.segIndexCount[s];
      expect(pick.segNode[s], `${chunk.key} seg ${s} ordinal order`).toBeGreaterThanOrEqual(lastNode);
      lastNode = pick.segNode[s];
      expect(pick.segNode[s]).toBeLessThan(t.nodes.length);
      const owner = pick.segOwner[s];
      expect(owner === -1 || owner < t.nodes.length).toBe(true);
      // The owner is an ancestor-or-self of the segment node.
      if (owner >= 0) {
        expect(owner).toBeLessThanOrEqual(pick.segNode[s]);
        expect(t.subtreeEnd[owner]).toBeGreaterThanOrEqual(pick.segNode[s]);
      }
    }
    expect(cursor).toBe(chunk.geometry.index!.count);
  }

  for (let n = 0; n < t.nodes.length; n++) {
    const rows = rowsOf(asset, n);
    // At most ONE range per chunk (§9.3).
    expect(new Set(rows.map((r) => r.chunk)).size, `node ${n}`).toBe(rows.length);
    const rowByChunk = new Map(rows.map((r) => [r.chunk, r]));
    for (let ci = 0; ci < asset.chunks.length; ci++) {
      const expected = subtreeSegments(asset, n, ci);
      const row = rowByChunk.get(ci);
      if (expected.length === 0) {
        expect(row, `node ${n} chunk ${ci} must have no row`).toBeUndefined();
        continue;
      }
      expect(row, `node ${n} chunk ${ci} must have a row`).toBeDefined();
      // The interval IS the union of the descendants' segments — and it is
      // contiguous, which is the whole point of the pre-order ordering.
      expect(row!.first).toBe(expected[0]);
      expect(row!.last).toBe(expected[expected.length - 1]);
      expect(row!.last - row!.first + 1).toBe(expected.length);
    }
  }
}

/** Ordinal of a template node (must exist). */
function ordinal(asset: BakedAsset, node: Object3D): number {
  const o = asset.nodeTable.ordinalOf.get(node);
  expect(o, `${node.name} has no ordinal`).toBeDefined();
  return o!;
}

/** The template node named `name`. */
function node(asset: BakedAsset, name: string): Object3D {
  let found: Object3D | null = null;
  asset.template.traverse((n) => { if (!found && n.name === name) found = n; });
  if (!found) throw new Error(`node "${name}" did not survive the bake`);
  return found;
}

describe('bake segments + node table (plan-756 §9.3)', () => {
  it('a plain surviving group under a pickable assembly: subtree contiguous, the ASSEMBLY window splits (P1/Q11)', async () => {
    // A(pick) { mA1, G1 { mG1, P(pick) { mP } }, G2 { mG2 } }
    // Pre-order ordinals: root 0, A 1, G1 2, P 3, G2 4.
    // Segment order = 1, 2, 3, 4 — so A's own window (segments of A, G1 and G2,
    // all owned by A) is interrupted by P's segment: TWO windows for A.
    const root = group('Asset');
    const a = withComponent(group('A'), 'TestPickNT');
    const g1 = group('G1');
    const p = withComponent(group('P'), 'TestPickNT');
    const g2 = group('G2');
    a.add(uberMesh(uber, 'mA1', [0, 0, 0]));
    g1.add(uberMesh(uber, 'mG1', [2, 0, 0]));
    p.add(uberMesh(uber, 'mP', [4, 0, 0]));
    g1.add(p);
    a.add(g1);
    g2.add(uberMesh(uber, 'mG2', [6, 0, 0]));
    a.add(g2);
    root.add(a);

    const survivors = new Set<Object3D>([g1, g2]);
    const asset = await bakeTree(root, { uber, destructive: true, survives: (n) => survivors.has(n) });
    assertTableConsistent(asset);

    const tA = node(asset, 'A');
    const tG1 = node(asset, 'G1');
    const tG2 = node(asset, 'G2');
    const tP = node(asset, 'P');
    expect(ordinal(asset, asset.template)).toBe(0);
    expect([ordinal(asset, tA), ordinal(asset, tG1), ordinal(asset, tP), ordinal(asset, tG2)]).toEqual([1, 2, 3, 4]);

    const chunk = chunkByKey(asset, 'static');
    // Four segments, in pre-order; the three owned by A carry A as owner.
    expect([...chunk.pick.segNode]).toEqual([1, 2, 3, 4]);
    expect([...chunk.pick.segOwner]).toEqual([1, 1, 3, 1]);

    // THE P1 consequence: A OWNS three non-contiguous segments (1, 2 and 4 in
    // index order), P owns the one between them, and every triangle still
    // resolves — the owner is an attribute of the SEGMENT, so nothing needs a
    // pick node's own triangles to be contiguous (plan-756 P1/Q11; step 1d
    // deleted the window table this used to assert through `bsearchNode`).
    const ownedByA = [...chunk.pick.segOwner].filter((o) => o === ordinal(asset, tA));
    expect(ownedByA).toHaveLength(3);
    expect([...chunk.pick.segOwner].filter((o) => o === ordinal(asset, tP))).toHaveLength(1);
    let covered = 0;
    for (let s = 0; s < chunk.pick.segmentCount; s++) covered += chunk.pick.segIndexCount[s];
    expect(covered).toBe(chunk.geometry.index!.count);
    for (let f = 0; f < chunk.triangles; f++) {
      const s = segmentOfIndex(chunk.pick, f * 3);
      expect(s, `face ${f}`).toBeGreaterThanOrEqual(0);
      const owner = asset.nodeTable.nodes[chunk.pick.segOwner[s]];
      expect(owner === tA || owner === tP).toBe(true);
    }

    // G1's subtree (mG1 + mP) is ONE interval although the two meshes have
    // different pick owners — the table is about geometry, not about picking.
    const rowsG1 = rowsOf(asset, ordinal(asset, tG1));
    expect(rowsG1).toEqual([{ chunk: 0, first: 1, last: 2 }]);
    expect(rowsOf(asset, ordinal(asset, tG2))).toEqual([{ chunk: 0, first: 3, last: 3 }]);
    // The root covers everything.
    expect(rowsOf(asset, 0)).toEqual([{ chunk: 0, first: 0, last: 3 }]);
  });

  it('a partition object owns no segments; a real node across two partition chunks gets one row per chunk', async () => {
    const root = group('Asset');
    const part = withComponent(group('Part'), 'TestPickNT');
    part.add(partition(uberMesh(uber, 'inA', [0, 0, 0]), 'A'));
    part.add(partition(uberMesh(uber, 'inB', [2, 0, 0]), 'B'));
    root.add(part);

    const asset = await bakeTree(root, { uber, destructive: true });
    assertTableConsistent(asset);
    expect(asset.chunks.map((c) => c.partition).sort()).toEqual(['A', 'B']);

    // The synthetic partition objects exist in the template but have NO ordinal:
    // they were created after the ordinals, so no segment can name them (§2.4a.9).
    const synthetic: Object3D[] = [];
    asset.template.traverse((n) => { if (n.userData?.[RV_SYNTHETIC_KEY] === true) synthetic.push(n); });
    expect(synthetic).toHaveLength(2);
    for (const s of synthetic) expect(asset.nodeTable.ordinalOf.get(s)).toBeUndefined();

    // The REAL node's subtree spreads over both partition chunks → one row each.
    const rows = rowsOf(asset, ordinal(asset, node(asset, 'Part')));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.chunk).sort()).toEqual([0, 1]);
    for (const r of rows) expect(r).toMatchObject({ first: 0, last: 0 });
  });

  it('movers, keep meshes and a catch-all owner: every chunk has a structure and every row is exact', async () => {
    const root = group('Asset');
    const drive = withComponent(group('D'), 'Drive');
    drive.add(uberMesh(uber, 'arm'));
    const inner = withComponent(group('Meta'), 'TestPickNT');
    inner.add(uberMesh(uber, 'plate', [1, 0, 0]));
    drive.add(inner);
    root.add(drive);
    root.add(uberMesh(uber, 'loose', [9, 0, 0]));           // no pick ancestor
    const lamp = withComponent(group('Lamp'), 'Lamp');      // keep mesh
    lamp.add(uberMesh(uber, 'bulb', [12, 0, 0]));
    root.add(lamp);

    const asset = await bakeTree(root, { uber, destructive: true });
    assertTableConsistent(asset);
    expect(asset.chunks).toHaveLength(2);
    expect(asset.keep).toHaveLength(1);
    // The static chunk's only segment has no pick owner and an OPAQUE material,
    // so it blocks (plan Q5) — the uber material is not transparent.
    const staticChunk = chunkByKey(asset, 'static');
    expect(staticChunk.blocks).toBe(true);
    // plan-756 step 1d (Q5): the catch-all is UNOWNED (-1), not "owned by the
    // root" — that is precisely what lets an opaque chunk block instead of
    // resolving a merged-away part to the asset root.
    expect([...staticChunk.pick.segOwner]).toEqual([-1]);
    // The mover chunk's owner is the drive; the inner pick node owns its own run.
    const mover = chunkByKey(asset, 'mover:D');
    const tDrive = node(asset, 'D');
    const tMeta = node(asset, 'Meta');
    expect([...mover.pick.segOwner]).toEqual([ordinal(asset, tDrive), ordinal(asset, tMeta)]);
    expect(rowsOf(asset, ordinal(asset, tMeta))).toEqual([
      { chunk: asset.chunks.indexOf(mover), first: 1, last: 1 },
    ]);
  });

  // plan-756 §1 NFR "Memory": the gate is read off ONE percentage, and that
  // percentage has to exist for the MAIN MODEL — `web_status.bake` reported the
  // bytes only for planner placements, which is all zeros in HMI mode.
  it('pickMemoryStats reports bytes, segments, clusters and the gate percentage of an asset', async () => {
    const root = group('Asset');
    const drive = withComponent(group('D'), 'Drive');
    drive.add(uberMesh(uber, 'arm'));
    root.add(drive);
    root.add(uberMesh(uber, 'loose', [9, 0, 0]));

    const asset = await bakeTree(root, { uber, destructive: true });
    const stats = pickMemoryStats([asset]);

    // Sums over the chunks, not a re-derivation: the numbers a report shows
    // must be the numbers the structure actually carries.
    expect(stats.segments).toBe(asset.chunks.reduce((n, c) => n + c.pick.segmentCount, 0));
    expect(stats.clusters).toBe(asset.chunks.reduce((n, c) => n + c.pick.clusterCount, 0));
    expect(stats.segments).toBeGreaterThan(0);
    expect(stats.clusters).toBeGreaterThan(0);
    expect(stats.pickBytes).toBe(asset.chunks.reduce((n, c) => n + pickStructureBytes(c.pick), 0));
    expect(stats.nodeTableBytes).toBe(nodeTableBytes(asset.nodeTable));
    expect(stats.nodeTableRows).toBe(asset.nodeTable.rowChunk.length);

    // The denominator is position + index of every DISTINCT chunk geometry.
    const expectedGeometry = asset.chunks.reduce((n, c) => n
      + (c.geometry.getAttribute('position')!.array.byteLength)
      + (c.geometry.index!.array.byteLength), 0);
    expect(stats.geometryBytes).toBe(expectedGeometry);
    expect(stats.pickPercent).toBeCloseTo(
      Math.round(((stats.pickBytes + stats.nodeTableBytes) / stats.geometryBytes) * 10000) / 100, 10);
    // Two decimals, never more — the gate is read as a printed number.
    expect(stats.pickPercent).toBe(Math.round(stats.pickPercent * 100) / 100);

    // Listing one asset twice must not double any of it.
    expect(pickMemoryStats([asset, asset])).toEqual(stats);
    // Nothing baked → a defined zero, never a division by zero.
    expect(pickMemoryStats([])).toMatchObject({ pickBytes: 0, geometryBytes: 0, pickPercent: 0 });
  });

  it('a transparent chunk material does not block (plan Q5)', async () => {
    const root = group('Asset');
    const glass = uberMesh(uber, 'glass');
    // A textured (non-uber) material of its own, transparent.
    const { MeshStandardMaterial } = await import('three');
    glass.material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    glass.userData._rvUberBaked = false;
    root.add(glass);

    const asset = await bakeTree(root, { uber, destructive: true });
    assertTableConsistent(asset);
    expect(asset.chunks).toHaveLength(1);
    expect(asset.chunks[0].blocks).toBe(false);
    expect(asset.chunks[0].pick.blocks).toBe(false);
  });

  // ── the gated await: failure and recovery (§2.4a.8, risk R12) ──────

  /** A port whose every build rejects — the "cannot be delivered at all" case. */
  function failingPort(): PickBuildPort {
    const epoch: PickBuildEpoch = {
      id: 1,
      stale: false,
      build: (job: PickBuildJob) => Promise.reject(new Error(`pick build of chunk "${job.key}" failed`)),
      abort: () => { /* nothing queued */ },
    };
    return {
      size: 1,
      usesWorker: false,
      stats: { workerJobs: 0, inlineJobs: 0, retries: 0, retiredWorkers: 0, maxInlineSliceMs: 0 },
      beginEpoch: () => epoch,
      build: (job) => epoch.build(job) as Promise<PickBuildJobResult>,
      dispose: () => { /* nothing to dispose */ },
    };
  }

  function makeAsset(): Object3D {
    const root = group('Machine');
    root.add(uberMesh(uber, 'frame'));
    const d = withComponent(group('Drive-A'), 'Drive');
    d.add(uberMesh(uber, 'arm', [1, 0, 0]));
    root.add(d);
    return root;
  }

  // plan-757 Phase 3 commit B: a build that rejects in worker AND inline is no
  // longer a bake failure — the chunk is re-staged and published SEGMENT-ONLY
  // (owners, occlusion and node table intact, no cluster tree) and a warning
  // names the chunk key. The load-level twin lives in bake-failure-is-load-error.
  it('a pick build that cannot be delivered publishes the chunk segment-only and warns with the chunk key', async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
    let asset: BakedAsset;
    try {
      asset = await bake(makeAsset(), {
        assetId: 'reject-test',
        uberMaterial: uber,
        destructive: true,
        pickPort: failingPort(),
      });
    } finally {
      warn.mockRestore();
    }
    expect(asset.chunks.length).toBeGreaterThan(0);
    for (const c of asset.chunks) {
      expect(isSegmentOnly(c.pick)).toBe(true);
      expect(warnings.some((w) => w.includes(`chunk "${c.key}"`) && w.includes('segment-only'))).toBe(true);
    }
    assertTableConsistent(asset);
  });

  it('a worker that dies with the buffers is recovered from the re-staged chunk — bake() still resolves', async () => {
    // One transport that raises a worker-level error on its first job; the pool
    // retires it, re-stages that chunk through the job's restage() and builds it
    // inline. Every later job runs inline too (the pool has no worker left).
    let raised = false;
    const create = (): PickBuildWorkerPort => {
      let onMessage: ((m: PickBuildResponse) => void) | null = null;
      let onError: ((reason: unknown) => void) | null = null;
      return {
        postMessage: (message) => {
          if (!raised) {
            raised = true;
            // A dead worker takes the transferred buffers with it.
            setTimeout(() => onError?.(new Error('worker died')), 0);
            return;
          }
          const { response } = handlePickBuildRequest(message);
          setTimeout(() => onMessage?.(response), 0);
        },
        onMessage: (cb) => { onMessage = cb; },
        onError: (cb) => { onError = cb; },
        terminate: () => { /* nothing */ },
      };
    };
    const port = createPickBuildPort({ createWorker: create, size: 1 });
    const asset = await bake(makeAsset(), {
      assetId: 'restage-test',
      uberMaterial: uber,
      destructive: true,
      pickPort: port,
    });
    expect(raised).toBe(true);
    expect(port.stats.retries).toBe(1);
    expect(port.stats.retiredWorkers).toBe(1);
    expect(asset.chunks).toHaveLength(2);
    assertTableConsistent(asset);
    port.dispose();
  });

  it('an empty asset still gets a (trivial) node table', async () => {
    const asset = await bake(group('Empty'), {
      assetId: 'empty-test',
      uberMaterial: uber,
      destructive: true,
      pickPort: inlinePickPort(),
    });
    expect(asset.chunks).toEqual([]);
    expect(asset.nodeTable.nodes).toEqual([asset.template]);
    expect(asset.nodeTable.rowChunk).toHaveLength(0);
    expect([...asset.nodeTable.subtreeEnd]).toEqual([0]);
  });
});

/** Narrow the chunk type once so the helpers above stay readable. */
export type _ChunkRef = BakedChunk;
