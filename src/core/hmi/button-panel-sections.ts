// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Sections of the floating tool toolbar (`button-group` slot, plan-2010).
 *
 * Pure TypeScript, no React: `ButtonPanel` turns the registry's entries into
 * sections with {@link computeToolSections} and renders one wrapper per section;
 * the dividers between them are CSS (`:empty` + sibling selector), because a
 * slot component may render `null` and a divider computed from the entry list
 * would then stand doubled or at the edge (the trap `withDividers` documents in
 * `action-group.tsx`).
 *
 * Order (decision E1): sections follow a fixed RANK table, not the entries'
 * `order` values — Section/Clip (65), the PLC editor (60), the planner tools
 * (200-300) and the DES tools (50-53) would otherwise interleave differently in
 * every mode. `order` only sorts entries WITHIN a section (the registry already
 * delivers them sorted). Ungrouped entries form an implicit FIRST section
 * (decision E2), so a toolbar without any group looks exactly as before.
 */

import type { UISlotEntry } from '../rv-ui-plugin';
import { evaluateVisibilityRule } from './ui-context-store';

/** The well-known toolbar groups. Any other `group` string is a section of its own. */
export const TOOL_GROUP = {
  editing: 'editing',
  model: 'model',
  analysis: 'analysis',
  view: 'view',
} as const;

/** Rank of each well-known group — lower renders further up (desktop) / left (mobile). */
export const TOOL_GROUP_RANK: Readonly<Record<string, number>> = {
  editing: 10,
  model: 20,
  analysis: 30,
  view: 40,
};

/** Accessible name of each well-known group (the section's `aria-label`). */
export const TOOL_GROUP_LABEL: Readonly<Record<string, string>> = {
  editing: 'Editing',
  model: 'Model & layout',
  analysis: 'Simulation & analysis',
  view: 'View',
};

/** Section key of the entries without a group. */
export const UNGROUPED_SECTION_KEY = 'ungrouped';

/** Rank of the ungrouped section — always first. */
const UNGROUPED_RANK = 0;
/** Rank of every group the table does not know — after all well-known ones. */
const UNKNOWN_GROUP_RANK = 1000;

/** One rendered entry of a section, with its stable React key. */
export interface ToolSectionEntry {
  entry: UISlotEntry;
  key: string;
}

/** One section of the toolbar. */
export interface ToolSection {
  /** The group id (`UNGROUPED_SECTION_KEY` for the entries without one). */
  key: string;
  /** Accessible name; empty for the ungrouped section (it gets no `role`). */
  label: string;
  /** The visible entries, in registry order. Never empty. */
  entries: ToolSectionEntry[];
}

/**
 * Whether the toolbar shows an entry right now — the rule `ButtonPanel` has
 * always applied, moved here verbatim:
 *  - the entry has a `visibilityRule` → evaluate it against the contexts;
 *  - no rule → visible, EXCEPT in a "focused" workspace mode (any active mode
 *    other than the default `hmi`, e.g. Planner or DES), where only entries that
 *    opt in through a rule are shown.
 */
export function isToolEntryVisible(
  entry: UISlotEntry,
  contexts: ReadonlySet<string>,
  activeMode: string | null,
): boolean {
  if (entry.visibilityRule) return evaluateVisibilityRule(entry.visibilityRule, contexts);
  return !(activeMode !== null && activeMode !== 'hmi');
}

function groupOf(entry: UISlotEntry): string {
  // An empty string is "no group" too, and an explicit 'ungrouped' joins the
  // implicit first section instead of becoming a second one of the same name.
  return entry.group ? entry.group : UNGROUPED_SECTION_KEY;
}

/** Own entry of a lookup table — never an inherited `Object.prototype` member
 *  (a plugin may name a group `constructor` or `toString`). */
function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function rankOf(group: string): number {
  if (group === UNGROUPED_SECTION_KEY) return UNGROUPED_RANK;
  return ownValue(TOOL_GROUP_RANK, group) ?? UNKNOWN_GROUP_RANK;
}

/**
 * Filter the `button-group` entries with today's rule, then split them into
 * sections: ungrouped (rank 0) → the well-known ranks → unknown group ids
 * (rank 1000; ties by their smallest member `order`, then by first appearance).
 * Within a section the registry order is kept. Sections without a visible entry
 * are left out.
 *
 * `key` of an entry = its `slotKey` (stamped by `UIPluginRegistry`), so it does
 * not change when another plugin's entries sort in before it. An entry that did
 * not come through the registry falls back to its position in `all`; a key seen
 * twice gets a `#n` suffix rather than a React key collision.
 */
export function computeToolSections(
  all: readonly UISlotEntry[],
  contexts: ReadonlySet<string>,
  activeMode: string | null,
): ToolSection[] {
  interface Draft { section: ToolSection; rank: number; minOrder: number; first: number }
  const byGroup = new Map<string, Draft>();
  const seenKeys = new Map<string, number>();

  all.forEach((entry, i) => {
    if (!isToolEntryVisible(entry, contexts, activeMode)) return;
    const group = groupOf(entry);
    let draft = byGroup.get(group);
    if (!draft) {
      draft = {
        section: {
          key: group,
          label: group === UNGROUPED_SECTION_KEY ? '' : (ownValue(TOOL_GROUP_LABEL, group) ?? group),
          entries: [],
        },
        rank: rankOf(group),
        minOrder: Number.POSITIVE_INFINITY,
        first: i,
      };
      byGroup.set(group, draft);
    }
    draft.minOrder = Math.min(draft.minOrder, entry.order ?? 100);

    const base = entry.slotKey ?? `idx:${i}`;
    const seen = seenKeys.get(base) ?? 0;
    seenKeys.set(base, seen + 1);
    draft.section.entries.push({ entry, key: seen === 0 ? base : `${base}#${seen}` });
  });

  return [...byGroup.values()]
    .sort((a, b) => (a.rank - b.rank) || (a.minOrder - b.minOrder) || (a.first - b.first))
    .map((d) => d.section);
}

/** Total number of visible entries over all sections. */
export function countToolEntries(sections: readonly ToolSection[]): number {
  let n = 0;
  for (const s of sections) n += s.entries.length;
  return n;
}
