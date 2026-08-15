// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-recompose — Descend and Back (plan-703 Phase 4, §2.7.2/§2.7.3).
 *
 * `rv-document-stack.ts` is synchronous bookkeeping. This is the half that
 * touches bytes: entering a reference, and putting the parent back together
 * when the user comes out again.
 *
 * ══ THE MEASUREMENT (§2.7.3) — decided 2026-08-10 ═══════════════════════════
 *
 * §2.7.3 left one question open and made Phase 4 answer it with a measurement:
 * does grafting the child's new bytes into the LIVE parent tree suffice, or
 * does Back need a full reload of the parent (bytes + op-log replay)?
 *
 * **Measured: the full parent reload. The subtree way does not carry.**
 * Evidence is `tests/rv-document-stack-recompose.test.ts`, which executes the
 * plan's step-1..4 table by hand against a live parent and pins three results:
 *
 * | | what the subtree way does |
 * |---|---|
 * | MESSUNG A | `traverseAndRegister` only ADDS. Nothing in the step-3/4 table evicts the detached subtree, so its old paths keep resolving — to nodes no longer in the scene. `NodeRegistry.unregisterSubtree` exists but is not part of the sequence, and a Back that leaves ghost paths breaks the next save's path lookups. |
 * | MESSUNG B | `buildGroups` **constructs** a `GroupRegistry`; there is no incremental merge into the one the viewer already holds — and the isolation gate (`rv-viewer.ts:3553`), the renderer's 3-pass isolate and the dimming all close over that one instance. The child's groups land in a throwaway. |
 * | MESSUNG C | `driveNodeSet` is returned ONCE by the load's `processMeshes` and handed to `rv-arena-planner` / `rv-batched-render`. A subtree re-run yields a second set no consumer holds; the parent's shadow/batch classification never learns about the new nodes. |
 *
 * Two of those three have **no incremental API at all** — they are constructed
 * singletons. Building one would mean new merge paths through the group
 * registry, the arena planner and the batch table, i.e. exactly the do-not-touch
 * surface of `doc-render-picking.md` (§5.1). The full reload costs one parse of
 * a file that is already in the blob cache and buys the phases verbatim,
 * because it IS the normal load path. So that is what ships, and the plan's
 * "Erwartungshaltung nach Runde 2" is confirmed rather than overridden.
 *
 * ── How the op log survives the reload ──────────────────────────────────────
 *
 * The parent's file on disk holds its SAVED bytes; its unsaved ops live only in
 * the op log. So the reload cannot be `restoreHistory` alone (that re-attaches
 * metadata to a tree which already contains the ops — the in-place test
 * session's case, plan-410 §2.4). Here the ops have to be applied to the fresh
 * tree AND the log must come back byte-identical, including its clean-point
 * baseline, or a document that was clean would come back dirty:
 *
 *   1. `captureHistory()` — freeze ops, redo, baselineIds, floor, metaDirty;
 *   2. host reloads the base bytes (fresh tree, fresh registry, fresh groups);
 *   3. re-apply every op straight through `doc.executor.applyForward` —
 *      BYPASSING the log, which must not gain a second copy of its own ops;
 *   4. `restoreHistory(frozen)` — the log is exactly what it was, so `dirty`
 *      is exactly what it was.
 */

import type { Object3D } from 'three';
import { getAssetReference, isUnresolvedReferenceNode } from '../engine/rv-asset-reference';
import { isMissingReferencePlaceholder } from '../engine/rv-missing-reference-placeholder';
import { getNodeId } from '../engine/rv-node-id';
import { recomposeProjection } from './rv-document-projection';
import {
  countInstanceOverrides,
  type RvDocumentStack,
  type RvPendingOverrideSource,
  type RvStackDocument,
  type RvStackFrame,
} from './rv-document-stack';

/** The one strategy Phase 4 measured its way to — see the header. */
export const RECOMPOSE_STRATEGY = 'full-parent-reload';

// ─── Host ───────────────────────────────────────────────────────────────

export interface RvOpenChildRequest {
  /** The reference node in the parent tree that is being entered. */
  reference: Object3D;
  /** Asset the reference points at. */
  assetId: string;
  /** Occurrence chain the child frame will carry. */
  occurrence: string;
}

export interface RvOpenedChild {
  doc: RvStackDocument;
  name: string;
  /**
   * What the child frame isolates. Usually the loaded child root(s); an empty
   * array means "isolate nothing", which the stack treats as the root case.
   */
  isolatedRoots: Object3D[];
}

export interface RvReloadedFrame {
  /**
   * The roots this frame isolates AFTER the reload.
   *
   * They must be recomputed: the reload replaced the tree, so the `Object3D`s
   * the frame recorded on its way in are detached objects now.
   */
  isolatedRoots: Object3D[];
}

/** A reason the stack could not do what was asked, for the Problems panel. */
export interface RvStackProblem {
  kind: 'child-missing' | 'child-unresolved' | 'reload-failed';
  message: string;
  assetId?: string;
  occurrence?: string;
}

/**
 * Everything Descend/Back needs from the world outside the op log.
 *
 * Narrow on purpose: a renderer-free test satisfies it with three closures, and
 * the production implementation is the asset-editor plugin, which already owns
 * `viewer.loadModel` and the library resolution.
 */
export interface RvRecomposeHost {
  /** Load the child asset as its own document. Rejects when it cannot. */
  openChild(request: RvOpenChildRequest): Promise<RvOpenedChild>;
  /**
   * Reload `frame`'s document from its own bytes — the full normal load path.
   * The op replay is NOT the host's job; {@link RvDescendController} does it.
   */
  reloadFrame(frame: RvStackFrame): Promise<RvReloadedFrame>;
  /**
   * Detach the simulation runtime (§2.7.3, last row): a descend puts the
   * document into the `editor` scope exactly like a normal mode change.
   */
  detachRuntime?(): void;
  /**
   * The UNSAVED field edits of the open document, for the descend hint.
   *
   * Optional, and its absence is honest rather than lossy: a host without an
   * inspector overlay (every test double, the crash-recovery path) has no
   * pending edits to report, and the hint then means what it always meant.
   * Where it exists it is the SAME overlay the inspector's override badge
   * unions in — see {@link RvPendingOverrideSource}.
   */
  pendingOverrides?(): RvPendingOverrideSource | null;
  /** Surface a problem instead of throwing. */
  reportProblem?(problem: RvStackProblem): void;
}

// ─── Verdicts ───────────────────────────────────────────────────────────

export type RvDescendRefusal =
  /** Not a reference node at all. */
  | 'not-a-reference'
  /**
   * The reference is `embedded`: a flat export already inlined the subtree and
   * left the reference behind as a provenance note. There is no separate file.
   */
  | 'embedded'
  /** A placeholder — composition resolved nothing, so there are no bytes. */
  | 'unresolved'
  /** The reference node carries no NodeId, so no occurrence can be formed. */
  | 'no-node-id'
  /** No root frame yet. */
  | 'no-stack';

export type RvDescendVerdict =
  | { ok: true; assetId: string; referenceNodeId: string }
  | { ok: false; reason: RvDescendRefusal };

export type RvBackOutcome =
  /** Popped and the parent recomposed. */
  | { status: 'ok'; frame: RvStackFrame; staleReason: RvStackFrame['staleReason'] }
  /** Already at the bottom — nothing to pop. */
  | { status: 'at-root' }
  /** The top frame has unsaved work; the caller must run the exit guard. */
  | { status: 'blocked-dirty'; frame: RvStackFrame }
  /** The parent could not be reloaded. The stack was popped anyway. */
  | { status: 'reload-failed'; frame: RvStackFrame; error: unknown };

// ─── Controller ─────────────────────────────────────────────────────────

export class RvDescendController {
  constructor(
    private readonly stack: RvDocumentStack,
    private readonly host: RvRecomposeHost,
  ) {}

  /**
   * May this reference node be entered?
   *
   * Pure and cheap, so the UI can gate the verb rather than let the user click
   * into a failure — §2.7.3 requires the Descend verb to be DISABLED on a
   * placeholder, which is what `unresolved` expresses.
   */
  canDescend(reference: Object3D): RvDescendVerdict {
    if (this.stack.isEmpty) return { ok: false, reason: 'no-stack' };
    const ref = getAssetReference(reference);
    if (!ref) return { ok: false, reason: 'not-a-reference' };
    if (!isUnresolvedReferenceNode(reference)) return { ok: false, reason: 'embedded' };
    // A PLACEHOLDER is a reference composition could not resolve. There are no
    // bytes behind it, and §2.7.3 requires the verb to be disabled rather than
    // to fail on click.
    //
    // Two tests, because Phase 8 changed what "unresolved" looks like: until
    // then the node stood EMPTY, and since then it carries a wireframe
    // stand-in. The emptiness test alone would now wave a placeholder through;
    // the marker test alone would miss a composition run before Phase 8 (a
    // recompose against a cached tree, a fixture). Both stay.
    if (reference.children.length === 0) return { ok: false, reason: 'unresolved' };
    if (reference.children.every(isMissingReferencePlaceholder)) {
      return { ok: false, reason: 'unresolved' };
    }
    const nodeId = getNodeId(reference);
    if (!nodeId) return { ok: false, reason: 'no-node-id' };
    return { ok: true, assetId: ref.assetId, referenceNodeId: nodeId };
  }

  /**
   * Enter the child asset of `reference` — isolated, in its own document.
   *
   * The parent's instance overrides are NOT carried in: the child is opened
   * from its OWN bytes, so they are absent by construction rather than by an
   * undo pass. What the frame records is how MANY are hidden, which is what the
   * hint line §2.7.2 asks for — including the ones the user typed a second ago
   * and has not saved yet, which are hidden exactly as hard as the saved ones.
   */
  async descend(reference: Object3D): Promise<RvStackFrame> {
    const verdict = this.canDescend(reference);
    if (!verdict.ok) {
      throw new Error(`descend refused: ${verdict.reason}`);
    }
    const parent = this.stack.top!;
    // A descend is a mode change for the runtime — the same detach a normal one
    // performs, not a special case (§2.7.3).
    this.host.detachRuntime?.();

    const occurrence = parent.occurrence
      ? `${parent.occurrence}/${verdict.referenceNodeId}`
      : verdict.referenceNodeId;

    let opened: RvOpenedChild;
    try {
      opened = await this.host.openChild({
        reference,
        assetId: verdict.assetId,
        occurrence,
      });
    } catch (e) {
      this.host.reportProblem?.({
        kind: 'child-missing',
        message: `The referenced asset could not be opened: ${String(e)}`,
        assetId: verdict.assetId,
        occurrence,
      });
      throw e;
    }

    return this.stack.push({
      doc: opened.doc,
      assetId: verdict.assetId,
      name: opened.name,
      referenceNodeId: verdict.referenceNodeId,
      isolatedRoots: opened.isolatedRoots,
      suppressedOverrides: countInstanceOverrides(reference, this.host.pendingOverrides?.()),
    });
  }

  /**
   * Leave the top frame and put the parent back together.
   *
   * `force` skips the dirty guard and DISCARDS the top frame's unsaved work —
   * it is the "discard" answer of the exit guard, never a default.
   */
  async back(opts?: { force?: boolean }): Promise<RvBackOutcome> {
    const top = this.stack.top;
    if (!top || this.stack.depth <= 1) return { status: 'at-root' };
    if (top.doc.document.dirty && !opts?.force) {
      return { status: 'blocked-dirty', frame: top };
    }

    // Pop first: this aborts any open transaction on the leaving frame and
    // replays the parent's isolation intent. Those roots are about to be
    // replaced by the reload, and `reisolate` below installs the new ones —
    // the double call is deliberate, because the pop contract (§9.4) has to
    // hold for callers that do not reload at all.
    const popped = this.stack.pop()!;
    popped.doc.dispose();

    const parent = this.stack.top!;
    try {
      const roots = await recomposeFrame(parent, this.host);
      this.stack.reisolate(roots);
    } catch (e) {
      this.host.reportProblem?.({
        kind: 'reload-failed',
        message: `The parent document could not be recomposed: ${String(e)}`,
        assetId: parent.assetId,
        occurrence: parent.occurrence,
      });
      return { status: 'reload-failed', frame: parent, error: e };
    }

    return { status: 'ok', frame: parent, staleReason: parent.staleReason };
  }
}

// ─── The recomposition itself ───────────────────────────────────────────

/**
 * Rebuild `frame`'s scene from its bytes and put its op log back on top.
 *
 * Exported separately from the controller because the crash-recovery path
 * (Phase 2's `planStackRecovery`) reinstates frames the same way, and because
 * it is the unit the acceptance test §9.4b measures.
 */
export async function recomposeFrame(
  frame: RvStackFrame,
  host: RvRecomposeHost,
): Promise<Object3D[]> {
  let reloaded: RvReloadedFrame = { isolatedRoots: [] };
  // The four steps live in `recomposeProjection` since plan-711 Phase 2+3 —
  // freeze, (switch projection), reload, replay without recording, restore.
  // Two things changed for THIS caller and both are widenings rather than
  // behaviour changes:
  //
  //  - the lock now spans the RELOAD as well, not only the replay. Two fast
  //    switches must serialise, and reload-outside/replay-inside left exactly
  //    that window open (plan-711 R2-Arch-F3).
  //  - `replay: 'all'` keeps the unfiltered replay Descend/Back has always
  //    done. A frame stays in ONE projection, so its log is single-origin by
  //    construction and the projection filter would be a no-op here — stating
  //    it is cheaper than making the next reader prove it.
  await recomposeProjection({
    doc: frame.doc.document,
    replay: 'all',
    label: frame.name,
    reload: async () => { reloaded = await host.reloadFrame(frame); },
  });
  return reloaded.isolatedRoots;
}
