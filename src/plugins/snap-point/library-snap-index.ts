// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { listLocalStorageKeys, readLocalStorage, removeLocalStorage, writeLocalStorage } from '../../core/rv-safe-storage';

/**
 * library-snap-index — Lazy snap-point index for library assets.
 *
 * On first request for a (typeId, oppositeDirCode) pair, walks all known
 * library catalog entries (at most {@link INDEX_CONCURRENCY} at a time) and
 * reads each GLB's snap names from its JSON CHUNK ONLY — no GLTFLoader, no
 * Draco, no geometry. The bytes come from the shared GLB blob cache
 * (`getGlbBytes`, the same rule ModelCache's decode uses), so placing the asset
 * afterwards does not download it a second time.
 *
 * Runtime name parity (the one trap): `nodeName` is later matched by EXACT
 * string against the placed asset's runtime node names. GLTFLoader sanitizes
 * every name (`sanitizeLikeThree`) and appends `_N` on collisions within ONE
 * used-names set shared by nodes, meshes, lights, cameras and scenes;
 * `detectRenamedNodes` then restores a pure sanitization. So a snap whose
 * sanitized name is unique in that set has the AUTHORED name at runtime. If any
 * snap is not unique, the WHOLE asset falls back to a decode through the shared
 * `gltfLoader` (+ `detectRenamedNodes`) — Three's dedup order is not
 * reimplemented here. Only nodes reachable from the default scene count.
 *
 * Cache key: `rv-snap-index-v3:<glbUrl>@<sha256>` when the catalog knows the
 * asset's content hash, else `rv-snap-index-v3:<glbUrl>` — the memory cache uses
 * the same key. Manual clear via `clearCache()` (DevTools, tests).
 */

import type { Object3D } from 'three';
import type { LibraryCatalogEntry } from '../layout-planner/rv-layout-store';
import { evictCachedGlbBytes, getGlbBytes } from '../../core/engine/rv-model-cache';
import { parseGlbChunks } from '../../core/persistence/rv-glb-chunks';
import { sanitizeLikeThree } from '../../core/engine/rv-three-names';
import { gltfLoader, detectRenamedNodes, type GltfParserLike } from '../../core/engine/rv-glb-parse';
import { binaryResources, parseGlbCollectingResources } from '../../core/engine/rv-binary-resources';
import { hashForUrl } from '../../core/library/rv-asset-hash-registry';
import {
  parseSnapName,
  flowsCompatible,
  forcesBidiPort,
  type SnapDirection,
  type SnapDirectionCode,
  type SnapFlow,
} from './snap-name-parser';

export interface LibraryAssetSnapEntry {
  /** Library catalog entry id. */
  catalogId: string;
  /** GLB URL the snap belongs to. */
  glbUrl: string;
  /** Snap point inside the asset. */
  snaps: Array<{
    /** Runtime node name — what the placed asset's `Object3D.name` is. */
    nodeName: string;
    dir: SnapDirection;
    typeId: string;
    flow: SnapFlow;
    /** Index of the snap node in the GLB's `json.nodes`. */
    nodeIndex: number;
    /** The node's raw glTF name (`json.nodes[nodeIndex].name`). */
    authoredName: string;
  }>;
}

type SnapRecord = LibraryAssetSnapEntry['snaps'][number];

// v3: names read from the JSON chunk (runtime spelling, see the header), entries
// carry `nodeIndex` + `authoredName`, and the key includes the content hash.
// v2 normalized the flow through `forcesBidiPort`; v1 stored the raw flow.
const LS_PREFIX = 'rv-snap-index-v3:';
const LEGACY_LS_PREFIXES: readonly string[] = ['rv-snap-index-v1:', 'rv-snap-index-v2:'];
/** How many assets are indexed in parallel by {@link findCompatibleLibraryAssets}. */
const INDEX_CONCURRENCY = 4;

const _memoryCache = new Map<string, LibraryAssetSnapEntry>();
const _inflight = new Map<string, Promise<LibraryAssetSnapEntry>>();
let _legacySwept = false;

/** Cache key of one asset version: url + content hash when the catalog knows it. */
function _cacheKey(glbUrl: string): string {
  const sha256 = hashForUrl(glbUrl)?.sha256;
  return sha256 ? `${glbUrl}@${sha256}` : glbUrl;
}

function _removeLocalStorageKeys(prefixes: readonly string[]): void {
  try {
    const keys: string[] = [];
    for (const k of listLocalStorageKeys()) {
      if (k && prefixes.some((p) => k.startsWith(p))) keys.push(k);
    }
    for (const k of keys) removeLocalStorage(k);
  } catch { /* ignore */ }
}

/** Drop the v1/v2 entries once per session — they are never read again. */
function _sweepLegacyOnce(): void {
  if (_legacySwept) return;
  _legacySwept = true;
  _removeLocalStorageKeys(LEGACY_LS_PREFIXES);
}

function _readLocalStorage(key: string): LibraryAssetSnapEntry | null {
  try {
    const raw = readLocalStorage(LS_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as LibraryAssetSnapEntry;
    if (!entry || !Array.isArray(entry.snaps)) throw new Error('malformed snap index entry');
    return entry;
  } catch {
    // Corrupt entry — drop it
    try { removeLocalStorage(LS_PREFIX + key); } catch { /* ignore */ }
    return null;
  }
}

function _writeLocalStorage(key: string, entry: LibraryAssetSnapEntry): void {
  try {
    writeLocalStorage(LS_PREFIX + key, JSON.stringify(entry));
  } catch {
    /* quota — silently skip; memory cache still holds it */
  }
}

/** A snap record for `nodeName`, flow normalized exactly as the runtime scanner does. */
function _snapRecord(glbUrl: string, nodeName: string, nodeIndex: number, authoredName: string): SnapRecord | null {
  const parsed = parseSnapName(nodeName);
  if (!parsed) return null;
  return {
    nodeName,
    dir: parsed.dir,
    typeId: parsed.typeId,
    // Apply the same bidi-force the runtime scanner uses, keyed off the GLB
    // url (it contains the model keyword, e.g. "ChainTransfer"), so the
    // quick-add picker matches a forced-bidi port (convchain) the same way a
    // placed asset would.
    flow: forcesBidiPort(glbUrl, parsed.typeId) ? 'bidi' : parsed.flow,
    nodeIndex,
    authoredName,
  };
}

interface GltfJsonSlice {
  scene?: number;
  scenes?: Array<{ name?: string; nodes?: number[] }>;
  nodes?: Array<{ name?: string; children?: number[] }>;
  meshes?: Array<{ name?: string; primitives?: unknown[] }>;
  cameras?: Array<{ name?: string }>;
  extensions?: { KHR_lights_punctual?: { lights?: Array<{ name?: string }> } };
}

/** Indices of every node reachable from the default scene (`json.scene ?? 0`). */
function _defaultSceneNodes(json: GltfJsonSlice): Set<number> {
  const reachable = new Set<number>();
  const scene = json.scenes?.[json.scene ?? 0];
  const nodes = json.nodes ?? [];
  const stack = [...(scene?.nodes ?? [])];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || reachable.has(i)) continue;
    reachable.add(i);
    for (const c of nodes[i].children ?? []) stack.push(c);
  }
  return reachable;
}

/**
 * How often each sanitized name enters GLTFLoader's ONE used-names set. Counted
 * conservatively (every def in the file, whether loaded or not): an over-count
 * only costs a fallback decode, an under-count would yield a wrong name.
 */
function _usedNameCounts(json: GltfJsonSlice): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string): void => {
    const s = sanitizeLikeThree(name);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  };
  // Nodes and cameras: createUniqueName only when the def has a name.
  for (const n of json.nodes ?? []) if (n?.name) add(n.name);
  for (const c of json.cameras ?? []) if (c?.name) add(c.name);
  for (const s of json.scenes ?? []) if (s?.name) add(s.name);
  // Meshes: one createUniqueName per primitive, fallback name `mesh_<i>`.
  (json.meshes ?? []).forEach((m, i) => {
    const name = m?.name || `mesh_${i}`;
    const prims = Math.max(1, m?.primitives?.length ?? 1);
    for (let p = 0; p < prims; p++) add(name);
  });
  (json.extensions?.KHR_lights_punctual?.lights ?? []).forEach((l, i) => add(l?.name || `light_${i}`));
  return counts;
}

/**
 * Snap records from the JSON chunk, or `null` when a snap's runtime name cannot
 * be derived without a decode (its sanitized name collides).
 */
function _snapsFromJson(glbUrl: string, json: GltfJsonSlice): SnapRecord[] | null {
  const nodes = json.nodes ?? [];
  const reachable = _defaultSceneNodes(json);
  let counts: Map<string, number> | null = null;
  const snaps: SnapRecord[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const authoredName = nodes[i]?.name;
    if (!authoredName || !reachable.has(i) || !parseSnapName(authoredName)) continue;
    counts ??= _usedNameCounts(json);
    if ((counts.get(sanitizeLikeThree(authoredName)) ?? 0) !== 1) return null;
    const rec = _snapRecord(glbUrl, authoredName, i, authoredName);
    if (rec) snaps.push(rec);
  }
  return snaps;
}

let _decodeSeq = 0;

/**
 * The fallback: a full decode through THE parse wrapper
 * (`parseGlbCollectingResources`, plan-498) with the SHARED `gltfLoader`
 * (local Draco), names reconciled by `detectRenamedNodes` exactly as at runtime.
 * Nothing of the decode is kept: the wrapper's one side effect — embedded FMU
 * payloads put into `binaryResources` — is held under a throwaway document id
 * and released again right after the parse.
 */
async function _snapsFromDecode(glbUrl: string, bytes: ArrayBuffer, json: GltfJsonSlice): Promise<SnapRecord[]> {
  const documentId = `snap-index-decode:${++_decodeSeq}`;
  let gltf: Awaited<ReturnType<typeof gltfLoader.parseAsync>>;
  try {
    gltf = await parseGlbCollectingResources(bytes, documentId, gltfLoader);
  } finally {
    binaryResources.releaseDocument(documentId);
  }
  const parser = gltf.parser as unknown as GltfParserLike;
  detectRenamedNodes(parser);
  const snaps: SnapRecord[] = [];
  gltf.scene.traverse((node: Object3D) => {
    const nodeIndex = parser.associations?.get(node)?.nodes;
    if (nodeIndex === undefined) return;
    const rec = _snapRecord(glbUrl, node.name, nodeIndex, json.nodes?.[nodeIndex]?.name ?? node.name);
    if (rec) snaps.push(rec);
  });
  return snaps;
}

async function _buildIndex(catalogId: string, glbUrl: string): Promise<LibraryAssetSnapEntry> {
  const bytes = await getGlbBytes(glbUrl);
  let json: GltfJsonSlice;
  try {
    json = parseGlbChunks(bytes).json as GltfJsonSlice;
  } catch (err) {
    // Same recovery as ModelCache: bytes that do not parse are forgotten so the
    // next ask re-fetches instead of failing identically forever.
    void evictCachedGlbBytes(glbUrl);
    throw err;
  }
  let snaps = _snapsFromJson(glbUrl, json);
  if (snaps === null) {
    console.warn(`[library-snap-index] duplicate snap node name in ${glbUrl} — falling back to a full decode`);
    snaps = await _snapsFromDecode(glbUrl, bytes, json);
  }
  return { catalogId, glbUrl, snaps };
}

/** Ensure the index for a single library entry is loaded. Idempotent. */
export async function ensureAssetIndex(
  catalogId: string,
  glbUrl: string,
): Promise<LibraryAssetSnapEntry> {
  const key = _cacheKey(glbUrl);
  const cached = _memoryCache.get(key);
  if (cached) return cached;
  _sweepLegacyOnce();
  const ls = _readLocalStorage(key);
  if (ls) {
    _memoryCache.set(key, ls);
    return ls;
  }
  const pending = _inflight.get(key);
  if (pending) return pending;

  const promise = _buildIndex(catalogId, glbUrl).then((entry) => {
    _memoryCache.set(key, entry);
    _writeLocalStorage(key, entry);
    return entry;
  });
  _inflight.set(key, promise);
  const drop = (): void => { if (_inflight.get(key) === promise) _inflight.delete(key); };
  promise.then(drop, drop);
  return promise;
}

/**
 * Snap index of ANY catalog entry — also one without a `glbUrl` (plan-655 F4).
 *
 * A project document (`project:<path>` / documentId) has no stable URL: its
 * bytes come from its library source as a fresh `blob:` per resolve. The index
 * is built from that volatile URL, which is released right after, and cached
 * under the entry identity + content hash — never under the blob URL. Without a
 * content hash nothing is cached (a re-saved document must not answer with the
 * snaps it had before). Throws when no registered source knows the entry.
 */
export async function ensureEntryIndex(entry: LibraryCatalogEntry): Promise<LibraryAssetSnapEntry> {
  if (entry.glbUrl) return ensureAssetIndex(entry.id, entry.glbUrl);
  // plan-778: an entry of a library PROJECT is keyed by (library, document id)
  // — two libraries may both have `models/pump`, and their snaps differ.
  const origin = entry.libraryOrigin;
  const idKey = origin ? `${origin.sourceId}/${entry.id}` : entry.id;
  const key = entry.sha256 ? `entry:${idKey}@${entry.sha256}` : null;
  if (key) {
    const cached = _memoryCache.get(key) ?? _readLocalStorage(key);
    if (cached) { _memoryCache.set(key, cached); return cached; }
  }
  const { getLibrarySource, listLibrarySources } = await import('../../core/library/library-source-registry');
  if (origin) {
    // Strict, like a qualified placement: that library or nothing.
    const source = getLibrarySource(origin.providerId, origin.sourceId);
    let known: LibraryCatalogEntry | null = null;
    try { known = source?.getEntry(entry.id) ?? null; } catch { known = null; }
    if (!source || !known) throw new Error(`Library "${origin.sourceId}" does not hold "${entry.id}"`);
    const resolved = await source.resolveAsset(known.id, 'place');
    try {
      const built = await _buildIndex(entry.id, resolved.url);
      if (key) { _memoryCache.set(key, built); _writeLocalStorage(key, built); }
      return built;
    } finally {
      void evictCachedGlbBytes(resolved.url);
      resolved.revokeUrl?.();
    }
  }
  for (const { source } of listLibrarySources()) {
    let known: LibraryCatalogEntry | null = null;
    try {
      known = source.getEntry?.(entry.id)
        ?? source.listEntries().find((e) => e.id === entry.id || (!!entry.documentId && e.documentId === entry.documentId))
        ?? null;
    } catch { known = null; }
    if (!known) continue;
    const resolved = await source.resolveAsset(known.id, 'place');
    try {
      const built = await _buildIndex(entry.id, resolved.url);
      if (key) { _memoryCache.set(key, built); _writeLocalStorage(key, built); }
      return built;
    } finally {
      void evictCachedGlbBytes(resolved.url);
      resolved.revokeUrl?.();
    }
  }
  throw new Error(`No library source knows "${entry.id}"`);
}

/**
 * For a target snap, find all library entries that contain at least one
 * compatible snap. "Compatible" means:
 *   - same `typeId`
 *   - flow-compatible: in↔out, bidi↔anything; rejects in↔in / out↔out
 *
 * The axis direction code is NOT a hard filter — outward direction comes
 * from snap POSITION in the alignment math. The `preferOppositeDirCode`
 * argument is preserved for source-compat (favours the natural same-axis-
 * opposite snap when an asset exposes multiple matches), but is otherwise
 * informational.
 *
 * Indexes up to {@link INDEX_CONCURRENCY} assets in parallel; the result keeps
 * the order of `entries`. An entry whose index fails to load is skipped.
 */
export async function findCompatibleLibraryAssets(
  entries: LibraryCatalogEntry[],
  typeId: string,
  preferOppositeDirCode?: SnapDirectionCode,
  targetFlow?: SnapFlow,
): Promise<Array<{ entry: LibraryCatalogEntry; ownSnapName: string }>> {
  const indices: Array<LibraryAssetSnapEntry | null> = new Array(entries.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      // Splats / virtual DES parts have no GLB snaps; a registry entry without
      // a glbUrl (project document) is indexed through its source (plan-655 F4).
      if (e.splatUrl || e.virtual || (!e.glbUrl && !e.localPath)) continue;
      try {
        indices[i] = await ensureEntryIndex(e);
      } catch {
        indices[i] = null; // skip on load error
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INDEX_CONCURRENCY, entries.length) }, worker));

  const out: Array<{ entry: LibraryCatalogEntry; ownSnapName: string }> = [];
  entries.forEach((e, i) => {
    const idx = indices[i];
    if (!idx) return;
    const matches = idx.snaps.filter(
      (s) => s.typeId === typeId && flowsCompatible(targetFlow, s.flow),
    );
    if (matches.length === 0) return;
    const preferred = preferOppositeDirCode
      ? matches.find((s) => s.dir.code === preferOppositeDirCode)
      : undefined;
    const chosen = preferred ?? matches[0];
    out.push({ entry: e, ownSnapName: chosen.nodeName });
  });
  return out;
}

/** Clear the in-memory + localStorage cache (DevTools, tests) — v3 and the legacy v1/v2 keys. */
export function clearCache(): void {
  _memoryCache.clear();
  _inflight.clear();
  _removeLocalStorageKeys([LS_PREFIX, ...LEGACY_LS_PREFIXES]);
}

/** Direct read of in-memory cache (test helper). Keyed by `<glbUrl>` or `<glbUrl>@<sha256>`. */
export function _getMemoryCache(): ReadonlyMap<string, LibraryAssetSnapEntry> {
  return _memoryCache;
}
