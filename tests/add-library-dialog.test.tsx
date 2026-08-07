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
  addLocalFolder: vi.fn(async () => {}),
  localFolderSupported: true,
}));

vi.mock('../src/core/library/library-store-singleton', () => ({
  getLibraryStore: () => ({
    addCatalog: h.addCatalog,
    addLocalFolder: h.addLocalFolder,
    get isLocalFolderSupported() { return h.localFolderSupported; },
  }),
}));

import { AddLibraryDialog } from '../src/core/library/AddLibraryDialog';

beforeEach(() => {
  h.addCatalog.mockReset();
  h.addCatalog.mockResolvedValue(undefined);
  h.addLocalFolder.mockReset();
  h.addLocalFolder.mockResolvedValue(undefined);
  h.localFolderSupported = true;
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

  it('hides the Local Folder tab where the API is unavailable', () => {
    h.localFolderSupported = false;
    render(<AddLibraryDialog open onClose={() => {}} />);
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

  it('shows the failure instead of closing on it', async () => {
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
