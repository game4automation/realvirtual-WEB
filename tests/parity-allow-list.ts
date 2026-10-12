// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parity-allow-list — plan-757 Phase 0.
 *
 * The ONLY differences between "the asset as main model" and "the asset as a
 * placement" that are declared, with the decision that declares them. Every
 * other difference the parity harness finds is a defect (F11).
 *
 * Rules, enforced by `assertAllowListWellFormed()` and the self-test in
 * `pipeline-parity.test.ts`:
 *  - chunk count, the component set, a node's LOCAL pose and ANY behaviour
 *    value may never be listed (`FORBIDDEN_DIMENSIONS`);
 *  - an entry no fixture triggers fails as `unused` — a stale declaration is a
 *    hole nobody is watching.
 */
import type { ParityDiff } from './helpers/parity-harness';

export interface AllowListEntry {
  id: string;
  /** Plan decision that declares the asymmetry. */
  decision: string;
  reason: string;
  matches(diff: ParityDiff): boolean;
}

/** Dimensions no entry may ever match, whatever its predicate says. */
export const FORBIDDEN_DIMENSIONS: ReadonlySet<ParityDiff['dimension']> = new Set<ParityDiff['dimension']>([
  'counts',      // chunk count, node count, matrix counts
  'movers',      // the chunk set
  'behaviour',   // any value after n steps
]);

export const PARITY_ALLOW_LIST: readonly AllowListEntry[] = Object.freeze([
  {
    id: 'instance-root-name',
    decision: 'mental model 3/4 — a placement root is named by the document, the asset root by the file',
    reason: 'a planner placement gets a unique name (`Machine_1`); the asset root keeps the file name',
    matches: (d) => d.dimension === 'root' && d.key === 'name' && d.tags.includes('instance-root-name'),
  },
  {
    id: 'plugin-claims',
    decision: 'D5 — plugin `bakeClaims()` reach the main model only',
    reason: 'a bare CAD leaf a model plugin claims survives the loader bake and not the cache bake — the ONE declared asymmetry',
    matches: (d) => (d.dimension === 'nodes' || d.dimension === 'rootChildren') && d.tags.includes('plugin-claim'),
  },
  {
    id: 'uniform-pivot-offset',
    decision: '§2.4 — `materialize()` runs `pivotToFloorCenter` on the instance root\'s children',
    reason: 'every direct child of the instance root is shifted by the SAME floor-centre offset; the shift is reported once, child poses are compared in the asset frame',
    matches: (d) => d.dimension === 'rootChildren' && d.key === 'pivotOffset' && d.tags.includes('uniform-pivot-offset'),
  },
  {
    id: 'placement-world-matrix-live',
    decision: 'plan-397 phase 6 + plan-757 F13 — a placement root carries `PlacementMeta` (a mover role), so `freezeStaticMatrices` keeps its whole subtree WORLD-live',
    reason: 'the planner moves a placement as one unit, and three.js never recomputes a frozen `matrixWorld` even when the parent moved — the main model freezes `matrixWorldAutoUpdate` on its static subtrees, a placement cannot. Only that one flag differs; `matrixAutoUpdate` (the per-frame local re-compose, R6) is compared unnormalised',
    matches: (d) => d.dimension === 'nodes' && d.tags.includes('placement-world-live'),
  },
]);

/** Throws when an entry could ever explain a forbidden dimension. */
export function assertAllowListWellFormed(list: readonly AllowListEntry[] = PARITY_ALLOW_LIST): void {
  const ids = new Set<string>();
  for (const e of list) {
    if (ids.has(e.id)) throw new Error(`[parity-allow-list] duplicate entry id "${e.id}"`);
    ids.add(e.id);
    for (const dimension of FORBIDDEN_DIMENSIONS) {
      const probe: ParityDiff = { dimension, key: 'probe', main: 1, placement: 2, tags: ['instance-root-name', 'plugin-claim', 'uniform-pivot-offset', 'placement-world-live'] };
      if (e.matches(probe)) {
        throw new Error(`[parity-allow-list] entry "${e.id}" would explain a "${dimension}" difference — forbidden`);
      }
    }
  }
}

export interface AllowListApplication {
  /** Diffs no entry explains — the defects. */
  unexplained: ParityDiff[];
  /** Entry ids that explained at least one diff. */
  used: Set<string>;
}

/** Split `diffs` into explained / unexplained; a forbidden dimension is never explained. */
export function applyAllowList(diffs: readonly ParityDiff[], list: readonly AllowListEntry[] = PARITY_ALLOW_LIST): AllowListApplication {
  const used = new Set<string>();
  const unexplained: ParityDiff[] = [];
  for (const d of diffs) {
    let explained = false;
    if (!FORBIDDEN_DIMENSIONS.has(d.dimension)) {
      for (const e of list) {
        if (e.matches(d)) { used.add(e.id); explained = true; }
      }
    }
    if (!explained) unexplained.push(d);
  }
  return { unexplained, used };
}

/** Entries that explained nothing across a whole suite run — fail as `unused`. */
export function unusedEntries(usedAcrossSuite: ReadonlySet<string>, list: readonly AllowListEntry[] = PARITY_ALLOW_LIST): string[] {
  return list.filter((e) => !usedAcrossSuite.has(e.id)).map((e) => e.id);
}
