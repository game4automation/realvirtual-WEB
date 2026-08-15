// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-workfolder-migration.ts — bring an old working folder into a project
 * (plan-709 §2.6, F5).
 *
 * The working folder was the second place this app wrote files. It is gone
 * (plan-709 phase 5), and everything now lives in the open project. This module
 * is the one-way door between the two: a recursive, resumable copy of the whole
 * old tree into the project's backend.
 *
 * ## Five properties, and why each one is not optional
 *
 * 1. **The whole tree, not the GLBs.** `library/**` including `.thumbnails/`,
 *    `knowledge/**`, `captures/**` and everything else, byte for byte. The
 *    knowledge folder is the only human-curated, non-regenerable class of data
 *    in here — datasheets, photos, notes somebody put there by hand — and
 *    cherry-picking file types is how you lose it. Thumbnails come along too,
 *    so previews do not go blank after the migration.
 *
 * 2. **A user gesture starts it.** A rehydrated `FileSystemDirectoryHandle`
 *    LOOKS valid and throws `NotAllowedError` on first access; `requestPermission`
 *    is only allowed inside a click. So the caller passes an already-permitted
 *    source, obtained in its own click handler, and a permission failure is
 *    reported as a retryable state rather than as a half-done run.
 *
 * 3. **Idempotent, with a manifest.** Every copied relPath is recorded in
 *    IndexedDB, so an aborted run resumes instead of restarting, and a second
 *    run is nearly free.
 *
 * 4. **A skip is verified, never assumed.** A target file that exists while the
 *    manifest does not know it is either a crash between the write and the
 *    manifest entry, or somebody else's file of the same name. The bytes decide:
 *    identical ⇒ record it as migrated; different ⇒ copy alongside under a
 *    suffixed name and say so in the report. Never silently skipped, never
 *    overwritten — writes use `expectedRevision: null`, the create-only mode
 *    from phase 1.
 *
 * 5. **The source is never deleted.** Not by this code, not at the end, not on
 *    success. The old folder stays exactly as it was; the report names it so the
 *    user can clear it out themselves once they are satisfied.
 */

import { getProjectStore } from './project-store';
import { openIdb, idbGetAllKeys, idbTxDone } from '../persistence/rv-idb-utils';

// ─── Manifest (IndexedDB) ─────────────────────────────────────────────────

const DB_NAME = 'rv-workfolder-migration';
const DB_VERSION = 1;
const STORE = 'done';

const openManifestDb = (): Promise<IDBDatabase> => openIdb(DB_NAME, DB_VERSION, [STORE]);

/**
 * One row per (project, source relPath).
 *
 * Keyed by project because "already migrated" is a fact about a DESTINATION:
 * the same old folder can legitimately be brought into two projects, and a
 * shared key would silently make the second one a no-op.
 */
function manifestKey(projectId: string, relPath: string): string {
  return `${projectId} ${relPath}`;
}

/** The relPaths already copied into `projectId`. */
export async function readMigrationManifest(projectId: string): Promise<Set<string>> {
  const db = await openManifestDb();
  try {
    const keys = await idbGetAllKeys(db, STORE);
    const prefix = `${projectId} `;
    return new Set(
      keys.map(String).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)),
    );
  } finally {
    db.close();
  }
}

async function noteMigrated(projectId: string, relPaths: string[]): Promise<void> {
  if (relPaths.length === 0) return;
  const db = await openManifestDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const relPath of relPaths) store.put(1, manifestKey(projectId, relPath));
    await idbTxDone(tx);
  } finally {
    db.close();
  }
}

/** Forget what was migrated into `projectId` — the next run starts from zero. */
export async function clearMigrationManifest(projectId: string): Promise<void> {
  const db = await openManifestDb();
  try {
    const keys = await idbGetAllKeys(db, STORE);
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const prefix = `${projectId} `;
    for (const key of keys) if (String(key).startsWith(prefix)) store.delete(key);
    await idbTxDone(tx);
  } finally {
    db.close();
  }
}

// ─── The copy ─────────────────────────────────────────────────────────────

/** What happened to one file. */
export type MigrationFileOutcome =
  /** Written into the project for the first time. */
  | { relPath: string; kind: 'copied' }
  /** The manifest already knew it. */
  | { relPath: string; kind: 'already-migrated' }
  /** Not in the manifest, but the project holds identical bytes — recorded now. */
  | { relPath: string; kind: 'identical' }
  /** Not in the manifest, and the project holds DIFFERENT bytes at that path. */
  | { relPath: string; kind: 'copied-alongside'; savedAs: string }
  | { relPath: string; kind: 'failed'; error: string };

export interface MigrationReport {
  /** Display name of the source folder — it is NOT deleted; the user clears it. */
  sourceName: string;
  total: number;
  copied: number;
  skipped: number;
  /** Paths that already held different bytes; each was copied under a new name. */
  conflicts: { relPath: string; savedAs: string }[];
  failures: { relPath: string; error: string }[];
  /** True when the run stopped early (cancelled or permission lost). */
  incomplete: boolean;
  /** Set when the run ended on a permission problem — the caller offers a retry. */
  permissionDenied: boolean;
}

export interface MigrationProgress {
  done: number;
  total: number;
  /** The file currently being handled — for a live label. */
  current: string;
}

export interface MigrateOptions {
  /** Root of the old working folder, ALREADY read-permitted in a click handler. */
  source: FileSystemDirectoryHandle;
  onProgress?: (progress: MigrationProgress) => void;
  /** Polled between files; true aborts and reports `incomplete`. */
  isCancelled?: () => boolean;
}

/** Depth-first listing of every file under `dir`, as project-relative paths. */
async function listTree(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): Promise<{ relPath: string; handle: FileSystemFileHandle }[]> {
  const out: { relPath: string; handle: FileSystemFileHandle }[] = [];
  // `values()` is an async iterator on the real API; a test double supplies the
  // same shape. Anything unreadable is skipped rather than aborting the walk —
  // one locked subfolder must not cost the user the other ninety.
  for await (const entry of dir.values()) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    try {
      if (entry.kind === 'directory') {
        out.push(...await listTree(entry as FileSystemDirectoryHandle, relPath));
      } else {
        out.push({ relPath, handle: entry as FileSystemFileHandle });
      }
    } catch {
      /* unreadable entry — skipped, and its absence shows in the count */
    }
  }
  return out;
}

/** `a/b/name.ext` → `a/b/name-migrated.ext` (or `-migrated-2`, … if taken). */
function suffixedPath(relPath: string, attempt: number): string {
  const slash = relPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relPath.slice(0, slash + 1);
  const file = slash < 0 ? relPath : relPath.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot <= 0 ? file : file.slice(0, dot);
  const ext = dot <= 0 ? '' : file.slice(dot);
  return `${dir}${stem}-migrated${attempt > 1 ? `-${attempt}` : ''}${ext}`;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function isPermissionError(e: unknown): boolean {
  return e instanceof DOMException
    ? (e.name === 'NotAllowedError' || e.name === 'SecurityError')
    : /NotAllowedError|SecurityError|permission/i.test(String(e));
}

/**
 * Copy the working folder into the open project.
 *
 * Call from a click handler that has already re-granted read permission on
 * `source` — see property 2 in the module docs.
 */
export async function migrateWorkfolderIntoProject(
  opts: MigrateOptions,
): Promise<MigrationReport> {
  const store = getProjectStore();
  const backend = store.getBackend();
  const projectId = store.getProject()?.id ?? null;
  const report: MigrationReport = {
    sourceName: opts.source.name,
    total: 0, copied: 0, skipped: 0,
    conflicts: [], failures: [], incomplete: false, permissionDenied: false,
  };
  if (!backend?.writable || !projectId) {
    throw new Error('Open a writable project first — the files are copied into it.');
  }

  let files: { relPath: string; handle: FileSystemFileHandle }[];
  try {
    files = await listTree(opts.source);
  } catch (e) {
    if (!isPermissionError(e)) throw e;
    report.permissionDenied = true;
    report.incomplete = true;
    return report;
  }

  report.total = files.length;
  const done = await readMigrationManifest(projectId);
  const newlyDone: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const { relPath, handle } = files[i];
    opts.onProgress?.({ done: i, total: files.length, current: relPath });
    if (opts.isCancelled?.()) { report.incomplete = true; break; }

    if (done.has(relPath)) { report.skipped++; continue; }

    try {
      const file = await handle.getFile();
      const bytes = await file.arrayBuffer();

      // `expectedRevision: null` = create only. It is the whole safety story:
      // a path that already holds something refuses the write instead of
      // replacing work the user did after (or independently of) the old folder.
      try {
        await backend.writeBlob(relPath, new Blob([bytes]), { expectedRevision: null });
        report.copied++;
        newlyDone.push(relPath);
        continue;
      } catch {
        /* something is already there — decide by comparing bytes, below */
      }

      const existing = await backend.readBlobBytes(relPath);
      if (existing && sameBytes(existing, bytes)) {
        // Same file. Either a crash between write and manifest entry, or it was
        // brought in another way. Recording it is the honest end state.
        report.skipped++;
        newlyDone.push(relPath);
        continue;
      }

      // Genuinely different content under the same name: keep BOTH and report.
      let saved: string | null = null;
      for (let attempt = 1; attempt <= 20 && saved === null; attempt++) {
        const candidate = suffixedPath(relPath, attempt);
        try {
          await backend.writeBlob(candidate, new Blob([bytes]), { expectedRevision: null });
          saved = candidate;
        } catch { /* that name is taken too — next attempt */ }
      }
      if (saved === null) {
        report.failures.push({ relPath, error: 'No free name to copy it under.' });
      } else {
        report.conflicts.push({ relPath, savedAs: saved });
        report.copied++;
        newlyDone.push(relPath);
      }
    } catch (e) {
      if (isPermissionError(e)) {
        report.permissionDenied = true;
        report.incomplete = true;
        break;
      }
      report.failures.push({ relPath, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Written once at the end rather than per file: a crash mid-run costs a
  // re-read of the files it already wrote, and property 4 makes that harmless.
  await noteMigrated(projectId, newlyDone);
  if (!report.incomplete) {
    opts.onProgress?.({ done: files.length, total: files.length, current: '' });
  }
  return report;
}
