// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * renderer-kinds.test.ts — plan-271 test 9.2 (integration, F10 harness).
 *
 * Boots REAL viewers via `createTestViewer(kind)` and asserts the plan-271
 * semantics core finding on live instances:
 *
 *   webgl     → isWebGPU === false, hasCompute === false
 *   webgpu-gl → isWebGPU === true  AND hasCompute === false
 *               (WebGPURenderer with the WebGL2 backend — the whole point of
 *                the semantics change: GLSL consumers must treat it as WebGPU)
 *
 * Plus a GLB regression smoke: an existing model loads under webgl AND
 * webgpu-gl without console errors.
 *
 * The real 'webgpu' kind is NOT tested here — headless CI has no WebGPU
 * adapter; create() would silently fall back to webgl (compute suite 9.5 in a
 * later phase covers it locally, guarded by requestAdapter()).
 *
 * Plan-B note: if WebGPURenderer({forceWebGL:true}).init() ever becomes
 * unstable under headless SwiftShader, skip the webgpu-gl describes with a
 * reference to tests/helpers/create-test-viewer.ts (documented fallback).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const SMOKE_GLB_URL = '/models/EuropalletEmpty.glb';
const VIEWER_TEST_TIMEOUT = 60_000;

/**
 * Filter console.error calls down to load-relevant ones. Disposing the
 * previous test's viewer loses its WebGL context ASYNCHRONOUSLY — the
 * "[RVViewer] WebGL context lost" report can land during the NEXT test and is
 * expected teardown noise in a multi-viewer test file, not a load error.
 */
function unexpectedErrors(calls: unknown[][]): unknown[][] {
  return calls.filter(
    (c) => !(typeof c[0] === 'string' && c[0].includes('WebGL context lost')),
  );
}

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  vi.restoreAllMocks();
});

describe('renderer kinds (plan-271 phase 1)', () => {
  it('webgl: classic WebGLRenderer — isWebGPU=false, hasCompute=false', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    expect(viewer.rendererKind).toBe('webgl');
    expect(viewer.isWebGPU).toBe(false);
    expect(viewer.hasCompute).toBe(false);
    // Classic renderer must NOT be a WebGPURenderer instance
    expect((viewer.renderer as unknown as { isWebGPURenderer?: boolean }).isWebGPURenderer).toBeUndefined();
  }, VIEWER_TEST_TIMEOUT);

  it('webgpu-gl: WebGPURenderer(forceWebGL) — isWebGPU=true AND hasCompute=false (semantics core finding)', async () => {
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    expect(viewer.rendererKind).toBe('webgpu-gl');
    // THE core assertion of plan-271 review finding 1: the WebGL2 backend of
    // WebGPURenderer counts as isWebGPU (no GLSL paths!) but has NO compute.
    expect(viewer.isWebGPU).toBe(true);
    expect(viewer.hasCompute).toBe(false);
    // It really is a WebGPURenderer instance without the real WebGPU backend
    const r = viewer.renderer as unknown as { isWebGPURenderer?: boolean; backend?: { isWebGPUBackend?: boolean } };
    expect(r.isWebGPURenderer).toBe(true);
    expect(!!r.backend?.isWebGPUBackend).toBe(false);
  }, VIEWER_TEST_TIMEOUT);

  it('GLB smoke: existing model loads under webgl without console errors', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    handle = await createTestViewer('webgl');
    const result = await handle.viewer.loadModel(SMOKE_GLB_URL);
    expect(result).toBeTruthy();
    expect(handle.viewer.currentModelRoot).toBeTruthy();
    expect(unexpectedErrors(errors.mock.calls)).toEqual([]);
  }, VIEWER_TEST_TIMEOUT);

  it('GLB smoke: existing model loads under webgpu-gl without console errors', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    handle = await createTestViewer('webgpu-gl');
    const result = await handle.viewer.loadModel(SMOKE_GLB_URL);
    expect(result).toBeTruthy();
    expect(handle.viewer.currentModelRoot).toBeTruthy();
    expect(unexpectedErrors(errors.mock.calls)).toEqual([]);
  }, VIEWER_TEST_TIMEOUT);
});
