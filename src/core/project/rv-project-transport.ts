// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-transport — `.rvproject` export and import (plan-372 Phase 16).
 *
 * A project is normally a folder under git. `.rvproject` is the other way to
 * move one: a single zip you can mail, attach to a ticket, or hand to a
 * customer who does not use git.
 *
 * ## Why this is last in the plan
 *
 * It is the only feature that can hand a user a file which *looks* like their
 * project but is not. Everything it does therefore leans conservative:
 *
 * - **A copy gets a fresh `id`.** Two projects sharing an id would fight over
 *   the same `rv-project/last` slot, the same scene-ownership markers and the
 *   same thumbnail cache keys. Importing is a copy, so the copy is a new
 *   project — the name is kept, the identity is not.
 * - **Ignored paths never travel.** Caches and secrets are excluded on the way
 *   *out*, using the same list `.rvprojectignore` documents. An export that
 *   quietly carried `.env` would be the worst possible bug in this file.
 * - **Import refuses to overwrite.** A target folder that already holds a
 *   `project.json` is someone else's project; unpacking over it would destroy a
 *   scene index that is not ours to touch.
 *
 * ## Safari / Firefox
 *
 * Export never needs the File System Access API — it produces a Blob and hands
 * it to a normal download. Import needs a directory to unpack *into*, which
 * those browsers cannot offer; callers get `unsupported` and should keep using
 * a browser project. That is the honest boundary, not a silent half-import.
 */

import { PROJECT_MANIFEST_FILE, newProject, type RvProject } from './rv-project-types';
import { PROJECT_GIT_TEMPLATES } from './templates/project-git-templates';

/** File extension of the transport container. */
export const RVPROJECT_EXTENSION = '.rvproject';

/**
 * Path prefixes and names that never travel in a `.rvproject`.
 *
 * Mirrors `.rvprojectignore`. Kept as code rather than parsed from the file so
 * an export is safe even for a project created before that template existed —
 * a missing ignore file must not mean "ship everything".
 */
const NEVER_EXPORT = [
  '.cad-cache/',
  '.trash/',
  '.git/',
  'node_modules/',
];

/**
 * Kept in step with `SECRET_FILE_PATTERNS` in `scripts/_rv-guards.mjs`, which
 * is the source of truth for the Node tooling. This list stays duplicated on
 * purpose — the browser bundle must not import a build script — but the two
 * must not diverge, and `secrets.local.json` is the entry that proved they can
 * (plan-700 B11): CONNECT stores gateway credentials in
 * `connect/secrets.local.json`, so an export that carried it would mail a
 * customer's credentials to whoever received the `.rvproject`.
 */
const NEVER_EXPORT_NAMES = [
  '.env',
  '.npmrc',
  '.mcp_auth_token',
  'secrets.local.json',
  'credentials.json',
  '.DS_Store',
  'Thumbs.db',
];

/** True when a project-relative path must be excluded from an export. */
export function isExcludedFromExport(relPath: string): boolean {
  const path = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (NEVER_EXPORT.some(prefix => path === prefix.slice(0, -1) || path.startsWith(prefix))) return true;
  const name = path.split('/').pop() ?? path;
  if (NEVER_EXPORT_NAMES.includes(name)) return true;
  // `.env.production`, `.env.local`, … — the dotted variants matter as much as
  // the bare name, and are the ones people actually forget.
  if (name.startsWith('.env.')) return true;
  if (/\.secrets\.json$/i.test(name)) return true;
  if (/\.(pem|p12|pfx|keystore|snk)$/i.test(name)) return true;
  return false;
}

export type ExportResult =
  | { kind: 'exported'; blob: Blob; fileName: string; entryCount: number; skipped: string[] }
  | { kind: 'error'; message: string };

export type ImportResult =
  | { kind: 'imported'; project: RvProject; entryCount: number }
  | { kind: 'project-exists'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

/** Recursively collect every exportable file as a project-relative path. */
async function collectFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: { path: string; handle: FileSystemFileHandle }[],
  skipped: string[],
): Promise<void> {
  const iterable = dir as unknown as {
    entries(): AsyncIterable<[string, FileSystemHandle]>;
  };
  for await (const [name, handle] of iterable.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (isExcludedFromExport(rel)) { skipped.push(rel); continue; }
    if (handle.kind === 'directory') {
      await collectFiles(handle as FileSystemDirectoryHandle, rel, out, skipped);
    } else {
      out.push({ path: rel, handle: handle as FileSystemFileHandle });
    }
  }
}

/**
 * Zip a project folder into a `.rvproject` blob.
 *
 * The caller owns the download; this function performs no UI. `skipped` names
 * everything the ignore rules dropped, so the caller can say so rather than
 * leaving the user to wonder why the archive is smaller than the folder.
 */
export async function exportProject(
  dir: FileSystemDirectoryHandle,
  projectName: string,
): Promise<ExportResult> {
  try {
    const files: { path: string; handle: FileSystemFileHandle }[] = [];
    const skipped: string[] = [];
    await collectFiles(dir, '', files, skipped);

    if (!files.some(f => f.path === PROJECT_MANIFEST_FILE)) {
      return { kind: 'error', message: `"${dir.name}" has no ${PROJECT_MANIFEST_FILE} — it is not a project.` };
    }

    // Dynamic import: JSZip is a large dependency and most sessions never
    // export. Same pattern as the AASX parser.
    const { default: JSZipLib } = await import('jszip');
    const zip = new JSZipLib();
    for (const file of files) {
      zip.file(file.path, await (await file.handle.getFile()).arrayBuffer());
    }

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const stem = projectName.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'project';
    return {
      kind: 'exported',
      blob,
      fileName: `${stem}${RVPROJECT_EXTENSION}`,
      entryCount: files.length,
      skipped,
    };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Zip-slip guard: reject any entry path that could escape the chosen folder.
 *
 * Exported so it can be tested directly. That matters because JSZip normalises
 * `../` away when *it* authors an archive, so a round-trip test can never reach
 * this check — but a hand-crafted or third-party zip absolutely can, and that
 * is precisely the case worth defending against.
 */
export function isUnsafeEntryPath(entryPath: string): boolean {
  const normalised = entryPath.replace(/\\/g, '/');
  if (normalised.startsWith('/')) return true;          // absolute
  if (/^[a-zA-Z]:/.test(normalised)) return true;       // Windows drive
  return normalised.split('/').some(s => s === '..');
}

/** Create nested directories for a zip entry path and return the leaf handle. */
async function ensureDir(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) {
    if (!segment || segment === '.') continue;          // harmless noise
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

/**
 * Unpack a `.rvproject` into `target`, giving the copy a fresh project id.
 *
 * Refuses a target that already carries a manifest: that is another project,
 * and overwriting its `project.json` would lose its whole scene index.
 */
export async function importProject(
  file: Blob,
  target: FileSystemDirectoryHandle,
): Promise<ImportResult> {
  try {
    // Refuse before writing anything at all.
    try {
      await target.getFileHandle(PROJECT_MANIFEST_FILE);
      return {
        kind: 'project-exists',
        message: `"${target.name}" already contains a project. Choose an empty folder.`,
      };
    } catch { /* no manifest — good, carry on */ }

    const { default: JSZipLib } = await import('jszip');
    const zip = await JSZipLib.loadAsync(file);

    const manifestEntry = zip.file(PROJECT_MANIFEST_FILE);
    if (!manifestEntry) {
      return { kind: 'invalid', message: `This archive has no ${PROJECT_MANIFEST_FILE}.` };
    }

    let source: RvProject;
    try {
      source = JSON.parse(await manifestEntry.async('string')) as RvProject;
    } catch {
      return { kind: 'invalid', message: `${PROJECT_MANIFEST_FILE} in the archive is not valid JSON.` };
    }

    // A copy is a NEW project: a shared id would make two projects fight over
    // the same last-opened slot, ownership markers and thumbnail cache keys.
    const copy: RvProject = { ...source, ...newProject(source.name ?? target.name), name: source.name ?? target.name };
    copy.id = newProject(copy.name).id;

    let entryCount = 0;
    const entries = Object.values(zip.files).filter(e => !e.dir);
    for (const entry of entries) {
      if (entry.name === PROJECT_MANIFEST_FILE) continue;      // written last, rewritten
      if (isExcludedFromExport(entry.name)) continue;          // defence in depth
      if (isUnsafeEntryPath(entry.name)) {
        return {
          kind: 'invalid',
          message: `Refusing to unpack "${entry.name}" — it would write outside the chosen folder.`,
        };
      }
      const segments = entry.name.split('/');
      const fileName = segments.pop()!;
      const dir = await ensureDir(target, segments);
      const handle = await dir.getFileHandle(fileName, { create: true });
      const writable = await (handle as unknown as {
        createWritable(): Promise<{ write(d: ArrayBuffer): Promise<void>; close(): Promise<void> }>;
      }).createWritable();
      await writable.write(await entry.async('arraybuffer'));
      await writable.close();
      entryCount++;
    }

    // Bodies first, manifest last — same ordering rule the folder writer and
    // rv-project-create follow, so a torn import never leaves a manifest
    // referencing files that are not there.
    const manifestHandle = await target.getFileHandle(PROJECT_MANIFEST_FILE, { create: true });
    const manifestWritable = await (manifestHandle as unknown as {
      createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
    }).createWritable();
    await manifestWritable.write(JSON.stringify(copy, null, 2));
    await manifestWritable.close();
    entryCount++;

    // A project unpacked from a zip is git-managed from here on, so it gets the
    // same templates a folder project created in the app would get.
    for (const template of PROJECT_GIT_TEMPLATES) {
      try {
        const h = await target.getFileHandle(template.name, { create: true });
        const w = await (h as unknown as {
          createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
        }).createWritable();
        await w.write(template.contents);
        await w.close();
      } catch { /* best-effort, exactly as at creation */ }
    }

    return { kind: 'imported', project: copy, entryCount };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
