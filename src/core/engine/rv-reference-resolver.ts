// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-resolver.ts — THE resolver of an authored path inside an asset
 * (plan-757 F7 / D12). One function, used by `prepare` (the pre-bake registry
 * over the raw tree: hooks, survival model, plugin claims) and by the runtime
 * (`NodeRegistry.resolve()` for every ComponentReference, `AssetOverrides.byPath`,
 * the MCP fan-out) — so what resolves before the bake is exactly what resolves
 * after it, for the main model and for every placement alike.
 *
 * A reference is stored ASSET-RELATIVE (`Mount/Kine`, no root segment). Older
 * files — every Unity export — spell it ROOT-INCLUSIVE (`Machine/Mount/Kine`).
 * Both are read, in exactly this order (§2.3):
 *
 *  1. the path as written, inside the asset scope — `<rootPath>/<path>`;
 *  2. else, if the first segment equals the asset root's authored or current
 *     name, strip it and resolve `<rootPath>/<rest>`;
 *  3. else unresolved — reported by the caller, never guessed.
 *
 * The order makes a real child named like the root unambiguous: fixture (i),
 * `Conveyor/Conveyor/Belt`, resolves in step 1 (through the renamed-node alias
 * the loader registers for the `Conveyor_1` child) before step 2 could strip
 * the segment and land on the root's own `Belt`.
 *
 * `rootPath` is the scope root's OWN registry path: `Machine` for the main model
 * (the loader stages `tmp` under an unrendered parent, and `computeNodePath`
 * spells the root itself), `Layout/Arburg_1` for a placement, `''` for a
 * parentless tree (the model cache's decode). The lookup's own stages (exact,
 * alias, sanitized) apply to the joined path; a bare suffix stage cannot fire
 * on a scope-prefixed query, which is what stops ten placements from resolving
 * each other's axes.
 *
 * Without a scope (a caller that has no asset to be relative to) the path is
 * looked up as written against the whole registry — the pre-plan behaviour.
 *
 * Engine data only: no viewer, plugin or HMI import (the recipe imports this).
 */

import type { Object3D } from 'three';
import { sanitizeLikeThree } from './rv-three-names';

/** The one lookup this resolver needs — `NodeRegistry` satisfies it. */
export interface PathLookup {
  getNode(path: string): Object3D | null;
}

/** Where a reference was authored: the asset it is relative to. */
export interface ReferenceScope {
  /** The asset root (main model root, placement root, or `tmp` during `prepare`). */
  root: Object3D;
  /** The root's own path in the lookup — `''` when the root is the lookup's origin. */
  rootPath: string;
  /**
   * Every name the root is or was known by: its current name, the authored
   * (pre-dedup) name, the baked template's name for a placement whose reference
   * node the planner renamed (`Arburg_1` places `Arburg`). Compared exactly and
   * in Three.js' sanitized spelling.
   */
  rootNames: ReadonlySet<string>;
}

export type ReferenceResolutionStep = 'as-written' | 'root-stripped' | 'unscoped' | 'unresolved';

export interface ReferenceResolution {
  node: Object3D | null;
  step: ReferenceResolutionStep;
  /** The lookup key that hit (diagnostics / tests). */
  lookupPath: string | null;
}

const UNRESOLVED: ReferenceResolution = Object.freeze({ node: null, step: 'unresolved', lookupPath: null });

/** `<rootPath>/<rel>`; `rel` alone for a root at the origin; the root itself for an empty `rel`. */
export function joinScopePath(rootPath: string, rel: string): string {
  if (rel === '') return rootPath;
  return rootPath === '' ? rel : `${rootPath}/${rel}`;
}

/** Build a scope; `extraNames` are added to the root's current name. */
export function scopeOf(root: Object3D, rootPath: string, extraNames?: Iterable<string | undefined | null>): ReferenceScope {
  const names = new Set<string>();
  if (root.name) names.add(root.name);
  if (extraNames) for (const n of extraNames) if (n) names.add(n);
  return { root, rootPath, rootNames: names };
}

/** Is `node` `ancestor` or below it? */
export function isUnderScope(node: Object3D, ancestor: Object3D): boolean {
  for (let cur: Object3D | null = node; cur; cur = cur.parent) if (cur === ancestor) return true;
  return false;
}

/** Trim, strip a leading `/`, collapse `//`. */
function normalizePath(path: string): string {
  let p = path.trim();
  while (p.startsWith('/')) p = p.slice(1);
  return p.replace(/\/{2,}/g, '/');
}

function nameMatches(segment: string, names: ReadonlySet<string>): boolean {
  if (names.has(segment)) return true;
  const sanitized = sanitizeLikeThree(segment);
  for (const n of names) if (sanitizeLikeThree(n) === sanitized) return true;
  return false;
}

/**
 * Resolve `path` as authored inside `scope` — the three-step rule of the file
 * header. With `scope === null` the path is looked up as written against the
 * whole lookup (step `'unscoped'`).
 */
export function resolveReferencePath(
  lookup: PathLookup,
  path: string,
  scope: ReferenceScope | null | undefined,
): ReferenceResolution {
  const p = normalizePath(path);
  if (p === '') return UNRESOLVED;
  if (!scope) {
    const node = lookup.getNode(p);
    return node ? { node, step: 'unscoped', lookupPath: p } : UNRESOLVED;
  }

  // 1. as written, inside the scope.
  const asWritten = joinScopePath(scope.rootPath, p);
  let node = lookup.getNode(asWritten);
  if (node && (scope.rootPath === '' || isUnderScope(node, scope.root))) {
    return { node, step: 'as-written', lookupPath: asWritten };
  }

  // 2. root-prefixed: strip the root segment.
  const slash = p.indexOf('/');
  const first = slash === -1 ? p : p.slice(0, slash);
  if (nameMatches(first, scope.rootNames)) {
    const rest = slash === -1 ? '' : p.slice(slash + 1);
    if (rest === '') return { node: scope.root, step: 'root-stripped', lookupPath: scope.rootPath };
    const stripped = joinScopePath(scope.rootPath, rest);
    node = lookup.getNode(stripped);
    if (node && (scope.rootPath === '' || isUnderScope(node, scope.root))) {
      return { node, step: 'root-stripped', lookupPath: stripped };
    }
  }

  // 3. unresolved — the caller reports; nothing here guesses.
  return UNRESOLVED;
}

/**
 * The ASSET-RELATIVE spelling of a target path for a reference authored in
 * `scope` (D12: write relative). A path outside the scope — a reference into
 * another asset or the document — stays exactly as given.
 */
export function assetRelativePath(targetPath: string, scope: ReferenceScope): string {
  return relativeToRoot(targetPath, scope.rootPath);
}

/**
 * The same rule as {@link assetRelativePath} against a bare root path, for a
 * caller that has no {@link ReferenceScope} — the bake recipe, which knows its
 * `rootPath` long before a scope exists. ONE implementation of "write
 * relative" (plan-582 Phase 5): the recipe had a private copy without the
 * normalization, which is exactly how the two spellings drift apart.
 */
export function relativeToRoot(targetPath: string, rootPath: string): string {
  const p = normalizePath(targetPath);
  if (rootPath === '') return p;
  if (p === rootPath) return '';
  return p.startsWith(rootPath + '/') ? p.slice(rootPath.length + 1) : p;
}

/** One line for a report: what was looked for, in which scope. */
export function describeUnresolvedReference(path: string, scope: ReferenceScope | null | undefined): string {
  if (!scope) return `"${path}" resolves to no node`;
  const names = [...scope.rootNames].map((n) => `"${n}"`).join(', ');
  return `"${path}" resolves to no node inside "${scope.rootPath || scope.root.name}" (as written, or with a leading ${names} segment stripped)`;
}
