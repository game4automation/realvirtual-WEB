// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Setup file of the GPU group ONLY (`npm run test:gpu`, vitest.gpu.config.ts) — never of the
 * main browser suite. Runs before every test file of the group, in that file's context:
 *
 *  1. marks the context as the GPU run ({@link GPU_RUN_FLAG}), so `skipEachWithoutAdapter`
 *     FAILS instead of skipping (tests/helpers/webgpu-adapter-skip.ts);
 *  2. prints which graphics backend this Chromium really got —
 *       `[gpu-backend] webgl=<UNMASKED_RENDERER> webgpu=adapter(<vendor>/<architecture>)|none device=ok|<error>`
 *     (on the dev PC it must name ANGLE D3D11 + the NVIDIA adapter; SwiftShader = the launch
 *     args did not arrive);
 *  3. throws {@link GPU_RUN_WITHOUT_ADAPTER} when `navigator.gpu.requestAdapter()` gives no
 *     adapter, which fails the file loudly instead of letting every test skip green;
 *  4. requests ONE device from the adapter (destroyed again) and throws when that fails. An
 *     adapter alone proves nothing: under chrome-headless-shell (no dxil.dll / dxcompiler.dll)
 *     the adapter was healthy but `requestDevice()` threw in Dawn's EnsureDXCLibraries, and three
 *     fell back to WebGL2 silently (measured 2026-10-17; fixed by GPU_BROWSER_CHANNEL).
 */

import { GPU_RUN_FLAG, GPU_RUN_WITHOUT_ADAPTER } from './webgpu-adapter-skip';

interface AdapterInfoLike { vendor?: string; architecture?: string; description?: string }
interface DeviceLike { destroy(): void }
interface AdapterLike { info?: AdapterInfoLike; requestDevice(): Promise<DeviceLike> }
interface GpuLike { requestAdapter(): Promise<AdapterLike | null> }

(globalThis as Record<string, unknown>)[GPU_RUN_FLAG] = true;

function webglRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  } catch (err) {
    return `error(${String(err)})`;
  }
}

const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
let adapterError = '';
const adapter = gpu
  ? await gpu.requestAdapter().catch((err: unknown) => {
    adapterError = String(err);
    return null;
  })
  : null;
let deviceError = '';
if (adapter) {
  try {
    (await adapter.requestDevice()).destroy();
  } catch (err) {
    deviceError = err instanceof Error ? err.message : String(err);
  }
}
const webgl = webglRenderer();
const webgpu = adapter
  ? `adapter(${adapter.info?.vendor || '?'}/${adapter.info?.architecture || '?'})`
  : 'none';
const device = adapter ? (deviceError || 'ok') : 'none';
console.log(`[gpu-backend] webgl=${webgl} webgpu=${webgpu} device=${device}`);

if (!adapter) {
  const why = !gpu
    ? 'navigator.gpu is missing'
    : adapterError
      ? `requestAdapter() threw: ${adapterError}`
      : 'requestAdapter() returned null';
  throw new Error(`${GPU_RUN_WITHOUT_ADAPTER} (${why}; webgl=${webgl})`);
}

if (deviceError) {
  throw new Error(`GPU group: WebGPU adapter present but requestDevice failed: ${deviceError}`);
}

export {};
