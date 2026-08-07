// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * empty-glb — Synthesizes a minimal valid GLB binary at runtime.
 *
 * Used by the Scene window when starting a new Layout: rather than
 * leaving the demo scene visible (or shipping a separate `empty.glb`
 * asset), we feed the existing `loadModel` pipeline a tiny in-memory
 * GLB so all of its side-effects fire (raycastManager rebuild, signal
 * store reset, etc.) and the viewer ends up in a clean state.
 *
 * GLB binary format (glTF 2.0 spec):
 *   Header  : 12 bytes — magic 'glTF', version 2, total length
 *   Chunk 0 : 8-byte header (length, type='JSON') + JSON payload (4-byte aligned with spaces)
 */

const GLB_MAGIC = 0x46546c67;          // 'glTF' little-endian
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;    // 'JSON' little-endian

let _cachedUrl: string | null = null;

/** Build the minimal empty-scene glTF JSON document. */
function emptySceneJson(): string {
  return JSON.stringify({
    asset: { version: '2.0', generator: 'realvirtual-empty-scene' },
    scene: 0,
    scenes: [{}],
  });
}

/**
 * The minimal valid GLB as a blob.
 *
 * Exported because a new *asset* has to be written to disk, not just handed to
 * a loader: "New asset" creates a row that survives a reload, which means real
 * bytes in the project's `library/` rather than an in-memory URL.
 */
export function buildEmptyGlbBlob(): Blob {
  // 1) JSON chunk payload — must be 4-byte aligned, pad with spaces (0x20).
  const enc = new TextEncoder();
  let json = emptySceneJson();
  while (json.length % 4 !== 0) json += ' ';
  const jsonBytes = enc.encode(json);

  // 2) Allocate buffer: 12-byte header + 8-byte chunk header + JSON
  const totalLen = 12 + 8 + jsonBytes.byteLength;
  const buf = new ArrayBuffer(totalLen);
  const view = new DataView(buf);

  // 3) GLB header
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLen, true);

  // 4) JSON chunk header
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, CHUNK_TYPE_JSON, true);

  // 5) JSON payload
  new Uint8Array(buf, 20, jsonBytes.byteLength).set(jsonBytes);

  return new Blob([buf], { type: 'model/gltf-binary' });
}

/**
 * Cached blob: URL pointing at an in-memory empty GLB. Same URL is reused
 * across calls so the GLTFLoader can hit its own cache and so we avoid
 * leaking a new blob: URL each time the user creates a new layout.
 */
export function getEmptyGlbUrl(): string {
  if (!_cachedUrl) _cachedUrl = URL.createObjectURL(buildEmptyGlbBlob());
  return _cachedUrl;
}
