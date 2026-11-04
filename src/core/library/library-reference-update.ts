// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-reference-update — the user-initiated half of the library reference
 * migration (plan-778 F14, Decision B).
 *
 * `rv-project-library-migration` converts the realvirtual catalog URLs of a
 * project to `{projectId, hint}`. A normal project is migrated on its first
 * manifest-writing save (`ProjectStore._foldLibraryMigration`). A project of
 * kind `customer` is NEVER written on its own — the manifest belongs to the
 * customer's delivery. For it this module shows a quiet Problems row,
 * "Library reference can be updated", whose **Update** button runs the registry
 * command `library.migrate`, which applies the same migration through
 * `applyManifestDelta`. Until then the old URL keeps resolving: the global
 * catalog source still serves it and the built-in realvirtual library project
 * answers legacy ids (Decisions B and C).
 */

import { clearProblem, reportProblem } from '../hmi/problems-store';
import { getProjectStore } from '../project/project-store';
import type { RvProject } from '../project/rv-project-types';
import {
  hasLegacyRealvirtualLibraryUrl,
  libraryReferenceUpdatePending,
  migrateLibraryProject,
  readLibraryMigrationMarker,
} from '../project/rv-project-library-migration';
import {
  NO_PROJECT_OPEN,
  PROJECT_READ_ONLY,
  PROJECT_SWITCHED,
  type AttachProjectStoreLike,
} from './project-library-attach';

export const LIBRARY_MIGRATE_COMMAND = 'library.migrate';
export const LIBRARY_REFERENCE_UPDATE_CODE = 'library-reference-update';
export const libraryReferenceUpdateProblemId = (projectId: string): string =>
  `${LIBRARY_REFERENCE_UPDATE_CODE}:${projectId}`;

export const NOTHING_TO_UPDATE = 'The library references of this project are already up to date.';

/** The slice of the project store this module follows. */
export interface ReferenceUpdateStoreLike extends AttachProjectStoreLike {
  subscribe(listener: () => void): () => void;
}

function writable(store: AttachProjectStoreLike): boolean {
  return (store.getBackend() as { writable?: boolean } | null)?.writable === true;
}

/** The Problems row of a customer project with a convertible library reference. */
export function libraryReferenceUpdateProblem(project: RvProject): Parameters<typeof reportProblem>[0] {
  return {
    id: libraryReferenceUpdateProblemId(project.id),
    severity: 'info',
    code: LIBRARY_REFERENCE_UPDATE_CODE,
    title: 'Library reference can be updated',
    detail: `Project '${project.name}' still names the realvirtual library by its catalog URL. `
      + 'Update writes the library by its project id into project.json (the old URL is kept as a hint). '
      + 'Nothing changes until you click Update; the old URL keeps working meanwhile.',
    quiet: true,
    action: { label: 'Update', commandId: LIBRARY_MIGRATE_COMMAND, args: {} },
  };
}

/**
 * Keep the Problems row in step with the open project: shown for a WRITABLE
 * customer project with a pending reference update, cleared when it is gone
 * (migrated, switched, closed). Returns the uninstall function.
 */
export function installLibraryReferenceUpdate(store: ReferenceUpdateStoreLike = getProjectStore() as unknown as ReferenceUpdateStoreLike): () => void {
  let shown: string | null = null;
  const sync = (): void => {
    const project = store.getProject();
    const want = project && libraryReferenceUpdatePending(project) && writable(store) ? project : null;
    if (shown && (!want || libraryReferenceUpdateProblemId(want.id) !== shown)) {
      clearProblem(shown);
      shown = null;
    }
    if (want) {
      reportProblem(libraryReferenceUpdateProblem(want));
      shown = libraryReferenceUpdateProblemId(want.id);
    }
  };
  const unsubscribe = store.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    if (shown) clearProblem(shown);
    shown = null;
  };
}

/** Why `library.migrate` is not offered right now, or null. */
export function migrateRefusal(store: AttachProjectStoreLike = getProjectStore() as unknown as AttachProjectStoreLike): string | null {
  const project = store.getProject();
  if (!project || !store.getBackend()) return NO_PROJECT_OPEN;
  if (!writable(store)) return PROJECT_READ_ONLY;
  if (readLibraryMigrationMarker(project)) return NOTHING_TO_UPDATE;
  return null;
}

export type MigrateLibraryResult =
  | { ok: true; converted: number; added: boolean; hadLegacyUrl: boolean }
  | { ok: false; reason: string };

/**
 * Apply the library reference migration to the open project now, as the user
 * asked (`force`: a customer project is converted too), through
 * `applyManifestDelta`. The identity of the project is re-checked INSIDE the
 * delta, like attach / detach: a switch during the write queue writes nothing
 * into the next project. Never throws.
 */
export async function applyLibraryReferenceUpdate(
  store: AttachProjectStoreLike = getProjectStore() as unknown as AttachProjectStoreLike,
): Promise<MigrateLibraryResult> {
  const before = store.getProject();
  const backendBefore = store.getBackend();
  if (!before || !backendBefore) return { ok: false, reason: NO_PROJECT_OPEN };
  if (readLibraryMigrationMarker(before)) return { ok: false, reason: NOTHING_TO_UPDATE };

  // The counts describe the project as the user saw it (plan-778 review E8): the
  // store folds the automatic migration into this very write BEFORE the delta
  // runs, so a non-customer project arrives in the delta already migrated.
  const preview = migrateLibraryProject(before, { force: true });
  const { converted, added } = preview;
  const hadLegacyUrl = hasLegacyRealvirtualLibraryUrl(before);
  let switched = false;
  let next: RvProject | null;
  try {
    next = await store.applyManifestDelta((current) => {
      if (current.id !== before.id || store.getBackend() !== backendBefore) {
        switched = true;
        return current;
      }
      return migrateLibraryProject(current, { force: true }).project;
    });
  } catch (e) {
    return { ok: false, reason: `Writing project.json failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (switched) return { ok: false, reason: PROJECT_SWITCHED };
  if (!next) return { ok: false, reason: PROJECT_READ_ONLY };
  return { ok: true, converted, added, hadLegacyUrl };
}
