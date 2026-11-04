// plan-673 O13/O14 — the obstacle field reads from the SCENE, and the mirror
// binds on the same component the physics was built from.
//
// ## Why this file exists
//
// The rework replaced two things at once, and each of them fails SILENTLY if it
// is wrong in isolation:
//
//  - `scanObstacles()` builds the MJCF obstacle list out of the per-node
//    components (`CollisionShapeSet` + `FreeBody` + `ContactProfile`). Get it
//    wrong and the obstacle is simply not in the physics — the node still
//    stands in the scene, so the picture looks complete.
//  - `RVMuJoCoFreeBodyMirror` writes `qpos` back onto those nodes, and it used
//    to find them through an `rv_obstacle` extras block that no longer exists.
//    Get THAT wrong and the obstacle is in the physics but frozen on screen:
//    the duck walks through a ball that never moves.
//
// The free-body mirror had no test at all before this file, which is precisely
// why the second failure mode was worth pinning. The oracle is the BUILT GLB:
// the generator's own OBSTACLE CHECK guarantees the components are complete, so
// scanning the artefact and binding to it exercises the production path on
// production data rather than on a fixture that agrees with it by construction.
//
// Node-only (glTF JSON read straight out of the GLB, tree rebuilt as Object3D
// the way GLTFLoader would), same approach as `joint-mirror.test.ts`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVMuJoCoFreeBodyMirror } from '@rv-private/mujoco/rv-mujoco-joint-mirror';
import { obstacleFromComponents, scanObstacles } from '@rv-private/mujoco/rv-mujoco-obstacle-scan';
import { parseRobotConfig } from '@rv-private/mujoco/rv-mujoco-locomotion-runtime';

const GLB = resolve(__dirname, 'duck/rv-duck.glb');

interface GltfNode {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  extras?: Record<string, unknown>;
}

function readGltfJson(path: string): { nodes: GltfNode[]; scenes: { nodes: number[] }[] } {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
}

/** The glTF node tree as Object3D, TRS applied and `extras` on `userData`. */
function buildTree(): { scene: Object3D; modelRoot: Object3D; byName: Map<string, Object3D> } {
  const gltf = readGltfJson(GLB);
  const objects = gltf.nodes.map((def) => {
    const node = new Object3D();
    node.name = def.name ?? '';
    if (def.translation) node.position.fromArray(def.translation);
    if (def.rotation) node.quaternion.fromArray(def.rotation);
    if (def.extras) node.userData = { ...def.extras };
    return node;
  });
  gltf.nodes.forEach((def, i) => {
    for (const child of def.children ?? []) objects[i].add(objects[child]);
  });
  const scene = new Object3D();
  for (const i of gltf.scenes[0].nodes) scene.add(objects[i]);
  const modelRoot = objects.find((o) => o.userData.rv_mujoco !== undefined);
  if (!modelRoot) throw new Error('no node carries rv_mujoco');
  const byName = new Map(objects.filter((o) => o.name).map((o) => [o.name, o]));
  return { scene, modelRoot, byName };
}

describe('plan-673 O14 — the obstacles are read off the scene', () => {
  const { modelRoot, byName } = buildTree();
  const report = scanObstacles(modelRoot);

  it('finds the whole field and refuses nothing', () => {
    expect(report.skipped).toEqual([]);
    // 34 since O15 widened the ball field; 30 free, 4 welded posts.
    expect(report.obstacles).toHaveLength(34);
    expect(report.obstacles.filter((o) => o.static === true)).toHaveLength(4);
  });

  it('the model no longer carries a central obstacles array, and one is refused', () => {
    const raw = modelRoot.userData.rv_mujoco as Record<string, unknown>;
    expect(raw.obstacles).toBeUndefined();
    // The refusal is the point: silently ignoring a stale array would leave an
    // author editing numbers that never reach the physics.
    expect(() => parseRobotConfig({ ...raw, obstacles: [] })).toThrow(/no longer read/);
  });

  it('every obstacle node carries the components instead of a Drive (O13)', () => {
    for (const o of report.obstacles) {
      const node = byName.get(o.name);
      expect(node, o.name).toBeDefined();
      const rv = node!.userData.realvirtual as Record<string, unknown>;
      expect(Object.keys(rv), o.name).toContain('CollisionShapeSet');
      expect(Object.keys(rv), o.name).toContain('FreeBody');
      expect(rv.Drive, o.name).toBeUndefined();
      expect(node!.userData.rv_obstacle, o.name).toBeUndefined();
    }
  });

  it('NO node of the whole model carries a Drive { Direction: Virtual } any more', () => {
    // The trunk was the last one — it is a FreeBody now, which is what a
    // floating base actually is.
    const offenders: string[] = [];
    modelRoot.traverse((n) => {
      const drive = (n.userData.realvirtual as { Drive?: { Direction?: string } } | undefined)?.Drive;
      if (drive?.Direction === 'Virtual') offenders.push(n.name);
    });
    expect(offenders).toEqual([]);
  });

  it('the floating base is a FreeBody but not an obstacle', () => {
    const trunk = byName.get('trunk_base');
    expect(trunk).toBeDefined();
    const rv = trunk!.userData.realvirtual as Record<string, unknown>;
    expect(rv.FreeBody).toBeDefined();
    // No CollisionShapeSet is exactly what keeps it out of the field: its
    // collision geometry (and its mass) live in the Apache-2.0 MJCF, and a
    // second MJCF body for the base would be a different robot.
    expect(rv.CollisionShapeSet).toBeUndefined();
    expect(report.obstacles.map((o) => o.name)).not.toContain('trunk_base');
  });

  it('mm half extents become metre half extents — the unit trap, pinned', () => {
    // `CollisionShapeSet.Size` is mm HALF extents; MuJoCo `size` is metres.
    // Phase 0 logged three conventions in one model (colliders[] metres/full,
    // TransportStopper mm, this one mm/half), so the factor is worth an assert.
    const ball = report.obstacles.find((o) => o.name === 'obs_ball_a');
    expect(ball?.shape).toBe('sphere');
    expect(ball?.size).toEqual([0.035]);
    const post = report.obstacles.find((o) => o.name === 'obs_post_e');
    expect(post?.size).toEqual([0.03, 0.03, 0.12]);
    expect(post?.static).toBe(true);
    expect(post?.mass).toBeUndefined();
  });

  it('a ContactProfile wins over FreeBody, and only the balls have one', () => {
    // Rolling friction has no slot on FreeBody, and without it a kicked 50 g
    // ball travelled 8.46 m instead of 0.38 m (plan-659, measured).
    const ball = report.obstacles.find((o) => o.name === 'obs_ball_a');
    expect(ball?.condim).toBe(6);
    expect(ball?.friction).toEqual([1, 0.005, 0.01]);
    // The cubes state condim 3 explicitly — the value the staffel was measured
    // at, NOT the component's own safer default of 4.
    const cube = report.obstacles.find((o) => o.name === 'obs_cube_m1');
    expect(cube?.condim).toBe(3);
    expect(cube?.mass).toBeCloseTo(0.2, 6);
  });

  it('a decomposition is named, not silently dropped', () => {
    // Two primitives is legitimate authoring (plan-673's three-star is three
    // boxes) and simply not something the locomotion splice can write. The
    // difference between "skipped with a reason" and "absent" is the whole
    // point of this rework.
    const two = obstacleFromComponents('x', [0, 0, 0], {
      CollisionShapeSet: { Shapes: [{ Kind: 'box', Size: [10, 10, 10] }, { Kind: 'box', Size: [10, 10, 10] }] },
      FreeBody: { Enabled: true, MassKg: 1 },
    });
    expect(two).not.toBeNull();
    expect(two).toHaveProperty('skip');
    // And a mass that has to be DERIVED is refused rather than guessed: an
    // obstacle of this world has no MechanismBody, so the derivation would fall
    // back to the bounding box.
    const noMass = obstacleFromComponents('y', [0, 0, 0], {
      CollisionShapeSet: { Shapes: [{ Kind: 'box', Size: [10, 10, 10] }] },
      FreeBody: { Enabled: true, MassKg: 0 },
    });
    expect(noMass).toHaveProperty('skip');
    // Collision geometry WITHOUT a free body belongs to something else and is
    // passed over in silence — that is not a defect.
    expect(obstacleFromComponents('z', [0, 0, 0], {
      CollisionShapeSet: { Shapes: [{ Kind: 'box', Size: [10, 10, 10] }] },
    })).toBeNull();
  });
});

describe('plan-673 O14 — the free-body mirror binds on FreeBody', () => {
  const { modelRoot, byName } = buildTree();
  const report = scanObstacles(modelRoot);
  const free = report.obstacles.filter((o) => o.static !== true);
  /** Stand-in for the compiled model: every free obstacle gets 7 qpos. */
  const adr = new Map(free.map((o, i) => [o.name, 21 + i * 7]));

  it('binds every free obstacle and no welded one', () => {
    const mirror = RVMuJoCoFreeBodyMirror.fromObject3D(modelRoot, (n) => adr.get(n));
    expect(mirror.bodies).toHaveLength(free.length);
    expect(mirror.bodies.map((b) => b.name).sort()).toEqual(free.map((o) => o.name).sort());
    // The welded posts have no qpos; writing them every frame would be pure cost.
    expect(mirror.bodies.map((b) => b.name)).not.toContain('obs_post_e');
    // And the floating base is not reported as an unbindable obstacle — it is a
    // FreeBody too, so without the `rv_free_joint` exemption every single load
    // would print a warning that is pure noise.
    expect(mirror.skipped).toEqual([]);
  });

  it('writes qpos straight through — the frame the scan read is the frame it writes', () => {
    const mirror = RVMuJoCoFreeBodyMirror.fromObject3D(modelRoot, (n) => adr.get(n));
    const qpos = new Float64Array(21 + free.length * 7);
    for (const [name, a] of adr) {
      const i = free.findIndex((o) => o.name === name);
      qpos[a] = 1 + i; qpos[a + 1] = 2 + i; qpos[a + 2] = 3 + i;
      qpos[a + 3] = 1;  // w, x, y, z — MuJoCo order
    }
    mirror.apply(qpos);
    for (const [name, a] of adr) {
      const node = byName.get(name)!;
      expect([node.position.x, node.position.y, node.position.z], name)
        .toEqual([qpos[a], qpos[a + 1], qpos[a + 2]]);
      expect(node.quaternion.w, name).toBe(1);
    }
  });

  it('an obstacle whose body is missing from the model is named, not dropped quietly', () => {
    const partial = new Map(adr);
    partial.delete(free[0].name);
    const mirror = RVMuJoCoFreeBodyMirror.fromObject3D(modelRoot, (n) => partial.get(n));
    expect(mirror.bodies).toHaveLength(free.length - 1);
    expect(mirror.skipped.map((s) => s.node)).toEqual([free[0].name]);
  });
});
