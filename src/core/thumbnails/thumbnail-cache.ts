// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ThumbnailCache — persistent store for auto-generated library preview PNGs
 * (moved out of the Layout Planner in plan-372 Phase 5).
 *
 * Backed by the Cache API (same approach as `rv-asset-blob-cache.ts`) so
 * previews survive reloads and large libraries don't re-decode + re-render
 * every session. Unlike the GLB blob cache this stores *generated* blobs (it
 * never fetches the key), so it exposes an explicit `put`. All methods degrade
 * to a silent no-op when the Cache API is unavailable (private mode / file://)
 * — callers simply fall back to regenerating in-memory.
 *
 * ## What changed with the move
 *
 * The cache no longer knows anything about GLB URLs. It takes the opaque,
 * stable key from {@link buildThumbnailKey} (`projectId:providerId:sourceId:
 * assetId[:version]`). That is the whole point of the move: the previous
 * `glbUrl` key collided across projects and missed on every reload for
 * blob-backed sources — see `thumbnail-key.ts` for the reasoning.
 *
 * ## Legacy entries are discarded, not migrated
 *
 * Old entries are keyed by a URL we can no longer map back to an asset
 * identity: from `https://x/library/belt.glb` alone there is no way to tell
 * which project, provider or source it belonged to, so a rewrite would have to
 * guess — and a wrong guess shows one asset's picture on another asset's card.
 * Previews are cheap, derived data, so the honest move is to drop them and let
 * them regenerate. That happens exactly once, via a versioned bucket name: the
 * new bucket starts empty and the old one is deleted in the background.
 *
 * ## The same applies to a render-quality change
 *
 * Bucket v3 (plan-712) is not a key-format change: the keys are identical, the
 * *pictures* changed (256px flat renders → 512px supersampled renders with AO
 * and a contact shadow). Since the size is deliberately not part of the key,
 * the bucket name is the only invalidation lever there is — without the bump
 * every card would keep serving its old 256px blob forever.
 */

const LEGACY_BUCKET = 'rv-planner-thumbnails';

/** Superseded buckets, deleted once per session. `rv-thumbnails-v3` held the
 *  short-lived plan-712 previews with the too-bright ambient fill (see the
 *  plan's `## Fix 2026-08-12`); `rv-thumbnails-v2` the pre-plan-712 256px
 *  previews; `rv-planner-thumbnails` the pre-plan-372 glbUrl-keyed ones. */
const SUPERSEDED_BUCKETS = ['rv-thumbnails-v3', 'rv-thumbnails-v2', LEGACY_BUCKET];

/** Bucket name for the current preview generation. Bump on any key-format
 *  change AND on any change to how previews look. */
export const THUMBNAIL_BUCKET_V4 = 'rv-thumbnails-v4';

/** Guards the one-time legacy purge per bucket name (module-scope, per document). */
const _purged = new Set<string>();

export class ThumbnailCache {
  private readonly _bucket: string;
  /** Set once the legacy purge for this instance has been kicked off. */
  private _purgeStarted = false;

  constructor(bucket = THUMBNAIL_BUCKET_V4) {
    this._bucket = bucket;
  }

  /**
   * Delete every superseded bucket once per session. Best-effort and
   * deliberately un-awaited by callers: failing to free old previews must never
   * keep a card from rendering.
   */
  private _purgeLegacyOnce(): void {
    if (this._purgeStarted) return;
    this._purgeStarted = true;
    // Only the default bucket supersedes the older ones; a test bucket must not
    // delete a real user's cache.
    if (this._bucket !== THUMBNAIL_BUCKET_V4) return;
    for (const bucket of SUPERSEDED_BUCKETS) {
      if (_purged.has(bucket)) continue;
      _purged.add(bucket);
      try {
        void Promise.resolve(caches.delete(bucket)).catch(() => { /* ignore */ });
      } catch { /* Cache API unavailable — nothing to purge */ }
    }
  }

  /** Cache API keys must be http(s) Requests; wrap the stable key in a synthetic one. */
  private _key(key: string): string {
    return `https://rv-thumb.local/${encodeURIComponent(key)}`;
  }

  /**
   * Return a fresh object URL for a cached preview, or null on miss/unsupported.
   * Caller owns the returned URL (revoke when the entry is replaced).
   *
   * @param key stable key from {@link buildThumbnailKey}
   */
  async get(key: string): Promise<string | null> {
    this._purgeLegacyOnce();
    try {
      const cache = await caches.open(this._bucket);
      const hit = await cache.match(this._key(key));
      if (!hit) return null;
      return URL.createObjectURL(await hit.blob());
    } catch {
      return null;
    }
  }

  /**
   * Store a generated preview PNG blob under the asset's stable key.
   *
   * @param key stable key from {@link buildThumbnailKey}
   */
  async put(key: string, blob: Blob): Promise<void> {
    this._purgeLegacyOnce();
    try {
      const cache = await caches.open(this._bucket);
      await cache.put(
        this._key(key),
        new Response(blob, { headers: { 'Content-Type': 'image/png' } }),
      );
    } catch {
      /* quota / unsupported — fine, preview stays in-memory only */
    }
  }

  /** Wipe the persistent bucket (tooling / "regenerate all"). */
  async clear(): Promise<void> {
    try { await caches.delete(this._bucket); } catch { /* ignore */ }
  }
}
