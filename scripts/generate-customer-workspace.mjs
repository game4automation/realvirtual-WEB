// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  formatSnapshotSummary,
  gitProvenance,
  loadDeliveryConfig,
  loadDeliveryConfigByCustomer,
  loadTierManifest,
  previewProjectReplace,
  readBaselineSourceInventory,
  readCloneDeliveryManifest,
  readPlasticChangeset,
  resolveRequestedProjects,
  runBuild,
  stageFilteredSourceTree,
} from './_workspace-lib.mjs';
import { knownProjectKeys } from './_rv-guards.mjs';
import { recordPublishProvenance } from './_rv-provenance.mjs';

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
export function snapshotPush({
  workspaceRoot, remote, version, plasticChangeset = null,
  push = false, coreRoot = null, replaceProjects = [], force = false, acceptNewPrivateFiles = false,
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
    const changelog = coreRoot ? deliveryChangelog(coreRoot, previousCoreCommit(clone)) : '';
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

async function main() {
  const args = process.argv.slice(2);
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
