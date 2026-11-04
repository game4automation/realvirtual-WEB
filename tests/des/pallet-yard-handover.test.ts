// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 4 CP1 — DES hand-over of the PalletYard runtime with the REAL
// DESRunner (Animated + FastForward), real Source / Conveyor definitions and
// three real Agv vehicles on the layout graph (pallet-yard-harness.ts):
//   - pick at a production output end: exactly once, totalProcessed +1, no double
//     processing on extra wake-ups, pallet seated on ForkAnchor;
//   - drop on a shipping input head: the same pallet reaches the sink;
//   - store on a floor slot and retrieve it (inputs paused), seat on the slot;
//   - FastForward → Animated with a pallet on the fork: reconcile seats it;
//   - full MU balance after 1 h (shipping lines incl. ConveyorOut, CP1c).
import { afterEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { muNode } from '@rv/plugins/des/fleet/des-handover';
import { PALLET_YARD_CONFIG, PALLET_SEAT_M, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import { buildYard, seatError, type YardMode, type YardWorld } from './pallet-yard-harness';

let w: YardWorld | null = null;
afterEach(() => { w?.dispose(); w = null; });

const MODES: YardMode[] = ['animated', 'fastforward'];

/** One pallet only (A1 at t=0), no pauses, nobody needs charging. */
function onePallet(over: Partial<PalletYardConfig> = {}): PalletYardConfig {
  return {
    ...PALLET_YARD_CONFIG,
    production: { intervalSec: 1e6, phaseSec: [0, 1e6] },
    shippingPauses: { everySec: 1e6, durationSec: 0, offsetSec: [0, 0] },
    battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [90, 90, 90] },
    ...over,
  };
}

const carrierOf = (y: YardWorld): string | null => y.rt.vehicleIds.find((id) => y.backend.carried(id) !== null) ?? null;

function balance(y: YardWorld): { produced: number; accounted: number; parts: Record<string, number> } {
  const shipped = Object.values(y.shipped).reduce((a, l) => a + l.length, 0);
  let onConveyors = 0;
  for (const id of ['A1', 'A2']) onConveyors += y.backend.outputConveyor(id)!.currentLoad;
  for (const id of ['V1', 'V2']) onConveyors += y.backend.inputConveyor(id)!.currentLoad + y.backend.conveyorOutOf(id)!.currentLoad;
  const inBuffer = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].filter((s) => y.backend.onSlot(s) !== null).length;
  const onForks = y.rt.vehicleIds.filter((v) => y.backend.carried(v) !== null).length;
  return { produced: y.rt.counters.produced, accounted: shipped + onConveyors + inBuffer + onForks, parts: { shipped, onConveyors, inBuffer, onForks } };
}

describe('PalletYard DES hand-over (CP1)', () => {
  for (const mode of MODES) {
    it(`[${mode}] pick at the output end exactly once, drop on a shipping head, the same pallet ships`, () => {
      w = buildYard(mode, { cfg: onePallet() });
      const conv = w.backend.outputConveyor('A1')!;
      expect(w.runUntil(() => w!.rt.counters.picks >= 1, 400)).toBe(true);
      const vid = carrierOf(w)!;
      expect(vid).not.toBeNull();
      const carrier = w.backend.carrierOf(vid)!;
      const mu = carrier.held!;
      expect(conv.totalProcessed).toBe(1);
      expect((conv.self.local as unknown as { blockedMUs: unknown[] }).blockedMUs).toHaveLength(0);
      expect(conv.currentLoad).toBe(0);
      // double-processing probe: wake the conveyor from every neighbour
      conv.onDownstreamReady(carrier);
      conv.onDownstreamReady(w.backend.sourceOf('A1')!);
      w.runTo(w.now() + 5);
      expect(conv.totalProcessed).toBe(1);
      expect(carrier.held).toBe(mu);
      if (mode === 'animated') {
        const node = muNode(mu)!;
        expect(node.parent).toBe(w.vehicle(vid).anchor);
        const e = seatError(node, w.vehicle(vid).anchor, -PALLET_SEAT_M);
        expect(e.pos).toBeLessThan(0.005);
        expect(e.ang).toBeLessThan(Math.PI / 180);
      }
      expect(w.runUntil(() => Object.values(w!.shipped).some((l) => l.length > 0), 600)).toBe(true);
      expect(Object.values(w.shipped).flat()).toEqual([mu.id]);
      expect(w.rt.counters).toMatchObject({ produced: 1, picks: 1, delivered: 1, stored: 0 });
      expect(carrier.held).toBeNull();
      expect(w.rt.stats(vid)!.ordersDone).toBe(1);
      // nobody idles in a stich afterwards: the vehicle got the wait point or cruises
      w.runTo(w.now() + 30);
      expect(['toWait', 'atWait', 'cruise']).toContain(w.rt.stats(vid)!.leg);
    }, 120_000);

    it(`[${mode}] store on a floor slot while both inputs pause, retrieve it after the pause, ship it`, () => {
      // Both inputs paused 0..400 s → the first pallet goes to the buffer.
      w = buildYard(mode, { cfg: onePallet({ shippingPauses: { everySec: 1e6, durationSec: 400, offsetSec: [0, 0] } }) });
      expect(w.runUntil(() => w!.rt.counters.stored >= 1, 400)).toBe(true);
      const slot = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].find((s) => w!.backend.onSlot(s) !== null)!;
      expect(slot).toBeDefined();
      const owner = w.backend.slotOwner(slot)!;
      const mu = owner.held!;
      expect(owner.currentLoad).toBe(1);
      expect(w.rt.dispatcher.storage('Buffer').occupancy()).toBe(1);
      expect(w.rt.vehicleIds.every((v) => w!.backend.carried(v) === null)).toBe(true);
      if (mode === 'animated') {
        const node = muNode(mu)!;
        expect(node.parent).toBe(w.slot(slot));
        expect(seatError(node, w.slot(slot), 0).pos).toBeLessThan(0.005);
      }
      // nothing ships during the pause, the slot keeps the pallet (no auto hand-on)
      w.runTo(399);
      expect(Object.values(w.shipped).flat()).toEqual([]);
      expect(owner.held).toBe(mu);
      // pause over → FIFO retrieval (no output waits) → shipped
      expect(w.runUntil(() => Object.values(w!.shipped).flat().length > 0, 600)).toBe(true);
      expect(Object.values(w.shipped).flat()).toEqual([mu.id]);
      expect(w.rt.counters).toMatchObject({ stored: 1, retrieved: 1, delivered: 1 });
      expect(owner.currentLoad).toBe(0);
      expect(w.rt.dispatcher.storage('Buffer').occupancy()).toBe(0);
    }, 120_000);
  }

  it('[fastforward → animated] a pallet carried headless is seated on ForkAnchor by the reconcile', () => {
    w = buildYard('fastforward', { cfg: onePallet() });
    expect(w.runUntil(() => w!.rt.counters.picks >= 1, 400)).toBe(true);
    const vid = carrierOf(w)!;
    const mu = w.backend.carrierOf(vid)!.held!;
    expect(mu.visual).toBeNull();                       // headless in FastForward
    w.runner.setSubMode('animated');                   // materialises headless MUs
    const node = muNode(mu)!;
    expect(node).not.toBeNull();
    const anchor: Object3D = w.vehicle(vid).anchor;
    w.runTo(w.now() + 1 / 30);                          // one frame → reconcile
    expect(node.parent).toBe(anchor);
    const e = seatError(node, anchor, -PALLET_SEAT_M);
    expect(e.pos).toBeLessThan(0.005);
    expect(e.ang).toBeLessThan(Math.PI / 180);
    expect(w.runUntil(() => Object.values(w!.shipped).flat().length > 0, 600)).toBe(true);
    expect(Object.values(w.shipped).flat()).toEqual([mu.id]);
  }, 120_000);

  it('[fastforward] 1 h nominal: full MU balance, every vehicle works, nobody runs empty', () => {
    w = buildYard('fastforward');
    w.runTo(3600);
    const b = balance(w);
    expect(b.accounted, JSON.stringify(b.parts)).toBe(b.produced);
    expect(b.produced).toBeGreaterThan(30);
    // Every vehicle works. Not ">5 each" any more (plan-631 Phase 2): the conveyors take a
    // pallet over mid-belt (shorter transits), the six floor slots fill in the first
    // pauses and - the known CP3 buffer rule (retrieve only while no output waits) - stay
    // full; from then on the nearest-vehicle dispatch always picks the two vehicles coming
    // back from the shipping inputs, the third (Stapler_2, 4 orders) parks at the wait
    // point. The throughput is carried by the sum.
    let orders = 0;
    for (const v of w.rt.vehicleIds) {
      expect(w.rt.stats(v)!.ordersDone, v).toBeGreaterThan(0);
      expect(w.rt.stats(v)!.minSoc, v).toBeGreaterThan(0);
      orders += w.rt.stats(v)!.ordersDone;
    }
    expect(orders).toBeGreaterThan(30);
    expect(w.rt.counters.stored).toBeGreaterThan(0);  // the pauses (t=300/900) fill the buffer
  }, 120_000);
});
