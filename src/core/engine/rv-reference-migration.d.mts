// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-reference-migration.mjs (plan-769 F3/F4). */

export const AMBIGUOUS: -3;

export function sanitizeLikeThree(name: string): string;
export function normalizeWrittenPath(path: string): string;

/** Minimal glTF JSON shape the migration reads. */
export interface MigrationGltfJson {
  scene?: number;
  scenes?: Array<{ name?: string; nodes?: number[]; extras?: Record<string, unknown> } | null | undefined>;
  nodes?: Array<{
    name?: string;
    children?: number[];
    mesh?: number;
    camera?: number;
    extensions?: Record<string, unknown>;
    extras?: Record<string, unknown>;
  } | null | undefined>;
  meshes?: Array<{ primitives?: unknown[] } | null | undefined>;
}

/** `parent[i]`: `-1` top level, `-2` not reachable from the scene. */
export function sceneParents(json: MigrationGltfJson): number[];
export function rawAuthoredPaths(json: MigrationGltfJson, parent: ArrayLike<number>): Array<string | undefined>;
export function pathsFromNames(names: ArrayLike<string | undefined>, parent: ArrayLike<number>): Array<string | undefined>;
/** Node index of the content root (`-1` = the scene). */
export function contentRootOf(json: MigrationGltfJson): number;
export function indexPaths(paths: ArrayLike<string | undefined>): Map<string, number>;
export function isReferenceNodeJson(node: unknown): boolean;
export function insideReferenceJson(json: MigrationGltfJson, parent: ArrayLike<number>, i: number): boolean;

export type MigrationKind = 'ref' | 'path' | 'name';

export interface EnumeratedReference {
  componentType: string;
  /** Location label (`steps[0].targetObjects[1]`). */
  field: string;
  path: string;
  kind: MigrationKind;
  refType?: string;
}

/** Location label of one visited position (`steps[0].targetObjects[1]`; a name field: its field). */
export function referenceFieldLabel(r: { kind: string; field: string; trail: ReadonlyArray<string | number> }): string;

export function enumerateReferences(extras: Record<string, unknown> | null | undefined): EnumeratedReference[];
/** `listReferrers` without the list: `fn(idx, extras)` per referrer, in the same order. */
export function forEachReferrer(
  json: MigrationGltfJson,
  parent: ArrayLike<number>,
  isForeign: (i: number) => boolean,
  fn: (idx: number, extras: Record<string, unknown>) => void,
): void;
export function listReferrers(
  json: MigrationGltfJson,
  parent: ArrayLike<number>,
  isForeign: (i: number) => boolean,
): Array<{ idx: number; extras: Record<string, unknown> }>;

/** Migration verdict of one written path / name. `idx -1` = the scene (model root). */
export type MigrationVerdict =
  | { via: string; idx: number; reason?: undefined }
  | { via: 'unresolved'; reason: 'missing' | 'ambiguous'; idx?: undefined }
  | { via: 'empty'; idx?: undefined; reason?: undefined };

export interface MigrationContextOptions {
  parent?: ArrayLike<number>;
  legacyPaths?: ArrayLike<string | undefined> | null;
  /**
   * Loader name per node index (the legacy paths = these joined along `parent`); an
   * array or a function returning one, called only when a lookup reaches the legacy
   * step (plan-769 9.15). Ignored when `legacyPaths` is given.
   */
  legacyNames?: ArrayLike<string | undefined> | (() => ArrayLike<string | undefined>) | null;
  /** The loader name of ONE node index, asked only for the nodes a legacy lookup visits (wins over `legacyNames`). */
  legacyNameOf?: ((i: number) => string | undefined) | null;
  legacyRootName?: string;
  /** The file's content root when the caller computed it (`contentRootOf` of the same file). */
  contentRoot?: number;
}

export interface MigrationContext {
  parent: ArrayLike<number>;
  /** The full-path tables below are built on first read (plan-769 9.15). */
  raw: Array<string | undefined>;
  authored: Map<string, number>;
  legacy: Map<string, number> | null;
  legacyPaths: ArrayLike<string | undefined> | null;
  /** Content root (`-1` = the scene). */
  U: number;
  sceneName: string;
  rootNames: Set<string>;
  lookIn(index: Map<string, number>, p: string, base: ArrayLike<string | undefined>): { idx: number; step: string } | null;
  /** Raw authored path of one node index (`undefined` = unreachable) — without building `raw`. */
  rawPathOf(i: number): string | undefined;
  migratePath(written: string): MigrationVerdict;
  migrateName(name: string, owner: number): MigrationVerdict;
}

export function createMigrationContext(json: MigrationGltfJson, opts?: MigrationContextOptions): MigrationContext;

export interface MigrationEntry extends EnumeratedReference {
  /** Referrer node index, `-1` = the scene. */
  referrer: number;
  mig: MigrationVerdict;
}

export function migrateFileReferences(
  json: MigrationGltfJson,
  opts?: MigrationContextOptions,
): { ctx: MigrationContext; entries: MigrationEntry[] };
