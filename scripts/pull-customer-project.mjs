// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pulls a project back OUT of a customer repository into the internal one
 * (plan-700 Phase 5, B3/B17/F15).
 *
 * This is the only path in the delivery tooling that writes into OUR repository
 * from material we do not control, and it used to do so with no diff, no backup
 * and no guard: `copyCustomerProject` deleted `projects/<key>/` and replaced it
 * with whatever the clone contained. Three things follow from that, and all
 * three are enforced here:
 *
 *   1. **Show before you write.** A diff is printed for every run, `--apply` or
 *      not, so the person running it sees what would change before it changes.
 *   2. **Never overwrite without a backup.** The internal state is copied aside
 *      before the first byte is written, and its location is printed.
 *   3. **Guard the incoming tree before it lands.** Secrets, nested `.git`,
 *      denied artefacts and manifest validity are checked on the clone — while
 *      rejecting it still costs nothing.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDeliveryConfig, loadTierManifest } from './_workspace-lib.mjs';
import { assertNoSecrets, isSecretPath } from './_rv-guards.mjs';
import { walk } from './_rv-fs-utils.mjs';
import { assertValidProject } from './validate-project.mjs';

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(coreRoot, '../realvirtual-WebViewer-Private~');

//! Reads a tree into `path -> sha256`, skipping build output and Git metadata.
//! Content, not timestamps: a Git checkout has no meaningful mtimes.
export function fingerprintTree(root) {
  const map = new Map();
  if (!existsSync(root)) return map;
  walk(root, (absolute, rel, entry) => {
    const first = rel.split('/')[0];
    if (entry.isDirectory()) return !['.git', 'node_modules', 'dist'].includes(entry.name);
    if (first === '.git') return;
    map.set(rel, createHash('sha256').update(readFileSync(absolute)).digest('hex'));
  });
  return map;
}

/**
 * Compares the incoming tree against the internal one.
 *
 * Returns added/changed/removed as plain path lists — the caller prints them and
 * decides. "Removed" is the interesting one: those are files that exist here and
 * would disappear, which is exactly what nobody saw before.
 */
export function diffTrees(internalRoot, incomingRoot) {
  const internal = fingerprintTree(internalRoot);
  const incoming = fingerprintTree(incomingRoot);
  const added = [];
  const changed = [];
  const removed = [];
  for (const [path, hash] of incoming) {
    if (!internal.has(path)) added.push(path);
    else if (internal.get(path) !== hash) changed.push(path);
  }
  for (const path of internal.keys()) if (!incoming.has(path)) removed.push(path);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/**
 * Rejects an incoming customer tree before anything is written.
 *
 * The delivery direction has had these guards since plan-296; the return
 * direction had none, which meant a secret the customer committed into their
 * project would travel into our repository and from there into the NEXT
 * delivery — to a different customer.
 */
export function assertIncomingTreeIsSafe(root, label) {
  walk(root, (absolute, rel, entry) => {
    const segments = rel.split('/');
    if (segments[0] === '.git') return false;
    if (entry.isDirectory()) {
      if (entry.name === '.git') throw new Error(`${label}: nested .git is forbidden (${rel}).`);
      return true;
    }
    if (isSecretPath(rel)) throw new Error(`${label}: secret-bearing file must not be pulled back: ${rel}`);
    // lstat, not stat: stat follows the link and would report the target.
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${label}: links are not allowed (${rel}).`);
    // Deliberately NOT isDeniedProjectArtifactPath(): that list says what may not be
    // PUBLISHED or embedded, and it names project.json and project-config.json —
    // precisely the two files a pull exists to bring back.
  });
  assertNoSecrets(root);
  // The manifest must still be a valid project, or we would import a state the
  // browser cannot open and the next delivery cannot validate.
  assertValidProject(root, label);
}

//! Copies the incoming tree over the internal one. Only ever called after the diff
//! has been printed, the guards have passed and a backup exists.
export function copyCustomerProject(source, destination) {
  if (!existsSync(source)) throw new Error(`Customer project path not found: ${source}`);
  const sourceRoot = resolve(source);
  const destinationRoot = resolve(destination);
  if (destinationRoot.startsWith(sourceRoot + '\\') || destinationRoot.startsWith(sourceRoot + '/')) {
    throw new Error('Recursive customer-repository nesting is forbidden.');
  }
  rmSync(destinationRoot, { recursive: true, force: true });
  mkdirSync(dirname(destinationRoot), { recursive: true });
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const from = join(sourceRoot, entry.name);
    const to = join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
    } else {
      mkdirSync(destinationRoot, { recursive: true });
      copyFileSync(from, to);
    }
  }
}

//! Copies the internal state aside before it is replaced, and returns where to.
export function backupInternalProject(internalRoot, projectKey) {
  const backup = join(mkdtempSync(join(tmpdir(), 'rv-pull-backup-')), projectKey);
  if (existsSync(internalRoot)) cpSync(internalRoot, backup, { recursive: true });
  return backup;
}

function printDiff(projectKey, diff) {
  const total = diff.added.length + diff.changed.length + diff.removed.length;
  console.log(`[pull] projects/${projectKey}: +${diff.added.length} neu  ~${diff.changed.length} geaendert  -${diff.removed.length} entfernt`);
  for (const path of diff.added) console.log(`  +  ${path}`);
  for (const path of diff.changed) console.log(`  ~  ${path}`);
  // The removals are the dangerous half: these files exist internally and the
  // customer tree does not have them, so applying makes them disappear here.
  for (const path of diff.removed) console.log(`  -  ${path}   (verschwindet im internen Repo)`);
  if (!total) console.log('  (keine Unterschiede)');
  return total;
}

//! Runs the whole pull; exported so the test can drive it without a real remote.
export async function pullCustomerProject({ projectKey, remote, apply = false, internalRoot = null }) {
  const target = internalRoot ?? join(privateRoot, 'projects', projectKey);
  const temp = mkdtempSync(join(tmpdir(), 'rv-customer-pull-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', remote, temp], { stdio: 'inherit' });
    const incoming = join(temp, 'projects', projectKey);
    if (!existsSync(incoming)) throw new Error(`The customer repository has no projects/${projectKey}.`);

    // Guards FIRST: a tree we would refuse is not worth diffing, and refusing it
    // before anything is written is the whole point.
    assertIncomingTreeIsSafe(incoming, `incoming projects/${projectKey}`);
    const diff = diffTrees(target, incoming);
    printDiff(projectKey, diff);

    if (!apply) {
      console.log('[dry-run] nichts geschrieben. Mit --apply uebernehmen.');
      return { applied: false, diff, backup: null };
    }
    const backup = backupInternalProject(target, projectKey);
    console.log(`[pull] Sicherung des internen Standes: ${backup}`);
    copyCustomerProject(incoming, target);
    console.log(`[pull] projects/${projectKey} uebernommen.`);
    return { applied: true, diff, backup };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project');
  const projectKey = projectIndex >= 0 ? args[projectIndex + 1] : null;
  if (!projectKey || projectKey.startsWith('--')) throw new Error('Usage: --project <key> [--apply].');
  const delivery = loadDeliveryConfig(privateRoot, projectKey, loadTierManifest(privateRoot));
  await pullCustomerProject({ projectKey, remote: delivery.remote, apply: args.includes('--apply') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[pull-customer-project] ${error.message}`); process.exitCode = 1; });
}
