// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-679 Phase 4 — the release check of one delivery target.
 *
 * Every test here is about one of two promises: the check finds EVERY blocker of a target in one
 * run, and it writes NOTHING anywhere — no push, no tag, no ref or object on the customer remote,
 * no dependency upload. The remote is a local bare repository whose refs and objects are compared
 * before and after.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertPrivateSourceInventory,
  assertWorkspaceGuards,
  gitProvenance,
  inventoryDigest,
  readRemoteBaselineInventory,
  selectBaselineTag,
} from '../scripts/_workspace-lib.mjs';

const SCRIPTS = resolve(__dirname, '../scripts');
// The generator has no .d.mts for the release-check exports; a non-literal specifier keeps tsc out.
type ReleaseCheckModule = {
  runReleaseCheck: (context: Record<string, unknown>, deps: Record<string, unknown>) => Promise<any>;
  resolveRagPair: (args: string[], projectKey: string | null, projectDir: string | null, deps?: Record<string, unknown>) => any;
  computeRagCacheKey: (input: Record<string, unknown>) => string;
  readApprovedPrivateFiles: (path: string, target: string) => string[];
  releaseTargetId: (delivery: Record<string, unknown>) => string;
};
const loadGenerator = () => import(pathToFileURL(join(SCRIPTS, 'generate-customer-workspace.mjs')).href) as Promise<ReleaseCheckModule>;

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-release-check-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.invalid'], dir);
  git(['config', 'user.name', 'rv test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

function manifestWith(paths: string[], baselineTag = 'delivery/6.4.0'): string {
  const sorted = [...paths].sort();
  return JSON.stringify({ manifestVersion: 3, baselineTag, privateSources: { count: sorted.length, sha256: inventoryDigest(sorted), paths: sorted } });
}

//! A bare "customer remote" with one delivery tagged `delivery/6.4.0` (or as configured).
function customerRemote(options: { paths?: string[]; tag?: string | null; manifest?: boolean; empty?: boolean } = {}): { bare: string; url: string } {
  const bare = join(work, 'remote.git');
  git(['init', '-q', '--bare', '-b', 'main', bare], work);
  if (!options.empty) {
    const seed = join(work, 'seed');
    initRepo(seed);
    writeFileSync(join(seed, 'README.md'), 'customer repo\n');
    if (options.manifest !== false) writeFileSync(join(seed, 'delivery-manifest.json'), manifestWith(options.paths ?? ['realvirtual-web-pro/src/a.ts']));
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'delivery'], seed);
    if (options.tag !== null) git(['tag', options.tag ?? 'delivery/6.4.0'], seed);
    git(['push', '-q', bare, 'HEAD:main', '--tags'], seed);
  }
  return { bare, url: pathToFileURL(bare).href };
}

//! Everything a write to the remote could change: every ref and every object file.
function remoteFingerprint(bare: string): string {
  const refs = git(['for-each-ref', '--format=%(refname) %(objectname)'], bare);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(`${path.slice(bare.length)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  walk(join(bare, 'objects'));
  walk(join(bare, 'refs'));
  return [refs, ...files.sort()].join('\n');
}

describe('readRemoteBaselineInventory — bare, blob-filtered, read-only', () => {
  it('reads the baseline inventory and writes nothing to the remote', () => {
    const { bare, url } = customerRemote({ paths: ['realvirtual-web-pro/src/b.ts', 'realvirtual-web-pro/src/a.ts'] });
    const before = remoteFingerprint(bare);
    const result = readRemoteBaselineInventory(url, { tmpBase: work });
    expect(result).toMatchObject({ remoteEmpty: false, untagged: false, baselineTag: 'delivery/6.4.0', damage: null });
    expect(result.inventory).toMatchObject({ trusted: true, paths: ['realvirtual-web-pro/src/a.ts', 'realvirtual-web-pro/src/b.ts'] });
    expect(remoteFingerprint(bare)).toBe(before);
    // The temp clone is gone.
    expect(readdirSync(work).filter((name) => name.startsWith('rv-baseline-'))).toEqual([]);
  });

  it('a remote without a delivery tag is not gated (first delivery under the gate)', () => {
    const { url } = customerRemote({ tag: null });
    expect(readRemoteBaselineInventory(url, { tmpBase: work })).toMatchObject({ untagged: true, inventory: null, baselineTag: null });
  });

  it('an empty remote is a first delivery', () => {
    const { url } = customerRemote({ empty: true });
    expect(readRemoteBaselineInventory(url, { tmpBase: work })).toMatchObject({ remoteEmpty: true, inventory: null });
  });

  it('a tag without a manifest is damage', () => {
    const { url } = customerRemote({ manifest: false });
    const result = readRemoteBaselineInventory(url, { tmpBase: work });
    expect(result.damage).toMatch(/carries no delivery-manifest\.json/);
    expect(result.inventory).toMatchObject({ trusted: false, paths: [] });
  });

  it('times out with a message and removes its temp clone', () => {
    const { url } = customerRemote();
    expect(() => readRemoteBaselineInventory(url, { tmpBase: work, timeoutMs: 1 })).toThrow(/timed out/);
    expect(readdirSync(work).filter((name) => name.startsWith('rv-baseline-'))).toEqual([]);
  });

  it('an unreachable remote is a clear error', () => {
    expect(() => readRemoteBaselineInventory(pathToFileURL(join(work, 'nope.git')).href, { tmpBase: work })).toThrow(/Reading the delivery baseline/);
  });

  it('picks the baseline tag like the full-clone path does', () => {
    expect(selectBaselineTag(['delivery/6.5.0', 'delivery/6.4.0'], 'delivery/6.4.0')).toBe('delivery/6.4.0');
    expect(selectBaselineTag(['delivery/6.5.0', 'delivery/6.4.0'], 'delivery/9.9.9')).toBe('delivery/6.5.0');
    expect(selectBaselineTag([], null)).toBeNull();
  });
});

describe('approved list instead of the blanket flag (F4)', () => {
  const baseline = { paths: ['p/a.ts'], trusted: true, reason: null };
  const current = (paths: string[]) => ({ count: paths.length, sha256: inventoryDigest(paths), paths });

  it('a subset of the approved list passes; an approved file that no longer arrives is information', () => {
    const diff = assertPrivateSourceInventory(baseline, current(['p/a.ts', 'p/b.ts']), { approved: ['p/b.ts', 'p/c.ts'] });
    expect(diff.added).toEqual(['p/b.ts']);
    expect(diff.approvedUnused).toEqual(['p/c.ts']);
  });

  it('an extra file aborts and names exactly it', () => {
    let message = '';
    try {
      assertPrivateSourceInventory(baseline, current(['p/a.ts', 'p/b.ts', 'p/x.ts']), { approved: ['p/b.ts'] });
    } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/NOT on the approved list/);
    expect(message).toContain('+ p/x.ts');
    expect(message).not.toContain('+ p/b.ts');
  });

  it('reads the approval file per target; an unnamed target approved nothing', async () => {
    const { readApprovedPrivateFiles, releaseTargetId } = await loadGenerator();
    const file = join(work, 'approval.json');
    writeFileSync(file, JSON.stringify({ privateFiles: { mauser: ['p/b.ts'], 'rv-commercial/realvirtual-commercial': [] } }));
    expect(readApprovedPrivateFiles(file, 'mauser')).toEqual(['p/b.ts']);
    expect(readApprovedPrivateFiles(file, 'wmyb')).toEqual([]);
    expect(releaseTargetId({ customer: 'acme', sharedRepo: true })).toBe('rv-commercial/realvirtual-commercial');
    expect(releaseTargetId({ customer: 'mauser', sharedRepo: false })).toBe('mauser');
  });
});

describe('guards in collect mode (Gate R2 finding 5)', () => {
  it('collects every content finding and does not enter a forbidden directory', () => {
    const root = join(work, 'ws');
    mkdirSync(join(root, 'src', 'vendor', '.git'), { recursive: true });
    const secret = ['Zq8', 'Lm3Xv9', 'Rt2Wb7Nk4', 'Ps6Hd1Gf5Jc0Yu'].join('');
    // A secret INSIDE the nested .git must not produce a second finding.
    writeFileSync(join(root, 'src', 'vendor', '.git', 'leak.ts'), `export const k = "${secret}";\n`);
    writeFileSync(join(root, 'src', 'a.ts'), `export const k = "${secret}";\n`);
    writeFileSync(join(root, 'src', 'b.ts'), `export const j = "${secret}x";\n`);
    writeFileSync(join(root, '.env.local'), 'X=1\n');
    const collect: Array<{ guard: string; kind: string; message: string }> = [];
    assertWorkspaceGuards(root, { collect });
    const byGuard = collect.map((entry) => `${entry.guard}:${entry.kind}`).sort();
    expect(byGuard).toEqual(['nested-git:structure', 'secret-content:content', 'secret-content:content', 'secret-name:structure']);
    expect(collect.some((entry) => entry.message.includes('leak.ts'))).toBe(false);
    // The throwing mode is unchanged: the first finding stops it.
    expect(() => assertWorkspaceGuards(root)).toThrow();
  });
});

describe('the release check of one target — every finding in one run (F5)', () => {
  const delivery = { customer: 'mauser', sharedRepo: false, remote: 'file:///remote.git', projects: ['mauser3dhmi'] };
  const baseContext = (outFile: string, args: string[] = []) => ({
    args, delivery, projectKey: 'mauser3dhmi', outFile, releaseVersion: '6.6.0', viewerVersion: '6.5.0',
    coreHead: 'c'.repeat(40), privateHead: 'p'.repeat(40), connectPin: { channel: 'stable', version: '1.0.0', url: 'u', sha256: 's'.repeat(64) },
  });
  const inventory = (paths: string[]) => ({ count: paths.length, sha256: inventoryDigest(paths), paths });

  it('reports secret, missing preset, notices failure and a new file of the SAME target together', async () => {
    const { runReleaseCheck } = await loadGenerator();
    const outFile = join(work, 'mauser.json');
    const stagedWith: Array<string | null> = [];
    const result = await runReleaseCheck(baseContext(outFile, ['--diagnosis-unavailable', 'Diagnosis preset not found: x.diagnosis.json']), {
      resolveRag: () => { throw new Error('must not be called when the preset is missing'); },
      stage: ({ connectArtifacts }: { connectArtifacts: string | null }) => { stagedWith.push(connectArtifacts); return { workspaceRoot: work, projectKeys: ['mauser3dhmi'] }; },
      guards: (_staged: unknown, collect: unknown[]) => { collect.push({ guard: 'secret-content', kind: 'content', message: 'High-entropy string literal found in src/x.ts.' }); },
      readRemote: () => ({ baselineTag: 'delivery/6.5.0', inventory: { paths: ['p/a.ts'], trusted: true, reason: null }, damage: null }),
      collectInventory: () => inventory(['p/a.ts', 'p/new.ts']),
      build: () => { throw new Error('[rv-third-party-notices] 1 licence-policy violation(s): stale-exception x'); },
    });
    expect(result.ok).toBe(false);
    expect(result.diagnosis).toBe('failed');
    // Staged WITHOUT the package, but staged.
    expect(stagedWith).toEqual([null]);
    const summary = result.findings.map((f: { check: string; severity: string }) => `${f.severity}:${f.check}`).sort();
    expect(summary).toEqual(['approval:tier-diff', 'error:build', 'error:diagnosis', 'error:guard:secret-content']);
    expect(result.tierDiff.added).toEqual(['p/new.ts']);
    expect(result.checks).toMatchObject({ diagnosis: 'failed', staging: 'ok', guards: 'failed', build: 'failed', tierDiff: 'ok' });
    expect(JSON.parse(readFileSync(outFile, 'utf8'))).toMatchObject({ target: 'mauser', ok: false, releaseVersion: '6.6.0' });
  });

  it('only new files: ok stays true — an approval, not a failure', async () => {
    const { runReleaseCheck } = await loadGenerator();
    const result = await runReleaseCheck(baseContext(join(work, 'r.json'), ['--no-rag']), {
      stage: () => ({ workspaceRoot: work }), guards: () => {}, build: () => {},
      readRemote: () => ({ baselineTag: 'delivery/6.5.0', inventory: { paths: [], trusted: true, reason: null }, damage: null }),
      collectInventory: () => inventory(['p/new.ts']),
    });
    expect(result.ok).toBe(true);
    expect(result.diagnosis).toBe('none');
    expect(result.findings).toEqual([{ check: 'tier-diff', severity: 'approval', message: 'new private source file: p/new.ts' }]);
  });

  it('a failed staging marks the dependent checks not-run, never passed', async () => {
    const { runReleaseCheck } = await loadGenerator();
    const result = await runReleaseCheck(baseContext(join(work, 'r.json'), ['--no-rag']), {
      stage: () => { throw new Error('staging broke'); },
      guards: () => { throw new Error('must not run'); }, build: () => { throw new Error('must not run'); },
      readRemote: () => { throw new Error('must not run'); }, collectInventory: () => inventory([]),
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toMatchObject({ staging: 'failed', guards: 'not-run: staging failed', build: 'not-run: staging failed', tierDiff: 'not-run: staging failed' });
  });

  it('an unreadable remote baseline is fatal for the target', async () => {
    const { runReleaseCheck } = await loadGenerator();
    const result = await runReleaseCheck(baseContext(join(work, 'r.json'), ['--no-rag']), {
      stage: () => ({ workspaceRoot: work }), guards: () => {}, build: () => {},
      readRemote: () => { throw new Error('Reading the delivery baseline of x timed out after 180 s.'); },
      collectInventory: () => inventory([]),
    });
    expect(result.ok).toBe(false);
    expect(result.checks.tierDiff).toBe('failed');
  });

  it('the release-check path of the generator has no push, no tag and no dependency upload', () => {
    const source = readFileSync(join(SCRIPTS, 'generate-customer-workspace.mjs'), 'utf8');
    const start = source.indexOf('async function releaseCheckMain');
    const end = source.indexOf('async function main()');
    const body = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    for (const forbidden of ['snapshotPush', 'writeDependencyPin', "'push'", 'publishDependencies', 'recordPublishProvenance']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    const check = source.slice(source.indexOf('export async function runReleaseCheck'), start);
    for (const forbidden of ['snapshotPush', 'writeDependencyPin', 'execFileSync']) expect(check, forbidden).not.toContain(forbidden);
  });
});

describe('the diagnosis package cache (A4)', () => {
  const project = () => {
    const dir = join(work, 'project');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'a.pdf'), 'pdf');
    return dir;
  };
  const fakeBuild = (calls: string[]) => (output: string) => {
    calls.push(output);
    writeFileSync(join(output, 'rag.zip'), 'zip-bytes');
    writeFileSync(join(output, 'project-config.json'), '{"Diagnosis":{}}');
  };
  const args = (cache: string, extra: string[] = []) => ['--seed-index', 'seed', '--diagnosis-config', 'preset', '--rag-cache', cache, ...extra];

  it('builds once, then hits; a different key builds again; a manipulated entry is refused', async () => {
    const { resolveRagPair } = await loadGenerator();
    const cache = join(work, 'rag-cache');
    const calls: string[] = [];
    let key = 'a'.repeat(64);
    const deps = { build: fakeBuild(calls), computeKey: () => key };
    const first = resolveRagPair(args(cache), 'mauser3dhmi', project(), deps);
    expect(first.cache).toMatchObject({ key, hit: false });
    const second = resolveRagPair(args(cache), 'mauser3dhmi', project(), deps);
    expect(second.cache).toMatchObject({ key, hit: true, ragZipSha256: first.cache.ragZipSha256 });
    expect(calls).toHaveLength(1);
    key = 'b'.repeat(64);
    expect(resolveRagPair(args(cache), 'mauser3dhmi', project(), deps).cache.hit).toBe(false);
    expect(calls).toHaveLength(2);
    writeFileSync(join(cache, key, 'rag.zip'), 'tampered');
    expect(() => resolveRagPair(args(cache), 'mauser3dhmi', project(), deps)).toThrow(/no longer matches its recorded hashes/);
  });

  it('--rag-expect: same key and hashes reuse; a changed key or a missing entry needs a new dry-run', async () => {
    const { resolveRagPair } = await loadGenerator();
    const cache = join(work, 'rag-cache');
    const key = 'c'.repeat(64);
    const calls: string[] = [];
    const deps = { build: fakeBuild(calls), computeKey: () => key };
    const built = resolveRagPair(args(cache), 'mauser3dhmi', project(), deps).cache;
    const expect3 = `${key},${built.ragZipSha256},${built.projectConfigSha256}`;
    expect(resolveRagPair(args(cache, ['--rag-expect', expect3]), 'mauser3dhmi', project(), deps).cache.hit).toBe(true);
    expect(() => resolveRagPair(args(cache, ['--rag-expect', `${'d'.repeat(64)},${built.ragZipSha256},${built.projectConfigSha256}`]), 'mauser3dhmi', project(), deps))
      .toThrow(/new dry-run is needed/);
    expect(() => resolveRagPair(args(join(work, 'other-cache'), ['--rag-expect', expect3]), 'mauser3dhmi', project(), deps))
      .toThrow(/No cached diagnosis package/);
    expect(calls).toHaveLength(1);
  });

  it('the key covers project key, seed index, preset, corpus and indexer sources — not build output', async () => {
    const { computeRagCacheKey } = await loadGenerator();
    const tools = join(work, 'tools');
    mkdirSync(join(tools, 'build-rag-index', 'bin'), { recursive: true });
    writeFileSync(join(tools, 'bundle-rag.mjs'), 'bundler');
    writeFileSync(join(tools, 'build-rag-index', 'Program.cs'), 'indexer');
    writeFileSync(join(work, 'seed.json'), 'seed');
    writeFileSync(join(work, 'preset.json'), 'preset');
    const dir = project();
    const input = { projectKey: 'mauser3dhmi', projectDir: dir, seedIndex: join(work, 'seed.json'), diagnosisConfig: join(work, 'preset.json'), tools, env: {} };
    const base = computeRagCacheKey(input);
    expect(computeRagCacheKey(input)).toBe(base);
    expect(computeRagCacheKey({ ...input, projectKey: 'other' })).not.toBe(base);
    writeFileSync(join(tools, 'build-rag-index', 'bin', 'out.dll'), 'build output');
    expect(computeRagCacheKey(input)).toBe(base);
    writeFileSync(join(work, 'seed.json'), 'seed v2');
    const seeded = computeRagCacheKey(input);
    expect(seeded).not.toBe(base);
    writeFileSync(join(tools, 'build-rag-index', 'Program.cs'), 'indexer v2');
    expect(computeRagCacheKey(input)).not.toBe(seeded);
    expect(computeRagCacheKey({ ...input, env: { REQUESTY_API_KEY: 'k' } })).not.toBe(computeRagCacheKey(input));
  });
});

describe('the tag exemption (Gate R1 finding 1)', () => {
  it('an untagged clean HEAD passes the release check provenance and fails the push provenance', () => {
    const repo = join(work, 'core');
    initRepo(repo);
    writeFileSync(join(repo, 'package.json'), '{"version":"6.5.0"}\n');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'core'], repo);
    expect(gitProvenance(repo, { requireTag: false }).tags).toEqual([]);
    expect(() => gitProvenance(repo, { requireTag: true })).toThrow(/release tag/);
  });

  it('the generator refuses --release-check together with --push (real child process)', () => {
    const child = spawnSync(process.execPath, [join(SCRIPTS, 'generate-customer-workspace.mjs'),
      '--release-check', join(work, 'x.json'), '--release-version', '6.6.0', '--push'], { encoding: 'utf8', timeout: 60000 });
    expect(child.status).toBe(2);
    expect(child.stderr).toMatch(/never pushes/);
    expect(existsSync(join(work, 'x.json'))).toBe(false);
  });

  it('deliver.mjs refuses --release-check together with --push, and needs --release-version', () => {
    const run = (...extra: string[]) => spawnSync(process.execPath, [join(SCRIPTS, 'deliver.mjs'), 'mauser', '--release-check', join(work, 'x.json'), ...extra],
      { encoding: 'utf8', timeout: 60000 });
    const both = run('--release-version', '6.6.0', '--push');
    expect(both.status).toBe(2);
    expect(both.stderr).toMatch(/never pushes/);
    // The out-file value is not read as a second slug.
    expect(both.stderr).not.toMatch(/Only one <slug>/);
    const missing = run();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/needs --release-version/);
  });
});
