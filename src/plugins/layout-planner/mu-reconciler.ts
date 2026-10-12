// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-reconciler.ts — Registers spawned MU scene nodes as planner-selectable.
 *
 * Spawned MUs (Movable Units) are simulation objects, NOT layout placements.
 * To make them selectable EXACTLY like layout objects — hover, click, marquee
 * box-select, multi-select, outline, delete — without a separate selection
 * system, we register each clone MU's Object3D as a normal selectable scene
 * node and let the shared pipeline (global RaycastManager + SelectionManager +
 * OutlinePass) do the rest:
 *
 *   - `userData._muSelectable = true` (+ `_muRef` back-ref) — NOT `_layoutId`,
 *     so MUs never enter `_objectMap` / the SceneStore / persistence and are
 *     never touched by the orphan sweep or the transform gizmo.
 *   - registered in the NodeRegistry under a synthetic, collision-proof key
 *     (`__mu#<n>`) resolved O(1) by exact match (avoids name-suffix ambiguity).
 *   - each mesh added as an aux raycast target owned by the MU root, so the
 *     global RaycastManager hits it and resolves to the MU root's path.
 *
 * The planner forces clone-mode MU spawning while active
 * (`transportManager.preferCloneMU`) so every MU has a real node; instanced MUs
 * (no per-instance Object3D) are ignored. `reconcile()` runs each frame from the
 * planner's onRender, diffing the live MU list against the registered set.
 *
 * Planner-independent (plan-567): the Commissioning MU interaction runs its own
 * instance. Two rules keep instances from damaging each other or the registry
 * (SOL #8):
 *   - a PRE-PLACED MU is already pickable under its document path — it only
 *     gets the `_muSelectable` / `_muRef` markers, never a synthetic path or aux
 *     targets (a synthetic path would overwrite its reverse lookup, and its
 *     removal would wipe the document paths of its subtree);
 *   - an instance removes only what IT added: the markers only while they carry
 *     its owner token, the registry entry only as the one synthetic path
 *     (`unregisterNode`), never the node's subtree.
 */

import type { Object3D, Mesh } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVMovingUnit, InstancedMovingUnit } from '../../core/engine/rv-mu';

type MovingUnit = RVMovingUnit | InstancedMovingUnit;

export interface MuReconcilerEntry {
  node: Object3D;
  /** Synthetic registry path (`__mu#<n>`), or a pre-placed MU's document path. */
  path: string;
  /** Aux raycast meshes registered for this MU (for clean removal). */
  meshes: Mesh[];
  /** True when `path` is the synthetic `__mu#<n>` key THIS reconciler registered;
   *  false for a pre-placed MU (its document path, not ours to remove). */
  synthetic?: boolean;
}

export interface MuReconcilerDeps {
  viewer: RVViewer;
  /** Live simulation MUs (clone + instanced). */
  getMUs(): MovingUnit[];
  /** Called when a selected MU is unregistered (consumed/released) so the
   *  planner can refresh the outline. */
  onSelectionDropped?(): void;
}

/** Hard cap on simultaneously-registered selectable MUs (runaway guard). */
const MAX_REGISTERED = 2000;

/** Distinct owner token per reconciler instance (marker ownership, SOL #8). */
let _nextOwner = 1;

export class MuReconciler {
  private _map = new Map<MovingUnit, MuReconcilerEntry>();
  private _counter = 0;
  private _capWarned = false;
  /** Reused scratch set — no per-frame allocation. */
  private _live = new Set<MovingUnit>();
  private _toRemove: MovingUnit[] = [];
  private readonly _owner = _nextOwner++;

  constructor(private deps: MuReconcilerDeps) {}

  /** Read-only view for box-select (path + node per registered MU). */
  get objectMap(): ReadonlyMap<MovingUnit, MuReconcilerEntry> { return this._map; }

  /**
   * Sync the registered MU set with the live simulation. Register new clone
   * MUs, unregister consumed/released ones (and drop their selection). Cheap
   * no-op when the MU list is unchanged (the common paused-planner case).
   */
  reconcile(): void {
    const mus = this.deps.getMUs();

    this._live.clear();
    for (const mu of mus) {
      if (mu.isInstanced || mu.markedForRemoval) continue;
      this._live.add(mu);
    }

    // Additions
    for (const mu of this._live) {
      if (this._map.has(mu)) continue;
      if (this._map.size >= MAX_REGISTERED) {
        if (!this._capWarned) {
          console.warn(`[MuReconciler] >${MAX_REGISTERED} selectable MUs — skipping further registration.`);
          this._capWarned = true;
        }
        break;
      }
      this._register(mu as RVMovingUnit);
    }

    // Removals (collect first — mutating the map during iteration is unsafe)
    this._toRemove.length = 0;
    for (const mu of this._map.keys()) {
      if (!this._live.has(mu)) this._toRemove.push(mu);
    }
    for (const mu of this._toRemove) this._unregister(mu);
  }

  /** Unregister every MU node (registry + aux targets + markers). */
  disposeAll(): void {
    this._toRemove.length = 0;
    for (const mu of this._map.keys()) this._toRemove.push(mu);
    for (const mu of this._toRemove) this._unregister(mu);
    this._map.clear();
    this._capWarned = false;
  }

  // ─── Private ──────────────────────────────────────────────────────

  private _register(mu: RVMovingUnit): void {
    const viewer = this.deps.viewer;
    const node = mu.node;
    node.userData._muSelectable = true;
    node.userData._muRef = mu;
    node.userData._muOwner = this._owner;

    // Pre-placed: already pickable under its document path — markers only.
    if (mu.preplaced) {
      const docPath = viewer.registry?.getPathForNode?.(node) ?? null;
      this._map.set(mu, { node, path: docPath ?? '', meshes: [], synthetic: false });
      return;
    }

    const path = `__mu#${this._counter++}`;
    viewer.registry?.registerNode(path, node);

    const meshes: Mesh[] = [];
    const rm = viewer.raycastManager;
    node.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      if (child.userData._isGhostOverlay || child.userData._highlightOverlay) return;
      rm?.addAuxRaycastTarget(mesh, node);
      meshes.push(mesh);
    });

    this._map.set(mu, { node, path, meshes, synthetic: true });
  }

  private _unregister(mu: MovingUnit): void {
    const entry = this._map.get(mu);
    if (!entry) return;
    const viewer = this.deps.viewer;
    const rm = viewer.raycastManager;

    for (const mesh of entry.meshes) rm?.removeAuxRaycastTarget(mesh);
    if (entry.synthetic) {
      // Only the synthetic path — never the subtree (pre-placed loads riding
      // on a spawned carrier keep their document paths).
      const reg = viewer.registry;
      if (reg?.unregisterNode) reg.unregisterNode(entry.path, entry.node);
      else reg?.unregisterSubtree(entry.node);
    }
    if (entry.node.userData._muOwner === this._owner) {
      delete entry.node.userData._muSelectable;
      delete entry.node.userData._muRef;
      delete entry.node.userData._muOwner;
    }
    this._map.delete(mu);

    // If this MU was selected, drop its path so selection/outline stay valid.
    const sel = viewer.selectionManager?.getSnapshot().selectedPaths ?? [];
    if (entry.path && sel.includes(entry.path)) {
      viewer.selectionManager?.selectPaths(sel.filter((p) => p !== entry.path));
      this.deps.onSelectionDropped?.();
    }
  }
}
