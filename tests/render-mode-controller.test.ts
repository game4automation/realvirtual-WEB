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
import { loadVisualSettings } from '../src/core/hmi/visual-settings-store';
import { setAppConfig } from '../src/core/rv-app-config';
import { fakeRenderViewer } from './helpers/fake-render-viewer';

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
