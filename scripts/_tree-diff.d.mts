// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `_tree-diff.mjs` (plan-738 Phase 2).
 *
 * Required because the node tests import the module statically from TypeScript;
 * without a declaration `npx tsc --noEmit` fails with TS7016. Keep in step with
 * the .mjs by hand — nothing checks that the two agree.
 */

export interface TreeDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export function fingerprintTree(root: string): Map<string, string>;
export function diffTrees(currentRoot: string, incomingRoot: string): TreeDiff;
export function diffSize(diff: TreeDiff): number;
export function printDiff(
  header: string,
  diff: TreeDiff,
  options?: {
    removedNote?: string;
    log?: (line: string) => void;
    include?: Array<'added' | 'changed' | 'removed'>;
  },
): number;
