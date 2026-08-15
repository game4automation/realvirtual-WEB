// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * In-memory state of the shared link the page was opened with (plan-386).
 *
 * Deliberately **not persisted**. F7 is the whole point of the consumer path:
 * opening someone else's link must leave nothing behind on the visitor's
 * machine — not a draft, not an active-scene pointer, not a last-model entry,
 * and not a record of the share either. Reload the page without the parameter
 * and the visitor is back exactly where he was.
 *
 * The downloaded buffer lives here too, so the download button spends no second
 * network request (F14): the bytes are already in the tab.
 */

import type { SharedGlbInfo } from './rv-share-meta';
import type { SharedGlbPayload } from './rv-share-fetch';

export interface SharedGlbSnapshot {
  /** Set once the shared GLB is loaded and its card can be shown. */
  info: SharedGlbInfo | null;
  /** The one downloaded buffer, kept for the download button. */
  payload: SharedGlbPayload | null;
  /** A user-facing sentence when the link could not be opened (F15). */
  error: string | null;
  /** True while the shared file is being fetched. */
  loading: boolean;
}

const EMPTY: SharedGlbSnapshot = { info: null, payload: null, error: null, loading: false };

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: SharedGlbSnapshot = EMPTY;

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeSharedGlb(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getSharedGlbSnapshot(): SharedGlbSnapshot {
  return snapshot;
}

/** Mark the start of a shared-link boot — the card can show a placeholder. */
export function beginSharedGlbLoad(): void {
  snapshot = { ...EMPTY, loading: true };
  notify();
}

/** Publish the loaded share. The card appears from here on. */
export function setSharedGlb(info: SharedGlbInfo, payload: SharedGlbPayload): void {
  snapshot = { info, payload, error: null, loading: false };
  notify();
}

/**
 * Publish a failure.
 *
 * The card stays visible in this state on purpose: "this link is no longer
 * available" is information the visitor needs, and an empty viewport with a
 * console error is not.
 */
export function failSharedGlb(message: string): void {
  snapshot = { info: null, payload: null, error: message, loading: false };
  notify();
}

/** Drop the share (card dismissed, or another model opened). Frees the buffer. */
export function clearSharedGlb(): void {
  if (snapshot === EMPTY) return;
  snapshot = EMPTY;
  notify();
}
