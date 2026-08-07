// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * assets-sections-store — which Assets-tab library sections are collapsed
 * (plan-702 Phase 1, F2).
 *
 * A module singleton with a listener set and a version counter, the same shape
 * `library-source-registry.ts` uses: `useSyncExternalStore` compares snapshots
 * by identity, so a getter that built a fresh object would re-render forever.
 *
 * Deliberately its OWN module rather than a few fields on
 * `projects-dashboard-store.ts`: that store persists nothing at all today, and
 * teaching it persistence would change behaviour nobody asked to change.
 *
 * ## Persist the exception, not the norm
 *
 * Only COLLAPSED keys are stored. An unknown key reads as expanded, so a
 * missing entry — a fresh browser, a cleared storage, a library attached one
 * second ago — means "open". Storing the open ones instead would make every
 * newly attached library appear as a closed header the user has to find.
 *
 * ## The transient layer is what keeps search from rewriting the user's state
 *
 * While a search is active the section a user collapses is collapsed for the
 * duration of that search only (§2.6 point 3). Writing it through would mean
 * that clearing the search box leaves sections shut that the user only ever
 * closed to get them out of the way of one query.
 */

import { lsLoad, lsSave } from '../ls-store-utils';
import { ASSETS_SECTIONS_COLLAPSED_KEY } from '../rv-storage-keys';

/**
 * The persisted shape.
 *
 * An OBJECT with one array field, not a bare array: `lsLoad` merges the parsed
 * JSON over a defaults object and explicitly rejects a top-level array, so a
 * bare `string[]` would silently read back as the defaults every time.
 */
interface CollapsedState {
  collapsed: string[];
}

const DEFAULTS: CollapsedState = { collapsed: [] };

const listeners = new Set<() => void>();
/** Persisted collapse set. */
let collapsed = new Set<string>(lsLoad(ASSETS_SECTIONS_COLLAPSED_KEY, DEFAULTS, {
  validate: (merged) => ({
    collapsed: Array.isArray(merged.collapsed)
      ? merged.collapsed.filter((k): k is string => typeof k === 'string')
      : [],
  }),
}).collapsed);
/** Search-scoped overrides. NEVER persisted. */
const transient = new Map<string, boolean>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

function persist(): void {
  lsSave(ASSETS_SECTIONS_COLLAPSED_KEY, { collapsed: [...collapsed] } satisfies CollapsedState);
}

/** Is this section collapsed? Unknown keys are expanded — see the file header. */
export function isSectionCollapsed(groupKey: string): boolean {
  return collapsed.has(groupKey);
}

/**
 * Effective collapse state for a render.
 *
 * While `searchActive`, the persisted set is neither read nor written: an
 * unvisited section is open (so a match is visible without a click) and only an
 * explicit toggle during this search closes it again.
 */
export function isSectionCollapsedEffective(groupKey: string, searchActive: boolean): boolean {
  if (!searchActive) return collapsed.has(groupKey);
  return transient.get(groupKey) ?? false;
}

/** Toggle a section, routing to the persisted or the transient layer. */
export function toggleSection(groupKey: string, searchActive = false): void {
  if (searchActive) {
    transient.set(groupKey, !(transient.get(groupKey) ?? false));
    bump();
    return;
  }
  if (collapsed.has(groupKey)) collapsed.delete(groupKey);
  else collapsed.add(groupKey);
  persist();
  bump();
}

/** Set a search-scoped collapse state directly. Never persisted. */
export function setTransientCollapsed(groupKey: string, value: boolean): void {
  transient.set(groupKey, value);
  bump();
}

/** Drop every search-scoped override — called when the search box is emptied. */
export function clearTransient(): void {
  if (transient.size === 0) return;
  transient.clear();
  bump();
}

/**
 * Forget collapse state for libraries that no longer exist.
 *
 * Without this the set grows for the lifetime of the browser profile, and a
 * URL re-added months later would come back mysteriously collapsed.
 */
export function pruneSections(knownKeys: readonly string[]): void {
  const known = new Set(knownKeys);
  let changed = false;
  for (const key of [...collapsed]) {
    if (!known.has(key)) { collapsed.delete(key); changed = true; }
  }
  for (const key of [...transient.keys()]) {
    if (!known.has(key)) transient.delete(key);
  }
  if (!changed) return;
  persist();
  bump();
}

export function subscribeAssetsSections(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Version counter — NOT an object. See the file header. */
export function getAssetsSectionsSnapshot(): number {
  return version;
}

/** Test seam — drops both layers and re-reads nothing. */
export function resetAssetsSectionsForTests(): void {
  collapsed = new Set<string>();
  transient.clear();
  listeners.clear();
  version = 0;
}

/** Test seam — re-read localStorage after a test wrote it directly. */
export function reloadAssetsSectionsForTests(): void {
  collapsed = new Set<string>(lsLoad(ASSETS_SECTIONS_COLLAPSED_KEY, DEFAULTS, {
    validate: (merged) => ({
      collapsed: Array.isArray(merged.collapsed)
        ? merged.collapsed.filter((k): k is string => typeof k === 'string')
        : [],
    }),
  }).collapsed);
  transient.clear();
  bump();
}
