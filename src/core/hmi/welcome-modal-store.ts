// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * welcome-modal-store — Pub/sub tracker for WelcomeModal visibility.
 *
 * KioskPlugin subscribes to this store to pause its idle detector while the
 * WelcomeModal is open (prevents auto-kiosk-start while the user sees the
 * blocking welcome dialog). WelcomeModal calls setWelcomeModalOpen() from a
 * useEffect so open/close transitions are captured reliably.
 *
 * Pattern matches `pdf-viewer-store.tsx` / `message-panel-store.ts` /
 * `instruction-store.ts` (module-level state + useSyncExternalStore).
 */

import { useSyncExternalStore } from 'react';

let _isOpen = false;
const _listeners = new Set<() => void>();

/** Set the modal open state. Called by WelcomeModal.tsx in a useEffect. */
export function setWelcomeModalOpen(open: boolean): void {
  if (_isOpen === open) return;
  _isOpen = open;
  for (const l of _listeners) {
    try { l(); } catch (e) { console.error('[welcome-modal-store] listener threw:', e); }
  }
}

/** Subscribe to visibility changes. Returns unsubscribe function. */
export function subscribeWelcomeModal(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Current visibility state (synchronous snapshot). */
export function isWelcomeModalOpen(): boolean { return _isOpen; }

/** React hook — returns live visibility state. */
export function useWelcomeModalOpen(): boolean {
  return useSyncExternalStore(subscribeWelcomeModal, isWelcomeModalOpen, isWelcomeModalOpen);
}

/** @internal — test-only reset. */
export function _resetWelcomeModalForTests(): void {
  if (import.meta.env.PROD) {
    throw new Error('_resetWelcomeModalForTests() must not be called in production');
  }
  _isOpen = false;
  _listeners.clear();
}
