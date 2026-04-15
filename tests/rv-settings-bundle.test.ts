// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getModelBasename,
  collectSettingsBundle,
  importSettingsFile,
  applySettingsBundle,
  loadModelSettingsConfig,
} from '../src/core/hmi/rv-settings-bundle';
import type { RVSettingsBundle } from '../src/core/hmi/rv-settings-bundle';

function createTestBundle(settings: RVSettingsBundle['settings']): RVSettingsBundle {
  return {
    $schema: 'rv-settings-bundle/1.0',
    exportedAt: new Date().toISOString(),
    settings,
  };
}

describe('getModelBasename', () => {
  test('extracts basename from path', () => {
    expect(getModelBasename('models/demo.glb')).toBe('demo');
  });
  test('handles nested path', () => {
    expect(getModelBasename('models/path/to/robot.glb')).toBe('robot');
  });
  test('strips query string', () => {
    expect(getModelBasename('models/demo.glb?v=3')).toBe('demo');
  });
  test('case-insensitive extension', () => {
    expect(getModelBasename('models/Demo.GLB')).toBe('Demo');
  });
  test('returns fallback for null', () => {
    expect(getModelBasename(null)).toBe('rv-settings');
  });
});

describe('collectSettingsBundle', () => {
  beforeEach(() => localStorage.clear());

  test('returns valid schema and all sections', () => {
    const bundle = collectSettingsBundle('models/demo.glb');
    expect(bundle.$schema).toBe('rv-settings-bundle/1.0');
    expect(bundle.exportedAt).toBeTruthy();
    expect(bundle.settings.visual).toBeDefined();
    expect(bundle.settings.physics).toBeDefined();
    expect(bundle.settings.groupVisibility).toBeDefined();
  });

  test('includes panelLayouts from localStorage', () => {
    localStorage.setItem('rv-panel-groups', JSON.stringify({ x: 10, y: 20, w: 300, h: 200 }));
    const bundle = collectSettingsBundle('models/demo.glb');
    expect(bundle.settings.panelLayouts?.groups).toEqual({ x: 10, y: 20, w: 300, h: 200 });
  });
});

describe('importSettingsFile', () => {
  test('rejects missing schema', async () => {
    const file = new File(['{"bad": true}'], 'test.json');
    await expect(importSettingsFile(file)).rejects.toThrow();
  });

  test('rejects wrong schema version', async () => {
    const file = new File([JSON.stringify({ $schema: 'rv-settings-bundle/2.0', settings: {} })], 'test.json');
    await expect(importSettingsFile(file)).rejects.toThrow();
  });

  test('rejects files > 1 MB', async () => {
    const bigFile = new File([new ArrayBuffer(1_048_577)], 'big.json');
    await expect(importSettingsFile(bigFile)).rejects.toThrow(/too large/i);
  });

  test('accepts valid bundle with unknown extra keys', async () => {
    const bundle = { $schema: 'rv-settings-bundle/1.0', exportedAt: new Date().toISOString(), settings: { futureSection: {} } };
    const file = new File([JSON.stringify(bundle)], 'test.json');
    const result = await importSettingsFile(file);
    expect(result.$schema).toBe('rv-settings-bundle/1.0');
  });
});

describe('applySettingsBundle', () => {
  beforeEach(() => localStorage.clear());

  test('writes visual settings to store', () => {
    const bundle = createTestBundle({ visual: { bloomEnabled: true } });
    applySettingsBundle(bundle);
    const raw = JSON.parse(localStorage.getItem('rv-visual-settings') ?? '{}');
    expect(raw.bloomEnabled).toBe(true);
  });

  test('does not overwrite stores for missing sections', () => {
    localStorage.setItem('rv-physics-settings', JSON.stringify({ enabled: true }));
    const bundle = createTestBundle({ visual: { bloomEnabled: true } });
    // physics not in bundle
    applySettingsBundle(bundle);
    const raw = JSON.parse(localStorage.getItem('rv-physics-settings') ?? '{}');
    expect(raw.enabled).toBe(true);
  });
});

describe('loadModelSettingsConfig', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  test('applies settings from sidecar on first visit', async () => {
    const bundle = { $schema: 'rv-settings-bundle/1.0', exportedAt: '', settings: { physics: { enabled: false } } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(bundle), { status: 200 }));
    await loadModelSettingsConfig('models/demo.glb');
    const raw = JSON.parse(localStorage.getItem('rv-physics-settings') ?? '{}');
    expect(raw.enabled).toBe(false);
  });

  test('silent on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(loadModelSettingsConfig('models/demo.glb')).resolves.not.toThrow();
  });

  test('silent on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('network error'));
    await expect(loadModelSettingsConfig('models/demo.glb')).resolves.not.toThrow();
  });
});
