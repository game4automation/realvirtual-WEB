// plan-659 Phase 3 (bridge to a demo scene) — does a Drive-carrying joint node
// survive the destructive bake?
//
// The measured Phase-2 blocker: loading `rv-duck.glb` into the viewer leaves a
// scene with `rv_duck_scene` + `static` only. The 23 nodes carry
// `extras.rv_joint` / `extras.rv_sensor` / `extras.rv_mjcf_body` — OUR keys, at
// the TOP level of `extras`. The bake's survival model looks at
// `userData.realvirtual` (the rv component map) and at nothing else, so none of
// those nodes claims itself and all their geometry merges into one chunk.
//
// This file measures both halves on the PRODUCTION bake with a tree that has
// exactly the duck's shape (23 nodes, 20 meshes, the same extras keys):
//
//   A) as exported today  → only the root survives, 1 chunk, 0 addressable joints
//   B) + `realvirtual: { Drive: … }` on the 14 joint nodes → all 14 survive as
//      chunk BOUNDARIES with their own chunk mesh, i.e. addressable and movable.
//
// Run:  node scripts/with-test-lock.mjs vitest run -c spikes/659/vitest.config.ts spikes/659/duck-bake-survival.node.test.ts
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import '@rv/core/engine/rv-scene-loader'; // side effect: capabilities + schemas
import { runPreBakeHooks, buildPreBakeRegistry } from '@rv/core/engine/rv-pre-bake';
import { computeSurvival } from '@rv/core/engine/rv-bake-survival';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '@rv/core/engine/rv-bake-registry';
import { getCapabilities } from '@rv/core/engine/rv-component-registry';
import { bakeAndPlace } from '../../tests/fixtures/bake-fixture';

const mat = new MeshStandardMaterial({ color: 0xd02a66, name: 'duck' });

/** The duck's joint list, read from `rv-duck.glb` (build-duck.mjs rig order). */
const JOINTS: ReadonlyArray<{ node: string; joint: string; standDeg: number }> = [
  { node: 'yaw2roll', joint: 'left_hip_yaw', standDeg: 0 },
  { node: 'hip_l', joint: 'left_hip_roll', standDeg: -5 },
  { node: 'upper_leg_left', joint: 'left_hip_pitch', standDeg: -26.24 },
  { node: 'leg', joint: 'left_knee', standDeg: -0.28 },
  { node: 'ankle_left', joint: 'left_ankle', standDeg: 25.95 },
  { node: 'neck', joint: 'neck_pitch', standDeg: 20 },
  { node: 'neck_pitch', joint: 'head_pitch', standDeg: 20 },
  { node: 'yaw_roll_motion', joint: 'head_yaw', standDeg: 0 },
  { node: 'jaw_soft', joint: 'head_roll', standDeg: 0 },
  { node: 'bearing_roll', joint: 'right_hip_yaw', standDeg: 0 },
  { node: 'hip_l_2', joint: 'right_hip_roll', standDeg: 5 },
  { node: 'upper_leg_right', joint: 'right_hip_pitch', standDeg: 26.24 },
  { node: 'leg_2', joint: 'right_knee', standDeg: 0.28 },
  { node: 'ankle_right', joint: 'right_ankle', standDeg: -25.95 },
];

const SENSORS = ['imu', 'left_foot', 'head_camera', 'tof', 'head_imu', 'mouth_tip', 'right_foot'];

/** Nodes 16–19 and 22 have a marker mesh; `head_imu` / `mouth_tip` do not. */
const SENSORS_WITH_MESH = new Set(['imu', 'left_foot', 'head_camera', 'tof', 'right_foot']);

const report: Record<string, unknown> = {
  plan: 659, phase: 3, part: 'bake-survival',
  measured: new Date().toISOString().slice(0, 10),
};

afterAll(() => {
  writeFileSync(
    resolve(__dirname, 'phase3-bake-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
});

/**
 * A tree with the duck's topology: root → trunk_base → a chain per joint, plus
 * the sensor sites. `withDrives` adds the one thing the GLB is missing.
 */
function buildDuckLikeTree(withDrives: boolean, virtualDriveOnBase: boolean): Object3D {
  const mk = (name: string, extras: Record<string, unknown>, hasMesh: boolean): Object3D => {
    const o: Object3D = hasMesh ? new Mesh(new BoxGeometry(0.02, 0.02, 0.05), mat) : new Group();
    o.name = name;
    Object.assign(o.userData, extras);
    return o;
  };

  const root = new Group();
  root.name = 'rv_duck';
  root.userData.rv_asset = { name: 'rv-duck' };

  const trunkExtras: Record<string, unknown> = {
    rv_mjcf_body: 'trunk_base',
    rv_free_joint: { trunk_height: 0.12 },
  };
  if (virtualDriveOnBase) {
    // A `Virtual` drive claims the node and makes it a chunk boundary, but
    // `applyToNode()` returns early for it (rv-drive.ts:1392) — so the mirror's
    // own write of the free-joint pose is never fought over.
    trunkExtras.realvirtual = { Drive: { Direction: 'Virtual' } };
  }
  const trunk = mk('trunk_base', trunkExtras, true);
  root.add(trunk);

  // The real file is two legs + a neck chain off the trunk; for survival the
  // exact branching is irrelevant, the CLAIMS are what count. Chain them so
  // ancestor survival is exercised too.
  let parent: Object3D = trunk;
  for (const j of JOINTS) {
    const extras: Record<string, unknown> = {
      rv_mjcf_body: j.node,
      rv_joint: { name: j.joint, type: 'hinge', axis: [0, 0, 1], stand_angle: j.standDeg * Math.PI / 180 },
    };
    if (withDrives) {
      // THE missing claim. `Direction` + `ReverseDirection` reproduce the
      // mirror's `rest ⊗ R([0,0,1], q)` exactly: RotationZ maps to the glTF
      // axis (0,0,-1), reversed to (0,0,+1) — the MJCF joint axis of all 14
      // duck joints. `Offset` carries the authored STAND angle out, so
      // `currentPosition` is the raw joint angle in degrees.
      extras.realvirtual = {
        Drive: {
          Direction: 'RotationZ',
          ReverseDirection: true,
          Offset: -j.standDeg,
          UseLimits: false,
        },
      };
    }
    const n = mk(j.node, extras, true);
    parent.add(n);
    parent = n;
  }
  for (const s of SENSORS) {
    trunk.add(mk(s, { rv_sensor: { name: s } }, SENSORS_WITH_MESH.has(s)));
  }
  return root;
}

/** Stage like the loader (`computeNodePath` starts at the root's own name). */
function staged<T extends Object3D>(root: T): T {
  const holder = new Object3D();
  holder.name = '_rvLoadStaging';
  holder.add(root);
  return root;
}

interface NodeFate {
  survives: boolean;
  reason: string;
  role: string;
  /** Chunk meshes parented UNDER this node in the template — its own geometry. */
  ownChunkMeshes: number;
}

async function measure(withDrives: boolean, opts: { virtualDriveOnBase?: boolean } = {}) {
  const root = staged(buildDuckLikeTree(withDrives, opts.virtualDriveOnBase ?? false));
  const names = new Set<string>();
  root.traverse((n) => { if (n.name) names.add(n.name); });

  runPreBakeHooks(root);
  const survival = computeSurvival(root, buildPreBakeRegistry(root));
  const find = (name: string): Object3D | null => {
    let found: Object3D | null = null;
    root.traverse((n) => { if (!found && n.name === name) found = n; });
    return found;
  };
  const survivingJoints = JOINTS
    .filter((j) => { const n = find(j.node); return n ? survival.survives(n) : false; })
    .map((j) => j.node);
  const reasons: Record<string, string> = {};
  for (const j of JOINTS) {
    const n = find(j.node);
    if (n) reasons[j.node] = `${survival.reasonOf(n) ?? 'removed'}/${survival.roleOf(n) ?? 'unclaimed'}`;
  }

  const { baked, template } = await bakeAndPlace(root, new BakeRegistry(), {
    survives: survival.survives,
    incomingRoles: survival.incoming,
  });

  const inTemplate: string[] = [];
  let chunkMeshes = 0;
  template.traverse((n) => {
    if (n.name) inTemplate.push(n.name);
    if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) chunkMeshes++;
  });

  const inTemplateByName = (name: string): Object3D | null => {
    let found: Object3D | null = null;
    template.traverse((n) => { if (!found && n.name === name) found = n; });
    return found;
  };
  const fateOf = (name: string): NodeFate => {
    const src = find(name);
    const tpl = inTemplateByName(name);
    return {
      survives: src ? survival.survives(src) : false,
      reason: (src && survival.reasonOf(src)) || 'removed',
      role: (src && survival.roleOf(src)) || 'unclaimed',
      ownChunkMeshes: tpl
        ? tpl.children.filter((c) => c.userData?.[RV_BAKE_CHUNK_KEY] === true).length
        : 0,
    };
  };

  return {
    sourceNodes: survival.counts.nodes,
    survivors: survival.counts.survivors,
    removed: survival.counts.removed,
    distinctSourceNames: names.size,
    survivingJoints,
    jointReasons: reasons,
    templateNames: inTemplate,
    chunkMeshes,
    chunkCount: baked.chunks.length,
    fateOf,
  };
}

describe('Phase 3 bridge — the destructive bake and the duck', () => {
  it('Drive is a chunk BOUNDARY and claims its node (registry, not folklore)', () => {
    const caps = getCapabilities('Drive');
    expect(caps.bake).toBe('chunk');
    expect(caps.claimsNode).toBe(true);
  });

  it('as exported today: NOT ONE of the 14 joints survives', async () => {
    const m = await measure(false);
    expect(m.survivingJoints).toEqual([]);
    // Every joint node is gone from the baked template; its triangles live on
    // inside the root's chunk.
    for (const j of JOINTS) expect(m.templateNames).not.toContain(j.node);
    expect(m.templateNames).not.toContain('trunk_base');
    report.asExportedToday = m;
  });

  it('with a Drive on each joint node: ALL 14 survive as their own chunk', async () => {
    const m = await measure(true);
    expect(m.survivingJoints).toEqual(JOINTS.map((j) => j.node));
    for (const j of JOINTS) expect(m.templateNames).toContain(j.node);
    // Each Drive is a boundary, so each joint owns a chunk mesh that can move,
    // be hidden and be picked on its own.
    expect(m.chunkMeshes).toBeGreaterThanOrEqual(JOINTS.length);
    for (const j of JOINTS) {
      const f = m.fateOf(j.node);
      expect(f.role, j.node).toBe('chunk');
      expect(f.ownChunkMeshes, j.node).toBeGreaterThanOrEqual(1);
    }
    report.withDrivesOnJoints = {
      ...m,
      fates: Object.fromEntries(JOINTS.map((j) => [j.node, m.fateOf(j.node)])),
      fateOf: undefined,
    };
  });

  it('the floating base survives as an ANCESTOR, but loses its own geometry', async () => {
    const m = await measure(true);
    const base = m.fateOf('trunk_base');
    // Rule 2: an ancestor of a survivor survives, so the base NODE is there and
    // its transform (the free joint's 6 DoF) can be written by the mirror…
    expect(base.survives).toBe(true);
    // …but it claims NOTHING (`rv_free_joint` is our key, invisible to the
    // bake), so it is no boundary and its own trunk geometry merged upward: a
    // move of this node would leave those triangles behind.
    expect(base.role).toBe('unclaimed');
    expect(base.ownChunkMeshes).toBe(0);

    // The 7 sensor sites are gone entirely: `rv_sensor` is not
    // `realvirtual.WebSensor`.
    for (const s of SENSORS) {
      expect(m.fateOf(s).survives, s).toBe(false);
      expect(m.templateNames).not.toContain(s);
    }
    report.baseAndSensorsWithDrivesOnJoints = { trunk_base: base, sensorsRemoved: SENSORS };
  });

  it('a `Drive { Direction: Virtual }` on the base makes it a boundary with its own chunk', async () => {
    const m = await measure(true, { virtualDriveOnBase: true });
    const base = m.fateOf('trunk_base');
    expect(base.survives).toBe(true);
    expect(base.role).toBe('chunk');
    expect(base.ownChunkMeshes).toBeGreaterThanOrEqual(1);
    report.baseWithVirtualDrive = base;
  });
});
