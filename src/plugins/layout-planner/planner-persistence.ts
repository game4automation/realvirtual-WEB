// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Persistence and autosave helpers for the LayoutPlannerPlugin.
 *
 * Hosts catalog loading, catalog-entry lookup, and the placement-URL
 * resolution logic (including the cloud-asset re-download fallback used
 * when a Unity Asset Manager extension is wired up).
 *
 * Extracted from `index.ts` (Plan-177 Phase 8). Functions take explicit
 * dependencies (store / extension / cloud store) instead of `this`, so
 * the planner class retains the single source of truth and the helpers
 * stay easy to unit-test with a tiny mock surface.
 *
 * Behavior is BIT-FOR-BIT equivalent to the previous private methods.
 */

import {
  normalizeCatalogEntry,
  type LayoutStore,
  type LibraryCatalogEntry,
  type PlacedComponent,
} from './rv-layout-store';
import type { LayoutPlannerCloudStore } from './cloud-types';

/**
 * Auto-load the realvirtual component library.
 *
 * The library belongs to the DemoRealvirtual project and is BUNDLED: it lives
 * in `public/library/`, so `<BASE_URL>library/` reaches it in dev and in a
 * build alike. That base is also what the catalog's relative `glbUrl`s resolve
 * against.
 *
 * Mutates the provided `store` via `addCatalogDirect`. Returns silently on
 * any fetch / parse error so the planner can still boot offline.
 */
export async function loadBundledLibrary(store: LayoutStore): Promise<string | null> {
  const baseUrl = (import.meta.env.BASE_URL ?? '/') + 'library/';
  const catalogUrl = baseUrl + 'catalog.json';
  try {
    const resp = await fetch(catalogUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.entries && Array.isArray(data.entries)) {
        const catalog = {
          version: '1.0' as const,
          name: data.name ?? 'Standard Library',
          entries: data.entries.map(
            (e: Partial<LibraryCatalogEntry> & { glbUrl: string }) =>
              normalizeCatalogEntry(e, baseUrl),
          ),
        };
        store.addCatalogDirect(catalogUrl, catalog);
        return catalogUrl;
      }
    }
  } catch { /* no catalog — fall through to the legacy glob below */ }

  // Legacy fallback: enumerate GLBs still sitting under `public/models/library/`
  // via import.meta.glob. The shipped library moved into the DemoRealvirtual
  // project, so this now only catches local scratch (`Custom/`, `imports/`).
  // These assets live in `public/`, so Vite serves them at the ROOT path
  // (WITHOUT the `/public` prefix) and the `?url` import VALUE is unreliable
  // (Vite warns: "Assets in the public directory are served at the root
  // path"). We therefore read the glob KEYS and derive the served path
  // ourselves: strip the `/public/models/library/` prefix to get each asset's
  // sub-path (e.g. `PalletHandling/CartonBox.glb`), pass it as a RELATIVE
  // glbUrl resolved against `baseUrl`, and use the first sub-folder as the
  // collection facet so subfolders become library categories.
  const glbModules = import.meta.glob('/public/models/library/**/*.glb', {
    query: '?url', import: 'default', eager: true,
  }) as Record<string, string>;

  const PUBLIC_PREFIX = '/public/models/library/';
  const keys = Object.keys(glbModules);
  if (keys.length === 0) return null;

  const catalog = {
    version: '1.0' as const,
    name: 'Standard Library',
    entries: keys.map((key) => {
      const sub = key.startsWith(PUBLIC_PREFIX)
        ? key.slice(PUBLIC_PREFIX.length)
        : (key.split('/').pop() ?? key);
      const parts = sub.split('/');

      // Category (enum): first subfolder if it maps to a known category,
      // otherwise 'custom'. Mirrors the Local Folder convention so existing
      // category-based UIs keep working.
      const folder = parts.length > 1 ? parts[0].toLowerCase() : '';
      const category = (['conveyor', 'robot', 'machine', 'fixture', 'des'].includes(folder)
        ? folder
        : 'custom') as LibraryCatalogEntry['category'];

      // Collections (chips): every parent directory becomes a chip, cumulative
      // for nested folders — `PalletHandling/Conveyors/Roll.glb` →
      // ["PalletHandling", "PalletHandling/Conveyors"]. Same as Local Folder.
      const dirSegments = parts.slice(0, -1).filter(Boolean);
      const collections: string[] = [];
      for (let i = 0; i < dirSegments.length; i++) {
        collections.push(dirSegments.slice(0, i + 1).join('/'));
      }

      return normalizeCatalogEntry(
        { glbUrl: sub, category, collections: collections.length > 0 ? collections : undefined },
        baseUrl,
      );
    }),
  };
  const fallbackUrl = 'bundled://library';
  store.addCatalogDirect(fallbackUrl, catalog);
  return fallbackUrl;
}

/** Find a catalog entry by its stable id across all loaded catalogs. */
export function findCatalogEntryById(
  store: LayoutStore,
  catalogId: string,
): LibraryCatalogEntry | null {
  for (const catalog of store.getSnapshot().catalogs.values()) {
    const entry = catalog.entries.find(e => e.id === catalogId);
    if (entry) return entry;
  }
  return null;
}

/**
 * Pick the freshest valid glbUrl for a placement during scene restore.
 * Returns null if no usable URL can be resolved (caller logs + skips).
 *
 * Saved blob: URLs become dead handles after a page reload — they MUST be
 * re-resolved against either the current catalog entry (for regular bundled
 * / file libraries) or a fresh download from the cloud extension (for
 * `unity-cloud:` Asset Manager assets, where catalog entries themselves
 * carry on-demand blob URLs that get regenerated by `cloud.downloadGlb`).
 *
 * Returns either a known-stable URL (http(s):, data:, /path) or a
 * just-issued blob URL from `cloud.downloadGlb`. Never returns a saved
 * blob URL — those are always stale by the time we get here.
 */
/**
 * Re-root a bundled (local) standard-library path onto the current deploy's
 * BASE_URL. A scene authored on one deploy (e.g. root `/`) stores each placement
 * glbUrl as the fully-resolved path of THAT deploy (`/library/...`); under
 * a sub-path deploy (`/demo/`) that root-absolute path resolves against the origin
 * root and 404s. Stripping to the `library/...` suffix and re-prepending
 * BASE_URL makes published scenes portable across root / sub-path / customer
 * deploys (and keeps local dev == build).
 *
 * The optional `models/` prefix is what scenes saved before the library moved
 * out of `models/` carry. Dropping it re-roots them onto the current location,
 * so an old published layout keeps resolving.
 *
 * Full public web URLs (http/https — e.g. a GitHub-hosted library) and blob/data
 * URLs are left untouched: those are NOT deploy-relative and resolve the same
 * everywhere.
 */
function rebaseLocalLibraryUrl(url: string): string | null {
  if (!url || /^(https?:|blob:|data:)/i.test(url)) return null;
  const m = url.match(/(?:^|\/)(?:models\/)?(library\/.+)$/);
  if (!m) return null;
  const base = import.meta.env.BASE_URL ?? '/';
  return (base.endsWith('/') ? base : base + '/') + m[1];
}

export async function resolvePlacementUrl(
  store: LayoutStore,
  cloudStore: LayoutPlannerCloudStore | null,
  comp: PlacedComponent,
): Promise<string | null> {
  // Splat placements: resolve splatUrl instead of glbUrl
  if (comp.splatUrl) {
    if (!comp.splatUrl.startsWith('blob:')) return comp.splatUrl;
    // Try to resolve from catalog
    const entry = findCatalogEntryById(store, comp.catalogId);
    if (entry?.splatUrl && !entry.splatUrl.startsWith('blob:')) return entry.splatUrl;
    // For blob: splat URLs, try catalog entry's blob (may be fresh from local folder)
    if (entry?.splatUrl) return entry.splatUrl;
    return null;
  }

  // 1. Saved URL is a stable URL (not blob:) — use it as-is, except a bundled
  //    (local) standard-library path is re-rooted onto THIS deploy's BASE_URL so
  //    a scene authored on another base (e.g. root) still resolves under a
  //    sub-path deploy (/demo). Public http(s) library URLs are left untouched.
  if (comp.glbUrl && !comp.glbUrl.startsWith('blob:')) {
    return rebaseLocalLibraryUrl(comp.glbUrl) ?? comp.glbUrl;
  }

  // 2. Current catalog entry has a stable URL — use it.
  //    Local-folder catalog entries carry FRESH blob URLs produced by
  //    `restoreLocalFolder()` at boot, so we accept them too (the saved
  //    `comp.glbUrl` blob is stale, but the catalog's is alive).
  const entry = findCatalogEntryById(store, comp.catalogId);
  if (entry?.glbUrl) {
    if (!entry.glbUrl.startsWith('blob:')) return entry.glbUrl;
    if (comp.catalogId.startsWith('local-')) return entry.glbUrl;
  }

  // 3. Unity Asset Manager — re-download via the cloud extension. The
  //    returned URL is a FRESH blob URL produced by `cloud.downloadGlb`
  //    in this session, so it's valid until the next reload.
  if (comp.catalogId.startsWith('unity-cloud:')) {
    if (cloudStore) {
      const assetId = comp.catalogId.slice('unity-cloud:'.length);
      const cs = cloudStore.getSnapshot().connections.find(c => c.connected && c.adapter && c.assets);
      const asset = cs?.assets?.find(a => a.id === assetId);
      if (cs && asset) {
        try {
          return await cloudStore.downloadGlb(cs.conn.id, assetId, asset.assetVersion);
        } catch (e) {
          console.warn(`[LayoutPlanner] Cloud download failed for ${assetId}:`, e);
        }
      }
    }
  }

  // 4. No fresh URL obtainable. Caller logs + skips.
  return null;
}

/**
 * Wait until all in-flight cloud connections have finished connecting AND
 * loading assets. Resolves immediately if the cloud store has nothing
 * pending. Used by restore paths so the cloud-download fallback in
 * `resolvePlacementUrl` sees a populated `assets[]`.
 */
export async function waitForCloudReady(cloudStore: LayoutPlannerCloudStore): Promise<void> {
  const needsWait = () =>
    cloudStore.getSnapshot().connections.some(c => c.connecting || c.loading);
  if (!needsWait()) return;
  await new Promise<void>((resolve) => {
    const check = () => { if (!needsWait()) { unsub(); resolve(); } };
    const unsub = cloudStore.subscribe(check);
    check();
  });
}

/**
 * Re-resolve the glbUrl for a single placed component that originated from
 * the cloud, downloading a fresh blob URL via `cloud.downloadGlb` when
 * needed. Mirrors the per-component logic inside the legacy
 * `_loadCatalogs` autosave-restore loop.
 *
 * Returns either:
 *  - the input `glbUrl` unchanged (no re-download needed),
 *  - a freshly downloaded blob URL (already mirrored into the store via
 *    `store.updateGlbUrl`), or
 *  - `null` if the component should be skipped (warning is logged).
 *
 * `onProgress` is invoked just before a network download so callers can
 * surface UI ("Downloading <label>…").
 */
export async function refreshCloudGlbUrl(
  store: LayoutStore,
  cloudStore: LayoutPlannerCloudStore | null,
  comp: PlacedComponent,
  onProgress?: (msg: string) => void,
): Promise<string | null> {
  let glbUrl = comp.glbUrl;

  // Local-folder placements: the saved blob URL is stale after a page
  // reload. `restoreLocalFolder()` re-mounted the working folder at boot
  // and rebuilt catalog entries with fresh blob URLs, so re-resolve via
  // the catalog. If the entry vanished (folder removed / different machine),
  // skip with a warning.
  if (comp.catalogId.startsWith('local-') && glbUrl.startsWith('blob:')) {
    const entry = findCatalogEntryById(store, comp.catalogId);
    if (entry?.glbUrl) {
      store.updateGlbUrl(comp.id, entry.glbUrl);
      return entry.glbUrl;
    }
    console.warn(
      `[LayoutPlanner] Local-folder asset "${comp.label}" (${comp.catalogId}) ` +
      'not in current library — re-add the working folder to recover.',
    );
    return null;
  }

  if (!(comp.catalogId.startsWith('unity-cloud:') && glbUrl.startsWith('blob:'))) {
    return glbUrl;
  }
  if (!cloudStore) {
    console.warn(`[LayoutPlanner] Cloud asset ${comp.catalogId} requires Unity Asset Manager extension — skipping`);
    return null;
  }
  const assetId = comp.catalogId.slice('unity-cloud:'.length);
  const cs = cloudStore.getSnapshot().connections.find(c => c.connected && c.adapter);
  if (!cs?.adapter || !cs.assets) {
    console.warn(`[LayoutPlanner] No AM connection available to restore asset ${assetId} — skipping`);
    return null;
  }
  const asset = cs.assets.find(a => a.id === assetId);
  if (!asset) {
    console.warn(`[LayoutPlanner] AM asset ${assetId} not found in connected libraries — skipping`);
    return null;
  }
  onProgress?.(`Downloading ${comp.label}…`);
  glbUrl = await cloudStore.downloadGlb(cs.conn.id, assetId, asset.assetVersion);
  // Update stored URL so subsequent autosaves use the fresh blob URL
  store.updateGlbUrl(comp.id, glbUrl);
  return glbUrl;
}
