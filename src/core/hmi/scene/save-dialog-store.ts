// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * save-dialog-store — the promise-based dialogs of the ONE save path.
 *
 * ## Why this is public, three days after plan-434 privatised the editor UI
 *
 * Save dialogs are document INFRASTRUCTURE, not authoring UI. plan-434 moved
 * the asset editor's *authoring tools* — the CAD import report, the mesh
 * separator preview, the op-log stack prompts — into the commercial sibling
 * because they are the product. Saving is not: every tier opens documents,
 * every tier writes them back, and a Community build whose save flow answers
 * differently from the commercial one is two products pretending to be one.
 * So these three dialogs stay in the AGPL core deliberately, and a later
 * 434-style sweep must not collect them again.
 *
 * ## Three dialogs, and only three
 *
 *  - `unsaved`      — Save / Discard / Cancel on the way out;
 *  - `name`         — "Save into project as…", the ONE prompt of the target
 *                     semantics (plan-719 F2);
 *  - `save-problem` — one message with the concrete reason plus the download
 *                     fallback (F5), replacing the pre-716 "Custom library"
 *                     text that swallowed WHY.
 *
 * The editor's remaining eight dialog kinds stay in the private store, which is
 * where they belong: they are about authoring, not about documents.
 *
 * ## One prompt owner (§2.10)
 *
 * Every save entry point — the card's Save button, Ctrl+S, the "Save as…" menu,
 * the exit guard and the MCP tool — asks through {@link askSaveName}. That is
 * what makes the reentrancy guard total rather than per-caller: the store holds
 * ONE pending prompt per document, and a second request while one is open
 * answers {@link SAVE_PROMPT_BUSY} immediately instead of publishing a second
 * dialog whose state overwrites the first one's and orphans its resolve
 * closure. A guard inside `saveDocument()` alone could not do this, because the
 * "Save as…" path opens its prompt BEFORE `saveDocument()` is ever called.
 *
 * The busy answer is a SYMBOL rather than the string `'busy'`: the other two
 * answers of this function are "a name" and `null` (declined), and a document
 * legitimately named "busy" must not read as a race.
 */

// ─── What the dialogs answer ────────────────────────────────────────────

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

/**
 * What the problem dialog offers. `retry` appears only when the caller says the
 * failure is retryable — a permission re-grant has to happen inside a fresh
 * user gesture, and that button IS the gesture.
 */
export type SaveProblemChoice = 'download' | 'retry' | 'cancel';

/** A save prompt for this document is already open; this request did nothing. */
export const SAVE_PROMPT_BUSY: unique symbol = Symbol('rv.save.promptBusy');

export type SaveNameAnswer = string | null | typeof SAVE_PROMPT_BUSY;

/** What {@link askSaveName} needs in order to ask a question worth answering. */
export interface SaveNameRequest {
  /**
   * Identity of the document being saved — the key the pending slot is held
   * under. Two different documents may prompt at once; the same one may not.
   */
  documentKey: string;
  /** Pre-filled name. The source's own name for a "save into project" copy. */
  initial: string;
  /** Dialog title. Defaults to the target semantics' one prompt. */
  title?: string;
  /**
   * WHY the prompt is open, shown above the name field. The prompt has three
   * reasons (Save as…, a read-only source, a document with no name of its
   * own), and the default sentence describes only the read-only copy — a
   * caller asking for one of the other two passes its own sentence, or the
   * user is told their own document is "read-only".
   */
  description?: string;
  /**
   * Where the copy will land, shown read-only under the name field.
   *
   * The project root is the empty string and renders as "Project root" — the
   * user is being asked to place a file, and "where" is half of that question.
   */
  folder?: string;
  /** Primary button. Defaults to "Save copy". */
  confirmLabel?: string;
}

export interface SaveProblemRequest {
  /** The concrete reason, in a sentence the user can act on (F5). */
  reason: string;
  /** Offer "Try again" — permission cases, where a fresh gesture may succeed. */
  canRetry?: boolean;
  /** Offer "Download .glb" as the way out. Default true. */
  canDownload?: boolean;
}

export type PendingSaveDialog =
  | { kind: 'unsaved'; documentName: string; resolve: (c: UnsavedChoice) => void }
  | {
      kind: 'name';
      documentKey: string;
      initial: string;
      title: string;
      description?: string;
      folder?: string;
      confirmLabel: string;
      resolve: (name: string | null) => void;
    }
  | {
      kind: 'save-problem';
      reason: string;
      canRetry: boolean;
      canDownload: boolean;
      resolve: (c: SaveProblemChoice) => void;
    }
  | null;

// ─── The store ──────────────────────────────────────────────────────────

let _pending: PendingSaveDialog = null;
let _version = 0;
const _listeners = new Set<() => void>();

/**
 * Documents with a name prompt in flight (§2.10).
 *
 * A set rather than a boolean: the pending slot is a UI fact (one dialog on
 * screen) while this is an identity fact (this document is mid-question), and
 * conflating them would let an auto-answered prompt — which never reaches the
 * UI at all — look free to the next caller.
 */
const _prompting = new Set<string>();

// ─── Automated callers (MCP) ────────────────────────────────────────────
//
// Same seam, same reasoning as the editor's private store: every dialog here is
// a promise that only settles when a human clicks, which is fatal for an MCP
// tool call — it would block to the bridge timeout and return "outcome unknown"
// with the dialog still on screen. A responder is installed for the duration of
// an automated call, and it is consulted in `_set` so an auto-answered dialog is
// never published to the UI and cannot flash.

/** Answer with this to settle a dialog whose `resolve` takes no argument. */
export const SAVE_DIALOG_AUTO_DISMISS: unique symbol = Symbol('rv.saveDialog.autoDismiss');

/**
 * Decides an automated answer for one save dialog.
 *
 * Return `undefined` to decline, which shows the dialog to the human as usual —
 * the correct outcome for anything an agent has no business deciding.
 */
export type SaveDialogAutoResponder = (dialog: NonNullable<PendingSaveDialog>) => unknown;

/** One auto-answered dialog, for reporting back to the automated caller. */
export interface AutoAnsweredSaveDialog {
  kind: string;
  answer: string;
  detail?: string;
}

let _autoResponder: SaveDialogAutoResponder | null = null;
let _autoLog: AutoAnsweredSaveDialog[] = [];

/** Install (or clear with `null`) the automated responder. Returns the previous one. */
export function setDialogAutoResponder(
  fn: SaveDialogAutoResponder | null,
): SaveDialogAutoResponder | null {
  const prev = _autoResponder;
  _autoResponder = fn;
  return prev;
}

/** Drain the log of save dialogs answered automatically since the last call. */
export function takeSaveDialogAutoLog(): AutoAnsweredSaveDialog[] {
  const out = _autoLog;
  _autoLog = [];
  return out;
}

function _autoDetail(d: NonNullable<PendingSaveDialog>): string | undefined {
  if (d.kind === 'save-problem') return d.reason;
  if (d.kind === 'name') return d.folder ? `folder "${d.folder}"` : undefined;
  return undefined;
}

function _set(next: PendingSaveDialog): void {
  if (next && _autoResponder) {
    const resolve = (next as { resolve?: unknown }).resolve;
    if (typeof resolve === 'function') {
      let answer: unknown;
      // A throwing responder must not strand the dialog: falling through to the
      // human is the same outcome as declining.
      try { answer = _autoResponder(next); } catch { answer = undefined; }
      if (answer !== undefined) {
        const dismiss = answer === SAVE_DIALOG_AUTO_DISMISS;
        _autoLog.push({
          kind: next.kind,
          answer: dismiss ? 'dismissed' : (JSON.stringify(answer) ?? String(answer)),
          ...(_autoDetail(next) ? { detail: _autoDetail(next)! } : {}),
        });
        // Never published — resolved straight through, so the UI never sees it.
        (resolve as (v?: unknown) => void)(dismiss ? undefined : answer);
        return;
      }
    }
  }
  _pending = next;
  _version++;
  for (const fn of _listeners) fn();
}

// ─── The three questions ────────────────────────────────────────────────

/** Ask Save / Discard / Cancel for a document with unsaved work. */
export function askUnsavedChoice(documentName: string): Promise<UnsavedChoice> {
  return new Promise((resolve) => {
    _set({
      kind: 'unsaved',
      documentName,
      resolve: (c) => { _set(null); resolve(c); },
    });
  });
}

/**
 * Ask where a save should land — the ONE prompt of the target semantics.
 *
 * Answers `null` when the user declines and {@link SAVE_PROMPT_BUSY} when a
 * prompt for this document is already open. Callers must distinguish the two:
 * a decline is a `cancelled` save, a busy answer is a no-op that must not
 * unwind anything the first prompt is still in the middle of.
 */
export function askSaveName(request: SaveNameRequest): Promise<SaveNameAnswer> {
  const { documentKey } = request;
  if (_prompting.has(documentKey)) return Promise.resolve(SAVE_PROMPT_BUSY);
  _prompting.add(documentKey);
  return new Promise<SaveNameAnswer>((resolve) => {
    _set({
      kind: 'name',
      documentKey,
      initial: request.initial,
      title: request.title ?? 'Save into project',
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.folder !== undefined ? { folder: request.folder } : {}),
      confirmLabel: request.confirmLabel ?? 'Save copy',
      resolve: (name) => {
        _prompting.delete(documentKey);
        _set(null);
        resolve(name);
      },
    });
  });
}

/**
 * The pending-slot key of a document, from the ONE derivation.
 *
 * §2.10 only guards if both save entry points agree on the key: the card asks
 * from React, `runSaveFlow` asks from plugin code outside it, and a key each
 * side computes its own way would give one document two slots and no guard at
 * all. The document's display name is what both sides genuinely hold at that
 * moment — the card has `view.name`, the flow has `doc.name` — so that is the
 * key, and this function is where the choice is written down once.
 */
export function saveDocumentPromptKey(name: string | null | undefined): string {
  return (name ?? '').trim() || 'document';
}

/** True while a name prompt for this document is open. The busy half of §2.10. */
export function isPromptingSaveName(documentKey: string): boolean {
  return _prompting.has(documentKey);
}

/**
 * Say why a save could not happen, and offer the ways out.
 *
 * One dialog, the CONCRETE reason, and an action (F5). The pre-716 text said
 * "Cannot save to Custom library" and dropped the reason the caller had already
 * computed, which left a user whose project was merely read-only with nothing
 * on screen to tell them so.
 */
export function askSaveProblem(request: SaveProblemRequest): Promise<SaveProblemChoice> {
  return new Promise((resolve) => {
    _set({
      kind: 'save-problem',
      reason: request.reason,
      canRetry: request.canRetry === true,
      canDownload: request.canDownload !== false,
      resolve: (c) => { _set(null); resolve(c); },
    });
  });
}

// ─── Subscription ───────────────────────────────────────────────────────

export function getPendingSaveDialog(): PendingSaveDialog {
  return _pending;
}

export function subscribeSaveDialogs(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** `useSyncExternalStore` snapshot. A number, so identity is never a hazard. */
export function getSaveDialogsVersion(): number {
  return _version;
}

/**
 * Drop any pending dialog and forget every prompt owner. Tests only.
 *
 * Keeps the listeners for the same reason the view seam does: a component still
 * mounted when this runs would otherwise stop hearing about the next write.
 */
export function resetSaveDialogsForTests(): void {
  _pending = null;
  _prompting.clear();
  _autoResponder = null;
  _autoLog = [];
  _version++;
  for (const fn of _listeners) fn();
}
