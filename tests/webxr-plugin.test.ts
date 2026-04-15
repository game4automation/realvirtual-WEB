// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, afterEach, vi } from 'vitest';
import { mockNavigatorXR, clearNavigatorXR } from './mocks/webxr-mock';
import { WebXRPlugin } from '../src/plugins/webxr-plugin';
import { Box3, Vector3 } from 'three';

// Minimal stubs for LoadResult and RVViewer used by the plugin
function makeStubViewer() {
  const listeners: Record<string, Function[]> = {};
  const renderer = {
    xr: {
      enabled: true,
      setSession: vi.fn(),
      isPresenting: false,
      addEventListener: vi.fn((event: string, cb: Function) => {
        (listeners[event] ??= []).push(cb);
      }),
      removeEventListener: vi.fn(),
      getController: vi.fn(() => ({
        add: vi.fn(),
        addEventListener: vi.fn(),
        getWorldPosition: vi.fn((v: any) => v),
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
      })),
      getControllerGrip: vi.fn(() => ({
        add: vi.fn(),
        addEventListener: vi.fn(),
      })),
      getCamera: vi.fn(() => ({
        getWorldQuaternion: vi.fn((q: any) => q),
      })),
      getSession: vi.fn(() => null),
    },
    domElement: document.createElement('canvas'),
  };
  const scene = {
    add: vi.fn(),
    remove: vi.fn(),
    background: null,
  };
  const camera = {
    position: new Vector3(3, 2.5, 4),
  };
  return { renderer, scene, camera, _xrListeners: listeners } as unknown as {
    renderer: import('three').WebGLRenderer;
    scene: import('three').Scene;
    camera: import('three').PerspectiveCamera;
    _xrListeners: Record<string, Function[]>;
  };
}

const stubLoadResult = {
  boundingBox: new Box3(new Vector3(-1, 0, -1), new Vector3(1, 2, 1)),
} as import('../src/core/engine/rv-scene-loader').LoadResult;

describe('WebXRPlugin', () => {
  afterEach(() => {
    clearNavigatorXR();
    document.querySelectorAll('button').forEach((b) => b.remove());
  });

  test('creates VR button when VR is supported on headset browser', async () => {
    mockNavigatorXR({ vr: true, ar: false });
    // Simulate a Quest browser user agent so isHeadsetBrowser() returns true
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 12; Quest 3) AppleWebKit/537.36', configurable: true });

    const plugin = new WebXRPlugin();
    const viewer = makeStubViewer();

    plugin.onModelLoaded(stubLoadResult, viewer as any);
    await new Promise((r) => setTimeout(r, 50));

    const buttons = document.querySelectorAll('body > *[style*="fixed"]');
    expect(buttons.length).toBeGreaterThanOrEqual(1);

    plugin.dispose();
    Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
  });

  test('skips VR button on non-headset browser', async () => {
    mockNavigatorXR({ vr: true, ar: false });
    const plugin = new WebXRPlugin();
    const viewer = makeStubViewer();

    plugin.onModelLoaded(stubLoadResult, viewer as any);
    await new Promise((r) => setTimeout(r, 50));

    // No overlay buttons on desktop/mobile browsers
    const buttons = document.querySelectorAll('body > *[style*="fixed"]');
    expect(buttons.length).toBe(0);

    plugin.dispose();
  });

  test('does nothing when VR is not supported', async () => {
    clearNavigatorXR();
    const plugin = new WebXRPlugin();
    const viewer = makeStubViewer();

    plugin.onModelLoaded(stubLoadResult, viewer as any);
    await new Promise((r) => setTimeout(r, 50));

    const buttons = document.querySelectorAll('body > *[style*="fixed"]');
    expect(buttons.length).toBe(0);

    plugin.dispose();
  });

  test('only initializes once across multiple model loads', async () => {
    mockNavigatorXR({ vr: true, ar: false });
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Quest 3)', configurable: true });

    const plugin = new WebXRPlugin();
    const viewer = makeStubViewer();

    plugin.onModelLoaded(stubLoadResult, viewer as any);
    plugin.onModelLoaded(stubLoadResult, viewer as any);
    await new Promise((r) => setTimeout(r, 50));

    const buttons = document.querySelectorAll('body > *[style*="fixed"]');
    expect(buttons.length).toBeLessThanOrEqual(1);

    plugin.dispose();
    Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
  });

  test('dispose cleans up button and restores camera', async () => {
    mockNavigatorXR({ vr: true, ar: false });
    const origUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Quest 3)', configurable: true });

    const plugin = new WebXRPlugin();
    const viewer = makeStubViewer();

    plugin.onModelLoaded(stubLoadResult, viewer as any);
    await new Promise((r) => setTimeout(r, 50));

    plugin.dispose();

    const buttons = document.querySelectorAll('body > *[style*="fixed"]');
    expect(buttons.length).toBe(0);
    expect(viewer.scene.add).toHaveBeenCalled();
    Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
  });

  test('onRender does nothing when not presenting', async () => {
    mockNavigatorXR({ vr: true, ar: false });
    const plugin = new WebXRPlugin();
    const viewer = makeStubViewer();

    plugin.onModelLoaded(stubLoadResult, viewer as any);
    await new Promise((r) => setTimeout(r, 50));

    expect(() => plugin.onRender(0.016)).not.toThrow();

    plugin.dispose();
  });
});
