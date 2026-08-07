// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pull-customer-project — the return path (plan-700 Phase 5, B3/B17/F15).
 *
 * The first test file this script has ever had. It is the only place where
 * material we do not control is written into OUR repository, and it used to do
 * that with no diff, no backup and no guard.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertIncomingTreeIsSafe, diffTrees, pullCustomerProject,
} from '../scripts/pull-customer-project.mjs';

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

const MANIFEST = JSON.stringify({
  schemaVersion: 1, id: 'prj_pull', name: 'Acme', canonicalName: 'acme',
  vendor: { managed: ['models/**'], handover: [] },
}, null, 2) + '\n';

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-pull-test-'));
  temporary.push(root);
  return root;
}

//! A customer repository carrying projects/acme, reachable as a file:// remote.
function customerRemote(root: string, files: Record<string, string>): string {
  const repo = join(root, 'customer');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  for (const [path, text] of Object.entries(files)) write(join(repo, path), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'customer state');
  return pathToFileURL(repo).href;
}

const CUSTOMER_FILES: Record<string, string> = {
  'projects/acme/project.json': MANIFEST,
  'projects/acme/scenes/mine.scene.json': '{"scene":"mine"}\n',
  'projects/acme/models/machine.glb': 'model-from-customer',
};

function internalProject(root: string): string {
  const target = join(root, 'internal', 'projects', 'acme');
  write(join(target, 'project.json'), MANIFEST);
  write(join(target, 'scenes', 'internal-only.scene.json'), '{"scene":"internal"}\n');
  write(join(target, 'models', 'machine.glb'), 'model-internal');
  return target;
}

describe('pull-customer-project', () => {
  it('writes nothing without --apply, but still shows the full diff', async () => {
    const root = sandbox();
    const remote = customerRemote(root, CUSTOMER_FILES);
    const target = internalProject(root);
    const before = readFileSync(join(target, 'models', 'machine.glb'), 'utf8');

    const result = await pullCustomerProject({ projectKey: 'acme', remote, apply: false, internalRoot: target });

    expect(result.applied).toBe(false);
    expect(readFileSync(join(target, 'models', 'machine.glb'), 'utf8')).toBe(before);
    expect(existsSync(join(target, 'scenes', 'internal-only.scene.json'))).toBe(true);
    expect(result.diff.changed).toContain('models/machine.glb');
    expect(result.diff.added).toContain('scenes/mine.scene.json');
    // The removals are the half nobody saw before: applying would delete this here.
    expect(result.diff.removed).toContain('scenes/internal-only.scene.json');
  }, 30000);

  it('backs the internal state up before overwriting it', async () => {
    const root = sandbox();
    const remote = customerRemote(root, CUSTOMER_FILES);
    const target = internalProject(root);

    const result = await pullCustomerProject({ projectKey: 'acme', remote, apply: true, internalRoot: target });

    expect(result.applied).toBe(true);
    expect(readFileSync(join(target, 'models', 'machine.glb'), 'utf8')).toBe('model-from-customer');
    // Nothing is unrecoverable: the file the pull deleted is still in the backup.
    expect(existsSync(join(target, 'scenes', 'internal-only.scene.json'))).toBe(false);
    expect(readFileSync(join(result.backup as string, 'scenes', 'internal-only.scene.json'), 'utf8'))
      .toBe('{"scene":"internal"}\n');
    expect(readFileSync(join(result.backup as string, 'models', 'machine.glb'), 'utf8')).toBe('model-internal');
  }, 30000);

  it('refuses an incoming tree carrying a secret, before anything is written', async () => {
    const root = sandbox();
    const remote = customerRemote(root, {
      ...CUSTOMER_FILES,
      'projects/acme/connect/secrets.local.json': '{"apiKey":"whatever"}\n',
    });
    const target = internalProject(root);

    await expect(pullCustomerProject({ projectKey: 'acme', remote, apply: true, internalRoot: target }))
      .rejects.toThrow(/secret-bearing file must not be pulled back/);
    // Refused BEFORE the write, so the internal state is exactly as it was.
    expect(readFileSync(join(target, 'models', 'machine.glb'), 'utf8')).toBe('model-internal');
    expect(existsSync(join(target, 'scenes', 'internal-only.scene.json'))).toBe(true);
  }, 30000);

  it('refuses an incoming tree whose manifest is no longer a valid project', async () => {
    const root = sandbox();
    const remote = customerRemote(root, { ...CUSTOMER_FILES, 'projects/acme/project.json': '{ broken' });
    const target = internalProject(root);

    await expect(pullCustomerProject({ projectKey: 'acme', remote, apply: true, internalRoot: target }))
      .rejects.toThrow();
    expect(readFileSync(join(target, 'models', 'machine.glb'), 'utf8')).toBe('model-internal');
  }, 30000);

  it('refuses a nested .git in the incoming tree', () => {
    const root = sandbox();
    const incoming = join(root, 'incoming');
    write(join(incoming, 'project.json'), MANIFEST);
    write(join(incoming, 'plugins', '.git', 'config'), '[core]\n');
    expect(() => assertIncomingTreeIsSafe(incoming, 'incoming')).toThrow(/nested \.git/);
  });

  it('compares content, not timestamps', () => {
    const root = sandbox();
    const a = join(root, 'a');
    const b = join(root, 'b');
    write(join(a, 'file.txt'), 'same');
    write(join(b, 'file.txt'), 'same');
    // A Git checkout rewrites every mtime; only the bytes mean anything here.
    expect(diffTrees(a, b)).toEqual({ added: [], changed: [], removed: [] });
    write(join(b, 'file.txt'), 'different');
    expect(diffTrees(a, b).changed).toEqual(['file.txt']);
  });
});
