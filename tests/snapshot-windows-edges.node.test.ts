// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The two filesystem cases that decide delete-then-copy vs. file sync
 * (plan-738 §2.4, NFA "Windows-Robustheit", risk 5.9).
 *
 * A per-file update loop passes both of these on Linux and fails both on
 * Windows, which is where the deliveries run. `Foo.md` → `foo.md` is not a
 * change to a per-file updater at all (NTFS finds the file under either name),
 * and a file that became a folder cannot be written over. Deleting the whole
 * territory first makes both disappear as special cases.
 *
 * ## Why `readdirSync` and not `git status`
 *
 * On NTFS with the default `core.ignorecase=true`, Git reports a clean tree for
 * a case-only rename it never performed — so a `git status` assertion here would
 * be vacuously green and would keep being green after a regression. The real
 * directory entry is the only witness, so that is what is read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { applySnapshot } from '../scripts/_workspace-lib.mjs';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-snapshot-edges-'));
  temporary.push(root);
  return root;
}

function stage(root: string, name: string, files: Record<string, string>, version: string): string {
  const staged = join(root, name);
  write(join(staged, 'delivery-manifest.json'),
    JSON.stringify({ manifestVersion: 3, baselineTag: 'delivery/' + version, projects: {} }, null, 2));
  for (const [path, text] of Object.entries(files)) write(join(staged, path), text);
  return staged;
}

//! The names actually present in a directory, as the filesystem spells them.
function entryNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('snapshot edges that only delete-then-copy survives', { timeout: 60000 }, () => {
  // ── T6, core ──────────────────────────────────────────────────────────
  it('T6: a case-only rename in the core lands with the NEW casing', () => {
    const root = sandbox();
    const v1 = stage(root, 'v1', {
      'realvirtual-web/main.ts': 'export const v = 1;\n',
      'docs/Readme.md': 'v1\n',
    }, '1.0.0');
    const clone = join(root, 'clone');
    mkdirSync(clone, { recursive: true });
    git(clone, 'init', '-b', 'main');
    applySnapshot(v1, clone, { version: '1.0.0', log: () => {} });
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'delivery 1');
    git(clone, 'tag', 'delivery/1.0.0');
    expect(entryNames(join(clone, 'docs'))).toEqual(['Readme.md']);

    const v2 = stage(root, 'v2', {
      'realvirtual-web/main.ts': 'export const v = 2;\n',
      'docs/readme.md': 'v2\n',
    }, '2.0.0');
    applySnapshot(v2, clone, { version: '2.0.0', log: () => {} });

    // The filesystem entry, not Git's opinion of it.
    expect(entryNames(join(clone, 'docs'))).toEqual(['readme.md']);
    expect(readFileSync(join(clone, 'docs', 'readme.md'), 'utf8')).toBe('v2\n');
  });

  it('T6: a file that becomes a folder, and a folder that becomes a file', () => {
    const root = sandbox();
    const v1 = stage(root, 'v1', {
      'realvirtual-web/main.ts': 'export const v = 1;\n',
      // Becomes a directory in v2.
      'connect/config': 'a plain file\n',
      // Becomes a plain file in v2.
      'library/catalog/index.json': '{"v":1}\n',
    }, '1.0.0');
    const clone = join(root, 'clone');
    mkdirSync(clone, { recursive: true });
    git(clone, 'init', '-b', 'main');
    applySnapshot(v1, clone, { version: '1.0.0', log: () => {} });
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'delivery 1');
    git(clone, 'tag', 'delivery/1.0.0');
    expect(statSync(join(clone, 'connect', 'config')).isFile()).toBe(true);
    expect(statSync(join(clone, 'library', 'catalog')).isDirectory()).toBe(true);

    const v2 = stage(root, 'v2', {
      'realvirtual-web/main.ts': 'export const v = 2;\n',
      'connect/config/project.json': '{"poll":100}\n',
      'library/catalog': 'now a plain file\n',
    }, '2.0.0');
    applySnapshot(v2, clone, { version: '2.0.0', log: () => {} });

    expect(statSync(join(clone, 'connect', 'config')).isDirectory()).toBe(true);
    expect(readFileSync(join(clone, 'connect/config/project.json'), 'utf8')).toBe('{"poll":100}\n');
    expect(statSync(join(clone, 'library', 'catalog')).isFile()).toBe(true);
    expect(readFileSync(join(clone, 'library', 'catalog'), 'utf8')).toBe('now a plain file\n');
  });

  // ── T6, inside a --projects replace ───────────────────────────────────
  it('T6: the same two edges inside a --projects folder replace', () => {
    const root = sandbox();
    const v1 = stage(root, 'v1', {
      'realvirtual-web/main.ts': 'export const v = 1;\n',
      'projects/acme/Docs/Manual.md': 'v1\n',
      'projects/acme/models/machine': 'a plain file\n',
    }, '1.0.0');
    const clone = join(root, 'clone');
    mkdirSync(clone, { recursive: true });
    git(clone, 'init', '-b', 'main');
    applySnapshot(v1, clone, { version: '1.0.0', log: () => {} });
    git(clone, 'add', '-A');
    git(clone, 'commit', '-m', 'delivery 1');
    git(clone, 'tag', 'delivery/1.0.0');

    const v2 = stage(root, 'v2', {
      'realvirtual-web/main.ts': 'export const v = 2;\n',
      'projects/acme/docs/manual.md': 'v2\n',
      'projects/acme/models/machine/part.glb': 'now a folder',
    }, '2.0.0');
    applySnapshot(v2, clone, { version: '2.0.0', replaceProjects: ['acme'], log: () => {} });

    expect(entryNames(join(clone, 'projects', 'acme'))).toEqual(['docs', 'models']);
    expect(entryNames(join(clone, 'projects', 'acme', 'docs'))).toEqual(['manual.md']);
    expect(statSync(join(clone, 'projects/acme/models/machine')).isDirectory()).toBe(true);
    expect(existsSync(join(clone, 'projects/acme/models/machine/part.glb'))).toBe(true);
  });
});
