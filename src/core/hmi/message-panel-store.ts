// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Tiny store for message panel open/close state (not persisted). */

import { useSyncExternalStore } from 'react';

let open = true;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

export function toggleMessagePanel(): void {
  open = !open;
  notify();
}

export function getMessagePanelOpen(): boolean {
  return open;
}

/** React hook — triggers re-render when message panel visibility changes. */
export function useMessagePanelOpen(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => open,
  );
}
