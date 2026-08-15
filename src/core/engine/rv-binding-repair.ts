// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-binding-repair — finding a slot mapping's new home after the model moved
 * underneath it (plan-425 F3, "case B").
 *
 * ## The problem this solves, and the one it refuses to
 *
 * Slot mappings are addressed by `componentPath + slot`. Re-parenting a group
 * in Unity rewrites every path below it, and `applyMappings()` then drops the
 * mapping — silently, by `.filter()`, which is how this defect stayed
 * comfortable for so long. The obvious repair is to look the slot up by
 * something the move did not change: its component TYPE, its SLOT name, and the
 * LEAF of its path.
 *
 * That lookup is not safe enough to act on by itself, which is the whole design
 * of this module. Three.js deduplicates node names per file, so two objects that
 * were both called `Gripper` in the CAD become `Gripper` and `Gripper_1` — and
 * which one got the suffix depends on traversal order, not on identity. A naive
 * leaf comparison is therefore wrong in BOTH directions: it misses the correct
 * node (`Gripper` vs `Gripper_1`), and — worse — it can present the WRONG node
 * as the single obvious answer. A false negative costs a click. A false positive
 * silently rewires a machine.
 *
 * So: normalisation makes the comparison honest (see {@link normalizedLeaf}),
 * and the result is never more than a CANDIDATE. Exactly one match is offered to
 * a human, who confirms it. Zero or several stay orphaned. Nothing here binds.
 */

import { sanitizeLikeThree } from './rv-three-names';

/**
 * The comparable form of a path's last segment.
 *
 * Sanitisation is applied because the stored path may predate it (a mapping
 * written against the original glTF name, `Drive.X`, must still match the
 * `DriveX` Three.js assigned). The dedup suffix is NOT stripped: `Gripper` and
 * `Gripper_1` are different objects and must compare unequal, or the ambiguity
 * check below has nothing left to detect. Stripping it would be exactly the
 * "in doubt, treat as equal" that produces a confident wrong answer.
 */
export function normalizedLeaf(path: string): string {
  const leaf = path.split('/').pop() ?? path;
  return sanitizeLikeThree(leaf);
}

/** The part of a slot the search needs — satisfied by `BindableSlot`. */
export interface RepairSearchSlot {
  slot: string;
  componentPath: string;
  componentType?: string;
}

/** The part of a mapping the search needs. */
export interface RepairSearchMapping {
  slot: string;
  componentPath?: string;
  componentType?: string;
}

/** Why a dropped mapping got no repair offer — the vocabulary the UI explains. */
export type RepairRejectReason =
  /** Legacy mapping: no `componentType` was ever stored, so the key is short. */
  | 'no-component-type'
  /** Nothing in the model has this type + slot + leaf. */
  | 'no-candidate'
  /** Two or more equally good matches — a coin flip is not a repair. */
  | 'ambiguous';

export type RepairLookup =
  | { found: true; componentPath: string }
  | { found: false; reason: RepairRejectReason };

/**
 * The single slot this mapping most likely belongs to now, or why there is none.
 *
 * Deliberately total and deliberately pessimistic: every "no" carries a reason,
 * and every "yes" means EXACTLY one match — never "the best of several".
 */
export function findRepairCandidate(
  mapping: RepairSearchMapping,
  slots: readonly RepairSearchSlot[],
): RepairLookup {
  // Without a persisted type the key is `slot + leaf`, which across a machine
  // full of identical stations matches plenty of wrong things. plan-425 chose
  // the honest orphan over the plausible guess.
  if (!mapping.componentType) return { found: false, reason: 'no-component-type' };
  if (mapping.componentPath === undefined) return { found: false, reason: 'no-component-type' };

  const wantLeaf = normalizedLeaf(mapping.componentPath);
  const matches = slots.filter((slot) =>
    slot.componentType === mapping.componentType
    && slot.slot === mapping.slot
    && normalizedLeaf(slot.componentPath) === wantLeaf);

  if (matches.length === 0) return { found: false, reason: 'no-candidate' };
  if (matches.length > 1) return { found: false, reason: 'ambiguous' };
  return { found: true, componentPath: matches[0].componentPath };
}
