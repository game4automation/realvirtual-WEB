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
import { createStore } from './create-store';
import { setStartupModalOpen } from './startup-modal-coordinator';
import { modeContext } from '../rv-mode-manager';
import type { UIVisibilityRule } from './ui-context-store';

const _store = createStore<boolean>(false);

// ─── Auto-open gate (plan-387) ──────────────────────────────────────────

/**
 * Visibility id for the AUTOMATIC first-visit opening of the welcome dialog.
 * Stable so a deployment can override the rule via `ui.visibilityOverrides`.
 */
export const WELCOME_AUTO_OPEN_UI_ELEMENT_ID = 'welcome-auto-open';

/**
 * Where the welcome dialog is NOT allowed to open itself.
 *
 * The dialog is a product pitch that offers an "HMI Demo" and a "Planner Demo"
 * — the latter an authoring entry point. A stranger following a shared Viewer
 * link must land on the running machine, not on that (plan-387 F4). Only the
 * automatic opening is gated: the logo/About click path stays intact in every
 * workspace, which is why this is a rule on its own id and not a gate on the
 * LogoBadge element.
 *
 * `hiddenIn` fails OPEN, deliberately: the CONNECT embed path skips mode boot
 * entirely, so no `mode:*` context is ever active there and its pre-387
 * behaviour is preserved.
 */
export const WELCOME_AUTO_OPEN_VISIBILITY_RULE: UIVisibilityRule = {
  hiddenIn: [modeContext('viewer')],
};

/** Set the modal open state. Called by WelcomeModal.tsx in a useEffect. */
export function setWelcomeModalOpen(open: boolean): void {
  if (_store.getSnapshot() === open) return;
  _store.set(() => open);
  setStartupModalOpen('welcome', open);
}

/** Subscribe to visibility changes. Returns unsubscribe function. */
export function subscribeWelcomeModal(listener: () => void): () => void {
  return _store.subscribe(listener);
}

/** Current visibility state (synchronous snapshot). */
export function isWelcomeModalOpen(): boolean {
  return _store.getSnapshot();
}

/** React hook — returns live visibility state. */
export function useWelcomeModalOpen(): boolean {
  return useSyncExternalStore(subscribeWelcomeModal, isWelcomeModalOpen, isWelcomeModalOpen);
}

/** @internal — test-only reset. */
export function _resetWelcomeModalForTests(): void {
  if (import.meta.env.PROD) {
    throw new Error('_resetWelcomeModalForTests() must not be called in production');
  }
  _store.set(() => false);
  setStartupModalOpen('welcome', false);
}
