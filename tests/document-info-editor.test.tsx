// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.6 — DocumentInfoEditor: blur commit, flush, serialised writes,
 * failures that keep their draft, read-only rendering, safe preview — and the
 * project switch that must never write into the wrong project (F5, F14).
 *
 * Template for the mounting: `document-card.test.tsx`. The editor is rendered
 * on its own; the host only hands it a callback, which is exactly why the
 * rules live here and in the draft store, where a test can reach them.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { DocumentInfoEditor } from '../src/core/hmi/projects/DocumentInfoEditor';
import {
  documentInfoDraftKey,
  getDocumentInfoDraft,
  resetDocumentInfoDraftsForTests,
  settleDocumentInfoDrafts,
} from '../src/core/hmi/projects/document-info-draft-store';
import type { DocumentInfo } from '../src/core/project/rv-document-info';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { glbWithSceneExtras, seedBlob } from './helpers/glb-scene-extras';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ProjectChangedError, ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { sceneExtrasOfGlbBlob } from '../src/core/project/rv-project-documents';

const INFO: DocumentInfo = { v: 1, summary: 'Press', description: 'Body' };

function summaryInput(): HTMLInputElement {
  return screen.getByLabelText('Document summary') as HTMLInputElement;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(async () => {
  cleanup();
  await settleDocumentInfoDrafts();
  resetDocumentInfoDraftsForTests();
});

describe('plan-506 §9.6 — commit on blur', () => {
  it('typing never commits; a blur with a diff commits once; a blur without one does not', async () => {
    const onCommit = vi.fn(async () => {});
    render(<DocumentInfoEditor projectId="p" documentId="a" info={INFO} onCommit={onCommit} />);

    fireEvent.blur(summaryInput());
    fireEvent.change(summaryInput(), { target: { value: 'Pres' } });
    fireEvent.change(summaryInput(), { target: { value: 'Press 400 t' } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(summaryInput());
    await settleDocumentInfoDrafts();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ v: 1, summary: 'Press 400 t', description: 'Body' });

    // Typed back to what the file says: no diff, no write.
    fireEvent.change(summaryInput(), { target: { value: 'X' } });
    fireEvent.change(summaryInput(), { target: { value: 'Press' } });
    fireEvent.blur(summaryInput());
    await settleDocumentInfoDrafts();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('Enter in the summary commits', async () => {
    const onCommit = vi.fn(async () => {});
    render(<DocumentInfoEditor projectId="p" documentId="a" info={null} onCommit={onCommit} />);
    fireEvent.change(summaryInput(), { target: { value: 'New' } });
    fireEvent.keyDown(summaryInput(), { key: 'Enter' });
    await settleDocumentInfoDrafts();
    expect(onCommit).toHaveBeenCalledWith({ v: 1, summary: 'New' });
  });

  it('flushes an open draft on unmount — exactly once', async () => {
    const onCommit = vi.fn(async () => {});
    const view = render(<DocumentInfoEditor projectId="p" documentId="a" info={INFO} onCommit={onCommit} />);
    fireEvent.change(summaryInput(), { target: { value: 'Unsaved' } });
    view.unmount();
    await settleDocumentInfoDrafts();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ v: 1, summary: 'Unsaved', description: 'Body' });
  });

  it('a selection change A→B with identical (empty) info commits A\'s draft for A, never for B', async () => {
    const commitA = vi.fn(async () => {});
    const commitB = vi.fn(async () => {});
    const view = render(<DocumentInfoEditor projectId="p" documentId="A" info={null} onCommit={commitA} />);
    fireEvent.change(summaryInput(), { target: { value: 'Typed for A' } });
    view.rerender(<DocumentInfoEditor projectId="p" documentId="B" info={null} onCommit={commitB} />);
    await settleDocumentInfoDrafts();
    expect(commitA).toHaveBeenCalledWith({ v: 1, summary: 'Typed for A' });
    expect(commitB).not.toHaveBeenCalled();
    // B shows B's (empty) state, not A's leftover text.
    expect(summaryInput().value).toBe('');
  });

  it('a second blur while a write runs is queued behind it, not dropped', async () => {
    const order: string[] = [];
    const first = deferred();
    const onCommit = vi.fn(async (next: DocumentInfo | null) => {
      order.push(`start:${next?.summary}`);
      if (next?.summary === 'one') await first.promise;
      order.push(`end:${next?.summary}`);
    });
    render(<DocumentInfoEditor projectId="p" documentId="a" info={null} onCommit={onCommit} />);
    fireEvent.change(summaryInput(), { target: { value: 'one' } });
    fireEvent.blur(summaryInput());
    fireEvent.change(summaryInput(), { target: { value: 'two' } });
    fireEvent.blur(summaryInput());
    await Promise.resolve();
    expect(order).toEqual(['start:one']);
    first.resolve();
    await settleDocumentInfoDrafts();
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it('a failed write keeps the draft, shows the error and retries on request', async () => {
    let fail = true;
    const onCommit = vi.fn(async () => { if (fail) throw new Error('disk refused'); });
    render(<DocumentInfoEditor projectId="p" documentId="a" info={INFO} onCommit={onCommit} />);
    fireEvent.change(summaryInput(), { target: { value: 'Keep me' } });
    fireEvent.blur(summaryInput());
    await settleDocumentInfoDrafts();

    expect(await screen.findByTestId('document-info-error')).toHaveTextContent(/disk refused/);
    expect(summaryInput().value).toBe('Keep me');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settleDocumentInfoDrafts();
    expect(onCommit).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByTestId('document-info-error')).toBeNull());
  });
});

describe('plan-506 §9.6 — read-only and preview', () => {
  it('without onCommit renders text and no input', async () => {
    render(<DocumentInfoEditor projectId="p" documentId="a" info={INFO} />);
    expect(screen.getByTestId('document-info-readonly')).toHaveTextContent('Press');
    expect(screen.queryByLabelText('Document summary')).toBeNull();
    expect(await screen.findByText('Body')).toBeTruthy();
  });

  it('an empty block without onCommit renders nothing at all', () => {
    const { container } = render(<DocumentInfoEditor projectId="p" documentId="a" info={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('the preview renders no <img> (alt text only) and links with noopener noreferrer', async () => {
    const info: DocumentInfo = {
      v: 1, description: 'See ![plant photo](https://tracker.example/pixel.png) and [the manual](https://example.com/m)',
    };
    const { container } = render(<DocumentInfoEditor projectId="p" documentId="a" info={info} onCommit={async () => {}} />);
    const link = await screen.findByText('the manual');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('document-info-img-alt')).toHaveTextContent('plant photo');
  });
});

// ─── The project switch (R2-5) ──────────────────────────────────────────

describe('plan-506 §9.6 — a draft never lands in another project', () => {
  let store: ProjectStore;

  beforeEach(() => {
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    store = new ProjectStore();
  });

  afterEach(async () => {
    await store.closeProject();
    vi.restoreAllMocks();
  });

  async function projectFolder(id: string): Promise<FakeDir> {
    const root = new FakeDir(id);
    await seedBlob(root.seedDir('models'), 'doc.glb', glbWithSceneExtras({}));
    root.seedText('project.json', JSON.stringify({
      schemaVersion: 3, id, name: id,
      documents: [{ id: 'doc', path: 'models/doc.glb', name: 'doc' }],
    }));
    return root;
  }

  it('refuses the flush with ProjectChangedError, keeps the draft, and retries in P1 later', async () => {
    const p1 = await projectFolder('prj_1');
    const p2 = await projectFolder('prj_2');
    expect(await store.openProjectFolder(asDirHandle(p1))).toBe(true);

    const errors: unknown[] = [];
    const onCommitP1 = (next: DocumentInfo | null) =>
      store.setDocumentInfo('doc', next, { expectProjectId: 'prj_1' }).catch((e) => { errors.push(e); throw e; });
    const view = render(<DocumentInfoEditor projectId="prj_1" documentId="doc" info={null} onCommit={onCommitP1} />);
    fireEvent.change(summaryInput(), { target: { value: 'Typed in P1' } });

    // The user opens P2 — a document with the SAME id — before leaving the field.
    expect(await store.openProjectFolder(asDirHandle(p2))).toBe(true);
    const reads = vi.spyOn(FolderBackend.prototype, 'readDocument');
    const writes = vi.spyOn(FolderBackend.prototype, 'writeDocument');
    view.unmount();
    await settleDocumentInfoDrafts();

    expect(errors[0]).toBeInstanceOf(ProjectChangedError);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    const p2File = await (await (await p2.getDirectoryHandle('models')).getFileHandle('doc.glb')).getFile();
    expect((await sceneExtrasOfGlbBlob(p2File))?.documentInfo).toBeNull();
    const kept = getDocumentInfoDraft(documentInfoDraftKey('prj_1', 'doc'));
    expect(kept?.summary).toBe('Typed in P1');
    expect(kept?.error).toBeTruthy();
    reads.mockRestore();
    writes.mockRestore();

    // Back in P1 the draft is offered again, with Retry — and now it lands.
    expect(await store.openProjectFolder(asDirHandle(p1))).toBe(true);
    render(<DocumentInfoEditor projectId="prj_1" documentId="doc" info={null}
      onCommit={(next) => store.setDocumentInfo('doc', next, { expectProjectId: 'prj_1' })} />);
    expect(summaryInput().value).toBe('Typed in P1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    await settleDocumentInfoDrafts();
    const p1File = await (await (await p1.getDirectoryHandle('models')).getFileHandle('doc.glb')).getFile();
    expect((await sceneExtrasOfGlbBlob(p1File))?.documentInfo?.summary).toBe('Typed in P1');
    expect(getDocumentInfoDraft(documentInfoDraftKey('prj_1', 'doc'))).toBeUndefined();
  });
});
