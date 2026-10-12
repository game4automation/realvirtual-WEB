// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-search — the models of every project, searched from the Projects
 * screen (plan-509 Phase 2).
 *
 * Pure, storage-free, and split into steps whose order is the contract — the
 * same shape as the in-project search (`rv-project-tree-search.ts`):
 *
 *   visibleSnapshots (per list change) → build (per snapshot/list change)
 *     → search (per keystroke; bounded by `max`, see searchModelIndex) → cap
 *
 * ## Filtered, never deleted (SOL F6)
 *
 * A folder snapshot whose project is no longer in the linked list is HIDDEN by
 * {@link visibleSnapshots}, not removed: `listLinkedProjects()` answers `[]` on
 * a read error, and deleting on that answer would wipe every valid snapshot
 * after one transient failure. Deletion belongs to `forgetProjectTraces` alone.
 *
 * ## The group name comes from the project list (SOL R2 F3/F5)
 *
 * {@link buildModelSearchIndex} takes the Projects screen's own, UNFILTERED
 * list for both the group order and the group name. A project renamed while
 * closed therefore shows its current name; the snapshot's `projectName` is a
 * fallback only, for a snapshot the list has no row for.
 *
 * ## Name and tags, one reject (SOL F2)
 *
 * The scorer sees `[name, tags.join(' ')]` — name weighs more than tags. The
 * cheap per-keystroke reject checks every token against `haystackLower`,
 * name AND tags together, so a pure tag hit and a term whose tokens split
 * across name and tags both reach the scorer.
 */

import { scoreFields, tokenizeSearchTerm, type SearchScore } from './rv-search-score';
import { MAX_SEARCH_RESULTS } from './rv-project-tree-search';
import {
  snapshotKey,
  type ModelIndexBackend, type ModelIndexDoc, type ModelIndexSnapshot,
} from './rv-model-index';

export { MAX_SEARCH_RESULTS };

/** One row of the Projects screen, in screen order — `key` = `<backend>:<projectId>`. */
export interface ModelSearchProject {
  key: string;
  name: string;
}

export interface ModelSearchEntry {
  doc: ModelIndexDoc;
  projectId: string;
  projectName: string;
  backend: ModelIndexBackend;
  /** Folders of `doc.path`, the file itself excluded. */
  crumbs: string[];
  /** `name + ' ' + tags`, lowercased once — the keystroke's cheap reject. */
  haystackLower: string;
  /** Project order, then path — the stable tiebreak. */
  ord: number;
}

export interface ModelSearchGroupInfo {
  key: string;
  projectId: string;
  projectName: string;
  backend: ModelIndexBackend;
}

export interface ModelSearchIndex {
  entries: ModelSearchEntry[];
  /** Every indexed project, in display order. */
  groups: ModelSearchGroupInfo[];
}

export interface ModelSearchHit { entry: ModelSearchEntry; score: SearchScore }

export interface ModelSearchGroup extends ModelSearchGroupInfo { hits: ModelSearchHit[] }

export interface ModelSearchResult {
  groups: ModelSearchGroup[];
  /** Every hit, before the cap. */
  total: number;
  /** `total` exceeded the cap; fewer rows are shown than `total`. */
  truncated: boolean;
}

/**
 * The snapshots the screen may show: every non-folder snapshot, and a folder
 * snapshot only while its project is linked. Returns a new array; the input is
 * left untouched and nothing is deleted.
 */
export function visibleSnapshots(
  snapshots: readonly ModelIndexSnapshot[],
  linkedIds: Iterable<string>,
): ModelIndexSnapshot[] {
  const linked = new Set(linkedIds);
  return snapshots.filter(s => s.backend !== 'folder' || linked.has(s.projectId));
}

/** `models/lines/a.glb` → `['models', 'lines']`. */
export function crumbsOfPath(path: string): string[] {
  const parts = path.split('/').filter(p => p !== '');
  parts.pop();
  return parts;
}

/**
 * Flatten the snapshots into one index.
 *
 * Groups follow `projects` (the screen's order, bundled first); a snapshot the
 * list has no row for goes after them, in key order, under its own recorded
 * name. Within a project the documents are ordered by path.
 */
export function buildModelSearchIndex(
  snapshots: readonly ModelIndexSnapshot[],
  projects: readonly ModelSearchProject[],
): ModelSearchIndex {
  const byKey = new Map<string, ModelIndexSnapshot>();
  for (const s of snapshots) byKey.set(snapshotKey(s), s);

  const ordered: { snap: ModelIndexSnapshot; name: string }[] = [];
  const used = new Set<string>();
  for (const p of projects) {
    const snap = byKey.get(p.key);
    if (!snap || used.has(p.key)) continue;
    used.add(p.key);
    ordered.push({ snap, name: p.name || snap.projectName });
  }
  const rest = [...byKey.keys()].filter(k => !used.has(k)).sort();
  for (const k of rest) {
    const snap = byKey.get(k)!;
    ordered.push({ snap, name: snap.projectName || snap.projectId });
  }

  const entries: ModelSearchEntry[] = [];
  const groups: ModelSearchGroupInfo[] = [];
  for (const { snap, name } of ordered) {
    groups.push({ key: snapshotKey(snap), projectId: snap.projectId, projectName: name, backend: snap.backend });
    const docs = [...snap.docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const doc of docs) {
      entries.push({
        doc,
        projectId: snap.projectId,
        projectName: name,
        backend: snap.backend,
        crumbs: crumbsOfPath(doc.path),
        haystackLower: `${doc.name} ${doc.tags.join(' ')}`.toLowerCase(),
        ord: entries.length,
      });
    }
  }
  return { entries, groups };
}

/**
 * Every hit of the term, grouped by project in index order. Within a group:
 * best score first, then `ord`. An empty term yields no groups.
 *
 * Uncapped by default — cap with {@link capModelSearch}. With `max`, groups
 * that start after `max` hits are COUNTED into `total` but neither scored nor
 * returned: the groups follow the project order, not the score, so no such
 * group could survive the cap anyway, and scoring a single-letter term's
 * twenty thousand hits is what would blow the keystroke budget.
 * `capModelSearch(searchModelIndex(i, t, max), max)` shows exactly what
 * `capModelSearch(searchModelIndex(i, t), max)` shows, with the same `total`.
 */
export function searchModelIndex(
  index: ModelSearchIndex,
  term: string,
  max: number = Infinity,
): ModelSearchResult {
  const tokens = tokenizeSearchTerm(term);
  if (tokens.length === 0) return { groups: [], total: 0, truncated: false };
  const byKey = new Map<string, ModelSearchHit[]>();
  const fields: string[] = ['', ''];
  let total = 0;
  // Entries are laid out group by group (see buildModelSearchIndex), so the
  // hits before the current group are a running count.
  let groupKey = '';
  let beforeGroup = 0;
  entries: for (const entry of index.entries) {
    // The reject is exact, not a pre-filter: tokens carry no whitespace, so a
    // token occurs in `name + ' ' + tags` exactly when it occurs in a field.
    for (const token of tokens) if (!entry.haystackLower.includes(token)) continue entries;
    const key = `${entry.backend}:${entry.projectId}`;
    if (key !== groupKey) { groupKey = key; beforeGroup = total; }
    total++;
    if (beforeGroup >= max) continue;   // past the cap: counted, never shown
    fields[0] = entry.doc.name;
    fields[1] = entry.doc.tags.join(' ');
    const score = scoreFields(fields, tokens);
    if (!score) continue;
    let hits = byKey.get(key);
    if (!hits) { hits = []; byKey.set(key, hits); }
    hits.push({ entry, score });
  }
  const groups: ModelSearchGroup[] = [];
  for (const g of index.groups) {
    const hits = byKey.get(g.key);
    if (!hits || hits.length === 0) continue;
    hits.sort((a, b) => (b.score.score - a.score.score) || (a.entry.ord - b.entry.ord));
    groups.push({ ...g, hits });
  }
  return { groups, total, truncated: false };
}

/** Cap over all groups together; `total` stays the uncapped count. The last step. */
export function capModelSearch(
  result: ModelSearchResult,
  max: number = MAX_SEARCH_RESULTS,
): ModelSearchResult {
  if (result.total <= max) return result;
  const out: ModelSearchGroup[] = [];
  let left = Math.max(0, max);
  for (const g of result.groups) {
    if (left === 0) break;
    const hits = g.hits.slice(0, left);
    left -= hits.length;
    out.push({ ...g, hits });
  }
  return { groups: out, total: result.total, truncated: true };
}

/** Number of hit rows a result actually shows. */
export function shownModelHits(result: ModelSearchResult): number {
  let n = 0;
  for (const g of result.groups) n += g.hits.length;
  return n;
}

/**
 * Linked projects the index knows nothing about — the F11 hint ("only
 * projects opened once are indexed") is shown when there is at least one.
 */
export function unindexedLinkedCount(
  snapshots: readonly ModelIndexSnapshot[],
  linkedIds: Iterable<string>,
): number {
  const indexed = new Set(snapshots.filter(s => s.backend === 'folder').map(s => s.projectId));
  let n = 0;
  for (const id of linkedIds) if (!indexed.has(id)) n++;
  return n;
}
