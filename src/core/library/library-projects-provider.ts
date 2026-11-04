// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-projects-provider — every library project of the open project as a
 * library source (plan-778 Phase 1, F3/F6/F7).
 *
 * Provider id `'library-projects'`, ONE source per {@link LibraryProjectNode}
 * of the {@link LibraryProjectLoader}: `sourceId` = the library's project id,
 * `writable: false` (a library is read-only inside the project that uses it,
 * Decision 3). The node state maps onto the registry's three flags so
 * `isPending()` is exact:
 *
 * | node state | loaded | needsPermission | error |
 * |---|---|---|---|
 * | pending | false | — | null |
 * | ready | true | — | null |
 * | locked | false | true | null |
 * | unknown / error | false | — | reason |
 *
 * A locked, unknown or failed library is therefore never "pending": nothing
 * waits for it (F7), its placements become placeholders at once and come back
 * when the source turns ready (F8, the instancer's registry subscription).
 *
 * Entries are keyed by DOCUMENT ID (`project-library-entries.ts`); legacy ids
 * answer through the separate `getAliasEntry`. Every entry carries
 * `libraryOrigin`, which is what makes a placement from it qualified.
 *
 * Non-placeable sources (transitive libraries, the built-in realvirtual library
 * when the project does not list it — Decision C) are `hidden`: they resolve,
 * but the browsing UIs do not offer them.
 *
 * Source objects are cached per node and rebuilt only when that node changed —
 * `listSources()` hands out the same array between changes (never new objects
 * per call; see the registry header on React #185).
 */

import type { LibraryCatalog, LibraryCatalogEntry } from './library-types';
import {
  registerLibrarySourceProvider,
  type LibrarySource,
  type LibrarySourceProvider,
  type ResolvePurpose,
  type ResolvedAsset,
} from './library-source-registry';
import {
  createEntryResolver,
  indexProjectEntries,
  registerEntryHashes,
  type ProjectEntryIndex,
} from './project-library-entries';
import { LIBRARY_PROJECTS_PROVIDER_ID } from './library-origin';
import type { LibraryProjectLoader, LibraryProjectNode, LibraryProjectState } from './library-project-loader';

export { LIBRARY_PROJECTS_PROVIDER_ID };

/** A library-projects source: a `LibrarySource` plus the node facts the UI and tools read. */
export interface LibraryProjectSource extends LibrarySource {
  /** Listed in the open project's `libraries[]`. */
  readonly direct: boolean;
  /** Placeable from the panel / `layout.place` (direct, Decision C). */
  readonly placeable: boolean;
  /** Ids of the libraries that need this one (transitive). */
  readonly neededBy: readonly string[];
  /** The node state kind — `pending` / `ready` / `locked` / `unknown` / `error`. */
  readonly state: LibraryProjectState['kind'];
  /** The location hint of the naming ref. */
  readonly hint?: string;
}

/** Is `source` a library-projects source (structural check on the extra fields)? */
export function isLibraryProjectSource(source: LibrarySource): source is LibraryProjectSource {
  return typeof (source as Partial<LibraryProjectSource>).placeable === 'boolean'
    && typeof (source as Partial<LibraryProjectSource>).state === 'string';
}

const EMPTY_INDEX: ProjectEntryIndex = { entries: [], byId: new Map(), byAlias: new Map(), versions: new Map() };

class LibraryProjectsProvider implements LibrarySourceProvider {
  readonly id = LIBRARY_PROJECTS_PROVIDER_ID;

  private readonly _listeners = new Set<() => void>();
  private _sources: LibrarySource[] = [];
  /** Cached source per project id + the node it was built from. */
  private readonly _cache = new Map<string, { node: LibraryProjectNode; source: LibraryProjectSource }>();
  private _unsub: (() => void) | null;

  constructor(private readonly _loader: LibraryProjectLoader) {
    this._unsub = _loader.subscribe(() => this._rebuild());
    this._rebuild();
  }

  listSources(): LibrarySource[] { return this._sources; }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  dispose(): void {
    this._unsub?.();
    this._unsub = null;
    this._listeners.clear();
    this._cache.clear();
    this._sources = [];
  }

  private _rebuild(): void {
    const nodes = this._loader.getNodes();
    const next: LibrarySource[] = [];
    const seen = new Set<string>();
    let changed = nodes.length !== this._sources.length;
    for (const node of nodes) {
      seen.add(node.projectId);
      const cached = this._cache.get(node.projectId);
      let source: LibraryProjectSource;
      if (cached && sameNode(cached.node, node)) {
        source = cached.source;
      } else {
        source = this._toSource(node);
        this._cache.set(node.projectId, { node, source });
        changed = true;
      }
      if (this._sources[next.length] !== source) changed = true;
      next.push(source);
    }
    for (const id of [...this._cache.keys()]) if (!seen.has(id)) this._cache.delete(id);
    if (!changed) return;
    this._sources = next;
    for (const l of this._listeners) l();
  }

  private _toSource(node: LibraryProjectNode): LibraryProjectSource {
    const state = node.state;
    const origin = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: node.projectId };
    let index = EMPTY_INDEX;
    let resolveAsset: (assetId: string, purpose: ResolvePurpose) => Promise<ResolvedAsset> =
      async (assetId) => { throw new Error(`Library "${node.label}" is not available — "${assetId}" cannot be resolved.`); };
    let kind: LibrarySource['kind'] = 'project';

    if (state.kind === 'ready') {
      if (state.via === 'scan' && state.scan) {
        index = indexScanCatalog(state.scan, origin);
        resolveAsset = async (assetId) => {
          const entry = index.byId.get(assetId) ?? index.byAlias.get(assetId);
          const url = entry?.glbUrl || entry?.splatUrl;
          if (!url) throw new Error(`Asset "${assetId}" is not in library "${node.label}".`);
          return { url };
        };
        kind = 'github';
      } else if (state.backend) {
        index = indexProjectEntries(state.documents, { writable: false }, { keyBy: 'document', origin });
        const backend = state.backend;
        resolveAsset = createEntryResolver(backend, index, node.label, {
          // F8: ready → error only when the LIBRARY is gone, not for one missing file (review C4).
          onReadFailure: (path, error) => {
            void backend.readManifest().then((m) => m?.id === node.projectId, () => false).then((there) => {
              const now = this._loader.getNode(node.projectId)?.state;
              if (there || now?.kind !== 'ready' || now.backend !== backend) return;
              this._loader.markError(node.projectId,
                `Library "${node.label}" could not read "${path}" (${error instanceof Error ? error.message : String(error)}).`);
            });
          },
        });
        kind = state.via === 'builtin' ? 'bundled' : state.via === 'hosted' ? 'url' : 'project';
      }
      registerEntryHashes(LIBRARY_PROJECTS_PROVIDER_ID, node.projectId, index);
    }

    const { entries, byId, byAlias } = index;
    const error = state.kind === 'error' ? state.reason
      : state.kind === 'unknown' ? `Library "${node.label}" (${node.projectId}) is unknown on this computer.`
      : null;
    return {
      id: node.projectId,
      label: node.label,
      kind,
      writable: false,
      loaded: state.kind === 'ready',
      ...(state.kind === 'locked' ? { needsPermission: true } : {}),
      error,
      hidden: !node.placeable,
      direct: node.direct,
      placeable: node.placeable,
      neededBy: node.neededBy,
      state: state.kind,
      ...(node.hint ? { hint: node.hint } : {}),
      listEntries: () => entries,
      getEntry: (assetId: string) => byId.get(assetId) ?? null,
      getAliasEntry: (alias: string) => byAlias.get(alias) ?? null,
      resolveAsset,
      refresh: async () => { this._loader.invalidate(node.projectId); },
    };
  }
}

/** Node equality for the source cache — same state object, same facts. */
function sameNode(a: LibraryProjectNode, b: LibraryProjectNode): boolean {
  return a.state === b.state && a.label === b.label && a.direct === b.direct && a.placeable === b.placeable
    && a.hint === b.hint && a.neededBy.length === b.neededBy.length && a.neededBy.every((x, i) => x === b.neededBy[i]);
}

/**
 * Index a GitHub repo scan (F13, a library whose repo has no `project.json`
 * yet). The scan mints ids `<repo>-<path>-glb`; the canonical document id of
 * the same file in a library project is the path part alone (the realvirtual
 * library's ids are exactly that: `pallethandling-chainconveyor-1m`), so the
 * scan id becomes an ALIAS of the derived canonical id — legacy references
 * written against the scan keep resolving, and a qualified reference by
 * document id resolves too.
 */
export function indexScanCatalog(
  catalog: LibraryCatalog,
  origin: { providerId: string; sourceId: string },
): ProjectEntryIndex {
  const repoSlug = (catalog.name ?? '').split('/')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const entries: LibraryCatalogEntry[] = [];
  const byId = new Map<string, LibraryCatalogEntry>();
  const byAlias = new Map<string, LibraryCatalogEntry>();
  for (const raw of catalog.entries ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') continue;
    let canonical = raw.id;
    if (repoSlug && canonical.startsWith(`${repoSlug}-`)) canonical = canonical.slice(repoSlug.length + 1);
    canonical = canonical.replace(/-glb$/, '');
    const entry: LibraryCatalogEntry = {
      ...raw,
      id: canonical,
      documentId: canonical,
      aliases: canonical === raw.id ? [] : [raw.id],
      libraryOrigin: { ...origin },
    };
    if (byId.has(canonical)) continue;
    entries.push(entry);
    byId.set(canonical, entry);
    if (canonical !== raw.id) byAlias.set(raw.id, entry);
  }
  return { entries, byId, byAlias, versions: new Map() };
}

// ─── Installation ───────────────────────────────────────────────────────

let installed: { provider: LibraryProjectsProvider; unregister: () => void } | null = null;

/** Register the library projects of `loader` as library sources. Idempotent (replaces). */
export function installLibraryProjectsProvider(loader: LibraryProjectLoader): () => void {
  uninstallLibraryProjectsProvider();
  const provider = new LibraryProjectsProvider(loader);
  const unregister = registerLibrarySourceProvider(provider);
  installed = { provider, unregister };
  return uninstallLibraryProjectsProvider;
}

export function uninstallLibraryProjectsProvider(): void {
  if (!installed) return;
  installed.unregister();
  installed.provider.dispose();
  installed = null;
}
