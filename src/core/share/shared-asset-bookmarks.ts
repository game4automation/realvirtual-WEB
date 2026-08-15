// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * "Add to my library" for a shared GLB (plan-386 §2.9, F13).
 *
 * ## Why this is the one place the receiver may write
 *
 * F7 says a shared link leaves nothing behind — and it means *nothing the
 * visitor did not ask for*. Clicking "add to my library" is the visitor asking.
 * Everything else on the consumer path still writes nothing at all; this store
 * is the single, deliberate exception, and it is keyed under its own name so
 * what it wrote is obvious and removable.
 *
 * ## Why a store of its own rather than the library store
 *
 * The obvious route was `libraryStore.addCatalog(url, 'user')`, and it does not
 * work: that call fetches the URL and parses it as JSON, which for a `.glb` is
 * a guaranteed parse error. `addCatalogDirect()` does not fetch — but it marks
 * the key as *bundled* and never persists it, so the bookmark would vanish on
 * reload, which is exactly what F13 forbids. So: own storage, own key, and
 * `addCatalogDirect()` used for what it is genuinely good at — projecting an
 * already-known catalogue into the library UI as one tab.
 *
 * A new `LibraryOrigin` value was considered and dropped: it would have meant
 * touching `_restoreOrigins()` and `_persistUrls()` for no behaviour this store
 * does not already provide.
 *
 * ## A bookmark can die
 *
 * The provider may have set a deadline or deleted the file. A bookmark that
 * silently stops working teaches the visitor that the feature is broken, so the
 * expiry is stored alongside and a `410` marks the entry visibly instead of
 * removing it (R14) — with a name he can still read, so he knows what to ask
 * the sender for.
 */

import type { LibraryCatalog, LibraryCatalogEntry } from '../library/library-types';
import type { RvShareMeta, SharedGlbInfo } from './rv-share-meta';
import { filenameFromUrl, originHostOf } from './rv-share-meta';

/** localStorage key; registered in `core/hmi/rv-storage-keys.ts`. */
export const SHARED_BOOKMARKS_KEY = 'rv-shared-bookmarks';

/** Catalogue key the projection is installed under — a scheme, not a URL. */
export const SHARED_BOOKMARKS_CATALOG_KEY = 'bookmarks://shared';

export interface SharedAssetBookmark {
  /** The `?glb=` value: an absolute URL, or `s:<id>` for one of ours. */
  url: string;
  /** What the file said about itself when it was bookmarked. */
  meta: RvShareMeta | null;
  /** Display name, resolved once so a dead link still has something to show. */
  name: string;
  /** ISO 8601 — only when the provider set a deadline. */
  expiresAt?: string;
  addedAt: string;
  /** Set when a load came back `410`. The entry stays, visibly dead (R14). */
  expired?: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: SharedAssetBookmark[] | undefined;

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeSharedBookmarks(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function read(): SharedAssetBookmark[] {
  try {
    const raw = localStorage.getItem(SHARED_BOOKMARKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isBookmark);
  } catch {
    // Disabled storage or a corrupt entry read the same way: no bookmarks.
    // Never throw here — this runs on the consumer path.
    return [];
  }
}

function isBookmark(v: unknown): v is SharedAssetBookmark {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<SharedAssetBookmark>;
  return typeof b.url === 'string' && b.url.length > 0 && typeof b.name === 'string';
}

/**
 * Persist the list.
 *
 * Returns `false` when storage refused — a full quota must not throw out of a
 * button handler (§9.5 `bookmark_QuotaExceeded_FailsSoftly`). The in-memory
 * list still carries the session, so the click did something even when the
 * disk did not.
 */
function write(next: SharedAssetBookmark[]): boolean {
  cache = next;
  try {
    localStorage.setItem(SHARED_BOOKMARKS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  } finally {
    notify();
  }
}

export function listSharedAssetBookmarks(): SharedAssetBookmark[] {
  if (cache === undefined) cache = read();
  return cache;
}

/**
 * Bookmark a shared GLB. Re-adding the same URL refreshes it in place rather
 * than producing a second row for the same thing.
 *
 * Returns `false` when it could not be persisted.
 */
export function addSharedAssetBookmark(info: SharedGlbInfo): boolean {
  const entry: SharedAssetBookmark = {
    url: info.url,
    meta: info.meta,
    name: info.name || filenameFromUrl(info.url),
    ...(info.meta?.expiresAt ? { expiresAt: info.meta.expiresAt } : {}),
    addedAt: new Date().toISOString(),
  };
  const rest = listSharedAssetBookmarks().filter(b => b.url !== entry.url);
  return write([entry, ...rest]);
}

export function removeSharedAssetBookmark(url: string): boolean {
  return write(listSharedAssetBookmarks().filter(b => b.url !== url));
}

export function hasSharedAssetBookmark(url: string): boolean {
  return listSharedAssetBookmarks().some(b => b.url === url);
}

/**
 * Mark a bookmark as dead after a `410` (R14).
 *
 * Not removed: an entry that disappears looks like a bug, while one labelled
 * "no longer available" tells the visitor what happened and lets him ask the
 * sender for it again.
 */
export function markSharedAssetBookmarkExpired(url: string): void {
  const list = listSharedAssetBookmarks();
  if (!list.some(b => b.url === url)) return;
  write(list.map(b => (b.url === url ? { ...b, expired: true } : b)));
}

/** Test/reset seam: forget the cached list so the next read hits storage. */
export function resetSharedBookmarkCache(): void {
  cache = undefined;
}

// ─── Projection into the library UI ────────────────────────────────────────

function entryOf(b: SharedAssetBookmark): LibraryCatalogEntry {
  const host = originHostOf(b.url);
  return {
    id: `shared:${b.url}`,
    // The dead state is carried in the NAME, not only in a field: this entry
    // ends up in a generic library grid that knows nothing about sharing, and a
    // flag no renderer reads would be an invisible marking (R14).
    name: b.expired ? `${b.name} (no longer available)` : b.name,
    category: b.meta?.category ?? 'custom',
    glbUrl: b.url,
    ...(b.meta?.footprintMm ? { footprintMm: b.meta.footprintMm } : {}),
    tags: [...(b.meta?.tags ?? []), ...(host ? [host] : [])],
  };
}

/** The single catalogue every bookmark is projected into. */
export function sharedBookmarkCatalog(): LibraryCatalog {
  return {
    version: '1.0',
    name: 'Shared with me',
    entries: listSharedAssetBookmarks().map(entryOf),
  };
}

/** The narrow slice of the library store this module needs. */
export interface BookmarkCatalogHost {
  addCatalogDirect(key: string, catalog: LibraryCatalog): void;
}

/**
 * Install (or refresh) the bookmarks tab.
 *
 * `addCatalogDirect` updates in place when the key is already known, so calling
 * this after every change is correct and cheap — no add/remove dance, and the
 * tab does not jump.
 */
export function publishSharedBookmarks(host: BookmarkCatalogHost): void {
  host.addCatalogDirect(SHARED_BOOKMARKS_CATALOG_KEY, sharedBookmarkCatalog());
}
