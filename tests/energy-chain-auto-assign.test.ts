// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Plan-362 F3 / §2.5 — automatic anchor/follower assignment.
 *
 * Without this, attaching the component is NOT the whole user action: a chain
 * with no explicit `Follower` reports `degraded-assignment` and sits in its CAD
 * rest pose. These tests cover the two automatic stages plus, just as
 * importantly, the cases where the scene must NOT be allowed to produce a lucky
 * guess.
 *
 * The fixture geometry is the reference case: travel axis Z, bend at the larger
 * Z, the two open strand ends at Z = 0 and Y = ±55 mm. A "carrier" is a node
 * with a small box mesh standing in for a gantry carriage; which strand end it
 * sits next to is the whole signal.
 */

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { RVDrive } from '../src/core/engine/rv-drive';
import { DriveDirection } from '../src/core/engine/rv-coordinate-utils';
import { chainHarness, transformRef, type ChainHarness } from './energy-chain-fixture';

/** Bind-frame Y of the two strand ends (bend radius 55 mm around Y = 0). */
const HIGH_STRAND = 0.09;
const LOW_STRAND = -0.09;

/**
 * A node with one box mesh, parked next to one of the strand ends. Returned as
 * the node a drive or a Kinematic extra would move.
 */
function addCarrier(
  h: ChainHarness,
  name: string,
  y: number,
  z = -0.06,
  size = 0.06,
): Object3D {
  const node = new Object3D();
  node.name = name;
  const body = new Mesh(new BoxGeometry(size, size, size), new MeshStandardMaterial());
  body.name = `${name}_body`;
  body.position.set(0, y, z);
  node.add(body);
  h.root.add(node);
  h.registry.registerNode(`Root/${name}`, node);
  h.scene.updateMatrixWorld(true);
  return node;
}

function addDrive(h: ChainHarness, node: Object3D, direction: DriveDirection): RVDrive {
  const drive = new RVDrive(node);
  drive.Direction = direction;
  drive.initDrive();
  h.registry.register('Drive', h.registry.getPathForNode(node)!, drive);
  return drive;
}

function markKinematic(node: Object3D): void {
  node.userData.realvirtual = { Kinematic: { IntegrateGroupEnable: true, GroupName: 'Axis' } };
}

function rig(h: ChainHarness, data: Record<string, unknown> = {}): RVEnergyChain {
  h.chain.userData.realvirtual = { EnergyChain: data };
  return constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
}

/** Move a node along the travel axis, as a drive or a live transform would. */
function travel(h: ChainHarness, node: Object3D, mm: number): void {
  node.position.z += mm / 1000;
  h.scene.updateMatrixWorld(true);
}

describe('EnergyChain auto assignment — stage 1, drive context', () => {
  it('follows the drive whose axis matches, and picks the strand end next to it', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Z', HIGH_STRAND);
    addDrive(h, carriage, DriveDirection.LinearZ);

    const chain = rig(h);

    expect(chain.diagnosis).toBe('ok');
    expect(chain.assignmentStage).toBe('drive');
    expect(chain.followerNode).toBe(carriage);
    expect(chain.statusLine).toContain('AxisLeft_Z');
  });

  it('moves the bend at half the auto-detected follower speed', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Z', HIGH_STRAND);
    addDrive(h, carriage, DriveDirection.LinearZ);
    const chain = rig(h);
    const bendBefore = chain.bendCenter;

    travel(h, carriage, -200);
    expect(chain.updatePose(0.016)).toBe(true);

    expect(chain.followerScalar).toBeCloseTo(-0.2, 6);
    expect(chain.bendCenter - bendBefore).toBeCloseTo(-0.1, 6);
  });

  it('works through the real drive API, not only a hand-moved transform', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Z', HIGH_STRAND);
    const drive = addDrive(h, carriage, DriveDirection.LinearZ);
    const chain = rig(h);
    const bendBefore = chain.bendCenter;

    drive.currentPosition = -200; // mm
    drive.applyToNode();
    h.scene.updateMatrixWorld(true);

    expect(chain.updatePose(0.016)).toBe(true);
    expect(chain.bendCenter - bendBefore).toBeCloseTo(-0.1, 6);
  });

  it('picks the LOW strand when the carriage sits below the chain', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Z', LOW_STRAND);
    addDrive(h, carriage, DriveDirection.LinearZ);

    const chain = rig(h);

    expect(chain.assignmentStage).toBe('drive');
    expect(chain.followerNode).toBe(carriage);
    // The strand choice is a real decision, not a default: the rest pose must
    // still reproduce the CAD exactly with the OTHER strand playing the moving
    // role, and travel must still move the bend at half speed.
    const bendBefore = chain.bendCenter;
    travel(h, carriage, -200);
    chain.updatePose(0.016);
    expect(chain.bendCenter - bendBefore).toBeCloseTo(-0.1, 6);
  });

  it('takes the nearest matching drive when several are in range', () => {
    const h = chainHarness();
    const far = addCarrier(h, 'Far_Z', HIGH_STRAND, -0.5);
    addDrive(h, far, DriveDirection.LinearZ);
    const near = addCarrier(h, 'Near_Z', HIGH_STRAND, -0.06);
    addDrive(h, near, DriveDirection.LinearZ);

    expect(rig(h).followerNode).toBe(near);
  });
});

describe('EnergyChain auto assignment — refusing to guess', () => {
  it('ignores a drive whose Direction does not match the chain axis', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'Sideways_X', HIGH_STRAND);
    addDrive(h, carriage, DriveDirection.LinearX);

    const chain = rig(h);

    expect(chain.assignmentStage).toBe('none');
    expect(chain.diagnosis).toBe('degraded-assignment');
  });

  it('ignores a rotary drive sitting right next to the chain', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'Turntable', HIGH_STRAND);
    addDrive(h, carriage, DriveDirection.RotationZ);

    expect(rig(h).assignmentStage).toBe('none');
  });

  it('ignores a matching drive that is further away than the chain is long', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'OtherStation_Z', HIGH_STRAND, -2.0);
    addDrive(h, carriage, DriveDirection.LinearZ);

    expect(rig(h).assignmentStage).toBe('none');
  });

  it('decides nothing when a carriage swallows BOTH strand ends', () => {
    const h = chainHarness();
    // A 300 mm box centred on the chain plane covers both ends — from where this
    // drive sits the two are indistinguishable, so it must not vote.
    const carriage = addCarrier(h, 'BigCarriage_Z', 0, -0.06, 0.3);
    addDrive(h, carriage, DriveDirection.LinearZ);

    const chain = rig(h);

    expect(chain.assignmentStage).toBe('none');
    expect(chain.diagnosis).toBe('degraded-assignment');
  });

  it('holds the CAD rest pose and never throws when nothing is found', () => {
    const h = chainHarness();
    const chain = rig(h);

    expect(chain.assignmentStage).toBe('none');
    expect(chain.diagnosis).toBe('degraded-assignment');
    expect(chain.isRigged).toBe(true);
    expect(chain.statusLine).toContain('rest pose');

    h.moveFollower(-200);
    expect(() => chain.updatePose(0.016)).not.toThrow();
    expect(chain.updatePose(0.016)).toBe(false);
  });
});

describe('EnergyChain auto assignment — stage 2, kinematic membership', () => {
  it('uses a Kinematic node when no drive matches', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Slide', HIGH_STRAND);
    markKinematic(carriage);

    const chain = rig(h);

    expect(chain.assignmentStage).toBe('kinematic');
    expect(chain.followerNode).toBe(carriage);

    const bendBefore = chain.bendCenter;
    travel(h, carriage, -200);
    chain.updatePose(0.016);
    expect(chain.bendCenter - bendBefore).toBeCloseTo(-0.1, 6);
  });

  it('prefers the drive stage over an equally close Kinematic node', () => {
    const h = chainHarness();
    const kinematic = addCarrier(h, 'KinSlide', HIGH_STRAND, -0.06);
    markKinematic(kinematic);
    const driven = addCarrier(h, 'AxisLeft_Z', HIGH_STRAND, -0.08);
    addDrive(h, driven, DriveDirection.LinearZ);

    const chain = rig(h);

    expect(chain.assignmentStage).toBe('drive');
    expect(chain.followerNode).toBe(driven);
  });

  it('skips a Kinematic node driven along the wrong axis', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'Sideways', HIGH_STRAND);
    markKinematic(carriage);
    addDrive(h, carriage, DriveDirection.LinearX);

    expect(rig(h).assignmentStage).toBe('none');
  });

  it('ignores a Kinematic ANCESTOR of the chain — it moves the whole chain', () => {
    const h = chainHarness();
    markKinematic(h.root);

    expect(rig(h).assignmentStage).toBe('none');
  });
});

describe('EnergyChain auto assignment — precedence and live edits', () => {
  it('lets an explicit Follower beat the automatic stages', () => {
    const h = chainHarness();
    // The drive would vote for the LOW strand; the reference says otherwise.
    const carriage = addCarrier(h, 'AxisLeft_Z', LOW_STRAND);
    addDrive(h, carriage, DriveDirection.LinearZ);

    const chain = rig(h, { Follower: transformRef('Root/Slide') });

    expect(chain.assignmentStage).toBe('reference');
    expect(chain.followerNode).toBe(h.follower);

    // The drive is not followed at all any more.
    travel(h, carriage, -200);
    expect(chain.updatePose(0.016)).toBe(false);
    h.moveFollower(-200);
    expect(chain.updatePose(0.016)).toBe(true);
  });

  it('falls back to the automatic stages when the reference is cleared', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Z', HIGH_STRAND);
    addDrive(h, carriage, DriveDirection.LinearZ);
    const chain = rig(h, { Follower: transformRef('Root/Slide') });
    expect(chain.assignmentStage).toBe('reference');

    (chain as unknown as Record<string, unknown>).Follower = null;
    chain.reapplyConfig();

    expect(chain.assignmentStage).toBe('drive');
    expect(chain.diagnosis).toBe('ok');
    expect(chain.followerNode).toBe(carriage);

    travel(h, carriage, -200);
    expect(chain.updatePose(0.016)).toBe(true);
  });

  it('degrades again when the reference is cleared and nothing can replace it', () => {
    const h = chainHarness();
    const chain = rig(h, { Follower: transformRef('Root/Slide') });

    (chain as unknown as Record<string, unknown>).Follower = null;
    chain.reapplyConfig();

    expect(chain.assignmentStage).toBe('none');
    expect(chain.diagnosis).toBe('degraded-assignment');
  });

  it('does NOT re-rig for an assignment change — same Skeleton instance', () => {
    const h = chainHarness();
    const carriage = addCarrier(h, 'AxisLeft_Z', HIGH_STRAND);
    addDrive(h, carriage, DriveDirection.LinearZ);
    const chain = rig(h, { Follower: transformRef('Root/Slide') });
    const skeleton = chain.skeleton;
    expect(skeleton).toBeDefined();

    // Reference → auto (same strand) and back again: assignment is path
    // configuration, not structure, so the rig must survive untouched.
    (chain as unknown as Record<string, unknown>).Follower = null;
    chain.reapplyConfig();
    expect(chain.skeleton).toBe(skeleton);

    (chain as unknown as Record<string, unknown>).Follower = transformRef('Root/Slide');
    chain.reapplyConfig();
    expect(chain.skeleton).toBe(skeleton);
    expect(chain.assignmentStage).toBe('reference');
  });

  it('keeps the same rig when an auto-assigned chain is re-applied unchanged', () => {
    const h = chainHarness();
    addDrive(h, addCarrier(h, 'AxisLeft_Z', HIGH_STRAND), DriveDirection.LinearZ);
    const chain = rig(h);
    const skeleton = chain.skeleton;

    chain.reapplyConfig();
    chain.reapplyConfig();

    expect(chain.skeleton).toBe(skeleton);
    expect(chain.assignmentStage).toBe('drive');
  });
});
