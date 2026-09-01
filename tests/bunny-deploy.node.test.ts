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
  publicDemoModelAllowlist,
  publicDemoManifestMisses,
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
import { assertManifestResolves } from './helpers/assert-manifest-resolves';

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

  it('default prefix is DemoRealvirtual only (user decision 2026-08-30: RobotIK + CSGMachining are internal dev/test models)', () => {
    expect(PUBLIC_MODEL_PREFIX).toBe('DemoRealvirtual');
  });

  it('comma-separated prefix list keeps a model matching ANY prefix', () => {
    // Mechanic test with an explicit two-prefix list — the DEFAULT list is a
    // single prefix since the 2026-08-30 decision (CSGMachining internal), so
    // the multi-prefix behaviour is exercised via the override parameter.
    const dist = makeDist();
    writeFileSync(join(dist, 'models', 'DemoCSGMachining.glb'), 'GLB');
    writeFileSync(join(dist, 'assets', 'DemoCSGMachining-DwwnP9kU.glb'), 'X');
    const res = applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual,DemoCSGMachining' });
    expect(res.kept).toEqual(['DemoCSGMachining.glb', 'DemoRealvirtualWeb.glb']);
    expect(existsSync(join(dist, 'models', 'DemoCSGMachining.glb'))).toBe(true);
    expect(existsSync(join(dist, 'assets', 'DemoCSGMachining-DwwnP9kU.glb'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dist, 'models.json'), 'utf8')))
      .toEqual(['DemoCSGMachining.glb', 'DemoRealvirtualWeb.glb']);
  });
});

// ─── 9.4c applyPublicScenePruning ────────────────────────────────────────

describe('applyPublicScenePruning', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvscene-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  /**
   * A dist as a CURRENT build produces it (plan-731): the documents are
   * `project.json` rows at the deploy root, and the dev-only one is marked
   * `devOnly` rather than named "Test*".
   *
   * The fixture deliberately gives the dev-only document a name that the OLD
   * filename rule would not have caught, and puts it outside `scenes/` — which
   * is where plan-731 2a moved the real one. If the manifest pass were missing,
   * this fixture would ship.
   */
  function makeManifestDist(): string {
    const dist = join(work, 'mdist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'DemoRealvirtualWeb.glb'), 'glTF');
    writeFileSync(join(dist, 'DemoPlanner.glb'), 'glTF');
    writeFileSync(join(dist, 'Turntable-Loop-Fixture.glb'), 'glTF');
    writeFileSync(join(dist, 'project.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'prj_sample',
      name: 'DemoRealvirtual',
      settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb', section: 'models' },
        { id: 'doc_b', name: 'Planner', path: 'DemoPlanner.glb', section: 'scenes' },
        {
          id: 'doc_fix', name: 'Fixture', path: 'Turntable-Loop-Fixture.glb',
          section: 'scenes', devOnly: true,
        },
      ],
    }, null, 2));
    return dist;
  }

  /** A dist from an OLDER source tree: a curated index.json, no devOnly rows. */
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

  it('deletes the devOnly document and its row, wherever the file sits', () => {
    // plan-731 2k: the manifest decides. The fixture's NAME would not have
    // matched the old "Test*" rule and it does not live in scenes/ — so this
    // passes only because the row said so.
    const dist = makeManifestDist();
    const res = applyPublicScenePruning(dist, { prefix: 'Test' });

    expect(res.dropped).toEqual(['Turntable-Loop-Fixture.glb']);
    expect(res.kept).toEqual(['DemoPlanner.glb', 'DemoRealvirtualWeb.glb']);

    expect(existsSync(join(dist, 'Turntable-Loop-Fixture.glb'))).toBe(false);
    expect(existsSync(join(dist, 'DemoPlanner.glb'))).toBe(true);
    expect(existsSync(join(dist, 'DemoRealvirtualWeb.glb'))).toBe(true);

    // The SHIPPED manifest no longer names it — a row without a file is the
    // 404 only the visitor ever sees.
    const shipped = JSON.parse(readFileSync(join(dist, 'project.json'), 'utf8'));
    expect(shipped.documents.map((d: { id: string }) => d.id)).toEqual(['doc_a', 'doc_b']);
    // Everything else about the manifest is carried through untouched.
    expect(shipped.settings.defaultModel).toBe('DemoRealvirtualWeb.glb');
    expect(shipped.id).toBe('prj_sample');
  });

  it('is idempotent over the manifest pass', () => {
    const dist = makeManifestDist();
    applyPublicScenePruning(dist, { prefix: 'Test' });
    const again = applyPublicScenePruning(dist, { prefix: 'Test' });
    expect(again.dropped).toEqual([]);
    expect(again.kept).toEqual(['DemoPlanner.glb', 'DemoRealvirtualWeb.glb']);
  });

  it('dry-run over a manifest dist reports without deleting or rewriting', () => {
    const dist = makeManifestDist();
    const res = applyPublicScenePruning(dist, { prefix: 'Test', dryRun: true });
    expect(res.dropped).toEqual(['Turntable-Loop-Fixture.glb']);
    expect(existsSync(join(dist, 'Turntable-Loop-Fixture.glb'))).toBe(true);
    const shipped = JSON.parse(readFileSync(join(dist, 'project.json'), 'utf8'));
    expect(shipped.documents).toHaveLength(3);
  });

  it('the filename fallback still catches a dist from an older source tree', () => {
    // No devOnly anywhere in this dist — the defensive pass is all there is,
    // and a pruner that silently stopped pruning is how a fixture reaches the
    // public CDN.
    const dist = makeDist();
    const res = applyPublicScenePruning(dist, { prefix: 'Test' });

    expect(res.kept).toEqual(['scenes/DemoPlanner.glb']);
    expect(res.dropped)
      .toEqual(['scenes/Test-DES-Turntable-Loop.glb', 'scenes/test-lowercase.glb']);

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
    expect(res.dropped).toEqual(['scenes/Test-Old.scene.json']);
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
    expect(res.dropped)
      .toEqual(['scenes/Test-DES-Turntable-Loop.glb', 'scenes/test-lowercase.glb']);
    expect(existsSync(join(dist, 'scenes', 'Test-DES-Turntable-Loop.glb'))).toBe(true); // not deleted
    const idx = JSON.parse(readFileSync(join(dist, 'scenes', 'index.json'), 'utf8'));
    expect(idx).toHaveLength(3);                                                        // not rewritten
  });

  it('is idempotent and a no-op when there is no scenes/ dir', () => {
    const dist = makeDist();
    applyPublicScenePruning(dist, { prefix: 'Test' });
    const res = applyPublicScenePruning(dist, { prefix: 'Test' });
    expect(res.dropped).toEqual([]);
    expect(res.kept).toEqual(['scenes/DemoPlanner.glb']);

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

// ─── 9.5 plan-726: the manifest curates the public deploy ────────────────

/**
 * Before plan-726 the only curator of the public demo was a filename prefix
 * (`DemoRealvirtual,DemoCSGMachining`), and the demo's own `project.json` had
 * no say. That had a live consequence: `DemoRobotIK.glb` is a demo model, it is
 * listed in the manifest, and it matches NEITHER prefix — so every public and
 * `--demo` deploy silently deleted it before upload.
 *
 * These nets pin the three parts of the fix: the manifest is read, it wins over
 * the prefix, and a manifest that names something the build does not contain
 * stops the deploy instead of shipping a 404 the visitor finds first.
 */
describe('publicDemoModelAllowlist (plan-726)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv726-allow-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  const manifest = (documents: unknown[]) => JSON.stringify({
    schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', documents,
  });

  it('is null for a dist/ with no manifest — the prefix rule still applies', () => {
    // Null and [] are different answers and the caller branches on it: null is
    // "no manifest, use the prefix", [] is "the manifest declares no models".
    expect(publicDemoModelAllowlist(work)).toBeNull();
  });

  it('reads only models/ documents, ignoring scenes and library', () => {
    writeFileSync(join(work, 'project.json'), manifest([
      { id: 'a', path: 'models/DemoRealvirtualWeb.glb', section: 'models' },
      { id: 'b', path: 'models/DemoRobotIK.glb', section: 'models' },
      { id: 'c', path: 'scenes/DemoPlanner.glb', section: 'scenes' },
      { id: 'd', path: 'library/PalletHandling/Europallet.glb', section: 'library' },
    ]));
    const models = publicDemoModelAllowlist(work);
    // Not null: the manifest was just written. The distinction matters — null
    // would mean "no manifest, fall back to the prefix rule".
    expect(models).not.toBeNull();
    expect(models!.sort()).toEqual(['DemoRealvirtualWeb.glb', 'DemoRobotIK.glb']);
  });

  it('KEEPS DemoRobotIK.glb, which every prefix deploy deletes today', () => {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'models'), { recursive: true });
    for (const f of ['DemoRealvirtualWeb.glb', 'DemoRobotIK.glb', 'tests.glb']) {
      writeFileSync(join(dist, 'models', f), 'GLB');
    }
    writeFileSync(join(dist, 'project.json'), manifest([
      { id: 'a', path: 'models/DemoRealvirtualWeb.glb', section: 'models' },
      { id: 'b', path: 'models/DemoRobotIK.glb', section: 'models' },
    ]));

    // The bug, restated: the built-in prefixes drop it.
    expect(applyPublicModelAllowlist(dist, { prefix: PUBLIC_MODEL_PREFIX, dryRun: true }).dropped)
      .toContain('DemoRobotIK.glb');

    // The manifest keeps it, and still prunes the scratch fixture.
    const res = applyPublicModelAllowlist(dist, { keep: publicDemoModelAllowlist(dist) });
    expect(res.kept).toEqual(['DemoRealvirtualWeb.glb', 'DemoRobotIK.glb']);
    expect(res.dropped).toEqual(['tests.glb']);
    expect(existsSync(join(dist, 'models', 'DemoRobotIK.glb'))).toBe(true);
    expect(existsSync(join(dist, 'models', 'tests.glb'))).toBe(false);
  });

  it('an explicit keep list REPLACES the prefix rather than adding to it', () => {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'models'), { recursive: true });
    for (const f of ['DemoRealvirtualWeb.glb', 'DemoCSGMachining.glb']) {
      writeFileSync(join(dist, 'models', f), 'GLB');
    }
    // `DemoCSGMachining` matches a built-in prefix but is NOT in the keep list.
    const res = applyPublicModelAllowlist(dist, { keep: ['DemoRealvirtualWeb.glb'] });
    expect(res.kept).toEqual(['DemoRealvirtualWeb.glb']);
    expect(res.dropped).toEqual(['DemoCSGMachining.glb']);
  });

  it('the pre-726 signature still works — no keep, prefix as before', () => {
    // The existing net calls `applyPublicModelAllowlist(dist)` with no options
    // at all; the new parameter had to be additive.
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'models'), { recursive: true });
    writeFileSync(join(dist, 'models', 'DemoRealvirtualWeb.glb'), 'GLB');
    writeFileSync(join(dist, 'models', 'tests.glb'), 'GLB');
    expect(applyPublicModelAllowlist(dist).kept).toEqual(['DemoRealvirtualWeb.glb']);
  });
});

describe('publicDemoManifestMisses — the contradiction guard (plan-726 F5)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv726-guard-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  function distWith(documents: unknown[], files: string[]): string {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'models'), { recursive: true });
    mkdirSync(join(dist, 'scenes'), { recursive: true });
    for (const rel of files) {
      mkdirSync(join(dist, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(dist, rel), 'GLB');
    }
    writeFileSync(join(dist, 'project.json'), JSON.stringify({
      schemaVersion: 2, id: 'prj_sample', name: 'DemoRealvirtual', documents,
    }));
    return dist;
  }

  const FOUR = [
    { id: 'a', path: 'models/DemoRealvirtualWeb.glb', section: 'models' },
    { id: 'b', path: 'models/DemoRobotIK.glb', section: 'models' },
    { id: 'c', path: 'models/DemoCSGMachining.glb', section: 'models' },
    { id: 'd', path: 'scenes/DemoPlanner.glb', section: 'scenes' },
  ];
  const FOUR_FILES = [
    'models/DemoRealvirtualWeb.glb', 'models/DemoRobotIK.glb',
    'models/DemoCSGMachining.glb', 'scenes/DemoPlanner.glb',
  ];

  it('passes when every declared document is in the build', () => {
    expect(publicDemoManifestMisses(distWith(FOUR, FOUR_FILES))).toEqual([]);
  });

  it('reports a model the pruning removed', () => {
    const dist = distWith(FOUR, FOUR_FILES.filter(f => !f.endsWith('DemoRobotIK.glb')));
    expect(publicDemoManifestMisses(dist)).toEqual(['models/DemoRobotIK.glb']);
  });

  it('reports a SCENE too — the pass that prunes those is a different one', () => {
    // The guard had to span both sections: `scenes/` is pruned by the
    // prefix-based `applyPublicScenePruning`, so a guard hanging off the model
    // allowlist would never have looked at the fourth document of the demo.
    const dist = distWith(FOUR, FOUR_FILES.filter(f => !f.startsWith('scenes/')));
    expect(publicDemoManifestMisses(dist)).toEqual(['scenes/DemoPlanner.glb']);
  });

  it('catches a case-only mismatch, which the storage zone would 404 on', () => {
    // `existsSync('Models/x.glb')` answers true on Windows and macOS and the
    // Linux CDN then serves nothing. This is the typo that survives every
    // local check.
    const dist = distWith(
      [{ id: 'a', path: 'Models/DemoRealvirtualWeb.glb', section: 'models' }],
      ['models/DemoRealvirtualWeb.glb'],
    );
    expect(publicDemoManifestMisses(dist)).toEqual(['Models/DemoRealvirtualWeb.glb']);
  });

  it('ignores library documents, which are staged by another step', () => {
    const dist = distWith(
      [{ id: 'l', path: 'library/PalletHandling/Europallet.glb', section: 'library' }],
      [],
    );
    expect(publicDemoManifestMisses(dist)).toEqual([]);
  });

  it('is vacuously satisfied for a dist/ with no manifest', () => {
    // A private customer deploy publishes no root manifest at all, and the
    // guard must not invent an opinion about it.
    expect(publicDemoManifestMisses(work)).toEqual([]);
  });
});

describe('project.json cache posture (plan-726 Phase 3)', () => {
  it('is an always-upload file, so an edit of equal size still ships', () => {
    // It lives at a FIXED url and the runtime boots from it, so it must never
    // be diffed by size like a hashed build asset — a renamed document or a
    // swapped start document routinely leaves the byte count untouched.
    expect(ALWAYS_UPLOAD_FILES.has('project.json')).toBe(true);
  });
});

// ─── plan-731 Phase 4 (F6): the release gate on the public dist ───────────

/**
 * The `dist/` this channel is about to upload must fully resolve.
 *
 * `demo-manifest-invariants` makes the same assertion about the SOURCE TREE,
 * and the source tree is not what anybody downloads: between it and the CDN sit
 * the model allowlist and the scene prune, either of which can leave the
 * manifest naming something that is no longer there. This is that assertion
 * moved onto the artefact.
 *
 * Both public shapes are covered — the ordinary public demo and `--demo` — via
 * the same helper, so neither can end up checking less than the other.
 */
describe('the public dist passes the release gate (plan-731 F6)', () => {
  let gwork: string;
  beforeEach(() => { gwork = mkdtempSync(join(tmpdir(), 'rvgate-')); });
  afterEach(() => { rmSync(gwork, { recursive: true, force: true }); });

  /** A dist as a build produces it: documents at the root, fixture marked. */
  function makeDeployDist(name: string): string {
    const dist = join(gwork, name);
    mkdirSync(dist, { recursive: true });
    for (const f of [
      'DemoRealvirtualWeb.glb', 'DemoRealvirtualWeb.settings.json',
      'DemoPlanner.glb', 'Turntable-Fixture.glb',
    ]) writeFileSync(join(dist, f), 'glTF');
    writeFileSync(join(dist, 'project.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'prj_sample',
      name: 'DemoRealvirtual',
      canonicalName: 'demorealvirtual',
      settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
      documents: [
        {
          id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb', section: 'models',
          settingsPath: 'DemoRealvirtualWeb.settings.json',
        },
        { id: 'doc_b', name: 'Planner', path: 'DemoPlanner.glb', section: 'scenes' },
        {
          id: 'doc_f', name: 'Fixture', path: 'Turntable-Fixture.glb',
          section: 'scenes', devOnly: true,
        },
      ],
    }, null, 2));
    return dist;
  }

  it('an unpruned dist FAILS the gate — the fixture is still declared', () => {
    // The negative half (4f), and the proof the positive half below means
    // something: run the gate before the prune and it must refuse.
    const dist = makeDeployDist('unpruned');
    expect(() => assertManifestResolves(dist)).toThrow(/dev-only/);
  });

  it('the pruned dist passes, with the fixture gone from files AND manifest', () => {
    const dist = makeDeployDist('public');
    applyPublicScenePruning(dist, { prefix: PUBLIC_TEST_SCENE_PREFIX });

    const gate = assertManifestResolves(dist);
    expect(gate.documents.map((d) => d.path))
      .toEqual(['DemoRealvirtualWeb.glb', 'DemoPlanner.glb']);
    expect(gate.start.path).toBe('DemoRealvirtualWeb.glb');
    // The sidecar travelled — F5's half of the same gate.
    expect(gate.sidecars).toEqual(['DemoRealvirtualWeb.settings.json']);
    expect(existsSync(join(dist, 'Turntable-Fixture.glb'))).toBe(false);
  });

  it('the --demo dist is held to the same rule, by the same helper', () => {
    // `--demo` differs from the public deploy only in its remote prefix; a
    // second, slightly weaker gate for it is exactly how one channel ends up
    // shipping what the other refuses.
    const dist = makeDeployDist('demo');
    applyPublicScenePruning(dist, { prefix: PUBLIC_TEST_SCENE_PREFIX });
    expect(() => assertManifestResolves(dist)).not.toThrow();
  });

  it('a dist whose manifest names a pruned MODEL fails the gate', () => {
    // The other prune. The allowlist deletes model files without touching the
    // manifest, so this is the case the source-tree assertion structurally
    // cannot see.
    const dist = makeDeployDist('pruned-model');
    applyPublicScenePruning(dist, { prefix: PUBLIC_TEST_SCENE_PREFIX });
    rmSync(join(dist, 'DemoRealvirtualWeb.glb'), { force: true });
    expect(() => assertManifestResolves(dist)).toThrow(/DemoRealvirtualWeb\.glb/);
  });

  it('a dist whose sidecar did not travel fails the gate', () => {
    const dist = makeDeployDist('no-sidecar');
    applyPublicScenePruning(dist, { prefix: PUBLIC_TEST_SCENE_PREFIX });
    rmSync(join(dist, 'DemoRealvirtualWeb.settings.json'), { force: true });
    expect(() => assertManifestResolves(dist)).toThrow(/did not travel/);
  });
});
