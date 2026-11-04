// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Customer-name guard for the PUBLIC tree (chore/neutralize-customer-names).
 *
 * The public repo is a plain mirror, so a customer's name in a comment, a help text
 * or a doc page is a disclosure. This test reads the customer register
 * (`customers/<slug>.json` of the private sibling) and fails when a register name
 * appears as a whole word in public source or documentation that is not on the
 * allowlist. The names come from the register, never from this file.
 *
 * - READ-ONLY: it never writes the register and cannot block a delivery; it is a test.
 * - Skips without the private sibling (community checkout) or with RV_SKIP_CUSTOMER_NAME_GUARD=1.
 * - Scope: src/, scripts/, root *.md, schema/, examples/, recipes/, skills/, features.catalog.json,
 *   public/ text files. NOT scanned: tests/, e2e/, spikes/, docs/perf (measurement data), projects/.
 * - Test trees (tests/, e2e/, spikes/, docs/): a second, coarser check. Fixtures and test comments
 *   there legitimately name the projects that are already public, so it works per NAME, not per
 *   file: only the names in the allowlist's `testTrees.tolerated` may appear. Every other register
 *   name — a new customer, a project slug, a field report's customer — fails. A
 *   test that pins a non-public customer project belongs in the private sibling's tests/.
 * - Allowlist: `customer-names-allowlist.json` next to this file, per FILE with a reason
 *   (vendor/product name, customer-register logic, example CLI, project path). A new file with a
 *   register name fails; a stale allowlist entry fails too, so the list cannot rot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');

function findPrivateRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.RV_PRIVATE_ROOT) candidates.push(process.env.RV_PRIVATE_ROOT);
  candidates.push(resolve(ROOT, '../realvirtual-WebViewer-Private~'));
  try {
    // A worktree has no sibling; the canonical checkout's sibling holds the same register.
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    candidates.push(resolve(common, '../../realvirtual-WebViewer-Private~'));
  } catch { /* no git */ }
  return candidates.find((c) => existsSync(join(c, 'customers'))) ?? null;
}

//! Generic words of a display name that are not a customer name by themselves.
const GENERIC = new Set(['hochschule', 'industrial', 'security', 'technical', 'college', 'international', 'maschinentechnik']);

/** Names the register declares: slug parts and the first word of the display name. */
export function registerNames(privateRoot: string): string[] {
  const dir = join(privateRoot, 'customers');
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.endsWith('.secrets.json')) continue;
    let entry: { customer?: string; displayName?: string };
    try { entry = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
    for (const part of String(entry.customer ?? file.replace(/\.json$/, '')).toLowerCase().split('-')) {
      if (part.length >= 4) names.add(part);
    }
    const first = String(entry.displayName ?? '').toLowerCase().match(/[a-z0-9]+/)?.[0];
    if (first && first.length >= 4 && !GENERIC.has(first)) names.add(first);
  }
  return [...names].sort();
}

const SCAN_DIRS = ['src', 'scripts', 'schema', 'examples', 'recipes', 'skills', 'public'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'models', 'library', 'aasx', 'private-models', 'knowledge']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.mts', '.cjs', '.md', '.json', '.css', '.html', '.txt']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(full); continue; }
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && TEXT_EXT.has(name.slice(dot)) && st.size < 3_000_000) yield full;
  }
}

const TEST_TREES = ['tests', 'e2e', 'spikes', 'docs'];
function testTreeFiles(): string[] {
  const files: string[] = [];
  for (const d of TEST_TREES) if (existsSync(join(ROOT, d))) files.push(...walk(join(ROOT, d)));
  return files;
}

function scanFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(ROOT)) {
    if ((entry.endsWith('.md') || entry === 'features.catalog.json') && statSync(join(ROOT, entry)).isFile()) files.push(join(ROOT, entry));
  }
  for (const d of SCAN_DIRS) if (existsSync(join(ROOT, d))) files.push(...walk(join(ROOT, d)));
  return files;
}

/** repo-relative file -> sorted names found as whole words (case-insensitive). */
export function findHits(names: string[], files: string[] = scanFiles()): Record<string, string[]> {
  const re = new RegExp(`\\b(${names.join('|')})`, 'gi');
  const hits: Record<string, string[]> = {};
  for (const file of files) {
    const found = new Set<string>();
    for (const m of readFileSync(file, 'utf8').matchAll(re)) found.add(m[1].toLowerCase());
    if (found.size) hits[relative(ROOT, file).split(sep).join('/')] = [...found].sort();
  }
  return hits;
}

const privateRoot = process.env.RV_SKIP_CUSTOMER_NAME_GUARD === '1' ? null : findPrivateRoot();

describe.skipIf(!privateRoot)('public tree carries no customer names (register-driven)', () => {
  const names = privateRoot ? registerNames(privateRoot) : [];
  const allowlist: Record<string, { names: string[]; reason: string }> =
    JSON.parse(readFileSync(join(__dirname, 'customer-names-allowlist.json'), 'utf8')).files;
  const hits = privateRoot ? findHits(names) : {};

  it('reads register names', () => {
    expect(names).toEqual(expect.arrayContaining(['mauser', 'festo']));
  });

  it('has no register name outside the allowlist', () => {
    const unexpected: string[] = [];
    for (const [file, found] of Object.entries(hits)) {
      const allowed = new Set(allowlist[file]?.names ?? []);
      const extra = found.filter((n) => !allowed.has(n));
      if (extra.length) unexpected.push(`${file}: ${extra.join(', ')}`);
    }
    expect(unexpected, 'customer name in public tree - neutralize it, or allowlist it with a reason in tests/customer-names-allowlist.json').toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const stale: string[] = [];
    for (const [file, entry] of Object.entries(allowlist)) {
      if (!entry.reason || entry.reason.length < 8) stale.push(`${file}: no reason`);
      const found = new Set(hits[file] ?? []);
      for (const n of entry.names) if (!found.has(n)) stale.push(`${file}: ${n} no longer present`);
    }
    expect(stale).toEqual([]);
  });
});

describe.skipIf(!privateRoot)('public test trees carry only customer names that are already public', () => {
  const names = privateRoot ? registerNames(privateRoot) : [];
  const testTrees: { tolerated: string[]; reason: string } =
    JSON.parse(readFileSync(join(__dirname, 'customer-names-allowlist.json'), 'utf8')).testTrees;
  const hits = privateRoot ? findHits(names, testTreeFiles()) : {};

  it('has no register name outside testTrees.tolerated', () => {
    const tolerated = new Set(testTrees.tolerated);
    const unexpected: string[] = [];
    for (const [file, found] of Object.entries(hits)) {
      const extra = found.filter((n) => !tolerated.has(n));
      if (extra.length) unexpected.push(`${file}: ${extra.join(', ')}`);
    }
    expect(unexpected, 'customer/project name in a public test tree - neutralize it or move the test to the private sibling').toEqual([]);
  });

  it('has no stale tolerated name', () => {
    const present = new Set(Object.values(hits).flat());
    expect(testTrees.reason.length).toBeGreaterThan(8);
    expect(testTrees.tolerated.filter((n) => !present.has(n))).toEqual([]);
  });
});
