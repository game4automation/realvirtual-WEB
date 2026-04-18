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

import type { Object3D } from 'three';

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
 * Tag a node and all descendants with ISOLATE_FOCUS_LAYER. Idempotent.
 *
 * Special-case `_rvStaticUberSource` meshes: the static uber merge collapses
 * many sources into chunks at scene root and hides the originals. A normal
 * `enable()` would tag the invisible originals — pass 3 (focus only) would
 * still skip them and the chunk lives outside the isolated subtree, so the
 * static-merged geometry of the isolated group never renders bright.
 *
 * Workaround: while isolated, restore the original mesh's visibility and
 * restrict it to ISOLATE_FOCUS_LAYER only (no layer 0). The mesh now renders
 * solely in pass 3; the chunk at scene root still renders only in pass 1
 * (dim backdrop). No double-render, no z-fighting.
 *
 * Saves prior `visible` and `layers.mask` under userData markers so
 * `untagIsolateSubtree()` can fully restore on deactivate.
 */
export function tagIsolateSubtree(root: Object3D): void {
  root.traverse(o => {
    o.layers.enable(ISOLATE_FOCUS_LAYER);
    if (o.userData?._rvStaticUberSource && !o.userData._rvIsoTagged) {
      o.userData._rvIsoSavedVisible = o.visible;
      o.userData._rvIsoSavedLayerMask = o.layers.mask;
      o.userData._rvIsoTagged = true;
      o.visible = true;
      o.layers.set(ISOLATE_FOCUS_LAYER);
    }
  });
}

/**
 * Reverse of {@link tagIsolateSubtree}. Removes ISOLATE_FOCUS_LAYER from every
 * descendant and restores any saved visibility/layer mask on
 * `_rvStaticUberSource` meshes that were forced visible during isolate.
 */
export function untagIsolateSubtree(root: Object3D): void {
  root.traverse(o => {
    if (o.userData._rvIsoTagged) {
      o.visible = o.userData._rvIsoSavedVisible as boolean;
      o.layers.mask = o.userData._rvIsoSavedLayerMask as number;
      delete o.userData._rvIsoTagged;
      delete o.userData._rvIsoSavedVisible;
      delete o.userData._rvIsoSavedLayerMask;
    } else {
      o.layers.disable(ISOLATE_FOCUS_LAYER);
    }
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
   * If the group already exists, the node is added to its nodes list.
   */
  register(resolvedName: string, node: Object3D): void {
    let group = this._groups.get(resolvedName);
    if (!group) {
      group = { name: resolvedName, nodes: [], visible: true };
      this._groups.set(resolvedName, group);
    }
    group.nodes.push(node);
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
