// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-op-progress — which step a long project operation is in right now.
 *
 * A project open is a chain of awaited steps (close the leaving project, ask
 * about unsaved work, list documents, read headers, register files, …). The
 * dashboard's "Open project…" dialog used to show one static sentence for all
 * of them, so a step that took a minute — or one that waited forever on a
 * question the user could not see — looked exactly like normal work.
 *
 * This module is the one place the steps are named. The project store reports
 * into it (`beginProjectOpStep`), the dialog subscribes (`useSyncExternalStore`
 * friendly: `subscribe` + `getProjectOpProgress`), and every finished step is
 * logged with its duration so a slow open leaves a trace in the console.
 *
 * Pure module state, no React and no DOM: it must be importable from the
 * project store without dragging UI into its module graph.
 */

export interface ProjectOpStep {
  label: string;
  /** Epoch ms when the step began. */
  startedAt: number;
  /** Duration in ms once finished; absent while running. */
  durationMs?: number;
  /** True for a step that waits on the USER, not on work. */
  waitingForUser?: boolean;
}

export interface ProjectOpProgress {
  /** Epoch ms when the first step of the current operation began, or null. */
  startedAt: number | null;
  current: ProjectOpStep | null;
  finished: readonly ProjectOpStep[];
}

const EMPTY: ProjectOpProgress = { startedAt: null, current: null, finished: [] };
let state: ProjectOpProgress = EMPTY;
/**
 * Steps are recorded only while an operation is open. The same store code runs
 * outside any dialog too (the save cascade rescans every few seconds), and
 * recording those would grow the list and the console without bound.
 */
let active = false;
const listeners = new Set<() => void>();

function emit(next: ProjectOpProgress): void {
  state = next;
  for (const l of listeners) {
    try { l(); } catch { /* a listener must not break the operation */ }
  }
}

function closeCurrent(now: number): ProjectOpStep[] {
  const finished = [...state.finished];
  const cur = state.current;
  if (cur) {
    const done = { ...cur, durationMs: now - cur.startedAt };
    finished.push(done);
    console.info(`[project-op] ${done.label} — ${Math.round(done.durationMs)} ms`);
  }
  return finished;
}

/** Open an operation: from now on steps are recorded (until {@link resetProjectOpProgress}). */
export function startProjectOp(): void {
  active = true;
  emit({ ...EMPTY, startedAt: Date.now() });
}

/** Start a named step; the previous one (if any) is closed and logged. No-op outside an operation. */
export function beginProjectOpStep(label: string, opts: { waitingForUser?: boolean } = {}): void {
  if (!active) return;
  const now = Date.now();
  const finished = closeCurrent(now);
  emit({
    startedAt: state.startedAt ?? now,
    current: { label, startedAt: now, ...(opts.waitingForUser ? { waitingForUser: true } : {}) },
    finished,
  });
}

/** Close the running step without starting a new one. */
export function endProjectOpStep(): void {
  if (!state.current) return;
  emit({ ...state, current: null, finished: closeCurrent(Date.now()) });
}

/** Forget everything — called when the operation as a whole has ended. */
export function resetProjectOpProgress(): void {
  if (state.current) endProjectOpStep();
  if (state.startedAt !== null) {
    const total = state.finished.reduce((s, x) => s + (x.durationMs ?? 0), 0);
    if (state.finished.length > 0) {
      console.info(`[project-op] done — ${state.finished.length} step(s), ${Math.round(total)} ms`);
    }
  }
  active = false;
  emit(EMPTY);
}

export function getProjectOpProgress(): ProjectOpProgress {
  return state;
}

export function subscribeProjectOpProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
