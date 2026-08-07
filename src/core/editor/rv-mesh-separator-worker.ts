// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-separator-worker — Web Worker entry point for the mesh separator
 * (plan-331, Phase 2b).
 *
 * This is **not** a second algorithm, only a second place to run the first one: the
 * worker imports `rv-mesh-separator.ts` and calls exactly the same pure functions the
 * main thread would. It touches nothing from the scene graph — no `Object3D`, no
 * registry, no viewer — which is what lets it live off-thread at all.
 *
 * Why off-thread: the plan-331 spike measured the weld plus union-find plus attribute
 * copy at 63-380 ms on the 200k-1M vertex range that this feature actually targets
 * (a STEP/JT import arriving as one mesh), on a fast workstation. That is well past the
 * point where a main-thread run drops frames.
 *
 * Two phases, matching the UI flow: `analyze` (weld + union-find, produces the part count
 * for the confirmation dialog) and `extract` (attribute copy, runs only after the user
 * confirms). The preview therefore pays only for the cheaper half.
 *
 * The heavy lifting is in `rv-mesh-separator.ts`, which is environment-free and unit
 * tested directly. This shell is just the wiring to `self.onmessage` / `self.postMessage`.
 */

import {
  computeGroupPartitions,
  computeMeshIslands,
  deserializeGeometry,
  extractSubGeometry,
  serializeGeometryParts,
  type AttributeArray,
  type SeparateRequest,
  type SeparateResponse,
} from './rv-mesh-separator';

// Worker global scope.
const ctx = self as unknown as {
  onmessage: ((ev: { data: SeparateRequest }) => void) | null;
  postMessage: (msg: SeparateResponse, transfer?: Transferable[]) => void;
};

/**
 * Runs one request and returns the response plus the buffers that may be transferred.
 *
 * Exported so the test suite can exercise the worker body without a real `Worker`.
 */
export function handleSeparateRequest(request: SeparateRequest): {
  response: SeparateResponse;
  transfer: Transferable[];
} {
  try {
    if (request.phase === 'analyze') {
      const geom = deserializeGeometry(
        { position: { array: request.position, itemSize: 3, normalized: false } },
        request.index,
        request.groups,
      );
      const partitions =
        request.mode === 'groups'
          ? computeGroupPartitions(geom)
          : computeMeshIslands(geom, request.resolution);
      return {
        response: { id: request.id, ok: true, phase: 'analyze', partitions },
        transfer: [],
      };
    }

    const geom = deserializeGeometry(request.attributes, request.index);
    const parts: { attributes: Record<string, { array: AttributeArray; itemSize: number; normalized: boolean }>; index: Uint32Array }[] = [];
    const transfer: Transferable[] = [];

    for (const partition of request.partitions) {
      const part = serializeGeometryParts(extractSubGeometry(geom, partition));
      parts.push(part);
      for (const name of Object.keys(part.attributes)) {
        transfer.push(part.attributes[name].array.buffer as ArrayBuffer);
      }
      transfer.push(part.index.buffer as ArrayBuffer);
    }

    return { response: { id: request.id, ok: true, phase: 'extract', parts }, transfer };
  } catch (err) {
    return {
      response: { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) },
      transfer: [],
    };
  }
}

// Only wire up the message pump when this module really is a worker global. Importing it
// from a test on the main thread must not hijack `window.onmessage`.
if (typeof ctx.postMessage === 'function' && typeof (globalThis as { document?: unknown }).document === 'undefined') {
  ctx.onmessage = (ev) => {
    const { response, transfer } = handleSeparateRequest(ev.data);
    ctx.postMessage(response, transfer);
  };
}
