// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * project-library-entries — a project's DOCUMENTS as library catalog entries
 * (extracted from `project-library-provider.ts`, plan-778 Phase 1).
 *
 * Two providers turn a project backend into a library source: the OPEN project
 * (`project-library-provider.ts`, provider `'project'`) and every library
 * project the open one names (`library-projects-provider.ts`, provider
 * `'library-projects'`). They differ in exactly one decision, and this module
 * is where it is made explicit instead of copied:
 *
 *  - **The open project keys an entry by `project:<path>`** — the id its panel
 *    selects with since plan-372 — and answers to the manifest document id as a
 *    second key.
 *  - **A library project keys an entry by its DOCUMENT ID** and nothing else
 *    canonical. A qualified reference (`providerId` + `sourceId` + `assetId`)
 *    names a document of a project that is not open; a path-derived key would
 *    tie it to the library's folder layout. Legacy ids (`aliases`) go into a
 *    SEPARATE lookup that only the unqualified legacy pass consults.
 *
 * Everything else — name, collections, thumbnail pointer, content hash — is
 * one mapping for both, and so is the resolve: `readDocumentUrl()` hands out
 * an object URL whose `release()` is forwarded as `revokeUrl()` (the registry
 * contract: the URL is volatile and the caller releases it).
 */

import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry } from '../project/rv-project-types';
import { isExternalThumbnailPointer, type LibraryCatalogEntry } from './library-types';
import type { ResolvedAsset, ResolvePurpose } from './library-source-registry';
import { isSha256, resolvedAssetKey, setAssetHash } from './rv-asset-hash-registry';

/** How {@link toCatalogEntry} keys an entry — see the file header. */
export type EntryKeying = 'path' | 'document';

export interface ToCatalogEntryOptions {
  /** `'path'` = `project:<path>` (the open project), `'document'` = the document id (a library project). */
  keyBy?: EntryKeying;
  /** Stamped onto the entry as `libraryOrigin` — makes a placement from it qualified (plan-778 F4). */
  origin?: { providerId: string; sourceId: string };
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
export function toCatalogEntry(doc: RvDocumentEntry, opts: ToCatalogEntryOptions = {}): LibraryCatalogEntry {
  const path = String(doc.path ?? '');
  const filename = path.split('/').pop() ?? path;
  const stem = filename.replace(/\.(scene\.)?(glb|gltf|splat|ksplat|ply)$/i, '');
  // Collections are the UNION of two different things (plan-717 §2.6):
  //
  //  - **Folder chips** — every parent directory, cumulative. A *place*. They
  //    mirror the local-folder derivation, so a project's documents and a
  //    local folder library facet identically.
  //  - **Row collections** — what the user filed the document under. A
  //    *filing*, typed in the Collections editor.
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
  // `name`; anything else was authored and is used verbatim.
  const authored = typeof doc.name === 'string' && doc.name !== '' && doc.name !== stem
    ? doc.name
    : '';
  const documentId = typeof doc.id === 'string' && doc.id.trim() !== '' ? doc.id : undefined;
  const aliases = Array.isArray(doc.aliases)
    ? doc.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim())
    : [];
  const keyBy = opts.keyBy ?? 'path';
  const entry: LibraryCatalogEntry = {
    // Contract documents-projects 4: a document is addressed by its id; the path form
    // is only the key of a row without one (and stays readable for old files).
    id: documentId ?? `project:${path}`,
    name: label || authored || stem.replace(/[_-]/g, ' '),
    category: 'custom',
    glbUrl: '',
    // The row's pointer is NOT a URL (plan-776): the card resolves it through
    // the project backend. A pointer that IS a URL (a delivered manifest's)
    // passes through as the picture directly.
    thumbnailUrl: typeof doc.thumbnail === 'string' && isExternalThumbnailPointer(doc.thumbnail)
      ? doc.thumbnail : '',
    ...(typeof doc.thumbnail === 'string' && doc.thumbnail.trim() !== ''
      && !isExternalThumbnailPointer(doc.thumbnail)
      ? { thumbnailPointer: doc.thumbnail.trim() } : {}),
    pivotToFloor: true,
    localPath: path,
    collections: collections.length > 0 ? collections : undefined,
    documentId,
    // plan-508 F4: the manifest's own content hash, passed through. It keys the
    // decoded/baked caches of this entry and never resolves anything.
    ...(isSha256(doc.sha256) ? { sha256: doc.sha256 } : {}),
    ...(isSha256(doc.sha256) && typeof doc.sizeBytes === 'number' ? { sizeBytes: doc.sizeBytes } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(opts.origin ? { libraryOrigin: { ...opts.origin } } : {}),
  };
  // Planner fields a library manifest may carry over from a catalog (plan-778
  // F12). Library projects only — the open project's entries stay as they were.
  if (keyBy !== 'document') return entry;
  const row = doc as RvDocumentEntry & Record<string, unknown>;
  if (Array.isArray(row.footprintMm) && row.footprintMm.length === 2
    && row.footprintMm.every((n) => typeof n === 'number')) {
    entry.footprintMm = [row.footprintMm[0] as number, row.footprintMm[1] as number];
  }
  if (typeof row.pivotToFloor === 'boolean') entry.pivotToFloor = row.pivotToFloor;
  if (Array.isArray(row.tags)) entry.tags = row.tags.filter((t): t is string => typeof t === 'string');
  return entry;
}

/**
 * Every document of a project backend — the catalog feed (F7).
 *
 * `listDocuments()` is the one list and the only call this makes. A partial
 * test double that implements less than the interface answers an empty list
 * rather than throwing.
 */
export async function listProjectDocuments(backend: ProjectBackend): Promise<RvDocumentEntry[]> {
  if (typeof backend.listDocuments !== 'function') return [];
  return backend.listDocuments();
}

/** The lookup tables of one project's entries. */
export interface ProjectEntryIndex {
  entries: LibraryCatalogEntry[];
  /** Canonical keys → entry. */
  byId: Map<string, LibraryCatalogEntry>;
  /** Legacy alias → entry (separate on purpose — only the legacy pass asks it). */
  byAlias: Map<string, LibraryCatalogEntry>;
  /** Entry id → content version (the manifest hash, else a writable backend's revision). */
  versions: Map<string, string>;
}

/**
 * Map documents to entries and index them.
 *
 * Path keying (the open project) answers to two canonical keys per entry: the
 * path-derived catalog id the panel selects with, and the manifest document id
 * a reference survives a move by (§2.7). The catalog id is registered last so
 * it wins any freak overlap — it is the one the UI hands back.
 *
 * Document keying (a library project) answers to the document id only;
 * aliases land in `byAlias`, never in `byId`.
 */
export function indexProjectEntries(
  docs: readonly RvDocumentEntry[],
  backend: Pick<ProjectBackend, 'writable'>,
  opts: ToCatalogEntryOptions = {},
): ProjectEntryIndex {
  const entries = docs.map((d) => toCatalogEntry(d, opts));
  const versions = new Map<string, string>();
  docs.forEach((doc, i) => {
    // Only a writable project edits its documents; a bundled deploy keeps the
    // url-keyed integrity path of plan-508 untouched.
    const v = isSha256(doc.sha256) ? doc.sha256
      : backend.writable && isSha256(doc.revision) ? doc.revision : undefined;
    if (v) versions.set(entries[i].id, v);
  });
  const byId = new Map<string, LibraryCatalogEntry>();
  const byAlias = new Map<string, LibraryCatalogEntry>();
  if ((opts.keyBy ?? 'path') === 'path') {
    for (const e of entries) if (e.localPath) byId.set(`project:${e.localPath}`, e);   // legacy references
    for (const e of entries) byId.set(e.id, e);
  } else {
    for (const e of entries) byId.set(e.id, e);
    for (const e of entries) {
      for (const alias of e.aliases ?? []) if (!byId.has(alias) && !byAlias.has(alias)) byAlias.set(alias, e);
    }
  }
  return { entries, byId, byAlias, versions };
}

/**
 * plan-508 F4: a project document has no stable url (its bytes come as a fresh
 * `blob:` per resolve), so its hash is registered under the ModelCache key the
 * placement instancer derives for it — for every key it answers to.
 */
export function registerEntryHashes(providerId: string, sourceId: string, index: ProjectEntryIndex): void {
  for (const [assetId, e] of index.byId) {
    const version = e.sha256 ?? index.versions.get(e.id);
    if (!version) continue;
    setAssetHash(resolvedAssetKey(providerId, sourceId, assetId), {
      sha256: version,
      ...(e.sha256 && typeof e.sizeBytes === 'number' ? { sizeBytes: e.sizeBytes } : {}),
    });
  }
}

/**
 * Resolve an entry of `index` through `backend` (the `LibrarySource.resolveAsset`
 * both providers hand out). `currentPathOf` lets the open project read the
 * CURRENT manifest path of a moved document (plan-655 F5); a library project
 * passes nothing. `onReadFailure` is told when the backend could not read the
 * file — the library loader turns that into `ready → error` (F8).
 */
export function createEntryResolver(
  backend: Pick<ProjectBackend, 'readDocumentUrl'>,
  index: Pick<ProjectEntryIndex, 'byId'> & Partial<Pick<ProjectEntryIndex, 'byAlias'>>,
  label: string,
  opts: {
    currentPathOf?: (entry: LibraryCatalogEntry) => string | null;
    onReadFailure?: (path: string, error: unknown) => void;
  } = {},
): (assetId: string, purpose: ResolvePurpose) => Promise<ResolvedAsset> {
  return async (assetId: string, _purpose: ResolvePurpose): Promise<ResolvedAsset> => {
    const entry = index.byId.get(assetId) ?? index.byAlias?.get(assetId);
    if (!entry?.localPath) {
      throw new Error(`Asset "${assetId}" is not in project "${label}".`);
    }
    const path = opts.currentPathOf?.(entry) ?? entry.localPath;
    let blob: Awaited<ReturnType<ProjectBackend['readDocumentUrl']>>;
    try {
      blob = await backend.readDocumentUrl(path);
    } catch (e) {
      opts.onReadFailure?.(path, e);
      throw e;
    }
    if (!blob) {
      const err = new Error(`Asset "${path}" could not be read.`);
      opts.onReadFailure?.(path, err);
      throw err;
    }
    // `sha256` rides along for the ModelCache (plan-508 F4): the expected
    // content of this resolve, compared before the decode.
    const resolved: ResolvedAsset & { sha256?: string } = { url: blob.url, revokeUrl: () => blob!.release() };
    if (entry.sha256) resolved.sha256 = entry.sha256;
    return resolved;
  };
}
