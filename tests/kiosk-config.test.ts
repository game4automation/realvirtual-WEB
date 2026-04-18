// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for kiosk-config — `normalizeKioskConfig`, `applyUrlOverrides`,
 * and `validateCameraArgs` input-validation helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_KIOSK_CONFIG,
  normalizeKioskConfig,
  applyUrlOverrides,
  validateCameraArgs,
} from '../src/plugins/kiosk-config';

describe('normalizeKioskConfig', () => {
  it('uses defaults for empty input', () => {
    const c = normalizeKioskConfig({});
    expect(c).toEqual(DEFAULT_KIOSK_CONFIG);
  });

  it('uses defaults for null / undefined', () => {
    expect(normalizeKioskConfig(null)).toEqual(DEFAULT_KIOSK_CONFIG);
    expect(normalizeKioskConfig(undefined)).toEqual(DEFAULT_KIOSK_CONFIG);
  });

  it('clamps idleTimeoutSeconds=0 to default (60) since min is 5', () => {
    expect(normalizeKioskConfig({ idleTimeoutSeconds: 0 }).idleTimeoutSeconds).toBe(60);
  });

  it('clamps negative idleTimeoutSeconds to default', () => {
    expect(normalizeKioskConfig({ idleTimeoutSeconds: -5 }).idleTimeoutSeconds).toBe(60);
  });

  it('rejects non-numeric idleTimeoutSeconds (string "abc")', () => {
    expect(normalizeKioskConfig({ idleTimeoutSeconds: 'abc' as unknown as number }).idleTimeoutSeconds).toBe(60);
  });

  it('accepts valid idleTimeoutSeconds=30', () => {
    expect(normalizeKioskConfig({ idleTimeoutSeconds: 30 }).idleTimeoutSeconds).toBe(30);
  });

  it('strict boolean check on enabled — only true enables', () => {
    expect(normalizeKioskConfig({ enabled: 'true' as unknown as boolean }).enabled).toBe(false);
    expect(normalizeKioskConfig({ enabled: 1 as unknown as boolean }).enabled).toBe(false);
    expect(normalizeKioskConfig({ enabled: true }).enabled).toBe(true);
    expect(normalizeKioskConfig({ enabled: false }).enabled).toBe(false);
  });

  it('cycleLimit clamped to non-negative', () => {
    expect(normalizeKioskConfig({ cycleLimit: -3 }).cycleLimit).toBe(0);
    expect(normalizeKioskConfig({ cycleLimit: 5 }).cycleLimit).toBe(5);
  });

  it('cameraAnimationTimeoutMs has 500ms floor', () => {
    expect(normalizeKioskConfig({ cameraAnimationTimeoutMs: 100 }).cameraAnimationTimeoutMs).toBe(500);
    expect(normalizeKioskConfig({ cameraAnimationTimeoutMs: 10000 }).cameraAnimationTimeoutMs).toBe(10000);
  });

  it('maxConcurrentMessages clamped to [1, 20]', () => {
    expect(normalizeKioskConfig({ maxConcurrentMessages: 0 }).maxConcurrentMessages).toBe(1);
    expect(normalizeKioskConfig({ maxConcurrentMessages: 50 }).maxConcurrentMessages).toBe(20);
    expect(normalizeKioskConfig({ maxConcurrentMessages: 8 }).maxConcurrentMessages).toBe(8);
  });
});

describe('applyUrlOverrides', () => {
  const base = DEFAULT_KIOSK_CONFIG;

  it('?kiosk missing returns base unchanged', () => {
    const p = new URLSearchParams('');
    expect(applyUrlOverrides(base, p)).toEqual(base);
  });

  it('?kiosk=off forces enabled=false', () => {
    const p = new URLSearchParams('kiosk=off');
    const cfg = applyUrlOverrides({ ...base, enabled: true }, p);
    expect(cfg.enabled).toBe(false);
  });

  it('?kiosk=now sets enabled=true + idleTimeoutSeconds=0', () => {
    const p = new URLSearchParams('kiosk=now');
    const cfg = applyUrlOverrides(base, p);
    expect(cfg.enabled).toBe(true);
    expect(cfg.idleTimeoutSeconds).toBe(0);
  });

  it('?kiosk=30 enables and sets timeout=30s', () => {
    const p = new URLSearchParams('kiosk=30');
    const cfg = applyUrlOverrides(base, p);
    expect(cfg.enabled).toBe(true);
    expect(cfg.idleTimeoutSeconds).toBe(30);
  });

  it('?kiosk=2 clamps up to 5s minimum', () => {
    const p = new URLSearchParams('kiosk=2');
    const cfg = applyUrlOverrides(base, p);
    expect(cfg.enabled).toBe(true);
    expect(cfg.idleTimeoutSeconds).toBe(5);
  });

  it('?kiosk=0 is REJECTED (use ?kiosk=now for instant activation)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new URLSearchParams('kiosk=0');
    const cfg = applyUrlOverrides(base, p);
    expect(cfg).toEqual(base);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('?kiosk=-5 is rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new URLSearchParams('kiosk=-5');
    expect(applyUrlOverrides(base, p)).toEqual(base);
    warn.mockRestore();
  });

  it('?kiosk=abc is rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new URLSearchParams('kiosk=abc');
    expect(applyUrlOverrides(base, p)).toEqual(base);
    warn.mockRestore();
  });
});

describe('validateCameraArgs', () => {
  it('accepts valid [x,y,z] arrays', () => {
    const r = validateCameraArgs([1, 2, 3], [4, 5, 6]);
    expect(r.position).toEqual([1, 2, 3]);
    expect(r.target).toEqual([4, 5, 6]);
  });

  it('rejects NaN in position', () => {
    expect(() => validateCameraArgs([NaN, 0, 0], [0, 0, 0])).toThrow(/position/);
  });

  it('rejects Infinity in target', () => {
    expect(() => validateCameraArgs([0, 0, 0], [0, Infinity, 0])).toThrow(/target/);
  });

  it('rejects wrong-length arrays', () => {
    expect(() => validateCameraArgs([1, 2] as never, [0, 0, 0])).toThrow();
    expect(() => validateCameraArgs([1, 2, 3, 4] as never, [0, 0, 0])).toThrow();
  });

  it('rejects non-array inputs', () => {
    expect(() => validateCameraArgs('bad' as never, [0, 0, 0])).toThrow();
    expect(() => validateCameraArgs({ x: 0 } as never, [0, 0, 0])).toThrow();
  });
});
