// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-source-registry — the seam every asset supplier sits behind
 * (plan-372 §2.6.4).
 *
 * Today the Layout Planner knows, by name, about remote catalogs, GitHub scans,
 * a local folder and — through an escape hatch on its extension interface — an
 * Asset-Manager cloud tab. The Projects dashboard needs the same list plus the
 * active project's own `library/` folder, and the Asset Editor needs to reopen
 * a draft against whichever of them produced it. A registry is what lets all
 * three read one list without any of them importing the others.
 *
 * ## Three contracts that are not negotiable
 *
 * 1. **Identity is the PAIR `(providerId, sourceId)`.** `LibrarySource.id` is
 *    unique only *within* one provider; two providers may legitimately both
 *    call their source `"library"`. Every lookup therefore takes both halves.
 *
 * 2. **`resolveAsset` takes an `assetId`, never an entry object.** A draft
 *    persisted by the Asset Editor stores ids, not objects — an entry-object
 *    signature would make reopening a draft after a reload impossible.
 *
 * 3. **`ResolvedAsset.url` is ALWAYS volatile and is never persisted.** A cloud
 *    or OPFS adapter hands out `blob:` URLs which are dead after a reload. The
 *    caller owns the URL and calls {@link ResolvedAsset.revokeUrl} in the
 *    success, error *and* cancel paths.
 *
 * ## Why the snapshot is a number
 *
 * `getLibrarySourcesSnapshot()` returns a version counter, not an object.
 * `useSyncExternalStore` compares snapshots by identity; a getter that built a
 * fresh array or object on every call re-renders forever (React minified error
 * #185 — the exact failure `LayoutLibraryPanel.tsx` had to work around with a
 * module-level `EMPTY_CLOUD_SNAPSHOT` constant). A counter cannot have that bug.
 */

import type { LibraryCatalogEntry } from './library-types';

// ─── Resolution ─────────────────────────────────────────────────────────

/** Why an asset is being resolved. Lets a provider pick a cheaper artefact. */
export type ResolvePurpose = 'thumbnail' | 'place' | 'edit';

export interface ResolvedAsset {
  /** `http(s):` OR `blob:` — ALWAYS volatile, never persist it. */
  url: string;
  /** Release the URL. Call in the success, error AND cancel paths. */
  revokeUrl?(): void;
  /** Opaque version marker. A mismatch never blocks a reopen (§2.6.6). */
  version?: string;
}

// ─── Source + provider ──────────────────────────────────────────────────

export interface LibrarySource {
  /** Unique ONLY within its provider — see the file header. */
  id: string;
  label: string;
  kind: 'project' | 'bundled' | 'url' | 'github' | 'local' | 'cloud';
  writable: boolean;
  loaded: boolean;
  needsPermission?: boolean;
  error?: string | null;
  /**
   * Resolver-only source: it still answers {@link getEntry} / {@link resolveAsset}
   * (so placements made from it keep resolving after a reload), but browsing UIs
   * — the library panel, the Projects dashboard, the agent catalog listing —
   * do not show it. Used by a source whose service is currently unreachable,
   * where a visible-but-dead tab would only be noise. Absent = shown.
   */
  hidden?: boolean;
  listEntries(): LibraryCatalogEntry[];
  /** `null` for an unknown id — never throws (§9.5). Canonical ids only. */
  getEntry(assetId: string): LibraryCatalogEntry | null;
  /**
   * The entry a LEGACY id answers to (plan-778 F5: `RvDocumentEntry.aliases`),
   * or null. A SEPARATE lookup on purpose: only the unqualified legacy pass
   * (`findLegacyOrigin`) asks it, and only after every source's canonical ids
   * were asked — an alias never shadows another library's canonical id.
   * `resolveAsset` accepts an alias too. Optional; absent = no aliases.
   */
  getAliasEntry?(alias: string): LibraryCatalogEntry | null;
  resolveAsset(assetId: string, purpose: ResolvePurpose): Promise<ResolvedAsset>;
  refresh?(): Promise<void>;
  remove?(): Promise<void>;
}

export interface LibrarySourceProvider {
  id: string;
  listSources(): LibrarySource[];
  subscribe(listener: () => void): () => void;
}

/** One entry of the flattened cross-provider listing. */
export interface RegisteredLibrarySource {
  providerId: string;
  source: LibrarySource;
}

// ─── Registry state ─────────────────────────────────────────────────────

const providers = new Map<string, { provider: LibrarySourceProvider; unsubscribe: () => void }>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

/**
 * Register a provider. Returns the unregister function.
 *
 * Registering the same id twice replaces the previous provider (and drops its
 * subscription) — that is what a project switch does when it re-registers the
 * newly active project under the stable id `'project'`.
 */
export function registerLibrarySourceProvider(p: LibrarySourceProvider): () => void {
  const previous = providers.get(p.id);
  if (previous) previous.unsubscribe();

  const unsubscribe = p.subscribe(() => bump());
  providers.set(p.id, { provider: p, unsubscribe });
  bump();

  return () => {
    const current = providers.get(p.id);
    // Only unregister if WE are still the registered provider — a later
    // register() for the same id must not be undone by an older disposer.
    if (!current || current.provider !== p) return;
    current.unsubscribe();
    providers.delete(p.id);
    bump();
  };
}

/** Every source of every provider, in registration order. */
export function listLibrarySources(): RegisteredLibrarySource[] {
  const out: RegisteredLibrarySource[] = [];
  for (const [providerId, { provider }] of providers) {
    for (const source of provider.listSources()) out.push({ providerId, source });
  }
  return out;
}

/** The sources a browsing UI shows: {@link listLibrarySources} minus `hidden` ones. */
export function listBrowsableLibrarySources(): RegisteredLibrarySource[] {
  return listLibrarySources().filter(s => s.source.hidden !== true);
}

/** Lookup by the identity PAIR. `null` when either half is unknown. */
export function getLibrarySource(providerId: string, sourceId: string): LibrarySource | null {
  const entry = providers.get(providerId);
  if (!entry) return null;
  return entry.provider.listSources().find(s => s.id === sourceId) ?? null;
}

export function subscribeLibrarySources(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Version counter — NOT an object. See the file header. */
export function getLibrarySourcesSnapshot(): number {
  return version;
}

/**
 * A source that is still fetching its listing: not loaded, no error, and not
 * parked behind a permission prompt (that one waits for a click, not a fetch).
 */
export function isLibrarySourcePending(source: LibrarySource): boolean {
  return !source.loaded && !source.error && source.needsPermission !== true;
}

/** True while at least one registered source is still loading its listing. */
export function hasPendingLibrarySources(): boolean {
  return listLibrarySources().some(({ source }) => isLibrarySourcePending(source));
}

/**
 * Resolve once no registered source is still loading, or after `timeoutMs`.
 *
 * A project's `libraries[]` are subscribed when the project becomes active, but
 * the catalog fetch behind each one lands later. An asset-id lookup made in
 * that window — a dashboard card composing a planner scene right after the
 * switch — misses every entry and falls back to the stored `path`, which for
 * the bundled demo names a file that does not exist next to the document
 * (2026-10-25: `/demo-realvirtual/library/…` 404s). Never rejects: a slow
 * catalog only costs the timeout, after which the caller resolves with what it
 * has.
 */
export function whenLibrarySourcesSettled(timeoutMs = 10_000): Promise<void> {
  if (!hasPendingLibrarySources()) return Promise.resolve();
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
      if (!hasPendingLibrarySources()) finish();
    });
  });
}

/**
 * Resolve an asset through the registry.
 *
 * Throws a descriptive error when the provider or the source is gone — the
 * Asset Editor turns exactly that into visible error UI instead of silently
 * opening an empty Untitled document (§2.6.6).
 */
export async function resolveAsset(
  providerId: string,
  sourceId: string,
  assetId: string,
  purpose: ResolvePurpose,
): Promise<ResolvedAsset> {
  const source = getLibrarySource(providerId, sourceId);
  if (!source) {
    throw new Error(`Library source "${providerId}/${sourceId}" is not registered.`);
  }
  return source.resolveAsset(assetId, purpose);
}

/** Test seam — drops every provider and its subscription. */
export function resetLibrarySourceRegistryForTests(): void {
  for (const { unsubscribe } of providers.values()) unsubscribe();
  providers.clear();
  listeners.clear();
  version = 0;
}
