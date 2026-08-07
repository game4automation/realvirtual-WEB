// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-conflict-dialog.test — the per-scene conflict prompt (§4c).
 *
 * The dialog must not have opinions of its own: it displays what
 * `resolveSceneConflict()` already classified as `prompt`, and its default is
 * the direction that cannot destroy work.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProjectConflictDialog } from '../src/core/project/rv-project-conflict-dialog';
import type { SceneConflictPromptItem } from '../src/core/project/project-store';

afterEach(cleanup);

const itemA: SceneConflictPromptItem = {
  id: 'scn_a',
  name: 'Cell A',
  cacheModifiedAt: '2025-06-01T10:00:00.000Z',
  folderModifiedAt: '2025-01-01T10:00:00.000Z',
  hasUnsavedDraft: false,
};

const itemB: SceneConflictPromptItem = {
  id: 'scn_b',
  name: 'Cell B',
  cacheModifiedAt: '2025-06-02T10:00:00.000Z',
  folderModifiedAt: '2025-01-02T10:00:00.000Z',
  hasUnsavedDraft: true,
};

function renderDialog(items: SceneConflictPromptItem[], onResolve = vi.fn()) {
  render(
    <ProjectConflictDialog open projectName="Customer project" items={items} onResolve={onResolve} />,
  );
  return onResolve;
}

describe('ProjectConflictDialog', () => {
  it('lists one row per conflicted scene', () => {
    renderDialog([itemA, itemB]);
    expect(screen.getByText('Cell A')).toBeTruthy();
    expect(screen.getByText('Cell B')).toBeTruthy();
    expect(screen.getByText(/Customer project/)).toBeTruthy();
  });

  it('defaults every row to keeping the cached edits', () => {
    const onResolve = renderDialog([itemA, itemB]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({ scn_a: 'keep-cache', scn_b: 'keep-cache' });
  });

  it('reports the row the user switched to the folder version', () => {
    const onResolve = renderDialog([itemA, itemB]);
    const rowA = screen.getByTestId('conflict-row-scn_a');
    fireEvent.click(within(rowA).getByRole('button', { name: 'Use folder version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({ scn_a: 'use-folder', scn_b: 'keep-cache' });
  });

  it('offers "apply to all" shortcuts once there is more than one conflict', () => {
    const onResolve = renderDialog([itemA, itemB]);
    fireEvent.click(screen.getByRole('button', { name: 'Use all folder versions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({ scn_a: 'use-folder', scn_b: 'use-folder' });
  });

  it('drops the shortcuts for a single conflict', () => {
    renderDialog([itemA]);
    expect(screen.queryByRole('button', { name: 'Use all folder versions' })).toBeNull();
  });

  it('says plainly when the browser copy holds work that was never saved', () => {
    renderDialog([itemA, itemB]);
    const rowB = screen.getByTestId('conflict-row-scn_b');
    expect(within(rowB).getByText(/unsaved edits/)).toBeTruthy();
    const rowA = screen.getByTestId('conflict-row-scn_a');
    expect(within(rowA).queryByText(/unsaved edits/)).toBeNull();
  });
});

// ─── plan-373 — a browser copy that belongs to another project ──────────

const itemForeign: SceneConflictPromptItem = {
  id: 'scn_c',
  name: 'Cell C',
  cacheModifiedAt: '2025-06-03T10:00:00.000Z',
  folderModifiedAt: '2025-01-03T10:00:00.000Z',
  hasUnsavedDraft: false,
  cachedFromProjectId: 'prj_other',
  cachedFromProjectName: 'Line 2 rebuild',
};

describe('ProjectConflictDialog — foreign cache origin', () => {
  it('names the project the browser copy came from', () => {
    renderDialog([itemForeign]);
    const row = screen.getByTestId('conflict-row-scn_c');
    expect(within(row).getByText(/comes from another project/)).toBeTruthy();
    expect(within(row).getByText('Line 2 rebuild')).toBeTruthy();
  });

  it('falls back to the project id when no name is known', () => {
    renderDialog([{ ...itemForeign, cachedFromProjectName: undefined }]);
    expect(within(screen.getByTestId('conflict-row-scn_c')).getByText('prj_other')).toBeTruthy();
  });

  it('defaults that row to the folder version — keeping a foreign copy is the destructive choice', () => {
    const onResolve = renderDialog([itemA, itemForeign]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The unrelated row keeps its safe default; only the foreign one flips.
    expect(onResolve).toHaveBeenCalledWith({ scn_a: 'keep-cache', scn_c: 'use-folder' });
  });
});
