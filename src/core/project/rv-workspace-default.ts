// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-workspace-default — "My Workspace", the home every document has
 * (plan-716 §2.2, F2).
 *
 * Before this module there was a whole mode with no project in it: open the
 * viewer, save a scene, never touch a folder. The scene then lived in the
 * localStorage catalogue and belonged to nothing, while `resolveActiveProject()`
 * answered with the READ-ONLY bundled demo — so the boot's "active project" and
 * the place the user's bytes actually went were two different things. Plan-716
 * removes the projectless mode as a concept: without a folder project the boot
 * opens a writable **browser** project, and the bundled demo goes back to being
 * what it is, a read-only source that is opened on purpose.
 *
 * ## Why a fixed id, and why that is the whole duplicate guard (Risiko 7)
 *
 * The id is the constant {@link WORKSPACE_DEFAULT_PROJECT_ID}, never minted.
 * `BrowserBackend` keys its manifest, its blob index and its scene membership
 * off that id, so *every* boot — first, tenth, two tabs at once, a reload in
 * the middle of the previous one — addresses the same project. There is no
 * window in which two of them can exist, because creating one is not an
 * operation that happens: opening it is.
 *
 * That is also why existence is asked of the fixed key
 * ({@link workspaceDefaultExists}) and **never** of "is the project list
 * empty". An empty list is true of a fresh profile and of a profile whose
 * listing failed, and the second one would mint a second home over the top of
 * the first.
 *
 * ## Persisting the row is a marker, not a precondition
 *
 * `BrowserBackend.readManifest()` synthesises a manifest when the key is absent,
 * so the project is fully usable before anything is written — which is what lets
 * the branch sit inside `resolveActiveProject()`, whose contract is that it opens
 * the backend read-only and writes nothing (boot-order.test.ts). The row is
 * written once, later, from `_adoptProject()` after `activate()` has opened the
 * write gate; see {@link ensureWorkspaceDefaultManifest}.
 */

import { BrowserBackend, browserManifestKey } from './backends/browser-backend';
import type { ProjectBackend } from './backends/project-backend';
import type { RvProject } from './rv-project-types';

/** The one id of the implicit browser project. Constant, never minted. */
export const WORKSPACE_DEFAULT_PROJECT_ID = 'workspace-default';

/** What the user sees in the project switcher and the library tab. */
export const WORKSPACE_DEFAULT_PROJECT_NAME = 'My Workspace';

/** Is this the implicit browser project? */
export function isWorkspaceDefaultProject(idOrProject: string | { id?: string } | null): boolean {
  const id = typeof idOrProject === 'string' ? idOrProject : idOrProject?.id;
  return id === WORKSPACE_DEFAULT_PROJECT_ID;
}

/** Is the backend the implicit browser project's? */
export function isWorkspaceDefaultBackend(
  backend: ProjectBackend | null,
): backend is BrowserBackend {
  return backend instanceof BrowserBackend
    && isWorkspaceDefaultProject(backend.projectId);
}

/**
 * Has the workspace project's manifest row been written yet?
 *
 * The **only** sanctioned existence question (see the file header). Reads the
 * fixed key directly rather than through a backend: the answer is needed before
 * a backend is activated, and a synthesised manifest would make every profile
 * look like it already had one.
 */
export function workspaceDefaultExists(): boolean {
  try {
    return localStorage.getItem(browserManifestKey(WORKSPACE_DEFAULT_PROJECT_ID)) !== null;
  } catch {
    // Private mode / storage disabled. "Not there" is the safe answer: the
    // caller then tries to write it, and that write fails softly too.
    return false;
  }
}

/**
 * Open the implicit browser project. Always the same project.
 *
 * This used to pass `adoptsUnowned: true`, so that a catalogue row with no
 * owner marker — a scene saved in the projectless mode this project replaced —
 * was listed here rather than nowhere. The eager migration converts those rows
 * into documents of THIS project before anything lists them (§2.3), so the
 * adoption rule had nothing left to adopt and went with the catalogue in
 * Phase 6.
 */
export function openWorkspaceDefaultBackend(
  opts: { requestPersistence?: boolean } = {},
): BrowserBackend {
  return new BrowserBackend(WORKSPACE_DEFAULT_PROJECT_ID, {
    name: WORKSPACE_DEFAULT_PROJECT_NAME,
    ...(opts.requestPersistence === undefined ? {} : { requestPersistence: opts.requestPersistence }),
  });
}

/**
 * Write the manifest row once, if it is not there.
 *
 * Idempotent by the existence check, and a no-op for every other backend. Call
 * it only where writes are legal — after `activate()` — because
 * `writeManifest()` refuses on an inactive backend by design.
 */
export async function ensureWorkspaceDefaultManifest(
  backend: ProjectBackend,
  project: RvProject,
): Promise<boolean> {
  if (!isWorkspaceDefaultBackend(backend)) return false;
  if (workspaceDefaultExists()) return false;
  try {
    await backend.writeManifest(project);
    return true;
  } catch {
    // Quota, private mode, or a backend that was deactivated underneath us.
    // The project keeps working off its synthesised manifest; the row is
    // written by the next real save.
    return false;
  }
}
