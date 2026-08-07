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
 * Usage:
 *   node scripts/migrate-project-manifest.mjs                 # all projects, dry run
 *   node scripts/migrate-project-manifest.mjs --apply         # all projects, write
 *   node scripts/migrate-project-manifest.mjs <dir> [<dir>…]  # named projects
 *   node scripts/migrate-project-manifest.mjs --projects-root <dir>
 *
 * Exit codes: 0 = nothing to do or migration succeeded, 1 = a project could not
 * be migrated, 2 = bad usage.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VENDOR_BLOCK } from './_rv-guards.mjs';

const MANIFEST = 'project.json';
const SCHEMA_VERSION = 1;

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
 * @param context   `{ folderName, scenes, now, mintId }` — `scenes` is the list
 *                  of `{ id, name, path }` discovered on disk by the caller.
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

  if (typeof next.schemaVersion !== 'number' || next.schemaVersion < 1) {
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
  if (typeof next.createdAt !== 'string' || !next.createdAt.trim()) {
    const legacy = typeof next.created === 'string' && next.created.trim() ? next.created.trim() : null;
    set('createdAt', legacy ?? now, legacy ? 'taken from the legacy "created"' : 'set to now (unknown)');
  }
  if (typeof next.modifiedAt !== 'string' || !next.modifiedAt.trim()) {
    set('modifiedAt', next.createdAt, 'seeded from createdAt');
  }
  if (next.scenes === undefined && scenes.length > 0) {
    set('scenes', scenes, `indexed ${scenes.length} scene file(s) from scenes/`);
  } else if (Array.isArray(next.scenes) && scenes.length > 0) {
    // Additive only. An entry the user renamed or annotated keeps its fields;
    // a scene file with no entry gains one. Nothing is ever removed here — a
    // manifest entry without a file is the validator's warning to give, not
    // this script's data to delete.
    const known = new Set(next.scenes.map((e) => (e && typeof e === 'object' ? e.path : null)).filter(Boolean));
    const added = scenes.filter((s) => !known.has(s.path));
    if (added.length) set('scenes', [...next.scenes, ...added], `added ${added.length} scene file(s) missing from the index`);
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
  return readdirSync(scenesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.scene.json'))
    .map((entry) => entry.name)
    .sort()
    .map((fileName) => {
      const path = `scenes/${fileName}`;
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(join(scenesDir, fileName), 'utf8'));
      } catch {
        // A scene file we cannot parse still exists and still belongs to the
        // project; indexing it by filename is better than pretending it is not
        // there. The validator reports the unreadable file separately.
      }
      const id = typeof parsed?.id === 'string' && parsed.id.trim()
        ? parsed.id
        : fileName.replace(/\.scene\.json$/, '');
      const name = typeof parsed?.name === 'string' && parsed.name.trim()
        ? parsed.name
        : fileName.replace(/\.scene\.json$/, '');
      return { id, name, path };
    });
}

/**
 * Migrates the manifest of one project directory.
 *
 * @returns `{ status, changes, before, after }` where `status` is
 *          `'migrated' | 'unchanged' | 'skipped'`.
 */
export function migrateProjectDir(projectDir, { apply = false, now = undefined, mintId = undefined } = {}) {
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
    result = migrateManifest(parsed, { folderName: basename(dir), scenes: discoverScenes(dir), now, mintId });
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
  const positional = argv.filter((token, index) =>
    !token.startsWith('--') && index !== rootIndex + 1);

  let results;
  if (positional.length > 0) {
    results = positional.map((dir) => ({ project: basename(resolve(dir)), ...migrateProjectDir(dir, { apply }) }));
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
