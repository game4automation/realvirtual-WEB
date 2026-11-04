// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-761 §9.1 — `setRenderMode` semantics (order, guards, persistence) and
 * the single-axis derivation `deriveRenderModeValue`.
 *
 * Every assertion here is a review finding turned into a test:
 *  - S1: persist BEFORE the setter emits `render-mode-changed`
 *  - S2: same mode without applied wireframe is a TRUE no-op (no recompile)
 *  - S3: the latent editor wireframe survives a shading click in viewer mode
 *  - S4: the ten lighting pre-pushes keep their order (dirLightEnabled before
 *    shadowEnabled) and run before the setter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setRenderMode, deriveRenderModeValue, renderModeLockReason, RENDER_MODE_LOCKED,
} from '../src/core/hmi/render-mode-controller';
import {
  loadVisualSettings, saveVisualSettings, getDefaultVisualSettings,
} from '../src/core/hmi/visual-settings-store';
import { setAppConfig } from '../src/core/rv-app-config';
import { registerRaytracedBackend } from '../src/core/engine/rv-raytraced-hook';
import { fakeRaytracedBackendFactory, fakeRenderViewer } from './helpers/fake-render-viewer';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const KEY = 'rv-visual-settings';
const VIEWER_TEST_TIMEOUT = 60_000;
/** A fake backend factory — Phase 1 never calls it, only its registration counts. */
const fakeBackendFactory = fakeRaytracedBackendFactory;
/** F18 test seam: the real-WebGPU flag of a webgpu-gl test viewer, overridden in place. */
const forceCompute = (h: TestViewerHandle): void => {
  Object.defineProperty(h.viewer, 'hasCompute', { value: true, configurable: true });
};

describe('setRenderMode', () => {
  beforeEach(() => { localStorage.clear(); setAppConfig({}); });
  afterEach(() => { setAppConfig({}); localStorage.clear(); });

  it('order: wireframe off → lighting pre-pushes (dirLightEnabled before shadowEnabled) → persist → renderMode → lightIntensity', () => {
    const v = fakeRenderViewer({ renderMode: 'default', wireframe: true, mode: 'editor' });
    let persistedAtSetter: string | undefined;
    const origSet = Object.getOwnPropertyDescriptor(v, 'renderMode')!.set!;
    Object.defineProperty(v, 'renderMode', {
      configurable: true,
      get: () => v._rm,
      set(m: string) { persistedAtSetter = loadVisualSettings().renderMode; origSet.call(v, m); },
    });

    setRenderMode(v, 'toon');

    const i = (s: string) => v.calls.findIndex((c) => c.startsWith(s));
    expect(i('wireframe=false')).toBeGreaterThanOrEqual(0);
    expect(i('wireframe=false')).toBeLessThan(i('toneMapping='));
    expect(i('dirLightEnabled=')).toBeLessThan(i('shadowEnabled='));
    expect(i('shadowEnabled=')).toBeLessThan(i('renderMode=toon'));
    expect(i('renderMode=toon')).toBeLessThan(i('lightIntensity='));
    // All ten pre-pushes happen, each exactly once, before the setter.
    for (const k of ['toneMapping', 'toneMappingExposure', 'ambientColor', 'ambientIntensity',
      'dirLightColor', 'dirLightIntensity', 'shadowIntensity', 'shadowQuality',
      'dirLightEnabled', 'shadowEnabled']) {
      const idx = i(`${k}=`);
      expect(idx, k).toBeGreaterThanOrEqual(0);
      expect(idx, k).toBeLessThan(i('renderMode=toon'));
      expect(v.calls.filter((c) => c.startsWith(`${k}=`)), k).toHaveLength(1);
    }
    expect(persistedAtSetter).toBe('toon'); // persisted BEFORE the setter emits the event
    expect(loadVisualSettings().renderMode).toBe('toon');
    expect(v.renderMode).toBe('toon');
  });

  it('pushes the per-mode lighting values of the TARGET mode', () => {
    const v = fakeRenderViewer({ renderMode: 'default' });
    const ms = loadVisualSettings().modeSettings.simple;
    setRenderMode(v, 'simple');
    expect(v.calls).toContain(`toneMapping=${ms.toneMapping}`);
    expect(v.calls).toContain(`toneMappingExposure=${ms.toneMappingExposure}`);
    expect(v.calls).toContain(`ambientColor=${ms.ambientColor}`);
    expect(v.calls).toContain(`dirLightEnabled=${ms.dirLightEnabled}`);
    expect(v.calls).toContain(`shadowEnabled=${ms.shadowEnabled}`);
    expect(v.calls).toContain(`lightIntensity=${ms.lightIntensity}`);
  });

  it('same mode without applied wireframe is a true no-op (no setter calls, no recompile trigger)', () => {
    const v = fakeRenderViewer({ renderMode: 'default' });
    setRenderMode(v, 'default');
    expect(v.calls).toEqual([]);
  });

  it('same mode with applied wireframe only leaves wireframe', () => {
    const v = fakeRenderViewer({ renderMode: 'default', wireframe: true, mode: 'editor' });
    setRenderMode(v, 'default');
    expect(v.calls).toContain('wireframe=false');
    expect(v.calls).toContain('renderMode=default');
    expect(v.wireframe).toBe(false);
    expect(v.renderMode).toBe('default');
  });

  it('latent editor wireframe survives a shading click in viewer mode', () => {
    const v = fakeRenderViewer({ renderMode: 'default', wireframe: true, mode: 'viewer' }); // toggle on, not applied
    setRenderMode(v, 'toon');
    expect(v.calls).not.toContain('wireframe=false');
    expect(v.wireframe).toBe(true);
    expect(v.renderMode).toBe('toon');
  });

  it('toon → wireframe → toon: leaving wireframe keeps toon as the shading mode', () => {
    const v = fakeRenderViewer({ renderMode: 'toon', mode: 'editor' });
    v.wireframe = true;
    expect(deriveRenderModeValue(v)).toBe('wireframe');
    setRenderMode(v, 'toon');
    expect(v.wireframe).toBe(false);
    expect(v.renderMode).toBe('toon');
    expect(deriveRenderModeValue(v)).toBe('toon');
  });

  it('never persists wireframe', () => {
    const v = fakeRenderViewer({ wireframe: true, mode: 'editor' });
    setRenderMode(v, 'simple');
    const stored = localStorage.getItem('rv-visual-settings');
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toMatch(/wireframe/);
    expect(JSON.parse(stored!).renderMode).toBe('simple');
  });

  it('reports a lock reason for lockedTabs visual AND lockSettings', () => {
    setAppConfig({ lockedTabs: ['visual'] });
    expect(renderModeLockReason()).toBe(RENDER_MODE_LOCKED);
    expect(renderModeLockReason()).toMatch(/locked/);
    setAppConfig({ lockSettings: true });
    expect(renderModeLockReason()).toMatch(/locked/);
    setAppConfig({ lockedTabs: ['model'] });
    expect(renderModeLockReason()).toBeNull();
    setAppConfig({});
    expect(renderModeLockReason()).toBeNull();
  });
});

describe('deriveRenderModeValue', () => {
  it('is wireframe only while wireframe is APPLIED (editor), otherwise renderMode', () => {
    const v = fakeRenderViewer({ renderMode: 'toon', wireframe: true, mode: 'viewer' });
    expect(deriveRenderModeValue(v)).toBe('toon');
    v.setMode('editor');
    expect(deriveRenderModeValue(v)).toBe('wireframe');
    v.setMode('viewer');
    expect(deriveRenderModeValue(v)).toBe('toon');
    expect(v.wireframe).toBe(true); // the toggle is untouched by the mode switch
  });
});

// ─── plan-762 §9.2: the ray traced gate on load, app-config override and direct calls ───

describe('setRenderMode — registry gate (plan-762)', () => {
  beforeEach(() => { localStorage.clear(); setAppConfig({}); });
  afterEach(() => { registerRaytracedBackend(null); setAppConfig({}); localStorage.clear(); });

  it('a direct raytraced call without compute resolves to the default mode', () => {
    registerRaytracedBackend(fakeBackendFactory);
    const v = fakeRenderViewer({ renderMode: 'toon', hasCompute: false });
    setRenderMode(v, 'raytraced');
    expect(v.renderMode).toBe('default');
    expect(loadVisualSettings().renderMode).toBe('default');
    expect(v.calls).not.toContain('renderMode=raytraced');
  });

  it('a direct raytraced call with compute but no backend resolves to the default mode', () => {
    const v = fakeRenderViewer({ renderMode: 'toon', hasCompute: true });
    setRenderMode(v, 'raytraced');
    expect(v.renderMode).toBe('default');
  });

  it('enters raytraced when compute AND a backend are present, and persists it', () => {
    registerRaytracedBackend(fakeBackendFactory);
    const v = fakeRenderViewer({ renderMode: 'default', hasCompute: true });
    setRenderMode(v, 'raytraced');
    expect(v.renderMode).toBe('raytraced');
    expect(loadVisualSettings().renderMode).toBe('raytraced');
  });

  it('MODE_DEFAULTS.raytraced has shadows off and survives a settings round-trip', () => {
    const def = getDefaultVisualSettings().modeSettings.raytraced;
    expect(def.shadowEnabled).toBe(false);
    expect(def.shadowIntensity).toBe(0);
    expect(def.dirLightEnabled).toBe(true);
    expect(def.toneMapping).toBe('neutral');
    // A first boot (nothing stored) already carries all four modes.
    expect(Object.keys(loadVisualSettings().modeSettings).sort()).toEqual(['default', 'raytraced', 'simple', 'toon']);
    const s = loadVisualSettings();
    saveVisualSettings({
      ...s,
      renderMode: 'raytraced',
      modeSettings: { ...s.modeSettings, raytraced: { ...s.modeSettings.raytraced, dirLightIntensity: 2.25 } },
    });
    const back = loadVisualSettings();
    expect(back.renderMode).toBe('raytraced');
    expect(back.modeSettings.raytraced.dirLightIntensity).toBe(2.25);
    expect(back.modeSettings.raytraced.shadowEnabled).toBe(false);
  });

  it('a stored three-mode settings object gains raytraced defaults on load', () => {
    localStorage.setItem(KEY, JSON.stringify({
      renderMode: 'toon',
      modeSettings: { simple: { lightIntensity: 0.9 }, default: { lightIntensity: 0.6 }, toon: { lightIntensity: 0.3 } },
    }));
    const s = loadVisualSettings();
    expect(s.modeSettings.toon.lightIntensity).toBe(0.3);
    expect(s.modeSettings.raytraced).toEqual(getDefaultVisualSettings().modeSettings.raytraced);
  });
});

describe('applyVisualSettings — persisted / app-config raytraced (plan-762 F3)', () => {
  let handle: TestViewerHandle | null = null;
  beforeEach(() => { localStorage.clear(); setAppConfig({}); });
  afterEach(() => {
    handle?.dispose(); handle = null;
    registerRaytracedBackend(null);
    setAppConfig({});
    localStorage.clear();
  });

  it('falls back to default and rewrites the store when raytraced is persisted without the gate', async () => {
    registerRaytracedBackend(fakeBackendFactory); // a backend alone is not enough — no compute
    handle = await createTestViewer('webgpu-gl');
    const { viewer } = handle;
    expect(viewer.hasCompute).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ renderMode: 'raytraced' }));
    viewer.applyVisualSettings(loadVisualSettings());
    expect(viewer.renderMode).toBe('default');
    expect(loadVisualSettings().renderMode).toBe('default');
    // Nothing is left pending — a later resolve changes nothing.
    viewer.resolvePendingRenderMode();
    expect(viewer.renderMode).toBe('default');
  }, VIEWER_TEST_TIMEOUT);

  it('keeps raytraced when the gate is satisfied', async () => {
    registerRaytracedBackend(fakeBackendFactory);
    handle = await createTestViewer('webgpu-gl');
    forceCompute(handle);
    const { viewer } = handle;
    expect(viewer.renderModeContext).toEqual({ hasCompute: true, backendRegistered: true });
    localStorage.setItem(KEY, JSON.stringify({ renderMode: 'raytraced' }));
    viewer.applyVisualSettings(loadVisualSettings());
    expect(viewer.renderMode).toBe('raytraced');
    expect(loadVisualSettings().renderMode).toBe('raytraced');
  }, VIEWER_TEST_TIMEOUT);

  it('leaves the store untouched while compute is present but no backend is registered yet, then resolves', async () => {
    handle = await createTestViewer('webgpu-gl');
    forceCompute(handle);
    const { viewer } = handle;
    localStorage.setItem(KEY, JSON.stringify({ renderMode: 'raytraced' }));
    viewer.applyVisualSettings(loadVisualSettings());
    // Pending: the viewer renders Shaded, the persisted choice survives the boot.
    expect(viewer.renderMode).toBe('default');
    expect(loadVisualSettings().renderMode).toBe('raytraced');
    // main.ts: registerPrivatePlugins registers the backend, then resolves once.
    registerRaytracedBackend(fakeBackendFactory);
    viewer.resolvePendingRenderMode();
    expect(viewer.renderMode).toBe('raytraced');
    expect(loadVisualSettings().renderMode).toBe('raytraced');
  }, VIEWER_TEST_TIMEOUT);

  it('pending without a backend after the plugins registered: default, and the store is corrected', async () => {
    handle = await createTestViewer('webgpu-gl');
    forceCompute(handle);
    const { viewer } = handle;
    localStorage.setItem(KEY, JSON.stringify({ renderMode: 'raytraced' }));
    viewer.applyVisualSettings(loadVisualSettings());
    expect(loadVisualSettings().renderMode).toBe('raytraced');
    viewer.resolvePendingRenderMode(); // no backend registered (community build)
    expect(viewer.renderMode).toBe('default');
    expect(loadVisualSettings().renderMode).toBe('default');
  }, VIEWER_TEST_TIMEOUT);

  it('a user mode change while pending supersedes the pending mode', async () => {
    handle = await createTestViewer('webgpu-gl');
    forceCompute(handle);
    const { viewer } = handle;
    localStorage.setItem(KEY, JSON.stringify({ renderMode: 'raytraced' }));
    viewer.applyVisualSettings(loadVisualSettings());
    setRenderMode(viewer, 'toon');
    registerRaytracedBackend(fakeBackendFactory);
    viewer.resolvePendingRenderMode();
    expect(viewer.renderMode).toBe('toon');
    expect(loadVisualSettings().renderMode).toBe('toon');
  }, VIEWER_TEST_TIMEOUT);

  it('ignores an app-config (URL / settings.json) renderMode=raytraced on a WebGL viewer', async () => {
    registerRaytracedBackend(fakeBackendFactory);
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    setAppConfig({ visual: { renderMode: 'raytraced' } });
    expect(loadVisualSettings().renderMode).toBe('raytraced'); // the override path of the store
    viewer.applyVisualSettings(loadVisualSettings());
    expect(viewer.renderMode).toBe('default');
  }, VIEWER_TEST_TIMEOUT);
});
