// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applySnapshot,
  assertLfsPointer,
  assertNoCrossTierLeak,
  assertPrivateSourceInventory,
  assertWorkspaceGuards,
  baselineTagFor,
  changeoverCommitNote,
  collectPrivateSourceInventory,
  confirmProjectReplace,
  createDeliveryManifest,
  deliveryChangelog,
  detectDeliveryBaseline,
  diffPrivateSourceInventory,
  formatSnapshotSummary,
  gitProvenance,
  hashTree,
  loadDeliveryConfig,
  loadDeliveryConfigByCustomer,
  loadTierManifest,
  previewProjectReplace,
  readBaselineSourceInventory,
  readCloneDeliveryManifest,
  readPlasticChangeset,
  readRemoteBaselineInventory,
  releaseNotesBetween,
  resolveRequestedProjects,
  versionOfBaselineTag,
  runBuild,
  stageFilteredSourceTree,
} from './_workspace-lib.mjs';
import { SHARED_ORG, SHARED_REPO } from './_rv-customers.mjs';
import { compileProjectDir } from './compile-project-scripts.mjs';
import { knownProjectKeys } from './_rv-guards.mjs';
import { recordPublishProvenance } from './_rv-provenance.mjs';
import { parseLibrarySourceArgs } from './lib/rv-library-trim.mjs';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(coreRoot, '../realvirtual-WebViewer-Private~');
const connectTools = resolve(coreRoot, '../realvirtual-Connect~/tools');

function arg(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
}

/**
 * Reads a list-valued flag: `--projects a b c`, `--projects a,b`, or both.
 *
 * Returns `[]` when the flag is absent, which is the standard delivery — the one
 * that writes nothing under `projects/` at all. Not the same as `--projects` with
 * no value, which is a typo and says so.
 */
export function listArg(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return [];
  const values = [];
  for (let i = index + 1; i < args.length && !args[i].startsWith('--'); i++) {
    values.push(...args[i].split(',').map((entry) => entry.trim()).filter(Boolean));
  }
  if (!values.length) throw new Error(`--${name} needs at least one name, e.g. --${name} all`);
  return values;
}

//! plan-778 F15: `--projects-dir` / `--library <id>=<folder>` as the staging's library sources.
//! Without a `--projects-dir` the staging searches the private tree's own `projects/`.
function librarySourcesOf(args) {
  const parsed = parseLibrarySourceArgs(args);
  return { ...(parsed.projectsDir ? { projectsDir: resolve(parsed.projectsDir) } : {}), libraries: parsed.libraries };
}

function requireArg(args, name) {
  const value = arg(args, name);
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

//! Builds the CONNECT diagnosis payload (rag.zip + project-config.json) and returns its directory,
//! or null for a --no-rag delivery. Null propagates to stageFilteredSourceTree, which then writes
//! no connect/ folder and generates a README/start script that never references one.
function buildRagPair(args, projectKey, projectDir) {
  return resolveRagPair(args, projectKey, projectDir)?.dir ?? null;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The content key of one diagnosis package (plan-679 A4).
 *
 * Everything the pair is computed from: the project key, the seed index, the preset, the corpus
 * bundle-rag embeds (`docs/`), the bundler, the .NET indexer it runs (sources, not build output),
 * and the gateway it is configured for (base URL, a hash of the key — never the key). The
 * embedding model is bundle-rag's own default, so it is covered by the bundler's hash.
 * Contents, never timestamps: an unchanged corpus delivered a week later hits the cache.
 */
export function computeRagCacheKey({ projectKey, projectDir, seedIndex, diagnosisConfig, tools = connectTools, env = process.env }) {
  const docs = join(projectDir, 'docs');
  const parts = {
    schema: 1,
    projectKey,
    seedIndex: sha256File(seedIndex),
    preset: sha256File(diagnosisConfig),
    corpus: existsSync(docs) ? hashTree(docs) : hashTree(projectDir),
    bundler: sha256File(join(tools, 'bundle-rag.mjs')),
    indexer: hashTree(join(tools, 'build-rag-index'), ['bin/**', 'bin2/**', 'obj/**']),
    baseUrl: env.REQUESTY_BASE_URL ?? '',
    apiKey: createHash('sha256').update(env.REQUESTY_API_KEY ?? '').digest('hex'),
  };
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Resolves the diagnosis package, optionally through the content-keyed cache (plan-679 A4).
 *
 * `--rag-cache <dir>`: a hit (meta + both files, hashes intact) is used as is; a miss is built and
 * stored. `--rag-expect <key>,<zipSha256>,<configSha256>` (the release push, from the receipt):
 * the key must be recomputed identically and the entry must exist with exactly those hashes —
 * anything else refuses this target with "a new dry-run is needed". A cache entry whose files no
 * longer match its own recorded hashes is refused in every mode.
 *
 * Returns `null` without a package, else `{ dir, cache: { key, ragZipSha256, projectConfigSha256, hit } | null }`.
 */
export function resolveRagPair(args, projectKey, projectDir, deps = {}) {
  if (args.includes('--no-rag')) {
    console.log('[customer-workspace] --no-rag: no diagnosis package is built or delivered.');
    return null;
  }
  // A projectless (standard) delivery has no project corpus to embed and no
  // preset to read, so the diagnosis package cannot exist — this is the same
  // branch as --no-rag, reached by what the customer IS rather than by a flag
  // (plan-434 Phase 4).
  if (!projectKey) {
    console.log('[customer-workspace] projectless delivery: no diagnosis package is built or delivered.');
    return null;
  }
  const supplied = arg(args, 'connect-artifacts');
  if (supplied) return { dir: resolve(supplied), cache: null };
  const seedIndex = requireArg(args, 'seed-index');
  const diagnosisConfig = requireArg(args, 'diagnosis-config');
  const build = deps.build ?? ((output) => execFileSync(process.execPath, [join(connectTools, 'bundle-rag.mjs'),
    '--project-dir', projectDir,
    '--project', projectKey,
    '--output-dir', output,
    '--seed-index', resolve(seedIndex),
    '--extra-config', resolve(diagnosisConfig),
  ], { stdio: 'inherit', env: process.env }));
  const cacheRoot = arg(args, 'rag-cache');
  const expect = arg(args, 'rag-expect');
  if (!cacheRoot) {
    if (expect) throw new Error('--rag-expect needs --rag-cache.');
    const output = mkdtempSync(join(tmpdir(), `rv-rag-${projectKey}-`));
    build(output);
    return { dir: output, cache: null };
  }
  const key = (deps.computeKey ?? computeRagCacheKey)({ projectKey, projectDir, seedIndex, diagnosisConfig });
  const entry = join(resolve(cacheRoot), key);
  const metaPath = join(entry, 'meta.json');
  const files = { zip: join(entry, 'rag.zip'), config: join(entry, 'project-config.json') };
  const expected = expect ? expect.split(',') : null;
  if (expected && (expected.length !== 3 || expected.some((value) => !/^[0-9a-f]{64}$/.test(value)))) {
    throw new Error(`--rag-expect must be <key>,<zipSha256>,<configSha256> (got "${expect}").`);
  }
  if (expected && expected[0] !== key) {
    throw new Error(`The inputs of the diagnosis package changed since the release dry-run `
      + `(cache key ${key.slice(0, 12)}…, receipt ${expected[0].slice(0, 12)}…). A new dry-run is needed.`);
  }
  if (existsSync(metaPath) && existsSync(files.zip) && existsSync(files.config)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const actual = { ragZipSha256: sha256File(files.zip), projectConfigSha256: sha256File(files.config) };
    if (actual.ragZipSha256 !== meta.ragZipSha256 || actual.projectConfigSha256 !== meta.projectConfigSha256) {
      throw new Error(`The cached diagnosis package ${entry} no longer matches its recorded hashes. `
        + 'Delete the entry; a new dry-run is needed.');
    }
    if (expected && (actual.ragZipSha256 !== expected[1] || actual.projectConfigSha256 !== expected[2])) {
      throw new Error(`The cached diagnosis package ${entry} differs from the one the release dry-run recorded. A new dry-run is needed.`);
    }
    console.log(`[customer-workspace] diagnosis package from cache ${key.slice(0, 12)}…`);
    return { dir: entry, cache: { key, ...actual, hit: true } };
  }
  if (expected) {
    throw new Error(`No cached diagnosis package for key ${key.slice(0, 12)}… under ${resolve(cacheRoot)}. A new dry-run is needed.`);
  }
  const output = mkdtempSync(join(tmpdir(), `rv-rag-${projectKey}-`));
  try {
    build(output);
    mkdirSync(entry, { recursive: true });
    copyFileSync(join(output, 'rag.zip'), files.zip);
    copyFileSync(join(output, 'project-config.json'), files.config);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
  const meta = { key, ragZipSha256: sha256File(files.zip), projectConfigSha256: sha256File(files.config), createdAt: new Date().toISOString() };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  console.log(`[customer-workspace] diagnosis package built and cached under ${key.slice(0, 12)}…`);
  return { dir: entry, cache: { key, ragZipSha256: meta.ragZipSha256, projectConfigSha256: meta.projectConfigSha256, hit: false } };
}

function initializeLfsIndex(workspaceRoot) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['lfs', 'install', '--local'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: workspaceRoot, stdio: 'ignore' });
  assertLfsPointer(workspaceRoot);
}

//! Keeps the dependency archive for the delivered package-lock.json available on the CDN and
//! pins it into the workspace, so a customer start can restore node_modules from one verified
//! download. Publishing is skipped when the archive is already there; a missing archive or
//! missing credentials only costs the customer the npm ci fallback, so it never fails the run.
async function writeDependencyPin(workspaceRoot, stagedCore, args) {
  if (args.includes('--no-deps-archive')) return null;
  const module = join(privateRoot, 'scripts', 'pack-dependencies.mjs');
  if (!existsSync(module)) return null;
  const {
    archiveName, archiveTarget, lockFingerprint, packDependencies, publishDependencies,
    dependenciesPublished, loadBunnyEnvironment,
  } = await import(pathToFileURL(module).href);
  const target = archiveTarget();
  const url = `https://web.realvirtual.io/download/deps/${archiveName(stagedCore, target)}`;
  const pin = { url, target, lockFingerprint: lockFingerprint(stagedCore) };
  try {
    if (await dependenciesPublished(url)) {
      const cached = JSON.parse(readFileSync(join(resolve(process.env.RV_DELIVER_TMP ?? tmpdir()), `${archiveName(stagedCore, target)}.json`), 'utf8'));
      writeFileSync(join(workspaceRoot, 'dependencies.lock.json'), JSON.stringify({ ...pin, sha256: cached.sha256, bytes: cached.bytes }, null, 2) + '\n');
      console.log(`[customer-workspace] dependency archive already published: ${url}`);
      return pin;
    }
    loadBunnyEnvironment(coreRoot);
    const output = resolve(process.env.RV_DELIVER_TMP ?? tmpdir());
    console.log('[customer-workspace] packing the dependency archive (first delivery for this package-lock.json) ...');
    const packed = packDependencies(stagedCore, output, { target });
    await publishDependencies(packed.path);
    writeFileSync(join(output, `${archiveName(stagedCore, target)}.json`), JSON.stringify({ sha256: packed.sha256, bytes: packed.bytes }) + '\n');
    writeFileSync(join(workspaceRoot, 'dependencies.lock.json'), JSON.stringify({ ...pin, sha256: packed.sha256, bytes: packed.bytes }, null, 2) + '\n');
    console.log(`[customer-workspace] published dependency archive: ${url} (${(packed.bytes / 1024 / 1024).toFixed(1)} MB)`);
    return pin;
  } catch (error) {
    console.warn(`[customer-workspace] WARNING: no dependency archive delivered (${error.message}); the customer falls back to npm ci.`);
    return null;
  }
}

//! Reads the core commit of the delivery that currently sits on the customer remote.
function previousCoreCommit(clone) {
  try {
    return JSON.parse(readFileSync(join(clone, 'delivery-manifest.json'), 'utf8')).coreCommit ?? null;
  } catch {
    return null;
  }
}

/**
 * Clones the customer repository, writes this delivery into it and pushes.
 *
 * Atomicity is the whole point of the temp clone and is preserved here: every
 * write lands in a throwaway directory, and the push happens only after the
 * snapshot has been applied in full. An abort anywhere in between — including
 * the `--projects` confirmation gate — leaves the customer's repository exactly
 * as it was.
 *
 * The ORDER inside is normative (plan-738 §2.5): the preview reads the clone
 * before `applySnapshot` deletes anything. Run the other way round it would
 * compare the new content against itself, report nothing, and be indis-
 * tinguishable from a delivery that destroyed nothing.
 *
 * The branch is pushed WITHOUT `--force`, and that is the TOCTOU backstop: a
 * customer commit landing between the preview and the push makes the push a
 * non-fast-forward, so it fails and nothing is published. Only the tag is
 * force-pushed, exactly as before.
 *
 * A dry run (`push: false`) with `--projects` takes the same path as far as the
 * preview and then stops: it clones, renders the before-view and returns without
 * writing anything at all. Without `--projects` a dry run does not clone.
 *
 * @param replaceProjects  project folders `--projects` named, already resolved
 * @param force            apply the replace unattended, without the confirmation
 */
/**
 * Build the `.js` sibling of every `scriptRef`, in the STAGED copy (plan-479 Phase 7).
 *
 * ## Why here and not in `deliver.mjs`
 *
 * A `scriptRef` is resolved two ways: the build glob (for a project that was
 * bundled with the app) and the runtime loader, which imports a compiled `.js`
 * sitting next to the referenced `.ts`. The first shadows the second, so a
 * missing sibling is invisible in-house and only shows up at a customer, as a
 * plugin that silently loads nothing.
 *
 * The obvious fix — a `--check` gate before the push — cannot work: there is no
 * compiled sibling anywhere in the project tree, so the gate would fail every
 * delivery on its first run and it can only ever report, never produce. And
 * building in the SOURCE tree is worse than it looks: `deliver.mjs` asserts a
 * clean private tree and states outright that it never auto-commits, so a build
 * against `privateRoot` would run after that check, leave the tree dirty, and
 * break the NEXT delivery instead of this one.
 *
 * The staged copy has neither problem. It is a throwaway tree this script
 * already assembles and whose contents are committed into the customer clone a
 * few steps later, so the artefact travels with the delivery, no `.js` is ever
 * written into the private repository, and the source tree stays untouched —
 * which `tests/compile-project-scripts.node.test.ts` pins with
 * `git status --porcelain`.
 *
 * A failure THROWS: an unbuildable plugin delivered anyway is a customer
 * discovering a dead feature, which is precisely the outcome this exists to
 * prevent. `--check` keeps its own job as the CI verification between deliveries.
 */
export async function compileStagedProjectScripts(workspaceRoot, projectKeys) {
  const failures = [];
  for (const key of projectKeys) {
    const dir = join(workspaceRoot, 'projects', key);
    if (!existsSync(join(dir, 'project.json'))) continue;
    const { status, reason, results } = await compileProjectDir(dir);
    if (status === 'skipped') {
      console.log(`[project-scripts] skip ${key}: ${reason}`);
      continue;
    }
    for (const r of results) {
      if (r.status === 'failed') failures.push(`${key}/${r.ref}: ${r.reason}`);
      else console.log(`[project-scripts] ${r.status} ${key}/${r.out ?? r.ref}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      'project scripts did not compile, so the delivery was stopped before anything was '
      + `committed or pushed:\n  ${failures.join('\n  ')}`,
    );
  }
}

/**
 * The change part of a delivery commit body (plan-679 Phase 6, D7 / A6).
 *
 * The released CHANGELOG sections between the customer's baseline version (`delivery/<version>`)
 * and this version, without `**Internal**`. `requireReleaseNotes` (the release path, with a
 * receipt): no section is an ERROR — the commit must carry what was approved. Otherwise (a manual
 * single delivery) the old commit-subject summary is the fallback.
 */
export function deliveryCommitNotes({ coreRoot, baselineTag, version, previousCoreCommit: previous = null, requireReleaseNotes = false }) {
  const notes = releaseNotesBetween(coreRoot, versionOfBaselineTag(baselineTag), version);
  if (notes) return `Release notes:\n\n${notes}`;
  if (requireReleaseNotes) {
    throw new Error(`CHANGELOG.md has no released section for ${version}; a release delivery must carry the `
      + 'approved release notes in its commit. Promote "## Unreleased" first (/release-web).');
  }
  return deliveryChangelog(coreRoot, previous);
}

export function snapshotPush({
  workspaceRoot, remote, version, plasticChangeset = null,
  push = false, coreRoot = null, replaceProjects = [], force = false, acceptNewPrivateFiles = false,
  approvedPrivateFiles = null, requireReleaseNotes = false,
}) {
  const header = Number.isInteger(plasticChangeset) ? `viewer ${version}-${plasticChangeset}` : `viewer ${version}`;
  let message = header;
  // A dry run WITH `--projects` still clones and still renders the before-view (plan-739 F15).
  // Until this existed, the preview only ever ran on the push path, so the first time an
  // operator saw what a `--projects` run would destroy was the run that destroyed it. The
  // preview is pure reading — `previewProjectReplace` diffs two directories on disk — so the
  // dry run returns before the first write of any kind: no `git add`, no commit, no tag, no
  // push, and not even the local LFS filter install below.
  // Without `--projects` there is nothing to preview and the clone is pure cost, so the old
  // immediate return is kept for exactly that case.
  if (!push && replaceProjects.length === 0) return { pushed: false, remote, message, snapshot: null, preview: null };
  const clone = mkdtempSync(join(tmpdir(), 'rv-customer-snapshot-'));
  try {
    execFileSync('git', ['clone', remote, clone], { stdio: 'inherit' });

    // ── The `--projects` gate, BEFORE anything is deleted (§2.5). ──────────
    const baseline = detectDeliveryBaseline(clone);
    // A first delivery seeds every project folder anyway, so `--projects` has
    // nothing to add and nothing to destroy — warned about in applySnapshot,
    // and skipped here so no confirmation is asked for a no-op (§2.4.4).
    const replace = baseline.firstDelivery ? [] : replaceProjects;
    const preview = replace.length ? previewProjectReplace(workspaceRoot, clone, replace) : null;
    if (!push) {
      if (!preview) {
        console.log('[dry-run] --projects has nothing to preview: the customer remote is empty, '
          + 'so this would be a first delivery and every project folder is seeded anyway.');
      } else {
        console.log(`[dry-run] --projects preview only: ${preview.total} file(s) would be replaced or deleted. `
          + 'Nothing was committed, tagged or pushed.');
      }
      return { pushed: false, remote, message, snapshot: null, preview };
    }
    // Read the manifest before the snapshot overwrites it: it names the previously
    // delivered core commit, which bounds the change summary for the customer.
    // plan-679 Phase 6 (D7): the body carries the APPROVED release notes — the CHANGELOG sections
    // since the version of the customer's baseline — not raw commit subjects. On the release path
    // (receipt) a missing section is an error; a manual single delivery falls back to the subjects.
    const changelog = coreRoot
      ? deliveryCommitNotes({ coreRoot, baselineTag: baseline.baselineTag, version, previousCoreCommit: previousCoreCommit(clone), requireReleaseNotes })
      : '';
    // Read while the clone still carries the customer's copy: it is what decides whether this
    // is the first delivery under the new model, and therefore whether the commit explains it.
    const previousManifestVersion = readCloneDeliveryManifest(clone).manifestVersion;
    // LFS filters must be active in the clone before any large file is added, so that
    // `git add` stages LFS pointers instead of full blobs (verified by assertLfsPointer).
    // It only affects the `git add` far below, so its place after the dry-run return costs
    // the push path nothing and keeps the dry run free of every write.
    execFileSync('git', ['lfs', 'install', '--local'], { cwd: clone, stdio: 'ignore' });
    if (preview) confirmProjectReplace(preview, { force });

    const snapshot = applySnapshot(workspaceRoot, clone, { version, replaceProjects: replaceProjects });
    console.log(formatSnapshotSummary(snapshot));
    // The tier diff gate (§2.4). It runs before `git add`, so an abort here leaves the
    // customer repository untouched — the clone is thrown away by the finally block.
    const inventoryDiff = assertPrivateSourceInventory(
      readBaselineSourceInventory(clone, snapshot.baselineTag),
      collectPrivateSourceInventory(workspaceRoot),
      // plan-679 Phase 4: the release path brings the APPROVED list; the blanket flag stays for
      // the manual single delivery only.
      { acceptNew: acceptNewPrivateFiles, approved: approvedPrivateFiles },
    );
    if (!inventoryDiff.gated) {
      console.log('[tier-gate] first delivery for this customer; no baseline inventory to compare against.');
    } else {
      if (inventoryDiff.added.length) {
        console.log(`[tier-gate] ${inventoryDiff.added.length} new private source file(s) accepted via `
          + `${approvedPrivateFiles ? 'the approved list' : '--accept-new-private-files'}:`);
        for (const path of inventoryDiff.added) console.log(`[tier-gate]   + ${path}`);
      }
      for (const path of inventoryDiff.approvedUnused ?? []) {
        console.log(`[tier-gate]   (approved, but no longer new: ${path})`);
      }
      // A removal never blocks, but it must be visible: a file that silently stops
      // being delivered is how a customer loses a feature without anyone noticing.
      for (const path of inventoryDiff.removed) console.log(`[tier-gate]   - ${path} (no longer delivered)`);
    }
    // The one place the customer is told the delivery model changed: the commit
    // that changes it (F9). It appears exactly once, because from the next
    // delivery on the repository already carries a v3 manifest.
    message = [header, changelog, changeoverCommitNote(previousManifestVersion, snapshot)]
      .filter(Boolean).join('\n\n');
    execFileSync('git', ['add', '-A'], { cwd: clone, stdio: 'inherit' });
    assertLfsPointer(clone);
    execFileSync('git', ['commit', '-m', message], { cwd: clone, stdio: 'inherit' });
    // The tag IS the merge basis of the next delivery (§2.4), so it must be pushed
    // with the commit it marks — and forced, because re-delivering the same viewer
    // version after a correction is routine and must not need manual tag surgery.
    const tag = baselineTagFor(version);
    execFileSync('git', ['tag', '-f', tag], { cwd: clone, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'HEAD:main'], { cwd: clone, stdio: 'inherit' });
    execFileSync('git', ['push', '--force', 'origin', `refs/tags/${tag}`], { cwd: clone, stdio: 'inherit' });
    return { pushed: true, remote, message, snapshot, baselineTag: tag };
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

// ─── release check (plan-679 Phase 4) ─────────────────────────────────────

//! Schema version of the per-target release-check result file.
export const RELEASE_CHECK_SCHEMA_VERSION = 1;

//! The id a release run uses for a delivery target: `<org>/<repo>` for the shared repository,
//! the customer slug otherwise — the key of the approved-files map (`--accept-private-files`).
export function releaseTargetId(delivery) {
  return delivery.sharedRepo ? `${SHARED_ORG}/${SHARED_REPO}` : delivery.customer;
}

/**
 * Reads the approved private files of one target from an approval/receipt-style file:
 * `{ "<target>": [paths] }` at the top level or under `privateFiles`. A target the file does not
 * name has approved nothing (`[]`), which is the safe reading.
 */
export function readApprovedPrivateFiles(path, targetId) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const map = data && typeof data === 'object' && data.privateFiles && typeof data.privateFiles === 'object'
    ? data.privateFiles : data;
  const list = map?.[targetId] ?? [];
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path}: the approved private files of "${targetId}" must be a list of paths.`);
  }
  return [...list];
}

/**
 * Runs every check of one delivery target WITHOUT pushing, cloning a working tree or uploading
 * anything, and collects ALL findings instead of stopping at the first (plan-679 F4/F5).
 *
 * Independent checks: (i) diagnosis inputs, (ii) staging + guards (collect mode), (iii) build incl.
 * notices, (iv) remote baseline + tier diff (needs only the staged tree). A check that depends on a
 * failed one is reported as `not-run: <reason>`, never as passed. A diagnosis failure does not stop
 * the rest: the target is staged without the package and stays `ok: false`.
 *
 * New private files are an APPROVAL finding (severity `approval`), not an error: they go into the
 * release-notes approval, and `ok` stays true.
 *
 * `deps` are the real pipeline steps in production and fakes in the tests.
 */
export async function runReleaseCheck(context, deps) {
  const startedAt = Date.now();
  const timings = {};
  const time = async (name, fn) => {
    const t0 = Date.now();
    try { return await fn(); } finally { timings[name] = Math.round((Date.now() - t0) / 100) / 10; }
  };
  const findings = [];
  const checks = {};
  const error = (check, message) => findings.push({ check, severity: 'error', message });
  const { delivery, projectKey, args } = context;
  const wantsDiagnosis = Boolean(projectKey) && !args.includes('--no-rag');

  // (i) diagnosis — never blocks the other checks.
  let rag = null;
  let diagnosis = wantsDiagnosis ? 'yes' : 'none';
  if (wantsDiagnosis) {
    const unavailable = arg(args, 'diagnosis-unavailable');
    if (unavailable) {
      error('diagnosis', unavailable);
      diagnosis = 'failed';
    } else {
      try {
        rag = await time('rag', () => deps.resolveRag());
      } catch (failure) {
        error('diagnosis', `diagnosis package could not be built: ${failure.message}`);
        diagnosis = 'failed';
      }
    }
  }
  checks.diagnosis = diagnosis === 'failed' ? 'failed' : 'ok';

  // (ii) staging + guards.
  let staged = null;
  try {
    staged = await time('staging', () => deps.stage({ connectArtifacts: rag?.dir ?? null }));
    checks.staging = 'ok';
  } catch (failure) {
    error('staging', failure.message);
    checks.staging = 'failed';
  }
  const notRun = (why) => `not-run: ${why}`;
  let guardsFailed = false;
  if (staged) {
    const collected = [];
    try {
      await time('guards', () => deps.guards(staged, collected));
    } catch (failure) {
      collected.push({ guard: 'guards', kind: 'fatal', message: failure.message });
    }
    for (const entry of collected) error(`guard:${entry.guard}`, entry.message);
    guardsFailed = collected.length > 0;
    checks.guards = guardsFailed ? 'failed' : 'ok';
  } else {
    checks.guards = notRun('staging failed');
  }

  // (iv) remote baseline + tier diff — needs the staged tree, not the build.
  let tierDiff = null;
  if (staged) {
    try {
      const remote = await time('remote', () => deps.readRemote(delivery.remote));
      const current = deps.collectInventory(staged);
      if (remote.damage) error('tier-diff', `${remote.damage} — without a baseline the approval list cannot be right.`);
      // The binding gate's own comparison — no second algorithm.
      const diff = diffPrivateSourceInventory(remote.inventory, current);
      tierDiff = { baselineTag: remote.baselineTag, gated: diff.gated, trusted: diff.trusted, reason: diff.reason, added: diff.added, removed: diff.removed };
      for (const path of diff.added) findings.push({ check: 'tier-diff', severity: 'approval', message: `new private source file: ${path}` });
      checks.tierDiff = remote.damage ? 'failed' : 'ok';
    } catch (failure) {
      error('tier-diff', failure.message);
      checks.tierDiff = 'failed';
    }
  } else {
    checks.tierDiff = notRun('staging failed');
  }

  // (iii) build incl. third-party notices. Runs after a guard finding too: the guards report
  // content, the build is independent of it, and the point is every finding in one run.
  if (staged) {
    try {
      await time('build', () => deps.build(staged));
      checks.build = 'ok';
    } catch (failure) {
      error('build', failure.message);
      checks.build = 'failed';
    }
  } else {
    checks.build = notRun('staging failed');
  }

  const result = {
    schemaVersion: RELEASE_CHECK_SCHEMA_VERSION,
    target: releaseTargetId(delivery),
    customer: delivery.customer,
    remote: delivery.remote,
    releaseVersion: context.releaseVersion,
    viewerVersion: context.viewerVersion,
    coreHead: context.coreHead,
    privateHead: context.privateHead,
    projects: [...(delivery.projects ?? [])],
    diagnosis,
    rag: rag?.cache ? { cacheKey: rag.cache.key, ragZipSha256: rag.cache.ragZipSha256, projectConfigSha256: rag.cache.projectConfigSha256, cacheHit: rag.cache.hit } : null,
    connectPin: context.connectPin ?? null,
    ok: !findings.some((finding) => finding.severity === 'error'),
    checks,
    findings,
    tierDiff,
    timings: { ...timings, total: Math.round((Date.now() - startedAt) / 100) / 10 },
  };
  if (context.outFile) {
    mkdirSync(dirname(resolve(context.outFile)), { recursive: true });
    writeFileSync(resolve(context.outFile), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

async function releaseCheckMain(args) {
  if (args.includes('--push')) throw new Error('--release-check never pushes; it cannot be combined with --push.');
  const outFile = requireArg(args, 'release-check');
  const releaseVersion = requireArg(args, 'release-version');
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(releaseVersion)) throw new Error(`--release-version must be X.Y.Z (got "${releaseVersion}").`);
  const manifest = loadTierManifest(privateRoot);
  const customer = arg(args, 'customer');
  const delivery = customer
    ? loadDeliveryConfigByCustomer(privateRoot, customer, manifest)
    : loadDeliveryConfig(privateRoot, requireArg(args, 'project'), manifest);
  const projectKey = delivery.projectKey;
  const projectDir = projectKey ? join(privateRoot, 'projects', projectKey) : null;
  const project = projectDir ? JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) : null;
  // The check runs BEFORE the tag exists: no tag requirement here (the push path keeps it).
  const core = gitProvenance(coreRoot, { requireTag: false });
  const privateRepo = gitProvenance(privateRoot);
  const plasticChangeset = readPlasticChangeset(resolve(coreRoot, '../../../..'));
  const connectPin = JSON.parse(readFileSync(resolve(requireArg(args, 'connect-lock')), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'));
  let stagedRoot = null;
  const tmpBase = resolve(process.env.RV_DELIVER_TMP ?? tmpdir());
  try {
    const result = await runReleaseCheck({
      args, delivery, projectKey, outFile, releaseVersion,
      viewerVersion: packageJson.version,
      coreHead: core.commit,
      privateHead: privateRepo.commit,
      connectPin: { channel: delivery.connectChannel, ...connectPin },
    }, {
      resolveRag: () => resolveRagPair(args, projectKey, projectDir),
      stage: async ({ connectArtifacts }) => {
        const staged = stageFilteredSourceTree({
          coreRoot, privateRoot, projectKey, projectKeys: delivery.projects, project, delivery,
          profile: { tier: delivery.tier, restrictedFeatures: delivery.restrictedFeatures },
          librarySources: librarySourcesOf(args),
          connectArtifacts,
          hasDiagnosis: connectArtifacts !== null,
          connectPin: { channel: delivery.connectChannel, ...connectPin },
        });
        stagedRoot = staged.workspaceRoot;
        await compileStagedProjectScripts(staged.workspaceRoot, staged.projectKeys);
        initializeLfsIndex(staged.workspaceRoot);
        const stagedProjects = Object.fromEntries(staged.projectKeys.map((key) =>
          [key, JSON.parse(readFileSync(join(staged.workspaceRoot, 'projects', key, 'project.json'), 'utf8'))]));
        const deliveryManifest = createDeliveryManifest({
          core, privateRepo,
          profile: { tier: delivery.tier, restrictedFeatures: delivery.restrictedFeatures },
          connect: { channel: delivery.connectChannel, ...connectPin },
          projectRoot: projectDir,
          viewerVersion: packageJson.version,
          plasticChangeset,
          projects: stagedProjects,
          privateSources: collectPrivateSourceInventory(staged.workspaceRoot),
        });
        // Stamped so a staged release-check tree can never be mistaken for a delivery: it was
        // built from an untagged HEAD, for a version that does not exist yet.
        deliveryManifest.releaseCheck = { releaseVersion };
        writeFileSync(join(staged.workspaceRoot, 'delivery-manifest.json'), JSON.stringify(deliveryManifest, null, 2) + '\n');
        assertNoCrossTierLeak(staged.workspaceRoot, manifest, delivery);
        return staged;
      },
      guards: (staged, collect) => assertWorkspaceGuards(staged.workspaceRoot, {
        projectKey,
        projectKeys: staged.projectKeys,
        knownProjectKeys: knownProjectKeys(privateRoot, { kind: 'customer' }),
        lfsRepoRoot: staged.workspaceRoot,
        collect,
      }),
      // No dependency archive in a release check, whatever the flags say (Gate R1 finding 4):
      // packing and uploading it is a write to the CDN, and the check writes nothing anywhere.
      build: (staged) => {
        let build;
        try {
          build = runBuild(staged.workspaceRoot, { mode: 'private', projectKey, fast: args.includes('--fast'), noticesTier: delivery.tier });
        } catch (error) {
          // The build streams to the console; its cause (a [rv-third-party-notices] violation, a
          // compile error) stands right above this line in the log, not in the exception.
          throw new Error(`${error.message} — the cause is in the build output above `
            + '(look for "error during build", e.g. [rv-third-party-notices] licence-policy violations).');
        }
        const html = join(build.coreRoot, 'dist', 'index.html');
        if (existsSync(html) && readFileSync(html, 'utf8').includes('rv-watermark')) {
          throw new Error('the built index.html still carries the AGPL watermark (#rv-watermark); a commercial delivery must not.');
        }
        if (existsSync(html) && readFileSync(html, 'utf8').includes('rv-demo-notice')) {
          throw new Error('the built index.html carries the public-demo notice (#rv-demo-notice); a customer delivery must not.');
        }
        return build;
      },
      readRemote: (remote) => readRemoteBaselineInventory(remote, { tmpBase }),
      collectInventory: (staged) => collectPrivateSourceInventory(staged.workspaceRoot),
    });
    const errors = result.findings.filter((finding) => finding.severity === 'error');
    const approvals = result.findings.filter((finding) => finding.severity === 'approval');
    console.log(`[release-check] ${result.target}: ${result.ok ? 'OK' : 'FAILED'} — ${errors.length} error(s), `
      + `${approvals.length} new private file(s) for approval, diagnosis ${result.diagnosis}, ${result.timings.total}s.`);
    for (const finding of errors) console.log(`[release-check]   ERROR ${finding.check}: ${finding.message.split('\n')[0]}`);
    for (const finding of approvals) console.log(`[release-check]   approve ${finding.message}`);
    console.log(`[release-check] result: ${resolve(outFile)}`);
    if (!result.ok) process.exitCode = 2;
  } finally {
    if (stagedRoot && !args.includes('--keep-staging')) rmSync(stagedRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--release-check')) {
    await releaseCheckMain(args);
    return;
  }
  const push = args.includes('--push');
  const fast = args.includes('--fast');
  const force = args.includes('--force');
  const requestedProjects = listArg(args, 'projects');
  if (args.includes('--seed-missing')) {
    throw new Error('--seed-missing was removed with plan-738. There is no per-file merge left to seed into; '
      + 'update a project folder with --projects <name…|all> instead.');
  }
  const acceptNewPrivateFiles = args.includes('--accept-new-private-files');
  const manifest = loadTierManifest(privateRoot);
  // Either one project (the primary; its customer's other projects come along) or a
  // whole customer. Both end at the same delivery config — one customer repository.
  const customer = arg(args, 'customer');
  const delivery = customer
    ? loadDeliveryConfigByCustomer(privateRoot, customer, manifest)
    : loadDeliveryConfig(privateRoot, requireArg(args, 'project'), manifest);
  // plan-679 Phase 4: the approved list from the release approval replaces the blanket flag.
  const approvalFile = arg(args, 'accept-private-files');
  if (approvalFile && acceptNewPrivateFiles) {
    throw new Error('--accept-private-files and --accept-new-private-files exclude each other; the release path uses the approved list.');
  }
  const approvedPrivateFiles = approvalFile ? readApprovedPrivateFiles(resolve(approvalFile), releaseTargetId(delivery)) : null;
  // A `standard` customer carries no projects (plan-434 Phase 4): no primary key,
  // no project directory, no project.json. `null` travels all the way down —
  // staging, the generated files and the manifest each have a projectless form.
  const projectKey = delivery.projectKey;
  const projectKeys = delivery.projects;
  const projectDir = projectKey ? join(privateRoot, 'projects', projectKey) : null;
  const project = projectDir ? JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) : null;
  if (!projectKey) {
    console.log(`[customer-workspace] ${delivery.kind ?? 'standard'} customer "${delivery.customer}": `
      + 'projectless delivery, no RAG.');
  }
  const core = gitProvenance(coreRoot, { requireTag: true });
  const privateRepo = gitProvenance(privateRoot);
  const plasticChangeset = readPlasticChangeset(resolve(coreRoot, '../../../..'));
  const connectPinPath = resolve(requireArg(args, 'connect-lock'));
  const connectPin = JSON.parse(readFileSync(connectPinPath, 'utf8'));
  if (!/\/versions\//.test(new URL(connectPin.url).pathname) || !/^[0-9a-f]{64}$/i.test(connectPin.sha256)) {
    throw new Error('connect.lock.json must contain an immutable versions URL and SHA-256.');
  }

  const ragArtifacts = buildRagPair(args, projectKey, projectDir);
  const staged = stageFilteredSourceTree({
    coreRoot, privateRoot, projectKey, projectKeys, project, delivery,
    profile: { tier: delivery.tier, restrictedFeatures: delivery.restrictedFeatures },
    librarySources: librarySourcesOf(args),
    connectArtifacts: ragArtifacts,
    hasDiagnosis: ragArtifacts !== null,
    connectPin: { channel: delivery.connectChannel, ...connectPin },
  });
  try {
    const packageJson = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf8'));
    // The Git index of the staging tree is the source of the staged-side blob OIDs
    // (§2.4). It has to exist BEFORE they are read, and `git hash-object` outside a
    // repository is not a substitute: without a repo the LFS clean filter never
    // runs, so the staged side would hash the real GLB while the clone hashes its
    // pointer, and every vendor file would report as a conflict forever.
    // BEFORE the index and before every write to the customer clone: the `.js`
    // siblings have to exist while the staged tree is being hashed and copied,
    // and a compile failure must stop the delivery while nothing has been
    // committed. See compileStagedProjectScripts.
    await compileStagedProjectScripts(staged.workspaceRoot, staged.projectKeys);
    initializeLfsIndex(staged.workspaceRoot);
    const stagedProjects = Object.fromEntries(staged.projectKeys.map((key) =>
      [key, JSON.parse(readFileSync(join(staged.workspaceRoot, 'projects', key, 'project.json'), 'utf8'))]));
    const deliveryManifest = createDeliveryManifest({
      core,
      privateRepo,
      profile: { tier: delivery.tier, restrictedFeatures: delivery.restrictedFeatures },
      connect: { channel: delivery.connectChannel, ...connectPin },
      // null for a projectless delivery — see createDeliveryManifest.
      projectRoot: projectDir,
      viewerVersion: packageJson.version,
      plasticChangeset,
      projects: stagedProjects,
      // Recorded at staging time, from the tree that is actually about to be delivered
      // — this is what the NEXT delivery diffs against (§2.4).
      privateSources: collectPrivateSourceInventory(staged.workspaceRoot),
    });
    writeFileSync(join(staged.workspaceRoot, 'delivery-manifest.json'), JSON.stringify(deliveryManifest, null, 2) + '\n');
    assertNoCrossTierLeak(staged.workspaceRoot, manifest, delivery);
    assertWorkspaceGuards(staged.workspaceRoot, {
      projectKey,
      projectKeys: staged.projectKeys,
      // Read from disk, never hardcoded (B4). The list this replaced named four
      // of six projects; `festo` and `demo-realvirtual` were missing, which meant
      // the foreign-customer-name guard could not recognise them — and that guard
      // exists precisely to stop one customer's material reaching another.
      //
      // Narrowed to `kind: 'customer'` in plan-434 §2.6. The guard aborts a
      // delivery when a foreign project's NAME appears anywhere in the staged
      // tree, so every extra name in this list is a way for the delivery to fail
      // over nothing: `festo`, `new-project` and `demo-realvirtual` are words a
      // demo scene, a fixture path or a doc sentence legitimately contains. Only
      // a folder that declares itself customer material carries the secret this
      // guard defends — a name that must never surface in another customer's
      // repository.
      knownProjectKeys: knownProjectKeys(privateRoot, { kind: 'customer' }),
      lfsRepoRoot: staged.workspaceRoot,
    });
    // noticesTier (plan-679 Phase 3): the licence check judges this build as its delivery tier.
    const build = runBuild(staged.workspaceRoot, { mode: 'private', projectKey, fast, noticesTier: delivery.tier });
    if (fast) console.log(`[customer-workspace] build cache ${build.cacheStatus === 'hit' ? `hit (${build.cacheMethod})` : 'rebuild'}.`);
    await writeDependencyPin(staged.workspaceRoot, build.coreRoot, args);
    const result = snapshotPush({
      workspaceRoot: staged.workspaceRoot,
      remote: delivery.remote,
      version: packageJson.version,
      plasticChangeset,
      push,
      coreRoot,
      // Resolved against what this delivery CARRIES, never against what is in the
      // customer's `projects/`: `all` means our project folders plus the demo, and
      // no spelling of the flag can reach a folder they created (§2.4.3).
      replaceProjects: resolveRequestedProjects(requestedProjects, staged.projectKeys),
      force,
      acceptNewPrivateFiles,
      approvedPrivateFiles,
      // With a receipt this IS a release delivery: its commit must carry the approved notes.
      requireReleaseNotes: Boolean(arg(args, 'receipt')),
    });
    // Provenance is recorded only for a push that actually landed, and on the
    // SOURCE manifests, not the staged copies about to be deleted (§2.8 / B15).
    // A dry run delivers nothing, so it must claim nothing.
    if (result.pushed) {
      for (const key of staged.projectKeys) {
        try {
          recordPublishProvenance(join(privateRoot, 'projects', key), 'delivery', {
            version: packageJson.version,
            coreCommit: core?.commit,
          });
        } catch (error) {
          console.error(`[customer-workspace] provenance not recorded for ${key}: ${error.message}`);
        }
      }
    }
    console.log(JSON.stringify({ workspace: staged.workspaceRoot, pushed: result.pushed, remote: result.remote, message: result.message }));
    if (!push) console.log('[dry-run] no remote was modified; pass --push only after reviewing the staged workspace.');
  } finally {
    if (!args.includes('--keep-staging')) rmSync(staged.workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[customer-workspace] ${error.message}`);
    // The machine-readable contract of F4: 1 means "differences were shown and
    // nobody confirmed them" — a decision, not a defect — and 2 is every real
    // failure. A caller that treats them the same still stops; one that tells
    // them apart can retry with --force without retrying a broken build.
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 2;
  });
}
