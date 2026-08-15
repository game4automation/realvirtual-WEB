// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-unified-executors — apply a unified {@link RvOp} to the live scene
 * (plan-703 Phase 1).
 *
 * ── What "merging the executors" actually means here ────────────────────────
 *
 * The two legacy executors do NOT differ in mechanics; they differ in TARGET.
 * `rv-scene-executors.ts` writes an overlay on top of a base GLB (plus planner
 * placements, camera preset, connection registry). `rv-asset-executors.ts`
 * writes the AUTHORED GLB itself (plus its trash group, CAD cache, BVH and
 * group bookkeeping). Plan-703 makes that difference a **mode of the one
 * document** instead of a second document class — which is exactly what this
 * file is: one `applyForward` / `applyInverse` pair that routes per op.
 *
 * It deliberately re-USES both existing executors verbatim rather than porting
 * their bodies. Those two files carry years of load-bearing detail (frozen
 * matrices, detach-to-trash, pick-index membership, group re-sync, the
 * collected-error contract). Re-implementing them would be the single riskiest
 * possible move in Phase 1, and it would buy nothing: the routing IS the merge.
 *
 * ── Routing rules (total, no fallthrough) ───────────────────────────────────
 *
 *  1. `composite`         → the COMMON target of its children, and the whole
 *                           composite is handed down to that executor intact.
 *                           Only a genuinely MIXED composite is split here
 *                           (forward in order, inverse in reverse).
 *  2. scene-only kinds    → scene executor.   (RV_OP_ORIGIN === 'scene')
 *  3. asset-only kinds    → asset executor.   (RV_OP_ORIGIN === 'asset')
 *  4. `transformNode`     → by PAYLOAD, not by mode: no `scale` ⇒ scene path
 *                           (frozen-safe `applyLocalPose`, never writes
 *                           `node.scale`); `scale` present ⇒ asset path.
 *                           This is what keeps an upcast legacy log replaying
 *                           the way it always did, in either mode.
 *  5. `setField` / `unsetField` → by DOCUMENT MODE. Same payload, different
 *                           target: overlay-over-base vs. authored GLB. This is
 *                           the one place the mode genuinely decides, and it is
 *                           the reason the mode exists at all.
 *
 * Error contract: the scene executor swallows failures (a stale op on a changed
 * base GLB must not break the log); the asset executor REJECTS so the document
 * can decline to record an op that never landed. Both contracts survive routing
 * unchanged — this file adds no try/catch of its own.
 *
 * ── What plan-710 removed ───────────────────────────────────────────────────
 *
 * Until plan-710 every branch below first LOWERED the op into a second
 * vocabulary through the up-/downcast module, and threw when the lowering came
 * back null. Both executors now take the origin-filtered subsets
 * of this union directly, so routing is the only work left here and the
 * "has no scene/asset form" error class is gone with the second vocabulary that
 * made it possible. The narrowing casts are the exact statement `resolveOpTarget`
 * just proved on the line above.
 */

import type { RVViewer } from '../rv-viewer';
import type { RvOp, RvAssetOp, RvSceneOp } from './rv-unified-ops';
import { RV_OP_ORIGIN } from './rv-unified-ops';
import { applyForward as applySceneForward, applyInverse as applySceneInverse } from '../hmi/scene/rv-scene-executors';
// TYPE-ONLY on purpose — see `_ensureAsset`. A value import here would put the
// whole asset-editor executor graph (mesh merge/separator, CAD provider, …) in
// every chunk that reaches a scene document, i.e. the core bundle.
import type { AssetExecutorContext } from '../editor/rv-asset-executors';

/** Which target an {@link RvDocument} writes to. */
export type RvDocumentMode = 'scene' | 'asset';

/** What {@link RvDocument} needs from an executor. Mockable in tests. */
export interface RvExecutor {
  applyForward(op: RvOp): Promise<void>;
  applyInverse(op: RvOp): Promise<void>;
  dispose?(): void;
  /**
   * Follow the document into a new projection (plan-711 §2.3).
   *
   * OPTIONAL, and that is the whole point: a document's mode and its executor's
   * mode are two fields describing one fact, but only an executor that ROUTES
   * on the mode has a second field to move. Every test double here is a pair of
   * closures with no routing at all, and forcing them to grow a method would
   * make the seam wider to express something they do not have.
   */
  setMode?(mode: RvDocumentMode): void;
}

/** Where a single op is applied. */
export type RvOpTarget = 'scene' | 'asset';

/**
 * Resolve the target of one op — pure, exported so the pinning test can assert
 * the routing table without touching a scene.
 *
 * A `composite` resolves to the COMMON target of its children, and `null` only
 * when it is empty or genuinely mixed. That is not a convenience: BOTH legacy
 * executors treat a composite as one indivisible unit, and splitting it here
 * silently broke three of their contracts (measured, plan-703 Phase 3):
 *
 *   - `AssetExecutorContext._afterApply` fires exactly ONCE per top-level op.
 *     Per-child recursion turned a 74-move batch into 74
 *     `editor-structure-changed` events, each costing the hierarchy panel a full
 *     `scene.traverse` — the exact regression plan-359 Phase 2 measured and fixed.
 *   - `_withMatrixBatch` keys on `isPureMoveComposite(op)`, i.e. on the WHOLE
 *     composite. A child seen alone never qualifies, so the 434-subtree-walks
 *     collapse never happens.
 *   - A composite that fails part-way rolls its own applied children back. Split
 *     into N separate applies, the failure surfaces after some already landed and
 *     the document never recorded (and therefore cannot invert) any of them —
 *     the "scene disagrees with its own history" state the op log exists to
 *     prevent.
 */
export function resolveOpTarget(op: RvOp, mode: RvDocumentMode): RvOpTarget | null {
  if (op.kind === 'composite') {
    let common: RvOpTarget | null = null;
    for (const child of op.ops) {
      const target = resolveOpTarget(child, mode);
      if (target === null) return null;
      if (common === null) common = target;
      else if (common !== target) return null; // mixed — must be split
    }
    return common;
  }
  if (op.kind === 'transformNode') {
    // Rule 4 — payload decides, never the mode.
    return (op.transform.scale || op.prev.scale) ? 'asset' : 'scene';
  }
  const origin = RV_OP_ORIGIN[op.kind];
  if (origin === 'scene') return 'scene';
  if (origin === 'asset') return 'asset';
  // Rule 5 — setField / unsetField: same payload, the mode picks the target.
  return mode;
}

/**
 * The one executor of the one document. Holds both legacy executors and routes.
 *
 * The asset side is created lazily: a pure scene-mode document must not pay for
 * an `AssetExecutorContext` (it installs a trash group in the scene on first use).
 */
export class RvUnifiedExecutor implements RvExecutor {
  /** The active projection — moved only by {@link setMode}, from `RvDocument.setProjection`. */
  private _mode: RvDocumentMode;
  private readonly _viewer: RVViewer;
  private _asset: AssetExecutorContext | null = null;

  /**
   * `assetExecutor` lets a caller that already owns an {@link AssetExecutorContext}
   * hand it in instead of having one created lazily.
   *
   * `AssetDocument` needs this: it exposes `doc.executor` as a stable public
   * handle (the CAD/merge/separate payload hand-off and the
   * `takeMissingCadGeometry` reporting all go through that identity), so the
   * context must exist eagerly and be the SAME object the document publishes.
   * A scene-mode document passes nothing and keeps the lazy behaviour.
   */
  constructor(viewer: RVViewer, mode: RvDocumentMode, assetExecutor?: AssetExecutorContext) {
    this._viewer = viewer;
    this._mode = mode;
    this._asset = assetExecutor ?? null;
  }

  get mode(): RvDocumentMode { return this._mode; }

  /**
   * IMPLEMENTS RvExecutor::setMode — the executor half of `setProjection`.
   *
   * Never called directly: `RvDocument.setProjection` is the one transition, so
   * the two fields cannot drift.
   */
  setMode(mode: RvDocumentMode): void {
    this._mode = mode;
  }

  /**
   * Take over the asset-side context of a document that is being projected into
   * the editor (plan-711 §2.3, R1-A1/A2).
   *
   * The reason this exists at all is object IDENTITY: `AssetDocument` publishes
   * its `AssetExecutorContext` as `doc.executor` and hands CAD/merge/separate
   * payloads to it by that handle, so a bound document must drive the SAME
   * object the editor talks to — not a second one this class would otherwise
   * create lazily on the first asset op.
   *
   * ## What it deliberately does NOT do: carry the old context over
   *
   * The spike measured that (plan-711 Spike (d), `spike-projection-recompose.test.ts`
   * MESSUNG d1/d2). `AssetExecutorContext._trash` stores `{node, parent,
   * childIndex}` as OBJECT REFERENCES into the tree that was live when the
   * delete happened, and `_trashGroup` hangs in that tree's scene. A projection
   * change replaces the tree, so undoing a `deleteNode` afterwards re-attaches
   * the node to a DETACHED parent — and `_restoreFromTrash` then registers that
   * subtree in the LIVE registry, where the path resolves to a ghost that
   * shadows the real node standing at exactly the same path. Every later op and
   * every save-path lookup gets the ghost. That is worse than losing the undo.
   *
   * So the caller hands in a context built against the CURRENT tree, and the
   * ops whose inverse depended on the dropped state are re-projected instead
   * (`recomposeProjection`). `_cadPayloads` is the counter-example and needs no
   * special handling: it is op-id-keyed and holds parsed subtrees that belong to
   * no tree, so it would survive — but it lives on the context that is being
   * replaced, which is why {@link AssetExecutorContext} carries the payloads
   * across itself rather than this method reaching into two contexts.
   *
   * The previous context is DISPOSED here: it owns a trash group in a scene
   * nobody shows any more.
   */
  adoptAssetContext(ctx: AssetExecutorContext): void {
    if (this._asset === ctx) return;
    this._asset?.dispose();
    this._asset = ctx;
  }

  /**
   * Drop the asset-side context (plan-711 §2.2, the un-bind).
   *
   * The mirror of {@link adoptAssetContext}, and it deliberately goes back to
   * NULL rather than to some previous context: the next asset op will build one
   * against whatever tree is live then, which is the only correct answer after
   * a projection change (see the tree-bound-state note above). Cheap, because a
   * scene-mode document that never sees an asset op never pays for one.
   */
  releaseAssetContext(): void {
    this._asset?.dispose();
    this._asset = null;
  }

  /**
   * The asset executor context, imported and constructed on first use.
   *
   * The import is DYNAMIC, not just the construction. `rv-asset-executors` pulls
   * in the whole asset-editor graph — mesh merge, mesh separator, the CAD
   * provider and their workers — and since Phase 3 the always-loaded
   * `scene-store` reaches this module. A static import therefore moved that
   * graph into the core bundle: measured as a second timeout in
   * `ui-lazy-panels.test.tsx`, which is precisely a chunk-loading test. Lazily
   * constructing an eagerly-imported class would not have helped — bundling
   * follows the import, not the `new`.
   *
   * `AssetDocument` injects its own instance in the constructor, so the asset
   * lineage never reaches this path and pays no dynamic-import latency.
   */
  private async _ensureAsset(): Promise<AssetExecutorContext> {
    if (!this._asset) {
      const { AssetExecutorContext: Ctor } = await import('../editor/rv-asset-executors');
      // Re-check: an await is a suspension point, and two ops can race here.
      if (!this._asset) this._asset = new Ctor(this._viewer);
    }
    return this._asset;
  }

  /** True once an asset executor exists (injected, or built by a first asset op). */
  get hasAssetExecutor(): boolean { return this._asset !== null; }

  /** The asset executor context — only valid once it exists ({@link hasAssetExecutor}). */
  get assetExecutor(): AssetExecutorContext {
    if (!this._asset) throw new Error('[rv-ops] no asset executor on this document');
    return this._asset;
  }

  async applyForward(op: RvOp): Promise<void> {
    const target = resolveOpTarget(op, this.mode);
    if (target === null) {
      // Empty or mixed composite — the only case that is split here.
      if (op.kind !== 'composite') {
        throw new Error(`[rv-ops] ${op.kind} has no target (op ${op.id})`);
      }
      for (const child of op.ops) await this.applyForward(child);
      return;
    }
    if (target === 'asset') {
      await (await this._ensureAsset()).applyForward(op as RvAssetOp);
      return;
    }
    await applySceneForward(op as RvSceneOp, { viewer: this._viewer });
  }

  async applyInverse(op: RvOp): Promise<void> {
    const target = resolveOpTarget(op, this.mode);
    if (target === null) {
      if (op.kind !== 'composite') {
        throw new Error(`[rv-ops] ${op.kind} has no target (op ${op.id})`);
      }
      for (let i = op.ops.length - 1; i >= 0; i--) await this.applyInverse(op.ops[i]);
      return;
    }
    if (target === 'asset') {
      await (await this._ensureAsset()).applyInverse(op as RvAssetOp);
      return;
    }
    await applySceneInverse(op as RvSceneOp, { viewer: this._viewer });
  }

  /** Release the asset side's trash / payload maps (document close). */
  dispose(): void {
    this._asset?.dispose();
    this._asset = null;
  }
}
