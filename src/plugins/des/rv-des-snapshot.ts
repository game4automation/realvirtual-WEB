// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DESSnapshotV4 } from './rv-des-snapshot-v4';

const DB_NAME = 'rv-des-snapshots';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const COMPRESSION_THRESHOLD = 1 * 1024 * 1024; // 1MB

/**
 * Open the IndexedDB database for snapshot storage.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

/**
 * Check if CompressionStream is available.
 */
function hasCompressionStream(): boolean {
  return typeof CompressionStream !== 'undefined';
}

/**
 * Compress a string using CompressionStream (gzip).
 */
async function compressGzip(data: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stream = new Blob([encoder.encode(data)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

/**
 * Decompress a gzipped ArrayBuffer to string.
 */
async function decompressGzip(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

/**
 * Save a snapshot to IndexedDB.
 * Key format: `rv-des-state:{modelName}:{snapshotName}`
 */
export async function saveToStorage(
  modelName: string,
  snapshotName: string,
  snapshot: DESSnapshotV4,
): Promise<void> {
  const key = `rv-des-state:${modelName}:${snapshotName}`;
  const json = JSON.stringify(snapshot);

  let value: string | ArrayBuffer;
  let compressed = false;

  // Compress if large and CompressionStream is available
  if (json.length > COMPRESSION_THRESHOLD && hasCompressionStream()) {
    try {
      value = await compressGzip(json);
      compressed = true;
    } catch {
      value = json;
    }
  } else {
    value = json;
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Store metadata alongside the data
    store.put({ data: value, compressed, timestamp: Date.now() }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Load a snapshot from IndexedDB.
 */
export async function loadFromStorage(
  modelName: string,
  snapshotName: string,
): Promise<unknown> {
  const key = `rv-des-state:${modelName}:${snapshotName}`;

  const db = await openDB();
  const entry = await new Promise<{ data: string | ArrayBuffer; compressed: boolean } | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!entry) return null;

  let json: string;
  if (entry.compressed && entry.data instanceof ArrayBuffer) {
    json = await decompressGzip(entry.data);
  } else {
    json = entry.data as string;
  }

  return JSON.parse(json) as unknown;
}

/**
 * Delete a snapshot from IndexedDB.
 */
export async function deleteFromStorage(
  modelName: string,
  snapshotName: string,
): Promise<void> {
  const key = `rv-des-state:${modelName}:${snapshotName}`;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
