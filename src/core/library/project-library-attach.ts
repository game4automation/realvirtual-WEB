// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-library-attach — attach / detach / list the libraries of the OPEN
 * project (plan-655 F1).
 *
 * Extracted from the Projects dashboard so the dashboard's "+" dialog, the
 * planner's "Manage libraries…" route and the MCP tools (`web_library_attach`
 * / `_detach` / `_list`, views of the `library.*` commands) run ONE sequence.
 *
 * The transaction contract (SOL review R1-3):
 *
 *  - **Attach:** the project identity (project id + backend object) is captured
 *    BEFORE the catalog fetch and re-checked before the manifest is written. A
 *    project switch during the fetch rolls the subscription back and refuses.
 *    The catalog is loaded FIRST and the manifest written only once it resolved,
 *    so a URL that 404s never lands in someone's `project.json`. A manifest
 *    write that throws (or a read-only backend that answers null) rolls the
 *    subscription back too. Attaching an already attached URL is idempotent.
 *  - **Detach:** manifest FIRST, then the source. A detach whose manifest write
 *    fails leaves the library attached (and loaded) — never "gone from the
 *    store but still in the manifest", which would bring it back on reopen.
 */

import type { RvProject } from '../project/rv-project-types';
import { getProjectStore } from '../project/project-store';
import { getLibraryStore } from './library-store-singleton';
import type { LibraryStore } from './library-store';
import { readLibraryRefs, readProjectLibraries, withLibraryRefs } from './project-libraries';
import {
  isRealvirtualCatalogUrl,
  LIBRARY_PROJECTS_PROVIDER_ID,
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  withBundledCatalogAsLibraryProject,
} from './library-origin';
import { getLibraryProjectLoader, type LibraryProjectNode } from './library-project-loader';
import { releaseLibraryWriteGrant } from './library-save-target';

/** The slice of `ProjectStore` this module needs (tests pass a double). */
export interface AttachProjectStoreLike {
  getProject(): RvProject | null;
  getBackend(): unknown;
  applyManifestDelta(apply: (current: RvProject) => RvProject): Promise<RvProject | null>;
}

/** The slice of `LibraryStore` this module needs. */
export type AttachLibraryStoreLike = Pick<LibraryStore,
  'addCatalog' | 'removeCatalog' | 'applyProjectLibraries' | 'catalogUrls' | 'catalogErrors' | 'catalogs' | 'getOrigin'>;

export interface LibraryAttachDeps {
  readonly project?: AttachProjectStoreLike;
  readonly library?: AttachLibraryStoreLike;
}

export const NO_PROJECT_OPEN = 'No project is open — open one with web_project_open first.';
export const PROJECT_READ_ONLY = 'This project is read-only, so a library cannot be added to it.';
export const PROJECT_READ_ONLY_DETACH = 'This project is read-only, so a library cannot be removed from it.';
export const PROJECT_SWITCHED = 'The project changed while the library was loading — nothing was attached.';
export const EMPTY_URL = 'url is required (a catalog.json URL, e.g. "https://example.com/catalog.json").';
export const notAttached = (url: string): string =>
  `"${url}" is not a library of this project. See web_query("library.list", {}).`;

export type AttachResult =
  | { ok: true; url: string; alreadyAttached: boolean; entries: number; libraries: string[] }
  | { ok: false; reason: string };

export type DetachResult =
  | { ok: true; url: string; libraries: string[] }
  | { ok: false; reason: string };

function deps(d?: LibraryAttachDeps): { project: AttachProjectStoreLike; library: AttachLibraryStoreLike } {
  return {
    project: d?.project ?? (getProjectStore() as unknown as AttachProjectStoreLike),
    library: d?.library ?? getLibraryStore(),
  };
}

/**
 * The manifest with the URL entry `url` appended (or kept) and `label` written
 * onto it. Goes through {@link withLibraryRefs}, so every OTHER entry — a
 * `{projectId}` library project above all (plan-778 F2) — survives untouched.
 */
function withUrlRef(project: RvProject, url: string, label: string | null | undefined): RvProject {
  const l = (label ?? '').trim();
  return withLibraryRefs(project, [...readLibraryRefs(project), { url, ...(l ? { label: l } : {}) }]);
}

/** The manifest without the URL entry `url`; every other entry is kept (plan-778 F2). */
function withoutUrlRef(project: RvProject, url: string): RvProject {
  return withLibraryRefs(project, readLibraryRefs(project).filter((r) => !!r.projectId || r.url !== url));
}

/**
 * Attach a catalog URL to the OPEN project — `project.json.libraries[]` plus the
 * live subscription. Returns the reason on failure, never throws.
 */
export async function attachLibraryToProject(
  rawUrl: string, label?: string | null, d?: LibraryAttachDeps,
): Promise<AttachResult> {
  const url = (rawUrl ?? '').trim();
  if (!url) return { ok: false, reason: EMPTY_URL };
  const { project: store, library: libStore } = deps(d);
  const before = store.getProject();
  const backendBefore = store.getBackend();
  if (!before || !backendBefore) return { ok: false, reason: NO_PROJECT_OPEN };

  const wasLoaded = libStore.catalogUrls.includes(url);
  const inManifest = readProjectLibraries(before).includes(url);
  const rollback = (): void => { if (!wasLoaded) libStore.removeCatalog(url); };

  await libStore.addCatalog(url, 'projectManifest');
  // `addCatalog` resolves on a failed fetch and records the reason instead.
  const failure = libStore.catalogErrors.get(url);
  if (failure) { rollback(); return { ok: false, reason: failure }; }

  // Identity re-check: the fetch awaited, and a project switch in that window
  // would otherwise write this URL into the NEXT project's manifest.
  const now = store.getProject();
  if (!now || now.id !== before.id || store.getBackend() !== backendBefore) {
    rollback();
    return { ok: false, reason: PROJECT_SWITCHED };
  }

  let next: RvProject | null;
  try {
    next = await store.applyManifestDelta((current) => withUrlRef(current, url, label));
  } catch (e) {
    rollback();
    return { ok: false, reason: `Writing project.json failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!next) { rollback(); return { ok: false, reason: PROJECT_READ_ONLY }; }

  // Re-declare the project level from what was written, so the store's project
  // URLs match the manifest and the next project switch swaps them out again.
  const libraries = readProjectLibraries(next);
  await libStore.applyProjectLibraries(libraries);
  return {
    ok: true, url, alreadyAttached: inManifest,
    entries: libStore.catalogs.get(url)?.entries.length ?? 0,
    libraries,
  };
}

/** Detach a catalog URL from the OPEN project: manifest first, then the source. */
export async function detachLibraryFromProject(rawUrl: string, d?: LibraryAttachDeps): Promise<DetachResult> {
  const url = (rawUrl ?? '').trim();
  if (!url) return { ok: false, reason: EMPTY_URL };
  const { project: store, library: libStore } = deps(d);
  const before = store.getProject();
  if (!before || !store.getBackend()) return { ok: false, reason: NO_PROJECT_OPEN };
  if (!readProjectLibraries(before).includes(url)) return { ok: false, reason: notAttached(url) };

  // plan-778 review E1: a realvirtual library URL (bundled or GitHub) IS the
  // realvirtual library project. Detaching it by URL would be undone by the
  // migration fold of this very save (it converts the URL entry to the id entry
  // BEFORE the verb runs, so a URL filter finds nothing) — it detaches the
  // library project instead, which drops every such URL entry in the same delta.
  if (isRealvirtualCatalogUrl(url)) {
    const r = await detachProjectLibraryAndUrls(REALVIRTUAL_LIBRARY_PROJECT_ID, d);
    if (!r.ok) return r;
    const libraries = readProjectLibraries(r.next);
    await libStore.applyProjectLibraries(libraries);
    for (const dropped of r.droppedUrls) {
      if (libStore.getOrigin(dropped) === 'projectManifest') libStore.removeCatalog(dropped);
    }
    return { ok: true, url, libraries };
  }

  let next: RvProject | null;
  try {
    next = await store.applyManifestDelta((current) => withoutUrlRef(current, url));
  } catch (e) {
    return { ok: false, reason: `Writing project.json failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!next) return { ok: false, reason: PROJECT_READ_ONLY_DETACH };
  const libraries = readProjectLibraries(next);
  // `applyProjectLibraries` drops a pure manifest subscription; a URL the user
  // also subscribed to globally keeps its promoted origin and stays loaded.
  await libStore.applyProjectLibraries(libraries);
  // A manifest URL the store never recorded as project-level (hand-edited
  // manifest) is not swapped out above — drop it when nothing else claims it.
  if (libStore.getOrigin(url) === 'projectManifest') libStore.removeCatalog(url);
  return { ok: true, url, libraries };
}

// ─── Library PROJECTS by id (plan-778 Phase 2, F10/F11, Decision D) ─────

export const EMPTY_PROJECT_ID = 'projectId is required (the id in the library\'s project.json, e.g. "prj_realvirtual_library").';
export const SELF_LIBRARY = 'A project cannot be a library of itself.';
export const BAD_PROJECT_ID = 'projectId must be a project id, not a path (no "/", "\\" or "..").';
export const projectNotAttached = (projectId: string): string =>
  `"${projectId}" is not a library of this project. See web_query("library.list", {}).`;

export type AttachProjectResult =
  | { ok: true; projectId: string; label: string | null; hint: string | null; alreadyAttached: boolean; libraries: string[] }
  | { ok: false; reason: string };

export type DetachProjectResult =
  | { ok: true; projectId: string; libraries: string[]; placements: number }
  | { ok: false; reason: string };

/** Why `projectId` cannot be a library id at all (null = fine). */
export function projectIdRefusal(projectId: string): string | null {
  if (!projectId) return EMPTY_PROJECT_ID;
  if (/[\\/]/.test(projectId) || projectId.includes('..')) return BAD_PROJECT_ID;
  return null;
}

/** The project ids `libraries[]` names (no URL entries). */
export function libraryProjectIdsOf(project: RvProject | null | undefined): string[] {
  return readLibraryRefs(project).map((r) => r.projectId).filter((id): id is string => typeof id === 'string' && id !== '');
}

/**
 * Attach a library PROJECT to the OPEN project by its id — the projectId twin
 * of {@link attachLibraryToProject}, with the same transaction contract:
 *
 *  - the project identity (id + backend) is captured first and checked again
 *    INSIDE the manifest delta — a switch before the write lands nothing in
 *    the next project (`PROJECT_SWITCHED`);
 *  - a read-only project refuses (`PROJECT_READ_ONLY`); a throwing write is
 *    reported; nothing was loaded before the write, so there is nothing to roll
 *    back — the loader follows the manifest (`main.ts` → `syncProjectLibraries`);
 *  - attaching an attached id is idempotent (the stored label / hint stay).
 *
 * The library does NOT have to resolve here: a library that lives on another
 * computer's disk is a legitimate entry, and the Problems panel offers Locate.
 * Every other entry of `libraries[]` survives (F2).
 */
export async function attachProjectLibrary(
  ref: { projectId: string; label?: string | null; hint?: string | null },
  d?: LibraryAttachDeps,
): Promise<AttachProjectResult> {
  const projectId = (ref.projectId ?? '').trim();
  const refusal = projectIdRefusal(projectId);
  if (refusal) return { ok: false, reason: refusal };
  const { project: store } = deps(d);
  const before = store.getProject();
  const backendBefore = store.getBackend();
  if (!before || !backendBefore) return { ok: false, reason: NO_PROJECT_OPEN };
  if (before.id === projectId) return { ok: false, reason: SELF_LIBRARY };
  const label = (ref.label ?? '').trim();
  const hint = (ref.hint ?? '').trim();
  const alreadyAttached = attachedLibraryProjectIdsOf(before).includes(projectId);

  let switched = false;
  let next: RvProject | null;
  try {
    next = await store.applyManifestDelta((current) => {
      if (current.id !== before.id || store.getBackend() !== backendBefore) {
        switched = true;
        return current;
      }
      const refs = readLibraryRefs(current);
      // Idempotent — a still-listed bundled catalog URL already IS the realvirtual library (review U2).
      if (attachedLibraryProjectIdsOf(current).includes(projectId)) return current;
      return withLibraryRefs(current, [
        ...refs,
        { projectId, ...(label ? { label } : {}), ...(hint ? { hint } : {}) },
      ]);
    });
  } catch (e) {
    return { ok: false, reason: `Writing project.json failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (switched) return { ok: false, reason: PROJECT_SWITCHED };
  if (!next) return { ok: false, reason: PROJECT_READ_ONLY };
  const stored = readLibraryRefs(withBundledCatalogAsLibraryProject(next)).find((r) => r.projectId === projectId);
  return {
    ok: true,
    projectId,
    label: typeof stored?.label === 'string' ? stored.label : (label || null),
    hint: typeof stored?.hint === 'string' ? stored.hint : (hint || null),
    alreadyAttached,
    libraries: attachedLibraryProjectIdsOf(next),
  };
}

/**
 * Detach a library PROJECT from the OPEN project — manifest only (the loader
 * follows it). Placements made from it are NOT touched (Decision D): they stay
 * in the document, resolve to a missing-reference placeholder from the next
 * load on, and come back when the library is attached again. `placements` is
 * the count the caller supplied for the confirmation ({@link countLibraryPlacements}).
 */
export async function detachProjectLibrary(
  rawProjectId: string,
  d?: LibraryAttachDeps & { placements?: number },
): Promise<DetachProjectResult> {
  const projectId = (rawProjectId ?? '').trim();
  const r = await detachProjectLibraryAndUrls(projectId, d);
  if (!r.ok) return r;
  if (r.droppedUrls.length > 0) {
    // A dropped realvirtual catalog URL may still be a live project-level
    // subscription of the library store: re-declare the project level.
    const { library: libStore } = deps(d);
    await libStore.applyProjectLibraries(readProjectLibraries(r.next));
  }
  return { ok: true, projectId, libraries: libraryProjectIdsOf(r.next), placements: d?.placements ?? 0 };
}

/**
 * The detach delta behind {@link detachProjectLibrary} and the realvirtual-URL
 * route of {@link detachLibraryFromProject}: ONE manifest write that removes
 * the `{projectId}` entry and — for the realvirtual library — every realvirtual
 * catalog URL entry (bundled or GitHub) too (plan-778 review U2/E1). Runs after
 * the store's migration fold, so the fold can never put a converted entry back.
 */
async function detachProjectLibraryAndUrls(
  projectId: string,
  d?: LibraryAttachDeps,
): Promise<{ ok: true; next: RvProject; droppedUrls: string[] } | { ok: false; reason: string }> {
  if (!projectId) return { ok: false, reason: EMPTY_PROJECT_ID };
  const { project: store } = deps(d);
  const before = store.getProject();
  const backendBefore = store.getBackend();
  if (!before || !backendBefore) return { ok: false, reason: NO_PROJECT_OPEN };
  if (!isLibraryProjectListed(before, projectId)) return { ok: false, reason: projectNotAttached(projectId) };

  let switched = false;
  const droppedUrls: string[] = [];
  let next: RvProject | null;
  try {
    next = await store.applyManifestDelta((current) => {
      if (current.id !== before.id || store.getBackend() !== backendBefore) {
        switched = true;
        return current;
      }
      droppedUrls.length = 0;
      const kept = readLibraryRefs(current).filter((r) => {
        if (r.projectId === projectId) return false;
        if (projectId === REALVIRTUAL_LIBRARY_PROJECT_ID && !r.projectId && isRealvirtualCatalogUrl(r.url)) {
          if (r.url) droppedUrls.push(r.url);
          return false;
        }
        return true;
      });
      return withLibraryRefs(current, kept);
    });
  } catch (e) {
    return { ok: false, reason: `Writing project.json failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (switched) return { ok: false, reason: PROJECT_SWITCHED };
  if (!next) return { ok: false, reason: PROJECT_READ_ONLY_DETACH };
  // An Edit-in-library write grant of B ends with B's place in this project (review E5).
  releaseLibraryWriteGrant(projectId);
  return { ok: true, next, droppedUrls };
}

/**
 * The library PROJECT ids a project names, with a still-listed BUNDLED
 * realvirtual catalog URL read as the realvirtual library project — the same
 * view the loader gets (`withBundledCatalogAsLibraryProject`, plan-778 review
 * U2). What every "is it attached?" question of the UI asks: an unmigrated
 * project's Remove works, and Add library does not offer it a second time.
 */
export function attachedLibraryProjectIdsOf(project: RvProject | null | undefined): string[] {
  return libraryProjectIdsOf(withBundledCatalogAsLibraryProject(project));
}

/**
 * Can `projectId` be detached from `project`? Listed by id or through the
 * bundled-URL view — and for the realvirtual library also through any
 * realvirtual catalog URL (GitHub included), all of which one detach drops.
 */
export function isLibraryProjectListed(project: RvProject | null | undefined, projectId: string): boolean {
  if (attachedLibraryProjectIdsOf(project).includes(projectId)) return true;
  return projectId === REALVIRTUAL_LIBRARY_PROJECT_ID
    && readLibraryRefs(project).some((r) => !r.projectId && isRealvirtualCatalogUrl(r.url));
}

/** The qualifier a placement record carries (the planner's `PlacedComponent` slice). */
export interface QualifiedPlacementLike {
  readonly providerId?: string | null;
  readonly sourceId?: string | null;
}

/**
 * How many placements name library `projectId` by their qualifier — the count
 * the Remove confirmation states (Decision D). Legacy (unqualified) placements
 * are not counted: they never belonged to one library.
 */
export function countLibraryPlacements(placed: readonly QualifiedPlacementLike[], projectId: string): number {
  let n = 0;
  for (const p of placed) if (p.providerId === LIBRARY_PROJECTS_PROVIDER_ID && p.sourceId === projectId) n++;
  return n;
}

/**
 * Why library `projectId` STAYS RESOLVABLE after it is removed from the open
 * project (plan-778 review U1), or null when it goes missing:
 *
 *  - the realvirtual library is always resolvable (Decision C);
 *  - a library another remaining library still names stays loaded as a
 *    transitive one (Decision 4) — reachable from the other direct libraries
 *    without passing through `projectId` itself.
 *
 * Its placements then keep working; only placing NEW parts from it stops.
 */
export function libraryRemovalKeepsAvailable(
  loader: LibraryNodesLike | null,
  projectId: string,
): { builtin: true } | { neededBy: string } | null {
  if (projectId === REALVIRTUAL_LIBRARY_PROJECT_ID) return { builtin: true };
  const nodes = loader?.getNodes() ?? [];
  const byId = new Map(nodes.map((n) => [n.projectId, n] as const));
  const namesOf = (n: LibraryProjectNode): string[] => (n.state.kind === 'ready' && n.state.project
    ? readLibraryRefs(n.state.project).map((r) => r.projectId).filter((id): id is string => !!id)
    : []);
  // Breadth-first from every remaining direct library; `projectId` is never expanded.
  const queue = nodes.filter((n) => n.direct && n.projectId !== projectId);
  const seen = new Set(queue.map((n) => n.projectId));
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    for (const child of namesOf(n)) {
      if (child === projectId) return { neededBy: n.label };
      if (seen.has(child)) continue;
      seen.add(child);
      const next = byId.get(child);
      if (next) queue.push(next);
    }
  }
  return null;
}

/** The Remove confirmation text (Decision D, §3.1; review U1). */
export function detachConfirmationMessage(
  label: string,
  placements: number,
  keeps: ReturnType<typeof libraryRemovalKeepsAvailable> = null,
): string {
  if (keeps) {
    const why = 'builtin' in keeps
      ? 'the realvirtual Library is always available'
      : `'${keeps.neededBy}' still needs it`;
    const head = placements === 0
      ? `No placement uses the library '${label}'.`
      : `${placements} placement${placements === 1 ? ' uses' : 's use'} this library and keep${placements === 1 ? 's' : ''} working.`;
    return `${head} It stays available because ${why}, but it is no longer offered for new placements. Nothing is deleted.`;
  }
  if (placements === 0) return `No placement uses the library '${label}'. Nothing is deleted.`;
  return `${placements} placement${placements === 1 ? ' uses' : 's use'} this library and will show as missing. `
    + 'Nothing is deleted; adding the library again restores them.';
}

/** One row of {@link listLibraries}. */
export interface LibraryListRow {
  readonly url: string;
  readonly label: string | null;
  /** `project` = in `project.json.libraries[]`; `user` = this browser's global list only. */
  readonly scope: 'project' | 'user';
  readonly loaded: boolean;
  readonly entries: number;
  readonly error: string | null;
}

/** One library PROJECT row of {@link listLibraries} (plan-778 F10). */
export interface LibraryProjectListRow {
  readonly projectId: string;
  readonly label: string;
  /** `direct` = listed in this project's `libraries[]` (placeable); `transitive` = needed by a library. */
  readonly scope: 'direct' | 'transitive';
  /** `pending` / `ready` / `locked` / `unknown` / `error`. */
  readonly state: string;
  /** Labels (ids when unknown) of the libraries that need this one. */
  readonly neededBy: string[];
  readonly hint: string | null;
  readonly entries: number;
  readonly error: string | null;
  /** The repair a locked / unknown library offers (`web_execute(<command>, {projectId})`). */
  readonly repair: string | null;
}

/** The slice of the library-projects loader the listing reads. */
export interface LibraryNodesLike {
  getNodes(): readonly LibraryProjectNode[];
}

/**
 * The library-project rows: every node the open project needs — direct ones in
 * `libraries[]` order, then the transitive ones. The built-in realvirtual
 * library appears only when something lists it (Decision C keeps it
 * resolvable; that alone is not a library of the project).
 */
export function listLibraryProjectRows(loader: LibraryNodesLike | null): LibraryProjectListRow[] {
  const nodes = loader?.getNodes() ?? [];
  const rows: LibraryProjectListRow[] = [];
  const ordered = [...nodes.filter((n) => n.direct), ...nodes.filter((n) => !n.direct && n.neededBy.length > 0)];
  for (const n of ordered) {
    const st = n.state;
    rows.push({
      projectId: n.projectId,
      label: n.label,
      scope: n.direct ? 'direct' : 'transitive',
      state: st.kind,
      neededBy: n.neededBy.map((id) => nodes.find((x) => x.projectId === id)?.label ?? id),
      hint: n.hint ?? null,
      entries: st.kind === 'ready' ? (st.scan ? st.scan.entries.length : st.documents.length) : 0,
      error: st.kind === 'error' ? st.reason : st.kind === 'unknown' ? 'Unknown on this computer.' : null,
      repair: st.kind === 'locked' ? 'library.grant' : (st.kind === 'unknown' || st.kind === 'error') && n.projectId !== REALVIRTUAL_LIBRARY_PROJECT_ID ? 'library.locate' : null,
    });
  }
  return rows;
}

/** The project's libraries plus every other catalog loaded in this viewer. */
export function listLibraries(d?: LibraryAttachDeps & { loader?: LibraryNodesLike | null }): {
  project: string | null;
  libraries: LibraryListRow[];
  libraryProjects: LibraryProjectListRow[];
} {
  const { project: store, library: libStore } = deps(d);
  const project = store.getProject();
  const manifestUrls = readProjectLibraries(project);
  const labelOf = (url: string): string | null => {
    const ref = readLibraryRefs(project).find((r) => !r.projectId && r.url === url);
    return typeof ref?.label === 'string' && ref.label ? ref.label : null;
  };
  const rowOf = (url: string, scope: 'project' | 'user'): LibraryListRow => {
    const cat = libStore.catalogs.get(url);
    return {
      url,
      label: labelOf(url) ?? (cat?.name ?? null),
      scope,
      loaded: !!cat,
      entries: cat?.entries.length ?? 0,
      error: libStore.catalogErrors.get(url) ?? null,
    };
  };
  const rows = manifestUrls.map((u) => rowOf(u, 'project'));
  for (const u of libStore.catalogUrls) if (!manifestUrls.includes(u)) rows.push(rowOf(u, 'user'));
  const loader = d && 'loader' in d ? (d.loader ?? null) : getLibraryProjectLoader();
  return { project: project?.name ?? null, libraries: rows, libraryProjects: listLibraryProjectRows(loader) };
}
