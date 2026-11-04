// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The GPU group (`npm run test:gpu`, 2026-10-17) — the pieces `vitest.gpu.config.ts` is built
 * from, kept here so `tests/test-gpu-run.node.test.ts` can check them without loading the
 * config (which would load vite.config.ts and all its plugins).
 *
 * Why a separate run: the main browser suite runs headless Chromium on SwiftShader (no WebGPU
 * adapter) and every baseline was measured that way. The WebGPU files (tests/gpu-tests.json)
 * need the real GPU, which only these Chromium launch args give (measured plan-602, 2026-10-15,
 * GTX 1060 / 560.94). The dropped plan-602 part B split the main suite into projects — cold Vite
 * cache per project, mid-run re-optimisation, double wall time (reverted 77111c0d). This run
 * leaves the main suite alone: its own config file, its own cache dir, one worker.
 *
 * Contents:
 *  - GPU_LAUNCH_ARGS / GPU_BROWSER_CHANNEL / GPU_CACHE_DIR / GPU_SETUP_FILE / GPU_TEST_LIST — the config's constants;
 *  - gpuTestFiles() — the include list from tests/gpu-tests.json (private entries only with
 *    the private sibling);
 *  - classifyGpuRun() / formatGpuRunSummary() — the end-of-run summary that separates
 *    failures INSIDE the quarantine baseline (tests/webgpu-quarantine.json) from those OUTSIDE it;
 *  - GpuRunReporter + gpuRunReporterPlugin() — prints that summary (stderr) and fails the run
 *    when the group ran without an adapter.
 *
 * Not staged into deliveries (scripts/_workspace-lib.mjs lists neither this file nor
 * vitest.gpu.config.ts; tests/ is not staged either). No relative imports.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Chromium launch args of the GPU group: ANGLE on D3D11, hardware GPU, no blocklist. Handed to
 * the PROVIDER (`playwright({ launchOptions: { args } })`), because vitest 4.0.18 does not forward
 * `browser.instances[].launchOptions` — the provider launches with its own factory options.
 */
export const GPU_LAUNCH_ARGS = Object.freeze(['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']);
/**
 * Playwright channel of the GPU group: the FULL Chromium build in new headless mode instead of
 * Playwright's default headless binary `chromium-headless-shell`. Measured 2026-10-17
 * (rv-tmp/gpu-group/probe.log): with the headless shell the WebGPU adapter is healthy
 * (nvidia/pascal), but `adapter.requestDevice()` fails even without a descriptor —
 * `DynamicLib.Open: dxil.dll Windows Error: 87 at EnsureDXCLibraries` — because
 * chrome-headless-shell-win64/ ships no dxil.dll / dxcompiler.dll, so Dawn's D3D12 backend cannot
 * create a device and three silently falls back to WebGL2 (kind 'webgpu-gl', no compute). The full
 * chromium-<rev>/chrome-win64/ ships both. playwright-core 1.58 `Chromium.getExecutableName`:
 * channel 'chromium' → executable "chromium" (headless or not); no channel + headless →
 * "chromium-headless-shell". Passed through untouched by @vitest/browser-playwright
 * (`launchOptions` spread into `playwright.chromium.launch`).
 */
export const GPU_BROWSER_CHANNEL = 'chromium';
/** The GPU group's own Vite cache — never the main suite's `node_modules/.vite`. */
export const GPU_CACHE_DIR = 'node_modules/.vite-gpu';
/** The GPU group's setup file (marks the run, prints the backend, throws without an adapter). */
export const GPU_SETUP_FILE = './tests/helpers/gpu-run-setup.ts';
/** The one file list of the GPU group. */
export const GPU_TEST_LIST = 'tests/gpu-tests.json';
/** The quarantine list (read, never written). */
export const QUARANTINE_LIST = 'tests/webgpu-quarantine.json';
/** The private sibling as the lists spell it. */
export const PRIVATE_PREFIX = '../realvirtual-WebViewer-Private~/';
/** Recognises GPU_RUN_WITHOUT_ADAPTER (tests/helpers/webgpu-adapter-skip.ts) in an error message. */
export const NO_ADAPTER_MARK = 'GPU group without a WebGPU adapter';
/** The quarantine helper's "body passed" failure (tests/helpers/quarantine.ts). */
export const NOW_PASSES_MARK = 'quarantined test now passes';

/** Same detection as vite.config.ts's first private candidate: the sibling's `src/` exists. */
export function hasPrivateSibling(root) {
  return existsSync(path.resolve(root, PRIVATE_PREFIX, 'src'));
}

/** `tests/gpu-tests.json` → `[{ file, why }]`. */
export function readGpuTests(root) {
  const list = JSON.parse(readFileSync(path.resolve(root, GPU_TEST_LIST), 'utf8'));
  return Array.isArray(list?.gpuTests) ? list.gpuTests : [];
}

/** The include list of the GPU group; private entries only when the sibling exists. */
export function gpuTestFiles({ root, hasPrivate = hasPrivateSibling(root) }) {
  return readGpuTests(root)
    .map((entry) => String(entry.file))
    .filter((file) => hasPrivate || !file.startsWith('../'));
}

/**
 * The deps-optimizer scan entries of the GPU group = the MAIN suite's test files (first GPU run,
 * 2026-10-17: 37 mid-run re-optimizations, one file reloaded into "No test suite found").
 *
 * In vitest browser mode the browser server's `optimizeDeps.entries` are the project's test
 * files — `project.globTestFiles()` over `test.include` / `test.exclude`, NOT the CLI filter
 * (@vitest/browser 4.0.18 dist/index.js, plugin `vitest:browser:tests`, `config()`). The main
 * suite's include reaches every HMI dependency at scan time; the GPU group's five files do not,
 * so the optimizer found react-dom/client, mqtt, @mui/icons-material/* … only while tests ran.
 * Handing the main suite's file list in as extra `optimizeDeps.entries` (vite concatenates the
 * arrays in mergeConfig) gives the GPU group the main suite's scan without running its files.
 *
 * Globbed exactly like vitest's `TestProject.globFiles` (tinyglobby, `dot`, `ignore: exclude`,
 * `expandDirectories: false`, slashed absolute paths) with vitest's own tinyglobby, resolved
 * from the vitest package. Concrete paths, no globs: vite's `globEntries` then takes all entries
 * as they are (no dynamic pattern → no glob, so its node_modules ignore drops none of vitest's).
 */
export async function mainSuiteEntries({ root, include, exclude = [] }) {
  const fromVitest = createRequire(createRequire(import.meta.url).resolve('vitest/package.json'));
  const { glob } = fromVitest('tinyglobby');
  const files = await glob([...include], { dot: true, cwd: root, ignore: [...exclude], expandDirectories: false });
  return files.map((file) => path.resolve(root, file).replace(/\\/g, '/')).sort();
}

/** The quarantine ids (`<file> :: <suite> > <title>`); empty when the list is absent. */
export function readQuarantineIds(root) {
  const file = path.resolve(root, QUARANTINE_LIST);
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8'));
  return (list?.webgpuQuarantine ?? []).map((e) => String(e.id));
}

const firstLine = (s) => String(s ?? '').split('\n')[0];

/**
 * Pure classification of one GPU run.
 * `tests`: `[{ id, state: 'passed'|'failed'|'skipped'|'pending', errors: string[] }]`
 * (`id` = `<file> :: <full name>`, the quarantine id shape); `fileErrors`: `[{ file, message }]`.
 * Inside the baseline a PASSED quarantined test is a reproduced known failure (quarantinedIt
 * turns the known cause into a pass); a FAILED one either now passes (remove it) or failed for
 * another cause (a different error, a hook, the timeout).
 */
export function classifyGpuRun({ tests = [], fileErrors = [], quarantineIds = [] }) {
  const quarantine = new Set(quarantineIds);
  const seen = new Set();
  const baseline = { reproduced: [], nowPasses: [], otherCause: [], skipped: [], notRun: [] };
  const outside = { passed: 0, failed: [], skipped: [] };
  let noAdapter = fileErrors.some((e) => String(e.message).includes(NO_ADAPTER_MARK));
  for (const t of tests) {
    const errors = (t.errors ?? []).map(String);
    if (errors.some((m) => m.includes(NO_ADAPTER_MARK))) noAdapter = true;
    if (quarantine.has(t.id)) {
      seen.add(t.id);
      if (t.state === 'passed') baseline.reproduced.push(t.id);
      else if (t.state === 'failed') {
        if (errors.some((m) => m.includes(NOW_PASSES_MARK))) baseline.nowPasses.push(t.id);
        else baseline.otherCause.push({ id: t.id, message: firstLine(errors[0]) });
      } else baseline.skipped.push(t.id);
    } else if (t.state === 'passed') outside.passed++;
    else if (t.state === 'failed') outside.failed.push({ id: t.id, message: firstLine(errors[0]) });
    else outside.skipped.push(t.id);
  }
  for (const id of quarantineIds) if (!seen.has(id)) baseline.notRun.push(id);
  return {
    baseline,
    outside,
    fileErrors: fileErrors.map((e) => ({ file: e.file, message: firstLine(e.message) })),
    noAdapter,
    quarantineSize: quarantine.size,
  };
}

/** The summary lines (`[gpu-run]` verdict, `[gpu-quarantine]` inside / outside, then details). */
export function formatGpuRunSummary(c) {
  const lines = [];
  lines.push(c.noAdapter
    ? `[gpu-run] FAILED: ${NO_ADAPTER_MARK} — flags not applied or driver/blocklist (see the [gpu-backend] lines)`
    : '[gpu-run] WebGPU adapter present');
  const b = c.baseline;
  lines.push(`[gpu-quarantine] inside the baseline (${c.quarantineSize}): ${b.reproduced.length} known failure reproduced, `
    + `${b.nowPasses.length} now pass (remove from the list), ${b.otherCause.length} failed for another cause, `
    + `${b.skipped.length} skipped, ${b.notRun.length} not run`);
  const o = c.outside;
  const fileErrs = c.fileErrors.length ? `, ${c.fileErrors.length} file error${c.fileErrors.length === 1 ? '' : 's'}` : '';
  lines.push(`[gpu-quarantine] outside the baseline: ${o.passed} passed, ${o.failed.length} failed, ${o.skipped.length} skipped${fileErrs}`);
  for (const id of b.nowPasses) lines.push(`[gpu-quarantine]   now passes: ${id}`);
  for (const f of b.otherCause) lines.push(`[gpu-quarantine]   baseline, other cause: ${f.id} — ${f.message}`);
  for (const id of b.skipped) lines.push(`[gpu-quarantine]   baseline, skipped: ${id}`);
  for (const id of b.notRun) lines.push(`[gpu-quarantine]   baseline, not run: ${id}`);
  for (const f of o.failed) lines.push(`[gpu-quarantine]   outside, failed: ${f.id} — ${f.message}`);
  for (const id of o.skipped) lines.push(`[gpu-quarantine]   outside, skipped: ${id}`);
  for (const f of c.fileErrors) lines.push(`[gpu-quarantine]   file error: ${f.file} — ${f.message}`);
  return lines;
}

const messageOf = (err) => String(err?.message ?? err ?? '');

/** vitest TestModules → the input of classifyGpuRun (ids relative to `root`). */
export function collectGpuRun(testModules, root) {
  const tests = [];
  const fileErrors = [];
  for (const module of testModules ?? []) {
    const file = path.relative(root, String(module.moduleId ?? '')).replace(/\\/g, '/') || String(module.moduleId);
    const moduleErrors = typeof module.errors === 'function' ? module.errors() : [];
    for (const err of moduleErrors) fileErrors.push({ file, message: messageOf(err) });
    for (const test of module.children.allTests()) {
      const result = test.result() ?? {};
      tests.push({ id: `${file} :: ${test.fullName}`, state: result.state, errors: (result.errors ?? []).map(messageOf) });
    }
  }
  return { tests, fileErrors };
}

const stderrLine = (line) => process.stderr.write(`${line}\n`);
/** Marks a GpuRunReporter across module instances (the config is bundled more than once per process). */
const REPORTER_MARK = Symbol.for('rv.testGpuRunReporter');

/** Prints the GPU summary at run end; a run without an adapter ends non-zero. */
export class GpuRunReporter {
  constructor({ log = stderrLine, failRun = () => { process.exitCode = 1; } } = {}) {
    this.log = log;
    this.failRun = failRun;
    this.root = process.cwd();
    this[REPORTER_MARK] = true;
  }

  onInit(vitest) {
    if (vitest?.config?.root) this.root = vitest.config.root;
  }

  onTestRunEnd(testModules) {
    let c;
    try {
      c = classifyGpuRun({ ...collectGpuRun(testModules, this.root), quarantineIds: readQuarantineIds(this.root) });
    } catch (err) {
      this.log(`[gpu-run] summary unavailable: ${messageOf(err)}`);
      return;
    }
    for (const line of formatGpuRunSummary(c)) this.log(line);
    if (c.noAdapter) this.failRun();
  }
}

/** Vite plugin of vitest.gpu.config.ts ONLY: appends one GpuRunReporter to the resolved reporters. */
export function gpuRunReporterPlugin() {
  const seen = new WeakSet();
  return {
    name: 'rv-test-gpu-run',
    configureVitest({ vitest }) {
      const config = vitest.config;
      if (!config || seen.has(config) || !Array.isArray(config.reporters)) return;
      seen.add(config);
      if (config.reporters.some((r) => r?.[REPORTER_MARK])) return;
      config.reporters.push(new GpuRunReporter());
    },
  };
}
