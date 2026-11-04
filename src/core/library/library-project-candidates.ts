// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-project-candidates — the projects this browser knows that could be a
 * library of the open project (plan-778 Phase 2, F10, Decision 8).
 *
 * Feeds the **Projects** tab of Add library…: the user picks from a list —
 * there is no free-text id field (§2.4) — and the two pickers add what the
 * list does not hold yet:
 *
 *  - **Link folder…** — a project folder on this computer, read-only
 *    (`showDirectoryPicker({mode:'read'})`), linked like the dashboard's Add so
 *    it also shows in the Projects list; the hint is the folder name;
 *  - **From URL…** — a hosted project (`…/project.json`, its folder, or a
 *    GitHub repository): its `project.json` is READ for its id and name, then
 *    attached by id with the URL as the hint.
 */

import { listLinkedProjects } from '../project/rv-project-linked';
import { LS_KEY_BROWSER_PROJECT_PREFIX } from '../project/backends/browser-backend';
import { readManifest } from '../project/rv-project-storage';
import { getLocalStorage } from '../rv-safe-storage';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from './library-origin';
import { githubRawBase, hostedBaseOf } from './library-project-loader';
import { createLibraryBackendFactory } from './library-project-backends';

/** One known project, as the Projects tab lists it. */
export interface LibraryProjectCandidate {
  id: string;
  name: string;
  /** Where it lives — shown as the row's secondary word. */
  location: 'bundled' | 'folder' | 'browser' | 'hosted';
  /** The location hint stored with the reference (folder name / URL), when there is one. */
  hint?: string;
}

/** The realvirtual library is always known: every build ships it (Decision C). */
export const BUILTIN_LIBRARY_CANDIDATE: LibraryProjectCandidate = {
  id: REALVIRTUAL_LIBRARY_PROJECT_ID,
  name: 'realvirtual Library',
  location: 'bundled',
};

/** Browser projects stored in this browser's localStorage (`rv-project/browser/<id>`). */
export function listBrowserProjectCandidates(): LibraryProjectCandidate[] {
  const out: LibraryProjectCandidate[] = [];
  let storage: Storage | null = null;
  try { storage = getLocalStorage(); } catch { storage = null; }
  if (!storage) return out;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(LS_KEY_BROWSER_PROJECT_PREFIX)) continue;
    const id = key.slice(LS_KEY_BROWSER_PROJECT_PREFIX.length);
    if (!id || id.includes('/')) continue;   // `<id>/blobs` and friends are not manifests
    let name = id;
    try {
      const parsed = JSON.parse(storage.getItem(key) ?? 'null') as { name?: unknown } | null;
      if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) name = parsed.name;
    } catch { /* an unreadable record still names its id */ }
    out.push({ id, name, location: 'browser' });
  }
  return out;
}

/**
 * Every project this browser knows: the realvirtual library, linked folders,
 * browser projects — deduplicated by id (first wins), in that order.
 */
export async function listLibraryProjectCandidates(): Promise<LibraryProjectCandidate[]> {
  const out: LibraryProjectCandidate[] = [BUILTIN_LIBRARY_CANDIDATE];
  let linked: Awaited<ReturnType<typeof listLinkedProjects>> = [];
  try { linked = await listLinkedProjects(); } catch { linked = []; }
  for (const row of linked) {
    out.push({ id: row.id, name: row.name || row.id, location: 'folder', ...(row.folderName ? { hint: row.folderName } : {}) });
  }
  out.push(...listBrowserProjectCandidates());
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

export type ReadLibraryProjectResult =
  | { ok: true; id: string; name: string; hint: string }
  | { ok: false; reason: string };

/** Timeout for reading a hosted `project.json`, ms. */
export const HOSTED_READ_TIMEOUT_MS = 10_000;

/**
 * **From URL…** — read the hosted project at `url` (a `project.json` URL, its
 * folder, or a GitHub repository) for its id and name. The URL itself becomes
 * the reference's hint. Never throws.
 */
export async function readHostedLibraryProject(rawUrl: string): Promise<ReadLibraryProjectResult> {
  const url = (rawUrl ?? '').trim();
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) {
    return { ok: false, reason: 'Enter the URL of a hosted project (its project.json or its folder).' };
  }
  const base = githubRawBase(url)?.rawBase ?? hostedBaseOf(url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const backend = createLibraryBackendFactory().remote(base);
    const manifest = await Promise.race([
      backend.readManifest(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), HOSTED_READ_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (!manifest) return { ok: false, reason: `No project.json found at ${base}.` };
    if (typeof manifest.id !== 'string' || !manifest.id) return { ok: false, reason: `The project at ${base} has no id.` };
    return { ok: true, id: manifest.id, name: manifest.name || manifest.id, hint: url };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: `Reading ${base}project.json failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * **Link folder…** after the pick — read the folder's manifest for its id, then
 * link it through the ONE linking sequence Locate uses (`linkLocatedLibrary`:
 * id verified, `projectfolder:<id>` + the linked-projects row, and the loader's
 * cached backend for that id invalidated — plan-778 review U3), and answer its
 * id and name. The OPEN project's own folder is refused BEFORE anything is
 * stored: storing it would replace the open project's own handle. Never throws.
 */
export async function linkLibraryFolder(
  dir: FileSystemDirectoryHandle,
  openProjectId: string | null = null,
): Promise<ReadLibraryProjectResult> {
  let manifest: Awaited<ReturnType<typeof readManifest>> = null;
  try { manifest = await readManifest(dir); } catch { manifest = null; }
  const project = manifest?.project ?? null;
  if (!project || typeof project.id !== 'string' || !project.id) {
    return { ok: false, reason: `"${dir.name}" does not hold a readable project.json.` };
  }
  if (openProjectId && project.id === openProjectId) {
    return { ok: false, reason: 'This folder is the open project — a project cannot be a library of itself.' };
  }
  const { linkLocatedLibrary } = await import('./library-availability');
  const linked = await linkLocatedLibrary(project.id, dir);
  if (!linked.ok) return { ok: false, reason: linked.reason };
  return { ok: true, id: project.id, name: project.name || project.id, hint: dir.name };
}
