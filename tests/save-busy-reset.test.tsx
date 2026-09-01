// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-719 F7 / Defect (a) — no "Saving…" survives a cancel or an exception.
 *
 * Field evidence, 2026-08-18: the card was left announcing "Saving…" after a
 * save path threw, and the "Save as…" menu verb reported nothing at all. Both
 * are the same omission — the announcement is written BEFORE the await and only
 * unwound on the outcomes the author happened to enumerate — so both are pinned
 * here as statements rather than left to a reviewer's memory.
 *
 * The third block is §2.10: the prompt is the REGULAR case for a read-only
 * source after this plan, so a second click while it is open must be a busy
 * no-op and never a second dialog with an orphaned resolve closure.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const backend = { id: 'b1', kind: 'browser', writable: true } as never;
vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => backend,
    getProject: () => ({ id: 'p1' }),
    setDirtyDocumentsProbe: () => {},
  }),
}));

import { DocumentCard } from '../src/core/hmi/scene/DocumentCard';
import { SaveDialogs } from '../src/core/hmi/scene/SaveDialogs';
import { resetSaveDialogsForTests } from '../src/core/hmi/scene/save-dialog-store';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentSaveOutcome,
  type ActiveDocumentView,
  type NamePrompt,
} from '../src/core/editor/active-document-view';

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  resetSaveDialogsForTests();
});

/** The app mounts both: the card in the header, the dialogs in the overlay slot. */
function renderCard() {
  return render(<><DocumentCard activeMode="editor" /><SaveDialogs /></>);
}

/** A minimal published view; every test overrides only what it is about. */
function publishView(over: Partial<ActiveDocumentView> = {}): void {
  const view: ActiveDocumentView = {
    name: 'Belt',
    crumbs: [{
      index: 0, label: 'Belt', occurrence: '', referenceNodeId: null,
      dirty: true, stale: false, current: true,
    }],
    dirty: true,
    busy: false,
    stackDirty: true,
    stale: false,
    saveVerb: 'save',
    sourceMode: 'editor',
    actions: { save: async () => ({ status: 'saved' }) },
    ...over,
  };
  setActiveDocumentView(view);
}

const statusText = (): string =>
  screen.getByTestId('document-card-status').textContent ?? '';

const clickSave = (): void => {
  fireEvent.click(screen.getByTestId('document-card-save'));
};

describe('DocumentCard save busy lifecycle (plan-719 F7)', () => {
  it('clears the announcement when the name prompt is cancelled', async () => {
    publishView({
      actions: {
        save: async (prompt?: NamePrompt): Promise<ActiveDocumentSaveOutcome> => {
          const picked = prompt ? await prompt('Belt', 'Save into project as…') : null;
          return picked === null ? { status: 'cancelled' } : { status: 'saved' };
        },
      },
    });
    renderCard();

    clickSave();
    // The shared save prompt is up; decline it.
    await screen.findByTestId('save-dialog-name');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(statusText()).toBe(''));
    expect(screen.getByTestId('document-card-save').textContent).toBe('Save');
  });

  /**
   * The one that is RED before this plan: `onSave` writes "Saving…" and unwinds
   * it only on the outcomes it enumerates. A rejection is not one of them, so
   * the live region keeps announcing a save that already failed.
   */
  it('clears the announcement when save throws instead of resolving', async () => {
    publishView({
      actions: {
        save: async (): Promise<ActiveDocumentSaveOutcome> => {
          throw new Error('the disk went away');
        },
      },
    });
    renderCard();

    clickSave();

    await waitFor(() => expect(statusText()).not.toBe('Saving…'));
    // The failure is SURFACED, not just cleared — a save that vanished without
    // a word is the other half of the same defect.
    expect(statusText()).toMatch(/failed/i);
    await waitFor(() =>
      expect(screen.getByTestId('document-card-notice').textContent)
        .toMatch(/the disk went away/i));
  });

  /**
   * F7 second half: Ctrl+S, the Save button, the exit guard and the "Save as…"
   * MENU all save, so all four have to report through the one mechanism. Today
   * only the button does.
   */
  it('menu "Save as…" reports through the same announcement mechanism', async () => {
    let resolveVerb: (() => void) | null = null;
    publishView({
      actions: {
        save: async () => ({ status: 'saved' }),
        menu: [{
          id: 'save-as',
          label: 'Save as…',
          run: async () => { await new Promise<void>(r => { resolveVerb = r; }); },
        }],
      },
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByTestId('document-card-verb-save-as'));

    await waitFor(() => expect(statusText()).toBe('Saving…'));
    resolveVerb!();
    await waitFor(() => expect(statusText()).toBe('Saved'));
  });
});

describe('save prompt reentrancy (plan-719 §2.10)', () => {
  /**
   * The target semantics make the prompt the REGULAR case for a catalog or
   * built-in source, so the double-click race stops being exotic. One dialog,
   * one save, and the second click answers `busy` — never a second dialog whose
   * state overwrites the first one's and orphans its resolve closure.
   */
  it('a second Save click while the prompt is open is a busy no-op', async () => {
    const saveCalls: number[] = [];
    let outcomes: ActiveDocumentSaveOutcome[] = [];
    publishView({
      saveVerb: 'save-into-project',
      actions: {
        save: async (prompt?: NamePrompt): Promise<ActiveDocumentSaveOutcome> => {
          saveCalls.push(saveCalls.length);
          const picked = prompt ? await prompt('Demo', 'Save into project as…') : null;
          return picked === null ? { status: 'cancelled' } : { status: 'saved' };
        },
      },
    });
    renderCard();

    clickSave();
    await screen.findByTestId('save-dialog-name');
    // …and again, while the first prompt is still up.
    clickSave();

    // Exactly ONE dialog is on screen — a second would mean the first's
    // resolve closure was orphaned.
    await waitFor(() => expect(screen.getAllByTestId('save-dialog-name')).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Demo copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save copy' }));

    await waitFor(() => expect(statusText()).toBe('Saved'));
    // One save ran. The second click never started a second one.
    expect(saveCalls).toHaveLength(1);
    outcomes = outcomes;
  });
});
