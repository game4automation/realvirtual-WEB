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

import { Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { NodeIdMap } from '../engine/rv-subtree-instantiate';
import { isModelRoot, isModelRootPath } from '../engine/rv-model-root';
import {
  AssetExecutorContext,
  ReferenceRebindError,
  geometryFromGlb,
  singleMeshOf,
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
import {
  RvDocument,
  type RvDocumentCore,
  type RvDocumentReplayOptions,
  type RvHistoryInterceptor,
  type RvTransactionOptions,
} from '../ops/rv-document';
import { RvUnifiedExecutor } from '../ops/rv-unified-executors';
import { needsRecomposeToUndo, undoViaRecompose, type RvReloadOutcome } from '../ops/rv-document-projection';
import { journalIdOf, makeAssetComposite } from '../ops/rv-unified-ops';
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
import { hasCadGlb, putCadGlb, sha256Hex, type CadConverter } from '../import/rv-cad-glb-cache';
import { objectToGlb } from '../import/rv-import-object';
import { AssetSimplifyController } from './rv-asset-simplify';
import type { AssetSimplifyClient, SimplifyNodesHooks, SimplifyNodesOptions, SimplifyNodesResult, SimplifyPreview } from './rv-asset-simplify';
export type { SimplifyNodesHooks, SimplifyNodesOptions, SimplifyNodesResult, SimplifyPreview } from './rv-asset-simplify';
import { weldImportedGlb } from '../import/rv-glb-weld';
import { generatedFamilyOf } from '../engine/rv-parametric-component';
import { reportProblem } from '../hmi/problems-store';
import { parseGlbSubtree, RV_ORIG_NAME_KEY } from '../engine/rv-glb-parse';
import { RV_SYNTHETIC_KEY } from '../engine/rv-bake-chunk';
import { NodeRegistry } from '../engine/rv-node-registry';
import { siblingNames, uniqueName } from '../engine/rv-node-naming';
import { planMaterialAssignment, materialPrevOfPlan, type MaterialSkipReason } from './rv-asset-material';
import { guardReferenceOp } from '../ops/rv-reference-guard';
import { isInsideReference, outermostReference } from '../engine/rv-reference-scope';
import { planReferenceRewrite, writtenTailMatches, type ReferenceRewriteWarning } from '../engine/rv-node-path-rewrite.mjs';
import { signalNameFollowsNodeName } from '../engine/rv-signal-construction';
import { sanitizeLikeThree } from '../engine/rv-three-names';
import { authoredAssetRelativePath, bareStringReferenceRefusal } from '../hmi/rv-reference-field';
import { binaryResources } from '../engine/rv-binary-resources';
import { fmuDocumentResourceId, fmuShasOfOps, restoreFmuPackagesForOps } from '../ops/rv-fmu-ops';
import { deleteDraftFmuPackage } from './rv-asset-draft-storage';
import {
  DocumentLockedError,
  documentLockedMessage,
  type DocumentLockKind,
  type DocumentLockToken,
  type DocumentLockOwner,
} from './rv-document-lock';

/** What {@link AssetDocument.setMaterial} queued: meshes painted and the requested paths it could not reach. */
export interface MaterialAssignResult {
  /** Meshes the op paints (0 = nothing changed, no op queued). */
  painted: number;
  /** Registry paths of the painted meshes. */
  meshPaths: string[];
  /** Requested paths that contributed no mesh, with the reason. */
  skipped: Array<{ path: string; reason: MaterialSkipReason }>;
}

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

// ─── Reference-safe rename / move (plan-610) ─────────────────────────────

/** Why a rename (or the auto-rename of a move) was refused. */
export type RenameRefusalReason =
  | 'model-root'
  | 'empty-name'
  | 'invalid-name'
  | 'not-found'
  | 'reference-guard'
  | 'signal-node'
  | 'document-busy';

/**
 * A rename — direct, or the collision auto-rename of a move — was REFUSED
 * before anything was mutated (plan-610 §2.4). The document is unchanged.
 */
export class RenameRefusedError extends Error {
  readonly reason: RenameRefusalReason;
  readonly nodePath: string;
  constructor(reason: RenameRefusalReason, nodePath: string, message: string) {
    super(message);
    this.name = 'RenameRefusedError';
    this.reason = reason;
    this.nodePath = nodePath;
  }
}

/** One notice of a rename/move: a reference left alone, a node auto-renamed. */
export interface ReferenceRewriteNotice {
  /** `auto-renamed`, `name-not-unique-in-file` (plan-610 Phase 5b), or a {@link ReferenceRewriteWarning} code of the rewrite core. */
  code: string;
  message: string;
  /** Node the notice is about (post-change path). */
  nodePath?: string;
}

/** What a reference-safe structural change rewrote (plan-610 F8). */
export interface ReferenceRewriteSummary {
  /** Stored paths rewritten (ComponentReference + declared path fields). */
  referencesRewritten: number;
  /** Declared name fields (e.g. `Source.ThisObjectAsMU`) rewritten. */
  nameFieldsRewritten: number;
  /** Auto-renames, references left unchanged, ambiguous name fields. */
  warnings: ReferenceRewriteNotice[];
}

/** Result of {@link AssetDocument.renameNodeAwaited}. */
export interface RenameNodeResult extends ReferenceRewriteSummary {
  /** The node's path after the rename. */
  path: string;
}

/** Result of {@link AssetDocument.reparentNodesDetailed} / {@link AssetDocument.reparentNodesBatchDetailed}. */
export interface ReparentNodesResult extends ReferenceRewriteSummary {
  /** Post-move (post-rename) paths of the nodes that actually moved. */
  moved: string[];
}

function emptyRewrite(): ReferenceRewriteSummary {
  return { referencesRewritten: 0, nameFieldsRewritten: 0, warnings: [] };
}

type RenameNodePrimitive = Extract<RvAssetPrimitiveOp, { kind: 'renameNode' }>;

/**
 * THE constructor of every `renameNode` op (plan-765 F2) — the direct rename
 * and both move auto-renames go through it, so none of them can forget the
 * authored-name stamp.
 *
 * A node the loader de-duplicated carries its authored name in
 * `userData._rvOrigName`, and the export writes that name back. A rename is
 * the user choosing a new name, so the forward op deletes the stamp and the
 * op records it as `prevOrigName` for undo. The key is set ONLY when there is
 * a stamp: op shapes are compared with `toEqual`, and a stored `undefined`
 * would also make the inverse write one.
 *
 * `prevName` defaults to the live name; a move plan that simulated an earlier
 * rename of the same node passes the simulated one, and then reads no stamp —
 * that earlier op already took it.
 */
function makeRenameOp(node: Object3D, nodePath: string, name: string, prevName: string = node.name): RenameNodePrimitive {
  const op: RenameNodePrimitive = { ...assetOpHeader(), kind: 'renameNode', nodePath, name, prevName };
  const orig = node.userData?.[RV_ORIG_NAME_KEY];
  if (prevName === node.name && typeof orig === 'string' && orig.length > 0) op.prevOrigName = orig;
  return op;
}

/** `node`'s registry path spelled in AUTHORED names (`_rvOrigName ?? name` per segment) — the
 *  segments of {@link NodeRegistry.computeNodePath} (everything below the parentless scene),
 *  spelled by the ONE reference writer {@link authoredAssetRelativePath} (plan-765 F3). */
function authoredNodePath(node: Object3D): string {
  let top: Object3D = node;
  while (top.parent) top = top.parent;
  return authoredAssetRelativePath(node, top) ?? '';
}

/**
 * plan-610 Phase 5b: the notice for a node named like another node of the
 * document. GLTFLoader de-duplicates node names FILE-WIDE (sanitized,
 * `createUniqueName`), so after save and reload one of the two loads as `<name>_N`
 * and every path written through it misses — the reason the Phase-5 welding
 * groups `FG03` / `Simulation` loaded as `FG03_1` / `Simulation_1`. A warning,
 * never a refusal: the edit itself is valid. Compared are the sanitized node
 * names (and the raw glTF names a dedup left in `_rvOrigName`) of the document
 * tree, the model root included (it becomes the scene name, which claims first);
 * content behind a reference and synthetic bake nodes are not part of the file.
 */
function nameNotUniqueNotice(
  root: Object3D | null, self: Object3D, name: string, nodePath: string,
): ReferenceRewriteNotice | null {
  if (!root) return null;
  const key = sanitizeLikeThree(name);
  let other: Object3D | null = null;
  const visit = (n: Object3D): void => {
    if (other) return;
    if (n !== self && n.userData?.[RV_SYNTHETIC_KEY] !== true) {
      const orig = n.userData?.[RV_ORIG_NAME_KEY];
      if (sanitizeLikeThree(n.name) === key || (typeof orig === 'string' && sanitizeLikeThree(orig) === key)) {
        other = n;
        return;
      }
    }
    if (n !== root && isInsideReference(n, root)) return;
    for (const c of n.children) visit(c);
  };
  visit(root);
  if (!other) return null;
  const otherPath = NodeRegistry.computeNodePath(other);
  return {
    code: 'name-not-unique-in-file',
    message: `"${name}" is also the name of "${otherPath}" — node names are de-duplicated file-wide on load, `
      + `so after saving one of the two loads as "${key}_N" and paths through it no longer match. Prefer a name unique in the document.`,
    nodePath,
  };
}

// ─── Document lock (plan-462 B3) ──────────────────────────────────────────

// The vocabulary lives in the leaf module `rv-document-lock` so the scene
// lineage (`SceneStore`) can refuse with the very same error class; every name
// is re-exported here, so existing imports keep working and `instanceof
// DocumentLockedError` holds across both lineages.
export {
  ERR_DOCUMENT_LOCKED,
  DocumentLockedError,
  documentLockedMessage,
  type DocumentLockKind,
  type DocumentLockToken,
  type DocumentLockOwner,
} from './rv-document-lock';

/**
 * The asset EDITOR's session on a document — not a document kind (plan-777 #6).
 *
 * There is one kind of document (plan-716): one GLB, one `project.json` row.
 * This class is what the editor holds while one is open in it — the authored
 * tree, the op log, the identity (`AssetBase`) and the save state. Its twin is
 * `SceneStore`, the PLANNER's session on a document. The class name is
 * historical and kept on purpose (~200 files import it); read "Asset" here as
 * "the editor's", never as a second kind of file.
 */
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
  private _reprojectTree: (() => Promise<void | RvReloadOutcome>) | null = null;
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
  private readonly _simplifier: AssetSimplifyController;

  /**
   * Who holds the document, and with which token — see {@link tryLock}.
   *
   * Null whenever the document is free. The generation is stamped at
   * acquisition and never reused, which is what makes a stale timeout harmless:
   * it can only carry the token of the run it was armed for.
   */
  private _lock: {
    kind: DocumentLockKind;
    token: symbol;
    generation: number;
    startedAt: number;
    /**
     * A debounced draft write was armed when this lock was taken, and
     * {@link tryLock} cancelled it. {@link unlock} owes it back — see there.
     */
    cancelledPendingWrite: boolean;
  } | null = null;

  /** Monotonic, never reset — the invalidation half of the token. */
  private _lockGeneration = 0;

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
      /** Injectable transport for synthetic integration tests (plan-663). */
      simplifyClient?: AssetSimplifyClient;
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
    this._simplifier = new AssetSimplifyController(this, viewer, () => {
      this._assertUnlocked('Simplifying meshes');
      if (this._disposed) throw new Error('The document is disposed');
    }, opts.simplifyClient);
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
      // plan-616 §2.3 — only a BOUND facade claims its records for the session:
      // its work also lives in the borrowed (scene) document, so the editor's
      // next entry may leave the record out of recovery and bind again. A facade
      // built from bytes or from a draft holds its work nowhere else.
      boundDoc: () => (this._bound ? this._doc : null),
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
  /** Monotonic across edits, coalescing, undo and redo; unlike op-log length. */
  get revision(): number { return this._doc.changeSeq; }

  /** Compute without mutating the scene. The preview lists unselected shared users. */
  async previewSimplify(paths: string[], opts: SimplifyNodesOptions = {}): Promise<SimplifyPreview> {
    this._assertUnlocked('Simplifying meshes');
    return this._simplifier.preview(paths, opts);
  }

  /** Revalidate a supplied preview, then apply all geometry swaps as one undo step. */
  async simplifyNodes(paths: string[], opts: SimplifyNodesOptions = {}, hooks?: SimplifyNodesHooks): Promise<SimplifyNodesResult> {
    this._assertUnlocked('Simplifying meshes');
    return this._simplifier.apply(paths, opts, hooks);
  }

  /** Terminate pending worker work; no partial simplification is committed. */
  cancelSimplify(): void { this._simplifier.cancel(); }

  // `static newUntitled(viewer)` lived here until plan-719 F3. It minted a
  // document over `{ kind: 'empty' }` — an asset with no file, no row and no
  // place — and everything downstream then had to carry a branch for the one
  // identity that could not answer "where do my bytes go". Creation now goes
  // through `createDocument()`, which writes the bytes and the manifest row
  // before the document is opened, so every AssetDocument has a home from its
  // first moment. A caller that needs a document needs a base; there is no
  // factory that can invent one for it.

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

  /** Follow a completed file rename without discarding unsaved ops. */
  adoptDocumentRename(base: Extract<AssetBase, { kind: 'document' }>, name: string): void {
    this._assertUnlocked('Adopting a document rename');
    if (this._base.kind !== 'document' || this._base.documentId !== base.documentId) {
      throw new Error('A rename must keep the document identity.');
    }
    this._base = base;
    this._doc.setNameSilently(name);
    this._snapshot = null;
    for (const fn of this._listeners) fn();
  }

  /** Rename the DOCUMENT (not a scene node). Metadata only — not an op, but
   *  marks the document dirty so the exit guard prompts to save. */
  renameDocument(name: string): void {
    this._assertUnlocked('Renaming the document');
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
    try {
      this._assertUnlocked('Applying an edit');
    } catch (e) {
      return Promise.reject(e);
    }
    // plan-769 D22: a reference field takes the object form — a bare string is
    // refused HERE, before anything is applied or recorded (the MCP tool then
    // answers with this message). Only NEW ops: replay, undo and redo never pass.
    if (op.kind === 'setField') {
      const refusal = bareStringReferenceRefusal(op.componentType, op.fieldName, op.value);
      if (refusal) return Promise.reject(new Error(refusal));
    }
    const unified: RvOp = op;
    const verdict = guardReferenceOp(unified, (nodePath) => {
      const node = this.viewer.registry?.getNode(nodePath);
      if (!node) return null;
      return { reference: outermostReference(node, this.viewer.currentModelRoot ?? null) };
    });
    if (op.kind === 'addComponent') {
      // plan-650 F10: simulation components under a family's `_Generated` come from its rule
      // part alone — a hand-attached one would vanish at the next regeneration.
      const node = this.viewer.registry?.getNode(op.nodePath);
      const family = node ? generatedFamilyOf(node) : null;
      if (family) {
        const message = `"${op.componentType}" cannot be attached by hand under the generated variant of `
          + `"${family.name}" — the rule part creates its components (attach it to the family node instead)`;
        reportProblem({
          id: `parametric-manual-attach:${op.nodePath}:${op.componentType}`,
          severity: 'warning', code: 'parametric-manual-attach',
          title: 'Component refused under a generated variant', detail: message, nodePath: op.nodePath,
        });
        return Promise.reject(new Error(message));
      }
    }
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
  async withTransaction(label: string, fn: () => Promise<void>, opts?: RvTransactionOptions): Promise<void> {
    this._assertUnlocked(`"${label}"`);
    await this._doc.withTransaction(label, fn, opts);
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
    this._assertUnlocked('Undo');
    const newest = this._doc.ops[this._doc.opCount - 1];
    // A journaled entry (plan-590 signal rename) is never taken back by
    // re-projection: its undo belongs to the history interceptor, which the
    // document asks inside `undo()` below.
    if (this._bound && newest && this._reprojectTree && !journalIdOf(newest)
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
  setReprojectTree(fn: (() => Promise<void | RvReloadOutcome>) | null): void {
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
    this._assertUnlocked('Redo');
    await this._doc.redo();
  }

  /**
   * Route undo/redo of journaled entries (`meta.journalId`, plan-590 signal
   * rename) to `interceptor` — the signal-rename coordinator. `undo`/`redo`
   * above reach it through {@link RvDocument.undo} / {@link RvDocument.redo},
   * before anything is applied. `null` removes it.
   */
  setHistoryInterceptor(interceptor: RvHistoryInterceptor | null): void {
    this._doc.setHistoryInterceptor(interceptor);
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
  beginBaseSwap(): void {
    this._assertUnlocked('Swapping the document base');
    this._baseSwapping = true;
  }

  /** End the window opened by {@link beginBaseSwap}. */
  endBaseSwap(): void { this._baseSwapping = false; }

  /** True while a base swap is in flight and ops are being refused. */
  get isBaseSwapping(): boolean { return this._baseSwapping; }

  // ─── Convenience op creators (EditTarget adapter + tools) ───────────

  /**
   * Attach freshly imported CAD geometry as an undoable op. Returns the root path.
   * `opts.name` overrides the root node name (re-import keeps the old name).
   *
   * The GLB bytes are cached under `(Sha256, Quality, Converter)` BEFORE the op is recorded,
   * so a later replay of that op always finds them. The tree that enters the
   * scene is parsed FROM those bytes — never from the importer's intermediate
   * representation — which is what guarantees import and reload agree on node
   * names, materials and transforms.
   *
   * The bytes are welded first (`rv-glb-weld`): this is the one sink every editor
   * import passes — whatever the format, and whether the conversion ran in the
   * browser or in CONNECT — so cache and scene both get the welded form.
   *
   * `opts.root` lets a caller that already parsed `result.glb` (CADLink
   * re-import, which needs the tree to diff against the old revision) hand it
   * over instead of paying for a second parse. It MUST be the result of
   * `parseGlbSubtree(weldImportedGlb(result.glb))` — passing any other tree
   * silently breaks the import-equals-reload invariant. Its local transform is
   * what gets recorded.
   */
  async importCad(result: CadImportResult, opts?: { name?: string; root?: Object3D; idMap?: NodeIdMap }): Promise<string> {
    this._assertUnlocked('Importing CAD');
    const { Sha256, Quality, Converter } = result.cadlink;
    const glb = weldImportedGlb(result.glb, result.cadlink.File);
    // plan-561: the converter is part of the key — a CONNECT import never overwrites the
    // browser entry an older draft of the same file replays from.
    const tier = await putCadGlb(Sha256, Quality, glb, Converter);
    if (tier === 'none') {
      console.warn(
        `[asset-editor] "${result.cadlink.File}" could not be cached — it will NOT survive a reload. ` +
        'Open or create a project (Projects) to keep CAD imports.',
      );
    }

    const root = opts?.root ?? await parseGlbSubtree(glb);
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
      // plan-769 Phase 2: a CADLink re-import hands the ids of the matched old
      // nodes in (the executor mints the rest and completes the map).
      ...(opts?.idMap ? { idMap: { ...opts.idMap } } : {}),
    });
    return rootPath;
  }

  /**
   * Swap the geometry of ONE mesh node for the single mesh in `glbBytes`
   * (plan-621) — an undoable op that leaves the node, its material, children and
   * rv_extras components in place. Generic: nothing here knows who produced the
   * bytes (`converter` only names the cache namespace).
   *
   * Same pattern as {@link importCad}: the bytes are cached under
   * `(sha256, quality, converter)` BEFORE the op is queued, the op carries only
   * the hashes, and the tree gets the geometry parsed FROM those bytes. The
   * vertices of the GLB's one mesh are taken in that mesh's local frame; node
   * transforms inside the GLB are ignored.
   *
   * `prevSha256` — mandatory on the op, so undo works after a save flushed the
   * old geometry object — is resolved in this order:
   *  1. the cache key the executor knows for the node's CURRENT geometry: the
   *     geometry a previous swap installed, or the single mesh of an `importCad`
   *     (a live-synced body's first geometry IS its import, addressed by the
   *     import's own `CADLink.Sha256`/`Quality`/`Converter`) — trusted only when
   *     it is in the same `quality`/`converter` namespace and still cached;
   *  2. otherwise the current geometry is SNAPSHOT: written to a one-mesh GLB,
   *     hashed and cached under the same namespace (a node of the loaded base,
   *     any geometry after a reload or a save + reopen).
   *
   * Rejects BEFORE anything is queued when the node does not resolve to exactly
   * one mesh, the GLB does not hold exactly one mesh, or either GLB cannot be
   * cached (`'none'` tier): an op whose geometry cannot be re-materialised could
   * be neither redone after a save nor replayed. Resolves `null` without an op
   * when the new geometry IS the current one (same hash).
   *
   * Coalescing is the caller's choice: a sync step wraps its ops in
   * `withTransaction(label, fn, { coalesce })`; repeated swaps of the same node
   * outside a transaction coalesce like any primitive setter (500 ms window).
   */
  async replaceNodeGeometry(
    nodePath: string,
    glbBytes: ArrayBuffer,
    converter: CadConverter,
    opts?: { quality?: string; sha256?: string; sharedNodePaths?: string[]; validate?: () => void },
  ): Promise<{ sha256: string; prevSha256: string } | null> {
    this._assertUnlocked('Replacing a geometry');
    const node = this.viewer.registry?.getNode(nodePath) ?? null;
    const mesh = node ? singleMeshOf(node) : null;
    if (!mesh) {
      throw new Error(`replaceNodeGeometry: "${nodePath}" ${node ? 'does not hold exactly one mesh' : 'not found'}`);
    }
    const sourceGeometry = mesh.geometry;
    const sharedNodePaths = [...new Set(opts?.sharedNodePaths ?? [])].filter(p => p !== nodePath).sort();
    const validate = () => {
      opts?.validate?.();
      if (mesh.geometry !== sourceGeometry) throw new Error('replaceNodeGeometry: source geometry changed before Apply');
      for (const path of sharedNodePaths) {
        const other = this.viewer.registry?.getNode(path);
        if (!other || singleMeshOf(other)?.geometry !== sourceGeometry) {
          throw new Error(`replaceNodeGeometry: "${path}" no longer shares the source geometry`);
        }
      }
    };
    validate();
    const quality = opts?.quality ?? 'source';
    const sha256 = opts?.sha256 ?? await sha256Hex(glbBytes);
    const prevSha256 = await this._geometryCacheKey(mesh.geometry as BufferGeometry, quality, converter);
    if (prevSha256 === sha256) return null;
    // Validate the bytes before they reach the cache or the queue.
    const geometry = await geometryFromGlb(glbBytes);
    if (await putCadGlb(sha256, quality, glbBytes, converter) === 'none') {
      geometry.dispose();
      throw new Error(`replaceNodeGeometry: the geometry of "${nodePath}" could not be cached — it could not be undone or replayed`);
    }
    const header = assetOpHeader();
    const op: RvAssetPrimitiveOp = { ...header, kind: 'replaceNodeGeometry', nodePath, sha256, quality, converter, prevSha256,
      ...(sharedNodePaths.length ? { sharedNodePaths } : {}) };
    this.executor.provideGeometryPayload(header.id, geometry);
    try {
      validate();
      await this.applyOp(op);
    } finally {
      // Consumed by a forward that ran; still here when the op was refused or dropped.
      this.executor.discardGeometryPayload(header.id);
    }
    return { sha256, prevSha256 };
  }

  /** The cache key of `geometry` in `(quality, converter)` — snapshotting it when it has none. */
  private async _geometryCacheKey(geometry: BufferGeometry, quality: string, converter: CadConverter): Promise<string> {
    const known = this.executor.geometryKeyOf(geometry);
    if (known && known.quality === quality && (known.converter ?? 'browser') === converter
        && await hasCadGlb(known.sha256, quality, converter)) {
      return known.sha256;
    }
    // Geometry only: a throwaway mesh, and the geometry's userData kept out of
    // the bytes (glTF primitive extras) so the hash depends on the vertices alone.
    const userData = geometry.userData;
    geometry.userData = {};
    let bytes: ArrayBuffer;
    try {
      bytes = await objectToGlb(new Mesh(geometry));
    } finally {
      geometry.userData = userData;
    }
    const sha = await sha256Hex(bytes);
    if (await putCadGlb(sha, quality, bytes, converter) === 'none') {
      throw new Error('replaceNodeGeometry: the current geometry could not be cached — the swap could not be undone');
    }
    this.executor.noteGeometryKey(geometry, { sha256: sha, quality, converter });
    return sha;
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

  /**
   * Fire-and-forget field edit (the inspector's path) — queued and tracked like
   * every {@link _voidApply} op. The returned promise only tells WHEN the op
   * settled (plan-774: the extras editor drops its optimistic badge entry for
   * placed content then); it is already observed, so ignoring it is safe.
   */
  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): Promise<void> {
    const applied = this._doc.applyOp({ ...assetOpHeader(), kind: 'setField', nodePath, componentType, fieldName, value, prev });
    this._doc.trackDetached(applied);
    return applied;
  }

  /**
   * Awaited variant of {@link setField} for callers that must OBSERVE the
   * outcome (the MCP tools): resolves once the op has actually applied and been
   * recorded, rejects when the executor refused it. The detached path swallows
   * a failure outside a transaction (`applyOpDetached` catches it), so a caller
   * that reports success to an agent must not use it — a tool that answers
   * "ok" for an op that never landed is how edits get lost in silence.
   *
   * NOTE: a resolve is necessary but not sufficient — an op queued during a
   * base swap is dropped inside the queue without an error (see
   * {@link beginBaseSwap}). Callers that need certainty read the field back
   * after the resolve.
   */
  setFieldAwaited(
    nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown,
  ): Promise<void> {
    return this.applyOp({ ...assetOpHeader(), kind: 'setField', nodePath, componentType, fieldName, value, prev });
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

  /**
   * Fire-and-forget form of {@link renameNodeAwaited} for the `void` UI
   * handlers. A refusal (model root, signal node, invalid name, …) is LOGGED and
   * changes nothing — inside a transaction it does not poison it either, the
   * same contract `_rejectRootOp` always had. An executor failure inside a
   * transaction still rolls the transaction back (like every void mutator).
   *
   * A re-bind refusal ({@link ReferenceRebindError}, plan-614 F1) arrives AFTER
   * the composite started mutating; the composite is already rolled back when
   * it gets here. It is reported LOUDLY — `console.warn` plus the viewer event
   * `editor-edit-refused`, which the HMI turns into a toast — and counts as
   * handled: the rename itself is undone, there is nothing left to poison.
   */
  renameNode(nodePath: string, name: string, prevName: string): void {
    // The root refusal stays synchronous: loud, immediate, nothing queued.
    if (this._rejectRootOp(nodePath, 'renameNode')) return;
    this._doc.trackDetached(this._renameNodePlanned(nodePath, name, prevName, false), (e) => {
      if (e instanceof RenameRefusedError) {
        console.warn(`[asset-edits] renameNode refused (${e.reason}): ${e.message}`);
        return true;
      }
      if (e instanceof ReferenceRebindError) {
        console.warn(`[asset-edits] renameNode refused and rolled back (reference re-bind): ${e.message}`, e.failures);
        this.viewer.emit('editor-edit-refused', {
          verb: 'Rename', nodePath, reason: 'ReferenceRebindError', message: e.message,
        });
        return true;
      }
      return false;
    });
  }

  /**
   * Rename a node REFERENCE-SAFELY (plan-610) and report what was rewritten.
   *
   * Every stored path in the document that points at the node or into its
   * subtree — ComponentReferences anywhere in the extras, the declared path
   * fields, the declared name fields when unique — is rewritten in the SAME
   * undo step as the rename, in its own spelling. Planning and apply share one
   * queue slot, so no queued op can change what was scanned.
   *
   * Rejects with {@link RenameRefusedError} — nothing mutated — for the model
   * root, an empty name, a name containing `/`, a missing node, a structural
   * edit inside a referenced asset, and a signal node whose signal name hangs
   * on its node name (use `web_editor_signal_rename`). Rejects with the executor's
   * error (nothing recorded) when the composite could not be applied. Renaming
   * to the current name resolves without an op.
   *
   * Scope: the open document only — other documents that point into this asset
   * by path are not searchable (the load audit reports them).
   */
  renameNodeAwaited(nodePath: string, name: string, prevName?: string): Promise<RenameNodeResult> {
    return this._renameNodePlanned(nodePath, name, prevName, true);
  }

  private async _renameNodePlanned(
    nodePath: string, name: string, _prevName: string | undefined, assertLock: boolean,
  ): Promise<RenameNodeResult> {
    if (assertLock) this._assertUnlocked('Renaming a node');
    const result = await this._doc.applyPlanned(() => this._planRename(nodePath, name));
    if (result === null) {
      throw new RenameRefusedError('document-busy', nodePath, 'The document base is being replaced — rename dropped.');
    }
    return result;
  }

  /** Plan a rename against the CURRENT state (runs inside the queue slot). */
  private _planRename(nodePath: string, name: string): { op: RvAssetOp | null; result: RenameNodeResult } {
    const registry = this.viewer.registry;
    if (this._rejectRootOp(nodePath, 'renameNode')) {
      throw new RenameRefusedError('model-root', nodePath,
        `"${nodePath}" is the model root — its name is the first segment of every node path.`);
    }
    if (!name.trim()) throw new RenameRefusedError('empty-name', nodePath, 'A node name must not be empty.');
    if (name.includes('/')) {
      throw new RenameRefusedError('invalid-name', nodePath,
        `"${name}" contains "/" — that is the path separator and cannot be part of a node name.`);
    }
    const node = registry?.getNode(nodePath) ?? null;
    if (!registry || !node) throw new RenameRefusedError('not-found', nodePath, `Node "${nodePath}" not found.`);
    const oldPath = registry.getPathForNode(node) ?? nodePath;
    if (node.name === name) return { op: null, result: { path: oldPath, ...emptyRewrite() } };
    if (signalNameFollowsNodeName(node)) {
      throw new RenameRefusedError('signal-node', oldPath, signalNodeRefusal(oldPath));
    }
    const renameOp = makeRenameOp(node, oldPath, name);
    this._guardStructural([renameOp]);
    const newPath = replacePathLeaf(oldPath, name);
    // plan-765 F2b: references are stored in AUTHORED names (the Unity export,
    // and the editor's writers), so the map is given in both spellings. The
    // authored new path carries the new name at the renamed segment — the
    // rename deletes that stamp — and authored names everywhere above it.
    // Descendants map by prefix in both maps, as in every move.
    const authoredOld = authoredNodePath(node);
    const rewrite = planDocumentReferenceRewrite(
      this.viewer,
      new Map([[oldPath, newPath]]),
      new Map([[authoredOld, replacePathLeaf(authoredOld, name)]]),
    );
    const op = rewriteComposite(`Rename ${node.name}`, [renameOp], rewrite);
    const dup = nameNotUniqueNotice(this.viewer.currentModelRoot ?? null, node, name, newPath);
    const warnings = dup ? [dup, ...rewrite.summary.warnings] : rewrite.summary.warnings;
    return { op, result: { path: newPath, ...rewrite.summary, warnings } };
  }

  /**
   * Refuse structural ops inside a referenced asset BEFORE planning on (the
   * check `applyOp` runs, applied to ops this document builds itself).
   */
  private _guardStructural(ops: readonly RvAssetPrimitiveOp[], locate?: (p: string) => Object3D | null): void {
    const root = this.viewer.currentModelRoot ?? null;
    for (const op of ops) {
      const verdict = guardReferenceOp(op, (p) => {
        const node = locate?.(p) ?? this.viewer.registry?.getNode(p) ?? null;
        return node ? { reference: outermostReference(node, root) } : null;
      });
      if (!verdict.ok) throw new RenameRefusedError('reference-guard', verdict.nodePath ?? '', verdict.message);
    }
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
   *
   * Returns what the op paints: `painted` is the number of meshes queued for
   * the new material (0 = nothing changed, no op queued), `skipped` every
   * requested path that contributed none, with the reason — unresolved,
   * placed reference content (not paintable from this document), or no mesh.
   * Callers that answer an agent must report a 0 as a failure.
   */
  setMaterial(nodePaths: string[], material: MaterialValue): MaterialAssignResult {
    const registry = this.viewer.registry;
    if (!registry) {
      return { painted: 0, meshPaths: [], skipped: nodePaths.map((path) => ({ path, reason: 'unresolved' as const })) };
    }
    const plan = planMaterialAssignment(registry, nodePaths);
    const prev = materialPrevOfPlan(plan);
    const result: MaterialAssignResult = { painted: prev.length, meshPaths: prev.map((p) => p.meshPath), skipped: plan.skipped };
    if (prev.length === 0) return result;
    this._voidApply({ ...assetOpHeader(), kind: 'setMaterial', nodePaths: plan.nodePaths, material, prev });
    return result;
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

  /**
   * plan-641 Phase 3 — deep-copy the subtree at `sourcePath` as ONE undoable op
   * (`cloneNode`). The copy lands under `opts.parentPath` (omitted = the source's
   * own parent, `null` = the asset root) as `opts.name` (default: the source's
   * name), `_N`-deduped against that parent at creation so replay is
   * deterministic. Returns the copy's path.
   */
  async cloneNode(
    sourcePath: string,
    opts?: { parentPath?: string | null; name?: string | null; index?: number },
  ): Promise<string> {
    this._assertUnlocked('Cloning a node');
    const registry = this.viewer.registry;
    const source = registry?.getNode(sourcePath) ?? null;
    if (!registry || !source) throw new Error(`cloneNode: "${sourcePath}" not found`);
    if (isModelRoot(source, this.viewer.currentModelRoot)) throw new Error('cloneNode: the model root cannot be cloned');
    const parent = opts?.parentPath === undefined
      ? source.parent
      : opts.parentPath
        ? registry.getNode(opts.parentPath) ?? null
        : this.viewer.currentModelRoot;
    if (!parent) throw new Error(`cloneNode: parent "${opts?.parentPath ?? '<source parent>'}" not found`);
    for (let anc: Object3D | null = parent; anc; anc = anc.parent) {
      if (anc === source) throw new Error('cloneNode: the target parent lies inside the copied subtree');
    }
    const name = uniqueChildName(parent, opts?.name?.trim() || source.name);
    const nodePath = childPath(parent, name);
    await this.applyOp({
      ...assetOpHeader(),
      kind: 'cloneNode',
      sourcePath,
      nodePath,
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
   *  within one parent is only rejected when no index is given).
   *
   *  Reference-safe (plan-610): see {@link reparentNodesDetailed}, which this
   *  is with the result reduced to the moved paths. */
  async reparentNodes(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): Promise<string[]> {
    return (await this.reparentNodesDetailed(nodePaths, newParentPath, opts)).moved;
  }

  /**
   * {@link reparentNodes} with what the move rewrote (plan-610 F8).
   *
   * The moves keep their sequential semantics (node i moves after node i-1:
   * its collision name, `prevIndex` and source path see the earlier moves), but
   * every op is now resolved BEFORE the first mutation — on a simulation of the
   * sibling lists and names — and applied as ONE composite together with the
   * `setField` steps that rewrite every stored reference into the moved
   * subtrees. Planning and apply share one queue slot.
   *
   * Rejects with {@link RenameRefusedError} (nothing mutated) when a collision
   * auto-rename would rename a signal node whose signal name hangs on its node
   * name, or when a move touches a referenced asset's structure.
   */
  async reparentNodesDetailed(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): Promise<ReparentNodesResult> {
    this._assertUnlocked('Moving nodes');
    const result = await this._doc.applyPlanned(() => this._planReparentSequential(nodePaths, newParentPath, opts));
    return result ?? { moved: [], ...emptyRewrite() };
  }

  /** Plan {@link reparentNodesDetailed} against the CURRENT state (inside the queue slot). */
  private _planReparentSequential(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): { op: RvAssetOp | null; result: ReparentNodesResult } {
    const none = { op: null, result: { moved: [], ...emptyRewrite() } };
    const targetIndex = opts?.index;
    const registry = this.viewer.registry;
    const newParent = newParentPath
      ? registry?.getNode(newParentPath) ?? null
      : this.viewer.currentModelRoot;
    if (!registry || !newParent) return none;

    // Filter out impossible moves up front so the composite stays clean.
    const movable: Object3D[] = [];
    for (const p of nodePaths) {
      const node = registry.getNode(p);
      if (!node || !node.parent) continue;
      if (isModelRoot(node, this.viewer.currentModelRoot)) continue;
      // Same-parent is "already there" ONLY when no explicit slot is asked for;
      // with an index it is a legitimate reorder within the parent.
      if (node.parent === newParent && targetIndex === undefined) continue;
      let cyclic = false;
      for (let anc: Object3D | null = newParent; anc; anc = anc.parent) {
        if (anc === node) { cyclic = true; break; }
      }
      if (cyclic) continue;
      movable.push(node);
    }
    if (movable.length === 0) return none;

    // The requested slot is expressed against the parent's children with the
    // moved-and-staying nodes excluded, so it composes cleanly as we emit one
    // op per node: node i lands at `baseIndex + i`.
    const baseIndex = targetIndex === undefined ? undefined : Math.max(0, targetIndex);

    // ── simulation of the tree the earlier moves leave behind ──────────
    // Names, parents and sibling lists as they stand when op i runs. World
    // matrices need no simulation: every move is world-preserving and a
    // same-parent reorder keeps the local pose, so no node's world changes.
    const nameOf = new Map<Object3D, string>();
    const parentOf = new Map<Object3D, Object3D>();
    const kids = new Map<Object3D, Object3D[]>();
    const nm = (n: Object3D): string => nameOf.get(n) ?? n.name;
    const par = (n: Object3D): Object3D | null => parentOf.get(n) ?? n.parent;
    const kidsOf = (p: Object3D): Object3D[] => {
      let list = kids.get(p);
      if (!list) { list = [...p.children]; kids.set(p, list); }
      return list;
    };
    const simPath = (n: Object3D): string => {
      // NodeRegistry.computeNodePath over the simulated names/parents.
      const parts: string[] = [];
      let cur: Object3D | null = n;
      while (cur && par(cur)) {
        parts.unshift(nm(cur));
        cur = par(cur);
        if (cur && !par(cur)) break;
      }
      return parts.join('/');
    };
    // Path → node for the guard: post-op paths do not exist in the registry yet.
    const pathIndex = new Map<string, Object3D>();
    const locate = (p: string): Object3D | null => pathIndex.get(p) ?? registry.getNode(p);

    this.viewer.currentModelRoot?.updateMatrixWorld(true);
    newParent.updateMatrixWorld(true); // covers a target outside the model root
    const parentWorldInverse = new Matrix4().copy(newParent.matrixWorld).invert();

    const ops: RvAssetPrimitiveOp[] = [];
    const movedPaths: string[] = [];
    const notices: ReferenceRewriteNotice[] = [];
    const originalPath = new Map<Object3D, string>();
    for (let i = 0; i < movable.length; i++) {
      const node = movable[i];
      const prevParent = par(node);
      if (!prevParent) continue;
      if (!originalPath.has(node)) originalPath.set(node, registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node));
      const sameParent = prevParent === newParent;
      let nodePath = simPath(node);
      pathIndex.set(nodePath, node);
      // Pre-rename when the target parent already has a same-named child
      // (never for a same-parent reorder — the node keeps its own name).
      if (!sameParent && kidsOf(newParent).some((c) => c !== node && nm(c) === nm(node))) {
        if (signalNameFollowsNodeName(node)) {
          throw new RenameRefusedError('signal-node', nodePath, signalNodeRefusal(nodePath, true));
        }
        const taken = new Set(kidsOf(newParent).map(nm));
        const sane = nm(node).replace(/[^\w\- ]+/g, '_').trim() || 'CAD';
        const newName = uniqueName(taken, sane);
        ops.push(makeRenameOp(node, nodePath, newName, nm(node)));
        notices.push({
          code: 'auto-renamed',
          message: `"${nm(node)}" was renamed to "${newName}" — the target already has a child of that name.`,
          nodePath: joinPaths(simPath(newParent), newName),
        });
        const dup = nameNotUniqueNotice(this.viewer.currentModelRoot ?? null, node, newName, joinPaths(simPath(newParent), newName));
        if (dup) notices.push(dup);
        nameOf.set(node, newName);
        nodePath = simPath(node);
        pathIndex.set(nodePath, node);
      }
      // World-preserving local TRS under the new parent, computed NOW so the
      // executor only replays recorded numbers. A same-parent reorder keeps
      // the world (and thus local) transform — snapshot it directly.
      const transform = sameParent
        ? snapshotLocalTransform(node)
        : decomposeToTransform(new Matrix4().copy(parentWorldInverse).multiply(node.matrixWorld));
      const prevList = kidsOf(prevParent);
      const prevIndex = prevList.indexOf(node);
      const parentPath = simPath(newParent);
      pathIndex.set(parentPath, newParent);
      const newIndex = baseIndex !== undefined ? baseIndex + i : undefined;
      ops.push({
        ...assetOpHeader(),
        kind: 'reparentNode',
        nodePath,
        newParentPath: parentPath,
        ...(newIndex !== undefined ? { newIndex } : {}),
        transform,
        prevParentPath: simPath(prevParent),
        prevIndex,
        prevTransform: snapshotLocalTransform(node),
      });
      // three's `add` removes from the old parent and appends; the executor
      // then splices to the requested slot.
      if (prevIndex >= 0) prevList.splice(prevIndex, 1);
      const target = kidsOf(newParent);
      target.push(node);
      if (newIndex !== undefined) {
        target.splice(target.indexOf(node), 1);
        target.splice(Math.min(newIndex, target.length), 0, node);
      }
      parentOf.set(node, newParent);
      const finalPath = joinPaths(parentPath, nm(node));
      pathIndex.set(finalPath, node);
      movedPaths.push(finalPath);
    }
    if (ops.length === 0) return none;
    this._guardStructural(ops, locate);

    // Old canonical → final path of every moved/renamed node (roots suffice;
    // a member moved again inside a moved ancestor carries its own entry).
    const moves = new Map<string, string>();
    for (const [node, from] of originalPath) moves.set(from, simPath(node));
    const rewrite = planDocumentReferenceRewrite(this.viewer, moves);
    const label = opts?.label ?? (movable.length === 1 ? `Move ${leafName(originalPath.get(movable[0]) ?? '')}` : `Move ${movable.length} objects`);
    const op = rewriteComposite(label, ops, rewrite);
    return {
      op,
      result: {
        moved: movedPaths,
        ...rewrite.summary,
        warnings: [...notices, ...rewrite.summary.warnings],
      },
    };
  }

  /**
   * Move MANY nodes under one new parent as a single composite op — the bulk
   * counterpart of {@link reparentNodes}, with the same per-node result (world
   * pose preserved, sibling names deduped, full inverse payload recorded).
   *
   * Why it exists. `reparentNodes` used to emit one top-level op per node and
   * await each in turn, and `AssetExecutorContext._afterApply` runs once per
   * TOP-LEVEL op — so N moves paid N `editor-structure-changed` events, and each
   * of those costs the hierarchy panel a FULL `scene.traverse`. Measured on a
   * 4493-node assembly with 434 moves (plan-359 Phase 2): 217 ms total, of which
   * 158 ms (73%) was the panel re-scanning the whole scene 434 times. Matrix
   * updates (19 ms) and registry path remapping (12 ms) together were under 15%
   * — the plan's "possibly quadratic matrix update" suspicion did not survive
   * measurement.
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
   * Reference-safe (plan-610): the same composite carries the `setField` steps
   * that rewrite every stored reference into the moved subtrees.
   *
   * Returns the post-move (post-rename) paths of the nodes that actually moved.
   */
  async reparentNodesBatch(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): Promise<string[]> {
    return (await this.reparentNodesBatchDetailed(nodePaths, newParentPath, opts)).moved;
  }

  /** {@link reparentNodesBatch} with what the move rewrote (plan-610 F8). */
  async reparentNodesBatchDetailed(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): Promise<ReparentNodesResult> {
    this._assertUnlocked('Moving nodes');
    const result = await this._doc.applyPlanned(() => this._planReparentBatch(nodePaths, newParentPath, opts));
    return result ?? { moved: [], ...emptyRewrite() };
  }

  /** Plan {@link reparentNodesBatchDetailed} against the CURRENT state (inside the queue slot). */
  private _planReparentBatch(
    nodePaths: string[],
    newParentPath: string | null,
    opts?: { index?: number; label?: string },
  ): { op: RvAssetOp | null; result: ReparentNodesResult } {
    const none = { op: null, result: { moved: [], ...emptyRewrite() } };
    const registry = this.viewer.registry;
    const newParent = newParentPath
      ? registry?.getNode(newParentPath) ?? null
      : this.viewer.currentModelRoot;
    if (!registry || !newParent) return none;
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
    if (block.length === 0) return none;

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
    const notices: ReferenceRewriteNotice[] = [];
    const moves = new Map<string, string>();
    // Path → node for the guard: the post-rename paths are not registered yet.
    const pathIndex = new Map<string, Object3D>();
    for (let i = 0; i < block.length; i++) {
      const node = block[i];
      const prevParent = node.parent!;
      const originalPath = registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
      const sameParent = prevParent === newParent;

      let nodePath = originalPath;
      let finalName = node.name;
      if (!sameParent && taken.has(node.name)) {
        if (signalNameFollowsNodeName(node)) {
          throw new RenameRefusedError('signal-node', originalPath, signalNodeRefusal(originalPath, true));
        }
        finalName = uniqueName(taken, node.name);
        ops.push(makeRenameOp(node, nodePath, finalName));
        nodePath = replacePathLeaf(nodePath, finalName);
        pathIndex.set(nodePath, node);
        notices.push({
          code: 'auto-renamed',
          message: `"${node.name}" was renamed to "${finalName}" — the target already has a child of that name.`,
          nodePath: joinPaths(parentPath, finalName),
        });
        const dup = nameNotUniqueNotice(this.viewer.currentModelRoot ?? null, node, finalName, joinPaths(parentPath, finalName));
        if (dup) notices.push(dup);
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
      const finalPath = joinPaths(parentPath, finalName);
      movedPaths.push(finalPath);
      moves.set(originalPath, finalPath);
    }
    this._guardStructural(ops, (p) => pathIndex.get(p) ?? null);

    // ── apply as ONE top-level op ──────────────────────────────────────
    const label = opts?.label ?? (block.length === 1
      ? `Move ${leafName(movedPaths[0])}`
      : `Move ${block.length} objects`);
    const rewrite = planDocumentReferenceRewrite(this.viewer, moves);
    const op = rewriteComposite(label, ops, rewrite);
    return {
      op,
      result: {
        moved: movedPaths,
        ...rewrite.summary,
        warnings: [...notices, ...rewrite.summary.warnings],
      },
    };
  }

  /**
   * Split a mesh into its connected islands (or its material groups), replacing
   * it with a same-named Group that carries the parts.
   *
   * One step, on the main thread: the partition is computed here and handed to
   * the executor under the op's id via the same mechanism `importCad` uses for
   * its parsed tree, so the apply does not repeat the analysis. `preview` lets a
   * caller that already holds a partition pass it in instead. The executor
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
    reportMergeUVGaps(rootPath, plan.classification);
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

  /**
   * Replay a recovered draft's ops onto the freshly loaded base.
   *
   * plan-774 review fix E3: with `opts.gate` (the authoring join's replay gate,
   * placements not ready in time) the ops from the first one on placed content
   * that is still materialising on become the document's PENDING tail — part
   * of the draft, applied on the document's queue once the placements arrived
   * (bounded by `opts.waitBudgetMs`). See `RvDocument.replayOps`.
   */
  async replayOps(ops: readonly RvOp[], opts?: RvDocumentReplayOptions): Promise<void> {
    this._assertUnlocked('Replaying ops');
    // plan-498 F13: an `attach-fmu` in the log carries only its package SHA —
    // put the bytes back (draft side-store) BEFORE the op constructs the RVFmu.
    await restoreFmuPackagesForOps(ops, this.id);
    await this._doc.replayOps(ops, opts);
  }

  /** plan-774 review fix E3: recovered ops still waiting for their placed content. */
  get hasPendingReplay(): boolean {
    return this._doc.pendingReplayOps.length > 0;
  }

  /**
   * The `userData.realvirtual` record of a node, or null (plan-498): what the
   * editor verbs (`rv-fmu-ops.ts`) read to dedupe keys and capture the inverse
   * payload of a `removeComponent`.
   */
  nodeExtras(nodePath: string): Record<string, unknown> | null {
    const node = this.viewer.registry?.getNode(nodePath);
    const rv = node?.userData?.realvirtual;
    return rv && typeof rv === 'object' ? rv as Record<string, unknown> : null;
  }

  toDraft(): AssetDraft {
    return {
      shell: { id: this.id, name: this._doc.name, base: this._base, createdAt: this._doc.createdAt },
      // plan-774 review fix E3: the history PLUS a pending replay tail.
      ops: this._doc.draftOps,
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
    // Guarded even though it looks like a read: it WRITES the draft slot, and
    // during a test run that slot must keep describing the pre-test authoring
    // state. It ignored the suspend flag outright before plan-462 B3.
    this._assertUnlocked('Flushing the draft');
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

  /**
   * True while autosave is suspended — which a held lock implies (plan-462 B3).
   *
   * Suspension is now DERIVED from the lock rather than set beside it. That is
   * the whole reason the lock exists: "the draft must keep describing the
   * pre-test state" and "no one may edit the document" were the same fact, kept
   * in two places, and only one of them was ever checked.
   */
  get isAutosaveSuspended(): boolean {
    return this._autosaveSuspended || this._lock !== null;
  }

  // ─── Document lock (plan-462 B3) ─────────────────────────────────────

  /**
   * Take the document, or fail — never wait.
   *
   * **Fail-fast by design.** A queue here would mean a second test run, or a
   * save racing a test run, silently waiting for a window it cannot reason
   * about; the caller is told no and says so, which is the only outcome a user
   * can act on. So a second test run is refused at its own entry, and a test
   * start during a save is refused too — and vice versa.
   *
   * Acquisition also cancels a pending debounced draft write: the draft slot
   * must keep describing the state as it was when the lock was taken. That
   * cancellation is a LOAN, not a discard — whether one happened is remembered
   * on the lock and {@link unlock} re-arms it. Dropping it outright is how a
   * cancelled Save As used to lose the crash-recovery draft.
   *
   * @returns the token to hand back to {@link unlock}, or null when the
   *   document is already held (read {@link lockOwner} to say by what).
   */
  tryLock(kind: DocumentLockKind): DocumentLockToken | null {
    if (this._lock) return null;
    const generation = ++this._lockGeneration;
    const token = Symbol(`rv-asset-document-lock:${kind}:${generation}`);
    const cancelledPendingWrite = this._autosave.hasPendingWrite;
    this._lock = { kind, token, generation, startedAt: Date.now(), cancelledPendingWrite };
    this._autosave.cancel();
    return { kind, token, generation };
  }

  /**
   * Release a lock — only for the token that is actually holding it.
   *
   * A foreign token, a token from an earlier generation, or a call when nothing
   * is held is a no-op with a warning rather than an error. That asymmetry is
   * deliberate: releasing is what error paths do, often more than once and
   * often out of order, and a throwing release would turn a recoverable failure
   * into a lost document. What it must never do is let a timeout armed for run
   * N release the lock of run N+1 — which is exactly what the generation check
   * prevents.
   *
   * Releasing also GIVES BACK the debounced draft write {@link tryLock} took
   * away. The case that made this necessary: edit, hit Save As before the
   * debounce fires, then cancel the name prompt. The lock had cancelled the
   * armed write, nothing rescheduled it, and unless the user happened to touch
   * the document again the crash-recovery draft stayed at the state before that
   * edit — silently, which is the worst shape a draft can fail in.
   *
   * The re-arm is guarded by `dirty` rather than by the remembered flag alone,
   * and that guard is what keeps a SUCCESSFUL save from writing the slot it
   * just cleared: `markSaved` re-bases the log inside the save's own lock, so
   * by the time the save releases, the document is clean and there is nothing
   * left to describe. A save the user cancelled never reaches `markSaved`, so
   * the document is still dirty and the write comes back.
   */
  unlock(token: DocumentLockToken | null | undefined): void {
    const held = this._lock;
    if (!held) return;
    if (!token || token.token !== held.token || token.generation !== held.generation) {
      console.warn(
        `[asset-document] unlock ignored — the token does not hold this lock `
        + `(held by '${held.kind}', generation ${held.generation}).`);
      return;
    }
    this._lock = null;
    if (!held.cancelledPendingWrite) return;
    // An edit DURING the lock already armed its own write (`onChanged` checks
    // `_autosaveSuspended`, not the lock), and re-arming would only push that
    // debounce further out.
    if (this._disposed || this._autosaveSuspended) return;
    if (!this._doc.dirty || this._autosave.hasPendingWrite) return;
    this._autosave.onChanged(this._doc);
  }

  /** What holds the document, or null when it is free. */
  get lockOwner(): DocumentLockOwner | null {
    return this._lock ? { kind: this._lock.kind, startedAt: this._lock.startedAt } : null;
  }

  /** Does `token` currently hold this document? */
  holdsLock(token: DocumentLockToken | null | undefined): boolean {
    const held = this._lock;
    return !!held && !!token
      && token.token === held.token && token.generation === held.generation;
  }

  /**
   * Refuse a mutation while a TEST RUN or a REPLACE (plan-527) owns the document.
   *
   * Never a save, and that is the contract rather than an oversight: a save
   * legitimately calls {@link markSaved} and re-bases the log from inside its
   * own lock, so making the save owner block the document's own methods would
   * make the save block itself. Saves exclude each other, and exclude test
   * runs, at ACQUISITION — {@link tryLock} is where that is decided.
   */
  private _assertUnlocked(what: string): void {
    const held = this._lock;
    // `save` is the one owner that may still mutate (it calls `markSaved` from
    // inside its own lock). `test-run` and `replace` refuse everything.
    if (!held || held.kind === 'save') return;
    const owner: DocumentLockOwner = { kind: held.kind, startedAt: held.startedAt };
    throw new DocumentLockedError(owner, documentLockedMessage(owner, what));
  }

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
  restoreFromSnapshot(
    state: AssetDocumentSessionState,
    token?: DocumentLockToken | null,
  ): void {
    // The one mutation a test run must be able to make while it holds the
    // document — putting the frozen history back is what ENDS the run. So it is
    // allowed for the token holder and refused for everyone else, rather than
    // refused outright (which would make the lock unreleasable) or allowed
    // outright (which would let any caller overwrite a live run's history).
    if (this._lock && !this.holdsLock(token)) {
      this._assertUnlocked('Restoring the document from a snapshot');
    }
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
    // Autosave is NOT resumed here any more (plan-462 B3): it is derived from
    // the lock, and the run that owns the lock is the one that releases it —
    // after this call, once its scene restore has actually finished.
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
    // Guarded although it is "not an op": it CLEARS the draft slot, which
    // during a test run is the only record of the pre-test authoring state.
    // A save holding its own lock passes — see `_assertUnlocked`.
    this._assertUnlocked('Marking the document saved');
    this._base = base;
    this.executor.flushTrash();
    // plan-498 F13: a package the save just embedded lives in the file now —
    // its draft side-store copy (only there for a reload BEFORE the first
    // save) goes with the draft. Read before the re-base empties the log; a
    // package the save could not embed (not in the store) is kept.
    const savedFmuShas = fmuShasOfOps(this._doc.ops).filter((sha) => binaryResources.has(sha));
    // Re-base the op log. This notifies, which schedules an autosave — so the
    // cancel below MUST come after it, or the debounced write would overwrite
    // the cleared draft with the stale pre-save log.
    this._doc.markSaved(name ? { name } : undefined);
    this._autosave.cancel();
    const draftDone = clearDocumentDraft(this._draftFrame);
    this._snapshot = null;
    for (const fn of this._listeners) fn();
    if (savedFmuShas.length === 0) return draftDone;
    return Promise.all([draftDone, ...savedFmuShas.map((sha) => deleteDraftFmuPackage(sha))]).then(() => undefined);
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
    this._assertUnlocked('Discarding edits');
    if (!this._bound) return 0;
    const undone = await this._doc.rollbackTo(this._bindFloor);
    this._snapshot = null;
    for (const fn of this._listeners) fn();
    return undone;
  }

  dispose(): void {
    this._simplifier.dispose();
    this._disposed = true;
    // Whatever held the document is gone with it. The generation is bumped so a
    // timeout still armed for that holder cannot release a lock taken later on
    // a document that outlives this one's token.
    this._lock = null;
    this._lockGeneration++;
    this._autosave.dispose();
    this._unsubDoc();
    // plan-498: the document's FMU packages were held for Undo while it was
    // open; a package another document (or the loaded model) holds survives.
    binaryResources.releaseDocument(fmuDocumentResourceId(this.id));
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
/**
 * plan-675: a merge whose textured bucket mixed sources with and without `uv`
 * filled the gaps with zeros — those parts now render one texel of the texture.
 * That is not silent any more: one Problems entry per bucket names the material
 * and the meshes, and the fix (`editor.generateUVs` before merging).
 */
export function reportMergeUVGaps(rootPath: string, classification: MergeClassification): void {
  for (const gap of classification.uvGaps) {
    const names = gap.missing.slice(0, 5).map((m) => m.name || '(unnamed)');
    reportProblem({
      id: `merge-uv-missing:${rootPath}:${gap.bucketKey}`,
      severity: 'warning',
      code: 'merge-uv-missing',
      title: `Merged textured material "${gap.materialName}" without UVs on ${gap.missing.length} of ${gap.total} parts`,
      detail: `Parts without UVs sample a single texel (flat colour): ${names.join(', ')}${gap.missing.length > names.length ? ', …' : ''}. `
        + 'Undo, run Generate UVs (editor.generateUVs) on them, then merge again.',
      nodePath: rootPath,
    });
  }
}

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

// `uniqueName` is the shared helper of `rv-node-naming` (plan-758): the same
// `Name, Name_1, Name_2 …` rule the planner assigns to placements. It never
// strips, so the `_part${i}` / `_merged` bases below keep their digits.

/** Unique child name under a parent (Name, Name_1, Name_2 …). */
function uniqueChildName(parent: Object3D | null, base: string): string {
  const sane = base.replace(/[^\w\- ]+/g, '_').trim() || 'CAD';
  return uniqueName(siblingNames(parent), sane);
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

// ─── Reference rewrite planning (plan-610) ────────────────────────────────

/** The planned rewrite of one structural change, ready to compose. */
interface DocumentReferenceRewrite {
  /** `setField` steps (POST-change referrer paths, complete field values). */
  setOps: RvAssetPrimitiveOp[];
  /**
   * The composite must run its end-of-range re-bind: there are steps, or a
   * live component holds a resolved address under a moved path (a foreign
   * referrer inside a placed asset, whose extras are never written).
   */
  needsRebind: boolean;
  summary: ReferenceRewriteSummary;
}

/**
 * Plan the reference rewrite for `moves` (old canonical → new canonical,
 * subtree roots suffice) against the CURRENT, not yet mutated state.
 *
 * Referrers are every registered non-alias node with extras; those inside
 * referenced (foreign) content are skipped — their extras belong to another
 * asset and are re-bound at runtime instead. Each written path is resolved
 * with its component type and authoring scope through the registry's ONE
 * resolution chain ({@link NodeRegistry.resolveWithStage}).
 *
 * `authoredMoves` (plan-765 F2b) is the same change spelled in AUTHORED names
 * (`_rvOrigName ?? name` per segment). With it, a reference written in the
 * authored spelling of a moved node is rewritten in that spelling rather than
 * healed onto the loader's `_N` names — see `authoredMoves` in the rewrite core.
 */
function planDocumentReferenceRewrite(
  viewer: RVViewer,
  moves: ReadonlyMap<string, string>,
  authoredMoves?: ReadonlyMap<string, string>,
): DocumentReferenceRewrite {
  const registry = viewer.registry;
  if (!registry || moves.size === 0) return { setOps: [], needsRebind: false, summary: emptyRewrite() };
  const modelRoot = viewer.currentModelRoot ?? null;

  // Leaf names (in the spellings the lookup stages tolerate) of every node in a
  // moved subtree: a written path whose leaf is none of them cannot resolve
  // INTO a moved subtree, so it is not resolved at all (the planner then
  // counts it as unresolved — counts are candidates, not an audit).
  const movedLeaves = new Set<string>();
  const addLeaf = (name: string): void => {
    movedLeaves.add(name);
    movedLeaves.add(name.replace(/ /g, '_'));
    movedLeaves.add(sanitizeLikeThree(name));
  };
  for (const oldPath of moves.keys()) {
    const root = registry.getNode(oldPath);
    if (root) {
      root.traverse((n) => {
        addLeaf(n.name);
        // An authored-spelled reference ends in the authored name (plan-765 F2b).
        const orig = n.userData?.[RV_ORIG_NAME_KEY];
        if (typeof orig === 'string' && orig.length > 0) addLeaf(orig);
      });
    } else {
      addLeaf(leafName(oldPath));
    }
  }
  const mayHitMoved = (written: string): boolean => {
    const leaf = leafName(written.replace(/\/+$/, ''));
    return movedLeaves.has(leaf) || movedLeaves.has(leaf.replace(/ /g, '_')) || movedLeaves.has(sanitizeLikeThree(leaf));
  };

  const nodesByPath = new Map<string, Object3D>();
  const referrers: { nodePath: string; extras: Record<string, unknown> }[] = [];
  registry.forEachNode((path, node) => {
    if (registry.getPathForNode(node) !== path) return; // alias entry
    const extras = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!extras || typeof extras !== 'object') return;
    nodesByPath.set(path, node);
    referrers.push({ nodePath: path, extras });
  });

  const foreign = new Map<string, boolean>();
  const isForeign = (path: string): boolean => {
    let v = foreign.get(path);
    if (v === undefined) {
      const node = nodesByPath.get(path);
      v = !!node && outermostReference(node, modelRoot) !== null;
      foreign.set(path, v);
    }
    return v;
  };

  const plan = planReferenceRewrite({
    referrers,
    moves,
    ...(authoredMoves ? { authoredMoves } : {}),
    isForeign,
    resolveOld: ({ path, componentType, referrerPath }) => {
      if (!mayHitMoved(path)) return null;
      const referrer = nodesByPath.get(referrerPath);
      if (!referrer) return null;
      // The reference's own chain first (a node without the target component is
      // no hit). A typed miss that EXACTLY names a node — a late-resolved
      // component reference (`MachiningVolume.Tools`, DES) whose target type
      // is not built yet — still follows its node; it is never healed.
      let hit = registry.resolveWithStage({ path }, componentType ?? '', referrer);
      if (!hit && componentType && !isEagerRefType(componentType)) {
        const asNode = registry.resolveWithStage({ path }, '', referrer);
        // A path in the AUTHORED names of exactly that node (plan-765 F2b) is as
        // good as exact: the loader's dedup alias is the only reason it is not.
        if (asNode && (asNode.stage === 'exact' || (authoredMoves
          && writtenTailMatches(path, authoredNodePath(asNode.node), asNode.spelling)))) hit = asNode;
      }
      if (!hit) return null;
      const canonical = registry.getPathForNode(hit.node);
      if (canonical === null) return null;
      const out = { canonical, spelling: hit.spelling, stage: hit.stage, scopeRootPath: hit.scopeRootPath };
      if (!authoredMoves) return out;
      const authored = authoredNodePath(hit.node);
      return authored === canonical ? out : { ...out, authoredCanonical: authored };
    },
    resolveName: ({ name, referrerPath }) => {
      if (!movedLeaves.has(name)) return null;
      const owner = nodesByPath.get(referrerPath);
      if (!owner) return null;
      // RVSource: the owner's subtree first, then the registry.
      const inOwner = namedNodesUnder(owner, name);
      if (inOwner.length === 1) return { canonical: registry.getPathForNode(inOwner[0]) };
      if (inOwner.length > 1) return { canonical: null, ambiguous: true };
      const scopeRoot = registry.enclosingScope(owner).root;
      const inScope = namedNodesUnder(scopeRoot, name);
      if (inScope.length > 1) return { canonical: null, ambiguous: true };
      const node = inScope[0] ?? registry.getNode(name);
      return node ? { canonical: registry.getPathForNode(node) } : null;
    },
  });

  const setOps: RvAssetPrimitiveOp[] = [...plan.steps, ...plan.nameSteps].map((s) => ({
    ...assetOpHeader(),
    kind: 'setField',
    nodePath: s.nodePath,
    componentType: s.componentType,
    fieldName: s.field,
    // Detached copies: the op log must not share objects with the live extras.
    value: cloneJson(s.value),
    prev: cloneJson(s.prev),
  }));
  const needsRebind = setOps.length > 0 || liveAddressUnderMoves(registry, moves);
  const summary: ReferenceRewriteSummary = {
    referencesRewritten: plan.counts.referencesRewritten,
    nameFieldsRewritten: plan.counts.nameFieldsRewritten,
    warnings: plan.warnings.map((w: ReferenceRewriteWarning) => ({ code: w.code, message: w.message, nodePath: w.nodePath })),
  };
  return { setOps, needsRebind, summary };
}

/**
 * Reference types `resolve` binds at load (Drive, Sensor, signals, plain
 * nodes): a miss there is a genuinely broken reference, not a late one.
 */
function isEagerRefType(componentType: string): boolean {
  const ct = componentType.slice(componentType.lastIndexOf('.') + 1);
  return componentType === 'UnityEngine.Transform'
    || ct.includes('Drive') || ct.includes('Sensor') || ct.includes('Signal') || ct.includes('PLC');
}

/** A JSON value detached from the live extras (`undefined` stays `undefined`). */
function cloneJson<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v)) as T;
}

/** Nodes named `name` in `root`'s subtree (root included). */
function namedNodesUnder(root: Object3D, name: string): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((n) => { if (n.name === name) out.push(n); });
  return out;
}

/**
 * Does any live component hold a resolved address string (scalar or array
 * element) at or below one of the moved paths? Then the composite needs the
 * end-of-range re-bind even without a single step to write.
 */
function liveAddressUnderMoves(registry: NodeRegistry, moves: ReadonlyMap<string, string>): boolean {
  const under = (s: string): boolean => {
    if (moves.has(s)) return true;
    for (let i = s.indexOf('/'); i > 0; i = s.indexOf('/', i + 1)) {
      if (moves.has(s.slice(0, i))) return true;
    }
    return false;
  };
  let found = false;
  registry.forEachNode((path, node) => {
    if (found || registry.getPathForNode(node) !== path) return;
    for (const [, instance] of registry.getComponentsAt(path)) {
      if (!instance || typeof instance !== 'object') continue;
      for (const v of Object.values(instance as Record<string, unknown>)) {
        const hit = typeof v === 'string'
          ? under(v)
          : Array.isArray(v) && v.some((e) => typeof e === 'string' && under(e));
        if (hit) { found = true; return; }
      }
    }
  });
  return found;
}

/**
 * The op of a reference-safe structural change: the structure ops, then the
 * rewrite's `setField` steps, as ONE composite. Marked (`referenceRewrite`)
 * only when it needs the deferred re-bind; an unmarked change keeps exactly its
 * old shape (a lone primitive stays a primitive).
 */
function rewriteComposite(label: string, structure: RvAssetPrimitiveOp[], rewrite: DocumentReferenceRewrite): RvAssetOp {
  if (!rewrite.needsRebind) {
    return structure.length === 1 ? structure[0] : makeAssetComposite(label, structure);
  }
  return makeAssetComposite(label, [...structure, ...rewrite.setOps], { referenceRewrite: true });
}

/** The refusal message of a rename that would rename a signal (plan-610 F6). */
function signalNodeRefusal(nodePath: string, autoRename = false): string {
  const what = autoRename
    ? `Moving "${nodePath}" would auto-rename it (a sibling of that name exists under the target), but it`
    : `"${nodePath}"`;
  return `${what} is a signal node whose signal name comes from its node name (no "Name" set) — `
    + 'renaming the node would rename the signal under every PLC/CONNECT binding. '
    + 'Use editor.signalRename to rename the signal, or set its "Name" field first.';
}
