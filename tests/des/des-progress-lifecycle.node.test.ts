// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// plan-2241 Phase 1: event-driven progress lifecycle of DES components (tests 9.1-9.3,
// 9.5, 9.9, 9.14, 9.15). The fields are diagnosis state: stamped at the transition, in
// sim time, independent of statistics resets, silent and literal across a restore.

import { expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import '../../src/behaviors/Conveyor';
import '../../src/behaviors/ChainTransfer';
import type { DESComponent } from '../../src/plugins/des/rv-des-component';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import type { DESMU } from '../../src/plugins/des/rv-des-mu';
import type { MU } from '../../src/core/material-flow/material-flow-self';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import { lineFixture, runnerFixture } from './runner-fixture';
import { flow, transferFixture } from './phase2-transfer-fixture';
import * as binding from '../../src/plugins/des/des-scene-binding';
import { getDefaultAgvFleet, type AgvHandle } from '../../src/core/engine/rv-agv-fleet';

type Ev = [string, number] | [string, number, number];
/** Record every publication of the lifecycle (the future ledger push, plan-2241 F5). */
function record(c: DESComponent): Ev[] {
  const ev: Ev[] = [];
  (c as unknown as { onProgress: unknown }).onProgress =
    (kind: string, at: number, n?: number) => { ev.push(n === undefined ? [kind, at] : [kind, at, n]); };
  return ev;
}
const lc = (c: DESComponent) => ({ since: c.progressArmedSince, last: c.lastProgressSec });
const partState = (snap: DESSnapshotV4, c: MaterialFlowAdapter) =>
  snap.parts.find(p => p.key === c.desId)!.state as Record<string, unknown>;

// ── 9.1 Station / buffer ────────────────────────────────────────────────────

it('9.1 stamps arm/idle/bump in sim time; a late first arrival is armed from its arrival', () => {
  const f = transferFixture([{ type: 'Station', props: { ProcessingTime: 1 } }, { type: 'Storage', props: { MaxCapacity: 1 } }]);
  const [station, buffer] = f.parts;
  const ev = record(station);
  f.advance(95);
  expect(lc(station)).toEqual({ since: NaN, last: NaN });
  expect(station.acceptMU(f.runner.createMU())).toBe(true);
  // First arrival at 95 s: armed since 95, not since 0 (no false alarm with a 12 s budget at 100 s).
  expect(lc(station)).toEqual({ since: 95, last: 95 });
  f.advance(96);
  expect(lc(station)).toEqual({ since: NaN, last: 96 });
  expect(lc(buffer)).toEqual({ since: 96, last: 96 });
  expect(ev).toEqual([['arm', 95], ['idle', 96], ['bump', 96, 1]]);
});

it('9.1 a blockage keeps its wait age across a warm-up statistics reset', () => {
  const f = transferFixture([{ type: 'Station', props: { ProcessingTime: 1 } }, { type: 'Storage', props: { MaxCapacity: 1 } }]);
  const [station] = f.parts;
  expect(station.acceptMU(f.runner.createMU())).toBe(true);
  f.advance(92);                         // first MU fills the buffer at 1 s
  expect(station.acceptMU(f.runner.createMU())).toBe(true);
  f.advance(95);                         // second MU finished at 93 s, blocked since then
  station.resetStatistics();             // warm-up reset at 95 s
  expect(station.statAccumulators().stateStartTime).toBe(95);
  expect(lc(station)).toEqual({ since: 92, last: 92 });
  expect(station.waitEdges(95)).toEqual([expect.objectContaining({ kind: 'des-exit', sinceSimSec: 93 })]);
});

// ── 9.2 Source with a pending MU ─────────────────────────────────────────────

it('9.2 a source holding a pending MU is armed from that moment and idle once it flushed', () => {
  const f = lineFixture({ stationProcessTime: 25, interArrivalTime: 10 });
  const ev = record(f.source);
  f.runUntil(29);
  // 0 s (inside start, before the recorder): MU1 to the station; 10 s: heartbeat spawns
  // MU2, station busy -> pending; 25 s: the station frees, the source flushes MU2 -> idle.
  expect(ev).toEqual([['arm', 10], ['bump', 25, 1], ['idle', 25]]);
  expect(lc(f.source)).toEqual({ since: NaN, last: 25 });
});

// ── 9.3 Reset separation ─────────────────────────────────────────────────────

it('9.3 a statistics reset leaves the lifecycle alone; clearMUState resets it; the next start re-arms', () => {
  const f = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  f.runUntil(3);
  expect(lc(f.station)).toEqual({ since: 0, last: 0 });
  for (const c of f.components) c.resetStatistics();
  expect(lc(f.station)).toEqual({ since: 0, last: 0 });
  const ev = record(f.station);
  f.station.clearMUState();                 // the run reset of one component (E-A)
  expect(ev).toEqual([['idle', 3]]);
  expect(lc(f.station)).toEqual({ since: NaN, last: NaN });
  // runner.reset() = clearMUs + start: the restart's first hand-over arms the station at 0 again.
  f.runner.reset();
  expect(ev).toEqual([['idle', 3], ['arm', 0]]);
  expect(lc(f.station)).toEqual({ since: 0, last: 0 });
});

// ── 9.5 Snapshot ────────────────────────────────────────────────────────────

it('9.5 the lifecycle is captured (null = not armed), restored literally in a fresh world', () => {
  const a = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  a.runUntil(23);
  const saved = a.snapshot();
  expect(partState(saved, a.station)).toMatchObject({ progressArmedSince: 20, lastProgressSec: 20 });
  expect(partState(saved, a.sink)).toMatchObject({ progressArmedSince: null, lastProgressSec: 20 });
  const b = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  b.runUntil(7);
  b.runner.restoreJson(JSON.stringify(saved));
  for (const [x, y] of [[a.source, b.source], [a.station, b.station], [a.sink, b.sink]]) expect(lc(y)).toEqual(lc(x));
  a.runUntil(40); b.runUntil(40);
  expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson());
});

it('9.5 an older snapshot without the fields gets the deterministic default', () => {
  const a = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  a.runUntil(23);
  const legacy = JSON.parse(JSON.stringify(a.snapshot())) as DESSnapshotV4;
  for (const part of legacy.parts) {
    const s = part.state as Record<string, unknown>;
    if (s && typeof s === 'object' && 'currentStateName' in s) { delete s.progressArmedSince; delete s.lastProgressSec; delete s.categorySince; }
  }
  const b = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  b.runner.restoreJson(JSON.stringify(legacy));
  expect(lc(b.station)).toEqual({ since: 23, last: 23 });   // armed: snapshot time
  expect(lc(b.sink)).toEqual({ since: NaN, last: NaN });     // never armed
});

it('9.5/9.9 an inconsistent or incomplete lifecycle is refused before any mutation', () => {
  const a = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  a.runUntil(23);
  const saved = a.snapshot();
  const b = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  b.runUntil(7);
  const before = b.runner.snapshotJson();
  const bad = JSON.parse(JSON.stringify(saved)) as DESSnapshotV4;
  partState(bad, a.station).progressArmedSince = null;           // station holds an MU: must be armed
  expect(() => b.runner.restoreJson(JSON.stringify(bad))).toThrow();
  const half = JSON.parse(JSON.stringify(saved)) as DESSnapshotV4;
  delete partState(half, a.station).lastProgressSec;
  expect(() => b.runner.restoreJson(JSON.stringify(half))).toThrow();
  expect(b.runner.snapshotJson()).toBe(before);
});

// ── 9.9 Silent restore ──────────────────────────────────────────────────────

it('9.9 a restore publishes nothing, also not from _prepareSnapshotApply', () => {
  const a = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  a.runUntil(23);
  const saved = a.snapshot();
  const b = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  b.runUntil(7);
  const evs = b.components.map(record);
  b.restore(saved);
  expect(evs.flat()).toEqual([]);
  b.runUntil(26);                         // the restored run publishes again
  expect(evs.flat().length).toBeGreaterThan(0);
});

// ── 9.14 Mutator coverage ───────────────────────────────────────────────────

it('9.14 setState: a real category change transitions, an idempotent call does not', () => {
  const f = transferFixture([{ type: flow() }]);
  const [c] = f.parts;
  const ev = record(c);
  c.setState('Blocked'); c.setState('Blocked');
  f.advance(3);
  c.setState('Empty'); c.setState('Empty');
  expect(ev).toEqual([['arm', 0], ['idle', 3]]);
});

it('9.14 a source whose demand is refused before the spawn is never armed', () => {
  const scene = new Scene();
  for (const [name, props] of [['Source', { AutomaticGeneration: false }], ['Station', { ProcessingTime: 5 }]] as const) {
    const node = new Object3D(); node.name = name; node.userData.realvirtual = { [name]: props }; scene.add(node);
  }
  const f = runnerFixture(scene);
  const [source, station] = ['Source', 'Station'].map(n => f.components.find(c => c.node.name === n)!);
  source.nextComponents = [station]; station.previousComponents = [source];
  f.runner.start([], { root: scene, host: f.host });
  const ev = record(source);
  f.manager.processAnimated(30);
  expect(ev).toEqual([]);
  expect(lc(source)).toEqual({ since: NaN, last: NaN });
});

it('9.14 a quantity-limited source does not arm when it stops spawning', () => {
  const scene = new Scene();
  for (const [name, props] of [['Source', { Interval: 10, LimitNumber: true, MaxNumberMUs: 1 }], ['Station', { ProcessingTime: 25 }]] as const) {
    const node = new Object3D(); node.name = name; node.userData.realvirtual = { [name]: props }; scene.add(node);
  }
  const f = runnerFixture(scene);
  const [source, station] = ['Source', 'Station'].map(n => f.components.find(c => c.node.name === n)!);
  source.nextComponents = [station]; station.previousComponents = [source];
  const ev = record(source);
  f.runner.start([], { root: scene, host: f.host });
  f.manager.processAnimated(30);
  expect(ev).toEqual([['bump', 0, 1]]);
});

it('9.14 terminal completion (no downstream) changes nothing: no transition, no progress', () => {
  const f = transferFixture([{ type: 'Station', props: { ProcessingTime: 1 } }]);
  const [station] = f.parts;
  const ev = record(station);
  expect(station.acceptMU(f.runner.createMU())).toBe(true);
  f.advance(10);
  expect(ev).toEqual([['arm', 0]]);
  expect(lc(station)).toEqual({ since: 0, last: 0 });
});

it('9.14 a refused reservation publishes nothing on holder or target', () => {
  const f = transferFixture([{ type: flow() }, { type: flow() }]);
  const [holder, target] = f.parts;
  expect(holder.acceptMU(f.runner.createMU())).toBe(true);
  expect(target.acceptMU(f.runner.createMU())).toBe(true);   // MaxCapacity 1: full
  const evH = record(holder), evT = record(target);
  expect(() => holder.reserveDownstream(1)).toThrow();
  expect([evH, evT]).toEqual([[], []]);
  expect(lc(holder)).toEqual({ since: 0, last: 0 });
});

function conveyorWorld() {
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name; node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  add('Source', 'Source', { Interval: 10000, AutomaticGeneration: false });
  const root = add('Belt', 'Conveyor');
  const belt = new Mesh(new BoxGeometry(1, 0.1, 1)); belt.name = 'Transport-X';
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(belt, sensor);
  const gateRoot = add('Gate', 'Station', { ProcessingTime: 10000 });
  gateRoot.position.z = 1;
  for (const [owner, name, z] of [[root, 'Snap-ZP-convroll', 0.5], [gateRoot, 'Snap-ZN-convroll', -0.5]] as const) {
    const snap = new Object3D(); snap.name = name; snap.position.z = z; owner.add(snap);
  }
  const f = runnerFixture(scene);
  const [conveyor, gate] = ['Belt', 'Gate'].map(name => f.components.find(c => c.node.name === name)!);
  conveyor.nextComponents = [gate]; gate.previousComponents = [conveyor];
  f.runner.start([], { root: scene, host: f.host });
  return { ...f, conveyor, gate, local: conveyor.self.local as unknown as { blockedMUs: unknown[] } };
}

it('9.14 a Conveyor restored with a parked MU (blockedTarget dropped) keeps its lifecycle, silently', () => {
  const a = conveyorWorld();
  expect(a.gate.acceptMU(a.runner.createMU())).toBe(true);
  expect(a.conveyor.acceptMU(a.runner.createMU())).toBe(true);
  a.manager.processAnimated(100);
  expect(a.local.blockedMUs.length).toBe(1);
  expect(Number.isFinite(a.conveyor.progressArmedSince)).toBe(true);
  const saved = a.runner.fullSnapshot();
  const b = conveyorWorld();
  const evs = b.components.map(record);
  b.runner.restoreFull(saved);
  expect(evs.flat()).toEqual([]);
  expect(b.local.blockedMUs.length).toBe(1);
  expect(lc(b.conveyor)).toEqual(lc(a.conveyor));
  expect(b.conveyor.progressConsistent()).toBe(true);
});

it('9.14 ChainTransfer DES release: armed while it holds the part, idle with one bump at the release', () => {
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name; node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  const root = add('Transfer', 'ChainTransfer');
  for (const name of ['Transport-Z', 'Transport-X']) { const m = new Mesh(new BoxGeometry(1, 0.1, 1)); m.name = name; root.add(m); }
  for (const name of ['Sensor', 'Drive-Lin-Y']) { const n = new Object3D(); n.name = name; root.add(n); }
  const sinkRoot = add('Out', 'Sink'); sinkRoot.position.z = 1;
  for (const [owner, name, z] of [[root, 'Snap-ZP-convroll', 0.5], [sinkRoot, 'Snap-ZN-convroll', -0.5]] as const) {
    const snap = new Object3D(); snap.name = name; snap.position.z = z; owner.add(snap);
  }
  const f = runnerFixture(scene);
  const [transfer, sink] = ['Transfer', 'Out'].map(name => f.components.find(c => c.node.name === name)!);
  transfer.nextComponents = [sink]; sink.previousComponents = [transfer];
  f.runner.start([], { root: scene, host: f.host });
  const ev = record(transfer);
  expect(transfer.acceptMU(f.runner.createMU())).toBe(true);
  f.manager.processAnimated(100);
  expect(ev.map(e => e[0])).toEqual(['arm', 'idle', 'bump']);
  expect(ev[0][1]).toBe(0);
  expect(ev[1][1]).toBe(ev[2][1]);
  expect(ev[1][1]).toBeGreaterThan(0);
});

// ── 9.15 Commit accounting and silent restore ────────────────────────────────

it('9.15 a failed normal accept publishes no tentative arm/idle on the target', () => {
  const f = transferFixture([{ type: flow() }, { type: flow({ des: { onAccept: () => false } }) }]);
  const [sender, target] = f.parts;
  const evS = record(sender), evT = record(target);
  const mu = f.runner.createMU();
  expect(sender.acceptMU(mu)).toBe(true);
  expect(sender.transferMU(mu)).toBe('blocked');
  expect(evT).toEqual([]);
  expect(evS).toEqual([['arm', 0]]);
  expect(lc(target)).toEqual({ since: NaN, last: NaN });
});

it('9.15 a rolled-back pose hand-over: no progress, no lifecycle change; a nested success survives', () => {
  let nested: (() => void) | null = null;
  const f = transferFixture([
    { type: flow() },
    { type: flow({ des: { acceptsPose: true, onAccept: () => { nested?.(); return false; } } }) },
    { type: flow() }, { type: flow() },
  ]);
  const [owner, target, x] = f.parts;
  const mu = f.runner.createMU(), other = f.runner.createMU();
  expect(owner.acceptMU(mu)).toBe(true);
  expect(x.acceptMU(other)).toBe(true);
  const evO = record(owner), evX = record(x);
  f.advance(4);
  nested = () => { nested = null; expect(x.transferMU(other)).toBe('moved'); };
  const processed = owner.totalProcessed;
  const r = (target as MaterialFlowAdapter).transferInWithPose(owner, mu as DESMU, {} as never);
  expect(r).toMatchObject({ ok: false, reason: 'rolled-back' });
  expect(owner.totalProcessed).toBe(processed + 1);          // KPI unchanged versus main
  expect(evO).toEqual([]);                                     // no idle, no arm, no bump
  expect(lc(owner)).toEqual({ since: 0, last: 0 });
  expect(evX).toEqual([['idle', 4], ['bump', 4, 1]]);          // the nested success is booked
});

it('9.15 a reservation batch rolled back by the target books nothing', () => {
  const f = transferFixture([{ type: flow() }, { type: flow({ des: { onAccept: () => false } }) }]);
  const [holder, target] = f.parts;
  const mu = f.runner.createMU();
  expect(holder.acceptMU(mu)).toBe(true);
  const evH = record(holder), evT = record(target);
  f.advance(2);
  const reservation = holder.reserveDownstream(1);
  expect(reservation.commitMany([mu as unknown as MU])).toBe(false);
  expect([evH, evT]).toEqual([[], []]);
  expect(lc(holder)).toEqual({ since: 0, last: 0 });
  expect(lc(target)).toEqual({ since: NaN, last: NaN });
});

it('9.15 a retry that blocks again keeps the wait age of the blocked exit', () => {
  const f = transferFixture([{ type: flow() }, { type: flow() }]);
  const [sender, target] = f.parts;
  expect(target.acceptMU(f.runner.createMU())).toBe(true);
  const mu = f.runner.createMU();
  expect(sender.acceptMU(mu)).toBe(true);
  expect(sender.transferMU(mu)).toBe('blocked');
  f.advance(5);
  sender.onDownstreamReady(target);                            // target still full
  expect(sender.waitEdges(5)).toEqual([expect.objectContaining({ kind: 'des-exit', sinceSimSec: 0 })]);
});

it('9.15 participant commits before des.apply reach no consumer and are not replayed', () => {
  const a = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  const b = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  for (const f of [a, b]) {
    const station = f.station;
    f.runner.registerSnapshotProvider('test.mutator', () => [{
      key: 'test.mutator', version: 1, owner: {}, stateKeys: [], services: [],
      capture: () => 0, validate: () => [], prepare: (json: unknown) => json,
      // A participant commit that touches a component (like swapState / handover rewiring).
      commit: () => { station.setState('Blocked'); station.setState('Failure'); },
    }] as never);
  }
  a.runUntil(23);
  const saved = a.snapshot();
  b.runUntil(7);
  const evs = b.components.map(record);
  b.restore(saved);
  expect(evs.flat()).toEqual([]);
  expect(Number.isFinite(b.station.progressArmedSince)).toBe(true);
  expect(lc(b.station)).toEqual(lc(a.station));
});

// ── Review fixes (Codex, Phase 1) ───────────────────────────────────────────

it('9.5/9.9 a load that disagrees with the held MUs is refused before commit; the active run stays', () => {
  const a = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  a.runUntil(23);
  const bad = JSON.parse(JSON.stringify(a.snapshot())) as DESSnapshotV4;
  const s = partState(bad, a.station);
  expect((s.muIds as number[]).length).toBe(1);
  // Not Blocked, one held MU, but load 0 and not armed: restore would install load 1.
  s.currentLoad = 0; s.progressArmedSince = null;
  const b = lineFixture({ stationProcessTime: 5, interArrivalTime: 10 });
  b.runUntil(7);
  const before = b.runner.snapshotJson(), time = b.manager.currentTime, processed = b.sink.totalProcessed;
  expect(() => b.runner.restoreJson(JSON.stringify(bad))).toThrow();
  expect(b.manager.currentTime).toBe(time);
  expect(b.sink.totalProcessed).toBe(processed);
  expect(b.runner.snapshotJson()).toBe(before);
});

it('NF1: one fleet subscription per runner; a task notification reaches exactly its own adapter', () => {
  const watch = (binding as unknown as { watchAgvTasks?: (runner: object, root: Object3D, adapter: { _progressCheck(): void }) => () => void }).watchAgvTasks;
  expect(typeof watch).toBe('function');
  const fleet = getDefaultAgvFleet();
  const subs = () => (fleet as unknown as { taskSubs: Set<unknown> }).taskSubs.size;
  const base = subs();
  const runnerA = {}, runnerB = {};
  const roots = [0, 1, 2].map(i => { const n = new Object3D(); n.name = `V${i}`; return n; });
  const adapters = roots.map(() => ({ _progressCheck: vi.fn() }));
  const offs = [watch!(runnerA, roots[0], adapters[0]), watch!(runnerA, roots[1], adapters[1]), watch!(runnerB, roots[2], adapters[2])];
  expect(subs()).toBe(base + 2);                               // one per runner, not one per AGV
  roots.forEach((node, i) => fleet.register({ id: `nf1-${i}`, node } as unknown as AgvHandle));
  try {
    fleet.notifyTaskChanged('nf1-1', { requested: null, effective: true } as never);
    fleet.notifyIdle('nf1-2');
    expect(adapters.map(x => x._progressCheck.mock.calls.length)).toEqual([0, 1, 1]);
    offs[1]();                                                 // dispose one instance
    fleet.notifyTaskChanged('nf1-1', { requested: null, effective: true } as never);
    expect(adapters[1]._progressCheck).toHaveBeenCalledTimes(1);
    offs[0](); offs[2]();
    expect(subs()).toBe(base);                                 // released with the last instance
    const again = watch!(runnerA, roots[0], adapters[0]);       // rebind: indexes an already registered handle
    fleet.notifyIdle('nf1-0');
    expect(adapters[0]._progressCheck).toHaveBeenCalledTimes(1);
    again();
    expect(subs()).toBe(base);
  } finally {
    for (let i = 0; i < 3; i++) fleet.unregister(`nf1-${i}`);
  }
});
