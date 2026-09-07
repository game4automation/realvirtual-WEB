// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPress } from '../src/hooks/use-long-press';

// Helper: simulate a minimal React.PointerEvent.
function pointerEvent(
  opts: { pointerType?: string; clientX?: number; clientY?: number } = {},
): React.PointerEvent {
  return {
    pointerType: opts.pointerType ?? 'touch',
    clientX: opts.clientX ?? 100,
    clientY: opts.clientY ?? 100,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.PointerEvent;
}

describe('useLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onLongPress after delay when touch pointer is held', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch', clientX: 50, clientY: 60 }));
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(50, 60);
  });

  it('does not fire onLongPress when pointer released before threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
      result.current.onPointerUp();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does not fire onLongPress for mouse pointer type', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'mouse' }));
      vi.advanceTimersByTime(2000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels on pointer movement beyond tolerance', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, moveTolerancePx2: 64 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch', clientX: 100, clientY: 100 }));
      vi.advanceTimersByTime(100);
      // Move 10px in X — 100px² > 64 tolerance
      result.current.onPointerMove(pointerEvent({ pointerType: 'touch', clientX: 110, clientY: 100 }));
      vi.advanceTimersByTime(500);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does NOT cancel on movement within tolerance', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, moveTolerancePx2: 64, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch', clientX: 100, clientY: 100 }));
      vi.advanceTimersByTime(100);
      // Move 5px in X — 25px² < 64 tolerance
      result.current.onPointerMove(pointerEvent({ pointerType: 'touch', clientX: 105, clientY: 100 }));
      vi.advanceTimersByTime(500);
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('cancels on pointer leave', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      result.current.onPointerLeave();
      vi.advanceTimersByTime(1000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('no-ops when disabled', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ enabled: false, onLongPress }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      vi.advanceTimersByTime(1000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('imperative cancel() prevents pending fire', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      result.current.cancel();
      vi.advanceTimersByTime(1000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('clears pending timer on unmount', () => {
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('starting a new gesture clears the previous timer', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch', clientX: 10, clientY: 10 }));
      vi.advanceTimersByTime(200);
      // Start a new gesture — should reset the timer with new origin
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch', clientX: 200, clientY: 200 }));
      vi.advanceTimersByTime(500);
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(200, 200);
  });
});

/**
 * plan-458 §9.2b — the two additions, and the promise that they ARE additions.
 *
 * `HierarchyNodeRow` wires this hook in two places and passes neither of them,
 * so both have to keep behaving exactly as the block above describes. What is
 * new is only asked for by a caller that wants it.
 */
describe('useLongPress — gesture consumption and pointercancel (plan-458)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports the gesture as consumed once the long-press has fired', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    expect(result.current.consumedLastGesture()).toBe(false);
    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      vi.advanceTimersByTime(500);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // The browser's synthetic click is still to come — this is what the card's
    // onClick asks before it acts.
    expect(result.current.consumedLastGesture()).toBe(true);
  });

  it('does not report a consumed gesture for a press that never fired', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      vi.advanceTimersByTime(200);
      result.current.onPointerUp();
    });
    expect(result.current.consumedLastGesture()).toBe(false);
  });

  it('resets consumption on the next pointerdown', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      vi.advanceTimersByTime(500);
      result.current.onPointerUp();
    });
    expect(result.current.consumedLastGesture()).toBe(true);
    act(() => { result.current.onPointerDown(pointerEvent({ pointerType: 'touch' })); });
    expect(result.current.consumedLastGesture()).toBe(false);
  });

  it('clears the flag even for a pointer type it does not time', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      vi.advanceTimersByTime(500);
    });
    // A mouse press after a touch long-press must not be swallowed.
    act(() => { result.current.onPointerDown(pointerEvent({ pointerType: 'mouse' })); });
    expect(result.current.consumedLastGesture()).toBe(false);
  });

  it('onPointerCancel clears the pending timer', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: 500 }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'touch' }));
      // The browser took the gesture over to scroll.
      result.current.onPointerCancel();
      vi.advanceTimersByTime(600);
    });
    expect(onLongPress).not.toHaveBeenCalled();
    expect(result.current.consumedLastGesture()).toBe(false);
  });

  it('still ignores mouse and pen pointers', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => {
      result.current.onPointerDown(pointerEvent({ pointerType: 'pen' }));
      vi.advanceTimersByTime(2000);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
