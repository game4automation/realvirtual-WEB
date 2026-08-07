// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * build-topic-tree — derive a display tree from MQTT topic paths (plan-352).
 *
 * MQTT single-topic signals arrive as a FLAT list (`interface.signals[]`), one concrete topic per
 * signal. The hierarchy they visibly have (`rv/demo/out/OpenDoor`) exists only in the string, so the
 * signal list derives it here instead of introducing wildcard groups into the interface config —
 * receive path, publish path and address validation stay untouched.
 *
 * Pure and allocation-light: the tree is built once per interface (a `useMemo` over the addresses)
 * and flattened per render with the current open/filter state. Nothing here touches React or the
 * store.
 *
 * Rules (deliberate, see plan §2.3):
 *  - `/` is the only separator; every level becomes its own collapsible node — there is NO
 *    single-child compression, because F2 requires each level to be individually collapsible.
 *  - An address without `/` stays a top-level leaf (S7 `%Q0.1`, legacy MQTT topics without a path).
 *  - Per level: nodes before leaves, each group sorted alphabetically (ordinal, locale-independent).
 *  - A node's `count` is the number of leaves in its whole subtree, UNFILTERED — the same semantics
 *    as the existing topic-group counter, which also shows the configured total.
 */

/** A signal (leaf) of the derived tree. */
export interface TopicTreeLeaf<T> {
  readonly kind: 'leaf';
  /** Full topic path of this leaf — its address. Not unique when two signals share an address. */
  readonly path: string;
  /** Last path segment (the address without its parent levels). */
  readonly label: string;
  /** Nesting level; 0 = top level (an address without `/`). */
  readonly depth: number;
  readonly item: T;
}

/** A topic level of the derived tree. */
export interface TopicTreeNode<T> {
  readonly kind: 'node';
  /** Path of this level, e.g. `rv/demo/out` — the stable collapse identity. */
  readonly path: string;
  /** Last path segment, e.g. `out`. */
  readonly label: string;
  readonly depth: number;
  /** Number of leaves in the whole subtree (unfiltered). */
  readonly count: number;
  readonly children: ReadonlyArray<TopicTreeEntry<T>>;
}

export type TopicTreeEntry<T> = TopicTreeNode<T> | TopicTreeLeaf<T>;

/** One emitted row of a flattened tree, in render order. */
export type TopicTreeRow<T> =
  | { readonly kind: 'node'; readonly path: string; readonly label: string; readonly depth: number; readonly count: number }
  | { readonly kind: 'leaf'; readonly depth: number; readonly item: T };

/** Ordinal compare — stable across locales, unlike `localeCompare`. */
function compareLabel(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface MutableNode<T> {
  path: string;
  label: string;
  depth: number;
  count: number;
  nodes: Map<string, MutableNode<T>>;
  leaves: TopicTreeLeaf<T>[];
}

function newNode<T>(path: string, label: string, depth: number): MutableNode<T> {
  return { path, label, depth, count: 0, nodes: new Map(), leaves: [] };
}

function freeze<T>(node: MutableNode<T>): TopicTreeNode<T> {
  const children: TopicTreeEntry<T>[] = [];
  const childNodes = [...node.nodes.values()].sort((a, b) => compareLabel(a.label, b.label));
  for (const child of childNodes) children.push(freeze(child));
  const leaves = [...node.leaves].sort((a, b) => compareLabel(a.label, b.label));
  for (const leaf of leaves) children.push(leaf);
  return { kind: 'node', path: node.path, label: node.label, depth: node.depth, count: node.count, children };
}

/**
 * Build the derived topic tree of `items`, keyed by the address returned from `addressOf`.
 * Returns the top-level entries in render order.
 */
export function buildTopicTree<T>(
  items: readonly T[],
  addressOf: (item: T) => string,
): ReadonlyArray<TopicTreeEntry<T>> {
  const root = newNode<T>('', '', -1);

  for (const item of items) {
    const address = addressOf(item) ?? '';
    const segments = address.split('/');
    // No separator → a top-level leaf; the tree never wraps a single-segment address in a node.
    if (segments.length < 2) {
      root.leaves.push({ kind: 'leaf', path: address, label: address, depth: 0, item });
      continue;
    }

    let parent = root;
    let path = '';
    for (let i = 0; i < segments.length - 1; i++) {
      path = i === 0 ? segments[0] : `${path}/${segments[i]}`;
      let node = parent.nodes.get(segments[i]);
      if (!node) {
        node = newNode<T>(path, segments[i], i);
        parent.nodes.set(segments[i], node);
      }
      node.count++;
      parent = node;
    }
    parent.leaves.push({
      kind: 'leaf',
      path: address,
      label: segments[segments.length - 1],
      depth: segments.length - 1,
      item,
    });
  }

  return freeze(root).children;
}

/**
 * All ancestor node paths of an address, outermost first:
 * `rv/demo/out/OpenDoor` → `['rv', 'rv/demo', 'rv/demo/out']`. Empty for an address without `/`.
 * This is the input the filter auto-open needs so a matching leaf opens EVERY level above it (F4).
 */
export function ancestorPathsOf(address: string): string[] {
  const segments = (address ?? '').split('/');
  if (segments.length < 2) return [];
  const paths: string[] = [];
  let path = '';
  for (let i = 0; i < segments.length - 1; i++) {
    path = i === 0 ? segments[0] : `${path}/${segments[i]}`;
    paths.push(path);
  }
  return paths;
}

/**
 * Flatten the tree into render rows.
 *
 * `isOpen(path)` decides whether a node's children are emitted. `isLeafVisible` (the active filter)
 * prunes: a leaf is dropped when it does not match, and a node is dropped entirely when its subtree
 * holds no matching leaf — so filtering never leaves empty branches behind. Node counts always show
 * the unfiltered subtree total.
 */
export function flattenTopicTree<T>(
  entries: ReadonlyArray<TopicTreeEntry<T>>,
  opts: { isOpen: (path: string) => boolean; isLeafVisible?: (item: T) => boolean },
): TopicTreeRow<T>[] {
  const rows: TopicTreeRow<T>[] = [];
  emit(entries, rows, opts);
  return rows;
}

function hasVisibleLeaf<T>(entry: TopicTreeEntry<T>, isLeafVisible: (item: T) => boolean): boolean {
  if (entry.kind === 'leaf') return isLeafVisible(entry.item);
  for (const child of entry.children) if (hasVisibleLeaf(child, isLeafVisible)) return true;
  return false;
}

function emit<T>(
  entries: ReadonlyArray<TopicTreeEntry<T>>,
  rows: TopicTreeRow<T>[],
  opts: { isOpen: (path: string) => boolean; isLeafVisible?: (item: T) => boolean },
): void {
  const visible = opts.isLeafVisible;
  for (const entry of entries) {
    if (entry.kind === 'leaf') {
      if (visible && !visible(entry.item)) continue;
      rows.push({ kind: 'leaf', depth: entry.depth, item: entry.item });
      continue;
    }
    if (visible && !hasVisibleLeaf(entry, visible)) continue;
    rows.push({ kind: 'node', path: entry.path, label: entry.label, depth: entry.depth, count: entry.count });
    if (opts.isOpen(entry.path)) emit(entry.children, rows, opts);
  }
}
