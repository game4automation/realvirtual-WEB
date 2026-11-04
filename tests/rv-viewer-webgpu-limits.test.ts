// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-762 § 9.11 — WebGPU boot limits (F14), with a mocked `navigator.gpu`
 * and a mocked renderer constructor.
 *
 *  - not internal (community / customer build, `__RV_INTERNAL__ === false`, or
 *    the `webgpu-gl` kind): no adapter request before the renderer, no
 *    `requiredLimits`;
 *  - internal: the four limits from `adapter.limits`, adapter requested with
 *    the options three r185 uses (`featureLevel: 'compatibility'`);
 *  - `init()` failure with limits → renderer disposed, ONE retry without
 *    limits, visible warning; a failing retry throws (→ the caller's WebGL
 *    fallback); a failure without limits throws at once (no retry).
 *
 * The F17 gate half of § 9.11 (wireframe → no frame(), mix 0) lives in
 * rv-raytraced-hook.test.ts with the real viewer.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  initWebGPURendererWithLimits,
  WEBGPU_ADAPTER_OPTIONS,
  WEBGPU_REQUIRED_LIMIT_NAMES,
} from '../src/core/rv-viewer';

const ADAPTER_LIMITS = {
  maxStorageBufferBindingSize: 2_147_483_644,
  maxBufferSize: 2_147_483_648,
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 32_768,
  maxColorAttachmentBytesPerSample: 128, // not requested
};

function mockGpu(limits: Record<string, number> | null = ADAPTER_LIMITS) {
  return {
    requestAdapter: vi.fn(async () => (limits ? { limits } : null) as unknown as GPUAdapter),
  };
}

interface FakeRenderer {
  extra: { requiredLimits?: Record<string, number> };
  init: ReturnType<typeof vi.fn<() => Promise<void>>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

/** `failures[i]` = whether the i-th constructed renderer's init() rejects. */
function mockCreate(failures: boolean[]) {
  const made: FakeRenderer[] = [];
  const create = vi.fn((extra: { requiredLimits?: Record<string, number> }) => {
    const idx = made.length;
    const fail = failures[idx] ?? false;
    const r: FakeRenderer = {
      extra,
      init: vi.fn<() => Promise<void>>(async () => { if (fail) throw new Error(`init ${idx} failed`); }),
      dispose: vi.fn<() => void>(),
    };
    made.push(r);
    return r;
  });
  return { create, made };
}

describe('WebGPU boot limits (plan-762 F14)', () => {
  it('community build: no adapter request, no requiredLimits', async () => {
    const gpu = mockGpu();
    const { create, made } = mockCreate([false]);
    const r = await initWebGPURendererWithLimits({ internal: false, gpu, create });
    expect(gpu.requestAdapter).not.toHaveBeenCalled();
    expect(made).toHaveLength(1);
    expect(made[0].extra).toEqual({});
    expect(r).toBe(made[0]);
  });

  it('internal build: the four adapter limits, adapter options identical to three', async () => {
    const gpu = mockGpu();
    const { create, made } = mockCreate([false]);
    const r = await initWebGPURendererWithLimits({ internal: true, gpu, create });
    expect(gpu.requestAdapter).toHaveBeenCalledTimes(1);
    expect(gpu.requestAdapter).toHaveBeenCalledWith(WEBGPU_ADAPTER_OPTIONS);
    expect(WEBGPU_ADAPTER_OPTIONS).toMatchObject({ featureLevel: 'compatibility', xrCompatible: false });
    expect(Object.keys(made[0].extra.requiredLimits ?? {}).sort()).toEqual([...WEBGPU_REQUIRED_LIMIT_NAMES].sort());
    expect(made[0].extra.requiredLimits).toEqual({
      maxStorageBufferBindingSize: 2_147_483_644,
      maxBufferSize: 2_147_483_648,
      maxStorageBuffersPerShaderStage: 10,
      maxComputeWorkgroupStorageSize: 32_768,
    });
    expect(r).toBe(made[0]);
  });

  it('init() failure with limits → dispose, warn, ONE retry without limits', async () => {
    const gpu = mockGpu();
    const { create, made } = mockCreate([true, false]);
    const warn = vi.fn();
    const r = await initWebGPURendererWithLimits({ internal: true, gpu, create, warn });
    expect(made).toHaveLength(2);
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
    expect(made[1].extra).toEqual({});
    expect(r).toBe(made[1]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/retrying once without requiredLimits/);
  });

  it('a failing retry throws (the caller falls back to WebGL) and disposes both renderers', async () => {
    const gpu = mockGpu();
    const { create, made } = mockCreate([true, true]);
    await expect(initWebGPURendererWithLimits({ internal: true, gpu, create, warn: () => {} })).rejects.toThrow(/init 1 failed/);
    expect(made).toHaveLength(2);
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
    expect(made[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('a failure without limits throws at once — no retry', async () => {
    const { create, made } = mockCreate([true]);
    await expect(initWebGPURendererWithLimits({ internal: false, gpu: mockGpu(), create })).rejects.toThrow(/init 0 failed/);
    expect(made).toHaveLength(1);
    expect(made[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('no adapter / no navigator.gpu → plain construction', async () => {
    const a = mockCreate([false]);
    await initWebGPURendererWithLimits({ internal: true, gpu: mockGpu(null), create: a.create });
    expect(a.made[0].extra).toEqual({});
    const b = mockCreate([false]);
    await initWebGPURendererWithLimits({ internal: true, gpu: undefined, create: b.create });
    expect(b.made[0].extra).toEqual({});
  });

  it('a throwing requestAdapter degrades to no limits with a warning', async () => {
    const gpu = { requestAdapter: vi.fn(async () => { throw new Error('blocked'); }) };
    const { create, made } = mockCreate([false]);
    const warn = vi.fn();
    await initWebGPURendererWithLimits({ internal: true, gpu, create, warn });
    expect(made[0].extra).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
