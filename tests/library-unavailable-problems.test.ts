// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.6 — a library that is not there becomes a Problems row with its
 * repair, and the repair keeps the user activation (Decision A, §3.3, F7/F9).
 *
 *  - locked → **Grant** (`library.grant`): `requestPermission({mode:'read'})`
 *    is reached SYNCHRONOUSLY from the dispatch (the click); success → ready,
 *    row gone; a `SecurityError` (activation already spent) and a denial keep
 *    the row and say so;
 *  - unknown → **Locate folder…** (`library.locate`): `showDirectoryPicker`
 *    is reached synchronously; a folder of ANOTHER project is refused with both
 *    names; the right one is linked (`projectfolder:<id>` + linked row) and the
 *    loader finds it;
 *  - rows name hint and `neededBy`, are quiet, leave with the project, and one
 *    summary line per project open says how many libraries are unavailable.
 *
 * Folder libraries run through the real `FolderBackend` over `FakeDir`
 * handles (as 9.2); only the IndexedDB handle store is replaced, because a
 * fake handle cannot be structured-cloned into it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { ensureHandlePermission } from '../src/core/engine/rv-local-filesystem';
import type { RvProject } from '../src/core/project/rv-project-types';
import {
  LibraryProjectLoader,
  type LibraryBackendFactory,
  type LibraryProjectLoaderDeps,
} from '../src/core/library/library-project-loader';
import {
  GRANT_DENIED,
  GRANT_NEEDS_CLICK,
  installLibraryAvailability,
  LIBRARY_UNAVAILABLE_CODE,
  libraryUnavailableProblemId,
  LOCATE_BUILTIN,
  locateRefusal,
  resetLibraryAvailabilityForTests,
  setLibraryAvailabilityDepsForTests,
} from '../src/core/library/library-availability';
import { locateProjectFolder } from '../src/core/project/rv-project-locate';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureLibraryCommandsRegistered } from '../src/core/library/library-commands';
import {
  announceProblems,
  getProblem,
  getProblems,
  getProblemsAnnouncement,
  reportProblem,
  resetProblemsForTests,
  withdrawProblemsAnnouncement,
} from '../src/core/hmi/problems-store';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from '../src/core/library/library-origin';
import { libraryStateBadge } from '../src/core/library/library-project-ui';
import { listLibraryProjectRows } from '../src/core/library/project-library-attach';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { getProblemsFilterForTests, ProblemsPanel, setProblemsPanelOpen } from '../src/core/hmi/ProblemsPanel';
import type { RVViewer } from '../src/core/rv-viewer';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { fakeGlb } from './helpers/fake-document-project';

const NOW = '2026-11-03T00:00:00.000Z';
const VIEWER = { modes: { activeMode: 'planner' } } as unknown as RVViewer;

function projectFolder(dirName: string, id: string, opts: { name?: string; libraries?: unknown[] } = {}): FakeDir {
  const dir = new FakeDir(dirName);
  dir.seedText('project.json', JSON.stringify({
    schemaVersion: 2, id, name: opts.name ?? dirName, canonicalName: dirName.toLowerCase(),
    createdAt: NOW, modifiedAt: NOW,
    documents: [{ id: 'doc_pump', path: 'models/pump.glb', name: 'pump' }],
    ...(opts.libraries ? { libraries: opts.libraries } : {}),
  }));
  dir.seedDir('models').seedBytes('pump.glb', fakeGlb(`${id}:pump`));
  return dir;
}

function projectA(libraries: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_a', name: 'A', canonicalName: 'a', libraries } as unknown as RvProject;
}

interface Env {
  loader: LibraryProjectLoader;
  folders: Map<string, FakeDir>;
  stored: Map<string, FileSystemDirectoryHandle>;
  linkedRows: Array<{ id: string; name: string; folderName?: string | null }>;
  pickerCalls: number;
  nextPick: FakeDir | Error | null;
  projectId: string | null;
  registry: CommandRegistry;
  uninstall: () => void;
}

function env(): Env {
  const folders = new Map<string, FakeDir>();
  const stored = new Map<string, FileSystemDirectoryHandle>();
  const factory: LibraryBackendFactory = {
    folder: (handle, projectId) => new FolderBackend(handle, { writable: false, id: `folder:${projectId}` }),
    browser: () => null,
    remote: () => ({ readManifest: async () => null }) as never,
  };
  const deps: LibraryProjectLoaderDeps = {
    factory,
    // A Locate stores the handle under `projectfolder:<id>` — the loader reads it back from there.
    getLinkedHandle: async (id) => stored.get(`projectfolder:${id}`) ?? (folders.has(id) ? asDirHandle(folders.get(id)!) : null),
    hasReadPermission: async (h) => (await ensureHandlePermission(h, { mode: 'read', prompt: false })) !== null,
    builtinBaseUrl: () => null,
  };
  const loader = new LibraryProjectLoader(deps);
  const e: Env = {
    loader, folders, stored, linkedRows: [], pickerCalls: 0, nextPick: null, projectId: 'prj_a',
    registry: new CommandRegistry(), uninstall: () => {},
  };
  setLibraryAvailabilityDepsForTests({
    loader: () => loader,
    directoryPicker: () => () => {
      e.pickerCalls++;
      const pick = e.nextPick;
      if (pick instanceof Error) return Promise.reject(pick);
      return pick ? Promise.resolve(asDirHandle(pick)) : Promise.reject(Object.assign(new Error('dismissed'), { name: 'AbortError' }));
    },
    putHandle: async (dir, key) => { stored.set(key, dir); },
    recordLinkedProject: (row) => { e.linkedRows.push(row); },
  });
  ensureLibraryCommandsRegistered(e.registry);
  e.uninstall = installLibraryAvailability(loader, { getProjectId: () => e.projectId });
  return e;
}

afterEach(() => {
  resetLibraryAvailabilityForTests();
  resetProblemsForTests();
});

function lockedFolder(e: Env, id: string, dirName: string): FakeDir {
  const dir = projectFolder(dirName, id);
  dir.permissions.read = 'prompt';
  dir.permissions.readwrite = 'prompt';
  e.folders.set(id, dir);
  return dir;
}

describe('plan-778 9.6 — locked library → Grant', () => {
  it('a locked library is a quiet warning row with Grant, naming its folder', async () => {
    const e = env();
    lockedFolder(e, 'prj_b', 'SharedConveyors');
    e.loader.setProject(projectA([{ projectId: 'prj_b', label: 'SharedConveyors' }]));
    await e.loader.whenSettled();
    const row = getProblem(libraryUnavailableProblemId('prj_b'))!;
    expect(row).toBeTruthy();
    expect(row.code).toBe(LIBRARY_UNAVAILABLE_CODE);
    expect(row.severity).toBe('warning');
    expect(row.quiet).toBe(true);
    expect(row.title).toContain("Library 'SharedConveyors' is not available (folder access lapsed)");
    expect(row.detail).toContain('SharedConveyors');
    expect(row.detail).toContain('Allow on every visit');
    expect(row.action).toEqual({ label: 'Grant', commandId: 'library.grant', args: { projectId: 'prj_b' } });
    e.uninstall();
  });

  it('Grant reaches requestPermission({mode:"read"}) synchronously, then the library is ready and the row gone', async () => {
    const e = env();
    const dir = lockedFolder(e, 'prj_b', 'SharedConveyors');
    e.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await e.loader.whenSettled();

    const pending = e.registry.execute('library.grant', { projectId: 'prj_b' }, { origin: 'ui', viewer: VIEWER });
    // Same tick as the click: the request was made before anything awaited.
    expect(dir.requestPermissionCalls).toBe(1);
    expect(dir.permissions.readwrite).not.toBe('granted');   // READ only (Decision 3)
    const r = await pending;
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await e.loader.whenSettled();
    expect(e.loader.getNode('prj_b')!.state.kind).toBe('ready');
    expect(getProblem(libraryUnavailableProblemId('prj_b'))).toBeUndefined();
    e.uninstall();
  });

  it('a Grant whose requestPermission throws SecurityError (activation spent) keeps the row and says so', async () => {
    const e = env();
    const dir = lockedFolder(e, 'prj_b', 'SharedConveyors');
    dir.secondRequestInTickThrows = true;
    e.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await e.loader.whenSettled();

    // The project-open click already spent its activation on A's own folder …
    void dir.requestPermission({ mode: 'readwrite' });
    // … so a request in the same tick throws.
    const r = await e.registry.execute('library.grant', { projectId: 'prj_b' }, { origin: 'ui', viewer: VIEWER });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(GRANT_NEEDS_CLICK);
    expect(e.loader.getNode('prj_b')!.state.kind).toBe('locked');
    const row = getProblem(libraryUnavailableProblemId('prj_b'))!;
    expect(row.action?.commandId).toBe('library.grant');
    expect(row.detail).toContain(`Last attempt: ${GRANT_NEEDS_CLICK}`);
    e.uninstall();
  });

  it('a denied Grant keeps the row too', async () => {
    const e = env();
    const dir = lockedFolder(e, 'prj_b', 'SharedConveyors');
    dir.grantOnRequest = 'denied';
    e.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await e.loader.whenSettled();
    const r = await e.registry.execute('library.grant', { projectId: 'prj_b' }, { origin: 'ui', viewer: VIEWER });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(GRANT_DENIED);
    expect(getProblem(libraryUnavailableProblemId('prj_b'))?.detail).toContain('Last attempt');
    e.uninstall();
  });

  it('Grant is refused for a library that is not locked', async () => {
    const e = env();
    e.folders.set('prj_b', projectFolder('SharedConveyors', 'prj_b'));
    e.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await e.loader.whenSettled();
    const en = e.registry.enabled('library.grant', { projectId: 'prj_b' }, VIEWER);
    expect(en).not.toBe(true);
    e.uninstall();
  });
});

describe('plan-778 9.6 — unknown library → Locate folder…', () => {
  it('an unknown library offers Locate folder…, naming its hint and who needs it', async () => {
    const e = env();
    // B is ready and names C; C is unknown on this computer.
    e.folders.set('prj_b', projectFolder('SharedConveyors', 'prj_b', {
      libraries: [{ projectId: 'prj_motors', label: 'Motors', hint: 'Motors' }],
    }));
    e.loader.setProject(projectA([{ projectId: 'prj_b' }]));
    await e.loader.whenSettled();
    const row = getProblem(libraryUnavailableProblemId('prj_motors'))!;
    expect(row.title).toBe("Library 'Motors' (needed by SharedConveyors) is unknown on this computer");
    expect(row.detail).toContain('Hint: folder "Motors"');
    expect(row.action).toEqual({ label: 'Locate folder…', commandId: 'library.locate', args: { projectId: 'prj_motors' } });
    e.uninstall();
  });

  it('a folder of another project is refused with both names; the row stays', async () => {
    const e = env();
    e.loader.setProject(projectA([{ projectId: 'prj_motors', label: 'Motors' }]));
    await e.loader.whenSettled();
    e.nextPick = projectFolder('Pumps', 'prj_pumps', { name: 'Pumps' });

    const pending = e.registry.execute('library.locate', { projectId: 'prj_motors' }, { origin: 'ui', viewer: VIEWER });
    expect(e.pickerCalls).toBe(1);   // the picker was opened inside the click
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("This folder holds project 'Pumps' (prj_pumps), not 'Motors' (prj_motors).");
    expect(e.stored.size).toBe(0);
    expect(e.linkedRows).toEqual([]);
    const row = getProblem(libraryUnavailableProblemId('prj_motors'))!;
    expect(row.detail).toContain('prj_pumps');
    expect(row.detail).toContain('prj_motors');
    e.uninstall();
  });

  it('the right folder is linked (projectfolder:<id> + linked row), the loader finds it, the row leaves', async () => {
    const e = env();
    e.loader.setProject(projectA([{ projectId: 'prj_motors', label: 'Motors' }]));
    await e.loader.whenSettled();
    expect(e.loader.getNode('prj_motors')!.state.kind).toBe('unknown');
    e.nextPick = projectFolder('Motors-2026', 'prj_motors', { name: 'Motors' });

    const r = await e.registry.execute('library.locate', { projectId: 'prj_motors' }, { origin: 'ui', viewer: VIEWER });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect([...e.stored.keys()]).toEqual(['projectfolder:prj_motors']);
    expect(e.linkedRows).toEqual([{ id: 'prj_motors', name: 'Motors', folderName: 'Motors-2026', opened: false }]);
    await e.loader.whenSettled();
    const n = e.loader.getNode('prj_motors')!;
    expect(n.state.kind === 'ready' && n.state.via).toBe('folder');
    expect(getProblem(libraryUnavailableProblemId('prj_motors'))).toBeUndefined();
    e.uninstall();
  });

  it('a dismissed picker changes nothing', async () => {
    const e = env();
    e.loader.setProject(projectA([{ projectId: 'prj_motors' }]));
    await e.loader.whenSettled();
    const r = await e.registry.execute('library.locate', { projectId: 'prj_motors' }, { origin: 'ui', viewer: VIEWER });
    expect(r.ok && (r.value as { cancelled?: boolean }).cancelled).toBe(true);
    expect(getProblem(libraryUnavailableProblemId('prj_motors'))?.detail).not.toContain('Last attempt');
    e.uninstall();
  });

  it('locateProjectFolder: unreadable / mismatch / ok', async () => {
    expect((await locateProjectFolder('prj_x', asDirHandle(new FakeDir('Empty')))).kind).toBe('unreadable');
    const other = await locateProjectFolder('prj_x', asDirHandle(projectFolder('Y', 'prj_y', { name: 'Y' })), 'X');
    expect(other.kind === 'mismatch' && other.message).toBe("This folder holds project 'Y' (prj_y), not 'X' (prj_x).");
    expect((await locateProjectFolder('prj_x', asDirHandle(projectFolder('X', 'prj_x')))).kind).toBe('ok');
  });
});

describe('plan-778 9.6 — lifecycle and summary line', () => {
  it('one summary line per project open, after the libraries settled; rows leave with the project', async () => {
    const e = env();
    lockedFolder(e, 'prj_b', 'SharedConveyors');
    e.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await e.loader.whenSettled();
    expect(getProblems().filter((p) => p.code === LIBRARY_UNAVAILABLE_CODE)).toHaveLength(2);
    expect(getProblemsAnnouncement()).toMatchObject({
      key: 'library-unavailable:prj_a', message: '2 libraries unavailable', code: LIBRARY_UNAVAILABLE_CODE,
    });

    // Project closed: the loader keeps only the built-in node, the rows go, the line goes.
    e.projectId = null;
    e.loader.setProject(null);
    await e.loader.whenSettled();
    expect(getProblems().filter((p) => p.code === LIBRARY_UNAVAILABLE_CODE)).toEqual([]);
    expect(getProblemsAnnouncement()).toBeNull();
    e.uninstall();
  });

  it('the summary line\'s Show opens the Problems panel filtered to library rows', async () => {
    reportProblem({ id: 'other', severity: 'warning', code: 'missing-reference', title: 'Other', detail: 'd' });
    reportProblem({ id: libraryUnavailableProblemId('prj_b'), severity: 'warning', code: LIBRARY_UNAVAILABLE_CODE, title: 'Lib B', detail: 'd', quiet: true });
    announceProblems({ key: 'library-unavailable:prj_a', message: '1 library unavailable', code: LIBRARY_UNAVAILABLE_CODE });
    setProblemsPanelOpen(false);
    render(createElement(ThemeProvider, { theme: rvDarkTheme }, createElement(ProblemsPanel)));
    expect((await screen.findByTestId('problems-announcement')).textContent).toBe('1 library unavailable');
    await act(async () => { fireEvent.click(screen.getByTestId('problems-announcement-show')); });
    expect(getProblemsFilterForTests()).toBe(LIBRARY_UNAVAILABLE_CODE);
    expect((await screen.findByTestId('problems-filter')).textContent).toContain('Showing 1 of 2');
    const codes = [...document.querySelectorAll('[data-problem-code]')].map((n) => n.getAttribute('data-problem-code'));
    expect(codes).toEqual([LIBRARY_UNAVAILABLE_CODE]);
    // Closing drops the filter.
    act(() => { setProblemsPanelOpen(false); });
    expect(getProblemsFilterForTests()).toBeNull();
    cleanup();
  });

  it('the built-in realvirtual library while unlisted is nobody\'s problem', async () => {
    const e = env();
    e.loader.setProject(projectA([]));
    await e.loader.whenSettled();
    expect(getProblems().filter((p) => p.code === LIBRARY_UNAVAILABLE_CODE)).toEqual([]);
    expect(getProblemsAnnouncement()).toBeNull();
    e.uninstall();
  });
});

describe('plan-778 review U4 / U8', () => {
  it('U4: the built-in realvirtual library offers no Locate (row, badge, command, list row)', async () => {
    const e = env();
    e.loader.setProject(projectA([{ projectId: REALVIRTUAL_LIBRARY_PROJECT_ID }]));
    await e.loader.whenSettled();
    // builtinBaseUrl → null and nothing linked: the built-in node is unknown here.
    expect(e.loader.getNode(REALVIRTUAL_LIBRARY_PROJECT_ID)!.state.kind).toBe('unknown');
    const row = getProblem(libraryUnavailableProblemId(REALVIRTUAL_LIBRARY_PROJECT_ID))!;
    expect(row.action).toBeUndefined();
    expect(row.detail).toContain(LOCATE_BUILTIN);
    expect(locateRefusal(REALVIRTUAL_LIBRARY_PROJECT_ID)).toBe(LOCATE_BUILTIN);
    expect(libraryStateBadge('error', REALVIRTUAL_LIBRARY_PROJECT_ID).repairCommand).toBeNull();
    expect(libraryStateBadge('error', 'prj_b').repairCommand).toBe('library.locate');
    expect(listLibraryProjectRows(e.loader).find((r) => r.projectId === REALVIRTUAL_LIBRARY_PROJECT_ID)!.repair).toBeNull();
    e.uninstall();
  });

  it('U8: the summary line follows the count, and a dismissed line shows again when the project is opened again', async () => {
    const e = env();
    const b = lockedFolder(e, 'prj_b', 'SharedConveyors');
    lockedFolder(e, 'prj_c', 'Motors');
    e.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await e.loader.whenSettled();
    const first = getProblemsAnnouncement()!;
    expect(first.message).toBe('2 libraries unavailable');

    // One of two granted → the line says 1.
    b.permissions.read = 'granted';
    e.loader.invalidate('prj_b');
    await e.loader.whenSettled();
    expect(getProblemsAnnouncement()!.message).toBe('1 library unavailable');

    // Close and open the same project: the same line is a NEW announcement (new seq).
    const before = getProblemsAnnouncement()!.seq;
    e.projectId = null;
    e.loader.setProject(null);
    await e.loader.whenSettled();
    b.permissions.read = 'prompt';
    e.loader.invalidate('prj_b');
    e.projectId = 'prj_a';
    e.loader.setProject(projectA([{ projectId: 'prj_b' }, { projectId: 'prj_c' }]));
    await e.loader.whenSettled();
    const again = getProblemsAnnouncement()!;
    expect(again.message).toBe('2 libraries unavailable');
    expect(again.seq).not.toBe(before);
    expect(again.seq).not.toBe(first.seq);
    e.uninstall();
  });

  it('U8: a dismissed line is shown again for a NEW announcement with the same key and text', async () => {
    announceProblems({ key: 'library-unavailable:prj_a', message: '1 library unavailable', code: LIBRARY_UNAVAILABLE_CODE });
    render(createElement(ThemeProvider, { theme: rvDarkTheme }, createElement(ProblemsPanel)));
    await screen.findByTestId('problems-announcement');
    await act(async () => { fireEvent.click(screen.getByLabelText('Dismiss')); });
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByTestId('problems-announcement')).toBeNull();
    act(() => { withdrawProblemsAnnouncement(); });
    act(() => { announceProblems({ key: 'library-unavailable:prj_a', message: '1 library unavailable', code: LIBRARY_UNAVAILABLE_CODE }); });
    expect((await screen.findByTestId('problems-announcement')).textContent).toBe('1 library unavailable');
    cleanup();
  });
});
