// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { OrderPool } from '../../src/core/fleet/core/orders';
import { YardOrderKpis } from '../../src/plugins/models/PalletYard/yard-order-kpis';
import { palletYardKpis } from '../../src/plugins/models/PalletYard/parameters';

describe('PalletYard mean order time', () => {
  it('reads null before completion and the exact creation-to-completion mean', () => {
    const pool = new OrderPool();
    const observations = new YardOrderKpis();
    observations.reset(pool);
    const row = palletYardKpis({ counters: () => null, simSeconds: () => 0,
      meanOrderSec: () => observations.meanOrderSec(),
    }).find(kpi => kpi.key === 'kpi.meanOrderSec')!;
    expect(row).toMatchObject({ label: 'Mean order time', unit: 's', kind: 'sim', decimals: 1 });
    expect(row.read()).toBeNull();
    pool.complete(pool.add({ source: 'A' }, 3), 13);
    pool.complete(pool.add({ source: 'B' }, 7), 32);
    expect(row.read()).toBe(17.5);
    observations.reset();
    expect(row.read()).toBeNull();
    pool.complete(pool.add({ source: 'A' }, 0), 100);
    expect(row.read()).toBeNull();
  });

  it('starts empty on a new pool and on a new run using the same pool', () => {
    const oldPool = new OrderPool();
    const nextPool = new OrderPool();
    const observations = new YardOrderKpis();
    observations.reset(oldPool);
    oldPool.complete(oldPool.add({ source: 'A' }, 0), 10);
    observations.reset(nextPool);
    oldPool.complete(oldPool.add({ source: 'A' }, 0), 100);
    expect(observations.meanOrderSec()).toBeNull();
    nextPool.complete(nextPool.add({ source: 'B' }, 2), 6);
    expect(observations.meanOrderSec()).toBe(4);
    observations.reset(nextPool);
    nextPool.reset();
    expect(observations.meanOrderSec()).toBeNull();
    nextPool.complete(nextPool.add({ source: 'B' }, 1), 7);
    expect(observations.meanOrderSec()).toBe(6);
    observations.reset();
  });

  it('supports sources without completion observations', () => {
    const row = palletYardKpis({ counters: () => null, simSeconds: () => 0 })
      .find(kpi => kpi.key === 'kpi.meanOrderSec')!;
    expect(row.read()).toBeNull();
  });
});

it('restores detached KPI state silently and keeps its completion subscription', () => {
  const pool = new OrderPool(), kpis = new YardOrderKpis();
  kpis.reset(pool);
  pool.complete(pool.add({ source: 'A' }, 0), 10);
  const state = kpis.exportState(), prepared = kpis.prepareState(state);
  state.sumSec = 999;
  kpis.swapState(prepared);
  expect(kpis.meanOrderSec()).toBe(10);
  pool.complete(pool.add({ source: 'A' }, 0), 20);
  expect(kpis.meanOrderSec()).toBe(15);
  expect(kpis.validateState({ sumSec: NaN, count: -1 })).not.toEqual([]);
  kpis.reset();
});
