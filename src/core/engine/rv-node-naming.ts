// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The ONE naming convention for sibling-unique node names (plan-758).
 *
 * `Belt`, `Belt_1`, `Belt_2` — the first free name wins, counting from 1. The
 * same trailing `_<digits>` block is what three.js' `GLTFLoader` appends when
 * it de-duplicates node names, what the asset editor gives split / merged
 * parts, and what `behaviors.ts` strips to recover an asset name from a placed
 * root. Every producer of such a name goes through this module so the rule
 * cannot drift between the planner, the asset editor and the loader.
 *
 * Two entry points, deliberately separate:
 *
 * - {@link uniqueName} NEVER strips. A fresh placement of a catalog entry
 *   named `Conveyor_2000` stays `Conveyor_2000`; an asset-editor base such as
 *   `Housing_part2` keeps its digits; a record-driven path (reload, undo/redo)
 *   never derives at all.
 * - {@link copyName} is the ONLY strip site: the name of a COPY of `Belt_2` is
 *   derived from the base `Belt`, so ten copies read `Belt`, `Belt_1` … `Belt_9`
 *   instead of `Belt_2_1`, `Belt_2_1_1` — the accumulation this module replaces
 *   (formerly `Belt (copy) (copy)`).
 *
 * The strip is the last block only, never recursive: `Belt_1_2` → `Belt_1`.
 * Legacy names carrying ` (copy)` are not recognised (decision 6 of plan-758):
 * a copy of `Belt (copy)` is `Belt (copy)_1`.
 */

/** The dedup-suffix convention: a trailing `_<digits>` block. */
export const DEDUP_SUFFIX_RE = /_\d+$/;

/** Fallback when a caller hands in an empty or whitespace-only base. */
export const EMPTY_NAME_FALLBACK = 'Object';

/** `'Belt_2'` → `'Belt'`; `'Belt_1_2'` → `'Belt_1'` (last block only); `'Belt'` → `'Belt'`. */
export function stripDedupSuffix(name: string): string {
  return name.replace(DEDUP_SUFFIX_RE, '');
}

/**
 * `base` if it is not taken, else `base_1`, `base_2`, … — the FIRST free one,
 * not max+1 (a gap left by a deleted sibling is filled). Never strips. An
 * empty / whitespace base becomes {@link EMPTY_NAME_FALLBACK} so no caller can
 * produce a nameless node.
 */
export function uniqueName(taken: ReadonlySet<string>, base: string): string {
  const b = base.trim() || EMPTY_NAME_FALLBACK;
  if (!taken.has(b)) return b;
  for (let n = 1; ; n++) {
    const candidate = `${b}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The name for a COPY of `sourceName`: strip the source's own dedup suffix,
 * then take the first free name in the same family. The only place a suffix
 * is ever stripped before naming.
 */
export function copyName(taken: ReadonlySet<string>, sourceName: string): string {
  return uniqueName(taken, stripDedupSuffix(sourceName));
}

/** The minimal shape of a parent whose children carry names (duck-typed, no three.js import). */
export interface NamedParent {
  readonly children: readonly { readonly name: string }[];
}

/**
 * The sibling scope: the names of `parent.children`, minus `exclude` (the node
 * being named, when it is already attached). A `null` parent yields an empty
 * set, so a caller without a scope still gets a well-formed name.
 */
export function siblingNames(parent: NamedParent | null | undefined, exclude?: object): Set<string> {
  const out = new Set<string>();
  if (!parent) return out;
  for (const child of parent.children) {
    if (child !== exclude) out.add(child.name);
  }
  return out;
}
