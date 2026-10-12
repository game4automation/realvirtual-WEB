// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.5 — `openProjectDocument`, the open chain shared by recents and
 * the Projects screen's model search: project then document, the
 * `document-missing` branch with the caller's own `forget`, and the re-check
 * against the LIVE row once the project is open (`vetoed-after-open`).
 *
 * plan-513 §9.6 — the chain decides the target mode ONCE, after the project
 * open, from the stored last mode, the live row and the demo status; it asks
 * the exit guards for exactly that transition, once; a foreign project's
 * pre-open question comes from the last mode only, never from the (possibly
 * stale) search index; and the handoff is handed the target.
 *
 * The recents' own contract stays pinned by `recent-documents-open-chain`;
 * this file stands the chain up with plain fakes so every guard call is
 * countable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetOpenRecentInFlight, openProjectDocument, openRecentEntry,
  type OpenDocumentDeps, type OpenDocumentTarget, type OpenRecentModes,
} from '../src/core/hmi/projects/open-recent-entry';

type Backend = 'folder' | 'browser' | 'bundled';
interface Row { id: string; mode?: string }

const MODES = ['viewer', 'hmi', 'planner', 'des', 'editor'];

function fakeModes(active: string, guardAnswer = true) {
  const modes = {
    activeMode: active as string | null,
    has: (id: string) => MODES.includes(id),
    list: () => MODES.map(id => ({ id })),
    setMode: vi.fn((id: string) => { modes.activeMode = id; }),
    runExitGuards: vi.fn(async (_to: string, _token?: symbol) => guardAnswer),
    acquireSwitchLock: () => Symbol('lock'),
    releaseSwitchLock: () => {},
  } satisfies OpenRecentModes;
  return modes;
}

/** Project p0 is open; opening p1 replaces the document list with `p1Rows`. */
function world(opts: { active?: string; guard?: boolean; p1Rows?: Row[] } = {}) {
  const modes = fakeModes(opts.active ?? 'hmi', opts.guard ?? true);
  const state = {
    current: { id: 'p0', backend: 'folder' as Backend | null },
    rows: [{ id: 'x0' }] as Row[],
    demo: false,
  };
  const openProjectFolder = vi.fn(async () => {
    state.current = { id: 'p1', backend: 'folder' };
    state.rows = opts.p1Rows ?? [{ id: 'd1' }];
    return true;
  });
  const openDocument = vi.fn(async (_id: string, _token?: symbol, _target?: string): Promise<void | boolean> => {});
  const forget = vi.fn();
  const notify = vi.fn();
  const deps: OpenDocumentDeps = {
    modes,
    currentProject: () => state.current,
    isLinked: () => true,
    resolveLinkedOpen: async () => ({ kind: 'ready', dir: {} as FileSystemDirectoryHandle }),
    store: {
      openDemoProject: async () => true,
      openWorkspaceProject: async () => true,
      openRecentProject: async () => true,
      openProjectFolder,
    },
    isDemoProject: () => state.demo,
    documents: () => state.rows,
    openDocument,
    notify,
    forget,
  };
  return { modes, state, deps, openProjectFolder, openDocument, forget, notify };
}

function hit(extra: Partial<OpenDocumentTarget> = {}): OpenDocumentTarget {
  return { projectId: 'p1', backend: 'folder', documentId: 'd1', projectName: 'P1', ...extra };
}

beforeEach(() => __resetOpenRecentInFlight());

describe('openProjectDocument', () => {
  it('a hit in another project: the project opens, then the document with the right id', async () => {
    const w = world();
    expect(await openProjectDocument(hit(), w.deps)).toBe('opened');
    expect(w.openProjectFolder).toHaveBeenCalledTimes(1);
    // No last mode, no declared mode: the target is the active mode.
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'hmi');
    expect(w.openProjectFolder.mock.invocationCallOrder[0])
      .toBeLessThan(w.openDocument.mock.invocationCallOrder[0]);
  });

  it('document-missing: forget(projectId, documentId), a message, the project stays open', async () => {
    const w = world({ p1Rows: [{ id: 'other' }] });
    expect(await openProjectDocument(hit(), w.deps)).toBe('document-missing');
    expect(w.forget).toHaveBeenCalledWith('p1', 'd1');
    expect(w.notify).toHaveBeenCalledWith('That document could not be found any more.');
    expect(w.state.current).toEqual({ id: 'p1', backend: 'folder' });
    expect(w.openDocument).not.toHaveBeenCalled();
  });

  it('a lastMode other than the active one, vetoed: no project open, no mode change', async () => {
    const w = world({ active: 'hmi', guard: false });
    expect(await openProjectDocument(hit({ lastMode: 'planner' }), w.deps)).toBe('vetoed');
    expect(w.modes.runExitGuards).toHaveBeenCalledWith('planner', expect.any(Symbol));
    expect(w.openProjectFolder).not.toHaveBeenCalled();
    expect(w.modes.setMode).not.toHaveBeenCalled();
    expect(w.modes.activeMode).toBe('hmi');
  });

  it('no lastMode and a live row without one: no guard, no mode change by the chain', async () => {
    const w = world({ active: 'hmi' });
    expect(await openProjectDocument(hit(), w.deps)).toBe('opened');
    expect(w.modes.runExitGuards).not.toHaveBeenCalled();
    expect(w.modes.setMode).not.toHaveBeenCalled();
  });

  it('a stale snapshot, vetoed on the re-check: vetoed-after-open, project open, no document, mode kept', async () => {
    const w = world({ active: 'hmi', guard: false, p1Rows: [{ id: 'd1', mode: 'planner' }] });
    // The snapshot said `hmi` — the active mode, no departure; the live row says `planner`.
    const r = await openProjectDocument(hit({ indexedDeclaredMode: 'hmi' }), w.deps);
    expect(r).toBe('vetoed-after-open');
    expect(w.modes.runExitGuards).toHaveBeenCalledTimes(1);
    expect(w.modes.runExitGuards).toHaveBeenCalledWith('planner', expect.any(Symbol));
    expect(w.state.current).toEqual({ id: 'p1', backend: 'folder' });
    expect(w.openDocument).not.toHaveBeenCalled();
    expect(w.modes.activeMode).toBe('hmi');
    expect(w.modes.setMode).not.toHaveBeenCalled();
  });

  it('the same stale snapshot with an agreeing guard: the document is loaded in the live row\'s mode', async () => {
    const w = world({ active: 'hmi', guard: true, p1Rows: [{ id: 'd1', mode: 'planner' }] });
    expect(await openProjectDocument(hit({ indexedDeclaredMode: 'hmi' }), w.deps)).toBe('opened');
    expect(w.modes.runExitGuards).toHaveBeenCalledTimes(1);
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'planner');
  });

  it('a lastMode the live row does not change is asked ONCE, not again after the open', async () => {
    const w = world({ active: 'hmi', guard: true, p1Rows: [{ id: 'd1', mode: 'des' }] });
    expect(await openProjectDocument(hit({ lastMode: 'planner' }), w.deps)).toBe('opened');
    expect(w.modes.runExitGuards).toHaveBeenCalledTimes(1);
    expect(w.modes.runExitGuards).toHaveBeenCalledWith('planner', expect.any(Symbol));
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'planner');
  });

  it('shares the in-flight lock with the recents', async () => {
    const w = world();
    let release!: () => void;
    w.openProjectFolder.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      release = () => { w.state.current = { id: 'p1', backend: 'folder' }; w.state.rows = [{ id: 'd1' }]; resolve(true); };
    }));
    const first = openProjectDocument(hit(), w.deps);
    await Promise.resolve();
    const recent = await openRecentEntry({
      projectId: 'p1', backend: 'folder', documentId: 'd1', documentName: 'D1',
      documentPath: 'models/d1.glb', projectName: 'P1', openedAt: '',
    }, { ...w.deps, forgetRecent: vi.fn() });
    expect(recent).toBe('busy');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect(await first).toBe('opened');
  });
});

describe('openProjectDocument — one mode decision (plan-513 §9.6)', () => {
  /** A guard that vetoes only one destination. */
  function onlyVetoes(w: ReturnType<typeof world>, to: string) {
    w.modes.runExitGuards.mockImplementation(async (dest: string) => dest !== to);
  }

  it('asks per transition with to = T: a guard vetoing only the editor blocks HMI → editor', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1' }] });
    onlyVetoes(w, 'editor');
    expect(await openProjectDocument(hit({ lastMode: 'editor' }), w.deps)).toBe('vetoed');
    expect(w.modes.runExitGuards).toHaveBeenCalledTimes(1);
    expect(w.modes.runExitGuards).toHaveBeenCalledWith('editor', expect.any(Symbol));
    expect(w.openProjectFolder).not.toHaveBeenCalled();
  });

  it('… and lets HMI → planner through', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1' }] });
    onlyVetoes(w, 'editor');
    expect(await openProjectDocument(hit({ lastMode: 'planner' }), w.deps)).toBe('opened');
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'planner');
  });

  it('from the editor the question is T, not the first non-editor mode', async () => {
    const w = world({ active: 'editor', p1Rows: [{ id: 'd1' }] });
    expect(await openProjectDocument(hit({ lastMode: 'planner' }), w.deps)).toBe('opened');
    expect(w.modes.runExitGuards.mock.calls.map(c => c[0])).toEqual(['planner']);
  });

  it('editor → editor asks the PARK departure, before any mutation', async () => {
    const w = world({ active: 'editor', guard: false, p1Rows: [{ id: 'd1' }] });
    expect(await openProjectDocument(hit({ lastMode: 'editor' }), w.deps)).toBe('vetoed');
    expect(w.modes.runExitGuards.mock.calls.map(c => c[0])).toEqual(['viewer']);
    expect(w.openProjectFolder).not.toHaveBeenCalled();
    expect(w.openDocument).not.toHaveBeenCalled();
  });

  it('search hit: index says planner, live row hmi, no lastMode → opens in hmi', async () => {
    const w = world({ active: 'planner', p1Rows: [{ id: 'd1', mode: 'hmi' }] });
    expect(await openProjectDocument(hit({ indexedDeclaredMode: 'planner' }), w.deps)).toBe('opened');
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'hmi');
  });

  it('search hit: active hmi, index planner, live row hmi, guard vetoes only planner → no veto', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1', mode: 'hmi' }] });
    onlyVetoes(w, 'planner');
    expect(await openProjectDocument(hit({ indexedDeclaredMode: 'planner' }), w.deps)).toBe('opened');
    // No pre-open question from the index — and none after, T is the active mode.
    expect(w.modes.runExitGuards).not.toHaveBeenCalled();
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'hmi');
  });

  it('search hit with lastMode editor and a live row hmi → editor', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1', mode: 'hmi' }] });
    expect(await openProjectDocument(hit({ lastMode: 'editor', indexedDeclaredMode: 'hmi' }), w.deps)).toBe('opened');
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'editor');
  });

  it('a demo project with a stored entry → its declared mode', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1', mode: 'planner' }] });
    w.openProjectFolder.mockImplementationOnce(async () => {
      w.state.current = { id: 'p1', backend: 'folder' };
      w.state.rows = [{ id: 'd1', mode: 'planner' }];
      w.state.demo = true;
      return true;
    });
    expect(await openProjectDocument(hit({ lastMode: 'editor' }), w.deps)).toBe('opened');
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'planner');
  });

  it('a veto after the project open → vetoed-after-open, document not loaded, mode unchanged', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1', mode: 'des' }] });
    onlyVetoes(w, 'des');
    expect(await openProjectDocument(hit(), w.deps)).toBe('vetoed-after-open');
    expect(w.openDocument).not.toHaveBeenCalled();
    expect(w.modes.activeMode).toBe('hmi');
    expect(w.modes.setMode).not.toHaveBeenCalled();
  });

  it('the handoff refusing the editor re-entry is reported as vetoed-after-open', async () => {
    const w = world({ active: 'editor', p1Rows: [{ id: 'd1' }] });
    w.openDocument.mockResolvedValueOnce(false);
    expect(await openProjectDocument(hit({ lastMode: 'editor' }), w.deps)).toBe('vetoed-after-open');
  });

  it('same project: no project open, the guard asked once, the live row decides', async () => {
    const w = world({ active: 'hmi' });
    w.state.current = { id: 'p1', backend: 'folder' };
    w.state.rows = [{ id: 'd1', mode: 'planner' }];
    expect(await openProjectDocument(hit(), w.deps)).toBe('opened');
    expect(w.openProjectFolder).not.toHaveBeenCalled();
    expect(w.modes.runExitGuards.mock.calls.map(c => c[0])).toEqual(['planner']);
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'planner');
  });

  it('same project, dirty scene: exactly one dirty dialog, then the open', async () => {
    const w = world({ active: 'hmi' });
    w.state.current = { id: 'p1', backend: 'folder' };
    w.state.rows = [{ id: 'd1' }];
    const confirmDiscardDirtyScene = vi.fn(async () => true);
    expect(await openProjectDocument(hit(), { ...w.deps, confirmDiscardDirtyScene })).toBe('opened');
    expect(confirmDiscardDirtyScene).toHaveBeenCalledTimes(1);
    expect(w.openDocument).toHaveBeenCalledTimes(1);
  });

  it('an unregistered lastMode counts as absent', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1' }] });
    expect(await openProjectDocument(hit({ lastMode: 'no-such-mode' }), w.deps)).toBe('opened');
    expect(w.modes.runExitGuards).not.toHaveBeenCalled();
    expect(w.openDocument).toHaveBeenCalledWith('d1', expect.any(Symbol), 'hmi');
  });
});

describe('openRecentEntry — the wrapper', () => {
  it('reads the target from the caller\'s lastMode, never from entry.mode (plan-513)', async () => {
    const w = world({ active: 'hmi', p1Rows: [{ id: 'd1' }] });
    const base = {
      projectId: 'p1', backend: 'folder' as const, documentId: 'd1', documentName: 'D1',
      documentPath: 'models/d1.glb', projectName: 'P1', openedAt: '', mode: 'planner',
    };
    expect(await openRecentEntry(base, { ...w.deps, forgetRecent: vi.fn() })).toBe('opened');
    expect(w.openDocument).toHaveBeenLastCalledWith('d1', expect.any(Symbol), 'hmi');
    __resetOpenRecentInFlight();
    w.state.current = { id: 'p0', backend: 'folder' };
    expect(await openRecentEntry(base, { ...w.deps, forgetRecent: vi.fn() }, { lastMode: 'des' })).toBe('opened');
    expect(w.openDocument).toHaveBeenLastCalledWith('d1', expect.any(Symbol), 'des');
  });

  it('a recent of a foreign project re-checks against the live row too', async () => {
    const w = world({ active: 'hmi', guard: false, p1Rows: [{ id: 'd1', mode: 'des' }] });
    const forgetRecent = vi.fn();
    const r = await openRecentEntry({
      projectId: 'p1', backend: 'folder', documentId: 'd1', documentName: 'D1',
      documentPath: 'models/d1.glb', projectName: 'P1', openedAt: '',
    }, { ...w.deps, forgetRecent });
    // No mode of its own, nothing known about the row before the open: the
    // first ask happens on the live row.
    expect(r).toBe('vetoed-after-open');
    expect(w.modes.runExitGuards).toHaveBeenCalledWith('des', expect.any(Symbol));
    expect(w.openDocument).not.toHaveBeenCalled();
  });

  it('routes a gone document to forgetRecent', async () => {
    const w = world({ p1Rows: [] });
    const forgetRecent = vi.fn();
    const r = await openRecentEntry({
      projectId: 'p1', backend: 'folder', documentId: 'd1', documentName: 'D1',
      documentPath: 'models/d1.glb', projectName: 'P1', openedAt: '',
    }, { ...w.deps, forgetRecent });
    expect(r).toBe('document-missing');
    expect(forgetRecent).toHaveBeenCalledWith('p1', 'd1');
    expect(w.forget).not.toHaveBeenCalled();
  });
});
