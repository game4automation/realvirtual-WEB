// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * alarm-notes-store.ts — Operator-note storage for the alarm assistant.
 *
 * Async by design so a shared note service can drop in without changing any
 * call site — and exactly that happened (plan-253): when
 * `getAppConfig().diagnostics.notesUrl` is set (delivered customer variants),
 * notes go to the CONNECT comment store via REST
 * (`GET/POST {notesUrl}/comments`); when it is absent (demo / public builds),
 * the original localStorage implementation runs UNCHANGED: curated seed notes
 * first, followed by any user-added notes.
 *
 * Locked (kiosk) deployments cannot persist — `addNote` resolves without
 * writing and the UI surfaces a "not saved" hint via {@link notesArePersistable}.
 * The same hint appears when the CONNECT store is offline.
 */

import { lsLoad, lsSave } from '../../../core/hmi/ls-store-utils';
import { getAppConfig, isSettingsLocked } from '../../../core/rv-app-config';
import { ALARM_SCENARIOS, type AlarmNote, type AlarmScenario } from './alarm-seed-data';

/** localStorage key for the user-added notes of one alarm. */
function storageKey(alarmId: string): string {
  return `demo-alarm-notes:${alarmId}`;
}

/** Shape persisted to localStorage. */
interface StoredNotes {
  notes: AlarmNote[];
}

const DEFAULTS: StoredNotes = { notes: [] };

/** Read the user-added notes (never the seed notes) for one alarm. Never throws. */
function loadUserNotes(alarmId: string): AlarmNote[] {
  const stored = lsLoad<StoredNotes>(storageKey(alarmId), DEFAULTS, {
    validate: (_merged, parsed) => {
      // Only accept a well-formed notes array; ignore corrupted entries.
      const arr = (parsed as Partial<StoredNotes>).notes;
      if (!Array.isArray(arr)) return { notes: [] };
      const clean = arr.filter(
        (n): n is AlarmNote =>
          !!n && typeof n === 'object' &&
          typeof (n as AlarmNote).author === 'string' &&
          typeof (n as AlarmNote).text === 'string',
      );
      return { notes: clean };
    },
  });
  return stored.notes;
}

/** Seed notes for one alarm (empty for unknown ids → isolation). */
function seedNotes(alarmId: string): AlarmNote[] {
  const scenario: AlarmScenario | undefined = ALARM_SCENARIOS[alarmId as AlarmScenario['id']];
  return scenario ? scenario.seedNotes.map((n) => ({ ...n, seed: true })) : [];
}

// ─── CONNECT comment store (REST, plan-253) ─────────────────────────────

const REMOTE_TIMEOUT_MS = 10_000;

/** Configured CONNECT comment-store base URL (trailing slashes trimmed), or null. */
function remoteNotesUrl(): string | null {
  const url = getAppConfig().diagnostics?.notesUrl?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * Last known reachability of the CONNECT store. Starts optimistic; flips to
 * false on any failed GET/POST so {@link notesArePersistable} can surface the
 * existing "not saved" hint. Flips back to true on the next success.
 */
let _remoteAvailable = true;
/** Test-only reset of the remote-availability latch. */
export function __resetRemoteNotesState(): void {
  _remoteAvailable = true;
}

/** Defensively coerce one server comment into an AlarmNote. Returns null when unusable. */
function parseRemoteNote(raw: unknown): AlarmNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.text !== 'string') return null;
  let dateLabel = typeof obj.dateLabel === 'string' ? obj.dateLabel : '';
  if (!dateLabel && typeof obj.timestamp === 'string') {
    const d = new Date(obj.timestamp);
    if (!Number.isNaN(d.getTime())) {
      dateLabel = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
    }
  }
  return {
    author: typeof obj.author === 'string' ? obj.author : '',
    dateLabel,
    shift: typeof obj.shift === 'string' ? obj.shift : '',
    text: obj.text,
    seed: false,
  };
}

/** GET `{notesUrl}/comments?errorId=…` → AlarmNote[]. Never throws (`?? []`). */
async function loadRemoteNotes(baseUrl: string, errorId: string): Promise<AlarmNote[]> {
  try {
    const resp = await fetch(
      `${baseUrl}/comments?errorId=${encodeURIComponent(errorId)}`,
      { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) },
    );
    if (!resp.ok) throw new Error(`comment store returned ${resp.status}`);
    const raw: unknown = await resp.json();
    _remoteAvailable = true;
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map(parseRemoteNote).filter((n): n is AlarmNote => n !== null);
  } catch {
    _remoteAvailable = false;
    return [];
  }
}

/** POST `{notesUrl}/comments`. Resolves without throwing on failure (offline). */
async function addRemoteNote(baseUrl: string, errorId: string, note: AlarmNote): Promise<void> {
  try {
    const resp = await fetch(`${baseUrl}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        errorId,
        author: note.author,
        text: note.text,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`comment store returned ${resp.status}`);
    _remoteAvailable = true;
  } catch {
    _remoteAvailable = false;
  }
}

// ─── Public API (signatures unchanged — call sites untouched) ────────────

/**
 * Load all notes for an alarm/error id.
 * - CONNECT mode (`diagnostics.notesUrl` set): shared server comments only.
 * - localStorage mode (default): seed notes first, then user-added notes.
 *   Unknown alarm ids return only their (empty) set — no cross-id bleed.
 */
export async function loadNotes(alarmId: string): Promise<AlarmNote[]> {
  const remote = remoteNotesUrl();
  if (remote) return loadRemoteNotes(remote, alarmId);
  return [...seedNotes(alarmId), ...loadUserNotes(alarmId)];
}

/**
 * Append a user note.
 * - CONNECT mode: POST to the shared comment store; on offline/error the
 *   promise still resolves and {@link notesArePersistable} flips to false.
 * - localStorage mode: unchanged. On locked (kiosk) deployments this is a
 *   no-op persist (lsSave already guards on `isSettingsLocked`) — the promise
 *   still resolves so the UI does not crash.
 */
export async function addNote(alarmId: string, note: AlarmNote): Promise<void> {
  const remote = remoteNotesUrl();
  if (remote) return addRemoteNote(remote, alarmId, note);
  const userNotes = loadUserNotes(alarmId);
  userNotes.push({ ...note, seed: false });
  lsSave<StoredNotes>(storageKey(alarmId), { notes: userNotes });
}

/**
 * False when notes cannot be persisted: locked (kiosk) deployments in
 * localStorage mode, or an unreachable CONNECT store in remote mode.
 */
export function notesArePersistable(): boolean {
  if (remoteNotesUrl()) return _remoteAvailable;
  return !isSettingsLocked();
}
