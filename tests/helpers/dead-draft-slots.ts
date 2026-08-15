// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * dead-draft-slots — reach the two localStorage keyspaces that nothing reads.
 *
 * `rv-scenes/draft/<baseKey>` and `rv-scenes/scene-draft/<id>` held op-log
 * autosaves. plan-397 phase 7 removed the writers; plan-413 phase 6 removed the
 * readers. What is left is `clearDraft`, `clearSceneDraft`, `clearDraftsForScope`
 * and `clearAllScenes` — the ability to REMOVE what an earlier release left
 * behind, which is the only reason the keyspaces still appear in this codebase.
 *
 * This replaces `legacy-drafts.ts`, and the difference in purpose is the point.
 * That helper wrote a *scene* into a slot so a test could prove it resumed;
 * these functions put an opaque marker into a *key* so a test can prove it is
 * ignored and can still be cleaned up. Writing a scene here would suggest
 * something still parses one.
 *
 * The key layout is copied deliberately rather than imported: it describes what
 * a previous release wrote, and must keep describing that even if the current
 * keyspace helpers move on.
 */

import { baseKeyOf, type SceneBase } from '../../src/core/hmi/scene/rv-scene-types';
import { getDraftScope } from '../../src/core/hmi/scene/rv-scene-storage';

const LS_KEY_DRAFT_PREFIX = 'rv-scenes/draft/';
const LS_KEY_SCENE_DRAFT_PREFIX = 'rv-scenes/scene-draft/';

/** The per-base draft key, including the project scope when one is set. */
export function deadDraftKey(base: SceneBase): string {
  const scope = getDraftScope();
  const key = baseKeyOf(base);
  return LS_KEY_DRAFT_PREFIX + (scope ? `${scope}:${key}` : key);
}

/** The per-saved-scene draft key. */
export function deadSceneDraftKey(id: string): string {
  return LS_KEY_SCENE_DRAFT_PREFIX + id;
}

/** Leave something in a per-base slot, as the pre-phase-7 autosave would have. */
export function seedDeadDraft(base: SceneBase, marker = 'leftover'): string {
  const key = deadDraftKey(base);
  localStorage.setItem(key, JSON.stringify({ marker }));
  return key;
}

/** Leave something in a per-saved-scene slot. */
export function seedDeadSceneDraft(id: string, marker = 'leftover'): string {
  const key = deadSceneDraftKey(id);
  localStorage.setItem(key, JSON.stringify({ marker }));
  return key;
}

/** Is anything still sitting in that slot? */
export function deadSlotExists(key: string): boolean {
  return localStorage.getItem(key) !== null;
}
