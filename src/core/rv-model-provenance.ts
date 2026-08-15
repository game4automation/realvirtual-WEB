// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Where the model **currently on screen** came from (plan-423 F6).
 *
 * ## Why this is not `RVViewer.loadTrust`
 *
 * `loadTrust` (rv-load-trust.ts) is deliberately valid only *during* a load:
 * `withLoadTrust` restores the previous context in a `finally`, so the moment
 * `loadModel()` returns the viewer reads `{ trusted: true }` again. That is
 * correct for what it gates — the side effects it stops all happen inside the
 * load — and it makes it useless as the source for anything the USER sees
 * afterwards. A banner reading `loadTrust` would never appear (review finding
 * SOL-R1 F1).
 *
 * This is the persistent counterpart: set once at the end of a load, carried
 * until the next one, and the only thing the trust banner and its revocation
 * are allowed to read.
 *
 * ## Why it carries an identity, not just a flag
 *
 * A boolean cannot be revoked. Withdrawing a trust decision means deleting one
 * specific record, and only the load path knows which one — the share id (or
 * the normalised own-URL) plus the digest of the bytes that were actually
 * loaded. Carrying both here is what lets the revoke button delete EXACTLY the
 * entry that produced this state and nothing else (SOL-R2 F2).
 */

import { useSyncExternalStore } from 'react';

/** How the bytes on screen reached this page. */
export type ModelProvenanceSource = 'share' | 'own-url' | 'local';

export interface ModelProvenance {
  /**
   * Whether live connections are allowed for this model — the persistent echo
   * of the `LoadTrustContext` the load ran under.
   */
  trusted: boolean;
  source: ModelProvenanceSource;
  /** Storage key of the trust decision: `share:<id>` or `url:<normalised>`. */
  trustRecordKey?: string;
  /** Lowercase hex SHA-256 of the loaded bytes; absent when it could not be computed. */
  digest?: string;
  /** Host the bytes came from, for the banner's plain-language sentence. */
  sourceOrigin?: string;
}

/**
 * The default for every ordinary load: the visitor's own content, trusted, with
 * no record behind it — so the banner never appears and there is nothing to
 * revoke.
 */
export const LOCAL_PROVENANCE: ModelProvenance = Object.freeze({
  trusted: true,
  source: 'local',
});

// ─── Store (the React side) ───────────────────────────────────────────────

const listeners = new Set<() => void>();
let state: ModelProvenance = LOCAL_PROVENANCE;

export function getModelProvenance(): ModelProvenance {
  return state;
}

/**
 * Publish a new provenance. Written by `RVViewer` only.
 *
 * Identical states are dropped: `useSyncExternalStore` re-renders on every
 * notification, and a load that ends where it started is the common case.
 */
export function setModelProvenance(next: ModelProvenance): void {
  if (
    state.trusted === next.trusted
    && state.source === next.source
    && state.trustRecordKey === next.trustRecordKey
    && state.digest === next.digest
    && state.sourceOrigin === next.sourceOrigin
  ) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Back to "the visitor's own content" — used by `clearModel()`. */
export function resetModelProvenance(): void {
  setModelProvenance(LOCAL_PROVENANCE);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useModelProvenance(): ModelProvenance {
  return useSyncExternalStore(subscribe, getModelProvenance, getModelProvenance);
}
