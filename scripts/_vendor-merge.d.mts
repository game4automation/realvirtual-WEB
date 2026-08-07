// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_vendor-merge.mjs`.
 *
 * Required: the merge tests import the module statically from TypeScript, and
 * without a declaration `npx tsc --noEmit` fails with TS7016 (review finding
 * T2). Keep in step with the .mjs by hand — nothing checks the two agree.
 */

/** `path -> git blob OID`. A path absent from the map does not exist on that side. */
export type BlobOidMap = Record<string, string>;

export interface RvVendorGlobs {
  managed?: string[];
  handover?: string[];
}

export type MergeActionValue =
  | 'add' | 'update' | 'noop' | 'delete' | 'keep-customer' | 'keep-deleted' | 'add-pending';

export type ConflictReasonValue =
  | 'both-changed' | 'added-both-sides' | 'deleted-by-vendor-changed-by-customer'
  | 'deleted-by-customer' | 'missing-without-baseline';

export interface MergeConflict {
  path: string;
  reason: ConflictReasonValue;
  /** True when the new vendor version should be parked beside the customer's. */
  sidecar: boolean;
}

export interface MergeResult {
  actions: Record<string, MergeActionValue>;
  conflicts: MergeConflict[];
  baselineMissing: boolean;
}

export interface MergeInput {
  baseline: BlobOidMap | null;
  customer: BlobOidMap;
  staged: BlobOidMap;
  vendorGlobs?: RvVendorGlobs | null;
  remoteEmpty?: boolean;
  seedMissing?: boolean;
  /** Paths the customer kept in an earlier conflict; still theirs. */
  customerOwned?: string[];
}

export function nextCustomerOwned(previous: string[] | undefined, result: MergeResult): string[];

export const PATH_CLASS: { readonly vendor: 'vendor'; readonly customer: 'customer' };
export const MERGE_ACTION: Readonly<Record<string, MergeActionValue>>;
export const CONFLICT_REASON: Readonly<Record<string, ConflictReasonValue>>;
export const DELIVERY_MANIFEST_VERSION: number;

export function classifyPath(relPath: string, vendorGlobs?: RvVendorGlobs | null): 'vendor' | 'customer';
export function mergeVendorTree(input: MergeInput): MergeResult;

export function isSidecarPath(relPath: string): boolean;
export function sidecarPathFor(relPath: string, version: string): string;
export function sidecarIsSafe(
  relPath: string, sidecarPath: string, attributeOf: (path: string) => string | null,
): boolean;
export function parseCheckAttr(output: string): string | null;

export interface ManifestMergeResult {
  merged: Record<string, any> | null;
  unreadable: boolean;
  changed: string[];
}
export function mergeProjectManifest(
  customerManifest: unknown, vendorManifest: unknown, vendorGlobs?: RvVendorGlobs | null,
): ManifestMergeResult;

export function baselineTagFor(version: string): string;
export function readDeliveryManifest(raw: unknown): {
  manifestVersion: number;
  baselineTag: string | null;
  projects: Record<string, any>;
  [key: string]: unknown;
};
export function withDeliveryBaseline(
  base: Record<string, any>,
  options: { version: string; projects: Record<string, any> },
): Record<string, any>;

export function parseLsFiles(output: string): BlobOidMap;
export function parseLsTree(output: string): BlobOidMap;
export function projectSubtree(map: BlobOidMap, projectKey: string): BlobOidMap;
export function summariseMerge(result: MergeResult): {
  add: number; update: number; delete: number; keepCustomer: number;
  keepDeleted: number; addPending: number; noop: number; conflicts: number;
};
