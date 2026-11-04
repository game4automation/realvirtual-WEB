// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-900 A9 — `scripts/test-hang-predict.mjs`.
 *
 * The cases here are the ones that have actually gone wrong, not a tour of the API:
 *   - a factory parameter that is NOT called `importOriginal` (our tree writes `original`) must
 *     still count — missing it hid one of the five known hangers;
 *   - a broken file selection (0 files, or files that cannot be read) must FAIL, not report a
 *     clean bill of health, which is the whole reason A9 demands the scan count;
 *   - a plain stub factory must NOT count, or the rule would name 49 files instead of 5.
 *
 * Runner: `npm run test:node`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'test-hang-predict.mjs');

const predictor = (await import(pathToFileURL(SCRIPT).href)) as {
  SUITES: Record<string, string>;
  staticImports(text: string): string[];
  originalMocks(text: string): string[];
  applyAliases(specifier: string, aliases: { find: string | RegExp; replacement: string }[]): string;
  resolveModule(specifier: string, fromFile: string, aliases: unknown[], options?: { root?: string }): string | null;
  buildGraph(entries: string[], aliases: unknown[], options?: { root?: string; extraEdges?: [string, string][] }): { edges: Map<string, string[]>; read: Set<string>; unreadable: string[]; unresolved: string[] };
  modulesInCycles(edges: Map<string, string[]>): Set<string>;
  unknownSpecifier(specifier: string, options?: { root?: string }): boolean;
  predict(testFiles: string[], aliases: unknown[], options?: { root?: string; extraEdges?: [string, string][] }): { scanned: number; modules: number; cyclicModules: number; unreadable: string[]; unresolved: string[]; hits: { file: string; mocked: { specifier: string; module: string }[] }[] };
  loadAliases(configFile: string, options?: { root?: string }): Promise<{ find: string | RegExp; replacement: string }[]>;
  parseArgv(argv: string[]): { suite: string; json: boolean; files: string[]; config?: string };
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
function scratch(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-hang-predict-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe('test-hang-predict (plan-900 A9)', { timeout: 120_000 }, () => {
  it('counts a factory that asks for the original WHATEVER its parameter is called', () => {
    // The spelling that hid `editor-save-shortcut.test.ts` from the first version of the rule.
    expect(predictor.originalMocks(`
      vi.mock('./a', async (original) => {
        const actual = await original<typeof import('./a')>();
        return { ...actual };
      });
    `)).toEqual(['./a']);
    expect(predictor.originalMocks(`
      vi.mock('./b', async (importOriginal) => ({ ...(await importOriginal()) }));
    `)).toEqual(['./b']);
    // NEGATIVE CONTROL: a plain stub factory, and a mock without a factory, break the cycle.
    expect(predictor.originalMocks(`
      vi.mock('./c', () => ({ thing: class {} }));
      vi.mock('./d');
      vi.mock('./e', (unused) => ({ x: 1 }));
    `)).toEqual([]);
  });

  it('reads static imports and ignores dynamic ones', () => {
    const text = `
      import a from './a';
      import { b } from "./b";
      export { c } from './c';
      import './side-effect';
      const lazy = await import('./not-static');
    `;
    expect(predictor.staticImports(text).sort()).toEqual(['./a', './b', './c', './side-effect']);
  });

  it('finds the modules on a cycle, and only those', () => {
    const edges = new Map<string, string[]>([
      ['a', ['b']], ['b', ['c']], ['c', ['a']], // a cycle
      ['d', ['a']], ['e', []], ['f', ['f']], // a caller, a leaf, a self-loop
    ]);
    const cyclic = predictor.modulesInCycles(edges);
    expect([...cyclic].sort()).toEqual(['a', 'b', 'c', 'f']);
  });

  it('end to end on a scratch tree: the cycle + original mock is named, the stub and the acyclic one are not', () => {
    const dir = scratch({
      'src/x.ts': "import './y';\nexport const x = 1;\n",
      'src/y.ts': "import './x';\nexport const y = 1;\n",
      'src/leaf.ts': 'export const leaf = 1;\n',
      'tests/hangs.test.ts': "import '../src/x';\nvi.mock('../src/x', async (original) => ({ ...(await original()) }));\n",
      'tests/stub.test.ts': "import '../src/x';\nvi.mock('../src/x', () => ({ x: 2 }));\n",
      'tests/acyclic.test.ts': "import '../src/leaf';\nvi.mock('../src/leaf', async (original) => ({ ...(await original()) }));\n",
    });
    const files = ['tests/hangs.test.ts', 'tests/stub.test.ts', 'tests/acyclic.test.ts'].map((f) => path.join(dir, f));
    const result = predictor.predict(files, [], { root: dir });
    expect(result.scanned).toBe(3);
    expect(result.unreadable).toEqual([]);
    expect(result.cyclicModules).toBe(2);
    expect(result.hits.map((hit) => hit.file)).toEqual(['tests/hangs.test.ts']);
    expect(result.hits[0].mocked[0].module).toBe('src/x.ts');
  });

  it('A9: a broken selection FAILS instead of reporting a clean bill of health', () => {
    // 0 files scanned — the case that once printed "PREDICTED HANGS (0)" and was believed.
    const empty = predictor.predict([], [], { root: ROOT });
    expect(empty.scanned).toBe(0);
    expect(empty.hits).toEqual([]);
    const none = spawnSync(process.execPath, [SCRIPT, '--config', 'vite.config.ts', '--files', ''], { cwd: ROOT, encoding: 'utf8' });
    expect(none.status, none.stdout + none.stderr).toBe(2);
    expect(none.stderr).toContain('--files was given but contains no file');
    // a selected file that cannot be read (a `[chromium] ` prefix left in, a stale path)
    const broken = predictor.predict([path.join(ROOT, 'tests', 'does-not-exist.test.ts')], [], { root: ROOT });
    expect(broken.unreadable).toEqual(['tests/does-not-exist.test.ts']);
    const run = spawnSync(process.execPath, [SCRIPT, '--config', 'vite.config.ts', '--files', 'tests/does-not-exist.test.ts'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(run.stderr).toContain('could not be read — the selection is broken');
  });

  it('every output states how many files and modules were scanned', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--config', 'vite.config.ts', '--files', 'tests/editor-save-shortcut.test.ts'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.stdout).toMatch(/scanned 1 test files, \d+ modules, \d+ aliases, \d+ modules on a cycle/);
    expect(run.stdout).toMatch(/out of 1 scanned test files/);
    expect(run.status, 'no hit on today’s tree → exit 0; a hit would be exit 1').toBe(0);
  });

  it('recall: with a cycle through the mocked module, all FIVE known hangers are named', async () => {
    // The rule's recall, measured on a tree that no longer has the cycle. plan-900 phase 4
    // removed the edge that killed these five, so today they run green and the predictor rightly
    // names nobody. To measure recall anyway the cycle is bent back IN MEMORY (`extraEdges`),
    // never in a repo file: for each file the module it mocks gets an edge from one of its own
    // imports back to it, which is exactly the condition the rule describes.
    const five = [
      'tests/library-snap-index.test.ts', 'tests/editor-save-shortcut.test.ts',
      'tests/editor-save-authored-names.test.ts', 'tests/in-place-test-session.test.ts',
      'tests/load-model-race.test.ts',
    ].map((file) => path.join(ROOT, file));
    const aliases = await predictor.loadAliases(path.join(ROOT, 'vite.config.ts'));
    const clean = predictor.predict(five, aliases, { root: ROOT });
    expect(clean.scanned).toBe(5);
    expect(clean.hits, 'after plan-900 phase 4 none of the five is on a cycle any more').toEqual([]);
    // close a cycle through each mocked module, using a module that module itself imports
    const { edges } = predictor.buildGraph(five, aliases, { root: ROOT });
    const mocked = new Set<string>();
    const perFile = new Map<string, number>();
    for (const file of five) {
      for (const specifier of predictor.originalMocks(fs.readFileSync(file, 'utf8'))) {
        const resolved = predictor.resolveModule(specifier, file, aliases, { root: ROOT });
        if (resolved) { mocked.add(resolved); perFile.set(file, (perFile.get(file) ?? 0) + 1); }
      }
    }
    // four distinct modules, because two pairs of files mock the same one
    expect([...perFile.values()].length, 'every one of the five mocks a module with the original').toBe(5);
    expect(mocked.size).toBe(4);
    const extraEdges: [string, string][] = [];
    for (const module of mocked) {
      const target = (edges.get(module) ?? []).find((imported) => imported !== module);
      expect(target, `${module} must import something to close a cycle with`).toBeTruthy();
      extraEdges.push([target!, module]);
    }
    const bent = predictor.predict(five, aliases, { root: ROOT, extraEdges });
    const expected = five.map((file) => path.relative(ROOT, file).split(path.sep).join('/')).sort();
    expect(bent.hits.map((hit) => hit.file).sort()).toEqual(expected);
  });

  it('F2: --json writes nothing but the report, even with the config that prints a banner', () => {
    // Measured: `vite.config.ts` logs `[rv-build] Private build …` at load time, on STDOUT, in
    // front of the JSON — `JSON.parse` died with `Unexpected token 'r'` although the header of the
    // script documents `--json` as machine-readable.
    const run = spawnSync(process.execPath, [SCRIPT, '--config', 'vite.config.ts', '--files', 'tests/editor-save-shortcut.test.ts', '--json'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const report = JSON.parse(run.stdout) as { scanned: number; suites: { aliases: number }[] };
    expect(report.scanned).toBe(1);
    expect(report.suites[0].aliases).toBeGreaterThan(0);
    // the banner is not swallowed, it is just out of the data channel
    expect(run.stderr).toContain('[rv-build]');
  });

  it('A9/F3: aliases that did not load are a BROKEN SCAN (exit 2), not a clean bill of health', () => {
    // The failure the header always promised to catch and nothing checked: with `resolve.alias`
    // empty, every `@rv/…` import is taken for a package, the graph collapses to the test files
    // themselves, and the output reads "0 modules on a cycle, 0 hits", exit 0.
    expect(predictor.unknownSpecifier('@rv/core/rv-viewer', { root: ROOT })).toBe(true);
    expect(predictor.unknownSpecifier('vitest', { root: ROOT })).toBe(false); // a real package
    expect(predictor.unknownSpecifier('./neighbour', { root: ROOT })).toBe(false); // a path, not an alias
    expect(predictor.unknownSpecifier('node:fs', { root: ROOT })).toBe(false);
    const file = path.join(ROOT, 'tests', 'behavior-extras-dispatch.test.ts');
    const withoutAliases = predictor.predict([file], [], { root: ROOT });
    expect(withoutAliases.unresolved.some((spec) => spec.startsWith('@rv/')), JSON.stringify(withoutAliases.unresolved)).toBe(true);
    // the CLI refuses it — a config that loads no aliases over files that need them
    const configFile = path.join(scratch({ 'noalias.config.mjs': 'export default {};\n' }), 'noalias.config.mjs');
    const run = spawnSync(process.execPath, [SCRIPT, '--config', configFile, '--files', 'tests/behavior-extras-dispatch.test.ts'], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(run.stderr).toContain('0 aliases loaded');
    expect(run.stderr).toContain('this is NOT a clean bill of health');
    // NEGATIVE CONTROL: the real config loads its aliases, nothing is left unresolved, exit 0.
    const ok = spawnSync(process.execPath, [SCRIPT, '--config', 'vite.config.ts', '--files', 'tests/behavior-extras-dispatch.test.ts'], { cwd: ROOT, encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stderr).not.toContain('0 aliases loaded');
  });

  it('the suite parameter names real configs and refuses an unknown one', () => {
    expect(Object.keys(predictor.SUITES).sort()).toEqual(['browser', 'node']);
    for (const config of Object.values(predictor.SUITES)) expect(fs.existsSync(path.join(ROOT, config))).toBe(true);
    expect(() => predictor.parseArgv(['--suite', 'nonsense'])).toThrow(/unknown suite/);
    expect(predictor.parseArgv(['--suite', 'all']).suite).toBe('all');
    expect(predictor.parseArgv([]).suite).toBe('node');
  });
});
