// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Guards the publish guard: scripts/assert-public-safe.mjs is what stands
 * between internal ops tooling and the public GitHub remote, so a silent
 * regression here is expensive. Each case builds a throwaway git repo and runs
 * the real script against it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GUARD = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/assert-public-safe.mjs');
const temporary: string[] = [];

//! Assembled at runtime on purpose: written out as one literal, this file would
//! carry the very marker the guard scans for, so the guard would block its own
//! test - and with it every push to the public remote.
const INTERNAL_TOKEN_MARKER = ['FORGEJO', 'BOT', 'TOKEN'].join('_');

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

//! Creates a repo on branch `main` holding `files`, plus one harmless commit.
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rv-guard-test-'));
  temporary.push(root);
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

function runGuard(cwd: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [GUARD, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// Every case spawns a fixture repo (git init/config/add/commit) plus the guard
// itself, which runs one `git grep` per content marker — roughly a dozen
// processes per test. That is ~600ms idle, but the Node suite runs pooled
// alongside git-heavy tests (customer-workspace pushes an LFS tree), and under
// that load the default 5s timeout fires on a test that is perfectly healthy.
const PROCESS_HEAVY = 30000;

describe('publish guard', () => {
  it('passes a tree that holds only public tooling', () => {
    const root = repoWith({ 'scripts/bunny-deploy.mjs': 'export const zone = process.env.BUNNY_STORAGE_ZONE;\n' });
    const { status, output } = runGuard(root);
    expect(status).toBe(0);
    expect(output).toContain('is clean');
  }, PROCESS_HEAVY);

  it('blocks a denied path', () => {
    const root = repoWith({ 'scripts/onboard-customer.mjs': 'export const x = 1;\n' });
    const { status, output } = runGuard(root);
    expect(status).toBe(1);
    expect(output).toContain('scripts/onboard-customer.mjs');
  }, PROCESS_HEAVY);

  it('blocks an internal marker in a file that is not on the path list', () => {
    const root = repoWith({ 'scripts/something-new.mjs': `const token = process.env.${INTERNAL_TOKEN_MARKER};\n` });
    const { status, output } = runGuard(root);
    expect(status).toBe(1);
    expect(output).toContain('scripts/something-new.mjs');
  }, PROCESS_HEAVY);

  it('does not flag the hub hostname, which customers legitimately receive', () => {
    const root = repoWith({ 'scripts/_workspace-lib.mjs': 'const hub = "https://git.realvirtual.io/rv-acme";\n' });
    expect(runGuard(root).status).toBe(0);
  }, PROCESS_HEAVY);

  it('warns when a denied file survives only in the unpushed range', () => {
    const root = repoWith({ 'scripts/onboard-customer.mjs': 'export const x = 1;\n' });
    git(root, ['branch', 'published', 'HEAD']);
    // The publish base is the first commit; the file is removed after it, so the
    // tip is clean while the range still carries the blob.
    git(root, ['rm', '-q', 'scripts/onboard-customer.mjs']);
    git(root, ['commit', '-m', 'move ops tooling out']);
    const { status, output } = runGuard(root, ['--base', 'published']);
    expect(status).toBe(0);
    expect(output).toContain('WARNING');
    expect(output).toContain('scripts/onboard-customer.mjs');
  }, PROCESS_HEAVY);
});
