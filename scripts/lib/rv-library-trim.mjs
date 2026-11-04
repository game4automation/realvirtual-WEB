// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-library-trim.mjs — ships the library projects a staged project uses as
 * trimmed copies under `libraries/<projectId>/` (plan-778 Phase 4, F15).
 *
 * The decision (which libraries, which documents, which hint) is
 * `src/core/project/rv-library-trim-core.mjs` — the same module the browser's
 * "Pack with libraries" runs. This file is its file-system half for the Node
 * channels: it finds library SOURCES, reads only the JSON chunk of each GLB,
 * and writes the result into a STAGED copy of a project. It is called by the
 * two shared staging helpers (`stageFilteredSourceTree`, `stageHostedProject`),
 * so every channel — hosted deploy, customer delivery, CONNECT embed, the
 * partner publish — gets the same result.
 *
 * Library sources, in this order (first hit wins):
 *  1. `--library <projectId>=<folder>` (explicit, repeatable);
 *  2. `--projects-dir <dir>`: every direct sub-folder whose `project.json` has
 *     that id (folder names do not matter — identity does);
 *  3. the staged project's OWN `libraries/<projectId>/` (a project that was
 *     packed or delivered before carries its libraries along).
 * An id no source knows fails the delivery (exit 1). The realvirtual library is
 * never trimmed: it is public and ships app-level `/library/` (N2).
 *
 * Never call this on a SOURCE project: it rewrites `project.json` (library
 * hints → `libraries/<id>/project.json`) and replaces `libraries/`.
 */

import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { withDerivedDocuments } from '../_rv-manifest.mjs';
import {
  DELIVERED_LIBRARIES_FOLDER,
  GLB_JSON_CHUNK_OFFSET,
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  formatLibraryTrimErrors,
  glbJsonChunkLength,
  isContainedPath,
  libraryProjectIdProblem,
  normalizeLibraryPath,
  parseGlbJson,
  planLibraryTrimSync,
  withDeliveredLibraryHints,
} from '../../src/core/project/rv-library-trim-core.mjs';

export { DELIVERED_LIBRARIES_FOLDER, REALVIRTUAL_LIBRARY_PROJECT_ID };

/** Exit-1 error of an unresolvable library or reference. */
export class LibraryTrimError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'LibraryTrimError';
    this.code = 'LIBRARY_TRIM_FAILED';
    this.errors = errors;
  }
}

// ─── CLI arguments ─────────────────────────────────────────────────────────

/**
 * `--projects-dir <dir>` and every `--library <projectId>=<folder>` of an argv.
 * Throws on a malformed `--library` (a delivery must not run with a source the
 * user meant but the parser dropped).
 */
export function parseLibrarySourceArgs(argv) {
  const out = { projectsDir: null, libraries: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--projects-dir') {
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) { out.projectsDir = value; i++; }
      continue;
    }
    if (arg !== '--library') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error('--library needs <projectId>=<folder>.');
    i++;
    const eq = value.indexOf('=');
    if (eq <= 0 || eq === value.length - 1) throw new Error(`--library needs <projectId>=<folder>, got "${value}".`);
    const projectId = value.slice(0, eq).trim();
    const problem = libraryProjectIdProblem(projectId);
    if (problem) throw new Error(`--library: ${problem}.`);
    out.libraries[projectId] = value.slice(eq + 1).trim();
  }
  return out;
}

/** The argv that hands `sources` on to a child process (`deliver.mjs` → generator). */
export function librarySourceArgv(sources) {
  const out = [];
  if (sources?.projectsDir) out.push('--projects-dir', resolve(sources.projectsDir));
  for (const [id, folder] of Object.entries(sources?.libraries ?? {})) out.push('--library', `${id}=${resolve(folder)}`);
  return out;
}

// ─── Sources ───────────────────────────────────────────────────────────────

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** `{ id → folder }` of every direct sub-folder of `dir` that holds a project.json with an id. */
function indexProjectFolders(dir, duplicates = null) {
  const index = new Map();
  if (!dir || !existsSync(dir)) return index;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return index; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = join(dir, entry.name);
    const manifest = readJsonOrNull(join(folder, 'project.json'));
    const id = manifest && typeof manifest.id === 'string' ? manifest.id : '';
    if (!id) continue;
    if (!index.has(id)) { index.set(id, folder); continue; }
    if (duplicates) {
      if (!duplicates.has(id)) duplicates.set(id, [index.get(id)]);
      duplicates.get(id).push(folder);
    }
  }
  return index;
}

/**
 * A `(projectId) => folder | null` over the configured sources (see the module
 * comment for the order). `ownLibrariesDir` is the staged project's own
 * `libraries/` folder.
 */
export function createLibrarySourceResolver({ projectsDir = null, libraries = {}, ownLibrariesDir = null } = {}) {
  const explicit = new Map(Object.entries(libraries ?? {}).map(([id, folder]) => [id, resolve(folder)]));
  let projectsIndex = null;
  const duplicates = new Map();
  let ownIndex = null;
  const resolver = (projectId) => {
    if (explicit.has(projectId)) return explicit.get(projectId);
    projectsIndex ??= indexProjectFolders(projectsDir ? resolve(projectsDir) : null, duplicates);
    if (projectsIndex.has(projectId)) return projectsIndex.get(projectId);
    ownIndex ??= indexProjectFolders(ownLibrariesDir);
    return ownIndex.get(projectId) ?? null;
  };
  /** Folders sharing `projectId` in --projects-dir (empty = unambiguous; an explicit --library makes it moot). */
  resolver.ambiguous = (projectId) => {
    if (explicit.has(projectId)) return [];
    resolver(projectId);
    return duplicates.get(projectId) ?? [];
  };
  return resolver;
}

/**
 * The glTF JSON of a GLB file, reading only its header and JSON chunk. `null`
 * for a file that is no GLB; `undefined` when the file does not exist.
 */
export function readGlbJsonFile(path) {
  let st;
  try { st = lstatSync(path); } catch { return undefined; }
  if (st.isSymbolicLink() || !st.isFile()) return undefined;   // never followed (as copyProjectVerbatim)
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(GLB_JSON_CHUNK_OFFSET);
    if (readSync(fd, header, 0, header.length, 0) < header.length) return null;
    const length = glbJsonChunkLength(header);
    if (length === null) return null;
    // A truncated download: the header promises more bytes than the file has.
    if (header.readUInt32LE(8) > st.size) return null;
    const bytes = Buffer.alloc(GLB_JSON_CHUNK_OFFSET + length);
    header.copy(bytes, 0);
    if (readSync(fd, bytes, GLB_JSON_CHUNK_OFFSET, length, GLB_JSON_CHUNK_OFFSET) < length) return null;
    return parseGlbJson(bytes);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A folder-backed document reader for the core (`{json}` / null when missing). */
function folderDocumentReader(root) {
  return (path) => {
    if (!isContainedPath(path)) return null;
    const abs = join(root, ...normalizeLibraryPath(path).split('/'));
    const json = readGlbJsonFile(abs);
    if (json === undefined) return null;
    const isGlb = /\.glb$/i.test(abs);
    // A .glb that exists but does not parse (unfetched LFS pointer, truncated file) is NOT
    // "no references": the core turns `unreadable` into a document-unreadable error.
    return { json: isGlb ? json : null, ...(isGlb && json === null ? { unreadable: true } : {}) };
  };
}

// ─── Plan + write ──────────────────────────────────────────────────────────

/**
 * The trim plan of a project folder — reads only, writes nothing. The Doctor
 * and `validate-project` use this form.
 *
 * @param {string} projectDir
 * @param {{ projectsDir?: string|null, libraries?: Record<string,string>, realvirtualLibraryDir?: string|null }} [sources]
 */
export function planProjectLibraries(projectDir, sources = {}) {
  const root = resolve(projectDir);
  const manifest = readJsonOrNull(join(root, 'project.json'));
  if (!manifest) throw new Error(`No readable project.json in ${root}.`);
  const resolveSource = createLibrarySourceResolver({
    projectsDir: sources.projectsDir ?? null,
    libraries: sources.libraries ?? {},
    ownLibrariesDir: join(root, DELIVERED_LIBRARIES_FOLDER),
  });
  const realvirtualLibrary = sources.realvirtualLibraryDir
    ? readJsonOrNull(join(sources.realvirtualLibraryDir, 'project.json'))
    : null;
  // A legacy manifest (models/scenes arrays, no documents[]) is planned over its derived
  // documents; the manifest that is written back keeps its own shape.
  const planned = withDerivedDocuments(manifest);
  const plan = planLibraryTrimSync({
    manifest: planned,
    readDocument: folderDocumentReader(root),
    realvirtualLibrary,
    openLibrary: (projectId) => {
      const folder = resolveSource(projectId);
      if (!folder) return null;
      const dupes = resolveSource.ambiguous(projectId);
      if (dupes.length > 0) return { ambiguous: dupes };
      const libraryManifest = readJsonOrNull(join(folder, 'project.json'));
      if (!libraryManifest) return null;
      return { manifest: libraryManifest, readDocument: folderDocumentReader(folder), folder };
    },
  });
  if (planned !== manifest) {
    plan.manifest = withDeliveredLibraryHints(manifest, plan.libraries.map((l) => l.projectId));
  }
  return plan;
}

/**
 * Writes the trimmed library projects into a STAGED project folder and rewrites
 * its `project.json` hints. Throws {@link LibraryTrimError} (exit 1) when a
 * library or a qualified reference cannot be resolved. A project that uses no
 * library is left byte-identical.
 *
 * @returns {{ plan: import('../../src/core/project/rv-library-trim-core.mjs').LibraryTrimPlan, shipped: string[] }}
 */
export function trimProjectLibraries(projectDir, sources = {}, { log = null } = {}) {
  const root = resolve(projectDir);
  const plan = planProjectLibraries(root, sources);
  const label = sources.label ?? root;
  if (plan.errors.length > 0) {
    throw new LibraryTrimError(
      `Library resolution failed for ${label}:\n${formatLibraryTrimErrors(plan.errors)}`,
      plan.errors,
    );
  }
  if (plan.legacyRefs.length > 0) {
    // Reported, never guessed (an unqualified ref names no library). One summary
    // line: a pre-778 plant carries hundreds of them.
    const sample = plan.legacyRefs.slice(0, 3)
      .map((r) => `${r.document} → "${r.assetId || r.path}"${r.resolvesIn ? ` (resolves in ${r.resolvesIn})` : ''}`);
    log?.(`[libraries] note: ${plan.legacyRefs.length} unqualified reference(s) in ${label} are not attributed to a library `
      + `and ship nothing: ${sample.join('; ')}${plan.legacyRefs.length > 3 ? '; …' : ''}`);
  }

  // Source guards (the private tree's clean-tree / LFS checks) run before a byte is copied.
  for (const library of plan.libraries) sources.verifySourceFolder?.(library.source.folder, library.projectId);
  for (const library of plan.libraries) assertNoLfsPointers(library);

  const destination = join(root, DELIVERED_LIBRARIES_FOLDER);
  if (plan.libraries.length === 0) {
    // Nothing to ship. A stale `libraries/` in the delivered copy goes with it.
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    return { plan, shipped: [] };
  }

  // Write into a fresh sibling first: a source may BE the current `libraries/<id>/`.
  const temp = join(root, `.${DELIVERED_LIBRARIES_FOLDER}-trim-${process.pid}-${Date.now()}`);
  rmSync(temp, { recursive: true, force: true });
  try {
    for (const library of plan.libraries) {
      const from = library.source.folder;
      const to = join(temp, library.projectId);
      mkdirSync(to, { recursive: true });
      for (const rel of library.files) {
        const source = join(from, ...rel.split('/'));
        let st;
        try { st = lstatSync(source); } catch { continue; }   // a thumbnail that was never generated
        if (st.isSymbolicLink() || !st.isFile()) {
          log?.(`[libraries] ${library.projectId}: skipped ${rel} (symlink or not a file)`);
          continue;
        }
        const target = join(to, ...rel.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
      writeFileSync(join(to, 'project.json'), `${JSON.stringify(library.manifest, null, 2)}\n`);
      log?.(`[libraries] ${library.projectId}: ${library.documentIds.length} of `
        + `${(Array.isArray(library.source.manifest.documents) ? library.source.manifest.documents.length : 0)} document(s)`
        + ` (needed by ${library.neededBy.join(', ')})`);
    }
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    renameSync(temp, destination);
  } finally {
    if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
  }
  writeFileSync(join(root, 'project.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`);
  return { plan, shipped: plan.libraries.map((l) => l.projectId) };
}

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/** Every file a library ships must be the file itself, not an unfetched Git LFS pointer. */
function assertNoLfsPointers(library) {
  for (const rel of library.files) {
    const abs = join(library.source.folder, ...rel.split('/'));
    let fd = null;
    try {
      if (!lstatSync(abs).isFile()) continue;
      fd = openSync(abs, 'r');
      const buffer = Buffer.alloc(100);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, read).toString('utf8').startsWith(LFS_POINTER_PREFIX)) {
        throw new LibraryTrimError(
          `Library "${library.projectId}": ${rel} is an unfetched Git LFS pointer, not the file itself (run "git lfs pull" in its repository).`,
          [{ code: 'document-unreadable', message: `${library.projectId}/${rel} is an unfetched Git LFS pointer.`, projectId: library.projectId }],
        );
      }
    } catch (error) {
      if (error instanceof LibraryTrimError) throw error;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}
