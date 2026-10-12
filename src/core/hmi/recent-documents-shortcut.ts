// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * recent-documents-shortcut — keyboard route to the Quick-Open popover
 * (plan-478 F4).
 *
 * `Ctrl/Cmd+Shift+F` (user decision 2026-09-11). The obvious `Ctrl+Shift+O` is
 * Chrome's bookmark manager and `Ctrl+Shift+T` reopens a closed tab, so both
 * would be swallowed before this app ever saw them; `Ctrl+Shift+F` is free in
 * Chrome, Firefox and Edge and is the shortcut editors already spend on "find
 * across everything", which is what this is — across projects.
 *
 * A pure predicate, exactly like `search-shortcut.ts`, so the guard that makes
 * it safe is unit-testable rather than buried in a listener: it must NEVER fire
 * while the user is typing, or a rename in the project tree loses its `F` and
 * gains a popover.
 */

import { isEditableTarget, type SearchShortcutEvent } from './search-shortcut';

/**
 * The event subset this predicate needs.
 *
 * `SearchShortcutEvent` plus `shiftKey`: the search shortcuts deliberately do
 * not look at Shift (a bare `/` is typed with it on some layouts), this combo
 * is defined by it. Structural, so a DOM `KeyboardEvent` and a test double are
 * both accepted.
 */
export interface RecentDocumentsShortcutEvent extends SearchShortcutEvent {
  shiftKey: boolean;
}

/**
 * True when this keydown should open the recent-documents popover.
 *
 * `e.key` is compared case-insensitively because Shift is part of the combo:
 * a browser reports `'F'` for Ctrl+Shift+F on most layouts and `'f'` on some,
 * and matching only one of them makes the shortcut work on one machine and not
 * the next. `altKey` is excluded so `Ctrl+Alt+Shift+F` — a plausible OS or
 * window-manager binding — passes through untouched.
 */
export function isRecentDocumentsShortcut(e: RecentDocumentsShortcutEvent): boolean {
  if (e.key !== 'f' && e.key !== 'F') return false;
  if (!e.shiftKey) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.altKey) return false;
  return !isEditableTarget(e.target);
}
