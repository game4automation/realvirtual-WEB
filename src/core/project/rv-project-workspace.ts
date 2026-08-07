// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-workspace — the workspace root and its project discovery (§2.2.4).
 *
 * ## One pick, one grant, one handle
 *
 * `HANDLE_KEY_WORKSPACE` has existed since plan-370 Phase 1 but no UI ever
 * filled it. This module is that UI's engine: the user picks **one** folder,
 * grants **one** `readwrite` permission, and every direct subfolder holding a
 * `project.json` becomes a listed project. The File System Access grant is
 * inherited by descendants, so {@link discoverWorkspaceProjects} never calls
 * `queryPermission` on a subfolder — a per-project re-grant would turn a
 * ten-project workspace into ten browser prompts after every reload.
 *
 * ## Discovery is a directory listing, not a crawl
 *
 * Only **direct** children are inspected, and only for a manifest:
 *
 *  - a folder without `project.json` is **not a project** and not an error —
 *    a workspace legitimately holds notes, exports and scratch folders;
 *  - a folder whose `project.json` exists but cannot be parsed is **skipped
 *    and reported once**, because silently swallowing it looks identical to
 *    the folder simply not being there — which is the one thing the user must
 *    not conclude about a project they know they created;
 *  - an empty workspace yields an empty list. It does not throw. "You have no
 *    projects yet" is a legitimate state, not a failure.
 *
 * ## Discovered backends are inert (§2.2.1b)
 *
 * Every entry carries a {@link FolderBackend}, and every one of them is
 * constructed **read-only and inactive**: no `RVProjectFolderWriter`, no
 * subscription to the (global, unscoped) scene mutation bus. The bus carries
 * no `projectId`, so a writer per discovered folder would broadcast the active
 * project's every save into every other project's folder. The store upgrades
 * exactly one backend when it opens it; until then a write throws.
 *
 * ## Projects outside the workspace
 *
 * They stay legal, and *Recent* is what carries them: their handle lives under
 * `projectfolder:<id>` (`rv-local-filesystem.ts:49`) and never appears in a
 * workspace listing. {@link forgetRecentProject} is how one leaves that list.
 */

import {
  HANDLE_KEY_WORKSPACE,
  deleteStoredHandle,
  getFolderHandle,
  getHandle,
  readTextFile,
  selectFolderForKey,
} from '../engine/rv-local-filesystem';
import { FolderBackend } from './backends/folder-backend';
import { readManifest } from './rv-project-storage';
import {
  PROJECT_MANIFEST_BAK_FILE,
  PROJECT_MANIFEST_FILE,
  canonicalNameOf,
  type RvProject,
} from './rv-project-types';

/** localStorage key holding the workspace display record. */
export const LS_KEY_WORKSPACE = 'rv-project/workspace';

/** Picker id — separate from the project picker so the OS remembers both. */
const WORKSPACE_PICKER_ID = 'rv-workspace';

export interface WorkspaceMeta {
  /** Folder name as the OS reports it. */
  folderName: string;
  /** ISO timestamp of the last successful pick or scan. */
  lastScannedAt: string;
}

/** One project found inside the workspace root. */
export interface WorkspaceProjectEntry {
  /** Manifest id — also the `projectfolder:<id>` handle key suffix. */
  id: string;
  /** `?project=<slug>`; CONNECT `ProjectPaths.ValidateProjectName` rules (§2.2.3). */
  slug: string;
  /** Display name from the manifest. */
  name: string;
  /** Subfolder name, shown as the secondary line. */
  folderName: string;
  /** The subfolder handle — what {@link ProjectStore.openProjectFolder} needs. */
  dir: FileSystemDirectoryHandle;
  /** The parsed manifest, so a caller need not re-read it to render a row. */
  manifest: RvProject;
  /** Read-only, inactive backend (§2.2.1b). Never writes until the store activates it. */
  backend: FolderBackend;
}

export interface WorkspaceDiscovery {
  projects: WorkspaceProjectEntry[];
  /** One line per skipped folder. Empty on a clean scan. */
  warnings: string[];
}

const EMPTY_DISCOVERY: WorkspaceDiscovery = Object.freeze({
  projects: Object.freeze([]) as unknown as WorkspaceProjectEntry[],
  warnings: Object.freeze([]) as unknown as string[],
});

// ─── Handle + metadata ──────────────────────────────────────────────────

function readMeta(): WorkspaceMeta | null {
  try {
    const raw = localStorage.getItem(LS_KEY_WORKSPACE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Record<string, unknown>;
    return {
      folderName: typeof m.folderName === 'string' ? m.folderName : '',
      lastScannedAt: typeof m.lastScannedAt === 'string' ? m.lastScannedAt : '',
    };
  } catch {
    return null;
  }
}

function writeMeta(meta: WorkspaceMeta): void {
  try {
    localStorage.setItem(LS_KEY_WORKSPACE, JSON.stringify(meta));
  } catch {
    // Private mode / quota — the record is a label, never a precondition.
  }
}

/** The workspace display record, or null when none was ever picked. */
export function getWorkspaceMeta(): WorkspaceMeta | null {
  return readMeta();
}

/** True when a workspace handle is stored. Asks for no permission. */
export async function hasWorkspace(): Promise<boolean> {
  try {
    return (await getHandle(HANDLE_KEY_WORKSPACE)) !== null;
  } catch {
    return false;
  }
}

/**
 * Show the directory picker and store the chosen folder as *the* workspace.
 *
 * One `readwrite` grant is taken here and here only — `selectFolderForKey`
 * picks in `readwrite` mode, so the grant covers every project underneath for
 * the lifetime of the session.
 *
 * Returns null when the user cancels.
 */
export async function pickWorkspace(): Promise<FileSystemDirectoryHandle | null> {
  const dir = await selectFolderForKey(HANDLE_KEY_WORKSPACE, WORKSPACE_PICKER_ID);
  if (!dir) return null;
  writeMeta({ folderName: dir.name ?? '', lastScannedAt: new Date().toISOString() });
  return dir;
}

/**
 * Retrieve the stored workspace handle, re-requesting the grant if the reload
 * dropped it. **Once**, for the root — never per project.
 */
export async function getWorkspaceHandle(
  opts: { prompt?: boolean } = {},
): Promise<FileSystemDirectoryHandle | null> {
  return getFolderHandle(HANDLE_KEY_WORKSPACE, {
    mode: 'readwrite',
    prompt: opts.prompt ?? true,
  });
}

/** Drop the workspace. Project folders themselves are left untouched. */
export async function forgetWorkspace(): Promise<void> {
  try {
    await deleteStoredHandle(HANDLE_KEY_WORKSPACE);
  } catch {
    // A missing slot is already the desired end state.
  }
  try {
    localStorage.removeItem(LS_KEY_WORKSPACE);
  } catch { /* private mode */ }
}

// ─── Discovery ──────────────────────────────────────────────────────────

/**
 * Probe a subfolder for a manifest **file**, without deciding whether it
 * parses.
 *
 * The two questions are genuinely different and only this half can tell them
 * apart: `readManifest()` returns null both for "no such file" and for
 * "unparseable", and collapsing those would either spam a warning for every
 * ordinary folder in the workspace or hide a corrupted project entirely.
 */
async function hasManifestFile(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for (const name of [PROJECT_MANIFEST_FILE, PROJECT_MANIFEST_BAK_FILE]) {
    try {
      if ((await readTextFile(dir, name)) !== null) return true;
    } catch {
      // Permission or I/O trouble on this one file — treat the folder as a
      // candidate so the parse step below can report it properly.
      return true;
    }
  }
  return false;
}

/**
 * List the projects in a workspace root.
 *
 * Direct subfolders only. Never throws for a folder-shaped reason: an empty
 * workspace, a folder without a manifest and a folder with a broken one are
 * all ordinary outcomes, the last of them carried in `warnings`.
 */
export async function discoverWorkspaceProjects(
  dir: FileSystemDirectoryHandle,
): Promise<WorkspaceDiscovery> {
  const projects: WorkspaceProjectEntry[] = [];
  const warnings: string[] = [];

  let entries: [string, FileSystemFileHandle | FileSystemDirectoryHandle][];
  try {
    entries = [];
    for await (const entry of dir.entries()) entries.push(entry);
  } catch (e) {
    // The root itself is unreadable — that is a real failure, but a listing
    // is not the place to blow up a UI. Report it and return nothing.
    return {
      projects: [],
      warnings: [`The workspace folder could not be read: ${errText(e)}`],
    };
  }

  for (const [name, handle] of entries) {
    if (handle.kind !== 'directory') continue;
    const sub = handle as FileSystemDirectoryHandle;

    // NB: no queryPermission here. The root grant covers descendants; asking
    // again would raise one prompt per project on every reload.
    if (!(await hasManifestFile(sub))) continue;   // not a project — silent, by design

    let manifest: RvProject | null = null;
    try {
      manifest = (await readManifest(sub))?.project ?? null;
    } catch (e) {
      warnings.push(`"${name}" has a project.json that could not be read: ${errText(e)}`);
      continue;
    }
    if (!manifest) {
      warnings.push(`"${name}" has an unreadable project.json and was skipped.`);
      continue;
    }

    projects.push({
      id: manifest.id,
      slug: manifest.canonicalName || canonicalNameOf(manifest.name),
      name: manifest.name || name,
      folderName: name,
      dir: sub,
      manifest,
      // Read-only and inert (§2.2.1b): no writer host, `writable: false`.
      // The store constructs its own writable backend when it opens one.
      backend: new FolderBackend(sub, { writable: false, id: `folder:${manifest.id}` }),
    });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  writeMeta({
    folderName: dir.name ?? readMeta()?.folderName ?? '',
    lastScannedAt: new Date().toISOString(),
  });
  return { projects, warnings };
}

/**
 * Convenience for the UI: resolve the stored workspace and scan it.
 *
 * Returns an empty discovery when no workspace is configured or the grant was
 * refused — "nothing to show" rather than an error, because the workspace is
 * optional and *Recent* still carries projects picked individually.
 */
export async function scanStoredWorkspace(
  opts: { prompt?: boolean } = {},
): Promise<WorkspaceDiscovery> {
  const dir = await getWorkspaceHandle(opts);
  if (!dir) return EMPTY_DISCOVERY;
  return discoverWorkspaceProjects(dir);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
