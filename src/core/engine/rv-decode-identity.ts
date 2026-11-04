// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-decode-identity — identity at decode (plan-769 F2/F3/F4, Phase 1 "read only").
 *
 * Runs ONCE per decoded file, on the parser's own JSON, before anything else looks
 * at the tree (prepare, bake, unwrap, the naming scan):
 *
 *  1. **NodeIds.** Every glTF node that arrived WITHOUT a `realvirtual.NodeId` gets
 *     the deterministic seed of its canonical authored path (`rv-node-id-seed.mjs`,
 *     the normative two-pass algorithm) under the RUNTIME key
 *     {@link RV_SEEDED_NODE_ID_KEY} — never under `realvirtual.NodeId`: Phase 1
 *     persists nothing (F17), and `sanitizeUserDataForExport` strips `_` keys. A node
 *     WITH an authored id keeps it (the seed reserved it); the model root (the glTF
 *     scene object) gets the scene's id or `seedNodeId('')`.
 *  2. **The file's identity record** ({@link FileIdentity}): ids per glTF index, the
 *     authored index (raw `json.nodes[].name` joined by `/`) and the legacy Three.js
 *     spelling — the per-file side table the Phase-0 memory decision asked for, ONE
 *     per file (shared by every instance of it), never per node.
 *  3. **Migration on load** (F3): every stored path reference of the file is read
 *     through that index (`rv-reference-migration.mjs` — the code the Phase-0
 *     baseline snapshot pins) into `{ address }` or `{ unresolvedPath, reason }`.
 *     The verdicts live IN THE RECORD (a cache keyed by the written path, plus the
 *     set of paths / names the file carried) and the extras are NOT rewritten —
 *     decided in Phase 1b: every stored-reference reader reads through
 *     `NodeRegistry.readStoredRef`, which asks this record, so nothing needs the
 *     `{ address }` form in memory, and nothing migrated can reach a file (F17).
 *     Phase 3's writer asks the same record (`migratePath` / `isFileReference`).
 *  4. **The report**: every ambiguous reference, every reference that binds only in
 *     the legacy Three.js spelling and every missing one — the registry/loader turn
 *     them into Problems when the file enters the live scene.
 *
 * Hooked into THE parse wrapper `parseGlbCollectingResources` (main model, subtree
 * parse, ModelCache, document replace) and separately into the scene-save re-parse.
 * The thumbnail decode gets no identity (it never registers).
 */

import type { Object3D } from 'three';
import { seedNodeIdsForFile } from './rv-node-id-seed.mjs';
import {
  createMigrationContext,
  contentRootOf,
  referenceFieldLabel,
  isReferenceNodeJson,
  forEachReferrer,
  sceneParents,
  type MigrationContext,
  type MigrationGltfJson,
  type MigrationVerdict,
} from './rv-reference-migration.mjs';
import { ADDRESS_SEPARATOR, RV_NODE_ID_KEY, getNodeId, newNodeId } from './rv-node-id';
import { storedReferenceForm, visitReferences, type VisitedReference } from './rv-node-path-rewrite.mjs';
import { RV_SEEDED_NODE_ID_KEY } from './rv-authored-keys';
import { isPureSanitization } from './rv-three-names';

// ─── Node identity ──────────────────────────────────────────────────────

/**
 * The identity of a node: its authored `realvirtual.NodeId`, else the id seeded at
 * decode. `null` for a node no file produced (op-created, synthetic, runtime clone
 * without a seed). THE accessor the address index (`NodeRegistry`) keys on.
 */
export function identityIdOf(node: Object3D): string | null {
  const authored = getNodeId(node);
  if (authored) return authored;
  const seeded = (node.userData as Record<string, unknown> | undefined)?.[RV_SEEDED_NODE_ID_KEY];
  return typeof seeded === 'string' && seeded.length > 0 ? seeded : null;
}

/**
 * A load-independent ORDER key for a node: the identities (else names) of its ancestors down to the node.
 * `Object3D.uuid` is random per load, and a node identity alone repeats across placements of the same file;
 * the ancestor chain contains the placement's reference node, so it tells the occurrences apart.
 * Empty for a node without identity of its own. For tie-breaks that must come out the same after a reload (plan-2059 O3).
 */
export function stableNodeOrderKey(node: Object3D): string {
  if (!identityIdOf(node)) return ''; // no identity: callers fall back to uuid
  const parts: string[] = [];
  for (let n: Object3D | null = node; n; n = n.parent) parts.push(identityIdOf(n) ?? `~${n.name}`);
  return parts.reverse().join('/');
}

/** The seeded (runtime) id of a node, or null — authored ids are not reported here. */
export function seededNodeIdOf(node: Object3D): string | null {
  const seeded = (node.userData as Record<string, unknown> | undefined)?.[RV_SEEDED_NODE_ID_KEY];
  return typeof seeded === 'string' && seeded.length > 0 ? seeded : null;
}

/**
 * Remove every seeded id under `root` — for a WRITER that serialises a decoded tree
 * without `sanitizeUserDataForExport` (the scene-save re-parse): Phase 1 writes no
 * id (F17). Returns how many were removed.
 */
export function stripSeededNodeIds(root: Object3D): number {
  let n = 0;
  root.traverse((node) => {
    const ud = node.userData as Record<string, unknown>;
    if (RV_SEEDED_NODE_ID_KEY in ud) { delete ud[RV_SEEDED_NODE_ID_KEY]; n++; }
  });
  return n;
}

/**
 * plan-769 F12: every reference node carries an identity — its occurrence segment.
 * A reference node no file produced (a live planner drop, a cell-matrix root)
 * gets a RUNTIME id here (UUIDv4 under {@link RV_SEEDED_NODE_ID_KEY}): never
 * persisted (F17 — the sanitizer and the D4 writer strip `_` keys), so a file
 * still carries only what it carried; Phase 3's save mints the authored id.
 * Returns the node's identity id.
 */
export function ensureRuntimeIdentity(node: Object3D): string {
  const id = identityIdOf(node);
  if (id) return id;
  const minted = newNodeId();
  (node.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = minted;
  return minted;
}

/**
 * plan-769 F10 / Inventory C: take the identity off a RUNTIME clone — a ghost, a
 * drag preview, a highlight copy, a spawned MU. `Object3D.clone()` JSON-copies
 * `userData`, so the clone arrives with its source's seeded id AND its authored
 * `realvirtual.NodeId`: two nodes, one identity. Such a clone is no node of any
 * file and is never registered in the address index; stripping makes that a
 * property of the clone instead of a promise of every caller (`docOccurrenceOf`,
 * `auditIdIndex`, a later save walk). Instances of a FILE (`BakeRegistry.instantiate`,
 * compose's `template.clone()`) keep their ids — the occurrence tells them apart.
 * Returns how many nodes carried an identity.
 */
export function stripIdentity(root: Object3D): number {
  let n = 0;
  root.traverse((node) => {
    const ud = node.userData as Record<string, unknown> | undefined;
    if (!ud) return;
    let had = false;
    if (RV_SEEDED_NODE_ID_KEY in ud) { delete ud[RV_SEEDED_NODE_ID_KEY]; had = true; }
    const rv = ud.realvirtual as Record<string, unknown> | undefined;
    if (rv && typeof rv === 'object' && RV_NODE_ID_KEY in rv) { delete rv[RV_NODE_ID_KEY]; had = true; }
    if (had) n++;
  });
  return n;
}

// ─── Migrated references ────────────────────────────────────────────────

/** Why a stored path has no address. `synthetic-target` is decided at runtime (registry). */
export type UnresolvedReason = 'missing' | 'ambiguous' | 'synthetic-target';

/** A stored path reference, migrated (F3/F4): an address relative to its file, or kept. */
export type MigratedReference =
  | { address: string; via: string; unresolvedPath?: undefined; reason?: undefined }
  | { address?: undefined; via: 'unresolved'; unresolvedPath: string; reason: 'missing' | 'ambiguous' };

/** One reference of the report (ambiguous / legacy spelling / missing). */
export interface IdentityFinding {
  /** Id of the node carrying the reference (`rootId` for the scene's lifted components). */
  referrerId: string;
  /** Authored path of that node (`''` = the model root). */
  referrerAuthoredPath: string;
  componentType: string;
  /** Location label (`steps[0].targetObjects[1]`). */
  field: string;
  kind: 'ref' | 'path' | 'name';
  writtenPath: string;
  outcome: 'missing' | 'ambiguous' | 'legacy-spelling';
}

/** Counts of the migration of one file. */
export interface IdentityCounts {
  nodes: number;
  seeded: number;
  existing: number;
  seedCollisions: number;
  duplicateIds: number;
  references: number;
  migrated: number;
  missing: number;
  ambiguous: number;
  legacySpelling: number;
}

/** What the decode identity needs of a loader result. */
export interface DecodedGltfLike {
  scene?: Object3D | null;
  parser?: {
    json?: unknown;
    associations?: Map<Object3D, { nodes?: number } | undefined>;
  } | null;
}

/**
 * What the on-demand lookups need of the file after the parser is gone: the raw names
 * and child lists per node index plus the scenes (the content root is known, so no
 * mesh / camera / light data). Two arrays instead of an object per node (plan-769 9.15);
 * the JSON-shaped skeleton is built from them only when a lookup misses after the decode.
 */
interface CompactSkeleton {
  scene: number | undefined;
  scenes: MigrationGltfJson['scenes'];
  names: ReadonlyArray<string | undefined>;
  children: ReadonlyArray<number[] | undefined>;
}

function skeletonJsonOf(c: CompactSkeleton): MigrationGltfJson {
  const nodes = c.names.map((name, i) => {
    const out: Record<string, unknown> = {};
    if (typeof name === 'string') out.name = name;
    const kids = c.children[i];
    if (kids) out.children = kids;
    return out;
  });
  return { scene: c.scene, scenes: c.scenes, nodes: nodes as MigrationGltfJson['nodes'] };
}

/**
 * The identity record of ONE decoded file: what every instance of it shares.
 *
 * Holds no `Object3D` — a placement asset's record lives as long as its bake, and
 * keeping the throwaway decode graph alive through it would defeat the destructive
 * bake. Addresses are FILE-RELATIVE (`#<id>`): the registry prefixes the occurrence.
 */
export class FileIdentity {
  /** Document / cache id the decode ran under (diagnostics). */
  readonly fileKey: string;
  /** Id of the model root (the glTF scene object). */
  readonly rootId: string;
  /** Final id per glTF node index (authored or seeded); `undefined` = unreachable. */
  readonly ids: ReadonlyArray<string | undefined>;
  /** Node index of the content root (`-1` = the scene) — where `unwrapGltfRoot` lands. */
  readonly contentRoot: number;
  /** Ambiguous / legacy-spelling / missing references of the file. */
  readonly findings: ReadonlyArray<IdentityFinding>;
  readonly counts: IdentityCounts;
  /** `scenes[json.scene ?? 0].extras.realvirtual.idVersion` when present (9.19). */
  readonly idVersion: number | undefined;
  /**
   * Did the decode MIGRATE the file's path references (F3)? Only a file WITHOUT an
   * `idVersion` does: `idVersion: 1` stores addresses already, a newer version is
   * read as it is (refs unchanged, `id-version-newer` — 9.19).
   */
  readonly migrated: boolean;

  private readonly _skeleton: CompactSkeleton;
  private readonly _parent: ArrayLike<number>;
  /** Loader name of one index, computed on first use (plan-769 9.15); null = no legacy step. */
  private readonly _legacyNames: ((i: number) => string) | null;
  private _ctx: MigrationContext | null;
  private readonly _pathCache = new Map<string, MigratedReference>();
  private readonly _nameCache = new Map<string, MigratedReference>();
  /**
   * The written paths / names the FILE's bytes carry (the decode pass saw them).
   * What separates a STORED reference — its verdict is the file's, final, never
   * guessed — from a path the web wrote into the live extras this session (an
   * editor rename rewrite, the reference field, an MCP `set_field`): such a path
   * is an INPUT in runtime spelling (D6/F9) until Phase 3 writes addresses.
   * Survives `_adoptIds` (the verdicts are recomputed, the set is not).
   */
  private readonly _filePaths = new Set<string>();
  private readonly _fileNames = new Set<string>();
  private _indexById: Map<string, number> | null = null;

  /** @internal — built by {@link decodeIdentity}. */
  constructor(init: {
    fileKey: string; rootId: string; ids: Array<string | undefined>; contentRoot: number;
    skeleton: CompactSkeleton; parent: ArrayLike<number>; legacyNames: ((i: number) => string) | null;
    ctx: MigrationContext | null; idVersion: number | undefined; migrated?: boolean;
    findings: IdentityFinding[]; counts: IdentityCounts;
  }) {
    this.migrated = init.migrated ?? init.idVersion === undefined;
    this.fileKey = init.fileKey;
    this.rootId = init.rootId;
    this.ids = init.ids;
    this.contentRoot = init.contentRoot;
    this._skeleton = init.skeleton;
    this._parent = init.parent;
    this._legacyNames = init.legacyNames;
    this._ctx = init.ctx;
    this.idVersion = init.idVersion;
    this.findings = init.findings;
    this.counts = init.counts;
  }

  /** Id of the content root: the node a placement of this file maps onto its reference node. */
  get contentRootId(): string {
    return this.contentRoot === -1 ? this.rootId : (this.ids[this.contentRoot] ?? this.rootId);
  }

  /** File-relative address (`#<id>`) of a node index (`-1` = the model root). */
  addressOfIndex(idx: number): string | null {
    const id = idx === -1 ? this.rootId : this.ids[idx];
    return id ? `${ADDRESS_SEPARATOR}${id}` : null;
  }

  /** glTF index of an id of this file (`-1` = the model root), or undefined. */
  indexOfId(id: string): number | undefined {
    if (id === this.rootId) return -1;
    if (!this._indexById) {
      const m = new Map<string, number>();
      this.ids.forEach((v, i) => { if (v !== undefined && !m.has(v)) m.set(v, i); });
      this._indexById = m;
    }
    return this._indexById.get(id);
  }

  /** Raw authored path (Unity spelling, `/`-joined names) of an id of this file; `''` = the root. */
  authoredPathOf(id: string): string | undefined {
    const idx = this.indexOfId(id);
    if (idx === undefined) return undefined;
    if (idx === -1) return '';
    const names: string[] = [];
    for (let cur = idx; cur >= 0; cur = this._parent[cur]!) {
      const n = this._skeleton.names[cur];
      names.push(typeof n === 'string' ? n : '');
    }
    return names.reverse().join('/');
  }

  /** The migration context, rebuilt on demand after the decode pass dropped it. */
  private _context(): MigrationContext {
    if (!this._ctx) {
      const legacyNameOf = this._legacyNames;
      this._ctx = createMigrationContext(skeletonJsonOf(this._skeleton), {
        parent: this._parent,
        contentRoot: this.contentRoot,
        legacyNameOf,
        legacyRootName: this.contentRoot >= 0 && legacyNameOf ? legacyNameOf(this.contentRoot) : undefined,
      });
    }
    return this._ctx;
  }

  private _toReference(written: string, v: MigrationVerdict): MigratedReference {
    return identityToReference(this, written, v);
  }

  /**
   * F3: a written PATH (ComponentReference `path`, a path field) of this file as an
   * address — the authored index, then the exact legacy Three spelling; never a guess.
   */
  migratePath(written: string): MigratedReference {
    const hit = this._pathCache.get(written);
    if (hit) return hit;
    const out = this._toReference(written, this._context().migratePath(written));
    this._pathCache.set(written, out);
    return out;
  }

  /**
   * F3 for a NAME field (`Source.ThisObjectAsMU`): unique in the owner's subtree, else
   * in the file, else read as a path. `ownerId` = the id of the node carrying it.
   */
  migrateName(name: string, ownerId: string | null): MigratedReference {
    const owner = ownerId === null ? -1 : (this.indexOfId(ownerId) ?? -1);
    const key = `${owner}\u0000${name}`;
    const hit = this._nameCache.get(key);
    if (hit) return hit;
    const out = this._toReference(name, this._context().migrateName(name, owner));
    this._nameCache.set(key, out);
    return out;
  }

  /**
   * Is `written` a reference of the FILE (it was in the bytes the decode migrated),
   * as opposed to a path the web wrote this session? Only for a migrated file —
   * `idVersion` files carry addresses, every legacy path there is an input.
   */
  isFileReference(written: string, kind: 'path' | 'name' = 'path'): boolean {
    return (kind === 'name' ? this._fileNames : this._filePaths).has(written);
  }

  /** Drop the decode-time lookup tables (the caches stay); rebuilt on the next miss. */
  releaseLookups(): void {
    this._ctx = null;
  }

  /** @internal — seed the cache from the decode pass. */
  _cachePath(written: string, ref: MigratedReference): void {
    this._filePaths.add(written);
    if (!this._pathCache.has(written)) this._pathCache.set(written, ref);
  }

  /** @internal */
  _cacheName(ownerIdx: number, name: string, ref: MigratedReference): void {
    this._fileNames.add(name);
    const key = `${ownerIdx}\u0000${name}`;
    if (!this._nameCache.has(key)) this._nameCache.set(key, ref);
  }

  /** @internal — compose re-derives ids on a template (plan-397); the record follows. */
  _adoptIds(idOfIndex: (idx: number) => string | null): number {
    let changed = 0;
    const ids = this.ids as Array<string | undefined>;
    for (let i = 0; i < ids.length; i++) {
      const id = idOfIndex(i);
      if (id && id !== ids[i]) { ids[i] = id; changed++; }
    }
    if (changed > 0) {
      this._indexById = null;
      this._pathCache.clear();
      this._nameCache.clear();
    }
    return changed;
  }
}

// ─── Stored references in a decoded tree (prepare / survival) ───────────

/**
 * The verdict of a STORED reference on a decoded tree BEFORE it is registered —
 * what `prepare` (the Kinematic hook) and the survival model read. It is the SAME
 * verdict the runtime registry reads after the bake (`NodeRegistry.readStoredRef`:
 * the file's migration → address → the node carrying that id), so "survives" and
 * "resolves at runtime" cannot disagree (plan-769 Phase 1b, "Survival == Runtime").
 *
 * Each lookup answers `undefined` when the value is NOT a reference of the file
 * (no migrated identity, or a path the web wrote) — the caller's path lookup
 * applies — and `null` when the file's verdict is "no node" (missing / ambiguous):
 * final, never guessed.
 */
export interface FileReferenceLookup {
  path(written: string): Object3D | null | undefined;
  name(name: string, owner: Object3D): Object3D | null | undefined;
  /**
   * plan-769 Phase 3: ANY stored value (a ComponentReference, a path-field leaf, a path):
   * the path form as {@link path}; an address of THIS file (`#id`) → its node or `null`;
   * an address into another occurrence (`p#id` — a placement's content, not in this
   * tree) → `undefined` (nothing of this file to claim); a kept `unresolvedPath` → `null`.
   */
  stored(value: unknown): Object3D | null | undefined;
}

/**
 * {@link FileReferenceLookup} over `root` (the tmp tree of one decoded file). Paths and
 * names answer only with a MIGRATED identity (else `undefined`: the caller's lookup);
 * addresses answer always — by the ids on the tree.
 */
export function createFileReferenceLookup(
  root: Object3D,
  identity: FileIdentity | null | undefined,
): FileReferenceLookup {
  const migrated = !!identity && identity.migrated;
  let byId: Map<string, Object3D> | null = null;
  const nodeOf = (address: string | undefined): Object3D | null => {
    if (address === undefined) return null;
    if (!byId) {
      const m = new Map<string, Object3D>();
      root.traverse((n) => { const id = identityIdOf(n); if (id && !m.has(id)) m.set(id, n); });
      // An unwrapped decode (ModelCache, subtree parse) has no scene object: the
      // file's root id names the content root it was unwrapped to.
      if (identity && !m.has(identity.rootId)) m.set(identity.rootId, root);
      byId = m;
    }
    const hash = address.lastIndexOf(ADDRESS_SEPARATOR);
    return byId.get(hash >= 0 ? address.slice(hash + 1) : address) ?? null;
  };
  const path = (written: string): Object3D | null | undefined => {
    if (!migrated || !identity!.isFileReference(written, 'path')) return undefined;
    return nodeOf(identity!.migratePath(written).address);
  };
  const ownerIdOf = (owner: Object3D): string | null => {
    for (let n: Object3D | null = owner; n; n = n.parent) {
      const id = identityIdOf(n);
      if (id) return id;
      if (n === root) break;
    }
    return null;
  };
  return {
    path,
    name(name, owner) {
      if (!migrated || !identity!.isFileReference(name, 'name')) return undefined;
      return nodeOf(identity!.migrateName(name, ownerIdOf(owner)).address);
    },
    stored(value) {
      const f = storedReferenceForm(value);
      if (!f) return null;
      if (f.form === 'path') return path(f.path);
      if (f.form === 'unresolved') return null;
      const hash = f.address.lastIndexOf(ADDRESS_SEPARATOR);
      if (hash > 0) return undefined;
      return nodeOf(f.address);
    },
  };
}

// ─── The decode pass ────────────────────────────────────────────────────

const _byScene = new WeakMap<Object3D, FileIdentity>();

/** The identity record of a decoded file, by the loader's scene object (or a node it was moved to). */
export function getDecodeIdentity(sceneRoot: Object3D | null | undefined): FileIdentity | null {
  return sceneRoot ? (_byScene.get(sceneRoot) ?? null) : null;
}

/** Record `identity` for `root` as well — a caller that re-roots the tree (unwrap, neutral root). */
export function linkDecodeIdentity(root: Object3D, identity: FileIdentity | null | undefined): void {
  if (identity) _byScene.set(root, identity);
}

/** Options of {@link decodeIdentity}. */
export interface DecodeIdentityOptions {
  /** Document / cache id (diagnostics). */
  fileKey?: string;
  /** Run the reference migration (default true). The writer re-parse needs only ids. */
  migrate?: boolean;
}

function restoredLoaderName(objName: string, rawName: string | undefined): string {
  // `detectRenamedNodes`' restore rule: a PURE sanitization comes back verbatim,
  // a genuine `_N` dedup keeps the loader's spelling. Computed, not applied —
  // the decode identity runs before that pass and must not move names.
  if (rawName && objName !== rawName && isPureSanitization(rawName, objName)) return rawName;
  return objName;
}

/**
 * The id format this viewer writes and reads (`scenes[0].extras.realvirtual.idVersion`,
 * rv-ODT §5a). A file without it is a Unity export (migrated on load); `1` stores
 * addresses; anything newer is read as it is and reported (`id-version-newer`, 9.19).
 */
export const ID_VERSION_CURRENT = 1;

/** The key of the id format in `scenes[0].extras.realvirtual` (no `_`: it is file content). */
export const ID_VERSION_KEY = 'idVersion';

/** Is the file's `idVersion` newer than this viewer understands? */
export function isIdVersionNewer(identity: Pick<FileIdentity, 'idVersion'> | null | undefined): boolean {
  return typeof identity?.idVersion === 'number' && identity.idVersion > ID_VERSION_CURRENT;
}

function sceneIdVersion(json: MigrationGltfJson): number | undefined {
  const s = json.scenes?.[json.scene ?? 0] as { extras?: { realvirtual?: { idVersion?: unknown } } } | null | undefined;
  const v = (s?.extras?.realvirtual as Record<string, unknown> | undefined)?.[ID_VERSION_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Identity at decode for one loader result (see the module doc). Stamps the seeded
 * ids onto the decoded objects, builds the file's {@link FileIdentity}, runs the
 * migration, and links the record to `gltf.scene` ({@link getDecodeIdentity}).
 * `null` when the result carries no parser JSON (a test fake, a non-glTF source).
 * Never throws: an identity failure must not take a load down.
 */
export function decodeIdentity(gltf: DecodedGltfLike, opts?: DecodeIdentityOptions): FileIdentity | null {
  const json = gltf.parser?.json as MigrationGltfJson | undefined;
  const scene = gltf.scene ?? null;
  if (!json || typeof json !== 'object' || !Array.isArray(json.nodes) || !scene) return null;
  try {
    return runDecodeIdentity(json, scene, gltf.parser?.associations, opts);
  } catch (e) {
    console.warn('[decode-identity] identity pass failed — the file loads without seeded ids:', e);
    return null;
  }
}

function runDecodeIdentity(
  json: MigrationGltfJson,
  scene: Object3D,
  associations: Map<Object3D, { nodes?: number } | undefined> | undefined,
  opts: DecodeIdentityOptions | undefined,
): FileIdentity {
  const nodes = json.nodes ?? [];
  const sceneIndex = json.scene ?? 0;
  const seed = seedNodeIdsForFile(json, sceneIndex);
  // The seed's walk yields `sceneParents(json)` as a by-product (same scene, same rule).
  const parent: ArrayLike<number> = Array.isArray(json.scenes) ? seed.parent : sceneParents(json);

  // 1. Stamp: seeded ids on objects without an authored id; a stale runtime key
  //    (leaked through a writer without the sanitizer) never survives a decode.
  //    The loader name of each node is RECORDED here (a later pass renames objects)
  //    and turned into the legacy spelling only when a lookup needs it (9.15).
  const loaderNames: Array<string | undefined> = new Array(nodes.length);
  const stamp = (obj: Object3D, id: string | undefined): void => {
    const ud = obj.userData as Record<string, unknown>;
    if (getNodeId(obj) || !id) { delete ud[RV_SEEDED_NODE_ID_KEY]; return; }
    ud[RV_SEEDED_NODE_ID_KEY] = id;
  };
  if (associations) {
    // `forEach`, not `for…of`: no entry array per association (every mesh, material and
    // texture of the file has one).
    associations.forEach((ref, obj) => {
      if (!ref || ref.nodes === undefined || !(obj as { isObject3D?: boolean }).isObject3D) return;
      const i = ref.nodes;
      if (i < 0 || i >= nodes.length) return;
      stamp(obj, seed.ids[i]);
      loaderNames[i] = obj.name;
    });
  }
  stamp(scene, seed.rootId);
  const rawNames: Array<string | undefined> = new Array(nodes.length);
  const childLists: Array<number[] | undefined> = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    rawNames[i] = typeof n?.name === 'string' ? n.name : undefined;
    childLists[i] = n && Array.isArray(n.children) ? n.children : undefined;
  }
  const legacyNameAt = (i: number): string => {
    const rawName = rawNames[i];
    const objName = loaderNames[i];
    // A node the loader did not associate keeps its raw name (the replica's rule).
    if (objName === undefined) return rawName ?? '';
    const restored = restoredLoaderName(objName, rawName);
    // Reuse the raw string where the spellings agree (memory: one string, not two).
    return restored === rawName ? rawName : restored;
  };
  const legacyMemo: Array<string | undefined> = new Array(nodes.length);
  const legacyNameOf = (i: number): string => (legacyMemo[i] ??= legacyNameAt(i));

  // 2. The migration (F3) over the file's own JSON.
  const findings: IdentityFinding[] = [];
  const counts: IdentityCounts = {
    nodes: nodes.length,
    seeded: seed.seeded,
    existing: seed.existing,
    seedCollisions: seed.collisions.length,
    duplicateIds: seed.duplicates.length,
    references: 0, migrated: 0, missing: 0, ambiguous: 0, legacySpelling: 0,
  };
  const contentRoot = contentRootOf(json);
  const hasLegacy = associations !== undefined;
  const ctx = createMigrationContext(json, {
    parent,
    legacyNameOf: hasLegacy ? legacyNameOf : null,
    legacyRootName: contentRoot >= 0 ? legacyNameAt(contentRoot) : undefined,
  });
  const idVersion = sceneIdVersion(json);
  // 9.19: only a file WITHOUT an id format is migrated. `idVersion: 1` already stores
  // addresses; a newer version is read as it is (refs unchanged) and reported.
  const migrate = opts?.migrate !== false && idVersion === undefined;
  const identity = new FileIdentity({
    fileKey: opts?.fileKey ?? '',
    rootId: seed.rootId,
    ids: seed.ids,
    contentRoot,
    skeleton: {
      scene: json.scene,
      scenes: (json.scenes ?? []).map((s) => (s ? { name: s.name, nodes: s.nodes } : s)),
      names: rawNames,
      children: childLists,
    },
    parent,
    legacyNames: hasLegacy ? legacyNameOf : null,
    ctx,
    idVersion,
    migrated: migrate,
    findings,
    counts,
  });

  if (migrate) {
    // `insideReferenceJson` per node, memoised along `parent` (0 unknown, 1 inside, 2 not).
    const foreign = new Uint8Array(nodes.length);
    const isForeign = (i: number): boolean => {
      if (i < 0) return false;
      const known = foreign[i]!;
      if (known !== 0) return known === 1;
      const inside = isReferenceNodeJson(nodes[i]) || isForeign(parent[i]!);
      foreign[i] = inside ? 1 : 2;
      return inside;
    };
    const referrerPath = (idx: number): string => (idx === -1 ? '' : (ctx.rawPathOf(idx) ?? ''));
    // One verdict per written path (per name + owner): Unity writes the same target
    // from many components (the large CAD line: 34 528 references, 17 052 distinct).
    const pathVerdicts = new Map<string, [MigrationVerdict, MigratedReference]>();
    const nameVerdicts = new Map<string, [MigrationVerdict, MigratedReference]>();
    // ONE visitor for the whole file; the referrer it is visiting is `at` / `referrerId`.
    let at = -1;
    let referrerId: string | undefined;
    const visitRef = (ref: VisitedReference): void => {
      // enumerateReferences' rule: an empty path is no reference.
      if (typeof ref.path !== 'string' || ref.path.length === 0) return;
      counts.references++;
      const isName = ref.kind === 'name';
      const cache = isName ? nameVerdicts : pathVerdicts;
      const key = isName ? `${at}\u0000${ref.path}` : ref.path;
      let hit = cache.get(key);
      if (!hit) {
        const v = isName ? ctx.migrateName(ref.path, at) : ctx.migratePath(ref.path);
        hit = [v, identityToReference(identity, ref.path, v)];
        cache.set(key, hit);
        // The record's caches take the FIRST verdict of a key (a repeat would be a no-op).
        if (isName) identity._cacheName(at, ref.path, hit[1]);
        else identity._cachePath(ref.path, hit[1]);
      }
      const verdict = hit[0];
      const migrated = hit[1];
      let outcome: IdentityFinding['outcome'] | null = null;
      if (migrated.address !== undefined) {
        counts.migrated++;
        if (verdict.via.includes('legacy-three')) { counts.legacySpelling++; outcome = 'legacy-spelling'; }
      } else if (migrated.reason === 'ambiguous') { counts.ambiguous++; outcome = 'ambiguous'; }
      else { counts.missing++; outcome = 'missing'; }
      if (outcome && referrerId) {
        // The location label is built only for a finding.
        findings.push({
          referrerId, referrerAuthoredPath: referrerPath(at), componentType: ref.componentKey,
          field: referenceFieldLabel(ref), kind: ref.kind, writtenPath: ref.path, outcome,
        });
      }
    };
    // THE walk (`visitReferences`) per referrer, directly — no reference list.
    forEachReferrer(json, parent, isForeign, (idx, extras) => {
      at = idx;
      referrerId = idx === -1 ? seed.rootId : seed.ids[idx];
      visitReferences(extras, visitRef);
    });
  }
  identity.releaseLookups();
  _byScene.set(scene, identity);
  return identity;
}

function identityToReference(identity: FileIdentity, written: string, v: MigrationVerdict): MigratedReference {
  if (v.idx !== undefined) {
    const address = identity.addressOfIndex(v.idx);
    if (address) return { address, via: v.via };
  }
  return { via: 'unresolved', unresolvedPath: written, reason: v.via === 'unresolved' ? (v.reason ?? 'missing') : 'missing' };
}
