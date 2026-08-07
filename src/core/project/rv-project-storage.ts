// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-storage — pure read/write of `project.json` and `scenes/*.scene.json`
 * over a `FileSystemDirectoryHandle`.
 *
 * No React, no Three.js, no picker. Everything here runs against an injected
 * handle, which is what keeps it testable: the real File System Access path
 * (`showDirectoryPicker`, the permission dialog) is not automatable in any
 * CI, so the picker stays a thin untested rim and *this* module — where the
 * data lives or dies — is fully covered against a fake handle.
 *
 * Three contracts this file exists to hold:
 *
 * 1. **Forward compatibility.** {@link mergeManifest} does read-modify-write
 *    on the parsed original at every level, including inside a `scenes[]`
 *    entry. Serialising from the TS type would silently delete any section
 *    or field a newer client wrote — as a *deletion* in the git diff.
 * 2. **Inline migration (R4).** Phase 1 runs before the offline migrator, so
 *    a manifest without `schemaVersion`/`id` must be *migrated on read*, not
 *    rejected. Otherwise none of the five existing projects could be opened.
 * 3. **Torn-write recovery.** The manifest is written last and preceded by a
 *    `.bak` copy of the previous content; {@link readManifest} falls back to
 *    the `.bak` when the primary file is unparseable.
 */

import {
  getOrCreateSubfolder,
  readTextFile,
  removeFileEntry,
  tryGetSubfolder,
  writeTextFile,
} from '../engine/rv-local-filesystem';
import { isValidSceneV2, type RvScene } from '../hmi/scene/rv-scene-types';
import {
  PROJECT_FOLDER,
  PROJECT_MANIFEST_BAK_FILE,
  PROJECT_MANIFEST_FILE,
  PROJECT_SETTINGS_FILE,
  PROJECT_SETTINGS_REF,
  RV_PROJECT_SCHEMA_VERSION,
  canonicalNameOf,
  isValidProjectV1,
  newProjectId,
  type RvProject,
  type RvProjectSceneEntry,
} from './rv-project-types';

// ─── Migration (R4 — inline, so Phase 1 stands without the offline CLI) ──

/**
 * Bring a parsed manifest up to `rv-project/1.0` **additively**.
 *
 * Adds `schemaVersion`, `id`, `canonicalName`, `createdAt` and `modifiedAt`
 * when missing and leaves everything else exactly as it was — in particular
 * the deploy fields `code`, `name`, `created`, `lastPublished` and
 * `settings`, which keep their name, place and meaning.
 *
 * Returns null when the input is not an object at all; a manifest missing
 * only the new fields is migrated, never refused.
 */
export function migrateManifest(raw: unknown): RvProject | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  if (typeof out.schemaVersion !== 'number') out.schemaVersion = RV_PROJECT_SCHEMA_VERSION;
  if (typeof out.id !== 'string' || out.id.trim() === '') out.id = newProjectId();
  if (typeof out.name !== 'string' || out.name.trim() === '') {
    // Fall back to the deploy `code`, then to a placeholder — `name` is
    // required by both readers, and refusing to open here would strand the
    // project entirely.
    const code = typeof src.code === 'string' ? src.code.trim() : '';
    out.name = code || 'Untitled project';
  }
  if (typeof out.canonicalName !== 'string' || out.canonicalName.trim() === '') {
    out.canonicalName = canonicalNameOf(String(out.name));
  }
  if (typeof out.createdAt !== 'string') {
    out.createdAt = typeof src.created === 'string' ? src.created : new Date().toISOString();
  }
  if (typeof out.modifiedAt !== 'string') out.modifiedAt = new Date().toISOString();

  return isValidProjectV1(out) ? (out as RvProject) : null;
}

// ─── Manifest read ──────────────────────────────────────────────────────

export interface ReadManifestResult {
  project: RvProject;
  /** True when the on-disk manifest lacked new fields and was migrated on read. */
  migrated: boolean;
  /** True when the primary file was unusable and the `.bak` was used. */
  recoveredFromBackup: boolean;
}

/**
 * Read `project.json`, migrating inline and falling back to `project.json.bak`.
 * Returns null when neither file yields a usable manifest.
 */
export async function readManifest(
  dir: FileSystemDirectoryHandle,
): Promise<ReadManifestResult | null> {
  const primary = await tryReadManifestFile(dir, PROJECT_MANIFEST_FILE);
  if (primary) return { ...primary, recoveredFromBackup: false };

  const backup = await tryReadManifestFile(dir, PROJECT_MANIFEST_BAK_FILE);
  if (backup) return { ...backup, recoveredFromBackup: true };

  return null;
}

async function tryReadManifestFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<{ project: RvProject; migrated: boolean } | null> {
  let text: string | null;
  try {
    text = await readTextFile(dir, filename);
  } catch {
    return null;
  }
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const alreadyValid = isValidProjectV1(parsed);
  const project = alreadyValid ? (parsed as RvProject) : migrateManifest(parsed);
  if (!project) return null;
  return { project, migrated: !alreadyValid };
}

// ─── Manifest merge (forward compatibility, both levels) ─────────────────

/** The subset of manifest state this build knows how to update. */
export interface ManifestUpdate {
  scenes?: RvProjectSceneEntry[];
  /** Ids to drop from `scenes[]`. Applied after `scenes` upserts. */
  removeSceneIds?: string[];
  activeSceneId?: string | null;
  settingsRef?: { ref: string };
  modifiedAt?: string;
}

/**
 * Merge known updates into a parsed manifest **without reserialising from
 * the TS type**.
 *
 * Top level: spread the original, overwrite only the touched keys.
 * `scenes[]`: merge field-by-field into the existing entry
 * (`{...existing, ...known}`) so an unknown field on a single entry — a
 * future `tags`, say — survives a save by this build. `metaOf()`-style
 * fresh construction is used only for entries that did not exist yet.
 */
export function mergeManifest(original: RvProject, update: ManifestUpdate): RvProject {
  const out: Record<string, unknown> = { ...(original as Record<string, unknown>) };

  if (update.scenes !== undefined || update.removeSceneIds !== undefined) {
    const existing = Array.isArray(original.scenes) ? original.scenes : [];
    const byId = new Map<string, RvProjectSceneEntry>();
    const order: string[] = [];
    for (const e of existing) {
      if (!e || typeof e.id !== 'string') continue;
      byId.set(e.id, e);
      order.push(e.id);
    }
    for (const incoming of update.scenes ?? []) {
      const prev = byId.get(incoming.id);
      if (prev) {
        // Field-level read-modify-write: unknown keys on `prev` survive.
        byId.set(incoming.id, { ...prev, ...incoming });
      } else {
        byId.set(incoming.id, { ...incoming });
        order.push(incoming.id);
      }
    }
    for (const id of update.removeSceneIds ?? []) byId.delete(id);
    out.scenes = order.filter(id => byId.has(id)).map(id => byId.get(id)!);
  }

  if (update.activeSceneId !== undefined) out.activeSceneId = update.activeSceneId;
  if (update.settingsRef !== undefined) {
    const prev = (original.settingsRef ?? {}) as Record<string, unknown>;
    out.settingsRef = { ...prev, ...update.settingsRef };
  }
  out.modifiedAt = update.modifiedAt ?? new Date().toISOString();

  return out as RvProject;
}

// ─── Manifest write (atomic-ish: .bak first, manifest last) ─────────────

/**
 * Write the manifest, keeping the previous content in `project.json.bak`.
 *
 * The File System Access API has no rename, so "atomic" here means: the
 * previous good content is preserved in a sibling file *before* the primary
 * is opened for writing. A crash mid-write leaves an unparseable
 * `project.json` and a valid `.bak`, which {@link readManifest} recovers.
 *
 * Callers must write scene bodies **before** calling this (bodies first,
 * manifest last), so the manifest never references a file that is not there.
 */
export async function writeManifest(
  dir: FileSystemDirectoryHandle,
  project: RvProject,
): Promise<void> {
  const previous = await readTextFile(dir, PROJECT_MANIFEST_FILE).catch(() => null);
  if (previous !== null) {
    // Best effort: a failed backup must not block the actual save.
    try {
      await writeTextFile(dir, PROJECT_MANIFEST_BAK_FILE, previous);
    } catch { /* keep going — the primary write is what matters */ }
  }
  await writeTextFile(dir, PROJECT_MANIFEST_FILE, JSON.stringify(project, null, 2));
}

// ─── Scene bodies ───────────────────────────────────────────────────────

/**
 * Read one `scenes/<file>.scene.json`. Returns null when absent or not a
 * valid schemaVersion-2 scene — a corrupt file must not take the project
 * down with it.
 */
export async function readSceneFile(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<RvScene | null> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await tryGetSubfolder(dir, folder) : dir;
  if (!sub) return null;
  let text: string | null;
  try {
    text = await readTextFile(sub, filename);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return isValidSceneV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write one scene body. Creates the target subfolder lazily on first write. */
export async function writeSceneFile(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  scene: RvScene,
): Promise<void> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await getOrCreateSubfolder(dir, folder) : dir;
  await writeTextFile(sub, filename, JSON.stringify(scene, null, 2));
}

/**
 * Delete one scene body. Idempotent; a missing folder is not an error.
 *
 * This is the *only* deletion the folder writer performs, and it is the
 * named exception to "the writer never removes anything" (§1.1 R2): R2
 * forbids tidying away files that are not in the manifest, not carrying out
 * a deletion the user explicitly asked for.
 */
export async function deleteSceneFile(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<void> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await tryGetSubfolder(dir, folder) : dir;
  if (!sub) return;
  await removeFileEntry(sub, filename);
}

// ─── Settings bundle ────────────────────────────────────────────────────

/** Read `settings/project-settings.json`. Returns null when absent/unparseable. */
export async function readSettingsFile(
  dir: FileSystemDirectoryHandle,
  relPath: string = PROJECT_SETTINGS_REF,
): Promise<unknown | null> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await tryGetSubfolder(dir, folder) : dir;
  if (!sub) return null;
  try {
    const text = await readTextFile(sub, filename);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** Write `settings/project-settings.json`, creating `settings/` lazily. */
export async function writeSettingsFile(
  dir: FileSystemDirectoryHandle,
  bundle: unknown,
  relPath: string = PROJECT_SETTINGS_REF,
): Promise<void> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await getOrCreateSubfolder(dir, folder) : dir;
  await writeTextFile(sub, filename, JSON.stringify(bundle, null, 2));
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Split `a/b/c.json` into its (single-level) folder and filename. */
export function splitRelPath(relPath: string): { folder: string | null; filename: string } {
  const clean = (relPath ?? '').replace(/^\.?\//, '');
  const idx = clean.lastIndexOf('/');
  if (idx < 0) return { folder: null, filename: clean };
  return { folder: clean.slice(0, idx), filename: clean.slice(idx + 1) };
}

/** Names kept for callers that want the canonical folder/file constants. */
export const PROJECT_STORAGE_PATHS = {
  scenes: PROJECT_FOLDER.scenes,
  settings: PROJECT_FOLDER.settings,
  settingsFile: PROJECT_SETTINGS_FILE,
} as const;
