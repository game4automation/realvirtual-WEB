// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-separator-client — thin main-thread wrapper around the mesh separator worker
 * (plan-331, Phase 2b).
 *
 * Owns three things and nothing else:
 *
 * 1. **Copy-in, transfer-out.** Request arrays are copied (tight copies via the
 *    `serialize*` helpers, then a plain structured clone — no transfer list). Transferring
 *    a request would detach the `ArrayBuffer` of the **live** source geometry and destroy
 *    rendering and raycasting. Responses *are* transferred: those buffers are built inside
 *    the worker and belong to nobody else.
 * 2. **A monotonically increasing `id` as the abort epoch.** Every request supersedes the
 *    previous one; a response carrying a stale `id` is dropped rather than applied. Dialog
 *    cancel, a geometry change at the source and `dispose()` all abort the in-flight
 *    request the same way — the same epoch idea as the BVH abort, just local to this class.
 * 3. **A synchronous fallback.** With no `Worker` available (restricted CSP, a test
 *    environment without worker support, a hard construction error) the same pure
 *    functions run inline. The fallback calls the identical code and therefore cannot
 *    diverge from the worker path.
 *
 * This wrapper lives in its own file rather than inside `rv-mesh-separator.ts` on purpose:
 * the worker imports the core, so putting a `new Worker(new URL('./…-worker.ts'))`
 * reference into the core would make the worker bundle contain a nested copy of itself.
 */

import type { BufferGeometry } from 'three';
import {
  computeGroupPartitions,
  computeMeshIslands,
  deserializeGeometry,
  extractSubGeometry,
  serializeAttributes,
  serializeGeometryParts,
  serializeIndex,
  serializePositions,
  type GeometryGroupSpec,
  type SeparateMode,
  type SeparateRequest,
  type SeparateResponse,
} from './rv-mesh-separator';

/** Message channel to the worker — injectable so tests can drive it deterministically. */
export interface MeshSeparatorPort {
  postMessage(message: SeparateRequest): void;
  terminate(): void;
  onMessage(callback: (message: SeparateResponse) => void): void;
}

export interface MeshSeparatorClientOptions {
  /**
   * Creates the transport. Return `null` to force the synchronous fallback.
   * Defaults to a real ES module Worker.
   */
  createPort?: () => MeshSeparatorPort | null;
}

/** Thrown when a request is superseded by a newer one, or the client is disposed. */
export class MeshSeparatorAbortError extends Error {
  constructor(message = 'Mesh separator request was aborted') {
    super(message);
    this.name = 'MeshSeparatorAbortError';
  }
}

/** True when `err` is the abort signal rather than a real failure. */
export function isMeshSeparatorAbort(err: unknown): boolean {
  return err instanceof MeshSeparatorAbortError;
}

interface PendingRequest {
  id: number;
  resolve: (response: SeparateResponse) => void;
  reject: (err: unknown) => void;
}

export class RVMeshSeparatorClient {
  private readonly createPort: () => MeshSeparatorPort | null;
  private port: MeshSeparatorPort | null = null;
  private portFailed = false;
  private nextId = 1;
  /** The only `id` whose response may still be applied. */
  private latestId = 0;
  private pending: PendingRequest | null = null;
  private disposed = false;

  constructor(options: MeshSeparatorClientOptions = {}) {
    this.createPort = options.createPort ?? defaultCreatePort;
  }

  /** True when requests really go off-thread. False means the inline fallback is active. */
  get usesWorker(): boolean {
    return this.ensurePort() !== null;
  }

  /**
   * Phase 1: weld + union-find (or the group table), returning the triangle partitions.
   * Only `position` and `index` are shipped — the cheap half the preview needs.
   */
  async analyze(
    geom: BufferGeometry,
    mode: SeparateMode,
    resolution: number,
  ): Promise<number[][]> {
    const id = this.beginRequest();
    const groups: GeometryGroupSpec[] | undefined =
      mode === 'groups'
        ? (geom.groups ?? []).map((g) => ({
            start: g.start,
            count: g.count,
            materialIndex: g.materialIndex ?? 0,
          }))
        : undefined;

    const request: SeparateRequest = {
      id,
      phase: 'analyze',
      mode,
      position: serializePositions(geom),
      index: serializeIndex(geom),
      resolution,
      groups,
    };

    const response = await this.dispatch(request, () => {
      const local = deserializeGeometry(
        { position: { array: request.position, itemSize: 3, normalized: false } },
        request.index,
        groups,
      );
      const partitions =
        mode === 'groups' ? computeGroupPartitions(local) : computeMeshIslands(local, resolution);
      return { id, ok: true, phase: 'analyze', partitions };
    });

    if (!response.ok) throw new Error(response.error);
    if (response.phase !== 'analyze') throw new Error('Mesh separator: unexpected response phase');
    return response.partitions;
  }

  /** Phase 2: the attribute copy, run only after the user confirms. */
  async extract(geom: BufferGeometry, partitions: number[][]): Promise<BufferGeometry[]> {
    const id = this.beginRequest();
    const request: SeparateRequest = {
      id,
      phase: 'extract',
      attributes: serializeAttributes(geom),
      index: serializeIndex(geom),
      partitions,
    };

    const response = await this.dispatch(request, () => {
      const local = deserializeGeometry(request.attributes, request.index);
      const parts = partitions.map((partition) =>
        serializeGeometryParts(extractSubGeometry(local, partition)),
      );
      return { id, ok: true, phase: 'extract', parts };
    });

    if (!response.ok) throw new Error(response.error);
    if (response.phase !== 'extract') throw new Error('Mesh separator: unexpected response phase');

    return response.parts.map((part) => {
      const out = deserializeGeometry(part.attributes, part.index.length > 0 ? part.index : null);
      out.computeBoundingSphere();
      out.computeBoundingBox();
      return out;
    });
  }

  /**
   * Abandons the in-flight request. The worker keeps running to completion — there is no
   * way to interrupt it — but its response is dropped because the epoch has moved on.
   */
  cancel(): void {
    this.bumpEpoch();
  }

  /** Aborts anything in flight and terminates the worker. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bumpEpoch();
    if (this.port) {
      try {
        this.port.terminate();
      } catch {
        /* ignore */
      }
      this.port = null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private beginRequest(): number {
    if (this.disposed) throw new MeshSeparatorAbortError('Mesh separator client is disposed');
    this.bumpEpoch();
    const id = this.nextId++;
    this.latestId = id;
    return id;
  }

  /** Invalidates the current epoch and rejects whatever was waiting on it. */
  private bumpEpoch(): void {
    this.latestId = 0;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new MeshSeparatorAbortError());
  }

  private ensurePort(): MeshSeparatorPort | null {
    if (this.disposed || this.portFailed) return null;
    if (this.port) return this.port;
    let port: MeshSeparatorPort | null = null;
    try {
      port = this.createPort();
    } catch {
      port = null;
    }
    if (!port) {
      this.portFailed = true;
      return null;
    }
    port.onMessage((message) => this.onResponse(message));
    this.port = port;
    return port;
  }

  private dispatch(
    request: SeparateRequest,
    runInline: () => SeparateResponse,
  ): Promise<SeparateResponse> {
    const port = this.ensurePort();
    if (!port) {
      // Synchronous fallback — same functions, so it cannot diverge.
      return new Promise((resolve, reject) => {
        let response: SeparateResponse;
        try {
          response = runInline();
        } catch (err) {
          response = {
            id: request.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (request.id !== this.latestId) {
          reject(new MeshSeparatorAbortError());
          return;
        }
        resolve(response);
      });
    }

    return new Promise<SeparateResponse>((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject };
      try {
        // No transfer list on purpose — see the class doc comment.
        port.postMessage(request);
      } catch (err) {
        this.pending = null;
        reject(err);
      }
    });
  }

  private onResponse(message: SeparateResponse): void {
    if (this.disposed) return;
    if (message.id !== this.latestId) return; // stale epoch — drop it
    const pending = this.pending;
    if (!pending || pending.id !== message.id) return;
    this.pending = null;
    pending.resolve(message);
  }
}

/** Real ES module Worker, or `null` when the environment has none. */
function defaultCreatePort(): MeshSeparatorPort | null {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./rv-mesh-separator-worker.ts', import.meta.url), {
    type: 'module',
  });
  let handler: ((message: SeparateResponse) => void) | null = null;
  worker.onmessage = (ev: MessageEvent) => handler?.(ev.data as SeparateResponse);
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => {
      worker.onmessage = null;
      worker.terminate();
    },
    onMessage: (callback) => {
      handler = callback;
    },
  };
}
