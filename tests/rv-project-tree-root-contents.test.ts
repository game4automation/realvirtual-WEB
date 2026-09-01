// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.2 — a moved document stays a document, and the project ROOT shows it
 * (plan-445 F3, LOP-119).
 *
 * ## The bug this file was written against
 *
 * `canMoveInTree` built its destination out of `node.name`. That is the
 * DISPLAY name: a manifest document called "Bar" living at `models/Bar.glb`
 * shows as `Bar`, so dropping it on the project root produced `to: 'Bar'` —
 * the extension gone. The bytes were then written to a file no
 * extension-filtered scan matches (`_walkAssets`), the manifest row pointed at
 * it, and the row vanished from the tree AND the cards. The user's report was
 * "elements on the top project level are invisible after a move"; the cause was
 * one property read, and it applied to every destination, the root being merely
 * the one people drop onto most.
 *
 * The first test is that repro. The rest pin the surrounding promises: the root
 * really is a legal destination, the cards really do render its contents, and
 * the docs-index half of §2.6.5 still holds afterwards.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProjectTree,
  canMoveInTree,
  fileNameOf,
  findTreeNode,
  folderContents,
  nearestFolderPath,
  planTreeMove,
} from '../src/core/project/rv-project-tree';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import { applyTreeMove, type TreeMoveIO } from '../src/core/project/rv-project-tree-move';
import type { RvProject } from '../src/core/project/rv-project-types';

/** The dashboard's own chain: listings → roots. */
function rootsOf(documents: Array<{ id?: string; path: string; name?: string }>, extra: {
  attachments?: string[]; plainFiles?: string[];
} = {}) {
  return buildProjectTree(buildDashboardTree({
    project: {
      id: 'proj',
      name: 'MyPlant',
      writable: true,
      documents,
      ...(extra.attachments ? { attachments: extra.attachments } : {}),
      ...(extra.plainFiles ? { plainFiles: extra.plainFiles } : {}),
    },
  }).roots);
}

/**
 * The host's card source, spelled exactly as `ProjectsDashboardHost` spells it:
 * the folder of the selection, falling back to the first root.
 */
function cardPathsFor(
  roots: ReturnType<typeof rootsOf>,
  selectedTreePath: string | null,
): string[] {
  const folder = nearestFolderPath(roots, selectedTreePath) ?? roots[0]?.path ?? null;
  return folderContents(roots, folder).map(n => n.relPath);
}

describe('§9.2 — a move keeps the file name', () => {
  it('moves models/Bar.glb to the root as Bar.glb, not as Bar (LOP-119)', () => {
    const roots = rootsOf([{ id: 'd2', path: 'models/Bar.glb', name: 'Bar' }]);
    const verdict = canMoveInTree(roots, 'proj/models/Bar.glb', 'proj');
    expect(verdict).toEqual({ ok: true, from: 'models/Bar.glb', to: 'Bar.glb' });
  });

  it('is not a root special case — the same holds for any folder', () => {
    const roots = rootsOf([
      { id: 'd2', path: 'models/Bar.glb', name: 'Bar' },
      { id: 'd3', path: 'parts/Keep.glb' },
    ]);
    const verdict = canMoveInTree(roots, 'proj/models/Bar.glb', 'proj/parts');
    expect(verdict).toEqual({ ok: true, from: 'models/Bar.glb', to: 'parts/Bar.glb' });
  });

  it('keeps a COMPOUND classifier ending, which a display name drops entirely', () => {
    const roots = buildProjectTree(buildDashboardTree({
      project: {
        id: 'proj', name: 'P', writable: true, documents: [],
        // NOT in `connect/` — that is a reserved system folder and nothing in
        // it may be restructured at all, which would hide what this asserts.
        configs: ['edge/dev.connect.json'],
        folders: ['line1'],
      },
    }).roots);
    // The row reads "dev"; the file is `dev.connect.json` and must stay one, or
    // it drops out of every config listing (plan-718's by-ending rule).
    expect(findTreeNode(roots, 'proj/edge/dev.connect.json')?.name).toBe('dev');
    const verdict = canMoveInTree(roots, 'proj/edge/dev.connect.json', 'proj/line1');
    expect(verdict).toEqual({
      ok: true, from: 'edge/dev.connect.json', to: 'line1/dev.connect.json',
    });
  });

  it('fileNameOf reads the path for files and the name for folders', () => {
    const roots = rootsOf([{ id: 'd2', path: 'models/Bar.glb', name: 'Bar' }]);
    expect(fileNameOf(findTreeNode(roots, 'proj/models/Bar.glb')!)).toBe('Bar.glb');
    expect(fileNameOf(findTreeNode(roots, 'proj/models')!)).toBe('models');
  });
});

describe('§9.2 — the root shows what was moved onto it', () => {
  it('the document is a card of the project root afterwards', async () => {
    const before = rootsOf([{ id: 'd2', path: 'models/Bar.glb', name: 'Bar' }]);
    const verdict = canMoveInTree(before, 'proj/models/Bar.glb', 'proj');
    expect(verdict.ok).toBe(true);

    const bytes = new Map<string, Blob>([['models/Bar.glb', new Blob(['glb'])]]);
    let manifest: RvProject = {
      schemaVersion: 2, id: 'proj', name: 'MyPlant',
      documents: [{ id: 'd2', path: 'models/Bar.glb', name: 'Bar', section: 'models' }],
    } as unknown as RvProject;
    const io: TreeMoveIO = {
      readBytes: async p => bytes.get(p) ?? null,
      writeBytes: async (p, b) => { bytes.set(p, b); },
      deleteBytes: async p => { bytes.delete(p); },
      readManifest: async () => manifest,
      writeManifest: async next => { manifest = next; },
    };
    await applyTreeMove(io, planTreeMove(before, 'proj/models/Bar.glb', verdict));

    // The bytes AND the row landed on a path an asset scan still recognises.
    expect([...bytes.keys()]).toEqual(['Bar.glb']);
    expect(manifest.documents?.[0].path).toBe('Bar.glb');

    // …and the dashboard, rebuilt from the new manifest, puts it on a card of
    // the root — whether the selection is the document or the root row.
    const after = rootsOf([{ id: 'd2', path: 'Bar.glb', name: 'Bar' }]);
    expect(cardPathsFor(after, 'proj/Bar.glb')).toContain('Bar.glb');
    expect(cardPathsFor(after, 'proj')).toContain('Bar.glb');
    expect(cardPathsFor(after, null)).toContain('Bar.glb');
  });

  it('root contents are the direct children only — folders excluded', () => {
    const roots = rootsOf([
      { id: 'a', path: 'Top.glb', name: 'Top' },
      { id: 'b', path: 'models/Deep.glb', name: 'Deep' },
    ], { plainFiles: ['Readme.md'] });
    expect(cardPathsFor(roots, 'proj').sort()).toEqual(['Readme.md', 'Top.glb']);
  });

  it('the ROOT is a legal move destination and its own folder', () => {
    const roots = rootsOf([{ id: 'a', path: 'models/Top.glb', name: 'Top' }]);
    expect(nearestFolderPath(roots, 'proj')).toBe('proj');
    expect(canMoveInTree(roots, 'proj/models/Top.glb', 'proj').ok).toBe(true);
    // …and moving it back to where it already is changes nothing.
    const rootLevel = rootsOf([{ id: 'a', path: 'Top.glb', name: 'Top' }]);
    expect(canMoveInTree(rootLevel, 'proj/Top.glb', 'proj'))
      .toEqual({ ok: false, reason: 'unchanged' });
  });
});

describe('§9.2 — the docs-index stays honest (F12/F13 regression)', () => {
  it('an ATTACHMENT moved to the root repoints the index rather than the manifest', async () => {
    const roots = rootsOf([], { attachments: ['docs/bom.pdf'] });
    const verdict = canMoveInTree(roots, 'proj/docs/bom.pdf', 'proj');
    expect(verdict).toEqual({ ok: true, from: 'docs/bom.pdf', to: 'bom.pdf' });

    const bytes = new Map<string, Blob>([['docs/bom.pdf', new Blob(['pdf'])]]);
    let index: unknown = { '4112630': [{ title: 'BOM', path: 'docs/bom.pdf' }] };
    const io: TreeMoveIO = {
      readBytes: async p => bytes.get(p) ?? null,
      writeBytes: async (p, b) => { bytes.set(p, b); },
      deleteBytes: async p => { bytes.delete(p); },
      readManifest: async () => ({
        schemaVersion: 2, id: 'proj', name: 'P', documents: [],
      } as unknown as RvProject),
      writeManifest: async () => { throw new Error('an attachment must not touch the manifest'); },
      readDocsIndex: async () => index,
      writeDocsIndex: async next => { index = next; },
    };
    const outcome = await applyTreeMove(io, planTreeMove(roots, 'proj/docs/bom.pdf', verdict));
    expect(outcome.docsIndexRows).toBe(1);
    expect((index as Record<string, Array<{ path: string }>>)['4112630'][0].path).toBe('bom.pdf');
  });

  it('an inert plain file is refused before any of that can happen', () => {
    const roots = rootsOf([], { plainFiles: ['docs/scratch.txt'] });
    expect(canMoveInTree(roots, 'proj/docs/scratch.txt', 'proj'))
      .toEqual({ ok: false, reason: 'inert' });
  });
});
