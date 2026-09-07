// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useLongPress — touch long-press detection with movement cancellation.
 *
 * Returns pointer event handlers that fire `onLongPress(clientX, clientY)`
 * after `delayMs` if a touch pointer stays within `moveTolerancePx` of its
 * original location. Cancels on pointer-up, pointer-leave, or movement
 * beyond the tolerance.
 *
 * Mouse and pen pointer types are ignored — long-press is touch-only by
 * design (mouse users have right-click for context menus).
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5) where
 * TreeNodeRow and FlatNodeRow had identical 30-line long-press blocks.
 */

import { useCallback, useEffect, useRef } from 'react';

export interface UseLongPressOptions {
  /** Whether long-press is enabled. When false, all handlers no-op. */
  enabled?: boolean;
  /** Delay in ms before the long-press fires. Default: 500ms. */
  delayMs?: number;
  /**
   * Squared distance tolerance in px². Movement beyond this cancels the timer.
   * Default: 64 (i.e. 8px in each direction).
   */
  moveTolerancePx2?: number;
  /** Optional callback fired on long-press, receiving the original pointer position. */
  onLongPress?: (x: number, y: number) => void;
}

export interface UseLongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  /**
   * The browser took the gesture over (a scroll started, a system menu opened).
   * Same effect as a leave — the finger is no longer ours to time.
   */
  onPointerCancel: () => void;
  /** Cancel imperatively (e.g. when a parent handler decides the gesture was something else). */
  cancel: () => void;
  /**
   * Did the pointer cycle that just ended fire a long-press?
   *
   * A touch long-press still emits a synthetic `click` after `pointerup` in
   * every browser, so a card that navigates on click would navigate right
   * behind the context menu it just opened. Callers ask this FIRST in their
   * `onClick` and return without acting. Reset on the next `pointerdown`.
   */
  consumedLastGesture: () => boolean;
}

export function useLongPress({
  enabled = true,
  delayMs = 500,
  moveTolerancePx2 = 64,
  onLongPress,
}: UseLongPressOptions = {}): UseLongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const consumedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    posRef.current = null;
  }, []);

  const consumedLastGesture = useCallback(() => consumedRef.current, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Cleared for EVERY pointer, not only the touches we time: a mouse click
    // after a touch long-press must not be swallowed by a stale flag.
    consumedRef.current = false;
    if (!enabled || !onLongPress || e.pointerType !== 'touch') return;
    // Clear any leftover timer from a previous gesture before starting a new one.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    posRef.current = { x: e.clientX, y: e.clientY };
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const start = posRef.current;
      if (start && onLongPress) {
        consumedRef.current = true;
        onLongPress(start.x, start.y);
        navigator.vibrate?.(50);
      }
    }, delayMs);
  }, [enabled, onLongPress, delayMs]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!timerRef.current || !posRef.current) return;
    const dx = e.clientX - posRef.current.x;
    const dy = e.clientY - posRef.current.y;
    if (dx * dx + dy * dy > moveTolerancePx2) cancel();
  }, [cancel, moveTolerancePx2]);

  // Cleanup on unmount: ensure any pending timer is cleared so callbacks
  // can't fire against a disposed component tree.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      posRef.current = null;
    };
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    cancel,
    consumedLastGesture,
  };
}
