// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-info-draft-store — unsaved description text, OUTSIDE React
 * (plan-506 F14, SOL R1-1 / R2-5).
 *
 * ## Why the draft cannot live in the editor's state
 *
 * The description is committed on blur, and the detail pane unmounts its
 * editor without a blur whenever the selection moves, the pane collapses or
 * the dashboard closes. Component state dies with the component, so a draft
 * kept there is lost exactly when the user moves on — the most common way to
 * finish typing. Worse, a flush from an effect cleanup runs AFTER the next
 * render, where the host's callback already names the NEXT document: flushing
 * A's text through it writes A's words into B. So the draft and the write that
 * belongs to it are stored together, here, keyed by the document they were
 * typed for.
 *
 * ## Why the key carries the project
 *
 * Two projects can hold a document with the same id (a copied folder). A
 * pending write keyed by the document alone would flush into whichever project
 * is open when it runs. The key is `${projectId}:${documentId}`, and the write
 * callback the editor registers is itself bound to that project (the store
 * refuses it with `ProjectChangedError` once another project is open) — so a
 * draft either lands where it was typed or stays here with an error.
 *
 * ## Why writes are queued, not dropped
 *
 * The dashboard's `runVerb` silently ignores a second call while one is in
 * flight, which is right for a button and wrong for text: two quick blurs are
 * two edits, and the second one is the newer. Writes are chained per key, so
 * the second starts when the first has settled — never concurrently (the file
 * is compare-and-swap protected; two parallel writes would make one of them
 * fail), never skipped.
 *
 * Pure module, no React: the editor subscribes through `useSyncExternalStore`.
 */

import { documentInfoEquals, type DocumentInfo } from '../../project/rv-document-info';

/** Writes one block (or `null` = remove) for the document the draft belongs to. */
export type DocumentInfoWrite = (next: DocumentInfo | null) => Promise<unknown>;

export interface DocumentInfoDraft {
  summary: string;
  description: string;
  /** The block the draft was typed against — the "is there a diff?" baseline. */
  base: DocumentInfo | null;
  /** True while a write of this key is queued or running. */
  saving: boolean;
  /** The last write's failure, kept until the next successful write. */
  error: string | null;
}

interface Entry {
  draft: DocumentInfoDraft;
  write: DocumentInfoWrite;
  /** Bumped on every edit, so a finishing write knows whether newer text exists. */
  edit: number;
  /** Writes of this key queued or running. */
  pending: number;
  /** The edit the most recent queued write carries — a second blur without typing is not a second write. */
  queuedEdit: number;
}

export interface DocumentInfoCommitResult {
  ok: boolean;
  error?: string;
}

const entries = new Map<string, Entry>();
const chains = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** The key a draft is stored under. */
export function documentInfoDraftKey(projectId: string, documentId: string): string {
  return `${projectId}:${documentId}`;
}

/** Subscribe to any draft change. */
export function subscribeDocumentInfoDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The draft of one document, or undefined when it has no unsaved text. */
export function getDocumentInfoDraft(key: string): DocumentInfoDraft | undefined {
  return entries.get(key)?.draft;
}

/** The block a draft stands for — `null` when both fields are blank. */
export function draftToDocumentInfo(draft: Pick<DocumentInfoDraft, 'summary' | 'description'>): DocumentInfo | null {
  const summary = draft.summary.trim();
  const description = draft.description.trim();
  if (!summary && !description) return null;
  return { v: 1, ...(summary ? { summary } : {}), ...(description ? { description } : {}) };
}

/** True when the draft's text differs from the block it was typed against. */
export function isDocumentInfoDraftDirty(draft: DocumentInfoDraft): boolean {
  return !documentInfoEquals(draftToDocumentInfo(draft), draft.base);
}

/**
 * Record typed text. Never writes.
 *
 * `write` is the callback for THIS key, captured while this key was the one on
 * screen; it is what a later flush uses, whatever the editor shows by then.
 */
export function setDocumentInfoDraft(
  key: string,
  text: { summary: string; description: string },
  base: DocumentInfo | null,
  write: DocumentInfoWrite,
): void {
  const prev = entries.get(key);
  entries.set(key, {
    draft: {
      summary: text.summary,
      description: text.description,
      // A draft keeps its original baseline while it lives: the diff is against
      // what the user started from, not against a write that is still in flight.
      base: prev ? prev.draft.base : base,
      saving: prev?.draft.saving ?? false,
      error: prev?.draft.error ?? null,
    },
    write,
    edit: (prev?.edit ?? 0) + 1,
    pending: prev?.pending ?? 0,
    queuedEdit: prev?.queuedEdit ?? 0,
  });
  emit();
}

/** Drop a draft without writing it. */
export function discardDocumentInfoDraft(key: string): void {
  if (entries.delete(key)) emit();
}

/**
 * Write the draft of `key`, queued behind any write of the same key.
 *
 * Resolves (never rejects) with the outcome. No draft, or a draft without a
 * text diff → `{ ok: true }` and nothing is written. On success the draft is
 * removed unless newer text was typed meanwhile; on failure it stays, with the
 * error, so the editor can show it and offer a retry.
 */
export function commitDocumentInfoDraft(key: string, write?: DocumentInfoWrite): Promise<DocumentInfoCommitResult> {
  const entry = entries.get(key);
  if (!entry) return Promise.resolve({ ok: true });
  if (write) entry.write = write;
  if (!isDocumentInfoDraftDirty(entry.draft)) {
    // Nothing to say — but a draft left over from a failed write that the user
    // has since typed back to the baseline is resolved by exactly this.
    if (entry.pending === 0) { entries.delete(key); emit(); }
    return Promise.resolve({ ok: true });
  }
  // This exact text is already queued (a blur, then an unmount flush): wait for
  // that write instead of queueing a second copy of it.
  if (entry.pending > 0 && entry.queuedEdit === entry.edit) {
    return (chains.get(key) ?? Promise.resolve()).then(() => {
      const after = entries.get(key);
      return after?.draft.error ? { ok: false, error: after.draft.error } : { ok: true };
    });
  }

  const next = draftToDocumentInfo(entry.draft);
  const editAtCommit = entry.edit;
  const run = entry.write;
  entry.pending += 1;
  entry.queuedEdit = editAtCommit;
  entry.draft = { ...entry.draft, saving: true };
  emit();

  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(async (): Promise<DocumentInfoCommitResult> => {
    try {
      await run(next);
      const current = entries.get(key);
      if (current) {
        current.pending -= 1;
        if (current.edit === editAtCommit && current.pending === 0) entries.delete(key);
        else current.draft = { ...current.draft, base: next, saving: current.pending > 0, error: null };
      }
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const current = entries.get(key);
      if (current) {
        current.pending -= 1;
        current.draft = { ...current.draft, saving: current.pending > 0, error: message };
      }
      return { ok: false, error: message };
    } finally {
      emit();
    }
  });
  chains.set(key, result.then(() => undefined));
  return result;
}

/**
 * Flush a draft on unmount / selection change — a commit with its own stored
 * write.
 *
 * A draft whose last write FAILED is not retried here: it waits, with its
 * error, for the user's explicit Retry when the document is shown again. An
 * unmount is not consent to hammer a refusing backend (or, after a project
 * switch, to try again against whatever is open now).
 */
export function flushDocumentInfoDraft(key: string): Promise<DocumentInfoCommitResult> {
  const entry = entries.get(key);
  if (entry?.draft.error && entry.pending === 0) {
    return Promise.resolve({ ok: false, error: entry.draft.error });
  }
  return commitDocumentInfoDraft(key);
}

/** Resolves once every queued write has settled — tests and shutdown only. */
export async function settleDocumentInfoDrafts(): Promise<void> {
  await Promise.all([...chains.values()]);
}

/** Forget every draft and queue — TESTS ONLY. */
export function resetDocumentInfoDraftsForTests(): void {
  entries.clear();
  chains.clear();
  emit();
}
