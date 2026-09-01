// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-backend — the seam every project data source sits behind.
 *
 * This is **not** a new interface. `ProjectReadProvider` already existed in
 * `project-store.ts` and its docstring said in so many words that "a
 * read-only HTTP one can be added without reshaping the store". That is
 * exactly what happens here: the read surface keeps its four members, `kind`
 * loses the placeholder `'http'` in favour of the name the thing actually
 * has (`'bundled'`), and the listing/write/lifecycle members are added
 * beside it. Existing callers of the read surface are untouched.
 *
 * ## The write side deliberately has no naive method (§2.2.2)
 *
 * `writeScene(relPath, write)` reads like a thin wrapper over a file write.
 * It must not be one. The folder path already has a
 * writer — `RVProjectFolderWriter`, a debounced, mutation-bus-driven class
 * that carries the RR1 filename contract (`_checkPathOwnership` before every
 * write **and** every delete) and the RR3 write seams. A backend method that
 * wrote a file directly would route around both, and the failure mode is not
 * a broken render: it is silently overwriting a different, still-valid
 * scene file.
 *
 * So the folder backend **owns** a writer instance and delegates to it.
 * These methods are a queueing surface, not a filesystem surface. The
 * browser backend implements the same outer contract against
 * localStorage/OPFS without a writer at all.
 *
 * ## Activation, and why a data source needs a lifecycle (§2.2.1b)
 *
 * Workspace discovery constructs a backend per candidate folder — for
 * projects that are **not** open. The scene mutation bus, meanwhile, is
 * global and unscoped: `SceneMutation` carries an `id` and no `projectId`,
 * so every listener sees every event. If each discovered backend started its
 * own writer, one save in the open project would be written into *every*
 * discovered folder.
 *
 * Hence: a backend is constructed **read-only**. `activate()` is what creates
 * the writer and subscribes it to the bus; `deactivate()` flushes and
 * unsubscribes. Exactly one backend may be active, and the store enforces
 * that by deactivating the outgoing one *before* activating the next. The
 * global bus stays as it is — the protection is that only one listener
 * exists.
 */

import type {
  SceneRecord,
  SceneRevision,
  SceneWrite,
} from '../rv-scene-record';
export { WriteQueue } from './write-queue';
import type { DocumentStat } from '../rv-project-documents';
import { isConnectConfigPath, isKnowledgeFilePath } from '../rv-project-refs';
import type {
  RvDocumentEntry,
  RvProject,
  RvProjectAssetEntry,
} from '../rv-project-types';

// ─── Kind ───────────────────────────────────────────────────────────────

/**
 * Where a project's bytes live.
 *
 *  - `bundled` — the build or an HTTP deploy root (`import.meta.env.BASE_URL`).
 *    Read-only, and always available: it is what makes "there are no
 *    project-less contents" true in a browser with no filesystem API.
 *  - `browser` — localStorage (scene JSON) plus OPFS (blobs). Writable
 *    everywhere, including Safari/Firefox/iPad. **Phase 2.**
 *  - `folder` — File System Access, read-write, git-capable. Chromium only.
 *
 * Replaces the earlier `'folder' | 'http'`. `'http'` was the placeholder for
 * what is now `'bundled'`; at runtime a build root and an HTTP root are the
 * same `fetch`.
 */
export type BackendKind = 'bundled' | 'browser' | 'folder';

// ─── Read surface (moved verbatim from project-store.ts) ────────────────

/**
 * The read surface a project backend must offer.
 *
 * Kept as its own interface so a caller that only reads does not have to
 * care about activation, writing or listing.
 */
export interface ProjectReadProvider {
  readonly kind: BackendKind;
  readonly writable: boolean;
  readManifest(): Promise<RvProject | null>;
  /**
   * Read one scene body.
   *
   * Returns a {@link SceneRecord} — bytes plus metadata plus a revision —
   * **not** an `RvScene`. See `rv-scene-record.ts` for why the contract had to
   * change rather than grow, and why `record.legacy` exists for exactly as
   * long as plan-397 phase 7 takes.
   */
  readScene(relPath: string): Promise<SceneRecord | null>;
  readSettings(relPath?: string): Promise<unknown | null>;
}

// ─── Full backend ───────────────────────────────────────────────────────

/**
 * A blob resolved out of a backend.
 *
 * Deliberately minimal for Phase 1: the richer `ResolvedAsset` of the
 * library layer (§2.6.4, Phase 4) wraps this once the source-provider
 * registry exists. `release()` is what an object-URL-based backend needs to
 * avoid leaking; a plain-URL backend makes it a no-op.
 */
export interface ResolvedBackendBlob {
  url: string;
  release(): void;
}

/**
 * The optional precondition of {@link ProjectBackend.writeBlob}.
 *
 * Its own interface rather than a bare parameter so a later addition (a
 * content type, an "atomic rename" hint) does not change every implementation's
 * signature again.
 */
export interface WriteBlobOptions {
  /** See the table on {@link ProjectBackend.writeBlob}. */
  expectedRevision?: SceneRevision | null;
}

export interface ProjectBackend extends ProjectReadProvider {
  readonly kind: BackendKind;
  /** Unique across all backends of one store. */
  readonly id: string;
  readonly writable: boolean;
  /** True between {@link activate} and {@link deactivate}. */
  readonly isActive: boolean;

  // ── Listing ──
  // `listScenes()` is gone (plan-716 Phase 6). It answered "which scenes does
  // this project have", which stopped being a question with its own answer once
  // a scene became an ordinary document: {@link listDocuments} returns them
  // along with everything else, each row carrying the `section` that says which
  // folder holds it.
  listModels(): Promise<RvProjectAssetEntry[]>;
  listLibrary(): Promise<RvProjectAssetEntry[]>;
  /**
   * The one list (plan-413 §2.4) — everything the three above return, as
   * documents.
   *
   * It does **not** simply concatenate them, and the difference is where the
   * folder backend lives: models and library are folder-driven there (dropping
   * `Machine.glb` into `models/` *is* adding it), while `documents[]` in the
   * manifest is derived from and mirrored back into the manifest arrays only.
   * Keeping the two apart is what stops a folder scan from rewriting a
   * customer's `project.json` with fifty entries nobody asked for.
   *
   * Ids are stable across calls: an entry that arrives without one gets a
   * path-derived id (`stableDocumentId`), never a random one, or a list nothing
   * could select in would come back different every render.
   */
  listDocuments(): Promise<RvDocumentEntry[]>;
  /**
   * Project-relative paths of every CONNECT configuration file
   * (`*.connect.json`) anywhere under the project root — including the
   * reserved `connect/` folder, which the document walk never enters as an
   * asset location.
   *
   * Classification is by the file ENDING, not the folder (plan-718 reference
   * model): a config a user keeps next to its model must be found exactly like
   * one CONNECT wrote into `connect/`. Optional — a backend without a real
   * folder to walk (bundled, HTTP) simply does not implement it, and callers
   * treat that as "none".
   */
  listConnectConfigs?(): Promise<string[]>;
  /**
   * Project-relative paths of every knowledge file (`*.knowledge.md`) anywhere
   * under the project root — the `knowledgeRef` twin of
   * {@link listConnectConfigs}, with the same by-ending rule and the same
   * optionality.
   */
  listKnowledgeFiles?(): Promise<string[]>;
  /**
   * Project-relative paths of EVERY file the project folder holds — the one
   * walk behind the full view (plan-445 F1).
   *
   * Internals are already gone: the backend applies
   * {@link isInternalProjectPath} so there is exactly one place that decides
   * what a user is not meant to see, and no caller can forget it.
   *
   * This is a superset of {@link listConnectConfigs} and
   * {@link listKnowledgeFiles}, which is the point: {@link listProjectFiles}
   * classifies it into all three lists from ONE walk instead of walking the
   * folder once per ending. Optional for the same reason as its two siblings —
   * a backend with no folder to walk (bundled, HTTP) simply omits it, and the
   * helper falls back to the per-ending calls.
   */
  listAllFiles?(): Promise<string[]>;
  /**
   * Cheap size/mtime/digest for the documents this backend stores — the
   * pre-filter of the classification scan (§2.5, SOL R1-7).
   *
   * Contract per medium, and the asymmetry is deliberate:
   *
   *  - **folder / browser** — real stats. They are writable, so a file can
   *    change behind the manifest's back and the scan is how that is noticed.
   *  - **bundled / HTTP** — an empty list. There is no reliable `mtime` over
   *    `fetch`, and there is nothing to reconcile: the source is read-only, so
   *    its manifest cannot be out of date with respect to bytes nobody can
   *    modify. Returning stats we do not trust would turn every open into a
   *    full re-download.
   *
   * A document with no stat is left alone by the scan. That is the same
   * statement as "the manifest is authoritative here".
   */
  statDocuments(): Promise<DocumentStat[]>;

  // ── Lifecycle (§2.2.1b) ──
  /** Bring the write side into service. Only the active project may do this. */
  activate(): Promise<void>;
  /** Flush outstanding writes and silence the writer. Idempotent. */
  deactivate(): Promise<void>;

  // ── Write (queueing surface — see the file header) ──
  /**
   * Store a scene body, atomically and under a precondition (§2.8).
   *
   * Three properties every implementation owes the caller:
   *
   *  1. **GLB only.** There is no way to put a JSON body in through this
   *     surface. That is what stops the pre-397 format from being re-created
   *     after the migration.
   *  2. **Compare-and-swap.** `write.expectedRevision` is checked against
   *     what is stored *now*; a mismatch throws
   *     {@link SceneRevisionConflictError} instead of overwriting. This is
   *     also how an edit made in the project folder behind our back surfaces —
   *     it changed the bytes, so it changed the revision.
   *  3. **All or nothing.** A failed write leaves the previous body exactly
   *     as it was. Never a truncated file, never a zero-byte placeholder.
   *
   * Throws unless writable **and** active.
   *
   * @returns the revision of what is now stored.
   */
  writeScene(relPath: string, write: SceneWrite): Promise<SceneRevision>;
  /** Queue a scene deletion. Throws unless writable **and** active. */
  deleteScene(relPath: string): Promise<void>;
  /**
   * Store a binary artefact. Throws unless writable **and** active.
   *
   * ## The precondition is optional, and that is what makes it safe to add
   *
   * Until plan-709 this surface had **no** way to say "…unless somebody else
   * changed it first", while `writeScene` right above it did. The asymmetry was
   * not a policy: it was a missing capability, and it is why every asset write
   * in the product (library rename/duplicate, classification, tree moves,
   * settings-into-model) was a last-writer-wins overwrite.
   *
   * `opts` closes that gap **without touching a single existing caller**: with
   * no `opts` the behaviour is byte-identical to before — unconditional. The
   * three intents are exactly the ones {@link SceneWrite.expectedRevision}
   * already defines, and they are checked by the same
   * {@link assertRevisionPrecondition}, so a fourth backend cannot invent a
   * fourth meaning of "conflict":
   *
   * | `expectedRevision` | means | throws when |
   * |---|---|---|
   * | omitted / `undefined` | unconditional (today's behaviour) | never |
   * | a revision | "I read this and am replacing it" | stored bytes hash differently |
   * | `null` | "create only — this must not exist yet" | anything is stored |
   *
   * The `null` mode is what a migration wants: copy in, never overwrite.
   *
   * A revision here is the same token as everywhere else — the SHA-256 of the
   * stored bytes ({@link revisionOfBytes}) — so a caller can obtain one by
   * hashing what it read, with no bookkeeping anywhere.
   *
   * @throws {@link SceneRevisionConflictError} when the precondition fails.
   *   Nothing is written in that case.
   */
  writeBlob(relPath: string, blob: Blob, opts?: WriteBlobOptions): Promise<void>;
  /**
   * Remove a binary artefact. Throws unless writable **and** active.
   *
   * A missing file is NOT an error: the caller's intent ("this must not be
   * there") is already satisfied, and making it throw would turn every
   * double-click of Delete into a spurious failure.
   */
  deleteBlob(relPath: string): Promise<void>;
  /** Resolve an artefact to something loadable. Read-only backends do this too. */
  readBlobUrl(relPath: string): Promise<ResolvedBackendBlob | null>;
  /**
   * The artefact's raw bytes, or null when nothing is stored at `relPath`.
   *
   * The sibling of {@link readBlobUrl} that hands over no resource (plan-709
   * §2.5). Two of the three backends already hold the bytes and only wrap them
   * in an object URL to satisfy the older contract — a wrapper the caller then
   * has to own and revoke, which is the leak phase 4 removes. Reading bytes
   * where bytes are what the caller wanted skips the whole question.
   *
   * `readBlobUrl` remains for the cases that genuinely need a base URL: a
   * glTF with external buffers or textures resolves its siblings against it.
   */
  readBlobBytes(relPath: string): Promise<ArrayBuffer | null>;
  /** Await any queued write. Safe on a read-only or inactive backend. */
  flush(): Promise<void>;
}

// ─── The full-view listing (plan-445 F1) ────────────────────────────────

/**
 * Files the project browser must NOT show, by name.
 *
 * `project.json` is the manifest the tree is BUILT from and `docs-index.json`
 * is the attachment index — showing either would offer the user a row that
 * describes the list it appears in. Both are also written by machinery, so a
 * rename of one is a corruption, not an edit.
 */
const INTERNAL_FILE_NAMES: ReadonlySet<string> = new Set([
  'project.json',
  'docs-index.json',
]);

/**
 * Top-level folders whose contents are viewer artefacts rather than content.
 *
 * `thumbnails/` is the preview cache — regenerated at will, meaningless to a
 * human, and large. The rest of the reserved set (`settings`, `connect`, `rag`,
 * `.trash`) is deliberately NOT here: those hold files a user legitimately
 * looks at, and the tree already groups them under its collapsed *System* node
 * (`RESERVED_SYSTEM_FOLDERS`) instead of hiding them.
 */
const INTERNAL_FOLDERS: readonly string[] = ['thumbnails'];

/**
 * Is `relPath` viewer machinery rather than project content?
 *
 * The ONE internals rule (plan-445 §2.3), applied by the backend so that every
 * consumer — dashboard, MCP tree, a future one — hides exactly the same set.
 * Three clauses, in the order they were decided: any segment beginning with a
 * dot (`.trash`, `.thumbnails`, `.git`), the two index files, and the thumbnail
 * cache.
 */
export function isInternalProjectPath(relPath: string): boolean {
  const path = (relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (path === '') return true;
  const segments = path.split('/').filter(Boolean);
  if (segments.some(s => s.startsWith('.'))) return true;
  if (INTERNAL_FILE_NAMES.has(segments[segments.length - 1].toLowerCase())) return true;
  return INTERNAL_FOLDERS.includes(segments[0].toLowerCase());
}

/** The three by-ending lists the project tree needs, from one path list. */
export interface ProjectFileListing {
  /** `*.connect.json`, wherever they sit (plan-718 reference model). */
  configs: string[];
  /** `*.knowledge.md`, same by-ending rule. */
  knowledge: string[];
  /** Everything else — the inert rows of the full view. */
  plainFiles: string[];
}

/**
 * Split one walk's paths into the three lists the tree consumes.
 *
 * Pure, and the only classifier: the dashboard and `web_project_tree` both call
 * it on the same input, which is what makes them show the same tree rather than
 * two hand-maintained approximations of one (plan-445 §2.4).
 */
export function classifyProjectFiles(paths: readonly string[]): ProjectFileListing {
  const configs: string[] = [];
  const knowledge: string[] = [];
  const plainFiles: string[] = [];
  for (const path of paths) {
    if (isInternalProjectPath(path)) continue;
    if (isConnectConfigPath(path)) configs.push(path);
    else if (isKnowledgeFilePath(path)) knowledge.push(path);
    else plainFiles.push(path);
  }
  return { configs, knowledge, plainFiles };
}

/**
 * Everything the project tree needs from the backend's folder, in ONE walk.
 *
 * `listAllFiles()` where the backend has it, the two per-ending walks where it
 * does not (and then no `plainFiles`, because a backend that cannot enumerate
 * cannot honestly claim there are none of anything else). Never throws: a
 * revoked folder grant or a backend that answers nothing yields empty lists,
 * which renders as a project with no extra rows rather than as a broken screen.
 */
export async function listProjectFiles(
  backend: Pick<ProjectBackend, 'listAllFiles' | 'listConnectConfigs' | 'listKnowledgeFiles'> | null,
): Promise<ProjectFileListing> {
  if (!backend) return { configs: [], knowledge: [], plainFiles: [] };
  if (backend.listAllFiles) {
    try {
      return classifyProjectFiles(await backend.listAllFiles());
    } catch {
      return { configs: [], knowledge: [], plainFiles: [] };
    }
  }
  const [configs, knowledge] = await Promise.all([
    backend.listConnectConfigs?.().catch(() => []) ?? Promise.resolve([]),
    backend.listKnowledgeFiles?.().catch(() => []) ?? Promise.resolve([]),
  ]);
  return { configs, knowledge, plainFiles: [] };
}

// ─── Guards ─────────────────────────────────────────────────────────────

/** Thrown when a write reaches a backend that may not perform it. */
export class BackendNotWritableError extends Error {
  constructor(
    readonly backendId: string,
    readonly reason: 'read-only' | 'inactive',
  ) {
    super(
      reason === 'read-only'
        ? `Backend "${backendId}" is read-only.`
        : `Backend "${backendId}" is not active — activate the project before writing.`,
    );
    this.name = 'BackendNotWritableError';
  }
}

/**
 * The one gate every write method calls first.
 *
 * Both halves matter and for different reasons: `writable` is about the
 * medium (a bundled deploy has nowhere to write, a folder without a
 * readwrite grant may not), `isActive` is about *which* of several
 * constructed backends is allowed to touch disk right now.
 */
export function assertWritable(backend: {
  id: string;
  writable: boolean;
  isActive: boolean;
}): void {
  if (!backend.writable) throw new BackendNotWritableError(backend.id, 'read-only');
  if (!backend.isActive) throw new BackendNotWritableError(backend.id, 'inactive');
}
