// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Skip-with-a-reason for suites that need a real WebGPU adapter (2026-10-16).
 *
 * `describe.skipIf(!adapter)` skips at collection and carries NO note, so the run's
 * `[test-skips]` line (scripts/test-progress-reporter.mjs) could only list these tests as
 * `no reason given: <file>`. Calling `skipEachWithoutAdapter(adapter)` as the FIRST
 * statement of a plain `describe` skips every test of it through `ctx.skip(note)` in a
 * `beforeEach` instead — still skipped without an adapter, unchanged with one — and the
 * note reaches the reporter as `TestCase.result().note`, so the line groups them as
 * `N no WebGPU adapter (main suite runs without GPU — covered by npm run test:gpu)`.
 *
 * Under `npm run test:gpu` (vitest.gpu.config.ts) a missing adapter is NOT a skip: the GPU
 * group's setup file (`tests/helpers/gpu-run-setup.ts`) marks the run, and the same
 * `beforeEach` then FAILS the test with {@link GPU_RUN_WITHOUT_ADAPTER} — otherwise the group
 * would skip everything and report green.
 *
 * Unlike `describe.skipIf`, the suite's own `beforeAll` / `afterAll` / `afterEach` hooks
 * DO run without an adapter, so a suite using this guards its setup with `if (!adapter) return`.
 * Public and private (`realvirtual-WebViewer-Private~/tests/cinematic-*.test.ts`) suites use it;
 * the files are listed in `tests/gpu-tests.json`.
 */

import { beforeEach } from 'vitest';

/**
 * The skip note of every test that needs a WebGPU adapter — in the MAIN browser suite.
 *
 * The cause is configuration, not hardware: headless Chromium in vitest renders with SwiftShader
 * and returns no WebGPU adapter, while `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`
 * gives the same machine its real GPU and an adapter (measured plan-602, 2026-10-15, GTX 1060).
 * The main suite deliberately runs WITHOUT those flags (every baseline — inventory, red set,
 * run time — was measured that way); the GPU run is the separate, serial `npm run test:gpu`
 * (vitest.gpu.config.ts, file list tests/gpu-tests.json, quarantine tests/webgpu-quarantine.json).
 */
export const NO_WEBGPU_ADAPTER = 'no WebGPU adapter (main suite runs without GPU — covered by npm run test:gpu)';

/**
 * The failure of a test in the GPU run (`npm run test:gpu`) when there is no adapter after all.
 * `scripts/test-gpu-run.mjs` recognises it by this text and prints the `[gpu-run]` verdict.
 */
export const GPU_RUN_WITHOUT_ADAPTER = 'GPU group without a WebGPU adapter — flags not applied or driver/blocklist';

/** The global the GPU group's setup file sets before every test file (`tests/helpers/gpu-run-setup.ts`). */
export const GPU_RUN_FLAG = '__rvTestGpuRun';

/** True inside `npm run test:gpu` (the setup file of vitest.gpu.config.ts ran in this context). */
export function isGpuRun(): boolean {
  return (globalThis as Record<string, unknown>)[GPU_RUN_FLAG] === true;
}

/**
 * Skips each test of the enclosing `describe` with {@link NO_WEBGPU_ADAPTER} when `adapter` is
 * falsy — or, in the GPU run, fails it with {@link GPU_RUN_WITHOUT_ADAPTER}.
 */
export function skipEachWithoutAdapter(adapter: unknown): void {
  beforeEach((ctx) => {
    if (adapter) return;
    if (isGpuRun()) throw new Error(GPU_RUN_WITHOUT_ADAPTER);
    ctx.skip(NO_WEBGPU_ADAPTER);
  });
}
