// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-group-registry.ts — Registry for Group components parsed from GLB extras.
 *
 * Groups are Unity components (realvirtual.Group) that tag scene nodes for
 * visibility control. Multiple nodes can belong to the same group, and a
 * single node can belong to multiple groups.
 *
 * Visibility is implemented via `node.visible = false` on group root nodes
 * only — Three.js automatically skips the entire subtree during rendering,
 * with zero per-frame cost for hidden groups.
 *
 * IMPORTANT: Do NOT use `node.traverse()` to set visibility — it would
 * clobber MU template visibility and LogicStep_Enable state on child nodes.
 *
 * Isolate uses a camera layer bit (ISOLATE_FOCUS_LAYER) instead of mutating
 * visibility. rv-viewer.ts renders a 3-pass composite when isolate is active:
 * dim backdrop (everything except focus) → white semi-transparent overlay →
 * focus group on top.
 */

import type { Camera, Object3D } from 'three';
import { MEASUREMENT_LAYER, NO_AO_LAYER } from './rv-constants';

/** Three.js layer bit used to mark the currently isolated group's subtree. */
export const ISOLATE_FOCUS_LAYER = 2;

/**
 * Three.js layer bit reserved for hover/select wireframe overlays.
 *
 * Overlays live on this layer ONLY (`.layers.set(HIGHLIGHT_OVERLAY_LAYER)`).
 * The viewer enables this layer on its cameras so they render in normal mode,
 * and the 3-pass isolate renderer adds a 4th pass that re-renders this layer
 * with `clearDepth()` so wireframes stay visible on top of the dim wash.
 */
export const HIGHLIGHT_OVERLAY_LAYER = 3;

/**
 * SINGLE SOURCE OF TRUTH for the "on-top UI overlay" layers.
 *
 * These layers hold 3D UI that must NOT influence Screen-Space Ambient
 * Occlusion: hover/select wireframes, planner gizmos, measurement markers and
 * labels. Why a layer (and not just `depthWrite:false`)? `GTAOPass` builds its
 * own depth+normal gbuffer with `scene.overrideMaterial`, so each object's own
 * `depthWrite:false` is ignored — the ONLY thing that keeps an object out of
 * SSAO is the camera layer mask.
 *
 * The viewer disables these layers on the camera before `composer.render()`
 * (so GTAO/N8AO never see them) and re-renders them on top afterwards in
 * `_renderOverlayLayers()`. Add a new overlay layer to this array and every
 * render path picks it up automatically via the helpers below.
 */
export const OVERLAY_LAYERS: readonly number[] = [HIGHLIGHT_OVERLAY_LAYER, MEASUREMENT_LAYER];

/**
 * Disable every overlay layer on a camera so they're excluded from the
 * EffectComposer's main pass (and thus from the GTAO/N8AO gbuffer). The
 * caller is responsible for restoring the previous layer mask.
 */
export function disableOverlayLayers(camera: Camera): void {
  for (const layer of OVERLAY_LAYERS) camera.layers.disable(layer);
}

/**
 * Restrict a camera to ONLY the overlay layers — the idiom used by the
 * post-composer overlay re-render and isolate pass 4. `set` the first layer
 * (which clears the mask), then `enable` the rest.
 */
export function setOverlayLayersOnly(camera: Camera): void {
  camera.layers.set(OVERLAY_LAYERS[0]);
  for (let i = 1; i < OVERLAY_LAYERS.length; i++) camera.layers.enable(OVERLAY_LAYERS[i]);
}

/**
 * Tag an object and all descendants as an on-top UI overlay so it never
 * contaminates SSAO. Puts the subtree on HIGHLIGHT_OVERLAY_LAYER ONLY
 * (removing layer 0) → excluded from the composer and re-rendered on top.
 *
 * Use this for any hand-rolled 3D UI added directly to the scene. Gizmos
 * created through `GizmoOverlayManager` already get this automatically.
 */
export function markAsOverlay(object: Object3D): void {
  object.traverse(o => o.layers.set(HIGHLIGHT_OVERLAY_LAYER));
}

/**
 * Tag an object and all descendants as in-scene UI that must not contribute to
 * SSAO, while still rendering normally (correct depth-occlusion + bloom).
 *
 * Use this — instead of {@link markAsOverlay} — when the UI needs to be occluded
 * by scene geometry or needs UnrealBloom (e.g. the placement ghost, the planner
 * grid, glow gizmos). Puts the subtree on NO_AO_LAYER ONLY; the real cameras
 * keep this layer enabled (so the RenderPass draws it) while the AO clone camera
 * disables it (so GTAO/N8AO skip it). See NO_AO_LAYER in rv-constants.
 */
export function markNoAO(object: Object3D): void {
  object.traverse(o => o.layers.set(NO_AO_LAYER));
}

/**
 * Tag a node and all descendants with ISOLATE_FOCUS_LAYER. Idempotent.
 *
 * Batched render path: sources of BatchedMesh instances carry
 * `layers.mask = 0` (not rendered normally). `layers.enable` gives them the
 * focus bit, so isolated batch sources render individually — and in full
 * color — in the focus pass (pass 3), while the arena keeps drawing the dim
 * backdrop in pass 1. {@link untagIsolateSubtree}'s `layers.disable` restores
 * the 0-mask exactly. No extra bookkeeping needed.
 */
export function tagIsolateSubtree(root: Object3D): void {
  root.traverse(o => {
    // BatchedMesh arenas never join the focus pass — their (mask-0) source
    // meshes get the focus bit instead and render individually in pass 3.
    // Tagging the arena too would double-draw the same geometry.
    if (o.userData?._rvBatchedRender) return;
    o.layers.enable(ISOLATE_FOCUS_LAYER);
  });
}

/**
 * Reverse of {@link tagIsolateSubtree}. Removes ISOLATE_FOCUS_LAYER from
 * every descendant.
 */
export function untagIsolateSubtree(root: Object3D): void {
  root.traverse(o => {
    o.layers.disable(ISOLATE_FOCUS_LAYER);
  });
}

/** Information about a single named group. */
export interface GroupInfo {
  /** Resolved full group name: prefixNodeName + GroupName */
  name: string;
  /** All Three.js nodes that belong to this group */
  nodes: Object3D[];
  /** Current visibility state */
  visible: boolean;
}

/**
 * Registry mapping group names to Object3D nodes with visibility state.
 *
 * Built during GLB scene load by parsing Group/Group_N components from
 * node.userData.realvirtual extras.
 */
export class GroupRegistry {
  private _groups = new Map<string, GroupInfo>();
  /** Group names that should remain hidden after showAll(). */
  private _defaultHidden: string[] = [];
  /** Group names that are structural kinematic groups (not user-facing). */
  private _kinematicGroups = new Set<string>();
  /** Name of the currently isolated group, or null if none. */
  private _isolateActiveName: string | null = null;
  /** Root nodes that carry the ISOLATE_FOCUS_LAYER tag — needed to untag on showAll. */
  private _isolatedNodes: Object3D[] = [];
  /** Prior `.visible` state of isolated roots (so isolate can force-show defaultHidden targets). */
  private _priorVisibility: { node: Object3D; visible: boolean }[] = [];

  /** Set group names that should remain hidden after showAll(). */
  setDefaultHiddenGroups(names: string[]): void {
    this._defaultHidden = names;
  }

  /**
   * Register a node under a group name.
   * If the group does not exist yet, it is created with visible=true.
   * If the group already exists, the node is added to its nodes list
   * (deduplicated — registering the same node twice is a no-op) and the
   * group's current visibility is applied to the new root.
   */
  register(resolvedName: string, node: Object3D): void {
    let group = this._groups.get(resolvedName);
    if (!group) {
      group = { name: resolvedName, nodes: [], visible: true };
      this._groups.set(resolvedName, group);
    }
    if (group.nodes.includes(node)) return;
    group.nodes.push(node);
    if (!group.visible) node.visible = false;
  }

  /**
   * Remove a node from a group (live-edit path — the editor removed a Group
   * component). Restores `node.visible = true` if the group was hidden.
   * When the group's node list empties, the group entry is deleted (clearing
   * isolate state if it was the isolated group, and its kinematic mark).
   * Returns true when something changed.
   */
  unregister(resolvedName: string, node: Object3D): boolean {
    const group = this._groups.get(resolvedName);
    if (!group) return false;
    const idx = group.nodes.indexOf(node);
    if (idx === -1) return false;
    group.nodes.splice(idx, 1);
    if (!group.visible) node.visible = true;
    if (group.nodes.length === 0) {
      if (this._isolateActiveName === resolvedName) {
        this._clearIsolateState();
      }
      this._groups.delete(resolvedName);
      this._kinematicGroups.delete(resolvedName);
    }
    return true;
  }

  /** Names of all groups that contain the given node, sorted alphabetically. */
  getGroupNamesForNode(node: Object3D): string[] {
    const names: string[] = [];
    for (const group of this._groups.values()) {
      if (group.nodes.includes(node)) names.push(group.name);
    }
    return names.sort();
  }

  /** Get all groups as an array, sorted alphabetically by name. */
  getAll(): GroupInfo[] {
    return [...this._groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Get a single group by name. */
  get(name: string): GroupInfo | undefined {
    return this._groups.get(name);
  }

  /**
   * Set visibility for a single group.
   * Only sets `node.visible` on group root nodes — Three.js skips the
   * entire subtree automatically when parent is invisible.
   */
  setVisible(name: string, visible: boolean): void {
    const group = this._groups.get(name);
    if (!group) return;
    group.visible = visible;
    for (const node of group.nodes) {
      node.visible = visible;
    }
  }

  /**
   * Isolate: mark the target group's subtree with ISOLATE_FOCUS_LAYER so the
   * viewer can render it in a dedicated pass on top of a dimmed backdrop.
   *
   * Unlike the legacy visibility-based isolate, this does NOT touch `.visible`
   * on non-target nodes. The focus group's own `.visible` is force-set to
   * true (and the prior value saved) so a defaultHidden group can still be
   * isolated without being culled by Three.js before layer testing runs.
   */
  isolate(name: string, opts?: { dimOpacity?: number }): void {
    const targetGroup = this._groups.get(name);
    if (!targetGroup) return;

    // Clear any previously applied isolate state first
    if (this._isolateActiveName) {
      this._clearIsolateState();
    }

    for (const node of targetGroup.nodes) {
      this._priorVisibility.push({ node, visible: node.visible });
      node.visible = true;
      tagIsolateSubtree(node);
      this._isolatedNodes.push(node);
    }

    this._isolateActiveName = name;
    this._dimOpacity = opts?.dimOpacity ?? null;
    // Raycast restriction is enforced centrally by RVViewer's isolation gate
    // — see RaycastManager.setIsolationGate().
  }

  /** Per-isolate dim opacity override (null = renderer default). */
  get dimOpacity(): number | null { return this._dimOpacity; }
  private _dimOpacity: number | null = null;

  /**
   * Show all: clear any isolate state and restore visibility for all groups.
   * Re-applies defaultHiddenGroups after restoring visibility.
   */
  showAll(): void {
    this._clearIsolateState();
    for (const group of this._groups.values()) {
      const shouldHide = this._defaultHidden.includes(group.name);
      this.setVisible(group.name, !shouldHide);
    }
  }

  /** Clear the layer tag and visibility overrides applied by the last isolate(). */
  private _clearIsolateState(): void {
    if (!this._isolateActiveName) return;
    for (const node of this._isolatedNodes) {
      untagIsolateSubtree(node);
    }
    for (const entry of this._priorVisibility) {
      entry.node.visible = entry.visible;
    }
    this._isolatedNodes = [];
    this._priorVisibility = [];
    this._isolateActiveName = null;
    this._dimOpacity = null;
  }

  /** External isolate override — true while a plugin owns ISOLATE_FOCUS_LAYER. */
  externalIsolateActive = false;
  /** External isolate roots managed by plugins (docs browser, etc.). */
  private _externalIsolatedRoots: Object3D[] = [];

  /**
   * Plugin-facing isolate API: tag the given roots with ISOLATE_FOCUS_LAYER and
   * mark external isolate active. Pass `null` or `[]` to clear.
   *
   * Use this instead of mutating layers / `externalIsolateActive` directly so
   * the renderer's per-frame `refreshIsolateLayer()` can re-tag dynamically
   * added descendants of these roots.
   */
  setExternalIsolated(roots: Object3D[] | null): void {
    // Clear any previous external state first
    for (const node of this._externalIsolatedRoots) {
      untagIsolateSubtree(node);
    }
    this._externalIsolatedRoots = [];
    if (!roots || roots.length === 0) {
      this.externalIsolateActive = false;
      return;
    }
    this._externalIsolatedRoots = roots.slice();
    for (const node of this._externalIsolatedRoots) {
      tagIsolateSubtree(node);
    }
    this.externalIsolateActive = true;
  }

  /**
   * Expand each input node to its closest registered group-root ancestor (or
   * the node itself if it's a registered root). Nodes with no registered
   * ancestor are passed through unchanged. Result is deduplicated.
   *
   * Use this so plugin-driven isolates (e.g. the docs browser, where a doc is
   * attached to a leaf mesh) end up isolating the same containers a user would
   * see when isolating the surrounding group from the Groups window.
   */
  expandToContainingGroups(nodes: Object3D[]): Object3D[] {
    const roots = new Set<Object3D>();
    for (const g of this._groups.values()) {
      for (const n of g.nodes) roots.add(n);
    }
    const result = new Set<Object3D>();
    for (const node of nodes) {
      let cur: Object3D | null = node;
      let matched: Object3D | null = null;
      while (cur) {
        if (roots.has(cur)) { matched = cur; break; }
        cur = cur.parent;
      }
      result.add(matched ?? node);
    }
    return [...result];
  }

  /**
   * Re-enable ISOLATE_FOCUS_LAYER on every descendant of every isolated root.
   * Idempotent and cheap (O(subtree-size)). Called by the renderer each frame
   * while isolate is active so that dynamically added children (spawned MUs,
   * gripper pickups, async-loaded geometry, etc.) inherit the focus layer.
   */
  refreshIsolateLayer(): void {
    for (const node of this._isolatedNodes) tagIsolateSubtree(node);
    for (const node of this._externalIsolatedRoots) tagIsolateSubtree(node);
  }

  /** True if an isolate is currently active (group-based or external). */
  get isIsolateActive(): boolean {
    return this._isolateActiveName !== null || this.externalIsolateActive;
  }

  /**
   * True if `node` (or any ancestor) is one of the currently isolated roots
   * (group-isolated or externally-isolated). Used by the viewer's isolation
   * gate to restrict raycast hover/select to the isolated subtree.
   *
   * Returns false when no isolate is active — callers should gate on
   * {@link isIsolateActive} first to avoid pointless walks.
   */
  isInIsolatedSubtree(node: Object3D): boolean {
    if (this._isolatedNodes.length === 0 && this._externalIsolatedRoots.length === 0) {
      return false;
    }
    let cur: Object3D | null = node;
    while (cur) {
      for (const root of this._isolatedNodes) if (root === cur) return true;
      for (const root of this._externalIsolatedRoots) if (root === cur) return true;
      cur = cur.parent;
    }
    return false;
  }

  /** Name of the currently isolated group, or null. */
  get isolatedGroupName(): string | null {
    return this._isolateActiveName;
  }

  /** Get all group names, sorted alphabetically. */
  getGroupNames(): string[] {
    return [...this._groups.keys()].sort();
  }

  /** Number of registered groups. */
  get groupCount(): number {
    return this._groups.size;
  }

  /** Mark a group as kinematic (structural, not user-facing visibility). */
  markAsKinematic(name: string): void {
    if (this._groups.has(name)) {
      this._kinematicGroups.add(name);
    }
  }

  /** Check if a group is marked as kinematic. */
  isKinematic(name: string): boolean {
    return this._kinematicGroups.has(name);
  }

  /** Get all group names marked as kinematic. */
  getKinematicGroupNames(): string[] {
    return [...this._kinematicGroups];
  }

  /** Clear all groups. */
  clear(): void {
    this._clearIsolateState();
    this._groups.clear();
    this._kinematicGroups.clear();
  }
}
