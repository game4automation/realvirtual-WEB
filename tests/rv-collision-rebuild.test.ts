// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.6 — live role changes (F11) and the subtree cut-off (§2.7).
 *
 * "The robot counts up to the gripper" — a nested role starts a body of its
 * own, and the parent body loses those meshes. The pair between the two is
 * skipped (F16) because they touch at the flange by construction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { boxMesh, FakeHighlightHost } from './collision-fixture';
import { __resetCollisionAlertStore, getCollisionAlertSnapshot } from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;

/** Robot with a gripper child, plus an unrelated machine 3 m away. */
function nestedScene() {
  const scene = new Scene();
  const robot = new Object3D(); robot.name = 'Robot';
  robot.add(boxMesh({ name: 'Arm' }));

  const gripper = new Object3D(); gripper.name = 'Gripper';
  gripper.position.x = 0.4;                    // overlaps the arm on purpose
  gripper.add(boxMesh({ name: 'Jaw' }));
  robot.add(gripper);

  const machine = new Object3D(); machine.name = 'Machine';
  machine.position.x = 3;
  machine.add(boxMesh({ name: 'Frame' }));

  scene.add(robot, machine);
  scene.updateMatrixWorld(true);

  const manager = new RVCollisionManager();
  manager.setHighlightHost(new FakeHighlightHost());
  return { scene, robot, gripper, machine, manager };
}

function meshNames(manager: RVCollisionManager, root: Object3D): string[] {
  const body = manager.bodies.find((b) => b.root === root);
  return body ? body.meshes.map((m) => m.mesh.name).sort() : [];
}

beforeEach(() => __resetCollisionAlertStore());

describe('registry rebuild', () => {
  it('applies None -> Robot within the next tick (F11)', () => {
    const s = nestedScene();
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);
    expect(s.manager.pairs).toHaveLength(0);

    s.manager.register(s.robot, 'Robot');
    expect(s.manager.isDirty).toBe(true);
    s.manager.update(DT);                       // rebuild happens at tick head
    expect(s.manager.pairs).toHaveLength(1);
  });

  it('applies Robot -> None and drops the body again', () => {
    const s = nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(2);

    s.manager.register(s.robot, 'None');
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(1);
    expect(s.manager.pairs).toHaveLength(0);
  });

  it('re-pairs when a role changes to a different value', () => {
    const s = nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.gripper, 'Robot');     // same role → no pair
    s.manager.update(DT);
    expect(s.manager.pairs).toHaveLength(0);

    s.manager.register(s.gripper, 'Machine');   // different role, but nested
    s.manager.update(DT);
    expect(s.manager.pairs).toHaveLength(0);    // still skipped by F16
  });

  it('cuts the subtree at the innermost node carrying a role', () => {
    const s = nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.gripper, 'Tool');
    s.manager.register(s.machine, 'Machine');
    s.manager.rebuild();

    expect(meshNames(s.manager, s.robot)).toEqual(['Arm']);      // NOT 'Jaw'
    expect(meshNames(s.manager, s.gripper)).toEqual(['Jaw']);
  });

  it('does not report the robot against its own gripper (F16), but does report the machine', () => {
    const s = nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.gripper, 'Tool');
    s.manager.register(s.machine, 'Machine');

    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(0);   // arm/jaw overlap ignored
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);

    // Drive the gripper into the machine — that pair IS checked.
    s.gripper.position.x = 2.7;
    s.scene.updateMatrixWorld(true);
    s.manager.update(DT);
    const pairs = s.manager.activePairs;
    expect(pairs).toHaveLength(1);
    expect([pairs[0].aPath, pairs[0].bPath].sort()).toEqual(['Gripper', 'Machine']);
  });

  it('re-cuts correctly when a nested role is added at runtime (F11)', () => {
    const s = nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.rebuild();
    expect(meshNames(s.manager, s.robot)).toEqual(['Arm', 'Jaw']);

    s.manager.register(s.gripper, 'Tool');
    s.manager.update(DT);
    expect(meshNames(s.manager, s.robot)).toEqual(['Arm']);
    expect(meshNames(s.manager, s.gripper)).toEqual(['Jaw']);
  });

  it('unregister removes the body at the next tick', () => {
    const s = nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);
    s.manager.unregister(s.machine);
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(1);
  });
});
