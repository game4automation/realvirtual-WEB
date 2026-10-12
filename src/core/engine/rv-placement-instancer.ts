// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-placement-instancer.ts — THE primitive that turns a placed reference
 * (asset key + transform + overrides + id/label) into an instance in the scene
 * graph (plan-753 structure hardening, 2026-09-17).
 *
 * Before this module the layout planner had one code path per entry — live
 * drop, snap drop, duplicate/paste, draft swap, restore/undo, reload — each
 * with its own key derivation and its own order of instantiate → pivot →
 * overrides → shadow flags → render mode. They agreed only because two tests
 * compared them, and two defects grew at exactly that seam on 2026-09-17
 * (reload over the in-place bake; reload without the uber material).
 *
 * Contract: **Placement = {@link PlacementInstancer.resolveBaked} +
 * {@link PlacementInstancer.materialize}; nobody else calls
 * `BakeRegistry.instantiate()`.**
 *
 * Ownership: the VIEWER owns exactly one instancer (`viewer.placements`), so a
 * viewer without the planner plugin loads a layout document as shared
 * instances too ({@link PlacementInstancer.materializeDeferred}). The planner
 * keeps what is planner: store / op log, selection, snap workflow, ghost and
 * draft UI, the hierarchy panel — it hooks in through
 * {@link DeferredPlacementHooks}.
 *
 * Lifecycle (plan-753 F11, unchanged): the bake cache is DOCUMENT-scoped.
 * Instances release first, then the cache retires its assets — a retired asset
 * with live instances is disposed by the last `release()`.
 *
 * plan-757 Phase 2 — **a reference is a placement, always** (F8): the recipe
 * leaves every reference node in a template as an EMPTY survivor and
 * `instantiate()` clones the whole template, so every fresh instance carries
 * its nested reference nodes. The LAST step of {@link PlacementInstancer.materialize}
 * scans them and queues each as a placement of its own through the same
 * {@link PlacementInstancer.materializeDeferred} — synchronously, so the
 * scene-ready contract never sees an empty queue between an outer instance and
 * its nested ones, and on EVERY entry (live drop, duplicate, draft swap,
 * reload, perf matrix), because the scan is part of the one order, not of one
 * caller. Guards: cycle (`sourceOf` key already on the chain), depth
 * (`MAX_REFERENCE_DEPTH`), a per-load placement cap. A nested root is CONTENT
 * of its parent placement — it carries `_layoutNestedOf`, never a planner
 * record's `_layoutId` ({@link recordRootOf}).
 */

import { Group } from 'three';
import type { Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ModelCache, resolvedCacheKey, type BakeStats, type ModelCacheUberOptions } from './rv-model-cache';
import type { BakeRegistry, PlacementInstance } from './rv-bake-registry';
import { RV_BAKE_CHUNK_KEY } from './rv-bake-registry';
import type { BakedAsset } from './rv-bake-chunk';
import type { SignatureState } from '../persistence/rv-sig-verify';
import { pivotToFloorCenter } from './rv-placement-pivot';
import { applyShadowFlags } from './rv-mesh-classifier';
import { RV_DRIVE_HOME_KEY, type DriveHomePose } from './rv-pre-bake-keys';
import {
  MAX_REFERENCE_DEPTH,
  clearDeferredPlacement,
  getAssetOverrides,
  getAssetReference,
  getDeferredPlacement,
  getPlacementMeta,
  isUnresolvedReferenceNode,
  markDeferredPlacement,
  type AssetOverrides,
} from './rv-asset-reference';
import { childOccurrence, getNodeId } from './rv-node-id';
import { resolveReferenceUrl, weakestSignatureState } from './rv-glb-compose';
import { gltfLoader as sharedGltfLoader } from './rv-glb-parse';
import {
  PROJECT_PLACEMENT_PREFIX,
  findRegistryOrigin,
  rebaseLocalLibraryUrl,
} from '../library/rv-placement-source';

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * What a placement points at. Structurally a subset of the planner's
 * `PlacedComponent` and derivable from a catalog entry
 * (`{ catalogId: entry.id, glbUrl: entry.glbUrl }`).
 */
export interface PlacementRef {
  /** Catalog / asset id. A `project:` id resolves through the library registry. */
  catalogId: string;
  /** The stable GLB url of a classic placement ('' for a project document). */
  glbUrl?: string;
  /** A pre-resolved fetch url that wins over {@link glbUrl} — the planner's
   *  catalog / cloud fallback for a saved `blob:` url that died with its session. */
  url?: string;
}

/** The cache key + transport of a {@link PlacementRef}. */
export interface PlacementSource {
  key: string;
  /** Registry transport; absent for a url-keyed asset (the key IS the url). */
  resolve?: () => Promise<{ url: string; revokeUrl?(): void }>;
}

/** Identity + per-occurrence state of one placement — see {@link PlacementInstancer.materialize}. */
export interface MaterializeSpec {
  id: string;
  label: string;
  catalogId: string;
  /** Saved `AssetOverrides` (byNodeId / trsByNodeId). Applied AFTER the pivot:
   *  a saved TRS is a position in the pivoted frame. */
  overrides?: AssetOverrides | null;
  /** Floor-centre pivot of the instantiated content. Default true; false for
   *  multi-part CAD assemblies that keep their functional origin (plan-238). */
  pivot?: boolean;
  /**
   * plan-757 Phase 2 — the nesting context of THIS placement, absent for a
   * document-level or live entry (chain = the document key, depth 0):
   * the asset keys from the outermost placement down to the asset the
   * reference node sits in, the nesting depth and the weakest signature state
   * on that chain (F7). The nested scan at the end of `materialize` extends
   * them by this instance's own asset.
   */
  chain?: readonly string[];
  depth?: number;
  chainState?: SignatureState;
  /** Occurrence chain of this placement (default: `id`). */
  occurrence?: string;
  /**
   * The parent placement's id when THIS root is a nested reference node inside
   * a placed asset (F5). Such a root is content of its parent: it gets
   * `_layoutObject` + `_layoutNestedOf`, never a planner record's `_layoutId`.
   */
  nestedOf?: string;
}

/** One deferred placement root of a loaded layout document. */
export interface DeferredPlacementEntry {
  node: Object3D;
  ref: PlacementRef;
  id: string;
  label: string;
  /** The occurrence chain composition assigned — the missing-reference problem id. */
  occurrence: string;
  /**
   * plan-757 Phase 2 (F8/F13): the asset keys from the outermost placement down
   * to the asset THIS reference node sits in. Absent for a document-level
   * reference (the instancer seeds it with the document's own key, so a
   * reference back to the document is a cycle). The cycle guard of nested
   * materialisation; spelled in {@link PlacementInstancer.sourceOf} keys.
   */
  chain?: readonly string[];
  /** Nesting depth — 0 for a document-level reference, +1 per level. */
  depth?: number;
  /**
   * Weakest signature verdict on the chain above this reference (F7): ABSENT
   * for a document-level reference (no chain), else folded from every
   * containing asset's own `signatureState`.
   */
  chainState?: SignatureState;
  /**
   * Floor-centre pivot of the instantiated content. Absent = true (a
   * document-level entry is always a planner placement today). A nested
   * reference carries `getPlacementMeta(node) !== null`: a planner placement
   * is pivoted, a hand-authored CAD sub-assembly keeps its child transforms —
   * the same rule `compose()` applies when it grafts.
   */
  pivot?: boolean;
  /** The parent placement's id for a NESTED reference (F5); absent at the document level. */
  nestedOf?: string;
}

/** Why a nested reference was NOT queued as a placement (per node). */
export type NestedRefusalReason = 'cycle' | 'depth';

/** One nested reference the instancer refused — reported, never dropped silently. */
export interface NestedReferenceRefusal {
  reason: NestedRefusalReason;
  /** The reference node (empty; the host draws the hole). */
  node: Object3D;
  label: string;
  /** The reference itself — for the placeholder label / bounds. */
  ref: PlacementRef;
  /** `sourceOf(ref).key` of the refused reference. */
  assetKey: string;
  /** Asset keys outer → inner, the parent asset included. */
  chain: readonly string[];
  /** Depth the refused reference would have had. */
  depth: number;
}

/**
 * The per-load placement cap was hit (F9) — ONE aggregated report per load,
 * re-issued (same load, growing numbers) whenever another nested scan runs
 * into it. The refused nodes stay empty, without a placeholder.
 */
export interface PlacementCapInfo {
  cap: number;
  /** Nested references refused by the cap so far in this load. */
  refused: number;
  /** The first {@link PLACEMENT_CAP_REPORTED_NODES} refused reference nodes. */
  nodes: readonly Object3D[];
}

/** How many refused nodes a cap report names. */
export const PLACEMENT_CAP_REPORTED_NODES = 5;

/**
 * Default hard cap on placements queued per load — the N × M guard (an asset
 * with 20 nested references placed 100× is 2 100 placements). Counted against
 * the load's `total`; only NESTED queueing stops at it, the document's own
 * references are what the user authored and always queue. Overridable per
 * instancer ({@link PlacementInstancerDeps.maxPlacementsPerLoad},
 * {@link PlacementInstancer.maxPlacementsPerLoad}).
 */
export const MAX_PLACEMENTS_PER_LOAD = 5000;

/**
 * The narrow hook a host uses to take part in deferred materialisation. The
 * planner passes its own (store, id maps, snap ports, bindings); without hooks
 * the instancer's defaults run (see {@link PlacementInstancerDeps}).
 */
export interface DeferredPlacementHooks {
  /** Fetch url for a classic placement whose saved url may be dead. Return
   *  null/undefined to fall back to the record's own `glbUrl`. */
  resolveUrl?(entry: DeferredPlacementEntry): Promise<string | null | undefined>;
  /** Is the root still part of the live document? Default: deps.isLive. */
  isLive?(node: Object3D): boolean;
  /** Register the materialised instance (runtime + host bookkeeping). */
  register?(entry: DeferredPlacementEntry, instance: PlacementInstance): void;
  /** The asset could not be loaded — draw the hole, report the problem. */
  missing?(entry: DeferredPlacementEntry, error: unknown): void;
}

/** How the instancer reaches its host — injected, the engine must not know `RVViewer`. */
export interface PlacementInstancerDeps extends ModelCacheUberOptions {
  /** The registry placements are instances of (the viewer's). */
  bakeRegistry: () => BakeRegistry;
  /** Match a subtree to the active render mode (toon swap + recompile). */
  applyRenderMode?: (root: Object3D) => void;
  /** GLTF loader of the model cache. Default: the engine's shared loader. */
  loader?: GLTFLoader;
  /** Default liveness test of a deferred root (viewer: under `currentModel`). */
  isLive?: (node: Object3D) => boolean;
  /** Default registration of a deferred root when no hook registers it. */
  registerDefault?: (entry: DeferredPlacementEntry, instance: PlacementInstance) => void;
  /** Default missing-asset handling when no hook handles it. */
  missingDefault?: (entry: DeferredPlacementEntry, error: unknown) => void;
  /**
   * The placements of a load settled — called exactly once per sealed load
   * ({@link PlacementInstancer.sealLoad}), also with zero references, and with
   * `aborted: true` when the document changed first. The viewer turns it into
   * its `placements-materialized` event.
   */
  onSettled?: (info: PlacementsSettledInfo) => void;
  /** `state` flipped — the viewer's busy indicator / DevTools line. */
  onStateChanged?: (state: PlacementsState) => void;
  /**
   * A reference node inside a materialised instance was NOT queued (cycle,
   * depth). The viewer draws the hole and files a Problems entry; the engine
   * does not know the problems store.
   */
  onNestedRefused?: (refusal: NestedReferenceRefusal) => void;
  /** The per-load placement cap was hit — ONE aggregated report per load (F9). */
  onCapReached?: (info: PlacementCapInfo) => void;
  /**
   * The host's `register` hook (or `registerDefault`) threw for a materialised
   * instance (F11). The instance stays in the scene and its nested references
   * were queued regardless; the viewer files a Problems entry.
   */
  onRegisterFailed?: (entry: DeferredPlacementEntry, error: unknown) => void;
  /** Initial value of {@link PlacementInstancer.maxPlacementsPerLoad}. */
  maxPlacementsPerLoad?: number;
  /**
   * Last-resort source of a reference {@link PlacementInstancer.sourceOf}
   * cannot place — no url, no registry origin (plan-757 Phase 2b): the host
   * resolves it the way `compose()` would have (library sources, the open
   * project's manifest, the resolved path) and hands back a url the cache can
   * decode, or `null` = missing. Keyed by the reference's bare identity.
   */
  resolveReference?: (ref: PlacementRef) => Promise<{ url: string; revokeUrl?(): void } | null>;
}

/** `materializing` while at least one deferred placement waits for / runs its bake. */
export type PlacementsState = 'idle' | 'materializing';

/** Counters of the current document's deferred placements (`web_status`, MCP open verbs). */
export interface PlacementsProgress {
  state: PlacementsState;
  /** Deferred references queued since the last document change. */
  total: number;
  /** Instantiated into the scene graph. */
  materialized: number;
  /** Still queued / baking. */
  pending: number;
  /** Settled WITHOUT an instance — asset not loadable (placeholder) or root gone. */
  missing: number;
}

/** Payload of the viewer's `placements-materialized` event. */
export interface PlacementsSettledInfo {
  /** The document changed (or was cleared) before the queue drained. */
  aborted: boolean;
  total: number;
  materialized: number;
  missing: number;
}

// ─── Markers ────────────────────────────────────────────────────────────

/** Marker + `LayoutObject` stamp of a placement root — one definition (F2). */
export function stampPlacementMarkers(root: Object3D, id: string, label: string, catalogId: string): void {
  root.userData._layoutObject = true;
  root.userData._layoutId = id;
  delete root.userData._layoutNestedOf;
  if (root.userData.realvirtual && typeof root.userData.realvirtual === 'object') {
    (root.userData.realvirtual as Record<string, unknown>).LayoutObject = { Label: label, CatalogId: catalogId, Locked: false };
  } else {
    root.userData.realvirtual = { LayoutObject: { Label: label, CatalogId: catalogId, Locked: false } };
  }
}

/**
 * Markers of a NESTED placement root (plan-757 Phase 2, F5): a reference node
 * inside a placed asset that became a placement of its own. It is CONTENT of
 * the parent placement, not a record of the planner's store — so it carries
 * `_layoutObject` (every node of a placement does) and `_layoutNestedOf` (the
 * parent placement's id), and never `_layoutId` or a `LayoutObject` stamp:
 * every planner tool that reads `_layoutId` as "the record" walks past it to
 * the record root ({@link recordRootOf}), every runtime rule that asks "is
 * this a placement root?" ({@link isPlacementRoot}) sees it.
 */
export function stampNestedPlacementMarkers(root: Object3D, parentId: string, id?: string): void {
  root.userData._layoutObject = true;
  root.userData._layoutNestedOf = parentId;
  // The occurrence-chain id (`<parent id>/<reference NodeId>`), STABLE across
  // reloads — what per-object services (placed behaviors) key a nested root by
  // instead of the uuid (plan-757 Phase 2b, F18). Never a record id.
  if (id) root.userData._layoutNestedId = id;
  else delete root.userData._layoutNestedId;
  delete root.userData._layoutId;
}

/** The stable id of a nested placement root (`_layoutNestedId`), or null. */
export function nestedPlacementIdOf(node: Object3D): string | null {
  const id = node.userData?._layoutNestedId;
  return typeof id === 'string' && id ? id : null;
}

/** True when `node` is the root of a nested placement (a reference node inside a placed asset). */
export function isNestedPlacementRoot(node: Object3D): boolean {
  return typeof node.userData?._layoutNestedOf === 'string';
}

/**
 * INNERMOST reading: true for a planner record's root (`_layoutId`) AND for a
 * nested placement root (`_layoutNestedOf`). What the runtime asks when it
 * needs "the placement this node's content belongs to" — spawn parents, pick.
 */
export function isPlacementRoot(node: Object3D): boolean {
  const ud = node.userData;
  return typeof ud?._layoutId === 'string' || typeof ud?._layoutNestedOf === 'string';
}

/**
 * RECORD reading (F5): the outermost ancestor of `node` (self included) that
 * carries a planner record — a string `_layoutId`. A nested placement root has
 * none, so a node deep inside nested content resolves to the top-level
 * placement the planner's store knows: selection, snap alignment, save routing,
 * the hierarchy panel and removal all act on THAT. Null outside any placement.
 */
export function recordRootOf(node: Object3D): Object3D | null {
  let found: Object3D | null = null;
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if (typeof cur.userData?._layoutId === 'string') found = cur;
  }
  return found;
}

// ─── Deferred discovery ─────────────────────────────────────────────────

/** The deferred placement roots under `root`, in document order (marks untouched). */
export function collectDeferredPlacements(root: Object3D): DeferredPlacementEntry[] {
  const out: DeferredPlacementEntry[] = [];
  const walk = (node: Object3D): void => {
    const mark = getDeferredPlacement(node);
    if (mark) {
      const reference = getAssetReference(node);
      // plan-757 Phase 2b: a hand-authored document reference has no NodeId of
      // its own (compose derives one only when the file's sha256 is known) —
      // the occurrence chain compose assigned is its id then. Without EITHER
      // the node is a reference nobody can address; it stays empty.
      const id = getNodeId(node) ?? mark.occurrence;
      if (id) {
        out.push({
          node,
          id,
          label: node.name,
          occurrence: mark.occurrence || id,
          // The path resolved against the CONTAINING file where the mark carries
          // it (a relative `path` of a deferred document reference), else as written.
          ref: {
            catalogId: reference?.assetId || getPlacementMeta(node)?.catalogId || '',
            glbUrl: mark.resolvedPath || reference?.path || '',
          },
          // The pivot rule of the reference node (spike S2 finding 3): a planner
          // placement is floor-centre pivoted, a hand-authored CAD sub-assembly
          // keeps its child transforms — what `compose()` applies when it grafts.
          pivot: getPlacementMeta(node) !== null,
        });
      }
      return; // never descend into a placement
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** Fallback key of a reference without a source — `catalogId || url || glbUrl`. */
function assetKeyOf(ref: PlacementRef): string {
  return ref.catalogId || ref.url || ref.glbUrl || '';
}

/** What the nested scan needs to know about the PARENT asset of the references it finds. */
export interface NestedScanContext {
  /** The parent asset's cache key (`BakedAsset.assetId`) — appended to the chain. */
  parentKey: string;
  /** The parent asset's url (`BakedAsset.url`) — the base of a relative `path` (F3). */
  parentUrl: string;
  /** The parent asset's own signature state — folded into the nested chain state (F7). */
  parentState: SignatureState;
  /** ONE key derivation for the cycle guard (F13): `PlacementInstancer.sourceOf(ref).key`. */
  keyOf: (ref: PlacementRef) => string;
  /**
   * The reference nodes of the instance, when the caller already knows them
   * (F14: the instancer memoises the template's reference nodes per asset and
   * maps them through `instance.nodeOf`). Default: walk the instance.
   */
  nodes?: readonly Object3D[];
}

/** The parent placement, as the nested scan sees it. */
export type NestedScanParent = Pick<DeferredPlacementEntry, 'node' | 'id' | 'occurrence' | 'chain' | 'depth' | 'chainState'>;

/**
 * The reference nodes INSIDE an instance (walk form): below the instance root,
 * never descending into a reference node found, chunk meshes skipped.
 */
export function walkReferenceNodes(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  const walk = (node: Object3D): void => {
    if (node.userData?.[RV_BAKE_CHUNK_KEY] === true) return;
    if (isUnresolvedReferenceNode(node)) { out.push(node); return; }
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return out;
}

/**
 * plan-757 Phase 2 (F8 — "a reference is a placement, always"): the reference
 * nodes INSIDE a freshly materialised instance, as deferred entries.
 *
 * The recipe leaves every reference node in the template as an EMPTY survivor
 * (`AssetReference` claims its node; `PlacementMeta` is the placement marker),
 * and `instantiate()` clones the whole template — so every instance carries
 * its nested reference nodes, extras included, and the ONLY thing missing is
 * to queue them. One entry per reference plus the refusals:
 *
 *  - `cycle` — the referenced asset is already on the chain (A → A, A → B → A,
 *    the document itself); keys are ONE derivation, `sourceOf(ref).key`, so
 *    the same file under two catalog ids is one asset (F13);
 *  - `depth` — deeper than {@link MAX_REFERENCE_DEPTH}, the same bound `compose()` has.
 *
 * Ids are occurrence chains (`<parent id>/<reference NodeId>`), because ten
 * instances of one asset carry ten clones of the SAME reference NodeId and the
 * instancer keys its queue by id. A relative `path` is resolved against the
 * PARENT ASSET's url exactly as `compose()` resolves it (F18/F3). The chain
 * state is the weakest verdict down to and including the parent asset (F7).
 */
export function collectNestedReferences(
  parent: NestedScanParent,
  ctx: NestedScanContext,
): { entries: DeferredPlacementEntry[]; refused: NestedReferenceRefusal[] } {
  const entries: DeferredPlacementEntry[] = [];
  const refused: NestedReferenceRefusal[] = [];
  const chain: readonly string[] = [...(parent.chain ?? []), ctx.parentKey];
  const depth = (parent.depth ?? 0) + 1;
  // The parent asset joins the chain: its own verdict, weakened by whatever is
  // above it. A parent WITHOUT a chain (a document-level placement) starts one.
  const chainState = parent.chainState === undefined
    ? ctx.parentState
    : weakestSignatureState(parent.chainState, ctx.parentState);
  let ordinal = 0;
  for (const node of ctx.nodes ?? walkReferenceNodes(parent.node)) {
    const reference = getAssetReference(node);
    if (!reference) continue;
    const segment = getNodeId(node) ?? `@${ordinal}`;
    ordinal++;
    const glbUrl = reference.path ? resolveReferenceUrl(ctx.parentUrl, reference.path) : '';
    const ref: PlacementRef = { catalogId: reference.assetId || getPlacementMeta(node)?.catalogId || '', glbUrl };
    const key = ctx.keyOf(ref);
    const base = { node, label: node.name, ref, assetKey: key, chain, depth };
    if (chain.includes(key)) refused.push({ reason: 'cycle', ...base });
    else if (depth > MAX_REFERENCE_DEPTH) refused.push({ reason: 'depth', ...base });
    else {
      entries.push({
        node,
        ref,
        id: `${parent.id}/${segment}`,
        label: node.name,
        occurrence: childOccurrence(parent.occurrence, segment),
        chain,
        depth,
        chainState,
        pivot: getPlacementMeta(node) !== null,
        nestedOf: parent.id,
      });
    }
  }
  return { entries, refused };
}

// ─── Instancer ──────────────────────────────────────────────────────────

export class PlacementInstancer {
  private readonly _deps: PlacementInstancerDeps;
  private _cache: ModelCache | null = null;
  /** Bumped on every document change: orphaned materialisations write nothing. */
  private _generation = 0;
  /** Deferred placements whose asset is still loading / baking, by placement id. */
  private readonly _materializing = new Map<string, Promise<void>>();
  /**
   * Tail of the per-asset materialisation queue. Deferred placements are
   * materialised ONE ASSET AT A TIME: every occurrence of an asset starts
   * together (all but the first join its in-flight bake), the next asset's
   * decode + bake begins only when the previous asset has fully staged.
   * Running every bake at once put two masters' staging on the main thread in
   * the same window — a 3 s long task for a conveyor that stages in 60 ms.
   */
  private _queue: Promise<void> = Promise.resolve();
  private _idleWaiters: Array<() => void> = [];
  /** A load was sealed and its settle notification is still owed. */
  private _loadOpen = false;
  private _total = 0;
  private _materialized = 0;
  private _lastState: PlacementsState = 'idle';
  /** Roots the DEFAULT registration owns (no planner) — released on document change. */
  private readonly _ownedRoots = new Set<Object3D>();
  /**
   * The document's own asset key (F13) — the first link of every chain, so an
   * asset that references the document it is placed in is a cycle. Set by the
   * viewer per load; cleared with the document.
   */
  private _documentKey: string | null = null;
  /** Per-load cap bookkeeping (F9) — one aggregated report, re-issued as it grows. */
  private _capRefused = 0;
  private readonly _capNodes: Object3D[] = [];
  /** F14: the template's reference nodes per asset — mapped per instance through `nodeOf`. */
  private readonly _templateRefs = new WeakMap<BakedAsset, readonly Object3D[]>();
  /**
   * Hard cap on placements queued per load (F9) — see {@link MAX_PLACEMENTS_PER_LOAD}.
   * Settable: the viewer option `createViewerPlacementInstancer(viewer, { maxPlacementsPerLoad })`
   * and a test both go through here, never through the deps.
   */
  maxPlacementsPerLoad: number;

  constructor(deps: PlacementInstancerDeps) {
    this._deps = deps;
    this.maxPlacementsPerLoad = deps.maxPlacementsPerLoad ?? MAX_PLACEMENTS_PER_LOAD;
  }

  // ── Cache access ────────────────────────────────────────────────────

  /** The document-scoped decode + bake cache. Created on first use. */
  get modelCache(): ModelCache {
    return (this._cache ??= new ModelCache(this._deps.loader ?? sharedGltfLoader, {
      uber: this._deps.uber,
      isWebGPU: this._deps.isWebGPU,
      pickPort: this._deps.pickPort,
      prepareMaster: this._deps.prepareMaster,
    }));
  }

  /** Replace the cache — test / embedder seam (in-memory decode). The previous
   *  cache is disposed; call before anything was placed. */
  setModelCache(cache: ModelCache): void {
    if (this._cache && this._cache !== cache) this._cache.dispose();
    this._cache = cache;
  }

  get bakeRegistry(): BakeRegistry { return this._deps.bakeRegistry(); }

  /** Live bake statistics (`web_status`, DevTools). */
  getBakeStats(): BakeStats & { placements: ReturnType<BakeRegistry['stats']> } {
    return { ...this.modelCache.getBakeStats(), placements: this.bakeRegistry.stats() };
  }

  // ── Key derivation — the ONE place ──────────────────────────────────

  /**
   * Cache key + transport of a reference, or null when it has no source:
   *  - a `project:` reference → `resolvedCacheKey(provider, source, catalogId)`;
   *  - a classic reference → `url || glbUrl`, a bundled library path re-rooted
   *    onto this deploy's BASE_URL (`rebaseLocalLibraryUrl`);
   *  - no url at all → the registry, by id (a registry entry has no `glbUrl`).
   * A live drop, a duplicate and a reloaded occurrence of one asset therefore
   * share ONE bake in the document's cache — and the nesting chain's cycle
   * guard spells its keys the same way (F13).
   */
  sourceOf(ref: PlacementRef): PlacementSource | null {
    const catalogId = ref.catalogId ?? '';
    const isProject = catalogId.startsWith(PROJECT_PLACEMENT_PREFIX);
    if (!isProject) {
      const raw = (ref.url || ref.glbUrl || '').trim();
      if (raw) return { key: rebaseLocalLibraryUrl(raw) ?? raw };
    }
    const origin = findRegistryOrigin(catalogId);
    if (!origin) return null;
    return {
      key: resolvedCacheKey(origin.providerId, origin.source.id, catalogId),
      resolve: () => origin.source.resolveAsset(catalogId, 'place'),
    };
  }

  /** The chain key of a reference: its source key, else its bare identity (F13). */
  keyOf(ref: PlacementRef): string {
    return this.sourceOf(ref)?.key ?? assetKeyOf(ref);
  }

  /**
   * The document's own asset key — the first link of every nesting chain
   * (F13). The viewer sets it per load from the document url; a document
   * loaded from bytes without a url has none (`null` = no seed).
   */
  setDocumentKey(key: string | null): void {
    this._documentKey = key;
  }

  get documentKey(): string | null { return this._documentKey; }

  /**
   * The shared `BakedAsset` of a reference (plan-753 F1): decodes + bakes once
   * per (asset, document); concurrent askers join the in-flight bake.
   * `forceSplitNodeIds` (a `trsByNodeId` override) is a different bake of the
   * same master. `signal` detaches THIS asker only.
   */
  resolveBaked(
    ref: PlacementRef,
    opts?: { signal?: AbortSignal; forceSplitNodeIds?: readonly string[] },
  ): Promise<BakedAsset> {
    const source = this.sourceOf(ref) ?? this._fallbackSource(ref);
    if (!source) {
      return Promise.reject(new Error(
        ref.catalogId?.startsWith(PROJECT_PLACEMENT_PREFIX)
          ? `Project asset "${ref.catalogId}" is not in the active project.`
          : `Entry "${ref.catalogId}" has no glbUrl and no registry origin.`,
      ));
    }
    return this.modelCache.getOrLoadBaked(source.key, source.resolve, opts);
  }

  /**
   * The host's resolver as a source (plan-757 Phase 2b, `deps.resolveReference`)
   * for a reference {@link sourceOf} cannot place: keyed by the reference's
   * bare identity (the same key {@link keyOf} gives it), transport = whatever
   * the host resolves. `null` without a host resolver or an identity.
   */
  private _fallbackSource(ref: PlacementRef): PlacementSource | null {
    const resolve = this._deps.resolveReference;
    const key = assetKeyOf(ref);
    if (!resolve || !key) return null;
    return {
      key,
      resolve: async () => {
        const resolved = await resolve(ref);
        if (!resolved) throw new Error(`Reference "${key}" resolves to nothing (no library source, project document or file).`);
        return resolved;
      },
    };
  }

  /** The cached baked asset of a reference, if it is warm and alive (no load). */
  peekBaked(ref: PlacementRef): BakedAsset | undefined {
    const source = this.sourceOf(ref);
    const baked = source ? this.modelCache.peekBaked(source.key) : undefined;
    return baked && !baked.disposed ? baked : undefined;
  }

  /** Warm the caches for a reference — fire-and-forget, never rejects. */
  prefetch(ref: PlacementRef, opts?: { bake?: boolean }): void {
    const source = this.sourceOf(ref);
    if (!source) return;
    if (source.resolve) this.modelCache.prefetchResolved(source.key, source.resolve, opts);
    else this.modelCache.prefetch(source.key, opts);
  }

  /**
   * A drawable CLONE of the reference — the drag ghost and the thumbnail.
   *
   * GEOMETRY ONLY (plan-754 §2.6 class (b)): after a destructive bake this is a
   * clone of the pruned template, so it carries every triangle of the asset but
   * not its source CAD hierarchy. Whoever needs that asks {@link decodeFreshModel}.
   */
  loadModel(ref: PlacementRef, opts?: { signal?: AbortSignal }): Promise<Group> {
    const source = this.sourceOf(ref);
    if (!source) return Promise.reject(new Error(`Entry "${ref.catalogId}" has no glbUrl and no registry origin.`));
    return source.resolve
      ? this.modelCache.getOrLoadResolved(source.key, source.resolve, opts)
      : this.modelCache.getOrLoad(source.key, opts);
  }

  /**
   * The FULL source tree of the reference, freshly decoded and uncached
   * (plan-754 §2.6 class (c)).
   *
   * The one door to the hierarchy a destructive bake consumed. Costs a parse
   * every time by design — its callers either edit the tree or consume it, so
   * handing two of them the same object would be a bug, not a saving.
   */
  decodeFreshModel(ref: PlacementRef, opts?: { signal?: AbortSignal }): Promise<Group> {
    const source = this.sourceOf(ref);
    if (!source) return Promise.reject(new Error(`Entry "${ref.catalogId}" has no glbUrl and no registry origin.`));
    return this.modelCache.decodeFresh(source.key, source.resolve, opts);
  }

  /** Drop the decoded master + bakes of a reference (editor-save invalidation). */
  invalidate(ref: PlacementRef): void {
    const source = this.sourceOf(ref);
    if (source) this.modelCache.invalidate(source.key);
  }

  // ── Materialise / release — the ONE order ───────────────────────────

  /** A fresh transform-neutral placement root for `baked` (named after the master). */
  createRoot(baked: BakedAsset): Group {
    const root = new Group();
    root.name = baked.template.name || 'Asset';
    return root;
  }

  /**
   * Instantiate `baked` under `root` — synchronous, no host knowledge, ONE
   * fixed order for every entry:
   *
   *   thaw root → markers → instantiate → subtree markers → shadow flags →
   *   pivot → overrides → world matrices → render mode → nested references
   *
   * `root` is a fresh {@link createRoot} (live drop, duplicate, restore), the
   * emptied placeholder root (draft swap) or the deferred reference node
   * (reload). It is never moved: the pivot shifts CHILD positions only.
   * Everything host-specific — parenting, floor align, unique name, id maps,
   * runtime registration, snap ports, bindings, selection, undo — is the
   * caller's, around this call.
   *
   * The LAST step (plan-757 Phase 2, F1/F8) scans the fresh instance for
   * reference nodes and queues each as a placement of its own — on every
   * entry, so a live drop of an asset with nested references fills them in as
   * a reload does. Mid-session that flips `state` to `materializing` (no
   * settle: no load is open); a host that needs the nested content joins
   * {@link whenMaterialized}. `hooks` are the parent's deferred hooks, of which
   * a nested entry takes `resolveUrl` / `isLive` only (never `register` /
   * `missing`: a nested instance is content, not a record).
   */
  materialize(root: Object3D, baked: BakedAsset, spec: MaterializeSpec, hooks?: DeferredPlacementHooks): PlacementInstance {
    // The loader's freeze pass turns an empty static root's matrix update off;
    // a placement moves as a unit. No-op for a fresh root.
    root.matrixAutoUpdate = true;
    root.matrixWorldAutoUpdate = true;

    if (spec.nestedOf) stampNestedPlacementMarkers(root, spec.nestedOf, spec.id);
    else stampPlacementMarkers(root, spec.id, spec.label, spec.catalogId);
    // What RVSource's self-template detection compares against — the name
    // BEFORE any unique-name suffix the host adds.
    root.userData._originalName ??= root.name;

    const registry = this.bakeRegistry;
    const instance = registry.instantiate(baked, root);
    // F7: the trust the chain above withholds is a property of the instance (absent = no chain).
    instance.chainState = spec.chainState;
    root.traverse(markLayoutObject);
    applyShadowFlags(root);
    if (spec.pivot !== false) pivotWithDriveHomeStamps(root as Group);
    if (spec.overrides) registry.applyOverrides(instance, spec.overrides);
    root.updateMatrixWorld(true);
    this._deps.applyRenderMode?.(root);
    this._queueNested(instance, spec, hooks);
    return instance;
  }

  /**
   * Release the instance rooted at `root` AND every nested instance under it
   * (F4 — `BakeRegistry.releaseSubtree`, innermost first). False when nothing
   * under `root` was an instance.
   */
  release(root: Object3D): boolean {
    const registry = this.bakeRegistry;
    for (const r of registry.instanceRootsUnder(root)) this._ownedRoots.delete(r);
    return registry.releaseSubtree(root) > 0;
  }

  /** The instance whose root is `root`, or null. */
  instanceOf(root: Object3D): PlacementInstance | null {
    return this.bakeRegistry.instanceOf(root);
  }

  // ── Deferred placements of a loaded layout document ─────────────────

  /**
   * Materialise the deferred placement roots of a load (plan-753, Reload =
   * shared instances). The deferred mark is consumed HERE, synchronously — an
   * entry is materialised once, whoever asks first (the planner in
   * `adoptPlacements`, else the viewer after `onModelLoaded`).
   *
   * Grouped by asset, smaller assets first when the references carry bounds:
   * an occurrence's chunks appear as early as they can, and the largest bake
   * never delays every smaller one. One bake per asset — later occurrences
   * join the in-flight bake.
   *
   * @returns the number of entries queued.
   */
  materializeDeferred(entries: readonly DeferredPlacementEntry[], hooks?: DeferredPlacementHooks): number {
    const generation = this._generation;
    const groups = new Map<string, DeferredPlacementEntry[]>();
    let queued = 0;
    for (const e of entries) {
      if (!getDeferredPlacement(e.node) || this._materializing.has(e.id)) continue;
      clearDeferredPlacement(e.node);
      const key = e.ref.catalogId || e.ref.glbUrl || e.id;
      const group = groups.get(key);
      if (group) group.push(e); else groups.set(key, [e]);
      queued++;
    }
    if (queued === 0) return 0;
    this._total += queued;

    // `sort` is stable: groups without bounds keep document order, after the sized ones.
    const ordered = [...groups.values()].sort((a, b) => boundsVolume(a[0].node) - boundsVolume(b[0].node));
    for (const group of ordered) {
      const step = this._queue.then(() => Promise.all(group.map((entry) =>
        this._materializeOne(entry, hooks, generation)
          .catch((err) => { console.warn(`[PlacementInstancer] Could not restore "${entry.label}": ${err}`); }),
      )));
      const settled = step.then(() => undefined, () => undefined);
      for (const entry of group) {
        const tracked: Promise<void> = settled.then(() => {
          if (this._materializing.get(entry.id) === tracked) this._materializing.delete(entry.id);
          this._notifyIdle();
        });
        this._materializing.set(entry.id, tracked);
      }
      this._queue = settled;
    }
    this._publishState();
    return queued;
  }

  /**
   * THE scene-completeness state: `materializing` while at least one deferred
   * placement of the current document is queued or baking. Until it is `idle`
   * again those placements are missing from the scene graph, the NodeRegistry,
   * the SignalStore, snap pairing, bounds and the transport topology.
   */
  get state(): PlacementsState {
    return this._materializing.size > 0 ? 'materializing' : 'idle';
  }

  /** Counters of the current document's deferred placements. */
  get progress(): PlacementsProgress {
    const pending = this._materializing.size;
    return {
      state: pending > 0 ? 'materializing' : 'idle',
      total: this._total,
      materialized: this._materialized,
      pending,
      missing: Math.max(0, this._total - this._materialized - pending),
    };
  }

  /**
   * The load's deferred placements are all queued (the viewer calls this right
   * after it emitted `model-loaded`). From here on the instancer owes exactly
   * ONE `onSettled` for this load: at once when nothing is pending (a document
   * without references included), else when the queue drains, else — with
   * `aborted: true` — on the document change that overtakes it.
   */
  sealLoad(): void {
    this._loadOpen = true;
    this._settleIfIdle();
  }

  /** True while `id` waits for / runs its materialisation. */
  isMaterializing(id: string): boolean {
    return this._materializing.has(id);
  }

  /**
   * Resolves when the materialisation queue of the CURRENT load is empty —
   * every deferred placement instantiated, or failed into its placeholder.
   * Also resolves on a document change / abort: the orphaned materialisations
   * of the previous document write nothing and are no longer waited for.
   */
  whenMaterialized(): Promise<void> {
    if (this._materializing.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this._idleWaiters.push(resolve); });
  }

  private _notifyIdle(): void {
    if (this._materializing.size > 0) return;
    this._publishState();
    // The event first: a `whenMaterialized()` continuation then already sees
    // what the `placements-materialized` listeners did (camera refit, DES bind).
    this._settleIfIdle();
    if (this._idleWaiters.length === 0) return;
    const waiters = this._idleWaiters;
    this._idleWaiters = [];
    for (const w of waiters) w();
  }

  private _settleIfIdle(): void {
    if (!this._loadOpen || this._materializing.size > 0) return;
    this._loadOpen = false;
    this._emitSettled(false);
  }

  private _emitSettled(aborted: boolean): void {
    const onSettled = this._deps.onSettled;
    if (!onSettled) return;
    try {
      onSettled({
        aborted,
        total: this._total,
        materialized: this._materialized,
        missing: aborted ? 0 : Math.max(0, this._total - this._materialized),
      });
    } catch (err) {
      console.warn(`[PlacementInstancer] onSettled failed: ${err}`);
    }
  }

  private _publishState(): void {
    const state = this.state;
    if (state === this._lastState) return;
    this._lastState = state;
    try { this._deps.onStateChanged?.(state); } catch (err) {
      console.warn(`[PlacementInstancer] onStateChanged failed: ${err}`);
    }
  }

  private async _materializeOne(
    entry: DeferredPlacementEntry,
    hooks: DeferredPlacementHooks | undefined,
    generation: number,
  ): Promise<void> {
    if (generation !== this._generation) return;
    const overrides = getAssetOverrides(entry.node);
    const forceSplitNodeIds = overrides?.trsByNodeId ? Object.keys(overrides.trsByNodeId) : undefined;
    const missing = hooks?.missing ?? this._deps.missingDefault;

    let baked: BakedAsset;
    try {
      const isProject = entry.ref.catalogId.startsWith(PROJECT_PLACEMENT_PREFIX);
      const url = !isProject && hooks?.resolveUrl ? await hooks.resolveUrl(entry) : undefined;
      if (generation !== this._generation) return;
      baked = await this.resolveBaked(url ? { ...entry.ref, url } : entry.ref, { forceSplitNodeIds });
    } catch (err) {
      if (generation !== this._generation) return;
      missing?.(entry, err);
      return;
    }
    // The load moved on while the asset baked (clearModel / a newer document):
    // the root is no longer part of the live model — nothing to attach to.
    if (generation !== this._generation || baked.disposed) return;
    const isLive = hooks?.isLive ?? this._deps.isLive;
    if (isLive && !isLive(entry.node)) return;

    // The ONE order — its last step queues the nested references of this
    // instance (F1/F8), synchronously, while this entry's id is still in
    // `_materializing`: `_notifyIdle` / `_settleIfIdle` cannot see an empty
    // queue between the outer instance and its nested ones, and
    // `placements-materialized` fires after the innermost.
    const instance = this.materialize(entry.node, baked, {
      id: entry.id, label: entry.label, catalogId: entry.ref.catalogId, overrides,
      // The pivot rule of the reference node, not of the entry point (spike S2 finding 3).
      pivot: entry.pivot,
      chain: entry.chain, depth: entry.depth, chainState: entry.chainState,
      occurrence: entry.occurrence, nestedOf: entry.nestedOf,
    }, hooks);
    this._materialized++;
    // F11: a throwing host registration neither loses the instance nor its
    // nested references (those are queued already) — it is reported.
    try {
      if (hooks?.register) {
        hooks.register(entry, instance);
      } else {
        this._ownedRoots.add(entry.node);
        this._deps.registerDefault?.(entry, instance);
      }
    } catch (err) {
      console.warn(`[PlacementInstancer] register of "${entry.label}" failed: ${err}`);
      try { this._deps.onRegisterFailed?.(entry, err); } catch (e) {
        console.warn(`[PlacementInstancer] onRegisterFailed failed: ${e}`);
      }
    }
  }

  /** F14: the template's reference nodes of `baked`, memoised per asset. */
  private _templateReferenceNodesOf(baked: BakedAsset): readonly Object3D[] {
    let refs = this._templateRefs.get(baked);
    if (!refs) {
      refs = walkReferenceNodes(baked.template);
      this._templateRefs.set(baked, refs);
    }
    return refs;
  }

  /**
   * Queue the reference nodes inside a fresh instance as placements of their
   * own (F8) — the last step of {@link materialize}. Refusals: cycle / depth
   * per node to `deps.onNestedRefused` (the host draws the hole), the per-load
   * cap as ONE aggregated `deps.onCapReached` (F9). The rest is marked
   * deferred and handed to {@link materializeDeferred} — one bake per nested
   * asset, later occurrences (every instance of the parent) join it.
   */
  private _queueNested(instance: PlacementInstance, spec: MaterializeSpec, hooks: DeferredPlacementHooks | undefined): void {
    const baked = instance.baked;
    const templateRefs = this._templateReferenceNodesOf(baked);
    if (templateRefs.length === 0) return;
    const nodes: Object3D[] = [];
    for (const t of templateRefs) {
      const node = instance.nodeOf.get(t);
      if (node) nodes.push(node);
    }
    const parent: NestedScanParent = {
      node: instance.root,
      id: spec.id,
      occurrence: spec.occurrence ?? spec.id,
      chain: spec.chain ?? this._documentChain(),
      depth: spec.depth ?? 0,
      chainState: spec.chainState,
    };
    const { entries, refused } = collectNestedReferences(parent, {
      parentKey: baked.assetId,
      parentUrl: baked.url,
      parentState: baked.signatureState,
      keyOf: (ref) => this.keyOf(ref),
      nodes,
    });
    for (const r of refused) {
      try { this._deps.onNestedRefused?.(r); } catch (err) {
        console.warn(`[PlacementInstancer] onNestedRefused failed: ${err}`);
      }
    }
    const cap = this.maxPlacementsPerLoad;
    const accepted: DeferredPlacementEntry[] = [];
    let capped = 0;
    for (const e of entries) {
      if (this._total + accepted.length >= cap) {
        capped++;
        this._capRefused++;
        if (this._capNodes.length < PLACEMENT_CAP_REPORTED_NODES) this._capNodes.push(e.node);
        continue;
      }
      accepted.push(e);
    }
    if (capped > 0) {
      try { this._deps.onCapReached?.({ cap, refused: this._capRefused, nodes: [...this._capNodes] }); } catch (err) {
        console.warn(`[PlacementInstancer] onCapReached failed: ${err}`);
      }
    }
    if (accepted.length === 0) return;
    for (const e of accepted) markDeferredPlacement(e.node, e.occurrence);
    const nestedHooks: DeferredPlacementHooks | undefined = hooks
      ? { resolveUrl: hooks.resolveUrl, isLive: hooks.isLive }
      : undefined;
    this.materializeDeferred(accepted, nestedHooks);
  }

  /** The chain a document-level placement starts from: the document's own key (F13). */
  private _documentChain(): readonly string[] {
    return this._documentKey ? [this._documentKey] : [];
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Document change (viewer `clearModel`): abandon the queue, release the
   * instances this instancer owns (no-planner path — the planner releases its
   * own), THEN retire the document's bakes and drop the decoded masters. The
   * blob cache underneath keeps the bytes.
   */
  clearDocument(): void {
    this._generation++;
    // A load that still owed its settle notification — sealed and pending, or
    // overtaken before the viewer could seal it — ends HERE, as aborted. A
    // settled load owes nothing: one notification per load, never two.
    const owed = this._loadOpen || this._materializing.size > 0;
    this._materializing.clear();
    this._queue = Promise.resolve();
    this._loadOpen = false;
    if (owed) this._emitSettled(true);
    this._total = 0;
    this._materialized = 0;
    this._capRefused = 0;
    this._capNodes.length = 0;
    this._documentKey = null;
    this._notifyIdle();
    const registry = this.bakeRegistry;
    // Nested instances go with their owner (F4); a nested root owned here as
    // well is released by the first pass and a no-op for the second.
    for (const root of this._ownedRoots) registry.releaseSubtree(root);
    this._ownedRoots.clear();
    this._cache?.clearDecoded();
  }

  /** Terminal teardown — call AFTER every placement released its instance. */
  dispose(): void {
    this.clearDocument();
    this._cache?.dispose();
    this._cache = null;
  }
}

function markLayoutObject(node: Object3D): void {
  node.userData._layoutObject = true;
}

/**
 * `pivotToFloorCenter` + the plan-757 §2.4 rule (R11): a shift of a node
 * shifts its home stamp. The pivot moves the DIRECT children of the instance
 * root; a drive among them carries the `Drive` hook's home stamp (JSON-cloned
 * from the template, authored frame), and `initDrive()` prefers that stamp
 * over the live transform — so without this step the first `applyToNode()`
 * would silently undo the pivot for exactly those drives (fixture (h)). The
 * delta is measured per child, so the rule holds whatever the pivot decided.
 */
function pivotWithDriveHomeStamps(root: Group): void {
  const children = root.children;
  const before = new Float64Array(children.length * 3);
  for (let i = 0; i < children.length; i++) {
    const p = children[i].position;
    before[i * 3] = p.x; before[i * 3 + 1] = p.y; before[i * 3 + 2] = p.z;
  }
  pivotToFloorCenter(root);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const home = child.userData?.[RV_DRIVE_HOME_KEY] as DriveHomePose | undefined;
    if (!home || !Array.isArray(home.p)) continue;
    const dx = child.position.x - before[i * 3];
    const dy = child.position.y - before[i * 3 + 1];
    const dz = child.position.z - before[i * 3 + 2];
    if (dx === 0 && dy === 0 && dz === 0) continue;
    home.p = [home.p[0] + dx, home.p[1] + dy, home.p[2] + dz];
  }
}

function boundsVolume(node: Object3D): number {
  const b = getAssetReference(node)?.bounds;
  if (!b) return Number.POSITIVE_INFINITY;
  return (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
}
