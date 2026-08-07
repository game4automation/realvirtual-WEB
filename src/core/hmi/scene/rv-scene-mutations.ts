// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-mutations — one notifier for every path that mutates persisted
 * scene state.
 *
 * ## Why this is a module-level bus and not a SceneStore callback
 *
 * The obvious design is an `onSaved` hook inside `SceneStore.save()`. It is
 * wrong twice over:
 *
 *  - `save()`/`saveAs()` are only two of the seams. `rename()`,
 *    `duplicate()`, `delete()`, `addPublishedToMyScenes()`,
 *    `importSceneJSON()`, `markGlbActive()` and `_loadIntoWorkspace()` all
 *    write persisted state too. A hook in save() alone lets an open project
 *    drift away from its folder with nothing visible to show for it.
 *  - `main.ts` calls `writeActiveId(null)` **directly** from the heavy-CAD
 *    restore guard — outside `SceneStore` entirely. A store-internal
 *    notifier cannot reach it by construction. That call now routes through
 *    {@link setActiveSceneId} here.
 *
 * The autosave tick (`writeSceneDraft`, every 2 s) deliberately does NOT
 * emit: only saved-state transitions are allowed to reach the disk. A second
 * crash cache next to the crash cache would have no reader and would cause
 * exactly the File-System-Access thrashing the folder writer debounces to
 * avoid.
 *
 * Nothing happens when no one subscribes, so the store's behaviour with no
 * project open is bit-for-bit what it was before.
 */

import { writeActiveId } from './rv-scene-storage';
import type { RvScene } from './rv-scene-types';

// ─── Event ──────────────────────────────────────────────────────────────

export type SceneMutation =
  /** A scene body was written (save, saveAs, duplicate, import, adopt). */
  | { type: 'upsert'; id: string; scene: RvScene }
  /** A scene was renamed. Carries the new body and the previous name. */
  | { type: 'rename'; id: string; scene: RvScene; prevName: string }
  /** A scene was deleted by explicit user request. */
  | { type: 'delete'; id: string }
  /** The active-scene pointer moved (including to null). */
  | { type: 'active'; id: string | null };

export type SceneMutationListener = (mutation: SceneMutation) => void;

const listeners = new Set<SceneMutationListener>();

/** Subscribe to scene mutations. Returns an unsubscribe function. */
export function onSceneMutation(listener: SceneMutationListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Emit a mutation. A throwing subscriber must never break the caller's save,
 * so failures are logged and swallowed here.
 */
export function emitSceneMutation(mutation: SceneMutation): void {
  for (const listener of [...listeners]) {
    try {
      listener(mutation);
    } catch (e) {
      console.warn('[scene-mutations] listener failed:', e);
    }
  }
}

/** Test/teardown helper — drop every subscriber. */
export function clearSceneMutationListeners(): void {
  listeners.clear();
}

// ─── Instrumented active-id writer ──────────────────────────────────────

/**
 * Write the active-scene pointer **and** announce it.
 *
 * Every producer of the active pointer must go through this instead of
 * `writeActiveId()` directly, including the one in `main.ts` that sits
 * outside `SceneStore`. `deleteScene()` in rv-scene-storage still calls
 * `writeActiveId(null)` internally; that one needs no event of its own
 * because the surrounding `delete` seam already emits.
 */
export function setActiveSceneId(id: string | null): void {
  writeActiveId(id);
  emitSceneMutation({ type: 'active', id });
}
