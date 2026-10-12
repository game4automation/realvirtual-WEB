// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.13 — Ask AI reads the open document's STORE ROW (F11).
 *
 * After `setDocumentInfo` on the open document — from the dashboard or from
 * MCP — the row is current in memory at once, while the loaded model's
 * `userData` keeps the text it was loaded with until the next reload. Ask AI
 * must follow the row, or it would contradict the dashboard. A write to a
 * document that is NOT open changes nothing, and without a project (share
 * link) the loaded file is the only source there is.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWithSceneExtras, seedBlob } from './helpers/glb-scene-extras';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { documentBase, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import {
  collectSearchAiContext,
  DOCUMENT_INFO_BLOCK_HEADER,
  type SearchAiContextViewer,
} from '../src/core/hmi/search-ai-context';

const LOADED = { v: 1, summary: 'Text the model was LOADED with' };

function viewer(): SearchAiContextViewer {
  return {
    selectionManager: { getSnapshot: () => ({ primaryPath: null }) },
    registry: null,
    errorStore: { getActive: () => [] },
    signalStore: null,
    // Deliberately stale: this is what the file said at load time.
    currentModelRoot: { userData: { realvirtual: { DocumentInfo: LOADED } } },
  };
}

async function seedProject(): Promise<FakeDir> {
  const root = new FakeDir('ask-ai-project');
  const models = root.seedDir('models');
  await seedBlob(models, 'a.glb', glbWithSceneExtras({ DocumentInfo: LOADED }));
  await seedBlob(models, 'b.glb', glbWithSceneExtras({}));
  root.seedText('project.json', JSON.stringify({
    schemaVersion: 3, id: 'prj_ask', name: 'Ask',
    documents: [
      { id: 'doc-a', path: 'models/a.glb', name: 'a' },
      { id: 'doc-b', path: 'models/b.glb', name: 'b' },
    ],
  }));
  return root;
}

describe('plan-506 §9.13 — Ask AI follows the open document\'s row', () => {
  beforeEach(() => {
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    setOpenDocumentBase(null);
  });

  afterEach(async () => {
    await getProjectStore().closeProject();
    setOpenDocumentBase(null);
  });

  it('shows a write to the open document without a reload, ignores other documents', async () => {
    const store = getProjectStore();
    expect(await store.openProjectFolder(asDirHandle(await seedProject()))).toBe(true);
    setOpenDocumentBase(documentBase('doc-a', 'a', 'models/a.glb'));

    // Before any write: the row (scanned from the file) says what the file says.
    expect(collectSearchAiContext(viewer()).machineContext).toContain('| Text the model was LOADED with');

    await store.setDocumentInfo('doc-a', { v: 1, summary: 'Written after load' });
    const afterA = collectSearchAiContext(viewer()).machineContext!;
    expect(afterA).toContain('| Written after load');
    expect(afterA).not.toContain('LOADED');

    await store.setDocumentInfo('doc-b', { v: 1, summary: 'Belongs to B' });
    expect(collectSearchAiContext(viewer()).machineContext).toBe(afterA);
  });

  it('no open document identity → no block, even though userData has one', async () => {
    const store = getProjectStore();
    expect(await store.openProjectFolder(asDirHandle(await seedProject()))).toBe(true);
    expect(collectSearchAiContext(viewer()).machineContext).not.toContain(DOCUMENT_INFO_BLOCK_HEADER);
  });

  it('without a project (share link) falls back to the loaded file', () => {
    const text = collectSearchAiContext(viewer()).machineContext!;
    expect(text.startsWith(DOCUMENT_INFO_BLOCK_HEADER)).toBe(true);
    expect(text).toContain('| Text the model was LOADED with');
  });
});
