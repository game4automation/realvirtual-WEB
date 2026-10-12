// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.9 — the offline half of the runtime mode (plan-718 stage 2b.2).
 *
 * The browser cannot compile (no `esbuild-wasm`, and Monaco's TS worker is
 * configured globally for the QuickJS editor — see the script's header), so the
 * `.js` sibling is produced here, on the dev/delivery path. What this file
 * checks is that the artefact it produces is the artefact the runtime loader
 * expects: a self-contained ES module at the sibling path, built from the
 * manifest's references and nothing else.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  scriptRefsOf,
  outputRefOf,
  isStale,
  compileProjectDir,
  projectDirsUnder,
} from '../scripts/compile-project-scripts.mjs';
import { compileStagedProjectScripts } from '../scripts/generate-customer-workspace.mjs';

const SCRIPTS = resolve(fileURLToPath(import.meta.url), '../../scripts');

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-compile-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeProject(documents: unknown[]): void {
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ schemaVersion: 'rv-project/1.0', documents }));
}

function writeFile(rel: string, content: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

// ─── Reference discovery ────────────────────────────────────────────────

describe('scriptRefsOf', () => {
  it('collapses the N:1 case onto one compilation', () => {
    const refs = scriptRefsOf({
      documents: [
        { id: 'a', scriptRef: 'scripts/linie1/index.ts' },
        { id: 'b', scriptRef: './scripts/linie1/index.ts' },
        { id: 'c', scriptRef: 'scripts/other.ts' },
        { id: 'd' },
      ],
    });
    expect(refs).toEqual(['scripts/linie1/index.ts', 'scripts/other.ts']);
  });

  it('drops a reference that would leave the project', () => {
    expect(scriptRefsOf({
      documents: [
        { scriptRef: '../out.ts' },
        { scriptRef: '/etc/x.ts' },
        { scriptRef: 'C:/x.ts' },
        { scriptRef: '   ' },
      ],
    })).toEqual([]);
  });
});

describe('outputRefOf', () => {
  it('names the sibling exactly as the runtime loader looks for it', () => {
    expect(outputRefOf('scripts/a.ts')).toBe('scripts/a.js');
    expect(outputRefOf('scripts/a.tsx')).toBe('scripts/a.js');
    expect(outputRefOf('scripts/a.js')).toBe('scripts/a.js');
    expect(outputRefOf('connect/a.json')).toBeNull();
  });
});

// ─── Compilation ────────────────────────────────────────────────────────

describe('compileProjectDir', () => {
  it('emits a self-contained ES module beside the source', async () => {
    writeProject([{ id: 'a', path: 'models/x.glb', scriptRef: 'scripts/index.ts' }]);
    writeFile('scripts/util.ts', 'export const marker = "from-util";\n');
    writeFile(
      'scripts/index.ts',
      'import { marker } from "./util";\n'
      + 'export function registerModelPlugins(): void { console.log(marker); }\n'
      + 'export function unregisterModelPlugins(): void {}\n',
    );

    const result = await compileProjectDir(dir);
    expect(result.status).toBe('ok');
    expect(result.results[0].status).toBe('built');

    const out = readFileSync(join(dir, 'scripts/index.js'), 'utf8');
    // Bundled: the relative import is gone, its content is in. That is what a
    // Blob-URL import needs — it has no directory to resolve against.
    expect(out).not.toMatch(/from\s+["']\.\/util["']/);
    expect(out).toContain('from-util');
    expect(out).toContain('export');
  });

  it('leaves bare package imports external — the viewer owns those copies', async () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.ts' }]);
    writeFile(
      'scripts/index.ts',
      'import * as THREE from "three";\n'
      + 'export function registerModelPlugins(): void { void THREE; }\n'
      + 'export function unregisterModelPlugins(): void {}\n',
    );
    const result = await compileProjectDir(dir);
    expect(result.status).toBe('ok');
    expect(readFileSync(join(dir, 'scripts/index.js'), 'utf8')).toContain('"three"');
  });

  it('leaves the viewer aliases @rv/* and @rv-private/* external — a plugin that uses the core compiles', async () => {
    // Regression: the mauser3dhmi delivery stopped with 32 "Could not resolve @rv/…" errors.
    writeProject([{ id: 'a', scriptRef: 'plugins/index.ts' }]);
    writeFile(
      'plugins/index.ts',
      'import { RVWebError } from "@rv/core/engine/rv-web-error";\n'
      + 'import { WebXRPlugin } from "@rv/plugins/webxr-plugin";\n'
      + 'import { Extra } from "@rv-private/plugins/extra";\n'
      + 'export function registerModelPlugins(): void { void RVWebError; void WebXRPlugin; void Extra; }\n'
      + 'export function unregisterModelPlugins(): void {}\n',
    );
    const result = await compileProjectDir(dir);
    expect(result.results.map((r) => r.status)).toEqual(['built']);
    const js = readFileSync(join(dir, 'plugins/index.js'), 'utf8');
    expect(js).toContain('"@rv/core/engine/rv-web-error"');
    expect(js).toContain('"@rv/plugins/webxr-plugin"');
    expect(js).toContain('"@rv-private/plugins/extra"');
  });

  it('reports a dead reference instead of writing an empty artefact', async () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/missing.ts' }]);
    const result = await compileProjectDir(dir);
    expect(result.status).toBe('failed');
    expect(result.results[0]).toMatchObject({ status: 'failed', reason: 'source does not exist' });
    expect(existsSync(join(dir, 'scripts/missing.js'))).toBe(false);
  });

  it('accepts a project that ships only compiled code', async () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.js' }]);
    writeFile('scripts/index.js', 'export function registerModelPlugins(){}\n');
    const result = await compileProjectDir(dir);
    expect(result.status).toBe('ok');
    expect(result.results[0].status).toBe('prebuilt');
  });

  it('is idempotent — a second run rebuilds nothing', async () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.ts' }]);
    writeFile('scripts/index.ts', 'export const x = 1;\n');
    expect((await compileProjectDir(dir)).results[0].status).toBe('built');
    expect((await compileProjectDir(dir)).results[0].status).toBe('current');
  });

  it('--check reports staleness and writes nothing', async () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.ts' }]);
    writeFile('scripts/index.ts', 'export const x = 1;\n');
    const result = await compileProjectDir(dir, { check: true });
    expect(result.status).toBe('stale');
    expect(existsSync(join(dir, 'scripts/index.js'))).toBe(false);
  });

  it('rebuilds when the source is newer than the artefact', async () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.ts' }]);
    writeFile('scripts/index.ts', 'export const x = 1;\n');
    await compileProjectDir(dir);
    // A save: the source moves ahead of the artefact.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'scripts/index.ts'), future, future);
    expect(isStale(join(dir, 'scripts/index.ts'), join(dir, 'scripts/index.js'))).toBe(true);
    expect((await compileProjectDir(dir)).results[0].status).toBe('built');
  });

  it('skips a directory that is not a project', async () => {
    const result = await compileProjectDir(dir);
    expect(result.status).toBe('skipped');
  });
});

describe('projectDirsUnder', () => {
  it('finds only directories that carry a manifest', () => {
    mkdirSync(join(dir, 'p1'), { recursive: true });
    writeFileSync(join(dir, 'p1/project.json'), '{}');
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    expect(projectDirsUnder(dir).map(p => p.replace(/\\/g, '/').split('/').pop())).toEqual(['p1']);
  });

  it('answers empty for a root that does not exist', () => {
    expect(projectDirsUnder(join(dir, 'nope'))).toEqual([]);
  });
});

// ─── The CLI's own exit code ────────────────────────────────────────────

/**
 * plan-479 §9 / Finding T5 — the process, not the library return value.
 *
 * Everything above calls `compileProjectDir` and reads a `status` string. What
 * a CI job and a delivery gate actually observe is the EXIT CODE of the child
 * process, and nothing tested that: the `exitCode = 3` line and the
 * `process.exit(code)` at the bottom of the script could both have been deleted
 * without a single test noticing.
 *
 * 3 is the specific claim, not merely "non-zero": 1 is a compile failure and 2
 * a usage error, and a caller that wants to say "artefacts are stale, rebuild
 * them" from "the source is broken" needs the three apart.
 */
describe('the compile CLI as a process', () => {
  function run(...args: string[]) {
    return spawnSync(
      process.execPath,
      [join(SCRIPTS, 'compile-project-scripts.mjs'), ...args],
      { encoding: 'utf8' },
    );
  }

  it('exits 3 when --check finds a missing artefact', () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.ts' }]);
    writeFile('scripts/index.ts', 'export const x = 1;\n');
    const out = run(dir, '--check');
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('STALE');
    expect(existsSync(join(dir, 'scripts/index.js'))).toBe(false);
  });

  it('exits 0 once the artefact has been built', () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/index.ts' }]);
    writeFile('scripts/index.ts', 'export const x = 1;\n');
    expect(run(dir).status).toBe(0);
    expect(existsSync(join(dir, 'scripts/index.js'))).toBe(true);
    expect(run(dir, '--check').status).toBe(0);
  });

  it('exits 1 — not 3 — when the reference is dead', () => {
    writeProject([{ id: 'a', scriptRef: 'scripts/missing.ts' }]);
    const out = run(dir, '--check');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('FAIL');
  });
});

// ─── The delivery step (plan-479 Phase 7) ───────────────────────────────

/**
 * The generator builds the siblings IN THE STAGED COPY, and the source tree
 * stays clean.
 *
 * Both halves are the phase. Building in the source tree would look identical
 * from the customer's side and would still be wrong: `deliver.mjs` asserts a
 * clean private tree and never auto-commits, so the dirt would surface as a
 * failure of the NEXT delivery. `git status --porcelain` on the source repo is
 * therefore not decoration here — it is the assertion the phase exists for.
 */
describe('compileStagedProjectScripts', () => {
  let source: string;
  let staged: string;

  function git(cwd: string, ...args: string[]) {
    return spawnSync('git', args, { cwd, encoding: 'utf8' });
  }

  /** A one-project "private repo" plus the staged copy a delivery makes of it. */
  function seed(script: string) {
    mkdirSync(join(source, 'projects/demo/plugins'), { recursive: true });
    writeFileSync(
      join(source, 'projects/demo/project.json'),
      JSON.stringify({
        schemaVersion: 'rv-project/1.0',
        documents: [{ id: 'a', path: 'models/x.glb', scriptRef: 'plugins/panel.tsx' }],
      }),
    );
    writeFileSync(join(source, 'projects/demo/plugins/panel.tsx'), script);
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'test');
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'seed');
    cpSync(join(source, 'projects'), join(staged, 'projects'), { recursive: true });
  }

  beforeEach(() => {
    source = mkdtempSync(join(tmpdir(), 'rv-src-'));
    staged = mkdtempSync(join(tmpdir(), 'rv-staged-'));
  });
  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  });

  it('writes the .js into the staged copy and leaves the source tree clean', async () => {
    seed('export function registerModelPlugins(): void {}\n'
      + 'export function unregisterModelPlugins(): void {}\n');

    await compileStagedProjectScripts(staged, ['demo']);

    expect(existsSync(join(staged, 'projects/demo/plugins/panel.js'))).toBe(true);
    // The whole point: nothing was written next to the source.
    expect(existsSync(join(source, 'projects/demo/plugins/panel.js'))).toBe(false);
    expect(git(source, 'status', '--porcelain').stdout.trim()).toBe('');
  });

  it('stops the delivery when a script does not compile', async () => {
    seed('export function registerModelPlugins(): void { this is not typescript }\n');

    await expect(compileStagedProjectScripts(staged, ['demo']))
      .rejects.toThrow(/did not compile/);
    // And it stopped BEFORE producing a half-delivery.
    expect(existsSync(join(staged, 'projects/demo/plugins/panel.js'))).toBe(false);
    expect(git(source, 'status', '--porcelain').stdout.trim()).toBe('');
  });

  it('ignores a project key with no manifest instead of failing on it', async () => {
    seed('export function registerModelPlugins(): void {}\n');
    await expect(compileStagedProjectScripts(staged, ['demo', 'not-delivered']))
      .resolves.toBeUndefined();
  });
});
