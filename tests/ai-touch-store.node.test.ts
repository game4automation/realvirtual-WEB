// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-499 §9.3 — the AI-touch (afterglow) store.
 *
 * It lives in `src/core/hmi/button-sim-state.ts` (the open button state): one
 * module, because the phase a button renders is ONE value — hover/pressed from
 * the choreography win over the afterglow. Pinned here: a touch lasts
 * AI_TOUCH_MS, several buttons glow in parallel, a repeat restarts (new seq),
 * progress runs 0 → 1, one sweep timer, and nothing leaks after expiry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_TOUCH_MS,
  _resetButtonSimStateForTest,
  _setAiTouchMsForTest,
  getAiTouch,
  getAiTouchMs,
  getAiTouches,
  getButtonSimPhase,
  setSimPhase,
  touchAfterglow,
} from '../src/core/hmi/button-sim-state';

afterEach(() => {
  vi.useRealTimers();
  _resetButtonSimStateForTest();
});

describe('AI touch / afterglow', () => {
  it('defaults to ~3 s', () => {
    expect(AI_TOUCH_MS).toBe(3000);
    expect(getAiTouchMs()).toBe(3000);
  });

  it('lasts AI_TOUCH_MS, parallel buttons glow together, a repeat restarts', () => {
    vi.useFakeTimers();
    _setAiTouchMsForTest(3000, () => Date.now());
    touchAfterglow('qe.to-ground', 'editor.toGround');
    vi.advanceTimersByTime(1000);
    touchAfterglow('qe.zero-position', 'editor.zeroPosition');
    expect(getButtonSimPhase('qe.to-ground')).toBe('afterglow');
    expect(getButtonSimPhase('qe.zero-position')).toBe('afterglow');
    expect(getAiTouches()).toHaveLength(2);
    vi.advanceTimersByTime(1500);
    touchAfterglow('qe.to-ground', 'editor.toGround'); // restart at t=2500
    vi.advanceTimersByTime(1000); // t=3500: the first touch would have expired
    expect(getButtonSimPhase('qe.to-ground')).toBe('afterglow');
    vi.advanceTimersByTime(600); // t=4100: zero-position expired at 4000
    expect(getButtonSimPhase('qe.zero-position')).toBeNull();
    vi.advanceTimersByTime(1500); // t=5600: the restarted touch expired at 5500
    expect(getButtonSimPhase('qe.to-ground')).toBeNull();
    expect(getAiTouches()).toHaveLength(0);
  });

  it('a re-trigger gets a new seq (restarts the CSS fade) and progress starts at 0', () => {
    vi.useFakeTimers();
    _setAiTouchMsForTest(1000, () => Date.now());
    touchAfterglow('b', 'c');
    const first = getAiTouch('b');
    expect(first).toMatchObject({ active: true, progress: 0 });
    expect(getAiTouch('b')).toBe(first); // stable snapshot between renders
    vi.advanceTimersByTime(400);
    touchAfterglow('b', 'c');
    const second = getAiTouch('b');
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.progress).toBe(0);
    vi.advanceTimersByTime(1001);
    expect(getAiTouch('b')).toMatchObject({ active: false });
  });

  it('one sweep timer for the whole list', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    touchAfterglow('a', 'x');
    touchAfterglow('b', 'y');
    touchAfterglow('c', 'z');
    // Each touch re-arms THE timer (clear + set) — never one live timer per button.
    expect(vi.getTimerCount()).toBe(1);
    spy.mockRestore();
  });

  it('hover/pressed win over afterglow while the choreography runs', () => {
    touchAfterglow('qe.to-ground', 'editor.toGround');
    setSimPhase('qe.to-ground', 'pressed');
    expect(getButtonSimPhase('qe.to-ground')).toBe('pressed');
    setSimPhase('qe.to-ground', null);
    expect(getButtonSimPhase('qe.to-ground')).toBe('afterglow');
  });

  it('an empty key never matches', () => {
    touchAfterglow('', 'x');
    expect(getAiTouch('')).toMatchObject({ active: false });
    expect(getButtonSimPhase('')).toBeNull();
  });
});
