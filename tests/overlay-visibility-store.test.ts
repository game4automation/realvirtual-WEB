// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isOverlayVisible, setOverlayVisible, showAllOverlays,
  registerOverlayProducer, unregisterOverlayProducer,
  resetOverlayProducers, getOverlaySnapshot, subscribeOverlayVisibility,
} from '../src/core/overlay-visibility-store';

const STORAGE_KEY = 'rv-overlay-visibility';

describe('overlay-visibility-store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetOverlayProducers();
    showAllOverlays();
  });

  it('defaults to visible for all categories', () => {
    expect(isOverlayVisible('tooltips')).toBe(true);
    expect(isOverlayVisible('gizmos')).toBe(true);
    expect(isOverlayVisible('status')).toBe(true);
  });

  it('hides + persists a category', () => {
    setOverlayVisible('signals', false);
    expect(isOverlayVisible('signals')).toBe(false);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.hidden).toContain('signals');
  });

  it('setOverlayVisible is a no-op when already in the wanted state', () => {
    let notified = 0;
    const off = subscribeOverlayVisibility(() => { notified++; });
    setOverlayVisible('gizmos', true); // already visible → no change
    expect(notified).toBe(0);
    setOverlayVisible('gizmos', false); // change
    expect(notified).toBe(1);
    off();
  });

  it('refcount drives presence and clamps at 0', () => {
    registerOverlayProducer('gizmos');
    registerOverlayProducer('gizmos');
    expect(getOverlaySnapshot().present.map(c => c.id)).toContain('gizmos');
    unregisterOverlayProducer('gizmos');
    unregisterOverlayProducer('gizmos');
    unregisterOverlayProducer('gizmos'); // extra unregister — clamp, no throw
    expect(getOverlaySnapshot().present.map(c => c.id)).not.toContain('gizmos');
  });

  it('multiple producers share a category refcount (double-dispose safe)', () => {
    registerOverlayProducer('status'); // e.g. WebSensor
    registerOverlayProducer('status'); // e.g. WebError
    unregisterOverlayProducer('status'); // one leaves
    expect(getOverlaySnapshot().present.map(c => c.id)).toContain('status'); // still present
  });

  it('present-change bumps version → new snapshot ref (React would rerender)', () => {
    const a = getOverlaySnapshot();
    registerOverlayProducer('markers');
    const b = getOverlaySnapshot();
    expect(b).not.toBe(a);
    expect(b.version).toBeGreaterThan(a.version);
    expect(b.present.map(c => c.id)).toContain('markers');
  });

  it('snapshot reference is STABLE when nothing changes (no infinite rerender)', () => {
    expect(getOverlaySnapshot()).toBe(getOverlaySnapshot());
  });

  it('present list is in catalog order', () => {
    registerOverlayProducer('markers');
    registerOverlayProducer('tooltips');
    const ids = getOverlaySnapshot().present.map(c => c.id);
    // catalog order: tooltips before markers
    expect(ids.indexOf('tooltips')).toBeLessThan(ids.indexOf('markers'));
  });

  it('showAllOverlays clears the hidden set', () => {
    setOverlayVisible('status', false);
    setOverlayVisible('tooltips', false);
    showAllOverlays();
    expect(isOverlayVisible('status')).toBe(true);
    expect(isOverlayVisible('tooltips')).toBe(true);
  });

  it('subscribe/unsubscribe works', () => {
    let n = 0;
    const off = subscribeOverlayVisibility(() => { n++; });
    setOverlayVisible('gizmos', false);
    expect(n).toBe(1);
    off();
    setOverlayVisible('gizmos', true);
    expect(n).toBe(1); // no further notifications after unsubscribe
  });
});
