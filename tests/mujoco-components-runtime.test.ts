// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mujoco-components-runtime.test.ts — plan-673 Phase 2 / 2b runtime behaviour.
 *
 * The components carry an authored declaration, so what there is to test is the
 * part that is NOT just storage: the clamping that makes a hand-edited GLB
 * behave like an inspector-edited one, the bake and pick capabilities an
 * obstacle needs (the whole point of replacing the `Drive{Direction:'Virtual'}`
 * misuse), the derived policy rate, the profile library's precedence, and the
 * one thing that must never happen silently — a non-reference `Axes` entry
 * being dropped the way `RobotIK.Axis` drops one today.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  applySchema,
  getCapabilities,
  getRegisteredFactories,
  setComponentInstance,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { RVMuJoCoRegion, MUJOCO_REGION_TYPE, enclosingMuJoCoRegion } from '../src/core/engine/rv-mujoco-region';
import { RVDynamicAxis, DYNAMIC_AXIS_TYPE } from '../src/core/engine/rv-dynamic-axis';
import {
  RVContactProfile, RVCollisionShapeSet,
  CONTACT_PROFILE_TYPE, COLLISION_SHAPE_SET_TYPE, COND_DIM_VALUES, condimOf,
} from '../src/core/engine/rv-contact-geometry';
import { RVFreeBody, RVMovable, FREE_BODY_TYPE, MOVABLE_TYPE } from '../src/core/engine/rv-free-body';
import {
  RVLocomotionPolicyComponent, LOCOMOTION_POLICY_TYPE, POLICY_AXIS_NOT_A_REFERENCE,
} from '../src/core/engine/rv-locomotion-policy-component';
import {
  LIBRARY_ROLES,
  contactProfileEntry,
  contactProfilePair,
  getContactProfileCatalog,
  resetContactProfileCatalog,
  resolveContactProfile,
  setContactProfileCatalog,
  unmeasuredProfileRoles,
  validateContactProfileCatalog,
} from '../src/core/engine/rv-contact-profile-library';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import '../src/core/engine/rv-scene-loader';

/** Minimal context: these components touch nothing but their own node. */
const CTX = {} as unknown as ComponentContext;

/** Build an instance through its registered factory, exactly as the loader does. */
function build<T>(type: string, extras: Record<string, unknown> = {}, node = new Object3D()): T {
  const factory = getRegisteredFactories().get(type);
  if (!factory) throw new Error(`no factory for ${type}`);
  const inst = factory.create(node, null);
  factory.beforeSchema?.(inst, extras);
  applySchema(inst as unknown as Record<string, unknown>, factory.schema, extras);
  // What the scene loader does, and what ancestor lookups read.
  setComponentInstance(node, inst);
  inst.init(CTX);
  return inst as unknown as T;
}

beforeEach(() => {
  RVMuJoCoRegion.clearAll();
  RVDynamicAxis.clearAll();
  RVContactProfile.clearAll();
  RVCollisionShapeSet.clearAll();
  RVFreeBody.clearAll();
  RVMovable.clearAll();
  RVLocomotionPolicyComponent.clearAll();
  resetContactProfileCatalog();
  clearAllProblems();
});

describe('WebMuJoCoRegion', () => {
  it('clamps a hand-edited timestep into the range the schema declares', () => {
    expect(build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { TimestepS: 0 }).TimestepS).toBe(0.0001);
    expect(build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { TimestepS: 5 }).TimestepS).toBe(0.1);
    expect(build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { TimestepS: 0.002 }).TimestepS).toBe(0.002);
  });

  it('falls back to composite for an unknown load tree mode', () => {
    expect(build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { LoadTreeMode: 'nonsense' }).LoadTreeMode).toBe('composite');
  });

  it('derives the policy rate from timestep and decimation — the one place that does', () => {
    const region = build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { TimestepS: 0.002 });
    expect(region.policyRateHz(4)).toBeCloseTo(125, 6);
    expect(region.policyRateHz(10)).toBeCloseTo(50, 6);
    // Decimation below 1 is meaningless; it is rounded up, never divided by zero.
    expect(region.policyRateHz(0)).toBeCloseTo(500, 6);
  });

  it('is found from a descendant node, so a policy can ask for its own rate', () => {
    const root = new Object3D();
    const child = new Object3D();
    const grandchild = new Object3D();
    root.add(child);
    child.add(grandchild);
    build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { TimestepS: 0.004 }, root);
    expect(enclosingMuJoCoRegion(grandchild)?.TimestepS).toBe(0.004);
    expect(enclosingMuJoCoRegion(new Object3D())).toBeNull();
  });
});

describe('DynamicAxis', () => {
  it('reports an unlimited actuator as unlimited (MuJoCo 0 … 0)', () => {
    expect(build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE).hasForceLimit).toBe(false);
    expect(build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, { ForceRangeMin: -20, ForceRangeMax: 20 }).hasForceLimit).toBe(true);
  });

  it('swaps an inverted force range instead of passing on an actuator that cannot move', () => {
    const axis = build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, { ForceRangeMin: 370, ForceRangeMax: -370 });
    expect([axis.ForceRangeMin, axis.ForceRangeMax]).toEqual([-370, 370]);
  });

  it('only a policy claims the axis exclusively', () => {
    for (const src of ['planner', 'signal', 'operator']) {
      expect(build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, { SetpointSource: src }).claimsAxis).toBe(false);
    }
    expect(build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE, { SetpointSource: 'policy' }).claimsAxis).toBe(true);
  });

  it('defaults to the gain the Phase-1 gate measured, not the stock one', () => {
    // 5000 left 14.9 mm of pure gravity sag at the tool, indistinguishable from
    // a contact refusal; 80000 keeps the servo share at 0.9 mm.
    expect(build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE).Kp).toBe(80000);
    expect(build<RVDynamicAxis>(DYNAMIC_AXIS_TYPE).Armature).toBe(0.1);
  });
});

describe('ContactProfile and CollisionShapeSet', () => {
  it('stores the NAME and derives the MuJoCo number, so a save round-trips', () => {
    // A resolved number as the stored value would be stamped as the default,
    // appear as a fifth dropdown entry, and be written back as a value the
    // schema's own enum rejects.
    const profile = build<RVContactProfile>(CONTACT_PROFILE_TYPE, { CondDim: 'Full' });
    expect(profile.CondDim).toBe('Full');
    expect(profile.condim).toBe(6);
    const body = build<RVFreeBody>(FREE_BODY_TYPE, { CondDim: 'Frictionless' });
    expect(body.CondDim).toBe('Frictionless');
    expect(body.condim).toBe(1);
  });

  it('an unknown condim name falls back to SlidingTorsional (4), never to MuJoCo\'s 3', () => {
    expect(build<RVContactProfile>(CONTACT_PROFILE_TYPE, { CondDim: 'nonsense' }).CondDim)
      .toBe('SlidingTorsional');
    expect(build<RVContactProfile>(CONTACT_PROFILE_TYPE, { CondDim: 'nonsense' }).condim)
      .toBe(COND_DIM_VALUES.SlidingTorsional);
    expect(build<RVFreeBody>(FREE_BODY_TYPE, { CondDim: 'nonsense' }).condim)
      .toBe(COND_DIM_VALUES.SlidingTorsional);
    expect(condimOf(undefined)).toBe(4);
    expect(condimOf('Sliding')).toBe(3);
  });

  it('priority is an integer count and says this side sets the tone', () => {
    const p = build<RVContactProfile>(CONTACT_PROFILE_TYPE, { Priority: 1.7 });
    expect(p.Priority).toBe(2);
    expect(p.setsTheTone).toBe(true);
    expect(build<RVContactProfile>(CONTACT_PROFILE_TYPE).setsTheTone).toBe(false);
  });

  it('normalises the authored shape list and separates the degenerate entries', () => {
    const set = build<RVCollisionShapeSet>(COLLISION_SHAPE_SET_TYPE, {
      Shapes: [
        { Kind: 'box', Center: { x: 0, y: 0, z: 25 }, Size: { x: 10, y: 17.5, z: 25 } },
        { Kind: 'sphere', Size: { x: 0 } },
        { Kind: 'capsule', Size: { x: 4, y: 12 } },
      ],
    });
    expect(set.shapes).toHaveLength(3);
    expect(set.validShapes).toHaveLength(2);
    expect(set.shapes[0].Rotation).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('FreeBody and Movable — the honest replacement for the Virtual drive', () => {
  it('both claim their node AND own their chunk, so the bake keeps them as a unit', () => {
    for (const type of [FREE_BODY_TYPE, MOVABLE_TYPE]) {
      const caps = getCapabilities(type);
      expect(caps.claimsNode, `${type} must survive the bake on its own`).toBe(true);
      expect(caps.bake, `${type} is moved as a unit, so it is a chunk boundary`).toBe('chunk');
      expect(caps.pick, `${type} is a thing the user points at`).toBe('select');
      expect(caps.authorable).toBe(true);
    }
  });

  it('a mass of 0 means derive it, and a negative one is not a mass', () => {
    expect(build<RVFreeBody>(FREE_BODY_TYPE).massIsDerived).toBe(true);
    expect(build<RVFreeBody>(FREE_BODY_TYPE, { MassKg: -5 }).MassKg).toBe(0);
    expect(build<RVFreeBody>(FREE_BODY_TYPE, { MassKg: 1.77 }).massIsDerived).toBe(false);
  });

  it('restitution stays inside 0 … 1', () => {
    expect(build<RVFreeBody>(FREE_BODY_TYPE, { Restitution: 9 }).Restitution).toBe(1);
    expect(build<RVFreeBody>(FREE_BODY_TYPE, { Restitution: -1 }).Restitution).toBe(0);
  });

  it('Movable restricts the drag to the declared directions, floor plane by default', () => {
    expect(build<RVMovable>(MOVABLE_TYPE).allowedAxes).toEqual({ x: true, y: false, z: true });
    expect(build<RVMovable>(MOVABLE_TYPE, { Axes: 'XYZ' }).allowedAxes).toEqual({ x: true, y: true, z: true });
    expect(build<RVMovable>(MOVABLE_TYPE, { Axes: 'Y' }).allowedAxes).toEqual({ x: false, y: true, z: false });
    expect(build<RVMovable>(MOVABLE_TYPE, { Axes: 'nonsense' }).Axes).toBe('XZ');
  });

  it('the snap grid is millimetres and the scene is metres — converted in one place', () => {
    const free = build<RVMovable>(MOVABLE_TYPE);
    expect(free.snap(0.1234)).toBe(0.1234);
    const snapped = build<RVMovable>(MOVABLE_TYPE, { SnapMm: 10 });
    expect(snapped.snap(0.1234)).toBeCloseTo(0.12, 6);
    expect(snapped.snap(0.126)).toBeCloseTo(0.13, 6);
  });

  it('ResetOnStop returns the node to its AUTHORED position, and only then', () => {
    const node = new Object3D();
    node.position.set(1, 0, 2);
    const m = build<RVMovable>(MOVABLE_TYPE, { ResetOnStop: true }, node);
    expect(m.homePosition).toEqual({ x: 1, y: 0, z: 2 });
    node.position.set(5, 0, 5);
    m.resetToHome();
    expect([node.position.x, node.position.z]).toEqual([1, 2]);

    const node2 = new Object3D();
    node2.position.set(1, 0, 2);
    const keep = build<RVMovable>(MOVABLE_TYPE, { ResetOnStop: false }, node2);
    node2.position.set(5, 0, 5);
    keep.resetToHome();
    expect([node2.position.x, node2.position.z]).toEqual([5, 5]);
  });
});

describe('LocomotionPolicy', () => {
  it('counts the declared axes and keeps their order', () => {
    const ref = (p: string) => ({ type: 'ComponentReference', path: p, componentType: 'realvirtual.Drive' });
    const policy = build<RVLocomotionPolicyComponent>(LOCOMOTION_POLICY_TYPE, {
      Axes: [ref('R/A1'), ref('R/A2'), ref('R/A3')],
    });
    expect(policy.axisCount).toBe(3);
    expect(getProblems().filter((p) => p.code === POLICY_AXIS_NOT_A_REFERENCE)).toHaveLength(0);
  });

  it('a bare string in Axes is REPORTED, not silently dropped', () => {
    const ref = (p: string) => ({ type: 'ComponentReference', path: p, componentType: 'realvirtual.Drive' });
    const node = new Object3D();
    node.name = 'Duck';
    build<RVLocomotionPolicyComponent>(LOCOMOTION_POLICY_TYPE, {
      Axes: [ref('R/A1'), 'R/A2', ref('R/A3')],
    }, node);
    const found = getProblems().filter((p) => p.code === POLICY_AXIS_NOT_A_REFERENCE);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].detail).toContain('Axes[1]');
    expect(found[0].nodePath).toBe('Duck');
  });

  it('decimation is a whole count of at least one', () => {
    expect(build<RVLocomotionPolicyComponent>(LOCOMOTION_POLICY_TYPE, { Decimation: 0 }).Decimation).toBe(1);
    expect(build<RVLocomotionPolicyComponent>(LOCOMOTION_POLICY_TYPE, { Decimation: 4.6 }).Decimation).toBe(5);
  });

  it('the rate is derived from the enclosing region, and absent without one', () => {
    const root = new Object3D();
    const robot = new Object3D();
    root.add(robot);
    build<RVMuJoCoRegion>(MUJOCO_REGION_TYPE, { TimestepS: 0.002 }, root);
    const policy = build<RVLocomotionPolicyComponent>(LOCOMOTION_POLICY_TYPE, { Decimation: 4 }, robot);
    expect(policy.rateHz).toBeCloseTo(125, 6);

    const orphan = build<RVLocomotionPolicyComponent>(LOCOMOTION_POLICY_TYPE, { Decimation: 4 }, new Object3D());
    expect(orphan.rateHz).toBeNull();
  });
});

describe('the contact profile library', () => {
  it('ships an entry for every role but Custom', () => {
    expect(validateContactProfileCatalog(getContactProfileCatalog())).toEqual([]);
    for (const role of LIBRARY_ROLES) {
      expect(contactProfileEntry(role), role).not.toBeNull();
    }
    expect(contactProfileEntry('Custom')).toBeNull();
    expect(contactProfileEntry('Nonsense')).toBeNull();
  });

  it('the sides that set the tone are the ones that have to', () => {
    // A grippy pad only works because it wins its pairing; friction is
    // MAXIMISED element-wise, so without priority one pad raises every pairing.
    expect(contactProfileEntry('GripperJaw')!.priority).toBe(1);
    expect(contactProfileEntry('FixtureBore')!.priority).toBe(1);
    expect(contactProfileEntry('StopperFace')!.priority).toBe(1);
    expect(contactProfileEntry('Workpiece')!.priority).toBe(0);
    expect(contactProfileEntry('Pallet')!.priority).toBe(0);
  });

  it('names the pairing the first case depends on', () => {
    const pair = contactProfilePair('Workpiece', 'GripperJaw');
    expect(pair).not.toBeNull();
    // Either order resolves to the same entry.
    expect(contactProfilePair('GripperJaw', 'Workpiece')).toBe(pair);
    expect(pair!.condim).toBe(4);
    expect(contactProfilePair('Pallet', 'MachineFrame')).toBeNull();
  });

  it('says which numbers are still assumptions instead of letting them look measured', () => {
    // Today every one of them is; the point is that the report exists and
    // shrinks as surfaces get measured.
    expect(unmeasuredProfileRoles().length).toBeGreaterThan(0);
    for (const role of unmeasuredProfileRoles()) {
      expect(contactProfileEntry(role)!.provenance).toBe('declared');
      expect(contactProfileEntry(role)!.note.length).toBeGreaterThan(0);
    }
  });

  it('a named role wins over the component numbers; Custom uses them', () => {
    const authored = {
      Profile: 'GripperJaw', Priority: 1, Solmix: 2,
      FrictionSlide: 0.01, FrictionSpin: 0, FrictionRoll: 0,
      CondDim: 'Sliding', SolrefTimeConst: 0.5, SolrefDampRatio: 9,
    };
    const fromLibrary = resolveContactProfile(authored);
    expect(fromLibrary.friction).toEqual(contactProfileEntry('GripperJaw')!.friction);
    expect(fromLibrary.condim).toBe(4);
    // Priority and Solmix are always the authored ones: they say how THIS node
    // takes part in a pairing, which is not a property of the role.
    expect(fromLibrary.priority).toBe(1);
    expect(fromLibrary.solmix).toBe(2);

    const custom = resolveContactProfile({ ...authored, Profile: 'Custom' });
    expect(custom.friction).toEqual([0.01, 0, 0]);
    expect(custom.condim).toBe(3);
    expect(custom.solref).toEqual([0.5, 9]);
  });

  it('an unknown role falls back to the component numbers and says so', () => {
    const r = resolveContactProfile({
      Profile: 'NoSuchRole', Priority: 0, Solmix: 1,
      FrictionSlide: 0.5, FrictionSpin: 0.005, FrictionRoll: 0.0001,
      CondDim: 'SlidingTorsional', SolrefTimeConst: 0.02, SolrefDampRatio: 1,
    });
    expect(r.friction).toEqual([0.5, 0.005, 0.0001]);
    expect(r.note).toContain('NoSuchRole');
  });

  it('a project catalogue is accepted whole or not at all', () => {
    const good = structuredClone(getContactProfileCatalog()) as unknown as Record<string, unknown>;
    (good.profiles as Record<string, { friction: number[] }>).Pallet.friction = [0.9, 0.005, 0.0001];
    expect(setContactProfileCatalog(good)).toEqual([]);
    expect(contactProfileEntry('Pallet')!.friction).toEqual([0.9, 0.005, 0.0001]);

    const broken = structuredClone(getContactProfileCatalog()) as unknown as Record<string, unknown>;
    delete (broken.profiles as Record<string, unknown>).GripperJaw;
    (broken.profiles as Record<string, { condim: number }>).Pallet.condim = 2;
    const problems = setContactProfileCatalog(broken);
    expect(problems).toContain('missing role GripperJaw');
    expect(problems).toContain('Pallet.condim must be 1, 3, 4 or 6');
    // Nothing was applied: the previous catalogue is still in force.
    expect(contactProfileEntry('Pallet')!.friction).toEqual([0.9, 0.005, 0.0001]);
    expect(contactProfileEntry('GripperJaw')).not.toBeNull();
  });

  it('a wrong version and a non-object are refused with a reason', () => {
    expect(validateContactProfileCatalog(null)).toEqual(['catalogue is not an object']);
    expect(validateContactProfileCatalog({ version: 2, profiles: {}, pairs: [] }))
      .toContain('unsupported version 2 (expected 1)');
  });
});
