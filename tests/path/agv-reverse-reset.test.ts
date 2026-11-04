// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.12 — reset, re-bind and mode switch during a reverse leg.
 *
 * A forklift reverses into stub S2 (DES Animated). Then, WITHOUT a masking
 * `clearShared()` in between:
 *  1. `runner.reset()` while reversing (the runner re-runs the setup, which
 *     keeps an imperative task but ends every manoeuvre): afterwards it holds no
 *     zone, its plan is forward, no event of the old run fires (no dock call),
 *     and the next task is driven forward without any reverse plan;
 *  2. the run is disposed while reversing again and the SAME scene is bound in
 *     DES FastForward, then in the continuous kernel (mode switches): no stale
 *     claim, no ghost of the old run, the next task drives forward.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindDes, bindContinuous, clearShared } from '../helpers/agv-harness';
import { stubLayout, forkCfg, FORK_MESH } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

const held = (id: string): string[] => { const out: string[] = []; getDefaultZoneRegistry().collectHeld(id, out); return [...out].sort(); };

describe('plan-595 9.12 — reset / re-bind / mode switch during reverse travel', () => {
  it('animated reset → FastForward → continuous: no claim, no ghost event, next task forward', () => {
    stubLayout();
    const host = makeHost();
    const root = makeAgvRoot('F', forkCfg('L0', 3500), FORK_MESH);
    const fleet = getDefaultAgvFleet();
    let dockCalls = 0;
    getDefaultPathDockRegistry().register('S2', { onVehicleArrive: (_id, release) => { dockCalls++; release(); } });

    // ── 1. DES Animated: reverse into S2, reset in the middle of the reverse leg ──
    let runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    const des = getDefaultMovementAuthority('des');
    fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse' });
    const tick = (): void => { runner.tick(TICK); runner.lateTick(TICK); };
    let f = 0;
    for (; f < 60 * 120 && des.planDirOf('F') !== -1; f++) tick();
    expect(des.planDirOf('F')).toBe(-1);              // precondition: it is reversing
    for (let k = 0; k < 60; k++) tick();              // 1 s into the reverse leg
    expect(des.planDirOf('F')).toBe(-1);
    expect(held('F')).toContain('K2');
    runner.reset();
    expect(held('F')).toEqual([]);                    // L0 has no zone — nothing held after the re-seed
    expect(des.planDirOf('F')).toBe(1);               // re-seeded forward
    // The next task (replacing the kept reverse task) is driven forward — the old manoeuvre is gone.
    let reversed = false;
    let done = false;
    fleet.get('F')!.assign({ destination: 'L2', serviceSec: 1, onServiceEnd: () => { done = true; } });
    for (let k = 0; k < 60 * 120 && !done; k++) { tick(); if (des.planDirOf('F') === -1) reversed = true; }
    expect(done).toBe(true);
    expect(reversed).toBe(false);

    // ── 2. reverse again, dispose mid-leg, re-bind the SAME scene in FastForward ──
    fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse' });
    for (let k = 0; k < 60 * 120 && des.planDirOf('F') !== -1; k++) tick();
    expect(des.planDirOf('F')).toBe(-1);
    runner.dispose();
    // (A disposed DES binding keeps its claims until the next binding's setup releases them —
    // plan-558 behaviour; the new binding below must start clean.)
    runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 120 });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    expect(held('F')).toEqual([]);                    // no stale claim of the reverse leg
    done = false;
    fleet.get('F')!.assign({ destination: 'L2', serviceSec: 1, onServiceEnd: () => { done = true; } });
    const traceKinds = new Set<string>();
    des.trace = [];
    for (let k = 0; k < 100 && !runner.getManager().isComplete; k++) tick();
    for (const e of des.trace ?? []) traceKinds.add(e.kind);
    des.trace = null;
    expect(done).toBe(true);
    expect(dockCalls).toBe(0);
    runner.dispose();

    // ── 3. continuous kernel on the same scene ──
    const h = bindContinuous(root, host);
    expect(held('F')).toEqual([]);
    const cont = getDefaultMovementAuthority('continuous');
    done = false;
    fleet.get('F')!.assign({ destination: 'L2', serviceSec: 1, onServiceEnd: () => { done = true; } });
    reversed = false;
    for (let k = 0; k < 60 * 120 && !done; k++) { iterateFixedUpdate(h, TICK); if (cont.planDirOf('F') === -1) reversed = true; }
    expect(done).toBe(true);
    expect(reversed).toBe(false);
    expect(dockCalls).toBe(0);
    expect(des.stats.violations + cont.stats.violations).toBe(0);
  }, 120000);
});
