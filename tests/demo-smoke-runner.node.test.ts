// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-503 §9.1: the live demo smoke runner (scripts/rv-demo-smoke.mjs) with
 * fake fetch / spawn / fs. Nothing is fetched, spawned or written for real.
 * Every exit path must write smoke-result.json; the runner never writes
 * expected.json and never derives its expectation from the live site.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain ESM script without type declarations
import * as runner from '../scripts/rv-demo-smoke.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const R = runner as {
  expectedTitles(demos: Record<string, string>): string[];
  flattenReport(report: unknown): Array<{ title: string; status: string }>;
  runDemoSmoke(opts: Record<string, unknown>): Promise<any>;
  parseArgs(argv: string[]): Record<string, unknown>;
  DEFAULT_TIMEOUT_MS: number;
};

const BASE = 'https://x.test/dev/';
const OUT = resolve('smoke-test-out');
const ROOT = resolve('fake-root');
const BROWSERS = resolve('fake-browsers');
const DIST = resolve('fake-dist');
const DEMOS = { hmi: 'doc_hmi', planner: 'doc_planner' };
const sha = (s: string | Buffer) => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s) : s).digest('hex');

const manifestOf = (demos: Record<string, string> = DEMOS) => JSON.stringify({
  demos,
  documents: [{ id: 'doc_hmi', path: 'Hmi.glb' }, { id: 'doc_planner', path: 'Planner.glb' }, { id: 'doc_other', path: 'Other.glb' }],
});
const MANIFEST = manifestOf();
const EXPECTED_FILE = resolve('expected.json');
const expectedJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  pair: { web: 'w'.repeat(40), private: 'p'.repeat(40) },
  baseUrl: BASE,
  demos: DEMOS,
  fingerprint: {
    indexHtml: sha('NEW'),
    manifest: sha(MANIFEST),
    glbs: { 'Hmi.glb': { size: 100 }, 'Planner.glb': { size: 10 } },
  },
  ...over,
});

type Test = { title: string; status: string; results: Array<{ status?: string; duration?: number; attachments?: unknown[]; error?: { message: string } }> };

//! A Playwright JSON report in the Windows shape: file suite title with a backslash, `file` with a slash.
function report(tests: Test[], errors: unknown[] = [], describeTitle: string | null = null) {
  const byFile = new Map<string, Test[]>();
  for (const t of tests) {
    const [file] = t.title.split(' › ');
    byFile.set(file, [...(byFile.get(file) ?? []), t]);
  }
  return {
    suites: [...byFile.entries()].map(([file, ts]) => {
      const specs = ts.map((t) => ({
        title: t.title.split(' › ').slice(-1)[0],
        file: `prod-demo/${file}`,
        tests: [{ status: t.status, projectName: 'prod-demo', results: t.results }],
      }));
      return {
        title: `prod-demo\\${file}`,
        file: `prod-demo/${file}`,
        ...(describeTitle
          ? { specs: [], suites: [{ title: describeTitle, file: `prod-demo/${file}`, specs }] }
          : { specs, suites: [] }),
      };
    }),
    errors,
  };
}

const TITLES: string[] = R.expectedTitles(DEMOS);
const green = (): Test[] => TITLES.map((title) => ({ title, status: 'expected', results: [{ status: 'passed', duration: 1 }] }));

interface Fake {
  served?: string[];               // successive index.html bodies
  servedManifest?: string;         // manifest body the CDN serves
  glbSizes?: Record<string, string>;
  manifestOk?: boolean;
  browsers?: string[];
  cli?: boolean;
  exitCode?: number;
  report?: unknown | 'corrupt' | 'missing';
  hang?: boolean;
  lineOutput?: string;
  expected?: string | null;        // expected.json content; null = absent
  dist?: { indexHtml: string; manifest: string; glbs: Record<string, number> };
}

function harness(f: Fake = {}) {
  const files = new Map<string, Buffer>();
  if (f.expected !== null) files.set(EXPECTED_FILE, Buffer.from(f.expected ?? expectedJson()));
  if (f.dist) {
    files.set(join(DIST, 'index.html'), Buffer.from(f.dist.indexHtml));
    files.set(join(DIST, 'demo-realvirtual', 'project.json'), Buffer.from(f.dist.manifest));
    for (const [path, size] of Object.entries(f.dist.glbs)) files.set(join(DIST, 'demo-realvirtual', path), Buffer.alloc(size));
  }
  const served = [...(f.served ?? ['NEW'])];
  const killed: number[] = [];
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const writes: string[] = [];
  const deps = {
    fetch: async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      requests.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
      if (init.method === 'HEAD') {
        const name = url.split('/').pop()!;
        const size = f.glbSizes?.[name] ?? (name === 'Hmi.glb' ? '100' : '10');
        const headers: Record<string, string> = { 'content-length': size, etag: '"etag-never-compared"', 'last-modified': 'Sat, 26 Sep 2026 14:50:00 GMT' };
        return { ok: true, status: 200, headers: { get: (h: string) => headers[h] ?? null } };
      }
      if (url.endsWith('project.json')) {
        if (f.manifestOk === false) throw new Error('ECONNREFUSED');
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(f.servedManifest ?? MANIFEST), headers: { get: () => null } };
      }
      if (url.endsWith('index.html')) {
        const body = served.length > 1 ? served.shift()! : served[0];
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body), headers: { get: () => null } };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    readFile: (p: string) => {
      const b = files.get(resolve(p));
      if (!b) throw new Error(`ENOENT ${p}`);
      return b;
    },
    writeFile: (p: string, data: string) => { writes.push(resolve(p)); files.set(resolve(p), Buffer.from(data)); },
    exists: (p: string) => {
      if (resolve(p) === join(ROOT, 'node_modules', 'playwright', 'cli.js')) return f.cli !== false;
      if (resolve(p) === BROWSERS) return true;
      return files.has(resolve(p));
    },
    readdir: () => f.browsers ?? ['chromium-1208', 'chromium_headless_shell-1208'],
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    killTree: (pid: number) => { killed.push(pid); },
    spawn: (_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; args: string[]; env: Record<string, string> };
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawned.push({ args, env: opts.env });
      setTimeout(() => {
        if (f.lineOutput) child.stdout.emit('data', f.lineOutput);
        if (f.hang) return;
        const reportPath = resolve(opts.env.PLAYWRIGHT_JSON_OUTPUT_NAME);
        if (f.report === 'corrupt') files.set(reportPath, Buffer.from('{not json'));
        else if (f.report !== 'missing') files.set(reportPath, Buffer.from(JSON.stringify(f.report ?? report(green()))));
        child.emit('exit', f.exitCode ?? 0, null);
      }, 0);
      return child;
    },
  };
  const spawned: Array<{ args: string[]; env: Record<string, string> }> = [];
  const run = (extra: Record<string, unknown> = {}) => R.runDemoSmoke({
    outDir: OUT, rootDir: ROOT, browsersPath: BROWSERS, expectedFile: EXPECTED_FILE,
    pollBudgetMs: 5_000, pollIntervalMs: 1, timeoutMs: 50, deps, ...extra,
  });
  const written = () => JSON.parse(files.get(join(OUT, 'smoke-result.json'))!.toString('utf8'));
  return { run, written, killed, files, requests, spawned, writes };
}

describe('runDemoSmoke (plan-503 §9.1)', () => {
  it('polls until the served index.html matches, then runs playwright → ok', async () => {
    const h = harness({ served: ['OLD', 'OLD', 'NEW'] });
    const r = await h.run();
    expect(r.status).toBe('ok');
    expect(r.steps.freshness.polls).toBe(3);
    expect(r.pair).toEqual({ web: 'w'.repeat(40), private: 'p'.repeat(40) });
    expect(r.baseUrl).toBe(BASE);
    expect(h.written().status).toBe('ok');
    // The playwright CLI is spawned directly (no npm lifecycle), prod-demo only, json + line.
    expect(h.spawned[0].args.slice(1, 4)).toEqual(['test', '--project=prod-demo', '--reporter=json,line']);
    expect(h.spawned[0].env.RV_SMOKE_BASE_URL).toBe(BASE);
    expect(JSON.parse(h.spawned[0].env.RV_SMOKE_EXPECTED_DEMOS)).toEqual(DEMOS);
  });

  it('reports stale-cdn when the poll budget is exhausted and still writes smoke-result.json', async () => {
    const h = harness({ served: ['OLD'] });
    const r = await h.run();
    expect(r).toMatchObject({ status: 'failed', reason: 'stale-cdn' });
    expect(h.written().reason).toBe('stale-cdn');
    expect(h.spawned).toEqual([]);
  });

  it('reports stale-cdn for new index.html + old manifest, and for unchanged index.html + changed GLB', async () => {
    const oldManifest = harness({ servedManifest: manifestOf({ hmi: 'doc_hmi', planner: 'doc_old' }) });
    expect(await oldManifest.run()).toMatchObject({ status: 'failed', reason: 'stale-cdn' });
    const oldGlb = harness({ glbSizes: { 'Planner.glb': '11' } });
    expect(await oldGlb.run()).toMatchObject({ status: 'failed', reason: 'stale-cdn' });
  });

  it('HEAD requests carry Accept-Encoding: identity and compare Content-Length, never ETag', async () => {
    const h = harness();
    const r = await h.run();
    expect(r.status).toBe('ok');
    const heads = h.requests.filter((q) => q.method === 'HEAD');
    expect(heads.map((q) => q.url.split('/').pop()).sort()).toEqual(['Hmi.glb', 'Planner.glb']);
    for (const q of heads) expect(q.headers['Accept-Encoding']).toBe('identity');
    // The served ETag ("etag-never-compared") is never part of the fingerprint.
    expect(JSON.stringify(r.steps.freshness.served)).not.toContain('etag');
    expect(r.steps.freshness.served.glbs['Hmi.glb']).toEqual({ size: 100, lastModified: 'Sat, 26 Sep 2026 14:50:00 GMT' });
  });

  it('fails with reason=unreachable when project.json cannot be fetched', async () => {
    const h = harness({ manifestOk: false });
    expect(await h.run()).toMatchObject({ status: 'failed', reason: 'unreachable' });
    expect(h.written().reason).toBe('unreachable');
  });

  it('fails with reason=runtime-missing when playwright/cli.js or the browser dir is absent', async () => {
    expect(await harness({ cli: false }).run()).toMatchObject({ status: 'failed', reason: 'runtime-missing' });
    const h = harness({ browsers: ['ffmpeg-1011'] });
    expect(await h.run()).toMatchObject({ status: 'failed', reason: 'runtime-missing' });
    expect(h.written().reason).toBe('runtime-missing');
    expect(await harness().run({ browsersPath: null })).toMatchObject({ reason: 'runtime-missing' });
  });

  it('fails with reason=incomplete when executed titles miss an expected one (skip/filter)', async () => {
    const tests = green();
    tests[3] = { ...tests[3], status: 'skipped', results: [] };
    const r = await harness({ report: report(tests) }).run();
    expect(r).toMatchObject({ status: 'failed', reason: 'incomplete' });
    expect(r.failures.map((x: { title: string }) => x.title)).toContain(TITLES[3]);
    // Filtered: a spec that is not in the report at all is missing too.
    const filtered = await harness({ report: report(green().slice(0, 2), [{ message: 'prod-demo: unreachable' }]) }).run();
    expect(filtered).toMatchObject({ status: 'failed', reason: 'incomplete' });
    // The global error that explains the gap comes along.
    expect(filtered.failures.map((x: { message: string }) => x.message)).toContain('prod-demo: unreachable');
  });

  it('treats a test with results [failed, passed] (status=flaky) as passed and lists it in flaky[]', async () => {
    const tests = green();
    tests[2] = { ...tests[2], status: 'flaky', results: [{ status: 'failed', duration: 1 }, { status: 'passed', duration: 1 }] };
    const r = await harness({ report: report(tests) }).run();
    expect(r.status).toBe('ok');
    expect(r.flaky).toEqual([TITLES[2]]);
    expect(r.retries).toBe(1);
  });

  it('flattens nested suites[] and maps a failing test to failures[] with spec, title, attachments', async () => {
    const tests = green();
    tests[1] = { ...tests[1], status: 'unexpected', results: [{ status: 'failed', error: { message: 'boom' }, attachments: [{ name: 's', path: '/a.png' }] }] };
    const r = await harness({ report: report(tests), exitCode: 1 }).run();
    expect(r).toMatchObject({ status: 'failed', reason: 'tests' });
    expect(r.failures[0]).toMatchObject({ spec: 'demo-smoke.spec.ts', title: TITLES[1], message: 'boom', attachments: ['/a.png'] });
  });

  it('fails with reason=tests when playwright exits non-zero or errors[] is non-empty despite green tests', async () => {
    expect(await harness({ exitCode: 1 }).run()).toMatchObject({ status: 'failed', reason: 'tests' });
    expect(await harness({ report: report(green(), [{ message: 'worker crashed' }]) }).run())
      .toMatchObject({ status: 'failed', reason: 'tests' });
  });

  it('fails with reason=report-unreadable when the playwright JSON is missing or corrupt', async () => {
    for (const bad of ['missing', 'corrupt'] as const) {
      const h = harness({ report: bad });
      expect(await h.run()).toMatchObject({ status: 'failed', reason: 'report-unreadable' });
      expect(h.written().reason).toBe('report-unreadable');
    }
  });

  it('fails with reason=timeout, kills the child tree and keeps the line-reporter output as partialLog', async () => {
    const h = harness({ hang: true, lineOutput: '[3/4] planner-journey.spec.ts › drag moves …' });
    const r = await h.run();
    expect(r).toMatchObject({ status: 'failed', reason: 'timeout' });
    expect(h.killed).toEqual([4242]);
    expect(r.partialLog).toContain('[3/4] planner-journey.spec.ts');
    expect(h.written().partialLog).toContain('planner-journey');
    expect(R.DEFAULT_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('writes smoke-result.json on EVERY exit path (table-driven over all reasons)', async () => {
    const cases: Array<[string, Fake, Record<string, unknown>]> = [
      ['ok', {}, {}],
      ['skipped', {}, { noSmoke: true }],
      ['expected-unreadable', { expected: null }, {}],
      ['runtime-missing', { cli: false }, {}],
      ['unreachable', { manifestOk: false }, {}],
      ['stale-cdn', { served: ['OLD'] }, {}],
      ['timeout', { hang: true }, {}],
      ['report-unreadable', { report: 'missing' }, {}],
      ['incomplete', { report: report(green().slice(1)) }, {}],
      ['tests', { exitCode: 1 }, {}],
    ];
    for (const [label, fake, extra] of cases) {
      const h = harness(fake);
      const r = await h.run(extra);
      const written = h.written();
      expect(written.reportPath, label).toBe(join(OUT, 'smoke-result.json'));
      expect(written.reason ?? written.status, label).toBe(label);
      expect(r.reportPath, label).toBe(written.reportPath);
      // The runner never (re)writes expected.json — the deploy owns it.
      expect(h.writes.filter((p) => p.endsWith('expected.json')), label).toEqual([]);
    }
  });

  it('derives expected demo ids from the LOCAL dist manifest, never from the live one', async () => {
    const localManifest = manifestOf({ hmi: 'doc_hmi', planner: 'doc_planner' });
    const h = harness({
      expected: null,
      dist: { indexHtml: 'NEW', manifest: localManifest, glbs: { 'Hmi.glb': 100, 'Planner.glb': 10 } },
      // The live manifest names a different planner doc — it must not leak into the expectation.
      servedManifest: localManifest,
    });
    const r = await h.run({ expectedFile: undefined, distDir: DIST, baseUrl: BASE });
    expect(r.status).toBe('ok');
    expect(r.demos).toEqual({ hmi: 'doc_hmi', planner: 'doc_planner' });
    expect(r.fingerprint.glbs).toEqual({ 'Hmi.glb': { size: 100 }, 'Planner.glb': { size: 10 } });
    const live = harness({
      expected: null,
      dist: { indexHtml: 'NEW', manifest: localManifest, glbs: { 'Hmi.glb': 100, 'Planner.glb': 10 } },
      servedManifest: manifestOf({ hmi: 'doc_hmi', planner: 'doc_live_only' }),
    });
    const stale = await live.run({ expectedFile: undefined, distDir: DIST, baseUrl: BASE });
    expect(stale).toMatchObject({ status: 'failed', reason: 'stale-cdn', demos: { planner: 'doc_planner' } });
  });

  it('--expected <file> replaces the dist fingerprint (retry path after staging is gone)', async () => {
    const h = harness();
    const r = await h.run({ distDir: undefined });
    expect(r.status).toBe('ok');
    expect(r.fingerprint.indexHtml).toBe(sha('NEW'));
    // base URL comes from the file when none is passed
    expect(r.baseUrl).toBe(BASE);
    const corrupt = harness({ expected: '{"demos":{}}' });
    expect(await corrupt.run()).toMatchObject({ status: 'failed', reason: 'expected-unreadable' });
  });

  it('aborts without --dist and without --expected (no self-bootstrap)', async () => {
    const h = harness();
    await expect(h.run({ expectedFile: undefined, distDir: undefined, baseUrl: BASE })).rejects.toThrow(/distDir .* or expectedFile/);
    expect(h.requests).toEqual([]);
    expect(() => R.parseArgs(['--base-url', BASE])).toThrow(/--expected <file> is required/);
    expect(() => R.parseArgs(['--bootstrap-from-live'])).toThrow(/unknown argument/);
    expect(() => R.parseArgs(['--dist', DIST])).toThrow(/--dist needs --base-url/);
    expect(R.parseArgs(['--expected', EXPECTED_FILE, '--out', OUT])).toMatchObject({ expectedFile: EXPECTED_FILE, outDir: OUT });
  });

  it('skips only with noSmoke and still writes smoke-result.json', async () => {
    const h = harness();
    expect(await h.run({ noSmoke: true })).toMatchObject({ status: 'skipped' });
    expect(h.written().status).toBe('skipped');
    expect(h.requests).toEqual([]);
  });

  it('identifies tests by basename(file)+describe+title and ignores the OS-specific top-level suite title', () => {
    expect(R.flattenReport(report(green())).map((t) => t.title)).toEqual(TITLES);
    const nested = R.flattenReport(report(green(), [], 'group'));
    expect(nested[0].title).toBe(TITLES[0].replace(' › ', ' › group › '));
    expect(nested.every((t) => !t.title.includes('\\'))).toBe(true);
  });
});
