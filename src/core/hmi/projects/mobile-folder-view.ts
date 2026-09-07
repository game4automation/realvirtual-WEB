// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The two data rules the compact projects layout adds (plan-458 §2.3).
 *
 * They live outside `ProjectsDashboardHost.tsx` because that file cannot be
 * rendered by a test — it pulls the project store, the library registry, the
 * scene store and the viewer. A rule kept in there could only ever be pinned
 * through a reproduction of the host's wiring; here it is pinned directly.
 *
 * Both are pure: they map tree nodes and crumb records to what the grid and
 * the breadcrumb should show, and know nothing about React or MUI.
 */

import type { ProjectTreeNode } from '../../project/rv-project-tree';

/**
 * An attached library as a root-level navigation tile.
 *
 * On the phone there is no tree column, so the libraries a project has
 * attached would have no entrance at all. They become tiles in the grid's own
 * "Libraries" section — the same shape a subfolder tile has, because to the
 * user they are the same gesture: tap, and you are in it.
 */
export interface MobileRootTile {
  /** Tree path of the library root — the grid item's identity. */
  key: string;
  name: string;
  rootId: string;
  kind: 'library';
  /** Filled folder icon when the library holds anything, outlined when empty. */
  holdsSomething: boolean;
}

/** The tiles for whatever catalog roots are in the forest, in tree order. */
export function mobileLibraryTiles(roots: readonly ProjectTreeNode[]): MobileRootTile[] {
  // Filtered HERE rather than by the caller: the caller already hands over a
  // split forest today, and a second place that decides what a library is is
  // how the grid and the tree start disagreeing.
  return roots
    .filter(root => root.rootKind === 'catalog')
    .map(root => ({
      key: root.path ?? root.rootId,
      name: root.name,
      rootId: root.rootId,
      kind: 'library' as const,
      holdsSomething: root.hasContent ?? root.children.length > 0,
    }));
}

/** The stand-in for the levels a collapsed breadcrumb hides. */
export interface CollapsedCrumbs<T> {
  ellipsis: true;
  /** The hidden levels, in trail order — the ellipsis menu's entries. */
  hidden: T[];
}

/**
 * Collapse the MIDDLE of a breadcrumb trail past `max` levels.
 *
 * Keeps the root (where you came from) and the last `max - 1` levels (where
 * you are and how you got here), and folds everything between them behind one
 * ellipsis. Dropping the tail instead would hide the current folder, and
 * dropping the head would hide the project — neither is the level a user
 * scrolls a trail to find.
 */
export function collapseCrumbs<T extends { name: string }>(
  crumbs: readonly T[],
  max = 3,
): (T | CollapsedCrumbs<T>)[] {
  const limit = Math.max(2, Math.floor(max));
  if (crumbs.length <= limit) return [...crumbs];
  const tail = crumbs.slice(crumbs.length - (limit - 1));
  const hidden = crumbs.slice(1, crumbs.length - (limit - 1));
  return [crumbs[0], { ellipsis: true, hidden }, ...tail];
}

/** Narrowing helper — a rendered trail asks this per entry. */
export function isCollapsedCrumbs<T>(
  entry: T | CollapsedCrumbs<T>,
): entry is CollapsedCrumbs<T> {
  return typeof entry === 'object' && entry !== null && 'ellipsis' in entry;
}
