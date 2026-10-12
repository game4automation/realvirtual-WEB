// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Tiny global store for HMI overlay visibility (persisted in localStorage). */

import { useEffect, useSyncExternalStore } from 'react';
import { getActiveAssetContext } from '../editor/active-asset-store';
import { isEditableTarget } from './search-shortcut';

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

/** Subscribe to HMI visibility changes (non-React). Returns an unsubscribe fn. */
export function subscribeHmiVisible(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook — triggers re-render when visibility changes. */
export function useHmiVisible(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => visible,
  );
}

/**
 * Whether a keydown is the "hide/show HMI" shortcut **H** (the eye button's
 * tooltip has promised it all along). Not while typing, not with a modifier
 * (browser and OS accelerators), and not in the asset editor, where **H**
 * already hides the selected node. Pure — unit-tested.
 */
export function isHmiToggleKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>,
  ctx: { typing: boolean; editorActive: boolean },
): boolean {
  if (e.key !== 'h' && e.key !== 'H') return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat) return false;
  return !ctx.typing && !ctx.editorActive;
}

/** Mounts the global **H** shortcut that hides and shows the HMI overlay. */
export function useHmiToggleShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isHmiToggleKey(e, { typing: isEditableTarget(e.target), editorActive: getActiveAssetContext() !== null })) return;
      e.preventDefault();
      toggleHmiVisible();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
