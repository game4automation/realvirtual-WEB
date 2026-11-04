// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-681 §9.3 / §9.3b (DES) + plan-630 Phase 7 — the PalletYard size through the
// planning window, on the REAL scene: Apply at any time (also mid-run) = stop →
// structural rebuild (paths + placements, one transaction) → ONE reset → start.
//
// One viewer for the whole file (the cold load costs ~30 s): the scene is driven
// 2 → 4 → 2 → 1 → 2, plus a failing rebuild that rolls back and an apply without
// a size change that changes nothing. DES time is advanced by the test
// (`processUpTo`), the viewer loop stays paused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { structuralDerivedOwnerOf } from '../../src/core/engine/rv-structural-derived';
import { getProblems } from '../../src/core/hmi/problems-store';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard/index';
import { yardConfigOf } from '@rv/plugins/models/PalletYard/yard-runtime';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { composeYard, type YardComposition } from '../../src/plugins/models/PalletYard/yard-compose';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { clearShared } from '../helpers/agv-harness';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';

const YARD_URL = '/demo-realvirtual/PalletYard.glb';
const AVAILABLE = await devAssetAvailable(YARD_URL);
const SIZE = 'palletYard.size';

let h: TestViewerHandle;
let v: RVViewer;
let planning: PlanningParametersPlugin;
let plugin: PalletYardPlugin;
let root: Object3D;
const lifecycle: string[] = [];

const runner = (): DESRunner => v.simulationKernel!.desControl() as unknown as DESRunner;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
}
const yardRoot = (): Object3D => {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === 'PalletYardRoot') hit = n; });
  return hit!;
};
const placementIds = (): string[] => yardRoot().children
  .filter((c) => !!(c.userData?.realvirtual as Record<string, unknown> | undefined)?.AssetReference)
  .map((c) => c.name).sort();
const childNamed = (name: string): Object3D | null => yardRoot().children.find((c) => c.name === name) ?? null;

/** Advance DES time by `seconds` (one-second steps, as the spike did). */
function runDes(seconds: number): void {
  const rt = plugin.runtime!;
  const be = rt.adapters as DesHandoverBackend;
  const m = runner().getManager();
  const end = Math.ceil(m.currentTime) + seconds;
  for (let t = Math.ceil(m.currentTime) + 1; t <= end; t++) {
    be.clock.schedule(t, () => {});
    m.processUpTo(t, 1e8);
    rt.frame();
  }
}

async function apply(size: number | null) {
  if (size !== null) {
    const set = planning.registry.set(SIZE, size, 'ui');
    expect(set.ok, JSON.stringify(set)).toBe(true);
  }
  const bound0 = lifecycle.filter((e) => e === 'bound').length;
  const r = await planning.applyPendingAndReset();
  await until(() => plugin.runtime !== null, 'runtime bound after apply');
  return { r, bounds: lifecycle.filter((e) => e === 'bound').length - bound0 };
}

/** The scene equals `composeYard(n)`: placement ids, instances, paths, runtime. */
function expectYard(yard: YardComposition): void {
  expect(placementIds()).toEqual(yard.placements.map((p) => p.id).sort());
  for (const p of yard.placements) {
    const n = childNamed(p.id);
    expect(n, p.id).not.toBeNull();
    expect(v.placements.instanceOf(n!), `${p.id} materialised`).not.toBeNull();
  }
  const net = getDefaultPathNetwork();
  for (const p of yard.pathGraph) expect(net.get(p.id), `path ${p.id}`).toBeTruthy();
  expect(plugin.yard.size).toBe(yard.size);
  const rt = plugin.runtime!;
  expect(rt.vehicleIds).toEqual(yard.vehicles.map((x) => x.id));
  expect(yardConfigOf(rt).stations.filter((s) => s.kind === 'pick').map((s) => s.id)).toEqual(yard.stations.filter((s) => s.kind === 'pick').map((s) => s.id));
  // The runner bound every vehicle of this size (an Agv instance per stacker).
  const agvs = runner().liveInstances.filter((i) => (i.def as { type?: string }).type === 'Agv').length;
  expect(agvs).toBe(yard.vehicles.length);
}

beforeAll(async () => {
  if (!AVAILABLE) return;
  clearShared();
  h = await createTestViewer('webgl');
  v = h.viewer;
  v.loop.setPaused('pallet-yard-size-reset', true);
  registerAllBehaviors(v.behaviors);
  planning = new PlanningParametersPlugin();
  v.use(planning);
  plugin = new PalletYardPlugin();
  v.use(plugin);
  await v.loadModel(YARD_URL);
  await v.whenSceneReady();
  await Promise.resolve();
  root = (v as unknown as { currentModel: Object3D }).currentModel;
  v.scene.updateMatrixWorld(true);
  v.simulationKernel!.setMode('des');
  await Promise.resolve();
  v.simulationKernel!.onDesLifecycle((e) => { lifecycle.push(e.type); });
  v.resetSimulation();
  await until(() => plugin.runtime !== null, 'first bind');
}, 300_000);

afterAll(async () => { await sleep(500); h?.dispose(); clearShared(); }, 60_000);

describe.skipIf(!AVAILABLE)('PalletYard size via the planning window (plan-681 Phase 3)', () => {
  let baseline: { nodes: number; signals: number; paths: Set<string>; sigs: Set<string> };
  // The DES runner's own per-generation owner signals (`__des-owner__/…/<gen>/…`)
  // belong to the runner, not to a placement — excluded from the placement leak check.
  const signalNames = (): Set<string> => new Set([...v.signalStore!.getAllPaths().keys()].filter((k) => !k.startsWith('__des-owner__/')));
  const registryPaths = (): Set<string> => { const out = new Set<string>(); v.registry!.forEachNode((p) => out.add(p)); return out; };

  it('declares the yard parameters with size = 2 (document size) and the n = 2 instance keys', () => {
    const keys = planning.registry.list().map((p) => p.key);
    expect(keys).toContain(SIZE);
    expect(keys).toContain('palletYard.production.A2.ratePerHour');
    expect(keys).not.toContain('palletYard.production.A3.ratePerHour');
    expect(planning.registry.list().find((p) => p.key === SIZE)?.value).toBe(2);
    expect(plugin.docSize).toBe(2);
    expectYard(composeYard(2));
    baseline = { nodes: v.registry!.size.nodes, signals: v.signalStore!.size, paths: registryPaths(), sigs: signalNames() };
  });

  it('an apply without a size change rebuilds nothing and resets once', async () => {
    runDes(300);
    const { r, bounds } = await apply(null);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bounds).toBe(1);
    expect(plugin.lastMaterialize).toBeNull();
    expect(runner().getManager().currentTime).toBeLessThan(1);
    expectYard(composeYard(2));
  });

  it('setting the size while running only marks it pending — the structure does not change', () => {
    runDes(120);
    expect(planning.registry.set(SIZE, 4, 'ui').ok).toBe(true);
    expect(planning.registry.getSnapshot().pendingCount).toBe(1);
    expect(placementIds()).toEqual(composeYard(2).placements.map((p) => p.id).sort());
    expect(planning.registry.revertPending(SIZE)).toBe(true);
  });

  it('2 → 4 mid-run: one rebuild, ONE reset/bound, the yard is composeYard(4) and runs', async () => {
    runDes(600);
    const { r, bounds } = await apply(4);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bounds).toBe(1);
    expectYard(composeYard(4));
    expect(plugin.lastMaterialize?.pathsReplaced).toBe(true);
    // derived = transient: the new conveyor is locked, the untouched loaded one is not
    expect(structuralDerivedOwnerOf(childNamed('Conveyor_V3'))).toBe('palletYard');
    expect(structuralDerivedOwnerOf(childNamed('Conveyor_V1'))).toBeNull();
    // instance keys of size 4
    expect(planning.registry.list().map((p) => p.key)).toContain('palletYard.production.A4.ratePerHour');
    expect(getProblems().filter((p) => p.code === 'path-id-collision')).toEqual([]);
    // A runtime stacker is wired like a loaded one: same components on the
    // reference node, same Signals container below it.
    const reg = v.registry!;
    const typesAt = (name: string) => [...reg.getComponentsAt(reg.getPathForNode(childNamed(name)!)!).keys()].sort();
    const kids = (name: string) => childNamed(name)!.children.map((c) => c.name).sort();
    expect({ types: typesAt('Stapler_4'), kids: kids('Stapler_4') }).toEqual({ types: typesAt('Stapler_1'), kids: kids('Stapler_1') });
    runDes(3600);
    const rt = plugin.runtime!;
    expect(rt.counters.picks).toBeGreaterThan(0);
    expect(rt.counters.delivered).toBeGreaterThan(0);
    expect(rt.jobLog.some((j) => /:pick:A[34]>/.test(j)), rt.jobLog.slice(0, 20).join(' ')).toBe(true);
  }, 240_000);

  it('4 → 2: back to composeYard(2), the removed placements leave no registry nodes or signals behind', async () => {
    const { r, bounds } = await apply(2);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bounds).toBe(1);
    expectYard(composeYard(2));
    const now = registryPaths();
    const extra = [...now].filter((x) => !baseline.paths.has(x));
    const gone = [...baseline.paths].filter((x) => !now.has(x));
    expect({ extra: extra.slice(0, 30), gone: gone.slice(0, 30) }).toEqual({ extra: [], gone: [] });
    expect(v.registry!.size.nodes).toBe(baseline.nodes);
    const sigNow = signalNames();
    expect({ extraSignals: [...sigNow].filter((x) => !baseline.sigs.has(x)).slice(0, 30) }).toEqual({ extraSignals: [] });
    expect(sigNow.size).toBe(baseline.sigs.size);
    runDes(1200);
    expect(plugin.runtime!.counters.picks).toBeGreaterThan(0);
  }, 240_000);

  it('2 → 1 and back to 2', async () => {
    let res = await apply(1);
    expect(res.r.ok, JSON.stringify(res.r)).toBe(true);
    expectYard(composeYard(1));
    runDes(1200);
    expect(plugin.runtime!.counters.picks).toBeGreaterThan(0);
    res = await apply(2);
    expect(res.r.ok, JSON.stringify(res.r)).toBe(true);
    expectYard(composeYard(2));
  }, 240_000);

  it('a rebuild that fails half-way rolls back to the previous size in the same transaction (A3), one reset', async () => {
    const structural = v.structural as unknown as { place: (spec: { name: string }) => Promise<Object3D> };
    const place = structural.place;
    structural.place = (spec) => (spec.name === 'Conveyor_V3'
      ? Promise.reject(new Error('test: asset refused'))
      : place(spec as never));
    try {
      const { r, bounds } = await apply(3);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('materialize-failed');
      expect(bounds).toBe(1);
      expectYard(composeYard(2));
      // the value is pending again, not committed
      const size = planning.registry.list().find((p) => p.key === SIZE)!;
      expect(size.value).toBe(2);
      expect(size.pending).toBe(3);
    } finally {
      structural.place = place;
    }
    // the same apply again, with the asset loadable → success
    const again = await apply(null);
    expect(again.r.ok, JSON.stringify(again.r)).toBe(true);
    expectYard(composeYard(3));
    const back = await apply(2);
    expect(back.r.ok).toBe(true);
    expectYard(composeYard(2));
  }, 240_000);
});

describe.skipIf(!AVAILABLE)('PalletYard planning parameters in DES (plan-630 Phase 7, 9.8 / 9.9)', () => {
  const setAll = async (values: Record<string, unknown>) => {
    const r = planning.registry.setMany(values, 'ui');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const a = await apply(null);
    expect(a.r.ok, JSON.stringify(a.r)).toBe(true);
  };

  it('V2 switched off: no order goes to V2, V1 and both outputs keep working', async () => {
    await setAll({ 'palletYard.station.V2.active': false });
    runDes(3600);
    const rt = plugin.runtime!;
    expect(yardConfigOf(rt).stations.some((s) => s.id === 'V2')).toBe(false);
    expect(rt.jobLog.some((j) => />V2$/.test(j))).toBe(false);
    expect(rt.jobLog.some((j) => />V1$/.test(j))).toBe(true);
    expect(rt.jobLog.some((j) => /:pick:A1>/.test(j)) && rt.jobLog.some((j) => /:pick:A2>/.test(j))).toBe(true);
    await setAll({ 'palletYard.station.V2.active': true });
  }, 240_000);

  it('one floor slot per module: only P1 and P4 are ever used', async () => {
    await setAll({ 'palletYard.buffer.slotsPerModule': 1 });
    runDes(3600);
    const rt = plugin.runtime!;
    expect(yardConfigOf(rt).stations.filter((s) => s.kind === 'buffer').map((s) => s.id)).toEqual(['P1', 'P4']);
    expect(rt.counters.bufferPeak).toBeLessThanOrEqual(2);
    expect(rt.jobLog.some((j) => />P[2356]$|:retrieve:P[2356]>/.test(j))).toBe(false);
    await setAll({ 'palletYard.buffer.slotsPerModule': 3 });
  }, 240_000);

  // Determinism of two runs WITH the same change (9.9) needs one process per run —
  // two runs inside one process are not comparable (plan-559 M3 note, shared
  // singleton state); that comparison is a measurement, not this suite.
  it('live load change at a sim instant: applied on the clock, logged, the takt follows', async () => {
    const a = await apply(null);
    expect(a.r.ok).toBe(true);
    runDes(1800);
    expect(planning.registry.set('palletYard.production.A1.ratePerHour', 70, 'ui').ok).toBe(true);
    runDes(5);
    const log = planning.registry.changeLog().filter((c) => c.key === 'palletYard.production.A1.ratePerHour');
    expect(log.length).toBe(1);
    expect(log[0].simTime).toBeGreaterThanOrEqual(1800);
    expect(log[0].simTime).toBeLessThan(1802);
    expect(yardConfigOf(plugin.runtime!).production.intervalPerOutput?.[0]).toBeCloseTo(3600 / 70, 9);
    expect(planning.registry.list().find((p) => p.key === 'palletYard.production.A1.ratePerHour')?.value).toBe(70);
    expect(planning.registry.set('palletYard.production.A1.ratePerHour', 40, 'ui').ok).toBe(true);
    runDes(5);
  }, 240_000);

  it('0 Pal/h stops an output (no takt, nothing released when its head frees)', async () => {
    const a = await apply(null);
    expect(a.r.ok).toBe(true);
    runDes(600);
    expect(planning.registry.set('palletYard.production.A2.ratePerHour', 0, 'ui').ok).toBe(true);
    runDes(5);
    const rt = plugin.runtime!;
    const be = rt.adapters as DesHandoverBackend;
    const before = be.sourceOf('A2') ? rt.counters.produced : 0;
    const producedA2 = () => rt.jobLog.filter((j) => /:pick:A2>/.test(j)).length;
    const picksBefore = producedA2();
    runDes(3600);
    // At most the one pallet already waiting at the head may still be picked.
    expect(producedA2() - picksBefore).toBeLessThanOrEqual(1);
    expect(rt.counters.produced).toBeGreaterThan(before);       // A1 keeps producing
    expect(planning.registry.set('palletYard.production.A2.ratePerHour', 40, 'ui').ok).toBe(true);
  }, 240_000);
});
