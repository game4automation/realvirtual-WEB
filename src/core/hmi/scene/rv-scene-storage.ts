// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-storage — the `rv-scenes/*` keyspace.
 *
 * Keyspace:
 *   rv-scenes-index                  JSON: RvSceneMeta[] (sorted modifiedAt desc)
 *   rv-scenes/<id>                   JSON: RvScene
 *   rv-scenes/active                 JSON: { id: string }
 *   rv-scenes/draft/<baseKey>        DEAD SLOT — cleared, never read or written
 *   rv-scenes/scene-draft/<savedId>  DEAD SLOT — cleared, never read or written
 *
 * ## This is no longer a catalogue of user content (plan-716 Phase 6)
 *
 * It was: every scene a user owned was a row here, minted by `newSceneId()`.
 * F1 ended that. `newSceneId()` is deleted, `SceneStore` writes nothing here,
 * and the eager migration (`rv-workspace-migration.ts`) converts every row it
 * finds into a GLB document and RETIRES the original under `rv-scenes-retired/`.
 * A profile that has booted once has an empty index.
 *
 * Three things still use these keys, and each is a READ or a cache — never a
 * new artefact:
 *
 *  1. **The migration**, which reads rows and bodies to convert them, and needs
 *     {@link removeScenesFromIndex} to drop a row whose bytes it has retired.
 *  2. **The folder-project scene cache.** `ProjectStore.hydrateScene()` and
 *     `_applyFolderScene()` mirror a folder's scene into `rv-scenes/<id>` and
 *     `rv-project-conflict.ts` compares the two on the next open — the
 *     documented "never a silent overwrite" net. Those rows carry
 *     `readSceneOwner(id).cachedFrom`, which is why the migration skips them
 *     (§2.3 step 0), and they outlive this phase deliberately: they can only go
 *     once that comparison is expressed over document revisions, and doing it by
 *     revision alone would be weaker than the content comparison it replaces
 *     (see the note in `resolveSceneConflict` step 4).
 *  3. **The active-id pointer**, {@link readActiveId}, which resolves through
 *     the permanent alias map and so answers with a documentId.
 *
 * `tests/scene-removal-guard.test.ts` pins that list: a fourth writer of this
 * keyspace is a regression, not a feature.
 *
 * ## Both draft keyspaces are dead (plan-397 phase 7, plan-413 phase 6)
 *
 * `writeDraft` and `writeSceneDraft` went first: since plan-397 phase 6 an
 * autosave is a GLB body, and leaving a second way to persist an op log would
 * have meant two writers with two formats and no rule about which wins. The
 * READERS survived one release, so a draft written by the previous version
 * still resumed. That release is over: both readers are gone with the rest of
 * the JSON scene reader, and what remains of the two keyspaces is the `clear*`
 * half, which removes keys without parsing them and is what stops the old slots
 * accumulating.
 *
 * `writeScene` stores a ROW (base + empty ops) rather than a body:
 * `rv-scenes/<id>` is the index entry, and the scene itself is the GLB it
 * points at. A row still carrying the op-log generation gets the F10 error —
 * see {@link readScene}.
 *
 * Pure CRUD — no React, no Three.js, no DOM.
 */

import { resolveDocumentId } from '../../project/rv-doc-alias';
import { LegacyFormatError } from '../../project/rv-legacy-format';
import {
  isLegacySchemaVersion,
  isSupportedSchemaVersion,
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
  /**
   * `write-alias` is the migration's (plan-716 §2.3d): the alias write is the
   * one localStorage write whose failure must ABORT its row rather than be
   * swallowed, and it is announced here so it reaches the same banner as every
   * other quota failure instead of inventing a second channel for one caller.
   */
  op: 'write-scene' | 'write-index' | 'write-draft' | 'write-alias';
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

/**
 * Announce a persistence failure raised OUTSIDE this module (plan-716 §2.3d).
 *
 * The workspace migration writes into two keyspaces this module does not own
 * (`rv-doc-alias/`, `rv-scenes-retired/`) and must reach the same subscribers:
 * the banner that tells the user their storage is full is the same banner
 * whichever key ran out of room. Exported rather than duplicated so there stays
 * ONE list of listeners and one "last error" for a poller to read.
 */
export function reportSceneStorageError(error: SceneStorageError): void {
  reportStorageError(error);
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

/**
 * Read one catalogue row.
 *
 * A row of the op-log generation **throws** {@link LegacyFormatError} rather
 * than reading as absent (plan-413 F10). The difference is the whole point:
 * {@link LegacyFormatError} names the release that can still convert, which is
 * actionable; a `null` here would delete the user's scene from the list on the
 * next index rewrite and say nothing.
 *
 * The parse itself still fails soft — an unparseable key is corruption, not a
 * format decision, and there is nothing a user can do about it.
 */
export function readScene(id: string): RvScene | null {
  let parsed: RvScene;
  try {
    const raw = localStorage.getItem(sceneKey(id));
    if (!raw) return null;
    parsed = JSON.parse(raw) as RvScene;
  } catch {
    return null;
  }
  if (isLegacySchemaVersion(parsed?.schemaVersion)) {
    throw new LegacyFormatError('localstorage-scene-v2', sceneKey(id));
  }
  return isSupportedSchemaVersion(parsed?.schemaVersion) ? parsed : null;
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
  // If active was this scene, clear it. Compared against the STORED pointer:
  // the resolving read would answer with a document id for a migrated scene and
  // never match the `scn_` id being deleted here.
  if (readStoredActiveId() === id) writeActiveId(null);
}

// ─── Active scene ───────────────────────────────────────────────────────

/**
 * The id of whatever was open last — ALIAS-TOLERANT since plan-716 §2.4.
 *
 * The pointer is written by a session and read by the next one, so the update
 * that migrates the catalogue lands squarely between the two: the stored value
 * is a `scn_` id and the thing it names is now a document. Resolving here rather
 * than at the (twelve) call sites is what makes that invisible to all of them —
 * they asked "what should I reopen", and the honest answer is the document.
 *
 * A pointer with no alias comes back unchanged, which is every pre-migration
 * profile and every id the migration did not touch (a folder project's cache
 * row, for one).
 */
export function readActiveId(): string | null {
  const stored = readStoredActiveId();
  if (stored === null) return null;
  return resolveDocumentId(stored);
}

/**
 * The pointer exactly as stored, alias unresolved.
 *
 * For the one caller that has to compare against what was WRITTEN rather than
 * what it resolves to — {@link deleteScene}, which clears the pointer when the
 * scene it names is deleted and would otherwise miss a pointer whose alias
 * target differs from the id being deleted.
 */
export function readStoredActiveId(): string | null {
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
// A dead keyspace, kept only so the keys can be removed. See the file header.

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

/**
 * Drop rows from the INDEX only, leaving their `rv-scenes/<id>` bodies alone
 * (plan-716 §2.3 step 4).
 *
 * The migration needs exactly this and nothing stronger. {@link deleteScene}
 * would remove the body key, and the migration does not remove it — it RETIRES
 * it under `rv-scenes-retired/`, which is a write it has to perform itself
 * because only it knows the graveyard's shape. Splitting the two lets a crash
 * between them be repaired: an index without a row is the finished state, a
 * retired key without an index entry is the finished state, and both together
 * is a state the re-run resolves.
 *
 * Rows the migration could NOT convert are simply not passed in, which is what
 * keeps them listed and retried on the next boot (§2.3d).
 */
export function removeScenesFromIndex(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const doomed = new Set(ids);
  writeIndex(listMetas().filter(m => !doomed.has(m.id)));
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
