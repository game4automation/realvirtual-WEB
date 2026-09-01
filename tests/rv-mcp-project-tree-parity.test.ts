// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.7 — `web_project_tree` and the dashboard show the SAME project
 * (plan-445 §2.4).
 *
 * `loadProjectTree()` used to build its input by hand: manifest documents, the
 * docs-index attachments, the declared folders — and neither the CONNECT
 * configs nor the knowledge files, which the dashboard had been passing for two
 * plans. An MCP client and the screen beside it therefore disagreed about what
 * the project contains, and the full view's `plainFiles` would have widened the
 * gap from two lists to three.
 *
 * The repair is that both sides call {@link listProjectFiles} on the same
 * backend. This file is the guard: build both inputs from ONE fake project and
 * compare the resulting path sets.
 */

import { describe, it, expect } from 'vitest';
import { loadProjectTree } from '../src/plugins/mcp-bridge/rv-mcp-project-tree';
import { listProjectFiles } from '../src/core/project/backends/project-backend';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import { buildProjectTree, walkProjectTree } from '../src/core/project/rv-project-tree';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { readProjectFolders } from '../src/core/project/rv-project-types';
import type { ProjectStore } from '../src/core/project/project-store';
import type { RvProject } from '../src/core/project/rv-project-types';

const PROJECT = {
  schemaVersion: 2,
  id: 'proj',
  name: 'MyPlant',
  documents: [
    { id: 'd1', path: 'models/Plant.glb', name: 'Plant', section: 'models' },
    { id: 'd2', path: 'library/Roll.glb', name: 'Roll', section: 'library' },
  ],
  folders: ['parts'],
} as unknown as RvProject;

const WALK = [
  'models/Plant.glb',
  'library/Roll.glb',
  'connect/dev.connect.json',
  'notes.knowledge.md',
  'scripts/setup.py',
  'Readme.txt',
];

const DOCS_INDEX = { '4112630': [{ title: 'BOM', path: 'docs/bom.pdf' }] };

const backend = {
  writable: true,
  listAllFiles: async () => WALK,
  readBlobBytes: async (relPath: string) =>
    (relPath === 'docs-index.json'
      ? new TextEncoder().encode(JSON.stringify(DOCS_INDEX)).buffer as ArrayBuffer
      : null),
};

const store = {
  getProject: () => PROJECT,
  getBackend: () => backend,
} as unknown as ProjectStore;

/** Every rel path the built tree carries, sorted — folders included. */
function pathsOf(roots: ReturnType<typeof buildProjectTree>): string[] {
  return walkProjectTree(roots).map(n => n.relPath).filter(Boolean).sort();
}

describe('§9.7 — MCP / dashboard parity', () => {
  it('both trees carry exactly the same paths', async () => {
    const loaded = await loadProjectTree(store);
    expect('roots' in loaded).toBe(true);
    if (!('roots' in loaded)) return;

    // The dashboard's own input, spelled the way `ProjectsDashboardHost` spells it.
    const { configs, knowledge, plainFiles } = await listProjectFiles(backend);
    const hostRoots = buildProjectTree(buildDashboardTree({
      project: {
        id: PROJECT.id,
        name: PROJECT.name,
        writable: true,
        documents: documentsOf(PROJECT),
        attachments: ['docs/bom.pdf'],
        configs,
        knowledge,
        plainFiles,
        folders: readProjectFolders(PROJECT),
      },
    }).roots);

    expect(pathsOf(loaded.roots)).toEqual(pathsOf(hostRoots));
  });

  it('the MCP tree really does carry the three lists it used to drop', async () => {
    const loaded = await loadProjectTree(store);
    if (!('roots' in loaded)) throw new Error(loaded.error);
    const paths = pathsOf(loaded.roots);
    expect(paths).toContain('connect/dev.connect.json');   // configs
    expect(paths).toContain('notes.knowledge.md');         // knowledge
    expect(paths).toContain('scripts/setup.py');           // plainFiles
    expect(paths).toContain('docs/bom.pdf');               // docs-index attachments
    expect(paths).toContain('parts');                      // declared empty folder
  });

  it('the inert flag travels too, so an MCP move is refused like a UI one', async () => {
    const loaded = await loadProjectTree(store);
    if (!('roots' in loaded)) throw new Error(loaded.error);
    const plain = walkProjectTree(loaded.roots).find(n => n.relPath === 'Readme.txt');
    expect(plain?.inert).toBe(true);
    const doc = walkProjectTree(loaded.roots).find(n => n.relPath === 'models/Plant.glb');
    expect(doc?.inert).toBeUndefined();
  });

  it('says so, rather than throwing, when nothing is open', async () => {
    const empty = { getProject: () => null, getBackend: () => null } as unknown as ProjectStore;
    expect(await loadProjectTree(empty)).toEqual({
      error: 'No project is open — open one with web_project_open.',
    });
  });
});
