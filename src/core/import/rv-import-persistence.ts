// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-import-persistence.ts — reload-safe persistence for additive imports
 * (plan-238 §2.2a, re-homed by plan-372 phase 11).
 *
 * Every additive non-catalog import (STEP, Onshape, local GLB file) is written
 * as a GLB into the OPEN PROJECT's `library/imports/` through the project
 * backend — to disk for a folder project, to OPFS for a browser one — and
 * turned into a REGULAR catalog entry. The placement's op-log record then
 * references that entry's stable `catalogId`, so restore resolves it through
 * the standard catalog path. No special case, no `blob:` URL in the op log as
 * the only reference.
 *
 * Fallback: with no writable project open, the import still places via an
 * ephemeral blob-URL entry, but the outcome is flagged `persisted: false` with
 * a user-facing warning — a visible degradation instead of a silent reload
 * loss.
 */

import type { LibraryCatalogEntry } from '../../plugins/layout-planner/rv-layout-store';
import { getProjectStore } from '../project/project-store';

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
    // `localPath` came from a free-name probe just above, so the target is new.
    await backend.writeDocument(
      `library/${localPath}`,
      new Uint8Array(await blob.arrayBuffer()),
      { expectedRevision: 'create' },
    );

    // Read back through the backend so the URL points at the stored bytes,
    // identical to what the scanner serves after a rescan.
    const resolved = await backend.readDocumentUrl(`library/${localPath}`);
    if (!resolved) {
      return ephemeralEntry(base, blob,
        'The import could not be read back after writing — it will NOT survive a reload.');
    }
    // Ownership passes to the catalog entry — and now something actually HOLDS
    // it (plan-709 §2.5). `holdImportedGlbUrl` releases whatever the same path
    // held before, so re-importing over an entry replaces its URL instead of
    // stranding one, and the whole set is released when the project changes.
    const glbUrl = holdImportedGlbUrl(localPath, resolved);

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

// ─── Object-URL ownership (plan-709 §2.5) ─────────────────────────────────

/**
 * The object URLs handed to catalog entries, by their library-relative path.
 *
 * `persistImportedGlb` used to mint a URL, write "ownership passes to the
 * catalog entry" next to it and hand it over — to an entry that owns nothing
 * and cannot revoke anything. Blob data lives until its URL is revoked, so
 * every import leaked its own bytes a second time, once more per re-import of
 * the same path. This map is the owner that comment claimed existed.
 *
 * Released on replacement (same path re-imported) and when the open project
 * changes — a catalog belongs to a project, and its entries are meaningless
 * outside it. Not a `FinalizationRegistry`: see plan-709 §7.
 */
const importedUrls = new Map<string, { url: string; release: () => void }>();
let projectWatch: { id: string | null; off: () => void } | null = null;

function holdImportedGlbUrl(
  localPath: string,
  resolved: { url: string; release: () => void },
): string {
  releaseImportedGlbUrl(localPath);
  importedUrls.set(localPath, resolved);
  watchProjectForRelease();
  return resolved.url;
}

/** Release the URL held for one import path. Safe to call for an unknown path. */
export function releaseImportedGlbUrl(localPath: string): void {
  const held = importedUrls.get(localPath);
  if (!held) return;
  importedUrls.delete(localPath);
  held.release();
}

/** Release every held import URL — the project's catalog is going away. */
export function releaseAllImportedGlbUrls(): void {
  for (const held of importedUrls.values()) held.release();
  importedUrls.clear();
}

/**
 * Subscribe once, lazily, to the project store, so a project switch frees the
 * previous project's import URLs.
 *
 * Lazily rather than at module scope: importing this file must not by itself
 * attach a listener to a singleton, or every test that touches an import
 * helper inherits one.
 */
function watchProjectForRelease(): void {
  if (projectWatch) return;
  const store = getProjectStore();
  const current = () => store.getProject()?.id ?? null;
  const watch = { id: current(), off: () => {} };
  watch.off = store.subscribe(() => {
    const next = current();
    if (next === watch.id) return;
    watch.id = next;
    releaseAllImportedGlbUrls();
  });
  projectWatch = watch;
}

/** Test seam: drop the subscription and every held URL. */
export function _resetImportedGlbUrlsForTests(): void {
  releaseAllImportedGlbUrls();
  projectWatch?.off();
  projectWatch = null;
}

/** True when the backend already holds something at `relPath`. */
async function backendHasFile(
  backend: NonNullable<ReturnType<ReturnType<typeof getProjectStore>['getBackend']>>,
  relPath: string,
): Promise<boolean> {
  const resolved = await backend.readDocumentUrl(relPath);
  if (!resolved) return false;
  resolved.release();
  return true;
}
