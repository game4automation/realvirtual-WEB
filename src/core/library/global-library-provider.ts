// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * global-library-provider — the global catalogs as library sources
 * (plan-702 Phase 0).
 *
 * Until this module existed exactly two providers registered with the
 * {@link registerLibrarySourceProvider} registry: the active project
 * (`project-library-provider.ts`) and — in private builds — the Asset Manager.
 * Everything the user actually *subscribes* to (a `catalog.json` URL, a GitHub
 * repo scan, a local working folder, a bundled catalog) lived in
 * {@link LibraryStore} with **no bridge into the registry at all**.
 *
 * The consequence was invisible but total: the Projects dashboard's Assets tab
 * reads the registry, so it could never show — let alone group by — any global
 * library, and "Add library" would have been a button that adds something the
 * user never sees. This provider is that bridge.
 *
 * ## Two rules the mapping follows
 *
 * 1. **`remove?()` carries removability, not the UI.** A bundled catalog gets no
 *    `remove`, so a consumer derives `removable` from
 *    `typeof source.remove === 'function'` and never has to know what "bundled"
 *    means. `_bundledUrls` is private to the store; the observable proxy is that
 *    a catalog injected via `addCatalogDirect` never records an origin.
 * 2. **`listEntries()` returns `[]`, it never throws.** A catalog that is still
 *    loading or errored is an empty source, not an exception — one bad library
 *    must not take the whole tab with it.
 *
 * The third rule used to be about `needsPermission`: a local working folder
 * could be remembered but not yet re-granted, which is a state and not a
 * failure. That whole source kind went with the work folder (plan-709 §2.6);
 * a project folder handles its own permission at the project level.
 */

import type { LibraryCatalogEntry } from './library-types';
import { isGitHubCatalogUrl, isGitHubRepoScanUrl } from './library-store';
import { getLibraryStore } from './library-store-singleton';
import {
  registerLibrarySourceProvider,
  type LibrarySource,
  type LibrarySourceProvider,
  type ResolvePurpose,
  type ResolvedAsset,
} from './library-source-registry';

/** Stable provider id — a second install REPLACES this provider, never adds one. */
export const GLOBAL_LIBRARY_PROVIDER_ID = 'global';

/**
 * Internal key of the placeholder catalog the private Asset-Manager extension
 * parks in the store. It is surfaced by the cloud provider, not by this one.
 */
const UNITY_CLOUD_PLACEHOLDER_URL = 'bundled://unity-cloud';

/** The minimum of {@link LibraryStore} this module needs. Keeps tests tiny. */
export interface LibraryStoreLike {
  subscribe(listener: () => void): () => void;
  readonly catalogUrls: string[];
  readonly catalogs: Map<string, { name?: string; entries: LibraryCatalogEntry[] }>;
  readonly catalogErrors: Map<string, string>;
  getOrigin(url: string): string | null;
  removeCatalog(url: string): void;
  /** Optional so long-standing test doubles keep compiling. */
  refreshCatalog?(url: string): Promise<void>;
}

/** Human-readable fallback for a catalog whose manifest has not landed yet. */
function fallbackLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last && last !== 'catalog.json' ? `${parsed.hostname}/${last}` : parsed.hostname;
  } catch {
    return url;
  }
}

/** Which badge a catalog wears. `bundled` is "shipped, not subscribed". */
function kindOf(url: string, origin: string | null): LibrarySource['kind'] {
  if (isGitHubRepoScanUrl(url) || isGitHubCatalogUrl(url)) return 'github';
  // Injected via `addCatalogDirect` — no origin was ever recorded for it.
  if (origin === null) return 'bundled';
  return 'url';
}

/**
 * The provider. One instance per installation; its SOURCES are rebuilt whenever
 * the library store publishes, so `listSources()` stays a cheap synchronous read
 * even though the store's own work is async.
 */
class GlobalLibraryProvider implements LibrarySourceProvider {
  readonly id = GLOBAL_LIBRARY_PROVIDER_ID;

  private _listeners = new Set<() => void>();
  private _sources: LibrarySource[] = [];
  private _unsubStore: (() => void) | null = null;

  constructor(private readonly _store: LibraryStoreLike) {
    this._unsubStore = _store.subscribe(() => this._rebuild());
    this._rebuild();
  }

  listSources(): LibrarySource[] { return this._sources; }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  dispose(): void {
    this._unsubStore?.();
    this._unsubStore = null;
    this._listeners.clear();
    this._sources = [];
  }

  private _emit(): void { for (const l of this._listeners) l(); }

  private _rebuild(): void {
    const store = this._store;
    this._sources = store.catalogUrls
      .filter(url => url !== UNITY_CLOUD_PLACEHOLDER_URL)
      .map(url => this._toSource(url));
    this._emit();
  }

  private _toSource(url: string): LibrarySource {
    const store = this._store;
    const catalog = store.catalogs.get(url);
    const error = store.catalogErrors.get(url) ?? null;
    const origin = store.getOrigin(url);
    const kind = kindOf(url, origin);

    const entries: LibraryCatalogEntry[] = catalog?.entries ?? [];
    const byId = new Map(entries.map(e => [e.id, e]));

    const label = catalog?.name ?? fallbackLabel(url);

    const source: LibrarySource = {
      id: url,
      label,
      kind,
      // Global catalogs are read-only: they are fetched over HTTP or scanned
      // off disk, and nothing here can write back to either.
      writable: false,
      loaded: catalog !== undefined && error === null,
      error,
      listEntries: () => entries,
      getEntry: (assetId: string) => byId.get(assetId) ?? null,
      resolveAsset: async (assetId: string, _purpose: ResolvePurpose): Promise<ResolvedAsset> => {
        const entry = byId.get(assetId);
        const assetUrl = entry?.glbUrl || entry?.splatUrl;
        if (!assetUrl) throw new Error(`Asset "${assetId}" is not in library "${label}".`);
        // Already a fetchable URL (http/blob) — the store resolved it at load
        // time, so there is nothing to revoke here.
        return { url: assetUrl };
      },
    };

    if (kind !== 'bundled') {
      // A bundled catalog was shipped with the deploy, not subscribed to — it
      // deliberately gets NO remove and NO refresh, which is what F6 reads off
      // the source. Every subscribed catalog (url/github/cloud) re-fetches.
      source.remove = async () => { store.removeCatalog(url); };
      if (store.refreshCatalog) {
        source.refresh = () => store.refreshCatalog!(url);
      }
    }

    return source;
  }
}

let installed: { provider: GlobalLibraryProvider; unregister: () => void } | null = null;

/**
 * Register the global catalogs as library sources. Idempotent — a second call
 * replaces the previous installation (used by tests and by a store swap).
 */
export function installGlobalLibraryProvider(
  store: LibraryStoreLike = getLibraryStore(),
): () => void {
  uninstallGlobalLibraryProvider();
  const provider = new GlobalLibraryProvider(store);
  const unregister = registerLibrarySourceProvider(provider);
  installed = { provider, unregister };
  return uninstallGlobalLibraryProvider;
}

export function uninstallGlobalLibraryProvider(): void {
  if (!installed) return;
  installed.unregister();
  installed.provider.dispose();
  installed = null;
}
