// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-680 §9.1 / §9.2 / §9.13 — DES is part of the public AGPL core.
 *
 * Since plan-680 the whole discrete-event simulation (`src/plugins/des/**`) and its
 * on-demand feature (`src/features/des.register.ts` / `des.body.ts`) live in this repo.
 * This contract keeps it that way:
 *
 *   - no file of the DES tree or the feature adapter names the private sibling, its
 *     import aliases or a project folder — the community clone must build it;
 *   - every file carries the SPDX AGPL header and a realvirtual copyright line;
 *   - relative imports stay inside the public `src/` tree;
 *   - the feature stub imports nothing of the DES body by value, declares itself as
 *     `origin: 'core'` and loads the body lazily, and every component trigger names a
 *     type the DES body registers;
 *   - startup code reaches DES only through the workspace shell, never the body;
 *   - the core never imports from `examples/` (the PalletYard example is content).
 *
 * Deliberately free of every private path string: the exclude generator lists a test
 * that names the private sibling, and this one must run in the community edition
 * (`scripts/gen-private-test-excludes.mjs`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = resolve(ROOT, 'src');
const DES = resolve(SRC, 'plugins/des');
const STUB = resolve(SRC, 'features/des.register.ts');
const BODY = resolve(SRC, 'features/des.body.ts');
const SHELL = resolve(DES, 'des-workspace-plugin.tsx');

// Built from parts so that this file itself never carries the strings it forbids.
const FORBIDDEN = [
  ['@rv', 'private'].join('-'),
  ['@rv', 'projects'].join('-'),
  ['realvirtual-WebViewer', 'Private~'].join('-'),
  ['realvirtual-web', 'pro'].join('-'),
  ['realvirtual', 'Connect~'].join('-'),
];
const SPDX = '// SPDX-License-Identifier: AGPL-3.0-only';
const COPYRIGHT = /^\/\/ Copyright \(C\) (\d{4})(?:-(\d{4}))? realvirtual GmbH <https:\/\/realvirtual\.io>$/;

const norm = (p: string): string => p.replace(/\\/g, '/');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every import specifier (static, dynamic, re-export) of a source. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]);
  return out;
}

/** Value (non-type) import specifiers of a TS source. */
function valueImports(text: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const clause = m[2] ?? '';
    if (m[1] === 'export' && !/[{*]/.test(clause)) continue;
    if (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((s) => s.startsWith('type'))) continue;
    out.push(m[3] ?? m[4]);
  }
  return out;
}

const resolvesInto = (fromFile: string, spec: string, dir: string): boolean =>
  spec.startsWith('.') && norm(resolve(dirname(fromFile), spec)).startsWith(`${norm(dir)}/`);

const desFiles = sourceFiles(DES);
const covered = [...desFiles, STUB, BODY];
const rel = (p: string): string => norm(relative(ROOT, p));

function exampleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(dir, entry.name);
    return entry.isDirectory() ? exampleFiles(file) : [file];
  });
}

const exampleRoots = [
  'src/plugins/models/PalletYard', 'src/plugins/models/AGVDemo',
  'src/plugins/models/AGVFactory', 'tools/des-examples',
];
//! Tests that name the private sibling ON PURPOSE (they prove something is gone from it)
//! and stay on the private-dependent list.
const PRIVATE_BY_DESIGN = new Set(['tests/des/des-legacy-retired.node.test.ts']);
const exampleSources = [
  ...exampleRoots.flatMap((dir) => exampleFiles(resolve(ROOT, dir))),
  ...exampleFiles(resolve(ROOT, 'tests/des')).filter((file) =>
    (/\/(?:des-|pallet-yard-)[^/]+\.(?:ts|tsx)$/.test(norm(file))
      || norm(file).includes('/fixtures/'))
    && !PRIVATE_BY_DESIGN.has(norm(relative(ROOT, file)))),
];

describe('plan-680: DES is public core code', () => {
  it('§9.2 / §9.13 examples and DES tests have public paths and licensed source', () => {
    const forbidden = [...FORBIDDEN,
      ['projects', 'DiscreteEventSimulation'].join('/'),
      ['', 'private-assets', ''].join('/'),
    ];
    const offenders: string[] = [];
    for (const file of exampleSources) {
      if (!/\.(?:ts|tsx|mjs|mts|md|json|txt)$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const needle of forbidden) if (text.includes(needle)) offenders.push(`${rel(file)}: ${needle}`);
      if (/\.(?:ts|tsx|mjs|mts)(?:\.txt)?$/.test(file)) {
        const [first, second] = text.replace(/^#![^\n]*\n/, '').split(/\r?\n/, 2);
        if (first !== SPDX || !COPYRIGHT.test(second ?? '')) offenders.push(`${rel(file)}: license header`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('§9.8b the public DES scenes and AGV library files are real GLBs', () => {
    for (const name of ['AGVDemo.glb', 'AGVFactory.glb', 'PalletYard.glb', 'library/AGV.glb', 'library/Custom/Course.glb']) {
      const bytes = readFileSync(resolve(ROOT, 'public/demo-realvirtual', name));
      expect(bytes.subarray(0, 4).toString('ascii'), name).toBe('glTF');
    }
  });

  it('the DES tree carries the remaining inventory (45 files)', () => {
    expect(desFiles.length).toBeGreaterThanOrEqual(45);
    expect(desFiles.map(norm)).toContain(norm(resolve(DES, 'des-runner.ts')));
    expect(desFiles.map(norm)).toContain(norm(SHELL));
  });

  it('§9.1 no file names the private sibling, its aliases or a project folder', () => {
    const offenders: string[] = [];
    for (const file of covered) {
      const text = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) if (text.includes(needle)) offenders.push(`${rel(file)}: ${needle}`);
      for (const spec of specifiers(text)) if (/(^|\/)projects\//.test(spec)) offenders.push(`${rel(file)} → ${spec}`);
    }
    expect(offenders).toEqual([]);
  });

  it('§9.2 / §9.13 every file starts with the SPDX AGPL header and a realvirtual copyright line', () => {
    const offenders: string[] = [];
    for (const file of covered) {
      const [first, second] = readFileSync(file, 'utf8').split(/\r?\n/, 2);
      const m = COPYRIGHT.exec(second ?? '');
      if (first !== SPDX || !m || Number(m[1]) < 2019 || Number(m[2] ?? m[1]) > 2026) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('relative imports stay inside the public src/ tree', () => {
    const offenders: string[] = [];
    for (const file of covered) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        if (!norm(resolve(dirname(file), spec)).startsWith(`${norm(SRC)}/`)) offenders.push(`${rel(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the feature stub declares des on demand, origin core, without a DES value import', () => {
    const stub = readFileSync(STUB, 'utf8');
    expect(valueImports(stub).filter((s) => resolvesInto(STUB, s, DES))).toEqual([]);
    expect(stub).toMatch(/load:\s*\(\)\s*=>\s*import\('\.\/des\.body'\)/);
    expect(stub).toMatch(/origin:\s*'core'/);
    const block = /const ACTIVATION = \[([^\]]*)\]/.exec(stub)?.[1] ?? '';
    const activation = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(activation).toContain('mode:des');
    expect(activation).toContain('command:sim.discrete');
    expect(activation.filter((t) => t.startsWith('component:')).length).toBeGreaterThan(0);
  });

  it('the body installs the des-hmi plugin with origin core', () => {
    const body = readFileSync(BODY, 'utf8');
    const uses = [...body.matchAll(/viewer\.use\([^,]+,\s*'([a-z]+)'\)/g)].map((m) => m[1]);
    expect(uses).toEqual(['core']);
  });

  it('every component trigger of des names a type the DES body registers', () => {
    const registered = new Set<string>(['DESManager']); // public settings node (core/material-flow/des-manager-node.ts)
    for (const file of desFiles) {
      for (const m of readFileSync(file, 'utf8').matchAll(/^\s*type: '([A-Za-z]+)',/gm)) registered.add(m[1]);
    }
    const block = /const ACTIVATION = \[([^\]]*)\]/.exec(readFileSync(STUB, 'utf8'))?.[1] ?? '';
    const missing = [...block.matchAll(/'component:([^']+)'/g)].map((m) => m[1]).filter((t) => !registered.has(t));
    expect(missing).toEqual([]);
  });

  it('startup code reaches DES only through the workspace shell, never the body', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const n = norm(file);
      if (n.startsWith(`${norm(DES)}/`) || n === norm(BODY)) continue;
      for (const spec of valueImports(readFileSync(file, 'utf8'))) {
        if (!resolvesInto(file, spec, DES)) continue;
        if (norm(resolve(dirname(file), spec)).replace(/\.tsx?$/, '') === norm(SHELL).replace(/\.tsx$/, '')) continue;
        offenders.push(`${rel(file)} → ${spec}`);
      }
    }
    // …and the shell itself imports no DES body module statically.
    for (const spec of valueImports(readFileSync(SHELL, 'utf8'))) {
      if (resolvesInto(SHELL, spec, DES)) offenders.push(`${rel(SHELL)} → ${spec}`);
    }
    expect(offenders).toEqual([]);
  });

  it('§9.8b the core never imports from examples/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        // Only the repo's own examples/ folder (three/examples/jsm is an npm path).
        if (spec.startsWith('.') && norm(resolve(dirname(file), spec)).startsWith(`${norm(resolve(ROOT, 'examples'))}/`)) {
          offenders.push(`${rel(file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
