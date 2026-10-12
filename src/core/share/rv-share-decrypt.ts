// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The decryptor seam of an encrypted `?glb=` link (plan-560).
 *
 * A shared GLB may arrive as an RVE1 envelope (the format of the hosted deploy,
 * plan-759). Opening one needs the password prompt, which the public edition
 * does not wire to the share path: the public build only RECOGNISES the
 * envelope and says it cannot open it. A commercial build installs the real
 * decryptor here from its feature adapter (`share-decrypt.register.ts`), and
 * no other public file changes.
 *
 * Same shape as `setShareIdResolver` (rv-share-target.ts): a module variable
 * whose setter returns an un-register function, so a test can install a fake
 * and put the module back exactly as it found it.
 */

/** Why a decryptor refused to deliver plaintext. */
export type ShareDecryptErrorCode = 'link-incomplete' | 'cancelled' | 'damaged';

/**
 * Typed rejection of a decryptor (plan-560 §2.3). Defined here, next to the
 * seam, so the public boot can map it without importing the password prompt;
 * `password-gate.tsx` re-exports it as the place that throws it.
 */
export class ShareDecryptError extends Error {
  readonly code: ShareDecryptErrorCode;

  constructor(code: ShareDecryptErrorCode, message: string) {
    super(message);
    this.name = 'ShareDecryptError';
    this.code = code;
  }
}

/**
 * Turns envelope bytes into the plaintext GLB, or rejects. A rejection with a
 * `ShareDecryptError` (password-gate.tsx) carries a code the boot maps onto the
 * card's sentences; anything else surfaces as "damaged".
 */
export type SharedGlbDecryptor = (envelope: ArrayBuffer) => Promise<ArrayBuffer>;

let decryptor: SharedGlbDecryptor | null = null;

/** Install (or clear, with `null`) the decryptor; returns the un-register function. */
export function setSharedGlbDecryptor(next: SharedGlbDecryptor | null): () => void {
  const previous = decryptor;
  decryptor = next;
  return () => { decryptor = previous; };
}

/** The installed decryptor, or `null` in an edition that cannot open encrypted links. */
export function getSharedGlbDecryptor(): SharedGlbDecryptor | null {
  return decryptor;
}
