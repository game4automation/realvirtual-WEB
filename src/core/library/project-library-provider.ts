// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-library-provider — the active project as a library source
 * (plan-372 §2.6.4, Phase 4).
 *
 * This is what closes out plan-370 Phase 4 ("`models/` + `library/` out of the
 * project folder") without inventing a second mechanism: the project does not
 * get its own asset panel, it simply *registers as a provider* and shows up in
 * the same list as a remote catalog, a GitHub scan or a local folder.
 *
 * ## Two properties that shape the implementation
 *
 * **`listSources()` is synchronous, the backend is not.** A backend lists its
 * `library/` folder over `await`. So the provider keeps a cached source and
 * refreshes it asynchronously whenever the project store publishes; the cache
 * flips to `loaded: true` when the listing arrives. A synchronous getter that
 * kicked off a fetch would re-enter on every React render.
 *
 * **`ResolvedAsset.url` is volatile.** `readBlobUrl()` on a folder or browser
 * backend hands out an object URL; the provider forwards its `release()` as
 * `revokeUrl()` and never caches the string.
 */

import { getProjectStore } from '../project/project-store';
import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvProject } from '../project/rv-project-types';
import { documentsOf } from '../project/rv-project-documents';
import type { LibraryCatalogEntry } from './library-types';
import {
  registerLibrarySourceProvider,
  type LibrarySource,
  type LibrarySourceProvider,
} from './library-source-registry';
import {
  createEntryResolver,
  indexProjectEntries,
  listProjectDocuments,
  registerEntryHashes,
  type ProjectEntryIndex,
} from './project-library-entries';
import { isProjectBackedProvider, OPEN_PROJECT_PROVIDER_ID } from './library-origin';

/** Stable provider id — a project switch REPLACES this provider, never adds one. */
export const PROJECT_LIBRARY_PROVIDER_ID = OPEN_PROJECT_PROVIDER_ID;
export { isProjectBackedProvider };

/** The minimum of `ProjectStore` this module needs. Keeps tests tiny. */
export interface ProjectStoreLike {
  subscribe(listener: () => void): () => void;
  getBackend(): ProjectBackend | null;
  getProject(): { id: string; name: string } | null;
}

/**
 * The provider. One instance per installation; the SOURCE inside it is swapped
 * when the active project changes.
 */
class ProjectLibraryProvider implements LibrarySourceProvider {
  readonly id = PROJECT_LIBRARY_PROVIDER_ID;

  private _listeners = new Set<() => void>();
  private _sources: LibrarySource[] = [];
  private _unsubStore: (() => void) | null = null;
  /** Guards against a stale listing overwriting a newer one. */
  private _generation = 0;

  constructor(private readonly _store: ProjectStoreLike) {
    this._unsubStore = _store.subscribe(() => { void this._refresh(); });
    void this._refresh();
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

  /** Re-read the active project's `library/`. Safe to call concurrently. */
  async refresh(): Promise<void> { await this._refresh(); }

  private _emit(): void { for (const l of this._listeners) l(); }

  /** The CURRENT manifest path of an entry's document id, or null (plan-655 F5). */
  private _currentPathOf(entry: LibraryCatalogEntry): string | null {
    if (!entry.documentId) return null;
    const project = this._store.getProject() as RvProject | null;
    const row = documentsOf(project).find((d) => d.id === entry.documentId);
    return typeof row?.path === 'string' && row.path ? row.path : null;
  }

  private async _refresh(): Promise<void> {
    const generation = ++this._generation;
    const backend = this._store.getBackend();
    const project = this._store.getProject();

    if (!backend || !project) {
      if (this._sources.length === 0) return;   // already empty — no churn
      this._sources = [];
      this._emit();
      return;
    }

    // Publish the source immediately (unloaded) so the UI can render a
    // placeholder, then fill it in when the listing lands.
    const sourceId = project.id;
    // The content version per entry id (the manifest hash, else the row's
    // revision — also a SHA-256 of the body, plan-397): a document re-saved in
    // the asset editor changes its revision, which is what retires the cached
    // bake of the old bytes in this session (plan-660 G4). `indexProjectEntries`
    // computes it; the open project keys entries by `project:<path>` + id.
    let index: ProjectEntryIndex = { entries: [], byId: new Map(), byAlias: new Map(), versions: new Map() };
    let error: string | null = null;
    try {
      index = indexProjectEntries(await listProjectDocuments(backend), backend, { keyBy: 'path' });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (generation !== this._generation) return;   // a newer refresh won

    // plan-508 F4: the hash of every key an entry answers to, under the
    // ModelCache key the placement instancer derives for it.
    registerEntryHashes(PROJECT_LIBRARY_PROVIDER_ID, sourceId, index);
    const { entries, byId } = index;
    const source: LibrarySource = {
      id: sourceId,
      label: project.name,
      // A bundled deploy IS a project, but it is read-only and shows a
      // different badge — the two kinds are not interchangeable in the UI.
      kind: backend.kind === 'bundled' ? 'bundled' : 'project',
      writable: backend.writable,
      loaded: error === null,
      error,
      listEntries: () => entries,
      getEntry: (assetId: string) => byId.get(assetId) ?? null,
      // plan-655 F5: the listing is a snapshot. A rename / move between that
      // listing and a resolve leaves `localPath` pointing at a file that no
      // longer exists; the manifest row of the document id is current the
      // moment the move is written, so the path is read from there first.
      resolveAsset: createEntryResolver(backend, index, project.name, {
        currentPathOf: (entry) => this._currentPathOf(entry),
      }),
      refresh: () => this._refresh(),
    };

    this._sources = [source];
    this._emit();
  }
}

let installed: { provider: ProjectLibraryProvider; unregister: () => void } | null = null;

/**
 * Register the active project as a library source. Idempotent — a second call
 * replaces the previous installation (used by tests and by a store swap).
 */
export function installProjectLibraryProvider(
  store: ProjectStoreLike = getProjectStore(),
): () => void {
  uninstallProjectLibraryProvider();
  const provider = new ProjectLibraryProvider(store);
  const unregister = registerLibrarySourceProvider(provider);
  installed = { provider, unregister };
  return uninstallProjectLibraryProvider;
}

/**
 * Re-list the active project's documents NOW and resolve when the provider's
 * entries are current (plan-655 F5). A rename / move / delete via MCP awaits
 * this, so a place by id right after the tool answered sees the new path —
 * the store's publish only kicks the same refresh off asynchronously.
 */
export async function refreshProjectLibrary(): Promise<void> {
  await installed?.provider.refresh();
}

export function uninstallProjectLibraryProvider(): void {
  if (!installed) return;
  installed.unregister();
  installed.provider.dispose();
  installed = null;
}
