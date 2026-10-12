// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.10 — scanner fields (R2-7 state machine) and their overlay.
 *
 * Field lengths (defaults): protective P(v) = v·0.2 + v²/(2·0.5) + 0.2 m,
 * warning W(v) = P(v) + 1.0 m. A faster vehicle closing in on a slower one
 * enters the warning field at the PREDICTED instant (the gap equals W(v) at
 * the `Replan:field` event), is capped to max(DockingSpeed, v_leader), never
 * reaches the protective field; an already-violated field at the start does
 * not storm; the field clears when the leader leaves; predictions made stale
 * by a leader re-plan are dropped. Same results in the continuous kernel. The
 * overlay plugin draws nothing while the category is off, follows v(t) at
 * render time between DES events, and frees its shared resources.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority, type FieldState } from '../../src/core/engine/rv-movement-authority';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { setOverlayVisible } from '../../src/core/overlay-visibility-store';
import { AgvScannerFieldPlugin } from '../../src/plugins/agv-scanner-field-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import {
  TICK, makeHost, makeAgvRoot, bindDes, bindContinuous, clearShared, sig,
} from '../helpers/agv-harness';

beforeEach(() => clearShared());

const P = (v: number): number => v * 0.2 + (v * v) / (2 * 0.5) + 0.2;
const W = (v: number): number => P(v) + 1.0;

function course(): void {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, ...raw }, raw.id as string)!);
  };
  add({ id: 'S', segments: [{ kind: 'line', from: [0, 0, 0], to: [60, 0, 0] }], successors: ['Main', 'Side'] });
  add({ id: 'Main', segments: [{ kind: 'line', from: [60, 0, 0], to: [120, 0, 0] }] });
  add({ id: 'Side', segments: [{ kind: 'line', from: [60, 0, 0], to: [60, 0, 40] }] });
  net.resolveGraph();
}

interface FieldRun {
  events: number[];           // field event times of the follower
  gapsAtEvents: number[];     // body gap − W(v) at those events (m)
  tWarn: number;              // first frame the follower is warned (s)
  states: FieldState[];       // distinct field states in order
  maxFollowSpeedAfterCap: number;
  stale: number;
}

function bodyGap(mb: ReturnType<typeof getDefaultMovementAuthority>, t: number): number {
  const l = mb.locate('Lead', t)!, f = mb.locate('Follow', t)!;
  // Both on 'S' in the measured window: front/rear 0.5 m each (1 m bodies).
  return (l.path.id === 'S' ? l.s : 60 + l.s) - 0.5 - ((f.path.id === 'S' ? f.s : 60 + f.s) + 0.5);
}

describe('scanner field state machine (plan-558 §9.10, R2-7)', () => {
  function runDes(opts: { leadStart: number; leadSpeed: number; seconds: number; branchLead?: boolean; speedUpLeadAt?: number }): FieldRun {
    course();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const lead = makeAgvRoot('Lead', { PathId: 'S', StartPosition: opts.leadStart, TargetSpeed: opts.leadSpeed, VehicleLength: 1000, VehicleWidth: 600 });
    const fol = makeAgvRoot('Follow', { PathId: 'S', StartPosition: 600, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 });
    [lead, fol].forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    if (opts.branchLead) getDefaultAgvFleet().get('Lead')!.assign({ destination: 'Side' });
    const mb = getDefaultMovementAuthority('des');
    mb.trace = [];
    const states: FieldState[] = ['clear'];
    let maxAfterCap = 0;
    let tWarn = -1;
    for (let f = 1; f <= Math.round(opts.seconds / TICK); f++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      const st = mb.fieldStateOf('Follow');
      if (st !== states[states.length - 1]) states.push(st);
      if (st === 'warning' && tWarn < 0) tWarn = f * TICK;
      // 2 s after the cap (its braking from 1 m/s takes 1 s at 0.5 m/s²).
      if (tWarn > 0 && f * TICK > tWarn + 2) maxAfterCap = Math.max(maxAfterCap, mb.speedOf('Follow', f * TICK));
    }
    const events = mb.trace.filter((e) => e.kind === 'Replan:field' && e.id === 'Follow').map((e) => e.t);
    const gapsAtEvents = events.map((t) => bodyGap(mb, t) - W(mb.speedOf('Follow', t)));
    const out = { events, gapsAtEvents, tWarn, states, maxFollowSpeedAfterCap: maxAfterCap, stale: mb.stats.fieldStale };
    mb.trace = null;
    runner.dispose();
    return out;
  }

  it('a faster follower enters the WARNING field at the predicted instant, is capped to the leader speed, never protective', () => {
    const r = runDes({ leadStart: 12000, leadSpeed: 500, seconds: 60 });
    // The warning entry event: the last field event at or before the first warned frame.
    const k = r.events.findIndex((t) => t > r.tWarn) - 1;
    const iEntry = k >= 0 ? k : r.events.length - 1;
    expect(r.tWarn - r.events[iEntry]).toBeLessThanOrEqual(TICK + 1e-9); // ± 1 tick
    // At that event the body gap equals the warning length at the current speed.
    expect(Math.abs(r.gapsAtEvents[iEntry])).toBeLessThan(1e-3);
    // Stable: warned once, no flip-flop (hysteresis), never protective.
    expect(r.states).toEqual(['clear', 'warning']);
    // Capped at max(DockingSpeed 0.3, v_leader 0.5) = 0.5 m/s.
    expect(r.maxFollowSpeedAfterCap).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('the cap holds: the follower never exceeds the leader speed while warned', () => {
    course();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    [
      makeAgvRoot('Lead', { PathId: 'S', StartPosition: 12000, TargetSpeed: 500, VehicleLength: 1000, VehicleWidth: 600 }),
      makeAgvRoot('Follow', { PathId: 'S', StartPosition: 600, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 }),
    ].forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    const mb = getDefaultMovementAuthority('des');
    let tWarn = -1, maxV = 0;
    for (let f = 1; f <= Math.round(60 / TICK); f++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      const t = f * TICK;
      if (tWarn < 0 && mb.fieldStateOf('Follow') === 'warning') tWarn = t;
      if (tWarn > 0 && t > tWarn + 2) maxV = Math.max(maxV, mb.speedOf('Follow', t));
    }
    expect(sig(host, 'Follow', 'FieldWarning')).toBe(true);
    expect(sig(host, 'Follow', 'FieldProtective')).toBe(false);
    runner.dispose();
    expect(tWarn).toBeGreaterThan(0);
    expect(maxV).toBeLessThanOrEqual(0.5 + 1e-6);
  });

  it('an already violated field at the start does not storm (hysteresis), and it clears when the leader branches off', () => {
    const r = runDes({ leadStart: 2400, leadSpeed: 1000, seconds: 80, branchLead: true });
    // Starts warned (gap 0.8 m < W), no event storm at any single instant.
    expect(r.states[1]).toBe('warning');
    const perInstant = new Map<number, number>();
    for (const t of r.events) perInstant.set(t, (perInstant.get(t) ?? 0) + 1);
    expect(Math.max(0, ...perInstant.values())).toBeLessThanOrEqual(2);
    expect(r.events.length).toBeLessThan(20);
    // The leader turns off onto 'Side': the follower's field clears.
    expect(r.states[r.states.length - 1]).toBe('clear');
  });

  it('predictions made stale by a leader re-plan are dropped, never applied', () => {
    course();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const roots = [
      makeAgvRoot('Lead', { PathId: 'S', StartPosition: 12000, TargetSpeed: 1500, VehicleLength: 1000, VehicleWidth: 600 }),
      makeAgvRoot('Follow', { PathId: 'S', StartPosition: 600, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 }),
      makeAgvRoot('Clock', { PathId: 'Side', StartPosition: 40000, VehicleLength: 1000, VehicleWidth: 600 }),
    ];
    roots.forEach((r) => bindDes(runner, r, host));
    runner.start([], { root: new Object3D() });
    // The leader stands (Run off): the follower's warning entry is predicted
    // against a standing leader (~9 s). At 3 s the leader starts and outruns
    // the follower — the pending prediction is stale and must never fire.
    const leadSelf = runner.liveInstances.find((i) => i.self.root === roots[0])!.self as unknown as {
      sig: { Run: { set(v: boolean): void } };
    };
    leadSelf.sig.Run.set(false);
    getDefaultAgvFleet().get('Lead')!.clear();
    const mb = getDefaultMovementAuthority('des');
    getDefaultAgvFleet().get('Clock')!.assign({
      destination: 'Side', serviceSec: 3,
      onServiceEnd: () => {
        leadSelf.sig.Run.set(true);
        getDefaultAgvFleet().get('Lead')!.assign({ destination: 'Main' });
      },
    });
    const states: FieldState[] = [];
    for (let f = 1; f <= Math.round(40 / TICK); f++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      const st = mb.fieldStateOf('Follow');
      if (states[states.length - 1] !== st) states.push(st);
    }
    const stale = mb.stats.fieldStale;
    runner.dispose();
    expect(stale).toBeGreaterThanOrEqual(1);
    expect(states).toEqual(['clear']);
  });

  it('continuous kernel: the same warning entry instant as DES', () => {
    const d = runDes({ leadStart: 12000, leadSpeed: 500, seconds: 40 });
    clearShared();
    course();
    const host = makeHost();
    const hL = bindContinuous(makeAgvRoot('Lead', { PathId: 'S', StartPosition: 12000, TargetSpeed: 500, VehicleLength: 1000, VehicleWidth: 600 }), host);
    const hF = bindContinuous(makeAgvRoot('Follow', { PathId: 'S', StartPosition: 600, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 }), host);
    const mb = getDefaultMovementAuthority('continuous');
    mb.trace = [];
    for (let i = 0; i < Math.round(40 / TICK); i++) { iterateFixedUpdate(hL, TICK); iterateFixedUpdate(hF, TICK); }
    const ev = mb.trace.filter((e) => e.kind === 'Replan:field' && e.id === 'Follow').map((e) => e.t);
    mb.trace = null;
    hL.dispose();
    hF.dispose();
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev.length).toBe(d.events.length);
    for (let i = 0; i < ev.length; i++) expect(Math.abs(ev[i] - d.events[i])).toBeLessThan(1e-9);
  });
});

describe('scanner field overlay plugin (plan-558 §9.10)', () => {
  const fakeViewer = { markRenderDirty: () => {} } as unknown as RVViewer;

  it('category off → no visible field; on → the field length follows v(t) at render time; dispose frees the shared resources', () => {
    course();
    const runner = new DESRunner({ subMode: 'animated' });
    const host = makeHost();
    const root = makeAgvRoot('Solo', { PathId: 'S', StartPosition: 600, TargetSpeed: 1500, Acceleration: 300, VehicleLength: 1000, VehicleWidth: 600 });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    setOverlayVisible('safety-fields', false);
    const plugin = new AgvScannerFieldPlugin();
    plugin.init(fakeViewer);
    const tick = (): void => { runner.tick(TICK); runner.lateTick(TICK); plugin.onRender(); };
    tick();
    const group = root.children.find((c) => c.name === '__agvScannerFields')!;
    expect(group).toBeDefined();
    expect(group.visible).toBe(false);
    setOverlayVisible('safety-fields', true);
    expect(group.visible).toBe(true);
    // Accelerating at 0.3 m/s² for 5 s from one plan (no DES event in between):
    // the warning field length follows the render-time speed.
    const lens: number[] = [];
    const speeds: number[] = [];
    const mb = getDefaultMovementAuthority('des');
    const events0 = runner.getManager().totalEventsProcessed;
    for (let i = 0; i < 300; i++) {
      tick();
      if (i % 60 === 59) {
        lens.push(group.children[0].scale.z);
        speeds.push(mb.renderSpeedOf('Solo'));
      }
    }
    expect(runner.getManager().totalEventsProcessed - events0).toBeLessThanOrEqual(1);
    for (let k = 1; k < lens.length; k++) expect(lens[k]).toBeGreaterThan(lens[k - 1]);
    for (let k = 0; k < lens.length; k++) expect(lens[k]).toBeCloseTo(W(speeds[k]), 3);
    expect(plugin.fieldCount).toBe(1);
    expect(plugin.hasSharedResources).toBe(true);
    plugin.dispose();
    expect(root.children.find((c) => c.name === '__agvScannerFields')).toBeUndefined();
    expect(plugin.fieldCount).toBe(0);
    expect(plugin.hasSharedResources).toBe(false);
    setOverlayVisible('safety-fields', false);
    runner.dispose();
  });
});
