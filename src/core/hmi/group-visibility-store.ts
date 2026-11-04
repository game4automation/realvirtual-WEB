// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { writeLocalStorage } from '../rv-safe-storage';

/**
 * group-visibility-store.ts — Persists group visibility state to localStorage.
 *
 * Stores which groups are hidden and which group (if any) is isolated,
 * so the state survives page reloads. Follows the same pattern as
 * visual-settings-store.ts.
 */

import { lsLoad } from './ls-store-utils';

const STORAGE_KEY = 'rv-group-visibility';

export interface GroupVisibilitySettings {
  /** Names of groups that are currently hidden. */
  hiddenGroups: string[];
  /** Name of the isolated group (only this group visible), or null. */
  isolatedGroup: string | null;
  /** Groups excluded from the Groups overlay panel. */
  excludedFromOverlay?: string[];
  /** The subset of `excludedFromOverlay` the panel added ITSELF because a drive
   *  moved the group (structural kinematic groups). Only these are released
   *  again when a later load says the group is not driven any more; a name the
   *  user excluded by hand in Settings → Groups is never touched. */
  autoExcludedKinematic?: string[];
  /** Groups hidden by default when a model loads. */
  defaultHiddenGroups?: string[];
  /** Component type keys of hidden auto-filter groups (e.g. 'Drive', 'Sensor'). */
  hiddenAutoFilters?: string[];
  /** Component type key of the isolated auto-filter, or null. */
  isolatedAutoFilter?: string | null;
}

const DEFAULTS: GroupVisibilitySettings = {
  hiddenGroups: [],
  isolatedGroup: null,
  excludedFromOverlay: [],
  defaultHiddenGroups: [],
  hiddenAutoFilters: [],
  isolatedAutoFilter: null,
};

/**
 * Load group visibility settings from localStorage.
 * Returns defaults if nothing saved or data is corrupted.
 */
export function loadGroupVisibilitySettings(): GroupVisibilitySettings {
  return lsLoad<GroupVisibilitySettings>(STORAGE_KEY, DEFAULTS, {
    // Coerce non-array fields back to [] and non-string isolated* fields to null
    // (mirrors the prior defensive parsing).
    validate: (_merged, parsed) => {
      const fixed: Partial<GroupVisibilitySettings> = {};
      if (!Array.isArray(parsed.hiddenGroups)) fixed.hiddenGroups = [];
      if (typeof parsed.isolatedGroup !== 'string') fixed.isolatedGroup = null;
      if (!Array.isArray(parsed.excludedFromOverlay)) fixed.excludedFromOverlay = [];
      // `undefined` is meaningful (legacy profile, see applyPersistedGroupVisibility);
      // anything else that is not a string array is dropped, never handed on.
      if (parsed.autoExcludedKinematic !== undefined
        && !(Array.isArray(parsed.autoExcludedKinematic) && parsed.autoExcludedKinematic.every(x => typeof x === 'string'))) {
        // The validator's result is spread OVER the merged object, so an
        // explicit `undefined` is what removes the malformed value.
        fixed.autoExcludedKinematic = undefined;
      }
      if (!Array.isArray(parsed.defaultHiddenGroups)) fixed.defaultHiddenGroups = [];
      if (!Array.isArray(parsed.hiddenAutoFilters)) fixed.hiddenAutoFilters = [];
      if (typeof parsed.isolatedAutoFilter !== 'string') fixed.isolatedAutoFilter = null;
      return fixed;
    },
  });
}

/**
 * Save group visibility settings to localStorage.
 *
 * Intentionally no isSettingsLocked() guard — the prior implementation did
 * not enforce one (group visibility is a runtime UI affordance, not a
 * configuration), keep behavior unchanged.
 */
export function saveGroupVisibilitySettings(settings: GroupVisibilitySettings): void {
  try {
    writeLocalStorage(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* quota exceeded — silently ignore */ }
  for (const cb of _listeners) {
    try { cb(); } catch { /* a listener must not break the save */ }
  }
}

const _listeners = new Set<() => void>();

/**
 * Be told after every {@link saveGroupVisibilitySettings}. The Display panel
 * filters its Groups list by `excludedFromOverlay`, and until 2026-09-24 it
 * read that list inside a memo keyed on the group array only — a change made
 * in Settings → Groups or by an MCP tool stayed invisible until the list
 * happened to rebuild (pick-and-place cell `Cover`). Returns the unsubscribe.
 */
export function subscribeGroupVisibilitySettings(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}
