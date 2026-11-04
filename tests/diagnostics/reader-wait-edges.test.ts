// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import { ChainTransferFlow } from '../../src/behaviors/ChainTransfer';
import { createBindContext, type BindContextHost } from '../../src/core/behavior-runtime';
import { createSelf, type MU } from '../../src/core/material-flow/material-flow-self';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { AABB } from '../../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { RVGrip } from '../../src/core/engine/rv-grip';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import { progressNodeId } from '../../src/core/diagnostics/rv-population-sources';
import { behaviorWaitSource, clearBehaviorWaitSources } from '../../src/core/diagnostics/rv-behavior-wait-sources';
import { classifyConnections, type SnapLite } from '../../src/behaviors/_shared/snap-graph-helpers';
import { enumerateCycles } from '../../src/core/diagnostics/rv-blockage-probes';

function reader(type: 'Conveyor' | 'ChainTransfer', mode: 'continuous' | 'des' = 'continuous') {
  const scene = new Scene(), root = new Object3D(), target = new Object3D();
  root.name = type; target.name = 'Downstream'; scene.add(root, target);
  const manager = new RVTransportManager();
  const add = (parent: Object3D, name: string) => { const n = new Object3D(); n.name = name; parent.add(n); return n; };
  const belt = add(root, 'Transport-Z');
  add(root, 'Transport-X'); add(root, 'Drive-Lin-Y'); add(root, 'Sensor');
  const downstream = add(target, 'Transport-Z');
  for (const n of [belt, downstream]) manager.surfaces.push(new RVTransportSurface(n,
    AABB.fromHalfSize(n, new Vector3(0.2, 0.1, 0.5))));
  const snaps: SnapLite[] = [
    { id: 'out', ownerRoot: root, object3D: add(root, 'Snap-ZP-convroll'), flow: 'out', pairedSnapId: 'in' },
    { id: 'in', ownerRoot: target, object3D: add(target, 'Snap-ZN-convroll'), flow: 'in', pairedSnapId: 'out' },
  ];
  const registry = { getByOwnerRoot: (r: Object3D) => snaps.filter(s => s.ownerRoot === r),
    getById: (id: string) => snaps.find(s => s.id === id) };
  const events = new EventEmitter<Record<string, unknown>>();
  const host = { signalStore: new SignalStore(), transportManager: manager,
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(), drives: [], registry: null,
    getPlugin: (id: string) => id === 'snap-point' ? { getRegistry: () => registry } : undefined,
  };
  const { ctx, handle } = createBindContext(root, host as unknown as BindContextHost, {});
  const def = (type === 'Conveyor' ? ConveyorFlow : ChainTransferFlow) as unknown as MaterialFlowDefinition;
  const self = createSelf(ctx, def, { mode, local: (def.state ?? def.local)?.() });
  def.setup?.(self);
  const wiring = new ProgressWiring({ transport: manager, fleet: { all: () => [] },
    clock: { now: () => 0 }, running: () => true });
  let activeMode: string = mode;
  wiring.waitRegistry.addSource(behaviorWaitSource(host, () => activeMode));
  const local = self.local as unknown as {
    partAtSensor: boolean; interlock: { occupied(): boolean }; state: string;
    connections: ReturnType<typeof classifyConnections>; blockedMUs: MU[];
  };
  return { self, local, host, root, target, belt, downstream, wiring, handle, def,
    setMode: (m: string) => { activeMode = m; },
    dispose() { handle.dispose(); wiring.dispose(); clearBehaviorWaitSources(host); } };
}

it('pulls the conveyor reader interlock, preserves coverage, and removes it on unbind', () => {
  const f = reader('Conveyor');
  try {
    f.local.partAtSensor = true;
    f.local.interlock = { occupied: vi.fn(() => true) };
    const before = f.wiring.sample().coverage;
    for (let i = 0; i < 120; i++) f.wiring.fixedStep();
    expect(f.local.interlock.occupied).not.toHaveBeenCalled();
    expect(f.wiring.waitRegistry.collect(0)).toContainEqual(expect.objectContaining({
      waiterId: progressNodeId(f.belt, 'surface'), resourceId: 'in',
      ownerIds: [progressNodeId(f.downstream, 'surface')], kind: 'conveyor-interlock', analysed: true,
    }));
    const coverage = f.wiring.sample().coverage;
    console.info('conveyor interlock coverage', coverage);
    expect(coverage).toEqual(before); expect(coverage.missing).toEqual([]);
    f.setMode('des'); expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
    f.setMode('continuous');
    f.handle.dispose(); expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
  } finally { f.dispose(); }
});

it('names the actual DES conveyor target recorded on refusal', () => {
  const f = reader('Conveyor', 'des');
  try {
    const mu = { id: 1 } as MU;
    f.self.downstreamCanAccept = () => false;
    const arrival = ConveyorFlow.des.onArrival;
    arrival(f.self as unknown as Parameters<typeof arrival>[0], mu);
    expect(f.wiring.waitRegistry.collect(0)).toContainEqual(expect.objectContaining({
      waiterId: 'des:Conveyor', resourceId: 'in', ownerIds: ['des:Downstream'], kind: 'conveyor-interlock',
    }));
    console.info('conveyor DES coverage (surface population)', f.wiring.sample().coverage);
    expect(f.wiring.sample().coverage.missing).toEqual([]);
    f.def.reset?.(f.self);
    expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
  } finally { f.dispose(); }
});

it('reads chain transfer per-port occupancy and clears registrations on model clear', () => {
  const f = reader('ChainTransfer');
  try {
    f.local.state = 'holding';
    f.local.connections = classifyConnections(f.host, f.root);
    f.self.signals.set('/Downstream.Flow.Occupied', true);
    f.self.signals.set('/Downstream.Flow.Occupied@in', false);
    expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
    f.self.signals.set('/Downstream.Flow.Occupied@in', true);
    expect(f.wiring.waitRegistry.collect(0)).toContainEqual(expect.objectContaining({
      waiterId: progressNodeId(f.belt, 'surface'), resourceId: 'in',
      ownerIds: [progressNodeId(f.downstream, 'surface')], kind: 'chain-transfer', analysed: true,
    }));
    console.info('chain transfer coverage', f.wiring.sample().coverage);
    expect(f.wiring.sample().coverage.missing).toEqual([]);
    const first = f.local.connections[0];
    f.local.connections.push({ ...first, snap: { ...first.snap, id: 'out2' },
      pairedSnap: { ...first.pairedSnap, id: 'in2' } });
    const alternatives = f.wiring.waitRegistry.collect(0);
    expect(alternatives).toHaveLength(2);
    expect(alternatives.every(e => !e.analysed && e.notAnalysedReason === 'alternative-outputs')).toBe(true);
    clearBehaviorWaitSources(f.host);
    expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
    f.def.setup?.(f.self); // Same viewer can bind the next model.
    expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
  } finally { f.dispose(); }
});

it('records a failed pick without making an idle empty gripper wait', () => {
  const manager = new RVTransportManager(), node = new Object3D();
  const grip = new RVGrip(node); manager.grips.push(grip);
  grip.allMUs = () => manager.mus;
  const wiring = new ProgressWiring({ transport: manager, fleet: { all: () => [] },
    clock: { now: () => 0 }, running: () => true });
  try {
    expect(wiring.waitRegistry.collect(0)).toEqual([]);
    grip.pick();
    expect(wiring.waitRegistry.collect(0)).toContainEqual(expect.objectContaining({
      waiterId: `grip:${node.uuid}`, resourceId: `part-slot:${node.uuid}`, kind: 'grip', ownerIds: [],
    }));
    const mu = new RVMovingUnit(new Object3D(), 'test', new Vector3(0.01, 0.01, 0.01));
    manager.mus.push(mu); grip.pick();
    expect(grip.grippedMUs).toEqual([mu]);
    expect(wiring.waitRegistry.collect(0)).toEqual([]);
    console.info('grip coverage (grips have no progress population in v1)', wiring.sample().coverage);
    expect(wiring.sample().coverage.missing).toEqual([]);
    grip.reset(); expect(wiring.waitRegistry.collect(0)).toEqual([]);
  } finally { grip.reset(); grip.dispose(); wiring.dispose(); }
});

it('keeps an internal surface queue out of cycle analysis and drops a removed leader', () => {
  const f = reader('Conveyor');
  try {
    const manager = f.host.transportManager;
    const ahead = new RVMovingUnit(new Object3D(), 'test');
    const behind = new RVMovingUnit(new Object3D(), 'test');
    ahead.currentSurface = behind.currentSurface = manager.surfaces[0];
    behind.blocked = true; behind.blockedBy = ahead.id;
    manager.mus.push(ahead, behind);
    const edges = f.wiring.waitRegistry.collect(0);
    expect(edges).toContainEqual(expect.objectContaining({ kind: 'surface',
      resourceId: `mu:${ahead.id}`, analysed: false, notAnalysedReason: 'shared-unit' }));
    expect(enumerateCycles(edges).cycles).toEqual([]);
    ahead.markedForRemoval = true;
    expect(f.wiring.waitRegistry.collect(0)).toEqual([]);
  } finally { f.dispose(); }
});
