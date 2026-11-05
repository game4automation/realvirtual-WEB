// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.6 — live role changes (F11) and the subtree cut-off (§2.7), on
 * the BAKED scene since plan-781.
 *
 * "The robot counts up to the gripper" — a nested role starts a body of its
 * own, and the parent body loses those segments. The pair between the two is
 * skipped (F16) because they touch at the flange by construction.
 *
 * plan-781 F17: pair states survive a rebuild by `pairKey` — a re-parent
 * `invalidate()` during a contact neither re-baselines an armed pair nor drops
 * a latch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Object3D } from 'three';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { bakeCollisionScene, bodyNode, plainGroup } from './collision-fixture';
import { __resetCollisionAlertStore, getCollisionAlertSnapshot } from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;

/** Robot (mover) with a gripper child (mover, overlapping the arm), plus a machine 3 m away. */
async function nestedScene() {
  const root = plainGroup('Asset',
    bodyNode('Robot', { role: 'Robot', mover: true, size: [1, 0.7, 0.7] },
      bodyNode('Gripper', { role: 'Tool', mover: true, at: [0.4, 0, 0], size: [0.6, 0.5, 0.5] })),
    bodyNode('Machine', { role: 'Machine', mover: true, at: [3, 0, 0], size: [1, 0.9, 0.9] }),
  );
  const s = await bakeCollisionScene(root);
  return { ...s, robot: s.node('Robot'), gripper: s.node('Gripper'), machine: s.node('Machine') };
}

function trianglesOf(manager: RVCollisionManager, root: Object3D): number {
  const body = manager.bodies.find((b) => b.root === root);
  return body ? body.parts.reduce((n, p) => n + p.triangles, 0) : -1;
}

beforeEach(() => __resetCollisionAlertStore());

describe('registry rebuild', () => {
  it('applies None -> Robot within the next tick (F11)', async () => {
    const s = await nestedScene();
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);
    expect(s.manager.pairs).toHaveLength(0);

    s.manager.register(s.robot, 'Robot');
    expect(s.manager.isDirty).toBe(true);
    s.manager.update(DT);                       // rebuild happens at tick head
    expect(s.manager.pairs).toHaveLength(1);
  });

  it('applies Robot -> None and drops the body again', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(2);

    s.manager.register(s.robot, 'None');
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(1);
    expect(s.manager.pairs).toHaveLength(0);
  });

  it('re-pairs when a role changes to a different value', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.gripper, 'Robot');     // same role → no pair
    s.manager.update(DT);
    expect(s.manager.pairs).toHaveLength(0);

    s.manager.register(s.gripper, 'Machine');   // different role, but nested
    s.manager.update(DT);
    expect(s.manager.pairs).toHaveLength(0);    // still skipped by F16
  });

  it('cuts the subtree at the innermost node carrying a role', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.gripper, 'Tool');
    s.manager.register(s.machine, 'Machine');
    s.manager.rebuild();

    expect(trianglesOf(s.manager, s.robot)).toBe(12);      // NOT the gripper's 12 as well
    expect(trianglesOf(s.manager, s.gripper)).toBe(12);
  });

  it('does not report the robot against its own gripper (F16), but does report the machine', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.gripper, 'Tool');
    s.manager.register(s.machine, 'Machine');

    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(0);   // arm/jaw overlap ignored
    expect(getCollisionAlertSnapshot().pairs).toHaveLength(0);

    // Drive the gripper into the machine — that pair IS checked.
    s.gripper.position.x = 2.7;
    s.manager.update(DT);
    const pairs = s.manager.activePairs;
    expect(pairs).toHaveLength(1);
    expect([pairs[0].aPath, pairs[0].bPath].sort()).toEqual(['Gripper', 'Machine']);
  });

  it('re-cuts correctly when a nested role is added at runtime (F11)', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.rebuild();
    expect(trianglesOf(s.manager, s.robot)).toBe(24);

    s.manager.register(s.gripper, 'Tool');
    s.manager.update(DT);
    expect(trianglesOf(s.manager, s.robot)).toBe(12);
    expect(trianglesOf(s.manager, s.gripper)).toBe(12);
  });

  it('unregister removes the body at the next tick', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);
    s.manager.unregister(s.machine);
    s.manager.update(DT);
    expect(s.manager.bodies).toHaveLength(1);
  });

  it('pair states survive a rebuild (F17): armed stays armed, a latch stays latched', async () => {
    const s = await nestedScene();
    s.manager.register(s.robot, 'Robot');
    s.manager.register(s.machine, 'Machine');
    s.manager.update(DT);                                    // apart → armed
    const [rb, mb] = [s.manager.bodies[0].key, s.manager.bodies[1].key];
    expect(s.manager.pairStateOf(rb, mb)?.state).toBe('armed');

    s.robot.position.x = 2.2;                                // into the machine
    s.manager.invalidate();                                  // a re-parent elsewhere, same tick
    s.manager.update(DT);
    // Not re-baselined by the rebuild: the contact latches.
    expect(s.manager.activePairs).toHaveLength(1);
    expect(s.manager.pairStateOf(rb, mb)?.state).toBe('armed');

    s.manager.invalidate();
    s.manager.update(DT);
    expect(s.manager.activePairs).toHaveLength(1);           // still latched after another rebuild
  });
});
