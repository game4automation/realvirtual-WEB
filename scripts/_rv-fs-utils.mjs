// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _rv-fs-utils — neutral filesystem and glob helpers shared by the delivery
 * tooling (plan-700 §2.9).
 *
 * ## Why this file exists at all
 *
 * The guard logic (secret patterns, artefact denylists, project-key discovery)
 * has to become one source of truth, because four copies of it had already
 * started to drift. But every one of those guards walks a tree, and `walk()`
 * lived module-private in `_workspace-lib.mjs`, where ten other call sites
 * (staging, doc-link checking, `hashTree`) still need it.
 *
 * Moving only the guards would have produced either an import cycle
 * (`_rv-guards` → `_workspace-lib` → `_rv-guards`) or a second copy of `walk()`
 * — exactly the duplication the consolidation is meant to end. So the neutral
 * helpers move out first, and `_rv-guards.mjs` and `_workspace-lib.mjs` both
 * import from here. Neither imports the other.
 *
 * Nothing in this module knows about projects, customers, secrets or delivery.
 * Keep it that way: the moment it does, the cycle is back.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { join } from 'node:path';

//! Normalises Windows separators so every reported path is stable across OSes.
export function toPosix(path) {
  return path.split(/[\\/]/).join('/');
}

//! Reads and parses a JSON file, naming the file in the failure message.
export function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${label}: ${error?.message ?? error}`);
  }
}

/**
 * Depth-first tree walk. The visitor receives `(absolute, relativePath, entry)`
 * and may return `false` for a directory to skip its subtree.
 *
 * A missing root is not an error: callers routinely probe for optional folders,
 * and forcing every one of them to guard the call adds noise, not safety.
 */
export function walk(root, visitor, relativeRoot = root) {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    const relativePath = toPosix(relative(relativeRoot, absolute));
    const descend = visitor(absolute, relativePath, entry);
    if (entry.isDirectory() && descend !== false) walk(absolute, visitor, relativeRoot);
  }
}

/**
 * Compiles a delivery glob to a RegExp.
 *
 * `**` crosses path separators, a single `*` does not; everything else is
 * literal. This is the one glob dialect the delivery tooling speaks — the
 * vendor globs in `project.json` are read with exactly this function, so what
 * a human writes in a manifest and what the tier manifest matches cannot drift.
 */
export function globRegex(pattern) {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(source + '$');
}

//! The literal path prefix of a glob, i.e. everything before its first wildcard.
export function fixedPrefix(pattern) {
  const wildcard = pattern.search(/[?*]/);
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/$/, '');
}

//! True when two globs can ever match the same path (used to reject ambiguous rules).
export function patternsOverlap(a, b) {
  if (a === b) return true;
  const aPrefix = fixedPrefix(a);
  const bPrefix = fixedPrefix(b);
  if (!aPrefix || !bPrefix) return true;
  return aPrefix === bPrefix
    || aPrefix.startsWith(`${bPrefix}/`)
    || bPrefix.startsWith(`${aPrefix}/`);
}
