// plan-659 test 9.8 — coordinates: a MuJoCo state mirrored onto the GLB tree.
//
// The strongest available oracle for this mapping is the ASSET ITSELF: the duck
// GLB was authored at the STAND keyframe, so every joint node's rotation in the
// file is exactly `rest_quat ⊗ R(axis, stand_angle)`. Mirroring that same state
// must therefore reproduce the file's own quaternions — if the formula were
// wrong (order swapped, axis in the parent frame, w/xyz confused) it could not.
//
// The test reads the glTF JSON chunk straight from the GLB, builds the
// hierarchy from it and binds the mirror to that — no GLTFLoader, no WebGL, no
// DOM, so it runs in the Node spike config next to the Phase-1 tests.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RVMuJoCoJointMirror } from '@rv-private/mujoco/rv-mujoco-joint-mirror';

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

/** Rebuild the glTF node tree as Object3D, the way GLTFLoader would: TRS
 *  applied, `extras` copied onto `userData`. */
function buildTree(gltf: ReturnType<typeof readGltfJson>): {
  root: Object3D;
  byName: Map<string, Object3D>;
} {
  const objects = gltf.nodes.map((def) => {
    const node = new Object3D();
    node.name = def.name ?? '';
    if (def.translation) node.position.fromArray(def.translation);
    if (def.rotation) node.quaternion.fromArray(def.rotation);
    if (def.extras) node.userData = { ...def.extras };
    return node;
  });
  gltf.nodes.forEach((def, index) => {
    for (const child of def.children ?? []) objects[index].add(objects[child]);
  });
  const root = new Object3D();
  root.name = 'scene';
  for (const index of gltf.scenes[0].nodes) root.add(objects[index]);
  const byName = new Map(objects.map((o) => [o.name, o]));
  return { root, byName };
}

describe('9.8 MuJoCo → Three.js joint mirror', () => {
  const gltf = readGltfJson(GLB);
  const contract = gltf.nodes.find((n) => n.extras?.rv_actuated_joints)?.extras as
    | { rv_actuated_joints: string[] }
    | undefined;

  it('binds every actuated joint and the floating base', () => {
    const { root } = buildTree(gltf);
    const mirror = RVMuJoCoJointMirror.fromObject3D(root);
    expect(mirror.skipped).toEqual([]);
    expect(mirror.joints).toHaveLength(14);
    expect(mirror.base?.name).toBe('trunk_base');
    // Bound in ACTUATOR order — the policy's joint order, not tree order.
    expect(mirror.joints.map((j) => j.actuatorIndex)).toEqual([...Array(14).keys()]);
    expect(mirror.joints.map((j) => j.name)).toEqual(contract?.rv_actuated_joints);
  });

  it('reproduces the authored STAND pose from the stand angles', () => {
    const { root } = buildTree(gltf);
    const mirror = RVMuJoCoJointMirror.fromObject3D(root);
    const authored = mirror.joints.map((j) => j.node.quaternion.clone());

    // The qpos layout of the fixture: 7 free-joint slots, then one per joint.
    const qpos = new Float64Array(7 + 14);
    qpos.set([0, 0, 0.12, 1, 0, 0, 0], 0);
    const qposAdr = new Int32Array(14);
    mirror.joints.forEach((joint, i) => {
      qposAdr[i] = 7 + i;
      const extras = joint.node.userData.rv_joint as { stand_angle: number };
      qpos[7 + i] = extras.stand_angle;
    });

    // Perturb first, so a mirror that did nothing could not pass.
    mirror.joints.forEach((j) => j.node.quaternion.set(0, 0, 0, 1));
    mirror.apply(qpos, 0, qposAdr);

    mirror.joints.forEach((joint, i) => {
      expect(joint.node.quaternion.angleTo(authored[i])).toBeLessThan(1e-6);
    });
  });

  it('places the base from the free joint, in MuJoCo order (w first)', () => {
    const { root, byName } = buildTree(gltf);
    const mirror = RVMuJoCoJointMirror.fromObject3D(root);
    const qpos = new Float64Array(7 + 14);
    // 90° about MuJoCo z: MuJoCo writes [w, x, y, z].
    const half = Math.SQRT1_2;
    qpos.set([1.5, -0.25, 0.3, half, 0, 0, half], 0);
    mirror.apply(qpos, 0, new Int32Array(14).fill(-1));

    const base = byName.get('trunk_base')!;
    expect(base.position.toArray()).toEqual([1.5, -0.25, 0.3]);
    expect(base.quaternion.x).toBeCloseTo(0, 12);
    expect(base.quaternion.z).toBeCloseTo(half, 12);
    expect(base.quaternion.w).toBeCloseTo(half, 12);
  });

  it('turns MuJoCo Z-up into Three.js Y-up ONCE, at the asset root', () => {
    const { root, byName } = buildTree(gltf);
    const assetRoot = byName.get('rv_duck')!;
    // The root carries −90° about X and nothing else.
    const expected = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    expect(assetRoot.quaternion.angleTo(expected)).toBeLessThan(1e-9);

    const mirror = RVMuJoCoJointMirror.fromObject3D(root);
    const qpos = new Float64Array(7 + 14);
    qpos.set([0, 0, 0.12, 1, 0, 0, 0], 0);
    mirror.apply(qpos, 0, new Int32Array(14).fill(-1));
    root.updateMatrixWorld(true);

    // A base 0.12 m up in MuJoCo (+z) must land 0.12 m up in Three.js (+y) —
    // the contact plane z = 0 and the visible floor y = 0 are the same plane.
    const world = new Vector3();
    byName.get('trunk_base')!.getWorldPosition(world);
    expect(world.y).toBeCloseTo(0.12, 12);
    expect(world.x).toBeCloseTo(0, 12);
    expect(world.z).toBeCloseTo(0, 12);

    // And a step of 1 m along MuJoCo +x stays along Three.js +x.
    qpos[0] = 1;
    mirror.apply(qpos, 0, new Int32Array(14).fill(-1));
    root.updateMatrixWorld(true);
    byName.get('trunk_base')!.getWorldPosition(world);
    expect(world.x).toBeCloseTo(1, 12);
    expect(world.y).toBeCloseTo(0.12, 12);
  });

  it('reports an unusable joint instead of mirroring it wrongly', () => {
    const { root, byName } = buildTree(gltf);
    const victim = byName.get('leg')!;
    victim.userData = {
      rv_joint: { ...(victim.userData.rv_joint as object), pos: [0, 0.01, 0] },
    };
    const mirror = RVMuJoCoJointMirror.fromObject3D(root);
    expect(mirror.joints).toHaveLength(13);
    expect(mirror.skipped).toEqual([{ node: 'leg', reason: 'joint anchor is off-centre (pos != 0)' }]);
  });
});
