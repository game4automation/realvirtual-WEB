// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, afterEach } from 'vitest';
import { mockNavigatorXR, clearNavigatorXR } from './mocks/webxr-mock';
import { RVXRManager } from '../src/core/engine/rv-xr-manager';

describe('RVXRManager', () => {
  afterEach(() => clearNavigatorXR());

  test('checkSupport returns false when no navigator.xr', async () => {
    clearNavigatorXR();
    const support = await RVXRManager.checkSupport();
    expect(support.vr).toBe(false);
    expect(support.ar).toBe(false);
  });

  test('checkSupport returns true with mock VR+AR', async () => {
    mockNavigatorXR({ vr: true, ar: true });
    const support = await RVXRManager.checkSupport();
    expect(support.vr).toBe(true);
    expect(support.ar).toBe(true);
  });

  test('checkSupport returns partial support', async () => {
    mockNavigatorXR({ vr: true, ar: false });
    const support = await RVXRManager.checkSupport();
    expect(support.vr).toBe(true);
    expect(support.ar).toBe(false);
  });

  test('isXRCapable returns false for null/undefined', () => {
    expect(RVXRManager.isXRCapable(null)).toBe(false);
    expect(RVXRManager.isXRCapable(undefined)).toBe(false);
  });

  test('isXRCapable returns false for stub xr (WebGPU)', () => {
    const stubRenderer = { xr: { enabled: false } };
    expect(RVXRManager.isXRCapable(stubRenderer)).toBe(false);
  });

  test('isXRCapable returns true for renderer with setSession', () => {
    const renderer = { xr: { setSession: () => {}, enabled: true } };
    expect(RVXRManager.isXRCapable(renderer)).toBe(true);
  });

  test('sessionType starts as none', () => {
    const manager = new RVXRManager();
    expect(manager.sessionType).toBe('none');
    expect(manager.isPresenting).toBe(false);
  });

  test('dispose resets state', () => {
    const manager = new RVXRManager();
    manager.dispose();
    expect(manager.sessionType).toBe('none');
    expect(manager.controllers).toHaveLength(0);
  });
});
