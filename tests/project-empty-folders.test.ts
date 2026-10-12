// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { buildDashboardTree } from '../src/core/project/rv-project-tree-sources';
import { buildProjectTree, findTreeNode } from '../src/core/project/rv-project-tree';

describe('empty project folders', () => {
  it('lists empty directories and carries them into the dashboard tree', async () => {
    const root = new FakeDir('project');
    root.seedDir('Empty');
    root.seedDir('Nested').seedDir('Empty');
    root.seedDir('.trash').seedDir('Hidden');
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    const folders = await backend.listFolders();
    expect(folders).toEqual(['Empty', 'Nested', 'Nested/Empty']);
    const tree = buildDashboardTree({ project: {
      id: 'p', name: 'Project', writable: true, documents: [], folders,
    } });
    const node = findTreeNode(buildProjectTree(tree.roots), 'p/Nested/Empty');
    expect(node?.kind).toBe('folder');
    expect(node?.children).toEqual([]);
  });

  it('deletes an empty directory without touching its siblings', async () => {
    const root = new FakeDir('project');
    root.seedDir('Empty');
    root.seedDir('Keep').seedText('part.txt', 'keep');
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    await backend.activate();
    await backend.deleteEmptyFolder('Empty');
    expect(await backend.listFolders()).toEqual(['Keep']);
    expect(await backend.listAllFiles()).toEqual(['Keep/part.txt']);
  });

  it('refuses a folder whose only content is a hidden file', async () => {
    const root = new FakeDir('project');
    root.seedDir('LooksEmpty').seedText('.keep', 'keep');
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    await backend.activate();
    await expect(backend.deleteEmptyFolder('LooksEmpty')).rejects.toThrow('not empty');
    expect(await backend.listFolders()).toEqual(['LooksEmpty']);
  });

  it('refuses root, traversal, internal paths, files and read-only backends', async () => {
    const root = new FakeDir('project');
    root.seedText('file.txt', 'keep');
    root.seedDir('Empty');
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    await backend.activate();
    for (const path of ['', '/', '..', '../Empty', 'a/../Empty', '.trash', 'C:/Empty', 'a\\Empty']) {
      await expect(backend.deleteEmptyFolder(path)).rejects.toThrow();
    }
    await expect(backend.deleteEmptyFolder('file.txt')).rejects.toThrow();
    const readOnly = new FolderBackend(asDirHandle(root));
    await readOnly.activate();
    await expect(readOnly.deleteEmptyFolder('Empty')).rejects.toThrow();
    expect(await backend.listFolders()).toEqual(['Empty']);
  });
});
