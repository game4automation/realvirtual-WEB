// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-recent — the "Recent projects" list behind the TopBar switcher (§4.5).
 *
 * ## Two halves, and only one of them is authoritative
 *
 * The thing that actually lets a project be reopened is the **directory handle**
 * persisted in IndexedDB under `projectfolder:<id>` (the multi-key store from
 * Phase 1). A localStorage row can never resurrect a folder on its own.
 *
 * So the handle store is the truth about *availability* and this module's
 * localStorage row is only the **display record** — the project name and the
 * folder name, which a `FileSystemDirectoryHandle` key cannot carry. Every read
 * that matters ({@link listAvailableRecentProjects}) intersects the two, so a
 * handle that was evicted, or a row written by a build that never stored a
 * handle, cannot produce a menu entry that does nothing when clicked.
 *
 * Reopening still has to pass `queryPermission('readwrite')` and may raise the
 * browser's re-grant prompt; that is `ProjectStore.openRecentProject`'s job, not
 * this module's. A listed project is "known", never "already granted".
 */

import { listHandleKeys, projectHandleKey } from '../engine/rv-local-filesystem';

/** localStorage key holding the display records. */
export const LS_KEY_RECENT_PROJECTS = 'rv-project/recent';

/** How many projects the menu remembers. Older rows fall off the end. */
export const MAX_RECENT_PROJECTS = 10;

export interface RecentProjectEntry {
  /** Project id — also the IndexedDB handle key suffix. */
  id: string;
  /** Display name from the manifest. */
  name: string;
  /** Folder name as the OS reports it, shown as the secondary line. */
  folderName: string;
  /** ISO timestamp of the last successful open. */
  lastOpenedAt: string;
}

function isEntry(value: unknown): value is RecentProjectEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.trim() !== '' && typeof e.name === 'string';
}

/** Read the raw display records, newest first. Never throws. */
export function readRecentProjects(): RecentProjectEntry[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_KEY_RECENT_PROJECTS);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map(e => ({
      id: e.id,
      name: e.name,
      folderName: typeof e.folderName === 'string' ? e.folderName : '',
      lastOpenedAt: typeof e.lastOpenedAt === 'string' ? e.lastOpenedAt : '',
    }));
  } catch {
    return [];
  }
}

function writeRecentProjects(entries: RecentProjectEntry[]): void {
  try {
    localStorage.setItem(LS_KEY_RECENT_PROJECTS, JSON.stringify(entries));
  } catch {
    // Private mode / quota — the recents list is a convenience, never a
    // precondition for opening a project.
  }
}

/**
 * Record a successful open. Deduplicates by id and moves the project to the
 * front, so the list reads as "most recently used" without a second timestamp
 * sort at render time.
 */
export function recordRecentProject(entry: {
  id: string;
  name: string;
  folderName?: string | null;
}): void {
  if (!entry?.id) return;
  const row: RecentProjectEntry = {
    id: entry.id,
    name: entry.name || entry.id,
    folderName: entry.folderName ?? '',
    lastOpenedAt: new Date().toISOString(),
  };
  const rest = readRecentProjects().filter(e => e.id !== row.id);
  writeRecentProjects([row, ...rest].slice(0, MAX_RECENT_PROJECTS));
}

/** Drop one project from the display records. The handle is left alone. */
export function forgetRecentProject(id: string): void {
  const rest = readRecentProjects().filter(e => e.id !== id);
  writeRecentProjects(rest);
}

/**
 * The list the switcher menu renders: display records that still have a handle
 * in IndexedDB, newest first.
 *
 * An id with a handle but no display row is included under a fallback label
 * rather than hidden — the handle is the reopenable thing, and dropping it from
 * the menu would leave the user no way back into a project that is genuinely
 * still there.
 */
export async function listAvailableRecentProjects(): Promise<RecentProjectEntry[]> {
  let keys: string[];
  try {
    keys = await listHandleKeys();
  } catch {
    return [];
  }
  const available = new Set(keys);
  const rows = readRecentProjects().filter(e => available.has(projectHandleKey(e.id)));

  const known = new Set(rows.map(e => e.id));
  const orphanIds = keys
    .filter(k => k.startsWith('projectfolder:'))
    .map(k => k.slice('projectfolder:'.length))
    .filter(id => id && !known.has(id));

  const orphans: RecentProjectEntry[] = orphanIds.map(id => ({
    id,
    name: 'Untitled project',
    folderName: '',
    lastOpenedAt: '',
  }));

  return [...rows, ...orphans].slice(0, MAX_RECENT_PROJECTS);
}
