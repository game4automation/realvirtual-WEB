// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-tiers — the two levels every project has (§2.3).
 *
 * A project carries shipped demo content **and** user data at the same time,
 * and the two have opposite lifecycles: the shipped half is replaced wholesale
 * by the next release, the user half must survive forever.
 *
 * Seeding the demo content into user storage once would satisfy neither.
 * Whoever edits a demo scene keeps a stale fork for good, and new demos never
 * reach them. So the two stay separate and are merged for display:
 *
 * ```
 * bundled tier  ← re-read from the build/HTTP on every load, read-only
 * user tier     ← localStorage + OPFS (or the project folder), writable
 * ```
 *
 * Four properties hold, and the tests in §9.2 exist to keep them holding:
 *
 *  1. Both tiers appear in **one** list, each entry knowing its `tier`.
 *  2. A bundled entry is read-only. The first edit **forks** it into the user
 *    tier — the same semantics `SceneStore.addPublishedToMyScenes` has today.
 *  3. A fork records `forkedFrom`, so the UI can say "based on Sample/Demo".
 *  4. The tiers share no storage. Swapping the whole bundled tier touches not
 *    one user key.
 *
 * Deletion follows from that: a bundled entry cannot be deleted, only
 * **hidden** (otherwise a customer could never get the shipped demos out of
 * their view). Deleting a fork removes the fork; the original comes back.
 */

import type { RvProject, RvProjectAssetEntry, RvProjectSceneEntry } from './rv-project-types';

/** Which level an entry came from. */
export type ProjectTier = 'bundled' | 'user';

export type TieredSceneEntry = RvProjectSceneEntry & {
  tier: ProjectTier;
  /** Id of the bundled entry this user entry was forked from. */
  forkedFrom?: string;
};

export type TieredAssetEntry = RvProjectAssetEntry & {
  tier: ProjectTier;
  forkedFrom?: string;
};

/** Result of merging the two levels of one section. */
export interface MergedTiers<T> {
  /** What the UI renders, bundled-then-user order with user overrides applied. */
  entries: T[];
  /** Every id the project owns across both tiers, hidden ones excluded. */
  ids: Set<string>;
}

// ─── Merge ──────────────────────────────────────────────────────────────

/**
 * Merge the bundled and user scene lists into one display list.
 *
 * A user entry shadows a bundled one when it either **is** that id (the same
 * scene, saved into the user tier) or was **forked from** it. Shadowing keeps
 * the bundled entry's slot in the order, so a fork does not jump to the end
 * of the list the moment it is edited.
 */
export function mergeSceneTiers(
  bundled: readonly RvProjectSceneEntry[],
  user: readonly RvProjectSceneEntry[],
  hidden: readonly string[] = [],
): MergedTiers<TieredSceneEntry> {
  return mergeTiers(bundled, user, hidden, e => e.id);
}

/** Same merge for `models[]` / `library[]`, keyed on `path`. */
export function mergeAssetTiers(
  bundled: readonly RvProjectAssetEntry[],
  user: readonly RvProjectAssetEntry[],
  hidden: readonly string[] = [],
): MergedTiers<TieredAssetEntry> {
  return mergeTiers(bundled, user, hidden, e => e.path);
}

function mergeTiers<E extends Record<string, unknown>>(
  bundled: readonly E[],
  user: readonly E[],
  hidden: readonly string[],
  keyOf: (e: E) => string,
): MergedTiers<E & { tier: ProjectTier; forkedFrom?: string }> {
  const hiddenSet = new Set(hidden);
  const ids = new Set<string>();
  const out: Array<E & { tier: ProjectTier; forkedFrom?: string }> = [];

  const userByKey = new Map<string, E>();
  const userByOrigin = new Map<string, E>();
  for (const e of user) {
    const key = keyOf(e);
    if (key) userByKey.set(key, e);
    const origin = typeof e.forkedFrom === 'string' ? e.forkedFrom : null;
    if (origin) userByOrigin.set(origin, e);
  }

  const consumed = new Set<E>();
  for (const b of bundled) {
    const key = keyOf(b);
    if (!key) continue;
    const shadow = userByKey.get(key) ?? userByOrigin.get(key);
    if (shadow) {
      consumed.add(shadow);
      const shadowKey = keyOf(shadow);
      if (!hiddenSet.has(shadowKey)) {
        out.push({ ...shadow, tier: 'user' });
        ids.add(shadowKey);
      }
      // The shadowed bundled entry is still owned by the project — it is what
      // the fork points back at — but it is not shown twice.
      if (!hiddenSet.has(key)) ids.add(key);
      continue;
    }
    if (hiddenSet.has(key)) continue;
    out.push({ ...b, tier: 'bundled' });
    ids.add(key);
  }

  for (const u of user) {
    if (consumed.has(u)) continue;
    const key = keyOf(u);
    if (!key || hiddenSet.has(key)) continue;
    out.push({ ...u, tier: 'user' });
    ids.add(key);
  }

  return { entries: out, ids };
}

// ─── Fork ───────────────────────────────────────────────────────────────

/**
 * Fork a bundled scene entry into the user tier.
 *
 * The fork gets a **new id**: the bundled id must stay resolvable, because
 * the next release re-reads it and because `forkedFrom` points at it. Reusing
 * the id would make the original unreachable the moment someone edits it.
 */
export function forkSceneEntry(
  entry: RvProjectSceneEntry,
  newId: string,
  overrides: Partial<RvProjectSceneEntry> = {},
): TieredSceneEntry {
  return {
    ...entry,
    ...overrides,
    id: newId,
    forkedFrom: entry.id,
    tier: 'user',
  };
}

/** True when this entry may not be written to. */
export function isReadOnlyEntry(entry: { tier?: ProjectTier }): boolean {
  return entry.tier === 'bundled';
}

// ─── Hidden list ────────────────────────────────────────────────────────

/** The project's hidden ids, defensively normalised. */
export function hiddenIdsOf(project: RvProject | null): string[] {
  const raw = project?.hidden;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * Add an id to the hidden list. Returns a new project object — hiding is a
 * manifest edit and must go through the normal write path, not a mutation.
 */
export function withHidden(project: RvProject, id: string): RvProject {
  const current = hiddenIdsOf(project);
  if (current.includes(id)) return project;
  return { ...project, hidden: [...current, id] };
}

/** Remove an id from the hidden list. */
export function withoutHidden(project: RvProject, id: string): RvProject {
  const current = hiddenIdsOf(project);
  if (!current.includes(id)) return project;
  return { ...project, hidden: current.filter(v => v !== id) };
}
