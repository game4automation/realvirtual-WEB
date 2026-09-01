// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.3 — the "Rename…" verb is offered exactly where the commit accepts it
 * (plan-445 F4).
 *
 * The context menu used to decide for itself: four hand-written conditions
 * beside `canRenameInTree`'s own, and a `disabled` entry wherever they said no.
 * Both halves were wrong. Two rule sets drift, and a greyed-out verb is a
 * promise the row cannot keep — §3.6's standing preference is to show what CAN
 * be done, not to list what cannot.
 *
 * So the menu asks {@link isRenamableInTree}, which is `canRenameInTree`'s own
 * name-independent half. This file pins that they agree: for every row, the
 * verb is offered iff SOME name would be accepted.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProjectTree,
  canRenameInTree,
  isRenamableInTree,
  walkProjectTree,
  type ProjectTreeNode,
} from '../src/core/project/rv-project-tree';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';

const TREE = () => buildProjectTree(buildDashboardTree({
  project: {
    id: 'proj',
    name: 'MyPlant',
    writable: true,
    documents: [{ id: 'd1', path: 'models/Plant.glb', name: 'Plant' }],
    attachments: ['docs/bom.pdf'],
    configs: ['settings/locked.connect.json', 'dev.connect.json'],
    plainFiles: ['Readme.txt'],
    folders: ['parts'],
  },
  catalogs: [{
    providerId: 'p', sourceId: 's', label: 'Read-only library',
    writable: false, remote: false,
    entries: [{ assetId: 'a1', name: 'Roll', path: 'Roll.glb' }],
  }],
}).roots);

const at = (roots: ProjectTreeNode[], path: string): ProjectTreeNode =>
  walkProjectTree(roots).find(n => n.path === path)!;

describe('§9.3 — which rows offer the verb', () => {
  it('a writable folder and a writable document do', () => {
    const roots = TREE();
    expect(isRenamableInTree(roots, 'proj/parts')).toBe(true);
    expect(isRenamableInTree(roots, 'proj/models/Plant.glb')).toBe(true);
    expect(isRenamableInTree(roots, 'proj/docs/bom.pdf')).toBe(true);
    expect(isRenamableInTree(roots, 'proj/dev.connect.json')).toBe(true);
  });

  it('a root and the System node do not — the folder IS the project', () => {
    const roots = TREE();
    expect(at(roots, 'proj').kind).toBe('root');
    expect(isRenamableInTree(roots, 'proj')).toBe(false);
    expect(isRenamableInTree(roots, 'proj/__system__')).toBe(false);
  });

  it('a reserved system folder and its contents do not', () => {
    const roots = TREE();
    expect(isRenamableInTree(roots, 'proj/settings')).toBe(false);
    expect(isRenamableInTree(roots, 'proj/settings/locked.connect.json')).toBe(false);
  });

  it('a read-only catalog does not', () => {
    const roots = TREE();
    expect(isRenamableInTree(roots, 'p:s')).toBe(false);
    expect(isRenamableInTree(roots, 'p:s/Roll.glb')).toBe(false);
  });

  it('an inert full-view row does not', () => {
    const roots = TREE();
    expect(at(roots, 'proj/Readme.txt').inert).toBe(true);
    expect(isRenamableInTree(roots, 'proj/Readme.txt')).toBe(false);
  });

  it('a path that is not in the tree does not', () => {
    expect(isRenamableInTree(TREE(), 'proj/nope.glb')).toBe(false);
    expect(isRenamableInTree(TREE(), null)).toBe(false);
  });
});

describe('§9.3 — the verb and the commit cannot disagree', () => {
  it('every row: offered iff a fresh, valid name is accepted', () => {
    const roots = TREE();
    for (const node of walkProjectTree(roots)) {
      const path = node.path!;
      const verdict = canRenameInTree(roots, path, 'A brand new name');
      const structural = verdict.ok
        || !['not-found', 'read-only', 'system', 'inert'].includes(verdict.reason);
      expect({ path, offered: isRenamableInTree(roots, path) })
        .toEqual({ path, offered: structural });
    }
  });

  it('a name-dependent refusal never hides the verb', () => {
    const roots = TREE();
    // "there is already one called that" and "you typed nothing" are answers
    // about a NAME. Hiding the verb for them would hide it always.
    expect(canRenameInTree(roots, 'proj/parts', '')).toEqual({ ok: false, reason: 'invalid-name' });
    expect(canRenameInTree(roots, 'proj/parts', 'parts')).toEqual({ ok: false, reason: 'unchanged' });
    expect(isRenamableInTree(roots, 'proj/parts')).toBe(true);
  });
});
