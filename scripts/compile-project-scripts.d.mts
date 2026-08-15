// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for `compile-project-scripts.mjs` (see `_rv-guards.d.mts`). */

export type CompileEntryStatus = 'built' | 'current' | 'stale' | 'prebuilt' | 'failed';

export interface CompileEntryResult {
  ref: string;
  out?: string;
  status: CompileEntryStatus;
  reason?: string;
  warnings?: string[];
}

export interface CompileProjectResult {
  status: 'ok' | 'stale' | 'failed' | 'skipped';
  reason?: string;
  results: CompileEntryResult[];
}

export const EXTERNAL_PACKAGES: string[];
export function scriptRefsOf(manifest: unknown): string[];
export function outputRefOf(scriptRef: string): string | null;
export function isStale(srcPath: string, outPath: string): boolean;
export function compileProjectDir(
  projectDir: string, options?: { check?: boolean },
): Promise<CompileProjectResult>;
export function projectDirsUnder(root: string): string[];
