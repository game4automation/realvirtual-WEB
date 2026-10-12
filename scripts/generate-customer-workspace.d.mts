// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `generate-customer-workspace.mjs` (see `_rv-guards.d.mts`).
 *
 * The script had no sidecar until plan-479 Phase 7, because its only test
 * (`tests/customer-workspace.node.test.ts`) is one of the private excludes and
 * therefore never reached `tsc`. `compileStagedProjectScripts` is tested from a
 * public file, so the declaration is now needed — and only the exports a test
 * may reach are declared, not the module's private machinery.
 */

/** `--projects a b c`, `--projects a,b`, or both. `[]` when the flag is absent. */
export function listArg(args: string[], name: string): string[];

/**
 * Build the `.js` sibling of every `scriptRef` in the STAGED project copies.
 *
 * Rejects when any script fails to compile, which stops the delivery before
 * anything is committed or pushed.
 */
export function compileStagedProjectScripts(
  workspaceRoot: string,
  projectKeys: readonly string[],
): Promise<void>;

export function snapshotPush(options: {
  workspaceRoot: string;
  remote: string;
  version: string;
  plasticChangeset?: number | null;
  push?: boolean;
  coreRoot?: string | null;
  replaceProjects?: string[];
  force?: boolean;
  acceptNewPrivateFiles?: boolean;
}): {
  pushed: boolean;
  remote: string;
  message: string;
  snapshot: unknown;
  preview?: unknown;
  baselineTag?: string;
};
