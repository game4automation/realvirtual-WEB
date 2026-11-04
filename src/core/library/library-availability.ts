// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-availability — what the user SEES and DOES about a library project
 * that is not there (plan-778 Phase 2, F7/F9, §2.7, §3.3, Decision 6/A).
 *
 * The loader already knows the state of every library the open project needs
 * (`library-project-loader.ts`); this module turns the three bad states into
 * the Problems panel and offers the two repairs:
 *
 * | node state | Problems row | repair (registry command) |
 * |---|---|---|
 * | `locked`  (folder linked, grant lapsed) | "… is not available (folder access lapsed)" | **Grant** → `library.grant` |
 * | `unknown` (no location on this computer) | "… is unknown on this computer" | **Locate folder…** → `library.locate` |
 * | `error`   (wrong id at the location, read failure) | "… could not be loaded" | **Locate folder…** |
 *
 * Rows are keyed `library-unavailable:<projectId>`, cleared the moment the
 * library is ready (or no longer needed: project closed / switched). They are
 * `quiet` — opening a project never pops a panel (Decision 6: A opens, never
 * blocks); instead ONE summary line per project open ("2 libraries
 * unavailable — Show") opens the panel filtered to them.
 *
 * ## User activation (Decision A, §3.3)
 *
 * `requestPermission` and `showDirectoryPicker` need the click's transient
 * activation, and a second request in the same activation fails. So:
 *
 *  - nothing here prompts on its own — the project-open click spends its
 *    activation on A's own folder; libraries get one click each, in the row;
 *  - {@link grantLibraryAccess} calls `handle.requestPermission({mode:'read'})`
 *    and {@link locateLibraryFolder} calls `showDirectoryPicker({mode:'read'})`
 *    as their FIRST statement, before any `await`. The registry runs an eager
 *    command synchronously up to its `run`, so the button click reaches them
 *    inside its activation;
 *  - a thrown `SecurityError` and a denial are the same outcome: the row stays
 *    and names what happened.
 *
 * Libraries are only ever asked for READ: a library is read-only inside the
 * project that uses it (Decision 3).
 */

import {
  announceProblems,
  clearProblem,
  reportProblem,
  withdrawProblemsAnnouncement,
} from '../hmi/problems-store';
import { projectHandleKey, putHandle } from '../engine/rv-local-filesystem';
import { recordLinkedProject } from '../project/rv-project-linked';
import { locateProjectFolder } from '../project/rv-project-locate';
import { REALVIRTUAL_LIBRARY_PROJECT_ID } from './library-origin';
import { releaseLibraryWriteGrant } from './library-save-target';
import {
  getLibraryProjectLoader,
  type LibraryProjectLoader,
  type LibraryProjectNode,
} from './library-project-loader';

// ─── Ids and texts ──────────────────────────────────────────────────────

export const LIBRARY_UNAVAILABLE_CODE = 'library-unavailable';
export const LIBRARY_GRANT_COMMAND = 'library.grant';
export const LIBRARY_LOCATE_COMMAND = 'library.locate';

export function libraryUnavailableProblemId(projectId: string): string {
  return `${LIBRARY_UNAVAILABLE_CODE}:${projectId}`;
}

export const GRANT_DENIED =
  'Access to the library folder was not granted. Click Grant again and allow it in the browser prompt.';
export const GRANT_NEEDS_CLICK =
  'The browser asks for folder access only on a click — use Grant in the Problems panel.';
export const LOCATE_UNSUPPORTED =
  'This browser cannot open local folders. Open the project in Chrome or Edge, or add the library from its URL.';
export const LOCATE_BUILTIN =
  'The realvirtual Library ships with the app and has no folder to locate — reload the page to load it again.';
export const LOCATE_NEEDS_CLICK =
  'The folder picker opens only on a click — use Locate folder… in the Problems panel.';

// ─── Dependencies (test seam) ───────────────────────────────────────────

export interface LibraryAvailabilityDeps {
  /** The loader whose nodes are watched and invalidated. */
  loader(): LibraryProjectLoader | null;
  /** `window.showDirectoryPicker`, or null when the browser has none. */
  directoryPicker(): ((opts: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>) | null;
  /** Persist a linked folder's handle (`projectfolder:<id>`). */
  putHandle(dir: FileSystemDirectoryHandle, key: string): Promise<void>;
  /** Record the display row of a linked project. */
  recordLinkedProject(entry: { id: string; name: string; folderName?: string | null; opened?: boolean }): void;
}

const DEFAULT_DEPS: LibraryAvailabilityDeps = {
  loader: () => getLibraryProjectLoader(),
  directoryPicker: () => {
    if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') return null;
    return (opts) => window.showDirectoryPicker!(opts);
  },
  putHandle: (dir, key) => putHandle(dir, key),
  recordLinkedProject: (entry) => recordLinkedProject(entry),
};

let _deps: LibraryAvailabilityDeps = DEFAULT_DEPS;

/** Test seam: replace some dependencies (`null` restores the defaults). */
export function setLibraryAvailabilityDepsForTests(over: Partial<LibraryAvailabilityDeps> | null): void {
  _deps = over ? { ...DEFAULT_DEPS, ...over } : DEFAULT_DEPS;
}

/** True when this browser can pick a folder — the Locate / Link folder actions exist only then (F10). */
export function canPickLibraryFolder(): boolean {
  return _deps.directoryPicker() !== null;
}

// ─── Last attempt (shown in the row until the library is ready) ─────────

const _lastAttempt = new Map<string, string>();
let _resync: (() => void) | null = null;

function noteAttempt(projectId: string, text: string): void {
  _lastAttempt.set(projectId, text);
  _resync?.();
}

/**
 * Is Locate a repair for `projectId`? Not for the built-in realvirtual library
 * (plan-778 review U4): the loader asks its app-level location FIRST and never
 * falls through to a linked folder when that location answers, so a located
 * folder would never be read — the button would do nothing.
 */
export function canLocateLibrary(projectId: string): boolean {
  return projectId !== REALVIRTUAL_LIBRARY_PROJECT_ID;
}

// ─── Which nodes get a row ──────────────────────────────────────────────

type BadNode = LibraryProjectNode & { state: { kind: 'locked' | 'unknown' | 'error' } };

/**
 * A node earns a row when its state is bad AND the open project needs it:
 * directly, or through a library that names it. The built-in realvirtual
 * library is always present as a resolution-only node (Decision C) — while
 * nothing lists it, its state is nobody's problem.
 */
export function isReportableLibraryNode(node: LibraryProjectNode): node is BadNode {
  const bad = node.state.kind === 'locked' || node.state.kind === 'unknown' || node.state.kind === 'error';
  return bad && (node.direct || node.neededBy.length > 0);
}

function labelsOf(ids: readonly string[], nodes: readonly LibraryProjectNode[]): string {
  return ids.map((id) => nodes.find((n) => n.projectId === id)?.label ?? id).join(', ');
}

function hintText(hint: string | undefined): string | null {
  if (!hint) return null;
  return /^https?:\/\//i.test(hint) ? `Hint: ${hint}` : `Hint: folder "${hint}"`;
}

/** The Problems row of one bad library node. */
export function libraryUnavailableProblem(node: BadNode, nodes: readonly LibraryProjectNode[]): Parameters<typeof reportProblem>[0] {
  const neededBy = node.neededBy.length > 0 ? labelsOf(node.neededBy, nodes) : '';
  const who = `Library '${node.label}'${neededBy ? ` (needed by ${neededBy})` : ''}`;
  const parts: string[] = [`Library project ${node.projectId}.`];
  const hint = hintText(node.hint);
  let title: string;
  let action: { label: string; commandId: string; args: unknown } | undefined;
  const args = { projectId: node.projectId };
  if (node.state.kind === 'locked') {
    title = `${who} is not available (folder access lapsed)`;
    action = { label: 'Grant', commandId: LIBRARY_GRANT_COMMAND, args };
    parts.push(`Folder: "${node.state.handle.name}".`);
    parts.push('Tip: choose "Allow on every visit" in Chrome\'s prompt.');
  } else if (node.state.kind === 'unknown') {
    title = `${who} is unknown on this computer`;
    if (hint) parts.push(`${hint}.`);
    if (!canLocateLibrary(node.projectId)) parts.push(LOCATE_BUILTIN);
    else if (canPickLibraryFolder()) action = { label: 'Locate folder…', commandId: LIBRARY_LOCATE_COMMAND, args };
    else parts.push(LOCATE_UNSUPPORTED);
  } else {
    title = `${who} could not be loaded`;
    parts.push(node.state.reason);
    if (hint) parts.push(`${hint}.`);
    if (!canLocateLibrary(node.projectId)) parts.push(LOCATE_BUILTIN);
    else if (canPickLibraryFolder()) action = { label: 'Locate folder…', commandId: LIBRARY_LOCATE_COMMAND, args };
  }
  const last = _lastAttempt.get(node.projectId);
  if (last) parts.push(`Last attempt: ${last}`);
  return {
    id: libraryUnavailableProblemId(node.projectId),
    severity: 'warning',
    code: LIBRARY_UNAVAILABLE_CODE,
    title,
    detail: parts.join(' '),
    // The summary line is the entry point; the panel does not pop open over a
    // project that just opened (Decision 6).
    quiet: true,
    ...(action ? { action } : {}),
  };
}

// ─── Installation: loader → Problems + summary line ─────────────────────

export interface LibraryAvailabilityOptions {
  /** The id of the open project (the summary line is shown once per project open). */
  getProjectId(): string | null;
}

/**
 * Mirror the loader's bad nodes into the Problems panel and put up the summary
 * line once per project open, after its libraries settled. Returns the
 * uninstall function (rows and line are taken down with it).
 */
export function installLibraryAvailability(
  loader: LibraryProjectLoader,
  opts: LibraryAvailabilityOptions,
): () => void {
  const reported = new Set<string>();
  let summarisedFor: string | null | undefined;   // undefined = not yet for the current project
  let currentProject: string | null | undefined;
  let announcedKey: string | null = null;

  const sync = (): void => {
    const nodes = loader.getNodes();
    const projectId = opts.getProjectId();
    if (projectId !== currentProject) {
      currentProject = projectId;
      summarisedFor = undefined;
      if (announcedKey) { withdrawProblemsAnnouncement(announcedKey); announcedKey = null; }
    }

    const bad = nodes.filter(isReportableLibraryNode);
    const now = new Set<string>();
    for (const node of bad) {
      const id = libraryUnavailableProblemId(node.projectId);
      now.add(id);
      reportProblem(libraryUnavailableProblem(node, nodes));
    }
    for (const id of reported) if (!now.has(id)) clearProblem(id);
    reported.clear();
    for (const id of now) reported.add(id);
    // A library that came back forgets its failed attempts.
    for (const node of nodes) if (node.state.kind === 'ready') _lastAttempt.delete(node.projectId);

    // Summary line: once per project open, when nothing it needs is pending.
    // A project without libraries has nothing to summarise yet — the loader may
    // simply not have followed the switch; the line waits for real nodes.
    const needed = nodes.filter((n) => n.direct || n.neededBy.length > 0);
    const settled = needed.length > 0 && !needed.some((n) => n.state.kind === 'pending');
    if (projectId && settled && summarisedFor !== projectId) {
      summarisedFor = projectId;
      if (bad.length > 0) {
        announcedKey = `${LIBRARY_UNAVAILABLE_CODE}:${projectId}`;
        announceProblems({
          key: announcedKey,
          message: `${bad.length} ${bad.length === 1 ? 'library' : 'libraries'} unavailable`,
          code: LIBRARY_UNAVAILABLE_CODE,
        });
      }
    } else if (announcedKey && needed.some((n) => n.state.kind === 'pending')) {
      // A retry re-locates libraries (they are pending, not fixed): the line
      // waits for the outcome instead of being taken down in between.
    } else if (announcedKey && bad.length === 0) {
      // Everything came back (Grant / Locate): the line has nothing left to say.
      withdrawProblemsAnnouncement(announcedKey);
      announcedKey = null;
    } else if (announcedKey && bad.length > 0) {
      // The count moved (one Grant of two, another library failed): the line
      // says the CURRENT number (review U8); an unchanged one is a no-op.
      announceProblems({
        key: announcedKey,
        message: `${bad.length} ${bad.length === 1 ? 'library' : 'libraries'} unavailable`,
        code: LIBRARY_UNAVAILABLE_CODE,
      });
    }
  };

  _resync = sync;
  const unsubscribe = loader.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    if (_resync === sync) _resync = null;
    for (const id of reported) clearProblem(id);
    reported.clear();
    if (announcedKey) withdrawProblemsAnnouncement(announcedKey);
    announcedKey = null;
  };
}

// ─── Repair: Grant ──────────────────────────────────────────────────────

export type GrantLibraryResult =
  | { ok: true; projectId: string; granted: true }
  | { ok: false; projectId: string; reason: string };

/** The reason `library.grant` is not offered for `projectId`, or null. */
export function grantRefusal(projectId: string): string | null {
  if (!projectId) return 'projectId is required.';
  const node = _deps.loader()?.getNode(projectId) ?? null;
  if (!node) return `"${projectId}" is not a library of the open project. See web_query("library.list", {}).`;
  if (node.state.kind !== 'locked') return `Library '${node.label}' does not need a grant (state: ${node.state.kind}).`;
  return null;
}

/**
 * **Grant** — re-request READ access to a locked library's folder, then let the
 * loader find it again (placeholders re-resolve through the registry, F8).
 *
 * `requestPermission` is called SYNCHRONOUSLY, before anything awaits, so a
 * button click reaches it inside its user activation. Never throws.
 */
export function grantLibraryAccess(projectId: string): Promise<GrantLibraryResult> {
  const loader = _deps.loader();
  const node = loader?.getNode(projectId) ?? null;
  const handle = node?.state.kind === 'locked' ? node.state.handle : null;
  if (!loader || !handle) {
    return Promise.resolve({ ok: false, projectId, reason: grantRefusal(projectId) ?? 'Nothing to grant.' });
  }
  // FIRST: the request itself — no await may come before it.
  let request: Promise<PermissionState>;
  try {
    request = handle.requestPermission({ mode: 'read' });
  } catch (e) {
    request = Promise.reject(e);
  }
  return request.then(
    (state): GrantLibraryResult => {
      if (state !== 'granted') {
        noteAttempt(projectId, GRANT_DENIED);
        return { ok: false, projectId, reason: GRANT_DENIED };
      }
      loader.invalidate(projectId);
      return { ok: true, projectId, granted: true };
    },
    (e: unknown): GrantLibraryResult => {
      // A SecurityError (no activation / activation already spent) and a denial
      // leave the row exactly where it was — the user clicks again.
      const reason = isSecurityError(e) ? GRANT_NEEDS_CLICK : `${GRANT_DENIED} (${errorText(e)})`;
      noteAttempt(projectId, reason);
      return { ok: false, projectId, reason };
    },
  );
}

// ─── Repair: Locate folder… ─────────────────────────────────────────────

export type LocateLibraryResult =
  | { ok: true; projectId: string; linked: true; name: string; folderName: string }
  | { ok: true; projectId: string; linked: false; cancelled: true }
  | { ok: false; projectId: string; reason: string; kind: 'unsupported' | 'blocked' | 'unreadable' | 'mismatch' | 'failed' };

/** The reason `library.locate` is not offered for `projectId`, or null. */
export function locateRefusal(projectId: string): string | null {
  if (!projectId) return 'projectId is required.';
  if (!canLocateLibrary(projectId)) return LOCATE_BUILTIN;
  if (!_deps.loader()?.getNode(projectId)) {
    return `"${projectId}" is not a library of the open project. See web_query("library.list", {}).`;
  }
  return null;
}

/**
 * **Locate folder…** — the user points at the library's folder; it is accepted
 * only when its `project.json` id matches (F9), then linked
 * (`projectfolder:<id>` + the linked-projects row, so it shows in the
 * dashboard too) and the loader's cached answer for that id is dropped.
 *
 * `showDirectoryPicker({mode:'read'})` is called SYNCHRONOUSLY, before any
 * await (user activation). Never throws.
 */
export function locateLibraryFolder(projectId: string): Promise<LocateLibraryResult> {
  const picker = _deps.directoryPicker();
  if (!picker) {
    noteAttempt(projectId, LOCATE_UNSUPPORTED);
    return Promise.resolve({ ok: false, projectId, kind: 'unsupported', reason: LOCATE_UNSUPPORTED });
  }
  // FIRST: the picker — no await may come before it.
  let picking: Promise<FileSystemDirectoryHandle>;
  try {
    picking = picker({ id: 'rv-library-locate', mode: 'read' });
  } catch (e) {
    picking = Promise.reject(e);
  }
  return picking.then(
    (dir) => linkLocatedLibrary(projectId, dir),
    (e: unknown): LocateLibraryResult => {
      if (e instanceof Error && e.name === 'AbortError' && !/already active/i.test(e.message)) {
        return { ok: true, projectId, linked: false, cancelled: true };
      }
      const reason = isSecurityError(e) ? LOCATE_NEEDS_CLICK : errorText(e);
      noteAttempt(projectId, reason);
      return { ok: false, projectId, kind: 'blocked', reason };
    },
  );
}

/**
 * The half of Locate after the pick (exported for the dialog's **Link
 * folder…** and for tests): verdict, then link + invalidate on a match.
 */
export async function linkLocatedLibrary(projectId: string, dir: FileSystemDirectoryHandle): Promise<LocateLibraryResult> {
  const loader = _deps.loader();
  const label = loader?.getNode(projectId)?.label ?? projectId;
  const verdict = await locateProjectFolder(projectId, dir, label);
  if (verdict.kind !== 'ok') {
    noteAttempt(projectId, verdict.message);
    return { ok: false, projectId, kind: verdict.kind, reason: verdict.message };
  }
  try {
    await _deps.putHandle(dir, projectHandleKey(projectId));
  } catch (e) {
    const reason = `The folder could not be remembered (${errorText(e)}).`;
    noteAttempt(projectId, reason);
    return { ok: false, projectId, kind: 'failed', reason };
  }
  _deps.recordLinkedProject({ id: projectId, name: verdict.project.name || projectId, folderName: dir.name, opened: false });
  // A write grant of Edit in library belongs to the OLD folder (review E5).
  releaseLibraryWriteGrant(projectId);
  loader?.invalidate(projectId);
  return { ok: true, projectId, linked: true, name: verdict.project.name || projectId, folderName: dir.name };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function isSecurityError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'SecurityError';
}

function errorText(e: unknown): string {
  return e instanceof Error ? (e.message || e.name) : String(e);
}

/** Test seam: forget remembered attempts. */
export function resetLibraryAvailabilityForTests(): void {
  _lastAttempt.clear();
  _resync = null;
  _deps = DEFAULT_DEPS;
}
