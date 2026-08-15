// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-documents-migration — the one direction that is left: legacy
 * arrays in, `documents[]` out (plan-413 §2.4 step B).
 *
 * ## Converting, not additive any more
 *
 * Through step A this migration added `documents[]` and left `scenes[]`,
 * `models[]` and `library[]` exactly as they were, because a mirror was going
 * to re-derive them on the next write. There is no mirror. Leaving them now
 * would leave a second, frozen copy of the document list in the manifest — and
 * a frozen copy is worse than none, because the delivery pipeline still reads
 * `scenes[]` as its "this customer has not converted yet" signal (run 6).
 *
 * So the three arrays are **removed** here, in memory, on the way in. Nothing
 * is written until the project's next normal save, which is what keeps opening
 * a read-only or merely-discovered project side-effect free.
 *
 * The rollback is correspondingly weaker and honestly so:
 * {@link rollbackDocumentsMigration} still removes the marker and the list, but
 * it cannot put back arrays it no longer has. Recovering those is what the
 * `.bak` and the customer's git history are for — the same answer as for every
 * other one-way step in this codebase.
 *
 * ## Why the marker lives in the manifest, not in localStorage
 *
 * `rv-project/migration` and `rv-project/scene-glb-migration` are localStorage
 * keys because what they migrate is localStorage. This one migrates a **file**
 * that travels: git, a zip, a customer delivery, another machine. A marker in
 * the browser would say "machine A already did this" while machine B, opening
 * the same repo, would have no way to know — and would mint a second set of ids
 * for entries that already have them. So the marker travels with what it marks.
 *
 * ## Ids
 *
 * Every entry that arrives without an `id` gets one (F2). Scene entries always
 * had one; `models[]`/`library[]` entries mostly do not, and `assetEntryKey()`
 * kept them addressable by path in the meantime. The id is derived from the
 * path rather than minted, so the same stored manifest yields the same
 * identities on every machine and on every read.
 */

import {
  documentOfAssetEntry,
  documentOfSceneEntry,
  readDocuments,
  stableDocumentId,
  withoutLegacyArrays,
  type DocumentSection,
} from './rv-project-documents';
import type {
  RvDocumentEntry,
  RvProject,
  RvProjectAssetEntry,
  RvProjectSceneEntry,
} from './rv-project-types';
import { RV_PROJECT_SCHEMA_VERSION } from './rv-project-types';

// ─── Marker ─────────────────────────────────────────────────────────────

/** Manifest key recording that this project has been given a `documents[]`. */
export const DOCUMENTS_MIGRATION_MARKER = 'rv-project/documents-migration';

/** What the marker holds. Unknown fields survive, as everywhere in this manifest. */
export interface DocumentsMigrationMarker {
  /** ISO timestamp of the run that created `documents[]`. */
  at: string;
  /** Schema version the migration produced. */
  schemaVersion: number;
  /** How many entries were lifted, per section — diagnostics only. */
  counts?: Record<string, number>;
  [key: string]: unknown;
}

/** The recorded marker, or null when this project has never been migrated. */
export function readDocumentsMigrationMarker(
  project: RvProject | null | undefined,
): DocumentsMigrationMarker | null {
  const raw = project?.[DOCUMENTS_MIGRATION_MARKER];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.at !== 'string') return null;
  return {
    at: rec.at,
    schemaVersion: typeof rec.schemaVersion === 'number' ? rec.schemaVersion : 1,
    ...rec,
  } as DocumentsMigrationMarker;
}

// ─── Outcome ────────────────────────────────────────────────────────────

/**
 * What one migration run did.
 *
 *  - `migrated` — `documents[]` was created from the legacy arrays.
 *  - `already`  — the marker was there and `documents[]` with it; nothing done.
 *  - `skipped`  — nothing to migrate (an empty project), or `documents[]`
 *                 already exists without a marker (a manifest written by a
 *                 newer client — theirs is authoritative, we do not re-derive).
 *  - `failed`   — the input was not a manifest at all.
 */
export type DocumentsMigrationOutcome = 'migrated' | 'already' | 'skipped' | 'failed';

export interface DocumentsMigrationResult {
  outcome: DocumentsMigrationOutcome;
  /** The manifest after the run. Identical to the input for every non-`migrated` outcome. */
  project: RvProject;
  /** Ids minted for entries that arrived without one (F2). */
  mintedIds: string[];
  /** Why, for `skipped`/`failed`. Diagnostics — never shown to a user. */
  reason?: string;
}

export interface DocumentsMigrateOptions {
  /**
   * Id minter for entries that arrive without one.
   *
   * Defaults to {@link stableDocumentId} — path-derived, not random, because
   * this migration runs inside `readManifest()` on every read and a random id
   * would give the same unchanged manifest a different identity every time.
   */
  mintId?: (entry: { path: string }) => string;
  /** Re-run even when the marker says it already ran. */
  force?: boolean;
  /** Clock seam. */
  now?: () => string;
}

// ─── The migration ──────────────────────────────────────────────────────

/**
 * Build `documents[]` from `scenes[]` + `models[]` + `library[]`.
 *
 * Idempotent by the marker, and cheap on re-run: with the marker present it
 * returns the input object itself, so a caller can run it on every open without
 * thinking about it. Order is scenes, then models, then library — the same
 * order the mirror derives back, which is what keeps a round trip from
 * reshuffling a customer's `project.json` on the first save.
 */
export async function migrateProjectDocuments(
  project: RvProject,
  opts: DocumentsMigrateOptions = {},
): Promise<DocumentsMigrationResult> {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return {
      outcome: 'failed',
      project,
      mintedIds: [],
      reason: 'not a manifest object',
    };
  }

  const marker = readDocumentsMigrationMarker(project);
  const existing = readDocuments(project);
  if (marker && existing && !opts.force) {
    // Already converted, but a stored manifest written by step A still carries
    // the mirror. Dropping it here — not only on the next write — is what makes
    // `documents[]` the single answer to "what is in this project" from the
    // first read on, rather than from the first save on.
    return { outcome: 'already', project: withoutLegacyArrays(project), mintedIds: [] };
  }
  if (existing && !marker && !opts.force) {
    // A newer client wrote `documents[]` and this build has never seen this
    // project. Re-deriving from the legacy arrays would throw away exactly the
    // information the newer client added.
    return {
      outcome: 'skipped',
      project: withoutLegacyArrays(project),
      mintedIds: [],
      reason: 'documents[] present without a marker — authored by a newer client',
    };
  }

  const mintedIds: string[] = [];
  const mint = (entry: { path: string }) => {
    const id = (opts.mintId ?? (e => stableDocumentId(e.path)))(entry);
    mintedIds.push(id);
    return id;
  };

  const documents: RvDocumentEntry[] = [];
  const counts: Record<string, number> = {};

  const legacy = project as {
    scenes?: unknown; models?: unknown; library?: unknown;
  };
  const scenes = arrayOf<RvProjectSceneEntry>(legacy.scenes);
  for (const entry of scenes) documents.push(documentOfSceneEntry(entry, mint));
  counts.scenes = scenes.length;

  for (const section of ['models', 'library'] as const) {
    const list = arrayOf<RvProjectAssetEntry>(legacy[section]);
    for (const entry of list) documents.push(documentOfAssetEntry(entry, section, mint));
    counts[section] = list.length;
  }

  // An empty project has nothing to lift, but it still needs the list: since
  // phase 6 `isValidProjectV2` requires one, and a project with no documents is
  // a perfectly ordinary new project, not a broken one. Through step A this
  // returned `skipped` and left the manifest without `documents[]` — which
  // would now be the F10 refusal, for a project whose only sin is being empty.
  const at = (opts.now ?? (() => new Date().toISOString()))();
  const migrated: RvProject = {
    ...withoutLegacyArrays(project),
    schemaVersion: Math.max(
      typeof project.schemaVersion === 'number' ? project.schemaVersion : 0,
      RV_PROJECT_SCHEMA_VERSION,
    ),
    documents,
    [DOCUMENTS_MIGRATION_MARKER]: {
      at,
      schemaVersion: RV_PROJECT_SCHEMA_VERSION,
      counts,
    } satisfies DocumentsMigrationMarker,
  };

  return { outcome: 'migrated', project: migrated, mintedIds };
}

// ─── Rollback ───────────────────────────────────────────────────────────

/**
 * Remove everything this module wrote: the marker and `documents[]`.
 *
 * **Not a full undo any more**, and the difference matters. Through step A the
 * migration was additive, so deleting these keys restored the manifest
 * byte-for-byte. Since the conversion the legacy arrays are gone, and this
 * cannot bring them back — what it produces is a manifest with no artefact list
 * at all, which is the right shape for handing to an older client only if that
 * client's own copy (`.bak`, git) is what supplies the arrays.
 *
 * The `schemaVersion` is left at 2 on purpose. It is a statement about what the
 * writer understood, not about which fields are present, and lowering it would
 * claim less than is true.
 */
export function rollbackDocumentsMigration(project: RvProject): RvProject {
  const out: Record<string, unknown> = { ...(project as Record<string, unknown>) };
  delete out.documents;
  delete out.documentsBaseline;
  delete out[DOCUMENTS_MIGRATION_MARKER];
  return out as RvProject;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function arrayOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is T =>
      !!e && typeof e === 'object' && !Array.isArray(e)
      && typeof (e as { path?: unknown }).path === 'string'
      && (e as { path: string }).path.trim() !== '',
  );
}

/** The sections a migration reads, in derivation order. Exported for tests. */
export const MIGRATED_SECTIONS: readonly DocumentSection[] = ['scenes', 'models', 'library'];
