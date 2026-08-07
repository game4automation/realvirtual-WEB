// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Real-WebGPU regression coverage for the production combination that exposed
 * the r185 GTAO/MSAA shader failure: antialiasing, standard AO settings, and
 * the complete demo model. CI environments without an adapter skip the suite.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getDefaultVisualSettings } from '../src/core/hmi/visual-settings-store';

const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  vi.restoreAllMocks();
});

describe.skipIf(!adapter)('real WebGPU smoke', () => {
  it('renders the complete demo with standard AO and antialiasing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    handle = await createTestViewer('webgpu', { antialias: true, initTimeoutMs: 30_000 });
    expect(handle.viewer.rendererKind).toBe('webgpu');
    expect(handle.viewer.hasCompute).toBe(true);

    handle.viewer.applyVisualSettings(getDefaultVisualSettings());
    const result = await handle.viewer.loadModel('/models/DemoRealvirtualWeb.glb');
    expect(result).toBeTruthy();
    expect(handle.viewer.currentModelRoot).toBeTruthy();
    expect(errors.mock.calls).toEqual([]);
  }, 90_000);
});
