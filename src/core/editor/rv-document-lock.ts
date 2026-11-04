// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-lock — the document lock vocabulary (plan-462 B3; `replace` from
 * plan-527, ported for plan-764).
 *
 * Lifted out of `rv-asset-document.ts` unchanged, so the SCENE lineage
 * (`SceneStore`) can refuse mutations with the very same error class and
 * sentences while a document is being replaced from outside — without pulling
 * the editor document's executor graph into the scene store's runtime imports.
 * `rv-asset-document.ts` re-exports every name, so existing imports keep working
 * and `instanceof DocumentLockedError` holds across both lineages.
 */

/**
 * What a lock is being held FOR. All kinds exclude each other, and each
 * excludes a second holder of the same kind — see {@link AssetDocument.tryLock}.
 *
 * `replace` (plan-527) is held while the document's FILE is being replaced from
 * outside (`rv-document-replace`): fetch, full parse, compare-and-swap write,
 * reload.
 * Like `test-run` it refuses every mutation (edit, undo, redo, rename, save
 * marking), because whatever is applied in that window lands on a document that
 * is about to be swapped for the new bytes and would be lost without a word.
 */
export type DocumentLockKind = 'test-run' | 'save' | 'replace';

/** The receipt {@link AssetDocument.tryLock} hands out. Opaque on purpose. */
export interface DocumentLockToken {
  readonly kind: DocumentLockKind;
  readonly token: symbol;
  readonly generation: number;
}

/** What a caller may know about a lock it does not hold. */
export interface DocumentLockOwner {
  readonly kind: DocumentLockKind;
  readonly startedAt: number;
}

/** The machine-readable code every refusal carries. */
export const ERR_DOCUMENT_LOCKED = 'ERR_DOCUMENT_LOCKED';

/**
 * A mutation was refused because something else owns the document.
 *
 * Thrown, not returned, and never swallowed: the whole point of plan-462 B3 is
 * that an edit made during a test run stops being accepted-then-silently-lost.
 * An MCP tool turns it into its JSON envelope, the UI into a toast; both read
 * {@link code}.
 */
export class DocumentLockedError extends Error {
  readonly code = ERR_DOCUMENT_LOCKED;

  constructor(readonly owner: DocumentLockOwner, message: string) {
    super(message);
    this.name = 'DocumentLockedError';
  }
}

/** The operator-facing half of a refusal — one sentence per owner kind. */
export function documentLockedMessage(owner: DocumentLockOwner, what: string): string {
  if (owner.kind === 'replace') {
    return `${what} was refused: this document is being replaced from outside (a new version `
      + 'is being written and reloaded). An edit accepted now would be applied to the version '
      + 'that is about to be replaced and lost. Wait for the replace to finish, then repeat the edit.';
  }
  if (owner.kind === 'test-run') {
    return `${what} was refused: a test run is active (in-place test session). The test session `
      + 'freezes the document history at start and puts it back verbatim on stop, so an edit '
      + 'accepted now would be discarded together with the test scene. Stop the test run first, '
      + 'then repeat the edit.';
  }
  return `${what} was refused: this document is being saved. Wait for the save to finish, then `
    + 'repeat the operation.';
}
