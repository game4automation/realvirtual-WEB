// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.1b — wake-ups of the PalletYard runtime on the plugin clock (SOL #5),
// DES Animated + FastForward with the real DESRunner (pallet-yard-harness.ts):
//   - a shipping pause begins during the approach → the stacker waits in the dock;
//     the pause ends while it waits → the drop happens AT the pause-end event;
//   - the target is occupied when the stacker arrives → it waits, and the input
//     freeing up (pallet onto ConveyorOut) wakes it in the same event;
//   - both chargers busy → the third vehicle queues at the wait point; the first
//     charger to free is taken by it in the same event.
import { afterEach, describe, expect, it } from 'vitest';
import { PALLET_YARD_CONFIG, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import type { DESMU } from '@rv/plugins/des/rv-des-mu';
import { buildYard, type YardMode, type YardWorld } from './pallet-yard-harness';

let w: YardWorld | null = null;
afterEach(() => { w?.dispose(); w = null; });

const MODES: YardMode[] = ['animated', 'fastforward'];

function cfgWith(over: Partial<PalletYardConfig> = {}): PalletYardConfig {
  return {
    ...PALLET_YARD_CONFIG,
    production: { intervalSec: 1e6, phaseSec: [0, 1e6] },
    shippingPauses: { everySec: 1e6, durationSec: 0, offsetSec: [0, 0] },
    battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [90, 90, 90] },
    ...over,
  };
}

/** The vehicle with a pick job on its way to the destination, and that destination. */
function delivering(y: YardWorld): { v: string; to: string } | null {
  for (const v of y.rt.vehicleIds) {
    const j = y.rt.dispatcher.jobOf(v);
    if (j?.kind === 'pick' && y.rt.stats(v)!.leg === 'toTo') return { v, to: j.to.station };
  }
  return null;
}

/** Record the sim times at which `input`'s conveyor accepts an MU. */
function acceptTimes(y: YardWorld, input: string): number[] {
  const conv = y.backend.inputConveyor(input)!;
  const out: number[] = [];
  const prev = conv.onMUEnter;
  conv.onMUEnter = (mu: DESMU) => { prev?.(mu); out.push(y.runner.getManager().currentTime); };
  return out;
}

describe('PalletYard wake-ups (9.1b)', () => {
  for (const mode of MODES) {
    it(`[${mode}] pause begins during the approach → waits in the dock; pause end → drop at that event`, () => {
      // Run 1: when does the loaded drive to the input start?
      w = buildYard(mode, { cfg: cfgWith() });
      expect(w.runUntil(() => delivering(w!) !== null, 400, 0.25)).toBe(true);
      const tDrive = w.now();
      const { to } = delivering(w)!;
      w.dispose();
      // Run 2 (deterministic up to the pause): both inputs pause 1 s after that start, for 120 s.
      const start = Math.ceil(tDrive) + 1, end = start + 120;
      w = buildYard(mode, { cfg: cfgWith({ shippingPauses: { everySec: 1e6, durationSec: 120, offsetSec: [start, start] } }) });
      const accepted = acceptTimes(w, to);
      expect(w.runUntil(() => delivering(w!) !== null, 400, 0.25)).toBe(true);
      expect(delivering(w)!.to).toBe(to);
      const { v } = delivering(w)!;
      expect(w.runUntil(() => w!.rt.stats(v)!.waitingAt === to, 200, 0.25)).toBe(true);
      expect(w.now()).toBeGreaterThan(start);
      expect(w.now()).toBeLessThan(end);
      expect(w.rt.stats(v)!.leg).toBe('atTo');
      w.runTo(end - 1);
      expect(accepted).toEqual([]);
      expect(w.backend.carried(v)).not.toBeNull();
      w.runTo(end + 1);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toBeCloseTo(end, 6);
      expect(w.rt.stats(v)!.waitingAt).toBeNull();
    }, 120_000);

    it(`[${mode}] target occupied on arrival → waits; the input freeing up wakes it in the same event`, () => {
      w = buildYard(mode, { cfg: cfgWith() });
      expect(w.runUntil(() => delivering(w!) !== null, 400, 0.25)).toBe(true);
      const { v, to } = delivering(w)!;
      // Occupy the target behind the dispatcher's back: a foreign pallet parks on its conveyor.
      const conv = w.backend.inputConveyor(to)!;
      w.backend.setInputRun(to, false);
      const foreign = w.runner.createMU();
      expect(conv.acceptMU(foreign)).toBe(true);
      const accepted = acceptTimes(w, to);
      expect(w.runUntil(() => w!.rt.stats(v)!.waitingAt === to, 200, 0.25)).toBe(true);
      w.runTo(w.now() + 30);
      expect(accepted).toEqual([]);                       // still waiting, pallet on the fork
      expect(w.backend.carried(v)).not.toBeNull();
      // Free the input from inside a DES event: the foreign pallet leaves onto ConveyorOut (CP1c).
      let freedAt = -1;
      w.backend.clock.schedule(w.now() + 1, () => { freedAt = w!.runner.getManager().currentTime; w!.backend.setInputRun(to, true); });
      w.runTo(w.now() + 3);
      expect(w.backend.conveyorOutOf(to)!.currentLoad).toBe(1);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toBeCloseTo(freedAt, 6);       // woken in the same instant
      expect(w.rt.stats(v)!.waitingAt).toBeNull();
      expect(w.runUntil(() => w!.shipped[to].length > 0, 120, 0.5)).toBe(true);
      expect(w.shipped[to][0]).toBe(foreign.id);
    }, 120_000);

    it(`[${mode}] both chargers busy → the third queues at the wait point and takes the first free charger at once`, () => {
      w = buildYard(mode, { cfg: cfgWith({ battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [20, 22, 24] } }) });
      w.runTo(1);
      const queued = w.rt.vehicleIds.filter((id) => w!.rt.stats(id)!.job === 'queue');
      expect(queued).toHaveLength(1);
      expect(w.rt.dispatcher.chargerQueue).toEqual(queued);
      expect(w.rt.waitPointOwner).toBe(queued[0]);
      expect(w.runUntil(() => w!.rt.stats(queued[0])!.leg === 'atWait', 200, 0.25)).toBe(true);
      // the first charge ends → in the same event the queued vehicle is sent to that charger
      expect(w.runUntil(() => w!.rt.vehicleIds.some((id) => w!.rt.stats(id)!.charges >= 1), 2000, 0.25)).toBe(true);
      expect(w.rt.stats(queued[0])!.leg).toBe('toCharger');
      expect(w.rt.dispatcher.chargerQueue).toEqual([]);
      expect(w.runUntil(() => w!.rt.stats(queued[0])!.leg === 'charging', 300, 0.25)).toBe(true);
    }, 120_000);
  }
});
