// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-tree-sources — from listings to one tree (plan-703 Phase 6, §2.6).
 *
 * `rv-project-tree.ts` builds nodes from {@link ProjectTreeRootInput}s and
 * refuses to know where a listing came from. This module is the other half:
 * it takes what the app actually has — the project store's `documents[]`, the
 * `docs-index.json` attachments and the registered library sources — and says
 * what the roots are.
 *
 * ## Three decisions live here, and only here
 *
 *  1. **The project folder is root 1; every catalog is a sibling root.** Not a
 *     child, not a second panel. A catalog is marked (`kind: 'catalog'`) and a
 *     read-only one is `writable: false`, which is what makes
 *     `canMoveInTree` / `canRenameInTree` refuse it without this module having
 *     to enforce anything.
 *  2. **A tree row must be answerable.** Clicking a row has to produce a
 *     selection, and a double-click has to open the right thing — but the tree
 *     model deliberately carries no provider identity. So the roots come back
 *     with an {@link DashboardTree.refs} index keyed by tree path. Parsing the
 *     path back apart would be the alternative, and a `providerId` containing a
 *     slash would silently break it.
 *  3. **What the project root contains.** Every manifest document, plus the
 *     paths `docs-index.json` points at. Deliberately not a recursive folder
 *     walk: the two things a move has to keep honest are a manifest row and a
 *     docs-index row (§2.6.5, F12/F13), and those are exactly these two
 *     listings. A file that is in neither is a file no reference can break on.
 *
 * ## Filtering
 *
 * The dashboard's search/chip/tag filter is applied here rather than to the
 * built tree, because folders are derived from the surviving paths — filter the
 * files and the empty folders disappear on their own. A folder that would be
 * left with no children is therefore never rendered, which is the behaviour a
 * grid had for free and a tree has to be given.
 *
 * No storage, no React, no `LibrarySource` calls: every input is a value.
 */

import type { ProjectTreeFile, ProjectTreeRootInput } from './rv-project-tree';

// ─── Inputs ─────────────────────────────────────────────────────────────

/** The subset of a manifest document row the tree needs. */
export interface TreeDocumentInput {
  /** Manifest document id, when the row has one. */
  id?: string;
  /** Project-relative path. */
  path: string;
  name?: string;
}

export interface ProjectRootInput {
  /** Project id — becomes the root's stable tree id. */
  id: string;
  name: string;
  writable: boolean;
  documents: readonly TreeDocumentInput[];
  /**
   * Project-relative paths of non-document files, i.e. the `docs-index.json`
   * targets. Anything already listed as a document is ignored.
   */
  attachments?: readonly string[];
  /** `RvProject.folders` — the folders that exist while still empty. */
  folders?: readonly string[];
}

/** One catalog entry, flattened out of a `LibrarySource`. */
export interface TreeCatalogEntryInput {
  /** The id the source answers to — what a selection and an open both carry. */
  assetId: string;
  name: string;
  /**
   * Path inside the catalog. `localPath` when the source has one, otherwise
   * derived from the URL. Empty means "put it at the catalog root".
   */
  path?: string;
}

export interface CatalogRootInput {
  providerId: string;
  sourceId: string;
  label: string;
  writable: boolean;
  /** Remote catalogs carry the `(o)` origin mark of §3.1. */
  remote: boolean;
  entries: readonly TreeCatalogEntryInput[];
}

/** What one tree row points at. The tree model itself carries none of this. */
export type DashboardTreeRef =
  | { kind: 'document'; path: string; documentId?: string }
  | { kind: 'attachment'; path: string }
  | { kind: 'catalogAsset'; providerId: string; sourceId: string; assetId: string };

export interface DashboardTree {
  roots: ProjectTreeRootInput[];
  /** Tree path → what that row is. Only leaf rows appear. */
  refs: Map<string, DashboardTreeRef>;
}

/** Does this row survive the dashboard filter? Absent = everything survives. */
export type TreeRowFilter = (row: { name: string; path: string }) => boolean;

export interface BuildDashboardTreeOptions {
  project: ProjectRootInput | null;
  catalogs?: readonly CatalogRootInput[];
  accept?: TreeRowFilter;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normalise(path: string): string {
  return (path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function leafOf(path: string): string {
  return normalise(path).split('/').filter(Boolean).pop() ?? path;
}

/**
 * The tree id of a catalog root.
 *
 * `${providerId}:${sourceId}` is the same composite key the collapse store and
 * the React lists already use, so a catalog cannot be one thing here and
 * another there.
 */
export function catalogRootId(providerId: string, sourceId: string): string {
  return `${providerId}:${sourceId}`;
}

/**
 * Where a catalog entry sits inside its catalog.
 *
 * `localPath` is authoritative when a source has one (local folders and the
 * project library do). Otherwise the entry only has a URL, and the part after
 * the last `library/` is the closest thing to a folder structure it carries —
 * the same slice `crossSourceKeyOf` takes, for the same reason. A URL with no
 * such folder falls back to its file name, and an entry with neither falls back
 * to its display name, so an entry is never dropped for want of a path.
 */
export function catalogEntryPath(entry: TreeCatalogEntryInput): string {
  const raw = normalise(entry.path ?? '');
  if (raw !== '') {
    // A URL sneaked in through `path`: keep only the library-relative tail.
    const idx = raw.toLowerCase().lastIndexOf('library/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return idx >= 0 ? raw.slice(idx + 'library/'.length) : leafOf(raw);
    }
    return raw;
  }
  return entry.name.trim() || entry.assetId;
}

/**
 * Make `path` unique inside one root by appending ` (2)`, ` (3)`, …
 *
 * Two rows with one tree path would give the virtualizer one row key for two
 * rows and it would render whichever it saw last — a card grid tolerated
 * duplicates, a keyed tree does not.
 */
function uniquePath(taken: Set<string>, path: string): string {
  if (!taken.has(path)) { taken.add(path); return path; }
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  return path;
}

// ─── Build ──────────────────────────────────────────────────────────────

/**
 * The roots of the dashboard tree, plus the index that makes its rows clickable.
 *
 * Returns an empty tree when nothing is open — the caller renders its own empty
 * state, which says something more useful than a tree with no roots would.
 */
export function buildDashboardTree({
  project,
  catalogs = [],
  accept,
}: BuildDashboardTreeOptions): DashboardTree {
  const roots: ProjectTreeRootInput[] = [];
  const refs = new Map<string, DashboardTreeRef>();
  const keep = accept ?? (() => true);

  if (project) {
    const files: ProjectTreeFile[] = [];
    const taken = new Set<string>();

    for (const doc of project.documents) {
      const path = normalise(doc.path);
      if (path === '') continue;
      const name = doc.name?.trim() || leafOf(path);
      if (!keep({ name, path })) continue;
      if (taken.has(path)) continue;         // the manifest listed it twice
      taken.add(path);
      files.push({ path, name, ...(doc.id ? { documentId: doc.id } : {}) });
      refs.set(`${project.id}/${path}`, {
        kind: 'document', path, ...(doc.id ? { documentId: doc.id } : {}),
      });
    }

    for (const raw of project.attachments ?? []) {
      const path = normalise(raw);
      if (path === '' || taken.has(path)) continue;
      const name = leafOf(path);
      if (!keep({ name, path })) continue;
      taken.add(path);
      files.push({ path, name });
      refs.set(`${project.id}/${path}`, { kind: 'attachment', path });
    }

    // Declared folders are NOT run through `accept`: the filter answers "does
    // this row match the search", and a folder that matches nothing still has
    // to be there to hold what does.
    roots.push({
      id: project.id,
      name: project.name,
      kind: 'project',
      writable: project.writable,
      files,
      ...(project.folders?.length ? { folders: project.folders } : {}),
    });
  }

  for (const catalog of catalogs) {
    const id = catalogRootId(catalog.providerId, catalog.sourceId);
    const files: ProjectTreeFile[] = [];
    const taken = new Set<string>();

    for (const entry of catalog.entries) {
      const base = catalogEntryPath(entry);
      if (base === '') continue;
      const name = entry.name.trim() || leafOf(base);
      // Filtered on the path the entry WANTS, before the dedup suffix: whether
      // a row survives the filter must not depend on how many rows came first.
      if (!keep({ name, path: base })) continue;
      const path = uniquePath(taken, base);
      files.push({ path, name });
      refs.set(`${id}/${path}`, {
        kind: 'catalogAsset',
        providerId: catalog.providerId,
        sourceId: catalog.sourceId,
        assetId: entry.assetId,
      });
    }

    roots.push({
      id,
      name: catalog.label,
      kind: 'catalog',
      writable: catalog.writable,
      ...(catalog.remote ? { remote: true } : {}),
      files,
    });
  }

  return { roots, refs };
}
