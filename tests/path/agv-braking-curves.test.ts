// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.7 — acceptance: braking, curve and docking limits on the speed
 * trace of a DES vehicle (sampled from the authoritative plan every frame).
 *
 * Course: one piece with TWO arcs of different radius (several curves inside
 * one path piece), a straight, and a station piece whose end is the task
 * destination (service stop with docking crawl).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => clearShared());

const A = 0.5, B = 0.5, A_LAT = 0.5, VMAX = 1.2, DOCK_V = 0.3, DOCK_D = 0.5;

function registerCourse(): void {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
  };
  // Curvy: straight 4 m, arc R = 1 (90°), straight 2 m, arc R = 2.5 (−90°) — one path piece.
  add({
    id: 'Curvy', successors: ['Station'], segments: [
      { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] },
      { kind: 'arc', center: [4, 0, 1], radius: 1, startAngle: -90, degrees: 90, plane: 'XZ' },
      { kind: 'line', from: [5, 0, 1], to: [5, 0, 3] },
      { kind: 'arc', center: [7.5, 0, 3], radius: 2.5, startAngle: 180, degrees: -90, plane: 'XZ' },
    ],
  });
  add({ id: 'Station', segments: [{ kind: 'line', from: [7.5, 0, 5.5], to: [12, 0, 5.5] }] });
  net.resolveGraph();
}

describe('AGV braking curves (plan-558 §9.7)', () => {
  it('curve limit √(aLat·R) in every arc, |dv/dt| ≤ a / b, docking crawl, monotone stop at the service end', () => {
    registerCourse();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const root = makeAgvRoot('V', {
      PathId: 'Curvy', StartPosition: 0, TargetSpeed: VMAX * 1000, Acceleration: A * 1000, Deceleration: B * 1000,
      LateralAcceleration: A_LAT * 1000, DockingSpeed: DOCK_V * 1000, DockingDistance: DOCK_D * 1000,
      VehicleLength: 1000, VehicleWidth: 600,
    });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    let serviced = -1;
    getDefaultAgvFleet().get('V')!.assign({ destination: 'Station', serviceSec: 2, onArrive: () => { serviced = runner.getManager().currentTime; } });
    const mb = getDefaultMovementAuthority('des');
    const curvy = getDefaultPathNetwork().get('Curvy')!;
    const arcs = curvy.curvatureIntervals().filter((c) => Number.isFinite(c.radiusM));
    expect(arcs.length).toBe(2);
    const trace: { t: number; path: string; s: number; v: number }[] = [];
    for (let f = 0; f <= Math.round(30 / TICK); f++) {
      if (f > 0) { runner.tick(TICK); runner.lateTick(TICK); }
      const t = f * TICK;
      const l = mb.locate('V', t)!;
      trace.push({ t, path: l.path.id, s: l.s, v: l.v });
    }
    runner.dispose();
    expect(serviced).toBeGreaterThan(0);
    let maxV = 0, maxArcExcess = -Infinity, maxDock = 0, maxAcc = 0, maxDec = 0;
    for (let i = 0; i < trace.length; i++) {
      const p = trace[i];
      maxV = Math.max(maxV, p.v);
      if (p.path === 'Curvy') {
        for (const c of arcs) {
          if (p.s >= c.s0 && p.s <= c.s1) maxArcExcess = Math.max(maxArcExcess, p.v - Math.sqrt(A_LAT * c.radiusM));
        }
      }
      if (p.path === 'Station' && p.s >= 4.5 - DOCK_D + 1e-9) maxDock = Math.max(maxDock, p.v);
      if (i > 0) {
        const dv = (p.v - trace[i - 1].v) / TICK;
        maxAcc = Math.max(maxAcc, dv);
        maxDec = Math.max(maxDec, -dv);
      }
    }
    // Final approach: monotone non-increasing speed from the start of the last braking on.
    const end = trace.findIndex((p) => p.path === 'Station' && p.s >= 4.5 - 1e-9);
    expect(end).toBeGreaterThan(0);
    let k = end;
    while (k > 0 && trace[k - 1].v >= trace[k].v - 1e-12) k--;
    const brakeStart = k;
    expect(trace[brakeStart].path === 'Station' || trace[brakeStart].s > 3).toBe(true);
    for (let i = brakeStart + 1; i <= end; i++) expect(trace[i].v).toBeLessThanOrEqual(trace[i - 1].v + 1e-12);
    console.log(`[agv-brake] maxV=${maxV.toFixed(3)} arcExcess=${maxArcExcess.toFixed(5)} dock=${maxDock.toFixed(4)}`
      + ` maxAcc=${maxAcc.toFixed(3)} maxDec=${maxDec.toFixed(3)} forced=${mb.stats.forced}`);
    expect(maxV).toBeLessThanOrEqual(VMAX + 1e-9);
    expect(maxV).toBeGreaterThan(1.0); // the straights are fast enough to show the limits
    expect(maxArcExcess).toBeLessThanOrEqual(0.001);
    expect(maxDock).toBeLessThanOrEqual(DOCK_V + 0.001);
    expect(maxAcc).toBeLessThanOrEqual(A + 1e-6);
    expect(maxDec).toBeLessThanOrEqual(B + 1e-6);
    expect(mb.stats.forced).toBe(0);
    expect(trace[trace.length - 1].v).toBe(0);
  }, 60_000);
});
