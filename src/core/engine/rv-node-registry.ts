// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVDrive } from './rv-drive';
import type { RVSensor } from './rv-sensor';
import { lastPathSegment } from './rv-constants';
import { sanitizeLikeThree } from './rv-three-names';
import { tooltipRegistry } from '../hmi/tooltip/tooltip-registry';
import { ROOT_OCCURRENCE, ROOT_SOURCE_KEY, fullNodeAddress, getNodeId } from './rv-node-id';

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
  /** Optional display label provided by the matched component's SearchDisplayResolver. */
  displayText?: string;
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
 * A node/component that consumes a signal (points at it by name or owns it as a
 * child node). Shape-compatible with `ReverseReference` in rv-inspector-helpers,
 * so the tooltip / property inspector can render both `getReferencesTo()` and
 * `getComponentsForSignal()` results uniformly.
 *   - `sourcePath`    — hierarchy path of the CONSUMING node (the component owner).
 *   - `fieldName`     — the field that names the signal (e.g. `SignalBool`),
 *                       or `'Signals'` for a parent-walk owner (child-node binding).
 *   - `componentType` — the consuming component type (e.g. `WebSensor`, `Drive`).
 */
export interface SignalConsumerRef {
  sourcePath: string;
  fieldName: string;
  componentType: string;
}

/**
 * A component type key is a SIGNAL type (a PLC signal node), not a signal
 * CONSUMER. Used by the parent-walk to skip past `Signals` container children
 * and stop at the first owning NON-signal component (Drive/Sensor/…). Kept local
 * to avoid importing rv-inspector-helpers (which imports from the engine — would
 * create a cycle).
 */
function isSignalComponentTypeKey(type: string): boolean {
  return type.startsWith('PLCInput') || type.startsWith('PLCOutput');
}

/**
 * Bare component name from a Unity componentType.
 *
 * The GLB serializer writes the C# type NAMESPACED (`realvirtual.MachiningTool`,
 * `UnityEngine.Transform`), while every TypeScript component is registered under its
 * bare name (`MachiningTool`). Callers that compare exactly must strip the namespace
 * first, or the component is reported as unknown even though it exists.
 *
 * `UnityEngine.Transform` is deliberately NOT stripped: `resolve()` treats that exact
 * string as the wire contract for a plain node reference, and a bare `Transform` is
 * not a component the registry knows.
 */
export function stripComponentNamespace(componentType: string): string {
  if (!componentType || componentType === 'UnityEngine.Transform') return componentType;
  const dot = componentType.lastIndexOf('.');
  return dot >= 0 ? componentType.slice(dot + 1) : componentType;
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
  /**
   * node → alias paths registered for it via {@link registerAlias}.
   *
   * Aliases deliberately do NOT appear in `nodePaths` (the canonical reverse
   * map), which is exactly why `unregisterSubtree` used to leave them behind:
   * it iterates `nodePaths`. Tracking them per object closes that leak
   * (plan-381 F11) — without it an alias kept resolving to a node that had been
   * removed from the scene (delete + re-import, CADLink re-import, planner
   * remove), handing callers a detached Object3D.
   */
  private aliasPaths = new Map<Object3D, string[]>();
  /**
   * `sanitizeLikeThree(path)` → the registered path(s) that sanitize to it —
   * the index behind resolution stage 4 (plan-734 F4).
   *
   * Values are a bare string for the overwhelmingly common single-claimant case
   * and only grow into an array when a second path collides, which keeps the
   * per-key cost at one reference for a 65k-node model. Paths (not nodes) are
   * stored so a removal is an exact splice by path: an alias and its canonical
   * path denote ONE node, and the ambiguity check has to be over distinct
   * nodes, which is resolved at query time against `nodes`.
   *
   * `null` until the first stage-4 lookup — a model whose paths all resolve
   * exactly never pays for it. Once built it is maintained INCREMENTALLY and is
   * never rebuilt: `MuReconciler.reconcile()` calls `registerNode` /
   * `unregisterSubtree` every frame while the layout planner runs, so a
   * dirty-flag + rebuild scheme would throw the index away several times a
   * second and pay O(nodes) on the next miss.
   */
  private sanitizedPathIndex: Map<string, string | string[]> | null = null;
  /** How often the stage-4 index was built from scratch. Must stay 1 in a session. */
  private _sanitizedIndexBuilds = 0;
  /** Stage-4 keys already warned about as ambiguous (once per key per registry). */
  private _warnedSanitizedKeys = new Set<string>();
  /** targetPath → Set of {sourcePath, fieldName, componentType} (reverse ref index) */
  private reverseRefs = new Map<string, Array<{ sourcePath: string; fieldName: string; componentType: string }>>();
  /** Whether the reverse-ref index has been built (built lazily on first getReferencesTo). */
  private _reverseRefsBuilt = false;

  /**
   * signalName → consumers that reference the signal by its string name. Distinct
   * from `reverseRefs` (which indexes ComponentReference OBJECTS by targetPath):
   * signal bindings are loose STRING names (`WebSensor.SignalBool = "MC07…"`), so
   * `getReferencesTo(signalName)` never finds them. Built lazily on first
   * `getComponentsForSignal()` call and invalidated on structural change
   * (`clear()` / `recomputePathsForSubtrees()`).
   */
  private signalNameIndex = new Map<string, SignalConsumerRef[]>();
  /** Whether the signal-name index has been built (built lazily on first getComponentsForSignal). */
  private _signalNameIndexBuilt = false;

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

    // Incremental stage-4 maintenance — never a rebuild (see sanitizedPathIndex).
    this._indexSanitizedPath(path);
  }

  /**
   * Register an alias path for a node (e.g. original GLTF name before Three.js dedup).
   * Adds to path→node and suffixMap but does NOT update nodePaths (reverse lookup),
   * so the canonical path remains the primary identifier for the node.
   *
   * @returns `false` when the path was already claimed and the alias was
   *   therefore discarded. Giving up silently is the right behaviour — a real
   *   registration must win over a historical spelling — but it used to be
   *   completely unobservable, and a discarded alias that shadows a live node
   *   is exactly the kind of thing that shows up as "highlight does nothing"
   *   three customers later (plan-734 F8).
   */
  registerAlias(aliasPath: string, node: Object3D): boolean {
    const existing = this.nodes.get(aliasPath);
    if (existing) return false; // Don't overwrite an existing node registration

    this.nodes.set(aliasPath, node);

    const suffix = lastPathSegment(aliasPath);
    let arr = this.suffixMap.get(suffix);
    if (!arr) {
      arr = [];
      this.suffixMap.set(suffix, arr);
    }
    arr.push(aliasPath);

    this._indexSanitizedPath(aliasPath);

    // Remember the alias so unregisterSubtree can take it down with the node.
    let aliases = this.aliasPaths.get(node);
    if (!aliases) {
      aliases = [];
      this.aliasPaths.set(node, aliases);
    }
    aliases.push(aliasPath);
    return true;
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

  /**
   * Unregister a single component instance at a path (asset editor
   * `removeComponent`). Leaves the node itself registered. No-op when the
   * path/type is unknown.
   */
  unregisterComponent(type: string, path: string): void {
    const compMap = this.components.get(path);
    if (compMap) {
      compMap.delete(type);
      if (compMap.size === 0) this.components.delete(path);
    }
    const typeSet = this.typeIndex.get(type);
    if (typeSet) {
      typeSet.delete(path);
      if (typeSet.size === 0) this.typeIndex.delete(type);
    }
  }

  // ─── Lookup by Path ─────────────────────────────────────────────

  /** Get raw Object3D by full hierarchy path */
  getNode(path: string): Object3D | null {
    return this._getNode(path, true);
  }

  /**
   * @param warnOnAmbiguity Emit the F10 "refusing to guess" warning. Suppressed
   *   for the internal probe in {@link getByPath}, which does its OWN ambiguity
   *   check over component instances: an ambiguous node lookup there is not yet
   *   a failure (only one of the candidates may carry the requested type), so
   *   warning would put a scary message next to a perfectly good result.
   */
  private _getNode(path: string, warnOnAmbiguity: boolean): Object3D | null {
    // Direct lookup (most common case)
    const direct = this.nodes.get(path);
    if (direct) return direct;

    // Normalize path: Three.js GLTF loader sanitizes names (spaces → underscores)
    const [, normalized] = this._lookupSpellings(path);
    if (normalized !== path) {
      const normDirect = this.nodes.get(normalized);
      if (normDirect) return normDirect;
    }

    // Suffix match using the suffix map for O(1) lookup.
    //
    // Every matching candidate is collected instead of returning at the first
    // hit (plan-381 F10): with two branches carrying the same leaf
    // (`CellA/PartA/Signal`, `CellB/PartA/Signal`) the old loop returned
    // whichever happened to be registered first, so the SAME query resolved to
    // a different object depending on GLB node order. Ambiguity is measured
    // over distinct NODES, not paths — an alias and its canonical path both
    // match but denote one node, which must stay resolvable.
    const querySuffix = lastPathSegment(path);
    const candidates = this.suffixMap.get(querySuffix);
    if (candidates) {
      let found: Object3D | null = null;
      let matchedPaths: string[] | null = null;
      for (const registeredPath of candidates) {
        if (!this._suffixMatches(registeredPath, path, normalized)) continue;
        const node = this.nodes.get(registeredPath);
        if (!node) continue;
        if (found === null) {
          found = node;
          matchedPaths = [registeredPath];
        } else if (node !== found) {
          matchedPaths!.push(registeredPath);
        }
      }
      if (matchedPaths && matchedPaths.length > 1) {
        if (warnOnAmbiguity) {
          console.warn(
            `[NodeRegistry] Ambiguous suffix match for "${path}": ${matchedPaths.length} candidates `
            + `(${matchedPaths.map((p) => `"${p}"`).join(', ')}) — refusing to guess.`,
          );
        }
        return null;
      }
      if (found) return found;
    }

    // Stage 4: sanitize-normalized full-path match (plan-734 F4).
    //
    // Reached ONLY after stage 3 found nothing. A stage-3 *refusal* (several
    // distinct candidates → the F10 "refusing to guess" warning) returns above
    // and never gets here: a refusal is a decision, not a miss, and letting a
    // later stage overturn it would break exactly the guarantee the earlier
    // stages exist to give.
    //
    // What it buys: an ALREADY-DELIVERED GLB, loaded by a viewer whose alias
    // registration predates plan-734, still resolves its authored paths —
    // `sanitizeLikeThree` is the one transform that maps both the authored and
    // the loader-assigned spelling onto the same key.
    return this._resolveSanitized(path, warnOnAmbiguity);
  }

  /**
   * The spellings a lookup tries, in order: the path as given, then with
   * whitespace collapsed to `_` the way Three.js' loader does.
   *
   * Shared by {@link _getNode} and {@link getByPath}, which each carried their
   * own copy of the normalization — and only one of them was ever updated.
   */
  private _lookupSpellings(path: string): [string, string] {
    return [path, path.replace(/ /g, '_')];
  }

  /**
   * Stage 4: find a node whose registered path sanitizes to the same string as
   * the queried path.
   *
   * Has its OWN ambiguity refusal, and needs one: `sanitizeLikeThree` REMOVES
   * `[ ] . : /` rather than replacing them, so two genuinely different authored
   * paths can collapse onto one key. Returning "the first" there would be the
   * silent wrong-node resolution that stages 1-3 were hardened against.
   */
  private _resolveSanitized(path: string, warnOnAmbiguity: boolean): Object3D | null {
    const index = this._ensureSanitizedIndex();
    const key = sanitizeLikeThree(path);
    const entry = index.get(key);
    if (entry === undefined) return null;

    if (typeof entry === 'string') return this.nodes.get(entry) ?? null;

    let found: Object3D | null = null;
    const matched: string[] = [];
    for (const registeredPath of entry) {
      const node = this.nodes.get(registeredPath);
      if (!node) continue;
      if (found === null) { found = node; matched.push(registeredPath); } else if (node !== found) {
        matched.push(registeredPath);
      }
    }
    if (matched.length > 1) {
      if (warnOnAmbiguity && !this._warnedSanitizedKeys.has(key)) {
        this._warnedSanitizedKeys.add(key);
        console.warn(
          `[NodeRegistry] Ambiguous sanitize-normalized match for "${path}": ${matched.length} candidates `
          + `(${matched.map((p) => `"${p}"`).join(', ')}) — refusing to guess.`,
        );
      }
      return null;
    }
    return found;
  }

  /** Build the stage-4 index once, on the first lookup that needs it. */
  private _ensureSanitizedIndex(): Map<string, string | string[]> {
    if (this.sanitizedPathIndex) return this.sanitizedPathIndex;
    const index = new Map<string, string | string[]>();
    this.sanitizedPathIndex = index;
    this._sanitizedIndexBuilds++;
    for (const path of this.nodes.keys()) this._indexSanitizedPath(path);
    return index;
  }

  /**
   * How often the stage-4 index was built from scratch (0 = never needed).
   *
   * A diagnostics hook, and the assertion of the incremental-maintenance test:
   * anything above 1 in a running session means something reintroduced a
   * rebuild on invalidation — the failure mode 2.4 of plan-734 forbids, because
   * the MU reconciler mutates the registry every frame.
   */
  sanitizedIndexBuildCount(): number {
    return this._sanitizedIndexBuilds;
  }

  /** Add one registered path to the stage-4 index (no-op before it is built). */
  private _indexSanitizedPath(path: string): void {
    const index = this.sanitizedPathIndex;
    if (!index) return;
    const key = sanitizeLikeThree(path);
    const entry = index.get(key);
    if (entry === undefined) index.set(key, path);
    else if (typeof entry === 'string') { if (entry !== path) index.set(key, [entry, path]); } else if (!entry.includes(path)) entry.push(path);
  }

  /** Remove one registered path from the stage-4 index (no-op before it is built). */
  private _unindexSanitizedPath(path: string): void {
    const index = this.sanitizedPathIndex;
    if (!index) return;
    const key = sanitizeLikeThree(path);
    const entry = index.get(key);
    if (entry === undefined) return;
    if (typeof entry === 'string') {
      if (entry === path) index.delete(key);
      return;
    }
    const i = entry.indexOf(path);
    if (i >= 0) entry.splice(i, 1);
    // Collapse back to the cheap single-string form so a churning subtree does
    // not leave one-element arrays behind for the life of the registry.
    if (entry.length === 1) index.set(key, entry[0]);
    else if (entry.length === 0) index.delete(key);
  }

  /**
   * Does a registered path end on the queried (partial) path? Both the raw and
   * the space→underscore normalized spelling count as a match; `normalized` is
   * passed in so callers compute it once.
   */
  private _suffixMatches(registeredPath: string, path: string, normalized: string): boolean {
    if (registeredPath === path || registeredPath.endsWith('/' + path)) return true;
    if (normalized !== path
      && (registeredPath === normalized || registeredPath.endsWith('/' + normalized))) return true;
    return false;
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
    const [, normalized] = this._lookupSpellings(path);
    if (normalized !== path) {
      const normMap = this.components.get(normalized);
      if (normMap) {
        const instance = normMap.get(type);
        if (instance !== undefined) return instance as T;
      }
    }

    // Alias-aware fallback: registerAlias() adds alias paths (Phase-8c
    // reparent aliases) to `nodes` but
    // component instances stay keyed under the node's canonical path only.
    // Resolve the node via the alias-aware getNode and retry with its
    // canonical path — this is what lets recorder playback find a Drive by
    // its authored path after re-parenting.
    const aliasNode = this._getNode(path, false);
    if (aliasNode) {
      const canonical = this.nodePaths.get(aliasNode);
      if (canonical && canonical !== path) {
        const cm = this.components.get(canonical);
        if (cm) {
          const instance = cm.get(type);
          if (instance !== undefined) return instance as T;
        }
      }
    }

    // Suffix match using suffixMap for O(1) lookup (instead of O(n) scan).
    //
    // Like getNode(), every candidate is collected rather than returning at the
    // first hit (plan-381 F10). Ambiguity is judged over distinct INSTANCES of
    // the requested type: candidates that merely share the leaf name but carry
    // no component of `type` are not competitors, and an alias path resolving
    // to the same instance is not one either.
    const querySuffix = lastPathSegment(path);
    const candidates = this.suffixMap.get(querySuffix);
    if (candidates) {
      let found: T | null = null;
      let matchedPaths: string[] | null = null;
      for (const registeredPath of candidates) {
        if (!this._suffixMatches(registeredPath, path, normalized)) continue;
        const instance = this.components.get(registeredPath)?.get(type);
        if (instance === undefined) continue;
        if (found === null) {
          found = instance as T;
          matchedPaths = [registeredPath];
        } else if (instance !== found) {
          matchedPaths!.push(registeredPath);
        }
      }
      if (matchedPaths && matchedPaths.length > 1) {
        console.warn(
          `[NodeRegistry] Ambiguous suffix match for "${type}" at "${path}": ${matchedPaths.length} candidates `
          + `(${matchedPaths.map((p) => `"${p}"`).join(', ')}) — refusing to guess.`,
        );
        return null;
      }
      if (found !== null) return found;
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
   *
   * @param scope Optional subtree for a last-resort fallback: when the exact /
   *   alias / suffix path lookups all miss (authored hierarchy no longer exists
   *   — glTF name-dedup drift, editor re-saves), the ref
   *   is resolved by NAME to a descendant of `scope` carrying the requested
   *   component. Callers pass the subtree the ref was authored in (e.g. a
   *   placed asset root), where axis/signal names are unambiguous.
   */
  resolve(ref: ComponentRef | undefined | null, scope?: Object3D | null): {
    drive?: RVDrive | null;
    sensor?: RVSensor | null;
    signalAddress?: string | null;
    /** Plain scene node (Unity `Transform` field). See the generic branch below. */
    node?: Object3D | null;
    /**
     * Any OTHER registered component type, resolved generically (plan-411 §2.2).
     * Present only when a matching instance was actually found — a miss keeps
     * the raw-path pass-through the deferred-resolution consumers rely on
     * (`MachiningVolume.Tools`, DES references), so this field is purely
     * additive and can never turn a working late resolution into a null.
     */
    component?: unknown;
  } {
    if (!ref || ref.type !== 'ComponentReference' || !ref.path) {
      return {};
    }

    // Unity writes the componentType NAMESPACED (`realvirtual.MachiningTool`), and
    // every lookup below compares against the bare TypeScript component name. The
    // known kinds got away with it only because they match via `includes()`; any
    // exact comparison — and every component type added later — has to see the bare
    // name. Strip once, here, so there is exactly one place that knows about it.
    const ct = stripComponentNamespace(ref.componentType ?? '');

    // Drive reference
    if (ct.includes('Drive')) {
      let drive = this.getByPath<RVDrive>('Drive', ref.path);
      if (!drive && scope) drive = this.findComponentInScope<RVDrive>('Drive', ref.path, scope);
      if (!drive) console.warn(`[NodeRegistry] Drive not found: "${ref.path}"`);
      return { drive };
    }

    // Sensor reference
    if (ct.includes('Sensor')) {
      let sensor = this.getByPath<RVSensor>('Sensor', ref.path);
      if (!sensor && scope) sensor = this.findComponentInScope<RVSensor>('Sensor', ref.path, scope);
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
      // Scoped fallback: signal node by name inside the authoring subtree.
      if (scope) {
        const scopedNode = this.findNodeInScope(ref.path, scope);
        if (scopedNode) {
          const resolvedPath = this.nodePaths.get(scopedNode);
          if (resolvedPath) return { signalAddress: resolvedPath };
        }
      }
      // Fallback: return the raw path. It MAY still work — the SignalStore runs
      // its own normalization/suffix resolution over `pathToName`, and a
      // process-image signal legitimately has no scene node at all. But when it
      // does not, the component silently binds to an address nobody writes and
      // the drive simply never moves, with nothing in the console to show for
      // it (plan-381 F6). Hence: say so, without claiming more than we know.
      console.warn(
        `[NodeRegistry] Signal node not found: "${ref.path}" — `
        + 'falling back to the raw path; the signal may not be driven.',
      );
      return { signalAddress: ref.path };
    }

    // Generic NODE reference (plan-362). A Unity `public Transform Anchor`
    // field serializes with componentType `UnityEngine.Transform`; very old
    // exports wrote no componentType at all. Exactly those two cases resolve
    // to the plain scene node:
    //   1. componentType === 'UnityEngine.Transform'  (the wire contract)
    //   2. componentType missing / null / ''          (legacy tolerance)
    // Every OTHER non-empty componentType deliberately keeps today's behavior
    // (unresolved + warning) — treating "unknown" as legacy would silently
    // bend a future reference type onto a node instead of failing visibly.
    if (ct === 'UnityEngine.Transform' || ct === '') {
      let node = this.getNode(ref.path);
      if (!node && scope) node = this.findNodeInScope(ref.path, scope);
      if (!node) console.warn(`[NodeRegistry] Node not found: "${ref.path}"`);
      return { node: node ?? null };
    }

    // GENERIC component reference (plan-411 §2.2). Every type the registry knows
    // resolves the same way the Drive/Sensor branches do — exact path, alias,
    // suffix (all inside getByPath) and finally the scoped name fallback.
    //
    // Before this branch existed, a `realvirtual.KinematicMechanism` reference
    // (and any component type added later) ended here as `{}`, which
    // `resolveComponentRefs()` flattens to `null` for a SCALAR field — the
    // reason plan-404 had to keep the raw path in a component-specific
    // `mechanismRefPath` workaround.
    //
    // A MISS deliberately falls through to the pass-through below instead of
    // returning `{ component: null }`: `MachiningVolume.Tools` and the DES
    // references resolve their raw path LATER, when the target may finally
    // exist. Reporting a miss as a hard null here would break that contract for
    // the sake of a nicer-looking API.
    if (this.typeIndex.has(ct)) {
      let component = this.getByPath<unknown>(ct, ref.path);
      if (component === null && scope) component = this.findComponentInScope<unknown>(ct, ref.path, scope);
      if (component !== null && component !== undefined) return { component };
      console.warn(`[NodeRegistry] ${ct} not found: "${ref.path}"`);
    } else {
      // The warning is about the TYPE, not about the resolution: a component type
      // this registry actually knows is a supported pass-through and must stay silent
      // (before the namespace was stripped, `realvirtual.MachiningTool` was reported as
      // unknown on every load — plan-405 live finding F2). A type nothing in the scene
      // carries is still worth flagging, because then nobody will resolve it later.
      console.warn(`[NodeRegistry] Unknown componentType: "${ref.componentType}" at "${ref.path}"`);
    }
    // RAW PATH pass-through: `resolveComponentRefs()` keeps `ref.path` for array
    // fields when nothing is returned here, and the consuming component resolves
    // it against the registry itself (two-phase construction — the target
    // instance need not exist yet at this point).
    return {};
  }

  /**
   * Scope-limited resolution fallback: first descendant of `scope` whose NAME
   * equals the ref path's last segment and carries a registered component of
   * `type`. Used by resolve() when every path-based lookup misses.
   */
  private findComponentInScope<T>(type: string, refPath: string, scope: Object3D): T | null {
    const name = lastPathSegment(refPath);
    if (!name) return null;
    let found: T | null = null;
    scope.traverse((n: Object3D) => {
      if (found !== null || n.name !== name) return;
      const path = this.nodePaths.get(n);
      if (!path) return;
      const instance = this.components.get(path)?.get(type);
      if (instance !== undefined) found = instance as T;
    });
    return found;
  }

  /** Name-match twin of {@link findComponentInScope} for plain node refs (signals). */
  private findNodeInScope(refPath: string, scope: Object3D): Object3D | null {
    const name = lastPathSegment(refPath);
    if (!name) return null;
    let found: Object3D | null = null;
    scope.traverse((n: Object3D) => {
      if (found !== null || n.name !== name) return;
      if (this.nodePaths.has(n)) found = n;
    });
    return found;
  }

  // ─── Search ────────────────────────────────────────────────────

  /** Search all registered nodes by node name, COMPONENT TYPE and metadata
   *  content (all case-insensitive substring). The component-type match makes
   *  "Drive"/"Sensor" searches work even when node names carry no hint. */
  search(term: string): NodeSearchResult[] {
    if (!term) return [];
    const lower = term.toLowerCase();
    const results: NodeSearchResult[] = [];
    for (const [path, node] of this.nodes) {
      const name = lastPathSegment(path);
      const nameMatched = name.toLowerCase().includes(lower);

      const compMap = this.components.get(path);
      const types = compMap ? [...compMap.keys()] : [];
      const rvType = node.userData?._rvType as string | undefined;
      if (rvType && !types.includes(rvType)) types.push(rvType);

      // Component-type match ("drive" finds every node with a Drive component),
      // then the tooltip-registry metadata resolvers as the last resort.
      let matchedBy: string | undefined;
      if (!nameMatched) {
        matchedBy = types.find((t) => t.toLowerCase().includes(lower));
        if (!matchedBy) {
          const comp = tooltipRegistry.findMatchingComponent(node, term);
          if (!comp) continue; // no match
          matchedBy = comp;
        }
      }
      // Ask the matched component for a display label (e.g. product name from AAS)
      const displayText = matchedBy
        ? tooltipRegistry.getSearchDisplayText(node, matchedBy)
        : null;
      results.push({ path, node, types, matchedBy, ...(displayText ? { displayText } : {}) });
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
   * Built lazily on first getReferencesTo() access (no longer called eagerly
   * on the model-load critical path). Replaces the O(n*m) scan in
   * PropertyInspector's referencedBy useMemo with O(1) lookup.
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
    this._reverseRefsBuilt = true;
  }

  /**
   * O(1) lookup of which nodes reference the given path via ComponentReference.
   * Returns empty array if none. The reverse-ref index is built lazily on
   * first access.
   */
  getReferencesTo(targetPath: string): ReadonlyArray<{ sourcePath: string; fieldName: string; componentType: string }> {
    if (!this._reverseRefsBuilt) this.buildReverseRefIndex();
    return this.reverseRefs.get(targetPath) ?? [];
  }

  /**
   * All signal names that a model component references via a ComponentReference
   * to the signal's node (e.g. `Drive_Cylinder.In` → `.../MC02.09Q00B`). This is
   * the set of signals actually CONSUMED by the model, as opposed to signals that
   * merely exist as PLC nodes but drive nothing.
   *
   * Coupling is by SYMBOL NAME, not scene path: each referenced target path is
   * resolved back to its registered signal name via `nameForPath`. Only signal
   * paths resolve (non-signal reference targets yield undefined and are skipped),
   * so the result is exactly the referenced *signals*. String-field references
   * (`WebSensor.SignalBool = "..."`) are covered separately by the caller via
   * {@link getComponentsForSignal}.
   *
   * Built from the cached reverse-ref index; cheap to call once per model load.
   */
  getComponentReferencedSignalNames(nameForPath: (path: string) => string | undefined): Set<string> {
    if (!this._reverseRefsBuilt) this.buildReverseRefIndex();
    const names = new Set<string>();
    for (const targetPath of this.reverseRefs.keys()) {
      const name = nameForPath(targetPath);
      if (name) names.add(name);
    }
    return names;
  }

  // ─── Signal → Component Binding Index ───────────────────────────

  /**
   * Build the signal-name → consumers index by scanning every registered node's
   * `userData.realvirtual` components for STRING fields whose value is the name
   * of a signal a component binds to.
   *
   * Signal-field detection: the component schema (rv-component-registry.ts) has
   * NO dedicated signal field type — signal references are declared `componentRef`
   * and, once resolved, become plain signal-address STRINGS on the instance and in
   * persisted rv_extras. There is therefore no schema flag to key on, so we take
   * the documented FALLBACK from plan-234 §10-A: index EVERY string field value,
   * keyed by that value. A `getComponentsForSignal(name)` lookup then hits only
   * for fields whose value is exactly that signal name. False positives are rare
   * (a string field that happens to equal a signal name) and tolerable — the
   * consumer is presented as informational binding, never a hard dependency.
   *
   * ComponentReference OBJECT fields (raw `{type:'ComponentReference', path}`) are
   * intentionally SKIPPED here — those are covered by `getReferencesTo(path)`.
   */
  buildSignalNameIndex(): void {
    this.signalNameIndex.clear();
    for (const [sourcePath, node] of this.nodes) {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv || typeof rv !== 'object') continue;
      for (const [compType, compData] of Object.entries(rv)) {
        if (typeof compData !== 'object' || compData === null || Array.isArray(compData)) continue;
        // Skip the signal's OWN definition component (PLCInput*/PLCOutput*): its
        // `Name` field equals the signal name but that is the signal declaring
        // itself, not a consumer binding TO it. Consumers are non-signal
        // components (WebSensor, ConnectSignal, Drive, …).
        if (isSignalComponentTypeKey(compType)) continue;
        for (const [fieldName, value] of Object.entries(compData as Record<string, unknown>)) {
          // Only bare, non-empty strings are signal-name candidates. Objects
          // (ComponentReference / vector3 / ScriptableObject) are skipped — a raw
          // ComponentReference is already covered by getReferencesTo(path).
          if (typeof value !== 'string' || value.length === 0) continue;
          let list = this.signalNameIndex.get(value);
          if (!list) { list = []; this.signalNameIndex.set(value, list); }
          list.push({ sourcePath, fieldName, componentType: compType });
        }
      }
    }
    this._signalNameIndexBuilt = true;
  }

  /**
   * Resolve which components/nodes a signal is bound to.
   *
   * Combines two paths (plan-234 §10-A):
   *   1. **Primary — signal-name index:** components that reference the signal by
   *      its string name (`WebSensor.SignalBool`, `ConnectSignal` fields, Drive
   *      signal slots). Built lazily & cached; O(1) lookup thereafter.
   *   2. **Secondary — parent-walk (only when `signalPath` is given):** for a
   *      signal that lives as a child node (`<Owner>/Signals/*`, Drive/Sensor
   *      auto-signals), walk the node ancestor chain up to the first NON-signal
   *      component and report it as the owner.
   *
   * The caller supplies `signalPath` (via `signalStore.getPath(name)`) so the
   * store is NOT imported here — keeps the engine registry decoupled.
   *
   * Results are deduplicated (by sourcePath + componentType + fieldName) and
   * sorted with the NEAREST owner first (shortest path distance from the signal
   * node; index-only hits sort after path-derived owners). Returns `[]` when the
   * signal is bound to nothing (a pure process-image signal with no node and no
   * consumer — the expected "orphaned" case, not an error).
   */
  getComponentsForSignal(signalName: string, signalPath?: string): SignalConsumerRef[] {
    if (!this._signalNameIndexBuilt) this.buildSignalNameIndex();

    const results: Array<{ ref: SignalConsumerRef; distance: number }> = [];
    const seen = new Set<string>();
    const key = (r: SignalConsumerRef) => `${r.sourcePath} ${r.componentType} ${r.fieldName}`;

    // Primary: string-name index. distance = Infinity so path-derived owners sort first.
    const named = this.signalNameIndex.get(signalName);
    if (named) {
      for (const ref of named) {
        const k = key(ref);
        if (seen.has(k)) continue;
        seen.add(k);
        results.push({ ref, distance: this._pathDistance(signalPath, ref.sourcePath) });
      }
    }

    // Secondary: parent-walk from the signal node up to the first owning
    // non-signal component. Only possible when a signalPath (→ node) is known.
    if (signalPath) {
      const node = this.getNode(signalPath);
      if (node) {
        let current: Object3D | null = node;
        let steps = 0;
        while (current) {
          const ancestorPath = this.nodePaths.get(current);
          if (ancestorPath) {
            const types = this.getComponentTypes(ancestorPath);
            const ownerType = types.find((t) => !isSignalComponentTypeKey(t));
            if (ownerType) {
              const ref: SignalConsumerRef = { sourcePath: ancestorPath, fieldName: 'Signals', componentType: ownerType };
              const k = key(ref);
              if (!seen.has(k)) {
                seen.add(k);
                results.push({ ref, distance: steps });
              }
              break; // nearest owning component found — stop climbing
            }
          }
          current = current.parent;
          steps++;
        }
      }
    }

    // Nearest owner first (shortest path distance); stable within equal distance.
    results.sort((a, b) => a.distance - b.distance);
    return results.map((r) => r.ref);
  }

  /**
   * Hierarchy-distance heuristic between the signal path and a consumer path:
   * 0 when identical, else the number of trailing path segments that differ
   * (how far the consumer sits from the signal). Used only for owner ordering,
   * so an approximate metric is fine; unknown/undefined signalPath → Infinity so
   * index-only hits sort after path-derived (parent-walk) owners.
   */
  private _pathDistance(signalPath: string | undefined, consumerPath: string): number {
    if (!signalPath) return Number.POSITIVE_INFINITY;
    if (signalPath === consumerPath) return 0;
    // If the consumer is an ancestor of the signal (or vice versa), distance is
    // the segment-count difference — the natural "how many levels apart".
    const sp = signalPath.split('/');
    const cp = consumerPath.split('/');
    if (signalPath.startsWith(consumerPath + '/') || consumerPath.startsWith(signalPath + '/')) {
      return Math.abs(sp.length - cp.length);
    }
    // Unrelated branch: count segments from the signal up to the common prefix.
    let common = 0;
    while (common < sp.length && common < cp.length && sp[common] === cp[common]) common++;
    return (sp.length - common) + (cp.length - common);
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
      // The NodeId index is keyed by address, not by path, and is taken down
      // BEFORE the path guard: a node can legitimately carry a NodeId without
      // ever having been path-registered (a referenced subtree whose
      // registration failed part-way), and leaving its address behind would keep
      // handing out an Object3D that is no longer in the scene — the same leak
      // `aliasPaths` had.
      const address = this.nodeAddresses.get(node);
      if (address !== undefined) {
        if (this.nodeIdIndex.get(address) === node) this.nodeIdIndex.delete(address);
        this.nodeAddresses.delete(node);
      }

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
      this._dropFromSuffixMap(path);

      // Alias paths registered for this node (plan-381 F11). They are NOT in
      // `nodePaths`, so this loop is the only thing that ever removes them —
      // without it the alias survived in `nodes`/`suffixMap` and kept handing
      // out a node that is no longer in the scene.
      const aliases = this.aliasPaths.get(node);
      if (aliases) {
        for (const aliasPath of aliases) {
          // Only drop the entry if it still points at THIS node: a later
          // registerNode() may have legitimately claimed the same string.
          if (this.nodes.get(aliasPath) === node) this.nodes.delete(aliasPath);
          this._dropFromSuffixMap(aliasPath);
          // NOT added to `removed`: that set is the contract for downstream
          // purges, which match it against `computeNodePath(component.node)` —
          // always a CANONICAL path. Listing alias spellings there could only
          // ever purge a live component that happens to sit at that path.
        }
        this.aliasPaths.delete(node);
      }
    });

    return removed;
  }

  /** Remove one path from the suffix index, dropping the bucket when empty. */
  private _dropFromSuffixMap(path: string): void {
    const suffix = lastPathSegment(path);
    const arr = this.suffixMap.get(suffix);
    if (arr) {
      const idx = arr.indexOf(path);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) this.suffixMap.delete(suffix);
    }
    // The two indexes are taken down together: every caller that drops a path
    // from the suffix map drops it from the registry entirely.
    this._unindexSanitizedPath(path);
  }

  /**
   * Recompute paths for all registered nodes in the given subtrees.
   * Call after kinematic re-parenting (Phase 8b) to fix stale paths.
   *
   * Updates: nodes, nodePaths, components, typeIndex, suffixMap maps.
   * Does NOT update reverseRefs (built later in Phase 14+).
   *
   * Structural node paths change here → the signal-name index (keyed by
   * consumer sourcePath) is stale. Invalidate its built flag so it is rebuilt
   * lazily on the next getComponentsForSignal() — never from a hot/60-Hz path.
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

        // Stage-4 index follows the move, incrementally (plan-734 §2.4).
        this._unindexSanitizedPath(oldPath);
        this._indexSanitizedPath(newPath);

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

    // Consumer sourcePaths may have moved — invalidate the signal-name index so
    // it is rebuilt lazily on the next lookup (never eagerly here).
    if (updated > 0) this._signalNameIndexBuilt = false;

    return { count: updated, remap };
  }

  /** Clear all registrations (for scene reload) */
  clear(): void {
    this.nodes.clear();
    this.nodePaths.clear();
    this.components.clear();
    this.typeIndex.clear();
    this.suffixMap.clear();
    this.aliasPaths.clear();
    // Back to "never built": a reloaded scene registers its own paths, and the
    // next stage-4 miss builds the index over them. This is NOT the forbidden
    // invalidation-rebuild — clear() is a whole-scene teardown, not a per-frame
    // structural edit.
    this.sanitizedPathIndex = null;
    this._warnedSanitizedKeys.clear();
    // Reset the reverse-ref index (was previously leaked across reloads — §10-E)
    // and the signal-name binding index so a reloaded scene never serves stale
    // bindings. Both rebuild lazily on next access.
    this.reverseRefs.clear();
    this._reverseRefsBuilt = false;
    this.signalNameIndex.clear();
    this._signalNameIndexBuilt = false;
    this.gltfNodeIndices.clear();
    this.gltfNodeNames = [];
    this.gltfNodeSources.clear();
    this.gltfSourceNames.clear();
    // The NodeId index is per-composition: a reloaded scene composes its
    // references afresh, so carrying entries over could only hand out nodes
    // from the previous tree.
    this.nodeIdIndex.clear();
    this.nodeAddresses.clear();
    this.nodeIdRemap.clear();
  }

  // ─── NodeId index — (occurrence, NodeId) → node ─────────────────

  /**
   * `<occurrence>#<NodeId>` → node.
   *
   * COMPOSITE on purpose. `NodeId` is unique inside its own FILE, not globally:
   * reference the same press ten times and all ten subtrees carry the same ids,
   * because they came from the same bytes. A flat `Map<NodeId, Object3D>` — the
   * shape `nodes` above has — would collapse those ten onto one entry, and an
   * edit meant for occurrence 3 would land on whichever happened to register
   * last. The occurrence chain (the ids of the reference nodes above the node)
   * is what tells them apart, and it exists only at runtime: no file ever
   * records where it is installed.
   */
  private nodeIdIndex = new Map<string, Object3D>();

  /** node → its full `<occurrence>#<NodeId>` address (reverse lookup). */
  private nodeAddresses = new Map<Object3D, string>();

  /**
   * Old full address → new full address, for structural changes in a referenced
   * asset (USD had to add `relocate` for the same reason: stable ids alone do
   * not survive someone restructuring the file). Consulted by
   * {@link getNodeByAddress} when the direct lookup misses, so an override
   * written before the change still finds its target instead of orphaning.
   */
  private nodeIdRemap = new Map<string, string>();

  /**
   * Index a node under its occurrence and its own `NodeId`.
   *
   * A node with no `NodeId` is skipped rather than rejected: the entire
   * pre-existing export corpus has none, and those nodes stay perfectly usable
   * through the path index.
   *
   * @param occurrence Chain of the reference nodes above this node; empty for
   *   nodes of the root file.
   * @returns The full address it was registered under, or null when skipped.
   */
  registerNodeId(node: Object3D, occurrence: string = ROOT_OCCURRENCE): string | null {
    const nodeId = getNodeId(node);
    if (!nodeId) return null;
    const address = fullNodeAddress(occurrence, nodeId);

    const existing = this.nodeIdIndex.get(address);
    if (existing && existing !== node) {
      // Two nodes with the same id in the SAME occurrence means the source file
      // is malformed (a producer duplicated an id). Keeping the first and saying
      // so beats silently retargeting every override written against that id.
      console.warn(
        `[NodeRegistry] Duplicate NodeId "${nodeId}" within occurrence "${occurrence || '<root>'}" — `
        + 'keeping the first registration; overrides addressed at this id may target the wrong node.',
      );
      return address;
    }

    this.nodeIdIndex.set(address, node);
    this.nodeAddresses.set(node, address);
    return address;
  }

  /**
   * Index every node of a subtree that carries a `NodeId`.
   * @returns How many nodes were indexed.
   */
  registerNodeIdsForSubtree(root: Object3D, occurrence: string = ROOT_OCCURRENCE): number {
    let count = 0;
    root.traverse((node) => {
      if (this.registerNodeId(node, occurrence)) count++;
    });
    return count;
  }

  /**
   * The node at `(occurrence, nodeId)`, or null.
   *
   * Falls back to the remap table once, so a target that MOVED in an updated
   * referenced asset is still found. The fallback is deliberately single-step:
   * chains of remaps would make the resolution order unpredictable, and one hop
   * covers the case this exists for.
   */
  getNodeByAddress(nodeId: string, occurrence: string = ROOT_OCCURRENCE): Object3D | null {
    const address = fullNodeAddress(occurrence, nodeId);
    const direct = this.nodeIdIndex.get(address);
    if (direct) return direct;
    const remapped = this.nodeIdRemap.get(address);
    if (remapped) return this.nodeIdIndex.get(remapped) ?? null;
    return null;
  }

  /** The full `<occurrence>#<NodeId>` address a node is registered under, or null. */
  getAddressForNode(node: Object3D): string | null {
    return this.nodeAddresses.get(node) ?? null;
  }

  /**
   * Record that a node moved: overrides addressed at `fromAddress` should now
   * resolve to `toAddress`. Both are full `<occurrence>#<NodeId>` addresses.
   */
  addNodeIdRemap(fromAddress: string, toAddress: string): void {
    if (fromAddress === toAddress) return;
    this.nodeIdRemap.set(fromAddress, toAddress);
  }

  /** All full addresses currently indexed (diagnostics, orphan reporting). */
  getRegisteredAddresses(): string[] {
    return [...this.nodeIdIndex.keys()];
  }

  // ─── glTF source indices ────────────────────────────────────────

  /**
   * node → index of the glTF `nodes[]` entry it was loaded from.
   *
   * Only populated for nodes that came from the model GLB itself. Planner
   * placements, op-created nodes and anything parsed by `parseGlbSubtree` have
   * no entry — deliberately, since those are the cases the GLB bake refuses.
   */
  private gltfNodeIndices = new Map<Object3D, number>();

  /**
   * The raw glTF names behind those indices, indexed like the file's `nodes[]`.
   *
   * Kept so a writer that re-fetches the model can prove the bytes it got are
   * the ones these indices describe. Without it an index silently means a
   * different node whenever the URL served something new.
   */
  private gltfNodeNames: readonly (string | undefined)[] = [];

  /**
   * node → which FILE its index belongs to.
   *
   * After composition (plan-397 Phase 3) the tree holds nodes from several
   * files, each numbered from zero in its own `nodes[]`. An index without the
   * file it belongs to is not just useless, it is dangerous: the write path
   * would patch `nodes[7]` of the root file with what belongs in `nodes[7]` of
   * a referenced one. Nodes from the root file carry {@link ROOT_SOURCE_KEY}.
   */
  private gltfNodeSources = new Map<Object3D, string>();

  /** sourceKey → that file's raw glTF node names, for the per-file identity check. */
  private gltfSourceNames = new Map<string, readonly (string | undefined)[]>();

  /** Hand over the load's `associations`-derived index map (see `collectGltfNodeIndices`). */
  setGltfNodeIndices(indices: Map<Object3D, number>, names: readonly (string | undefined)[] = []): void {
    this.gltfNodeIndices = indices;
    this.gltfNodeNames = names;
    this.gltfNodeSources.clear();
    for (const node of indices.keys()) this.gltfNodeSources.set(node, ROOT_SOURCE_KEY);
    this.gltfSourceNames.set(ROOT_SOURCE_KEY, names);
  }

  /**
   * Add the index map of ONE referenced file's occurrence.
   *
   * Called once per composed occurrence: the indices are keyed on that
   * occurrence's own cloned nodes, while `sourceKey` and `names` describe the
   * file they all came from — ten occurrences of one asset add ten index maps
   * under one `sourceKey`.
   */
  addGltfNodeSource(
    sourceKey: string,
    indices: Map<Object3D, number>,
    names: readonly (string | undefined)[] = [],
  ): void {
    for (const [node, index] of indices) {
      this.gltfNodeIndices.set(node, index);
      this.gltfNodeSources.set(node, sourceKey);
    }
    if (!this.gltfSourceNames.has(sourceKey)) this.gltfSourceNames.set(sourceKey, names);
  }

  /**
   * The captured glTF node names, for the source-identity check. Empty when unknown.
   *
   * Without an argument this answers for the ROOT file — the behaviour every
   * pre-composition caller relies on.
   */
  getGltfNodeNames(sourceKey: string = ROOT_SOURCE_KEY): readonly (string | undefined)[] {
    if (sourceKey === ROOT_SOURCE_KEY) return this.gltfNodeNames;
    return this.gltfSourceNames.get(sourceKey) ?? [];
  }

  /** Every file the current tree was composed from, root first. */
  getGltfSourceKeys(): string[] {
    return [...this.gltfSourceNames.keys()];
  }

  /**
   * The glTF `nodes[]` index a path was loaded from, or null when the node is
   * unknown or did not come from the model GLB.
   *
   * Resolution goes through {@link getNode}, so aliases, space-normalisation
   * and the unambiguous-suffix fallback all apply.
   *
   * NOTE for writers: an index alone is only meaningful together with
   * {@link getGltfLocation}'s `sourceKey`. This accessor stays for the
   * single-file callers that predate composition.
   */
  getGltfNodeIndex(path: string): number | null {
    const node = this.getNode(path);
    if (!node) return null;
    return this.gltfNodeIndices.get(node) ?? null;
  }

  /**
   * Which file a path's node came from, and its index there.
   *
   * The pair a writer needs: patch `sourceKey`'s file at `index`, and check that
   * file's own `expectedNames`. `sourceKey === ROOT_SOURCE_KEY` means the node
   * belongs to the scene's own file — anything else belongs to a referenced
   * asset, which this plan says must never be written to (§2.6).
   */
  getGltfLocation(path: string): { sourceKey: string; index: number } | null {
    const node = this.getNode(path);
    if (!node) return null;
    const index = this.gltfNodeIndices.get(node);
    if (index === undefined) return null;
    return { sourceKey: this.gltfNodeSources.get(node) ?? ROOT_SOURCE_KEY, index };
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
