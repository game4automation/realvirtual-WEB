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
 * {@link entryOriginOf} is the authoring half: the qualifier a NEW placement
 * stores, read off the catalog entry it was made from (`libraryOrigin`, stamped
 * by the library-projects provider). Every placement-creation site goes
 * through it.
 */

import type { LibraryCatalogEntry } from './library-types';
import {
  getLibrarySource,
  isLibrarySourcePending,
  listLibrarySources,
  subscribeLibrarySources,
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
  const source = safeGetSource(ref.providerId!, ref.sourceId!);
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
  if (qualifiedSourceState(ref) !== 'pending') return Promise.resolve();
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
      if (qualifiedSourceState(ref) !== 'pending') finish();
    });
  });
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

/** A reference inside a document of `library` is that library's (`project:<path>`, a bare id it holds); null = as written. */
export function qualifyInLibrary(
  catalogId: string,
  library: { providerId: string; sourceId: string },
): { catalogId: string; providerId: string; sourceId: string } | null {
  const source = safeGetSource(library.providerId, library.sourceId);
  if (catalogId.startsWith('project:')) {
    const path = normalizeDocPath(catalogId.slice('project:'.length));
    const entry = source?.listEntries().find((e) => normalizeDocPath(e.localPath ?? '') === path);
    return { ...library, catalogId: entry?.id ?? catalogId };
  }
  return catalogId && source?.getEntry(catalogId) ? { ...library, catalogId } : null;
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
  const sources = safeSources();
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
