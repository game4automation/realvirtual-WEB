// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Tiny global store for HMI overlay visibility (persisted in localStorage). */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'rv-hmi-visible';

let visible = loadInitial();
const listeners = new Set<() => void>();

function loadInitial(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function notify() {
  for (const fn of listeners) fn();
}

export function toggleHmiVisible(): void {
  visible = !visible;
  try { localStorage.setItem(STORAGE_KEY, visible ? '1' : '0'); } catch { /* ignore */ }
  notify();
}

export function getHmiVisible(): boolean {
  return visible;
}

/** React hook — triggers re-render when visibility changes. */
export function useHmiVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => visible,
  );
}
