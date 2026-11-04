// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.5 + §9.6c — Model-Scripts in DES snapshots and continuation.
 *
 * §9.5: the continuation harness (`assertContinuation`, modes A / B /
 * B-immediate) over a material-flow line with WebComponent scripts that hold
 * `self.every` timers, `self.persist` state, an FSM state, the seeded
 * `self.random()` stream and published `statValue` rows. Mode B loads through a
 * REAL registry rebuild (a fresh world: new plugin, new VMs). The trace is the
 * script hook dispatch log, keyed by the desId of the adapter that RECEIVED the
 * hook - an event dispatched to a disposed adapter (no longer listed) is
 * recorded as `stale` and fails the comparison.
 *
 * Dispatcher rebinding: a snapshot restored after `reset()` rebuilt every VM
 * dispatches its `Script.Hook` events to the CURRENT instances.
 *
 * Two sink listeners (plan-2212 Phase 2): `Yard2` and `Yard1` listen to the
 * DES sink through `self.sink('Sink').on` (minted Yard2 first, delivered in
 * node-path order Yard1, Yard2). Every delivery joins the trace as
 * `sink:<name>` at its DES time, so the comparison covers the callback order
 * and exactly one delivery per arrival; the delivering VM's persist (KPIs)
 * proves the CURRENT VM received it, and the sink's listener count and
 * throughput (MU retirement) are part of the KPIs.
 *
 * §9.6c: two placements of the SAME asset with a script, registered by a REAL
 * `NodeRegistry` (document + placement occurrences): distinct desIds that are
 * stable over a reload (a fresh world), a snapshot addressable across that
 * reload; a script on a node no document registers stays a visible refusal.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { makeWorld, scriptNode, type DesAddressSource } from './webcomponent-des-fixture';
import { assertContinuation, type ContinuationEvent, type ContinuationWorld } from '../helpers/des-continuation-harness';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { getProblem, clearProblem } from '../../src/core/hmi/problems-store';

/** Timers + persist + FSM + RNG + stat rows - all declared state. */
const WORKER = `
function setup(self) {
  const st = self.persist({ n: 0, draws: [] });
  self.setState('Idle');
  self.every(3, 'beat');
  self.in(1.5, 'first');
  return {
    des: { on(hook) {
      if (hook === 'first') { self.setState('Busy'); return; }
      if (hook !== 'beat') return;
      st.n++;
      st.draws.push(Math.round(self.random() * 1000));
      if (st.n % 2 === 0) self.in(self.random() * 2, 'first');
      self.statValue('Beats', st.n);
      self.statValue('Phase', st.n % 3 === 0 ? 'cool' : 'run');
    } },
    state() { return { st, fsm: self.state }; },
  };
}`;

const MONITOR = `
function setup(self) {
  const st = self.persist({ ticks: 0 });
  self.every(5, 'tick');
  return {
    des: { on(hook) { if (hook === 'tick') { st.ticks++; self.statValue('Ticks', st.ticks, 'n', 'Monitor'); } } },
    state() { return st; },
  };
}`;

/** A sink listener: records each arrival in persist and logs it for the trace. */
const YARD = (tag: string) => `
function setup(self) {
  const st = self.persist({ hits: [] });
  self.sink('Sink').on(function (mu) {
    st.hits.push([self.now, mu.id]);
    self.log('ARR', '${tag}', mu.id);
  });
  return { state() { return st; } };
}`;

type World = Awaited<ReturnType<typeof makeWorld>>;

// ─── Trace: every script hook dispatch, by the receiving adapter ────────────

let active: { world: World; events: ContinuationEvent[] } | null = null;
const original = RVScriptComponentAdapter.prototype.dispatchScriptHook;
vi.spyOn(RVScriptComponentAdapter.prototype, 'dispatchScriptHook').mockImplementation(function (
  this: RVScriptComponentAdapter, ...args: Parameters<RVScriptComponentAdapter['dispatchScriptHook']>) {
  if (active) {
    const src = active.world.plugin.listScriptComponents().find(s => s.adapter === this);
    active.events.push({ time: active.world.manager.currentTime, action: String(args[0]),
      componentId: src ? src.desId : 'stale', muId: -1 });
  }
  return original.apply(this, args);
});
// Sink deliveries (Phase 2) join the same trace, keyed by the listening script.
const realLog = console.log.bind(console);
vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  const i = args.indexOf('ARR');
  if (i < 0) { realLog(...args); return; }
  if (!active) return;
  const tag = String(args[i + 1]);
  const src = active.world.plugin.listScriptComponents().find(s => s.path.endsWith(`/${tag}`));
  active.events.push({ time: active.world.manager.currentTime, action: `sink:${tag}`,
    componentId: src ? src.desId : 'stale', muId: Number(args[i + 2]) });
});
afterEach(() => { active = null; });

async function buildLineWorld(): Promise<ContinuationWorld & { w: World }> {
  const w = await makeWorld({ flow: true, seed: 7, scripts: [
    { name: 'Worker', code: WORKER }, { name: 'Monitor', code: MONITOR },
    { name: 'Yard2', code: YARD('Yard2') }, { name: 'Yard1', code: YARD('Yard1') }] });
  const events: ContinuationEvent[] = [];
  active = { world: w, events };
  w.start();
  w.manager.duration = 1e6;
  await whenDocumentHashesSettled();
  return {
    w,
    runner: w.runner,
    async step(t: number) { await w.runner.fastForwardUntil(t); },
    kpis: () => ({
      Worker: w.state('Worker'), Monitor: w.state('Monitor'),
      Yard1: w.state('Yard1'), Yard2: w.state('Yard2'),
      sinkListeners: w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter.consumedListenerCount,
      // Unsorted: the collector's canonical owner order (node path) and the
      // restored per-owner key order must reproduce the uninterrupted run.
      rows: w.statRows().map(r => [r.owner, r.label, r.value]),
      sink: w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter.totalProcessed,
    }),
    trace: () => events,
  };
}

describe('plan-2212 §9.5 — WebComponent scripts in snapshot continuation', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it.each([4.5, 31])(`${mode}: identical parts, KPIs and hook trace at cut %s`, async T => {
      await assertContinuation({ buildWorld: buildLineWorld, mode, T, TPrime: T + 17, T2: T + 40 });
    });
  }

  it('a restore after reset() dispatches the snapshot\'s hooks to the rebuilt (current) VMs', async () => {
    const ref = await buildLineWorld();
    await ref.step(60);
    const expected = ref.kpis();

    const world = await buildLineWorld();
    await world.step(20);
    const saved = world.runner.fullSnapshot();
    const before = world.w.inst('Worker').adapter;
    world.w.runner.reset();                       // rebinds: every VM is rebuilt
    await whenDocumentHashesSettled();
    const rebuilt = world.w.inst('Worker').adapter;
    expect(rebuilt).not.toBe(before);
    world.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    expect(world.w.inst('Worker').adapter).toBe(rebuilt);   // restore re-uses the current VM
    const cut = world.trace().length;
    await world.step(60);
    const after = world.trace().slice(cut);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter(e => e.componentId === 'stale')).toEqual([]);
    // Sink deliveries after the restore: Yard1 before Yard2 per arrival, one each.
    const sinkTags = after.filter(e => e.action.startsWith('sink:')).map(e => e.action);
    expect(sinkTags.length).toBeGreaterThan(0);
    expect(sinkTags).toEqual(sinkTags.map((_, i) => (i % 2 === 0 ? 'sink:Yard1' : 'sink:Yard2')));
    expect(world.kpis()).toEqual(expected);
    expect(world.kpis().sinkListeners).toBe(2);
  });
});

// ─── §9.6c identity with a real NodeRegistry ────────────────────────────────

const ASSET_ROOT_ID = '0b9c1d8e-0000-4000-8000-00000000a001';
const SCRIPT_ID = '0b9c1d8e-0000-4000-8000-00000000a002';
const PLACEMENT_IDS = ['0b9c1d8e-0000-4000-8000-000000000001', '0b9c1d8e-0000-4000-8000-000000000002'];

/** Main document with two placements of the same asset; the asset holds a script node. */
function placementScene(extra?: (scene: Scene) => void): Scene {
  const scene = new Scene();
  PLACEMENT_IDS.forEach((pid, i) => {
    const ref = new Object3D(); ref.name = `Machine_${i + 1}`;
    ref.userData._layoutId = pid;
    ref.userData.realvirtual = { NodeId: pid };
    const content = new Object3D(); content.name = 'Machine';
    content.userData.realvirtual = { NodeId: ASSET_ROOT_ID };
    const script = scriptNode({ name: 'Counter', code: MONITOR });
    (script.userData.realvirtual as Record<string, unknown>).NodeId = SCRIPT_ID;
    content.add(script); ref.add(content); scene.add(ref);
  });
  extra?.(scene);
  return scene;
}

/** The production registration: main document, then each placement's occurrence. */
function registryAddresses(scene: Scene): DesAddressSource {
  const reg = new NodeRegistry();
  reg.registerDocument(scene);
  for (const ref of scene.children.filter(c => typeof c.userData._layoutId === 'string')) {
    reg.registerOccurrence(ref, ref.userData._layoutId as string);
  }
  return {
    getAddressForNode: n => reg.getAddressForNode(n),
    forEachNode: fn => scene.traverse(n => { const a = reg.getAddressForNode(n); if (a) fn(a, n); }),
  };
}

async function placementWorld(extra?: (scene: Scene) => void) {
  const w = await makeWorld({ scripts: [], scene: placementScene(extra), addresses: registryAddresses });
  w.start();
  w.manager.duration = 1e6;
  await whenDocumentHashesSettled();
  return w;
}

describe('plan-2212 §9.6c — script desIds of two placements of the same asset', () => {
  it('distinct, registered, stable over a reload; the snapshot restores across it', async () => {
    const expected = PLACEMENT_IDS.map(p => `${p}#${SCRIPT_ID}@WebComponent`).sort();
    const w1 = await placementWorld();
    const ids1 = w1.plugin.listScriptComponents().map(s => s.desId).sort();
    expect(ids1).toEqual(expected);
    await w1.runner.fastForwardUntil(23);
    const saved = JSON.parse(JSON.stringify(w1.runner.fullSnapshot()));
    expect(saved.parts.map((p: { key: string }) => p.key)).toEqual(expect.arrayContaining(expected));

    // Reload: a fresh scene (new Object3Ds, same authored ids) and a fresh registry.
    const w2 = await placementWorld();
    expect(w2.plugin.listScriptComponents().map(s => s.desId).sort()).toEqual(ids1);
    w2.runner.restoreFull(saved);
    const counters = (w: typeof w1) => w.plugin.instances.map(i => [i.nodePath, i.component!.callHandler('state').value]);
    expect(counters(w2)).toEqual(counters(w1));
    await w1.runner.fastForwardUntil(41); await w2.runner.fastForwardUntil(41);
    expect(counters(w2)).toEqual(counters(w1));
  });

  it('script desIds come from the runner address source (desAddresses ?? registry), not a second one', async () => {
    // A headless host: its NodeRegistry knows nothing, `desAddresses` addresses
    // the scene (exactly what the runner keys the material-flow components by).
    const w = await makeWorld({ scripts: [{ name: 'Counter', code: MONITOR }], flow: true });
    const viewer = w.viewer as unknown as { registry: unknown; desAddresses?: unknown };
    viewer.desAddresses = w.host.desAddresses;
    viewer.registry = { getAddressForNode: () => null };
    expect(w.plugin.listScriptComponents().map(s => s.desId)).toEqual(['#Counter@WebComponent']);
    w.start();
    await whenDocumentHashesSettled();
    expect(() => w.runner.fullSnapshot()).not.toThrow();
  });

  it('a script on a node no document registers stays a visible refusal', async () => {
    clearProblem('des-snapshot-unaddressable');
    const w = await placementWorld(scene => {
      const loose = scriptNode({ name: 'Loose', code: MONITOR });   // op-created, no identity
      scene.add(loose);
    });
    const rows = w.plugin.listScriptComponents();
    expect(rows.find(r => r.path.endsWith('Loose'))?.desId).toBeNull();
    expect(() => w.runner.fullSnapshot()).toThrow('des-snapshot-unaddressable');
    expect(getProblem('des-snapshot-unaddressable')?.detail).toContain('Loose');
  });
});
