// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAppConfig, setAppConfig, getAppConfig,
  isSettingsLocked, isTabLocked, type RVAppConfig,
} from '../src/core/rv-app-config';

describe('rv-app-config', () => {
  beforeEach(() => {
    localStorage.clear();
    setAppConfig({}); // Reset singleton
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- fetchAppConfig ---

  it('should return empty config when settings.json is 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const config = await fetchAppConfig();
    expect(config).toEqual({});
  });

  it('should parse valid settings.json with all fields', async () => {
    const mockConfig: RVAppConfig = {
      lockSettings: true,
      defaultModel: 'models/test.glb',
      visual: { lightingMode: 'simple', antialias: false },
      interface: { wsPort: 8080 },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockConfig), { status: 200 }),
    );
    const config = await fetchAppConfig();
    expect(config.lockSettings).toBe(true);
    expect(config.defaultModel).toBe('models/test.glb');
    expect(config.visual?.lightingMode).toBe('simple');
    expect(config.visual?.antialias).toBe(false);
    expect(config.interface?.wsPort).toBe(8080);
    // Unset fields must be undefined
    expect(config.physics).toBeUndefined();
    expect(config.search).toBeUndefined();
  });

  it('should return empty config on invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('not valid json {{{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const config = await fetchAppConfig();
    expect(config).toEqual({});
  });

  it('should return empty config on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const config = await fetchAppConfig();
    expect(config).toEqual({});
  });

  it('should return empty config when JSON is not an object (array)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('[1, 2, 3]', { status: 200 }),
    );
    const config = await fetchAppConfig();
    expect(config).toEqual({});
  });

  it('should return empty config when JSON is a primitive ("true")', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('true', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const config = await fetchAppConfig();
    expect(config).toEqual({});
  });

  // --- isSettingsLocked / isTabLocked ---

  it('should return false when no config set', () => {
    setAppConfig({});
    expect(isSettingsLocked()).toBe(false);
  });

  it('should return true when lockSettings is true', () => {
    setAppConfig({ lockSettings: true });
    expect(isSettingsLocked()).toBe(true);
  });

  it('should lock all tabs when lockSettings is true', () => {
    setAppConfig({ lockSettings: true });
    expect(isTabLocked('visual')).toBe(true);
    expect(isTabLocked('physics')).toBe(true);
    expect(isTabLocked('interfaces')).toBe(true);
    expect(isTabLocked('model')).toBe(true);
  });

  it('should lock only specified tabs via lockedTabs', () => {
    setAppConfig({ lockedTabs: ['interfaces', 'physics'] });
    expect(isTabLocked('interfaces')).toBe(true);
    expect(isTabLocked('physics')).toBe(true);
    expect(isTabLocked('visual')).toBe(false);
    expect(isTabLocked('model')).toBe(false);
  });

  it('should not lock any tab when lockedTabs is empty array', () => {
    setAppConfig({ lockedTabs: [] });
    expect(isTabLocked('visual')).toBe(false);
    expect(isTabLocked('interfaces')).toBe(false);
  });

  // --- Lock-Guard in Stores ---

  it('should not write to localStorage when settings locked (visual)', async () => {
    const { saveVisualSettings, loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    setAppConfig({ lockSettings: true });
    const spy = vi.spyOn(Storage.prototype, 'setItem');

    // Use current VisualSettings shape (nested modeSettings)
    const settings = loadVisualSettings();
    saveVisualSettings(settings);

    expect(spy).not.toHaveBeenCalled();
  });

  it('should write to localStorage when settings NOT locked (visual)', async () => {
    const { saveVisualSettings, loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    setAppConfig({});
    const spy = vi.spyOn(Storage.prototype, 'setItem');

    const settings = loadVisualSettings();
    saveVisualSettings(settings);

    expect(spy).toHaveBeenCalledWith('rv-visual-settings', expect.any(String));
  });

  // --- Config-Override Merge ---

  it('should override localStorage values with config (visual)', async () => {
    const { loadVisualSettings, saveVisualSettings } = await import('../src/core/hmi/visual-settings-store');

    // Step 1: Populate localStorage with user values (lock must be off for save)
    setAppConfig({});
    const defaults = loadVisualSettings();
    defaults.modeSettings.default.shadowEnabled = false;
    defaults.modeSettings.default.lightIntensity = 1.0;
    saveVisualSettings(defaults);

    // Step 2: Set config override (lightingMode override)
    setAppConfig({ visual: { lightingMode: 'default' } });

    // Step 3: Load — config must win over localStorage for overridden fields
    const result = loadVisualSettings();
    expect(result.lightingMode).toBe('default');
    // localStorage values preserved for non-overridden fields
    expect(result.modeSettings.default.shadowEnabled).toBe(false);
    expect(result.modeSettings.default.lightIntensity).toBe(1.0);
  });

  it('should return localStorage values when no config override', async () => {
    const { loadVisualSettings, saveVisualSettings } = await import('../src/core/hmi/visual-settings-store');

    setAppConfig({}); // No override
    const defaults = loadVisualSettings();
    defaults.modeSettings.default.shadowEnabled = false;
    defaults.modeSettings.default.lightIntensity = 1.5;
    defaults.lightingMode = 'default';
    saveVisualSettings(defaults);

    const result = loadVisualSettings();
    expect(result.lightingMode).toBe('default');
    expect(result.modeSettings.default.shadowEnabled).toBe(false);
    expect(result.modeSettings.default.lightIntensity).toBe(1.5);
  });

  // ── Navigation Sensitivity Overrides (Plan 148) ─────────────────────
  it('overrides navigation settings from settings.json (visual.orbit*)', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    setAppConfig({ visual: { orbitRotateSpeed: 2.0, orbitDampingFactor: 0.15 } });
    const s = loadVisualSettings();
    expect(s.orbitRotateSpeed).toBe(2.0);
    expect(s.orbitDampingFactor).toBe(0.15);
  });

  it('ignores string values in settings.json for nav fields (typeof guard)', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    // Cast forces a broken JSON-like payload that TS would normally reject.
    setAppConfig({ visual: { orbitRotateSpeed: '2.0' as unknown as number } });
    const s = loadVisualSettings();
    expect(s.orbitRotateSpeed).toBe(1.0); // falls back to DEFAULT
  });

  it('ignores out-of-range values in settings.json for nav fields', async () => {
    const { loadVisualSettings } = await import('../src/core/hmi/visual-settings-store');
    setAppConfig({ visual: { orbitPanSpeed: 99 } });
    const s = loadVisualSettings();
    expect(s.orbitPanSpeed).toBe(1.0); // clamped to DEFAULT
  });
});
