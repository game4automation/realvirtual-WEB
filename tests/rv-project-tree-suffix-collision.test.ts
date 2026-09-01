// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.8 — `device.connect.json` next to `device.json` (plan-445 §5.2).
 *
 * A CONNECT config is classified by its compound ending and shows WITHOUT it:
 * `device.connect.json` reads as `device`. Fine until the full view starts
 * listing the whole folder, at which point something else in it can read as
 * `device` too — and then there are two identical rows, and the display-name
 * collision check inside `canRenameInTree` starts refusing renames the
 * filesystem would accept.
 *
 * **A correction to the plan's premise.** §5.2 named `device.json` as the
 * colliding neighbour, on the reading that only `.connect` is stripped. It is
 * not: `stripConnectConfigSuffix` removes the WHOLE `.connect.json`
 * (`rv-project-refs.ts:100`), so `device.connect.json` shows as `device` and a
 * plain `device.json` shows as `device.json` — different rows, no collision.
 * The real collisions are an extension-less `device`, and the knowledge twin
 * `device.knowledge.md`, which strips to `device` as well. Both are covered
 * below, and `device.json` is pinned as the NON-collision it turns out to be.
 *
 * **Decision (the plan left it open):** the STRIPPED row gives its short name
 * back. The file that owns its name outright keeps it, so the long name reads
 * as "this one needed disambiguating" rather than as two arbitrary long names.
 * Only the display changes — the path, the ref and every write stay exactly
 * what they were.
 */

import { describe, it, expect } from 'vitest';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import {
  buildProjectTree,
  canMoveInTree,
  canRenameInTree,
  findTreeNode,
} from '../src/core/project/rv-project-tree';

const collidingTree = () => buildDashboardTree({
  project: {
    id: 'proj',
    name: 'P',
    writable: true,
    documents: [],
    configs: ['edge/device.connect.json'],
    // Extension-less, so it shows as `device` — exactly what the config's
    // stripped name shows as.
    plainFiles: ['edge/device', 'edge/device.json'],
    folders: ['other'],
  },
});

describe('§9.8 — the two rows are told apart', () => {
  it('the stripped row falls back to its full file name on a collision', () => {
    const roots = buildProjectTree(collidingTree().roots);
    expect(findTreeNode(roots, 'proj/edge/device.connect.json')?.name)
      .toBe('device.connect.json');
    // The row that owns its name outright keeps it — only the stripped one
    // gives its short form up.
    expect(findTreeNode(roots, 'proj/edge/device')?.name).toBe('device');
  });

  it('`device.json` is NOT a collision — the whole compound ending is stripped', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true, documents: [],
        configs: ['edge/device.connect.json'],
        plainFiles: ['edge/device.json'],
      },
    }).roots);
    expect(findTreeNode(roots, 'proj/edge/device.connect.json')?.name).toBe('device');
    expect(findTreeNode(roots, 'proj/edge/device.json')?.name).toBe('device.json');
  });

  it('two STRIPPED rows colliding with each other both give the short name up', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true, documents: [],
        configs: ['device.connect.json'],
        knowledge: ['device.knowledge.md'],
      },
    }).roots);
    expect(findTreeNode(roots, 'proj/device.connect.json')?.name).toBe('device.connect.json');
    expect(findTreeNode(roots, 'proj/device.knowledge.md')?.name).toBe('device.knowledge.md');
  });

  it('with no collision the short name is kept — the rule is minimal', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true, documents: [],
        configs: ['edge/device.connect.json'],
      },
    }).roots);
    expect(findTreeNode(roots, 'proj/edge/device.connect.json')?.name).toBe('device');
  });

  it('the collision is per FOLDER — a namesake elsewhere changes nothing', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true, documents: [],
        configs: ['edge/device.connect.json'],
        plainFiles: ['other/device'],
      },
    }).roots);
    expect(findTreeNode(roots, 'proj/edge/device.connect.json')?.name).toBe('device');
  });

  it('knowledge files follow the same rule', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true, documents: [],
        knowledge: ['notes.knowledge.md'],
        plainFiles: ['notes'],
      },
    }).roots);
    expect(findTreeNode(roots, 'proj/notes.knowledge.md')?.name).toBe('notes.knowledge.md');
    expect(findTreeNode(roots, 'proj/notes')?.name).toBe('notes');
  });

  it('the path, the ref and the classification are untouched by the display rule', () => {
    const built = collidingTree();
    expect(built.refs.get('proj/edge/device.connect.json'))
      .toEqual({ kind: 'connectConfig', path: 'edge/device.connect.json' });
    expect(built.refs.get('proj/edge/device'))
      .toEqual({ kind: 'plainFile', path: 'edge/device' });
  });
});

describe('§9.8 — no false name-taken', () => {
  it('the config renames freely although a namesake sits beside it', () => {
    const roots = buildProjectTree(collidingTree().roots);
    // The compound ending is restored, and the destination path is genuinely
    // free — so this must be accepted, not refused as a collision.
    expect(canRenameInTree(roots, 'proj/edge/device.connect.json', 'gateway'))
      .toEqual({ ok: true, from: 'edge/device.connect.json', to: 'edge/gateway.connect.json' });
  });

  it('a REAL collision is still refused — on the path, not on the display name', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true,
        documents: [
          { id: 'a', path: 'parts/Roll.glb', name: 'Roll' },
          { id: 'b', path: 'parts/Bar.glb', name: 'Bar' },
        ],
      },
    }).roots);
    // "Bar" is the display name of `Bar.glb`; renaming Roll to "Bar" lands on
    // `parts/Bar.glb`, which exists.
    expect(canRenameInTree(roots, 'parts/Roll.glb', 'Bar').ok).toBe(false);
    expect(canRenameInTree(roots, 'proj/parts/Roll.glb', 'Bar'))
      .toEqual({ ok: false, reason: 'name-taken' });
  });

  it('a move onto an occupied PATH is refused even when the names differ', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true,
        documents: [
          // Two rows, two different display names, one destination file name.
          { id: 'a', path: 'parts/Roll.glb', name: 'Roll' },
          { id: 'b', path: 'Roll.glb', name: 'The other roll' },
        ],
      },
    }).roots);
    expect(canMoveInTree(roots, 'proj/parts/Roll.glb', 'proj'))
      .toEqual({ ok: false, reason: 'name-taken' });
  });
});
