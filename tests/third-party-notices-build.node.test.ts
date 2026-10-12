// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-544 F5/F7/F11 — the Vite plugin against a real in-process `vite.build` of a temp fixture
 * with a fake node_modules: a main-chunk package, a lazy-chunk-only package, a WORKER-ONLY
 * package (`new Worker(new URL(...))` — a separate Rollup pass), two versions of one package, a
 * package without a `license` field but with a LICENSE file, a package whose sub-folder carries a
 * name-less package.json, and a fake GPL package.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, createServer } from 'vite';

import { createThirdPartyNotices } from '../scripts/vite-plugin-third-party-notices.mjs';

const MIT_LICENSE = 'MIT License\n\nCopyright (c) 2024 Fixture Author\n\nPermission is hereby granted, free of charge.\n';

let root: string;
// realpath: the Windows temp dir can be an 8.3 short name, which trips libuv's fs watcher.
beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rv-notices-build-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, text: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function pkg(dir: string, manifest: Record<string, unknown>, main = 'export const value = 1;\n', license: string | null = MIT_LICENSE) {
  write(`${dir}/package.json`, JSON.stringify({ type: 'module', main: 'index.js', ...manifest }));
  write(`${dir}/index.js`, main);
  if (license) write(`${dir}/LICENSE`, license);
}

function fixture({ withGpl }: { withGpl: boolean }) {
  write('package.json', JSON.stringify({ name: 'fixture-app', version: '0.0.0', private: true, type: 'module' }));
  write('src/main.js', [
    "import { value as a } from 'main-pkg';",
    "import { value as n } from 'nested';",
    "import { value as f } from 'nofield-pkg';",
    "import { deep } from 'sub-pkg/lib/deep.js';",
    withGpl ? "import { value as g } from 'gpl-pkg';" : 'const g = 0;',
    "export async function run() {",
    "  const lazy = await import('./lazy.js');",
    "  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });",
    '  return a + n + f + deep + g + lazy.value + (worker ? 1 : 0);',
    '}',
    // An app build drops the entry's exports (preserveEntrySignatures: false) — call it.
    'run().then((v) => console.log(v));',
  ].join('\n'));
  write('src/lazy.js', "import { value } from 'lazy-pkg';\nexport { value };\n");
  write('src/worker.js', "import { value } from 'worker-pkg';\nself.postMessage(value);\n");
  pkg('node_modules/main-pkg', { name: 'main-pkg', version: '1.0.0', license: 'MIT', dependencies: { nested: '1.0.0' } },
    "import { value as n } from 'nested';\nexport const value = n + 1;\n");
  pkg('node_modules/main-pkg/node_modules/nested', { name: 'nested', version: '1.0.0', license: 'MIT' });
  pkg('node_modules/nested', { name: 'nested', version: '2.0.0', license: 'MIT' });
  pkg('node_modules/lazy-pkg', { name: 'lazy-pkg', version: '3.0.0', license: 'ISC', author: 'Lazy Author' }, 'export const value = 3;\n', null);
  pkg('node_modules/worker-pkg', { name: 'worker-pkg', version: '4.0.0', license: 'BSD-3-Clause' }, 'export const value = 4;\n');
  pkg('node_modules/nofield-pkg', { name: 'nofield-pkg', version: '5.0.0' });
  pkg('node_modules/sub-pkg', { name: 'sub-pkg', version: '6.0.0', license: 'MIT' });
  write('node_modules/sub-pkg/lib/package.json', JSON.stringify({ type: 'module' }));
  write('node_modules/sub-pkg/lib/deep.js', 'export const deep = 6;\n');
  pkg('node_modules/gpl-pkg', { name: 'gpl-pkg', version: '7.0.0', license: 'GPL-3.0-only' });
  write('third-party/license-policy.json', JSON.stringify({
    allowed: ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0'],
    dynamicOnly: ['LGPL-2.1-only'],
    exceptions: [{ name: 'nofield-pkg', version: '5.0.0', license: '', reason: 'fixture: no license field, LICENSE file is MIT-like', decidedBy: 'test', date: '2026-10-03' }],
    vendorTerms: [],
  }));
}

function notices(mode: 'warn' | 'enforce') {
  return createThirdPartyNotices({
    rootDir: root,
    policies: [{ path: join(root, 'third-party/license-policy.json'), scope: 'public' }],
    tier: 'public',
    mode,
  });
}

async function buildFixture(mode: 'warn' | 'enforce', { embedStyle = false } = {}) {
  const n = notices(mode);
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    publicDir: embedStyle ? false : undefined,
    plugins: [n.plugin()],
    worker: { format: 'es', plugins: () => [n.workerPlugin()] },
    build: {
      outDir: join(root, 'dist'),
      emptyOutDir: true,
      minify: false,
      ...(embedStyle
        ? { lib: { entry: join(root, 'src/main.js'), formats: ['es'], fileName: () => 'lib.js' } }
        : { rollupOptions: { input: join(root, 'src/main.js') } }),
    },
  });
  return {
    txt: readFileSync(join(root, 'dist/THIRD-PARTY-NOTICES.txt'), 'utf8'),
    json: JSON.parse(readFileSync(join(root, 'dist/third-party-notices.json'), 'utf8')),
  };
}

describe('vite-plugin-third-party-notices — real build (F5)', () => {
  it('without GPL: lists main, lazy, worker-only and both nested versions; no first-party ids', async () => {
    fixture({ withGpl: false });
    const { txt, json } = await buildFixture('enforce');
    const names = json.components.map((c: { name: string; version: string }) => `${c.name}@${c.version}`);
    expect(names).toEqual(['lazy-pkg@3.0.0', 'main-pkg@1.0.0', 'nested@1.0.0', 'nested@2.0.0', 'nofield-pkg@5.0.0', 'sub-pkg@6.0.0', 'worker-pkg@4.0.0']);
    expect(json.violations).toEqual([]);
    expect(json.mode).toBe('enforce');
    expect(txt).not.toContain('fixture-app');
    expect(txt).not.toContain('Policy violations');
    // The ISC package ships no LICENSE: canonical text + the author as copyright line.
    expect(txt).toContain('Copyright (c) Lazy Author');
  }, 120_000);

  it('enforce fails the build and lists the GPL package', async () => {
    fixture({ withGpl: true });
    await expect(buildFixture('enforce')).rejects.toThrow(/gpl-pkg 7\.0\.0[\s\S]*strong copyleft/);
  }, 120_000);

  it('warn passes and writes a violations section at the top', async () => {
    fixture({ withGpl: true });
    const { txt, json } = await buildFixture('warn');
    expect(json.mode).toBe('warn');
    expect(json.violations.map((v: { name: string }) => v.name)).toEqual(['gpl-pkg']);
    expect(txt.indexOf('Policy violations (warn mode)')).toBeGreaterThan(-1);
    expect(txt.indexOf('Policy violations (warn mode)')).toBeLessThan(txt.indexOf('Components ('));
  }, 120_000);

  it('an embed-style lib build (publicDir:false) emits the notices too', async () => {
    fixture({ withGpl: false });
    const { json } = await buildFixture('enforce', { embedStyle: true });
    expect(json.components.length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'dist/lib.js'))).toBe(true);
  }, 120_000);
});

describe('vite-plugin-third-party-notices — dev server (F7)', () => {
  it('answers THIRD-PARTY-NOTICES.txt with a development preview and never throws', async () => {
    fixture({ withGpl: true });
    write('package-lock.json', JSON.stringify({ packages: {
      '': { name: 'fixture-app' },
      'node_modules/main-pkg': { version: '1.0.0' },
      'node_modules/gpl-pkg': { version: '7.0.0' },
      'node_modules/dev-only': { version: '1.0.0', dev: true },
    } }));
    const n = notices('enforce');
    const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true, watch: null, hmr: false }, plugins: [n.plugin()] });
    const http = createHttpServer(server.middlewares);
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
    try {
      const port = (http.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/THIRD-PARTY-NOTICES.txt`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
      const text = await response.text();
      expect(text.split('\n')[0]).toMatch(/^DEVELOPMENT PREVIEW/);
      expect(text).toContain('main-pkg 1.0.0');
      // Serve mode never errors — a GPL package in the lockfile is reported, not thrown.
      expect(text).toContain('gpl-pkg');
    } finally {
      await new Promise<void>((ok) => http.close(() => ok()));
      await server.close();
    }
  }, 120_000);
});

describe('vite-plugin-third-party-notices — the inputs are read once per build (plan-587 Phase 4)', () => {
  //! A collector with a manual component list, so BOTH readers of that file run: `collect()`
  //! matches the entry's `match` globs, and `declaredNames()` collects its name for the policy.
  function noticesWithManualList() {
    write('third-party/manual-components.json', JSON.stringify([{
      name: 'fixture-manual-component',
      version: '1.2.3',
      license: 'MIT',
      match: ['**/main-pkg/**', '**/*.js'],
    }]));
    return createThirdPartyNotices({
      rootDir: root,
      policies: [{ path: join(root, 'third-party/license-policy.json'), scope: 'public' }],
      manualComponents: join(root, 'third-party/manual-components.json'),
      tier: 'public',
      mode: 'warn',
    });
  }

  async function runBuild(n: ReturnType<typeof createThirdPartyNotices>) {
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [n.plugin()],
      worker: { format: 'es', plugins: () => [n.workerPlugin()] },
      build: {
        outDir: join(root, 'dist'),
        emptyOutDir: true,
        minify: false,
        rollupOptions: { input: join(root, 'src/main.js') },
      },
    });
    return JSON.parse(readFileSync(join(root, 'dist/third-party-notices.json'), 'utf8'));
  }

  it('Test_ManualComponents_ReadOncePerBuild', async () => {
    // `collect()` and `declaredNames()` both need the manual list, and the dev preview needs it
    // a third time — before plan-587 that was two or three reads of the same unchanging file per
    // build. The counter is the only way to tell a working memo from a coincidence; without it
    // this number would be 2 after the build and 3 after the preview.
    fixture({ withGpl: false });
    const n = noticesWithManualList();
    const json = await runBuild(n);
    // Proof that BOTH readers actually ran: the entry is in the output (collect), …
    expect(json.components.map((c: { name: string }) => c.name)).toContain('fixture-manual-component');
    expect(n.reads.manualComponents).toBe(1);
    // … and a dev preview afterwards — the third reader — still does not re-read it.
    n.devPreview();
    expect(n.reads.manualComponents).toBe(1);
  }, 120_000);

  it('Test_LicencePolicies_ReadOncePerBuild', async () => {
    fixture({ withGpl: false });
    const n = noticesWithManualList();
    await runBuild(n);
    expect(n.reads.policies).toBe(1);
    n.devPreview();
    expect(n.reads.policies).toBe(1);
  }, 120_000);

  it('Test_UnreadableManualComponents_StillReportedOnEveryCall', async () => {
    // The memo caches the FAILURE as well as the success — but it must keep landing in
    // `problems`, or a broken manual list would turn into a silently incomplete notices file
    // after the first read. `warn` mode writes the problems into the file as "incomplete".
    fixture({ withGpl: false });
    write('third-party/manual-components.json', '{ this is not json');
    const n = createThirdPartyNotices({
      rootDir: root,
      policies: [{ path: join(root, 'third-party/license-policy.json'), scope: 'public' }],
      manualComponents: join(root, 'third-party/manual-components.json'),
      tier: 'public',
      mode: 'warn',
    });
    const json = await runBuild(n);
    expect(n.reads.manualComponents).toBe(1);
    expect(JSON.stringify(json.incomplete ?? json)).toMatch(/manual component list unreadable/);
    // And a second generate (the dev preview) reports it again rather than losing it.
    expect(n.devPreview()).toBeTypeOf('string');
    expect(n.reads.manualComponents).toBe(1);
  }, 120_000);
});
