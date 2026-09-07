// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// plan-739 Phase 5 / T19.
//
// `snapshotPush` used to return before it even cloned whenever `push` was false, so
// `previewProjectReplace` only ever ran on the push path: a dry run with `--projects` printed
// nothing at all about the folders it was about to overwrite. The first time an operator could
// see the diff was the run that applied it — against a repository that had been out of sync for
// several releases. This file asserts BOTH halves of the fix: the preview really appears, and
// the remote really is untouched.
//
// It needs no private checkout: `generate-customer-workspace.mjs` reaches the private repo only
// through a dynamic import inside `writeDependencyPin`, which `snapshotPush` never calls.

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

const identity: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();

type SnapshotPushOptions = {
  workspaceRoot: string; remote: string; version: string;
  plasticChangeset?: number | null; push?: boolean; coreRoot?: string | null;
  replaceProjects?: string[]; force?: boolean; acceptNewPrivateFiles?: boolean;
};
type SnapshotPushResult = {
  pushed: boolean; remote: string; message: string; snapshot: unknown;
  preview?: { total: number; projects: { name: string; affected: number }[] } | null;
};

// generate-customer-workspace.mjs has no .d.mts; a non-literal specifier keeps tsc out of it.
async function loadGenerator() {
  return (await import(
    new URL('../scripts/generate-customer-workspace.mjs', import.meta.url).href
  )) as { snapshotPush: (options: SnapshotPushOptions) => SnapshotPushResult };
}

//! A customer remote that already carries a delivery, plus a staging tree that differs from it
//! in exactly one project file. `firstDelivery` is tied to an EMPTY remote, so the single
//! commit here is what makes `--projects` a real replace rather than a seeding no-op.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rv-projects-preview-'));
  temporary.push(root);
  const work = join(root, 'work');
  write(join(work, 'realvirtual-web', 'src', 'main.ts'), 'export {};');
  write(join(work, 'projects', 'acme', 'project.json'), '{"name":"ACME"}');
  write(join(work, 'projects', 'acme', 'models', 'machine.glb'), 'the-customers-own-edited-model');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'customer state');
  const bare = join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  git(work, 'remote', 'add', 'origin', pathToFileURL(bare).href);
  git(work, 'push', '-q', 'origin', 'main');

  const staged = join(root, 'staged');
  write(join(staged, 'realvirtual-web', 'src', 'main.ts'), 'export {};');
  write(join(staged, 'projects', 'acme', 'project.json'), '{"name":"ACME"}');
  write(join(staged, 'projects', 'acme', 'models', 'machine.glb'), 'the-vendor-model-of-this-delivery');
  return { root, bare, staged, remote: pathToFileURL(bare).href };
}

//! Everything about the remote that a push would change: the branch tip and every tag.
function remoteState(bare: string) {
  return {
    head: git(bare, 'rev-parse', 'main'),
    tags: git(bare, 'tag', '-l'),
    model: execFileSync('git', ['-C', bare, 'cat-file', 'blob', 'main:projects/acme/models/machine.glb'],
      { encoding: 'utf8' }),
  };
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('--projects preview in a dry run (plan-739 F15)', () => {
  it('T19 prints the diff list and leaves the remote untouched', async () => {
    const { bare, staged, remote } = fixture();
    const { snapshotPush } = await loadGenerator();
    const before = remoteState(bare);

    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    let result: SnapshotPushResult;
    try {
      result = snapshotPush({
        workspaceRoot: staged, remote, version: '9.9.9', push: false, replaceProjects: ['acme'],
      });
    } finally {
      log.mockRestore();
    }
    const output = lines.join('\n');

    // Half one: the operator actually sees what the run would destroy.
    expect(output).toContain('[projects] acme:');
    expect(output).toMatch(/ersetzt oder geloescht/);
    expect(output).toContain('models/machine.glb');
    expect(output).toContain('[dry-run]');
    expect(result.preview?.total).toBeGreaterThan(0);

    // Half two: nothing was written. Not the branch, not a tag, not the file itself.
    expect(result.pushed).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(remoteState(bare)).toEqual(before);
    expect(before.model).toBe('the-customers-own-edited-model');
  });

  it('does not clone at all when a dry run names no projects', async () => {
    const { staged } = fixture();
    const { snapshotPush } = await loadGenerator();
    // An unreachable remote is the proof: a run that cloned would fail here. Without
    // `--projects` there is nothing to preview, so the clone would be pure cost.
    const result = snapshotPush({
      workspaceRoot: staged, remote: 'file:///rv-does-not-exist-739.git', version: '9.9.9', push: false,
    });
    expect(result.pushed).toBe(false);
    expect(result.preview ?? null).toBeNull();
  });

  it('says so instead of previewing when the customer remote is still empty', async () => {
    const { root, staged } = fixture();
    const empty = join(root, 'empty.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', empty]);
    const { snapshotPush } = await loadGenerator();
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const result = snapshotPush({
        workspaceRoot: staged, remote: pathToFileURL(empty).href, version: '9.9.9',
        push: false, replaceProjects: ['acme'],
      });
      expect(result.pushed).toBe(false);
      expect(result.preview).toBeNull();
    } finally {
      log.mockRestore();
    }
    // A first delivery seeds every folder anyway, so there is nothing to destroy and the
    // dry run must not imply there is.
    expect(lines.join('\n')).toContain('first delivery');
  });

  it('keeps reading the clone before applySnapshot deletes anything', () => {
    // The order in §2.5 is the safety property, and it is now shared by both paths: the
    // preview is computed once, above the dry-run return, and reused by the push path.
    const source = readFileSync(
      new URL('../scripts/generate-customer-workspace.mjs', import.meta.url), 'utf8');
    const previewAt = source.indexOf('previewProjectReplace(workspaceRoot, clone, replace)');
    const dryRunReturnAt = source.indexOf('return { pushed: false, remote, message, snapshot: null, preview };');
    const applyAt = source.indexOf('applySnapshot(workspaceRoot, clone');
    expect(previewAt).toBeGreaterThan(0);
    expect(dryRunReturnAt).toBeGreaterThan(previewAt);
    expect(applyAt).toBeGreaterThan(dryRunReturnAt);
  });
});
