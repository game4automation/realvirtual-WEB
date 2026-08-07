// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-asset-ops — rename, duplicate, delete and re-collect a library asset
 * (plan-372 §2.6.5 / Phase 9).
 *
 * All four operate on the active project's `library/` folder through the
 * `ProjectBackend`, so one implementation serves a folder project (disk) and a
 * browser project (OPFS) alike.
 *
 * ## Delete is a move, not a delete
 *
 * "Delete" puts the asset in `library/.trash/` and leaves it there. A library
 * asset can be the only copy of hours of authoring work, and a mis-click must
 * not be terminal. `.trash/` is excluded from `.rvprojectignore` and from the
 * `.rvproject` export, so the safety net never travels or bloats an archive.
 *
 * ## The sidecar follows the bytes
 *
 * Every operation updates `library.json` in the same pass: a rename that left
 * the metadata behind would silently drop the asset's collections, which is the
 * exact failure the sidecar exists to prevent. Metadata is written *after* the
 * bytes, so a torn operation leaves an asset without metadata (recoverable —
 * the folder fallback applies) rather than metadata without an asset.
 */

import { buildEmptyGlbBlob } from '../hmi/scene/empty-glb';
import type { ProjectBackend } from '../project/backends/project-backend';
import {
  SIDECAR_FILENAME,
  emptySidecar,
  parseSidecar,
  serialiseSidecar,
  withAssetMeta,
  withRenamedAsset,
  type LibrarySidecarAsset,
  type LibrarySidecarV1,
} from './library-sidecar';

/** Root folder of a project's own assets. */
export const LIBRARY_FOLDER = 'library';

/** Where deleted assets go. Never exported, never scanned as a catalog. */
export const TRASH_FOLDER = '.trash';

export type AssetOpResult =
  | { kind: 'ok' }
  | { kind: 'exists'; message: string }
  | { kind: 'error'; message: string };

const ok: AssetOpResult = { kind: 'ok' };

/** Full backend path for an asset given its path relative to `library/`. */
function libPath(relPath: string): string {
  return `${LIBRARY_FOLDER}/${relPath}`;
}

/** Read the sidecar, tolerating absence and corruption alike. */
async function readSidecar(backend: ProjectBackend): Promise<LibrarySidecarV1> {
  const resolved = await backend.readBlobUrl(libPath(SIDECAR_FILENAME));
  if (!resolved) return emptySidecar();
  try {
    const text = await (await fetch(resolved.url)).text();
    // A sidecar we cannot parse must not be treated as empty and rewritten —
    // that would destroy a newer build's metadata. Callers get an empty view;
    // `writeSidecar` is what refuses to clobber, see below.
    return parseSidecar(text) ?? emptySidecar();
  } catch {
    return emptySidecar();
  } finally {
    resolved.release();
  }
}

/** True when a sidecar file exists but cannot be parsed by this build. */
async function sidecarIsUnreadable(backend: ProjectBackend): Promise<boolean> {
  const resolved = await backend.readBlobUrl(libPath(SIDECAR_FILENAME));
  if (!resolved) return false;                 // absent is fine
  try {
    return parseSidecar(await (await fetch(resolved.url)).text()) === null;
  } catch {
    return false;
  } finally {
    resolved.release();
  }
}

/**
 * Persist the sidecar — unless the existing one is unreadable.
 *
 * Overwriting a file we could not parse is how a user opening their project in
 * an older build would lose every collection they had set. Skipping the write
 * loses only the current edit, and says so.
 */
async function writeSidecar(backend: ProjectBackend, sidecar: LibrarySidecarV1): Promise<void> {
  if (await sidecarIsUnreadable(backend)) {
    throw new Error(
      `${SIDECAR_FILENAME} was written by a newer version and cannot be updated safely.`,
    );
  }
  await backend.writeBlob(
    libPath(SIDECAR_FILENAME),
    new Blob([serialiseSidecar(sidecar)], { type: 'application/json' }),
  );
}

/** Copy the bytes at `from` to `to`. Returns false when the source is gone. */
async function copyBlob(backend: ProjectBackend, from: string, to: string): Promise<boolean> {
  const resolved = await backend.readBlobUrl(libPath(from));
  if (!resolved) return false;
  try {
    const blob = await (await fetch(resolved.url)).blob();
    await backend.writeBlob(libPath(to), blob);
    return true;
  } finally {
    resolved.release();
  }
}

/** True when an asset already exists at `relPath`. */
async function exists(backend: ProjectBackend, relPath: string): Promise<boolean> {
  const resolved = await backend.readBlobUrl(libPath(relPath));
  if (!resolved) return false;
  resolved.release();
  return true;
}

/**
 * Create an empty asset in the project library.
 *
 * "New asset" used to jump straight into the editor, which meant the project
 * gained nothing until the user saved — abandon the editor and there was never
 * an asset. Writing a minimal valid GLB up front makes the row real
 * immediately: it can be renamed, opened later, and it survives a reload.
 *
 * The name is probed like {@link duplicateAsset} does, so clicking twice
 * produces two assets rather than a collision.
 */
export async function createEmptyAsset(
  backend: ProjectBackend,
  baseName = 'New asset',
): Promise<AssetOpResult & { newPath?: string }> {
  try {
    let target = `${baseName}.glb`;
    for (let n = 2; await exists(backend, target); n++) target = `${baseName} ${n}.glb`;
    await backend.writeBlob(libPath(target), buildEmptyGlbBlob());
    return { ...ok, newPath: target };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Rename an asset, keeping it in the same folder.
 *
 * Refuses to overwrite an existing name — silently replacing another asset is
 * the one outcome a rename must never produce.
 */
export async function renameAsset(
  backend: ProjectBackend,
  relPath: string,
  newFileName: string,
): Promise<AssetOpResult> {
  try {
    const segments = relPath.split('/');
    segments.pop();
    const target = [...segments, newFileName].join('/');
    if (target === relPath) return ok;
    if (await exists(backend, target)) {
      return { kind: 'exists', message: `"${newFileName}" already exists in this folder.` };
    }
    if (!(await copyBlob(backend, relPath, target))) {
      return { kind: 'error', message: `"${relPath}" could not be read.` };
    }
    await backend.deleteBlob(libPath(relPath));
    await writeSidecar(backend, withRenamedAsset(await readSidecar(backend), relPath, target));
    return ok;
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Duplicate an asset next to itself, appending " copy" (then " copy 2", …).
 *
 * The generated name is probed rather than assumed, so duplicating three times
 * produces three assets instead of two failures.
 */
export async function duplicateAsset(
  backend: ProjectBackend,
  relPath: string,
): Promise<AssetOpResult & { newPath?: string }> {
  try {
    const segments = relPath.split('/');
    const fileName = segments.pop() ?? relPath;
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';

    let target = '';
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
      const path = [...segments, candidate].join('/');
      if (!(await exists(backend, path))) { target = path; break; }
    }
    if (!target) return { kind: 'error', message: 'Too many copies of this asset already exist.' };

    if (!(await copyBlob(backend, relPath, target))) {
      return { kind: 'error', message: `"${relPath}" could not be read.` };
    }
    // The copy inherits the original's metadata — collections and tags are
    // what make a duplicate useful as a starting point.
    const sidecar = await readSidecar(backend);
    const meta = sidecar.assets[relPath];
    if (meta) await writeSidecar(backend, withAssetMeta(sidecar, target, meta));
    return { kind: 'ok', newPath: target };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Move an asset into `library/.trash/`.
 *
 * Deliberately recoverable: a library asset can be the only copy of hours of
 * work. A name already in the trash gets a numeric suffix rather than being
 * overwritten — the trash is a safety net, and a safety net that discards its
 * own contents is not one.
 */
export async function deleteAsset(
  backend: ProjectBackend,
  relPath: string,
): Promise<AssetOpResult> {
  try {
    const fileName = relPath.split('/').pop() ?? relPath;
    let target = `${TRASH_FOLDER}/${fileName}`;
    for (let n = 2; n < 100 && (await exists(backend, target)); n++) {
      const dot = fileName.lastIndexOf('.');
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : '';
      target = `${TRASH_FOLDER}/${stem} ${n}${ext}`;
    }
    if (!(await copyBlob(backend, relPath, target))) {
      return { kind: 'error', message: `"${relPath}" could not be read.` };
    }
    await backend.deleteBlob(libPath(relPath));
    // Drop the metadata: the asset is no longer in the library, and a stale
    // record would reattach itself to a future asset of the same path.
    await writeSidecar(backend, withAssetMeta(await readSidecar(backend), relPath, {}));
    return ok;
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Replace an asset's collections (the Collections editor's single write). */
export async function setAssetCollections(
  backend: ProjectBackend,
  relPath: string,
  collections: string[],
): Promise<AssetOpResult> {
  try {
    const sidecar = await readSidecar(backend);
    const previous: LibrarySidecarAsset = sidecar.assets[relPath] ?? {};
    // Trim, drop blanks and de-duplicate: collection names are user-typed and
    // "Conveyors " must not become a second chip beside "Conveyors".
    const cleaned = [...new Set(collections.map(c => c.trim()).filter(Boolean))];
    await writeSidecar(backend, withAssetMeta(sidecar, relPath, { ...previous, collections: cleaned }));
    return ok;
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
