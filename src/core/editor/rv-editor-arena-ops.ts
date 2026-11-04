// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Editor arena op listener (plan-766 Phase 2, §2.4.4).
 *
 * Subscribes to the asset op stream at its one seam — the executor's
 * post-apply hook (`AssetExecutorContext.addApplyListener`), which fires once
 * per top-level op in BOTH directions, so undo, redo and draft replay arrive
 * here exactly like a fresh edit — and maps every op to the cheapest arena
 * reaction that keeps the batched display true:
 *
 * | Op | Reaction |
 * |----|----------|
 * | transformNode, reparentNode, renameNode, setField, unsetField, addComponent, removeComponent | none — the pre-frame matrix sync covers moves |
 * | setNodeVisible, deleteNode (trash detach / its undo) | visibility epoch |
 * | setMaterial | `setMaterial(mesh)` per recorded mesh path (reconcile when a path no longer resolves) |
 * | importCad, createNode, separateMesh, mergeMesh, replaceNodeGeometry (and their undos) | `reconcile()` — adds new meshes, re-buckets swapped geometry/material, visibility epoch |
 * | anything else | `rebuild()`, debounced 150 ms |
 *
 * Trashed meshes stay arena instances (hidden through the trash group's
 * `.visible = false`); the trash flush removes them (`rv-asset-executors.ts`).
 * Draft replay and recompose: {@link EditorArenaOps.suspend} turns the
 * listener off, the matching {@link EditorArenaOps.resume} runs ONE build.
 * When the source publishes replay brackets (`addReplayListener`, the asset
 * executor — fired by `RvDocument.replayOps` and the recompose replay), the
 * ops suspend and resume on them by themselves; nobody has to wrap a replay.
 */

import type { Mesh, Object3D } from 'three';
import type { RvAssetOp } from '../ops/rv-unified-ops';
import type { AssetApplyDirection, AssetApplyListener, AssetReplayListener } from './rv-asset-executors';
import type { EditorArenaManager } from './rv-editor-arena';

/** Arena reaction of one op, ordered by cost. */
export type ArenaOpReaction = 'none' | 'visibility' | 'material' | 'reconcile' | 'rebuild';

const RANK: Record<ArenaOpReaction, number> = {
  none: 0, visibility: 1, material: 2, reconcile: 3, rebuild: 4,
};

const NONE_KINDS = new Set<string>([
  'transformNode', 'reparentNode', 'renameNode', 'setField', 'unsetField',
  'addComponent', 'removeComponent',
]);
const VISIBILITY_KINDS = new Set<string>(['setNodeVisible', 'deleteNode']);
// plan-621: `replaceNodeGeometry` keeps the mesh but swaps its geometry — exactly
// the "re-bucket swapped geometry" case `reconcile()` exists for.
const RECONCILE_KINDS = new Set<string>([
  'importCad', 'createNode', 'separateMesh', 'mergeMesh', 'replaceNodeGeometry',
  // plan-641 Phase 3: a copied subtree brings new meshes.
  'cloneNode',
]);

/** Pure: the reaction a primitive op kind needs. */
export function arenaReactionOfKind(kind: string): ArenaOpReaction {
  if (NONE_KINDS.has(kind)) return 'none';
  if (VISIBILITY_KINDS.has(kind)) return 'visibility';
  if (kind === 'setMaterial') return 'material';
  if (RECONCILE_KINDS.has(kind)) return 'reconcile';
  return 'rebuild';
}

/** Pure: the reaction an op (composite = strongest child) needs. */
export function arenaReactionOf(op: RvAssetOp): ArenaOpReaction {
  if (op.kind !== 'composite') return arenaReactionOfKind(op.kind);
  let best: ArenaOpReaction = 'none';
  for (const child of op.ops) {
    const r = arenaReactionOfKind(child.kind);
    if (RANK[r] > RANK[best]) best = r;
  }
  return best;
}

/** Mesh paths a `setMaterial` op (or composite) painted — read from `prev`. */
export function materialMeshPathsOf(op: RvAssetOp): string[] {
  const out: string[] = [];
  const visit = (o: { kind: string; prev?: unknown }) => {
    if (o.kind !== 'setMaterial' || !Array.isArray(o.prev)) return;
    for (const p of o.prev as Array<{ meshPath?: unknown }>) {
      if (typeof p?.meshPath === 'string') out.push(p.meshPath);
    }
  };
  if (op.kind === 'composite') for (const c of op.ops) visit(c as never);
  else visit(op as never);
  return out;
}

/** The subscribe seam (`AssetExecutorContext` satisfies it). */
export interface ArenaOpSource {
  addApplyListener(fn: AssetApplyListener): () => void;
  /** Optional bulk-replay brackets (the asset executor has them). */
  addReplayListener?(fn: AssetReplayListener): () => void;
  /** True while the source is inside a replay bracket. */
  readonly replaying?: boolean;
}

export interface EditorArenaOpsOptions {
  /** Node by path (production: `viewer.registry.getNode`). */
  resolveNode?: (path: string) => Object3D | null;
  /** Debounce of the unknown-op rebuild in ms (default 150). */
  debounceMs?: number;
}

/** Counters for tests / stats. */
export interface EditorArenaOpsCounters {
  visibility: number;
  material: number;
  reconcile: number;
  rebuilds: number;
  ignored: number;
  suspendedOps: number;
}

export class EditorArenaOps {
  readonly counters: EditorArenaOpsCounters = {
    visibility: 0, material: 0, reconcile: 0, rebuilds: 0, ignored: 0, suspendedOps: 0,
  };
  private readonly _resolve: (path: string) => Object3D | null;
  private readonly _debounceMs: number;
  private _unsub: (() => void) | null = null;
  private _unsubReplay: (() => void) | null = null;
  /** True while THIS object holds a suspend on behalf of the source's replay bracket. */
  private _replayHeld = false;
  private _suspend = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly manager: EditorArenaManager, opts: EditorArenaOpsOptions = {}) {
    this._resolve = opts.resolveNode ?? (() => null);
    this._debounceMs = opts.debounceMs ?? 150;
  }

  /** Subscribe to an op source (idempotent: re-attaching detaches first). */
  attach(source: ArenaOpSource): void {
    this.detach();
    this._unsub = source.addApplyListener((op, dir) => this.handle(op, dir));
    if (source.addReplayListener) {
      this._unsubReplay = source.addReplayListener((phase) => {
        if (phase === 'begin') this._holdReplay();
        else this._releaseReplay();
      });
      // Attached in the middle of a replay (a recompose reload installs the
      // arena BEFORE its replay ends): hold the suspend until the bracket closes.
      if (source.replaying) this._holdReplay();
    }
  }

  /** Unsubscribe and drop a pending rebuild (and a held replay suspend, without building). */
  detach(): void {
    this._unsub?.();
    this._unsub = null;
    this._unsubReplay?.();
    this._unsubReplay = null;
    if (this._replayHeld) {
      this._replayHeld = false;
      if (this._suspend > 0) this._suspend--;
    }
    this.cancelPendingRebuild();
  }

  private _holdReplay(): void {
    if (this._replayHeld) return;
    this._replayHeld = true;
    this.suspend();
  }

  private _releaseReplay(): void {
    if (!this._replayHeld) return;
    this._replayHeld = false;
    this.resume();
  }

  get attached(): boolean { return this._unsub !== null; }
  get suspended(): boolean { return this._suspend > 0; }

  /** Listener off (draft replay, recompose). Nests. */
  suspend(): void {
    this._suspend++;
    this.cancelPendingRebuild();
  }

  /** Counterpart of {@link suspend}: the outermost resume runs ONE build. */
  resume(): void {
    if (this._suspend === 0) return;
    this._suspend--;
    if (this._suspend > 0) return;
    if (this.manager.isBuilt) {
      this.manager.rebuild();
      this.counters.rebuilds++;
    }
  }

  /** React to one applied op. Public for tests; normally driven by {@link attach}. */
  handle(op: RvAssetOp, _direction: AssetApplyDirection = 'forward'): void {
    if (this._suspend > 0) { this.counters.suspendedOps++; return; }
    if (!this.manager.isBuilt) return;
    switch (arenaReactionOf(op)) {
      case 'none':
        this.counters.ignored++;
        return;
      case 'visibility':
        this.manager.bumpVisibility();
        this.counters.visibility++;
        return;
      case 'material': {
        const meshes: Mesh[] = [];
        let unresolved = false;
        for (const path of materialMeshPathsOf(op)) {
          const node = this._resolve(path) as Mesh | null;
          if (node && (node as { isMesh?: boolean }).isMesh) meshes.push(node);
          else unresolved = true;
        }
        for (const m of meshes) this.manager.setMaterial(m);
        if (unresolved || meshes.length === 0) this.manager.reconcile();
        this.counters.material++;
        return;
      }
      case 'reconcile':
        this.manager.reconcile();
        this.counters.reconcile++;
        return;
      case 'rebuild':
        this.scheduleRebuild();
        return;
    }
  }

  /** Debounced full rebuild (unknown op / error fallback). */
  scheduleRebuild(): void {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._runRebuild();
    }, this._debounceMs);
  }

  /** Run a pending debounced rebuild now (tests, teardown ordering). No-op when none is armed. */
  flushRebuild(): void {
    if (this._timer === null) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._runRebuild();
  }

  private _runRebuild(): void {
    if (this._suspend > 0 || !this.manager.isBuilt) return;
    this.manager.rebuild();
    this.counters.rebuilds++;
  }

  /** True while a debounced rebuild is armed. */
  get rebuildPending(): boolean { return this._timer !== null; }

  cancelPendingRebuild(): void {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  /** Detach and forget. */
  dispose(): void {
    this.detach();
    this._suspend = 0;
  }

  /** True while a replay bracket of the attached source holds the listener off. */
  get replayHeld(): boolean { return this._replayHeld; }
}
