// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-linked — the flat list of project folders this browser knows
 * (plan-743).
 *
 * ## From cache to source of truth
 *
 * This module is the descendant of the old capped "recent projects" cache, and
 * the rename is the point. That list was a *convenience* beside the workspace
 * root, capped at ten, and losing a row cost nothing because the workspace
 * would rediscover the project anyway. There is no workspace any more, so this
 * list is the ONLY record of which folders the dashboard offers — which is why
 * it has no cap, an explicit
 * {@link LinkedProjectEntry.linkedAt} that survives every reopen, and an
 * {@link unlinkProject} that the user has to ask for.
 *
 * ## Two halves, and only one of them is authoritative
 *
 * The thing that actually lets a project be reopened is the **directory handle**
 * persisted in IndexedDB under `projectfolder:<id>`. A localStorage row can
 * never resurrect a folder on its own.
 *
 * So the handle store is the truth about *availability* and this module's
 * localStorage row is only the **display record** — the project name, its slug
 * and the folder name, none of which a `FileSystemDirectoryHandle` key can
 * carry. {@link listLinkedProjects} intersects the two, so a handle that was
 * evicted, or a row written by a build that never stored a handle, cannot
 * produce a dashboard entry that does nothing when clicked.
 *
 * Reopening still has to pass `queryPermission('readwrite')` and may raise the
 * browser's re-grant prompt; that is the dashboard's job, not this module's. A
 * listed project is "known", never "already granted".
 */

import {
  deleteStoredHandle,
  getHandle,
  listHandleKeys,
  projectHandleKey,
  putHandle,
} from '../engine/rv-local-filesystem';

/** localStorage key holding the display records. */
export const LS_KEY_LINKED_PROJECTS = 'rv-project/linked';

export interface LinkedProjectEntry {
  /** Project id from the manifest — also the IndexedDB handle key suffix. */
  id: string;
  /** Display name from the manifest. */
  name: string;
  /**
   * `?project=<slug>` — the key `web_project_list` publishes and agents match
   * on. Kept in the row because the manifest is not read when the list renders.
   */
  slug: string;
  /** Folder name as the OS reports it, shown as the secondary line. Not a path. */
  folderName: string;
  /** ISO timestamp of the moment the folder was first linked. */
  linkedAt: string;
  /** ISO timestamp of the last successful open. Absent until opened once. */
  lastOpenedAt?: string;
}

function isEntry(value: unknown): value is LinkedProjectEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'string' && e.id.trim() !== '' && typeof e.name === 'string';
}

/** Read the raw display records. Never throws. */
export function readLinkedProjects(): LinkedProjectEntry[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_KEY_LINKED_PROJECTS);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map(e => {
      const row: LinkedProjectEntry = {
        id: e.id,
        name: e.name,
        slug: typeof e.slug === 'string' ? e.slug : '',
        folderName: typeof e.folderName === 'string' ? e.folderName : '',
        linkedAt: typeof e.linkedAt === 'string' ? e.linkedAt : '',
      };
      if (typeof e.lastOpenedAt === 'string' && e.lastOpenedAt !== '') {
        row.lastOpenedAt = e.lastOpenedAt;
      }
      return row;
    });
  } catch {
    return [];
  }
}

function writeLinkedProjects(entries: LinkedProjectEntry[]): void {
  try {
    localStorage.setItem(LS_KEY_LINKED_PROJECTS, JSON.stringify(entries));
  } catch {
    // Private mode / quota — the list is a convenience, never a precondition
    // for opening a project the handle store still holds.
  }
}

/**
 * Sort newest-activity first: last open wins, and a folder that has only ever
 * been linked (the `parent` branch of Add links many at once without opening
 * any of them) falls back to when it was linked.
 */
function sortLinked(rows: LinkedProjectEntry[]): LinkedProjectEntry[] {
  return [...rows].sort((a, b) => {
    const ao = a.lastOpenedAt ?? '';
    const bo = b.lastOpenedAt ?? '';
    if (ao !== bo) return ao < bo ? 1 : -1;
    const al = a.linkedAt ?? '';
    const bl = b.linkedAt ?? '';
    if (al !== bl) return al < bl ? 1 : -1;
    return 0;
  });
}

/**
 * Link a folder, or refresh what is known about an already-linked one.
 *
 * Upsert by id, and deliberately NOT a move-to-front: order is derived from the
 * timestamps at read time, so a rewrite cannot reshuffle the list behind the
 * user's back. `linkedAt` is preserved across every re-record — it says when
 * this browser first learnt about the folder, and nothing later should be able
 * to make a long-known project look new.
 *
 * `opened: true` additionally stamps `lastOpenedAt`; the `parent` Add branch
 * passes `opened: false` because it links folders it never opened.
 */
export function recordLinkedProject(entry: {
  id: string;
  name: string;
  slug?: string | null;
  folderName?: string | null;
  opened?: boolean;
}): void {
  if (!entry?.id) return;
  const existing = readLinkedProjects().find(e => e.id === entry.id);
  const now = new Date().toISOString();
  const row: LinkedProjectEntry = {
    id: entry.id,
    name: entry.name || entry.id,
    slug: entry.slug ?? existing?.slug ?? '',
    folderName: entry.folderName ?? existing?.folderName ?? '',
    linkedAt: existing?.linkedAt || now,
  };
  const lastOpenedAt = entry.opened === false
    ? existing?.lastOpenedAt
    : now;
  if (lastOpenedAt) row.lastOpenedAt = lastOpenedAt;

  const rest = readLinkedProjects().filter(e => e.id !== row.id);
  writeLinkedProjects([row, ...rest]);
}

/**
 * Drop only the display row, leaving the handle in place.
 *
 * Synchronous, and therefore the half {@link unlinkProject} can offer to a
 * caller that must update its own state in the same tick. On its own it is not
 * "Remove from list" — the surviving handle would resurface the project under a
 * fallback label on the next listing.
 */
export function forgetLinkedRow(id: string): void {
  const rest = readLinkedProjects().filter(e => e.id !== id);
  writeLinkedProjects(rest);
}

/**
 * Forget a project: the display row AND the handle.
 *
 * Both halves, unlike the old recents list which left the handle
 * behind — with no workspace to rediscover the folder, an orphaned handle would
 * simply reappear in {@link listLinkedProjects} under a fallback label, and
 * "Remove from list" would look broken. No file is touched.
 */
export async function unlinkProject(id: string): Promise<void> {
  if (!id) return;
  forgetLinkedRow(id);
  try {
    await deleteStoredHandle(projectHandleKey(id));
  } catch {
    // A missing slot is already the desired end state.
  }
}

/**
 * Point an existing row at a different folder — "Locate…" for a project whose
 * folder was moved or renamed.
 *
 * Only the handle changes: the display row keeps its id, name and `linkedAt`,
 * because it is the same project, found again.
 */
export async function relinkProject(id: string, dir: FileSystemDirectoryHandle): Promise<void> {
  if (!id) return;
  await putHandle(dir, projectHandleKey(id));
}

/**
 * Is `dir` the folder already linked under `id`?
 *
 * The duplicate guard. Two folders can legitimately carry the same manifest id
 * (a copied project), and `putHandle` would silently repoint the row at the
 * copy. Identity is asked of the platform via `isSameEntry` — comparing handle
 * objects would answer "different" for the same folder after every reload.
 *
 * Answers `false` when nothing is linked under that id, which is the caller's
 * cue that there is no conflict to confirm.
 */
export async function isSameLinkedFolder(
  id: string,
  dir: FileSystemDirectoryHandle,
): Promise<boolean> {
  if (!id) return false;
  try {
    const existing = await getHandle(projectHandleKey(id));
    if (!existing) return false;
    return await existing.isSameEntry(dir);
  } catch {
    return false;
  }
}

/**
 * The list the dashboard renders: display records that still have a handle in
 * IndexedDB, newest activity first.
 *
 * An id with a handle but no display row is included under a fallback label
 * rather than hidden — the handle is the reopenable thing, and dropping it from
 * the list would leave the user no way back into a project that is genuinely
 * still there.
 *
 * Asks for no permission: this is a listing, and the grant is spent when the
 * user actually clicks a row.
 */
export async function listLinkedProjects(): Promise<LinkedProjectEntry[]> {
  let keys: string[];
  try {
    keys = await listHandleKeys();
  } catch {
    return [];
  }
  const available = new Set(keys);
  const rows = readLinkedProjects().filter(e => available.has(projectHandleKey(e.id)));

  const known = new Set(rows.map(e => e.id));
  const orphanIds = keys
    .filter(k => k.startsWith('projectfolder:'))
    .map(k => k.slice('projectfolder:'.length))
    .filter(id => id && !known.has(id));

  const orphans: LinkedProjectEntry[] = orphanIds.map(id => ({
    id,
    name: 'Untitled project',
    slug: '',
    folderName: '',
    linkedAt: '',
  }));

  return [...sortLinked(rows), ...orphans];
}
