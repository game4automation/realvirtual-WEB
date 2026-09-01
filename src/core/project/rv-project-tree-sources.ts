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
 *  3. **What the project root contains.** Since plan-445 F1: EVERYTHING the
 *     project folder holds. The four reference-bearing listings first — manifest
 *     documents, the paths `docs-index.json` points at, the `*.connect.json`
 *     configs and the `*.knowledge.md` files — and then, deduped against all
 *     four, whatever else the backend's walk found ({@link
 *     ProjectRootInput.plainFiles}). The distinction did not disappear, it moved:
 *     a file in one of the four listings is a file a move has to keep honest
 *     (§2.6.5, F12/F13), and a file in none of them is one no reference can
 *     break on — so it is listed INERT and no verb touches it.
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
import { stripConnectConfigSuffix, stripKnowledgeFileSuffix } from './rv-project-refs';

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
  /**
   * Project-relative paths of the CONNECT configuration files
   * (`*.connect.json`), from the backend's suffix walk. A config is a config
   * by its ENDING, wherever it sits (plan-718 reference model) — this list is
   * what makes one visible even though it is neither a manifest document nor a
   * docs-index target. Anything already listed above is ignored.
   */
  configs?: readonly string[];
  /**
   * Project-relative paths of the knowledge files (`*.knowledge.md`) — the
   * `knowledgeRef` twin of {@link configs}, same by-ending rule, same
   * listing origin. Anything already listed above is ignored.
   */
  knowledge?: readonly string[];
  /**
   * Every REMAINING file of the project folder, from the backend's one walk
   * (plan-445 F1) — internals already filtered by the backend.
   *
   * This is what turns the curated listing into the honest full view. A file
   * that is none of the four lists above has no reference model behind it, so
   * it arrives as an INERT row: visible, selectable, and refused by
   * `canMoveInTree` / `canRenameInTree` as a source. Anything already listed
   * above is ignored — same dedupe rule as {@link configs} / {@link knowledge}.
   */
  plainFiles?: readonly string[];
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
  /**
   * What one of this root's rows POINTS AT. Defaults to `catalogAsset`.
   *
   * The built-in demo catalog (plan-445 F6) is a catalog root by structure and
   * something else entirely by verb: a `catalogAsset` activates into the asset
   * EDITOR, which is the wrong answer for a demo model — opening one has to
   * load it as the working scene, exactly as the `?model=` deep link does. The
   * two are therefore different ref kinds rather than one kind with a flag the
   * activation handler has to remember to read.
   */
  refKind?: 'catalogAsset' | 'bundledDocument';
}

/** What one tree row points at. The tree model itself carries none of this. */
export type DashboardTreeRef =
  | { kind: 'document'; path: string; documentId?: string }
  | { kind: 'attachment'; path: string }
  /** A CONNECT configuration file — classified by ending, not by folder. */
  | { kind: 'connectConfig'; path: string }
  /** A knowledge file (`*.knowledge.md`) — classified by ending too. */
  | { kind: 'knowledgeFile'; path: string }
  /**
   * Any other file of the project folder (plan-445 F1/F2). INERT: it carries a
   * path so the pane can describe it, and no verb at all.
   */
  | { kind: 'plainFile'; path: string }
  /**
   * A read-only built-in demo model (plan-445 F6). `url` is what
   * `sceneStore.openBuiltin` loads — the same deploy URL the `?model=` deep
   * link resolves to — so activating one never switches the open project.
   */
  | { kind: 'bundledDocument'; url: string; path: string }
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

/** One project row on its way into the tree, before the collision pass. */
interface PendingRow {
  path: string;
  name: string;
  documentId?: string;
  inert?: boolean;
  /** True when {@link name} had a compound classifier ending removed. */
  stripped?: boolean;
  ref: DashboardTreeRef;
}

/** The directory part of a normalised path — `''` for the project root. */
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

/**
 * "Is there another row with this name in this folder" as one string key.
 *
 * Joined with `/`, which is unambiguous rather than merely convenient: a
 * directory carries no trailing slash and a display name can contain no `/` at
 * all (`ILLEGAL_NAME` in `rv-project-tree.ts` forbids it, and a name derived
 * from a path is one segment by construction). So no two distinct
 * `(folder, name)` pairs can produce the same key.
 */
function folderNameKey(path: string, name: string): string {
  return `${dirOf(path)}/${name.toLowerCase()}`;
}

/**
 * Give a suffix-stripped row its FULL file name back when the short one would
 * collide with a sibling (plan-445 §5.2).
 *
 * `device.connect.json` shows as `device` — which is right until something else
 * in that folder also reads as `device`: an extension-less file of that name, or
 * its knowledge twin `device.knowledge.md`, which strips to the same thing. Then
 * there are two identical rows, the user cannot tell which is which, and the
 * display-name collision check inside `canRenameInTree` starts refusing a rename
 * the filesystem would happily accept. (A plain `device.json` is NOT one of
 * these: the WHOLE `.connect.json` is stripped, not just `.connect`.)
 *
 * Only the STRIPPED rows give the short name up; the file that owns its name
 * outright keeps it, so the fallback reads as "this one needed disambiguating"
 * rather than as two arbitrary long names.
 *
 * In place, because the caller built the array and nothing else has seen it.
 */
function unstripCollidingNames(rows: PendingRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = folderNameKey(row.path, row.name);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    if (!row.stripped) continue;
    if ((seen.get(folderNameKey(row.path, row.name)) ?? 0) > 1) {
      row.name = leafOf(row.path);
    }
  }
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
    const rows: PendingRow[] = [];
    const taken = new Set<string>();

    for (const doc of project.documents) {
      const path = normalise(doc.path);
      if (path === '') continue;
      const name = doc.name?.trim() || leafOf(path);
      if (!keep({ name, path })) continue;
      if (taken.has(path)) continue;         // the manifest listed it twice
      taken.add(path);
      rows.push({
        path,
        name,
        ...(doc.id ? { documentId: doc.id } : {}),
        ref: { kind: 'document', path, ...(doc.id ? { documentId: doc.id } : {}) },
      });
    }

    for (const raw of project.attachments ?? []) {
      const path = normalise(raw);
      if (path === '' || taken.has(path)) continue;
      const name = leafOf(path);
      if (!keep({ name, path })) continue;
      taken.add(path);
      rows.push({ path, name, ref: { kind: 'attachment', path } });
    }

    for (const raw of project.configs ?? []) {
      const path = normalise(raw);
      if (path === '' || taken.has(path)) continue;
      // The `.connect.json` ending is the CLASSIFIER, not part of the name —
      // no row or card ever shows it. The path keeps it, of course: it is the
      // identity every ref and every storage call runs on.
      const name = leafOf(stripConnectConfigSuffix(path));
      if (!keep({ name, path })) continue;
      taken.add(path);
      rows.push({ path, name, stripped: true, ref: { kind: 'connectConfig', path } });
    }

    for (const raw of project.knowledge ?? []) {
      const path = normalise(raw);
      if (path === '' || taken.has(path)) continue;
      // Same rule as the configs above: the ending classifies, the name drops it.
      const name = leafOf(stripKnowledgeFileSuffix(path));
      if (!keep({ name, path })) continue;
      taken.add(path);
      rows.push({ path, name, stripped: true, ref: { kind: 'knowledgeFile', path } });
    }

    // LAST, and only what the four lists above did not claim: everything else
    // the project folder holds (plan-445 F1). Inert — see `DashboardTreeRef`.
    for (const raw of project.plainFiles ?? []) {
      const path = normalise(raw);
      if (path === '' || taken.has(path)) continue;
      const name = leafOf(path);
      if (!keep({ name, path })) continue;
      taken.add(path);
      rows.push({ path, name, inert: true, ref: { kind: 'plainFile', path } });
    }

    unstripCollidingNames(rows);
    const files: ProjectTreeFile[] = rows.map(r => ({
      path: r.path,
      name: r.name,
      ...(r.documentId ? { documentId: r.documentId } : {}),
      ...(r.inert ? { inert: true } : {}),
    }));
    for (const r of rows) refs.set(`${project.id}/${r.path}`, r.ref);

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
      refs.set(`${id}/${path}`, catalog.refKind === 'bundledDocument'
        // A built-in demo is addressed by the URL it loads from, which is what
        // `assetId` carries for this root — see `CatalogRootInput.refKind`.
        ? { kind: 'bundledDocument', url: entry.assetId, path }
        : {
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
