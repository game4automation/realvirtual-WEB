// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-activity-display.test.ts — plan-234 Phase 4 pure display helpers.
 *
 * Covers the row-level activity display classification (opacity, inactive flag,
 * status marker, status hint) for all five SignalActivity states, plus the
 * feature-flag store default/persistence logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  type SignalActivity,
  activityIsInactive,
  activityOpacity,
  activityStatusMarker,
  activityStatusHint,
  INACTIVE_ROW_OPACITY,
} from '../src/core/engine/rv-signal-activity';
import {
  getSignalActivityIndicator,
  setSignalActivityIndicator,
  toggleSignalActivityIndicator,
} from '../src/core/hmi/signal-activity-indicator-store';

const ALL: SignalActivity[] = ['live', 'supplied', 'local', 'stale', 'no-source'];

describe('activityIsInactive', () => {
  it('is true only for stale and no-source', () => {
    expect(activityIsInactive('stale')).toBe(true);
    expect(activityIsInactive('no-source')).toBe(true);
  });

  it('is false for live, supplied and local (active states)', () => {
    expect(activityIsInactive('live')).toBe(false);
    expect(activityIsInactive('supplied')).toBe(false);
    expect(activityIsInactive('local')).toBe(false);
  });
});

describe('activityOpacity', () => {
  it('dims inactive rows (stale / no-source)', () => {
    expect(activityOpacity('stale')).toBe(INACTIVE_ROW_OPACITY);
    expect(activityOpacity('no-source')).toBe(INACTIVE_ROW_OPACITY);
  });

  it('renders active rows at full opacity', () => {
    expect(activityOpacity('live')).toBe(1);
    expect(activityOpacity('supplied')).toBe(1);
    expect(activityOpacity('local')).toBe(1);
  });

  it('opacity always matches the inactive classification', () => {
    for (const a of ALL) {
      expect(activityOpacity(a)).toBe(activityIsInactive(a) ? INACTIVE_ROW_OPACITY : 1);
    }
  });
});

describe('activityStatusMarker', () => {
  it('maps stale → warn', () => {
    expect(activityStatusMarker('stale')).toBe('warn');
  });

  it('maps no-source → empty', () => {
    expect(activityStatusMarker('no-source')).toBe('empty');
  });

  it('maps active states (live / supplied / local) → none', () => {
    expect(activityStatusMarker('live')).toBe('none');
    expect(activityStatusMarker('supplied')).toBe('none');
    expect(activityStatusMarker('local')).toBe('none');
  });

  it('emits a marker exactly when the state is inactive', () => {
    for (const a of ALL) {
      const hasMarker = activityStatusMarker(a) !== 'none';
      expect(hasMarker).toBe(activityIsInactive(a));
    }
  });
});

describe('activityStatusHint (A11y text — never color alone)', () => {
  it('provides a text hint for inactive states', () => {
    expect(activityStatusHint('stale')).toBe('stale');
    expect(activityStatusHint('no-source')).toBe('no data');
  });

  it('is empty for active/neutral states', () => {
    expect(activityStatusHint('live')).toBe('');
    expect(activityStatusHint('supplied')).toBe('');
    expect(activityStatusHint('local')).toBe('');
  });

  it('has a non-empty hint exactly when there is a marker', () => {
    for (const a of ALL) {
      const hasHint = activityStatusHint(a) !== '';
      expect(hasHint).toBe(activityStatusMarker(a) !== 'none');
    }
  });
});

describe('signalActivityIndicator feature flag (§10-H)', () => {
  beforeEach(() => {
    try { localStorage.removeItem('rv-signal-activity-indicator'); } catch { /* ignore */ }
    // Force back to the default ON state for a clean baseline.
    setSignalActivityIndicator(true);
  });

  it('defaults to ON', () => {
    expect(getSignalActivityIndicator()).toBe(true);
  });

  it('setSignalActivityIndicator(false) turns it off and persists', () => {
    setSignalActivityIndicator(false);
    expect(getSignalActivityIndicator()).toBe(false);
    expect(localStorage.getItem('rv-signal-activity-indicator')).toBe('0');
  });

  it('toggle flips the value', () => {
    const before = getSignalActivityIndicator();
    toggleSignalActivityIndicator();
    expect(getSignalActivityIndicator()).toBe(!before);
    toggleSignalActivityIndicator();
    expect(getSignalActivityIndicator()).toBe(before);
  });
});
