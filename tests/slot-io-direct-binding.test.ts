// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SlotIO — direct binding of signal slots that are not wired to a store signal.
 *
 * A slot whose field in the GLB points at no signal is the normal case when an
 * external signal is to be connected only in the viewer. The resolver offers
 * such a slot as `direct-property` / `direct-feedback` when the component
 * declared it in SlotIO (`rv-slot-io.ts`) or carries an own contract; otherwise
 * the row is `unavailable` and nothing can be bound to it.
 */

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Scene,
  Vector3,
} from 'three';
import '../src/core/engine/rv-signal-construction';
// plan-2227: the SignalConnector loads on demand in the app; registered here so the guard sees it.
import '../src/core/engine/rv-signal-connector';
import {
  constructComponentOnNode,
  type DriveLifecycleHost,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import {
  getRegisteredSchemaTypes,
  getSignalSlotFields,
  registerComponentSchema,
  type RVComponent,
} from '../src/core/engine/rv-component-registry';
import { DRIVE_BEHAVIOR_MAP } from '../src/core/engine/rv-signal-construction';
import {
  resolveBindableSlots,
  type ActiveBindableSlot,
  type BindableSlot,
  type DirectPropertySlot,
} from '../src/core/engine/rv-binding-slot-resolver';
import { RVDrive } from '../src/core/engine/rv-drive';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import { wireBoolSignal, wireNumberSignal } from '../src/core/engine/rv-signal-wiring';
import {
  slotBound,
  slotCommand,
  slotDeclare,
  slotDeclared,
  slotFeedbackSource,
  slotFeedbackValue,
  slotNeutralize,
  slotRead,
  slotTryRead,
  slotWrite,
} from '../src/core/engine/rv-slot-io';
import type { RVDriveProfidriveSpeed } from '../src/core/engine/rv-drive-profidrive-speed';
import type { RVDriveProfidrivePos } from '../src/core/engine/rv-drive-profidrive-pos';
import type { RVDriveSpeed } from '../src/core/engine/rv-drive-speed';
import { buildBehaviorRig } from './fixtures/drive-behavior-harness';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import type { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import type { RVZone } from '../src/core/engine/rv-zone';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import type { RVSceneButtonBase } from '../src/core/engine/rv-scene-button-base';
import type { RVPushButton3D } from '../src/core/engine/rv-push-button3d';

class FakeDriveHost implements DriveLifecycleHost {
  readonly drives: RVDrive[] = [];
  addDrive(drive: RVDrive): boolean {
    if (this.drives.includes(drive)) return false;
    this.drives.push(drive);
    return true;
  }
  removeDrive(drive: RVDrive): boolean {
    const i = this.drives.indexOf(drive);
    if (i < 0) return false;
    this.drives.splice(i, 1);
    return true;
  }
}

/** One unwired `Root/Axis` node in a fresh registry/store. */
function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager,
    driveHost: new FakeDriveHost(), events: new EventEmitter<ViewerEvents>(),
  };
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {};
  root.add(axis);
  registry.registerNode('Root/Axis', axis);
  return { scene, root, axis, registry, signalStore, deps };
}

const BUTTON_WRAPPERS = new Set(['PushButton3D', 'EmergencyButton3D', 'HandleSwitch3D']);

/**
 * Configuration the guard constructs a type with, where the default leaves a
 * slot deliberately unread. Zone reads `ActivationSignal` only with
 * `Activation = Signal`; the other activations are covered by their own test.
 */
const GUARD_EXTRAS: Record<string, Record<string, unknown>> = {
  Zone: { Activation: 'Signal' },
};

/** Construct `type` unwired on its own node; returns the node's resolved slots of that type. */
function resolveUnwired(type: string): { constructed: boolean; slots: BindableSlot[] } {
  const h = harness();
  // Drive behaviors and the encoder (`DrivePulseEncoder`) extend a Drive on the same node.
  const needsDrive = !!DRIVE_BEHAVIOR_MAP[type] || type.startsWith('Drive');
  const rv = h.axis.userData.realvirtual as Record<string, unknown>;
  if (needsDrive) {
    rv.Drive = { Direction: 'LinearX' };
    constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' });
  }
  // A 3D button wrapper configures the SceneButtonBase on its node or below.
  if (BUTTON_WRAPPERS.has(type)) {
    rv.SceneButtonBase = {};
    constructComponentOnNode(h.deps, h.axis, 'SceneButtonBase', {});
  }
  const extras = GUARD_EXTRAS[type] ?? {};
  rv[type] = { ...extras };
  let inst: unknown = null;
  try {
    inst = constructComponentOnNode(h.deps, h.axis, type, extras);
  } catch {
    inst = null;
  }
  const fields = new Set(getSignalSlotFields(type).map((f) => f.field));
  const slots = resolveBindableSlots(h.axis, h.signalStore, h.registry)
    .filter((s) => fields.has(s.slot)
      && (s.kind === 'unavailable' || s.componentType === type));
  return { constructed: !!inst, slots };
}

/**
 * Types whose unwired slots are not bindable yet — each with its reason. The
 * guard fails when a listed type becomes fully bindable, so the list cannot rot.
 */
const EXPECTED_UNAVAILABLE: Record<string, string> = {
  // Schema-only type (`registerComponentSchema`, no runtime component): there is
  // no instance to key a SlotIO slot on. `maintenance-parser.ts` reads the four
  // output refs and `MaintenanceTriggerHost` (plugins/demo) resolves and writes
  // them by signal name. Follow-up: SlotIO keyed by the plugin's procedure run.
  LogicStep_MaintenanceProcedure: 'outputs written by the maintenance plugin, no component instance',
  // Schema-only too (plan-2038 § 2.7): `BudgetResolver` (core/diagnostics/rv-blockage-budget.ts)
  // resolves SignalSuppress / SignalBlockageFound through the node registry at checker sample time.
  // The slots take an existing signal by drag; creating a fresh signal on an unwired node needs an
  // instance. Follow-up: SlotIO keyed by the declaring node.
  BlockageBudget: 'signals resolved by the blockage checker at sample time, no component instance',
  // plan-2227: a connector couples two MODEL signals (K3; signals rule 1/3 — the target is a PLC
  // input the model writes). A direct binding of an external signal to a connector slot would be a
  // K1 binding past the connector: bind the model signal instead, the connector carries it on.
  SignalConnector: 'couples two model signals (K3); external signals bind to those signals, not to the connector',
};

function slotTypes(): string[] {
  return getRegisteredSchemaTypes().filter((type) => getSignalSlotFields(type).length > 0).sort();
}

describe('SlotIO guard — every unwired signal slot is bindable', () => {
  it('lists only types that really carry signal slots', () => {
    const types = new Set(slotTypes());
    for (const type of Object.keys(EXPECTED_UNAVAILABLE)) {
      expect(types.has(type), `${type} is a registered slot type`).toBe(true);
    }
  });

  it.each(slotTypes())('%s', (type) => {
    const { constructed, slots } = resolveUnwired(type);
    const fields = getSignalSlotFields(type).map((f) => f.field);
    const unavailable = slots.filter((s) => s.kind === 'unavailable').map((s) => s.slot);
    const offered = new Set(slots.filter((s) => s.kind !== 'unavailable').map((s) => s.slot));
    const missing = fields.filter((f) => !offered.has(f));

    if (EXPECTED_UNAVAILABLE[type]) {
      // Must still be short of fully bindable — otherwise drop it from the list.
      expect(missing.length, `${type} is fully bindable now: remove it from EXPECTED_UNAVAILABLE`)
        .toBeGreaterThan(0);
      return;
    }
    expect(constructed, `${type} constructs on an unwired node`).toBe(true);
    expect(unavailable, `${type}: unavailable slots`).toEqual([]);
    expect(missing, `${type}: slots not offered`).toEqual([]);
  });
});

// ─── Fixtures for the direct-binding behaviour tests ─────────────────────────

/** An unwired Drive + behavior of `type` on `Root/Axis`, with its resolved direct slots. */
function directRig<T>(type: string, extras: Record<string, unknown> = {}) {
  const h = harness();
  const rv = h.axis.userData.realvirtual as Record<string, unknown>;
  rv.Drive = { Direction: 'LinearX' };
  const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' }) as RVDrive;
  rv[type] = {};
  const behavior = constructComponentOnNode(h.deps, h.axis, type, extras) as T;
  const slots = resolveBindableSlots(h.axis, h.signalStore, h.registry)
    .filter((s): s is ActiveBindableSlot => s.kind !== 'unavailable');
  const property = (slot: string): DirectPropertySlot => {
    const found = slots.find((s) => s.slot === slot && s.kind === 'direct-property');
    if (!found) throw new Error(`no direct-property slot ${slot}`);
    return found as DirectPropertySlot;
  };
  return {
    ...h,
    drive,
    behavior,
    command: (slot: string, value: boolean | number) => property(slot).command(value),
    neutralize: (slot: string) => property(slot).neutralize(),
  };
}

/** Bind `slot` of the rig's node to an external CONNECT signal through a real manager. */
function bindExternal(
  r: { signalStore: SignalStore; axis: Object3D },
  manager: SignalBindingManager,
  slot: string,
  signal: string,
  plcType: 'PLCOutputInt' | 'PLCInputInt',
): void {
  const control = plcType.startsWith('PLCOutput');
  r.signalStore.register(signal, `__iface__/${signal}`, 0, plcType);
  r.signalStore.registerSignalProvider({ interfaceId: 'plc', signal }, true);
  manager.bind('axis', r.axis, {
    kind: control ? 'direct-property' : 'direct-feedback',
    componentPath: '.',
    slot,
    signal,
    interfaceId: 'plc',
    direction: control ? 'plcOutput' : 'plcInput',
    enabled: true,
  });
}

// STW1 / ZSW1 bits (telegram 1 / 111), see tests/drive-profidrive.test.ts.
const ON_OFF1 = 1 << 0;
const NO_OFF2 = 1 << 1;
const NO_OFF3 = 1 << 2;
const ENABLE_OP = 1 << 3;
const ENABLE_RAMP = 1 << 4;
const CONTINUE_RAMP = 1 << 5;
const ENABLE_SETPOINT = 1 << 6;
const CTRL_PLC = 1 << 10;
const READY_WORD = NO_OFF2 | NO_OFF3 | ENABLE_OP | ENABLE_RAMP | CONTINUE_RAMP | ENABLE_SETPOINT | CTRL_PLC;
const RUN_WORD = READY_WORD | ON_OFF1;
const Z_READY_SWITCH_ON = 1 << 0;
const Z_READY_OPERATE = 1 << 1;
const Z_OP_ENABLED = 1 << 2;
const Z_TARGET_REACHED = 1 << 10;
const POS_READY = NO_OFF2 | NO_OFF3 | ENABLE_OP | ENABLE_RAMP | CONTINUE_RAMP | CTRL_PLC;
const POS_RUN = POS_READY | ON_OFF1;
const ACTIVATE = 1 << 6;
const MDI_ABS = 1 << 8;
const MDI_MODE = 1 << 15;

/** The FeedbackSource the resolver hands the binding manager for a declared feedback field. */
function resolvedFeedbackSource(inst: object, field: string) {
  registerComponentSchema('SlotIoProbe2012', { [field]: { type: 'componentRef', signal: 'PLCInputInt' } });
  const node = new Object3D();
  node.name = 'Probe';
  node.userData.realvirtual = { SlotIoProbe2012: {} };
  const registry = new NodeRegistry();
  registry.registerNode('Probe', node);
  registry.register('SlotIoProbe2012', 'Probe', inst);
  const slot = resolveBindableSlots(node, new SignalStore(), registry)[0];
  if (slot.kind !== 'direct-feedback') throw new Error(`expected direct-feedback, got ${slot.kind}`);
  return slot.source;
}

describe('SlotIO core', () => {
  it('reads the wired signal, else the direct value, else the fallback', () => {
    const store = new SignalStore();
    store.register('W', 'Root/W', 7, 'PLCOutputInt');
    const inst = {};
    slotDeclare(inst, 'Word', 'poll');
    expect(slotDeclared(inst, 'Word')).toBe('poll');
    expect(slotRead(store, inst, 'Word', null, 42)).toBe(42);
    expect(slotTryRead(store, inst, 'Word', null)).toBeUndefined();
    expect(slotBound(inst, 'Word', null)).toBe(false);
    slotCommand(inst, 'Word', 5);
    expect(slotRead(store, inst, 'Word', null, 42)).toBe(5);
    expect(slotTryRead(store, inst, 'Word', null)).toBe(5);
    expect(slotBound(inst, 'Word', null)).toBe(true);
    expect(slotRead(store, inst, 'Word', 'Root/W', 42)).toBe(7); // the wired signal wins
    slotNeutralize(inst, 'Word');
    expect(slotRead(store, inst, 'Word', null, 42)).toBe(42);
  });

  it('writes feedback to the wired signal and notifies only on a value change', () => {
    const writes: number[] = [];
    const writer = { setByPath: (_p: string, v: boolean | number) => { writes.push(Number(v)); } };
    const inst = {};
    slotDeclare(inst, 'Status', 'feedback');
    const source = resolvedFeedbackSource(inst, 'Status');
    let notified = 0;
    source.addFeedbackListener(() => { notified++; });
    slotWrite(inst, 'Status', 'Root/F', 3, writer as never);
    slotWrite(inst, 'Status', 'Root/F', 3, writer as never);
    slotWrite(inst, 'Status', null, 4, null);
    expect(writes).toEqual([3, 3]);
    expect(notified).toBe(2);
    expect(slotFeedbackValue(inst, 'Status')).toBe(4);
    expect(source.readFeedbackSlot('Status')).toBe(4);
  });
});

describe('SlotIO — Profidrive direct binding', () => {
  it('9.2 parity: the same input sequence wired and direct gives identical feedback and state', () => {
    const wired = buildBehaviorRig<RVDriveProfidriveSpeed>('Drive_ProfidriveSpeed', {
      ControlWord: 'PLCOutputInt',
      SpeedSetpoint: 'PLCOutputInt',
      StatusWord: 'PLCInputInt',
      SpeedActual: 'PLCInputInt',
    }, { ReferenceSpeed: 500 });
    const direct = directRig<RVDriveProfidriveSpeed>('Drive_ProfidriveSpeed', { ReferenceSpeed: 500 });
    const repeat = (n: number, step: [number, number]): [number, number][] => Array.from({ length: n }, () => step);
    const sequence: [number, number][] = [
      [READY_WORD, 0], [RUN_WORD, 0], [RUN_WORD, 0x4000],
      ...repeat(30, [RUN_WORD, 0x4000]),
      ...repeat(10, [RUN_WORD & ~ENABLE_SETPOINT, 0x4000]),
      ...repeat(10, [RUN_WORD, -0x2000]),
      [0, 0], [0, 0],
    ];
    let moved = false;
    for (const [stw1, nsoll] of sequence) {
      wired.set('ControlWord', stw1);
      wired.set('SpeedSetpoint', nsoll);
      direct.command('ControlWord', stw1);
      direct.command('SpeedSetpoint', nsoll);
      wired.drive.update(1 / 60);
      direct.drive.update(1 / 60);
      expect(slotFeedbackValue(direct.behavior, 'StatusWord')).toBe(wired.num('StatusWord'));
      expect(slotFeedbackValue(direct.behavior, 'SpeedActual')).toBe(wired.num('SpeedActual'));
      expect(direct.behavior.State).toBe(wired.behavior.State);
      expect(direct.drive.currentSpeed).toBe(wired.drive.currentSpeed);
      if (wired.drive.currentSpeed !== 0) moved = true;
    }
    expect(moved).toBe(true); // the sequence did move the axis
  });

  it('9.3 standstill: ZSW1 reaches the bound source signal through the handshake without motion', () => {
    const r = directRig<RVDriveProfidriveSpeed>('Drive_ProfidriveSpeed');
    const manager = new SignalBindingManager(r.signalStore, r.registry);
    bindExternal(r, manager, 'ControlWord', 'PLC.STW1', 'PLCOutputInt');
    bindExternal(r, manager, 'StatusWord', 'PLC.ZSW1', 'PLCInputInt');
    manager.tick(1 / 60);

    const step = (stw1: number): number => {
      r.signalStore.set('PLC.STW1', stw1);
      manager.tick(1 / 60);
      r.drive.update(1 / 60);
      return r.signalStore.getFloat('PLC.ZSW1');
    };
    expect(step(0x06) & (Z_READY_SWITCH_ON | Z_READY_OPERATE)).toBe(Z_READY_SWITCH_ON);
    expect(r.behavior.State).toBe('ReadyForSwitchingOn');
    expect(step(0x07) & (Z_READY_OPERATE | Z_OP_ENABLED)).toBe(Z_READY_OPERATE);
    expect(step(0x0f) & (Z_READY_SWITCH_ON | Z_READY_OPERATE | Z_OP_ENABLED))
      .toBe(Z_READY_SWITCH_ON | Z_READY_OPERATE | Z_OP_ENABLED);
    expect(r.behavior.State).toBe('Operation');
    expect(r.drive.currentSpeed).toBe(0);
    expect(r.drive.jogForward).toBe(false);
    manager.dispose();
  });

  it('9.4 positioning: the target-reached bit arrives via feedback after the move ends', () => {
    const r = directRig<RVDriveProfidrivePos>('Drive_ProfidrivePos');
    const manager = new SignalBindingManager(r.signalStore, r.registry);
    bindExternal(r, manager, 'StatusWord', 'PLC.ZSW1', 'PLCInputInt');
    manager.tick(1 / 60);
    const tick = (stw1: number, posStw1 = 0): number => {
      r.command('ControlWord', stw1);
      r.command('PosControlWord1', posStw1);
      manager.tick(1 / 60);
      r.drive.update(1 / 60);
      return r.signalStore.getFloat('PLC.ZSW1');
    };
    tick(POS_READY); tick(POS_RUN); tick(POS_RUN);
    expect(r.behavior.State).toBe('Operation');
    r.command('MdiTargetPosition', 100);
    r.command('MdiVelocity', 500);
    expect(tick(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS) & Z_TARGET_REACHED).toBe(0);
    expect(r.drive.isRunning).toBe(true);
    for (let i = 0; i < 600 && r.drive.isRunning; i++) tick(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS);
    const zsw1 = tick(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS);
    expect(r.drive.currentPosition).toBeCloseTo(100, 3);
    expect(zsw1 & Z_TARGET_REACHED).toBe(Z_TARGET_REACHED);
    manager.dispose();
  });
});

/** A small component wiring three unwired slots through the helpers' slot hook. */
function gadgetFixture() {
  registerComponentSchema('SlotIoGadget2012', {
    Run: { type: 'componentRef', signal: 'PLCOutputBool' },
    Speed: { type: 'componentRef', signal: 'PLCOutputFloat' },
    Enable: { type: 'componentRef', signal: 'PLCOutputBool' },
  });
  const store = new SignalStore();
  const reapply = new SignalReapplyRegistry();
  const instance = {
    Run: null as string | null,
    Speed: null as string | null,
    Enable: null as string | null,
    run: false,
    speed: 25,
    speedWrites: 0,
    enable: true,
  };
  const wires = [
    wireBoolSignal(store, instance.Run, (v) => { instance.run = v; }, undefined, reapply,
      { instance, field: 'Run' }),
    wireNumberSignal(store, instance.Speed, (v) => { instance.speed = v; instance.speedWrites++; }, undefined, reapply,
      { instance, field: 'Speed' }),
    wireBoolSignal(store, instance.Enable, (v) => { instance.enable = v; }, undefined, reapply,
      { instance, field: 'Enable', unbound: true }),
  ];
  const node = new Object3D();
  node.name = 'Gadget';
  node.userData.realvirtual = { SlotIoGadget2012: {} };
  const registry = new NodeRegistry();
  registry.registerNode('Gadget', node);
  registry.register('SlotIoGadget2012', 'Gadget', instance);
  const slots = resolveBindableSlots(node, store, registry);
  const property = (slot: string): DirectPropertySlot => {
    const found = slots.find((s) => s.slot === slot);
    if (found?.kind !== 'direct-property') throw new Error(`expected direct-property for ${slot}`);
    return found;
  };
  return {
    instance,
    reapply,
    slots,
    wires,
    command: (slot: string, value: boolean | number) => property(slot).command(value),
    neutralize: (slot: string) => property(slot).neutralize(),
  };
}

describe('SlotIO — neutralize per access type (9.5)', () => {
  it('poll: a neutralized Override falls back to 100 %', () => {
    const r = directRig<RVDriveProfidrivePos>('Drive_ProfidrivePos');
    const run = (stw1: number, posStw1 = 0) => {
      r.command('ControlWord', stw1);
      r.command('PosControlWord1', posStw1);
      r.drive.update(1 / 60);
    };
    run(POS_READY); run(POS_RUN); run(POS_RUN);
    r.command('MdiVelocity', 100);
    r.command('MdiTargetPosition', 50);
    r.command('Override', 0x2000); // 50 %
    run(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS);
    expect(r.drive.targetSpeed).toBeCloseTo(50, 6);
    r.neutralize('Override');
    run(POS_RUN, MDI_MODE | MDI_ABS);
    run(POS_RUN | ACTIVATE, MDI_MODE | MDI_ABS);
    expect(r.drive.targetSpeed).toBeCloseTo(100, 6);
  });

  it('Drive_Speed: neutralize restores the authored TargetSpeed and Acceleration', () => {
    const r = directRig<RVDriveSpeed>('Drive_Speed', { TargetSpeed: 120, Acceleration: 30 });
    r.command('SignalTargetSpeed', -240);
    r.command('SignalAcceleration', 60);
    r.drive.update(1 / 60);
    expect(r.drive.targetSpeed).toBe(240);
    expect(r.drive.jogBackward).toBe(true);
    r.neutralize('SignalTargetSpeed');
    r.neutralize('SignalAcceleration');
    expect(r.behavior.TargetSpeed).toBe(120);
    expect(r.behavior.Acceleration).toBe(30);
  });

  it('wire hooks: bool applies false (or its unbound default), number leaves the value standing', () => {
    const gadget = gadgetFixture();
    gadget.command('Run', true);
    gadget.command('Speed', 7);
    gadget.command('Enable', false);
    expect(gadget.instance.run).toBe(true);
    expect(gadget.instance.speed).toBe(7);
    expect(gadget.instance.enable).toBe(false);
    const speedWrites = gadget.instance.speedWrites;
    gadget.neutralize('Run');
    gadget.neutralize('Speed');
    gadget.neutralize('Enable');
    expect(gadget.instance.run).toBe(false);
    expect(gadget.instance.speed).toBe(7);
    expect(gadget.instance.speedWrites).toBe(speedWrites); // no write on neutralize
    expect(gadget.instance.enable).toBe(true); // unbound default
  });
});

describe('SlotIO — wire hook', () => {
  it('declares unwired fields as direct-property slots and drops them on unsubscribe', () => {
    const gadget = gadgetFixture();
    expect(gadget.slots.map((s) => [s.slot, s.kind])).toEqual([
      ['Run', 'direct-property'], ['Speed', 'direct-property'], ['Enable', 'direct-property'],
    ]);
    for (const wire of gadget.wires) wire.unsubscribe();
    expect(slotDeclared(gadget.instance, 'Run')).toBeNull();
  });

  it('a wired address keeps the helpers exactly as before and declares nothing', () => {
    const store = new SignalStore();
    store.register('Go', 'Root/Go', true, 'PLCOutputBool');
    const inst = { value: false };
    const res = wireBoolSignal(store, 'Root/Go', (v) => { inst.value = v; }, undefined, undefined,
      { instance: inst, field: 'Go' });
    expect(res.addr).toBe('Root/Go');
    expect(inst.value).toBe(true);
    expect(slotDeclared(inst, 'Go')).toBeNull();
    // No slot reference: an empty address stays the plain no-op.
    expect(wireBoolSignal(store, null, () => { throw new Error('called'); }).addr).toBeNull();
  });

  it('9.8 a setter slot survives a reset replay with its last direct value', () => {
    const gadget = gadgetFixture();
    gadget.command('Run', true);
    gadget.instance.run = false; // the reset clears the component state
    gadget.reapply.reapplyAll();
    expect(gadget.instance.run).toBe(true);
    gadget.neutralize('Run');
    gadget.reapply.reapplyAll();
    expect(gadget.instance.run).toBe(false);
  });
});

describe('SlotIO — property overrides restore the authored value on neutralize', () => {
  it('Drive_ProportionalValve: a neutralized setpoint returns to the authored one', () => {
    const r = directRig<RVComponent & { Setpoint: number }>('Drive_ProportionalValve', { Setpoint: 0, ResponseTime: 0 });
    r.command('SignalSetpoint', 10);
    r.drive.update(1 / 60);
    expect(r.behavior.Setpoint).toBe(10);
    expect(r.drive.jogForward).toBe(true);
    r.neutralize('SignalSetpoint');
    expect(r.behavior.Setpoint).toBe(0);
    r.drive.update(1 / 60);
    expect(r.drive.jogForward).toBe(false);
  });

  it('Drive_ContinousDestination: neutralize restores Destination, TargetSpeed and Acceleration', () => {
    const r = directRig<RVComponent & { Destination: number; TargetSpeed: number; Acceleration: number }>(
      'Drive_ContinousDestination', { Destination: 5, TargetSpeed: 80, Acceleration: 40 });
    r.command('SignalDestination', 50);
    r.command('SignalTargetSpeed', 300);
    r.command('SignalAcceleration', 900);
    expect([r.behavior.Destination, r.behavior.TargetSpeed, r.behavior.Acceleration]).toEqual([50, 300, 900]);
    r.neutralize('SignalDestination');
    r.neutralize('SignalTargetSpeed');
    r.neutralize('SignalAcceleration');
    expect([r.behavior.Destination, r.behavior.TargetSpeed, r.behavior.Acceleration]).toEqual([5, 80, 40]);
  });
});

describe('SlotIO — re-declaration', () => {
  it('moves a setter replay to the new registry instead of keeping the old one', () => {
    const inst = { v: false };
    const first = new SignalReapplyRegistry();
    const second = new SignalReapplyRegistry();
    const apply = (value: boolean | number) => { inst.v = value === true; };
    slotDeclare(inst, 'Go', 'setter', { apply, reapply: first });
    slotCommand(inst, 'Go', true);
    expect(first.size).toBe(1);
    slotDeclare(inst, 'Go', 'setter', { apply, reapply: second });
    expect(first.size).toBe(0);
    expect(second.size).toBe(1);
    inst.v = false;
    second.reapplyAll();
    expect(inst.v).toBe(true);
  });
});

// ─── Phase 3b: subscribing inputs and feedback writers of non-drive components ──

const boolRef = (path: string) => ({ type: 'ComponentReference', path, componentType: 'realvirtual.PLCOutputBool' });

/** The resolved slots of `type` on `node`, as the binding UI would see them. */
function slotsOf(node: Object3D, store: SignalStore, registry: NodeRegistry, type: string) {
  const all = resolveBindableSlots(node, store, registry)
    .filter((s) => s.kind === 'unavailable' || s.componentType === type);
  const property = (slot: string): DirectPropertySlot => {
    const found = all.find((s) => s.slot === slot);
    if (found?.kind !== 'direct-property') throw new Error(`expected direct-property for ${slot}, got ${found?.kind}`);
    return found;
  };
  return { all, property };
}

/** A Lamp with a lens mesh on `Root/Axis` — wired to two store signals, or unwired. */
function lampRig(wired: boolean) {
  const h = harness();
  const lens = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  lens.name = 'Lens';
  h.axis.add(lens);
  const reapply = new SignalReapplyRegistry();
  const lampManager = new LampManager();
  const data: Record<string, unknown> = { Period: 1 };
  if (wired) {
    h.signalStore.register('On', 'Signals/On', false);
    h.signalStore.register('Flash', 'Signals/Flash', false);
    data.SignalLampOn = boolRef('Signals/On');
    data.SingalLampFlashing = boolRef('Signals/Flash');
  }
  (h.axis.userData.realvirtual as Record<string, unknown>).Lamp = { ...data };
  const lamp = constructComponentOnNode({ ...h.deps, lampManager, reapply }, h.axis, 'Lamp', data) as RVLamp;
  const slots = slotsOf(h.axis, h.signalStore, h.registry, 'Lamp');
  const set = (on: boolean, flash: boolean): void => {
    if (wired) {
      h.signalStore.setByPath('Signals/On', on);
      h.signalStore.setByPath('Signals/Flash', flash);
    } else {
      slots.property('SignalLampOn').command(on);
      slots.property('SingalLampFlashing').command(flash);
    }
  };
  return { ...h, lamp, lampManager, reapply, slots, set };
}

describe('SlotIO — Lamp', () => {
  it('9.2 parity: the same input sequence wired and direct gives the same lamp state per step', () => {
    const wired = lampRig(true);
    const direct = lampRig(false);
    const sequence: [boolean, boolean][] = [
      [true, false], [true, false], [false, false], [false, true],
      [false, true], [true, true], [true, false], [false, false],
    ];
    let lit = false;
    for (const [on, flash] of sequence) {
      wired.set(on, flash);
      direct.set(on, flash);
      wired.lampManager.update(0.3);
      direct.lampManager.update(0.3);
      expect([direct.lamp.LampOn, direct.lamp.Flashing, direct.lamp.isLit()])
        .toEqual([wired.lamp.LampOn, wired.lamp.Flashing, wired.lamp.isLit()]);
      if (wired.lamp.isLit()) lit = true;
    }
    expect(lit).toBe(true); // the sequence did light the lamp
  });

  it('neutralize switches the lamp off; a rebind keeps the directly commanded state', () => {
    const r = lampRig(false);
    r.slots.property('SignalLampOn').command(true);
    expect(r.lamp.isLit()).toBe(true);
    r.lamp.reapplyConfig(); // `_rebind()` re-declares the unwired slots
    expect(r.lamp.LampOn).toBe(true);
    expect(r.lamp.isLit()).toBe(true);
    slotsOf(r.axis, r.signalStore, r.registry, 'Lamp').property('SignalLampOn').neutralize();
    expect(r.lamp.LampOn).toBe(false);
    expect(r.lamp.isLit()).toBe(false);
  });

  it('9.8 the directly commanded state survives a reset replay', () => {
    const r = lampRig(false);
    r.slots.property('SignalLampOn').command(true);
    r.lamp.LampOn = false; // the reset clears the component state
    r.lamp.setDisplayedLit(false);
    r.reapply.reapplyAll();
    expect(r.lamp.LampOn).toBe(true);
    expect(r.lamp.isLit()).toBe(true);
  });
});

/** An unwired Unity-semantics Source (`Test/Source`) loaded through the scene loader. */
function sourceRig(properties: Record<string, unknown> = {}) {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Test';
  scene.add(root);
  const node = new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial());
  node.name = 'Source';
  node.position.y = 1;
  node.userData.realvirtual = { Source: { GenerateMU: false, AutomaticGeneration: true, ...properties } };
  root.add(node);
  scene.updateMatrixWorld(true);
  const manager = new RVTransportManager();
  manager.scene = scene;
  manager.preferCloneMU = true;
  const signals = new SignalStore();
  const registry = new NodeRegistry();
  const reapply = new SignalReapplyRegistry();
  processExtras(root, buildInitContext({ registry, signalStore: signals, transportManager: manager, scene, reapply }));
  const source = manager.sources[0];
  const slots = slotsOf(node, signals, registry, 'Source');
  const tick = (dt = 1 / 60) => manager.update(dt);
  const flags = () => source as unknown as { unityControls: boolean };
  return { manager, source, slots, tick, reapply, flags };
}

describe('SlotIO — Source', () => {
  it('9.7 a directly bound SourceGenerate generates MUs and governs AutomaticGeneration', () => {
    const r = sourceRig();
    expect(r.source.AutomaticGeneration).toBe(true);
    const generate = r.slots.property('SourceGenerate');
    generate.command(false);
    expect(r.source.AutomaticGeneration).toBe(false); // off while bound
    expect(r.flags().unityControls).toBe(true);
    r.tick();
    expect(r.manager.mus).toHaveLength(0);
    generate.command(true);
    r.tick(); r.tick();
    expect(r.manager.mus).toHaveLength(1); // one MU per rising edge
    generate.command(false); r.tick();
    generate.command(true); r.tick();
    expect(r.manager.mus).toHaveLength(2);
    generate.neutralize();
    expect(r.source.AutomaticGeneration).toBe(true); // restored after unbind
    expect(r.source.GenerateMU).toBe(false); // the authored unbound default
  });

  it('an inspector edit during a direct SourceGenerate binding keeps the distance spawn mode', () => {
    const r = sourceRig({ GenerateIfDistance: 300 });
    expect(r.source.spawnMode).toBe('Distance');
    const generate = r.slots.property('SourceGenerate');
    generate.command(true);
    generate.command(false);
    generate.command(true); // repeated pulses do not re-save the forced value
    expect(r.source.AutomaticGeneration).toBe(false);
    r.source.GenerateIfDistance = 400; // field edit while bound
    r.source.reapplyConfig();
    expect(r.source.spawnMode).toBe('Distance');
    expect(r.source.AutomaticGeneration).toBe(false); // still governed by the binding
    generate.neutralize();
    expect(r.source.spawnMode).toBe('Distance');
    expect(r.source.AutomaticGeneration).toBe(true);
  });

  it('a directly bound SourceGenerateOnDistance drives AutomaticGeneration; unbind restores it', () => {
    const r = sourceRig({ AutomaticGeneration: false });
    const distance = r.slots.property('SourceGenerateOnDistance');
    distance.command(true);
    r.tick();
    expect(r.source.AutomaticGeneration).toBe(true);
    distance.command(false);
    r.tick();
    expect(r.source.AutomaticGeneration).toBe(false);
    distance.command(true);
    r.tick();
    distance.neutralize();
    expect(r.source.AutomaticGeneration).toBe(false); // the authored value
  });

  it('9.8 the directly commanded GenerateMU survives a reset replay', () => {
    const r = sourceRig();
    r.slots.property('SourceGenerate').command(true);
    r.tick();
    expect(r.manager.mus).toHaveLength(1);
    r.source.reset();
    r.source.GenerateMU = false; // the reset clears the component state
    r.reapply.reapplyAll();
    expect(r.source.GenerateMU).toBe(true);
    r.tick();
    expect(r.manager.mus).toHaveLength(2); // a fresh run sees the held level as a new edge
  });
});

describe('SlotIO — Zone', () => {
  it('feedback: SignalOccupied reaches a bound listener at standstill', () => {
    const h = harness();
    const zoneData = { Size: { x: 200, y: 200, z: 200 } };
    (h.axis.userData.realvirtual as Record<string, unknown>).Zone = { ...zoneData };
    const zone = constructComponentOnNode(h.deps, h.axis, 'Zone', zoneData) as RVZone;
    const slot = resolveBindableSlots(h.axis, h.signalStore, h.registry)
      .find((s) => s.slot === 'SignalOccupied');
    if (slot?.kind !== 'direct-feedback') throw new Error(`expected direct-feedback, got ${slot?.kind}`);
    expect(slot.source).toBe(slotFeedbackSource(zone, 'SignalOccupied'));
    let notified = 0;
    slot.source.addFeedbackListener(() => { notified++; });
    expect(slot.source.readFeedbackSlot('SignalOccupied')).toBe(false);
    const part = new Object3D();
    part.name = 'part';
    h.deps.transportManager.mus.push(new RVMovingUnit(part, 'test', new Vector3(0.05, 0.05, 0.05)));
    for (let i = 0; i < 3; i++) h.deps.transportManager.update(1 / 60); // nothing moves
    expect(zone.occupied).toBe(true);
    expect(slot.source.readFeedbackSlot('SignalOccupied')).toBe(true);
    expect(notified).toBe(1);
  });

  it('ActivationSignal is refused with a reason unless Activation = Signal; a direct level activates', () => {
    const h = harness();
    (h.axis.userData.realvirtual as Record<string, unknown>).Zone = {};
    constructComponentOnNode(h.deps, h.axis, 'Zone', {});
    const refused = resolveBindableSlots(h.axis, h.signalStore, h.registry).find((s) => s.slot === 'ActivationSignal');
    expect(refused?.kind).toBe('unavailable');
    expect(refused?.kind === 'unavailable' ? refused.reason : '').toMatch(/only read with Activation = Signal/);

    const s = harness();
    const data = { Activation: 'Signal' };
    (s.axis.userData.realvirtual as Record<string, unknown>).Zone = { ...data };
    const zone = constructComponentOnNode(s.deps, s.axis, 'Zone', data) as RVZone;
    const activation = slotsOf(s.axis, s.signalStore, s.registry, 'Zone').property('ActivationSignal');
    zone.updateActivation();
    expect(zone.active).toBe(false);
    activation.command(true);
    zone.updateActivation();
    expect(zone.active).toBe(true);
    activation.neutralize();
    zone.updateActivation();
    expect(zone.active).toBe(false); // unbound: inactive, like an unwired signal activation
  });
});

describe('SlotIO — PushButton3D', () => {
  it('stateSignal publishes the click; a bound lightSignal takes the light, neutralize hands it back', () => {
    const h = harness();
    const rv = h.axis.userData.realvirtual as Record<string, unknown>;
    rv.SceneButtonBase = { isToggle: true };
    const base = constructComponentOnNode(h.deps, h.axis, 'SceneButtonBase', { isToggle: true }) as RVSceneButtonBase;
    rv.PushButton3D = { toggle: true };
    const button = constructComponentOnNode(h.deps, h.axis, 'PushButton3D', { toggle: true }) as RVPushButton3D;
    const slots = slotsOf(h.axis, h.signalStore, h.registry, 'PushButton3D');
    const state = slots.all.find((s) => s.slot === 'stateSignal');
    if (state?.kind !== 'direct-feedback') throw new Error(`expected direct-feedback, got ${state?.kind}`);
    expect(state.source.readFeedbackSlot('stateSignal')).toBe(false);
    base.onClick();
    expect(state.source.readFeedbackSlot('stateSignal')).toBe(true);
    expect(slotFeedbackValue(button, 'stateSignal')).toBe(true);

    expect(base.autoLight).toBe(true);
    const light = slots.property('lightSignal');
    light.command(false);
    expect(base.autoLight).toBe(false);
    light.neutralize();
    expect(base.autoLight).toBe(true);
  });
});
