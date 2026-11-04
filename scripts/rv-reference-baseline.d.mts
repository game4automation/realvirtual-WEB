// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-reference-baseline.mjs (plan-769 Phase 0). */

export interface ReferenceBaselineEntry {
  referrer: string;
  component: string;
  field: string;
  kind: 'ref' | 'path' | 'name';
  path: string;
  stage: string;
  todayTarget: string | null;
  via: string;
  target?: string;
  reason?: 'missing' | 'ambiguous';
  guessOnly?: true;
  disagree?: true;
}

export interface ReferenceBaselineGlb {
  nodes: number;
  reachable: number;
  seed: Record<string, unknown> & { seedMs: number };
  refs: Record<string, unknown>;
  refsDigest: string;
  guessOnlyByComponent: Record<string, number>;
  signals: { total: number; explicitName: number; nameFollowsNode: number };
  overrides: { byNodeId: number; byPath: number; trsByNodeId: number };
  entries: ReferenceBaselineEntry[];
}

/** The parsed JSON chunk of a GLB (BIN chunk never read). */
export function readGlbJson(file: string): { json: any; bytes: number; jsonSha1: string };

/** Every stored reference of one extras bag. */
export function enumerateReferences(extras: unknown): Array<{ componentType: string; field: string; path: string; kind: 'ref' | 'path' | 'name'; refType?: string }>;

/** JSON mirror of `unwrapGltfRoot`: node index of the content root, `-1` = the scene. */
export function contentRootOf(json: unknown): number;

/** Analysis of one glTF JSON. */
export function analyseGlb(json: unknown, opts?: { entries?: 'all' | 'nontrivial' | 'none' }): ReferenceBaselineGlb;

/** `AssetOverrides` entry counts anywhere below `root`. */
export function countOverrides(root: unknown): { byNodeId: number; byPath: number; trsByNodeId: number };

/** Files with extension `ext` below `dir` that git tracks (disk walk outside a work tree), absolute, sorted. */
export function listBaselineFiles(dir: string, ext: string): string[];

/** Snapshot label of a file: `public:<path>` / `private:<path>`, forward slashes, relative to its repo. */
export function labelOf(file: string): string;

/** The whole baseline over `roots`. */
export function runBaseline(roots: string[], opts?: { entries?: 'all' | 'nontrivial' | 'none'; quiet?: boolean }): {
  tool: string;
  plan: number;
  entries: string;
  perCustomer: Record<string, Record<string, number>>;
  glbs: Record<string, ReferenceBaselineGlb & { bytes: number; jsonSha1: string }>;
  jsonOverrides: Record<string, { byNodeId: number; byPath: number; trsByNodeId: number }>;
  errors: Record<string, string>;
};

/** Private labels public tests read by key; every other `private:` entry is withheld from the public fixture. */
export const PUBLIC_PINNED_LABELS: string[];

/** Default path of the withheld part (`<private sibling>/tests/fixtures/reference-baseline.private.json`). */
export const PRIVATE_SNAPSHOT_FILE: string;

/** Split a baseline into the public fixture and the private supplement (see the script). */
export function splitSnapshot<T extends ReturnType<typeof runBaseline>>(result: T): {
  public: Omit<T, never>;
  private: Omit<T, never> & { _comment: string };
};
