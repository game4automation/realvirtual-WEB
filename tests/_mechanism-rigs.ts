// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared mechanism rigs for the plan-404 test suite.
 *
 * Hand-built topology inputs (no GLB, no Unity) so the solver host can be
 * exercised before the Phase-0 fixtures exist. Deliberately mirrors the shapes
 * `KinematicTemplates.cs` generates on the Unity side: a driven open chain, a
 * four-bar (loop closure) and a rig with a free body.
 */

import { Quaternion, Vector3 } from 'three';
import type {
  MechanismJointInput,
  MechanismLinkInput,
  MechanismTopology,
} from '@rv-private/kinematic-mechanism/rv-kinematic-topology';
import { buildTopology } from '@rv-private/kinematic-mechanism/rv-kinematic-topology';
import { exportMechanismStateBlob } from '@rv-private/kinematic-mechanism/rv-kinematic-state-export';
import type {
  KinematicSolverInstance,
  KinematicSolverProvider,
} from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';

/** Unity units per millimetre inverse — 1000 for a metres-based scene. */
export const CONTROLLER_SCALE = 1000;

export function makeLink(name: string, x = 0, y = 0, z = 0): MechanismLinkInput {
  return { name, worldPosition: new Vector3(x, y, z), worldRotation: new Quaternion() };
}

export function makeJoint(over: Partial<MechanismJointInput> = {}): MechanismJointInput {
  return {
    name: 'J',
    jointType: 'Revolute',
    bodyA: 0,
    bodyB: 1,
    anchorAMm: new Vector3(),
    anchorBMm: new Vector3(),
    axisA: new Vector3(0, 0, 1),
    secondaryAxisB: new Vector3(),
    useLimits: false,
    lowerLimit: -180,
    upperLimit: 180,
    isDriven: false,
    driveReferenceValue: 0,
    driveUseLimits: false,
    driveLowerLimit: 0,
    driveUpperLimit: 0,
    ...over,
  };
}

export interface Rig {
  joints: MechanismJointInput[];
  links: MechanismLinkInput[];
  worldNodeUsed: boolean;
}

/**
 * Single driven Revolute: Base (root) → Arm, hinge at the world origin about Z,
 * the arm's own origin 500 mm out along +X. Open chain (no residuals), so the
 * solver takes its fast path — the simplest possible valid mechanism.
 */
export function singleRevoluteRig(): Rig {
  return {
    links: [makeLink('Base', 0, 0, 0), makeLink('Arm', 0.5, 0, 0)],
    joints: [makeJoint({
      name: 'Hinge',
      jointType: 'Revolute',
      bodyA: 0,
      bodyB: 1,
      anchorAMm: new Vector3(0, 0, 0),
      anchorBMm: new Vector3(-500, 0, 0),
      axisA: new Vector3(0, 0, 1),
      isDriven: true,
      driveReferenceValue: 0,
    })],
    worldNodeUsed: false,
  };
}

/**
 * Planar four-bar: world → Crank → Coupler → Rocker → world. The last joint
 * closes the loop, so this rig exercises the residual/Newton path rather than
 * the open-chain fast path. World is ALWAYS the Body A side (Body B is required
 * and can never be the world frame), which is why the closing joint reads
 * world → Rocker.
 *
 * GEOMETRICALLY CLOSABLE by construction — this matters. Each link's origin sits
 * ON its first anchor and every link starts unrotated, so a local anchor in
 * millimetres is exactly the world delta from that origin, and all four joints'
 * A/B anchors coincide in world space at the assembly pose:
 *
 *   ground 600 · crank 200 · coupler 500 · rocker 300
 *   pivots  (0,0,0) and (0.6,0,0); crank tip (0.2,0,0); coupler tip (0.6,0.3,0)
 *   |(0.6,0.3,0) − (0.2,0,0)| = 0.5 = coupler length ✓
 *
 * An arbitrary set of anchors would still *solve* (damped least squares always
 * returns something), but from an inconsistent assembly pose — which makes any
 * assertion about the result meaningless and can leave the inverse Jacobian
 * rank-deficient.
 */
export function fourBarRig(): Rig {
  return {
    links: [
      makeLink('Crank', 0, 0, 0),
      makeLink('Coupler', 0.2, 0, 0),
      makeLink('Rocker', 0.6, 0.3, 0),
    ],
    joints: [
      makeJoint({
        name: 'A', bodyA: -1, bodyB: 0,
        anchorAMm: new Vector3(0, 0, 0), anchorBMm: new Vector3(0, 0, 0),
        isDriven: true,
      }),
      makeJoint({
        name: 'B', bodyA: 0, bodyB: 1,
        anchorAMm: new Vector3(200, 0, 0), anchorBMm: new Vector3(0, 0, 0),
      }),
      makeJoint({
        name: 'C', bodyA: 1, bodyB: 2,
        anchorAMm: new Vector3(400, 300, 0), anchorBMm: new Vector3(0, 0, 0),
      }),
      makeJoint({
        name: 'D', bodyA: -1, bodyB: 2,
        anchorAMm: new Vector3(600, 0, 0), anchorBMm: new Vector3(0, -300, 0),
      }),
    ],
    worldNodeUsed: true,
  };
}

/**
 * A rig whose platform is reachable only through Spherical joints, so the
 * Revolute/Prismatic-only spanning tree cannot reach it and it becomes a FREE
 * BODY (six extra generalized coordinates) — the Delta case, and the one that
 * makes the free-body buffers non-empty.
 */
export function freeBodyRig(): Rig {
  return {
    links: [
      makeLink('Base', 0, 0, 0),
      makeLink('UpperArm', 0.2, 0, 0),
      makeLink('Platform', 0.5, -0.3, 0),
    ],
    joints: [
      makeJoint({
        name: 'Shoulder', bodyA: 0, bodyB: 1,
        anchorAMm: new Vector3(0, 0, 0), anchorBMm: new Vector3(-200, 0, 0),
        isDriven: true,
      }),
      makeJoint({
        name: 'Ball', jointType: 'Spherical', bodyA: 1, bodyB: 2,
        anchorAMm: new Vector3(100, 0, 0), anchorBMm: new Vector3(-200, 300, 0),
      }),
    ],
    worldNodeUsed: false,
  };
}

/** Topology of a rig, throwing on a configuration error (tests want a hard fail). */
export function topologyOf(rig: Rig): MechanismTopology {
  const result = buildTopology(rig.joints, rig.links, rig.worldNodeUsed, CONTROLLER_SCALE);
  if (!result.ok) throw new Error(`topology failed: ${result.error}`);
  return result.topology;
}

/** Build a rig, export its blob and create a live wasm solver instance. */
export function createSolverFor(
  provider: KinematicSolverProvider,
  rig: Rig,
): { topology: MechanismTopology; solver: KinematicSolverInstance } {
  const topology = topologyOf(rig);
  const blob = exportMechanismStateBlob(topology, rig.joints);
  const solver = provider.createMechanism(blob.ints, blob.floats, blob.sizes);
  if (!solver) throw new Error('rvk_create rejected the state blob (handle 0)');
  // Free bodies must be seeded with their authored orientation before the first
  // solve — rvk_solve always overwrites its state from the caller's buffer.
  for (let i = 0; i < topology.freeBodyDofs.length; i++) {
    const r = topology.freeBodyDofs[i].initialRot;
    solver.seedFreeBodyRotation(i, r.x, r.y, r.z, r.w);
  }
  return { topology, solver };
}

/** Seed the root link's live world pose from the rig's authored link poses. */
export function seedRoot(
  solver: KinematicSolverInstance,
  topology: MechanismTopology,
  rig: Rig,
): void {
  if (topology.rootLinkIndex < 0) return;
  const l = rig.links[topology.rootLinkIndex];
  solver.seedRootLinkPose(
    topology.rootLinkIndex,
    l.worldPosition.x, l.worldPosition.y, l.worldPosition.z,
    l.worldRotation.x, l.worldRotation.y, l.worldRotation.z, l.worldRotation.w,
  );
}

/**
 * Two-link open chain: Base (root) → Arm1 (DRIVEN) → Arm2 (PASSIVE), both
 * Revolute about Z, 300 mm each. No loop closure, so the inverse Jacobian is
 * well conditioned — this is the rig for asserting that inverse mode writes an
 * output value for EVERY tree dof, active and passive alike, without fighting
 * the rank deficiency a planar four-bar has out of plane.
 */
export function twoLinkChainRig(): Rig {
  return {
    links: [makeLink('Base', 0, 0, 0), makeLink('Arm1', 0.3, 0, 0), makeLink('Arm2', 0.6, 0, 0)],
    joints: [
      makeJoint({
        name: 'J1', bodyA: 0, bodyB: 1,
        anchorAMm: new Vector3(0, 0, 0), anchorBMm: new Vector3(-300, 0, 0),
        isDriven: true,
      }),
      makeJoint({
        name: 'J2', bodyA: 1, bodyB: 2,
        anchorAMm: new Vector3(300, 0, 0), anchorBMm: new Vector3(-300, 0, 0),
      }),
    ],
    worldNodeUsed: false,
  };
}
