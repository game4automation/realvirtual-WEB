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
 *        [--delivered | --projects-dir <dir> | --library <projectId>=<folder> ...]
 *
 * Library projects (plan-778): every `libraries[]` entry needs a `projectId` or a
 * `url`, and a `projectId` must never name a path. With `--delivered` the folder is
 * a delivered / packed copy and every qualified reference must resolve in its own
 * `libraries/<projectId>/`; with `--projects-dir` / `--library` a SOURCE project's
 * libraries are looked up there by id. A miss is an error naming document and library.
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
} from './_rv-guards.mjs';
import {
  documentRefsOf,
  documentsOf,
  isContainedRef,
  projectConnectRefs,
} from './_rv-manifest.mjs';
import { parseLibrarySourceArgs, planProjectLibraries } from './lib/rv-library-trim.mjs';
import { libraryProjectIdProblem } from '../src/core/project/rv-library-trim-core.mjs';

const MANIFEST = 'project.json';

/** Well-known subfolders. Unknown ones are reported, never rejected. */
const KNOWN_FOLDERS = new Set([
  'models', 'library', 'scenes', 'docs', 'aasx',
  'connect', 'settings', 'rag', 'splats',
  // plan-776: the saved previews. Dot folders are skipped before this set is
  // asked; the entry names the folder so the list is the whole vocabulary. The
  // undotted 'thumbnails' of older builds is no longer a known folder.
  '.thumbnails',
  // plan-718: a project's own code and its knowledge files. Neither is a
  // reserved path — a reference may name anything inside the project — but
  // these two are the spellings the docs use, so they are not 'unrecognised'.
  'scripts', 'knowledge',
  // plan-434 phase 2: material that stays on this machine. `projects/wmyb/local`
  // is the real instance — NDA customer data that is neither delivered nor
  // published, so the only thing missing was the spelling being recognised here.
  'local',
  // plan-395: the internal Development project's two extra places. `fixtures/`
  // holds the synthetic GLBs the test suites load, `scratch/` is the documented
  // home for experiments (F10) — the folder that exists so `public/models/` does
  // not become the dumping ground again. Neither is a document section, so
  // neither appears in `documents[]`; they are working material, and without
  // these two spellings the validator warns about them on every single run.
  'fixtures', 'scratch',
  // plan-778 F15: the trimmed library projects a delivered or packed project carries,
  // one folder per library project id.
  'libraries',
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
 *
 * A `customer` project used to additionally need a `vendor.managed` block, because
 * without one the three-way merge classified every path as customer-owned and no
 * update could reach the project. Plan-738 removed the zones: the core is replaced
 * in full at every delivery no matter what the manifest says, so the field it
 * demanded no longer exists and its absence means nothing.
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
}

/**
 * `settings.start` — the hosted start document (plan-640).
 *
 * Opt-in: absent is the normal case and silent. When present it must name a
 * document of `documents[]` — by path, by id, or by a file name exactly one
 * document carries (the same rule as the runtime's `findStartDocument`) —
 * because the runtime falls back to the dashboard on a miss, and a customer
 * link that quietly stops opening its machine is exactly what a deploy gate is
 * for. `mode` is optional; a non-string one is ignored by the runtime, so it is
 * a warning here. Whether the mode id is REGISTERED is only known in the
 * browser (plugins register modes) and is not checked.
 */
function validateStart(manifest) {
  if (!manifest) return;
  const settings = manifest.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  if (!('start' in settings)) return;
  const start = settings.start;
  if (!start || typeof start !== 'object' || Array.isArray(start)) {
    fail(`${MANIFEST}: settings.start must be an object { document, mode? } — got ${JSON.stringify(start)}.`);
    return;
  }
  const wanted = typeof start.document === 'string' ? start.document.trim() : '';
  if (wanted === '') {
    fail(`${MANIFEST}: settings.start.document must be a non-empty document id or path.`);
    return;
  }
  if (!findStartDocumentIn(documentsOf(manifest), wanted)) {
    fail(`${MANIFEST}: settings.start.document "${wanted}" names no document of documents[] `
      + '(by path, id or a unique file name) — the hosted root would fall back to the dashboard.');
  }
  if (start.mode !== undefined && typeof start.mode !== 'string') {
    warn(`${MANIFEST}: settings.start.mode should be a mode id string (e.g. "hmi") — `
      + `${JSON.stringify(start.mode)} is ignored.`);
  }
}

/**
 * The workspace modes this build registers: `main.ts` (viewer, hmi, des,
 * planner, commissioning) plus the asset editor's feature adapter (editor).
 * Keep in step with those registrations - there is no compiler check tying
 * them together; `tests/validate-project.node.test.ts` pins the list.
 */
export const KNOWN_WORKSPACE_MODES = ['viewer', 'hmi', 'des', 'planner', 'commissioning', 'editor'];

/**
 * `documents[].modes` / `documents[].mode` - the per-document mode restriction.
 *
 * `modes` is optional; when present it must be a non-empty array of known mode
 * ids (an unknown or misspelled id would silently make the document unusable in
 * the mode the author meant). `mode` - the mode a document opens in, and the
 * default of the restriction - must then be one of `modes`, or the runtime would
 * fall back to the first listed mode instead of the one the row names. A
 * document's own `mode` without `modes` keeps its old, lenient rule (unchecked).
 */
function validateDocumentModes(manifest) {
  if (!manifest) return;
  for (const entry of documentsOf(manifest)) {
    if (!entry || typeof entry !== 'object' || !('modes' in entry)) continue;
    const label = `${MANIFEST}: document "${entry.id ?? entry.path}"`;
    const modes = entry.modes;
    if (!Array.isArray(modes) || modes.length === 0) {
      fail(`${label}: "modes" must be a non-empty array of mode ids — got ${JSON.stringify(modes)}.`);
      continue;
    }
    for (const m of modes) {
      if (m === 'editor') {
        // The authoring workspace is never restricted, so listing it says
        // nothing - and a list of ONLY the editor would leave the document no
        // mode to be viewed in (the editor handoff needs one to park in).
        fail(`${label}: "modes" must not list "editor" — the Editor is always available.`);
        continue;
      }
      if (typeof m !== 'string' || !KNOWN_WORKSPACE_MODES.includes(m)) {
        fail(`${label}: "modes" names unknown mode ${JSON.stringify(m)} — `
          + `known: ${KNOWN_WORKSPACE_MODES.join(', ')}.`);
      }
    }
    if (entry.mode !== undefined && !modes.includes(entry.mode)) {
      fail(`${label}: "mode" ${JSON.stringify(entry.mode)} is not one of its "modes" `
        + `(${modes.map((m) => JSON.stringify(m)).join(', ')}).`);
    }
  }
}

/** Mirror of `findStartDocument` (src/core/project/rv-project-documents.ts). */
function findStartDocumentIn(documents, wanted) {
  const byPath = documents.find((d) => d?.path === wanted);
  if (byPath) return byPath;
  const byId = documents.find((d) => d?.id === wanted);
  if (byId) return byId;
  if (wanted.includes('/') || wanted.includes('\\')) return null;
  const fileName = (p) => (typeof p === 'string' ? p : '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const matches = documents.filter((d) => fileName(d?.path) === wanted);
  return matches.length === 1 ? matches[0] : null;
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

/**
 * `libraries[]` (plan-778): the shape of every entry, and — when the caller says
 * where libraries are found — that every library and every qualified reference
 * resolves.
 *
 *  - an entry with neither `projectId` nor `url` names nothing: error;
 *  - a `projectId` becomes a folder name (`libraries/<id>/`) and a lookup key, so a
 *    separator or `..` in it is an error, not a warning;
 *  - `delivered`: the project ships its libraries itself (`libraries/<id>/`), so
 *    every qualified reference must resolve there — a delivery that would show a
 *    placeholder is refused here, naming document and library;
 *  - `librarySources`: a SOURCE project, its libraries found by id in a projects
 *    folder or an explicit `--library` map (the same lookup the delivery runs).
 */
function validateLibraries(root, manifest, opts) {
  if (!manifest || !Array.isArray(manifest.libraries)) return;
  manifest.libraries.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) fail(`${MANIFEST}: libraries[${index}] is an empty string.`);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${MANIFEST}: libraries[${index}] must be an object { projectId | url, label?, hint? }.`);
      return;
    }
    const hasId = typeof entry.projectId === 'string' && entry.projectId.trim() !== '';
    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== '';
    if (!hasId && !hasUrl) {
      fail(`${MANIFEST}: libraries[${index}] has neither "projectId" nor "url" — it names no library.`);
      return;
    }
    if (entry.projectId !== undefined) {
      const problem = libraryProjectIdProblem(entry.projectId);
      if (problem) fail(`${MANIFEST}: libraries[${index}]: ${problem} — a library id must never name a path.`);
    }
  });
  if (!opts.delivered && !opts.librarySources) return;
  let plan;
  try {
    plan = planProjectLibraries(root, opts.delivered
      ? { realvirtualLibraryDir: opts.realvirtualLibraryDir ?? null }
      : { ...opts.librarySources, realvirtualLibraryDir: opts.realvirtualLibraryDir ?? null });
  } catch (error) {
    fail(`library resolution could not run: ${error.message}`);
    return;
  }
  for (const error of plan.errors) {
    if (error.code === 'library-unresolvable' && opts.delivered) {
      fail(`library "${error.projectId}" (needed by ${(error.neededBy ?? []).join(', ')}) is not shipped under libraries/${error.projectId}/.`);
    } else {
      fail(error.message);
    }
  }
  if (plan.legacyRefs.length > 0) {
    warn(`${plan.legacyRefs.length} unqualified reference(s) are not attributed to a library `
      + `(e.g. ${plan.legacyRefs[0].document} → "${plan.legacyRefs[0].assetId || plan.legacyRefs[0].path}").`);
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
  const asJson = argv.includes('--json');
  const delivered = argv.includes('--delivered');
  let sources;
  try {
    sources = parseLibrarySourceArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  // The positional is the first token that is neither a flag nor a flag's value.
  const valueOf = new Set();
  argv.forEach((token, index) => { if (token === '--projects-dir' || token === '--library') valueOf.add(index + 1); });
  const root = argv.find((token, index) => !token.startsWith('--') && !valueOf.has(index));
  if (!root) {
    console.error('usage: node scripts/validate-project.mjs <project-dir> [--json] '
      + '[--delivered | --projects-dir <dir> | --library <projectId>=<folder> ...]');
    return 2;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    return 2;
  }

  const hasSources = !!sources.projectsDir || Object.keys(sources.libraries).length > 0;
  if (delivered && hasSources) {
    console.error('--delivered cannot be combined with --projects-dir / --library: a delivered copy resolves its libraries from its own libraries/ folder.');
    return 2;
  }
  const result = validateProject(root, {
    delivered,
    ...(hasSources ? { librarySources: sources } : {}),
  });

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
 *
 * `opts` (plan-778): `delivered` — the folder is a delivered/packed copy whose
 * qualified references must resolve in its own `libraries/`; `librarySources`
 * (`{ projectsDir?, libraries? }`) — resolve a source project's libraries there;
 * `realvirtualLibraryDir` — check references into the realvirtual library too.
 */
export function validateProject(root, opts = {}) {
  errors = [];
  warnings = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, errors: [`Not a directory: ${root}`], warnings: [] };
  }
  const manifest = validateManifest(root);
  validateReferences(root, manifest);
  validateDocumentRefs(root, manifest);
  validateConnectSecrets(root, manifest);
  validateKind(manifest);
  validateStart(manifest);
  validateDocumentModes(manifest);
  validateCanonicalName(root, manifest);
  validateAssetHashes(root, manifest);
  validateLibraries(root, manifest, opts);
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
export function assertValidProject(root, label = root, opts = {}) {
  const result = validateProject(root, opts);
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
