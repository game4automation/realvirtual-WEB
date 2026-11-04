// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-library-pack — "Pack with libraries" (plan-778 Phase 4, F15, Decision 5).
 *
 * Writes the open folder project A into a folder the user picks, together with
 * TRIMMED copies of the library projects it uses under `libraries/<projectId>/`
 * — the browser half of what every delivery channel does. The decision (which
 * libraries, which documents, which hints) is `rv-library-trim-core.mjs`, the
 * very module the Node delivery scripts run, so a pack and a delivery of the
 * same project carry the same rows and the same bytes (9.13 / 9.14 share one
 * fixture). A packed folder opens anywhere: its rewritten hints
 * (`libraries/<id>/project.json`) resolve against the project's own folder
 * (`openRelativeToBackend`, the loader's relative-hint step).
 *
 * Rules:
 *  - document bytes are copied unchanged (a signed GLB stays signed);
 *  - a trimmed library manifest is an allowlist (`TRIMMED_MANIFEST_FIELDS`: schemaVersion,
 *    id, name, canonicalName, kind, libraries, documents), not a copy of the original —
 *    other fields (code, provenance, settings, ...) never travel;
 *  - the realvirtual library is never packed — every build ships it app-level;
 *  - a library or a qualified reference that cannot be resolved stops the pack
 *    before a single byte is written, naming document and library;
 *  - the target must not already hold a project (`project.json`): a pack never
 *    overwrites someone else's project;
 *  - caches and secrets never travel (`isExcludedFromExport`, the `.rvproject` rule).
 *
 * Reads only the JSON chunk of a GLB to find its references (`Blob.slice`).
 */

import {
  DELIVERED_LIBRARIES_FOLDER,
  GLB_JSON_CHUNK_OFFSET,
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  glbJsonChunkLength,
  parseGlbJson,
  planLibraryTrim,
  type LibraryTrimError,
  type LibraryTrimPlan,
  type TrimManifest,
  type TrimReadResult,
} from './rv-library-trim-core.mjs';
import { isExcludedFromExport } from './rv-project-transport';
import { isEncryptedEnvelope } from '../persistence/rv-crypto-utils';
import { decryptServedBytes, EncryptedWithoutKeyError } from '../persistence/rv-served-bytes';
import { PROJECT_MANIFEST_FILE } from './rv-project-types';
import { FolderBackend } from './backends/folder-backend';
import { BundledBackend } from './backends/bundled-backend';
import type { LibraryProjectNode } from '../library/library-project-loader';

// ─── Sources ───────────────────────────────────────────────────────────────

/** Read access to one project's files by project-relative path. */
export interface PackFileSource {
  readFile(path: string): Promise<Blob | null>;
}

/** A library project the pack can read from. */
export interface PackLibrary {
  manifest: TrimManifest;
  files: PackFileSource;
}

/** A folder handle as a file source (path segments resolved one by one; never escapes). */
export function directoryFileSource(root: FileSystemDirectoryHandle): PackFileSource {
  return {
    async readFile(path) {
      const segments = path.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
      if (segments.length === 0 || segments.includes('..')) return null;
      try {
        let dir = root;
        for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
        const handle = await dir.getFileHandle(segments[segments.length - 1]);
        return await handle.getFile();
      } catch {
        return null;
      }
    },
  };
}

/** A hosted folder (`…/`) as a file source. */
export function urlFileSource(baseUrl: string, fetchImpl: typeof fetch = fetch.bind(globalThis)): PackFileSource {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  // plan-778 D15: plan and copy both read each file — fetch once per pack.
  const cache = new Map<string, Promise<Blob | null>>();
  return {
    readFile(path) {
      let hit = cache.get(path);
      if (!hit) { hit = fetchOnce(path); cache.set(path, hit); }
      return hit;
    },
  };
  async function fetchOnce(path: string): Promise<Blob | null> {
    if (path.split('/').includes('..')) return null;
    try {
      const resp = await fetchImpl(`${base}${path.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-cache' });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      // A hosted encrypted deploy serves RVE1 envelopes: read them through the viewer's own decrypt
      // seam (the session key of the unlocked deploy), never copy ciphertext into a pack. Without a
      // key it throws EncryptedWithoutKeyError, which the pack reports (see `guardEncrypted`).
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (!isEncryptedEnvelope(head)) return blob;
      return new Blob([await decryptServedBytes(await blob.arrayBuffer(), resp.url || base + path)]);
    } catch (e) {
      if (e instanceof EncryptedWithoutKeyError) throw e;
      return null;
    }
  }
}

/**
 * The pack source of a READY library node of the loader: a linked folder or a
 * hosted / built-in location. A browser-stored library (OPFS) is not packable
 * from here — the pack then fails naming it, rather than shipping a gap.
 */
export function packLibraryFromNode(node: LibraryProjectNode): PackLibrary | null {
  if (node.state.kind !== 'ready' || !node.state.project || !node.state.backend) return null;
  const backend = node.state.backend;
  const manifest = node.state.project as unknown as TrimManifest;
  if (backend instanceof FolderBackend) return { manifest, files: directoryFileSource(backend.directory) };
  if (backend instanceof BundledBackend) {
    const root = /^(https?:)?\/\//i.test(backend.basePath) ? backend.basePath : `${backend.baseUrl}${backend.basePath}`;
    return { manifest, files: urlFileSource(root) };
  }
  return null;
}

/** A `PackLibrary` lookup over the loader's nodes (the libraries the open project resolves). */
export function packLibrariesFromNodes(nodes: readonly LibraryProjectNode[]): (projectId: string) => Promise<PackLibrary | null> {
  return async (projectId) => {
    const node = nodes.find((n) => n.projectId === projectId);
    return node ? packLibraryFromNode(node) : null;
  };
}

// ─── Pack ──────────────────────────────────────────────────────────────────

export type PackResult =
  | {
    kind: 'packed';
    /** Files written, project-relative, sorted. */
    files: string[];
    libraries: Array<{ projectId: string; documentIds: string[] }>;
    legacyRefs: LibraryTrimPlan['legacyRefs'];
    realvirtualLibraryUsed: boolean;
  }
  | { kind: 'unresolved'; message: string; errors: LibraryTrimError[] }
  | { kind: 'target-has-project'; message: string }
  | { kind: 'error'; message: string };

/** The glTF JSON of a GLB blob (JSON chunk only), or null when it is no GLB. */
async function glbJsonOfBlob(blob: Blob): Promise<Record<string, unknown> | null> {
  const header = new Uint8Array(await blob.slice(0, GLB_JSON_CHUNK_OFFSET).arrayBuffer());
  const length = glbJsonChunkLength(header);
  if (length === null) return null;
  const bytes = new Uint8Array(await blob.slice(0, GLB_JSON_CHUNK_OFFSET + length).arrayBuffer());
  return parseGlbJson(bytes);
}

function documentReader(files: PackFileSource): (path: string) => Promise<TrimReadResult | null> {
  return async (path) => {
    const blob = await files.readFile(path);
    if (!blob) return null;
    return { json: /\.glb$/i.test(path) ? await glbJsonOfBlob(blob) : null };
  };
}

/** Every exportable file of a folder project, project-relative (its own `libraries/` excluded). */
async function projectFiles(dir: FileSystemDirectoryHandle, prefix = '', out: string[] = []): Promise<string[]> {
  const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
  for await (const [name, handle] of iterable.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (isExcludedFromExport(rel)) continue;
    // A previous pack's libraries are regenerated, never copied along.
    if (!prefix && name === DELIVERED_LIBRARIES_FOLDER && handle.kind === 'directory') continue;
    if (handle.kind === 'directory') await projectFiles(handle as FileSystemDirectoryHandle, rel, out);
    else out.push(rel);
  }
  return out;
}

async function writeFile(root: FileSystemDirectoryHandle, path: string, data: Blob | string): Promise<void> {
  const segments = path.split('/');
  let dir = root;
  for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
  const handle = await dir.getFileHandle(segments[segments.length - 1], { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

/** True when `child` is `parent` or lies inside it (platform identity; a handle without `resolve` counts only as same-entry). */
async function isInsideOrSame(parent: FileSystemDirectoryHandle, child: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    if (await parent.isSameEntry(child)) return true;
    const path = await (parent as { resolve?: (h: FileSystemHandle) => Promise<string[] | null> }).resolve?.(child);
    return path !== null && path !== undefined;
  } catch {
    return false;
  }
}

async function hasFile(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

/**
 * Packs the folder project `projectDir` and the library projects it uses into
 * `target`. `openLibrary` answers a library id with a readable source (in the
 * app: the loader's ready nodes, {@link packLibrariesFromNodes}).
 */
export async function packProjectWithLibraries(opts: {
  projectDir: FileSystemDirectoryHandle;
  target: FileSystemDirectoryHandle;
  openLibrary: (projectId: string) => Promise<PackLibrary | null>;
  realvirtualLibrary?: TrimManifest | null;
}): Promise<PackResult> {
  const source = directoryFileSource(opts.projectDir);
  const manifestBlob = await source.readFile(PROJECT_MANIFEST_FILE);
  if (!manifestBlob) return { kind: 'error', message: `"${opts.projectDir.name}" has no ${PROJECT_MANIFEST_FILE} — it is not a project.` };
  let manifest: TrimManifest;
  try {
    manifest = JSON.parse(await manifestBlob.text()) as TrimManifest;
  } catch (e) {
    return { kind: 'error', message: `${PROJECT_MANIFEST_FILE} is not valid JSON (${e instanceof Error ? e.message : String(e)}).` };
  }
  if (await isInsideOrSame(opts.projectDir, opts.target)) {
    return { kind: 'error', message: `The target "${opts.target.name}" is the project "${opts.projectDir.name}" itself or lies inside it (including its libraries/ folder). Pick a folder outside the project.` };
  }
  if (await hasFile(opts.target, PROJECT_MANIFEST_FILE)) {
    return { kind: 'target-has-project', message: `"${opts.target.name}" already holds a project. Pick an empty folder.` };
  }

  // Decide first — nothing is written for a project that cannot be packed.
  const libraries = new Map<string, PackLibrary>();
  let encryptedFailure: EncryptedWithoutKeyError | null = null;
  const guardEncrypted = (files: PackFileSource): PackFileSource => ({
    async readFile(path) {
      try { return await files.readFile(path); } catch (e) {
        if (e instanceof EncryptedWithoutKeyError) encryptedFailure = e;
        throw e;
      }
    },
  });
  const plan = await planLibraryTrim({
    manifest,
    readDocument: documentReader(source),
    realvirtualLibrary: opts.realvirtualLibrary ?? null,
    openLibrary: async (projectId) => {
      if (projectId === REALVIRTUAL_LIBRARY_PROJECT_ID) return null;
      const lib = await opts.openLibrary(projectId);
      if (!lib) return null;
      const guarded = { manifest: lib.manifest, files: guardEncrypted(lib.files) };
      libraries.set(projectId, guarded);
      return { manifest: guarded.manifest, readDocument: documentReader(guarded.files) };
    },
  });
  if (encryptedFailure) {
    return { kind: 'error', message: `A library of this project is served encrypted and its deploy is not unlocked in this tab (${(encryptedFailure as EncryptedWithoutKeyError).url}). Unlock the deploy first - a pack never copies ciphertext.` };
  }
  if (plan.errors.length > 0) {
    return {
      kind: 'unresolved',
      message: `Cannot pack: ${plan.errors.map((e) => e.message).join(' ')}`,
      errors: plan.errors,
    };
  }

  const written: string[] = [];
  for (const rel of await projectFiles(opts.projectDir)) {
    if (rel === PROJECT_MANIFEST_FILE) continue;
    const blob = await source.readFile(rel);
    if (!blob) continue;
    await writeFile(opts.target, rel, blob);
    written.push(rel);
  }
  await writeFile(opts.target, PROJECT_MANIFEST_FILE, `${JSON.stringify(plan.manifest, null, 2)}\n`);
  written.push(PROJECT_MANIFEST_FILE);

  for (const lib of plan.libraries) {
    const files = libraries.get(lib.projectId)!.files;
    const prefix = `${DELIVERED_LIBRARIES_FOLDER}/${lib.projectId}`;
    for (const rel of lib.files) {
      const blob = await files.readFile(rel);
      if (!blob) continue;   // a thumbnail that was never generated
      await writeFile(opts.target, `${prefix}/${rel}`, blob);
      written.push(`${prefix}/${rel}`);
    }
    await writeFile(opts.target, `${prefix}/${PROJECT_MANIFEST_FILE}`, `${JSON.stringify(lib.manifest, null, 2)}\n`);
    written.push(`${prefix}/${PROJECT_MANIFEST_FILE}`);
  }

  return {
    kind: 'packed',
    files: written.sort(),
    libraries: plan.libraries.map((l) => ({ projectId: l.projectId, documentIds: l.documentIds })),
    legacyRefs: plan.legacyRefs,
    realvirtualLibraryUsed: plan.realvirtualLibraryUsed,
  };
}
