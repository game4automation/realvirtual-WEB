// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.9 — `web_document_info_get` / `_set` are document-scoped (F9).
 *
 * Template: `mcp-knowledge-tools.test.ts`, but with a project store and a
 * folder backend instead of a node overlay — the point of risk 5.4 is that the
 * write reaches a document that is NOT open, through the same store path as the
 * dashboard editor, and answers with the block read back afterwards.
 */

import { executeDelegateValue } from './helpers/execute-value';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { queryValue } from './helpers/query-value';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWithSceneExtras, seedBlob } from './helpers/glb-scene-extras';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { documentBase, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { sceneExtrasOfGlbBlob } from '../src/core/project/rv-project-documents';
import { McpDocumentInfoTools } from '../src/plugins/mcp-bridge/rv-mcp-document-info-tools';
import type { RVViewer } from '../src/core/rv-viewer';

async function seedProject(): Promise<FakeDir> {
  const root = new FakeDir('mcp-info');
  const models = root.seedDir('models');
  await seedBlob(models, 'open.glb', glbWithSceneExtras({ DocumentInfo: { v: 1, summary: 'The open one' } }));
  await seedBlob(models, 'closed.glb', glbWithSceneExtras({
    DocumentInfo: { v: 1, summary: 'Old summary', description: 'Kept description' },
  }));
  root.seedText('project.json', JSON.stringify({
    schemaVersion: 3, id: 'prj_mcp', name: 'MCP',
    documents: [
      { id: 'doc-open', path: 'models/open.glb', name: 'open' },
      { id: 'doc-closed', path: 'models/closed.glb', name: 'closed' },
    ],
  }));
  return root;
}

async function fileInfo(root: FakeDir, name: string) {
  const file = await (await (await root.getDirectoryHandle('models')).getFileHandle(name)).getFile();
  return (await sceneExtrasOfGlbBlob(file))?.documentInfo ?? null;
}

describe('plan-506 §9.9 — MCP document info tools', () => {
  let root: FakeDir;
  // plan-641 Nachtrag: the set dispatches `document.infoSet` through the command registry,
  // which needs a viewer (it reads the active mode) — the read tools never touch it.
  const viewer = { modes: { activeMode: 'hmi' } } as unknown as RVViewer;
  const tools = new McpDocumentInfoTools(() => viewer);

  beforeEach(async () => {
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    root = await seedProject();
    expect(await getProjectStore().openProjectFolder(asDirHandle(root))).toBe(true);
    setOpenDocumentBase(documentBase('doc-open', 'open', 'models/open.glb'));
  });

  afterEach(async () => {
    await getProjectStore().closeProject();
    setOpenDocumentBase(null);
    vi.restoreAllMocks();
  });

  it('get without an argument answers for the open document', async () => {
    const out = JSON.parse(await queryValue(viewer, 'document.infoGet', { }));
    expect(out.document).toBe('doc-open');
    expect(out.info.summary).toBe('The open one');
    expect(out.source).toBe('manifest');
  });

  it('get by path and by id', async () => {
    const byPath = JSON.parse(await queryValue(viewer, 'document.infoGet', { document: 'models\\closed.glb' }));
    const byId = JSON.parse(await queryValue(viewer, 'document.infoGet', { document: 'doc-closed' }));
    expect(byPath.info).toEqual(byId.info);
    expect(byId.info.description).toBe('Kept description');
  });

  it('set writes a document that is NOT open, through the store, and reads it back', async () => {
    const spy = vi.spyOn(getProjectStore(), 'setDocumentInfo');
    const out = JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'models/closed.glb', summary: 'New summary' }));
    expect(out.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe('doc-closed');
    expect(spy.mock.calls[0]![2]).toEqual({ expectProjectId: 'prj_mcp' });
    // Field merge: only summary was passed, the description stays.
    expect(out.info.summary).toBe('New summary');
    expect(out.info.description).toBe('Kept description');
    expect(out.info.updatedAt).toBeTruthy();
    expect(out.persistedTo).toBe('glb');
    // …and the bytes say so.
    expect((await fileInfo(root, 'closed.glb'))?.summary).toBe('New summary');
    // The open document is untouched.
    expect((await fileInfo(root, 'open.glb'))?.summary).toBe('The open one');
  });

  it('an empty string removes a field; removing both removes the block', async () => {
    const one = JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'doc-closed', summary: undefined, description: '' }));
    expect(one.info).toEqual(expect.objectContaining({ summary: 'Old summary' }));
    expect(one.info.description).toBeUndefined();

    const both = JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'doc-closed', summary: '' }));
    expect(both.info).toBeNull();
    expect(await fileInfo(root, 'closed.glb')).toBeNull();
  });

  it('refuses a read-only (bundled) document without writing', async () => {
    const store = getProjectStore();
    const real = store.getSnapshot();
    vi.spyOn(store, 'getSnapshot').mockReturnValue({
      ...real,
      documents: real.documents.map(d => d.id === 'doc-closed' ? { ...d, tier: 'bundled' as const } : d),
    });
    const spy = vi.spyOn(store, 'setDocumentInfo');
    const out = JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'doc-closed', summary: 'x' }));
    expect(out.error).toMatch(/read-only/);
    expect(spy).not.toHaveBeenCalled();
    expect((await fileInfo(root, 'closed.glb'))?.summary).toBe('Old summary');
  });

  it('refuses an over-long summary and an unknown document', async () => {
    expect(JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'doc-closed', summary: 'x'.repeat(201) })).error).toMatch(/limit/);
    expect(JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'nope', summary: 'x' })).error).toMatch(/No document/);
    expect(JSON.parse(await executeDelegateValue(tools, 'document.infoSet', { document: 'doc-closed' })).error).toMatch(/nothing to write/);
  });
});
