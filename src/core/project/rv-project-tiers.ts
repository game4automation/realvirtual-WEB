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
 *    tier — the same semantics `SceneStore.materializePublishedExample` has, which is
 *    also why importing an example materialises a document rather than sharing
 *    the bundled one (plan-716 F1).
 *  3. A fork records `forkedFrom`, so the UI can say "based on Sample/Demo".
 *  4. The tiers share no storage. Swapping the whole bundled tier touches not
 *    one user key.
 *
 * Deletion follows from that: a bundled entry cannot be deleted, only
 * **hidden** (otherwise a customer could never get the shipped demos out of
 * their view). Deleting a fork removes the fork; the original comes back.
 */

import type {
  RvDocumentEntry,
  RvProject,
  RvProjectAssetEntry,
} from './rv-project-types';

/** Which level an entry came from. */
export type ProjectTier = 'bundled' | 'user';

// `TieredSceneEntry`, `mergeSceneTiers` and `forkSceneEntry` are GONE
// (plan-716 Phase 6). They were the scene-shaped third of a three-way merge that
// has been one merge since plan-413: `mergeDocumentTiers` below does the same
// job over `documents[]`, which is the only artefact list left. Nothing read the
// scene half any more — the dashboard, the catalog feed and both MCP families
// were moved off it in Phase 5 — so what remained was a second answer to a
// question with one answer. `tests/document-tiers-scan.test.ts` covers the
// surviving merge.

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
  /**
   * Every string a fork's `forkedFrom` may name this bundled entry by.
   *
   * Scenes record the origin's **id**, assets its **path** — and a document is
   * both at once, so keying a document merge on one of them alone would make
   * exactly half the existing forks stop shadowing their originals. Defaults to
   * the primary key, which is what the two legacy merges have always used.
   */
  aliasesOf: (e: E) => readonly string[] = e => [keyOf(e)],
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
    let shadow = userByKey.get(key);
    if (!shadow) {
      for (const alias of aliasesOf(b)) {
        if (!alias) continue;
        shadow = userByOrigin.get(alias);
        if (shadow) break;
      }
    }
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

// ─── Documents (plan-413 §2.4) ──────────────────────────────────────────

export type TieredDocumentEntry = RvDocumentEntry & {
  tier: ProjectTier;
  forkedFrom?: string;
};

/**
 * The one merge. It replaced a scene-shaped and an asset-shaped variant; only
 * {@link mergeAssetTiers} is still around, for the models list.
 *
 * Same algorithm, one key rule: `id` when the entry has one, `path` otherwise —
 * `assetEntryKey()` semantics, which is what makes a document minted from an
 * id-less asset entry keep answering to the path it was addressed by. A fork's
 * `forkedFrom` is looked up under **both**, because the two legacy merges
 * recorded two different things there and neither may stop working
 * (`document-tiers-scan.test.ts` is the regression anchor).
 *
 * The section is deliberately NOT part of the key. Ids are unique across the
 * project, and a document that changes section — a library asset promoted to a
 * scene — is the same document, not a new one.
 */
export function mergeDocumentTiers(
  bundled: readonly RvDocumentEntry[],
  user: readonly RvDocumentEntry[],
  hidden: readonly string[] = [],
): MergedTiers<TieredDocumentEntry> {
  return mergeTiers(bundled, user, hidden, documentTierKey, documentTierAliases);
}

/** `id` when present, `path` otherwise. */
function documentTierKey(entry: RvDocumentEntry): string {
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  return id !== '' ? id : (typeof entry.path === 'string' ? entry.path : '');
}

function documentTierAliases(entry: RvDocumentEntry): string[] {
  const out: string[] = [];
  if (typeof entry.id === 'string' && entry.id.trim() !== '') out.push(entry.id.trim());
  if (typeof entry.path === 'string' && entry.path !== '') out.push(entry.path);
  return out;
}

/**
 * Fork a bundled document into the user tier.
 *
 * The fork gets a
 * **new id** so the bundled original stays resolvable — the next release
 * re-reads it, and `forkedFrom` points back at it. Reusing the id would make the
 * original unreachable the moment somebody edits it.
 */
export function forkDocumentEntry(
  entry: RvDocumentEntry,
  newId: string,
  overrides: Partial<RvDocumentEntry> = {},
): TieredDocumentEntry {
  return {
    ...entry,
    ...overrides,
    id: newId,
    forkedFrom: documentTierKey(entry),
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
