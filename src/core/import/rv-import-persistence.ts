// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-import-persistence.ts — reload-safe persistence for additive imports
 * (plan-238 §2.2a).
 *
 * Every additive non-catalog import (STEP, Onshape, local GLB file) is
 * written as a GLB into the Local Working Folder (`library/imports/`) and
 * turned into a REGULAR catalog entry — the same entry the local-folder
 * scanner would produce on the next reload. The placement's op-log record
 * then references that entry's stable `catalogId`, so restore resolves it
 * through the standard local-catalog path. No special case, no `blob:` URL
 * in the op log as the only reference.
 *
 * Fallback: if no working folder is configured (or write permission is
 * denied), the import still places via an ephemeral blob-URL entry, but the
 * outcome is flagged `persisted: false` with a user-facing warning — a
 * visible degradation instead of a silent reload loss.
 */

import type { LibraryCatalogEntry } from '../../plugins/layout-planner/rv-layout-store';
import { getProjectStore } from '../project/project-store';
import {
  getWorkFolder,
  getOrCreateSubfolder,
  requestWriteAccess,
  writeBlobFile,
  readFileAsUrl,
} from '../engine/rv-local-filesystem';

/** Subfolder inside `<working-folder>/library/` that receives imports. */
export const IMPORTS_SUBFOLDER = 'imports';

/**
 * Entry-id convention of the local-folder scanner
 * (`rv-layout-store._loadLibrarySubfolder`). MUST stay in sync — the
 * placement's `catalogId` is this id, and after a reload the re-scanned
 * catalog must produce the identical id for the same file so
 * `resolvePlacementUrl` finds the entry again.
 */
export function localEntryIdForPath(prefixedPath: string): string {
  return `local-${prefixedPath.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
}

/** Display-name convention of the local-folder scanner. */
export function localEntryNameForFile(filename: string): string {
  const stem = filename.replace(/\.(glb|splat|ksplat|ply)$/i, '');
  return stem.replace(/[_-]/g, ' ');
}

/** Outcome of {@link persistImportedGlb}. */
export interface PersistImportOutcome {
  entry: LibraryCatalogEntry;
  /** true = written to the working folder (survives reload). */
  persisted: boolean;
  /** Set when persistence was skipped/failed (fallback blob entry in use). */
  warning?: string;
}

function sanitizeBaseName(name: string): string {
  const cleaned = name
    .replace(/\.(glb|step|stp)$/i, '')
    .replace(/[\\/:*?"<>|#%]/g, '_')
    .trim();
  return cleaned || 'import';
}

async function fileExists(dir: FileSystemDirectoryHandle, filename: string): Promise<boolean> {
  try {
    await dir.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}

/** Build the fallback (non-persisted) blob-URL entry. */
function ephemeralEntry(name: string, blob: Blob, warning: string): PersistImportOutcome {
  return {
    entry: {
      id: `import-${crypto.randomUUID()}`,
      name,
      category: 'custom',
      glbUrl: URL.createObjectURL(blob),
    },
    persisted: false,
    warning,
  };
}

/**
 * Persist imported GLB bytes into `<working-folder>/library/imports/` and
 * return a catalog entry matching the local-folder scanner's conventions
 * (id, name, category, collections, localPath). Falls back to an ephemeral
 * blob entry when no working folder is available — see module docs.
 */
export async function persistImportedGlb(
  name: string,
  data: ArrayBuffer | Blob,
): Promise<PersistImportOutcome> {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'model/gltf-binary' });
  const base = sanitizeBaseName(name);

  // plan-372 Phase 11: imports land in the ACTIVE PROJECT's library/imports/,
  // through the backend — so a folder project writes to disk and a browser
  // project to OPFS, with no work folder involved either way.
  const backend = getProjectStore().getBackend();
  if (!backend?.writable) {
    return ephemeralEntry(base, blob,
      'No writable project is open — the import will NOT survive a reload. ' +
      'Open or create a project (Projects) to keep imports.');
  }

  try {
    // Unique filename: never silently overwrite an unrelated same-name asset.
    let filename = `${base}.glb`;
    let n = 2;
    while (await backendHasFile(backend, `library/${IMPORTS_SUBFOLDER}/${filename}`)) {
      filename = `${base}-${n++}.glb`;
    }

    const localPath = `${IMPORTS_SUBFOLDER}/${filename}`;
    await backend.writeBlob(`library/${localPath}`, blob);

    // Read back through the backend so the URL points at the stored bytes,
    // identical to what the scanner serves after a rescan.
    const resolved = await backend.readBlobUrl(`library/${localPath}`);
    if (!resolved) {
      return ephemeralEntry(base, blob,
        'The import could not be read back after writing — it will NOT survive a reload.');
    }
    const glbUrl = resolved.url;   // ownership passes to the catalog entry

    const entry: LibraryCatalogEntry = {
      id: localEntryIdForPath(localPath),
      name: localEntryNameForFile(filename),
      category: 'custom',
      glbUrl,
      pivotToFloor: true,
      localPath,
      collections: [IMPORTS_SUBFOLDER],
    };
    return { entry, persisted: true };
  } catch (e) {
    return ephemeralEntry(base, blob,
      `Could not write the import into the project (${e instanceof Error ? e.message : String(e)}) ` +
      '— the import will NOT survive a reload.');
  }
}

/** True when the backend already holds something at `relPath`. */
async function backendHasFile(
  backend: NonNullable<ReturnType<ReturnType<typeof getProjectStore>['getBackend']>>,
  relPath: string,
): Promise<boolean> {
  const resolved = await backend.readBlobUrl(relPath);
  if (!resolved) return false;
  resolved.release();
  return true;
}
