// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.5 — the linked-projects dashboard (plan-743, Phases 3 and 4).
 *
 * ## Why the host is not mounted
 *
 * `ProjectsDashboardHost.tsx` says so itself, at the import of
 * `dashboard-documents`: *"They live in their own module because this file
 * cannot be rendered by a test."* It pulls the project store, the library
 * registry, the scene store, the viewer and the private asset editor. So this
 * file follows the pattern `projects-rename-host.test.tsx` established — with
 * one improvement plan-743 makes possible: the host's new RULES were extracted
 * into `linked-project-verbs.ts` rather than reproduced here, so what is
 * asserted below is the production code, not a copy of it. Only the React
 * plumbing between a rule and a row is re-stated.
 *
 * What is rendered for real: `ProjectsList` (every row state, the empty state,
 * the no-File-System-Access state) and `NewProjectDialog`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';

// ─── The handle store, faked ────────────────────────────────────────────
//
// IndexedDB cannot hold a fake handle (structured clone rejects an object with
// methods), and `isSameEntry` has to be a method for the duplicate guard to
// work at all. So the store is the seam.

const HANDLES = new Map<string, FileSystemDirectoryHandle>();
/** Grant answers per handle key — what `queryPermission` would report. */
const GRANTS = new Map<string, PermissionState>();
/** Keys whose `requestPermission` the user refuses. */
const REFUSED = new Set<string>();
const requestSpy = vi.fn<(key: string) => void>();
const querySpy = vi.fn<(key: string) => void>();

// Spread the real module and override only the handle store: other importers
// (rv-project-storage, the tree sources) pull file helpers from here, and a
// factory that replaced the whole module would break their imports.
vi.mock('../src/core/engine/rv-local-filesystem', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/engine/rv-local-filesystem')>(),
  isSupported: () => SUPPORTED.value,
  projectHandleKey: (id: string) => `projectfolder:${id}`,
  listHandleKeys: async () => [...HANDLES.keys()],
  getHandle: async (key: string) => {
    const h = HANDLES.get(key);
    if (!h) return null;
    // The lock icon comes from `queryPermission` on the handle itself, so the
    // fake store has to hand back something that answers it.
    return Object.assign(h, {
      queryPermission: async () => { querySpy(key); return GRANTS.get(key) ?? 'granted'; },
    });
  },
  putHandle: async (h: FileSystemDirectoryHandle, key: string) => { HANDLES.set(key, h); },
  deleteStoredHandle: async (key: string) => { HANDLES.delete(key); GRANTS.delete(key); },
  getFolderHandle: async (key: string, opts?: { prompt?: boolean }) => {
    const h = HANDLES.get(key);
    if (!h) return null;
    const state = GRANTS.get(key) ?? 'granted';
    if (state === 'granted') return h;
    if (!opts?.prompt) return null;
    requestSpy(key);
    return REFUSED.has(key) ? null : h;
  },
  selectFolderForKey: async () => PICKED.value,
  HANDLE_KEY_NEW_PROJECT_PARENT: 'newprojectparent',
}));

/** Feature detection, flipped per test. */
const SUPPORTED = { value: true };
/** What the folder picker returns next. */
const PICKED: { value: FileSystemDirectoryHandle | null } = { value: null };

const {
  LS_KEY_LINKED_PROJECTS,
  listLinkedProjects,
  readLinkedProjects,
  recordLinkedProject,
  relinkProject,
  unlinkProject,
} = await import('../src/core/project/rv-project-linked');
const {
  firstDirectoryHandle,
  collectDropHandles,
  isInternalDrag,
  linkChildProjects,
  resolveLinkedOpen,
  summariseParentAdd,
  verdictForAdd,
} = await import('../src/core/hmi/projects/linked-project-verbs');
const { ProjectsList } = await import('../src/core/hmi/projects/ProjectsList');
const { NewProjectDialog } = await import('../src/core/hmi/projects/NewProjectDialog');
const { putHandle, projectHandleKey } =
  await import('../src/core/engine/rv-local-filesystem');
const { DEMO_PROJECT_ID, DEMO_PROJECT_NAME } =
  await import('../src/core/project/backends/bundled-backend');

// ─── Fixtures ───────────────────────────────────────────────────────────

const manifestJson = (id: string, name: string) => JSON.stringify({
  schemaVersion: 2, id, name, canonicalName: name.toLowerCase(), documents: [],
});

/** A folder that IS a project. */
function projectDir(folder: string, id: string, name = folder): FakeDir {
  const dir = new FakeDir(folder);
  dir.seedText('project.json', manifestJson(id, name));
  return dir;
}

async function link(id: string, dir: FakeDir, name = dir.name): Promise<void> {
  await putHandle(asDirHandle(dir), projectHandleKey(id));
  recordLinkedProject({ id, name, slug: name.toLowerCase(), folderName: dir.name, opened: true });
}

const noop = () => {};
const listProps = {
  activeProjectId: null,
  modeLocked: false,
  onOpenProject: noop,
  onAdd: noop,
  onNew: noop,
  onLocate: noop,
  onRemove: noop,
  onRenameProject: noop,
  onDeleteProject: noop,
};

beforeEach(() => {
  HANDLES.clear();
  GRANTS.clear();
  REFUSED.clear();
  requestSpy.mockClear();
  querySpy.mockClear();
  SUPPORTED.value = true;
  PICKED.value = null;
  localStorage.removeItem(LS_KEY_LINKED_PROJECTS);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ─── Listing never spends a permission ──────────────────────────────────

describe('permission timing (F5)', () => {
  it('listing the projects never calls requestPermission', async () => {
    await link('p_a', projectDir('LineA', 'p_a'));
    GRANTS.set(projectHandleKey('p_a'), 'prompt');

    const rows = await listLinkedProjects();

    expect(rows.map(r => r.id)).toContain('p_a');
    // The whole point of the four row states: a lapsed grant is listed, not
    // hidden and not prompted for.
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('opening a row prompts exactly once', async () => {
    await link('p_a', projectDir('LineA', 'p_a'));
    GRANTS.set(projectHandleKey('p_a'), 'prompt');

    const result = await resolveLinkedOpen('p_a');

    expect(result.kind).toBe('ready');
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('a refused grant is `denied`, and the dashboard stays', async () => {
    await link('p_a', projectDir('LineA', 'p_a'));
    GRANTS.set(projectHandleKey('p_a'), 'prompt');
    REFUSED.add(projectHandleKey('p_a'));

    expect((await resolveLinkedOpen('p_a')).kind).toBe('denied');
  });

  it('a missing handle is `missing`, NOT `denied`', async () => {
    recordLinkedProject({ id: 'p_ghost', name: 'Ghost' });   // row, no handle
    // The two answers send the user to different verbs; `getFolderHandle`
    // answers null for both, which is why the handle is looked up first.
    expect((await resolveLinkedOpen('p_ghost')).kind).toBe('missing');
  });

  it('a folder replaced by a file reads as `missing` (TypeMismatchError)', async () => {
    const parent = new FakeDir('parent');
    parent.seedText('project.json', 'x');       // makes readManifest throw nothing…
    const gone = new FakeDir('Gone');
    await putHandle(asDirHandle(gone), projectHandleKey('p_gone'));
    recordLinkedProject({ id: 'p_gone', name: 'Gone' });
    vi.spyOn(gone, 'getFileHandle').mockRejectedValue(
      Object.assign(new Error('is a directory'), { name: 'TypeMismatchError' }));

    expect((await resolveLinkedOpen('p_gone')).kind).toBe('missing');
  });
});

// ─── Add ────────────────────────────────────────────────────────────────

describe('Add (F2)', () => {
  it('a copied project folder under a linked id is flagged, never silently taken', async () => {
    const original = projectDir('LineA', 'p_a');
    await link('p_a', original);
    const copy = projectDir('LineA - Copy', 'p_a', 'LineA');

    const verdict = await verdictForAdd(asDirHandle(copy), readLinkedProjects());

    expect(verdict.kind).toBe('project');
    expect(verdict.duplicateOfOtherFolder).toBe(true);
    // The handle still points at the original: the guard reports, it does not act.
    expect(HANDLES.get(projectHandleKey('p_a'))).toBe(asDirHandle(original));
  });

  it('re-adding the SAME folder is not a duplicate', async () => {
    const dir = projectDir('LineA', 'p_a');
    await link('p_a', dir);

    const verdict = await verdictForAdd(asDirHandle(dir), readLinkedProjects());

    expect(verdict.duplicateOfOtherFolder).toBe(false);
  });

  it('a parent links every child and skips duplicates with a named toast', async () => {
    const existing = projectDir('Elsewhere', 'p_b');
    await link('p_b', existing);

    const parent = new FakeDir('OldRoot');
    parent.seedDir('PlantA').seedText('project.json', manifestJson('p_a', 'PlantA'));
    // Same id as the already-linked `Elsewhere` — a copy sitting in the root.
    parent.seedDir('PlantB').seedText('project.json', manifestJson('p_b', 'PlantB'));
    parent.seedDir('Broken').seedText('project.json', '{ not json');

    const verdict = await verdictForAdd(asDirHandle(parent), readLinkedProjects());
    expect(verdict.kind).toBe('parent');

    const summary = await linkChildProjects(
      asDirHandle(parent), verdict.childProjects, readLinkedProjects());

    expect(summary.linked).toBe(1);
    expect(summary.duplicates).toEqual(['PlantB']);
    expect(summary.broken).toEqual(['Broken']);
    const said = summariseParentAdd(summary);
    expect(said).toContain('PlantB');
    expect(said).toContain('Broken');
  });

  it('writes nothing into the parent folder', async () => {
    const parent = new FakeDir('OldRoot');
    parent.seedDir('PlantA').seedText('project.json', manifestJson('p_a', 'PlantA'));
    const getFile = vi.spyOn(parent, 'getFileHandle');
    const getDir = vi.spyOn(parent, 'getDirectoryHandle');

    const verdict = await verdictForAdd(asDirHandle(parent), []);
    await linkChildProjects(asDirHandle(parent), verdict.childProjects, []);

    for (const spy of [getFile, getDir]) {
      for (const call of spy.mock.calls) {
        expect((call[1] as { create?: boolean } | undefined)?.create).not.toBe(true);
      }
    }
  });
});

// ─── Drop (F10) ─────────────────────────────────────────────────────────

describe('drop', () => {
  /** A DataTransferItem whose handle call answers once, like the real one. */
  const item = (handle: unknown) => ({
    kind: handle ? 'file' : 'string',
    getAsFileSystemHandle: async () => handle,
  }) as unknown as DataTransferItem;

  it('picks the dropped directory and ignores dropped files', async () => {
    const dir = projectDir('Dropped', 'p_d');
    const file = { kind: 'file', name: 'model.glb' };

    const found = await firstDirectoryHandle(
      collectDropHandles([item(file), item(asDirHandle(dir))]));

    expect(found).toBe(asDirHandle(dir));
  });

  it('survives an item whose handle call rejects', async () => {
    const bad = { getAsFileSystemHandle: () => Promise.reject(new Error('nope')) } as unknown as DataTransferItem;
    await expect(firstDirectoryHandle(collectDropHandles([bad]))).resolves.toBeNull();
  });

  it('yields to the dashboard own internal drags', () => {
    // The dashboard already carries CONNECT-config and knowledge-file drags;
    // Add must not steal a drop that means something else.
    expect(isInternalDrag(['application/x-rv-connect-config'],
      ['application/x-rv-connect-config', 'application/x-rv-knowledge'])).toBe(true);
    expect(isInternalDrag(['Files'],
      ['application/x-rv-connect-config', 'application/x-rv-knowledge'])).toBe(false);
  });
});

// ─── Locate / Remove (F6, F7) ───────────────────────────────────────────

describe('Locate and Remove', () => {
  it('locate with the same id replaces only the handle', async () => {
    const old = projectDir('LineA', 'p_a');
    await link('p_a', old);
    const before = readLinkedProjects()[0]!;
    const moved = projectDir('LineA-moved', 'p_a', 'LineA');

    await relinkProject('p_a', asDirHandle(moved));

    expect(readLinkedProjects()[0]).toEqual(before);
    expect(HANDLES.get(projectHandleKey('p_a'))).toBe(asDirHandle(moved));
  });

  it('remove drops the row AND the handle', async () => {
    await link('p_a', projectDir('LineA', 'p_a'));

    await unlinkProject('p_a');

    expect(readLinkedProjects()).toEqual([]);
    expect(HANDLES.has(projectHandleKey('p_a'))).toBe(false);
    expect(await listLinkedProjects()).toEqual([]);
  });
});

// ─── The list itself ────────────────────────────────────────────────────

describe('ProjectsList rendering', () => {
  it('shows a silent lock for needs-grant and sentences for denied/missing', () => {
    render(<ProjectsList
      {...listProps}
      rows={[
        { id: 'a', name: 'Locked', hint: 'local', state: 'needs-grant', canUnlink: true },
        { id: 'b', name: 'Refused', hint: 'local', state: 'denied', canUnlink: true },
        { id: 'c', name: 'Gone', hint: 'local', state: 'missing', canUnlink: true },
      ]}
    />);

    // needs-grant is the NORMAL state after a browser restart: an icon, no words.
    expect(screen.getByTestId('project-lock-a')).toBeTruthy();
    expect(screen.queryByTestId('project-lock-b')).toBeNull();
    expect(screen.getByText('Access to this folder was not granted')).toBeTruthy();
    expect(screen.getByText('Folder not found')).toBeTruthy();
    expect(screen.getByTestId('project-locate-c')).toBeTruthy();
    // Locate is offered ONLY where it can do something.
    expect(screen.queryByTestId('project-locate-a')).toBeNull();
  });

  // ─── T-UI-2 (plan-482 F5/F7) ───────────────────────────────────────────
  //
  // The badge claims horizontal room in the same zone as `OPEN` and next to a
  // text block that already carries a caption and, in three states, a whole
  // sentence. So it is not enough to prove the badge renders: every state that
  // needs extra room is checked WITH the badge in place, at a narrow width.

  it('shows the backend badge for each hint, without disturbing the caption', () => {
    render(<ProjectsList
      {...listProps}
      rows={[
        { id: 'a', name: 'Folder one', hint: 'local', caption: 'line3-projekt', canUnlink: true },
        { id: 'b', name: 'In browser', hint: 'browser', caption: 'prj_b' },
        { id: 'c', name: 'Demo', hint: 'bundled', caption: 'demo' },
      ]}
    />);

    expect(screen.getByTestId('project-backend-a').textContent).toBe('FOLDER');
    expect(screen.getByTestId('project-backend-b').textContent).toBe('BROWSER');
    expect(screen.getByTestId('project-backend-c').textContent).toBe('BUNDLED');
    // The caption keeps its own slot and its own text (F7).
    expect(screen.getByText('line3-projekt')).toBeTruthy();
    expect(screen.getByText('prj_b')).toBeTruthy();
  });

  it('keeps every row state legible beside the badge at a narrow width', () => {
    const { container } = render(<div style={{ width: '360px' }}><ProjectsList
      {...listProps}
      rows={[
        { id: 'a', name: 'Locked', hint: 'local', state: 'needs-grant', canUnlink: true },
        { id: 'b', name: 'Refused', hint: 'local', state: 'denied', canUnlink: true },
        { id: 'c', name: 'Gone', hint: 'local', state: 'missing', canUnlink: true },
        { id: 'd', name: 'Active', hint: 'browser' },
      ]}
      activeProjectId="d"
    /></div>);

    // needs-grant: badge AND lock, side by side, neither displacing the other.
    expect(screen.getByTestId('project-backend-a')).toBeTruthy();
    expect(screen.getByTestId('project-lock-a')).toBeTruthy();

    // denied / missing: the sentence is present and fully laid out, not clipped
    // away by the badge that shares the line above it.
    for (const text of ['Access to this folder was not granted', 'Folder not found']) {
      const node = screen.getByText(text);
      expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth);
    }

    // The active row carries OPEN and the badge together.
    expect(screen.getByTestId('project-backend-d')).toBeTruthy();
    expect(screen.getByText('OPEN')).toBeTruthy();

    // And no row overflows its card horizontally.
    for (const id of ['a', 'b', 'c', 'd']) {
      const row = screen.getByTestId(`project-row-${id}`);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  });

  it('offers Remove on linked rows and never on the bundled one', () => {
    const onRemove = vi.fn();
    render(<ProjectsList
      {...listProps}
      onRemove={onRemove}
      rows={[
        { id: DEMO_PROJECT_ID, name: DEMO_PROJECT_NAME, hint: 'bundled' },
        { id: 'a', name: 'Mine', hint: 'local', canUnlink: true },
      ]}
    />);

    // The verb lives in the kebab, not in a ✕ of its own, so it is reachable
    // only once the menu is open — and the bundled row has no kebab to open.
    expect(screen.queryByTestId('project-remove-a')).toBeNull();
    expect(screen.queryByLabelText(`Project actions for ${DEMO_PROJECT_NAME}`)).toBeNull();

    fireEvent.click(screen.getByLabelText('Project actions for Mine'));
    fireEvent.click(screen.getByTestId('project-remove-a'));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('routes Add and New from both the header and the empty state', () => {
    const onAdd = vi.fn();
    const onNew = vi.fn();
    render(<ProjectsList {...listProps} onAdd={onAdd} onNew={onNew} rows={[]} />);

    expect(screen.getByTestId('projects-empty').textContent)
      .toContain('Add a project folder or create a new one');
    fireEvent.click(screen.getByTestId('projects-add'));
    fireEvent.click(screen.getByTestId('projects-new-empty'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('hides both verbs and names the browser when the API is missing (F11)', () => {
    SUPPORTED.value = false;
    render(<ProjectsList {...listProps} rows={[]} />);

    expect(screen.queryByTestId('projects-add')).toBeNull();
    expect(screen.queryByTestId('projects-new')).toBeNull();
    expect(screen.getByTestId('projects-no-fsa').textContent)
      .toContain('Folder projects need Chrome or Edge');
  });
});

// ─── New project dialog (F4) ────────────────────────────────────────────

describe('NewProjectDialog', () => {
  it('keeps Create disabled until a name AND a location are given', async () => {
    render(<NewProjectDialog open onClose={noop} onCreate={noop} />);

    const create = () => screen.getByTestId('new-project-create') as HTMLButtonElement;
    expect(create().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Line B' } });
    // A name alone is not enough: there is no implied location any more.
    await waitFor(() => expect(create().disabled).toBe(true));

    PICKED.value = asDirHandle(new FakeDir('Projects'));
    fireEvent.click(screen.getByTestId('new-project-location'));
    await waitFor(() => expect(create().disabled).toBe(false));
  });

  it('previews the canonical folder name while it is still changeable', async () => {
    render(<NewProjectDialog open onClose={noop} onCreate={noop} />);
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Line B!' } });

    await waitFor(() => expect(screen.getByTestId('new-project-canonical').textContent)
      .toBe('folder: line-b'));
  });

  it('blocks Create when the folder already exists', async () => {
    const parent = new FakeDir('Projects');
    parent.seedDir('line-b');
    PICKED.value = asDirHandle(parent);

    render(<NewProjectDialog open onClose={noop} onCreate={noop} />);
    fireEvent.click(screen.getByTestId('new-project-location'));
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Line B' } });

    await waitFor(() => expect(screen.getByTestId('new-project-exists')).toBeTruthy());
    expect((screen.getByTestId('new-project-create') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hands the parent and the raw name to the caller', async () => {
    const parent = asDirHandle(new FakeDir('Projects'));
    PICKED.value = parent;
    const onCreate = vi.fn();

    render(<NewProjectDialog open onClose={noop} onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('new-project-location'));
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Line B' } });

    await waitFor(() =>
      expect((screen.getByTestId('new-project-create') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('new-project-create'));

    // The RAW name — the canonical one is the folder, the typed one is the
    // project's display name.
    expect(onCreate).toHaveBeenCalledWith(parent, 'Line B');
  });
});
