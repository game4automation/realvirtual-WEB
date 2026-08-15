// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T3 of plan-411 — an incomplete Drive is a FINDING, not a crash.
 *
 * `describeDrive()` called `directionToGltfAxis(drive.Direction).clone()`. That
 * helper is a total switch over the DriveDirection enum WITHOUT a default, so
 * an authored Drive whose Direction is missing produced `undefined.clone()` —
 * a TypeError thrown out of `RVKinematicMechanism.build()`, which took the
 * whole mechanism down: no topology, no findings, nothing in the panel to say
 * why. One misconfigured drive silently disabled a machine.
 *
 * The fix validates in `describeDrive()` and leaves `directionToGltfAxis()`
 * alone — three production callers rely on its non-null return. This file pins
 * BOTH halves: the finding appears, and the utility keeps its contract.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { validateMechanism, hasBlockingFinding } from '@rv-private/kinematic-mechanism/rv-kinematic-findings';
import type { FindingsJointInput, FindingsLinkInput } from '@rv-private/kinematic-mechanism/rv-kinematic-findings';
import { RVKinematicMechanism, RVKinematicJoint } from '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { getRegisteredFactories } from '../src/core/engine/rv-component-registry';
import { RVDrive } from '../src/core/engine/rv-drive';
import { DriveDirection, directionToGltfAxis } from '../src/core/engine/rv-coordinate-utils';
import { Quaternion } from 'three';

function link(name: string): FindingsLinkInput {
  return { name, worldPosition: new Vector3(), worldRotation: new Quaternion(), worldScale: new Vector3(1, 1, 1) };
}

function joint(over: Partial<FindingsJointInput> = {}): FindingsJointInput {
  return {
    name: 'J', jointType: 'Revolute', bodyA: 0, bodyB: 1,
    anchorAMm: new Vector3(), anchorBMm: new Vector3(),
    axisA: new Vector3(0, 0, 1), secondaryAxisB: new Vector3(),
    isDriven: false, ...over,
  };
}

/** Build a joint through the REGISTERED factory so the mechanism's subtree scan
 *  (`jointsByNode`, filled in `afterCreate`) actually finds it. */
function makeJoint(node: Object3D, over: Partial<RVKinematicJoint> = {}): RVKinematicJoint {
  const factory = getRegisteredFactories().get('KinematicJoint')!;
  const inst = factory.create(node, null) as RVKinematicJoint;
  factory.afterCreate?.(inst, node);
  Object.assign(inst, over);
  return inst;
}

describe('plan-411 T3 — DriveIncomplete finding', () => {
  it('reports an incomplete drive and still validates every other joint', () => {
    const findings = validateMechanism({
      joints: [
        joint({ name: 'Broken', isDriven: true, driveDefect: 'Drive \'M1\' has no usable Direction ("undefined").' }),
        joint({ name: 'AlsoBroken', bodyB: -1 }),
      ],
      links: [link('Base'), link('Arm')],
      mmToUnity: 0.001,
    });

    const codes = findings.map((f) => f.code);
    expect(codes).toContain('DriveIncomplete');
    expect(codes).toContain('MissingBodyB');   // the OTHER joint still diagnosed
    expect(findings.find((f) => f.code === 'DriveIncomplete')!.jointIndex).toBe(0);
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('says nothing when every drive is complete', () => {
    const findings = validateMechanism({
      joints: [joint({ name: 'Fine', isDriven: false })],
      links: [link('Base'), link('Arm')],
      mmToUnity: 0.001,
    });
    expect(findings.map((f) => f.code)).not.toContain('DriveIncomplete');
  });
});

describe('plan-411 T3 — build() survives a broken drive', () => {
  it('does not throw, produces the finding and keeps the other joints', () => {
    const root = new Object3D();
    root.name = 'Mech';
    const base = new Object3D(); base.name = 'Base'; root.add(base);
    const arm = new Object3D(); arm.name = 'Arm'; root.add(arm);
    const tip = new Object3D(); tip.name = 'Tip'; root.add(tip);

    const brokenNode = new Object3D(); brokenNode.name = 'J1'; root.add(brokenNode);
    const goodNode = new Object3D(); goodNode.name = 'J2'; root.add(goodNode);

    // The drive the mechanism chokes on: constructed normally, then left with
    // a Direction that is not a DriveDirection value — exactly what an extras
    // record with a missing/renamed Direction produces downstream.
    const driveNode = new Object3D(); driveNode.name = 'M1'; arm.add(driveNode);
    const drive = new RVDrive(driveNode);
    drive.Direction = DriveDirection.RotationZ;
    drive.initDrive();
    drive.Direction = undefined as unknown as DriveDirection;

    makeJoint(brokenNode, { BodyA: base, BodyB: arm, DrivenBy: drive });
    makeJoint(goodNode, { BodyA: arm, BodyB: tip });

    const mech = new RVKinematicMechanism(root);

    expect(() => mech.build()).not.toThrow();

    const codes = mech.findings.map((f) => f.code);
    expect(codes).toContain('DriveIncomplete');
    expect(mech.findings.find((f) => f.code === 'DriveIncomplete')!.message).toContain('M1');
    // "the other joints stay intact": both joints were collected and described.
    expect(mech.joints).toHaveLength(2);
  });
});

describe('plan-411 T3 — directionToGltfAxis stays untouched', () => {
  it('keeps its non-nullable return for every enum member', () => {
    for (const dir of Object.values(DriveDirection)) {
      const axis = directionToGltfAxis(dir);
      expect(axis).toBeInstanceOf(Vector3);
      // `.clone()` is what the three production callers do straight away.
      expect(() => axis.clone()).not.toThrow();
    }
  });
});
