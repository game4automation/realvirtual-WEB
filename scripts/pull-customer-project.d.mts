// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `pull-customer-project.mjs`.
 *
 * Required because tests/pull-customer-project.node.test.ts imports the module
 * statically from TypeScript; without a declaration `npx tsc --noEmit` fails with
 * TS7016. Keep in step with the .mjs by hand — nothing checks that the two agree.
 */

export interface PullDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export function fingerprintTree(root: string): Map<string, string>;
export function diffTrees(internalRoot: string, incomingRoot: string): PullDiff;
export function assertIncomingTreeIsSafe(root: string, label: string): void;
export function copyCustomerProject(source: string, destination: string): void;
export function backupInternalProject(internalRoot: string, projectKey: string): string;
export function pullCustomerProject(options: {
  projectKey: string;
  remote: string;
  apply?: boolean;
  internalRoot?: string | null;
}): Promise<{ applied: boolean; diff: PullDiff; backup: string | null }>;
