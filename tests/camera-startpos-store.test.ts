// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  loadStartPos, saveStartPos, clearStartPos, hasStartPos,
} from '../src/core/hmi/camera-startpos-store';
import { CAMERA_START_CHANGED_EVENT } from '../src/core/hmi/camera-startpos-types';

describe('camera-startpos-store', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('returns null when nothing is saved', () => {
    expect(loadStartPos('Model')).toBeNull();
    expect(hasStartPos('Model')).toBe(false);
  });

  it('round-trips a valid preset', () => {
    const preset = { px: 1, py: 2, pz: 3, tx: 0, ty: 1, tz: 0, savedAt: 123, source: 'user' as const };
    expect(saveStartPos('Model', preset)).toBe(true);
    expect(loadStartPos('Model')).toEqual(preset);
    expect(hasStartPos('Model')).toBe(true);
  });

  it('dispatches CAMERA_START_CHANGED_EVENT on save', () => {
    const listener = vi.fn();
    window.addEventListener(CAMERA_START_CHANGED_EVENT, listener);
    saveStartPos('EventModel', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0 });
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(CAMERA_START_CHANGED_EVENT, listener);
  });

  it('dispatches CAMERA_START_CHANGED_EVENT on clear', () => {
    saveStartPos('C', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0 });
    const listener = vi.fn();
    window.addEventListener(CAMERA_START_CHANGED_EVENT, listener);
    clearStartPos('C');
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(CAMERA_START_CHANGED_EVENT, listener);
  });

  it('clears a preset', () => {
    saveStartPos('Model', { px: 1, py: 2, pz: 3, tx: 0, ty: 0.5, tz: 0 });
    clearStartPos('Model');
    expect(loadStartPos('Model')).toBeNull();
    expect(hasStartPos('Model')).toBe(false);
  });

  it('returns null on corrupt JSON', () => {
    localStorage.setItem('rv-camera-start:Broken', '{not valid json');
    expect(loadStartPos('Broken')).toBeNull();
  });

  it('REJECTS NaN in any coordinate', () => {
    localStorage.setItem('rv-camera-start:NaN', JSON.stringify({
      px: NaN, py: 0, pz: 0, tx: 0, ty: 1, tz: 0,
    }));
    expect(loadStartPos('NaN')).toBeNull();
  });

  it('REJECTS Infinity in any coordinate', () => {
    localStorage.setItem('rv-camera-start:Inf', JSON.stringify({
      px: Infinity, py: 0, pz: 0, tx: 0, ty: 1, tz: 0,
    }));
    expect(loadStartPos('Inf')).toBeNull();
  });

  it('REJECTS duration = Infinity (parsed from 1e309)', () => {
    localStorage.setItem('rv-camera-start:InfDur', JSON.stringify({
      px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, duration: 1e309,
    }));
    expect(loadStartPos('InfDur')).toBeNull();
  });

  it('REJECTS duration = NaN', () => {
    localStorage.setItem('rv-camera-start:NaNDur', JSON.stringify({
      px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, duration: NaN,
    }));
    expect(loadStartPos('NaNDur')).toBeNull();
  });

  it('REJECTS negative duration', () => {
    localStorage.setItem('rv-camera-start:NegDur', JSON.stringify({
      px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, duration: -5,
    }));
    expect(loadStartPos('NegDur')).toBeNull();
  });

  it('REJECTS zero duration', () => {
    localStorage.setItem('rv-camera-start:ZeroDur', JSON.stringify({
      px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, duration: 0,
    }));
    expect(loadStartPos('ZeroDur')).toBeNull();
  });

  it('ACCEPTS preset without duration (optional field)', () => {
    localStorage.setItem('rv-camera-start:NoDur', JSON.stringify({
      px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0,
    }));
    expect(loadStartPos('NoDur')).not.toBeNull();
  });

  it('saveStartPos returns false on quota exceeded', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(saveStartPos('Model', { px: 1, py: 2, pz: 3, tx: 0, ty: 1, tz: 0 })).toBe(false);
  });

  it('isolates presets per model key', () => {
    saveStartPos('A', { px: 1, py: 1, pz: 1, tx: 0, ty: 1, tz: 0 });
    saveStartPos('B', { px: 9, py: 9, pz: 9, tx: 0, ty: 1, tz: 0 });
    expect(loadStartPos('A')?.px).toBe(1);
    expect(loadStartPos('B')?.px).toBe(9);
  });
});
