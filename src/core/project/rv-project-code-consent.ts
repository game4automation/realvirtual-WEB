// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-code-consent — the trust gate in front of native project code
 * (plan-718 §2.6, stage 2b.3, R8; user decision 2026-08-14).
 *
 * The runtime mode of `scriptRef` imports a `.js` file that came with a project
 * folder. That is **unsandboxed JavaScript with the full authority of the
 * page** — `doc-scripting.md` says so in as many words ("None — native JS
 * execution"). The existing QuickJS trust gate does not cover it and cannot:
 * that gate is about a VM this one does not use.
 *
 * So the decision is asked for separately, and three properties of the way it is
 * asked are the whole point:
 *
 *  - **Per project, not global.** The unit a user can reason about is "this
 *    folder, from these people". A single global "allow scripting" switch would
 *    make the *next* project's code run because the *previous* one was trusted,
 *    and that is precisely the failure the gate exists to prevent. The global
 *    scripting gate is explicitly NOT a blanket permission here.
 *  - **Once, then persisted** (localStorage, keyed by project id). A prompt on
 *    every model switch is a prompt people click away.
 *  - **Fail closed, at every step.** No decision on file and no dialog host
 *    mounted ⇒ denied. Storage unavailable (private mode) ⇒ the decision holds
 *    for the session and is asked again next time — never "assume yes".
 *
 * The bundled build-glob path is deliberately NOT gated: that code was compiled
 * into this build from this repository, it is in git, and it is as reviewable as
 * the viewer around it. Gating it would train users to click through a prompt
 * that never carries information.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'rv-project-code-consent';
const TABLE_VERSION = 1;

/** What was decided about one project. */
export interface ProjectCodeConsentRecord {
  v: number;
  decision: 'granted' | 'denied';
  at: number;
}

type ConsentTable = Record<string, ProjectCodeConsentRecord>;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ─── Persistence ────────────────────────────────────────────────────────

/**
 * Session mirror of the table.
 *
 * Not an optimisation: in private mode `localStorage` throws on write, and
 * without this the user would be asked again for every model of the same
 * project inside one session.
 */
let sessionTable: ConsentTable = {};

function readTable(): ConsentTable {
  let stored: ConsentTable = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stored = parsed as ConsentTable;
    }
  } catch { /* storage disabled or corrupt — the session mirror is the answer */ }
  return { ...stored, ...sessionTable };
}

function writeRecord(projectId: string, record: ProjectCodeConsentRecord): void {
  sessionTable = { ...sessionTable, [projectId]: record };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const table: ConsentTable =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as ConsentTable)
        : {};
    table[projectId] = record;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
  } catch { /* private mode: the session mirror still holds the decision */ }
}

// ─── Reading ────────────────────────────────────────────────────────────

/**
 * The decision on file for a project, or null when none was ever made.
 *
 * A record written by a future version of this table reads as **null**, not as
 * "granted": an unknown shape is not consent.
 */
export function projectCodeConsent(projectId: string): 'granted' | 'denied' | null {
  if (!projectId) return null;
  const record = readTable()[projectId];
  if (!record || record.v !== TABLE_VERSION) return null;
  return record.decision === 'granted' || record.decision === 'denied' ? record.decision : null;
}

/** True only for an explicit, current "granted". */
export function hasProjectCodeConsent(projectId: string): boolean {
  return projectCodeConsent(projectId) === 'granted';
}

// ─── Writing ────────────────────────────────────────────────────────────

/** Record a decision. Persisted across sessions. */
export function setProjectCodeConsent(projectId: string, granted: boolean): void {
  if (!projectId) return;
  writeRecord(projectId, {
    v: TABLE_VERSION,
    decision: granted ? 'granted' : 'denied',
    at: Date.now(),
  });
  emit();
}

/** Forget a decision (or, with no id, all of them) — back to "will ask again". */
export function resetProjectCodeConsent(projectId?: string): void {
  if (projectId) {
    const { [projectId]: _dropped, ...rest } = sessionTable;
    sessionTable = rest;
  } else {
    sessionTable = {};
  }
  try {
    if (!projectId) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const table = parsed as ConsentTable;
        delete table[projectId];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
      }
    }
  } catch { /* private mode */ }
  emit();
}

// ─── Asking ─────────────────────────────────────────────────────────────

/** One project waiting for an answer. */
export interface PendingProjectCodeConsent {
  projectId: string;
  projectName: string;
  /** The script that triggered the question — shown so the prompt is concrete. */
  scriptRef: string;
}

let pending: PendingProjectCodeConsent | null = null;
let pendingResolve: ((granted: boolean) => void) | null = null;
let pendingPromise: Promise<boolean> | null = null;
let hostMounted = false;

/** The request the dialog host should be showing, or null. */
export function pendingProjectCodeConsent(): PendingProjectCodeConsent | null {
  return pending;
}

/** Subscribe to consent-table and pending-request changes. */
export const subscribeProjectCodeConsent = subscribe;

/**
 * Declare that a UI can show the prompt.
 *
 * Without this, {@link requestProjectCodeConsent} denies instead of hanging on a
 * promise nobody will ever settle — a headless embed or a test must not be able
 * to deadlock a model load, and it must not silently run the code either.
 */
export function registerProjectCodeConsentHost(): () => void {
  hostMounted = true;
  emit();
  return () => {
    hostMounted = false;
    // A host that unmounts while a question is open answers it: no.
    if (pendingResolve) answerProjectCodeConsent(false);
    emit();
  };
}

/** Answer the open question. Persists the decision and settles the waiters. */
export function answerProjectCodeConsent(granted: boolean): void {
  const request = pending;
  const resolve = pendingResolve;
  pending = null;
  pendingResolve = null;
  pendingPromise = null;
  if (request) setProjectCodeConsent(request.projectId, granted);
  resolve?.(granted);
  emit();
}

/**
 * Ask (or recall) whether this project's native code may run.
 *
 * Concurrent callers for the SAME project share one question — a project with
 * three documents pointing at the same script must not produce three dialogs.
 * A request for a *different* project while one is open is denied rather than
 * queued: two overlapping trust prompts is how the wrong one gets answered.
 */
export function requestProjectCodeConsent(
  request: PendingProjectCodeConsent,
): Promise<boolean> {
  const { projectId } = request;
  if (!projectId) return Promise.resolve(false);

  const decided = projectCodeConsent(projectId);
  if (decided) return Promise.resolve(decided === 'granted');

  if (pending && pendingPromise) {
    return pending.projectId === projectId ? pendingPromise : Promise.resolve(false);
  }
  if (!hostMounted) return Promise.resolve(false);

  pending = request;
  pendingPromise = new Promise<boolean>(resolve => { pendingResolve = resolve; });
  emit();
  return pendingPromise;
}

// ─── React ──────────────────────────────────────────────────────────────

/** The open question, re-rendering the host when it appears or is answered. */
export function usePendingProjectCodeConsent(): PendingProjectCodeConsent | null {
  return useSyncExternalStore(subscribe, pendingProjectCodeConsent, pendingProjectCodeConsent);
}

/** Test seam: forget every decision AND any open question. */
export function _resetProjectCodeConsentForTests(): void {
  pending = null;
  pendingResolve = null;
  pendingPromise = null;
  hostMounted = false;
  sessionTable = {};
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  listeners.clear();
}
