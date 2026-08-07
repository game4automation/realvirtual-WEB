// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-merge-port.test.ts — plan-274 9.2: port behavior.
 *
 *   - strict sequential queue per port instance
 *   - registry empty → InlineMergePort (public build, F3)
 *   - ABI version mismatch → inline + console.warn
 *   - kill-switch rv.merge.wasm (pattern: usd-provider.test.ts)
 *   - matching provider is used; provider createPort() failure → inline
 *   - inline port yields to macrotasks between chunks
 *   - dispose during in-flight merge does not reject callers
 *   - inline merge compute: transform bake, index rebase, group split
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Matrix4 } from 'three';
import {
  createMeshMergePort,
  createInlineMergePort,
  isMeshMergeWasmEnabled,
  meshMergeRegistry,
  mergeBatchInline,
  MESH_MERGE_ABI_VERSION,
  MESH_MERGE_WASM_FLAG_KEY,
  type MergeBatch,
  type MergedChunks,
  type MeshMergePort,
  type MeshDescriptor,
} from '../src/core/engine/rv-mesh-merge-port';

// ─── Batch helpers (hand-built canonical payloads) ──────────────────────

/** A minimal single-triangle descriptor + payload builder. */
function makeBatch(opts?: {
  meshCount?: number;
  chunkVertexBudget?: number;
  groupIds?: number[];
  groupInverses?: Matrix4[];
  worldMatrices?: Matrix4[];
  keepIndexed?: boolean;
}): MergeBatch {
  const meshCount = opts?.meshCount ?? 2;
  const keepIndexed = opts?.keepIndexed ?? true;
  const groupIds = opts?.groupIds ?? new Array(meshCount).fill(0);
  const inverses = opts?.groupInverses ?? [new Matrix4()];
  const vertsPer = 3;
  const position = new Float32Array(meshCount * vertsPer * 3);
  const normal = new Float32Array(meshCount * vertsPer * 3);
  for (let m = 0; m < meshCount; m++) {
    for (let v = 0; v < vertsPer; v++) {
      const o = (m * vertsPer + v) * 3;
      position[o] = m * 10 + v;
      position[o + 1] = v === 2 ? 1 : 0;
      position[o + 2] = 0;
      normal[o + 2] = 1;
    }
  }
  const index = keepIndexed ? new Uint32Array(meshCount * 3) : null;
  if (index) {
    for (let m = 0; m < meshCount; m++) index.set([0, 1, 2], m * 3);
  }
  const descriptors: MeshDescriptor[] = [];
  for (let m = 0; m < meshCount; m++) {
    descriptors.push({
      vertexCount: vertsPer,
      indexCount: keepIndexed ? 3 : 0,
      hasNormal: true,
      hasColor: false,
      hasRm: false,
      groupId: groupIds[m],
      worldMatrix: Float32Array.from((opts?.worldMatrices?.[m] ?? new Matrix4()).elements),
    });
  }
  const groupCount = Math.max(...groupIds) + 1;
  const groupTable = new Float32Array(groupCount * 16);
  for (let g = 0; g < groupCount; g++) {
    (inverses[g] ?? new Matrix4()).toArray(groupTable, g * 16);
  }
  return {
    keepIndexed,
    chunkVertexBudget: opts?.chunkVertexBudget ?? 500_000,
    groupCount,
    groupInverses: groupTable,
    descriptors,
    position,
    normal,
    color: null,
    rmPacked: null,
    index,
  };
}

beforeEach(() => {
  localStorage.clear();
  meshMergeRegistry.register(null);
});

afterEach(() => {
  meshMergeRegistry.register(null);
});

// ─── Kill-switch ────────────────────────────────────────────────────────

describe('kill-switch rv.merge.wasm (F4)', () => {
  it('is ON by default', () => {
    expect(isMeshMergeWasmEnabled()).toBe(true);
  });

  it('is disabled by off/false/0', () => {
    for (const v of ['off', 'false', '0']) {
      localStorage.setItem(MESH_MERGE_WASM_FLAG_KEY, v);
      expect(isMeshMergeWasmEnabled()).toBe(false);
    }
    localStorage.setItem(MESH_MERGE_WASM_FLAG_KEY, 'on');
    expect(isMeshMergeWasmEnabled()).toBe(true);
  });

  it('forces the inline port even when a valid provider is registered', () => {
    const providerPort: MeshMergePort = {
      path: 'wasm',
      merge: () => Promise.resolve({ chunks: [], totalVertices: 0 }),
      dispose: () => {},
    };
    meshMergeRegistry.register({ abiVersion: MESH_MERGE_ABI_VERSION, createPort: () => providerPort });
    localStorage.setItem(MESH_MERGE_WASM_FLAG_KEY, 'off');
    const port = createMeshMergePort();
    expect(port).not.toBe(providerPort);
    expect(port.path).toBe('js');
  });
});

// ─── Port creation / registry ───────────────────────────────────────────

describe('createMeshMergePort resolution', () => {
  it('returns the inline port when meshMergeRegistry is empty (public build, F3)', () => {
    const port = createMeshMergePort();
    expect(port.path).toBe('js');
  });

  it('uses the factory test seam verbatim', () => {
    const mock: MeshMergePort = {
      path: 'mock',
      merge: () => Promise.resolve({ chunks: [], totalVertices: 0 }),
      dispose: () => {},
    };
    expect(createMeshMergePort(() => mock)).toBe(mock);
  });

  it('uses a registered provider with matching ABI version', () => {
    const providerPort: MeshMergePort = {
      path: 'wasm',
      merge: () => Promise.resolve({ chunks: [], totalVertices: 0 }),
      dispose: () => {},
    };
    meshMergeRegistry.register({ abiVersion: MESH_MERGE_ABI_VERSION, createPort: () => providerPort });
    expect(createMeshMergePort()).toBe(providerPort);
  });

  it('degrades to inline on ABI version mismatch with console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      meshMergeRegistry.register({
        abiVersion: MESH_MERGE_ABI_VERSION + 1,
        createPort: () => {
          throw new Error('must not be called');
        },
      });
      const port = createMeshMergePort();
      expect(port.path).toBe('js');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ABI'));
    } finally {
      warn.mockRestore();
    }
  });

  it('degrades to inline when provider createPort() throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      meshMergeRegistry.register({
        abiVersion: MESH_MERGE_ABI_VERSION,
        createPort: () => {
          throw new Error('boom');
        },
      });
      const port = createMeshMergePort();
      expect(port.path).toBe('js');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── Queue / dispose ────────────────────────────────────────────────────

describe('InlineMergePort queue + dispose', () => {
  it('processes merges strictly sequentially', async () => {
    const port = createInlineMergePort();
    const order: number[] = [];
    // Multi-chunk batches so each merge spans macrotask yields — an
    // out-of-order implementation would interleave completions.
    const p1 = port.merge(makeBatch({ meshCount: 4, chunkVertexBudget: 3 })).then(() => order.push(1));
    const p2 = port.merge(makeBatch({ meshCount: 4, chunkVertexBudget: 3 })).then(() => order.push(2));
    const p3 = port.merge(makeBatch({ meshCount: 2 })).then(() => order.push(3));
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('inline port yields to macrotasks between chunks', async () => {
    const port = createInlineMergePort();
    let macrotaskRan = false;
    setTimeout(() => { macrotaskRan = true; }, 0);
    // 4 meshes with a 1-mesh chunk budget → 4 chunks → 3 yields.
    const result = await port.merge(makeBatch({ meshCount: 4, chunkVertexBudget: 3 }));
    expect(result.chunks.length).toBe(4);
    // The pre-scheduled macrotask MUST have run during the merge (the port
    // yielded control to the event loop between chunks).
    expect(macrotaskRan).toBe(true);
  });

  it('dispose during in-flight merge does not reject callers', async () => {
    const port = createInlineMergePort();
    const inFlight = port.merge(makeBatch({ meshCount: 4, chunkVertexBudget: 3 }));
    port.dispose();
    const result = await inFlight; // must resolve, not reject
    expect(result.chunks.length).toBe(4);
    // New merges after dispose ARE refused.
    await expect(port.merge(makeBatch())).rejects.toThrow(/disposed/);
  });
});

// ─── Inline compute semantics ───────────────────────────────────────────

describe('mergeBatchInline compute', () => {
  it('bakes groupInverse × worldMatrix into positions', async () => {
    const world = new Matrix4().makeTranslation(10, 0, 0);
    const inverse = new Matrix4().makeTranslation(0, -5, 0);
    const batch = makeBatch({
      meshCount: 1,
      worldMatrices: [world],
      groupInverses: [inverse],
    });
    const out = await mergeBatchInline(batch);
    expect(out.chunks).toHaveLength(1);
    // Source vertex 0 = (0,0,0) → world (10,0,0) → inverse (10,-5,0).
    expect(out.chunks[0].position[0]).toBeCloseTo(10, 6);
    expect(out.chunks[0].position[1]).toBeCloseTo(-5, 6);
    // Normals rotated (identity rotation here) + normalized.
    expect(out.chunks[0].normal[2]).toBeCloseTo(1, 6);
  });

  it('rebases indices per chunk and splits at group boundaries', async () => {
    const batch = makeBatch({
      meshCount: 3,
      groupIds: [0, 0, 1],
      groupInverses: [new Matrix4(), new Matrix4()],
    });
    const out = await mergeBatchInline(batch);
    // Group boundary forces two chunks even under a huge vertex budget.
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks[0].groupId).toBe(0);
    expect(out.chunks[1].groupId).toBe(1);
    expect(out.chunks[0].position.length).toBe(6 * 3);
    expect(out.chunks[1].position.length).toBe(3 * 3);
    // Second mesh's indices rebased by +3 within chunk 0.
    expect(Array.from(out.chunks[0].index!)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(out.chunks[1].index!)).toEqual([0, 1, 2]);
    expect(out.totalVertices).toBe(9);
  });

  it('returns an empty result for an empty batch', async () => {
    const batch = makeBatch({ meshCount: 1 });
    batch.descriptors = [];
    const out: MergedChunks = await mergeBatchInline(batch);
    expect(out.chunks).toEqual([]);
    expect(out.totalVertices).toBe(0);
  });
});
