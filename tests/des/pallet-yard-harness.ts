// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * pallet-yard-harness.ts — headless PalletYard world for the plan-612 Phase 4
 * integration tests (DES backend, CP1).
 *
 * The REAL engine pieces of the scene, bound to a REAL `DESRunner` (Animated or
 * FastForward) — without loading the 23 MB GLB:
 *   - the path graph of `layout.ts` (`buildPathGraph`, split zones) in the default network;
 *   - three Agv vehicles (`Stapler_1..3`, `agvConfigOf` — the generator's extras)
 *     with a `Lift` RVDrive and `Lift/ForkAnchor`;
 *   - two Source → Conveyor production outputs (`Pallet_A*`, `Conveyor_A*`),
 *     two Conveyor → Conveyor → Sink shipping lines (`Conveyor_V*`,
 *     `ConveyorOut_V*` (2 m, CP1c), `Sink_V*`) — every conveyor stamped as a
 *     placement root like the scene's library references (CP1d-b) — with the
 *     real Source / Conveyor definitions, six floor-slot nodes (`Slot_P*`);
 * then `bindDesYard` + `startDesRuntime` exactly as the viewer plugin does.
 * The bound-GLB counterpart (real scene, bake, all four conveyors) is
 * pallet-yard-discovery.test.ts.
 */

import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { RVSource } from '@rv/core/engine/rv-source';
import { RVDrive } from '@rv/core/engine/rv-drive';
import { parsePathExtras } from '@rv/core/engine/rv-path';
import { getDefaultPathNetwork } from '@rv/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '@rv/core/engine/rv-zone-registry';
import { ConveyorFlow } from '@rv/behaviors/Conveyor';
import Source from '@rv/behaviors/Source';
import { createSelf, type MaterialFlowSelf, type MU } from '@rv/core/material-flow/material-flow-self';
import { defineMaterialFlow, type MaterialFlowDefinition } from '@rv/core/material-flow/define-material-flow';
import { getMaterialFlow } from '@rv/core/material-flow/registry';
import { createBindContext, type KinematicsSpec } from '@rv/core/behavior-runtime';
import { SignalStore } from '@rv/core/engine/rv-signal-store';
import { testAddressRegistry } from '../helpers/test-address-registry';
import { bindDes, clearShared, makeAgvRoot, makeHost, TICK, type AgvTestHost } from '../helpers/agv-harness';
import { pathExtras } from '../../src/plugins/models/PalletYard/path-dsl.mjs';
import {
  CONVEYOR_BELT_HALF_M, CONVEYOR_LENGTH_M, CONVEYOR_OUT_LENGTH_M, CONVEYOR_SURFACE_M, FORK_SEAT_OFFSET_M, FORK_TOP_HOME_MM,
  PALLET_YARD_CONFIG, STATION_GEOMETRY, VEHICLES, agvConfigOf, buildPathGraph, conveyorOutNodeOf, conveyorZOf, headSeatOf,
  type PalletYardConfig,
} from '../../src/plugins/models/PalletYard/layout';
import { bindDesYard, startDesRuntime, type YardRun, type YardRunOptions } from '@rv/plugins/models/PalletYard/yard-runtime';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';

void Source; void ConveyorFlow;
const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;
const SourceDef = getMaterialFlow('Source') as MaterialFlowDefinition;

export type YardMode = 'animated' | 'fastforward';

export interface YardWorld {
  mode: YardMode;
  runner: DESRunner;
  root: Object3D;
  host: AgvTestHost;
  backend: DesHandoverBackend;
  rt: YardRun;
  owners: PluginOwnerRegistry;
  /** Consumed MU ids per shipping input. */
  shipped: Record<string, number[]>;
  /** Snapshot Problems reports (count). */
  snapshotReports: number;
  vehicle(id: string): { root: Object3D; anchor: Object3D; lift: RVDrive };
  slot(id: string): Object3D;
  now(): number;
  /** Advance to sim time `t` (FastForward: drain the queue; Animated: render ticks + frame). */
  runTo(t: number): void;
  /** Advance until `pred()` holds or `limit` sim seconds passed; returns true when it held. */
  runUntil(pred: () => boolean, limit: number, step?: number): boolean;
  /** Full engine reset + runtime restart (the viewer's simulation-reset / simulation-start). */
  reset(): void;
  dispose(): void;
}

function palletNode(name: string): Object3D {
  const node = new Object3D(); node.name = name;
  const deck = new Mesh(new BoxGeometry(0.8, 0.14, 1.2), new MeshStandardMaterial()); deck.name = 'Deck';
  node.add(deck);
  return node;
}

function engineSource(name: string, spawnParent: Object3D): RVSource {
  const node = palletNode(name);
  const src = new RVSource(node);
  src.ThisObjectAsMU = name;
  src.AutomaticGeneration = false;
  src.GenerateMU = false;
  src.computeSpawnConfig({ ThisObjectAsMU: name, AutomaticGeneration: false, GenerateMU: false });
  src.spawnParent = spawnParent;
  src.setTemplate(node);
  return src;
}

/** Build the yard. `opts.cfg` overrides the configuration (pauses, battery …) — the scene stays the same. */
export function buildYard(mode: YardMode, opts: { cfg?: PalletYardConfig; durationSec?: number; runtime?: YardRunOptions; snapshotAddresses?: boolean } = {}): YardWorld {
  clearShared();
  _resetDesHookCache();
  resetDESMUCounter();
  const cfg = opts.cfg ?? PALLET_YARD_CONFIG;
  const host = makeHost();
  // Snapshot tests: the SAME real SignalStore for the components and the runner topology, so Run signals travel in des.signals.
  const snapshotSignals = opts.snapshotAddresses ? new SignalStore() : null;
  if (snapshotSignals) (host as unknown as { signalStore: unknown }).signalStore = snapshotSignals;
  const net = getDefaultPathNetwork();
  const zones = getDefaultZoneRegistry();
  for (const p of buildPathGraph()) {
    const path = parsePathExtras(pathExtras(p).Path, p.id)!;
    net.register(path);
    if (path.zoneId) zones.define(path.zoneId, 1);
  }
  net.resolveGraph();

  const runner = new DESRunner(mode === 'fastforward'
    ? { subMode: 'fastforward', durationSeconds: opts.durationSec ?? 1e7 }
    : { subMode: 'animated' });
  const root = new Object3D(); root.name = 'PalletYardRoot';

  // Vehicles first (bind order = entity order, as in the scene).
  const vehicles = new Map<string, { root: Object3D; anchor: Object3D; lift: RVDrive }>();
  const drives: RVDrive[] = [];
  for (const v of VEHICLES) {
    const vroot = makeAgvRoot(v.id, agvConfigOf(v.id));
    const liftNode = new Object3D(); liftNode.name = 'Lift'; vroot.add(liftNode);
    const anchor = new Object3D(); anchor.name = 'ForkAnchor';
    anchor.position.set(0, FORK_TOP_HOME_MM / 1000, -FORK_SEAT_OFFSET_M);
    liftNode.add(anchor);
    const lift = new RVDrive(liftNode); lift.TargetSpeed = 300; lift.initDrive();
    drives.push(lift);
    root.add(vroot);
    vehicles.set(v.id, { root: vroot, anchor, lift });
    bindDes(runner, vroot, host);
    // As in the scene the vehicle's Lift drive belongs to its adapter - the snapshot (des.drives) needs it there.
    if (opts.snapshotAddresses) (runner.liveInstances.find(i => i.self.root === vroot)!.adapter as unknown as { _drives: Map<string, RVDrive> })._drives.set('Lift', lift);
  }

  // Material flow: adapters are created in this order; entity ids are read live.
  const adapters: MaterialFlowAdapter[] = [];
  const add = (def: MaterialFlowDefinition, node: Object3D, extra: Partial<Parameters<typeof createSelf>[2]> & object = {}): MaterialFlowAdapter => {
    const i = adapters.length;
    const ctx = createBindContext(node, host, {} as KinematicsSpec).ctx;
    const self = createSelf(ctx, def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def, () => adapters[i].entityId),
      onTransfer: (mu) => runner.makeTransfer(adapters[i])(mu),
      canAcceptDownstream: (mu) => adapters[i].nextComponents.length > 0 && adapters[i].nextComponents.some((c) => c.canAccept(mu as never)),
      onStatState: (n) => adapters[i].setState(n),
      // As the scene binding: the adapter's held MUs are authoritative (snapshot tests only; S10 keeps its binding).
      ...(opts.snapshotAddresses ? { mus: () => adapters[i].heldMUs as never } : {}),
      local: (def.state ?? def.local)?.(),
      ...extra,
    });
    const a = runner.addInstance(def, self as unknown as MaterialFlowSelf, node, undefined, { desId: node.name + '@' + def.type });
    adapters.push(a);
    return a;
  };
  const shipped: Record<string, number[]> = {};
  /**
   * One conveyor (`beltM` long belt along local +Z, roller top at CONVEYOR_SURFACE_M) at
   * (x, z) of the layout — the real Conveyor definition. The pallet hand-over carries a
   * LOGICAL layout pose (plan-631), so the belts stand where the scene has them.
   */
  const conveyor = (name: string, x: number, z: number, beltM: number): void => {
    const conv = new Object3D(); conv.name = name; conv.position.set(x, 0, z); root.add(conv);
    // A placement root as in the scene (CP1d-b): the conveyor's signals are scoped
    // per instance (`Conveyor_V1.Flow.Run`) — the shipping pause switches ONE input.
    conv.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'pallet-yard-harness', Locked: false } };
    const belt = new Mesh(new BoxGeometry(0.8, 0.1, beltM)); belt.name = 'Transport-Z';
    belt.position.y = CONVEYOR_SURFACE_M - 0.05; conv.add(belt);
    const sensor = new Object3D(); sensor.name = 'Sensor'; conv.add(sensor);
    conv.updateMatrixWorld(true);
    const hostConv = { ...host, drives: [{ name: 'Transport-Z', node: belt, TargetSpeed: 200 }] as never };
    const ctx = createBindContext(conv, hostConv, {} as KinematicsSpec).ctx;
    const i = adapters.length;
    const self = createSelf(ctx, ConveyorDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(ConveyorDef, () => adapters[i].entityId),
      onTransfer: (mu) => runner.makeTransfer(adapters[i])(mu),
      canAcceptDownstream: (mu) => adapters[i].nextComponents.length > 0 && adapters[i].nextComponents.some((c) => c.canAccept(mu as never)),
      onStatState: (n) => adapters[i].setState(n),
      ...(opts.snapshotAddresses ? { mus: () => adapters[i].heldMUs as never } : {}),
      local: (ConveyorDef.state ?? ConveyorDef.local)!(),
    });
    adapters.push(runner.addInstance(ConveyorDef, self, conv, undefined, { desId: conv.name + '@' + ConveyorDef.type }));
  };
  for (const s of cfg.stations) {
    if (s.kind !== 'pick' && s.kind !== 'drop') continue;
    const g = STATION_GEOMETRY.find((x) => x.id === s.id)!;
    const x = g.x, z = conveyorZOf(g);
    if (s.kind === 'pick') {
      const srcNode = new Object3D(); srcNode.name = `Pallet_${s.id}`; srcNode.position.set(...headSeatOf(g)); root.add(srcNode);
      const eng = engineSource(`Pallet_${s.id}`, root);
      const tid = `pallet:${s.id}`;
      runner.registerMuVisualFactory(tid, () => eng.spawnMU() as never, (v) => v.dispose());
      const src = add(SourceDef, srcNode, { spawnMU: () => runner.createMU(tid) as never });
      src.self.prop['AutomaticGeneration'] = false;
      src.self.prop['Interval'] = 0;
    }
    conveyor(`Conveyor_${s.id}`, x, z, 2 * CONVEYOR_BELT_HALF_M);
    if (s.kind === 'drop') {
      // The shipping line goes on: the 2 m out conveyor, then the sink (CP1c).
      conveyor(conveyorOutNodeOf(s.id), x, z + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M / 2, CONVEYOR_OUT_LENGTH_M);
      const sinkNode = new Object3D(); sinkNode.name = `Sink_${s.id}`; root.add(sinkNode);
      const list: number[] = (shipped[s.id] = []);
      const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
        type: `PalletYardTestSink_${s.id}`, kind: 'sink', schema: {}, continuous: {},
        des: { onAccept(_self, mu: MU) { list.push((mu as unknown as { id: number }).id); return true; } },
      }) as MaterialFlowDefinition;
      add(sinkDef, sinkNode);
    }
  }
  const slots = new Map<string, Object3D>();
  for (const s of cfg.stations) {
    if (s.kind !== 'buffer') continue;
    const n = new Object3D(); n.name = s.slot!; n.position.set(slots.size * 2, 0, -10); root.add(n);
    slots.set(s.id, n);
  }
  root.updateMatrixWorld(true);
  for (const v of VEHICLES) host.signalStore!.set(`${v.id}.Agv.Run`, true);
  // plan-2059 6b-2: snapshot tests need an address source on the topology host (D7); off by default so the
  // determinism / S10 tests keep their exact binding.
  runner.start([ConveyorDef, SourceDef], opts.snapshotAddresses
    ? { root: new Object3D(), host: { mainDocumentKey: null, registry: null, desAddresses: testAddressRegistry(root), drives: [], signalStore: snapshotSignals } as never }
    : { root: new Object3D() });

  const owners = new PluginOwnerRegistry();
  const r = bindDesYard({ runner, root, drives, cfg, owners });
  if (!r.ok) throw new Error(`yard bind incomplete: ${r.missing.join(', ')}`);
  const world: YardWorld = {
    mode, runner, root, host, owners, shipped, snapshotReports: 0,
    backend: r.backend,
    rt: null as unknown as YardRun,
    vehicle: (id) => vehicles.get(id)!,
    slot: (id) => slots.get(id)!,
    // Animated: the render clock (the manager clock only jumps to event times).
    now: () => (runner.subMode === 'fastforward' ? runner.getManager().currentTime : Math.max(runner.renderClock, runner.getManager().currentTime)),
    runTo(t: number): void {
      const m = runner.getManager();
      if (runner.subMode === 'fastforward') {
        if (t <= m.currentTime + 1e-9) return;
        // A no-op plugin event at `t`: the clock reaches `t` even with an empty model queue.
        world.backend.clock.schedule(t, () => {});
        // One drain (as the viewer's FastForward does), then the per-frame work.
        m.processUpTo(t, 1e8);
        world.rt.frame();
        if (m.currentTime < t - 1e-9) throw new Error(`runTo(${t}): stuck at ${m.currentTime}`);
        return;
      }
      let guard = 0;
      while (runner.renderClock < t - 1e-9) {
        runner.tick(TICK); runner.lateTick(TICK);
        world.rt.frame();
        if (++guard > (t + 10) * 120) throw new Error(`runTo(${t}): render clock stuck at ${runner.renderClock}`);
      }
    },
    runUntil(pred: () => boolean, limit: number, step = 1): boolean {
      const end = world.now() + limit;
      while (!pred()) {
        if (world.now() >= end - 1e-9) return false;
        world.runTo(Math.min(end, world.now() + step));
      }
      return true;
    },
    reset(): void {
      world.rt.prepareReset();
      runner.reset();
      for (const l of Object.values(shipped)) l.length = 0;
      if (mode === 'fastforward') runner.setSubMode('fastforward');
      world.rt.start();
    },
    dispose(): void {
      world.rt.dispose();
      runner.dispose();
      clearShared();
    },
  };
  world.rt = startDesRuntime(r.backend, () => { world.snapshotReports++; }, { ...opts.runtime, cfg });
  return world;
}

/** World pose error (m, rad) of a pallet visual against an owner node's seat (local (0, seatY, 0), identity). */
export function seatError(node: Object3D, owner: Object3D, seatY: number): { pos: number; ang: number } {
  node.updateMatrixWorld(true);
  owner.updateMatrixWorld(true);
  const seat = owner.localToWorld(new Vector3(0, seatY, 0));
  const ang = node.getWorldQuaternion(new Quaternion()).angleTo(owner.getWorldQuaternion(new Quaternion()));
  return { pos: node.getWorldPosition(new Vector3()).distanceTo(seat), ang };
}
