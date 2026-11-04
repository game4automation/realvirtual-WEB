// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `experiment-cut-guard.mjs` (plan-2211 Phase 0).
 *
 * Required because the node test imports the module statically from TypeScript;
 * without a declaration `npx tsc --noEmit` fails with TS7016. Keep in step with
 * the .mjs by hand.
 */

export interface CutListEntry {
  path: string;
  action: 'move' | 'split' | string;
  [key: string]: unknown;
}

export interface CutList {
  paths: CutListEntry[];
  forbiddenMarkers: string[];
  [key: string]: unknown;
}

export interface CutViolation {
  check: 'a' | 'b' | 'c' | 'd';
  file: string;
  line?: number;
  target?: string;
  message: string;
}

export interface ImportEdge {
  file: string;
  line: number;
  target: string;
  spec: string;
}

export function filesUnder(dir: string): string[];
export function matchesPath(path: string, pattern: string): boolean;
export function importEdges(root: string, dirs?: string[]): ImportEdge[];
export function isListed(target: string, entries: CutListEntry[]): boolean;
export function checkCut(options: { publicRoot: string; privateRoot?: string; list?: CutList }): CutViolation[];
