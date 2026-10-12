// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.7 — unlinking a project drops its recents AND its folder
 * model-index snapshot, for the same id, and leaves the bundled snapshot of
 * that id alone.
 *
 * plan-513 §9.9 — and its documents' folder last modes, same rule.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { forgetProjectTraces } from '../src/core/hmi/projects/forget-project-traces';
import {
  MODEL_INDEX_DB_NAME, __closeModelIndexDb, loadModelIndex, putSnapshot,
} from '../src/core/project/rv-model-index-store';
import { MODEL_INDEX_SCHEMA_VERSION } from '../src/core/project/rv-model-index';
import {
  DOCUMENT_MODES_DB_NAME, __closeDocumentModesDb, loadDocumentModes, setDocumentMode,
} from '../src/core/project/rv-document-mode-store';
import {
  LS_KEY_RECENT_DOCUMENTS, __resetRecentsSnapshot, readRecents, recordRecentForOpen,
} from '../src/core/project/rv-project-recents-store';

function dropDb(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

afterEach(async () => {
  __closeModelIndexDb();
  __closeDocumentModesDb();
  await dropDb(MODEL_INDEX_DB_NAME);
  await dropDb(DOCUMENT_MODES_DB_NAME);
  localStorage.removeItem(LS_KEY_RECENT_DOCUMENTS);
  __resetRecentsSnapshot();
});

describe('forgetProjectTraces', () => {
  it('forgets the recents and the FOLDER snapshot of the same id', async () => {
    const forgetRecentsOfProject = vi.fn();
    const forgetModelIndexOfProject = vi.fn(async () => {});
    const forgetDocumentModesOfProject = vi.fn(async () => {});
    await forgetProjectTraces('prj_a',
      { forgetRecentsOfProject, forgetModelIndexOfProject, forgetDocumentModesOfProject });
    expect(forgetRecentsOfProject).toHaveBeenCalledWith('prj_a');
    expect(forgetModelIndexOfProject).toHaveBeenCalledWith('folder', 'prj_a');
    expect(forgetDocumentModesOfProject).toHaveBeenCalledWith('folder', 'prj_a');
  });

  it('against the real stores: recents, folder snapshot and folder last modes of one project go together', async () => {
    const base = { version: MODEL_INDEX_SCHEMA_VERSION, projectName: 'A', updatedAt: '', docs: [] as never[] } as const;
    await putSnapshot({ ...base, projectId: 'prj_a', backend: 'folder' });
    recordRecentForOpen({
      projectId: 'prj_a', backend: 'folder', documentId: 'd1', documentName: 'D1',
      documentPath: 'd1.glb', projectName: 'A', activeMode: 'hmi',
    });
    await setDocumentMode('folder', 'prj_a', 'd1', 'editor');
    await setDocumentMode('folder', 'prj_b', 'd1', 'planner');
    await setDocumentMode('bundled', 'prj_a', 'd1', 'hmi');

    await forgetProjectTraces('prj_a');

    expect(readRecents()).toEqual([]);
    expect((await loadModelIndex()).snapshots).toEqual([]);
    expect([...(await loadDocumentModes()).keys()].sort())
      .toEqual(['bundled:prj_a:d1', 'folder:prj_b:d1']);
  });

  it('against the real stores: the bundled snapshot of the same id stays', async () => {
    const base = { version: MODEL_INDEX_SCHEMA_VERSION, projectName: 'Demo', updatedAt: '', docs: [] as never[] } as const;
    await putSnapshot({ ...base, projectId: 'prj_sample', backend: 'bundled' });
    await putSnapshot({ ...base, projectId: 'prj_sample', backend: 'folder' });
    await forgetProjectTraces('prj_sample');
    const { snapshots } = await loadModelIndex();
    expect(snapshots.map(s => `${s.backend}:${s.projectId}`)).toEqual(['bundled:prj_sample']);
  });
});
