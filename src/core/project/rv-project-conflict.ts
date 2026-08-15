// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-conflict — "who wins for this scene, the folder or the cache?"
 *
 * Pure decision function: no DOM, no handle, no storage. That is deliberate
 * (§4c) — the real File System Access path cannot be automated, so the part
 * that decides whether a user's work survives is kept where a test can reach
 * all of it.
 *
 * ## There used to be TWO cache states per scene (Blocker B3)
 *
 * `rv-scenes/<id>` holds the last **saved** record. A second slot,
 * `rv-scenes/scene-draft/<id>`, held the autosave of the working state, and
 * `openScene()` preferred it — so comparing only the saved record against the
 * folder had two failure modes, both fatal to user data. Since plan-413 phase 6
 * that slot has no writer and no reader (an autosave is a GLB body), so callers
 * pass `draft: null` and only the first of the two remains reachable. The
 * `draft` parameter stays because the comparison is still the honest place to
 * express "there is unsaved work", should a future one arrive:
 *
 *  1. Someone who edits but never presses Save has their work *only* in the
 *     draft. The saved record still carries the old `modifiedAt`, the naive
 *     comparison reports "folder is newer", and the folder version silently
 *     replaces work that was never even looked at. Hence: **a draft that
 *     differs from the saved record is always unsaved work, and always
 *     prompts** — never a silent overwrite, whatever the timestamps say.
 *  2. "Folder wins" that only rewrites `rv-scenes/<id>` is undone by the very
 *     next `openScene()`, which puts the stale draft back on top. Clearing the
 *     draft is therefore part of applying the decision, not an optional extra
 *     — see `ProjectStore._applyFolderScene`. Without it the rule is worse
 *     than useless, because it pretends to be correct.
 *
 * The cache timestamp is consequently `max(saved.modifiedAt, draft.modifiedAt)`
 * ({@link cacheModifiedAt}), never `saved.modifiedAt` alone.
 *
 * ## Content beats clocks
 *
 * `modifiedAt` is a *content* field written by `writeScene()`, not the
 * filesystem mtime, so a `git checkout` does not distort it. Two machines
 * with badly set clocks still can, and hydrating a scene bumps the cache
 * timestamp to "now" even though nothing changed. Whenever the caller can
 * supply the folder body, {@link resolveSceneConflict} compares content with
 * `scenesEqual()` (which ignores `modifiedAt` and the thumbnail) and answers
 * `equal` regardless of the timestamps. Clock drift is a named, accepted
 * residual risk: when in doubt this function prompts, it never discards.
 *
 * ## The four answers
 *
 * | result | meaning | caller does |
 * |---|---|---|
 * | `equal` | both sides carry the same scene | nothing |
 * | `folder-wins` | the folder is newer, and no unsaved cache work is at risk | overwrite the cache **and clear the draft** |
 * | `cache-wins` | the folder has nothing (yet) to offer | nothing; the next save writes it out |
 * | `prompt` | a human has to choose | ask, then apply the answer |
 */

import { scenesEqual, type RvScene } from '../hmi/scene/rv-scene-types';

// ─── Types ──────────────────────────────────────────────────────────────

export type SceneConflictResolution = 'folder-wins' | 'cache-wins' | 'equal' | 'prompt';

/**
 * What is known about the folder side of one scene.
 *
 * With lazy hydration the manifest entry (`modifiedAt`) is often all that has
 * been read; `scene` stays undefined until the caller actually needs the
 * body. Both fields absent means "the folder has nothing here".
 */
export interface FolderSceneState {
  /** `modifiedAt` from the manifest entry, or from the body when read. */
  modifiedAt?: string | null;
  /** The parsed body, when the caller has already read it. */
  scene?: RvScene | null;
  /**
   * Content revision of the folder body (SHA-256), when known (plan-397 §2.8).
   *
   * From `RvProjectSceneEntry.revision` or from a `SceneRecord` that was read.
   * It contributes **existence, not equality**: a manifest entry that carries
   * a revision proves the folder has a body here even when it carries no
   * `modifiedAt`, which is the shape a GLB entry has. What it is deliberately
   * *not* compared against is the recorded cache revision — see step 4 of
   * {@link resolveSceneConflict}.
   */
  revision?: string | null;
}

export interface SceneConflictInput {
  /** `rv-scenes/<id>` — the last saved record, or null when not cached. */
  saved: RvScene | null;
  /** `rv-scenes/scene-draft/<id>` — the autosaved working state, or null. */
  draft: RvScene | null;
  /** What the folder holds. Null when the manifest has no entry at all. */
  folder: FolderSceneState | null;
}

// ─── Helpers (exported: the caller builds prompt items from them) ────────

/** True when the draft carries edits the saved record does not have. */
export function hasUnsavedDraft(saved: RvScene | null, draft: RvScene | null): boolean {
  if (!draft) return false;
  return !scenesEqual(draft, saved);
}

/** The cache's effective timestamp: the newer of saved and draft. */
export function cacheModifiedAt(saved: RvScene | null, draft: RvScene | null): string | null {
  const a = typeof saved?.modifiedAt === 'string' ? saved.modifiedAt : null;
  const b = typeof draft?.modifiedAt === 'string' ? draft.modifiedAt : null;
  if (a === null) return b;
  if (b === null) return a;
  return compareTimestamps(a, b) >= 0 ? a : b;
}

/**
 * Compare two ISO timestamps. Falls back to a string compare when either is
 * unparseable, so a hand-edited manifest cannot make the comparison throw.
 * Returns <0 when `a` is older, >0 when newer, 0 when indistinguishable.
 */
export function compareTimestamps(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a < b ? -1 : a > b ? 1 : 0;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/** True when the folder side carries anything usable at all. */
function folderIsKnown(folder: FolderSceneState | null): boolean {
  if (!folder) return false;
  if (folder.scene) return true;
  if (typeof folder.revision === 'string' && folder.revision.trim() !== '') return true;
  return typeof folder.modifiedAt === 'string' && folder.modifiedAt.trim() !== '';
}

// ─── The decision ───────────────────────────────────────────────────────

/**
 * Decide what happens to one scene when a project folder is opened.
 *
 * Order of reasoning — each step exists because skipping it loses data:
 *  1. nothing cached → take the folder (there is nothing to lose);
 *  2. nothing in the folder → keep the cache (there is nothing to take);
 *  3. an unsaved draft → prompt, unconditionally (B3);
 *  4. identical content → equal, whatever the clocks say;
 *  5. only then compare timestamps, and prompt rather than discard whenever
 *     the cache is the newer side.
 */
export function resolveSceneConflict(input: SceneConflictInput): SceneConflictResolution {
  const { saved, draft, folder } = input;
  const hasCache = saved !== null || draft !== null;
  const folderKnown = folderIsKnown(folder);

  // 1 — no cache: the folder is the only copy there is.
  if (!hasCache) return folderKnown ? 'folder-wins' : 'equal';

  // 2 — no folder entry (or an unreadable one): the cache is the only copy.
  if (!folderKnown) return 'cache-wins';

  // 3 — unsaved work in the draft slot. This is the B3 rule and it outranks
  //     every timestamp: work that was never explicitly saved must never be
  //     thrown away by an automatic comparison.
  if (hasUnsavedDraft(saved, draft)) return 'prompt';

  // From here the draft (if any) matches the saved record, so the saved
  // record represents the cache. `hasCache` guarantees it is non-null: a
  // draft without a saved record differs from `null` and left above.
  const cacheScene = saved as RvScene;
  const folderScene = folder?.scene ?? null;

  // 4 — content decides over clocks. Hydration alone rewrites the cache's
  //     `modifiedAt` to "now", so a purely timestamp-based answer would
  //     report a conflict on every single re-open of an untouched project.
  //
  //
  //     Note what is deliberately NOT done here (plan-397 §2.8): the recorded
  //     `cachedRevision` is *not* compared against `folder.revision`. That
  //     pairing looks like a free content check and is not one — the cached
  //     revision says which folder body the cache was **filled from**, not
  //     what the cache holds **now**. A user who saved a local edit still
  //     matches it, and the comparison would answer "equal" over their work.
  //     A revision is the precondition for a *write*; the open-time decision
  //     stays content-based.
  if (folderScene && scenesEqual(folderScene, cacheScene)) return 'equal';

  const folderAt = typeof folder?.modifiedAt === 'string'
    ? folder.modifiedAt
    : folderScene?.modifiedAt ?? null;
  const cacheAt = cacheModifiedAt(saved, draft);

  // No usable folder timestamp, but a body that we already know differs.
  if (folderAt === null) return folderScene ? 'prompt' : 'cache-wins';

  const cmp = compareTimestamps(folderAt, cacheAt);
  if (cmp > 0) return 'folder-wins';   // someone pulled / edited on disk
  if (cmp < 0) return 'prompt';        // local edits are newer — never discard silently

  // 5 — same timestamp. Identical content was ruled out in step 4, so a known
  //     body here means a genuine divergence at equal clocks; an unknown body
  //     means there is no evidence of one.
  return folderScene ? 'prompt' : 'equal';
}
