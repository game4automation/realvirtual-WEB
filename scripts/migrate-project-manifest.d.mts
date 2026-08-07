// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for `migrate-project-manifest.mjs` (see `_rv-guards.d.mts`). */

export interface RvSceneIndexEntry {
  id: string;
  name: string;
  path: string;
}

export interface MigrateContext {
  folderName?: string;
  scenes?: RvSceneIndexEntry[];
  now?: string;
  mintId?: () => string;
}

export interface MigrateResult {
  manifest: Record<string, any>;
  changes: string[];
}

export type MigrateStatus = 'migrated' | 'unchanged' | 'reformatted' | 'skipped';

export interface MigrateDirResult {
  status: MigrateStatus;
  changes: string[];
  reason?: string;
  before?: string;
  after?: string;
}

export function canonicalNameOf(name: string): string;
export function newProjectId(): string;
export function migrateManifest(manifest: unknown, context?: MigrateContext): MigrateResult;
export function discoverScenes(projectDir: string): RvSceneIndexEntry[];
export function migrateProjectDir(
  projectDir: string, options?: { apply?: boolean; now?: string; mintId?: () => string },
): MigrateDirResult;
export function migrateProjectsRoot(
  projectsRoot: string, options?: { apply?: boolean; now?: string; mintId?: () => string },
): Array<MigrateDirResult & { project: string }>;
