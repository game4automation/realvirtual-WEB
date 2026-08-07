// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-gzip-utils.ts — generic gzip helpers on top of the browser-native
 * `CompressionStream` / `DecompressionStream` APIs (Chrome 80 / FF 113 /
 * Safari 16.4+).
 *
 * GENERIC by design (plan-261): lives in the PUBLIC repo so both public
 * consumers and the private DES plugin can use it (only private→public
 * imports are allowed, plan 194). It must never import feature types.
 */

/** True when the browser provides `CompressionStream` (gzip support). */
export function hasCompressionStream(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

/** Drain a ReadableStream into one contiguous Uint8Array. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Compress a string to a gzip ArrayBuffer. Throws when gzip is unavailable. */
export async function gzipString(data: string): Promise<ArrayBuffer> {
  const encoded = new TextEncoder().encode(data);
  const stream = new Blob([encoded]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = await drainStream(stream);
  // Return a tightly-sized ArrayBuffer (drainStream already copies).
  return bytes.buffer as ArrayBuffer;
}

/** Decompress a gzip ArrayBuffer (or view) back to a string. */
export async function gunzipToString(data: ArrayBuffer | Uint8Array): Promise<string> {
  const blob = new Blob([data instanceof Uint8Array ? (data as unknown as BlobPart) : data]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = await drainStream(stream);
  return new TextDecoder().decode(bytes);
}

/** Compress a string to a gzip Blob (e.g. for file downloads). */
export async function gzipStringToBlob(data: string, mime = 'application/gzip'): Promise<Blob> {
  const buf = await gzipString(data);
  return new Blob([buf], { type: mime });
}

/** Decompress a gzip Blob back to a string. */
export async function gunzipBlobToString(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return gunzipToString(buf);
}
