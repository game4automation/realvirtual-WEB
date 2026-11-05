// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { bumpModelEditEpoch } from './rv-model-edit-epoch';
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

import { addPatchTypes, collectComponentTypes } from './rv-component-types';
import { Group } from 'three';
import type { Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ModelCache, resolvedCacheKey, type BakeStats, type ModelCacheUberOptions } from './rv-model-cache';
import type { BakeRegistry, InstanceOverrideLayer, PlacementInstance } from './rv-bake-registry';
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
  RV_AUTHORED_LAYOUT_OBJECT_KEY,
  RV_LAYOUT_OBJECT_STAMP_KEY,
  type AssetOverrides,
  type NestedOverride,
  type OrphanReason,
} from './rv-asset-reference';
import { childOccurrence } from './rv-node-id';
import { isMissingReferencePlaceholder } from './rv-missing-reference-placeholder';
import { NodeRegistry } from './rv-node-registry';
import { reportOverrideOrphaned } from '../hmi/problems-store';
import { identityIdOf } from './rv-decode-identity';
import { parametricRequestsOf } from './rv-parametric-component';
import { resolveReferenceUrl, weakestSignatureState } from './rv-glb-compose';
import { gltfLoader as sharedGltfLoader } from './rv-glb-parse';
import {
  isProjectDocumentId,
  rebaseLocalLibraryUrl,
} from '../library/rv-placement-source';
import {
  findQualifiedOrigin,
  isQualifiedRef,
  isStrictDocumentRef,
  LIBRARY_PROJECTS_PROVIDER_ID,
  qualifiedSourceState,
  resolveDocumentRef,
  resolveDocumentRefSettled,
  scopeOfQualifiedRef,
  type DocumentScope,
  type RefResolution,
  type ResolvedRef,
} from '../library/library-origin';
import { listLibrarySources, subscribeLibrarySources } from '../library/library-source-registry';
import { RESOLVED_KEY_PREFIX } from '../library/rv-asset-hash-registry';

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
  /**
   * The reference's qualifier (plan-778 F4). `providerId: 'library-projects'`
   * + `sourceId` = a STRICT reference into one library project: resolved in
   * that source only, checked BEFORE any url / path, never through the host's
   * fallback. Any other pair (a pre-778 `global` + catalog URL) is a legacy
   * hint for the legacy search (`findLegacyOrigin`, via `resolveDocumentRef`).
   */
  providerId?: string;
  sourceId?: string;
}

/** The qualifier fields of an `AssetReference` as {@link PlacementRef} fields (none when absent). */
function qualifierFieldsOf(reference: { providerId?: string; sourceId?: string } | null): Pick<PlacementRef, 'providerId' | 'sourceId'> {
  if (!reference?.providerId && !reference?.sourceId) return {};
  return {
    ...(reference.providerId ? { providerId: reference.providerId } : {}),
    ...(reference.sourceId ? { sourceId: reference.sourceId } : {}),
  };
}

/** The bake / chain key of a QUALIFIED reference — stable whether or not its source is ready. */
function qualifiedKeyOf(ref: PlacementRef): string {
  return resolvedCacheKey(ref.providerId as string, ref.sourceId as string, ref.catalogId);
}

/** Key of a strict reference in `scope`, stable while its library is pending (plan-780). */
function strictKeyOf(ref: PlacementRef, scope: DocumentScope): string {
  if (isQualifiedRef(ref)) return qualifiedKeyOf(ref);
  return scope ? resolvedCacheKey(scope.providerId, scope.sourceId, ref.catalogId) : assetKeyOf(ref);
}

/** plan-780 R1: a strict hit's qualified form (no url); null for a legacy hit, kept as written. */
function effectiveRefOf(hit: ResolvedRef): PlacementRef | null {
  if (!hit.qualified) return null;
  return { catalogId: hit.assetId, glbUrl: '', providerId: hit.registered.providerId, sourceId: hit.registered.source.id };
}

/** Key `resolved:<provider>:<source>:<id>` + transport of a hit. */
function sourceOfHit(hit: ResolvedRef): PlacementSource {
  const source = hit.registered.source;
  const id = hit.assetId;
  return {
    key: resolvedCacheKey(hit.registered.providerId, source.id, id),
    resolve: () => source.resolveAsset(id, 'place'),
  };
}

/** plan-780 2.1: scope of content baked under `assetKey`, read off the key; undefined = url-keyed. */
export function scopeOfAssetKey(assetKey: string): DocumentScope | undefined {
  if (!assetKey.startsWith(RESOLVED_KEY_PREFIX)) return undefined;
  const rest = assetKey.slice(RESOLVED_KEY_PREFIX.length);
  const providerEnd = rest.indexOf(':');
  if (providerEnd < 0) return null;
  const providerId = rest.slice(0, providerEnd);
  if (providerId !== LIBRARY_PROJECTS_PROVIDER_ID) return null;
  const sourceEnd = rest.indexOf(':', providerEnd + 1);
  const sourceId = sourceEnd < 0 ? '' : rest.slice(providerEnd + 1, sourceEnd);
  return sourceId ? { providerId, sourceId } : null;
}

/** {@link scopeOfAssetKey}; a url-keyed asset keeps `inherited`. */
function contentScopeOf(assetKey: string, inherited: DocumentScope): DocumentScope {
  const s = scopeOfAssetKey(assetKey);
  return s === undefined ? inherited : s;
}

/** Problems-row reason of a strict reference without a source. */
function unresolvedReason(ref: PlacementRef, r: RefResolution): string {
  if ('missing' in r) return r.reason;
  if ('pending' in r) {
    const where = r.source ? `library "${r.source.sourceId}"` : 'the libraries';
    return `"${ref.catalogId}" waits for ${where} to finish loading — it is placed when it is ready.`;
  }
  return `"${ref.catalogId}" could not be placed.`;
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
  /** Saved `AssetOverrides` (`byAddress`, plan-769; component values only). Applied after the pivot. */
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
   * plan-650 Phase 5b: parametric nesting level of THIS placement (1 = a
   * family placement whose overrides carry family values, +1 per nested child
   * family) - bounded by {@link MAX_PARAMETRIC_DEPTH}. Absent = 0.
   */
  paramDepth?: number;
  /** plan-650 Phase 5b: id of the outermost placement - the key of the aggregated child budget. */
  paramRoot?: string;
  /**
   * The parent placement's id when THIS root is a nested reference node inside
   * a placed asset (F5). Such a root is content of its parent: it gets
   * `_layoutObject` + `_layoutNestedOf`, never a planner record's `_layoutId`.
   */
  nestedOf?: string;
  /** plan-780 2.1: scope of this placement's nested references; absent = {@link scopeOfAssetKey}. */
  scope?: DocumentScope;
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
  /**
   * plan-650 Phase 5b: parametric nesting level of THIS placement (1 = a
   * family placement whose overrides carry family values, +1 per nested child
   * family) - bounded by {@link MAX_PARAMETRIC_DEPTH}. Absent = 0.
   */
  paramDepth?: number;
  /** plan-650 Phase 5b: id of the outermost placement - the key of the aggregated child budget. */
  paramRoot?: string;
  /**
   * plan-780 R2: project of the document this reference is written in, captured at
   * queue time (contract documents-projects 4). Absent / null = the open project.
   */
  scope?: DocumentScope;
}

/** Why a nested reference was NOT queued as a placement (per node). */
export type NestedRefusalReason = 'cycle' | 'depth' | 'parametric-cycle' | 'parametric-depth' | 'parametric-budget';

/** plan-650 Phase 5b: most parametric levels in one placement tree (the family itself = 1). */
export const MAX_PARAMETRIC_DEPTH = 4;
/** plan-650 Phase 5b: most nested child-family placements below ONE outermost placement. */
export const MAX_PARAMETRIC_TREE_PLACEMENTS = 256;
/** plan-650 Phase 5b: most baked vertices of all child-family placements below ONE outermost placement. */
export const MAX_PARAMETRIC_TREE_VERTICES = 2_000_000;

/** Is `node` a parametric child reference (its overrides carry family values)? */
export function isParametricReferenceNode(node: Object3D): boolean {
  return parametricRequestsOf(getAssetOverrides(node)).length > 0;
}

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
  /**
   * plan-778 Decision D / F8, the other direction: the library source of a
   * QUALIFIED placement went away (detached, error, permission lost) while its
   * instance stands. Undo what `register` did to the runtime (components,
   * drives, behaviours, snap ports …) and release the instance, but KEEP the
   * reference node — the instancer draws the placeholder right after
   * (`missing`) and brings the content back when the source answers again.
   */
  lost?(entry: DeferredPlacementEntry, instance: PlacementInstance): void;
  /** Overrides when the root carries none (a live placement's values sit in the host record; plan-778). */
  overridesOf?(entry: DeferredPlacementEntry): AssetOverrides | null | undefined;
}

/** How the instancer reaches its host — injected, the engine must not know `RVViewer`. */
export interface PlacementInstancerDeps extends ModelCacheUberOptions {
  /** The registry placements are instances of (the viewer's). */
  bakeRegistry: () => BakeRegistry;
  /** Match a subtree to the active render mode (toon swap + recompile). */
  applyRenderMode?: (root: Object3D) => void;
  /**
   * plan-652 Phase 3: activates the on-demand features the placement's component
   * types need (DES) before {@link PlacementInstancer.materialize} builds them —
   * the asset's own types plus those its overrides add.
   */
  ensureComponentTypes?: (types: Iterable<string>) => Promise<void>;
  /** GLTF loader of the model cache. Default: the engine's shared loader. */
  loader?: GLTFLoader;
  /** Default liveness test of a deferred root (viewer: under `currentModel`). */
  isLive?: (node: Object3D) => boolean;
  /** Default registration of a deferred root when no hook registers it. */
  registerDefault?: (entry: DeferredPlacementEntry, instance: PlacementInstance) => void;
  /** Default missing-asset handling when no hook handles it. */
  missingDefault?: (entry: DeferredPlacementEntry, error: unknown) => void;
  /** Default {@link DeferredPlacementHooks.lost} when no hook handles it. */
  lostDefault?: (entry: DeferredPlacementEntry, instance: PlacementInstance) => void;
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
  /**
   * plan-778 F8: a placeholder placement is about to be re-resolved because its
   * library source became ready — the placeholder child is already removed;
   * the host clears what else it attached (the missing-reference problem).
   */
  onReresolve?: (entry: DeferredPlacementEntry) => void;
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

/**
 * userData flag of a reference node between `materializeDeferred` (deferred
 * mark consumed) and its marker stamp — keeps it a signal-scope root in that
 * window (plan-612 #149, read inline by `rv-instance-scope.ts`).
 */
const PLACEMENT_PENDING_KEY = '_rvPlacementPending';

/** Marker + `LayoutObject` stamp of a placement root — one definition (F2). */
export function stampPlacementMarkers(root: Object3D, id: string, label: string, catalogId: string, locked = false): void {
  root.userData._layoutObject = true;
  root.userData._layoutId = id;
  delete root.userData._layoutNestedOf;
  delete root.userData[PLACEMENT_PENDING_KEY];
  // plan-774 review fix E2: the PURE stamp, so the editor's save can tell a
  // runtime-only field from one the user changed (`dropRuntimePlacementStamps`).
  root.userData[RV_LAYOUT_OBJECT_STAMP_KEY] = { Label: label, CatalogId: catalogId, Locked: locked };
  if (root.userData.realvirtual && typeof root.userData.realvirtual === 'object') {
    (root.userData.realvirtual as Record<string, unknown>).LayoutObject = { Label: label, CatalogId: catalogId, Locked: locked };
  } else {
    root.userData.realvirtual = { LayoutObject: { Label: label, CatalogId: catalogId, Locked: locked } };
  }
}

/**
 * plan-774 review fix E2: a reference node whose FILE authored a `LayoutObject`
 * (recorded by the loader as `_rvAuthoredLayoutObject` before any stamp) keeps
 * it — every authored field wins (`Locked`, `Visible`, its own `Label` /
 * `CatalogId`, …); the stamp only adds the runtime fields the file did not
 * write. Without a record (a live drop, a nested root) the stamp stands as is.
 */
function mergeAuthoredLayoutObject(root: Object3D): void {
  const authored = root.userData[RV_AUTHORED_LAYOUT_OBJECT_KEY];
  if (!authored || typeof authored !== 'object') return;
  const rv = root.userData.realvirtual as Record<string, unknown> | undefined;
  const stamp = rv?.LayoutObject as Record<string, unknown> | undefined;
  if (!rv || !stamp || typeof stamp !== 'object') return;
  const merged: Record<string, unknown> = JSON.parse(JSON.stringify(authored));
  for (const [key, value] of Object.entries(stamp)) if (!(key in merged)) merged[key] = value;
  rv.LayoutObject = merged;
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
  delete root.userData[PLACEMENT_PENDING_KEY];
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

/**
 * The deferred placement roots under `root`, in document order (marks untouched).
 * `scope` (plan-780 R2) is captured on every entry.
 */
export function collectDeferredPlacements(root: Object3D, scope: DocumentScope = null): DeferredPlacementEntry[] {
  const out: DeferredPlacementEntry[] = [];
  const walk = (node: Object3D): void => {
    const mark = getDeferredPlacement(node);
    if (mark) {
      const reference = getAssetReference(node);
      // plan-757 Phase 2b: a hand-authored document reference has no NodeId of
      // its own (compose derives one only when the file's sha256 is known) —
      // the occurrence chain compose assigned is its id then. Without EITHER
      // the node is a reference nobody can address; it stays empty.
      // plan-769 F12: the node's IDENTITY (authored NodeId or decode seed) first.
      const id = identityIdOf(node) ?? mark.occurrence;
      if (id) {
        out.push({
          node,
          id,
          label: node.name,
          occurrence: mark.occurrence || id,
          // The path resolved against the CONTAINING file where the mark carries
          // it (a relative `path` of a deferred document reference), else as written.
          // plan-778 F4: a qualified reference never carries a url — a stored
          // `path` beside a qualifier is ignored, it must not win over the library.
          ref: isQualifiedRef(reference)
            ? { catalogId: reference!.assetId, glbUrl: '', ...qualifierFieldsOf(reference) }
            : {
                catalogId: reference?.assetId || getPlacementMeta(node)?.catalogId || '',
                glbUrl: mark.resolvedPath || reference?.path || '',
                ...qualifierFieldsOf(reference),
              },
          // The pivot rule of the reference node (spike S2 finding 3): a planner
          // placement is floor-centre pivoted, a hand-authored CAD sub-assembly
          // keeps its child transforms — what `compose()` applies when it grafts.
          pivot: getPlacementMeta(node) !== null,
          scope,
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

/** Does a cache key / url name the project-relative file `relPath` (normalized, no leading `/`)? */
function addressesPath(keyOrUrl: string, relPath: string): boolean {
  if (!keyOrUrl || !relPath) return false;
  const k = keyOrUrl.replace(/\\/g, '/').split(/[?#]/)[0].toLowerCase();
  const p = relPath.toLowerCase();
  return k === p || k.endsWith('/' + p) || k.endsWith(':' + p);
}

/** What the nested scan needs to know about the PARENT asset of the references it finds. */
export interface NestedScanContext {
  /** The parent asset's cache key (`BakedAsset.assetId`) — appended to the chain. */
  parentKey: string;
  /** The parent asset's url (`BakedAsset.url`) — the base of a relative `path` (F3). */
  parentUrl: string;
  /** The parent asset's own signature state — folded into the nested chain state (F7). */
  parentState: SignatureState;
  /** ONE key derivation for the cycle guard (F13), {@link scope} bound in. */
  keyOf: (ref: PlacementRef) => string;
  /** plan-780 2.1: scope of the parent's content; nested unqualified refs resolve there (D2). */
  scope?: DocumentScope;
  /**
   * The reference nodes of the instance, when the caller already knows them
   * (F14: the instancer memoises the template's reference nodes per asset and
   * maps them through `instance.nodeOf`). Default: walk the instance.
   */
  nodes?: readonly Object3D[];
}

/** The parent placement, as the nested scan sees it. */
export type NestedScanParent = Pick<DeferredPlacementEntry, 'node' | 'id' | 'occurrence' | 'chain' | 'depth' | 'chainState' | 'paramDepth' | 'paramRoot'>;

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
  for (const node of ctx.nodes ?? walkReferenceNodes(parent.node)) {
    const reference = getAssetReference(node);
    if (!reference) continue;
    // plan-769 F12: the occurrence segment is the reference node's IDENTITY — its
    // authored NodeId or its decode seed (every decoded node has one). The
    // positional `@ordinal` fallback is gone: an id-less reference node names no
    // occurrence anybody could address again, so it stays empty, visibly.
    const segment = identityIdOf(node);
    if (!segment) {
      console.warn(`[placement] nested reference "${node.name}" carries no identity (no NodeId, no decode seed) — left empty`);
      continue;
    }
    // plan-778 F4: a qualified nested reference ignores any stored path.
    const catalogId = reference.assetId || getPlacementMeta(node)?.catalogId || '';
    // plan-780: kept as written; the parent's scope travels with it, the ONE resolver decides.
    const scope = ctx.scope ?? null;
    const asWritten: PlacementRef = { catalogId, glbUrl: '', ...qualifierFieldsOf(reference) };
    const strict = isStrictDocumentRef(asWritten, scope);
    const glbUrl = !strict && reference.path ? resolveReferenceUrl(ctx.parentUrl, reference.path) : '';
    const ref: PlacementRef = { ...asWritten, glbUrl };
    const key = ctx.keyOf(ref);
    const base = { node, label: node.name, ref, assetKey: key, chain, depth };
    // plan-650 Phase 5b: a reference whose overrides carry family values is a
    // parametric level - its own cycle code and the tighter depth bound.
    const isParam = isParametricReferenceNode(node);
    const paramDepth = (parent.paramDepth ?? 0) + (isParam ? 1 : 0);
    if (chain.includes(key)) refused.push({ reason: isParam ? 'parametric-cycle' : 'cycle', ...base });
    else if (depth > MAX_REFERENCE_DEPTH) refused.push({ reason: 'depth', ...base });
    else if (isParam && paramDepth > MAX_PARAMETRIC_DEPTH) refused.push({ reason: 'parametric-depth', ...base });
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
        paramDepth,
        paramRoot: parent.paramRoot ?? parent.id,
        scope,
      });
    }
  }
  return { entries, refused };
}

/**
 * plan-769 Phase 4b (F13): one override an outer placement aims into a nested
 * occurrence, waiting for (or already applied to) that occurrence's instance.
 */
interface RoutedOverride {
  /** Occurrence of the placement that STORES the override. */
  sourceOcc: string;
  /** Depth of the file holding the record — the storing placement's depth (outer = smaller = stronger). */
  depth: number;
  /** ONE entry, addressed relative to the TARGET occurrence's asset (`#<id>`, `<c>#<id>`, or a legacy path). */
  overrides: AssetOverrides;
  /** The storing reference node, for the Problems panel: its path, label, asset, the key as it wrote it. */
  source: { nodePath: string; label: string; assetId: string; occurrence: string; key: string; addressing: 'address' | 'path' };
}

/** The override set of a {@link NestedOverride}'s remainder. */
function remainderOverrides(n: NestedOverride): AssetOverrides {
  return n.address !== undefined
    ? { byAddress: { [n.address]: n.patch } }
    : { byAddress: {}, legacyByPath: { [n.path ?? '']: n.patch } };
}

function occurrenceBelow(base: string, segments: readonly string[]): string {
  let occ = base;
  for (const seg of segments) occ = childOccurrence(occ, seg);
  return occ;
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
  /**
   * plan-774 F6: state of the kept-baked window. `open` = the last clear kept
   * the bakes and the next settle retires the unclaimed ones; `held` = a
   * descend keeps them past that settle; `none` = nothing kept.
   */
  private _keptWindow: 'none' | 'open' | 'held' = 'none';
  /** Per-load cap bookkeeping (F9) — one aggregated report, re-issued as it grows. */
  private _capRefused = 0;
  private readonly _capNodes: Object3D[] = [];
  /**
   * plan-769 Phase 4b (F13): overrides outer placements route into nested
   * occurrences, by TARGET occurrence — applied with the target's own record when
   * it materialises (`applyOverrideLayers`: the outer file wins), at once when it
   * is already live. Flushed with a reason on missing / cap / refusal, cleared with
   * the document; what is left once nothing is pending is an orphan (`missing`).
   */
  private readonly _routed = new Map<string, RoutedOverride[]>();
  /** Live instance per occurrence — where a routed override lands at once. */
  private readonly _instanceByOcc = new Map<string, PlacementInstance>();
  /** plan-650 Phase 5b: aggregated child-family budget per outermost placement id. */
  private readonly _paramTree = new Map<string, { placements: number; vertices: number }>();
  /** plan-650 Phase 5b: child-family placements per outermost placement ({@link MAX_PARAMETRIC_TREE_PLACEMENTS}). */
  maxParametricTreePlacements = MAX_PARAMETRIC_TREE_PLACEMENTS;
  /** plan-650 Phase 5b: baked vertices of all child families per outermost placement ({@link MAX_PARAMETRIC_TREE_VERTICES}). */
  maxParametricTreeVertices = MAX_PARAMETRIC_TREE_VERTICES;
  /**
   * plan-778 F8: deferred placements that fell into their placeholder, by id,
   * with the key of the registry answer at that moment. Re-queued when it changes.
   */
  private readonly _unresolved = new Map<string, {
    entry: DeferredPlacementEntry;
    hooks: DeferredPlacementHooks | undefined;
    generation: number;
    source: string | null;
  }>();
  private _unsubSources: (() => void) | null = null;
  /**
   * plan-778 Decision D: placements with a QUALIFIED reference that stand as
   * live instances, by id — materialised through the deferred path, or handed
   * in by the host for a live drop ({@link watchQualified}). When the library
   * source they name stops answering (detached, error, permission lost) they
   * fall back into their placeholder without a reload; the unresolved list
   * above brings them back. `counted` = part of the load's progress counters
   * (deferred); a live drop joins them only when it turns into a placeholder.
   */
  private readonly _liveQualified = new Map<string, {
    entry: DeferredPlacementEntry;
    hooks: DeferredPlacementHooks | undefined;
    generation: number;
    instance: PlacementInstance;
    counted: boolean;
  }>();
  private _unsubLive: (() => void) | null = null;
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
  sourceOf(ref: PlacementRef, scope: DocumentScope): PlacementSource | null {
    const catalogId = ref.catalogId ?? '';
    // plan-778 F4 / plan-780 R1: a strict reference is checked before the url
    // branch; only its ONE library answers, nothing else stands in.
    if (isStrictDocumentRef(ref, scope)) {
      const r = resolveDocumentRef(ref, scope);
      return 'hit' in r ? sourceOfHit(r.hit) : null;
    }
    const isProject = isProjectDocumentId(catalogId);
    if (!isProject) {
      const raw = (ref.url || ref.glbUrl || '').trim();
      // An UNANCHORED relative path (no scheme, no leading `/`) is what
      // `resolveReferenceUrl` leaves behind under an opaque base — a document
      // opened from a project (`rvproject:`) or from bytes (`blob:`). Fetched
      // as is it resolves against the page root and 404s, and the asset id
      // never gets its turn. With an id and a host resolver it goes through
      // `_fallbackSource` instead: library, open project's manifest, then path.
      const key = raw ? (rebaseLocalLibraryUrl(raw) ?? raw) : '';
      const unanchored = !!key && !/^[a-z][a-z0-9+.-]*:/i.test(key) && !key.startsWith('/');
      if (key && !(unanchored && catalogId && this._deps.resolveReference)) return { key };
    }
    // The ONE resolver (plan-780 R1/R3).
    const r = resolveDocumentRef(ref, scope);
    return 'hit' in r ? sourceOfHit(r.hit) : null;
  }

  /**
   * The chain key of a reference: its source key, else its bare identity (F13).
   * A strict reference keys by (library, document) even while its library is
   * not ready — two libraries' equal document ids are two assets (plan-778).
   */
  keyOf(ref: PlacementRef, scope: DocumentScope): string {
    return this.sourceOf(ref, scope)?.key ?? (isStrictDocumentRef(ref, scope) ? strictKeyOf(ref, scope) : assetKeyOf(ref));
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
   * `signal` detaches THIS asker only.
   *
   * plan-650 Phase 5 (SOL-Finding 3/6, R2-Finding 4): `overrides` are THIS
   * placement's `AssetOverrides`; their `ParametricComponent.Values` pick the
   * parametric variant (a derived `#param:` bake of the same base key, values
   * at the baked default = the base bake). Every caller passes them: the
   * deferred reload (the reference node's), a copy (the source's), a restore /
   * undo (the record's). Absent = the standard variant.
   */
  resolveBaked(
    ref: PlacementRef,
    opts?: { signal?: AbortSignal; overrides?: AssetOverrides | null; scope?: DocumentScope },
  ): Promise<BakedAsset> {
    const scope = opts?.scope ?? null;
    if (isStrictDocumentRef(ref, scope)) return this._resolveStrictBaked(ref, scope, opts);
    const source = this.sourceOf(ref, scope) ?? this._fallbackSource(ref, scope);
    if (!source) {
      // A strict verdict (ambiguous legacy path) is reported with its reason.
      const r = ref.catalogId ? resolveDocumentRef(ref, scope) : null;
      if (r && 'missing' in r && r.strict) return Promise.reject(new Error(r.reason));
      return Promise.reject(new Error(
        isProjectDocumentId(ref.catalogId ?? '')
          ? `Project asset "${ref.catalogId}" is not in the active project.`
          : `Entry "${ref.catalogId}" has no glbUrl and no registry origin.`,
      ));
    }
    const parametric = parametricRequestsOf(opts?.overrides);
    return this.modelCache.getOrLoadBaked(source.key, source.resolve, {
      signal: opts?.signal,
      ...(parametric.length > 0 ? { parametric } : {}),
    });
  }

  /**
   * plan-778 F4 / plan-780 R1: the baked asset of a STRICT reference. Waits for
   * its ONE library, then resolves there or rejects — never a fallback. A
   * rejection is not cached, so a later attempt bakes normally (F8).
   */
  private async _resolveStrictBaked(
    ref: PlacementRef,
    scope: DocumentScope,
    opts?: { signal?: AbortSignal; overrides?: AssetOverrides | null },
  ): Promise<BakedAsset> {
    const r = await resolveDocumentRefSettled(ref, scope);
    if (!('hit' in r)) throw new Error(unresolvedReason(ref, r));
    const source = sourceOfHit(r.hit);
    const parametric = parametricRequestsOf(opts?.overrides);
    return this.modelCache.getOrLoadBaked(source.key, source.resolve, {
      signal: opts?.signal,
      ...(parametric.length > 0 ? { parametric } : {}),
    });
  }

  /**
   * The host's resolver as a source (plan-757 Phase 2b, `deps.resolveReference`)
   * for a reference {@link sourceOf} cannot place: keyed by the reference's
   * bare identity (the same key {@link keyOf} gives it), transport = whatever
   * the host resolves. `null` without a host resolver or an identity, and for a
   * strict or ambiguous reference (plan-780 D2, contract node-identity 4).
   */
  private _fallbackSource(ref: PlacementRef, scope: DocumentScope): PlacementSource | null {
    if (isStrictDocumentRef(ref, scope)) return null;
    const resolve = this._deps.resolveReference;
    const key = assetKeyOf(ref);
    if (!resolve || !key) return null;
    if (ref.catalogId) {
      const r = resolveDocumentRef(ref, scope);
      if ('missing' in r && r.strict) return null;
    }
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
  peekBaked(ref: PlacementRef, scope: DocumentScope = null): BakedAsset | undefined {
    const source = this.sourceOf(ref, scope);
    const baked = source ? this.modelCache.peekBaked(source.key) : undefined;
    return baked && !baked.disposed ? baked : undefined;
  }

  /** Warm the caches for a reference — fire-and-forget, never rejects. */
  prefetch(ref: PlacementRef, opts?: { bake?: boolean; scope?: DocumentScope }): void {
    const source = this.sourceOf(ref, opts?.scope ?? null);
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
  loadModel(ref: PlacementRef, opts?: { signal?: AbortSignal; scope?: DocumentScope }): Promise<Group> {
    const source = this.sourceOf(ref, opts?.scope ?? null);
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
  decodeFreshModel(ref: PlacementRef, opts?: { signal?: AbortSignal; scope?: DocumentScope }): Promise<Group> {
    const source = this.sourceOf(ref, opts?.scope ?? null);
    if (!source) return Promise.reject(new Error(`Entry "${ref.catalogId}" has no glbUrl and no registry origin.`));
    return this.modelCache.decodeFresh(source.key, source.resolve, opts);
  }

  /** Drop the decoded master + bakes of a reference (editor-save invalidation). */
  invalidate(ref: PlacementRef, scope: DocumentScope = null): void {
    const source = this.sourceOf(ref, scope);
    if (source) this.modelCache.invalidate(source.key);
  }

  /**
   * plan-774 F6 — a DOCUMENT was written (`document-saved`): retire every
   * cache entry baked from it, so the next placement of it (a Back after a
   * descend-save above all) bakes the new bytes. Keyed by document id (plan-780
   * R3) in `doc.scope` (absent: every loaded library holding it), plus entries
   * whose key or url ends in the path. Over-matching costs a re-bake, never a
   * wrong picture. Returns the keys invalidated.
   */
  invalidateDocument(doc: { documentId?: string | null; relPath?: string | null; scope?: DocumentScope }): string[] {
    const path = (doc.relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const keys = new Set<string>();
    const documentId = doc.documentId ?? '';
    if (documentId) {
      const key = this.keyOf({ catalogId: documentId, glbUrl: '' }, doc.scope ?? null);
      if (key) keys.add(key);
      if (doc.scope === undefined) {
        for (const { providerId, source } of listLibrarySources()) {
          if (providerId !== LIBRARY_PROJECTS_PROVIDER_ID || !source.loaded) continue;
          let held = false;
          try { held = source.getEntry(documentId) !== null; } catch { held = false; }
          if (held) keys.add(resolvedCacheKey(providerId, source.id, documentId));
        }
      }
    }
    if (path && this._cache) {
      for (const e of this._cache.knownEntries()) {
        if (addressesPath(e.key, path) || addressesPath(e.url, path)) keys.add(e.key);
      }
    }
    if (this._cache) for (const key of keys) this._cache.invalidate(key);
    return [...keys];
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
    else {
      stampPlacementMarkers(root, spec.id, spec.label, spec.catalogId);
      mergeAuthoredLayoutObject(root);
    }
    // What RVSource's self-template detection compares against — the name
    // BEFORE any unique-name suffix the host adds.
    root.userData._originalName ??= root.name;

    const registry = this.bakeRegistry;
    const instance = registry.instantiate(baked, root);
    bumpModelEditEpoch('placement-instance');
    // F7: the trust the chain above withholds is a property of the instance (absent = no chain).
    instance.chainState = spec.chainState;
    root.traverse(markLayoutObject);
    applyShadowFlags(root);
    if (spec.pivot !== false) pivotWithDriveHomeStamps(root as Group);
    this._applyOverrides(instance, spec);
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
    const released = new Set(registry.instanceRootsUnder(root));
    for (const r of released) this._ownedRoots.delete(r);
    // A released placement takes what it routed and what was routed into it along
    // (a removal is no orphan); a re-materialisation routes again.
    for (const [occ, inst] of this._instanceByOcc) {
      if (!released.has(inst.root)) continue;
      this._instanceByOcc.delete(occ);
      this._dropRoutedFrom(occ);
      this._routed.delete(occ);
    }
    for (const [id, live] of this._liveQualified) if (released.has(live.instance.root)) this._liveQualified.delete(id);
    if (this._liveQualified.size === 0) this._stopLiveWatch();
    const removed = registry.releaseSubtree(root) > 0;
    if (removed) bumpModelEditEpoch('placement-removal');
    return removed;
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
      // plan-780 R1/R2: the entry's own scope decides; a pending strict ref resolves in `_materializeOne`.
      const scope = e.scope ?? null;
      if (isStrictDocumentRef(e.ref, scope)) {
        const r = resolveDocumentRef(e.ref, scope);
        const effective = 'hit' in r ? effectiveRefOf(r.hit) : null;
        if (effective) e.ref = effective;
      }
      // plan-612 #149: still a placement root for the signal scope while its
      // asset bakes (`rv-instance-scope` reads it; the stamp removes it).
      e.node.userData[PLACEMENT_PENDING_KEY] = true;
      const key = isStrictDocumentRef(e.ref, scope) ? strictKeyOf(e.ref, scope) : (e.ref.catalogId || e.ref.glbUrl || e.id);
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
    this._settleRouted();
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
    // plan-774 F6: the load after a kept release settled (or was overtaken) —
    // whatever it did not claim is retired now, before anyone is told.
    this._endKeptWindow();
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
    const overrides = getAssetOverrides(entry.node) ?? hooks?.overridesOf?.(entry) ?? null;
    const missing = hooks?.missing ?? this._deps.missingDefault;

    const scope = entry.scope ?? null;
    let baked: BakedAsset;
    try {
      // plan-780 R1: wait for the deciding library (pending is never a verdict).
      if (isStrictDocumentRef(entry.ref, scope) && !isQualifiedRef(entry.ref)) {
        const r = await resolveDocumentRefSettled(entry.ref, scope);
        if (generation !== this._generation) return;
        const effective = 'hit' in r ? effectiveRefOf(r.hit) : null;
        if (!effective) throw new Error(unresolvedReason(entry.ref, r));
        entry.ref = effective;
      }
      const isProject = isProjectDocumentId(entry.ref.catalogId);
      // plan-778 F4: a strict reference never takes the host's url fallback.
      const url = !isProject && !isStrictDocumentRef(entry.ref, scope) && hooks?.resolveUrl ? await hooks.resolveUrl(entry) : undefined;
      if (generation !== this._generation) return;
      baked = await this.resolveBaked(url ? { ...entry.ref, url } : entry.ref, { overrides, scope });
    } catch (err) {
      if (generation !== this._generation) return;
      this._flushRouted(entry.occurrence, 'placement-missing');
      missing?.(entry, err);
      this._recordUnresolved(entry, hooks);
      return;
    }
    // The load moved on while the asset baked (clearModel / a newer document):
    // the root is no longer part of the live model — nothing to attach to.
    if (generation !== this._generation || baked.disposed) return;
    const isLive = hooks?.isLive ?? this._deps.isLive;
    if (isLive && !isLive(entry.node)) return;
    if (!this._chargeParametricVertices(entry, baked)) return;

    // plan-652 Phase 3 (§2.4.3 #2): the build below is synchronous — activate the
    // features this placement's components need first. The asset's types are cached
    // per baked asset (a cache hit asks again, a no-op once active); override types
    // are added per placement (SOL #2). A failed activation is reported by the
    // loader and does not lose the placement.
    if (this._deps.ensureComponentTypes) {
      const types = new Set(componentTypesOf(baked));
      // plan-769: overrides are `byAddress` (+ the read-only `legacyByPath` bridge).
      addPatchTypes(types, overrides?.byAddress);
      addPatchTypes(types, overrides?.legacyByPath);
      try {
        await this._deps.ensureComponentTypes(types);
      } catch (err) {
        console.warn(`[PlacementInstancer] feature activation for "${entry.label}" failed: ${err}`);
      }
      if (generation !== this._generation || baked.disposed) return;
      if (isLive && !isLive(entry.node)) return;
    }

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
      paramDepth: entry.paramDepth, paramRoot: entry.paramRoot,
      // plan-780 2.1: nested refs resolve in the source the content came from.
      scope: scopeOfQualifiedRef(entry.ref) ?? contentScopeOf(baked.assetId, scope),
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
    if (isQualifiedRef(entry.ref)) this._trackLiveQualified(entry, hooks, instance);
  }

  /**
   * plan-769 Phase 4b — the overrides of a fresh instance: its OWN record and every
   * override an outer placement routed into its occurrence, as layers of ONE
   * `applyOverrideLayers` call (outer wins). What aims further down is routed on.
   */
  private _applyOverrides(instance: PlacementInstance, spec: MaterializeSpec): void {
    const occ = spec.occurrence ?? spec.id;
    const depth = spec.depth ?? 0;
    const routed = this._routed.get(occ) ?? [];
    const layers: InstanceOverrideLayer[] = [];
    if (spec.overrides) layers.push({ overrides: spec.overrides, depth, own: true });
    for (const r of routed) layers.push({ overrides: r.overrides, depth: r.depth, source: r.source });
    // This placement re-derives everything it routes (a re-materialisation replaces).
    this._dropRoutedFrom(occ);
    this._instanceByOcc.set(occ, instance);
    if (layers.length === 0) return;
    const results = this.bakeRegistry.applyOverrideLayers(instance, layers);
    const offset = spec.overrides ? 1 : 0;
    const root = instance.root;
    const ownSource = (n: NestedOverride): RoutedOverride['source'] => ({
      nodePath: NodeRegistry.computeNodePath(root) || root.name,
      label: root.name,
      assetId: instance.baked.assetId,
      occurrence: occ,
      key: n.key,
      addressing: n.addressing,
    });
    results.forEach((res, i) => {
      const from = i < offset ? null : routed[i - offset]!;
      for (const n of res.nested) {
        this._deliver(occurrenceBelow(occ, n.segments), {
          sourceOcc: from ? from.sourceOcc : occ,
          depth: from ? from.depth : depth,
          overrides: remainderOverrides(n),
          source: from ? from.source : ownSource(n),
        });
      }
    });
  }

  /** Route one override to `target`; applied at once when that occurrence is live. */
  private _deliver(target: string, entry: RoutedOverride): void {
    const list = this._routed.get(target) ?? [];
    const at = list.findIndex((e) => e.sourceOcc === entry.sourceOcc && e.source.key === entry.source.key);
    if (at >= 0) list[at] = entry; else list.push(entry);
    this._routed.set(target, list);
    const inst = this._instanceByOcc.get(target);
    if (!inst || inst.released) return;
    const [res] = this.bakeRegistry.applyOverrideLayers(inst, [{ overrides: entry.overrides, depth: entry.depth, source: entry.source }]);
    for (const n of res?.nested ?? []) {
      this._deliver(occurrenceBelow(target, n.segments), { ...entry, overrides: remainderOverrides(n) });
    }
  }

  /** Forget what the placement at `sourceOcc` routed (it is about to route again). */
  private _dropRoutedFrom(sourceOcc: string): void {
    for (const [target, list] of this._routed) {
      const keep = list.filter((e) => e.sourceOcc !== sourceOcc);
      if (keep.length === list.length) continue;
      if (keep.length > 0) this._routed.set(target, keep); else this._routed.delete(target);
    }
  }

  /**
   * Flush the overrides routed into `occurrence` and everything below it with
   * `reason` — the nested placement failed to load, was capped or refused.
   */
  private _flushRouted(occurrence: string, reason: OrphanReason): void {
    for (const [target, list] of [...this._routed]) {
      if (target !== occurrence && !target.startsWith(occurrence + '/')) continue;
      this._routed.delete(target);
      for (const e of list) this._reportRouted(e, reason);
    }
  }

  /** The orphan verdict (F13): no placement is pending, a routed override without a live target is missing. */
  private _settleRouted(): void {
    for (const [target, list] of [...this._routed]) {
      const inst = this._instanceByOcc.get(target);
      if (inst && !inst.released) continue;
      this._routed.delete(target);
      for (const e of list) this._reportRouted(e, 'missing');
    }
  }

  private _reportRouted(e: RoutedOverride, reason: OrphanReason): void {
    const patch = Object.values(e.overrides.byAddress ?? {})[0] ?? Object.values(e.overrides.legacyByPath ?? {})[0] ?? {};
    reportOverrideOrphaned({
      nodePath: e.source.nodePath, label: e.source.label, assetId: e.source.assetId,
      addressing: e.source.addressing, key: e.source.key, componentTypes: Object.keys(patch), reason,
    });
  }

  /** How many overrides wait for a nested occurrence (diagnostics, tests). */
  get routedOverrideCount(): number {
    let n = 0;
    for (const list of this._routed.values()) n += list.length;
    return n;
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
      paramDepth: spec.paramDepth ?? (parametricRequestsOf(spec.overrides).length > 0 ? 1 : 0),
      paramRoot: spec.paramRoot ?? spec.id,
    };
    // A re-materialised OUTERMOST placement starts its child budget afresh.
    if (spec.nestedOf === undefined) this._paramTree.delete(spec.id);
    // plan-780 2.1: scope of this content; a live drop / copy reads it off the bake key.
    const scope: DocumentScope = spec.scope !== undefined ? spec.scope : contentScopeOf(baked.assetId, null);
    const { entries, refused } = collectNestedReferences(parent, {
      parentKey: baked.assetId,
      parentUrl: baked.url,
      parentState: baked.signatureState,
      keyOf: (ref) => this.keyOf(ref, scope),
      nodes,
      scope,
    });
    // plan-650 Phase 5b: the aggregated child budget of the placement tree.
    const budgeted: DeferredPlacementEntry[] = [];
    for (const e of entries) {
      if (e.paramRoot !== undefined && isParametricReferenceNode(e.node)) {
        const tally = this._paramTreeOf(e.paramRoot);
        if (tally.placements >= this.maxParametricTreePlacements) {
          refused.push({ reason: 'parametric-budget', node: e.node, label: e.label, ref: e.ref,
            assetKey: this.keyOf(e.ref, e.scope ?? null), chain: e.chain ?? [], depth: e.depth ?? 0 });
          continue;
        }
        tally.placements++;
      }
      budgeted.push(e);
    }
    for (const r of refused) {
      const seg = identityIdOf(r.node);
      if (seg) this._flushRouted(childOccurrence(parent.occurrence, seg), 'placement-refused');
      try { this._deps.onNestedRefused?.(r); } catch (err) {
        console.warn(`[PlacementInstancer] onNestedRefused failed: ${err}`);
      }
    }
    const cap = this.maxPlacementsPerLoad;
    const accepted: DeferredPlacementEntry[] = [];
    let capped = 0;
    for (const e of budgeted) {
      if (this._total + accepted.length >= cap) {
        this._flushRouted(e.occurrence, 'placement-cap');
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

  private _paramTreeOf(root: string): { placements: number; vertices: number } {
    let t = this._paramTree.get(root);
    if (!t) { t = { placements: 0, vertices: 0 }; this._paramTree.set(root, t); }
    return t;
  }

  /**
   * plan-650 Phase 5b: charge a nested child family's baked vertices to its
   * placement tree. Over {@link maxParametricTreeVertices} -> refused as
   * `parametric-budget` (the host draws the hole), nothing is materialised.
   */
  private _chargeParametricVertices(entry: DeferredPlacementEntry, baked: BakedAsset): boolean {
    if (entry.nestedOf === undefined || entry.paramRoot === undefined || !isParametricReferenceNode(entry.node)) return true;
    const tally = this._paramTreeOf(entry.paramRoot);
    if (tally.vertices + baked.vertices > this.maxParametricTreeVertices) {
      try {
        this._deps.onNestedRefused?.({ reason: 'parametric-budget', node: entry.node, label: entry.label, ref: entry.ref,
          assetKey: this.keyOf(entry.ref, entry.scope ?? null), chain: entry.chain ?? [], depth: entry.depth ?? 0 });
      } catch (err) {
        console.warn(`[PlacementInstancer] onNestedRefused failed: ${err}`);
      }
      // plan-769 F13: what outer placements routed into this occurrence has no target now.
      this._flushRouted(entry.occurrence, 'placement-refused');
      return false;
    }
    tally.vertices += baked.vertices;
    return true;
  }

  /** The chain a document-level placement starts from: the document's own key (F13). */
  // ── Re-resolve (plan-778 F8) ─────────────────────────────────────────

  /**
   * A deferred placement fell into its placeholder. Remember it — with the
   * library source that answered for it at that moment (null = none) — so a
   * later change of the library registry can bring it back without a reload:
   * Grant, Locate, a retry, a library that simply finished loading late.
   * Only references with an identity are kept (a bare url never changes
   * with the registry).
   */
  private _recordUnresolved(entry: DeferredPlacementEntry, hooks: DeferredPlacementHooks | undefined): void {
    if (!entry.ref.catalogId) return;
    this._unresolved.set(entry.id, { entry, hooks, generation: this._generation, source: this._registrySourceOf(entry) });
    if (!this._unsubSources) {
      this._unsubSources = subscribeLibrarySources(() => this._reresolveUnresolved());
    }
  }

  /**
   * The registry answer for an entry as a key (null = none), never source
   * identity — providers rebuild sources per notify (review C5). Scope-aware
   * (plan-780 R1), so a pending library brings the placement back on settle.
   */
  private _registrySourceOf(entry: DeferredPlacementEntry): string | null {
    const r = resolveDocumentRef(entry.ref, entry.scope ?? null);
    if (!('hit' in r)) return null;
    const { providerId, source } = r.hit.registered;
    return `${providerId}|${source.id}|${source.loaded}|${source.error ?? ''}`;
  }

  /**
   * The registry changed: every remembered placeholder whose reference now has
   * a DIFFERENT answering source than when it failed (a qualified one: its own
   * library turned ready; a legacy one: any source that now owns the id) is
   * queued again. Its placeholder is removed first, the host is told
   * ({@link PlacementInstancerDeps.onReresolve}) and the node re-marked as
   * deferred — then it runs the one materialise order like a reload would.
   * Nothing negative is cached anywhere on that path.
   */
  private _reresolveUnresolved(): void {
    if (this._unresolved.size === 0) return;
    const byHooks = new Map<DeferredPlacementHooks | undefined, DeferredPlacementEntry[]>();
    for (const [id, u] of [...this._unresolved]) {
      if (u.generation !== this._generation) { this._unresolved.delete(id); continue; }
      const now = this._registrySourceOf(u.entry);
      if (!now || now === u.source) continue;
      const node = u.entry.node;
      const isLive = u.hooks?.isLive ?? this._deps.isLive;
      this._unresolved.delete(id);
      if (isLive && !isLive(node)) continue;
      if (this._materializing.has(id)) continue;
      for (const child of [...node.children]) {
        if (!isMissingReferencePlaceholder(child)) continue;
        node.remove(child);
        disposePlaceholder(child);
      }
      try { this._deps.onReresolve?.(u.entry); } catch (err) {
        console.warn(`[PlacementInstancer] onReresolve of "${u.entry.label}" failed: ${err}`);
      }
      markDeferredPlacement(node, u.entry.occurrence);
      // It was counted once already; `materializeDeferred` counts it again.
      this._total = Math.max(0, this._total - 1);
      const list = byHooks.get(u.hooks);
      if (list) list.push(u.entry); else byHooks.set(u.hooks, [u.entry]);
    }
    for (const [hooks, entries] of byHooks) this.materializeDeferred(entries, hooks);
    if (this._unresolved.size === 0) this._clearUnresolved();
  }

  private _clearUnresolved(): void {
    this._unresolved.clear();
    this._unsubSources?.();
    this._unsubSources = null;
  }

  /** Placeholders waiting for a library source (diagnostics, tests). */
  get unresolvedCount(): number { return this._unresolved.size; }

  // ── Source lost (plan-778 Decision D, the reverse of the re-resolve) ──

  /**
   * plan-778 Decision D for a placement that did NOT come through
   * {@link materializeDeferred} — a live drop, a copy, a snap place, an undo
   * restore, MCP `layout.place`: the host hands in its standing qualified
   * placement (`entry.node` = the placement root, `entry.ref` with the stored
   * qualifier) together with the hooks a reloaded one of it would get, and from
   * then on it is treated exactly like a reloaded one: source gone →
   * `lost` + placeholder (`missing`) + remembered as unresolved; source back →
   * re-resolved in place through `register`.
   *
   * Idempotent per (id, instance), a no-op for a legacy reference, a root
   * without an instance or one still materialising. A placement whose source
   * is ALREADY gone when it is handed in is unseated right away — the host may
   * call this from its own registry listener, in either order with the
   * instancer's.
   */
  watchQualified(entry: DeferredPlacementEntry, hooks?: DeferredPlacementHooks): void {
    if (!isQualifiedRef(entry.ref) || this._materializing.has(entry.id)) return;
    const instance = this.instanceOf(entry.node);
    if (!instance) return;
    if (this._liveQualified.get(entry.id)?.instance === instance) return;
    this._trackLiveQualified(entry, hooks, instance, false);
    this._unseatLostQualified();
  }

  /** True while the qualified placement `id` is watched for its source going away (diagnostics, tests). */
  isWatchingQualified(id: string): boolean {
    return this._liveQualified.has(id);
  }

  private _trackLiveQualified(
    entry: DeferredPlacementEntry,
    hooks: DeferredPlacementHooks | undefined,
    instance: PlacementInstance,
    counted = true,
  ): void {
    this._liveQualified.set(entry.id, { entry, hooks, generation: this._generation, instance, counted });
    this._unsubLive ??= subscribeLibrarySources(() => this._unseatLostQualified());
  }

  private _stopLiveWatch(): void {
    this._unsubLive?.();
    this._unsubLive = null;
  }

  /**
   * The registry changed: every live qualified placement whose OWN source no
   * longer answers for it (unregistered, locked, unknown, error — or the
   * document is gone from a ready source) falls back into its placeholder: the
   * host undoes its registration, the instance is released, the reference node
   * stays and gets the same "Missing: <doc> from library <label>" placeholder
   * a reload would draw, and the placement is remembered as unresolved so the
   * source coming back (re-attach, Grant) restores it. A source that is merely
   * PENDING (a project switch re-reading it) is not lost — the instance stands.
   */
  private _unseatLostQualified(): void {
    if (this._liveQualified.size === 0) return;
    for (const [id, live] of [...this._liveQualified]) {
      if (live.generation !== this._generation) { this._liveQualified.delete(id); continue; }
      const ref = live.entry.ref;
      const qualifier = { assetId: ref.catalogId, providerId: ref.providerId, sourceId: ref.sourceId };
      if (findQualifiedOrigin(qualifier)) continue;
      if (qualifiedSourceState(qualifier) === 'pending') continue;
      this._liveQualified.delete(id);
      const node = live.entry.node;
      const isLive = live.hooks?.isLive ?? this._deps.isLive;
      if (isLive && !isLive(node)) continue;
      if (this._materializing.has(id)) continue;
      const lost = live.hooks?.lost ?? this._deps.lostDefault;
      try { lost?.(live.entry, live.instance); } catch (err) {
        console.warn(`[PlacementInstancer] lost() of "${live.entry.label}" failed: ${err}`);
      }
      // The host's teardown may already have released the instance; the call is a no-op then.
      this.release(node);
      for (const child of [...node.children]) {
        if (isMissingReferencePlaceholder(child)) continue;
        node.remove(child);
      }
      // A reloaded placement leaves the materialised count; a live one was never in
      // the load's counters and joins them as missing (the re-resolve counts it as
      // a deferred placement from here on).
      if (live.counted) this._materialized = Math.max(0, this._materialized - 1);
      else this._total++;
      const missing = live.hooks?.missing ?? this._deps.missingDefault;
      const reason = new Error(`library "${ref.sourceId}" is no longer available`);
      try { missing?.(live.entry, reason); } catch (err) {
        console.warn(`[PlacementInstancer] missing() of "${live.entry.label}" failed: ${err}`);
      }
      this._recordUnresolved(live.entry, live.hooks);
    }
    if (this._liveQualified.size === 0) this._stopLiveWatch();
  }

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
  clearDocument(opts?: {
    /**
     * plan-774 F6: keep the document's BAKED assets for the next load
     * (`ModelCache.releaseDocument({ keepBaked: true })`) — instances are
     * released as always, decoded masters and in-flight work are dropped as
     * always. The next load that settles retires what it did not claim
     * (`ModelCache.retireKept`). Default false = every bake retired (today).
     */
    keepBaked?: boolean;
    /**
     * plan-774 F6, descend: the next load is a CHILD of a document that comes
     * back (Back) — its settle must not close the kept window, or the parent's
     * other assets would be gone when Back reloads it. The window then stays
     * open until a load cleared WITHOUT `holdKept` settles, or a clear without
     * `keepBaked` retires everything. Ignored without `keepBaked`.
     */
    holdKept?: boolean;
    /**
     * The roots of the document being dropped (the viewer's model roots).
     * Every bake instance under them is released HERE, whoever registered it —
     * this instancer (`_ownedRoots`), a host hook (`DeferredPlacementHooks.register`,
     * the layout planner's records) or a live drop. Keep = ASSETS, never
     * instances: an instance left registered would hang in a detached tree
     * until its host happened to release it, and would make a kept asset look
     * claimed to the next load's `retireKept`.
     */
    documentRoots?: Iterable<Object3D>;
  }): void {
    this._generation++;
    // A load that still owed its settle notification — sealed and pending, or
    // overtaken before the viewer could seal it — ends HERE, as aborted. A
    // settled load owes nothing: one notification per load, never two.
    const owed = this._loadOpen || this._materializing.size > 0;
    this._materializing.clear();
    this._queue = Promise.resolve();
    this._loadOpen = false;
    if (owed) this._emitSettled(true);
    // A kept window whose load never sealed (overtaken inside `loadModel`) ends
    // here as well — BEFORE the release below, so what that load claimed counts
    // as claimed and is kept again by this clear (aborted loads included).
    this._endKeptWindow();
    this._total = 0;
    this._materialized = 0;
    this._capRefused = 0;
    this._capNodes.length = 0;
    this._paramTree.clear();
    this._documentKey = null;
    // 'unloaded': the document is gone, its overrides with it — nothing to report.
    this._routed.clear();
    this._instanceByOcc.clear();
    this._clearUnresolved();
    this._liveQualified.clear();
    this._stopLiveWatch();
    this._notifyIdle();
    const registry = this.bakeRegistry;
    // Nested instances go with their owner (F4); a nested root owned here as
    // well is released by the first pass and a no-op for the second.
    for (const root of this._ownedRoots) registry.releaseSubtree(root);
    this._ownedRoots.clear();
    // …and every other instance of the dropped document (host-registered
    // placements included) — BEFORE the release below decides which assets are
    // kept, and before the viewer's subtree dispose walks those roots.
    if (opts?.documentRoots) for (const root of opts.documentRoots) registry.releaseSubtree(root);
    const keepBaked = opts?.keepBaked === true;
    this._cache?.releaseDocument({ keepBaked });
    this._keptWindow = keepBaked && this._cache !== null ? (opts?.holdKept === true ? 'held' : 'open') : 'none';
  }

  /**
   * Close the kept window (plan-774 F6) at the settle of the load that followed
   * a `clearDocument({ keepBaked: true })` — settled or aborted — unless that
   * clear held it (descend). Retires the kept assets this load did not claim.
   */
  /**
   * plan-774 review fix E7: end an OPEN kept window now — for a load that
   * failed (it never seals, so `_emitSettled` would never close it). Retires
   * the kept assets nothing claimed. A held window (descend) and no window are
   * left alone.
   */
  endKeptWindow(): void {
    this._endKeptWindow();
  }

  private _endKeptWindow(): void {
    if (this._keptWindow !== 'open') return;
    this._keptWindow = 'none';
    this._cache?.retireKept();
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

/** Free the GPU side of a removed missing-reference placeholder (LineSegments). */
function disposePlaceholder(node: Object3D): void {
  node.traverse((o) => {
    const mesh = o as Object3D & { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } | Array<{ dispose?: () => void }> };
    mesh.geometry?.dispose?.();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats) m.dispose?.();
  });
}

function boundsVolume(node: Object3D): number {
  const b = getAssetReference(node)?.bounds;
  if (!b) return Number.POSITIVE_INFINITY;
  return (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
}

/** Component types of a baked asset's template, cached per asset (plan-652 Phase 3). */
const assetTypes = new WeakMap<BakedAsset, readonly string[]>();
function componentTypesOf(baked: BakedAsset): readonly string[] {
  let types = assetTypes.get(baked);
  if (!types) {
    const set = collectComponentTypes(baked.template);
    // Logic-node templates may live outside the template graph (in-place bake).
    for (const logic of baked.logicNodes) for (const t of collectComponentTypes(logic.template)) set.add(t);
    types = [...set];
    assetTypes.set(baked, types);
  }
  return types;
}
