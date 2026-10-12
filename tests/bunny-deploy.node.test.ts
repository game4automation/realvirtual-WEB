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
  cpSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildUploadUrl,
  selectFilesToUpload,
  sanitizeDemoName,
  stageHostedProject,
  BunnyClient,
  loadConfig,
  normalizeRegion,
  buildEnvForMode,
  buildRemoteIndex,
  mimeType,
  ALWAYS_UPLOAD_FILES,
  isAlwaysUploadFile,
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
import { uploadDirectory, stageAndBuild } from '../scripts/bunny-deploy.mjs';
// @ts-expect-error — plan-487 helpers are not part of the declared module surface.
import { deployPublic, fastBuildForPublicTarget, runWithConcurrency, publishLockName, reportThirdPartyNotices } from '../scripts/bunny-deploy.mjs';
import { DEPLOY_PHASES, DEPLOY_PHASE_FILENAME, deployPhaseFilePath, reportDeployPhase } from '../scripts/bunny-deploy.mjs';
import { stageFilteredSourceTree, runBuild } from '../scripts/_workspace-lib.mjs';
// @ts-expect-error — plain JS Node module, no type declarations by design (plan-488).
import { acquirePublishLock } from '../scripts/rv-publish-lock.mjs';
import { randomBytes } from 'node:crypto';
import {
  BunnyClient as CdnClient,
  RV_EDGE_RULES,
  IMMUTABLE_CACHE_CONTROL,
  cacheControlForUrl,
  edgeRuleBody,
  manifestPreloadFor,
  withManifestPreload,
  injectManifestPreload,
  purgeUrlsFor,
  purgeDeployChanges,
  URL_PURGE_LIMIT,
  MANIFEST_PRELOAD_ATTR,
} from '../scripts/_bunny-lib.mjs';
import { maybePurge, reconcileRemoteSnapshot } from '../scripts/bunny-deploy.mjs';
import { execFileSync } from 'node:child_process';

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

// ─── 9.4 stageHostedProject (plan-759) ──────────────────────────────────

describe('stageHostedProject', () => {
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

    const staging = await stageHostedProject({ distDir: dist, projectDir: proj });
    try {
      expect(existsSync(join(staging, 'index.html'))).toBe(true);
      expect(existsSync(join(staging, 'assets', 'demo.glb'))).toBe(false);   // public glb removed
      expect(existsSync(join(staging, 'assets', 'index-abc.js'))).toBe(true); // other assets kept
      expect(existsSync(join(staging, 'p', 'models', 'machine.glb'))).toBe(true); // customer glb, own path
      expect(existsSync(join(staging, 'p', 'project.json'))).toBe(true);       // the manifest travels
      expect(existsSync(join(staging, 'models.json'))).toBe(false);            // no catalogue any more
      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.projectUrl).toBe('p/');
      expect(settings.projectAssetsPath).toBe('p/');
      expect(settings.defaultModel).toBeUndefined(); // D14: the root is the dashboard
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
    const staging = await stageHostedProject({
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
    const staging = await stageHostedProject({
      distDir: dist, projectDir: proj,
      encryption: { password: 'geheim-2027', fragmentSecret, iterations: 1000 },
    });
    try {
      // Same .glb name, but the body is now an RVE1 envelope (not the plaintext).
      const staged = readFileSync(join(staging, 'p', 'models', 'machine.glb'));
      expect(isEncryptedEnvelope(staged)).toBe(true);
      expect(staged.toString('utf8')).not.toContain('CUSTOMER');
      // settings.json advertises encryption and carries the key probe (plan-759 F5).
      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.encryption.enabled).toBe(true);
      expect(typeof settings.encryption.probe).toBe('string');
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

  // plan-737: this pass no longer writes models.json. The selector reads the
  // demo manifest directly, so a second derivation of the same set — which after
  // the folder move would also have carried the WRONG urls — was removed rather
  // than repointed. models.json survives only where it is genuinely the deploy
  // own statement about itself (stagePrivateProject / a foreign host).
  it('does not write a models.json — the manifest is the only catalogue', () => {
    const dist = makeDist();
    applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual' });
    expect(existsSync(join(dist, 'models.json'))).toBe(false);
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
    expect(existsSync(join(dist, 'models.json'))).toBe(false);
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
    // plan-487: only a 404 means "nothing remote yet"; every other failure now throws (9.5).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '', json: async () => [] })));
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

// ─── plan-737 9.5: the guards work from dist/demo-realvirtual/ ────────────

/**
 * The demo is a FOLDER in the deploy now, and all three public-demo guards had
 * to move with it. The failure they share if one is missed is silence: a guard
 * pointed at `dist/` finds no manifest, returns "nothing to check", and reports
 * success on a build it never looked at.
 *
 * The devOnly row is the load-bearing fixture here — it is the one thing that
 * MUST be deleted before upload, and both halves (file gone, row gone) have to
 * be resolved against the demo folder for it to happen at all.
 */
describe('the demo manifest bypasses the size diff wherever it lives (plan-737)', () => {
  // The rollback runbook (doc-deploy.md §"replace one file") only works if a
  // manifest edit is always re-uploaded. A curator's edit — renaming a
  // document, swapping the start document — routinely leaves the BYTE COUNT
  // untouched, so the size diff would skip exactly the upload that matters.
  //
  // The move into `demo-realvirtual/` is what makes this worth pinning: the
  // predicate matches on the BASENAME, so it survived the move for free — but
  // nothing said so, and `uploadDirectory` carried a second, hand-written
  // spelling of the rule that listed `settings|models|manifest` and omitted
  // `project.json` entirely.
  it('selects demo-realvirtual/project.json even when its size is unchanged', () => {
    expect(ALWAYS_UPLOAD_FILES.has('project.json')).toBe(true);
    expect(isAlwaysUploadFile('demo-realvirtual/project.json')).toBe(true);
    // …and the size-diff selection agrees, which is the behaviour that matters.
    const local = [
      { rel: 'demo-realvirtual/project.json', size: 512, abs: '/x/demo-realvirtual/project.json' },
      { rel: 'demo-realvirtual/DemoRealvirtualWeb.glb', size: 999, abs: '/x/demo-realvirtual/DemoRealvirtualWeb.glb' },
    ];
    // Keys are lowercased — that is the contract `buildRemoteIndex()` produces.
    const remote = new Map([
      ['demo-realvirtual/project.json', 512],
      ['demo-realvirtual/demorealvirtualweb.glb', 999],
    ]);
    const selected = selectFilesToUpload(local, remote, {});
    expect(selected.map(f => f.rel)).toEqual(['demo-realvirtual/project.json']);
  });
});

describe('public demo guards on the demo folder (plan-737)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvdemo737-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  /** A dist/ in the plan-737 shape: everything the demo owns inside its folder. */
  function makeFolderDist(): string {
    const dist = join(work, 'dist');
    const demo = join(dist, 'demo-realvirtual');
    mkdirSync(demo, { recursive: true });
    mkdirSync(join(dist, 'library', 'PalletHandling'), { recursive: true });
    for (const f of ['DemoRealvirtualWeb.glb', 'DemoPlanner.glb', 'Test-DES-Turntable-Loop.glb', 'Stray.glb']) {
      writeFileSync(join(demo, f), 'GLB');
    }
    writeFileSync(join(demo, 'DemoRealvirtualWeb.settings.json'), '{}');
    writeFileSync(join(dist, 'library', 'PalletHandling', 'Europallet.glb'), 'GLB');
    writeFileSync(join(demo, 'project.json'), JSON.stringify({
      schemaVersion: 2,
      id: 'prj_sample',
      name: 'DemoRealvirtual',
      kind: 'demo',
      settings: { defaultModel: 'DemoRealvirtualWeb.glb' },
      libraries: [{ url: 'library/catalog.json' }],
      documents: [
        { id: 'doc_a', name: 'Demo', path: 'DemoRealvirtualWeb.glb', settingsPath: 'DemoRealvirtualWeb.settings.json' },
        { id: 'doc_b', name: 'Planner', path: 'DemoPlanner.glb' },
        { id: 'doc_c', name: 'Turntable', path: 'Test-DES-Turntable-Loop.glb', devOnly: true },
      ],
    }, null, 2));
    return dist;
  }

  it('reads the allowlist from the demo folder manifest, root-level rows included', () => {
    // Both halves matter. Before plan-737 this function only accepted
    // `models/<file>` paths, so against a root-level demo manifest it returned
    // `[]` — and `[]` is not "no manifest", it is "keep nothing".
    expect(publicDemoModelAllowlist(makeFolderDist())?.sort()).toEqual([
      'DemoPlanner.glb', 'DemoRealvirtualWeb.glb', 'Test-DES-Turntable-Loop.glb',
    ]);
  });

  it('prunes inside the demo folder and leaves the app-level library alone', () => {
    const dist = makeFolderDist();
    const res = applyPublicModelAllowlist(dist, { keep: publicDemoModelAllowlist(dist)! });
    expect(res.dropped).toEqual(['Stray.glb']);
    expect(existsSync(join(dist, 'demo-realvirtual', 'Stray.glb'))).toBe(false);
    expect(existsSync(join(dist, 'demo-realvirtual', 'DemoRealvirtualWeb.glb'))).toBe(true);
    // The library is a SIBLING of the demo folder and app-level — never curated
    // by this pass, and never pruned by it.
    expect(existsSync(join(dist, 'library', 'PalletHandling', 'Europallet.glb'))).toBe(true);
  });

  it('prunes the devOnly row AND its file from inside the demo folder', () => {
    const dist = makeFolderDist();
    const res = applyPublicScenePruning(dist, { prefix: PUBLIC_TEST_SCENE_PREFIX });
    expect(res.dropped).toContain('Test-DES-Turntable-Loop.glb');
    expect(existsSync(join(dist, 'demo-realvirtual', 'Test-DES-Turntable-Loop.glb'))).toBe(false);
    const shipped = JSON.parse(readFileSync(join(dist, 'demo-realvirtual', 'project.json'), 'utf8'));
    expect(shipped.documents.map((d: { path: string }) => d.path))
      .toEqual(['DemoRealvirtualWeb.glb', 'DemoPlanner.glb']);
  });

  it('resolves manifest misses against the demo folder, and exempts the library', () => {
    const dist = makeFolderDist();
    applyPublicScenePruning(dist, { prefix: PUBLIC_TEST_SCENE_PREFIX });
    // A healthy build has no misses…
    expect(publicDemoManifestMisses(dist)).toEqual([]);
    // …and a document whose file did not travel is named.
    rmSync(join(dist, 'demo-realvirtual', 'DemoPlanner.glb'), { force: true });
    expect(publicDemoManifestMisses(dist)).toEqual(['DemoPlanner.glb']);
  });

  it('RV_PUBLIC_MODEL_PREFIX still works as the rollback lever on the new basis', () => {
    // doc-deploy.md's incident runbook: an operator overrides the manifest for
    // one deploy. The prefix has to keep matching the files where they now are.
    const dist = makeFolderDist();
    const res = applyPublicModelAllowlist(dist, { prefix: 'DemoRealvirtual' });
    expect(res.kept.sort()).toEqual(['DemoRealvirtualWeb.glb']);
    expect(res.dropped).toContain('Stray.glb');
  });
});

// ─── plan-487: upload ordering, pool, retry, listing, staging ────────────

/** A deploy dist that carries HTML — `makeDeployDist()` above has none, so it cannot
 *  witness the HTML-after-assets ordering. Returns the dist path. */
function makeDeployDistWithHtml(root: string, extraHtml: string[] = []): string {
  const dist = join(root, 'dist');
  const files: Record<string, string> = {
    'index.html': '<html></html>',
    'nested/index.html': '<html>nested</html>',
    'assets/index-a.js': 'a'.repeat(10),
    'assets/chunk-b.js': 'b'.repeat(20),
    'assets/style-c.css': 'c'.repeat(30),
    'models/DemoRealvirtualWeb.glb': 'GLB',
    'settings.json': '{}',
  };
  for (const rel of extraHtml) files[rel] = '<html>extra</html>';
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dist, rel, '..'), { recursive: true });
    writeFileSync(join(dist, rel), text);
  }
  return dist;
}

function countNonHtmlFiles(dist: string): number {
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (!entry.name.toLowerCase().endsWith('.html')) count++;
    }
  };
  walk(dist);
  return count;
}

describe('uploadDirectory — HTML ordering (plan-487 9.1)', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv487-order-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  it('starts html only after every asset upload has settled', async () => {
    const settled = new Set<string>();
    const pending = new Map<string, () => void>();
    let htmlStartWitness: { settled: number; expected: number } | null = null;
    let assetCount = 0;

    const client = {
      putFile: async (_bytes: Buffer, remotePath: string) => {
        if (remotePath.endsWith('.html')) {
          // The proof itself: taken at the moment HTML STARTS, not when it ends.
          htmlStartWitness ??= { settled: settled.size, expected: assetCount };
          return;
        }
        await new Promise<void>((release) => pending.set(remotePath, release));
        settled.add(remotePath);
      },
      deleteFile: async () => {},
      listRecursive: async () => [],
    };

    const dist = makeDeployDistWithHtml(work);
    assetCount = countNonHtmlFiles(dist);
    const run = uploadDirectory(client, dist, 'dev', { force: true, dryRun: false, alwaysUploadGlbs: false });

    // Released continuously: works sequentially (one gate at a time) AND in parallel
    // (several gates open at once).
    while (settled.size < assetCount) {
      await vi.waitFor(() => expect(pending.size).toBeGreaterThan(0));
      for (const [path, release] of [...pending]) { pending.delete(path); release(); }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await run;

    expect(htmlStartWitness).not.toBeNull();
    expect(htmlStartWitness!.settled).toBe(htmlStartWitness!.expected);
  });

  it('regression: index.html is uploaded at the last positions', async () => {
    const order: string[] = [];
    const client = {
      putFile: async (_bytes: Buffer, remotePath: string) => { order.push(remotePath); },
      deleteFile: async () => {},
      listRecursive: async () => [],
    };
    const dist = makeDeployDistWithHtml(work);
    await uploadDirectory(client, dist, 'dev', { force: true, dryRun: false, alwaysUploadGlbs: false });
    const htmlCount = 2;
    expect(order.slice(-htmlCount).every((p) => /index\.html$/.test(p))).toBe(true);
    expect(order.slice(0, -htmlCount).some((p) => /\.html$/.test(p))).toBe(false);
  });
});

describe('uploadDirectory — pool semantics (plan-487 9.1b, 9.2)', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv487-pool-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  it('uploads every *.html — not only index.html — after all assets have settled', async () => {
    const settled = new Set<string>();
    const htmlStarts: number[] = [];
    const client = {
      putFile: async (_bytes: Buffer, remotePath: string) => {
        if (remotePath.endsWith('.html')) { htmlStarts.push(settled.size); return; }
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled.add(remotePath);
      },
      deleteFile: async () => {},
      listRecursive: async () => [],
    };
    const dist = makeDeployDistWithHtml(work, ['help/about.html']);
    const assetCount = countNonHtmlFiles(dist);
    await uploadDirectory(client, dist, 'dev', { force: true, dryRun: false, alwaysUploadGlbs: false });
    expect(htmlStarts).toHaveLength(3);
    expect(htmlStarts.every((count) => count === assetCount)).toBe(true);
  });

  it('a final asset failure uploads no HTML, deletes nothing, and awaits the running uploads', async () => {
    const puts: string[] = [];
    const deletes: string[] = [];
    let slowFinished = false;
    const client = {
      putFile: async (_bytes: Buffer, remotePath: string) => {
        puts.push(remotePath);
        if (remotePath.endsWith('assets/index-a.js')) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          slowFinished = true;
          return;
        }
        if (remotePath.endsWith('assets/chunk-b.js')) throw new Error('HTTP 500 after retries');
      },
      deleteFile: async (path: string) => { deletes.push(path); },
      listRecursive: async () => [{ rel: 'assets/stale-old.js', size: 1, isDirectory: false }],
    };
    const dist = makeDeployDistWithHtml(work);
    await expect(uploadDirectory(client, dist, 'dev', { force: true, dryRun: false, alwaysUploadGlbs: false }))
      .rejects.toThrow(/Failed to upload assets\/chunk-b\.js/);
    expect(slowFinished).toBe(true);
    expect(puts.some((p) => p.endsWith('.html'))).toBe(false);
    expect(deletes).toEqual([]);
  });
});

describe('runWithConcurrency — count and byte budget (plan-487 9.3)', () => {
  it('never exceeds the worker limit and runs items in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('holds the byte budget, and an item heavier than the budget runs alone', async () => {
    let inFlight = 0;
    let bytes = 0;
    let peakBytesWithSmall = 0;
    let bigRanAlone = true;
    const items = [10, 10, 10, 10, 100, 10, 10];
    await runWithConcurrency(items, 8, async (size: number) => {
      inFlight++;
      bytes += size;
      if (size === 100 && inFlight !== 1) bigRanAlone = false;
      if (size !== 100 && bytes > 100) bigRanAlone = false;
      if (size !== 100) peakBytesWithSmall = Math.max(peakBytesWithSmall, bytes);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      bytes -= size;
    }, { weight: (size: number) => size, maxInflightBytes: 25 });
    expect(bigRanAlone).toBe(true);
    expect(peakBytesWithSmall).toBe(20);
  });

  it('starts nothing new after a failure and rejects only once the running workers settled', async () => {
    const started: number[] = [];
    let slowSettled = false;
    const run = runWithConcurrency([1, 2, 3, 4, 5], 2, async (n: number) => {
      started.push(n);
      if (n === 1) { await new Promise((resolve) => setTimeout(resolve, 30)); slowSettled = true; return; }
      if (n === 2) throw new Error('boom');
    });
    await expect(run).rejects.toThrow('boom');
    expect(slowSettled).toBe(true);
    expect(started).toEqual([1, 2]);
  });

  it('uploadDirectory holds RV_DEPLOY_CONCURRENCY and RV_DEPLOY_MAX_INFLIGHT_BYTES against real fetches', async () => {
    const work = mkdtempSync(join(tmpdir(), 'rv487-budget-'));
    const previous = { c: process.env.RV_DEPLOY_CONCURRENCY, b: process.env.RV_DEPLOY_MAX_INFLIGHT_BYTES };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const dist = join(work, 'dist');
      mkdirSync(join(dist, 'assets'), { recursive: true });
      for (let i = 0; i < 9; i++) writeFileSync(join(dist, 'assets', `chunk-${i}.js`), 'x'.repeat(10));
      writeFileSync(join(dist, 'assets', 'big.wasm'), 'w'.repeat(100));
      writeFileSync(join(dist, 'index.html'), '<html></html>');
      process.env.RV_DEPLOY_CONCURRENCY = '3';
      process.env.RV_DEPLOY_MAX_INFLIGHT_BYTES = '25';

      let inFlight = 0;
      let inFlightBytes = 0;
      let peakCount = 0;
      let peakSmallBytes = 0;
      let bigAlone = true;
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { method: string; body?: Buffer }): Promise<FetchReply> => {
        if (init.method === 'GET') return reply(404);
        const size = init.body?.length ?? 0;
        inFlight++;
        inFlightBytes += size;
        peakCount = Math.max(peakCount, inFlight);
        if (size === 100 && inFlight !== 1) bigAlone = false;
        if (size !== 100 && size > 0) peakSmallBytes = Math.max(peakSmallBytes, inFlightBytes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        inFlightBytes -= size;
        return reply(201);
      }));
      const client = new BunnyClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K' }) as unknown as LooseClient;
      const result = await uploadDirectory(client, dist, 'dev', { force: false, dryRun: false, alwaysUploadGlbs: false });
      expect(result.uploaded).toBe(11);
      expect(peakCount).toBeGreaterThan(1);
      expect(peakCount).toBeLessThanOrEqual(3);
      expect(peakSmallBytes).toBeLessThanOrEqual(25);
      expect(bigAlone).toBe(true);
    } finally {
      if (previous.c === undefined) delete process.env.RV_DEPLOY_CONCURRENCY; else process.env.RV_DEPLOY_CONCURRENCY = previous.c;
      if (previous.b === undefined) delete process.env.RV_DEPLOY_MAX_INFLIGHT_BYTES; else process.env.RV_DEPLOY_MAX_INFLIGHT_BYTES = previous.b;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('rejects a malformed RV_DEPLOY_CONCURRENCY before anything is listed or uploaded', async () => {
    const previous = process.env.RV_DEPLOY_CONCURRENCY;
    const work = mkdtempSync(join(tmpdir(), 'rv487-env-'));
    try {
      writeFileSync(join(work, 'index.html'), 'x');
      process.env.RV_DEPLOY_CONCURRENCY = 'eight';
      const listRecursive = vi.fn(async () => []);
      await expect(uploadDirectory({ listRecursive, putFile: async () => {}, deleteFile: async () => {} },
        work, 'dev', { force: true, dryRun: false, alwaysUploadGlbs: false })).rejects.toThrow(/RV_DEPLOY_CONCURRENCY/);
      expect(listRecursive).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.RV_DEPLOY_CONCURRENCY; else process.env.RV_DEPLOY_CONCURRENCY = previous;
      rmSync(work, { recursive: true, force: true });
    }
  });
});

type FetchReply = { ok: boolean; status: number; headers?: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> };
const reply = (status: number, body: unknown = [], headers: Record<string, string> = {}): FetchReply => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => { if (typeof body === 'string') throw new SyntaxError('Unexpected token'); return body; },
});
type LooseClient = {
  deleteFile(path: string): Promise<void>;
  listRecursive(path: string): Promise<Array<{ rel: string; size: number }>>;
  putFile(bytes: Buffer, path: string): Promise<void>;
};
function testClient(waits: number[]): LooseClient {
  const options = { region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K', sleep: async (ms: number) => { waits.push(ms); } };
  return new BunnyClient(options as ConstructorParameters<typeof BunnyClient>[0]) as unknown as LooseClient;
}

describe('BunnyClient retry for delete and listing (plan-487 9.4, 9.5)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('deleteFile tolerates a 503 and succeeds on the second attempt', async () => {
    const statuses = [503, 200];
    const fetchMock = vi.fn(async () => reply(statuses.shift()!));
    vi.stubGlobal('fetch', fetchMock);
    const waits: number[] = [];
    await testClient(waits).deleteFile('dev/assets/old.js');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
  });

  it('honours Retry-After on 429 instead of its own backoff', async () => {
    const statuses = [reply(429, '', { 'retry-after': '7' }), reply(201)];
    vi.stubGlobal('fetch', vi.fn(async () => statuses.shift()!));
    const waits: number[] = [];
    await testClient(waits).putFile(Buffer.from('x'), 'dev/a.js');
    expect(waits).toEqual([7000]);
  });

  it('deleteFile treats 404 as already deleted and gives up after three failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404)));
    await testClient([]).deleteFile('dev/gone.js');
    const fetchMock = vi.fn(async () => reply(400, 'Unable to delete file'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testClient([]).deleteFile('dev/legacy.glb')).rejects.toThrow(/Delete failed for dev\/legacy\.glb after 3 attempts: HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('listRecursive: 404 is an empty listing, a 500 throws after retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(404)));
    expect(await testClient([]).listRecursive('brand-new-prefix')).toEqual([]);
    const fetchMock = vi.fn(async () => reply(500, 'boom'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testClient([]).listRecursive('dev')).rejects.toThrow(/Listing dev failed after 3 attempts: HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('listRecursive: an auth failure throws at once, without retrying', async () => {
    const fetchMock = vi.fn(async () => reply(401, 'Unauthorized'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testClient([]).listRecursive('dev')).rejects.toThrow(/after 1 attempt: HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('listRecursive: invalid JSON and a non-array body throw, also in a nested folder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, 'not json')));
    await expect(testClient([]).listRecursive('dev')).rejects.toThrow(/invalid JSON/);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (/\/dev\/$/.test(String(url))
      ? reply(200, [{ ObjectName: 'assets', IsDirectory: true }])
      : reply(200, { error: 'nope' }))));
    await expect(testClient([]).listRecursive('dev')).rejects.toThrow(/Listing dev\/assets returned object instead of an array/);
  });
});

describe('same-size change outside ALWAYS_UPLOAD_FILES is skipped — known gap R6 (plan-487 9.6)', () => {
  it('a same-size catalog.json ships since plan-508 (it carries the asset hashes), like project.json', () => {
    const local = [
      { rel: 'library/catalog.json', size: 120, abs: '' },
      { rel: 'project.json', size: 80, abs: '' },
      { rel: 'library/Belt.glb', size: 500, abs: '' },
    ];
    const remote = new Map([['library/catalog.json', 120], ['project.json', 80], ['library/belt.glb', 500]]);
    const selected = selectFilesToUpload(local, remote, {});
    // The size-only diff (plan-487 R6) still skips a same-size binary that no catalog
    // hash flags — plan-508 closes that for catalogued files via `alwaysUploadRel`.
    expect(selected.map((f) => f.rel)).toEqual(['library/catalog.json', 'project.json']);
  });
});

describe('deployPublic — the real entry (plan-487 9.4, 9.7, 9.8)', () => {
  let work: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['RV_KEEP_STAGING', 'RV_SIGN_PRIVATE_KEY', 'RV_SEO', 'RV_PUBLIC_MODEL_PREFIX'];
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv487-entry-'));
    for (const key of envKeys) { saved[key] = process.env[key]; delete process.env[key]; }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Net guard: this block drives the REAL deploy entry, so a test that forgets to arrange
    // its remote reaches Bunny for real. There is no global network block (no `setupFiles`
    // in vitest.node.config.ts), so the guard lives here: every unstubbed `fetch` throws
    // with the way out in the message. A test that stubs `fetch` itself simply replaces
    // this one, and `afterEach`'s `vi.unstubAllGlobals()` already cleans up either way.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      throw new Error(`no network in tests: stub fetch explicitly, or use dryRun / skipProbe / a probe deps `
        + `(blocked ${init?.method ?? 'GET'} ${String(url)})`);
    }));
  });
  afterEach(() => {
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  const cfg = { storageZone: 'z', region: 'storage.bunnycdn.com', storageKey: 'K', accountKey: 'A', pullZoneId: '42', remotePath: '', googleAnalyticsId: '', newsApiUrl: '' };

  //! A staging stand-in: creates the workspace (as the real producer would) and records `fast`.
  function stagingStub(calls: Array<{ fast: boolean }>, withDist: boolean) {
    return (options: { fast: boolean }) => {
      calls.push({ fast: options.fast });
      const workspaceRoot = mkdtempSync(join(work, 'rv-customer-workspace-'));
      const distDir = join(workspaceRoot, 'realvirtual-web', 'dist');
      if (withDist) {
        mkdirSync(join(distDir, 'assets'), { recursive: true });
        writeFileSync(join(distDir, 'index.html'), '<html><head></head><body></body></html>');
        writeFileSync(join(distDir, 'assets', 'app-new.js'), 'console.log(1)');
      }
      return { workspaceRoot, distDir };
    };
  }
  const leftovers = () => readdirSync(work).filter((name) => name.startsWith('rv-customer-workspace-'));

  it('sets fast only for /dev and /demo-beta, never for /demo or --root', async () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ path: 'dev', demo: true }, true],
      [{ path: 'demo-beta', demo: true, base: '/demo-beta/' }, true],
      [{ path: 'demo', demo: true, base: '/demo/' }, false],
      [{ path: null, root: true }, false],
    ];
    for (const [opts, expected] of cases) {
      const calls: Array<{ fast: boolean }> = [];
      await expect(deployPublic(cfg, { ...opts }, { stageAndBuild: stagingStub(calls, false) }))
        .rejects.toThrow(/Filtered build output not found/);
      expect(calls).toEqual([{ fast: expected }]);
    }
    expect(fastBuildForPublicTarget('/dev/')).toBe(true);
    // Every one of those failures happened AFTER staging returned — the owner removed it.
    expect(leftovers()).toEqual([]);
  });

  it('a failing upload removes the staging directory; RV_KEEP_STAGING=1 keeps it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { method: string }) => (
      init.method === 'GET' ? reply(404) : reply(500, 'storage down'))));
    const sleep = async () => {};
    await expect(deployPublic(cfg, { path: 'dev', demo: true }, { stageAndBuild: stagingStub([], true), sleep }))
      .rejects.toThrow(/Failed to upload assets\/app-new\.js/);
    expect(leftovers()).toEqual([]);

    process.env.RV_KEEP_STAGING = '1';
    await expect(deployPublic(cfg, { path: 'dev', demo: true }, { stageAndBuild: stagingStub([], true), sleep }))
      .rejects.toThrow(/Failed to upload/);
    expect(leftovers()).toHaveLength(1);
  });

  it('a permanently failing stale delete is counted, does not abort, and the purge still runs', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string }) => {
      methods.push(`${init.method} ${String(url)}`);
      if (init.method === 'GET') {
        return /\/z\/dev\/$/.test(String(url))
          ? reply(200, [{ ObjectName: 'assets', IsDirectory: true }])
          : reply(200, [{ ObjectName: 'app-old.js', Length: 3, IsDirectory: false }]);
      }
      if (init.method === 'DELETE') return reply(400, 'Unable to delete file');
      return reply(init.method === 'PUT' ? 201 : 200);
    }));
    // The post-deploy probe (plan-508) would ask the real host; this test is about the delete path.
    // noSmoke: the post-deploy demo smoke (plan-503) has its own tests (bunny-deploy-smoke-gate).
    const probe = async () => ({ ok: true, findings: [], checks: [] });
    await deployPublic(cfg, { path: 'dev', demo: true, noSmoke: true }, { stageAndBuild: stagingStub([], true), sleep: async () => {}, probe });

    expect(methods.filter((m) => m.startsWith('DELETE'))).toHaveLength(3);
    expect(methods.some((m) => m === 'POST https://api.bunny.net/pullzone/42/purgeCache')).toBe(true);
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/1 stale file\(s\) could not be deleted/);
    expect(logged).toMatch(/all assets settled/);
    expect(leftovers()).toEqual([]);
  });
});

describe('staging leak — four failure sites (plan-487 9.8)', () => {
  let work: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['RV_KEEP_STAGING', 'TEMP', 'TMP', 'TMPDIR'];
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv487-leak-'));
    for (const key of envKeys) saved[key] = process.env[key];
    delete process.env.RV_KEEP_STAGING;
    // Redirect os.tmpdir() into the fixture, so the check never looks at (or touches) the
    // machine's real temp folder.
    process.env.TEMP = work; process.env.TMP = work; process.env.TMPDIR = work;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });
  const leftovers = () => readdirSync(work).filter((name) => name.startsWith('rv-customer-workspace-'));
  type StageAndBuild = (options: Record<string, unknown>, deps: Record<string, unknown>) => unknown;
  const stageWithDeps = stageAndBuild as unknown as StageAndBuild;
  const fakeStage = () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'rv-customer-workspace-'));
    return { workspaceRoot, coreRoot: join(workspaceRoot, 'realvirtual-web'), manifest: { rules: [] } };
  };
  const fakeBuild = (workspaceRoot: string) => ({ coreRoot: workspaceRoot, distDir: join(workspaceRoot, 'dist'), dryRun: false });

  it('copying: a failure inside stageFilteredSourceTree removes its own temp directory', () => {
    expect(tmpdir()).toBe(work);
    const staging = () => stageFilteredSourceTree({
      coreRoot: join(work, 'no-such-core'),
      privateRoot: join(work, 'no-such-private'),
      profile: { tier: 'core', restrictedFeatures: [] },
    });
    expect(staging).toThrow();
    expect(leftovers()).toEqual([]);
    process.env.RV_KEEP_STAGING = '1';
    expect(staging).toThrow();
    expect(leftovers()).toHaveLength(1);
  });

  const sites: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['tier check', { mode: 'demo' }, { assertTierLeak: () => { throw new Error('tier leak'); } }],
    ['build', { mode: 'demo' }, { assertTierLeak: () => {}, build: () => { throw new Error('vite failed'); } }],
    ['provenance', { mode: 'public' }, { build: fakeBuild, assertProvenance: () => { throw new Error('provenance mismatch'); } }],
  ];
  for (const [site, options, deps] of sites) {
    it(`${site}: stageAndBuild removes the staging directory the caller never received`, () => {
      expect(() => stageWithDeps(options, { stage: fakeStage, ...deps })).toThrow();
      expect(leftovers()).toEqual([]);
      process.env.RV_KEEP_STAGING = '1';
      expect(() => stageWithDeps(options, { stage: fakeStage, ...deps })).toThrow();
      expect(leftovers()).toHaveLength(1);
    });
  }

  it('the success path hands the directory over and forwards fast to the build', () => {
    let seenFast: unknown = null;
    const result = stageWithDeps({ mode: 'public', fast: true }, {
      stage: fakeStage,
      build: (root: string, opts: { fast: boolean }) => { seenFast = opts.fast; return { ...fakeBuild(root), cacheStatus: 'hit', cacheMethod: 'link', profileKey: 'abcdef123' }; },
      assertProvenance: () => {},
    }) as { workspaceRoot: string };
    expect(seenFast).toBe(true);
    expect(existsSync(result.workspaceRoot)).toBe(true);
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/build-cache.*hit/);
  });
});

// ─── hosted-link customers — staged from the register, no git delivery ─────

describe('stageAndBuild — hosted-link customer', () => {
  type StageAndBuild = (options: Record<string, unknown>, deps: Record<string, unknown>) => unknown;
  const stageWithDeps = stageAndBuild as unknown as StageAndBuild;
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv-hosted-link-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });
  const run = (owner: unknown) => {
    const staged: Record<string, unknown>[] = [];
    stageWithDeps({ mode: 'private', projectDir: join(work, 'private', 'projects', 'Kitchen'), dryRun: true }, {
      resolveOwner: () => owner,
      stage: (options: Record<string, unknown>) => {
        staged.push(options);
        return { workspaceRoot: work, coreRoot: join(work, 'realvirtual-web'), manifest: { rules: [] } };
      },
      build: (root: string) => ({ coreRoot: root, distDir: join(root, 'dist'), dryRun: true }),
      assertProvenance: () => {},
    });
    return staged[0];
  };

  it('takes tier, entitlements and project from the register and writes no workspace files', () => {
    const options = run({
      customer: 'kitchen', kind: 'development',
      delivery: { channel: 'hosted-link', tier: 'commercial', restrictedFeatures: ['agents'], projects: ['Kitchen'] },
    });
    expect(options.projectKey).toBe('Kitchen');
    expect(options.profile).toMatchObject({ tier: 'commercial', restrictedFeatures: ['agents'] });
    expect(options.delivery).toMatchObject({ customer: 'kitchen', channel: 'hosted-link', projects: ['Kitchen'] });
    expect(options.workspaceFiles).toBe(false);
  });

  it('a git-workspace customer still resolves through its delivery config', () => {
    // loadDeliveryConfig is not stubbed: with no register in the fixture it throws, which proves
    // the git-workspace owner was NOT short-circuited by the hosted-link branch.
    expect(() => run({
      customer: 'repo', kind: 'development',
      delivery: { channel: 'git-workspace', tier: 'commercial', restrictedFeatures: [], projects: ['Kitchen'] },
    })).toThrow();
  });
});

// ─── plan-488 §9 A — the publish lock inside deployPublic ──────────────────

describe.skipIf(process.platform !== 'win32')('deployPublic — publish lock (plan-488 §9 A)', () => {
  type Lock = { name: string; release(): Promise<void> };
  type Acquire = (name: string, options?: Record<string, unknown>) => Promise<Lock>;
  const acquire = acquirePublishLock as Acquire;
  type Deploy = (cfg: Record<string, unknown>, opts: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<void>;
  // The post-deploy probe (plan-508) would GET the public host through the stubbed fetch and
  // add requests to `events`; these tests are about the lock window, so it answers "ok".
  // noSmoke by default: the post-deploy demo smoke (plan-503, inside the same lock) has its
  // own tests in bunny-deploy-smoke-gate.node.test.ts.
  const okProbe = async () => ({ ok: true, findings: [], checks: [] });
  const deploy: Deploy = (cfg, opts, deps) => (deployPublic as Deploy)(cfg, { noSmoke: true, ...opts }, { probe: okProbe, ...deps });
  const lockName = publishLockName as (zone: string, prefix: string) => string;

  let work: string;
  // A zone name unique to this run: the lock names derived from it can never meet a real
  // `rv-publish-<zone>:…` lock of a deploy running on this machine.
  let zone: string;
  let cfg: Record<string, string>;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['RV_KEEP_STAGING', 'RV_SIGN_PRIVATE_KEY', 'RV_SEO', 'RV_PUBLIC_MODEL_PREFIX', 'RV_SEO_CANONICAL_PATH',
    'RV_DEPLOY_LOCK_TIMEOUT_SECONDS', 'RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS', 'RV_DEPLOY_LOCK'];
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'rv488-lock-'));
    zone = `z488-${process.pid}-${randomBytes(4).toString('hex')}`;
    cfg = { storageZone: zone, region: 'storage.bunnycdn.com', storageKey: 'K', accountKey: 'A', pullZoneId: '42', remotePath: '', googleAnalyticsId: '', newsApiUrl: '' };
    for (const key of envKeys) { saved[key] = process.env[key]; delete process.env[key]; }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  //! Staging stand-in producing a dist whose index.html references exactly one asset.
  function staging(asset: string) {
    return () => {
      const workspaceRoot = mkdtempSync(join(work, 'rv-customer-workspace-'));
      const distDir = join(workspaceRoot, 'realvirtual-web', 'dist');
      mkdirSync(join(distDir, 'assets'), { recursive: true });
      writeFileSync(join(distDir, 'index.html'), `<html><head></head><body><script src="assets/${asset}"></script></body></html>`);
      writeFileSync(join(distDir, 'assets', asset), `console.log(${JSON.stringify(asset)})`);
      return { workspaceRoot, distDir };
    };
  }

  //! An in-memory storage zone behind a stubbed fetch. `fail(method, path)` returns an HTTP
  //! status to answer instead, or null. `events` records every request in order.
  function storage(fail: (method: string, path: string) => number | null = () => null) {
    const files = new Map<string, string>();
    const events: string[] = [];
    const host = `https://storage.bunnycdn.com/${zone}/`;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string; body?: Buffer }) => {
      const u = String(url);
      if (u.startsWith('https://api.bunny.net/')) {
        // plan-598: the API host also answers the edge-rule calls (GET the pull
        // zone, addOrUpdate) — recorded apart, so PURGE still means a purge.
        const apiPath = u.slice('https://api.bunny.net/'.length).split('?')[0];
        if (/^pullzone\/[^/]+(\/edgerules\/addOrUpdate)?$/.test(apiPath)) {
          events.push('EDGE');
          return reply(200, apiPath.includes('edgerules') ? {} : { EdgeRules: [] });
        }
        events.push('PURGE');
        const status = fail('PURGE', '');
        if (status === -1) throw new Error('network down');
        return reply(status ?? 200);
      }
      const path = decodeURIComponent(u.slice(host.length));
      events.push(`${init.method} ${path}`);
      const status = fail(init.method, path);
      if (status !== null) return reply(status, 'injected failure');
      if (init.method === 'GET') {
        const dir = path;
        const children = new Map<string, { ObjectName: string; IsDirectory: boolean; Length: number }>();
        for (const [key, content] of files) {
          if (!key.startsWith(dir)) continue;
          const rest = key.slice(dir.length);
          const [head, ...tail] = rest.split('/');
          children.set(head, tail.length ? { ObjectName: head, IsDirectory: true, Length: 0 } : { ObjectName: head, IsDirectory: false, Length: content.length });
        }
        return children.size ? reply(200, [...children.values()]) : reply(404);
      }
      if (init.method === 'PUT') { files.set(path, String(init.body ?? '')); return reply(201); }
      if (init.method === 'DELETE') { files.delete(path); return reply(200); }
      return reply(200);
    }));
    return { files, events };
  }

  const fetchCalls = () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  const lockIsFree = async (prefix: string) => {
    const lock = await acquire(lockName(zone, prefix), { timeoutMs: 0 });
    await lock.release();
    return true;
  };
  const noSleep = async () => {};

  it('names the lock rv-publish-<zone>:<prefix> — /dev and /demo are different locks', () => {
    expect(lockName('realvitual-web', '/dev/')).toBe('rv-publish-realvitual-web:dev');
    expect(lockName('Zone', 'Demo')).toBe('rv-publish-zone:demo');
    expect(lockName('zone', '')).toBe('rv-publish-zone:');
  });

  it('a successful deploy holds the lock from before the listing to after the purge', async () => {
    const { events } = storage();
    const deps = {
      stageAndBuild: staging('app-a.js'),
      sleep: noSleep,
      acquireLock: async (name: string, options: Record<string, unknown>) => {
        const lock = await acquire(name, options);
        events.push('LOCKED');
        return { name, release: async () => { events.push('RELEASED'); await lock.release(); } };
      },
    };
    await deploy(cfg, { path: 'dev', demo: true }, deps);
    expect(events[0]).toBe('LOCKED');
    expect(events[1]).toBe('GET dev/');
    expect(events.at(-2)).toBe('PURGE');
    expect(events.at(-1)).toBe('RELEASED');
    expect(await lockIsFree('dev')).toBe(true);
  });

  const failurePaths: Array<[string, string, Record<string, unknown>, (method: string, path: string) => number | null, RegExp | null]> = [
    ['listing', 'dev', { path: 'dev', demo: true }, (m, p) => (m === 'GET' && p === 'dev/' ? 500 : null), /Listing .* failed/],
    ['upload', 'dev', { path: 'dev', demo: true }, (m) => (m === 'PUT' ? 500 : null), /Failed to upload/],
    ['root robots.txt (/demo, SEO canonical)', 'demo', { path: 'demo', demo: true, base: '/demo/' }, (m, p) => (m === 'PUT' && p === 'robots.txt' ? 500 : null), /Upload failed/],
    ['purge (HTTP 500 — non-fatal)', 'dev', { path: 'dev', demo: true }, (m) => (m === 'PURGE' ? 500 : null), null],
    ['purge (network error — non-fatal)', 'dev', { path: 'dev', demo: true }, (m) => (m === 'PURGE' ? -1 : null), null],
    ['--no-purge', 'dev', { path: 'dev', demo: true, noPurge: true }, () => null, null],
  ];
  for (const [label, prefix, opts, fail, error] of failurePaths) {
    it(`releases the lock on the ${label} path — a new acquisition succeeds afterwards`, async () => {
      const { events } = storage(fail);
      const run = deploy(cfg, { ...opts }, { stageAndBuild: staging('app-a.js'), sleep: noSleep });
      if (error) await expect(run).rejects.toThrow(error);
      else await run;
      if (label.startsWith('root robots')) expect(events).toContain('PUT robots.txt');
      if (label === '--no-purge') expect(events).not.toContain('PURGE');
      expect(await lockIsFree(prefix)).toBe(true);
    });
  }

  it('a lock that stays busy aborts BEFORE any remote access (RV_DEPLOY_LOCK_TIMEOUT_SECONDS)', async () => {
    storage();
    const held = await acquire(lockName(zone, 'dev'), { timeoutMs: 0 });
    try {
      process.env.RV_DEPLOY_LOCK_TIMEOUT_SECONDS = '0';
      await expect(deploy(cfg, { path: 'dev', demo: true }, { stageAndBuild: staging('app-a.js'), sleep: noSleep }))
        .rejects.toThrow(/held by another process/);
      expect(fetchCalls()).toBe(0);

      process.env.RV_DEPLOY_LOCK_TIMEOUT_SECONDS = '1';
      const started = Date.now();
      await expect(deploy(cfg, { path: 'dev', demo: true }, { stageAndBuild: staging('app-a.js'), sleep: noSleep, lockPollMs: 100 }))
        .rejects.toThrow(/held by another process/);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(fetchCalls()).toBe(0);
      const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(`waiting for publish lock ${lockName(zone, 'dev')}`);
    } finally {
      await held.release();
    }
  });

  it('a staging/build overrun ends the deploy before the lock and before any remote access (plan-488 §2.8)', async () => {
    storage();
    process.env.RV_DEPLOY_PREPUBLISH_TIMEOUT_SECONDS = '900';
    const clock = [0, 16 * 60 * 1000];
    const acquireLock = vi.fn(acquire);
    await expect(deploy(cfg, { path: 'dev', demo: true }, {
      stageAndBuild: staging('app-a.js'), sleep: noSleep, now: () => clock.shift() ?? 16 * 60 * 1000, acquireLock,
    })).rejects.toThrow(/over the limit of 900 s/);
    expect(acquireLock).not.toHaveBeenCalled();
    expect(fetchCalls()).toBe(0);
    expect(await lockIsFree('dev')).toBe(true);
  });

  it('rejects a malformed RV_DEPLOY_LOCK_TIMEOUT_SECONDS before any remote access', async () => {
    storage();
    process.env.RV_DEPLOY_LOCK_TIMEOUT_SECONDS = 'soon';
    await expect(deploy(cfg, { path: 'dev', demo: true }, { stageAndBuild: staging('app-a.js'), sleep: noSleep }))
      .rejects.toThrow(/RV_DEPLOY_LOCK_TIMEOUT_SECONDS/);
    expect(fetchCalls()).toBe(0);
  });

  it('interleaving: two concurrent deploys to /dev never overlap — the second lists only after the first purged', async () => {
    const { files, events } = storage();
    const tagged = (tag: string) => async (name: string, options: Record<string, unknown>) => {
      const lock = await acquire(name, { ...options, pollMs: 20 });
      events.push(`${tag}:LOCKED`);
      return { name, release: async () => { events.push(`${tag}:RELEASED`); await lock.release(); } };
    };
    await Promise.all([
      deploy(cfg, { path: 'dev', demo: true }, { stageAndBuild: staging('app-a.js'), sleep: noSleep, acquireLock: tagged('A') }),
      deploy(cfg, { path: 'dev', demo: true }, { stageAndBuild: staging('app-b.js'), sleep: noSleep, acquireLock: tagged('B') }),
    ]);

    // Every remote request sits inside exactly one lock window, and the windows do not overlap.
    let owner: string | null = null;
    const windows: string[] = [];
    for (const event of events) {
      const marker = /^([AB]):(LOCKED|RELEASED)$/.exec(event);
      if (marker) {
        if (marker[2] === 'LOCKED') { expect(owner).toBeNull(); owner = marker[1]; windows.push(owner); }
        else { expect(owner).toBe(marker[1]); owner = null; }
        continue;
      }
      expect(owner, `request outside a lock window: ${event}`).not.toBeNull();
    }
    expect(windows.sort()).toEqual(['A', 'B']);
    const firstWindowEnd = events.findIndex((e) => /:RELEASED$/.test(e));
    const secondListing = events.findIndex((e, i) => i > firstWindowEnd && e === 'GET dev/');
    expect(events.slice(0, firstWindowEnd).lastIndexOf('PURGE')).toBeGreaterThan(-1);
    expect(secondListing).toBeGreaterThan(firstWindowEnd);

    // The final state is consistent: index.html references an asset that exists.
    const html = files.get('dev/index.html') ?? '';
    const referenced = /src="(assets\/[^"]+)"/.exec(html)?.[1];
    expect(referenced).toBeTruthy();
    expect(files.has(`dev/${referenced}`)).toBe(true);
    expect(await lockIsFree('dev')).toBe(true);
  });

  it('/dev and /demo do not block each other', async () => {
    storage();
    const heldDemo = await acquire(lockName(zone, 'demo'), { timeoutMs: 0 });
    try {
      process.env.RV_DEPLOY_LOCK_TIMEOUT_SECONDS = '0';
      await deploy(cfg, { path: 'dev', demo: true }, { stageAndBuild: staging('app-a.js'), sleep: noSleep });
    } finally {
      await heldDemo.release();
    }
    const heldDev = await acquire(lockName(zone, 'dev'), { timeoutMs: 0 });
    try {
      process.env.RV_SEO = '0';
      await deploy(cfg, { path: 'demo', demo: true, base: '/demo/' }, { stageAndBuild: staging('app-a.js'), sleep: noSleep });
    } finally {
      await heldDev.release();
    }
  });
});

// ─── Build metadata handed to the staged build (version line) ────────────
//
// A deploy does not compile the repository, it compiles a FILTERED STAGING TREE — and that
// tree carries no `.git`. vite.config.ts asks git for build number, commit and commit date,
// so every one of those calls fell back there and the delivered bundle claimed "web build 0"
// with no commit and today's date instead of the commit's. runBuild() closes that gap: it
// reads the values in the SOURCE repository and hands them to the build as environment.

describe('build metadata for the staged build', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-build-meta-')); });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(work, { recursive: true, force: true });
  });

  //! The smallest thing runBuild() accepts as a workspace, plus a runner that records the
  //! environment the build was actually given (rather than what runBuild intended).
  function stagedWorkspace() {
    const workspaceRoot = join(work, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"staged-fixture","version":"1.0.0"}');
    writeFileSync(join(workspaceRoot, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    const envs: Record<string, string | undefined>[] = [];
    const npmRunner = (args: string[], options: { cwd: string; env?: Record<string, string | undefined> }) => {
      if (args.join(' ') === 'run build') {
        envs.push({ ...(options.env ?? {}) });
        mkdirSync(join(options.cwd, 'dist'), { recursive: true });
        writeFileSync(join(options.cwd, 'dist', 'app.js'), 'built');
      }
    };
    return { workspaceRoot, envs, npmRunner };
  }

  //! A throwaway git repository with exactly one commit — the stand-in for the source checkout.
  function gitSourceRepo() {
    const root = join(work, 'source');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), 'fixture source repo');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', [
      '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture commit',
    ], { cwd: root });
    return root;
  }

  const clearInheritedMetadata = () => {
    for (const key of ['RV_WEB_BUILD', 'RV_COMMIT', 'RV_BUILD_DATE', 'RV_BUILD_TIME']) vi.stubEnv(key, '');
  };

  it('passes build number, commit, commit date and build time from the SOURCE repo', () => {
    const { workspaceRoot, envs, npmRunner } = stagedWorkspace();
    const sourceRoot = gitSourceRepo();
    clearInheritedMetadata();

    runBuild(workspaceRoot, { npmRunner, sourceRoot });

    expect(envs).toHaveLength(1);
    const env = envs[0];
    const git = (args: string[]) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
    expect(env.RV_WEB_BUILD).toBe(git(['rev-list', '--count', 'HEAD']));
    expect(env.RV_COMMIT).toBe(git(['rev-parse', '--short', 'HEAD']));
    expect(env.RV_BUILD_DATE).toBe(git(['log', '-1', '--format=%cd', '--date=short']));
    // Local time to the minute — no seconds and no time-zone suffix.
    expect(env.RV_BUILD_TIME).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('passes only the build time when the source root is not a git repository', () => {
    const { workspaceRoot, envs, npmRunner } = stagedWorkspace();
    const sourceRoot = join(work, 'not-a-repo');
    mkdirSync(sourceRoot, { recursive: true });
    clearInheritedMetadata();

    runBuild(workspaceRoot, { npmRunner, sourceRoot });

    const env = envs[0];
    expect(env.RV_BUILD_TIME).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // Nothing invented: without git the three git-derived values stay absent, and
    // vite.config.ts falls back exactly as it did before this change.
    expect(env.RV_WEB_BUILD).toBeFalsy();
    expect(env.RV_COMMIT).toBeFalsy();
    expect(env.RV_BUILD_DATE).toBeFalsy();
  });

  it('keeps a metadata value the caller already set in the environment', () => {
    const { workspaceRoot, envs, npmRunner } = stagedWorkspace();
    const sourceRoot = gitSourceRepo();
    vi.stubEnv('RV_WEB_BUILD', '9999');
    vi.stubEnv('RV_BUILD_TIME', '2026-09-17 21:34');

    runBuild(workspaceRoot, { npmRunner, sourceRoot });

    const env = envs[0];
    expect(env.RV_WEB_BUILD).toBe('9999');
    expect(env.RV_BUILD_TIME).toBe('2026-09-17 21:34');
    // What nobody pinned still comes from the repository.
    expect(env.RV_COMMIT).toBe(
      execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
    );
  });
});

/**
 * Every relative import of a staged core script resolves inside the staged tree.
 *
 * plan-508 made `build-local-library-catalog.mjs` import `./lib/rv-hash.mjs`, but
 * the staging copies scripts only from the allowlist `CORE_SCRIPT_FILES` in
 * `_workspace-lib.mjs`, which nobody extended — so every public deploy (release,
 * /demo, the /dev watcher) died in the staged build with ERR_MODULE_NOT_FOUND.
 * This stages the REAL scripts of the repository through the REAL staging and
 * follows each relative `import` / `export … from` recursively, so the next
 * forgotten helper fails here and not in the deploy.
 *
 * The walk also starts at the staged ROOT configs (`CORE_FILES`: `vite.config.ts`,
 * `vitest.node.config.ts`, …) and follows their `./scripts/…` imports: plan-508 made
 * `vite.config.ts` import `./scripts/lib/rv-fs.mjs`, and the second hotfix found the
 * staged `vite build` dying on exactly that edge after the first one was fixed.
 */
describe('staged core scripts carry their relative imports (plan-508 hotfix)', () => {
  const REPO = resolve(__dirname, '..');
  const RELATIVE_SPECIFIERS = [
    /\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g,
    /\bimport\s*['"](\.\.?\/[^'"]+)['"]/g,
  ];
  // Root files the staging copies (CORE_FILES) that can import from scripts/.
  const ROOT_CONFIGS = ['vite.config.ts', 'vitest.config.ts', 'vitest.node.config.ts'];
  let work: string;
  let stagedRoot: string | null = null;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvstage-scripts-')); });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    if (stagedRoot) rmSync(stagedRoot, { recursive: true, force: true });
    stagedRoot = null;
  });

  function relativeImports(file: string): string[] {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const found: string[] = [];
    for (const pattern of RELATIVE_SPECIFIERS) {
      for (const match of code.matchAll(pattern)) found.push(match[1]);
    }
    return found;
  }

  function mjsFilesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) mjsFilesUnder(path, out);
      else if (entry.name.endsWith('.mjs')) out.push(path);
    }
    return out;
  }

  it('every file a staged script imports by a relative path is staged too', () => {
    const core = join(work, 'core');
    const privateRoot = join(work, 'private');
    mkdirSync(privateRoot, { recursive: true });
    const write = (path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(core, 'src', 'main.ts'), 'export {};');
    write(join(core, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: {} } }));
    write(join(core, 'recipes', 'kinematize-cad-import.md'), '# recipe fixture\n');
    write(join(core, 'public', 'settings.json'), '{}');
    // The real scripts/ tree, so the allowlist is checked against what the scripts
    // actually import today, not against a fixture that agrees with it by design.
    cpSync(join(REPO, 'scripts'), join(core, 'scripts'), { recursive: true });
    // The real root configs too: vite.config.ts reaches into scripts/ at config-load time.
    for (const name of ROOT_CONFIGS) {
      if (existsSync(join(REPO, name))) cpSync(join(REPO, name), join(core, name));
    }

    const staged = stageFilteredSourceTree({
      coreRoot: core,
      privateRoot,
      profile: { tier: 'core', restrictedFeatures: [] },
      includePublicDemoContent: true,
    });
    stagedRoot = staged.workspaceRoot;

    const stagedScripts = join(staged.coreRoot, 'scripts');
    const queue = mjsFilesUnder(stagedScripts);
    expect(queue.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    const missing: string[] = [];
    let followed = 0;
    // Staged root configs: only their ./scripts/ edges are checked here — src/ is a
    // fixture stub in this test, and the staging copies src/ wholesale anyway.
    const stagedRootConfigs = ROOT_CONFIGS.filter((name) => existsSync(join(staged.coreRoot, name)));
    expect(stagedRootConfigs).toContain('vite.config.ts');
    for (const name of stagedRootConfigs) {
      for (const specifier of relativeImports(join(staged.coreRoot, name))) {
        if (!specifier.startsWith('./scripts/')) continue;
        followed++;
        const target = resolve(staged.coreRoot, specifier);
        if (!existsSync(target)) missing.push(`${name} -> ${specifier}`);
        else if (/.m?js$/.test(target)) queue.push(target);
      }
    }
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of relativeImports(file)) {
        followed++;
        const target = resolve(dirname(file), specifier);
        if (!existsSync(target)) {
          missing.push(`${file.slice(staged.coreRoot.length + 1)} -> ${specifier}`);
        } else if (/\.m?js$/.test(target)) {
          queue.push(target);
        }
      }
    }
    expect(missing).toEqual([]);
    // Not vacuous: build-local-library-catalog.mjs -> ./lib/rv-hash.mjs is followed.
    expect(followed).toBeGreaterThan(0);
    expect(existsSync(join(stagedScripts, 'lib', 'rv-hash.mjs'))).toBe(true);
    // And vite.config.ts -> ./scripts/lib/rv-fs.mjs (plan-508, second hotfix).
    expect(existsSync(join(stagedScripts, 'lib', 'rv-fs.mjs'))).toBe(true);
  });
});

/**
 * plan-551 F17: `scripts/lib/rv-cinematic-frames.mjs` re-exports the shared cinematic manifest
 * module from `src/core/engine/rv-cinematic-manifest.mjs` — the first `scripts → src` edge.
 * The staging copies `src/` wholesale, so such an edge resolves in a staged workspace as long as
 * its target exists and stays self-contained (no imports of its own that would drag a script-only
 * or Node-only module into the browser bundle). The CLI that uses it (`rv-record-video.mjs`) is
 * not part of `CORE_SCRIPT_FILES`, i.e. not staged into customer workspaces at all.
 */
describe('scripts → src edges (plan-551 F17)', () => {
  const REPO = resolve(__dirname, '..');
  const SCRIPTS = join(REPO, 'scripts');
  const SPECIFIER = /\b(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g;

  function scriptFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') scriptFiles(path, out); }
      else if (/\.m?js$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  it('every script import into src/ resolves to a self-contained module', () => {
    const edges: string[] = [];
    const problems: string[] = [];
    for (const file of scriptFiles(SCRIPTS)) {
      const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const match of code.matchAll(SPECIFIER)) {
        // A specifier inside a template literal is GENERATED code for another tree
        // (`_workspace-lib.mjs` writes the customer workspace's imports), not an import of
        // this script — in a staged tree named `realvirtual-web` it would resolve into src/.
        const lineStart = code.lastIndexOf('\n', match.index) + 1;
        if (code.slice(lineStart, match.index).includes('`')) continue;
        const target = resolve(dirname(file), match[1]);
        if (!target.startsWith(join(REPO, 'src'))) continue;
        const edge = `${file.slice(REPO.length + 1)} -> ${target.slice(REPO.length + 1)}`.replace(/\\/g, '/');
        edges.push(edge);
        if (!existsSync(target)) { problems.push(`${edge}: missing`); continue; }
        const targetCode = readFileSync(target, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/^\s*import\s|\brequire\(/m.test(targetCode)) problems.push(`${edge}: the target imports other modules`);
      }
    }
    expect(problems).toEqual([]);
    expect(edges).toContain('scripts/lib/rv-cinematic-frames.mjs -> src/core/engine/rv-cinematic-manifest.mjs');
  });

  it('the record CLI and its frames adapter are not staged into customer workspaces', () => {
    const lib = readFileSync(join(SCRIPTS, '_workspace-lib.mjs'), 'utf8');
    const list = /const CORE_SCRIPT_FILES = \[([\s\S]*?)\];/.exec(lib)?.[1] ?? '';
    expect(list).not.toBe('');
    expect(list).not.toMatch(/rv-record-video|rv-cinematic-frames/);
  });
});

// plan-544 F11: every deploy reports the notices' mode and prints a loud banner in warn mode or
// when the notices are missing — the gate itself lives in the build.
describe('reportThirdPartyNotices (plan-544)', () => {
  let dist: string;
  beforeEach(() => { dist = mkdtempSync(join(tmpdir(), 'rv-notices-report-')); });
  afterEach(() => { rmSync(dist, { recursive: true, force: true }); });
  const capture = () => { const lines: string[] = []; return { lines, log: (m: string) => lines.push(m) }; };

  it('prints a banner in warn mode', () => {
    writeFileSync(join(dist, 'THIRD-PARTY-NOTICES.txt'), 'x');
    writeFileSync(join(dist, 'third-party-notices.json'), JSON.stringify({ mode: 'warn', violations: [{}, {}] }));
    const out = capture();
    const result = reportThirdPartyNotices(dist, out);
    expect(result.mode).toBe('warn');
    expect(out.lines.join('\n')).toMatch(/WARN mode[\s\S]*violations: 2/);
  });

  it('stays quiet in enforce mode', () => {
    writeFileSync(join(dist, 'THIRD-PARTY-NOTICES.txt'), 'x');
    writeFileSync(join(dist, 'third-party-notices.json'), JSON.stringify({ mode: 'enforce', violations: [] }));
    const out = capture();
    expect(reportThirdPartyNotices(dist, out).banner).toBeNull();
    expect(out.lines.join('\n')).toMatch(/enforce mode/);
  });

  it('reports missing notices loudly', () => {
    const out = capture();
    expect(reportThirdPartyNotices(dist, out).banner).toMatch(/MISSING/);
  });
});

describe('bunny-deploy — phase reporting for the watcher deadline (plan-587 F4)', () => {
  let base: string;
  const ENV_KEY = 'RV_DEPLOY_PHASE_FILE';

  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'rv-deploy-phase-')); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('Test_DeployPhaseFilePath_EnvWinsOverTheTmpDir', () => {
    // The child runs from a CLONE, which has no workspace root of its own, so the watcher names
    // the path. If this precedence ever flips, the two sides write and read different files and
    // the deadline silently loses its verdict.
    const explicit = join(base, 'watcher-owned.json');
    expect(deployPhaseFilePath({ [ENV_KEY]: explicit })).toBe(explicit);
    expect(deployPhaseFilePath({ [ENV_KEY]: '   ' })).toMatch(new RegExp(`${DEPLOY_PHASE_FILENAME}$`));
    expect(deployPhaseFilePath({})).toMatch(new RegExp(`${DEPLOY_PHASE_FILENAME}$`));
  });

  it('Test_ReportDeployPhase_WritesPhaseAndTimestamp', () => {
    const path = join(base, 'sub', 'deploy-phase.json');
    expect(reportDeployPhase('upload', { path, now: () => 1_700_000_000_000 })).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ phase: 'upload', at: 1_700_000_000_000 });
  });

  it('Test_ReportDeployPhase_IsAtomic_TmpThenRename', () => {
    // A torn read would give the reader `{ phase: 'bu` — it degrades to the conservative
    // no-kill case today, but a half record is a bug waiting for a different reader. So: write
    // to a temp file, THEN rename. Proved by watching the calls, because the race itself is not
    // observable from a single-threaded test.
    const order: string[] = [];
    const path = join(base, 'deploy-phase.json');
    reportDeployPhase('published', {
      path,
      now: () => 1,
      fs: {
        mkdirSync: () => { order.push('mkdir'); return undefined; },
        writeFileSync: (target: string) => { order.push(`write ${String(target).endsWith('.tmp') ? 'tmp' : 'TARGET'}`); },
        renameSync: (from: string, to: string) => { order.push(`rename ${String(from).endsWith('.tmp') ? 'tmp' : '?'} -> ${to === path ? 'target' : '?'}`); },
      },
    });
    expect(order).toEqual(['mkdir', 'write tmp', 'rename tmp -> target']);
  });

  it('Test_ReportDeployPhase_NeverThrows', () => {
    // This is bookkeeping for somebody else's timeout. A deploy must never fail over it.
    expect(reportDeployPhase('build', { path: null as never })).toBeNull();
    expect(reportDeployPhase('build', {
      path: join(base, 'x.json'),
      fs: { mkdirSync: () => { throw new Error('read-only'); }, writeFileSync: () => {}, renameSync: () => {} },
    })).toBeNull();
  });

  it('Test_DeployPublic_ReportsEveryPhaseBoundaryInOrder', async () => {
    // The ORDER is the contract `decideTimeoutKill` leans on: `build` before the first
    // expensive step and the only killable phase; `upload` the moment the remote is about to
    // change; `published` once the purge is through and the build IS live; `smoke` for the
    // checks that follow. Every network call is stubbed — nothing is deployed anywhere.
    const phases: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { method: string }) => (
      init.method === 'GET' ? reply(404) : reply(init.method === 'PUT' ? 201 : 200))));
    const workspaceRoot = mkdtempSync(join(base, 'ws-'));
    const distDir = join(workspaceRoot, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html><head></head><body></body></html>');
    const cfg = {
      storageZone: 'z', region: 'storage.bunnycdn.com', storageKey: 'K', accountKey: 'A',
      pullZoneId: '42', remotePath: '', googleAnalyticsId: '', newsApiUrl: '',
    };
    await deployPublic(cfg as never, { path: 'dev', demo: true, skipProbe: true } as never, {
      reportPhase: (phase: string) => { phases.push(phase); return null; },
      stageAndBuild: () => ({ workspaceRoot, distDir }),
      sleep: async () => {},
      runSmoke: async () => ({ status: 'ok', failures: [], reportPath: join(base, 'r.json') }),
    } as never);
    expect(phases).toEqual(['build', 'upload', 'published', 'smoke']);
    expect(phases).toEqual([...DEPLOY_PHASES]);
  }, 120_000);

  it('Test_DeployPublic_DryRun_ReportsOnlyTheKillablePhase', async () => {
    // A dry run never touches the remote, so it never leaves `build` — and `build` is exactly
    // the phase in which an outside deadline is allowed to kill.
    const phases: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await deployPublic({ storageZone: 'z', remotePath: '' } as never, { path: 'dev', demo: true, dryRun: true } as never, {
      reportPhase: (phase: string) => { phases.push(phase); return null; },
      stageAndBuild: () => ({ workspaceRoot: null, distDir: join(base, 'nope') }),
    } as never);
    expect(phases).toEqual(['build']);
  });
});

// ─── plan-598 Phase 2: CDN caching ──────────────────────────────────────────

describe('plan-598 §9.5 — edge rules: immutable only for hashed assets', () => {
  const H = 'https://web.realvirtual.io';
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('immutable for */assets/*, revalidated for draco, html, manifests and models', () => {
    expect(cacheControlForUrl(`${H}/demo/assets/index-AbC123.js`)).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(cacheControlForUrl(`${H}/0123abcd/assets/rv_ik_solver-9f8e.wasm`)).toBe(IMMUTABLE_CACHE_CONTROL);
    for (const url of [
      `${H}/demo/draco/draco_decoder.wasm`, `${H}/demo/draco/draco_wasm_wrapper.js`,
      `${H}/demo/project.json`, `${H}/demo/demo-realvirtual/project.json`, `${H}/demo/models.json`,
      `${H}/demo/demo-realvirtual/models/DemoRealvirtualWeb.glb`, `${H}/demo/index.html`, `${H}/demo/`,
      `${H}/demo/?consent=decline`, `${H}/0123abcd/p/project.json`,
      // A hosted project's own `p/assets/` is NOT content-hashed (plan-759 layout).
      `${H}/0123abcd/p/assets/logo.png`, `${H}/0123abcd/p/assets/textures/steel.jpg`,
    ]) {
      expect(cacheControlForUrl(url), url).not.toBe(IMMUTABLE_CACHE_CONTROL);
      expect(cacheControlForUrl(url), url).toBe('no-cache');
    }
  });

  it('ensureEdgeRules is idempotent: first run creates, second run touches nothing', async () => {
    const zoneRules: Array<Record<string, unknown>> = [{ Guid: 'foreign', Description: 'someone else', ActionType: 3 }];
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method?: string; body?: string } = {}) => {
      const u = String(url);
      if (u === 'https://api.bunny.net/pullzone/42' && (init.method ?? 'GET') === 'GET') return reply(200, { EdgeRules: zoneRules });
      if (u === 'https://api.bunny.net/pullzone/42/edgerules/addOrUpdate' && init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        const guid = (body.Guid as string | undefined) ?? `g-${posts.length}`;
        const i = zoneRules.findIndex((r) => r.Guid === guid);
        if (i >= 0) zoneRules[i] = { ...body, Guid: guid }; else zoneRules.push({ ...body, Guid: guid });
        return reply(200, {});
      }
      return reply(404);
    }));
    const client = new CdnClient({ region: 'storage.bunnycdn.com', zone: 'z', storageKey: 'K', accountKey: 'A', pullZoneId: '42' });
    expect(await client.ensureEdgeRules()).toEqual({ created: RV_EDGE_RULES.length, updated: 0, unchanged: 0 });
    expect(await client.ensureEdgeRules()).toEqual({ created: 0, updated: 0, unchanged: RV_EDGE_RULES.length });
    expect(posts).toHaveLength(RV_EDGE_RULES.length);
    // The foreign rule is untouched; ours carry the planned header values.
    expect(zoneRules.find((r) => r.Guid === 'foreign')).toEqual({ Guid: 'foreign', Description: 'someone else', ActionType: 3 });
    const immutable = posts.find((p) => p.ActionParameter2 === IMMUTABLE_CACHE_CONTROL)!;
    expect((immutable.Triggers as Array<{ PatternMatches: string[] }>)[0]!.PatternMatches).toEqual(['*/assets/*']);

    // A drifted rule is updated IN PLACE (same Guid), not duplicated.
    const drifted = zoneRules.find((r) => r.ActionParameter2 === 'no-cache')!;
    drifted.ActionParameter2 = 'max-age=60';
    expect(await client.ensureEdgeRules()).toEqual({ created: 0, updated: 1, unchanged: RV_EDGE_RULES.length - 1 });
    expect(posts.at(-1)!.Guid).toBe(drifted.Guid);
    expect(zoneRules.filter((r) => String(r.Description).startsWith('rv-webviewer:'))).toHaveLength(RV_EDGE_RULES.length);
  });

  it('a rule body is a SetResponseHeader Cache-Control rule on a URL trigger', () => {
    const body = edgeRuleBody(RV_EDGE_RULES[0]!, 'g1');
    expect(body).toMatchObject({ Guid: 'g1', ActionParameter1: 'Cache-Control', Enabled: true, Description: RV_EDGE_RULES[0]!.description });
  });

  it('without credentials or with a failing API the deploy goes on (null, no throw)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await new CdnClient({ region: 'r', zone: 'z', storageKey: 'K' }).ensureEdgeRules()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await new CdnClient({ region: 'r', zone: 'z', storageKey: 'K', accountKey: 'A', pullZoneId: '42' }).ensureEdgeRules()).toBeNull();
  });
});

describe('plan-598 §9.5 — URL purge of what changed', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('uploaded AND deleted non-hashed files, under the demo prefix; index.html also purges its folder URL', () => {
    const urls = purgeUrlsFor({
      baseUrl: 'https://web.realvirtual.io/demo/',
      uploaded: ['index.html', 'assets/index-AbC.js', 'demo-realvirtual/project.json', 'settings.json'],
      deleted: ['demo-realvirtual/models/Old Model.glb', 'assets/index-Old.js'],
    });
    expect(urls).toEqual([
      'https://web.realvirtual.io/demo/index.html',
      'https://web.realvirtual.io/demo/',
      'https://web.realvirtual.io/demo/demo-realvirtual/project.json',
      'https://web.realvirtual.io/demo/settings.json',
      'https://web.realvirtual.io/demo/demo-realvirtual/models/Old%20Model.glb',
    ]);
  });

  it('a private deploy purges under its code — p/assets is NOT content-hashed', () => {
    const urls = purgeUrlsFor({
      baseUrl: 'https://web.realvirtual.io/0123abcd/',
      uploaded: ['p/project.json', 'p/assets/logo.png', 'assets/index-X.js'],
      deleted: ['models.json'],
    });
    expect(urls).toEqual([
      'https://web.realvirtual.io/0123abcd/p/project.json',
      'https://web.realvirtual.io/0123abcd/p/assets/logo.png',
      'https://web.realvirtual.io/0123abcd/models.json',
    ]);
  });

  function apiClient(failUrls: (u: string) => boolean = () => false) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/purge?url=') && failUrls(decodeURIComponent(u.split('url=')[1]!.split('&')[0]!))) return reply(500, 'nope');
      return reply(200, {});
    }));
    return { calls, client: new CdnClient({ region: 'r', zone: 'z', storageKey: 'K', accountKey: 'A', pullZoneId: '42' }) };
  }
  const purgedUrl = (c: string) => decodeURIComponent(c.split('url=')[1]!.split('&')[0]!);

  it('purges exactly the changed URLs (async) and never the zone', async () => {
    const { calls, client } = apiClient();
    const r = await purgeDeployChanges(client, { baseUrl: 'https://web.realvirtual.io/demo/', uploaded: ['index.html'], deleted: ['old.json'] });
    expect(r.mode).toBe('url');
    expect(calls.every((c) => c.startsWith('https://api.bunny.net/purge?url=') && c.endsWith('&async=true'))).toBe(true);
    expect(calls.map(purgedUrl).sort()).toEqual([
      'https://web.realvirtual.io/demo/', 'https://web.realvirtual.io/demo/index.html', 'https://web.realvirtual.io/demo/old.json',
    ]);
  });

  it('only hashed assets changed: nothing to purge', async () => {
    const { calls, client } = apiClient();
    expect((await purgeDeployChanges(client, { baseUrl: 'https://x/demo/', uploaded: ['assets/a-1.js'] })).mode).toBe('none');
    expect(calls).toEqual([]);
  });

  it('falls back to the zone purge: partly applied deploy, more URLs than the limit, or a failed URL purge', async () => {
    const zone = 'https://api.bunny.net/pullzone/42/purgeCache';
    let { calls, client } = apiClient();
    expect((await purgeDeployChanges(client, { baseUrl: 'https://x/d/', uploaded: ['index.html'], partial: true })).mode).toBe('zone');
    expect(calls).toEqual([zone]);

    ({ calls, client } = apiClient());
    const many = Array.from({ length: URL_PURGE_LIMIT + 1 }, (_, i) => `f${i}.json`);
    expect((await purgeDeployChanges(client, { baseUrl: 'https://x/d/', uploaded: many })).mode).toBe('zone');
    expect(calls).toEqual([zone]);

    ({ calls, client } = apiClient((u) => u.endsWith('b.json')));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await purgeDeployChanges(client, { baseUrl: 'https://x/d/', uploaded: ['a.json', 'b.json'] })).mode).toBe('zone');
    expect(calls.at(-1)).toBe(zone);
  });

  it('maybePurge: --no-purge purges nothing; a deploy that only DELETED still purges', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let { calls, client } = apiClient();
    await maybePurge(client, 3, { noPurge: true }, { baseUrl: 'https://x/d/', uploaded: ['index.html'], deleted: [] });
    expect(calls).toEqual([]);
    ({ calls, client } = apiClient());
    await maybePurge(client, 0, {}, { baseUrl: 'https://x/d/', uploaded: [], deleted: ['gone.glb'] });
    expect(calls.map(purgedUrl)).toEqual(['https://x/d/gone.glb']);
  });

  it('reconcileRemoteSnapshot reports the paths it deleted', async () => {
    const deletedOut: string[] = [];
    const client = {
      listRecursive: async () => [{ rel: 'keep.json', size: 1 }, { rel: 'models\\old.glb', size: 1 }],
      deleteFile: async () => {},
    };
    const n = await reconcileRemoteSnapshot(client as never, 'abc', new Set(['keep.json']), deletedOut);
    expect(n).toBe(1);
    expect(deletedOut).toEqual(['models/old.glb']);
  });

  it('uploadDirectory returns the uploaded and deleted paths', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'rv598-upload-'));
    try {
      mkdirSync(join(dist, 'assets'), { recursive: true });
      writeFileSync(join(dist, 'index.html'), '<html></html>');
      writeFileSync(join(dist, 'assets', 'a-1.js'), 'x');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const client = {
        listRecursive: async () => [{ rel: 'assets/old-0.js', size: 1 }, { rel: 'index.html', size: 999 }],
        putFile: async () => {},
        deleteFile: async () => {},
      };
      const r = await uploadDirectory(client as never, dist, 'dev', { force: false, dryRun: false, alwaysUploadGlbs: false }) as {
        uploadedRels: string[]; deletedRels: string[];
      };
      expect(r.uploadedRels.sort()).toEqual(['assets/a-1.js', 'index.html']);
      expect(r.deletedRels).toEqual(['assets/old-0.js']);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('plan-598 §9.5 — deploy-time manifest preload', () => {
  it('matrix: demo, root, hosted without and with password', () => {
    const demo = mkdtempSync(join(tmpdir(), 'rv598-demo-'));
    const root = mkdtempSync(join(tmpdir(), 'rv598-root-'));
    try {
      mkdirSync(join(demo, 'demo-realvirtual'), { recursive: true });
      writeFileSync(join(demo, 'demo-realvirtual', 'project.json'), '{}');
      writeFileSync(join(root, 'project.json'), '{}');
      expect(manifestPreloadFor({ kind: 'public', distDir: demo })).toBe('demo-realvirtual/project.json');
      expect(manifestPreloadFor({ kind: 'public', distDir: root })).toBe('project.json');
      expect(manifestPreloadFor({ kind: 'hosted', encrypted: false })).toBe('p/project.json');
      expect(manifestPreloadFor({ kind: 'hosted', encrypted: true })).toBeNull();
    } finally {
      rmSync(demo, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects exactly one matching preload, idempotently, and removes it for a password deploy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv598-html-'));
    try {
      const index = join(dir, 'index.html');
      writeFileSync(index, '<html><head>\n  <meta charset="UTF-8" />\n  <title>t</title>\n</head><body></body></html>');
      injectManifestPreload(index, { href: 'demo-realvirtual/project.json' });
      injectManifestPreload(index, { href: 'demo-realvirtual/project.json' });
      const html = readFileSync(index, 'utf8');
      expect(html.match(new RegExp(MANIFEST_PRELOAD_ATTR, 'g'))).toHaveLength(1);
      expect(html).toContain('<link rel="preload" href="demo-realvirtual/project.json" as="fetch" type="application/json" crossorigin');
      expect(html.indexOf(MANIFEST_PRELOAD_ATTR)).toBeLessThan(html.indexOf('<title>'));
      injectManifestPreload(index, { href: null });
      expect(readFileSync(index, 'utf8')).not.toContain('rel="preload"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed index.html carries NO static manifest preload any more', () => {
    const html = readFileSync(resolve('index.html'), 'utf8');
    expect(html).not.toMatch(/<link[^>]+rel="preload"[^>]+project\.json/);
    expect(withManifestPreload(html, null)).toBe(html);
  });
});
