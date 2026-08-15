// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-catalog — model identity, the reactive catalogue signal, and the
 * revision registry that busts the browser cache without touching identity.
 *
 * Three small concerns live together here because they are one concern in
 * disguise: *which string identifies a model*.
 *
 *  - **Canonical URL.** The one string a model is known by — catalogue key,
 *    `localStorage` entry, `viewer.currentModelUrl` and scene-draft key are all
 *    the same value (plan-365 §2.2). It is never rewritten.
 *  - **Fetch URL.** `canonicalUrl?v=<revision>`, produced for the download and
 *    nowhere else. A publish overwrites the same URL, so without this the
 *    browser happily serves the previous GLB out of its cache and the user sees
 *    the old geometry after a "successful" update.
 *  - **Catalogue version.** A counter React can subscribe to. `SceneStore`
 *    *copies* `viewer.availableModels` and the login gate memoises on the stable
 *    viewer reference, so neither of them can see an array mutation — a shared
 *    signal is what makes one update reach both (plan-365 §2.1).
 */

/** One selectable model in the viewer's model picker. */
export interface ModelCatalogEntry {
  url: string;
  label: string;
}

// ── Reactive catalogue signal ──────────────────────────────────────────────

let _version = 0;
const _listeners = new Set<() => void>();

/** Subscribe to catalogue changes (useSyncExternalStore-compatible). */
export function subscribeModelCatalog(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Monotonic version of the model catalogue — the snapshot for React. */
export function getModelCatalogVersion(): number {
  return _version;
}

/** Announce that `viewer.availableModels` changed. */
export function bumpModelCatalog(): void {
  _version++;
  for (const listener of _listeners) {
    try {
      listener();
    } catch (e) {
      console.warn('[model-catalog] listener failed', e);
    }
  }
}

/**
 * The read-only built-in SOURCES this viewer can open (plan-716 §2.7, Phase 6).
 *
 * `SceneStore.listBuiltins()` used to answer this, and it read
 * `viewer.availableModels` to do it. That indirection only existed because
 * built-ins were shelved next to the scene CATALOGUE and the catalogue was the
 * store's job; with the catalogue gone the store has no claim on them. A source
 * is not a document — nothing owns its bytes, opening one and saving
 * materialises a document — so it is read here, from the catalogue signal that
 * actually holds it, by whoever needs it.
 */
export function builtinSources(
  viewer: { availableModels?: readonly ModelCatalogEntry[] | null } | null | undefined,
): ModelCatalogEntry[] {
  return (viewer?.availableModels ?? []).map((m) => ({ url: m.url, label: m.label }));
}

// ── Identity helpers ───────────────────────────────────────────────────────

/** The URL without query and fragment — the part that identifies the model. */
export function modelUrlKey(url: string): string {
  return url.split('#')[0].split('?')[0];
}

/** Trailing file name of a model URL, e.g. `Fuellstation.glb`. */
export function modelFileName(url: string): string {
  const key = modelUrlKey(url);
  return key.substring(key.lastIndexOf('/') + 1);
}

/** Display label for a model URL — the file name without its `.glb` suffix. */
export function modelLabel(url: string): string {
  return modelFileName(url).replace(/\.glb$/i, '');
}

/**
 * Resolve a URL as reported by a CONNECT gateway (`models/X.glb`,
 * `private-models/<project>/X.glb`) into the catalogue's URL space.
 *
 * The gateway reports without a leading slash and knows nothing about the
 * deploy's base path; the catalogue is built from `${BASE_URL}models/<file>` and
 * `/private-models/<project>/<file>`. Prefixing with the base is what makes the
 * two comparable — reconstructing either side from the file name is exactly the
 * mode-blind guess plan-363 Phase 4 removed.
 */
export function canonicalModelUrl(reported: string, baseUrl = '/'): string {
  const trimmed = reported.trim();
  if (trimmed === '') return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;   // absolute (http:, blob:, data:)
  if (trimmed.startsWith('/')) return trimmed;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${trimmed.replace(/^\.?\//, '')}`;
}

/**
 * Whether two URLs denote the same model. Query strings are ignored so a model
 * opened as a supplier variant (`…?option=sew`) still matches the plain URL the
 * gateway reports.
 */
export function isSameModelUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return modelUrlKey(a) === modelUrlKey(b);
}

// ── Revision registry (cache busting, identity untouched) ──────────────────

const _revisions = new Map<string, string>();

/** Record the revision a model was last published at. Keyed by canonical URL. */
export function setModelRevision(canonicalUrl: string, revision: string | undefined): void {
  if (!canonicalUrl) return;
  if (revision === undefined || revision === '') {
    // A gateway from before plan-365 sends no revision. Stamp the URL with the
    // local clock instead: without *some* changing parameter the reload below
    // would be answered from the cache, which is the bug, not the fallback.
    _revisions.set(modelUrlKey(canonicalUrl), `t${Date.now()}`);
    return;
  }
  _revisions.set(modelUrlKey(canonicalUrl), revision);
}

/** The recorded revision for a model URL, or undefined. */
export function getModelRevision(canonicalUrl: string): string | undefined {
  return _revisions.get(modelUrlKey(canonicalUrl));
}

/**
 * The URL to actually download from — `canonicalUrl?v=<revision>` once a
 * revision is known, and the untouched URL otherwise. Call this at the fetch
 * and nowhere else: the value must never be stored, compared or persisted.
 */
export function modelFetchUrl(canonicalUrl: string): string {
  const revision = getModelRevision(canonicalUrl);
  if (!revision) return canonicalUrl;
  if (/[?&]v=/.test(canonicalUrl)) return canonicalUrl;
  const separator = canonicalUrl.includes('?') ? '&' : '?';
  return `${canonicalUrl}${separator}v=${encodeURIComponent(revision)}`;
}

/** Drop all recorded revisions (tests). */
export function clearModelRevisions(): void {
  _revisions.clear();
}

// ── Catalogue merge ────────────────────────────────────────────────────────

/**
 * Lay published models over the catalogue the viewer resolved for itself —
 * **additively**.
 *
 * Existing entries always win. `models.json` is authoritative when present
 * (`main.ts`), and a deploy that swapped its models folder must not get
 * build-time filenames back through this door; equally, an upload must not make
 * the embedded models disappear (F8). Merging by file name also means the same
 * model published twice produces one row, not two (R6).
 */
export function mergeModelCatalog(
  existing: readonly ModelCatalogEntry[],
  incoming: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const known = new Set(existing.map((entry) => modelFileName(entry.url).toLowerCase()));
  const merged = [...existing];
  for (const entry of incoming) {
    const name = modelFileName(entry.url).toLowerCase();
    if (name === '' || known.has(name)) continue;
    known.add(name);
    merged.push(entry);
  }
  return merged;
}
