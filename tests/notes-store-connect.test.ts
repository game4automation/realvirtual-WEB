// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * notes-store-connect.test.ts — CONNECT comment-store path of the notes store
 * (plan-253, §9.5): GET/POST against {notesUrl}/comments, offline degradation,
 * and the localStorage regression path when no notesUrl is configured.
 * NEVER performs real network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAppConfig } from '../src/core/rv-app-config';
import {
  loadNotes,
  addNote,
  notesArePersistable,
  __resetRemoteNotesState,
} from '../src/plugins/demo/robot-alarm/alarm-notes-store';
import type { AlarmNote } from '../src/plugins/demo/robot-alarm/alarm-seed-data';

const NOTE: AlarmNote = { author: 'Meier', dateLabel: '6 Jul', shift: 'Early', text: 'Blockade at gripper' };

describe('alarm-notes-store — CONNECT mode (notesUrl set)', () => {
  beforeEach(() => {
    setAppConfig({ diagnostics: { notesUrl: 'http://connect:5100/' } });
    __resetRemoteNotesState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setAppConfig({});
    __resetRemoteNotesState();
  });

  it('loadNotes GETs {notesUrl}/comments?errorId=…', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        { author: 'Meier', text: 'Blockade', timestamp: '2026-07-01T08:00:00Z' },
        { text: 'anonymous ok' },
        null,               // garbage entries are skipped
        { author: 7 },      // no text → skipped
      ],
    } as Response);

    const notes = await loadNotes('SYST-320');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://connect:5100/comments?errorId=SYST-320');
    expect(notes).toHaveLength(2);
    expect(notes[0].author).toBe('Meier');
    expect(notes[0].dateLabel.length).toBeGreaterThan(0);   // derived from timestamp
    expect(notesArePersistable()).toBe(true);
  });

  it('addNote POSTs {notesUrl}/comments with errorId + author + text', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);

    await addNote('SYST-320', NOTE);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://connect:5100/comments');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ errorId: 'SYST-320', author: 'Meier', text: 'Blockade at gripper' });
    expect(typeof body.timestamp).toBe('string');
    expect(notesArePersistable()).toBe(true);
  });

  it('offline GET → resolves [] without crash + notesArePersistable() === false', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const notes = await loadNotes('SYST-320');
    expect(notes).toEqual([]);
    expect(notesArePersistable()).toBe(false);
  });

  it('offline POST → resolves without crash + notesArePersistable() === false', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(addNote('SYST-320', NOTE)).resolves.toBeUndefined();
    expect(notesArePersistable()).toBe(false);
  });

  it('HTTP error → treated as offline (persistable false, empty list)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    expect(await loadNotes('SYST-320')).toEqual([]);
    expect(notesArePersistable()).toBe(false);
  });
});

describe('alarm-notes-store — localStorage mode (regression: demo unchanged)', () => {
  const TEST_ID = 'TEST-CONNECT-REGRESSION';

  beforeEach(() => {
    setAppConfig({});
    __resetRemoteNotesState();
    localStorage.removeItem(`demo-alarm-notes:${TEST_ID}`);
  });
  afterEach(() => {
    localStorage.removeItem(`demo-alarm-notes:${TEST_ID}`);
    vi.restoreAllMocks();
  });

  it('no notesUrl → NO fetch, notes go to localStorage as before', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await loadNotes(TEST_ID)).toEqual([]);   // unknown id → no seeds
    await addNote(TEST_ID, NOTE);
    const notes = await loadNotes(TEST_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ author: 'Meier', text: 'Blockade at gripper', seed: false });
    expect(notesArePersistable()).toBe(true);       // not locked
  });

  it('known demo alarm still returns its seed notes first', async () => {
    const notes = await loadNotes('SYST-320');
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].seed).toBe(true);
  });
});
