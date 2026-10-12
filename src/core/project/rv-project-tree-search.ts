// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-tree-search — the open project, searched all the way down
 * (plan-507 F7–F13).
 *
 * The dashboard search used to filter only the folder in view, so a model two
 * folders down — or in an attached library — was invisible to it. This module
 * is the recursive answer, split into steps whose ORDER is the contract:
 *
 *   index (per tree change) → search (per keystroke, uncapped)
 *     → chip counting (caller) → chip/tag filter → cap
 *
 * Capping before the chip filter would cut hits the chip wanted and make the
 * "N more" line lie; counting chips after it would make a count change as the
 * chip is clicked. So the search is uncapped and {@link capSearchResult} is a
 * separate, last step.
 *
 * ## Why an index at all
 *
 * The walk over every root (libraries included) is the expensive part and it
 * depends only on the tree. Building it once per `treeRoots` change leaves the
 * keystroke with one scorer call per node — the 5 ms budget of plan-507's NFR.
 *
 * ## What is never a hit
 *
 * A root node (it IS the group) and the synthetic System node. A hit matches on
 * the node's own NAME, never its path: a folder called `lines` is a hit, the
 * files inside it are not — otherwise one folder name would flood the list with
 * its whole subtree.
 */

import type { ProjectTreeNode, ProjectTreeRootKind } from './rv-project-tree';
import { SYSTEM_NODE_PATH } from './rv-project-tree';
import { scoreFields, tokenizeSearchTerm, type SearchScore } from './rv-search-score';
import type { ClassifiedRow } from '../hmi/projects/document-filter';
import type { DocumentClassification } from './rv-document-classification';

/** One crumb = one ancestor folder; `path` is the tree path so a crumb can be selected. */
export interface SearchCrumb { name: string; path: string }

/** Built ONCE per treeRoots change; the search consumes only this. */
export interface ProjectSearchIndexEntry {
  node: ProjectTreeNode;
  rootId: string;
  rootName: string;
  rootKind: ProjectTreeRootKind;
  /** Ancestors between root and node, root excluded, node excluded — collapseCrumbs-compatible. */
  crumbs: SearchCrumb[];
  /** Walk order — the stable tiebreak. */
  ord: number;
  /** `node.name` lowercased once at build time — the keystroke's cheap reject. */
  nameLower: string;
}

export interface ProjectSearchRoot { rootId: string; rootName: string; rootKind: ProjectTreeRootKind }

export interface ProjectSearchIndex {
  entries: ProjectSearchIndexEntry[];
  roots: ProjectSearchRoot[];
}

export interface ProjectSearchHit { entry: ProjectSearchIndexEntry; score: SearchScore }

export interface ProjectSearchGroup extends ProjectSearchRoot { hits: ProjectSearchHit[] }

export interface ProjectSearchResult {
  groups: ProjectSearchGroup[];
  /** Hits after every filter, before the cap. */
  total: number;
  /** `total` exceeded the cap; the list shows fewer than `total`. */
  truncated: boolean;
}

/** Most rows the result list renders; the rest is one "N more" line. */
export const MAX_SEARCH_RESULTS = 200;

function isSystemNode(node: ProjectTreeNode): boolean {
  return node.kind === 'system' || node.path === `${node.rootId}/${SYSTEM_NODE_PATH}`;
}

/**
 * Flatten the forest once, remembering each node's ancestor trail.
 *
 * A trail walk rather than `walkProjectTree` + `ancestorPathsOf` per hit: the
 * crumbs fall out of the recursion for free, where looking them up per hit
 * would walk the tree again for every row shown.
 */
export function buildProjectSearchIndex(roots: readonly ProjectTreeNode[]): ProjectSearchIndex {
  const entries: ProjectSearchIndexEntry[] = [];
  const outRoots: ProjectSearchRoot[] = [];
  for (const root of roots) {
    const rootInfo: ProjectSearchRoot = {
      rootId: root.rootId,
      rootName: root.name,
      rootKind: root.rootKind ?? 'project',
    };
    outRoots.push(rootInfo);
    const trail: SearchCrumb[] = [];
    const walk = (node: ProjectTreeNode): void => {
      for (const child of node.children) {
        if (!isSystemNode(child)) {
          entries.push({
            node: child, ...rootInfo, crumbs: trail.slice(), ord: entries.length,
            nameLower: child.name.toLowerCase(),
          });
        }
        if (child.children.length > 0) {
          trail.push({ name: child.name, path: child.path! });
          walk(child);
          trail.pop();
        }
      }
    };
    walk(root);
  }
  return { entries, roots: outRoots };
}

/**
 * Every hit of the term, grouped by root in root order. UNCAPPED.
 *
 * Within a group: best score first, walk order on a tie. An empty term is no
 * search at all and yields no groups.
 */
export function searchProjectIndex(index: ProjectSearchIndex, term: string): ProjectSearchGroup[] {
  const tokens = tokenizeSearchTerm(term);
  if (tokens.length === 0) return [];
  const byRoot = new Map<string, ProjectSearchHit[]>();
  const fields: string[] = [''];
  entries: for (const entry of index.entries) {
    // Most nodes miss: reject them on the precomputed lowercase name before
    // the scorer allocates anything.
    for (const token of tokens) if (!entry.nameLower.includes(token)) continue entries;
    fields[0] = entry.node.name;
    const score = scoreFields(fields, tokens);
    if (!score) continue;
    let hits = byRoot.get(entry.rootId);
    if (!hits) { hits = []; byRoot.set(entry.rootId, hits); }
    hits.push({ entry, score });
  }
  const groups: ProjectSearchGroup[] = [];
  for (const root of index.roots) {
    const hits = byRoot.get(root.rootId);
    if (!hits || hits.length === 0) continue;
    hits.sort((a, b) => (b.score.score - a.score.score) || (a.entry.ord - b.entry.ord));
    groups.push({ ...root, hits });
  }
  return groups;
}

/** Applies a per-hit predicate — used AFTER chip counting. Empty groups drop out. */
export function filterSearchGroups(
  groups: readonly ProjectSearchGroup[],
  keep: (hit: ProjectSearchHit) => boolean,
): ProjectSearchGroup[] {
  const out: ProjectSearchGroup[] = [];
  for (const group of groups) {
    const hits = group.hits.filter(keep);
    if (hits.length > 0) out.push({ ...group, hits });
  }
  return out;
}

/** Cap over all groups together; `total` counts the FILTERED hits. The last step. */
export function capSearchResult(
  groups: readonly ProjectSearchGroup[],
  max = MAX_SEARCH_RESULTS,
): ProjectSearchResult {
  let total = 0;
  for (const g of groups) total += g.hits.length;
  if (total <= max) return { groups: [...groups], total, truncated: false };
  const out: ProjectSearchGroup[] = [];
  let left = Math.max(0, max);
  for (const g of groups) {
    if (left === 0) break;
    const hits = g.hits.slice(0, left);
    left -= hits.length;
    out.push({ ...g, hits });
  }
  return { groups: out, total, truncated: true };
}

/** Number of hit rows a result actually shows. */
export function shownSearchHits(result: ProjectSearchResult): number {
  let n = 0;
  for (const g of result.groups) n += g.hits.length;
  return n;
}

/**
 * Does the chip/tag filter apply to this hit? Every leaf does — documents and
 * files alike, exactly like the folder cards — a folder never does.
 */
export function isDocumentHit(hit: ProjectSearchHit): boolean {
  const kind = hit.entry.node.kind;
  return kind === 'document' || kind === 'file';
}

/**
 * May a search row be ACTIVATED (Enter / double-click / touch chevron)?
 *
 * A folder navigates, an asset opens. Every `file` row — attachment, CONNECT
 * config, knowledge file, script, inert plain file — is inspected, never opened
 * (the host's `handleTreeActivate` refuses them all), and an inert document has
 * no verb at all.
 */
export function isActivatableSearchNode(node: ProjectTreeNode): boolean {
  if (node.kind === 'folder') return true;
  return node.kind === 'document' && !node.inert;
}

/** The document hits as chip rows — what `documentChipOptions` counts in search mode. */
export function searchDocumentRows(
  groups: readonly ProjectSearchGroup[],
  classificationOf: (node: ProjectTreeNode) => DocumentClassification | undefined,
): ClassifiedRow[] {
  const rows: ClassifiedRow[] = [];
  for (const g of groups) {
    for (const hit of g.hits) {
      if (!isDocumentHit(hit)) continue;
      rows.push({ name: hit.entry.node.name, classification: classificationOf(hit.entry.node) });
    }
  }
  return rows;
}
