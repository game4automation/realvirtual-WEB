// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-locate — "is this the folder of project X?" (plan-778 Phase 2, F9).
 *
 * The ONE answer behind two Locate verbs: the Projects dashboard's **Locate…**
 * on a linked row whose folder moved, and the Problems panel's **Locate
 * folder…** on a library project that is unknown on this computer. Both pick a
 * folder and must refuse one that holds a different project — a project is its
 * manifest id, never its folder name (Decision 1).
 *
 * The verdict only. What happens on a match (relink + open for a dashboard row,
 * link + loader invalidation for a library) and on a mismatch (the dashboard
 * offers to replace the row, a library refuses) stays with the caller.
 */

import { readManifest } from './rv-project-storage';
import type { RvProject } from './rv-project-types';

/** What a picked folder turned out to be. */
export type LocateProjectResult =
  /** The folder holds the expected project. */
  | { kind: 'ok'; project: RvProject }
  /** No readable `project.json` (nor `.bak`) — not a project at all. */
  | { kind: 'unreadable'; message: string }
  /** A project, but another one: both names and ids, for the message. */
  | {
      kind: 'mismatch';
      project: RvProject;
      expected: { id: string; label: string };
      found: { id: string; name: string };
      message: string;
    };

/** The refusal text of a folder without a readable manifest. */
export function unreadableFolderMessage(dirName: string): string {
  return `"${dirName}" does not hold a readable project.json.`;
}

/** The refusal text of a folder holding another project — names both (F9). */
export function mismatchMessage(found: { id: string; name: string }, expected: { id: string; label: string }): string {
  return `This folder holds project '${found.name}' (${found.id}), not '${expected.label}' (${expected.id}).`;
}

/**
 * Read `dir`'s manifest and compare its id with `expectedId`.
 *
 * `expectedLabel` only feeds the mismatch message (default: the id). Never
 * throws: an unreadable folder is a verdict, not an error.
 */
export async function locateProjectFolder(
  expectedId: string,
  dir: FileSystemDirectoryHandle,
  expectedLabel?: string | null,
): Promise<LocateProjectResult> {
  let project: RvProject | null = null;
  try {
    project = (await readManifest(dir))?.project ?? null;
  } catch {
    project = null;
  }
  if (!project) return { kind: 'unreadable', message: unreadableFolderMessage(dir.name) };
  if (project.id === expectedId) return { kind: 'ok', project };
  const expected = { id: expectedId, label: (expectedLabel ?? '').trim() || expectedId };
  const found = { id: String(project.id), name: project.name || String(project.id) };
  return { kind: 'mismatch', project, expected, found, message: mismatchMessage(found, expected) };
}
