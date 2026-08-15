// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-storage — pure read/write of `project.json` and `scenes/*.scene.glb`
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
  writeBlobFile,
  writeTextFile,
} from '../engine/rv-local-filesystem';
import { LegacyFormatError, isLegacyScenePath } from './rv-legacy-format';
import { migrateProjectDocuments } from './rv-project-documents-migration';
import {
  documentKeyOf,
  documentOfSceneEntry,
  documentsInSection,
  fingerprintOf,
  readDocuments,
  withoutLegacyArrays,
} from './rv-project-documents';
import {
  PROJECT_FOLDER,
  PROJECT_MANIFEST_BAK_FILE,
  PROJECT_MANIFEST_FILE,
  PROJECT_SETTINGS_FILE,
  PROJECT_SETTINGS_REF,
  RV_PROJECT_SCHEMA_VERSION,
  canonicalNameOf,
  isValidProjectV1,
  isValidProjectV2,
  newProjectId,
  type RvDocumentEntry,
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
  /** True when `documents[]` was built from the legacy arrays on this read (plan-413 §2.4). */
  documentsMigrated: boolean;
  /** SHA-256 of the file as read — the compare-and-swap token for {@link updateManifestCas}. */
  revision: string | null;
}

/**
 * Read `project.json`, migrating inline and falling back to `project.json.bak`.
 * Returns null when neither file yields a usable manifest.
 *
 * ## Why both migrations run here and not at the call sites
 *
 * doc-persistence §13.3: a migrator belongs inside the `read*()` function. A
 * call site that forgets it produces a half-migrated object that looks valid
 * and behaves differently, and there is no way to tell the two apart downstream.
 * So this function is where a manifest becomes current — the v1-field migration
 * it always did, and the `documents[]` conversion (plan-413 §2.4 step B).
 *
 * It is also the **one gate** for F10. A manifest that still names a
 * `.scene.json` body, or that cannot be given a `documents[]` at all, is
 * refused here with {@link LegacyFormatError} rather than handed on in pieces.
 * Throwing at the entrance is what keeps "unsupported format" from degrading
 * into "a project that opens with some of its scenes missing".
 *
 * Nothing is written back. The migrated shape reaches disk on the next normal
 * save, which keeps discovery — which reads manifests of projects that are not
 * open — read-only, exactly as before.
 */
export async function readManifest(
  dir: FileSystemDirectoryHandle,
): Promise<ReadManifestResult | null> {
  const primary = await tryReadManifestFile(dir, PROJECT_MANIFEST_FILE);
  if (primary) return finishManifestRead(primary, false);

  const backup = await tryReadManifestFile(dir, PROJECT_MANIFEST_BAK_FILE);
  if (backup) return finishManifestRead(backup, true);

  return null;
}

async function finishManifestRead(
  read: { project: RvProject; migrated: boolean; revision: string | null },
  recoveredFromBackup: boolean,
): Promise<ReadManifestResult> {
  const migration = await migrateProjectDocuments(read.project);
  const project = migration.project;

  assertNoLegacyScenes(project);
  if (!isValidProjectV2(project)) {
    // The migration is the only route to `documents[]`, and it takes anything
    // shaped like a manifest. Arriving here means the stored file is neither a
    // v2 manifest nor convertible into one.
    throw new LegacyFormatError('manifest-not-migratable', PROJECT_MANIFEST_FILE);
  }

  return {
    project,
    migrated: read.migrated,
    recoveredFromBackup,
    documentsMigrated: migration.outcome === 'migrated',
    revision: read.revision,
  };
}

/**
 * Refuse a manifest whose scene documents point at pre-phase-6 JSON bodies.
 *
 * Checked over `documents[]` after the conversion rather than over `scenes[]`
 * before it, so a project gets the benefit of the migration first — an
 * unmigrated manifest full of `.scene.glb` rows is fine, and only the format of
 * the *bodies* decides. The first offender is enough: the user's next move is
 * the same whether one scene is affected or forty.
 */
function assertNoLegacyScenes(project: RvProject): void {
  for (const doc of documentsInSection(project, 'scenes')) {
    if (isLegacyScenePath(doc.path) || doc.format === 'json') {
      throw new LegacyFormatError('project-scene-json', doc.path);
    }
  }
}

async function tryReadManifestFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
): Promise<{ project: RvProject; migrated: boolean; revision: string | null } | null> {
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
  return { project, migrated: !alreadyValid, revision: await fingerprintOf(text) };
}

// ─── Manifest merge (forward compatibility, both levels) ─────────────────

/** The subset of manifest state this build knows how to update. */
export interface ManifestUpdate {
  /**
   * Scene upserts, expressed in the shape the scene layer speaks.
   *
   * Not a second list: they are lifted into `documents[]` and land there, in
   * the `scenes` section. The convenience is kept because the writer, the
   * project creator and the conflict path all hold an `RvProjectSceneEntry`
   * already, and making each of them build a document by hand would be four
   * places to get `section` wrong.
   */
  scenes?: RvProjectSceneEntry[];
  /** Scene ids to drop. Applied after upserts. */
  removeSceneIds?: string[];
  /** Document upserts (plan-413). Merged field-by-field, like `scenes`. */
  documents?: RvDocumentEntry[];
  /** Document keys (`id`, or a bare scene id) to drop. Applied after upserts. */
  removeDocumentIds?: string[];
  activeSceneId?: string | null;
  settingsRef?: { ref: string };
  modifiedAt?: string;
}

/**
 * Merge known updates into a parsed manifest **without reserialising from
 * the TS type**.
 *
 * Top level: spread the original, overwrite only the touched keys.
 * `documents[]`: merge field-by-field into the existing entry
 * (`{...existing, ...known}`) so an unknown field on a single entry — a
 * future `tags`, say — survives a save by this build. Fresh construction is
 * used only for entries that did not exist yet.
 */
export function mergeManifest(original: RvProject, update: ManifestUpdate): RvProject {
  const out: Record<string, unknown> = { ...(original as Record<string, unknown>) };

  // ── documents[] — the only artefact list (plan-413 §2.4 step B) ──
  //
  // `?? []` rather than "only when the project already has one": a manifest
  // with no list is a manifest whose first upsert creates it, and refusing to
  // do that here would leave the caller with an update that silently did
  // nothing.
  const documents = readDocuments(original) ?? [];
  const touchesDocuments = update.documents !== undefined
    || update.removeDocumentIds !== undefined
    || update.scenes !== undefined
    || update.removeSceneIds !== undefined;
  if (touchesDocuments) {
    const byKey = new Map<string, RvDocumentEntry>();
    const order: string[] = [];
    for (const doc of documents) {
      const key = documentKeyOf(doc);
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, doc);
    }
    const upserts: RvDocumentEntry[] = [
      ...(update.scenes ?? []).map(e => documentOfSceneEntry(e)),
      ...(update.documents ?? []),
    ];
    for (const incoming of upserts) {
      const key = documentKeyOf(incoming);
      const prev = byKey.get(key);
      // Field-level read-modify-write again — and here it is what keeps the
      // classification cache alive across a plain scene save, since a scene
      // upsert carries no `classification` field at all.
      if (prev) byKey.set(key, { ...prev, ...incoming });
      else { byKey.set(key, { ...incoming }); order.push(key); }
    }
    for (const id of [...(update.removeSceneIds ?? []), ...(update.removeDocumentIds ?? [])]) {
      for (const key of [...byKey.keys()]) {
        if (key === id || key.endsWith(`:${id}`)) byKey.delete(key);
      }
    }
    out.documents = order.filter(k => byKey.has(k)).map(k => byKey.get(k)!);
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
  opts: WriteManifestOptions = {},
): Promise<string> {
  const previous = await readTextFile(dir, PROJECT_MANIFEST_FILE).catch(() => null);

  // Compare-and-swap, checked as late as possible (§2.4, SOL R2-1). The `.bak`
  // is crash insurance, not conflict handling: it recovers a torn write, and is
  // exactly no help against a second writer whose complete, valid manifest we
  // are about to overwrite with one built from a stale read.
  if (opts.expectedRevision !== undefined) {
    const actual = previous === null ? null : await fingerprintOf(previous);
    if (actual !== opts.expectedRevision) {
      throw new ManifestRevisionConflictError(opts.expectedRevision, actual);
    }
  }

  if (previous !== null) {
    // Best effort: a failed backup must not block the actual save.
    try {
      await writeTextFile(dir, PROJECT_MANIFEST_BAK_FILE, previous);
    } catch { /* keep going — the primary write is what matters */ }
  }
  // The single funnel every manifest write goes through, and the last place a
  // legacy array can still be sitting on an in-memory manifest that was built
  // before the conversion ran (a hand-made fixture, an older code path). It
  // does not reach disk from here (§2.4 step B).
  const text = JSON.stringify(withoutLegacyArrays(project), null, 2);
  await writeTextFile(dir, PROJECT_MANIFEST_FILE, text);
  return fingerprintOf(text);
}

export interface WriteManifestOptions {
  /**
   * The revision the caller's copy was read at. When given, the write is
   * refused with a {@link ManifestRevisionConflictError} unless the file on
   * disk still hashes to it.
   */
  expectedRevision?: string | null;
}

/** Thrown when a manifest write's compare-and-swap precondition fails. */
export class ManifestRevisionConflictError extends Error {
  constructor(
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super('project.json changed since it was read — the write was refused.');
    this.name = 'ManifestRevisionConflictError';
  }
}

/**
 * Read-modify-write the manifest under a compare-and-swap precondition,
 * retrying against the fresh state on conflict (§2.4, SOL R2-1).
 *
 * `apply` is handed the manifest **as it is on disk right now** and returns
 * what should replace it. On a conflict it is called again with the newer
 * state — which is why it has to be a pure function of its input and not a
 * closure over a manifest read earlier. That is the whole contract: retrying a
 * merge is safe, retrying a diff is not.
 *
 * Note what this is and is not. The File System Access API has no atomic
 * replace, so the window between the last check and the write is real, just
 * very small. What it buys is the difference between "the other writer's change
 * is gone" and "the other writer's change is the base of ours" — which is the
 * difference that costs data.
 */
export async function updateManifestCas(
  dir: FileSystemDirectoryHandle,
  apply: (current: RvProject | null) => RvProject | Promise<RvProject>,
  opts: { retries?: number } = {},
): Promise<{ project: RvProject; revision: string }> {
  const retries = Math.max(0, opts.retries ?? 3);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const read = await readManifest(dir);
    const next = await apply(read?.project ?? null);
    try {
      const revision = await writeManifest(dir, next, {
        expectedRevision: read?.revision ?? null,
      });
      return { project: next, revision };
    } catch (e) {
      if (!(e instanceof ManifestRevisionConflictError)) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ManifestRevisionConflictError(null, null);
}

// ─── GLB scene bodies (plan-397 phase 5) ────────────────────────────────

/**
 * Read one `scenes/<file>.scene.glb` as raw bytes.
 *
 * No parsing, no validation: whether the bytes are a well-formed GLB is the
 * loader's question, and answering it here would mean parsing every scene of
 * a project just to list it — the exact cost §2.7 removes from `listScenes`.
 * Absent reads as null, as everywhere else in this module.
 */
export async function readSceneGlbFile(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<Uint8Array | null> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await tryGetSubfolder(dir, folder) : dir;
  if (!sub) return null;
  try {
    const file = await (await sub.getFileHandle(filename)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Replace a file's contents so that a failure leaves the previous state
 * untouched (§2.8, "atomarer Ersatz — kein Teilzustand").
 *
 * The File System Access API has no `rename`, so the usual temp-then-rename
 * dance is not available. What *is* available is that `createWritable()`
 * buffers into a swap file and only commits on `close()` — so a write that
 * throws before `close()` has changed nothing. That covers the interesting
 * half of the problem and not the boring one:
 * `getFileHandle(name, {create: true})` materialises a **zero-byte file**
 * before the stream even opens. Without the rollback below, a write that
 * failed at its very first step would replace "no scene here" with "a scene
 * whose body is empty" — a corrupt file where there had been none.
 *
 * Hence: remember what was there, and on failure put it back (or remove the
 * file when there was nothing). Restoration is best-effort — if even that
 * fails the original error is what the caller needs to see, not a second one
 * about the cleanup.
 */
export async function atomicReplaceFile(
  dir: FileSystemDirectoryHandle,
  filename: string,
  blob: Blob,
): Promise<void> {
  let previous: Blob | null = null;
  let existed = false;
  try {
    previous = await (await dir.getFileHandle(filename)).getFile();
    existed = true;
  } catch {
    // Not there — the rollback is "remove it again".
  }

  try {
    await writeBlobFile(dir, filename, blob);
  } catch (e) {
    try {
      if (existed && previous) await writeBlobFile(dir, filename, previous);
      else await removeFileEntry(dir, filename);
    } catch { /* the original failure is the one that matters */ }
    throw e;
  }
}

/** Write one scene GLB body, creating `scenes/` lazily. Atomic (see above). */
export async function writeSceneGlbFile(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  glb: Uint8Array,
): Promise<void> {
  const { folder, filename } = splitRelPath(relPath);
  const sub = folder ? await getOrCreateSubfolder(dir, folder) : dir;
  await atomicReplaceFile(
    sub,
    filename,
    new Blob([glb as unknown as BlobPart], { type: 'model/gltf-binary' }),
  );
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
