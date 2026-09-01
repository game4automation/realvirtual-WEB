// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for `patch-vendor-handover-connect.mjs` (plan-725 Phase 6). */

export type PatchStatus = 'patched' | 'unchanged' | 'refused';
export type PatchDirStatus = PatchStatus | 'skipped';

export interface PatchResult {
  status: PatchStatus;
  /** Present only for `patched` and `unchanged`. */
  manifest?: Record<string, any>;
  added: string[];
  /** Candidate globs left out because `vendor.managed` does not claim their zone. */
  skipped: string[];
  reason?: string;
}

export interface PatchDirResult {
  status: PatchDirStatus;
  added: string[];
  skipped: string[];
  reason?: string;
  before?: string;
  after?: string;
  diff: string[];
  /** True when writing would also normalise the manifest to canonical 2-space JSON. */
  reformats?: boolean;
}

export function zoneOf(glob: unknown): string | null;
export function applicableGlobs(managed: unknown): string[];
export function patchManifest(manifest: unknown): PatchResult;
export function compactDiff(before: string, after: string): string[];
export function patchProjectDir(projectDir: string, options?: { apply?: boolean }): PatchDirResult;
export function patchProjectsRoot(
  projectsRoot: string, options?: { apply?: boolean },
): Array<PatchDirResult & { project: string }>;
