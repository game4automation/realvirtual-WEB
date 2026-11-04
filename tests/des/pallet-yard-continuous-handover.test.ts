// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.7a — the continuous PalletYard hand-over on the REAL scene (CP2, SOL R2 #4,
// CP2-Gate G1–G3): real roller conveyors moved by the RVTransportManager, their own end
// sensors, the real Source edge, three real Agv stackers in the continuous kernel.
//   - one pallet: produced by ONE GenerateMU edge, runs to the end sensor, picked WITHOUT a
//     jump (world pose before/after the hold), glides onto the fork seat (≤ 1 mm per tick),
//     driven, set down on the shipping head without an x/z jump (height ≤ 5 mm) and at the
//     layout head pose (≤ 5 mm), runs the shipping line into the sink; MU balance;
//   - occupied head: the stacker waits in the dock with the pallet on its seat; the head
//     frees → the drop happens at once (onInputFreed);
//   - a drop refused AFTER the detach rolls back hold AND seat pose (no jump), the vehicle
//     stays in the dock, the retry (DROP_RETRY_SEC) succeeds — never a permanent wait;
//   - an edge without a spawn is counted and reported, never counted as a pallet (G3);
//   - SOC / status signals / lamps run in the continuous mode too (CP2 c4).
// Every assertion on a looked-up value first asserts that it exists (#211).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Quaternion, Vector3, type Object3D } from 'three';
import { placeMUOnSurface } from '../../src/core/engine/rv-mu-manipulation';
import type { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { getProblems } from '../../src/core/hmi/problems-store';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import {
  PALLET_SEAT_M, PALLET_YARD_CONFIG, STATION_GEOMETRY, headSeatOf, type PalletYardConfig,
} from '../../src/plugins/models/PalletYard/layout';
import { DROP_RETRY_SEC, SEAT_GLIDE_STEP_M, SPAWN_PROBLEM_CODE } from '@rv/core/fleet/continuous/handover';
import { loadContinuousYard, type ContinuousYard } from './pallet-yard-continuous-scene';
import { PALLET_YARD_URL, nodeNamed } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);

/** One pallet only (A1 at `phase`), no pauses, nobody needs charging. */
function onePallet(over: Partial<PalletYardConfig> = {}, phase = 0): PalletYardConfig {
  return {
    ...PALLET_YARD_CONFIG,
    production: { intervalSec: 1e6, phaseSec: [phase, 1e6] },
    shippingPauses: { everySec: 1e6, durationSec: 0, offsetSec: [0, 0] },
    battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [90, 90, 90] },
    ...over,
  };
}

const world = (n: Object3D): Vector3 => { n.updateWorldMatrix(true, false); return n.getWorldPosition(new Vector3()); };
const mm = (a: Vector3, b: Vector3): number => a.distanceTo(b) * 1000;

/** World pose jumps of every hand-over (pick, drop, rollback) — measured around the calls. */
interface Jumps { pick: number[]; drop: number[]; dropY: number[]; dropXZ: number[] }

/** Wrap the backend's hand-over entry points and measure the pallet's world pose before / after. */
function instrument(y: ContinuousYard): Jumps {
  const j: Jumps = { pick: [], drop: [], dropY: [], dropXZ: [] };
  const be = y.be;
  const cb = be.setPickHandler((output, wait, pallet) => {
    const mu = be.carriedMU(wait.v)!;
    j.pick.push(mm(world(mu.node), lastBeltPose.get(output) ?? world(mu.node)));
    cb(output, wait, pallet);
  });
  const origPut = be.putOnHead.bind(be);
  be.putOnHead = (vehicle, input) => {
    const mu = be.carriedMU(vehicle);
    // (the vehicle subtree's world matrices are refreshed by the render pass only — refresh first)
    be.vehicleNode(vehicle)?.updateMatrixWorld(true);
    const before = mu ? world(mu.node) : null;
    const ok = origPut(vehicle, input);
    if (mu && before) {
      const after = world(mu.node);
      j.drop.push(mm(after, before));
      j.dropY.push(Math.abs(after.y - before.y) * 1000);
      j.dropXZ.push(Math.hypot(after.x - before.x, after.z - before.z) * 1000);
      if (ok) dropPose = after;
    }
    return ok;
  };
  return j;
}
/** Last belt pose of the pallet on each output (sampled every tick by the trace). */
const lastBeltPose = new Map<string, Vector3>();
/** World pose (node origin) of the pallet right after its last successful drop. */
let dropPose: Vector3 | null = null;

describe.skipIf(!AVAILABLE)('PalletYard continuous hand-over (9.7a) — real scene, continuous kernel', () => {
  let y: ContinuousYard;
  beforeAll(async () => {
    y = await loadContinuousYard({
      cfg: onePallet(),
      onTick: () => {
        for (const o of ['A1', 'A2']) {
          const mu = y?.be.palletOnOutput(o);
          if (mu) lastBeltPose.set(o, world(mu.node));
        }
      },
    });
  }, 240_000);
  afterAll(() => { y?.dispose(); });

  it('one pallet: edge → end sensor → pick without a jump → glide onto the seat → drop on the head (no x/z jump, layout pose) → sink', () => {
    const jumps = instrument(y);
    const be = y.be;
    const rt = y.rt;
    // ONE edge, ONE spawn (G3).
    y.tick(2);
    expect(be.counters).toMatchObject({ edges: 1, spawned: 1, spawnFailures: 0 });
    const mu = be.palletOnOutput('A1');
    expect(mu, 'pallet on A1').not.toBeNull();
    // Runs to the end sensor and stops there (no successor → ZPA hold), reported as ready.
    expect(y.runUntil(() => rt.counters.picks >= 1, 200), 'picked').toBe(true);
    const vid = rt.vehicleIds.find((v) => be.carried(v) !== null)!;
    expect(vid, 'carrier').toBeDefined();
    const anchor = be.anchorOf(vid)!;
    expect(mu!.node.parent, 'held on ForkAnchor').toBe(anchor);
    expect(mu!.heldBy).toBe('grip');
    expect(jumps.pick.length).toBe(1);
    expect(jumps.pick[0], 'pick jump (mm)').toBeLessThanOrEqual(5);
    // The glide: ≤ SEAT_GLIDE_STEP_M per tick relative to the fork, then exactly on the seat.
    let maxStep = 0;
    let prev = mu!.node.position.clone();
    expect(y.runUntil(() => {
      maxStep = Math.max(maxStep, mu!.node.position.distanceTo(prev));
      prev = mu!.node.position.clone();
      return !be.isGliding(vid);
    }, 30), 'glide ends').toBe(true);
    console.info(`[9.7a] pick jump ${jumps.pick[0].toFixed(2)} mm; glide max step ${(maxStep * 1000).toFixed(3)} mm/tick`);
    expect(maxStep).toBeLessThanOrEqual(SEAT_GLIDE_STEP_M + 1e-6);
    // On the seat: centred, square, the COLLIDER bottom PALLET_SEAT_M below the fork top.
    mu!.updateAABB();
    const forkTop = world(anchor).y;
    expect(Math.hypot(mu!.node.position.x, mu!.node.position.z) * 1000, 'centred on the fork (mm)').toBeLessThan(0.01);
    expect(Math.abs(forkTop - PALLET_SEAT_M - mu!.aabb.min.y) * 1000, 'collider bottom PALLET_SEAT_M below the fork top (mm)').toBeLessThan(0.01);
    expect(mu!.node.quaternion.angleTo(new Quaternion()), 'seat rotation').toBeLessThan(1e-4);
    // Drop on the shipping head.
    expect(y.runUntil(() => rt.counters.delivered >= 1, 400), 'delivered').toBe(true);
    expect(be.carried(vid)).toBeNull();
    expect(mu!.heldBy).toBeNull();
    const job = rt.jobLog.find((j) => j.startsWith(`${vid}:pick:A1>`))!;
    const input = job.split('>')[1];
    expect(['V1', 'V2']).toContain(input);
    console.info(`[9.7a] drop jump ${jumps.drop[0]?.toFixed(2)} mm (x/z ${jumps.dropXZ[0]?.toFixed(2)}, y ${jumps.dropY[0]?.toFixed(2)})`);
    expect(jumps.drop.length).toBe(1);
    expect(jumps.dropXZ[0], 'drop x/z jump (mm)').toBeLessThanOrEqual(0.5);
    expect(jumps.dropY[0], 'drop height correction (mm)').toBeLessThanOrEqual(5);
    // ...at the layout head pose (the DES set-down pose, plan-631) — sampled at the drop.
    const g = STATION_GEOMETRY.find((x) => x.id === input)!;
    const yard = nodeNamed(y.root, 'PalletYardRoot')!;
    const head = yard.localToWorld(new Vector3(...headSeatOf(g)));
    expect(dropPose, 'drop pose sampled').not.toBeNull();
    console.info(`[9.7a] drop pose vs layout head seat: ${mm(dropPose!, head).toFixed(2)} mm`);
    expect(mm(dropPose!, head), 'drop pose vs DES head seat (mm)').toBeLessThanOrEqual(5);
    // The pallet runs the shipping line and the sink consumes it.
    expect(y.runUntil(() => be.shipped[input].length > 0, 120), 'shipped').toBe(true);
    expect(be.shipped[input]).toEqual([mu!.id]);
    expect(be.counters.spawned).toBe(1);
    expect(be.livePallets(), 'MU balance: nothing left').toBe(0);
    // Nobody idles in a stich afterwards.
    y.runTo(y.now() + 30);
    expect(['toWait', 'atWait', 'cruise']).toContain(rt.stats(vid)!.leg);
  }, 240_000);

  it('occupied head: the stacker waits in the dock, the pallet stays on its seat; the head frees → drop at once', () => {
    y.rebind(onePallet());
    const be = y.be;
    const rt = y.rt;
    // Loaded drive towards an input.
    expect(y.runUntil(() => rt.vehicleIds.some((v) => rt.stats(v)!.leg === 'toTo' && be.carried(v) !== null), 300)).toBe(true);
    const vid = rt.vehicleIds.find((v) => be.carried(v) !== null)!;
    const input = rt.jobLog.find((j) => j.startsWith(`${vid}:pick:`))!.split('>')[1];
    // Occupy that head AFTER the assignment: a second pallet, belt of the input stopped.
    const run = be.inputRunSignal(input)!;
    y.viewer.signalStore!.set(run, false);
    const blocker = y.viewer.transportManager!.spawnFromSource(be.sourceOf('A2')!) as RVMovingUnit;
    expect(blocker, 'blocker spawned').toBeTruthy();
    const g = STATION_GEOMETRY.find((x) => x.id === input)!;
    const head = nodeNamed(y.root, 'PalletYardRoot')!.localToWorld(new Vector3(...headSeatOf(g)));
    const placed = placeMUOnSurface(y.viewer.transportManager!, blocker, head);
    expect(placed.ok, `blocker placed: ${(placed as { reason?: string }).reason}`).toBe(true);
    y.tick(2);
    expect(be.inputFree(input), 'head occupied').toBe(false);
    // Arrival: waits in the dock with the pallet set down onto its seat.
    expect(y.runUntil(() => rt.stats(vid)!.waitingAt === input, 300), 'waits at the input').toBe(true);
    const mu = be.carriedMU(vid)!;
    expect(mu, 'still carried').not.toBeNull();
    const vroot = be.vehicleNode(vid)!;
    const rootAt = world(vroot);
    const seat = mu.node.position.clone();
    y.runTo(y.now() + 10);
    expect(rt.stats(vid)!.leg, 'in the dock').toBe('atTo');
    expect(mm(world(vroot), rootAt), 'vehicle stands').toBeLessThan(1);
    expect(mu.node.parent).toBe(be.anchorOf(vid));
    expect(mu.node.position.distanceTo(seat) * 1000, 'seat pose kept (mm)').toBeLessThan(0.01);
    expect(be.carried(vid)).toBe(String(mu.id));
    // Head frees (belt runs again, the blocker leaves) → the drop follows at that event.
    y.viewer.signalStore!.set(run, true);
    expect(y.runUntil(() => be.carried(vid) === null, 60), 'dropped after the head freed').toBe(true);
    expect(rt.counters.delivered).toBe(1);
    expect(y.runUntil(() => be.shipped[input].includes(mu.id), 120), 'shipped').toBe(true);
  }, 240_000);

  it('a drop refused after the detach rolls back hold and seat pose; the stacker stays; the retry succeeds', () => {
    y.rebind(onePallet());
    const jumps = instrument(y);
    const be = y.be;
    const rt = y.rt;
    const realPlace = be.placeImpl;
    let refusals = 0;
    be.placeImpl = (tm, mu, point, o) => (refusals++ === 0 ? { ok: false, reason: 'test: refused after the detach' } : realPlace(tm, mu, point, o));
    // The seat pose right before the refused call (the wrapper measures the world pose around it).
    let vid = '';
    let seat: Vector3 | null = null;
    const origPut = be.putOnHead.bind(be);
    be.putOnHead = (vehicle, input) => {
      if (!seat) { vid = vehicle; seat = be.carriedMU(vehicle)!.node.position.clone(); }
      return origPut(vehicle, input);
    };
    expect(y.runUntil(() => be.counters.rollbacks > 0, 400), 'rollback happened').toBe(true);
    const m = be.carriedMU(vid)!;
    expect(m, 'still carried').not.toBeNull();
    expect(m.node.parent, 'hold restored').toBe(be.anchorOf(vid));
    expect(m.heldBy).toBe('grip');
    expect(m.node.position.distanceTo(seat!) * 1000, 'seat pose restored (mm)').toBeLessThan(0.01);
    console.info(`[9.7a] rollback jump ${jumps.drop[0]?.toFixed(4)} mm, reason "${be.lastRefusal}"`);
    expect(jumps.drop.length).toBe(1);
    expect(jumps.drop[0], 'rollback jump (mm)').toBeLessThanOrEqual(0.01);
    expect(rt.stats(vid)!.leg, 'stays in the dock').toBe('atTo');
    expect(rt.stats(vid)!.waitingAt).not.toBeNull();
    // The retry (no head event — the head was free all along) succeeds within DROP_RETRY_SEC.
    expect(y.runUntil(() => be.carried(vid) === null, DROP_RETRY_SEC + 1), 'retry dropped').toBe(true);
    expect(refusals).toBe(2);
    expect(rt.counters.delivered).toBe(1);
    be.placeImpl = realPlace;
  }, 240_000);

  it('an edge without a spawn is counted and reported, never a pallet (G3)', () => {
    y.rebind(onePallet({}, 5));
    const be = y.be;
    const src = be.sourceOf('A1')!;
    expect(src.AutomaticGeneration, 'automatic generation off').toBe(false);
    expect(src.Interval, 'interval generation off').toBe(0);
    src.Enabled = false;
    y.runTo(5.2);
    expect(be.counters.edges, 'the edge was accepted').toBe(1);
    expect(be.counters.spawned).toBe(0);
    expect(be.counters.spawnFailures).toBe(1);
    expect(getProblems().some((p) => p.id === `${SPAWN_PROBLEM_CODE}:A1`), 'Problems entry').toBe(true);
    expect(src.GenerateMU, 'edge LOW again').toBe(false);
    expect(be.livePallets()).toBe(0);
    src.Enabled = true;
    expect(be.produce('A1'), 'next edge accepted').toBe(true);
    y.tick(3);
    expect(be.counters.spawned).toBe(1);
    expect(getProblems().some((p) => p.id === `${SPAWN_PROBLEM_CODE}:A1`), 'cleared by the next spawn').toBe(false);
  }, 240_000);

  it('c4: SOC, status signals and lamps run in the continuous mode (charging included)', () => {
    y.rebind({ ...PALLET_YARD_CONFIG, battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [20, 22, 90] } });
    const be = y.be;
    const rt = y.rt;
    const store = y.viewer.signalStore!;
    const seen = { charging: false, busy: false, label: false };
    const soc0 = rt.socAt('Stapler_3');
    expect(y.runUntil(() => {
      for (const v of rt.vehicleIds) {
        if (store.get(`${v}.Status.Charging`) === true && rt.chargingAt(v) !== null) seen.charging = true;
        if (store.get(`${v}.Status.Busy`) === true) seen.busy = true;
      }
      return seen.charging && seen.busy;
    }, 400), `status signals ${JSON.stringify(seen)}`).toBe(true);
    for (const v of rt.vehicleIds) {
      const soc = be.vehicleNode(v)!.userData._rvStateOfCharge;
      expect(typeof soc, `${v} SOC published`).toBe('number');
      expect(rt.lamps.lampCount(v), `${v} lamps`).toBe(6);
    }
    expect(rt.socAt('Stapler_3'), 'SOC is consumed while driving').toBeLessThan(soc0);
  }, 240_000);
});
