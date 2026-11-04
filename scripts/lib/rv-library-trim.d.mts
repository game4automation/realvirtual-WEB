// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { LibraryTrimError as TrimError, LibraryTrimPlan } from '../../src/core/project/rv-library-trim-core.mjs';

export const DELIVERED_LIBRARIES_FOLDER: 'libraries';
export const REALVIRTUAL_LIBRARY_PROJECT_ID: 'prj_realvirtual_library';

export interface LibrarySources {
  projectsDir?: string | null;
  libraries?: Record<string, string>;
  /** The app-level realvirtual library folder (holds its project.json), to check references into it. */
  realvirtualLibraryDir?: string | null;
  /** Name used in error messages. */
  label?: string;
  /** Called per shipped library source folder before anything is copied; throw to abort the delivery. */
  verifySourceFolder?: (folder: string, projectId: string) => void;
}

export class LibraryTrimError extends Error {
  readonly code: 'LIBRARY_TRIM_FAILED';
  readonly errors: TrimError[];
  constructor(message: string, errors: TrimError[]);
}

export function parseLibrarySourceArgs(argv: string[]): { projectsDir: string | null; libraries: Record<string, string> };
export function librarySourceArgv(sources: LibrarySources | null | undefined): string[];
export function createLibrarySourceResolver(opts?: {
  projectsDir?: string | null;
  libraries?: Record<string, string>;
  ownLibrariesDir?: string | null;
}): ((projectId: string) => string | null) & { ambiguous(projectId: string): string[] };
export function readGlbJsonFile(path: string): Record<string, unknown> | null | undefined;
export function planProjectLibraries(projectDir: string, sources?: LibrarySources): LibraryTrimPlan;
export function trimProjectLibraries(
  projectDir: string,
  sources?: LibrarySources,
  opts?: { log?: ((line: string) => void) | null },
): { plan: LibraryTrimPlan; shipped: string[] };
