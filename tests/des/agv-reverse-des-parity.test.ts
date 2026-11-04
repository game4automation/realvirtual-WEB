// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.7 (F8) — the stub cycle in the event kernel: same stops, same
 * times, pose on the mirrored route.
 *
 * A forklift works a chain of reverse tasks over three stubs (S2, S3, S1, S2)
 * with an 8 s dock hold each, a cart circles the ring. Tolerances (plan-595
 * §9.7, from the spike):
 * - DES Animated vs FastForward: dock call / release times within 1e-6 s;
 * - continuous vs DES: within ±1e-3 s;
 * - pose at the handling position: within 1e-6 m, sampled at the end of the
 *   very step of the dock call in BOTH Animated and continuous (no lag). Since
 *   plan-632 the continuous fleet syncs every vehicle at the step's shared clock
 *   time AFTER the one advance in which the arrival event ran, so the drawn pose
 *   is already the handling position; the former BOUND x TICK allowance (one
 *   tick per vehicle joining the clock, #202) would hide a regression of that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type AgvTask } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared } from '../helpers/agv-harness';
import {
  stubLayout, makeStubWorld, forkCfg, carCfg, FORK, FORK_MESH, CAR, delay, type Mode,
} from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

const CHAIN = ['S2', 'S3', 'S1', 'S2'];
interface Trace { times: number[]; poseErr: number[]; done: string[]; violations: number; watchdog: number }

function run(mode: Mode): Trace {
  stubLayout();
  const w = makeStubWorld(mode, [
    { name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK },
    { name: 'C', cfg: carCfg('R2', 20000), body: CAR },
  ], 900);
  const net = getDefaultPathNetwork();
  const fleet = getDefaultAgvFleet();
  const tr: Trace = { times: [], poseErr: [], done: [], violations: 0, watchdog: 0 };
  const pending: { stub: string; t: number }[] = [];
  for (const sid of ['S1', 'S2', 'S3']) {
    getDefaultPathDockRegistry().register(sid, {
      onVehicleArrive: (id, release) => {
        if (id !== 'F') { release(); return; }
        tr.times.push(w.now());
        pending.push({ stub: sid, t: w.now() });
        delay(8, () => { tr.times.push(w.now()); release(); });
      },
    });
  }
  let k = 0;
  const next = (): void => {
    if (k >= CHAIN.length) { fleet.get('F')!.clear(); return; }
    const stub = CHAIN[k++];
    const task: AgvTask = { destination: stub, approach: 'reverse', onServiceEnd: () => { tr.done.push(stub); next(); } };
    fleet.get('F')!.assign(task);
  };
  next();
  // plan-632: no render lag in any mode (see the module doc) — 0 ticks, not BOUND x TICK.
  const lag = 0;
  const p = new Vector3();
  while (!w.done() && tr.done.length < CHAIN.length) {
    w.step();
    if (mode === 'fastforward') continue;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (w.now() - pending[i].t < lag) continue;
      net.get(pending[i].stub)!.getAbsPosition(0, p);
      tr.poseErr.push(w.roots.F.position.distanceTo(p));
      pending.splice(i, 1);
    }
  }
  tr.violations = w.mb.stats.violations;
  tr.watchdog = w.mb.stats.watchdogFires;
  w.dispose();
  return tr;
}

describe('plan-595 9.7 — DES parity of the stub cycle', () => {
  it('Animated vs FastForward 1e-6 s, continuous ±1e-3 s, pose 1e-6 m at the handling position', () => {
    const a = run('animated'); clearShared(); setReverseGateOpen(true);
    const f = run('fastforward'); clearShared(); setReverseGateOpen(true);
    const c = run('continuous');
    for (const t of [a, f, c]) {
      expect(t.done).toEqual(CHAIN);
      expect(t.times.length).toBe(2 * CHAIN.length);
      expect(t.violations).toBe(0);
      expect(t.watchdog).toBe(0);
    }
    for (let i = 0; i < a.times.length; i++) {
      expect(Math.abs(f.times[i] - a.times[i])).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(c.times[i] - a.times[i])).toBeLessThanOrEqual(1e-3);
    }
    expect(a.poseErr.length).toBe(CHAIN.length);
    expect(c.poseErr.length).toBe(CHAIN.length);
    for (const e of [...a.poseErr, ...c.poseErr]) expect(e).toBeLessThan(1e-6);
  }, 300000);
});
