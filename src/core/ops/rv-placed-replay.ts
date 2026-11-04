// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-placed-replay — what a REPLAY does with an op whose target lies inside
 * placed content (plan-774 F8, review fixes E4 / E5).
 *
 * The ONE decision both replays share — the draft replay (`RvDocument.replayOps`,
 * which also builds the history) and the recompose replay
 * (`replayOntoTreeLocked`, which restores the history it froze):
 *
 *  - the target exists → apply;
 *  - the target is missing and its placement IS materialised → the placed
 *    asset's bake merged the node away (`baked-away`): not applied, and a draft
 *    replay drops it from the history — it can never land again;
 *  - the target is missing and its placement is NOT materialised (placeholder:
 *    offline source, fetch / decode error, cap, cycle) → `not-loaded`: not
 *    applied, but KEPT — the next load that brings the asset applies it;
 *  - a composite is filtered child by child: its own-content children and the
 *    placed children whose target exists are applied, only the missing placed
 *    children are skipped and reported (never the whole composite).
 *
 * Pure: the probe (the executor's `replayTargetInPlacedContent`) is the only
 * thing that looks at the tree.
 */
import type { RvOp } from './rv-unified-ops';

/** Why a replayed op on placed content did not land. */
export type RvPlacedSkipReason =
  /** The placement is materialised; its bake merged the target away. */
  | 'baked-away'
  /** The placement did not materialise (placeholder) — the content is not there yet. */
  | 'not-loaded'
  /** The placement was still materialising when the replay's wait ran out. */
  | 'still-loading';

/** The executor's answer for one op (`RvExecutor.replayTargetInPlacedContent`). */
export interface RvPlacedReplayTarget {
  /** The first target path inside placed content (the missing one, when one is). */
  nodePath: string;
  /** That target's node is absent. */
  missing: boolean;
  /** The innermost placed reference over it has a materialised instance. */
  materialized: boolean;
}

/** One skipped op (or composite child), as the Problems entry names it. */
export interface RvPlacedReplaySkip {
  kind: string;
  nodePath: string;
  reason: RvPlacedSkipReason;
}

/** What the decision needs of the executor. */
export interface RvPlacedReplayProbe {
  replayTargetInPlacedContent?(op: RvOp): RvPlacedReplayTarget | null;
}

/** The decision for one op. */
export interface RvPlacedReplayPlan {
  /** What to apply: the op, a composite without its missing placed children, or null. */
  apply: RvOp | null;
  /** What a draft replay keeps in the history: everything but the baked-away part, or null. */
  keep: RvOp | null;
  /** The skipped op / children. */
  skips: RvPlacedReplaySkip[];
  /** The first placed target among what is applied — a throw there counts as a placed skip. */
  placedPath: string | null;
}

function reasonOf(target: RvPlacedReplayTarget): RvPlacedSkipReason {
  return target.materialized ? 'baked-away' : 'not-loaded';
}

/** Decide what a replay does with `op` (see the module header). */
export function planPlacedReplay(probe: RvPlacedReplayProbe, op: RvOp): RvPlacedReplayPlan {
  const ask = probe.replayTargetInPlacedContent?.bind(probe);
  if (!ask) return { apply: op, keep: op, skips: [], placedPath: null };
  if (op.kind === 'composite') {
    const children = op.ops as readonly RvOp[];
    const applied: RvOp[] = [];
    const kept: RvOp[] = [];
    const skips: RvPlacedReplaySkip[] = [];
    let placedPath: string | null = null;
    for (const child of children) {
      const target = ask(child);
      if (target?.missing) {
        const reason = reasonOf(target);
        skips.push({ kind: child.kind, nodePath: target.nodePath, reason });
        if (reason !== 'baked-away') kept.push(child);
        continue;
      }
      if (target) placedPath ??= target.nodePath;
      applied.push(child);
      kept.push(child);
    }
    if (skips.length === 0) return { apply: op, keep: op, skips, placedPath };
    const withChildren = (ops: RvOp[]): RvOp | null => (ops.length === 0 ? null : { ...op, ops } as RvOp);
    return {
      apply: withChildren(applied),
      keep: kept.length === children.length ? op : withChildren(kept),
      skips,
      placedPath,
    };
  }
  const target = ask(op);
  if (target?.missing) {
    const reason = reasonOf(target);
    return {
      apply: null,
      keep: reason === 'baked-away' ? null : op,
      skips: [{ kind: op.kind, nodePath: target.nodePath, reason }],
      placedPath: target.nodePath,
    };
  }
  return { apply: op, keep: op, skips: [], placedPath: target?.nodePath ?? null };
}
