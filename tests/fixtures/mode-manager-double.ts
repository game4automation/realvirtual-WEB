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
 * A second incident followed when commit b4edac68 ("per-document workspace-mode
 * restriction") introduced `ModeManager.available()`: the shared double fell
 * behind again. The measured surface is therefore every
 * `.modes.([A-Za-z_][A-Za-z0-9_]*)` hit in `src` and the sibling private
 * checkout's `src` (17 members today), excluding the verified
 * `plugin.modes` string-array hits for `includes`, `length`, and `map`.
 * `tests/mode-manager-double-surface.node.test.ts` enforces that rule.
 *
 * plan-900 E18 deliberately models only `available`. The other newly surfaced
 * members throw: a neutral stub is not protection. No current path calls those
 * members, but a future test could otherwise take a path the real manager never
 * would and silently stay green even though `register`, `setMode`, and `lock`
 * mutate real state. A throwing stub makes that path loudly red and forces the
 * behavior to be modelled deliberately. The surface invariant checks presence
 * only and never invokes a member, so throwing stubs satisfy it.
 *
 * Kept in one place so suites that render shared viewer UI cannot drift apart
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
    // The real available() is list().filter(isAllowed); without a document
    // restriction nothing is filtered, so it is the same empty list here.
    available: () => [],
    setMode: (_id: string): void => {
      throw new Error('mode-manager-double: setMode is not modelled — model it deliberately (plan-900 R10)');
    },
    register: (_descriptor: unknown): never => {
      throw new Error('mode-manager-double: register is not modelled — model it deliberately (plan-900 R10)');
    },
    descriptor: (_id: string): never => {
      throw new Error('mode-manager-double: descriptor is not modelled — model it deliberately (plan-900 R10)');
    },
    has: (_id: string): boolean => {
      throw new Error('mode-manager-double: has is not modelled — model it deliberately (plan-900 R10)');
    },
    restrictedFallback: (): string | null => {
      throw new Error('mode-manager-double: restrictedFallback is not modelled — model it deliberately (plan-900 R10)');
    },
    releaseSwitchLock: (_token: symbol): void => {
      throw new Error('mode-manager-double: releaseSwitchLock is not modelled — model it deliberately (plan-900 R10)');
    },
    registerExitGuard: (_modeId: string, _guard: unknown): (() => void) => {
      throw new Error('mode-manager-double: registerExitGuard is not modelled — model it deliberately (plan-900 R10)');
    },
    lock: (_id: string): void => {
      throw new Error('mode-manager-double: lock is not modelled — model it deliberately (plan-900 R10)');
    },
    acquireSwitchLock: (): symbol | null => {
      throw new Error('mode-manager-double: acquireSwitchLock is not modelled — model it deliberately (plan-900 R10)');
    },
    requestMode: async () => {},
    // plan-652: the awaited switch, enter guards and the boot's restore target.
    setModeAsync: async (id: string) => { activeMode = id; return true; },
    registerEnterGuard: () => () => undefined,
    peekRestoreTarget: (fallback = 'hmi') => activeMode ?? fallback,
    subscribe: () => () => undefined,
    getSnapshot: () => 0,
  };
}
