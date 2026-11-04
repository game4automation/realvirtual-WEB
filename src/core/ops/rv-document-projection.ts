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

import { DEFAULT_REPLAY_WAIT_BUDGET_MS, type RvDocument } from './rv-document';
import type { RvOp } from './rv-unified-ops';
import { resolveOpTarget, type RvDocumentMode } from './rv-unified-executors';
import { planPlacedReplay, type RvPlacedSkipReason } from './rv-placed-replay';

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

/** One op a replay did not apply (plan-774 F8): its kind and, where it has one, its target path. */
export interface RvReplaySkip {
  kind: string;
  nodePath?: string;
  /**
   * The op's target lies inside PLACED content (`nodePath` is that target):
   * reported as Problems `replay-op-skipped` through the executor. Absent for
   * an own-content op that threw (log line only) and for the tail a superseded
   * gate wait cut off (the document is gone).
   */
  placed?: true;
  /**
   * With `placed`: why it did not land (review fix E4, `rv-placed-replay.ts`) —
   * `baked-away` (placement materialised, node merged away) or `not-loaded`
   * (placement not materialised); absent for an op that threw.
   */
  reason?: RvPlacedSkipReason;
}

/** What a replay did (plan-774 F8). Skips under a reference become `replay-op-skipped` (Phase 4). */
export interface RvReplayResult {
  applied: number;
  skipped: RvReplaySkip[];
  /**
   * Review round 2 (R4): a `gate` wait ended SUPERSEDED mid-replay — another
   * document took the viewer, the rest of the log was not applied. The caller
   * must not answer "done": the tree it replayed onto is not the one on screen.
   */
  superseded?: true;
  /**
   * Review round 2 (R5): the `gate` wait ran out of its budget — the remaining
   * ops on placed content were left unapplied (reported "still loading", kept
   * in the restored history), the own-content ones applied.
   */
  timedOut?: true;
}

/** Options of {@link replayOntoTreeLocked}. */
export interface RvReplayOntoTreeOptions {
  /**
   * How long a `gate` wait may hold the document lock (review round 2, R5).
   * Default {@link DEFAULT_REPLAY_WAIT_BUDGET_MS} — the authoring join's budget.
   */
  waitBudgetMs?: number;
}

/**
 * plan-774 F3: the gate a replay asks before each op — "does this op need
 * placed content that is still materialising?" (`rv-authoring-load.ts`
 * `authoringReplayGate`). Structural here so core ops stay free of the editor.
 * The FIRST op that needs the wait waits once; `wait()` resolving false (the
 * document was superseded) ends the replay — the rest is reported skipped and
 * the result is marked `superseded`. The wait is bounded (review round 2, R5):
 * once the budget is spent, ops still waiting stay unapplied ("still loading").
 */
export interface RvReplayGate {
  needsWait(op: RvOp): boolean;
  wait(): Promise<boolean>;
}

/**
 * What a `reload` may hand back to the replay that follows it: the authoring
 * join's gate (plan-774 F3) when the placements were not ready in time.
 */
export interface RvReloadOutcome {
  replayGate?: RvReplayGate;
}

/** Hand the skips under a reference to the executor (Problems `replay-op-skipped`). */
export function reportPlacedSkips(doc: RvDocument, skipped: readonly RvReplaySkip[], what: string): void {
  const placed = skipped.filter((s): s is RvReplaySkip & { nodePath: string } => s.placed === true && typeof s.nodePath === 'string');
  if (placed.length === 0) return;
  try {
    doc.executor.reportReplaySkips?.(placed.map((s) => ({ kind: s.kind, nodePath: s.nodePath, reason: s.reason ?? 'baked-away' })), what);
  } catch (e) {
    console.warn('[rv-document-projection] reporting skipped replay ops failed:', e);
  }
}

/** `gate.wait()` raced against `budgetMs`: true = settled, false = superseded, `'timeout'` = budget spent. */
async function waitBounded(gate: RvReplayGate, budgetMs: number): Promise<boolean | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<boolean | 'timeout'>([
      gate.wait().catch(() => false),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, budgetMs)); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function skipOf(op: RvOp): RvReplaySkip {
  const nodePath = (op as { nodePath?: unknown }).nodePath;
  return typeof nodePath === 'string' ? { kind: op.kind, nodePath } : { kind: op.kind };
}

/** True for a "a newer load took the viewer" rejection — the loader's abort or the authoring join's supersede. */
export function isSupersededReload(e: unknown): boolean {
  return e instanceof Error && (e.name === 'LoadAbortedError' || e.name === 'AuthoringLoadSupersededError');
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
 *
 * plan-774 F8: returns `{ applied, skipped }` — skipped = the ops whose target
 * inside placed content is missing (not applied at all, see
 * `RvExecutor.replayTargetInPlacedContent`), the ops that threw, plus the rest
 * of the log when a `gate` wait ended with the document superseded. The skips
 * under a reference are handed to `executor.reportReplaySkips` → Problems
 * `replay-op-skipped` (path + op kind); the others keep the log line.
 */
export async function replayOntoTreeLocked(
  doc: RvDocument,
  ops: readonly RvOp[],
  what: string,
  gate?: RvReplayGate,
  opts: RvReplayOntoTreeOptions = {},
): Promise<RvReplayResult> {
  const result: RvReplayResult = { applied: 0, skipped: [] };
  // plan-766 §2.4.4: bracket the replay (editor arenas build once at the end).
  doc.executor.beginReplay?.();
  try {
    let waited = false;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (gate && !waited && gate.needsWait(op)) {
        waited = true;
        // Review round 2 (R5): the wait runs INSIDE the document lock, so it is
        // bounded like the draft tail's (E3) — never an endless `runExclusive`.
        const outcome = await waitBounded(gate, opts.waitBudgetMs ?? DEFAULT_REPLAY_WAIT_BUDGET_MS);
        if (outcome === false) {
          // R4: superseded — the rest is not applied and the caller must not
          // report the recompose as done.
          result.superseded = true;
          for (let j = i; j < ops.length; j++) result.skipped.push(skipOf(ops[j]));
          break;
        }
        if (outcome === 'timeout') result.timedOut = true;
      }
      // R5: after the budget ran out, an op whose placed content is STILL
      // materialising is kept unapplied (the caller restores the history, so it
      // stays in the log and the draft) and reported "still loading" — the
      // draft tail's timeout semantics (E3). Own-content ops land as usual.
      if (result.timedOut && gate!.needsWait(op)) {
        const nodePath = doc.executor.replayTargetInPlacedContent?.(op)?.nodePath ?? skipOf(op).nodePath;
        result.skipped.push(nodePath !== undefined
          ? { kind: op.kind, nodePath, placed: true, reason: 'still-loading' }
          : { kind: op.kind, placed: true, reason: 'still-loading' });
        continue;
      }
      // plan-774 F8: a target inside placed content that is not there — the
      // op would no-op silently (a field write on a missing node) — is skipped.
      // Review fixes E4/E5 (`planPlacedReplay`, shared with the draft replay):
      // baked away vs not loaded, and a composite loses only its missing
      // placed children. The history is restored by the caller either way.
      const plan = planPlacedReplay(doc.executor, op);
      for (const s of plan.skips) result.skipped.push({ kind: s.kind, nodePath: s.nodePath, placed: true, reason: s.reason });
      if (!plan.apply) continue;
      try {
        await doc.executor.applyForward(plan.apply);
        result.applied++;
      } catch (e) {
        result.skipped.push(plan.placedPath ? { kind: op.kind, nodePath: plan.placedPath, placed: true } : skipOf(op));
        console.warn(
          `[rv-document-projection] op '${op.kind}' did not replay onto the reloaded '${what}' — skipped:`,
          e,
        );
      }
    }
  } finally {
    doc.executor.endReplay?.();
  }
  if (result.skipped.length > 0) {
    console.warn(`[rv-document-projection] replay onto '${what}': ${result.applied} applied, ${result.skipped.length} skipped`);
    reportPlacedSkips(doc, result.skipped, what);
  }
  return result;
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
   *
   * plan-774 F3: an authoring reload joins its placements before it returns
   * and may hand back the join's replay gate ({@link RvReloadOutcome}). A
   * reload that was SUPERSEDED (another document took the viewer — it rejects
   * with a `LoadAbortedError`) ends the recompose silently: no replay, the
   * history restored as it was.
   */
  reload: () => Promise<void | RvReloadOutcome>;
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
  /**
   * Bound of the replay's gate wait inside the lock (review round 2, R5);
   * default {@link DEFAULT_REPLAY_WAIT_BUDGET_MS}.
   */
  waitBudgetMs?: number;
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
/** What a recompose did: the replay's result, or nothing because its reload was superseded (plan-774 F3). */
export type RvRecomposeOutcome =
  | { status: 'ok'; replay: RvReplayResult }
  | { status: 'superseded' };

export async function recomposeProjection(req: RvRecomposeRequest): Promise<RvRecomposeOutcome> {
  const { doc, reload } = req;
  return doc.runExclusive(async (): Promise<RvRecomposeOutcome> => {
    const history = doc.captureHistory();
    if (req.projection) doc.setProjection(req.projection);
    let reloaded: void | RvReloadOutcome;
    try {
      reloaded = await reload();
    } catch (e) {
      if (!isSupersededReload(e)) throw e;
      // plan-774 F3: another document took the viewer during the reload — no
      // replay onto its tree; this document's log stays exactly as it was.
      doc.restoreHistory(history);
      return { status: 'superseded' };
    }
    const ops = req.replay === 'none'
      ? []
      : req.replay === 'all'
        ? history.ops
        : projectedOps(history.ops, doc.mode);
    const replay = await replayOntoTreeLocked(
      doc, ops, req.label ?? doc.name, reloaded?.replayGate, { waitBudgetMs: req.waitBudgetMs },
    );
    doc.restoreHistory(history);
    // Review round 2 (R4): the replay's gate wait ended superseded — another
    // document took the viewer mid-replay. Not done; the log stays as it was.
    if (replay.superseded) return { status: 'superseded' };
    // plan-774 review fix E3: a recovered tail that was still waiting for its
    // placed content (kept when a descend superseded its wait) is re-attempted
    // on the fresh tree — Back is exactly that moment.
    if (req.replay !== 'none') await doc.replayPendingLocked(reloaded?.replayGate, req.waitBudgetMs);
    return { status: 'ok', replay };
  });
}

/** Why an undo-by-recompose could not run right now. */
export type RvUndoRecomposeRefusal = 'busy' | 'in-transaction' | 'nothing-to-undo' | 'superseded';

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
  reload: () => Promise<void | RvReloadOutcome>;
  label?: string;
  /** Bound of the replay's gate wait (review round 2, R5). */
  waitBudgetMs?: number;
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
  const superseded = await doc.runExclusive(async (): Promise<boolean> => {
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
    let reloaded: void | RvReloadOutcome;
    try {
      reloaded = await req.reload();
    } catch (e) {
      if (!isSupersededReload(e)) throw e;
      // plan-774 F3: superseded during the reload — the undo did not happen.
      doc.restoreHistory(history);
      return true;
    }
    const replay = await replayOntoTreeLocked(
      doc, projectedOps(next.ops, doc.mode), req.label ?? doc.name, reloaded?.replayGate, { waitBudgetMs: req.waitBudgetMs },
    );
    if (replay.superseded) {
      // Review round 2 (R4): superseded mid-replay — the undo did not happen;
      // the undone op stays in the log (it does NOT move to redo).
      doc.restoreHistory(history);
      return true;
    }
    doc.restoreHistory(next, { announce: true });
    // plan-774 review fix E3: the fresh tree is also a chance for a kept tail.
    await doc.replayPendingLocked(reloaded?.replayGate, req.waitBudgetMs);
    return false;
  });
  if (superseded) {
    return { ok: false, reason: 'superseded', message: 'Another document was opened while the undo was rebuilding the view.' };
  }
  return { ok: true };
}
