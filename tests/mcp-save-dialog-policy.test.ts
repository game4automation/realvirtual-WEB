// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-719 F6 — an MCP call never blocks on a save dialog.
 *
 * ## Why this file exists at all
 *
 * Every dialog in `save-dialog-store` is a promise that settles on a CLICK. An
 * MCP tool call that raises one has nobody to click it: it blocks to the
 * bridge's timeout, comes back as `outcome=unknown`, and leaves the dialog on
 * screen poisoning every following call. `rv-mcp-dialog-policy` exists to stop
 * that — and until this plan it had NO tests at all, while the very refactor
 * that moved three dialogs into a new store was exactly the kind of change that
 * would have silently unarmed it.
 *
 * So this pins the seam rather than the wiring: with the policy installed, each
 * of the three save dialogs resolves by itself, without ever being published to
 * the UI, and the answers come back in the per-call report.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { installMcpDialogPolicy } from '../src/plugins/mcp-bridge/rv-mcp-dialog-policy';
import {
  askSaveName,
  askSaveProblem,
  askUnsavedChoice,
  getPendingSaveDialog,
  resetSaveDialogsForTests,
  SAVE_PROMPT_BUSY,
} from '../src/core/hmi/scene/save-dialog-store';

beforeEach(() => {
  resetSaveDialogsForTests();
});

describe('MCP dialog policy — the public save dialogs (plan-719 F6)', () => {
  it('answers all three without ever showing them', async () => {
    const release = await installMcpDialogPolicy();
    try {
      // Each resolves on its own. Without the responder these three awaits
      // would simply never settle, which is the failure being prevented.
      expect(await askUnsavedChoice('Belt')).toBe('cancel');
      expect(await askSaveProblem({ reason: 'The open project is read-only.' }))
        .toBe('cancel');
      expect(await askSaveName({ documentKey: 'Belt', initial: 'Belt' })).toBeNull();
      // Nothing was ever published, so nothing can be left standing.
      expect(getPendingSaveDialog()).toBeNull();
    } finally {
      release();
    }
  });

  it('reports what it answered, so an agent can see it happened', async () => {
    const release = await installMcpDialogPolicy();
    await askSaveProblem({ reason: 'No project is open.' });
    const answered = release();

    const problem = answered.find((a) => a.kind === 'save-problem');
    expect(problem).toBeTruthy();
    // The REASON travels with it: a refusal an agent cannot read the cause of
    // is the same dead end as no answer at all.
    expect(problem?.detail).toContain('No project is open.');
  });

  /**
   * `name` is answered `null` — "declined" — and never with a made-up name. An
   * agent that wanted one passed it (`web_editor_save name=`); being asked
   * means it did not, and inventing a file name on its behalf is how an agent
   * writes a document nobody can find.
   */
  it('never invents a name', async () => {
    const release = await installMcpDialogPolicy();
    try {
      expect(await askSaveName({ documentKey: 'X', initial: 'Demo' })).toBeNull();
    } finally {
      release();
    }
  });

  it('releasing restores the human path', async () => {
    const release = await installMcpDialogPolicy();
    release();

    // Not awaited: with no responder this promise stays open by design, and
    // the dialog is now PUBLISHED for a human to answer.
    void askUnsavedChoice('Belt');
    expect(getPendingSaveDialog()?.kind).toBe('unsaved');
  });

  /**
   * §2.10 still holds under automation. An auto-answered prompt must release
   * its pending slot, or the first MCP save would leave the document
   * permanently "busy" and every later one would answer the sentinel.
   */
  it('an auto-answered prompt frees the document for the next save', async () => {
    const release = await installMcpDialogPolicy();
    try {
      await askSaveName({ documentKey: 'Belt', initial: 'Belt' });
      const second = await askSaveName({ documentKey: 'Belt', initial: 'Belt' });
      expect(second).not.toBe(SAVE_PROMPT_BUSY);
    } finally {
      release();
    }
  });
});
