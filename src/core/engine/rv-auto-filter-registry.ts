// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-auto-filter-registry.ts — Auto-discovered filter groups based on component
 * capabilities.
 *
 * Unlike GroupRegistry (which stores explicitly defined groups from GLB extras),
 * AutoFilterRegistry generates "virtual" filter groups from the component
 * capabilities registry. Any component type that has a `filterLabel` capability
 * becomes an auto-filter entry, collecting all scene nodes of that type.
 *
 * Visibility and isolate follow the same patterns as GroupRegistry:
 * - Visibility: `node.visible = false` on component root nodes
 * - Isolate: ISOLATE_FOCUS_LAYER camera layer bit for 3-pass composite rendering
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import { tagIsolateSubtree, untagIsolateSubtree } from './rv-group-registry';
import { getRegisteredCapabilities } from './rv-component-registry';

/** Information about a single auto-filter group. */
export interface AutoFilterGroup {
  /** Component type key (e.g. 'Drive', 'Sensor'). */
  type: string;
  /** Display label from filterLabel capability (e.g. 'Drives', 'Sensors'). */
  label: string;
  /** Badge color hex from capabilities. */
  badgeColor: string;
  /** All Object3D nodes that have this component type. */
  nodes: Object3D[];
  /** Current visibility state. */
  visible: boolean;
}

/**
 * Registry for auto-discovered filter groups based on component capabilities.
 *
 * Built once after model load by scanning NodeRegistry + capabilitiesMap.
 * Supports the same visibility/isolate API surface as GroupRegistry.
 */
/** Optional isolate parameters. */
export interface IsolateOptions {
  /** Override dim-overlay opacity (0-1). Default 0.9. */
  dimOpacity?: number;
  /** Desaturate the dimmed backdrop to grayscale. Default false. */
  dimDesaturate?: boolean;
}

export class AutoFilterRegistry {
  private _filters = new Map<string, AutoFilterGroup>();
  private _isolateActiveName: string | null = null;
  private _isolatedNodes: Object3D[] = [];
  private _priorVisibility: { node: Object3D; visible: boolean }[] = [];
  /** Per-isolate dim opacity override; null = use renderer default (0.9). */
  private _dimOpacity: number | null = null;
  /** Per-isolate desaturation flag; false = full color backdrop. */
  private _dimDesaturate = false;

  /**
   * Build auto-filter groups from NodeRegistry + capabilities.
   * Only includes types with `filterLabel !== null` AND at least one scene node.
   */
  build(nodeRegistry: NodeRegistry): void {
    this._filters.clear();

    for (const [type, caps] of getRegisteredCapabilities()) {
      if (!caps.filterLabel) continue;

      const instances = nodeRegistry.getAll(type);
      if (instances.length === 0) continue;

      const nodes: Object3D[] = [];
      for (const inst of instances) {
        const node = nodeRegistry.getNode(inst.path);
        if (node) nodes.push(node);
      }
      if (nodes.length === 0) continue;

      this._filters.set(type, {
        type,
        label: caps.filterLabel,
        badgeColor: caps.badgeColor,
        nodes,
        visible: true,
      });
    }
  }

  /** Get all auto-filter groups sorted alphabetically by label. */
  getAll(): AutoFilterGroup[] {
    return [...this._filters.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Get a single auto-filter group by component type key. */
  get(type: string): AutoFilterGroup | undefined {
    return this._filters.get(type);
  }

  /** Number of registered auto-filter groups. */
  get filterCount(): number {
    return this._filters.size;
  }

  /**
   * Set visibility for all nodes of a given component type.
   * Sets `node.visible` on component root nodes only.
   */
  setVisible(type: string, visible: boolean): void {
    const filter = this._filters.get(type);
    if (!filter) return;
    filter.visible = visible;
    for (const node of filter.nodes) {
      node.visible = visible;
    }
  }

  /**
   * Isolate: mark the target filter's nodes with ISOLATE_FOCUS_LAYER for
   * 3-pass composite rendering (dim backdrop → overlay → focus on top).
   */
  isolate(type: string, opts?: IsolateOptions): void {
    const target = this._filters.get(type);
    if (!target) return;

    // Clear any previous isolate state
    if (this._isolateActiveName) {
      this._clearIsolateState();
    }

    for (const node of target.nodes) {
      this._priorVisibility.push({ node, visible: node.visible });
      node.visible = true;
      tagIsolateSubtree(node);
      this._isolatedNodes.push(node);
    }

    this._isolateActiveName = type;
    this._dimOpacity = opts?.dimOpacity ?? null;
    this._dimDesaturate = opts?.dimDesaturate ?? false;
    // Raycast restriction is enforced centrally by RVViewer's isolation gate
    // — see RaycastManager.setIsolationGate().
  }

  /** Per-isolate dim opacity override (null = use renderer default 0.9). */
  get dimOpacity(): number | null { return this._dimOpacity; }

  /** Whether the dimmed backdrop should be desaturated to grayscale. */
  get dimDesaturate(): boolean { return this._dimDesaturate; }

  /**
   * Show all: clear isolate state and restore visibility for all filters.
   */
  showAll(): void {
    this._clearIsolateState();
    for (const filter of this._filters.values()) {
      filter.visible = true;
      for (const node of filter.nodes) {
        node.visible = true;
      }
    }
  }

  /** Clear the layer tag and visibility overrides from the last isolate(). */
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
    this._dimDesaturate = false;
  }

  /**
   * Re-enable ISOLATE_FOCUS_LAYER on every descendant of the isolated roots.
   * Idempotent and cheap (O(subtree-size)). Called by the renderer each frame
   * while isolate is active so that dynamically added children inherit the
   * focus layer (spawned MUs, gripper pickups, async-loaded geometry, etc.).
   */
  refreshIsolateLayer(): void {
    for (const node of this._isolatedNodes) tagIsolateSubtree(node);
  }

  /** True if an auto-filter isolate is currently active. */
  get isIsolateActive(): boolean {
    return this._isolateActiveName !== null;
  }

  /**
   * True if `node` (or any ancestor) is under one of the currently isolated
   * filter roots. Used by the viewer's isolation gate to restrict raycast
   * hover/select to the isolated subtree.
   */
  isInIsolatedSubtree(node: Object3D): boolean {
    if (this._isolatedNodes.length === 0) return false;
    let cur: Object3D | null = node;
    while (cur) {
      for (const root of this._isolatedNodes) if (root === cur) return true;
      cur = cur.parent;
    }
    return false;
  }

  /** Type key of the currently isolated filter, or null. */
  get isolatedFilterType(): string | null {
    return this._isolateActiveName;
  }

  /** Clear all filter groups and isolate state. */
  clear(): void {
    this._clearIsolateState();
    this._filters.clear();
  }
}
