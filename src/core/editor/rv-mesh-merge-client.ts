// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-merge-client — thin main-thread wrapper around the mesh merge worker
 * (plan-372, Phase 4). Built to the plan-331 separator-client blueprint, not on top of
 * it: same mechanics, own request and response types.
 *
 * Owns three things and nothing else:
 *
 * 1. **Copy in, TRANSFER in, transfer out.** The request arrays are tight copies made by
 *    the `serialize*` helpers, so they are already independent of the live geometry —
 *    which is precisely why they may go on the transfer list instead of being cloned a
 *    second time by `postMessage`. Nothing live is ever detached. (The separator client
 *    leaves that saving on the table; plan-372 finding 8.)
 * 2. **A monotonically increasing `id` as the abort epoch.** Every request supersedes the
 *    previous one; a response carrying a stale `id` is dropped. Dialog cancel, a changed
 *    subtree and `dispose()` all abort the same way.
 * 3. **A synchronous fallback.** With no `Worker` available (restricted CSP, a test
 *    environment without worker support, a hard construction error) `runMergeRequest`
 *    runs inline — the identical function the worker calls, so the two cannot diverge.
 *
 * This wrapper lives in its own file on purpose: the worker imports the core, so a
 * `new Worker(new URL('./…-worker.ts'))` reference inside the core would make the worker
 * bundle contain a nested copy of itself.
 */

import { BufferGeometry, Matrix4 } from 'three';
import {
  runMergeRequest,
  type MergeRequest,
  type MergeResponse,
  type MergeWorkerOutput,
  type MergeWorkerSource,
} from './rv-mesh-merge';
import {
  deserializeGeometry,
  serializeAttributes,
  serializeIndex,
} from './rv-mesh-separator';

/** Message channel to the worker — injectable so tests can drive it deterministically. */
export interface MeshMergePort {
  postMessage(message: MergeRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onMessage(callback: (message: MergeResponse) => void): void;
}

export interface MeshMergeClientOptions {
  /** Creates the transport. Return `null` to force the synchronous fallback. */
  createPort?: () => MeshMergePort | null;
}

/** Thrown when a request is superseded by a newer one, or the client is disposed. */
export class MeshMergeAbortError extends Error {
  constructor(message = 'Mesh merge request was aborted') {
    super(message);
    this.name = 'MeshMergeAbortError';
  }
}

/** True when `err` is the abort signal rather than a real failure. */
export function isMeshMergeAbort(err: unknown): boolean {
  return err instanceof MeshMergeAbortError;
}

/** One bucket to merge, as the caller holds it: live geometries plus world matrices. */
export interface MeshMergeJob {
  sources: { geometry: BufferGeometry; worldMatrix: Matrix4 }[];
  ownerWorld: Matrix4;
}

interface PendingRequest {
  id: number;
  resolve: (response: MergeResponse) => void;
  reject: (err: unknown) => void;
}

export class RVMeshMergeClient {
  private readonly createPort: () => MeshMergePort | null;
  private port: MeshMergePort | null = null;
  private portFailed = false;
  private nextId = 1;
  /** The only `id` whose response may still be applied. */
  private latestId = 0;
  private pending: PendingRequest | null = null;
  private disposed = false;

  constructor(options: MeshMergeClientOptions = {}) {
    this.createPort = options.createPort ?? defaultCreatePort;
  }

  /** True when requests really go off-thread. False means the inline fallback is active. */
  get usesWorker(): boolean {
    return this.ensurePort() !== null;
  }

  /**
   * Bake and merge every job off-thread, in one round trip.
   *
   * Returns one geometry per job, `null` for a job without sources (the empty carrier
   * that keeps the "one same-named mesh" result form).
   */
  async merge(jobs: MeshMergeJob[]): Promise<(BufferGeometry | null)[]> {
    const id = this.beginRequest();

    // Deduplicate by geometry identity: two meshes may share one BufferGeometry, and a
    // transfer list must never carry the same ArrayBuffer twice.
    const sources: MergeWorkerSource[] = [];
    const indexOf = new Map<BufferGeometry, Map<string, number>>();
    const outputs: MergeWorkerOutput[] = [];
    for (const job of jobs) {
      const sourceIndices: number[] = [];
      for (const source of job.sources) {
        const key = source.worldMatrix.elements.join(',');
        let byMatrix = indexOf.get(source.geometry);
        if (!byMatrix) { byMatrix = new Map(); indexOf.set(source.geometry, byMatrix); }
        let index = byMatrix.get(key);
        if (index === undefined) {
          index = sources.length;
          byMatrix.set(key, index);
          sources.push({
            attributes: serializeAttributes(source.geometry),
            index: serializeIndex(source.geometry),
            worldMatrix: source.worldMatrix.toArray(),
          });
        }
        sourceIndices.push(index);
      }
      outputs.push({ sourceIndices, ownerMatrix: job.ownerWorld.toArray() });
    }

    const request: MergeRequest = { id, sources, outputs };
    const transfer: Transferable[] = [];
    for (const source of sources) {
      for (const name of Object.keys(source.attributes)) {
        transfer.push(source.attributes[name].array.buffer as ArrayBuffer);
      }
      if (source.index) transfer.push(source.index.buffer as ArrayBuffer);
    }

    const response = await this.dispatch(request, transfer, () => runMergeRequest(request));
    if (!response.ok) throw new Error(response.error);

    return response.parts.map((part) => {
      if (!part) return null;
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
      try { this.port.terminate(); } catch { /* ignore */ }
      this.port = null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────

  private beginRequest(): number {
    if (this.disposed) throw new MeshMergeAbortError('Mesh merge client is disposed');
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
    pending?.reject(new MeshMergeAbortError());
  }

  private ensurePort(): MeshMergePort | null {
    if (this.disposed || this.portFailed) return null;
    if (this.port) return this.port;
    let port: MeshMergePort | null = null;
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
    request: MergeRequest,
    transfer: Transferable[],
    runInline: () => MergeResponse,
  ): Promise<MergeResponse> {
    const port = this.ensurePort();
    if (!port) {
      return new Promise((resolve, reject) => {
        let response: MergeResponse;
        try {
          response = runInline();
        } catch (err) {
          response = {
            id: request.id, ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        if (request.id !== this.latestId) { reject(new MeshMergeAbortError()); return; }
        resolve(response);
      });
    }

    return new Promise<MergeResponse>((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject };
      try {
        port.postMessage(request, transfer);
      } catch (err) {
        this.pending = null;
        reject(err);
      }
    });
  }

  private onResponse(message: MergeResponse): void {
    if (this.disposed) return;
    if (message.id !== this.latestId) return; // stale epoch — drop it
    const pending = this.pending;
    if (!pending || pending.id !== message.id) return;
    this.pending = null;
    pending.resolve(message);
  }
}

/** Real ES module Worker, or `null` when the environment has none. */
function defaultCreatePort(): MeshMergePort | null {
  if (typeof Worker === 'undefined') return null;
  const worker = new Worker(new URL('./rv-mesh-merge-worker.ts', import.meta.url), {
    type: 'module',
  });
  let handler: ((message: MergeResponse) => void) | null = null;
  worker.onmessage = (ev: MessageEvent) => handler?.(ev.data as MergeResponse);
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer ?? []),
    terminate: () => {
      worker.onmessage = null;
      worker.terminate();
    },
    onMessage: (callback) => { handler = callback; },
  };
}
