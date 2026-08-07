// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-result-grouping — pure grouping of global-search results for the
 * BottomBar dropdown ("Drives (4)", "Signals (6)", "Objects (28)", …).
 *
 * A flat 20-row dump mixes drives, signals and plain nodes without visual
 * anchor points; grouping by category makes the dropdown scannable. Pure and
 * structural (only `types`/`matchedBy` are read) so it is unit-testable
 * without Three.js. The flattened group order (groups in priority order,
 * items in original relevance order inside each group) is the SINGLE order
 * both rendering and keyboard navigation use — `startIndex` maps a group's
 * first item into that flat order.
 */

/** Structural subset of NodeSearchResult the grouping reads. */
export interface GroupableResult {
  /** Registered component types at this path. Empty for plain nodes. */
  types: string[];
  /** Which source matched: component type key, or undefined for name matches. */
  matchedBy?: string;
}

export interface SearchResultGroup<T extends GroupableResult> {
  label: string;
  /** Index of the group's first item in the flattened (rendered) order. */
  startIndex: number;
  items: T[];
}

/** Group label for the untyped rest — always sorted last. */
export const OBJECTS_GROUP = 'Objects';

/** Fixed group order for the common categories; others follow alphabetically. */
const GROUP_PRIORITY = ['Drives', 'Sensors', 'Conveyors', 'Signals', 'Logic'];

/** Category label for one search result. */
export function searchGroupLabel(result: GroupableResult): string {
  const t = result.matchedBy ?? result.types[0] ?? '';
  if (!t || t === 'Node') return OBJECTS_GROUP;
  if (t === 'Drive' || t.startsWith('Drive_') || t === 'DrivesRecorder') return 'Drives';
  if (t === 'Sensor') return 'Sensors';
  if (t === 'TransportSurface') return 'Conveyors';
  if (t.startsWith('PLCInput') || t.startsWith('PLCOutput') || t === 'ConnectSignal') return 'Signals';
  if (t.startsWith('LogicStep')) return 'Logic';
  // Other component types group under their own type key (e.g. "AASLink").
  return t;
}

function groupRank(label: string): number {
  const p = GROUP_PRIORITY.indexOf(label);
  if (p !== -1) return p;
  return label === OBJECTS_GROUP ? GROUP_PRIORITY.length + 1 : GROUP_PRIORITY.length;
}

/**
 * Group results by category. Group order: Drives, Sensors, Conveyors,
 * Signals, Logic, other types (alphabetical), Objects last. Item order
 * inside a group preserves the input (relevance) order.
 */
export function groupSearchResults<T extends GroupableResult>(
  results: T[],
): SearchResultGroup<T>[] {
  const byLabel = new Map<string, T[]>();
  for (const r of results) {
    const label = searchGroupLabel(r);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(r);
    else byLabel.set(label, [r]);
  }
  const labels = [...byLabel.keys()].sort((a, b) => {
    const ra = groupRank(a);
    const rb = groupRank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  let index = 0;
  return labels.map((label) => {
    const items = byLabel.get(label)!;
    const group: SearchResultGroup<T> = { label, startIndex: index, items };
    index += items.length;
    return group;
  });
}

/** The flattened item order matching the rendered group order. */
export function flattenGroupedResults<T extends GroupableResult>(
  groups: SearchResultGroup<T>[],
): T[] {
  const flat: T[] = [];
  for (const g of groups) flat.push(...g.items);
  return flat;
}
