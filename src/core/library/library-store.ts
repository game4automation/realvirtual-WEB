// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-store — catalog state, lifted out of the Layout Planner (plan-372 §2.6.1).
 *
 * Everything about *which libraries exist and what is in them* used to be
 * private state of `LayoutStore`. The Projects dashboard needs the same state,
 * and it must be the SAME state — two copies would disagree the moment a user
 * added a library in one of the two windows.
 *
 * So the fields, the mutators and the free helper functions moved here verbatim.
 * `LayoutStore` keeps its whole public surface and delegates (§2.6.2): it
 * subscribes to this store in its constructor and rebuilds a *combined*
 * snapshot on every library mutation, so no existing React consumer notices the
 * split.
 *
 * ## The one behaviour that is genuinely new: the origin policy (§2.6.3)
 *
 * `addCatalog` now takes a {@link LibraryOrigin}. Only `'user'` is persisted
 * into the global list, and promotion is monotone. The subtle part is the
 * pre-existing early return for an already-registered URL: the promotion has to
 * happen **before** it, otherwise a library that arrived first from a config
 * default and was *then* explicitly added by the user would never be marked
 * `'user'` — and would vanish on the next restart.
 */

import {
  isSupported as isFsApiSupported,
  selectWorkFolder,
  getWorkFolder,
  getWorkFolderMeta,
  removeWorkFolder,
  getSubfolder,
  listFiles,
  readFileAsUrl,
  type LocalFileEntry,
} from '../engine/rv-local-filesystem';
import {
  LOCAL_NEEDS_PERMISSION,
  LS_KEY_ACTIVE_TAB,
  LS_KEY_ORIGINS,
  LS_KEY_URLS,
  SPLAT_EXTENSIONS,
  THUMBNAILS_SUBFOLDER,
  isPersistedOrigin,
  promoteOrigin,
  type LibraryCatalog,
  type LibraryCatalogEntry,
  type LibraryOrigin,
  type LibrarySnapshot,
} from './library-types';

// ─── URL / entry normalization (moved verbatim) ─────────────────────────

/** Resolve a potentially relative URL against a base URL. */
export function resolveUrl(base: string, relative: string): string {
  // Already absolute
  if (/^https?:\/\//i.test(relative) || relative.startsWith('blob:')) return relative;
  // Starts with ./ or ../ — resolve against base
  try {
    return new URL(relative, base).href;
  } catch {
    // Fallback: simple concatenation
    const b = base.endsWith('/') ? base : base + '/';
    return b + relative.replace(/^\.\//, '');
  }
}

/** Auto-fill missing fields on a catalog entry. */
export function normalizeCatalogEntry(
  raw: Partial<LibraryCatalogEntry> & { glbUrl?: string; splatUrl?: string },
  baseUrl: string,
): LibraryCatalogEntry {
  // Virtual DES entries have no GLB — pass through with defaults
  if (raw.virtual) {
    return {
      id: raw.id ?? raw.desType?.toLowerCase() ?? 'virtual',
      name: raw.name ?? raw.desType ?? 'Virtual Component',
      category: raw.category ?? 'des',
      glbUrl: '',
      thumbnailUrl: '',
      footprintMm: raw.footprintMm,
      tags: raw.tags,
      pivotToFloor: raw.pivotToFloor,
      plugin: raw.plugin,
      virtual: true,
      desType: raw.desType,
      desConfig: raw.desConfig,
      gizmoSize: raw.gizmoSize,
      ...(raw.virtualPorts ? { virtualPorts: raw.virtualPorts } : {}),
      ...(raw.virtualChildren ? { virtualChildren: raw.virtualChildren } : {}),
    };
  }

  // Splat entries — splatUrl instead of glbUrl
  if (raw.splatUrl) {
    const splatUrlRaw = raw.splatUrl;
    const filename = splatUrlRaw.split('/').pop() ?? splatUrlRaw;
    const stem = filename.replace(/\.(splat|ksplat|ply)$/i, '');
    const id = raw.id ?? stem.toLowerCase().replace(/\s+/g, '-');
    const name = raw.name ?? stem.replace(/[_-]/g, ' ');
    const splatUrl = resolveUrl(baseUrl, splatUrlRaw);
    const thumbnailUrl = raw.thumbnailUrl
      ? resolveUrl(baseUrl, raw.thumbnailUrl)
      : '';
    return {
      id,
      name,
      category: raw.category ?? 'splat',
      splatUrl,
      thumbnailUrl,
      footprintMm: raw.footprintMm,
      tags: raw.tags,
      pivotToFloor: raw.pivotToFloor,
      plugin: raw.plugin,
      collections: raw.collections,
    };
  }

  const glbUrlRaw = raw.glbUrl ?? '';
  const filename = glbUrlRaw.split('/').pop() ?? glbUrlRaw;
  const stem = filename.replace(/\.glb$/i, '');
  const id = raw.id ?? stem.toLowerCase().replace(/\s+/g, '-');
  const name = raw.name ?? stem.replace(/[_-]/g, ' ');
  const category = raw.category ?? 'custom';
  const glbUrl = resolveUrl(baseUrl, glbUrlRaw);
  const thumbnailUrl = raw.thumbnailUrl
    ? resolveUrl(baseUrl, raw.thumbnailUrl)
    : '';
  return {
    id,
    name,
    category,
    glbUrl,
    thumbnailUrl,
    footprintMm: raw.footprintMm,
    tags: raw.tags,
    pivotToFloor: raw.pivotToFloor,
    plugin: raw.plugin,
    collections: raw.collections,
  };
}

// ─── GitHub repository scanning (moved verbatim) ────────────────────────

interface GitHubRepoRef {
  owner: string;
  repo: string;
  branch?: string;
  subpath: string;
}

/**
 * Parse a GitHub repo / folder URL into its parts. Returns null for anything
 * that is not a github.com repo URL. Handles:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/sub/folder
 */
export function parseGitHubRepoUrl(url: string): GitHubRepoRef | null {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/i,
  );
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    branch: m[3],
    subpath: (m[4] ?? '').replace(/\/+$/, ''),
  };
}

/**
 * True when `url` should be treated as a GitHub repository to SCAN for `.glb`
 * files (rather than a `catalog.json` to fetch). A github.com URL that does not
 * point at a `.json` file qualifies; a `.../blob/.../catalog.json` URL does not
 * (it is handled by the regular catalog-fetch path).
 */
export function isGitHubRepoScanUrl(url: string): boolean {
  if (/\.json(\?|#|$)/i.test(url)) return false;
  if (/\/blob\//i.test(url)) return false; // a blob points at a single file, not a folder
  return parseGitHubRepoUrl(url) !== null;
}

/**
 * True for any github.com / raw.githubusercontent.com catalog URL.
 *
 * GitHub libraries are strictly OPT-IN: they may only be loaded by an explicit
 * manual add this session (the GitHub tab, a constructor `catalogUrls` option,
 * or a `?library=<url>` parameter). They are NEVER auto-restored from persisted
 * storage or a restored scene's `catalogUrls`, and are NEVER written back to
 * storage — otherwise a former-default GitHub library that leaked into a user's
 * storage would re-scan GitHub (and 404) on every boot without the user ever
 * adding it.
 */
export function isGitHubCatalogUrl(url: string): boolean {
  return /^https?:\/\/(raw\.githubusercontent\.com|github\.com)\//i.test(url.trim());
}

/**
 * Scan a GitHub repository (optionally a subfolder) for `.glb` files via the
 * public GitHub API and build a `LibraryCatalog` from them — no `catalog.json`
 * required. Each `.glb` becomes an entry whose `glbUrl` is its raw URL; the
 * immediate parent folder becomes a collection chip. Throws on failure so the
 * caller can record a catalog error.
 */
export async function buildCatalogFromGitHub(url: string): Promise<LibraryCatalog> {
  const ref = parseGitHubRepoUrl(url);
  if (!ref) throw new Error('Not a GitHub repository URL');
  const { owner, repo } = ref;

  // Resolve the default branch when the URL did not specify one.
  let branch = ref.branch;
  if (!branch) {
    const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (!repoResp.ok) {
      throw new Error(repoResp.status === 403
        ? 'GitHub API rate limit reached — try again later'
        : `GitHub repo lookup failed: HTTP ${repoResp.status}`);
    }
    branch = ((await repoResp.json()) as { default_branch?: string }).default_branch ?? 'main';
  }

  // One recursive tree listing returns every path in the repo.
  const treeResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  if (!treeResp.ok) {
    throw new Error(treeResp.status === 403
      ? 'GitHub API rate limit reached — try again later'
      : `GitHub tree fetch failed: HTTP ${treeResp.status}`);
  }
  const treeData = (await treeResp.json()) as {
    tree?: Array<{ path: string; type: string }>;
    truncated?: boolean;
  };

  const prefix = ref.subpath ? ref.subpath.toLowerCase() + '/' : '';
  const glbNodes = (treeData.tree ?? []).filter(
    n => n.type === 'blob'
      && /\.glb$/i.test(n.path)
      && n.path.toLowerCase().startsWith(prefix),
  );
  if (glbNodes.length === 0) {
    throw new Error(treeData.truncated
      ? 'No .glb files found (repository tree was truncated — narrow the folder)'
      : 'No .glb files found in this repository / folder');
  }

  const entries: LibraryCatalogEntry[] = glbNodes.map((n) => {
    const rel = n.path.slice(prefix.length);
    const filename = n.path.split('/').pop() ?? n.path;
    const stem = filename.replace(/\.glb$/i, '');
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')).split('/').pop() ?? '' : '';
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`
      + n.path.split('/').map(encodeURIComponent).join('/');
    return {
      id: `${repo}/${n.path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: stem.replace(/[_-]+/g, ' ').trim(),
      category: 'custom' as LibraryCatalogEntry['category'],
      glbUrl: rawUrl,
      thumbnailUrl: '',
      collections: parent ? [parent] : undefined,
    };
  });

  return {
    version: '1.0',
    name: `${repo}${ref.subpath ? '/' + ref.subpath : ''}`,
    entries,
  };
}

// ─── Store ──────────────────────────────────────────────────────────────

/**
 * Catalog state for the whole application.
 *
 * Deliberately NOT a `useSyncExternalStore` consumer's only entry point: the
 * planner still reads its combined `LayoutSnapshot` through `LayoutStore`. This
 * store's own `subscribe`/`getSnapshot` pair exists for the Projects dashboard
 * and for the adapter bridge.
 */
export class LibraryStore {
  private _catalogs = new Map<string, LibraryCatalog>();
  private _catalogUrls: string[] = [];
  private _catalogErrors = new Map<string, string>();
  private _activeTabUrl: string | null = null;
  /** Map of URL -> pending Promise to serialize concurrent fetches. */
  private _pendingFetches = new Map<string, Promise<void>>();
  /** URLs added via addCatalogDirect (bundled) — excluded from localStorage. */
  private _bundledUrls = new Set<string>();
  /** Entry ids currently being auto-thumbnailed (drives per-card spinner). */
  private _thumbnailPending = new Set<string>();
  /** Per-URL origin (§2.6.3). Persisted so promotion survives a restart. */
  private _origins = new Map<string, LibraryOrigin>();
  /** URLs contributed by the active `project.json.libraries[]`. */
  private _projectUrls: string[] = [];

  private _listeners = new Set<() => void>();
  private _snapshot: LibrarySnapshot;

  constructor() {
    try {
      const at = localStorage.getItem(LS_KEY_ACTIVE_TAB);
      if (at) this._activeTabUrl = at;
      this._restoreOrigins();
    } catch { /* ignore */ }
    this._snapshot = this._createSnapshot();
  }

  // ─── useSyncExternalStore API ─────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): LibrarySnapshot => this._snapshot;

  // ─── Getters (non-React) ──────────────────────────────────────────

  get catalogs(): Map<string, LibraryCatalog> { return this._catalogs; }
  get catalogUrls(): string[] { return this._catalogUrls; }
  get catalogErrors(): Map<string, string> { return this._catalogErrors; }
  get activeTabUrl(): string | null { return this._activeTabUrl; }
  get thumbnailPending(): ReadonlySet<string> { return this._thumbnailPending; }

  /** Origin of a registered URL, or `null` when the URL is unknown. */
  getOrigin(url: string): LibraryOrigin | null { return this._origins.get(url) ?? null; }

  /** URLs currently contributed by the active project manifest. */
  getProjectLibraryUrls(): string[] { return [...this._projectUrls]; }

  // ─── Catalog management (multi-tab) ───────────────────────────────

  /**
   * Add (or re-declare) a library subscription.
   *
   * `origin` defaults to `'user'` because every UI call site is a human action;
   * boot-time and manifest-driven call sites pass their own origin explicitly.
   */
  async addCatalog(url: string, origin: LibraryOrigin = 'user'): Promise<void> {
    // Promotion FIRST — before every early return below (§2.6.3). Skipping this
    // is what would drop an explicitly user-added library on the next restart.
    const promoted = this._noteOrigin(url, origin);

    // If already loading this URL, wait for the existing fetch
    const existing = this._pendingFetches.get(url);
    if (existing) {
      if (promoted) this._persistUrls();
      await existing;
      return;
    }

    // Avoid duplicate tabs
    if (this._catalogUrls.includes(url)) {
      if (promoted) this._persistUrls();
      this._activeTabUrl = url;
      this._notify();
      return;
    }

    // Add URL to tab list immediately (shows loading state)
    this._catalogUrls.push(url);
    if (!this._activeTabUrl) this._activeTabUrl = url;
    this._notify();

    const fetchPromise = (async () => {
      try {
        // A GitHub repo / folder URL is scanned for .glb files (no catalog.json
        // needed); any other URL is fetched as a catalog.json manifest.
        if (isGitHubRepoScanUrl(url)) {
          const data = await buildCatalogFromGitHub(url);
          this._catalogs.set(url, data);
          this._catalogErrors.delete(url);
          this._notify();
          return;
        }

        // Auto-convert GitHub blob URLs to raw URLs
        // https://github.com/user/repo/blob/main/path → https://raw.githubusercontent.com/user/repo/main/path
        let fetchUrl = url;
        const ghMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
        if (ghMatch) {
          fetchUrl = `https://raw.githubusercontent.com/${ghMatch[1]}/${ghMatch[2]}/${ghMatch[3]}`;
        }
        const resp = await fetch(fetchUrl);
        if (!resp.ok) {
          this._catalogErrors.set(url, `HTTP ${resp.status}`);
          this._notify();
          return;
        }
        const data = await resp.json() as LibraryCatalog;
        if (!data.entries || !Array.isArray(data.entries)) {
          this._catalogErrors.set(url, 'Invalid catalog format');
          this._notify();
          return;
        }
        // Derive baseUrl from catalog URL directory
        const baseUrl = data.baseUrl ?? fetchUrl.substring(0, fetchUrl.lastIndexOf('/') + 1);
        // Normalize entries: auto-fill missing fields, resolve relative URLs
        data.entries = data.entries.map(e => normalizeCatalogEntry(e, baseUrl));
        this._catalogs.set(url, data);
        this._catalogErrors.delete(url);
        this._notify();
      } catch (e) {
        this._catalogErrors.set(url, e instanceof Error ? e.message : String(e));
        this._notify();
      } finally {
        this._pendingFetches.delete(url);
      }
    })();

    this._pendingFetches.set(url, fetchPromise);
    await fetchPromise;

    this._persistUrls();
  }

  /** Inject a pre-built catalog without fetching (e.g. bundled library). */
  addCatalogDirect(key: string, catalog: LibraryCatalog): void {
    this._bundledUrls.add(key);
    if (this._catalogUrls.includes(key)) {
      // Update existing
      this._catalogs.set(key, catalog);
      this._catalogErrors.delete(key);
      this._notify();
      return;
    }
    this._catalogUrls.push(key);
    this._catalogs.set(key, catalog);
    this._catalogErrors.delete(key);
    if (!this._activeTabUrl) this._activeTabUrl = key;
    this._notify();
  }

  /** Update the thumbnail URL for a specific catalog entry.
   *
   *  Immutable update: replaces the entry, its `entries` array, and the catalog
   *  object so a new reference flows through the snapshot. The ThumbnailCard is
   *  `React.memo`'d on the `entry` prop — mutating in place would leave the
   *  reference unchanged and the card would only repaint if its spinner state
   *  happened to toggle (which is why freshly-generated previews appeared only
   *  after a reload). */
  setEntryThumbnail(entryId: string, thumbnailUrl: string): void {
    for (const [key, catalog] of this._catalogs) {
      const idx = catalog.entries.findIndex(e => e.id === entryId);
      if (idx !== -1) {
        const entries = catalog.entries.slice();
        entries[idx] = { ...entries[idx], thumbnailUrl };
        this._catalogs.set(key, { ...catalog, entries });
        this._notify();
        return;
      }
    }
  }

  /** Mark/unmark an entry as having its preview auto-generated (drives the
   *  per-card spinner). */
  setThumbnailPending(entryId: string, pending: boolean): void {
    const has = this._thumbnailPending.has(entryId);
    if (pending === has) return;
    if (pending) this._thumbnailPending.add(entryId);
    else this._thumbnailPending.delete(entryId);
    this._notify();
  }

  removeCatalog(url: string): void {
    const idx = this._catalogUrls.indexOf(url);
    if (idx === -1) return;
    this._catalogUrls.splice(idx, 1);
    this._catalogs.delete(url);
    this._catalogErrors.delete(url);
    this._origins.delete(url);

    // Switch active tab
    if (this._activeTabUrl === url) {
      this._activeTabUrl = this._catalogUrls[0] ?? null;
    }
    this._persistUrls();
    this._notify();
  }

  setActiveTab(url: string): void {
    if (!this._catalogUrls.includes(url)) return;
    this._activeTabUrl = url;
    try { localStorage.setItem(LS_KEY_ACTIVE_TAB, url); } catch { /* ignore */ }
    this._notify();
  }

  // ─── Project libraries (§2.6.3, project level) ────────────────────

  /**
   * Apply the `project.json.libraries[]` of the newly active project.
   *
   * Project-level subscriptions are swapped wholesale on a project switch: URLs
   * of the previous project that no other origin claims are removed, the new
   * ones are added with origin `'projectManifest'`. A URL the user ALSO added
   * himself keeps its promoted `'user'` origin and therefore survives the swap —
   * which is exactly the two-level SSOT §2.6.3 asks for.
   */
  async applyProjectLibraries(urls: readonly string[]): Promise<void> {
    const next = [...new Set(urls.filter(u => typeof u === 'string' && u.trim() !== ''))];
    const previous = this._projectUrls;
    this._projectUrls = next;

    for (const url of previous) {
      if (next.includes(url)) continue;
      // Keep anything the user promoted — only drop pure manifest entries.
      if (this._origins.get(url) === 'projectManifest') this.removeCatalog(url);
    }
    for (const url of next) {
      // GitHub stays opt-in even from a manifest — never auto-scan.
      if (isGitHubCatalogUrl(url)) continue;
      await this.addCatalog(url, 'projectManifest');
    }
  }

  // ─── Local Working Folder support (File System Access API) ─────────

  /** True if the browser supports the File System Access API. */
  get isLocalFolderSupported(): boolean { return isFsApiSupported(); }

  /**
   * Add the working folder as a library catalog.
   *
   * If a working folder is already configured (handle in IndexedDB), reuse it —
   * Chrome may show a brief re-grant prompt because this runs in a user-gesture
   * context (button click). If no handle is stored, fall back to the native
   * directory picker.
   */
  async addLocalFolder(): Promise<void> {
    // Try to reuse an existing handle first (user-gesture context — safe to prompt).
    let root = await getWorkFolder(true);
    if (!root) {
      // No stored handle, or user denied the re-grant — show the native picker.
      root = await selectWorkFolder();
    }
    if (!root) return; // user cancelled or denied
    await this._loadLibrarySubfolder(root);
  }

  /**
   * Restore the library from a previously configured working folder.
   *
   * Called automatically at boot (no user gesture available) — must NOT call
   * `requestPermission()`. Reads the handle from IndexedDB and proceeds in
   * one of three ways:
   *   - permission still granted     → load the library subfolder normally.
   *   - handle stored, no permission → add a placeholder tab carrying the
   *     `LOCAL_NEEDS_PERMISSION` sentinel so the UI can prompt the user to
   *     re-grant access on the next click (a user-gesture context).
   *   - no handle stored             → no-op.
   */
  async restoreLocalFolder(): Promise<void> {
    const root = await getWorkFolder(false);
    if (root) {
      await this._loadLibrarySubfolder(root);
      return;
    }
    // Permission has lapsed (or was never granted in this session). If a
    // folder handle is still remembered, surface a placeholder tab so the
    // user sees the previous selection and can re-grant access by clicking
    // the tab — that click runs in a user-gesture context, which is the
    // only place `requestPermission()` is allowed.
    const meta = getWorkFolderMeta();
    if (!meta) return;
    this._addPendingLocalFolderTab(meta.displayName);
  }

  /** Insert a placeholder local-folder tab tagged with the
   *  `LOCAL_NEEDS_PERMISSION` sentinel. No-op if already present. */
  private _addPendingLocalFolderTab(folderName: string): void {
    const key = `local:${folderName}/library`;
    if (this._catalogUrls.includes(key)) return;
    this._catalogUrls.push(key);
    this._catalogs.set(key, {
      version: '1.0',
      name: `Local: ${folderName}/library`,
      entries: [],
    });
    this._catalogErrors.set(key, LOCAL_NEEDS_PERMISSION);
    this._bundledUrls.add(key); // never persist `local:` URLs into LS_KEY_URLS
    if (!this._activeTabUrl) this._activeTabUrl = key;
    this._notify();
  }

  /**
   * User-gesture entry point: prompt for read permission on the stored
   * working-folder handle and load the library subfolder. Call from a
   * click handler — the browser blocks `requestPermission()` outside of
   * user gestures. No-op if the user denies the prompt.
   */
  async activateLocalFolder(): Promise<void> {
    const root = await getWorkFolder(true);
    if (!root) return;
    // Clear the placeholder sentinel before loading so the UI flips out of
    // the "needs permission" state even if `_loadLibrarySubfolder` ends up
    // setting a different error (e.g. missing `library/` subfolder). If the
    // folder was renamed on disk since the placeholder was created, also
    // drop the now-mismatched tab — the loader will add a fresh one.
    const placeholderKey = this._catalogUrls.find(u => u.startsWith('local:'));
    const newKey = `local:${root.name}/library`;
    if (placeholderKey && placeholderKey !== newKey) {
      this.removeCatalog(placeholderKey);
    } else if (placeholderKey) {
      this._catalogErrors.delete(placeholderKey);
    }
    await this._loadLibrarySubfolder(root);
  }

  /** Refresh the local library catalog (re-scan files).
   *
   * Always called from a user gesture (the panel's Refresh button), so it uses
   * the prompting `getWorkFolder(true)` variant: if the persisted handle's read
   * permission has lapsed back to `prompt` (Chrome does this across reloads /
   * tab-backgrounding), this re-grants instead of silently no-opping — which
   * would otherwise leave the stale catalog on screen and hide newly added
   * files. When permission is already `granted`, no prompt is shown. */
  async refreshLocalFolder(): Promise<void> {
    const root = await getWorkFolder(true);
    if (!root) return;
    await this._loadLibrarySubfolder(root);
  }

  /** Remove working folder access and its catalog tab. */
  async removeLocalFolder(): Promise<void> {
    await removeWorkFolder();
    const localUrl = this._catalogUrls.find(u => u.startsWith('local:'));
    if (localUrl) this.removeCatalog(localUrl);
  }

  private async _loadLibrarySubfolder(root: FileSystemDirectoryHandle): Promise<void> {
    const key = `local:${root.name}/library`;
    try {
      // Sources merged into the single local catalog:
      //   - `library/` → all assets (GLB + Splats)
      //   - `splats/`  → splats-only (the working folder's documented home
      //                  for reality-capture point clouds). Files here are
      //                  treated identically to splats under `library/` so
      //                  the user can drop them into either location.
      const libDir = await getSubfolder(root, 'library');
      const splatsDir = await getSubfolder(root, 'splats');
      if (!libDir && !splatsDir) {
        this._catalogErrors.set(key, 'No "library/" or "splats/" subfolder found in working folder');
        this._notify();
        return;
      }

      type LocalLibrarySource = {
        dir: FileSystemDirectoryHandle;
        files: LocalFileEntry[];
        source: 'library' | 'splats';
      };
      const sources: LocalLibrarySource[] = [];
      if (libDir) {
        sources.push({
          dir: libDir,
          files: await listFiles(libDir, ['.glb', '.splat', '.ksplat', '.ply']),
          source: 'library',
        });
      }
      if (splatsDir) {
        sources.push({
          dir: splatsDir,
          files: await listFiles(splatsDir, ['.splat', '.ksplat', '.ply']),
          source: 'splats',
        });
      }

      // Persisted thumbnail map across both source `.thumbnails/` trees.
      // Keys are namespaced by source so `splats/.thumbnails/scan.png`
      // never collides with a hypothetical `library/.thumbnails/scan.png`.
      const thumbsByKey = new Map<string, FileSystemFileHandle>();
      for (const src of sources) {
        try {
          const thumbsDir = await src.dir.getDirectoryHandle(THUMBNAILS_SUBFOLDER);
          const thumbFiles = await listFiles(thumbsDir, ['.png']);
          for (const tf of thumbFiles) {
            thumbsByKey.set(`${src.source}/${tf.path.toLowerCase()}`, tf.handle);
          }
        } catch { /* no thumbnails folder yet — fine */ }
      }

      const entryArrays = await Promise.all(
        sources.map((src) => Promise.all(
          src.files.map(async (f: LocalFileEntry) => {
            const blobUrl = await readFileAsUrl(f.handle);
            const ext = '.' + (f.name.split('.').pop()?.toLowerCase() ?? '');
            const isSplat = SPLAT_EXTENSIONS.has(ext);
            const stem = f.name.replace(/\.(glb|splat|ksplat|ply)$/i, '');
            // Derive category from first subfolder, or 'custom' / 'splat'.
            // `category` stays in the predefined enum so existing UIs and
            // filters keep working; arbitrary subfolder names are exposed
            // separately via `collections` (Asset-Manager-style chips).
            const parts = f.path.split('/');
            const folder = parts.length > 1 ? parts[0].toLowerCase() : '';
            const category = isSplat
              ? 'splat' as LibraryCatalogEntry['category']
              : (['conveyor', 'robot', 'machine', 'fixture', 'des'].includes(folder)
                ? folder
                : 'custom') as LibraryCatalogEntry['category'];

            // Collections: every parent directory inside the source becomes
            // a chip. For `library/PalletHandling/RollConveyor2m.glb` →
            // ["PalletHandling"]. For nested `splats/Hall1/Scan.splat` →
            // ["Hall1"]. The source folder itself is not added as a chip —
            // splat-category already groups `splats/` entries together.
            const dirSegments = parts.slice(0, -1).filter(Boolean);
            const collections: string[] = [];
            for (let i = 0; i < dirSegments.length; i++) {
              collections.push(dirSegments.slice(0, i + 1).join('/'));
            }

            // Look up persisted thumbnail by mirroring the source path
            // (same subfolder structure, .png extension).
            const thumbRelPath = f.path.replace(/\.(glb|splat|ksplat|ply)$/i, '.png').toLowerCase();
            const thumbHandle = thumbsByKey.get(`${src.source}/${thumbRelPath}`);
            const thumbnailUrl = thumbHandle ? await readFileAsUrl(thumbHandle) : '';

            // Files from `splats/` use the source as a path prefix in
            // `localPath` and `id` so they round-trip cleanly on layout
            // restore and never collide with a same-name file under
            // `library/`. Files from `library/` keep their unprefixed
            // path → backwards-compatible with layouts saved before the
            // splats/ source existed.
            const prefixedPath = src.source === 'splats' ? `splats/${f.path}` : f.path;

            const base: LibraryCatalogEntry = {
              id: `local-${prefixedPath.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`,
              name: stem.replace(/[_-]/g, ' '),
              category,
              thumbnailUrl,
              pivotToFloor: !isSplat,
              localPath: prefixedPath,
              collections: collections.length > 0 ? collections : undefined,
            };
            if (isSplat) {
              base.splatUrl = blobUrl;
            } else {
              base.glbUrl = blobUrl;
            }
            return base;
          }),
        )),
      );

      const entries: LibraryCatalogEntry[] = entryArrays.flat();

      const catalog: LibraryCatalog = {
        version: '1.0',
        name: `Local: ${root.name}/library`,
        entries,
      };

      this.addCatalogDirect(key, catalog);
      this._activeTabUrl = key;
      this._notify();
    } catch (e) {
      this._catalogErrors.set(key, String(e));
      this._notify();
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────

  async restoreFromStorage(): Promise<void> {
    try {
      const urlsJson = localStorage.getItem(LS_KEY_URLS);
      if (!urlsJson) return;
      const urls = (JSON.parse(urlsJson) as string[]).filter(u => u.trim() !== '');
      for (const url of urls) {
        // GitHub libraries are opt-in only — never auto-restore a persisted
        // GitHub catalog (it would re-scan GitHub on every boot without the
        // user adding it this session). Only an explicit manual add loads it.
        if (isGitHubCatalogUrl(url)) continue;
        // Anything that reached the persisted list was a user subscription;
        // a stored origin (written since plan-372) wins over that default.
        await this.addCatalog(url, this._origins.get(url) ?? 'user');
      }
    } catch { /* ignore */ }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /** Record/promote the origin of a URL. Returns true when it changed. */
  private _noteOrigin(url: string, origin: LibraryOrigin): boolean {
    const current = this._origins.get(url);
    const next = current ? promoteOrigin(current, origin) : origin;
    if (current === next) return false;
    this._origins.set(url, next);
    return true;
  }

  private _restoreOrigins(): void {
    const raw = localStorage.getItem(LS_KEY_ORIGINS);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, string> | null;
      if (!parsed || typeof parsed !== 'object') return;
      for (const [url, origin] of Object.entries(parsed)) {
        if (origin === 'user' || origin === 'config'
          || origin === 'urlParam' || origin === 'projectManifest') {
          this._origins.set(url, origin);
        }
      }
    } catch { /* corrupt map — fall back to the 'user' default */ }
  }

  private _persistUrls(): void {
    try {
      // Only persist USER-origin URLs (§2.6.3). Bundled/local keys and GitHub
      // catalogs are excluded as before — GitHub is opt-in per session, and
      // this also self-heals any former-default GitHub URL that leaked into
      // storage: the next persist rewrites the list without it.
      const userUrls = this._catalogUrls.filter(
        u => u.trim() !== ''
          && !this._bundledUrls.has(u)
          && !isGitHubCatalogUrl(u)
          && isPersistedOrigin(this._origins.get(u) ?? 'user'),
      );
      localStorage.setItem(LS_KEY_URLS, JSON.stringify(userUrls));

      // The origin map is persisted for every non-bundled URL, not just the
      // persisted ones: that is what makes promotion monotone ACROSS restarts.
      const origins: Record<string, LibraryOrigin> = {};
      for (const [url, origin] of this._origins) {
        if (this._bundledUrls.has(url)) continue;
        origins[url] = origin;
      }
      localStorage.setItem(LS_KEY_ORIGINS, JSON.stringify(origins));
    } catch { /* ignore */ }
  }

  private _createSnapshot(): LibrarySnapshot {
    return {
      catalogs: new Map(this._catalogs),
      catalogUrls: [...this._catalogUrls],
      catalogErrors: new Map(this._catalogErrors),
      activeTabUrl: this._activeTabUrl,
      thumbnailPending: new Set(this._thumbnailPending),
    };
  }

  private _notify(): void {
    this._snapshot = this._createSnapshot();
    for (const l of this._listeners) l();
  }
}
