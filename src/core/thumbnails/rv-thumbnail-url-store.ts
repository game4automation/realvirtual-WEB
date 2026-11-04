// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-thumbnail-url-store — the session store of resolved thumbnail URLs
 * (plan-776 F8, P9).
 *
 * A card shows a document's saved preview by pointer (`row.thumbnail`). For a
 * folder or browser project that pointer resolves to an object URL, which
 * somebody has to own and revoke. This store is that owner:
 *
 *  - one entry per `backend + pointer`, shared by every card that shows it —
 *    two cards on one pointer cost ONE read;
 *  - refcounted by the cards that hold it; the last release makes the entry
 *    idle, not gone, so scrolling back is free;
 *  - capped at {@link MAX_ENTRIES} entries — idle ones are released oldest
 *    first (LRU), held ones never;
 *  - cleared (every URL released) when the open project changes and when the
 *    viewer is disposed.
 *
 * The pointer carries the image's hash (`<id>.<hash8>.webp`), so a re-saved
 * document has a NEW pointer and therefore a new entry: there is no
 * invalidation, the old entry simply goes idle and is released by the LRU.
 *
 * It never renders and never loads a GLB — it imports nothing that could
 * (guard: `tests/thumbnail-read-import-boundary.node.test.ts`).
 */

import { useEffect, useState } from 'react';
import type { ProjectBackend } from '../project/backends/project-backend';
import { getProjectStore } from '../project/project-store';
import {
  resolveThumbnailUrl,
  type ResolvedDocumentThumbnail,
} from '../library/resolve-document-thumbnail';

/** Upper bound of resolved entries kept per session (plan-776 P9). */
export const MAX_ENTRIES = 500;

/** Cache API buckets of the deleted render-on-view machinery (plan-776 F10). */
export const LEGACY_THUMBNAIL_BUCKETS: readonly string[] = [
  'rv-thumbnails-v4', 'rv-thumbnails-v3', 'rv-thumbnails-v2', 'rv-planner-thumbnails',
];

interface Entry {
  promise: Promise<string | null>;
  resolved: ResolvedDocumentThumbnail | null;
  refs: number;
  /** Monotonic use counter — the LRU order. */
  used: number;
  /** Set once the entry was released; a late resolution is let go at once. */
  dead: boolean;
}

const entries = new Map<string, Entry>();
const backendIds = new WeakMap<object, number>();
let nextBackendId = 1;
let clock = 0;

function backendKey(backend: ProjectBackend | null | undefined): string {
  if (!backend) return '-';
  let id = backendIds.get(backend);
  if (id === undefined) {
    id = nextBackendId++;
    backendIds.set(backend, id);
  }
  return String(id);
}

function keyOf(backend: ProjectBackend | null | undefined, pointer: string): string {
  return `${backendKey(backend)}\u0000${pointer}`;
}

function releaseEntry(key: string, entry: Entry): void {
  entry.dead = true;
  entries.delete(key);
  try { entry.resolved?.release?.(); } catch { /* an object URL that is already gone */ }
}

/** Release idle entries, oldest first, until the store is back under the cap. */
function evict(): void {
  if (entries.size <= MAX_ENTRIES) return;
  const idle = [...entries].filter(([, e]) => e.refs <= 0).sort((a, b) => a[1].used - b[1].used);
  for (const [key, entry] of idle) {
    if (entries.size <= MAX_ENTRIES) break;
    releaseEntry(key, entry);
  }
}

/**
 * Take a reference on the URL behind `pointer` and resolve it. Every call must
 * be paired with exactly one {@link releaseThumbnailUrl} of the same arguments.
 */
export function acquireThumbnailUrl(
  backend: ProjectBackend | null | undefined,
  pointer: string,
): Promise<string | null> {
  armSessionHooks();
  const key = keyOf(backend, pointer);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = { promise: Promise.resolve(null), resolved: null, refs: 0, used: 0, dead: false };
    created.promise = resolveThumbnailUrl(backend, pointer).then((resolved) => {
      if (created.dead) {
        try { resolved?.release?.(); } catch { /* nothing to free */ }
        return null;
      }
      created.resolved = resolved;
      return resolved?.url ?? null;
    });
    entries.set(key, created);
    entry = created;
  }
  entry.refs++;
  entry.used = ++clock;
  evict();
  return entry.promise;
}

/** Drop one reference. The entry stays (idle) until the LRU or a clear frees it. */
export function releaseThumbnailUrl(
  backend: ProjectBackend | null | undefined,
  pointer: string,
): void {
  const entry = entries.get(keyOf(backend, pointer));
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  evict();
}

/** Release every URL — project switch, viewer dispose. Mounted cards re-acquire. */
export function clearThumbnailUrls(): void {
  for (const [key, entry] of [...entries]) releaseEntry(key, entry);
}

/** Number of live entries. Diagnostics and tests. */
export function thumbnailUrlStoreSize(): number {
  return entries.size;
}

// ─── Session hooks ──────────────────────────────────────────────────────

let hooksArmed = false;
let lastProjectKey: string | null = null;

/**
 * Armed on first use: a project switch clears the store, and the Cache API
 * buckets of the deleted render-on-view machinery are deleted once.
 */
function armSessionHooks(): void {
  if (hooksArmed) return;
  hooksArmed = true;
  void cleanupLegacyThumbnailCaches();
  try {
    const store = getProjectStore();
    const projectKey = (): string => `${store.getProject()?.id ?? ''}\u0000${backendKey(store.getBackend())}`;
    lastProjectKey = projectKey();
    store.subscribe(() => {
      const next = projectKey();
      if (next === lastProjectKey) return;
      lastProjectKey = next;
      clearThumbnailUrls();
    });
  } catch { /* no project store in this shell — nothing to follow */ }
}

/**
 * Delete the Cache API buckets the render-on-view thumbnail cache used
 * (`rv-thumbnails-v4/v3/v2`, `rv-planner-thumbnails`). One-shot per page; a
 * browser without the Cache API, or a private window, simply has nothing to
 * delete. Resolves to the buckets that were found and deleted.
 */
let legacyCleanup: Promise<string[]> | null = null;
export function cleanupLegacyThumbnailCaches(): Promise<string[]> {
  legacyCleanup ??= (async () => {
    const deleted: string[] = [];
    if (typeof caches === 'undefined') return deleted;
    for (const bucket of LEGACY_THUMBNAIL_BUCKETS) {
      try {
        if (await caches.delete(bucket)) deleted.push(bucket);
      } catch { /* storage blocked */ }
    }
    return deleted;
  })();
  return legacyCleanup;
}

/** Test seam: forget the one-shot state and every entry. */
export function resetThumbnailUrlStoreForTests(): void {
  clearThumbnailUrls();
  legacyCleanup = null;
  hooksArmed = false;
  lastProjectKey = null;
}

// ─── React ──────────────────────────────────────────────────────────────

/**
 * The loadable URL of a saved thumbnail for one mounted card, or null while it
 * resolves / when there is none. Holds a reference for as long as the card is
 * mounted with this pointer; a new pointer releases the old one.
 */
export function useThumbnailUrl(
  backend: ProjectBackend | null | undefined,
  pointer: string | null | undefined,
): string | null {
  const value = typeof pointer === 'string' ? pointer.trim() : '';
  const [state, setState] = useState<{ key: string; url: string | null }>({ key: '', url: null });
  const key = value ? keyOf(backend, value) : '';
  useEffect(() => {
    if (!value) return;
    let alive = true;
    void acquireThumbnailUrl(backend, value).then((url) => {
      if (alive) setState({ key: keyOf(backend, value), url });
    });
    return () => {
      alive = false;
      releaseThumbnailUrl(backend, value);
    };
  }, [backend, value]);
  return key !== '' && state.key === key ? state.url : null;
}
