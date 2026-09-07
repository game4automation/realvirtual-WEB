// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-458 §9.1 — the two data rules of the compact projects layout.
 *
 * Pure logic, no DOM. The fixtures come from `buildProjectTree()` rather than
 * from `as never` literals, so the day `ProjectTreeNode` changes shape this
 * test stops compiling instead of quietly describing a tree that no longer
 * exists.
 */

import { describe, it, expect } from 'vitest';
import { buildProjectTree } from '../src/core/project/rv-project-tree';
import {
  collapseCrumbs, isCollapsedCrumbs, mobileLibraryTiles,
} from '../src/core/hmi/projects/mobile-folder-view';

/** The typed builder — the same input the host hands it. */
const roots = (inputs: Parameters<typeof buildProjectTree>[0]) => buildProjectTree(inputs);

describe('mobile-folder-view — library tiles', () => {
  it('maps every catalog root to one library tile with its rootId', () => {
    const tree = roots([
      { id: 'proj', name: 'AutomationML', kind: 'project', writable: true, files: [] },
      { id: 'lib-a', name: 'Lib A', kind: 'catalog', writable: false, files: [{ path: 'x.glb' }] },
    ]);
    expect(mobileLibraryTiles(tree.filter(r => r.rootKind === 'catalog'))).toEqual([
      { key: 'lib-a', name: 'Lib A', rootId: 'lib-a', kind: 'library', holdsSomething: true },
    ]);
  });

  it('returns no tiles for a project without libraries, and ignores non-catalog roots', () => {
    const tree = roots([{ id: 'proj', name: 'P', kind: 'project', writable: true, files: [] }]);
    expect(mobileLibraryTiles(tree)).toEqual([]);
  });

  it('filters the forest itself — a caller may hand over the whole tree', () => {
    const tree = roots([
      { id: 'proj', name: 'P', kind: 'project', writable: true, files: [{ path: 'a.glb' }] },
      { id: 'lib-a', name: 'Lib A', kind: 'catalog', writable: false, files: [{ path: 'x.glb' }] },
      { id: 'lib-b', name: 'Lib B', kind: 'catalog', writable: false, files: [] },
    ]);
    expect(mobileLibraryTiles(tree).map(t => t.rootId)).toEqual(['lib-a', 'lib-b']);
  });

  it('marks an empty library as holding nothing — the outlined folder icon', () => {
    const tree = roots([
      { id: 'lib-b', name: 'Lib B', kind: 'catalog', writable: false, files: [] },
    ]);
    expect(mobileLibraryTiles(tree)[0].holdsSomething).toBe(false);
  });
});

describe('mobile-folder-view — breadcrumb collapse', () => {
  const c = (n: string) => ({ name: n, path: n });

  it('keeps a trail of three or fewer untouched', () => {
    expect(collapseCrumbs([c('P'), c('a'), c('b')])).toHaveLength(3);
    expect(collapseCrumbs([c('P')])).toHaveLength(1);
    expect(collapseCrumbs([])).toEqual([]);
  });

  it('collapses the middle beyond that, keeping the root and the last two', () => {
    const out = collapseCrumbs([c('P'), c('a'), c('b'), c('c'), c('d')]);
    expect(out.map(x => (isCollapsedCrumbs(x) ? '…' : x.name))).toEqual(['P', '…', 'c', 'd']);
    const folded = out[1];
    expect(isCollapsedCrumbs(folded) && folded.hidden.map(h => h.name)).toEqual(['a', 'b']);
  });

  it('folds exactly one level when the trail is one past the limit', () => {
    const out = collapseCrumbs([c('P'), c('a'), c('b'), c('c')]);
    expect(out.map(x => (isCollapsedCrumbs(x) ? '…' : x.name))).toEqual(['P', '…', 'b', 'c']);
  });

  it('honours a wider limit and never folds below two visible levels', () => {
    expect(collapseCrumbs([c('P'), c('a'), c('b'), c('c')], 4)).toHaveLength(4);
    const out = collapseCrumbs([c('P'), c('a'), c('b')], 1);
    // A limit under two would leave no room for both ends of the trail.
    expect(out.map(x => (isCollapsedCrumbs(x) ? '…' : x.name))).toEqual(['P', '…', 'b']);
  });
});
