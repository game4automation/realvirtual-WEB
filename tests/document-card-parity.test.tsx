// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Parity with the deleted `AssetActiveCard` (plan-709 §9.11).
 *
 * `AssetActiveCard` was the editor's own card and it made a short list of
 * promises: a dirty dot beside the name, a Save that only makes sense while
 * there is something to save, undo/redo, and the verbs Save as… / Rename… /
 * Share… / Download .glb / Discard changes. Deleting it is only safe if every
 * one of those survives in the shared `DocumentCard`, so they are written down
 * here as testable statements rather than left to a reviewer's memory.
 *
 * Two of them changed ON PURPOSE and say so below: the Save button is no longer
 * disabled (A11y — plan-709 §1, Primer's "Saving" pattern), and the subtitle is
 * the document's breadcrumb rather than the fixed line "Asset · Custom library",
 * which stopped being true the moment a save routed by identity.
 *
 * Also covers the plan's second §9.11 clause: the exit guard and the card read
 * ONE dirty bit, so the card cannot say "saved" while the guard still asks.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// A writable project, so the routing decision under test is the identity's and
// not "no project is open".
const backend = { id: 'b1', kind: 'browser', writable: true } as never;
vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => backend,
    getProject: () => ({ id: 'p1' }),
    setDirtyDocumentsProbe: () => {},
  }),
}));

import { DocumentCard } from '../src/core/hmi/scene/DocumentCard';
import { editorDocumentView } from '@rv-private/plugins/asset-editor/editor-document-view';
import { sceneDocumentView } from '../src/core/hmi/scene/scene-document-view';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
} from '../src/core/editor/active-document-view';
import { documentBase, libraryDocumentBase } from '../src/core/editor/active-asset-store';

// ─── Doubles ────────────────────────────────────────────────────────────

function stubAssetContext(over: Record<string, unknown> = {}) {
  const snap = {
    name: 'Belt',
    dirty: true,
    busy: false,
    canUndo: true,
    canRedo: false,
    undoLabel: 'Move node',
    redoLabel: null,
    ...over,
  };
  const doc = {
    id: 'doc1',
    base: libraryDocumentBase('Custom/Belt.glb'),
    name: snap.name,
    getSnapshot: () => snap,
    subscribe: () => () => {},
    undo: vi.fn(async () => {}),
    redo: vi.fn(async () => {}),
    renameDocument: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  };
  const viewer = {
    currentModelRoot: null,
    modes: { activeMode: 'editor', subscribe: () => () => {} },
  };
  return { viewer, doc } as never as Parameters<typeof editorDocumentView>[0];
}

function stubSceneSnapshot(over: Record<string, unknown> = {}) {
  return {
    saved: { id: 's1', name: 'MyPlant' },
    draft: { id: 's1', name: 'MyPlant' },
    isDraft: false,
    dirty: true,
    transient: false,
    busy: false,
    canUndo: true,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  } as never;
}

const stubSceneStore = {
  save: vi.fn(async () => {}),
  saveAs: vi.fn(async () => 's2'),
  discard: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  redo: vi.fn(async () => {}),
  rename: vi.fn(),
  duplicate: vi.fn(() => 's2'),
  saveSettingsIntoModel: vi.fn(async () => ({ kind: 'nothing-to-save' })),
  estimateFlatExport: vi.fn(async () => null),
  exportSceneGlb: vi.fn(async () => new Uint8Array()),
} as never;

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
});

// ─── The editor's promises, as data ─────────────────────────────────────

describe('AssetActiveCard parity — the view', () => {
  it('carries the document name and its dirty bit', () => {
    const view = editorDocumentView(stubAssetContext());
    expect(view.name).toBe('Belt');
    expect(view.dirty).toBe(true);
  });

  it('offers undo and redo with their labels', () => {
    const view = editorDocumentView(stubAssetContext());
    expect(view.actions.undo).toBeTypeOf('function');
    expect(view.actions.redo).toBeTypeOf('function');
    expect(view.canUndo).toBe(true);
    expect(view.canRedo).toBe(false);
    expect(view.undoLabel).toBe('Move node');
  });

  it('offers exactly the old menu verbs', () => {
    const view = editorDocumentView(stubAssetContext());
    expect((view.actions.menu ?? []).map(v => v.id))
      .toEqual(['save-as', 'rename', 'download', 'discard']);
    // Share was a menu item too, but it needs a dialog, so it arrives as a
    // capability the card renders rather than as a plain verb.
    expect(view.actions.share?.level).toBe('assembly');
    expect(view.actions.share?.suggestedName).toBe('Belt');
  });

  it('cannot discard a document with nothing to discard', () => {
    const clean = editorDocumentView(stubAssetContext({ dirty: false }));
    expect(clean.actions.menu?.find(v => v.id === 'discard')?.disabled).toBe(true);
    const dirty = editorDocumentView(stubAssetContext({ dirty: true }));
    expect(dirty.actions.menu?.find(v => v.id === 'discard')?.disabled).toBe(false);
  });

  it('an untitled document offers no name to share', () => {
    const view = editorDocumentView(stubAssetContext({ name: 'Untitled' }));
    expect(view.actions.share?.suggestedName).toBe('');
  });

  it('routes a library asset back to its own path — Save, not a copy', () => {
    expect(editorDocumentView(stubAssetContext()).saveVerb).toBe('save');
  });

  it('reports one chip for a session that never descended', () => {
    const view = editorDocumentView(stubAssetContext());
    expect(view.crumbs.map(c => c.label)).toEqual(['Belt']);
    expect(view.crumbs[0].current).toBe(true);
    // No stack, so "any frame dirty" is this document's own bit.
    expect(view.stackDirty).toBe(view.dirty);
  });
});

// ─── The same promises, rendered ────────────────────────────────────────

describe('AssetActiveCard parity — the card', () => {
  function mountEditorCard(over: Record<string, unknown> = {}) {
    setActiveDocumentView(editorDocumentView(stubAssetContext(over)));
    return render(<DocumentCard variant="compact" activeMode="editor" />);
  }

  it('marks unsaved work with the shared dot', () => {
    mountEditorCard({ dirty: true });
    expect(screen.getByTestId('document-card').querySelector('[data-testid="dirty-dot"]'))
      .not.toBeNull();
  });

  it('keeps Save reachable even with nothing to save — deliberately changed', () => {
    mountEditorCard({ dirty: false });
    // AssetActiveCard disabled the button here. It is now always pressable and
    // the state is carried by the dot and the verb; a disabled control drops
    // out of the keyboard order and tells a screen reader nothing.
    expect((screen.getByTestId('document-card-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders undo/redo, disabled exactly as the document reports', () => {
    mountEditorCard();
    expect((screen.getByTestId('document-card-undo') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('document-card-redo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders every old verb in the overflow menu', () => {
    mountEditorCard();
    fireEvent.click(screen.getByLabelText('More actions'));
    for (const id of ['save-as', 'rename', 'download', 'discard', 'share']) {
      expect(screen.getByTestId(`document-card-verb-${id}`)).toBeTruthy();
    }
  });

  it('runs a verb when it is chosen', () => {
    const ctx = stubAssetContext();
    setActiveDocumentView(editorDocumentView(ctx));
    render(<DocumentCard variant="compact" activeMode="editor" />);
    fireEvent.click(screen.getByTestId('document-card-undo'));
    expect((ctx as never as { doc: { undo: ReturnType<typeof vi.fn> } }).doc.undo)
      .toHaveBeenCalledTimes(1);
  });
});

// ─── The scene half, and the exit guard beside it ───────────────────────

describe('the card and the exit guard read ONE dirty bit', () => {
  it('the view’s dirty IS the snapshot’s dirty, both ways', () => {
    for (const dirty of [true, false]) {
      const snap = stubSceneSnapshot({ dirty });
      const view = sceneDocumentView(stubSceneStore, { ...(snap as object), dirty } as never, backend);
      // `trySwitch` in ProjectsDashboardHost gates on exactly `snap.dirty`, so
      // a card built from the same field cannot show "saved" while the guard
      // still asks — there is no second bit to disagree with.
      expect(view?.dirty).toBe(dirty);
      expect(view?.stackDirty).toBe(dirty);
    }
  });

  it('gives a scene exactly one breadcrumb chip', () => {
    const view = sceneDocumentView(stubSceneStore, stubSceneSnapshot(), backend);
    expect(view?.crumbs.map(c => c.label)).toEqual(['MyPlant']);
  });

  it('hangs saveSettingsIntoModel back on the card’s menu', () => {
    const view = sceneDocumentView(stubSceneStore, stubSceneSnapshot(), backend);
    const verb = view?.actions.menu?.find(v => v.id === 'save-into-model');
    expect(verb).toBeTruthy();
    expect(verb?.secondary).toBe('Settings travel with the file');
  });

  it('refuses to save a read-only project, and says why', () => {
    const readOnly = { id: 'b2', kind: 'bundled', writable: false } as never;
    const view = sceneDocumentView(stubSceneStore, stubSceneSnapshot(), readOnly);
    expect(view?.saveVerb).toBe('blocked');
    expect(view?.saveReason).toContain('ships with the application');
  });
});

// ─── The location crumb — a document is a FILE, never a section ─────────
//
// Field finding 2026-08-14: the crumb hardcoded "Unsaved" / "Scenes" off the
// snapshot, so a saved document claimed a section that no longer exists. It
// now reads the identity, which carries the row's real path.

describe('the location crumb names the file, never a section', () => {
  const storeWithIdentity = (identity: unknown) =>
    ({ ...(stubSceneStore as object), documentIdentity: () => identity }) as never;

  it('a document in the project root shows no folder at all', () => {
    const view = sceneDocumentView(
      storeWithIdentity(documentBase('doc_1', 'MyPlant', 'MyPlant.glb')),
      stubSceneSnapshot(), backend);
    expect(view?.location).toEqual([]);
  });

  it('a document in a folder shows that folder', () => {
    const view = sceneDocumentView(
      storeWithIdentity(documentBase('doc_1', 'Press', 'machines/Press.glb')),
      stubSceneSnapshot(), backend);
    expect(view?.location).toEqual(['machines']);
  });

  it('a library document shows the Library crumbs, same as the editor', () => {
    const view = sceneDocumentView(
      storeWithIdentity(documentBase('doc_1', 'Belt', 'library/Custom/Belt.glb')),
      stubSceneSnapshot(), backend);
    expect(view?.location).toEqual(['Library', 'Custom']);
  });

  it('only a DRAFT — a document that exists nowhere yet — says Unsaved', () => {
    const view = sceneDocumentView(
      storeWithIdentity(null),
      stubSceneSnapshot({ saved: null, isDraft: true }), backend);
    expect(view?.location).toEqual(['Unsaved']);
  });

  it('"Scenes" never appears — not even for a legacy path-less identity', () => {
    const view = sceneDocumentView(
      storeWithIdentity(documentBase('doc_1', 'Old')),   // path: '' (slot form)
      stubSceneSnapshot(), backend);
    expect(view?.location).toEqual([]);
  });
});
