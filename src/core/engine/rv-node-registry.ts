// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVDrive } from './rv-drive';
import type { RVSensor } from './rv-sensor';
import { lastPathSegment } from './rv-constants';
import { tooltipRegistry } from '../hmi/tooltip/tooltip-registry';

/**
 * Search result from NodeRegistry.search().
 */
export interface NodeSearchResult {
  path: string;
  node: Object3D;
  /** Registered component types at this path (e.g. ['Drive', 'TransportSurface']). Empty for plain nodes. */
  types: string[];
  /** Which source matched the search: 'name' (node name), or component type key (e.g. 'AASLink', 'RuntimeMetadata'). */
  matchedBy?: string;
}

/**
 * ComponentReference from GLB extras.
 * Written by GLBComponentSerializer for Signal/Drive/Sensor references.
 */
export interface ComponentRef {
  type: string;        // "ComponentReference"
  path: string;        // Hierarchy path in GLB
  componentType: string; // e.g. "realvirtual.Drive", "realvirtual.PLCOutputBool"
}

/**
 * NodeRegistry - Centralized object discovery for the WebViewer.
 *
 * Mirrors Unity's object lookup API:
 * - Path-based primary lookup (never name-only — names can be duplicated)
 * - Type-based scene-wide queries (like FindObjectsOfType<T>)
 * - Hierarchy walk-up (like GetComponentInParent<T>)
 * - Hierarchy walk-down (like GetComponentInChildren<T> / GetComponentsInChildren<T>)
 * - ComponentReference resolution (replaces resolveComponentRef)
 *
 * Two-phase build:
 *   Phase 1 (GLB traverse): registerNode(path, node)
 *   Phase 2 (after construction): register(type, path, instance)
 */
export class NodeRegistry {
  /** path → Object3D node */
  private nodes = new Map<string, Object3D>();
  /** node → path (reverse lookup for hierarchy walk) */
  private nodePaths = new Map<Object3D, string>();
  /** path → Map<type, instance> */
  private components = new Map<string, Map<string, unknown>>();
  /** type → Set<path> (reverse index for getAll) */
  private typeIndex = new Map<string, Set<string>>();
  /** last path segment → full paths (for O(1) suffix lookup in getNode fallback) */
  private suffixMap = new Map<string, string[]>();
  /** targetPath → Set of {sourcePath, fieldName, componentType} (reverse ref index) */
  private reverseRefs = new Map<string, Array<{ sourcePath: string; fieldName: string; componentType: string }>>();

  // ─── Path Computation ───────────────────────────────────────────

  /**
   * Compute canonical hierarchy path for a Three.js node.
   * Walks up to the scene root, joining names with '/'.
   * Replaces all duplicate getNodePath() functions.
   */
  static computeNodePath(node: Object3D): string {
    const parts: string[] = [];
    let current: Object3D | null = node;
    while (current && current.parent) {
      parts.unshift(current.name);
      current = current.parent;
      if (!current.parent) break; // Stop at scene root
    }
    return parts.join('/');
  }

  // ─── Registration ───────────────────────────────────────────────

  /** Register a raw node by its hierarchy path (Phase 1) */
  registerNode(path: string, node: Object3D): void {
    this.nodes.set(path, node);
    this.nodePaths.set(node, path);

    // Update suffix map for O(1) suffix lookups
    const suffix = lastPathSegment(path);
    let arr = this.suffixMap.get(suffix);
    if (!arr) {
      arr = [];
      this.suffixMap.set(suffix, arr);
    }
    arr.push(path);
  }

  /**
   * Register an alias path for a node (e.g. original GLTF name before Three.js dedup).
   * Adds to path→node and suffixMap but does NOT update nodePaths (reverse lookup),
   * so the canonical path remains the primary identifier for the node.
   */
  registerAlias(aliasPath: string, node: Object3D): void {
    const existing = this.nodes.get(aliasPath);
    if (existing) return; // Don't overwrite an existing node registration

    this.nodes.set(aliasPath, node);

    const suffix = lastPathSegment(aliasPath);
    let arr = this.suffixMap.get(suffix);
    if (!arr) {
      arr = [];
      this.suffixMap.set(suffix, arr);
    }
    arr.push(aliasPath);
  }

  /**
   * Register a typed component instance at a path (Phase 2).
   * A single path can have multiple component types (Drive + TransportSurface, etc.)
   */
  register(type: string, path: string, instance: unknown): void {
    let compMap = this.components.get(path);
    if (!compMap) {
      compMap = new Map<string, unknown>();
      this.components.set(path, compMap);
    }
    compMap.set(type, instance);

    // Update type reverse index
    let typeSet = this.typeIndex.get(type);
    if (!typeSet) {
      typeSet = new Set<string>();
      this.typeIndex.set(type, typeSet);
    }
    typeSet.add(path);
  }

  // ─── Lookup by Path ─────────────────────────────────────────────

  /** Get raw Object3D by full hierarchy path */
  getNode(path: string): Object3D | null {
    // Direct lookup (most common case)
    const direct = this.nodes.get(path);
    if (direct) return direct;

    // Normalize path: Three.js GLTF loader sanitizes names (spaces → underscores)
    const normalized = path.replace(/ /g, '_');
    if (normalized !== path) {
      const normDirect = this.nodes.get(normalized);
      if (normDirect) return normDirect;
    }

    // Suffix match using the suffix map for O(1) lookup
    const querySuffix = lastPathSegment(path);
    const candidates = this.suffixMap.get(querySuffix);
    if (candidates) {
      for (const registeredPath of candidates) {
        if (registeredPath.endsWith('/' + path) || registeredPath === path) {
          return this.nodes.get(registeredPath) ?? null;
        }
        // Also try with normalized path (spaces → underscores)
        if (normalized !== path && (registeredPath.endsWith('/' + normalized) || registeredPath === normalized)) {
          return this.nodes.get(registeredPath) ?? null;
        }
      }
    }
    return null;
  }

  /** Get the registered path for a node */
  getPathForNode(node: Object3D): string | null {
    return this.nodePaths.get(node) ?? null;
  }

  /** Get typed instance by full path and type */
  getByPath<T = unknown>(type: string, path: string): T | null {
    const compMap = this.components.get(path);
    if (compMap) {
      const instance = compMap.get(type);
      if (instance !== undefined) return instance as T;
    }
    // Normalize path: Three.js GLTF loader sanitizes names (spaces → underscores)
    const normalized = path.replace(/ /g, '_');
    if (normalized !== path) {
      const normMap = this.components.get(normalized);
      if (normMap) {
        const instance = normMap.get(type);
        if (instance !== undefined) return instance as T;
      }
    }

    // Suffix match using suffixMap for O(1) lookup (instead of O(n) scan)
    const querySuffix = lastPathSegment(path);
    const candidates = this.suffixMap.get(querySuffix);
    if (candidates) {
      for (const registeredPath of candidates) {
        if (registeredPath.endsWith('/' + path) || registeredPath === path) {
          const cm = this.components.get(registeredPath);
          if (cm) {
            const instance = cm.get(type);
            if (instance !== undefined) return instance as T;
          }
        }
        // Also try with normalized path (spaces → underscores)
        if (normalized !== path && (registeredPath.endsWith('/' + normalized) || registeredPath === normalized)) {
          const cm = this.components.get(registeredPath);
          if (cm) {
            const instance = cm.get(type);
            if (instance !== undefined) return instance as T;
          }
        }
      }
    }
    return null;
  }

  // ─── Scene-Wide Type Queries ────────────────────────────────────

  /** Get all instances of a given type across the scene (like FindObjectsOfType) */
  getAll<T = unknown>(type: string): { path: string; instance: T }[] {
    const typeSet = this.typeIndex.get(type);
    if (!typeSet) return [];

    const results: { path: string; instance: T }[] = [];
    for (const path of typeSet) {
      const compMap = this.components.get(path);
      if (compMap) {
        const instance = compMap.get(type);
        if (instance !== undefined) {
          results.push({ path, instance: instance as T });
        }
      }
    }
    return results;
  }

  // ─── Hierarchy Traversal ────────────────────────────────────────

  /**
   * Walk UP hierarchy from node, find first ancestor with given component type.
   * Like Unity's GetComponentInParent<T>().
   * Checks the node itself first, then walks up.
   */
  findInParent<T = unknown>(node: Object3D, type: string): T | null {
    let current: Object3D | null = node;
    while (current) {
      const path = this.nodePaths.get(current);
      if (path) {
        const compMap = this.components.get(path);
        if (compMap) {
          const instance = compMap.get(type);
          if (instance !== undefined) return instance as T;
        }
      }
      current = current.parent;
    }
    return null;
  }

  /**
   * Walk DOWN hierarchy from node, find first descendant with given component type.
   * Like Unity's GetComponentInChildren<T>().
   * Checks the node itself first, then recurses children (breadth-first).
   */
  findInChildren<T = unknown>(node: Object3D, type: string): T | null {
    // Check self
    const selfPath = this.nodePaths.get(node);
    if (selfPath) {
      const compMap = this.components.get(selfPath);
      if (compMap) {
        const instance = compMap.get(type);
        if (instance !== undefined) return instance as T;
      }
    }

    // BFS through children (index pointer avoids O(n) shift)
    const queue: Object3D[] = [...node.children];
    let i = 0;
    while (i < queue.length) {
      const child = queue[i++];
      const childPath = this.nodePaths.get(child);
      if (childPath) {
        const compMap = this.components.get(childPath);
        if (compMap) {
          const instance = compMap.get(type);
          if (instance !== undefined) return instance as T;
        }
      }
      for (const grandchild of child.children) {
        queue.push(grandchild);
      }
    }
    return null;
  }

  /**
   * Walk DOWN hierarchy, collect ALL descendants with given component type.
   * Like Unity's GetComponentsInChildren<T>().
   * Includes the node itself if it has the component.
   */
  findAllInChildren<T = unknown>(node: Object3D, type: string): { path: string; instance: T }[] {
    const results: { path: string; instance: T }[] = [];

    const visit = (n: Object3D) => {
      const path = this.nodePaths.get(n);
      if (path) {
        const compMap = this.components.get(path);
        if (compMap) {
          const instance = compMap.get(type);
          if (instance !== undefined) {
            results.push({ path, instance: instance as T });
          }
        }
      }
      for (const child of n.children) {
        visit(child);
      }
    };

    visit(node);
    return results;
  }

  // ─── ComponentReference Resolution ──────────────────────────────

  /**
   * Resolve a ComponentReference from GLB extras to typed instances.
   * Replaces the standalone resolveComponentRef() function.
   */
  resolve(ref: ComponentRef | undefined | null): {
    drive?: RVDrive | null;
    sensor?: RVSensor | null;
    signalAddress?: string | null;
  } {
    if (!ref || ref.type !== 'ComponentReference' || !ref.path) {
      return {};
    }

    const ct = ref.componentType ?? '';

    // Drive reference
    if (ct.includes('Drive')) {
      const drive = this.getByPath<RVDrive>('Drive', ref.path);
      if (!drive) console.warn(`[NodeRegistry] Drive not found: "${ref.path}"`);
      return { drive };
    }

    // Sensor reference
    if (ct.includes('Sensor')) {
      const sensor = this.getByPath<RVSensor>('Sensor', ref.path);
      if (!sensor) console.warn(`[NodeRegistry] Sensor not found: "${ref.path}"`);
      return { sensor };
    }

    // Signal reference (PLCOutputBool, PLCInputBool, etc.)
    // Resolve the C# path to the actual registered Three.js path
    // (handles root prefix mismatch and space→underscore sanitization)
    if (ct.includes('Signal') || ct.includes('PLC')) {
      const node = this.getNode(ref.path);
      if (node) {
        const resolvedPath = this.nodePaths.get(node);
        if (resolvedPath) return { signalAddress: resolvedPath };
      }
      // Fallback: return raw path (may still work if path happens to match)
      return { signalAddress: ref.path };
    }

    console.warn(`[NodeRegistry] Unknown componentType: "${ref.componentType}" at "${ref.path}"`);
    return {};
  }

  // ─── Search ────────────────────────────────────────────────────

  /** Search all registered nodes by path substring AND metadata content (case-insensitive). */
  search(term: string): NodeSearchResult[] {
    if (!term) return [];
    const lower = term.toLowerCase();
    const results: NodeSearchResult[] = [];
    for (const [path, node] of this.nodes) {
      const name = lastPathSegment(path);
      const nameMatched = name.toLowerCase().includes(lower);

      // Check which component's search resolver matched (if not name match)
      let matchedBy: string | undefined;
      if (!nameMatched) {
        const comp = tooltipRegistry.findMatchingComponent(node, term);
        if (!comp) continue; // no match
        matchedBy = comp;
      }

      const compMap = this.components.get(path);
      const types = compMap ? [...compMap.keys()] : [];
      const rvType = node.userData?._rvType as string | undefined;
      if (rvType && !types.includes(rvType)) types.push(rvType);
      results.push({ path, node, types, matchedBy });
    }
    return results;
  }

  /** Get component types registered at a path. Returns empty array if none. */
  getComponentTypes(path: string): string[] {
    const compMap = this.components.get(path);
    return compMap ? [...compMap.keys()] : [];
  }

  /** Get all component instances at a path as [type, instance] pairs. */
  getComponentsAt(path: string): Array<[string, unknown]> {
    const compMap = this.components.get(path);
    return compMap ? [...compMap.entries()] : [];
  }

  // ─── Reverse Reference Index ────────────────────────────────────

  /**
   * Build a reverse-reference index from all rv_extras ComponentReference fields.
   * Call once after scene load (Phase 2 complete). Replaces the O(n*m) scan
   * in PropertyInspector's referencedBy useMemo with O(1) lookup.
   */
  buildReverseRefIndex(): void {
    this.reverseRefs.clear();
    for (const [sourcePath, node] of this.nodes) {
      const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (!rv) continue;
      for (const [compType, compData] of Object.entries(rv)) {
        if (typeof compData !== 'object' || compData === null) continue;
        for (const [fieldName, value] of Object.entries(compData as Record<string, unknown>)) {
          if (
            value && typeof value === 'object' && !Array.isArray(value) &&
            (value as Record<string, unknown>).type === 'ComponentReference' &&
            typeof (value as Record<string, unknown>).path === 'string'
          ) {
            const targetPath = (value as Record<string, unknown>).path as string;
            let list = this.reverseRefs.get(targetPath);
            if (!list) { list = []; this.reverseRefs.set(targetPath, list); }
            list.push({ sourcePath, fieldName, componentType: compType });
          }
        }
      }
    }
  }

  /**
   * O(1) lookup of which nodes reference the given path via ComponentReference.
   * Returns empty array if none. Must call buildReverseRefIndex() first.
   */
  getReferencesTo(targetPath: string): ReadonlyArray<{ sourcePath: string; fieldName: string; componentType: string }> {
    return this.reverseRefs.get(targetPath) ?? [];
  }

  // ─── Iteration ─────────────────────────────────────────────────

  /** Iterate all registered nodes with their paths. */
  forEachNode(callback: (path: string, node: Object3D) => void): void {
    for (const [path, node] of this.nodes) {
      callback(path, node);
    }
  }

  // ─── Utility ────────────────────────────────────────────────────

  /**
   * Unregister an entire subtree (root + all descendants).
   * Removes from nodes, nodePaths, components, typeIndex, suffixMap.
   * Returns the set of removed paths for downstream cleanup.
   */
  unregisterSubtree(root: Object3D): Set<string> {
    const removed = new Set<string>();

    root.traverse((node) => {
      const path = this.nodePaths.get(node);
      if (!path) return;

      removed.add(path);

      // Remove from nodes map
      this.nodes.delete(path);
      this.nodePaths.delete(node);

      // Remove from components and typeIndex
      const compMap = this.components.get(path);
      if (compMap) {
        for (const type of compMap.keys()) {
          const typeSet = this.typeIndex.get(type);
          if (typeSet) {
            typeSet.delete(path);
            if (typeSet.size === 0) this.typeIndex.delete(type);
          }
        }
        this.components.delete(path);
      }

      // Remove from suffixMap
      const suffix = lastPathSegment(path);
      const arr = this.suffixMap.get(suffix);
      if (arr) {
        const idx = arr.indexOf(path);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) this.suffixMap.delete(suffix);
      }
    });

    return removed;
  }

  /**
   * Recompute paths for all registered nodes in the given subtrees.
   * Call after kinematic re-parenting (Phase 8b) to fix stale paths.
   *
   * Updates: nodes, nodePaths, components, typeIndex, suffixMap maps.
   * Does NOT update reverseRefs (built later in Phase 14+).
   */
  recomputePathsForSubtrees(subtreeRoots: Object3D[]): { count: number; remap: Map<string, string> } {
    let updated = 0;
    const remap = new Map<string, string>(); // oldPath → newPath

    for (const root of subtreeRoots) {
      root.traverse((node: Object3D) => {
        const oldPath = this.nodePaths.get(node);
        if (!oldPath) return; // Not registered — skip

        const newPath = NodeRegistry.computeNodePath(node);
        if (newPath === oldPath) return; // Path unchanged — skip

        // Update nodes map
        this.nodes.delete(oldPath);
        this.nodes.set(newPath, node);

        // Update nodePaths reverse map
        this.nodePaths.set(node, newPath);

        // Update suffixMap: remove old, add new
        const oldSuffix = lastPathSegment(oldPath);
        const oldArr = this.suffixMap.get(oldSuffix);
        if (oldArr) {
          const idx = oldArr.indexOf(oldPath);
          if (idx >= 0) oldArr.splice(idx, 1);
          if (oldArr.length === 0) this.suffixMap.delete(oldSuffix);
        }
        const newSuffix = lastPathSegment(newPath);
        let newArr = this.suffixMap.get(newSuffix);
        if (!newArr) {
          newArr = [];
          this.suffixMap.set(newSuffix, newArr);
        }
        newArr.push(newPath);

        // Update components map
        const compMap = this.components.get(oldPath);
        if (compMap) {
          this.components.delete(oldPath);
          this.components.set(newPath, compMap);

          // Update typeIndex
          for (const type of compMap.keys()) {
            const typeSet = this.typeIndex.get(type);
            if (typeSet) {
              typeSet.delete(oldPath);
              typeSet.add(newPath);
            }
          }
        }

        remap.set(oldPath, newPath);
        updated++;
      });
    }

    return { count: updated, remap };
  }

  /** Clear all registrations (for scene reload) */
  clear(): void {
    this.nodes.clear();
    this.nodePaths.clear();
    this.components.clear();
    this.typeIndex.clear();
    this.suffixMap.clear();
  }

  /** Get registry stats */
  get size(): { nodes: number; components: number; types: string[] } {
    let componentCount = 0;
    for (const compMap of this.components.values()) {
      componentCount += compMap.size;
    }
    return {
      nodes: this.nodes.size,
      components: componentCount,
      types: [...this.typeIndex.keys()],
    };
  }
}
