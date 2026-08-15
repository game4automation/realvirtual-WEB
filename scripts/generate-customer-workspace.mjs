// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyMergedSnapshot,
  assertLfsPointer,
  assertNoCrossTierLeak,
  assertPrivateSourceInventory,
  assertWorkspaceGuards,
  collectPrivateSourceInventory,
  createDeliveryManifest,
  deliveryChangelog,
  formatMergeSummary,
  gitProvenance,
  loadDeliveryConfig,
  loadDeliveryConfigByCustomer,
  loadTierManifest,
  mergeCommitNote,
  readBaselineSourceInventory,
  readPlasticChangeset,
  runBuild,
  stageFilteredSourceTree,
} from './_workspace-lib.mjs';
import { baselineTagFor } from './_vendor-merge.mjs';
import { knownProjectKeys } from './_rv-guards.mjs';
import { recordPublishProvenance } from './_rv-provenance.mjs';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(coreRoot, '../realvirtual-WebViewer-Private~');
const connectTools = resolve(coreRoot, '../realvirtual-Connect~/tools');

function arg(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
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
  if (supplied) return resolve(supplied);
  const seedIndex = requireArg(args, 'seed-index');
  const diagnosisConfig = requireArg(args, 'diagnosis-config');
  const output = mkdtempSync(join(tmpdir(), `rv-rag-${projectKey}-`));
  execFileSync(process.execPath, [join(connectTools, 'bundle-rag.mjs'),
    '--project-dir', projectDir,
    '--project', projectKey,
    '--output-dir', output,
    '--seed-index', resolve(seedIndex),
    '--extra-config', resolve(diagnosisConfig),
  ], { stdio: 'inherit', env: process.env });
  return output;
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
 * Clones the customer repository, merges this delivery into it and pushes.
 *
 * Atomicity is the whole point of the temp clone and is preserved here: every
 * write lands in a throwaway directory, and the push happens only after the
 * merge has completed for ALL projects. An abort anywhere in between leaves the
 * customer's repository exactly as it was.
 *
 * `projects` carries the vendor block per project — the merge needs it, and it
 * comes from the manifest we are delivering, not from the customer's copy.
 */
export function snapshotPush({
  workspaceRoot, remote, projects, version, plasticChangeset = null,
  push = false, coreRoot = null, seedMissing = false, acceptNewPrivateFiles = false,
}) {
  const header = Number.isInteger(plasticChangeset) ? `viewer ${version}-${plasticChangeset}` : `viewer ${version}`;
  let message = header;
  if (!push) return { pushed: false, remote, message, snapshot: null };
  const clone = mkdtempSync(join(tmpdir(), 'rv-customer-snapshot-'));
  try {
    execFileSync('git', ['clone', remote, clone], { stdio: 'inherit' });
    // Read the manifest before the snapshot overwrites it: it names the previously
    // delivered core commit, which bounds the change summary for the customer.
    const changelog = coreRoot ? deliveryChangelog(coreRoot, previousCoreCommit(clone)) : '';
    // LFS filters must be active in the clone before any large file is added, so that
    // `git add` stages LFS pointers instead of full blobs (verified by assertLfsPointer).
    execFileSync('git', ['lfs', 'install', '--local'], { cwd: clone, stdio: 'ignore' });
    const snapshot = applyMergedSnapshot(workspaceRoot, clone, { projects, version, seedMissing });
    const summary = formatMergeSummary(snapshot);
    if (summary) console.log(summary);
    // The tier diff gate (§2.4). It runs before `git add`, so an abort here leaves the
    // customer repository untouched — the clone is thrown away by the finally block.
    const inventoryDiff = assertPrivateSourceInventory(
      readBaselineSourceInventory(clone, snapshot.baselineTag),
      collectPrivateSourceInventory(workspaceRoot),
      { acceptNew: acceptNewPrivateFiles },
    );
    if (!inventoryDiff.gated) {
      console.log('[tier-gate] first delivery for this customer; no baseline inventory to compare against.');
    } else {
      if (inventoryDiff.added.length) {
        console.log(`[tier-gate] ${inventoryDiff.added.length} new private source file(s) accepted via --accept-new-private-files:`);
        for (const path of inventoryDiff.added) console.log(`[tier-gate]   + ${path}`);
      }
      // A removal never blocks, but it must be visible: a file that silently stops
      // being delivered is how a customer loses a feature without anyone noticing.
      for (const path of inventoryDiff.removed) console.log(`[tier-gate]   - ${path} (no longer delivered)`);
    }
    // A conflict is a normal, expected outcome, not a failure: the customer keeps
    // their file and we say so. It belongs in the commit message so it is visible
    // in the Forgejo history, and on stdout — never in an exit code.
    message = [header, changelog, mergeCommitNote(snapshot)].filter(Boolean).join('\n\n');
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

async function main() {
  const args = process.argv.slice(2);
  const push = args.includes('--push');
  const fast = args.includes('--fast');
  const seedMissing = args.includes('--seed-missing');
  const acceptNewPrivateFiles = args.includes('--accept-new-private-files');
  const manifest = loadTierManifest(privateRoot);
  // Either one project (the primary; its customer's other projects come along) or a
  // whole customer. Both end at the same delivery config — one customer repository.
  const customer = arg(args, 'customer');
  const delivery = customer
    ? loadDeliveryConfigByCustomer(privateRoot, customer, manifest)
    : loadDeliveryConfig(privateRoot, requireArg(args, 'project'), manifest);
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
    const build = runBuild(staged.workspaceRoot, { mode: 'private', projectKey, fast });
    if (fast) console.log(`[customer-workspace] build cache ${build.cacheStatus === 'hit' ? `hit (${build.cacheMethod})` : 'rebuild'}.`);
    await writeDependencyPin(staged.workspaceRoot, build.coreRoot, args);
    const result = snapshotPush({
      workspaceRoot: staged.workspaceRoot,
      remote: delivery.remote,
      // The vendor globs come from the manifest we are DELIVERING. Reading them from
      // the customer's copy would let an edited vendor block widen the zone that may
      // be overwritten — the one direction of this design that costs data (§2.2).
      projects: staged.projectKeys.map((key) => ({ key, vendor: stagedProjects[key]?.vendor ?? null })),
      version: packageJson.version,
      plasticChangeset,
      push,
      coreRoot,
      seedMissing,
      acceptNewPrivateFiles,
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
  main().catch((error) => { console.error(`[customer-workspace] ${error.message}`); process.exitCode = 1; });
}
