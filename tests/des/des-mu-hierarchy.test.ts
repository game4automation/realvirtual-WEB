// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import {
  freeCarrierSlots,
  loadMUOnCarrier,
  topmostPickable,
} from '@rv-private/plugins/des/rv-des-component';
import { createDESMU, resetDESMUCounter, type DESMU } from '@rv-private/plugins/des/rv-des-mu';
import { migrateSnapshotToV3, type DESSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { PalletSource } from '@rv-private/plugins/des/material-flow/PalletSource';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

function makeMU(manager: DESManager, carrierType: string, capacity?: number): DESMU {
  const mu = createDESMU(manager.currentTime);
  manager.registerMU(mu);
  mu.carrierType = carrierType;
  mu.carrierCapacity = capacity;
  return mu;
}

function visual(template: string): RVMovingUnit {
  const node = new Object3D();
  node.name = template;
  node.userData.template = template;
  return new RVMovingUnit(node, template);
}

function bindContext(root: Object3D): RVBindContext {
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  const host: BindContextHost = {
    signalStore: {
      get: (name: string) => values.get(name),
      set: (name: string, value: boolean | number) => values.set(name, value),
      subscribe: () => () => {},
    } as never,
    on: (event, callback) => events.on(event, callback as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const accum: KinematicsSpec = {};
  return createBindContext(root, host, accum).ctx;
}

interface Bound {
  def: MaterialFlowDefinition;
  self: MaterialFlowSelf;
  adapter: MaterialFlowAdapter;
}

function bindStation(runner: DESRunner, type: string): Bound {
  const def = defineMaterialFlow<MaterialFlowSelf>({
    type, kind: 'station',
    schema: { MaxCapacity: { type: 'number', default: 10 } },
    continuous: {}, des: {},
  });
  const node = new Object3D(); node.name = type;
  let adapter!: MaterialFlowAdapter;
  const self = createSelf(bindContext(node), def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def, () => adapter.entityId),
    onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    spawnMU: (templateId) => runner.createMU(templateId),
    mus: () => adapter?.heldMUs as unknown as ReadonlyArray<MU> ?? [],
    downstreamFreeCapacity: (port) => adapter.downstreamFreeCapacity(port),
    reserveDownstream: (n, port, carrier) => adapter.reserveDownstream(n, port, carrier),
    reservation: (id) => adapter.reservation(id),
  });
  adapter = runner.addInstance(def, self, node);
  return { def, self, adapter };
}

function reservationLine(): { runner: DESRunner; a: Bound; b: Bound; target: Bound } {
  const runner = new DESRunner();
  const a = bindStation(runner, 'RobotA');
  const b = bindStation(runner, 'RobotB');
  const target = bindStation(runner, 'CarrierTarget');
  a.adapter.nextComponents = [target.adapter];
  b.adapter.nextComponents = [target.adapter];
  target.adapter.previousComponents = [a.adapter, b.adapter];
  runner.start([a.def, b.def, target.def], { root: new Object3D() });
  a.adapter.reconfigureCapacity(10);
  b.adapter.reconfigureCapacity(10);
  target.adapter.reconfigureCapacity(10);
  return { runner, a, b, target };
}

function bareFixture(version: 1 | 2): DESSnapshot {
  const runner = new DESRunner();
  const mu = runner.createMU();
  const snapshot = runner.fullSnapshot();
  snapshot.version = version;
  const legacy = snapshot.mus[0] as unknown as Record<string, unknown>;
  delete legacy.generation;
  delete legacy.childMUs;
  delete legacy.parentMU;
  delete legacy.visualTemplateId;
  delete snapshot.muGenerationCounters;
  if (version === 1) delete snapshot.scriptStates;
  delete snapshot.reservations;
  delete snapshot.nextReservationId;
  expect(mu.id).toBe(0);
  return snapshot;
}

beforeEach(() => {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();
});

describe('DESMU hierarchy', () => {
  it('parts onto blister onto pallet; topmostPickable returns LIFO part', () => {
    const manager = new DESManager();
    const pallet = makeMU(manager, 'pallet', 2);
    const blister = makeMU(manager, 'blister', 3);
    const first = makeMU(manager, 'part');
    const last = makeMU(manager, 'part');
    expect(loadMUOnCarrier(pallet, blister, manager)).toBe(true);
    expect(loadMUOnCarrier(blister, first, manager)).toBe(true);
    expect(loadMUOnCarrier(blister, last, manager)).toBe(true);
    expect(topmostPickable(pallet, manager)).toBe(last);
  });

  it('freeCarrierSlots respects carrierCapacity (partially filled blister)', () => {
    const manager = new DESManager();
    const blister = makeMU(manager, 'blister', 4);
    loadMUOnCarrier(blister, makeMU(manager, 'part'), manager);
    loadMUOnCarrier(blister, makeMU(manager, 'part'), manager);
    expect(freeCarrierSlots(blister)).toBe(2);
  });

  it('empty blister becomes pickable (cascade); removeEmptyCarriers=false blocks instead', () => {
    const manager = new DESManager();
    const pallet = makeMU(manager, 'pallet', 1);
    const blister = makeMU(manager, 'blister', 1);
    loadMUOnCarrier(pallet, blister, manager);
    expect(topmostPickable(pallet, manager)).toBe(blister);
    expect(topmostPickable(pallet, manager, (mu) => mu.carrierType === 'part')).toBeNull();
  });

  it('sink consumes pallet: children retire recursively, no dangling refs', () => {
    const manager = new DESManager();
    const pallet = makeMU(manager, 'pallet', 1);
    const blister = makeMU(manager, 'blister', 1);
    const part = makeMU(manager, 'part');
    loadMUOnCarrier(pallet, blister, manager);
    loadMUOnCarrier(blister, part, manager);
    manager.retireMU(pallet);
    expect(manager.getMU(pallet.id)).toBeNull();
    expect(manager.getMU(blister.id)).toBeNull();
    expect(manager.getMU(part.id)).toBeNull();
    expect(pallet.childMUs).toEqual([]);
    expect(blister.parentMU).toBeNull();
  });

  it('MuRef(id,gen): reuse never resurrects stale refs (same-run AND after snapshot restore)', () => {
    const runner = new DESRunner();
    const manager = runner.getManager();
    const parent = runner.createMU(); parent.carrierType = 'pallet';
    const first = runner.createMU();
    loadMUOnCarrier(parent, first, manager);
    const stale = { ...parent.childMUs[0] };
    manager.retireMU(first);
    const replacement = runner.createMU();
    expect(replacement.id).toBe(stale.id);
    expect(replacement.generation).toBe(stale.gen + 1);
    parent.childMUs.push(stale);
    expect(topmostPickable(parent, manager)).not.toBe(replacement);

    const snapshot = runner.fullSnapshot();
    runner.restoreFull(snapshot);
    const restoredParent = manager.getMU(parent.id) as DESMU;
    expect(restoredParent.childMUs).toEqual([]);
  });

  it('carrier reservation is atomic: two robots on same partially filled blister never oversubscribe; carrier retire releases reserved slots', () => {
    const { runner, a, b } = reservationLine();
    const manager = runner.getManager();
    const carrier = runner.createMU(); carrier.carrierType = 'blister'; carrier.carrierCapacity = 2;
    const partsA = [runner.createMU(), runner.createMU()];
    for (const part of partsA) expect(a.adapter.acceptMU(part)).toBe(true);
    const reservationA = a.self.reserveDownstream(2, undefined, {
      ref: { id: carrier.id, gen: carrier.generation }, slots: 2,
    });
    const partB = runner.createMU(); expect(b.adapter.acceptMU(partB)).toBe(true);
    expect(() => b.self.reserveDownstream(1, undefined, {
      ref: { id: carrier.id, gen: carrier.generation }, slots: 1,
    })).toThrow(/carrier capacity unavailable/);
    expect(reservationA.commitMany(partsA)).toBe(true);
    expect(carrier.childMUs).toHaveLength(2);
    expect(freeCarrierSlots(carrier)).toBe(0);

    const carrierToRetire = runner.createMU();
    carrierToRetire.carrierType = 'blister'; carrierToRetire.carrierCapacity = 1;
    const pending = b.self.reserveDownstream(1, undefined, {
      ref: { id: carrierToRetire.id, gen: carrierToRetire.generation }, slots: 1,
    });
    expect(manager.activeReservationCount).toBe(1);
    manager.retireMU(carrierToRetire);
    expect(manager.activeReservationCount).toBe(0);
    expect(pending.commitMany([partB])).toBe(false);
  });

  it('generation counters are persisted: no repeated generations after restore', () => {
    const runner = new DESRunner();
    const manager = runner.getManager();
    const first = runner.createMU();
    manager.retireMU(first);
    const second = runner.createMU();
    expect(second.generation).toBe(1);
    const snapshot = runner.fullSnapshot();
    runner.restoreFull(snapshot);
    const restored = manager.getMU(second.id) as DESMU;
    manager.retireMU(restored);
    expect(runner.createMU().generation).toBe(2);
  });

  it('guards: cycle, self-parent, stale ref skipped with warning', () => {
    const manager = new DESManager();
    const a = makeMU(manager, 'pallet');
    const b = makeMU(manager, 'blister');
    a.childMUs.push({ id: a.id, gen: a.generation }, { id: 999, gen: 4 }, { id: b.id, gen: b.generation });
    b.childMUs.push({ id: a.id, gen: a.generation });
    b.parentMU = { id: b.id, gen: b.generation };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => topmostPickable(a, manager)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('snapshot v3 round-trip: hierarchy + per-template visuals (two real templates, nested headless child materializes when uncovered)', () => {
    const disposed = { pallet: 0, part: 0 };
    const runner = new DESRunner({ subMode: 'fastforward' });
    runner.registerMuVisualFactory('pallet-template', () => visual('pallet-template'), () => { disposed.pallet++; });
    runner.registerMuVisualFactory('part-template', () => visual('part-template'), () => { disposed.part++; });
    const pallet = runner.createMU('pallet-template'); pallet.carrierCapacity = 2;
    const buried = runner.createMU('part-template');
    const top = runner.createMU('part-template');
    loadMUOnCarrier(pallet, buried, runner.getManager());
    loadMUOnCarrier(pallet, top, runner.getManager());
    const snapshot = runner.fullSnapshot();
    expect(snapshot.version).toBe(3);
    runner.restoreFull(snapshot);
    runner.setSubMode('animated');
    const restoredPallet = runner.getManager().getMU(pallet.id) as DESMU;
    const restoredBuried = runner.getManager().getMU(buried.id) as DESMU;
    const restoredTop = runner.getManager().getMU(top.id) as DESMU;
    expect(restoredPallet.visual?.getName()).toBe('pallet-template');
    expect(restoredTop.visual?.getName()).toBe('part-template');
    expect(restoredBuried.visual).toBeNull();
    runner.getManager().retireMU(restoredTop);
    expect(restoredBuried.visual?.getName()).toBe('part-template');
    expect(restoredPallet.childMUs).toEqual([{ id: buried.id, gen: buried.generation }]);
    expect(disposed.part).toBe(1);
  });

  it('unknown visualTemplateId falls back to gizmo box with warning; factory dispose counted', () => {
    const runner = new DESRunner();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = runner.createMU('missing-template');
    const alsoUnknown = runner.createMU('missing-template');
    expect(unknown.visual?.getName()).toContain('MU_Fallback_missing-template');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(alsoUnknown.visual).not.toBeNull();

    let disposed = 0;
    runner.registerMuVisualFactory('known-template', () => visual('known-template'), () => { disposed++; });
    const known = runner.createMU('known-template');
    runner.getManager().retireMU(known);
    expect(disposed).toBe(1);
    warn.mockRestore();
  });

  it('migrates v1 and v2 fixtures to v3', () => {
    for (const version of [1, 2] as const) {
      const migrated = migrateSnapshotToV3(bareFixture(version));
      expect(migrated.version).toBe(3);
      expect(migrated.mus[0]).toMatchObject({ generation: 0, childMUs: [], parentMU: null });
      expect(migrated.muGenerationCounters?.[0]).toBe(0);
      expect(migrated.reservations).toEqual([]);
      const runner = new DESRunner();
      expect(() => runner.restoreFull(migrated)).not.toThrow();
    }
  });

  it('PalletSource generates configured grid from templateRefs; reset and restore reproduce it', () => {
    const runner = new DESRunner();
    const palletDef = PalletSource as unknown as MaterialFlowDefinition;
    for (const id of ['pallet', 'blister', 'part']) {
      runner.registerMuVisualFactory(id, () => visual(id), (owned) => { owned.dispose(); });
    }
    const node = new Object3D(); node.name = 'PalletSource1';
    let adapter!: MaterialFlowAdapter;
    const self = createSelf(bindContext(node), palletDef, {
      mode: 'des',
      scheduler: runner.makeScheduler(palletDef, () => adapter.entityId),
      onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
      spawnMU: (templateId) => runner.createMU(templateId),
      mus: () => adapter?.heldMUs as unknown as ReadonlyArray<MU> ?? [],
      downstreamFreeCapacity: (port) => adapter.downstreamFreeCapacity(port),
      reserveDownstream: (n, port, carrier) => adapter.reserveDownstream(n, port, carrier),
      reservation: (id) => adapter.reservation(id),
    });
    Object.assign(self.prop, {
      PalletTemplateRef: 'pallet', BlisterTemplateRef: 'blister', PartTemplateRef: 'part',
      BlisterCount: 2, PartsPerBlister: 3, CarrierCapacity: 3,
      GridRows: 2, GridColumns: 2, GridPitch: 100,
    });
    adapter = runner.addInstance(palletDef, self, node);
    runner.start([palletDef], { root: node });
    const snapshot = runner.fullSnapshot();
    expect(snapshot.mus).toHaveLength(9);
    const pallet = runner.getManager().getMU(0) as DESMU;
    expect(pallet.childMUs).toHaveLength(2);
    const firstBlister = runner.getManager().getMUByRef(pallet.childMUs[0]) as DESMU;
    expect(firstBlister.childMUs).toHaveLength(3);
    expect(firstBlister.prop.gridPosition).toEqual([0, 0, 0]);
    const secondBlister = runner.getManager().getMUByRef(pallet.childMUs[1]) as DESMU;
    expect(secondBlister.prop.gridPosition).toEqual([0.1, 0, 0]);

    runner.reset();
    expect(runner.fullSnapshot().mus).toHaveLength(9);
    runner.restoreFull(snapshot);
    expect(runner.fullSnapshot().mus).toEqual(snapshot.mus);
  });
});
