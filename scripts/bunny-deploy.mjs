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
 * See `.env.example`.
 *
 * Exit code (plan-503): 0 = deploy OK and demo smoke OK (or skipped), 1 = deploy error,
 * 3 = deploy OK — the build IS live — but the demo smoke FAILED (SmokeFailedError). A public
 * deploy runs `scripts/rv-demo-smoke.mjs` against the live target after the purge, inside the
 * publish lock; `--no-smoke` skips it, `--dry-run` and `--private` never run it.
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
 *   node scripts/bunny-deploy.mjs --path demo              # public, custom remote prefix
 *   node scripts/bunny-deploy.mjs --root                   # public deploy at the ZONE ROOT (explicit)
 *   node scripts/bunny-deploy.mjs --demo --path demo --base /demo/   # commercial demo
 *   node scripts/bunny-deploy.mjs --private --project "Kunde XY"
 *   node scripts/bunny-deploy.mjs --private --list         # list private projects
 *   node scripts/bunny-deploy.mjs --force                  # skip diff, upload all
 *   node scripts/bunny-deploy.mjs --dry-run                # log only, no build/upload
 *   node scripts/bunny-deploy.mjs --path dev --skip-probe  # skip the post-deploy probe (plan-508)
 *   node scripts/bunny-deploy.mjs --demo --path dev --no-smoke   # skip the post-deploy demo smoke
 */

import { readFileSync, writeFileSync, existsSync, renameSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  BunnyClient,
  collectLocalFiles,
  buildRemoteIndex,
  selectFilesToUpload,
  stageHostedProject,
  hostedForcedUploadRels,
  discoverPrivateProjects,
  loadProject,
  sanitizeDemoName,
  applyPublicModelAllowlist,
  publicDemoModelAllowlist,
  publicDemoManifestMisses,
  publicDemoDir,
  isAlwaysUploadFile,
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
  stampCatalogHashes,
  findCatalogFiles,
  catalogChangedBinaries,
  probePublishedAssets,
  PROBE_MISSING_ASSET,
  manifestPreloadFor,
  injectManifestPreload,
  purgeDeployChanges,
} from './_bunny-lib.mjs';
import { generateFragmentSecret, bytesToBase64Url, base64UrlToBytes } from './lib/rv-crypto.mjs';
import { loadSigningConfig, signGlbFile } from './rv-sign-glb.mjs';
import {
  assertBuildProvenance,
  assertNoCrossTierLeak,
  keepStagingRequested,
  loadDeliveryConfig,
  runBuild as runFilteredBuild,
  stageFilteredSourceTree,
  withStagingCleanup,
} from './_workspace-lib.mjs';
import { assertValidProject } from './validate-project.mjs';
import { resolveCustomerForProject, resolveHostedSecrets, recordHostedFragment } from './_rv-customers.mjs';
import { recordPublishProvenance } from './_rv-provenance.mjs';
import { NOTICES_JSON, NOTICES_TXT, noticesWarnBanner, readNoticesMode } from './lib/rv-third-party-notices.mjs';
import { mergeEnv, parseDotEnvText } from './lib/rv-dotenv.mjs';
import { tmpDir } from './lib/rv-machine-paths.mjs';
import { acquirePublishLock } from './rv-publish-lock.mjs';
import { distFingerprint, runDemoSmoke } from './rv-demo-smoke.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

//! Load credentials from a gitignored .env file into process.env (dependency-free).
//! CI / real shell env wins — we only fill keys that aren't already set. Vite
//! auto-loads .env.production for the BUILD, but this plain Node script does not,
//! so without this `npm run deploy` can't see BUNNY_* locally. Mirrors .env.example.
//!
//! The parsing lives in `lib/rv-dotenv.mjs` since plan-587 F7, and the policy
//! `firstNonEmpty` IS the "real shell env wins" rule this comment promises —
//! now named instead of hidden in an `if`. `dev-deploy-watch.mjs` shares the
//! parser but folds with `last`; that difference was MEASURED (§4b M2) and is
//! kept on purpose, because unifying it would have inverted the precedence here.
function loadDotEnv() {
  for (const name of ['.env.production', '.env']) {
    const p = join(ROOT, name);
    if (!existsSync(p)) continue;
    mergeEnv(parseDotEnvText(readFileSync(p, 'utf8')), 'firstNonEmpty', process.env);
  }
}

// ─── Phase reporting for the watcher's timeout (plan-587 F4) ─────────────

//! Name of the file this deploy reports its phase in.
export const DEPLOY_PHASE_FILENAME = 'deploy-phase.json';

//! The phases, in the order they happen. `build` is the only one in which the deploy may be
//! killed from the outside — see `KILLABLE_PHASES` in `lib/rv-proc.mjs`.
export const DEPLOY_PHASES = Object.freeze(['build', 'upload', 'published', 'smoke']);

//! Where to report the phase: `RV_DEPLOY_PHASE_FILE` when the parent named a path (the deploy
//! watcher does, and it MUST, because a watcher clone and this script would otherwise each
//! compute their own `tmpDir()`), else `<RV_DELIVER_TMP>/deploy-phase.json`.
//!
//! Returns `null` when neither is available — a clone without a `.plastic` ancestor and without
//! `RV_WORKSPACE_ROOT` has no tmp dir, and reporting is then simply off. Never throws: this is
//! bookkeeping for somebody else's timeout, never a reason to fail a deploy.
export function deployPhaseFilePath(env = process.env) {
  const explicit = String(env.RV_DEPLOY_PHASE_FILE ?? '').trim();
  if (explicit) return explicit;
  try { return join(tmpDir(), DEPLOY_PHASE_FILENAME); } catch { return null; }
}

//! Reports one phase change ATOMICALLY: write to a pid-suffixed temp file, then `rename` over
//! the target. The reader (`decideTimeoutKill` in `lib/rv-proc.mjs`) must never see half a
//! record — on a torn read it would fall back to "unreadable", which is the conservative
//! no-kill case, but a `{ phase: 'bu` is a bug waiting for a different reader.
//!
//! Returns the path written, or `null` when reporting is off or the write failed. Never throws.
export function reportDeployPhase(phase, { path = deployPhaseFilePath(), now = Date.now, fs = { mkdirSync, writeFileSync, renameSync } } = {}) {
  if (!path) return null;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ phase, at: now() })}\n`);
    fs.renameSync(tmp, path);
    return path;
  } catch {
    return null; // The deploy does not depend on being observable.
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
const YELLOW = '\x1b[33m';

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

//! Public remote prefixes whose deploys reuse the shared node_modules build cache (plan-487).
//! Only the internal channels: `/dev` is "latest work in progress" and `/demo-beta` its
//! rehearsal target. `/demo`, a `--root` deploy and every private/customer deploy keep the
//! fresh `npm ci` — reproducibility before speed where the artifact is public or delivered.
const FAST_BUILD_PREFIXES = new Set(['dev', 'demo-beta']);

//! Decides whether a PUBLIC deploy to `remotePrefix` builds with the dependency cache.
export function fastBuildForPublicTarget(remotePrefix, { root = false } = {}) {
  if (root) return false;
  const prefix = String(remotePrefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  return FAST_BUILD_PREFIXES.has(prefix);
}

//! The register entry of a project whose customer is reached by a hosted link only
//! (`delivery.channel: "hosted-link"`), or `null`. Such a customer has no git delivery, so
//! `loadDeliveryConfig` refuses it; the hosted deploy still needs its tier and its project.
function hostedLinkOwner(privateRoot, projectKey, resolveOwner) {
  const owner = resolveOwner(privateRoot, projectKey);
  return owner?.delivery?.channel === 'hosted-link' ? owner : null;
}

//! Stages the filtered source tree and builds it. The staging directory is created here, so it
//! is also removed here whenever the tier check, the build or the provenance check throws —
//! the caller has no handle yet at that point (plan-487 F1). Once this returns, the caller OWNS
//! `workspaceRoot` and must remove it itself (see releaseStaging). `deps` is a test seam.
export function stageAndBuild({ mode, projectDir = null, base = null, dryRun = false, fast = false }, deps = {}) {
  const {
    stage = stageFilteredSourceTree,
    assertTierLeak = assertNoCrossTierLeak,
    build: buildStep = runFilteredBuild,
    assertProvenance = assertBuildProvenance,
    resolveOwner = resolveCustomerForProject,
  } = deps;
  const demo = mode === 'demo';
  const privateRoot = projectDir ? dirname(dirname(projectDir)) : join(ROOT, '..', 'realvirtual-WebViewer-Private~');
  const projectKey = projectDir ? projectDir.split(/[\\/]/).filter(Boolean).pop() : null;
  // A hosted-link customer stages from its register entry: its tier and entitlements, its
  // project — and, like the demo, no customer workspace files (there is no repository to
  // write them into, and no git delivery config to write them from).
  const hostedOwner = projectKey && !demo ? hostedLinkOwner(privateRoot, projectKey, resolveOwner) : null;
  const delivery = hostedOwner
    ? {
      customer: hostedOwner.customer,
      kind: hostedOwner.kind,
      channel: 'hosted-link',
      projects: [...hostedOwner.delivery.projects],
      projectKey,
      tier: hostedOwner.delivery.tier,
      restrictedFeatures: [...hostedOwner.delivery.restrictedFeatures],
    }
    : (projectKey ? loadDeliveryConfig(privateRoot, projectKey) : null);
  const profile = demo ? DEMO_PROFILE : (delivery ?? { tier: 'core', restrictedFeatures: [] });
  const staged = stage({
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
    ...(hostedOwner ? { workspaceFiles: false } : {}),
  });
  return withStagingCleanup(staged.workspaceRoot, () => {
    // The staged private tree is what gets compiled, so this is the check that the internal
    // tier never entered the demo build in the first place — before Vite, before any upload.
    if (demo) assertTierLeak(staged.workspaceRoot, staged.manifest, profile);
    const build = buildStep(staged.workspaceRoot, { mode, base, dryRun, projectKey, fast });
    if (!dryRun) assertProvenance(build.distDir, { mode, projectKey });
    if (!dryRun && fast) {
      const method = build.cacheMethod ? `, restored as ${build.cacheMethod === 'link' ? 'junction' : 'copy'}` : '';
      const profileTag = build.profileKey ? `profile ${String(build.profileKey).slice(0, 6)}…` : 'no profile';
      info('build-cache', `${build.cacheStatus ?? 'rebuild'}  (${profileTag}${method})`);
    }
    return { ...staged, ...build };
  });
}

//! Reports the third-party notices of a build (plan-544 F11): one log line with the mode, and a
//! loud multi-line banner when they were generated in `warn` mode or are missing. The notices
//! are dist-root files, so every channel uploads them unencrypted next to index.html. Returns
//! `{ mode, banner }` (test seam); never throws — the gate itself lives in the build.
export function reportThirdPartyNotices(distDir, { log: write = log } = {}) {
  const jsonPath = join(distDir, NOTICES_JSON);
  const present = existsSync(jsonPath) && existsSync(join(distDir, NOTICES_TXT));
  const mode = present ? readNoticesMode(jsonPath) : null;
  // A missing TXT counts as missing even when the JSON is there: the banner then reports both.
  const banner = noticesWarnBanner(present ? jsonPath : join(distDir, NOTICES_TXT), { product: 'realvirtual WEB deploy' });
  write(`  ${CYAN}${'notices'.padEnd(10)}${RESET}: ${present ? `${NOTICES_TXT} (${mode ?? 'unknown'} mode)` : 'MISSING'}`);
  if (banner) write(`${YELLOW}${banner}${RESET}`);
  return { mode, banner };
}

//! Removes a staging workspace the caller owns — unless `RV_KEEP_STAGING=1` keeps it for
//! inspection. Runs in a `finally`, so it must never throw over the error that got it there.
function releaseStaging(workspaceRoot) {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return;
  if (keepStagingRequested()) {
    info('staging', `kept (RV_KEEP_STAGING=1): ${workspaceRoot}`);
    return;
  }
  try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* ignore */ }
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
//! Which remote files a deploy may delete as stale — and which it must not touch.
//!
//! A deploy owns only the TOP-LEVEL entries its own dist carries. Everything else
//! in the listing belongs to another deploy and is never "stale" here: at the zone
//! root that is download/ (the CONNECT installer and its manifests), demo/, dev/,
//! embed/ and every 32-hex customer folder. Before this rule a plain root deploy
//! listed the whole zone and deleted every file outside dist — on 2026-09-07 that
//! took the CONNECT download, the beta manifest, the dev/ demo and three live
//! customer projects off the CDN in one run. `preserveRemotePrefixes` keeps its
//! role for the private deploy (private-assets/ lives inside the owned tree).
//!
//! Pure: entries + local rels in, { stale, foreign } out — so the rule is tested,
//! not demonstrated.
export function selectStaleEntries(entries, localRels, preserveRemotePrefixes = []) {
  const norm = (rel) => String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const localPaths = new Set(localRels.map((rel) => norm(rel).toLowerCase()));
  const localTop = new Set(localRels.map((rel) => norm(rel).split('/')[0].toLowerCase()));
  const stale = [];
  const foreign = [];
  for (const entry of entries) {
    const rel = norm(entry.rel);
    if (localPaths.has(rel.toLowerCase())) continue;
    if (preserveRemotePrefixes.some((prefix) => rel.startsWith(prefix))) continue;
    if (!localTop.has(rel.split('/')[0].toLowerCase())) { foreign.push(rel); continue; }
    stale.push({ ...entry, rel });
  }
  return { stale, foreign };
}

//! Default number of parallel storage requests of one deploy (`RV_DEPLOY_CONCURRENCY`). A
//! derivation from Bunny's documented ceilings (100 connections per IP, DELETE 30 concurrent),
//! not a Bunny recommendation.
export const DEFAULT_DEPLOY_CONCURRENCY = 8;
//! Default ceiling for the summed size of files being uploaded at once
//! (`RV_DEPLOY_MAX_INFLIGHT_BYTES`): each in-flight upload holds its whole file in memory.
export const DEFAULT_MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return value;
}

//! Runs `worker(item)` over `items` in order with at most `limit` workers in flight and at most
//! `maxInflightBytes` summed `weight(item)` in flight. An item heavier than the whole budget runs
//! alone; the queue is FIFO, so it is never starved by smaller items behind it.
//!
//! Failure contract (plan-487 §2.4): after the first worker rejects no further item STARTS,
//! every worker already running is awaited, and then the first error is thrown. The caller can
//! therefore rely on "resolved = every item succeeded" and on nothing still running on reject.
export function runWithConcurrency(items, limit, worker, { weight = () => 0, maxInflightBytes = Infinity } = {}) {
  const queue = [...items];
  const maxWorkers = Math.max(1, Math.floor(limit) || 1);
  return new Promise((resolvePool, rejectPool) => {
    let next = 0;
    let inFlight = 0;
    let inFlightWeight = 0;
    let failure = null;
    let settled = false;
    const pump = () => {
      while (failure === null && next < queue.length && inFlight < maxWorkers) {
        const item = queue[next];
        const itemWeight = Math.max(0, Number(weight(item)) || 0);
        if (inFlight > 0 && inFlightWeight + itemWeight > maxInflightBytes) break;
        next++;
        inFlight++;
        inFlightWeight += itemWeight;
        Promise.resolve()
          .then(() => worker(item))
          .catch((error) => { if (failure === null) failure = { error }; })
          .finally(() => {
            inFlight--;
            inFlightWeight -= itemWeight;
            pump();
          });
      }
      if (settled || inFlight > 0) return;
      if (failure !== null) { settled = true; rejectPool(failure.error); }
      else if (next >= queue.length) { settled = true; resolvePool(); }
    };
    pump();
  });
}

//! Is `rel` a library catalog? The default `deferUntilLast` predicate (plan-508 F2b).
export function isCatalogFile(rel) {
  return /(^|\/)catalog\.json$/i.test(String(rel).replace(/\\/g, '/'));
}

//! The catalogued binaries under `localDir` whose hash changed against the
//! catalogs currently published under `remotePrefix` (plan-508 F2b) — fed to
//! `uploadDirectory` as `alwaysUploadRel`, so a same-size GLB / splat whose
//! bytes changed is uploaded even though the size diff would skip it. Called
//! INSIDE the publish lock: another deploy's catalog must not slip in between.
//! A remote catalog that is missing (first deploy) forces every catalogued file.
export async function catalogHashDiff(client, localDir, remotePrefix) {
  const prefix = (remotePrefix || '').replace(/^\/+|\/+$/g, '');
  const changed = new Set();
  for (const rel of findCatalogFiles(localDir)) {
    const remotePath = prefix ? `${prefix}/${rel}` : rel;
    const remote = await client.getFileIfExists(remotePath);
    for (const bin of catalogChangedBinaries(localDir, rel, remote)) changed.add(bin);
  }
  if (changed.size > 0) info('catalog', `${changed.size} catalogued file(s) with a changed sha256 — uploaded regardless of size`);
  return changed;
}

//! `deferUntilLast` (plan-508 F2b): files uploaded only after EVERY other asset
//! of this run has finished — by default each `catalog.json`. If a binary
//! fails, the pool rejects before the catalog is sent, the OLD catalog stays
//! remote, and the next run's hash diff selects the binary again. A catalog
//! that went out first would make browsers verify old bytes against new hashes.
export async function uploadDirectory(client, localDir, remotePrefix, {
  force, dryRun, alwaysUploadGlbs, preserveRemotePrefixes = [],
  alwaysUploadRel = null, deferUntilLast = isCatalogFile, uploadFirst = null,
}) {
  const local = collectLocalFiles(localDir);
  if (local.length === 0) {
    throw new Error(`No files to upload in ${localDir}`);
  }
  const concurrency = positiveIntegerEnv('RV_DEPLOY_CONCURRENCY', DEFAULT_DEPLOY_CONCURRENCY);
  const maxInflightBytes = positiveIntegerEnv('RV_DEPLOY_MAX_INFLIGHT_BYTES', DEFAULT_MAX_INFLIGHT_BYTES);

  log(`${DIM}Fetching remote file list for diff/reconcile...${RESET}`);
  const entries = await client.listRecursive(remotePrefix);
  let remoteIndex = null;
  if (!force) {
    remoteIndex = buildRemoteIndex(entries);
    info('diff', `${remoteIndex.size} remote files indexed`);
  }

  const selected = selectFilesToUpload(local, remoteIndex, { force, alwaysUploadGlbs, alwaysUploadRel: alwaysUploadRel ?? [] });
  const skipped = local.length - selected.length;

  // Atomic ordering (plan-487 §2.4). With a pool, sorting only decides when an upload STARTS;
  // what matters is when it has FINISHED. So every non-HTML file goes through the pool, the
  // pool is drained, then the deferred files (plan-508: the catalogs) one by one, and only
  // then the HTML files — index.html last.
  const isHtml = (rel) => /\.html$/i.test(rel);
  const isIndexHtml = (rel) => /(^|\/)index\.html$/i.test(rel);
  const isDeferred = typeof deferUntilLast === 'function'
    ? deferUntilLast
    : (rel) => (deferUntilLast ? [...deferUntilLast].some((d) => String(d).toLowerCase() === rel.toLowerCase()) : false);
  // `uploadFirst` (plan-759 F9): a stable partition so, e.g., a hosted deploy's
  // `p/**` enters the pool before the runtime assets. Start order only — the
  // pool still finishes files in whatever order the network allows.
  const assets = selected.filter((f) => !isHtml(f.rel) && !isDeferred(f.rel));
  if (typeof uploadFirst === 'function') {
    const first = assets.filter((f) => uploadFirst(f.rel));
    const rest = assets.filter((f) => !uploadFirst(f.rel));
    assets.length = 0;
    assets.push(...first, ...rest);
  }
  const deferred = selected.filter((f) => !isHtml(f.rel) && isDeferred(f.rel));
  const pages = selected.filter((f) => isHtml(f.rel))
    .sort((a, b) => Number(isIndexHtml(a.rel)) - Number(isIndexHtml(b.rel)));

  const prefix = (remotePrefix || '').replace(/^\/+|\/+$/g, '');
  let uploaded = 0;
  // plan-598 Phase 2: the PATHS, not only the counts — the URL purge needs to
  // know which files changed (uploaded) and which disappeared (deleted).
  const uploadedRels = [];
  const deletedRels = [];
  const uploadOne = async (f) => {
    const remotePath = prefix ? `${prefix}/${f.rel}` : f.rel;
    // The REAL predicate, not a second spelling of it. This regex used to list
    // `settings|models|manifest` and omit `project.json`, so the one file whose
    // always-upload matters most — the demo manifest, since plan-737 at
    // `demo-realvirtual/project.json` — was uploaded unconditionally but logged
    // as though it had been diffed. A log that disagrees with the mechanism is
    // how a manifest fix looks skipped while the rollback runbook is being read.
    const always = isHtml(f.rel) || isAlwaysUploadFile(f.rel);
    const tag = always ? `${MAGENTA}(always)${RESET}` : '';
    log(`  ${GREEN}↑${RESET} ${f.rel} ${tag} ${DIM}${humanSize(f.size)}${RESET}`);
    try {
      await client.putFile(readFileSync(f.abs), remotePath);
      uploaded++;
      uploadedRels.push(f.rel);
    } catch (ex) {
      log(`    ${RED}! upload failed${RESET} ${f.rel} ${DIM}${ex?.message ?? ex}${RESET}`);
      throw new Error(
        `Failed to upload ${f.rel}: ${ex?.message ?? ex}\n` +
        `  (rerun without --force to resume via diff)`,
      );
    }
  };

  if (selected.length > 0) {
    info('upload', `${selected.length} files, pool=${concurrency} (max ${humanSize(maxInflightBytes)} in flight)`);
  }
  // A final asset failure throws out of here after the running uploads have settled: no HTML
  // and no stale-delete follow, so the live page never points at a chunk that did not arrive.
  await runWithConcurrency(assets, concurrency, uploadOne, { weight: (f) => f.size, maxInflightBytes });
  if (assets.length > 0) log(`  ${GREEN}OK${RESET}  all assets settled`);
  for (const f of deferred) await uploadOne(f);
  for (const f of pages) await uploadOne(f);

  const { stale, foreign } = selectStaleEntries(entries, local.map((file) => file.rel), preserveRemotePrefixes);
  if (foreign.length > 0) {
    log(`  ${DIM}= ${foreign.length} remote file(s) outside this deploy's tree left untouched${RESET}`);
  }
  if (stale.length > 0) {
    log(`${DIM}Removing ${stale.length} stale file(s) under ${prefix || '(root)'}/ ...${RESET}`);
  }
  let deleteFailures = 0;
  // Same pool, capped at 8 (Bunny allows 30 concurrent deletes). The try/catch stays INSIDE
  // the worker, so the pool itself never rejects here.
  await runWithConcurrency(stale, Math.min(concurrency, DEFAULT_DEPLOY_CONCURRENCY), async (entry) => {
    const remotePath = prefix ? `${prefix}/${entry.rel}` : entry.rel;
    log(`  ${RED}-${RESET} ${entry.rel} ${DIM}(stale)${RESET}`);
    try {
      await client.deleteFile(remotePath);
      deletedRels.push(entry.rel);
    } catch (ex) {
      // A stale leftover Bunny refuses to delete (HTTP 400 "Unable to delete
      // file" on some legacy demo/models/* objects) must not abort the deploy:
      // every upload is already done at this point, and dying here skipped the
      // cache purge — the live site kept serving the OLD index.html against
      // the NEW assets (2026-09-02, /demo). Deletes are cleanup, not delivery.
      deleteFailures++;
      log(`    ${RED}! delete failed${RESET} ${DIM}${ex?.message ?? ex}${RESET}`);
    }
  });
  if (deleteFailures > 0) {
    log(`${RED}${deleteFailures} stale file(s) could not be deleted${RESET} ${DIM}— remove them via the Bunny dashboard.${RESET}`);
  }

  if (skipped > 0) log(`  ${DIM}= ${skipped} unchanged (skipped)${RESET}`);
  return { uploaded, skipped, deleted: stale.length - deleteFailures, deleteFailures, uploadedRels, deletedRels };
}

// ─── Publish lock (plan-488) ─────────────────────────────────────────────

//! Default wait for a busy publish lock before the deploy gives up (`RV_DEPLOY_LOCK_TIMEOUT_SECONDS`).
export const DEFAULT_LOCK_TIMEOUT_SECONDS = 20 * 60;

//! The publish lock name for a public remote prefix. THIS IS A CONTRACT (doc-deploy.md
//! § "Automatic /dev deploys"): every local publisher — the /dev watcher, a manual
//! `/deploy-web-beta`, `/deploy-web` — derives the same name for the same CDN target, and an
//! installed watcher copy of an older version must keep agreeing with it. Scheme:
//! `rv-publish-<zone>:<prefix>`, prefix without slashes and lower-cased; the zone root is
//! `rv-publish-<zone>:` (empty prefix).
export function publishLockName(storageZone, remotePrefix) {
  const zone = String(storageZone ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
  const prefix = String(remotePrefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  return `rv-publish-${zone}:${prefix}`;
}

function nonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (seconds), got "${raw}".`);
  }
  return value;
}

//! Acquires the publish lock for one public deploy window — or refuses the deploy.
//!
//! Order matters (plan-488 §2.8): the optional staging/build limit
//! (`RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS`, measured from the start of deployPublic) is checked
//! IMMEDIATELY before the acquisition, so an overrun ends the deploy before the lock and before
//! any remote access. Waiting for the lock is bounded by `RV_DEPLOY_LOCK_TIMEOUT_SECONDS`.
async function acquireDeployLock(cfg, remotePrefix, { startedAt, now, acquire, pollMs }) {
  const prepublishLimit = nonNegativeIntegerEnv('RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS', null);
  const lockTimeoutSeconds = nonNegativeIntegerEnv('RV_DEPLOY_LOCK_TIMEOUT_SECONDS', DEFAULT_LOCK_TIMEOUT_SECONDS);
  if (prepublishLimit !== null) {
    const elapsedSeconds = (now() - startedAt) / 1000;
    if (elapsedSeconds > prepublishLimit) {
      throw new Error(`Staging and build took ${Math.round(elapsedSeconds)} s, over the limit of ${prepublishLimit} s `
        + '(RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS). Aborting before the publish lock — nothing was published.');
    }
  }
  const name = publishLockName(cfg.storageZone, remotePrefix);
  if (process.platform !== 'win32' && (process.env.RV_DEPLOY_LOCK || '').trim() === '0') {
    log(`${DIM}publish lock disabled (RV_DEPLOY_LOCK=0 on ${process.platform}) — make sure nobody else publishes to this target${RESET}`);
    return { name, release: async () => {} };
  }
  try {
    const lock = await acquire(name, {
      timeoutMs: lockTimeoutSeconds * 1000,
      ...(pollMs != null ? { pollMs } : {}),
      onWait: (lockName) => log(`${MAGENTA}waiting for publish lock ${lockName}${RESET} ${DIM}(another deploy is publishing to this target; up to ${lockTimeoutSeconds} s)${RESET}`),
    });
    info('lock', name);
    return lock;
  } catch (error) {
    if (process.platform !== 'win32') {
      throw new Error(`${error?.message ?? error} On a non-Windows machine set RV_DEPLOY_LOCK=0 to publish without the lock, `
        + 'but only when no other deploy can run against the same target.');
    }
    throw error;
  }
}

// ─── Public deploy ───────────────────────────────────────────────────────

//! Public deploy entry. `deps.stageAndBuild` and `deps.sleep` are test seams; everything after staging runs
//! inside a `try/finally` that owns the staging directory (plan-487, gate round 2 finding 1):
//! the manifest guard, an upload that finally fails and the purge can all still throw.
//! `deps.now`, `deps.acquireLock` and `deps.lockPollMs` are the publish-lock seams (plan-488);
//! `deps.probe` replaces the post-deploy probe (plan-508 F8).
//! `deps.runSmoke` replaces `runDemoSmoke` (plan-503); `opts.noSmoke` skips the smoke.
export async function deployPublic(cfg, opts, deps = {}) {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const remotePrefix = opts.path ?? cfg.remotePath;
  // The zone root is shared with download/, demo/, dev/ and every customer folder.
  // A deploy there is a deliberate, rare act — it must be spelled out, never be the
  // result of a forgotten --path (2026-09-07). Forks publishing at their own zone
  // root pass --root once and are done.
  if (!remotePrefix && !opts.root) {
    throw new Error('Refusing to deploy to the zone root: no --path given and BUNNY_REMOTE_PATH is empty.\n'
      + '  The public demo lives at --path demo (see /deploy-web); a deliberate root deploy needs --root.');
  }
  // `--demo` swaps the code tier and nothing else: same prefix, same content pipeline below.
  const mode = opts.demo ? 'demo' : 'public';
  // plan-587 F4: from here to the publish lock NOTHING is published, so this is the one phase in
  // which an outside deadline may kill this process. Reported before the first expensive step,
  // and re-reported at each boundary below.
  const phase = deps.reportPhase ?? reportDeployPhase;
  phase('build');
  const fast = fastBuildForPublicTarget(remotePrefix, { root: opts.root });
  const filtered = (deps.stageAndBuild ?? stageAndBuild)({ mode, base: opts.base, dryRun: opts.dryRun, fast });
  try {
    await publishPublicBuild(cfg, opts, filtered, {
      mode,
      remotePrefix,
      sleep: deps.sleep ?? null,
      probe: deps.probe ?? probePublishedAssets,
      lock: { startedAt, now, acquire: deps.acquireLock ?? acquirePublishLock, pollMs: deps.lockPollMs ?? null },
      runSmoke: deps.runSmoke ?? runDemoSmoke,
      reportPhase: phase,
    });
  } finally {
    releaseStaging(filtered.workspaceRoot);
  }
}

// ─── Post-deploy demo smoke (plan-503) ───────────────────────────────────

//! The deploy is live, the demo smoke is red. `main()` maps it to exit 3 (not 1): the watcher
//! reads 3 as "DEPLOY OK + SMOKE FAILED" and must not back off and redeploy the same pair.
export class SmokeFailedError extends Error {
  constructor(result, url) {
    const first = result?.failures?.[0];
    super(`Smoke FAILED after deploy — the build IS live at ${url}; see ${result?.reportPath ?? '(no report)'}.`
      + `${result?.reason ? ` reason=${result.reason}` : ''}${first ? ` first: ${first.title}` : ''}`
      + ' Roll back by re-deploying the previous tag.');
    this.name = 'SmokeFailedError';
    this.exitCode = 3;
    this.result = result;
  }
}

//! Exit code of the CLI for an error that reached `main()`.
export function exitCodeFor(error) {
  return error instanceof SmokeFailedError ? 3 : 1;
}

//! The URL the smoke opens (F10): the public host plus the ACTUAL remote prefix. Not
//! `resolveSeo().pageUrl` — that exists only on the canonical path, never for `dev/` or the root.
export function smokeBaseUrl(remotePrefix, env = process.env) {
  const host = (env.RV_PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, '');
  const prefix = String(remotePrefix ?? '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${host}/${prefix}/` : `${host}/`;
}

//! Where the smoke writes (F8) — OUTSIDE the staging tree, which `releaseStaging()` deletes:
//! `RV_SMOKE_OUT_DIR` (the watcher: `<root>\last-smoke`), else `<repo>/.smoke/<ISO time>/`.
export function smokeOutDir(env = process.env, now = Date.now) {
  if (env.RV_SMOKE_OUT_DIR) return resolve(env.RV_SMOKE_OUT_DIR);
  return join(ROOT, '.smoke', new Date(now()).toISOString().replace(/[:.]/g, '-'));
}

//! `RV_SMOKE_PAIR` (JSON `{ web, private }`, set by the watcher) or null.
function smokePair(env = process.env) {
  if (!env.RV_SMOKE_PAIR) return null;
  try { return JSON.parse(env.RV_SMOKE_PAIR); } catch { return null; }
}

//! Runs the demo smoke against what was just published. Writes `<outDir>/expected.json`
//! (`{ pair, baseUrl, demos, fingerprint }`, from the STAGING dist — the uploaded bytes) BEFORE
//! the runner starts, so a `--retry-smoke` always has the current stand even when the runner ends
//! at runtime-missing or unreachable. A runner that throws counts as a failed smoke, never as a
//! failed deploy. Throws SmokeFailedError when the result is `failed`.
async function runPostDeploySmoke(distDir, remotePrefix, runSmoke) {
  const baseUrl = smokeBaseUrl(remotePrefix);
  const outDir = smokeOutDir();
  mkdirSync(outDir, { recursive: true });
  for (const stale of ['expected.json', 'smoke-result.json', 'playwright-report.json']) {
    try { rmSync(join(outDir, stale), { force: true }); } catch { /* best effort */ }
  }
  const expectedFile = join(outDir, 'expected.json');
  let runOpts;
  try {
    const { demos, fingerprint } = distFingerprint(distDir);
    writeFileSync(expectedFile, `${JSON.stringify({ pair: smokePair(), baseUrl, demos, fingerprint }, null, 2)}\n`);
    runOpts = { baseUrl, expectedFile, outDir, rootDir: ROOT };
  } catch (error) {
    // No demo manifest in the staging dist — the runner reports expected-unreadable itself.
    log(`${DIM}smoke: no expected stand from ${distDir} (${error?.message ?? error})${RESET}`);
    runOpts = { baseUrl, distDir, outDir, rootDir: ROOT };
  }
  info('smoke', `${baseUrl}  →  ${outDir}`);
  let result;
  try {
    result = await runSmoke(runOpts);
  } catch (error) {
    result = { status: 'failed', reason: 'crashed', failures: [{ spec: '(runner)', title: '(runner)', message: String(error?.message ?? error), attachments: [] }], reportPath: join(outDir, 'smoke-result.json') };
    try { writeFileSync(result.reportPath, `${JSON.stringify({ ...result, baseUrl, outDir }, null, 2)}\n`); } catch { /* best effort */ }
  }
  const seconds = result.durationMs != null ? ` ${(result.durationMs / 1000).toFixed(1)}s` : '';
  info('smoke', result.status === 'ok'
    ? `${GREEN}✓${RESET}${seconds}${result.flaky?.length ? ` (${result.flaky.length} flaky)` : ''}`
    : `${RED}${String(result.status).toUpperCase()}${RESET}${result.reason ? ` reason=${result.reason}` : ''}${seconds}`);
  for (const f of (result.failures ?? []).slice(0, 10)) log(`  ${RED}✗${RESET} ${f.title}: ${String(f.message).split('\n')[0]}`);
  console.log(`SMOKE_STATUS=${result.status}`);
  console.log(`SMOKE_REPORT=${result.reportPath}`);
  if (result.status === 'failed') throw new SmokeFailedError(result, baseUrl);
  return result;
}

async function publishPublicBuild(cfg, opts, filtered, { mode, remotePrefix, sleep, probe, lock: lockOptions, runSmoke, reportPhase = reportDeployPhase }) {
  const distDir = filtered.distDir;
  if (opts.dryRun) {
    log(`${DIM}[dry-run] filtered ${mode} source staged; no build/upload performed${RESET}`);
    return;
  }
  if (!existsSync(distDir)) throw new Error(`Filtered build output not found: ${distDir}`);
  assertNoDevArtifacts(distDir);
  assertNoPublishableSource(distDir);
  reportThirdPartyNotices(distDir);

  // The DemoRealvirtual content is bundled: it lives in `public/` (models/,
  // scenes/, library/), so Vite has already copied it into dist/ as part of the
  // build. Nothing to stage here — the allowlist and scene pruning below run
  // over what the build produced.

  // Model allowlist: the public CDN must ship ONLY the official demo models
  // (prefix DemoRealvirtual*) plus the planner library — prune test/helper/stray
  // GLBs (and their hashed assets/ duplicates) before upload, and rewrite
  // models.json so the selector lists exactly what is shipped.
  const modelPrefix = (process.env.RV_PUBLIC_MODEL_PREFIX || PUBLIC_MODEL_PREFIX).trim() || PUBLIC_MODEL_PREFIX;
  // ── Who curates: the manifest, unless it is absent or overridden ──────
  //
  // Precedence, and the reason for it (plan-726 Phase 3):
  //
  //  1. `RV_PUBLIC_MODEL_PREFIX` — an operator saying "this deploy, this once".
  //     It stays the rollback lever of 5.6, so it has to outrank the file.
  //  2. `dist/project.json` `documents[]` — the demo's own statement of what it
  //     contains, and since plan-726 the same file the RUNTIME boots from.
  //  3. the built-in prefix — for a dist/ that has no manifest at all.
  //
  // The bug this removes: `DemoRobotIK.glb` is a demo model, it is listed in
  // the manifest, and it matches neither built-in prefix — so every public and
  // `--demo` deploy so far has deleted it.
  const manifestKeep = process.env.RV_PUBLIC_MODEL_PREFIX
    ? null
    : publicDemoModelAllowlist(distDir);
  if (process.env.RV_PUBLIC_MODEL_PREFIX && publicDemoModelAllowlist(distDir)) {
    log(`${DIM}RV_PUBLIC_MODEL_PREFIX is set — overriding the project.json document list${RESET}`);
  }
  const allow = applyPublicModelAllowlist(distDir, {
    prefix: modelPrefix,
    dryRun: opts.dryRun,
    ...(manifestKeep ? { keep: manifestKeep } : {}),
  });
  const curator = manifestKeep ? 'project.json documents[]' : `prefix "${modelPrefix}*"`;
  log(`${DIM}Public model allowlist (${curator}): `
    + `${allow.kept.length} kept, ${allow.dropped.length} pruned`
    + `${allow.droppedAssets.length ? ` (+${allow.droppedAssets.length} hashed)` : ''}${RESET}`);
  for (const f of allow.kept) log(`  ${GREEN}keep${RESET} models/${f}`);
  for (const f of allow.dropped) log(`  ${RED}prune${RESET} models/${f}`);
  if (allow.kept.length === 0) {
    log(`  ${RED}⚠ no model matches ${curator} — the public selector will be empty${RESET}`);
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

  // ── The contradiction guard (plan-726 F5) ────────────────────────────
  //
  // Runs AFTER both pruning passes, because the question is about the artifact
  // that is actually going to be uploaded — not about what the build produced.
  // It covers `models/` and `scenes/` together: the two are pruned by two
  // unrelated passes (an allowlist and a filename prefix), and a manifest names
  // documents in both.
  //
  // It throws. A missing document is a 404 that only the visitor ever sees:
  // the manifest boots the demo, so the very first thing a first-time visitor
  // does is ask for `settings.defaultModel`. Shipping that broken is strictly
  // worse than not shipping.
  //
  // PUBLIC path only, on purpose. A private customer deploy publishes no root
  // `project.json` at all (its manifest travels through `private-assets/`), so
  // the same call there would either be vacuous or, worse, start asserting
  // things about a customer's manifest that this plan never reasoned about.
  if (!opts.dryRun) {
    const misses = publicDemoManifestMisses(distDir);
    if (misses.length > 0) {
      throw new Error(
        'The deploy manifest names documents that are not in the build output:\n'
        + misses.map((p) => `  - ${p}`).join('\n')
        + '\n\nEither add them to public/demo-realvirtual/, or remove them from'
        + ' public/demo-realvirtual/project.json.'
        + ' (A case-only mismatch counts: the storage zone is case-sensitive.)',
      );
    }
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

  // Catalog hashes (plan-508 F2): stamped from the bytes that ship — AFTER the
  // signing above, which changes every GLB at the same size. `prebuild` stamped
  // the unsigned dev bytes; left alone, every signed library GLB would be a
  // "hash mismatch" in every browser.
  if (existsSync(join(distDir, PROBE_MISSING_ASSET))) {
    throw new Error(`Refusing to deploy: ${PROBE_MISSING_ASSET} exists in the build output — `
      + 'that path is reserved for the post-deploy probe and must stay missing.');
  }
  const stamp = stampCatalogHashes(distDir);
  if (stamp.catalogs > 0) log(`${DIM}Catalog hashes: stamped ${stamp.stamped} entr${stamp.stamped === 1 ? 'y' : 'ies'} in ${stamp.catalogs} catalog(s)${RESET}`);

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

  // plan-598 Phase 2: the manifest preload is written by the DEPLOY — only it
  // knows which manifest this channel's runtime will fetch (demo folder vs root).
  const preload = injectManifestPreload(join(distDir, 'index.html'), {
    href: manifestPreloadFor({ kind: 'public', distDir }), dryRun: opts.dryRun,
  });
  log(`${DIM}Manifest preload: ${preload ?? 'none'}${RESET}`);

  log('');
  log(`${MAGENTA}realvirtual WebViewer · Bunny Deploy${RESET}`);
  info('mode', opts.demo ? 'demo  (commercial code · public demo content)' : 'public');
  info('zone', `${cfg.storageZone}  region ${cfg.region}`);
  info('remote', `${remotePrefix || '(root)'}/`);

  const client = new BunnyClient({
    region: cfg.region, zone: cfg.storageZone, storageKey: cfg.storageKey,
    accountKey: cfg.accountKey, pullZoneId: cfg.pullZoneId, dryRun: opts.dryRun, log, sleep,
  });

  // The publish window (plan-488 §2.3): from BEFORE the remote listing to AFTER the purge, the
  // root robots.txt PUT included. Two publishers to the same target interleaving here corrupt
  // it — the second one's listing sees the first one's fresh assets and its stale-delete removes
  // them. Nothing above this line touched the remote.
  const lock = await acquireDeployLock(cfg, remotePrefix, lockOptions);
  let uploaded;
  let skipped;
  let changes = { uploadedRels: [], deletedRels: [], deleteFailures: 0 };
  try {
    // plan-508 F2b: inside the lock, before the upload — the catalog published
    // RIGHT NOW is the baseline, and nobody else can change it until we are done.
    // plan-587 F4: the remote is about to change. From here on an outside kill would leave a
    // half-published target behind, so the phase file stops saying `build`.
    reportPhase('upload');
    const alwaysUploadRel = opts.force ? [] : await catalogHashDiff(client, distDir, remotePrefix);
    const result = await uploadDirectory(client, distDir, remotePrefix, {
      ...opts,
      alwaysUploadGlbs: !!signing,
      alwaysUploadRel,
    });
    ({ uploaded, skipped } = result);
    changes = result;

    // Crawlers only honor /robots.txt at the DOMAIN ROOT — when the canonical
    // deploy lives under a sub-path (demo/), a root copy referencing the absolute
    // sitemap URL must exist too. The dist/ copy under the sub-path is harmless.
    if (seo.mode === 'canonical' && seo.prefix && seo.robots) {
      log(`  ${GREEN}↑${RESET} robots.txt ${MAGENTA}(zone root)${RESET}`);
      await client.putFile(Buffer.from(seo.robots, 'utf8'), 'robots.txt');
    }

    // plan-598 F5: the browser-cache rules of the pull zone (immutable hashed
    // assets, revalidated HTML/manifests/models/draco), idempotent — a no-op
    // when the zone already carries them. Before the purge, so every URL the
    // purge refetches is answered under the rules.
    await ensureEdgeRulesStep(client, opts);
    const rootRobots = seo.mode === 'canonical' && seo.prefix && seo.robots
      ? [`${(process.env.RV_PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, '')}/robots.txt`]
      : [];
    await maybePurge(client, uploaded, opts, {
      baseUrl: publicBaseUrlFor(remotePrefix),
      uploaded: changes.uploadedRels,
      deleted: changes.deletedRels,
      extraUrls: rootRobots,
      partial: changes.deleteFailures > 0,
    });
    // plan-587 F4: the bytes are up and the cache is purged — the build IS live. Everything
    // after this point only CHECKS it, which is exactly why a timeout must not kill it.
    reportPhase('published');

    // plan-508 F8: prove on the live host that a missing asset is a 404 without
    // HTML, that the catalog arrived byte-for-byte and that the first asset
    // hashes to its catalog entry. Still inside the lock — what is probed is
    // exactly what this run published.
    await runPublishProbe(distDir, remotePrefix, opts, probe);

    // plan-503: the demo smoke runs after the purge and the plan-508 probe, INSIDE the
    // publish lock, so no second publisher changes the target while it is being checked.
    // A failed probe (exit 1) stops before the smoke. `--dry-run` returned above.
    if (opts.noSmoke) {
      info('smoke', 'skipped (--no-smoke)');
      console.log('SMOKE_STATUS=skipped');
    } else {
      info('uploaded', `${uploaded} uploaded, ${skipped} unchanged — the build is live; running the demo smoke`);
      reportPhase('smoke');
      await runPostDeploySmoke(distDir, remotePrefix, runSmoke ?? runDemoSmoke);
    }
  } finally {
    await lock.release();
  }
  info('done', `${uploaded} uploaded, ${skipped} unchanged`);
}

//! The public base URL a remote prefix is served under (`https://web.realvirtual.io/demo/`).
export function publicBaseUrlFor(remotePrefix) {
  const host = (process.env.RV_PUBLIC_BASE_URL || PUBLIC_BASE_URL).replace(/\/+$/, '');
  const prefix = (remotePrefix || '').replace(/^\/+|\/+$/g, '');
  return prefix ? `${host}/${prefix}/` : `${host}/`;
}

//! Runs the post-deploy probe (plan-508 F8) and throws — exit 1 — on any finding.
//! `--skip-probe` (or `--dry-run`) skips it with a visible line. `probe` is the
//! test seam (default `probePublishedAssets`).
async function runPublishProbe(distDir, remotePrefix, opts, probe = probePublishedAssets) {
  if (opts.dryRun) return;
  if (opts.skipProbe) {
    info('probe', `${DIM}skipped (--skip-probe)${RESET}`);
    return;
  }
  const baseUrl = publicBaseUrlFor(remotePrefix);
  const result = await probe({ baseUrl, distDir });
  for (const line of result.checks) log(`  ${GREEN}✓${RESET} ${DIM}${line}${RESET}`);
  if (!result.ok) {
    for (const line of result.findings) log(`  ${RED}✗${RESET} ${line}`);
    throw new Error(`Post-deploy probe failed for ${baseUrl}:\n`
      + result.findings.map((f) => `  - ${f}`).join('\n')
      + '\n  (the upload itself finished; fix the host / catalog and redeploy, or pass --skip-probe for an offline run)');
  }
  info('probe', `${GREEN}✓${RESET} ${baseUrl}`);
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
  try {
    await publishPrivateBuild(cfg, opts, { project, projectDir, filtered });
  } finally {
    releaseStaging(filtered.workspaceRoot);
  }
}

async function publishPrivateBuild(cfg, opts, { project, projectDir, filtered }) {
  const filteredProjectDir = join(filtered.workspaceRoot, 'projects', requireFolderName(projectDir));
  opts.dist = filtered.distDir;
  if (!opts.dryRun && !existsSync(opts.dist)) throw new Error(`Filtered build output not found: ${opts.dist}`);
  if (!opts.dryRun) assertNoDevArtifacts(opts.dist);
  if (!opts.dryRun) reportThirdPartyNotices(opts.dist);

  log('');
  log(`${MAGENTA}realvirtual WebViewer · Bunny Deploy${RESET}`);
  info('mode', `private  project "${project.name}" (code ${project.code.slice(0, 8)}…)`);
  info('zone', `${cfg.storageZone}  region ${cfg.region}`);
  info('remote', `${project.code}/`);

  const client = new BunnyClient({
    region: cfg.region, zone: cfg.storageZone, storageKey: cfg.storageKey,
    accountKey: cfg.accountKey, pullZoneId: cfg.pullZoneId, dryRun: opts.dryRun, log,
  });

  // plan-267 / plan-759: optional password protection. The password and the
  // 32-byte fragment secret come from the customer register (`hosted` block of
  // customers/<slug>.json) so a re-publish keeps the customer's link stable;
  // RV_DEPLOY_PASSWORD / RV_DEPLOY_FRAGMENT override them for a one-off run.
  // Never a CLI arg — args land in process lists / shell history / logs.
  let encryption = null;
  let fragmentB64 = null;
  const privateRoot = dirname(opts.projectsDir);
  const projectKey = requireFolderName(projectDir);
  let customer = null;
  try {
    customer = resolveCustomerForProject(privateRoot, projectKey);
  } catch (ex) {
    log(`${DIM}Customer register: ${ex?.message ?? ex}${RESET}`);
  }
  const hosted = resolveHostedSecrets(customer, process.env);
  if (hosted.password) {
    const fragmentSecret = hosted.fragment ? base64UrlToBytes(hosted.fragment) : generateFragmentSecret();
    fragmentB64 = bytesToBase64Url(fragmentSecret);
    encryption = { password: hosted.password, fragmentSecret };
    const origin = hosted.source === 'env' ? 'env' : `register customers/${customer.customer}.json`;
    info('encrypt', `AES-256-GCM · password protected · ${origin}${hosted.fragment ? ' · fragment kept' : ' · fresh fragment'}`);
    if (!hosted.fragment && customer && hosted.source === 'register' && !opts.dryRun) {
      // A minted fragment is link material: write it back so the NEXT publish
      // keeps this link working (D6). Printed below either way.
      recordHostedFragment(privateRoot, customer.customer, fragmentB64);
      log(`${DIM}Fragment written to customers/${customer.customer}.json (hosted.fragment).${RESET}`);
    }
  } else {
    log(`${RED}Unencrypted hosted deploy:${RESET} ${DIM}no hosted.password in the register and no RV_DEPLOY_PASSWORD — every GLB goes out in plaintext.${RESET}`);
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
  // plan-598: what this publish changed, for the URL purge below.
  const privateChanges = { uploaded: [], deleted: [], partial: false };
  try {
    if (opts.dryRun) {
      log(`${DIM}[dry-run] would stage project + upload to ${project.code}/${RESET}`);
    } else {
      let encryptedRels = [];
      stagingDir = await stageHostedProject({
        distDir: opts.dist,
        projectDir: filteredProjectDir,
        encryption,
        signing,
        onReport: (report) => {
          encryptedRels = report.encrypted ?? [];
          printHostedPreflight(report, project);
        },
      });
      info('staging', stagingDir);
      // plan-508 F2: staging signed (and possibly encrypted) the GLBs — the
      // catalog hash must describe the bytes the browser will fetch.
      const stamp = stampCatalogHashes(stagingDir);
      if (stamp.catalogs > 0) log(`${DIM}Catalog hashes: stamped ${stamp.stamped} entr${stamp.stamped === 1 ? 'y' : 'ies'} in ${stamp.catalogs} catalog(s)${RESET}`);

      // Private customer deploys live on unguessable {code}/ URLs and must never
      // be indexed. A robots.txt below the domain root has no effect — the meta
      // tag is the mechanism that works at any path. (index.html stays plaintext
      // even in encrypted deploys; only GLBs are encrypted.)
      injectNoindex(join(stagingDir, 'index.html'));
      log(`${DIM}SEO: noindex injected (private deploy)${RESET}`);
      // plan-598 Phase 2: hosted without password preloads `p/project.json`; a
      // password deploy preloads NOTHING — its manifest may only be requested
      // after the password gate, and an HTML preload runs before any script.
      const preload = injectManifestPreload(join(stagingDir, 'index.html'), {
        href: manifestPreloadFor({ kind: 'hosted', encrypted: !!encryption }),
      });
      log(`${DIM}Manifest preload: ${preload ?? 'none (password deploy)'}${RESET}`);

      // ONE pass: runtime + p/ (plan-759 F9). Envelope GLBs must bypass the size
      // diff: a fresh salt gives a new ciphertext at identical size. settings.json
      // is deferred to the end with the catalogs: it names the probe of THIS
      // publish, so it must not go live before the GLBs it belongs to.
      // plan-596 SOL #1: every file the staging encrypted (GLB AND project
      // AASX / aasx/index.json) is uploaded regardless of size — p/-relative
      // report paths become staging-relative here and join the catalog diff.
      const p1 = await uploadDirectory(client, stagingDir, project.code, {
        ...opts,
        alwaysUploadGlbs: !!encryption || !!signing,
        alwaysUploadRel: opts.force
          ? []
          : hostedForcedUploadRels(encryptedRels, await catalogHashDiff(client, stagingDir, project.code)),
        deferUntilLast: (rel) => isCatalogFile(rel) || /^settings\.json$/i.test(rel),
        uploadFirst: (rel) => rel.startsWith('p/'),
      });
      totalUploaded += p1.uploaded;
      totalSkipped += p1.skipped;
      privateChanges.uploaded.push(...p1.uploadedRels);
      privateChanges.deleted.push(...p1.deletedRels);
      if (p1.deleteFailures > 0) privateChanges.partial = true;

      // The {code}/ folder is owned in full: whatever the staging did not
      // produce is gone — including a previous layout's models/, models.json
      // and private-assets/ (D8). The snapshot IS the staging listing, never a
      // second rule.
      const expected = expectedHostedSnapshot(stagingDir);
      const deleted = await reconcileRemoteSnapshot(client, project.code, expected, privateChanges.deleted);
      if (deleted > 0) log(`${DIM}Remote reconcile removed ${deleted} file(s) not in this publish.${RESET}`);

      // lastPublished only after the reconcile (R9).
      writeLastPublished(projectDir, project);
    }
  } finally {
    if (stagingDir && existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // plan-598 F5: cache rules first (idempotent), then the purge of what changed.
  if (!opts.dryRun) await ensureEdgeRulesStep(client, opts);
  await maybePurge(client, totalUploaded, opts, {
    baseUrl: publicBaseUrlFor(project.code),
    uploaded: privateChanges.uploaded,
    deleted: privateChanges.deleted,
    partial: privateChanges.partial,
  });
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

//! The preflight a hosted deploy prints (plan-759 F10): every document the
//! manifest lists, every file the deny list removed, every skipped symlink.
function printHostedPreflight(report, project) {
  const documents = Array.isArray(project?.documents) ? project.documents : [];
  log(`${DIM}Preflight: ${report.copied.length} file(s) under p/, ${documents.length} document(s) in project.json${RESET}`);
  for (const doc of documents) {
    const want = String(doc.path ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
    const present = report.copied.some((rel) => rel.toLowerCase() === want);
    log(`  ${present ? GREEN + '·' : RED + '?'}${RESET} ${doc.path}${present ? '' : DIM + '  (declared, not on disk)' + RESET}`);
  }
  for (const d of report.denied) log(`  ${DIM}- ${d.rel}  (${d.reason})${RESET}`);
  for (const rel of report.symlinks) log(`  ${RED}- ${rel}${RESET} ${DIM}(symlink, never followed)${RESET}`);
  for (const rel of report.oversized) log(`  ${RED}! ${rel}${RESET} ${DIM}(larger than 256 MB — decrypts on the customer's main thread)${RESET}`);
  if (report.encrypted.length > 0) log(`  ${DIM}${report.encrypted.length} GLB(s) encrypted in place${RESET}`);
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
    layout: 'hosted-v2',
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

//! Purges what the deploy changed (plan-598 Phase 2), unless suppressed
//! (--no-purge) or nothing changed. With the changed paths (`changes`) it is a
//! URL purge of the uploaded AND deleted non-hashed files — every other URL of
//! the zone stays warm on the edges; it falls back to the zone purge for a
//! partly applied deploy (a stale file that could not be deleted), more than
//! URL_PURGE_LIMIT URLs, or a failed URL purge. Without `changes` (old callers)
//! it is the zone purge it always was. Mirrors C# (uploadedCount>0 + creds set).
export async function maybePurge(client, uploadedCount, opts, changes = null) {
  if (opts.noPurge) {
    info('purge', 'skipped (--no-purge)');
    return;
  }
  const deletedCount = changes?.deleted?.length ?? 0;
  if (uploadedCount === 0 && deletedCount === 0 && !changes?.partial) {
    info('purge', 'skipped (nothing uploaded)');
    return;
  }
  if (!changes) {
    const ok = await client.purge();
    info('purge', ok ? `${GREEN}✓${RESET}` : `${DIM}skipped${RESET}`);
    return;
  }
  if (!client.accountKey || !client.pullZoneId) {
    info('purge', `${DIM}skipped (no account key / pull zone id)${RESET}`);
    return;
  }
  const result = await purgeDeployChanges(client, { ...changes, log });
  if (result.mode === 'none') info('purge', `${DIM}nothing to purge (only content-hashed files changed)${RESET}`);
  else if (result.mode === 'url') info('purge', `${GREEN}✓${RESET} ${result.urls.length} URL(s)`);
  else info('purge', result.ok ? `${GREEN}✓${RESET} zone` : `${DIM}skipped${RESET}`);
}

//! plan-598 F5: makes the pull zone carry the browser-cache edge rules. Runs on
//! every real deploy (idempotent, non-fatal); RV_DEPLOY_EDGE_RULES=0 skips it.
async function ensureEdgeRulesStep(client, opts) {
  if ((process.env.RV_DEPLOY_EDGE_RULES || '').trim() === '0') {
    info('edge', 'skipped (RV_DEPLOY_EDGE_RULES=0)');
    return;
  }
  const r = await client.ensureEdgeRules();
  if (r) info('edge', `cache rules: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged${opts.dryRun ? ' [dry-run]' : ''}`);
  else info('edge', `${DIM}cache rules not applied (see log)${RESET}`);
}

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
    root: hasFlag('root'),
    force: hasFlag('force'),
    dryRun: hasFlag('dry-run'),
    noPurge: hasFlag('no-purge'),
    skipProbe: hasFlag('skip-probe'),
    noSmoke: hasFlag('no-smoke'),
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
    process.exit(exitCodeFor(e));
  });
}

//! What a hosted publish leaves on the CDN: exactly the staging listing (F9).
//! Deriving this from the staged tree — not from a second walk of the project
//! with its own deny rule — is what keeps the reconciler from deleting a file
//! the upload just wrote.
export function expectedHostedSnapshot(stagingDir) {
  return new Set(collectLocalFiles(stagingDir).map((file) => file.rel.replace(/\\/g, '/').toLowerCase()));
}

//! Deletes every remote file that is absent from the validated local snapshot manifest.
//! `deletedOut` (optional) collects the deleted prefix-relative paths — the URL
//! purge of plan-598 must purge what disappeared, not only what was uploaded.
export async function reconcileRemoteSnapshot(client, remotePrefix, expectedPaths, deletedOut = null) {
  const entries = await client.listRecursive(remotePrefix);
  const prefix = remotePrefix.replace(/^\/+|\/+$/g, '');
  let deleted = 0;
  for (const entry of entries) {
    if (expectedPaths.has(entry.rel.replace(/\\/g, '/').toLowerCase())) continue;
    await client.deleteFile(prefix ? `${prefix}/${entry.rel}` : entry.rel);
    deleted++;
    if (deletedOut) deletedOut.push(entry.rel.replace(/\\/g, '/'));
  }
  return deleted;
}
