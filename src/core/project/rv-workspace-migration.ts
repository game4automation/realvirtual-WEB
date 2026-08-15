// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-workspace-migration — the eager scene→document conversion (plan-716 §2.3,
 * F3).
 *
 * The user decision was "convert them all": every row of the localStorage scene
 * catalogue becomes a GLB document of "My Workspace" on the first boot after the
 * update, and the catalogue stops existing. What makes that safe to do eagerly —
 * awaited, in the boot, over data nobody has a backup of — is the set of
 * properties below. Each of them is a rule this file follows literally, and each
 * is the answer to a specific way the naive version loses work.
 *
 * ## Retire, never delete (R1-I1)
 *
 * Nothing is removed. "Delete the old row" means "move it under
 * {@link LS_KEY_SCENES_RETIRED_PREFIX}", where a later release purges it and
 * where the documented DevTools snippet can put it back if a user has to go back
 * to the previous version. There is no rename primitive in either store, so a
 * retire is two operations — write the new key, remove the old — and a crash
 * between them leaves BOTH, which is duplication and not loss. The re-run
 * removes the old key when the retired key is already there.
 *
 * ## The alias decides the state, not the body (R1-S1 / R2-S1)
 *
 * `readSceneGlb()` returns null both for "this row never had a body" and for
 * "OPFS was evicted", and its own header calls that deliberate. For a RESUMING
 * migration that ambiguity is fatal: it cannot tell an unconverted row from a
 * converted one. So the state question is asked of {@link resolveDocumentAlias}
 * instead, which is written exactly once per row and never lies.
 *
 * The subtlety that R2 caught: the alias means "steps b–d are done", NOT "this
 * row is finished". Steps **e** (draft slot) and **f** (retire the body) run on
 * every pass regardless, because they are no-ops once their source key is gone
 * and because a crash between d/e or e/f is otherwise never repaired — the
 * second run would see the alias, skip everything, and leave the user's autosave
 * permanently unreachable under an id nothing addresses any more.
 *
 * ## Alias before retire (R1-S3)
 *
 * The order within a row is: bytes → alias → draft → retire. The alias write is
 * the only one that can fail on a full localStorage while the bytes (OPFS)
 * succeed, and the state it guards against is the worst one available here —
 * "the document is there and every link to it is dead". A failed alias aborts
 * its row, retires nothing, and is reported on the storage-error channel.
 *
 * ## Folder-project cache rows are not ours (R2-I1b)
 *
 * `rv-scenes-index` carries two different populations. Most rows are workspace
 * content. Some are CACHES of a folder project's `.glb`, put there by
 * `hydrateScene()`, and `rv-project-conflict.ts` hangs its "never a silent
 * overwrite" check on them. Retiring those would have turned that safety net off
 * without a single test going red. They are identified by
 * `readSceneOwner(id)?.cachedFrom` and skipped whole — not migrated, not retired
 * — until phase 6 moves the conflict check onto document revisions.
 *
 * ## Marker last
 *
 * {@link SCENES_MIGRATION_MARKER_KEY} is written only after the final row, and
 * only when every row succeeded. A run with an aborted row leaves the marker
 * unset on purpose: the aborted row genuinely is not migrated, and the next boot
 * should try again. The successful rows cost one `getItem` each on that re-run,
 * because the alias check short-circuits them.
 */

import {
  listMetas,
  removeScenesFromIndex,
  reportSceneStorageError,
} from '../hmi/scene/rv-scene-storage';
import {
  listSceneGlbIds,
  readSceneGlb,
  readSceneGlbPointer,
} from '../storage/rv-scene-glb-store';
import { readSceneOwner } from './rv-scene-owner';
import {
  resolveDocumentAlias,
  writeDocumentAlias,
} from './rv-doc-alias';
import { documentsOf, stableDocumentId } from './rv-project-documents';
import { openWorkspaceDefaultBackend } from './rv-workspace-default';
import type { ProjectBackend } from './backends/project-backend';
import type { RvDocumentEntry, RvProject } from './rv-project-types';

// ─── Keyspace ───────────────────────────────────────────────────────────

/**
 * Marker key. `rv-migration/…` rather than `rv-project/…` because this migrates
 * localStorage and stays with the browser profile — the same reasoning
 * `rv-project-documents-migration` gives for putting ITS marker in the manifest
 * instead, applied to the opposite case.
 */
export const SCENES_MIGRATION_MARKER_KEY = 'rv-migration/scenes-v1';

/**
 * Where retired keys go.
 *
 * Deliberately `rv-scenes-retired/` and not `rv-scenes/retired/`: the second
 * form shares a prefix with `LS_KEY_SCENE_PREFIX` and would be picked up by
 * `clearAllScenes()` and every other `rv-scenes/` walker, which is precisely the
 * accident the graveyard exists to avoid. `'rv-scenes-retired/x'.startsWith(
 * 'rv-scenes/')` is false — the character after `rv-scenes` is a hyphen.
 */
export const LS_KEY_SCENES_RETIRED_PREFIX = 'rv-scenes-retired/';

/** Retired catalogue row: the former `rv-scenes/<id>`. */
export function retiredRowKey(sceneId: string): string {
  return `${LS_KEY_SCENES_RETIRED_PREFIX}row/${sceneId}`;
}

/** Retired body pointer: the former `rv-scene-glb/<id>`. */
export function retiredGlbKey(sceneId: string): string {
  return `${LS_KEY_SCENES_RETIRED_PREFIX}glb/${sceneId}`;
}

/** The keys this migration reads and writes outside its own namespace. */
const LS_KEY_SCENE_PREFIX = 'rv-scenes/';
const LS_KEY_SCENE_GLB_PREFIX = 'rv-scene-glb/';

/** Web Lock name — one migration per origin, ever (§2.3 step 1). */
export const MIGRATION_LOCK_NAME = 'rv-migration-716';

/** Prefix of a draft body slot in the scene-GLB keyspace (Form C). */
const DRAFT_SLOT_PREFIX = 'draft/';

// ─── Result ─────────────────────────────────────────────────────────────

/** Why one row was not converted. */
export type MigrationSkipReason =
  /** A folder project's cache row — not workspace content (R2-I1b). */
  | 'cache-row'
  /** The row existed but never had a body. Retired, no document created. */
  | 'no-body'
  /** The alias could not be written (quota). Nothing retired; retried next boot. */
  | 'alias-failed'
  /** The bytes could not be written. Nothing retired; retried next boot. */
  | 'write-failed';

export interface MigratedRow {
  sceneId: string;
  documentId: string;
  path: string;
  /** True when this pass created it; false when a previous pass had. */
  fresh: boolean;
}

export interface SkippedRow {
  sceneId: string;
  reason: MigrationSkipReason;
  detail?: string;
}

/** What one run of {@link runWorkspaceScenesMigration} did. */
export interface WorkspaceMigrationResult {
  /**
   * - `migrated` — the run walked the catalogue and finished it.
   * - `already`  — the marker was set and nothing was left to repair.
   * - `deferred` — another tab holds the lock; this tab waited and re-read.
   * - `partial`  — at least one row aborted; the marker is NOT set.
   * - `skipped`  — there was nothing to do (no catalogue at all).
   */
  outcome: 'migrated' | 'already' | 'deferred' | 'partial' | 'skipped';
  migrated: MigratedRow[];
  skipped: SkippedRow[];
  /** Bodies with no row and no alias, adopted as `Recovered …` (R1-S5). */
  recovered: MigratedRow[];
  /** Rows moved to the graveyard by this run. */
  retiredRows: string[];
  /** Was the marker set by (or already true before) this run? */
  markerSet: boolean;
  /** Wall-clock duration, for the <10s NFR of Risiko 10. */
  durationMs: number;
  /** `navigator.storage.estimate()` at entry, when the browser answered. */
  quota?: { usage?: number; quota?: number };
}

/**
 * What the migration needs of a backend.
 *
 * `writeManifest` is deliberately NOT on `ProjectBackend`: a folder project's
 * manifest is written by the folder writer, on a queue, with a revision
 * precondition, and putting the verb on the shared interface would invite a
 * caller to bypass all of that. The browser backend has its own, and the browser
 * backend is the only thing this migration ever targets — "My Workspace" is a
 * browser project by definition (§2.2).
 */
export type MigrationBackend = ProjectBackend & {
  writeManifest(project: RvProject): Promise<void>;
};

export interface WorkspaceMigrationOptions {
  /**
   * Backend to write through. Defaults to a freshly opened, freshly ACTIVATED
   * workspace-default backend that this function also deactivates again.
   *
   * The default matters at the boot anchor: `resolveActiveProject()` promises
   * that the backend it returns is still inactive (boot-order.test.ts), so the
   * migration must not activate THAT one. It opens its own instance instead —
   * `BrowserBackend` keys everything off the project id, so a second instance
   * addresses exactly the same storage.
   */
  backend?: MigrationBackend;
  /**
   * Scene documents of a FOLDER project to alias (§2.3 step 5).
   *
   * Folder projects need no byte migration — their scenes have been
   * `documents[]` rows with a real file since plan-397/413. What they need is
   * that an old `?scene=scn_…` link to one keeps resolving, which is one alias
   * per `scn_`-shaped document id and no data movement at all.
   */
  folderProject?: RvProject | null;
  /** Progress seam. Called once per row with 1-based `done`. */
  onProgress?: (done: number, total: number) => void;
  /** Clock seam. */
  now?: () => string;
  /** How long to wait for another tab's finish broadcast before giving up. */
  waitForOtherTabMs?: number;
}

// ─── Entry point ────────────────────────────────────────────────────────

/**
 * Convert the scene catalogue into documents of "My Workspace". Idempotent.
 *
 * Safe to call on every boot: with the marker set and no residue it returns
 * `already` after two `getItem`s. Never throws — a migration that fails must
 * still let the application start, and everything it could not do is reported in
 * the result and on the storage-error channel.
 */
export async function runWorkspaceScenesMigration(
  opts: WorkspaceMigrationOptions = {},
): Promise<WorkspaceMigrationResult> {
  const startedAt = Date.now();
  const empty = (outcome: WorkspaceMigrationResult['outcome']): WorkspaceMigrationResult => ({
    outcome,
    migrated: [],
    skipped: [],
    recovered: [],
    retiredRows: [],
    markerSet: isScenesMigrationDone(),
    durationMs: Date.now() - startedAt,
  });

  // Cheapest possible answer for the overwhelmingly common case: the marker is
  // set and there is nothing left over. Asked BEFORE the lock, so a normal boot
  // never touches the Web Locks API at all.
  if (isScenesMigrationDone() && !hasMigrationResidue()) return empty('already');

  const lock = await acquireMigrationLock();
  if (!lock.held) {
    // Another run holds the lock. Waiting is not politeness: proceeding on the
    // pre-migration picture would route `?scene=` through a catalogue that is
    // being dismantled underneath us.
    //
    // But it is only worth waiting for something that is actually going to
    // change. With no catalogue there is nothing for the holder to convert and
    // nothing for this caller to re-read, so it returns immediately — which is
    // what keeps concurrent boots on a fresh profile from each stalling for the
    // full timeout on a migration that has no work in it.
    if (listMetas().length > 0) {
      await waitForMigrationDone(opts.waitForOtherTabMs ?? 5_000);
    }
    return empty('deferred');
  }

  try {
    const result = await _migrate(opts, startedAt);
    if (result.migrated.length > 0 || result.recovered.length > 0 || result.retiredRows.length > 0) {
      // Only when something actually moved. A no-op run broadcasting "done"
      // would wake every other tab for nothing, and — worse — would tell a tab
      // that is legitimately waiting for a REAL run that it may proceed.
      const { announceSceneMigrationDone } = await import('../hmi/scene/rv-scene-live-sync');
      announceSceneMigrationDone(result.migrated.length + result.recovered.length);
    }
    return result;
  } catch (e) {
    // A migration that throws must not stop the boot. Whatever it managed is
    // already durable — every step commits on its own — and the next boot
    // resumes from the alias state.
    console.error('[workspace-migration] aborted:', e);
    return { ...empty('partial'), skipped: [{ sceneId: '', reason: 'write-failed', detail: String(e) }] };
  } finally {
    await lock.release();
  }
}

// ─── The walk ───────────────────────────────────────────────────────────

async function _migrate(
  opts: WorkspaceMigrationOptions,
  startedAt: number,
): Promise<WorkspaceMigrationResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const quota = await readQuota();

  const rows = listMetas();
  const orphans = listOrphanBodies(rows.map(r => r.id));
  const folderScenes = folderSceneIdsToAlias(opts.folderProject ?? null);

  if (rows.length === 0 && orphans.length === 0 && folderScenes.length === 0) {
    // Nothing to convert — but the marker still belongs on a profile that has
    // no catalogue, or every boot pays for the residue scan.
    markScenesMigrationDone(now());
    return {
      outcome: 'skipped',
      migrated: [], skipped: [], recovered: [], retiredRows: [],
      markerSet: true,
      durationMs: Date.now() - startedAt,
      ...(quota ? { quota } : {}),
    };
  }

  const owned = opts.backend ?? null;
  const backend = owned ?? openWorkspaceDefaultBackend({ requestPersistence: false });
  const activatedHere = !backend.isActive;
  if (activatedHere) await backend.activate();

  const migrated: MigratedRow[] = [];
  const skipped: SkippedRow[] = [];
  const recovered: MigratedRow[] = [];
  /** Rows that may be retired once the marker is set. */
  const retirable: string[] = [];

  try {
    // The manifest is read ONCE and written ONCE. Per-row manifest writes would
    // be O(n²) over a growing document list, and the row's own durability does
    // not depend on it: the alias is what records that a row was converted, and
    // a manifest lost to a crash is rebuilt on the next pass because the alias
    // check keeps the same derived id and the same create-only path.
    const manifest = (await backend.readManifest()) ?? ({} as RvProject);
    const documents = [...documentsOf(manifest)];
    const takenPaths = new Set(documents.map(d => normalisePath(d.path)));
    const takenIds = new Set(documents.map(d => d.id));

    const total = rows.length + orphans.length;
    let done = 0;

    for (const row of rows) {
      done++;
      opts.onProgress?.(done, total);

      // ── Step 0: folder-project cache rows are not ours (R2-I1b) ────────
      if (readSceneOwner(row.id)?.cachedFrom) {
        skipped.push({ sceneId: row.id, reason: 'cache-row' });
        continue;
      }

      // ── Step a: the alias decides whether b–d have run (R2-S1) ─────────
      let documentId = resolveDocumentAlias(row.id);

      if (!documentId) {
        // ── Step b: the body ────────────────────────────────────────────
        const body = await readSceneGlb(row.id);
        if (!body) {
          // A row that never had a body. Creating an empty document for it
          // would put a broken card in the user's project for the rest of time;
          // retiring it is what "convert them all" means for something that has
          // nothing to convert.
          skipped.push({ sceneId: row.id, reason: 'no-body' });
          retirable.push(row.id);
          console.warn(`[workspace-migration] "${row.id}" had no body — retired without a document.`);
          continue;
        }

        // ── Step c: the document ────────────────────────────────────────
        const placed = await placeDocument(backend, row.name || row.id, row.id, body, takenPaths, takenIds);
        try {
          if (!placed.reuse) {
            await backend.writeBlob(
              placed.path,
              new Blob([body as unknown as BlobPart], { type: 'model/gltf-binary' }),
              // "create only" — the migration copies in and never overwrites
              // (write-blob-cas.contract.test.ts names this mode in those words).
              { expectedRevision: null },
            );
          }
        } catch (e) {
          skipped.push({ sceneId: row.id, reason: 'write-failed', detail: String(e) });
          console.error(`[workspace-migration] "${row.id}" could not be written:`, e);
          continue;
        }

        // ── Step d: the alias — BEFORE anything is retired (R1-S3) ──────
        try {
          writeDocumentAlias(row.id, placed.id, now);
        } catch (e) {
          // The document exists and nothing points at it yet. Leave the row
          // alone entirely: it is still openable the old way, and the next boot
          // re-derives the same id onto the same path, so the retry is exact.
          skipped.push({ sceneId: row.id, reason: 'alias-failed', detail: String(e) });
          reportSceneStorageError({ op: 'write-alias', id: row.id, cause: e });
          continue;
        }

        takenPaths.add(normalisePath(placed.path));
        takenIds.add(placed.id);
        documents.push(documentRowOf(placed, row, now()));
        documentId = placed.id;
        migrated.push({ sceneId: row.id, documentId: placed.id, path: placed.path, fresh: true });
      } else {
        migrated.push({
          sceneId: row.id,
          documentId,
          path: documents.find(d => d.id === documentId)?.path ?? '',
          fresh: false,
        });
      }

      // ── Steps e and f run on EVERY pass (R2-S1) ────────────────────────
      // Both are no-ops once their source key is gone, and both are the repair
      // for a crash that happened after the alias was written.
      moveDraftSlot(row.id, documentId);
      retireBodyPointer(row.id);
      retirable.push(row.id);
    }

    // ── Step 3: bodies with no row (R1-S5) ───────────────────────────────
    for (const orphanId of orphans) {
      done++;
      opts.onProgress?.(done, total);
      const existing = resolveDocumentAlias(orphanId);
      if (existing) {
        moveDraftSlot(orphanId, existing);
        retireBodyPointer(orphanId);
        continue;
      }
      const body = await readSceneGlb(orphanId);
      if (!body) continue;
      const placed = await placeDocument(backend, `Recovered ${orphanId}`, orphanId, body, takenPaths, takenIds);
      try {
        if (!placed.reuse) {
          await backend.writeBlob(
            placed.path,
            new Blob([body as unknown as BlobPart], { type: 'model/gltf-binary' }),
            { expectedRevision: null },
          );
        }
        writeDocumentAlias(orphanId, placed.id, now);
      } catch (e) {
        skipped.push({ sceneId: orphanId, reason: 'alias-failed', detail: String(e) });
        continue;
      }
      takenPaths.add(normalisePath(placed.path));
      takenIds.add(placed.id);
      documents.push(documentRowOf(placed, { id: orphanId, name: placed.name }, now()));
      recovered.push({ sceneId: orphanId, documentId: placed.id, path: placed.path, fresh: true });
      moveDraftSlot(orphanId, placed.id);
      retireBodyPointer(orphanId);
    }

    // ── Step 5: folder-project scenes get an alias and nothing else ──────
    for (const sceneId of folderScenes) {
      if (resolveDocumentAlias(sceneId)) continue;
      try {
        // A SELF-alias, and that is the whole point: a folder project's scene
        // document already carries the `scn_` id as its document id, so the old
        // link is already the new one. Recording it is what lets the router
        // treat "has an alias" as "resolves to a document" without a second
        // question about which world the id came from.
        writeDocumentAlias(sceneId, sceneId, now);
      } catch (e) {
        skipped.push({ sceneId, reason: 'alias-failed', detail: String(e) });
      }
    }

    if (documents.length > 0) {
      try {
        await backend.writeManifest({ ...manifest, documents } as RvProject);
      } catch (e) {
        console.error('[workspace-migration] the manifest could not be written:', e);
      }
    }

    // ── Step 4: marker LAST, then retire the rows ────────────────────────
    const aborted = skipped.some(s => s.reason === 'alias-failed' || s.reason === 'write-failed');
    if (!aborted) markScenesMigrationDone(now());

    const retiredRows: string[] = [];
    for (const id of retirable) {
      if (retireRow(id)) retiredRows.push(id);
    }
    removeScenesFromIndex(retirable);

    return {
      outcome: aborted ? 'partial' : 'migrated',
      migrated,
      skipped,
      recovered,
      retiredRows,
      markerSet: isScenesMigrationDone(),
      durationMs: Date.now() - startedAt,
      ...(quota ? { quota } : {}),
    };
  } finally {
    if (activatedHere) await backend.deactivate().catch(() => {});
  }
}

// ─── Marker ─────────────────────────────────────────────────────────────

/** Has the catalogue been fully converted on this profile? */
export function isScenesMigrationDone(): boolean {
  try {
    return localStorage.getItem(SCENES_MIGRATION_MARKER_KEY) !== null;
  } catch {
    // Storage disabled. Answering "done" is the safe lie: there is no catalogue
    // to convert either, and answering "not done" would run the whole walk on
    // every boot of a private-mode session.
    return true;
  }
}

function markScenesMigrationDone(at: string): void {
  try {
    localStorage.setItem(SCENES_MIGRATION_MARKER_KEY, JSON.stringify({ at, state: 'done' }));
  } catch { /* the run still happened; the next boot repeats a cheap no-op walk */ }
}

/**
 * Is there anything left over from an interrupted run?
 *
 * Asked only when the marker IS set, to catch the one window the marker cannot
 * describe: it is written before the rows are retired, so a crash in between
 * leaves rows in a catalogue the marker claims is gone.
 */
function hasMigrationResidue(): boolean {
  try {
    return listMetas().length > 0;
  } catch {
    return false;
  }
}

// ─── Lock (§2.3 step 1) ─────────────────────────────────────────────────

interface MigrationLock {
  held: boolean;
  /**
   * Give the lock back, and RESOLVE only once the browser has actually taken it
   * back.
   *
   * Awaiting matters and is not tidiness. Resolving the holder's promise merely
   * lets the `request()` callback return; the lock manager releases the lock
   * afterwards, out of band. A caller that ran a second migration in the same
   * turn — a boot that retries, or two calls in one test — would find the lock
   * still taken and defer for the full broadcast timeout while nothing on the
   * other side was ever going to answer. `request()`'s own promise settles after
   * the release, so awaiting it is the exact signal.
   */
  release(): Promise<void>;
}

/**
 * Take the origin-wide migration lock, or report that someone else has it.
 *
 * Web Locks is NEW infrastructure in this repo (there is no precedent to copy,
 * A7), so two things are spelled out rather than assumed. First, `ifAvailable`
 * means the callback runs with `null` instead of waiting — that null IS the
 * "another tab has it" signal, and the promise still resolves normally. Second,
 * a browser without the API is not an error: a single-tab user is the
 * overwhelming case, and the per-step idempotence is what actually protects the
 * data. The lock only saves a second tab from doing redundant work.
 */
async function acquireMigrationLock(): Promise<MigrationLock> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    return { held: true, release: async () => {} };
  }
  let release!: () => void;
  const releasedByHolder = new Promise<void>(resolve => { release = resolve; });
  // The lock is held for as long as the callback's promise is pending, so the
  // callback parks on `releasedByHolder` and the caller decides when to let go.
  let requestDone: Promise<unknown> = Promise.resolve();
  const settled = new Promise<boolean>(resolve => {
    requestDone = locks
      .request(MIGRATION_LOCK_NAME, { ifAvailable: true }, async lock => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        await releasedByHolder;
      })
      .catch(() => { resolve(false); });
  });
  const got = await settled;
  return {
    held: got,
    release: async () => {
      if (!got) return;
      release();
      await requestDone;
    },
  };
}

/**
 * Park until the holder is finished, or until the deadline.
 *
 * Three ways out, on purpose. The BroadcastChannel message is the fast path and
 * the only one that works across tabs. The poll covers the two cases the message
 * cannot: a holder in this same context (BroadcastChannel does not deliver to
 * the sending context, so a concurrent call in one tab would never hear itself)
 * and a holder that finished before this waiter subscribed. The deadline covers
 * a holder that was closed mid-run — not a failure worth logging, because the
 * next call simply takes the lock and does the work.
 */
async function waitForMigrationDone(timeoutMs: number): Promise<void> {
  const { onSceneMigrationDone } = await import('../hmi/scene/rv-scene-live-sync');
  await new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      off();
      resolve();
    };
    const off = onSceneMigrationDone(finish);
    const poll = setInterval(() => {
      if (isScenesMigrationDone() || listMetas().length === 0) finish();
    }, 50);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// ─── Row helpers ────────────────────────────────────────────────────────

interface PlacedDocument {
  id: string;
  path: string;
  name: string;
  /**
   * The bytes are already at {@link path} and are BYTE-IDENTICAL to ours, so
   * the create-only write must be skipped rather than attempted.
   *
   * This is what makes a retry after a crash between step c and step d work at
   * all. That crash leaves the blob written and the manifest row unwritten, so
   * the next run's in-memory `takenPaths` — built from the manifest — does not
   * know the path is occupied, and a create-only write onto it is refused. The
   * row would then abort forever, on every boot, with the document sitting
   * right there. Recognising our own earlier attempt by its content is the fix,
   * and content-addressing is what makes the recognition exact rather than a
   * guess about names.
   */
  reuse: boolean;
}

/**
 * Pick a free id and a free path for a converted row.
 *
 * The id is DERIVED from the scene id rather than minted, for the reason
 * `stableDocumentId` gives: a re-run after a crash has to arrive at the same
 * answer, or the create-only write would land beside the previous attempt
 * instead of on top of it.
 *
 * The collision case (R2-T) is a real one and not merely defensive: two rows can
 * legitimately carry the same NAME, so their `scenes/<name>.glb` paths collide
 * even though their ids never do. The name is probed exactly like
 * `createEmptyAsset` probes ("Line", "Line 2", "Line 3"), so the outcome is
 * deterministic, legible, and never an overwrite.
 */
async function placeDocument(
  backend: MigrationBackend,
  rawName: string,
  sceneId: string,
  body: Uint8Array,
  takenPaths: ReadonlySet<string>,
  takenIds: ReadonlySet<string>,
): Promise<PlacedDocument> {
  const base = safeFileName(rawName) || safeFileName(sceneId) || 'Scene';
  let name = base;
  let path = `scenes/${name}.glb`;
  let reuse = false;

  for (let n = 2; ; n++) {
    if (!takenPaths.has(normalisePath(path))) {
      // Not claimed by a manifest row. Ask the STORE as well, because a crashed
      // earlier attempt leaves bytes with no row (see {@link PlacedDocument}).
      const stored = await backend.readBlobBytes(path).catch(() => null);
      if (!stored) break;
      if (sameBytes(new Uint8Array(stored), body)) { reuse = true; break; }
    }
    name = `${base} ${n}`;
    path = `scenes/${name}.glb`;
  }

  let id = stableDocumentId(path);
  // The path is unique by construction above, so a colliding id means the hash
  // collided — vanishingly rare and still not allowed to overwrite anything.
  for (let n = 2; takenIds.has(id); n++) id = stableDocumentId(`${path}#${n}`);

  return { id, path, name, reuse };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function documentRowOf(
  placed: PlacedDocument,
  row: { id: string; name?: string; createdAt?: string; modifiedAt?: string },
  at: string,
): RvDocumentEntry {
  return {
    id: placed.id,
    path: placed.path,
    name: placed.name,
    section: 'scenes',
    createdAt: row.createdAt ?? at,
    modifiedAt: row.modifiedAt ?? at,
    // Kept so a support question ("where did this document come from?") has an
    // answer in the manifest itself, and so the retired row can be matched back
    // to it without consulting the alias map.
    migratedFrom: row.id,
  };
}

/**
 * Step e — move the Form-C draft body slot onto the new identity.
 *
 * The slot is a POINTER in the scene-GLB keyspace (`rv-scene-glb/draft/<id>`),
 * so the move costs two localStorage operations and touches no OPFS bytes at
 * all: both the old and the new key name the same content-addressed blob.
 *
 * Write-new then remove-old, in that order and never the reverse. Interrupted
 * after the write, the next pass finds both and removes the old one; interrupted
 * before it, the next pass finds only the old one and repeats the move. The
 * order that loses a draft is the other one.
 */
function moveDraftSlot(sceneId: string, documentId: string): boolean {
  const fromKey = LS_KEY_SCENE_GLB_PREFIX + DRAFT_SLOT_PREFIX + sceneId;
  const toKey = LS_KEY_SCENE_GLB_PREFIX + DRAFT_SLOT_PREFIX + documentId;
  try {
    const raw = localStorage.getItem(fromKey);
    if (raw === null) return false;
    // A draft already at the destination wins: it was written by the migrated
    // identity, so it is newer than anything still sitting under the old key.
    if (localStorage.getItem(toKey) === null) localStorage.setItem(toKey, raw);
    localStorage.removeItem(fromKey);
    return true;
  } catch (e) {
    reportSceneStorageError({ op: 'write-draft', id: sceneId, cause: e });
    return false;
  }
}

/** Step f — retire the canonical body pointer. Idempotent, never deletes bytes. */
function retireBodyPointer(sceneId: string): boolean {
  return retireKey(LS_KEY_SCENE_GLB_PREFIX + sceneId, retiredGlbKey(sceneId));
}

/** Step 4 — retire the catalogue row body. Idempotent. */
function retireRow(sceneId: string): boolean {
  return retireKey(LS_KEY_SCENE_PREFIX + sceneId, retiredRowKey(sceneId));
}

/**
 * Move one localStorage key into the graveyard.
 *
 * Two operations, no atomicity, and the R2 correction is that this is fine
 * rather than that it is atomic: a crash between them leaves both keys, which
 * duplicates a pointer to content-addressed bytes and loses nothing. The next
 * pass sees the source still there, rewrites the (identical) retired value and
 * removes the source — so the repair is the ordinary path, not a special case.
 *
 * @returns true when something was actually moved.
 */
function retireKey(fromKey: string, toKey: string): boolean {
  try {
    const raw = localStorage.getItem(fromKey);
    if (raw === null) return false;
    localStorage.setItem(toKey, raw);
    localStorage.removeItem(fromKey);
    return true;
  } catch (e) {
    // A full localStorage cannot accept the retired copy. Removing the source
    // anyway would be the hard delete this plan exists to avoid, so the row
    // stays where it is and the next boot tries again.
    reportSceneStorageError({ op: 'write-scene', cause: e });
    return false;
  }
}

// ─── Orphans and folder projects ────────────────────────────────────────

/**
 * Body pointers with no catalogue row (R1-S5).
 *
 * Draft slots are excluded, and that exclusion is load-bearing rather than
 * tidy: `listSceneGlbIds()` returns the raw key tails, so `draft/<id>` and
 * `draft/<baseKey>` come back looking exactly like scene ids. Adopting one as a
 * "Recovered …" document would turn every unsaved autosave in the profile into a
 * permanent document card.
 */
function listOrphanBodies(rowIds: readonly string[]): string[] {
  const known = new Set(rowIds);
  return listSceneGlbIds().filter(id =>
    !id.startsWith(DRAFT_SLOT_PREFIX)
    && !known.has(id)
    && !resolveDocumentAlias(id)
    && !readSceneOwner(id)?.cachedFrom
    && readSceneGlbPointer(id) !== null,
  );
}

/** `scn_`-shaped scene document ids of a folder project (§2.3 step 5). */
function folderSceneIdsToAlias(project: RvProject | null): string[] {
  if (!project) return [];
  return documentsOf(project)
    .filter(d => d.section === 'scenes' && typeof d.id === 'string' && d.id.startsWith('scn_'))
    .map(d => d.id);
}

// ─── Small helpers ──────────────────────────────────────────────────────

async function readQuota(): Promise<{ usage?: number; quota?: number } | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return null;
    return {
      ...(typeof estimate.usage === 'number' ? { usage: estimate.usage } : {}),
      ...(typeof estimate.quota === 'number' ? { quota: estimate.quota } : {}),
    };
  } catch {
    return null;
  }
}

/** Strip everything a file name may not carry, without inventing a new name. */
function safeFileName(raw: string): string {
  return (raw ?? '')
    .trim()
    .replace(/\.(scene\.)?glb$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
}

function normalisePath(path: string): string {
  return (path ?? '').trim().replace(/^\/+/, '').toLowerCase();
}

// ─── Test support ───────────────────────────────────────────────────────

/** Forget the marker and empty the graveyard. Tests only. */
export function __resetWorkspaceMigrationForTests(): void {
  const doomed: string[] = [SCENES_MIGRATION_MARKER_KEY];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS_KEY_SCENES_RETIRED_PREFIX)) doomed.push(k);
  }
  for (const k of doomed) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

/** Every retired key currently in the graveyard. Tests and the restore snippet. */
export function listRetiredKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_KEY_SCENES_RETIRED_PREFIX)) out.push(k);
    }
  } catch { /* ignore */ }
  return out.sort();
}
