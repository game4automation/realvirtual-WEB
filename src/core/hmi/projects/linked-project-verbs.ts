// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * linked-project-verbs — the decisions behind Add, Open, Locate and Drop
 * (plan-743).
 *
 * ## Why they are not in the host
 *
 * `ProjectsDashboardHost.tsx` says of its own `dashboard-documents` import:
 * *"They live in their own module because this file cannot be rendered by a
 * test."* It pulls the project store, the library registry, the scene store,
 * the viewer and the private asset editor, so a rule that lives inside it is a
 * rule with no test — and `projects-rename-host.test.tsx` had to reproduce the
 * host's wiring by hand to get at one.
 *
 * These four are the rules plan-743 adds, and every one of them is a
 * correctness question rather than a rendering question: which of three shapes
 * a folder is, whether a lapsed grant means `denied` or `missing`, whether a
 * duplicate id is the same folder, and which drop items are still live. So they
 * are here, storage-aware but React-free, and the host is their one caller.
 */

import {
  getFolderHandle,
  getHandle,
  projectHandleKey,
  putHandle,
} from '../../engine/rv-local-filesystem';
import { probeAddTarget, type AddProbe } from '../../project/rv-project-add';
import { detectOpenTarget, type OpenTargetKind } from '../../project/rv-project-open';
import {
  isSameLinkedFolder,
  recordLinkedProject,
  type LinkedProjectEntry,
} from '../../project/rv-project-linked';
import { readManifest } from '../../project/rv-project-storage';
import {
  PROJECT_MANIFEST_BAK_FILE,
  PROJECT_MANIFEST_FILE,
  canonicalNameOf,
  type RvProject,
} from '../../project/rv-project-types';

// ─── Open ───────────────────────────────────────────────────────────────

/**
 * What happened when a linked row was clicked.
 *
 * `missing` and `denied` are separate because they send the user to different
 * verbs: Locate… re-points a folder that moved, and a re-grant is just another
 * click on the same row.
 */
export type LinkedOpenResult =
  | { kind: 'ready'; dir: FileSystemDirectoryHandle }
  | { kind: 'denied' }
  | { kind: 'missing' };

/**
 * Resolve a linked project's folder for opening.
 *
 * The ORDER is the rule (plan-743 review finding 10): `getFolderHandle` answers
 * `null` both for "no handle stored" and for "grant refused", so the handle is
 * looked up first and the two are told apart by which lookup failed. Telling a
 * user "access was not granted" for a project whose handle was evicted sends
 * them to a permission dialog that will never appear.
 *
 * `prompt: true` is the FIRST await after the click by construction — no
 * manifest read comes before it — so the browser still counts the user's
 * gesture and the re-grant dialog is allowed to open.
 */
export async function resolveLinkedOpen(id: string): Promise<LinkedOpenResult> {
  const stored = await getHandle(projectHandleKey(id));
  if (!stored) return { kind: 'missing' };

  const dir = await getFolderHandle(projectHandleKey(id), { prompt: true });
  if (!dir) return { kind: 'denied' };

  // The manifest is PROBED, not parsed, and deliberately not through
  // `readManifest`: that function catches everything and answers `null` for
  // "no such file", "the path is a file now" and "the JSON is broken" alike, so
  // it cannot tell a folder that moved from a folder that is fine. The raw
  // lookup is the only place `NotFoundError` and `TypeMismatchError` still
  // surface, and those two are exactly what "Folder not found" means.
  if (!(await manifestReachable(dir))) return { kind: 'missing' };
  return { kind: 'ready', dir };
}

/** Is either manifest file still there? Errors other than "gone" say yes. */
async function manifestReachable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for (const name of [PROJECT_MANIFEST_FILE, PROJECT_MANIFEST_BAK_FILE]) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (e) {
      const kind = e instanceof Error ? e.name : '';
      if (kind === 'NotFoundError') continue;              // try the .bak
      if (kind === 'TypeMismatchError') return false;      // the path is a file now
      // Permission or I/O trouble: the folder is THERE, so this is not a
      // "locate it" problem and the open should proceed and fail loudly.
      return true;
    }
  }
  return false;
}

// ─── Add ────────────────────────────────────────────────────────────────

/** What Add learnt about the picked folder, before it acts on it. */
export interface AddVerdict {
  kind: OpenTargetKind;
  probe: AddProbe;
  /** Child folder names holding a manifest. Only meaningful for `parent`. */
  childProjects: string[];
  /** The parsed root manifest. Only present for a readable `project`. */
  manifest: RvProject | null;
  /**
   * The id is already linked to a DIFFERENT folder — a copied project.
   *
   * The caller confirms rather than repointing silently: `putHandle` would
   * otherwise leave the row pointing at a folder the user never chose.
   */
  duplicateOfOtherFolder: boolean;
}

/** Classify a picked folder and answer the duplicate question in one pass. */
export async function verdictForAdd(
  dir: FileSystemDirectoryHandle,
  known: readonly LinkedProjectEntry[],
): Promise<AddVerdict> {
  const probe = await probeAddTarget(dir);
  const target = detectOpenTarget(probe);
  const base = {
    kind: target.kind,
    probe,
    childProjects: target.childProjects,
    manifest: null as RvProject | null,
    duplicateOfOtherFolder: false,
  };
  if (target.kind !== 'project' || probe.manifestBroken) return base;

  const manifest = (await readManifest(dir))?.project ?? null;
  if (!manifest) return { ...base, probe: { ...probe, manifestBroken: true } };

  const collides = known.some(l => l.id === manifest.id)
    && !(await isSameLinkedFolder(manifest.id, dir));
  return { ...base, manifest, duplicateOfOtherFolder: collides };
}

/** What linking a folder full of projects actually managed to do. */
export interface ParentAddSummary {
  linked: number;
  /** Children whose id is already linked to a DIFFERENT folder. */
  duplicates: string[];
  /** Children with an unreadable `project.json`. */
  broken: string[];
}

/**
 * Link every child project of a folder, writing NOTHING to the folder itself
 * (plan-743 F2, the user's decision that replaces a migration).
 *
 * Each child gets its own `projectfolder:<id>` handle and its own row, which is
 * exactly what the old workspace engine never did — it stored one handle, for
 * the root. That is why an old workspace's children have to come back through
 * this path rather than through a data migration: there was no per-child handle
 * to migrate.
 *
 * A duplicate id is SKIPPED rather than confirmed one dialog at a time: a
 * parent can hold dozens of children, and a modal per collision would be worse
 * than the collision itself. The names come back so the caller can say it once.
 */
export async function linkChildProjects(
  parent: FileSystemDirectoryHandle,
  childNames: readonly string[],
  known: readonly LinkedProjectEntry[],
  dirs?: readonly (FileSystemDirectoryHandle | undefined)[],
): Promise<ParentAddSummary> {
  const summary: ParentAddSummary = { linked: 0, duplicates: [], broken: [] };
  for (let i = 0; i < childNames.length; i++) {
    const name = childNames[i]!;
    try {
      const child = dirs?.[i] ?? await parent.getDirectoryHandle(name);
      const manifest = (await readManifest(child))?.project;
      if (!manifest?.id) { summary.broken.push(name); continue; }
      if (known.some(l => l.id === manifest.id)
        && !(await isSameLinkedFolder(manifest.id, child))) {
        summary.duplicates.push(name);
        continue;
      }
      await putHandle(child, projectHandleKey(manifest.id));
      // `opened: false` — these were linked in bulk and never opened, so they
      // must not outrank a project the user actually worked in.
      recordLinkedProject({
        id: manifest.id,
        name: manifest.name || name,
        slug: manifest.canonicalName || canonicalNameOf(manifest.name || name),
        folderName: name,
        opened: false,
      });
      summary.linked++;
    } catch {
      summary.broken.push(name);
    }
  }
  return summary;
}

/** One sentence for the whole batch — never one toast per child. */
export function summariseParentAdd(s: ParentAddSummary): string {
  const parts = [`Linked ${s.linked} project${s.linked === 1 ? '' : 's'}.`];
  if (s.duplicates.length > 0) {
    parts.push(`Skipped ${s.duplicates.length} already linked elsewhere `
      + `(${s.duplicates.join(', ')}).`);
  }
  if (s.broken.length > 0) {
    parts.push(`${s.broken.length} could not be read (${s.broken.join(', ')}).`);
  }
  return parts.join(' ');
}

// ─── Drop ───────────────────────────────────────────────────────────────

/** Internal drag types the dashboard already owns; they beat Add. */
export function isInternalDrag(
  types: readonly string[],
  internalTypes: readonly string[],
): boolean {
  return internalTypes.some(t => types.includes(t));
}

/**
 * Collect `getAsFileSystemHandle()` promises for every dropped item.
 *
 * **Synchronous by contract.** `DataTransferItem`s are neutered the moment the
 * `drop` handler's tick ends, so an `await` placed before these calls makes
 * every one of them answer `null` — the single most common way folder drops are
 * broken. The function therefore returns PROMISES and awaits nothing itself;
 * {@link firstDirectoryHandle} is the half that may be awaited.
 */
export function collectDropHandles(
  items: readonly DataTransferItem[],
): Promise<FileSystemHandle | null>[] {
  return items.map(item => {
    const get = (item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
    }).getAsFileSystemHandle;
    return typeof get === 'function'
      ? get.call(item).catch(() => null)
      : Promise.resolve(null);
  });
}

/**
 * The first dropped DIRECTORY, or null.
 *
 * Files are ignored in silence: dropping a GLB on the project LIST is a gesture
 * with no meaning here, and an error toast for it would be noise.
 */
export async function firstDirectoryHandle(
  pending: readonly Promise<FileSystemHandle | null>[],
): Promise<FileSystemDirectoryHandle | null> {
  const handles = await Promise.all(pending);
  const dir = handles.find(h => h?.kind === 'directory');
  return (dir as FileSystemDirectoryHandle | undefined) ?? null;
}
