// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-group-labels.ts — the group names a node carries, read so that they
 * survive cloning (plan-2016 S5, MUSwitcher).
 *
 * Three sources, first hit wins:
 *  1. `userData._rvPartitionGroups` — the clonable label list. A spawned MU clone
 *     loses its rv-extras (`stripComponentMetadata`), which stamps this list
 *     first; `Object3D.clone()` copies it (plain JSON data).
 *  2. `userData.realvirtual.Group` / `Group_N` — the authored `GroupName`s,
 *     exactly as Unity's `MUSwitcher` compares them: raw (no `GroupNamePrefix`),
 *     one entry per `Group` component in authored order, duplicates and disabled
 *     components included (`GetComponentsInChildren<Group>(true)` returns
 *     disabled components too). The node's LAST entry decides the switch, so the
 *     list must not be deduplicated — `['A', 'B', 'A']` ends active for `A`.
 *     Bake survivors keep their extras (the template node takes the userData by
 *     reference), and a partition object carries one synthetic block per label.
 *  3. `userData._rvPartition` — the RESOLVED, DEDUPLICATED labels the `Group`
 *     pre-bake hook stamps; only a fallback for a node whose extras are gone.
 *
 * A chunk key is never split at `|` — labels only ever come from these lists.
 */

import type { Object3D } from 'three';

/** `userData` key of the clonable group-label list (plan-2016 S5). */
export const RV_GROUP_LABELS_KEY = '_rvPartitionGroups';

/** The bake's partition-label key (mirrors `RV_PARTITION_KEY`, rv-bake-chunk.ts). */
const RV_PARTITION_LABELS = '_rvPartition';

const NONE: readonly string[] = Object.freeze([]);

function stringList(v: unknown): readonly string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  for (const s of v) if (typeof s !== 'string') return null;
  return v as string[];
}

/** The group names `node` belongs to, in authored order (duplicates kept); empty when none. */
export function groupLabelsOf(node: Object3D): readonly string[] {
  const ud = node.userData;
  if (!ud) return NONE;
  const own = stringList(ud[RV_GROUP_LABELS_KEY]);
  if (own) return own;
  const rv = ud.realvirtual as Record<string, unknown> | undefined;
  if (rv) {
    let labels: string[] | null = null;
    for (const key of Object.keys(rv)) {
      if (key !== 'Group' && !/^Group_\d+$/.test(key)) continue;
      const data = rv[key] as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') continue;
      const name = data['GroupName'];
      if (typeof name !== 'string' || !name) continue;
      (labels ??= []).push(name);
    }
    if (labels) return labels;
  }
  return stringList(ud[RV_PARTITION_LABELS]) ?? NONE;
}
