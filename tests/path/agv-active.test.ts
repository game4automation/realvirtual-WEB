// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 test 9.7: Active is sampled at setup/reset in both kernels.
 * Out-of-service vehicles have no fleet id or zone hold and stay hidden while
 * the others move. Config edits take effect only at the next reset, which
 * reactivates one vehicle and releases another; disposal leaves no handles.
 * Continuous covers both legacy stepping and the acceleration planner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from '../../src/core/rv-events';
import { Object3D, type Vector3 } from 'three';
import type { BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { AGV_DEF, makeHost, makeAgvRoot, bindContinuous, bindDes, clearShared, stepFleet, TICK,
  type AgvTestHost } from '../helpers/agv-harness';

function seg(id: string, from: [number, number, number], to: [number, number, number], successors: string[], zone?: string): void {
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path', id, segments: [{ kind: 'line', from, to }], successors,
    ...(zone ? { zone, zoneCapacity: 1 } : {}),
  }, id)!);
}
function course(): void {
  seg('S', [0, 0, 0], [10, 0, 0], ['E']);
  seg('E', [10, 0, 0], [10, 0, 10], ['N'], 'EastCurve');
  seg('N', [10, 0, 10], [0, 0, 10], ['W']);
  seg('W', [0, 0, 10], [0, 0, 0], ['S']);
  getDefaultPathNetwork().resolveGraph();
}
const cfg = (start: number, active = true, useAcc = false): Record<string, unknown> => ({
  PathId: 'S', StartPosition: start, TargetSpeed: 1000, UseAcceleration: useAcc, Active: active,
});
/** makeHost + an emitter we can fire `simulation-reset` on. */
function hostWithReset(): AgvTestHost & { emit(e: string): void } {
  const h = makeHost();
  const ev = new EventEmitter<Record<string, unknown>>();
  return Object.assign(h, { on: (e: string, cb: (...a: unknown[]) => void) => ev.on(e, cb as never),
    emit: (e: string) => { ev.emit(e, undefined as never); } });
}
const ids = (): string[] => getDefaultAgvFleet().handleList.map(h => h.id).sort();
const at = (r: Object3D) => r.position.clone();
const moved = (r: Object3D, before: Vector3): number => before.distanceTo(r.position);

beforeEach(() => { clearShared(); });

describe.each([false, true])('Agv.Active — continuous (UseAcceleration=%s)', (useAcc) => {
  it('inactive at setup: no id, hidden, others drive; reactivation and deactivation at reset', () => {
    course();
    const host = hostWithReset();
    const roots = [makeAgvRoot('A1', cfg(0, true, useAcc)), makeAgvRoot('A2', cfg(3000, false, useAcc)),
      makeAgvRoot('A3', cfg(6000, true, useAcc))];
    const handles: BindContextHandle[] = roots.map(r => bindContinuous(r, host));
    host.emit('simulation-start');
    expect(ids()).toEqual(['A1', 'A3']);
    expect(roots[1].visible).toBe(false);
    expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('A2');
    const p0 = [at(roots[0]), at(roots[2])];
    for (let i = 0; i < 300; i++) {
      stepFleet(host, handles, TICK);
      expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('A2');
    }
    expect(moved(roots[0], p0[0])).toBeGreaterThan(1);
    expect(moved(roots[2], p0[1])).toBeGreaterThan(1);
    expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('A2');

    // Reactivate A2, deactivate A1 — both only at the next reset.
    (roots[1].userData.realvirtual.Agv as Record<string, unknown>).Active = true;
    (roots[0].userData.realvirtual.Agv as Record<string, unknown>).Active = false;
    for (let i = 0; i < 60; i++) stepFleet(host, handles, TICK);
    expect(ids()).toEqual(['A1', 'A3']); // config edits do not apply during a run
    expect(roots[0].visible).toBe(true);
    expect(roots[1].visible).toBe(false);
    host.emit('simulation-reset');
    host.emit('simulation-start');
    expect(ids()).toEqual(['A2', 'A3']);
    expect(roots[0].visible).toBe(false);
    expect(roots[1].visible).toBe(true);
    const a2 = at(roots[1]);
    for (let i = 0; i < 300; i++) {
      stepFleet(host, handles, TICK);
      expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('A1');
    }
    expect(moved(roots[1], a2)).toBeGreaterThan(1);
    for (const h of handles) h.dispose();
    expect(ids()).toEqual([]);
  });
});

describe('Agv.Active — DES', () => {
  it('inactive at setup: no id, hidden, others drive; reactivation and deactivation at reset', () => {
    course();
    const host = makeHost();
    const runner = new DESRunner({ subMode: 'animated' });
    const roots = [makeAgvRoot('D1', cfg(0)), makeAgvRoot('D2', cfg(3000, false)), makeAgvRoot('D3', cfg(6000))];
    for (const r of roots) bindDes(runner, r, host);
    runner.start([AGV_DEF], { root: new Object3D() });
    expect(ids()).toEqual(['D1', 'D3']);
    expect(roots[1].visible).toBe(false);
    expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('D2');
    const d0 = [at(roots[0]), at(roots[2])];
    for (let i = 0; i < 300; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('D2');
    }
    expect(moved(roots[0], d0[0])).toBeGreaterThan(1);
    expect(moved(roots[2], d0[1])).toBeGreaterThan(1);
    (roots[1].userData.realvirtual.Agv as Record<string, unknown>).Active = true;
    (roots[0].userData.realvirtual.Agv as Record<string, unknown>).Active = false;
    for (let i = 0; i < 60; i++) { runner.tick(TICK); runner.lateTick(TICK); }
    expect(ids()).toEqual(['D1', 'D3']);
    expect(roots[0].visible).toBe(true);
    expect(roots[1].visible).toBe(false);
    runner.reset();
    expect(ids()).toEqual(['D2', 'D3']);
    expect(roots[0].visible).toBe(false);
    expect(roots[1].visible).toBe(true);
    const d2 = at(roots[1]);
    for (let i = 0; i < 300; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      expect(getDefaultZoneRegistry().holdersOf('EastCurve')).not.toContain('D1');
    }
    expect(moved(roots[1], d2)).toBeGreaterThan(1);
    // No fleet assertion after dispose here: `runner.dispose()` does not unregister the handles of
    // programmatically bound (harness) instances — with or without Active (probed 2026-10-31); the
    // production teardown runs through the scene binding and resetTrafficRegistries().
    runner.dispose();
  });
});

describe('Agv.Active — visibility belongs to Active only while it hid the vehicle', () => {
  it('an active vehicle hidden from outside (e.g. a hidden group) stays hidden across a reset', () => {
    course();
    const host = hostWithReset();
    const roots = [makeAgvRoot('V1', cfg(0)), makeAgvRoot('V2', cfg(3000, false))];
    const handles: BindContextHandle[] = roots.map(r => bindContinuous(r, host));
    host.emit('simulation-start');
    roots[0].visible = false;                   // someone else hides the active vehicle
    host.emit('simulation-reset');
    expect(roots[0].visible).toBe(false);       // Active (true) did not override that hide
    expect(roots[1].visible).toBe(false);       // hidden by Active
    (roots[1].userData.realvirtual.Agv as Record<string, unknown>).Active = true;
    host.emit('simulation-reset');
    expect(roots[1].visible).toBe(true);        // shown again — Active had hidden it
    for (const h of handles) h.dispose();
  });
});
