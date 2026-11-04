// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AddLibraryDialog — the shared "subscribe to a library" dialog
 * (plan-372 Phase 8).
 *
 * Two contracts matter beyond the happy path. The Asset Manager tab is
 * *injected*: a public build must not import the private extension, so the tab
 * only exists when a caller supplies the connect callback. And a failed add is
 * shown, never swallowed — a library that silently fails to appear is
 * indistinguishable from one the user mistyped.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  addCatalog: vi.fn(async (_url: string, _origin?: string) => {}),
  removeCatalog: vi.fn((_url: string) => {}),
  // `addCatalog` RESOLVES on a failed fetch and records the reason here, so
  // the double has to offer the same channel — a store that only ever
  // rejects would keep the dialog passing while the real one fails silently.
  catalogErrors: new Map<string, string>(),
  catalogUrls: [] as string[],
}));

vi.mock('../src/core/library/library-store-singleton', () => ({
  getLibraryStore: () => ({
    addCatalog: h.addCatalog,
    removeCatalog: h.removeCatalog,
    get catalogErrors() { return h.catalogErrors; },
    get catalogUrls() { return h.catalogUrls; },
  }),
}));

import { AddLibraryDialog, type AddLibraryProjectsOptions } from '../src/core/library/AddLibraryDialog';

beforeEach(() => {
  h.addCatalog.mockReset();
  h.addCatalog.mockResolvedValue(undefined);
  h.removeCatalog.mockReset();
  h.catalogErrors.clear();
  h.catalogUrls.length = 0;
});
afterEach(() => cleanup());

describe('tabs on offer', () => {
  it('hides the Asset Manager tab when no connect callback is supplied', () => {
    render(<AddLibraryDialog open onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: /asset manager/i })).toBeNull();
  });

  it('shows it once a caller injects the private extension', () => {
    render(<AddLibraryDialog open onClose={() => {}} onConnectAssetManager={() => 'id'} />);
    expect(screen.getByRole('tab', { name: /asset manager/i })).toBeTruthy();
  });

  // The Local Folder tab went with the working folder (plan-709 §2.6): a
  // library on this machine is a PROJECT now, opened from Projects.
  it('offers no Local Folder tab any more', () => {
    render(<AddLibraryDialog open onClose={() => {}} onConnectAssetManager={() => 'id'} />);
    expect(screen.queryByRole('tab', { name: /local folder/i })).toBeNull();
  });
});

describe('adding by URL', () => {
  it('records the subscription as user origin — the only one persisted globally', async () => {
    const onClose = vi.fn();
    const onAdded = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAdded={onAdded} />);

    fireEvent.change(screen.getByLabelText('Catalog URL'), { target: { value: ' https://x/catalog.json ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(h.addCatalog).toHaveBeenCalledWith('https://x/catalog.json', 'user'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdded).toHaveBeenCalledWith('https://x/catalog.json');
  });

  it('keeps Add disabled until something is typed', () => {
    render(<AddLibraryDialog open onClose={() => {}} />);
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // The case the dialog actually meets in the field. `addCatalog` resolves;
  // the reason is in `catalogErrors`. Before this was read, a 404, a
  // rate-limited GitHub API or a repo without .glb files closed the dialog
  // as if the add had worked and left an empty root in the tree.
  it('shows a RECORDED failure and leaves no phantom subscription', async () => {
    h.addCatalog.mockImplementation(async (url: string) => {
      h.catalogUrls.push(url);
      h.catalogErrors.set(url, 'GitHub API rate limit reached — try again later');
    });
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Catalog URL'), { target: { value: 'https://x/rate-limited.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText(/rate limit reached/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(h.removeCatalog).toHaveBeenCalledWith('https://x/rate-limited.json');
  });

  // Re-adding a catalog that is already attached must not detach it just
  // because this attempt could not reach the network.
  it('keeps an already-attached catalog when a re-add fails', async () => {
    h.catalogUrls.push('https://x/known.json');
    h.addCatalog.mockImplementation(async (url: string) => {
      h.catalogErrors.set(url, 'HTTP 503');
    });
    render(<AddLibraryDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Catalog URL'), { target: { value: 'https://x/known.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('HTTP 503')).toBeTruthy());
    expect(h.removeCatalog).not.toHaveBeenCalled();
  });

  it('shows a THROWN failure instead of closing on it', async () => {
    h.addCatalog.mockRejectedValue(new Error('404 Not Found'));
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Catalog URL'), { target: { value: 'https://x/bad.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText('404 Not Found')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('adding from GitHub', () => {
  it('goes through the same addCatalog path — it auto-detects a repo URL', async () => {
    render(<AddLibraryDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /github/i }));
    fireEvent.change(screen.getByLabelText('GitHub URL'), { target: { value: 'https://github.com/a/b' } });
    fireEvent.click(screen.getByRole('button', { name: /scan & add/i }));
    await waitFor(() => expect(h.addCatalog).toHaveBeenCalledWith('https://github.com/a/b', 'user'));
  });
});

// The Projects dashboard lands a library in the OPEN PROJECT, never in the
// browser-global list: the URL goes into `project.json.libraries[]` so it
// travels with the project. The dialog itself only has to honour the seam.
describe('attaching somewhere other than the global list', () => {
  it('routes a typed URL through onAttach and never touches the store', async () => {
    const onAttach = vi.fn(async () => null);
    const onClose = vi.fn();
    const onAdded = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAdded={onAdded} onAttach={onAttach} />);

    fireEvent.change(screen.getByLabelText('Catalog URL'), { target: { value: ' https://x/catalog.json ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onAttach).toHaveBeenCalledWith('https://x/catalog.json'));
    expect(h.addCatalog).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onAdded).toHaveBeenCalledWith('https://x/catalog.json');
  });

  it('takes the GitHub tab down the same seam', async () => {
    const onAttach = vi.fn(async () => null);
    render(<AddLibraryDialog open onClose={() => {}} onAttach={onAttach} />);

    fireEvent.click(screen.getByRole('tab', { name: /github/i }));
    fireEvent.change(screen.getByLabelText('GitHub URL'), { target: { value: 'https://github.com/a/b' } });
    fireEvent.click(screen.getByRole('button', { name: /scan & add/i }));

    await waitFor(() => expect(onAttach).toHaveBeenCalledWith('https://github.com/a/b'));
    expect(h.addCatalog).not.toHaveBeenCalled();
  });

  // A read-only project, a 404, a rate-limited scan: the attach returns why,
  // and the dialog stays open with it rather than closing on a no-op.
  it('stays open and shows the reason the attach refused', async () => {
    const onAttach = vi.fn(async () => 'This project is read-only, so a library cannot be added to it.');
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAttach={onAttach} />);

    fireEvent.change(screen.getByLabelText('Catalog URL'), { target: { value: 'https://x/catalog.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText(/read-only/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says where the library will land when the caller supplies a hint', () => {
    render(<AddLibraryDialog open onClose={() => {}} attachHint="Added to this project." />);
    expect(screen.getByText('Added to this project.')).toBeTruthy();
  });
});

describe('Asset Manager', () => {
  it('passes the typed credentials to the injected callback', async () => {
    const connect = vi.fn(() => 'conn-1');
    const onAdded = vi.fn();
    render(<AddLibraryDialog open onClose={() => {}} onAdded={onAdded} onConnectAssetManager={connect} />);

    fireEvent.click(screen.getByRole('tab', { name: /asset manager/i }));
    fireEvent.change(screen.getByLabelText(/Project ID/), { target: { value: 'proj' } });
    fireEvent.change(screen.getByLabelText(/Service Account Key ID/), { target: { value: 'key' } });
    fireEvent.change(screen.getByLabelText(/Secret Key/), { target: { value: 'sec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj', keyId: 'key', secretKey: 'sec',
    }));
    expect(onAdded).toHaveBeenCalledWith('conn-1');
  });

  it('stays disabled until every required credential is present', () => {
    render(<AddLibraryDialog open onClose={() => {}} onConnectAssetManager={() => 'x'} />);
    fireEvent.click(screen.getByRole('tab', { name: /asset manager/i }));
    const connect = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Project ID/), { target: { value: 'proj' } });
    expect(connect.disabled).toBe(true);
  });
});

// ─── plan-778 9.8 — the Projects tab: another project as a library, by id ───

describe('plan-778 — Projects tab', () => {
  const CANDIDATES = [
    { id: 'prj_realvirtual_library', name: 'realvirtual Library', location: 'bundled' as const },
    { id: 'prj_a', name: 'Open Project', location: 'folder' as const, hint: 'A' },
    { id: 'prj_shared', name: 'SharedConveyors', location: 'folder' as const, hint: 'SharedConveyors' },
    { id: 'prj_cx', name: 'CustomerX Machines', location: 'browser' as const },
  ];
  function opts(over: Partial<AddLibraryProjectsOptions> = {}): AddLibraryProjectsOptions {
    return {
      openProjectId: 'prj_a',
      attachedIds: ['prj_realvirtual_library'],
      attach: vi.fn(async () => null),
      listCandidates: async () => CANDIDATES,
      directoryPicker: null,
      ...over,
    };
  }

  it('is absent without a project target, and the first (default) tab with one', () => {
    const { unmount } = render(<AddLibraryDialog open onClose={() => {}} />);
    expect(screen.queryByRole('tab', { name: /projects/i })).toBeNull();
    unmount();
    render(<AddLibraryDialog open onClose={() => {}} projects={opts()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].textContent).toMatch(/projects/i);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('lists the known projects, excludes the open one, greys the attached ones', async () => {
    render(<AddLibraryDialog open onClose={() => {}} projects={opts()} />);
    await waitFor(() => expect(document.querySelector('[data-project-id="prj_shared"]')).toBeTruthy());
    const ids = [...document.querySelectorAll('[data-project-id]')].map((n) => n.getAttribute('data-project-id'));
    expect(ids).toEqual(['prj_realvirtual_library', 'prj_shared', 'prj_cx']);
    const attached = document.querySelector('[data-project-id="prj_realvirtual_library"]')!;
    expect(attached.getAttribute('aria-disabled')).toBe('true');
    expect(attached.textContent).toContain('(attached)');
    // Clicking an attached row selects nothing — Add stays disabled.
    fireEvent.click(attached);
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Add attaches the picked project by id, with its name as label and its folder as hint', async () => {
    const attach = vi.fn(async () => null);
    const onAdded = vi.fn();
    render(<AddLibraryDialog open onClose={() => {}} onAdded={onAdded} projects={opts({ attach })} />);
    await waitFor(() => expect(document.querySelector('[data-project-id="prj_shared"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-project-id="prj_shared"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(attach).toHaveBeenCalledWith({ projectId: 'prj_shared', label: 'SharedConveyors', hint: 'SharedConveyors' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('prj_shared'));
    expect(h.addCatalog).not.toHaveBeenCalled();
  });

  it('From URL… reads the hosted project.json and attaches by its id with the URL as hint', async () => {
    const attach = vi.fn(async () => null);
    const readUrl = vi.fn(async (url: string) => ({ ok: true as const, id: 'prj_hosted', name: 'Hosted Lib', hint: url }));
    render(<AddLibraryDialog open onClose={() => {}} projects={opts({ attach, readUrl })} />);
    fireEvent.click(screen.getByRole('button', { name: /from url/i }));
    fireEvent.change(screen.getByLabelText('Project URL'), { target: { value: ' https://cdn/libs/hosted/project.json ' } });
    fireEvent.click(screen.getByRole('button', { name: /add from url/i }));
    await waitFor(() => expect(readUrl).toHaveBeenCalledWith('https://cdn/libs/hosted/project.json'));
    await waitFor(() => expect(attach).toHaveBeenCalledWith({
      projectId: 'prj_hosted', label: 'Hosted Lib', hint: 'https://cdn/libs/hosted/project.json',
    }));
  });

  it('From URL… of the open project itself is refused', async () => {
    const attach = vi.fn(async () => null);
    const readUrl = vi.fn(async (url: string) => ({ ok: true as const, id: 'prj_a', name: 'Open Project', hint: url }));
    render(<AddLibraryDialog open onClose={() => {}} projects={opts({ attach, readUrl })} />);
    fireEvent.click(screen.getByRole('button', { name: /from url/i }));
    fireEvent.change(screen.getByLabelText('Project URL'), { target: { value: 'https://cdn/a/project.json' } });
    fireEvent.click(screen.getByRole('button', { name: /add from url/i }));
    await waitFor(() => expect(screen.getByText(/cannot be a library of itself/)).toBeTruthy());
    expect(attach).not.toHaveBeenCalled();
  });

  it('Link folder… is hidden without showDirectoryPicker, and opens the picker inside the click with it', async () => {
    const { unmount } = render(<AddLibraryDialog open onClose={() => {}} projects={opts({ directoryPicker: null })} />);
    expect(screen.queryByRole('button', { name: /link folder/i })).toBeNull();
    unmount();

    const attach = vi.fn(async () => null);
    let picks = 0;
    const dir = { name: 'SharedConveyors' } as unknown as FileSystemDirectoryHandle;
    const linkFolder = vi.fn(async () => ({ ok: true as const, id: 'prj_shared', name: 'SharedConveyors', hint: 'SharedConveyors' }));
    render(<AddLibraryDialog open onClose={() => {}} projects={opts({
      attach, linkFolder, directoryPicker: () => { picks++; return Promise.resolve(dir); },
    })} />);
    fireEvent.click(screen.getByRole('button', { name: /link folder/i }));
    expect(picks).toBe(1);   // synchronous — inside the click's user activation
    await waitFor(() => expect(linkFolder).toHaveBeenCalledWith(dir));
    await waitFor(() => expect(attach).toHaveBeenCalledWith({ projectId: 'prj_shared', label: 'SharedConveyors', hint: 'SharedConveyors' }));
  });
});

describe('plan-778 review U3 / U7', () => {
  it('U7: a fresh listCandidates function per render does not re-list (no render loop)', async () => {
    let calls = 0;
    const make = (): AddLibraryProjectsOptions => ({
      openProjectId: 'prj_a',
      attachedIds: [],
      attach: async () => null,
      listCandidates: async () => { calls++; return []; },
      directoryPicker: null,
    });
    const { rerender } = render(<AddLibraryDialog open onClose={() => {}} projects={make()} />);
    await waitFor(() => expect(calls).toBe(1));
    for (let i = 0; i < 3; i++) rerender(<AddLibraryDialog open onClose={() => {}} projects={make()} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it('U3: Link folder of the OPEN project is refused before anything is stored; another folder links through Locate\'s sequence (invalidate)', async () => {
    const { linkLibraryFolder } = await import('../src/core/library/library-project-candidates');
    const { setLibraryAvailabilityDepsForTests, resetLibraryAvailabilityForTests } = await import('../src/core/library/library-availability');
    const { FakeDir, asDirHandle } = await import('./helpers/fake-fs-handles');
    const folder = (id: string): FileSystemDirectoryHandle => {
      const d = new FakeDir(id);
      d.seedText('project.json', JSON.stringify({ schemaVersion: 2, id, name: id, canonicalName: id, documents: [] }));
      return asDirHandle(d);
    };
    const stored: string[] = [];
    const invalidated: string[] = [];
    setLibraryAvailabilityDepsForTests({
      putHandle: async (_dir, key) => { stored.push(key); },
      recordLinkedProject: () => {},
      loader: () => ({ getNode: () => null, invalidate: (id: string) => { invalidated.push(id); } }) as never,
    });
    try {
      const self = await linkLibraryFolder(folder('prj_a'), 'prj_a');
      expect(self.ok).toBe(false);
      if (!self.ok) expect(self.reason).toMatch(/cannot be a library of itself/);
      expect(stored).toEqual([]);

      const other = await linkLibraryFolder(folder('prj_b'), 'prj_a');
      expect(other.ok).toBe(true);
      expect(stored).toEqual(['projectfolder:prj_b']);
      expect(invalidated).toEqual(['prj_b']);
    } finally {
      resetLibraryAvailabilityForTests();
    }
  });
});
