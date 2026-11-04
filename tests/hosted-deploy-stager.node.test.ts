// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * hosted-deploy-stager.node.test.ts — plan-759 §9.1 / §9.2 / §9.8.
 *
 * The hosted layout: runtime at the deploy root, the project folder verbatim
 * under `p/`, a generated settings.json naming it. What the tests pin:
 *
 *  - `p/project.json` survives (the deny list must never remove the manifest),
 *    every GLB keeps its own path, sources / trash / backups / secrets / symlinks
 *    do not travel, no `models.json` exists any more, no `defaultModel` (D14).
 *  - With a password every GLB is an RVE1 envelope under ONE salt, each header
 *    carries the file's own path as `hkdfInfo` (chunks are not interchangeable),
 *    the probe in settings.json opens with the same key.
 *  - The remote snapshot IS the staging listing; the reconciler removes a
 *    previous layout's `models/`, `models.json`, `private-assets/`.
 *
 * Runner: `npm run test:node`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  stageHostedProject,
  generateHostedSettings,
  copyProjectVerbatim,
  HOSTED_PROJECT_PREFIX,
  SETTINGS_RESERVED_KEYS,
} from '../scripts/_bunny-lib.mjs';
import { expectedHostedSnapshot, reconcileRemoteSnapshot, uploadDirectory } from '../scripts/bunny-deploy.mjs';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { generateFragmentSecret, isEncryptedEnvelope, decryptGlb, parseEnvelopeHeader, PROBE_PLAINTEXT, PROBE_INFO } from '../scripts/lib/rv-crypto.mjs';
import { makeDist, FIXTURE_NOTICES_JSON, FIXTURE_NOTICES_TXT } from './helpers/make-dist';

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

interface ProjectSpec {
  files?: Record<string, string>;
  manifest?: Record<string, unknown>;
  ignore?: string;
}

/** A customer project folder as the viewer writes it: manifest + arbitrary files at any depth. */
function makeProject(root: string, spec: ProjectSpec = {}): string {
  mkdirSync(root, { recursive: true });
  const manifest = spec.manifest ?? {
    name: 'Kunde XY', code: 'deadbeefdeadbeefdeadbeefdeadbeef', canonicalName: 'kunde-xy', kind: 'customer',
    settings: { defaultModel: 'models/a.glb' },
    documents: [
      { id: 'doc_a', path: 'models/a.glb', name: 'a' },
      { id: 'doc_b', path: 'cad/deep/b.glb', name: 'b' },
    ],
  };
  writeFileSync(join(root, 'project.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  if (spec.ignore !== undefined) writeFileSync(join(root, '.rvprojectignore'), spec.ignore);
  return root;
}

const FILES = {
  'models/a.glb': 'glTF-A-CUSTOMER',
  'cad/deep/b.glb': 'glTF-B-CUSTOMER',
  'scenes/c.scene.glb': 'glTF-C',
  'plugins/index.ts': 'export const x = 1;',
  'assets/branding/logo.png': 'PNG',
  'docs/manual.pdf': 'PDF',
  'cad/old/project.json.bak': '{}',
  'secrets.local.json': '{"token":"x"}',
  'connect/project-config.json': '{"ApiKey":"x"}',
  'foo.tmp': 'tmp',
  'debug.log': 'log',
  '.trash/gone.glb': 'glTF',
  '.cad-cache/x.bin': 'bin',
};

describe('stageHostedProject — layout & deny (§9.1)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvhosted-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('publishes the runtime at the root and the project verbatim under p/, minus the deny list', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'kunde-xy'), { files: FILES, ignore: '# derived\n.trash/\n*.tmp\n*.log\n' });
    let symlinked = false;
    try {
      writeFileSync(join(work, 'outside.glb'), 'OUTSIDE');
      symlinkSync(join(work, 'outside.glb'), join(proj, 'link.glb'), 'file');
      symlinked = true;
    } catch {
      // Symlink creation needs a privilege on some Windows setups — the
      // skip-rule is then asserted through the report only when it ran.
    }

    let report: { copied: string[]; denied: { rel: string; reason: string }[]; symlinks: string[]; encrypted: string[] } | null = null;
    const staging = await stageHostedProject({ distDir: dist, projectDir: proj, onReport: (r) => { report = r; } });
    try {
      const p = (rel: string) => join(staging, HOSTED_PROJECT_PREFIX, ...rel.split('/'));
      // runtime
      expect(existsSync(join(staging, 'index.html'))).toBe(true);
      expect(existsSync(join(staging, 'assets', 'app.js'))).toBe(true);
      expect(existsSync(join(staging, 'assets', 'demo-abc123.glb'))).toBe(false);
      expect(existsSync(join(staging, 'models'))).toBe(false);
      expect(existsSync(join(staging, 'scenes'))).toBe(false);
      expect(existsSync(join(staging, 'library'))).toBe(false);
      expect(existsSync(join(staging, 'models.json'))).toBe(false);
      // project, verbatim
      expect(existsSync(p('project.json'))).toBe(true);
      expect(readFileSync(p('models/a.glb'), 'utf8')).toBe('glTF-A-CUSTOMER');
      expect(readFileSync(p('cad/deep/b.glb'), 'utf8')).toBe('glTF-B-CUSTOMER');
      expect(existsSync(p('scenes/c.scene.glb'))).toBe(true);
      expect(existsSync(p('assets/branding/logo.png'))).toBe(true);
      expect(existsSync(p('docs/manual.pdf'))).toBe(true);
      // denied
      for (const rel of ['plugins/index.ts', 'cad/old/project.json.bak', 'secrets.local.json',
        'connect/project-config.json', 'foo.tmp', 'debug.log', '.trash/gone.glb', '.cad-cache/x.bin', 'link.glb']) {
        expect(existsSync(p(rel)), rel).toBe(false);
      }
      expect(report).not.toBeNull();
      const reasons = Object.fromEntries(report!.denied.map((d) => [d.rel, d.reason]));
      expect(reasons['plugins/index.ts']).toBe('denied-file');
      expect(reasons['cad/old/project.json.bak']).toBe('denied-file');
      expect(reasons['secrets.local.json']).toBe('secret');
      expect(reasons['connect/project-config.json']).toBe('artifact');
      expect(reasons['foo.tmp']).toBe('denied-file');   // built-in rule wins over the ignore file
      expect(reasons['debug.log']).toBe('ignore:*.log'); // the project's own .rvprojectignore
      expect(reasons['.trash/']).toBe('denied-dir');
      if (symlinked) expect(report!.symlinks).toEqual(['link.glb']);
      // settings
      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.projectUrl).toBe('p/');
      expect(settings.projectAssetsPath).toBe('p/');
      expect(settings.defaultModel).toBeUndefined(); // D14: the root is the dashboard
      expect(settings.hostedDeploy).toBe(true); // plan-640: the marker that lets settings.start apply
      expect(settings.encryption).toBeUndefined();
      expect(settings.analytics).toEqual({ googleAnalyticsId: '' });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('refuses to stage when the deny list would remove project.json', () => {
    const proj = makeProject(join(work, 'p'), { files: { 'models/a.glb': 'x' } });
    const out = join(work, 'out');
    const report = copyProjectVerbatim(proj, out);
    expect(report.copied).toContain('project.json');
    expect(report.denied).toEqual([]);
  });

  it('a project file can add settings but never own the reserved keys', () => {
    const s = JSON.parse(generateHostedSettings({
      projectSettings: {
        theme: 'dark',
        projectUrl: 'https://elsewhere.example/',
        projectAssetsPath: 'https://elsewhere.example/',
        analytics: { googleAnalyticsId: 'UA-EVIL' },
        encryption: { enabled: false },
        generated: '1999-01-01T00:00:00Z',
        hostedDeploy: false,
        defaultModel: 'models/a.glb',
      },
    }));
    expect(s.theme).toBe('dark');
    expect(s.hostedDeploy).toBe(true); // plan-640: a project file cannot switch the marker off
    expect(s.defaultModel).toBeUndefined();
    expect(s.projectUrl).toBe('p/');
    expect(s.projectAssetsPath).toBe('p/');
    expect(s.analytics).toEqual({ googleAnalyticsId: '' });
    expect(s.encryption).toBeUndefined();
    expect(s.generated).not.toBe('1999-01-01T00:00:00Z');
    expect(SETTINGS_RESERVED_KEYS).toContain('projectUrl');
  });
});

describe('stageHostedProject — envelope, probe, snapshot (§9.2)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvhosted-enc-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('encrypts every GLB under one salt with its own path bound, and the probe opens with the same key', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'kunde-enc'), {
      files: { 'models/a.glb': 'glTF-SAME-PLAINTEXT', 'cad/deep/b.glb': 'glTF-SAME-PLAINTEXT', 'docs/manual.pdf': 'PDF' },
    });
    const fragmentSecret = generateFragmentSecret();
    const staging = await stageHostedProject({
      distDir: dist, projectDir: proj,
      encryption: { password: 'geheim-2027', fragmentSecret, iterations: 1000 },
    });
    try {
      const a = readFileSync(join(staging, 'p', 'models', 'a.glb'));
      const b = readFileSync(join(staging, 'p', 'cad', 'deep', 'b.glb'));
      expect(isEncryptedEnvelope(a)).toBe(true);
      expect(isEncryptedEnvelope(b)).toBe(true);
      expect(a.toString('utf8')).not.toContain('PLAINTEXT');
      // the PDF is not a GLB and stays as it is
      expect(readFileSync(join(staging, 'p', 'docs', 'manual.pdf'), 'utf8')).toBe('PDF');

      const ha = await parseEnvelopeHeader(new Uint8Array(a));
      const hb = await parseEnvelopeHeader(new Uint8Array(b));
      expect(Buffer.from(ha.salt).toString('hex')).toBe(Buffer.from(hb.salt).toString('hex'));
      expect(utf8(ha.hkdfInfo)).toBe('models/a.glb');
      expect(utf8(hb.hkdfInfo)).toBe('cad/deep/b.glb');
      expect(ha.iterations).toBe(1000);

      // Same plaintext, same key — different ciphertext AND not interchangeable:
      // b's header on a's body fails the GCM check.
      expect(a.equals(b)).toBe(false);
      const spliced = Buffer.concat([b.subarray(0, hb.headerLength), a.subarray(ha.headerLength)]);
      await expect(decryptGlb(new Uint8Array(spliced), 'geheim-2027', fragmentSecret)).rejects.toThrow();
      expect(utf8(new Uint8Array(await decryptGlb(new Uint8Array(a), 'geheim-2027', fragmentSecret)))).toBe('glTF-SAME-PLAINTEXT');

      const settings = JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8'));
      expect(settings.encryption.enabled).toBe(true);
      const probe = new Uint8Array(Buffer.from(settings.encryption.probe, 'base64'));
      const hp = await parseEnvelopeHeader(probe);
      expect(Buffer.from(hp.salt).toString('hex')).toBe(Buffer.from(ha.salt).toString('hex'));
      expect(utf8(hp.hkdfInfo)).toBe(PROBE_INFO);
      expect(utf8(new Uint8Array(await decryptGlb(probe, 'geheim-2027', fragmentSecret)))).toBe(PROBE_PLAINTEXT);
      await expect(decryptGlb(probe, 'wrong', fragmentSecret)).rejects.toThrow();
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('without a password the bytes are the source bytes', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'plain'), { files: { 'models/a.glb': 'glTF-PLAIN' } });
    const staging = await stageHostedProject({ distDir: dist, projectDir: proj });
    try {
      expect(readFileSync(join(staging, 'p', 'models', 'a.glb'), 'utf8')).toBe('glTF-PLAIN');
      expect(JSON.parse(readFileSync(join(staging, 'settings.json'), 'utf8')).encryption).toBeUndefined();
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('the remote snapshot is exactly the staging listing', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'snap'), { files: { 'models/a.glb': 'x', 'docs/m.pdf': 'y' } });
    const staging = await stageHostedProject({ distDir: dist, projectDir: proj });
    try {
      const expected = expectedHostedSnapshot(staging) as Set<string>;
      expect(expected.has('p/project.json')).toBe(true);
      expect(expected.has('p/models/a.glb')).toBe(true);
      expect(expected.has('p/docs/m.pdf')).toBe(true);
      expect(expected.has('settings.json')).toBe(true);
      expect(expected.has('index.html')).toBe(true);
      expect([...expected].some((rel) => rel.startsWith('private-assets/'))).toBe(false);
      expect([...expected].some((rel) => rel === 'models.json')).toBe(false);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

describe('hosted reconcile & upload order (§9.8)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvhosted-rec-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('removes a previous layout (models/, models.json, private-assets/) and keeps p/ + runtime', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'old'), { files: { 'models/a.glb': 'x' } });
    const staging = await stageHostedProject({ distDir: dist, projectDir: proj });
    try {
      const expected = expectedHostedSnapshot(staging);
      const deleted: string[] = [];
      const client = {
        listRecursive: async () => [
          { rel: 'models/x.glb' }, { rel: 'models.json' }, { rel: 'private-assets/old/a.png' }, { rel: 'assets/old.js' },
          { rel: 'p/project.json' }, { rel: 'p/models/a.glb' }, { rel: 'index.html' }, { rel: 'settings.json' }, { rel: 'assets/app.js' },
        ],
        deleteFile: async (path: string) => { deleted.push(path); },
      };
      const n = await reconcileRemoteSnapshot(client, 'deadbeef', expected);
      expect(n).toBe(4);
      expect(deleted.sort()).toEqual([
        'deadbeef/assets/old.js', 'deadbeef/models.json', 'deadbeef/models/x.glb', 'deadbeef/private-assets/old/a.png',
      ]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('uploads p/ first, settings.json after every asset, index.html last', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'order'), { files: { 'models/a.glb': 'x', 'docs/m.pdf': 'y' } });
    const staging = await stageHostedProject({ distDir: dist, projectDir: proj });
    try {
      const puts: string[] = [];
      const client = {
        listRecursive: async () => [],
        putFile: async (_bytes: Buffer, path: string) => { puts.push(path); },
        deleteFile: async () => {},
        getFileIfExists: async () => null,
      };
      await uploadDirectory(client, staging, 'deadbeef', {
        force: true, dryRun: false, alwaysUploadGlbs: false,
        deferUntilLast: (rel: string) => /^settings\.json$/i.test(rel),
        uploadFirst: (rel: string) => rel.startsWith('p/'),
      });
      const rel = puts.map((p) => p.replace(/^deadbeef\//, ''));
      const firstNonProject = rel.findIndex((r) => !r.startsWith('p/'));
      const lastProject = rel.map((r) => r.startsWith('p/')).lastIndexOf(true);
      expect(lastProject).toBeLessThan(firstNonProject);
      expect(rel[rel.length - 1]).toBe('index.html');
      expect(rel[rel.length - 2]).toBe('settings.json');
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});

// plan-544 F6: the third-party notices are dist-root files — staged next to index.html on every
// hosted deploy and NEVER encrypted or put behind the project password, even when the project's
// GLBs are.
describe('stageHostedProject — third-party notices stay plaintext (plan-544)', () => {
  let work: string;
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rvhosted-notices-')); });
  afterEach(() => { rmSync(work, { recursive: true, force: true }); });

  it('a password deploy carries both notice files byte-identical at the root', async () => {
    const dist = makeDist(join(work, 'dist'));
    const proj = makeProject(join(work, 'projects', 'kunde-notices'), { files: { 'models/a.glb': 'glTF-SECRET' } });
    const staging = await stageHostedProject({
      distDir: dist, projectDir: proj,
      encryption: { password: 'geheim-2027', fragmentSecret: generateFragmentSecret(), iterations: 1000 },
    });
    try {
      expect(isEncryptedEnvelope(readFileSync(join(staging, 'p', 'models', 'a.glb')))).toBe(true);
      expect(readFileSync(join(staging, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(FIXTURE_NOTICES_TXT);
      expect(readFileSync(join(staging, 'third-party-notices.json'), 'utf8')).toBe(FIXTURE_NOTICES_JSON);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
});
