// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.1 — the full view: every file listed, internals excluded, nothing twice
 * (plan-445 F1/F2).
 *
 * The project browser used to show four curated listings and call the rest of
 * the folder "not a file no reference can break on". That was true and it was
 * also the reason users could not find their own files. This pins the three
 * halves of the replacement: what the backend's one walk hides
 * ({@link isInternalProjectPath}), how the walk is split into the lists the
 * tree consumes ({@link classifyProjectFiles}), and that a plain file arrives
 * as an INERT row deduped against everything already listed.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyProjectFiles,
  isInternalProjectPath,
  listProjectFiles,
} from '../src/core/project/backends/project-backend';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import { buildProjectTree, findTreeNode, walkProjectTree } from '../src/core/project/rv-project-tree';

describe('§9.1 — the internals filter', () => {
  it('hides any path with a dot segment', () => {
    expect(isInternalProjectPath('.trash/old.glb')).toBe(true);
    expect(isInternalProjectPath('library/.thumbnails/a.png')).toBe(true);
    expect(isInternalProjectPath('.gitignore')).toBe(true);
  });

  it('hides the two index files, wherever they sit', () => {
    expect(isInternalProjectPath('project.json')).toBe(true);
    expect(isInternalProjectPath('docs-index.json')).toBe(true);
    expect(isInternalProjectPath('nested/project.json')).toBe(true);
  });

  it('hides the manifest write\'s crash-recovery copy', () => {
    // `project.json.bak` is written by the manifest writer purely so
    // `readManifest` can recover an unparseable primary — machinery, and one
    // more row the user can only be confused by.
    expect(isInternalProjectPath('project.json.bak')).toBe(true);
    expect(isInternalProjectPath('nested/project.json.bak')).toBe(true);
  });

  it('hides the thumbnail cache but keeps the other reserved folders', () => {
    expect(isInternalProjectPath('thumbnails/abc.png')).toBe(true);
    // `settings` / `connect` / `rag` hold files a human legitimately reads —
    // the tree groups them under its System node instead of hiding them.
    expect(isInternalProjectPath('settings/project-settings.json')).toBe(false);
    expect(isInternalProjectPath('connect/dev.connect.json')).toBe(false);
  });

  it('keeps ordinary content', () => {
    expect(isInternalProjectPath('models/Plant.glb')).toBe(false);
    expect(isInternalProjectPath('Readme.md')).toBe(false);
    expect(isInternalProjectPath('docs/Module_A/bom.pdf')).toBe(false);
  });
});

describe('§9.1 — one walk, three lists', () => {
  it('classifies by ENDING, not by folder', () => {
    const listing = classifyProjectFiles([
      'models/Plant.glb',
      'device.connect.json',
      'connect/dev.connect.json',
      'notes.knowledge.md',
      'docs/bom.pdf',
      'project.json',            // internal — never reaches a list
      '.trash/gone.glb',         // internal
    ]);
    expect(listing.configs).toEqual(['device.connect.json', 'connect/dev.connect.json']);
    expect(listing.knowledge).toEqual(['notes.knowledge.md']);
    expect(listing.plainFiles).toEqual(['models/Plant.glb', 'docs/bom.pdf']);
  });

  it('prefers listAllFiles — ONE traversal instead of one per ending', async () => {
    let allCalls = 0;
    let endingCalls = 0;
    const listing = await listProjectFiles({
      listAllFiles: async () => { allCalls++; return ['a.connect.json', 'b.txt']; },
      listConnectConfigs: async () => { endingCalls++; return []; },
      listKnowledgeFiles: async () => { endingCalls++; return []; },
    });
    expect(allCalls).toBe(1);
    expect(endingCalls).toBe(0);
    expect(listing.configs).toEqual(['a.connect.json']);
    expect(listing.plainFiles).toEqual(['b.txt']);
  });

  it('falls back to the per-ending walks, and then claims no plain files', async () => {
    const listing = await listProjectFiles({
      listConnectConfigs: async () => ['x.connect.json'],
      listKnowledgeFiles: async () => ['y.knowledge.md'],
    });
    expect(listing.configs).toEqual(['x.connect.json']);
    expect(listing.knowledge).toEqual(['y.knowledge.md']);
    // A backend that cannot enumerate must not claim the folder holds nothing
    // else — it has no way to know.
    expect(listing.plainFiles).toEqual([]);
  });

  it('a backend that throws yields empty lists, never a broken screen', async () => {
    const listing = await listProjectFiles({
      listAllFiles: async () => { throw new Error('grant revoked'); },
    });
    expect(listing).toEqual({ configs: [], knowledge: [], plainFiles: [] });
  });
});

describe('§9.1 — plain files in the tree', () => {
  const tree = () => buildDashboardTree({
    project: {
      id: 'proj',
      name: 'MyPlant',
      writable: true,
      documents: [{ id: 'd1', path: 'models/Plant.glb', name: 'Plant' }],
      attachments: ['docs/bom.pdf'],
      configs: ['dev.connect.json'],
      knowledge: ['notes.knowledge.md'],
      plainFiles: [
        // Every one of the four above, repeated — the dedupe has to swallow
        // all of them, not just the documents.
        'models/Plant.glb', 'docs/bom.pdf', 'dev.connect.json', 'notes.knowledge.md',
        'scripts/setup.py', 'Readme.txt',
      ],
    },
  });

  it('lists a plain file as an inert row', () => {
    const roots = buildProjectTree(tree().roots);
    const node = findTreeNode(roots, 'proj/scripts/setup.py');
    expect(node?.kind).toBe('file');
    expect(node?.inert).toBe(true);
    expect(node?.name).toBe('setup.py');
  });

  it('never lists a file twice, whichever of the four already had it', () => {
    const built = tree();
    const roots = buildProjectTree(built.roots);
    const paths = walkProjectTree(roots).map(n => n.relPath).filter(Boolean);
    for (const dup of ['models/Plant.glb', 'docs/bom.pdf', 'dev.connect.json', 'notes.knowledge.md']) {
      expect(paths.filter(p => p === dup)).toHaveLength(1);
    }
    // …and the reference kind survives the plain-file pass unchanged.
    expect(built.refs.get('proj/models/Plant.glb')?.kind).toBe('document');
    expect(built.refs.get('proj/dev.connect.json')?.kind).toBe('connectConfig');
    expect(built.refs.get('proj/notes.knowledge.md')?.kind).toBe('knowledgeFile');
    expect(built.refs.get('proj/docs/bom.pdf')?.kind).toBe('attachment');
  });

  it('points a plain-file row at nothing but its path', () => {
    const ref = tree().refs.get('proj/Readme.txt');
    expect(ref).toEqual({ kind: 'plainFile', path: 'Readme.txt' });
  });

  it('derives the folders a plain file needs, like any other row', () => {
    const roots = buildProjectTree(tree().roots);
    const folder = findTreeNode(roots, 'proj/scripts');
    expect(folder?.kind).toBe('folder');
    expect(folder?.children.map(c => c.name)).toEqual(['setup.py']);
  });
});
