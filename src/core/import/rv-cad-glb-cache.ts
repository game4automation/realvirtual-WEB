// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cad-glb-cache — the durable, content-addressed store of CONVERTED GLB bytes.
 *
 * GLB is the single source of truth. Every import (STEP, USD, .glb file, catalog
 * entry) is converted to GLB bytes exactly once, stored here under the content
 * hash of the ORIGINAL file, and then loaded from these bytes. Import and reload
 * therefore parse the same bytes and produce an identical tree — which is what
 * makes the asset editor's op log (which addresses nodes by name path) stable
 * across a refresh.
 *
 * Two tiers:
 *
 *   1. **OPFS blob store** (`core/storage/rv-opfs-blobs`) — content-addressed,
 *      origin-private, effectively unbounded, and available in every modern
 *      browser *including* Firefox and Safari.
 *
 *      **plan-372 §5.4, decided in Phase 11 (Option 2).** Tier 1 used to be
 *      `<workfolder>/.cad-cache/`. The working folder is being retired, and a
 *      cache may live neither in the project nor in the workspace (plan-370
 *      §1.1 R4) — it is derived data and must never travel with a git-managed
 *      project. OPFS satisfies both constraints, the store already existed from
 *      Phase 2, and it hands the unbounded tier to Firefox and Safari, which
 *      previously had only the bounded Cache-API fallback.
 *
 *      The store keys on a sha256 and validates that shape as its path-traversal
 *      guard, so the composite `(version, sha256, quality)` identity is folded
 *      into one hash — see `opfsKey`.
 *
 *   2. **Cache API** (`rv-cad-glbs`) — the fallback when OPFS is unavailable.
 *      Bounded by a BYTE budget with true LRU eviction. The user agent may still
 *      evict the whole origin under storage pressure, so callers must treat a
 *      miss as recoverable (re-tessellate, or prompt for a re-pick).
 *
 * This module lives in the PUBLIC core on purpose: draft replay of an `importCad`
 * op resolves geometry from here, so a public build (which has no OCCT provider)
 * can reopen a draft containing STEP imports. It must never import from
 * `@rv-private` — `tests/private-internal-gate.node.test.ts` guards that.
 */

import {
  deleteBlob,
  getBlobUrl,
  isOpfsSupported,
  listBlobs,
  putBlob,
} from '../storage/rv-opfs-blobs';

/**
 * Legacy working-folder subdirectory that used to hold converted GLBs.
 *
 * Kept exported only so a future cleanup pass can still find it; nothing writes
 * there any more.
 *
 * @deprecated Tier 1 is the OPFS blob store since plan-372 Phase 11 (§5.4).
 */
export const CAD_CACHE_FOLDER = '.cad-cache';

/** Cache-API bucket used when OPFS is unavailable. */
const CAD_GLB_BUCKET = 'rv-cad-glbs';

/**
 * Bumped whenever the meaning of a `(sha256, quality)` key changes — e.g. when a
 * quality preset's tessellation parameters are retuned under the same preset id.
 * Without this, a stale GLB tessellated with the old numbers would be served for
 * a preset the user believes they changed.
 */
const CACHE_VERSION = 'v1';

/** Byte budget for the Cache-API tier. The OPFS tier is effectively unbounded. */
const MAX_CACHE_BYTES = 512 * 1024 * 1024;

/** Header carrying the entry's byte length, so eviction never reads a body. */
const SIZE_HEADER = 'x-rv-size';

const GLB_MIME = 'model/gltf-binary';

// ─── Keys ────────────────────────────────────────────────────────────────

/** Filesystem-safe quality token (preset ids are already tame; be defensive). */
function qualityToken(quality: string): string {
  const cleaned = quality.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return cleaned || 'default';
}

/** `<version>.<sha256>.<quality>.glb` — the Cache-API entry name. */
export function cadGlbFileName(sha256: string, quality: string): string {
  return `${CACHE_VERSION}.${sha256}.${qualityToken(quality)}.glb`;
}

/** Synthetic but deterministic URL under which the Cache API stores an entry. */
function cacheUrl(sha256: string, quality: string): string {
  return `https://rv-cad-cache.local/${cadGlbFileName(sha256, quality)}`;
}

// ─── OPFS tier ───────────────────────────────────────────────────────────

/**
 * Keys this module has written this session.
 *
 * The OPFS store is shared with the project blob store, and its keys are opaque
 * hashes — there is no way to tell a CAD entry from a project asset by looking
 * at it. Clearing the CAD cache must therefore never sweep the store; it can
 * only remove what it knows it put there.
 */
const cadOpfsKeys = new Set<string>();

/**
 * Composite cache key, folded into a single sha256.
 *
 * The OPFS store validates every key against a strict sha256 regex — that regex
 * IS its path-traversal guard, so a composite like `<sha>-<quality>` would be
 * (correctly) rejected. Hashing the tuple keeps one opaque, valid key while
 * still separating qualities and cache versions from one another.
 */
async function opfsKey(sha256: string, quality: string): Promise<string> {
  const material = `${CACHE_VERSION}:${sha256}:${qualityToken(quality)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function readFromOpfs(sha256: string, quality: string): Promise<ArrayBuffer | null> {
  if (!isOpfsSupported()) return null;
  try {
    const resolved = await getBlobUrl(await opfsKey(sha256, quality));
    if (!resolved) return null;
    try {
      return await (await fetch(resolved.url)).arrayBuffer();
    } finally {
      // The store hands out an owned object URL; free it in every path.
      resolved.revokeUrl();
    }
  } catch {
    return null;
  }
}

async function writeToOpfs(sha256: string, quality: string, bytes: ArrayBuffer): Promise<boolean> {
  if (!isOpfsSupported()) return false;
  try {
    const key = await opfsKey(sha256, quality);
    await putBlob(key, new Blob([bytes], { type: GLB_MIME }));
    cadOpfsKeys.add(key);
    return true;
  } catch {
    return false;
  }
}

// ─── Cache-API tier ──────────────────────────────────────────────────────

function cacheApiAvailable(): boolean {
  return typeof caches !== 'undefined';
}

/** Sum the recorded sizes of every entry without reading a single body. */
async function bucketBytes(cache: Cache, keys: readonly Request[]): Promise<number> {
  let total = 0;
  for (const req of keys) {
    const resp = await cache.match(req);
    total += Number(resp?.headers.get(SIZE_HEADER) ?? 0);
  }
  return total;
}

/**
 * Evict oldest-first until the bucket fits the byte budget. `cache.keys()`
 * returns insertion order, and `readFromCacheApi` re-inserts on every hit, so
 * insertion order IS recency order — this is a true LRU, not the FIFO it
 * replaces (which evicted a still-hot entry after 8 imports).
 */
async function enforceByteBudget(cache: Cache): Promise<void> {
  let keys = await cache.keys();
  let total = await bucketBytes(cache, keys);
  while (total > MAX_CACHE_BYTES && keys.length > 1) {
    const victim = keys[0];
    const resp = await cache.match(victim);
    total -= Number(resp?.headers.get(SIZE_HEADER) ?? 0);
    await cache.delete(victim);
    keys = keys.slice(1);
  }
}

async function readFromCacheApi(sha256: string, quality: string): Promise<ArrayBuffer | null> {
  if (!cacheApiAvailable()) return null;
  try {
    const cache = await caches.open(CAD_GLB_BUCKET);
    const url = cacheUrl(sha256, quality);
    const hit = await cache.match(url);
    if (!hit) return null;
    const bytes = await hit.clone().arrayBuffer();
    // Touch: delete + re-put moves the entry to the end of insertion order, so
    // `enforceByteBudget` evicts genuinely cold entries rather than merely old
    // ones. Best effort — a failed touch only degrades eviction quality.
    try {
      await cache.delete(url);
      await cache.put(url, hit);
    } catch { /* ignore */ }
    return bytes;
  } catch {
    return null;
  }
}

async function writeToCacheApi(sha256: string, quality: string, bytes: ArrayBuffer): Promise<boolean> {
  if (!cacheApiAvailable()) return false;
  try {
    const cache = await caches.open(CAD_GLB_BUCKET);
    const resp = new Response(bytes, {
      headers: { 'Content-Type': GLB_MIME, [SIZE_HEADER]: String(bytes.byteLength) },
    });
    await cache.put(cacheUrl(sha256, quality), resp);
    await enforceByteBudget(cache);
    return true;
  } catch {
    // Cache API unavailable (private browsing, file://) or quota exceeded.
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/** SHA-256 of a buffer as lowercase hex — the identity of an imported file. */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** Outcome of {@link putCadGlb}: which tier accepted the bytes. */
export type CadCacheTier = 'opfs' | 'cache-api' | 'none';

/**
 * Store converted GLB bytes under `(sha256, quality)`.
 *
 * OPFS first, Cache API otherwise. Returns the tier that accepted the
 * write — `'none'` means nothing durable happened and the caller should surface
 * the same "will NOT survive a reload" degradation that `persistImportedGlb`
 * reports, rather than pretending the import is safe.
 */
export async function putCadGlb(
  sha256: string,
  quality: string,
  bytes: ArrayBuffer,
): Promise<CadCacheTier> {
  if (await writeToOpfs(sha256, quality, bytes)) return 'opfs';
  if (await writeToCacheApi(sha256, quality, bytes)) return 'cache-api';
  return 'none';
}

/**
 * Retrieve converted GLB bytes for `(sha256, quality)`, or null on a miss.
 *
 * A miss is recoverable, never fatal: the CAD provider can re-tessellate from
 * its cached source bytes, and failing that the user is prompted to re-pick the
 * file. Never prompts for filesystem permission — safe to call at boot.
 */
export async function getCadGlb(sha256: string, quality: string): Promise<ArrayBuffer | null> {
  return (await readFromOpfs(sha256, quality)) ?? (await readFromCacheApi(sha256, quality));
}

/** True when the bytes are already cached (no read of the body). */
export async function hasCadGlb(sha256: string, quality: string): Promise<boolean> {
  return (await getCadGlb(sha256, quality)) !== null;
}

/** Wipe both tiers. Used by dev tools and tests. */
export async function clearCadGlbCache(): Promise<void> {
  try {
    // The OPFS store is shared with the project blob store and its keys are
    // opaque hashes — nothing distinguishes a CAD entry from a project asset by
    // looking at it. So this removes only what this module put there, and never
    // sweeps the store.
    const known = await listBlobs();
    for (const key of known) {
      if (cadOpfsKeys.has(key)) await deleteBlob(key).catch(() => undefined);
    }
    cadOpfsKeys.clear();
  } catch { /* ignore */ }
  if (cacheApiAvailable()) {
    try { await caches.delete(CAD_GLB_BUCKET); } catch { /* ignore */ }
  }
}

/**
 * Total bytes currently held across both cache tiers — for a "Clear CAD import
 * cache (X MB)" affordance. Best-effort and read-only: the working-folder tier
 * uses the no-prompt read handle, the Cache-API tier sums recorded size headers
 * without reading bodies. Zero when nothing is cached / storage is unavailable.
 */
export async function getCadGlbCacheSize(): Promise<number> {
  // The OPFS tier is deliberately not summed: its keys are opaque hashes shared
  // with the project blob store, so attributing bytes to CAD would mean reading
  // every blob in the origin. Under-reporting beats a slow lie.
  let total = 0;
  if (cacheApiAvailable()) {
    try {
      const cache = await caches.open(CAD_GLB_BUCKET);
      total += await bucketBytes(cache, await cache.keys());
    } catch { /* ignore */ }
  }
  return total;
}
