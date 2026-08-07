// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-inventory-diff.mjs — the safety net for plan-375.
 *
 * plan-375 rebuilds the bodies of the five most expensive test files. The hard
 * requirement of that plan is "null deletion": no test may disappear and no
 * assertion may be weakened. A green run does NOT prove that — a test that was
 * quietly removed, or flipped from `it(...)` to `it.skip(...)`, also produces a
 * green run.
 *
 *   node scripts/test-inventory-diff.mjs <before.json> <after.json>
 *
 * Both arguments are vitest `--reporter=json` outputs:
 *
 *   npx vitest run --reporter=json --outputFile=before.json
 *   ...change something...
 *   npx vitest run --reporter=json --outputFile=after.json
 *   node scripts/test-inventory-diff.mjs before.json after.json
 *
 * Two failure classes, both exit code 1:
 *
 *   LOST      — the key `file::testname` existed before and is gone now.
 *   SILENCED  — the key still exists, but its status went from `passed` to
 *               `skipped` / `pending` / `todo`.
 *
 * The second class is the one that matters and the reason this is not a plain
 * set difference. Verified empirically against a real report: a skipped test is
 * still emitted, with an identical title, only `"status":"skipped"`. A pure
 * membership diff would therefore wave an `it` -> `it.skip` slip straight
 * through. That is exactly the mistake this script exists to catch.
 *
 * What it deliberately does NOT report:
 *   - newly added tests (informational only — adding tests is always allowed)
 *   - `passed` -> `failed` (the suite's own exit code already covers that)
 *   - a weakened assertion under an unchanged name and status. No name-level
 *     diff can see that; plan-375 section 9.3 covers it with fault injection.
 */

import { readFileSync } from 'node:fs';

//! Statuses that mean "this test no longer executes".
const MUTED_STATUSES = new Set(['skipped', 'pending', 'todo']);

//! Path segments that mark the start of a repo-relative path. Reports taken in
//! different worktrees carry different absolute prefixes; cutting here makes the
//! keys comparable without collapsing the public and private test trees onto
//! each other.
const ROOT_MARKERS = ['realvirtual-WebViewer-Private~/', 'realvirtual-WebViewer~/'];

//! Normalize a report's absolute test-file path to a stable, comparable key.
export function normalizeFilePath(filePath) {
  const slashed = String(filePath ?? '').replace(/\\/g, '/');
  for (const marker of ROOT_MARKERS) {
    const at = slashed.lastIndexOf(marker);
    if (at !== -1) return slashed.slice(at + marker.length);
  }
  return slashed;
}

//! Build `Map<"file::fullName", status>` from a parsed vitest JSON report.
//!
//! Duplicate names inside one file get a `#n` suffix so that removing one of two
//! identically named tests is still detected as a loss.
export function buildInventory(report) {
  const inventory = new Map();
  const files = Array.isArray(report?.testResults) ? report.testResults : [];

  for (const file of files) {
    const name = normalizeFilePath(file?.name);
    const assertions = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
    const seen = new Map();

    for (const assertion of assertions) {
      const title = assertion?.fullName ?? assertion?.title ?? '<unnamed>';
      const occurrence = (seen.get(title) ?? 0) + 1;
      seen.set(title, occurrence);
      const key = occurrence === 1 ? `${name}::${title}` : `${name}::${title}#${occurrence}`;
      inventory.set(key, String(assertion?.status ?? 'unknown'));
    }
  }

  return inventory;
}

//! Read a vitest JSON report from disk and turn it into an inventory.
export function loadInventory(path) {
  const raw = readFileSync(path, 'utf8');
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!Array.isArray(report?.testResults)) {
    throw new Error(
      `${path} has no "testResults" array — is it a vitest --reporter=json output?`,
    );
  }
  return buildInventory(report);
}

//! Compare two inventories. Returns the two failure classes plus an `added`
//! list, which is informational and never fails the check.
export function diffInventories(before, after) {
  const lost = [];
  const silenced = [];

  for (const [key, status] of before) {
    if (!after.has(key)) {
      lost.push(key);
      continue;
    }
    const now = after.get(key);
    if (status === 'passed' && MUTED_STATUSES.has(now)) {
      silenced.push({ key, from: status, to: now });
    }
  }

  const added = [...after.keys()].filter((key) => !before.has(key));
  return { lost, silenced, added };
}

function main(argv) {
  const [beforePath, afterPath] = argv;
  if (!beforePath || !afterPath) {
    process.stderr.write(
      'Usage: node scripts/test-inventory-diff.mjs <before.json> <after.json>\n',
    );
    return 2;
  }

  let before;
  let after;
  try {
    before = loadInventory(beforePath);
    after = loadInventory(afterPath);
  } catch (error) {
    process.stderr.write(
      `[test-inventory-diff] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const { lost, silenced, added } = diffInventories(before, after);

  for (const key of lost) process.stderr.write(`LOST:      ${key}\n`);
  for (const entry of silenced) {
    process.stderr.write(`SILENCED:  ${entry.key}  (${entry.from} -> ${entry.to})\n`);
  }

  process.stdout.write(
    `[test-inventory-diff] before=${before.size} after=${after.size} ` +
      `lost=${lost.length} silenced=${silenced.length} added=${added.length}\n`,
  );

  if (lost.length || silenced.length) {
    process.stderr.write(
      `[test-inventory-diff] FAILED — ${lost.length} lost, ${silenced.length} silenced. ` +
        'plan-375 forbids removing or muting tests.\n',
    );
    return 1;
  }

  process.stdout.write('[test-inventory-diff] OK — no test lost, none silenced.\n');
  return 0;
}

// Only act as a CLI when invoked directly; the self-test imports the helpers.
if (process.argv[1] && normalizeFilePath(process.argv[1]).endsWith('scripts/test-inventory-diff.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
