// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.3 / 9.8b — THE verified bug: since the destructive bake a role on
 * a STATIC node has no mesh under it (its triangles were merged into the
 * asset's root chunk), and the plan-394 body ("the meshes under the node")
 * found nothing, so it never collided. A body is now the node's segment ranges
 * per chunk, resolved through the bake registry.
 *
 * Also covered: nested roles cut out of the parent body (a sub-range AND a
 * nested mover chunk that arrives whole), a role under a Group partition, a
 * body with zero parts, hidden owners through a parent chain, and the Problems
 * `nodePath` being a real node path (contract bake-picking rules 12/13).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RV_PARTITION_KEY } from '../src/core/engine/rv-bake-chunk';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import { clearAllProblems, getProblem } from '../src/core/hmi/problems-store';
import { bakeCollisionScene, bodyNode, plainGroup, uberBox } from './collision-fixture';

/** A node that only survives the bake (claims itself, merges its geometry). */
registerComponentSchema('TestCollisionHolder', {}, {});

const DT = 1 / 60;

function holder(name: string, ...children: Object3D[]): Object3D {
  const g = plainGroup(name, ...children);
  g.userData.realvirtual = { TestCollisionHolder: { enabled: true } };
  return g;
}

/** Asset { Fence(Environment) static @x=10, Box(Workpiece) static @x=10.4, Axis(Robot, mover) @0 } */
async function fenceScene() {
  const root = plainGroup('Asset',
    bodyNode('Fence', { role: 'Environment', at: [10, 0, 0] }),
    bodyNode('Box', { role: 'Workpiece', at: [10.4, 0.1, 0.05], size: [0.6, 0.6, 0.6] }),
    bodyNode('Axis', { role: 'Robot', mover: true, size: [1, 0.6, 0.6] }),
  );
  const s = await bakeCollisionScene(root);
  const fence = s.node('Fence');
  const box = s.node('Box');
  const axis = s.node('Axis');
  s.manager.register(fence, 'Environment');
  s.manager.register(box, 'Workpiece');
  s.manager.register(axis, 'Robot');
  return { ...s, fence, box, axis };
}

function bodyOf(s: { manager: import('../src/core/engine/rv-collision-manager').RVCollisionManager }, root: Object3D) {
  const b = s.manager.bodies.find((x) => x.root === root);
  if (!b) throw new Error(`no body for ${root.name}`);
  return b;
}

function reported(s: { manager: import('../src/core/engine/rv-collision-manager').RVCollisionManager }): string[] {
  return s.manager.activePairs.map((p) => [p.aPath, p.bPath].sort().join('|')).sort();
}

beforeEach(() => {
  __resetCollisionAlertStore();
  clearAllProblems();
});

describe('static role nodes collide after the destructive bake', () => {
  it('a static role has no mesh, but its segment range IS its body', async () => {
    const s = await fenceScene();
    // The bug's precondition: no Mesh survived under the static role nodes.
    let meshesUnderFence = 0;
    s.fence.traverse((n) => { if ((n as { isMesh?: boolean }).isMesh) meshesUnderFence++; });
    expect(meshesUnderFence).toBe(0);

    s.manager.rebuild();
    const fence = bodyOf(s, s.fence);
    expect(fence.parts).toHaveLength(1);
    expect(fence.parts[0].kind).toBe('chunk');
    expect(fence.parts[0].segments).toBeGreaterThan(0);
    expect(fence.parts[0].triangles).toBe(12);
    expect(fence.parts[0].mesh.userData[RV_BAKE_CHUNK_KEY]).toBe(true);
    // Fence and Box share the asset's root chunk, but own different segments.
    const box = bodyOf(s, s.box);
    expect(box.parts[0].mesh).toBe(fence.parts[0].mesh);
    expect(Array.from(box.parts[0].intervals)).not.toEqual(Array.from(fence.parts[0].intervals));
  });

  it('Axis driven into the Fence latches; the still Fence↔Box overlap is only a Problems entry', async () => {
    const s = await fenceScene();
    s.manager.update(DT);                         // first evaluation: baseline
    expect(reported(s)).toEqual([]);
    expect(s.manager.pairStateOf(bodyOf(s, s.fence).key, bodyOf(s, s.box).key))
      .toEqual({ state: 'baseline', authoredStill: true });

    s.axis.position.x = 9.3;                       // into the fence (8.8..9.8 vs 9.5..10.5)
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Axis|Fence']);

    const entry = getProblem('collision-authored-overlap');
    expect(entry?.severity).toBe('info');
    expect(entry?.quiet).toBe(true);
    expect(entry?.detail).toContain('Fence (Environment)');
    expect(entry?.detail).toContain('Box (Workpiece)');
    // Rules 12/13: a REAL node path, never a chunk, partition or `tex:` key.
    expect([NodeRegistry.computeNodePath(s.fence), NodeRegistry.computeNodePath(s.box)]).toContain(entry?.nodePath);
    expect(entry?.nodePath).not.toMatch(/tex:|mover:|grp:|static/);
  });

  it('a nested role is cut out of the parent body — sub-range and a nested mover chunk', async () => {
    const root = plainGroup('Asset',
      bodyNode('Robot', { role: 'Robot', mover: true },
        // A static nested role: its triangles sit in the Robot's mover chunk.
        bodyNode('Flange', { role: 'Tool', at: [0.4, 0, 0], size: [0.6, 0.6, 0.6] }),
        // A nested MOVER role: its chunk arrives whole for the Robot's subtree.
        bodyNode('Gripper', { role: 'Tool', mover: true, at: [-0.4, 0, 0], size: [0.6, 0.6, 0.6] }),
      ),
      bodyNode('Machine', { role: 'Machine', mover: true, at: [3, 0, 0], size: [1, 0.8, 0.8] }),
    );
    const s = await bakeCollisionScene(root);
    const robot = s.node('Robot');
    const flange = s.node('Flange');
    const gripper = s.node('Gripper');
    const machine = s.node('Machine');
    s.manager.register(robot, 'Robot');
    s.manager.register(flange, 'Tool');
    s.manager.register(gripper, 'Tool');
    s.manager.register(machine, 'Machine');
    s.manager.rebuild();

    const rb = bodyOf(s, robot);
    // Only the robot's own box: the flange range and the gripper chunk are cut out.
    expect(rb.parts.reduce((n, p) => n + p.triangles, 0)).toBe(12);
    expect(bodyOf(s, flange).parts.reduce((n, p) => n + p.triangles, 0)).toBe(12);
    expect(bodyOf(s, gripper).parts.reduce((n, p) => n + p.triangles, 0)).toBe(12);
    // F16: Robot↔Flange / Robot↔Gripper are never paired (they overlap by design).
    s.manager.update(DT);
    expect(reported(s)).toEqual([]);

    // Drive the robot (and its tools with it) into the machine.
    robot.position.x = 2.3;
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Flange|Machine', 'Machine|Robot']);
  });

  it('a role on a node inside a Group partition resolves its segments in the partitioned chunk', async () => {
    const cell = bodyNode('Guard', { role: 'Environment', at: [5, 0, 0], size: [1, 0.8, 0.8] });
    cell.userData[RV_PARTITION_KEY] = ['G1'];
    const root = plainGroup('Asset', cell, bodyNode('Slide', { role: 'Robot', mover: true, size: [1, 0.6, 0.6] }));
    const s = await bakeCollisionScene(root);
    const guard = s.node('Guard');
    const slide = s.node('Slide');
    s.manager.register(guard, 'Environment');
    s.manager.register(slide, 'Robot');
    s.manager.update(DT);
    const gb = bodyOf(s, guard);
    expect(gb.parts).toHaveLength(1);
    // The chunk hangs under a synthetic partition object, not under the role node.
    expect(gb.parts[0].mesh.parent?.name).toContain('G1');
    slide.position.x = 4.3;
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Guard|Slide']);
  });

  it('a role node without geometry is a body with zero parts and no pairs', async () => {
    const root = plainGroup('Asset',
      bodyNode('Empty', { role: 'Environment', noMesh: true }),
      bodyNode('Slide', { role: 'Robot', mover: true }),
    );
    const s = await bakeCollisionScene(root);
    s.manager.register(s.node('Empty'), 'Environment');
    s.manager.register(s.node('Slide'), 'Robot');
    s.manager.update(DT);
    expect(bodyOf(s, s.node('Empty')).parts).toHaveLength(0);
    expect(s.manager.bodies).toHaveLength(2);
    expect(s.manager.pairs).toHaveLength(0);
  });

  it('a body hidden through a parent chain takes no part after node-visibility-changed', async () => {
    const root = plainGroup('Asset',
      holder('Area', bodyNode('Fence', { role: 'Environment', at: [3, 0, 0], size: [1, 0.8, 0.8] })),
      bodyNode('Slide', { role: 'Robot', mover: true, size: [1, 0.6, 0.6] }),
    );
    const s = await bakeCollisionScene(root);
    const fence = s.node('Fence');
    const slide = s.node('Slide');
    s.manager.register(fence, 'Environment');
    s.manager.register(slide, 'Robot');
    s.manager.update(DT);
    expect(bodyOf(s, fence).parts).toHaveLength(1);

    s.node('Area').visible = false;            // the chunk mesh itself stays visible
    s.manager.invalidateVisibility();          // what `node-visibility-changed` calls
    s.manager.update(DT);
    expect(bodyOf(s, fence).parts).toHaveLength(0);
    slide.position.x = 2.3;
    s.manager.update(DT);
    expect(reported(s)).toEqual([]);

    s.node('Area').visible = true;
    s.manager.invalidateVisibility();
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Fence|Slide']);
  });

  it('does not alarm for a box merely resting ON a static body (touching ≠ collision)', async () => {
    const root = plainGroup('Asset',
      bodyNode('Table', { role: 'Machine', size: [2, 0.2, 2] }),
      bodyNode('Part', { role: 'Workpiece', mover: true, at: [3, 0.35, 0], size: [0.5, 0.5, 0.5] }),
    );
    const s = await bakeCollisionScene(root);
    const part = s.node('Part');
    s.manager.register(s.node('Table'), 'Machine');
    s.manager.register(part, 'Workpiece');
    s.manager.update(DT);
    part.position.x = 0.2;                     // slides onto the table top, flush (y 0.1)
    s.manager.update(DT);
    expect(reported(s)).toEqual([]);
    part.position.y = 0.3;                     // pressed 5 cm into the table
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Part|Table']);
  });
});

// Keep `uberBox` referenced for fixture parity (used by other suites).
void uberBox;
