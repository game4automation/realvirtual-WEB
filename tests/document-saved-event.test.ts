// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-719 F8 / Defect (b) — every successful save announces itself.
 *
 * The planner's decoded-model cache used to be dropped by `save-flow.ts`
 * reaching INTO the planner and matching the saved path against its catalog —
 * a structurally typed direct coupling that only fired for `library/**`, so a
 * document under `models/` was placed from stale bytes after being saved.
 *
 * The fix is an event, and this pins the event rather than the subscriber:
 * `document-saved` fires after EVERY successful document write, whatever the
 * path, carrying the identity and the project-relative path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  projectId: 'prj_one' as string | null,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => store,
}));

vi.mock('../src/core/editor/rv-asset-glb-export', async (original) => {
  const actual = await original<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async (_root: unknown, name?: string) =>
      new TextEncoder().encode(`GLB:${name}`).buffer,
  };
});

vi.mock('../src/core/thumbnails/thumbnail-renderer', () => ({
  ThumbnailRenderer: class {
    render(): string | null { return null; }
    dispose(): void {}
  },
}));

function makeBackend(id: string) {
  return {
    kind: 'browser' as const,
    id,
    writable: true,
    isActive: true,
    async writeBlob(relPath: string, blob: Blob) {
      h.files.set(relPath, await blob.text());
    },
    async readBlobUrl(relPath: string) {
      const value = h.files.get(relPath);
      if (value === undefined) return null;
      const url = URL.createObjectURL(new Blob([value]));
      return { url, release: () => URL.revokeObjectURL(url) };
    },
    async listDocuments() {
      return [...h.files.keys()].map((path, i) => ({ id: `doc-${i}`, name: path, path }));
    },
  };
}

let backend = makeBackend('backend-1');

const store = {
  getBackend: () => backend,
  getProject: () => (h.projectId ? { id: h.projectId, documents: [] } : null),
};

import { saveDocument, forgetSavedRevisions } from '../src/core/editor/rv-save-document';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  libraryDocumentBase,
  projectDocumentBase,
} from '../src/core/editor/active-asset-store';

interface Emitted { event: string; payload: unknown }

function makeDoc(base: AssetBase, name = 'Belt') {
  const doc = {
    name,
    base,
    dirty: true,
    document: {
      opCount: 3,
      runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
      markSaved() {},
    },
    async markSaved(next: AssetBase) { doc.base = next; },
  };
  return doc;
}

function makeViewer(emitted: Emitted[]) {
  return {
    currentModelRoot: { name: 'Belt' },
    renderer: {},
    scene: {},
    emit: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
    getPlugin: () => undefined,
  };
}

beforeEach(() => {
  h.files.clear();
  h.projectId = 'prj_one';
  backend = makeBackend('backend-1');
  forgetSavedRevisions();
});

const savedEvents = (emitted: Emitted[]): Emitted[] =>
  emitted.filter(e => e.event === 'document-saved');

describe('document-saved event (plan-719 F8)', () => {
  it('fires after saving a document under models/', async () => {
    h.files.set('models/Cell.glb', 'old');
    const emitted: Emitted[] = [];
    const doc = makeDoc(projectDocumentBase('models/Cell.glb', 'Cell'), 'Cell');

    const result = await saveDocument(makeViewer(emitted) as never, doc as never);

    expect(result.kind).toBe('saved');
    expect(savedEvents(emitted)).toHaveLength(1);
  });

  it('fires after saving a document under library/Custom/', async () => {
    h.files.set('library/Custom/Belt.glb', 'old');
    const emitted: Emitted[] = [];
    const doc = makeDoc(libraryDocumentBase('Custom/Belt.glb'));

    await saveDocument(makeViewer(emitted) as never, doc as never);

    expect(savedEvents(emitted)).toHaveLength(1);
  });

  it('carries documentId and relPath', async () => {
    h.files.set('models/Cell.glb', 'old');
    const emitted: Emitted[] = [];
    const base = projectDocumentBase('models/Cell.glb', 'Cell');
    const doc = makeDoc(base, 'Cell');

    await saveDocument(makeViewer(emitted) as never, doc as never);

    const payload = savedEvents(emitted)[0]?.payload as
      { documentId: string; relPath: string } | undefined;
    expect(payload?.relPath).toBe('models/Cell.glb');
    expect(payload?.documentId).toBe(
      (base as Extract<AssetBase, { kind: 'document' }>).documentId);
  });

  it('does NOT fire when nothing was written', async () => {
    h.files.set('models/Cell.glb', 'old');
    const emitted: Emitted[] = [];
    const doc = makeDoc(projectDocumentBase('models/Cell.glb', 'Cell'), 'Cell');
    doc.dirty = false;

    const result = await saveDocument(makeViewer(emitted) as never, doc as never);

    expect(result.kind).toBe('no-op');
    expect(savedEvents(emitted)).toHaveLength(0);
  });
});
