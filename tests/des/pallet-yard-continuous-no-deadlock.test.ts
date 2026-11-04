// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-559 continuous-operation regression: an owner-based occupancy check and a
// sink-aware end-of-line fallback (src/behaviors/_shared/surface-occupancy.ts,
// src/behaviors/_shared/transport-links.ts) are what let the shipping conveyors
// (V1/V2) ever hand a pallet off to their Sink in continuous mode. Before that fix,
// the yard shipped exactly 2 pallets total (one per station) and then deadlocked
// forever: a part resting at its own conveyor's end sensor grazed the next
// segment's footprint by a few millimetres, which that segment misread as "already
// occupied" and refused to run — and the segment feeding the Sink had no snap-paired
// successor, so it treated "nothing paired" as a dead end instead of checking for an
// accepting Sink. This test runs continuous production long enough to see several
// shipping cycles and asserts throughput never plateaus.
import { describe, expect, it } from 'vitest';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { loadContinuousYard } from './pallet-yard-continuous-scene';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);

describe.skipIf(!AVAILABLE)('PalletYard continuous shipping (plan-559 no-deadlock regression)', () => {
  it('ships pallets continuously for 2400 s — consumption keeps increasing, never plateaus', async () => {
    const y = await loadContinuousYard({ plugin: true });
    try {
      const consumed = (): number =>
        Object.values(y.be.shipped).reduce((sum, ids) => sum + ids.length, 0);
      let previous = 0;
      for (let window = 0; window < 4; window++) {
        y.runTo((window + 1) * 600);
        const now = consumed();
        expect(now, `sink consumption must advance in window ${window} (t=${(window + 1) * 600})`).toBeGreaterThan(previous);
        previous = now;
      }
      expect(previous).toBeGreaterThan(2);
    } finally {
      y.dispose();
    }
  }, 180_000);
});
