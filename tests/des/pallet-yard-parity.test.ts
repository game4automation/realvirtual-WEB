// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.7 — PalletYard parity DES ↔ continuous on the REAL scene (CP2, CP2-Gate G6),
// plus the DES-internal FastForward → Animated owner tests (SOL #6, SOL R2 #3).
//   - 30 min sim time, nominal configuration, both kernels through the REAL plugin
//     (`PalletYardPlugin`; DES = the viewer switched to the DES kernel, drained like the
//     viewer's FastForward; continuous = fixed ticks): the same first 10 jobs, shipped
//     throughput within ±10 %, a complete MU balance in each mode
//     (source / conveyors / buffer / forks / sinks);
//   - the set-down pose on a shipping head: continuous vs DES within 5 mm;
//   - [DES FF → Animated] a pallet carried headless sits on ForkAnchor after the switch and
//     arrives on the head (carrier owner, SOL #6);
//   - [DES FF → Animated] a pallet stored headless on a floor slot that is ROTATED 90° and
//     offset sits on the slot pose after the switch (< 5 mm, < 1°) and is picked again
//     correctly (floor-slot owner, SOL R2 #3).
// There is no FastForward in the continuous kernel — those two are DES-internal (G6).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3, type Object3D } from 'three';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { muNode } from '@rv/plugins/des/fleet/des-handover';
import { PALLET_SEAT_M, PALLET_YARD_CONFIG, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import type { YardRun } from '@rv/plugins/models/PalletYard/yard-runtime';
import { FIRST_JOBS_KEPT } from '@rv/core/fleet/exec/job-runner';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { buildYard, seatError, type YardWorld } from './pallet-yard-harness';
import { loadContinuousYard, type ContinuousYard } from './pallet-yard-continuous-scene';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
const T = 1800;
const INPUTS = ['V1', 'V2'] as const;
const SLOTS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

interface Run {
  firstJobs: string[];
  shipped: number;
  produced: number;
  parts: Record<string, number>;
  /** First set-down pose (pallet origin, world) per input. */
  dropPose: Partial<Record<string, Vector3>>;
}

function worldOf(n: Object3D): Vector3 { n.updateWorldMatrix(true, false); return n.getWorldPosition(new Vector3()); }

/** The real plugin in the DES kernel, drained second by second to `T` (the viewer's FastForward drain). */
async function desRun(): Promise<Run> {
  const y = await loadContinuousYard({ plugin: true });
  try {
    y.viewer.simulationKernel!.setMode('des');
    await Promise.resolve();
    const plugin = y.plugin!;
    expect(plugin.runtime?.adapters.kind, 'plugin bound in DES').toBe('des');
    const rt: YardRun = plugin.runtime!;
    const be = rt.adapters as DesHandoverBackend;
    const dropPose: Run['dropPose'] = {};
    const put = be.putOnHead.bind(be);
    be.putOnHead = (vehicle, input) => {
      const pose = be.dockSeatPose(vehicle, input);
      const ok = put(vehicle, input);
      if (ok && pose && !dropPose[input]) dropPose[input] = new Vector3(...pose.position);
      return ok;
    };
    const runner = y.viewer.simulationKernel!.desControl() as unknown as DESRunner;
    const m = runner.getManager();
    for (let t = Math.ceil(m.currentTime) + 1; t <= T; t++) {
      be.clock.schedule(t, () => {});
      m.processUpTo(t, 1e8);
      rt.frame();
    }
    const shipped = INPUTS.reduce((a, i) => a + be.sinkOf(i)!.totalProcessed, 0);
    let onConveyors = 0;
    for (const id of ['A1', 'A2']) onConveyors += be.outputConveyor(id)!.currentLoad;
    for (const id of INPUTS) onConveyors += be.inputConveyor(id)!.currentLoad + be.conveyorOutOf(id)!.currentLoad;
    const inBuffer = SLOTS.filter((s) => be.onSlot(s) !== null).length;
    const onForks = rt.vehicleIds.filter((v) => be.carried(v) !== null).length;
    return {
      firstJobs: [...rt.firstJobs], shipped, produced: rt.counters.produced,
      parts: { shipped, onConveyors, inBuffer, onForks }, dropPose,
    };
  } finally {
    y.dispose();
  }
}

/** The real plugin in the continuous kernel, ticked to `T`. */
async function continuousRun(): Promise<Run> {
  const y: ContinuousYard = await loadContinuousYard({ plugin: true });
  try {
    expect(y.plugin!.runtime?.adapters.kind, 'plugin bound continuous').toBe('continuous');
    const be = y.be;
    const dropPose: Run['dropPose'] = {};
    const put = be.putOnHead.bind(be);
    be.putOnHead = (vehicle, input) => {
      const mu = be.carriedMU(vehicle);
      const ok = put(vehicle, input);
      if (ok && mu && !dropPose[input]) dropPose[input] = worldOf(mu.node);
      return ok;
    };
    y.runTo(T);
    const rt = y.rt;
    const shipped = INPUTS.reduce((a, i) => a + be.shipped[i].length, 0);
    const onOutputs = ['A1', 'A2'].filter((o) => be.palletOnOutput(o) !== null).length;
    const inBuffer = SLOTS.filter((s) => be.onSlot(s) !== null).length;
    const onForks = rt.vehicleIds.filter((v) => be.carried(v) !== null).length;
    const live = be.livePallets();
    return {
      firstJobs: [...rt.firstJobs], shipped, produced: be.counters.spawned,
      parts: { shipped, onOutputs, inBuffer, onForks, onShippingLines: live - onOutputs - inBuffer - onForks, live, edges: be.counters.edges, spawnFailures: be.counters.spawnFailures },
      dropPose,
    };
  } finally {
    y.dispose();
  }
}

describe.skipIf(!AVAILABLE)('PalletYard parity DES ↔ continuous (9.7) — real scene, 30 min', () => {
  let des: Run;
  let cont: Run;
  beforeAll(async () => {
    des = await desRun();
    cont = await continuousRun();
    console.info(`[9.7] DES: shipped ${des.shipped}, produced ${des.produced}, parts ${JSON.stringify(des.parts)}; jobs ${des.firstJobs.join(' | ')}`);
    console.info(`[9.7] continuous: shipped ${cont.shipped}, produced ${cont.produced}, parts ${JSON.stringify(cont.parts)}; jobs ${cont.firstJobs.join(' | ')}`);
  }, 600_000);

  it('the first 10 jobs are the same in both kernels', () => {
    expect(des.firstJobs.length).toBe(FIRST_JOBS_KEPT);
    expect(cont.firstJobs).toEqual(des.firstJobs);
  });

  it('shipped throughput within ±10 %', () => {
    expect(des.shipped, 'DES ships').toBeGreaterThan(0);
    const dev = Math.abs(cont.shipped - des.shipped) / des.shipped;
    console.info(`[9.7] throughput DES ${des.shipped}, continuous ${cont.shipped}: ${(dev * 100).toFixed(1)} %`);
    expect(dev).toBeLessThanOrEqual(0.10);
  });

  it('complete MU balance in each mode (source = conveyors + buffer + forks + sinks)', () => {
    const d = des.parts;
    expect(d.shipped + d.onConveyors + d.inBuffer + d.onForks, JSON.stringify(d)).toBe(des.produced);
    const c = cont.parts;
    expect(c.spawnFailures, 'no lost edge').toBe(0);
    expect(c.edges, 'every edge spawned').toBe(cont.produced);
    expect(c.shipped + c.live, JSON.stringify(c)).toBe(cont.produced);
    expect(c.onShippingLines, 'pallets on the shipping lines').toBeGreaterThanOrEqual(0);
    expect(c.onShippingLines).toBeLessThanOrEqual(4);
  });

  it('the set-down pose on a shipping head: continuous vs DES within 5 mm', () => {
    let compared = 0;
    for (const i of INPUTS) {
      const a = des.dropPose[i];
      const b = cont.dropPose[i];
      if (!a || !b) continue;
      const d = a.distanceTo(b) * 1000;
      console.info(`[9.7] ${i}: DES ${a.toArray().map((x) => x.toFixed(4))} continuous ${b.toArray().map((x) => x.toFixed(4))}: ${d.toFixed(2)} mm`);
      expect(d, `${i} set-down pose (mm)`).toBeLessThanOrEqual(5);
      compared++;
    }
    expect(compared, 'both inputs compared').toBe(2);
  });
});

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

describe('PalletYard DES FastForward → Animated owners (9.7, DES-internal — G6)', () => {
  let w: YardWorld | null = null;
  afterAll(() => { w?.dispose(); w = null; });
  const carrierOf = (y: YardWorld): string | null => y.rt.vehicleIds.find((id) => y.backend.carried(id) !== null) ?? null;

  it('FF carrier: switch to Animated during the loaded drive → the pallet sits on ForkAnchor and arrives on the head', () => {
    w?.dispose();
    w = buildYard('fastforward', { cfg: onePallet() });
    const y = w;
    expect(y.runUntil(() => y.rt.counters.picks >= 1 && y.rt.vehicleIds.some((v) => y.rt.stats(v)!.leg === 'toTo'), 400)).toBe(true);
    const vid = carrierOf(y)!;
    const mu = y.backend.carrierOf(vid)!.held!;
    expect(mu.visual, 'headless in FastForward').toBeNull();
    y.runner.setSubMode('animated');
    const node = muNode(mu)!;
    expect(node, 'materialised').not.toBeNull();
    y.runTo(y.now() + 1 / 30);
    const anchor = y.vehicle(vid).anchor;
    expect(node.parent).toBe(anchor);
    const e = seatError(node, anchor, -PALLET_SEAT_M);
    expect(e.pos).toBeLessThan(0.005);
    expect(e.ang).toBeLessThan(Math.PI / 180);
    expect(y.runUntil(() => Object.values(y.shipped).flat().length > 0, 600)).toBe(true);
    expect(Object.values(y.shipped).flat()).toEqual([mu.id]);
  }, 120_000);

  it('FF floor slot rotated 90° and offset: stored headless, Animated → on the slot pose (< 5 mm, < 1°), picked again correctly', () => {
    w?.dispose();
    // Both inputs paused 0..400 s → the pallet goes to the buffer, retrieved after the pause.
    w = buildYard('fastforward', { cfg: onePallet({ shippingPauses: { everySec: 1e6, durationSec: 400, offsetSec: [0, 0] } }) });
    const y = w;
    for (const s of SLOTS) {
      const n = y.slot(s);
      n.rotation.y += Math.PI / 2;
      n.position.x += 0.35;
      n.position.z -= 0.2;
      n.updateMatrixWorld(true);
    }
    expect(y.runUntil(() => y.rt.counters.stored >= 1, 400)).toBe(true);
    const slot = SLOTS.find((s) => y.backend.onSlot(s) !== null)!;
    const owner = y.backend.slotOwner(slot)!;
    const mu = owner.held!;
    expect(mu.visual, 'headless in FastForward').toBeNull();
    y.runner.setSubMode('animated');
    const node = muNode(mu)!;
    expect(node, 'materialised').not.toBeNull();
    y.runTo(y.now() + 1 / 30);
    const slotNode = y.slot(slot);
    expect(node.parent).toBe(slotNode);
    const e = seatError(node, slotNode, 0);
    console.info(`[9.7] FF slot ${slot}: ${(e.pos * 1000).toFixed(2)} mm, ${(e.ang * 180 / Math.PI).toFixed(3)}°; slot yaw ${(new Quaternion().setFromEuler(slotNode.rotation).angleTo(new Quaternion()) * 180 / Math.PI).toFixed(1)}°`);
    expect(e.pos).toBeLessThan(0.005);
    expect(e.ang).toBeLessThan(Math.PI / 180);
    // Picked again after the pause: on the fork seat, then shipped.
    expect(y.runUntil(() => y.rt.counters.retrieved >= 1, 600)).toBe(true);
    const vid = carrierOf(y)!;
    expect(vid, 'carrier after the retrieve').not.toBeNull();
    y.runTo(y.now() + 1 / 30);
    const anchor = y.vehicle(vid).anchor;
    expect(node.parent).toBe(anchor);
    const f = seatError(node, anchor, -PALLET_SEAT_M);
    expect(f.pos).toBeLessThan(0.005);
    expect(f.ang).toBeLessThan(Math.PI / 180);
    expect(y.runUntil(() => Object.values(y.shipped).flat().length > 0, 600)).toBe(true);
    expect(Object.values(y.shipped).flat()).toEqual([mu.id]);
  }, 120_000);
});
