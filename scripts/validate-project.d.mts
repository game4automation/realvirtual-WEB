// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `validate-project.mjs`.
 *
 * Required because the Node tests import the module statically from TypeScript;
 * without it `npx tsc --noEmit` fails with TS7016. Keep in step with the .mjs —
 * there is no compiler check tying the two together.
 */

export interface ProjectValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Workspace mode ids a `documents[].modes` entry may name. */
export const KNOWN_WORKSPACE_MODES: string[];
/** plan-778: library resolution options (see validate-project.mjs). */
export interface ProjectValidationOptions {
  /** The folder is a delivered / packed copy: qualified references must resolve in its own libraries/. */
  delivered?: boolean;
  /** A source project's library sources: by id in a projects folder, or an explicit map. */
  librarySources?: { projectsDir?: string | null; libraries?: Record<string, string> } | null;
  /** The app-level realvirtual library folder, to check references into it. */
  realvirtualLibraryDir?: string | null;
}
export function validateProject(root: string, opts?: ProjectValidationOptions): ProjectValidationResult;
export function assertValidProject(root: string, label?: string, opts?: ProjectValidationOptions): ProjectValidationResult;
