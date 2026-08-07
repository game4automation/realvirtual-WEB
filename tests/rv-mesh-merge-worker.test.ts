// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mesh merger — worker path and the Phase 4 benchmark (plan-372 section 9: test 9.21).
 *
 * The benchmark is not decoration: plan-372 set the peak-memory budget at 2.5× the sum
 * of the source attribute buffers WITHOUT measuring it. The two cases below measure it,
 * at the 200k and 1M vertex sizes the NFR names, and print the numbers.
 */

import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';
import {
  buildMergedGeometry,
  type MergeRequest,
  type MergeResponse,
} from '../src/core/editor/rv-mesh-merge';
import { triangleCount as triangleCountOf } from '../src/core/editor/rv-mesh-separator';
import { handleMergeRequest } from '../src/core/editor/rv-mesh-merge-worker';
import {
  RVMeshMergeClient,
  isMeshMergeAbort,
  type MeshMergeJob,
  type MeshMergePort,
} from '../src/core/editor/rv-mesh-merge-client';

function triangleGeometry(offset = 0): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return geom;
}

/**
 * A port that runs the real worker body OFF the caller's stack.
 *
 * The work happens inside the microtask, not inside `postMessage` — otherwise every
 * "main-thread submit" measurement below would silently include the whole merge.
 */
function fakePort(sink?: { requests: MergeRequest[] }): MeshMergePort {
  let handler: ((message: MergeResponse) => void) | null = null;
  return {
    postMessage(message: MergeRequest) {
      sink?.requests.push(message);
      queueMicrotask(() => {
        const { response } = handleMergeRequest(message);
        handler?.(response);
      });
    },
    terminate() { handler = null; },
    onMessage(cb) { handler = cb; },
  };
}

function job(offsets: number[]): MeshMergeJob {
  return {
    sources: offsets.map((o) => ({ geometry: triangleGeometry(o), worldMatrix: new Matrix4() })),
    ownerWorld: new Matrix4(),
  };
}

// ─── 9.21 — worker parity, abort, buffer safety ─────────────────────────

describe('9.21 worker parity, abort and buffer safety', () => {
  it('produces exactly the same geometry as the synchronous fallback', async () => {
    const viaWorker = new RVMeshMergeClient({ createPort: () => fakePort() });
    const viaFallback = new RVMeshMergeClient({ createPort: () => null });
    expect(viaWorker.usesWorker).toBe(true);
    expect(viaFallback.usesWorker).toBe(false);

    const [a] = await viaWorker.merge([job([0, 5])]);
    const [b] = await viaFallback.merge([job([0, 5])]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Array.from(a!.getAttribute('position').array as Float32Array))
      .toEqual(Array.from(b!.getAttribute('position').array as Float32Array));
    expect(triangleCountOf(a!)).toBe(2);
    viaWorker.dispose();
    viaFallback.dispose();
  });

  it('returns null for an output without sources (the empty carrier)', async () => {
    const client = new RVMeshMergeClient({ createPort: () => null });
    const parts = await client.merge([{ sources: [], ownerWorld: new Matrix4() }, job([0, 5])]);
    expect(parts[0]).toBeNull();
    expect(parts[1]).not.toBeNull();
    client.dispose();
  });

  it('bakes each job into its OWN owner space', async () => {
    const client = new RVMeshMergeClient({ createPort: () => fakePort() });
    const shifted = new Matrix4().makeTranslation(100, 0, 0);
    const [inRoot, inAnchor] = await client.merge([
      { sources: [{ geometry: triangleGeometry(0), worldMatrix: new Matrix4() }, { geometry: triangleGeometry(5), worldMatrix: new Matrix4() }], ownerWorld: new Matrix4() },
      { sources: [{ geometry: triangleGeometry(0), worldMatrix: new Matrix4() }, { geometry: triangleGeometry(5), worldMatrix: new Matrix4() }], ownerWorld: shifted },
    ]);
    // Same world geometry, different owner → the anchor copy sits 100 units back.
    expect(inRoot!.getAttribute('position').getX(0)).toBeCloseTo(0, 5);
    expect(inAnchor!.getAttribute('position').getX(0)).toBeCloseTo(-100, 5);
    client.dispose();
  });

  it('drops a superseded response instead of applying it', async () => {
    const client = new RVMeshMergeClient({ createPort: () => fakePort() });
    const first = client.merge([job([0, 5])]);
    const second = client.merge([job([0, 5, 10])]);
    await expect(first).rejects.toSatisfy(isMeshMergeAbort);
    const [merged] = await second;
    expect(triangleCountOf(merged!)).toBe(3);
    client.dispose();
  });

  it('never detaches the LIVE source buffers, and transfers no buffer twice', async () => {
    const sink = { requests: [] as MergeRequest[] };
    const client = new RVMeshMergeClient({ createPort: () => fakePort(sink) });
    const live = triangleGeometry(0);
    // The same geometry twice — a shared BufferGeometry must not be serialized twice
    // under the same transform, or the transfer list would carry one buffer twice.
    await client.merge([{
      sources: [
        { geometry: live, worldMatrix: new Matrix4() },
        { geometry: live, worldMatrix: new Matrix4() },
        { geometry: triangleGeometry(5), worldMatrix: new Matrix4() },
      ],
      ownerWorld: new Matrix4(),
    }]);

    expect(Array.from(live.getAttribute('position').array as Float32Array))
      .toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const request = sink.requests[0];
    expect(request.sources).toHaveLength(2); // deduped
    expect(request.outputs[0].sourceIndices).toEqual([0, 0, 1]);
    const buffers = new Set<ArrayBuffer>();
    for (const source of request.sources) {
      for (const name of Object.keys(source.attributes)) {
        const buffer = source.attributes[name].array.buffer as ArrayBuffer;
        expect(buffers.has(buffer)).toBe(false);
        buffers.add(buffer);
      }
    }
    client.dispose();
  });

  it('reports a merge failure as a rejection, not a null geometry', async () => {
    const client = new RVMeshMergeClient({ createPort: () => null });
    const withTangent = triangleGeometry(0);
    withTangent.setAttribute('tangent', new BufferAttribute(new Float32Array(12), 4));
    await expect(client.merge([{
      sources: [
        { geometry: withTangent, worldMatrix: new Matrix4() },
        { geometry: triangleGeometry(5), worldMatrix: new Matrix4() },
      ],
      ownerWorld: new Matrix4(),
    }])).rejects.toThrow(/cannot be reconstructed/);
    client.dispose();
  });

  it('a disposed client refuses new work', async () => {
    const client = new RVMeshMergeClient({ createPort: () => null });
    client.dispose();
    await expect(client.merge([job([0, 5])])).rejects.toSatisfy(isMeshMergeAbort);
  });
});

// ─── Phase 4 benchmark ──────────────────────────────────────────────────

describe('merge benchmark (plan-372 Phase 4)', () => {
  /** `vertexCount` vertices of independent triangles: position + normal, indexed. */
  function bigGeometry(vertexCount: number, offset: number): BufferGeometry {
    const tris = Math.floor(vertexCount / 3);
    const pos = new Float32Array(tris * 9);
    const nrm = new Float32Array(tris * 9);
    for (let t = 0; t < tris; t++) {
      const o = t * 9;
      const x = offset + t * 0.001;
      pos[o] = x; pos[o + 3] = x + 0.5; pos[o + 6] = x;
      pos[o + 7] = 1;
      nrm[o + 2] = 1; nrm[o + 5] = 1; nrm[o + 8] = 1;
    }
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(pos, 3));
    geom.setAttribute('normal', new BufferAttribute(nrm, 3));
    const idx = new Uint32Array(tris * 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    geom.setIndex(new BufferAttribute(idx, 1));
    return geom;
  }

  function bytesOf(geom: BufferGeometry): number {
    let total = 0;
    for (const name of Object.keys(geom.attributes)) {
      total += (geom.attributes[name] as BufferAttribute).array.byteLength;
    }
    if (geom.index) total += geom.index.array.byteLength;
    return total;
  }

  for (const total of [200_000, 1_000_000]) {
    it(`stays inside the 2.5x peak-buffer budget at ${total} vertices`, async () => {
      const parts = 4;
      const per = Math.floor(total / parts);
      const geometries = Array.from({ length: parts }, (_, i) => bigGeometry(per, i * 1000));
      const sourceBytes = geometries.reduce((n, g) => n + bytesOf(g), 0);

      // What a MAIN-THREAD merge of the same work costs — the number the worker removes.
      const syncStart = performance.now();
      const syncMerged = buildMergedGeometry(
        geometries.map((geometry) => ({ geometry, worldMatrix: new Matrix4() })),
        new Matrix4(),
      );
      const syncMs = performance.now() - syncStart;
      const mergedBytes = bytesOf(syncMerged);
      syncMerged.dispose();

      const client = new RVMeshMergeClient({ createPort: () => fakePort() });
      const submitStart = performance.now();
      const promise = client.merge([{
        sources: geometries.map((geometry) => ({ geometry, worldMatrix: new Matrix4() })),
        ownerWorld: new Matrix4(),
      }]);
      // The synchronous half the NFR allows: traversal plus the tight attribute copy.
      const submitMs = performance.now() - submitStart;
      const [merged] = await promise;
      expect(merged).not.toBeNull();
      expect(triangleCountOf(merged!)).toBe(Math.floor(per / 3) * parts);

      // Peak of the worker pipeline: the deserialized sources (baked IN PLACE, so no
      // third copy) plus the merged result.
      const peakBytes = sourceBytes + mergedBytes;
      const ratio = peakBytes / sourceBytes;
      // eslint-disable-next-line no-console
      console.log(
        `[merge-bench] ${total} vertices | sources ${(sourceBytes / 1e6).toFixed(1)} MB, ` +
        `merged ${(mergedBytes / 1e6).toFixed(1)} MB, peak ${ratio.toFixed(2)}x | ` +
        `main-thread merge ${syncMs.toFixed(1)} ms, worker submit ${submitMs.toFixed(1)} ms`,
      );
      expect(ratio).toBeLessThanOrEqual(2.5);

      client.dispose();
      merged!.dispose();
      for (const geom of geometries) geom.dispose();
    });
  }
});
