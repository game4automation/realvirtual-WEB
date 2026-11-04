// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-629 §9.5 (+ gate R1-2 / R1-7) — the LIVE source: an interface controls
 * the vehicle (`isWired`), so the trace reads the node's world pose and the
 * `Agv.*` signals (the PLC values). A live vehicle is SIGNAL-driven by design,
 * so asserting signals here does not touch the #202 time skew of planned ones.
 *
 * - wired + UseAcceleration = true → source `live` (wins over `planned`);
 *   unwiring during the run switches back to `planned`;
 * - 0.3 m beside a path, Run && !Moving && Speed 0 → blocked;
 * - Agv.Blocked while the speed signal says driving → blocked;
 * - 3 m beside the network → not counted;
 * - the grid only finds candidates: the position is PROJECTED onto the path,
 *   the whole body interval is covered (longer than a bucket, clipped at the
 *   piece end), the heading decides which side the asymmetric body reaches;
 * - parallel pieces: the nearer wins, an exact tie goes to the smaller id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { setSignalLiveControlled, clearLiveControl } from '../../src/core/engine/rv-live-control';
import { PathTraceDriver } from '../../src/core/engine/rv-path-trace-sources';
import type { TraceSink } from '../../src/core/engine/rv-path-trace';
import { TICK, makeHost, makeAgvRoot, bindContinuous, clearShared, type AgvTestHost } from '../helpers/agv-harness';
import type { Object3D } from 'three';

beforeEach(() => clearShared());
afterEach(() => clearLiveControl());

/** Two parallel pieces along +x: A at z = 0 (20 m), B at z = 1 (20 m); C far away at z = 50. */
function parallel(): void {
  const net = getDefaultPathNetwork();
  const add = (id: string, z: number, len = 20): void => {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id, closed: false, align: [0, 1, 0], successors: [],
      segments: [{ kind: 'line', from: [0, 0, z], to: [len, 0, z] }],
    }, id)!);
  };
  add('A', 0); add('B', 1); add('C', 50, 4);
  net.resolveGraph();
}

interface Live { host: AgvTestHost; root: Object3D; handle: BindContextHandle; driver: PathTraceDriver; covers: Array<{ p: string; a: number; b: number; blocked: boolean }>; sample(): void }

function live(cfg: Record<string, unknown> = {}, body?: { length: number; width: number; rootOffset?: number }): Live {
  parallel();
  setSignalLiveControlled('W.Agv.Run', true); // an interface owns the vehicle → isWired
  const host = makeHost();
  const root = makeAgvRoot('W', { PathId: 'C', StartPosition: 1000, VehicleLength: 1200, VehicleWidth: 800, ...cfg }, body);
  const handle = bindContinuous(root, host);
  const driver = new PathTraceDriver();
  driver.rebuild(getDefaultPathNetwork().all());
  const covers: Live['covers'] = [];
  const rec: TraceSink = {
    sampleTime: 0,
    cover: (p, a, b, blocked) => { covers.push({ p: driver.trace.paths[p].id, a, b, blocked }); },
  };
  return { host, root, handle, driver, covers, sample: () => { covers.length = 0; driver.sampler.sample(0, rec); } };
}

function setSignals(w: Live, s: { run: boolean; moving: boolean; speed: number; blocked: boolean }): void {
  w.host.signalStore!.set('W.Agv.Run', s.run);
  w.host.signalStore!.set('W.Agv.Moving', s.moving);
  w.host.signalStore!.set('W.Agv.Speed', s.speed);
  w.host.signalStore!.set('W.Agv.Blocked', s.blocked);
}

describe('PathTrace live source (plan-629 §9.5)', () => {
  it('wired + UseAcceleration → live; unwiring switches back to planned', () => {
    const w = live({ UseAcceleration: true });
    const h = getDefaultAgvFleet().get('W')!;
    expect(h.traceSource).toBe('live');
    clearLiveControl();
    for (let i = 0; i < 3; i++) iterateFixedUpdate(w.handle, TICK);
    expect(h.traceSource).toBe('planned');
  });

  it('0.3 m beside a path, Run && !Moving && Speed 0 → blocked over the projected body interval', () => {
    const w = live();
    w.root.position.set(6.4, 0, -0.3);
    w.root.rotation.set(0, Math.PI / 2, 0); // heading +x (along A)
    setSignals(w, { run: true, moving: false, speed: 0, blocked: false });
    w.sample();
    expect(w.covers).toHaveLength(1);
    expect(w.covers[0].p).toBe('A');
    expect(w.covers[0].a).toBeCloseTo(6.4 - 0.6, 9);
    expect(w.covers[0].b).toBeCloseTo(6.4 + 0.6, 9);
    expect(w.covers[0].blocked).toBe(true);
    // Counted through the dt driver (no planned vehicle moves the clock).
    for (let i = 0; i < 120; i++) w.driver.tickFixed(TICK);
    const tr = w.driver.trace;
    const a = tr.pathBuckets(tr.indexOfPathId('A'));
    expect(tr.count('blocked', 'start', a.first + 2)).toBe(tr.samplesTotal);  // [4, 6] ∋ 5.8
    expect(tr.count('blocked', 'start', a.first + 3)).toBe(tr.samplesTotal);  // [6, 8] ∋ 7.0
    expect(tr.count('blocked', 'start', a.first + 1)).toBe(0);
    // Moving again → occupied, not blocked.
    setSignals(w, { run: true, moving: true, speed: 800, blocked: false });
    w.sample();
    expect(w.covers[0].blocked).toBe(false);
  });

  it('Agv.Blocked while the speed signal says driving → blocked', () => {
    const w = live();
    w.root.position.set(10, 0, 0.2);
    w.root.rotation.set(0, Math.PI / 2, 0);
    setSignals(w, { run: true, moving: true, speed: 900, blocked: true });
    w.sample();
    expect(w.covers[0].blocked).toBe(true);
  });

  it('3 m beside the network → not counted', () => {
    const w = live();
    w.root.position.set(10, 0, -3);
    setSignals(w, { run: true, moving: false, speed: 0, blocked: false });
    w.sample();
    expect(w.covers).toHaveLength(0);
    for (let i = 0; i < 60; i++) w.driver.tickFixed(TICK);
    const tr = w.driver.trace;
    for (let b = 0; b < tr.bucketCount; b++) expect(tr.count('utilization', 'start', b)).toBe(0);
  });

  it('a body longer than a bucket covers every bucket; clipped at the piece end', () => {
    const w = live({ VehicleLength: 5000 });
    w.root.position.set(19, 0, -0.2);
    w.root.rotation.set(0, Math.PI / 2, 0);
    setSignals(w, { run: true, moving: true, speed: 500, blocked: false });
    for (let i = 0; i < 60; i++) w.driver.tickFixed(TICK);
    const tr = w.driver.trace;
    const a = tr.pathBuckets(tr.indexOfPathId('A'));
    // [16.5, 21.5] on a 20 m piece → buckets 8 and 9 ([16, 18], [18, 20]); 7 untouched.
    expect(tr.count('utilization', 'start', a.first + 9)).toBe(tr.samplesTotal);
    expect(tr.count('utilization', 'start', a.first + 8)).toBe(tr.samplesTotal);
    expect(tr.count('utilization', 'start', a.first + 7)).toBe(0);
    w.root.position.set(10, 0, -0.2);
    w.sample();
    expect(w.covers[0].b - w.covers[0].a).toBeCloseTo(5, 9); // 3 buckets touched: [7.5, 12.5]
  });

  it('the heading decides where the asymmetric body reaches (forks at the rear)', () => {
    // Mesh body 2.4 m with the root 0.4 m ahead of its centre → front 0.8, rear 1.6.
    const w = live({ VehicleLength: 0, VehicleWidth: 0 }, { length: 2.4, width: 1.0, rootOffset: -0.4 });
    setSignals(w, { run: true, moving: true, speed: 500, blocked: false });
    w.root.position.set(10, 0, -0.1);
    w.root.rotation.set(0, Math.PI / 2, 0); // front along +x = path tangent
    w.sample();
    expect(w.covers[0].a).toBeCloseTo(10 - 1.6, 6);
    expect(w.covers[0].b).toBeCloseTo(10 + 0.8, 6);
    w.root.rotation.set(0, -Math.PI / 2, 0); // front along −x
    w.sample();
    expect(w.covers[0].a).toBeCloseTo(10 - 0.8, 6);
    expect(w.covers[0].b).toBeCloseTo(10 + 1.6, 6);
  });

  it('parallel pieces: the nearer wins; an exact tie goes to the smaller id', () => {
    const w = live();
    setSignals(w, { run: true, moving: true, speed: 500, blocked: false });
    w.root.position.set(8, 0, 0.6); // 0.6 from A, 0.4 from B
    w.sample();
    expect(w.covers[0].p).toBe('B');
    w.root.position.set(8, 0, 0.5); // exact tie
    w.sample();
    expect(w.covers[0].p).toBe('A');
    w.root.position.set(8, 0, 0.45);
    w.sample();
    expect(w.covers[0].p).toBe('A');
    expect(w.driver.trace.work.searchCells).toBeGreaterThan(0);
    expect(w.driver.trace.work.searchCandidates).toBeGreaterThan(0);
  });
});
