// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVDrive } from './rv-drive';
import type { RVSensor } from './rv-sensor';
import { lastPathSegment } from './rv-constants';
import { sanitizeLikeThree } from './rv-three-names';
import { RV_SYNTHETIC_KEY } from './rv-bake-chunk';
import { tooltipRegistry } from '../hmi/tooltip/tooltip-registry';
import {
  ROOT_OCCURRENCE, ROOT_SOURCE_KEY, childOccurrence, fullNodeAddress, occurrenceSegments, parseNodeAddress,
} from './rv-node-id';
import { identityIdOf, type FileIdentity } from './rv-decode-identity';
import { storedValueOfLabel } from './rv-stored-ref-label';
import { getDeferredPlacement, isUnresolvedReferenceNode } from './rv-asset-reference';
import { resolveReferencePath, scopeOf, type PathLookup, type ReferenceScope } from './rv-reference-resolver';
import {
  isComponentReference,
  storedReferenceForm,
  storedReferenceLabel,
  storedReferenceValue,
  type ReferenceLookupStage,
  type ReferenceSpelling,
} from './rv-node-path-rewrite.mjs';

/**
 * A stored reference as {@link NodeRegistry.resolveRef} reads it (plan-769 F6): the
 * address form `{ address }`, the kept form `{ unresolvedPath, reason }`, or a legacy
 * `ComponentReference` / `{ path }` record / path string of a file without `idVersion`.
 */
export type StoredReferenceLike =
  | string
  | {
    address?: unknown; unresolvedPath?: unknown; reason?: unknown; path?: unknown;
    type?: unknown; componentType?: unknown; componentIndex?: unknown;
  }
  | null
  | undefined;

/** A stored reference that reached its node. */
export interface ResolvedRef {
  status: 'resolved';
  node: Object3D;
  /** The ABSOLUTE address it resolved to (`<occurrence>#<id>`). */
  address: string;
  /** `address` = stored as an address; `migrated` = a legacy path, migrated on load (F3). */
  via: 'address' | 'migrated';
}

/** Outcome of {@link NodeRegistry.resolveRef}. */
export type RefResolution =
  | ResolvedRef
  /** The target's occurrence exists but its content is not registered yet (§2.3 rule 3). */
  | { status: 'pending'; address: string; occurrence: string; blocking: Object3D }
  | {
    status: 'unresolved';
    /**
     * `missing` / `ambiguous` / `synthetic-target` — the reference has no target;
     * `no-document` — the referrer lies in no registered document;
     * `no-identity` — a legacy path in a document without an identity record (the
     * caller's old path chain still applies).
     */
    reason: 'missing' | 'ambiguous' | 'synthetic-target' | 'no-document' | 'no-identity';
    address?: string;
    path?: string;
  };

/**
 * What a READER of a stored reference does with it (plan-769 Phase 1b, {@link NodeRegistry.readStoredRef}):
 *
 *  - `resolved` / `pending` / `unresolved` — the verdict of the reference's FILE
 *    (its address, or its path migrated through the file's authored index): final.
 *    An unresolved stored reference is never handed to a guessing stage;
 *  - `legacy` — there is no file to judge it by: the document has no identity
 *    record (`no-identity`: a test fake, a runtime tree), the referrer lies in no
 *    registered document (`no-document`), or the path is not one the file carried
 *    but one the web wrote into the live extras this session (`web-written`: an
 *    editor rename rewrite, the reference field, MCP — a path INPUT in runtime
 *    spelling, D6, until Phase 3 writes addresses). The caller's path lookup applies.
 */
export type StoredRead =
  | ResolvedRef
  | { status: 'pending'; address: string; occurrence: string; blocking: Object3D }
  | { status: 'unresolved'; reason: 'missing' | 'ambiguous' | 'synthetic-target'; address?: string; path?: string }
  | { status: 'legacy'; path: string; reason: 'no-identity' | 'no-document' | 'web-written' };

/** Why a queued reference was dropped without a node (F13). */
export type PendingDropReason = 'missing' | 'placement-missing' | 'placement-cap' | 'unloaded';

/** One queued reference of {@link NodeRegistry.whenResolved}. */
interface PendingRef {
  referrer: Object3D;
  ref: StoredReferenceLike;
  kind: 'path' | 'name' | undefined;
  onResolved: (node: Object3D, resolution: ResolvedRef) => void;
  onDropped: ((reason: PendingDropReason) => void) | undefined;
  /** The reference node whose content the target waits for. */
  blocking: Object3D;
}

/** One located migration finding of {@link NodeRegistry.identityProblemsOf} (plan-769 F4). */
export interface IdentityProblem {
  kind: 'ambiguous' | 'legacySpelling' | 'syntheticTarget';
  referrerPath: string;
  componentType: string;
  field: string;
  writtenPath: string;
}

/** Outcome of {@link NodeRegistry.findNodeForUser} (plan-769 F9). */
export interface UserPathResolution {
  node: Object3D;
  /**
   * `runtime` — the registry path as typed; `authored` — the file's authored path
   * (Unity spelling); `legacy-three` — the exact loader spelling; `guess` — only a
   * guessing stage matched (until plan-770): never store it unchecked.
   */
  via: 'runtime' | 'authored' | 'legacy-three' | 'guess';
  /** Absolute address, for `authored` / `legacy-three`. */
  address?: string;
  /** The guessing stage, for `guess`. */
  stage?: ReferenceLookupStage;
}

/**
 * One entry of the reverse reference index (plan-610): `sourcePath` holds a
 * `ComponentReference` in `componentType.fieldName` that resolves to the key's
 * node. `index` is set for an element of an array field.
 */
export interface ReverseRefEntry {
  sourcePath: string;
  fieldName: string;
  componentType: string;
  index?: number;
}

/**
 * A reference resolved WITH its lookup stage (plan-610, {@link NodeRegistry.resolveWithStage}).
 *
 *  - `node`          — the target node (for a component reference: the node carrying it);
 *  - `stage`         — the lookup that actually hit: `exact`, or a fallback
 *                      (`alias` / `space` / `suffix` / `sanitized` / `name-in-scope`);
 *  - `spelling`      — how the written path relates to `scopeRootPath`
 *                      (relative to it, or root-prefixed with the scope root's name);
 *  - `scopeRootPath` — canonical path of the scope root the spelling refers to
 *                      (`''` = written as an absolute registry path).
 */
export interface StagedReferenceResolution {
  node: Object3D;
  stage: ReferenceLookupStage;
  spelling: ReferenceSpelling;
  scopeRootPath: string;
}

/**
 * How many prefix aliases one lookup may chain (plan-610 Phase 5c) — a moved
 * node inside a moved subtree is one hop. The same bound as the reference
 * depth limit; it also ends any cycle.
 */
const PREFIX_ALIAS_MAX_CHAIN = 16;

/** Internal: a node lookup with the stage that hit. */
interface StagedNode {
  node: Object3D;
  stage: ReferenceLookupStage;
}

/** Internal: where the type-dependent resolution chain landed, and with what value. */
interface ChainHit {
  /**
   * The target node; `null` only for a typed hit whose instance is registered
   * at a path without a `nodes` entry — `resolve` still hands that instance out
   * (the pre-plan-610 contract, plan-614 F4), `resolveWithStage` reports a miss.
   */
  node: Object3D | null;
  /** What `resolve` hands out (the instance, the node). */
  value: unknown;
  stage: ReferenceLookupStage;
  spelling: ReferenceSpelling;
  scopeRootPath: string;
}

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
  path?: string;       // Hierarchy path in GLB (legacy / Unity form; absent on the address forms)
  address?: string;    // plan-769 Phase 3: `#id`, `p#id`, `p/b#id` relative to the file
  unresolvedPath?: string; // plan-769 F4: kept, never guessed
  reason?: string;
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
 * and stop at the first owning NON-signal component (Drive/Sensor/…), and by
 * `buildPreBakeRegistry` to index signal nodes without pulling the whole signal
 * construction stack (and its drive imports) into `prepare`. Kept local to
 * avoid importing rv-inspector-helpers (which imports from the engine — would
 * create a cycle).
 *
 * Deliberately a PREFIX test rather than the `SIGNAL_TYPES` list: it must keep
 * answering for a signal type added later without a second edit site.
 */
export function isSignalComponentTypeKey(type: string): boolean {
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
   * PREFIX aliases (plan-610 Phase 5c): the AUTHORED path of a subtree a
   * pre-bake hook re-parented → the moved node. A path `<prefix>/<rest>` that
   * misses exactly resolves `<rest>` under the moved node's CURRENT path —
   * segment by segment through the registered entries (canonical paths, dedup
   * and sanitize aliases, further prefix aliases for a moved node inside the
   * moved subtree), never by suffix or name. One entry per moved node instead
   * of one alias per descendant. Registered by the place step only
   * ({@link registerPrefixAlias}); an editor move never adds one — there the old
   * path is genuinely gone (`rv-asset-executors.ts` `_remapSubtreePaths`).
   */
  private prefixAliases = new Map<string, Object3D>();
  /** node → its prefix alias paths, so `unregisterSubtree` takes them down with the node. */
  private prefixAliasPaths = new Map<Object3D, string[]>();
  /**
   * AMBIGUOUS re-parent paths (plan-610 Phase 5c): one authored path claimed by
   * two or more DIFFERENT moved nodes → every claimant. Such a path names no
   * node — neither as prefix alias nor as the moved node's exact alias — so the
   * result never depends on which node was registered first; the conflict is
   * reported once ({@link ambiguousPrefixAliasPaths}, `console.warn`).
   */
  private ambiguousPrefixAliases = new Map<string, Set<Object3D>>();
  /**
   * Asset roots the ONE resolver (plan-757 F7, `rv-reference-resolver.ts`)
   * may be relative to, with every name the root is or was known by: the
   * main model root, every placement root, every editor-rebuilt subtree.
   * `initSubtree` registers them; `unregisterSubtree` / `clear` take them
   * down. A scope root's names are what makes step 2 of the tolerant read
   * ("first segment == the asset root's authored or current name") strip a
   * `Arburg/…` prefix on a placement the planner named `Arburg_1`.
   */
  private scopeNames = new Map<Object3D, Set<string>>();
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
  /**
   * CANONICAL target path → referrers (reverse ref index, plan-610). A reference
   * is keyed by the registry path of the node it resolves to WITH its authoring
   * scope (the raw written path only when it resolves nowhere), so an
   * asset-relative and a root-prefixed spelling of the same target land on one
   * key. Array elements carry their `index`.
   */
  private reverseRefs = new Map<string, ReverseRefEntry[]>();
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
    // An ambiguous re-parent path names none of its claimants (plan-610 Phase 5c).
    if (this.ambiguousPrefixAliases.size > 0 && this.ambiguousPrefixAliases.get(aliasPath)?.has(node)) return false;

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
   * Register `prefixPath` — the authored path of a subtree that was RE-PARENTED
   * while the asset was prepared — as a PREFIX alias of `node` (plan-610 Phase
   * 5c): every `<prefixPath>/<rest>` that misses exactly resolves `<rest>` under
   * `node`'s current path, as stage `alias`. Call {@link registerAlias} for the
   * path itself as well; this covers only what lies below it.
   *
   * Exact always wins: the path is refused when a DIFFERENT node owns it (a
   * live registration at the authored path, which then also owns its
   * children), and a prefix alias falls silent the moment a node is registered
   * at its path later. Only for load/bake re-parenting — the interactive
   * editor never calls it.
   *
   * Two DIFFERENT moved nodes with the same authored path (duplicate sibling
   * names) make the path AMBIGUOUS: it then names neither node — the prefix
   * alias is withdrawn and so is the exact alias {@link registerAlias} gave the
   * first claimant — so the outcome does not depend on the registration order.
   * The conflict is reported once with `console.warn` and stays listed in
   * {@link ambiguousPrefixAliasPaths}; a lookup through it falls to the later,
   * reported stages like any other miss.
   *
   * @returns `false` when the path was refused or is ambiguous.
   */
  registerPrefixAlias(prefixPath: string, node: Object3D): boolean {
    if (prefixPath === '') return false;
    const claimants = this.ambiguousPrefixAliases.get(prefixPath);
    if (claimants) {
      if (!claimants.has(node)) {
        claimants.add(node);
        this._rememberPrefixPath(node, prefixPath);
      }
      this._dropAmbiguousExactAlias(prefixPath, claimants);
      return false;
    }
    const existing = this.prefixAliases.get(prefixPath);
    if (existing === node) return true;
    if (existing !== undefined) {
      // One authored path, two moved nodes: name neither, whichever came first.
      this.prefixAliases.delete(prefixPath);
      const both = new Set<Object3D>([existing, node]);
      this.ambiguousPrefixAliases.set(prefixPath, both);
      this._rememberPrefixPath(node, prefixPath);
      this._dropAmbiguousExactAlias(prefixPath, both);
      const where = [...both].map((n) => this.nodePaths.get(n) ?? n.name).sort();
      console.warn(`[NodeRegistry] ambiguous re-parent path "${prefixPath}": claimed by ${where.map((w) => `"${w}"`).join(' and ')} — it resolves to neither (plan-610 Phase 5c)`);
      return false;
    }
    const owner = this.nodes.get(prefixPath);
    if (owner !== undefined && owner !== node) return false;
    this.prefixAliases.set(prefixPath, node);
    this._rememberPrefixPath(node, prefixPath);
    return true;
  }

  /** Number of registered (unambiguous) prefix aliases (diagnostics, tests). */
  prefixAliasCount(): number {
    return this.prefixAliases.size;
  }

  /**
   * Authored re-parent paths claimed by more than one moved node, sorted — they
   * resolve to none of them ({@link registerPrefixAlias}). Diagnostics, tests.
   */
  ambiguousPrefixAliasPaths(): string[] {
    return [...this.ambiguousPrefixAliases.keys()].sort();
  }

  private _rememberPrefixPath(node: Object3D, prefixPath: string): void {
    let paths = this.prefixAliasPaths.get(node);
    if (!paths) {
      paths = [];
      this.prefixAliasPaths.set(node, paths);
    }
    if (!paths.includes(prefixPath)) paths.push(prefixPath);
  }

  /**
   * Withdraw the exact alias an ambiguous re-parent path gave one of its
   * claimants (first come in {@link registerAlias}); a canonical registration
   * or an alias of a non-claimant at that path is left alone.
   */
  private _dropAmbiguousExactAlias(prefixPath: string, claimants: ReadonlySet<Object3D>): void {
    const holder = this.nodes.get(prefixPath);
    if (holder === undefined || !claimants.has(holder) || this.nodePaths.get(holder) === prefixPath) return;
    this.nodes.delete(prefixPath);
    this._dropFromSuffixMap(prefixPath);
    const aliases = this.aliasPaths.get(holder);
    if (aliases) {
      const i = aliases.indexOf(prefixPath);
      if (i >= 0) aliases.splice(i, 1);
      if (aliases.length === 0) this.aliasPaths.delete(holder);
    }
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

  // ─── Reference scopes (plan-757 F7 / D12) ──────────────────────

  /**
   * Declare `root` an asset root references may be relative to, with the
   * names it is or was known by (its current name is always included).
   * Idempotent and additive; taken down with `unregisterSubtree(root)`.
   */
  registerScopeNames(root: Object3D, names: Iterable<string | undefined | null>): void {
    let set = this.scopeNames.get(root);
    if (!set) this.scopeNames.set(root, (set = new Set()));
    if (root.name) set.add(root.name);
    for (const n of names) if (n) set.add(n);
  }

  /** Is `root` a registered reference scope? */
  isScopeRoot(root: Object3D): boolean {
    return this.scopeNames.has(root);
  }

  /**
   * The {@link ReferenceScope} of `root` for the ONE resolver: its registry
   * path, its registered names and the leaf names of its aliases. `root` need
   * not be a registered scope — a bare subtree resolves relative to itself.
   */
  scopeFor(root: Object3D): ReferenceScope {
    const rootPath = this.nodePaths.get(root) ?? NodeRegistry.computeNodePath(root);
    const names: string[] = [];
    const registered = this.scopeNames.get(root);
    if (registered) names.push(...registered);
    const aliases = this.aliasPaths.get(root);
    if (aliases) for (const a of aliases) names.push(lastPathSegment(a));
    return scopeOf(root, rootPath, names);
  }

  /**
   * The scope a node was authored in: the nearest registered scope root at or
   * above it, else the node itself. What a runtime-created component (editor
   * "add component") resolves its references relative to.
   */
  enclosingScope(node: Object3D): ReferenceScope {
    for (let cur: Object3D | null = node; cur; cur = cur.parent) {
      if (this.scopeNames.has(cur)) return this.scopeFor(cur);
    }
    return this.scopeFor(node);
  }

  private _scopeArg(scope: Object3D | ReferenceScope | null | undefined): ReferenceScope | null {
    if (!scope) return null;
    if ((scope as ReferenceScope).rootNames instanceof Set) return scope as ReferenceScope;
    return this.enclosingScope(scope as Object3D);
  }

  /**
   * THE path resolver (plan-757 F7): `path` as authored inside `scope` — as
   * written, then with the asset root's name stripped, else `null`. Without a
   * scope the path is looked up as written against the whole registry.
   */
  resolvePath(path: string, scope?: Object3D | ReferenceScope | null): Object3D | null {
    return resolveReferencePath(this, path, this._scopeArg(scope)).node;
  }

  /** The component of `type` registered on `node`, by its canonical path. */
  componentOn<T = unknown>(node: Object3D, type: string): T | null {
    const path = this.nodePaths.get(node);
    if (!path) return null;
    const instance = this.components.get(path)?.get(type);
    return instance === undefined ? null : (instance as T);
  }

  // ─── Lookup by Path ─────────────────────────────────────────────

  /** Get raw Object3D by full hierarchy path */
  getNode(path: string): Object3D | null {
    return this._getNode(path, true);
  }

  /**
   * The node registered under exactly `path` — its canonical path, a
   * registered alias, or a path into a subtree re-parented at load (prefix
   * alias) — and nothing else: no space normalisation, no suffix match, no
   * sanitized-name stage. plan-774 review fix E6: what a CLASSIFICATION
   * ("does this path lie inside a placed reference?") must use, where a
   * guessing stage would answer for a different node.
   */
  getNodeExact(path: string): Object3D | null {
    return this.nodes.get(path) ?? this._resolvePrefixAlias(path, 0);
  }

  /**
   * @param warnOnAmbiguity Emit the F10 "refusing to guess" warning. Suppressed
   *   for the internal probe in {@link getByPath}, which does its OWN ambiguity
   *   check over component instances: an ambiguous node lookup there is not yet
   *   a failure (only one of the candidates may carry the requested type), so
   *   warning would put a scary message next to a perfectly good result.
   */
  private _getNode(path: string, warnOnAmbiguity: boolean): Object3D | null {
    return this._getNodeStaged(path, warnOnAmbiguity)?.node ?? null;
  }

  /**
   * {@link _getNode} with the stage that hit (plan-610) — the ONE implementation
   * of the node lookup chain; `_getNode` is this without the stage.
   */
  private _getNodeStaged(path: string, warnOnAmbiguity: boolean): StagedNode | null {
    // Direct lookup (most common case). A hit under a path that is not the
    // node's canonical one is an ALIAS hit.
    const direct = this.nodes.get(path);
    if (direct) return { node: direct, stage: this.nodePaths.get(direct) === path ? 'exact' : 'alias' };

    // A path INTO a subtree re-parented at load (plan-610 Phase 5c): exact
    // through the prefix alias of the moved node, therefore an ALIAS hit.
    const viaPrefix = this._resolvePrefixAlias(path, 0);
    if (viaPrefix) return { node: viaPrefix, stage: 'alias' };

    // Normalize path: Three.js GLTF loader sanitizes names (spaces → underscores)
    const [, normalized] = this._lookupSpellings(path);
    if (normalized !== path) {
      const normDirect = this.nodes.get(normalized) ?? this._resolvePrefixAlias(normalized, 0);
      if (normDirect) return { node: normDirect, stage: 'space' };
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
      if (found) return { node: found, stage: 'suffix' };
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
    const sanitized = this._resolveSanitized(path, warnOnAmbiguity);
    return sanitized ? { node: sanitized, stage: 'sanitized' } : null;
  }

  /**
   * The prefix-alias stage (plan-610 Phase 5c, {@link registerPrefixAlias}):
   * the LONGEST proper prefix of `path` that is a prefix alias names the moved
   * node; the rest is looked up under the node's current canonical path —
   * exactly (a registered canonical or alias entry), else through a further
   * prefix alias (a moved node that was itself inside a moved subtree). No
   * suffix, no name, no shorter prefix after the longest one matched: the
   * authored prefix names its node definitively, and a miss below it is a miss.
   *
   * Scope-correct by construction: a prefix alias is registered with the
   * instance root's registry path in front, and every candidate key it builds
   * lies under the moved node's own canonical path — so it cannot land in
   * another placement. `depth` bounds a chain (and any cycle) like the
   * reference depth limit does.
   */
  private _resolvePrefixAlias(path: string, depth: number): Object3D | null {
    if ((this.prefixAliases.size === 0 && this.ambiguousPrefixAliases.size === 0) || depth > PREFIX_ALIAS_MAX_CHAIN) return null;
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
      const prefix = path.slice(0, cut);
      const target = this.prefixAliases.get(prefix);
      if (target === undefined) {
        // An ambiguous authored prefix names no node: a miss, never a shorter guess.
        if (this.ambiguousPrefixAliases.has(prefix)) return null;
        continue;
      }
      // A node registered at the authored path since then owns its children.
      const owner = this.nodes.get(prefix);
      if (owner !== undefined && owner !== target) return null;
      const canonical = this.nodePaths.get(target);
      if (canonical === undefined) return null;
      const candidate = `${canonical}/${path.slice(cut + 1)}`;
      return this.nodes.get(candidate) ?? this._resolvePrefixAlias(candidate, depth + 1);
    }
    return null;
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
    // plan-755 R11: a node the bake CREATED (a partition object) was never an
    // authored path, so no delivered GLB can spell it in a pre-sanitized form —
    // stage 4 has nothing to repair for it. Letting it in only widens the
    // collision surface: its name is free text (`MC01.13`, `A|B`), and a
    // collision makes stage 4 refuse the AUTHORED path it collides with. It
    // stays fully addressable through stages 1–3 by its real path.
    if (this.nodes.get(path)?.userData?.[RV_SYNTHETIC_KEY] === true) return;
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
    const hit = this._getByPathStaged(type, path, true);
    return hit ? (hit.instance as T) : null;
  }

  /**
   * {@link getByPath} with the canonical path and the lookup stage that hit
   * (plan-610) — the ONE implementation of the typed lookup chain.
   */
  private _getByPathStaged(
    type: string,
    path: string,
    warnOnAmbiguity: boolean,
  ): { instance: unknown; path: string; stage: ReferenceLookupStage } | null {
    const compMap = this.components.get(path);
    if (compMap) {
      const instance = compMap.get(type);
      if (instance !== undefined) return { instance, path, stage: 'exact' };
    }
    // Normalize path: Three.js GLTF loader sanitizes names (spaces → underscores)
    const [, normalized] = this._lookupSpellings(path);
    if (normalized !== path) {
      const normMap = this.components.get(normalized);
      if (normMap) {
        const instance = normMap.get(type);
        if (instance !== undefined) return { instance, path: normalized, stage: 'space' };
      }
    }

    // Alias-aware fallback: registerAlias() adds alias paths (Phase-8c
    // reparent aliases) to `nodes` but
    // component instances stay keyed under the node's canonical path only.
    // Resolve the node via the alias-aware getNode and retry with its
    // canonical path — this is what lets recorder playback find a Drive by
    // its authored path after re-parenting.
    const aliasHit = this._getNodeStaged(path, false);
    if (aliasHit) {
      const canonical = this.nodePaths.get(aliasHit.node);
      if (canonical && canonical !== path) {
        const cm = this.components.get(canonical);
        if (cm) {
          const instance = cm.get(type);
          if (instance !== undefined) {
            return { instance, path: canonical, stage: aliasHit.stage === 'exact' ? 'alias' : aliasHit.stage };
          }
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
      let found: unknown = null;
      let foundPath: string | null = null;
      let matchedPaths: string[] | null = null;
      for (const registeredPath of candidates) {
        if (!this._suffixMatches(registeredPath, path, normalized)) continue;
        const instance = this.components.get(registeredPath)?.get(type);
        if (instance === undefined) continue;
        if (found === null) {
          found = instance;
          foundPath = registeredPath;
          matchedPaths = [registeredPath];
        } else if (instance !== found) {
          matchedPaths!.push(registeredPath);
        }
      }
      if (matchedPaths && matchedPaths.length > 1) {
        if (warnOnAmbiguity) {
          console.warn(
            `[NodeRegistry] Ambiguous suffix match for "${type}" at "${path}": ${matchedPaths.length} candidates `
            + `(${matchedPaths.map((p) => `"${p}"`).join(', ')}) — refusing to guess.`,
          );
        }
        return null;
      }
      if (found !== null && foundPath !== null) return { instance: found, path: foundPath, stage: 'suffix' };
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
   * @param scope The asset the reference was authored in (a placed asset
   *   root, the main model root, or a {@link ReferenceScope}). plan-757 F7:
   *   the path is resolved FIRST through the ONE resolver inside that scope —
   *   as written, then with the asset root's name stripped (`Arburg/Kine` on
   *   the placement `Layout/Arburg_1`) — so ten placements never resolve each
   *   other's axes. Only when both miss do the registry-wide stages (exact /
   *   alias / suffix / sanitized) run, and last a NAME match to a descendant
   *   of `scope` carrying the requested component (legacy tolerance for an
   *   authored hierarchy that no longer exists).
   * @param referrer plan-769 F6: the node carrying the reference. A STORED
   *   reference — one whose document is known through `referrer` or `scope` — is
   *   read by {@link readStoredRef} FIRST: its address, or its legacy `path`
   *   through the file's migration (authored index). That verdict is FINAL
   *   (Phase 1b): a stored reference the file does not resolve is a miss, never
   *   handed to the guessing stages above; a typed miss on the addressed node is
   *   a miss too. The path chain runs only for a `legacy` read (no identity
   *   record, no document, or a path the web wrote this session — an input) and
   *   for a call without referrer AND scope (the plugin API with a bare path).
   *   An address-form ref (`{ address }`, `{ unresolvedPath }`) never reaches it.
   */
  resolve(ref: ComponentRef | undefined | null, scope?: Object3D | ReferenceScope | null, referrer?: Object3D | null): {
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
    /** plan-769: the node came from the address index (`address` stored, `migrated` legacy path). */
    resolvedVia?: 'address' | 'migrated';
  } {
    if (!ref || ref.type !== 'ComponentReference') return {};
    const stored = ref as unknown as { address?: unknown; unresolvedPath?: unknown };
    const addressForm = typeof stored.address === 'string' || typeof stored.unresolvedPath === 'string';
    if (!addressForm && !ref.path) return {};
    const chain = this._resolveChain(ref, scope, true, referrer ?? null, addressForm, true);
    const hit = chain.hit;
    if (chain.via && hit?.node === chain.addressed) {
      const out = this._resolveOutcome(ref, chain);
      out.resolvedVia = chain.via;
      return out;
    }
    if (addressForm && !hit) return {};
    return this._resolveOutcome(ref, chain);
  }

  /** The typed result of {@link resolve} for one chain outcome. */
  private _resolveOutcome(ref: ComponentRef, chain: ReturnType<NodeRegistry['_resolveChain']>): {
    drive?: RVDrive | null;
    sensor?: RVSensor | null;
    signalAddress?: string | null;
    node?: Object3D | null;
    component?: unknown;
    resolvedVia?: 'address' | 'migrated';
  } {
    const hit = chain.hit;
    // plan-769 Phase 3: the label of any stored form (path, address, kept path).
    const label = storedReferenceLabel(ref) ?? '';

    switch (chain.kind) {
      case 'drive': {
        const drive = (hit?.value ?? null) as RVDrive | null;
        if (!drive) console.warn(`[NodeRegistry] Drive not found: "${label}"`);
        return { drive };
      }
      case 'sensor': {
        const sensor = (hit?.value ?? null) as RVSensor | null;
        if (!sensor) console.warn(`[NodeRegistry] Sensor not found: "${label}"`);
        return { sensor };
      }
      case 'signal': {
        const resolvedPath = hit?.node ? this.nodePaths.get(hit.node) : undefined;
        if (resolvedPath) return { signalAddress: resolvedPath };
        // Fallback: return the raw path. It MAY still work — the SignalStore runs
        // its own normalization/suffix resolution over `pathToName`, and a
        // process-image signal legitimately has no scene node at all. But when it
        // does not, the component silently binds to an address nobody writes and
        // the drive simply never moves, with nothing in the console to show for
        // it (plan-381 F6). Hence: say so, without claiming more than we know.
        console.warn(
          `[NodeRegistry] Signal node not found: "${label}" — `
          + 'falling back to the raw path; the signal may not be driven.',
        );
        return { signalAddress: ref.path ?? label };
      }
      case 'node': {
        if (!hit) console.warn(`[NodeRegistry] Node not found: "${label}"`);
        return { node: hit?.node ?? null };
      }
      case 'component': {
        if (hit) return { component: hit.value };
        console.warn(`[NodeRegistry] ${chain.ct} not found: "${label}"`);
        break;
      }
      case 'unknown':
        // The warning is about the TYPE, not about the resolution: a component type
        // this registry actually knows is a supported pass-through and must stay silent
        // (before the namespace was stripped, `realvirtual.MachiningTool` was reported as
        // unknown on every load — plan-405 live finding F2). A type nothing in the scene
        // carries is still worth flagging, because then nobody will resolve it later.
        console.warn(`[NodeRegistry] Unknown componentType: "${ref.componentType}" at "${label}"`);
        break;
    }
    // RAW PATH pass-through: `resolveComponentRefs()` keeps `ref.path` for array
    // fields when nothing is returned here, and the consuming component resolves
    // it against the registry itself (two-phase construction — the target
    // instance need not exist yet at this point).
    return {};
  }

  /**
   * Resolve a reference like {@link resolve} — the SAME type-dependent chain —
   * but report WHERE it landed instead of the runtime value (plan-610): the
   * target node, the lookup stage that actually hit, the spelling of the
   * written path and the scope root that spelling refers to. Quiet (no
   * warnings) and side-effect free; `null` when the chain misses (where
   * `resolve` would fall back to the raw path or to `null`).
   *
   * `componentType` overrides `ref.componentType` (the plan-610 rewrite passes
   * `undefined` → `''` for a declared path-string field, i.e. a plain node).
   */
  resolveWithStage(
    ref: { path: string; componentType?: string | null } | null | undefined,
    componentType: string | null | undefined,
    scope?: Object3D | ReferenceScope | null,
  ): StagedReferenceResolution | null {
    if (!ref || typeof ref.path !== 'string' || ref.path === '') return null;
    const chain = this._resolveChain(
      { type: 'ComponentReference', path: ref.path, componentType: componentType ?? ref.componentType ?? '' },
      scope,
      false,
    );
    const hit = chain.hit;
    if (!hit || !hit.node) return null;
    const { spelling, scopeRootPath } = hit;
    return { node: hit.node, stage: hit.stage, spelling, scopeRootPath };
  }

  /**
   * THE type-dependent resolution chain of {@link resolve} / {@link resolveWithStage}:
   * the ONE resolver inside the authoring scope first, then the registry-wide
   * stages (exact / alias / space / suffix / sanitized), last the NAME match to
   * a descendant of the scope root. `warn` keeps the ambiguity warnings of the
   * lookup stages exactly where `resolve` always emitted them.
   */
  private _resolveChain(
    ref: ComponentRef,
    scope: Object3D | ReferenceScope | null | undefined,
    warn: boolean,
    referrer: Object3D | null = null,
    addressOnly = false,
    stored = false,
  ): {
    kind: 'drive' | 'sensor' | 'signal' | 'node' | 'component' | 'unknown';
    ct: string;
    hit: ChainHit | null;
    /** plan-769: set when the address index named the node ({@link addressed}). */
    via?: 'address' | 'migrated';
    addressed?: Object3D;
  } {
    // Unity writes the componentType NAMESPACED (`realvirtual.MachiningTool`), and
    // every lookup below compares against the bare TypeScript component name. The
    // known kinds got away with it only because they match via `includes()`; any
    // exact comparison — and every component type added later — has to see the bare
    // name. Strip once, here, so there is exactly one place that knows about it.
    const ct = stripComponentNamespace(ref.componentType ?? '');
    // The path branches below run only for the PATH form (an address-form ref is
    // answered by the address index above them, or not at all).
    const refPath = ref.path ?? '';

    // plan-757 F7: the ONE resolver inside the authoring scope comes first. The
    // lookup it is handed records the stage of the node lookup that hit
    // (plan-610: a root-prefixed path can still land via a suffix fallback).
    const refScope = this._scopeArg(scope);
    let scopedStage: ReferenceLookupStage = 'exact';
    let scopedSpelling: ReferenceSpelling = 'relative';
    let scopedNode: Object3D | null = null;
    // plan-769 F6: the address index first — for an address-form ref always, for
    // a legacy path when the referrer or the scope names its document (its file's
    // migration, no guessing). Phase 1b: that verdict is FINAL for a reference the
    // file carries; only a `legacy` read goes on to the path chain below.
    let via: 'address' | 'migrated' | undefined;
    if (referrer || addressOnly || (stored && scope)) {
      const r = this.readStoredRef(referrer, ref as unknown as StoredReferenceLike, { scope });
      if (r.status === 'resolved') { scopedNode = r.node; via = r.via; }
      else if (r.status !== 'legacy' || addressOnly) {
        // A stored reference that names no node is unresolved — never guessed.
        return { kind: addressOnly ? 'unknown' : this._chainKind(ct), ct, hit: null };
      }
    }
    if (refScope && !scopedNode) {
      const lookup: PathLookup = {
        getNode: (p: string) => {
          const r = this._getNodeStaged(p, warn);
          scopedStage = r?.stage ?? 'exact';
          return r?.node ?? null;
        },
      };
      const res = resolveReferencePath(lookup, refPath, refScope);
      scopedNode = res.node;
      if (res.step === 'root-stripped') {
        scopedSpelling = 'root-prefixed';
        // The scope root itself (`Machine` alone) is found without a lookup.
        if (res.node === refScope.root && res.lookupPath === refScope.rootPath) scopedStage = 'exact';
      }
    }
    const scopeRoot = refScope?.root ?? null;
    const scopeRootPath = refScope?.rootPath ?? '';

    type Hit = ChainHit;
    const fromScope = (value: unknown): Hit => ({
      node: scopedNode!, value, stage: scopedStage, spelling: scopedSpelling, scopeRootPath,
    });
    // A registry-wide hit: an EXACT one was written as the absolute path; a
    // fallback one is healed relative to the authoring scope when it lies in it.
    const fromRegistry = (node: Object3D, value: unknown, stage: ReferenceLookupStage): Hit => {
      if (stage === 'exact' || !refScope) return { node, value, stage, spelling: 'relative', scopeRootPath: '' };
      const p = this.nodePaths.get(node) ?? '';
      const inScope = scopeRootPath === '' || p === scopeRootPath || p.startsWith(scopeRootPath + '/');
      return { node, value, stage, spelling: 'relative', scopeRootPath: inScope ? scopeRootPath : '' };
    };
    const typed = (type: string): Hit | null => {
      if (scopedNode) {
        const inst = this.componentOn<unknown>(scopedNode, type);
        if (inst !== null) return fromScope(inst);
      }
      // The address named the node: a missing component there is a miss, not a
      // reason to look for one elsewhere by path or name (plan-769 1b).
      if (addressOnly || via) return null;
      const byPath = this._getByPathStaged(type, refPath, warn);
      if (byPath) {
        // plan-614 F4: an instance found by path is THE answer, exactly as
        // before plan-610 — also when its path has no node entry (then there is
        // no node to report, and no later stage is consulted).
        const node = this.nodes.get(byPath.path) ?? null;
        return node
          ? fromRegistry(node, byPath.instance, byPath.stage)
          : { node: null, value: byPath.instance, stage: byPath.stage, spelling: 'relative', scopeRootPath: '' };
      }
      if (scopeRoot) {
        const byName = this.findComponentNodeInScope(type, refPath, scopeRoot);
        if (byName) return fromRegistry(byName.node, byName.instance, 'name-in-scope');
      }
      return null;
    };
    // `registeredOnly`: the signal branch only accepts a node with a registry
    // path (its address) and then tries the next stage — exactly as before.
    const plainNode = (registeredOnly: boolean): Hit | null => {
      const ok = (n: Object3D | null): n is Object3D => !!n && (!registeredOnly || this.nodePaths.has(n));
      if (addressOnly || via) return scopedNode && ok(scopedNode) ? fromScope(scopedNode) : null;
      const r = scopedNode ? null : this._getNodeStaged(refPath, warn);
      if (scopedNode) {
        if (ok(scopedNode)) return fromScope(scopedNode);
      } else if (r && ok(r.node)) {
        return fromRegistry(r.node, r.node, r.stage);
      }
      if (scopeRoot) {
        const byName = this.findNodeInScope(refPath, scopeRoot);
        if (ok(byName)) return fromRegistry(byName, byName, 'name-in-scope');
      }
      return null;
    };

    // Drive reference
    const addr = via && scopedNode ? { via, addressed: scopedNode } : {};
    if (ct.includes('Drive')) return { kind: 'drive', ct, hit: typed('Drive'), ...addr };
    // Sensor reference
    if (ct.includes('Sensor')) return { kind: 'sensor', ct, hit: typed('Sensor'), ...addr };
    // Signal reference (PLCOutputBool, PLCInputBool, etc.)
    // Resolve the C# path to the actual registered Three.js path
    // (handles root prefix mismatch and space→underscore sanitization)
    if (ct.includes('Signal') || ct.includes('PLC')) {
      return { kind: 'signal', ct, hit: plainNode(true), ...addr };
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
    if (ct === 'UnityEngine.Transform' || ct === '') return { kind: 'node', ct, hit: plainNode(false), ...addr };
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
    // A MISS deliberately falls through to the pass-through in `resolve`
    // instead of returning `{ component: null }`: `MachiningVolume.Tools` and the
    // DES references resolve their raw path LATER, when the target may finally
    // exist. Reporting a miss as a hard null there would break that contract for
    // the sake of a nicer-looking API.
    if (this.typeIndex.has(ct)) return { kind: 'component', ct, hit: typed(ct), ...addr };
    return { kind: 'unknown', ct, hit: null };
  }

  /** The branch {@link _resolveChain} takes for a (namespace-stripped) component type. */
  private _chainKind(ct: string): 'drive' | 'sensor' | 'signal' | 'node' | 'component' | 'unknown' {
    if (ct.includes('Drive')) return 'drive';
    if (ct.includes('Sensor')) return 'sensor';
    if (ct.includes('Signal') || ct.includes('PLC')) return 'signal';
    if (ct === 'UnityEngine.Transform' || ct === '') return 'node';
    if (this.typeIndex.has(ct)) return 'component';
    return 'unknown';
  }

  /**
   * Quiet twin of the SIGNAL branch of {@link resolve} (plan-566): the same
   * three stages in the same order — the ONE resolver inside `scope`, the
   * registry-wide lookup, the scoped name match — but without warnings, and
   * with the outcome spelled out for the signal cross-reference list.
   *
   * - `path`     — the canonical registry path of the signal node, or the raw
   *               path when nothing resolved (what the runtime falls back to);
   * - `resolved` — a node was found;
   * - `byName`   — found only by the legacy name match inside the scope.
   */
  resolveSignalReference(
    refPath: string,
    scope?: Object3D | ReferenceScope | null,
  ): { path: string; resolved: boolean; byName: boolean } {
    if (!refPath) return { path: refPath, resolved: false, byName: false };
    const refScope = this._scopeArg(scope);
    let node = refScope ? resolveReferencePath(this, refPath, refScope).node : null;
    if (!node) node = this._getNode(refPath, false);
    let byName = false;
    if (!node && refScope) {
      node = this.findNodeInScope(refPath, refScope.root);
      byName = node !== null;
    }
    const resolvedPath = node ? this.nodePaths.get(node) : undefined;
    return resolvedPath
      ? { path: resolvedPath, resolved: true, byName }
      : { path: refPath, resolved: false, byName: false };
  }

  /**
   * Scope-limited resolution fallback: first descendant of `scope` whose NAME
   * equals the ref path's last segment and carries a registered component of
   * `type`. Used by resolve() when every path-based lookup misses. Returns the
   * node with the instance (plan-610 reports where the fallback landed).
   */
  private findComponentNodeInScope(
    type: string, refPath: string, scope: Object3D,
  ): { node: Object3D; instance: unknown } | null {
    const name = lastPathSegment(refPath);
    if (!name) return null;
    let found: { node: Object3D; instance: unknown } | null = null;
    scope.traverse((n: Object3D) => {
      if (found !== null || n.name !== name) return;
      const path = this.nodePaths.get(n);
      if (!path) return;
      const instance = this.components.get(path)?.get(type);
      if (instance !== undefined) found = { node: n, instance };
    });
    return found;
  }

  /** Name-match twin of {@link findComponentNodeInScope} for plain node refs (signals). */
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
   *
   * plan-610: keyed by the CANONICAL target — every reference is resolved with
   * its authoring scope through the same chain as {@link resolve} (typed, then
   * as a plain node), so `Mount/Kine` and `Machine/Mount/Kine` meet on one key;
   * only a reference that resolves nowhere is keyed by its raw path. Scalar
   * fields and the elements of array fields (with `index`) are indexed; alias
   * registrations are skipped (one node, one walk).
   */
  buildReverseRefIndex(): void {
    this.reverseRefs.clear();
    for (const [sourcePath, node] of this.nodes) {
      if (this.nodePaths.get(node) !== sourcePath) continue; // alias entry
      const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (!rv) continue;
      for (const [compType, compData] of Object.entries(rv)) {
        if (typeof compData !== 'object' || compData === null || Array.isArray(compData)) continue;
        for (const [fieldName, value] of Object.entries(compData as Record<string, unknown>)) {
          if (isComponentReference(value)) {
            this._indexReverseRef(node, value, { sourcePath, fieldName, componentType: compType });
          } else if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
              const el: unknown = value[index];
              if (isComponentReference(el)) {
                this._indexReverseRef(node, el, { sourcePath, fieldName, componentType: compType, index });
              }
            }
          }
        }
      }
    }
    this._reverseRefsBuilt = true;
  }

  private _indexReverseRef(
    referrer: Object3D,
    ref: { path?: string; address?: string; unresolvedPath?: string; componentType?: unknown },
    entry: ReverseRefEntry,
  ): void {
    const form = storedReferenceForm(ref);
    if (!form) return;
    let targetPath: string;
    if (form.form !== 'path') {
      // plan-769 Phase 3: an address-form reference names its target by id — the
      // index key is the target's CURRENT path (a kept path keys itself).
      const r = this.readStoredRef(referrer, storedReferenceValue(ref)!);
      targetPath = (r.status === 'resolved' ? this.nodePaths.get(r.node) : undefined) ?? storedReferenceLabel(ref)!;
    } else {
      const query = { path: form.path };
      const ct = typeof ref.componentType === 'string' ? ref.componentType : '';
      const hit = this.resolveWithStage(query, ct, referrer)
        ?? (ct !== '' ? this.resolveWithStage(query, '', referrer) : null);
      targetPath = (hit ? this.nodePaths.get(hit.node) : undefined) ?? form.path;
    }
    let list = this.reverseRefs.get(targetPath);
    if (!list) { list = []; this.reverseRefs.set(targetPath, list); }
    list.push(entry);
  }

  /**
   * Drop the reverse-ref index; it is rebuilt lazily on the next lookup. Called
   * whenever paths or stored references change (plan-610: a re-key in
   * {@link recomputePathsForSubtrees}, the end of every reference-rewrite
   * composite) — never rebuilt eagerly.
   */
  invalidateReverseRefs(): void {
    this.reverseRefs.clear();
    this._reverseRefsBuilt = false;
  }

  /**
   * O(1) lookup of which nodes reference the given path via ComponentReference.
   * Returns empty array if none. The reverse-ref index is built lazily on
   * first access. `targetPath` is a canonical registry path.
   */
  getReferencesTo(targetPath: string): ReadonlyArray<ReverseRefEntry> {
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
      // plan-769: forward-only entries and registered occurrences go with it too.
      this.unregisterNodeId(node);

      // A reference scope goes with its root (plan-757 F7).
      this.scopeNames.delete(node);

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
      // Prefix aliases (plan-610 Phase 5c) go with their node the same way.
      const prefixes = this.prefixAliasPaths.get(node);
      if (prefixes) {
        for (const p of prefixes) {
          if (this.prefixAliases.get(p) === node) this.prefixAliases.delete(p);
          const claimants = this.ambiguousPrefixAliases.get(p);
          if (claimants) {
            claimants.delete(node);
            if (claimants.size === 0) this.ambiguousPrefixAliases.delete(p);
          }
        }
        this.prefixAliasPaths.delete(node);
      }
    });

    return removed;
  }

  /**
   * Remove exactly ONE path registration — `path` → `node` — and leave every
   * other registration in `node`'s subtree alone (plan-567 SOL #8). A synthetic
   * selectable path (`__mu#<n>`, MuReconciler) must not take the document paths
   * of what rides on the carrier with it, which `unregisterSubtree` would.
   * Returns false when `path` does not point at `node`.
   */
  unregisterNode(path: string, node: Object3D): boolean {
    if (this.nodes.get(path) !== node) return false;
    this.nodes.delete(path);
    if (this.nodePaths.get(node) === path) this.nodePaths.delete(node);
    this._dropFromSuffixMap(path);
    return true;
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
   * Invalidates the reverse-ref index (plan-610: it is keyed by canonical paths).
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
    // it is rebuilt lazily on the next lookup (never eagerly here). The
    // reverse-ref index is keyed by canonical paths, so it goes too (plan-610).
    if (updated > 0) {
      this._signalNameIndexBuilt = false;
      this.invalidateReverseRefs();
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
    this.aliasPaths.clear();
    this.prefixAliases.clear();
    this.prefixAliasPaths.clear();
    this.ambiguousPrefixAliases.clear();
    this.scopeNames.clear();
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
    // plan-769: the address book is per load as well; a queued reference of the
    // dropped scene is told why it never resolves.
    this.occurrences.clear();
    this.contentOccurrences.clear();
    this.forwardOnly.clear();
    this.dropPendingRefs('unloaded');
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
    // plan-769: the node's IDENTITY — its authored NodeId, else the id seeded at decode.
    const nodeId = identityIdOf(node);
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

  // ─── Address book (plan-769 F5/F6/F9) ───────────────────────────

  /**
   * Every occurrence whose content is registered: occurrence → the node it is
   * rooted at (the main model root for `''`, the reference node of a placement /
   * frame) and the identity record of the file it came from. The O(1) answer to
   * "is this occurrence there yet?" (spike condition d — no address scan).
   */
  private occurrences = new Map<string, { root: Object3D; identity: FileIdentity | null }>();

  /** Reference node → the occurrence its CONTENT is registered under. */
  private contentOccurrences = new Map<Object3D, string>();

  /**
   * Forward-only entries: `<occurrence>#<content root id>` → the reference node a
   * placement instance is rooted at (spike condition b). The reverse map keeps the
   * node's OWN address (where its file put it) — the address the reference node's
   * own components resolve relative to.
   */
  private forwardOnly = new Map<Object3D, string[]>();

  /** References waiting for a late-materialised occurrence (F13 / §2.3 rule 3). Per load. */
  private pendingRefs: PendingRef[] = [];

  /**
   * Register the nodes of ONE document under `occurrence` (`''` = the main model):
   * `root` and everything below it, STOPPING at reference nodes — a reference node
   * belongs to this file (registered), its content is another occurrence (spike
   * condition a). `identity` is the file's record (migration of legacy paths).
   * Index maintenance hook: re-registering is idempotent per node.
   * @returns How many nodes were indexed.
   */
  registerDocument(root: Object3D, occurrence: string = ROOT_OCCURRENCE, identity?: FileIdentity | null): number {
    const count = this._registerDocumentNodes(root, occurrence, true);
    this.occurrences.set(occurrence, { root, identity: identity ?? null });
    return count;
  }

  /**
   * Register the CONTENT of a placement or composed frame under its occurrence
   * (F5, spike conditions b + c — call it BEFORE the content's init):
   *
   *  - a placement instance is rooted AT the reference node (`instantiate` maps the
   *    asset's template root onto it): the node keeps its own address in the parent
   *    occurrence, the asset's root id becomes a FORWARD-ONLY entry
   *    `<occurrence>#<contentRootId>` → node, and the children are walked;
   *  - a composed frame grafts a CLONE below the reference node: pass it as
   *    `contentRoot`, it is registered like a document root.
   *
   * Nested reference nodes inside the content are registered, their content is not.
   */
  registerOccurrence(
    referenceNode: Object3D,
    occurrence: string,
    opts?: { identity?: FileIdentity | null; contentRootId?: string | null; contentRoot?: Object3D | null },
  ): number {
    let count = 0;
    if (opts?.contentRoot) {
      count = this._registerDocumentNodes(opts.contentRoot, occurrence, true);
    } else {
      const rootId = opts?.contentRootId ?? null;
      if (rootId) {
        const address = fullNodeAddress(occurrence, rootId);
        if (!this.nodeIdIndex.has(address)) {
          this.nodeIdIndex.set(address, referenceNode);
          const list = this.forwardOnly.get(referenceNode) ?? [];
          list.push(address);
          this.forwardOnly.set(referenceNode, list);
          count++;
        }
      }
      for (const child of referenceNode.children) count += this._registerDocumentNodes(child, occurrence, false);
    }
    this.contentOccurrences.set(referenceNode, occurrence);
    this.occurrences.set(occurrence, { root: referenceNode, identity: opts?.identity ?? null });
    return count;
  }

  /**
   * Index maintenance for a subtree an OP attached (plan-769 Phase 2, F5): created,
   * cloned, imported, restored from the trash, rebuilt by a separate / merge. The
   * subtree belongs to the document its parent lies in — registered under that
   * occurrence ({@link docOccurrenceOf} of the parent; a reference node met as the
   * parent's ancestor opens its content), stopping at reference nodes below `root`
   * like {@link registerDocument}. Idempotent per node; a subtree outside every
   * document (no registered ancestor) is left out. The removal side is
   * {@link unregisterSubtree}.
   * @returns How many nodes were indexed.
   */
  registerSubtreeIds(root: Object3D): number {
    const occ = this._parentDocumentOccurrence(root);
    if (occ === null) return 0;
    return this._registerDocumentNodes(root, occ, false);
  }

  /**
   * Index ONE node — a reference node a live operation placed (planner drop,
   * duplicate, paste) — under the document its parent lies in. Its content is its
   * own occurrence ({@link registerOccurrence}); nothing below it is walked.
   * @returns The address, or null (no identity / no registered parent document).
   */
  registerNodeIdInParentDocument(node: Object3D): string | null {
    const occ = this._parentDocumentOccurrence(node);
    return occ === null ? null : this.registerNodeId(node, occ);
  }

  /** The occurrence of the document `node`'s PARENT lies in (a reference node parent opens its content), or null. */
  private _parentDocumentOccurrence(node: Object3D): string | null {
    const parent = node.parent;
    if (!parent) return null;
    return this.isReferenceNode(parent) ? this.contentOccurrenceOf(parent) : this.docOccurrenceOf(parent);
  }

  /** The walk of {@link registerDocument}: index, then descend unless a reference node. */
  private _registerDocumentNodes(node: Object3D, occurrence: string, isRoot: boolean): number {
    let n = 0;
    const visit = (cur: Object3D, top: boolean): void => {
      if (this.registerNodeId(cur, occurrence)) n++;
      if (!top && this.isReferenceNode(cur)) return;
      for (const c of cur.children) visit(c, false);
    };
    visit(node, isRoot);
    return n;
  }

  /**
   * plan-769 F15: the id a placement's reference node answers to INSIDE its content — the
   * asset's content root id of its forward-only entry (`<occ>#<id>`), or null.
   */
  contentRootIdOf(referenceNode: Object3D): string | null {
    const forward = this.forwardOnly.get(referenceNode);
    const first = forward?.[0];
    return first ? parseNodeAddress(first).nodeId : null;
  }

  /** Is the occurrence's content registered? */
  hasOccurrence(occurrence: string): boolean {
    return this.occurrences.has(occurrence);
  }

  /** The identity record of the file registered under `occurrence`, or null. */
  identityOfOccurrence(occurrence: string): FileIdentity | null {
    return this.occurrences.get(occurrence)?.identity ?? null;
  }

  /** The root node an occurrence is registered at (main model root / reference node), or null. */
  rootOfOccurrence(occurrence: string): Object3D | null {
    return this.occurrences.get(occurrence)?.root ?? null;
  }

  /** Registered occurrences (diagnostics, tests). */
  getRegisteredOccurrences(): string[] {
    return [...this.occurrences.keys()];
  }

  /**
   * Remove one node from the id index (index maintenance for ops that delete or
   * replace nodes — Phase 2 wires them; `unregisterSubtree` does it for subtrees).
   */
  unregisterNodeId(node: Object3D): boolean {
    let removed = false;
    const address = this.nodeAddresses.get(node);
    if (address !== undefined) {
      if (this.nodeIdIndex.get(address) === node) this.nodeIdIndex.delete(address);
      this.nodeAddresses.delete(node);
      removed = true;
    }
    const forward = this.forwardOnly.get(node);
    if (forward) {
      for (const a of forward) if (this.nodeIdIndex.get(a) === node) this.nodeIdIndex.delete(a);
      this.forwardOnly.delete(node);
      removed = true;
    }
    const occ = this.contentOccurrences.get(node);
    if (occ !== undefined) {
      if (this.occurrences.get(occ)?.root === node) this.occurrences.delete(occ);
      this.contentOccurrences.delete(node);
    }
    if (this.occurrences.get(ROOT_OCCURRENCE)?.root === node) this.occurrences.delete(ROOT_OCCURRENCE);
    return removed;
  }

  /**
   * A non-embedded reference node: its content is another file, another occurrence.
   * A node whose content was registered as an occurrence, or a placement root
   * (planner record / nested placement markers), counts too.
   */
  isReferenceNode(node: Object3D): boolean {
    if (this.contentOccurrences.has(node)) return true;
    if (isUnresolvedReferenceNode(node)) return true;
    const ud = node.userData as Record<string, unknown> | undefined;
    return typeof ud?._layoutId === 'string' || typeof ud?._layoutNestedOf === 'string';
  }

  /**
   * The occurrence the CONTENT of a reference node lives in: where it was
   * registered, else the deferred mark compose assigned, else the reference node's
   * own address extended by its id. `null` when none can be named.
   */
  contentOccurrenceOf(referenceNode: Object3D): string | null {
    const registered = this.contentOccurrences.get(referenceNode);
    if (registered !== undefined) return registered;
    const mark = getDeferredPlacement(referenceNode);
    if (mark?.occurrence) return mark.occurrence;
    const id = identityIdOf(referenceNode);
    const own = this.nodeAddresses.get(referenceNode);
    if (!id || own === undefined) return null;
    return childOccurrence(parseNodeAddress(own).occurrence, id);
  }

  /**
   * plan-774 F7: the reference node whose MATERIALISED (registered) content a
   * stored reference of `referrer` points into — or `null` when the target lies
   * in the referrer's own file, its placement is not registered (still loading,
   * failed: those are `pending` / `missing-reference`), or nothing says so.
   *
   * `address` is the full address an unresolved read reports (`<occ>#<id>`);
   * `path` a written path, checked by its proper prefixes (innermost first) —
   * the first prefix that resolves, in the referrer's scope, to a reference node
   * with registered content. Used by the audit to tell "the target was baked
   * away inside a placed asset" (`reference-target-baked-away`) from an
   * ordinary unresolved reference.
   */
  placedContentOfTarget(target: { address?: string; path?: string }, referrer: Object3D): Object3D | null {
    if (target.address) {
      const { occurrence } = parseNodeAddress(target.address);
      if (!occurrence || !this.occurrences.has(occurrence)) return null;
      if (this.docOccurrenceOf(referrer) === occurrence) return null;
      for (const [node, occ] of this.contentOccurrences) if (occ === occurrence) return node;
      return null;
    }
    const written = (target.path ?? '').trim().replace(/^\/+/, '');
    if (!written) return null;
    const segments = written.split('/');
    const scope = this.enclosingScope(referrer);
    for (let i = segments.length - 1; i >= 1; i--) {
      const node = resolveReferencePath(this, segments.slice(0, i).join('/'), scope).node;
      if (node && this.contentOccurrences.has(node)) {
        const occ = this.contentOccurrences.get(node)!;
        return this.occurrences.has(occ) ? node : null;
      }
    }
    return null;
  }

  /**
   * F6: `O_doc` of a referrer — the occurrence of the file whose bytes hold it: its
   * own registered address, else the nearest registered ancestor; a REFERENCE node
   * met as an ancestor opens its content occurrence (spike finding). `null` when no
   * ancestor is registered (a node outside every document).
   */
  docOccurrenceOf(referrer: Object3D): string | null {
    for (let n: Object3D | null = referrer; n; n = n.parent) {
      if (n !== referrer && this.isReferenceNode(n)) return this.contentOccurrenceOf(n);
      const a = this.nodeAddresses.get(n);
      if (a !== undefined) return parseNodeAddress(a).occurrence;
    }
    return null;
  }

  /**
   * THE resolution of a STORED reference (plan-769 F6): every stored ref of a file
   * is relative to that file, so `referrer` names it (`O_doc`, {@link docOccurrenceOf}).
   *
   *  - `{ address }` (`#id`, `p#id`, `p/b#id`) → `O_doc` + relative → the id index;
   *  - `{ unresolvedPath, reason }` → unresolved, never guessed;
   *  - a legacy `{ path }` / path string (a file without `idVersion`) → the file's
   *    migration (F3: authored index, exact legacy Three spelling — NO rate stage)
   *    → address → id index (`via: 'migrated'`);
   *  - `kind: 'name'` for a NAME field (`Source.ThisObjectAsMU`).
   *
   * A target whose occurrence exists but has not registered its content yet is
   * `pending`, not missing (§2.3 rule 3). `no-identity` = a legacy path in a
   * document the decode identity never saw (test fakes, runtime trees) — the
   * caller keeps its old path chain for it.
   */
  resolveRef(referrer: Object3D, ref: StoredReferenceLike, opts?: { kind?: 'path' | 'name' }): RefResolution {
    const docOcc = this.docOccurrenceOf(referrer);
    if (docOcc === null) return { status: 'unresolved', reason: 'no-document' };
    return this.resolveRefInOccurrence(docOcc, ref, referrer, opts);
  }

  /**
   * {@link resolveRef} with `O_doc` given — the occurrence of the document the
   * reference is stored in. `nameOwner` is the node a NAME field belongs to.
   */
  resolveRefInOccurrence(
    docOcc: string,
    ref: StoredReferenceLike,
    nameOwner?: Object3D | null,
    opts?: { kind?: 'path' | 'name' },
  ): RefResolution {
    if (ref && typeof ref === 'object') {
      if (typeof ref.address === 'string' && ref.address) return this._resolveAddress(docOcc, ref.address, 'address');
      if (typeof ref.unresolvedPath === 'string') {
        const reason = ref.reason === 'ambiguous' || ref.reason === 'synthetic-target' ? ref.reason : 'missing';
        return { status: 'unresolved', reason, path: ref.unresolvedPath };
      }
    }
    const written = typeof ref === 'string' ? ref : (ref && typeof ref.path === 'string' ? ref.path : '');
    if (!written) return { status: 'unresolved', reason: 'missing', path: '' };
    const identity = this.occurrences.get(docOcc)?.identity ?? null;
    // 9.19: a file with an `idVersion` is NOT migrated — its legacy path has no file
    // verdict (the reader's path lookup applies, exactly as without a record).
    if (!identity || !identity.migrated) return { status: 'unresolved', reason: 'no-identity', path: written };
    let ownerId: string | null = null;
    if (opts?.kind === 'name' && nameOwner) {
      ownerId = this._nearestIdentityId(nameOwner);
      // plan-769 Phase 2: a NAME names a node in its owner's subtree. An owner the
      // web created (a duplicate, an op-built node: its id is no node of the file)
      // carries no name of the file — the copied string equals one, but its subtree
      // is the COPY's. The reader's own subtree lookup answers it (`legacy`).
      if (ownerId !== null && identity.indexOfId(ownerId) === undefined) {
        return { status: 'unresolved', reason: 'no-identity', path: written };
      }
    }
    const migrated = opts?.kind === 'name'
      ? identity.migrateName(written, ownerId)
      : identity.migratePath(written);
    if (migrated.address === undefined) return { status: 'unresolved', reason: migrated.reason, path: written };
    return this._resolveAddress(docOcc, migrated.address, 'migrated', written);
  }

  /**
   * THE read of a STORED reference by its reader (plan-769 Phase 1b — CRI, Source,
   * PhysicsZone, WebVisibility, the logic engine, `resolveComponentRefs`, the
   * audit, …): {@link resolveRef} relative to `referrer` — else to `scope` (a
   * reference node as scope opens its content occurrence) — and the one rule that
   * decides whether the reader's own path lookup may run at all ({@link StoredRead}):
   * only for `legacy`. A reference the FILE carries is resolved, pending or
   * unresolved by its file, and an unresolved one stays unresolved (D7) — the
   * guessing stages are for path INPUTS ({@link findNodeForUser}), not for it.
   */
  readStoredRef(
    referrer: Object3D | null,
    ref: StoredReferenceLike,
    opts?: { kind?: 'path' | 'name'; scope?: Object3D | ReferenceScope | null },
  ): StoredRead {
    // plan-769 Phase 3: a STRING may be the label a component keeps for an address-form
    // reference of `referrer` (`storedRefString`) — read the stored value behind it.
    if (typeof ref === 'string' && referrer) {
      const behind = storedValueOfLabel(referrer, ref);
      if (behind !== undefined) ref = behind;
    }
    const addressForm = !!ref && typeof ref === 'object'
      && (typeof ref.address === 'string' || typeof ref.unresolvedPath === 'string');
    const written = addressForm ? '' : (typeof ref === 'string' ? ref : (ref && typeof ref.path === 'string' ? ref.path : ''));
    let docOcc: string | null = null;
    let owner: Object3D | null = referrer;
    if (referrer) docOcc = this.docOccurrenceOf(referrer);
    else if (opts?.scope) {
      const scope = opts.scope;
      const root = (scope as ReferenceScope).rootNames instanceof Set ? (scope as ReferenceScope).root : scope as Object3D;
      owner = root;
      docOcc = this.isReferenceNode(root) ? this.contentOccurrenceOf(root) : this.docOccurrenceOf(root);
    }
    if (docOcc === null) {
      return written
        ? { status: 'legacy', path: written, reason: 'no-document' }
        : { status: 'unresolved', reason: 'missing' };
    }
    const r = this.resolveRefInOccurrence(docOcc, ref, owner, { kind: opts?.kind });
    if (r.status !== 'unresolved') return r;
    if (r.reason === 'no-identity' || r.reason === 'no-document') {
      return written ? { status: 'legacy', path: written, reason: r.reason } : { status: 'unresolved', reason: 'missing' };
    }
    if (written) {
      const identity = this.occurrences.get(docOcc)?.identity ?? null;
      if (identity && !identity.isFileReference(written, opts?.kind ?? 'path')) {
        return { status: 'legacy', path: written, reason: 'web-written' };
      }
    }
    return { status: 'unresolved', reason: r.reason, ...(r.address !== undefined ? { address: r.address } : {}), ...(r.path !== undefined ? { path: r.path } : {}) };
  }

  /**
   * The NODE a stored reference names ({@link readStoredRef}); for a `legacy` read
   * `legacy(path)` — default {@link getNode}, the caller's historic lookup. `null`
   * for pending / unresolved.
   */
  storedNode(
    referrer: Object3D | null,
    ref: StoredReferenceLike,
    opts?: {
      kind?: 'path' | 'name';
      scope?: Object3D | ReferenceScope | null;
      legacy?: (path: string) => Object3D | null;
    },
  ): Object3D | null {
    const r = this.readStoredRef(referrer, ref, opts);
    if (r.status === 'resolved') return r.node;
    if (r.status === 'legacy') return opts?.legacy ? opts.legacy(r.path) : this.getNode(r.path);
    return null;
  }

  /**
   * The component of `type` a stored reference names: the instance on the addressed
   * node — a typed miss there is a miss — or, for a `legacy` read, `legacy(path)`
   * (default {@link getByPath}).
   */
  storedComponent<T = unknown>(
    referrer: Object3D | null,
    ref: StoredReferenceLike,
    type: string,
    opts?: { scope?: Object3D | ReferenceScope | null; legacy?: (path: string) => T | null },
  ): T | null {
    const r = this.readStoredRef(referrer, ref, opts);
    if (r.status === 'resolved') return this.componentOn<T>(r.node, type);
    if (r.status === 'legacy') return opts?.legacy ? opts.legacy(r.path) : this.getByPath<T>(type, r.path);
    return null;
  }

  /**
   * The audit's judgement of one stored reference (plan-769 Phase 1b): a FILE
   * reference by its file — resolved (stage `exact`, the address is the path as
   * written) or unresolved (`null` + its reason; `pending` is no finding yet) —
   * and a `legacy` one through the old chain ({@link resolveWithStage}), whose
   * fallback stages still surface as `reference-rescued`.
   */
  auditStoredReference(
    ref: { path: string; componentType?: string | null },
    componentType: string | null | undefined,
    referrer: Object3D,
  ): { verdict: 'file'; hit: StagedReferenceResolution | null; reason?: 'missing' | 'ambiguous' | 'synthetic-target' | 'pending'; address?: string }
    | { verdict: 'legacy' } {
    const r = this.readStoredRef(referrer, ref.path);
    if (r.status === 'legacy') return { verdict: 'legacy' };
    if (r.status === 'resolved') {
      return { verdict: 'file', hit: { node: r.node, stage: 'exact', spelling: 'relative', scopeRootPath: '' } };
    }
    if (r.status === 'pending') return { verdict: 'file', hit: null, reason: 'pending' };
    let reason = r.reason;
    if (reason === 'missing') {
      // A written path that names a node the bake MADE (a partition / chunk) is
      // `reference-target-synthetic` — the migration problem, not the audit's.
      const hit = resolveReferencePath(this, ref.path, this.enclosingScope(referrer)).node;
      if (hit && (hit.userData as Record<string, unknown> | undefined)?.[RV_SYNTHETIC_KEY] === true) reason = 'synthetic-target';
    }
    void componentType;
    return { verdict: 'file', hit: null, reason, ...(r.address !== undefined ? { address: r.address } : {}) };
  }

  /**
   * An ADDRESS relative to the document `scopeRoot` opens (a placement root: its
   * content; any other node: the document it lies in) → node, or null. The read
   * side of the Phase-3 forms outside a GLB (`SignalMapping.componentAddress`,
   * an annotation's `nodeAddress`, F19).
   */
  resolveAddressIn(scopeRoot: Object3D, address: string): Object3D | null {
    if (typeof address !== 'string' || !address) return null;
    const r = this.readStoredRef(null, { address }, { scope: scopeRoot });
    return r.status === 'resolved' ? r.node : null;
  }

  /** The identity id of `node` or its nearest ancestor that has one. */
  private _nearestIdentityId(node: Object3D): string | null {
    for (let n: Object3D | null = node; n; n = n.parent) {
      const id = identityIdOf(n);
      if (id) return id;
    }
    return null;
  }

  /** `O_doc` + relative address → node | pending | missing. */
  private _resolveAddress(docOcc: string, relative: string, via: 'address' | 'migrated', path?: string): RefResolution {
    const { occurrence: rel, nodeId } = parseNodeAddress(relative);
    const occ = rel ? (docOcc ? `${docOcc}/${rel}` : rel) : docOcc;
    const address = fullNodeAddress(occ, nodeId);
    const node = this.getNodeByAddress(nodeId, occ);
    if (node) return { status: 'resolved', node, address, via };
    const blocking = this._pendingBlocker(occ);
    if (blocking) return { status: 'pending', address, occurrence: occ, blocking };
    return { status: 'unresolved', reason: 'missing', address, ...(path !== undefined ? { path } : {}) };
  }

  /**
   * The reference node that keeps `occurrence` from being registered — its chain
   * exists up to that node, the node's content does not (yet). `null` when the
   * occurrence is registered or its chain breaks (missing).
   */
  private _pendingBlocker(occurrence: string): Object3D | null {
    if (this.occurrences.has(occurrence)) return null;
    let parent = ROOT_OCCURRENCE;
    for (const seg of occurrenceSegments(occurrence)) {
      const child = childOccurrence(parent, seg);
      if (!this.occurrences.has(child)) {
        if (!this.occurrences.has(parent)) return null;
        const refNode = this.nodeIdIndex.get(fullNodeAddress(parent, seg)) ?? null;
        return refNode && this.isReferenceNode(refNode) ? refNode : null;
      }
      parent = child;
    }
    return null;
  }

  /**
   * Resolve now, or queue until the target's occurrence registers (§2.3 rule 3, F13).
   * `onDropped(reason)` fires when the queue is flushed without a node:
   * `missing` (orphan verdict once no placement is pending), `placement-missing`,
   * `placement-cap` or `unloaded`.
   */
  whenResolved(
    referrer: Object3D,
    ref: StoredReferenceLike,
    onResolved: (node: Object3D, resolution: ResolvedRef) => void,
    onDropped?: (reason: PendingDropReason) => void,
    opts?: { kind?: 'path' | 'name' },
  ): RefResolution {
    const r = this.resolveRef(referrer, ref, opts);
    if (r.status === 'resolved') onResolved(r.node, r);
    else if (r.status === 'pending') {
      this.pendingRefs.push({ referrer, ref, kind: opts?.kind, onResolved, onDropped, blocking: r.blocking });
    }
    return r;
  }

  /** How many references wait for an occurrence. */
  pendingRefCount(): number {
    return this.pendingRefs.length;
  }

  /**
   * Retry every queued reference — the `occurrence-registered` moment: the viewer
   * calls this on `layout-content-added`, after the new content's components exist.
   * Resolved ones fire; the rest stay, re-keyed to their current blocker — also one
   * that is now plainly missing: the orphan verdict is {@link settlePendingRefs}'s,
   * once no placement is pending.
   * @returns How many resolved.
   */
  flushPendingRefs(): number {
    if (this.pendingRefs.length === 0) return 0;
    const queue = this.pendingRefs;
    this.pendingRefs = [];
    let resolved = 0;
    for (const p of queue) {
      const r = this.resolveRef(p.referrer, p.ref, { kind: p.kind });
      if (r.status === 'resolved') {
        resolved++;
        try { p.onResolved(r.node, r); } catch (e) { console.warn('[NodeRegistry] pending reference handler failed:', e); }
        continue;
      }
      if (r.status === 'pending') p.blocking = r.blocking;
      this.pendingRefs.push(p);
    }
    return resolved;
  }

  /**
   * Drop queued references with `reason` — all of them, or those blocked by one of
   * `blockers` (a placement that failed to load / was refused by the cap).
   * @returns How many were dropped.
   */
  dropPendingRefs(reason: PendingDropReason, blockers?: Iterable<Object3D>): number {
    if (this.pendingRefs.length === 0) return 0;
    const set = blockers ? new Set(blockers) : null;
    const keep: PendingRef[] = [];
    const drop: PendingRef[] = [];
    for (const p of this.pendingRefs) {
      if (!set || (p.blocking && set.has(p.blocking))) drop.push(p); else keep.push(p);
    }
    this.pendingRefs = keep;
    for (const p of drop) {
      try { p.onDropped?.(reason); } catch (e) { console.warn('[NodeRegistry] pending reference drop handler failed:', e); }
    }
    return drop.length;
  }

  /**
   * The orphan verdict (F13): no placement is pending any more, so a reference that
   * still does not resolve is missing. Retries once, then drops the rest as `missing`.
   * @returns How many were dropped.
   */
  settlePendingRefs(): number {
    this.flushPendingRefs();
    return this.dropPendingRefs('missing');
  }

  /**
   * F9: a PATH as a person or a caller types it (MCP, plugin, UI, URL) → node:
   * the runtime registry path exactly → the AUTHORED path in the file it lies in
   * (through the file's identity: the placement whose runtime root path prefixes it,
   * the main model last) → the exact legacy Three.js spelling → (until plan-770) the
   * registry's guessing stages, with a console warning — a guessed hit must not
   * become a stored address unnoticed (`via: 'guess'`). `null` when nothing answers,
   * or when the authored path is ambiguous (never guessed past).
   */
  findNodeForUser(path: string): UserPathResolution | null {
    const p = typeof path === 'string' ? path.trim().replace(/^\/+/, '') : '';
    if (!p) return null;
    const exact = this.nodes.get(p);
    if (exact) return { node: exact, via: 'runtime' };
    let ambiguous = false;
    const candidates: Array<{ rel: string; occ: string; identity: FileIdentity }> = [];
    for (const [occ, rec] of this.occurrences) {
      if (!rec.identity) continue;
      if (occ === ROOT_OCCURRENCE) { candidates.push({ rel: p, occ, identity: rec.identity }); continue; }
      const rootPath = this.nodePaths.get(rec.root);
      if (rootPath && p.startsWith(rootPath + '/')) candidates.push({ rel: p.slice(rootPath.length + 1), occ, identity: rec.identity });
    }
    // Most specific file first: the deepest placement prefix leaves the shortest rest.
    candidates.sort((a, b) => a.rel.length - b.rel.length);
    for (const want of ['authored', 'legacy-three'] as const) {
      for (const c of candidates) {
        const m = c.identity.migratePath(c.rel);
        if (m.address === undefined) {
          if (m.reason === 'ambiguous') ambiguous = true;
          continue;
        }
        if (!m.via.startsWith(want)) continue;
        const { nodeId } = parseNodeAddress(m.address);
        const node = this.getNodeByAddress(nodeId, c.occ);
        if (node) return { node, via: want, address: fullNodeAddress(c.occ, nodeId) };
      }
    }
    if (ambiguous) return null;
    const guessed = this._getNodeStaged(p, true);
    if (!guessed) return null;
    console.warn(
      `[NodeRegistry] findNodeForUser("${p}") matched "${this.nodePaths.get(guessed.node) ?? guessed.node.name}" only `
      + `through the "${guessed.stage}" lookup stage — a guess (plan-769 F9). Used for this input; check it before `
      + 'it is stored as a reference.',
    );
    return { node: guessed.node, via: 'guess', stage: guessed.stage };
  }

  /** The raw authored path (Unity spelling) of a node in its file, or null (no identity). */
  getAuthoredPath(node: Object3D): string | null {
    const id = identityIdOf(node);
    const a = this.nodeAddresses.get(node);
    if (!id || a === undefined) return null;
    const identity = this.occurrences.get(parseNodeAddress(a).occurrence)?.identity;
    return identity?.authoredPathOf(id) ?? null;
  }

  /**
   * plan-769 F4: the migration findings of one registered occurrence, located in
   * the live scene — what the Problems panel shows (`reportReferenceMigrationProblems`).
   * Ambiguous and legacy-spelling references come from the decode; a MISSING one
   * becomes `syntheticTarget` when its written path names a node the bake made
   * (`_rvSynthetic`), and is left to the path audit (`reference-unresolved`) otherwise.
   */
  identityProblemsOf(occurrence: string): IdentityProblem[] {
    const rec = this.occurrences.get(occurrence);
    const identity = rec?.identity;
    if (!rec || !identity || identity.findings.length === 0) return [];
    const rootPath = this.nodePaths.get(rec.root) ?? NodeRegistry.computeNodePath(rec.root);
    const scope = this.scopeFor(rec.root);
    const out: IdentityProblem[] = [];
    for (const f of identity.findings) {
      let kind: IdentityProblem['kind'] | null = null;
      if (f.outcome === 'ambiguous') kind = 'ambiguous';
      else if (f.outcome === 'legacy-spelling') kind = 'legacySpelling';
      else if (f.kind !== 'name') {
        const hit = resolveReferencePath(this, f.writtenPath, scope).node;
        if (hit && (hit.userData as Record<string, unknown> | undefined)?.[RV_SYNTHETIC_KEY] === true) kind = 'syntheticTarget';
      }
      if (!kind) continue;
      const referrer = this.getNodeByAddress(f.referrerId, occurrence)
        ?? (f.referrerId === identity.rootId || f.referrerId === identity.contentRootId ? rec.root : null);
      const referrerPath = (referrer ? this.nodePaths.get(referrer) : undefined)
        ?? (f.referrerAuthoredPath ? `${rootPath}/${f.referrerAuthoredPath}` : rootPath);
      out.push({ kind, referrerPath, componentType: f.componentType, field: f.field, writtenPath: f.writtenPath });
    }
    return out;
  }

  /**
   * The invariant "index == traversal" (F5, test 9.21) over the registered
   * occurrences: every node an occurrence's document walk reaches that has an
   * identity is indexed under exactly its address, and every indexed node is still
   * attached below a registered occurrence root. Empty arrays = it holds.
   */
  auditIdIndex(): { unindexed: string[]; stale: string[]; wrong: string[] } {
    const unindexed: string[] = [];
    const stale: string[] = [];
    const wrong: string[] = [];
    for (const [occ, rec] of this.occurrences) {
      const walk = (n: Object3D, top: boolean): void => {
        const id = identityIdOf(n);
        if (id) {
          const got = this.nodeAddresses.get(n);
          const want = fullNodeAddress(occ, id);
          if (got === undefined) unindexed.push(want);
          else if (got !== want) wrong.push(`${want} (indexed as ${got})`);
        }
        if (!top && this.isReferenceNode(n)) return;
        for (const c of n.children) walk(c, false);
      };
      // The main model root is its own document's node; a reference node (placement
      // / frame) belongs to its PARENT document — its content starts below it.
      if (occ === ROOT_OCCURRENCE) walk(rec.root, true);
      else for (const c of rec.root.children) walk(c, false);
    }
    const roots = [...this.occurrences.values()].map((r) => r.root);
    for (const [address, node] of this.nodeIdIndex) {
      let attached = false;
      for (let n: Object3D | null = node; n && !attached; n = n.parent) if (roots.includes(n)) attached = true;
      if (!attached) stale.push(address);
    }
    return { unindexed, stale, wrong };
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

  /** Preserve source-file identity before a temporary export replaces the live tree. */
  captureGltfProvenance(): {
    names: Map<string, readonly (string | undefined)[]>;
    nodes: { path: string; sourceKey: string; index: number }[];
  } {
    const nodes: { path: string; sourceKey: string; index: number }[] = [];
    for (const [node, index] of this.gltfNodeIndices) {
      const path = this.getPathForNode(node);
      if (path && this.nodes.get(path) === node) {
        nodes.push({ path, sourceKey: this.gltfNodeSources.get(node) ?? ROOT_SOURCE_KEY, index });
      }
    }
    return {
      names: new Map([...this.gltfSourceNames].map(([key, names]) => [key, [...names]])),
      nodes,
    };
  }

  /** Restore original indices onto the same authoring hierarchy after a test run. */
  restoreGltfProvenance(snapshot: ReturnType<NodeRegistry['captureGltfProvenance']>): void {
    const indices = new Map<Object3D, number>();
    const sources = new Map<Object3D, string>();
    for (const entry of snapshot.nodes) {
      // Exact paths only: a suffix alias must never attach an index to another part.
      const node = this.nodes.get(entry.path);
      if (!node) throw new Error(`Cannot restore model source mapping: missing "${entry.path}".`);
      indices.set(node, entry.index);
      sources.set(node, entry.sourceKey);
    }
    // Replace all maps together. Nodes created by edits remain without a source
    // index even though the temporary test export assigned them one.
    this.gltfNodeIndices = indices;
    this.gltfNodeSources = sources;
    this.gltfSourceNames = new Map(snapshot.names);
    this.gltfNodeNames = snapshot.names.get(ROOT_SOURCE_KEY) ?? [];
  }

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

  /**
   * plan-769 Phase 4b: the node loaded from `nodes[index]` of the file `sourceKey`
   * (default: the scene's own file), or null. A linear scan - for the rare writer
   * that has an index and needs the live node (the planner save's override migration).
   */
  getNodeAtGltfIndex(index: number, sourceKey: string = ROOT_SOURCE_KEY): Object3D | null {
    for (const [node, i] of this.gltfNodeIndices) {
      if (i === index && (this.gltfNodeSources.get(node) ?? ROOT_SOURCE_KEY) === sourceKey) return node;
    }
    return null;
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
