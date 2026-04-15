// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useMediaQuery } from '@mui/material';

/** Mobile breakpoint (px). Below this, use mobile layout (bottom tab bar, bottom sheets). */
export const MOBILE_BREAKPOINT = 768;

/**
 * Detect mobile/touch device using multiple signals for robust detection.
 * Combines: UA Client Hints, media queries, maxTouchPoints, and UA string fallback.
 * Cached after first call — device class doesn't change at runtime.
 */
let _cachedIsMobile: boolean | null = null;

export function isMobileDevice(): boolean {
  if (_cachedIsMobile !== null) return _cachedIsMobile;

  // 1. Modern UA Client Hints (Chrome 89+, Edge, Opera — NOT Safari/Firefox)
  const uad = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uad?.mobile !== undefined) {
    _cachedIsMobile = uad.mobile;
    // UA Client Hints detected mobile device
    return _cachedIsMobile;
  }

  // 2. CSS media query: touch-only device (fails on iPad with keyboard/trackpad)
  const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (touchOnly) {
    _cachedIsMobile = true;
    return true;
  }

  // 3. Touch capability + small screen (catches iPads, Android tablets with accessories)
  const hasTouch = navigator.maxTouchPoints > 0;
  const smallScreen = Math.min(window.screen.width, window.screen.height) <= 1024;
  if (hasTouch && smallScreen) {
    _cachedIsMobile = true;
    return true;
  }

  // 4. UA string fallback (Safari/Firefox on iOS/Android)
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(ua)) {
    _cachedIsMobile = true;
    return true;
  }
  // iPadOS 13+ sends Mac UA but has touch — detect via maxTouchPoints
  if (/Macintosh/i.test(ua) && hasTouch) {
    _cachedIsMobile = true;
    return true;
  }

  _cachedIsMobile = false;
  return false;
}

/**
 * Returns true when the device should use mobile layout.
 * Triggers on narrow viewports OR detected mobile/touch devices.
 */
export function useMobileLayout(): boolean {
  const narrow = useMediaQuery(`(max-width:${MOBILE_BREAKPOINT - 1}px)`);
  return narrow || isMobileDevice();
}

/** Returns true when the primary input is touch (coarse pointer, no hover). */
export function useTouchDevice(): boolean {
  return useMediaQuery('(hover: none) and (pointer: coarse)') || isMobileDevice();
}
