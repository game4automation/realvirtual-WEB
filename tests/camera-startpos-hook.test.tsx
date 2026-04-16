// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useCameraStartPos } from '../src/hooks/use-camera-startpos';
import { saveStartPos, clearStartPos } from '../src/core/hmi/camera-startpos-store';

function mockViewer(url: string = '/models/HookTest.glb') {
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  return {
    pendingModelUrl: url, currentModelUrl: url,
    on: (ev: string, cb: (d?: unknown) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => listeners.get(ev)?.delete(cb);
    },
    _emit: (ev: string, data?: unknown) => listeners.get(ev)?.forEach(cb => cb(data)),
  } as any;
}

describe('useCameraStartPos', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('returns has=false when no preset', () => {
    const { result } = renderHook(() => useCameraStartPos(mockViewer()));
    expect(result.current.has).toBe(false);
    expect(result.current.modelKey).toBe('HookTest');
  });

  it('returns has=true + source=user after save', () => {
    saveStartPos('HookTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'user', savedAt: 42 });
    const { result } = renderHook(() => useCameraStartPos(mockViewer()));
    expect(result.current.has).toBe(true);
    expect(result.current.source).toBe('user');
    expect(result.current.savedAt).toBe(42);
  });

  it('re-renders on model-loaded event', () => {
    const viewer = mockViewer();
    const { result } = renderHook(() => useCameraStartPos(viewer));
    expect(result.current.has).toBe(false);
    saveStartPos('HookTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'user' });
    act(() => viewer._emit('model-loaded', { result: {} }));
    expect(result.current.has).toBe(true);
  });

  it('re-renders on CAMERA_START_CHANGED_EVENT (SAME-TAB save)', () => {
    const viewer = mockViewer();
    const { result } = renderHook(() => useCameraStartPos(viewer));
    expect(result.current.has).toBe(false);
    act(() => { saveStartPos('HookTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'user' }); });
    expect(result.current.has).toBe(true);
  });

  it('re-renders on CAMERA_START_CHANGED_EVENT (SAME-TAB clear)', () => {
    saveStartPos('HookTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'user' });
    const viewer = mockViewer();
    const { result } = renderHook(() => useCameraStartPos(viewer));
    expect(result.current.has).toBe(true);
    act(() => clearStartPos('HookTest'));
    expect(result.current.has).toBe(false);
  });

  it('re-renders on cross-tab storage event', () => {
    const viewer = mockViewer();
    const { result } = renderHook(() => useCameraStartPos(viewer));
    saveStartPos('HookTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'user' });
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'rv-camera-start:HookTest' }));
    });
    expect(result.current.has).toBe(true);
  });
});
