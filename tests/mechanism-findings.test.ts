// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T8 — Mechanism core validation (plan-404 §2.5, §9).
 *
 * Every ported finding code must fire on exactly its own condition and stay
 * silent otherwise. This suite has NO external dependency: no wasm artifact, no
 * GLB fixture, no viewer — the findings port is deliberately pure so this test
 * runs unconditionally and is the regression net for the validation semantics.
 */

import { describe, it, expect } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  validateMechanism,
  buildAnchorsApartFindings,
  buildDriveFindings,
  analyzeTopologyFindings,
  hasBlockingFinding,
  POSITION_EPSILON_MM,
  type FindingsJointInput,
  type FindingsLinkInput,
  type KinematicFindingCode,
} from '@rv-private/kinematic-mechanism/rv-kinematic-findings';

const MM_TO_UNITY = 0.001;

function link(name: string, x = 0, y = 0, z = 0): FindingsLinkInput {
  return {
    name,
    worldPosition: new Vector3(x, y, z),
    worldRotation: new Quaternion(),
    worldScale: new Vector3(1, 1, 1),
  };
}

function joint(over: Partial<FindingsJointInput> = {}): FindingsJointInput {
  return {
    name: 'J',
    jointType: 'Revolute',
    bodyA: 0,
    bodyB: 1,
    anchorAMm: new Vector3(),
    anchorBMm: new Vector3(),
    axisA: new Vector3(0, 0, 1),
    secondaryAxisB: new Vector3(),
    isDriven: false,
    ...over,
  };
}

function codes(findings: readonly { code: KinematicFindingCode }[]): KinematicFindingCode[] {
  return findings.map((f) => f.code);
}

describe('T8 — mechanism findings: structural errors', () => {
  it('MissingBodyB fires when Body B is absent, and blocks the mechanism', () => {
    const findings = validateMechanism({
      joints: [joint({ name: 'J1', bodyB: -1 })],
      links: [link('Base'), link('Arm')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).toContain('MissingBodyB');
    expect(findings[0].severity).toBe('Error');
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('SameBodyAAndB fires when both sides reference the same link', () => {
    const findings = validateMechanism({
      joints: [joint({ name: 'J1', bodyA: 1, bodyB: 1 })],
      links: [link('Base'), link('Arm')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).toContain('SameBodyAAndB');
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('an ABSENT Body A is a valid world anchor, NOT a finding', () => {
    // plan-404 §2.4: the Unity serializer omits null fields, so a missing BodyA
    // key IS the authored world anchor. This is the single most important
    // semantic of the read side — it must never be reported as a defect.
    const findings = validateMechanism({
      joints: [joint({ name: 'J1', bodyA: -1, bodyB: 0 })],
      links: [link('Arm')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).not.toContain('UnresolvedBody');
    expect(hasBlockingFinding(findings)).toBe(false);
  });

  it('a PRESENT but unresolvable reference is an error, unlike an absent one', () => {
    const findings = validateMechanism({
      joints: [joint({ name: 'J1', bodyA: -1, bodyB: 0, bodyAUnresolved: true })],
      links: [link('Arm')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).toContain('UnresolvedBody');
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('MissingSecondaryAxis fires only for a Universal joint without a second axis', () => {
    const withAxis = validateMechanism({
      joints: [joint({ jointType: 'Universal', secondaryAxisB: new Vector3(1, 0, 0) })],
      links: [link('A'), link('B')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(withAxis)).not.toContain('MissingSecondaryAxis');

    const without = validateMechanism({
      joints: [joint({ jointType: 'Universal' })],
      links: [link('A'), link('B')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(without)).toContain('MissingSecondaryAxis');
    expect(without.find((f) => f.code === 'MissingSecondaryAxis')?.severity).toBe('Warning');
    expect(without.find((f) => f.code === 'MissingSecondaryAxis')?.fixable).toBe(true);
  });

  it('a Revolute joint without a secondary axis is NOT flagged', () => {
    const findings = validateMechanism({
      joints: [joint({ jointType: 'Revolute' })],
      links: [link('A'), link('B')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).not.toContain('MissingSecondaryAxis');
  });
});

describe('T8 — mechanism findings: AnchorsApart tolerance', () => {
  it('stays silent exactly at the tolerance and fires beyond it', () => {
    const links = [link('A'), link('B')];
    const atTolerance = buildAnchorsApartFindings(
      [joint({ anchorAMm: new Vector3(), anchorBMm: new Vector3(POSITION_EPSILON_MM, 0, 0) })],
      links, MM_TO_UNITY,
    );
    expect(atTolerance).toHaveLength(0);

    const beyond = buildAnchorsApartFindings(
      [joint({ name: 'J1', anchorAMm: new Vector3(), anchorBMm: new Vector3(2.3, 0, 0) })],
      links, MM_TO_UNITY,
    );
    expect(beyond).toHaveLength(1);
    expect(beyond[0].code).toBe('AnchorsApart');
    // The message carries the real distance — the panel shows this verbatim.
    expect(beyond[0].message).toContain('2.30 mm apart');
    expect(beyond[0].fixable).toBe(true);
  });

  it('accounts for the links\' world poses, not just the raw anchor numbers', () => {
    // Anchors differ numerically but coincide in world space: Body B sits 100 mm
    // along +X, and its anchor points 100 mm back. That must NOT be a finding.
    const links = [link('A', 0, 0, 0), link('B', 0.1, 0, 0)];
    const findings = buildAnchorsApartFindings(
      [joint({ anchorAMm: new Vector3(100, 0, 0), anchorBMm: new Vector3(0, 0, 0) })],
      links, MM_TO_UNITY,
    );
    expect(findings).toHaveLength(0);
  });

  it('skips joints that already have a structural error', () => {
    const findings = buildAnchorsApartFindings(
      [joint({ bodyB: -1, anchorBMm: new Vector3(50, 0, 0) })],
      [link('A')], MM_TO_UNITY,
    );
    expect(findings).toHaveLength(0);
  });
});

describe('T8 — mechanism findings: drive validation (plan-356)', () => {
  const links = [link('Base'), link('Crank')];

  function driven(over: Partial<FindingsJointInput['drive']> = {}, jointOver: Partial<FindingsJointInput> = {}) {
    return joint({
      name: 'J1',
      isDriven: true,
      ...jointOver,
      drive: {
        name: 'Drive',
        kind: 'rotation',
        directionLabel: 'RotationZ',
        localAxis: new Vector3(0, 0, 1),
        reverseDirection: false,
        worldRotation: new Quaternion(),
        movesBodyB: true,
        uniformScale: true,
        ...over,
      },
    });
  }

  it('passes when the drive axis matches the joint axis', () => {
    expect(buildDriveFindings([driven()], links)).toHaveLength(0);
  });

  it('DriveTypeMismatch fires when a linear drive drives a Revolute joint', () => {
    const findings = buildDriveFindings(
      [driven({ kind: 'linear', directionLabel: 'LinearX', localAxis: new Vector3(1, 0, 0) })],
      links,
    );
    expect(codes(findings)).toEqual(['DriveTypeMismatch']);
    expect(findings[0].message).toContain('needs a Rotation* Direction');
  });

  it('DriveTypeMismatch fires when a rotational drive drives a Prismatic joint', () => {
    const findings = buildDriveFindings([driven({}, { jointType: 'Prismatic' })], links);
    expect(codes(findings)).toEqual(['DriveTypeMismatch']);
  });

  it('DriveAxisMismatch fires on a perpendicular drive axis', () => {
    const findings = buildDriveFindings(
      [driven({ directionLabel: 'RotationX', localAxis: new Vector3(1, 0, 0) })],
      links,
    );
    expect(codes(findings)).toEqual(['DriveAxisMismatch']);
    expect(findings[0].message).toContain('90.0 deg off');
  });

  it('the axis comparison is SIGNED: antiparallel is a finding, not a pass', () => {
    // Deliberate (plan-356): for a DRIVEN joint the sign matters — an opposing
    // direction places every downstream passive link at twice the wrong angle.
    const findings = buildDriveFindings(
      [driven({ localAxis: new Vector3(0, 0, -1), directionLabel: 'RotationZ' })],
      links,
    );
    expect(codes(findings)).toEqual(['DriveAxisMismatch']);
    expect(findings[0].message).toContain('180.0 deg off');
  });

  it('ReverseDirection is folded into the effective drive axis', () => {
    // Axis is antiparallel BUT ReverseDirection is set → effectively parallel.
    const findings = buildDriveFindings(
      [driven({ localAxis: new Vector3(0, 0, -1), reverseDirection: true })],
      links,
    );
    expect(findings).toHaveLength(0);
  });

  it('skips a drive that does not actually move Body B', () => {
    const findings = buildDriveFindings(
      [driven({ localAxis: new Vector3(1, 0, 0), directionLabel: 'RotationX', movesBodyB: false })],
      links,
    );
    expect(findings).toHaveLength(0);
  });

  it('skips a virtual drive entirely', () => {
    const findings = buildDriveFindings(
      [driven({ kind: 'virtual', directionLabel: 'Virtual' })],
      links,
    );
    expect(findings).toHaveLength(0);
  });

  it('skips the linear axis comparison under non-uniform scale', () => {
    const findings = buildDriveFindings(
      [driven(
        { kind: 'linear', directionLabel: 'LinearX', localAxis: new Vector3(1, 0, 0), uniformScale: false },
        { jointType: 'Prismatic', axisA: new Vector3(0, 0, 1) },
      )],
      links,
    );
    expect(findings).toHaveLength(0);
  });

  it('never touches a passive joint', () => {
    expect(buildDriveFindings([joint({ isDriven: false })], links)).toHaveLength(0);
  });
});

describe('T8 — mechanism findings: topology', () => {
  it('IdleSpinRod fires for a rod held by exactly two spherical joints', () => {
    // Delta parallelogram rod: Base -S- Rod -S- Platform.
    const links = [link('Base'), link('Rod'), link('Platform')];
    const joints = [
      joint({ name: 'S1', jointType: 'Spherical', bodyA: 0, bodyB: 1 }),
      joint({ name: 'S2', jointType: 'Spherical', bodyA: 1, bodyB: 2 }),
    ];
    const { extra } = analyzeTopologyFindings(joints, links);
    const idle = extra.filter((f) => f.code === 'IdleSpinRod');
    expect(idle).toHaveLength(1);
    expect(idle[0].linkIndex).toBe(1);
    // The fix is deterministic: always the FIRST touching joint in joint order.
    expect(idle[0].jointIndices).toEqual([0, 1]);
    expect(idle[0].fixable).toBe(true);
  });

  it('does NOT fire when one end is a Universal joint', () => {
    const links = [link('Base'), link('Rod'), link('Platform')];
    const joints = [
      joint({ jointType: 'Universal', bodyA: 0, bodyB: 1, secondaryAxisB: new Vector3(1, 0, 0) }),
      joint({ jointType: 'Spherical', bodyA: 1, bodyB: 2 }),
    ];
    const { extra } = analyzeTopologyFindings(joints, links);
    expect(codes(extra)).not.toContain('IdleSpinRod');
  });

  it('counts independent loops via union-find (four-bar closes exactly one)', () => {
    // Ground -R- Crank -R- Coupler -R- Rocker -R- Ground.
    // NOTE the direction of the closing joint: world is ALWAYS the Body A side
    // (Body B is required and can never be the world frame), so J4 reads
    // world -> Rocker, not Rocker -> world.
    const links = [link('Crank'), link('Coupler'), link('Rocker')];
    const joints = [
      joint({ name: 'J1', bodyA: -1, bodyB: 0 }),
      joint({ name: 'J2', bodyA: 0, bodyB: 1 }),
      joint({ name: 'J3', bodyA: 1, bodyB: 2 }),
      joint({ name: 'J4', bodyA: -1, bodyB: 2 }),
    ];
    const { summary } = analyzeTopologyFindings(joints, links);
    expect(summary.loopCount).toBe(1);
    expect(summary.worldNodeUsed).toBe(true);
    expect(summary.linkCount).toBe(3);
  });

  it('an open chain closes no loop', () => {
    const links = [link('A'), link('B')];
    const joints = [
      joint({ bodyA: -1, bodyB: 0 }),
      joint({ bodyA: 0, bodyB: 1 }),
    ];
    const { summary } = analyzeTopologyFindings(joints, links);
    expect(summary.loopCount).toBe(0);
  });

  it('NegativeDof is informational, never blocking (parallel-axis mechanisms)', () => {
    // A planar four-bar is mobile but the generic spatial Grübler/Kutzbach
    // formula reports a negative DOF — that must stay a warning.
    const links = [link('Crank'), link('Coupler'), link('Rocker')];
    const joints = [
      joint({ bodyA: -1, bodyB: 0 }), joint({ bodyA: 0, bodyB: 1 }),
      joint({ bodyA: 1, bodyB: 2 }), joint({ bodyA: -1, bodyB: 2 }),
    ];
    const { summary, extra } = analyzeTopologyFindings(joints, links);
    expect(summary.dof).toBeLessThan(0);
    const negative = extra.find((f) => f.code === 'NegativeDof');
    expect(negative).toBeDefined();
    expect(negative?.severity).toBe('Warning');
    expect(hasBlockingFinding(extra)).toBe(false);
  });
});

describe('T8 — mechanism findings: mechanism level', () => {
  it('NestedMechanism is an error', () => {
    const findings = validateMechanism({
      joints: [joint()],
      links: [link('A'), link('B')],
      nestedInMechanism: true,
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).toContain('NestedMechanism');
    expect(hasBlockingFinding(findings)).toBe(true);
  });

  it('an idle mechanism (no joints) produces no findings at all', () => {
    expect(validateMechanism({ joints: [], links: [], mmToUnity: MM_TO_UNITY })).toHaveLength(0);
  });

  it('geometric checks are skipped while a structural error is present', () => {
    // Unity ordering: an unassigned Body B has no sane anchor to compare, so
    // anchor/drive findings must not be produced on top of the real error.
    const findings = validateMechanism({
      joints: [
        joint({ name: 'Broken', bodyB: -1 }),
        joint({ name: 'Apart', bodyA: 0, bodyB: 1, anchorBMm: new Vector3(999, 0, 0) }),
      ],
      links: [link('A'), link('B')],
      mmToUnity: MM_TO_UNITY,
    });
    expect(codes(findings)).toContain('MissingBodyB');
    expect(codes(findings)).not.toContain('AnchorsApart');
  });

  it('a clean four-bar produces no ERROR finding', () => {
    const links = [link('Crank'), link('Coupler'), link('Rocker')];
    const joints = [
      joint({ name: 'J1', bodyA: -1, bodyB: 0 }), joint({ name: 'J2', bodyA: 0, bodyB: 1 }),
      joint({ name: 'J3', bodyA: 1, bodyB: 2 }), joint({ name: 'J4', bodyA: -1, bodyB: 2 }),
    ];
    const findings = validateMechanism({ joints, links, mmToUnity: MM_TO_UNITY });
    expect(hasBlockingFinding(findings)).toBe(false);
  });
});
