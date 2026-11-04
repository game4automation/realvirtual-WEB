// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-900 section 2.3 / A7 guard: the shared ModeManager double must carry
 * every member reached through `.modes.*` in public or private viewer source,
 * and every such member must really belong to ModeManager. The exclusions are
 * exact source locations because those three receivers are `plugin.modes`
 * string arrays, not the viewer's manager.
 *
 * F8 remains open: inline-built mode stubs in individual test files are not
 * covered here. This invariant checks only the shared double.
 *
 * Known limitation: the rule sees only dot access. Destructuring such as
 * `const { has } = viewer.modes` and computed access such as
 * `viewer.modes[name]` escape it. Neither exists today (checked by the scan).
 * If one appears, extend the rule; do not weaken the invariant.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modeManagerDouble } from './fixtures/mode-manager-double';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface SurfaceHit {
  file: string;
  line: number;
  member: string;
}

const EXCLUSIONS: readonly (SurfaceHit & { reason: string })[] = [
  {
    file: 'src/core/rv-mode-manager.ts',
    line: 759,
    member: 'includes',
    reason: 'plugin.modes.includes(mode) — plugin.modes is string[], not the ModeManager',
  },
  {
    file: 'src/core/rv-ui-registry.ts',
    line: 88,
    member: 'length',
    reason: 'plugin.modes && plugin.modes.length > 0 — same string[]',
  },
  {
    file: 'src/core/rv-ui-registry.ts',
    line: 89,
    member: 'map',
    reason: 'plugin.modes.map(...) — same string[]',
  },
];

function repoPath(file: string): string {
  return relative(root, file).replaceAll('\\', '/');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const scannedFiles = [
  ...walk(join(root, 'src')),
  ...walk(resolve(root, '..', 'realvirtual-WebViewer-Private~', 'src')),
].sort();

const allHits: SurfaceHit[] = [];
for (const file of scannedFiles) {
  const text = readFileSync(file, 'utf8');
  const pattern = /\.modes\.([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of text.matchAll(pattern)) {
    allHits.push({
      file: repoPath(file),
      line: text.slice(0, match.index).split('\n').length,
      member: match[1],
    });
  }
}

function sameHit(a: SurfaceHit, b: SurfaceHit): boolean {
  return a.file === b.file && a.line === b.line && a.member === b.member;
}

const surface = new Set(
  allHits
    .filter((hit) => !EXCLUSIONS.some((exclusion) => sameHit(hit, exclusion)))
    .map((hit) => hit.member),
);

const managerSource = readFileSync(join(root, 'src', 'core', 'rv-mode-manager.ts'), 'utf8');
const classStart = managerSource.indexOf('export class ModeManager {');
const afterClassStart = managerSource.slice(classStart);
const classEnd = afterClassStart.search(/^}\r?$/m);
const managerClassSource = classStart >= 0 && classEnd >= 0
  ? afterClassStart.slice(0, classEnd)
  : '';
const managerMembers = new Set<string>();
const declaration = /^ {2}(?:(?:public|private|protected|static|readonly)\s+)*(?:(?:async|get|set)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|=|:)/gm;
for (const match of managerClassSource.matchAll(declaration)) managerMembers.add(match[1]);

const doubleKeys = new Set(Reflect.ownKeys(modeManagerDouble()));
const DOUBLE_ONLY = new Set([
  'setActive', // Pure test setter; ModeManager has no corresponding member.
]);

function names(values: Iterable<PropertyKey>): string {
  return [...values].map(String).sort().join(', ');
}

describe('plan-900 shared ModeManager double surface', () => {
  it('scans a plausible source surface', () => {
    // A wrong glob otherwise yields an empty surface and a passing invariant.
    expect(scannedFiles.length, `scanned only ${scannedFiles.length} TypeScript source files`).toBeGreaterThan(200);
    expect(surface.size, `found only ${surface.size} distinct .modes.* members`).toBeGreaterThanOrEqual(15);
  });

  it('every exclusion row still matches a real hit', () => {
    const stale = EXCLUSIONS.filter((exclusion) => !allHits.some((hit) => sameHit(hit, exclusion)));
    expect(
      stale,
      `stale exclusions (re-verify each row because the code moved): ${stale.map((row) => `${row.file}:${row.line} ${row.member} - ${row.reason}`).join(', ')}`,
    ).toEqual([]);
  });

  it('every scanned .modes.* member exists on the real ModeManager', () => {
    const missing = [...surface].filter((member) => !managerMembers.has(member));
    expect(missing, `not declared on ModeManager: ${names(missing)}`).toEqual([]);
  });

  it('every scanned .modes.* member is present on the shared double', () => {
    const missing = [...surface].filter((member) => !doubleKeys.has(member));
    expect(missing, `missing from modeManagerDouble: ${names(missing)}`).toEqual([]);
  });

  it('the double carries no unexplained extras', () => {
    const unexplained = [...doubleKeys].filter((key) => (
      typeof key !== 'string'
      || (!surface.has(key) && !managerMembers.has(key) && !DOUBLE_ONLY.has(key))
    ));
    expect(unexplained, `unexplained modeManagerDouble keys: ${names(unexplained)}`).toEqual([]);
  });
});
