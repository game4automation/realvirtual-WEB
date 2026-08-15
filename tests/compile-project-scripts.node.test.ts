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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scriptRefsOf,
  outputRefOf,
  isStale,
  compileProjectDir,
  projectDirsUnder,
} from '../scripts/compile-project-scripts.mjs';

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
