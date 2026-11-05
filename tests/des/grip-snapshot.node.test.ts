// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import { RVGrip } from '../../src/core/engine/rv-grip';
import { RVSensor } from '../../src/core/engine/rv-sensor';
import { AABB } from '../../src/core/engine/rv-aabb';
import { RVZone } from '../../src/core/engine/rv-zone';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import { RVLogicEngine } from '../../src/core/engine/rv-logic-engine';
import { RVGripPick, RVSerialContainer, RVWaitForSensor, RVWaitForZone, StepState } from '../../src/core/engine/rv-logic-step';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import * as slots from '../../src/core/engine/rv-slot-io';
import { clearAllProblems } from '../../src/core/hmi/problems-store';
import { addGripHeldListener, gripKeyTable, zoneKeyTable, gripSnapshotParticipant } from '../../src/plugins/des/rv-des-grip-snapshot';
import { logicEventParticipant } from '../../src/plugins/des/rv-des-logic';
import * as takt from '../../src/plugins/des/rv-des-core-takt';
import { logicCyclePolled, logicDesFindings } from '../../src/plugins/des/rv-des-logic-check';
import { toSnapshotData } from '../../src/plugins/des/rv-snapshot-contract';
import { registerAction } from '../../src/plugins/des/rv-des-named-actions';
import { NO_ENTITY, NO_MU } from '../../src/plugins/des/rv-des-event';
import type { SnapshotJson } from '../../src/core/sdk/rv-snapshot-contract-types';
import { compareFullSnapshots } from '../helpers/des-continuation-harness';
import { cycleRunnerFixture } from './cycle-runner-fixture';

const cleanup: (() => void)[] = [];
const heldActions = new WeakMap<object, () => void>();
const heldAction = registerAction('Test.GripHeld', ctx => heldActions.get(ctx.manager)?.());
afterEach(() => { cleanup.splice(0).reverse().forEach(off => off()); vi.restoreAllMocks(); clearAllProblems(); });
const fields = (owner: object) => owner as Record<string, unknown>;
const node = (name: string) => { const n = new Object3D(); n.name = name; return n; };
const mu = () => new RVMovingUnit(node('Part'), 'test', new Vector3(0.01, 0.01, 0.01));

function world(options: { empty?: boolean; logic?: 'GripPick' | 'GripPlace'; initial?: boolean;
  oneBit?: boolean; invert?: boolean; core?: boolean; unwired?: boolean } = {}) {
  const transport = {
    grips: [] as RVGrip[], zones: new Set<RVZone>(), sources: [], mus: [] as RVMovingUnit[],
    surfaces: [], gripTargets: [], hasVanishingMU: false, updateTextureAnimations() {},
  };
  const w = cycleRunnerFixture({ core: options.core, cycleTime: 0.25, host: { transportManager: transport } });
  w.signalStore.register('pick', 'Root/Pick', options.initial ?? false, 'PLCOutputBool');
  w.signalStore.register('place', 'Root/Place', options.initial ?? false, 'PLCOutputBool');
  w.signalStore.register('activate', 'Root/Activate', options.initial ?? false, 'PLCOutputBool');
  w.signalStore.register('occupied', 'Root/Occupied', false, 'PLCInputBool');
  const grip = new RVGrip(node('Grip')), zone = new RVZone(node('Zone'));
  w.scene.add(grip.node, zone.node);
  grip.SignalPick = 'Root/Pick'; grip.SignalPlace = 'Root/Place';
  zone.Activation = 'Signal'; zone.ActivationSignal = 'Root/Activate'; zone.SignalOccupied = 'Root/Occupied';
  grip.OneBitControl = options.oneBit ?? false;
  zone.InvertSignal = options.invert ?? false;
  if (options.unwired) { grip.SignalPick = null; grip.SignalPlace = null; zone.ActivationSignal = null; }
  const context = { signalStore: w.signalStore, transportManager: transport, scene: w.scene, root: w.scene } as unknown as ComponentContext;
  if (!options.empty) {
    grip.init(context); zone.init(context);
    cleanup.push(() => { grip.dispose(); zone.dispose(); });
  }
  let engine: RVLogicEngine | undefined, root: RVSerialContainer | undefined;
  if (options.logic) {
    const sequence = node('Sequence'); sequence.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const step = node('Subject'); step.userData.realvirtual = { [`LogicStep_${options.logic}`]: {
      Grip: { type: 'ComponentReference', path: 'Root/Grip', componentType: 'Grip' }, Blocking: true,
    } };
    sequence.add(step); w.scene.add(sequence);
    const registry = new NodeRegistry();
    w.scene.traverse(n => registry.registerNode(n === w.scene ? 'Root' : `Root/${NodeRegistry.computeNodePath(n)}`, n));
    registry.register('Grip', 'Root/Grip', grip);
    engine = RVLogicEngine.build(w.scene, registry, w.signalStore);
    root = engine.roots[0] as RVSerialContainer; root.autoLoop = false;
    w.host.logicEngine = engine;
  }
  w.start();
  const host = { grips: () => transport.grips, zones: () => [...transport.zones] };
  const participant = () => gripSnapshotParticipant(host, n => w.host.desAddresses.getAddressForNode(n));
  return { ...w, transport, grip, zone, context, engine, root, participant };
}

function setState(w: ReturnType<typeof world>) {
  w.grip.pick(); // No MU: a real waiting pick.
  w.signalStore.set('pick', true); w.signalStore.set('place', true); w.signalStore.set('activate', true);
  Object.assign(w.grip, { _pickObjectsBefore: true, _placeObjectsBefore: true, _velSamples: 2 });
  w.grip.velocity.set(-0, 2, 3);
  (fields(w.grip)._velPrev as Vector3).set(4, 5, 6);
  (fields(w.grip)._velCur as Vector3).set(7, 8, 9);
  Object.assign(w.zone, { active: true, occupied: true, _wasActive: true, _prevAxisPos: NaN, _released: true, _releaseUsed: true });
}

describe('core.grip scalar snapshots', () => {
  it('classifies every own grip and zone key after init wiring, with disjoint tables', () => {
    const w = world();
    for (const [owner, table] of [[w.grip, gripKeyTable], [w.zone, zoneKeyTable]] as const) {
      const declared = [...table.stateKeys, ...table.held, ...table.services];
      expect(new Set(declared)).toEqual(new Set(Reflect.ownKeys(owner)));
      expect(new Set(declared).size).toBe(declared.length);
    }
    expect(() => w.runner.fullSnapshot()).not.toThrow();
  });

  it.each(['A', 'B'] as const)('restores waiting grip and zone history from JSON (%s)', mode => {
    const a = world(); setState(a);
    const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot()));
    const b = mode === 'A' ? a : world();
    b.signalStore.set('pick', false); b.signalStore.set('place', false); b.signalStore.set('activate', false);
    Object.assign(b.grip, { waitingForPart: false, _pickObjectsBefore: false, _placeObjectsBefore: false, _velSamples: 9 });
    b.grip.velocity.set(0, 0, 0);
    (fields(b.grip)._velPrev as Vector3).set(0, 0, 0);
    (fields(b.grip)._velCur as Vector3).set(0, 0, 0);
    Object.assign(b.zone, { active: false, occupied: false, _wasActive: false, _prevAxisPos: 7, _released: false, _releaseUsed: false });
    const velocity = b.grip.velocity;
    b.runner.restoreFull(saved);
    expect(fields(b.grip).waitingForPart).toBe(true);
    expect(b.grip.pickObjects).toBe(true); expect(b.grip.placeObjects).toBe(true);
    expect(fields(b.grip)._pickObjectsBefore).toBe(true); expect(fields(b.grip)._placeObjectsBefore).toBe(true);
    expect(b.grip.velocity).toBe(velocity); expect(Object.is(velocity.x, -0)).toBe(true);
    expect(fields(b.zone)._signalLevel).toBe(true); expect(fields(b.zone)._activationBound).toBe(true);
    expect(b.zone.occupied).toBe(true); expect(fields(b.zone)._prevAxisPos).toBeNaN();
    compareFullSnapshots(saved, b.runner.fullSnapshot());
    b.signalStore.set('pick', false); b.signalStore.set('activate', false);
    expect(b.grip.pickObjects).toBe(false); expect(fields(b.zone)._signalLevel).toBe(false);
  });

  it.each([
    { initial: false }, { initial: true }, { initial: true, oneBit: true },
    { initial: false, oneBit: true, invert: true }, { initial: true, invert: true },
    { initial: false, core: false }, { initial: true, unwired: true },
  ])('cold-resets each replication to fresh grip/zone state using current signals: %j', options => {
    const a = world(options);
    // Signals survive runner reset; compare with a fresh load at those same levels.
    const b = world({ ...options, initial: !options.initial });
    const capture = (w: ReturnType<typeof world>) => w.runner.fullSnapshot().parts.find(p => p.key === 'core.grip');
    for (let replication = 0; replication < 2; replication++) {
      a.manager.processAnimated(0);
      setState(a);
      for (const name of ['pick', 'place', 'activate']) a.signalStore.set(name, !options.initial);
      if (options.unwired) { a.grip.pickObjects = true; a.grip.placeObjects = true; }
      expect(fields(a.grip).waitingForPart).toBe(true);
      a.runner.reset();
      expect(fields(a.grip).waitingForPart).toBe(false);
      expect(capture(a)).toEqual(capture(b));
    }
  });

  it('re-derives grip/zone levels after core signal reapply and before restarting logic', () => {
    const w = world({ logic: 'GripPick', oneBit: true, invert: true });
    w.engine!.start(false); w.manager.processAnimated(0);
    setState(w);
    for (const name of ['pick', 'place', 'activate']) w.signalStore.set(name, false);
    Object.assign(w.host, { signalReapply: { reapplyAll: () => {
      for (const name of ['pick', 'place', 'activate']) w.signalStore.set(name, true);
    } } });
    const pick = w.grip.pick.bind(w.grip);
    const restartPick = vi.spyOn(w.grip, 'pick').mockImplementation(() => {
      expect(fields(w.grip).waitingForPart).toBe(false);
      expect(w.grip.pickObjects).toBe(true); expect(w.grip.placeObjects).toBe(true);
      expect(fields(w.zone)._signalLevel).toBe(true);
      expect(w.zone.active).toBe(false); expect(w.zone.occupied).toBe(false);
      pick();
    });
    w.runner.reset();
    expect(restartPick).toHaveBeenCalledOnce();
    expect(fields(w.grip).waitingForPart).toBe(true); // A new pick from the restarted root.
    w.manager.processAnimated(0);
    expect(w.pending('Core.Cycle')).toEqual([]);
  });

  it('keeps a grip command issued during startup (cold reset runs before start)', () => {
    const w = world();
    const start = w.runner.start.bind(w.runner);
    // Stands in for a material definition whose setup() picks.
    vi.spyOn(w.runner, 'start').mockImplementation((defs, topology) => { start(defs, topology); w.grip.pick(); });
    for (let replication = 0; replication < 2; replication++) {
      w.runner.reset();
      expect(fields(w.grip).waitingForPart).toBe(true);
    }
  });

  it.each(['grip-MU', 'grip-warning', 'zone-MU', 'zone-token'])('refuses capture and restore with addressed %s', kind => {
    const w = world(), saved = w.runner.fullSnapshot(), part = mu();
    if (kind === 'grip-MU') w.grip.grippedMUs.push(part);
    if (kind === 'grip-warning') (fields(w.grip)._seatProblemIds as Set<string>).add('seat');
    if (kind === 'zone-MU') w.zone.held.push(part);
    if (kind === 'zone-token') fields(w.zone)._token = part;
    const reason = `${kind.startsWith('grip') ? 'Grip #Grip' : 'Zone #Zone'} holds 1 MU (needs DES MU activation, plan-519)`;
    for (const action of [() => w.runner.fullSnapshot(), () => w.runner.restoreFull(saved)]) {
      expect(action).toThrow('des-snapshot-unsupported-component'); expect(action).toThrow(reason);
    }
    expect(w.host.snapshotBlockers.batchHazards()).toEqual([]);
    w.grip.grippedMUs.length = 0; w.zone.held.length = 0; fields(w.zone)._token = null;
    (fields(w.grip)._seatProblemIds as Set<string>).clear();
    w.runner.restoreFull(saved); compareFullSnapshots(saved, w.runner.fullSnapshot());
  });

  it.each(['grip', 'zone'] as const)('rejects new own %s fields through owners()', kind => {
    const w = world();
    Object.defineProperty(w[kind], 'newState', { value: 1 });
    expect(() => w.runner.fullSnapshot()).toThrow(/des-state-not-declared: core.grip.*newState/);
  });

  it.each(['unknown-address', 'missing-address', 'missing-owner', 'extra-field', 'missing-field',
    'boolean', 'number', 'vector', 'vector-nonfinite', 'vector-sparse', 'zone-infinity', 'unordered'])('rejects %s atomically', kind => {
    const w = world(); setState(w);
    if (kind === 'unordered') {
      const other = new RVGrip(node('Another')); w.scene.add(other.node); w.transport.grips.push(other);
    }
    const saved = w.runner.fullSnapshot(), bad = structuredClone(saved);
    const dto = bad.parts.find(p => p.key === 'core.grip')!.state as {
      grips: { address?: string; state: Record<string, SnapshotJson> }[];
      zones: { address: string; state: Record<string, SnapshotJson> }[];
    };
    const row = dto.grips[0];
    if (kind === 'unknown-address') row.address = '#Unknown';
    if (kind === 'missing-address') delete row.address;
    if (kind === 'missing-owner') dto.zones.pop();
    if (kind === 'extra-field') row.state.newState = 1;
    if (kind === 'missing-field') delete row.state.waitingForPart;
    if (kind === 'boolean') row.state.pickObjects = 1;
    if (kind === 'number') row.state._velSamples = false;
    if (kind === 'vector') row.state.velocity = [1, 2];
    if (kind === 'vector-nonfinite') row.state.velocity = [1, 2, { $num: 'NaN' }];
    if (kind === 'vector-sparse') row.state.velocity = new Array<SnapshotJson>(3);
    if (kind === 'zone-infinity') dto.zones[0].state._prevAxisPos = { $num: 'Infinity' };
    if (kind === 'unordered') dto.grips.reverse();
    expect(() => w.runner.restoreFull(bad)).toThrow(/des-snapshot-contract/);
    compareFullSnapshots(saved, w.runner.fullSnapshot());
  });

  it('rejects unaddressable and duplicate inventory entries', () => {
    const w = world(), host = { grips: () => [w.grip], zones: () => [w.zone] };
    expect(() => gripSnapshotParticipant(host, () => null).capture()).toThrow(/des-snapshot-unaddressable/);
    expect(() => gripSnapshotParticipant(host, () => '#Same').capture()).toThrow(/des-snapshot-contract: core.grip: duplicate/);
  });

  it('validates before commit and writes fields without listeners or signal/slot writes', () => {
    const w = world(); setState(w);
    const p = w.participant(), json = toSnapshotData(p.capture(), { participant: p.key, ...p.schema });
    expect(p.validate(json)).toEqual([]);
    const prepared = p.prepare(json), occupied = vi.fn(), held = vi.fn(), writes = vi.fn();
    cleanup.push(w.zone.addOccupiedListener(occupied), addGripHeldListener(w.grip, held), w.signalStore.observeWrites(writes));
    const slotWrite = vi.spyOn(slots, 'slotWrite');
    const setOccupied = vi.spyOn(w.zone as unknown as { setOccupied(v: boolean): void }, 'setOccupied');
    w.zone.occupied = false; w.grip.velocity.set(1, 1, 1);
    p.commit(prepared);
    expect(w.zone.occupied).toBe(true); expect(w.grip.velocity.toArray()).toEqual([-0, 2, 3]);
    for (const spy of [occupied, held, writes, slotWrite, setOccupied]) expect(spy).not.toHaveBeenCalled();
    expect(p.dependencies).toEqual(['des.signals']);
    expect(p.onRestore).toBeUndefined();
  });

  it('reads placements fresh, omits empty inventories, and detaches the blocker', () => {
    const w = world({ empty: true });
    const hasPart = () => w.runner.fullSnapshot().parts.some(p => p.key === 'core.grip');
    expect(hasPart()).toBe(false);
    w.transport.grips.push(w.grip); expect(hasPart()).toBe(true);
    const other = new RVGrip(node('Another')); w.scene.add(other.node); w.transport.grips.push(other);
    const data = w.runner.fullSnapshot().parts.find(p => p.key === 'core.grip')!.state as { grips: { address: string }[] };
    expect(data.grips.map(g => g.address)).toEqual(['#Another', '#Grip']);
    w.transport.grips.length = 0; expect(hasPart()).toBe(false);
    w.transport.zones.add(w.zone); expect(hasPart()).toBe(true);
    w.runner.clearMUs();
    w.zone.held.push(mu()); expect(w.host.snapshotBlockers.reasons()).toEqual([]);
    expect(hasPart()).toBe(false); w.zone.held.length = 0;
  });
});

describe('grip held-set wake', () => {
  it.each(['GripPick', 'GripPlace'] as const)('finishes blocking %s at the held event without Core.Cycle', type => {
    const w = world({ logic: type }), part = mu(); w.scene.add(part.node);
    if (type === 'GripPlace') {
      w.grip.grippedMUs.push(part); part.heldBy = 'grip';
      vi.spyOn(w.grip, 'place').mockImplementation(() => {});
    }
    w.engine!.start(false); w.manager.processAnimated(0);
    const step = w.root!.children[0];
    expect(step.state).toBe(StepState.Waiting);
    expect(logicCyclePolled(step, w.engine!)).toBe(false);
    w.root!.autoLoop = true;
    expect(logicDesFindings(w.engine!).filter(f => f.severity === 'error')).toEqual([]);
    w.root!.autoLoop = false;
    expect(w.pending()).toEqual([]);
    if (type === 'GripPick') {
      expect(w.engine!.snapshotBlockerReason()).toBeNull();
      const saved = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
      w.runner.restoreFull(saved); // Restore reattaches the held listener.
      expect(w.grip.onHeldChange).toBeTypeOf('function');
    }
    const finish = vi.spyOn(step as unknown as { finish(): void }, 'finish');
    heldActions.set(w.manager, () => {
      expect(step.state).toBe(StepState.Waiting);
      if (type === 'GripPick') { w.grip.allMUs = () => [part]; w.grip.pick(); }
      else w.grip.onMUDisposed(part);
    });
    w.manager.scheduleEventByIndex(2.5, heldAction, NO_ENTITY, NO_MU);
    w.manager.processAnimated(2.5);
    expect(w.manager.currentTime).toBe(2.5); expect(step.state).toBe(StepState.Finished);
    expect(finish).toHaveBeenCalledOnce(); expect(w.root!.state).toBe(StepState.Finished);
    expect(w.root!.minCycleTime).toBe(2.5); expect(w.pending()).toEqual([]);
    w.grip.onMUDisposed(part);
    w.runner.clearMUs();
    expect(w.grip.onHeldChange).toBeNull();
  });

  it('notifies each held-set mutation once and supports unsubscribe', () => {
    const grip = new RVGrip(node('Standalone')), part = mu(), listener = vi.fn();
    grip.allMUs = () => [part]; grip.PlaceMode = 'Static';
    const off = addGripHeldListener(grip, listener);
    grip.pick(); expect(listener).toHaveBeenCalledTimes(1);
    grip.releaseForTakeover(part); expect(listener).toHaveBeenCalledTimes(2);
    grip.pick(); grip.place(); expect(listener).toHaveBeenCalledTimes(4);
    grip.pick(); grip.onMUDisposed(part); expect(listener).toHaveBeenCalledTimes(6);
    grip.pick(); grip.reset(); expect(listener).toHaveBeenCalledTimes(8);
    grip.reset(); expect(listener).toHaveBeenCalledTimes(9);
    off(); grip.pick(); expect(listener).toHaveBeenCalledTimes(9);
    expect(grip.onHeldChange).toBeNull();
  });

  it('multiplexes listeners and removes the dispatcher only after the last unsubscribe', () => {
    const grip = new RVGrip(node('Standalone')), first = vi.fn(), second = vi.fn();
    const offFirst = addGripHeldListener(grip, first), dispatcher = grip.onHeldChange;
    const offSecond = addGripHeldListener(grip, second);
    expect(grip.onHeldChange).toBe(dispatcher);
    grip.reset();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    offFirst(); grip.reset();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
    expect(grip.onHeldChange).toBe(dispatcher);
    offSecond(); offFirst();
    expect(grip.onHeldChange).toBeNull();
    const offAgain = addGripHeldListener(grip, first);
    grip.reset(); expect(first).toHaveBeenCalledTimes(2);
    offAgain(); expect(grip.onHeldChange).toBeNull();
  });

  it('rejects a foreign held callback without overwriting it', () => {
    const grip = new RVGrip(node('Standalone')), foreign = vi.fn();
    grip.onHeldChange = foreign;
    expect(() => addGripHeldListener(grip, vi.fn())).toThrow(/des-snapshot-contract: core.grip: foreign onHeldChange/);
    expect(grip.onHeldChange).toBe(foreign);
  });
});


describe('atomic logic wake listener attachment', () => {
  function attachmentWorld() {
    const w = cycleRunnerFixture();
    const a = new RVGrip(node('A')), b = new RVGrip(node('B'));
    const sensorNode = node('Sensor');
    const sensor = new RVSensor(sensorNode, AABB.fromHalfSize(sensorNode, new Vector3(1, 1, 1)));
    const zone = new RVZone(node('Zone'));
    w.scene.add(a.node, b.node, sensorNode, zone.node);
    const engine = RVLogicEngine.build(w.scene, new NodeRegistry(), w.signalStore);
    engine.roots.push(new RVSerialContainer([
      new RVWaitForSensor(sensor, true), new RVWaitForZone(zone, true),
      new RVGripPick(a, true), new RVGripPick(b, true),
    ], false));
    w.host.logicEngine = engine;
    const realAdd = takt.addArrivedListener, arrivedOff: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(takt, 'addArrivedListener').mockImplementation((host, fn) => {
      const off = vi.fn(realAdd(host, fn)); arrivedOff.push(off); return off;
    });
    const check = (foreign: () => void) => {
      expect(a.onHeldChange).toBeNull(); expect(b.onHeldChange).toBe(foreign);
      expect(fields(sensor).feedbackListeners).toEqual([]);
      expect((fields(zone).occupiedListeners as Set<unknown>).size).toBe(0);
      for (const off of arrivedOff) expect(off).toHaveBeenCalledOnce();
      const fresh = vi.fn(), off = addGripHeldListener(a, fresh);
      a.reset(); expect(fresh).toHaveBeenCalledOnce();
      off(); expect(a.onHeldChange).toBeNull();
    };
    return { ...w, a, b, engine, check };
  }

  it('unwinds every acquired listener when construction encounters a foreign grip callback', () => {
    const w = attachmentWorld(), foreign = vi.fn(); w.b.onHeldChange = foreign;
    const cycle = vi.spyOn(w.runner.simEvents, 'registerCycleParticipant');
    const reset = vi.spyOn(w.runner.simEvents, 'registerResetHook');
    expect(() => logicEventParticipant(w.engine, w.host, { store: w.signalStore, events: w.runner.simEvents }))
      .toThrow(/foreign onHeldChange/);
    expect(cycle).not.toHaveBeenCalled(); expect(reset).not.toHaveBeenCalled();
    w.check(foreign); expect(foreign).not.toHaveBeenCalled();
  });

  it('releases old and newly acquired listeners after a rejected reattachment', () => {
    const w = attachmentWorld();
    const p = logicEventParticipant(w.engine, w.host, { store: w.signalStore, events: w.runner.simEvents });
    cleanup.push(() => p.dispose());
    const foreign = vi.fn(); w.b.onHeldChange = foreign;
    expect(() => p.reattachWakeListeners()).toThrow(/foreign onHeldChange/);
    w.check(foreign);
    p.dispose(); w.check(foreign);
  });

  it('leaves no held dispatcher behind when runner startup fails and the runner is disposed', () => {
    const w = attachmentWorld(), foreign = vi.fn(); w.b.onHeldChange = foreign;
    expect(() => w.start()).toThrow(/foreign onHeldChange/);
    w.check(foreign);
    w.runner.dispose(); w.check(foreign);
    expect(foreign).not.toHaveBeenCalled();
  });
});
