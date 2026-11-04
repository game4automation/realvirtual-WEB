// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { clearShared } from '../helpers/agv-harness';
import { assertContinuation, compareFullSnapshots } from '../helpers/des-continuation-harness';
import { agvContinuationWorld, findAgvCut, type AgvContinuationWorld } from '../helpers/agv-continuation-world';

afterEach(() => { clearShared(); });

function assertHeldAndWaiting(w: AgvContinuationWorld) {
  const state = w.authorityState();
  const a = state.vehicles.find((v: { id: string }) => v.id === 'A');
  expect(a.held.some(([zone]: [string, number]) => zone === 'crossing')).toBe(true);
  expect(w.zones.holdersOf('crossing')).toEqual(['A']);
  const entries = state.waiters.find(([zone]: [string, unknown]) => zone === 'crossing')?.[1];
  expect(entries).toBeDefined();
  expect(entries.map(([id]: [string, number]) => id)).toEqual(['B']);
  // The serialized tuple order is the authority's FIFO wait-start order.
  expect(entries.map(([, time]: [string, number]) => time)).toEqual(
    entries.map(([, time]: [string, number]) => time).sort((a: number, b: number) => a - b));
}

function zoneCut() {
  return findAgvCut({ zones: true }, w => w.zones.isHolder('crossing', 'A')
    && w.authorityState().waiters.some(([zone, waiters]: [string, [string, number][]]) =>
      zone === 'crossing' && waiters.some(([id]) => id === 'B'))) + 1;
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: without FleetPlugin: held merge zone and FIFO waiter continue only after release`, async () => {
    const T = zoneCut();
    await assertContinuation({ mode, T, TPrime: T + 6, T2: 80,
      buildWorld: () => {
        const w = agvContinuationWorld({ zones: true }), step = w.step.bind(w);
        w.step = t => {
          while (w.manager.currentTime < t) {
            step(Math.min(t, w.manager.currentTime + 0.25));
            if (w.zones.isHolder('crossing', 'A')) {
              expect(w.zones.isHolder('crossing', 'B')).toBe(false);
              expect(w.authority.locate('B', w.manager.currentTime)?.path.id).toBe('Side');
              expect(w.authorityState().vehicles.find((v: { id: string }) => v.id === 'B').held
                .some(([zone]: [string, number]) => zone === 'crossing')).toBe(false);
            }
          }
          if (t === T) assertHeldAndWaiting(w);
          if (t === 80) {
            expect(w.authorityState().waiters.some(([, entries]: [string, [string, number][]]) => entries.some(([id]) => id === 'B'))).toBe(false);
            expect(w.zones.isHolder('crossing', 'B') || !w.zones.holdersOf('crossing').includes('A')).toBe(true);
          }
        };
        return w;
      } });
  }, 60000);
}

it('preflight rejects authority held without the matching fleet.zones holder before mutation', () => {
  const T = zoneCut(), w = agvContinuationWorld({ zones: true });
  try {
    w.step(T); assertHeldAndWaiting(w);
    const before = w.runner.fullSnapshot(), corrupt = JSON.parse(JSON.stringify(before));
    const zones = corrupt.parts.find((p: { key: string }) => p.key === 'fleet.zones').state;
    zones.zones.find((z: { id: string }) => z.id === 'crossing').holders = [];
    zones.byHolder = zones.byHolder.filter((h: { holder: string }) => h.holder !== 'A');
    expect(() => w.runner.restoreFull(corrupt)).toThrow(/fleet\.authority.*held zone.*fleet\.zones/);
    compareFullSnapshots(before, w.runner.fullSnapshot());
  } finally { w.dispose(); }
});
