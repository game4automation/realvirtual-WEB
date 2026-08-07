// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BVHBuildPort — asynchronous three-mesh-bvh construction behind an
 * injectable port (plan-240, Baustein 3).
 *
 * The scene loader used to build every BVH synchronously inside `loadGLB()`,
 * stalling the main thread for 800+ ms on large models. This module moves the
 * `MeshBVH` construction behind a small port abstraction, mirroring the
 * transport-worker pattern of `websocket-realtime-interface.ts`
 * (createPort / worker port / inline fallback / mock port for tests):
 *
 *   - **Worker port** (default): wraps `GenerateMeshBVHWorker` from
 *     `three-mesh-bvh/worker`. ONE worker instance is created lazily on the
 *     first build and reused across model loads; builds run strictly
 *     sequentially (the library worker handles one job at a time).
 *     The worker path TRANSFERS the geometry's position/index buffers for the
 *     duration of the build and restores them on resolve — it is therefore
 *     only used for geometries whose typed arrays exclusively own their
 *     underlying ArrayBuffer (see `isTransferSafeGeometry`). Everything else
 *     (views into a shared GLB buffer, interleaved attributes, buffers shared
 *     between geometries) falls back to the inline path per geometry.
 *     Note on `ParallelMeshBVHWorker`: it needs `crossOriginIsolated`
 *     (COOP/COEP headers) which our deploys do not guarantee — we stick to
 *     the single `GenerateMeshBVHWorker` to keep the port simple; the
 *     sequential queue already keeps the main thread free.
 *
 *   - **Inline budget port** (fallback / no `Worker`): builds `MeshBVH`
 *     synchronously on the main thread but yields to the event loop between
 *     geometries via a MessageChannel macrotask once a time budget is
 *     exhausted (NOT `setTimeout(0)` — clamped; NOT `requestIdleCallback` —
 *     unavailable on Safari). Total build time is similar, but frames keep
 *     rendering in between.
 *
 *   - **Mock port** (tests): inject via the `factory` parameter of
 *     `createBVHPort()` — vitest never spawns a real worker.
 *
 * The port deliberately does NOT assign `geometry.boundsTree` — the caller
 * (`computeBVHAsync` in rv-scene-loader.ts) owns the assignment so it can
 * enforce the load-generation guard before every write.
 */

import { BufferGeometry, Mesh } from 'three';

// ─── Types ──────────────────────────────────────────────────────────

export interface BVHBuildOptions {
  /** Build in indirect mode (preserves the original index-buffer ordering —
   *  required by the merged raycast geometries' face-range tables). */
  indirect?: boolean;
  /** When false, the port must NOT transfer the geometry's buffers to a
   *  worker (e.g. the caller detected that the underlying ArrayBuffer is
   *  shared with another geometry). The inline path is used instead. */
  transferable?: boolean;
}

/** Async BVH build port. `generate` resolves with the built MeshBVH instance
 *  (typed `unknown` so consumers don't need the three-mesh-bvh types). */
export interface BVHBuildPort {
  generate(geometry: BufferGeometry, options?: BVHBuildOptions): Promise<unknown>;
  dispose(): void;
}

/** Minimal surface of three-mesh-bvh's GenerateMeshBVHWorker. */
interface MeshBVHWorkerLike {
  generate(geometry: BufferGeometry, options?: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
}

// ─── Prototype patches ──────────────────────────────────────────────

let patchesPromise: Promise<void> | null = null;

/**
 * Install the three-mesh-bvh prototype patches (`computeBoundsTree`,
 * `disposeBoundsTree`, `acceleratedRaycast`) exactly once.
 *
 * Must run BEFORE any raycast that should consume an assigned
 * `geometry.boundsTree` — `acceleratedRaycast` falls back to the native
 * three.js raycast while `boundsTree` is undefined, so raycasting works
 * (slower) from the moment this resolves, and speeds up per geometry as the
 * async build assigns trees.
 */
export function ensureBVHPrototypePatches(): Promise<void> {
  if (!patchesPromise) {
    // Dynamic import — three-mesh-bvh stays out of the startup bundle chunk.
    patchesPromise = import('three-mesh-bvh').then((bvh) => {
      BufferGeometry.prototype.computeBoundsTree = bvh.computeBoundsTree;
      BufferGeometry.prototype.disposeBoundsTree = bvh.disposeBoundsTree;
      Mesh.prototype.raycast = bvh.acceleratedRaycast;
    });
  }
  return patchesPromise;
}

// ─── Transfer-safety check ──────────────────────────────────────────

interface TypedArrayLike {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
}

/**
 * A geometry may only go through the worker path when its position/index
 * typed arrays each exclusively own their ArrayBuffer. GLTFLoader frequently
 * creates attributes as VIEWS into a shared per-bufferView ArrayBuffer —
 * transferring such a view's buffer would detach every sibling geometry's
 * data and `postMessage` would throw on duplicate transferables.
 */
export function isTransferSafeGeometry(geometry: BufferGeometry): boolean {
  const pos = geometry.getAttribute('position');
  if (!pos) return false;
  if ((pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return false;
  const posArr = pos.array as unknown as TypedArrayLike;
  if (posArr.byteOffset !== 0 || posArr.byteLength !== posArr.buffer.byteLength) return false;

  const index = geometry.index;
  if (index) {
    if ((index as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return false;
    const idxArr = index.array as unknown as TypedArrayLike;
    if (idxArr.byteOffset !== 0 || idxArr.byteLength !== idxArr.buffer.byteLength) return false;
    if (idxArr.buffer === posArr.buffer) return false;
  }
  return true;
}

// ─── Macrotask yield (inline budget path) ───────────────────────────

/** Yield one macrotask via MessageChannel (React-scheduler pattern —
 *  `setTimeout(0)` is clamped to 4 ms+, `requestIdleCallback` is Safari-gated). */
function yieldMacrotask(): Promise<void> {
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

/** Max synchronous build time between yields on the inline path. */
const INLINE_BUDGET_MS = 8;

// ─── Default port implementation ────────────────────────────────────

class DefaultBVHPort implements BVHBuildPort {
  /** Sequential job queue — the library worker runs one build at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private worker: MeshBVHWorkerLike | null = null;
  private workerPromise: Promise<MeshBVHWorkerLike | null> | null = null;
  /** Set after a worker-level failure — all further builds go inline. */
  private workerDead: boolean;
  private disposed = false;
  /** Timestamp of the last event-loop yield on the inline path. */
  private lastYield = 0;

  constructor(inlineOnly = false) {
    this.workerDead = inlineOnly;
  }

  generate(geometry: BufferGeometry, options?: BVHBuildOptions): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('BVHBuildPort is disposed'));
    const job = this.queue.then(() => this.generateOne(geometry, options));
    // Keep the chain alive even when a job rejects — the rejection still
    // propagates to THIS job's caller via `job`.
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose(): void {
    this.disposed = true;
    // Note: terminating mid-build leaves the in-flight promise unresolved —
    // acceptable, dispose() only runs at viewer teardown (fire-and-forget
    // builds are abandoned with the page).
    this.worker?.dispose();
    this.worker = null;
    this.workerPromise = null;
  }

  private async generateOne(geometry: BufferGeometry, options?: BVHBuildOptions): Promise<unknown> {
    if (this.disposed) throw new Error('BVHBuildPort is disposed');

    const wantWorker =
      !this.workerDead &&
      typeof Worker !== 'undefined' &&
      options?.transferable !== false &&
      isTransferSafeGeometry(geometry);

    if (wantWorker) {
      const worker = await this.getWorker();
      if (worker) {
        try {
          // GenerateMeshBVHWorker passes options through to `new MeshBVH()`
          // in the worker, serializes the (indirect-aware) result and
          // restores the transferred buffers on resolve.
          const tree = await worker.generate(geometry, { indirect: options?.indirect === true });
          return await this.rebrandToMainEntry(tree);
        } catch (e) {
          // Worker failures are treated as systemic (module load / runtime
          // error) — retire the worker and continue inline.
          console.warn('[BVHBuildPort] worker build failed — falling back to inline builds:', e);
          this.retireWorker();
        }
      }
    }

    return this.generateInline(geometry, options);
  }

  private getWorker(): Promise<MeshBVHWorkerLike | null> {
    if (!this.workerPromise) {
      // Dynamic import keeps the worker chunk out of the startup bundle.
      this.workerPromise = import('three-mesh-bvh/worker')
        .then((mod) => {
          if (this.disposed) return null;
          this.worker = new mod.GenerateMeshBVHWorker() as unknown as MeshBVHWorkerLike;
          return this.worker;
        })
        .catch((e) => {
          console.warn('[BVHBuildPort] worker unavailable — using inline builds:', e);
          this.workerDead = true;
          return null;
        });
    }
    return this.workerPromise;
  }

  private retireWorker(): void {
    this.workerDead = true;
    try {
      this.worker?.dispose();
    } catch {
      /* ignore */
    }
    this.worker = null;
    this.workerPromise = null;
  }

  /** Cross-entry class-identity fix: `three-mesh-bvh/worker` is a SEPARATE
   *  bundler entry with its OWN copy of the MeshBVH class, and
   *  `GenerateMeshBVHWorker.generate` deserializes the finished tree with THAT
   *  copy on the main thread. `MeshBVH.bvhcast` in the main entry guards
   *  `otherBvh instanceof MeshBVH` against the MAIN copy, so a worker-built
   *  tree throws 'MeshBVH: "intersectsTriangles" callback can only be used
   *  with another MeshBVH.' the first time the collision narrowphase runs
   *  (plan-394; the inline test paths never hit this because they build with
   *  the main entry). Re-branding the instance onto the main entry's
   *  prototype unifies class identity — same package version, identical
   *  instance layout, methods carry no per-copy state. */
  private async rebrandToMainEntry(tree: unknown): Promise<unknown> {
    const { MeshBVH } = await import('three-mesh-bvh');
    if (tree instanceof Object && !(tree instanceof MeshBVH)) {
      Object.setPrototypeOf(tree, MeshBVH.prototype);
    }
    return tree;
  }

  private async generateInline(geometry: BufferGeometry, options?: BVHBuildOptions): Promise<unknown> {
    const { MeshBVH } = await import('three-mesh-bvh');
    const now = performance.now();
    if (now - this.lastYield > INLINE_BUDGET_MS) {
      await yieldMacrotask();
      this.lastYield = performance.now();
    }
    // Direct MeshBVH construction (NOT computeBoundsTree) — the caller owns
    // the `geometry.boundsTree` assignment (load-generation guard).
    return new MeshBVH(geometry, options?.indirect ? { indirect: true } : undefined);
  }
}

/** Inline-only port — used by tests and available as an explicit fallback.
 *  Same budget-yield behavior as the default port's inline path, never
 *  touches `Worker`. */
export function createInlineBVHPort(): BVHBuildPort {
  return new DefaultBVHPort(true);
}

/**
 * Create a BVH build port.
 *
 * @param factory  Test seam — when provided, the factory result is returned
 *                 instead of the default worker/inline port (vitest injects a
 *                 mock port here; never spawn a real worker in tests).
 */
export function createBVHPort(factory?: () => BVHBuildPort): BVHBuildPort {
  if (factory) return factory();
  return new DefaultBVHPort();
}
