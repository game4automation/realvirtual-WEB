// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-merge-worker — Web Worker entry point for the mesh merger (plan-372, Phase 4).
 *
 * Not a second algorithm, only a second place to run the first one: it calls
 * `runMergeRequest()` from `rv-mesh-merge.ts`, the same function the client's synchronous
 * fallback calls. Nothing here touches the scene graph — no `Object3D`, no registry, no
 * viewer — which is what lets it live off-thread at all.
 *
 * Why off-thread: the bake transforms every vertex and every normal of every source, and
 * `mergeGeometries` then copies the lot once more. Plan-331 measured the comparable load
 * at > 50 ms from ~200k vertices and 380 ms at 1M — well past the point where a
 * main-thread run drops frames.
 *
 * The main thread still pays for classification, traversal and the attribute copy; the
 * NFR is deliberately "bake and merge off-thread", not the impossible "nothing on the
 * main thread".
 */

import { runMergeRequest, type MergeRequest, type MergeResponse } from './rv-mesh-merge';

// Worker global scope.
const ctx = self as unknown as {
  onmessage: ((ev: { data: MergeRequest }) => void) | null;
  postMessage: (msg: MergeResponse, transfer?: Transferable[]) => void;
};

/**
 * Runs one request and returns the response plus the buffers that may be transferred.
 *
 * Exported so the test suite can exercise the worker body without a real `Worker`.
 */
export function handleMergeRequest(request: MergeRequest): {
  response: MergeResponse;
  transfer: Transferable[];
} {
  const response = runMergeRequest(request);
  const transfer: Transferable[] = [];
  if (response.ok) {
    for (const part of response.parts) {
      if (!part) continue;
      for (const name of Object.keys(part.attributes)) {
        transfer.push(part.attributes[name].array.buffer as ArrayBuffer);
      }
      transfer.push(part.index.buffer as ArrayBuffer);
    }
  }
  return { response, transfer };
}

// Only wire up the message pump when this module really is a worker global. Importing it
// from a test on the main thread must not hijack `window.onmessage`.
if (typeof ctx.postMessage === 'function' && typeof (globalThis as { document?: unknown }).document === 'undefined') {
  ctx.onmessage = (ev) => {
    const { response, transfer } = handleMergeRequest(ev.data);
    ctx.postMessage(response, transfer);
  };
}
