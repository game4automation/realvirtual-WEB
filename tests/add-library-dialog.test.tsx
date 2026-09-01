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

import { AddLibraryDialog } from '../src/core/library/AddLibraryDialog';

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
