// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-568 — "Frame rate limit" setting: store field + validation, persistence
 * in the `rv-visual-settings` blob, the Visual tab control, and the real
 * viewer wiring (setter → loop interval, applyVisualSettings at boot, preset
 * switch keeps the cap, XR / capture guards, screenshots unaffected,
 * time-based camera damping, camera animation ends correctly under a cap).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Vector3 } from 'three';
import {
  loadVisualSettings, saveVisualSettings, getDefaultVisualSettings,
  isFpsCap, fpsCapToFrameInterval, type FpsCap,
} from '../src/core/hmi/visual-settings-store';
import { applyVisualPreset, VISUAL_PRESET_FIELDS, type VisualPreset } from '../src/core/hmi/visual-presets';
import { setAppConfig } from '../src/core/rv-app-config';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { VisualTab } from '../src/core/hmi/settings/VisualTab';
import { timeScaledDampingFactor, DAMPING_REFERENCE_HZ } from '../src/core/rv-camera-manager';
import { visualTabCapableFake } from './helpers/fake-render-viewer';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { RVViewerPlugin } from '../src/core/rv-plugin';

const KEY = 'rv-visual-settings';

beforeEach(() => { localStorage.clear(); setAppConfig({}); });
afterEach(() => { cleanup(); localStorage.clear(); setAppConfig({}); });

describe('store: fpsCap', () => {
  it('defaults to 0 (Off)', () => {
    expect(loadVisualSettings().fpsCap).toBe(0);
    expect(getDefaultVisualSettings().fpsCap).toBe(0);
  });

  it('an invalid stored value falls back to 0', () => {
    for (const bad of [45, '60', -1, null, 120, true]) {
      localStorage.setItem(KEY, JSON.stringify({ fpsCap: bad }));
      expect(loadVisualSettings().fpsCap).toBe(0);
    }
  });

  it('persists 30 / 60 in the rv-visual-settings blob', () => {
    for (const cap of [30, 60] as FpsCap[]) {
      saveVisualSettings({ ...loadVisualSettings(), fpsCap: cap });
      expect(JSON.parse(localStorage.getItem(KEY)!).fpsCap).toBe(cap);
      expect(loadVisualSettings().fpsCap).toBe(cap);
    }
  });

  it('validator and interval helper', () => {
    expect(isFpsCap(0) && isFpsCap(30) && isFpsCap(60)).toBe(true);
    expect(isFpsCap(45)).toBe(false);
    expect(fpsCapToFrameInterval(0)).toBe(0);
    expect(fpsCapToFrameInterval(30)).toBeCloseTo(1 / 30, 12);
    expect(fpsCapToFrameInterval(60)).toBeCloseTo(1 / 60, 12);
  });

  it('is not a preset field (a preset never changes the cap)', () => {
    expect((VISUAL_PRESET_FIELDS as readonly string[]).includes('fpsCap')).toBe(false);
  });
});

describe('VisualTab: Frame rate limit', () => {
  it('renders Off / 30 / 60 and persists + applies the choice', () => {
    const viewer = visualTabCapableFake({ renderMode: 'default' }) as unknown as { fpsCap?: number };
    render(createElement(RVViewerProvider, { value: viewer as never }, createElement(VisualTab)));
    expect(screen.getByText('Frame rate limit')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Frame rate limit' });
    const off = group.querySelector('button[value="0"]') as HTMLButtonElement;
    const b30 = group.querySelector('button[value="30"]') as HTMLButtonElement;
    const b60 = group.querySelector('button[value="60"]') as HTMLButtonElement;
    expect(off.textContent).toBe('Off');
    expect(off.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(b30);
    expect(viewer.fpsCap).toBe(30);
    expect(loadVisualSettings().fpsCap).toBe(30);
    fireEvent.click(b60);
    expect(viewer.fpsCap).toBe(60);
    expect(JSON.parse(localStorage.getItem(KEY)!).fpsCap).toBe(60);
    fireEvent.click(off);
    expect(viewer.fpsCap).toBe(0);
    expect(loadVisualSettings().fpsCap).toBe(0);
  });
});

describe('camera damping is time-based', () => {
  it('the same decay over one second at 30, 60 and 144 frames per second', () => {
    const f = 0.2;
    const remaining = (hz: number) => {
      let v = 1;
      for (let i = 0; i < hz; i++) v *= 1 - timeScaledDampingFactor(f, 1 / hz);
      return v;
    };
    const ref = Math.pow(1 - f, DAMPING_REFERENCE_HZ);
    for (const hz of [30, 60, 144]) expect(remaining(hz)).toBeCloseTo(ref, 10);
    expect(timeScaledDampingFactor(f, 1 / 60)).toBeCloseTo(f, 12);
    expect(timeScaledDampingFactor(f, 0)).toBe(0);
  });
});

// ── Real viewer ───────────────────────────────────────────────────────────

type LoopView = {
  minFrameInterval: number;
  shouldThrottle: (() => boolean) | null;
  renderCapSuppressed: boolean;
};

describe('RVViewer wiring', () => {
  let handle: TestViewerHandle;
  let viewer: RVViewer;
  const loop = (): LoopView => viewer.loop as unknown as LoopView;

  beforeAll(async () => {
    handle = await createTestViewer('webgl', { width: 320, height: 240 });
    viewer = handle.viewer;
  }, 120_000);
  afterAll(() => handle?.dispose());
  afterEach(() => { viewer.fpsCap = 0; });

  it('the setter sets the loop interval; an unsupported value means Off', () => {
    viewer.fpsCap = 30;
    expect(loop().minFrameInterval).toBeCloseTo(1 / 30, 12);
    viewer.fpsCap = 60;
    expect(loop().minFrameInterval).toBeCloseTo(1 / 60, 12);
    viewer.fpsCap = 45 as FpsCap;
    expect(viewer.fpsCap).toBe(0);
    expect(loop().minFrameInterval).toBe(0);
  });

  it('reload with a stored cap: the boot path (loadVisualSettings → applyVisualSettings) applies it', () => {
    saveVisualSettings({ ...loadVisualSettings(), fpsCap: 30 });
    viewer.applyVisualSettings(loadVisualSettings());
    expect(viewer.fpsCap).toBe(30);
    expect(loop().minFrameInterval).toBeCloseTo(1 / 30, 12);
  });

  it('a preset switch leaves the cap unchanged', () => {
    saveVisualSettings({ ...loadVisualSettings(), fpsCap: 60 });
    viewer.applyVisualSettings(loadVisualSettings());
    const preset: VisualPreset = {
      name: 'test-preset', schemaVersion: 1,
      settings: { renderMode: 'simple', maxDpr: 1 } as unknown as VisualPreset['settings'],
    };
    applyVisualPreset(viewer, preset);
    expect(loadVisualSettings().fpsCap).toBe(60);
    expect(viewer.fpsCap).toBe(60);
  });

  it('guard: no cap while XR presents or a capture runs', () => {
    const guard = loop().shouldThrottle!;
    expect(guard()).toBe(true);
    const xr = (viewer.renderer as unknown as { xr: { isPresenting: boolean } }).xr;
    xr.isPresenting = true;
    try { expect(guard()).toBe(false); } finally { xr.isPresenting = false; }
    expect(guard()).toBe(true);
    const v = viewer as unknown as { _capture: unknown };
    v._capture = {};
    try { expect(guard()).toBe(false); } finally { v._capture = null; }
    expect(guard()).toBe(true);
  });

  it('screenshots (renderFrameForCapture) render synchronously regardless of the cap', () => {
    viewer.fpsCap = 30;
    let rendered = 0;
    const probe = { id: 'fps-cap-capture-probe', onRender: () => { rendered++; } } as unknown as RVViewerPlugin;
    viewer.use(probe);
    try {
      for (let i = 0; i < 5; i++) expect(viewer.renderFrameForCapture()).toBe(true);
      expect(rendered).toBe(5);
    } finally {
      viewer.removePlugin('fps-cap-capture-probe');
    }
  });

  it('damping budget after a released drag is held in seconds', () => {
    viewer.controls.dispatchEvent({ type: 'end' } as never);
    const secs = (viewer as unknown as { _dampingSecondsRemaining: number })._dampingSecondsRemaining;
    const f = viewer.controls.dampingFactor;
    const frames = Math.min(Math.ceil(Math.log(0.01) / Math.log(1 - f)), 300);
    expect(secs).toBeCloseTo(frames / 60, 12);
  });

  it('a camera animation ends at its target under a 30 FPS cap', async () => {
    // Earlier tests switched render modes: let the env-map (IBL) work settle.
    // Note: headless Chromium may pause rAF for ~2 s after frames that draw
    // nothing (render-on-demand); the generous timeout absorbs that.
    await viewer.whenLoadingIdle();
    viewer.fpsCap = 30;
    const target = new Vector3(0, 0, 0);
    const to = viewer.camera.position.clone().add(new Vector3(3, 2, 1));
    viewer.animateCameraTo(to, target, 0.25);
    expect(viewer.isCameraAnimating).toBe(true);
    const t0 = performance.now();
    while (viewer.isCameraAnimating && performance.now() - t0 < 10000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(viewer.isCameraAnimating).toBe(false);
    expect(viewer.camera.position.distanceTo(to)).toBeLessThan(1e-3);
  }, 20_000);
});
