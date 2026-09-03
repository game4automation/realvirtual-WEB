// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-719 F2 — a read-only source asks ONCE, and a decline writes nothing.
 *
 * ## The behaviour change this pins (§2.2, row 1)
 *
 * Before this plan, saving a catalog asset or a built-in model copied it into
 * `models/<name>.glb` SILENTLY. The verb announced the copy on the button, but
 * the destination — the thing the user actually cares about — was chosen for
 * them. The target semantics make it one explicit "Save into project as…"
 * prompt, and everything after that first copy is an ordinary document save
 * with no dialogs at all.
 *
 * ## Why the cancel case has a test of its own
 *
 * A prompt in front of a write is only safe if declining it is a true no-op.
 * The failure mode is specific and silent: bytes written before the name is
 * confirmed leave an orphan file with no manifest row — a document the user can
 * neither see nor open, and which the next `uniqueProjectPath` call then dodges
 * by inventing `_1` suffixes forever.
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

const writes: string[] = [];

function makeBackend(id: string) {
  return {
    kind: 'browser' as const,
    id,
    writable: true,
    isActive: true,
    async writeDocument(ref: string | { path: string }, bytes: Uint8Array) {
      const relPath = typeof ref === 'string' ? ref : ref.path;
      writes.push(relPath);
      h.files.set(relPath, new TextDecoder().decode(bytes));
      return { revision: 'rev' };
    },
    async readDocument(ref: string | { path: string }) {
      const relPath = typeof ref === 'string' ? ref : ref.path;
      const value = h.files.get(relPath);
      return value === undefined ? null : {
        bytes: new TextEncoder().encode(value),
        meta: { id: '', name: relPath, path: relPath },
        revision: 'rev',
      };
    },
    async readDocumentUrl(relPath: string) {
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

import { saveDocument, decideSaveVerb, forgetSavedRevisions } from '../src/core/editor/rv-save-document';
import type { AssetBase } from '../src/core/editor/rv-asset-document';

function makeDoc(base: AssetBase, name = 'Demo') {
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

function makeViewer() {
  return {
    currentModelRoot: { name: 'Demo' },
    renderer: {},
    scene: {},
    emit: () => {},
    getPlugin: () => undefined,
  };
}

const builtin: AssetBase = { kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' };

beforeEach(() => {
  h.files.clear();
  h.projectId = 'prj_one';
  backend = makeBackend('backend-1');
  writes.length = 0;
  forgetSavedRevisions();
});

describe('save into project — the ONE prompt (plan-719 F2)', () => {
  it('still announces the copy on the button before the click', () => {
    const decision = decideSaveVerb({ lineage: 'asset', base: builtin, name: 'Demo' }, backend as never);
    expect(decision.verb).toBe('save-into-project');
    // The MCP `_saveVerb.copies` contract is unchanged (§4 Phase 4 task 1).
    expect(decision.copies).toBe(true);
  });

  it('asks for a name instead of copying silently', async () => {
    const asked: string[] = [];
    const doc = makeDoc(builtin);

    const result = await saveDocument(makeViewer() as never, doc as never, {
      requestName: async (initial) => { asked.push(initial); return 'My Demo'; },
    });

    // Asked exactly once, pre-filled with the source's name.
    expect(asked).toEqual(['Demo']);
    expect(result.kind).toBe('saved');
    expect(writes).toEqual(['models/My Demo.glb']);
    // …and it became a DOCUMENT, so the next save is silent (F1).
    expect(result.kind === 'saved' && result.base.kind).toBe('document');
  });

  it('declining the prompt writes NOTHING and leaves the source read-only', async () => {
    const doc = makeDoc(builtin);

    const result = await saveDocument(makeViewer() as never, doc as never, {
      requestName: async () => null,
    });

    expect(result.kind).toBe('cancelled');
    // No blob, no row, no orphan.
    expect(writes).toEqual([]);
    expect(h.files.size).toBe(0);
    // The document is still the source it was.
    expect(doc.base).toEqual(builtin);
  });

  it('never prompts again once the source has become a document', async () => {
    const doc = makeDoc(builtin);
    await saveDocument(makeViewer() as never, doc as never, {
      requestName: async () => 'My Demo',
    });
    writes.length = 0;

    let askedAgain = false;
    doc.dirty = true;
    const second = await saveDocument(makeViewer() as never, doc as never, {
      requestName: async () => { askedAgain = true; return 'other'; },
    });

    expect(askedAgain).toBe(false);
    expect(second.kind).toBe('saved');
    expect(writes).toEqual(['models/My Demo.glb']);
  });
});
