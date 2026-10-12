// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * runLegacyCleanup — retiring the workspace keys (plan-743 §9.2).
 *
 * Two properties matter and neither is about the deletion itself: what it does
 * NOT delete (the resume pair, which would cost the user their open project),
 * and that it cannot fail a boot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runLegacyCleanup } from '../src/core/project/rv-project-legacy-cleanup';
import {
  deleteStoredHandle,
  getHandle,
  projectHandleKey,
  putHandle,
} from '../src/core/engine/rv-local-filesystem';

const LS_WORKSPACE = 'rv-project/workspace';
const LS_RECENT = 'rv-project/recent';
const LS_LAST = 'rv-project/last';

const cloneableHandle = (name: string) =>
  ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle;

beforeEach(() => {
  localStorage.removeItem(LS_WORKSPACE);
  localStorage.removeItem(LS_RECENT);
  localStorage.removeItem(LS_LAST);
});

afterEach(async () => {
  // Before any localStorage call: one case makes `removeItem` throw, and the
  // cleanup must not inherit it.
  vi.restoreAllMocks();
  localStorage.removeItem(LS_WORKSPACE);
  localStorage.removeItem(LS_RECENT);
  localStorage.removeItem(LS_LAST);
  await deleteStoredHandle('workspace');
  await deleteStoredHandle(projectHandleKey('prj_keep'));
});

describe('runLegacyCleanup', () => {
  it('deletes the workspace handle and both retired localStorage keys', async () => {
    await putHandle(cloneableHandle('old-workspace'), 'workspace');
    localStorage.setItem(LS_WORKSPACE, JSON.stringify({ folderName: 'old-workspace' }));
    localStorage.setItem(LS_RECENT, JSON.stringify([{ id: 'prj_a', name: 'A' }]));

    await runLegacyCleanup();

    expect(await getHandle('workspace')).toBeNull();
    expect(localStorage.getItem(LS_WORKSPACE)).toBeNull();
    expect(localStorage.getItem(LS_RECENT)).toBeNull();
  });

  it('leaves the resume pair — rv-project/last and every projectfolder handle — alone', async () => {
    localStorage.setItem(LS_LAST, 'prj_keep');
    await putHandle(cloneableHandle('keep-folder'), projectHandleKey('prj_keep'));

    await runLegacyCleanup();

    // Losing either half would drop the user out of their project on the very
    // boot that installs the new list.
    expect(localStorage.getItem(LS_LAST)).toBe('prj_keep');
    expect((await getHandle(projectHandleKey('prj_keep')))?.name).toBe('keep-folder');
  });

  it('is a no-op on the second run', async () => {
    await putHandle(cloneableHandle('old-workspace'), 'workspace');
    localStorage.setItem(LS_WORKSPACE, '{}');

    await runLegacyCleanup();
    await expect(runLegacyCleanup()).resolves.toBeUndefined();

    expect(await getHandle('workspace')).toBeNull();
  });

  it('resolves even when localStorage throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    // Safari private mode is a supported browser, and housekeeping that can
    // fail a startup is worse than the keys it removes.
    await expect(runLegacyCleanup()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});
