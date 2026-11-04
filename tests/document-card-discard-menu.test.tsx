// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The compact document header carries the document menu, and "Discard
 * changes" in it asks before it throws anything away (2026-10-25).
 *
 *  - the kebab sits next to Save in the hierarchy header (compact variant);
 *  - "Discard changes" is disabled while nothing is unsaved;
 *  - choosing it opens the Save / Discard / Cancel guard dialog — Cancel runs
 *    nothing, Discard runs the verb the view published (the scene store's
 *    `discard()`), Save runs the card's save path instead.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { DocumentCard } from '../src/core/hmi/scene/DocumentCard';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
});

function makeView(dirty: boolean, discard: () => Promise<void>, save = vi.fn(async () => ({ status: 'saved' as const }))): ActiveDocumentView {
  return {
    name: 'Untitled',
    location: ['Unsaved'],
    crumbs: [{ index: 0, label: 'Untitled', occurrence: '', referenceNodeId: null, dirty, stale: false, current: true }],
    dirty,
    busy: false,
    stackDirty: dirty,
    stale: false,
    saveVerb: 'save',
    sourceMode: 'planner',
    actions: {
      save,
      menu: [
        { id: 'save-as', label: 'Save as…', prompt: { title: 'Save as new scene', initial: 'Untitled' }, run: async () => {} },
        { id: 'discard', label: 'Discard changes', danger: true, disabled: !dirty, run: discard },
      ],
    },
  };
}

function mount(view: ActiveDocumentView) {
  setActiveDocumentView(view);
  return render(<DocumentCard variant="compact" activeMode="planner" />);
}

function openMenu() {
  const kebab = screen.getByRole('button', { name: 'More actions' });
  expect(kebab.getAttribute('aria-haspopup')).toBe('menu');
  fireEvent.click(kebab);
  return screen.getByRole('menu');
}

describe('compact document header — menu with "Discard changes"', () => {
  it('shows the menu next to Save', () => {
    mount(makeView(true, async () => {}));
    expect(screen.getByTestId('document-card-save')).toBeTruthy();
    expect(screen.getByTestId('document-card-more')).toBeTruthy();
  });

  it('disables "Discard changes" when nothing is unsaved', () => {
    mount(makeView(false, async () => {}));
    const menu = openMenu();
    const item = within(menu).getByTestId('document-card-verb-discard');
    expect(item.getAttribute('aria-disabled')).toBe('true');
  });

  it('asks first — Cancel discards nothing', async () => {
    const discard = vi.fn(async () => {});
    mount(makeView(true, discard));
    fireEvent.click(within(openMenu()).getByTestId('document-card-verb-discard'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Untitled');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(discard).not.toHaveBeenCalled();
  });

  it('Discard in the dialog runs the published discard verb', async () => {
    const discard = vi.fn(async () => {});
    mount(makeView(true, discard));
    fireEvent.click(within(openMenu()).getByTestId('document-card-verb-discard'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
  });

  it('Save in the dialog saves instead of discarding', async () => {
    const discard = vi.fn(async () => {});
    const save = vi.fn(async () => ({ status: 'saved' as const }));
    mount(makeView(true, discard, save));
    fireEvent.click(within(openMenu()).getByTestId('document-card-verb-discard'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(discard).not.toHaveBeenCalled();
  });
});
