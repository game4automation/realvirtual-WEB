// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-652 §9.15 — intent prefetch (80 ms delay, cancel on leave, pointerdown at once) and the
 * idle prefetch gate (pointer: fine, Save-Data, effectiveType, missing navigator.connection,
 * missing requestIdleCallback is the caller's whenIdle seam).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIntentPrefetcher,
  lazyFeaturesForMode,
  scheduleIdlePrefetch,
  shouldIdlePrefetch,
  INTENT_PREFETCH_DELAY_MS,
  type PrefetchLoader,
} from '../src/core/rv-feature-prefetch';

function fakeLoader(rows: { id: string; state: string; activation: string[] }[]) {
  const preload = vi.fn<(id: string) => void>();
  const loader: PrefetchLoader = { statuses: () => rows, preload };
  return Object.assign(loader, { preload });
}

const ROWS = [
  { id: 'asset-editor', state: 'declared', activation: ['mode:editor'] },
  { id: 'des', state: 'declared', activation: ['mode:des', 'component:DESSource'] },
  { id: 'eager', state: 'active', activation: ['startup'] },
];

const fine = { matchMedia: (q: string) => ({ matches: q === '(pointer: fine)' }) };

describe('lazyFeaturesForMode', () => {
  it('lists declared features of the mode and nothing for an active or unknown one', () => {
    expect(lazyFeaturesForMode(fakeLoader(ROWS), 'editor')).toEqual(['asset-editor']);
    expect(lazyFeaturesForMode(fakeLoader([{ ...ROWS[0], state: 'active' }]), 'editor')).toEqual([]);
    expect(lazyFeaturesForMode(fakeLoader(ROWS), 'hmi')).toEqual([]);
    expect(lazyFeaturesForMode(undefined, 'editor')).toEqual([]);
  });
});

describe('intent prefetch (§2.4.6)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('preloads after the 80 ms hover delay, not before', () => {
    const loader = fakeLoader(ROWS);
    const p = createIntentPrefetcher(() => loader);
    p.enter('editor');
    vi.advanceTimersByTime(INTENT_PREFETCH_DELAY_MS - 1);
    expect(loader.preload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loader.preload).toHaveBeenCalledWith('asset-editor');
  });

  it('cancels when the pointer leaves before the delay ran out', () => {
    const loader = fakeLoader(ROWS);
    const p = createIntentPrefetcher(() => loader);
    p.enter('des');
    vi.advanceTimersByTime(40);
    p.leave('des');
    vi.advanceTimersByTime(200);
    expect(loader.preload).not.toHaveBeenCalled();
  });

  it('pointerdown preloads at once (touch has no hover) and does not fire twice', () => {
    const loader = fakeLoader(ROWS);
    const p = createIntentPrefetcher(() => loader);
    p.enter('des');
    p.down('des');
    expect(loader.preload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(loader.preload).toHaveBeenCalledTimes(1);
  });

  it('starts no timer for a mode without on-demand features, and cancelAll clears pending ones', () => {
    const loader = fakeLoader(ROWS);
    const p = createIntentPrefetcher(() => loader);
    p.enter('hmi');
    p.enter('editor');
    p.cancelAll();
    vi.advanceTimersByTime(200);
    expect(loader.preload).not.toHaveBeenCalled();
  });
});

describe('idle prefetch gate (§2.4.6)', () => {
  it('needs a fine pointer', () => {
    expect(shouldIdlePrefetch({ matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(shouldIdlePrefetch({})).toBe(false);
    expect(shouldIdlePrefetch(fine)).toBe(true); // no navigator.connection (Firefox, Safari)
  });

  it('skips Save-Data and slow connections', () => {
    expect(shouldIdlePrefetch({ ...fine, connection: { saveData: true } })).toBe(false);
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect(shouldIdlePrefetch({ ...fine, connection: { effectiveType } })).toBe(false);
    }
    expect(shouldIdlePrefetch({ ...fine, connection: { effectiveType: '4g', saveData: false } })).toBe(true);
  });

  it('hints every chunk file of the declared on-demand features once, after idle', () => {
    const loader = fakeLoader(ROWS);
    const hints: string[] = [];
    let idle: (() => void) | null = null;
    scheduleIdlePrefetch(loader, {
      env: fine,
      whenIdle: (cb) => { idle = cb; },
      filesOf: (id) => (id === 'asset-editor' ? ['assets/a.js', 'assets/shared.js'] : ['assets/d.js', 'assets/shared.js']),
      addHint: (href) => hints.push(href),
    });
    expect(hints).toEqual([]); // nothing before idle
    idle!();
    expect(hints).toEqual(['assets/a.js', 'assets/shared.js', 'assets/d.js']);
    expect(loader.preload).not.toHaveBeenCalled(); // download hint only, no import
  });

  it('schedules nothing when the gate says no', () => {
    const whenIdle = vi.fn();
    scheduleIdlePrefetch(fakeLoader(ROWS), { env: { matchMedia: () => ({ matches: false }) }, whenIdle });
    expect(whenIdle).not.toHaveBeenCalled();
  });
});
