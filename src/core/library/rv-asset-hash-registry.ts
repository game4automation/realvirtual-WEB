// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-hash-registry.ts — URL → expected SHA-256 of a library asset (plan-508 F4).
 *
 * The library catalog carries `sha256` + `sizeBytes` per asset. The blob cache
 * needs that hash to key and verify the bytes, but the hash lives in the
 * catalog and the loads happen far away from it: a planner drop, a hover
 * prefetch, a NESTED placement the instancer materialises, a splat. Threading
 * a hash field through `PlacementRef` → `PlacementSource` → `AcquiredAsset`
 * and every call site was the rejected design; instead the catalog normalizer
 * fills this registry and the loaders look the hash up BY URL.
 *
 * Keys are the canonical absolute url ({@link cacheKeyFor} without a hash) AND
 * the BASE_URL-relative form (`rebaseLocalLibraryUrl`), so `/library/x.glb`,
 * `http://host/library/x.glb` and a scene saved on another deploy
 * (`/demo/library/x.glb`) all find the same entry. A registry-resolved asset
 * (a project document, `resolved:<provider>:<source>:<entry>`) is registered
 * under that key verbatim.
 *
 * The hash is for INTEGRITY and CACHE KEYS only — never a resolution key
 * (`rv-glb-reference-resolver.ts`: a library correction must not break old
 * references). Entries are never removed by a catalog without a hash: a second
 * catalog that lacks the field must not disarm a first one that has it. When two
 * catalogs name one url with different hashes, the last one normalized wins.
 *
 * Core, React-free, no planner dependency.
 */

import { rebaseLocalLibraryUrl } from './rv-placement-source';

/** What the registry knows about one asset. */
export interface AssetHashInfo {
  /** SHA-256 of the bytes, hex, lowercase, 64 chars. */
  sha256: string;
  /** File size in bytes, when the catalog says. */
  sizeBytes?: number;
}

/** Namespace prefix of a registry-resolved cache key (`ModelCache` re-exports it). */
export const RESOLVED_KEY_PREFIX = 'resolved:';

/**
 * The stable cache key of a library-registry asset: `resolved:<provider>:<source>:<entry>`.
 * `ModelCache.resolvedCacheKey` IS this function — one spelling for the cache and the registry.
 */
export function resolvedAssetKey(providerId: string, sourceId: string, entryId: string): string {
  return `${RESOLVED_KEY_PREFIX}${providerId}:${sourceId}:${entryId}`;
}

/** Query parameter that carries the hash inside a cache key. */
export const CACHE_KEY_HASH_PARAM = '__rvsha';

const SHA256_RE = /^[0-9a-f]{64}$/;

/** True for a lowercase-hex SHA-256 string. */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function pageHref(): string | undefined {
  try {
    return typeof location !== 'undefined' && location?.href ? location.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE cache key of an asset url, used for storing, looking up and cleaning up
 * in BOTH tiers of `RVAssetBlobCache` (in-memory `_pending` and the Cache API):
 *
 *   u = new URL(url, location.href); u.hash = '';
 *   if (sha256) u.searchParams.set('__rvsha', sha256);
 *   return u.href;
 *
 * The fragment is dropped because the Cache API ignores it when matching — a
 * hash placed there would make `a.glb#x` under H2 hit the H1 entry. The network
 * request keeps using the original url; this string is only ever a key.
 * `resolved:` keys and urls that cannot be parsed are kept verbatim (minus the
 * fragment), with the hash appended as a query parameter.
 */
export function cacheKeyFor(url: string, sha256?: string): string {
  if (!url.startsWith(RESOLVED_KEY_PREFIX)) {
    try {
      const u = new URL(url, pageHref());
      u.hash = '';
      if (sha256) u.searchParams.set(CACHE_KEY_HASH_PARAM, sha256);
      return u.href;
    } catch { /* relative url without a page (node), or unparsable — manual form below */ }
  }
  const hashAt = url.indexOf('#');
  const bare = hashAt >= 0 ? url.slice(0, hashAt) : url;
  if (!sha256) return bare;
  return `${bare}${bare.includes('?') ? '&' : '?'}${CACHE_KEY_HASH_PARAM}=${sha256}`;
}

/** The cache key of `url` with any `__rvsha` parameter removed — "the same url, any version". */
export function unversionedCacheKey(key: string): string {
  if (!key.includes(CACHE_KEY_HASH_PARAM)) return key;
  try {
    const u = new URL(key);
    u.searchParams.delete(CACHE_KEY_HASH_PARAM);
    return u.href;
  } catch {
    return key.replace(new RegExp(`[?&]${CACHE_KEY_HASH_PARAM}=[0-9a-f]*`), '');
  }
}

const _hashes = new Map<string, AssetHashInfo>();
const _listeners = new Set<(key: string) => void>();

/** Every registry key `url` is known under: canonical, plus the BASE_URL-relative form. */
function keysOf(url: string): string[] {
  const keys = [cacheKeyFor(url)];
  if (!url.startsWith(RESOLVED_KEY_PREFIX)) {
    const rebased = rebaseLocalLibraryUrl(url);
    if (rebased) {
      const k = cacheKeyFor(rebased);
      if (k !== keys[0]) keys.push(k);
    }
  }
  return keys;
}

/**
 * Record the expected hash of the asset behind `url`. A malformed hash is
 * ignored (a hand-written catalog must not break loads); an unchanged one is a
 * no-op. Listeners hear every key whose hash actually CHANGED.
 */
export function setAssetHash(url: string, info: AssetHashInfo): void {
  if (!url || !info || !isSha256(info.sha256)) return;
  const record: AssetHashInfo = typeof info.sizeBytes === 'number' && Number.isFinite(info.sizeBytes)
    ? { sha256: info.sha256, sizeBytes: info.sizeBytes }
    : { sha256: info.sha256 };
  for (const key of keysOf(url)) {
    const prev = _hashes.get(key);
    if (prev && prev.sha256 === record.sha256 && prev.sizeBytes === record.sizeBytes) continue;
    _hashes.set(key, record);
    if (prev && prev.sha256 === record.sha256) continue; // only the size was new — no version change
    for (const listener of [..._listeners]) {
      try { listener(key); } catch (err) { console.warn('[asset-hash-registry] listener failed:', err); }
    }
  }
}

/** The expected hash of the asset behind `url`, or null when no catalog named it with one. */
export function hashForUrl(url: string): AssetHashInfo | null {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  for (const key of keysOf(url)) {
    const hit = _hashes.get(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Hear about every key whose hash changed (a catalog re-normalized mid-session).
 * Returns the unsubscribe function.
 */
export function subscribeAssetHashes(listener: (key: string) => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Number of registered keys (diagnostics / tests). */
export function assetHashCount(): number {
  return _hashes.size;
}

/** Forget every hash — tests only; a running app never un-learns a catalog. */
export function clearAssetHashes(): void {
  _hashes.clear();
}
