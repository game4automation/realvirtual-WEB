// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Tiny store for message panel open/close and minimized state (not persisted). */

import { useSyncExternalStore } from 'react';

let open = true;
let minimized = false;
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

export function toggleMessagePanelMinimized(): void {
  minimized = !minimized;
  notify();
}

export function getMessagePanelMinimized(): boolean {
  return minimized;
}

/** React hook — triggers re-render when message panel visibility changes. */
export function useMessagePanelOpen(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => open,
  );
}

/** React hook — triggers re-render when minimized state changes. */
export function useMessagePanelMinimized(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => minimized,
  );
}
