// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-project-loader — finds, opens (read-only) and lists the library
 * PROJECTS the open project names (plan-778 Phase 1, §2.1, F3/F6/F7/F8).
 *
 * A project A names a library project B by B's project id in
 * `project.json.libraries[]` (`{projectId, label?, hint?}`). This module turns
 * that list into one {@link LibraryProjectNode} per library — B, and
 * transitively whatever B names — each with a state the library-projects
 * provider maps 1:1 onto a `LibrarySource`.
 *
 * ## Never blocking (F7)
 *
 * {@link LibraryProjectLoader.setProject} creates every DIRECT node as
 * `pending` SYNCHRONOUSLY, before the first `await`, so a resolver that asks
 * the registry right after a project switch already sees the source and waits
 * for that one source only. Locked / unknown / error are published the moment
 * they are known; a hint fetch times out after 3 s. Nothing here ever prompts:
 * a folder handle without a read grant is `locked` (the Grant click is Phase 2).
 *
 * ## Where a library is looked for, in order
 *
 *  0. **built-in** — `prj_realvirtual_library` → app-level `/library/project.json`
 *     first (every build ships it; it is public and never trimmed). Until that
 *     file exists (plan-778 Phase 3) the built-in library is simply not ready and
 *     today's bundled catalog keeps serving legacy references through the global
 *     provider — nothing regresses.
 *  1. **linked folder** — the stored handle `projectfolder:<id>` with a READ
 *     grant → `FolderBackend(handle, {writable:false, id:'folder:<id>'})`;
 *     a handle without a grant → `locked` (final: the user's local copy is the
 *     intended location, Grant fixes it — a hosted copy might be another version).
 *  2. **browser project** — a stored browser project of that id.
 *  3. **hint URL** (3 s) — a hosted project; a GitHub URL without a
 *     `project.json` falls back to today's repo scan (F13), whose ids resolve
 *     through aliases. A RELATIVE hint (`libraries/<id>/project.json`, what a
 *     delivery or "Pack with libraries" writes, plan-778 Phase 4) is resolved
 *     against the OPEN project's own location — its folder, or its hosted base
 *     URL — through the injected {@link LibraryProjectLoaderDeps.openRelative}.
 *  else **unknown**.
 *
 * Every manifest read goes through the backend's own `readManifest()` — the
 * migration ladder the store itself uses (spike result, plan §Spike-Ergebnis).
 * The manifest's id must equal the requested id, else `error` naming both.
 *
 * ## Coupling
 *
 * The backends come from an INJECTED {@link LibraryBackendFactory}: this module
 * imports no project store (the store imports the library layer, and a cycle
 * there is the §5.4 risk). `main.ts` wires the real factory.
 */

import { MAX_REFERENCE_DEPTH } from '../engine/rv-asset-reference';
import type { ProjectBackend } from '../project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../project/rv-project-types';
import type { LibraryCatalog } from './library-types';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from './library-origin';
import { readLibraryProjectRefs } from './project-libraries';

// ─── Types ──────────────────────────────────────────────────────────────

/** How a ready library was reached. */
export type LibraryProjectVia = 'folder' | 'browser' | 'hosted' | 'builtin' | 'scan';

export type LibraryProjectState =
  | { kind: 'pending' }
  | {
      kind: 'ready';
      via: LibraryProjectVia;
      /** The read-only backend — null only for a repo scan (`via: 'scan'`). */
      backend: ProjectBackend | null;
      /** The library's manifest — null only for a repo scan. */
      project: RvProject | null;
      /** Every document of the library (empty for a scan). */
      documents: RvDocumentEntry[];
      /** Found through a relative hint: a delivered/packed copy, never edited in place. */
      delivered?: true;
      /** The scanned catalog of a GitHub repo without `project.json` (F13). */
      scan?: LibraryCatalog;
    }
  | { kind: 'locked'; handle: FileSystemDirectoryHandle }
  | { kind: 'unknown' }
  | { kind: 'error'; reason: string };

export interface LibraryProjectNode {
  projectId: string;
  /** The library's name once known, else the ref's label, else the id. */
  label: string;
  /** The location hint the naming ref carried (a URL, a folder name, …). */
  hint?: string;
  /** Listed in the OPEN project's `libraries[]`. */
  direct: boolean;
  /** Direct AND listed — the built-in realvirtual library is resolvable but placeable only when listed (Decision C). */
  placeable: boolean;
  /** Project ids of the libraries that need this one (transitive only; empty for a direct node). */
  neededBy: string[];
  /** 1 for a direct library, +1 per level. */
  depth: number;
  state: LibraryProjectState;
}

/** Injected: how a library project's read-only backend is built (keeps this module free of project-store). */
export interface LibraryBackendFactory {
  folder(handle: FileSystemDirectoryHandle, projectId: string): ProjectBackend;
  /** The browser project of that id, or null when this browser stores none. */
  browser(projectId: string): ProjectBackend | null;
  /** A hosted project at `baseUrl` (a folder URL ending in `/`). */
  remote(baseUrl: string): ProjectBackend;
}

export interface LibraryProjectLoaderDeps {
  factory: LibraryBackendFactory;
  /** The stored folder handle of a linked project (`projectfolder:<id>`), or null. */
  getLinkedHandle?(projectId: string): Promise<FileSystemDirectoryHandle | null>;
  /** True when `handle` already has a READ grant — never prompts. */
  hasReadPermission?(handle: FileSystemDirectoryHandle): Promise<boolean>;
  /** Base URL of the app-level realvirtual library (`<BASE_URL>library/`); null = no built-in location. */
  builtinBaseUrl?(): string | null;
  /** Today's GitHub repo scan (F13 fallback). */
  scanGitHub?(url: string): Promise<LibraryCatalog>;
  /**
   * A read-only backend for the folder `relDir` INSIDE the open project (a
   * delivered project carries its libraries under `libraries/<id>/`), or null
   * when the open project has no such folder / no location to resolve against.
   */
  openRelative?(relDir: string, projectId: string): Promise<{ backend: ProjectBackend; via: 'folder' | 'hosted' } | null>;
  /** Hint fetch timeout, ms (default 3000). */
  hintTimeoutMs?: number;
  /** Nesting limit (default `MAX_REFERENCE_DEPTH` = 16). */
  maxDepth?: number;
}

/** The state of the open project the loader follows. */
interface ActiveProject {
  id: string | null;
  refs: Array<{ projectId: string; label?: string; hint?: string }>;
}

export const LIBRARY_HINT_TIMEOUT_MS = 3000;

/** Built-in label until the manifest says otherwise. */
const BUILTIN_LABEL = 'realvirtual Library';

// ─── Loader ─────────────────────────────────────────────────────────────

export class LibraryProjectLoader {
  private readonly _deps: LibraryProjectLoaderDeps;
  private readonly _listeners = new Set<() => void>();
  /** Insertion order = registry order: direct in `libraries[]` order, transitive, built-in last. */
  private _nodes = new Map<string, LibraryProjectNode>();
  /** Stable snapshot of `_nodes` — rebuilt on change only. */
  private _list: LibraryProjectNode[] = [];
  private _generation = 0;
  private _active: ActiveProject = { id: null, refs: [] };
  /**
   * Last READY state per library id, kept across rebuilds (a project switch
   * that keeps a library must not flicker it back to pending). Dropped by
   * {@link invalidate} and {@link markError}.
   */
  private readonly _readyCache = new Map<string, Extract<LibraryProjectState, { kind: 'ready' }>>();

  constructor(deps: LibraryProjectLoaderDeps) {
    this._deps = deps;
  }

  // ── Read side ───────────────────────────────────────────────────────

  /** Every node, in registry order. Stable array between changes. */
  getNodes(): readonly LibraryProjectNode[] { return this._list; }

  /** The project the loader follows. */
  get activeProjectId(): string | null { return this._active.id; }

  getNode(projectId: string): LibraryProjectNode | null { return this._nodes.get(projectId) ?? null; }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  /** Resolves when no node is pending (or immediately). Test / tool seam; never rejects. */
  whenSettled(): Promise<void> {
    if (!this._list.some((n) => n.state.kind === 'pending')) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const off = this.subscribe(() => {
        if (!this._list.some((n) => n.state.kind === 'pending')) { off(); resolve(); }
      });
    });
  }

  // ── Write side ──────────────────────────────────────────────────────

  /**
   * Follow the OPEN project (or none). Synchronous up to the pending nodes
   * (F7): every direct library and the built-in realvirtual library exist as
   * `pending` (or keep a still-valid ready state) before this returns.
   */
  setProject(project: RvProject | null | undefined): void {
    const id = project && typeof project.id === 'string' ? project.id : null;
    const refs: ActiveProject['refs'] = [];
    for (const ref of readLibraryProjectRefs(project)) {
      const projectId = ref.projectId as string;
      if (projectId === id) continue;   // self-reference: harmless, ignored
      if (refs.some((r) => r.projectId === projectId)) continue;
      refs.push({
        projectId,
        ...(typeof ref.label === 'string' && ref.label ? { label: ref.label } : {}),
        ...(typeof ref.hint === 'string' && ref.hint ? { hint: ref.hint } : {}),
      });
    }
    // Hint-found states belong to the old project (review C3).
    if (id !== this._active.id) {
      for (const [k, s] of [...this._readyCache]) if (s.delivered || s.via === 'hosted' || s.via === 'scan') this._readyCache.delete(k);
    }
    this._active = { id, refs };
    this._rebuild();
  }

  /**
   * Forget what is known about `projectId` and locate it again — after Locate
   * replaced its folder handle, after a Grant, or to retry an error. Nodes that
   * need it are re-expanded when it settles.
   */
  invalidate(projectId: string): void {
    this._readyCache.delete(projectId);
    if (!this._nodes.has(projectId)) return;
    this._rebuild();
  }

  /**
   * A READY library whose reads started failing at runtime (folder moved or
   * deleted, F8): `ready → error`. The source stops answering; placeholders
   * stay placeholders; an {@link invalidate} retries.
   */
  markError(projectId: string, reason: string): void {
    const node = this._nodes.get(projectId);
    if (!node || node.state.kind !== 'ready') return;
    this._readyCache.delete(projectId);
    this._setState(projectId, { kind: 'error', reason });
  }

  /** Drop every node and listener (teardown, tests). */
  dispose(): void {
    this._generation++;
    this._nodes.clear();
    this._readyCache.clear();
    this._list = [];
    this._listeners.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private _emit(): void {
    this._list = [...this._nodes.values()];
    for (const l of this._listeners) {
      try { l(); } catch (e) { console.warn('[library-projects] listener failed:', e); }
    }
  }

  /**
   * Rebuild the node set for the active project — synchronously — and start
   * locating every node that is not carried over ready.
   */
  private _rebuild(): void {
    const generation = ++this._generation;
    const next = new Map<string, LibraryProjectNode>();

    for (const ref of this._active.refs) {
      next.set(ref.projectId, {
        projectId: ref.projectId,
        label: ref.label ?? ref.projectId,
        ...(ref.hint ? { hint: ref.hint } : {}),
        direct: true,
        placeable: true,
        neededBy: [],
        depth: 1,
        state: this._carried(ref.projectId),
      });
    }
    if (!next.has(REALVIRTUAL_LIBRARY_PROJECT_ID) && this._active.id !== REALVIRTUAL_LIBRARY_PROJECT_ID) {
      next.set(REALVIRTUAL_LIBRARY_PROJECT_ID, {
        projectId: REALVIRTUAL_LIBRARY_PROJECT_ID,
        label: BUILTIN_LABEL,
        direct: false,
        placeable: false,
        neededBy: [],
        depth: 1,
        state: this._carried(REALVIRTUAL_LIBRARY_PROJECT_ID),
      });
    }
    for (const node of next.values()) {
      if (node.state.kind === 'ready') node.label = labelOfReady(node.state, node.label);
    }
    this._nodes = next;

    // Full graph before the publish (review C2).
    const toLocate: LibraryProjectNode[] = [];
    for (const node of [...next.values()]) {
      if (node.state.kind === 'ready') this._expand(node, generation, false, toLocate);
      else if (node.state.kind === 'pending') toLocate.push(node);
    }
    this._emit();

    for (const node of toLocate) void this._locateAndPublish(node.projectId, node.hint, generation);
  }

  /** The cached ready state of a library, if any — else `pending`. */
  private _carried(projectId: string): LibraryProjectState {
    return this._readyCache.get(projectId) ?? { kind: 'pending' };
  }

  private _setState(projectId: string, state: LibraryProjectState, emit = true): void {
    const node = this._nodes.get(projectId);
    if (!node) return;
    const label = state.kind === 'ready' ? labelOfReady(state, node.label) : node.label;
    if (state.kind === 'ready') this._readyCache.set(projectId, state);
    this._nodes.set(projectId, { ...node, label, state });
    if (emit) this._emit();
  }

  private async _locateAndPublish(projectId: string, hint: string | undefined, generation: number): Promise<void> {
    let state: LibraryProjectState;
    try {
      state = await this._locate(projectId, hint, generation);
    } catch (e) {
      state = { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
    }
    if (generation !== this._generation) return;   // a newer project / invalidate won
    // ONE publish for the node AND the libraries it names: emitting the ready
    // node first would show a moment with nothing pending — exactly the window
    // in which a waiting resolver gives up on a transitive library.
    this._setState(projectId, state, false);
    const node = this._nodes.get(projectId);
    if (node && node.state.kind === 'ready') this._expand(node, generation, false);
    this._emit();
  }

  /** Add the libraries a ready node names (transitive, dedupe, depth limit, self-ref ignored). */
  private _expand(node: LibraryProjectNode, generation: number, emit = true, deferred?: LibraryProjectNode[]): void {
    if (node.state.kind !== 'ready' || !node.state.project) return;
    const maxDepth = this._deps.maxDepth ?? MAX_REFERENCE_DEPTH;
    let changed = false;
    const toLocate: LibraryProjectNode[] = [];
    for (const ref of readLibraryProjectRefs(node.state.project)) {
      const childId = ref.projectId as string;
      if (childId === node.projectId || childId === this._active.id) continue;   // self / cycle back to A
      const existing = this._nodes.get(childId);
      if (existing) {
        if (!existing.direct && !existing.neededBy.includes(node.projectId)) {
          this._nodes.set(childId, { ...existing, neededBy: [...existing.neededBy, node.projectId] });
          changed = true;
        }
        continue;
      }
      const depth = node.depth + 1;
      const hint = typeof ref.hint === 'string' && ref.hint ? ref.hint : undefined;
      const child: LibraryProjectNode = {
        projectId: childId,
        label: typeof ref.label === 'string' && ref.label ? ref.label : childId,
        ...(hint ? { hint } : {}),
        direct: false,
        placeable: false,
        neededBy: [node.projectId],
        depth,
        state: depth > maxDepth
          ? { kind: 'error', reason: `Library nesting deeper than ${maxDepth} levels — "${childId}" is not loaded.` }
          : this._carried(childId),
      };
      if (child.state.kind === 'ready') child.label = labelOfReady(child.state, child.label);
      this._nodes.set(childId, child);
      changed = true;
      toLocate.push(child);
    }
    if (changed && emit) this._emit();
    for (const child of toLocate) {
      if (child.state.kind === 'ready') this._expand(child, generation, emit, deferred);
      else if (child.state.kind !== 'pending') continue;
      else if (deferred) deferred.push(child);
      else void this._locateAndPublish(child.projectId, child.hint, generation);
    }
  }

  /** Find + open one library project. Never prompts; throws only on a programming error. */
  private async _locate(projectId: string, hint: string | undefined, generation: number): Promise<LibraryProjectState> {
    const deps = this._deps;
    const stale = (): boolean => generation !== this._generation;

    // 0. built-in
    if (projectId === REALVIRTUAL_LIBRARY_PROJECT_ID) {
      const base = deps.builtinBaseUrl?.() ?? null;
      if (base) {
        const ready = await this._openRemote(projectId, base, 'builtin');
        if (stale()) return { kind: 'pending' };
        if (ready && ready.kind === 'ready') return ready;
        if (ready && ready.kind === 'error') return ready;
      }
    }

    // 1. linked folder
    let handle: FileSystemDirectoryHandle | null = null;
    try { handle = (await deps.getLinkedHandle?.(projectId)) ?? null; } catch { handle = null; }
    if (stale()) return { kind: 'pending' };
    if (handle) {
      let granted = false;
      try { granted = (await deps.hasReadPermission?.(handle)) ?? false; } catch { granted = false; }
      if (stale()) return { kind: 'pending' };
      if (!granted) return { kind: 'locked', handle };
      return this._openBackend(projectId, deps.factory.folder(handle, projectId), 'folder', null);
    }

    // 2. browser project
    let browser: ProjectBackend | null = null;
    try { browser = deps.factory.browser(projectId); } catch { browser = null; }
    if (browser) return this._openBackend(projectId, browser, 'browser', null);

    // 3. hint URL
    if (hint && /^https?:\/\//i.test(hint)) {
      const github = githubRawBase(hint);
      const base = github?.rawBase ?? hostedBaseOf(hint);
      const hosted = await this._openRemote(projectId, base, 'hosted');
      if (stale()) return { kind: 'pending' };
      if (hosted) return hosted;
      if (github && deps.scanGitHub) {
        const scan = await withTimeout(deps.scanGitHub(hint), this._hintTimeout()).catch(() => null);
        if (stale()) return { kind: 'pending' };
        if (scan) return { kind: 'ready', via: 'scan', backend: null, project: null, documents: [], scan };
      }
    }
    // 3b. relative hint — the copy a delivery / pack ships beside the open project.
    const relDir = hint ? relativeHintDir(hint) : null;
    if (relDir && deps.openRelative) {
      const located = await withTimeout(deps.openRelative(relDir, projectId), this._hintTimeout()).catch(() => null);
      if (stale()) return { kind: 'pending' };
      if (located) {
        const opened = await this._openBackend(projectId, located.backend, located.via, null);
        if (stale()) return { kind: 'pending' };
        // A missing manifest at a relative hint is "not here", not a broken library.
        if (opened.kind === 'ready') return { ...opened, delivered: true };
        if (opened.kind === 'error' && !/no project\.json/.test(opened.reason)) return opened;
      }
    }
    return { kind: 'unknown' };
  }

  /** A hosted / built-in project at `base`; null when nothing is published there (or it timed out). */
  private async _openRemote(projectId: string, base: string, via: 'hosted' | 'builtin'): Promise<LibraryProjectState | null> {
    let backend: ProjectBackend;
    try { backend = this._deps.factory.remote(base); } catch { return null; }
    let manifest: RvProject | null;
    try {
      manifest = await withTimeout(backend.readManifest(), this._hintTimeout());
    } catch {
      return null;
    }
    if (!manifest) return null;
    return this._openBackend(projectId, backend, via, manifest);
  }

  private async _openBackend(
    projectId: string,
    backend: ProjectBackend,
    via: LibraryProjectVia,
    manifest: RvProject | null,
  ): Promise<LibraryProjectState> {
    let project = manifest;
    if (!project) {
      try { project = await backend.readManifest(); } catch (e) {
        return { kind: 'error', reason: `Library "${projectId}": project.json could not be read (${e instanceof Error ? e.message : String(e)}).` };
      }
    }
    if (!project) return { kind: 'error', reason: `Library "${projectId}": no project.json at its location.` };
    if (project.id !== projectId) {
      return {
        kind: 'error',
        reason: `This location holds project '${project.name}' (${project.id}), not '${projectId}'.`,
      };
    }
    let documents: RvDocumentEntry[];
    try {
      documents = typeof backend.listDocuments === 'function' ? await backend.listDocuments() : [];
    } catch (e) {
      return { kind: 'error', reason: `Library "${project.name}": documents could not be listed (${e instanceof Error ? e.message : String(e)}).` };
    }
    return { kind: 'ready', via, backend, project, documents };
  }

  private _hintTimeout(): number {
    return this._deps.hintTimeoutMs ?? LIBRARY_HINT_TIMEOUT_MS;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function labelOfReady(state: Extract<LibraryProjectState, { kind: 'ready' }>, fallback: string): string {
  const name = state.project?.name ?? state.scan?.name;
  return typeof name === 'string' && name.trim() !== '' ? name : fallback;
}

/**
 * The project-relative FOLDER a relative hint names (`libraries/B/project.json`
 * → `libraries/B`), or null for a URL, an absolute path, an escape (`..`) or a
 * bare word (a folder name kept as a message, Decision 1).
 */
export function relativeHintDir(hint: string): string | null {
  const raw = hint.trim().replace(/\\/g, '/');
  if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return null;
  const parts = raw.replace(/^(\.\/)+/, '').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  if (/^project\.json$/i.test(parts[parts.length - 1])) parts.pop();
  // A single segment is a folder NAME (the Locate hint), not a location.
  return parts.length >= 2 ? parts.join('/') : null;
}

/** The folder URL of a hosted project hint (`…/project.json` → `…/`). */
export function hostedBaseOf(hint: string): string {
  const bare = hint.trim().split(/[?#]/)[0];
  const folder = /\/project\.json$/i.test(bare) ? bare.replace(/project\.json$/i, '') : bare;
  return folder.endsWith('/') ? folder : `${folder}/`;
}

/**
 * The raw-content base of a GitHub repository hint, or null for any other URL.
 * `HEAD` stands in for the default branch, so no API call is needed to read
 * `project.json`.
 */
export function githubRawBase(hint: string): { rawBase: string } | null {
  const m = hint.trim().match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/i,
  );
  if (!m) return null;
  const sub = (m[4] ?? '').replace(/^\/+|\/+$/g, '');
  return { rawBase: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3] ?? 'HEAD'}/${sub ? `${sub}/` : ''}` };
}

/** `promise`, or a rejection after `ms` (fake-timer friendly: plain `setTimeout`). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ─── Singleton ──────────────────────────────────────────────────────────

let current: LibraryProjectLoader | null = null;

/** The loader `main.ts` installed, or null (embed / tests without one). */
export function getLibraryProjectLoader(): LibraryProjectLoader | null { return current; }

/** Install the app's loader (replaces a previous one). */
export function setLibraryProjectLoader(loader: LibraryProjectLoader | null): void {
  if (current && current !== loader) current.dispose();
  current = loader;
}
