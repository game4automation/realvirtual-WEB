// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * axis-contract-overload.test.ts — plan-673 Phase 4.
 *
 * Three subjects, and the first one is the reason the phase exists:
 *
 * 1. **The base share of the following error is subtracted.** A MuJoCo position
 *    actuator is P+D without an integral term, so a dynamic axis sits at
 *    `tau/Kp` forever. The Phase-1 gate measured 1.07 deg of axis sag at the
 *    stock gain and 0.10 deg at the gain the component defaults to. A model
 *    comparing the RAW error against a window reports permanent overload —
 *    so the test drives a sag-only axis for a simulated minute and requires
 *    SILENCE, and then proves the same axis still reports a real jam.
 * 2. **The cascade.** A dynamic axis gets a setpoint, a kinematic one gets a
 *    position, and the IK path takes the branch from the role — not from a
 *    runtime switch.
 * 3. **The gripper half.** The jam is visible at the gripper in two of three
 *    measured failure cases, so the slip is measured in the JAW frame and has
 *    its own window.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  applySchema,
  getFieldDescriptor,
  getRegisteredFactories,
  setComponentInstance,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { RVDynamicAxis, DYNAMIC_AXIS_TYPE } from '../src/core/engine/rv-dynamic-axis';
import { RVGripLoad, GRIP_LOAD_TYPE } from '../src/core/engine/rv-grip-load';
import { RVDrive, DriveDirection, DEFAULT_ARRIVAL_TOLERANCE } from '../src/core/engine/rv-drive';
import {
  AXIS_ROLE_CONFLICT,
  arrivalToleranceOf,
  auditAxisRoles,
  axisRoleOf,
  bindDynamicAxis,
  commandAxisPosition,
  dynamicAxisOf,
  isDynamicAxis,
  unbindDynamicAxis,
} from '../src/core/engine/rv-axis-contract';
import {
  AXIS_OVERLOAD,
  GRIP_SLIP,
  AxisDiagnosticsManager,
  netFollowingError,
} from '../src/core/engine/rv-axis-diagnostics';
import { claimAxes, releaseAllAxes, plannerCommandedAxes, registerAxisOwnershipParticipant } from '../src/core/engine/rv-axis-ownership';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import '../src/core/engine/rv-scene-loader';

/** Minimal context — these components touch nothing but their own node. */
const CTX = {} as unknown as ComponentContext;

function build<T>(type: string, extras: Record<string, unknown> = {}, node = new Object3D()): T {
  const factory = getRegisteredFactories().get(type);
  if (!factory) throw new Error(`no factory for ${type}`);
  const inst = factory.create(node, null);
  factory.beforeSchema?.(inst, extras);
  applySchema(inst as unknown as Record<string, unknown>, factory.schema, extras);
  setComponentInstance(node, inst);
  inst.init(CTX);
  return inst as unknown as T;
}

/** A bare drive, wired to a node, with no behaviors. */
function makeDrive(name = 'A2'): RVDrive {
  const node = new Object3D();
  node.name = name;
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.RotationZ;
  return drive;
}

/** A dynamic axis bound to a drive, both built from scratch. */
function makeDynamic(extras: Record<string, unknown> = {}, name = 'A2'): { axis: RVDynamicAxis; drive: RVDrive } {
  const drive = makeDrive(name);
  const axis = build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, extras, drive.node);
  // No registry in this context, so the component cannot find the sibling Drive
  // itself — the binding is what `init()` does when there is one.
  axis.drive = drive;
  bindDynamicAxis(drive, axis);
  return { axis, drive };
}

const unregisters: (() => void)[] = [];

beforeEach(() => {
  for (const u of unregisters.splice(0)) u();
  releaseAllAxes();
  RVDynamicAxis.clearAll();
  RVGripLoad.clearAll();
  clearAllProblems();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('every new property has a real inspector editor', () => {
  /**
   * Thomas' rule (cs:10960): a parameter has a type, a unit and a default, and
   * every property needs an editor a person can actually use. Phase 2 built the
   * machinery that carries schema bounds into `NumberEditor`; these seven
   * fields have to USE it, not re-invent it.
   */
  const EXPECTED: ReadonlyArray<readonly [string, string, string, 'number' | 'enum']> = [
    [DYNAMIC_AXIS_TYPE, 'FollowingErrorLimit', 'mm', 'number'],
    [DYNAMIC_AXIS_TYPE, 'FollowingErrorTimeMs', 'ms', 'number'],
    [DYNAMIC_AXIS_TYPE, 'ArrivalTolerance', 'mm', 'number'],
    [GRIP_LOAD_TYPE, 'GripForce', 'N', 'number'],
    [GRIP_LOAD_TYPE, 'SlipLimit', 'mm', 'number'],
    [GRIP_LOAD_TYPE, 'SlipTimeMs', 'ms', 'number'],
  ];

  it.each(EXPECTED)('%s.%s is a %s field with a unit and a lower bound', (type, field, unit, kind) => {
    const desc = getFieldDescriptor(type, field);
    expect(desc, `${type}.${field} not registered`).toBeDefined();
    expect(desc!.type).toBe(kind);
    expect(desc!.unit).toBe(unit);
    // Not a single one of them can be negative, and the bound reaches the field.
    expect(desc!.min).toBe(0);
    expect(desc!.default).toBeTypeOf('number');
  });

  it('GripLoad.Mode is a named select, not a free string', () => {
    const desc = getFieldDescriptor(GRIP_LOAD_TYPE, 'Mode');
    expect(desc?.type).toBe('enum');
    expect(Object.keys(desc?.enumMap ?? {}).sort()).toEqual(['forcefit', 'formfit']);
    expect(desc?.default).toBe('formfit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the base share of the following error', () => {
  it('is subtracted from the magnitude, never signed', () => {
    // The sag's sign depends on which way gravity pulls at the current pose, so
    // a signed subtraction would ADD to the error in half the workspace.
    expect(netFollowingError(0.12, 0.1)).toBeCloseTo(0.02, 9);
    expect(netFollowingError(-0.12, 0.1)).toBeCloseTo(0.02, 9);
    // Never negative: an axis closer than its declared sag is simply fine.
    expect(netFollowingError(0.05, 0.1)).toBe(0);
    // A negative declaration cannot inflate the error.
    expect(netFollowingError(0.3, -5)).toBeCloseTo(0.3, 9);
  });

  it('keeps the overload model SILENT on an axis that only sags — one simulated minute', () => {
    // The measured case: Kp 80000 leaves 0.10 deg of permanent axis sag, and
    // the window is 0.5 deg. Without the subtraction the raw 0.10 deg would
    // still be inside 0.5 — so the test uses the STOCK-gain sag of 1.07 deg,
    // which is what a model that forgets to subtract reports forever.
    const { axis, drive } = makeDynamic({ BaseFollowingError: 1.07, FollowingErrorLimit: 0.5, FollowingErrorTimeMs: 200 });
    const mgr = new AxisDiagnosticsManager(() => null);
    drive.commandPosition(30);
    for (let i = 0; i < 3600; i++) {               // 60 s at 60 Hz
      drive.reportDynamicSample(30 - 1.07, 120, false);
      mgr.update(1 / 60);
    }
    expect(mgr.isOverloaded(axis)).toBe(false);
    expect(getProblems().filter((p) => p.code === AXIS_OVERLOAD)).toHaveLength(0);
    // And the number the signal carries is the NET error, i.e. ~0 — not 1.07.
    expect(netFollowingError(drive.followingError, axis.BaseFollowingError)).toBeCloseTo(0, 6);
  });

  it('reports the SAME axis once the error exceeds the sag by more than the window', () => {
    const { axis, drive } = makeDynamic({ BaseFollowingError: 1.07, FollowingErrorLimit: 0.5, FollowingErrorTimeMs: 200 });
    const mgr = new AxisDiagnosticsManager(() => null);
    drive.commandPosition(30);
    // 2.0 deg of refusal: net = 2.0 - 1.07 = 0.93 > 0.5.
    for (let i = 0; i < 60; i++) {                 // 1 s
      drive.reportDynamicSample(28, 370, true);
      mgr.update(1 / 60);
    }
    expect(mgr.isOverloaded(axis)).toBe(true);
    const found = getProblems().filter((p) => p.code === AXIS_OVERLOAD);
    expect(found).toHaveLength(1);
    // The numbers are IN the message — a finding that says only "overload"
    // cannot be told apart from servo sag by the person reading it.
    expect(found[0].detail).toContain('0.930');
    expect(found[0].detail).toContain('1.070');
    expect(found[0].detail).toContain('AT THE FORCE LIMIT');
    // …and it is a report, not a trip.
    expect(found[0].severity).toBe('warning');
    expect(found[0].detail).toContain('keeps running');
  });

  it('needs the window to be exceeded for the declared TIME, not for one tick', () => {
    const { axis, drive } = makeDynamic({ FollowingErrorLimit: 0.5, FollowingErrorTimeMs: 200 });
    const mgr = new AxisDiagnosticsManager(() => null);
    drive.commandPosition(10);
    // 10 ticks of 10 ms = 100 ms outside the window: not yet.
    for (let i = 0; i < 10; i++) {
      drive.reportDynamicSample(8, 0, false);
      mgr.update(0.01);
    }
    expect(mgr.isOverloaded(axis)).toBe(false);
    for (let i = 0; i < 11; i++) {
      drive.reportDynamicSample(8, 0, false);
      mgr.update(0.01);
    }
    expect(mgr.isOverloaded(axis)).toBe(true);
    // Recovery retracts the entry — a stale finding is worse than none.
    drive.reportDynamicSample(10, 0, false);
    mgr.update(0.01);
    expect(mgr.isOverloaded(axis)).toBe(false);
    expect(getProblems().filter((p) => p.code === AXIS_OVERLOAD)).toHaveLength(0);
  });

  it('never reports an overload while the window is 0 (monitoring off)', () => {
    const { axis, drive } = makeDynamic({ FollowingErrorLimit: 0 });
    const mgr = new AxisDiagnosticsManager(() => null);
    drive.commandPosition(100);
    for (let i = 0; i < 600; i++) {
      drive.reportDynamicSample(0, 999, true);     // 100 deg of refusal
      mgr.update(1 / 60);
    }
    expect(axis.monitorsFollowingError).toBe(false);
    expect(mgr.isOverloaded(axis)).toBe(false);
    expect(getProblems().filter((p) => p.code === AXIS_OVERLOAD)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the axis role and the cascade', () => {
  it('a plain drive is kinematic, a claimed one is planned, a declared one is dynamic', () => {
    const plain = makeDrive('plain');
    expect(axisRoleOf(plain)).toBe('kinematic');

    claimAxes([plain], 'test-owner');
    expect(axisRoleOf(plain)).toBe('planned');
    releaseAllAxes();

    const { drive } = makeDynamic({}, 'dyn');
    expect(axisRoleOf(drive)).toBe('dynamic');
    // dynamic OUTRANKS planned: a claimed policy axis is still dynamic, because
    // the claim says who writes the setpoint, not who integrates.
    claimAxes([drive], 'policy-owner');
    expect(axisRoleOf(drive)).toBe('dynamic');
  });

  it('writes a SETPOINT on a dynamic axis and a POSITION on a kinematic one', () => {
    const kinematic = makeDrive('kin');
    kinematic.currentPosition = 5;
    commandAxisPosition(kinematic, 42);
    expect(kinematic.currentPosition).toBe(42);
    expect(kinematic.targetPosition).toBe(42);

    const { drive } = makeDynamic({}, 'dyn');
    drive.currentPosition = 5;
    commandAxisPosition(drive, 42);
    // The position is the physics' answer and must NOT be touched here — that
    // is the "last writer in the tick wins" race the contract prevents.
    expect(drive.currentPosition).toBe(5);
    expect(drive.commandedPosition).toBe(42);
    expect(drive.followingError).toBe(37);
  });

  it('binding and unbinding moves the arrival tolerance with the declaration', () => {
    const { axis, drive } = makeDynamic({ BaseFollowingError: 0.1, FollowingErrorLimit: 0.5 });
    // Derived: base + window, so the band it may sit in without being called
    // overloaded is the band in which it counts as arrived.
    expect(arrivalToleranceOf(axis)).toBeCloseTo(0.6, 9);
    expect(drive.arrivalTolerance).toBeCloseTo(0.6, 9);
    // A dynamic axis is never STRICTER than a kinematic one.
    const tiny = makeDynamic({ BaseFollowingError: 0, FollowingErrorLimit: 0 }, 'tiny');
    expect(tiny.drive.arrivalTolerance).toBe(DEFAULT_ARRIVAL_TOLERANCE);
    // An authored value wins.
    axis.ArrivalTolerance = 2;
    axis.reapplyConfig();
    expect(drive.arrivalTolerance).toBe(2);
    // Unbinding hands the kinematic tolerance back.
    unbindDynamicAxis(drive, axis);
    expect(drive.arrivalTolerance).toBe(DEFAULT_ARRIVAL_TOLERANCE);
    expect(isDynamicAxis(drive)).toBe(false);
    expect(dynamicAxisOf(drive)).toBeNull();
  });

  it('widens isAtTarget so a dynamic axis can ever be reported as arrived', () => {
    const { drive } = makeDynamic({ BaseFollowingError: 0.1, FollowingErrorLimit: 0.5 }, 'arr');
    drive.targetPosition = 30;
    // 0.1 deg of permanent sag: a kinematic 0.01 tolerance would wait forever,
    // which 2.4 names as the most common practical stumbling block.
    drive.currentPosition = 29.9;
    expect(drive.isAtTarget).toBe(true);
    drive.currentPosition = 29.2;                  // beyond base + window
    expect(drive.isAtTarget).toBe(false);
  });

  it('a sim reset drops the command and the diagnostics, not the declaration', () => {
    const { drive } = makeDynamic({ ArrivalTolerance: 2 }, 'res');
    drive.commandPosition(40);
    drive.reportDynamicSample(10, 99, true);
    drive.reset();
    expect(Number.isNaN(drive.commandedPosition)).toBe(true);
    expect(drive.followingError).toBe(0);
    expect(drive.actualTorque).toBe(0);
    expect(drive.saturated).toBe(false);
    // The tolerance is a property of the axis declaration, not of the run.
    expect(drive.arrivalTolerance).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the axis-role audit', () => {
  it('reports a declaration with no Drive on its node', () => {
    const node = new Object3D();
    node.name = 'Orphan';
    const axis = build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, {}, node);
    expect(axis.drive).toBeNull();
    const conflicts = auditAxisRoles([axis], new Set());
    expect(conflicts.map((c) => c.reason)).toEqual(['no-drive']);
    const found = getProblems().filter((p) => p.code === AXIS_ROLE_CONFLICT);
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain('Orphan');
  });

  it('reports a policy claim on an axis a path planner commands', () => {
    const { axis, drive } = makeDynamic({ SetpointSource: 'policy' }, 'A1');
    expect(axis.claimsAxis).toBe(true);
    unregisters.push(registerAxisOwnershipParticipant({
      label: 'TestPath',
      drives: [drive],
      isActive: () => true,
      pause: () => {},
      resume: () => {},
    }));
    // The set comes from the ownership participants, so the audit covers every
    // planner kind rather than the one the auditor thought of.
    expect(plannerCommandedAxes().has(drive)).toBe(true);
    const conflicts = auditAxisRoles([axis], plannerCommandedAxes());
    expect(conflicts.map((c) => c.reason)).toEqual(['policy-claims-planner']);
  });

  it('stays quiet for a planner-driven dynamic axis — the normal case', () => {
    const { axis, drive } = makeDynamic({ SetpointSource: 'planner' }, 'A3');
    unregisters.push(registerAxisOwnershipParticipant({
      label: 'TestPath',
      drives: [drive],
      isActive: () => true,
      pause: () => {},
      resume: () => {},
    }));
    expect(auditAxisRoles([axis], plannerCommandedAxes())).toEqual([]);
    expect(getProblems().filter((p) => p.code === AXIS_ROLE_CONFLICT)).toHaveLength(0);
  });

  it('replaces its own findings instead of stacking them on a re-audit', () => {
    const node = new Object3D();
    node.name = 'Orphan';
    const axis = build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, {}, node);
    auditAxisRoles([axis], new Set());
    auditAxisRoles([axis], new Set());
    expect(getProblems().filter((p) => p.code === AXIS_ROLE_CONFLICT)).toHaveLength(1);
    auditAxisRoles([], new Set());
    expect(getProblems().filter((p) => p.code === AXIS_ROLE_CONFLICT)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the gripper half — the quantity the axes do not show', () => {
  /** A grip load with a part held in `forcefit`, both at the origin. */
  function makeGrip(extras: Record<string, unknown> = {}): { load: RVGripLoad; jaws: Object3D; part: Object3D } {
    const jaws = new Object3D();
    jaws.name = 'Gripper';
    const load = build<RVGripLoad>(GRIP_LOAD_TYPE, extras, jaws);
    const part = new Object3D();
    return { load, jaws, part };
  }

  it('measures the slip in the JAW frame, so moving the gripper is not slip', () => {
    const { load, jaws, part } = makeGrip({ Mode: 'forcefit', SlipLimit: 3 });
    load.holdPart(part);
    expect(load.measure()).toBe(0);                 // latches the reference

    // The whole gripper travels half a metre: the part rides along, no slip.
    jaws.position.set(0.5, 0.2, -0.3);
    part.position.copy(jaws.position);
    expect(load.measure()).toBeCloseTo(0, 6);

    // Now the part slides 20 mm inside the jaws — the measured failure case.
    part.position.add(new Vector3(0.02, 0, 0));
    expect(load.measure()).toBeCloseTo(20, 4);
  });

  it('says a formfit grip cannot slip instead of displaying a reassuring zero', () => {
    const { load, part } = makeGrip({ Mode: 'formfit', SlipLimit: 3 });
    load.holdPart(part);
    part.position.set(1, 1, 1);
    expect(load.slipMeasurable).toBe(false);
    expect(load.monitorsSlip).toBe(false);
    expect(load.measure()).toBe(0);
  });

  it('reports the slip through its own window, with the numbers in the message', () => {
    const { load, part } = makeGrip({ Mode: 'forcefit', SlipLimit: 3, SlipTimeMs: 100, GripForce: 100 });
    const mgr = new AxisDiagnosticsManager(() => null);
    mgr.update(0.01);                               // latch the reference
    part.position.set(0, 0, 0);
    load.holdPart(part);
    mgr.update(0.01);
    expect(mgr.isSlipping(load)).toBe(false);

    part.position.set(0.0167, 0, 0);                // 16.7 mm — the skew-push case
    for (let i = 0; i < 11; i++) mgr.update(0.01);
    expect(mgr.isSlipping(load)).toBe(true);
    const found = getProblems().filter((p) => p.code === GRIP_SLIP);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toContain('16.70 mm');
    expect(found[0].detail).toContain('100.0 N');
    // The reason this measurement exists at all is named in the finding.
    expect(found[0].detail).toContain('two of three');
  });

  it('shows the measured clamping force when the runtime supplies one, else the declared', () => {
    const { load } = makeGrip({ Mode: 'forcefit', GripForce: 100 });
    expect(load.forceN).toBe(100);
    load.measuredForce = 42.5;
    expect(load.forceN).toBe(42.5);
    load.reset();
    expect(load.forceN).toBe(100);
  });

  it('forgets the reference when the part changes, so slip is always "since this grasp"', () => {
    const { load, part } = makeGrip({ Mode: 'forcefit', SlipLimit: 3 });
    load.holdPart(part);
    load.measure();
    part.position.set(0.05, 0, 0);
    expect(load.measure()).toBeCloseTo(50, 4);
    const other = new Object3D();
    other.position.set(2, 2, 2);
    load.holdPart(other);
    expect(load.slipMm).toBe(0);
    expect(load.measure()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the diagnostics pass', () => {
  it('writes every published value in ONE setMany batch per tick', () => {
    const batches: Record<string, boolean | number>[] = [];
    const store = { setMany: (u: Record<string, boolean | number>) => { batches.push({ ...u }); } };
    const mgr = new AxisDiagnosticsManager(() => store as never);
    // Three axes, each with its own four signals — one batch, not twelve calls.
    const made = ['A1', 'A2', 'A3'].map((n) => makeDynamic({ FollowingErrorLimit: 1 }, n));
    for (const { axis } of made) {
      axis.signals = {
        followingError: { name: `${axis.node.name}.FollowingError`, path: '', node: axis.node },
        isTorque: { name: `${axis.node.name}.IsTorque`, path: '', node: axis.node },
        saturated: { name: `${axis.node.name}.Saturated`, path: '', node: axis.node },
        overload: { name: `${axis.node.name}.Overload`, path: '', node: axis.node },
      };
    }
    made[1].drive.commandPosition(10);
    made[1].drive.reportDynamicSample(9, 7, true);
    mgr.update(1 / 60);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0])).toHaveLength(12);
    expect(batches[0]['A2.FollowingError']).toBeCloseTo(1, 9);
    expect(batches[0]['A2.IsTorque']).toBe(7);
    expect(batches[0]['A2.Saturated']).toBe(true);
    expect(batches[0]['A2.Overload']).toBe(false);  // window not yet exhausted
  });

  it('costs nothing and writes nothing when the model has no dynamic axis', () => {
    let calls = 0;
    const store = { setMany: () => { calls++; } };
    const mgr = new AxisDiagnosticsManager(() => store as never);
    expect(mgr.update(1 / 60)).toBe(false);
    expect(calls).toBe(0);
  });

  it('clear() retracts the live findings AND the audit findings', () => {
    const { axis, drive } = makeDynamic({ FollowingErrorLimit: 0.1, FollowingErrorTimeMs: 0 }, 'A4');
    const orphan = new Object3D();
    orphan.name = 'Orphan';
    const orphanAxis = build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, {}, orphan);
    const mgr = new AxisDiagnosticsManager(() => null);
    drive.commandPosition(10);
    drive.reportDynamicSample(5, 0, false);
    mgr.update(1 / 60);
    expect(mgr.isOverloaded(axis)).toBe(true);
    expect(getProblems().filter((p) => p.code === AXIS_ROLE_CONFLICT)).toHaveLength(1);
    expect(orphanAxis.drive).toBeNull();

    mgr.clear();
    expect(getProblems().filter((p) => p.code === AXIS_OVERLOAD)).toHaveLength(0);
    expect(getProblems().filter((p) => p.code === AXIS_ROLE_CONFLICT)).toHaveLength(0);
    // …and the lists are empty, so the next model does not measure the previous
    // model's axes. Nothing in src/ called the Phase-2 clearAll() before.
    expect(RVDynamicAxis.axes).toHaveLength(0);
    expect(RVGripLoad.loads).toHaveLength(0);
    expect(isDynamicAxis(drive)).toBe(false);
    expect(mgr.update(1 / 60)).toBe(false);
  });
});
