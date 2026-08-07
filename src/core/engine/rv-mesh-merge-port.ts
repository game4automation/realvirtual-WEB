// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MeshMergePort — asynchronous mesh-merge compute behind an injectable port
 * (plan-274 Phase 1).
 *
 * The static + kinematic uber merges (`rv-static-merge-uber.ts` /
 * `rv-kinematic-merge-uber.ts`) used to clone every candidate geometry and
 * run `applyMatrix4` + `mergeGeometries` synchronously on the main thread —
 * the last big synchronous compute block of the GLB load pipeline. This
 * module moves the vertex-batch part (transform bake, attribute concat,
 * chunk packing) behind a small port abstraction, mirroring
 * `rv-bvh-build-port.ts` (plan-240):
 *
 *   - **InlineMergePort** (default, source of truth): processes staged
 *     batches on the main thread, yielding one macrotask between chunks via
 *     MessageChannel (NOT `setTimeout(0)` — clamped; NOT
 *     `requestIdleCallback` — unavailable on Safari). Functionally identical
 *     to the legacy clone/mergeGeometries path, but without the N clones.
 *
 *   - **Provider port** (plan-274 Phase 2/3, Rust→WASM): registered as a
 *     provider OBJECT via `meshMergeRegistry` (IK-solver pattern, N2 — the
 *     private tier imports the `.wasm` itself and registers a ready
 *     instance; no URL crosses the public/private seam). Gated by the ABI
 *     version and the `rv.merge.wasm` kill-switch; any mismatch degrades
 *     transparently to the inline port (F3).
 *
 *   - **Mock port** (tests): inject via the `factory` parameter of
 *     `createMeshMergePort()` — vitest never runs real compute.
 *
 * Batches are staged SLICE-wise by `rv-mesh-merge-batch.ts` (B2): one
 * `merge()` call per slice of 2-4M vertices, so neither the staging nor a
 * future WASM heap ever holds a full-scene bulk buffer.
 */

import { Matrix3, Matrix4 } from 'three';

// ─── ABI / feature constants ────────────────────────────────────────

/** ABI version the TS side speaks. A provider with a different `abiVersion`
 *  is rejected at port creation (degrade to inline + console.warn). */
export const MESH_MERGE_ABI_VERSION = 1;

/** localStorage kill-switch (pattern: `rv.import.jt`/`rv.import.usd`).
 *  Default ON; 'off' / 'false' / '0' disable the WASM provider path. */
export const MESH_MERGE_WASM_FLAG_KEY = 'rv.merge.wasm';

/**
 * Below this total vertex count a provider port must route the batch through
 * the inline path directly (no worker round trip, no slice overhead) — the
 * postMessage/copy overhead would exceed the compute win on small models.
 * The inline port ignores it (it is already inline).
 */
export const SMALL_MODEL_VERTEX_THRESHOLD = 200_000;

/** Returns false when the `rv.merge.wasm` kill-switch disables the provider
 *  (WASM) path. Inline merging is unaffected by the switch. */
export function isMeshMergeWasmEnabled(): boolean {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(MESH_MERGE_WASM_FLAG_KEY) : null;
    if (v === 'off' || v === 'false' || v === '0') return false;
  } catch {
    /* storage unavailable (privacy mode) — default ON */
  }
  return true;
}

// ─── Batch / result types (TS mirror of the plan-274 §2.3 ABI layout) ──

/** Per-mesh descriptor inside a MergeBatch. All payload offsets are implicit:
 *  descriptors are laid out back-to-back in the concatenated payload arrays,
 *  in descriptor order. */
export interface MeshDescriptor {
  /** Staged vertex count (post toNonIndexed-expansion when the batch is
   *  non-indexed). */
  vertexCount: number;
  /** Staged index count; 0 when the batch is non-indexed. Index values are
   *  mesh-local — the port rebases them per output chunk. */
  indexCount: number;
  /** Whether the SOURCE geometry had a normal attribute. The staging layer
   *  computes missing normals (legacy `computeVertexNormals()` parity), so
   *  the batch `normal` payload is always filled — the flag is kept for the
   *  Phase-2 WASM ABI, where normal computation moves into the module. */
  hasNormal: boolean;
  /** Whether the source had a color attribute (uber bake). */
  hasColor: boolean;
  /** Whether the source had an rmPacked attribute (uber bake). */
  hasRm: boolean;
  /** Index into the batch group-inverse table (B1). Descriptors of the same
   *  group are contiguous; a group never spans a slice boundary. */
  groupId: number;
  /** World matrix of the source mesh (column-major, 16 floats). The port
   *  bakes `groupInverse[groupId] × worldMatrix` into the positions. */
  worldMatrix: Float32Array;
}

/** One staged merge slice — the unit of a `MeshMergePort.merge()` call. */
export interface MergeBatch {
  /** True when every source geometry kept its index (all-or-none, decided
   *  once per pass by the caller). */
  keepIndexed: boolean;
  /** Output chunk vertex budget (greedy split, reset at group boundaries). */
  chunkVertexBudget: number;
  /** Number of groups referenced by this slice. */
  groupCount: number;
  /** Per-group bake-target inverse matrices (B1): `groupCount × 16` floats,
   *  column-major. Static pass: one entry (rootInverse). Kinematic pass: one
   *  entry per Drive group in the slice. */
  groupInverses: Float32Array;
  descriptors: MeshDescriptor[];
  /** Concatenated payload in descriptor order (canonical layout: f32/u8/u32,
   *  de-interleaved, dequantized). */
  position: Float32Array;
  /** Always filled (staging computes missing normals — see MeshDescriptor.hasNormal). */
  normal: Float32Array;
  /** Null when NO mesh in the slice carries the attribute; meshes without it
   *  are pre-filled by the staging layer (color: 255, rm: [255, 0]). */
  color: Uint8Array | null;
  rmPacked: Uint8Array | null;
  /** Null when `keepIndexed` is false. */
  index: Uint32Array | null;
}

/** One merged output chunk (becomes one BufferGeometry / draw call). */
export interface MergedChunk {
  groupId: number;
  position: Float32Array;
  normal: Float32Array;
  color?: Uint8Array;
  rmPacked?: Uint8Array;
  /** Rebased to chunk-local vertex 0. Present only for indexed batches. */
  index?: Uint32Array;
}

export interface MergedChunks {
  chunks: MergedChunk[];
  totalVertices: number;
}

/** Async mesh-merge port. `merge()` calls are processed strictly
 *  sequentially per port instance. */
export interface MeshMergePort {
  merge(batch: MergeBatch): Promise<MergedChunks>;
  dispose(): void;
  /** Diagnostic label for the load log (`path=js|wasm`). */
  readonly path?: string;
}

// ─── Provider seam (N2 — IK-solver registry pattern) ────────────────

/** Registered by the private tier (Phase 2/3). Creates provider-backed ports
 *  (Worker + rv_mesh_merge.wasm). `abiVersion` must equal
 *  {@link MESH_MERGE_ABI_VERSION} or the provider is ignored. */
export interface MeshMergeProvider {
  createPort(): MeshMergePort;
  abiVersion: number;
}

let registeredProvider: MeshMergeProvider | null = null;

/** Provider registry singleton. `register(null)` clears (tests). When empty,
 *  `createMeshMergePort()` always returns the inline port — in the public
 *  build this is structurally enforced (stub resolution, no registration). */
export const meshMergeRegistry = {
  register(provider: MeshMergeProvider | null): void {
    registeredProvider = provider;
  },
  get(): MeshMergeProvider | null {
    return registeredProvider;
  },
};

// ─── Macrotask yield (inline path) ──────────────────────────────────

/** Yield one macrotask via MessageChannel (React-scheduler pattern —
 *  `setTimeout(0)` is clamped to 4 ms+, `requestIdleCallback` is Safari-gated).
 *  Exported for the BatchedMesh arena builders (rv-batched-render.ts). */
export function yieldMacrotask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    // Non-browser environment (SSR) — a microtask is the best we can do.
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

// ─── Inline merge implementation ────────────────────────────────────

/** Descriptor range forming one output chunk. */
interface ChunkRange {
  start: number; // first descriptor index (inclusive)
  end: number;   // last descriptor index (exclusive)
  groupId: number;
  vertexCount: number;
  indexCount: number;
}

/**
 * Greedy chunk split — EXACTLY the legacy packing: accumulate descriptors
 * until adding the next would exceed the budget (a chunk always takes at
 * least one descriptor), and always finalize at group boundaries (each
 * Drive group owns its chunks — B1).
 *
 * Exported for the staging layer, which uses the same ranges to cut slices
 * at chunk boundaries so slice-local greedy packing reproduces the global
 * (legacy) chunk structure.
 */
export function computeChunkRanges(
  descriptors: readonly { vertexCount: number; indexCount: number; groupId: number }[],
  chunkVertexBudget: number,
): ChunkRange[] {
  const ranges: ChunkRange[] = [];
  let start = 0;
  let verts = 0;
  let indices = 0;
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i];
    const chunkHasEntries = i > start;
    if (
      chunkHasEntries &&
      (d.groupId !== descriptors[start].groupId || verts + d.vertexCount > chunkVertexBudget)
    ) {
      ranges.push({ start, end: i, groupId: descriptors[start].groupId, vertexCount: verts, indexCount: indices });
      start = i;
      verts = 0;
      indices = 0;
    }
    verts += d.vertexCount;
    indices += d.indexCount;
  }
  if (descriptors.length > start) {
    ranges.push({
      start,
      end: descriptors.length,
      groupId: descriptors[start].groupId,
      vertexCount: verts,
      indexCount: indices,
    });
  }
  return ranges;
}

/**
 * Run the merge compute for one staged batch on the calling thread:
 * per-mesh transform bake (`groupInverse[groupId] × worldMatrix`), normal
 * rotation (normal matrix + normalize — `BufferGeometry.applyMatrix4`
 * parity), attribute concat, index rebase and greedy chunk split.
 *
 * Pure function on the staged arrays — never touches THREE objects other
 * than temp matrices. Exported for the Phase-2 WASM equivalence tests.
 */
export function mergeBatchInline(
  batch: MergeBatch,
  onChunkBoundary?: () => Promise<void>,
): Promise<MergedChunks> {
  return (async () => {
    const { descriptors } = batch;
    if (descriptors.length === 0) return { chunks: [], totalVertices: 0 };

    // Prefix offsets of every descriptor into the batch payload.
    const vertOffsets = new Array<number>(descriptors.length);
    const idxOffsets = new Array<number>(descriptors.length);
    {
      let vo = 0;
      let io = 0;
      for (let i = 0; i < descriptors.length; i++) {
        vertOffsets[i] = vo;
        idxOffsets[i] = io;
        vo += descriptors[i].vertexCount;
        io += descriptors[i].indexCount;
      }
    }

    const ranges = computeChunkRanges(descriptors, batch.chunkVertexBudget);
    const chunks: MergedChunk[] = [];
    let totalVertices = 0;

    const mat = new Matrix4();
    const world = new Matrix4();
    const inverse = new Matrix4();
    const normalMat = new Matrix3();

    for (let r = 0; r < ranges.length; r++) {
      if (r > 0 && onChunkBoundary) await onChunkBoundary();
      const range = ranges[r];

      const outPos = new Float32Array(range.vertexCount * 3);
      const outNormal = new Float32Array(range.vertexCount * 3);
      const outColor = batch.color ? new Uint8Array(range.vertexCount * 3) : null;
      const outRm = batch.rmPacked ? new Uint8Array(range.vertexCount * 2) : null;
      const outIndex = batch.keepIndexed && batch.index ? new Uint32Array(range.indexCount) : null;

      let dstVert = 0;
      let dstIdx = 0;
      for (let i = range.start; i < range.end; i++) {
        const d = descriptors[i];
        const srcVert = vertOffsets[i];
        const n = d.vertexCount;

        // Composed bake matrix: groupInverse × worldMatrix. Composing the two
        // legacy applyMatrix4 calls into one matrix is mathematically
        // identical (normalization makes the normal path scale-invariant).
        world.fromArray(d.worldMatrix);
        inverse.fromArray(batch.groupInverses as unknown as number[], d.groupId * 16);
        mat.multiplyMatrices(inverse, world);
        normalMat.getNormalMatrix(mat);
        const e = mat.elements;
        const ne = normalMat.elements;

        const srcP = batch.position;
        const srcN = batch.normal;
        let s = srcVert * 3;
        let t = dstVert * 3;
        for (let v = 0; v < n; v++, s += 3, t += 3) {
          const x = srcP[s], y = srcP[s + 1], z = srcP[s + 2];
          outPos[t] = e[0] * x + e[4] * y + e[8] * z + e[12];
          outPos[t + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
          outPos[t + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];

          const nx = srcN[s], ny = srcN[s + 1], nz = srcN[s + 2];
          let ox = ne[0] * nx + ne[3] * ny + ne[6] * nz;
          let oy = ne[1] * nx + ne[4] * ny + ne[7] * nz;
          let oz = ne[2] * nx + ne[5] * ny + ne[8] * nz;
          const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
          if (len > 0) {
            const inv = 1 / len;
            ox *= inv; oy *= inv; oz *= inv;
          }
          outNormal[t] = ox;
          outNormal[t + 1] = oy;
          outNormal[t + 2] = oz;
        }

        if (outColor && batch.color) {
          outColor.set(batch.color.subarray(srcVert * 3, (srcVert + n) * 3), dstVert * 3);
        }
        if (outRm && batch.rmPacked) {
          outRm.set(batch.rmPacked.subarray(srcVert * 2, (srcVert + n) * 2), dstVert * 2);
        }
        if (outIndex && batch.index) {
          const srcIdx = idxOffsets[i];
          const rebase = dstVert;
          for (let k = 0; k < d.indexCount; k++) {
            outIndex[dstIdx + k] = batch.index[srcIdx + k] + rebase;
          }
          dstIdx += d.indexCount;
        }

        dstVert += n;
      }

      totalVertices += range.vertexCount;
      chunks.push({
        groupId: range.groupId,
        position: outPos,
        normal: outNormal,
        ...(outColor ? { color: outColor } : {}),
        ...(outRm ? { rmPacked: outRm } : {}),
        ...(outIndex ? { index: outIndex } : {}),
      });
    }

    return { chunks, totalVertices };
  })();
}

// ─── Inline port ────────────────────────────────────────────────────

class InlineMergePort implements MeshMergePort {
  readonly path = 'js';
  /** Sequential job queue — one merge at a time per port (BVH-port pattern). */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  merge(batch: MergeBatch): Promise<MergedChunks> {
    if (this.disposed) return Promise.reject(new Error('MeshMergePort is disposed'));
    const job = this.queue.then(() => mergeBatchInline(batch, yieldMacrotask));
    // Keep the chain alive even when a job rejects — the rejection still
    // propagates to THIS job's caller via `job`.
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose(): void {
    // In-flight merges run to completion (their callers are never rejected
    // by dispose); only NEW merge() calls are refused.
    this.disposed = true;
  }
}

/** Inline-only port — the JS source of truth. Used directly in the public
 *  build (empty registry) and as the degradation target for every provider
 *  failure mode. */
export function createInlineMergePort(): MeshMergePort {
  return new InlineMergePort();
}

/**
 * Create a mesh-merge port.
 *
 * Resolution order:
 *   1. `factory` (test seam) — returned verbatim.
 *   2. Registered provider, IF the `rv.merge.wasm` kill-switch is on AND the
 *      provider's `abiVersion` matches {@link MESH_MERGE_ABI_VERSION}.
 *      An ABI mismatch logs a console.warn and degrades to inline (F3).
 *   3. InlineMergePort.
 */
export function createMeshMergePort(factory?: () => MeshMergePort): MeshMergePort {
  if (factory) return factory();
  const provider = meshMergeRegistry.get();
  if (provider && isMeshMergeWasmEnabled()) {
    if (provider.abiVersion !== MESH_MERGE_ABI_VERSION) {
      console.warn(
        `[MeshMergePort] provider ABI v${provider.abiVersion} != expected v${MESH_MERGE_ABI_VERSION} — using inline JS merge`,
      );
      return new InlineMergePort();
    }
    try {
      return provider.createPort();
    } catch (e) {
      console.warn('[MeshMergePort] provider createPort() failed — using inline JS merge:', e);
      return new InlineMergePort();
    }
  }
  return new InlineMergePort();
}
