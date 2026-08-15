// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * migrate-project-manifest — brings an existing `project.json` up to
 * `rv-project/1.0` without losing anything (plan-700 Phase 1, spec inherited
 * from plan-370 §2.0 Phase 1b).
 *
 * ## Why an offline migrator when the browser already migrates
 *
 * `rv-project-storage.migrateManifest` upgrades a manifest when a *browser*
 * opens the project. The Node pipeline — delivery, validation, publishing —
 * never opens one, so it sees whatever is on disk. Today that is three
 * different shapes across six projects: some carry `schemaVersion`/`id`, some
 * only the old deploy fields, and the delivery gate cannot require a field that
 * half the projects do not have.
 *
 * ## What it does NOT do, on purpose
 *
 * It does not fill `models[]` or `library[]`, and it does not compute `sha256`
 * per asset.
 *
 * That was in the original plan and was reversed by the Phase 0 finding P0-3:
 * plan-372 had already made `FolderBackend.listModels()` **directory-driven**,
 * so every GLB under `models/` belongs to the project and the manifest is an
 * optional metadata overlay. Writing the lists back in would recreate exactly
 * the duplicate source of truth that was deliberately removed — and every
 * dropped-in GLB would then need a manifest edit to become visible. The folder
 * is the source of truth; the merge basis is the Git blob OID, not a hash in
 * JSON.
 *
 * ## Conservative by construction
 *
 * - A field that already exists is never rewritten. That makes the migrator
 *   idempotent by construction rather than by care: a second run produces a
 *   byte-identical file.
 * - Unknown and legacy fields (`code`, `created`, `lastPublished`, `settings`)
 *   are carried through untouched — `_bunny-lib.mjs` still reads them, and a
 *   migrator that tidied them away would break publishing.
 * - `--dry-run` is the DEFAULT. Writing requires `--apply`.
 *
 * ## Why this is NOT wired into deliver.mjs / bunny-deploy.mjs
 *
 * plan-703 phase 9 had to choose between hanging this script into the delivery
 * pipeline and running it once with `--apply`. It does neither, and the reason
 * is in the two callers:
 *
 * - `deliver.mjs` asserts a **clean tree** before it does anything and states
 *   that it never auto-commits. A migration that writes `project.json` fails
 *   that assertion by existing — the delivery would abort on the change it just
 *   made itself.
 * - `bunny-deploy.mjs` publishes. A publish that mutates the source project as a
 *   side effect is the kind of surprise that gets discovered from a diff weeks
 *   later.
 *
 * What the pipeline actually needed was not a write but a **read** that speaks
 * `documents[]` whatever shape is on disk, and that is where it went:
 * `loadProject()` in `_bunny-lib.mjs` runs `withDerivedDocuments()`, the Node
 * twin of the browser's read-side derivation. Every consumer downstream sees one
 * document list, no file is touched, and the publish path could therefore drop
 * the private `scenes[]` fallback it used to keep for the same case.
 *
 * This script stays what it is: the deliberate, human-invoked way to actually
 * write the migration into a repository, one `--apply` at a time. Note that it
 * writes **without a `.bak`** — unlike the browser path — so point it at files a
 * version-control system can give back.
 *
 * Usage:
 *   node scripts/migrate-project-manifest.mjs                 # all projects, dry run
 *   node scripts/migrate-project-manifest.mjs --apply         # all projects, write
 *   node scripts/migrate-project-manifest.mjs <dir> [<dir>…]  # named projects
 *   node scripts/migrate-project-manifest.mjs --projects-root <dir>
 *   node scripts/migrate-project-manifest.mjs <dir> --kind demo --apply
 *
 * Exit codes: 0 = nothing to do or migration succeeded, 1 = a project could not
 * be migrated, 2 = bad usage.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VENDOR_BLOCK, PROJECT_KINDS, isProjectKind } from './_rv-guards.mjs';
import {
  DOCUMENTS_MIGRATION_MARKER,
  LEGACY_DOCUMENT_KEYS,
  SCRIPT_REF_MIGRATION_MARKER,
  deriveDocuments,
  deriveScriptRefs,
} from './_rv-manifest.mjs';

const MANIFEST = 'project.json';
/**
 * The manifest generation this migrator brings a project up to.
 *
 * 1 → 2 in plan-413 phase 6: `documents[]` is the manifest's one list and the
 * three legacy arrays are gone. The browser migrator
 * (`rv-project-documents-migration.ts`) performs the same conversion when a
 * project is opened; this one exists because the Node pipeline never opens one.
 */
const SCHEMA_VERSION = 2;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECTS_ROOT = resolve(scriptDir, '../../realvirtual-WebViewer-Private~/projects');

// ─── Pure manifest migration ─────────────────────────────────────────────

/**
 * Slugify a name the same way `canonicalNameOf()` does in
 * `src/core/project/rv-project-types.ts`.
 *
 * Duplicated rather than imported because this is a Node script and that is
 * browser TypeScript; the two must agree, which is what the round-trip test
 * pins. CONNECT's `ProjectPaths.ValidateProjectName` applies the same
 * restrictions, so a WEB slug and a CONNECT RAG bundle id cannot disagree.
 */
export function canonicalNameOf(name) {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'project';
}

/** Mint a project id in the same shape as `newProjectId()`. */
export function newProjectId() {
  return 'prj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Migrates one parsed manifest. Pure: no filesystem access, no clock beyond
 * what the caller injects, so the whole decision table is testable.
 *
 * @param manifest  the parsed `project.json`
 * @param context   `{ folderName, scenes, pluginModules, kind, now, mintId }` —
 *                  `scenes` is the list of `{ id, name, path }` discovered on
 *                  disk by the caller, `pluginModules` the list of
 *                  `{ scriptRef, models }` declarations (plan-718 §2.7), `kind`
 *                  the project kind to write when the manifest has none
 *                  (default `internal`, plan-434 §2.6).
 * @returns `{ manifest, changes }` — `changes` is empty when nothing was needed.
 */
export function migrateManifest(manifest, context = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${MANIFEST} must be a JSON object.`);
  }
  const folderName = context.folderName ?? '';
  const now = context.now ?? new Date().toISOString();
  const mintId = context.mintId ?? newProjectId;
  const scenes = Array.isArray(context.scenes) ? context.scenes : [];

  // Read-modify-write on the parsed original, at every level: an unknown
  // section written by a newer client must survive a migration by an older one.
  const next = { ...manifest };
  const changes = [];
  const set = (key, value, why) => { next[key] = value; changes.push(`${key}: ${why}`); };

  if (typeof next.schemaVersion !== 'number' || next.schemaVersion < SCHEMA_VERSION) {
    set('schemaVersion', SCHEMA_VERSION, `set to ${SCHEMA_VERSION}`);
  }
  if (typeof next.id !== 'string' || !next.id.trim()) {
    set('id', mintId(), 'minted (was missing)');
  }
  if (typeof next.name !== 'string' || !next.name.trim()) {
    // Only ever a fallback: every real manifest has a display name, and
    // inventing one from the folder is better than an unopenable project.
    set('name', folderName || 'Project', 'derived from the folder name (was missing)');
  }
  if (typeof next.canonicalName !== 'string' || !next.canonicalName.trim()) {
    // From the FOLDER, not the display name: the folder name is what the deploy
    // pipeline and the CONNECT bundle id already use, so deriving from the
    // display name ("Toray OEE Showcase") would mint a third spelling.
    set('canonicalName', canonicalNameOf(folderName || next.name), 'derived from the folder name');
  }
  if (next.kind === undefined) {
    // Defaults to `internal`, and the direction of that default is the whole
    // point (plan-434 §2.6): most folders under `projects/` are scratch, and the
    // consumer that reads `kind` — the foreign-customer-name guard — errs safely
    // when a folder is under-claimed and dangerously when it is over-claimed. A
    // wrong `internal` costs a guard that did not fire on a name nobody was
    // hiding; a wrong `customer` aborts deliveries over a fixture. Customer and
    // demo folders are therefore named by a human, with `--kind`.
    //
    // A value that is already there is never rewritten — not even one outside
    // the enum. That is the file-wide rule (see the header), and an unknown kind
    // is a thing to REPORT, which `validate-project.mjs` does as an error, not a
    // thing for a migrator to overwrite behind the author's back.
    const requested = isProjectKind(context.kind) ? context.kind : 'internal';
    set('kind', requested, `set to "${requested}" (one of ${PROJECT_KINDS.join('/')})`);
  }
  if (typeof next.createdAt !== 'string' || !next.createdAt.trim()) {
    const legacy = typeof next.created === 'string' && next.created.trim() ? next.created.trim() : null;
    set('createdAt', legacy ?? now, legacy ? 'taken from the legacy "created"' : 'set to now (unknown)');
  }
  if (typeof next.modifiedAt !== 'string' || !next.modifiedAt.trim()) {
    set('modifiedAt', next.createdAt, 'seeded from createdAt');
  }
  // The scene files on disk feed `documents[]` DIRECTLY (plan-703 phase 9).
  // Until then they were written back as `scenes[]` and lifted from there on the
  // next pass, which was correct while the browser still mirrored the three
  // arrays out of `documents[]`. It stopped being correct when phase 6 removed
  // that mirror: `withoutLegacyArrays()` now strips `scenes[]` on every browser
  // save, so writing it here would add a second, immediately stale answer that
  // the next save deletes again — the exact duplicate the hardcut removed.
  //
  // The additive rule survives the move, one level down: an entry that already
  // speaks for a file keeps all of its fields, a file no entry speaks for gains
  // one, and nothing is ever removed. A manifest entry without a file is the
  // validator's warning to give, not this script's data to delete.
  const knownScenePaths = new Set(
    (Array.isArray(next.scenes) ? next.scenes : [])
      .map((e) => (e && typeof e === 'object' ? e.path : null)).filter(Boolean));
  const sceneSources = [
    ...(Array.isArray(next.scenes) ? next.scenes : []),
    ...scenes.filter((s) => !knownScenePaths.has(s.path)),
  ];
  const derived = deriveDocuments({ ...next, scenes: sceneSources }, { now });
  if (derived) {
    const lifted = derived.documents.length - derived.existing;
    set('documents', derived.documents, derived.existing > 0
      ? `completed the document list with ${lifted} entr${lifted === 1 ? 'y' : 'ies'} from scenes/models/library`
      : `derived ${derived.documents.length} document(s) from scenes/models/library`);
    next[DOCUMENTS_MIGRATION_MARKER] = derived.marker;
  }
  // The hardcut itself (decision 20). Everything the three arrays held is in
  // `documents[]` by the line above — `deriveDocuments` lifts what the list does
  // not already speak for — so dropping them loses nothing and is what keeps a
  // migrated manifest byte-comparable with one the browser saved.
  for (const key of LEGACY_DOCUMENT_KEYS) {
    if (!(key in next)) continue;
    delete next[key];
    changes.push(`${key}: dropped (documents[] is the manifest's one list)`);
  }
  // plan-718 §2.7: the plugin module's `models: string[]` self-declaration
  // becomes `scriptRef` on the rows it named. Idempotent by its own marker, and
  // independent of the documents[] marker above — a project migrated to
  // documents[] long ago still needs this one exactly once.
  const modules = Array.isArray(context.pluginModules) ? context.pluginModules : [];
  if (!next[SCRIPT_REF_MIGRATION_MARKER] && modules.length > 0) {
    const refs = deriveScriptRefs(next, modules, { now });
    if (refs) {
      if (refs.assigned.length > 0) {
        set('documents', refs.documents,
          `bound ${refs.assigned.length} document(s) to their code via scriptRef `
          + '(was: the module\'s own models[] declaration)');
      }
      next[SCRIPT_REF_MIGRATION_MARKER] = refs.marker;
      for (const miss of refs.caseMismatches) {
        // Reported, never assigned: the runtime matcher is case-sensitive, so
        // this declaration binds nothing today and a silent "fix" here would be
        // a behaviour change disguised as a migration (K3).
        changes.push(
          `scriptRef: models[] declares "${miss.declared}" but the document is `
          + `"${miss.documentPath}" — case differs, NOT bound. Fix one of the two by hand.`);
      }
    }
  }
  if (next.vendor === undefined) {
    // The conservative default from _rv-guards.mjs. A human sharpens it per
    // project afterwards; it deliberately contains neither scenes/ nor
    // settings/ nor layouts/, so the first delivery after migration cannot
    // touch customer data even if nobody reviews it.
    set('vendor', {
      managed: [...DEFAULT_VENDOR_BLOCK.managed],
      handover: [...DEFAULT_VENDOR_BLOCK.handover],
    }, 'conservative default added (sharpen per project)');
  }
  return { manifest: next, changes };
}

// ─── Filesystem side ─────────────────────────────────────────────────────

/**
 * Reads the scene files on disk as manifest entries.
 *
 * The id inside the file wins over anything derivable from the filename: the
 * filename carries the id only so a human can read the folder, and a renamed
 * file must not become a second scene.
 */
export function discoverScenes(projectDir) {
  const scenesDir = join(projectDir, 'scenes');
  if (!existsSync(scenesDir) || !statSync(scenesDir).isDirectory()) return [];
  const files = readdirSync(scenesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.scene\.(glb|json)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  // A scene converted by plan-397 phase 7 leaves both bodies side by side for a
  // release. The GLB is the newer of the two by construction — it is written
  // *from* the op log, never the reverse — so it is the one indexed, and the
  // `.scene.json` sibling is skipped rather than listed as a second scene.
  const glbStems = new Set(
    files.filter(f => /\.scene\.glb$/i.test(f)).map(f => f.replace(/\.scene\.glb$/i, '')),
  );

  const out = [];
  for (const fileName of files) {
    const stem = fileName.replace(/\.scene\.(glb|json)$/i, '');
    const isJson = /\.scene\.json$/i.test(fileName);
    if (isJson && glbStems.has(stem)) continue;
    const path = `scenes/${fileName}`;
    let parsed = null;
    if (isJson) {
      try {
        parsed = JSON.parse(readFileSync(join(scenesDir, fileName), 'utf8'));
      } catch {
        // A scene file we cannot parse still exists and still belongs to the
        // project; indexing it by filename is better than pretending it is not
        // there. The validator reports the unreadable file separately.
      }
    }
    // A GLB is never opened here. Its id and name live in the manifest entry
    // that already points at it; for a file dropped in by hand the filename is
    // the only honest answer, and parsing a hundred megabytes to improve on it
    // is not a trade a migrator should make.
    const id = typeof parsed?.id === 'string' && parsed.id.trim() ? parsed.id : stem;
    const name = typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name : stem;
    out.push({ id, name, path });
  }
  return out;
}

/**
 * The project's own plugin module and what it declares (plan-718 §2.7).
 *
 * A project's code lives at `<project>/plugins/index.ts` — that is where the
 * private-project glob of `rv-model-plugin-manager.ts` finds it, and it is
 * already project-relative, which is what makes it expressible as a `scriptRef`
 * at all. A PUBLIC model plugin (`src/plugins/models/<Name>/`) is not inside any
 * project and therefore cannot be referenced from a manifest; those keep their
 * `models[]` declaration and are deliberately not migrated.
 *
 * The declaration is read with a regex rather than by importing the module: this
 * is a `.ts` file with browser imports, and a migrator that had to bundle
 * TypeScript to read one array would not run in CI. A declaration it cannot
 * parse yields no entry, which costs a manual binding — never a wrong one.
 */
export function discoverPluginModules(projectDir) {
  const out = [];
  for (const rel of ['plugins/index.ts', 'plugins/index.tsx']) {
    const abs = join(projectDir, rel);
    if (!existsSync(abs)) continue;
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // Both spellings are in the tree: `export const models = [...]` (all three
    // real projects) and `models: [...]` inside an object literal.
    const match = /\bmodels\s*[:=]\s*\[([^\]]*)\]/.exec(source);
    const models = match
      ? [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
      : [];
    out.push({ scriptRef: rel, models });
  }
  return out;
}

/**
 * Migrates the manifest of one project directory.
 *
 * @returns `{ status, changes, before, after }` where `status` is
 *          `'migrated' | 'unchanged' | 'skipped'`.
 */
export function migrateProjectDir(projectDir, { apply = false, now = undefined, mintId = undefined, kind = undefined } = {}) {
  const dir = resolve(projectDir);
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return { status: 'skipped', reason: `${MANIFEST} is missing — not a project folder.`, changes: [] };
  }
  const before = readFileSync(manifestPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(before);
  } catch (error) {
    return { status: 'skipped', reason: `${MANIFEST} is not valid JSON: ${error.message}`, changes: [] };
  }
  let result;
  try {
    result = migrateManifest(parsed, {
      folderName: basename(dir),
      scenes: discoverScenes(dir),
      pluginModules: discoverPluginModules(dir),
      kind,
      now,
      mintId,
    });
  } catch (error) {
    return { status: 'skipped', reason: error.message, changes: [] };
  }
  const after = JSON.stringify(result.manifest, null, 2) + '\n';
  if (result.changes.length === 0 && after === before) {
    return { status: 'unchanged', changes: [], before, after };
  }
  if (apply) writeFileSync(manifestPath, after);
  return { status: result.changes.length ? 'migrated' : 'reformatted', changes: result.changes, before, after };
}

//! Every direct subdirectory of a projects root, migrated or reported in turn.
export function migrateProjectsRoot(projectsRoot, options = {}) {
  const root = resolve(projectsRoot);
  if (!existsSync(root)) throw new Error(`Projects root not found: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ project: name, ...migrateProjectDir(join(root, name), options) }));
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main(argv) {
  const apply = argv.includes('--apply');
  const rootIndex = argv.indexOf('--projects-root');
  const projectsRoot = rootIndex >= 0 ? argv[rootIndex + 1] : null;
  if (rootIndex >= 0 && !projectsRoot) {
    console.error('--projects-root needs a directory.');
    return 2;
  }
  const kindIndex = argv.indexOf('--kind');
  const kind = kindIndex >= 0 ? argv[kindIndex + 1] : undefined;
  if (kindIndex >= 0 && !isProjectKind(kind)) {
    console.error(`--kind needs one of: ${PROJECT_KINDS.join(', ')}.`);
    return 2;
  }
  // The value slots of the two flags are skipped — but only when the flag is
  // actually present. `indexOf` yields -1 when it is not, and `-1 + 1` is the
  // index of the FIRST positional: written as an unconditional `index !==
  // rootIndex + 1`, this filter silently dropped the one directory a caller
  // named, and the run fell back to migrating every project instead.
  const valueSlots = new Set([rootIndex, kindIndex].filter((i) => i >= 0).map((i) => i + 1));
  const positional = argv.filter((token, index) =>
    !token.startsWith('--') && !valueSlots.has(index));
  if (kindIndex >= 0 && positional.length === 0) {
    // `--kind` names ONE project's nature, so it may only be used with named
    // project directories. Over a whole root it would stamp the same kind onto
    // every unmigrated folder there — and `--kind customer` doing that to a
    // scratch folder is the over-claim the default exists to avoid.
    console.error('--kind applies to named project directories, not to a whole projects root.');
    return 2;
  }

  let results;
  if (positional.length > 0) {
    results = positional.map((dir) => ({ project: basename(resolve(dir)), ...migrateProjectDir(dir, { apply, kind }) }));
  } else {
    results = migrateProjectsRoot(projectsRoot ?? DEFAULT_PROJECTS_ROOT, { apply });
  }

  let failed = 0;
  for (const result of results) {
    if (result.status === 'skipped') {
      // A folder that is not a project does not fail the run: `projects/` also
      // holds scratch material, and refusing to migrate the other five because
      // of it would be the wrong trade.
      console.warn(`skip     ${result.project}: ${result.reason}`);
      failed++;
      continue;
    }
    if (result.status === 'unchanged') {
      console.log(`ok       ${result.project}: already at rv-project/${SCHEMA_VERSION}`);
      continue;
    }
    console.log(`${apply ? 'migrate ' : 'would   '} ${result.project}`);
    for (const change of result.changes) console.log(`           ${change}`);
  }
  if (!apply && results.some((r) => r.status === 'migrated' || r.status === 'reformatted')) {
    console.log('\nDry run — nothing was written. Re-run with --apply to migrate.');
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
