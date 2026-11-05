// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// plan-2241 Phase 2: the progress ledger is fed by the components' own push (tests 9.4, 9.7,
// 9.8, 9.16). Units are registered at bind, seeded from both lifecycle stamps, re-seeded after
// every ledger reset, and a batch needs no sample and no finalisation.

import { afterEach, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { BlockageWatch } from '../../src/core/diagnostics/rv-blockage-watch';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { clearAllProblems } from '../../src/core/hmi/problems-store';
import { DESRunner } from '../../src/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { bindDes, clearShared, makeAgvRoot, makeHost } from '../helpers/agv-harness';

afterEach(() => clearAllProblems());

type Diag = { progressLedger: ProgressLedger | null; waitRegistry: WaitRegistry | null };

/** A real scene line; `diag` puts a ledger + wait registry on the host before the first start. */
function line(parts: Array<[string, Record<string, unknown>]>, links: Array<[number, number]>, diag = true, idleSec = 10) {
  const scene = new Scene();
  const nodes = parts.map(([type, props], i) => {
    const node = new Object3D(); node.name = `${type}${i}`;
    node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  });
  const f = runnerFixture(scene);
  const c = nodes.map(n => f.components.find(x => x.node === n)!);
  for (const [a, b] of links) { c[a].nextComponents.push(c[b]); c[b].previousComponents.push(c[a]); }
  f.manager.statResetTime = 0;
  const ledger = new ProgressLedger({ clock: { now: () => f.manager.currentTime } });
  const registry = new WaitRegistry();
  const budgets = new BudgetResolver({ defaults: { MaxIdleSec: idleSec, WarmupSec: 0 } });
  const host = f.host as typeof f.host & Diag;
  Object.assign(host, diag ? { progressLedger: ledger, waitRegistry: registry } : { progressLedger: null, waitRegistry: null });
  const watch = new BlockageWatch(() => ({ ledger: host.progressLedger!, registry, budgets, now: f.manager.currentTime }));
  const topology = { root: scene, host };
  f.runner.start([], topology);
  return { ...f, scene, c, ledger, registry, watch, host, topology,
    runUntil(time: number) { while (f.manager.currentTime < time) f.manager.processAnimated(Math.min(0.5, time - f.manager.currentTime)); },
    ff: (time: number) => f.runner.runFastForward({ untilSimTime: time }),
  };
}
const SOURCE: [string, Record<string, unknown>] = ['Source', { Interval: 10 }];
const cleanLine = (diag = true) => line([SOURCE, ['Station', { ProcessingTime: 5 }], ['Sink', {}]], [[0, 1], [1, 2]], diag);
const units = (f: { c: MaterialFlowAdapter[] }) => f.c.map(a => a.progressUnitId);
/** The ledger as the lifecycle says it must be: armed from the progress stamp, else inactive. */
function expectSeeded(ledger: ProgressLedger, adapters: readonly MaterialFlowAdapter[]) {
  for (const a of adapters) {
    const e = ledger.entry(a.progressUnitId);
    expect(e, `${a.progressUnitId} registered`).not.toBeNull();
    const armed = a.progressArmedSince === a.progressArmedSince;
    expect(e!.state, a.progressUnitId).toBe(armed ? 'armed' : 'inactive');
    if (armed) expect(e!.lastChangeSec, a.progressUnitId).toBe(a.lastProgressSec);
  }
}
function expectCoverage(ledger: ProgressLedger, n: number) {
  const { coverage } = ledger.sample(0, undefined, true);
  expect(coverage).toMatchObject({ expected: n, registered: n, missing: [], unknown: [], coverageComplete: true });
}

// ── 9.8 Batch without finalisation ──────────────────────────────────────────

it('9.8 FastForward without any sample: a clean line has no finding, every unit registered', async () => {
  const f = cleanLine();
  expect(await f.ff(2000)).toBe(true);
  const report = f.watch.inspect();
  expect(report.findings).toEqual([]);
  expect(report.coverage).toMatchObject({ expected: 3, registered: 3, missing: [], coverageComplete: true });
  expectSeeded(f.ledger, f.c);
  expect(f.ledger.adapterSources()).toEqual([]);           // no sampling adapter for DES units
});

it('9.8 FastForward without any sample: a station blocked at a full buffer is a stall', async () => {
  const f = line([SOURCE, ['Station', { ProcessingTime: 1 }], ['Storage', { MaxCapacity: 1 }]], [[0, 1], [1, 2]]);
  expect(await f.ff(200)).toBe(true);
  const station = f.c[1];
  expect(station.progressArmedSince).toBeLessThan(20);          // blocked behind the full buffer early on
  const stalls = f.watch.inspect().findings.filter(x => x.cls === 'stall').map(x => x.waiterId);
  expect(stalls).toContain(station.progressUnitId);
});

it('9.8 FastForward without any sample: two stations feeding each other are a deadlock', async () => {
  // Stations, not buffers: an empty pass-through pair would bounce one MU back and forth at t = 0.
  // The source keeps events (and so the batch clock) going while the pair is stuck.
  const f = line([['Station', { ProcessingTime: 1 }], ['Station', { ProcessingTime: 1 }], SOURCE], [[0, 1], [1, 0], [2, 0]]);
  expect(await f.ff(200)).toBe(true);
  const report = f.watch.inspect();
  const deadlocks = report.findings.filter(x => x.cls === 'deadlock');
  expect(deadlocks).toHaveLength(1);
  expect([...new Set(deadlocks[0].chain.filter((_, i) => i % 2 === 0))].sort()).toEqual(units(f).slice(0, 2).sort());
});

// ── 9.7 Parity / determinism ────────────────────────────────────────────────

it('9.7 the same run with and without the bound check is identical (events, statistics, queue, time)', async () => {
  const runs = [true, false].map(diag => line([SOURCE, ['Station', { ProcessingTime: 12 }], ['Storage', { MaxCapacity: 2 }],
    ['Station', { ProcessingTime: 4 }], ['Sink', {}]], [[0, 1], [1, 2], [2, 3], [3, 4]], diag));
  for (const f of runs) { f.runUntil(137); expect(await f.ff(5000)).toBe(true); }
  const [bound, free] = runs;
  expect(bound.ledger.sample(0, undefined, true).coverage.registered).toBe(5);
  expect(free.ledger.sample(0, undefined, true).coverage.registered).toBe(0);
  expect(bound.manager.totalEventsProcessed).toBe(free.manager.totalEventsProcessed);
  expect(bound.manager.currentTime).toBe(free.manager.currentTime);
  expect(JSON.stringify(bound.runner.statistics())).toBe(JSON.stringify(free.runner.statistics()));
  // The snapshot carries queue, components, MUs and RNG (no diag part: no watch on the host).
  expect(bound.runner.snapshotJson()).toBe(free.runner.snapshotJson());
});

// ── 9.16 Re-registration ────────────────────────────────────────────────────

it('9.16 consumer attach: a late bind seeds from both stamps (armed since 0, progress 90, attach at 100)', () => {
  const f = line([['Storage', { MaxCapacity: 3 }], ['Sink', {}]], [], false);
  const buffer = f.c[0];
  buffer.acceptMU(f.runner.createMU());                 // armed since 0, nothing leaves
  f.runUntil(90);
  buffer.acceptMU(f.runner.createMU());
  buffer.recordOutput(1);                               // progress at 90
  f.runUntil(100);
  expect([buffer.progressArmedSince, buffer.lastProgressSec]).toEqual([0, 90]);
  Object.assign(f.host, { progressLedger: f.ledger, waitRegistry: f.registry });
  (f.runner as unknown as { _bindDiagnostics(t: unknown): void })._bindDiagnostics(f.topology);
  expect(f.ledger.entry(buffer.progressUnitId)).toMatchObject({ state: 'armed', lastChangeSec: 90 });
  expectSeeded(f.ledger, f.c);
  expectCoverage(f.ledger, 2);
  const stall = f.watch.inspect().findings.find(x => x.waiterId === buffer.progressUnitId);
  expect(stall).toMatchObject({ cls: 'stall', idleSec: 10 });
});

it('9.16 mode switch: a ledger reset AFTER the DES start re-seeds every unit at once', () => {
  const f = cleanLine();
  f.runUntil(23);
  f.ledger.reset();                                     // onModeChanged: ProgressWiring.reset() after start
  expectSeeded(f.ledger, f.c);
  expectCoverage(f.ledger, 3);
  f.runUntil(31);                                       // and the push goes on into the same entries
  expectSeeded(f.ledger, f.c);
});

it('9.16 viewer reset: a ledger reset BEFORE the executor reset ends seeded from the restarted run', () => {
  const f = cleanLine();
  f.runUntil(23);
  f.ledger.reset();                                     // resetSimulation: ledger first ...
  f.runner.reset();                                     // ... then the executor
  expectSeeded(f.ledger, f.c);
  expectCoverage(f.ledger, 3);
  expect(f.ledger.entry(f.c[1].progressUnitId)).toMatchObject({ state: 'armed', lastChangeSec: 0 });
});

it('9.16 ledger replacement: the next start binds the new ledger and releases the old one', () => {
  const f = cleanLine();
  f.runUntil(23);
  const old = f.ledger;
  const fresh = new ProgressLedger({ clock: { now: () => f.manager.currentTime } });
  f.host.progressLedger = fresh;
  f.runner.reset();
  expectSeeded(fresh, f.c);
  expectCoverage(fresh, 3);
  expect(old.sample(0, undefined, true).coverage).toMatchObject({ expected: 0, registered: 0 });
  f.runUntil(40);
  for (const id of units(f)) expect(old.entry(id)).toBeNull();
});

it('9.16 repeated batch resets: each run is seeded and complete without one sample', async () => {
  const f = cleanLine();
  const seen: string[] = [];
  for (const until of [300, 50, 777]) {
    f.runner.reset();
    expect(await f.ff(until)).toBe(true);
    expectSeeded(f.ledger, f.c);
    expectCoverage(f.ledger, 3);
    seen.push(JSON.stringify(f.ledger.snapshotState().entries.map(([id, e]) => [id, e.state, e.lastChangeSec])));
  }
  f.runner.reset(); expect(await f.ff(300)).toBe(true);
  expect(JSON.stringify(f.ledger.snapshotState().entries.map(([id, e]) => [id, e.state, e.lastChangeSec]))).toBe(seen[0]);
});

it('9.16 a late addInstance is registered and pushed immediately', () => {
  const f = cleanLine();
  f.runUntil(5);
  const node = new Object3D(); node.name = 'Late'; f.scene.add(node);
  bindDes(f.runner, node, makeHost(), f.c[2].def);
  const late = f.runner.liveInstances.at(-1)!.adapter;
  expect(late.node).toBe(node);
  expect(f.ledger.entry(late.progressUnitId)).toMatchObject({ state: 'inactive' });
  late.recordOutput(1);
  expect(f.ledger.entry(late.progressUnitId)).toMatchObject({ count: 1, lastChangeSec: late.lastProgressSec });
});

// ── Decision 8, ledger half: restore validation ─────────────────────────────

function watched(f: ReturnType<typeof line> = cleanLine()) {
  Object.assign(f.host, { blockageWatch: f.watch });
  return f;
}
const stallLine = () => line([SOURCE, ['Station', { ProcessingTime: 1 }], ['Storage', { MaxCapacity: 1 }]], [[0, 1], [1, 2]]);
type SavedDiag = { pushed?: boolean; ledger: { entries: Array<[string, { state: string; lastChangeSec: number }]> } };
const savedDiag = (snap: DESSnapshotV4) => snap.parts.find(p => p.key === 'diag.blockage')!.state as SavedDiag;

it('restore: a pushed ledger restores literally into a fresh world', () => {
  const a = watched(); a.runUntil(23);
  const saved = a.runner.fullSnapshot();
  const b = watched(); b.runUntil(7);
  b.runner.restoreFull(saved);
  expect(b.ledger.snapshotState().entries).toEqual(a.ledger.snapshotState().entries);
  a.runUntil(60); b.runUntil(60);
  expect(b.ledger.snapshotState().entries).toEqual(a.ledger.snapshotState().entries);
});

it('restore: a pushed ledger that disagrees with the component lifecycle is refused before any mutation', () => {
  const a = watched(); a.runUntil(23);
  const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot())) as DESSnapshotV4;
  const diag = saved.parts.find(p => p.key === 'diag.blockage')!.state as { ledger: { entries: Array<[string, { lastChangeSec: number }]> } };
  const station = diag.ledger.entries.find(([id]) => id === a.c[1].progressUnitId)!;
  station[1].lastChangeSec -= 1;
  const b = watched(); b.runUntil(7);
  const before = b.runner.snapshotJson();
  expect(() => b.runner.restoreFull(saved)).toThrow();
  expect(b.manager.currentTime).toBe(7);
  expect(b.runner.snapshotJson()).toBe(before);
});

it('restore: a sampled (pre-push) ledger is normalised to the component lifecycle', () => {
  const a = watched(); a.runUntil(23);
  const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot())) as DESSnapshotV4;
  const diag = saved.parts.find(p => p.key === 'diag.blockage')!.state as { pushed?: boolean;
    ledger: { entries: Array<[string, { state: string; lastChangeSec: number }]> } };
  delete diag.pushed;
  const station = diag.ledger.entries.find(([id]) => id === a.c[1].progressUnitId)!;
  station[1].lastChangeSec = 22; station[1].state = 'inactive';  // what a sampler could have seen
  const b = watched();
  b.runner.restoreFull(saved);
  expectSeeded(b.ledger, b.c);
});

// Codex review of Phase 2 [high]: a ledger without rows must not leave bound units unregistered.
it('restore: an empty sampler-era ledger (captured right after a mode switch) registers every bound unit; a later stall is found', () => {
  const a = watched(stallLine()); a.runUntil(5);
  const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot())) as DESSnapshotV4;
  const diag = savedDiag(saved);
  delete diag.pushed; diag.ledger.entries = [];            // ProgressWiring.reset() after the DES start, no sample yet
  const b = watched(stallLine()); b.runUntil(2);
  b.runner.restoreFull(saved);
  expectSeeded(b.ledger, b.c);
  expectCoverage(b.ledger, 3);
  b.runUntil(200);
  expect(b.watch.inspect().findings.filter(x => x.cls === 'stall').map(x => x.waiterId)).toContain(b.c[1].progressUnitId);
});

it('restore: a pushed ledger without a row for a bound unit is refused before any mutation', () => {
  const a = watched(); a.runUntil(23);
  const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot())) as DESSnapshotV4;
  const diag = savedDiag(saved);
  expect(diag.pushed).toBe(true);
  diag.ledger.entries = diag.ledger.entries.filter(([id]) => id !== a.c[1].progressUnitId);
  const b = watched(); b.runUntil(7);
  const before = b.runner.snapshotJson();
  expect(() => b.runner.restoreFull(saved)).toThrow(/no ledger entry for des:Station1/);
  expect(b.runner.snapshotJson()).toBe(before);
});

it('a push for a unit the ledger dropped re-registers it, seeded from the stamps (never goes nowhere)', () => {
  const f = cleanLine();
  f.runUntil(23);
  const station = f.c[1];
  f.ledger.unregister(station.progressUnitId);
  f.runUntil(31);                                       // the station's next arm/bump/idle pushes
  expectSeeded(f.ledger, f.c);
  expectCoverage(f.ledger, 3);
});

// ── 9.4 AGV / fleet ─────────────────────────────────────────────────────────

async function agvWorld(names: [string, string] = ['V', 'W']) {
  clearShared();
  const net = getDefaultPathNetwork();
  for (const id of ['A', 'C']) net.register(parsePathExtras({ type: 'Path', id,
    segments: [{ kind: 'line', from: [id === 'A' ? 0 : 10, 0, 0], to: [id === 'A' ? 0 : 10, 0, 3] }], successors: [] }, id)!);
  net.resolveGraph();
  const docks = getDefaultPathDockRegistry();
  for (const id of ['A', 'C']) docks.register(id, { onVehicleArrive: () => {} });   // a stay that never ends
  const runner = new DESRunner({ subMode: 'animated' });
  const agvHost = makeHost();
  const scene = new Scene();
  const roots = [makeAgvRoot(names[0], { PathId: 'A', StartPosition: 0, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false }),
    makeAgvRoot(names[1], { PathId: 'C', StartPosition: 0, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false })];
  for (const r of roots) { scene.add(r); bindDes(runner, r, agvHost); }
  const manager = runner.getManager();
  const wiring = new ProgressWiring({ clock: { now: () => manager.currentTime }, running: () => true,
    fleet: { all: () => getDefaultAgvFleet().all() }, transport: { surfaces: [], sinks: [], mus: [] } as never,
    adapters: { surface: false, sink: false } });
  const budgets = new BudgetResolver({ defaults: { MaxIdleSec: 10, WarmupSec: 0 } });
  const host = { ...agvHost, progressLedger: wiring.ledger, waitRegistry: wiring.waitRegistry };
  runner.start([], { root: scene, host: host as never });
  await runner.kpiSourcesReady();                         // a host run waits for its KPI sources first
  // The DES clock stands between events; the inspection reads the rendered sim time like the viewer.
  const watch = new BlockageWatch(() => ({ ledger: wiring.ledger, registry: wiring.waitRegistry, budgets, now: runner.renderClock }));
  const adapters = runner.liveInstances.map(i => i.adapter);
  const tick = () => { runner.tick(0.1); runner.lateTick(0.1); };
  return { runner, manager, wiring, watch, adapters, fleet: getDefaultAgvFleet(),
    advance(seconds: number) { for (let i = 0; i < seconds * 10; i++) tick(); },
    dispose() { runner.dispose(); wiring.dispose(); clearShared(); } };
}

it('9.4 a DES AGV is one ledger unit des:<path>: armed with a task, stalled at an endless stay, idle without', async () => {
  const w = await agvWorld();
  try {
    const [v] = w.adapters;
    expect(v.progressUnitId).toBe('des:V');
    w.advance(2);
    expect(w.wiring.ledger.entry('des:V')).toMatchObject({ state: 'inactive' });   // cruising, no task
    w.fleet.get('V')!.assign({ destination: 'A' });
    w.advance(1);
    const armedAt = v.progressArmedSince;
    expect(armedAt).toBe(armedAt);                            // armed (not NaN), stamped in DES time
    expect(w.wiring.ledger.entry('des:V')).toMatchObject({ state: 'armed', lastChangeSec: armedAt });
    w.wiring.sample();                                        // the core sampler skips DES-bound vehicles
    expect(w.wiring.ledger.entry('V')).toBeNull();
    expectCoverage(w.wiring.ledger, 2);
    expect(w.wiring.ledger.sample(0, undefined, true).coverage.bySource).toEqual({ des: 2, fleet: 0, sinks: 0, surfaces: 0 });
    w.advance(20);
    expect(w.watch.inspect().findings.filter(f => f.cls === 'stall').map(f => f.waiterId)).toEqual(['des:V']);
    w.fleet.get('V')!.clear();
    w.advance(1);
    expect(w.wiring.ledger.entry('des:V')).toMatchObject({ state: 'inactive' });
  } finally { w.dispose(); }
});

it('9.4 traffic edges in fleet ids resolve to des:<path>: two AGVs waiting on each other are a deadlock', async () => {
  const w = await agvWorld();
  try {
    w.fleet.get('V')!.assign({ destination: 'A' });
    w.fleet.get('W')!.assign({ destination: 'C' });
    // Zone-holder edges as the movement authority reports them: waiter and holder are fleet ids.
    w.wiring.waitRegistry.addSource({ id: 'zones-test', vehicles: true, edges: () => [
      { waiterId: 'V', resourceId: 'Z1', ownerIds: ['W'], kind: 'zone-holder', sinceSimSec: 1, analysed: true },
      { waiterId: 'W', resourceId: 'Z2', ownerIds: ['V'], kind: 'zone-holder', sinceSimSec: 1, analysed: true },
      // A drop target occupied by an MU keeps its MU owner id (plan-2243 owns the endpoint domain).
      { waiterId: 'V', resourceId: 'drop', ownerIds: ['17'], ownerMUs: true, kind: 'fleet:target', sinceSimSec: 1, analysed: true },
    ] });
    w.advance(25);
    const edges = w.wiring.waitRegistry.collect(w.manager.currentTime, true);
    expect(edges.map(e => [e.waiterId, e.ownerIds])).toEqual(expect.arrayContaining([
      ['des:V', ['des:W']], ['des:W', ['des:V']], ['des:V', ['17']]]));
    const findings = w.watch.inspect().findings;
    expect(findings.filter(f => f.cls === 'deadlock')).toHaveLength(1);
    expect(findings[0].chain).toEqual(['des:V', 'Z1', 'des:W', 'Z2', 'des:V']);
  } finally { w.dispose(); }
});

// Codex review of Phase 2 [medium]: endpoints resolve by their domain, never by the look of the id.
it('9.4 a numeric vehicle id equal to the blocking MU id: no self-edge, no deadlock', async () => {
  const w = await agvWorld(['17', 'W']);
  try {
    w.fleet.get('17')!.assign({ destination: 'A' });
    // A drop wait as the job runner reports it: the owner is the occupying MU 17, not vehicle 17.
    w.wiring.waitRegistry.addSource({ id: 'fleet-test', vehicles: true, edges: () => [
      { waiterId: '17', resourceId: 'drop', ownerIds: ['17'], ownerMUs: true, kind: 'fleet:target', sinceSimSec: 1, analysed: true },
    ] });
    w.advance(25);
    const edges = w.wiring.waitRegistry.collect(w.manager.currentTime, true);
    expect(edges.map(e => [e.waiterId, e.ownerIds])).toEqual([['des:17', ['17']]]);
    expect(w.watch.inspect().findings.filter(f => f.cls === 'deadlock')).toEqual([]);
  } finally { w.dispose(); }
});

it('9.4 the fleet wait source declares vehicle endpoints and marks an MU-occupied drop', async () => {
  const { WaitWatch } = await import('../../src/core/fleet/exec/wait-watch');
  const { ContinuousSimClock } = await import('../../src/core/fleet/core/sim-clock');
  const watch = new WaitWatch({ clock: new ContinuousSimClock(), defaultLimitSec: 60, problems: { report() {}, clear() {} } });
  expect(watch.vehicles).toBe(true);
  watch.setResolver({ valid: () => true, detail: () => ({ waitingFor: 'drop', waiterId: '17', resourceId: 'drop', ownerIds: ['17'], ownerMUs: true }) });
  watch.begin('17', 'target');
  expect(watch.edges(0)).toEqual([expect.objectContaining({ waiterId: '17', ownerIds: ['17'], ownerMUs: true })]);
});
