// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-projection — ONE op log, two projections (plan-711 Phase 2+3).
 *
 * The document merge (plan-703) made scene and editor share a class; plan-711
 * makes them share an INSTANCE when they show the same document. That is not
 * "one tree, two windows": there is always exactly one active projection, and a
 * mode change is a RECOMPOSE of the shared log into the other one —
 * `captureHistory` → rebuild the tree → replay onto it WITHOUT recording →
 * `restoreHistory`, the pattern `rv-document-recompose.ts` established for
 * Descend/Back. This module is that pattern, generalised, so there is one
 * implementation with one lock scope rather than a second, differently-locked
 * copy (plan-711 R2-Arch-F2/F3). `recomposeFrame` now calls it.
 *
 * ══ What the spike changed about the replay (plan-711 Spike (a)/(e)) ═════════
 *
 * The plan text said "the recompose applies ALL ops of the log, each in the way
 * its projection means". That is not implementable, because "in the way its
 * projection means" does not exist in the executor: `resolveOpTarget` routes by
 * ORIGIN, and only the four `'both'` kinds follow the mode. An unfiltered
 * replay therefore does not skip the foreign ops — it runs them against the
 * WRONG TREE:
 *
 *  - a scene op (`addPlacement`) replayed in the editor projection reaches the
 *    scene executor, needs the layout planner the editor does not register, and
 *    is swallowed into a console warning. Reported success, nothing built
 *    (MESSUNG a2).
 *  - an asset op (`deleteNode`) replayed in the scene projection is NOT
 *    swallowed and NOT skipped — it deletes a node out of the scene's tree
 *    (MESSUNG e3).
 *
 * The second is data loss, so the replay is FILTERED by
 * {@link isProjectedInto}: an op materialises in a projection through
 * `applyForward` only if it belongs to that projection. Everything else reaches
 * the other side through BYTES — the scene's ops through the scene bake (which
 * is what writes placement reference nodes in the first place), the editor's
 * through the authored-tree export that replaces the bake's source. That is the
 * §2.3 bake rule the spike settled as "projizierter Baum".
 *
 * ── Undo across the seam (Spike (c)/(d)) ────────────────────────────────────
 *
 * {@link needsRecomposeToUndo} is KIND-triggered and asked BEFORE the inverse
 * runs. "Try it and recompose if it fails" was the plan's first shape and the
 * spike killed it: the inverse does not fail. The scene executor swallows, the
 * common asset kinds `if (!node) return`, the log pops either way, and nothing
 * anywhere reports a problem — log and tree diverge in silence (MESSUNG c1).
 * The same answer covers Spike (d): after a projection change the asset
 * executor's tree-bound undo state (`_trash`, `_trashGroup`, …) is deliberately
 * dropped, so those inverses are only correct through a re-projection too.
 */

import type { RvDocument } from './rv-document';
import type { RvOp } from './rv-unified-ops';
import { resolveOpTarget, type RvDocumentMode } from './rv-unified-executors';

/**
 * Does `op` materialise in `projection` when applied through the executor?
 *
 * A MIXED composite answers false: `resolveOpTarget` returns null for it, the
 * executor splits it and routes each child on its own, so part of it would land
 * on the wrong tree. Refusing the whole composite is the conservative reading —
 * it costs a recompose, where letting it through costs correctness.
 */
export function isProjectedInto(op: RvOp, projection: RvDocumentMode): boolean {
  return resolveOpTarget(op, projection) === projection;
}

/** The ops of `log` that a `projection`'s tree can be rebuilt from. */
export function projectedOps(
  log: readonly RvOp[],
  projection: RvDocumentMode,
): RvOp[] {
  return log.filter((op) => isProjectedInto(op, projection));
}

/**
 * Must undoing `op` go through a recompose rather than through the executor?
 *
 * Asked by the undo path BEFORE it acts — see the header for why "the inverse
 * failed" is not a usable trigger.
 */
export function needsRecomposeToUndo(op: RvOp, projection: RvDocumentMode): boolean {
  return !isProjectedInto(op, projection);
}

/**
 * Apply `ops` to the live tree WITHOUT recording them.
 *
 * The caller MUST already hold the document's queue — this is the inside of
 * {@link recomposeProjection} and of `replayOntoFreshTree`, and taking the lock
 * here would deadlock against the outer `runExclusive` (its tail awaits this
 * one). A single failing op is logged and skipped: the tree came from bytes and
 * may legitimately have moved on, and losing one op is recoverable where losing
 * the whole replay is not.
 */
export async function replayOntoTreeLocked(
  doc: RvDocument,
  ops: readonly RvOp[],
  what: string,
): Promise<void> {
  for (const op of ops) {
    try {
      await doc.executor.applyForward(op);
    } catch (e) {
      console.warn(
        `[rv-document-projection] op '${op.kind}' did not replay onto the reloaded '${what}' — skipped:`,
        e,
      );
    }
  }
}

export interface RvRecomposeRequest {
  /** The document that keeps its log across the rebuild. */
  doc: RvDocument;
  /**
   * The projection to switch INTO. Omit to recompose in place (Descend/Back,
   * which stay inside one projection).
   */
  projection?: RvDocumentMode;
  /**
   * Rebuild the live tree. Runs INSIDE the lock (plan-711 R2-Arch-F3): two
   * fast mode switches must serialise, and the old shape — reload outside,
   * replay inside — left exactly that window open.
   */
  reload: () => Promise<void>;
  /**
   * What the replay applies onto the rebuilt tree.
   *
   *  - `'projected'` (default) — only what the target projection can
   *    materialise; see the header.
   *  - `'all'` — the pre-711 behaviour, kept for the SAME-projection callers
   *    (Descend/Back), whose log is single-origin by construction and whose
   *    fixtures pin the unfiltered count.
   *  - `'none'` — the tree ALREADY contains the ops, so re-applying them would
   *    double them. That is the way back from a bound editor session (the
   *    authored export carries both halves) and the same reason the scene open
   *    and the in-place test session are restore-only: their bytes are the ops.
   */
  replay?: 'projected' | 'all' | 'none';
  /** For the skipped-op warning. */
  label?: string;
}

/**
 * Rebuild a document's tree and put its op log back on top — the ONE
 * implementation (plan-711 R2-Arch-F2).
 *
 * Order is load-bearing:
 *
 *  1. freeze the history INCLUDING the clean point, or a clean document comes
 *     back dirty (the failure plan-410 R1-2 named);
 *  2. switch the projection BEFORE the replay, so the filter and the executor's
 *     routing agree about what "this projection" means;
 *  3. rebuild the tree through the caller's own load path;
 *  4. replay, without recording — `replayOps` would push a second copy of the
 *     history onto a log that is about to be restored from the freeze;
 *  5. restore, byte-identical, so `dirty` is exactly what it was.
 */
export async function recomposeProjection(req: RvRecomposeRequest): Promise<void> {
  const { doc, reload } = req;
  await doc.runExclusive(async () => {
    const history = doc.captureHistory();
    if (req.projection) doc.setProjection(req.projection);
    await reload();
    const ops = req.replay === 'none'
      ? []
      : req.replay === 'all'
        ? history.ops
        : projectedOps(history.ops, doc.mode);
    await replayOntoTreeLocked(doc, ops, req.label ?? doc.name);
    doc.restoreHistory(history);
  });
}

/** Why an undo-by-recompose could not run right now. */
export type RvUndoRecomposeRefusal = 'busy' | 'in-transaction' | 'nothing-to-undo';

export type RvUndoRecomposeOutcome =
  | { ok: true }
  | { ok: false; reason: RvUndoRecomposeRefusal; message: string };

/**
 * Undo the newest op by RE-PROJECTING the log without it (plan-711 §2.3, F3).
 *
 * The answer to two measurements that turn out to have one cause: an op the
 * active projection cannot materialise also cannot be INVERTED there (Spike
 * (c)), and after a projection change the asset executor's tree-bound undo
 * state has deliberately been dropped, so its inverses are in the same position
 * (Spike (d)). Both are "the executor cannot take this op back", and rebuilding
 * the tree from the log-without-it is the correct — and only — general answer.
 *
 * Correct before fast: the cost is one reload plus N `applyForward`, i.e. the
 * price of a projection switch, paid at a moment the user is already crossing
 * one. It is REFUSED rather than queued while the document is busy or inside an
 * open transaction: a mini-recompose replaces the tree, and doing that under a
 * half-collected transaction would leave the transaction's applied children
 * pointing at objects that no longer exist.
 */
export async function undoViaRecompose(req: {
  doc: RvDocument;
  reload: () => Promise<void>;
  label?: string;
}): Promise<RvUndoRecomposeOutcome> {
  const { doc } = req;
  if (doc.inTransaction) {
    return {
      ok: false,
      reason: 'in-transaction',
      message: 'This change can only be undone once the current operation has finished.',
    };
  }
  if (doc.busy) {
    return { ok: false, reason: 'busy', message: 'The document is still working — try again in a moment.' };
  }
  if (!doc.canUndo()) {
    return { ok: false, reason: 'nothing-to-undo', message: 'There is nothing to undo.' };
  }
  await doc.runExclusive(async () => {
    const history = doc.captureHistory();
    const undone = history.ops[history.ops.length - 1];
    // The log WITHOUT the undone op, with it on the redo branch — exactly the
    // stack move `RvDocument.undo` makes, done here because the tree is
    // rebuilt from the result rather than by an inverse.
    const next = {
      ...history,
      ops: history.ops.slice(0, -1),
      redoOps: [...history.redoOps, undone],
    };
    await req.reload();
    await replayOntoTreeLocked(doc, projectedOps(next.ops, doc.mode), req.label ?? doc.name);
    doc.restoreHistory(next, { announce: true });
  });
  return { ok: true };
}
