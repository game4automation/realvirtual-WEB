// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcSegment, RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv-private/plugins/des/des-scene-binding';
import { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { DESComponent } from '@rv-private/plugins/des/rv-des-component';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
  type Port,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { TweenRegistry } from '../../src/core/material-flow/tween-registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

function testHost(): BindContextHost {
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
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
}

function bindContext(root: Object3D): RVBindContext {
  const accum: KinematicsSpec = {};
  return createBindContext(root, testHost(), accum).ctx;
}

interface Bound {
  def: MaterialFlowDefinition;
  self: MaterialFlowSelf;
  adapter: MaterialFlowAdapter;
  node: Object3D;
}

function definition(
  type: string,
  hooks: NonNullable<MaterialFlowDefinition['des']> = {},
): MaterialFlowDefinition {
  return defineMaterialFlow<MaterialFlowSelf>({
    type,
    kind: 'station',
    schema: { MaxCapacity: { type: 'number', default: 1 } },
    continuous: {},
    des: hooks,
  });
}

function bind(runner: DESRunner, def: MaterialFlowDefinition, name: string): Bound {
  const node = new Object3D();
  node.name = name;
  const root = new Object3D();
  root.add(node);
  let adapter!: MaterialFlowAdapter;
  const self = createSelf(bindContext(node), def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def, () => adapter.entityId),
    mus: () => adapter?.heldMUs as unknown as ReadonlyArray<MU> ?? [],
    downstreamFreeCapacity: (port) => adapter.downstreamFreeCapacity(port),
    reserveDownstream: (n, port, carrier) => adapter.reserveDownstream(n, port, carrier),
    reservation: (id) => adapter.reservation(id),
    onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    spawnMU: () => runner.createMU(),
  });
  adapter = runner.addInstance(def, self, node);
  return { def, self, adapter, node };
}

function pair(
  holderHooks: NonNullable<MaterialFlowDefinition['des']> = {},
  targetHooks: NonNullable<MaterialFlowDefinition['des']> = {},
): { runner: DESRunner; holder: Bound; target: Bound } {
  const runner = new DESRunner({ subMode: 'animated' });
  const holder = bind(runner, definition('KernelHolder', holderHooks), 'Holder');
  const target = bind(runner, definition('KernelTarget', targetHooks), 'Target');
  holder.adapter.nextComponents = [target.adapter];
  target.adapter.previousComponents = [holder.adapter];
  runner.start([holder.def, target.def], { root: new Object3D() });
  holder.adapter.reconfigureCapacity(8);
  target.adapter.reconfigureCapacity(4);
  return { runner, holder, target };
}

function addMUs(runner: DESRunner, holder: Bound, count: number): MU[] {
  const mus: MU[] = [];
  for (let i = 0; i < count; i++) {
    const mu = runner.createMU();
    expect(holder.adapter.acceptMU(mu)).toBe(true);
    mus.push(mu as unknown as MU);
  }
  return mus;
}

function targetPort(target: Bound): Port {
  return {
    id: 'out-main', role: 'output', ownerRoot: target.node, ownerComponent: target.adapter,
    partnerRoot: target.node, partnerComponent: target.adapter,
    mySnapId: 'out-main', partnerSnapId: 'in-main',
    occupied: () => false, upstreamWaiting: () => false, setOccupied: () => {},
  };
}

function path(id = 'kernel-path'): RVPath {
  return new RVPath(id, [new ArcSegment(new Vector3(), 10, 0, 90, false, 'XZ')]);
}

describe('unified kernel contracts (plan-297 phase 0)', () => {
  beforeEach(() => {
    _resetDesHookCache();
    resetDESMUCounter();
    getDefaultPathNetwork().clear();
  });

  it('self.mus reflects adapter-held MUs across accept/release/restore/retire', () => {
    const { runner, holder } = pair();
    const [mu] = addMUs(runner, holder, 1);
    expect(holder.self.mus).toEqual([mu]);
    const snapshot = runner.fullSnapshot();
    holder.adapter.releaseMU(mu as never);
    expect(holder.self.currentLoad).toBe(0);
    runner.restoreFull(snapshot);
    expect(holder.self.currentLoad).toBe(1);
    const restored = holder.self.mus[0];
    holder.adapter.releaseMU(restored as never);
    runner.getManager().retireMU(restored as never);
    expect(holder.self.mus).toHaveLength(0);
  });

  it('onProcessComplete receives scheduled data payload; payload survives snapshot round-trip', () => {
    const received: unknown[] = [];
    const runner = new DESRunner({ subMode: 'animated' });
    const def = definition('PayloadStation', {
      onProcessComplete(_self, _mu, data) { received.push(data); },
    });
    const station = bind(runner, def, 'Payload');
    runner.start([def], { root: station.node });
    station.self.in(5, 'ProcessComplete', null, { phase: 'cycle', value: 7 });
    const snapshot = JSON.parse(runner.snapshotJson());
    runner.restoreFull(snapshot);
    runner.tick(6);
    expect(received).toEqual([{ phase: 'cycle', value: 7 }]);
  });

  it('seeds MaxCapacity from validated config; invalid config fails at bind (no NaN)', () => {
    const def = definition('KernelBindCapacity');
    const validScene = new Object3D();
    const validNode = new Object3D(); validNode.name = 'Capacity';
    validNode.userData.realvirtual = {
      LayoutObject: {}, KernelBindCapacity: { MaxCapacity: 6 },
    };
    validScene.add(validNode);
    const runner = new DESRunner();
    expect(bindSceneToRunner(runner, validScene, testHost())).toBe(1);
    expect(runner.liveInstances[0].adapter.MaxCapacity).toBe(6);

    const invalidScene = new Object3D();
    const invalidNode = new Object3D(); invalidNode.name = 'InvalidCapacity';
    invalidNode.userData.realvirtual = {
      LayoutObject: {}, KernelBindCapacity: { MaxCapacity: 'not-a-number' },
    };
    invalidScene.add(invalidNode);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(bindSceneToRunner(new DESRunner(), invalidScene, testHost())).toBe(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('bind error'),
        expect.objectContaining({ message: expect.stringContaining('invalid numeric config') }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('reconfigure never drops capacity below currentLoad + reservations', () => {
    const { runner, holder, target } = pair();
    addMUs(runner, target, 1);
    holder.self.reserveDownstream(2);
    expect(() => target.adapter.reconfigureCapacity(2)).toThrow(/currentLoad \+ reservations/);
    target.adapter.reconfigureCapacity(3);
  });

  it('ReservationRecord: reserve counts against capacity; commitMany atomic via given port', () => {
    const seenPorts: Array<string | undefined> = [];
    const { runner, holder, target } = pair({}, {
      onAccept(_self, _mu, port) { seenPorts.push(port?.id); return true; },
    });
    target.adapter.reconfigureCapacity(2);
    const mus = addMUs(runner, holder, 2);
    expect(holder.self.downstreamFreeCapacity(targetPort(target))).toBe(2);
    const reservation = holder.self.reserveDownstream(2, targetPort(target));
    expect(holder.self.downstreamFreeCapacity(targetPort(target))).toBe(0);
    expect(target.adapter.canAccept(runner.createMU())).toBe(false);
    expect(reservation.commitMany(mus)).toBe(true);
    expect(holder.self.currentLoad).toBe(0);
    expect(target.self.currentLoad).toBe(2);
    expect(seenPorts).toEqual(['out-main', 'out-main']);
  });

  it('commitMany partial failure rolls back completely (no half-commit)', () => {
    let calls = 0;
    const { runner, holder, target } = pair({}, {
      onAccept() { calls++; return calls < 2; },
    });
    const mus = addMUs(runner, holder, 2);
    const reservation = holder.self.reserveDownstream(2);
    expect(reservation.commitMany(mus)).toBe(false);
    expect(holder.self.currentLoad).toBe(2);
    expect(target.self.currentLoad).toBe(0);
    expect(runner.getManager().activeReservationCount).toBe(0);
  });

  it('reservation survives snapshot between reserve and commit; restore before event queue', () => {
    const { runner, holder, target } = pair();
    const mus = addMUs(runner, holder, 2);
    const id = holder.self.reserveDownstream(2).record.id;
    const snapshot = runner.fullSnapshot();
    runner.restoreFull(snapshot);
    const restored = holder.self.reservation(id);
    expect(restored?.record.state).toBe('reserved');
    expect(restored?.commitMany(holder.self.mus)).toBe(true);
    expect(target.self.currentLoad).toBe(2);
    expect(mus).toHaveLength(2);
  });

  it('rollback on reset AND on target failure re-queues holder', () => {
    let requeued = 0;
    const { runner, holder, target } = pair({ onDownstreamReady() { requeued++; } });
    holder.self.reserveDownstream(1);
    target.adapter.setFailure(true);
    expect(runner.getManager().activeReservationCount).toBe(0);
    expect(requeued).toBe(1);
    target.adapter.setFailure(false);
    holder.self.reserveDownstream(1);
    runner.clearMUs();
    expect(runner.getManager().activeReservationCount).toBe(0);
  });

  it('record retention: terminal records are purged; long-run keeps count bounded; zero after reset', () => {
    const { runner, holder } = pair();
    for (let i = 0; i < 50; i++) {
      const handle = holder.self.reserveDownstream(1);
      expect(runner.getManager().activeReservationCount).toBe(1);
      handle.rollback();
      expect(runner.getManager().activeReservationCount).toBe(0);
    }
    holder.self.reserveDownstream(1);
    runner.clearMUs();
    expect(runner.getManager().activeReservationCount).toBe(0);
  });

  it('two competing holders never oversubscribe component capacity; deterministic order', () => {
    const runner = new DESRunner();
    const first = bind(runner, definition('FirstHolder'), 'First');
    const second = bind(runner, definition('SecondHolder'), 'Second');
    const target = bind(runner, definition('SharedTarget'), 'Shared');
    first.adapter.nextComponents = [target.adapter];
    second.adapter.nextComponents = [target.adapter];
    runner.start([first.def, second.def, target.def], { root: new Object3D() });
    target.adapter.reconfigureCapacity(2);
    expect(first.self.reserveDownstream(2).record.id).toBe(1);
    expect(() => second.self.reserveDownstream(1)).toThrow(/capacity unavailable/);
  });

  it('frozen descriptors are pure JSON (action NAME, tween data); snapshot DURING failure restores remaining times and paused tweens', () => {
    const completed: unknown[] = [];
    const runner = new DESRunner();
    const def = definition('FrozenStation', {
      onProcessComplete(_self, _mu, data) { completed.push(data); },
    });
    const station = bind(runner, def, 'Frozen');
    runner.start([def], { root: station.node });
    const mu = runner.createMU();
    station.adapter.acceptMU(mu);
    const p = path(); getDefaultPathNetwork().register(p);
    station.self.in(10, 'ProcessComplete', mu as unknown as MU, {
      phase: 'transit', tween: { kind: 'path', pathRef: p.id, muId: mu.id, fromS: 0, toS: p.length },
    });
    runner.getManager().processAnimated(4);
    station.adapter.setFailure(true);
    const snapshot = runner.fullSnapshot();
    const frozen = (snapshot.components.Frozen as unknown as { frozen: unknown[] }).frozen;
    expect(() => JSON.stringify(frozen)).not.toThrow();
    expect(frozen).toEqual([expect.objectContaining({ action: 'MF.FrozenStation.ProcessComplete', remaining: 6 })]);
    runner.restoreFull(JSON.parse(JSON.stringify(snapshot)));
    station.adapter.setFailure(false);
    runner.tick(5.9);
    expect(completed).toHaveLength(0);
    runner.tick(0.2);
    expect(completed).toHaveLength(1);
  });

  it('frozen descriptor survives changed action registration order and cleared tween pool (stale-handle-free rebind)', () => {
    let completed = 0;
    const runner = new DESRunner();
    const def = definition('RebindStation', { onProcessComplete() { completed++; } });
    const station = bind(runner, def, 'Rebind');
    runner.start([def], { root: station.node });
    station.self.in(3, 'ProcessComplete', null, { phase: 'work' });
    station.adapter.setFailure(true);
    const snapshot = JSON.parse(runner.snapshotJson());
    runner.getTweenRegistry().clear();
    _resetDesHookCache();
    runner.restoreFull(snapshot);
    station.adapter.setFailure(false);
    runner.tick(3.1);
    expect(completed).toBe(1);
  });

  it('native DESComponent snapshot behavior unchanged (flat prop copy regression)', () => {
    const native = new DESComponent(new Object3D());
    native.prop.nested = { value: 1 };
    const snapshot = native.toSnapshot();
    (native.prop.nested as { value: number }).value = 2;
    expect((snapshot.prop.nested as { value: number }).value).toBe(2);
  });

  it('failure and completion at same sim time is deterministic', () => {
    const run = (): number => {
      let completed = 0;
      const runner = new DESRunner();
      const def = definition('TieStation', { onProcessComplete() { completed++; } });
      const station = bind(runner, def, 'Tie');
      runner.start([def], { root: station.node });
      station.self.in(1, 'ProcessComplete');
      runner.tick(1);
      station.adapter.setFailure(true);
      return completed;
    };
    expect(run()).toBe(1);
    _resetDesHookCache();
    expect(run()).toBe(1);
  });

  it('json path tween resolves pathRef at execution; FF-exit mid-path; snapshotJson round-trip mid-transit', () => {
    const p = path('snapshot-path'); getDefaultPathNetwork().register(p);
    const target = { position: new Vector3(), setPosition(v: Vector3) { this.position.copy(v); } };
    const registry = new TweenRegistry(4);
    registry.addPath(p, null, 0, p.length, 0, 10, 7, p.id);
    expect(registry.positionForMu(7, 5, target.position)).toBe(true);
    const expected = p.getAbsPosition(p.length / 2, new Vector3());
    expect(target.position.distanceTo(expected)).toBeLessThan(1e-9);
    const json = JSON.stringify(registry.toSnapshot());
    const restored = new TweenRegistry(4);
    restored.fromSnapshot(JSON.parse(json), () => target, (id) => getDefaultPathNetwork().get(id));
    restored.settle(5);
    expect(target.position.distanceTo(expected)).toBeLessThan(1e-9);
  });

  it('prop deep-copy: mutating prop.slots after snapshot does not alter the snapshot; prop identity preserved on restore', () => {
    const { runner, holder } = pair();
    holder.self.prop.slots = [{ id: 1 }];
    const identity = holder.self.prop;
    const snapshot = runner.fullSnapshot();
    (holder.self.prop.slots as Array<{ id: number }>)[0].id = 9;
    expect((snapshot.components.Holder.prop.slots as Array<{ id: number }>)[0].id).toBe(1);
    runner.restoreFull(snapshot);
    expect(holder.self.prop).toBe(identity);
    expect((holder.self.prop.slots as Array<{ id: number }>)[0].id).toBe(1);
  });
});
