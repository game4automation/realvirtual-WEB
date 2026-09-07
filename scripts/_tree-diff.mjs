// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _tree-diff — "what would change if I replaced this folder with that one".
 *
 * One filesystem comparison, used by both directions of the customer pipeline
 * (plan-738 Phase 2):
 *
 *   - `pull-customer-project.mjs` shows what an incoming customer tree would do
 *     to our internal project before it writes a single byte;
 *   - `previewProjectReplace()` in `_workspace-lib.mjs` shows what a
 *     `--projects` snapshot would do to the customer's folder before
 *     `applySnapshot()` deletes it.
 *
 * Both need exactly the same answer and used to be one private copy in the pull
 * script, which is why the delivery side had no preview at all. It lives here so
 * neither side can quietly grow its own dialect of "removed".
 *
 * Content hashes, not timestamps: a Git checkout has no meaningful mtimes, and a
 * freshly cloned tree has none at all that mean anything.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { walk } from './_rv-fs-utils.mjs';

//! Directories that are build output or Git metadata, never content to compare.
const SKIPPED_DIRECTORIES = ['.git', 'node_modules', 'dist'];

//! Reads a tree into `path -> sha256`, skipping build output and Git metadata.
//! A missing root is an empty map, never an error: "the folder is not there" and
//! "the folder is empty" mean the same thing to every caller here.
export function fingerprintTree(root) {
  const map = new Map();
  if (!existsSync(root)) return map;
  walk(root, (absolute, rel, entry) => {
    const first = rel.split('/')[0];
    if (entry.isDirectory()) return !SKIPPED_DIRECTORIES.includes(entry.name);
    if (first === '.git') return;
    map.set(rel, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
  });
  return map;
}

/**
 * Compares an incoming tree against the one that is there now.
 *
 * Returns added/changed/removed as plain path lists — the caller prints them and
 * decides. "Removed" is the interesting one in both directions: those are files
 * that exist in `currentRoot` and would disappear, which is exactly what nobody
 * saw before this was shown.
 */
export function diffTrees(currentRoot, incomingRoot) {
  const current = fingerprintTree(currentRoot);
  const incoming = fingerprintTree(incomingRoot);
  const added = [];
  const changed = [];
  const removed = [];
  for (const [path, hash] of incoming) {
    if (!current.has(path)) added.push(path);
    else if (current.get(path) !== hash) changed.push(path);
  }
  for (const path of current.keys()) if (!incoming.has(path)) removed.push(path);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

//! Total number of differing paths in a diff.
export function diffSize(diff) {
  return diff.added.length + diff.changed.length + diff.removed.length;
}

/**
 * Prints a diff in the `+ / ~ / -` shape both callers use, and returns its size.
 *
 * `removedNote` is appended to every removal line, because what a disappearing
 * file MEANS differs by direction — it vanishes from our repository on a pull,
 * and from the customer's on a delivery — while the shape of the list does not.
 * `include` restricts the list without changing the counts in the header: the
 * delivery preview shows only what it would destroy, and the header still has to
 * say how much of the folder it is about to rewrite.
 */
export function printDiff(header, diff, { removedNote = '', log = console.log, include = ['added', 'changed', 'removed'] } = {}) {
  const total = diffSize(diff);
  log(`${header}: +${diff.added.length} neu  ~${diff.changed.length} geaendert  -${diff.removed.length} entfernt`);
  if (include.includes('added')) for (const path of diff.added) log(`  +  ${path}`);
  if (include.includes('changed')) for (const path of diff.changed) log(`  ~  ${path}`);
  if (include.includes('removed')) for (const path of diff.removed) log(`  -  ${path}${removedNote}`);
  if (!total) log('  (keine Unterschiede)');
  return total;
}
