// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.17 (R3-5) — a safe hold keeps the direction's cruise and the
 * (mirrored) curve limits.
 *
 * The asymmetric stub of 9.8 (quarter arc R = 1.5 m at the lane, then a 4 m
 * straight): a forklift reverses Turn → S. On the turn piece, before the arc,
 * the re-plan cap is set to 0 and a re-plan is forced — from then on every plan
 * is a SAFE HOLD, which runs on to the previous plan's stop, through the arc.
 * At every time the speed of every applied plan stays ≤ min(ReverseSpeed,
 * √(aLat·R)) on the arc and ≤ ReverseSpeed elsewhere. Two cases: the curve
 * limit binds (ReverseSpeed 1200 mm/s > 0.866 m/s) and the reverse speed binds
 * (600 mm/s). Before R3-5 the safe hold ran on `max(vmax, speed)²` — 1.2 m/s.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultMovementAuthority, setReverseGateOpen, type MbHost, type MbPlan } from '../../src/core/engine/rv-movement-authority';
import { positionAt, speedAt } from '../../src/core/engine/rv-motion-profile';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindContinuous, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

const J = new Vector3(10, 0, 0);
const R = 1.5;
const LINE = 4;
const VLIM = Math.sqrt(0.5 * R);

function arcSegment(): Record<string, unknown> {
  for (const startAngle of [0, 90, 180, 270]) {
    for (const clockwise of [false, true]) {
      for (const center of [[10, 0, -R], [10, 0, R]]) {
        const seg = { kind: 'arc', center, radius: R, startAngle, degrees: 90, clockwise, plane: 'XZ' };
        const p = parsePathExtras({ type: 'Path', version: 1, id: 'probe', segments: [seg] }, 'probe');
        if (!p) continue;
        if (p.getAbsPosition(p.length, new Vector3()).distanceTo(J) < 1e-6
          && p.getAbsDirection(p.length, new Vector3()).distanceTo(new Vector3(1, 0, 0)) < 1e-6) return seg;
      }
    }
  }
  throw new Error('no arc orientation ends at J heading +x');
}

function layout(): { S: RVPath; Turn: RVPath } {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
  };
  const arc = arcSegment();
  const probe = parsePathExtras({ type: 'Path', version: 1, id: 'p2', segments: [arc] }, 'p2')!;
  const a0 = probe.getAbsPosition(0, new Vector3());
  const h = a0.clone().addScaledVector(probe.getAbsDirection(0, new Vector3()), -LINE);
  add({ id: 'L0', segments: [{ kind: 'line', from: [0, 0, 0], to: [7, 0, 0] }], successors: ['Pre'] });
  add({ id: 'Pre', segments: [{ kind: 'line', from: [7, 0, 0], to: [10, 0, 0] }], successors: ['Turn'], zone: 'M', zoneCapacity: 1 });
  add({ id: 'Turn', segments: [{ kind: 'line', from: [10, 0, 0], to: [13, 0, 0] }], successors: ['L1'], zone: 'M', zoneCapacity: 1 });
  add({ id: 'L1', segments: [{ kind: 'line', from: [13, 0, 0], to: [40, 0, 0] }] });
  add({ id: 'S', segments: [{ kind: 'line', from: [h.x, h.y, h.z], to: [a0.x, a0.y, a0.z] }, arc], successors: ['Turn'], zone: 'M', zoneCapacity: 1 });
  net.resolveGraph();
  return { S: net.get('S')!, Turn: net.get('Turn')! };
}

interface Obs { arc: number; other: number; safeHoldPlans: number; safeArcSamples: number; arrived: boolean; safeHolds: number; violations: number }

function run(mode: 'continuous' | 'animated', reverseMm: number): Obs {
  const { S, Turn } = layout();
  const host = makeHost();
  const root = makeAgvRoot('F', { PathId: 'Turn', StartPosition: 2500, TargetSpeed: 1200, ReverseSpeed: reverseMm, AllowReverse: true,
    Acceleration: 500, Deceleration: 500, LateralAcceleration: 500, VehicleLength: 2000, VehicleWidth: 1000, ScannerFields: false });
  const mb = getDefaultMovementAuthority(mode === 'continuous' ? 'continuous' : 'des');
  let step: () => void, now: () => number, dispose = (): void => {};
  if (mode === 'continuous') {
    const h: BindContextHandle = bindContinuous(root, host);
    step = () => iterateFixedUpdate(h, TICK);
    now = () => mb.clock.now;
  } else {
    const runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    step = () => { runner.tick(TICK); runner.lateTick(TICK); };
    now = () => runner.getManager().currentTime;
    dispose = () => runner.dispose();
  }
  expect(mb.setDirection('F', -1, [Turn, S])).toBe(true);
  const vehHost = (mb as unknown as { vehicles: Map<string, { host: MbHost }> }).vehicles.get('F')!.host; // test seam: force a re-plan
  const o: Obs = { arc: 0, other: 0, safeHoldPlans: 0, safeArcSamples: 0, arrived: false, safeHolds: 0, violations: 0 };
  let lastVer = -1, forced = false, sampleAfterForce = 0;
  for (let f = 0; f < 60 * 60; f++) {
    step();
    const t = now();
    const plan = mb.planOf('F')! as MbPlan;
    if (plan.dir !== -1) continue;
    const loc = mb.locate('F', t)!;
    // Before the arc: every plan from now on is a safe hold (continuous: while driving; DES: at the
    // reverse start — its manager clock only sits on event times).
    if (!forced && loc.path === Turn && loc.s > 0.3 && (mode === 'animated' || mb.speedOf('F', t) > 0.3)) {
      forced = true;
      mb.replanCap = 0;
      mb.markDirty('F', 'test-safe-hold');
      mb.requestFlush(vehHost);
      sampleAfterForce = 2; // the safe hold may keep the same trajectory (no version bump) — sample it anyway
      continue;
    }
    const ver = mb.versionOf('F');
    if (ver !== lastVer || sampleAfterForce > 0) {
      if (sampleAfterForce > 0) sampleAfterForce--;
      lastVer = ver;
      const isSafe = forced;
      if (isSafe) o.safeHoldPlans++;
      for (let tt = t; tt <= plan.profile.tEnd; tt += 1e-3) {
        const x = positionAt(plan.profile, tt);
        let k = 0;
        while (k + 1 < plan.route.length && x > plan.route[k + 1].x0 + 1e-9) k++;
        const e = plan.route[k];
        const v = speedAt(plan.profile, tt);
        const onArc = e.path === S && e.path.length - (x - e.x0) > LINE + 1e-6;
        if (onArc) { o.arc = Math.max(o.arc, v); if (isSafe) o.safeArcSamples++; } else o.other = Math.max(o.other, v);
      }
    }
    if (plan.stopCause === 'deadend' && t >= plan.profile.tEnd && root.position.distanceTo(S.getAbsPosition(0, new Vector3())) < 1e-6) {
      o.arrived = true;
      break;
    }
  }
  o.safeHolds = mb.stats.holdsBy.safe ?? 0;
  o.violations = mb.stats.violations;
  dispose();
  return o;
}

describe('plan-595 9.17 — safe hold keeps reverse and curve limits (R3-5)', () => {
  for (const mode of ['continuous', 'animated'] as const) {
    for (const rs of [1200, 600]) {
      it(`${mode}, ReverseSpeed ${rs} mm/s: every safe-hold plan stays ≤ min(ReverseSpeed, curve limit)`, () => {
        const o = run(mode, rs);
        expect(o.safeHolds).toBeGreaterThan(0);          // the safe-hold path really ran …
        expect(o.safeHoldPlans).toBeGreaterThan(0);
        expect(o.safeArcSamples).toBeGreaterThan(0);     // … and its plans cover the arc
        expect(o.arrived).toBe(true);
        expect(o.arc).toBeLessThanOrEqual(Math.min(rs / 1000, VLIM) + 1e-6);
        expect(o.other).toBeLessThanOrEqual(rs / 1000 + 1e-6);
        expect(o.violations).toBe(0);
      }, 60000);
    }
  }
});
