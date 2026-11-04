// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * publish-project — publish ONE project of this workspace to a Bunny storage zone.
 *
 * This is the publish path of a **delivered workspace** (plan-604): a commercial
 * customer or partner builds his own project and puts it on a CDN zone of his own —
 * either the zone realvirtual provisioned for him inside realvirtual's account
 * (`rv-partner-<slug>`, see `doc-publishing.md`) or a zone in his own Bunny account.
 * The tool cannot tell the two apart and does not need to: every account-specific
 * value comes from the environment.
 *
 * ## Why this exists next to `bunny-deploy.mjs`
 *
 * `bunny-deploy.mjs` is realvirtual's own pipeline. It carries the public demo
 * allowlist, SEO artifacts, the customer register, the shared publish lock, release
 * staging and a post-deploy smoke run — machinery that is about operating
 * `web.realvirtual.io`, not about publishing a project. None of it is delivered, and
 * a workspace must not need it.
 *
 * What both share is the part that is a CONTRACT, and they share it by importing the
 * same module rather than by having two copies: `stageHostedProject` (the `{code}/`
 * layout, plan-759), the diff and always-upload rules, `expectedHostedSnapshot` plus
 * `reconcileRemoteSnapshot` (the folder is owned in full), and the Bunny client with
 * its retries and MIME map — all from `_bunny-lib.mjs`.
 *
 * The one deliberate difference: this uploads **sequentially**. The concurrency pool
 * in `bunny-deploy.mjs` is a throughput optimisation for publishing the demo dozens
 * of times a day; a project publish is occasional, and a plain loop is less to get
 * wrong. The upload ORDER is kept identical, because that one is a contract: project
 * bytes first, then the rest of the runtime, then the catalogs and `settings.json`,
 * and `index.html` last — so the live site never points at assets that are not there
 * yet.
 *
 * ## Usage
 *
 *   node scripts/publish-project.mjs --list
 *   node scripts/publish-project.mjs --project "My Line"
 *   node scripts/publish-project.mjs --project "My Line" --dry-run
 *   node scripts/publish-project.mjs --project "My Line" --no-build --force
 *
 * Environment (a gitignored `.env` in this folder or in the workspace root is read):
 *
 *   BUNNY_STORAGE_ZONE   required  the storage zone to publish into
 *   BUNNY_STORAGE_KEY    required  that zone's password (write + delete IN THAT ZONE)
 *   BUNNY_REGION         optional  storage region host, default storage.bunnycdn.com
 *   BUNNY_ACCOUNT_KEY    optional  account API key — only to purge the CDN cache
 *   BUNNY_PULL_ZONE_ID   optional  pull zone id — only to purge the CDN cache
 *   PROJECTS_DIR         optional  projects root, default `projects/` beside the workspace
 *   RV_PUBLIC_BASE_URL   optional  the hostname your zone is served under, for the
 *                                  printed link. Without it the link is printed as
 *                                  Bunny's system hostname `<zone>.b-cdn.net`, which
 *                                  is where the files really are.
 *   RV_DEPLOY_PASSWORD   optional  password-protect the project (AES-256-GCM, plan-759).
 *                                  Half the key travels in the link (`#k=`), this half
 *                                  does not — send them through separate channels.
 *   RV_DEPLOY_FRAGMENT   optional  reuse a previous link fragment instead of minting one,
 *                                  so an already distributed link keeps working.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BunnyClient,
  HOSTED_PROJECT_PREFIX,
  normalizePath,
  buildRemoteIndex,
  collectLocalFiles,
  discoverPrivateProjects,
  expectedHostedSnapshot,
  injectNoindex,
  isAlwaysUploadFile,
  isCatalogFile,
  loadConfig,
  reconcileRemoteSnapshot,
  selectFilesToUpload,
  stageHostedProject,
  stampCatalogHashes,
} from './_bunny-lib.mjs';
import { bytesToBase64Url, base64UrlToBytes, generateFragmentSecret } from './lib/rv-crypto.mjs';
import { mergeEnv, parseDotEnvText } from './lib/rv-dotenv.mjs';
import { parseLibrarySourceArgs } from './lib/rv-library-trim.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CYAN = '[36m'; const DIM = '[2m'; const GREEN = '[32m';
const RED = '[31m'; const RESET = '[0m';

const HELP = `Publish one project of this workspace to a Bunny storage zone.

Usage:
  node scripts/publish-project.mjs --list
  node scripts/publish-project.mjs --project "<name>" [--dry-run] [--no-build] [--force]
                                   [--library <projectId>=<folder> ...]

Library projects the project uses (project.json libraries[]) are published with it,
trimmed to the documents it uses, under p/libraries/<projectId>/. They are found by id
in the projects folder, in the project's own libraries/, or where --library says.

Required environment (a gitignored .env beside this folder is read automatically):
  BUNNY_STORAGE_ZONE   the storage zone to publish into
  BUNNY_STORAGE_KEY    that zone password (write + delete IN THAT ZONE only)

Optional:
  BUNNY_REGION         storage region host (default storage.bunnycdn.com)
  BUNNY_ACCOUNT_KEY    account API key, only needed to purge the CDN cache
  BUNNY_PULL_ZONE_ID   pull zone id, only needed to purge the CDN cache
  PROJECTS_DIR         projects root (default: projects/ beside this folder)
  RV_PUBLIC_BASE_URL   the hostname your zone is served under, for the printed link
  RV_DEPLOY_PASSWORD   password-protect the project (the link then carries #k=...)
  RV_DEPLOY_FRAGMENT   reuse a previous link fragment so old links keep working

The project folder is published to <zone>/<project code>/ and that folder is owned in
full: files this publish does not contain are removed from it. --dry-run shows every
step and uploads nothing.`

const log = (message) => console.log(message);
const info = (label, value) => console.log(`  ${CYAN}${label.padEnd(10)}${RESET}: ${value}`);

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${bytes} B`;
}

/**
 * Fills `process.env` from a gitignored `.env` without overriding a real shell value.
 *
 * Two locations, in this order: this folder (beside `package.json`, where the internal
 * pipeline also keeps it) and the WORKSPACE ROOT one level up — the folder with
 * `start.ps1` and `.gitignore`, which is where someone who received a workspace
 * naturally puts credentials. Reading only one of the two produced the worst failure
 * mode available here: a `.env` that exists, is ignored, and the tool reporting a
 * missing variable.
 *
 * Precedence: a real shell/CI value wins over both, and this folder wins over the root.
 * The generated workspace `.gitignore` carries `.env*`, which matches at every level.
 */
export function loadDotEnv(root = ROOT, env = process.env) {
  for (const dir of [root, resolve(root, '..')]) {
    for (const name of ['.env.production', '.env']) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      mergeEnv(parseDotEnvText(readFileSync(path, 'utf8')), 'firstNonEmpty', env);
    }
  }
  return env;
}

export function parsePublishArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    if (index < 0) return null;
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value.`);
    return next;
  };
  const flag = (name) => argv.includes(`--${name}`);
  const known = new Set(['--list', '--project', '--projects-dir', '--library', '--no-build', '--dry-run', '--force', '--help', '-h']);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--') && !argument.startsWith('-')) continue;
    if (!known.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (argument === '--project' || argument === '--projects-dir' || argument === '--library') index++;
  }
  return {
    help: flag('help') || argv.includes('-h') || argv.length === 0,
    list: flag('list'),
    project: value('project'),
    projectsDir: value('projects-dir'),
    // plan-778 F15: repeatable --library <projectId>=<folder>; the projects dir is searched by id too.
    libraries: parseLibrarySourceArgs(argv).libraries,
    build: !flag('no-build'),
    dryRun: flag('dry-run'),
    force: flag('force'),
  };
}

/**
 * Where the projects live.
 *
 * `projects/` sits BESIDE the viewer in a delivered workspace
 * (`<workspace>/projects`, `<workspace>/realvirtual-web`), which is why the sibling is
 * probed before the local folder. `--projects-dir` and `PROJECTS_DIR` win over both.
 */
export function resolveProjectsDir({ projectsDir = null, env = process.env, root = ROOT } = {}) {
  const explicit = projectsDir ?? env.PROJECTS_DIR ?? env.BUNNY_PRIVATE_PROJECTS_DIR ?? null;
  if (explicit) return resolve(explicit);
  return [resolve(root, '..', 'projects'), resolve(root, 'projects')]
    .find((candidate) => existsSync(candidate)) ?? resolve(root, '..', 'projects');
}

//! The project whose `name` or folder matches, case-insensitively. Throws with the list
//! of what IS there, because a typo in a project name is the likeliest failure here.
export function pickProject(projects, wanted) {
  const needle = String(wanted ?? '').trim().toLowerCase();
  const hit = projects.find((entry) => entry.project.name.toLowerCase() === needle
    || entry.folderName.toLowerCase() === needle);
  if (!hit) {
    const names = projects.map((entry) => `"${entry.project.name}"`).join(', ') || '(none)';
    throw new Error(`No project "${wanted}". This workspace has: ${names}`);
  }
  return hit;
}

/**
 * The upload order, as one function so it is testable and visibly the same rule the
 * internal pipeline applies (plan-487 §2.4, plan-759 F9):
 *
 *   1. `p/**`          the project's own bytes
 *   2. everything else the runtime assets
 *   3. catalogs + `settings.json`  they describe 1 and 2, so they follow them
 *   4. `*.html`, `index.html` last the entry point goes live only once all of it is up
 */
export function orderForUpload(files) {
  const rank = (rel) => {
    if (/(^|\/)index\.html$/i.test(rel)) return 4;
    if (/\.html$/i.test(rel)) return 3;
    if (isCatalogFile(rel) || /^settings\.json$/i.test(rel)) return 2;
    if (rel.startsWith('p/')) return 0;
    return 1;
  };
  return [...files].sort((a, b) => rank(a.rel) - rank(b.rel));
}

/**
 * The project documents whose bytes changed against the PUBLISHED manifest, by sha256.
 *
 * The upload diff is size-based (that is the shared rule, and it is cheap). For project
 * documents it is also the wrong rule: the most common update in this workflow is "same
 * model, re-exported", and a re-export can easily land on the identical byte count — a
 * renamed signal, a changed transform, a different material value. Size alone would then
 * report "unchanged" and the CDN would keep serving the old geometry, which is the one
 * failure nobody notices until a customer does.
 *
 * `project.json` carries a `sha256` per document, so the comparison is exact: read the
 * manifest that is live, compare, and force exactly the documents that really differ.
 * A missing or unparsable remote manifest means "force everything" — a first publish, or
 * a manifest we cannot reason about, is not the moment to skip bytes.
 *
 * @returns staging-relative paths (`p/<document path>`), ready as `alwaysUploadRel`.
 */
export function changedProjectDocuments(localManifestText, remoteManifestText) {
  let local;
  try { local = JSON.parse(String(localManifestText)); } catch { return []; }
  const documents = Array.isArray(local?.documents) ? local.documents : [];
  // `normalizePath` is the lib's own backslash rule — the same one `collectLocalFiles`
  // used to produce the rels this list is compared against.
  const rel = (document) => HOSTED_PROJECT_PREFIX
    + normalizePath(String(document.path ?? '')).replace(/^[.]?[/]/, '');
  let remoteByPath = null;
  if (remoteManifestText != null) {
    try {
      const remote = JSON.parse(String(remoteManifestText));
      remoteByPath = new Map();
      for (const document of Array.isArray(remote?.documents) ? remote.documents : []) {
        if (document?.path) remoteByPath.set(String(document.path).toLowerCase(), document.sha256 ?? null);
      }
    } catch { remoteByPath = null; }
  }
  const changed = [];
  for (const document of documents) {
    const path = String(document?.path ?? "");
    if (!path) continue;
    // No local hash: we cannot prove it is unchanged, so it goes up.
    if (typeof document.sha256 !== "string") { changed.push(rel(document)); continue; }
    if (remoteByPath === null) { changed.push(rel(document)); continue; }
    if (remoteByPath.get(path.toLowerCase()) !== document.sha256) changed.push(rel(document));
  }
  return changed;
}
//! The link the published project is reachable under. Without `RV_PUBLIC_BASE_URL` this
//! is Bunny's system hostname for the zone — unglamorous, but true for any account.
export function publishedUrl(code, { zone, env = process.env } = {}) {
  const base = (env.RV_PUBLIC_BASE_URL || `https://${zone}.b-cdn.net`).replace(/\/+$/, '');
  return `${base}/${code}/`;
}

//! The optional password protection (plan-759). Both halves come from the environment
//! here: a delivered workspace has no register to keep them in.
function resolveEncryption(env = process.env) {
  const password = (env.RV_DEPLOY_PASSWORD || '').trim();
  if (!password) return null;
  const existing = (env.RV_DEPLOY_FRAGMENT || '').trim();
  const fragmentSecret = existing ? base64UrlToBytes(existing) : generateFragmentSecret();
  return { password, fragmentSecret, reused: Boolean(existing) };
}

function runBuild(dryRun) {
  if (dryRun) {
    log(`${DIM}[dry-run] would run: npm run build${RESET}`);
    return;
  }
  log(`${DIM}Building (npm run build)...${RESET}`);
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
    // A customer project never carries the public-demo notice, whatever the shell inherited.
    env: { ...process.env, RV_DEMO_NOTICE: '0' },
  });
  if (result.status !== 0) throw new Error('npm run build failed — nothing was uploaded.');
}

async function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  if (options.help) {
    log(HELP);
    return;
  }
  loadDotEnv();
  const projectsDir = resolveProjectsDir({ projectsDir: options.projectsDir });
  const projects = discoverPrivateProjects(projectsDir);

  if (options.list) {
    info('projects', projectsDir);
    if (projects.length === 0) log(`  ${DIM}(no project.json found)${RESET}`);
    for (const entry of projects) {
      log(`  ${entry.project.name.padEnd(30)} ${DIM}folder ${entry.folderName}  code ${entry.project.code.slice(0, 8)}…${RESET}`);
    }
    return;
  }
  if (!options.project) throw new Error('Pass --project "<name>" (or --list to see what is here).');

  const { project, projectDir } = pickProject(projects, options.project);
  const cfg = loadConfig();
  const client = new BunnyClient({
    region: cfg.region,
    zone: cfg.storageZone,
    storageKey: cfg.storageKey,
    accountKey: cfg.accountKey,
    pullZoneId: cfg.pullZoneId,
    dryRun: options.dryRun,
    log: (message) => log(`${DIM}${message}${RESET}`),
  });

  info('project', `${project.name}  ${DIM}(code ${project.code.slice(0, 8)}…)${RESET}`);
  info('zone', `${cfg.storageZone}  ${DIM}${cfg.region}${RESET}`);
  info('remote', `${project.code}/`);
  const encryption = resolveEncryption();
  if (encryption) {
    info('encrypt', `AES-256-GCM, password from RV_DEPLOY_PASSWORD${encryption.reused ? ', fragment reused' : ', fresh fragment'}`);
  }

  if (options.build) runBuild(options.dryRun);
  const distDir = join(ROOT, 'dist');
  if (!options.dryRun && !existsSync(distDir)) {
    throw new Error(`No build to publish: ${distDir} does not exist. Run without --no-build.`);
  }
  if (options.dryRun) {
    log(`${DIM}[dry-run] would stage ${projectDir} with the build and upload it to ${project.code}/${RESET}`);
    info('url', publishedUrl(project.code, { zone: cfg.storageZone }));
    return;
  }

  let stagingDir = null;
  let uploaded = 0;
  let skipped = 0;
  try {
    stagingDir = await stageHostedProject({
      distDir,
      projectDir,
      encryption: encryption ? { password: encryption.password, fragmentSecret: encryption.fragmentSecret } : null,
      signing: null,
      // plan-778 F15: library projects the project uses ship trimmed under p/libraries/.
      librarySources: { projectsDir, libraries: options.libraries },
      onLog: (line) => log(`${DIM}${line}${RESET}`),
      onReport: (report) => {
        log(`${DIM}Staged ${report.copied.length} project file(s) under p/${RESET}`);
        for (const denied of report.denied ?? []) log(`  ${DIM}- ${denied.rel}  (${denied.reason})${RESET}`);
        for (const rel of report.symlinks ?? []) log(`  ${RED}- ${rel}${RESET} ${DIM}(symlink, never followed)${RESET}`);
      },
    });
    const stamp = stampCatalogHashes(stagingDir);
    if (stamp.catalogs > 0) log(`${DIM}Catalog hashes: stamped ${stamp.stamped} entry/entries${RESET}`);
    // A project on an unguessable path must not be indexed, and a robots.txt below the
    // domain root has no effect — the meta tag is what works at any path.
    injectNoindex(join(stagingDir, 'index.html'));

    const local = collectLocalFiles(stagingDir);
    if (local.length === 0) throw new Error(`Nothing staged in ${stagingDir}.`);
    const remoteIndex = options.force ? null : buildRemoteIndex(await client.listRecursive(project.code));
    if (remoteIndex) info('diff', `${remoteIndex.size} remote file(s) indexed`);
    // An envelope has a fresh salt on every publish, so an encrypted GLB of identical
    // size is still different bytes — the size diff must not skip it.
    // Exact change detection for the project documents (see changedProjectDocuments).
    // One small GET against the live manifest buys a correct answer for the GLBs.
    let forced = [];
    if (!options.force) {
      const remoteManifest = await client.getFileIfExists(`${project.code}/${HOSTED_PROJECT_PREFIX}project.json`);
      forced = changedProjectDocuments(
        readFileSync(join(stagingDir, HOSTED_PROJECT_PREFIX, "project.json"), "utf8"),
        remoteManifest,
      );
      if (forced.length > 0) {
        info("changed", `${forced.length} project document(s) differ by sha256 from what is published`);
      }
    }
    const selected = selectFilesToUpload(local, remoteIndex, {
      force: options.force,
      alwaysUploadGlbs: Boolean(encryption),
      alwaysUploadRel: forced,
    });
    skipped = local.length - selected.length;

    for (const file of orderForUpload(selected)) {
      const remotePath = `${project.code}/${file.rel}`;
      const always = /\.html$/i.test(file.rel) || isAlwaysUploadFile(file.rel);
      log(`  ${GREEN}↑${RESET} ${file.rel}${always ? ` ${DIM}(always)${RESET}` : ''} ${DIM}${humanSize(file.size)}${RESET}`);
      await client.putFile(readFileSync(file.abs), remotePath);
      uploaded++;
    }
    if (skipped > 0) log(`  ${DIM}= ${skipped} unchanged (skipped)${RESET}`);

    // The `{code}/` folder is owned in full: whatever this publish did not produce is
    // gone, including a previous layout's leftovers (plan-759 D8).
    const deleted = await reconcileRemoteSnapshot(client, project.code, expectedHostedSnapshot(stagingDir));
    if (deleted > 0) log(`${DIM}Removed ${deleted} remote file(s) this publish does not contain.${RESET}`);
  } finally {
    if (stagingDir && existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  if (uploaded > 0) await client.purge();
  info('done', `${uploaded} uploaded, ${skipped} unchanged`);
  const url = publishedUrl(project.code, { zone: cfg.storageZone });
  if (encryption) {
    info('url', `${url}#k=${bytesToBase64Url(encryption.fragmentSecret)}`);
    log(`${DIM}Send the link and the password through separate channels — together they ARE the key.${RESET}`);
    if (!encryption.reused) {
      log(`${DIM}Keep the fragment (RV_DEPLOY_FRAGMENT) if the next publish should keep this link working.${RESET}`);
    }
  } else {
    info('url', url);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`${RED}Error:${RESET} ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
