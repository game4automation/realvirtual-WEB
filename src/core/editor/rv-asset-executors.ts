// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-executors — apply AssetOps to the live RVViewer scene.
 *
 * For every primitive `AssetOp.kind`: `applyAssetForward(op)` mutates the live
 * scene, `applyAssetInverse(op)` reverses it via the op's `prev` payload.
 * Composites fan out (forward in order, inverse in reverse). Failures are
 * caught and logged — a stale op (e.g. node renamed outside the op flow) never
 * breaks the queue.
 *
 * Structural deletes use DETACH-TO-TRASH: `deleteNode` (and the inverse of
 * `importCad`) move the subtree into a hidden trash group instead of disposing
 * it, so undo re-attaches the ORIGINAL objects (geometry, materials, userData)
 * without any serialization. The trash is flushed on save/close by the
 * AssetDocument. Draft replay never needs the trash — recovery replays forward
 * ops only.
 *
 * `importCad` never inlines geometry. The op carries only `{Sha256, Quality}`;
 * the GLB bytes they address are resolved, in order, from:
 *   1. a session-local payload map (the fresh-import path parsed them already —
 *      pure optimization, it skips a redundant re-parse of the same bytes),
 *   2. the content-addressed GLB cache (`rv-cad-glb-cache`) — this is what makes
 *      draft replay work after a reload, in the PUBLIC build too,
 *   3. the registered `CadGeometryProvider.retessellate` (private build only),
 *      for when the GLB cache was evicted but the original CAD bytes survive.
 *
 * All three yield the SAME tree, because all three parse the same GLB bytes.
 * When none of them can produce geometry the op throws
 * {@link CadGeometryUnavailableError}, which — unlike a generic executor failure
 * — is collected and surfaced to the user instead of being logged away.
 * {@link SeparateMeshUnappliedError} is the second member of that class: a
 * recorded split whose source is gone (typically the same evicted cache, one op
 * downstream) is reported, never silently skipped.
 */

import { BufferGeometry, Group, Matrix4, Mesh, Object3D } from 'three';
import type { Material } from 'three';
import type { RVViewer } from '../rv-viewer';
import { NodeRegistry } from '../engine/rv-node-registry';
import {
  writeUserDataField,
  deleteUserDataField,
  reapplySchemaForComponent,
} from '../hmi/scene/rv-scene-executors';
import {
  constructComponentOnNode,
  disposeComponentsInSubtree,
  processExtras,
  type RuntimeNodeDeps,
} from '../engine/rv-scene-loader';
import {
  computeGroupPartitions,
  computeMeshIslands,
  extractSubGeometry,
  groupModeIneligibility,
  triangleCount,
  REASON_MULTI_MATERIAL,
  REASON_SINGLE_PART,
} from './rv-mesh-separator';
import {
  buildMergedGeometry,
  materialFingerprint,
} from './rv-mesh-merge';
import { unsupportedMeshShapeReason } from '../engine/rv-mesh-guards';
import { debug } from '../engine/rv-debug';
import { parseGlbSubtree } from '../engine/rv-glb-parse';
import { GROUP_KEY_RE, syncNodeGroups, syncSubtreeGroups } from '../engine/rv-group-sync';
import { getCadProvider, cadFormatOfName } from './rv-cad-provider';
import { getCadGlb } from '../import/rv-cad-glb-cache';
import { materialForValue } from './rv-asset-material';
import { assetOpTouchesHierarchy, classifyAssetOpRaycastImpact } from './rv-asset-ops';
import type {
  AssetOp,
  AssetPrimitiveOp,
  ImportCadOp,
  TransformNodeOp,
  RenameNodeOp,
  DeleteNodeOp,
  CreateNodeOp,
  ReparentNodeOp,
  AddComponentOp,
  RemoveComponentOp,
  AssetSetFieldOp,
  AssetUnsetFieldOp,
  SetMaterialOp,
  SeparateMeshOp,
  MergeMeshOp,
  MergeOutputSpec,
  MergeKeptNodeSpec,
  NodeTransform,
  CADLinkExtras,
} from './rv-asset-ops';

/** Name of the hidden trash group parked directly under the scene root. */
const TRASH_GROUP_NAME = '_rvAssetTrash';

/** Trash key for the Group a `separateMesh` created (parked by its inverse). */
function separateTrashKey(opId: string): string { return `separate:${opId}`; }
/** Trash key for the source mesh a `separateMesh` displaced. */
function sourceTrashKey(opId: string): string { return `sourceOf:${opId}`; }
/** Trash key for the ORIGINAL subtree a `mergeMesh` dissolved (parked by its forward). */
function mergeSourceTrashKey(opId: string): string { return `mergeSource:${opId}`; }
/** Trash key for the merged result a `mergeMesh` built (parked by its inverse). */
function mergedTrashKey(opId: string): string { return `merged:${opId}`; }

/**
 * Marker on geometries the separator created, so the trash flush knows which
 * ones it exclusively owns and may dispose. Underscore-prefixed, i.e. stripped
 * by `sanitizeUserDataForExport` if it ever reached a node's userData.
 */
const SEPARATOR_GEOMETRY_MARK = '_rvSeparatorPart';

/**
 * Same idea for the merger, and here it matters even more: the parked ORIGINAL
 * geometries may be shared with meshes elsewhere and come back alive on undo, so
 * only the geometries the merge itself BUILT may ever be disposed.
 */
const MERGER_GEOMETRY_MARK = '_rvMergerOutput';

/**
 * The analysis result handed over from the preview so the apply does not repeat
 * it (plan-331 §2.3).
 *
 * The analysis runs in the ACTION, before the op — and therefore before an op id
 * exists. Same handoff as `importCad`: the document mints the header, hands the
 * payload over under that id, then applies the op. The executor consumes the
 * entry and deletes it; a replay finds none and recomputes.
 */
export interface SeparateMeshPayload {
  /** The geometry the analysis ran on — identity-checked before the result is reused. */
  sourceGeometry: BufferGeometry;
  /** Vertex count at analysis time — the other half of the staleness check. */
  vertexCount: number;
  /** Triangle indices per output part, in child order. */
  partitions: number[][];
  /** Ready-built part geometries, same order. Empty when only `analyze` ran. */
  geometries: BufferGeometry[];
}

/**
 * Merged geometries handed over from the preview, so the apply does not repeat the bake
 * (plan-372 §2.3). Same handoff mechanism as {@link SeparateMeshPayload}.
 */
export interface MergeMeshPayload {
  /** Source geometries at analysis time, indexed like `op.sourcePaths` — identity-checked. */
  sources: { geometry: BufferGeometry; vertexCount: number }[];
  /** Ready-built merged geometries, indexed like `op.outputs`. Empty = build here. */
  geometries: (BufferGeometry | null)[];
}

/** One node a `mergeMesh` lifted out of the dissolved subtree. */
interface MergeMovedNode {
  node: Object3D;
  /** Parent BEFORE the merge — undo restores exactly here. */
  parent: Object3D;
  /** Sibling index BEFORE the merge (captured before ANY detachment). */
  childIndex: number;
  /** Depth below the subtree root; orders detach (deep first) and restore (shallow first). */
  depth: number;
  role: 'protected' | 'anchor' | 'source';
  /** Where the node belongs AFTER the merge. `null` for sources (they get parked). */
  targetParent: Object3D | null;
  /** Local matrix before the merge — the re-home rebases it to keep the world pose. */
  prevMatrix: Matrix4;
}

/** One generated output mesh plus the two parents it needs across undo/redo. */
interface MergeOutputRecord {
  node: Mesh;
  /** Parent after the merge; `null` for the `role: 'root'` output (it replaces the root). */
  targetParent: Object3D | null;
  /** Node that owns the zone in the ORIGINAL tree — where late authored children go home. */
  originOwner: Object3D;
}

/** Everything a `mergeMesh` needs to be undone bit-exactly. */
interface MergeRecord {
  /** Ascending (depth, childIndex) — detach walks it backwards, restore forwards. */
  moved: MergeMovedNode[];
  outputs: MergeOutputRecord[];
  rootOutput: Mesh;
  /** Identity of everything the merge generated — tells outputs from authored children. */
  generated: Set<Object3D>;
  /** Nodes that went into the trash with the root (structural leftovers + sources). */
  parked: Set<Object3D>;
  outputGeometries: BufferGeometry[];
  /** Cleared when the output geometries are disposed — gates the async BVH build. */
  alive: { value: boolean };
}

/** What a `separateMesh` created, so its inverse can tell parts from authored children. */
interface SeparateRecord {
  /** The generated island/group meshes (identity, not names). */
  islands: Set<Object3D>;
  /** Cleared when the parts' geometries are disposed — gates the async BVH build. */
  alive: { value: boolean };
}

/**
 * Neither the GLB cache nor the CAD provider could produce the geometry an
 * `importCad` op references — the caches were evicted (or this is a public build
 * opening a draft whose GLB cache is gone). Recoverable: the user re-picks the
 * source file. Distinguished from generic executor failures so that replay can
 * surface it rather than swallow it.
 */
export class CadGeometryUnavailableError extends Error {
  constructor(readonly cadlink: CADLinkExtras) {
    super(
      `CAD geometry for ${cadlink.File} (${cadlink.Sha256.slice(0, 8)}…) is not available — re-import the file`,
    );
    this.name = 'CadGeometryUnavailableError';
  }
}

/**
 * A recorded `separateMesh` op could not be applied to the live tree — the
 * source node is gone, is no longer a mesh, lost its parent, or the recorded
 * split no longer reproduces on it (part count / name divergence).
 *
 * Collected and surfaced like {@link CadGeometryUnavailableError}, NOT swallowed:
 * a silent no-op would leave the op recorded in the draft, so the split counts as
 * having happened while the tree still holds the unsplit mesh — and every later op
 * in the draft then edits the wrong tree. Recoverable: the user re-imports the
 * missing source (or drops the split) with the divergence named.
 */
export class SeparateMeshUnappliedError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly reason: string,
    readonly opId: string,
  ) {
    super(`separateMesh on "${sourcePath}" was not applied: ${reason} (op ${opId})`);
    this.name = 'SeparateMeshUnappliedError';
  }
}

/** One drained {@link SeparateMeshUnappliedError}, flattened for the UI. */
export interface UnappliedSeparation {
  sourcePath: string;
  reason: string;
  opId: string;
}

/**
 * A recorded `mergeMesh` op could not be applied — a source path is gone, is no longer a
 * mesh, its material or vertex count diverged from the recorded signature, or an owner
 * path no longer resolves.
 *
 * The third member of the collected, user-recoverable class next to
 * {@link CadGeometryUnavailableError} and {@link SeparateMeshUnappliedError}, and for the
 * same reason: a silent no-op would leave the merge recorded in the draft while the tree
 * still holds the unmerged subtree, so every later op would edit the wrong tree. Throwing
 * instead would make the replay caller replace the partially restored document with an
 * empty one — which is why this is COLLECTED rather than fatal.
 */
export class MergeMeshUnappliedError extends Error {
  constructor(
    readonly rootPath: string,
    readonly reason: string,
    readonly opId: string,
  ) {
    super(`mergeMesh on "${rootPath}" was not applied: ${reason} (op ${opId})`);
    this.name = 'MergeMeshUnappliedError';
  }
}

/** One drained {@link MergeMeshUnappliedError}, flattened for the UI. */
export interface UnappliedMerge {
  rootPath: string;
  reason: string;
  opId: string;
}

/**
 * Rename duplicate sibling names to `name_1`, `name_2`, … (the glTF/Unity
 * `_N` convention) throughout a subtree, in place. CAD assemblies commonly
 * repeat part names (20× "Bolt"); the NodeRegistry keys nodes by name-path,
 * so duplicate siblings would collapse onto ONE path and picking/selection
 * would always resolve the same instance.
 *
 * Deterministic (child order decides indices) and idempotent — replaying the
 * same tree yields the same names, and pre-existing `name_N` siblings keep
 * their names (renamed duplicates skip over them).
 */
export function dedupeSiblingNames(root: Object3D): void {
  const stack: Object3D[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    if (parent.children.length > 0) {
      // Original names are reserved so a renamed duplicate never steals the
      // name of a later sibling that legitimately carries a `_N` suffix.
      const taken = new Set<string>();
      for (const child of parent.children) taken.add(child.name);
      const assigned = new Set<string>();
      for (const child of parent.children) {
        let name = child.name;
        if (assigned.has(name)) {
          let i = 1;
          while (taken.has(`${name}_${i}`) || assigned.has(`${name}_${i}`)) i++;
          name = `${name}_${i}`;
          child.name = name;
          taken.add(name);
        }
        assigned.add(name);
        stack.push(child);
      }
    }
  }
}

/** One trashed subtree — enough to re-attach at the original position. */
interface TrashEntry {
  node: Object3D;
  parent: Object3D;
  childIndex: number;
}

export class AssetExecutorContext {
  readonly viewer: RVViewer;
  /**
   * Session-local geometry payloads for importCad ops (op.id → parsed root).
   *
   * Purely an optimization: the fresh-import path has already parsed the GLB
   * bytes (it needs the root's transform to build the op), so handing that tree
   * over avoids re-parsing a possibly-large assembly a second time. The bytes are
   * in the cache either way, so a miss here is not a failure — it just falls
   * through to `getCadGlb` + `parseGlbSubtree` and yields the identical tree.
   */
  private readonly _cadPayloads = new Map<string, Object3D>();
  /** Detached subtrees keyed by op id (deleteNode) / `import:<opId>` (importCad inverse). */
  private readonly _trash = new Map<string, TrashEntry>();
  private _trashGroup: Group | null = null;
  /**
   * Original materials displaced by a `setMaterial` op, keyed by op id → mesh
   * path, so undo re-attaches the EXACT instance.
   *
   * Two things depend on this rather than on rebuilding from the op payload:
   * textured materials cannot round-trip through `MaterialValue` at all, and
   * even those that can would come back as fresh unshared instances, silently
   * splitting a material the rest of the asset still shares.
   */
  private readonly _materialTrash = new Map<string, Map<string, Material>>();
  /** importCad ops whose geometry could not be resolved (drained by the plugin). */
  private _missingCadGeometry: CADLinkExtras[] = [];
  /** separateMesh ops that did not land on the live tree (drained by the plugin). */
  private _unappliedSeparations: UnappliedSeparation[] = [];
  /** Preview analysis results awaiting their `separateMesh` op (op.id → payload). */
  private readonly _separatePayloads = new Map<string, SeparateMeshPayload>();
  /** Per-`separateMesh` bookkeeping: which children are generated parts, BVH liveness. */
  private readonly _separateRecords = new Map<string, SeparateRecord>();
  /** mergeMesh ops that did not land on the live tree (drained by the plugin). */
  private _unappliedMerges: UnappliedMerge[] = [];
  /** Pre-built merge geometries awaiting their `mergeMesh` op (op.id → payload). */
  private readonly _mergePayloads = new Map<string, MergeMeshPayload>();
  /** Per-`mergeMesh` bookkeeping: moved nodes, generated outputs, BVH liveness. */
  private readonly _mergeRecords = new Map<string, MergeRecord>();

  constructor(viewer: RVViewer) {
    this.viewer = viewer;
  }

  /** Stash the freshly parsed CAD root for the matching importCad op. */
  provideCadPayload(opId: string, root: Object3D): void {
    this._cadPayloads.set(opId, root);
  }

  /**
   * Stash the preview's analysis (and, when the user confirmed, the extracted
   * part geometries) for the matching `separateMesh` op.
   *
   * The executor validates the payload against the LIVE source geometry before
   * using it — a mesh edited while the dialog was open must not silently get a
   * stale split.
   */
  provideSeparatePayload(opId: string, payload: SeparateMeshPayload): void {
    this._separatePayloads.set(opId, payload);
  }

  /** Drop a stashed analysis (dialog cancelled, or the action failed). */
  discardSeparatePayload(opId: string): void {
    this._separatePayloads.delete(opId);
  }

  /**
   * Stash the preview's merged geometries for the matching `mergeMesh` op.
   *
   * Validated against the LIVE source geometries before use — a subtree edited while the
   * dialog was open must not silently get a stale merge.
   */
  provideMergePayload(opId: string, payload: MergeMeshPayload): void {
    this._mergePayloads.set(opId, payload);
  }

  /** Drop a stashed merge payload (dialog cancelled, or the action failed). */
  discardMergePayload(opId: string): void {
    const payload = this._mergePayloads.get(opId);
    this._mergePayloads.delete(opId);
    // These geometries were built for an op that will never run — nothing else holds them.
    for (const geometry of payload?.geometries ?? []) geometry?.dispose();
  }

  /**
   * Take (and clear) the `mergeMesh` ops that did not land during the last apply/replay.
   * Same one-shot contract as {@link takeUnappliedSeparations}.
   */
  takeUnappliedMerges(): UnappliedMerge[] {
    const out = this._unappliedMerges;
    this._unappliedMerges = [];
    return out;
  }

  /**
   * Take (and clear) the CADLinks whose geometry could not be re-materialised
   * during the last apply/replay. The AssetEditorPlugin drains this after
   * `replayOps` and prompts the user to re-import — geometry silently vanishing
   * is exactly the failure this replaces.
   */
  takeMissingCadGeometry(): CADLinkExtras[] {
    const out = this._missingCadGeometry;
    this._missingCadGeometry = [];
    return out;
  }

  /**
   * Take (and clear) the `separateMesh` ops that did not land during the last
   * apply/replay. Same contract as {@link takeMissingCadGeometry}: the plugin
   * drains this after `replayOps` and tells the user, because a recorded-but-
   * unapplied split silently desynchronises the draft from the live tree.
   */
  takeUnappliedSeparations(): UnappliedSeparation[] {
    const out = this._unappliedSeparations;
    this._unappliedSeparations = [];
    return out;
  }

  /** Dispose the trash + payload maps (document close / save). Trash nodes are
   *  removed from the scene; geometry disposal is left to the GC/renderer since
   *  trashed CAD meshes may share materials with live clones. */
  flushTrash(): void {
    for (const entry of this._trash.values()) {
      // Geometries the SEPARATOR built are exclusively owned by their island
      // mesh — nothing else in the scene references them — so this is the one
      // place where disposal is provably safe (the trashed CAD meshes above are
      // not, which is why the rest of the trash is still left to the GC).
      // `disposeBoundsTree()` first: the tree holds its own typed arrays and
      // three-mesh-bvh patches it onto the prototype, so disposing the geometry
      // alone would strand it.
      this._disposeSeparatorGeometries(entry.node);
      // Same exclusive-ownership rule for the merger — and here the distinction is
      // load-bearing: the OTHER trash entry of a merge holds the original geometries,
      // which may be shared and must never be disposed.
      this._disposeMergerGeometries(entry.node);
      entry.node.removeFromParent();
    }
    this._trash.clear();
    this._trashGroup?.removeFromParent();
    this._trashGroup = null;
    // Displaced materials are no longer reachable for undo. Their textures may
    // still be shared with live materials, so leave disposal to the renderer —
    // same reasoning as the trashed CAD meshes above.
    this._materialTrash.clear();
  }

  dispose(): void {
    // Every in-flight BVH build is abandoned before the trash flush disposes
    // the geometries it would otherwise write its tree into.
    for (const record of this._separateRecords.values()) record.alive.value = false;
    for (const record of this._mergeRecords.values()) record.alive.value = false;
    this.flushTrash();
    this._cadPayloads.clear();
    this._separatePayloads.clear();
    this._separateRecords.clear();
    for (const opId of [...this._mergePayloads.keys()]) this.discardMergePayload(opId);
    this._mergeRecords.clear();
    this._missingCadGeometry = [];
    this._unappliedSeparations = [];
    this._unappliedMerges = [];
  }

  // ─── Public entry points ──────────────────────────────────────────────

  /**
   * Apply an op to the live scene.
   *
   * REJECTS when the op could not be applied. The two documented exceptions are
   * {@link CadGeometryUnavailableError} (`takeMissingCadGeometry`) and
   * {@link SeparateMeshUnappliedError} (`takeUnappliedSeparations`), which stay
   * collected, user-recoverable conditions so draft replay of a model whose GLB
   * cache was evicted still restores everything else. Every other failure propagates, so
   * `AssetDocument` can decline to record an op that never landed — recording one
   * was the mechanism behind "half-rebuilt scene, nothing to undo" (plan-359 Phase 3).
   */
  async applyForward(op: AssetOp): Promise<void> {
    try {
      await this._withMatrixBatch(op, () => this._forwardAny(op));
    } finally {
      // Runs on the failure path too: a rolled-back composite touched the graph
      // on its way in and out, so hierarchy/BVH consumers must resync either way.
      this._afterApply(op);
    }
  }

  /** Inverse counterpart of {@link applyForward} — same rejection contract. */
  async applyInverse(op: AssetOp): Promise<void> {
    try {
      await this._withMatrixBatch(op, () => this._inverseAny(op));
    } finally {
      this._afterApply(op);
    }
  }

  // ─── Matrix batching for bulk moves ───────────────────────────────────

  /** Parents whose subtree matrices are pending a forced refresh (null = no batch). */
  private _matrixBatch: Set<Object3D> | null = null;

  /**
   * Run `body` with the per-node world-matrix refresh deferred to the end — but
   * ONLY for a composite made purely of moves and renames.
   *
   * Why the deferral is safe there and nowhere else: those two primitives apply a
   * local TRS that was resolved BEFORE the first mutation, so nothing inside the
   * batch reads `matrixWorld`. A composite that also constructs components would
   * break that (component construction may measure the node), so it keeps the
   * eager per-op refresh.
   *
   * The flush is unconditional (`finally`): the editor pick backend reads
   * `matrixWorld` RAW and `freezeStaticMatrices` runs in editor loads too, so a
   * skipped refresh would break picking AND rendering — doc-render-picking.md §2.5,
   * "load-bearing invariant".
   */
  private async _withMatrixBatch(op: AssetOp, body: () => Promise<void>): Promise<void> {
    if (this._matrixBatch || !isPureMoveComposite(op)) return body();
    this._matrixBatch = new Set<Object3D>();
    try {
      await body();
    } finally {
      const parents = this._matrixBatch;
      this._matrixBatch = null;
      // One walk per TARGET parent covers every node moved into it — that is the
      // whole saving: 434 subtree walks collapse to one.
      for (const parent of parents) parent.updateMatrixWorld(true);
    }
  }

  /** Force-refresh `node`'s world matrices, or defer it to the open batch. */
  private _refreshWorldMatrix(node: Object3D): void {
    const batch = this._matrixBatch;
    if (batch) { batch.add(node.parent ?? node); return; }
    node.updateMatrixWorld(true);
  }

  /** Post-apply notifications — exactly once per top-level op (composites
   *  included), on BOTH directions so undo/redo/replay stay consistent.
   *  Failures (e.g. a throwing event listener) must never break the op queue —
   *  the scene mutation has already been applied at this point.
   *
   *  Each step gets its OWN try/catch, because they are independent consumers of
   *  the same mutation and one must not starve the next. The group sync is the
   *  one that matters: it maintains live SCENE STATE (GroupRegistry membership),
   *  not just a notification, and a kinematic axis whose group is missing from
   *  the registry silently drives nothing — a drive gizmo that moves an empty
   *  node. Sharing a try block with an arbitrary `editor-structure-changed`
   *  listener or a BVH rebuild made that outcome one unrelated exception away. */
  private _afterApply(op: AssetOp): void {
    this._notifyStep(op, 'structure-changed', () => {
      if (assetOpTouchesHierarchy(op)) {
        this.viewer.emit('editor-structure-changed', { source: 'asset-editor' });
      }
    });
    // With the instance pick backend (editor default), pick membership is
    // maintained INLINE at the scene-mutation sites below (trash detach/
    // restore, import, create, rename/reparent/component epoch bumps) —
    // transforms and visibility need nothing at all. The classification
    // path survives only for the legacy merged groups (kill-switch).
    this._notifyStep(op, 'raycast-resync', () => {
      if (this.viewer.instancePickIndex) return;
      const raycastImpact = classifyAssetOpRaycastImpact(op);
      if (raycastImpact.rebuild) {
        this.viewer.rebuildGroupedBvh(); // macrotask-coalesced (one per transaction)
      } else if (raycastImpact.refitPaths.length > 0) {
        // Pure transforms: position re-bake + BVH refit instead of the full
        // rebuild (which re-merges every mesh + rebuilds the edge arena).
        this.viewer.refitRaycastSubtrees(raycastImpact.refitPaths);
      }
    });
    this._notifyStep(op, 'group-sync', () => {
      if (this._syncGroupOps(op)) this._emitGroupsChanged();
    });
  }

  /** Run one post-apply step; report its failure without taking the others down. */
  private _notifyStep(op: AssetOp, step: string, body: () => void): void {
    try {
      body();
    } catch (e) {
      console.warn(
        `[asset-edits] post-apply ${step} failed for ${op.kind} (op ${op.id}):`, e,
      );
    }
  }

  /** Re-sync GroupRegistry memberships for every Group-touching primitive in
   *  the op (composites recursed). Runs on both directions via _afterApply.
   *  Returns true when the registry changed. */
  private _syncGroupOps(op: AssetOp): boolean {
    if (op.kind === 'composite') {
      let changed = false;
      for (const child of op.ops) changed = this._syncGroupOps(child) || changed;
      return changed;
    }
    if (
      op.kind === 'addComponent' || op.kind === 'removeComponent' ||
      op.kind === 'setField' || op.kind === 'unsetField'
    ) {
      if (GROUP_KEY_RE.test(op.componentType)) {
        const node = this._node(op.nodePath);
        if (node) return syncNodeGroups(this.viewer, node);
      }
    }
    return false;
  }

  private _emitGroupsChanged(): void {
    this.viewer.emit('groups-changed', { source: 'editor' });
    this.viewer.markRenderDirty();
  }

  /**
   * A composite is ATOMIC: it either applies completely or leaves the scene as it
   * found it. A partially applied structural batch is the one state the op log
   * cannot describe — the document records the composite only after this resolves,
   * so a half-applied one would be an un-undoable rebuild of the user's scene
   * (plan-359 §2.4 / Phase 3).
   */
  private async _forwardAny(op: AssetOp): Promise<void> {
    if (op.kind === 'composite') {
      const applied: AssetPrimitiveOp[] = [];
      try {
        for (const child of op.ops) {
          await this._forwardAny(child);
          applied.push(child);
        }
      } catch (e) {
        await this._unwind(applied, (child) => this._inverseAny(child), op.id);
        throw e;
      }
      return;
    }
    try {
      await this._forward(op);
    } catch (e) {
      // Missing CAD geometry is a RECOVERABLE, user-visible condition, not a
      // stale-op hiccup: swallowing it made the geometry disappear silently and
      // every later op targeting those node paths silently no-op. Collect it and
      // CONTINUE (the documented exception to the rejection contract) so replaying
      // a draft whose GLB cache was evicted still restores everything else.
      if (e instanceof CadGeometryUnavailableError) {
        this._missingCadGeometry.push(e.cadlink);
        console.warn(`[asset-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
        return;
      }
      // Same contract for a split that could not be reproduced: it is the
      // upstream half of the SAME failure (an evicted CAD cache takes the
      // source mesh with it), so it must not abort the replay of everything
      // else — but it must reach the user rather than a console warning.
      if (e instanceof SeparateMeshUnappliedError) {
        this._unappliedSeparations.push({
          sourcePath: e.sourcePath, reason: e.reason, opId: e.opId,
        });
        console.warn(`[asset-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
        return;
      }
      // …and the same for a merge that could not be reproduced. Collected, never
      // rethrown: the replay caller replaces a THROWING document with an empty one,
      // so a fatal merge divergence would cost the user the whole draft.
      if (e instanceof MergeMeshUnappliedError) {
        this._unappliedMerges.push({
          rootPath: e.rootPath, reason: e.reason, opId: e.opId,
        });
        console.warn(`[asset-edits] forward apply failed for ${op.kind} (op ${op.id}):`, e);
        return;
      }
      throw e;
    }
  }

  private async _inverseAny(op: AssetOp): Promise<void> {
    if (op.kind === 'composite') {
      const inverted: AssetPrimitiveOp[] = [];
      try {
        for (let i = op.ops.length - 1; i >= 0; i--) {
          await this._inverseAny(op.ops[i]);
          inverted.push(op.ops[i]);
        }
      } catch (e) {
        // Re-apply what was already undone, so a failed undo is a no-op rather
        // than a partial one (the document keeps the op on its undo stack).
        await this._unwind(inverted, (child) => this._forwardAny(child), op.id);
        throw e;
      }
      return;
    }
    await this._inverse(op);
  }

  /** Reverse the primitives a failed composite already applied, newest first.
   *  Unwind failures are logged, never rethrown — the caller must learn the
   *  ORIGINAL error, and there is nothing better left to try. */
  private async _unwind(
    done: AssetPrimitiveOp[],
    reverse: (op: AssetPrimitiveOp) => Promise<void>,
    compositeId: string,
  ): Promise<void> {
    for (let i = done.length - 1; i >= 0; i--) {
      try {
        await reverse(done[i]);
      } catch (e) {
        console.error(
          `[asset-edits] rollback of composite ${compositeId} failed at ${done[i].kind} ` +
          `(op ${done[i].id}) — the scene may be inconsistent:`, e,
        );
      }
    }
  }

  private async _forward(op: AssetPrimitiveOp): Promise<void> {
    switch (op.kind) {
      case 'importCad':       return this._importCadForward(op);
      case 'transformNode':   return this._applyTransform(op.nodePath, op.transform);
      case 'renameNode':      return this._rename(op.nodePath, op.name);
      case 'deleteNode':      return this._detachToTrash(op.id, op.nodePath);
      case 'setNodeVisible':  return this._setNodeVisible(op.nodePath, op.visible);
      case 'createNode':      return this._createNodeForward(op);
      case 'reparentNode':    return this._reparent(op.nodePath, op.newParentPath, op.transform, op.newIndex);
      case 'addComponent':    return this._addComponent(op);
      case 'removeComponent': return this._removeComponent(op);
      case 'setField':        return this._setField(op);
      case 'unsetField':      return this._unsetField(op);
      case 'setMaterial':     return this._setMaterialForward(op);
      case 'separateMesh':    return this._separateMeshForward(op);
      case 'mergeMesh':       return this._mergeMeshForward(op);
    }
  }

  private async _inverse(op: AssetPrimitiveOp): Promise<void> {
    switch (op.kind) {
      case 'importCad':
        // Undo an import: park the subtree in the trash (redo re-attaches it).
        return this._detachToTrash(`import:${op.id}`, op.rootPath);
      case 'transformNode':   return this._applyTransform(op.nodePath, op.prev);
      case 'renameNode': {
        // The node now carries the NEW name — its path ends in op.name.
        const renamedPath = replaceLeaf(op.nodePath, op.name);
        return this._rename(renamedPath, op.prevName);
      }
      case 'deleteNode':      return this._restoreFromTrash(op.id);
      case 'setNodeVisible':  return this._setNodeVisible(op.nodePath, op.prev);
      case 'createNode':
        // Undo a create: park the subtree in the trash (redo re-attaches it,
        // keeping any components/children added before the undo).
        return this._detachToTrash(`create:${op.id}`, op.nodePath);
      case 'reparentNode': {
        // The node now lives under the new parent — resolve its current path.
        const currentPath = joinPath(op.newParentPath, leaf(op.nodePath));
        return this._reparent(currentPath, op.prevParentPath, op.prevTransform, op.prevIndex);
      }
      case 'addComponent':    return this._removeComponentByKey(op.nodePath, op.componentType);
      case 'removeComponent': return this._addComponentWithFields(op.nodePath, op.componentType, op.prevFields);
      case 'setField': {
        if (op.prev === undefined) {
          deleteUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName);
        } else {
          writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
        }
        reapplySchemaForComponent(this.viewer, op.nodePath, op.componentType);
        this.viewer.markRenderDirty();
        return;
      }
      case 'unsetField': {
        writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, op.prev);
        reapplySchemaForComponent(this.viewer, op.nodePath, op.componentType);
        this.viewer.markRenderDirty();
        return;
      }
      case 'setMaterial':     return this._setMaterialInverse(op);
      case 'separateMesh':    return this._separateMeshInverse(op);
      case 'mergeMesh':       return this._mergeMeshInverse(op);
    }
  }

  // ─── setMaterial ──────────────────────────────────────────────────────

  /**
   * Paint every mesh listed in `op.prev` with the op's material.
   *
   * Iterates `op.prev` rather than re-expanding `op.nodePaths`: the mesh set was
   * resolved when the op was created, so replay paints exactly the meshes the
   * user saw change even if the selection has since moved. Meshes missing from
   * the scene (deleted since) are skipped, not an error — draft replay after a
   * delete is a normal path.
   */
  private _setMaterialForward(op: SetMaterialOp): void {
    const shared = materialForValue(op.material);
    const stash = new Map<string, Material>();
    for (const { meshPath, material } of op.prev) {
      const mesh = this._node(meshPath) as Mesh | null;
      if (!mesh || !(mesh as { isMesh?: boolean }).isMesh) continue;
      const current = mesh.material as Material;
      // Stash EVERY displaced material, not only the ones MaterialValue cannot
      // express. Rebuilding from the value would restore the right appearance
      // but a fresh instance, so a material shared with un-painted parts would
      // come back unshared — and the Materials window would then correctly
      // report the result as a duplicate the user never created.
      if (current) stash.set(meshPath, current);
      mesh.material = shared;
    }
    if (stash.size > 0) this._materialTrash.set(op.id, stash);
    this.viewer.markShadowsDirty();
  }

  /**
   * Restore each mesh's pre-op material.
   *
   * Prefers the exact instance stashed by the forward pass, which preserves
   * material sharing across the asset. Falls back to rebuilding from the op's
   * `MaterialValue` — the draft-replay path, where the stash was never filled
   * because the forward pass ran in a previous page session.
   */
  private _setMaterialInverse(op: SetMaterialOp): void {
    const stash = this._materialTrash.get(op.id);
    for (const { meshPath, material } of op.prev) {
      const mesh = this._node(meshPath) as Mesh | null;
      if (!mesh || !(mesh as { isMesh?: boolean }).isMesh) continue;
      const original = stash?.get(meshPath);
      if (original) mesh.material = original;
      else if (material) mesh.material = materialForValue(material);
    }
    // Keep the stash: a redo re-runs forward, and a second undo must restore
    // the same instances again. It is released with the rest of the trash.
    this.viewer.markShadowsDirty();
  }

  // ─── importCad ────────────────────────────────────────────────────────

  private async _importCadForward(op: ImportCadOp): Promise<void> {
    const assetRoot = this.viewer.currentModelRoot;
    if (!assetRoot) throw new Error('no asset root loaded');

    // Redo after an undo: the subtree is parked in the trash — re-attach it.
    if (this._trash.has(`import:${op.id}`)) {
      return this._restoreFromTrash(`import:${op.id}`);
    }

    let root = this._cadPayloads.get(op.id) ?? null;
    if (!root) {
      // Draft replay / redo after a trash flush. The converted GLB is the single
      // source of truth: read the cached bytes and parse them — no occt, no WASM
      // worker, and no CadGeometryProvider needed (so the public build works).
      let bytes = await getCadGlb(op.cadlink.Sha256, op.cadlink.Quality);
      if (!bytes) {
        // Cache evicted. A provider that kept the ORIGINAL CAD bytes can rebuild
        // them (and re-populate the GLB cache); the public build cannot.
        bytes = (await getCadProvider(cadFormatOfName(op.cadlink.File))?.retessellate?.(op.cadlink)) ?? null;
      }
      if (!bytes) throw new CadGeometryUnavailableError(op.cadlink);
      root = await parseGlbSubtree(bytes);
    }
    this._cadPayloads.delete(op.id);

    root.name = leaf(op.rootPath);
    // Unique sibling names BEFORE registration — duplicate CAD part names
    // would collapse onto one registry path (picking would always resolve
    // the same instance). Runs on fresh imports AND cache replays, so live
    // paths stay identical across sessions.
    dedupeSiblingNames(root);
    applyTransform(root, op.transform);
    // Stamp the CADLink extras (kept across GLB save/load round-trips).
    const ud = root.userData as Record<string, unknown>;
    const rv = (ud['realvirtual'] ?? {}) as Record<string, unknown>;
    rv['CADLink'] = { ...op.cadlink };
    ud['realvirtual'] = rv;

    assetRoot.add(root);
    root.updateMatrixWorld(true);
    this._registerSubtree(root);
    // Index the imported meshes + build their local BVHs in the background
    // (native raycast fallback keeps them pickable immediately).
    this.viewer.instancePickIndex?.addSubtree(root);
    if (this.viewer.instancePickIndex) this.viewer.buildMeshBvhsAsync(root);
    this.viewer.markShadowsDirty();
  }

  // ─── transform / rename ───────────────────────────────────────────────

  private _applyTransform(nodePath: string, t: NodeTransform): void {
    const node = this._node(nodePath);
    if (!node) return;
    applyTransform(node, t);
    node.updateMatrixWorld(true);
    this.viewer.markShadowsDirty();
  }

  private _rename(nodePath: string, name: string): void {
    const node = this._node(nodePath);
    if (!node) return;
    node.name = name;
    // Re-key every registered path under this subtree (nodes + components).
    this.viewer.registry?.recomputePathsForSubtrees([node]);
    // Cached pick paths are stale — re-resolve lazily on the next hit.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markRenderDirty();
  }

  // ─── delete / restore (trash) ─────────────────────────────────────────

  private _detachToTrash(key: string, nodePath: string): void {
    const node = this._node(nodePath);
    if (!node || !node.parent) return;
    const parent = node.parent;
    const childIndex = parent.children.indexOf(node);
    this.viewer.registry?.unregisterSubtree(node);
    // MANDATORY, not an optimization: a trashed mesh left in the pick index
    // with a cached path would alias a node later created at the same path.
    this.viewer.instancePickIndex?.removeSubtree(node);
    // Trashed nodes leave their groups (undo re-attaches them below).
    if (syncSubtreeGroups(this.viewer, node, 'detach')) this._emitGroupsChanged();
    this._ensureTrashGroup().add(node);
    this._trash.set(key, { node, parent, childIndex });
    this.viewer.markShadowsDirty();
  }

  private _restoreFromTrash(key: string): void {
    const entry = this._trash.get(key);
    if (!entry) return;
    this._trash.delete(key);
    const { node, parent, childIndex } = entry;
    parent.add(node);
    // Restore the original sibling position (add() appends).
    const arr = parent.children;
    arr.splice(arr.indexOf(node), 1);
    arr.splice(Math.min(childIndex, arr.length), 0, node);
    node.updateMatrixWorld(true);
    this._registerSubtree(node);
    // Fresh index entries resolve lazily on the next pick (epoch 0).
    this.viewer.instancePickIndex?.addSubtree(node);
    // Restored nodes rejoin their groups (memberships derive from extras).
    if (syncSubtreeGroups(this.viewer, node, 'attach')) this._emitGroupsChanged();
    this.viewer.markShadowsDirty();
  }

  // ─── separateMesh ─────────────────────────────────────────────────────

  /**
   * Replace the source mesh with a same-named `Group` carrying one mesh per
   * partition (plan-331 §2.6).
   *
   * NOT "throw the source away and put a Group next to it": everything on the
   * source node has to travel — world transform, `userData`, existing child
   * nodes — and the components on the whole subtree have to be torn down and
   * rebuilt around the move. The order below is load-bearing; the two places it
   * is easiest to get wrong are marked inline.
   */
  private _separateMeshForward(op: SeparateMeshOp): void {
    // Redo after an undo. NOT the `_importCadForward` trash short-circuit: two
    // objects plus the children are in play here (the original is live again
    // WITH its children, the Group sits in the trash), so a plain restore would
    // produce two nodes at the same path and strand the children.
    if (this._trash.has(separateTrashKey(op.id))) return this._separateMeshRedo(op);

    // Every bail-out below is a DIVERGENCE, never a no-op: the op stays in the
    // draft either way, so a split that silently did not happen would leave the
    // draft claiming a tree the scene does not have, and every later op would
    // edit the wrong one. Raise the collected, user-recoverable error instead.
    // The explicit annotation is what makes TS treat a `fail(...)` statement as
    // never-returning, so the narrowing below needs no `!`.
    const fail: (reason: string) => never = (reason) => {
      throw new SeparateMeshUnappliedError(op.sourcePath, reason, op.id);
    };

    const source = this._node(op.sourcePath) as Mesh | null;
    if (!source || !(source as { isMesh?: boolean }).isMesh) {
      fail(`"${op.sourcePath}" is not a live mesh`);
    }
    const parent = source.parent;
    if (!parent) fail(`"${op.sourcePath}" has no parent`);

    const geometry = source.geometry as BufferGeometry;
    const shapeReason = unsupportedMeshShapeReason(source);
    if (shapeReason) fail(shapeReason);
    if (op.mode === 'islands' && Array.isArray(source.material)) {
      fail(REASON_MULTI_MATERIAL);
    }
    if (op.mode === 'groups') {
      const groupReason = groupModeIneligibility(source);
      if (groupReason) fail(groupReason);
    }

    // The preview already paid for weld + union-find; only recompute on replay.
    // The single-island case is read off the partition list rather than through
    // `islandModeIneligibility()`, which would run the union-find a second time.
    const payload = this._takeSeparatePayload(op.id, geometry);
    const partitions = payload?.partitions
      ?? (op.mode === 'groups'
        ? computeGroupPartitions(geometry)
        : computeMeshIslands(geometry, op.weldThreshold));
    if (partitions.length < 2) fail(REASON_SINGLE_PART);
    if (partitions.length !== op.childNames.length) {
      fail(
        `replay divergence — ${partitions.length} parts but ` +
        `${op.childNames.length} recorded names`,
      );
    }
    // Names are applied VERBATIM (plan-331 §2.3) — a collision on replay is an
    // error with a diagnostic, never a silent rename, or the live run and the
    // replay would drift apart.
    const collision = firstNameCollision(op.childNames, source.children);
    if (collision) {
      fail(
        `recorded child name "${collision}" collides with an existing child of ` +
        `"${op.sourcePath}"`,
      );
    }

    // ── 2. Transform, from the BAKED world matrix ───────────────────────
    // Editor loads run `freezeStaticMatrices()`, after which local TRS is not
    // authoritative — the world matrix is.
    this.viewer.currentModelRoot?.updateMatrixWorld(true);
    const localMatrix = new Matrix4().copy(parent.matrixWorld).invert().multiply(source.matrixWorld);

    // ── 3.-6. Teardown of the WHOLE live subtree, components first ──────
    this._teardownSubtree(source);

    // ── 7. Children off the source, in stable order ─────────────────────
    const authored = source.children.slice();
    for (const child of authored) source.remove(child);

    // ── 8. Source into the trash BEFORE the Group is built — otherwise two
    //       nodes would carry the same name under the same parent.
    const childIndex = parent.children.indexOf(source);
    parent.remove(source);
    this._parkNode(sourceTrashKey(op.id), source, parent, childIndex);

    // ── 9. The Group ────────────────────────────────────────────────────
    const group = new Group();
    group.name = source.name;
    group.visible = source.visible;
    localMatrix.decompose(group.position, group.quaternion, group.scale);
    // Both: the TRS for anything that recomputes, the matrix for the frozen
    // case where nothing will.
    group.matrix.copy(localMatrix);
    group.matrixWorld.copy(source.matrixWorld);
    group.matrixAutoUpdate = source.matrixAutoUpdate;
    group.matrixWorldAutoUpdate = source.matrixWorldAutoUpdate;
    // Deep copy — a shared userData object would mean every later edit on the
    // Group also mutates the original parked in the trash.
    group.userData = cloneUserData(source.userData as Record<string, unknown>);
    parent.add(group);
    spliceChildTo(parent, group, childIndex);

    // ── 10. Children back, then the parts under the verbatim names ──────
    for (const child of authored) group.add(child);
    const materials = Array.isArray(source.material) ? source.material : null;
    const geometryGroups = geometry.groups ?? [];
    const islands = new Set<Object3D>();
    for (let i = 0; i < partitions.length; i++) {
      const partGeometry = payload?.geometries[i] ?? extractSubGeometry(geometry, partitions[i]);
      (partGeometry.userData as Record<string, unknown>)[SEPARATOR_GEOMETRY_MARK] = op.id;
      // Materials are SHARED by reference — never cloned, never disposed. In
      // group mode each part takes the material of its own slot.
      const material = op.mode === 'groups' && materials
        ? materials[Math.min(geometryGroups[i]?.materialIndex ?? 0, materials.length - 1)]
        : (source.material as Material);
      const part = new Mesh(partGeometry, material);
      part.name = op.childNames[i];
      part.castShadow = source.castShadow;
      part.receiveShadow = source.receiveShadow;
      group.add(part);
      islands.add(part);
    }
    const record: SeparateRecord = { islands, alive: { value: true } };
    this._separateRecords.set(op.id, record);

    group.updateMatrixWorld(true);
    this._reviveSubtree(group, record);
  }

  /** Inverse: the Group goes back into the trash, the source mesh comes out. */
  private _separateMeshInverse(op: SeparateMeshOp): void {
    const entry = this._trash.get(sourceTrashKey(op.id));
    const group = this._node(op.sourcePath);
    if (!entry || !group || !group.parent) {
      console.warn(`[asset-edits] separateMesh inverse: nothing to restore for op ${op.id}`);
      return;
    }
    const record = this._separateRecords.get(op.id);
    const islands = record?.islands ?? new Set<Object3D>();

    this._teardownSubtree(group);

    // Everything that is NOT a generated part is an authored child and belongs
    // back on the source — including children added AFTER the split.
    const authored = group.children.filter((child) => !islands.has(child));
    for (const child of authored) group.remove(child);

    const groupParent = group.parent!;
    const groupIndex = groupParent.children.indexOf(group);
    groupParent.remove(group);
    this._parkNode(separateTrashKey(op.id), group, groupParent, groupIndex);

    this._trash.delete(sourceTrashKey(op.id));
    const source = entry.node;
    entry.parent.add(source);
    spliceChildTo(entry.parent, source, entry.childIndex);
    for (const child of authored) source.add(child);
    source.updateMatrixWorld(true);
    this._reviveSubtree(source, null);
  }

  /**
   * Redo: original (live, with children) → trash, Group (trashed) → live.
   *
   * The children are read from the LIVE original rather than from the record,
   * so a child added while the split was undone travels with it.
   */
  private _separateMeshRedo(op: SeparateMeshOp): void {
    const entry = this._trash.get(separateTrashKey(op.id));
    const source = this._node(op.sourcePath);
    if (!entry || !source || !source.parent) {
      console.warn(`[asset-edits] separateMesh redo: nothing to restore for op ${op.id}`);
      return;
    }

    this._teardownSubtree(source);

    const authored = source.children.slice();
    for (const child of authored) source.remove(child);

    const sourceParent = source.parent!;
    const sourceIndex = sourceParent.children.indexOf(source);
    sourceParent.remove(source);
    this._parkNode(sourceTrashKey(op.id), source, sourceParent, sourceIndex);

    this._trash.delete(separateTrashKey(op.id));
    const group = entry.node;
    entry.parent.add(group);
    spliceChildTo(entry.parent, group, entry.childIndex);
    // In FRONT of the parts, which came back from the trash still attached —
    // that is the layout the forward pass produces, and redo has to reproduce
    // the same tree, not merely an equivalent one.
    for (let i = 0; i < authored.length; i++) {
      group.add(authored[i]);
      spliceChildTo(group, authored[i], i);
    }
    group.updateMatrixWorld(true);
    this._reviveSubtree(group, this._separateRecords.get(op.id) ?? null);
  }

  /**
   * Tear a live subtree down in the ONLY order that works: components first —
   * they are unresolvable once the paths are gone — then registry, pick index
   * and group memberships.
   *
   * `disposeComponentsInSubtree` and not `_removeComponentByKey`: the latter
   * deletes `userData.realvirtual[type]`, i.e. exactly the extras that have to
   * survive for undo.
   *
   * Disposing is only HALF the job. The components it kills are also held by the
   * central runtime collections (`viewer.drives`, the transport manager's lists),
   * which nothing else prunes — and `_reviveSubtree` pushes fresh ones in. Without
   * the purge below every separate/undo/redo cycle would leave dead entries behind
   * and the lists would grow monotonically.
   */
  private _teardownSubtree(root: Object3D): void {
    const v = this.viewer;
    // LogicSteps FIRST, while the subtree is still attached: `removeSubtree`
    // finds its roots by walking each step node UP to `root`. `processExtras`
    // deliberately does not rebuild logic, so this is the only thing that drops
    // the steps a torn-down subtree carried.
    v.logicEngine?.removeSubtree(root);
    const registry = v.registry;
    if (registry) {
      const disposed = disposeComponentsInSubtree(registry, root);
      const removedPaths = registry.unregisterSubtree(root);
      this._purgeRuntimeCollections(disposed, removedPaths);
    }
    // MANDATORY: a stale entry would alias a node later built at the same path.
    v.instancePickIndex?.removeSubtree(root);
    if (syncSubtreeGroups(v, root, 'detach')) this._emitGroupsChanged();
  }

  /**
   * Drop the just-unregistered components from the runtime collections that own
   * no back-reference to the registry. Mirrors `removePlacedFromScene()` in the
   * layout planner — the other place a live subtree leaves the scene.
   *
   * Called while the subtree is STILL attached, so `computeNodePath` yields the
   * same paths `unregisterSubtree` just returned.
   */
  private _purgeRuntimeCollections(disposed: Set<unknown>, removedPaths: Set<string>): void {
    if (removedPaths.size === 0) return;
    const v = this.viewer;
    const registry = v.registry;
    if (!registry) return;

    if (v.drives.length > 0) {
      const before = v.drives.length;
      // A drive whose node no longer resolves to a path was just unregistered.
      v.drives = v.drives.filter((d) => registry.getPathForNode(d.node) !== null);
      // The removed drives must stop participating in the grouped BVH.
      if (v.drives.length !== before) v.rebuildGroupedBvh();
    }

    const tm = v.transportManager;
    if (!tm) return;
    const isRemoved = (c: { node: Object3D }): boolean =>
      removedPaths.has(NodeRegistry.computeNodePath(c.node));
    tm.sensors = tm.sensors.filter((s) => !isRemoved(s));
    tm.surfaces = tm.surfaces.filter((s) => !isRemoved(s));
    // Sources hold ghost materials; dispose the ones the sweep above missed.
    for (const s of tm.sources) {
      if (isRemoved(s) && !disposed.has(s)) s.dispose?.();
    }
    tm.sources = tm.sources.filter((s) => !isRemoved(s));
    tm.sinks = tm.sinks.filter((s) => !isRemoved(s));
    tm.grips = tm.grips.filter((s) => !isRemoved(s));
    tm.gripTargets = tm.gripTargets.filter((s) => !isRemoved(s));
    // Surfaces changed — invalidate the spatial index + dead-end adjacency cache.
    tm.notifyTopologyChanged?.();
  }

  /** Bring a freshly (re)attached subtree back to life — the mirror of {@link _teardownSubtree}.
   *  `record` is only read for its BVH liveness gate, so separator and merger records
   *  both fit. */
  private _reviveSubtree(root: Object3D, record: { alive: { value: boolean } } | null): void {
    this._registerSubtree(root);
    this._rebuildComponents(root);
    // After the components: `buildStep` resolves its targets through the
    // registry, so the steps must be built on a fully populated subtree.
    this._rebuildLogic(root);
    if (syncSubtreeGroups(this.viewer, root, 'attach')) this._emitGroupsChanged();
    this.viewer.instancePickIndex?.addSubtree(root);
    if (this.viewer.instancePickIndex) {
      // The alive predicate is what `_loadGeneration` alone cannot express: undo
      // and the trash flush do not start a new load, but they do make these
      // geometries unwritable.
      const alive = record?.alive;
      this.viewer.buildMeshBvhsAsync(root, alive ? () => alive.value : undefined);
    }
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markShadowsDirty();
    this.viewer.markRenderDirty();
  }

  /**
   * Reconstruct the rv_extras components of a subtree that was just re-attached.
   *
   * Skipped when the runtime systems are absent (minimal test viewers, headless
   * documents) — exactly as component authoring does via `_runtimeDeps()`.
   */
  private _rebuildComponents(root: Object3D): void {
    const v = this.viewer;
    if (!v.registry || !v.signalStore || !v.transportManager) return;
    try {
      const result = processExtras(
        root, v.registry, v.signalStore, v.transportManager, v.scene,
        v.gizmoManager, v, v.errorStore, v.instructionStore,
        { logicRunState: v.logicRunState },
        v.outlineManager, v.lampManager, v.energyChainManager,
      );
      // The returns are live runtime state, not diagnostics — dropping them
      // would leave drives unsimulated and gated logic never started. The
      // matching removals happen in `_teardownSubtree`, so these pushes replace
      // rather than accumulate.
      if (result.deferredLogic) v.registerDeferredLogic(result.deferredLogic);
      if (result.drives.length > 0) v.drives.push(...result.drives);
      // `signalsRegistered` / `componentsCreated` are counts, not handles: the
      // signals went into the SignalStore and the components into the registry
      // during the call. Nothing to re-file, so they are only reported.
      debug(
        'loader',
        `subtree rebuild: ${result.componentsCreated} components, ` +
        `${result.signalsRegistered} signals, ${result.drives.length} drives`,
      );
      v.transportManager.notifyTopologyChanged?.();
    } catch (e) {
      // Shared by separateMesh and mergeMesh — both rebuild a re-attached subtree.
      console.warn('[asset-edits] subtree component rebuild failed:', e);
    }
  }

  /**
   * Re-merge the LogicSteps of a re-attached subtree — the mirror of the
   * `logicEngine.removeSubtree()` in {@link _teardownSubtree}.
   *
   * `processExtras` explicitly does NOT rebuild logic (its doc comment puts the
   * duty on the caller), so without this a source mesh whose children carried
   * LogicSteps lost their execution on the first separate and never got it back.
   *
   * No lazy engine creation, unlike the layout planner's `mergePlacedLogic`: an
   * engine that did not exist held no steps to tear down either, and building one
   * here would START logic the editor never had running.
   */
  private _rebuildLogic(root: Object3D): void {
    const v = this.viewer;
    if (!v.logicEngine || !v.registry || !v.signalStore) return;
    v.logicEngine.addSubtree(root, v.registry, v.signalStore);
  }

  /** Trash bookkeeping only — the caller has already detached and unregistered. */
  private _parkNode(key: string, node: Object3D, parent: Object3D, childIndex: number): void {
    this._ensureTrashGroup().add(node);
    this._trash.set(key, { node, parent, childIndex });
    this.viewer.markShadowsDirty();
  }

  /** Consume a preview payload, but only when it still describes THIS geometry. */
  private _takeSeparatePayload(opId: string, geometry: BufferGeometry): SeparateMeshPayload | null {
    const payload = this._separatePayloads.get(opId);
    if (!payload) return null;
    this._separatePayloads.delete(opId);
    const vertexCount = geometry.getAttribute('position')?.count ?? -1;
    if (payload.sourceGeometry !== geometry || payload.vertexCount !== vertexCount) {
      console.warn(
        `[asset-edits] separateMesh: the source geometry changed while the dialog was open ` +
        `(op ${opId}) — recomputing`,
      );
      return null;
    }
    // `geometries: []` is the legitimate analyze-only payload (a caller that
    // resolved the partition for the child names but never ran the extract);
    // the parts are then built here. Any other mismatch is corrupt — recompute.
    if (payload.geometries.length !== 0 && payload.geometries.length !== payload.partitions.length) {
      return null;
    }
    return payload;
  }

  /** Dispose the part geometries of a trashed subtree (exclusive ownership only). */
  private _disposeSeparatorGeometries(root: Object3D): void {
    root.traverse((node) => {
      const geometry = (node as Mesh).geometry as BufferGeometry | undefined;
      const opId = (geometry?.userData as Record<string, unknown> | undefined)?.[SEPARATOR_GEOMETRY_MARK];
      if (!geometry || typeof opId !== 'string') return;
      const record = this._separateRecords.get(opId);
      if (record) record.alive.value = false;
      try {
        geometry.disposeBoundsTree?.();
        geometry.dispose();
      } catch (e) {
        console.warn('[asset-edits] separateMesh: part geometry disposal failed:', e);
      }
    });
  }

  // ─── mergeMesh ────────────────────────────────────────────────────────

  /**
   * Collapse the subtree of one node into one mesh per material AND per Group
   * (plan-372 §2.6) — the mirror image of {@link _separateMeshForward}.
   *
   * The separator parks ONE node and builds many; the merger parks many and builds few.
   * Two things make this harder than the mirror suggests, and both are load-bearing:
   *
   * - **Owner zones.** Geometry below an anchor (`Drive`, `Kinematic`, `CADLink`,
   *   `JTData`) merges into an output that stays a CHILD OF THAT ANCHOR. Hanging every
   *   output under the new root mesh would silently stop the anchor from moving its own
   *   geometry — an asset that looks right and is broken.
   * - **Bit-exact undo.** Every node that changes parent is recorded with its ORIGINAL
   *   parent object, sibling index, depth and local matrix, captured in one pass BEFORE
   *   the first detachment (a later capture would read indices that earlier removals
   *   already shifted).
   */
  private _mergeMeshForward(op: MergeMeshOp): void {
    // Redo after an undo: the merged result is parked and the original is live again.
    if (this._trash.has(mergedTrashKey(op.id)) && this._mergeRecords.has(op.id)) {
      return this._mergeMeshRedo(op);
    }

    // Every bail-out is a DIVERGENCE, never a no-op — see MergeMeshUnappliedError.
    const fail: (reason: string) => never = (reason) => {
      throw new MergeMeshUnappliedError(op.rootPath, reason, op.id);
    };

    const root = this._node(op.rootPath);
    if (!root) fail(`"${op.rootPath}" is not in the tree`);
    const rootParent = root.parent;
    if (!rootParent) fail(`"${op.rootPath}" has no parent`);

    // ── 1. Sources, validated against their recorded signatures ─────────
    const sources: Mesh[] = [];
    for (let i = 0; i < op.sourcePaths.length; i++) {
      const path = op.sourcePaths[i];
      const node = this._node(path) as Mesh | null;
      if (!node || (node as { isMesh?: boolean }).isMesh !== true) {
        fail(`source "${path}" is not a live mesh`);
      }
      if (!isDescendantOf(node, root)) {
        fail(`source "${path}" is no longer inside "${op.rootPath}"`);
      }
      const shape = unsupportedMeshShapeReason(node);
      if (shape) fail(`source "${path}": ${shape}`);
      if (Array.isArray(node.material)) fail(`source "${path}" became multi-material`);
      const signature = op.sourceSignatures[i];
      if (signature) {
        const geometry = node.geometry as BufferGeometry;
        const vertexCount = geometry.getAttribute('position')?.count ?? -1;
        const triCount = triangleCount(geometry);
        if (vertexCount !== signature.vertexCount || triCount !== signature.triangleCount) {
          fail(
            `source "${path}" diverged — recorded ${signature.vertexCount} vertices / ` +
            `${signature.triangleCount} triangles, found ${vertexCount} / ${triCount}`,
          );
        }
        const materialKey = materialFingerprint(node.material as Material);
        if (materialKey !== signature.materialKey) {
          fail(`source "${path}" no longer carries the recorded material`);
        }
      }
      sources.push(node);
    }

    // ── 2. Surviving nodes and the owner zones they belong to ───────────
    const keptByNode = new Map<Object3D, MergeKeptNodeSpec>();
    const anchorByPath = new Map<string, Object3D>();
    for (const spec of op.kept) {
      const node = this._node(spec.path);
      if (!node) fail(`kept node "${spec.path}" is not in the tree`);
      if (!isDescendantOf(node, root)) {
        fail(`kept node "${spec.path}" is no longer inside "${op.rootPath}"`);
      }
      keptByNode.set(node, spec);
      if (spec.role === 'anchor') anchorByPath.set(spec.path, node);
    }

    const rootSpecs = op.outputs.filter((o) => o.role === 'root');
    if (rootSpecs.length !== 1) {
      fail(`expected exactly one root output, found ${rootSpecs.length}`);
    }
    for (const spec of op.outputs) {
      if (spec.ownerPath === op.rootPath) continue;
      if (!anchorByPath.has(spec.ownerPath)) {
        fail(`output owner "${spec.ownerPath}" is not a live anchor`);
      }
    }
    const collision = firstOutputNameCollision(op, keptByNode);
    if (collision) fail(collision);

    // ── 3. World matrices, captured BEFORE anything moves ───────────────
    // Editor loads run `freezeStaticMatrices()`, after which local TRS is not
    // authoritative — the world matrix is.
    this.viewer.currentModelRoot?.updateMatrixWorld(true);
    const rootWorld = root.matrixWorld.clone();
    const rootLocal = new Matrix4().copy(rootParent.matrixWorld).invert().multiply(rootWorld);
    const sourceWorld = sources.map((s) => s.matrixWorld.clone());
    const ownerWorld = new Map<string, Matrix4>([[op.rootPath, rootWorld]]);
    for (const [path, node] of anchorByPath) ownerWorld.set(path, node.matrixWorld.clone());

    // ── 4. The merged geometries — from the preview, or built here ──────
    const payload = this._takeMergePayload(op.id, sources);
    const geometries: BufferGeometry[] = [];
    try {
      for (let i = 0; i < op.outputs.length; i++) {
        const spec = op.outputs[i];
        const ready = payload?.geometries[i] ?? null;
        if (ready) { geometries.push(ready); continue; }
        if (spec.sourceIndices.length === 0) {
          // The root zone carries no geometry of its own — the replacement is the
          // geometry-less carrier that keeps the result form "one same-named mesh".
          geometries.push(new BufferGeometry());
          continue;
        }
        geometries.push(buildMergedGeometry(
          spec.sourceIndices.map((si) => ({
            geometry: sources[si].geometry as BufferGeometry,
            worldMatrix: sourceWorld[si],
          })),
          ownerWorld.get(spec.ownerPath)!,
        ));
      }
    } catch (e) {
      // Everything built so far AND every pre-built geometry this loop never reached:
      // the op will not run, so nothing else will ever own them.
      const orphaned = new Set<BufferGeometry>(geometries);
      for (const geometry of payload?.geometries ?? []) if (geometry) orphaned.add(geometry);
      for (const geometry of orphaned) geometry.dispose();
      fail(e instanceof Error ? e.message : String(e));
    }

    // ── 5. Teardown of the WHOLE live subtree, components first ─────────
    this._teardownSubtree(root);

    // ── 6. One capture pass, then detach deepest-first ──────────────────
    const sourceSet = new Set<Object3D>(sources);
    const moved: MergeMovedNode[] = [];
    const capture = (node: Object3D, depth: number): void => {
      if (node !== root) {
        const spec = keptByNode.get(node);
        const parent = node.parent;
        if (spec && parent) {
          moved.push({
            node, parent, childIndex: parent.children.indexOf(node), depth,
            role: spec.role, targetParent: null, prevMatrix: node.matrix.clone(),
          });
          // A protected node exempts its WHOLE subtree — never descend into it.
          if (spec.role === 'protected') return;
        } else if (sourceSet.has(node) && parent) {
          moved.push({
            node, parent, childIndex: parent.children.indexOf(node), depth,
            role: 'source', targetParent: null, prevMatrix: node.matrix.clone(),
          });
        }
      }
      for (const child of node.children.slice()) capture(child, depth + 1);
    };
    capture(root, 0);
    moved.sort((a, b) => a.depth - b.depth || a.childIndex - b.childIndex);
    // Deepest first: an anchor must be free of its own consumed meshes before it moves.
    for (let i = moved.length - 1; i >= 0; i--) moved[i].parent.remove(moved[i].node);

    // ── 7. The original subtree into the trash, sources with it ─────────
    const rootIndex = rootParent.children.indexOf(root);
    rootParent.remove(root);
    this._parkNode(mergeSourceTrashKey(op.id), root, rootParent, rootIndex);
    for (const source of sources) root.add(source);
    const parked = new Set<Object3D>();
    root.traverse((n) => parked.add(n));

    // ── 8. Build the outputs; the 'root' one REPLACES the root ──────────
    const generated = new Set<Object3D>();
    const outputs: MergeOutputRecord[] = [];
    const deferred: { mesh: Mesh; spec: MergeOutputSpec }[] = [];
    let rootOutput: Mesh | null = null;
    for (let i = 0; i < op.outputs.length; i++) {
      const spec = op.outputs[i];
      const geometry = geometries[i];
      (geometry.userData as Record<string, unknown>)[MERGER_GEOMETRY_MARK] = op.id;
      // Materials are SHARED by reference — never cloned, never disposed.
      const material = spec.sourceIndices.length > 0
        ? (sources[spec.sourceIndices[0]].material as Material)
        : null;
      const mesh = material ? new Mesh(geometry, material) : new Mesh(geometry);
      mesh.name = spec.name;
      generated.add(mesh);

      if (spec.role === 'root') {
        applyRootParity(mesh, root, rootLocal, rootWorld);
        applyGroupExtras(mesh, spec.groupNames);
        rootParent.add(mesh);
        spliceChildTo(rootParent, mesh, rootIndex);
        rootOutput = mesh;
        outputs.push({ node: mesh, targetParent: null, originOwner: root });
      } else {
        const owner = spec.ownerPath === op.rootPath ? root : anchorByPath.get(spec.ownerPath)!;
        mesh.castShadow = owner.castShadow;
        mesh.receiveShadow = owner.receiveShadow;
        applyGroupExtras(mesh, spec.groupNames);
        deferred.push({ mesh, spec });
      }
    }

    // ── 9. Survivors home, shallowest first (an anchor before its children) ──
    for (const record of moved) {
      if (record.role === 'source') continue;
      const spec = keptByNode.get(record.node)!;
      const target = spec.ownerPath === op.rootPath
        ? rootOutput!
        : anchorByPath.get(spec.ownerPath)!;
      record.targetParent = target;
      target.add(record.node);
      rebaseLocalMatrix(record.node, target);
    }

    // ── 10. The remaining outputs, after their owners are in place ──────
    for (const { mesh, spec } of deferred) {
      const target = spec.ownerPath === op.rootPath
        ? rootOutput!
        : anchorByPath.get(spec.ownerPath)!;
      target.add(mesh);
      outputs.push({
        node: mesh,
        targetParent: target,
        originOwner: spec.ownerPath === op.rootPath ? root : anchorByPath.get(spec.ownerPath)!,
      });
    }

    const record: MergeRecord = {
      moved, outputs, rootOutput: rootOutput!, generated, parked,
      outputGeometries: geometries, alive: { value: true },
    };
    this._mergeRecords.set(op.id, record);

    rootOutput!.updateMatrixWorld(true);
    this._reviveSubtree(rootOutput!, record);
  }

  /** Inverse: the merged result goes into the trash, the original subtree comes back. */
  private _mergeMeshInverse(op: MergeMeshOp): void {
    const record = this._mergeRecords.get(op.id);
    const entry = this._trash.get(mergeSourceTrashKey(op.id));
    const rootOutput = record?.rootOutput ?? null;
    if (!record || !entry || !rootOutput || !rootOutput.parent) {
      console.warn(`[asset-edits] mergeMesh inverse: nothing to restore for op ${op.id}`);
      return;
    }

    this._teardownSubtree(rootOutput);

    // Anything under an output that the merge did NOT generate and that is not a
    // recorded moved node was authored AFTER the merge — it goes to the origin owner
    // of that output rather than into the trash.
    const movedNodes = new Set(record.moved.map((m) => m.node));
    const late: { node: Object3D; home: Object3D }[] = [];
    for (const out of record.outputs) {
      for (const child of out.node.children.slice()) {
        if (record.generated.has(child) || movedNodes.has(child)) continue;
        out.node.remove(child);
        late.push({ node: child, home: out.originOwner });
      }
    }

    for (let i = record.moved.length - 1; i >= 0; i--) {
      record.moved[i].node.parent?.remove(record.moved[i].node);
    }
    // Child outputs collapse under the root output so the result parks as ONE subtree.
    for (const out of record.outputs) {
      if (!out.targetParent) continue;
      out.node.parent?.remove(out.node);
      rootOutput.add(out.node);
    }

    const outParent = rootOutput.parent!;
    const outIndex = outParent.children.indexOf(rootOutput);
    outParent.remove(rootOutput);
    this._parkNode(mergedTrashKey(op.id), rootOutput, outParent, outIndex);

    this._trash.delete(mergeSourceTrashKey(op.id));
    const root = entry.node;
    entry.parent.add(root);
    spliceChildTo(entry.parent, root, entry.childIndex);
    // Shallowest first, ascending sibling index — that reconstructs each original
    // children array exactly, not merely an equivalent one.
    for (const m of record.moved) {
      m.parent.add(m.node);
      spliceChildTo(m.parent, m.node, m.childIndex);
      restoreLocalMatrix(m.node, m.prevMatrix);
    }
    for (const l of late) l.home.add(l.node);

    root.updateMatrixWorld(true);
    this._reviveSubtree(root, null);
  }

  /**
   * Redo: original (live) → trash, merged result (trashed) → live.
   *
   * Reproduces the FORWARD tree, not merely an equivalent one: the child outputs are
   * pulled off the root output first so that survivors and outputs land back in the same
   * order the forward pass produced.
   */
  private _mergeMeshRedo(op: MergeMeshOp): void {
    const record = this._mergeRecords.get(op.id)!;
    const entry = this._trash.get(mergedTrashKey(op.id))!;
    const root = this._node(op.rootPath);
    if (!root || !root.parent) {
      console.warn(`[asset-edits] mergeMesh redo: nothing to restore for op ${op.id}`);
      return;
    }

    this._teardownSubtree(root);

    for (let i = record.moved.length - 1; i >= 0; i--) {
      record.moved[i].node.parent?.remove(record.moved[i].node);
    }
    // Anything added under the root WHILE the merge was undone is authored work — it
    // must not disappear into the trash with the dissolved subtree.
    const late: Object3D[] = [];
    for (const child of root.children.slice()) {
      if (record.parked.has(child)) continue;
      root.remove(child);
      late.push(child);
    }

    const rootParent = root.parent!;
    const rootIndex = rootParent.children.indexOf(root);
    rootParent.remove(root);
    this._parkNode(mergeSourceTrashKey(op.id), root, rootParent, rootIndex);
    for (const m of record.moved) if (m.role === 'source') root.add(m.node);

    this._trash.delete(mergedTrashKey(op.id));
    const rootOutput = record.rootOutput;
    for (const out of record.outputs) {
      if (out.targetParent) out.node.parent?.remove(out.node);
    }
    entry.parent.add(rootOutput);
    spliceChildTo(entry.parent, rootOutput, entry.childIndex);

    for (const m of record.moved) {
      if (m.role === 'source' || !m.targetParent) continue;
      m.targetParent.add(m.node);
      rebaseLocalMatrix(m.node, m.targetParent);
    }
    for (const out of record.outputs) {
      if (out.targetParent) out.targetParent.add(out.node);
    }
    for (const node of late) rootOutput.add(node);

    rootOutput.updateMatrixWorld(true);
    this._reviveSubtree(rootOutput, record);
  }

  /** Consume a merge payload, but only when it still describes THESE geometries. */
  private _takeMergePayload(opId: string, sources: Mesh[]): MergeMeshPayload | null {
    const payload = this._mergePayloads.get(opId);
    if (!payload) return null;
    this._mergePayloads.delete(opId);

    let stale = payload.sources.length !== sources.length;
    for (let i = 0; !stale && i < sources.length; i++) {
      const geometry = sources[i].geometry as BufferGeometry;
      const vertexCount = geometry.getAttribute('position')?.count ?? -1;
      stale = payload.sources[i].geometry !== geometry
        || payload.sources[i].vertexCount !== vertexCount;
    }
    if (stale) {
      console.warn(
        `[asset-edits] mergeMesh: the subtree changed while the dialog was open ` +
        `(op ${opId}) — recomputing`,
      );
      for (const geometry of payload.geometries) geometry?.dispose();
      return null;
    }
    return payload;
  }

  /** Dispose the OUTPUT geometries of a trashed subtree — never the parked originals. */
  private _disposeMergerGeometries(root: Object3D): void {
    root.traverse((node) => {
      const geometry = (node as Mesh).geometry as BufferGeometry | undefined;
      const opId = (geometry?.userData as Record<string, unknown> | undefined)?.[MERGER_GEOMETRY_MARK];
      if (!geometry || typeof opId !== 'string') return;
      const record = this._mergeRecords.get(opId);
      if (record) record.alive.value = false;
      try {
        // `disposeBoundsTree()` FIRST: the tree holds its own typed arrays, and
        // three-mesh-bvh patches it onto the prototype — disposing the geometry alone
        // would strand it.
        geometry.disposeBoundsTree?.();
        geometry.dispose();
      } catch (e) {
        console.warn('[asset-edits] mergeMesh: output geometry disposal failed:', e);
      }
    });
  }

  // ─── create / reparent ────────────────────────────────────────────────

  private _createNodeForward(op: CreateNodeOp): void {
    // Redo after an undo: the subtree is parked in the trash — re-attach it
    // (keeps components/children that were added between create and undo).
    if (this._trash.has(`create:${op.id}`)) {
      return this._restoreFromTrash(`create:${op.id}`);
    }
    const parentPath = dirname(op.nodePath);
    const parent = parentPath ? this._node(parentPath) : this.viewer.currentModelRoot;
    if (!parent) {
      console.warn(`[asset-edits] createNode: parent "${parentPath}" not found (op ${op.id})`);
      return;
    }
    const node = new Object3D();
    node.name = leaf(op.nodePath);
    // Runtime-only marker (stripped by sanitizeUserDataForExport on save).
    (node.userData as Record<string, unknown>)['__rvAdded'] = true;
    parent.add(node);
    if (op.index !== undefined) {
      const arr = parent.children;
      arr.splice(arr.indexOf(node), 1);
      arr.splice(Math.min(op.index, arr.length), 0, node);
    }
    applyTransform(node, op.transform);
    node.updateMatrixWorld(true);
    this.viewer.registry?.registerNode(op.nodePath, node);
    // A fresh empty node carries no meshes yet, but children added later
    // (reparent) index via their own ops; keep membership consistent anyway.
    this.viewer.instancePickIndex?.addSubtree(node);
    this.viewer.markRenderDirty();
  }

  /** Move a subtree under a new parent at a given sibling index with the
   *  recorded local TRS. Shared by reparentNode forward AND inverse.
   *
   *  THROWS on an unresolvable move (missing node, missing parent, cycle). These
   *  used to warn and return, which let `AssetDocument` record a move that never
   *  happened — and inside a bulk import that means a group whose contents the
   *  op log claims are elsewhere (plan-359 Phase 3). */
  private _reparent(
    nodePath: string, newParentPath: string, transform: NodeTransform, index?: number,
  ): void {
    const node = this._node(nodePath);
    if (!node) throw new Error(`reparent: node "${nodePath}" not found`);
    const newParent = newParentPath ? this._node(newParentPath) : this.viewer.currentModelRoot;
    if (!newParent) throw new Error(`reparent: new parent "${newParentPath}" not found`);
    // Cycle guard — a node must never become a descendant of itself.
    for (let p: Object3D | null = newParent; p; p = p.parent) {
      if (p === node) {
        throw new Error(`reparent: "${nodePath}" is an ancestor of "${newParentPath}"`);
      }
    }
    newParent.add(node);
    if (index !== undefined) {
      const arr = newParent.children;
      arr.splice(arr.indexOf(node), 1);
      arr.splice(Math.min(index, arr.length), 0, node);
    }
    applyTransform(node, transform);
    this._refreshWorldMatrix(node);
    // Re-key registered paths under the moved subtree AND carry every path-based
    // reference (signal bindings, serialized ref paths) across the move.
    this._remapSubtreePaths(node);
    // Cached pick paths are stale — re-resolve lazily on the next hit.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markShadowsDirty();
  }

  /** Re-key every registered path under a moved subtree and carry the signal
   *  store's path registrations across the move, so a signal owned by a dragged
   *  node still resolves under its new path (name↔path stay consistent).
   *
   *  Unlike the loader's Phase-8c handling this does NOT register the old paths
   *  as aliases: at load time serialized references still point at the authoring
   *  hierarchy Phase-8b just changed, but in the interactive editor a moved
   *  node's old path is genuinely gone — keeping it resolvable would shadow a
   *  node later created at that path (and `_rename`, which re-keys paths the
   *  same way, aliases nothing either). */
  private _remapSubtreePaths(node: Object3D): void {
    const registry = this.viewer.registry;
    if (!registry) return;
    const { remap } = registry.recomputePathsForSubtrees([node]);
    if (remap.size === 0) return;
    this.viewer.signalStore?.remapPaths(remap);
  }

  // ─── visibility ───────────────────────────────────────────────────────

  /** Show/hide a node. The authored state is mirrored into
   *  `userData.realvirtual.Hidden` because glTF has no node visibility — the
   *  scene loader re-applies the flag on GLB load, and the raycast BVH keys
   *  pick-exclusion on it (never on `.visible`, which the static merge uses
   *  for its own bookkeeping). */
  private _setNodeVisible(nodePath: string, visible: boolean): void {
    const node = this._node(nodePath);
    if (!node) return;
    node.visible = visible;
    // Clone-on-write so memoized inspector/hierarchy readers see a new object.
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    if (visible) delete rv['Hidden'];
    else rv['Hidden'] = true;
    ud['realvirtual'] = rv;
    this.viewer.markShadowsDirty();
    this.viewer.markRenderDirty();
  }

  // ─── add/remove component ─────────────────────────────────────────────

  private _addComponent(op: AddComponentOp): void {
    this._addComponentWithFields(op.nodePath, op.componentType, op.fields);
  }

  private _addComponentWithFields(
    nodePath: string, componentType: string, fields: Record<string, unknown>,
  ): void {
    const node = this._node(nodePath);
    if (!node) return;
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    rv[componentType] = { ...fields };
    ud['realvirtual'] = rv;

    const deps = this._runtimeDeps();
    if (deps) constructComponentOnNode(deps, node, componentType, { ...fields });
    // Components change hoverable/CADLink/Drive resolution — re-resolve lazily.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markRenderDirty();
  }

  private _removeComponent(op: RemoveComponentOp): void {
    this._removeComponentByKey(op.nodePath, op.componentType);
  }

  private _removeComponentByKey(nodePath: string, componentType: string): void {
    const node = this._node(nodePath);
    if (!node) return;
    // Dispose the live instance and unregister it.
    const comps = this.viewer.registry?.getComponentsAt(nodePath) ?? [];
    const entry = comps.find(([type]) => type === componentType);
    if (entry) {
      const inst = entry[1] as { dispose?: () => void };
      try { inst.dispose?.(); } catch (e) { console.warn(`[asset-edits] dispose failed for ${componentType}:`, e); }
      this.viewer.registry?.unregisterComponent(componentType, nodePath);
    }
    // Drop the userData entry (clone-on-write for inspector memoisation).
    const ud = node.userData as Record<string, unknown>;
    const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };
    delete rv[componentType];
    ud['realvirtual'] = rv;
    // Components change hoverable/CADLink/Drive resolution — re-resolve lazily.
    this.viewer.instancePickIndex?.bumpResolutionEpoch();
    this.viewer.markRenderDirty();
  }

  // ─── field ops ────────────────────────────────────────────────────────

  private _setField(op: AssetSetFieldOp): void {
    writeUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName, op.value);
    reapplySchemaForComponent(this.viewer, op.nodePath, op.componentType);
    this.viewer.markRenderDirty();
  }

  private _unsetField(op: AssetUnsetFieldOp): void {
    deleteUserDataField(this.viewer, op.nodePath, op.componentType, op.fieldName);
    reapplySchemaForComponent(this.viewer, op.nodePath, op.componentType);
    this.viewer.markRenderDirty();
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private _node(path: string): Object3D | null {
    return this.viewer.registry?.getNode(path) ?? null;
  }

  private _ensureTrashGroup(): Group {
    if (!this._trashGroup) {
      this._trashGroup = new Group();
      this._trashGroup.name = TRASH_GROUP_NAME;
      this._trashGroup.visible = false;
      this.viewer.scene.add(this._trashGroup);
    }
    return this._trashGroup;
  }

  private _registerSubtree(root: Object3D): void {
    const registry = this.viewer.registry;
    if (!registry) return;
    root.traverse((child) => {
      registry.registerNode(NodeRegistry.computeNodePath(child), child);
    });
  }

  private _runtimeDeps(): RuntimeNodeDeps | null {
    const v = this.viewer;
    if (!v.registry || !v.signalStore || !v.transportManager) return null;
    return {
      registry: v.registry,
      signalStore: v.signalStore,
      scene: v.scene,
      transportManager: v.transportManager,
      gizmoManager: v.gizmoManager,
      lampManager: v.lampManager,
      errorStore: v.errorStore,
      instructionStore: v.instructionStore,
    };
  }
}

// ─── module helpers ───────────────────────────────────────────────────

/** A composite that only moves and renames nodes — the shape `reparentNodesBatch`
 *  produces, and the only one whose world-matrix refresh may be batched. */
function isPureMoveComposite(op: AssetOp): boolean {
  return op.kind === 'composite'
    && op.ops.length > 1
    && op.ops.every((child) => child.kind === 'reparentNode' || child.kind === 'renameNode');
}

/** Move an already-added child to a specific sibling slot (`add()` appends). */
function spliceChildTo(parent: Object3D, child: Object3D, index: number): void {
  const arr = parent.children;
  const at = arr.indexOf(child);
  if (at < 0 || index < 0) return;
  arr.splice(at, 1);
  arr.splice(Math.min(index, arr.length), 0, child);
}

/** True when `node` sits inside `root`'s subtree (root itself counts). */
function isDescendantOf(node: Object3D, root: Object3D): boolean {
  for (let p: Object3D | null = node; p; p = p.parent) if (p === root) return true;
  return false;
}

/**
 * The first recorded output name that would collide under its owner, or `null`.
 *
 * Names are applied VERBATIM on replay (same contract as `separateMesh.childNames`), so a
 * collision has to be reported rather than silently renamed — a rename would shift the
 * paths every later op in the draft refers to.
 */
function firstOutputNameCollision(
  op: MergeMeshOp,
  keptByNode: Map<Object3D, MergeKeptNodeSpec>,
): string | null {
  const takenByOwner = new Map<string, Set<string>>();
  for (const [node, spec] of keptByNode) {
    let taken = takenByOwner.get(spec.ownerPath);
    if (!taken) { taken = new Set<string>(); takenByOwner.set(spec.ownerPath, taken); }
    taken.add(node.name);
  }
  for (const spec of op.outputs) {
    // The 'root' output's name lives under the root's PARENT (it replaces the root), so
    // it never competes with the kept children that end up beneath it.
    if (spec.role === 'root') continue;
    let taken = takenByOwner.get(spec.ownerPath);
    if (!taken) { taken = new Set<string>(); takenByOwner.set(spec.ownerPath, taken); }
    if (taken.has(spec.name)) {
      return `recorded output name "${spec.name}" collides under "${spec.ownerPath}"`;
    }
    taken.add(spec.name);
  }
  return null;
}

/**
 * Property parity for the mesh that REPLACES the merged subtree root (plan-372 §2.6
 * step 8). Anything missing here is a property the asset silently loses on a merge.
 */
function applyRootParity(mesh: Mesh, root: Object3D, localMatrix: Matrix4, worldMatrix: Matrix4): void {
  localMatrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  // Both: the TRS for anything that recomputes, the matrix for the frozen case where
  // nothing will.
  mesh.matrix.copy(localMatrix);
  mesh.matrixWorld.copy(worldMatrix);
  mesh.matrixAutoUpdate = root.matrixAutoUpdate;
  mesh.matrixWorldAutoUpdate = root.matrixWorldAutoUpdate;
  mesh.visible = root.visible;
  mesh.layers.mask = root.layers.mask;
  mesh.castShadow = root.castShadow;
  mesh.receiveShadow = root.receiveShadow;
  mesh.renderOrder = root.renderOrder;
  mesh.frustumCulled = root.frustumCulled;
  // Deep copy — a shared userData object would mean every later edit on the output also
  // mutates the original parked in the trash.
  mesh.userData = cloneUserData(root.userData as Record<string, unknown>);
}

/**
 * Ensure the node carries a `Group`/`Group_N` extra for every resolved group name.
 *
 * `rv-group-sync` derives membership EXCLUSIVELY from `userData.realvirtual.Group*`, so
 * an output without these extras silently drops out of its groups — no overlay, no
 * visibility switching, and the loss survives the GLB round-trip.
 */
function applyGroupExtras(node: Object3D, groupNames: string[]): void {
  if (groupNames.length === 0) return;
  const ud = node.userData as Record<string, unknown>;
  const rv = { ...(ud['realvirtual'] as Record<string, unknown> | undefined) };

  const present = new Set<string>();
  for (const key of Object.keys(rv)) {
    if (!GROUP_KEY_RE.test(key)) continue;
    const name = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
    if (typeof name === 'string') present.add(name);
  }
  for (const name of groupNames) {
    if (present.has(name)) continue;
    let key = 'Group';
    for (let n = 1; key in rv; n++) key = `Group_${n}`;
    rv[key] = { GroupName: name };
    present.add(name);
  }
  ud['realvirtual'] = rv;
}

/** Re-express a node's local TRS under a new parent so its WORLD pose is unchanged. */
function rebaseLocalMatrix(node: Object3D, target: Object3D): void {
  const local = new Matrix4().copy(target.matrixWorld).invert().multiply(node.matrixWorld);
  local.decompose(node.position, node.quaternion, node.scale);
  node.matrix.copy(local);
}

/** Put a recorded local matrix back, TRS and matrix alike (frozen nodes need both). */
function restoreLocalMatrix(node: Object3D, matrix: Matrix4): void {
  matrix.decompose(node.position, node.quaternion, node.scale);
  node.matrix.copy(matrix);
}

/** First generated name that collides with an existing sibling, or with itself. */
function firstNameCollision(names: readonly string[], siblings: readonly Object3D[]): string | null {
  const taken = new Set(siblings.map((c) => c.name));
  for (const name of names) {
    if (taken.has(name)) return name;
    taken.add(name);
  }
  return null;
}

/**
 * Deep copy of a node's `userData`.
 *
 * JSON round-trip on purpose (same as `deepCloneJSON`): it drops exactly the
 * things that must not be copied — the non-enumerable `_rvComponentInstance`
 * back-reference and any function — while duplicating `realvirtual` deeply, so
 * the Group and the parked original never share a mutable object.
 */
function cloneUserData(userData: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(userData ?? {})) as Record<string, unknown>;
  } catch {
    // A non-serializable extra (should not happen — rv_extras are JSON) must not
    // cost the whole split; fall back to a shallow copy with a cloned rv block.
    const shallow: Record<string, unknown> = { ...userData };
    const rv = shallow['realvirtual'];
    if (rv && typeof rv === 'object') shallow['realvirtual'] = { ...(rv as Record<string, unknown>) };
    return shallow;
  }
}

function applyTransform(node: Object3D, t: NodeTransform): void {
  node.position.fromArray(t.position);
  node.quaternion.fromArray(t.quaternion);
  node.scale.fromArray(t.scale);
  node.updateMatrix();
}

function leaf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function replaceLeaf(path: string, newLeaf: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? newLeaf : path.slice(0, idx + 1) + newLeaf;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

// Always join with '/' so the result matches NodeRegistry.computeNodePath —
// including under an UNNAMED asset root, where the parent path is '' and the
// child path is '/child' (leading empty segment). Dropping the slash for empty
// parent paths would desync the reparent inverse from the registry key. See the
// matching note on childPath/joinPaths in rv-asset-document.ts.
function joinPath(parentPath: string, childName: string): string {
  return `${parentPath}/${childName}`;
}
