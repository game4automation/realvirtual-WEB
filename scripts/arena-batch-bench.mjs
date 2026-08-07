// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Arena-batching CPU self-time benchmark (plan-309 Phase 0).
 *
 * Starts an isolated Vite server on the first free port at/above 5199, loads
 * the three largest checked-in GLB models plus a low-reuse synthetic scene,
 * performs one warm-up and five measured arena builds, then prints a
 * reproducible Markdown/JSON report. GLB parse/network time and cooperative
 * yield wait time are deliberately outside the measured self-time.
 *
 *   node scripts/arena-batch-bench.mjs
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const RUNS = 5;
const WARMUPS = 1;
const MODEL_COUNT = 3;
const SYNTHETIC_UNIQUE_GEOMETRIES = 1_000;
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(rootDir, 'public', 'models');

async function filesBelow(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.glb')) files.push(path);
  }
  return files;
}

const corpus = [];
for (const path of (await filesBelow(modelsDir))) {
  const info = await stat(path);
  corpus.push({
    path,
    file: relative(rootDir, path).split(sep).join('/'),
    bytes: info.size,
  });
}
corpus.sort((a, b) => b.bytes - a.bytes);
corpus.splice(MODEL_COUNT);
for (const item of corpus) {
  item.sha256 = createHash('sha256').update(await readFile(item.path)).digest('hex');
  item.url = `/${relative(join(rootDir, 'public'), item.path).split(sep).map(encodeURIComponent).join('/')}`;
  delete item.path;
}

const server = await createServer({
  root: rootDir,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
  plugins: [{
    name: 'arena-batch-bench-page',
    configureServer(viteServer) {
      viteServer.middlewares.use('/__arena-batch-bench', (_request, response) => {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body>arena batch benchmark</body></html>');
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  const baseUrl = server.resolvedUrls?.local[0];
  if (!baseUrl) throw new Error('Vite did not expose a local benchmark URL');

  browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${baseUrl}__arena-batch-bench`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const browserEnvironment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    longTaskObserver: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    preciseHeap: typeof performance.memory?.usedJSHeapSize === 'number',
  }));

  const rows = await page.evaluate(async ({ corpus: modelCorpus, runs, warmups, syntheticUnique }) => {
    const THREE = await import('/@id/three');
    const { GLTFLoader } = await import('/@id/three/addons/loaders/GLTFLoader.js');
    const { buildBatchedScene } = await import('/src/core/engine/rv-batched-render.ts');
    const { BatchTable } = await import('/src/core/engine/rv-batch-table.ts');
    const { createLoadProfiler } = await import('/src/core/engine/rv-load-profiler.ts');
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const p95 = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    };
    const summarize = (values) => ({ median: median(values), p95: p95(values) });

    const prepareStatic = (root) => {
      let meshCount = 0;
      root.traverse((node) => {
        if (!node.isMesh || node.isSkinnedMesh) return;
        node.matrixAutoUpdate = false;
        node.updateMatrix();
        meshCount++;
      });
      root.updateWorldMatrix(true, true);
      return meshCount;
    };

    const makeSynthetic = () => {
      const root = new THREE.Group();
      root.name = 'SyntheticLowReuse';
      const material = new THREE.MeshStandardMaterial({ color: 0x78909c, roughness: 0.6 });
      for (let i = 0; i < syntheticUnique; i++) {
        const geometry = new THREE.SphereGeometry(0.5, 16, 12);
        for (let reuse = 0; reuse < 2; reuse++) {
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set((i % 50) * 1.25, Math.floor(i / 50) * 1.25, reuse * 1.25);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          root.add(mesh);
        }
      }
      root.updateWorldMatrix(true, true);
      return root;
    };

    const measureBuild = async (root) => {
      const longTasks = [];
      const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
        ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        })
        : null;
      observer?.observe({ type: 'longtask', buffered: false });

      const heapBefore = performance.memory?.usedJSHeapSize ?? null;
      const profiler = createLoadProfiler('arena-batch-bench');
      const table = new BatchTable();
      const wallStart = performance.now();
      const result = await buildBatchedScene(root, null, new Set(), table, { profiler });
      const wallMs = performance.now() - wallStart;
      await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      observer?.disconnect();
      const heapAfter = performance.memory?.usedJSHeapSize ?? null;
      const self = profiler.getSelfTimings().buildBatchedScene ?? {};
      const selfTotal = Object.values(self).reduce((sum, value) => sum + value, 0);
      const instanceCount = result.staticUber.instanceCount + result.staticTextured.instanceCount;
      const batchCount = result.staticUber.batchCount + result.staticTextured.batchCount;
      table.dispose();
      return {
        self,
        selfTotal,
        wallMs,
        longTaskCount: longTasks.length,
        longTaskMs: longTasks.reduce((sum, value) => sum + value, 0),
        longestTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
        heapBefore,
        heapAfter,
        peakHeap: heapBefore === null || heapAfter === null ? null : Math.max(heapBefore, heapAfter),
        instanceCount,
        batchCount,
      };
    };

    const benchmarkRoot = async (name, root, meshCount) => {
      for (let i = 0; i < warmups; i++) await measureBuild(root);
      const samples = [];
      for (let i = 0; i < runs; i++) samples.push(await measureBuild(root));
      const keys = ['classify/partition', 'canonicalize+flip', 'addGeometry', 'instances'];
      const self = {};
      for (const key of keys) self[key] = summarize(samples.map((sample) => sample.self[key] ?? 0));
      return {
        name,
        planner: 'advanced',
        meshCount,
        runs,
        warmups,
        self,
        selfTotal: summarize(samples.map((sample) => sample.selfTotal)),
        wall: summarize(samples.map((sample) => sample.wallMs)),
        longTasks: {
          count: summarize(samples.map((sample) => sample.longTaskCount)),
          totalMs: summarize(samples.map((sample) => sample.longTaskMs)),
          longestMs: summarize(samples.map((sample) => sample.longestTaskMs)),
        },
        peakHeapBytes: samples[0].peakHeap === null ? null : Math.max(...samples.map((sample) => sample.peakHeap)),
        instanceCount: summarize(samples.map((sample) => sample.instanceCount)),
        batchCount: summarize(samples.map((sample) => sample.batchCount)),
      };
    };

    const results = [];
    const loader = new GLTFLoader();
    for (const item of modelCorpus) {
      const gltf = await loader.loadAsync(item.url);
      results.push(await benchmarkRoot(item.file, gltf.scene, prepareStatic(gltf.scene)));
    }
    const synthetic = makeSynthetic();
    results.push(await benchmarkRoot(
      `synthetic-low-reuse-${syntheticUnique}x2`,
      synthetic,
      syntheticUnique * 2,
    ));
    return results;
  }, {
    corpus,
    runs: RUNS,
    warmups: WARMUPS,
    syntheticUnique: SYNTHETIC_UNIQUE_GEOMETRIES,
  });

  const environment = {
    timestamp: new Date().toISOString(),
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtReport: freemem(),
    node: process.version,
    playwrightChromium: await browser.version(),
    viteUrl: baseUrl,
    ...browserEnvironment,
  };

  const fmt = (value) => Number(value).toFixed(2);
  console.log('\n# Arena batching benchmark (plan-309 Phase 0)');
  console.log(`\nEnvironment: ${JSON.stringify(environment)}`);
  console.log('\nCorpus:');
  for (const item of corpus) {
    console.log(`- ${item.file} | ${item.bytes} bytes | sha256 ${item.sha256}`);
  }
  console.log(`- synthetic-low-reuse-${SYNTHETIC_UNIQUE_GEOMETRIES}x2 | generated | two instances per unique SphereGeometry`);
  console.log('\n| scene | meshes | runs | classify median/p95 | canonicalize+flip median/p95 | addGeometry median/p95 | instances median/p95 | self total median/p95 | long tasks median/p95 | peak heap |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    console.log(`| ${row.name} | ${row.meshCount} | ${row.runs} | ${fmt(row.self['classify/partition'].median)}/${fmt(row.self['classify/partition'].p95)} ms | ${fmt(row.self['canonicalize+flip'].median)}/${fmt(row.self['canonicalize+flip'].p95)} ms | ${fmt(row.self.addGeometry.median)}/${fmt(row.self.addGeometry.p95)} ms | ${fmt(row.self.instances.median)}/${fmt(row.self.instances.p95)} ms | ${fmt(row.selfTotal.median)}/${fmt(row.selfTotal.p95)} ms | ${fmt(row.longTasks.count.median)}/${fmt(row.longTasks.count.p95)} | ${row.peakHeapBytes === null ? 'n/a' : `${fmt(row.peakHeapBytes / 1048576)} MiB`} |`);
  }
  console.log('\nJSON:');
  console.log(JSON.stringify({ environment, corpus, synthetic: { uniqueGeometries: SYNTHETIC_UNIQUE_GEOMETRIES, reuse: 2 }, rows }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
