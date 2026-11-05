// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * library-origin — THE place that answers "which library source owns this
 * asset id" (plan-778 Phase 1, §2.1).
 *
 * Before plan-778 that answer was a first-hit loop, copied twice
 * (`rv-glb-reference-resolver.findInLibrarySources`,
 * `rv-placement-source.findRegistryOrigin`), and it was good enough while every
 * library answered to a globally unique id. A library PROJECT breaks that
 * premise: two libraries may both have a document `models/pump`, and only the
 * qualifier a placement stored says which one it meant. So there are now two
 * questions with two different answers, and they never mix:
 *
 *  - **Qualified** (`providerId === 'library-projects'` + `sourceId`): the asset
 *    lives in exactly that source. {@link findQualifiedOrigin} asks only it, by
 *    canonical document id — no other source, no alias, no fallback. A source
 *    that is not ready answers null; the caller draws a placeholder and the
 *    instancer re-resolves when the source becomes ready (F4/F8).
 *  - **Legacy** (no qualifier, or a pre-778 `global` qualifier):
 *    {@link findLegacyOrigin} makes TWO passes over every registered source in
 *    registry order — canonical ids first, then aliases — so an alias in one
 *    library never shadows a canonical id in another (F5). A stored
 *    `providerId: 'global'` + realvirtual catalog URL is mapped to the
 *    realvirtual library project first; any other stored pair is asked first,
 *    as the pre-778 resolver did, and is never required to match.
 *
 * plan-780: every stored reference resolves through {@link resolveDocumentRef}
 * in the scope of the document it is written in (hit / pending / missing).
 *
 * {@link entryOriginOf} is the authoring half: the qualifier a NEW placement
 * stores, read off the catalog entry it was made from (`libraryOrigin`, stamped
 * by the library-projects provider). Every placement-creation site goes
 * through it.
 */

import type { LibraryCatalogEntry } from './library-types';
import {
  getLibrarySource,
  hasPendingLibrarySources,
  isLibrarySourcePending,
  listLibrarySources,
  subscribeLibrarySources,
  whenLibrarySourcesSettled,
  type LibrarySource,
  type RegisteredLibrarySource,
} from './library-source-registry';

/** Provider id of the library projects of the open project (plan-778). */
export const LIBRARY_PROJECTS_PROVIDER_ID = 'library-projects';

/** Project id of the realvirtual library — built in, always resolvable (Decision C). */
export const REALVIRTUAL_LIBRARY_PROJECT_ID = 'prj_realvirtual_library';

/**
 * Provider id of the OPEN project's own documents (`project-library-provider.ts`
 * re-exports it as `PROJECT_LIBRARY_PROVIDER_ID`). Declared here so the
 * predicate below needs no project-store import.
 */
export const OPEN_PROJECT_PROVIDER_ID = 'project';

/**
 * Is `providerId` backed by a PROJECT — the open one (`project`) or a library
 * project (`library-projects`) — rather than an external catalog (plan-778,
 * Arch F8)? The provider-filter sites ask this and then decide, each for
 * itself, what differs between the two: only the open project is writable,
 * removable through its tree and the target of "project wins" dedup; library
 * projects are read-only, placeable when direct, removable via `library.detach`.
 */
export function isProjectBackedProvider(providerId: string | null | undefined): boolean {
  return providerId === OPEN_PROJECT_PROVIDER_ID || providerId === LIBRARY_PROJECTS_PROVIDER_ID;
}

/** Legacy provider id of the global catalogs (`global-library-provider.ts`). */
const LEGACY_GLOBAL_PROVIDER_ID = 'global';

// ─── Authoring ──────────────────────────────────────────────────────────

/** The qualifier + id a placement stores. `providerId`/`sourceId` only for a qualified origin. */
export interface LibraryOrigin {
  assetId: string;
  providerId?: string;
  sourceId?: string;
}

/**
 * The origin a NEW placement made from `entry` stores (plan-778 F4): the
 * entry's `libraryOrigin` when a library-projects source minted it, else the
 * bare id (the legacy form every other source keeps). Falls back to an
 * identity search over the library-projects sources for an entry object that
 * lost its stamp on the way (a copy built field by field).
 */
export function entryOriginOf(entry: Pick<LibraryCatalogEntry, 'id' | 'libraryOrigin'> | null | undefined): LibraryOrigin {
  const assetId = entry?.id ?? '';
  const stamped = entry?.libraryOrigin;
  if (stamped && stamped.providerId && stamped.sourceId) {
    return { assetId, providerId: stamped.providerId, sourceId: stamped.sourceId };
  }
  if (entry) {
    for (const { providerId, source } of safeSources()) {
      if (providerId !== LIBRARY_PROJECTS_PROVIDER_ID) continue;
      try {
        if (source.listEntries().includes(entry as LibraryCatalogEntry)) {
          return { assetId, providerId, sourceId: source.id };
        }
      } catch { /* a source that throws owns nothing */ }
    }
  }
  return { assetId };
}

/**
 * The qualifier fields of an origin, as a spreadable object — empty for a
 * legacy origin, so `{ ...originFields(o) }` never writes an `undefined` key.
 */
export function originFields(origin: Pick<LibraryOrigin, 'providerId' | 'sourceId'>): { providerId?: string; sourceId?: string } {
  return origin.providerId && origin.sourceId ? { providerId: origin.providerId, sourceId: origin.sourceId } : {};
}

/** plan-780 R7: UI-state key of an entry, library-qualified — two libraries may share a document id. */
export function entryKeyOf(entry: Pick<LibraryCatalogEntry, 'id' | 'libraryOrigin'>): string {
  const o = entry.libraryOrigin;
  return o && o.providerId && o.sourceId ? `${o.providerId}/${o.sourceId}/${entry.id}` : entry.id;
}

/** {@link originInScope}'s answer; `warning` goes to a Problems row. */
export interface ScopedOrigin extends LibraryOrigin {
  warning?: string;
}

/**
 * plan-780 A1/A2: the origin a new placement from `entry` stores in a document of
 * `scope` (contract documents-projects 4). Own library → unqualified (A2); other
 * library or open project A → qualified, warning when B does not list it (A1).
 */
export function originInScope(
  entry: Pick<LibraryCatalogEntry, 'id' | 'libraryOrigin'> | null | undefined,
  scope: DocumentScope,
  deps: { openProjectId?: string | null; libraryLists?: (libraryId: string, projectId: string) => boolean | null } = {},
): ScopedOrigin {
  const origin = entryOriginOf(entry);
  if (!scope) return origin;
  const lists = (x: string): boolean | null => deps.libraryLists?.(scope.sourceId, x) ?? null;
  if (origin.providerId === scope.providerId && origin.sourceId === scope.sourceId) return { assetId: origin.assetId };
  if (origin.providerId && origin.sourceId) {
    if (origin.sourceId !== REALVIRTUAL_LIBRARY_PROJECT_ID && lists(origin.sourceId) === false) {
      return { ...origin, warning: `"${origin.assetId}" comes from library '${origin.sourceId}', which library '${scope.sourceId}' does not list — it resolves only where both are attached.` };
    }
    return origin;
  }
  const openId = deps.openProjectId ?? null;
  const isOpenProjects = !!entry && !!openId && safeSources().some(({ providerId, source }) => {
    if (providerId !== OPEN_PROJECT_PROVIDER_ID || source.id !== openId) return false;
    try { return source.getEntry(entry.id) !== null; } catch { return false; }
  });
  if (!isOpenProjects || !openId) return origin;
  const qualified: ScopedOrigin = { assetId: origin.assetId, providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: openId };
  if (lists(openId) !== true) {
    qualified.warning = `"${origin.assetId}" is a document of the open project '${openId}', which library '${scope.sourceId}' does not list — the library cannot resolve it on its own.`;
  }
  return qualified;
}


// ─── Qualifier ──────────────────────────────────────────────────────────

/** A reference's qualifier fields. */
export interface QualifierLike {
  providerId?: string | null;
  sourceId?: string | null;
}

/** True when `ref` is a STRICT qualified reference (plan-778 F4). */
export function isQualifiedRef(ref: QualifierLike | null | undefined): boolean {
  return ref?.providerId === LIBRARY_PROJECTS_PROVIDER_ID && typeof ref.sourceId === 'string' && ref.sourceId !== '';
}

/** Where a qualified reference stands right now. */
export type QualifiedSourceState = 'ready' | 'pending' | 'unavailable';

/** The state of the ONE source a qualified reference names. `unavailable` = not registered, locked, unknown or error. */
export function qualifiedSourceState(ref: QualifierLike): QualifiedSourceState {
  if (!isQualifiedRef(ref)) return 'unavailable';
  return sourceStateOf(ref.providerId!, ref.sourceId!);
}

function sourceStateOf(providerId: string, sourceId: string): QualifiedSourceState {
  const source = safeGetSource(providerId, sourceId);
  if (!source) return 'unavailable';
  if (source.loaded) return 'ready';
  return isLibrarySourcePending(source) ? 'pending' : 'unavailable';
}

/**
 * The source + entry of a QUALIFIED reference — strict (F4): only the named
 * source is asked, by canonical id, and only when it is loaded. Null otherwise;
 * never another source, an alias, a manifest row or a path.
 */
export function findQualifiedOrigin(
  ref: QualifierLike & { assetId: string },
): { registered: RegisteredLibrarySource; entry: LibraryCatalogEntry } | null {
  if (!isQualifiedRef(ref) || !ref.assetId) return null;
  const source = safeGetSource(ref.providerId!, ref.sourceId!);
  if (!source || !source.loaded) return null;
  let entry: LibraryCatalogEntry | null = null;
  try { entry = source.getEntry(ref.assetId); } catch { entry = null; }
  if (!entry) return null;
  return { registered: { providerId: ref.providerId!, source }, entry };
}

/**
 * Resolve when the ONE source a qualified reference names is no longer pending
 * (ready, locked, unknown, error, or unregistered) — or after `timeoutMs`.
 * Never rejects. A locked / unknown source is NOT waited for (F7): it is not
 * pending, so this resolves at once.
 */
export function whenQualifiedSourceSettled(ref: QualifierLike, timeoutMs = 30_000): Promise<void> {
  if (!isQualifiedRef(ref)) return Promise.resolve();
  return whenSourceSettled(ref.providerId!, ref.sourceId!, timeoutMs);
}

/** find → wait for the ref's ONE source to settle → find again (plan-778 review C8). */
export async function findWhenQualifiedSourceSettled<T>(ref: QualifierLike, find: () => T | null | undefined): Promise<T | null> {
  const first = find();
  if (first) return first;
  await whenQualifiedSourceSettled(ref);
  return find() ?? null;
}

export function findQualifiedOriginSettled(ref: QualifierLike & { assetId: string }): Promise<ReturnType<typeof findQualifiedOrigin>> {
  return findWhenQualifiedSourceSettled(ref, () => findQualifiedOrigin(ref));
}

// ─── Document scope + THE resolver (plan-780 R1) ────────────────────────

/**
 * The project a document belongs to; its unqualified references resolve there
 * (contract documents-projects 4). `null` = the open project. Passed as data, never a global.
 */
export type DocumentScope = { providerId: string; sourceId: string } | null;

/** How a reference was found — diagnostics and tests. */
export type ResolvedVia = 'qualified' | 'legacy-path' | 'legacy-hint' | 'realvirtual' | 'scope' | 'open-project' | 'legacy';

/** A reference that resolved to one entry of one registered source. */
export interface ResolvedRef {
  registered: RegisteredLibrarySource;
  entry: LibraryCatalogEntry;
  /** The id the asset is keyed with in {@link registered} (canonical, or the R3-migrated document id). */
  assetId: string;
  /** True = strict hit in one library project, never a fallback. */
  qualified: boolean;
  via: ResolvedVia;
}

/** Why a reference resolved to nothing. */
export type RefMissingCode =
  | 'not-in-library'
  | 'library-unavailable'
  | 'legacy-path-not-found'
  | 'legacy-path-ambiguous'
  | 'not-found';

/**
 * `pending` = the deciding source still loads (null = registry-wide), recoverable.
 * `missing.strict` = no fallback to url, manifest or path (contract node-identity 4).
 */
export type RefResolution =
  | { hit: ResolvedRef }
  | { pending: true; source: { providerId: string; sourceId: string } | null }
  | { missing: true; reason: string; code: RefMissingCode; strict: boolean };

/** What {@link resolveDocumentRef} reads off a reference. */
export type DocumentRefLike = QualifierLike & { catalogId: string };

/** A pre-778 non-library-projects qualifier (`global` + URL, …): legacy, resolves registry-wide in any scope. */
export function hasLegacyHint(ref: QualifierLike | null | undefined): boolean {
  return !!ref?.providerId && ref.providerId !== LIBRARY_PROJECTS_PROVIDER_ID;
}

/** Strict = resolves in exactly one library project or not at all: qualified, or an unqualified id in a library scope (D2). */
export function isStrictDocumentRef(ref: DocumentRefLike, scope: DocumentScope): boolean {
  if (isQualifiedRef(ref)) return true;
  return !!scope && !!ref.catalogId && !hasLegacyHint(ref);
}

/** The scope of an entry's own references: the library project it belongs to, else null (plan-780 2.1). */
export function scopeOfEntry(entry: Pick<LibraryCatalogEntry, 'libraryOrigin'> | null | undefined): DocumentScope {
  const o = entry?.libraryOrigin;
  return o && o.providerId === LIBRARY_PROJECTS_PROVIDER_ID && o.sourceId ? { providerId: o.providerId, sourceId: o.sourceId } : null;
}

/** The scope a QUALIFIED reference's own nested references resolve in (its library); null otherwise. */
export function scopeOfQualifiedRef(ref: QualifierLike | null | undefined): DocumentScope {
  return isQualifiedRef(ref) ? { providerId: ref!.providerId!, sourceId: ref!.sourceId! } : null;
}

/** Are two scopes the same project? */
export function sameScope(a: DocumentScope, b: DocumentScope): boolean {
  if (a === null || b === null) return a === b;
  return a.providerId === b.providerId && a.sourceId === b.sourceId;
}

/**
 * THE resolver of a stored reference written in `scope` (plan-780 R1). Never throws,
 * never reads a pending source. Order: qualified → legacy forms (`project:<path>`
 * via the scope's path index, legacy hint, realvirtual id) → library scope strict (D2) → open project.
 */
export function resolveDocumentRef(ref: DocumentRefLike, scope: DocumentScope): RefResolution {
  const id = (ref.catalogId ?? '').trim();
  if (!id) return missingOf('not-found', 'The reference carries no document id.', false);

  // 1. Qualified: the ONE named source.
  if (isQualifiedRef(ref)) {
    const named = { providerId: ref.providerId!, sourceId: ref.sourceId! };
    return id.startsWith(PROJECT_PATH_PREFIX) ? byLegacyPath(named, id, true) : inLibrary(named, id, 'qualified');
  }

  // 2a. Legacy `project:<path>` — the scope's path index.
  if (id.startsWith(PROJECT_PATH_PREFIX)) {
    if (scope) return byLegacyPath(scope, id, true);
    const open = openProjectSource();
    const byPath = open
      ? byLegacyPath({ providerId: open.providerId, sourceId: open.source.id }, id, false)
      : missingOf('legacy-path-not-found', `No open project holds "${id}".`, false);
    if (!('missing' in byPath) || byPath.strict) return byPath;
    // Pre-780 exact-id answer (canonical key, not a path guess).
    const origin = findLegacyOrigin(id, null);
    const entry = origin ? canonicalEntry(origin.source, id) : null;
    if (origin && entry) return { hit: { registered: origin, entry, assetId: id, qualified: false, via: 'legacy' } };
    return byPath;
  }

  // 2b. Legacy hint (`global` + catalog URL, …): registry-wide, as pre-778.
  if (hasLegacyHint(ref)) {
    const origin = findLegacyOrigin(id, ref);
    const entry = origin ? entryOfSource(origin.source, id) : null;
    if (origin && entry) return { hit: { registered: origin, entry, assetId: id, qualified: false, via: 'legacy-hint' } };
    return hasPendingLibrarySources() ? pendingOf(null) : missingOf('not-found', `No library holds "${id}".`, false);
  }

  // 2c. An old realvirtual catalog id → the built-in realvirtual library project (D2 exception).
  const rv = realvirtualHit(id);
  if (rv && rv !== 'pending') return rv;

  // 3. Unqualified id inside a library document: strict in that library (D2).
  if (scope) {
    const state = sourceStateOf(scope.providerId, scope.sourceId);
    if (state === 'pending') return pendingOf(scope);
    if (state === 'unavailable') {
      return missingOf('library-unavailable', `Library "${scope.sourceId}" is not available — "${id}" cannot be placed.`, true);
    }
    const source = safeGetSource(scope.providerId, scope.sourceId)!;
    const entry = entryOfSource(source, id);
    if (entry) {
      return { hit: { registered: { providerId: scope.providerId, source }, entry, assetId: entry.id, qualified: true, via: 'scope' } };
    }
    if (rv === 'pending') return pendingOf(realvirtualScope());
    return missingOf('not-in-library', `"${id}" is missing in library "${labelOf(source)}".`, true);
  }

  // 4. Unqualified + null scope: the open project first, then the legacy search.
  const open = openProjectSource();
  if (open && !isLibrarySourcePending(open.source)) {
    let entry: LibraryCatalogEntry | null = null;
    try { entry = open.source.getEntry(id); } catch { entry = null; }
    if (entry) return { hit: { registered: open, entry, assetId: id, qualified: false, via: 'open-project' } };
  }
  const origin = findLegacyOrigin(id, null);
  const entry = origin ? entryOfSource(origin.source, id) : null;
  if (origin && entry) return { hit: { registered: origin, entry, assetId: id, qualified: false, via: 'legacy' } };
  if (rv === 'pending' || hasPendingLibrarySources()) return pendingOf(rv === 'pending' ? realvirtualScope() : null);
  return missingOf('not-found', `No library or project holds "${id}".`, false);
}

/** {@link resolveDocumentRef}; on `pending` wait for the deciding source(s) and ask once more. Never rejects. */
export async function resolveDocumentRefSettled(ref: DocumentRefLike, scope: DocumentScope): Promise<RefResolution> {
  const first = resolveDocumentRef(ref, scope);
  if (!('pending' in first)) return first;
  if (first.source) await whenSourceSettled(first.source.providerId, first.source.sourceId);
  else await whenLibrarySourcesSettled();
  return resolveDocumentRef(ref, scope);
}

/** R3: the document id a `project:<path>` migrated to this session — writers save by id after a rename. */
export function migratedDocumentIdOf(scope: { providerId: string; sourceId: string }, legacyId: string): string | null {
  if (!legacyId.startsWith(PROJECT_PATH_PREFIX)) return null;
  return legacyPathMigrations.get(migrationKey(scope, normalizeDocPath(legacyId.slice(PROJECT_PATH_PREFIX.length)))) ?? null;
}

/** Test seam: forget every in-memory legacy path migration. */
export function resetLegacyPathMigrationsForTests(): void {
  legacyPathMigrations.clear();
}

const PROJECT_PATH_PREFIX = 'project:';

/** R3: (source, path) → document id on the first unique hit; in memory only, loading never writes. */
const legacyPathMigrations = new Map<string, string>();

function migrationKey(scope: { providerId: string; sourceId: string }, normPath: string): string {
  return `${scope.providerId}|${scope.sourceId}|${normPath}`;
}

function byLegacyPath(target: { providerId: string; sourceId: string }, legacyId: string, strict: boolean): RefResolution {
  const state = sourceStateOf(target.providerId, target.sourceId);
  if (state === 'pending') return pendingOf(target);
  if (state === 'unavailable') {
    return missingOf('library-unavailable', `Library "${target.sourceId}" is not available — "${legacyId}" cannot be placed.`, strict);
  }
  const source = safeGetSource(target.providerId, target.sourceId)!;
  const registered: RegisteredLibrarySource = { providerId: target.providerId, source };
  const qualified = target.providerId === LIBRARY_PROJECTS_PROVIDER_ID;
  const normPath = normalizeDocPath(legacyId.slice(PROJECT_PATH_PREFIX.length));
  const key = migrationKey(target, normPath);
  // Migrated earlier this session: the id holds even if the file moved since.
  const migrated = legacyPathMigrations.get(key);
  if (migrated) {
    const entry = canonicalEntry(source, migrated);
    if (entry) return { hit: { registered, entry, assetId: entry.id, qualified, via: 'legacy-path' } };
  }
  let rows: LibraryCatalogEntry[] = [];
  try {
    rows = source.listEntries().filter((e) => !!e.localPath && normalizeDocPath(e.localPath) === normPath);
  } catch { rows = []; }
  if (rows.length > 1) {
    // Contract node-identity 4: more than one row answers the path — never guess.
    return missingOf('legacy-path-ambiguous',
      `Ambiguous legacy path "${legacyId}": ${rows.length} documents of "${labelOf(source)}" answer to it — kept as written.`, true);
  }
  if (rows.length === 0) {
    return missingOf('legacy-path-not-found',
      `Legacy path "${legacyId}" names no document of "${labelOf(source)}" — kept as written.`, strict);
  }
  const entry = rows[0];
  const documentId = entry.documentId ?? (entry.id.startsWith(PROJECT_PATH_PREFIX) ? null : entry.id);
  if (documentId) legacyPathMigrations.set(key, documentId);
  return { hit: { registered, entry, assetId: documentId ?? entry.id, qualified, via: 'legacy-path' } };
}

function inLibrary(named: { providerId: string; sourceId: string }, id: string, via: ResolvedVia): RefResolution {
  const state = sourceStateOf(named.providerId, named.sourceId);
  if (state === 'pending') return pendingOf(named);
  if (state === 'unavailable') {
    return missingOf('library-unavailable', `Library "${named.sourceId}" is not available — "${id}" cannot be placed.`, true);
  }
  const source = safeGetSource(named.providerId, named.sourceId)!;
  const entry = canonicalEntry(source, id);
  if (!entry) return missingOf('not-in-library', `Document "${id}" is not in library "${named.sourceId}".`, true);
  return { hit: { registered: { providerId: named.providerId, source }, entry, assetId: entry.id, qualified: true, via } };
}

/** The realvirtual library's answer for a bare id: a hit, `'pending'` while it loads, null otherwise. */
function realvirtualHit(id: string): { hit: ResolvedRef } | 'pending' | null {
  const rvScope = realvirtualScope();
  const state = sourceStateOf(rvScope.providerId, rvScope.sourceId);
  if (state === 'pending') return 'pending';
  if (state !== 'ready') return null;
  const source = safeGetSource(rvScope.providerId, rvScope.sourceId)!;
  const entry = entryOfSource(source, id);
  if (!entry) return null;
  return { hit: { registered: { providerId: rvScope.providerId, source }, entry, assetId: entry.id, qualified: true, via: 'realvirtual' } };
}

function realvirtualScope(): { providerId: string; sourceId: string } {
  return { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: REALVIRTUAL_LIBRARY_PROJECT_ID };
}

function openProjectSource(): RegisteredLibrarySource | null {
  return safeSources().find((s) => s.providerId === OPEN_PROJECT_PROVIDER_ID) ?? null;
}

function canonicalEntry(source: LibrarySource, id: string): LibraryCatalogEntry | null {
  try { return source.getEntry(id); } catch { return null; }
}

function labelOf(source: LibrarySource): string {
  return source.label || source.id;
}

function pendingOf(source: { providerId: string; sourceId: string } | null): RefResolution {
  return { pending: true, source };
}

function missingOf(code: RefMissingCode, reason: string, strict: boolean): RefResolution {
  // Ambiguity is never a fallback case, in any scope (contract node-identity 4).
  return { missing: true, reason, code, strict: strict || code === 'legacy-path-ambiguous' };
}

/** Resolve when the ONE source `(providerId, sourceId)` is no longer pending — or after `timeoutMs`. */
function whenSourceSettled(providerId: string, sourceId: string, timeoutMs = 30_000): Promise<void> {
  if (sourceStateOf(providerId, sourceId) !== 'pending') return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = subscribeLibrarySources(() => {
      if (sourceStateOf(providerId, sourceId) !== 'pending') finish();
    });
  });
}

function normalizeDocPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
}

// ─── Legacy ─────────────────────────────────────────────────────────────

/**
 * Is `url` a realvirtual library catalog URL (plan-778 F5/F14) — the bundled
 * `library/catalog.json` in any spelling (relative, root-absolute, under a base
 * path, host-qualified on a realvirtual host — see {@link isBundledRealvirtualCatalogUrl})
 * or the GitHub repository `game4automation/realvirtual-Library` (trailing slash,
 * `.git`, `/tree/<branch>/…`, raw URLs)? This is THE predicate the legacy
 * resolution and the library reference migration share.
 */
export function isRealvirtualCatalogUrl(url: string | null | undefined): boolean {
  const raw = (url ?? '').trim();
  if (!raw) return false;
  const bare = raw.split(/[?#]/)[0].replace(/\/+$/, '');
  if (isBundledRealvirtualCatalogUrl(bare)) return true;
  if (/^https?:\/\/(www\.)?github\.com\/game4automation\/realvirtual-library(\.git)?(\/.*)?$/i.test(bare)) return true;
  if (/^https?:\/\/raw\.githubusercontent\.com\/game4automation\/realvirtual-library\//i.test(bare + '/')) return true;
  return false;
}

/**
 * Is `url` the app-level BUNDLED realvirtual catalog — the one URL the
 * `library.attach` / `library.detach` legacy shim maps to the realvirtual
 * library project (plan-778 F10)? GitHub spellings are not the bundled catalog.
 *
 * Relative (`library/catalog.json`, `./…`), root-absolute and base-path forms
 * always count: they name the catalog of whatever app serves the project. A
 * HOST-QUALIFIED `…/library/catalog.json` counts only on a host that serves the
 * realvirtual library: `realvirtual.io` and its subdomains, `localhost`,
 * `127.0.0.1`, `[::1]`, and the app's own origin when one is known at runtime.
 * A partner's own catalog at the same path (`https://partner.example/library/catalog.json`)
 * is that partner's library and stays a URL entry.
 */
export function isBundledRealvirtualCatalogUrl(url: string | null | undefined): boolean {
  const bare = (url ?? '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
  if (!bare || /github(usercontent)?\.com/i.test(bare)) return false;
  if (!/(^|\/)library\/catalog\.json$/i.test(bare)) return false;
  const hostQualified = /^[a-z][a-z0-9+.-]*:\/\//i.test(bare) || bare.startsWith('//');
  return !hostQualified || isRealvirtualLibraryHost(bare);
}

/**
 * The READ-time view of a project's `libraries[]` (plan-778 Phase 4, legacy-URL
 * shim): a URL entry that names the bundled realvirtual catalog
 * ({@link isBundledRealvirtualCatalogUrl}) reads as the realvirtual library
 * PROJECT. The bundled `library/catalog.json` no longer exists, so fetching it
 * would only produce a "HTTP 404" catalog tab — while the library itself is one
 * `projectId` away and placeable exactly as the project meant.
 *
 * A view, never written: the manifest keeps its URL until the marker migration
 * (or, for a customer project, the user's Update) converts it. Every other entry
 * — external catalogs, GitHub, `{projectId}` refs — is returned unchanged, and a
 * project with nothing to map is returned as the same object.
 */
export function withBundledCatalogAsLibraryProject<P extends { libraries?: unknown }>(project: P | null | undefined): P | null | undefined {
  if (!project || !Array.isArray(project.libraries)) return project;
  let changed = false;
  const libraries = (project.libraries as unknown[]).map((item) => {
    const isObject = !!item && typeof item === 'object' && !Array.isArray(item);
    if (isObject && typeof (item as { projectId?: unknown }).projectId === 'string') return item;
    const url = typeof item === 'string' ? item : (isObject ? (item as { url?: unknown }).url : undefined);
    if (typeof url !== 'string' || !isBundledRealvirtualCatalogUrl(url)) return item;
    changed = true;
    return { ...(isObject ? item as Record<string, unknown> : { url }), projectId: REALVIRTUAL_LIBRARY_PROJECT_ID };
  });
  return changed ? { ...project, libraries } : project;
}

/** Does the host-qualified `url` point at a host that serves the realvirtual library? */
function isRealvirtualLibraryHost(url: string): boolean {
  let parsed: URL;
  try {
    // The base only completes a protocol-relative `//host/…`; a full URL ignores it.
    parsed = new URL(url, 'https://invalid.invalid');
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'realvirtual.io' || host.endsWith('.realvirtual.io')) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  const own = appOrigin();
  return own !== null && parsed.origin === own;
}

/** The origin the app runs on, or null where there is none (node, `file:`, sandboxed `null`). */
function appOrigin(): string | null {
  try {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

/**
 * The source that owns a LEGACY (unqualified) asset id — two passes over every
 * registered source in registry order: canonical ids, then aliases (F5).
 *
 * `hint` is the pair a pre-778 reference may have stored: a `global` +
 * realvirtual catalog URL is mapped to the realvirtual library project and
 * asked first; any other pair is asked first as well, but never required to
 * match (a scene opened where the same catalog is registered under another
 * provider must still resolve). Never throws — one broken provider must not
 * take the lookup with it.
 */
export function findLegacyOrigin(assetId: string, hint?: QualifierLike | null): RegisteredLibrarySource | null {
  if (!assetId) return null;
  // plan-780 R1: never read a pending source ("nothing yet" ≠ "not there").
  const sources = safeSources().filter((s) => !isLibrarySourcePending(s.source));
  if (sources.length === 0) return null;

  const preferred: RegisteredLibrarySource[] = [];
  if (hint?.providerId === LEGACY_GLOBAL_PROVIDER_ID && isRealvirtualCatalogUrl(hint.sourceId)) {
    for (const s of sources) {
      if (s.providerId === LIBRARY_PROJECTS_PROVIDER_ID && s.source.id === REALVIRTUAL_LIBRARY_PROJECT_ID) preferred.push(s);
    }
  }
  if (hint?.providerId || hint?.sourceId) {
    for (const s of sources) {
      if ((!hint.providerId || s.providerId === hint.providerId) && (!hint.sourceId || s.source.id === hint.sourceId)) {
        if (!preferred.includes(s)) preferred.push(s);
      }
    }
  }

  for (const list of [preferred, sources]) {
    for (const s of list) if (canonicalHit(s.source, assetId)) return s;
  }
  for (const list of [preferred, sources]) {
    for (const s of list) if (aliasHit(s.source, assetId)) return s;
  }
  return null;
}

/** The entry `assetId` names in `source` — canonical id first, then alias. */
export function entryOfSource(source: LibrarySource, assetId: string): LibraryCatalogEntry | null {
  try {
    return source.getEntry(assetId) ?? source.getAliasEntry?.(assetId) ?? null;
  } catch {
    return null;
  }
}

// ─── Internals ──────────────────────────────────────────────────────────

function canonicalHit(source: LibrarySource, assetId: string): boolean {
  try { return source.getEntry(assetId) !== null; } catch { return false; }
}

function aliasHit(source: LibrarySource, assetId: string): boolean {
  try { return (source.getAliasEntry?.(assetId) ?? null) !== null; } catch { return false; }
}

function safeSources(): RegisteredLibrarySource[] {
  try { return listLibrarySources(); } catch { return []; }
}

function safeGetSource(providerId: string, sourceId: string): LibrarySource | null {
  try { return getLibrarySource(providerId, sourceId); } catch { return null; }
}
