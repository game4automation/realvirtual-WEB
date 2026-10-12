// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.11 — DES snapshots of scenes with AGVs are an explicit
 * NON-GOAL with a guard: taking one warns, restoring refuses cleanly before
 * any state is touched. Plus the Phase-3 check that cancelling a planner
 * event frees the leg tween coupled to it (no orphaned tweens per re-plan).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => clearShared());

function course(): void {
  const net = getDefaultPathNetwork();
  net.register(parsePathExtras({ type: 'Path', id: 'A', segments: [{ kind: 'line', from: [0, 0, 0], to: [40, 0, 0] }], successors: ['B'] }, 'A')!);
  net.register(parsePathExtras({ type: 'Path', id: 'B', segments: [{ kind: 'line', from: [40, 0, 0], to: [60, 0, 0] }] }, 'B')!);
  net.resolveGraph();
}

function start(): { runner: DESRunner } {
  course();
  const runner = new DESRunner({ subMode: 'animated' });
  bindDes(runner, makeAgvRoot('V', { PathId: 'A', StartPosition: 1000 }), makeHost());
  runner.start([], { root: new Object3D() });
  for (let i = 0; i < 120; i++) { runner.tick(TICK); runner.lateTick(TICK); }
  return { runner };
}

describe('DES snapshot guard for AGV scenes (plan-558 §9.11)', () => {
  it('a snapshot warns once; a restore is refused with a message and leaves the state untouched', () => {
    const { runner } = start();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const snap = runner.fullSnapshot();
    runner.fullSnapshot();
    const agvWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('AGVs are not supported'));
    expect(agvWarnings.length).toBe(1);
    warn.mockRestore();
    const mgr = runner.getManager();
    const t = mgr.currentTime;
    const queued = mgr.nextEventTime;
    expect(() => runner.restoreFull(snap)).toThrow(/not supported for scenes with AGVs/);
    expect(() => runner.restoreJson(JSON.stringify(snap))).toThrow(/not supported for scenes with AGVs/);
    // No half restore: clock and queue unchanged, the vehicle keeps driving.
    expect(mgr.currentTime).toBe(t);
    expect(mgr.nextEventTime).toBe(queued);
    for (let i = 0; i < 60; i++) { runner.tick(TICK); runner.lateTick(TICK); }
    expect(mgr.currentTime).toBeGreaterThanOrEqual(t);
    runner.dispose();
  });
});

describe('cancelling a planner event frees its coupled leg tween (plan-558 Phase 3)', () => {
  it('repeated re-plans keep exactly one active leg tween per vehicle', () => {
    const { runner } = start();
    const tweens = (runner as unknown as { tweens: { activeCount: number } }).tweens;
    expect(tweens.activeCount).toBe(1);
    for (let i = 0; i < 10; i++) {
      // Alternate destinations: every assign changes the plan (cancel + new leg).
      getDefaultAgvFleet().get('V')!.assign({ destination: i % 2 === 0 ? 'A' : 'B' });
      expect(tweens.activeCount).toBe(1);
    }
    runner.dispose();
  });
});
