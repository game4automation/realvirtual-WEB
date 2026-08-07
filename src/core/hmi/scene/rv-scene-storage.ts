// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-storage — localStorage CRUD for the unified Scene model.
 *
 * Keyspace:
 *   rv-scenes-index                  JSON: RvSceneMeta[] (sorted modifiedAt desc)
 *   rv-scenes/<id>                   JSON: RvScene
 *   rv-scenes/active                 JSON: { id: string }
 *   rv-scenes/draft/<baseKey>        JSON: RvScene  (per-base autosaved draft —
 *                                                    fresh built-in / empty
 *                                                    workspaces with no saved id)
 *   rv-scenes/scene-draft/<savedId>  JSON: RvScene  (per-saved-scene autosaved
 *                                                    draft — survives reload via
 *                                                    openScene; keyed by id so
 *                                                    multiple scenes built on
 *                                                    the same base don't collide)
 *
 * Pure CRUD — no React, no Three.js, no DOM. Imported by SceneStore and tests.
 */

import {
  type RvScene,
  type RvSceneMeta,
  type SceneBase,
  baseKeyOf,
  metaOf,
} from './rv-scene-types';

// ─── Storage keys ───────────────────────────────────────────────────────

const LS_KEY_INDEX = 'rv-scenes-index';
const LS_KEY_ACTIVE = 'rv-scenes/active';
const LS_KEY_SCENE_PREFIX = 'rv-scenes/';
const LS_KEY_DRAFT_PREFIX = 'rv-scenes/draft/';
const LS_KEY_SCENE_DRAFT_PREFIX = 'rv-scenes/scene-draft/';

function sceneKey(id: string): string {
  return LS_KEY_SCENE_PREFIX + id;
}

// ─── Draft scope (project isolation) ────────────────────────────────────
//
// `baseKeyOf()` derives the per-base draft slot purely from the base GLB
// (`builtin:<url>` / `empty`) and knows nothing about projects. With more
// than one project that is a cross-project leak: an unsaved draft made on
// `conveyor.glb` inside project A resurrects when the same built-in is
// opened inside project B — or in "no project" — because both compute the
// identical key.
//
// The scope prefixes the slot with the open project's id. It is deliberately
// module state rather than a parameter on every call: `readDraft`/
// `writeDraft`/`clearDraft` have many callers, and threading a project id
// through all of them would push project awareness into code that has no
// business holding it. "No project" keeps the historic unscoped key, so
// existing drafts stay exactly where they are.

let _draftScope: string | null = null;

/** Scope subsequent per-base draft reads/writes to a project. Null = global. */
export function setDraftScope(projectId: string | null): void {
  _draftScope = projectId && projectId.trim() !== '' ? projectId : null;
}

/** Current per-base draft scope, or null when no project is open. */
export function getDraftScope(): string | null {
  return _draftScope;
}

function draftKey(base: SceneBase): string {
  const key = baseKeyOf(base);
  return LS_KEY_DRAFT_PREFIX + (_draftScope ? `${_draftScope}:${key}` : key);
}

function sceneDraftKey(id: string): string {
  return LS_KEY_SCENE_DRAFT_PREFIX + id;
}

// ─── Write failures (plan-372 §5.1) ─────────────────────────────────────
//
// `writeScene()` and `writeIndex()` swallow their `setItem` failure and the
// comment claims "caller surfaces toast" — but the return value carries no
// failure signal, so no caller ever could. The scene simply is not saved and
// the UI says it was. With the Sample project now bundling every formerly
// loose scene into one keyspace, the pressure on that quota only goes up.
//
// The fix is additive: the return contract is unchanged (changing it would
// ripple through every save path), and a failure is announced on this channel
// instead of vanishing. A build with no subscriber behaves exactly as before.

export interface SceneStorageError {
  op: 'write-scene' | 'write-index' | 'write-draft';
  /** Scene id, where one is known. */
  id?: string;
  cause: unknown;
}

type SceneStorageErrorListener = (error: SceneStorageError) => void;

const storageErrorListeners = new Set<SceneStorageErrorListener>();

/** Subscribe to persistence failures (quota, private mode). */
export function onSceneStorageError(listener: SceneStorageErrorListener): () => void {
  storageErrorListeners.add(listener);
  return () => { storageErrorListeners.delete(listener); };
}

/** Last failure seen, for a caller that polls rather than subscribes. */
let _lastStorageError: SceneStorageError | null = null;

export function getLastSceneStorageError(): SceneStorageError | null {
  return _lastStorageError;
}

export function clearLastSceneStorageError(): void {
  _lastStorageError = null;
}

function reportStorageError(error: SceneStorageError): void {
  _lastStorageError = error;
  for (const l of [...storageErrorListeners]) {
    try { l(error); } catch { /* a bad listener must not break a save */ }
  }
}

// ─── Index ──────────────────────────────────────────────────────────────

export function listMetas(): RvSceneMeta[] {
  try {
    const raw = localStorage.getItem(LS_KEY_INDEX);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Sort defensively in case index was written out of order.
    return [...parsed].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  } catch {
    return [];
  }
}

function writeIndex(metas: RvSceneMeta[]): void {
  const sorted = [...metas].sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  try {
    localStorage.setItem(LS_KEY_INDEX, JSON.stringify(sorted));
  } catch (e) {
    reportStorageError({ op: 'write-index', cause: e });
  }
}

function upsertMeta(meta: RvSceneMeta): void {
  const metas = listMetas();
  const i = metas.findIndex(m => m.id === meta.id);
  if (i >= 0) metas[i] = meta;
  else metas.push(meta);
  writeIndex(metas);
}

function removeMeta(id: string): void {
  const metas = listMetas().filter(m => m.id !== id);
  writeIndex(metas);
}

// ─── Scene CRUD ─────────────────────────────────────────────────────────

export function readScene(id: string): RvScene | null {
  try {
    const raw = localStorage.getItem(sceneKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RvScene;
    if (parsed?.schemaVersion !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a scene. Updates `modifiedAt`, writes the blob, and refreshes the index.
 * @returns the persisted scene (with updated modifiedAt)
 */
export function writeScene(scene: RvScene): RvScene {
  const updated: RvScene = { ...scene, modifiedAt: new Date().toISOString() };
  try {
    localStorage.setItem(sceneKey(updated.id), JSON.stringify(updated));
    upsertMeta(metaOf(updated));
  } catch (e) {
    // The index is deliberately left alone: an index row pointing at a body
    // that was never written is worse than no row at all.
    reportStorageError({ op: 'write-scene', id: updated.id, cause: e });
  }
  return updated;
}

export function deleteScene(id: string): void {
  try {
    localStorage.removeItem(sceneKey(id));
  } catch {
    /* ignore */
  }
  removeMeta(id);
  // If active was this scene, clear it.
  if (readActiveId() === id) writeActiveId(null);
}

// ─── Active scene ───────────────────────────────────────────────────────

export function readActiveId(): string | null {
  try {
    const raw = localStorage.getItem(LS_KEY_ACTIVE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === 'string') return parsed.id;
    return null;
  } catch {
    return null;
  }
}

export function writeActiveId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEY_ACTIVE);
    else localStorage.setItem(LS_KEY_ACTIVE, JSON.stringify({ id }));
  } catch {
    /* ignore */
  }
}

// ─── Per-base draft slots ───────────────────────────────────────────────

export function readDraft(base: SceneBase): RvScene | null {
  try {
    const raw = localStorage.getItem(draftKey(base));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RvScene;
    if (parsed?.schemaVersion !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(base: SceneBase, scene: RvScene): void {
  try {
    localStorage.setItem(draftKey(base), JSON.stringify(scene));
  } catch {
    /* quota */
  }
}

export function clearDraft(base: SceneBase): void {
  try {
    localStorage.removeItem(draftKey(base));
  } catch {
    /* ignore */
  }
}

/**
 * Drop every per-base draft belonging to `projectId`.
 *
 * Called when a project is closed or switched. Scoping the key already
 * stops project A's draft from surfacing inside project B; clearing on the
 * way out stops them accumulating and makes the isolation observable rather
 * than merely structural.
 */
export function clearDraftsForScope(projectId: string): void {
  if (!projectId) return;
  const prefix = LS_KEY_DRAFT_PREFIX + projectId + ':';
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) doomed.push(k);
  }
  for (const k of doomed) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

/** Enumerate all per-base draft keys currently in storage. Used by tests and the cleanup tool. */
export function listDraftBaseKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    // Per-base prefix is a strict prefix of the per-saved-scene prefix
    // (`rv-scenes/draft/` vs `rv-scenes/scene-draft/`). Filter the latter
    // out so the legacy enumerator keeps its semantics.
    if (k && k.startsWith(LS_KEY_DRAFT_PREFIX) && !k.startsWith(LS_KEY_SCENE_DRAFT_PREFIX)) {
      out.push(k.slice(LS_KEY_DRAFT_PREFIX.length));
    }
  }
  return out;
}

// ─── Per-saved-scene draft slots ────────────────────────────────────────
//
// Drafts for workspaces that have a saved scene (`SceneStore._saved != null`)
// are keyed by saved-scene id so they survive reload via `openScene(id)`
// and don't collide with the source built-in's own draft slot. Same shape
// as the per-base helpers above; just a different keyspace.

export function readSceneDraft(id: string): RvScene | null {
  try {
    const raw = localStorage.getItem(sceneDraftKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RvScene;
    if (parsed?.schemaVersion !== 2) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSceneDraft(id: string, scene: RvScene): void {
  try {
    localStorage.setItem(sceneDraftKey(id), JSON.stringify(scene));
  } catch {
    /* quota */
  }
}

export function clearSceneDraft(id: string): void {
  try {
    localStorage.removeItem(sceneDraftKey(id));
  } catch {
    /* ignore */
  }
}

/** Enumerate all per-saved-scene draft ids currently in storage. */
export function listSceneDraftIds(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_KEY_SCENE_DRAFT_PREFIX)) {
      out.push(k.slice(LS_KEY_SCENE_DRAFT_PREFIX.length));
    }
  }
  return out;
}

// ─── Bulk helpers ───────────────────────────────────────────────────────

/** Delete every key in the new scene namespace. Test/cleanup utility. */
export function clearAllScenes(): void {
  const metas = listMetas();
  for (const m of metas) {
    try { localStorage.removeItem(sceneKey(m.id)); } catch { /* ignore */ }
  }
  for (const baseKey of listDraftBaseKeys()) {
    try { localStorage.removeItem(LS_KEY_DRAFT_PREFIX + baseKey); } catch { /* ignore */ }
  }
  for (const id of listSceneDraftIds()) {
    try { localStorage.removeItem(LS_KEY_SCENE_DRAFT_PREFIX + id); } catch { /* ignore */ }
  }
  try { localStorage.removeItem(LS_KEY_INDEX); } catch { /* ignore */ }
  try { localStorage.removeItem(LS_KEY_ACTIVE); } catch { /* ignore */ }
}
