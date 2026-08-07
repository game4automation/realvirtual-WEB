// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-shortcut — keyboard route to the global search (BottomBar).
 *
 * `/` (Onshape pattern) and Ctrl/Cmd+K (familiar command-palette pattern)
 * expand + focus the global search field. Pure predicate so the guard is
 * unit-testable: it must NEVER fire while the user is typing in any input
 * context (input, textarea, contenteditable) — otherwise `/` steals focus
 * mid-sentence. The caller `preventDefault()`s on a match (Firefox quick
 * find, double-typed `/`).
 */

/** Structural event subset — accepts both DOM KeyboardEvent and test doubles. */
export interface SearchShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** True when the event target sits in an editable context (guard). */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') !== null;
}

/**
 * True when this keydown should open the global search:
 * bare `/` or Ctrl/Cmd+K — and the focus is NOT in an editable element.
 */
export function isSearchShortcut(e: SearchShortcutEvent): boolean {
  const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
  const isCtrlK = (e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey;
  if (!isSlash && !isCtrlK) return false;
  return !isEditableTarget(e.target);
}
