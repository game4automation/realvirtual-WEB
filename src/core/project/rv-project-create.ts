// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-create — "New Project from current scenes…" (§4.5).
 *
 * The migration path for an existing user. Before this, someone with a
 * browser full of saved scenes had exactly one way into a project: open an
 * empty folder and re-save every scene by hand.
 *
 * Three rules govern what happens here, and all three are about not
 * destroying something:
 *
 * 1. **The cache is never cleared.** After this runs the scenes exist in both
 *    worlds; the folder simply becomes the reference. Nothing about R2 lets a
 *    "migration" double as a delete.
 * 2. **An existing project is never overwritten.** If the chosen folder
 *    already carries a readable `project.json`, this refuses and says so —
 *    the caller should open that project instead. Writing a fresh manifest
 *    over someone else's would lose their whole scene index.
 * 3. **Bodies first, manifest last.** Same ordering as the folder writer, for
 *    the same reason: the manifest must never reference a file that is not
 *    there yet.
 *
 * A non-empty foreign folder that has no `project.json` is a legitimate
 * target — nothing already in it is touched, only `scenes/` and
 * `project.json` are added (§1.1 R2).
 */

import { PROJECT_GIT_TEMPLATES } from './templates/project-git-templates';
import { readScene } from '../hmi/scene/rv-scene-storage';
import type { RvScene } from '../hmi/scene/rv-scene-types';
import { sceneEntryOf } from './rv-project-folder-writer';
import {
  mergeManifest,
  readManifest,
  writeManifest,
  writeSceneGlbFile,
} from './rv-project-storage';
import { readSceneGlb } from '../storage/rv-scene-glb-store';
import { writeBlobFile } from '../engine/rv-local-filesystem';
import { setCachedFrom } from './rv-scene-owner';
import {
  newProject,
  sceneGlbRelPathFor,
  type RvProject,
  type RvProjectSceneEntry,
} from './rv-project-types';

export interface CreateProjectFromScenesOptions {
  /** Scene id to record as `activeSceneId`. Ignored when it was not written. */
  activeSceneId?: string | null;
  /** Catalogue-row lookup override. Tests inject; production uses the cache. */
  readScene?: (id: string) => RvScene | null;
  /**
   * GLB body lookup override. Tests inject; production reads the OPFS store.
   *
   * The store rather than `readSceneGlbBody()`: that one asks the *open*
   * project first, and the whole point of this function is that the scenes
   * being migrated do not belong to a project yet.
   */
  readSceneGlb?: (id: string) => Promise<Uint8Array | null>;
}

export type CreateProjectFromScenesResult =
  | {
      ok: true;
      project: RvProject;
      /** Ids whose body reached the folder. */
      written: string[];
      /** Ids skipped because no body was in the cache. */
      skipped: string[];
    }
  | { ok: false; reason: 'project-exists' | 'write-failed'; message: string };

/**
 * Create a project in `dir` from scenes that currently live in the browser
 * cache, then leave it for the caller to open.
 *
 * Opening is deliberately *not* done here: `ProjectStore.openProjectFolder()`
 * owns the dirty guard, the reconciliation and the draft scope, and a second
 * entry point into that sequence is how those get skipped.
 */
export async function createProjectFromScenes(
  dir: FileSystemDirectoryHandle,
  name: string,
  sceneIds: readonly string[],
  opts: CreateProjectFromScenesOptions = {},
): Promise<CreateProjectFromScenesResult> {
  const existing = await readManifest(dir).catch(() => null);
  if (existing) {
    return {
      ok: false,
      reason: 'project-exists',
      message: `"${dir.name}" already contains the project "${existing.project.name}". Open it instead.`,
    };
  }

  const read = opts.readScene ?? readScene;
  const readGlb = opts.readSceneGlb ?? readSceneGlb;
  const entries: RvProjectSceneEntry[] = [];
  const written: string[] = [];
  const skipped: string[] = [];

  try {
    // ── bodies first ──
    //
    // A scene with no GLB body is skipped exactly like a scene with no
    // catalogue row. Since plan-397 the body IS the scene; writing the row
    // alone would put a card in the new project that opens to nothing.
    for (const id of sceneIds) {
      const scene = read(id);
      if (!scene) { skipped.push(id); continue; }
      const glb = await readGlb(id);
      if (!glb) { skipped.push(id); continue; }
      const relPath = sceneGlbRelPathFor(scene);
      await writeSceneGlbFile(dir, relPath, glb);
      entries.push(sceneEntryOf(scene, relPath));
      written.push(id);
    }

    // ── manifest last ──
    const activeSceneId = opts.activeSceneId && written.includes(opts.activeSceneId)
      ? opts.activeSceneId
      : null;
    const project = mergeManifest(newProject(name.trim() || dir.name || 'Untitled project'), {
      scenes: entries,
      activeSceneId,
    });
    await writeManifest(dir, project);

    // Git templates (plan-372 Phase 15). Best-effort: a project whose
    // .gitattributes could not be written is still a perfectly good project,
    // and failing creation over it would be absurd. Creation time is the only
    // moment the user is reliably present, which is why it happens here rather
    // than on first commit.
    for (const template of PROJECT_GIT_TEMPLATES) {
      try {
        await writeBlobFile(
          dir,
          template.name,
          new Blob([template.contents], { type: 'text/plain' }),
        );
      } catch (e) {
        console.warn(`[project] could not write ${template.name}:`, e);
      }
    }

    // Provenance, once the manifest makes the project real (plan-373). Every
    // body that reached the folder came *from the cache*, so at this instant
    // the cache demonstrably holds this project's content. Recording it is
    // what lets the next project sharing these ids notice that the cache is
    // not its own — the behaviour of this function is unchanged, multiple
    // membership stays deliberate, only the fact is now written down.
    for (const id of written) setCachedFrom(id, project.id);

    return { ok: true, project, written, skipped };
  } catch (e) {
    // Partial scene files may remain. They are inert without a manifest —
    // and deleting them would be the tidying-up writer §1.1 R2 forbids.
    return {
      ok: false,
      reason: 'write-failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
