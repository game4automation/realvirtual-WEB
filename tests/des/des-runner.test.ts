// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-runner.test.ts — Plan 194 P5 (DESRunner + hook adapter + sub-modes).
 *
 * Verifies the private DESRunner end-to-end against the public material-flow
 * surface:
 *  - hook name → integer dispatch (R3): `self.in('Arrival', …)` resolves the
 *    `<type>.Arrival` named action and the hook runs.
 *  - Animated sub-mode advances simNow by dt and fires due events.
 *  - HybridSynced spreads a large batch across frames (B4) — NEVER drops events.
 *  - FastForward drains the queue (jump-to-event-time, no render write).
 *  - Step processes exactly one event.
 *  - the tween registry is driven on lateTick (Animated) / off in FastForward.
 *  - createDesRunner factory is non-null in the private build (kernel wiring).
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { createDesRunner } from '@rv-private/plugins/des/register-des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

// ─── Minimal bind context (mirrors material-flow-self.test.ts) ────────────

function makeBindContext(root: Object3D): RVBindContext {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('DESRunner — factory wiring', () => {
  it('createDesRunner is non-null in the private build', () => {
    expect(createDesRunner).not.toBe(null);
    const exec = createDesRunner!([], { root: new Object3D() });
    expect(exec.mode).toBe('des');
  });
});

describe('DESRunner — hook int-dispatch + Animated', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('schedules and dispatches a des hook by short suffix (R3)', () => {
    const fired: string[] = [];
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestConveyor',
      kind: 'conveyor',
      schema: {},
      continuous: {},
      setup() { fired.push('setup'); },
      des: {
        onGenerate(self) {
          // schedule an Arrival 2s out
          self.in(2, 'Arrival', { id: 1 } as MU);
        },
        onArrival() { fired.push('arrival'); },
      },
    });

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D();
    node.name = 'TestConveyor1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);

    runner.start([def as MaterialFlowDefinition], { root: node });
    expect(fired).toContain('setup');

    // start() auto-fires every DECLARED des.onGenerate exactly once (plan-268
    // Phase 3: declaration-gated, no longer kind-gated to source/downtime) —
    // the Arrival above is already scheduled 2s out.

    // Advance < 2s — no arrival yet.
    runner.tick(1.0);
    expect(fired).not.toContain('arrival');
    // Advance past 2s — arrival fires exactly once.
    runner.tick(1.5);
    expect(fired).toContain('arrival');
    expect(fired.filter(f => f === 'arrival').length).toBe(1);
  });
});

describe('DESRunner — sub-modes (B4 no-drop / FastForward / Step)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  /** Build a def that, on each Generate, schedules N back-to-back events. */
  function makeBurstDef(count: number, processed: { n: number }) {
    return defineMaterialFlow<MaterialFlowSelf>({
      type: 'Burst',
      kind: 'source',
      schema: {},
      continuous: {},
      des: {
        onGenerate(self) {
          for (let i = 0; i < count; i++) {
            // all due at t = 0.001*(i+1) — a dense burst
            self.at(0.001 * (i + 1), 'Arrival', null);
          }
        },
        onArrival() { processed.n++; },
      },
    });
  }

  it('HybridSynced spreads a large burst across frames and drops NOTHING (B4)', () => {
    const processed = { n: 0 };
    const def = makeBurstDef(5000, processed);
    const runner = new DESRunner({ subMode: 'hybrid', frameEventBudget: 1000, multiplier: 50 });
    const node = new Object3D(); node.name = 'Burst1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);

    runner.start([def as MaterialFlowDefinition], { root: node });
    // start() fired onGenerate (kind 'source') → 5000 events queued at t≈0..5s.

    // One big-dt frame at 50× would advance simNow by a lot, but the per-frame
    // budget is 1000 → it must take ≥ 5 frames to drain, NEVER truncating.
    let frames = 0;
    while (runner.getManager().pendingEventCount > 0 && frames < 100) {
      runner.tick(0.1); // 0.1s · 50× = 5s render advance — covers all event times
      frames++;
    }
    expect(frames).toBeGreaterThanOrEqual(5); // batch spread across frames
    expect(processed.n).toBe(5000);           // EVERY event processed (no drop)
    expect(runner.getManager().pendingEventCount).toBe(0);
  });

  it('standalone FastForward (SimModeToggle path — no runFastForward()) drains the whole queue via tick()', () => {
    const processed = { n: 0 };
    const def = makeBurstDef(3000, processed);
    const runner = new DESRunner({ subMode: 'fastforward', frameEventBudget: 5000 });
    const node = new Object3D(); node.name = 'Burst2';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // plan-262 Phase 1: the tick()-FF branch is a time-based deadline loop
    // (12 ms slices of 2000-event inner batches) — a dense 3000-event burst
    // drains within very few frames instead of one fixed batch per frame.
    let frames = 0;
    while (runner.getManager().pendingEventCount > 0 && frames < 50) {
      runner.tick(0.016);
      frames++;
    }
    expect(processed.n).toBe(3000);
  });

  it('runFastForward() drains the whole queue asynchronously and resolves true (plan-262)', async () => {
    const processed = { n: 0 };
    const def = makeBurstDef(3000, processed);
    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'Burst2b';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // Real await chain — the drain loop yields via yieldToBrowser (no rIC).
    const done = await runner.runFastForward();
    expect(done).toBe(true);
    expect(processed.n).toBe(3000);
    expect(runner.getManager().pendingEventCount).toBe(0);
    expect(runner.subMode).toBe('fastforward');
    expect(runner.ffProgress).toBeUndefined(); // run finished → no in-flight progress

    // Idempotence: a completed run re-triggers cleanly (queue already empty).
    await expect(runner.runFastForward()).resolves.toBe(true);
  });

  it('runFastForward() while already running resolves false immediately; cancel resolves the first promise false (plan-262 R3)', async () => {
    // Self-rescheduling stream — FastForward never completes on its own.
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'InfiniteBurst', kind: 'source', schema: {}, continuous: {},
      des: {
        onGenerate(self) { self.in(0.001, 'Arrival', null); },
        onArrival(self) { self.in(0.001, 'Arrival', null); },
      },
    });
    const runner = new DESRunner({ subMode: 'animated', durationSeconds: 1e9 });
    const node = new Object3D(); node.name = 'Infinite1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    const p1 = runner.runFastForward();
    expect(runner.ffProgress).toBeDefined();          // in flight
    await expect(runner.runFastForward()).resolves.toBe(false); // second call: false immediately

    runner.cancelFastForward();                        // synchronous resolve (R3)
    await expect(p1).resolves.toBe(false);
    expect(runner.ffProgress).toBeUndefined();
    runner.dispose();
  });

  it('Animated/Hybrid stop at the sim END time (consistent with FastForward)', () => {
    const processed = { n: 0 };
    // Two events: one inside the end time (t=1), one beyond it (t=5). End = 2s.
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'EndStop', kind: 'source', schema: {}, continuous: {},
      des: {
        onGenerate(self) { self.at(1.0, 'Arrival', null); self.at(5.0, 'Arrival', null); },
        onArrival() { processed.n++; },
      },
    });
    const runner = new DESRunner({ subMode: 'animated', durationSeconds: 2 });
    const node = new Object3D(); node.name = 'EndStop1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // Advance far past the end: the render clock must CLAMP at 2s and the event
    // at t=5 must never process (previously animated drifted past the end, and a
    // later FastForward — capped at the end — then looked frozen).
    for (let i = 0; i < 10; i++) { runner.tick(1.0); runner.lateTick(1.0); }
    expect(processed.n).toBe(1);                    // only the t=1 event
    expect(runner.simTime).toBeCloseTo(1.0);        // clock stops at the last event ≤ end
    expect(runner.renderClock).toBeCloseTo(2.0);    // render clock clamped at the end
    expect(runner.getManager().pendingEventCount).toBe(1); // t=5 stays queued
  });

  it('Step processes exactly one event per step()', () => {
    const processed = { n: 0 };
    const def = makeBurstDef(10, processed);
    const runner = new DESRunner({ subMode: 'step' });
    const node = new Object3D(); node.name = 'Burst3';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    runner.tick(1.0);            // step mode: tick does NOT auto-advance
    expect(processed.n).toBe(0);
    runner.step();
    expect(processed.n).toBe(1);
    runner.step();
    expect(processed.n).toBe(2);
  });
});

describe('DESRunner — tween integration', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('Animated drives the tween registry on lateTick; FastForward does NOT write parts (no animation, max throughput)', () => {
    const target = { pos: new Vector3(), writes: 0, setPosition(v: Vector3) { this.pos.copy(v); this.writes++; } };

    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'Mover',
      kind: 'source',
      schema: {},
      continuous: {},
      des: { onGenerate() { /* no events; tween added directly below */ } },
    });
    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'Mover1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // Register a position tween 0→10 over 2s starting at the current render clock.
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);

    runner.tick(1.0);      // simNow → 1.0
    runner.lateTick(1.0);  // animated → render at 1.0 → 50%
    expect(target.pos.x).toBeCloseTo(5);

    // Interactive FastForward is for MAX THROUGHPUT: lateTick must NOT write part
    // positions (the noWrite 'fastforward' sub) — the parts do NOT animate; only the
    // sim clock + event queue advance. Switching back to a slower factor resumes
    // animation from the live sim state.
    runner.setSubMode('fastforward');
    const writesBefore = target.writes;
    runner.tick(0.5);
    runner.lateTick(0.5);
    expect(target.writes).toBe(writesBefore); // no per-part writes during FastForward
  });

  it('leaving FastForward settles running tweens to the exact sim position (no teleport)', () => {
    const target = { pos: new Vector3(), writes: 0, setPosition(v: Vector3) { this.pos.copy(v); this.writes++; } };

    // onGenerate schedules a single event at t=4s so FastForward advances the sim
    // clock to 4.0 (in DES the clock moves by EVENTS, not by dt).
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'Mover2', kind: 'source', schema: {}, continuous: {},
      // samplesLiveGeometry keeps the per-event-time settle wired (plan-262
      // Phase 2 gating) — this test asserts exactly that settle behavior.
      des: { samplesLiveGeometry: true, onGenerate(self) { self.at(4.0, 'Arrival', null); }, onArrival() { /* no-op */ } },
    });
    const runner = new DESRunner({ subMode: 'fastforward' });
    const node = new Object3D(); node.name = 'Mover2';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    // A long position tween (0→100 over 10s) so it stays RUNNING across the FF window.
    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(100, 0, 0), 0, 10);

    // FastForward drains the event → sim clock advances to 4.0. The event-time
    // settle (manager.onTimeAdvance → tweens.settle) writes the part at EXACTLY
    // the event time, so even in FF it sits at its true sim position (40% → x=40).
    runner.tick(0.016);
    runner.lateTick(0.016);
    expect(runner.simTime).toBeCloseTo(4.0);
    expect(target.pos.x).toBeCloseTo(40);

    // Switching back to an animating sub-mode keeps the exact position (the exit
    // settle is idempotent here) — no teleport on the first continuous frame.
    runner.setSubMode('animated');
    expect(target.pos.x).toBeCloseTo(40);
  });

  it('remembers the pre-FastForward sub-mode so the FF toggle returns to the previous speed', () => {
    // Hybrid 5× → FF → the runner remembers 'hybrid' (the UI toggle returns there
    // WITHOUT re-picking the speed in the dropdown).
    const runner = new DESRunner({ subMode: 'hybrid', multiplier: 5 });
    expect(runner.preFastForwardSubMode).toBe('hybrid');
    runner.setSubMode('fastforward');
    expect(runner.preFastForwardSubMode).toBe('hybrid');
    // Re-setting FF while already in FF must NOT overwrite the memory.
    runner.setSubMode('fastforward');
    expect(runner.preFastForwardSubMode).toBe('hybrid');
    runner.setSubMode(runner.preFastForwardSubMode);
    expect(runner.subMode).toBe('hybrid');
    expect(runner.multiplier).toBe(5);

    // Animated → FF → back lands on animated.
    runner.setSubMode('animated');
    runner.setSubMode('fastforward');
    expect(runner.preFastForwardSubMode).toBe('animated');
  });

  it('starting directly in FastForward derives the return mode from the multiplier', () => {
    // Persisted mode = FastForward with a time-lapse factor → return to hybrid.
    const ff5 = new DESRunner({ subMode: 'fastforward', multiplier: 5 });
    expect(ff5.preFastForwardSubMode).toBe('hybrid');
    // No factor → return to real-time.
    const ff1 = new DESRunner({ subMode: 'fastforward' });
    expect(ff1.preFastForwardSubMode).toBe('animated');
  });

  it('event handlers sample visuals at the EXACT event time (settle-before-dispatch)', () => {
    const target = { pos: new Vector3(), writes: 0, setPosition(v: Vector3) { this.pos.copy(v); this.writes++; } };
    const sampled: number[] = [];

    // onGenerate: two events. At t=2 the handler SAMPLES the target's position —
    // the tween (0→10 over 2s) must already be settled to x=10 (finished at t=2)
    // BEFORE the handler runs, even though no render happened in between (FF).
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'Sampler', kind: 'source', schema: {}, continuous: {},
      des: {
        // The handler samples live geometry → declare it (plan-262 Phase 2
        // gating would otherwise skip the settle this test asserts).
        samplesLiveGeometry: true,
        onGenerate(self) { self.at(2.0, 'Arrival', null); self.at(3.0, 'Arrival', null); },
        onArrival() { sampled.push(target.pos.x); },
      },
    });
    const runner = new DESRunner({ subMode: 'fastforward' });
    const node = new Object3D(); node.name = 'Sampler1';
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def as MaterialFlowDefinition, () => adapter.entityId),
    });
    const adapter = runner.addInstance(def as MaterialFlowDefinition, self, node);
    runner.start([def as MaterialFlowDefinition], { root: node });

    runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);

    // One FF frame processes BOTH events back-to-back without a render between.
    runner.tick(0.016);
    runner.lateTick(0.016);

    expect(sampled.length).toBe(2);
    expect(sampled[0]).toBeCloseTo(10); // t=2: tween finished exactly now → settled to 10
    expect(sampled[1]).toBeCloseTo(10); // t=3: still 10 (tween reaped at settle)
  });
});

describe('DESRunner — Station definition (DES-only wrapper)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
  });

  it('holds an MU for ProcessingTime, then transfers it downstream', async () => {
    // Import here so the def self-registers AFTER the registry reset.
    const { Station } = await import('@rv-private/plugins/des/material-flow/Station');
    const def = Station as unknown as MaterialFlowDefinition<MaterialFlowSelf<{ processingTime: number }>>;
    const defAny = def as unknown as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'Station1';
    const self = createSelf<{ processingTime: number }>(makeBindContext(node), def, {
      mode: 'des',
      local: { processingTime: 0 },
      scheduler: runner.makeScheduler(defAny, () => adapter.entityId),
      onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    });
    // Sink-like downstream that records transferred MUs.
    const transferred: MU[] = [];
    const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
      type: 'TestSink', kind: 'sink', schema: {}, continuous: {},
      des: { onAccept(_s, mu) { transferred.push(mu); return true; } },
    });
    const sinkNode = new Object3D(); sinkNode.name = 'Sink1';
    const sinkSelf = createSelf(makeBindContext(sinkNode), sinkDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(sinkDef as MaterialFlowDefinition, () => sink.entityId),
    });
    const sink = runner.addInstance(sinkDef as MaterialFlowDefinition, sinkSelf, sinkNode);
    const adapter = runner.addInstance(defAny, self as unknown as MaterialFlowSelf, node);

    // Wire the Station's downstream to the sink (native handshake routing).
    runner.start([defAny, sinkDef as MaterialFlowDefinition], { root: node });
    adapter.nextComponents = [sink];

    // ProcessingTime defaults to 5s; accept an MU and verify the hold + release.
    self.local.processingTime = 3; // 3s hold
    const mu = runner.createMU();
    adapter.acceptMU(mu as never); // → des.onAccept schedules ProcessComplete in 3s

    runner.tick(2.0); // 2s — still processing
    expect(transferred.length).toBe(0);
    runner.tick(1.5); // past 3s — ProcessComplete fires → transfer
    expect(transferred.length).toBe(1);
    expect(transferred[0].id).toBe(mu.id);
  });
});
