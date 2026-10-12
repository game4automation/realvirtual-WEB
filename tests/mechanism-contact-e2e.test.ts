// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mechanism-contact-e2e.test.ts — plan-467 test 9.10.
 *
 * The whole chain, with BOTH real wasm artifacts and no mocks in between:
 *
 *   Rapier contact  →  RapierPhysicsProvider.forEachContactLoad
 *                   →  RVMovingColliderRegistry.aggregateLoads
 *                   →  RVKinematicManager.setExternalLinkLoad
 *                   →  link_wrench (ABI v4)  →  rvk_solve_dynamics
 *                   →  the drive torque a user reads off the force chart.
 *
 * A 1 kg MU resting on a gripper pad 0.5 m out from the hinge must cost the
 * drive 4.905 N·m more than the empty machine — and give it back when the part
 * is taken away. The third case is the one that only an end-to-end test can
 * see: a mechanism REBUILD while the part is held must not leave the payload on
 * a stale link index (SOL R1 #9).
 *
 * Two artifacts, two skip rules: the kinematic wasm is part of the build (skip
 * loudly if absent), Rapier is out-of-band (skip unless `RV_PHYSICS_REQUIRE_WASM=1`,
 * F15).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { setRapierLibLoader } from '@rv-private/physics/rapier-lib-loader';
import { RVMovingColliderRegistry } from '@rv-private/physics/rv-moving-collider-registry';
import { RVKinematicManager } from '@rv-private/kinematic-mechanism/rv-kinematic-manager';
import { KinematicUiBridge } from '@rv-private/kinematic-mechanism/rv-kinematic-ui-bridge';
import {
  RVKinematicJoint,
  RVKinematicMechanism,
  RVMechanismBody,
} from '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';
import { getRegisteredFactories } from '../src/core/engine/rv-component-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { PhysicsQuat, PhysicsVec3 } from '../src/core/engine/rv-physics-registry';

const DT = PHYSICS_FIXED_DT;
const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };
const ZONE_CFG = { friction: 0.8, restitution: 0, removeBelowY: -10 };
/**
 * 1 kg at 0.5 m from the hinge. The drive reports it NEGATIVE: `AxisA` is
 * authored in Unity coordinates and `jointAxisToGltf` negates a ROTATION axis,
 * so this drive's positive direction is world −Z while the payload's holding
 * moment is +Z. The magnitude is the physics; the sign is the axis convention,
 * and the assertions state both rather than hiding one of them behind an abs().
 */
const EXPECTED_NM = 9.81 * 0.5;

const REQUIRE_WASM = typeof __RV_PHYSICS_REQUIRE_WASM__ !== 'undefined' && __RV_PHYSICS_REQUIRE_WASM__;

let rapierAvailable = false;

beforeAll(async () => {
  const probe = new RapierPhysicsProvider();
  try {
    await probe.init();
    rapierAvailable = probe.ready;
  } catch {
    rapierAvailable = false;
  }
  probe.dispose();
}, 30000);

beforeEach(() => setRapierLibLoader(null));
afterEach(() => setRapierLibLoader(null));

/** A joint built through the REGISTERED factory, so the mechanism's subtree scan finds it. */
function makeJoint(node: Object3D, over: Partial<RVKinematicJoint>): RVKinematicJoint {
  const factory = getRegisteredFactories().get('KinematicJoint')!;
  const inst = factory.create(node, null) as RVKinematicJoint;
  factory.afterCreate?.(inst, node);
  Object.assign(inst, over);
  return inst;
}

/** A near-massless body, so whatever the drive reports IS the payload. */
function makeBody(node: Object3D): RVMechanismBody {
  const factory = getRegisteredFactories().get('MechanismBody')!;
  const inst = factory.create(node, null) as RVMechanismBody;
  factory.afterCreate?.(inst, node);
  inst.MassOverrideKg = 1e-4;
  inst.ComOverrideLocalMm = new Vector3(0, 0, 0);
  return inst;
}

interface Cell {
  scene: Scene;
  mech: RVKinematicMechanism;
  manager: RVKinematicManager;
  registry: RVMovingColliderRegistry;
  provider: RapierPhysicsProvider;
  zone: RVPhysicsZone;
  tick(): void;
  driveTorque(): number;
  dispose(): void;
}

/**
 * Hinge at the world origin about +Z, arm 0.5 m out along +X, and a pad on the
 * arm whose top surface is the place an MU can rest on.
 */
async function buildCell(): Promise<Cell | null> {
  if (!rapierAvailable) {
    if (REQUIRE_WASM) {
      throw new Error(
        '[plan-467 F15] RV_PHYSICS_REQUIRE_WASM=1 but @dimforge/rapier3d-compat is not usable — '
        + 'install it out-of-band (npm i --no-save @dimforge/rapier3d-compat@0.19.3)',
      );
    }
    console.warn('[physics-467] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
    return null;
  }

  const scene = new Scene();
  const root = new Object3D(); root.name = 'Gripper'; scene.add(root);
  const base = new Object3D(); base.name = 'Base'; root.add(base);
  const arm = new Object3D(); arm.name = 'Arm'; arm.position.set(0.5, 0, 0); root.add(arm);

  // The pad: an authored BoxCollider, 0.4 × 0.1 × 0.4 m, top surface at y = +0.05.
  const pad = new Object3D(); pad.name = 'Pad'; arm.add(pad);
  pad.userData.realvirtual = {
    colliders: [{
      type: 'BoxCollider',
      center: { x: 0, y: 0, z: 0 },
      size: { x: 0.4, y: 0.1, z: 0.4 },
      enabled: true,
      isTrigger: false,
    }],
  };
  const hingeNode = new Object3D(); hingeNode.name = 'Hinge'; root.add(hingeNode);
  scene.updateMatrixWorld(true);

  makeBody(base);
  makeBody(arm);

  const driveNode = new Object3D(); driveNode.name = 'M1'; arm.add(driveNode);
  const drive = new RVDrive(driveNode);
  drive.Direction = DriveDirection.RotationZ;
  drive.initDrive();

  makeJoint(hingeNode, {
    BodyA: base,
    BodyB: arm,
    JointType: 'Revolute',
    // Anchors are Unity MILLIMETRES in each body's own frame: the hinge sits at
    // the world origin, i.e. 500 mm back along the arm's local −X.
    AnchorA: new Vector3(0, 0, 0),
    AnchorB: new Vector3(-500, 0, 0),
    AxisA: new Vector3(0, 0, 1),
    DrivenBy: drive,
  });

  const manager = new RVKinematicManager();
  const ok = await manager.ensureSolverLoaded();
  if (!ok) throw new Error(`kinematic wasm unavailable: ${manager.provider.failureDetail}`);

  const mech = new RVKinematicMechanism(root);
  mech.build();
  manager.register(mech);
  manager.notifyBuilt(mech);
  mech.setForceAnalysis(true);

  const provider = new RapierPhysicsProvider();
  provider.addZone('zone', { min: { x: -20, y: -20, z: -20 }, max: { x: 20, y: 20, z: 20 } }, ZONE_CFG);
  await provider.init();

  const zoneNode = new Object3D(); zoneNode.name = 'Zone'; zoneNode.updateMatrixWorld(true);
  const zone = new RVPhysicsZone(
    zoneNode,
    AABB.fromBoxCollider(zoneNode, { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 100 }),
  );
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);

  const registry = new RVMovingColliderRegistry();
  registry.collectMovingSet([], manager);
  registry.build(provider);

  // Topology changes invalidate the mapping and rebuild — what the physics zone
  // plugin subscribes to in production.
  manager.onTopologyChanged((m) => {
    registry.invalidateMechanism(provider, m);
    registry.collectMovingSet([], manager);
    registry.build(provider);
  });

  const cell: Cell = {
    scene, mech, manager, registry, provider, zone,
    tick(): void {
      // Production order (§2.1): mechanism SIM stage, then the physics plugin.
      manager.tickMechanisms(DT);
      registry.pushPoses(provider);
      provider.step(DT);
      registry.aggregateLoads(provider, manager);
    },
    driveTorque(): number {
      return mech.solverInstance?.driveForce[0] ?? NaN;
    },
    dispose(): void {
      registry.dispose(provider);
      provider.dispose();
      manager.dispose();
      zone.dispose?.();
    },
  };
  return cell;
}

function run(cell: Cell, ticks: number): void {
  for (let i = 0; i < ticks; i++) cell.tick();
}

describe('plan-467 9.10 — contact load reaches the drive', () => {
  it('a held 1 kg MU adds m·g·L to the drive torque, and giving it back returns to idle', async () => {
    const cell = await buildCell();
    if (!cell) return;
    try {
      // Idle: the machine is (deliberately) near massless, so this is ~0.
      run(cell, 30);
      const idle = cell.driveTorque();
      expect(Number.isFinite(idle)).toBe(true);
      expect(Math.abs(idle)).toBeLessThan(0.05);

      // A 1 kg cube dropped onto the pad, 0.5 m out from the hinge.
      cell.provider.addDynamicMU(
        'mu', { pos: { x: 0.5, y: 0.1501, z: 0 }, quat: Q_IDENT },
        { x: 0.1, y: 0.1, z: 0.1 }, V0, 1,
      );
      run(cell, 60);
      const loaded = cell.driveTorque();
      console.log(`[467 e2e] idle ${idle.toFixed(4)} N·m → loaded ${loaded.toFixed(4)} N·m`);
      expect(Math.abs(loaded - idle)).toBeGreaterThan(EXPECTED_NM * 0.95);
      expect(Math.abs(loaded - idle)).toBeLessThan(EXPECTED_NM * 1.05);
      expect(loaded - idle).toBeLessThan(0); // sign follows the drive axis

      // Released: back to idle within a couple of ticks (the load table is
      // consumed per tick, so a stale payload cannot linger).
      cell.provider.removeBody('mu');
      run(cell, 3);
      expect(Math.abs(cell.driveTorque() - idle)).toBeLessThan(0.05);
    } finally {
      cell.dispose();
    }
  }, 60000);

  it('a rebuild while the part is held puts the load back on the right link', async () => {
    const cell = await buildCell();
    if (!cell) return;
    try {
      cell.provider.addDynamicMU(
        'mu', { pos: { x: 0.5, y: 0.1501, z: 0 }, quat: Q_IDENT },
        { x: 0.1, y: 0.1, z: 0.1 }, V0, 1,
      );
      run(cell, 60);
      const before = cell.driveTorque();
      expect(Math.abs(before)).toBeGreaterThan(EXPECTED_NM * 0.95);

      // Authoring edit mid-hold: new link table, new solver, new bodies.
      cell.mech.build();
      cell.manager.notifyBuilt(cell.mech);
      cell.mech.setForceAnalysis(true);

      run(cell, 60);
      const after = cell.driveTorque();
      console.log(`[467 e2e rebuild] before ${before.toFixed(4)} N·m → after ${after.toFixed(4)} N·m`);
      expect(Math.abs(after)).toBeGreaterThan(EXPECTED_NM * 0.95);
      expect(Math.abs(after)).toBeLessThan(EXPECTED_NM * 1.05);
      expect(Math.sign(after)).toBe(Math.sign(before));
    } finally {
      cell.dispose();
    }
  }, 60000);

  // ── plan-467 9.11 (Phase 6) — the same payload, as the panel reads it ──────
  //
  // The drive torque above proves the load reached the SOLVER. This proves it
  // also reaches the USER: `MechanismForcesSnapshot.externalLoadN` is what the
  // Quick Edit "Ext. load" column renders, and it must name the link that
  // carries the part — not the machine as a whole, and not the base.
  it('the forces snapshot reports the payload on the carrying link', async () => {
    const cell = await buildCell();
    if (!cell) return;
    try {
      const bridge = new KinematicUiBridge(cell.manager);
      const path = bridge.list()[0]?.nodePath ?? '';
      expect(path).not.toBe('');

      // Empty machine: the column has nothing to show, and the UI hides it.
      run(cell, 30);
      const idleSnap = bridge.forcesSnapshot(path)!;
      expect(idleSnap.externalLoadN).toHaveLength(idleSnap.externalLoadN.length);
      expect(idleSnap.externalLoadN.every((n) => n < 0.05)).toBe(true);

      cell.provider.addDynamicMU(
        'mu', { pos: { x: 0.5, y: 0.1501, z: 0 }, quat: Q_IDENT },
        { x: 0.1, y: 0.1, z: 0.1 }, V0, 1,
      );
      run(cell, 60);

      const snap = bridge.forcesSnapshot(path)!;
      const links = bridge.list()[0]!.links;
      expect(snap.externalLoadN).toHaveLength(links.length);
      const armIdx = links.findIndex((l) => l.name === 'Arm');
      const baseIdx = links.findIndex((l) => l.name === 'Base');
      expect(armIdx).toBeGreaterThanOrEqual(0);
      console.log(`[467 ui] externalLoadN = [${snap.externalLoadN.map((n) => n.toFixed(3)).join(', ')}]`);
      // 1 kg resting on the pad — the magnitude a user reads off the column.
      expect(snap.externalLoadN[armIdx]).toBeGreaterThan(9.81 * 0.95);
      expect(snap.externalLoadN[armIdx]).toBeLessThan(9.81 * 1.05);
      // The base carries nothing: a per-mechanism total would wrongly show it here.
      if (baseIdx >= 0) expect(snap.externalLoadN[baseIdx]).toBeLessThan(0.05);

      // Taken away → the column goes back to "—" rather than freezing the
      // last payload (the load table is consumed per tick).
      cell.provider.removeBody('mu');
      run(cell, 5);
      expect(bridge.forcesSnapshot(path)!.externalLoadN.every((n) => n < 0.05)).toBe(true);
    } finally {
      cell.dispose();
    }
  }, 60000);
});
