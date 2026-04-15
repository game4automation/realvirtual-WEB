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
  isolate(name: string): void {
    const targetGroup = this._groups.get(name);
    if (!targetGroup) return;

    // Clear any previously applied isolate state first
    if (this._isolateActiveName) {
      this._clearIsolateState();
    }

    for (const node of targetGroup.nodes) {
      this._priorVisibility.push({ node, visible: node.visible });
      node.visible = true;
      node.traverse(o => o.layers.enable(ISOLATE_FOCUS_LAYER));
      this._isolatedNodes.push(node);
    }

    this._isolateActiveName = name;
  }

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
      node.traverse(o => o.layers.disable(ISOLATE_FOCUS_LAYER));
    }
    for (const entry of this._priorVisibility) {
      entry.node.visible = entry.visible;
    }
    this._isolatedNodes = [];
    this._priorVisibility = [];
    this._isolateActiveName = null;
  }

  /** True if an isolate is currently active. */
  get isIsolateActive(): boolean {
    return this._isolateActiveName !== null;
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
