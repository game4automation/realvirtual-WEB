// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// plan-2241a Phase 3 (normal tests, not a benchmark): micro-scenario rollback / reservation / fault
// including a nested pose transfer, run with a ledger consumer bound and without, and the DES time
// base of the progress stamps (event time vs sim time for the end-of-run check and the live watch).
// A "stuck" statement is made on the LEDGER (what plan-2048 and the watch read), not only on the
// component callbacks that 9.15 already pins.

import { afterEach, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import { clearAllProblems } from '../../src/core/hmi/problems-store';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { BlockageWatch } from '../../src/core/diagnostics/rv-blockage-watch';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import type { DESMU } from '../../src/plugins/des/rv-des-mu';
import type { MU } from '../../src/core/material-flow/material-flow-self';
import { runnerFixture } from './runner-fixture';

afterEach(() => { clearAllProblems(); __resetDesRunSettingsForTest(); });

let nextType = 0;
const flow = (def: Partial<MaterialFlowDefinition> = {}): MaterialFlowDefinition =>
  defineMaterialFlow({ type: `Plan2241Micro${nextType++}`, kind: 'station', schema: {}, continuous: {}, ...def });

type Part = [string | MaterialFlowDefinition, Record<string, unknown>?];

/** A real scene chain p0 -> p1 -> ...; `bound` puts a ledger + wait registry on the host before the first start. */
function world(parts: Part[], bound: boolean, idleSec = 10) {
  const scene = new Scene();
  const nodes = parts.map(([type, props], i) => {
    if (typeof type !== 'string') registerMaterialFlow(type);
    const node = new Object3D(); node.name = `P${i}`;
    node.userData.realvirtual = { [typeof type === 'string' ? type : type.type]: props ?? {} }; scene.add(node);
    return node;
  });
  const f = runnerFixture(scene);
  const c = nodes.map(n => f.components.find(x => x.node === n)!);
  for (let i = 0; i < c.length - 1; i++) { c[i].nextComponents = [c[i + 1]]; c[i + 1].previousComponents = [c[i]]; }
  f.manager.statResetTime = 0;
  const ledger = new ProgressLedger({ clock: { now: () => f.manager.currentTime } });
  const registry = new WaitRegistry();
  const budgets = new BudgetResolver({ defaults: { MaxIdleSec: idleSec, WarmupSec: 0 } });
  const host = f.host as typeof f.host & { progressLedger: ProgressLedger | null; waitRegistry: WaitRegistry | null };
  Object.assign(host, bound ? { progressLedger: ledger, waitRegistry: registry } : { progressLedger: null, waitRegistry: null });
  const watch = new BlockageWatch(() => ({ ledger, registry, budgets, now: f.manager.currentTime }));
  f.runner.start([], { root: scene, host });
  const entry = (a: MaterialFlowAdapter) => ledger.entry(a.progressUnitId);
  return { ...f, c, ledger, registry, watch, entry, scene,
    advance(time: number) { expect(time).toBeGreaterThanOrEqual(f.manager.currentTime); f.manager.processAnimated(time - f.manager.currentTime); },
  };
}

/** What a model-visible comparison needs: events, time, statistics, per-part processed counts, queue + RNG via snapshot. */
const observable = (w: ReturnType<typeof world>) => ({
  events: w.manager.totalEventsProcessed, time: w.manager.currentTime,
  stats: JSON.stringify(w.runner.statistics()),
  processed: w.c.map(a => a.totalProcessed), loads: w.c.map(a => a.currentLoad),
  snapshot: w.runner.snapshotJson().replace(/Plan2241Micro\d+/g, 'Micro').replace(/"modelHash":"[0-9a-f]+"/, ''),   // type names carry a per-world counter
});

// ── Micro-scenario: rollback / reservation / fault / nested pose transfer ───────────────────────

/** The scripted sequence; identical in the bound and the unbound world. Returns the ledger-relevant marks. */
function script(w: ReturnType<typeof world>, hook: { fn: (() => void) | null }) {
  const [owner, target, x, , fq] = w.c;
  const marks: Record<string, unknown> = {};
  const mu = w.runner.createMU(), other = w.runner.createMU(), fm = w.runner.createMU();
  expect(owner.acceptMU(mu)).toBe(true);                       // owner armed since 0
  expect(x.acceptMU(other)).toBe(true);                        // x armed since 0
  expect(fq.acceptMU(fm)).toBe(true);                          // fq: the station that will fault
  w.advance(4);
  // (1) pose hand-over rolled back by the target; a nested, independent transfer inside it succeeds.
  hook.fn = () => { hook.fn = null; expect(x.transferMU(other)).toBe('moved'); };
  const r = (target as MaterialFlowAdapter).transferInWithPose(owner, mu as DESMU, {} as never);
  marks.pose = r.ok;
  // (2) reservation batch rolled back by the same target.
  const reservation = owner.reserveDownstream(1);
  marks.reserve = reservation.commitMany([mu as unknown as MU]);
  // (3) fault on a station that holds a part (arm kept), repair 3 s later.
  w.advance(5);
  fq.setFailure(true);
  w.advance(8);
  fq.setFailure(false);
  w.advance(30);
  return marks;
}

function microParts(hook: { fn: (() => void) | null }): Part[] {
  return [
    [flow()],                                                                            // owner
    [flow({ des: { acceptsPose: true, onAccept: () => { hook.fn?.(); return false; } } })], // target: refuses, nested success inside
    [flow()],                                                                            // x (nested transfer moves its part to y)
    [flow()],                                                                            // y
    ['Station', { ProcessingTime: 6 }],                                                  // fq (faulting, loaded)
    ['Sink'],
  ];
}

it('micro: rolled-back pose + reservation + fault leave the ledger exactly as the lifecycle says; bound == unbound', () => {
  const hb = { fn: null as (() => void) | null }, hf = { fn: null as (() => void) | null };
  const bound = world(microParts(hb), true), free = world(microParts(hf), false);
  const mb = script(bound, hb), mf = script(free, hf);
  expect(mb).toEqual({ pose: false, reserve: false });
  expect(mf).toEqual(mb);
  expect(observable(bound)).toEqual(observable(free));       // no model-visible effect of the consumer
  const [owner, target, x] = bound.c;
  // Rolled-back attempts: the owner keeps its original activation and progress, the target never armed.
  expect(owner.progressArmedSince).toBe(0);
  expect(bound.entry(owner)).toMatchObject({ state: 'armed', lastChangeSec: 0 });
  expect(bound.entry(target)).toMatchObject({ state: 'inactive' });
  expect(target.progressArmedSince).toBeNaN();
  // The nested, independent success inside the failed outer attempt survives: x went idle and booked its output at 4 s.
  expect(bound.entry(x)).toMatchObject({ state: 'inactive', lastChangeSec: 4 });
  expect(x.lastProgressSec).toBe(4);
  // The faulting loaded station: 5 s of 6 s done, 3 s down, 1 s remaining -> output at 9 s (downtime is real, books once).
  const fq = bound.c[4];
  expect(fq.lastProgressSec).toBe(9);
  expect(bound.entry(fq)).toMatchObject({ state: 'inactive', lastChangeSec: 9 });
  // Same picture for every unit: the ledger mirrors the component stamps.
  for (const a of bound.c) {
    const e = bound.entry(a)!;
    const armed = a.progressArmedSince === a.progressArmedSince;
    expect(e.state, a.progressUnitId).toBe(armed ? 'armed' : 'inactive');
    if (armed) expect(e.lastChangeSec, a.progressUnitId).toBe(a.lastProgressSec);
  }
});

it('micro: a fault keeps the activation of a loaded station, books the delayed output once, and never arms an idle one', () => {
  const w = world([['Station', { ProcessingTime: 6 }], ['Station', { ProcessingTime: 6 }], ['Sink']], true);
  const [idle, st] = w.c;
  const mu = w.runner.createMU();
  expect(st.acceptMU(mu)).toBe(true);                          // work 0..6
  w.advance(2);
  idle.setFailure(true);                                       // idle unit fails: never armed
  expect(idle.progressArmedSince).toBeNaN();
  expect(w.entry(idle)).toMatchObject({ state: 'inactive' });
  st.setFailure(true);                                         // loaded unit fails at 2 s
  expect(st.progressArmedSince).toBe(0);                       // still armed from the first arrival
  w.advance(10);
  expect(st.progressArmedSince).toBe(0);
  expect(st.lastProgressSec).toBe(0);                          // a failure is not progress
  expect(w.entry(st)).toMatchObject({ state: 'armed', lastChangeSec: 0 });
  st.setFailure(false);                                        // repaired at 10 s: 4 s of work remain
  w.advance(14);
  expect(st.progressArmedSince).toBeNaN();                     // output at 14 s = 10 + remaining 4 (downtime is real)
  expect(st.lastProgressSec).toBe(14);
  expect(w.entry(st)).toMatchObject({ state: 'inactive', lastChangeSec: 14 });
});

// ── Time base ───────────────────────────────────────────────────────────────────────────────────

/** A line that goes silent: the station finishes at 1 s and stays blocked at the full buffer; no event follows. */
function silentWorld(bound = true) {
  const w = world([['Station', { ProcessingTime: 1 }], ['Storage', { MaxCapacity: 1 }]], bound, 10);
  const [station, buffer] = w.c;
  expect(buffer.acceptMU(w.runner.createMU())).toBe(true);
  expect(station.acceptMU(w.runner.createMU())).toBe(true);
  return { ...w, station, buffer };
}

it('time base (batch): FastForward over a silent tail leaves the clock at the LAST EVENT; the end-of-run check must pass the end time', async () => {
  const w = silentWorld();
  expect(await w.runner.runFastForward({ untilSimTime: 500 })).toBe(true);
  expect(w.station.progressArmedSince).toBe(0);                       // stamps are event times
  // FINDING for plan-2048: the DES clock does NOT run on to the target when the queue is empty -
  // `manager.currentTime` is the last event (1 s), not 500 s. A check that takes `now` from the
  // runner clock sees a stall age of ~1 s and reports nothing for a line that has been stuck since 1 s.
  expect(w.manager.currentTime).toBe(1);
  expect(w.watch.inspect().findings.filter(x => x.cls === 'stall')).toEqual([]);
  // With the END time passed explicitly the same ledger ages correctly (stall since 0 s, found at 500 s).
  const entry = w.ledger.sample(0, 500, true).candidates.find(e => e.unitId === w.station.progressUnitId);
  expect(entry).toBeDefined();
  expect(500 - entry!.lastChangeSec).toBe(500);
});

it('time base (live): animated time advances without events, so the watch ages a silent stall against sim time', () => {
  const w = silentWorld();
  w.advance(5);
  expect(w.watch.inspect().findings.filter(x => x.cls === 'stall')).toEqual([]);   // 5 s < MaxIdleSec 10
  w.advance(60);
  expect(w.manager.currentTime).toBe(60);                                          // the clock moves with sim time
  const stalls = w.watch.inspect().findings.filter(x => x.cls === 'stall');
  expect(stalls.map(s => s.waiterId)).toContain(w.station.progressUnitId);
});

it('time base: the edge age of a des-exit wait is event time (blocked since 1 s), not the inspection time', async () => {
  const w = silentWorld();
  await w.runner.runFastForward({ untilSimTime: 200 });
  const edges = w.station.waitEdges(w.manager.currentTime);
  expect(edges).toEqual([expect.objectContaining({ kind: 'des-exit', sinceSimSec: 1 })]);
});
