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
 * `writeScene(relPath, scene)` reads like a thin wrapper over
 * `writeSceneFile()`. It must not be one. The folder path already has a
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

import type { RvScene } from '../../hmi/scene/rv-scene-types';
import type {
  RvProject,
  RvProjectAssetEntry,
  RvProjectSceneEntry,
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
  readScene(relPath: string): Promise<RvScene | null>;
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

export interface ProjectBackend extends ProjectReadProvider {
  readonly kind: BackendKind;
  /** Unique across all backends of one store. */
  readonly id: string;
  readonly writable: boolean;
  /** True between {@link activate} and {@link deactivate}. */
  readonly isActive: boolean;

  // ── Listing ──
  listScenes(): Promise<RvProjectSceneEntry[]>;
  listModels(): Promise<RvProjectAssetEntry[]>;
  listLibrary(): Promise<RvProjectAssetEntry[]>;

  // ── Lifecycle (§2.2.1b) ──
  /** Bring the write side into service. Only the active project may do this. */
  activate(): Promise<void>;
  /** Flush outstanding writes and silence the writer. Idempotent. */
  deactivate(): Promise<void>;

  // ── Write (queueing surface — see the file header) ──
  /** Queue a scene body write. Throws unless writable **and** active. */
  writeScene(relPath: string, scene: RvScene): Promise<void>;
  /** Queue a scene deletion. Throws unless writable **and** active. */
  deleteScene(relPath: string): Promise<void>;
  /** Store a binary artefact. Throws unless writable **and** active. */
  writeBlob(relPath: string, blob: Blob): Promise<void>;
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
  /** Await any queued write. Safe on a read-only or inactive backend. */
  flush(): Promise<void>;
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
