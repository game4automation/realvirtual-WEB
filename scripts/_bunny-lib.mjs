// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _bunny-lib.mjs — Reusable, individually testable building blocks for the
 * Unity-independent Bunny CDN deploy CLI (`bunny-deploy.mjs`).
 *
 * This is a direct 1:1 behavior port of the Unity C# tooling so that a deploy
 * performed by the CLI is bit-functionally identical to a deploy performed from
 * the Unity Editor:
 *   - HTTP / diff / MIME / purge / retry  → BunnyCdnUploader.cs
 *   - private staging / settings / models → WebViewerToolbar.cs
 *
 * Each parity function carries a `// SOURCE: <file>:<line> — keep in sync`
 * comment. If the C# side changes, update the matching JS here.
 *
 * Zero new runtime deps: Node built-ins + global fetch only (Node 18+).
 */

import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { encryptGlb } from './lib/rv-crypto.mjs';
import { signGlbBytes } from './rv-sign-glb.mjs';
import { join, extname, basename, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { hasDeliveryConfig, loadDeliveryConfig } from './_workspace-lib.mjs';

// ─── Constants ───────────────────────────────────────────────────────────

//! Files that bypass the size-based diff check and are ALWAYS re-uploaded.
//! Vite rewrites these on every build with new hashed asset references of
//! identical byte length, so size-only diff would incorrectly skip them and
//! the CDN would keep serving HTML that points at stale JS/CSS.
// SOURCE: BunnyCdnUploader.cs:637 (IsAlwaysUploadFile) — keep in sync
export const ALWAYS_UPLOAD_FILES = new Set([
  'settings.json',
  'models.json',
  'manifest.json',
]);

const DEFAULT_REGION = 'storage.bunnycdn.com';
export const DEFAULT_NEWS_API_URL = 'https://download.realvirtual.io/news/api/v1';
const FETCH_TIMEOUT_MS = 300_000; // parity with C# HttpClient.Timeout = 5 min (R4)
const MAX_ATTEMPTS = 3;

//! Public-demo model allowlist prefix. On a PUBLIC deploy, only top-level
//! `models/*.glb` whose filename starts with this prefix (case-insensitive) are
//! published; the component library is a sibling of models/ and is never seen here.
//! Every other top-level GLB (test fixtures, helper/MU GLBs, stray models) is
//! pruned before upload so the public CDN ships only the official demo models.
//! Override per-deploy via the RV_PUBLIC_MODEL_PREFIX env var.
export const PUBLIC_MODEL_PREFIX = 'DemoRealvirtual';

//! Example scenes (`public/scenes/*.scene.json`) whose filename starts with this
//! prefix (case-insensitive) are TEST fixtures: they live in the repo and show up
//! in the dev "Examples" list, but must NEVER ship to the public demo. The public
//! deploy prunes them from `dist/scenes/` (file + index.json) before upload.
//! Override per-deploy via the RV_PUBLIC_TEST_SCENE_PREFIX env var.
export const PUBLIC_TEST_SCENE_PREFIX = 'Test';

// ─── Path / URL helpers ──────────────────────────────────────────────────

//! Normalizes a relative path by replacing backslashes with forward slashes.
//! Critical on Windows dev machines (R5).
// SOURCE: BunnyCdnUploader.cs:72 (NormalizePath) — keep in sync
export function normalizePath(path) {
  if (!path) return path;
  return path.split(sep).join('/').replace(/\\/g, '/');
}

//! Builds the full Bunny storage upload URL. Encodes each path segment
//! individually (handles spaces / special chars in filenames), keeps slashes.
// SOURCE: BunnyCdnUploader.cs:60 (BuildUploadUrl) — keep in sync
export function buildUploadUrl(region, storageZone, relativePath) {
  const host = region.startsWith('https://') ? region : `https://${region}`;
  const encodedPath = relativePath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const zone = storageZone.replace(/^\/+|\/+$/g, '');
  return `${host}/${zone}/${encodedPath}`;
}

//! Normalizes a region string. EditorPrefs may store a label suffix such as
//! "storage.bunnycdn.com (Falkenstein DE)" — only the first token is the host.
// SOURCE: WebViewerToolbar.cs:1336 (regionEntry.Split(' ')[0]) — keep in sync
export function normalizeRegion(region) {
  if (!region || !region.trim()) return DEFAULT_REGION;
  return region.trim().split(' ')[0].trim();
}

//! Returns a MIME type for common web asset extensions. `.glb` MUST map to
//! `model/gltf-binary` or Three.js refuses to load the model.
// SOURCE: BunnyCdnUploader.cs:650 (GetMimeType) — keep in sync
export function mimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html';
    case '.css': return 'text/css';
    case '.js': return 'application/javascript';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg': return 'image/jpeg';
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.glb': return 'model/gltf-binary';
    case '.gltf': return 'model/gltf+json';
    default: return 'application/octet-stream';
  }
}

//! True for files that must bypass the size-diff check (see ALWAYS_UPLOAD_FILES).
// SOURCE: BunnyCdnUploader.cs:637 (IsAlwaysUploadFile) — keep in sync
export function isAlwaysUploadFile(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.html') return true;
  return ALWAYS_UPLOAD_FILES.has(basename(filePath).toLowerCase());
}

// ─── Config ──────────────────────────────────────────────────────────────

//! Reads + validates the Bunny credentials from an env object (default
//! process.env). Throws on missing required keys (CI fail-fast).
export function loadConfig(env = process.env) {
  const storageKey = (env.BUNNY_STORAGE_KEY || '').trim();
  const storageZone = (env.BUNNY_STORAGE_ZONE || '').trim();

  if (!storageKey) throw new Error('Missing required env BUNNY_STORAGE_KEY');
  if (!storageZone) throw new Error('Missing required env BUNNY_STORAGE_ZONE');

  const newsOverride = (env.NEWS_API_URL || '').trim();
  return {
    storageKey,
    storageZone: storageZone.replace(/^\/+|\/+$/g, ''),
    accountKey: (env.BUNNY_ACCOUNT_KEY || '').trim(),
    pullZoneId: (env.BUNNY_PULL_ZONE_ID || '').trim(),
    region: normalizeRegion(env.BUNNY_REGION),
    remotePath: (env.BUNNY_REMOTE_PATH || '').trim().replace(/^\/+|\/+$/g, ''),
    googleAnalyticsId: (env.GA_MEASUREMENT_ID || '').trim(),
    newsApiUrl: (env.NEWS_DISABLE || '').trim() === '1'
      ? ''
      : newsOverride || DEFAULT_NEWS_API_URL,
  };
}

//! Injects the public-hosted news opt-in into a built settings.json artifact.
//! Empty URL is the NEWS_DISABLE=1 no-op; private/customer generators never call this.
export function injectNewsIntoSettings(settingsPath, newsApiUrl, dryRun = false) {
  if (!newsApiUrl || !existsSync(settingsPath) || dryRun) return false;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.news = { enabled: true, apiUrl: newsApiUrl };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
}

// ─── Build env ───────────────────────────────────────────────────────────

//! Builds the environment for `npm run build` for a given mode.
//! Public  → VITE_PUBLIC_BUILD=1 (HAS_PRIVATE=false, no private content).
//! Private → MUST NOT set VITE_PUBLIC_BUILD (private content compiled in).
//! Optional `base` → VITE_BASE (Vite base path, e.g. /demo/).
// SOURCE: WebViewerToolbar.cs (BuildWebViewerPrivate vs public deploy) — keep in sync
export function buildEnvForMode(mode, opts = {}) {
  const env = { ...process.env };
  if (mode === 'public') {
    env.VITE_PUBLIC_BUILD = '1';
    delete env.VITE_PRIVATE_BUILD;
  } else {
    // Private build: ensure VITE_PUBLIC_BUILD is NOT inherited from a prior public run.
    // VITE_PRIVATE_BUILD gates customer-facing pruning (e.g. no bundled example scenes).
    delete env.VITE_PUBLIC_BUILD;
    env.VITE_PRIVATE_BUILD = '1';
  }
  if (opts.base) env.VITE_BASE = opts.base;
  return env;
}

// ─── Sanitize ────────────────────────────────────────────────────────────

//! Sanitizes a demo / project name for use in URLs: lowercase, alphanumeric +
//! hyphens, collapsed + trimmed, capped at 60 chars. Empty → "demo".
// SOURCE: WebViewerToolbar.cs:1050 (SanitizeDemoName) — keep in sync
export function sanitizeDemoName(name) {
  if (!name) return 'demo';
  let out = String(name).toLowerCase().trim();
  out = out.replace(/[^a-z0-9-]/g, '-');
  out = out.replace(/-+/g, '-');
  out = out.replace(/^-+|-+$/g, '');
  if (out.length > 60) out = out.substring(0, 60);
  return out || 'demo';
}

// ─── Local file collection + diff ────────────────────────────────────────

//! Recursively collects files under a directory. Returns
//! [{ abs, rel, size }] with forward-slash relative paths. Skips `.map`.
// SOURCE: BunnyCdnUploader.cs:239 (GetFiles + .map skip) — keep in sync
export function collectLocalFiles(rootDir) {
  const out = [];
  const root = rootDir.replace(/[\\/]+$/, '');
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (extname(entry.name).toLowerCase() === '.map') continue;
      const rel = normalizePath(abs.substring(root.length + 1));
      out.push({ abs, rel, size: statSync(abs).size });
    }
  }
  walk(root);
  return out;
}

//! Selects which local files need uploading. `local` = [{ rel, size }],
//! `remote` = Map<lowercaseRelPath, size>. A file is skipped when its remote
//! size equals the local size AND it is not an always-upload file. With
//! `force: true` everything is selected. With `alwaysUploadGlbs: true` every
//! .glb is selected regardless of size — required for encrypted deploys: the
//! RVE1 envelope has fresh random salt/IVs on every publish, so a password
//! change produces different bytes at the IDENTICAL size and the size diff
//! would silently keep the old-password ciphertext on the CDN.
// SOURCE: BunnyCdnUploader.cs:287 (diff check) — keep in sync
export function selectFilesToUpload(local, remote, opts = {}) {
  if (opts.force || !remote) return [...local];
  const result = [];
  for (const f of local) {
    if (isAlwaysUploadFile(f.rel) || (opts.alwaysUploadGlbs && extname(f.rel).toLowerCase() === '.glb')) {
      result.push(f);
      continue;
    }
    const remoteSize = remote.get(f.rel.toLowerCase());
    if (remoteSize !== undefined && remoteSize === f.size) {
      continue; // unchanged
    }
    result.push(f);
  }
  return result;
}

//! Builds a Map<lowercaseRelPath, size> from a flat list of remote storage
//! entries (already flattened, directories filtered out by listRecursive).
export function buildRemoteIndex(entries) {
  const map = new Map();
  for (const e of entries) {
    if (e.isDirectory) continue;
    map.set(e.rel.toLowerCase(), e.size);
  }
  return map;
}

// ─── Bunny HTTP client ───────────────────────────────────────────────────

//! Thin HTTP client over the Bunny Storage + CDN APIs. Uses global fetch with
//! a 5-minute AbortSignal.timeout (R4) and exponential backoff + jitter (R7).
export class BunnyClient {
  constructor({ region, zone, storageKey, accountKey = '', pullZoneId = '', dryRun = false, log = () => {} }) {
    this.region = region;
    this.zone = zone.replace(/^\/+|\/+$/g, '');
    this.storageKey = storageKey;
    this.accountKey = accountKey;
    this.pullZoneId = pullZoneId;
    this.dryRun = dryRun;
    this.log = log;
  }

  _host() {
    return this.region.startsWith('https://') ? this.region : `https://${this.region}`;
  }

  //! Uploads a single file (Buffer/Uint8Array) to the given remote path.
  //! Accepts HTTP 200/201. Retries up to 3 times on 5xx / network error with
  //! exponential backoff (2^n * 1000 ms) + jitter.
  // SOURCE: BunnyCdnUploader.cs:308 (per-file PUT + retry loop) — keep in sync
  async putFile(bytes, remotePath, mimeOverride) {
    if (this.dryRun) {
      this.log(`[dry-run] PUT ${remotePath}`);
      return;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    const contentType = mimeOverride || mimeType(remotePath);
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'PUT',
          headers: {
            AccessKey: this.storageKey,
            'Content-Type': contentType,
          },
          body: bytes,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.status === 201 || resp.status === 200) return;
        const body = await resp.text().catch(() => '');
        lastErr = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
      } catch (ex) {
        lastErr = ex?.message ?? String(ex);
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw new Error(`Upload failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
  }

  //! Downloads a single file from Bunny Storage for byte-for-byte verification.
  //! Retries transient failures with the same policy as putFile().
  async getFile(remotePath) {
    if (this.dryRun) {
      this.log(`[dry-run] GET ${remotePath}`);
      return null;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: { AccessKey: this.storageKey },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.ok) return Buffer.from(await resp.arrayBuffer());
        const body = await resp.text().catch(() => '');
        lastErr = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
      } catch (ex) {
        lastErr = ex?.message ?? String(ex);
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
    throw new Error(`Download failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
  }

  //! Deletes one remote file after local snapshot validation has succeeded.
  async deleteFile(remotePath) {
    if (this.dryRun) {
      this.log(`[dry-run] DELETE ${remotePath}`);
      return;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { AccessKey: this.storageKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok && response.status !== 404) {
      const body = await response.text().catch(() => '');
      throw new Error(`Delete failed for ${remotePath}: HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  //! Recursively lists a remote storage path. Returns a flat array of
  //! { rel, size, isDirectory:false } where `rel` is relative to `remoteRoot`.
  //! Directories are descended into, not emitted. A failed/empty listing
  //! returns [] (first deploy: nothing remote yet).
  // SOURCE: BunnyCdnUploader.cs:378 (ListStorageRecursiveAsync) — keep in sync
  async listRecursive(remoteRoot) {
    const root = normalizePath(remoteRoot || '').replace(/^\/+|\/+$/g, '');
    const result = [];
    await this._listInto(root, root, result);
    return result;
  }

  async _listInto(currentPath, rootPath, result) {
    const segment = currentPath ? `/${currentPath}/` : '/';
    const url = `${this._host()}/${this.zone}${segment}`;
    let entries;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { AccessKey: this.storageKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return;
      entries = await resp.json();
    } catch (ex) {
      this.log(`[bunny] failed to list ${currentPath || '/'}: ${ex?.message ?? ex}`);
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const name = String(entry.ObjectName ?? '').replace(/^\/+|\/+$/g, '');
      const entryPath = currentPath ? `${currentPath}/${name}` : name;
      if (entry.IsDirectory) {
        await this._listInto(entryPath, rootPath, result);
      } else {
        const rel = rootPath ? entryPath.substring(rootPath.length).replace(/^\/+/, '') : entryPath;
        result.push({ rel, size: Number(entry.Length ?? 0), isDirectory: false });
      }
    }
  }

  //! Purges the configured pull-zone cache (single POST). No-op if account key
  //! or pull-zone id is missing. Failure is non-fatal (logged, not thrown).
  // SOURCE: BunnyCdnUploader.cs:594 (PurgeCacheAsync) — keep in sync
  async purge() {
    if (!this.pullZoneId || !this.accountKey) {
      this.log('[bunny] purge skipped (no account key / pull zone id)');
      return false;
    }
    if (this.dryRun) {
      this.log(`[dry-run] purge pull zone ${this.pullZoneId}`);
      return true;
    }
    try {
      const resp = await fetch(`https://api.bunny.net/pullzone/${this.pullZoneId}/purgeCache`, {
        method: 'POST',
        headers: { AccessKey: this.accountKey, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        this.log(`[bunny] purge returned HTTP ${resp.status}: ${body.slice(0, 200)}`);
        return false;
      }
      return true;
    } catch (ex) {
      this.log(`[bunny] purge failed (non-fatal): ${ex?.message ?? ex}`);
      return false;
    }
  }
}

// ─── Private project: load / validate ────────────────────────────────────

//! Loads + validates a project.json. Throws (with filename) when missing or
//! when `code` / `name` are absent — so a deploy never lands under `undefined/`.
// SOURCE: WebViewerToolbar.cs:1135 (LoadProject) + R6 validation — keep in sync
export function loadProject(projectDir) {
  const jsonPath = join(projectDir, 'project.json');
  if (!existsSync(jsonPath)) {
    throw new Error(`project.json not found in ${projectDir}`);
  }
  let project;
  try {
    project = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (ex) {
    throw new Error(`Failed to parse ${jsonPath}: ${ex?.message ?? ex}`);
  }
  if (!project || typeof project.code !== 'string' || !project.code.trim()) {
    throw new Error(`Invalid project.json (missing "code"): ${jsonPath}`);
  }
  if (typeof project.name !== 'string' || !project.name.trim()) {
    throw new Error(`Invalid project.json (missing "name"): ${jsonPath}`);
  }
  const privateRoot = dirname(dirname(projectDir));
  // A delivery config may be named after the CUSTOMER and claim this project in its
  // `projects[]` (§2.10), so probing for delivery/<folder>.json is no longer the
  // question. hasDeliveryConfig() answers the real one: does any config claim it?
  if (hasDeliveryConfig(privateRoot, basename(projectDir))) {
    project.delivery = loadDeliveryConfig(privateRoot, basename(projectDir));
  }
  return project;
}

//! Discovers private projects: subfolders of `baseDir` that contain a
//! project.json. Returns [{ project, projectDir, folderName }].
// SOURCE: WebViewerToolbar.cs:1112 (DiscoverPrivateProjects) — keep in sync
export function discoverPrivateProjects(baseDir) {
  const result = [];
  if (!baseDir || !existsSync(baseDir)) return result;
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = join(baseDir, entry.name);
    if (!existsSync(join(projectDir, 'project.json'))) continue;
    try {
      const project = loadProject(projectDir);
      result.push({ project, projectDir, folderName: entry.name });
    } catch {
      // corrupt project.json — skip in discovery
    }
  }
  return result;
}

// ─── Private project: settings.json ──────────────────────────────────────

//! Generates the settings.json content for a private project.
//! Private CUSTOMER deploys never carry analytics: googleAnalyticsId is
//! hardcoded empty (the runtime skips gtag injection for ''). GA stays a
//! public-demo-only concern (injectGaIntoSettings on the public path).
//!
//! plan-700 Phase 6 (B14): the project's own `settings/project-settings.json`
//! is merged in as the BASE when the caller passes it. It is a base, never an
//! override: every key this function owns (`projectAssetsPath`, `analytics`,
//! `encryption`, `generated`, and `defaultModel` when the manifest declares
//! one) is written afterwards and wins. A project file can therefore add
//! settings the deploy did not know about, but can never switch analytics back
//! on, aim the assets path elsewhere, or claim the build is unencrypted.
// SOURCE: WebViewerToolbar.cs:1185 (GeneratePrivateSettings) — keep in sync
export function generatePrivateSettings(project, projectFolderName, opts = {}) {
  let defaultModel = project?.settings?.defaultModel ?? '';
  if (defaultModel && !defaultModel.startsWith('models/')) {
    defaultModel = 'models/' + defaultModel;
  }
  const settings = {};
  for (const [key, value] of Object.entries(projectSettingsBase(opts.projectSettings))) {
    settings[key] = value;
  }
  if (defaultModel) settings.defaultModel = defaultModel;
  if (projectFolderName) settings.projectAssetsPath = `private-assets/${projectFolderName}/`;
  // plan-267: signal the runtime to install the password gate + decrypt models.
  // The GLBs keep their .glb name but hold an RVE1 envelope; salt/iterations live
  // in each envelope header, so this flag only needs to be a boolean.
  if (opts.encryption) settings.encryption = { enabled: true };
  settings.analytics = { googleAnalyticsId: '' }; // no tracking in customer deploys
  settings.generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return JSON.stringify(settings, null, 2);
}

//! Keys of the generated settings.json that a project file must never set.
//! `analytics` and `encryption` are security statements about the artifact,
//! `projectAssetsPath` and `generated` are deploy mechanics.
export const SETTINGS_RESERVED_KEYS = Object.freeze([
  'projectAssetsPath',
  'analytics',
  'encryption',
  'generated',
]);

//! The usable part of a `settings/project-settings.json`: a plain object with
//! every reserved key stripped. Anything else (array, string, null, unparsed)
//! yields {} — a malformed project file must not be able to break a deploy.
export function projectSettingsBase(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SETTINGS_RESERVED_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

//! Reads `<projectDir>/settings/project-settings.json`, or null when it is
//! absent or unparseable. A broken file is not a deploy failure: the deploy
//! simply falls back to the generated settings it produced before plan-700.
export function readProjectSettingsFile(projectDir) {
  const path = join(projectDir, 'settings', 'project-settings.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

//! The curated Examples manifest (`scenes/index.json`, `[{file,name,mode}]`)
//! derived from the manifest's `scenes[]` — plan-700 Phase 6.
//!
//! Only `baseKind: 'published'` entries whose `path` points into `scenes/`
//! qualify: a customer's own scenes are Zone C and are not published Examples.
//! Returns null when the manifest declares none, in which case the folder's own
//! `index.json` (if any) is left exactly as it was — the folder stays SSOT for
//! everything the manifest does not speak about (P0-3).
export function publishedSceneIndex(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const out = [];
  for (const scene of scenes) {
    if (!scene || typeof scene !== 'object') continue;
    if (scene.baseKind !== 'published') continue;
    const path = typeof scene.path === 'string' ? scene.path.replace(/^\.?\//, '') : '';
    if (!path.startsWith('scenes/')) continue;
    const file = path.slice('scenes/'.length);
    if (!file || file.includes('/') || !file.endsWith('.scene.json')) continue;
    const entry = { file };
    if (typeof scene.name === 'string' && scene.name) entry.name = scene.name;
    if (typeof scene.mode === 'string' && scene.mode) entry.mode = scene.mode;
    out.push(entry);
  }
  return out.length > 0 ? out : null;
}

//! The GLBs a project publishes, in `readdirSync` order — the exact contents of
//! the deployed `models.json`.
//!
//! **The folder is the source of truth, not the manifest** (plan-700 P0-3).
//! plan-372 turned the browser-side `FolderBackend.listModels()` directory-driven
//! for the same reason and removed `models[]` from all six manifests: every GLB in
//! `models/` belongs to the project, and nobody should have to remember to
//! register one. Publishing from `models[]` would have re-imposed exactly the
//! bookkeeping that decision removed — and, with the manifests already emptied,
//! would have published nothing.
//!
//! Extracted from `stagePrivateProject` only so the derivation can be asserted
//! against the real project folders without staging half a gigabyte of GLB.
export function projectModelNames(projectDir) {
  const modelsDir = join(projectDir, 'models');
  if (!existsSync(modelsDir)) return [];
  const names = [];
  for (const entry of readdirSync(modelsDir, { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.glb') names.push(entry.name);
  }
  return names;
}

// ─── Private project: staging ────────────────────────────────────────────

function copyDirRecursive(sourceDir, destDir, excludeExtensions) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const srcPath = join(sourceDir, entry.name);
    const dstPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath, excludeExtensions);
    } else {
      if (excludeExtensions && excludeExtensions.has(extname(entry.name).toLowerCase())) continue;
      copyFileSync(srcPath, dstPath);
    }
  }
}

//! Stages a private project into a fresh temp directory ready for upload.
//! Copies dist/ (root files flat; subdirs except models/; assets/ without .glb),
//! the project's own models/*.glb, then writes models.json + settings.json.
//! Returns the staging directory path. Does NOT build (caller builds first).
//! Caller is responsible for cleaning up the returned dir (try/finally).
//!
//! When `encryption` is provided ({ password, fragmentSecret, iterations?,
//! chunkSize? }), each GLB is AES-256-GCM encrypted (plan-267) and staged under
//! its SAME .glb name (the bytes are an RVE1 envelope, self-describing via magic);
//! settings.json then carries `encryption:{enabled:true}`. Async because encryption is.
// SOURCE: WebViewerToolbar.cs:1215 (StagePrivateProject) — keep in sync
/**
 * @param {{
 *   distDir: string,
 *   projectDir: string,
 *   encryption?: { password: string, fragmentSecret: Uint8Array, iterations?: number, chunkSize?: number } | null,
 *   signing?: { privateKey: import('node:crypto').KeyObject, customerCert?: object | null } | null,
 * }} opts
 * @returns {Promise<string>} staging directory path
 */
export async function stagePrivateProject({ distDir, projectDir, encryption = null, signing = null }) {
  if (!existsSync(distDir)) {
    throw new Error(`dist/ not found: ${distDir}`);
  }
  const project = loadProject(projectDir);
  const folderName = basename(projectDir);

  // Fresh atomic staging dir (R9).
  const stagingDir = mkdtempSync(join(tmpdir(), `realvirtual-private-${project.code}-`));

  // Copy dist/ root files flat.
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(distDir, entry.name), join(stagingDir, entry.name));
    }
  }
  // Copy dist/ subdirectories EXCEPT models/, scenes/ and library/; strip .glb out of assets/.
  // scenes/ holds realvirtual's curated "Example" demos (public/scenes/*.scene.json +
  // index.json); they are intentional only on the public demo deploy. A private/kiosk
  // customer build must not surface a generic realvirtual "Planner Demo" in its Models
  // panel, so the scenes/ folder is dropped here (the Examples section then stays hidden).
  // library/ is the same case and became one only when the DemoRealvirtual project moved
  // into `public/` (it used to reach dist/ solely via the public deploy's staging step):
  // the bundled realvirtual component library is demo content, and a customer deploy must
  // show the customer's own assets. The project's own library/ is copied back in below.
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    if (name === 'models' || name === 'scenes' || name === 'library') continue;
    const exclude = name === 'assets' ? new Set(['.glb']) : null;
    copyDirRecursive(join(distDir, entry.name), join(stagingDir, entry.name), exclude);
  }

  // Copy project models/*.glb.
  const projectModelsDir = join(projectDir, 'models');
  const stagingModelsDir = join(stagingDir, 'models');
  mkdirSync(stagingModelsDir, { recursive: true });
  const glbNames = projectModelNames(projectDir);
  for (const name of glbNames) {
    const src = join(projectModelsDir, name);
    const dst = join(stagingModelsDir, name);
    // Provenance order is security-sensitive: sign the finished plaintext
    // GLB first, then wrap those signed bytes in the optional RVE1 envelope.
    const plain = readFileSync(src);
    const signedPlain = signing ? signGlbBytes(plain, signing) : plain;
    if (encryption) {
      // Encrypt in place: same .glb name, RVE1 envelope as the file body.
      const cipher = await encryptGlb(
        signedPlain,
        encryption.password,
        encryption.fragmentSecret,
        { iterations: encryption.iterations, chunkSize: encryption.chunkSize },
      );
      writeFileSync(dst, cipher);
    } else {
      writeFileSync(dst, signedPlain);
    }
  }

  // A project's OWN scenes/ folder is staged (the drop above targets the
  // build's generic Examples, which a customer must not see — a project that
  // authored its own example scenes is the opposite case).
  const projectLibraryDir = join(projectDir, 'library');
  if (existsSync(projectLibraryDir)) {
    copyDirRecursive(projectLibraryDir, join(stagingDir, 'library'), null);
  }

  const projectScenesDir = join(projectDir, 'scenes');
  if (existsSync(projectScenesDir)) {
    copyDirRecursive(projectScenesDir, join(stagingDir, 'scenes'), null);
    // plan-700 Phase 6: the manifest's `scenes[]` publishes the Examples
    // catalogue. Written only when the manifest actually declares published
    // scenes — otherwise the folder's own index.json (if it has one) stands.
    const index = publishedSceneIndex(project);
    if (index) {
      writeFileSync(join(stagingDir, 'scenes', 'index.json'), JSON.stringify(index, null, 2));
    }
  }

  // models.json (array of GLB filenames) — AlwaysUpload file.
  // Deliberately still `readdirSync`-derived: the folder is the single source
  // of truth for assets (plan-700 P0-3), the manifest is a metadata overlay.
  writeFileSync(join(stagingDir, 'models.json'), JSON.stringify(glbNames));

  // settings.json with project assets path + analytics, on top of the
  // project's own settings/project-settings.json when it has one (B14).
  writeFileSync(
    join(stagingDir, 'settings.json'),
    generatePrivateSettings(project, folderName, {
      encryption: !!encryption,
      projectSettings: readProjectSettingsFile(projectDir),
    }),
  );

  return stagingDir;
}

// ─── Deploy guard: dev artifacts ──────────────────────────────────────────

//! Hard gate before ANY upload: dist/index.html must not contain dev-only
//! script injections (e.g. the impeccable-live block pointing at
//! `localhost:8400/live.js`). The Vite plugin `rv-strip-impeccable-live`
//! removes these on build; this check also covers `--no-build` deploys of a
//! stale dist/. Throws so the deploy aborts instead of shipping the artifact.
export function assertNoDevArtifacts(distDir) {
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) return;
  const html = readFileSync(indexPath, 'utf8');
  const patterns = [
    /impeccable-live/i,
    /localhost:\d+\/live\.js/i,
  ];
  for (const p of patterns) {
    if (p.test(html)) {
      throw new Error(
        `Dev artifact in ${indexPath} (matched ${p}) — refusing to deploy. `
        + `Rebuild without --no-build, or remove the impeccable-live block from index.html.`,
      );
    }
  }
}

// ─── Public deploy: model allowlist ──────────────────────────────────────

//! Enforces the public-demo model allowlist on a freshly built `dist/`:
//!
//!  1. top-level `dist/models/*.glb` — KEEP files whose name starts with
//!     `prefix` (case-insensitive), DELETE the rest (test/helper/stray models).
//!  2. subdirectories of `dist/models/` — skipped; the library lives in `dist/library/`.
//!  3. `dist/assets/<stem>-<hash>.glb` — Vite emits a SECOND, content-hashed
//!     copy of every globbed GLB here. Delete only the hashed copies of the
//!     models removed in step 1 (matched by `<stem>-` with a hyphen boundary so
//!     e.g. dropping `EuropalletEmpty` never hits the library's `Europallet`/
//!     `EuropalletLoaded` assets). Library + any other bundled GLB stay.
//!  4. `dist/models.json` — rewritten to the kept demo models so the model
//!     selector lists exactly what is shipped (the build-time `import.meta.glob`
//!     otherwise bakes in every dev GLB filename, leaving 404 ghost entries).
//!
//! Idempotent (safe to re-run on an already-pruned dist/, e.g. with --no-build).
//! In `dryRun` mode nothing is written/deleted — only the report is computed.
//! Returns { kept, dropped, droppedAssets } (filenames, sorted).
export function applyPublicModelAllowlist(distDir, { prefix = PUBLIC_MODEL_PREFIX, dryRun = false } = {}) {
  const modelsDir = join(distDir, 'models');
  const kept = [];
  const dropped = [];
  const droppedAssets = [];
  if (!existsSync(modelsDir)) return { kept, dropped, droppedAssets };

  const pfx = String(prefix || PUBLIC_MODEL_PREFIX).toLowerCase();

  // Step 1+2: prune top-level models/*.glb; subdirectories (incl. library/) skipped.
  for (const entry of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== '.glb') continue;
    if (entry.name.toLowerCase().startsWith(pfx)) {
      kept.push(entry.name);
    } else {
      dropped.push(entry.name);
      if (!dryRun) rmSync(join(modelsDir, entry.name), { force: true });
    }
  }

  // Step 3: prune the hashed assets/ duplicates of the dropped top-level models.
  const droppedStems = dropped.map((n) => basename(n, extname(n)).toLowerCase());
  const assetsDir = join(distDir, 'assets');
  if (droppedStems.length > 0 && existsSync(assetsDir)) {
    for (const entry of readdirSync(assetsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (extname(entry.name).toLowerCase() !== '.glb') continue;
      const lower = entry.name.toLowerCase();
      if (droppedStems.some((stem) => lower.startsWith(`${stem}-`))) {
        droppedAssets.push(entry.name);
        if (!dryRun) rmSync(join(assetsDir, entry.name), { force: true });
      }
    }
  }

  // Step 4: authoritative model manifest for the selector (always-upload file).
  if (!dryRun) {
    writeFileSync(join(distDir, 'models.json'), JSON.stringify(kept.slice().sort()));
  }

  return {
    kept: kept.sort(),
    dropped: dropped.sort(),
    droppedAssets: droppedAssets.sort(),
  };
}

// ─── Public deploy: test-scene pruning ───────────────────────────────────

//! Prunes TEST example scenes from a freshly built public `dist/` so they never
//! reach the public CDN (they stay in the repo + the dev Examples list):
//!
//!  1. `dist/scenes/<prefix>*.scene.json` — DELETE every example scene whose
//!     filename starts with `prefix` (case-insensitive; default "Test").
//!  2. `dist/scenes/index.json` — rewrite the curated Examples manifest to DROP
//!     the entries that point at the deleted files, so the public demo's Examples
//!     list never references (or 404s on) a test scene.
//!
//! Idempotent (safe to re-run on an already-pruned dist/, e.g. with --no-build).
//! In `dryRun` mode nothing is written/deleted — only the report is computed.
//! Returns { kept, dropped } (scene filenames, sorted).
export function applyPublicScenePruning(distDir, { prefix = PUBLIC_TEST_SCENE_PREFIX, dryRun = false } = {}) {
  const scenesDir = join(distDir, 'scenes');
  const kept = [];
  const dropped = [];
  if (!existsSync(scenesDir)) return { kept, dropped };

  const pfx = String(prefix || PUBLIC_TEST_SCENE_PREFIX).toLowerCase();

  // Step 1: delete test scene files (matched by name prefix + .scene.json).
  for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.scene\.json$/i.test(entry.name)) continue;
    if (entry.name.toLowerCase().startsWith(pfx)) {
      dropped.push(entry.name);
      if (!dryRun) rmSync(join(scenesDir, entry.name), { force: true });
    } else {
      kept.push(entry.name);
    }
  }

  // Step 2: drop the pruned files from the curated index.json (match by the same
  // filename prefix so a stale entry can't resurrect a deleted scene as a 404).
  const indexPath = join(scenesDir, 'index.json');
  if (existsSync(indexPath)) {
    let arr = null;
    try { arr = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { arr = null; }
    if (Array.isArray(arr)) {
      const filtered = arr.filter((e) => {
        const f = e && typeof e === 'object' ? e.file : undefined;
        return !(typeof f === 'string' && f.toLowerCase().startsWith(pfx));
      });
      if (!dryRun && filtered.length !== arr.length) {
        writeFileSync(indexPath, JSON.stringify(filtered, null, 2) + '\n');
      }
    }
  }

  return { kept: kept.sort(), dropped: dropped.sort() };
}

// ─── Public deploy: SEO artifacts ────────────────────────────────────────

//! Default absolute origin of the public deploy target. Override per-deploy via
//! the RV_PUBLIC_BASE_URL env var (forks substitute their own pull-zone host).
export const PUBLIC_BASE_URL = 'https://web.realvirtual.io';

//! Remote path prefix that is considered THE canonical, indexable public deploy.
//! Only a deploy to this prefix gets canonical/OG URL tags + sitemap + robots;
//! every other non-root public prefix (e.g. "dev") is noindexed so it never
//! competes with the canonical demo in search results. Override via
//! RV_SEO_CANONICAL_PATH; disable all SEO handling with RV_SEO=0.
export const SEO_CANONICAL_PATH = 'demo';

//! Injects deploy-specific SEO tags into `dist/index.html`: canonical link,
//! og:url, og:image and twitter:card/image. The committed index.html stays
//! deployment-neutral (it carries only URL-free meta tags) — only the DEPLOYED
//! artifact knows its public URL, mirroring the GA settings.json injection.
//!
//! og:image prefers a dedicated `og-image.png` in dist/ (1200×630 marketing
//! shot, card style summary_large_image); falls back to the square PWA icon
//! with a plain summary card when absent.
//!
//! Idempotent: a file that already carries rel="canonical" is left untouched.
//! In `dryRun` mode nothing is written. Returns true when tags were (or would
//! be) injected.
export function injectSeoTags(distDir, { pageUrl, dryRun = false }) {
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) return false;
  let html = readFileSync(indexPath, 'utf8');
  if (/rel="canonical"/i.test(html)) return false;

  const hasOgImage = existsSync(join(distDir, 'og-image.png'));
  const imageUrl = pageUrl + (hasOgImage ? 'og-image.png' : 'pwa-512x512.png');
  const card = hasOgImage ? 'summary_large_image' : 'summary';
  const tags = [
    `  <link rel="canonical" href="${pageUrl}" />`,
    `  <meta property="og:url" content="${pageUrl}" />`,
    `  <meta property="og:image" content="${imageUrl}" />`,
    `  <meta name="twitter:card" content="${card}" />`,
    `  <meta name="twitter:image" content="${imageUrl}" />`,
  ].join('\n');

  if (!dryRun) {
    html = html.replace(/\s*<\/head>/i, `\n${tags}\n</head>`);
    writeFileSync(indexPath, html);
  }
  return true;
}

//! Injects <meta name="robots" content="noindex, nofollow"> into an index.html.
//! Used for private customer deploys (unguessable {code}/ URLs must never be
//! indexed — a robots.txt below the domain root has no effect, the meta tag is
//! the mechanism that works at any path) and for non-canonical public prefixes
//! (e.g. /dev) to avoid duplicate-content shadows of the canonical demo.
//! Idempotent; `dryRun` writes nothing. Returns true when injected.
export function injectNoindex(indexPath, { dryRun = false } = {}) {
  if (!existsSync(indexPath)) return false;
  let html = readFileSync(indexPath, 'utf8');
  if (/name="robots"/i.test(html)) return false;
  if (!dryRun) {
    html = html.replace(
      /\s*<\/head>/i,
      `\n  <meta name="robots" content="noindex, nofollow" />\n</head>`,
    );
    writeFileSync(indexPath, html);
  }
  return true;
}

//! Writes the crawler artifacts for the canonical public deploy into dist/:
//!
//!  - `sitemap.xml` — currently the single canonical page URL; per-scene landing
//!    pages can extend the list later.
//!  - `robots.txt`  — allow-all + absolute Sitemap line (overwrites the neutral
//!    committed public/robots.txt in the built dist/).
//!
//! Because the sitemap URL is absolute, the SAME robots.txt content is also
//! valid at the storage-zone ROOT — crawlers only honor /robots.txt at the
//! domain root, so the caller additionally uploads `robots` there when the
//! deploy goes to a sub-path. Returns { robots, sitemap } (file contents).
export function writeSeoArtifacts(distDir, { pageUrl, dryRun = false }) {
  const lastmod = new Date().toISOString().slice(0, 10);
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${pageUrl}</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');
  const robots = `User-agent: *\nAllow: /\n\nSitemap: ${pageUrl}sitemap.xml\n`;
  if (!dryRun) {
    writeFileSync(join(distDir, 'sitemap.xml'), sitemap);
    writeFileSync(join(distDir, 'robots.txt'), robots);
  }
  return { robots, sitemap };
}
