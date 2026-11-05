// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
//
// plan-2241 Phase 2 (Codex re-check): the fleet's wait edges reach the blockage check through the
// REAL FleetPlugin registration. Its sources must carry the vehicle-endpoint domain, so DES vehicles
// meet their ledger units `des:<path>` (deadlock found, expected charge waits suppressed) while an
// MU owner keeps its MU id (no self-edge when a vehicle is named like the MU).

import { afterEach, expect, it, vi } from 'vitest';
import { Group, Scene } from 'three';
import { FleetPlugin, type FleetSceneBinder } from '../../src/plugins/fleet-plugin';
import type { PlantPluginDefinition } from '../../src/core/fleet/define-plant-plugin';
import type { FleetJobRunner } from '../../src/core/fleet/exec/job-runner';
import type { FleetKernelAdapters } from '../../src/core/fleet/exec/backends';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import { WaitWatch } from '../../src/core/fleet/exec/wait-watch';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { ReservationTable } from '../../src/core/fleet/core/reservations';
import { OrderPool } from '../../src/core/fleet/core/orders';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { BlockageWatch } from '../../src/core/diagnostics/rv-blockage-watch';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { clearAllProblems } from '../../src/core/hmi/problems-store';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { bindDes, clearShared, makeAgvRoot, makeHost } from '../helpers/agv-harness';
import type { WaitCause } from '../../src/core/fleet/exec/wait-watch';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const disposers: Array<() => void> = [];
afterEach(() => { for (const d of disposers.splice(0).reverse()) d(); clearAllProblems(); });

/** Two DES AGVs at stays that never end (armed, no progress) + the real FleetPlugin bound to them. */
async function world(names: [string, string]) {
  clearShared();
  const net = getDefaultPathNetwork();
  for (const id of ['A', 'C']) net.register(parsePathExtras({ type: 'Path', id,
    segments: [{ kind: 'line', from: [id === 'A' ? 0 : 10, 0, 0], to: [id === 'A' ? 0 : 10, 0, 3] }], successors: [] }, id)!);
  net.resolveGraph();
  for (const id of ['A', 'C']) getDefaultPathDockRegistry().register(id, { onVehicleArrive: () => {} });
  const runner = new DESRunner({ subMode: 'animated' });
  const agvHost = makeHost();
  const scene = new Scene();
  names.forEach((name, i) => {
    const root = makeAgvRoot(name, { PathId: i ? 'C' : 'A', StartPosition: 0, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
    scene.add(root); bindDes(runner, root, agvHost);
  });
  const manager = runner.getManager();
  const wiring = new ProgressWiring({ clock: { now: () => manager.currentTime }, running: () => true,
    fleet: { all: () => getDefaultAgvFleet().all() }, transport: { surfaces: [], sinks: [], mus: [] } as never,
    adapters: { surface: false, sink: false } });
  runner.start([], { root: scene, host: { ...agvHost, progressLedger: wiring.ledger, waitRegistry: wiring.waitRegistry } as never });
  await runner.kpiSourcesReady();

  // The fleet runtime with its real wait watch and reservation table; the project resolver
  // reports what the cause of each wait is (as FleetJobRunner.waitCause does).
  const causes = new Map<string, WaitCause>();
  const waitWatch = new WaitWatch({ clock: new ContinuousSimClock(), defaultLimitSec: 1e6, problems: { report() {}, clear() {} } });
  waitWatch.setResolver({ valid: () => true, detail: (vehicle, kind) => causes.get(`${vehicle}|${kind}`) });
  const reservations = new ReservationTable();
  const binder: FleetSceneBinder = {
    bindContinuous: vi.fn(() => ({ ok: false, missing: [] }) as unknown as ReturnType<FleetSceneBinder['bindContinuous']>),
    bindDes: vi.fn(() => ({ ok: true, backend: { kind: 'des', onClockRestart: null, onSnapshotRestored: null,
      attach: () => () => {}, dispose() {} } }) as unknown as ReturnType<FleetSceneBinder['bindDes']>),
    createRun: vi.fn((adapters: FleetKernelAdapters) => ({ adapters, waitWatch,
      dispatcher: { orders: new OrderPool(), station: () => ({}), reservations },
      start() {}, prepareReset() {}, dispose() {}, frame() {}, kick() {}, setRng() {}, scheduleNow() {},
    }) as unknown as FleetJobRunner),
    reconfigure: vi.fn(),
  };
  const definition: PlantPluginDefinition = { apiVersion: 1, id: 'plant', config: {}, parameters: {
    adoptDocument() {}, declare: () => ({ owner: 'plant', title: 'Plant', params: [] }), onLive() {}, async onStructuralReset() {}, dispose() {},
  } };
  const kernel = { mode: 'des', desControl: () => runner, hasDesLifecycle: () => false,
    onDesLifecycle: (fn: (e: unknown) => void, opts?: { replay?: boolean }) => {
      if (opts?.replay) fn({ type: 'bound', generation: runner.lifecycleGeneration, runnerId: 1 });
      return () => {};
    } };
  const viewer = { simulationKernel: kernel, _simLoop: {}, inStructuralEdit: false, simTime: 0,
    waitRegistry: wiring.waitRegistry, whenSceneReady: () => Promise.resolve(),
    getPlugin: () => ({ id: 'planning-parameters', registry: { declare: () => ({ values: () => ({}), get: () => undefined,
      commitPending() {}, redeclare() {}, dispose() {} }) } }),
    on: () => () => {} };
  const plugin = new FleetPlugin(definition, binder);
  plugin.init(viewer as unknown as RVViewer);
  plugin.onModelLoaded({ root: new Group() } as unknown as LoadResult);
  await settle();
  expect(binder.createRun, 'the plugin bound its fleet run').toHaveBeenCalledOnce();
  expect(wiring.waitRegistry.sources()).toEqual(expect.arrayContaining(['plant:fleet', 'plant:reservations']));

  const budgets = new BudgetResolver({ defaults: { MaxIdleSec: 10, WarmupSec: 0 } });
  const watch = new BlockageWatch(() => ({ ledger: wiring.ledger, registry: wiring.waitRegistry, budgets, now: runner.renderClock }));
  const fleet = getDefaultAgvFleet();
  const tick = () => { runner.tick(0.1); runner.lateTick(0.1); };
  disposers.push(() => { plugin.dispose(); runner.dispose(); wiring.dispose(); clearShared(); });
  for (const [name, path] of [[names[0], 'A'], [names[1], 'C']]) fleet.get(name)!.assign({ destination: path });
  return { runner, wiring, watch, fleet, waitWatch, reservations,
    wait(vehicle: string, kind: string, cause: WaitCause) { causes.set(`${vehicle}|${kind}`, cause); waitWatch.begin(vehicle, kind); },
    advance(seconds: number) { for (let i = 0; i < seconds * 10; i++) tick(); },
    edges: () => wiring.waitRegistry.collect(runner.renderClock, true).filter(e => e.kind.startsWith('fleet:') || e.kind === 'reservation') };
}

it('fleet waits through the plugin registration resolve to des:<path>: two AGVs waiting on each other are a deadlock', async () => {
  const w = await world(['V', 'W']);
  w.wait('V', 'standstill', { waitingFor: 'motion', waiterId: 'V', resourceId: 'Z1', ownerIds: ['W'] });
  w.wait('W', 'standstill', { waitingFor: 'motion', waiterId: 'W', resourceId: 'Z2', ownerIds: ['V'] });
  w.reservations.tryReserve('station', 'Dock', 'W', 0);
  w.advance(25);
  expect(w.edges().map(e => [e.waiterId, e.ownerIds])).toEqual(expect.arrayContaining([
    ['des:V', ['des:W']], ['des:W', ['des:V']], ['', ['des:W']]]));
  const findings = w.watch.inspect().findings;
  expect(findings.map(f => f.cls)).toEqual(['deadlock']);
  expect(findings[0].chain).toEqual(['des:V', 'Z1', 'des:W', 'Z2', 'des:V']);
});

it('an expected charge wait through the plugin registration still suppresses its DES vehicle', async () => {
  const w = await world(['V', 'W']);
  w.wait('V', 'charge', { waitingFor: 'a free charger', waiterId: 'V', resourceId: 'fleet:chargers', ownerIds: [] });
  w.advance(25);
  // V waits for a charger (an expected wait by default); W makes no progress without any wait.
  expect(w.watch.inspect().findings.map(f => [f.cls, f.waiterId])).toEqual([['stall', 'des:W']]);
});

it('a numeric vehicle id equal to the blocking MU id: no self-edge, no deadlock (plugin registration)', async () => {
  const w = await world(['17', 'W']);
  w.wait('17', 'target', { waitingFor: 'drop at D', waiterId: '17', resourceId: 'D', ownerIds: ['17'], ownerMUs: true });
  w.advance(25);
  expect(w.edges().map(e => [e.waiterId, e.ownerIds])).toEqual([['des:17', ['17']]]);
  expect(w.watch.inspect().findings.filter(f => f.cls === 'deadlock')).toEqual([]);
});
