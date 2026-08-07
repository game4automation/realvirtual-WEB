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
 * ## Three rules the mapping follows
 *
 * 1. **`remove?()` carries removability, not the UI.** A bundled catalog gets no
 *    `remove`, so a consumer derives `removable` from
 *    `typeof source.remove === 'function'` and never has to know what "bundled"
 *    means. `_bundledUrls` is private to the store; the observable proxy is that
 *    a catalog injected via `addCatalogDirect` never records an origin.
 * 2. **`listEntries()` returns `[]`, it never throws.** A catalog that is still
 *    loading, errored, or waiting for a folder permission is an empty source,
 *    not an exception — one bad library must not take the whole tab with it.
 * 3. **`needsPermission` is a state, not an error.** The store encodes it as the
 *    `LOCAL_NEEDS_PERMISSION` sentinel inside `catalogErrors`; here the two are
 *    split again so the UI can offer "re-grant" instead of "failed to load".
 */

import type { LibraryCatalogEntry } from './library-types';
import { LOCAL_NEEDS_PERMISSION } from './library-types';
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
  removeLocalFolder(): Promise<void>;
  refreshLocalFolder(): Promise<void>;
}

/** Human-readable fallback for a catalog whose manifest has not landed yet. */
function fallbackLabel(url: string): string {
  if (url.startsWith('local:')) {
    return url.slice('local:'.length).replace(/\/library$/, '') || 'Local folder';
  }
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
  if (url.startsWith('local:')) return 'local';
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
    const rawError = store.catalogErrors.get(url) ?? null;
    const needsPermission = rawError === LOCAL_NEEDS_PERMISSION;
    // The permission sentinel is a state, not a failure — surfacing it as
    // `error` would show "failed to load" where "re-grant access" belongs.
    const error = needsPermission ? null : rawError;
    const origin = store.getOrigin(url);
    const kind = kindOf(url, origin);

    const entries: LibraryCatalogEntry[] = needsPermission ? [] : (catalog?.entries ?? []);
    const byId = new Map(entries.map(e => [e.id, e]));

    const label = kind === 'local'
      ? (catalog?.name?.replace(/^Local:\s*/, '') ?? fallbackLabel(url))
      : (catalog?.name ?? fallbackLabel(url));

    const source: LibrarySource = {
      id: url,
      label,
      kind,
      // Global catalogs are read-only: they are fetched over HTTP or scanned
      // off disk, and nothing here can write back to either.
      writable: false,
      loaded: catalog !== undefined && error === null && !needsPermission,
      needsPermission,
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

    if (kind === 'local') {
      source.refresh = () => store.refreshLocalFolder();
      source.remove = () => store.removeLocalFolder();
    } else if (kind !== 'bundled') {
      // A bundled catalog was shipped with the deploy, not subscribed to — it
      // deliberately gets NO remove, which is what F6 reads off the source.
      source.remove = async () => { store.removeCatalog(url); };
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
