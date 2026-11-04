// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-node-id-seed.mjs (plan-769, rv-ODT §5a). */

/** UUIDv5(NAMESPACE_URL, 'https://realvirtual.io/rv-odt/node-id') — fixed forever. */
export const RV_NODE_ID_NAMESPACE: string;

/** RFC 9562 URL namespace (`6ba7b811-…`), the parent of {@link RV_NODE_ID_NAMESPACE}. */
export const UUID_NAMESPACE_URL: string;

/** Canonical path of the model root (the glTF scene itself): `''`. */
export const ROOT_CANONICAL_PATH: string;

/** Lowercase hex SHA-1 of the UTF-8 bytes of `text`. */
export function sha1Hex(text: string): string;

/** RFC 9562 UUIDv5 of `name` (UTF-8) in `namespace`, lowercase and hyphenated. */
export function uuidV5(namespace: string, name: string): string;

/** `UUIDv5(RV_NODE_ID_NAMESPACE, canonicalPath)` — synchronous, identical in browser and Node. */
export function seedNodeId(canonicalPath: string): string;

/** One escaped segment of a non-empty raw name (`\`, `/`, `[` and a leading `#` escaped; no `[k]`). */
export function escapeSegment(name: string): string;

/** Minimal glTF JSON shape the seed reads. */
export interface SeedGltfJson {
  scene?: number;
  scenes?: Array<{ name?: string; nodes?: number[]; extras?: { realvirtual?: { NodeId?: unknown } } } | null | undefined>;
  nodes?: Array<{ name?: string; children?: number[]; extras?: { realvirtual?: { NodeId?: unknown } } } | null | undefined>;
}

/** Canonical authored path per glTF node index (`undefined` = not reachable from the scene). */
export function canonicalAuthoredPaths(json: SeedGltfJson, sceneIndex?: number): Array<string | undefined>;

export interface SeedCollision {
  /** glTF node index, `-1` = the model root (scene). */
  index: number;
  path: string;
  /** The `n` of `path + '\u0000' + n` that was free. */
  n: number;
}

export interface SeedResult {
  /** Final id per glTF node index (existing or seeded); `undefined` = unreachable without an id. */
  ids: Array<string | undefined>;
  /** Id of the model root: the scene's own NodeId, else `seedNodeId('')`. */
  rootId: string;
  paths: Array<string | undefined>;
  /** Ids the file already carried (scene included). */
  existing: number;
  /** Ids minted by the seed (root included when seeded). */
  seeded: number;
  collisions: SeedCollision[];
  /** Existing ids carried by more than one holder (`index -1` = scene). */
  duplicates: Array<{ index: number; id: string }>;
  /**
   * `parent[i]` of every node of the walked scene (`-1` top level, `-2` not reached) —
   * equal to `sceneParents(json)` (rv-reference-migration.mjs), produced by the seed's
   * walk (non-enumerable).
   */
  readonly parent: number[];
}

/** The normative two-pass seed of one file. */
export function seedNodeIdsForFile(json: SeedGltfJson, sceneIndex?: number): SeedResult;
