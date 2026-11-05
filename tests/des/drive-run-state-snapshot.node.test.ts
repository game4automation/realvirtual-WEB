// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { captureKeys, restoreKeys, captureRunState, restoreRunState, runStateDeclaration,
  RUN_STATE_KEYS, RUN_STATE_SERVICES, driveStateOwners, behaviorSnapshotType, driveRunStateDeclaration } from '../../src/plugins/des/rv-des-drive-state';
import { RVDriveDestinationMotor } from '../../src/core/engine/rv-drive-destination-motor';
import { RVDriveSimple } from '../../src/core/engine/rv-drive-simple';
import { RVDriveSpeed } from '../../src/core/engine/rv-drive-speed';
import { RVDriveCylinder, type DriveCylinderMode } from '../../src/core/engine/rv-drive-cylinder';
import { RVDriveGear } from '../../src/core/engine/rv-drive-gear';
import { RVDriveFollowPosition } from '../../src/core/engine/rv-drive-follow-position';
import { RVErraticDriver } from '../../src/core/engine/rv-erratic';
import { RVDriveContinousDestination } from '../../src/core/engine/rv-drive-continous-destination';
import { RVDrivePositionSwitch } from '../../src/core/engine/rv-drive-position-switch';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { setComponentInstance, type ComponentContext } from '../../src/core/engine/rv-component-registry';
import { slotCommand, slotNeutralize, slotFeedbackValue, slotFeedbackSource } from '../../src/core/engine/rv-slot-io';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { cycleRunnerFixture } from './cycle-runner-fixture';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { addArrivedListener } from '../../src/plugins/des/rv-des-core-takt';
import { publishFeedbackNow, subscribeDriveInputs } from '../../src/plugins/des/rv-des-drive-feedback';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import { createCaptureSession } from '../../src/plugins/des/rv-snapshot-contract';
import { eagerGraphPaths, REPO_ROOT } from '../helpers/static-import-graph';
import { resolve } from 'node:path';
import { constructDrive } from '../../src/core/engine/rv-signal-construction';
import { createBindContext } from '../../src/core/behavior-runtime';
import { SignalReapplyRegistry } from '../../src/core/engine/rv-signal-reapply-registry';
import { applyLiveEdit } from '../../src/core/hmi/rv-value-resolver';
import { reapplySchemaForComponent } from '../../src/core/hmi/scene/rv-scene-executors';
import { reconcileOverlayOverrides } from '../../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../../src/core/rv-viewer';
import { createSceneScriptAccess } from '../../src/core/sdk/rv-sdk-scene';

const classes = [RVDriveDestinationMotor, RVDriveSimple, RVDriveSpeed, RVDriveCylinder,
  RVDriveGear, RVDriveFollowPosition, RVErraticDriver, RVDriveContinousDestination, RVDrivePositionSwitch];
type Constructor = typeof classes[number];
const DT = 1 / 60;

function world(Type?: Constructor, wired = true, shared?: { scene: Scene; store: SignalStore; cylinderMode?: DriveCylinderMode }) {
  const scene = shared?.scene ?? new Scene();
  const registry = new NodeRegistry();
  const store = shared?.store ?? new SignalStore();
  const reapply = new SignalReapplyRegistry();
  function axis(name: string) {
    const node = new Object3D(); node.name = name; scene.add(node);
    const drive = new RVDrive(node);
    drive.onCommand = owner => publishFeedbackNow(drive, owner);
    drive.TargetSpeed = 25; drive.Acceleration = 13; drive.UseAcceleration = true;
    drive.initDrive();
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node); registry.register('Drive', path, drive);
    return drive;
  }
  const master = axis('Master');
  const drive = axis('Axis');
  const behavior = Type ? new Type(drive.node) : null;
  const slots: Record<string, string> = {};
  if (behavior && Type) {
    if (wired) for (const [slot, spec] of Object.entries(Type.schema)) {
      if (!spec.signal) continue;
      const path = `IO/${slot}`;
      slots[slot] = path;
      (behavior as unknown as Record<string, unknown>)[slot] = path;
      const initial = slot === 'Enable' || slot === 'SignalEnable' ? true
        : spec.signal.endsWith('Bool') ? false : 0;
      store.register(path, path, initial, spec.signal);
    }
    if (behavior instanceof RVDriveGear) { behavior.MasterDrive = master; behavior.GearFactor = -2; }
    if (behavior instanceof RVDriveSpeed) { behavior.TargetSpeed = 25; behavior.Acceleration = 13; }
    if (behavior instanceof RVDriveCylinder && shared?.cylinderMode) behavior.Mode = shared.cylinderMode;
    if (behavior instanceof RVDriveContinousDestination) behavior.Destination = 200;
    if (behavior instanceof RVErraticDriver) { behavior.MinPos = -20; behavior.MaxPos = 30; behavior.Speed = 25; }
    if (behavior instanceof RVDrivePositionSwitch) {
      drive.BehaviorExtras.Drive_PositionSwitch = { Areas: [{ StartPosition: 2, EndPosition: 10 }] };
    }
    behavior.init({ scene, root: scene, registry, signalStore: store, reapply } as unknown as ComponentContext);
  }
  return { drive, master, behavior, store, slots, registry, reapply,
    input(slot: string, value: boolean | number) { store.setByPath(slots[slot], value); },
    tick() { master.update(DT); drive.update(DT); },
  };
}
type World = ReturnType<typeof world>;

function declared(owner: object, state: readonly string[], services: readonly string[]) {
  const all = [...state, ...services];
  expect(new Set(all).size, 'duplicate classification').toBe(all.length);
  expect(all.slice().sort()).toEqual(Reflect.ownKeys(owner).sort());
}

function samePrimitives(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const key of Object.keys(expected)) expect(Object.is(actual[key], expected[key]), key).toBe(true);
}

function capture(w: World) {
  return { drive: captureRunState(w.drive), master: captureRunState(w.master),
    behavior: w.behavior ? captureKeys(w.behavior, runStateDeclaration(w.behavior).stateKeys) : {},
    signals: w.store.getAll() };
}

function restore(w: World, state: ReturnType<typeof capture>) {
  w.store.restoreValuesSilently(state.signals);
  restoreRunState(w.master, state.master); restoreRunState(w.drive, state.drive);
  if (w.behavior) restoreKeys(w.behavior, runStateDeclaration(w.behavior).stateKeys, state.behavior);
  w.drive.applyToNode();
}

function exercise(w: World, step: number) {
  const b = w.behavior;
  if (b instanceof RVDriveDestinationMotor && step % 45 === 0) {
    w.input('Destination', step % 90 === 0 ? 40 : -10);
    w.input('StartDrive', false); w.input('StartDrive', true);
    w.input('Acceleration', 17);
  }
  if (b instanceof RVDriveSimple) {
    if (step % 70 === 0) w.input('Forward', true);
    if (step % 70 === 30) w.input('Forward', false);
    if (step % 70 === 35) w.input('Backward', true);
    if (step % 70 === 60) w.input('Backward', false);
    if (step % 110 === 20) w.input('Enable', false);
    if (step % 110 === 40) w.input('Enable', true);
    if (step === 0) { w.input('Speed', 27); w.input('Accelaration', 14); }
  }
  if (b instanceof RVDriveSpeed && step % 80 === 0) {
    w.input('SignalTargetSpeed', step % 160 === 0 ? 20 : -30);
    w.input('SignalAcceleration', 19);
  }
  if (b instanceof RVDriveCylinder) {
    if (step % 100 === 0) { w.input('Out', false); w.input('Out', true); }
    if (step % 100 === 50) { w.input('In', false); w.input('In', true); }
    if (step % 100 === 20) w.input('Enable', false);
    if (step % 100 === 40) w.input('Enable', true);
  }
  if (b instanceof RVDriveGear && step % 60 === 0) w.master.startMove(step % 120 ? -20 : 40);
  if (b instanceof RVDriveFollowPosition) {
    w.drive.liveControlled = step % 100 < 50;
    if (step % 7 === 0) b.commandPosition(Math.sin(step) * 30);
    if (step % 37 === 0) b.neutralizePosition();
    w.input('Position', step % 23);
  }
  if (b instanceof RVErraticDriver) {
    if (step % 120 === 60) w.input('SignalEnable', false);
    if (step % 120 === 90) w.input('SignalEnable', true);
  }
  if (b instanceof RVDriveContinousDestination && step % 90 === 0) {
    w.input('SignalDestination', step % 180 ? -30 : 40);
    w.input('SignalTargetSpeed', 29); w.input('SignalAcceleration', 18);
  }
  if (b instanceof RVDrivePositionSwitch) w.drive.jogForward = true;
}

describe('core drive run state', () => {
  it('keeps DES snapshot code outside the eager graph', () => {
    expect(eagerGraphPaths(resolve(REPO_ROOT, 'src/main.ts'))
      .some(path => /\/rv-des-drive-(?:state|participant|feedback)\.ts$/.test(path))).toBe(false);
  });

  for (const Type of [RVDriveDestinationMotor, RVDriveSimple, RVDriveCylinder]) {
    it(`${Type.name}: signal-only owners preserve idle and behavior consumers, then detach`, () => {
      const w = world(Type);
      expect(w.drive.driveBehaviors).toEqual([]);
      expect(driveStateOwners(w.drive)).toEqual([w.behavior]);
      expect(w.drive.isIdle).toBe(true);
      expect('update' in w.behavior!).toBe(false);
      (w.behavior as InstanceType<typeof Type>).dispose();
      expect(driveStateOwners(w.drive)).toEqual([]);
    });
  }

  it('snapshots and resets motion behaviors before signal-only owners in registration order', () => {
    const w = world();
    const order: string[] = [];
    const owner = (id: string) => ({ update: vi.fn(), resetRunState: () => { order.push(id); } });
    const adapterA = Object.assign(new RVDriveSimple(w.drive.node), owner('adapter A'));
    const adapterB = Object.assign(new RVDriveCylinder(w.drive.node), owner('adapter B'));
    const motionA = owner('motion A'), motionB = owner('motion B');
    setComponentInstance(w.drive.node, adapterA); setComponentInstance(w.drive.node, adapterB);
    w.drive.driveBehaviors.push(motionA, motionB);
    expect(driveStateOwners(w.drive)).toEqual([motionA, motionB, adapterA, adapterB]);
    w.tick();
    expect(motionA.update).toHaveBeenCalledOnce();
    expect(adapterA.update).not.toHaveBeenCalled();
    w.drive.reset();
    expect(order).toEqual(['motion A', 'motion B', 'adapter A', 'adapter B']);
  });

  it('refuses metadata lookup for an unsupported snapshot type', () => {
    expect(() => runStateDeclaration({})).toThrow('without snapshot state');
    expect(() => runStateDeclaration({ snapshotType: 'toString' })).toThrow('without snapshot state');
  });

  it('classifies every initialized drive own key exactly once', () => {
    declared(world().drive, RUN_STATE_KEYS, RUN_STATE_SERVICES);
  });

  for (const Type of classes) {
    it(`${Type.name}: classifies every initialized behavior own key exactly once`, () => {
      const w = world(Type);
      declared(w.behavior!, runStateDeclaration(w.behavior!).stateKeys, runStateDeclaration(w.behavior!).services);
      expect(driveStateOwners(w.drive)).toContain(w.behavior);
    });

    for (const eventDriven of [false, true]) it(`${Type.name}: fresh restore continues 300 steps bit-identically (${eventDriven})`, () => {
      const a = world(Type), b = world(Type);
      a.drive.eventDrivenFeedback = b.drive.eventDrivenFeedback = eventDriven;
      // The RNG belongs to the caller. Restore its stream cursor independently of behavior state.
      let cursorA = 0, cursorB = 0;
      const draw = (cursor: number) => ((cursor * 73 + 19) % 101) / 101;
      if (a.behavior instanceof RVErraticDriver) a.behavior.random = () => draw(cursorA++);
      if (b.behavior instanceof RVErraticDriver) b.behavior.random = () => draw(cursorB++);
      for (let i = 0; i < 83; i++) { exercise(a, i); a.tick(); }
      const saved = capture(a);
      const writes = vi.fn(); b.store.observeWrites(writes);
      restore(b, saved); cursorB = cursorA;
      expect(writes).not.toHaveBeenCalled();
      for (let i = 83; i < 383; i++) {
        exercise(a, i); exercise(b, i); a.tick(); b.tick();
        const left = capture(a), right = capture(b);
        samePrimitives(right.drive, left.drive); samePrimitives(right.master, left.master);
        samePrimitives(right.behavior, left.behavior);
        samePrimitives(Object.fromEntries(right.signals), Object.fromEntries(left.signals));
        expect(b.drive.node.position.toArray()).toEqual(a.drive.node.position.toArray());
        expect(cursorB).toBe(cursorA);
      }
    });

    it(`${Type.name}: the owner guard rejects a newly added behavior field`, () => {
      const w = world(Type), b = w.behavior!;
      const registry = new SnapshotRegistry();
      registry.register({ key: 'test.drive', version: 1, owner: w.drive,
        stateKeys: RUN_STATE_KEYS, services: RUN_STATE_SERVICES,
        owners: () => [{ path: behaviorSnapshotType(b)!, owner: b, stateKeys: runStateDeclaration(b).stateKeys, services: runStateDeclaration(b).services }],
        capture: () => ({}), validate: () => [], prepare: () => null, commit: () => {} });
      expect(() => registry.captureAll(createCaptureSession())).not.toThrow();
      Object.defineProperty(b, 'hiddenCounter', { value: 1 });
      expect(() => registry.captureAll(createCaptureSession()))
        .toThrow(`des-state-not-declared: test.drive.${behaviorSnapshotType(b)}.hiddenCounter`);
    });

    for (const eventDriven of [false, true]) it(`${Type.name}: reset -> behavior state equals freshly initialized (${eventDriven ? 'DES' : 'Continuous'})`, () => {
      const a = world(Type), fresh = world(Type);
      a.drive.eventDrivenFeedback = eventDriven;
      if (a.behavior instanceof RVErraticDriver) a.behavior.random = () => 0.25;
      for (let i = 0; i < 113; i++) { exercise(a, i); a.tick(); }
      a.drive.reset();
      // A held direct input level survives reset (released by neutralize, replayed as the live command).
      const keys = runStateDeclaration(a.behavior!).stateKeys
        .filter(k => !(a.behavior instanceof RVDriveFollowPosition && k === 'directPosition'));
      samePrimitives(captureKeys(a.behavior!, keys), captureKeys(fresh.behavior!, keys));
    });
  }

  for (const mode of ['positioning', 'jog', 'ramp'] as const) {
    it(`plain ${mode}: fresh restore continues 300 steps bit-identically`, () => {
      const a = world(), b = world();
      a.drive.UseAcceleration = mode === 'ramp';
      if (mode === 'positioning') a.drive.startMove(-100);
      else a.drive.jogForward = true;
      for (let i = 0; i < 37; i++) a.tick();
      restore(b, capture(a));
      for (let i = 0; i < 300; i++) {
        if (i === 20 && mode !== 'positioning') { a.drive.jogForward = false; b.drive.jogForward = false; }
        if (i === 100) { a.drive.startMove(30); b.drive.startMove(30); }
        a.tick(); b.tick(); samePrimitives(captureRunState(b.drive), captureRunState(a.drive));
      }
    });
  }

  it('cold reset restores authored motion config and fresh drive state, retaining the reset discontinuity', () => {
    const a = world(), fresh = world();
    a.drive.Acceleration = 77; a.drive.UseAcceleration = false;
    a.drive.startMove(-25); for (let i = 0; i < 25; i++) a.tick();
    a.drive.positionOverwrite = true; a.drive.commandPosition(10); a.tick();
    const revision = a.drive.discontinuityRev;
    a.drive.reset();
    const state = captureRunState(a.drive);
    expect(state.discontinuityRev).toBe(revision + 1);
    state.discontinuityRev = fresh.drive.discontinuityRev;
    samePrimitives(state, captureRunState(fresh.drive));
  });

  it('capture/restore preserves NaN, signed zero and infinities without callbacks or discontinuity bumps', () => {
    const a = world(), b = world();
    a.drive.commandedPosition = NaN; a.drive.currentSpeed = -0; a.drive.targetSpeed = Infinity;
    const saved = captureRunState(a.drive); const feedback = vi.fn(); b.drive.addAfterUpdate(feedback);
    restoreRunState(b.drive, saved); samePrimitives(captureRunState(b.drive), saved);
    expect(feedback).not.toHaveBeenCalled();
  });

  for (const configPath of ['setLiveField', 'reapplyConfig', 'initDrive'] as const) {
    it(`${configPath}: reset retains authored edits after runtime behavior commands`, () => {
      const w = world(RVDriveDestinationMotor);
      if (configPath === 'setLiveField') {
        expect(w.drive.setLiveField('TargetSpeed', 250)).toBe(true);
        expect(w.drive.setLiveField('Acceleration', 123)).toBe(true);
        expect(w.drive.setLiveField('UseAcceleration', false)).toBe(true);
      } else {
        Object.assign(w.drive, { TargetSpeed: 250, Acceleration: 123, UseAcceleration: false });
        w.drive[configPath]();
      }
      w.drive.reset();
      expect([w.drive.TargetSpeed, w.drive.targetSpeed, w.drive.Acceleration, w.drive.UseAcceleration])
        .toEqual([250, 250, 123, false]);
      const motor = w.behavior as RVDriveDestinationMotor;
      motor.commandTargetSpeed(7); motor.commandAcceleration(9);
      expect([w.drive.targetSpeed, w.drive.Acceleration, w.drive.UseAcceleration]).toEqual([7, 9, true]);
      // Editing an unrelated config field must not promote a runtime command to authored config.
      w.drive.setLiveField('TargetSpeed', 251);
      w.drive.reset();
      expect([w.drive.TargetSpeed, w.drive.targetSpeed, w.drive.Acceleration, w.drive.UseAcceleration])
        .toEqual([251, 251, 123, false]);
    });
  }

  it('rejects non-primitive or missing declared state before assigning any fields', () => {
    expect(() => captureKeys({ value: {} }, ['value'])).toThrow('Non-primitive run state: value');
    const owner = { first: 1, second: 2 };
    expect(() => restoreKeys(owner, ['first', 'second'], { first: 3 })).toThrow();
    expect(owner).toEqual({ first: 1, second: 2 });
  });

  for (const Type of [RVDriveSpeed, RVDriveContinousDestination]) {
    for (const path of ['inspector', 'reapplyConfig', 'schema', 'overlay'] as const) {
      it(`${Type.name}: ${path} edits survive reset without promoting runtime commands`, () => {
        const w = world(Type, false), b = w.behavior as RVDriveSpeed | RVDriveContinousDestination;
        const type = behaviorSnapshotType(b)!, nodePath = NodeRegistry.computeNodePath(w.drive.node);
        w.registry.register(type, nodePath, b);
        const config = { TargetSpeed: 250, Acceleration: 123,
          ...(b instanceof RVDriveContinousDestination ? { Destination: 321 } : {}) };
        w.drive.node.userData.realvirtual = { [type]: {} };
        if (path === 'inspector') {
          for (const [field, value] of Object.entries(config))
            applyLiveEdit({ registry: w.registry, signalStore: w.store }, nodePath, type, field, value);
        } else if (path === 'reapplyConfig') {
          Object.assign(b, config); b.reapplyConfig();
        } else if (path === 'schema') {
          w.drive.node.userData.realvirtual[type] = config;
          reapplySchemaForComponent({ registry: w.registry } as unknown as RVViewer, nodePath, type);
        } else {
          reconcileOverlayOverrides(w.registry, {
            $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes: { [nodePath]: { [type]: config } },
          });
        }
        w.drive.reset();
        expect([b.TargetSpeed, b.Acceleration]).toEqual([250, 123]);
        if (b instanceof RVDriveContinousDestination) expect(b.Destination).toBe(321);
        slotCommand(b, 'SignalTargetSpeed', 7); slotCommand(b, 'SignalAcceleration', 9);
        if (b instanceof RVDriveContinousDestination) slotCommand(b, 'SignalDestination', 11);
        w.tick();
        expect([b.TargetSpeed, b.Acceleration]).toEqual([7, 9]);
        // A single authored edit must leave the other fields' baselines alone.
        applyLiveEdit({ registry: w.registry, signalStore: w.store }, nodePath, type, 'TargetSpeed', 251);
        w.drive.reset();
        expect([b.TargetSpeed, b.Acceleration]).toEqual([251, 123]);
        if (b instanceof RVDriveContinousDestination) {
          expect(b.Destination).toBe(321);
          w.tick(); expect(w.drive.targetPosition).toBe(321);
        }
      });
    }

    it(`${Type.name}: SDK edits refresh only the authored field after direct commands`, () => {
      const w = world(Type, false), b = w.behavior as RVDriveSpeed | RVDriveContinousDestination;
      const type = behaviorSnapshotType(b)!, nodePath = NodeRegistry.computeNodePath(w.drive.node);
      w.registry.register(type, nodePath, b);
      const access = createSceneScriptAccess(w.registry, w.drive.node);
      access.set(nodePath, type, 'TargetSpeed', 100);
      access.set(nodePath, type, 'Acceleration', 100);
      if (b instanceof RVDriveContinousDestination) access.set(nodePath, type, 'Destination', 300);
      const command = () => {
        slotCommand(b, 'SignalTargetSpeed', 7); slotCommand(b, 'SignalAcceleration', 9);
        if (b instanceof RVDriveContinousDestination) slotCommand(b, 'SignalDestination', 11);
        expect([b.TargetSpeed, b.Acceleration]).toEqual([7, 9]);
      };
      const expectDefaults = (speed: number) => {
        expect([b.TargetSpeed, b.Acceleration]).toEqual([speed, 100]);
        if (b instanceof RVDriveContinousDestination) expect(b.Destination).toBe(300);
      };
      const neutralize = () => {
        slotNeutralize(b, 'SignalTargetSpeed'); slotNeutralize(b, 'SignalAcceleration');
        if (b instanceof RVDriveContinousDestination) slotNeutralize(b, 'SignalDestination');
      };
      command();
      access.set(nodePath, type, 'CurrentPositionScale', 2);
      expect([b.TargetSpeed, b.Acceleration]).toEqual([7, 9]);
      w.drive.reset(); expectDefaults(100);
      w.reapply.reapplyAll(); neutralize(); expectDefaults(100);

      command();
      // An authored edit counts even when it equals the current command value.
      access.set(nodePath, type, 'TargetSpeed', 7);
      w.drive.reset(); expectDefaults(7);
      w.reapply.reapplyAll(); neutralize(); expectDefaults(7);
    });

    it(`${Type.name}: polled signal inputs do not change the authored baseline`, () => {
      const w = world(Type), b = w.behavior as RVDriveSpeed | RVDriveContinousDestination;
      b.setLiveField('TargetSpeed', 250); b.setLiveField('Acceleration', 123);
      if (b instanceof RVDriveContinousDestination) b.setLiveField('Destination', 321);
      w.input('SignalTargetSpeed', 7); w.input('SignalAcceleration', 9);
      if (b instanceof RVDriveContinousDestination) w.input('SignalDestination', 11);
      w.tick(); expect([b.TargetSpeed, b.Acceleration]).toEqual([7, 9]);
      const type = behaviorSnapshotType(b)!, nodePath = NodeRegistry.computeNodePath(w.drive.node);
      w.registry.register(type, nodePath, b);
      createSceneScriptAccess(w.registry, w.drive.node).set(nodePath, type, 'CurrentPositionScale', 2);
      w.drive.reset(); expect([b.TargetSpeed, b.Acceleration]).toEqual([250, 123]);
      if (b instanceof RVDriveContinousDestination) expect(b.Destination).toBe(321);
    });
  }

  it('refuses capture when a smooth core handle or plan owns motion state', () => {
    const w = world(); expect(w.drive.usesSmoothCore()).toBe(false);
    const owner = w.drive as unknown as Record<string, unknown>;
    for (const key of ['_smoothHandle', '_smoothPlanned']) {
      owner[key] = key === '_smoothHandle' ? 1 : true;
      expect(w.drive.usesSmoothCore()).toBe(true);
      expect(() => captureRunState(w.drive)).toThrow('smooth-motion drive Axis');
      owner[key] = key === '_smoothHandle' ? 0 : false;
    }
  });

  it('Erratic uses the injected random hook and retains Math.random in Continuous', () => {
    const w = world(RVErraticDriver);
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.75);
    try {
      w.tick(); expect(spy).toHaveBeenCalledOnce(); expect(w.drive.targetPosition).toBe(17.5);
      const erratic = w.behavior as RVErraticDriver;
      erratic.resetRunState(); erratic.random = () => 0.25;
      w.tick(); expect(spy).toHaveBeenCalledOnce(); expect(w.drive.targetPosition).toBe(-7.5);
    } finally { spy.mockRestore(); }
  });

  it('arrival is transient and survives an immediate feedback restart', () => {
    const w = world(); w.drive.UseAcceleration = false;
    w.drive.startMove(0.1);
    w.drive.addAfterUpdate(d => { if (d.isAtTarget) d.startMove(100); });
    w.tick(); expect(w.drive.arrivedThisUpdate).toBe(true);
    expect(w.drive.isAtTarget).toBe(false);
    w.tick(); expect(w.drive.arrivedThisUpdate).toBe(false);
    const ordinary = world(); ordinary.drive.UseAcceleration = false; ordinary.drive.startMove(0.1);
    ordinary.tick(); expect(ordinary.drive.arrivedThisUpdate).toBe(true);
    ordinary.tick(); expect(ordinary.drive.arrivedThisUpdate).toBe(false);
  });
});

describe('synchronous command feedback', () => {
  it('Festo P40 122 -> 123 waits for physical arrival after a zero-time start pulse', () => {
    const w = world(RVDriveDestinationMotor);
    const b = w.behavior as RVDriveDestinationMotor;
    b.commandStartDrive(true); w.tick(); b.commandStartDrive(false);
    w.drive.eventDrivenFeedback = true;
    let step = 122;
    const scan = () => {
      if (step === 122) {
        w.input('Destination', 25); w.input('StartDrive', true); step = 123;
      } else if (step === 123) {
        w.input('StartDrive', false);
        if (w.store.getBoolByPath(w.slots.IsAtDestination)) step = 130;
      }
    };
    scan(); scan(); expect(step).toBe(123); expect(w.drive.currentPosition).toBe(0);
    for (let i = 0; i < 1000 && step === 123; i++) {
      w.tick(); scan();
      if (!w.drive.isAtTarget) expect(step).toBe(123);
    }
    expect(step).toBe(130); expect(w.drive.isAtTarget).toBe(true);
  });

  for (const eventDriven of [false, true]) {
    it(`Speed: stop commands retain driving feedback throughout deceleration (${eventDriven})`, () => {
      const w = world(RVDriveSpeed); w.drive.eventDrivenFeedback = eventDriven;
      const off = eventDriven ? subscribeDriveInputs(w.drive, w.store) : () => {};
      w.input('SignalTargetSpeed', 25); w.input('SignalAcceleration', 13);
      for (let i = 0; i < 90; i++) w.tick();
      const command = vi.spyOn(w.behavior as RVDriveSpeed, 'commandTargetSpeed');
      w.input('SignalTargetSpeed', 0);
      expect(command).toHaveBeenCalledTimes(eventDriven ? 1 : 0);
      expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(true);
      expect(w.drive.currentSpeed).toBeGreaterThan(0);
      for (let i = 0; i < 100; i++) {
        const wasRunning = w.drive.isRunning;
        w.tick();
        expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(wasRunning);
        expect(slotFeedbackValue(w.behavior!, 'SignalIsDriving')).toBe(w.drive.isRunning);
      }
      expect(w.drive.isRunning).toBe(false);
      expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(false);
      off();
    });

    it(`Simple: afterUpdate reports motion when a jog is held at a limit (${eventDriven})`, () => {
      const w = world(RVDriveSimple); w.drive.eventDrivenFeedback = eventDriven;
      const b = w.behavior as RVDriveSimple;
      const values: (boolean | number)[] = [];
      b.addFeedbackListener(() => values.push(b.readFeedbackSlot('IsDriving')));
      w.drive.UseLimits = true; w.drive.UpperLimit = w.drive.currentPosition;
      w.input('Forward', true);
      expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(eventDriven);
      w.tick();
      expect(w.drive.jogForward).toBe(true); expect(w.drive.isRunning).toBe(false);
      expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(false);
      expect(values).toEqual(eventDriven ? [true, false] : [false]);
    });

    it(`DestinationMotor and Cylinder: afterUpdate feedback stays motion/pose-based (${eventDriven})`, () => {
      const motor = world(RVDriveDestinationMotor); motor.drive.eventDrivenFeedback = eventDriven;
      motor.input('Destination', 25); motor.input('StartDrive', true);
      for (let i = 0; i < 250; i++) {
        motor.tick();
        expect(motor.store.getBoolByPath(motor.slots.IsDriving)).toBe(motor.drive.isRunning);
        expect(motor.store.getBoolByPath(motor.slots.IsAtDestination)).toBe(motor.drive.isAtTarget);
      }
      const cylinder = world(RVDriveCylinder); cylinder.drive.eventDrivenFeedback = eventDriven;
      const b = cylinder.behavior as RVDriveCylinder;
      cylinder.input('Out', true);
      for (let i = 0; i < 90; i++) {
        cylinder.tick();
        const atMax = Math.abs(cylinder.drive.currentPosition - b.MaxPos) < 0.01;
        const atMin = Math.abs(cylinder.drive.currentPosition - b.MinPos) < 0.01;
        for (const slot of ['IsOut', 'IsMax']) expect(cylinder.store.getBoolByPath(cylinder.slots[slot])).toBe(atMax);
        for (const slot of ['IsIn', 'IsMin']) expect(cylinder.store.getBoolByPath(cylinder.slots[slot])).toBe(atMin);
        expect(cylinder.store.getBoolByPath(cylinder.slots.IsMovingOut))
          .toBe(cylinder.drive.isRunning && cylinder.drive.targetPosition === b.MaxPos);
      }
    });

    it(`DestinationMotor: target + start pulse before any update (${eventDriven})`, () => {
      const w = world(RVDriveDestinationMotor);
      const b = w.behavior as RVDriveDestinationMotor;
      b.commandStartDrive(true); w.tick(); b.commandStartDrive(false);
      expect(w.store.getBoolByPath(w.slots.IsAtDestination)).toBe(true);
      w.drive.eventDrivenFeedback = eventDriven;
      const batches = vi.fn(); w.store.observeWrites(batches);
      w.input('Destination', 50);
      expect(w.store.getBoolByPath(w.slots.IsAtDestination)).toBe(!eventDriven);
      w.input('StartDrive', true); w.input('StartDrive', false);
      expect(w.drive.isRunning).toBe(true); expect(w.drive.isAtTarget).toBe(false);
      expect(w.store.getBoolByPath(w.slots.IsAtDestination)).toBe(!eventDriven);
      expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(eventDriven);
      expect(w.drive.currentPosition).toBe(0);
      if (eventDriven) { batches.mockClear(); w.drive.onCommand?.(b); expect(batches).not.toHaveBeenCalled(); }
      w.tick(); expect(w.store.getBoolByPath(w.slots.IsAtDestination)).toBe(false);
      expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(true);
    });

    it(`Simple: command publishes all three feedback slots without integrating (${eventDriven})`, () => {
      const w = world(RVDriveSimple); w.drive.eventDrivenFeedback = eventDriven;
      w.store.setByPath(w.slots.IsAtPosition, -777); w.store.setByPath(w.slots.IsAtSpeed, -777);
      w.input('Forward', true);
      expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(eventDriven);
      expect(w.store.getFloatByPath(w.slots.IsAtPosition)).toBe(eventDriven ? 0 : -777);
      expect(w.store.getFloatByPath(w.slots.IsAtSpeed)).toBe(eventDriven ? 0 : -777);
      expect(w.drive.currentPosition).toBe(0);
      w.tick(); expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(true);
      w.input('Enable', false);
      expect(w.store.getBoolByPath(w.slots.IsDriving)).toBe(!eventDriven);
    });

    it(`Speed: wired and direct commands publish only IsDriving (${eventDriven})`, () => {
      const w = world(RVDriveSpeed); w.drive.eventDrivenFeedback = eventDriven;
      const off = eventDriven ? subscribeDriveInputs(w.drive, w.store) : () => {};
      w.store.setByPath(w.slots.SignalCurrentPosition, -777);
      w.input('SignalTargetSpeed', -30);
      expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(eventDriven);
      expect(w.store.getFloatByPath(w.slots.SignalCurrentPosition)).toBe(-777);
      expect(w.drive.currentPosition).toBe(0);
      w.tick();
      // Continuous writes wired Speed feedback before physics, retaining its existing one-tick lag.
      expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(false);
      w.tick(); expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(true);
      w.input('SignalTargetSpeed', 0);
      expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(true);
      const direct = world(RVDriveSpeed, false); direct.drive.eventDrivenFeedback = eventDriven;
      slotCommand(direct.behavior!, 'SignalTargetSpeed', 42);
      expect(slotFeedbackValue(direct.behavior!, 'SignalIsDriving')).toBe(eventDriven);
      off();
    });

    it(`Cylinder: commands publish moving flags and leave end-position slots pose-based (${eventDriven})`, () => {
      const w = world(RVDriveCylinder); w.drive.eventDrivenFeedback = eventDriven;
      const feedback = vi.fn(); (w.behavior as RVDriveCylinder).addFeedbackListener(feedback);
      for (const slot of ['IsOut', 'IsIn', 'IsMax', 'IsMin']) w.store.setByPath(w.slots[slot], true);
      w.input('Out', true);
      expect(feedback).toHaveBeenCalledTimes(eventDriven ? 1 : 0);
      expect(w.store.getBoolByPath(w.slots.IsMovingOut)).toBe(eventDriven);
      for (const slot of ['IsOut', 'IsIn', 'IsMax', 'IsMin']) expect(w.store.getBoolByPath(w.slots[slot])).toBe(true);
      expect(w.drive.currentPosition).toBe(0);
      w.tick(); expect(w.store.getBoolByPath(w.slots.IsMovingOut)).toBe(true);
      w.input('In', true);
      expect(w.store.getBoolByPath(w.slots.IsMovingOut)).toBe(!eventDriven);
      expect(w.store.getBoolByPath(w.slots.IsMovingIn)).toBe(eventDriven);
      w.input('Enable', false);
      if (eventDriven) expect(w.store.getBoolByPath(w.slots.IsMovingIn)).toBe(false);
    });
  }
});

function runnerWorld(Type?: Constructor, version: 1 | 2 = 1, options: { wired?: boolean; cylinderMode?: DriveCylinderMode } = {}) {
  const f = cycleRunnerFixture({ cycleTime: DT });
  const w = world(Type, options.wired ?? true, { scene: f.scene, store: f.signalStore, cylinderMode: options.cylinderMode });
  f.host.drives = [w.master, w.drive];
  // Also install a cycle for signal-only adapters and plain drives.
  f.runner.simEvents.registerCycleParticipant('test.clock', 0, { step() {}, alive: () => true });
  f.runner.setRngVersion(version); f.runner.setMasterSeed(731);
  f.start();
  return { ...w, ...f, tick() { f.runner.step(); } };
}

type DriveDoc = { id: string; kind: string; drive: Record<string, unknown>;
  behaviors: { type: string; state: Record<string, unknown>; inputReplay: Record<string, boolean> }[] }[];
function driveDoc(snapshot: DESSnapshotV4): DriveDoc {
  return snapshot.parts.find(p => p.key === 'des.drives')!.state as unknown as DriveDoc;
}

describe('DESRunner drive snapshots v2', () => {
  it('registers Speed inputs only on DES entry, without replay or duplicate subscriptions, then detaches', () => {
    const f = cycleRunnerFixture();
    const w = world(RVDriveSpeed, true, { scene: f.scene, store: f.signalStore });
    const speed = w.behavior as RVDriveSpeed;
    w.drive.onCommand = null;
    const command = vi.spyOn(speed, 'commandTargetSpeed');
    w.input('SignalTargetSpeed', 7);
    expect(command).not.toHaveBeenCalled();
    expect(speed.TargetSpeed).toBe(25);
    f.host.drives = [w.drive]; f.start();
    expect(w.drive.eventDrivenFeedback).toBe(true);
    expect(command).not.toHaveBeenCalled();
    w.input('SignalTargetSpeed', 8);
    expect(command).toHaveBeenCalledTimes(1);
    expect(w.store.getBoolByPath(w.slots.SignalIsDriving)).toBe(true);
    f.runner.setCycleTime(DT * 2);
    w.input('SignalTargetSpeed', 9);
    expect(command).toHaveBeenCalledTimes(2);
    speed.dispose();
    w.input('SignalTargetSpeed', 10);
    expect(command).toHaveBeenCalledTimes(2);
    f.runner.setCycleTime(DT);
    expect(f.runner.cycleMode).toBe(false);
    expect(w.drive.onCommand).toBeNull();
    f.runner.dispose();
    w.input('SignalTargetSpeed', 11);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('keeps own TargetPosition authored across takt commands and rejects new primitive state', () => {
    const f = cycleRunnerFixture();
    const node = new Object3D(); node.name = 'BoundAxis'; f.scene.add(node);
    const registry = new NodeRegistry(), path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);
    const { drive } = constructDrive(node, {}, { Direction: 'LinearX', TargetPosition: 42 }, path, registry)!;
    f.host.drives = [drive];
    const { ctx, handle } = createBindContext(f.scene,
      { drives: [drive], signalStore: f.signalStore, on: f.host.on, contextMenu: f.host.contextMenu }, {});
    const bound = ctx.drives.get(node)!;
    expect(bound).toBe(drive);
    expect(Object.hasOwn(drive, 'moveTo')).toBe(true);
    expect(Object.hasOwn(drive, 'jog')).toBe(true);
    expect((drive as unknown as { TargetPosition: number }).TargetPosition).toBe(42);
    const motor = new RVDriveDestinationMotor(node);
    motor.init({ scene: f.scene, root: f.scene, registry, signalStore: f.signalStore } as unknown as ComponentContext);
    declared(drive, RUN_STATE_KEYS, driveRunStateDeclaration(drive).services);
    f.runner.simEvents.registerCycleParticipant('test.clock', 0, { step() {}, alive: () => true });
    f.start();
    for (const [command, target] of [[() => bound.moveTo(5), 5], [() => motor.commandDestination(17), 17],
      [() => drive.setLiveField('TargetPosition', 29), 29]] as const) {
      command();
      expect(drive.targetPosition).toBe(target);
      for (let i = 0; i < 5; i++) {
        expect(f.runner.step()).toBe(true);
        expect(drive.targetPosition).toBe(target);
        expect((drive as unknown as { TargetPosition: number }).TargetPosition).toBe(42);
        expect(driveDoc(f.runner.fullSnapshot())[0].drive.targetPosition).toBe(target);
      }
    }
    expect(() => f.runner.fullSnapshot()).not.toThrow();
    // Any function-valued own key is a service, independent of its name.
    Object.defineProperty(drive, 'customBindService', { value: () => {} });
    expect(() => f.runner.fullSnapshot()).not.toThrow();
    Object.defineProperty(drive, 'newPrimitiveState', { value: 1 });
    expect(() => f.runner.fullSnapshot()).toThrow(/des-state-not-declared.*BoundAxis.newPrimitiveState/);
    handle.dispose();
  });

  for (const Type of [RVDriveDestinationMotor, RVDriveSimple]) {
    for (const [speedDelivered, accelerationDelivered] of [[false, false], [true, false], [false, true], [true, true]] as const)
    it.each([false, true])(`${Type.name}: reset/reapply preserves per-slot arming (${speedDelivered}/${accelerationDelivered}, used=%s)`, targetUsed => {
      const a = runnerWorld(Type), b = runnerWorld(Type);
      a.drive.setLiveField('TargetSpeed', 100); b.drive.setLiveField('TargetSpeed', 100);
      const speed = Type === RVDriveSimple ? 'Speed' : 'TargetSpeed';
      const acceleration = Type === RVDriveSimple ? 'Accelaration' : 'Acceleration';
      if (speedDelivered) a.input(speed, 25);
      if (accelerationDelivered) a.input(acceleration, 77);
      if (Type === RVDriveDestinationMotor && speedDelivered) a.input('Destination', 31);
      if (targetUsed) {
        // Restore also disarms individual inputs in an already-used target world.
        b.input(speed, 88); b.input(acceleration, 99);
        if (Type === RVDriveDestinationMotor) b.input('Destination', 91);
      }
      const commands = b.behavior instanceof RVDriveSimple ? vi.spyOn(b.behavior, 'commandSpeed')
        : vi.spyOn(b.behavior as RVDriveDestinationMotor, 'commandTargetSpeed');
      const listeners = vi.fn(), writes = vi.fn(), starts = vi.spyOn(b.drive, 'startMove');
      (b.behavior as RVDriveDestinationMotor | RVDriveSimple).addFeedbackListener(listeners);
      b.store.observeWrites(writes);
      b.runner.restoreJson(a.runner.snapshotJson());
      expect(commands).not.toHaveBeenCalled(); expect(listeners).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled(); expect(starts).not.toHaveBeenCalled();
      expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson());
      for (const w of [a, b]) { w.drive.reset(); w.reapply.reapplyAll(); }
      expect([a.drive.targetSpeed, a.drive.Acceleration, a.drive.targetPosition])
        .toEqual([speedDelivered ? 25 : 100, accelerationDelivered ? 77 : 13, speedDelivered && Type === RVDriveDestinationMotor ? 31 : 0]);
      samePrimitives(captureRunState(b.drive), captureRunState(a.drive));
      for (let i = 0; i < 5; i++) { a.tick(); b.tick();
        expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson()); }
    });
  }

  for (const mode of ['Legacy', 'DoubleActing'] as const) {
    it(`${mode}: runner reset republishes all cylinder endpoints from the home pose`, async () => {
      const w = runnerWorld(RVDriveCylinder, 2, { cylinderMode: mode });
      w.input('Out', true);
      for (let i = 0; i < 1200 && !w.drive.isAtTarget; i++) w.tick();
      expect(w.drive.currentPosition).toBe((w.behavior as RVDriveCylinder).MaxPos);
      for (const slot of ['IsOut', 'IsMax']) expect(w.store.getBoolByPath(w.slots[slot])).toBe(true);
      for (const slot of ['IsIn', 'IsMin']) expect(w.store.getBoolByPath(w.slots[slot])).toBe(false);
      w.runner.reset(); await w.runner.whenCycleOwnersReady();
      expect(w.drive.currentPosition).toBe((w.behavior as RVDriveCylinder).MinPos);
      for (const slot of ['IsOut', 'IsMax', 'IsMovingOut', 'IsMovingIn'])
        expect(w.store.getBoolByPath(w.slots[slot]), slot).toBe(false);
      for (const slot of ['IsIn', 'IsMin']) expect(w.store.getBoolByPath(w.slots[slot]), slot).toBe(true);
    });
  }

  for (const Type of [RVDriveSpeed, RVDriveDestinationMotor]) {
    for (const beforeTick of [false, true]) it(`${Type.name}: B-immediate unwired feedback restore (before tick=${beforeTick})`, () => {
      const a = runnerWorld(Type, 2, { wired: false }), b = runnerWorld(Type, 2, { wired: false });
      if (a.behavior instanceof RVDriveSpeed) slotCommand(a.behavior, 'SignalTargetSpeed', 42);
      else {
        const motor = a.behavior as RVDriveDestinationMotor;
        motor.commandDestination(100); motor.commandStartDrive(true); motor.commandStartDrive(false);
      }
      if (!beforeTick) for (let i = 0; i < 10; i++) a.tick();
      const fields = Type === RVDriveSpeed
        ? ['SignalIsDriving', 'SignalCurrentPosition', 'SignalCurrentSpeed']
        : ['IsDriving', 'IsAtDestination', 'IsAtPosition', 'IsAtSpeed'];
      const feedback = (owner: typeof a.behavior, field: string) => owner instanceof RVDriveDestinationMotor
        ? owner.readFeedbackSlot(field) : slotFeedbackSource(owner!, field)!.readFeedbackSlot(field);
      expect(feedback(a.behavior, fields[0])).toBe(true);
      expect(feedback(b.behavior, fields[0])).toBe(false);
      const listeners = vi.fn(), commands = vi.spyOn(RVDrive.prototype, 'startMove'), writes = vi.fn();
      b.store.observeWrites(writes);
      if (b.behavior instanceof RVDriveDestinationMotor) b.behavior.addFeedbackListener(listeners);
      else for (const field of fields) slotFeedbackSource(b.behavior!, field)!.addFeedbackListener(listeners);
      b.runner.restoreJson(a.runner.snapshotJson());
      for (const field of fields) {
        expect(Object.is(feedback(b.behavior, field), feedback(a.behavior, field)), field).toBe(true);
        if (Type === RVDriveSpeed)
          expect(Object.is(slotFeedbackValue(b.behavior!, field), slotFeedbackValue(a.behavior!, field)), field).toBe(true);
      }
      expect(listeners).not.toHaveBeenCalled(); expect(commands).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
      commands.mockRestore();
      expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson());
    });
  }

  for (const Type of [undefined, ...classes]) {
    it(`${Type?.name ?? 'plain'}: moving takt owners continue 300 real runner steps after silent fresh restore`, () => {
      const a = runnerWorld(Type, 2), b = runnerWorld(Type, 2);
      if (!Type) a.drive.startMove(100);
      for (let i = 0; i < 83; i++) { exercise(a, i); a.tick(); }
      const saved = JSON.parse(a.runner.snapshotJson());
      expect(saved.parts.find((p: { key: string }) => p.key === 'des.drives').version).toBe(2);
      expect(driveDoc(saved).map(d => [d.id, d.kind])).toEqual([['#Axis', 'takt'], ['#Master', 'takt']]);
      const writes = vi.fn(); b.store.observeWrites(writes);
      b.runner.restoreFull(saved); expect(writes).not.toHaveBeenCalled();
      for (let i = 83; i < 383; i++) {
        exercise(a, i); exercise(b, i); a.tick(); b.tick();
        const left = capture(a), right = capture(b);
        samePrimitives(right.drive, left.drive); samePrimitives(right.master, left.master);
        samePrimitives(right.behavior, left.behavior);
        samePrimitives(Object.fromEntries(right.signals), Object.fromEntries(left.signals));
      }
      expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson());
    });
  }

  for (const mode of ['positioning', 'jog', 'ramp'] as const) {
    it(`plain ${mode}: moving runner snapshot continues 300 steps`, () => {
      const a = runnerWorld(), b = runnerWorld();
      a.drive.UseAcceleration = mode === 'ramp';
      if (mode === 'positioning') a.drive.startMove(-100);
      else a.drive.jogForward = true;
      for (let i = 0; i < 37; i++) a.tick();
      expect(a.drive.isRunning).toBe(true);
      b.runner.restoreJson(a.runner.snapshotJson());
      for (let i = 0; i < 300; i++) {
        if (i === 20 && mode !== 'positioning') { a.drive.jogForward = false; b.drive.jogForward = false; }
        if (i === 100) { a.drive.startMove(30); b.drive.startMove(30); }
        a.tick(); b.tick(); samePrimitives(captureRunState(b.drive), captureRunState(a.drive));
      }
      expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson());
    });
  }

  for (const mode of ['A', 'B-immediate'] as const) it(`moving takt drive continuation harness ${mode}`, async () => {
    await assertContinuation({ mode, T: 0.5, TPrime: 1.5, T2: 2,
      buildWorld() {
        const w = runnerWorld(RVDriveDestinationMotor);
        w.input('Destination', 100); w.input('StartDrive', true); w.input('StartDrive', false);
        return { runner: w.runner,
          step(toT) { while (w.manager.currentTime < toT) w.tick(); },
          trace: () => [], kpis: () => ({}), dispose: () => w.runner.dispose() };
      },
    });
  });

  it('B-immediate preserves a never-delivered zero input and latched adapter state', () => {
    const a = runnerWorld(RVDriveDestinationMotor), b = runnerWorld(RVDriveDestinationMotor);
    a.drive.targetSpeed = 100; a.drive.startMove(100);
    a.tick();
    expect(a.store.getFloatByPath(a.slots.TargetSpeed)).toBe(0);
    const saved = a.runner.fullSnapshot(); b.runner.restoreFull(saved);
    expect(b.drive.targetSpeed).toBe(100);
    samePrimitives(captureRunState(b.drive), captureRunState(a.drive));
    expect(b.runner.snapshotJson()).toBe(a.runner.snapshotJson());
  });

  it('round-trips NaN sentinels, signed zero and unbounded speed through JSON', () => {
    const a = runnerWorld(), b = runnerWorld();
    a.drive.currentSpeed = -0; a.drive.targetSpeed = Infinity;
    b.runner.restoreJson(a.runner.snapshotJson());
    samePrimitives(captureRunState(b.drive), captureRunState(a.drive));
  });

  const corruptions: [string, (snapshot: DESSnapshotV4) => void, RegExp][] = [
    ['unknown address', s => { driveDoc(s)[0].id = '#unknown'; }, /unknown drive/],
    ['kind mismatch', s => { driveDoc(s)[0].kind = 'des'; }, /invalid drive kind/],
    ['behavior mismatch', s => { driveDoc(s)[0].behaviors[0].type = 'Drive_Simple'; }, /type mismatch/],
    ['non-finite pose', s => { driveDoc(s)[0].drive.currentPosition = { $num: 'Infinity' }; }, /invalid run-state field/],
    ['wrong primitive', s => { driveDoc(s)[0].drive.isRunning = 1; }, /invalid run-state field/],
    ['missing field', s => { delete driveDoc(s)[0].drive.currentSpeed; }, /run-state keys/],
    ['extra field', s => { driveDoc(s)[0].drive.newCounter = 1; }, /run-state keys/],
    ['feedback shape', s => { (driveDoc(s)[0].behaviors[0] as unknown as { feedback: unknown }).feedback = { unknown: true }; }, /invalid drive feedback/],
    ['missing input arming', s => { delete driveDoc(s)[0].behaviors[0].inputReplay['0']; }, /invalid drive input replay/],
    ['extra input arming', s => { driveDoc(s)[0].behaviors[0].inputReplay.unknown = true; }, /invalid drive input replay/],
    ['wrong input arming primitive', s => { (driveDoc(s)[0].behaviors[0].inputReplay as Record<string, unknown>)['0'] = 1; }, /invalid drive input replay/],
    ['duplicate drive', s => { driveDoc(s)[1] = JSON.parse(JSON.stringify(driveDoc(s)[0])); }, /incomplete drives/],
    ['v1 part', s => { s.parts.find(p => p.key === 'des.drives')!.version = 1; }, /version mismatch/],
  ];
  for (const [name, corrupt, error] of corruptions) it(`preflight rejects ${name} before changing live state`, () => {
    const w = runnerWorld(RVDriveDestinationMotor);
    w.input('Destination', 40); w.input('StartDrive', true); w.tick();
    const before = w.runner.snapshotJson(), saved = JSON.parse(before);
    corrupt(saved); expect(() => w.runner.restoreFull(saved)).toThrow(error);
    expect(w.runner.snapshotJson()).toBe(before);
  });

  it('runner owner guard reports a new signal-only adapter own field', () => {
    const w = runnerWorld(RVDriveDestinationMotor);
    Object.defineProperty(w.behavior, 'newCounter', { value: 1 });
    expect(() => w.runner.fullSnapshot()).toThrow(/des-state-not-declared.*#Axis#0:Drive_DestinationMotor.newCounter/);
  });

  for (const refusal of ['smooth', 'unsupported']) it(`publishes ${refusal} refusal to blockers and batch hazards`, () => {
    const w = runnerWorld();
    if (refusal === 'smooth') (w.drive as unknown as { _smoothHandle: number })._smoothHandle = 1;
    else w.drive.driveBehaviors.push({ update() {} });
    const reason = refusal === 'smooth' ? /smooth-motion drive #Axis/ : /drive behavior Object without snapshot state: #Axis/;
    expect(w.host.snapshotBlockers.reasons().join()).toMatch(reason);
    expect(w.host.snapshotBlockers.batchHazards().flatMap(p => p.nodes).join()).toMatch(reason);
    expect(() => w.runner.fullSnapshot()).toThrow(reason);
    if (refusal === 'smooth') (w.drive as unknown as { _smoothHandle: number })._smoothHandle = 0;
  });

  it('keeps DES-only scenes without cycles or RNG owners unchanged outside des.drives', () => {
    const w = cycleRunnerFixture(); const plain = world();
    vi.spyOn(w.runner as unknown as { collectDrives(): RVDrive[] }, 'collectDrives').mockReturnValue([plain.drive]);
    w.start(); const saved = w.runner.fullSnapshot();
    expect(w.runner.cycleMode).toBe(false);
    expect(driveDoc(saved).map(d => d.kind)).toEqual(['des']);
    expect(saved.parts.find(p => p.key === 'des.rng')!.state).toEqual({ rngStates: {} });
    expect(saved.parts.some(p => p.key.startsWith('core.'))).toBe(false);
    expect(plain.drive.eventDrivenFeedback).toBe(false);
  });

  it('clears feedback and injected randomness on resync, detach and dispose', () => {
    const w = runnerWorld(RVErraticDriver);
    expect(w.drive.eventDrivenFeedback).toBe(true); expect((w.behavior as RVErraticDriver).random).toBeTypeOf('function');
    w.host.drives = [w.master]; w.runner.setCycleTime(DT);
    expect(w.drive.eventDrivenFeedback).toBe(false); expect((w.behavior as RVErraticDriver).random).toBeNull();
    w.host.drives = [w.master, w.drive]; w.runner.setCycleTime(DT);
    expect(w.drive.eventDrivenFeedback).toBe(true);
    w.runner.clearMUs(); expect(w.drive.eventDrivenFeedback).toBe(false); expect((w.behavior as RVErraticDriver).random).toBeNull();
    w.start(); expect(w.drive.eventDrivenFeedback).toBe(true);
    w.runner.dispose(); expect(w.drive.eventDrivenFeedback).toBe(false); expect((w.behavior as RVErraticDriver).random).toBeNull();
  });
});

describe('DES Erratic owner streams', () => {
  it.each([1, 2] as const)('v%s: the very first Core.Cycle draws its first target from the injected stream', version => {
    const w = runnerWorld(RVErraticDriver, version);
    const owner = w.behavior as RVErraticDriver;
    expect(w.pending()[0].time).toBe(0);
    expect(w.drive.eventDrivenFeedback).toBe(true);
    expect(w.drive.onCommand).toBeTypeOf('function');
    expect(owner.random).toBeTypeOf('function');
    const stream = w.runner.registerRngOwner('#Axis@ErraticPosition');
    const initial = stream.getState(), expected = owner.MinPos + stream.next() * (owner.MaxPos - owner.MinPos);
    stream.setState(initial);
    const random = vi.spyOn(Math, 'random');
    try {
      expect(w.runner.step()).toBe(true);
      expect(w.drive.targetPosition).toBe(expected);
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });

  for (const version of [1, 2] as const) {
    function targets(w: ReturnType<typeof runnerWorld>, count: number) {
      const values: number[] = [];
      for (let i = 0; i < count; i++) {
        // Force the next autonomous target choice; draws still go through the real cycle.
        w.behavior!.resetRunState!(); w.tick(); values.push(w.drive.targetPosition);
      }
      return values;
    }
    it(`v${version}: same seed, restore after draws, reset and seed replacement`, async () => {
      const a = runnerWorld(RVErraticDriver, version), b = runnerWorld(RVErraticDriver, version);
      const managerState = a.manager.rng.getState();
      const random = vi.spyOn(Math, 'random');
      let first: number[];
      try { first = targets(a, 8); expect(random).not.toHaveBeenCalled(); }
      finally { random.mockRestore(); }
      if (version === 1) expect(a.manager.rng.getState()).toEqual(managerState);
      expect(targets(b, 8)).toEqual(first);
      const ownerState = a.runner.registerRngOwner('#Axis@ErraticPosition').getState();
      a.runner.setRngVersion(version);
      expect(a.runner.registerRngOwner('#Axis@ErraticPosition').getState()).toEqual(ownerState);
      a.runner.setCycleTime(DT); // a resync retains the existing cursor
      expect(a.runner.registerRngOwner('#Axis@ErraticPosition').getState()).toEqual(ownerState);
      const stream = a.runner.registerRngOwner('#Axis@ErraticPosition');
      a.runner.setCycleTime(DT * 2); // recreates the cycle while the same run continues
      expect(a.runner.registerRngOwner('#Axis@ErraticPosition')).toBe(stream);
      expect(stream.getState()).toEqual(ownerState);
      b.runner.setCycleTime(DT * 2);
      expect(targets(a, 5)).toEqual(targets(b, 5));
      const saved = a.runner.snapshotJson(); const next = targets(a, 10);
      b.runner.restoreJson(saved); expect(targets(b, 10)).toEqual(next);
      a.runner.restoreJson(saved); expect(targets(a, 10)).toEqual(next);
      a.runner.reset(); await a.runner.whenCycleOwnersReady(); expect(targets(a, 8)).toEqual(first);
      expect(a.runner.registerRngOwner('#Axis@ErraticPosition')).toBe(stream);
      a.runner.setMasterSeed(731); b.runner.setMasterSeed(731);
      expect(targets(a, 8)).toEqual(first); expect(targets(b, 8)).toEqual(first);
      a.runner.setMasterSeed(732); expect(targets(a, 8)).not.toEqual(first);
    });
    it(`v${version}: rejects unknown, missing and malformed owners in preflight`, () => {
      const w = runnerWorld(RVErraticDriver, version);
      for (const bad of ['unknown', 'missing', 'shape']) {
        const saved = JSON.parse(w.runner.snapshotJson());
        const rng = saved.parts.find((p: { key: string }) => p.key === 'des.rng').state;
        if (version === 1) {
          const key = Object.keys(rng.ownerStates)[0];
          if (bad === 'unknown') { rng.ownerStates.unknown = [...rng.ownerStates[key]]; }
          else if (bad === 'missing') delete rng.ownerStates[key];
          else rng.ownerStates[key] = [1, 2, 3, -1];
        } else {
          if (bad === 'unknown') rng.streams.push({ ...rng.streams[0], id: 'unknown', state: { ...rng.streams[0].state } });
          else if (bad === 'missing') rng.streams = [];
          else rng.streams[0].state.counter = -1;
        }
        const before = w.runner.snapshotJson();
        expect(() => w.runner.restoreFull(saved)).toThrow(/RNG/); expect(w.runner.snapshotJson()).toBe(before);
      }
    });
    it(`v${version}: removes absent owners and safely replaces an owner at the same address`, () => {
      const w = runnerWorld(RVErraticDriver, version);
      const key = '#Axis@ErraticPosition';
      const original = w.behavior as RVErraticDriver;
      const stream = w.runner.registerRngOwner(key), initial = stream.getState();
      targets(w, 5);
      w.drive.driveBehaviors.splice(w.drive.driveBehaviors.indexOf(original), 1);
      const replacement = new RVErraticDriver(w.drive.node);
      replacement.init({ scene: w.scene, root: w.scene, registry: w.registry, signalStore: w.store } as unknown as ComponentContext);
      w.runner.setCycleTime(DT * 2);
      expect(original.random).toBeNull();
      const next = w.runner.registerRngOwner(key);
      expect(next).not.toBe(stream); expect(next.getState()).toEqual(initial);
      replacement.resetRunState(); w.tick(); // the replacement's injected callback remains usable
      w.drive.driveBehaviors.splice(w.drive.driveBehaviors.indexOf(replacement), 1);
      w.runner.setCycleTime(DT);
      const rng = () => w.runner.fullSnapshot().parts.find(p => p.key === 'des.rng')!.state;
      expect(JSON.stringify(rng())).not.toContain(key);
      expect(replacement.random).toBeNull();
      w.runner.dispose();
      expect(w.manager.streamEntries().some(s => s.id === key)).toBe(false);
    });
  }
});

describe('DES arrival and zero-time feedback integration', () => {
  for (const restart of [false, true]) it(`onArrived fires once per arrival (feedback restart=${restart})`, () => {
    const w = runnerWorld(); w.drive.UseAcceleration = false; w.drive.targetSpeed = 25;
    const arrived = vi.fn(); addArrivedListener(w.core!.desHost, arrived);
    let restarted = false;
    w.drive.addAfterUpdate(d => {
      if (restart && d.arrivedThisUpdate && !restarted) { restarted = true; d.startMove(1); }
    });
    w.drive.startMove(0.1); w.tick(); expect(arrived).toHaveBeenCalledOnce();
    if (restart) { expect(w.drive.isAtTarget).toBe(false); while (!w.drive.isAtTarget) w.tick(); }
    const expected = restart ? 2 : 1;
    expect(arrived).toHaveBeenCalledTimes(expected); w.tick(); w.tick(); expect(arrived).toHaveBeenCalledTimes(expected);
  });

  it('Festo P40 fake event participant stays in 123 until arrival, then reaches 130', () => {
    const w = runnerWorld(RVDriveDestinationMotor);
    const b = w.behavior as RVDriveDestinationMotor;
    b.commandStartDrive(true); w.tick(); b.commandStartDrive(false);
    expect(w.store.getBoolByPath(w.slots.IsAtDestination)).toBe(true);
    let step = 122;
    const seen: boolean[] = [];
    w.runner.simEvents.registerEventParticipant('test.p40', 10, {
      readSet: () => [w.slots.IsAtDestination], dueTime: () => null,
      settle(_t, image) {
        seen.push(Boolean(image.get(w.slots.IsAtDestination)));
        if (step === 122) {
          w.input('Destination', 25); w.input('StartDrive', true); step = 123;
          expect(w.store.getBoolByPath(w.slots.IsAtDestination)).toBe(false);
          return true;
        }
        if (step === 123) {
          w.input('StartDrive', false);
          if (image.get(w.slots.IsAtDestination)) { step = 130; return true; }
        }
        return false;
      },
    });
    w.runner.simEvents.wake('test.p40'); w.tick();
    expect(step).toBe(123); expect(seen.slice(0, 2)).toEqual([true, false]);
    for (let i = 0; i < 1000 && step !== 130; i++) {
      w.tick(); if (!w.drive.isAtTarget) expect(step).toBe(123);
    }
    expect(step).toBe(130); expect(w.drive.isAtTarget).toBe(true);
  });
});
