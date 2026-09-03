// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * validate-project — CI gate for a realvirtual project folder (plan-372 Phase 15).
 *
 * A project is a git-managed directory that travels between machines, customers
 * and CI. Two classes of mistake are worth failing a build over:
 *
 *   1. **A manifest CI cannot read.** `project.json` is the entry point; a
 *      truncated or hand-edited one turns into a confusing runtime failure far
 *      from its cause.
 *   2. **A secret committed into a project.** Projects get zipped, mailed and
 *      pushed. A leaked API key is not a lint warning, it is an incident - so
 *      this check exits non-zero and names the file.
 *
 * Usage:
 *   node scripts/validate-project.mjs <project-dir> [--json]
 *
 * Exit codes: 0 = clean (warnings allowed), 1 = errors found, 2 = bad usage.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walk } from './_rv-fs-utils.mjs';
import {
  PROJECT_KINDS,
  collectSecretRefKeys,
  isProjectKind,
  isSecretFileName,
  plaintextSecretPaths,
  vendorGlobProblems,
} from './_rv-guards.mjs';
import {
  documentRefsOf,
  documentsOf,
  isContainedRef,
  projectConnectRefs,
} from './_rv-manifest.mjs';

const MANIFEST = 'project.json';

/** Well-known subfolders. Unknown ones are reported, never rejected. */
const KNOWN_FOLDERS = new Set([
  'models', 'library', 'scenes', 'docs', 'aasx',
  'connect', 'settings', 'rag', 'thumbnails', 'splats',
  // plan-718: a project's own code and its knowledge files. Neither is a
  // reserved path — a reference may name anything inside the project — but
  // these two are the spellings the docs use, so they are not 'unrecognised'.
  'scripts', 'knowledge',
  // plan-434 phase 2: material that stays on this machine. `projects/wmyb/local`
  // is the real instance — NDA customer data that is neither delivered nor
  // published. It is customer-owned by construction, since no vendor glob names
  // it and unknown means zone C (`_vendor-merge.mjs`), so the only thing missing
  // was the spelling being recognised here.
  'local',
  // plan-395: the internal Development project's two extra places. `fixtures/`
  // holds the synthetic GLBs the test suites load, `scratch/` is the documented
  // home for experiments (F10) — the folder that exists so `public/models/` does
  // not become the dumping ground again. Neither is a document section, so
  // neither appears in `documents[]`; they are working material, and without
  // these two spellings the validator warns about them on every single run.
  'fixtures', 'scratch',
]);

// The list of secret-bearing filenames lives in scripts/_rv-guards.mjs and
// nowhere else (plan-700 §2.9 / B10). It used to be copied here, in the
// delivery library, in bunny-deploy and in the CONNECT stager, and the four
// copies had already drifted apart — `secrets.local.json` was in none of them.
// Do not reintroduce a local array: tests/rv-guards.node.test.ts fails on it.

/** Directories never worth walking. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cad-cache', '.trash']);

// Per-run, not module-level: `validateProject()` is called in-process by the
// delivery and deploy gates, sometimes several times for a multi-project repo,
// and module-level accumulators would report the first project's errors against
// the second one.
let errors = [];
let warnings = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

function walkProject(root, onFile) {
  walk(root, (absolute, rel, entry) => {
    if (entry.isDirectory()) return !SKIP_DIRS.has(entry.name);
    if (entry.isFile()) onFile(absolute, rel);
  });
}

function validateManifest(root) {
  const path = join(root, MANIFEST);
  if (!existsSync(path)) {
    fail(`${MANIFEST} is missing — this directory is not a project.`);
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${MANIFEST} is not valid JSON: ${e.message}`);
    return null;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${MANIFEST} must be a JSON object.`);
    return null;
  }
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
    fail(`${MANIFEST}: "id" is required and must be a non-empty string.`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    fail(`${MANIFEST}: "name" is required and must be a non-empty string.`);
  }
  // `documents` is the list since plan-413 phase 6; the other three are the
  // pre-413 shape and are still *accepted* — a customer repository that has not
  // been opened by a current client since the migration is not an invalid
  // project, it is an unmigrated one, and this gate must not fail a delivery
  // over that.
  for (const key of ['documents', 'scenes', 'models', 'library', 'libraries']) {
    if (key in manifest && !Array.isArray(manifest[key])) {
      fail(`${MANIFEST}: "${key}" must be an array when present.`);
    }
  }
  for (const entry of documentsOf(manifest)) {
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      // Mandatory since plan-413 F2, and the one field the whole identity model
      // rests on: an id-less document cannot be referenced, moved or resolved.
      fail(`${MANIFEST}: a documents[] entry ("${entry.path}") has no "id".`);
    }
  }
  return manifest;
}

/** Manifest entries pointing at files that are not there. */
function validateReferences(root, manifest) {
  if (!manifest) return;
  const check = (entries, key, folder) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const rel = typeof entry === 'string' ? entry : entry?.path;
      if (typeof rel !== 'string' || !rel) continue;
      // Absolute or escaping paths are a portability bug: the project is meant
      // to be relocatable, so a reference that leaves it can never resolve
      // on another machine.
      if (rel.startsWith('/') || rel.includes('..') || /^[a-zA-Z]:/.test(rel)) {
        fail(`${key}: "${rel}" must be a relative path inside the project.`);
        continue;
      }
      const candidates = folder ? [join(root, folder, rel), join(root, rel)] : [join(root, rel)];
      if (!candidates.some(p => existsSync(p))) {
        warn(`${key}: "${rel}" is listed in the manifest but not present on disk.`);
      }
    }
  };
  // documents[] first — the list since plan-413 phase 6. Checked against the
  // project root and nothing else: a `documents[]` path is project-relative by
  // definition, so it either exists at that path or it does not (plan-736
  // Phase 3). The second candidate this used to build — the folder the row's
  // SECTION named — was a fallback for a row that had lost its own prefix, and
  // it could only ever turn a genuinely missing file into a silent pass.
  check(documentsOf(manifest), 'documents', null);
  // The pre-413 arrays, for a manifest that still carries them.
  check(manifest.scenes, 'scenes', 'scenes');
  check(manifest.models, 'models', 'models');
  check(manifest.library, 'library', 'library');
}

/**
 * The reference model's own gate (plan-718 §2.6, F7).
 *
 * Two failure modes, and they are not the same severity:
 *
 *  - a reference that LEAVES the project is an **error**. It cannot resolve on
 *    another machine, so the project has stopped being copyable — which is the
 *    single property the whole reference model exists to provide.
 *  - a reference whose target is simply **missing** is a warning, the same
 *    reading `validateReferences` already gives a manifest entry without a file:
 *    a half-copied working tree is a state to report, not a build to fail.
 */
function validateDocumentRefs(root, manifest) {
  if (!manifest) return;
  for (const { documentPath, field, ref, contained } of documentRefsOf(manifest)) {
    if (!contained) {
      fail(`${MANIFEST}: ${field} "${ref}" on "${documentPath}" leaves the project — `
        + 'references must be relative paths inside it.');
      continue;
    }
    if (!existsSync(join(root, ref))) {
      warn(`${MANIFEST}: ${field} "${ref}" on "${documentPath}" points at a file that is not there.`);
    }
  }
  // The project-wide half. A missing secrets sidecar is NORMAL and deliberately
  // silent: it is gitignored, so a fresh clone has none by construction.
  const { agentsRef, ragRef } = projectConnectRefs(manifest);
  if (typeof manifest.connect?.agentsRef === 'string' && agentsRef === null) {
    fail(`${MANIFEST}: connect.agentsRef "${manifest.connect.agentsRef}" leaves the project.`);
  } else if (agentsRef && !existsSync(join(root, agentsRef))) {
    warn(`${MANIFEST}: connect.agentsRef "${agentsRef}" points at a file that is not there.`);
  }
  if (typeof manifest.connect?.secretsRef === 'string'
    && !isContainedRef(manifest.connect.secretsRef)) {
    fail(`${MANIFEST}: connect.secretsRef "${manifest.connect.secretsRef}" leaves the project.`);
  }
  // The RAG bundle is the project's artefact and is checked like any other
  // reference. The generations CONNECT unpacks from it are host-local caches and
  // are deliberately NOT looked for here (stage 3.3).
  if (typeof manifest.connect?.ragRef === 'string' && ragRef === null) {
    fail(`${MANIFEST}: connect.ragRef "${manifest.connect.ragRef}" leaves the project.`);
  } else if (ragRef && !existsSync(join(root, ragRef))) {
    warn(`${MANIFEST}: connect.ragRef "${ragRef}" points at a file that is not there.`);
  }
}

/**
 * Committed CONNECT config files: secrets as references, never as values
 * (plan-718 F3, §2.6).
 *
 * The files checked are the ones the manifest NAMES — `connectRef` and
 * `connect.agentsRef` — plus anything else under `connect/`, because a file that
 * nothing references today is still a file that gets committed and mailed. The
 * secrets sidecar is excluded: it is the one place a value legitimately lives,
 * and it is gitignored and blocked by name (`isSecretFileName`) besides.
 */
function validateConnectSecrets(root, manifest) {
  if (!manifest) return;
  const { secretsRef } = projectConnectRefs(manifest);
  const named = new Set(
    documentRefsOf(manifest)
      .filter(r => r.field === 'connectRef' && r.contained)
      .map(r => r.ref),
  );
  const { agentsRef } = projectConnectRefs(manifest);
  if (agentsRef) named.add(agentsRef);
  const connectDir = join(root, 'connect');
  if (existsSync(connectDir) && statSync(connectDir).isDirectory()) {
    for (const entry of readdirSync(connectDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        named.add(`connect/${entry.name}`);
      }
    }
  }

  /** Which connect file each `$secretRef` key was seen in — the collision map. */
  const keyOwners = new Map();

  for (const rel of [...named].sort()) {
    if (rel === secretsRef || isSecretFileName(basename(rel))) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      fail(`${rel}: not valid JSON (${e.message}).`);
      continue;
    }
    for (const path of plaintextSecretPaths(parsed)) {
      fail(`${rel}: "${path}" holds a plaintext secret. Use {"$secretRef": "<key>"} `
        + `or "\${env:VAR}" and keep the value in ${secretsRef}.`);
    }
    for (const key of collectSecretRefKeys(parsed)) {
      const owners = keyOwners.get(key) ?? new Set();
      owners.add(rel);
      keyOwners.set(key, owners);
    }
  }

  for (const [key, owners] of keyOwners) {
    if (owners.size > 1) {
      // Sharing a key across configs is legitimate (N:1 exists on purpose); a
      // COLLISION is the same thing done by accident, and only the author can
      // tell them apart. So it is said out loud rather than decided here.
      warn(`Secret key "${key}" is referenced from more than one connect file `
        + `(${[...owners].sort().join(', ')}) — they share one value.`);
    }
  }
}

function validateSecrets(root) {
  walkProject(root, (abs, rel) => {
    if (isSecretFileName(basename(rel))) {
      fail(`Possible secret committed into the project: ${rel}`);
    }
  });
}

/**
 * The project's declared `kind` (plan-434 §2.6).
 *
 * Three severities, and the split is deliberate:
 *
 *  - **missing → warning.** Every project in our own tree has one, and the
 *    doctor gates on that. But this validator also runs over an INCOMING
 *    customer repository (`pull-customer-project.mjs`), and those were delivered
 *    before the field existed. Failing there would block a pull over a field the
 *    customer never had a chance to write — a migration note, not a defect.
 *  - **outside the enum → error.** A typo (`"Customer"`, the retired `"seed"`)
 *    silently turns off every rule keyed on `customer`, which is the failure
 *    that must never pass quietly.
 *  - **`customer` without a `vendor` block → error.** No `vendor` means the
 *    whole project is customer-owned and no update can ever reach it (see
 *    `_vendor-merge.mjs`: unknown is zone C). For a demo or a fixture that is a
 *    fine default; for a project we deliver it is a delivery that silently
 *    changes nothing, and it should be said before the delivery, not after.
 */
function validateKind(manifest) {
  if (!manifest) return;
  const kind = manifest.kind;
  if (kind === undefined) {
    warn(`${MANIFEST}: no "kind" — run scripts/migrate-project-manifest.mjs `
      + `(one of ${PROJECT_KINDS.join(', ')}; plan-434 phase 2 migration pending).`);
    return;
  }
  if (!isProjectKind(kind)) {
    fail(`${MANIFEST}: "kind" is ${JSON.stringify(kind)} — must be one of ${PROJECT_KINDS.join(', ')}.`);
    return;
  }
  if (kind !== 'customer') return;
  const vendor = manifest.vendor;
  const managed = Array.isArray(vendor?.managed) ? vendor.managed : [];
  if (managed.length === 0) {
    fail(`${MANIFEST}: "kind" is "customer" but there is no "vendor.managed" — `
      + 'without it every path is customer-owned and no delivered update can ever reach this project.');
  }
}

/**
 * Refuses a vendor block that could overwrite customer data (plan-700 §2.3, T6).
 *
 * The `vendor` globs decide, at every future delivery, which files we are
 * allowed to replace in a customer's repository. A wrong entry here is not a
 * lint issue: `managed: ["**"]` hands us permission to overwrite the scenes the
 * customer built. The rule is therefore mechanical and lives in the gate that
 * runs before every delivery and every deploy, not in a review checklist.
 */
function validateVendorBlock(manifest) {
  if (!manifest) return;
  for (const problem of vendorGlobProblems(manifest.vendor)) {
    fail(`${MANIFEST}: ${problem}`);
  }
}

/**
 * Verifies any `sha256` a manifest entry carries against the file on disk (B9).
 *
 * `sha256` is optional and the delivery merge does not depend on it — the merge
 * basis is the Git blob OID, which Git maintains for free. But an entry that
 * *claims* a hash and gets it wrong is worse than one that claims nothing, so a
 * stated hash is checked. A mismatch is a warning while the field is still
 * being filled in by hand; the day it becomes generated it should become an
 * error.
 */
function validateAssetHashes(root, manifest) {
  if (!manifest) return;
  const groups = [
    ['documents', null, documentsOf(manifest)],
    ['models', 'models', manifest.models],
    ['library', 'library', manifest.library],
  ];
  for (const [key, folder, entries] of groups) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const { path: rel, sha256 } = entry;
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) continue;
      if (typeof rel !== 'string' || !rel) continue;
      const file = (folder ? [join(root, folder, rel), join(root, rel)] : [join(root, rel)])
        .find(p => existsSync(p));
      if (!file) continue;
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
      if (actual !== sha256.toLowerCase()) {
        warn(`${key}: "${rel}" sha256 does not match the file on disk (manifest ${sha256.slice(0, 12)}…, file ${actual.slice(0, 12)}…).`);
      }
    }
  }
}

/**
 * The slug invariant: folder name == `canonicalName` == CONNECT bundle id
 * (plan-700 Phase 8), enforced **case-insensitively**.
 *
 * Three separate mechanisms address a project by name — the Bunny private
 * deploy resolves `--project` against the folder name, the CONNECT stager uses
 * the folder name as its bundle id, and `?project=<slug>` deep links resolve
 * `canonicalName`. When those drift apart, a link opens nothing and a bundle
 * embeds a project nobody asked for.
 *
 * Case is deliberately excluded from the comparison. The real repository has a
 * folder `Toray` whose migrated `canonicalName` is `toray`, and the fix for
 * that is NOT to rename the folder from a validator: layouts, delivery configs
 * and CONNECT bundles all carry the current spelling, and Windows' own
 * case-insensitive filesystem makes such a rename its own class of accident.
 * The invariant that actually protects the three lookups is
 * case-insensitive identity, so that is the one enforced. The rename question
 * stays open and belongs to a human.
 */
function validateCanonicalName(root, manifest) {
  if (!manifest) return;
  const folder = basename(resolve(root));
  const canonical = manifest.canonicalName;
  if (canonical === undefined) {
    // Pre-migration manifests legitimately have none. `migrate-project-manifest`
    // derives it from the folder, so this is a note about an unmigrated project,
    // not a broken one.
    warn(`${MANIFEST}: no "canonicalName" — run scripts/migrate-project-manifest.mjs.`);
    return;
  }
  if (typeof canonical !== 'string' || !canonical.trim()) {
    fail(`${MANIFEST}: "canonicalName" must be a non-empty string when present.`);
    return;
  }
  if (canonical.toLowerCase() !== folder.toLowerCase()) {
    fail(`${MANIFEST}: "canonicalName" is "${canonical}" but the folder is "${folder}" — `
      + 'they must be the same name (case aside); deploy, CONNECT bundle id and ?project= links all key off it.');
  } else if (canonical !== folder) {
    warn(`${MANIFEST}: "canonicalName" ("${canonical}") differs from the folder ("${folder}") in case only.`);
  }
}

function reportUnknownFolders(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    if (!KNOWN_FOLDERS.has(entry.name)) {
      // A note, not a failure: projects legitimately carry extra material and
      // rejecting it would make the validator useless in real repositories.
      warn(`Unrecognised top-level folder "${entry.name}" (kept, just noting it).`);
    }
  }
}

function main(argv) {
  const args = argv.filter(a => a !== '--json');
  const asJson = argv.includes('--json');
  const root = args[0];
  if (!root) {
    console.error('usage: node scripts/validate-project.mjs <project-dir> [--json]');
    return 2;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    return 2;
  }

  const result = validateProject(root);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const w of result.warnings) console.warn(`warning: ${w}`);
    for (const e of result.errors) console.error(`error: ${e}`);
    console.log(result.ok
      ? `project OK (${result.warnings.length} warning(s))`
      : `project INVALID (${result.errors.length} error(s), ${result.warnings.length} warning(s))`);
  }
  return result.ok ? 0 : 1;
}

/**
 * Validates one project directory and returns the findings.
 *
 * Exported so the delivery and deploy gates can call it in-process instead of
 * shelling out: a gate that spawns a child has to parse stdout to learn *what*
 * was wrong, and one that cannot be imported tends not to be wired in at all —
 * which is exactly how this validator sat unused in every pipeline (B12).
 */
export function validateProject(root) {
  errors = [];
  warnings = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, errors: [`Not a directory: ${root}`], warnings: [] };
  }
  const manifest = validateManifest(root);
  validateReferences(root, manifest);
  validateDocumentRefs(root, manifest);
  validateConnectSecrets(root, manifest);
  validateVendorBlock(manifest);
  validateKind(manifest);
  validateCanonicalName(root, manifest);
  validateAssetHashes(root, manifest);
  validateSecrets(root);
  reportUnknownFolders(root);
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Runs the validator over one project and throws on the first error.
 *
 * This is the form the pipelines use (F10): a delivery or a deploy must not
 * proceed past an invalid project, and a thrown error is the only outcome the
 * surrounding scripts already treat as fatal. Warnings are printed, not fatal.
 */
export function assertValidProject(root, label = root) {
  const result = validateProject(root);
  for (const w of result.warnings) console.warn(`[validate-project] warning: ${label}: ${w}`);
  if (!result.ok) {
    throw new Error(`Project validation failed for ${label}:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result;
}

// Only exit the process when invoked as a CLI; importing this module must not
// terminate its host (the gates import it).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
