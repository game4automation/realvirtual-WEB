// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-document — the op-log document behind the asset editor.
 *
 * Owns the ordered `AssetOp[]` history with undo/redo, coalescing,
 * transactions, dirty tracking and debounced IndexedDB draft autosave.
 * Deliberately does NOT own model loading — the AssetEditorPlugin loads the
 * base (empty scene or a library GLB) and constructs the document around it.
 *
 * Ops flow through a single-flight queue (mirrors the SceneStore): two ops
 * never execute concurrently, and the queue is drained in order. Application
 * to the live scene is delegated to {@link AssetExecutorContext}.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Mesh, Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
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
  type AssetOp,
  type AssetPrimitiveOp,
  type CADLinkExtras,
  type NodeTransform,
  type MaterialValue,
  type MergeKeptNodeSpec,
  type MergeOutputSpec,
  type MergeSourceSignature,
  assetOpHeader,
  canCoalesceAssetOps,
  mergeAssetOps,
  describeAssetOp,
  dedupeComponentKey,
} from './rv-asset-ops';
import { MAX_OP_HISTORY } from '../ops/rv-op-utils';
import {
  saveAssetDraft,
  clearAssetDraft,
  type AssetDraft,
  type AssetDraftBase,
} from './rv-asset-draft-storage';
import type { CadImportResult } from './rv-cad-provider';
import { putCadGlb } from '../import/rv-cad-glb-cache';
import { parseGlbSubtree } from '../engine/rv-glb-parse';
import { NodeRegistry } from '../engine/rv-node-registry';
import { captureMaterialPrev } from './rv-asset-material';

/** Where the document started from. */
export type AssetBase = AssetDraftBase;

/** Immutable UI snapshot (useSyncExternalStore). */
export interface AssetDocumentSnapshot {
  id: string;
  name: string;
  base: AssetBase;
  dirty: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  opCount: number;
}

/** Debounce for the IndexedDB draft autosave (same cadence as SceneStore). */
const DRAFT_AUTOSAVE_MS = 2000;

export class AssetDocument {
  readonly id: string;
  private _name: string;
  private _base: AssetBase;
  private readonly _createdAt: number;

  private readonly viewer: RVViewer;
  readonly executor: AssetExecutorContext;

  private _ops: AssetOp[] = [];
  private _redo: AssetOp[] = [];
  /** Ids of `_ops` at the last clean point (fresh open / save). */
  private _baselineIds: string[] = [];

  /** Single-flight op queue tail. */
  private _queue: Promise<void> = Promise.resolve();
  private _busyDepth = 0;

  /** Transaction collection buffer (null = not inside a transaction). */
  private _txnOps: AssetOp[] | null = null;
  /** First failure seen inside the open transaction. Set by the fire-and-forget
   *  mutators, whose promise no caller holds — without this a transaction could
   *  commit around an op that never applied. */
  private _txnError: unknown = null;
  /** True while a failed transaction is unwinding: the rollback drives the
   *  executor op by op and must not wake React per step (a 434-op rollback would
   *  emit 868 store updates — the overflow this plan removes). */
  private _notifyPaused = false;
  /**
   * Busy state OWNED BY the open transaction (F6).
   *
   * A transaction suppresses intermediate notifications, which also swallowed the
   * `busy` transition its ops would have produced: a bulk import left the toolbar
   * looking idle for its whole duration. So the transaction publishes busy ONCE
   * when it opens, and drops the flag when it commits or unwinds — the UI gets a
   * deliberate "working / done", not the accidental silence.
   */
  private _txnBusy = false;

  private _autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposed = false;

  // React store plumbing
  private _version = 0;
  private _snapshot: AssetDocumentSnapshot | null = null;
  private readonly _listeners = new Set<() => void>();

  constructor(viewer: RVViewer, opts: { id: string; name: string; base: AssetBase; createdAt?: number }) {
    this.viewer = viewer;
    this.executor = new AssetExecutorContext(viewer);
    this.id = opts.id;
    this._name = opts.name;
    this._base = opts.base;
    this._createdAt = opts.createdAt ?? Date.now();
  }

  /** Fresh "Untitled" document. */
  static newUntitled(viewer: RVViewer): AssetDocument {
    return new AssetDocument(viewer, {
      id: 'asset_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      name: 'Untitled',
      base: { kind: 'empty' },
    });
  }

  // ─── Metadata ───────────────────────────────────────────────────────

  /** Document metadata dirty (rename) — OR'd into `dirty` alongside the op log. */
  private _metaDirty = false;

  get name(): string { return this._name; }
  get base(): AssetBase { return this._base; }
  get dirty(): boolean {
    if (this._metaDirty) return true;
    const ids = this._ops.map((o) => o.id);
    if (ids.length !== this._baselineIds.length) return true;
    return ids.some((id, i) => id !== this._baselineIds[i]);
  }

  /** Rename the DOCUMENT (not a scene node). Metadata only — not an op, but
   *  marks the document dirty so the exit guard prompts to save. */
  renameDocument(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this._name) return;
    this._name = trimmed;
    this._metaDirty = true;
    this._scheduleAutosave();
    this._notify();
  }

  // ─── Op application ─────────────────────────────────────────────────

  /** Queue an op: forward-apply to the live scene, then record it.
   *
   *  The returned promise REJECTS when the op did not apply, and the op is then
   *  NOT recorded. Recording an op the executor never applied is what produced
   *  "the scene disagrees with its own history" — and inside a bulk edit, a scene
   *  half-rebuilt with nothing to undo (plan-359 Phase 3). */
  applyOp(op: AssetOp): Promise<void> {
    return this._enqueue(async () => {
      await this.executor.applyForward(op);
      this._record(op);
    });
  }

  /**
   * Collect every op applied inside `fn` into one composite undo unit.
   *
   * Re-entrant: a nested call folds its ops into the OUTER transaction (one undo
   * unit total) — this is what lets compound tools (e.g. the MCP kinematize tool)
   * reuse actions that open their own transactions.
   *
   * ALL-OR-NOTHING. If the body throws, or any op inside it failed (including the
   * fire-and-forget mutators, whose failure lands in `_txnError`), everything the
   * transaction did apply is rolled back, NOTHING is recorded, and the original
   * error is re-thrown at the caller. Before this, a failure mid-transaction left
   * the ops applied and unrecorded.
   */
  async withTransaction(label: string, fn: () => Promise<void>): Promise<void> {
    if (this._txnOps) { await fn(); return; }
    // Publish "busy" BEFORE suppression starts — this is the only notification
    // the UI gets while the transaction runs (F6).
    this._txnBusy = true;
    this._notify();
    this._txnOps = [];
    this._txnError = null;
    let bodyError: unknown = null;
    let bodyFailed = false;
    try {
      try {
        await fn();
      } catch (e) {
        bodyError = e;
        bodyFailed = true;
      }
      // Commit (or unwind) INSIDE the queue, so no other op can interleave.
      await this._enqueue(async () => {
        const collected = this._txnOps ?? [];
        const failed = bodyFailed || this._txnError !== null;
        const failure = bodyFailed ? bodyError : this._txnError;
        this._txnOps = null;
        this._txnError = null;
        this._txnBusy = false;
        if (failed) {
          await this._rollback(collected);
          throw failure;
        }
        if (collected.length === 0) return;
        const flattened = collected.flatMap((o) => (o.kind === 'composite' ? o.ops : [o]));
        this._record({ ...assetOpHeader(), kind: 'composite', label, ops: flattened });
      });
    } finally {
      this._txnOps = null;
      this._txnError = null;
      this._txnBusy = false;
    }
  }

  /**
   * Reverse the ops a failed transaction already applied, newest first, so the
   * scene ends where it started.
   *
   * Individual rollback failures are logged, never re-thrown: the caller must
   * learn the ORIGINAL error, and there is nothing better left to try.
   */
  private async _rollback(ops: AssetOp[]): Promise<void> {
    if (ops.length === 0) return;
    this._notifyPaused = true;
    try {
      for (let i = ops.length - 1; i >= 0; i--) {
        try {
          await this.executor.applyInverse(ops[i]);
        } catch (e) {
          console.error(
            '[asset-editor] transaction rollback failed — the scene may be inconsistent:', e,
          );
        }
      }
    } finally {
      this._notifyPaused = false;
    }
  }

  /** Undo the newest op. The stacks move only AFTER the inverse applied — popping
   *  first (as this used to) discarded the entry on a failed undo, leaving the
   *  change in the scene with no way back. */
  async undo(): Promise<void> {
    await this._enqueue(async () => {
      const op = this._ops[this._ops.length - 1];
      if (!op) return;
      await this.executor.applyInverse(op);
      this._ops.pop();
      this._redo.push(op);
    });
    this._scheduleAutosave();
    this._notify();
  }

  /** Redo the newest undone op. Same stack discipline as {@link undo}. */
  async redo(): Promise<void> {
    await this._enqueue(async () => {
      const op = this._redo[this._redo.length - 1];
      if (!op) return;
      await this.executor.applyForward(op);
      this._redo.pop();
      this._ops.push(op);
    });
    this._scheduleAutosave();
    this._notify();
  }

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
   * Inside a transaction the failure is remembered in `_txnError`, so
   * `withTransaction` still rolls back and rejects: a caller that opened a
   * transaction always learns that part of it did not apply, even when the op was
   * issued through an API that cannot hand the error back directly.
   */
  private _voidApply(op: AssetOp): void {
    void this.applyOp(op).catch((e) => {
      if (this._txnOps && this._txnError === null) this._txnError = e;
    });
  }

  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): void {
    this._voidApply({ ...assetOpHeader(), kind: 'setField', nodePath, componentType, fieldName, value, prev });
  }

  unsetField(nodePath: string, componentType: string, fieldName: string, prev: unknown): void {
    this._voidApply({ ...assetOpHeader(), kind: 'unsetField', nodePath, componentType, fieldName, prev });
  }

  transformNode(nodePath: string, transform: NodeTransform, prev: NodeTransform): void {
    this._voidApply({ ...assetOpHeader(), kind: 'transformNode', nodePath, transform, prev });
  }

  renameNode(nodePath: string, name: string, prevName: string): void {
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
      if (node === this.viewer.currentModelRoot) return false;
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
    if (this._txnOps !== null || (movable.length === 1 && !label && !singleNeedsRename)) {
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
   * `reparentNode` primitives inside an `AssetCompositeOp`, so undo, redo, draft
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
      if (node === this.viewer.currentModelRoot) continue;
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

    const ops: AssetPrimitiveOp[] = [];
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
      await this.applyOp({ ...assetOpHeader(), kind: 'composite', label, ops });
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
  async replayOps(ops: AssetOp[]): Promise<void> {
    for (const op of ops) {
      await this.executor.applyForward(op);
      this._ops.push(op);
    }
    this._notify();
  }

  toDraft(): AssetDraft {
    return {
      shell: { id: this.id, name: this._name, base: this._base, createdAt: this._createdAt },
      ops: [...this._ops],
      savedAt: Date.now(),
    };
  }

  /** Persist the draft NOW (bypasses the debounce — used by the exit guard). */
  async flushDraft(): Promise<void> {
    if (this._autosaveTimer) { clearTimeout(this._autosaveTimer); this._autosaveTimer = null; }
    await saveAssetDraft(this.toDraft());
  }

  // ─── Save / lifecycle ────────────────────────────────────────────────

  /** Mark the current state as saved: re-base, flush trash, replace the draft.
   *  A library save leaves a CLEAN draft (saved base + name, no ops) so a
   *  reload re-opens the saved asset instead of a fresh Untitled; other bases
   *  — and explicit discards (`clearDraft: true`) — clear the draft. The
   *  returned promise resolves once the draft write/clear has landed; callers
   *  that may race a page reload (the save flow) await it. */
  markSaved(base: AssetBase, name?: string, opts?: { clearDraft?: boolean }): Promise<void> {
    this._base = base;
    if (name) this._name = name;
    this._baselineIds = this._ops.map((o) => o.id);
    this._metaDirty = false;
    this.executor.flushTrash();
    // Cancel a pending autosave — it would overwrite the clean draft below
    // with the stale pre-save op log.
    if (this._autosaveTimer) { clearTimeout(this._autosaveTimer); this._autosaveTimer = null; }
    const draftDone = !opts?.clearDraft && base.kind === 'libraryGlb'
      ? saveAssetDraft({
          shell: { id: this.id, name: this._name, base, createdAt: this._createdAt },
          ops: [],
          savedAt: Date.now(),
        })
      : clearAssetDraft();
    this._notify();
    return draftDone;
  }

  /** Wait for all queued ops to finish (save pipeline calls this first). */
  whenIdle(): Promise<void> {
    return this._queue;
  }

  dispose(): void {
    this._disposed = true;
    if (this._autosaveTimer) { clearTimeout(this._autosaveTimer); this._autosaveTimer = null; }
    this.executor.dispose();
    this._listeners.clear();
  }

  // ─── React store ─────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): AssetDocumentSnapshot => {
    if (!this._snapshot) {
      const lastOp = this._ops[this._ops.length - 1] ?? null;
      const nextRedo = this._redo[this._redo.length - 1] ?? null;
      this._snapshot = {
        id: this.id,
        name: this._name,
        base: this._base,
        dirty: this.dirty,
        busy: this._busyDepth > 0 || this._txnBusy,
        canUndo: this._ops.length > 0,
        canRedo: this._redo.length > 0,
        undoLabel: lastOp ? describeAssetOp(lastOp) : null,
        redoLabel: nextRedo ? describeAssetOp(nextRedo) : null,
        opCount: this._ops.length,
      };
    }
    return this._snapshot;
  };

  // ─── internals ───────────────────────────────────────────────────────

  private _record(op: AssetOp): void {
    if (this._txnOps) {
      // Inside a transaction: collect, don't touch history yet.
      this._txnOps.push(op);
      return;
    }
    const last = this._ops[this._ops.length - 1];
    if (last && canCoalesceAssetOps(last, op)) {
      this._ops[this._ops.length - 1] = mergeAssetOps(last, op);
    } else {
      this._ops.push(op);
      if (this._ops.length > MAX_OP_HISTORY) this._ops.shift();
    }
    this._redo.length = 0; // a new edit invalidates the redo branch
    this._scheduleAutosave();
    this._notify();
  }

  /**
   * Run `work` on the single-flight queue.
   *
   * Two promises, deliberately: the QUEUE TAIL never rejects (a rejected tail
   * would fail every later op through `.then`), while the promise handed to the
   * CALLER does. That split is what lets a failed op be both survivable for the
   * document and observable for whoever asked for it.
   */
  private _enqueue(work: () => Promise<void>): Promise<void> {
    this._busyDepth++;
    this._notify();
    let failure: unknown = null;
    let failed = false;
    const tail = this._queue.then(async () => {
      try {
        await work();
      } catch (e) {
        failure = e;
        failed = true;
        console.warn('[asset-editor] op failed:', e);
      } finally {
        this._busyDepth--;
        this._notify();
      }
    });
    this._queue = tail;
    return tail.then(() => { if (failed) throw failure; });
  }

  private _scheduleAutosave(): void {
    if (this._disposed) return;
    if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => {
      this._autosaveTimer = null;
      void saveAssetDraft(this.toDraft());
    }, DRAFT_AUTOSAVE_MS);
  }

  /**
   * Invalidate the snapshot and wake the React store.
   *
   * Coalesced while a transaction is open: `_enqueue` notifies twice per op (busy in, busy out), so
   * a bulk edit inside one transaction produced two notifications PER NODE. A PLMXML kinematics
   * import moves 434 nodes and thereby raised React's "Maximum update depth exceeded" mid-apply —
   * with no rollback in this API, that left the scene half-mutated. Chunking the caller's work did
   * not help (measured, with a frame between chunks); the notification count is the actual lever.
   *
   * Suppressing here is safe because the transaction always ends with notifications that DO pass:
   * the composite `_record` and `_enqueue`'s own finally both run after `_txnOps` is cleared. The
   * trade is that intermediate states are not rendered during a bulk edit — which is what the
   * `replayOps` path already does deliberately (one notify after the whole replay).
   */
  private _notify(): void {
    if (this._txnOps || this._notifyPaused) return;
    this._snapshot = null;
    this._version++;
    for (const fn of this._listeners) fn();
  }
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
