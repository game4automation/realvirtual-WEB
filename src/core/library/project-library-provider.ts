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
import { documentOfAssetEntry } from '../project/rv-project-documents';
import type { RvDocumentEntry } from '../project/rv-project-types';
import type { LibraryCatalogEntry } from './library-types';
import {
  registerLibrarySourceProvider,
  type LibrarySource,
  type LibrarySourceProvider,
  type ResolvePurpose,
  type ResolvedAsset,
} from './library-source-registry';

/** Stable provider id — a project switch REPLACES this provider, never adds one. */
export const PROJECT_LIBRARY_PROVIDER_ID = 'project';

/** The minimum of `ProjectStore` this module needs. Keeps tests tiny. */
export interface ProjectStoreLike {
  subscribe(listener: () => void): () => void;
  getBackend(): ProjectBackend | null;
  getProject(): { id: string; name: string } | null;
}

/**
 * Derive a catalog entry from a project DOCUMENT (plan-716 §2.7 / F7).
 *
 * It used to take a manifest `library[]` record, and that was the whole limit:
 * a document in `models/` or `scenes/` could not be placed because the catalog
 * never listed it. Since plan-716 there is one kind of owned artefact and
 * `library/` is an ordinary folder, so the feed is `listDocuments()` — every
 * section — and placeability is decided by the cycle guard at insert time
 * (`compose()` → `ReferenceCycleError`), not by which folder a file sits in.
 */
function toCatalogEntry(doc: RvDocumentEntry): LibraryCatalogEntry {
  const path = String(doc.path ?? '');
  const filename = path.split('/').pop() ?? path;
  const stem = filename.replace(/\.(scene\.)?(glb|gltf|splat|ksplat|ply)$/i, '');
  // Collections are the UNION of two different things, and keeping them
  // distinct in the head is what makes the union correct rather than muddled
  // (plan-717 §2.6):
  //
  //  - **Folder chips** — every parent directory, cumulative. A *place*. They
  //    mirror the local-folder derivation, so a project's documents and a
  //    local folder library facet identically, and `scenes` / `models` /
  //    `library` are among them because the folder is the only thing that ever
  //    separated those.
  //  - **Row collections** — what the user filed the document under. A
  //    *filing*, typed in the Collections editor, and until plan-717 written
  //    into a sidecar nothing read back.
  //
  // The row's come first: they are the answer to "why did I put this here",
  // and the panel renders chips in order.
  const dirSegments = path.split('/').slice(0, -1).filter(Boolean);
  const collections: string[] = [];
  for (const name of Array.isArray(doc.collections) ? doc.collections : []) {
    if (typeof name === 'string' && name.trim() !== '') collections.push(name);
  }
  for (let i = 0; i < dirSegments.length; i++) {
    const chip = dirSegments.slice(0, i + 1).join('/');
    if (!collections.includes(chip)) collections.push(chip);
  }
  const label = typeof doc.label === 'string' && doc.label.trim() !== '' ? doc.label.trim() : '';
  // A document minted from a bare folder scan carries the raw stem as its
  // `name`; anything else was authored and is used verbatim. Prettifying the
  // former (and only the former) is what keeps `RollConveyor-1m.glb` reading as
  // "RollConveyor 1m" the way the manifest-less library listing always did.
  const authored = typeof doc.name === 'string' && doc.name !== '' && doc.name !== stem
    ? doc.name
    : '';
  return {
    id: `project:${path}`,
    name: label || authored || stem.replace(/[_-]/g, ' '),
    category: 'custom',
    glbUrl: '',
    thumbnailUrl: typeof doc.thumbnail === 'string' ? doc.thumbnail : '',
    pivotToFloor: true,
    localPath: path,
    collections: collections.length > 0 ? collections : undefined,
    // The manifest id, when the entry has one — every migrated manifest does,
    // because the documents migration mints one for each entry that arrives
    // without. It is the second key this source answers to; see
    // `LibraryCatalogEntry.documentId`.
    documentId: typeof doc.id === 'string' && doc.id.trim() !== '' ? doc.id : undefined,
  };
}

/**
 * Every document of a project backend — the catalog feed (F7).
 *
 * `listDocuments()` is the one list and the only call this needs. The
 * `listLibrary()` fallback below is not politeness towards old backends: the
 * test doubles in this repo implement the surface they exercise and nothing
 * more, and a provider that hard-required the newer method would fail them for
 * a reason that has nothing to do with what they test. A backend that answers
 * only the older call still gets its `library/` half, which is exactly what it
 * had before.
 */
async function listProjectDocuments(backend: ProjectBackend): Promise<RvDocumentEntry[]> {
  if (typeof backend.listDocuments === 'function') return backend.listDocuments();
  const legacy = await backend.listLibrary();
  return legacy.map(e => documentOfAssetEntry(e, 'library'));
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
    let entries: LibraryCatalogEntry[] = [];
    let error: string | null = null;
    try {
      entries = (await listProjectDocuments(backend)).map(toCatalogEntry);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (generation !== this._generation) return;   // a newer refresh won

    // Two keys per entry: the path-derived catalog id the panel selects with,
    // and the manifest document id a reference survives a move by (§2.7). The
    // catalog id is registered last so it wins any freak overlap — it is the
    // one the UI hands back.
    const byId = new Map<string, LibraryCatalogEntry>();
    for (const e of entries) if (e.documentId) byId.set(e.documentId, e);
    for (const e of entries) byId.set(e.id, e);
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
      resolveAsset: async (assetId: string, _purpose: ResolvePurpose): Promise<ResolvedAsset> => {
        const entry = byId.get(assetId);
        if (!entry?.localPath) {
          throw new Error(`Asset "${assetId}" is not in project "${project.name}".`);
        }
        const blob = await backend.readDocumentUrl(entry.localPath);
        if (!blob) throw new Error(`Asset "${entry.localPath}" could not be read.`);
        return { url: blob.url, revokeUrl: () => blob.release() };
      },
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

export function uninstallProjectLibraryProvider(): void {
  if (!installed) return;
  installed.unregister();
  installed.provider.dispose();
  installed = null;
}
