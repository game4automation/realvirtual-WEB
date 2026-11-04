// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export interface PublishArguments {
  help: boolean;
  list: boolean;
  project: string | null;
  projectsDir: string | null;
  /** plan-778: every `--library <projectId>=<folder>`. */
  libraries: Record<string, string>;
  /** false with `--no-build`: publish the existing `dist/`. */
  build: boolean;
  dryRun: boolean;
  force: boolean;
}

/** One discovered project: its manifest, its folder name and the absolute folder. */
export interface DiscoveredProject {
  project: { name: string; code: string; [key: string]: unknown };
  projectDir: string;
  folderName: string;
}

/** A staged file as `collectLocalFiles` reports it. */
export interface StagedFile {
  abs: string;
  rel: string;
  size: number;
}

/** Fills `env` from `.env` in this folder and in the workspace root; shell values win. */
export function loadDotEnv(root?: string, env?: Record<string, string | undefined>): Record<string, string | undefined>;
export function parsePublishArguments(argv: string[]): PublishArguments;
export function resolveProjectsDir(options?: {
  projectsDir?: string | null;
  env?: Record<string, string | undefined>;
  root?: string;
}): string;
export function pickProject(projects: DiscoveredProject[], wanted: string): DiscoveredProject;
/**
 * Project documents whose `sha256` differs from the published manifest, as staging-relative
 * paths (`p/<path>`). A null/unparsable remote manifest forces every document.
 */
export function changedProjectDocuments(
  localManifestText: string,
  remoteManifestText: string | null | undefined,
): string[];
/** Project bytes first, `index.html` last — the ordering contract, as a sort. */
export function orderForUpload(files: StagedFile[]): StagedFile[];
export function publishedUrl(code: string, options?: {
  zone?: string;
  env?: Record<string, string | undefined>;
}): string;
