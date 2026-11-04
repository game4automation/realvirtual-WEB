// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { testAddressRegistry } from './helpers/test-address-registry';

/**
 * conveyor-run-edge-des.test.ts — plan-645 9.4 (S6 / L7).
 *
 * In DES a Conveyor parks an arrived MU in `blockedMUs` while `Flow.Run` is
 * false; before plan-645 only `onDownstreamReady` retried, so a Run false→true
 * edge never released it (the line stood still behind a stopped belt). The wake
 * is bounded: the list is detached, every MU gets at most ONE try, a refused one
 * goes back exactly once (FIFO kept), nested wakes are no-ops, and a flank
 * during a snapshot restore is held back and caught up once afterwards.
 *
 * Runs bounded by sim time and events, never wall clock. DES (core since
 * plan-680; imports `@rv/plugins/des/*`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import Source from '../src/behaviors/Source';
import Sink from '../src/behaviors/Sink';
import { ConveyorFlow } from '../src/behaviors/Conveyor';
import {
  _resetMaterialFlowRegistry,
  getMaterialFlow,
  registerMaterialFlow,
} from '../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';

void Source; void Sink;

const MAX_EVENTS = 20_000;
const RUN = 'Conveyor_2.Flow.Run';

const DEFS: MaterialFlowDefinition[] = [
  getMaterialFlow('Source')!,
  getMaterialFlow('Sink')!,
  ConveyorFlow as unknown as MaterialFlowDefinition,
];

function resetWorld(): void {
  _resetMaterialFlowRegistry();
  for (const d of DEFS) registerMaterialFlow(d);
  _resetDesHookCache();
  resetDESMUCounter();
}

function line(): { scene: Scene; host: BindContextHost; store: SignalStore } {
  const scene = new Scene();
  const drives: BindContextHost['drives'] = [];
  const add = (name: string, payload: Record<string, unknown>, x: number): Object3D => {
    const root = new Object3D();
    root.name = name;
    root.userData.realvirtual = { ...payload, LayoutObject: { Name: name } };
    root.position.set(x, 0, 0);
    scene.add(root);
    return root;
  };
  const snapAt = (parent: Object3D, name: string, x: number): void => {
    const s = new Object3D(); s.name = name; s.position.set(x, 0, 0); parent.add(s);
  };
  const conveyor = (name: string, x: number): void => {
    const root = add(name, { Conveyor: {} }, x);
    const belt = new Mesh(new BoxGeometry(1, 0.1, 0.4));
    belt.name = 'Transport-X';
    root.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
    snapAt(root, 'Snap-XN-convroll', -0.5);
    snapAt(root, 'Snap-XP-convroll', 0.5);
    drives.push({ name: 'Transport-X', node: belt, TargetSpeed: 500 });
  };
  const src = add('Source_1', { Source: { Interval: 2, AutomaticGeneration: true } }, -0.75);
  const body = new Mesh(new BoxGeometry(0.3, 0.05, 0.3)); body.name = 'SourceBody'; src.add(body);
  snapAt(src, 'Snap-XP-convroll', 0.25);
  conveyor('Conveyor_1', 0);
  conveyor('Conveyor_2', 1);
  const snk = add('Sink_1', { Sink: {} }, 1.75);
  const sbody = new Mesh(new BoxGeometry(0.4, 0.4, 0.4)); sbody.name = 'SinkBody'; snk.add(sbody);
  snapAt(snk, 'Snap-XN-convroll', -0.25);
  let i = 0;
  scene.traverse((n) => { n.uuid = `00000000-0000-4000-8000-${String(i++).padStart(12, '0')}`; });
  scene.updateMatrixWorld(true);
  const events = new EventEmitter<Record<string, unknown>>();
  const store = new SignalStore();
  const host = {
    signalStore: store,
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry: null, desAddresses: testAddressRegistry(scene),
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
  return { scene, host, store };
}

interface Rig {
  runner: DESRunner;
  store: SignalStore;
  sunk(): number;
  blocked(): unknown[];
  run(t: number): void;
}

function rig(): Rig {
  const l = line();
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 10_000, masterSeed: 7 });
  runner.start([...DEFS], { root: l.scene, host: l.host });
  const inst = (name: string) => runner.liveInstances.find((x) => x.self.root.name === name)!;
  const mgr = runner.getManager();
  return {
    runner,
    store: l.store,
    sunk: () => (inst('Sink_1').adapter as unknown as { totalProcessed: number }).totalProcessed,
    blocked: () => (inst('Conveyor_2').self.local as unknown as { blockedMUs: unknown[] }).blockedMUs,
    run: (t) => { mgr.processUpTo(t, MAX_EVENTS); },
  };
}

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWorld();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { infoSpy.mockRestore(); });

describe('plan-645 9.4 — Conveyor Flow.Run edge in DES', () => {
  it('false → true releases the parked MU; the line delivers again', () => {
    const r = rig();
    expect(r.store.get(RUN)).toBe(true);
    r.run(20);
    const before = r.sunk();
    expect(before, 'the line delivers').toBeGreaterThan(0);
    r.store.set(RUN, false);
    r.run(60);
    const stopped = r.sunk();
    expect(r.blocked().length, 'an MU is parked behind the stopped belt').toBe(1);
    r.run(80);
    expect(r.sunk(), 'nothing passes a stopped belt').toBe(stopped);
    r.store.set(RUN, true);
    expect(r.blocked().length, 'the edge released the parked MU at once').toBe(0);
    r.run(140);
    expect(r.sunk(), 'the line delivers again').toBeGreaterThan(stopped + 3);
    r.runner.dispose();
  });

  it('repeated toggling: no duplicates in blockedMUs, no lost MU', () => {
    const r = rig();
    r.run(20);
    for (let k = 0; k < 6; k++) {
      r.store.set(RUN, false);
      r.run(30 + k * 20);
      r.store.set(RUN, true);
      r.store.set(RUN, true);           // same value: no second wake effect
      r.run(40 + k * 20);
      const ids = (r.blocked() as Array<{ id: number }>).map((m) => m.id);
      expect(new Set(ids).size, 'no duplicate in blockedMUs').toBe(ids.length);
    }
    expect(r.sunk()).toBeGreaterThan(10);
    r.runner.dispose();
  });

  it('downstream full: the refused MU goes back exactly once and keeps its place', () => {
    const r = rig();
    r.run(20);
    r.store.set(RUN, false);
    r.run(60);
    const parked = [...r.blocked()];
    expect(parked.length).toBe(1);
    // Make the downstream refuse: the sink accepts nothing for this wake.
    const sink = r.runner.liveInstances.find((x) => x.self.root.name === 'Sink_1')!.adapter as unknown as { canAccept: (m: unknown) => boolean };
    const orig = sink.canAccept.bind(sink);
    sink.canAccept = () => false;
    r.store.set(RUN, true);
    expect(r.blocked(), 'refused → back in blockedMUs, exactly once').toEqual(parked);
    sink.canAccept = orig;
    r.store.set(RUN, false);
    r.store.set(RUN, true);
    expect(r.blocked().length, 'a later edge releases it').toBe(0);
    r.runner.dispose();
  });

  it('a Run edge during a snapshot restore wakes nothing mid-restore; the catch-up releases no ghost MU', () => {
    const r = rig();
    r.run(20);
    // Park an MU with Run = TRUE: the sink refuses for a while.
    const sink = r.runner.liveInstances.find((x) => x.self.root.name === 'Sink_1')!.adapter as unknown as {
      canAccept: (m: unknown) => boolean; acceptMU: (m: unknown) => boolean;
    };
    sink.canAccept = () => false;
    r.run(60);
    expect(r.blocked().length, 'parked behind the refusing sink').toBe(1);
    const ghost = r.blocked()[0];
    // plan-2059 state guard: an own property on a component is undeclared state —
    // lift the test double for the capture (the refusal itself lives in the queue/state).
    delete (sink as { canAccept?: unknown }).canAccept;
    const snap = r.runner.fullSnapshot();     // Run = true, one parked MU
    r.store.set(RUN, false);
    const accepted: unknown[] = [];
    const origAccept = sink.acceptMU.bind(sink);
    sink.acceptMU = (m) => { accepted.push(m); return origAccept(m); };
    r.runner.restoreFull(snap);                // Run false → true happens DURING the restore
    expect(r.store.get(RUN)).toBe(true);
    expect(accepted, 'the pre-restore MU object is never released (no mid-restore wake)').not.toContain(ghost);
    expect(r.blocked(), 'the catch-up drops MU objects the conveyor no longer holds').not.toContain(ghost);
    r.run(160);
    expect(accepted).not.toContain(ghost);
    expect(r.sunk(), 'the restored line keeps delivering').toBeGreaterThan(0);
    r.runner.dispose();
  });

  it('repeated resets keep one subscription per bind (one wake per edge)', () => {
    const r = rig();
    r.runner.reset();
    r.runner.reset();
    r.run(20);
    r.store.set(RUN, false);
    r.run(60);
    expect(r.blocked().length).toBe(1);
    r.store.set(RUN, true);
    expect(r.blocked().length).toBe(0);
    r.run(120);
    expect(r.sunk()).toBeGreaterThan(5);
    r.runner.dispose();
  });
});
