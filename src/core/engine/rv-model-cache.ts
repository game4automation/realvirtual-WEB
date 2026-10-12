// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-cache.ts — decode + bake cache of placeable GLB assets.
 *
 * Moved out of the layout planner (2026-09-17, plan-753 structure hardening):
 * the cache belongs to the VIEWER's placement instancer
 * (`rv-placement-instancer.ts`), so a viewer without the planner plugin loads
 * a layout document as shared instances too. It imports nothing from
 * `plugins/` — the planner keeps a re-export at its old path
 * (`plugins/layout-planner/model-cache.ts`) next to its own floor/drop helpers.
 *
 * - ModelCache: loads + caches GLB masters, returns clones (`getOrLoad`) or
 *   the shared `BakedAsset` (`getOrLoadBaked`) — one bake per asset, document.
 *   Since plan-754 Phase 1b the bake is DESTRUCTIVE: it consumes the decoded
 *   master and keeps only the pruned template, so `getOrLoad` then serves a
 *   clone of that template (geometry-complete: chunk + keep meshes) and
 *   `decodeFresh` is the one door to the full source hierarchy.
 * - ensureNeutralPlacementRoot: identity wrapper for masters with a root TRS.
 *
 * ## Who gets what after a destructive bake (plan-754 §2.6)
 *
 * Every consumer of a cached asset falls in one of three classes, and the
 * classification is the whole content of Phase 1b:
 *
 *  - (b) GEOMETRY ONLY — the drag ghost (`GhostManager` → `loadEntryModel`) and
 *    the thumbnail render (`generateThumbnail`), both through
 *    `PlacementInstancer.loadModel`. They draw the asset and throw it away, so
 *    the pruned template is not a downgrade: it carries every triangle, in one
 *    mesh per boundary × material instead of N source meshes.
 *  - (c) FULL SOURCE TREE — {@link ModelCache.decodeFresh}
 *    (`PlacementInstancer.decodeFreshModel`). The asset editor and `descend`
 *    are (c) by decision D9, and they satisfy it WITHOUT this cache: both open
 *    the child's own bytes as an authoring load (`preserveHierarchy`, which
 *    refuses the bake outright), so they never see a template in the first
 *    place. `decodeFresh` is the door for anyone who needs the tree from HERE —
 *    today the forced-split re-bake in {@link ModelCache._bake}.
 *  - (n/a) `rv-glb-compose.ts` also calls a `getOrLoad`, but on its own
 *    `GlbTemplateCache` (a parse-template cache with a factory argument), not
 *    on this class. Unaffected.
 *
 * Decoder workers are POOLED, not per load: the DRACO decoder hangs off the one
 * `gltfLoader` singleton of `rv-glb-parse.ts` (`DRACOLoader` keeps its own
 * worker pool up to `workerLimit`), and this cache is constructed with exactly
 * that loader. Nothing here starts a worker per decode.
 */

import { Group } from 'three';
import type { Mesh, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { disposeSubtree } from './rv-traverse-utils';
import type { RVUberMaterial } from './rv-uber-material';
import { BakeAbortedError } from './rv-bake-pipeline';
import { prepareAndBake } from './rv-prepare-and-bake';
import type { BakedAsset } from './rv-bake-chunk';
import type { PickBuildPort } from './rv-pick-build-port';
import { applyKinematicsSpec } from '../behavior-runtime';
import { applyNamingScan } from './rv-naming-scan';
import { RVAssetBlobCache, rejectUnlessGlb } from './rv-asset-blob-cache';
import { unwrapGltfRoot } from './rv-gltf-unwrap';
import { getNodeId } from './rv-node-id';
import { detectRenamedNodes, type GltfParserLike } from './rv-glb-parse';
import { verifyRvSigBuffer, type SignatureState } from '../persistence/rv-sig-verify';
import { fetchServedBytes, isEncryptedDeploy } from '../persistence/rv-served-bytes';
import { tryFetchSidecarSpec } from './rv-scene-loader';
import { binaryResources, parseGlbCollectingResources } from './rv-binary-resources';
import {
  RESOLVED_KEY_PREFIX as REGISTRY_RESOLVED_KEY_PREFIX,
  hashForUrl,
  resolvedAssetKey,
  subscribeAssetHashes,
} from '../library/rv-asset-hash-registry';

/** Binary-resource document id of a decoded placement master (plan-498). */
export function modelCacheDocumentId(cacheKey: string): string {
  return `model-cache:${cacheKey}`;
}

/**
 * Placement roots must be transform-neutral: the planner stamps the placement
 * position/rotation/scale directly onto the placed root (materialize/restore
 * paths), which would destroy any intrinsic root transform the asset carries —
 * e.g. the 0.001 mm→m scale a CAD import bakes onto its content root
 * ("way too large" bug for editor-saved CAD assets). Wrap such roots in an
 * identity Group so the intrinsic transform survives inside.
 */
export function ensureNeutralPlacementRoot(source: Group): Group {
  const { position: t, quaternion: q, scale: s } = source;
  const identity =
    t.x === 0 && t.y === 0 && t.z === 0 &&
    q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1 &&
    s.x === 1 && s.y === 1 && s.z === 1;
  if (identity) return source;
  const wrapper = new Group();
  wrapper.name = source.name || 'Asset';
  wrapper.add(source);
  return wrapper;
}

// ─── Model Cache ────────────────────────────────────────────────────────

/**
 * Cache API bucket for all placeable GLBs (catalog, GitHub, AM). `-v2` since
 * plan-508: the keys became url + catalog hash, and the old url-keyed bucket
 * `rv-planner-glbs` is deleted on first open instead of migrated — its entries
 * are bytes the network hands out again at any time.
 */
export const GLB_CACHE_BUCKET = 'rv-assets-glb-v2';
/** Earlier names of {@link GLB_CACHE_BUCKET}, swept once per session. */
export const LEGACY_GLB_CACHE_BUCKETS: readonly string[] = ['rv-planner-glbs'];

/** Shared blob cache singleton — also exposed for tooling that needs to wipe it. */
const _glbBlobCache = new RVAssetBlobCache({
  bucket: GLB_CACHE_BUCKET,
  legacyBuckets: LEGACY_GLB_CACHE_BUCKETS,
  reject: rejectUnlessGlb,
});

/** The rejection an aborted `getOrLoad` consumer receives. */
export class AbortError extends Error {
  readonly name = 'AbortError';
  constructor(message = 'Aborted') { super(message); }
}

/** Reject immediately when the caller is already gone. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Resolve with `work`, or reject as soon as `signal` aborts — WITHOUT
 * cancelling `work` itself. The shared load keeps running for every other
 * consumer (plan-371 H5/R12); this consumer simply stops listening.
 */
function detachOnAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  // The abandoned promise must still have a handler, or an eventual rejection
  // would surface as an unhandled rejection.
  work.catch(() => { /* owned by whoever still awaits it */ });
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError());
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/**
 * How a decode gets at the bytes it needs (plan-723 §2.3).
 *
 * The cache KEY and the URL the loader reads are two different things. For a
 * plain catalog GLB they happen to be the same string; for a library-registry
 * asset they cannot be, because `LibrarySource.resolveAsset()` mints a FRESH
 * `blob:` URL on every call. Keying the caches on that URL would mean never
 * hitting the cache again (a silent performance defect, not a crash), and the
 * URL carries a `revokeUrl` that somebody has to call.
 *
 * So the state machine keys on an explicit `cacheKey` and asks this callback
 * for the transport when — and only when — it actually has to decode. A cache
 * or in-flight hit never calls it, which is the whole point: a second placement
 * of the same project document must not re-read the backend.
 *
 * `release` is invoked in the success, error AND abort paths — see
 * {@link ModelCache._decode}.
 *
 * The return type is deliberately `T | Promise<T>` and not just `Promise<T>`:
 * the URL path has nothing to await, and awaiting it anyway would push
 * `loadAsync` out of the caller's own tick — which the in-flight dedup tests
 * (plan-371 T17) observe directly, and which nothing about this feature should
 * change.
 */
export interface AcquiredAsset {
  url: string;
  release?: () => void;
  /** Expected SHA-256 of the bytes behind `url`, when the resolver knows it (plan-508 F4). */
  sha256?: string;
}
export type AcquireFn = () => AcquiredAsset | Promise<AcquiredAsset>;

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === 'function';
}

/** Namespace prefix of a registry-resolved cache key — see {@link resolvedCacheKey}. */
export const RESOLVED_KEY_PREFIX = REGISTRY_RESOLVED_KEY_PREFIX;

/**
 * The stable cache key of a library-registry asset (plan-723 §2.3).
 *
 * Namespaced so it can never collide with the URL-keyed half of the same maps:
 * a catalog entry is keyed by its `glbUrl`, and no URL starts with `resolved:`.
 */
export function resolvedCacheKey(providerId: string, sourceId: string, entryId: string): string {
  // ONE spelling with the url -> hash registry (plan-508): a project document's
  // hash is registered under exactly this key.
  return resolvedAssetKey(providerId, sourceId, entryId);
}

/** Cache key of a forced-split bake (plan-753 I7): `<cacheKey>#split:<id>,<id>`. */
function bakedKeyWithSplit(cacheKey: string, sortedIds: readonly string[]): string {
  return cacheKey + '#split:' + sortedIds.join(',');
}

/** The URL path's acquire: the key IS the transport, and there is nothing to
 *  release — so it answers synchronously and the decode stays in one tick. */
function acquireUrl(url: string): AcquireFn {
  return () => ({ url });
}

/** What a registry resolve hands back — `sha256` when the source knows the content hash (plan-508). */
type ResolveFn = () => Promise<{ url: string; revokeUrl?(): void; sha256?: string }>;

/** The registry path's acquire: forward `revokeUrl` as the release obligation. */
function acquireResolved(resolve: ResolveFn): AcquireFn {
  return async () => {
    const resolved = await resolve();
    return {
      url: resolved.url,
      // Bound here, not passed as a bare method reference: `revokeUrl` closes
      // over the provider's own handle and must keep its receiver.
      release: resolved.revokeUrl ? () => resolved.revokeUrl!() : undefined,
      ...(typeof resolved.sha256 === 'string' ? { sha256: resolved.sha256 } : {}),
    };
  };
}

/**
 * How the {@link ModelCache} reaches the session's uber material and renderer
 * kind (plan-752 Phase 2).
 *
 * Injected rather than imported: the cache is an engine module and must not
 * know `RVViewer`. The placement instancer passes `() => viewer.placementUberMaterial`, which
 * is null exactly when the loader itself skipped the uber bake (an authoring
 * load: editor / STEP inspection) — so the master skips it too (S4).
 */
export interface ModelCacheUberOptions {
  /** The session's shared uber material, or null to skip the master bake. */
  uber?: () => RVUberMaterial | null;
  /** Renderer kind, only consulted when {@link uber} returns null-ish and the
   *  bake has to mint its own (tests, embedders). */
  isWebGPU?: () => boolean;
  /** Pick-structure build port for the chunk bake (plan-756). Test seam —
   *  `createPickBuildPort({ createWorker: () => null })`; default: the ONE shared
   *  worker pool, so a suite stays worker-free. */
  pickPort?: () => PickBuildPort | undefined;
  /** Runs ONCE on the master before `bake()` — default: the naming-convention
   *  scan ({@link applyNamingScanToMaster}). Idempotent by contract. */
  prepareMaster?: (master: Group) => void;
  /**
   * plan-757 Phase 2b (F10): apply the asset's OWN `<glb>.kin.json` sidecar to
   * the decoded master — the rule `loadGLB` applies per composed frame
   * (`applyFrameSidecars`): an UNSIGNED file gets its adjacent sidecar, a
   * signed file declares itself self-contained and gets none. Default true;
   * `false` = self-contained load (the loader's `loadKinematicsSidecar: false`).
   */
  loadKinematicsSidecar?: () => boolean;
}

/**
 * Naming-convention scan on the MASTER (plan-753 §5.3): `Drive-*` /
 * `Transport-*` / `Sensor*` names become rv extras BEFORE the bake decides
 * its mover cut — otherwise a `Transport-Z` would be merged into the static
 * chunk and only get its Drive at placement time. The same scan runs again on
 * every clone in `registerPlaced` (scene-mutations.ts); `applyKinematicsSpec`
 * deep-merges without overwrite, so the second pass is a no-op.
 */
export function applyNamingScanToMaster(master: Group): void {
  applyNamingScan(master);
}

/** True when `root` carries at least one mesh with triangles to bake. */
function hasDrawableMesh(root: Group): boolean {
  let found = false;
  root.traverse((node) => {
    if (found) return;
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry;
    const count = g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0);
    if (count >= 3) found = true;
  });
  return found;
}

/** Bake statistics for DevTools / `web_status` (plan-753 §2.7). */
export interface BakeStats {
  assets: number;
  chunks: number;
  vertices: number;
  triangles: number;
  instances: number;
  inflight: number;
}

/**
 * What a decode learned about its bytes and hands to the bake (plan-757):
 * the signature verdict — `BakedAsset.signatureState`, the placed asset's OWN
 * trust (D8) — and the parser's renamed-node map, from which the recipe
 * derives the asset's alias table (D4). Keyed by the decoded root in a
 * `WeakMap`; it dies with the master the destructive bake consumes.
 */
interface DecodeMeta {
  signatureState: SignatureState;
  renamedNodes: Map<Object3D, string>;
  /** The url the bytes were read from — `BakedAsset.url` (plan-757 Phase 2, F3). */
  url: string;
}

/** The slice of a GLTF loader `_decode` uses. The real `GLTFLoader` has both;
 *  a test fake may implement only `loadAsync` (the URL seam, see `_decode`). */
interface DecodeLoader {
  parseAsync?(data: ArrayBuffer, path: string): Promise<{ scene: Group; parser?: GltfParserLike }>;
  loadAsync?(url: string): Promise<{ scene: Group; parser?: GltfParserLike }>;
}

/**
 * Decode timings — one record per `_decode` run, phase by phase. The
 * counterpart of `getPlacementTimings()` for the half of a placement that
 * happens BEFORE the scene is touched: resolving the bytes, verifying the
 * signature, parsing the GLB and unwrapping the master. Always on, capped,
 * read via `web_layout_timings`.
 */
export interface DecodeTiming {
  cacheKey: string;
  phases: Array<{ phase: string; ms: number }>;
  totalMs: number;
  meshes?: number;
  triangles?: number;
}
const DECODE_TIMING_CAP = 64;
const _decodeTimings: DecodeTiming[] = [];
export function getDecodeTimings(): readonly DecodeTiming[] { return _decodeTimings; }
export function clearDecodeTimings(): void { _decodeTimings.length = 0; }

export class ModelCache {
  /** Decoded Three.js Group cache — clones are returned to callers. */
  private _decoded = new Map<string, Group>();
  /**
   * In-flight DECODES, keyed by CACHE KEY (plan-371 §2.10, plan-723 §2.3).
   *
   * `_decoded` only ever holds finished results, so without this map two
   * overlapping `getOrLoad` calls for the same key decode the same GLB twice —
   * exactly the situation the hover prefetch creates (prefetch still running,
   * drag starts). Three rules keep the map from introducing bugs of its own;
   * they are spelled out at their enforcement sites in {@link _shared} and
   * {@link invalidate}.
   */
  private _inflight = new Map<string, Promise<Group>>();
  /**
   * Invalidation counter per cache key. A decode records the epoch it started under
   * and refuses to publish into `_decoded` if `invalidate()` has bumped it
   * meanwhile — dropping the promise from `_inflight` alone is NOT enough,
   * because the abandoned decode still runs to completion and would otherwise
   * re-install the very tree the invalidate was meant to evict.
   */
  private _epoch = new Map<string, number>();
  /**
   * Baked chunk assets by cache key (plan-753 Phase 2). Populated only through
   * {@link getOrLoadBaked}; `getOrLoadResolved` / `getOrLoad` stay the clone
   * path (the planner's production path until Phase 3).
   */
  private _baked = new Map<string, BakedAsset>();
  /** In-flight BAKES by cache key — one bake per key, later askers join. */
  private _bakedInflight = new Map<string, Promise<BakedAsset>>();
  /** What each decoded root's bytes said — see {@link DecodeMeta}. */
  private readonly _decodeMeta = new WeakMap<Group, DecodeMeta>();
  /**
   * The catalog hash each cache key was LAST REQUESTED under (plan-508 F4).
   *
   * Set synchronously at every entry, BEFORE the first `await`, and compared
   * before anything is served from `_decoded`, `_inflight`, `_baked` or
   * `_bakedInflight`: a different hash — including `undefined -> H`, an
   * unhashed prefetch followed by a hashed load — invalidates the key (epoch
   * bump, like an editor save) and loads fresh. `H -> undefined` (a catalog
   * without hashes after one with) invalidates nothing. The url-based keys
   * themselves are unchanged; old placement records need no new field.
   */
  private readonly _expectedHash = new Map<string, string>();
  private _unsubscribeHashes: (() => void) | null = null;
  private _loader: GLTFLoader;
  private _uberOptions: ModelCacheUberOptions;

  constructor(loader: GLTFLoader, uberOptions?: ModelCacheUberOptions) {
    this._loader = loader;
    this._uberOptions = uberOptions ?? {};
    // A catalog re-normalized mid-session may change a hash under a key this
    // cache already holds. Held weakly: a cache nobody disposes must not be
    // kept alive by the process-wide registry.
    const self = new WeakRef(this);
    const unsubscribe = subscribeAssetHashes(() => {
      const cache = self.deref();
      if (!cache) { unsubscribe(); return; }
      cache._onAssetHashesChanged();
    });
    this._unsubscribeHashes = unsubscribe;
  }

  /** The catalog hash the registry currently holds for `cacheKey` (a url or a `resolved:` key). */
  private _registryHash(cacheKey: string): string | undefined {
    return hashForUrl(cacheKey)?.sha256;
  }

  /** True when any tier of this cache holds something for `cacheKey` (split bakes included). */
  private _isKnown(cacheKey: string): boolean {
    if (this._decoded.has(cacheKey) || this._inflight.has(cacheKey)) return true;
    const splitPrefix = bakedKeyWithSplit(cacheKey, []);
    for (const k of this._baked.keys()) if (k === cacheKey || k.startsWith(splitPrefix)) return true;
    for (const k of this._bakedInflight.keys()) if (k === cacheKey || k.startsWith(splitPrefix)) return true;
    return false;
  }

  /**
   * THE expected-hash gate (plan-508 F4) — synchronous, run at every entry
   * before any cache or in-flight lookup. `hash` undefined = the catalog knows
   * none: nothing changes. A new hash for a key this cache holds invalidates it.
   */
  private _syncExpectedHash(cacheKey: string, hash: string | undefined): void {
    if (!hash) return;
    if (this._expectedHash.get(cacheKey) === hash) return;
    if (this._isKnown(cacheKey)) this.invalidate(cacheKey);
    this._expectedHash.set(cacheKey, hash);
  }

  /** Registry listener: re-run the gate for every key this cache knows. */
  private _onAssetHashesChanged(): void {
    const keys = new Set<string>([
      ...this._expectedHash.keys(), ...this._decoded.keys(), ...this._inflight.keys(),
    ]);
    for (const k of this._baked.keys()) if (!k.includes('#split:')) keys.add(k);
    for (const k of this._bakedInflight.keys()) if (!k.includes('#split:')) keys.add(k);
    for (const key of keys) this._syncExpectedHash(key, this._registryHash(key));
  }

  /** The expected hash recorded for `cacheKey` (diagnostics / tests). */
  expectedHashOf(cacheKey: string): string | undefined {
    return this._expectedHash.get(cacheKey);
  }

  /**
   * Get a clone of the cached model, loading it first if needed.
   *
   * `opts.signal` (plan-371) detaches THIS consumer from the result — it does
   * NOT cancel the underlying work. That is deliberate: the blob layer beneath
   * (`RVAssetBlobCache._pending`) de-duplicates in-flight fetches URL-wide, so
   * a real abort would tear down the download of an unrelated second placement
   * of the same asset. The load runs to completion, lands in the cache, and
   * benefits whoever asks next.
   */
  async getOrLoad(url: string, opts?: { signal?: AbortSignal }): Promise<Group> {
    const signal = opts?.signal;
    throwIfAborted(signal);
    this._syncExpectedHash(url, this._registryHash(url));

    const cached = this._decoded.get(url);
    if (cached) return cached.clone();
    const pruned = this._cloneTemplate(url);
    if (pruned) return pruned;

    const source = await detachOnAbort(this._shared(url, acquireUrl(url)), signal);
    return source.clone();
  }

  /**
   * Get a clone of a model that has no stable URL — a library-registry asset
   * (plan-723 F4).
   *
   * `cacheKey` is the asset's stable identity ({@link resolvedCacheKey}); the
   * volatile `blob:` URL never reaches the caches and never reaches the caller.
   * `resolve` is called ONLY on a genuine miss, and its `revokeUrl` is called
   * for us in the success, error and abort paths.
   *
   * Two failure shapes, deliberately different:
   *  - `resolve()` itself throws → there IS no handle, so nothing is revoked
   *    (`revokeUrl` only exists after a successful return).
   *  - the load fails after a successful resolve → the handle is released in
   *    the `finally` like any other outcome.
   */
  async getOrLoadResolved(
    cacheKey: string,
    resolve: ResolveFn,
    opts?: { signal?: AbortSignal },
  ): Promise<Group> {
    const signal = opts?.signal;
    throwIfAborted(signal);
    this._syncExpectedHash(cacheKey, this._registryHash(cacheKey));

    const cached = this._decoded.get(cacheKey);
    if (cached) return cached.clone();
    const pruned = this._cloneTemplate(cacheKey);
    if (pruned) return pruned;

    const source = await detachOnAbort(this._shared(cacheKey, acquireResolved(resolve)), signal);
    return source.clone();
  }

  /**
   * The BAKED form of an asset (plan-753 F1): chunks + node windows + BVH,
   * shared by every placement of the asset in this document. Bakes once per
   * cache key; concurrent askers join the in-flight bake (`_bakedInflight`),
   * later askers get the cached asset.
   *
   * `resolve` is the registry path's acquire (see {@link getOrLoadResolved});
   * without it `cacheKey` is taken as the GLB url (the {@link getOrLoad}
   * path). A DESTRUCTIVE bake (plan-754, the default) CONSUMES the decoded
   * master: `keep[]` and the logic-node templates point into the pruned
   * `BakedAsset.template` the bake built, `_decoded` no longer holds the source
   * hierarchy, and {@link decodeFresh} is what hands one out again.
   *
   * Rejects with `BakeAbortedError` when the key was invalidated while the
   * bake ran; nothing is published in that case.
   */
  async getOrLoadBaked(
    cacheKey: string,
    resolve?: ResolveFn,
    opts?: { signal?: AbortSignal; forceSplitNodeIds?: readonly string[] },
  ): Promise<BakedAsset> {
    const signal = opts?.signal;
    throwIfAborted(signal);
    this._syncExpectedHash(cacheKey, this._registryHash(cacheKey));
    // A forced chunk split (plan-753 I7: `AssetOverrides.trsByNodeId`) is a
    // DIFFERENT bake of the same master — cached under a derived key, retired
    // together with the base key (see `_retireBaked`).
    const splitIds = opts?.forceSplitNodeIds && opts.forceSplitNodeIds.length > 0
      ? [...new Set(opts.forceSplitNodeIds)].sort()
      : null;
    const bakedKey = splitIds ? bakedKeyWithSplit(cacheKey, splitIds) : cacheKey;
    const cached = this._baked.get(bakedKey);
    if (cached) return cached;
    const acquire = resolve ? acquireResolved(resolve) : acquireUrl(cacheKey);
    return detachOnAbort(this._sharedBake(cacheKey, bakedKey, acquire, splitIds), signal);
  }

  /**
   * A FULL, freshly decoded tree for `cacheKey` — the only door to the source
   * hierarchy once a destructive bake has consumed the decode (plan-754 D9/§2.6).
   *
   * Deliberately NOT cached and NOT de-duplicated: every caller gets a tree of
   * its own, because the two things that need one — the asset editor / descend
   * and a forced-split re-bake — either edit it or consume it. The bytes still
   * come from {@link RVAssetBlobCache}, so the cost is a parse, not a download.
   *
   * `resolve` is the registry path's acquire (see {@link getOrLoadResolved});
   * without it `cacheKey` is taken as the GLB url. A `resolved:` key without a
   * `resolve` has no transport at all and is refused rather than fetched.
   */
  async decodeFresh(
    cacheKey: string,
    resolve?: ResolveFn,
    opts?: { signal?: AbortSignal },
  ): Promise<Group> {
    const signal = opts?.signal;
    throwIfAborted(signal);
    this._syncExpectedHash(cacheKey, this._registryHash(cacheKey));
    if (!resolve && cacheKey.startsWith(RESOLVED_KEY_PREFIX)) {
      throw new Error(`[ModelCache] decodeFresh("${cacheKey}") needs the registry resolve callback — the key is not a URL.`);
    }
    const acquire = resolve ? acquireResolved(resolve) : acquireUrl(cacheKey);
    return detachOnAbort(this._decode(cacheKey, acquire, { cache: false }), signal);
  }

  /**
   * A clone of the pruned TEMPLATE of a destructively baked asset, or null.
   *
   * After a destructive bake the full decode is gone (plan-754 §2.6), so the
   * geometry-only consumers of {@link getOrLoad} — the drag ghost and the
   * thumbnail render — are served from the template: survivors, keep meshes and
   * the chunk meshes, which together carry every triangle the asset draws.
   * Callers that need the source CAD hierarchy use {@link decodeFresh}.
   *
   * Like every `getOrLoad` clone this one SHARES its geometry with what it was
   * cloned from — here the asset's chunk geometry, which the asset disposes at
   * refcount 0 once retired. Both consumers are transient by construction.
   */
  private _cloneTemplate(cacheKey: string): Group | null {
    const baked = this._baked.get(cacheKey);
    if (!baked || !baked.destructive || baked.disposed) return null;
    // The template root is always the `Group` the bake built for the asset root.
    return baked.template.clone() as Group;
  }

  /** Live bake statistics (DevTools "Render" tab, `web_status`). */
  getBakeStats(): BakeStats {
    const stats: BakeStats = { assets: 0, chunks: 0, vertices: 0, triangles: 0, instances: 0, inflight: this._bakedInflight.size };
    for (const [, a] of this._baked) {
      stats.assets++;
      stats.chunks += a.chunks.length;
      stats.vertices += a.vertices;
      stats.triangles += a.triangles;
      stats.instances += a.instances;
    }
    return stats;
  }

  /** The cached baked asset for `cacheKey`, if any (no load). */
  peekBaked(cacheKey: string): BakedAsset | undefined {
    return this._baked.get(cacheKey);
  }

  /**
   * Warm the caches for `url` without producing a clone — fire-and-forget.
   * `opts.bake` additionally bakes the master (plan-753 Phase 2; the planner
   * switches its hover prefetch to it in Phase 3).
   *
   * Called from the library panel's hover intent (plan-371 F8): by the time the
   * user actually starts dragging, fetch and decode are already under way, and
   * the drag's own `getOrLoad` joins the very same promise instead of starting
   * a second one.
   *
   * Never rejects: a prefetch that fails is simply a prefetch that did not
   * help, and the real load re-runs (and re-reports) it moments later.
   */
  prefetch(url: string, opts?: { bake?: boolean }): void {
    if (!url) return;
    this._syncExpectedHash(url, this._registryHash(url));
    if (opts?.bake) {
      if (this._baked.has(url)) return;
      this._sharedBake(url, url, acquireUrl(url), null).catch(() => { /* speculative — the real load reports */ });
      return;
    }
    // A baked asset already IS the warm state of this key — re-decoding the
    // consumed master would only re-create what the bake deliberately dropped.
    if (this._decoded.has(url) || this._baked.has(url)) return;
    this._shared(url, acquireUrl(url)).catch(() => { /* speculative — the real load reports */ });
  }

  /** {@link prefetch} for a registry asset — the mirror of {@link getOrLoadResolved}. */
  prefetchResolved(
    cacheKey: string,
    resolve: ResolveFn,
    opts?: { bake?: boolean },
  ): void {
    if (!cacheKey) return;
    this._syncExpectedHash(cacheKey, this._registryHash(cacheKey));
    if (opts?.bake) {
      if (this._baked.has(cacheKey)) return;
      this._sharedBake(cacheKey, cacheKey, acquireResolved(resolve), null).catch(() => { /* speculative */ });
      return;
    }
    if (this._decoded.has(cacheKey) || this._baked.has(cacheKey)) return;
    this._shared(cacheKey, acquireResolved(resolve))
      .catch(() => { /* speculative — the real load reports */ });
  }

  /**
   * The ONE in-flight bake promise for `cacheKey` — the bake-level twin of
   * {@link _shared}, same three rules (cleanup in every case, no signal here,
   * epoch guard at publish time).
   */
  private _sharedBake(cacheKey: string, bakedKey: string, acquire: AcquireFn, splitIds: readonly string[] | null): Promise<BakedAsset> {
    // Same gate as the public entries — idempotent when they already ran it.
    this._syncExpectedHash(cacheKey, this._registryHash(cacheKey));
    const existing = this._bakedInflight.get(bakedKey);
    if (existing) return existing;
    const job = this._bake(cacheKey, bakedKey, acquire, splitIds);
    this._bakedInflight.set(bakedKey, job);
    const settle = (): void => {
      if (this._bakedInflight.get(bakedKey) === job) this._bakedInflight.delete(bakedKey);
    };
    job.then(settle, settle);
    return job;
  }

  /**
   * Decode (or join the decode of) the master, scan it once, bake it under the
   * decode epoch it started with, publish only at an unchanged epoch.
   * `bakedKey` is `cacheKey` or its forced-split derivative; the epoch is
   * always the BASE key's.
   *
   * plan-754 Phase 1b — a DESTRUCTIVE bake consumes the tree it bakes, so this
   * is also where the full decode of a library asset ends:
   *  - the survival model (D4/D7) decides which nodes the template carries on
   *    top of the ones the bake needs anyway;
   *  - a forced-split bake is a SECOND bake of the same asset and therefore
   *    gets its own {@link decodeFresh} tree (§2.6);
   *  - on success the decode is dropped from `_decoded` — from then on
   *    `getOrLoad` serves the pruned template and `decodeFresh` is the only
   *    door to the source hierarchy.
   */
  private async _bake(cacheKey: string, bakedKey: string, acquire: AcquireFn, splitIds: readonly string[] | null): Promise<BakedAsset> {
    const epoch = this._epoch.get(cacheKey) ?? 0;
    const isEpochCurrent = (): boolean => (this._epoch.get(cacheKey) ?? 0) === epoch;
    // The destructive bake eats its input. A forced split runs while the base
    // bake has (or will have) consumed the shared decode, so it never shares a
    // tree with it — it decodes its own, uncached.
    const master = splitIds
      ? await this._decode(cacheKey, acquire, { cache: false })
      : this._decoded.get(cacheKey) ?? await this._shared(cacheKey, acquire);
    if (!isEpochCurrent()) throw new BakeAbortedError(cacheKey);
    // Same gate the loader uses (`destructivePipeline`, rv-scene-loader.ts): a
    // master that draws nothing bakes to nothing, and pruning a tree whose only
    // content is references would throw the document away for no chunk at all.
    const destructive = hasDrawableMesh(master);
    // The host's own master hook (test / embedder seam) — the recipe's naming
    // scan is idempotent with it (plan-753 §5.3).
    (this._uberOptions.prepareMaster ?? applyNamingScanToMaster)(master);
    const splitSet = splitIds ? new Set(splitIds) : null;
    const forceSplit = splitSet
      ? (node: Object3D): boolean => { const id = getNodeId(node); return !!id && splitSet.has(id); }
      : undefined;
    // plan-757 D1: THE recipe — the same `prepareAndBake` the loader runs for
    // the main model: hooks, survival + removal report, dedup → uber, bake,
    // aliases. Per-source context only; no plugin claims (D5: main model only).
    const meta = this._decodeMeta.get(master);
    const asset = await prepareAndBake(master, {
      assetId: cacheKey,
      // F3: the base of the asset's OWN relative references — the url the
      // bytes came from, which for a `project:` asset is not the cache key.
      url: meta?.url ?? '',
      renamedNodes: meta?.renamedNodes ?? new Map(),
      signatureState: meta?.signatureState ?? 'none',
      uber: this._uberOptions.uber?.() ?? null,
      isWebGPU: this._uberOptions.isWebGPU?.() ?? false,
      pickPort: this._uberOptions.pickPort?.(),
      epoch,
      isEpochCurrent,
      forceSplit,
      destructive,
    });
    // The tree the bake just consumed must not be handed out again. Dropped
    // only on SUCCESS: an aborted bake leaves `tmp` intact, and the next ask
    // must be able to retry from it.
    if (destructive && this._decoded.get(cacheKey) === master) this._decoded.delete(cacheKey);
    if (!isEpochCurrent()) {
      // Invalidated between the bake's last check and this continuation.
      asset.dispose();
      throw new BakeAbortedError(cacheKey);
    }
    // A master without geometry (an empty document, a reference-only layout)
    // bakes to nothing. The asker gets its empty asset, but the cache does not
    // keep it — `bake.assets` counts real assets only.
    if (asset.chunks.length === 0 && asset.keep.length === 0 && asset.triangles === 0) return asset;
    this._baked.set(bakedKey, asset);
    return asset;
  }

  /**
   * Drop a baked asset from the cache (plan-753 F11): live instances keep
   * using it until their last `release()`, which then disposes; with no
   * instances it is disposed right here. Retires the base key AND every
   * forced-split derivative of it.
   */
  private _retireBaked(cacheKey: string): void {
    const splitPrefix = bakedKeyWithSplit(cacheKey, []);
    for (const key of [...this._bakedInflight.keys()]) {
      if (key === cacheKey || key.startsWith(splitPrefix)) this._bakedInflight.delete(key);
    }
    for (const key of [...this._baked.keys()]) {
      if (key !== cacheKey && !key.startsWith(splitPrefix)) continue;
      const asset = this._baked.get(key)!;
      this._baked.delete(key);
      asset.retired = true;
      if (asset.instances === 0) asset.dispose();
    }
  }

  /**
   * The ONE in-flight decode promise for `cacheKey`, created on first ask.
   *
   * RULE 1 — cleanup in every case. Without the settle handler a REJECTED
   * promise would stay in the map forever, and every later caller (including
   * `PendingGeometryRegistry.retry()`) would be handed the same stale failure:
   * a retry that can never succeed, silently. Registering the handler also
   * means the shared promise always has a rejection handler, so a decode whose
   * consumers all detached never surfaces as an unhandled rejection.
   *
   * RULE 2 — no `signal` here on purpose. Aborting is a per-consumer concern
   * and is applied one level up in `getOrLoad` via `detachOnAbort`; cancelling
   * the shared work would tear down an unrelated second placement of the same
   * asset (the same bug class as H5, one layer higher).
   */
  private _shared(cacheKey: string, acquire: AcquireFn): Promise<Group> {
    const existing = this._inflight.get(cacheKey);
    if (existing) return existing;

    const decode = this._decode(cacheKey, acquire);
    this._inflight.set(cacheKey, decode);
    // `then(settle, settle)` rather than `finally`: it consumes the rejection
    // instead of re-raising it on a derived promise nobody awaits.
    const settle = (): void => {
      if (this._inflight.get(cacheKey) === decode) this._inflight.delete(cacheKey);
    };
    decode.then(settle, settle);
    return decode;
  }

  /**
   * Fetch + verify + decode + normalize one GLB into the decoded cache, under
   * `cacheKey` — which for the URL path IS the url, and for the registry path
   * is the asset's stable identity (plan-723 §2.3).
   *
   * plan-757 (R1): bytes → `verifyRvSigBuffer` → `parseAsync` →
   * `detectRenamedNodes` → drop the parser — the same four steps the loader's
   * `loadAndPrepareGLTF` runs, so a placed asset carries its own signature
   * verdict (D8) and its renamed-node aliases (D4). The byte buffer lives until
   * the parse resolved, the parser until the renamed nodes are read; both are
   * released in this function. The `blob:` passthrough (a blob url is read
   * directly, never copied through the Cache API) and RULE 1–3 are unchanged.
   *
   * A loader WITHOUT `parseAsync` (the test fakes built on `loadAsync`) is fed
   * the url instead: no bytes, no signature (`'none'`), renamed nodes from the
   * parser when the fake returns one. The real `GLTFLoader` always takes the
   * byte path.
   */
  private async _decode(cacheKey: string, acquire: AcquireFn, opts?: { cache?: boolean }): Promise<Group> {
    const epoch = this._epoch.get(cacheKey) ?? 0;
    // The hash this decode was asked for — captured before the first await, so
    // a registry change mid-flight cannot re-target bytes already requested.
    const expected = this._expectedHash.get(cacheKey);
    // `cache: false` (plan-754 `decodeFresh` / a forced-split bake): the tree
    // belongs to its caller alone — it is never published, so it can be edited
    // or consumed without affecting anybody else's view of the asset.
    const publish = opts?.cache !== false;

    // A throwing `acquire()` leaves NO handle behind — there is nothing to
    // release, and `revokeUrl` does not exist until a resolve returned.
    // Awaited only when it actually has something to await (see `AcquireFn`).
    const t0 = performance.now();
    let tLast = t0;
    const rec: DecodeTiming = { cacheKey, phases: [], totalMs: 0 };
    const mark = (phase: string): void => {
      const now = performance.now();
      rec.phases.push({ phase, ms: now - tLast });
      tLast = now;
    };
    const acquired = acquire();
    const handle = isThenable(acquired) ? await acquired : acquired;
    const url = handle.url;
    // A registry resolve that knows the content hash (a project document) is
    // the first to tell this key its version (plan-508 F4).
    if (handle.sha256 && !this._expectedHash.has(cacheKey)) this._expectedHash.set(cacheKey, handle.sha256);
    // What the bytes behind `url` must hash to: the resolver's word, else the
    // hash this decode was requested under, else the catalog's for the url.
    const blobSha = handle.sha256 ?? expected ?? hashForUrl(url)?.sha256;
    mark('acquire');

    // Resolve bytes via the generic blob cache (in-memory + Cache API). For
    // blob: URLs the cache pass-throughs — their bytes are already local.
    let loadUrl: string | null = null;
    try {
      const loader = this._loader as unknown as DecodeLoader;
      let gltf: { scene: Group; parser?: GltfParserLike };
      let signatureState: SignatureState = 'none';
      let signaturePresent = false;
      if (typeof loader.parseAsync === 'function') {
        // THE byte path (plan-757 R1). `bytes` is scoped to this block and
        // nulled the moment the parse resolved.
        // plan-759 F6: an encrypted deploy never touches the persistent blob
        // cache — its `rejectUnlessGlb` would refuse the envelope, and it would
        // otherwise write the decrypted GLB to the customer's disk. Plain
        // deploys keep the cache exactly as before.
        const fromBlobCache = !url.startsWith('blob:') && !isEncryptedDeploy();
        let bytes: ArrayBuffer | null = fromBlobCache
          ? await (await _glbBlobCache.getBlob(url, { sha256: blobSha })).arrayBuffer()
          : await this._fetchBytes(url);
        mark('blobCache');
        try {
          const verified = await verifyRvSigBuffer(bytes);
          signatureState = verified.state;
          signaturePresent = verified.signaturePresent;
          mark('verify');
          // THE parse wrapper (plan-498): embedded FMU packages reach the
          // binary resource store under this master's document id.
          gltf = await parseGlbCollectingResources(verified.buffer, modelCacheDocumentId(cacheKey), {
            parseAsync: (data, path) => loader.parseAsync!(data, path),
          });
        } catch (err) {
          // Bytes the cache handed out did not parse: forget them in both
          // tiers so the next ask re-fetches instead of failing identically
          // on every reload (2026-09-26, DemoPlanner). Not a retry — the
          // caller reports this failure; the recovery is for the next load.
          if (fromBlobCache) void _glbBlobCache.evict(url, { sha256: blobSha });
          throw err;
        }
        bytes = null;
      } else {
        // URL seam for a loader without `parseAsync` (test fakes).
        loadUrl = url.startsWith('blob:') ? url : await _glbBlobCache.getObjectUrl(url, { sha256: blobSha });
        mark('blobCache');
        gltf = await loader.loadAsync!(loadUrl);
      }
      mark('gltfParse');
      let source = gltf.scene as Group;
      // The parser's name reconciliation (plan-757 D4): pure sanitizations are
      // restored in place, genuine `_N` dedups recorded — the map feeds the
      // asset's alias table, the `_rvOrigName` stamps travel with every clone.
      const renamedNodes = detectRenamedNodes(gltf.parser);
      // Release the parser explicitly (plan-754 §2.6). `GLTFParser.associations`
      // maps every Object3D/Material/Texture back to its glTF def and
      // `parser.cache` holds one resolved promise per node, mesh and material —
      // so a retained parser keeps the WHOLE def graph of the decode alive, and
      // a destructive bake that drops the tree would free nothing. Nothing after
      // this line reads it, and `gltf` is local, so cutting the link here is
      // belt and braces: it makes the intent explicit and survives anyone later
      // returning `gltf`.
      gltf.parser = undefined;
      mark('renamedNodes');
      // Strip UnityGLTF __root__ wrapper and non-content nodes
      source = unwrapGltfRoot(source);
      source = ensureNeutralPlacementRoot(source);
      mark('unwrap');
      // plan-757 Phase 2b (F10): the asset's OWN `.kin.json` sidecar, the rule
      // `loadGLB` applies to every composed frame — an unsigned file only, on
      // the un-baked tree so component factories see it. ONE probe for every
      // path (`tryFetchSidecarSpec`): it skips blob:/data: urls, treats 404 and
      // an HTML answer as "absent" without a console line, and negative-caches.
      if (!signaturePresent && (this._uberOptions.loadKinematicsSidecar?.() ?? true)) {
        const spec = await tryFetchSidecarSpec(url).catch(() => null);
        if (spec) {
          const report = applyKinematicsSpec(source, spec);
          console.info(`[ModelCache] sidecar applied to ${cacheKey}: drives=${report.applied.drives} `
            + `transports=${report.applied.transports} sensors=${report.applied.sensors}`);
        }
        mark('sidecar');
      }
      // (plan-752's master uber bake used to run here; since plan-757 the
      // material phase is part of the recipe `_bake` runs — dedup → uber, once.)
      this._decodeMeta.set(source, { signatureState, renamedNodes, url });
      // Publish only if this decode has not been invalidated while it ran. The
      // caller still gets its result — it asked before the invalidate — but the
      // CACHE must not be repopulated with a superseded tree.
      let meshes = 0; let tris = 0;
      source.traverse((n) => {
        const m = n as Mesh;
        if (!m.isMesh) return;
        meshes++;
        const g = m.geometry;
        tris += (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3;
      });
      rec.meshes = meshes; rec.triangles = Math.round(tris);
      rec.totalMs = performance.now() - t0;
      _decodeTimings.push(rec);
      if (_decodeTimings.length > DECODE_TIMING_CAP) _decodeTimings.shift();
      console.info('[ModelCache] decode ' + cacheKey + ' ' + rec.totalMs.toFixed(0) + 'ms '
        + rec.phases.map((p) => p.phase + '=' + p.ms.toFixed(0)).join(' ')
        + ' meshes=' + meshes + ' tris=' + rec.triangles);
      if (publish && (this._epoch.get(cacheKey) ?? 0) === epoch) this._decoded.set(cacheKey, source);
      return source;
    } finally {
      // Passthrough rule, unchanged: only an object URL WE minted gets revoked
      // here. A blob: url handed in from outside is the acquire's property...
      if (loadUrl !== null && loadUrl !== url) URL.revokeObjectURL(loadUrl);
      // ...and is released through ITS own obligation, in every outcome —
      // success, failure and (because `detachOnAbort` never cancels the shared
      // work) abort.
      handle.release?.();
    }
  }

  /**
   * Fetch raw GLB bytes for a (blob or object) URL. Test seam. Goes through
   * the served-bytes seam (plan-759 F6): on an encrypted deploy the bytes come
   * back decrypted, or the call throws `EncryptedWithoutKeyError`.
   */
  protected async _fetchBytes(url: string): Promise<ArrayBuffer> {
    return fetchServedBytes(url);
  }

  get size(): number { return this._decoded.size; }

  /**
   * Drop ONE decoded entry (dispose its geometry) — the editor-save
   * invalidation hook: a re-saved library asset must not be served from the
   * pre-save decoded tree. No-op on unknown keys.
   *
   * Takes a CACHE KEY: a plain url for a catalog GLB, a
   * {@link resolvedCacheKey} for a registry asset (plan-723 F10).
   */
  invalidate(cacheKey: string): void {
    // RULE 3 (plan-371 §2.10) — TWO steps, and the second is the load-bearing
    // one. Dropping the promise makes the next ask start a fresh decode; bumping
    // the epoch stops the abandoned decode (which keeps running regardless)
    // from publishing the pre-save tree back into `_decoded` when it lands.
    this._inflight.delete(cacheKey);
    this._epoch.set(cacheKey, (this._epoch.get(cacheKey) ?? 0) + 1);
    // The baked form follows the master: retired now, disposed at refcount 0.
    this._retireBaked(cacheKey);
    binaryResources.releaseDocument(modelCacheDocumentId(cacheKey));
    const entry = this._decoded.get(cacheKey);
    if (!entry) return;
    disposeSubtree(entry);
    this._decoded.delete(cacheKey);
  }

  /**
   * Drop every DECODED tree, keep the byte cache (plan-752 S1).
   *
   * The document-change hook. A decoded master carries baked geometry and a
   * reference to the session's uber material; the next document is a different
   * scene with a different (possibly absent) uber path, and it must not
   * inherit either. The BLOB cache below it holds bytes only — nothing
   * document-specific — so it survives, and a re-decode costs a parse, not a
   * download.
   *
   * Bumps the epoch of every known key so a decode that is still running
   * cannot publish its pre-clear tree back into the map afterwards — the same
   * rule {@link invalidate} enforces for a single key.
   */
  clearDecoded(): void {
    this._retireAll();
    for (const [key, model] of this._decoded) {
      disposeSubtree(model);
      binaryResources.releaseDocument(modelCacheDocumentId(key));
    }
    this._decoded.clear();
  }

  /** Bump every known epoch, abandon in-flight decodes/bakes, retire every baked asset. */
  private _retireAll(): void {
    const keys = new Set([
      ...this._decoded.keys(), ...this._inflight.keys(),
      ...this._baked.keys(), ...this._bakedInflight.keys(),
    ]);
    for (const key of keys) this._epoch.set(key, (this._epoch.get(key) ?? 0) + 1);
    this._inflight.clear();
    for (const key of [...this._baked.keys()]) this._retireBaked(key);
    this._bakedInflight.clear();
  }

  /** Clear the persistent browser cache for all planner GLBs. */
  static async clearPersistentCache(): Promise<void> {
    await _glbBlobCache.clearPersistent();
  }

  dispose(): void {
    this._unsubscribeHashes?.();
    this._unsubscribeHashes = null;
    // Same teardown as `clearDecoded` (plan-753 F11): epochs bumped so a
    // running bake cannot publish, baked assets retired — disposed at once
    // when nothing holds them, else by the last `release()`. The planner
    // therefore calls this AFTER its placement-release loop.
    this._retireAll();
    for (const [key, model] of this._decoded) {
      disposeSubtree(model);
      binaryResources.releaseDocument(modelCacheDocumentId(key));
    }
    this._decoded.clear();
    // In-flight decodes are abandoned, not cancelled — see `_shared`. Their
    // settle handlers are harmless no-ops once the map is empty.
    this._inflight.clear();
  }
}
