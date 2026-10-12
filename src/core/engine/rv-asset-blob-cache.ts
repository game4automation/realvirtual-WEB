// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-blob-cache.ts — URL → Blob cache.
 *
 * Two-tier cache for binary assets (GLB, splat, pcd, ply, …):
 *
 *   1. In-memory `Map<key, Promise<Blob>>` — survives the current session and
 *      deduplicates concurrent fetches for the same key.
 *   2. Browser Cache API (per-bucket) — survives page reload.
 *
 * Both tiers are addressed with ONE key (plan-508 F3): `cacheKeyFor(url,
 * sha256)` — the canonical absolute url, fragment removed, and, when the
 * library catalog knows the asset's SHA-256, `?__rvsha=<hash>`. The network
 * request always uses the original url.
 *
 *  - WITH a hash the cache is content-addressed: a hit under the key is served
 *    as is (it was verified when stored — not re-hashed, 30 MB would cost tens
 *    of ms on a phone), a miss downloads, hashes and stores only verified
 *    bytes. A mismatch evicts, refetches ONCE with `cache: 'reload'` (the
 *    browser's HTTP cache could hold the same outdated bytes) and then fails
 *    loudly — unverified bytes are never served. After a successful store the
 *    other versions of the same url are dropped from both tiers, so each url
 *    holds exactly one version.
 *  - WITHOUT a hash (a catalog that has none) the pre-plan-508 behaviour stays:
 *    content check on the way in and out, same-origin conditional GET.
 *
 * Every exit records one outcome in `rv-asset-cache-outcomes.ts`
 * (`web_status.cache`, DevTools › Render › Asset cache).
 *
 * Decoded forms (Three.js Group, GS3D.SplatMesh, …) are NOT this cache's
 * concern. Callers that benefit from a decoded cache (e.g. ModelCache.clone())
 * wrap this layer.
 *
 * Blob URLs (`blob:`) are returned unchanged — no fetch, no caching — since
 * the bytes already live in the browser.
 */

import { cacheKeyFor, isSha256, unversionedCacheKey } from '../library/rv-asset-hash-registry';
import { sha256Hex } from '../import/rv-cad-glb-cache';
import { recordCacheOutcome, setCachePersisted, type CacheOutcome } from './rv-asset-cache-outcomes';

interface AssetBlobCacheOptions {
  /** Cache API bucket name (e.g. `rv-assets-glb-v2`). One bucket per asset type. */
  bucket: string;
  /**
   * Bucket names of earlier versions of this cache (e.g. `rv-planner-glbs`).
   * Deleted once per session, best effort, the first time the bucket is
   * opened (plan-508 F9). Exact names only — never a prefix match.
   */
  legacyBuckets?: readonly string[];
  /**
   * Content check applied to every blob before it is handed out — and, for a
   * Cache API hit, before it is trusted. A blob that fails is never stored;
   * a stored one that fails is evicted and fetched again from the network.
   *
   * Why this exists (2026-09-26, DemoPlanner): the persistent tier served hits
   * without ever revalidating them, and a dev server answers an unknown path
   * with its `index.html` and status 200. One such answer, cached once under a
   * GLB url (the library moved from `models/library/` to `library/` at some
   * point), stayed the "bytes" of that asset for the life of the browser
   * profile — every load of it failed with a parse error while the file on
   * disk and on the wire was fine, and the Problems panel called it "not
   * found". Returns a reason when the blob is NOT acceptable, `null` when it is.
   */
  reject?: (blob: Blob, url: string) => Promise<string | null>;
}

/** Per-request options of {@link RVAssetBlobCache.getBlob}. */
export interface GetBlobOptions {
  /**
   * Expected SHA-256 (hex, lowercase) of the bytes, from the library catalog
   * via `hashForUrl`. Present: the key is url + hash and every network answer
   * is verified. A malformed value is ignored (treated as absent).
   */
  sha256?: string;
}

/**
 * The stock content check for GLB buckets: the first four bytes must be the
 * `glTF` magic. Catches HTML fallbacks, error pages and truncated-to-zero
 * bodies without reading more than a header.
 */
export async function rejectUnlessGlb(blob: Blob, _url: string): Promise<string | null> {
  if (blob.size < 12) return `${blob.size} bytes — too short for a GLB header`;
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (magic === 'glTF') return null;
  const isHtml = /^\s*</.test(magic) || (blob.type || '').includes('text/html');
  return isHtml
    ? `not a GLB — the response is an HTML page (${blob.type || 'no content-type'})`
    : `not a GLB — magic "${magic.replace(/[^\x20-\x7e]/g, '?')}" (${blob.type || 'no content-type'})`;
}

/** True for a url on the page's own origin (or a relative one). */
function isSameOrigin(url: string): boolean {
  if (typeof location === 'undefined') return true;
  try { return new URL(url, location.href).origin === location.origin; }
  catch { return false; }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** The url a Cache API `keys()` entry stands for (a `Request`, or a string in test doubles). */
function requestUrl(entry: Request | string): string {
  return typeof entry === 'string' ? entry : entry.url;
}

export class RVAssetBlobCache {
  private _pending = new Map<string, Promise<Blob>>();
  private readonly _bucket: string;
  private readonly _legacyBuckets: readonly string[];
  private readonly _reject: AssetBlobCacheOptions['reject'];
  private _legacySwept = false;
  private _persistAsked = false;

  constructor(options: AssetBlobCacheOptions) {
    this._bucket = options.bucket;
    this._legacyBuckets = options.legacyBuckets ?? [];
    this._reject = options.reject;
  }

  /** The Cache API bucket this cache writes. */
  get bucket(): string { return this._bucket; }

  /**
   * Fetch (or hit cache for) the blob behind `url`. Concurrent calls for the
   * same KEY (url + hash) share a single Promise; two asks for one url with
   * different hashes are two requests. Returns the original blob — callers
   * decide whether to `URL.createObjectURL` it.
   *
   * For `blob:` and `data:` URLs the cache is bypassed (their bytes are
   * already local; no benefit to copying them through the Cache API).
   */
  async getBlob(url: string, opts?: GetBlobOptions): Promise<Blob> {
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      const resp = await fetch(url);
      return resp.blob();
    }
    const sha256 = isSha256(opts?.sha256) ? opts!.sha256 : undefined;
    const key = cacheKeyFor(url, sha256);

    const pending = this._pending.get(key);
    if (pending) return pending;

    const promise = this._fetchWithBucket(url, key, sha256);
    this._pending.set(key, promise);
    promise.then(
      () => { if (sha256) this._dropOtherPending(key); },
      () => { if (this._pending.get(key) === promise) this._pending.delete(key); },
    );
    return promise;
  }

  /**
   * Same as `getBlob()` but returns a freshly created blob URL ready to hand
   * to a loader. Caller is responsible for `URL.revokeObjectURL()` once the
   * loader has consumed it.
   */
  async getObjectUrl(url: string, opts?: GetBlobOptions): Promise<string> {
    const blob = await this.getBlob(url, opts);
    return URL.createObjectURL(blob);
  }

  /** Open the bucket; the first open of a session deletes the legacy buckets. */
  private async _open(): Promise<Cache> {
    if (!this._legacySwept) {
      this._legacySwept = true;
      for (const name of this._legacyBuckets) {
        try { await caches.delete(name); } catch { /* best effort */ }
      }
    }
    return caches.open(this._bucket);
  }

  private _record(url: string, outcome: CacheOutcome, t0: number, bytes?: number, detail?: string): void {
    recordCacheOutcome({ bucket: this._bucket, url, outcome, bytes, ms: now() - t0, detail });
  }

  private async _fetchWithBucket(url: string, key: string, sha256: string | undefined): Promise<Blob> {
    const name = url.split('/').pop() ?? url;
    const t0 = now();
    let cache: Cache | null = null;
    let stale: { blob: Blob; etag: string | null; lastModified: string | null } | null = null;
    try {
      cache = await this._open();
      const hit = await cache.match(key);
      if (hit) {
        const blob = await hit.blob();
        const why = this._reject ? await this._reject(blob, url) : null;
        if (why === null) {
          const etag = hit.headers.get('etag');
          const lastModified = hit.headers.get('last-modified');
          if (!sha256 && (etag || lastModified) && isSameOrigin(url)) {
            // A valid hit WITHOUT a catalog hash is REVALIDATED, not trusted:
            // the server is asked whether these bytes are still current (one
            // conditional GET — a 304 costs no body, a 200 IS the download of
            // the new file). Before this, an edited library GLB never reached a
            // browser that had loaded it once (2026-09-22 `EuropalletLoaded.glb`,
            // `GenerateIfDistance`; seen again 2026-09-26 in the planner demo).
            // Cross-origin urls keep the old trust-the-hit behaviour: the
            // conditional headers would force a CORS preflight the host may
            // not answer. WITH a hash the key IS the version — nothing to ask.
            stale = { blob, etag, lastModified };
          } else {
            console.log(`[blob-cache:${this._bucket}] HIT  ${name} (${mb(blob.size)} MB${sha256 ? ', sha256 key' : ''})`);
            this._record(url, 'hit', t0, blob.size, sha256 ? `sha256 ${sha256.slice(0, 12)}…` : undefined);
            return blob;
          }
        } else {
          // A poisoned entry: drop it and take the network path below, so the
          // next reload does not fail the same way (2026-09-26, DemoPlanner).
          console.warn(`[blob-cache:${this._bucket}] EVICT ${name} — cached bytes rejected: ${why}`);
          this._record(url, 'evicted', t0, blob.size, why);
          await cache.delete(key).catch(() => false);
        }
      }
    } catch {
      // Cache API unavailable (private browsing, file://, …) — fall back to
      // a direct fetch so the caller still gets the bytes. Verified all the same.
      cache = null;
      stale = null;
    }

    let resp: Response;
    let outcome: CacheOutcome = 'miss';
    if (stale) {
      const headers: Record<string, string> = {};
      if (stale.etag) headers['If-None-Match'] = stale.etag;
      if (stale.lastModified) headers['If-Modified-Since'] = stale.lastModified;
      try {
        resp = await fetch(url, { headers });
      } catch {
        // Offline / server down: the cached bytes are the best we have.
        console.log(`[blob-cache:${this._bucket}] HIT  ${name} (${mb(stale.blob.size)} MB, revalidation unreachable)`);
        this._record(url, 'offline-hit', t0, stale.blob.size);
        return stale.blob;
      }
      if (resp.status === 304) {
        console.log(`[blob-cache:${this._bucket}] HIT  ${name} (${mb(stale.blob.size)} MB, revalidated)`);
        this._record(url, 'revalidated', t0, stale.blob.size);
        return stale.blob;
      }
      if (!resp.ok) {
        // The file is gone or the server is unhappy — do not paper over it
        // with old bytes forever; report like a plain miss would.
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      console.log(`[blob-cache:${this._bucket}] STALE ${name} → server has a newer file, replacing`);
      outcome = 'replaced';
    } else {
      resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    }

    for (let attempt = 1; ; attempt++) {
      if (resp.type === 'opaque') {
        // Status 0, no body: nothing to verify and nothing worth storing.
        this._record(url, 'rejected', t0, 0, 'opaque response');
        throw new Error(`${name}: the asset host sends no CORS headers (opaque response) for ${url}`);
      }
      // Clone BEFORE consuming so we can store and return the body once each.
      const forCache = cache ? resp.clone() : null;
      const blob = await resp.blob();
      const why = this._reject ? await this._reject(blob, url) : null;
      if (why !== null) {
        // Never store what we would refuse to serve — and say what came back
        // instead of letting the parser report a cryptic token error.
        this._record(url, 'rejected', t0, blob.size, why);
        throw new Error(`${name}: ${why} (HTTP ${resp.status}, ${blob.size} bytes) for ${url}`);
      }
      if (sha256) {
        const got = await sha256Hex(await blob.arrayBuffer());
        if (got !== sha256) {
          const detail = `expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}… (attempt ${attempt})`;
          console.warn(`[blob-cache:${this._bucket}] HASH MISMATCH ${name} — ${detail}`);
          this._record(url, 'hash-mismatch', t0, blob.size, detail);
          if (cache) await cache.delete(key).catch(() => false);
          if (attempt >= 2) {
            // Leads with "hash mismatch" on purpose: it is what the Problems
            // panel shows after "Load failed:" (plan-508 F5).
            throw new Error(`hash mismatch (expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — `
              + `${name}, ${blob.size} bytes, ${url}`);
          }
          // Once more, past the browser's HTTP cache: it may hold the very
          // bytes that just failed (an old response under the same url).
          resp = await fetch(url, { cache: 'reload' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
          continue;
        }
      }
      if (cache && forCache) {
        try {
          await cache.put(key, forCache);
          if (sha256) await this._dropOtherVersions(cache, key);
          await this._askPersistOnce();
        } catch { /* quota / unsupported — the caller still gets the bytes */ }
        console.log(`[blob-cache:${this._bucket}] ${outcome === 'replaced' ? 'REPLACED' : 'MISS'} ${name} → fetched ${mb(blob.size)} MB, `
          + `${sha256 ? 'verified, ' : ''}cached`);
        this._record(url, outcome, t0, blob.size, sha256 ? `sha256 ${sha256.slice(0, 12)}… verified` : undefined);
      } else {
        console.log(`[blob-cache:${this._bucket}] NO-CACHE ${name} → direct fetch ${mb(blob.size)} MB${sha256 ? ', verified' : ''}`);
        this._record(url, outcome, t0, blob.size, sha256 ? 'no Cache API — verified, not stored' : 'no Cache API');
      }
      return blob;
    }
  }

  /**
   * After a verified store under `key`: every other key of the same url (older
   * hashes, the unhashed legacy entry) leaves the bucket — one version per url.
   */
  private async _dropOtherVersions(cache: Cache, key: string): Promise<void> {
    const base = unversionedCacheKey(key);
    const entries = await cache.keys();
    for (const entry of entries) {
      const k = requestUrl(entry as Request | string);
      if (k !== key && unversionedCacheKey(k) === base) await cache.delete(entry).catch(() => false);
    }
  }

  /**
   * The in-memory twin of {@link _dropOtherVersions}: forget the other versions'
   * promises. A consumer that already holds one keeps it — only the map lets go.
   */
  private _dropOtherPending(key: string): void {
    const base = unversionedCacheKey(key);
    for (const k of [...this._pending.keys()]) {
      if (k !== key && unversionedCacheKey(k) === base) this._pending.delete(k);
    }
  }

  /**
   * Ask for persistent storage once per session, after the first successful
   * store (plan-508 F9): Safari evicts script-written storage after seven days
   * without interaction. The verdict shows in `web_status.cache.persisted`.
   */
  private async _askPersistOnce(): Promise<void> {
    if (this._persistAsked) return;
    this._persistAsked = true;
    try {
      const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (!storage) return;
      const already = storage.persisted ? await storage.persisted() : false;
      const granted = already || (storage.persist ? await storage.persist() : false);
      setCachePersisted(granted);
    } catch { /* not supported — stays null */ }
  }

  /**
   * Forget ONE url in both tiers — the key with `opts.sha256` AND the unhashed
   * key. The decode side calls this when bytes that passed the content check
   * still failed to parse, so the next ask fetches fresh instead of re-parsing
   * the same cached bytes forever.
   */
  async evict(url: string, opts?: GetBlobOptions): Promise<void> {
    const sha256 = isSha256(opts?.sha256) ? opts!.sha256 : undefined;
    const keys = [...new Set([cacheKeyFor(url, sha256), cacheKeyFor(url), url])];
    for (const k of keys) this._pending.delete(k);
    try {
      const cache = await caches.open(this._bucket);
      for (const k of keys) await cache.delete(k);
    } catch { /* Cache API unavailable — nothing persisted to drop */ }
  }

  /** Drop the in-memory tier. Cache API entries are kept (persistent layer). */
  clearMemory(): void {
    this._pending.clear();
  }

  /** Wipe the persistent Cache API bucket (and any legacy bucket still around). */
  async clearPersistent(): Promise<void> {
    try { await caches.delete(this._bucket); } catch { /* ignore */ }
    for (const name of this._legacyBuckets) {
      try { await caches.delete(name); } catch { /* ignore */ }
    }
  }
}
