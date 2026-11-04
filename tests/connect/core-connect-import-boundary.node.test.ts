// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-633 Gate R1 #10 — the connection core stays public and plugin-free.
 *
 * `src/core/connect/**` is AGPL core shared by planner, DES and path network.
 * It must import nothing private (`@rv-private`, `@rv-projects`, the private
 * sibling folders) and nothing from `src/plugins/**` — the snap vocabulary
 * moved INTO the core precisely so the engine no longer depends on a plugin.
 *
 * The private folder names are assembled at runtime on purpose: a literal in
 * this file would make the private-test generator classify the guard itself
 * as private-dependent and drop it from the community run it protects.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_CONNECT = join(repoRoot, 'src', 'core', 'connect');

const PRIVATE_FOLDERS = [
  ['realvirtual-WebViewer', 'Private~'].join('-'),
  ['realvirtual', 'web', 'pro'].join('-'),
  ['realvirtual', 'Connect~'].join('-'),
];

const AT_PRIVATE = ['@rv', 'private'].join('-');
const AT_PROJECTS = ['@rv', 'projects'].join('-');

function isForbidden(spec: string): boolean {
  if (spec.startsWith(AT_PRIVATE) || spec.startsWith(AT_PROJECTS)) return true;
  if (PRIVATE_FOLDERS.some((f) => spec.split('/').includes(f))) return true;
  if (/^(\.\.\/)+plugins\//.test(spec) || spec.startsWith('@rv/plugins/')) return true;
  return false;
}

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  for (let m: RegExpExecArray | null; (m = re.exec(source)) !== null;) out.push(m[1]);
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe('core/connect import boundary (plan-633 #10)', () => {
  const files = sourceFiles(CORE_CONNECT);

  it('the guarded folder exists and holds the connection core', () => {
    const names = files.map((f) => relative(CORE_CONNECT, f).replace(/\\/g, '/'));
    expect(names).toContain('rv-connection-resolver.ts');
    expect(names).toContain('snap-name-parser.ts');
  });

  for (const file of files) {
    const rel = relative(repoRoot, file).replace(/\\/g, '/');
    it(`${rel} imports nothing private and nothing from src/plugins`, () => {
      const source = readFileSync(file, 'utf8');
      const offenders = importSpecifiers(source).filter(isForbidden);
      expect(offenders, `${rel} crosses the core/connect boundary`).toEqual([]);
      // Private paths referenced as plain strings fail a community clone just the same.
      expect(PRIVATE_FOLDERS.filter((f) => source.includes(f)), `${rel} names a private folder`).toEqual([]);
    });
  }

  it('the matcher recognises every forbidden form', () => {
    const probe = [
      `import a from '${AT_PRIVATE}/plugins/des/des-runner';`,
      `import b from '${AT_PROJECTS}/X/plugins/index';`,
      `import c from '../../../${PRIVATE_FOLDERS[0]}/src/x';`,
      "import d from '../../plugins/snap-point/snap-name-parser';",
      "import ok from '../engine/rv-snap-point-registry';",
      "import three from 'three';",
    ].join('\n');
    expect(importSpecifiers(probe).filter(isForbidden)).toEqual([
      `${AT_PRIVATE}/plugins/des/des-runner`,
      `${AT_PROJECTS}/X/plugins/index`,
      `../../../${PRIVATE_FOLDERS[0]}/src/x`,
      '../../plugins/snap-point/snap-name-parser',
    ]);
  });
});
