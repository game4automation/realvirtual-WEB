// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-nav — a reference's asset opens in THIS tab, in its last mode, and
 * Back returns to the layout in the mode and camera it was left in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearDocumentNav,
  getDocumentNav,
  navigateBack,
  openReferencedDocument,
  syncDocumentNav,
  type DocumentNavHost,
  type NavCamera,
} from '../src/core/hmi/document-nav';
import { __resetOpenRecentInFlight } from '../src/core/hmi/projects/open-recent-entry';
import { navCrumbs } from '../src/core/hmi/DocumentNavBar';

interface FakeState {
  open: { documentId: string; name: string } | null;
  mode: string;
  camera: NavCamera;
  lastModes: Record<string, string>;
  calls: string[];
  notices: string[];
  restored: NavCamera[];
  /** Exit guard answer for the next switch. */
  guard: boolean;
}

const DOCS = [
  { id: 'doc_layout', name: 'juju' },
  { id: 'doc_mhm', name: 'mhm' },
  { id: 'doc_side', name: 'sidecutter' },
];

function fakeHost(state: FakeState): DocumentNavHost {
  return {
    modes: {
      get activeMode() { return state.mode; },
      has: (id) => ['planner', 'editor', 'hmi'].includes(id),
      list: () => [{ id: 'hmi' }, { id: 'planner' }, { id: 'editor' }],
      setMode: (id) => { state.mode = id; },
      runExitGuards: async () => state.guard,
      acquireSwitchLock: () => Symbol('lock'),
      releaseSwitchLock: () => {},
    },
    project: () => ({ id: 'prj', backend: 'folder', name: 'testnestedassets', isDemo: false, documents: DOCS }),
    openDocument: () => state.open,
    readLastMode: async (_b, _p, id) => state.lastModes[id] ?? null,
    openAsWorkingScene: async (id, _token, targetMode) => {
      state.calls.push(`open ${id} ${targetMode ?? '-'}`);
      state.open = { documentId: id, name: DOCS.find((d) => d.id === id)!.name };
      if (targetMode) state.mode = targetMode;
      return true;
    },
    flushAutosave: async () => { state.calls.push('flush'); },
    getCamera: () => state.camera,
    restoreCamera: async (c) => { state.restored.push(c); },
    notify: (m) => { state.notices.push(m); },
  };
}

let state: FakeState;
beforeEach(() => {
  clearDocumentNav();
  __resetOpenRecentInFlight();
  state = {
    open: { documentId: 'doc_layout', name: 'juju' },
    mode: 'planner',
    camera: { position: [1, 2, 3], target: [0, 0, 0] },
    lastModes: { doc_mhm: 'editor' },
    calls: [],
    notices: [],
    restored: [],
    guard: true,
  };
});
afterEach(() => clearDocumentNav());

describe('document-nav', () => {
  it('opens the referenced document in its last mode after flushing the autosave, and pushes the way back', async () => {
    const host = fakeHost(state);
    expect(await openReferencedDocument(host, 'doc_mhm')).toBe('opened');
    expect(state.calls).toEqual(['flush', 'open doc_mhm editor']);
    const nav = getDocumentNav();
    expect(nav.frames).toEqual([{ documentId: 'doc_layout', name: 'juju', mode: 'planner', camera: { position: [1, 2, 3], target: [0, 0, 0] } }]);
    expect(nav.current).toEqual({ documentId: 'doc_mhm', name: 'mhm' });
    expect(nav.busy).toBe(false);
  });

  it('Back reopens the layout in the mode it was left in and restores its camera', async () => {
    const host = fakeHost(state);
    await openReferencedDocument(host, 'doc_mhm');
    state.calls = [];
    expect(await navigateBack(host)).toBe('opened');
    expect(state.calls).toEqual(['flush', 'open doc_layout planner']);
    expect(state.mode).toBe('planner');
    expect(state.restored).toEqual([{ position: [1, 2, 3], target: [0, 0, 0] }]);
    expect(getDocumentNav().frames).toEqual([]);
    expect(getDocumentNav().current).toBeNull();
  });

  it('chains levels and a crumb jumps back several at once', async () => {
    const host = fakeHost(state);
    await openReferencedDocument(host, 'doc_mhm');
    await openReferencedDocument(host, 'doc_side');
    expect(getDocumentNav().frames.map((f) => f.name)).toEqual(['juju', 'mhm']);
    expect(navCrumbs(getDocumentNav().frames, getDocumentNav().current).map((c) => [c.label, c.current]))
      .toEqual([['juju', false], ['mhm', false], ['sidecutter', true]]);
    expect(await navigateBack(host, 0)).toBe('opened');
    expect(state.open?.documentId).toBe('doc_layout');
    expect(getDocumentNav().frames).toEqual([]);
  });

  it('a vetoed open (exit guard says no) changes nothing', async () => {
    state.guard = false;
    expect(await openReferencedDocument(fakeHost(state), 'doc_mhm')).toBe('vetoed');
    expect(state.open?.documentId).toBe('doc_layout');
    expect(getDocumentNav().frames).toEqual([]);
  });

  it('an unsaved working scene (no document) has nothing to come back to', async () => {
    state.open = null;
    expect(await openReferencedDocument(fakeHost(state), 'doc_mhm')).toBe('no-document');
    expect(state.notices).toHaveLength(1);
    expect(state.calls).toEqual([]);
  });

  it('a document opened another way ends the chain', async () => {
    await openReferencedDocument(fakeHost(state), 'doc_mhm');
    syncDocumentNav('doc_mhm');
    expect(getDocumentNav().frames).toHaveLength(1);
    syncDocumentNav('doc_side');
    expect(getDocumentNav().frames).toEqual([]);
  });

  it('an unknown document id is refused before anything moves', async () => {
    expect(await openReferencedDocument(fakeHost(state), 'doc_gone')).toBe('not-found');
    expect(state.calls).toEqual([]);
  });
});
