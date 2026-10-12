// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-add — what the folder behind "Add" actually is (plan-743 F2).
 *
 * ## One listing, and NOT a second classifier
 *
 * The interesting decision — project / parent / plain — is
 * {@link detectOpenTarget}'s and stays there. This module only produces the
 * probe it eats, plus the one fact Add needs that Open does not: whether a
 * manifest that IS there is also *readable*. A folder whose `project.json`
 * cannot be parsed is still a project, so it must not fall through to the GLB
 * scan and get a second manifest written over the broken one; it has to be
 * reported instead.
 *
 * ## Existence is not parsing
 *
 * {@link hasManifestFile} (inherited unchanged from the retired workspace
 * engine) answers only "is the file there". `readManifest()` returns null both
 * for "no such file" and for "unparseable", and collapsing those would either
 * warn about every ordinary folder or hide a corrupted project entirely.
 *
 * Nothing here writes. Add's write happens in `seedProjectFromScan`, and only
 * ever inside the folder the user picked.
 */

import { detectOpenTarget, type OpenProbe, type OpenTarget } from './rv-project-open';
import { readManifest } from './rv-project-storage';
import { PROJECT_MANIFEST_BAK_FILE, PROJECT_MANIFEST_FILE } from './rv-project-types';

/** What one listing of the picked folder told us. */
export interface AddProbe extends OpenProbe {
  /**
   * A manifest file is present at the root but did not parse.
   *
   * Never true together with a successful open: the caller reports it and stops,
   * because both other branches would write to a folder that already claims to
   * be a project.
   */
  manifestBroken: boolean;
}

/**
 * Probe a folder for a manifest **file**, without deciding whether it parses.
 *
 * Taken verbatim from the workspace discovery engine when it was deleted —
 * a `.bak` counts, because a project whose main manifest was lost mid-write is
 * still a project and must not be overwritten by the scan.
 */
export async function hasManifestFile(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for (const name of [PROJECT_MANIFEST_FILE, PROJECT_MANIFEST_BAK_FILE]) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch (e) {
      // "Does the file exist" needs only the handle lookup — reading the bytes
      // here would duplicate the read `readManifest()` does right after.
      if (e instanceof DOMException && e.name === 'NotFoundError') continue;
      if (e instanceof Error && e.name === 'NotFoundError') continue;
      // Permission or I/O trouble on this one file — treat the folder as a
      // candidate so the parse step can report it properly.
      return true;
    }
  }
  return false;
}

/**
 * List what Add needs to classify the picked folder: ONE listing, direct
 * children only.
 *
 * Never throws. An unreadable folder answers "no manifest, no children", which
 * the detection turns into `plain` — the same thing an empty folder gets, and
 * the only outcome the user can act on.
 */
export async function probeAddTarget(dir: FileSystemDirectoryHandle): Promise<AddProbe> {
  const hasManifest = await hasManifestFile(dir);

  let manifestBroken = false;
  if (hasManifest) {
    try {
      manifestBroken = (await readManifest(dir)) === null;
    } catch {
      manifestBroken = true;
    }
  }

  const childProjectFolders: string[] = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'directory') continue;
      if (await hasManifestFile(handle as FileSystemDirectoryHandle)) childProjectFolders.push(name);
    }
  } catch {
    // Unreadable root — the manifest answer above already stands.
  }
  childProjectFolders.sort();

  return { hasManifest, childProjectFolders, manifestBroken };
}

/** Convenience: probe and classify in one step. */
export async function classifyAddTarget(
  dir: FileSystemDirectoryHandle,
): Promise<{ probe: AddProbe; target: OpenTarget }> {
  const probe = await probeAddTarget(dir);
  return { probe, target: detectOpenTarget(probe) };
}
