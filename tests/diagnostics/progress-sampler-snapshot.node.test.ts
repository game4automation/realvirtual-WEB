// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import type { AgvHandle } from '../../src/core/engine/rv-agv-fleet';

function world() {
  let now = 0;
  const vehicle = { id: 'A', node: new Object3D(), task: { destination: 'target' },
    phase: 'driving' as AgvHandle['phase'], assign() {}, clear() {} };
  const wiring = new ProgressWiring({ fleet: { all: () => [vehicle] }, transport: new RVTransportManager(),
    sampleEveryTicks: 4, clock: { now: () => now }, running: () => true });
  return { wiring, step(t: number) {
    while (now < t) { now++; vehicle.node.position.x = now / 8; wiring.fixedStep(); }
  }, restoreTime(t: number) { now = t; vehicle.node.position.x = t / 8; } };
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: a cut between samples preserves exact ledger entries and cadence`, () => {
    const a = world();
    let b = a;
    try {
      a.step(6);
      const sampler = JSON.parse(JSON.stringify(a.wiring.snapshotState(() => null)));
      const ledger = structuredClone(a.wiring.ledger.snapshotState());
      a.step(16);
      const expected = a.wiring.ledger.snapshotState();
      if (mode === 'A') a.restoreTime(6); else { b = world(); b.restoreTime(6); }
      b.wiring.validateSnapshot(sampler);
      b.wiring.ledger.restoreState(ledger);
      b.wiring.restoreSnapshot(sampler, () => null);
      if (mode === 'B-immediate') expect(b.wiring.snapshotState(() => null)).toEqual(sampler);
      b.step(16);
      expect(b.wiring.ledger.snapshotState()).toEqual(expected);
    } finally { a.wiring.dispose(); if (b !== a) b.wiring.dispose(); }
  });
}

it('refuses a sampled transport MU without a stable DES id', () => {
  const mu = { aabb: { center: new Vector3() }, currentSurface: null } as unknown as RVMovingUnit;
  const wiring = new ProgressWiring({ fleet: { all: () => [] },
    transport: { mus: [mu], surfaces: [], sinks: [] }, clock: { now: () => 0 }, running: () => true });
  try { expect(() => wiring.snapshotState(() => null)).toThrow('sampled MU has no stable DES id'); }
  finally { wiring.dispose(); }
});

import { BlockageWatch } from '../../src/core/diagnostics/rv-blockage-watch';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { lineFixture } from '../des/runner-fixture';
import { continuationWorld } from '../des/continuation-world-fixture';
import { assertContinuation } from '../helpers/des-continuation-harness';

function participantWorld() {
  const f = lineFixture();
  const vehicle = { id: 'A', node: new Object3D(), task: { destination: 'target' },
    phase: 'driving' as AgvHandle['phase'], assign() {}, clear() {} };
  const wiring = new ProgressWiring({ fleet: { all: () => [vehicle] },
    transport: { mus: [], surfaces: [], sinks: [] }, sampleEveryTicks: 4,
    clock: { now: () => f.manager.currentTime }, running: () => true });
  const budgets = new BudgetResolver();
  const watch = new BlockageWatch(() => ({ ledger: wiring.ledger, registry: wiring.waitRegistry,
    budgets, now: f.manager.currentTime }));
  Object.assign(f.host, { blockageWatch: watch, progressWiring: wiring });
  const base = continuationWorld(f.runner, dt => {
    f.manager.processAnimated(dt);
    vehicle.node.position.x = f.manager.currentTime / 8;
    wiring.fixedStep();
  });
  return { ...base, dispose() { wiring.dispose(); base.dispose?.(); } };
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: diag.blockage includes the sampler in full snapshot continuation`, async () => {
    await assertContinuation({ buildWorld: participantWorld, mode, T: 1.5, TPrime: 3, T2: 6 });
  });
}

import type { ProgressSamplerState } from '../../src/core/diagnostics/rv-progress-wiring';
import { muRecords, partState } from '../des/snapshot-test-utils';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';

// `renderFrames`: run the runner's render pass after every step, as the viewer does. Only that pass retires the MUs a sink
// consumed (`_sweepConsumedVisuals`); a bare `processAnimated` loop never frees them (plan-2059 O6).
function sampledMUWorld(stationProcessTime = 1.1, renderFrames = false) {
  resetDESMUCounter();
  const f = lineFixture({ stationProcessTime, interArrivalTime: 1000 });
  const transport = new RVTransportManager();
  f.runner.registerMuVisualFactory('sample', () => {
    const visual = new RVMovingUnit(new Object3D(), 'sample');
    transport.mus.push(visual);
    return visual;
  }, visual => {
    const index = transport.mus.indexOf(visual);
    if (index >= 0) transport.mus.splice(index, 1);
    visual.dispose();
  });
  // The source places its first MU on the station at start: make room for the sampled MU.
  f.station.MaxCapacity = 2;
  const mu = f.runner.createMU('sample');
  expect(f.station.acceptMU(mu)).toBe(true);
  const wiring = new ProgressWiring({ fleet: { all: () => [] }, transport, sampleEveryTicks: 8,
    clock: { now: () => f.manager.currentTime }, running: () => true });
  const watch = new BlockageWatch(() => ({ ledger: wiring.ledger, registry: wiring.waitRegistry,
    budgets: new BudgetResolver(), now: f.manager.currentTime }));
  Object.assign(f.host, { blockageWatch: watch, progressWiring: wiring });
  const base = continuationWorld(f.runner, dt => {
    f.manager.processAnimated(dt);
    if (renderFrames) f.runner.lateTick(dt);
    wiring.fixedStep();
  });
  return { ...base, wiring, mu, dispose() { base.dispose?.(); wiring.dispose(); } };
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: capture between sink consumption and the next sample continues exactly`, async () => {
    await assertContinuation({ buildWorld: sampledMUWorld, mode, T: 1.25, TPrime: 3, T2: 4 });
  });
}

for (const headless of [false, true]) {
  it(`populated MU sampler restores without a visual (fast-forward=${headless})`, async () => {
    const a = sampledMUWorld();
    const b = sampledMUWorld();
    try {
      await a.step(0.5);
      const snapshot = a.runner.fullSnapshot();
      const sampler = partState<{ sampler: ProgressSamplerState }>(snapshot, 'diag.blockage').sampler;
      expect(sampler.mus).toHaveLength(1);
      if (headless) (b.runner as unknown as { setSubMode(m: string): void }).setSubMode('fastforward');
      else delete muRecords(snapshot).find(mu => mu.id === sampler.mus[0][0])!.visualTemplateId;
      expect(() => b.runner.restoreFull(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
      expect(partState<{ sampler: ProgressSamplerState }>(b.runner.fullSnapshot(), 'diag.blockage').sampler).toEqual(sampler);
    } finally { a.dispose(); b.dispose(); }
  });
}

it('malformed historical sample is refused before the world changes', async () => {
  const w = sampledMUWorld();
  try {
    await w.step(0.5);
    const before = w.runner.fullSnapshot();
    const bad = structuredClone(before);
    partState<{ sampler: ProgressSamplerState }>(bad, 'diag.blockage').sampler.mus[0][6] = NaN;
    expect(() => w.runner.restoreFull(bad)).toThrow('des-snapshot-contract');
    expect(w.runner.fullSnapshot()).toEqual(before);
  } finally { w.dispose(); }
});

// The station processes its two MUs in parallel (capacity 2): with a processing time of 2.2 s the sampled MU is consumed
// at 2.2 s, between the samples at 2.0 s (it is alive and sampled) and 4.0 s (not yet taken), and the render pass retires it.
it('sink consumption leaves detached history until the next sampler tick', async () => {
  const w = sampledMUWorld(2.2, true);
  try {
    await w.step(2.0);
    expect(w.mu.visual).not.toBeNull();
    expect(partState<{ sampler: ProgressSamplerState }>(w.runner.fullSnapshot(), 'diag.blockage').sampler.mus).toHaveLength(1);
    await w.step(2.25); // consumed at 2.2
    const snapshot = w.runner.fullSnapshot();
    expect(w.mu.visual).toBeNull();
    const samples = partState<{ sampler: ProgressSamplerState }>(snapshot, 'diag.blockage').sampler.mus;
    expect(samples).toHaveLength(1);
    expect(samples[0].slice(0, 2)).toEqual([w.mu.id, w.mu.generation]);
    expect(muRecords(snapshot).some(mu => mu.id === w.mu.id && mu.generation === w.mu.generation)).toBe(false);
  } finally { w.dispose(); }
});

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: a cut after the sampled MU was consumed continues exactly`, async () => {
    await assertContinuation({ buildWorld: () => sampledMUWorld(2.2, true), mode, T: 2.25, TPrime: 3, T2: 6 });
  });
}

import type { RVTransportSurface } from '../../src/core/engine/rv-transport-surface';

it('detached final travel is credited exactly once without a live MU or visual', () => {
  const node = new Object3D(); node.name = 'SampleSurface';
  const surface = { node } as RVTransportSurface;
  const mu = { aabb: { center: new Vector3() }, currentSurface: surface } as unknown as RVMovingUnit;
  const transport = { mus: [mu], surfaces: [surface], sinks: [] };
  const opts = { fleet: { all: () => [] }, transport, clock: { now: () => 0 }, running: () => true };
  const a = new ProgressWiring(opts);
  const b = new ProgressWiring({ ...opts, transport: { ...transport, mus: [] } });
  try {
    mu.aabb.center.set(0.1, 0.2, 0.3);
    a.retireMU(mu, { id: 2, gen: 3 });
    transport.mus = [];
    const saved = JSON.parse(JSON.stringify(a.snapshotState(() => null))) as ProgressSamplerState;
    const ledger = structuredClone(a.ledger.snapshotState());
    // Slot reuse and disposal must not mutate the saved final position.
    mu.aabb.center.set(100, 200, 300);
    b.validateSnapshot(saved);
    b.ledger.restoreState(ledger);
    b.restoreSnapshot(saved, (id, gen) => {
      expect([id, gen]).toEqual([2, 3]);
      return null;
    });
    a.sample(); b.sample();
    expect(b.ledger.snapshotState()).toEqual(a.ledger.snapshotState());
    const once = b.ledger.snapshotState();
    b.sample();
    expect(b.ledger.snapshotState()).toEqual(once);
  } finally { a.dispose(); b.dispose(); }
});
