// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * asset-cache-outcomes.node.test.ts — plan-508 F6.
 *
 * The outcome ring behind `web_status.cache` and DevTools › Asset cache: a
 * capped ring (128) of the latest records plus cumulative counters per outcome.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CACHE_OUTCOME_CAP,
  CACHE_OUTCOMES,
  cacheOutcomeVersion,
  clearCacheOutcomes,
  getCacheOutcomes,
  recordCacheOutcome,
  setCachePersisted,
  type CacheOutcome,
} from '../src/core/engine/rv-asset-cache-outcomes';

beforeEach(() => {
  clearCacheOutcomes();
  setCachePersisted(null);
});

const push = (i: number, outcome: CacheOutcome): void =>
  recordCacheOutcome({ bucket: 'rv-assets-glb-v2', url: `/library/a${i}.glb`, outcome, bytes: i, ms: 1.234, at: 1000 + i });

describe('cache outcomes ring', () => {
  it('keeps the last 128 records and counts per outcome', () => {
    expect(CACHE_OUTCOME_CAP).toBe(128);
    for (let i = 0; i < 200; i++) push(i, i % 4 === 0 ? 'miss' : 'hit');
    const all = getCacheOutcomes({ last: 1000 });
    expect(all.outcomes).toHaveLength(128);
    // The oldest 72 fell out; the ring holds 72…199.
    expect(all.outcomes[0].url).toBe('/library/a72.glb');
    expect(all.outcomes[127].url).toBe('/library/a199.glb');
    // Counters are cumulative since the last clear, not bounded by the ring.
    expect(all.counts.miss).toBe(50);
    expect(all.counts.hit).toBe(150);
    expect(all.total).toBe(200);
    for (const o of CACHE_OUTCOMES) expect(typeof all.counts[o]).toBe('number');
    expect(all.outcomes[0].ms).toBe(1.2);
  });

  it('getCacheOutcomes({ last: 5 }) returns the newest five, newest last', () => {
    for (let i = 0; i < 12; i++) push(i, 'revalidated');
    const five = getCacheOutcomes({ last: 5 }).outcomes;
    expect(five.map((r) => r.url)).toEqual([7, 8, 9, 10, 11].map((i) => `/library/a${i}.glb`));
    expect(getCacheOutcomes().outcomes).toHaveLength(12); // default 20
    expect(getCacheOutcomes({ last: 0 }).outcomes).toEqual([]);
    // Snapshots are copies — a consumer cannot edit the ring.
    five[0].url = 'mutated';
    expect(getCacheOutcomes({ last: 5 }).outcomes[0].url).toBe('/library/a7.glb');
  });

  it('clear empties the ring and the counters and bumps the version; persisted is reported', () => {
    push(1, 'hash-mismatch');
    const v = cacheOutcomeVersion();
    clearCacheOutcomes();
    expect(cacheOutcomeVersion()).toBeGreaterThan(v);
    const snap = getCacheOutcomes();
    expect(snap.outcomes).toEqual([]);
    expect(snap.total).toBe(0);
    expect(snap.persisted).toBeNull();
    setCachePersisted(true);
    expect(getCacheOutcomes().persisted).toBe(true);
  });
});
