// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-thumbnail-regenerate-progress — what a "Regenerate thumbnails" run is
 * doing right now (plan-776 #20).
 *
 * A registry command returns one value at its end, so the progress of a run —
 * "3 / 12, Gantry" — and its Cancel travel through this tiny external store
 * instead. The run (`rv-thumbnail-regenerate.ts`) writes it; the dashboard's
 * progress dialog reads it with `useSyncExternalStore`. A run started from MCP
 * (`web_execute("project.regenerateThumbnails", …)`) reports here too, so an
 * open dashboard shows it and can cancel it.
 *
 * React-free and import-free on purpose: the dashboard imports it, and the
 * read side may not reach the renderer or the writer (plan-776 guard 2).
 */

/** One document whose thumbnail could not be written. */
export interface RegenerateFailure {
  documentId: string;
  name: string;
  reason: string;
}

export interface RegenerateProgress {
  /** A run is in progress. */
  running: boolean;
  projectId: string | null;
  projectName: string | null;
  /** Documents in the run. */
  total: number;
  /** Documents finished (written or failed). */
  done: number;
  /** Name of the document being rendered, null between documents. */
  current: string | null;
  written: number;
  failures: readonly RegenerateFailure[];
  /** Cancel was asked for; the run stops after the current document. */
  cancelRequested: boolean;
  /** The finished run stopped early on Cancel. */
  cancelled: boolean;
  /** A run ended and its result is still on screen (until {@link dismissRegenerateProgress}). */
  finished: boolean;
  /** Why the run could not start or aborted as a whole (permission refused, project read-only). */
  error: string | null;
}

const IDLE: RegenerateProgress = {
  running: false,
  projectId: null,
  projectName: null,
  total: 0,
  done: 0,
  current: null,
  written: 0,
  failures: [],
  cancelRequested: false,
  cancelled: false,
  finished: false,
  error: null,
};

let state: RegenerateProgress = IDLE;
let cancelHook: (() => void) | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<RegenerateProgress>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function subscribeRegenerateProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getRegenerateProgress(): RegenerateProgress {
  return state;
}

/** Is a run in progress? The command refuses a second one. */
export function isRegenerateRunning(): boolean {
  return state.running;
}

/** A run starts. `onCancel` is what {@link requestRegenerateCancel} triggers. */
export function beginRegenerateProgress(
  project: { id: string; name: string | null },
  onCancel: () => void,
): void {
  cancelHook = onCancel;
  state = { ...IDLE, running: true, projectId: project.id, projectName: project.name };
  for (const l of listeners) l();
}

/** The document list is known (after the project is open). */
export function setRegenerateTotal(total: number, projectName?: string | null): void {
  set({ total, ...(projectName !== undefined ? { projectName } : {}) });
}

/** The run moves on to `name`. */
export function setRegenerateCurrent(name: string | null): void {
  set({ current: name });
}

/** One document finished. */
export function recordRegenerateResult(failure: RegenerateFailure | null): void {
  set({
    done: state.done + 1,
    written: failure ? state.written : state.written + 1,
    failures: failure ? [...state.failures, failure] : state.failures,
  });
}

/** The run ended (normally, on Cancel, or with an `error` that stopped it as a whole). */
export function finishRegenerateProgress(result: { cancelled: boolean; error?: string | null }): void {
  cancelHook = null;
  set({
    running: false,
    current: null,
    finished: true,
    cancelled: result.cancelled,
    error: result.error ?? null,
  });
}

/** Cancel: the run stops after the current document; written thumbnails stay. */
export function requestRegenerateCancel(): void {
  if (!state.running || state.cancelRequested) return;
  set({ cancelRequested: true });
  try { cancelHook?.(); } catch { /* a cancel never throws into the UI */ }
}

/** The result was read — back to idle. Ignored while a run is in progress. */
export function dismissRegenerateProgress(): void {
  if (state.running) return;
  state = IDLE;
  for (const l of listeners) l();
}

/** Test hook. */
export function _resetRegenerateProgressForTest(): void {
  cancelHook = null;
  state = IDLE;
  for (const l of listeners) l();
}
