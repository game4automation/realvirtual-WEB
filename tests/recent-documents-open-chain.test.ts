// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 Phase 3.6 SPIKE — the recents open chain.
 *
 * One question, answered against the real machinery rather than on paper:
 * can ONE awaitable function do guards → project → document → target mode,
 * for a foreign-project recent targeting `viewer` and for an editor→editor
 * recent with a vetoing guard, without the resume effect and with the right
 * mode in the ring for BOTH documents of an A→B→A round trip?
 *
 * The `ModeManager` under test is the REAL one — the veto in T2 has to be the
 * production guard machinery or the test proves nothing. Only its host (the
 * viewer's plugin/context plumbing) is stubbed, and that stub is also the
 * event bus the recents mode tracking subscribes to.
 *
 * plan-513: a recent's target is the document's STORED last mode, which the
 * host reads from `rv-document-modes` and hands in — {@link openStored} stands
 * in for that read with the entry's `mode` as the stored answer. The chain
 * decides the target once and the handoff carries it out, so the row's own
 * declared mode is no longer applied first and overridden afterwards (R3-4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const calls: string[] = [];

vi.mock('@rv-private/plugins/asset-editor/pending-open-store', () => ({
  setPendingAssetOpen: () => { /* identity plumbing is pinned elsewhere */ },
}));
vi.mock('../src/core/editor/active-asset-store', async (original) => {
  const actual =
    await original<typeof import('../src/core/editor/active-asset-store')>();
  return { ...actual, setOpenDocumentBase: () => { /* ditto */ } };
});

import { ModeManager, type ModeHost } from '../src/core/rv-mode-manager';
import { openDocumentAsWorkingScene } from '../src/core/hmi/projects/ProjectsDashboardHost';
import {
  openRecentEntry,
  __resetOpenRecentInFlight,
  type OpenRecentDeps,
} from '../src/core/hmi/projects/open-recent-entry';
import { openProjectById } from '../src/core/hmi/projects/open-project-by-id';
import type { RecentDocumentEntry } from '../src/core/project/rv-project-recents';
import {
  LS_KEY_RECENT_DOCUMENTS,
  attachRecentsModeTracking,
  readRecents,
  recordRecentForOpen,
  __resetRecentsSnapshot,
} from '../src/core/project/rv-project-recents-store';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';
import {
  DOCUMENT_MODES_DB_NAME,
  __closeDocumentModesDb,
  loadDocumentModes,
  recordDocumentMode,
} from '../src/core/project/rv-document-mode-store';

// ── The world ────────────────────────────────────────────────────────────

type ModeListener = (data: { from: string | null; to: string }) => void;

/** Stub viewer: a mode host and the event bus the ring's tracking listens on. */
function makeWorld() {
  const listeners = new Set<ModeListener>();
  const host = {
    viewer: {} as never,
    pluginsForMode: () => ({ enable: [], disable: [], activateHooks: [], deactivateHooks: [] }),
    enablePlugin: () => {},
    disablePlugin: () => {},
    callPlugin: () => {},
    setContext: () => {},
    emit: (event: string, data: { from: string | null; to: string }) => {
      if (event !== 'mode-changed') return;
      calls.push(`mode:${data.from ?? 'null'}->${data.to}`);
      for (const l of [...listeners]) l(data);
    },
  } as unknown as ModeHost;

  const modes = new ModeManager(host);
  // Order matters: `handoffExitTarget` and the chain's `firstDeparture` both
  // take the first non-editor mode of `list()`.
  modes.register({ id: 'viewer', label: 'Viewer', order: 1 });
  modes.register({ id: 'hmi', label: 'HMI', order: 2 });
  modes.register({ id: 'planner', label: 'Planner', order: 3 });
  modes.register({ id: 'editor', label: 'Editor', order: 4 });

  const bus = {
    on: (_e: 'mode-changed', cb: ModeListener) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    modes,
  };
  return { modes, bus };
}

const DOCS_P = [
  { id: 'doc_a', name: 'A', path: 'a.glb', section: 'library' },
  { id: 'doc_b', name: 'B', path: 'b.glb', section: 'library' },
] as unknown as readonly TieredDocumentEntry[];

interface Fixture {
  deps: OpenRecentDeps;
  openDocId: { value: string | null };
  current: { value: { id: string; backend: 'folder' | 'browser' | 'bundled' } | null };
  documents: { value: readonly TieredDocumentEntry[] };
  openFolderResult: { value: boolean | Promise<boolean> };
  projectKind: { value: 'demo' | 'project' };
  /** null = the chain gets no dirty-guard dep at all (the headless case). */
  dirtyAnswer: { value: boolean | null };
}

/**
 * A world where one project is open and `openProjectFolder` can be made to
 * succeed, fail or hang. `openScene` is the funnel stand-in: it records into
 * the ring exactly the way `SceneStore.openDocument` will (plan-478 §2.4.1),
 * which is what makes the intent scope observable here.
 */
function makeFixture(
  modes: ModeManager,
  bus: { on: (e: 'mode-changed', cb: ModeListener) => () => void; modes: ModeManager },
  start: { projectId: string; backend: 'folder' | 'browser' | 'bundled' },
): Fixture {
  const openDocId = { value: null as string | null };
  const current = { value: { id: start.projectId, backend: start.backend } as
    { id: string; backend: 'folder' | 'browser' | 'bundled' } | null };
  const documents = { value: DOCS_P };
  const openFolderResult = { value: true as boolean | Promise<boolean> };
  const projectKind = { value: 'project' as 'demo' | 'project' };

  const dirtyAnswer = { value: null as boolean | null };

  const sceneStore = {
    openScene: async (id: string, opts?: { modeDecidedByCaller?: boolean }) => {
      calls.push(`openScene:${id}`);
      openDocId.value = id;
      // `_applyMode` (plan-731 2e), stood up here the way `SceneStore` does
      // it: a bare, unguarded `setMode` INSIDE the open — unless the caller
      // decided the mode (plan-513 F5), which the chain now always does.
      const rowMode = (documents.value.find(d => d.id === id) as { mode?: string } | undefined)?.mode;
      if (!opts?.modeDecidedByCaller && rowMode && modes.has(rowMode)) modes.setMode(rowMode);
      // The funnel's second sink (plan-513 F1), beside the ring.
      void recordDocumentMode({
        projectId: current.value?.id,
        backend: current.value?.backend,
        documentId: id,
        activeMode: modes.activeMode,
        lockedMode: modes.lockedMode,
        isDemo: projectKind.value === 'demo',
      });
      recordRecentForOpen({
        projectId: current.value?.id,
        backend: current.value?.backend,
        documentId: id,
        documentName: id,
        documentPath: `models/${id}.glb`,
        projectName: current.value?.id ?? '',
        activeMode: modes.activeMode,
        lockedMode: modes.lockedMode,
      });
    },
  };

  const deps: OpenRecentDeps = {
    modes,
    currentProject: () => current.value,
    isLinked: () => true,
    resolveLinkedOpen: async (id) => {
      calls.push(`resolveLinkedOpen:${id}`);
      return { kind: 'ready', dir: {} as FileSystemDirectoryHandle };
    },
    store: {
      openDemoProject: async () => { calls.push('openDemoProject'); return true; },
      openWorkspaceProject: async () => { calls.push('openWorkspaceProject'); return true; },
      openRecentProject: async () => { calls.push('openRecentProject'); return true; },
      openProjectFolder: async () => {
        calls.push('openProjectFolder');
        const ok = await openFolderResult.value;
        return ok;
      },
    },
    isDemoProject: () => projectKind.value === 'demo',
    documents: () => documents.value,
    // The switch token travels with the open (plan-478 R3-2): the chain holds
    // the workspace lock for its whole run, so the handoff's own
    // `requestMode('editor')` is only allowed because it carries the token.
    openDocument: (id, token, targetMode) =>
      openDocumentAsWorkingScene({ modes }, sceneStore, documents.value, id, token, targetMode),
    forgetRecent: (p, d) => { calls.push(`forget:${p}/${d}`); },
    notify: (m) => { calls.push(`notify:${m}`); },
    confirmDiscardDirtyScene: async () => {
      if (dirtyAnswer.value === null) return true;
      calls.push(`dirtyGuard:${dirtyAnswer.value}`);
      return dirtyAnswer.value;
    },
  };

  attachRecentsModeTracking(bus, () => ({
    projectId: current.value?.id ?? null,
    documentId: openDocId.value,
  }));

  return { deps, openDocId, current, documents, openFolderResult, projectKind, dirtyAnswer };
}

function entry(over: Partial<RecentDocumentEntry> = {}): RecentDocumentEntry {
  return {
    projectId: 'P',
    backend: 'folder',
    documentId: 'doc_b',
    documentName: 'B',
    documentPath: 'models/b.glb',
    projectName: 'P',
    mode: 'editor',
    openedAt: new Date().toISOString(),
    ...over,
  };
}

/**
 * A recent opened with its STORED last mode (plan-513). The host reads that
 * from `rv-document-modes`; here the entry's `mode` stands in as the store's
 * answer, so every scenario below keeps stating its target where it always did.
 */
function openStored(e: RecentDocumentEntry, deps: OpenRecentDeps) {
  return openRecentEntry(e, deps, { lastMode: e.mode ?? null });
}

/** Let the handoff's un-awaited `void requestMode('editor')` land. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function dropModeDb() {
  __closeDocumentModesDb();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DOCUMENT_MODES_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  calls.length = 0;
  localStorage.removeItem(LS_KEY_RECENT_DOCUMENTS);
  __resetRecentsSnapshot();
  __resetOpenRecentInFlight();
  await dropModeDb();
});
afterEach(async () => { __resetOpenRecentInFlight(); await dropModeDb(); });

// ── T1 ───────────────────────────────────────────────────────────────────

describe('T1 — a foreign project, target mode viewer', () => {
  it('runs guards, then the project, then the document, and the mode LAST', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    modes.registerExitGuard('hmi', (from, to) => { calls.push(`guard:${from}->${to}`); return true; });
    fx.current.value = { id: 'OTHER', backend: 'folder' };
    const orig = fx.deps.store.openProjectFolder;
    fx.deps.store.openProjectFolder = async (d) => {
      const ok = await orig(d);
      if (ok) fx.current.value = { id: 'P', backend: 'folder' };
      return ok;
    };
    calls.length = 0;

    const r = await openStored(entry({ mode: 'viewer' }), fx.deps);
    await settle();

    expect(r).toBe('opened');
    expect(calls).toEqual([
      'guard:hmi->viewer',        // (1) the veto point, before anything moves
      'resolveLinkedOpen:P',      // (2) the project, awaited
      'openProjectFolder',
      'openScene:doc_b',          // (3) the document, through the handoff
      'mode:hmi->viewer',         // (4) the target mode, LAST
    ]);
    // The ring holds the mode the document is USED in, not the one it loaded in.
    expect(readRecents()[0]).toMatchObject({ documentId: 'doc_b', mode: 'viewer' });
  });

  it('a cancelled project open opens nothing and leaves the mode alone', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    modes.registerExitGuard('hmi', () => true);
    fx.current.value = { id: 'OTHER', backend: 'folder' };
    fx.openFolderResult.value = false;                     // the store's dirty guard said no
    calls.length = 0;

    const r = await openStored(entry({ mode: 'viewer' }), fx.deps);
    await settle();

    expect(r).toBe('project-cancelled');
    expect(calls).not.toContain('openScene:doc_b');
    expect(calls.filter(c => c.startsWith('mode:'))).toEqual([]);
    expect(modes.activeMode).toBe('hmi');                  // nothing to restore — nothing moved
    expect(readRecents()).toEqual([]);
  });
});

// ── T2 ───────────────────────────────────────────────────────────────────

describe('T2 — editor → editor with a vetoing exit guard', () => {
  it('aborts the whole open: no mode change, no document, no project', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('editor');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    modes.registerExitGuard('editor', (from, to) => { calls.push(`guard:${from}->${to}`); return false; });
    calls.length = 0;

    const r = await openStored(entry({ mode: 'editor' }), fx.deps);
    await settle();

    // The departure asked about is the HANDOFF's, not the target mode's — the
    // target IS the active mode here, so `requestMode` would have run no guard
    // at all and the handoff's bare `setMode` would have left the editor
    // unasked (SOL R2 F1).
    expect(calls).toEqual(['guard:editor->viewer']);
    expect(r).toBe('vetoed');
    expect(modes.activeMode).toBe('editor');
    expect(readRecents()).toEqual([]);
    // plan-513: the last-mode store is untouched as well.
    expect((await loadDocumentModes()).size).toBe(0);
  });

  it('the same click proceeds when the guard allows it', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('editor');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    modes.registerExitGuard('editor', () => true);
    calls.length = 0;

    const r = await openStored(entry({ mode: 'editor' }), fx.deps);
    await settle();

    expect(r).toBe('opened');
    expect(calls).toContain('openScene:doc_b');
    expect(modes.activeMode).toBe('editor');
  });
});

// ── T3 ───────────────────────────────────────────────────────────────────

describe('T3 — A → B → A keeps each document\'s own mode', () => {
  it('never writes the handoff\'s transitional mode onto either document', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('editor');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });

    // A is open in the editor — the state the ring starts from.
    await fx.deps.openDocument('doc_a');
    await settle();
    expect(readRecents()[0]).toMatchObject({ documentId: 'doc_a', mode: 'editor' });

    await openStored(entry({ documentId: 'doc_b', mode: 'editor' }), fx.deps);
    await settle();
    expect(readRecents().map(e => [e.documentId, e.mode])).toEqual([
      ['doc_b', 'editor'], ['doc_a', 'editor'],
    ]);

    await openStored(entry({ documentId: 'doc_a', documentName: 'A', mode: 'editor' }), fx.deps);
    await settle();
    expect(readRecents().map(e => [e.documentId, e.mode])).toEqual([
      ['doc_a', 'editor'], ['doc_b', 'editor'],
    ]);
    // The transitional mode the handoff passes through appears nowhere.
    expect(readRecents().some(e => e.mode === 'viewer')).toBe(false);
  });

  it('a mode the user settles in afterwards retags only the open document', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('editor');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    await fx.deps.openDocument('doc_a');
    await openStored(entry({ documentId: 'doc_b', mode: 'editor' }), fx.deps);
    await settle();

    await modes.requestMode('planner');
    await settle();

    expect(readRecents().map(e => [e.documentId, e.mode])).toEqual([
      ['doc_b', 'planner'], ['doc_a', 'editor'],
    ]);
  });
});

// ── T4 ───────────────────────────────────────────────────────────────────

describe('T4 — a second click while a chain runs', () => {
  it('is ignored, not queued', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    fx.current.value = { id: 'OTHER', backend: 'folder' };
    let release!: (v: boolean) => void;
    fx.openFolderResult.value = new Promise<boolean>((res) => { release = res; });
    const orig = fx.deps.store.openProjectFolder;
    fx.deps.store.openProjectFolder = async (d) => {
      const ok = await orig(d);
      if (ok) fx.current.value = { id: 'P', backend: 'folder' };
      return ok;
    };
    calls.length = 0;

    const first = openStored(entry({ mode: 'viewer' }), fx.deps);
    await Promise.resolve();
    const second = await openStored(entry({ documentId: 'doc_a', mode: 'planner' }), fx.deps);
    expect(second).toBe('busy');

    release(true);
    expect(await first).toBe('opened');
    await settle();

    expect(calls.filter(c => c.startsWith('openScene:'))).toEqual(['openScene:doc_b']);
    expect(modes.activeMode).toBe('viewer');
  });
});

// ── T5 ───────────────────────────────────────────────────────────────────

describe('T5 — openProjectById routes on the backend', () => {
  const base = {
    currentProject: () => null,
    isLinked: () => false,
    resolveLinkedOpen: async () => ({ kind: 'ready' as const, dir: {} as FileSystemDirectoryHandle }),
  };
  function store(ok = true) {
    return {
      openDemoProject: async () => { calls.push('openDemoProject'); return ok; },
      openWorkspaceProject: async () => { calls.push('openWorkspaceProject'); return ok; },
      openRecentProject: async () => { calls.push('openRecentProject'); return ok; },
      openProjectFolder: async () => { calls.push('openProjectFolder'); return ok; },
    };
  }

  it('browser → openWorkspaceProject', async () => {
    expect(await openProjectById({ projectId: 'W', backend: 'browser' },
      { ...base, store: store() })).toBe('opened');
    expect(calls).toEqual(['openWorkspaceProject']);
  });

  it('bundled → openDemoProject', async () => {
    expect(await openProjectById({ projectId: 'D', backend: 'bundled' },
      { ...base, store: store() })).toBe('opened');
    expect(calls).toEqual(['openDemoProject']);
  });

  it('linked folder → resolveLinkedOpen + openProjectFolder', async () => {
    const r = await openProjectById({ projectId: 'F', backend: 'folder' },
      { ...base, isLinked: () => true, store: store() });
    expect(r).toBe('opened');
    expect(calls).toEqual(['openProjectFolder']);
  });

  it('unlinked folder → openRecentProject (the handle comes from IndexedDB)', async () => {
    expect(await openProjectById({ projectId: 'F', backend: 'folder' },
      { ...base, store: store() })).toBe('opened');
    expect(calls).toEqual(['openRecentProject']);
  });

  it('a store answering false is "cancelled"', async () => {
    expect(await openProjectById({ projectId: 'W', backend: 'browser' },
      { ...base, store: store(false) })).toBe('cancelled');
  });

  it('a denied handle is "denied", a gone folder is "missing"', async () => {
    expect(await openProjectById({ projectId: 'F', backend: 'folder' }, {
      ...base, isLinked: () => true, store: store(),
      resolveLinkedOpen: async () => ({ kind: 'denied' as const }),
    })).toBe('denied');
    expect(await openProjectById({ projectId: 'F', backend: 'folder' }, {
      ...base, isLinked: () => true, store: store(),
      resolveLinkedOpen: async () => ({ kind: 'missing' as const }),
    })).toBe('missing');
  });

  it('identity is the PAIR — the same id on another backend is not already-open', async () => {
    const deps = { ...base, currentProject: () => ({ id: 'D', backend: 'bundled' as const }), store: store() };
    expect(await openProjectById({ projectId: 'D', backend: 'bundled' }, deps)).toBe('already-open');
    expect(await openProjectById({ projectId: 'D', backend: 'folder' }, deps)).toBe('opened');
  });

  it('a throwing store is "failed", never a silent success', async () => {
    expect(await openProjectById({ projectId: 'W', backend: 'browser' }, {
      ...base,
      store: { ...store(), openWorkspaceProject: async () => { throw new Error('boom'); } },
    })).toBe('failed');
  });
});

// ── T6 — Demo, missing document, and the chain's quiet outcomes ───────────

describe('T6 — the outcomes that are not an open', () => {
  it('a demo project lists the entry but does not restore its mode (F6)', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    fx.projectKind.value = 'demo';
    calls.length = 0;

    const r = await openStored(entry({ mode: 'planner' }), fx.deps);
    await settle();

    expect(r).toBe('opened');
    expect(calls).toContain('openScene:doc_b');
    // No mode change of any kind: `targetModeOf` answered null, and with the
    // target gone there was no departure to guard either.
    expect(calls.filter(c => c.startsWith('mode:'))).toEqual([]);
    expect(modes.activeMode).toBe('hmi');
  });

  it('a document that is gone is FORGOTTEN and reported (F7)', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    calls.length = 0;

    const r = await openStored(entry({ documentId: 'doc_gone', mode: 'hmi' }), fx.deps);
    await settle();

    expect(r).toBe('document-missing');
    expect(calls).toContain('forget:P/doc_gone');
    expect(calls.some(c => c.startsWith('notify:'))).toBe(true);
    expect(calls.filter(c => c.startsWith('openScene:'))).toEqual([]);
  });

  it('an unknown mode is a MISSING TARGET, not a veto — the document still opens', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    calls.length = 0;

    const r = await openStored(entry({ mode: 'no-such-mode' }), fx.deps);
    await settle();

    expect(r).toBe('opened');
    expect(calls).toContain('openScene:doc_b');
    expect(modes.activeMode).toBe('hmi');
  });
});

// ── R3-1 — the scene dirty guard ─────────────────────────────────────────

describe('R3-1 — unsaved scene work is asked about before anything moves', () => {
  it('a cancel leaves the previous document and mode completely intact', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('planner');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    // A is open and dirty; the user clicks a recent for B.
    await fx.deps.openDocument('doc_a');
    await settle();
    fx.dirtyAnswer.value = false;
    calls.length = 0;

    const r = await openStored(entry({ documentId: 'doc_b', mode: 'hmi' }), fx.deps);
    await settle();

    expect(r).toBe('dirty-cancelled');
    // Asked FIRST, and nothing at all after it: no guard, no project, no load.
    expect(calls).toEqual(['dirtyGuard:false']);
    expect(fx.openDocId.value).toBe('doc_a');
    expect(modes.activeMode).toBe('planner');
    expect(readRecents()[0].documentId).toBe('doc_a');
  });

  it('is asked even when the click changes neither project nor mode', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    fx.dirtyAnswer.value = false;
    calls.length = 0;

    // Same project, and the entry's mode IS the active mode — the case in
    // which nothing else in the chain would have asked the user anything.
    const r = await openStored(entry({ documentId: 'doc_b', mode: 'hmi' }), fx.deps);
    await settle();

    expect(r).toBe('dirty-cancelled');
    expect(calls).toEqual(['dirtyGuard:false']);
  });

  it('a discard lets the whole chain run', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    fx.dirtyAnswer.value = true;
    calls.length = 0;

    const r = await openStored(entry({ documentId: 'doc_b', mode: 'planner' }), fx.deps);
    await settle();

    expect(r).toBe('opened');
    expect(calls[0]).toBe('dirtyGuard:true');
    expect(calls).toContain('openScene:doc_b');
    expect(modes.activeMode).toBe('planner');
  });
});

// ── R3-2 — one interlock, shared with requestMode ────────────────────────

describe('R3-2 — the chain and requestMode share one lock', () => {
  it('a recent clicked while a guarded switch is mid-dialog answers busy', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });

    let releaseGuard!: (ok: boolean) => void;
    modes.registerExitGuard('hmi', () => new Promise<boolean>(r => { releaseGuard = r; }));

    const switching = modes.requestMode('planner');
    await Promise.resolve();                       // let the guard start
    calls.length = 0;

    const r = await openStored(entry({ mode: 'viewer' }), fx.deps);
    expect(r).toBe('busy');
    // Not one thing moved, and the chain asked no guard of its own.
    expect(calls).toEqual([]);

    releaseGuard(true);
    expect(await switching).toBe(true);
    expect(modes.activeMode).toBe('planner');
  });

  it('runExitGuards refuses to answer while another switch owns the workspace', async () => {
    const { modes } = makeWorld();
    modes.setMode('hmi');
    modes.registerExitGuard('hmi', () => true);
    const token = modes.acquireSwitchLock();
    expect(token).not.toBeNull();

    // The holder may ask; nobody else may.
    expect(await modes.runExitGuards('planner', token!)).toBe(true);
    expect(await modes.runExitGuards('planner')).toBe(false);
    expect(modes.acquireSwitchLock()).toBeNull();

    modes.releaseSwitchLock(token!);
    expect(await modes.runExitGuards('planner')).toBe(true);
  });

  it('releases the lock even when the chain ends in a veto', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('hmi');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    const off = modes.registerExitGuard('hmi', () => false);

    expect(await openStored(entry({ mode: 'viewer' }), fx.deps)).toBe('vetoed');
    expect(modes.isSwitchLocked).toBe(false);
    // With the veto withdrawn the workspace is switchable again — which it
    // would not be if the chain had leaked the lock on its way out.
    off();
    expect(await modes.requestMode('planner')).toBe(true);
  });

  it('serialises two overlapping handoffs instead of interleaving them', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('editor');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    calls.length = 0;

    // Started together, and deliberately not awaited in order.
    const first = fx.deps.openDocument('doc_a');
    const second = fx.deps.openDocument('doc_b');
    await Promise.all([second, first]);
    await settle();

    // The loads ran in start order, one after the other — no handoff landed
    // its load between another handoff's leave and its own.
    expect(calls.filter(c => c.startsWith('openScene:')))
      .toEqual(['openScene:doc_a', 'openScene:doc_b']);
    // And the ring is not corrupted: both documents kept the editor.
    expect(readRecents().map(e => [e.documentId, e.mode])).toEqual([
      ['doc_b', 'editor'], ['doc_a', 'editor'],
    ]);
  });
});

// ── R3-3 — the editor re-entry is awaited ────────────────────────────────

describe('R3-3 — the chain waits for the whole handoff', () => {
  it('the editor re-entry completes BEFORE the chain returns', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('editor');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });

    // The mode the handoff parks in holds its exit guard for a while, so a
    // re-entry that was not awaited would land after the chain had finished.
    let releaseViewer!: (ok: boolean) => void;
    modes.registerExitGuard('viewer', () => new Promise<boolean>(r => { releaseViewer = r; }));
    modes.registerExitGuard('editor', () => true);
    calls.length = 0;

    const run = openStored(entry({ documentId: 'doc_b', mode: 'editor' }), fx.deps);
    // Give the chain enough turns to reach (and block on) the re-entry.
    await settle();
    expect(calls).toContain('openScene:doc_b');
    expect(modes.activeMode).toBe('viewer');       // still parked — it is waiting

    releaseViewer(true);
    expect(await run).toBe('opened');
    await settle();

    expect(modes.activeMode).toBe('editor');
    expect(modes.isSwitchLocked).toBe(false);      // the lock outlived the wait
    expect(readRecents()[0]).toMatchObject({ documentId: 'doc_b', mode: 'editor' });
  });
});

// ── R3-4 — the row's own declared mode is a departure too ────────────────

describe('R3-4 — a document that declares its own mode', () => {
  const DOCS_WITH_MODE = [
    { id: 'doc_a', name: 'A', path: 'a.glb', section: 'library' },
    { id: 'doc_b', name: 'B', path: 'b.glb', section: 'library', mode: 'hmi' },
  ] as unknown as readonly TieredDocumentEntry[];

  it('without a last mode the row decides — and its departure is asked first', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('planner');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    fx.documents.value = DOCS_WITH_MODE;
    modes.registerExitGuard('planner', (from, to) => { calls.push('guard:' + from + '->' + to); return false; });
    calls.length = 0;

    const r = await openStored(entry({ documentId: 'doc_b', mode: undefined }), fx.deps);
    await settle();

    expect(calls).toEqual(['guard:planner->hmi']);
    expect(r).toBe('vetoed');
    expect(modes.activeMode).toBe('planner');
    expect(fx.openDocId.value).toBeNull();
  });

  it('a last mode outranks the row, and the workspace never passes through the row\'s mode', async () => {
    const { modes, bus } = makeWorld();
    modes.setMode('planner');
    const fx = makeFixture(modes, bus, { projectId: 'P', backend: 'folder' });
    fx.documents.value = DOCS_WITH_MODE;
    modes.registerExitGuard('planner', (from, to) => { calls.push('guard:' + from + '->' + to); return true; });
    calls.length = 0;

    const r = await openStored(entry({ documentId: 'doc_b', mode: 'planner' }), fx.deps);
    await settle();

    expect(r).toBe('opened');
    // plan-513: one decision, no intermediate mode — the target IS the active
    // mode, so nothing is asked and nothing switches.
    expect(calls.filter(c => c.startsWith('mode:') || c.startsWith('guard:'))).toEqual([]);
    expect(modes.activeMode).toBe('planner');
  });
});
