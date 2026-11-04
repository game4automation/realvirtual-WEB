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
  lstatSync,
  rmSync,
} from 'node:fs';
import { encryptGlb, makeKeyProbe, randomBytes, DEFAULT_CHUNK_SIZE } from './lib/rv-crypto.mjs';
import { existsOnDiskExactly } from './lib/rv-fs.mjs';
import { sha256Buffer } from './lib/rv-hash.mjs';
import { signGlbBytes } from './rv-sign-glb.mjs';
import { join, extname, basename, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { withDerivedDocuments } from './_rv-manifest.mjs';
import { hostedDeployDenyReason, readProjectIgnoreRules, HOSTED_DEPLOY_WARN_FILE_BYTES } from './_rv-guards.mjs';
import { DELIVERED_LIBRARIES_FOLDER, trimProjectLibraries } from './lib/rv-library-trim.mjs';

// ─── Constants ───────────────────────────────────────────────────────────

//! Files that bypass the size-based diff check and are ALWAYS re-uploaded.
//! Vite rewrites these on every build with new hashed asset references of
//! identical byte length, so size-only diff would incorrectly skip them and
//! the CDN would keep serving HTML that points at stale JS/CSS.
// SOURCE: BunnyCdnUploader.cs:637 (IsAlwaysUploadFile) — keep in sync
//!
//! `project.json` joined them for a different but equally load-bearing reason
//! (plan-726 Phase 3): it is the boot SSOT of the public demo, it sits at a
//! FIXED url, and a curator's edit — renaming a document, swapping the start
//! document — routinely leaves the byte count untouched. It must never be
//! cached like a hashed build asset, so it is always re-uploaded and the pull
//! zone is purged afterwards (`maybePurge`), which together are what let the
//! rollback in plan-726 §5.6 be "replace one file" rather than "redeploy".
//!
//! `catalog.json` (every file with that basename — external catalogs; the bundled
//! library ships `library/project.json` since plan-778, deferred the same way)
//! joined in plan-508 F2b: it carries `sha256` per asset, and a
//! changed hash leaves the byte count untouched. A size-skipped catalog would
//! keep the OLD hashes on the CDN while the browser verifies the NEW bytes.
//!
//! `feature-chunks.json` (plan-652) and `features.json` (plan-646) are build tables at a FIXED
//! url. `feature-chunks.json` names the hashed chunk files per feature, and a rebuild swaps
//! every 8-char hash for another 8-char hash — same byte count. Size-skipped, the CDN kept the
//! table of the PREVIOUS build, the idle prefetch asked for ~28 chunks that the stale-delete had
//! just removed, and the /demo smoke of 2026-10-23 10:56 went red on their 404s.
export const ALWAYS_UPLOAD_FILES = new Set([
  'settings.json',
  'models.json',
  'manifest.json',
  'project.json',
  'catalog.json',
  'feature-chunks.json',
  'features.json',
]);

const DEFAULT_REGION = 'storage.bunnycdn.com';
export const DEFAULT_NEWS_API_URL = 'https://download.realvirtual.io/news/api/v1';
const FETCH_TIMEOUT_MS = 300_000; // parity with C# HttpClient.Timeout = 5 min (R4)
const MAX_ATTEMPTS = 3;

//! Public-demo model allowlist prefixes (comma-separated). On a PUBLIC deploy,
//! only top-level `models/*.glb` whose filename starts with one of these prefixes
//! (case-insensitive) are published; the component library is a sibling of
//! models/ and is never seen here. Every other top-level GLB (test fixtures,
//! helper/MU GLBs, stray models) is pruned before upload so the public CDN ships
//! only the official demo models. DemoCSGMachining was public by user decision
//! 2026-08-07 (plan-430) and was made INTERNAL again by user decision 2026-08-30 —
//! it and DemoRobotIK are dev/test models (repo fixtures), not demo surface.
//! Override per-deploy via the RV_PUBLIC_MODEL_PREFIX env var.
export const PUBLIC_MODEL_PREFIX = 'DemoRealvirtual';

//! FALLBACK ONLY since plan-731 2k — `devOnly` on the manifest row is the rule.
//! Example scenes (`public/scenes/*.glb`) whose filename starts with this prefix
//! (case-insensitive) are TEST fixtures: they live in the repo and show up in the
//! dev "Examples" list, but must NEVER ship to the public demo. The public deploy
//! prunes them from `dist/scenes/` (file + index.json) before upload. `.scene.json`
//! is still matched by the pruner for dists built from an older source tree — see
//! `applyPublicScenePruning()` — but is no longer an authored format (plan-413).
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
  // plan-596: a project's AASX index is rewritten by the viewer; an edit that
  // keeps the byte count (an id swapped for one of equal length) must still
  // reach the CDN. Matched on the folder, not the bare name — a generic
  // `index.json` elsewhere keeps the size diff.
  if (AASX_INDEX_REL_RE.test(normalizePath(filePath))) return true;
  return ALWAYS_UPLOAD_FILES.has(basename(filePath).toLowerCase());
}

//! `aasx/index.json` at any depth (project-relative or `p/aasx/index.json`).
const AASX_INDEX_REL_RE = /(^|\/)aasx\/index\.json$/i;

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
  } else if (mode === 'demo') {
    // Hosted demo (bunny-deploy --demo): commercial code, public demo content. Neither
    // switch — VITE_PUBLIC_BUILD would stub out the private code, VITE_PRIVATE_BUILD would
    // hide the bundled example scenes. Kept in step with runBuild() in _workspace-lib.mjs,
    // which is the copy the deploy actually runs.
    delete env.VITE_PUBLIC_BUILD;
    delete env.VITE_PRIVATE_BUILD;
    delete env.RV_INTERNAL;
    delete env.RV_SOURCEMAP;
    // Installability. The AGPL watermark follows the build stage instead (plan-679 Phase 9,
    // scripts/lib/rv-agpl-attribution.mjs): with the private tree it is never in the HTML.
    env.RV_COMMERCIAL = '1';
  } else {
    // Private build: ensure VITE_PUBLIC_BUILD is NOT inherited from a prior public run.
    // VITE_PRIVATE_BUILD gates customer-facing pruning (e.g. no bundled example scenes).
    delete env.VITE_PUBLIC_BUILD;
    env.VITE_PRIVATE_BUILD = '1';
  }
  // plan-679 Phase 3: a Bunny build is never a customer delivery tier; never inherit one.
  delete env.RV_NOTICES_TIER;
  if (opts.base) env.VITE_BASE = opts.base;
  // plan-646 F14: explicit for every build, never inherited (same rule as runBuild()).
  env.RV_DEMO_WELCOME = mode === 'demo' && opts.demoWelcome === true ? '1' : '0';
  // The "realvirtual public demo for evaluation" notice: only the public demo (target path `demo`,
  // the same decision as the welcome window: demoWelcomeForTarget), never /dev or /demo-beta;
  // explicit, never inherited.
  env.RV_DEMO_NOTICE = mode === 'demo' && opts.demoWelcome === true ? '1' : '0';
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
//! `alwaysUploadRel` (plan-508 F2b) is a set of rels selected regardless of
//! size — the catalogued binaries whose `sha256` differs from the previously
//! published catalog (`catalogChangedBinaries`). Compared case-insensitively.
// SOURCE: BunnyCdnUploader.cs:287 (diff check) — keep in sync
export function selectFilesToUpload(local, remote, opts = {}) {
  if (opts.force || !remote) return [...local];
  const forced = new Set([...(opts.alwaysUploadRel ?? [])].map((rel) => normalizePath(rel).toLowerCase()));
  const result = [];
  for (const f of local) {
    if (isAlwaysUploadFile(f.rel)
      || (opts.alwaysUploadGlbs && extname(f.rel).toLowerCase() === '.glb')
      || forced.has(f.rel.toLowerCase())) {
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

/// ─── Bunny HTTP client ───────────────────────────────────────────────────

const MAX_RETRY_AFTER_MS = 60_000;
// Retrying these cannot succeed: the credentials are wrong, the answer will not change.
const NON_RETRYABLE_STATUSES = new Set([401, 403]);

//! Parses an HTTP `Retry-After` header (delta-seconds or an HTTP date) into milliseconds,
//! capped at one minute. Returns null when the header is absent or unparseable.
export function retryAfterMs(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
}

//! Thin HTTP client over the Bunny Storage + CDN APIs. Uses global fetch with
//! a 5-minute AbortSignal.timeout (R4) and exponential backoff + jitter (R7).
//! `sleep` is a test seam for the backoff wait.
export class BunnyClient {
  constructor({ region, zone, storageKey, accountKey = '', pullZoneId = '', dryRun = false, log = () => {}, sleep = null }) {
    this.region = region;
    this.zone = zone.replace(/^\/+|\/+$/g, '');
    this.storageKey = storageKey;
    this.accountKey = accountKey;
    this.pullZoneId = pullZoneId;
    this.dryRun = dryRun;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  _host() {
    return this.region.startsWith('https://') ? this.region : `https://${this.region}`;
  }

  //! The one retry loop behind putFile, getFile, deleteFile and the listing (plan-487).
  //! Up to MAX_ATTEMPTS tries on network errors and on every status `accept` refuses, except
  //! 401/403. The wait is `Retry-After` when a 429/503 sends one, else 2^attempt * 1000 ms +
  //! jitter. Returns the accepted Response; throws `${failure} after N attempts: …`.
  async _requestWithRetry(url, init, { accept, failure }) {
    let lastErr = '';
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      let wait = null;
      try {
        const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (accept(resp)) return resp;
        const body = await resp.text().catch(() => '');
        lastErr = `HTTP ${resp.status}: ${body.slice(0, 200)}`;
        if (NON_RETRYABLE_STATUSES.has(resp.status)) break;
        if (resp.status === 429 || resp.status === 503) {
          wait = retryAfterMs(resp.headers?.get?.('retry-after'));
        }
      } catch (ex) {
        lastErr = ex?.message ?? String(ex);
      }
      if (attempt < MAX_ATTEMPTS) {
        await this.sleep(wait ?? Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500));
      }
    }
    throw new Error(`${failure} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${lastErr}`);
  }

  //! Uploads a single file (Buffer/Uint8Array) to the given remote path.
  //! Accepts HTTP 200/201. Retries up to 3 times with exponential backoff
  //! (2^n * 1000 ms) + jitter, honouring Retry-After — see _requestWithRetry.
  // SOURCE: BunnyCdnUploader.cs:308 (per-file PUT + retry loop) — keep in sync
  async putFile(bytes, remotePath, mimeOverride) {
    if (this.dryRun) {
      this.log(`[dry-run] PUT ${remotePath}`);
      return;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    const contentType = mimeOverride || mimeType(remotePath);
    await this._requestWithRetry(url, {
      method: 'PUT',
      headers: {
        AccessKey: this.storageKey,
        'Content-Type': contentType,
      },
      body: bytes,
    }, { accept: (resp) => resp.status === 201 || resp.status === 200, failure: 'Upload failed' });
  }

  //! Downloads a single file from Bunny Storage for byte-for-byte verification.
  //! Retries transient failures with the same policy as putFile().
  async getFile(remotePath) {
    if (this.dryRun) {
      this.log(`[dry-run] GET ${remotePath}`);
      return null;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    const resp = await this._requestWithRetry(url, {
      method: 'GET',
      headers: { AccessKey: this.storageKey },
    }, { accept: (r) => r.ok, failure: 'Download failed' });
    return Buffer.from(await resp.arrayBuffer());
  }

  //! Like getFile(), but a missing file (HTTP 404) is `null` instead of a retried
  //! failure — the previously published catalog of a first deploy (plan-508 F2b).
  //! Dry-run answers null.
  async getFileIfExists(remotePath) {
    if (this.dryRun) {
      this.log(`[dry-run] GET ${remotePath}`);
      return null;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    const resp = await this._requestWithRetry(url, {
      method: 'GET',
      headers: { AccessKey: this.storageKey },
    }, { accept: (r) => r.ok || r.status === 404, failure: 'Download failed' });
    if (resp.status === 404) return null;
    return Buffer.from(await resp.arrayBuffer());
  }

  //! Deletes one remote file. A missing file (404) counts as deleted. Retries with the same
  //! policy as putFile() — shared with embed-deploy.mjs, which uses this client too.
  async deleteFile(remotePath) {
    if (this.dryRun) {
      this.log(`[dry-run] DELETE ${remotePath}`);
      return;
    }
    const url = buildUploadUrl(this.region, this.zone, normalizePath(remotePath));
    await this._requestWithRetry(url, {
      method: 'DELETE',
      headers: { AccessKey: this.storageKey },
    }, { accept: (r) => r.ok || r.status === 404, failure: `Delete failed for ${remotePath}` });
  }

  //! Recursively lists a remote storage path. Returns a flat array of
  //! { rel, size, isDirectory:false } where `rel` is relative to `remoteRoot`.
  //! Directories are descended into, not emitted. A path that does not exist
  //! (HTTP 404) is an empty listing — the first deploy to a new prefix. Every
  //! other failure (auth, network, 5xx after retries, invalid JSON, a non-array
  //! body) THROWS: a half-blind listing used to report success (plan-487).
  //! Deliberately sequential — Bunny allows only 5 concurrent listings.
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
    const where = currentPath || '/';
    const resp = await this._requestWithRetry(url, {
      method: 'GET',
      headers: { AccessKey: this.storageKey, Accept: 'application/json' },
    }, { accept: (r) => r.ok || r.status === 404, failure: `Listing ${where} failed` });
    if (resp.status === 404) return;
    let entries;
    try {
      entries = await resp.json();
    } catch (ex) {
      throw new Error(`Listing ${where} returned invalid JSON: ${ex?.message ?? ex}`);
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Listing ${where} returned ${entries === null ? 'null' : typeof entries} instead of an array`);
    }
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

/**
 * The delivery-config lookup, registered by the caller that HAS one (plan-604).
 *
 * This module used to import `hasDeliveryConfig`/`loadDeliveryConfig` from
 * `_workspace-lib.mjs` directly, and that one edge decided who could publish at all:
 * `_workspace-lib` pulls in the customer register (`_rv-customers.mjs`) and the whole
 * delivery/tier machinery, ~330 kB of material that describes OTHER customers'
 * arrangements. A commercial partner publishing his own project needs the staging and
 * the uploader, and must never receive that. So the dependency is inverted: internal
 * tooling (`bunny-deploy.mjs`) registers the lookup, the delivered partner CLI
 * (`publish-project.mjs`) does not, and a project simply carries no `delivery` there —
 * which is exactly true, because a delivered workspace has no delivery configs.
 *
 * `null` is the honest default: no lookup registered means nothing claims the project.
 */
let deliveryLookup = null;

//! Registers the lookup above. `(privateRoot, folderName) => deliveryConfig | null`.
export function setDeliveryLookup(lookup) {
  deliveryLookup = typeof lookup === 'function' ? lookup : null;
}

//! Loads + validates a project.json. Throws (with filename) when missing or
//! when `code` / `name` are absent — so a deploy never lands under `undefined/`.
//!
//! **This is the one read boundary of the publish path**, so it is where the
//! manifest gets its `documents[]` (plan-703 phase 9). `withDerivedDocuments()`
//! lifts a genuinely unmigrated customer's `scenes[]` / `models[]` / `library[]`
//! into the one list and drops the arrays — in memory only, nothing is written,
//! no marker is minted. Consumers downstream therefore never have to ask which
//! shape they were handed, and no consumer needs a legacy fallback of its own —
//! a fallback per consumer is how two readers of the same file drift apart.
// SOURCE: WebViewerToolbar.cs:1135 (LoadProject) + R6 validation — keep in sync
export function loadProject(projectDir) {
  const jsonPath = join(projectDir, 'project.json');
  if (!existsSync(jsonPath)) {
    throw new Error(`project.json not found in ${projectDir}`);
  }
  let project;
  try {
    project = withDerivedDocuments(JSON.parse(readFileSync(jsonPath, 'utf8')));
  } catch (ex) {
    throw new Error(`Failed to parse ${jsonPath}: ${ex?.message ?? ex}`);
  }
  if (!project || typeof project.code !== 'string' || !project.code.trim()) {
    throw new Error(`Invalid project.json (missing "code"): ${jsonPath}`);
  }
  if (typeof project.name !== 'string' || !project.name.trim()) {
    throw new Error(`Invalid project.json (missing "name"): ${jsonPath}`);
  }
  // A delivery config may be named after the CUSTOMER and claim this project in its
  // `projects[]` (§2.10), so probing for delivery/<folder>.json is not the question.
  // The registered lookup answers the real one: does any config claim it?
  const delivery = deliveryLookup?.(dirname(dirname(projectDir)), basename(projectDir)) ?? null;
  if (delivery) project.delivery = delivery;
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

//! Keys of the generated settings.json that a project file must never set.
//! `analytics` and `encryption` are security statements about the artifact,
//! `projectAssetsPath`, `hostedDeploy` (plan-640) and `generated` are deploy
//! mechanics.
export const SETTINGS_RESERVED_KEYS = Object.freeze([
  'projectUrl',
  'projectAssetsPath',
  'hostedDeploy',
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

//! The THIRD read entry point for a manifest, and the one the public deploy needs
//! (plan-726 Phase 3).
//!
//! `loadProject()` is the private-project gate: it demands a `code` so a delivery
//! can never land under `undefined/`. The PUBLIC demo deliberately has no `code`
//! — its URL is the site itself — so `loadProject()` would throw on it, which is
//! why the allowlist could not simply reuse it. `readProjectManifest()` is the
//! non-throwing reader; this only exports it under a name that says which
//! manifest is meant.
//!
//! `rootDir` is a DEPLOY ROOT (a `dist/` or a staged `public/`), not a project
//! folder — but the file, its name and its projection are the same, so there is
//! deliberately no second parser here.
export function readDeployManifest(rootDir) {
  return readProjectManifest(rootDir);
}

//! Parses `<projectDir>/project.json` through the shared document projection,
//! or null when it is absent or unparseable. Unlike `loadProject()` this neither
//! validates nor throws.
function readProjectManifest(projectDir) {
  const jsonPath = join(projectDir, 'project.json');
  if (!existsSync(jsonPath)) return null;
  try {
    return withDerivedDocuments(JSON.parse(readFileSync(jsonPath, 'utf8')));
  } catch {
    return null;
  }
}

// ─── Hosted project: staging (plan-759) ──────────────────────────────────

//! Copies ONE directory subtree of dist/ into the staging dir (the runtime part).
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

//! The relative path a hosted deploy publishes the project under. The runtime
//! sits at the deploy root, the project folder verbatim below this prefix, and
//! the generated settings.json names it as `projectUrl`.
export const HOSTED_PROJECT_PREFIX = 'p/';

/**
 * Copies a project folder byte-for-byte into `destDir`, minus what
 * `hostedDeployDenyReason()` refuses. Works on `lstat`: a symlink is never
 * dereferenced (a link pointing outside the project would otherwise land on a
 * CDN), it is skipped and reported. Returns the report the deploy prints as
 * its preflight:
 *
 *   { copied: string[], denied: {rel, reason}[], symlinks: string[], oversized: string[] }
 */
export function copyProjectVerbatim(projectDir, destDir, { ignoreRules = null } = {}) {
  const rules = ignoreRules ?? readProjectIgnoreRules(projectDir);
  const report = { copied: [], denied: [], symlinks: [], oversized: [] };
  const root = projectDir.replace(/[\\/]+$/, '');
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = normalizePath(abs.substring(root.length + 1));
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        report.symlinks.push(rel);
        continue;
      }
      const isDir = st.isDirectory();
      const reason = hostedDeployDenyReason(rel, { isDir, ignoreRules: rules });
      if (reason) {
        report.denied.push({ rel: isDir ? `${rel}/` : rel, reason });
        continue;
      }
      if (isDir) {
        mkdirSync(join(destDir, rel), { recursive: true });
        visit(abs);
        continue;
      }
      mkdirSync(dirname(join(destDir, rel)), { recursive: true });
      copyFileSync(abs, join(destDir, rel));
      report.copied.push(rel);
      if (st.size > HOSTED_DEPLOY_WARN_FILE_BYTES) report.oversized.push(rel);
    }
  };
  mkdirSync(destDir, { recursive: true });
  visit(root);
  return report;
}

//! True for a `p/`-relative path a password-protected deploy encrypts: every
//! `.glb` (any depth), the project AASX — `aasx/*.aasx` (flat, like the
//! viewer's scan) and `aasx/index.json` (plan-596) — and every saved preview
//! `.thumbnails/*.webp|png` (plan-776 P2): a picture rendered from a protected
//! model must not travel in the clear beside it. The viewer reads all of them
//! through `BundledBackend.readDocumentUrl`, which decrypts on an encrypted deploy.
export function isEncryptablePath(rel) {
  const p = normalizePath(rel);
  if (extname(p).toLowerCase() === '.glb') return true;
  if (/(^|\/)\.thumbnails\/[^/]+\.(webp|png)$/i.test(p)) return true;
  return /^aasx\/[^/]+\.aasx$/i.test(p) || /^aasx\/index\.json$/i.test(p);
}

//! Every encryptable file below `dir` (see {@link isEncryptablePath}), as
//! `p/`-relative POSIX paths, sorted.
export function encryptablePathsBelow(dir) {
  const out = [];
  const root = dir.replace(/[\\/]+$/, '');
  const visit = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) visit(abs);
      else {
        const rel = normalizePath(abs.substring(root.length + 1));
        if (isEncryptablePath(rel)) out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}

//! The rels a hosted publish must upload regardless of the size diff: the
//! catalog-hash diff (plan-508) united with every file the staging encrypted
//! (plan-596 SOL #1 — a fresh salt per publish gives new ciphertext at the
//! identical size). `encrypted` is `p/`-relative (`aasx/a.aasx`), the upload
//! works staging-relative (`p/aasx/a.aasx`). Both inputs accept any iterable
//! (`catalogHashDiff` returns a `Set`) or null/undefined.
export function hostedForcedUploadRels(encrypted = [], catalogDiff = []) {
  const out = new Set([...(catalogDiff ?? [])].map((r) => normalizePath(r)));
  for (const rel of encrypted ?? []) out.add(`${HOSTED_PROJECT_PREFIX}${normalizePath(rel).replace(/^\/+/, '')}`);
  return [...out].sort();
}

//! Generates the settings.json of a hosted deploy.
//!
//! A hosted deploy carries NO `defaultModel` (D14): the root always opens the
//! dashboard of the served project, a document opens through its own `?doc=`
//! URL — unless the project opts in with `project.json` → `settings.start`
//! (plan-640), which the runtime honours only next to `hostedDeploy: true`.
//! The project's `settings/project-settings.json` is the BASE; every key
//! this function owns (`projectUrl`, `projectAssetsPath`, `hostedDeploy`,
//! `analytics`, `encryption`, `generated`) is written afterwards and wins, so a project file
//! can add settings but never re-enable analytics, aim the project elsewhere
//! or claim the build is unencrypted. Private customer deploys never carry
//! analytics: the GA id is hardcoded empty.
export function generateHostedSettings(opts = {}) {
  const settings = {};
  for (const [key, value] of Object.entries(projectSettingsBase(opts.projectSettings))) {
    settings[key] = value;
  }
  // D14: the root of a hosted deploy is the dashboard; a document opens only
  // through its own `?doc=` URL. A `defaultModel` from the project file would
  // make the boot auto-open it, so it is dropped here rather than reserved.
  delete settings.defaultModel;
  settings.projectUrl = HOSTED_PROJECT_PREFIX;
  settings.projectAssetsPath = HOSTED_PROJECT_PREFIX;
  // plan-640: the marker that makes `project.json` → `settings.start` apply.
  // Only a real hosted deploy carries it; a `?projectUrl=` boot elsewhere does
  // not, so the opt-in start document can never leak into other deliveries.
  settings.hostedDeploy = true;
  // plan-267 / plan-759: signal the runtime to install the boot password gate.
  // `probe` is a tiny envelope over a fixed plaintext with the publish salt, so
  // the gate verifies the key without downloading a model (F5).
  if (opts.encryption) settings.encryption = { enabled: true, probe: opts.encryption.probe };
  settings.analytics = { googleAnalyticsId: '' }; // no tracking in customer deploys
  settings.generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return JSON.stringify(settings, null, 2);
}

//! Stages a hosted project into a fresh temp directory ready for upload:
//!
//!   staging/            ← dist/ root files + subdirs (without the demo's
//!                          models/, scenes/, library/; assets/ without .glb)
//!   staging/settings.json
//!   staging/p/**        ← the project folder verbatim (copyProjectVerbatim)
//!
//! With `encryption` ({ password, fragmentSecret, iterations?, chunkSize? })
//! every `.glb` below `p/` — and the project AASX (`aasx/*.aasx`,
//! `aasx/index.json`, plan-596) — becomes an RVE1 envelope under its own name:
//! ONE salt for the whole publish (one key derivation, one probe), the file's
//! `p/`-relative path as `hkdfInfo` (per-file AAD binding, F6b), 16 MiB chunks.
//! Signing, when configured, runs on the plaintext BEFORE encryption — and ONLY
//! on `.glb` (SOL #2): an AASX or a JSON index is no GLB container.
//!
//! Library projects (plan-778 F15): the project's libraries ship TRIMMED under
//! `p/libraries/<projectId>/` (`trimProjectLibraries`, the same step the
//! customer staging runs), found by id through `librarySources`
//! (`{ projectsDir, libraries }` = `--projects-dir` / `--library <id>=<folder>`)
//! or the project's own `libraries/`; an unresolvable one throws (exit 1). The
//! realvirtual library is never trimmed: the build's app-level `library/` is
//! published beside the runtime whenever the project needs it (lists it, places
//! from it, or carries a legacy id of it) — otherwise it stays out, as before.
//! Trimming runs BEFORE signing/encryption, so library GLBs get the same
//! treatment as the project's own; `stampCatalogHashes` re-stamps their rows.
//!
//! Returns the staging directory path. Does NOT build (caller builds first).
//! Caller is responsible for cleaning up the returned dir (try/finally). The
//! preflight report is handed to `onReport` when given.
/**
 * @param {{
 *   distDir: string,
 *   projectDir: string,
 *   encryption?: { password: string, fragmentSecret: Uint8Array, iterations?: number, chunkSize?: number } | null,
 *   signing?: { privateKey: import('node:crypto').KeyObject, customerCert?: object | null } | null,
 *   onReport?: (report: { copied: string[], denied: {rel:string,reason:string}[], symlinks: string[], oversized: string[], encrypted: string[], libraries: string[], realvirtualLibrary: boolean }) => void,
 *   librarySources?: { projectsDir?: string | null, libraries?: Record<string, string> } | null,
 *   onLog?: ((line: string) => void) | null,
 * }} opts
 * @returns {Promise<string>} staging directory path
 */
export async function stageHostedProject({ distDir, projectDir, encryption = null, signing = null, onReport = null, librarySources = null, onLog = null }) {
  if (!existsSync(distDir)) {
    throw new Error(`dist/ not found: ${distDir}`);
  }
  const project = loadProject(projectDir);

  // Fresh atomic staging dir (R9).
  const stagingDir = mkdtempSync(join(tmpdir(), `realvirtual-hosted-${project.code}-`));

  // Runtime: dist/ root files flat, subdirectories EXCEPT the demo content
  // (models/, scenes/, library/ are the public demo's; a customer deploy must
  // not surface a generic realvirtual example), assets/ without .glb.
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      copyFileSync(join(distDir, entry.name), join(stagingDir, entry.name));
    }
  }
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name.toLowerCase();
    if (name === 'models' || name === 'scenes' || name === 'library') continue;
    if (name === HOSTED_PROJECT_PREFIX.replace('/', '')) continue; // never let a dist/p/ shadow the project
    const exclude = name === 'assets' ? new Set(['.glb']) : null;
    copyDirRecursive(join(distDir, entry.name), join(stagingDir, entry.name), exclude);
  }

  // The project, verbatim.
  const projectStage = join(stagingDir, HOSTED_PROJECT_PREFIX);
  const report = copyProjectVerbatim(projectDir, projectStage);
  report.encrypted = [];
  if (!existsSync(join(projectStage, 'project.json'))) {
    throw new Error(`Hosted staging of ${basename(projectDir)} lost project.json — the deny list must never remove it.`);
  }

  // plan-778 F15: the libraries it uses, trimmed, beside it under p/libraries/.
  // A failure removes the staging dir: the caller never received it.
  const appLibraryDir = join(distDir, 'library');
  let trim;
  try {
    trim = trimProjectLibraries(projectStage, {
      projectsDir: librarySources?.projectsDir ?? null,
      libraries: librarySources?.libraries ?? {},
      realvirtualLibraryDir: existsSync(join(appLibraryDir, 'project.json')) ? appLibraryDir : null,
      label: `project "${project.name}"`,
    }, { log: onLog });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  report.libraries = trim.shipped;
  report.realvirtualLibrary = trim.plan.realvirtualLibraryUsed && existsSync(appLibraryDir);
  if (trim.plan.realvirtualLibraryUsed && !existsSync(appLibraryDir)) {
    onLog?.('[libraries] WARNING: the project needs the realvirtual library but dist/library is missing - '
      + 'run "npm run build" (or build:library) first; the hosted copy would ship without it.');
  }
  // The realvirtual library is app-level and untrimmed (N2): published only for a
  // project that needs it, so a project without it keeps the plan-759 layout.
  if (report.realvirtualLibrary) copyDirRecursive(appLibraryDir, join(stagingDir, 'library'));

  // Provenance order is security-sensitive: sign the finished plaintext GLB
  // first, then wrap those signed bytes in the optional RVE1 envelope.
  let probe = null;
  const salt = encryption ? randomBytes(16) : null;
  for (const rel of encryptablePathsBelow(projectStage)) {
    const isGlb = extname(rel).toLowerCase() === '.glb';
    // Without a password only the GLBs are touched (signing); AASX stay as they are.
    if (!isGlb && !encryption) continue;
    const abs = join(projectStage, rel);
    const plain = readFileSync(abs);
    const signedPlain = signing && isGlb ? signGlbBytes(plain, signing) : plain;
    if (encryption) {
      const cipher = await encryptGlb(signedPlain, encryption.password, encryption.fragmentSecret, {
        salt,
        iterations: encryption.iterations,
        chunkSize: encryption.chunkSize ?? DEFAULT_CHUNK_SIZE,
        hkdfInfo: rel,
      });
      writeFileSync(abs, cipher);
      report.encrypted.push(rel);
    } else if (signing && isGlb) {
      writeFileSync(abs, signedPlain);
    }
  }
  if (encryption) {
    probe = await makeKeyProbe(encryption.password, encryption.fragmentSecret, { salt, iterations: encryption.iterations });
  }

  writeFileSync(
    join(stagingDir, 'settings.json'),
    generateHostedSettings({
      encryption: encryption ? { probe } : null,
      projectSettings: readProjectSettingsFile(projectDir),
    }),
  );

  if (onReport) onReport(report);
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
//!
//! ## `keep` — the manifest as the curator (plan-726 Phase 3)
//!
//! `keep` is an explicit list of `models/` filenames taken from the deploy
//! manifest's `documents[]` (see `publicDemoModelAllowlist()`). When it is
//! given it REPLACES the prefix rule: the manifest is what says what the demo
//! contains, and a second curator that only agrees by coincidence is how
//! `DemoRobotIK.glb` came to be deleted by every public deploy — it is a demo
//! model, it is in the manifest, and it matches neither prefix.
//!
//! The prefix stays as the fallback for a dist/ with no manifest and as the
//! `RV_PUBLIC_MODEL_PREFIX` escape hatch, so the signature is additive: every
//! existing caller (and every existing test) that passes no `keep` keeps the
//! behaviour it had.
//! Folder name of the demo project inside a deploy root (plan-737).
//! Mirrors `DEMO_PROJECT_FOLDER` in `src/core/project/backends/bundled-backend.ts`;
//! `tests/bunny-deploy.node.test.ts` pins the two together.
export const PUBLIC_DEMO_FOLDER = 'demo-realvirtual';

//! `dist/demo-realvirtual` — the base every public-demo guard works from since
//! plan-737, and the only place the folder name is turned into a path.
export function publicDemoDir(distDir) {
  return join(distDir, PUBLIC_DEMO_FOLDER);
}

export function applyPublicModelAllowlist(
  distDir,
  { prefix = PUBLIC_MODEL_PREFIX, dryRun = false, keep = null } = {},
) {
  // ── Where the demo's models live (plan-737) ──────────────────────────
  //
  // They are the ROOT-LEVEL documents of `dist/demo-realvirtual/`, not
  // `dist/models/*.glb`. `models/` is still honoured — a deploy may carry one,
  // and a private deploy's staging writes exactly that shape — so the pass
  // prunes whichever of the two this dist actually has, with the demo folder
  // taking precedence. Without this the guard would find an empty `models/`,
  // keep nothing, and print "no model matches" on a perfectly good build.
  const demoDir = publicDemoDir(distDir);
  const modelsDir = existsSync(demoDir) ? demoDir : join(distDir, 'models');
  const kept = [];
  const dropped = [];
  const droppedAssets = [];
  if (!existsSync(modelsDir)) return { kept, dropped, droppedAssets };

  // Comma-separated prefix list; a filename matching ANY prefix is kept.
  const prefixes = String(prefix || PUBLIC_MODEL_PREFIX)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  // A manifest-derived list is authoritative and exact — never a prefix. Compared
  // case-INSENSITIVELY here only because this half runs against a filesystem
  // (Windows dev machines answer `readdir` with the on-disk case); the guard
  // downstream does the case-SENSITIVE comparison that the Linux CDN cares about.
  const explicit = Array.isArray(keep)
    ? new Set(keep.map((f) => String(f).trim().toLowerCase()).filter(Boolean))
    : null;
  const isKept = (name) => (explicit
    ? explicit.has(name.toLowerCase())
    : prefixes.some((pfx) => name.toLowerCase().startsWith(pfx)));

  // Step 1+2: prune top-level models/*.glb; subdirectories (incl. library/) skipped.
  for (const entry of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== '.glb') continue;
    if (isKept(entry.name)) {
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

  // ── Step 4 is GONE: `models.json` is not a second catalogue (plan-737) ──
  //
  // This used to rewrite `dist/models.json` to the kept filenames, so the model
  // selector listed exactly what shipped. It was already a duplicate of the
  // manifest — the same set, derived twice — and after the demo moved into its
  // own folder it became a WRONG duplicate: `main.ts` resolves a `models.json`
  // name to `<BASE_URL>models/<name>`, so every entry would have pointed at a
  // path the demo no longer uses and 404'd.
  //
  // The selector reads `demo-realvirtual/project.json` directly now (plan-737
  // Phase 2), which is the same rule as everywhere else — a document exists
  // because a `project.json` says so — and leaves exactly one curator instead
  // of two that agree only by coincidence. `models.json` survives as what it
  // always genuinely was: the file a PRIVATE deploy publishes about ITSELF
  // (`stagePrivateProject`) and the one `getRemoteBackend()` reads off a
  // foreign host. Neither is written here.

  return {
    kept: kept.sort(),
    dropped: dropped.sort(),
    droppedAssets: droppedAssets.sort(),
  };
}

// ─── Public deploy: the manifest as the curator (plan-726 Phase 3) ───────

//! The `models/` filenames the deploy manifest declares, or null when the root
//! has no readable `project.json`.
//!
//! Null and `[]` mean different things and the caller must keep them apart:
//! null is "this dist/ has no manifest, use the prefix rule", `[]` is "the
//! manifest declares no models", which is a manifest worth failing on rather
//! than silently reinterpreting.
//!
//! Only `models/<file>.glb` counts. `scenes/` is pruned by a separate pass
//! (`applyPublicScenePruning`) and `library/` is not a document surface here —
//! see `assertPublicDemoManifestSatisfied()` for the check that covers all of
//! them at once.
export function publicDemoModelAllowlist(distDir) {
  // The demo's own manifest, inside its own folder (plan-737). Falls back to a
  // root manifest so a dist/ in the pre-737 shape still answers — that is what
  // keeps `--no-build` re-runs over an old dist/ from silently pruning it bare.
  const demoDir = publicDemoDir(distDir);
  const manifest = readDeployManifest(existsSync(demoDir) ? demoDir : distDir);
  if (!manifest) return null;
  const documents = Array.isArray(manifest.documents) ? manifest.documents : [];
  const out = [];
  for (const doc of documents) {
    const raw = manifestDocumentPath(doc);
    if (!raw.toLowerCase().endsWith('.glb')) continue;
    const segments = raw.split('/');
    // ROOT-LEVEL of the demo folder is the shape the demo actually has, and
    // `models/<file>` stays accepted for a deploy that uses that layout. A
    // deeper path (notably `library/…`) is somebody else's surface — the
    // library is app-level and is neither curated nor pruned by this pass.
    if (segments.length === 1) out.push(segments[0]);
    else if (segments.length === 2 && segments[0].toLowerCase() === 'models') out.push(segments[1]);
  }
  return out;
}

//! Normalised, POSIX, leading-`./` and leading-`/` stripped path of a document row.
function manifestDocumentPath(doc) {
  const raw = doc && typeof doc.path === 'string' ? doc.path : '';
  return raw.replace(/\\/g, '/').replace(/^\.?\//, '');
}

//! THE public-demo deploy gate: every document the manifest names is actually in
//! `dist/` after all pruning has run (plan-726 F5).
//!
//! ## Why it exists
//!
//! The manifest is the boot SSOT of the demo — `settings.defaultModel` and the
//! document list both come from it — so a document it names that the deploy does
//! not ship is a 404 the visitor hits and nobody else sees. Before this, the only
//! curator was a filename prefix, and the two could not disagree because there
//! was only one of them.
//!
//! ## Three things it does deliberately
//!
//! - **models AND scenes.** `scenes/DemoPlanner.glb` is pruned by
//!   `applyPublicScenePruning()`, a completely separate, prefix-based pass. A
//!   guard hanging off the model allowlist would never have looked at the demo's
//!   fourth document at all.
//! - **Case-SENSITIVE.** The comparison is against the real names in `dist/`,
//!   byte for byte. A manifest that says `Models/Demo.glb` passes on a Windows
//!   dev machine and 404s on the Linux CDN, and a case-insensitive guard is a
//!   guard that lets exactly that through.
//! - **`library/` is skipped.** A manifest may subscribe to library assets that
//!   are staged by another step or not shipped at all; that is not this gate's
//!   question.
//!
//! Returns the list of offending paths; the caller decides to throw. Never
//! throws by itself, and a dist/ with no manifest is vacuously fine (`[]`).
export function publicDemoManifestMisses(distDir) {
  // Resolved against the DEMO FOLDER since plan-737 — the manifest's paths are
  // relative to the manifest, and the manifest moved. Checking them against
  // `dist/` would report every document as missing.
  const demoDir = publicDemoDir(distDir);
  const root = existsSync(demoDir) ? demoDir : distDir;
  const manifest = readDeployManifest(root);
  if (!manifest) return [];
  const documents = Array.isArray(manifest.documents) ? manifest.documents : [];
  const misses = [];
  for (const doc of documents) {
    const rel = manifestDocumentPath(doc);
    if (rel === '') continue;
    // EVERY document is checked now, not just `models/` and `scenes/`. That
    // narrowing existed because the demo's rows lived in those two folders; the
    // demo's rows are root-level in its own folder today, so the old rule
    // checked precisely nothing. `library/` stays exempt for its original
    // reason — it is an app-level subscription, staged by another step.
    // `libraries/` (plan-778) likewise: delivered library projects are checked by
    // the trim and by `validate-project`, against their own manifests.
    const top = rel.split('/')[0].toLowerCase();
    if (top === 'library' || top === DELIVERED_LIBRARIES_FOLDER) continue;
    if (!existsOnDiskExactly(root, rel)) misses.push(rel);
  }
  return misses;
}

//! `existsOnDiskExactly` lives in `lib/rv-fs.mjs` since plan-508 (the Vite 404
//! guard needs it too); re-exported here for the deploy callers and tests.
export { existsOnDiskExactly };

// ─── Public deploy: test-scene pruning ───────────────────────────────────

//! Prunes DEV-ONLY documents from a freshly built public `dist/` so they never
//! reach the public CDN (they stay in the repo and in the dev checkout's list).
//!
//! ## `devOnly` decides, the filename only catches strays (plan-731 2k)
//!
//! The rule used to be a FILENAME CONVENTION: anything under `dist/scenes/`
//! starting with "Test". Two things were wrong with it. It could not say "this
//! one is a fixture" about a file whose name does not start with Test — and it
//! could not be seen from the manifest at all, so no release gate could check
//! that it had done its job. `devOnly: true` on the `documents[]` row says it
//! once, in the place both the app and the gate read.
//!
//! So the passes are, in order:
//!
//!  1. **`dist/project.json`** — every document row with `devOnly: true` has its
//!     FILE deleted and its ROW removed from the shipped manifest. Wherever the
//!     file sits: the folder is a place, not a type (plan-716), and the fixture
//!     this rule exists for moved out of `scenes/` in plan-731 2a.
//!  2. **`dist/scenes/<prefix>*.{glb,scene.json}`** — the old filename rule, kept
//!     as a defensive FALLBACK for a `dist/` built from an older source tree
//!     whose manifest carries no `devOnly` at all. A pruner that silently stops
//!     pruning is how a test scene reaches the public CDN.
//!  3. **`dist/scenes/index.json`** — likewise: rewrite the legacy curated
//!     Examples manifest to drop what pass 2 deleted, so an old dist's Examples
//!     list never 404s. Our own builds ship no such file since plan-731 2g.
//!
//! Idempotent (safe to re-run on an already-pruned dist/, e.g. with --no-build).
//! In `dryRun` mode nothing is written/deleted — only the report is computed.
//! Returns { kept, dropped } — relative paths of the SHIPPED and PRUNED
//! documents, sorted. (Paths, not bare filenames, since a dev-only document is
//! no longer confined to one folder.)
export function applyPublicScenePruning(distDir, { prefix = PUBLIC_TEST_SCENE_PREFIX, dryRun = false } = {}) {
  const kept = [];
  const dropped = [];
  const pfx = String(prefix || PUBLIC_TEST_SCENE_PREFIX).toLowerCase();

  // ── Pass 1: the manifest's own dev-only rows ──────────────────────────
  //
  // Rooted at the DEMO FOLDER since plan-737, for both halves: the manifest is
  // read there, and `row.path` is resolved there. Rooting the delete at `dist/`
  // while reading the manifest from the folder would delete nothing and report
  // success — the exact silent-stop failure the pass-2 fallback below exists to
  // prevent, so it must not be reintroduced by the base path.
  const demoDir = publicDemoDir(distDir);
  const manifestRoot = existsSync(demoDir) ? demoDir : distDir;
  const manifestPath = join(manifestRoot, 'project.json');
  if (existsSync(manifestPath)) {
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
    const rows = manifest && Array.isArray(manifest.documents) ? manifest.documents : null;
    if (rows) {
      const survivors = [];
      for (const row of rows) {
        const path = row && typeof row === 'object' && typeof row.path === 'string'
          ? row.path : null;
        if (!path) { survivors.push(row); continue; }
        if (row.devOnly === true) {
          dropped.push(path);
          if (!dryRun) rmSync(join(manifestRoot, path), { force: true });
          // Its saved preview (plan-776 `.thumbnails/<id>.<hash8>.<ext>`) goes with it:
          // the row that pointed at it is leaving the shipped manifest.
          const thumb = typeof row.thumbnail === 'string' ? normalizePath(row.thumbnail) : '';
          if (!dryRun && /^\.thumbnails\/[^/]+\.(webp|png)$/i.test(thumb)) {
            rmSync(join(manifestRoot, thumb), { force: true });
          }
        } else {
          kept.push(path);
          survivors.push(row);
        }
      }
      if (!dryRun && survivors.length !== rows.length) {
        writeFileSync(
          manifestPath,
          JSON.stringify({ ...manifest, documents: survivors }, null, 2) + '\n',
        );
      }
    }
  }

  // ── Pass 2: the filename fallback, for a dist from an older source tree ──
  const scenesDir = join(distDir, 'scenes');
  if (existsSync(scenesDir)) {
    for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(glb|scene\.json)$/i.test(entry.name)) continue;
      const rel = `scenes/${entry.name}`;
      if (dropped.includes(rel) || kept.includes(rel)) continue;   // pass 1 ruled on it
      if (entry.name.toLowerCase().startsWith(pfx)) {
        dropped.push(rel);
        if (!dryRun) rmSync(join(scenesDir, entry.name), { force: true });
      } else {
        kept.push(rel);
      }
    }

    // ── Pass 3: the legacy curated index, matched by the same prefix ──────
    const indexPath = join(scenesDir, 'index.json');
    if (existsSync(indexPath)) {
      let arr = null;
      try { arr = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { arr = null; }
      if (Array.isArray(arr)) {
        const filtered = arr.filter((e) => {
          const f = e && typeof e === 'object' ? e.file : undefined;
          if (typeof f !== 'string') return true;
          return !(f.toLowerCase().startsWith(pfx) || dropped.includes(`scenes/${f}`));
        });
        if (!dryRun && filtered.length !== arr.length) {
          writeFileSync(indexPath, JSON.stringify(filtered, null, 2) + '\n');
        }
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

// ─── Library catalog integrity (plan-508) ────────────────────────────────

//! The probe path that must NEVER exist in a deploy — its only job is to be
//! missing, so the CDN's answer for a missing asset can be observed.
export const PROBE_MISSING_ASSET = 'library/__rv-probe-missing__.glb';

//! Every `catalog.json` under `rootDir`, as forward-slash rels.
export function findCatalogFiles(rootDir) {
  return collectLocalFiles(rootDir)
    .filter((f) => basename(f.rel).toLowerCase() === 'catalog.json')
    .map((f) => f.rel);
}

//! The deploy-relative path of an entry's binary (`glbUrl`, else `splatUrl`,
//! else — a library PROJECT document row, plan-778 — `path`), or null when the
//! url is not a relative file url (http(s), blob, data, root-absolute): such an
//! entry is not part of this deploy's upload set.
export function catalogEntryBinaryRel(catalogRel, entry) {
  const url = typeof entry?.glbUrl === 'string' && entry.glbUrl !== ''
    ? entry.glbUrl
    : (typeof entry?.splatUrl === 'string' && entry.splatUrl !== ''
      ? entry.splatUrl
      : (typeof entry?.path === 'string' ? entry.path : ''));
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('/')) return null;
  let decoded;
  try { decoded = decodeURIComponent(url.split(/[?#]/, 1)[0]); } catch { return null; }
  const dir = normalizePath(dirname(normalizePath(catalogRel)));
  const parts = [];
  for (const seg of `${dir === '.' ? '' : dir}/${decoded}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

//! The id of the realvirtual library project (plan-778): its `project.json` rows are
//! stamped like catalog entries. Customer projects are never touched here.
export const REALVIRTUAL_LIBRARY_PROJECT_ID = 'prj_realvirtual_library';

//! Every library `project.json` under `rootDir`, as forward-slash rels: the
//! realvirtual library's (id `prj_realvirtual_library`, plan-778 Phase 3) and every
//! delivered trimmed library `libraries/<id>/project.json` whose id is its folder
//! name (Phase 4 — signing/encryption changed its documents' bytes after the
//! trim copied the rows). A project's own `project.json` is never one of them.
export function findLibraryProjectFiles(rootDir) {
  return collectLocalFiles(rootDir)
    .filter((f) => basename(f.rel).toLowerCase() === 'project.json')
    .filter((f) => {
      let id;
      try { id = JSON.parse(readFileSync(join(rootDir, f.rel), 'utf8'))?.id; } catch { return false; }
      if (id === REALVIRTUAL_LIBRARY_PROJECT_ID) return true;
      const segments = f.rel.split('/');
      return segments.length >= 3
        && segments[segments.length - 3] === DELIVERED_LIBRARIES_FOLDER
        && segments[segments.length - 2] === id;
    })
    .map((f) => f.rel);
}

//! Re-stamps `sha256` + `sizeBytes` into every `catalog.json` under `rootDir`
//! from the bytes that are there NOW (plan-508 F2).
//!
//! Runs in the deploy AFTER `signGlbsInDirectory`: signing is size-preserving
//! but changes the bytes, and the hash must describe what the browser gets —
//! a catalog stamped before signing makes every signed library GLB a hash
//! mismatch. Entries whose file is absent keep what they had (a 404 is its own,
//! louder failure). The realvirtual library's `project.json` documents are
//! re-stamped the same way (plan-778). Returns
//! { catalogs, stamped, libraryProjects, projectRows }.
export function stampCatalogHashes(rootDir, { dryRun = false } = {}) {
  let catalogs = 0;
  let stamped = 0;
  let libraryProjects = 0;
  let projectRows = 0;
  for (const rel of findCatalogFiles(rootDir)) {
    const path = join(rootDir, rel);
    let catalog;
    try { catalog = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (!catalog || !Array.isArray(catalog.entries)) continue;
    catalogs++;
    for (const entry of catalog.entries) {
      const binRel = catalogEntryBinaryRel(rel, entry);
      if (!binRel || !existsSync(join(rootDir, binRel))) continue;
      const bytes = readFileSync(join(rootDir, binRel));
      entry.sha256 = sha256Buffer(bytes);
      entry.sizeBytes = bytes.byteLength;
      stamped++;
    }
    if (!dryRun) writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  }
  for (const rel of findLibraryProjectFiles(rootDir)) {
    const path = join(rootDir, rel);
    let project;
    try { project = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (!Array.isArray(project?.documents)) continue;
    libraryProjects++;
    for (const doc of project.documents) {
      const binRel = catalogEntryBinaryRel(rel, doc);
      if (!binRel || !existsSync(join(rootDir, binRel))) continue;
      const bytes = readFileSync(join(rootDir, binRel));
      doc.sha256 = sha256Buffer(bytes);
      doc.sizeBytes = bytes.byteLength;
      projectRows++;
    }
    if (!dryRun) writeFileSync(path, JSON.stringify(project, null, 2) + '\n', 'utf8');
  }
  return { catalogs, stamped, libraryProjects, projectRows };
}

//! The catalogued binaries of ONE local catalog whose hash differs from the
//! previously published catalog (plan-508 F2b), as `localDir`-relative rels.
//!
//! `remoteText` is the remote `catalog.json` body (string/Buffer) or null when
//! there is none — then EVERY catalogued binary counts as changed. An entry
//! without a local hash is never forced (nothing to compare). Matching is by
//! the entry's url, the one key both catalogs share.
export function catalogChangedBinaries(localDir, catalogRel, remoteText) {
  let local;
  try { local = JSON.parse(readFileSync(join(localDir, catalogRel), 'utf8')); } catch { return []; }
  const entries = Array.isArray(local?.entries) ? local.entries : (Array.isArray(local?.documents) ? local.documents : []);
  const keyOf = (e) => e?.glbUrl || e?.splatUrl || e?.path;
  let remoteByUrl = null;
  if (remoteText != null) {
    try {
      const remote = JSON.parse(String(remoteText));
      remoteByUrl = new Map();
      for (const e of Array.isArray(remote?.entries) ? remote.entries : (Array.isArray(remote?.documents) ? remote.documents : [])) {
        const key = keyOf(e);
        if (key) remoteByUrl.set(key, e.sha256 ?? null);
      }
    } catch { remoteByUrl = null; }
  }
  const changed = [];
  for (const e of entries) {
    const binRel = catalogEntryBinaryRel(catalogRel, e);
    if (!binRel || typeof e.sha256 !== 'string') continue;
    const before = remoteByUrl?.get(keyOf(e));
    if (remoteByUrl === null || before !== e.sha256) changed.push(binRel);
  }
  return changed;
}

//! Post-deploy probe (plan-508 F8): proves on the LIVE host that
//!  1. a missing asset is a 404 (no SPA fallback, no global
//!     "404 -> index.html, rewrite to 200" edge rule). The STATUS is the
//!     contract, not the content type: Bunny answers every missing file with
//!     its standard `text/html` error page (observed on the live pull zone
//!     2026-09-27), and a 404 is never stored as an asset by the viewer. Only
//!     a 200 (any type) or another non-404 status is a finding,
//!  2. the library manifest — `library/project.json` since plan-778 Phase 4 (the
//!     bundled `catalog.json` is gone) — is served, is JSON and is BYTE-EQUAL to
//!     the one in `distDir` (catches a size-skipped or edge-cached manifest),
//!  3. the first listed asset (`documents[]` row, or `entries[]` of a catalog
//!     passed as `catalogRel`) is served as a binary and its bytes hash to the
//!     manifest `sha256` (catches a size-preserving re-sign not stamped).
//! `baseUrl` ends with `/` (e.g. `https://web.realvirtual.io/demo/`). The
//! catalog and asset GETs carry an `rv-probe` query so a stale edge copy cannot
//! answer for them. Returns { ok, findings[], checks[] }; never throws.
export async function probePublishedAssets({
  baseUrl,
  distDir,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  catalogRel = 'library/project.json',
  now = Date.now,
}) {
  const base = String(baseUrl).endsWith('/') ? String(baseUrl) : `${baseUrl}/`;
  const findings = [];
  const checks = [];
  const get = async (rel) => {
    try {
      return await fetchImpl(base + rel, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    } catch (ex) {
      return { error: ex?.message ?? String(ex) };
    }
  };
  const bust = `?rv-probe=${now()}`;
  const done = () => ({ ok: findings.length === 0, findings, checks });

  if (existsSync(join(distDir, PROBE_MISSING_ASSET))) {
    findings.push(`${PROBE_MISSING_ASSET} exists in the build output — the probe path must never be deployed`);
  }

  // 1 — the missing asset.
  const missing = await get(PROBE_MISSING_ASSET);
  if (missing.error) {
    findings.push(`GET ${PROBE_MISSING_ASSET} failed: ${missing.error}`);
  } else {
    const type = missing.headers?.get?.('content-type') ?? '';
    if (missing.status === 200) {
      findings.push(`GET ${PROBE_MISSING_ASSET} answered HTTP 200 (${type || 'no content-type'}) — `
        + 'a missing asset answered 200 — the host serves a fallback page instead of 404; '
        + 'check the pull zone for a global "404 -> index.html, rewrite to 200" edge rule');
    } else if (missing.status !== 404) {
      findings.push(`GET ${PROBE_MISSING_ASSET} answered HTTP ${missing.status} (${type || 'no content-type'}) — `
        + 'a missing asset must be a 404');
    } else if (/text\/html/i.test(type)) {
      // Bunny's standard error page — accepted, the status is what counts.
      checks.push(`${PROBE_MISSING_ASSET} -> 404 (text/html error page, accepted)`);
    } else {
      checks.push(`${PROBE_MISSING_ASSET} -> 404${type ? ` ${type}` : ''}`);
    }
  }

  // 2 — the library manifest, byte for byte.
  const localCatalogPath = join(distDir, catalogRel);
  if (!existsSync(localCatalogPath)) {
    checks.push(`${catalogRel}: not in the build output — catalog checks skipped`);
    return done();
  }
  const localBytes = readFileSync(localCatalogPath);
  const remoteCatalog = await get(catalogRel + bust);
  if (remoteCatalog.error) {
    findings.push(`GET ${catalogRel} failed: ${remoteCatalog.error}`);
  } else if (remoteCatalog.status !== 200) {
    findings.push(`GET ${catalogRel} answered HTTP ${remoteCatalog.status}`);
  } else {
    const remoteBytes = Buffer.from(await remoteCatalog.arrayBuffer());
    let isJson = true;
    try { JSON.parse(remoteBytes.toString('utf8')); } catch { isJson = false; }
    if (!isJson) {
      findings.push(`${catalogRel} on the host is not JSON (content-type ${remoteCatalog.headers?.get?.('content-type') ?? '?'})`);
    } else if (!remoteBytes.equals(localBytes)) {
      findings.push(`${catalogRel} on the host differs from the build output (${remoteBytes.length} vs ${localBytes.length} bytes) — `
        + 'a size-skipped upload or a stale edge copy; browsers would verify against the old hashes');
    } else {
      checks.push(`${catalogRel} -> 200, byte-equal to dist`);
    }
  }
  let catalog = null;
  try { catalog = JSON.parse(localBytes.toString('utf8')); } catch { catalog = null; }

  // 3 — the first listed asset, hashed (project rows or catalog entries).
  const entries = Array.isArray(catalog?.documents) ? catalog.documents
    : (Array.isArray(catalog?.entries) ? catalog.entries : []);
  const first = entries.find((e) => catalogEntryBinaryRel(catalogRel, e) !== null);
  if (!first) {
    checks.push(`${catalogRel}: no relative asset entry — asset check skipped`);
    return done();
  }
  const assetRel = catalogEntryBinaryRel(catalogRel, first);
  const encodedRel = assetRel.split('/').map((s) => encodeURIComponent(s)).join('/');
  const asset = await get(encodedRel + bust);
  if (asset.error) {
    findings.push(`GET ${assetRel} failed: ${asset.error}`);
  } else if (asset.status !== 200) {
    findings.push(`GET ${assetRel} answered HTTP ${asset.status}`);
  } else {
    const type = (asset.headers?.get?.('content-type') ?? '').toLowerCase();
    const bytes = Buffer.from(await asset.arrayBuffer());
    if (!/^(model\/gltf-binary|application\/octet-stream)\b/.test(type)) {
      findings.push(`GET ${assetRel} answered content-type "${type || 'none'}" — expected model/gltf-binary or application/octet-stream`);
    }
    if (typeof first.sha256 === 'string') {
      const got = sha256Buffer(bytes);
      if (got !== first.sha256) {
        findings.push(`${assetRel}: served bytes hash to ${got.slice(0, 12)}…, the catalog says ${first.sha256.slice(0, 12)}… `
          + `(${bytes.length} bytes) — every browser load would fail with "hash mismatch"`);
      } else {
        checks.push(`${assetRel} -> 200 ${type}, sha256 matches the catalog`);
      }
    } else if (typeof first.sizeBytes === 'number' && first.sizeBytes !== bytes.length) {
      findings.push(`${assetRel}: served ${bytes.length} bytes, the catalog says ${first.sizeBytes}`);
    } else {
      checks.push(`${assetRel} -> 200 ${type} (catalog carries no hash)`);
    }
  }
  return done();
}

// ─── Upload bookkeeping shared with the delivered partner CLI (plan-604) ─
//
// These three used to live in `bunny-deploy.mjs`. They moved here because the
// delivered partner CLI (`publish-project.mjs`) needs exactly them and must NOT
// import `bunny-deploy.mjs`: that module carries the customer register, the demo
// allowlist, the publish lock and the smoke runner — internal machinery that has no
// place in a partner workspace. `bunny-deploy.mjs` re-exports all three, so every
// caller, test and parity comment that names them at the old address still resolves.

//! Is `rel` a library catalog? The default `deferUntilLast` predicate (plan-508 F2b).
export function isCatalogFile(rel) {
  // `library/project.json` (plan-778) is the same kind of file: the hashes of the binaries beside it —
  // and so is a delivered trimmed library's `libraries/<id>/project.json` (Phase 4).
  return /(^|\/)(catalog\.json|library\/project\.json|libraries\/[^/]+\/project\.json)$/i.test(String(rel).replace(/\\/g, '/'));
}

//! What a hosted publish leaves on the CDN: exactly the staging listing (plan-759 F9).
//! Deriving this from the staged tree — not from a second walk of the project with its
//! own deny rule — is what keeps the reconciler from deleting a file the upload just wrote.
export function expectedHostedSnapshot(stagingDir) {
  return new Set(collectLocalFiles(stagingDir).map((file) => file.rel.replace(/\\/g, '/').toLowerCase()));
}

//! Deletes every remote file that is absent from the validated local snapshot manifest.
export async function reconcileRemoteSnapshot(client, remotePrefix, expectedPaths) {
  const entries = await client.listRecursive(remotePrefix);
  const prefix = remotePrefix.replace(/^\/+|\/+$/g, '');
  let deleted = 0;
  for (const entry of entries) {
    if (expectedPaths.has(entry.rel.replace(/\\/g, '/').toLowerCase())) continue;
    await client.deleteFile(prefix ? `${prefix}/${entry.rel}` : entry.rel);
    deleted++;
  }
  return deleted;
}
