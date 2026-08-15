// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-document — the asset-editor's view of the ONE op-log document.
 *
 * ── What changed in plan-703 Phase 3 ────────────────────────────────────────
 *
 * This class used to *be* an op-log document: it carried its own single-flight
 * queue, transaction orchestration, coalescing, undo/redo stacks, dirty
 * derivation and React store — a second, independently maintained copy of the
 * machinery `SceneStore` also carried. All of that is now GONE from here and
 * delegated to a single {@link RvDocument} in `'asset'` mode. Phase 1 built that
 * class; this is the point at which it acquires a production consumer.
 *
 * What is left here is what is genuinely asset-specific and belongs nowhere
 * else:
 *   - the {@link AssetBase} the document was opened from,
 *   - WHICH draft frame this document writes to, and the test-session
 *     suspension of that writing — the writing itself is {@link RvDraftAutosave}
 *     since plan-710 Phase 2, which retired the hand-rolled debounce and the
 *     single legacy slot that used to sit beside it,
 *   - the convenience mutators that RESOLVE an op against the live scene
 *     (world-preserving reparent maths, `_N` name deduplication, merge/separate
 *     partitioning, per-mesh material `prev` capture) before handing it over.
 *
 * That split is the point: op-log mechanics are one implementation, op
 * CONSTRUCTION stays with the lineage that knows the geometry.
 *
 * The public API is deliberately UNCHANGED — `applyOp`, `withTransaction`,
 * `undo`/`redo`, `getSnapshot`, `executor`, every mutator. ~20 of these methods
 * are called directly by the MCP editor tools, which are an external API surface
 * used by agents; their names and return shapes are a contract, not an
 * implementation detail.
 *
 * Since plan-710 there is nothing left to convert on the way in or out: ops are
 * authored, applied and persisted as {@link RvAssetOp}, the origin-filtered view
 * of the ONE union. The `upcastAssetOp` / `toAssetOp` pair that used to bracket
 * every entry point is gone — it was an identity cast between two names for the
 * same records.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import { isModelRoot, isModelRootPath } from '../engine/rv-model-root';
import {
  AssetExecutorContext,
  type MergeMeshPayload,
  type SeparateMeshPayload,
} from './rv-asset-executors';
import {
  classifySubtree,
  type MergeClassification,
} from './rv-mesh-merge';
import {
  DEFAULT_WELD_THRESHOLD,
  computeGroupPartitions,
  computeMeshIslands,
  type SeparateMode,
} from './rv-mesh-separator';
import {
  type CADLinkExtras,
  type NodeTransform,
  type MaterialValue,
  type MergeKeptNodeSpec,
  type MergeOutputSpec,
  type MergeSourceSignature,
  assetOpHeader,
  dedupeComponentKey,
} from './rv-asset-ops';
import { RvDocument, type RvDocumentCore } from '../ops/rv-document';
import { RvUnifiedExecutor } from '../ops/rv-unified-executors';
import { needsRecomposeToUndo, undoViaRecompose } from '../ops/rv-document-projection';
import { makeAssetComposite } from '../ops/rv-unified-ops';
import type { RvOp, RvAssetOp, RvAssetPrimitiveOp } from '../ops/rv-unified-ops';
import type { AssetDraft, AssetDraftBase } from './rv-asset-draft-storage';
import {
  RvDraftAutosave,
  clearDocumentDraft,
  rootFrame,
  sharedDocumentFrame,
  type RvDraftBytesCache,
  type RvDraftFrameKey,
} from '../ops/rv-document-drafts';
import type { CadImportResult } from './rv-cad-provider';
import { putCadGlb } from '../import/rv-cad-glb-cache';
import { parseGlbSubtree } from '../engine/rv-glb-parse';
import { NodeRegistry } from '../engine/rv-node-registry';
import { captureMaterialPrev } from './rv-asset-material';
import { guardReferenceOp } from '../ops/rv-reference-guard';
import { outermostReference } from '../engine/rv-reference-scope';

/** Where the document started from. */
export type AssetBase = AssetDraftBase;

/**
 * Immutable UI snapshot (useSyncExternalStore).
 *
 * The three intrinsics come from {@link RvDocumentCore} — derived once in the
 * document layer, spread here (plan-710 §2.4). What this interface ADDS is what
 * is genuinely asset-specific: the identity and the base it was opened from.
 */
export interface AssetDocumentSnapshot extends RvDocumentCore {
  id: string;
  name: string;
  base: AssetBase;
  undoLabel: string | null;
  redoLabel: string | null;
  opCount: number;
}

/**
 * Everything a document's history consists of, frozen (plan-410 §2.4).
 *
 * Deliberately NOT an {@link AssetDraft}: a draft is a replay recipe, this is a
 * state photograph. See {@link AssetDocument.captureSessionState}.
 */
export interface AssetDocumentSessionState {
  shell: { id: string; name: string; base: AssetBase; createdAt: number };
  ops: RvAssetOp[];
  redoOps: RvAssetOp[];
  baselineIds: string[];
  metaDirty: boolean;
}

export class AssetDocument {
  readonly id: string;
  private _base: AssetBase;

  private readonly viewer: RVViewer;
  /**
   * The asset-lineage executor, created eagerly and published as a stable
   * handle: the CAD / separate / merge payload hand-off and the
   * `takeMissingCadGeometry` reporting all key on this identity.
   */
  readonly executor: AssetExecutorContext;

  /**
   * The one op-log document (plan-703 Phase 1). Everything this class used to
   * duplicate — queue, transactions, coalescing, undo/redo, dirty, cap — lives
   * here now, once.
   */
  private readonly _doc: RvDocument;
  private readonly _unsubDoc: () => void;

  /**
   * This facade BORROWED its document from another projection (plan-711 §2.2).
   *
   * Three things follow from it, and they are the whole difference: the
   * document is not disposed with the facade (its owner is still showing it),
   * the draft seam hangs on {@link RvDocument.attachCommitHook} instead of on
   * the constructor's `onChanged`, and a discard has a FLOOR to roll back to
   * rather than a whole log to clear.
   */
  private readonly _bound: boolean;
  /** Detaches the commit hook of a bound document; null when not bound. */
  private _detachCommitHook: (() => void) | null = null;
  /** `opCount` at the moment of the bind — see {@link discardBoundEdits}. */
  private _bindFloor = 0;
  /** Rebuilds this projection's tree — see {@link setReprojectTree}. */
  private _reprojectTree: (() => Promise<void>) | null = null;
  /** What the other projection's bytes hold of this log — {@link setDraftBytesCache}. */
  private _bytesCache: (() => RvDraftBytesCache | null) | null = null;

  /**
   * The ONE op-draft writer (plan-710 §2.3).
   *
   * This class used to carry its own `setTimeout` debounce and its own
   * `_writeDraft` branch beside {@link RvDraftAutosave}, which was finished code
   * that nothing ever instantiated. There is one writer now, it lives in the
   * draft layer, and the facade only decides WHICH FRAME it points at.
   */
  private readonly _autosave: RvDraftAutosave;
  /** Autosave is off while an editor test run holds the document (plan-410 F5). */
  private _autosaveSuspended = false;
  private _disposed = false;

  /**
   * A base swap is in flight — see {@link beginBaseSwap} (plan-710 §2.4).
   *
   * The asset counterpart of the scene lineage's `!loading` gate. It did not
   * exist before this phase: the scene had the guard, the asset lineage had the
   * same hazard and no answer for it.
   */
  private _baseSwapping = false;

  /**
   * This document's slot in the per-frame draft keyspace
   * (`<projectId>:<rootDocumentId>:<occurrenceChain>`).
   *
   * Never null since plan-710 Phase 2. A document that is not in a stack gets
   * its OWN root frame rather than falling back to a shared legacy slot — that
   * slot is gone, and "some documents write here, others there" was the split
   * this phase closed. {@link RvDocumentStack} still overrides it via
   * {@link setDraftFrame} for every frame it opens, root included, because only
   * the stack knows the project id and the occurrence chain.
   */
  private _draftFrame: RvDraftFrameKey;

  // React store plumbing. The document has its own snapshot; this one adds
  // `base`, which is asset-specific and therefore not in `RvDocumentSnapshot`.
  private _snapshot: AssetDocumentSnapshot | null = null;
  private readonly _listeners = new Set<() => void>();

  constructor(
    viewer: RVViewer,
    opts: {
      id: string;
      name: string;
      base: AssetBase;
      createdAt?: number;
      /**
       * BIND instead of construct (plan-711 §2.2, F2).
       *
       * The living `RvDocument` of the other projection, handed over — never
       * looked up. When present this facade does not mint a document: it
       * borrows one, so the op log, the undo/redo stacks, the clean point and
       * `dirty` are literally the same objects the scene is showing, which is
       * what "one Undo stack across the boundary" means.
       */
      adopt?: RvDocument;
    },
  ) {
    this.viewer = viewer;
    // A FRESH context in either case — never the one the other projection was
    // driving. `_trash`/`_trashGroup` hold references into the tree that has
    // just been replaced, and carrying them over does not merely lose an undo:
    // `_restoreFromTrash` re-registers the detached subtree into the LIVE
    // registry, where its path shadows the real node (plan-711 Spike (d),
    // MESSUNG d1). The ops that depended on it are re-projected instead.
    this.executor = new AssetExecutorContext(viewer);
    this.id = opts.id;
    this._base = opts.base;
    this._bound = opts.adopt !== undefined;
    this._doc = opts.adopt ?? new RvDocument({
      id: opts.id,
      name: opts.name,
      mode: 'asset',
      // Hand in OUR executor so `doc.executor` and the one the document drives
      // are the same object.
      executor: new RvUnifiedExecutor(viewer, 'asset', this.executor),
      // The asset lineage has no protected leading ops — undo goes to zero.
      baselineFloor: 0,
      createdAt: opts.createdAt,
      // Phase 2 named this the draft seam; this is it in production.
      onChanged: (doc) => {
        if (this._disposed || this._autosaveSuspended) return;
        this._autosave.onChanged(doc);
      },
      // Ops queued while the document's BASE is being swapped out are stale by
      // the time the queue reaches them (§2.4, R2-F4).
      canApply: () => !this._baseSwapping,
      // plan-710 F7 — the asset lineage's half of the page unload guard's
      // question. `hasPendingWrite` was built with the writer in Phase 2 and had
      // no consumer until now: an armed debounce is work that exists only in
      // memory, and the page guard asked nothing about it in any mode.
      hasUnpersistedWork: () => this._autosave.hasPendingWrite,
    });
    if (opts.adopt) {
      // The borrowed document's `onChanged` belongs to the lineage that built
      // it, and is a private readonly field there — so the asset half of the
      // seam arrives through the COMMIT-channel hook instead (plan-711
      // R2-Arch-F1), and leaves again with the binding. Deliberately not
      // `subscribe`: that also fires for busy transitions and for
      // `restoreHistory`, i.e. exactly during a recompose, which is the one
      // moment the log does not describe the tree.
      this._detachCommitHook = this._doc.attachCommitHook((doc) => {
        if (this._disposed || this._autosaveSuspended) return;
        this._autosave.onChanged(doc);
      });
      // The shared document is driven through OUR context from here on, so
      // `doc.executor === AssetDocument.executor` holds for a bound document
      // too — the identity the CAD/merge payload hand-off keys on (§9.7).
      const unified = this._doc.executor;
      if (unified instanceof RvUnifiedExecutor) unified.adoptAssetContext(this.executor);
      // The projection follows the executor in the same breath. `setProjection`
      // is what keeps `RvDocument.mode` (composite tagging, snapshot) and
      // `RvUnifiedExecutor.mode` (resolveOpTarget) from ever disagreeing.
      this._doc.setProjection('asset');
      // Metadata, not history: the borrowed document carries the scene's name
      // and the header card would otherwise read empty.
      this._doc.setNameSilently(opts.name);
      // What a discard of THIS binding has to take back (plan-711 R1-S1). Read
      // after the projection switch and before any editor op can be recorded.
      this._bindFloor = this._doc.opCount;
    }
    // A SHARED document keys its draft on its IDENTITY, not on this instance
    // (plan-711 §2.4, F5): both projections have to write the one slot, and the
    // side that recovers it after a crash never saw the instance id. Everything
    // else keeps the instance-keyed frame it always had.
    this._draftFrame = sharedDocumentFrame(opts.base) ?? rootFrame(null, opts.id);
    this._autosave = new RvDraftAutosave({
      frame: this._draftFrame,
      // Read at flush time, so a rename between edit and write is picked up.
      shell: () => ({
        id: this.id, name: this._doc.name, base: this._base, createdAt: this._doc.createdAt,
      }),
      bytesCache: () => this._bytesCache?.() ?? null,
    });
    // One subscription, forwarded: the document already coalesces notifications
    // across a transaction and a rollback, so this inherits that for free.
    this._unsubDoc = this._doc.subscribe(() => {
      this._snapshot = null;
      for (const fn of this._listeners) fn();
    });
  }

  /**
   * The unified document behind this facade.
   *
   * Exposed for the document stack (plan-703 Phase 4) and the unified draft
   * layer, which speak `RvOp`. Op AUTHORING still goes through this class.
   */
  get document(): RvDocument { return this._doc; }

  /** Fresh "Untitled" document. */
  static newUntitled(viewer: RVViewer): AssetDocument {
    return new AssetDocument(viewer, {
      id: 'asset_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      name: 'Untitled',
      base: { kind: 'empty' },
    });
  }

  // ─── Metadata ───────────────────────────────────────────────────────

  get name(): string { return this._doc.name; }
  get base(): AssetBase { return this._base; }
  get dirty(): boolean { return this._doc.dirty; }

  /**
   * Would a page reload lose work? (plan-710 F7)
   *
   * Not the same question as {@link dirty}, and stricter where it matters: a
   * dirty document whose op draft is already written comes back after an F5,
   * while one whose debounce has not fired does not. The page unload guard asks
   * this — through `ProjectStore.hasUnpersistedWork()` — in EVERY mode, so an
   * asset left open behind the planner is covered too.
   */
  hasUnpersistedWork(): boolean { return this._doc.hasUnpersistedWork(); }

  /** Rename the DOCUMENT (not a scene node). Metadata only — not an op, but
   *  marks the document dirty so the exit guard prompts to save. */
  renameDocument(name: string): void {
    this._doc.renameDocument(name);
  }

  // ─── Op application ─────────────────────────────────────────────────

  /** The op log, in the asset vocabulary. Read-only — mutate through the op API. */
  get ops(): readonly RvAssetOp[] { return this._doc.ops as readonly RvAssetOp[]; }

  /**
   * The ops appended since `index` — the TAIL only (plan-707 §2.3).
   *
   * Read-only, and deliberately not a new op kind: the {@link RvAssetOp} union
   * is untouched. It exists so the MCP effect probe can ask "what did this one
   * call append?" without taking the whole log for an answer it will slice
   * anyway. That mattered more before plan-710 (`ops` re-mapped the entire log
   * on every access); it is a plain cast today, but a probe that runs ahead of
   * EVERY editor write should not depend on that staying true.
   *
   * An index past the end yields an empty list rather than throwing — the log
   * can shrink under an undo between the two reads.
   */
  opsSince(index: number): readonly RvAssetOp[] {
    const from = Math.max(0, index);
    return this._doc.ops.slice(from) as readonly RvAssetOp[];
  }

  /** Queue an op: forward-apply to the live scene, then record it.
   *
   *  The returned promise REJECTS when the op did not apply, and the op is then
   *  NOT recorded. Recording an op the executor never applied is what produced
   *  "the scene disagrees with its own history" — and inside a bulk edit, a scene
   *  half-rebuilt with nothing to undo (plan-359 Phase 3). */
  applyOp(op: RvAssetOp): Promise<void> {
    const unified: RvOp = op;
    const verdict = guardReferenceOp(unified, (nodePath) => {
      const node = this.viewer.registry?.getNode(nodePath);
      if (!node) return null;
      return { reference: outermostReference(node, this.viewer.currentModelRoot ?? null) };
    });
    if (!verdict.ok) {
      // F8: a structural edit inside a referenced subtree cannot be WRITTEN
      // DOWN — `AssetOverrides` is a value merge patch and has no vocabulary
      // for tree surgery (§2.4, and §8's four independent confirmations).
      // Rejecting at the op is the honest place: earlier and the UI cannot
      // explain itself, later and the user has already lost the edit.
      return Promise.reject(new Error(verdict.message));
    }
    return this._doc.applyOp(unified);
  }

  /**
   * Collect every op applied inside `fn` into one composite undo unit.
   *
   * Re-entrant: a nested call folds its ops into the OUTER transaction (one undo
   * unit total) — this is what lets compound tools (e.g. the MCP kinematize tool)
   * reuse actions that open their own transactions.
   *
   * ALL-OR-NOTHING. If the body throws, or any op inside it failed (including the
   * fire-and-forget mutators, whose failure the document remembers), everything
   * the transaction did apply is rolled back, NOTHING is recorded, and the
   * original error is re-thrown at the caller.
   */
  async withTransaction(label: string, fn: () => Promise<void>): Promise<void> {
    await this._doc.withTransaction(label, fn);
  }

  /** Undo the newest op. The stacks move only AFTER the inverse applied — popping
   *  first (as this used to) discarded the entry on a failed undo, leaving the
   *  change in the scene with no way back.
   *
   *  At a BOUND document the newest op may belong to the OTHER projection —
   *  a planner placement, say, undone from the editor. Its inverse would not
   *  fail there; it would be swallowed while the log pops, and the tree and the
   *  history would part company in silence (plan-711 Spike (c), MESSUNG c1). So
   *  the decision is made by KIND, before anything is applied, and such an op is
   *  taken back by re-projecting the log without it. */
  async undo(): Promise<void> {
    const newest = this._doc.ops[this._doc.opCount - 1];
    if (this._bound && newest && this._reprojectTree
        && needsRecomposeToUndo(newest, this._doc.mode)) {
      const outcome = await undoViaRecompose({
        doc: this._doc,
        reload: this._reprojectTree,
        label: this._doc.name,
      });
      if (!outcome.ok && outcome.reason !== 'nothing-to-undo') {
        console.warn(`[rv-asset-document] undo deferred: ${outcome.message}`);
      }
      this._snapshot = null;
      for (const fn of this._listeners) fn();
      return;
    }
    await this._doc.undo();
  }

  /**
   * How to rebuild the tree this document is projected into (plan-711 §2.3).
   *
   * Supplied by the binder — only IT knows how the bytes of this projection are
   * produced (the editor loads the scene's bake through `viewer.loadModel`).
   * Absent means "no re-projection available", and the undo path then behaves
   * exactly as it did before the binding existed.
   */
  setReprojectTree(fn: (() => Promise<void>) | null): void {
    this._reprojectTree = fn;
  }

  /**
   * Where this document's BYTES projection stands (plan-711 §2.4).
   *
   * Supplied by the binder for the same reason as {@link setReprojectTree}: the
   * scene owns the bake, so only it can say which slot holds which revision at
   * which op count. Stamped into every draft write, and it is what lets the
   * recovery on the other side of a crash tell a usable cache from a stale one
   * instead of guessing (`decideDocumentRecovery`).
   */
  setDraftBytesCache(read: (() => RvDraftBytesCache | null) | null): void {
    this._bytesCache = read;
  }

  /** Redo the newest undone op. Same stack discipline as {@link undo}. */
  async redo(): Promise<void> {
    await this._doc.redo();
  }

  // ─── Base swap gate (plan-710 §2.4) ──────────────────────────────────

  /**
   * Declare that the document's BASE is being replaced — CAD re-import.
   *
   * Ops queued while this holds are dropped inside the queue: not applied, not
   * recorded, no error. That is the same contract the scene lineage has had
   * against a scene load (`canApply: () => !loading`), for the same reason. A
   * re-import spends seconds tessellating and parsing before it deletes the old
   * CAD root, and an edit issued in that window targets nodes that are about to
   * stop existing — applying it edits the outgoing tree, recording it puts an
   * unreplayable op in the incoming document's history.
   *
   * The gate covers the PREPARATION only. The re-import's own ops run after
   * {@link endBaseSwap}, inside its transaction, and must of course apply.
   *
   * Always pair through `try/finally`: a flag left standing silently swallows
   * every subsequent edit, which is worse than the hazard it guards.
   */
  beginBaseSwap(): void { this._baseSwapping = true; }

  /** End the window opened by {@link beginBaseSwap}. */
  endBaseSwap(): void { this._baseSwapping = false; }

  /** True while a base swap is in flight and ops are being refused. */
  get isBaseSwapping(): boolean { return this._baseSwapping; }

  // ─── Convenience op creators (EditTarget adapter + tools) ───────────

  /**
   * Attach freshly imported CAD geometry as an undoable op. Returns the root path.
   * `opts.name` overrides the root node name (re-import keeps the old name).
   *
   * The GLB bytes are cached under `(Sha256, Quality)` BEFORE the op is recorded,
   * so a later replay of that op always finds them. The tree that enters the
   * scene is parsed FROM those bytes — never from the importer's intermediate
   * representation — which is what guarantees import and reload agree on node
   * names, materials and transforms.
   *
   * `opts.root` lets a caller that already parsed `result.glb` (CADLink
   * re-import, which needs the tree to diff against the old revision) hand it
   * over instead of paying for a second parse. It MUST be the result of
   * `parseGlbSubtree(result.glb)` — passing any other tree silently breaks the
   * import-equals-reload invariant. Its local transform is what gets recorded.
   */
  async importCad(result: CadImportResult, opts?: { name?: string; root?: Object3D }): Promise<string> {
    const { Sha256, Quality } = result.cadlink;
    const tier = await putCadGlb(Sha256, Quality, result.glb);
    if (tier === 'none') {
      console.warn(
        `[asset-editor] "${result.cadlink.File}" could not be cached — it will NOT survive a reload. ` +
        'Open or create a project (Projects) to keep CAD imports.',
      );
    }

    const root = opts?.root ?? await parseGlbSubtree(result.glb);
    const assetRoot = this.viewer.currentModelRoot;
    const rootName = uniqueChildName(assetRoot, opts?.name ?? (stripExtension(result.cadlink.File) || 'CAD'));
    const rootPath = assetRoot ? childPath(assetRoot, rootName) : rootName;
    const header = assetOpHeader();
    // Hand the already-parsed tree to the executor so the fresh-import path does
    // not parse the same bytes twice (replay re-parses from the cache).
    this.executor.provideCadPayload(header.id, root);
    await this.applyOp({
      ...header,
      kind: 'importCad',
      rootPath,
      cadlink: { ...result.cadlink } as CADLinkExtras,
      transform: {
        position: root.position.toArray() as [number, number, number],
        quaternion: root.quaternion.toArray() as [number, number, number, number],
        scale: root.scale.toArray() as [number, number, number],
      },
    });
    return rootPath;
  }

  /**
   * Queue an op from one of the SYNC mutators below, whose `void` signature the
   * UI event handlers depend on and whose promise therefore nobody holds.
   *
   * Inside a transaction the document remembers the failure, so
   * `withTransaction` still rolls back and rejects: a caller that opened a
   * transaction always learns that part of it did not apply, even when the op was
   * issued through an API that cannot hand the error back directly.
   */
  private _voidApply(op: RvAssetOp): void {
    this._doc.applyOpDetached(op);
  }

  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): void {
    this._voidApply({ ...assetOpHeader(), kind: 'setField', nodePath, componentType, fieldName, value, prev });
  }

  unsetField(nodePath: string, componentType: string, fieldName: string, prev: unknown): void {
    this._voidApply({ ...assetOpHeader(), kind: 'unsetField', nodePath, componentType, fieldName, prev });
  }

  /**
   * Is `nodePath` the model root — the one node no structural verb may touch?
   *
   * The guard sits HERE rather than in each caller (plan-715 §2.4.4): every
   * structural op in the app — UI, MCP tools, quick-edit actions — funnels
   * through `AssetDocument`, so one check covers all of them, and a new caller
   * inherits it instead of having to remember it.
   *
   * Refusal is LOUD (a warning), not silent: an op that quietly does nothing is
   * how a caller learns the wrong lesson about what it may do. The Executor
   * REPLAY path is the deliberate exception — see `_rename`/`_applyTransform`.
   */
  private _rejectRootOp(nodePath: string, verb: string): boolean {
    if (!isModelRootPath(nodePath, this.viewer.registry, this.viewer.currentModelRoot)) return false;
    console.warn(
      `[asset-edits] ${verb} refused on the model root "${nodePath}": the GLB root is ` +
      'structurally locked (its name is the first segment of every node path, its pose ' +
      'is the asset origin). Edit its metadata instead.',
    );
    return true;
  }

  transformNode(nodePath: string, transform: NodeTransform, prev: NodeTransform): void {
    if (this._rejectRootOp(nodePath, 'transformNode')) return;
    this._voidApply({ ...assetOpHeader(), kind: 'transformNode', nodePath, transform, prev });
  }

  renameNode(nodePath: string, name: string, prevName: string): void {
    if (this._rejectRootOp(nodePath, 'renameNode')) return;
    this._voidApply({ ...assetOpHeader(), kind: 'renameNode', nodePath, name, prevName });
  }

  deleteNode(nodePath: string): void {
    this._voidApply({ ...assetOpHeader(), kind: 'deleteNode', nodePath });
  }

  /** Delete several nodes as ONE undo unit (paths must already be
   *  descendant-deduped — deleting an ancestor trashes its subtree). */
  async deleteNodes(nodePaths: string[]): Promise<void> {
    if (nodePaths.length === 0) return;
    if (nodePaths.length === 1) {
      await this.applyOp({ ...assetOpHeader(), kind: 'deleteNode', nodePath: nodePaths[0] });
      return;
    }
    await this.withTransaction(`Delete ${nodePaths.length} objects`, async () => {
      for (const nodePath of nodePaths) {
        await this.applyOp({ ...assetOpHeader(), kind: 'deleteNode', nodePath });
      }
    });
  }

  /** Show/hide a node (no-op when the state already matches). */
  setNodeVisible(nodePath: string, visible: boolean): void {
    if (this._rejectRootOp(nodePath, 'setNodeVisible')) return;
    const prev = this.viewer.registry?.getNode(nodePath)?.visible ?? true;
    if (prev === visible) return;
    this._voidApply({ ...assetOpHeader(), kind: 'setNodeVisible', nodePath, visible, prev });
  }

  /**
   * Apply a material to every mesh under each of `nodePaths`.
   *
   * The per-mesh inverse payload is resolved HERE (at op creation) rather than
   * in the executor, because a selection routinely spans meshes with different
   * starting materials and undo must restore each one exactly. Returns without
   * queueing when the selection contains no meshes.
   */
  setMaterial(nodePaths: string[], material: MaterialValue): void {
    const registry = this.viewer.registry;
    if (!registry || nodePaths.length === 0) return;
    const prev = captureMaterialPrev(registry, nodePaths);
    if (prev.length === 0) return;
    this._voidApply({ ...assetOpHeader(), kind: 'setMaterial', nodePaths: [...nodePaths], material, prev });
  }

  /** Create an empty node under `parentPath` (null = the asset root) as an
   *  undoable op. The name is `_N`-deduped against the parent's children at
   *  creation time (deterministic replay). Returns the new node's path. */
  async createEmptyNode(
    parentPath: string | null,
    baseName: string,
    opts?: { index?: number; transform?: NodeTransform },
  ): Promise<string> {
    const parent = parentPath
      ? this.viewer.registry?.getNode(parentPath) ?? null
      : this.viewer.currentModelRoot;
    if (!parent) throw new Error(`createEmptyNode: parent "${parentPath ?? '<root>'}" not found`);
    const name = uniqueChildName(parent, baseName);
    const nodePath = childPath(parent, name);
    await this.applyOp({
      ...assetOpHeader(),
      kind: 'createNode',
      nodePath,
      transform: opts?.transform ?? IDENTITY_TRANSFORM(),
      ...(opts?.index !== undefined ? { index: opts.index } : {}),
    });
    return nodePath;
  }

  /** Move nodes under a new parent (null = the asset root), preserving each
   *  node's WORLD transform. One undo unit. Nodes that would create a cycle
   *  or are the asset root itself are skipped. Name collisions under the target
   *  are resolved with a pre-rename op. Returns the paths of the moved nodes
   *  (post-move, post-rename).
   *
   *  `opts.index` (optional) is the sibling slot the moved block should occupy
   *  in the target parent's `children` array, counted **against the parent's
   *  current children with the moved nodes excluded** — i.e. "put the block so
   *  that `index` non-moved siblings precede it". This is exactly what the
   *  executor's splice consumes, and it lets drag-and-drop drop a node BETWEEN
   *  two rows. When omitted, the block is appended (classic reparent-onto).
   *  Supplying an index also enables **same-parent reordering** (a pure move
   *  within one parent is only rejected when no index is given). */
  async reparentNodes(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): Promise<string[]> {
    const targetIndex = opts?.index;
    const label = opts?.label;
    const registry = this.viewer.registry;
    const newParent = newParentPath
      ? registry?.getNode(newParentPath) ?? null
      : this.viewer.currentModelRoot;
    if (!registry || !newParent) return [];
    const parentPath = NodeRegistry.computeNodePath(newParent);

    // Filter out impossible moves up front so the transaction stays clean.
    const movable = nodePaths.filter((p) => {
      const node = registry.getNode(p);
      if (!node || !node.parent) return false;
      if (isModelRoot(node, this.viewer.currentModelRoot)) return false;
      // Same-parent is "already there" ONLY when no explicit slot is asked for;
      // with an index it is a legitimate reorder within the parent.
      if (node.parent === newParent && targetIndex === undefined) return false;
      for (let anc: Object3D | null = newParent; anc; anc = anc.parent) {
        if (anc === node) return false; // cycle
      }
      return true;
    });
    if (movable.length === 0) return [];

    // The requested slot is expressed against the parent's children with the
    // moved-and-staying nodes excluded, so it composes cleanly as we emit one
    // op per node: node i lands at `baseIndex + i`.
    const baseIndex = targetIndex === undefined
      ? undefined
      : Math.max(0, targetIndex);

    const movedPaths: string[] = [];
    const doMoves = async () => {
      for (let i = 0; i < movable.length; i++) {
        const path = movable[i];
        const node = registry.getNode(path);
        if (!node || !node.parent) continue;
        const sameParent = node.parent === newParent;
        let nodePath = path;
        // Pre-rename when the target parent already has a same-named child
        // (never for a same-parent reorder — the node keeps its own name).
        if (!sameParent && newParent.children.some((c) => c !== node && c.name === node.name)) {
          const newName = uniqueChildName(newParent, node.name);
          await this.applyOp({
            ...assetOpHeader(), kind: 'renameNode', nodePath, name: newName, prevName: node.name,
          });
          nodePath = replacePathLeaf(nodePath, newName);
        }
        // World-preserving local TRS under the new parent, computed NOW so the
        // executor only replays recorded numbers. A same-parent reorder keeps
        // the world (and thus local) transform — snapshot it directly.
        let transform: NodeTransform;
        if (sameParent) {
          transform = snapshotLocalTransform(node);
        } else {
          newParent.updateMatrixWorld(true);
          node.updateMatrixWorld(true);
          const local = new Matrix4()
            .copy(newParent.matrixWorld).invert()
            .multiply(node.matrixWorld);
          transform = decomposeToTransform(local);
        }
        const prevParent = node.parent;
        await this.applyOp({
          ...assetOpHeader(),
          kind: 'reparentNode',
          nodePath,
          newParentPath: parentPath,
          ...(baseIndex !== undefined ? { newIndex: baseIndex + i } : {}),
          transform,
          prevParentPath: NodeRegistry.computeNodePath(prevParent),
          prevIndex: prevParent.children.indexOf(node),
          prevTransform: snapshotLocalTransform(node),
        });
        movedPaths.push(joinPaths(parentPath, node.name));
      }
    };

    // A single collision-free move stays ONE op; a pre-rename must share the
    // undo unit with its reparent, so it forces a transaction.
    const singleNode = movable.length === 1 ? registry.getNode(movable[0]) : null;
    const singleNeedsRename = singleNode
      ? singleNode.parent !== newParent
        && newParent.children.some((c) => c !== singleNode && c.name === singleNode.name)
      : false;

    // Inside an outer transaction (e.g. "group into empty") the caller owns
    // the undo unit — just emit the ops.
    if (this._doc.inTransaction || (movable.length === 1 && !label && !singleNeedsRename)) {
      await doMoves();
    } else {
      const fallback = movable.length === 1
        ? `Move ${leafName(movable[0])}`
        : `Move ${movable.length} objects`;
      await this.withTransaction(label ?? fallback, doMoves);
    }
    return movedPaths;
  }

  /**
   * Move MANY nodes under one new parent as a single composite op — the bulk
   * counterpart of {@link reparentNodes}, with the same per-node result (world
   * pose preserved, sibling names deduped, full inverse payload recorded).
   *
   * Why it exists. `reparentNodes` emits one top-level op per node and awaits each
   * in turn, and `AssetExecutorContext._afterApply` runs once per TOP-LEVEL op — so
   * N moves paid N `editor-structure-changed` events, and each of those costs the
   * hierarchy panel a FULL `scene.traverse`. Measured on a 4493-node assembly with
   * 434 moves (plan-359 Phase 2): 217 ms total, of which 158 ms (73%) was the panel
   * re-scanning the whole scene 434 times. Matrix updates (19 ms) and registry path
   * remapping (12 ms) together were under 15% — the plan's "possibly quadratic
   * matrix update" suspicion did not survive measurement.
   *
   * Resolving the block into ONE composite fixes that at the root: one structure
   * event, one BVH classification, one matrix flush, one undo step.
   *
   * DELIBERATELY NOT A NEW OP KIND. It composes the existing `renameNode` and
   * `reparentNode` primitives inside ONE composite, so undo, redo, draft
   * replay, coalescing and the op-log schema all keep working untouched — a new
   * persisted kind would have had to be threaded through every switch in
   * `rv-asset-ops.ts` and would have changed the draft format for no measured gain
   * (plan-359 Alternative 5).
   *
   * Every path is resolved BEFORE the first mutation, so no earlier move can
   * invalidate a later lookup. Nodes that are descendants of another node in the
   * same batch are dropped: moving an ancestor and its descendant into the same
   * parent is contradictory, and it would strand the descendant's recorded path.
   *
   * Returns the post-move (post-rename) paths of the nodes that actually moved.
   */
  async reparentNodesBatch(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): Promise<string[]> {
    const registry = this.viewer.registry;
    const newParent = newParentPath
      ? registry?.getNode(newParentPath) ?? null
      : this.viewer.currentModelRoot;
    if (!registry || !newParent) return [];
    const targetIndex = opts?.index;
    const parentPath = NodeRegistry.computeNodePath(newParent);

    // ── resolve, in one pass over the untouched scene ──────────────────
    const movable: Object3D[] = [];
    const seen = new Set<Object3D>();
    for (const p of nodePaths) {
      const node = registry.getNode(p);
      if (!node || !node.parent) continue;
      if (isModelRoot(node, this.viewer.currentModelRoot)) continue;
      if (node.parent === newParent && targetIndex === undefined) continue;
      if (seen.has(node)) continue;
      let cyclic = false;
      for (let anc: Object3D | null = newParent; anc; anc = anc.parent) {
        if (anc === node) { cyclic = true; break; }
      }
      if (cyclic) continue;
      seen.add(node);
      movable.push(node);
    }
    // Drop descendants of other members (checked against the full member set, so
    // input order cannot decide who survives).
    const block = movable.filter((node) => {
      for (let anc = node.parent; anc; anc = anc.parent) {
        if (seen.has(anc)) return false;
      }
      return true;
    });
    if (block.length === 0) return [];

    // Names already claimed under the target, ignoring the nodes that are leaving
    // their old parents to come here.
    const taken = new Set(
      newParent.children.filter((c) => !seen.has(c)).map((c) => c.name),
    );
    // ONE forced matrix refresh for the whole resolve step — `reparentNodes` did
    // this per node, on a target group that grew with every move.
    this.viewer.currentModelRoot?.updateMatrixWorld(true);
    newParent.updateMatrixWorld(true); // covers a target outside the model root
    const parentWorldInverse = new Matrix4().copy(newParent.matrixWorld).invert();
    const baseIndex = targetIndex === undefined ? undefined : Math.max(0, targetIndex);

    // `prevIndex` must be the slot the node occupied AFTER the batch's earlier
    // members left the same parent — because the inverse restores them in reverse
    // order into a list that grows back one node at a time. Snapshotting all
    // indices against the untouched array instead scrambles sibling order on undo
    // (the per-node path gets this right only incidentally, by recomputing the
    // index between applies). One shrinking working copy per source parent
    // reproduces that semantics exactly.
    const remainingSiblings = new Map<Object3D, Object3D[]>();
    const prevIndexOf = (node: Object3D, parent: Object3D): number => {
      let list = remainingSiblings.get(parent);
      if (!list) { list = [...parent.children]; remainingSiblings.set(parent, list); }
      const index = list.indexOf(node);
      if (index >= 0) list.splice(index, 1);
      return Math.max(0, index);
    };

    const ops: RvAssetPrimitiveOp[] = [];
    const movedPaths: string[] = [];
    for (let i = 0; i < block.length; i++) {
      const node = block[i];
      const prevParent = node.parent!;
      const originalPath = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
      const sameParent = prevParent === newParent;

      let nodePath = originalPath;
      let finalName = node.name;
      if (!sameParent && taken.has(node.name)) {
        finalName = uniqueName(taken, node.name);
        ops.push({
          ...assetOpHeader(), kind: 'renameNode',
          nodePath, name: finalName, prevName: node.name,
        });
        nodePath = replacePathLeaf(nodePath, finalName);
      }
      if (!sameParent) taken.add(finalName);

      // World-preserving local TRS under the new parent, from the matrices
      // snapshotted above. A same-parent reorder keeps its local transform.
      const transform = sameParent
        ? snapshotLocalTransform(node)
        : decomposeToTransform(
            new Matrix4().copy(parentWorldInverse).multiply(node.matrixWorld),
          );

      ops.push({
        ...assetOpHeader(),
        kind: 'reparentNode',
        nodePath,
        newParentPath: parentPath,
        ...(baseIndex !== undefined ? { newIndex: baseIndex + i } : {}),
        transform,
        prevParentPath: NodeRegistry.computeNodePath(prevParent),
        prevIndex: prevIndexOf(node, prevParent),
        prevTransform: snapshotLocalTransform(node),
      });
      movedPaths.push(joinPaths(parentPath, finalName));
    }

    // ── apply as ONE top-level op ──────────────────────────────────────
    const label = opts?.label ?? (block.length === 1
      ? `Move ${leafName(movedPaths[0])}`
      : `Move ${block.length} objects`);
    if (ops.length === 1) {
      await this.applyOp(ops[0]);
    } else {
      // Origin-typed constructor, not an inline record: `ops` is the batch's own
      // asset-lineage primitives, and this is the point where that is still
      // provable (plan-710 §2.2).
      await this.applyOp(makeAssetComposite(label, ops));
    }
    return movedPaths;
  }

  /**
   * Split a mesh into its connected islands (or its material groups), replacing
   * it with a same-named Group that carries the parts.
   *
   * `preview` is the result the confirmation dialog already computed — handed to
   * the executor under the op's id via the same mechanism `importCad` uses for
   * its parsed tree, so the apply does not repeat the analysis. The executor
   * validates it against the live geometry and recomputes if it went stale;
   * replay finds no payload and always recomputes.
   *
   * The child names are resolved HERE, once, and applied verbatim afterwards
   * (plan-331 §2.3) — `uniqueName` is the same `_N` convention
   * `dedupeSiblingNames()` uses, but claims names incrementally, which is what a
   * batch of N names against one parent needs.
   *
   * Returns the generated child names (empty when there is nothing to split).
   */
  async separateMesh(
    sourcePath: string,
    mode: SeparateMode,
    opts?: { weldThreshold?: number },
    preview?: SeparateMeshPayload,
  ): Promise<string[]> {
    const source = this.viewer.registry?.getNode(sourcePath) as Mesh | null;
    if (!source || !(source as { isMesh?: boolean }).isMesh) {
      throw new Error(`separateMesh: "${sourcePath}" is not a live mesh`);
    }
    const weldThreshold = opts?.weldThreshold ?? DEFAULT_WELD_THRESHOLD;
    const geometry = source.geometry as BufferGeometry;
    const partitions = preview?.partitions
      ?? (mode === 'groups'
        ? computeGroupPartitions(geometry)
        : computeMeshIslands(geometry, weldThreshold));
    if (partitions.length < 2) return [];

    // Unity parity: `MeshSeparator.cs` names the children `<mesh>_part<idx>`.
    const taken = new Set(source.children.map((c) => c.name));
    const base = source.name || 'Part';
    const childNames = partitions.map((_, i) => {
      const name = uniqueName(taken, `${base}_part${i}`);
      taken.add(name);
      return name;
    });

    const header = assetOpHeader();
    // Without a preview the partition above was still computed here, to resolve
    // the names — hand it over as an analyze-only payload so the executor does
    // not pay for a second union-find.
    this.executor.provideSeparatePayload(header.id, preview ?? {
      sourceGeometry: geometry,
      vertexCount: geometry.getAttribute('position')?.count ?? -1,
      partitions,
      geometries: [],
    });
    try {
      await this.applyOp({
        ...header, kind: 'separateMesh', sourcePath, mode, weldThreshold, childNames,
      });
    } catch (e) {
      // The payload holds the extracted geometries; a failed apply must not keep
      // them (and their buffers) alive for an op that will never run. (The
      // executor already consumes it on the happy path — this covers the case
      // where it never got that far.)
      this.executor.discardSeparatePayload(header.id);
      throw e;
    }
    return childNames;
  }

  /**
   * Collapse the subtree of one node into one mesh per material AND per Group, replacing
   * the node with a same-named `Mesh` (plan-372). The inverse of {@link separateMesh}.
   *
   * The whole partition — sources, buckets, output names, owner zones and surviving
   * nodes — is resolved HERE, once, and applied verbatim afterwards. That is stricter
   * than `separateMesh` for a concrete reason: bucketing depends on the MATERIAL, so an
   * executor that re-classified on replay would produce a different split as soon as a
   * `setMaterial` op ran in between — different meshes, different paths, and every later
   * op editing the wrong tree.
   *
   * Returns the plan that was applied, or `null` when the subtree is not mergeable (no
   * op is created in that case).
   */
  async mergeMesh(rootPath: string, preview?: MergeMeshPayload): Promise<MergeMeshPlan | null> {
    const plan = planMergeMesh(this.viewer, rootPath);
    if (!plan || plan.ineligibleReason) {
      for (const geometry of preview?.geometries ?? []) geometry?.dispose();
      return null;
    }

    const header = assetOpHeader();
    if (preview) this.executor.provideMergePayload(header.id, preview);
    try {
      await this.applyOp({
        ...header,
        kind: 'mergeMesh',
        rootPath,
        sourcePaths: plan.sourcePaths,
        sourceSignatures: plan.sourceSignatures,
        outputs: plan.outputs,
        kept: plan.kept,
      });
    } catch (e) {
      // A failed apply must not keep the pre-built geometries alive for an op that will
      // never run. (The executor consumes them on the happy path.)
      this.executor.discardMergePayload(header.id);
      throw e;
    }
    return plan;
  }

  /** Add a component; the key is deduped against the node's current rv_extras. */
  addComponent(nodePath: string, baseType: string, fields: Record<string, unknown>): string {
    const node = this.viewer.registry?.getNode(nodePath);
    const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
    const componentType = dedupeComponentKey(rv, baseType);
    this._voidApply({ ...assetOpHeader(), kind: 'addComponent', nodePath, componentType, fields });
    return componentType;
  }

  removeComponent(nodePath: string, componentType: string): void {
    const node = this.viewer.registry?.getNode(nodePath);
    const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    const prevFields = { ...(rv?.[componentType] ?? {}) };
    this._voidApply({ ...assetOpHeader(), kind: 'removeComponent', nodePath, componentType, prevFields });
  }

  // ─── Draft persistence ───────────────────────────────────────────────

  /** Replay a recovered draft's ops onto the freshly loaded base. */
  async replayOps(ops: readonly RvOp[]): Promise<void> {
    await this._doc.replayOps(ops);
  }

  toDraft(): AssetDraft {
    return {
      shell: { id: this.id, name: this._doc.name, base: this._base, createdAt: this._doc.createdAt },
      ops: [...this._doc.ops],
      savedAt: Date.now(),
    };
  }

  /**
   * Persist the draft NOW (bypasses the debounce — used by the exit guard and
   * by the end of an in-place test run).
   *
   * `writeNow` rather than `flush`: on both of those paths autosave was
   * suspended or already flushed, so there may be no announced change pending,
   * and a plain flush would write nothing at all.
   */
  async flushDraft(): Promise<void> {
    await this._autosave.writeNow(this._doc);
  }

  // ─── Draft frame ─────────────────────────────────────────────────────

  /** This document's per-frame draft slot. */
  get draftFrame(): RvDraftFrameKey { return this._draftFrame; }

  /**
   * Point the document at a stack frame's draft slot.
   *
   * A pending debounced write is CANCELLED rather than redirected: it described
   * the document under the old key, and writing it under the new one is exactly
   * the cross-frame contamination the per-frame keyspace exists to prevent.
   * {@link RvDraftAutosave.setFrame} is that rule; this just forwards.
   */
  setDraftFrame(frame: RvDraftFrameKey): void {
    this._draftFrame = frame;
    this._autosave.setFrame(frame);
  }

  // ─── Editor test session (plan-410 F5) ───────────────────────────────

  /**
   * Stop autosaving until {@link resumeAutosave} (in-place test run).
   *
   * The test replaces the live scene with a materialised copy; the draft slot
   * must keep describing the PRE-TEST authoring state for the whole run, so a
   * crash mid-test recovers the document the user was editing — not the test
   * scene. A pending debounced write is cancelled, not deferred.
   */
  suspendAutosave(): void {
    this._autosaveSuspended = true;
    this._autosave.cancel();
  }

  /** Re-enable autosave after {@link suspendAutosave}. Does not write. */
  resumeAutosave(): void {
    this._autosaveSuspended = false;
  }

  /** True while autosave is suspended (test run in progress). */
  get isAutosaveSuspended(): boolean { return this._autosaveSuspended; }

  /**
   * Freeze everything the document's HISTORY consists of, so a test run can put
   * it back byte for byte (plan-410 §2.4).
   *
   * Not `toDraft()`: a draft is a REPLAY recipe, and replaying it after a save
   * would re-apply ops that `markSaved` already baked into the base — a clean
   * document would come back dirty (review finding R1-2). The scene itself is
   * restored from the exported GLB blob instead; this carries only the metadata
   * that the blob cannot: op log, redo stack, clean-point baseline, rename flag.
   *
   * Every array is copied — the live stacks keep moving underneath.
   */
  captureSessionState(): AssetDocumentSessionState {
    const history = this._doc.captureHistory();
    return {
      shell: { id: this.id, name: this._doc.name, base: this._base, createdAt: this._doc.createdAt },
      ops: history.ops as RvAssetOp[],
      redoOps: history.redoOps as RvAssetOp[],
      baselineIds: history.baselineIds,
      metaDirty: history.metaDirty,
    };
  }

  /**
   * Put a {@link captureSessionState} snapshot back, WITHOUT replaying anything
   * (plan-410 §2.4). The caller has already re-loaded the exported blob, so the
   * scene is the frozen authoring state; this only re-attaches the history to
   * it. Autosave resumes — the document is exactly as dirty (or clean) as it
   * was before the test.
   */
  restoreFromSnapshot(state: AssetDocumentSessionState): void {
    this._base = state.shell.base;
    this._doc.restoreHistory({
      ops: [...state.ops],
      redoOps: [...state.redoOps],
      baselineIds: [...state.baselineIds],
      baselineFloor: 0,
      metaDirty: state.metaDirty,
    });
    // The name is metadata, not history: put it back WITHOUT `renameDocument`,
    // which would set the meta-dirty flag `restoreHistory` just restored.
    this._doc.setNameSilently(state.shell.name);
    this.resumeAutosave();
    this._snapshot = null;
  }

  // ─── Save / lifecycle ────────────────────────────────────────────────

  /** Mark the current state as saved: re-base, flush trash, drop the draft.
   *
   *  "Saved" means the frame has nothing outstanding, so the slot is CLEARED —
   *  a clean draft record left behind is exactly what `planStackRecovery` would
   *  later offer back as unsaved work. (Until plan-710 the unbound case wrote a
   *  clean legacy record instead, so a reload would re-open the saved library
   *  asset; that job belongs to `saveLastEditedAsset`/`setOpenDocumentBase`,
   *  which the editor already writes on every successful open.)
   *
   *  The returned promise resolves once the clear has landed; callers that may
   *  race a page reload (the save flow) await it. */
  markSaved(base: AssetBase, name?: string, _opts?: { clearDraft?: boolean }): Promise<void> {
    this._base = base;
    this.executor.flushTrash();
    // Re-base the op log. This notifies, which schedules an autosave — so the
    // cancel below MUST come after it, or the debounced write would overwrite
    // the cleared draft with the stale pre-save log.
    this._doc.markSaved(name ? { name } : undefined);
    this._autosave.cancel();
    const draftDone = clearDocumentDraft(this._draftFrame);
    this._snapshot = null;
    for (const fn of this._listeners) fn();
    return draftDone;
  }

  /** Wait for all queued ops to finish (save pipeline calls this first). */
  whenIdle(): Promise<void> {
    return this._doc.whenIdle();
  }

  /** Did this facade borrow its document from another projection? (plan-711 §2.2) */
  get isBound(): boolean { return this._bound; }

  /**
   * The op count at the moment of the bind — the floor a discard rolls back to.
   *
   * Zero for an unbound document, where "everything since the bind" and
   * "everything" are the same set.
   */
  get bindFloor(): number { return this._bindFloor; }

  /**
   * Discard what was authored SINCE the bind, for real (plan-711 R1-S1).
   *
   * The unbound editor discards by clearing its draft and letting the document
   * die; a BOUND one cannot, because the document outlives the editor session —
   * so "discard" has to mean discard. {@link RvDocument.rollbackTo} applies the
   * inverses and cuts the log, on the queue, and the scene never sees the ops.
   *
   * Deliberately NOT `markSaved({floor})`: that rebases the clean point onto
   * the ops that are there, which at a shared document hands the user's
   * discarded work to the other projection as a clean, saved state
   * (rv-asset-document.ts `markSaved` → `RvDocument.markSaved`).
   */
  async discardBoundEdits(): Promise<number> {
    if (!this._bound) return 0;
    const undone = await this._doc.rollbackTo(this._bindFloor);
    this._snapshot = null;
    for (const fn of this._listeners) fn();
    return undone;
  }

  dispose(): void {
    this._disposed = true;
    this._autosave.dispose();
    this._unsubDoc();
    this._detachCommitHook?.();
    this._detachCommitHook = null;
    if (this._bound) {
      // NOT disposed: the document belongs to the projection that lent it, and
      // that projection is still showing it. What goes is this facade's half of
      // the binding — the commit hook above, and the asset executor context,
      // which is tree-bound state of a tree that is about to be replaced. It is
      // released THROUGH the unified executor so the shared document does not
      // keep pointing at a disposed context; the next asset op builds a fresh
      // one against the tree that is live by then.
      const unified = this._doc.executor;
      if (unified instanceof RvUnifiedExecutor) unified.releaseAssetContext();
      else this.executor.dispose();
    } else {
      // Disposes the unified executor, which disposes the asset context we gave it.
      this._doc.dispose();
    }
    this._listeners.clear();
  }

  // ─── React store ─────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): AssetDocumentSnapshot => {
    if (!this._snapshot) {
      const s = this._doc.getSnapshot();
      // The three intrinsics, derived once in the document layer. Spread from
      // `core` and not from `s`, so this object carries exactly the fields this
      // interface declares — `RvDocumentSnapshot` also has `mode`, which is not
      // part of the asset facade's contract.
      this._snapshot = {
        ...this._doc.core,
        id: s.id,
        name: s.name,
        base: this._base,
        undoLabel: s.undoLabel,
        redoLabel: s.redoLabel,
        opCount: s.opCount,
      };
    }
    return this._snapshot;
  };
}

// ─── helpers ────────────────────────────────────────────────────────────

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

/** Unique name against an explicit claim set (Name, Name_1, Name_2 …) — the bulk
 *  counterpart of {@link uniqueChildName}, which reads the live children. A batch
 *  must dedupe against names its own earlier members already claimed, before any
 *  of them has moved. */
/**
 * Everything a `mergeMesh` op needs, resolved once against the live tree.
 *
 * Also what the preview dialog reports and what the worker path bakes with — the action
 * layer must never build a second, differently-derived partition.
 */
export interface MergeMeshPlan {
  rootPath: string;
  classification: MergeClassification;
  /** The live source meshes, indexed like {@link sourcePaths}. */
  sources: Mesh[];
  sourcePaths: string[];
  sourceSignatures: MergeSourceSignature[];
  outputs: MergeOutputSpec[];
  kept: MergeKeptNodeSpec[];
  /** Owner world matrix per output, in output order — the bake target space. */
  ownerWorlds: Matrix4[];
  /** Non-null when no op may be created. */
  ineligibleReason: string | null;
}

/**
 * Resolve the merge partition for a subtree, without touching the scene.
 *
 * Exported so the preview dialog and the worker path use the SAME plan the op is built
 * from — a second, independently derived partition would be a second truth.
 */
export function planMergeMesh(viewer: RVViewer, rootPath: string): MergeMeshPlan | null {
  const root = viewer.registry?.getNode(rootPath) ?? null;
  if (!root) return null;
  // Editor loads freeze static matrices, so only the world matrices are authoritative.
  viewer.currentModelRoot?.updateMatrixWorld(true);

  const pathOf = (node: Object3D): string => NodeRegistry.computeNodePath(node);
  const classification = classifySubtree(root, pathOf);
  const empty: MergeMeshPlan = {
    rootPath, classification, sources: [], sourcePaths: [], sourceSignatures: [],
    outputs: [], kept: [], ownerWorlds: [], ineligibleReason: classification.ineligibleReason,
  };
  if (classification.ineligibleReason) return empty;

  const sources = classification.candidates.map((c) => c.mesh);
  const indexOfMesh = new Map<Mesh, number>(sources.map((mesh, i) => [mesh, i]));
  const sourcePaths = sources.map(pathOf);
  const sourceSignatures: MergeSourceSignature[] = classification.candidates.map((c) => ({
    materialKey: c.materialKey,
    vertexCount: c.vertexCount,
    triangleCount: c.triangleCount,
  }));
  const kept: MergeKeptNodeSpec[] = classification.kept.map((k) => ({
    path: pathOf(k.node),
    role: k.role,
    ownerPath: pathOf(k.owner),
  }));

  // Output names are claimed against the names that will exist under the same owner —
  // once, here, exactly as `separateMesh` claims its child names.
  const takenByOwner = new Map<string, Set<string>>();
  const takenUnder = (ownerPath: string): Set<string> => {
    let taken = takenByOwner.get(ownerPath);
    if (!taken) { taken = new Set<string>(); takenByOwner.set(ownerPath, taken); }
    return taken;
  };
  for (const spec of kept) takenUnder(spec.ownerPath).add(leafName(spec.path));

  const outputs: MergeOutputSpec[] = [];
  const ownerWorlds: Matrix4[] = [];
  for (const zone of classification.zones) {
    const ownerPath = pathOf(zone.owner);
    const taken = takenUnder(ownerPath);
    const ownerWorld = zone.owner.matrixWorld.clone();
    const indicesOf = (bucketIndex: number): number[] =>
      zone.buckets[bucketIndex].candidates.map((c) => indexOfMesh.get(c.mesh)!);

    if (zone.isRoot) {
      // The FIRST root-zone bucket becomes the replacement mesh — same name as the root,
      // so the subtree keeps its identity and its path. A root zone without geometry
      // still gets it, as an empty carrier.
      outputs.push({
        sourceIndices: zone.buckets.length > 0 ? indicesOf(0) : [],
        role: 'root',
        ownerPath,
        name: root.name,
        groupNames: zone.buckets[0]?.groupNames ?? [],
      });
      ownerWorlds.push(ownerWorld);
      for (let i = 1; i < zone.buckets.length; i++) {
        const name = uniqueName(taken, `${root.name || 'Merged'}_merged`);
        taken.add(name);
        outputs.push({
          sourceIndices: indicesOf(i), role: 'child', ownerPath, name,
          groupNames: zone.buckets[i].groupNames,
        });
        ownerWorlds.push(ownerWorld);
      }
      continue;
    }

    for (let i = 0; i < zone.buckets.length; i++) {
      const name = uniqueName(taken, `${zone.owner.name || 'Merged'}_merged`);
      taken.add(name);
      outputs.push({
        sourceIndices: indicesOf(i), role: 'child', ownerPath, name,
        groupNames: zone.buckets[i].groupNames,
      });
      ownerWorlds.push(ownerWorld);
    }
  }

  return {
    rootPath, classification, sources, sourcePaths, sourceSignatures, outputs, kept,
    ownerWorlds, ineligibleReason: null,
  };
}

function uniqueName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) {
    const name = `${base}_${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Unique child name under a parent (Name, Name_1, Name_2 …). */
function uniqueChildName(parent: Object3D | null, base: string): string {
  const sane = base.replace(/[^\w\- ]+/g, '_').trim() || 'CAD';
  if (!parent) return sane;
  const taken = new Set(parent.children.map((c) => c.name));
  if (!taken.has(sane)) return sane;
  for (let n = 1; ; n++) {
    const name = `${sane}_${n}`;
    if (!taken.has(name)) return name;
  }
}

// A child's registry path MUST equal what NodeRegistry.computeNodePath() will
// re-derive for it — every later getNode()/op lookup goes through computeNodePath.
// That invariant is `computeNodePath(child) === computeNodePath(parent) + '/' + name`
// for ALL parents, including an UNNAMED asset root (name === ''), where
// computeNodePath(root) === '' and computeNodePath(child) === '/child' (a leading
// empty segment). So we always join with '/'; the old `parentPath ? … : childName`
// shortcut dropped that leading slash and registered editor-created nodes at `Empty`
// while computeNodePath re-derived `/Empty`, so add-component / add-child / reparent
// on those nodes silently no-op'd (the lookup missed).
function childPath(parent: Object3D, childName: string): string {
  return joinPaths(NodeRegistry.computeNodePath(parent), childName);
}

function joinPaths(parentPath: string, childName: string): string {
  return `${parentPath}/${childName}`;
}

function replacePathLeaf(path: string, newLeaf: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? newLeaf : path.slice(0, idx + 1) + newLeaf;
}

function leafName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? path : path.slice(idx + 1);
}

function IDENTITY_TRANSFORM(): NodeTransform {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function snapshotLocalTransform(node: Object3D): NodeTransform {
  return {
    position: node.position.toArray() as [number, number, number],
    quaternion: node.quaternion.toArray() as [number, number, number, number],
    scale: node.scale.toArray() as [number, number, number],
  };
}

function decomposeToTransform(m: Matrix4): NodeTransform {
  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  m.decompose(p, q, s);
  return {
    position: p.toArray() as [number, number, number],
    quaternion: q.toArray() as [number, number, number, number],
    scale: s.toArray() as [number, number, number],
  };
}
