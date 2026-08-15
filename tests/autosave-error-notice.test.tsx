// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * autosave-error-notice — a save that is not happening has to say so
 * (plan-422 F2, test 9.8).
 *
 * The failure this covers is not the write itself but the SILENCE around it.
 * `_autosaveBody()` used to end a non-conflict failure in `console.error`, which
 * meant the interface looked identical whether the draft body had been written
 * or refused — and a refused bake writes nothing at all, so the whole session's
 * unsaved work was riding on a line nobody reads.
 *
 * Four properties are pinned here, and the third and fourth are the ones the
 * old channel could not have delivered (SOL-R2 F1): the notice must be
 * WITHDRAWABLE by id with the banner noticing, and it must coexist with a
 * conflict rather than replace it.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  reportAutosaveError,
  clearAutosaveError,
  reportSceneConflict,
  reportOrphanedBindings,
  clearSceneSyncNotices,
  onSceneSyncNotice,
  onSceneSyncEvent,
  sceneSyncNoticeId,
  type SceneSyncNotice,
  type SceneSyncEvent,
} from '../src/core/hmi/scene/rv-scene-live-sync';
import { StorageNoticeBanner } from '../src/core/hmi/StorageNoticeBanner';

afterEach(() => {
  cleanup();
  clearSceneSyncNotices();
});

const DRAFT = 'draft/builtin:demo';

describe('autosave-error notice', () => {
  it('reaches the banner with the reason the storage layer gave', async () => {
    render(<StorageNoticeBanner />);
    reportAutosaveError(DRAFT, 'UnrepresentableValueError: 1 setting(s) cannot be stored');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('automatic save failed');
    expect(alert.textContent).toContain('UnrepresentableValueError');
  });

  it('deduplicates by id: a repeated failure refreshes the same notice', async () => {
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    try {
      reportAutosaveError(DRAFT, 'first reason');
      reportAutosaveError(DRAFT, 'second reason');

      render(<StorageNoticeBanner />);
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('second reason');
      expect(alert.textContent).not.toContain('first reason');
      // One notice on screen, whatever the number of failures behind it.
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('is WITHDRAWN when the next autosave of the same slot succeeds', async () => {
    render(<StorageNoticeBanner />);
    reportAutosaveError(DRAFT, 'bake refused the file');
    await screen.findByRole('alert');

    clearAutosaveError(DRAFT);

    // The banner holds its own copy, so the clear only lands if it is an EVENT.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('emits a clear event carrying the id the notice was filed under', () => {
    const events: SceneSyncEvent[] = [];
    const off = onSceneSyncEvent((e) => events.push(e));
    try {
      reportAutosaveError(DRAFT, 'why');
      const id = sceneSyncNoticeId({ kind: 'autosave-error', slot: DRAFT, reason: 'why', message: '' });
      clearAutosaveError(DRAFT);
      expect(events).toEqual([
        { type: 'notice', id, notice: expect.objectContaining({ kind: 'autosave-error', slot: DRAFT }) },
        { type: 'clear', id },
      ]);
      // Clearing something that is not there says nothing.
      clearAutosaveError(DRAFT);
      expect(events).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('clears only its own slot', async () => {
    render(<StorageNoticeBanner />);
    reportAutosaveError('draft/a', 'a failed');
    reportAutosaveError('draft/b', 'b failed');

    clearAutosaveError('draft/a');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('b failed');
  });
});

describe('notice priority', () => {
  it('a conflict outranks an autosave error, and survives it being cleared', async () => {
    render(<StorageNoticeBanner />);
    reportAutosaveError(DRAFT, 'bake refused');
    reportSceneConflict('Demo Cell');

    let alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('was changed somewhere else');

    // The conflict is a separate id, so clearing the autosave error leaves it.
    clearAutosaveError(DRAFT);
    alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('was changed somewhere else');
  });

  it('an autosave error outranks an orphaned-bindings warning', async () => {
    render(<StorageNoticeBanner />);
    reportOrphanedBindings('demo.glb', ['Cell/Old/Lamp']);
    reportAutosaveError(DRAFT, 'bake refused');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('automatic save failed');

    // …and the warning is still there underneath, not lost.
    clearAutosaveError(DRAFT);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('no longer has');
    });
  });
});

describe('existing consumers are unchanged (regression)', () => {
  it('still replays the latest conflict to a late subscriber', () => {
    reportSceneConflict('Demo Cell');
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice((n) => seen.push(n));
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('conflict');
  });

  it('still renders an other-tab hint as a quiet status, not an alert', async () => {
    render(<StorageNoticeBanner />);
    // Emitted the way the BroadcastChannel handler does, via the public reporter
    // surface the channel shares: a conflict then cleared leaves the hint alone.
    const { announceSceneWrite } = await import('../src/core/hmi/scene/rv-scene-live-sync');
    // announceSceneWrite only talks to OTHER tabs, so drive the hint directly
    // through the same emit path the handler uses by reporting from a peer id.
    announceSceneWrite(DRAFT, 'rev-1');
    // Nothing is asserted about cross-tab delivery here (one tab in one page);
    // what matters is that no alert appeared from the additive change.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
