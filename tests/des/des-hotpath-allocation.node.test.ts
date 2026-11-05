// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// plan-2241a Anhang P3: the DES hot path allocates nothing for the progress lifecycle.
//  Fix 1 - `blockedSince` keeps its keys (NaN = not blocked) instead of shrinking the map per episode;
//          no reader counts a NaN entry and no snapshot carries one.
//  Fix 2 - the ledger push goes through a per-unit handle (no string lookups per push), guarded by a
//          ledger generation across reset / restore / replacement.
//  Fix 3 - the pose hand-over releases its held entry with pop() when it is the last one.

import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { flow, transferFixture } from './phase2-transfer-fixture';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { ProgressHandle, claimProgress, pushArm, pushBump, pushInactive } from '../../src/core/diagnostics/rv-progress-handle';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import type { DESComponent } from '../../src/plugins/des/rv-des-component';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import type { DESMU } from '../../src/plugins/des/rv-des-mu';

type Since = Map<DESComponent, number>;
const sinceOf = (c: DESComponent) => (c as unknown as { blockedSince: Since }).blockedSince;

/** Source (5 s) -> St0 (3 s) -> St1 (20 s bottleneck) -> Sink: Source and St0 block and release all the time. */
function congested(diag = false) {
  const scene = new Scene();
  const parts: Array<[string, string, Record<string, unknown>]> = [
    ['Src', 'Source', { Interval: 5 }], ['St0', 'Station', { ProcessingTime: 3 }],
    ['St1', 'Station', { ProcessingTime: 20 }], ['Snk', 'Sink', {}]];
  const nodes = parts.map(([name, type, props]) => {
    const n = new Object3D(); n.name = name; n.userData.realvirtual = { [type]: props }; scene.add(n); return n;
  });
  const f = runnerFixture(scene);
  const c = nodes.map(n => f.components.find(x => x.node === n)!) as MaterialFlowAdapter[];
  for (let i = 0; i < c.length - 1; i++) { c[i].nextComponents = [c[i + 1]]; c[i + 1].previousComponents = [c[i]]; }
  f.manager.statResetTime = 0;
  const ledger = new ProgressLedger({ clock: { now: () => f.manager.currentTime } });
  if (diag) Object.assign(f.host, { progressLedger: ledger, waitRegistry: new WaitRegistry() });
  f.runner.start([], { root: scene, host: f.host });
  return { ...f, c, ledger,
    step(dt = 0.5) { f.manager.processAnimated(dt); },
    runUntil(t: number) { while (f.manager.currentTime < t) f.manager.processAnimated(Math.min(0.5, t - f.manager.currentTime)); } };
}

// ── Fix 1: blockedSince tombstones ──────────────────────────────────────────

it('fix 1: a congested run never shrinks blockedSince; its keys stay within the downstream targets', () => {
  const f = congested();
  let deletes = 0;
  for (const c of f.c) {
    const m = sinceOf(c), del = m.delete.bind(m);
    m.delete = (k: DESComponent) => { deletes++; return del(k); };
  }
  let releases = 0, wasBlocked = false;
  while (f.manager.currentTime < 400) {
    f.step();
    const now = f.c[1].waitEdges(f.manager.currentTime).some(e => e.kind === 'des-exit');
    if (wasBlocked && !now) releases++;
    wasBlocked = now;
  }
  expect(releases, 'the fixture really blocks and releases').toBeGreaterThan(5);
  expect(deletes, 'Map.delete on blockedSince (shrinks/reallocates the hash table per episode)').toBe(0);
  for (const c of f.c) {
    const m = sinceOf(c);
    for (const k of m.keys()) expect(c.nextComponents).toContain(k);
    expect(m.size).toBeLessThanOrEqual(c.nextComponents.length);
  }
});

it('fix 1: a released target is not blocked for any reader; a new episode stamps its own begin', () => {
  const f = congested();
  // Last sim time each (component, target) edge was seen absent.
  const absentAt = new Map<string, number>();
  let episodes = 0, tombstones = 0;
  while (f.manager.currentTime < 400) {
    f.step();
    const now = f.manager.currentTime;
    for (const c of f.c) {
      const edges = c.waitEdges(now).filter(e => e.kind === 'des-exit');
      for (const t of c.nextComponents) {
        const key = `${c.path}->${t.path}`;
        const e = edges.find(x => x.resourceId === t.path);
        if (!e) {
          // Not blocked: blockedSinceOf answers "now" (as for a never-blocked target), never NaN.
          expect(c.blockedSinceOf(t), key).toBe(now);
          if (sinceOf(c).has(t)) tombstones++;
          absentAt.set(key, now);
          continue;
        }
        expect(Number.isFinite(e.sinceSimSec), `${key} since at ${now}`).toBe(true);
        expect(e.sinceSimSec).toBeLessThanOrEqual(now);
        const gone = absentAt.get(key);
        if (gone !== undefined) {
          // A new episode after a release: stamped after the release, not the old begin.
          expect(e.sinceSimSec, `${key} re-block at ${now}`).toBeGreaterThan(gone - 1e-9);
          episodes++;
          absentAt.delete(key);
        }
      }
    }
  }
  expect(episodes, 'several block -> release -> block sequences').toBeGreaterThan(5);
  expect(tombstones, 'released targets keep their (NaN) entry').toBeGreaterThan(0);
});

it('fix 1: snapshots never carry a tombstone; restore creates none; continuation is unchanged', () => {
  const a = congested();
  const nanKeys = (f: { c: MaterialFlowAdapter[] }) =>
    f.c.reduce((n, c) => n + [...sinceOf(c).values()].filter(v => v !== v).length, 0);
  a.runUntil(200);
  while (nanKeys(a) === 0 && a.manager.currentTime < 300) a.step();
  const at = a.manager.currentTime;
  expect(nanKeys(a), 'the world holds tombstones at the capture point').toBeGreaterThan(0);
  const withStale = a.runner.snapshotJson();
  expect(withStale).not.toMatch(/NaN|"since":null/);
  // Byte-identical to the snapshot of the same world without the stale keys.
  const purged = congested();
  purged.runUntil(at);
  for (const c of purged.c) for (const [k, v] of [...sinceOf(c)]) if (v !== v) sinceOf(c).delete(k);
  expect(nanKeys(purged)).toBe(0);
  expect(purged.runner.snapshotJson()).toBe(withStale);
  // Restore installs only real begin stamps.
  const b = congested();
  b.runUntil(50);
  b.runner.restoreJson(withStale);
  expect(nanKeys(b), 'restore creates no NaN key').toBe(0);
  for (const c of b.c) for (const v of sinceOf(c).values()) expect(Number.isFinite(v)).toBe(true);
  // Tombstones never change later behaviour: stale, purged and restored worlds stay identical.
  a.runUntil(400); purged.runUntil(400); b.runUntil(400);
  const end = a.runner.snapshotJson();
  expect(purged.runner.snapshotJson()).toBe(end);
  expect(b.runner.snapshotJson()).toBe(end);
});

// ── Fix 2: ledger handle ────────────────────────────────────────────────────

type Counted = { lookups: number; reportedSets: number };
function countLedger(ledger: ProgressLedger): Counted {
  const n: Counted = { lookups: 0, reportedSets: 0 };
  const priv = ledger as unknown as { entries: Map<string, unknown>; reported: Map<string, boolean> };
  const e = priv.entries, get = e.get.bind(e), has = e.has.bind(e);
  e.get = (k: string) => { n.lookups++; return get(k); };
  e.has = (k: string) => { n.lookups++; return has(k); };
  const r = priv.reported, set = r.set.bind(r);
  r.set = (k: string, v: boolean) => { if (v) n.reportedSets++; return set(k, v); };
  return n;
}

it('fix 2: a bound run pushes through the handle - no ledger lookup per push, reported set once per unit', () => {
  const f = congested(true);
  f.runUntil(60);
  const counted = countLedger(f.ledger);
  let pushes = 0;
  for (const a of f.c) {
    const push = a.onProgress!;
    a.onProgress = (k, t, n) => { pushes++; push(k, t, n); };
  }
  const before = f.c.map(a => f.ledger.entry(a.progressUnitId)!.count);
  f.runUntil(600);
  expect(pushes).toBeGreaterThan(200);
  // At most one claim (register has + get) per unit that had not pushed yet - never one per push.
  expect(counted.lookups, `ledger map lookups for ${pushes} pushes`).toBeLessThanOrEqual(2 * f.c.length);
  expect(counted.reportedSets, 'reported flips false -> true at most once per unit').toBeLessThanOrEqual(f.c.length);
  // Same accounting as before: every unit counted its hand-overs, armed rows carry the progress stamp.
  f.c.forEach((a, i) => {
    const e = f.ledger.entry(a.progressUnitId)!;
    expect(e.count).toBeGreaterThan(before[i]);
    expect(e.state).toBe(a.progressArmedSince === a.progressArmedSince ? 'armed' : 'inactive');
    if (e.state === 'armed') expect(e.lastChangeSec).toBe(a.lastProgressSec);
  });
});

it('fix 2: a handle follows reset, restore and removal and never writes into a dropped row', () => {
  let now = 0;
  const ledger = new ProgressLedger({ clock: { now: () => now } });
  const h = new ProgressHandle(ledger, 'des:A', 'des', 'des');
  expect(claimProgress(h), 'first claim registers the unit').toBe(true);
  expect(claimProgress(h)).toBe(false);
  pushArm(h, 1);
  pushBump(h, 2, 3);
  expect(ledger.entry('des:A')).toMatchObject({ count: 2, lastChangeSec: 3, state: 'armed' });
  expect(ledger.snapshotState().reported).toEqual([['des:A', true]]);
  const saved = ledger.snapshotState();
  const dropped = ledger._row('des:A')!;
  // Reset: the old row is gone; the next claim re-registers, the old object is never written again.
  ledger.reset();
  now = 5;
  pushBump(h, 9, 5);                       // stale, unclaimed: id path = unknown unit, observed only
  expect(ledger.entry('des:A')).toBeNull();
  expect(claimProgress(h), 're-register after reset').toBe(true);
  pushBump(h, 1, 5);
  expect(ledger.entry('des:A')).toMatchObject({ count: 1, lastChangeSec: 5 });
  expect(dropped.count).toBe(2);
  expect(ledger.snapshotState().reported).toEqual([['des:A', true]]);
  // Restore replaces the row objects: the handle writes into the restored row.
  ledger.restoreState(JSON.parse(JSON.stringify(saved)));
  expect(claimProgress(h)).toBe(false);
  pushBump(h, 4, 9);
  expect(ledger.entry('des:A')).toMatchObject({ count: 6, lastChangeSec: 9, state: 'armed' });
  // Unregister and the removal in sample invalidate too.
  ledger.unregister('des:A');
  expect(claimProgress(h)).toBe(true);
  pushInactive(h);
  expect(ledger.entry('des:A')!.state).toBe('inactive');
  ledger.sample(0);                        // no population: the row is dropped
  expect(ledger.entry('des:A')).toBeNull();
  pushArm(h, 10);
  expect(ledger.entry('des:A')).toBeNull();
  // A handle is bound to its own ledger: another ledger with the same unit id is never touched.
  const other = new ProgressLedger({ clock: { now: () => now } });
  other.register('des:A', 'des', 'des');
  expect(claimProgress(h)).toBe(true);
  pushBump(h, 7, 11); pushArm(h, 11);
  expect(other.entry('des:A')).toMatchObject({ count: 0, state: 'inactive' });
  expect(ledger.entry('des:A')).toMatchObject({ count: 7, state: 'armed' });
});

it('fix 2: a replaced host ledger is bound at the next start; the old one receives nothing', () => {
  const f = congested(true);
  f.runUntil(100);
  const old = f.ledger;
  const counts = () => f.c.map(a => old.entry(a.progressUnitId)?.count ?? -1);
  const next = new ProgressLedger({ clock: { now: () => f.manager.currentTime } });
  Object.assign(f.host, { progressLedger: next });
  f.runner.reset();
  const frozen = counts();
  f.runUntil(300);
  expect(counts()).toEqual(frozen);
  for (const a of f.c) expect(next.entry(a.progressUnitId), a.progressUnitId).not.toBeNull();
  expect(f.c.some(a => next.entry(a.progressUnitId)!.count > 0)).toBe(true);
});

// ── Fix 3: pose hand-over pop fast path ─────────────────────────────────────

type Held = { _heldMUs: DESMU[]; _heldBumps: number[] };
function spySplice(arr: unknown[]): { n: number } {
  const c = { n: 0 }, splice = arr.splice.bind(arr);
  (arr as { splice: unknown }).splice = (...args: [number, number]) => { c.n++; return splice(...args); };
  return c;
}

it('fix 3: nested holds release LIFO with pop(); an out-of-order release falls back and keeps the rest', () => {
  const f = transferFixture([{ type: 'Station', props: { ProcessingTime: 1 } }, { type: 'Storage', props: { MaxCapacity: 4 } }]);
  const [owner] = f.parts;
  const held = owner as unknown as Held;
  const s1 = spySplice(held._heldMUs), s2 = spySplice(held._heldBumps);
  const [m1, m2, m3] = [f.runner.createMU(), f.runner.createMU(), f.runner.createMU()];
  owner._holdProgress(m1); owner._holdProgress(m2);
  held._heldBumps[0] = 1; held._heldBumps[1] = 2;
  owner._releaseHeldProgress(m2, false);          // LIFO: the last entry
  expect([...held._heldMUs]).toEqual([m1]);
  expect([...held._heldBumps]).toEqual([1]);
  expect(s1.n + s2.n, 'LIFO release uses pop(), no splice').toBe(0);
  owner._holdProgress(m2); owner._holdProgress(m3);
  held._heldBumps[1] = 5; held._heldBumps[2] = 7;
  owner._releaseHeldProgress(m2, false);          // out of order: the middle entry
  expect([...held._heldMUs]).toEqual([m1, m3]);
  expect([...held._heldBumps]).toEqual([1, 7]);
  expect(s1.n).toBe(1);
  owner._releaseHeldProgress(m3, false);
  owner._releaseHeldProgress(m1, false);
  expect(held._heldMUs.length + held._heldBumps.length).toBe(0);
  expect(s1.n, 'only the out-of-order release spliced').toBe(1);
  expect(owner.progressConsistent()).toBe(true);
});

it('fix 3: a committed pose hand-over pops the pending pose and books the held bump once', () => {
  const f = transferFixture([{ type: flow() }, { type: flow({ des: { acceptsPose: true } }) }]);
  const [owner, target] = f.parts;
  expect(target.poseUnsupportedReason()).toBeNull();
  const pending = (target as unknown as { pendingPoses: unknown[] }).pendingPoses;
  const sp = spySplice(pending), sh = spySplice((owner as unknown as Held)._heldMUs);
  const mu = f.runner.createMU();
  expect(owner.acceptMU(mu)).toBe(true);
  expect(target.transferInWithPose(owner, mu, {} as never)).toEqual({ ok: true });
  expect(target.pendingPoseCount).toBe(0);
  target.canAcceptWithPose(f.runner.createMU(), {} as never);
  expect(target.pendingPoseCount).toBe(0);
  expect(owner.lastProgressSec, 'the committed hand-over booked the owner output').toBe(f.manager.currentTime);
  expect(sp.n + sh.n, 'pose bookkeeping uses pop()').toBe(0);
});
