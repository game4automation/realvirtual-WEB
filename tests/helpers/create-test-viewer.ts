// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * create-test-viewer — F10 full-viewer test harness (plan-271 Phase 1).
 *
 * Boots a REAL `RVViewer.create()` inside the headless Chromium used by the
 * vitest browser mode. This is deliberately different from the lightweight
 * mock in `tests/helpers/test-viewer.ts` (which never touches WebGL): use the
 * mock for logic-level tests, use THIS harness when the renderer path itself
 * is the subject under test (renderer kinds, TSL materials, readback).
 *
 * Contract:
 *  - a fixed-size container <div> is appended to document.body
 *  - `RVViewer.create()` is raced against an init timeout (default 15 s) so a
 *    hanging `WebGPURenderer.init()` fails the test instead of the suite
 *  - `dispose()` tears down the viewer AND removes the container — always call
 *    it (afterEach / finally), leaked contexts starve headless Chromium
 *
 * Plan-B (documented, plan-271 §5.4): if `WebGPURenderer({forceWebGL:true})`
 * `init()` ever proves unstable under headless SwiftShader in CI, downgrade
 * the affected suites to `describe.skip` with a reference to this note and
 * test the TSL materials on renderer-stub level instead. As of three 0.185.1
 * the forceWebGL path initializes on a plain WebGL2 context and works
 * headless.
 */

import { RVViewer, type RendererKind, type RVViewerOptions } from '../../src/core/rv-viewer';

export interface TestViewerHandle {
  viewer: RVViewer;
  container: HTMLElement;
  /** Dispose the viewer and remove the container. Safe to call once. */
  dispose(): void;
}

export interface CreateTestViewerOptions extends Omit<RVViewerOptions, 'renderer'> {
  /** Timeout for RVViewer.create() (WebGPURenderer.init() included). Default 15 000 ms. */
  initTimeoutMs?: number;
  /** Container size in px. Default 640×480. */
  width?: number;
  height?: number;
}

const DEFAULT_INIT_TIMEOUT_MS = 15_000;

/**
 * Create a real viewer of the given renderer kind for a browser-mode test.
 *
 *   const handle = await createTestViewer('webgpu-gl');
 *   try { ... } finally { handle.dispose(); }
 */
export async function createTestViewer(
  kind: RendererKind = 'webgl',
  options: CreateTestViewerOptions = {},
): Promise<TestViewerHandle> {
  const { initTimeoutMs, width, height, ...viewerOptions } = options;

  const container = document.createElement('div');
  container.style.cssText =
    `position:fixed; left:0; top:0; width:${width ?? 640}px; height:${height ?? 480}px;`;
  document.body.appendChild(container);

  const timeoutMs = initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `createTestViewer('${kind}'): RVViewer.create() did not resolve within ${timeoutMs} ms ` +
        '(headless renderer init hang — see Plan-B note in tests/helpers/create-test-viewer.ts)',
      )),
      timeoutMs,
    );
  });

  try {
    const viewer = await Promise.race([
      RVViewer.create(container, {
        renderer: kind,
        ground: false,
        autoResize: false,
        ...viewerOptions,
      }),
      timeout,
    ]);

    let disposed = false;
    return {
      viewer,
      container,
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          viewer.dispose();
        } catch (err) {
          console.warn('[create-test-viewer] viewer.dispose() threw during teardown:', err);
        }
        container.remove();
      },
    };
  } catch (err) {
    container.remove();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Async pixel readback ────────────────────────────────────────────────

/** Minimal render-target shape accepted by both renderer families. */
export interface ReadbackTarget { width: number; height: number }

/**
 * Read back RGBA8 pixels from a render target — async-first.
 *
 * Under `WebGPURenderer` (both backends) there is NO synchronous
 * `readRenderTargetPixels` — only `readRenderTargetPixelsAsync()` exists
 * (plan-271 research note). The classic `WebGLRenderer` has had the async
 * variant since r168 too, so the async path is universal; the sync call is
 * kept only as a defensive fallback.
 *
 * SIGNATURE TRAP (found in plan-271 Phase 2): the two renderer families
 * disagree on the 6th parameter —
 *   WebGLRenderer:  readRenderTargetPixelsAsync(rt, x, y, w, h, BUFFER)
 *   WebGPURenderer: readRenderTargetPixelsAsync(rt, x, y, w, h, TEXTURE_INDEX)
 * Passing a buffer to the WebGPU variant crashes deep in the backend
 * ("Invalid value used as weak map key"), so the branches stay separate.
 */
export async function readRenderTargetPixelsAsync(
  viewer: RVViewer,
  target: ReadbackTarget,
  x = 0,
  y = 0,
  width = target.width,
  height = target.height,
): Promise<Uint8Array> {
  const renderer = viewer.renderer as unknown as {
    isWebGPURenderer?: boolean;
    readRenderTargetPixelsAsync?: (
      t: ReadbackTarget, x: number, y: number, w: number, h: number,
      bufferOrTextureIndex?: Uint8Array | number,
    ) => Promise<ArrayBufferView | void>;
    readRenderTargetPixels?: (
      t: ReadbackTarget, x: number, y: number, w: number, h: number, b: Uint8Array,
    ) => void;
  };

  if (renderer.isWebGPURenderer === true
    && typeof renderer.readRenderTargetPixelsAsync === 'function') {
    // WebGPURenderer allocates + returns the typed array itself.
    const result = await renderer.readRenderTargetPixelsAsync(target, x, y, width, height);
    if (result instanceof Uint8Array) return result;
    if (result && ArrayBuffer.isView(result)) {
      return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
    }
    throw new Error('[create-test-viewer] WebGPU readback returned no pixel data');
  }

  const buffer = new Uint8Array(width * height * 4);
  if (typeof renderer.readRenderTargetPixelsAsync === 'function') {
    await renderer.readRenderTargetPixelsAsync(target, x, y, width, height, buffer);
    return buffer;
  }
  if (typeof renderer.readRenderTargetPixels === 'function') {
    renderer.readRenderTargetPixels(target, x, y, width, height, buffer);
    return buffer;
  }
  throw new Error('[create-test-viewer] Renderer exposes no readRenderTargetPixels(Async) API');
}
