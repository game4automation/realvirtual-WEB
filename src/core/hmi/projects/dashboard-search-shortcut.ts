// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * dashboard-search-shortcut — `/` and Ctrl/Cmd+K belong to the open dashboard
 * (plan-507 F12).
 *
 * The same keys focus the scene search in the BottomBar, which keeps listening
 * while the dashboard covers the scene. With the dashboard up, the scene search
 * is behind it, so the press must reach the dashboard's own field instead.
 *
 * ## Capture phase plus `preventDefault`, not an ordering assumption
 *
 * Both listeners sit on `document`. This one registers in the CAPTURE phase and
 * marks the event it takes; the BottomBar's bubble listener asks
 * `isUnclaimedSearchShortcut` and steps aside. Neither depends on which
 * component mounted first.
 *
 * ## Only when the field is really there
 *
 * Each screen has its own field and calls this hook with its own ref and its
 * own `active` answer: the project screen, and since plan-509 the Projects
 * screen's model search ({@link projectsScreenActive}). The hook still claims
 * the key only when its input is CONNECTED — otherwise the press falls through
 * to the scene search exactly as before, instead of being swallowed.
 */

import { useEffect, type RefObject } from 'react';
import { isSearchShortcut, type SearchShortcutEvent } from '../search-shortcut';

/** Should this keydown focus the dashboard search field? Pure — the guard under test. */
export function shouldFocusDashboardSearch(
  e: SearchShortcutEvent,
  dashboardOpen: boolean,
  projectView: boolean,
): boolean {
  return dashboardOpen && projectView && isSearchShortcut(e);
}

/**
 * Is the dashboard showing the Projects screen (the project list)?
 *
 * The SAME condition the host renders that screen under — not
 * `view === 'projects'`: on the first open without a project `view` still
 * says `'project'`, and the list is what is on screen (plan-509 SOL R2 F4).
 */
export function projectsScreenActive(
  dash: { open: boolean; view: string },
  hasOpenProject: boolean,
): boolean {
  return dash.open && !(dash.view === 'project' && hasOpenProject);
}

/**
 * Capture-phase document listener: on `/` or Ctrl/Cmd+K, focus and select the
 * input. `active` is the host's "dashboard open on a project" answer.
 */
export function useDashboardSearchShortcut(
  inputRef: RefObject<HTMLInputElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!shouldFocusDashboardSearch(e, true, true)) return;
      const input = inputRef.current;
      if (!input?.isConnected) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [inputRef, active]);
}
