// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-build-worker — module-worker entry point of the pick-structure build
 * (plan-756, step 1b).
 *
 * Not a second algorithm, only a second place to run the first one: it calls
 * `buildPickStructure()` from `rv-pick-build.ts` — the very function the port's
 * inline fallback calls ("one function, two callers", the `rv-mesh-merge-worker`
 * blueprint). They cannot diverge, which is what makes the worker == inline
 * byte-identity test of plan §9.2 meaningful rather than decorative.
 *
 * Four properties are load-bearing:
 *
 *  1. **Zero-copy in both directions.** `position` and `index` arrive as
 *     TRANSFERRED buffers (the main thread has already given them up) and go
 *     back the same way, together with every `ChunkPickData` array. Nothing is
 *     cloned: the index the caller attaches to the chunk's `BufferAttribute`
 *     afterwards IS the permuted one this worker produced.
 *  2. **No yielding.** The main thread's inline path time-slices to keep frames
 *     alive; a worker has no frames to keep alive, so it drains the build
 *     synchronously at full speed. Same code, no `onYield` hook.
 *  3. **No three.js, no DOM, no viewer** — the whole reason the build was
 *     written as a pure function over typed arrays in step 1a. The only import
 *     from the port is `import type`, which is erased at transform time, so the
 *     worker bundle never contains the port (and therefore no nested
 *     `new Worker`).
 *  4. **Failure is reported, never thrown at the message pump.** A failed build
 *     comes back as `ok: false` WITH the buffers, so the port can account for
 *     them. The index may be half-permuted at that point, so the port discards
 *     them and re-stages the chunk (plan §2.4a.8).
 */

import { buildPickStructure } from './rv-pick-build';
import type { PickBuildRequest, PickBuildResponse } from './rv-pick-build-port';

/**
 * Every buffer of a response that may go on the transfer list.
 *
 * Deliberately a local copy of ~15 lines instead of a shared helper: the port
 * would have to export it as RUNTIME code, and a runtime import from the port
 * is exactly what pulls `new Worker(new URL(…))` into the worker bundle.
 */
function responseTransferables(response: PickBuildResponse): Transferable[] {
  const transfer: Transferable[] = [];
  const push = (array: { buffer: ArrayBufferLike } | undefined): void => {
    if (array) transfer.push(array.buffer as ArrayBuffer);
  };
  push(response.position);
  push(response.index);
  if (response.ok) {
    const d = response.data;
    push(d.segNode);
    push(d.segOwner);
    push(d.segIndexStart);
    push(d.segIndexCount);
    push(d.segBox);
    push(d.segFirstCluster);
    push(d.clusterBox);
    push(d.clusterSeg);
    push(d.clusterOrder);
    push(d.treeBox);
    push(d.treeLink);
  }
  return transfer;
}

/**
 * Run one request and return the response plus the buffers that may be
 * transferred back.
 *
 * Exported so the suite can exercise the worker body — and a mock worker
 * transport can run the REAL worker code — without spawning a `Worker`.
 */
export function handlePickBuildRequest(request: PickBuildRequest): {
  response: PickBuildResponse;
  transfer: Transferable[];
} {
  const { id, key, position, index, segments, options } = request;
  let response: PickBuildResponse;
  try {
    const result = buildPickStructure(position, index, segments, options);
    response = {
      id,
      key,
      ok: true,
      data: result.data,
      position,
      index: result.index,
      stats: result.stats,
    };
  } catch (err) {
    response = {
      id,
      key,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      position,
      index,
    };
  }
  return { response, transfer: responseTransferables(response) };
}

// Worker global scope.
const ctx = self as unknown as {
  onmessage: ((ev: { data: PickBuildRequest }) => void) | null;
  postMessage: (message: PickBuildResponse, transfer?: Transferable[]) => void;
};

// Only wire up the message pump when this module really IS a worker global —
// importing it from a main-thread test must not hijack `window.onmessage`.
if (
  typeof ctx.postMessage === 'function' &&
  typeof (globalThis as { document?: unknown }).document === 'undefined'
) {
  ctx.onmessage = (ev) => {
    const { response, transfer } = handlePickBuildRequest(ev.data);
    ctx.postMessage(response, transfer);
  };
}
