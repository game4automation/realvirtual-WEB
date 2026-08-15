// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-types — Unified Scene model for the WebViewer Model Window.
 *
 * A Scene composes a base GLB with optional edit layers:
 *   - rv-extras overlay (component property patches)
 *   - planner placements (PlacedComponent[])
 *   - camera start preset
 *
 * Replaces the prior split between "GLB Scenes", "Layouts", and the hidden
 * `rv-extras-overlay:*` keyspace. See plan: unified scene model.
 */

import type { DocumentClassification } from '../../project/rv-document-classification';
import type { SceneEdits } from './rv-scene-edits';
import { opsEqual } from './rv-scene-edits';

// ─── Base ───────────────────────────────────────────────────────────────

/**
 * Foundation a scene is built on.
 *
 * ## Why `scene-glb` is its own kind and not a `builtin` with a URL
 *
 * Since plan-397 phase 6 a saved scene **is** a GLB: the bake folds every op
 * into the file, so what is left is a base with an empty op log. That base has
 * to name the body somehow, and neither existing kind can:
 *
 *  - a `blob:` URL dies with the document, and an `RvScene` outlives it — the
 *    record is cached in localStorage and read again after a reload, so the
 *    stored base would point at nothing;
 *  - a project-relative path is wrong for a user with no project, whose bodies
 *    live in the id-keyed OPFS store instead.
 *
 * So the base names the **scene id**, and resolving it to bytes is the storage
 * layer's job (`rv-scene-glb-io`). `revision` is carried along as the
 * compare-and-swap baseline for the next write — see §2.8.
 */
export type SceneBase =
  | { kind: 'empty' }
  | { kind: 'builtin'; url: string; label: string }
  | { kind: 'scene-glb'; sceneId: string; label: string; revision?: string };
// 'imported' (user-uploaded GLB) reserved for future.

/** Stable storage key derived from a SceneBase, safe for use in localStorage paths. */
export function baseKeyOf(base: SceneBase): string {
  if (base.kind === 'empty') return 'empty';
  // Deliberately WITHOUT the revision: the draft slot belongs to the scene, not
  // to one of its versions, or every save would strand the previous draft.
  if (base.kind === 'scene-glb') return 'scene-glb:' + encodeURIComponent(base.sceneId);
  return 'builtin:' + encodeURIComponent(base.url);
}

/** Human-readable label for a base (used in "from <label>" subtext). */
export function baseLabelOf(base: SceneBase): string {
  return base.kind === 'empty' ? '(empty)' : base.label;
}

/** True when the scene's body is a GLB that the storage layer has to resolve. */
export function isGlbBase(base: SceneBase): base is Extract<SceneBase, { kind: 'scene-glb' }> {
  return base.kind === 'scene-glb';
}

// ─── Scene record ───────────────────────────────────────────────────────

/**
 * Storage generation of an `RvScene`.
 *
 * **3**, and only 3: the record is a CATALOGUE ROW; the body is a GLB the base
 * points at, and `edits.ops` is empty (plan-397 phase 7).
 *
 * Generation 2 — the record IS the body, `edits.ops` is the persisted form —
 * was readable for one release and is not any more (plan-413 phase 6). A v2
 * record still in `rv-scenes/<id>` gets the F10 error from `readScene`, naming
 * the release that can convert it, rather than being quietly skipped.
 */
export type RvSceneSchemaVersion = 3;

/** The version every writer stamps and every reader requires. */
export const RV_SCENE_SCHEMA_VERSION = 3 as const;

/** True for a schema version this build understands. */
export function isSupportedSchemaVersion(v: unknown): v is RvSceneSchemaVersion {
  return v === 3;
}

/** True for the op-log generation this build refuses (plan-413 F10). */
export function isLegacySchemaVersion(v: unknown): boolean {
  return v === 2;
}

export interface RvScene {
  id: string;                       // 'scn_<base36-time>_<rand>'
  name: string;
  createdAt: string;                // ISO 8601
  modifiedAt: string;               // ISO 8601
  schemaVersion: RvSceneSchemaVersion;

  base: SceneBase;
  edits: SceneEdits;                // ops log + workspace settings

  thumbnailDataUrl?: string;        // base64 PNG, generated lazily on save
  parentId?: string;                // scene this was duplicated from
  description?: string;
  /**
   * Cache of the body's own classification (plan-413 §2.9).
   *
   * The same cache the project manifest holds, for the world that has no
   * project: without one open, `rv-scenes-index` **is** the manifest, and a
   * document without a project must still be able to say what it is. Truth is
   * the GLB, here as everywhere — this field is a listing convenience so the
   * dashboard can filter without parsing every body, and it is replaced, never
   * merged, when the two disagree (§2.5).
   */
  classification?: DocumentClassification;
}

/** Lightweight scene index entry — kept in `rv-scenes-index` for fast list rendering. */
export interface RvSceneMeta {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  baseKind: SceneBase['kind'];
  baseLabel: string;
  parentId?: string;
  /** Classification cache — see {@link RvScene.classification}. */
  classification?: DocumentClassification;
}

/** In-memory active workspace: the saved snapshot + the live draft. */
export interface RvSceneSession {
  saved: RvScene | null;            // last-saved snapshot; null for never-saved drafts
  draft: RvScene;                   // mutated by editors via SceneStore subscriptions
  isDraft: boolean;                 // true => no saved.id yet
  dirty: boolean;                   // structural diff between saved and draft
}

/** Built-in scene catalogue entry, mirrored from `viewer.availableModels`. */
export interface BuiltinSceneEntry {
  url: string;
  label: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

// `newSceneId()` lived here and is GONE (plan-716 F1, Phase 6). It was the only
// minter of `scn_` ids, and F1 is precisely that no code path creates one any
// more: every owned artefact is a GLB document whose id comes from
// `stableDocumentId(relPath)`. The `scn_` PREFIX still appears — in the
// permanent alias map, in the retired namespace and in the folder-project scene
// cache — but only ever as something being READ. `tests/scene-removal-guard.test.ts`
// is what keeps a new minter from creeping back in.

/** Produce a meta record from a full scene. */
export function metaOf(scene: RvScene): RvSceneMeta {
  return {
    id: scene.id,
    name: scene.name,
    createdAt: scene.createdAt,
    modifiedAt: scene.modifiedAt,
    baseKind: scene.base.kind,
    baseLabel: baseLabelOf(scene.base),
    parentId: scene.parentId,
    ...(scene.classification ? { classification: scene.classification } : {}),
  };
}

/** Construct an empty draft on top of a base. Caller assigns a final id on save. */
export function makeDraftScene(base: SceneBase, name: string = 'Untitled'): RvScene {
  const now = new Date().toISOString();
  return {
    id: 'draft',
    name,
    createdAt: now,
    modifiedAt: now,
    schemaVersion: RV_SCENE_SCHEMA_VERSION,
    base,
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
  };
}

/**
 * Structural equality between two scenes for dirty detection.
 * Compares identity + base + ops sequence + workspace settings. Ignores
 * `modifiedAt` (advances on every save) and `thumbnailDataUrl` (regenerated
 * lazily). Op sequence equality uses op-id comparison via {@link opsEqual} —
 * Op records are immutable.
 */
export function scenesEqual(a: RvScene | null, b: RvScene | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id) return false;
  if (a.name !== b.name) return false;
  if (a.parentId !== b.parentId) return false;
  if (a.description !== b.description) return false;
  if (!sceneBaseEqual(a.base, b.base)) return false;
  if (!opsEqual(a.edits.ops, b.edits.ops)) return false;
  if (canonicalize(a.edits.settings) !== canonicalize(b.edits.settings)) return false;
  return true;
}

function sceneBaseEqual(a: SceneBase, b: SceneBase): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'empty' && b.kind === 'empty') return true;
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.url === b.url && a.label === b.label;
  if (a.kind === 'scene-glb' && b.kind === 'scene-glb') {
    // The revision IS part of identity here: this comparison drives dirty
    // detection, and a body that was rewritten is a different base even though
    // the scene id did not move.
    return a.sceneId === b.sceneId && a.label === b.label && a.revision === b.revision;
  }
  return false;
}

/**
 * The `RvScene` shell for a scene whose body is a GLB.
 *
 * Empty op log by construction — the bake folded every op into the file, and
 * the user's decision was that undo does not survive a reload. Settings start
 * at the defaults and are replaced from the file's `SceneSettings` once it is
 * loaded (`rv-scene-glb-read`), because reading them here would mean parsing a
 * GLB just to list a scene.
 */
export function glbSceneShell(args: {
  id: string;
  name: string;
  revision?: string;
  createdAt?: string;
  modifiedAt?: string;
  parentId?: string;
  description?: string;
  classification?: DocumentClassification;
}): RvScene {
  const now = new Date().toISOString();
  return {
    id: args.id,
    name: args.name,
    createdAt: args.createdAt ?? now,
    modifiedAt: args.modifiedAt ?? now,
    schemaVersion: RV_SCENE_SCHEMA_VERSION,
    base: { kind: 'scene-glb', sceneId: args.id, label: args.name, revision: args.revision },
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    ...(args.parentId ? { parentId: args.parentId } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.classification ? { classification: args.classification } : {}),
  };
}

/** Stable JSON stringify with sorted keys, used only for equality comparison. */
function canonicalize(value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, sortReplacer);
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}
