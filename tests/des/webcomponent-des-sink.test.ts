// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.4 — `self.sink(path).on` in DES.
 *
 *  - fires once per arrival at the DES sink, synchronously at the DES time of
 *    the arrival (`self.now` inside the callback = the arrival's event time);
 *  - two scripts on the same sink: a fixed delivery order (script node path,
 *    NOT the mint order - the scene lists `Beta` before `Alpha`), exactly one
 *    delivery per script and arrival, and the runner's visual sweep
 *    (`onMUConsumed`) still runs exactly once per arrival;
 *  - after 3 replications (each rebuilds every VM) exactly one listener per
 *    script and sink - no leak; switching to continuous releases all of them;
 *  - `componentsAll.sink` in DES resolves the DES sinks too.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Object3D } from 'three';
import { makeWorld } from './webcomponent-des-fixture';
import { getProblem, clearProblemsOfCode } from '../../src/core/hmi/problems-store';
import { DES_SCRIPT_SINK_RUNTIME_CODE, DES_SCRIPT_SINK_UNRESOLVED_CODE } from '../../src/plugins/web-component-plugin';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';

const LISTENER = (tag: string) => `
function setup(self) {
  const st = self.persist({ hits: [] });
  self.sink('Sink').on(function (mu) {
    st.hits.push([self.now, mu.id]);
    self.log('ARR', '${tag}', self.now, mu.id);
  });
  return { state() { return st; } };
}`;

const ALL_SINKS = `
function setup(self) {
  const st = self.persist({ n: 0, sinks: 0 });
  const sinks = self.findAll('Sink');
  st.sinks = sinks.length;
  for (const s of sinks) s.on(function () { st.n++; });
  return { state() { return st; } };
}`;

type World = Awaited<ReturnType<typeof makeWorld>>;
interface St { hits: Array<[number, number]> }

function sinkAdapter(w: World): MaterialFlowAdapter {
  return w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter;
}

/** Collects the `ARR` log lines (tag, time, muId) in delivery order. */
function captureArrivals(): { lines: Array<[string, number, number]>; restore(): void } {
  const lines: Array<[string, number, number]> = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const i = args.indexOf('ARR');
    if (i >= 0) lines.push([String(args[i + 1]), Number(args[i + 2]), Number(args[i + 3])]);
  });
  return { lines, restore: () => spy.mockRestore() };
}

let restoreLog: (() => void) | null = null;
afterEach(() => {
  restoreLog?.(); restoreLog = null;
  clearProblemsOfCode(DES_SCRIPT_SINK_RUNTIME_CODE);
  clearProblemsOfCode(DES_SCRIPT_SINK_UNRESOLVED_CODE);
});

/** Subscribes from a timer at t = 12 (after setup) - refused in DES. */
const LATE_ON = `
function setup(self) {
  const st = self.persist({ hits: 0, err: '' });
  self.in(12, 'late');
  return {
    des: { on(hook) {
      if (hook !== 'late') return;
      try { self.sink('Sink').on(function () { st.hits++; }); }
      catch (e) { st.err = String((e && e.message) || e); }
    } },
    state() { return st; },
  };
}`;

/** Subscribes in setup, tries to unsubscribe at t = 12 - refused, keeps receiving. */
const LATE_OFF = `
function setup(self) {
  const st = self.persist({ hits: 0, err: '' });
  const off = self.sink('Sink').on(function () { st.hits++; });
  self.in(12, 'stop');
  return {
    des: { on(hook) {
      if (hook !== 'stop') return;
      try { off(); } catch (e) { st.err = String((e && e.message) || e); }
    } },
    state() { return st; },
  };
}`;

/** Listens to a sink path (guarded: an unresolved sink is null). */
const AT = (path: string) => `
function setup(self) {
  const st = self.persist({ hits: 0, found: false });
  const s = self.sink('${path}');
  st.found = !!s;
  if (s) s.on(function () { st.hits++; });
  return { state() { return st; } };
}`;

describe('plan-2212 §9.4 — sink events in DES', () => {
  it('fires per arrival at DES time; two scripts in path order, one delivery each, one visual sweep', async () => {
    // Mint order Beta, Alpha - delivery order must still be Alpha, Beta (node path).
    const w = await makeWorld({ flow: true, scripts: [
      { name: 'Beta', code: LISTENER('Beta') }, { name: 'Alpha', code: LISTENER('Alpha') }] });
    w.start();
    const sink = sinkAdapter(w);
    expect(sink.consumedListenerCount).toBe(2);

    // Host-side truth: the DES time of every arrival, and the visual sweep count.
    const truth: Array<[number, number]> = [];
    const hostUnsub = sink.addConsumedListener(mu => truth.push([w.manager.currentTime, mu.id]), '￿');
    let sweeps = 0;
    const sweep = sink.onMUConsumed!;
    sink.onMUConsumed = (mu) => { sweeps++; sweep(mu); };

    const cap = captureArrivals(); restoreLog = cap.restore;
    await w.runTo(100);
    hostUnsub();

    expect(truth.length).toBeGreaterThan(3);
    expect(sink.totalProcessed).toBe(truth.length);
    expect(sweeps).toBe(truth.length);
    for (const name of ['Alpha', 'Beta']) {
      const st = w.state(name) as St;
      expect(st.hits).toEqual(truth);   // one delivery per arrival, at the arrival's DES time
    }
    // DES time, not a frame clock: arrivals land on the 5 s event grid of the line.
    expect(truth.map(t => t[0])).toEqual(truth.map((_, i) => 5 * (i + 1)));
    // Fixed order per arrival: Alpha before Beta.
    expect(cap.lines.map(l => l[0])).toEqual(truth.flatMap(() => ['Alpha', 'Beta']));
    expect(cap.lines.map(l => [l[1], l[2]])).toEqual(truth.flatMap(t => [t, t]));
  });

  it('exactly one listener per script and sink after 3 replications; continuous releases them', async () => {
    const w = await makeWorld({ flow: true, scripts: [
      { name: 'Alpha', code: LISTENER('Alpha') }, { name: 'Beta', code: LISTENER('Beta') }] });
    w.start();
    const sink = sinkAdapter(w);
    for (const seed of [11, 12, 13]) {
      w.runner.setMasterSeed(seed);
      w.runner.reset();
      expect(sink.consumedListenerCount).toBe(2);
      const truth: Array<[number, number]> = [];
      const hostUnsub = sink.addConsumedListener(mu => truth.push([w.manager.currentTime, mu.id]));
      await w.runTo(60);
      hostUnsub();
      expect(sinkAdapter(w)).toBe(sink);
      expect(sink.consumedListenerCount).toBe(2);
      // Each replication's fresh VM saw exactly this replication's arrivals, once.
      expect(truth.length).toBeGreaterThan(3);
      expect((w.state('Alpha') as St).hits).toEqual(truth);
      expect((w.state('Beta') as St).hits).toEqual(truth);
    }
    w.switchToContinuous();
    expect(sink.consumedListenerCount).toBe(0);
  });

  it('a single-script reload re-subscribes in the same place: order stays path order, no leak', async () => {
    const w = await makeWorld({ flow: true, scripts: [
      { name: 'Alpha', code: LISTENER('Alpha') }, { name: 'Beta', code: LISTENER('Beta') }] });
    w.start();
    const sink = sinkAdapter(w);
    await w.runTo(30);
    // Rebuild Alpha alone (editor save path): it re-subscribes last in time.
    const alpha = w.inst('Alpha');
    const registry = (w.plugin as unknown as { registry: { reload(path: string, code: string): unknown } }).registry;
    registry.reload(alpha.nodePath, LISTENER('Alpha'));
    expect(sink.consumedListenerCount).toBe(2);
    const cap = captureArrivals(); restoreLog = cap.restore;
    w.manager.duration = 60;
    await w.runner.runFastForward();
    expect(cap.lines.length).toBeGreaterThan(0);
    const tags = cap.lines.map(l => l[0]);
    expect(tags).toEqual(tags.map((_, i) => (i % 2 === 0 ? 'Alpha' : 'Beta')));
  });

  it('componentsAll.sink resolves the DES sinks in DES mode', async () => {
    const w = await makeWorld({ flow: true, scripts: [{ name: 'All', code: ALL_SINKS }] });
    w.start();
    await w.runTo(60);
    const st = w.state('All') as { n: number; sinks: number };
    expect(st.sinks).toBe(1);
    expect(st.n).toBe(sinkAdapter(w).totalProcessed);
    expect(st.n).toBeGreaterThan(0);
  });

  it('a runtime .on() is refused visibly; nothing subscribes, in the current VM and after a rebuild', async () => {
    const w = await makeWorld({ flow: true, scripts: [{ name: 'Late', code: LATE_ON }] });
    w.start();
    const sink = sinkAdapter(w);
    const id = `${DES_SCRIPT_SINK_RUNTIME_CODE}:${w.inst('Late').nodePath}`;
    for (let round = 0; round < 2; round++) {
      if (round > 0) {
        w.runner.reset();   // rebuild: the old VM's problem retires with it
        expect(getProblem(id)).toBeUndefined();
      }
      await w.runTo(60);
      const st = w.state('Late') as { hits: number; err: string };
      expect(st.err).toContain('des-sink-subscribe-outside-setup');
      expect(st.hits).toBe(0);
      expect(sink.consumedListenerCount).toBe(0);
      expect(getProblem(id)?.detail).toContain('subscribe (.on)');
    }
  });

  it('a runtime unsubscribe is refused visibly; the subscription keeps delivering and is released on teardown', async () => {
    const w = await makeWorld({ flow: true, scripts: [{ name: 'Off', code: LATE_OFF }] });
    w.start();
    const sink = sinkAdapter(w);
    for (let round = 0; round < 2; round++) {
      if (round > 0) w.runner.reset();
      const truth: number[] = [];
      const unsub = sink.addConsumedListener(mu => truth.push(mu.id), '\uffff');
      await w.runTo(60);
      unsub();
      const st = w.state('Off') as { hits: number; err: string };
      expect(st.err).toContain('des-sink-unsubscribe-outside-setup');
      expect(st.hits).toBe(truth.length);          // still delivering after t = 12
      expect(sink.consumedListenerCount).toBe(1);
      expect(getProblem(`${DES_SCRIPT_SINK_RUNTIME_CODE}:${w.inst('Off').nodePath}`)?.detail).toContain('unsubscribe');
    }
    w.switchToContinuous();
    expect(sink.consumedListenerCount).toBe(0);
  });

  it('delivery uses a membership snapshot: added listeners wait, removed ones skip, a throwing one does not block', async () => {
    const w = await makeWorld({ flow: true, scripts: [] });
    w.start();
    const sink = sinkAdapter(w);
    const calls: string[] = [];
    let offC: () => void = () => {};
    let added = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sink.addConsumedListener((mu) => {
      calls.push(`a${mu.id}`);
      // Re-registering on every delivery must not chain within one arrival.
      sink.addConsumedListener(m => calls.push(`late${added}:${m.id}`), 'z');
      added++;
      offC();
    }, 'a');
    sink.addConsumedListener(() => { throw new Error('boom'); }, 'b');
    offC = sink.addConsumedListener(mu => calls.push(`c${mu.id}`), 'c');
    sink.addConsumedListener(mu => calls.push(`d${mu.id}`), 'd');
    w.manager.duration = 6;   // the first arrival only (5 s grid)
    await w.runner.runFastForward();
    const warned = warn.mock.calls.length;
    warn.mockRestore();
    expect(added).toBe(1);
    const first = calls[0].slice(1);
    // c was removed during the delivery (skipped); the late listener waits; the throw is isolated.
    expect(calls).toEqual([`a${first}`, `d${first}`]);
    expect(warned).toBeGreaterThan(0);
  });

  it('an unresolved sink is a visible problem, never the frame-clock sink', async () => {
    const w = await makeWorld({ flow: true, scripts: [{ name: 'Lost', code: AT('Nowhere/Sink') }] });
    // A frame-clock RVSink exists at that path, but the DES run has no sink there.
    let frameClockSubs = 0;
    const registry = (w.plugin as unknown as { lastLoad: { result: { registry: { getByPath(t: string, p: string): unknown } } } })
      .lastLoad.result.registry;
    const frameSink = { node: w.scene, subscribeConsumed: () => { frameClockSubs++; return () => {}; } };
    registry.getByPath = (t: string, p: string) => (t === 'Sink' && p === 'Nowhere/Sink' ? frameSink : null);
    w.start();
    await w.runTo(30);
    expect((w.state('Lost') as { found: boolean }).found).toBe(false);
    expect(frameClockSubs).toBe(0);
    const p = getProblem(`${DES_SCRIPT_SINK_UNRESOLVED_CODE}:${w.inst('Lost').nodePath}`);
    expect(p?.detail).toContain(w.inst('Lost').nodePath);
    expect(p?.detail).toContain('Nowhere/Sink');
  });

  it('resolves a sink through the viewer registry node, and headless by name path', async () => {
    const w = await makeWorld({ flow: true, scripts: [
      { name: 'ByNode', code: AT('Plant/Exit') }, { name: 'ByName', code: AT('Sink') }] });
    // Production path: the viewer registry names the node; the script path is not the node name.
    const registry = (w.plugin as unknown as { lastLoad: { result: { registry: { getNode(p: string): Object3D | null } } } })
      .lastLoad.result.registry;
    const sinkNode = w.scene.getObjectByName('Sink')!;
    registry.getNode = (p: string) => (p === 'Plant/Exit' ? sinkNode : null);
    w.start();
    await w.runTo(60);
    const processed = sinkAdapter(w).totalProcessed;
    expect(processed).toBeGreaterThan(0);
    expect(w.state('ByNode')).toEqual({ hits: processed, found: true });
    expect(w.state('ByName')).toEqual({ hits: processed, found: true });
  });

  it('rebindScene releases the old sink adapter and subscribes the new one', async () => {
    const w = await makeWorld({ flow: true, scripts: [
      { name: 'Alpha', code: LISTENER('Alpha') }, { name: 'Beta', code: LISTENER('Beta') }] });
    w.start();
    const old = sinkAdapter(w);
    await w.runTo(20);
    w.runner.rebindScene();
    const fresh = sinkAdapter(w);
    expect(fresh).not.toBe(old);
    expect(old.consumedListenerCount).toBe(0);
    expect(fresh.consumedListenerCount).toBe(2);
  });
});
