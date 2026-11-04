// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-library-migration — `libraries[]` URL entries of the realvirtual
 * library → `{projectId: 'prj_realvirtual_library', hint}` (plan-778 F14).
 *
 * Until plan-778 a project subscribed to the realvirtual library through a
 * catalog URL: the bundled `library/catalog.json` (in any spelling) or the
 * public GitHub repository. The library is a normal project now, named by id,
 * so those entries are converted once. The pure functions here decide WHAT
 * changes; WHEN it is written is the project store's call (the first
 * manifest-writing save of a writable project, `_foldLibraryMigration`) and
 * the user's (the Problems row's **Update**, command `library.migrate`).
 *
 * ## Rules
 *
 *  - **Marker in the same delta.** The migration returns the new manifest with
 *    `rv-project/library-project-migration` already set; there is no second
 *    write that could leave the library converted but unmarked (or marked and
 *    not converted).
 *  - **A decision is made once.** `libraries` ABSENT → the realvirtual library
 *    is added (Decision 7: explicit but pre-filled). `libraries` present — even
 *    `[]` — is the author's statement and stays as it is. Either way the marker
 *    is set, so a library the user removes later is never put back.
 *  - **External catalogs are untouched** (`/_tmp/interroll/catalog.json`, SimReady, …),
 *    and so is a partner's own `https://partner.example/library/catalog.json`: a
 *    host-qualified catalog URL converts only on a realvirtual host
 *    (`isRealvirtualCatalogUrl` → `isBundledRealvirtualCatalogUrl`, one predicate
 *    for this migration and the legacy resolution).
 *  - **`kind: 'customer'` is never migrated on its own** (Decision B): a
 *    customer's manifest changes only when someone clicks **Update**
 *    ({@link migrateLibraryProject} with `force`). Until then the old URL keeps
 *    resolving through the legacy path.
 *  - **Every field of an entry survives** — `label` and unknown keys of a
 *    converted entry are kept; the URL moves into `hint`.
 *  - **Reversible.** The marker records the entries it replaced, so
 *    {@link rollbackLibraryMigration} restores them.
 *
 * Read-only projects are the caller's concern: this module never knows
 * whether a manifest can be written.
 */

import {
  LIBRARY_PROJECT_MIGRATION_MARKER,
  REALVIRTUAL_LIBRARY_LABEL,
  REALVIRTUAL_LIBRARY_PROJECT_REF as MIGRATION_LIBRARY_PROJECT_ID,
  type RvProject,
} from './rv-project-types';
import { isRealvirtualCatalogUrl } from '../library/library-origin';

export { LIBRARY_PROJECT_MIGRATION_MARKER, REALVIRTUAL_LIBRARY_LABEL };

export interface LibraryMigrationMarker {
  /** ISO time of the migration. */
  at: string;
  /** The realvirtual library was ADDED because `libraries` was absent. */
  added: boolean;
  /** `libraries` existed before the migration (rollback removes the key again when it did not). */
  hadLibraries: boolean;
  /** The entries that were replaced by the single realvirtual entry, verbatim (first = converted in place, rest = dropped duplicates). */
  replaced: unknown[];
  /** An id entry for the realvirtual library was already listed: rollback keeps it, label and all. */
  hadIdEntry?: boolean;
  /** Born with the library (`newProject()`): nothing was changed. */
  born?: boolean;
  [key: string]: unknown;
}

export type LibraryMigrationOutcome = 'migrated' | 'already' | 'skipped';

export interface LibraryMigrationResult {
  outcome: LibraryMigrationOutcome;
  project: RvProject;
  /** How many URL entries were converted (0 when none). */
  converted: number;
  /** The realvirtual library was added to an absent `libraries`. */
  added: boolean;
  reason?: string;
}

/** The recorded marker, or null when this project was never migrated. */
export function readLibraryMigrationMarker(project: RvProject | null | undefined): LibraryMigrationMarker | null {
  const raw = project?.[LIBRARY_PROJECT_MIGRATION_MARKER];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.at !== 'string') return null;
  return {
    ...rec,
    at: rec.at,
    added: rec.added === true,
    hadLibraries: rec.hadLibraries !== false,
    replaced: Array.isArray(rec.replaced) ? rec.replaced : [],
  };
}

/** The URL of a `libraries[]` entry that is a plain URL entry (bare string or `{url}` without `projectId`), else null. */
function urlOfEntry(item: unknown): string | null {
  if (typeof item === 'string') return item.trim() || null;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.projectId === 'string' && rec.projectId.trim() !== '') return null;
  return typeof rec.url === 'string' && rec.url.trim() !== '' ? rec.url.trim() : null;
}

function isRealvirtualProjectEntry(item: unknown): boolean {
  return !!item && typeof item === 'object' && !Array.isArray(item)
    && (item as Record<string, unknown>).projectId === MIGRATION_LIBRARY_PROJECT_ID;
}

/** Is `url` a realvirtual library catalog URL this migration converts? */
export function isMigratableLibraryUrl(url: string | null | undefined): boolean {
  return isRealvirtualCatalogUrl(url);
}

/** True when `project` lists at least one realvirtual catalog URL (the trigger of the customer **Update** row). */
export function hasLegacyRealvirtualLibraryUrl(project: RvProject | null | undefined): boolean {
  const list = project?.libraries as unknown;
  if (!Array.isArray(list)) return false;
  return list.some((item) => isMigratableLibraryUrl(urlOfEntry(item)));
}

/**
 * Should the Problems row "Library reference can be updated" be shown for `project`?
 * Customer projects only (Decision B), not yet migrated, with a convertible entry.
 */
export function libraryReferenceUpdatePending(project: RvProject | null | undefined): boolean {
  return !!project && project.kind === 'customer'
    && !readLibraryMigrationMarker(project)
    && hasLegacyRealvirtualLibraryUrl(project);
}

export interface MigrateLibraryOptions {
  now?: () => string;
  /** The user asked for it (**Update**): a `kind: 'customer'` project migrates too. */
  force?: boolean;
}

/**
 * Converts the realvirtual library references of `project`. Pure — the caller
 * writes the returned manifest. See the file header for the rules.
 */
export function migrateLibraryProject(project: RvProject, opts: MigrateLibraryOptions = {}): LibraryMigrationResult {
  const none = { converted: 0, added: false };
  if (readLibraryMigrationMarker(project)) return { outcome: 'already', project, ...none };
  // The realvirtual library itself never lists itself (plan-778 review E6).
  if (project.id === MIGRATION_LIBRARY_PROJECT_ID) {
    return { outcome: 'skipped', project, ...none, reason: 'the realvirtual library is not a library of itself' };
  }
  if (project.kind === 'customer' && !opts.force) {
    return { outcome: 'skipped', project, ...none, reason: 'customer projects are only updated on request' };
  }

  const at = (opts.now ?? (() => new Date().toISOString()))();
  const raw = project.libraries as unknown;
  const hadLibraries = Array.isArray(raw);
  const replaced: unknown[] = [];
  let converted = 0;
  let added = false;
  let libraries: unknown[] | undefined;
  const hadIdEntry = hadLibraries && (raw as unknown[]).some(isRealvirtualProjectEntry);

  if (!hadLibraries) {
    libraries = [{ projectId: MIGRATION_LIBRARY_PROJECT_ID, label: REALVIRTUAL_LIBRARY_LABEL }];
    added = true;
  } else {
    const out: unknown[] = [];
    let haveLibrary = hadIdEntry;
    for (const item of raw as unknown[]) {
      const url = urlOfEntry(item);
      if (url === null || !isMigratableLibraryUrl(url)) { out.push(item); continue; }
      replaced.push(item);
      converted++;
      if (haveLibrary) continue;           // the id is already listed: the URL entry is a duplicate
      haveLibrary = true;
      const base: Record<string, unknown> = typeof item === 'string' ? {} : { ...(item as Record<string, unknown>) };
      delete base.url;
      const hint = typeof base.hint === 'string' && base.hint.trim() !== '' ? base.hint : url;
      out.push({ ...base, projectId: MIGRATION_LIBRARY_PROJECT_ID, hint });
    }
    libraries = converted > 0 ? out : undefined;
  }

  const marker: LibraryMigrationMarker = { at, added, hadLibraries, replaced };
  if (hadIdEntry) marker.hadIdEntry = true;
  const next: RvProject = { ...project, [LIBRARY_PROJECT_MIGRATION_MARKER]: marker };
  if (libraries) next.libraries = libraries as RvProject['libraries'];
  return { outcome: 'migrated', project: next, converted, added };
}

/**
 * Undo {@link migrateLibraryProject}: the entries it replaced come back where
 * the realvirtual entry stands, an entry it added goes, and the marker is
 * removed. An entry the user already removed is not resurrected. A project
 * without a marker is returned as it is.
 */
export function rollbackLibraryMigration(project: RvProject): RvProject {
  const marker = readLibraryMigrationMarker(project);
  if (!marker) return project;
  const { [LIBRARY_PROJECT_MIGRATION_MARKER]: _marker, ...rest } = project as Record<string, unknown>;
  const next = rest as RvProject;
  const list = Array.isArray(next.libraries) ? (next.libraries as unknown[]) : [];
  const out: unknown[] = [];
  let placed = false;
  for (const item of list) {
    if (!isRealvirtualProjectEntry(item)) { out.push(item); continue; }
    if (marker.added) { placed = true; continue; }                    // it was added by the migration: gone again
    if (marker.hadIdEntry) {                                           // the user's own entry stays
      out.push(item);
      if (!placed) { out.push(...marker.replaced); placed = true; }
      continue;
    }
    if (marker.replaced.length > 0 && !placed) { out.push(...marker.replaced); placed = true; continue; }
    out.push(item);
  }
  if (out.length === 0 && !marker.hadLibraries) delete next.libraries;
  else next.libraries = out as RvProject['libraries'];
  return next;
}
