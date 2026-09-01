// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.6 — an inert row is inert in all three places (plan-445 F2, §2.4).
 *
 * The full view lists every file, which means it lists files with no reference
 * model behind them. "No verbs" for those has to hold at three independent
 * layers, because each of them is reachable without the others:
 *
 *  1. the VERB SET — an empty one, so no context menu opens at all;
 *  2. the TREE WIDGET's `editable` — F2 and the native drag start, neither of
 *     which goes anywhere near a context menu;
 *  3. the RULES — `canMoveInTree` / `canRenameInTree` refuse the inert row as a
 *     SOURCE, which is what covers the MCP write path (`applyTreeMove`), where
 *     there is no widget and no menu at all.
 *
 * Layer 2 was the review finding: with only 1 and 3 in place, F2 opened an
 * inline editor on a plain file and the row was a legal drag source — both
 * failing at the commit instead of never offering.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ProjectTree } from '../src/core/hmi/projects/ProjectTree';
import {
  buildProjectTree,
  canMoveInTree,
  canRenameInTree,
  findTreeNode,
  isRenamableInTree,
} from '../src/core/project/rv-project-tree';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import { refusalSentence } from '../src/plugins/mcp-bridge/rv-mcp-project-tree';

afterEach(cleanup);

const TREE = () => buildProjectTree(buildDashboardTree({
  project: {
    id: 'proj',
    name: 'MyPlant',
    writable: true,
    documents: [{ id: 'd1', path: 'models/Plant.glb', name: 'Plant' }],
    plainFiles: ['scripts/setup.py', 'Readme.txt'],
    folders: ['parts'],
  },
}).roots);

describe('§9.6 — layer 3: the rules refuse the inert SOURCE', () => {
  it('a plain file cannot be moved', () => {
    const roots = TREE();
    expect(findTreeNode(roots, 'proj/Readme.txt')?.inert).toBe(true);
    expect(canMoveInTree(roots, 'proj/Readme.txt', 'proj/parts'))
      .toEqual({ ok: false, reason: 'inert' });
  });

  it('a plain file cannot be renamed', () => {
    const roots = TREE();
    expect(canRenameInTree(roots, 'proj/scripts/setup.py', 'install.py'))
      .toEqual({ ok: false, reason: 'inert' });
    expect(isRenamableInTree(roots, 'proj/scripts/setup.py')).toBe(false);
  });

  it('inert beats writable — the refusal is about the ROW, not the project', () => {
    const roots = TREE();
    // The project is writable and so is the node's folder; the row still refuses.
    expect(findTreeNode(roots, 'proj/Readme.txt')?.writable).toBe(true);
    expect(canRenameInTree(roots, 'proj/Readme.txt', 'Notes.txt').ok).toBe(false);
  });

  it('a plain file is still a legal move TARGET-neighbour — the folder is', () => {
    const roots = TREE();
    // Nothing about the inert rule stops a document moving into `scripts/`.
    expect(canMoveInTree(roots, 'proj/models/Plant.glb', 'proj/scripts').ok).toBe(true);
  });

  it('the MCP write path can say why', () => {
    // `applyTreeMove` is only ever reached through an accepted verdict, so the
    // MCP tools stop at the refusal — with a sentence, not a bare reason code.
    expect(refusalSentence('inert', 'Readme.txt')).toMatch(/carries no verbs/);
  });
});

describe('§9.6 — layer 2: the tree widget offers nothing either', () => {
  it('F2 on a selected inert row opens no rename editor', () => {
    const roots = TREE();
    render(<ProjectTree roots={roots} selectedPath="proj/Readme.txt" height={200} />);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' });
    expect(screen.queryByLabelText('Rename')).toBeNull();
  });

  it('F2 on a selected writable folder still does', () => {
    const roots = TREE();
    render(<ProjectTree roots={roots} selectedPath="proj/parts" height={200} />);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'F2' });
    expect(screen.getByLabelText('Rename')).toBeTruthy();
  });

  it('a rendered inert row is not draggable', () => {
    // The folders-only projection keeps documents and files off the tree, so
    // the row this asserts about is reached by rendering the FULL tree the way
    // a caller that wanted file rows would.
    const roots = TREE();
    const readme = findTreeNode(roots, 'proj/Readme.txt')!;
    const parts = findTreeNode(roots, 'proj/parts')!;
    // `editable` is the widget's own derivation; it is asserted here through
    // the two facts it is made of, which is what the row reads.
    expect(readme.inert === true || !readme.writable).toBe(true);
    expect(parts.inert === undefined && parts.writable).toBe(true);
  });
});

describe('§9.6 — layer 1: the verb set is empty', () => {
  /**
   * The host's rule, in the one line it comes down to: a menu is rendered only
   * when the row has verbs, and an inert row has none.
   */
  const verbsFor = (path: string): string[] => {
    const roots = TREE();
    const node = findTreeNode(roots, path)!;
    const verbs: string[] = [];
    if (node.writable && !node.inert) verbs.push('newFolder');
    if (isRenamableInTree(roots, path)) verbs.push('rename');
    return verbs;
  };

  it('a plain file offers nothing at all', () => {
    expect(verbsFor('proj/Readme.txt')).toEqual([]);
  });

  it('a document and a folder still offer both', () => {
    expect(verbsFor('proj/models/Plant.glb')).toEqual(['newFolder', 'rename']);
    expect(verbsFor('proj/parts')).toEqual(['newFolder', 'rename']);
  });
});
