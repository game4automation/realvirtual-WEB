// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The `viewer.modes` slice any double needs once it renders the activity bar.
 *
 * `RVViewer.modes` is a `readonly ModeManager` constructed with the viewer, so
 * a double without it is not a smaller viewer — it is an impossible one. The
 * activity bar reads only the lock state, but it reads it through `useMode`,
 * which eagerly calls `list()` and subscribes on every render. A double that
 * answers `activeMode` and `subscribe` alone therefore passes until something
 * in the bar starts using the hook, and then fails with a bare
 * `viewer.modes.list is not a function` far from the test that caused it.
 *
 * Kept in one place so the four suites that render the bar cannot drift apart
 * on what a mode manager looks like.
 */
export interface ModeManagerDoubleOptions {
  /** Mode reported as active; also what `lockedMode` reports when locked. */
  activeMode?: string | null;
  /** Workspace pinned to one mode — the bar hides the switcher. */
  locked?: boolean;
}

export function modeManagerDouble(options: ModeManagerDoubleOptions = {}) {
  let activeMode = options.activeMode ?? null;
  return {
    get activeMode() { return activeMode; },
    setActive(id: string | null) { activeMode = id; },
    get lockedMode() { return options.locked ? activeMode : null; },
    list: () => [],
    requestMode: async () => {},
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
  };
}
