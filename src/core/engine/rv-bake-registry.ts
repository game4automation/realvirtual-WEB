// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-bake-registry.ts — placements as INSTANCES of a {@link BakedAsset}
 * (plan-753 §2.4, Phase 3).
 *
 * `instantiate(baked, root)` turns one baked library asset into a placement:
 *
 *   PlacementRoot {LayoutObject}
 *   ├─ static chunk Mesh        geometry / pick structure SHARED with every instance
 *   ├─ Drive-A (logic node)  ── mover chunk Mesh (shared geometry, owner frame)
 *   ├─ Sensor (logic node)   ── keep: Ray Mesh (clone, own material)
 *   ├─ SeqCycle {LogicStep_…}   survivor without a registered capability
 *   └─ Snap-ZN-convroll        (logic node without mesh)
 *
 * plan-757 D2: an instance is a clone of the WHOLE template — every node the
 * bake kept (component nodes, snap ports, reference targets, plugin-claimed
 * leaves, `LogicStep_*` / `PLC*` nodes, partition objects), rebuilt by parent
 * chain from the template (not by path — sibling names may repeat), with the
 * template's JSON-cloned rv extras. What is in the template exists, in every
 * placement. `logicNodes` stays an INDEX into that clone (the instance nodes
 * of `baked.logicNodes`, same order), not a second definition of what exists.
 * `keep` meshes are cloned per instance with their own material (Lamp / Ray /
 * fluid swap state), geometry shared; chunk meshes are plain `Mesh` wrappers
 * over the shared chunk geometry. Before D2 only logic nodes, keep meshes and
 * chunk parents were cloned — a placed Arburg had no sequence, no signals and
 * a drive without its geometry.
 *
 * Ownership rules this class enforces (F11):
 *  - `instantiate` = `baked.acquire()`, `release` = `baked.release()`;
 *  - `release` NEVER calls `geometry.dispose()` on a chunk — the asset does,
 *    at refcount 0 on a retired asset;
 *  - release listeners (the highlight proxy pool) run BEFORE the refcount
 *    drops, so no proxy can outlive the geometry it wraps (provider before
 *    geometry, §4.2).
 *
 * The viewer holds one registry as a field and only delegates (God-node
 * risk A3); the pick backend and the highlight manager read it through the
 * narrow seams below.
 */

import { registerMaterialIndex } from './rv-pre-bake';
import { Box3, Group, Mesh, MeshBasicMaterial, Object3D, type Material } from 'three';
import type { BakedAsset, BakedChunk } from './rv-bake-chunk';
import type { SignatureState } from '../persistence/rv-sig-verify';
import { getCapabilities, pickModeOf } from './rv-component-registry';
import { getNodeId } from './rv-node-id';
import { identityIdOf } from './rv-decode-identity';
import {
  applyResolvedOverrideSets, getAssetOverrides, getAssetReference, getPlacementMeta, migrateLegacyOverridePaths,
  readAssetOverridesRecord, recordOverridePathMigration, resolveAssetOverrides, setAssetOverrides,
  type ApplyOverridesResult, type AssetOverrides, type OverrideResolvers,
} from './rv-asset-reference';
import { NodeRegistry } from './rv-node-registry';
import { resolveReferencePath, scopeOf } from './rv-reference-resolver';
import { reportOverrideOrphaned, reportOverrideTransformsDropped } from '../hmi/problems-store';
import { classifyShadows } from './rv-mesh-classifier';
import { faceMaterial, isPickableMesh, materialBlocks } from './rv-pick-utils';
import { isSegmentOnly, nodeTableBytes, pickStructureBytes, segmentBoxUnion, segmentRange, type ChunkRange } from './rv-pick-structure';
import { installPickRaycast } from './rv-pick-backend';
import { RAYCAST_BLOCKED } from './rv-raycast-manager';

/** One live placement built from a baked asset. */
export interface PlacementInstance {
  /** The placement root (`LayoutObject`) the chunks and logic nodes hang under. */
  root: Object3D;
  baked: BakedAsset;
  /** One plain `Mesh` per chunk, geometry + material shared with the asset. */
  chunks: Mesh[];
  /** Per-instance clones of the asset's `keep[]` meshes (own material). */
  keep: Mesh[];
  /** Instance nodes of `baked.logicNodes` (same order) — an INDEX into the
   *  whole-template clone, not the set of what exists (plan-757 D2). */
  logicNodes: Object3D[];
  /** Master template node → instance node (root included; EVERY non-chunk
   *  template node since plan-757 D2). Allocation-free hit resolution:
   *  `nodes[]` references master nodes. */
  nodeOf: Map<Object3D, Object3D>;
  /**
   * The asset's alias table resolved to THIS instance (plan-757 D4):
   * asset-relative path → instance node. The place step registers them
   * prefixed with the root's registry path; `release()` empties the list.
   */
  aliases: Array<{ path: string; node: Object3D; subtree?: true }>;
  /**
   * The weakest signature verdict on the nesting chain ABOVE this instance
   * (plan-757 Phase 2, F7): ABSENT for a document-level placement (no chain —
   * the document itself never lends trust downwards, D8), else the weakest of
   * every containing asset's own `signatureState` — the same strength ordering
   * `compose()` carries as `effectiveState`. The trust gate weighs
   * `weakest(chainState, baked.signatureState)` against the document, so an
   * untrusted outer asset can never lend its inner asset a run — and never
   * takes away from a document-level placement either. Set by
   * `PlacementInstancer.materialize`; absent on a bare `instantiate()`.
   */
  chainState?: SignatureState;
  /** Chunk mesh → the chunk it draws. */
  chunkOf: Map<Mesh, BakedChunk>;
  /** True after `release()`. */
  released: boolean;
  /**
   * True for an IDENTITY placement — the instance IS its own template, built by
   * {@link BakeRegistry.instantiateTemplate}: `root` is `baked.template`,
   * `nodeOf` is the identity map, and `keep` are the template's own meshes
   * rather than per-instance clones. That is the main model and every entry
   * that places a destructively baked asset directly (plan-754 §2.4 step 5).
   *
   * False for a CLONED placement ({@link BakeRegistry.instantiate}): the asset
   * is placed more than once, so each placement gets its own chunk meshes, its
   * own keep clones and a real template → instance map.
   *
   * The distinction decides who owns the nodes — `release()` may only take
   * apart what the placement itself created — and how a hit resolves: an
   * identity placement has no CAD leaves left to fall back to.
   */
  identity: boolean;
}

export interface InstantiateOptions {
  /** Saved `AssetOverrides` of the placement (plan-753 Phase 3, I3; plan-769):
   *  `byAddress` patches are applied to LOGIC nodes only — a patch whose
   *  target has no template is reported as an orphan (Decision 1). Component
   *  values only: `trsByNodeId` was removed (F14). */
  overrides?: AssetOverrides | null;
}

/** What the highlight manager needs per node — a chunk mesh and, for a node that
 *  owns only part of it, the segment interval of its SUBTREE inside that chunk
 *  (plan-756 Q7/F5). `range === null` = the whole mesh, which is the answer for
 *  a placement root, for a chunk whose owner is the node or a descendant of it,
 *  and for a plan-755 partition object. At most ONE range per chunk, so a
 *  highlight costs at most one draw call per touched chunk. */
export interface ChunkHighlightTarget {
  mesh: Mesh;
  range: ChunkRange | null;
}

/** The narrow seam the highlight manager reads (no dependency on the class). */
export interface ChunkHighlightSource {
  /** Chunk targets of `node`'s subtree — its own placement's chunks plus every
   *  live placement nested below it — or null when there are none and `node`
   *  is no placement root. */
  chunkTargetsOf(node: Object3D): ChunkHighlightTarget[] | null;
  /** The placement root `node` belongs to (root itself included), or null
   *  when `node` lies outside every placement (optional: a test source may
   *  omit it). */
  placementOf?(node: Object3D): Object3D | null;
  /** Subscribe to instance release (fires BEFORE the refcount drops). */
  onRelease(listener: (instance: PlacementInstance) => void): () => void;
}

/** Marker on every chunk mesh — a plain mesh the registry created, never a
 *  CAD node. Highlight / hierarchy consumers key on it. */
export const RV_BAKE_CHUNK_KEY = '_rvBakeChunk';

/** Invisible stand-in material for keep clones without a material. */
const FALLBACK_MATERIAL = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/** Scratch for `chunkBoundsOf` — bounds are read on camera focus / isolate, so
 *  the walk allocates nothing per call. */
const _boundsScratch = new Float64Array(6);
const _boundsBox = new Box3();

/** Per asset: the template nodes that own WHOLE chunks — a chunk boundary
 *  (mover) and, since plan-755, a partition object. Built once per asset. */
type WholeChunkIndex = Map<Object3D, BakedChunk[]>;

/**
 * The plan-756 memory gate, as numbers (§1 NFR "Memory"): what the pick
 * structures of a set of baked assets cost against the geometry they
 * accelerate.
 *
 * One function for both readers — {@link BakeRegistry.stats} (the live
 * instances, i.e. the main model in HMI mode and the planner placements) and
 * the viewer's `loaderBake` block (the main model's asset alone) — so the two
 * can never drift into two different definitions of the same percentage.
 */
export interface PickMemoryStats {
  /** Bytes of every DISTINCT chunk's pick structure. */
  pickBytes: number;
  /** Bytes of the sparse CSR node tables (counts toward the same budget). */
  nodeTableBytes: number;
  /** CSR rows behind `nodeTableBytes` (`rowChunk.length`). */
  nodeTableRows: number;
  /** Segments over all distinct chunks. */
  segments: number;
  /** Clusters over all distinct chunks. */
  clusters: number;
  /** Chunks published SEGMENT-ONLY (no cluster tree — their pick build failed,
   *  plan-757 Phase 3 commit B); the traversal picks them by its linear walk. */
  segmentOnlyChunks: number;
  /** Position + index bytes of every DISTINCT chunk geometry — the denominator. */
  geometryBytes: number;
  /** `(pickBytes + nodeTableBytes) / geometryBytes * 100`, 2 decimals, 0 when nothing is baked. */
  pickPercent: number;
}

export function pickMemoryStats(assets: Iterable<BakedAsset>): PickMemoryStats {
  let pickBytes = 0;
  let tableBytes = 0;
  let tableRows = 0;
  let segments = 0;
  let clusters = 0;
  let segmentOnlyChunks = 0;
  let geometryBytes = 0;
  // A chunk geometry is per asset by construction, but an asset may be listed
  // twice by a caller — count every geometry object exactly once regardless.
  const geometries = new Set<object>();
  const seen = new Set<BakedAsset>();
  for (const asset of assets) {
    if (seen.has(asset)) continue;
    seen.add(asset);
    for (const c of asset.chunks) {
      pickBytes += pickStructureBytes(c.pick);
      segments += c.pick.segmentCount;
      clusters += c.pick.clusterCount;
      if (isSegmentOnly(c.pick)) segmentOnlyChunks++;
      if (geometries.has(c.geometry)) continue;
      geometries.add(c.geometry);
      geometryBytes += chunkGeometryBytes(c);
    }
    tableBytes += nodeTableBytes(asset.nodeTable);
    tableRows += asset.nodeTable.rowChunk.length;
  }
  const pickPercent = geometryBytes > 0
    ? Math.round(((pickBytes + tableBytes) / geometryBytes) * 10000) / 100
    : 0;
  return {
    pickBytes, nodeTableBytes: tableBytes, nodeTableRows: tableRows,
    segments, clusters, segmentOnlyChunks, geometryBytes, pickPercent,
  };
}

/** Position + index bytes of one chunk geometry (what the structure accelerates). */
function chunkGeometryBytes(chunk: BakedChunk): number {
  const geo = chunk.geometry;
  const pos = geo.getAttribute('position') as { array?: { byteLength?: number } } | undefined;
  return (pos?.array?.byteLength ?? 0) + (geo.index?.array.byteLength ?? 0);
}

export class BakeRegistry implements ChunkHighlightSource {
  private readonly _byRoot = new WeakMap<Object3D, PlacementInstance>();
  private readonly _byMesh = new WeakMap<Object3D, PlacementInstance>();
  private readonly _instances = new Set<PlacementInstance>();
  /** Flat list of every chunk + keep mesh of every live instance — the pick
   *  backend's broad phase. Rebuilt on instantiate / release only. */
  private _pickMeshes: Mesh[] = [];
  private _pickMeshesDirty = false;
  private _revision = 0;
  private readonly _wholeChunkIndex = new WeakMap<BakedAsset, WholeChunkIndex>();
  private readonly _releaseListeners = new Set<(instance: PlacementInstance) => void>();
  /**
   * Nesting of live instances (plan-774): instance → the instances whose
   * nearest enclosing instance it is, and the reverse pointer (`null` = top
   * level, also held in {@link _topLevel}). Linked when an instance registers
   * — a nested placement is materialised INSIDE its parent's clone, so its
   * root's parent chain already reaches the parent root then — re-linked by
   * {@link relinkSubtree} after a host moves a materialised root (live drop,
   * pivot, editor re-parent) and unlinked on release. What lets {@link _visitChunkTargets} reach the chunks of the
   * placements below a node without walking the scene.
   */
  private readonly _nestedOf = new WeakMap<PlacementInstance, Set<PlacementInstance>>();
  private readonly _enclosingOf = new WeakMap<PlacementInstance, PlacementInstance | null>();
  private readonly _topLevel = new Set<PlacementInstance>();
  /**
   * Instance node → TEMPLATE node (plan-756 step 1d). Filled at instantiate
   * time, which is what replaced the linear scans over `nodeOf` that
   * `chunkTargetsOf` and `findChunkMesh` used to run per highlight.
   */
  private readonly _templateOf = new WeakMap<Object3D, Object3D>();
  /** Instance: chunk → its `Mesh` (the reverse of `chunkOf`). */
  private readonly _meshOfChunk = new WeakMap<PlacementInstance, Map<BakedChunk, Mesh>>();

  // ─── Instantiate / release ────────────────────────────────────────

  /**
   * Build a placement of `baked` under `root`. `root` should be an identity
   * `Group` (the planner's transform-neutral placement root); the asset root
   * frame IS the placement frame.
   */
  instantiate(baked: BakedAsset, root: Object3D, opts?: InstantiateOptions): PlacementInstance {
    if (baked.disposed) throw new Error('[rv-bake-registry] instantiate() on a disposed asset ' + baked.assetId);
    const master = baked.template;
    // Live instances already under `root` (the nearest ones) become nested in
    // this one (scanned BEFORE the clone is built — a fresh root has nothing to scan).
    const adopt = this._nearestUnder(root);
    const nodeOf = new Map<Object3D, Object3D>();
    nodeOf.set(master, root);
    carryRootComponents(master, root);
    const keepTemplates = new Set<Object3D>();
    for (const k of baked.keep) keepTemplates.add(k.mesh);

    const keep: Mesh[] = [];
    const logicNodes: Object3D[] = [];
    const chunks: Mesh[] = [];
    const chunkOf = new Map<Mesh, BakedChunk>();

    /** The instance node of `template`, creating the parent chain on demand. */
    const ensure = (template: Object3D): Object3D => {
      const existing = nodeOf.get(template);
      if (existing) return existing;
      const parent = template.parent ? ensure(template.parent) : root;
      let node: Object3D;
      if (keepTemplates.has(template)) {
        node = cloneKeepMesh(template as Mesh);
        keep.push(node as Mesh);
      } else {
        node = cloneLogicNode(template);
      }
      parent.add(node);
      nodeOf.set(template, node);
      return node;
    };

    // plan-757 D2: the WHOLE template, pre-order (a parent is always mapped
    // before its children; `ensure` would build the chain anyway). Every node
    // the bake kept becomes an instance node — a keep template its own mesh
    // clone, everything else a plain Group with the template's JSON-cloned
    // extras. The template's chunk meshes are skipped: the loop below creates
    // this instance's own `Mesh` per chunk, under the instance node of the
    // chunk's parent.
    master.traverse((template) => {
      if (template === master) return;
      if (template.userData?.[RV_BAKE_CHUNK_KEY] === true) return;
      ensure(template);
    });
    for (const l of baked.logicNodes) logicNodes.push(nodeOf.get(l.template) ?? ensure(l.template));

    // One plain Mesh per chunk, under its owner (mover) or the root — or, for a
    // partitioned chunk, under this placement's OWN clone of the partition
    // object (plan-755 F8/B1). `cloneLogicNode` JSON-copied the partition
    // object's `userData`, so the placement has the same shape as the
    // template: independent `.visible` / matrix per placement, shared geometry.
    /** Template chunk mesh → this instance's mesh (for an alias that names a chunk mesh). */
    const meshOfTemplateChunk = new Map<Object3D, Mesh>();
    for (const chunk of baked.chunks) {
      const parentTemplate = chunk.groupObject ?? chunk.owner;
      const owner = parentTemplate === master ? root : ensure(parentTemplate);
      const mesh = new Mesh(chunk.geometry, chunk.material);
      if (chunk.templateMesh) meshOfTemplateChunk.set(chunk.templateMesh, mesh);
      // `Object3D.clone()` does not copy own properties and `new Mesh` has none,
      // so every creation site assigns the pick override explicitly (plan F4).
      installPickRaycast(mesh);
      mesh.name = chunk.key;
      // Loader shadow policy (processMeshes / applyShadowFlags).
      mesh.castShadow = classifyShadows(mesh);
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      // Positions are baked into the owner's frame: local matrix stays identity.
      mesh.matrixAutoUpdate = false;
      mesh.userData[RV_BAKE_CHUNK_KEY] = true;
      owner.add(mesh);
      chunks.push(mesh);
      chunkOf.set(mesh, chunk);
    }

    // plan-757 D4: the asset's alias table, resolved to this instance's nodes
    // (a chunk mesh under a renamed node is aliased too, like on the main model).
    const aliases: Array<{ path: string; node: Object3D; subtree?: true }> = [];
    for (const a of baked.aliases) {
      const node = nodeOf.get(a.template) ?? meshOfTemplateChunk.get(a.template);
      if (node) aliases.push(a.subtree ? { path: a.path, node, subtree: true } : { path: a.path, node });
    }

    const instance: PlacementInstance = { root, baked, chunks, keep, logicNodes, nodeOf, chunkOf, aliases, released: false, identity: false };
    // plan-496: a placement's components resolve `MaterialName` against the
    // document they came from, and the template is not an ancestor of a
    // placement root — so the index is registered on the root as well.
    registerMaterialIndex(root, baked.materialsByName);
    this._indexInstance(instance);
    if (opts?.overrides) this.applyOverrides(instance, opts.overrides);

    baked.acquire();
    this._byRoot.set(root, instance);
    for (const m of chunks) this._byMesh.set(m, instance);
    for (const m of keep) this._byMesh.set(m, instance);
    this._wholeChunkIndexOf(baked); // Prepare the geometry visitor before fixed updates.
    this._instances.add(instance);
    this._link(instance, adopt);
    this._invalidatePickMeshes();
    root.updateMatrixWorld(true);
    return instance;
  }

  /**
   * Apply saved `AssetOverrides` to an existing instance — the deferred-reload
   * path (plan-753) instantiates first, pivot-normalises the content, and only
   * THEN applies the overrides. Same routine `instantiate` runs for `opts.overrides`.
   *
   * plan-757 F9: ONE application path with placement semantics —
   * {@link applyAssetOverrides}, the function composition uses — over resolvers
   * that address THIS instance: `byAddress` (`#<id>`) through the template's
   * identity ids, the legacy `byPath` through the ONE resolver
   * (`rv-reference-resolver.ts`: the path as written relative to the asset, then
   * root-stripped) and migrated to its address (plan-769 9.22). Every orphan lands
   * in the Problems panel (`override-orphaned`); an old file's part moves are
   * reported (`override-transforms-dropped`, F14); nothing is dropped with a console line.
   */
  applyOverrides(instance: PlacementInstance, overrides: AssetOverrides): ApplyOverridesResult {
    return applyOverrideLayersTo(instance, [{ overrides, depth: 0, own: true }])[0]!;
  }

  /**
   * plan-769 Phase 4b (F13) — apply SEVERAL override sets to one instance: its own
   * record and the overrides outer placements route into its occurrence. Each set is
   * resolved against this instance, then all hits go through `applyOverrideLayers`
   * together — the outer file (smaller `depth`) wins, whatever order the sets come in.
   * A nested address no set's target holds comes back in `nested` (per set) for the
   * caller to route one occurrence further down.
   */
  applyOverrideLayers(instance: PlacementInstance, layers: readonly InstanceOverrideLayer[]): ApplyOverridesResult[] {
    return applyOverrideLayersTo(instance, layers);
  }

  /**
   * plan-754 §2.4 step 5 — PLACE a destructively baked asset: the template IS
   * the instance. Nothing is cloned and nothing is masked, because the bake
   * already built exactly the graph that is drawn: survivors as plain nodes,
   * keep meshes moved over, one chunk `Mesh` per boundary. `nodeOf` is the
   * identity map — there is only one graph — so this instance is `identity`
   * and `resolveHit`, `chunkTargetsOf` and `release` take that branch.
   *
   * The caller owns the template root and puts it into the scene.
   */
  instantiateTemplate(baked: BakedAsset): PlacementInstance {
    if (baked.disposed) throw new Error('[rv-bake-registry] instantiateTemplate() on a disposed asset ' + baked.assetId);
    if (!baked.destructive) {
      throw new Error('[rv-bake-registry] instantiateTemplate() needs a destructive bake (plan-754) — ' + baked.assetId);
    }
    if (this._byRoot.has(baked.template)) {
      throw new Error('[rv-bake-registry] the template of ' + baked.assetId + ' is already placed');
    }
    const root = baked.template;
    const adopt = this._nearestUnder(root);
    const nodeOf = new Map<Object3D, Object3D>();
    // Identity for EVERY template node (plan-757 D2 — the same set a cloned
    // instance maps), then the explicit entries the pick path reads.
    root.traverse((n) => nodeOf.set(n, n));
    const keep: Mesh[] = [];
    for (const k of baked.keep) {
      installPickRaycast(k.mesh);
      keep.push(k.mesh);
      nodeOf.set(k.mesh, k.mesh);
    }
    const logicNodes: Object3D[] = [];
    for (const l of baked.logicNodes) {
      logicNodes.push(l.template);
      nodeOf.set(l.template, l.template);
    }
    const chunks: Mesh[] = [];
    const chunkOf = new Map<Mesh, BakedChunk>();
    for (const chunk of baked.chunks) {
      nodeOf.set(chunk.owner, chunk.owner);
      if (chunk.groupObject) nodeOf.set(chunk.groupObject, chunk.groupObject);
      const mesh = chunk.templateMesh;
      if (!mesh) continue;
      installPickRaycast(mesh);
      chunks.push(mesh);
      chunkOf.set(mesh, chunk);
    }
    for (const node of baked.nodeTable.nodes) nodeOf.set(node, node);
    const aliases = baked.aliases.map((a) => (a.subtree
      ? { path: a.path, node: a.template, subtree: true as const }
      : { path: a.path, node: a.template }));
    const instance: PlacementInstance = {
      root, baked, chunks, keep, logicNodes, nodeOf, chunkOf, aliases, released: false, identity: true,
    };
    this._indexInstance(instance);
    baked.acquire();
    this._byRoot.set(root, instance);
    for (const m of chunks) this._byMesh.set(m, instance);
    for (const m of keep) this._byMesh.set(m, instance);
    this._wholeChunkIndexOf(baked);
    this._instances.add(instance);
    this._link(instance, adopt);
    this._invalidatePickMeshes();
    root.updateMatrixWorld(true);
    return instance;
  }

  /**
   * Take a placement apart: notify release listeners (highlight proxies go
   * first), detach chunk meshes and every node the instance created, free the
   * per-instance keep materials, drop the registry entries and the alias
   * table, then `baked.release()`. Idempotent. Never disposes a chunk geometry
   * (F11). The NodeRegistry aliases the place step registered go with the
   * caller's `unregisterSubtree(root)` — they belong to the runtime registry,
   * which this class never sees.
   */
  release(instance: PlacementInstance): void {
    if (instance.released) return;
    instance.released = true;
    instance.aliases.length = 0;
    for (const l of this._releaseListeners) {
      try { l(instance); } catch (e) { console.warn('[rv-bake-registry] release listener failed:', e); }
    }
    for (const m of instance.chunks) {
      m.parent?.remove(m);
      this._byMesh.delete(m);
    }
    if (instance.identity) {
      // The template owns its keep meshes and logic nodes — the placement
      // created nothing but the chunk meshes, which are already gone. After
      // the destructive bake there is nothing to unmask or re-attach: the
      // nodes a chunk absorbed do not exist any more.
      for (const m of instance.keep) this._byMesh.delete(m);
    } else {
      for (const m of instance.keep) {
        m.parent?.remove(m);
        this._byMesh.delete(m);
        disposeOwnMaterial(m);
      }
      // Every top-level node the instance created under the root — the deeper
      // ones go with their parent (plan-757 D2: the whole template clone).
      for (const [template, node] of instance.nodeOf) {
        if (template === instance.baked.template) continue;
        if (node.parent === instance.root) instance.root.remove(node);
      }
    }
    this._byRoot.delete(instance.root);
    this._instances.delete(instance);
    this._unlink(instance);
    this._invalidatePickMeshes();
    instance.baked.release();
  }

  /** `release()` of the instance rooted at `root`; false when there is none. */
  releaseByRoot(root: Object3D): boolean {
    const inst = this._byRoot.get(root);
    if (!inst) return false;
    this.release(inst);
    return true;
  }

  /**
   * The roots of every live instance under `root` — `root` itself included
   * when it is one — INNERMOST FIRST (plan-757 Phase 2, F4). A nested
   * reference node inside a placed asset is an instance of its own; whoever
   * takes the outer placement apart must take those apart too, and a host that
   * announces per-root events (`layout-content-removed`) needs the same list.
   */
  instanceRootsUnder(root: Object3D): Object3D[] {
    const out: Object3D[] = [];
    root.traverse((node) => { if (this._byRoot.has(node)) out.push(node); });
    // `traverse` is pre-order (outer before inner); release wants the reverse.
    return out.reverse();
  }

  /**
   * THE release of a placement subtree (plan-757 Phase 2, F4): every instance
   * under `root` — the nested ones first, then `root`'s own — through
   * {@link release}. Returns the number of instances released. Idempotent; 0
   * when nothing under `root` is an instance.
   */
  releaseSubtree(root: Object3D): number {
    const roots = this.instanceRootsUnder(root);
    for (const r of roots) this.releaseByRoot(r);
    return roots.length;
  }

  /** Release every live instance (bulk teardown). */
  releaseAll(): void {
    for (const inst of [...this._instances]) this.release(inst);
  }

  /**
   * Re-record the nesting of the instances under `node` after `node` was
   * added, attached or re-parented (plan-774). Nesting is linked when an
   * instance registers, but a planner live drop is materialised DETACHED and
   * hung under the model root afterwards, and the multi-select pivot and the
   * editor's re-parent move materialised roots around — without this call
   * {@link chunkTargetsOf} of the new (or old) enclosing placement would miss
   * (or keep) them.
   *
   * Cheap: when `node` is an instance root only that instance is re-pointed;
   * otherwise the walk visits `node`'s subtree down to the first instance roots
   * (never into one) — the nesting INSIDE a moved instance moved with it and
   * stays valid. A no-op when nothing is live.
   */
  relinkSubtree(node: Object3D): void {
    if (this._instances.size === 0) return;
    const self = this._byRoot.get(node);
    if (self) {
      this._setEnclosing(self, this._enclosingInstanceOf(node));
      return;
    }
    const nearest = this._nearestUnder(node);
    if (!nearest) return;
    for (const inst of nearest) this._setEnclosing(inst, this._enclosingInstanceOf(inst.root));
  }

  // ─── Lookup ────────────────────────────────────────────────────────

  /** The instance whose root is exactly `root`, or null. */
  instanceOf(root: Object3D): PlacementInstance | null {
    return this._byRoot.get(root) ?? null;
  }

  /** The instance that owns this chunk or keep mesh, or null. */
  instanceOfMesh(mesh: Object3D): PlacementInstance | null {
    return this._byMesh.get(mesh) ?? null;
  }

  /** The placement root `node` belongs to (root itself included), or null.
   *  Planner tools derive the placement from the innermost picked node here
   *  (Decision 7 — no climbing in the pick path itself). */
  placementOf(node: Object3D): Object3D | null {
    for (let c: Object3D | null = node; c; c = c.parent) {
      if (this._byRoot.has(c)) return c;
    }
    return null;
  }

  /** The chunk mesh that draws this geometry / mesh, or null. */
  chunkMeshOf(geometryOrMesh: Object3D | { uuid: string }): Mesh | null {
    if ((geometryOrMesh as Mesh).isMesh) {
      return this._byMesh.has(geometryOrMesh as Mesh) && (geometryOrMesh as Mesh).userData[RV_BAKE_CHUNK_KEY]
        ? (geometryOrMesh as Mesh) : null;
    }
    for (const inst of this._instances) {
      for (const m of inst.chunks) if (m.geometry === geometryOrMesh) return m;
    }
    return null;
  }

  /** Bumped whenever the set of drawn meshes changes (instantiate, in-place
   *  bake, release) — read-outs of the draw state poll it instead of subscribing. */
  get revision(): number {
    return this._revision;
  }

  /** Every chunk + keep mesh of every live instance (the pick broad phase). */
  get pickMeshes(): readonly Mesh[] {
    if (this._pickMeshesDirty) this._rebuildPickMeshes();
    return this._pickMeshes;
  }

  /** Live instances (iteration order = instantiate order). */
  get instances(): ReadonlySet<PlacementInstance> {
    return this._instances;
  }

  /**
   * Resolve a raycast hit on one of {@link pickMeshes} to the INSTANCE node, on
   * the node table (plan-756 step 1d).
   *
   * `ownerOrdinal` is the hit segment's `segOwner` — the pre-order ordinal of the
   * segment's pick owner, or -1 when the triangles belong to geometry with no
   * pickable node at all; `faceIndex` picks a keep mesh's face material.
   * Allocation-free, one array index and one map lookup;
   * no binary search and no window table any more.
   *
   * The three answers:
   *  - a NODE: the instance node of the owner (the template itself for an
   *    identity placement);
   *  - {@link RAYCAST_BLOCKED}: an IDENTITY placement hit an unowned face of an
   *    OPAQUE chunk, or an ownerless opaque keep mesh — real geometry that
   *    occludes but selects nothing (plan Q5);
   *  - `null`: not our mesh, or an unowned face of a TRANSPARENT chunk (the ray
   *    passes on, which is what keeps a guard behind safety glass selectable).
   *
   * A CLONED placement never blocks: an unowned face answers with the chunk
   * owner's instance node — a placement has no CAD leaves of its own and must
   * stay selectable as a whole, including a saved placement reloaded through a
   * forced split at its `PlacementMeta` root (plan-753 Phase 4b).
   */
  resolveHit(mesh: Object3D, ownerOrdinal: number, faceIndex = -1): Object3D | null | typeof RAYCAST_BLOCKED {
    const inst = this._byMesh.get(mesh);
    if (!inst) return null;
    const chunk = inst.chunkOf.get(mesh as Mesh);
    if (chunk) {
      if (ownerOrdinal < 0) {
        if (!inst.identity) return inst.nodeOf.get(chunk.owner) ?? inst.root;
        return chunk.blocks ? RAYCAST_BLOCKED : null;
      }
      const template = inst.baked.nodeTable.nodes[ownerOrdinal];
      if (template === undefined) return inst.identity ? null : inst.root;
      if (inst.identity) return template;
      return inst.nodeOf.get(template) ?? inst.root;
    }
    // keep mesh: nearest pickable ancestor-or-self inside the instance
    // (identity: none → as an unowned chunk face — except under a loaded
    // placement root, which resolves like a session placement).
    for (let c: Object3D | null = mesh; c && c !== inst.root; c = c.parent) {
      if (pickModeOf(c) !== 'none') return c;
      if (inst.identity && getPlacementMeta(c)) return c;
    }
    if (!inst.identity) return inst.root;
    const m = mesh as Mesh;
    return materialBlocks(faceMaterial(m.material, m.geometry.groups, faceIndex)) ? RAYCAST_BLOCKED : null;
  }

  // ─── Highlight seam ────────────────────────────────────────────────

  /**
   * The chunk geometry of `node` — its whole SUBTREE, at most one range per
   * chunk (plan-756 Q7/F5/§9.3).
   *
   * The node table's CSR rows give, per chunk the subtree touches, the interval
   * of segments that subtree owns; because segments are ordered by the pre-order
   * ordinal of their node (P1), that interval is one contiguous index range, and
   * `segmentRange` turns it into a `drawRange` plus a bounding sphere derived
   * from the segment boxes. Two cases answer with the WHOLE chunk instead:
   *
   *  - the chunk's boundary is `node` itself or a descendant of it — a
   *    descendant mover chunk belongs to the subtree in its entirety, and
   *    drawing it whole costs one draw call instead of a clipped one;
   *  - a plan-755 PARTITION object (§2.4a.9): synthetic, so it has no ordinal
   *    and owns no segment, but it parents exactly the chunks whose geometry
   *    hiding it would hide — the same rule as a mover.
   */
  chunkTargetsOf(node: Object3D): ChunkHighlightTarget[] | null {
    const out: ChunkHighlightTarget[] = [];
    const kind = this._visitChunkTargets(
      node,
      (mesh) => { out.push({ mesh, range: null }); },
      (mesh, chunk, firstSeg, lastSeg) => {
        const range = segmentRange(chunk.pick, firstSeg, lastSeg);
        if (range) out.push({ mesh, range });
      },
    );
    // A placement ROOT answers with its chunk list as it is (even an empty one);
    // any other node with nothing below it answers `null` — "not baked
    // content, collect real meshes" for a node outside every placement.
    if (kind === 'root') return out;
    return out.length > 0 ? out : null;
  }

  /**
   * World-space bounds of the chunk geometry of `node`'s subtree, unioned into
   * `target` — `true` when anything was added (plan-756 F6).
   *
   * This is what a node whose triangles were merged into an ancestor's chunk
   * answers with instead of the 0.1 m fallback cube of `computeSubtreeAABB`:
   * after a destructive bake such a node has no `Mesh` descendant at all, so the
   * only thing that knows where its geometry is, is its segment interval. The
   * boxes are per SEGMENT and chunk-local, so they are transformed by the chunk
   * mesh's `matrixWorld` (all eight corners — a mirrored placement and a rotated
   * mover are therefore correct) and the result is conservatively LARGER than the
   * triangles, never smaller. A node under a moving mover follows the motion,
   * because the matrix is read per call and refreshed first.
   */
  chunkBoundsOf(node: Object3D, target: Box3): boolean {
    let added = false;
    const local = _boundsScratch;
    this._visitChunkTargets(
      node,
      (mesh) => {
        mesh.updateWorldMatrix(true, false);
        const geo = mesh.geometry;
        if (geo.boundingBox === null) geo.computeBoundingBox();
        if (!geo.boundingBox) return;
        _boundsBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (_boundsBox.isEmpty()) return;
        target.union(_boundsBox);
        added = true;
      },
      (mesh, chunk, firstSeg, lastSeg) => {
        if (!segmentBoxUnion(chunk.pick, firstSeg, lastSeg, local)) return;
        mesh.updateWorldMatrix(true, false);
        _boundsBox.min.set(local[0], local[1], local[2]);
        _boundsBox.max.set(local[3], local[4], local[5]);
        _boundsBox.applyMatrix4(mesh.matrixWorld);
        target.union(_boundsBox);
        added = true;
      },
    );
    return added;
  }

  /** Visit live chunk geometry without creating target arrays or ranges.
   * Callbacks are synchronous; segment indices are inclusive. */
  visitChunkGeometry(
    node: Object3D,
    onWhole: (mesh: Mesh) => void,
    onRange: (mesh: Mesh, chunk: BakedChunk, first: number, last: number) => void,
  ): void {
    this._visitChunkTargets(node, onWhole, onRange);
  }

  /**
   * The ONE walk from a node to the chunk geometry of its subtree — shared by
   * {@link chunkTargetsOf} (highlight ranges) and {@link chunkBoundsOf} (bounds),
   * so the two can never disagree about which chunks a node owns.
   *
   * Returns `'none'` when `node` belongs to no live baked placement at all,
   * `'root'` when it IS a placement root and `'node'` for a node inside one.
   * `onWhole` is called for a whole chunk mesh, `onRange` with the segment
   * interval of the node's subtree inside a chunk that some OTHER node bounds.
   *
   * plan-774: the subtree includes the live placements NESTED below `node` —
   * a reference node inside a placed asset is an instance of its own, and an
   * asset made only of references (`mhm` → `fufu` → `empty`…) has no chunk
   * of its own at all. Every nested instance under `node` contributes ALL of
   * its chunks (and its own nested ones) whole. A node outside every placement
   * (an unbaked document node above placed references) reaches the top-level
   * instances below it the same way, still reported as `'none'`. Cost: the
   * nested instances of `node`'s placement, one parent walk each — or, for a
   * node outside every placement, the top-level instances.
   */
  private _visitChunkTargets(
    node: Object3D,
    onWhole: (mesh: Mesh) => void,
    onRange: (mesh: Mesh, chunk: BakedChunk, firstSeg: number, lastSeg: number) => void,
  ): 'none' | 'root' | 'node' {
    const whole = this._byRoot.get(node);
    if (whole) {
      this._visitWholeInstance(whole, onWhole);
      return 'root';
    }
    const root = this.placementOf(node);
    if (!root) {
      if (node.children.length > 0) {
        for (const top of this._topLevel) {
          if (isStrictAncestor(node, top.root, null)) this._visitWholeInstance(top, onWhole);
        }
      }
      return 'none';
    }
    const inst = this._byRoot.get(root)!;
    const nested = this._nestedOf.get(inst);
    if (nested && node.children.length > 0) {
      for (const child of nested) {
        if (isStrictAncestor(node, child.root, root)) this._visitWholeInstance(child, onWhole);
      }
    }
    const template = inst.identity ? node : this._templateOf.get(node);
    if (!template) return 'node';

    const table = inst.baked.nodeTable;
    const meshes = this._meshOfChunk.get(inst);
    if (!meshes) return 'node';

    // Partition objects (and boundaries reached without an ordinal) own whole chunks.
    const wholeOwned = this._wholeChunkIndexOf(inst.baked).get(template);
    if (wholeOwned) {
      for (const chunk of wholeOwned) {
        const mesh = meshes.get(chunk);
        if (!mesh) continue;
        onWhole(mesh);
      }
    }

    const ordinal = table.ordinalOf.get(template);
    if (ordinal !== undefined) {
      const end = table.subtreeEnd[ordinal];
      for (let r = table.rowStart[ordinal]; r < table.rowStart[ordinal + 1]; r++) {
        const chunk = table.chunks[table.rowChunk[r]];
        if (chunk === undefined || wholeOwned?.includes(chunk)) continue;
        const mesh = meshes.get(chunk);
        if (!mesh) continue;
        // A chunk whose boundary lies inside the subtree belongs to it whole.
        const ownerOrdinal = table.ordinalOf.get(chunk.owner);
        if (ownerOrdinal !== undefined && ownerOrdinal >= ordinal && ownerOrdinal <= end) {
          onWhole(mesh);
          continue;
        }
        onRange(mesh, chunk, table.rowFirstSeg[r], table.rowLastSeg[r]);
      }
    }
    return 'node';
  }

  onRelease(listener: (instance: PlacementInstance) => void): () => void {
    this._releaseListeners.add(listener);
    return () => { this._releaseListeners.delete(listener); };
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  /**
   * Live placement statistics (DevTools "Bake" section, `web_status.bake`).
   * `assets` / `chunks` count the DISTINCT baked assets the live instances
   * share and their chunk geometries — `chunkMeshes` are the per-instance
   * `Mesh` wrappers over those shared geometries, `keepMeshes` the
   * per-instance clones (own geometry object each).
   *
   * plan-756 memory gate: `pickBytes` (every chunk's own pick structure) and
   * `nodeTableBytes` / `nodeTableRows` (the sparse CSR table, which counts
   * toward the same 5 % budget, §2.3) are summed per DISTINCT asset — they are
   * shared by every instance, exactly like the chunk geometry.
   *
   * `geometryBytes` is the denominator of that gate: position + index bytes of
   * every DISTINCT chunk geometry. `pickPercent` = (pickBytes + nodeTableBytes)
   * / geometryBytes × 100, rounded to two decimals — the single number the 5 %
   * gate is read off (0 when nothing is baked). `segments` / `clusters` are the
   * structure's shape, summed over the same distinct chunks.
   */
  stats(): {
    instances: number; assets: number; chunks: number; chunkMeshes: number; keepMeshes: number; drawCalls: number;
    pickBytes: number; nodeTableBytes: number; nodeTableRows: number;
    segments: number; clusters: number; geometryBytes: number; pickPercent: number;
  } {
    let chunkMeshes = 0;
    let keepMeshes = 0;
    let chunks = 0;
    const seen = new Set<BakedAsset>();
    const assets: BakedAsset[] = [];
    for (const inst of this._instances) {
      chunkMeshes += inst.chunks.length;
      keepMeshes += inst.keep.length;
      if (!seen.has(inst.baked)) {
        seen.add(inst.baked);
        assets.push(inst.baked);
        chunks += inst.baked.chunks.length;
      }
    }
    const memory = pickMemoryStats(assets);
    return {
      instances: this._instances.size, assets: seen.size, chunks, chunkMeshes, keepMeshes,
      drawCalls: chunkMeshes + keepMeshes,
      ...memory,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────

  /**
   * The draw set changed: bump the revision NOW (the hierarchy browser and the
   * property inspector poll it) but defer the rebuild to the next
   * {@link pickMeshes} read. Loading a layout instantiates up to
   * `MAX_PLACEMENTS_PER_LOAD` (5000) placements and a teardown releases them
   * one by one — an eager rebuild per step walked every live instance and all
   * its meshes each time, which made a layout load quadratic (plan-582 Phase 3).
   */
  private _invalidatePickMeshes(): void {
    this._revision++;
    this._pickMeshesDirty = true;
  }

  private _rebuildPickMeshes(): void {
    this._pickMeshesDirty = false;
    const list: Mesh[] = [];
    for (const inst of this._instances) {
      for (const m of inst.chunks) list.push(m);
      for (const m of inst.keep) {
        // Keep entries may be Lines / Points / Sprites (never baked, kept
        // as-is) — a Sprite raycast needs `raycaster.camera` and none of them
        // was ever pick geometry. In place, the shared pickable-mesh predicate
        // of the merged table applies too (sensor viz, overlays, rigs …).
        if (!m.isMesh) continue;
        if (inst.identity && !isPickableMesh(m)) continue;
        list.push(m);
      }
    }
    this._pickMeshes = list;
  }

  /**
   * Fill the two reverse indices of an instance (plan-756 step 1d): instance
   * node → template and chunk → chunk mesh. Both used to be linear scans over
   * `nodeOf` / `chunkOf` per highlight.
   */
  private _indexInstance(instance: PlacementInstance): void {
    if (!instance.identity) {
      for (const [template, node] of instance.nodeOf) this._templateOf.set(node, template);
    }
    const meshes = new Map<BakedChunk, Mesh>();
    for (const [mesh, chunk] of instance.chunkOf) meshes.set(chunk, mesh);
    this._meshOfChunk.set(instance, meshes);
  }

  /** Every chunk of `inst` and, recursively, of every instance nested in it
   *  (nesting depth is bounded by the instancer's reference depth, 16). */
  private _visitWholeInstance(inst: PlacementInstance, onWhole: (mesh: Mesh) => void): void {
    for (const m of inst.chunks) onWhole(m);
    const nested = this._nestedOf.get(inst);
    if (!nested) return;
    for (const child of nested) this._visitWholeInstance(child, onWhole);
  }

  /** The NEAREST instances strictly under `node` (`node` itself excluded) —
   *  the walk does not descend into an instance root, so an instance nested in
   *  another one is not returned. Before `node` registers this is what it
   *  adopts: whatever registered first below it (a host that places the outer
   *  asset last, or the order outer → leaf → middle), whichever instance held
   *  it until then. Walks only while some instance is live. */
  private _nearestUnder(node: Object3D): PlacementInstance[] | null {
    if (this._instances.size === 0) return null;
    let out: PlacementInstance[] | null = null;
    const walk = (n: Object3D): void => {
      for (const child of n.children) {
        const inst = this._byRoot.get(child);
        if (inst) (out ??= []).push(inst);
        else walk(child);
      }
    };
    walk(node);
    return out;
  }

  /** The live instance whose root is the nearest STRICT ancestor of `root`. */
  private _enclosingInstanceOf(root: Object3D): PlacementInstance | null {
    const outerRoot = root.parent ? this.placementOf(root.parent) : null;
    return outerRoot ? this._byRoot.get(outerRoot) ?? null : null;
  }

  /** Point `instance` at `outer` (`null` = top level), out of wherever it was. */
  private _setEnclosing(instance: PlacementInstance, outer: PlacementInstance | null): void {
    const linked = this._enclosingOf.has(instance);
    const prev = this._enclosingOf.get(instance) ?? null;
    if (linked && prev === outer) return;
    if (prev) this._nestedOf.get(prev)?.delete(instance);
    else this._topLevel.delete(instance);
    this._enclosingOf.set(instance, outer);
    if (outer) this._nestedSetOf(outer).add(instance);
    else this._topLevel.add(instance);
  }

  /** Record `instance` under its nearest enclosing instance (or as top level)
   *  and adopt the nearest instances `adopt` below it. */
  private _link(instance: PlacementInstance, adopt: PlacementInstance[] | null): void {
    this._setEnclosing(instance, this._enclosingInstanceOf(instance.root));
    if (!adopt) return;
    for (const a of adopt) this._setEnclosing(a, instance);
  }

  /** Drop `instance` from the nesting; what was nested in it goes to ITS
   *  nearest enclosing instance in the scene graph as it is now — the outer one
   *  while the released clone stays attached, the top level when the release
   *  detached it (a lone `release()`; `releaseSubtree` releases the nested ones
   *  first). Call after `instance.root` left `_byRoot`. */
  private _unlink(instance: PlacementInstance): void {
    const outer = this._enclosingOf.get(instance);
    if (outer) this._nestedOf.get(outer)?.delete(instance);
    this._topLevel.delete(instance);
    this._enclosingOf.delete(instance);
    const nested = this._nestedOf.get(instance);
    this._nestedOf.delete(instance);
    if (!nested) return;
    for (const child of nested) {
      // `child` still points at the released instance — re-point it from scratch.
      this._enclosingOf.delete(child);
      this._setEnclosing(child, this._enclosingInstanceOf(child.root));
    }
  }

  private _nestedSetOf(instance: PlacementInstance): Set<PlacementInstance> {
    let set = this._nestedOf.get(instance);
    if (!set) {
      set = new Set();
      this._nestedOf.set(instance, set);
    }
    return set;
  }

  /** template → the chunks it owns WHOLE: a mover boundary (never the asset
   *  root, which is the placement itself) and a plan-755 partition object. */
  private _wholeChunkIndexOf(baked: BakedAsset): WholeChunkIndex {
    let index = this._wholeChunkIndex.get(baked);
    if (index) return index;
    index = new Map();
    const push = (t: Object3D, chunk: BakedChunk): void => {
      const arr = index!.get(t);
      if (arr) arr.push(chunk);
      else index!.set(t, [chunk]);
    };
    for (const chunk of baked.chunks) {
      if (chunk.groupObject) push(chunk.groupObject, chunk);
    }
    this._wholeChunkIndex.set(baked, index);
    return index;
  }
}

/** True when `ancestor` lies on `node`'s parent chain (`node` itself excluded),
 *  walking no further than `stop` (exclusive; `null` = the scene top). */
function isStrictAncestor(ancestor: Object3D, node: Object3D, stop: Object3D | null): boolean {
  for (let c = node.parent; c && c !== stop; c = c.parent) {
    if (c === ancestor) return true;
  }
  return false;
}

/**
 * Copy the asset root's components that declare `carriesToPlacementRoot` onto
 * the placement root (JSON clone). The asset root is mapped onto `root`, which
 * keeps its own extras (the placement stamps); without this a robot rig on the
 * asset root exists when the file is opened and vanishes when it is placed.
 * A key the placement root already carries wins — the document's own block.
 *
 * plan-774 review fix E1: the copy is RUNTIME state, not content of the file
 * that holds the reference node. The carried keys are recorded on the root
 * ({@link RV_CARRIED_ROOT_KEYS_KEY}) so the editor's save can take them off
 * again (`dropRuntimePlacementStamps`) — otherwise the parent document would
 * store the asset's rig and, on reopen, that stale copy would shadow the
 * asset's real one (the "document's own block wins" rule above). A key is only
 * ever carried when the root did NOT author it, so the file's own state for
 * every recorded key is "absent". A key carried by an earlier instantiate of
 * the same root is refreshed (it is ours, not the document's).
 */
function carryRootComponents(master: Object3D, root: Object3D): void {
  const src = master.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') return;
  let dst = root.userData.realvirtual as Record<string, unknown> | undefined;
  const previous = carriedRootKeysOf(root);
  const carried = new Set(previous);
  for (const [key, value] of Object.entries(src)) {
    if (!getCapabilities(key).carriesToPlacementRoot) continue;
    if (!dst || typeof dst !== 'object') dst = root.userData.realvirtual = {};
    if (key in dst && !previous.includes(key)) continue;
    dst[key] = JSON.parse(JSON.stringify(value));
    carried.add(key);
  }
  if (carried.size > 0) root.userData[RV_CARRIED_ROOT_KEYS_KEY] = [...carried];
}

/**
 * plan-774 review fix E1: runtime key (leading `_`, never exported) on a
 * placement root — the `userData.realvirtual` keys {@link carryRootComponents}
 * copied from the asset root (absent in the file that holds the root).
 */
export const RV_CARRIED_ROOT_KEYS_KEY = '_rvCarriedRootKeys';

/** The component keys the bake registry carried onto `root` (empty when none). */
export function carriedRootKeysOf(root: Object3D): string[] {
  const keys = root.userData?.[RV_CARRIED_ROOT_KEYS_KEY];
  return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
}

/** A plain node with the template's name, transform, visibility and (JSON-
 *  cloned, like `Object3D.copy`) userData — never its geometry. */
function cloneLogicNode(template: Object3D): Object3D {
  const node = new Group();
  node.name = template.name;
  node.position.copy(template.position);
  node.quaternion.copy(template.quaternion);
  node.scale.copy(template.scale);
  node.visible = template.visible;
  node.renderOrder = template.renderOrder;
  node.layers.mask = template.layers.mask;
  node.userData = JSON.parse(JSON.stringify(template.userData));
  return node;
}

/** `keep` clone: shared geometry, OWN material (per-instance swap state). */
function cloneKeepMesh(template: Mesh): Mesh {
  // `clone(false)` — children are rebuilt from their own templates. A clone does
  // NOT inherit the `.raycast` own property, so it is re-installed here (plan F4).
  const mesh = template.clone(false) as Mesh;
  installPickRaycast(mesh);
  const mat = template.material as Material | Material[] | undefined;
  if (Array.isArray(mat)) mesh.material = mat.map((m) => m.clone());
  else if (mat) mesh.material = mat.clone();
  else mesh.material = FALLBACK_MATERIAL;
  return mesh;
}

function disposeOwnMaterial(mesh: Mesh): void {
  const mat = mesh.material as Material | Material[] | undefined;
  if (Array.isArray(mat)) { for (const m of mat) if (m !== FALLBACK_MATERIAL) m.dispose(); }
  else if (mat && mat !== FALLBACK_MATERIAL) mat.dispose();
}

/**
 * The {@link OverrideResolvers} of ONE placement instance (plan-757 F9, plan-769 4b):
 *
 *  - `byAddress` — `#<id>` over the template's IDENTITY ids (authored NodeId, else
 *    the decode seed), mapped to this instance's nodes; the TEMPLATE ROOT is in the
 *    map too (`#<rootId>` = the placement root). An id without a template is a CAD
 *    leaf the bake merged away (plan-753 Decision 1) — an orphan, reported. An id
 *    that names two nodes is `ambiguous` — reported, never "first wins". A nested
 *    address (`<b>#<id>`) is content of another occurrence and answers null here:
 *    the instancer routes it (F13).
 *  - `byPath` — the ONE resolver over a lookup of this instance's own nodes (it
 *    stops at nested reference nodes — their content is another occurrence): the
 *    path as written, relative to the asset root (`Mount/Kine`), then with the
 *    asset's or the reference node's name stripped (`Arburg/Kine`); the asset's
 *    alias table is part of the lookup. Built lazily — most placements carry none.
 */
function instanceResolvers(inst: PlacementInstance): OverrideResolvers {
  const byId = new Map<string, Object3D>();
  const ambiguous = new Set<string>();
  for (const [template, node] of inst.nodeOf) {
    const target = template === inst.baked.template ? inst.root : node;
    const id = identityIdOf(template);
    if (!id) continue;
    const prior = byId.get(id);
    if (prior && prior !== target) ambiguous.add(id);
    else byId.set(id, target);
  }
  if (!inst.nodeOf.has(inst.baked.template)) {
    const rootId = identityIdOf(inst.baked.template);
    if (rootId && !byId.has(rootId)) byId.set(rootId, inst.root);
  }
  const idOfInstance = new Map<Object3D, string>();
  for (const [id, node] of byId) if (!ambiguous.has(id)) idOfInstance.set(node, id);
  let lookup: NodeRegistry | null = null;
  const scope = scopeOf(inst.root, '', [inst.baked.template.name]);
  const local = (address: string): string | null => (address.lastIndexOf('#') === 0 ? address.slice(1) : null);
  return {
    byAddress: (address) => {
      const id = local(address);
      if (!id || ambiguous.has(id)) return null;
      return byId.get(id) ?? null;
    },
    isAmbiguous: (address) => { const id = local(address); return !!id && ambiguous.has(id); },
    addressOf: (node) => {
      const id = idOfInstance.get(node);
      return id ? `#${id}` : null;
    },
    byPath: (relativePath) => {
      if (!lookup) {
        lookup = new NodeRegistry();
        const index = lookup;
        const walk = (node: Object3D, prefix: string): void => {
          for (const child of node.children) {
            if (child.userData?.[RV_BAKE_CHUNK_KEY] === true) continue;
            const path = prefix ? `${prefix}/${child.name}` : child.name;
            index.registerNode(path, child);
            const ref = getAssetReference(child);
            if (ref && ref.embedded !== true) continue;
            walk(child, path);
          }
        };
        walk(inst.root, '');
        for (const a of inst.aliases) {
          if (a.path === '') continue;
          index.registerAlias(a.path, a.node);
          if (a.subtree) index.registerPrefixAlias(a.path, a.node);
        }
      }
      return resolveReferencePath(lookup, relativePath, scope).node;
    },
  };
}

/** One override set competing on an instance — see {@link BakeRegistry.applyOverrideLayers}. */
export interface InstanceOverrideLayer {
  overrides: AssetOverrides;
  /** Depth of the file that holds the record (0 = the document); the outer (smaller) wins. */
  depth: number;
  /** The placement's OWN record: migrated in place on its root (9.22), part moves reported (F14). */
  own?: boolean;
  /**
   * The reference node that STORES the set when it is not this instance's root — an
   * outer placement's override routed into this nested occurrence (F13). Problem
   * ids and labels name that node and the key as it wrote it.
   */
  source?: { nodePath: string; label: string; assetId: string; occurrence: string; key: string };
}

/**
 * Apply override sets to an instance — see {@link BakeRegistry.applyOverrideLayers}.
 * Resolution per set, precedence across the sets through `applyOverrideLayers`
 * (one precedence point, `applyResolvedOverrideSets`); orphans are reported to the
 * Problems panel keyed by the storing node, the addressing and the key, so a
 * re-apply replaces rather than appends.
 */
function applyOverrideLayersTo(inst: PlacementInstance, layers: readonly InstanceOverrideLayer[]): ApplyOverridesResult[] {
  const root = inst.root;
  const nodePath = NodeRegistry.computeNodePath(root) || root.name;
  const assetId = getAssetReference(root)?.assetId || getPlacementMeta(root)?.catalogId || inst.baked.assetId;
  const occurrence = getNodeId(root) ?? nodePath;
  const resolvers = instanceResolvers(inst);
  const resolved = layers.map((layer) => resolveAssetOverrides(
    // plan-769: whatever form the caller holds (a node's extras, an older layout
    // record with `byNodeId` / `byPath` / `trsByNodeId`) is read the one way.
    readAssetOverridesRecord(layer.overrides) ?? { byAddress: {} },
    resolvers,
    { occurrence: layer.source?.occurrence ?? occurrence, assetId: layer.source?.assetId ?? assetId },
  ));
  const applied = applyResolvedOverrideSets(resolved.map((r, i) => ({ hits: r.hits, depth: layers[i]!.depth })));
  return resolved.map((r, i) => {
    const layer = layers[i]!;
    const where = layer.source ?? { nodePath, label: root.name, assetId };
    for (const o of r.orphaned) {
      reportOverrideOrphaned({
        nodePath: where.nodePath, label: where.label, assetId: where.assetId,
        addressing: o.addressing, key: layer.source?.key ?? o.key, componentTypes: o.componentTypes,
        ...(o.reason ? { reason: o.reason } : {}),
      });
    }
    if (layer.own) {
      // 9.22: the placement node holds the 769 form from now on — a legacy `byPath` that
      // resolved is its address, `byNodeId` / `trsByNodeId` are gone — so the next save
      // writes `byAddress` only. Unresolved paths stay (orphans are never dropped).
      const own = getAssetOverrides(root);
      if (own) setAssetOverrides(root, migrateLegacyOverridePaths(own, r.migratedPaths));
      recordOverridePathMigration(root, r.migratedPaths);
      if (r.droppedTransforms > 0) {
        reportOverrideTransformsDropped({ nodePath, label: root.name, assetId, count: r.droppedTransforms });
      }
    }
    const { hits: _hits, ...rest } = r;
    void _hits;
    return { applied: applied[i]!, ...rest };
  });
}

