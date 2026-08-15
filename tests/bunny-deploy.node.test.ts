// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bunny-deploy.node.test.ts — Node-environment parity tests for the
 * Unity-independent Bunny CDN deploy CLI (`scripts/_bunny-lib.mjs`).
 *
 * These tests fixate behavioral parity with the Unity C# tooling
 * (BunnyCdnUploader.cs + WebViewerToolbar.cs): URL/segment encoding, diff +
 * always-upload rules, name sanitization, private staging, MIME/headers/retry,
 * config fail-fast, region normalization, build-env mode, purge condition,
 * recursive listing + index, dry-run, and force.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildUploadUrl,
  selectFilesToUpload,
  sanitizeDemoName,
  stagePrivateProject,
  BunnyClient,
  loadConfig,
  normalizeRegion,
  buildEnvForMode,
  buildRemoteIndex,
  mimeType,
  ALWAYS_UPLOAD_FILES,
  applyPublicModelAllowlist,
  PUBLIC_MODEL_PREFIX,
  applyPublicScenePruning,
  PUBLIC_TEST_SCENE_PREFIX,
  injectSeoTags,
  injectNoindex,
  writeSeoArtifacts,
  SEO_CANONICAL_PATH,
} from '../scripts/_bunny-lib.mjs';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { generateFragmentSecret, isEncryptedEnvelope, decryptGlb } from '../scripts/lib/rv-crypto.mjs';

// ─── 9.1 buildUploadUrl ──────────────────────────────────────────────────

describe('buildUploadUrl', () => {
  it('encodes each path segment, keeps slashes', () => {
    const url = buildUploadUrl('storage.bunnycdn.com', 'rv-zone', 'demo/My Model.glb');
    expect(url).toBe('https://storage.bunnycdn.com/rv-zone/demo/My%20Model.glb');
  });
});

// ─── 9.2 diff selection ──────────────────────────────────────────────────

describe('diff selection', () => {
  it('skips same-size files but forces always-upload files', () => {
    const local = [
      { rel: 'assets/index-abc.js', size: 100 },
      { rel: 'index.html', size: 50 },
      { rel: 'settings.json', size: 20 },
      { rel: 'models/machine.glb', size: 999 },
    ];
    const remote = new Map([
      ['assets/index-abc.js', 100],
      ['index.html', 50],
      ['settings.json', 20],
      ['models/machine.glb', 999],
    ]);
    const sel = selectFilesToUpload(local, remote, { force: false });
    const rels = sel.map((f: { rel: string }) => f.rel).sort();
    expect(rels).toEqual(['index.html', 'settings.json']); // js + glb unchanged
  });

  it('always-upload set covers settings/models/manifest json', () => {
    expect(ALWAYS_UPLOAD_FILES.has('settings.json')).toBe(true);
    expect(ALWAYS_UPLOAD_FILES.has('models.json')).toBe(true);
    expect(ALWAYS_UPLOAD_FILES.has('manifest.json')).toBe(true);
  });

  it('alwaysUploadGlbs=true selects same-size GLBs (encrypted deploys)', () => {
    // Encrypted RVE1 envelopes change bytes but not size on a password change —
    // the size diff must never skip them.
    const local = [
      { rel: 'assets/index-abc.js', size: 100 },
      { rel: 'models/machine.glb', size: 999 },
    ];
    const remote = new Map([
      ['assets/index-abc.js', 100],
      ['models/machine.glb', 999],
    ]);
    const sel = selectFilesToUpload(local, remote, { force: false, alwaysUploadGlbs: true });
    expect(sel.map((f: { rel: string }) => f.rel)).toEqual(['models/machine.glb']);
  });

  it('force=true selects everything (diff skipped)', () => {
    const local = [
      { rel: 'assets/index-abc.js', size: 100 },
      { rel: 'models/machine.glb', size: 999 },
    ];
    const remote = new Map([
      ['assets/index-abc.js', 100],
      ['models/machine.glb', 999],
    ]);
    const sel = selectFilesToUpload(local, remote, { force: true });
    expect(sel.length).toBe(2);
  });
});

// ─── 9.3 sanitizeDemoName ────────────────────────────────────────────────

describe('sanitizeDemoName', () => {
  it('lowercases, replaces invalid chars, collapses + trims dashes', () => {
    expect(sanitizeDemoName('Kunde XY / Linie #2')).toBe('kunde-xy-linie-2');
  });
  it('caps at 60 chars', () => {
    expect(sanitizeDemoName('a'.repeat(80)).length).toBe(60);
  });
  // R13 edge cases
  it('empty input falls back to "demo"', () => {
    expect(sanitizeDemoName('')).toBe('demo');
    expect(sanitizeDemoName(null)).toBe('demo');
    expect(sanitizeDemoName('###')).toBe('demo'); // all invalid → empty → "demo"
  });
  it('trims leading and trailing dashes', () => {
    expect(sanitizeDemoName('-abc-')).toBe('abc');
    expect(sanitizeDemoName('  -Kunde-  ')).toBe('kunde');
  });
});

// ─── 9.4 stagePrivateProject ─────────────────────────────────────────────

describe('stagePrivateProject', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvdep-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('produces correct staging contents', async () => {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    writeFileSync(join(dist, 'assets', 'demo.glb'), 'PUBLIC'); // must be dropped
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'JS');  // must be kept
    const proj = join(work, 'projects', 'kunde-xy');
    mkdirSync(join(proj, 'models'), { recursive: true });
    writeFileSync(join(proj, 'models', 'machine.glb'), 'CUSTOMER');
    writeFileSync(join(proj, 'project.json'),
      JSON.stringify({ name: 'Kunde XY', code: 'deadbeef', settings: { defaultModel: 'machine.glb' } }));

    const staging = await stagePrivateProject({ distDir: dist, projectDir: proj });
    try {
      expect(existsSync(join(staging, 'index.html'))).toBe(true);
      expect(existsSync(join(staging, 'assets', 'demo.glb'))).toBe(false);   // public glb removed
      expect(existsSync(join(staging, 'assets', 'index-abc.js'))).toBe(true); // other assets kept
      expect(existsSync(join(staging, 'models', 'machine.glb'))).toBe(true); // customer glb present
      expect(JSON.parse(readFileSync(join(staging, 'models.json'), 'utf8'))).toEqual(['machine.glb']);
      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.defaultModel).toBe('models/machine.glb');
      expect(settings.projectAssetsPath).toBe('private-assets/kunde-xy/');
      // Customer deploys never carry analytics
      expect(settings.analytics.googleAnalyticsId).toBe('');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('never carries a GA id in private customer deploys', async () => {
    const dist = join(work, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    const proj = join(work, 'projects', 'kunde-z');
    mkdirSync(join(proj, 'models'), { recursive: true });
    writeFileSync(join(proj, 'project.json'),
      JSON.stringify({ name: 'Kunde Z', code: 'cafebabe', settings: {} }));

    // Even a (stale) caller passing a GA id must not leak it into the staging.
    const staging = await stagePrivateProject({
      distDir: dist, projectDir: proj, googleAnalyticsId: 'G-TEST123',
    } as never);
    try {
      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.analytics.googleAnalyticsId).toBe('');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('encrypts GLBs in place and flags settings when a password is given (plan-267)', async () => {
    const dist = join(work, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<html></html>');
    const proj = join(work, 'projects', 'kunde-enc');
    mkdirSync(join(proj, 'models'), { recursive: true });
    const plainGlb = 'glTF-CUSTOMER-GEOMETRY-BYTES';
    writeFileSync(join(proj, 'models', 'machine.glb'), plainGlb);
    writeFileSync(join(proj, 'project.json'),
      JSON.stringify({ name: 'Kunde Enc', code: 'facefeed', settings: { defaultModel: 'machine.glb' } }));

    const fragmentSecret = generateFragmentSecret();
    const staging = await stagePrivateProject({
      distDir: dist, projectDir: proj,
      encryption: { password: 'geheim-2027', fragmentSecret, iterations: 1000 },
    });
    try {
      // Same .glb name, but the body is now an RVE1 envelope (not the plaintext).
      const staged = readFileSync(join(staging, 'models', 'machine.glb'));
      expect(isEncryptedEnvelope(staged)).toBe(true);
      expect(staged.toString('utf8')).not.toContain('CUSTOMER');
      // settings.json advertises encryption; manifest keeps the .glb name.
      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.encryption).toEqual({ enabled: true });
      expect(JSON.parse(readFileSync(join(staging, 'models.json'), 'utf8'))).toEqual(['machine.glb']);
      // Round-trips with the same password + fragment.
      const back = await decryptGlb(new Uint8Array(staged), 'geheim-2027', fragmentSecret);
      expect(new TextDecoder().decode(back)).toBe(plainGlb);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

// ─── 9.4b applyPublicModelAllowlist ──────────────────────────────────────

describe('applyPublicModelAllowlist', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvallow-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  /** Build a dist/ mirroring a real public build: verbatim models/ + library/,
   *  plus the hashed assets/ duplicates Vite emits for every globbed GLB. */
  function makeDist(): string {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'models', 'library', 'PalletHandling'), { recursive: true });
    mkdirSync(join(dist, 'assets'), { recursive: true });
    // top-level models (verbatim publicDir copies)
    for (const f of ['DemoRealvirtualWeb.glb', 'DemoRobotIK.glb', 'EuropalletEmpty.glb', 'tests.glb']) {
      writeFileSync(join(dist, 'models', f), 'GLB');
    }
    // planner library (must always survive)
    for (const f of ['Europallet.glb', 'EuropalletLoaded.glb', 'ChainConveyor-1m.glb']) {
      writeFileSync(join(dist, 'models', 'library', 'PalletHandling', f), 'GLB');
    }
    writeFileSync(join(dist, 'models', 'library', 'catalog.json'), '{"entries":[]}');
    // hashed assets/ duplicates (Vite content hash; note a hash may contain '-')
    for (const f of [
      'DemoRealvirtualWeb-D17zvQbu.glb', 'DemoRobotIK-DVCOxFk2.glb',
      'EuropalletEmpty-CRO-B5qD.glb', 'tests-Du1D0p2I.glb',
      'Europallet-YuOv3y_q.glb', 'EuropalletLoaded-Dc8dx8gC.glb', 'ChainConveyor-1m-CFqim7Ud.glb',
      'index-abc.js',
    ]) {
      writeFileSync(join(dist, 'assets', f), 'X');
    }
    return dist;
  }

  it('keeps DemoRealvirtual* + library, prunes the rest incl. hashed copies', () => {
    const dist = makeDist();
    const res = applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual' });

    expect(res.kept).toEqual(['DemoRealvirtualWeb.glb']);
    expect(res.dropped).toEqual(['DemoRobotIK.glb', 'EuropalletEmpty.glb', 'tests.glb']);

    // top-level models pruned / kept on disk
    expect(existsSync(join(dist, 'models', 'DemoRealvirtualWeb.glb'))).toBe(true);
    expect(existsSync(join(dist, 'models', 'DemoRobotIK.glb'))).toBe(false);
    expect(existsSync(join(dist, 'models', 'EuropalletEmpty.glb'))).toBe(false);
    expect(existsSync(join(dist, 'models', 'tests.glb'))).toBe(false);

    // planner library fully intact
    expect(existsSync(join(dist, 'models', 'library', 'PalletHandling', 'Europallet.glb'))).toBe(true);
    expect(existsSync(join(dist, 'models', 'library', 'PalletHandling', 'EuropalletLoaded.glb'))).toBe(true);
    expect(existsSync(join(dist, 'models', 'library', 'catalog.json'))).toBe(true);

    // hashed duplicates of dropped models removed; demo + library + non-glb kept
    expect(existsSync(join(dist, 'assets', 'DemoRobotIK-DVCOxFk2.glb'))).toBe(false);
    expect(existsSync(join(dist, 'assets', 'tests-Du1D0p2I.glb'))).toBe(false);
    expect(existsSync(join(dist, 'assets', 'EuropalletEmpty-CRO-B5qD.glb'))).toBe(false); // hash with '-'
    expect(existsSync(join(dist, 'assets', 'DemoRealvirtualWeb-D17zvQbu.glb'))).toBe(true);
    expect(existsSync(join(dist, 'assets', 'index-abc.js'))).toBe(true);

    // EuropalletEmpty must NOT take down library Europallet*/loaded assets (hyphen boundary)
    expect(existsSync(join(dist, 'assets', 'Europallet-YuOv3y_q.glb'))).toBe(true);
    expect(existsSync(join(dist, 'assets', 'EuropalletLoaded-Dc8dx8gC.glb'))).toBe(true);
    expect(existsSync(join(dist, 'assets', 'ChainConveyor-1m-CFqim7Ud.glb'))).toBe(true);
    expect(res.droppedAssets).toEqual(
      ['DemoRobotIK-DVCOxFk2.glb', 'EuropalletEmpty-CRO-B5qD.glb', 'tests-Du1D0p2I.glb'],
    );
  });

  it('writes models.json listing only the kept demo models', () => {
    const dist = makeDist();
    applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual' });
    expect(JSON.parse(readFileSync(join(dist, 'models.json'), 'utf8'))).toEqual(['DemoRealvirtualWeb.glb']);
  });

  it('dry-run computes the report without deleting or writing', () => {
    const dist = makeDist();
    const res = applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual', dryRun: true });
    expect(res.dropped).toEqual(['DemoRobotIK.glb', 'EuropalletEmpty.glb', 'tests.glb']);
    expect(existsSync(join(dist, 'models', 'tests.glb'))).toBe(true);           // not deleted
    expect(existsSync(join(dist, 'assets', 'tests-Du1D0p2I.glb'))).toBe(true);  // not deleted
    expect(existsSync(join(dist, 'models.json'))).toBe(false);                  // not written
  });

  it('is idempotent on an already-pruned dist/', () => {
    const dist = makeDist();
    applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual' });
    const res = applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual' });
    expect(res.kept).toEqual(['DemoRealvirtualWeb.glb']);
    expect(res.dropped).toEqual([]);
    expect(res.droppedAssets).toEqual([]);
  });

  it('default prefix is DemoRealvirtual', () => {
    expect(PUBLIC_MODEL_PREFIX).toBe('DemoRealvirtual');
  });
});

// ─── 9.4c applyPublicScenePruning ────────────────────────────────────────

describe('applyPublicScenePruning', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvscene-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  /** dist/scenes/ with a curated demo, two Test fixtures, and an index.json
   *  listing all three (mirroring a real public build of public/scenes/).
   *  Examples are GLBs since plan-413 phase 3. */
  function makeDist(): string {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'scenes'), { recursive: true });
    writeFileSync(join(dist, 'scenes', 'DemoPlanner.glb'), 'glTF');
    writeFileSync(join(dist, 'scenes', 'Test-DES-Turntable-Loop.glb'), 'glTF');
    writeFileSync(join(dist, 'scenes', 'test-lowercase.glb'), 'glTF'); // case-insensitive
    writeFileSync(join(dist, 'scenes', 'index.json'), JSON.stringify([
      { file: 'DemoPlanner.glb', name: 'Planner Demo', mode: 'planner' },
      { file: 'Test-DES-Turntable-Loop.glb', name: 'Test DES Turntable Loop', mode: 'des' },
      { file: 'test-lowercase.glb', name: 'lc', mode: 'des' },
    ], null, 2));
    return dist;
  }

  it('deletes Test* scene files and keeps the curated demo', () => {
    const dist = makeDist();
    const res = applyPublicScenePruning(dist, { prefix: 'Test' });

    expect(res.kept).toEqual(['DemoPlanner.glb']);
    expect(res.dropped).toEqual(['Test-DES-Turntable-Loop.glb', 'test-lowercase.glb']);

    expect(existsSync(join(dist, 'scenes', 'DemoPlanner.glb'))).toBe(true);
    expect(existsSync(join(dist, 'scenes', 'Test-DES-Turntable-Loop.glb'))).toBe(false);
    expect(existsSync(join(dist, 'scenes', 'test-lowercase.glb'))).toBe(false);
  });

  it('still prunes a legacy .scene.json example from an older dist', () => {
    // Phase 6 deletes the JSON world; until then a dist built from an older
    // source tree must not smuggle a test scene onto the public CDN.
    const dist = join(work, 'legacy-dist');
    mkdirSync(join(dist, 'scenes'), { recursive: true });
    writeFileSync(join(dist, 'scenes', 'Test-Old.scene.json'), '{}');
    writeFileSync(join(dist, 'scenes', 'DemoPlanner.scene.json'), '{}');
    const res = applyPublicScenePruning(dist, { prefix: 'Test' });
    expect(res.dropped).toEqual(['Test-Old.scene.json']);
    expect(existsSync(join(dist, 'scenes', 'Test-Old.scene.json'))).toBe(false);
    expect(existsSync(join(dist, 'scenes', 'DemoPlanner.scene.json'))).toBe(true);
  });

  it('rewrites index.json to drop the Test* entries', () => {
    const dist = makeDist();
    applyPublicScenePruning(dist, { prefix: 'Test' });
    const idx = JSON.parse(readFileSync(join(dist, 'scenes', 'index.json'), 'utf8'));
    expect(idx).toEqual([{ file: 'DemoPlanner.glb', name: 'Planner Demo', mode: 'planner' }]);
  });

  it('dry-run reports without deleting or rewriting', () => {
    const dist = makeDist();
    const res = applyPublicScenePruning(dist, { prefix: 'Test', dryRun: true });
    expect(res.dropped).toEqual(['Test-DES-Turntable-Loop.glb', 'test-lowercase.glb']);
    expect(existsSync(join(dist, 'scenes', 'Test-DES-Turntable-Loop.glb'))).toBe(true); // not deleted
    const idx = JSON.parse(readFileSync(join(dist, 'scenes', 'index.json'), 'utf8'));
    expect(idx).toHaveLength(3);                                                        // not rewritten
  });

  it('is idempotent and a no-op when there is no scenes/ dir', () => {
    const dist = makeDist();
    applyPublicScenePruning(dist, { prefix: 'Test' });
    const res = applyPublicScenePruning(dist, { prefix: 'Test' });
    expect(res.dropped).toEqual([]);
    expect(res.kept).toEqual(['DemoPlanner.glb']);

    const empty = join(work, 'empty-dist');
    mkdirSync(empty, { recursive: true });
    expect(applyPublicScenePruning(empty).dropped).toEqual([]);
  });

  it('default prefix is Test', () => {
    expect(PUBLIC_TEST_SCENE_PREFIX).toBe('Test');
  });
});

// ─── 9.5 BunnyClient.putFile ─────────────────────────────────────────────

describe('BunnyClient.putFile', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('sends AccessKey + glb mime, retries once on 503', async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
    const fetchMock = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, init });
      const fail = calls.length === 1;
      return {
        status: fail ? 503 : 201,
        ok: !fail,
        text: async () => '',
        json: async () => ({}),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new BunnyClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K' });
    await client.putFile(Buffer.from('x'), 'demo/m.glb');

    expect(calls.length).toBe(2); // retry happened
    expect(calls[1].init.headers['AccessKey']).toBe('K');
    expect(calls[1].init.headers['Content-Type']).toBe('model/gltf-binary');
  });

  it('mimeType maps glb to model/gltf-binary, unknown to octet-stream', () => {
    expect(mimeType('a/b.glb')).toBe('model/gltf-binary');
    expect(mimeType('a/b.html')).toBe('text/html');
    expect(mimeType('a/b.unknownext')).toBe('application/octet-stream');
  });

  it('skips fetch entirely in dry-run mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new BunnyClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K', dryRun: true });
    await client.putFile(Buffer.from('x'), 'demo/m.glb');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── 9.6 config + region ─────────────────────────────────────────────────

describe('config', () => {
  it('throws when BUNNY_STORAGE_KEY missing', () => {
    expect(() => loadConfig({ BUNNY_STORAGE_ZONE: 'z' })).toThrow(/BUNNY_STORAGE_KEY/);
  });
  it('throws when BUNNY_STORAGE_ZONE missing', () => {
    expect(() => loadConfig({ BUNNY_STORAGE_KEY: 'k' })).toThrow(/BUNNY_STORAGE_ZONE/);
  });
  it('normalizes region label suffix', () => {
    expect(normalizeRegion('storage.bunnycdn.com (Falkenstein DE)')).toBe('storage.bunnycdn.com');
    expect(normalizeRegion(undefined)).toBe('storage.bunnycdn.com'); // default
  });
  it('returns GA id from env', () => {
    const cfg = loadConfig({ BUNNY_STORAGE_KEY: 'k', BUNNY_STORAGE_ZONE: 'z', GA_MEASUREMENT_ID: 'G-X' });
    expect(cfg.googleAnalyticsId).toBe('G-X');
  });
});

// ─── 9.7 buildEnvForMode ─────────────────────────────────────────────────

describe('buildEnvForMode', () => {
  it('public build sets VITE_PUBLIC_BUILD=1', () => {
    expect(buildEnvForMode('public', {}).VITE_PUBLIC_BUILD).toBe('1');
  });
  it('private build must NOT set VITE_PUBLIC_BUILD', () => {
    expect(buildEnvForMode('private', {}).VITE_PUBLIC_BUILD).toBeUndefined();
  });
  it('passes base path as VITE_BASE', () => {
    expect(buildEnvForMode('public', { base: '/demo/' }).VITE_BASE).toBe('/demo/');
  });
});

// ─── R11: listRecursive + buildRemoteIndex (IsDirectory filter) ──────────

describe('listRecursive + buildRemoteIndex', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('descends into directories and indexes files (lowercased, dirs filtered)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      // root /demo/
      if (/\/z\/demo\/$/.test(u)) {
        return {
          ok: true,
          json: async () => [
            { ObjectName: 'Index.HTML', Length: 10, IsDirectory: false },
            { ObjectName: 'assets', Length: 0, IsDirectory: true },
          ],
        };
      }
      // /demo/assets/
      if (/\/z\/demo\/assets\/$/.test(u)) {
        return {
          ok: true,
          json: async () => [
            { ObjectName: 'app.js', Length: 200, IsDirectory: false },
          ],
        };
      }
      return { ok: false, json: async () => [] };
    }));

    const client = new BunnyClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K' });
    const entries = await client.listRecursive('demo');
    const index = buildRemoteIndex(entries);

    expect(index.get('index.html')).toBe(10);     // lowercased
    expect(index.get('assets/app.js')).toBe(200);  // nested
    expect(index.has('assets')).toBe(false);       // directory not indexed
  });

  it('returns empty list when remote path does not exist yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })));
    const client = new BunnyClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K' });
    const entries = await client.listRecursive('newdemo');
    expect(entries).toEqual([]);
  });
});

// ─── R11: purge condition ────────────────────────────────────────────────

describe('BunnyClient.purge', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('skips purge (no fetch) when account key / pull zone missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new BunnyClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K' });
    const ok = await client.purge();
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('purges once when account key + pull zone set', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: { method: string; headers: Record<string, string> }) =>
        ({ ok: true, text: async () => '' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new BunnyClient({
      region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K',
      accountKey: 'ACC', pullZoneId: '12345',
    });
    const ok = await client.purge();
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toBe('https://api.bunny.net/pullzone/12345/purgeCache');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.AccessKey).toBe('ACC');
  });

  it('does not fetch when dry-run', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new BunnyClient({
      region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K',
      accountKey: 'ACC', pullZoneId: '12345', dryRun: true,
    });
    const ok = await client.purge();
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── SEO artifacts (public deploy) ───────────────────────────────────────

describe('SEO artifacts', () => {
  const PAGE_URL = 'https://web.realvirtual.io/demo/';
  let dist: string;

  function makeDist(withOgImage = false): string {
    const dir = mkdtempSync(join(tmpdir(), 'rv-seo-test-'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!DOCTYPE html>\n<html><head>\n  <title>realvirtual WEB</title>\n</head>\n<body></body></html>\n',
    );
    writeFileSync(join(dir, 'pwa-512x512.png'), 'png');
    if (withOgImage) writeFileSync(join(dir, 'og-image.png'), 'png');
    return dir;
  }

  afterEach(() => {
    if (dist && existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  });

  it('default canonical path is demo', () => {
    expect(SEO_CANONICAL_PATH).toBe('demo');
  });

  it('injects canonical + og:url + fallback og:image with summary card', () => {
    dist = makeDist(false);
    expect(injectSeoTags(dist, { pageUrl: PAGE_URL })).toBe(true);
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(html).toContain(`<link rel="canonical" href="${PAGE_URL}" />`);
    expect(html).toContain(`<meta property="og:url" content="${PAGE_URL}" />`);
    expect(html).toContain(`<meta property="og:image" content="${PAGE_URL}pwa-512x512.png" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('</head>'); // head still closed exactly once
    expect(html.match(/<\/head>/g)?.length).toBe(1);
  });

  it('prefers og-image.png with summary_large_image card when present', () => {
    dist = makeDist(true);
    injectSeoTags(dist, { pageUrl: PAGE_URL });
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(html).toContain(`<meta property="og:image" content="${PAGE_URL}og-image.png" />`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it('is idempotent — second injection is a no-op', () => {
    dist = makeDist(false);
    injectSeoTags(dist, { pageUrl: PAGE_URL });
    const once = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(injectSeoTags(dist, { pageUrl: PAGE_URL })).toBe(false);
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe(once);
  });

  it('dry-run reports true but writes nothing', () => {
    dist = makeDist(false);
    const before = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(injectSeoTags(dist, { pageUrl: PAGE_URL, dryRun: true })).toBe(true);
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe(before);
  });

  it('injectNoindex adds the robots meta exactly once', () => {
    dist = makeDist(false);
    const indexPath = join(dist, 'index.html');
    expect(injectNoindex(indexPath)).toBe(true);
    const html = readFileSync(indexPath, 'utf8');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(injectNoindex(indexPath)).toBe(false); // idempotent
  });

  it('writeSeoArtifacts writes sitemap.xml + robots.txt with absolute URLs', () => {
    dist = makeDist(false);
    const { robots, sitemap } = writeSeoArtifacts(dist, { pageUrl: PAGE_URL });
    expect(readFileSync(join(dist, 'sitemap.xml'), 'utf8')).toBe(sitemap);
    expect(readFileSync(join(dist, 'robots.txt'), 'utf8')).toBe(robots);
    expect(sitemap).toContain(`<loc>${PAGE_URL}</loc>`);
    expect(robots).toContain(`Sitemap: ${PAGE_URL}sitemap.xml`);
    expect(robots).toContain('User-agent: *');
  });

  it('writeSeoArtifacts dry-run writes no files', () => {
    dist = makeDist(false);
    writeSeoArtifacts(dist, { pageUrl: PAGE_URL, dryRun: true });
    expect(existsSync(join(dist, 'sitemap.xml'))).toBe(false);
    expect(existsSync(join(dist, 'robots.txt'))).toBe(false);
  });
});
