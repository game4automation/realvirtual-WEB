// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-686 §9.4 — REGRESSION: the PalletYard at a 180 s production takt, 8 h DES FastForward on the
// real GLB scene. Before plan-686 the yard deadlocked at sim t ≈ 14990 s (hour 5): Stapler_3 in
// Stich_P1 held Merge_P2_P3 (claimed before a reverse task into Stich_A1, orphaned by the task and
// direction change) and waited for Merge_A1_P1, which Stapler_2 held while waiting for Merge_P2_P3
// (165 pallets in 8 h, none after hour 5). Now: no wait cycle in any hourly sample, pallets in every
// hour after the warm-up, every step-4 release geometrically safe. Own file = own vitest process.

import { describe, expect, it } from 'vitest';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';
import { runTakt } from './pallet-yard-takt-run';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
const TAKT = 180;
const HOURS = 8;
const WARMUP_H = 1;

describe.skipIf(!AVAILABLE)(`plan-686 PalletYard takt ${TAKT} s (regression, was a deadlock)`, () => {
  it(`${HOURS} h DES FastForward without a zone wait cycle`, async () => {
    const r = await runTakt(TAKT, HOURS);
    console.log('TAKT_RESULT ' + JSON.stringify(r));
    expect(r.simTimeSec).toBeGreaterThanOrEqual(HOURS * 3600 - 1);
    expect(r.firstCycle).toBeNull();
    for (let h = WARMUP_H; h < r.shippedPerHour.length; h++) expect(r.shippedPerHour[h], `hour ${h + 1}`).toBeGreaterThan(0);
    expect(r.safetyViolations).toEqual([]);
    expect(r.mbViolations).toBe(0);
    expect(r.staleClaimsUnexpected).toBe(0);
  }, 1_800_000);
});
