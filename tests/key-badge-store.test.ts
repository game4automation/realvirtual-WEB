// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * key-badge-store.test.ts — chord state behind the Blender-style
 * screencast-keys badge (KeyBadgeLayer).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  showKeyBadge,
  appendKeyBadge,
  hideKeyBadge,
  getKeyBadgeSnapshot,
} from '../src/core/hmi/key-badge-store';

// The module is a singleton — reset between tests.
beforeEach(() => {
  vi.useFakeTimers();
  hideKeyBadge();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('key-badge-store', () => {
  it('showKeyBadge starts a fresh chord', () => {
    showKeyBadge('S');
    appendKeyBadge('I', 'Identical (3)');
    expect(getKeyBadgeSnapshot()?.keys).toEqual(['S', 'I']);
    expect(getKeyBadgeSnapshot()?.label).toBe('Identical (3)');
    showKeyBadge('K');
    expect(getKeyBadgeSnapshot()?.keys).toEqual(['K']);
    expect(getKeyBadgeSnapshot()?.label).toBeNull();
  });

  it('appendKeyBadge extends the visible chord, or starts one when hidden', () => {
    appendKeyBadge('S');
    expect(getKeyBadgeSnapshot()?.keys).toEqual(['S']);
    appendKeyBadge('V', 'Invert (9)');
    expect(getKeyBadgeSnapshot()?.keys).toEqual(['S', 'V']);
    hideKeyBadge();
    appendKeyBadge('M');
    expect(getKeyBadgeSnapshot()?.keys).toEqual(['M']);
  });

  it('auto-hides after the delay; every push resets the timer', () => {
    showKeyBadge('S');
    vi.advanceTimersByTime(1500);
    appendKeyBadge('I');
    // 1.5 s after the append the badge is still visible (timer was reset)...
    vi.advanceTimersByTime(1500);
    expect(getKeyBadgeSnapshot()?.keys).toEqual(['S', 'I']);
    // ...and gone once the full delay elapses without another push.
    vi.advanceTimersByTime(2000);
    expect(getKeyBadgeSnapshot()).toBeNull();
  });

  it('hideKeyBadge is idempotent', () => {
    showKeyBadge('S');
    hideKeyBadge();
    hideKeyBadge();
    expect(getKeyBadgeSnapshot()).toBeNull();
  });

  it('seq increases on every push (fade-restart signal for the layer)', () => {
    showKeyBadge('S');
    const first = getKeyBadgeSnapshot()!.seq;
    appendKeyBadge('I');
    expect(getKeyBadgeSnapshot()!.seq).toBeGreaterThan(first);
  });
});
