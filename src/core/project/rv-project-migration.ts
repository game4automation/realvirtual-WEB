// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-migration — giving the pre-project scenes a project, without
 * moving a single byte (§2.4).
 *
 * ## The rule, stated exactly
 *
 * **Migration changes nothing that exists.** Not "writes nothing" — the
 * earlier wording — but "changes nothing". The difference is the whole design:
 * `rv-scenes-index` is a flat keyspace with no `projectId` and `RvSceneMeta`
 * carries no origin, so membership cannot be *read* anywhere. It has to be
 * recorded. What this module writes is therefore exactly one additive key per
 * scene — `rv-scene-owner/<id>`, the marker plan-373 already built — and
 * nothing else. `rv-scenes-index`, `rv-scenes/<id>`, `rv-scenes/active` and
 * both draft keyspaces come out byte-for-byte identical.
 *
 * That is what makes the rollback property in §9.3 true rather than hoped
 * for: an older build does not know the key, ignores it, and finds every
 * scene precisely where it left it. Deleting the `rv-scene-owner/*` keys
 * restores the pre-migration state exactly.
 *
 * ## Why the Recent handles are consulted first
 *
 * "Everything unowned belongs to Sample" is wrong for the one user it matters
 * to most: someone whose scenes came out of a folder project. Before claiming
 * an entry, the already-**granted** folder handles are read and their
 * manifests consulted — with `queryPermission` only, never
 * `requestPermission`. A migration that raises a permission dialog on first
 * boot after an update is a migration nobody will let finish, and a prompt
 * whose answer decides data ownership makes the answer session-dependent —
 * exactly the flapping §2.4 exists to prevent.
 *
 * A folder whose grant has lapsed is simply not consulted. Its scenes get a
 * Sample marker, and the next time that project is genuinely opened
 * `noteSceneMembership()` adds the folder's id alongside — the marker is 1:n,
 * so nothing has to be taken away for that to be correct.
 *
 * ## The Working-Folder offer
 *
 * §2.10 retires the working folder by turning it into a project, and the
 * offer to do so must appear once and stay refused. The refusal is recorded
 * at {@link LS_KEY_WORKFOLDER_OFFER} — **its own key**. It is deliberately not
 * stored at, or derived from, the `HANDLE_KEY_WORKFOLDER` slot: that slot is
 * the working folder itself, still in service until Phase 11, and encoding a
 * UI decision into it would make declining an offer indistinguishable from
 * losing the folder.
 *
 * This module is headless on purpose. Deciding *whether* to offer is here;
 * showing the dialog is Phase 11's.
 */

import {
  HANDLE_KEY_WORKFOLDER,
  getHandle,
  listHandleKeys,
} from '../engine/rv-local-filesystem';
import { listMetas } from '../hmi/scene/rv-scene-storage';
import { onSceneMutation } from '../hmi/scene/rv-scene-mutations';
import { SAMPLE_PROJECT_ID } from './backends/bundled-backend';
import { readManifest } from './rv-project-storage';
import {
  clearSceneOwner,
  listSceneOwnerIds,
  noteSceneMembership,
  readSceneOwner,
} from './rv-scene-owner';

// ─── Keys (both new, both additive) ─────────────────────────────────────

/** Records that the migration ran, so the log is written once, not per boot. */
export const LS_KEY_MIGRATION_STATE = 'rv-project/migration';

/** The Working-Folder offer's own decision slot. See the file header. */
export const LS_KEY_WORKFOLDER_OFFER = 'rv-project/workfolder-offer';

export type WorkFolderOfferStatus = 'pending' | 'declined' | 'accepted';

interface MigrationState {
  /** ISO timestamp of the first successful ownership pass. */
  sceneOwnersAt?: string;
  [key: string]: unknown;
}

// ─── Results ────────────────────────────────────────────────────────────

export interface SceneAssignment {
  sceneId: string;
  projectId: string;
  /**
   *  - `sample` — no evidence of another owner; §2.4's default.
   *  - `granted-folder` — found in the manifest of an already-granted folder.
   *  - `already-marked` — a marker existed; nothing was written.
   */
  via: 'sample' | 'granted-folder' | 'already-marked';
}

export interface MigrationResult {
  /** Every index entry, with the project it ended up attributed to. */
  assignments: SceneAssignment[];
  /** Scene ids that received a marker in this run. */
  written: string[];
  /** Folder projects that were readable without a prompt. */
  consultedProjects: string[];
  /** True when the ownership pass had already been recorded before. */
  alreadyRan: boolean;
}

export interface MigrateOptions {
  /** Project id the unowned entries fall to. Defaults to the Sample project. */
  sampleProjectId?: string;
  /**
   * Test seam / pre-resolved evidence: `sceneId -> projectId` for scenes
   * proven to live in a granted folder project. When omitted, the granted
   * handles are read through {@link findGrantedFolderScenes}.
   */
  grantedFolderScenes?: Map<string, string>;
  /** Handle-store seams forwarded to {@link findGrantedFolderScenes}. */
  handleSeams?: Parameters<typeof findGrantedFolderScenes>[0];
  /** Run even when the state key says it already ran. */
  force?: boolean;
}

// ─── Evidence: the already-granted folder projects ──────────────────────

/**
 * Scene ids that provably belong to a folder project, without ever prompting.
 *
 * Every handle is checked with `queryPermission({ mode: 'read' })` and skipped
 * unless it is already `granted`. A stale or evicted handle, a folder that was
 * moved, a manifest that fails to parse — all of them are simply "no evidence",
 * never an error: the fallback (Sample) is always a valid answer, and the 1:n
 * marker means a later open can add the folder without contradiction.
 */
export async function findGrantedFolderScenes(
  seams: {
    /** Handle-store enumeration. Injectable because IndexedDB cannot hold a fake handle. */
    listKeys?: () => Promise<string[]>;
    getDir?: (key: string) => Promise<FileSystemDirectoryHandle | null>;
  } = {},
): Promise<Map<string, string>> {
  const listKeys = seams.listKeys ?? listHandleKeys;
  const getDir = seams.getDir ?? ((key: string) => getHandle(key));

  const found = new Map<string, string>();
  let keys: string[];
  try {
    keys = await listKeys();
  } catch {
    return found;
  }
  for (const key of keys) {
    if (!key.startsWith('projectfolder:')) continue;
    let dir: FileSystemDirectoryHandle | null = null;
    try {
      dir = await getDir(key);
    } catch {
      continue;
    }
    if (!dir) continue;
    try {
      // `queryPermission` only. Prompting here would make ownership depend on
      // what the user clicked, which is the flapping §2.4 forbids.
      const perm = await dir.queryPermission?.({ mode: 'read' });
      if (perm !== 'granted') continue;
    } catch {
      continue;
    }
    try {
      const result = await readManifest(dir);
      const project = result?.project;
      if (!project?.id) continue;
      for (const entry of project.scenes ?? []) {
        if (entry?.id && !found.has(entry.id)) found.set(entry.id, project.id);
      }
    } catch {
      /* unreadable manifest — no evidence */
    }
  }
  return found;
}

// ─── The migration ──────────────────────────────────────────────────────

/**
 * Attribute every loose `rv-scenes-index` entry to a project (§2.4).
 *
 * Idempotent, cheap on re-run (the marker only writes when something actually
 * changes) and safe to call before any project is open.
 */
export async function migrateLooseScenesToSample(
  opts: MigrateOptions = {},
): Promise<MigrationResult> {
  const sampleId = opts.sampleProjectId ?? SAMPLE_PROJECT_ID;
  const state = readMigrationState();
  const alreadyRan = typeof state.sceneOwnersAt === 'string';

  const metas = listMetas();
  const assignments: SceneAssignment[] = [];
  const written: string[] = [];

  const granted =
    opts.grantedFolderScenes ??
    (await findGrantedFolderScenes(opts.handleSeams).catch(
      () => new Map<string, string>(),
    ));

  for (const meta of metas) {
    const id = meta?.id;
    if (!id) continue;

    const existing = readSceneOwner(id);
    if (existing && existing.projectIds.length > 0) {
      // Already attributed — by an earlier run, by opening a project, or by
      // `createProjectFromScenes`. Never re-decide it.
      assignments.push({ sceneId: id, projectId: existing.projectIds[0]!, via: 'already-marked' });
      continue;
    }

    const folderId = granted.get(id);
    const projectId = folderId ?? sampleId;
    noteSceneMembership(id, projectId);
    written.push(id);
    assignments.push({
      sceneId: id,
      projectId,
      via: folderId ? 'granted-folder' : 'sample',
    });
  }

  if (!alreadyRan || opts.force) {
    writeMigrationState({ ...state, sceneOwnersAt: new Date().toISOString() });
  }

  return {
    assignments,
    written,
    consultedProjects: [...new Set(granted.values())],
    alreadyRan,
  };
}

// ─── Marker hygiene ─────────────────────────────────────────────────────

/**
 * Drop the ownership marker whenever a scene is deleted (§9.3).
 *
 * Hooked onto the mutation bus rather than into `deleteScene()` so the scene
 * storage layer keeps knowing nothing about projects, and so every deletion
 * path — `SceneStore.delete()`, the folder backend, a future one — is covered
 * by the same subscription. The listener is id-only and writes nothing but a
 * removal, so it does not compete with the single-writer rule of §2.2.1b.
 *
 * @returns the unsubscribe function.
 */
export function installSceneOwnerCleanup(): () => void {
  return onSceneMutation(mutation => {
    if (mutation.type === 'delete') clearSceneOwner(mutation.id);
  });
}

/**
 * Remove markers whose scene id is in neither `keepIds` nor the local index.
 *
 * `keepIds` must be the union of every known project's scene ids — a folder
 * project's scenes legitimately have a marker without appearing in the local
 * index, so pruning on the index alone would delete exactly the records that
 * carry the most information. Caller-supplied, never guessed.
 *
 * @returns the ids whose marker was removed.
 */
export function pruneSceneOwners(keepIds: Iterable<string>): string[] {
  const keep = new Set(keepIds);
  for (const meta of listMetas()) keep.add(meta.id);
  const removed: string[] = [];
  for (const id of listSceneOwnerIds()) {
    if (keep.has(id)) continue;
    clearSceneOwner(id);
    removed.push(id);
  }
  return removed;
}

// ─── Working-Folder offer ───────────────────────────────────────────────

/**
 * Should the "open this folder as a project?" offer be shown (§2.4 step 2)?
 *
 * True only when a working-folder handle exists and no decision has been
 * recorded. The handle is read, never permission-checked: asking for
 * permission in order to decide whether to *ask a question* would raise the
 * browser prompt this offer is supposed to precede.
 */
export async function shouldOfferWorkFolderAsProject(): Promise<boolean> {
  if (readWorkFolderOffer() !== 'pending') return false;
  try {
    return (await getHandle(HANDLE_KEY_WORKFOLDER)) !== null;
  } catch {
    return false;
  }
}

/** The recorded decision. `pending` means "never answered". */
export function readWorkFolderOffer(): WorkFolderOfferStatus {
  try {
    const raw = localStorage.getItem(LS_KEY_WORKFOLDER_OFFER);
    if (!raw) return 'pending';
    const parsed: unknown = JSON.parse(raw);
    const status = (parsed as { status?: unknown } | null)?.status;
    return status === 'declined' || status === 'accepted' ? status : 'pending';
  } catch {
    return 'pending';
  }
}

/**
 * Record a refusal. Permanent by design — §2.4 says the offer does not come
 * back, and the working-folder handle stays untouched.
 */
export function declineWorkFolderOffer(): void {
  writeWorkFolderOffer('declined');
}

/** Record acceptance, so the offer is not repeated after the folder is adopted. */
export function acceptWorkFolderOffer(): void {
  writeWorkFolderOffer('accepted');
}

/** Test/support utility: forget the decision so the offer can appear again. */
export function resetWorkFolderOffer(): void {
  try {
    localStorage.removeItem(LS_KEY_WORKFOLDER_OFFER);
  } catch {
    /* ignore */
  }
}

function writeWorkFolderOffer(status: Exclude<WorkFolderOfferStatus, 'pending'>): void {
  try {
    localStorage.setItem(
      LS_KEY_WORKFOLDER_OFFER,
      JSON.stringify({ status, at: new Date().toISOString() }),
    );
  } catch {
    /* private mode — the offer reappearing is a nuisance, not data loss */
  }
}

// ─── Rollback surface ───────────────────────────────────────────────────

/**
 * Undo everything this module ever wrote.
 *
 * Not a product feature — the executable form of the §9.3 acceptance
 * criterion. After this call the storage is byte-for-byte what it was before
 * the migration layer existed, which is exactly what "rolling back to an
 * older build loses nothing" has to mean.
 */
export function rollbackMigration(): void {
  for (const id of listSceneOwnerIds()) clearSceneOwner(id);
  try {
    localStorage.removeItem(LS_KEY_MIGRATION_STATE);
  } catch {
    /* ignore */
  }
  resetWorkFolderOffer();
}

// ─── State helpers ──────────────────────────────────────────────────────

function readMigrationState(): MigrationState {
  try {
    const raw = localStorage.getItem(LS_KEY_MIGRATION_STATE);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as MigrationState) : {};
  } catch {
    return {};
  }
}

function writeMigrationState(state: MigrationState): void {
  try {
    localStorage.setItem(LS_KEY_MIGRATION_STATE, JSON.stringify(state));
  } catch {
    /* quota — re-running the pass is harmless */
  }
}
