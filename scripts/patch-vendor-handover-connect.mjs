// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * patch-vendor-handover-connect — adds the per-zone `*.connect.json` handover
 * globs to a project that already has a `vendor` block (plan-725 Phase 6, F8).
 *
 * ## Why this exists next to migrate-project-manifest.mjs
 *
 * `migrate-project-manifest.mjs` seeds `vendor` from `DEFAULT_VENDOR_BLOCK`, but
 * only for a project that has none yet — `if (next.vendor === undefined)`.
 * A project that was already migrated keeps its own block forever, and that is
 * **deliberate**, not an oversight: quoting the migrator, the default is written
 * only where nothing existed so that *"the first delivery after migration cannot
 * touch customer data even if nobody reviews it."* A migrator that rewrote an
 * existing `vendor` block would be a migrator that can silently re-claim a zone a
 * human had narrowed on purpose.
 *
 * So the default block reaching customers is not something the migrator can do —
 * and should not become something it does. This script is the deliberate,
 * explicitly invoked counterpart: it is aimed at one repository at a time, by a
 * human who intends exactly this change, and it can therefore do what the
 * migrator must not.
 *
 * ## What it touches
 *
 * `vendor.handover`, and nothing else. Not `vendor.managed` — narrowing that is a
 * human judgement per project — and no other field of the manifest.
 *
 * The candidate zones come from the project's **own** `managed` list, not from
 * the default six, and each candidate is then checked against the real
 * validator. That cuts both ways, and both directions are real:
 *
 * - a project sharpened down to `models/**` gets the two `models/` entries and
 *   nothing else — adding the rest would leave `vendorGlobProblems()` reporting
 *   entries with no effect;
 * - a project that manages a zone the default never mentions gets that zone
 *   covered too. Toray's manifest manages `cad/**`; with a fixed twelve-glob
 *   list a configuration the customer put under `cad/` would still be
 *   classified as ours and overwritten — the exact failure F8 exists to prevent.
 *
 * ## Refusals
 *
 * - no `project.json`, or unparsable → skipped
 * - no `vendor` block at all → **refused**. Such a project is the migrator's job
 *   (`migrate-project-manifest.mjs`), which writes the whole default block
 *   including these globs. Inventing a `handover` list next to an absent
 *   `managed` list would create a manifest shape no other tool produces.
 * - `vendor` is not an object, or `vendor.handover` is present but not an array
 *   → refused, rather than repaired.
 * - the patched block would not validate → refused, nothing written.
 *
 * Idempotent by construction: a glob already present is never added twice, so a
 * second run reports `unchanged` and writes nothing.
 *
 * Usage:
 *   node scripts/patch-vendor-handover-connect.mjs <dir> [<dir>…]        # dry run
 *   node scripts/patch-vendor-handover-connect.mjs <dir> --apply         # write
 *   node scripts/patch-vendor-handover-connect.mjs --projects-root <dir> # every project below
 *
 * `--apply` is required to write; a dry run showing the diff is the DEFAULT.
 *
 * Exit codes: 0 = nothing to do or patched, 1 = at least one target was refused
 * or skipped, 2 = bad usage.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONNECT_CONFIG_HANDOVER_GLOBS, vendorGlobProblems } from './_rv-guards.mjs';

const MANIFEST = 'project.json';

// ─── Pure patch ──────────────────────────────────────────────────────────

/**
 * The literal folder prefix of one `managed` glob, or null when it has none.
 *
 * `models/**` → `models`, `models/vendor/**` → `models/vendor`, `*.glb` → null.
 * A glob whose very first segment is a wildcard names no folder to protect, and
 * inventing one from it would be guessing.
 */
export function zoneOf(glob) {
  if (typeof glob !== 'string') return null;
  const segments = glob.split('/');
  const literal = [];
  for (const segment of segments) {
    if (segment.includes('*') || segment.includes('?')) break;
    literal.push(segment);
  }
  // A glob with no wildcard at all names a FILE, so its last segment is not a
  // folder and is dropped: `connect/secrets.local.json` yields `connect`, not
  // itself. Whether that folder then earns a handover glob is not decided here
  // — the validator gate below rejects one whose zone `managed` does not
  // actually claim, which is precisely this case.
  if (literal.length === segments.length) literal.pop();
  return literal.length > 0 ? literal.join('/') : null;
}

/**
 * The candidate globs this project can actually use.
 *
 * Derived from the project's **own** `managed` list rather than from the six
 * default zones, because a sharpened block goes both ways. Toray manages a
 * `cad/**` zone that the default never mentions; with a fixed twelve-glob list
 * a configuration the customer put under `cad/` would still be classified as
 * ours and overwritten — which is the exact failure F8 exists to prevent.
 *
 * "Can use" is then decided by the validator itself: a handover glob outside
 * every `managed` glob is what `vendorGlobProblems()` refuses, so each candidate
 * is offered to it alone and kept only if it comes back clean. No
 * glob-containment logic is reimplemented here.
 */
export function applicableGlobs(managed) {
  const list = Array.isArray(managed) ? managed : [];
  const zones = [];
  for (const glob of list) {
    const zone = zoneOf(glob);
    if (zone && !zones.includes(zone)) zones.push(zone);
  }
  const candidates = [];
  for (const zone of zones) {
    for (const candidate of [`${zone}/*.connect.json`, `${zone}/**/*.connect.json`]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates.filter(
    (glob) => vendorGlobProblems({ managed: list, handover: [glob] }).length === 0,
  );
}

/**
 * Adds the missing per-zone connect-config globs to one parsed manifest.
 *
 * Pure: returns a new object and never mutates the input.
 *
 * @returns `{ status, manifest, added, skipped, reason }` where `status` is
 *          `'patched' | 'unchanged' | 'refused'`.
 */
export function patchManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'refused', reason: `${MANIFEST} is not a JSON object.`, added: [], skipped: [] };
  }
  const vendor = manifest.vendor;
  if (vendor === undefined || vendor === null) {
    return {
      status: 'refused',
      reason: 'no "vendor" block — run migrate-project-manifest.mjs, which writes the full default including these globs.',
      added: [],
      skipped: [],
    };
  }
  if (typeof vendor !== 'object' || Array.isArray(vendor)) {
    return { status: 'refused', reason: '"vendor" is not a JSON object.', added: [], skipped: [] };
  }
  if (vendor.handover !== undefined && !Array.isArray(vendor.handover)) {
    return { status: 'refused', reason: '"vendor.handover" is present but not an array.', added: [], skipped: [] };
  }
  if (vendor.managed !== undefined && !Array.isArray(vendor.managed)) {
    return { status: 'refused', reason: '"vendor.managed" is present but not an array.', added: [], skipped: [] };
  }

  const handover = Array.isArray(vendor.handover) ? vendor.handover : [];
  const applicable = applicableGlobs(vendor.managed);
  const skipped = CONNECT_CONFIG_HANDOVER_GLOBS.filter((glob) => !applicable.includes(glob));
  const added = applicable.filter((glob) => !handover.includes(glob));
  if (added.length === 0) {
    return { status: 'unchanged', manifest, added: [], skipped };
  }

  // Only `vendor.handover` is replaced. `vendor.managed`, every other key of
  // `vendor`, and every other key of the manifest are carried over by identity.
  const nextHandover = [...handover, ...added];
  const next = { ...manifest, vendor: { ...vendor, handover: nextHandover } };

  const problems = vendorGlobProblems(next.vendor);
  if (problems.length > 0) {
    return { status: 'refused', reason: `patched block would not validate: ${problems.join(' ')}`, added: [], skipped };
  }
  return { status: 'patched', manifest: next, added, skipped };
}

// ─── Diff ────────────────────────────────────────────────────────────────

/**
 * A compact diff of two texts, trimmed to the block that actually differs.
 *
 * The expected edit is one contiguous run of added lines inside `handover`, so
 * trimming the common prefix and suffix is enough and keeps the output readable.
 * When a run *does* produce a large block — a manifest that was not stored in
 * the canonical 2-space form and gets normalised by the write — that shows up
 * here as the large block it is, which is the point.
 */
export function compactDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
         && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines = [];
  for (const line of a.slice(head, a.length - tail)) lines.push(`- ${line}`);
  for (const line of b.slice(head, b.length - tail)) lines.push(`+ ${line}`);
  return lines;
}

// ─── Filesystem side ─────────────────────────────────────────────────────

/**
 * Patches the manifest of one project directory.
 *
 * @returns `{ status, added, skipped, before, after, diff, reformats, reason }`
 *          where `status` is `'patched' | 'unchanged' | 'refused' | 'skipped'`.
 */
export function patchProjectDir(projectDir, { apply = false } = {}) {
  const dir = resolve(projectDir);
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return { status: 'skipped', reason: `${MANIFEST} is missing — not a project folder.`, added: [], skipped: [], diff: [] };
  }
  const before = readFileSync(manifestPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(before);
  } catch (error) {
    return { status: 'skipped', reason: `${MANIFEST} is not valid JSON: ${error.message}`, added: [], skipped: [], diff: [] };
  }
  const result = patchManifest(parsed);
  if (result.status !== 'patched') {
    return { ...result, before, after: before, diff: [], reformats: false };
  }
  // The trailing newline follows the file, it is not imposed on it. Measured
  // rather than assumed: all three delivered customer manifests are written by
  // the browser save path and end WITHOUT one, while migrate-project-manifest
  // adds one — so a fixed convention here would put a spurious one-byte change
  // into every customer repository this is ever pointed at.
  const eof = before.endsWith('\n') ? '\n' : '';
  const after = JSON.stringify(result.manifest, null, 2) + eof;
  // Anything else that is not canonical WOULD be normalised by the write.
  // Reported rather than refused — but reported, because a delivery diff that
  // touches every line of project.json is not what anybody asked for.
  const reformats = JSON.stringify(parsed, null, 2) + eof !== before;
  if (apply) writeFileSync(manifestPath, after);
  return { ...result, before, after, diff: compactDiff(before, after), reformats };
}

//! Every direct subdirectory of a projects root, patched or reported in turn.
export function patchProjectsRoot(projectsRoot, options = {}) {
  const root = resolve(projectsRoot);
  if (!existsSync(root)) throw new Error(`Projects root not found: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ project: name, ...patchProjectDir(join(root, name), options) }));
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
  const valueSlots = new Set([rootIndex].filter((i) => i >= 0).map((i) => i + 1));
  const positional = argv.filter((token, index) => !token.startsWith('--') && !valueSlots.has(index));
  if (positional.length === 0 && !projectsRoot) {
    // No default target on purpose: this writes into customer repositories, and
    // "which repository" is never something it should guess.
    console.error('Usage: node scripts/patch-vendor-handover-connect.mjs <project-dir>… [--apply]');
    console.error('       node scripts/patch-vendor-handover-connect.mjs --projects-root <dir> [--apply]');
    return 2;
  }

  let results;
  try {
    results = positional.length > 0
      ? positional.map((dir) => ({ project: basename(resolve(dir)), ...patchProjectDir(dir, { apply }) }))
      : patchProjectsRoot(projectsRoot, { apply });
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  let failed = 0;
  for (const result of results) {
    if (result.status === 'skipped' || result.status === 'refused') {
      console.warn(`${result.status === 'refused' ? 'refuse  ' : 'skip    '} ${result.project}: ${result.reason}`);
      failed++;
      continue;
    }
    if (result.status === 'unchanged') {
      console.log(`ok       ${result.project}: connect-config handover globs already present`);
      continue;
    }
    console.log(`${apply ? 'patch   ' : 'would   '} ${result.project}: +${result.added.length} handover glob(s)`);
    for (const glob of result.added) console.log(`           + ${glob}`);
    if (result.skipped.length > 0) {
      console.log(`           (${result.skipped.length} zone glob(s) not applicable — "managed" does not claim them)`);
    }
    if (result.reformats) {
      console.log('           note: writing also normalises this manifest to 2-space JSON.');
    }
    for (const line of result.diff) console.log(`           ${line}`);
  }
  if (!apply && results.some((r) => r.status === 'patched')) {
    console.log('\nDry run — nothing was written. Re-run with --apply to patch.');
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
