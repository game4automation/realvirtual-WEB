// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

//! Types for scripts/lib/rv-glb-nodes.mjs (plan-610 Phase 4) — reference-safe
//! rename / move / group creation on glTF JSON. All paths are ASSET-RELATIVE
//! (no root segment), segments named like the viewer names nodes (GLTFLoader's
//! file-wide de-duplication in load order, raw name restored where only sanitized).

import type { ReferenceRewriteWarningCode } from '../../src/core/engine/rv-node-path-rewrite.mjs';

/** Rule a refused operation broke. The JSON is untouched when one is thrown. */
export type NodeOpErrorCode =
  | 'not-gltf'
  | 'no-scene'
  | 'bad-index'
  | 'multi-parent'
  | 'bad-args'
  | 'bad-path'
  | 'not-found'
  | 'empty-name'
  | 'slash-in-name'
  | 'name-collision'
  | 'name-taken-in-file'
  | 'cycle'
  | 'world-mismatch'
  | 'inside-reference'
  | 'signal-name-follows-node'
  | 'duplicate-move'
  | 'group-name-taken';

export declare class NodeOpError extends Error {
  readonly code: NodeOpErrorCode;
  constructor(code: NodeOpErrorCode, message: string);
}

/** Mirror of `SIGNAL_TYPES` (rv-signal-construction.ts). */
export declare const SIGNAL_COMPONENT_TYPES: ReadonlyArray<string>;

export interface NodeOpWarning {
  /**
   * Core rewrite warnings, plus `dedup-shift` (a node's file-wide de-duplicated name changed) and
   * `ambiguous-loader-name` (a changed path runs through a node the loader names order-dependently —
   * see {@link ambiguousLoaderNames}; the rewrite is a best guess).
   */
  code: ReferenceRewriteWarningCode | 'dedup-shift' | 'ambiguous-loader-name';
  /** Asset-relative path of the referrer (core warnings) / of the shifted node (`dedup-shift`, `ambiguous-loader-name`: its new path). */
  nodePath: string;
  componentType: string;
  field: string;
  /** The written path / name concerned (`dedup-shift`, `ambiguous-loader-name`: the node's old path). */
  path: string;
  message: string;
}

export interface NodeOpResult {
  /** References (ComponentReference + declared path fields) whose written path changed. */
  referencesRewritten: number;
  /** Declared name fields (`Source.ThisObjectAsMU`) rewritten. */
  nameFieldsRewritten: number;
  warnings: NodeOpWarning[];
}

export interface NodeOpOptions {
  /** Extra names the model root is known by (root-prefixed references); the scene name is always one. */
  rootNames?: Iterable<string>;
  /** Source missing but the target already there → no-op instead of `not-found` (re-runnable scripts). */
  skipIfDone?: boolean;
}

/** The model root's name — the scene name (`''` when unnamed). */
export declare function modelRootName(json: unknown): string;

/** Asset-relative path of every node reachable from the scene, in depth-first scene order. */
export declare function nodePaths(json: unknown): Map<number, string>;

/** Effective (viewer) node name of every reachable node — glTF name, or `<sanitized>_N` on a file-wide collision; the path segment of {@link nodePaths}. */
export declare function nodeNames(json: unknown): Map<number, string>;

/** `THREE.PropertyBinding.sanitizeNodeName` (whitespace → `_`, `[ ] . : /` removed). */
export declare function sanitizeLikeThree(name: string): string;

export interface FileNameCollision {
  /** glTF node index. */
  index: number;
  /** Asset-relative path (effective names). */
  path: string;
  /** The glTF name. */
  raw: string;
  /** The name the loader gives it (`<sanitized>_N`). */
  name: string;
}

/** Every reachable node loaded under a file-wide collision name instead of its glTF name, in scene order. */
export declare function fileNameCollisions(json: unknown): FileNameCollision[];

export interface AmbiguousLoaderName {
  /** glTF node index. */
  index: number;
  /** Asset-relative path (best guess: mesh claims in trigger order). */
  path: string;
  /** The node's best-guess name. */
  name: string;
  /** `true` when an ancestor, not the node itself, carries the order-dependent name. */
  ancestor: boolean;
}

/**
 * Every reachable node whose path depends on the order GLTFLoader's mesh promises settle: an unnamed
 * node named after a single-primitive mesh whose sanitized name two or more mesh claims share, and
 * everything below it. Named nodes, scenes, cameras and lights are always deterministic.
 */
export declare function ambiguousLoaderNames(json: unknown): AmbiguousLoaderName[];

/** Node index at an asset-relative path (exact), `null` when there is none. */
export declare function findByPath(json: unknown, path: string): number | null;

/** Rename + reference rewrite. Throws {@link NodeOpError}; renaming to the current name is a no-op. */
export declare function renameNode(
  json: unknown,
  path: string,
  newName: string,
  opts?: NodeOpOptions,
): NodeOpResult & { /** The node's path afterwards. */ path: string };

/** Move (local transform kept; parents must share their world matrix) + reference rewrite. */
export declare function moveNode(
  json: unknown,
  path: string,
  newParentPath: string | null,
  opts?: NodeOpOptions & { /** Position among the new siblings (default: last). */ index?: number },
): NodeOpResult & { path: string };

export interface NodeMove {
  /** Pre-batch path of the node to move. */
  path: string;
  /** Pre-batch path of the new parent; `null` = top level. */
  newParentPath: string | null;
  index?: number;
}

/** Atomic batch move: one path map and one reference scan for all moves. */
export declare function moveNodes(
  json: unknown,
  moves: ReadonlyArray<NodeMove>,
  opts?: NodeOpOptions,
): NodeOpResult & { /** Each node's path afterwards, in input order. */ paths: string[] };

/** Create (or reuse an empty identity) group; appended last, so no reference changes. */
export declare function createGroup(
  json: unknown,
  parentPath: string | null,
  name: string,
): NodeOpResult & { path: string; nodeIndex: number; created: boolean };

/** One hit of today's node-level resolution chain (plan-769 Phase 0 baseline). */
export interface ReferenceLookupHit {
  /** glTF node index; `-1` = the model root (scene). */
  idx: number;
  stage: 'exact' | 'space' | 'suffix' | 'sanitized' | 'name-in-scope';
  spelling: 'relative' | 'root-prefixed';
  scopeRootPath: string;
}

/** Read-only view of today's resolution chain over an unchanged file. */
export declare function referenceLookup(json: unknown, opts?: { rootNames?: readonly string[] }): {
  R: string;
  reg(idx: number): string;
  rel: Array<string | undefined>;
  resolve(written: string): ReferenceLookupHit | null;
  resolveName(name: string, ownerIdx: number): { canonical: string | null; ambiguous?: boolean } | null;
  parent: number[];
  isForeign(idx: number): boolean;
};
