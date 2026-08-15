// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bunny-deploy.mjs — Unity-independent, CI-capable Bunny CDN deploy CLI for the
 * realvirtual WebViewer. Builds the Vite app, then diff-uploads dist/ (+ project
 * GLBs) to Bunny CDN Edge Storage — public demo or a private customer project.
 *
 * Behavior is a 1:1 parity port of the Unity C# tooling (BunnyCdnUploader.cs +
 * WebViewerToolbar.cs); the reusable logic lives in `_bunny-lib.mjs`. The GLB
 * export itself stays Unity-bound — this tool deploys existing builds + models.
 *
 * Credentials come exclusively from env (no EditorPrefs, no hardcoded secret).
 * See `.env.example`. Exit code: 0 = OK, 1 = error.
 *
 * Three forms, two axes — WHICH CODE is compiled in, and WHICH CONTENT ships with it:
 *
 *   form        code tier                      content                     target
 *   ----------  -----------------------------  --------------------------  -------------
 *   (default)   core only (AGPL, stubs)        public demo (scenes, lib)   {path}/
 *   --demo      commercial (all 15 features)   public demo (scenes, lib)   {path}/
 *   --private   commercial + customer project  customer project only       {code}/
 *
 * `--demo` is the hosted demo of the full commercial product (ADR-047): the private
 * TypeScript is compiled in and never published — chunks yes, sources and `.map` no. It is
 * the public form in every other respect: same remote prefix, same model allowlist, same
 * scene pruning, same SEO/GA/news injection, same GLB signing.
 *
 * Usage:
 *   node scripts/bunny-deploy.mjs                          # public deploy (build + upload)
 *   node scripts/bunny-deploy.mjs --path demo              # public, custom remote prefix
 *   node scripts/bunny-deploy.mjs --demo --path demo --base /demo/   # commercial demo
 *   node scripts/bunny-deploy.mjs --private --project "Kunde XY"
 *   node scripts/bunny-deploy.mjs --private --list         # list private projects
 *   node scripts/bunny-deploy.mjs --force                  # skip diff, upload all
 *   node scripts/bunny-deploy.mjs --dry-run                # log only, no build/upload
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  BunnyClient,
  collectLocalFiles,
  buildRemoteIndex,
  selectFilesToUpload,
  stagePrivateProject,
  discoverPrivateProjects,
  loadProject,
  sanitizeDemoName,
  applyPublicModelAllowlist,
  assertNoDevArtifacts,
  PUBLIC_MODEL_PREFIX,
  applyPublicScenePruning,
  PUBLIC_TEST_SCENE_PREFIX,
  injectSeoTags,
  injectNoindex,
  writeSeoArtifacts,
  PUBLIC_BASE_URL,
  SEO_CANONICAL_PATH,
  injectNewsIntoSettings,
} from './_bunny-lib.mjs';
import { generateFragmentSecret, bytesToBase64Url, base64UrlToBytes } from './lib/rv-crypto.mjs';
import { loadSigningConfig, signGlbFile } from './rv-sign-glb.mjs';
import {
  assertBuildProvenance,
  assertNoCrossTierLeak,
  loadDeliveryConfig,
  runBuild as runFilteredBuild,
  stageFilteredSourceTree,
} from './_workspace-lib.mjs';
import { assertValidProject } from './validate-project.mjs';
import { isDeniedProjectArtifactPath, isProjectAssetSkipDir } from './_rv-guards.mjs';
import { recordPublishProvenance } from './_rv-provenance.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

//! Load credentials from a gitignored .env file into process.env (dependency-free).
//! CI / real shell env wins — we only fill keys that aren't already set. Vite
//! auto-loads .env.production for the BUILD, but this plain Node script does not,
//! so without this `npm run deploy` can't see BUNNY_* locally. Mirrors .env.example.
function loadDotEnv() {
  for (const name of ['.env.production', '.env']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
    }
  }
}

// ─── CLI args (parity with webtest.mjs getArg/hasFlag) ───────────────────

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  if (idx + 1 < args.length && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return defaultVal;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

// ─── ANSI colors ─────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

function log(msg) { console.log(msg); }
function info(label, value) { console.log(`  ${CYAN}${label.padEnd(10)}${RESET}: ${value}`); }

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reject a `--base` that was mangled by MSYS path conversion BEFORE anything is
 * built or uploaded. Git Bash rewrites a standalone `/demo/` argument into
 * `C:/Program Files/Git/demo/`; the build then bakes that Windows path into
 * index.html, build and upload report success, and the live site 404s on every
 * asset. A valid base is relative (`./`) or a simple absolute URL path like
 * `/demo/` — never something with a drive letter, backslash or spaces.
 */
function assertSaneBase(base) {
  if (base == null) return;
  if (/^\.?\/(?:[\w.-]+(?:\/[\w.-]+)*\/?)?$/.test(base)) return;
  throw new Error(
    `--base "${base}" is not a valid URL base path. `
    + 'This is the MSYS/Git-Bash path mangling: a leading "/" argument was rewritten into a '
    + 'Windows path. Run the deploy from PowerShell, or prefix the Bash command with '
    + 'MSYS_NO_PATHCONV=1.',
  );
}

// ─── Build ───────────────────────────────────────────────────────────────

//! The staging profile of the `--demo` form: the FULL commercial tier and nothing beyond it.
//! `restrictedFeatures: []` is the load-bearing half — agents and omniverse are restricted, so
//! an empty entitlement list is what keeps them (and the whole internal tier) out of a
//! publicly hosted build. It is exactly the profile a commercial customer without extras
//! receives, which is the point: the demo shows what a customer gets.
const DEMO_PROFILE = Object.freeze({ tier: 'commercial', restrictedFeatures: [] });

export function stageAndBuild({ mode, projectDir = null, base = null, dryRun = false }) {
  const demo = mode === 'demo';
  const privateRoot = projectDir ? dirname(dirname(projectDir)) : join(ROOT, '..', 'realvirtual-WebViewer-Private~');
  const projectKey = projectDir ? projectDir.split(/[\\/]/).filter(Boolean).pop() : null;
  const delivery = projectKey ? loadDeliveryConfig(privateRoot, projectKey) : null;
  const profile = demo ? DEMO_PROFILE : (delivery ?? { tier: 'core', restrictedFeatures: [] });
  const staged = stageFilteredSourceTree({
    coreRoot: ROOT,
    privateRoot,
    projectKey,
    delivery,
    profile,
    // The two things that make this the DEMO staging rather than a customer delivery:
    // the public demo content stays (a commercial tier would otherwise drop it), and no
    // customer workspace is generated (there is no customer, and no delivery config to
    // generate one from).
    ...(demo ? { includePublicDemoContent: true, workspaceFiles: false } : {}),
  });
  // The staged private tree is what gets compiled, so this is the check that the internal
  // tier never entered the demo build in the first place — before Vite, before any upload.
  if (demo) assertNoCrossTierLeak(staged.workspaceRoot, staged.manifest, profile);
  const build = runFilteredBuild(staged.workspaceRoot, { mode, base, dryRun, projectKey });
  if (!dryRun) assertBuildProvenance(build.distDir, { mode, projectKey });
  return { ...staged, ...build };
}

//! Refuses to publish a build output that carries source code: any `.map` (a sourcemap next
//! to a commercial chunk IS the private TypeScript) or any `.ts`/`.tsx` that a copied
//! `public/` folder dragged along.
//!
//! Three independent layers already point the same way — `sourcemap: false` in vite.config.ts,
//! the `delete env.RV_SOURCEMAP` in the demo build env, and the `.map` skip in
//! collectLocalFiles — and that is the reason this one exists: it is the only one that FAILS
//! instead of silently doing the right thing, so a regression in any of the three is loud.
function assertNoPublishableSource(distDir) {
  const offenders = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (/\.(?:map|ts|tsx|mts|cts)$/i.test(entry.name)) offenders.push(rel);
    }
  };
  walk(distDir, '');
  if (offenders.length) {
    throw new Error(
      `Refusing to deploy: ${offenders.length} source artifact(s) in ${distDir} — `
      + `${offenders.slice(0, 10).join(', ')}${offenders.length > 10 ? ', …' : ''}. `
      + 'A .map next to a commercial chunk is the private source code itself. '
      + 'Rebuild without RV_SOURCEMAP=1.',
    );
  }
}

function signGlbsInDirectory(rootDir, signing) {
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.glb') {
        signGlbFile(path, signing);
        count++;
      }
    }
  };
  walk(rootDir);
  return count;
}

// ─── Shared upload routine ───────────────────────────────────────────────

//! Diff-uploads all files from `localDir` to `{remotePrefix}/...`. Returns
//! { uploaded, skipped }. Atomic ordering: every non-index.html file first,
//! index.html files last (R10), so the CDN never points new HTML at missing
//! assets.
export async function uploadDirectory(client, localDir, remotePrefix, {
  force, dryRun, alwaysUploadGlbs, preserveRemotePrefixes = [],
}) {
  const local = collectLocalFiles(localDir);
  if (local.length === 0) {
    throw new Error(`No files to upload in ${localDir}`);
  }

  log(`${DIM}Fetching remote file list for diff/reconcile...${RESET}`);
  const entries = await client.listRecursive(remotePrefix);
  let remoteIndex = null;
  if (!force) {
    remoteIndex = buildRemoteIndex(entries);
    info('diff', `${remoteIndex.size} remote files indexed`);
  }

  const selected = selectFilesToUpload(local, remoteIndex, { force, alwaysUploadGlbs });
  const skipped = local.length - selected.length;

  // Atomic ordering: assets first, index.html last.
  const isIndexHtml = (rel) => /(^|\/)index\.html$/i.test(rel);
  selected.sort((a, b) => Number(isIndexHtml(a.rel)) - Number(isIndexHtml(b.rel)));

  const prefix = (remotePrefix || '').replace(/^\/+|\/+$/g, '');
  let uploaded = 0;
  for (const f of selected) {
    const remotePath = prefix ? `${prefix}/${f.rel}` : f.rel;
    const always = /\.html$/i.test(f.rel) || /(^|\/)(settings|models|manifest)\.json$/i.test(f.rel);
    const tag = always ? `${MAGENTA}(always)${RESET}` : '';
    log(`  ${GREEN}↑${RESET} ${f.rel} ${tag} ${DIM}${humanSize(f.size)}${RESET}`);
    try {
      await client.putFile(readFileSync(f.abs), remotePath);
      uploaded++;
    } catch (ex) {
      throw new Error(
        `Failed to upload ${f.rel}: ${ex?.message ?? ex}\n` +
        `  (rerun without --force to resume via diff)`,
      );
    }
  }

  const localPaths = new Set(local.map((file) => file.rel.toLowerCase()));
  const stale = entries.filter((entry) => {
    const rel = entry.rel.replace(/\\/g, '/');
    return !localPaths.has(rel.toLowerCase())
      && !preserveRemotePrefixes.some((prefix) => rel.startsWith(prefix));
  });
  for (const entry of stale) {
    const remotePath = prefix ? `${prefix}/${entry.rel}` : entry.rel;
    log(`  ${RED}-${RESET} ${entry.rel} ${DIM}(stale)${RESET}`);
    await client.deleteFile(remotePath);
  }

  if (skipped > 0) log(`  ${DIM}= ${skipped} unchanged (skipped)${RESET}`);
  return { uploaded, skipped, deleted: stale.length };
}

// ─── Public deploy ───────────────────────────────────────────────────────

async function deployPublic(cfg, opts) {
  const remotePrefix = opts.path ?? cfg.remotePath;
  // `--demo` swaps the code tier and nothing else: same prefix, same content pipeline below.
  const mode = opts.demo ? 'demo' : 'public';
  const filtered = stageAndBuild({ mode, base: opts.base, dryRun: opts.dryRun });
  const distDir = filtered.distDir;
  if (opts.dryRun) {
    log(`${DIM}[dry-run] filtered ${mode} source staged; no build/upload performed${RESET}`);
    rmSync(filtered.workspaceRoot, { recursive: true, force: true });
    return;
  }
  if (!existsSync(distDir)) throw new Error(`Filtered build output not found: ${distDir}`);
  assertNoDevArtifacts(distDir);
  assertNoPublishableSource(distDir);

  // The DemoRealvirtual content is bundled: it lives in `public/` (models/,
  // scenes/, library/), so Vite has already copied it into dist/ as part of the
  // build. Nothing to stage here — the allowlist and scene pruning below run
  // over what the build produced.

  // Model allowlist: the public CDN must ship ONLY the official demo models
  // (prefix DemoRealvirtual*) plus the planner library — prune test/helper/stray
  // GLBs (and their hashed assets/ duplicates) before upload, and rewrite
  // models.json so the selector lists exactly what is shipped.
  const modelPrefix = (process.env.RV_PUBLIC_MODEL_PREFIX || PUBLIC_MODEL_PREFIX).trim() || PUBLIC_MODEL_PREFIX;
  const allow = applyPublicModelAllowlist(distDir, { prefix: modelPrefix, dryRun: opts.dryRun });
  log(`${DIM}Public model allowlist (prefix "${modelPrefix}*"): `
    + `${allow.kept.length} kept, ${allow.dropped.length} pruned`
    + `${allow.droppedAssets.length ? ` (+${allow.droppedAssets.length} hashed)` : ''}${RESET}`);
  for (const f of allow.kept) log(`  ${GREEN}keep${RESET} models/${f}`);
  for (const f of allow.dropped) log(`  ${RED}prune${RESET} models/${f}`);
  if (allow.kept.length === 0) {
    log(`  ${RED}⚠ no model matches prefix "${modelPrefix}*" — the public selector will be empty${RESET}`);
  }

  // Test-scene guard: example scenes named "Test*" are repo/dev-only fixtures —
  // prune them (file + index.json entry) so they never ship to the public demo.
  const scenePrefix = (process.env.RV_PUBLIC_TEST_SCENE_PREFIX || PUBLIC_TEST_SCENE_PREFIX).trim() || PUBLIC_TEST_SCENE_PREFIX;
  const scenes = applyPublicScenePruning(distDir, { prefix: scenePrefix, dryRun: opts.dryRun });
  if (scenes.dropped.length) {
    log(`${DIM}Public scene pruning (prefix "${scenePrefix}*"): `
      + `${scenes.kept.length} kept, ${scenes.dropped.length} pruned${RESET}`);
    for (const f of scenes.dropped) log(`  ${RED}prune${RESET} scenes/${f}`);
  }

  // Sign only the final public artifact set, after all allowlist/pruning
  // mutations. Re-signing is deliberately size-preserving, so signed GLBs
  // must bypass the CDN's size-only diff.
  const signing = loadSigningConfig();
  if (signing) {
    const signedCount = signGlbsInDirectory(distDir, signing);
    log(`${DIM}GLB provenance: signed ${signedCount} public GLB file(s)${RESET}`);
  } else {
    log(`${DIM}GLB provenance: RV_SIGN_PRIVATE_KEY not configured; models remain unsigned${RESET}`);
  }

  // GA injection (R2): inject only into the deployed settings.json, never commit it.
  injectGaIntoSettings(join(distDir, 'settings.json'), cfg.googleAnalyticsId, opts.dryRun);
  // News injection: public-hosted artifact only; private/customer paths stay fail-closed.
  injectNewsIntoSettings(join(distDir, 'settings.json'), cfg.newsApiUrl, opts.dryRun);

  // SEO artifacts: only the canonical public path (default "demo") is indexable —
  // it gets canonical/OG URL tags + sitemap.xml + robots.txt. Every other
  // non-root public prefix (e.g. "dev") is noindexed so it never shadows the
  // canonical demo in search results. RV_SEO=0 disables all of this.
  const seo = resolveSeo(remotePrefix);
  if (seo.mode === 'canonical') {
    injectSeoTags(distDir, { pageUrl: seo.pageUrl, dryRun: opts.dryRun });
    seo.robots = writeSeoArtifacts(distDir, { pageUrl: seo.pageUrl, dryRun: opts.dryRun }).robots;
    log(`${DIM}SEO: canonical ${seo.pageUrl} + sitemap.xml + robots.txt${opts.dryRun ? ' [dry-run]' : ''}${RESET}`);
  } else if (seo.mode === 'noindex') {
    injectNoindex(join(distDir, 'index.html'), { dryRun: opts.dryRun });
    log(`${DIM}SEO: noindex injected (non-canonical public path "${seo.prefix}" — canonical is "${seo.canonicalPath}")${RESET}`);
  }

  log('');
  log(`${MAGENTA}realvirtual WebViewer · Bunny Deploy${RESET}`);
  info('mode', opts.demo ? 'demo  (commercial code · public demo content)' : 'public');
  info('zone', `${cfg.storageZone}  region ${cfg.region}`);
  info('remote', `${remotePrefix || '(root)'}/`);

  const client = new BunnyClient({
    region: cfg.region, zone: cfg.storageZone, storageKey: cfg.storageKey,
    accountKey: cfg.accountKey, pullZoneId: cfg.pullZoneId, dryRun: opts.dryRun, log,
  });

  const { uploaded, skipped } = await uploadDirectory(client, distDir, remotePrefix, {
    ...opts,
    alwaysUploadGlbs: !!signing,
  });

  // Crawlers only honor /robots.txt at the DOMAIN ROOT — when the canonical
  // deploy lives under a sub-path (demo/), a root copy referencing the absolute
  // sitemap URL must exist too. The dist/ copy under the sub-path is harmless.
  if (seo.mode === 'canonical' && seo.prefix && seo.robots) {
    log(`  ${GREEN}↑${RESET} robots.txt ${MAGENTA}(zone root)${RESET}`);
    await client.putFile(Buffer.from(seo.robots, 'utf8'), 'robots.txt');
  }

  await maybePurge(client, uploaded, opts);
  info('done', `${uploaded} uploaded, ${skipped} unchanged`);
  rmSync(filtered.workspaceRoot, { recursive: true, force: true });
}

//! Resolves the SEO treatment for a public deploy from env + remote prefix:
//! { mode: 'canonical' | 'noindex' | 'off', pageUrl?, prefix, canonicalPath }.
//! Root deploys ('' prefix, e.g. forks publishing at their zone root) are left
//! untouched unless RV_SEO_CANONICAL_PATH is explicitly set to ''.
function resolveSeo(remotePrefix) {
  const prefix = (remotePrefix || '').replace(/^\/+|\/+$/g, '');
  const canonicalPath = (process.env.RV_SEO_CANONICAL_PATH ?? SEO_CANONICAL_PATH)
    .replace(/^\/+|\/+$/g, '');
  if ((process.env.RV_SEO || '').trim() === '0') {
    return { mode: 'off', prefix, canonicalPath };
  }
  if (prefix === canonicalPath) {
    const host = (process.env.RV_PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, '');
    const pageUrl = prefix ? `${host}/${prefix}/` : `${host}/`;
    return { mode: 'canonical', pageUrl, prefix, canonicalPath };
  }
  if (prefix) {
    return { mode: 'noindex', prefix, canonicalPath };
  }
  return { mode: 'off', prefix, canonicalPath };
}

// ─── Private deploy ──────────────────────────────────────────────────────

async function deployPrivate(cfg, opts) {
  const projectsDir = opts.projectsDir;
  if (!projectsDir) {
    throw new Error('Private deploy requires --projects-dir <dir> (or BUNNY_PRIVATE_PROJECTS_DIR env)');
  }

  if (opts.list) {
    listPrivateProjects(projectsDir);
    return;
  }
  if (!opts.project) {
    throw new Error('Private deploy requires --project <name> (or --list to enumerate)');
  }

  const projectDir = resolvePrivateProjectDir(projectsDir, opts.project);
  // Mandatory gate before anything is built or uploaded (F10 / B12). A CDN
  // upload is not undoable: whatever reaches the pull zone stays there until the
  // next deploy, so a secret or a broken manifest has to be caught here rather
  // than noticed afterwards.
  assertValidProject(projectDir, `project "${opts.project}"`);
  const project = loadProject(projectDir); // validates code + name (R6)
  const filtered = stageAndBuild({ mode: 'private', projectDir, base: opts.base, dryRun: opts.dryRun });
  const filteredProjectDir = join(filtered.workspaceRoot, 'projects', requireFolderName(projectDir));
  opts.dist = filtered.distDir;
  if (!opts.dryRun && !existsSync(opts.dist)) throw new Error(`Filtered build output not found: ${opts.dist}`);
  if (!opts.dryRun) assertNoDevArtifacts(opts.dist);

  log('');
  log(`${MAGENTA}realvirtual WebViewer · Bunny Deploy${RESET}`);
  info('mode', `private  project "${project.name}" (code ${project.code.slice(0, 8)}…)`);
  info('zone', `${cfg.storageZone}  region ${cfg.region}`);
  info('remote', `${project.code}/`);

  const client = new BunnyClient({
    region: cfg.region, zone: cfg.storageZone, storageKey: cfg.storageKey,
    accountKey: cfg.accountKey, pullZoneId: cfg.pullZoneId, dryRun: opts.dryRun, log,
  });

  // plan-267: optional password protection. Password comes ONLY from env
  // (never a CLI arg — args land in process lists / shell history / logs).
  // The 32-byte fragment secret is generated per publish unless RV_DEPLOY_FRAGMENT
  // is supplied to keep an existing link stable across in-place re-publishes.
  let encryption = null;
  let fragmentB64 = null;
  const password = process.env.RV_DEPLOY_PASSWORD;
  if (password) {
    const fragEnv = process.env.RV_DEPLOY_FRAGMENT;
    const fragmentSecret = fragEnv ? base64UrlToBytes(fragEnv) : generateFragmentSecret();
    fragmentB64 = bytesToBase64Url(fragmentSecret);
    encryption = { password, fragmentSecret };
    info('encrypt', `AES-256-GCM · password protected${fragEnv ? ' · reusing fragment' : ''}`);
  }
  const signing = loadSigningConfig();
  if (signing) {
    info('sign', signing.customerCert ? `Ed25519 · customer ${signing.customerCert.org}` : 'Ed25519 · realvirtual root');
  } else {
    log(`${DIM}GLB provenance: RV_SIGN_PRIVATE_KEY not configured; models remain unsigned${RESET}`);
  }

  let totalUploaded = 0;
  let totalSkipped = 0;
  let stagingDir = null;
  try {
    if (opts.dryRun) {
      log(`${DIM}[dry-run] would stage project + upload to ${project.code}/${RESET}`);
    } else {
      stagingDir = await stagePrivateProject({
        distDir: opts.dist,
        projectDir: filteredProjectDir,
        encryption,
        signing,
      });
      info('staging', stagingDir);

      // Private customer deploys live on unguessable {code}/ URLs and must never
      // be indexed. A robots.txt below the domain root has no effect — the meta
      // tag is the mechanism that works at any path. (index.html stays plaintext
      // even in encrypted deploys; only GLBs are encrypted.)
      injectNoindex(join(stagingDir, 'index.html'));
      log(`${DIM}SEO: noindex injected (private deploy)${RESET}`);

      // Pass 1: app + models → {code}/
      // Encrypted GLBs must bypass the size diff: fresh salt/IVs give a new
      // ciphertext at identical size (see selectFilesToUpload).
      log(`${DIM}Pass 1/2: app + models${RESET}`);
      const p1 = await uploadDirectory(client, stagingDir, project.code, {
        ...opts,
        alwaysUploadGlbs: !!encryption || !!signing,
        preserveRemotePrefixes: ['private-assets/'],
      });
      totalUploaded += p1.uploaded;
      totalSkipped += p1.skipped;

      // Pass 2: project asset subfolders + root *.json → {code}/private-assets/{folder}/
      log(`${DIM}Pass 2/2: private assets${RESET}`);
      const p2 = await uploadPrivateAssets(client, filteredProjectDir, project, opts);
      totalUploaded += p2.uploaded;
      totalSkipped += p2.skipped;

      const expected = expectedPrivateSnapshot(stagingDir, filteredProjectDir, project);
      const deleted = await reconcileRemoteSnapshot(client, project.code, expected);
      if (deleted > 0) log(`${DIM}Remote reconcile removed ${deleted} stale private file(s).${RESET}`);

      // lastPublished only AFTER pass 2 (R9).
      writeLastPublished(projectDir, project);
    }
  } finally {
    if (stagingDir && existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (filtered.workspaceRoot && existsSync(filtered.workspaceRoot)) {
      try { rmSync(filtered.workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  await maybePurge(client, totalUploaded, opts);
  info('done', `${totalUploaded} uploaded, ${totalSkipped} unchanged`);
  if (encryption) {
    // The fragment secret is HALF the key — it must travel in the link. The
    // password is the other half; send it via a SEPARATE channel (never log it).
    info('url', `https://web.realvirtual.io/${project.code}/#k=${fragmentB64}`);
    log(`${DIM}Encrypted deploy: send the link and the password through separate channels.${RESET}`);
  } else {
    info('url', `https://web.realvirtual.io/${project.code}/`);
  }
}

//! Pass 2: uploads project asset subfolders (excluding build/system dirs) and
//! root-level *.json (except project.json) into {code}/private-assets/{folder}/.
// SOURCE: WebViewerToolbar.cs:1346 (skipDirs + private-assets) — keep in sync
async function uploadPrivateAssets(client, projectDir, project, opts) {
  // What may not be published lives in _rv-guards.mjs and nowhere else
  // (plan-700 §2.9 / B10). The list used to be duplicated here and in the
  // CONNECT stager, with a comment asking the two to be "kept in sync" — which
  // is the failure mode, not the fix. Do not reintroduce a local array.
  const folderName = project.folderName ?? requireFolderName(projectDir);
  let uploaded = 0;
  let skipped = 0;

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (isProjectAssetSkipDir(entry.name) || isDeniedProjectArtifactPath(entry.name)) continue;
      const remotePath = `${project.code}/private-assets/${folderName}/${entry.name}`;
      const r = await uploadDirectory(client, join(projectDir, entry.name), remotePath, opts);
      uploaded += r.uploaded;
      skipped += r.skipped;
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')
               && !isDeniedProjectArtifactPath(entry.name)) {
      const remotePath = `${project.code}/private-assets/${folderName}/${entry.name}`;
      log(`  ${GREEN}↑${RESET} ${entry.name} ${DIM}(asset)${RESET}`);
      if (!opts.dryRun) {
        await client.putFile(readFileSync(join(projectDir, entry.name)), remotePath);
      }
      uploaded++;
    }
  }
  return { uploaded, skipped };
}

function requireFolderName(projectDir) {
  return join(projectDir).split(/[\\/]/).filter(Boolean).pop();
}

//! Records this Bunny publish in the project manifest (plan-700 §2.8 / B15).
//! `lastPublished` used to be ONE field for all three targets, so this write
//! erased the record of the CONNECT embed every time. It is still written, as
//! a mirror of the most recent publish; the per-target truth now lives under
//! `provenance.lastPublishedBy['bunny-private']`.
function writeLastPublished(projectDir, project) {
  recordPublishProvenance(projectDir, 'bunny-private', {
    version: viewerVersion(),
    code: project?.code,
  });
}

//! The viewer version being published, from the WebViewer's own package.json.
//! Absent/unreadable is not a deploy failure — the provenance entry simply
//! carries no version rather than aborting an upload that already happened.
function viewerVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
}

function resolvePrivateProjectDir(projectsDir, projectName) {
  const all = discoverPrivateProjects(projectsDir);
  // Match by exact project name, then by sanitized folder name.
  const byName = all.find((p) => p.project.name === projectName);
  if (byName) return byName.projectDir;
  const sanitized = sanitizeDemoName(projectName);
  const byFolder = all.find((p) => p.folderName === sanitized || p.folderName === projectName);
  if (byFolder) return byFolder.projectDir;
  const direct = join(projectsDir, projectName);
  if (existsSync(join(direct, 'project.json'))) return direct;
  throw new Error(`Private project "${projectName}" not found under ${projectsDir}`);
}

function listPrivateProjects(projectsDir) {
  const all = discoverPrivateProjects(projectsDir);
  log('');
  log(`${MAGENTA}Private projects in ${projectsDir}${RESET}`);
  if (all.length === 0) {
    log(`  ${DIM}(none)${RESET}`);
    return;
  }
  for (const { project, folderName } of all) {
    const last = project.lastPublished ? project.lastPublished : 'never';
    log(`  ${folderName.padEnd(28)} ${DIM}code ${project.code.slice(0, 8)}…  published ${last}${RESET}`);
  }
}

// ─── GA injection + purge helpers ────────────────────────────────────────

//! Injects the GA4 id into a settings.json on disk (deployed artifact only).
//! Empty id → no-op (committed settings.json stays clean). R2 / O5.
function injectGaIntoSettings(settingsPath, gaId, dryRun) {
  if (!gaId) return;
  if (!existsSync(settingsPath)) return;
  if (dryRun) {
    log(`${DIM}[dry-run] would inject GA id into ${settingsPath}${RESET}`);
    return;
  }
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  s.analytics = s.analytics || {};
  s.analytics.googleAnalyticsId = gaId;
  writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  log(`${DIM}GA4 id injected into ${settingsPath}${RESET}`);
}

//! Purges the pull-zone cache once, but only if files were uploaded and purge
//! isn't suppressed (--no-purge). Mirrors C# (uploadedCount>0 + creds set).
async function maybePurge(client, uploadedCount, opts) {
  if (opts.noPurge) {
    info('purge', 'skipped (--no-purge)');
    return;
  }
  if (uploadedCount <= 0) {
    info('purge', 'skipped (nothing uploaded)');
    return;
  }
  const ok = await client.purge();
  info('purge', ok ? `${GREEN}✓${RESET}` : `${DIM}skipped${RESET}`);
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv(); // populate process.env from .env.production / .env (CI env still wins)
  if (hasFlag('no-build')) {
    throw new Error('--no-build is disabled: deploys must build from filtered staging.');
  }
  const opts = {
    private: hasFlag('private'),
    demo: hasFlag('demo'),
    project: getArg('project', null),
    list: hasFlag('list'),
    path: getArg('path', null),
    dist: getArg('dist', join(ROOT, 'dist')),
    projectsDir: getArg('projects-dir', process.env.BUNNY_PRIVATE_PROJECTS_DIR || null),
    base: getArg('base', null),
    force: hasFlag('force'),
    dryRun: hasFlag('dry-run'),
    noPurge: hasFlag('no-purge'),
  };
  assertSaneBase(opts.base);
  if (opts.private && opts.demo) {
    throw new Error('--demo and --private are different deploy forms: --demo publishes the '
      + 'commercial code on the PUBLIC demo content, --private publishes one customer project. '
      + 'Pick one.');
  }

  // --list does not need full credentials.
  if (opts.private && opts.list) {
    if (!opts.projectsDir) throw new Error('--list requires --projects-dir <dir>');
    listPrivateProjects(opts.projectsDir);
    return;
  }

  const cfg = loadConfig(process.env);

  if (opts.private) {
    await deployPrivate(cfg, opts);
  } else {
    await deployPublic(cfg, opts);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`${RED}Error:${RESET} ${e?.message ?? e}`);
    process.exit(1);
  });
}

function expectedPrivateSnapshot(stagingDir, projectDir, project) {
  const expected = new Set(collectLocalFiles(stagingDir).map((file) => file.rel.replace(/\\/g, '/').toLowerCase()));
  const folderName = project.folderName ?? requireFolderName(projectDir);
  const prefix = `private-assets/${folderName}/`;
  // This set decides what the reconciler DELETES from the CDN, so its selection
  // rule has to be the same one uploadPrivateAssets applies — a third copy of
  // the denylist here would delete exactly the files the upload just wrote. Both
  // read from _rv-guards.mjs for that reason.
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isDirectory() && !isProjectAssetSkipDir(entry.name) && !isDeniedProjectArtifactPath(entry.name)) {
      for (const file of collectLocalFiles(join(projectDir, entry.name))) {
        expected.add(`${prefix}${entry.name}/${file.rel}`.toLowerCase());
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')
        && !isDeniedProjectArtifactPath(entry.name)) {
      expected.add(`${prefix}${entry.name}`.toLowerCase());
    }
  }
  return expected;
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
