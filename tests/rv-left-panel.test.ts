// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for LeftPanel component exports, clampWidth helper, buildPanelSx helper,
 * and shared layout constants.
 *
 * Runs in vitest browser mode (Playwright/Chromium) — no Node fs/path.
 * Uses Vite ?raw imports to read source files as strings for the
 * "no hardcoded widths" regression tests.
 */

import { describe, it, expect } from 'vitest';

// Vite ?raw imports — source text for regression checks (browser-compatible)
import buttonPanelSrc from '../src/core/hmi/ButtonPanel.tsx?raw';
import viewerSrc from '../src/core/rv-viewer.ts?raw';
import cameraManagerSrc from '../src/core/rv-camera-manager.ts?raw';

// ── 9.1 TestLayoutConstants ──────────────────────────────────────────────

import {
  BOTTOM_BAR_HEIGHT,
  LEFT_PANEL_TOP,
  LEFT_PANEL_LEFT,
  LEFT_PANEL_BOTTOM,
  LEFT_PANEL_ZINDEX,
  SETTINGS_PANEL_WIDTH,
  INSPECTOR_PANEL_WIDTH,
} from '../src/core/hmi/layout-constants';

describe('layout-constants', () => {
  it('exports all panel dimension constants with correct values', () => {
    expect(BOTTOM_BAR_HEIGHT).toBe(52);
    expect(LEFT_PANEL_TOP).toBe(44);
    expect(LEFT_PANEL_LEFT).toBe(8);
    expect(LEFT_PANEL_BOTTOM).toBe(8);
    expect(LEFT_PANEL_ZINDEX).toBe(1200);
    expect(SETTINGS_PANEL_WIDTH).toBe(540);
    expect(INSPECTOR_PANEL_WIDTH).toBe(320);
  });

  it('LEFT_PANEL_TOP is >= 40 (panel below topbar)', () => {
    expect(LEFT_PANEL_TOP).toBeGreaterThanOrEqual(40);
  });

  it('all dimension constants are positive numbers', () => {
    for (const v of [
      BOTTOM_BAR_HEIGHT, LEFT_PANEL_TOP, LEFT_PANEL_LEFT,
      LEFT_PANEL_BOTTOM, LEFT_PANEL_ZINDEX,
      SETTINGS_PANEL_WIDTH, INSPECTOR_PANEL_WIDTH,
    ]) {
      expect(v).toBeGreaterThan(0);
      expect(typeof v).toBe('number');
    }
  });
});

// ── 9.2 TestLeftPanelExports ─────────────────────────────────────────────

describe('LeftPanel module', () => {
  it('exports LeftPanel component as a function', async () => {
    const mod = await import('../src/core/hmi/LeftPanel');
    expect(mod.LeftPanel).toBeDefined();
    expect(typeof mod.LeftPanel).toBe('function');
  });

  it('exports clampWidth helper for resize logic', async () => {
    const mod = await import('../src/core/hmi/LeftPanel');
    expect(mod.clampWidth).toBeDefined();
    expect(typeof mod.clampWidth).toBe('function');
  });

  it('exports buildPanelSx helper for style computation', async () => {
    const mod = await import('../src/core/hmi/LeftPanel');
    expect(mod.buildPanelSx).toBeDefined();
    expect(typeof mod.buildPanelSx).toBe('function');
  });
});

// ── 9.3 TestClampWidth ───────────────────────────────────────────────────

import { clampWidth } from '../src/core/hmi/LeftPanel';

describe('clampWidth', () => {
  it('returns value when within range', () => {
    expect(clampWidth(300, 200, 600)).toBe(300);
  });

  it('clamps to minWidth when too small', () => {
    expect(clampWidth(100, 200, 600)).toBe(200);
  });

  it('clamps to maxWidth when too large', () => {
    expect(clampWidth(800, 200, 600)).toBe(600);
  });

  it('handles edge case: value equals min', () => {
    expect(clampWidth(200, 200, 600)).toBe(200);
  });

  it('handles edge case: value equals max', () => {
    expect(clampWidth(600, 200, 600)).toBe(600);
  });

  it('handles negative values by clamping to min', () => {
    expect(clampWidth(-50, 200, 600)).toBe(200);
  });

  it('handles NaN by returning min', () => {
    expect(clampWidth(NaN, 200, 600)).toBe(200);
  });
});

// ── 9.4 TestBuildPanelSx ─────────────────────────────────────────────────

import { buildPanelSx } from '../src/core/hmi/LeftPanel';

describe('buildPanelSx', () => {
  it('returns correct desktop positioning', () => {
    const sx = buildPanelSx({ width: 320, isMobile: false });
    expect(sx.position).toBe('fixed');
    expect(sx.left).toBe(LEFT_PANEL_LEFT);
    expect(sx.top).toBe(LEFT_PANEL_TOP);
    expect(sx.bottom).toBe(LEFT_PANEL_BOTTOM);
    expect(sx.width).toBe(320);
    expect(sx.zIndex).toBe(LEFT_PANEL_ZINDEX);
    expect(sx.right).toBe('auto');
  });

  it('returns full-screen mobile positioning', () => {
    const sx = buildPanelSx({ width: 320, isMobile: true, mobile: 'full-screen' });
    expect(sx.left).toBe(0);
    expect(sx.right).toBe(0);
    expect(sx.bottom).toBe(0);
    expect(sx.width).toBe('100%');
    expect(sx.borderRadius).toBe(0);
  });

  it('returns display:none for mobile=hidden', () => {
    const sx = buildPanelSx({ width: 320, isMobile: true, mobile: 'hidden' });
    expect(sx.display).toBe('none');
  });

  it('respects custom leftOffset', () => {
    const sx = buildPanelSx({ width: 320, isMobile: false, leftOffset: 296 });
    expect(sx.left).toBe(296);
  });

  it('defaults mobile to full-screen', () => {
    const sx = buildPanelSx({ width: 320, isMobile: true });
    expect(sx.left).toBe(0);
    expect(sx.right).toBe(0);
  });
});

// ── 9.5 TestNoHardcodedWidths ────────────────────────────────────────────

describe('No hardcoded panel widths', () => {
  it('ButtonPanel.tsx imports SETTINGS_PANEL_WIDTH and INSPECTOR_PANEL_WIDTH', () => {
    expect(buttonPanelSrc).toContain('SETTINGS_PANEL_WIDTH');
    expect(buttonPanelSrc).toContain('INSPECTOR_PANEL_WIDTH');
  });

  it('rv-viewer.ts delegates getCurrentViewportOffset (uses INSPECTOR_PANEL_WIDTH via CameraManager)', () => {
    expect(viewerSrc).toContain('getCurrentViewportOffset');
    // INSPECTOR_PANEL_WIDTH is now used in the extracted CameraManager module
    expect(cameraManagerSrc).toContain('INSPECTOR_PANEL_WIDTH');
  });
});
