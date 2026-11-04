// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-582 Phase 1 (§2.4, §9.2) — the ROLE pass runs ONCE per bake.
 *
 * Before this split the classification DFS ran twice per `prepareAndBake`: once
 * from `computeSurvival` and once from `bake()`. The pass is now cut in two —
 * `classifyRoles` (roles, mover cut, keep vs chunk, partitions, the
 * `InstancedMesh` triangle count) and `bucketItems` (material buckets, items,
 * chunk keys, boundary inverses) — and the recipe runs the ROLE half once,
 * before the material phase, and hands the result to the bake.
 *
 * ## How the counter is taken (and why not with a spy)
 *
 * `BakeOptions.forceSplit` is evaluated "once per node in the role pass" and
 * NOWHERE else. Counting its calls for one named node therefore counts role
 * DFS passes at the TRUE entry — which is what §9.2 demands, and what a spy on
 * `classifyBakeTree` would have got wrong (that wrapper always answered 1 and
 * proved nothing). Measured with this very fixture:
 *
 *   | code                                   | passes | chunks |
 *   |----------------------------------------|--------|--------|
 *   | before the split (cs 020bde5c)         | **2**  | 5      |
 *   | after  the split                       | **1**  | 5      |
 *
 * ## What the expectations are worth
 *
 * Every number below was READ OFF the pre-split implementation on the identical
 * fixture (same file, pipeline/survival/recipe restored from 020bde5c) and is
 * therefore an equivalence assertion, not a snapshot of the new code:
 * `keep: [belt, edge]`, 13 staged meshes, `instancedTriangles: 96`, 5 chunks.
 *
 * The acceptance criterion of Phase 1 is CORRECTNESS, not speed (§9.3, corrected
 * 2026-10-12): the removed pass is ~5 ms of a 1000–2800 ms bake. What it buys is
 * one place where the role rules have to stay right instead of two.
 */
import { describe, it, expect } from 'vitest';
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Group, InstancedMesh, Line, LineBasicMaterial,
  Matrix4, Mesh, MeshStandardMaterial, Object3D, type Material,
} from 'three';
import '../src/core/engine/rv-scene-loader';   // side effect: capabilities, schemas, built-in hooks
import { classifyBakeTree, classifyRoles } from '../src/core/engine/rv-bake-pipeline';
import { prepareAndBake, prepareMaterials } from '../src/core/engine/rv-prepare-and-bake';
import { RV_PARTITION_KEY } from '../src/core/engine/rv-bake-chunk';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { inlinePickPort, makeTexture } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);
const matA = new MeshStandardMaterial({ color: 0x884422, name: 'A' });
const matB = new MeshStandardMaterial({ color: 0x224488, name: 'B' });

function mesh(name: string, material: Material | Material[] | undefined, pos: [number, number, number] = [0, 0, 0]): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material as Material);
  m.name = name;
  m.position.set(...pos);
  return m;
}

function node(name: string, extras?: Record<string, unknown>, ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  if (extras) g.userData.realvirtual = extras;
  for (const c of children) g.add(c);
  return g;
}

/** An `InstancedMesh` of `count` boxes — 12 triangles each, 6 material groups. */
function instanced(name: string, material: Material | Material[] | undefined, count = 3): InstancedMesh {
  const im = new InstancedMesh(new BoxGeometry(1, 1, 1), material as Material, count);
  im.name = name;
  for (let i = 0; i < count; i++) im.setMatrixAt(i, new Matrix4().makeTranslation(0, i * 5, 0));
  return im;
}

function line(name: string): Line {
  const l = new Line(
    new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3)),
    new LineBasicMaterial(),
  );
  l.name = name;
  return l;
}

/**
 * The whole corpus of §9.2 in one tree: several materials, a partition, a mover,
 * a TransportSurface with a TEXTURED (keep) and an untextured (staged) mesh, the
 * `InstancedMesh` group-validity cases, a mesh without material and a `Line`.
 */
function buildFixture(): Group {
  const root = node('Roles');
  root.add(mesh('Frame', matA));
  root.add(mesh('FrameB', matB, [2, 0, 0]));

  const partitioned = node('Partitioned');
  partitioned.userData[RV_PARTITION_KEY] = ['P1'];
  partitioned.add(mesh('pmesh', matA, [0, 1, 0]));
  root.add(partitioned);

  const mover = node('Drive-M', { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
  mover.add(mesh('arm', matA, [0, 2, 0]));
  root.add(mover);

  // §6c M4: the TransportSurface rule — the textured mesh is `keep` because
  // `cloneScrollableMaps` scrolls its map per instance, the untextured one is
  // staged and the uber pass collects it.
  const transport = node('Transport', { TransportSurface: { Speed: 100 } });
  transport.add(mesh('belt', new MeshStandardMaterial({ map: makeTexture() }), [0, 3, 0]));
  transport.add(mesh('beltPlain', matA, [1, 3, 0]));
  root.add(transport);

  // §6c M5: the group-validity arithmetic of the instanced triangle count.
  root.add(instanced('BoltsSimple', matA));                 // single material → 12 × 3 = 36
  root.add(instanced('BoltsPartialMats', [matA]));          // 6 box groups, only index 0 has a material → 6

  const invalid = instanced('BoltsInvalidGroup', [matA]);
  invalid.geometry.addGroup(0, 36, 5);                      // no material at index 5 → contributes nothing
  root.add(invalid);

  const truncated = instanced('BoltsTruncated', [matA]);
  truncated.geometry.addGroup(0, 7, 0);                     // 7 entries → 2 whole triangles
  root.add(truncated);

  const noGroups = instanced('BoltsNoGroups', [matA]);
  noGroups.geometry.clearGroups();                          // material array, zero groups → whole mesh
  root.add(noGroups);

  const zeroCount = instanced('BoltsZeroGroup', [matA]);
  zeroCount.geometry.clearGroups();
  zeroCount.geometry.addGroup(0, 0, 0);                     // empty material group → nothing
  root.add(zeroCount);

  const noMatInstanced = instanced('BoltsNoMat', undefined);
  noMatInstanced.material = undefined as unknown as Material;
  root.add(noMatInstanced);

  const noMat = mesh('NoMat', matA, [4, 0, 0]);
  noMat.material = undefined as unknown as Material;        // staged, but no item and no triangles
  root.add(noMat);

  root.add(line('edge'));
  return root;
}

interface RoleShape { keep: string[]; staged: string[]; instancedTriangles: number }

function shapeOf(root: Object3D): RoleShape {
  const r = classifyRoles(root);
  return {
    keep: r.keep.map((k) => k.mesh.name).sort(),
    staged: r.staged.map((m) => m.name).sort(),
    instancedTriangles: r.instancedTriangles,
  };
}

/** What the pre-split implementation answered for {@link buildFixture}. */
const BASELINE: RoleShape = {
  keep: ['belt', 'edge'],
  staged: [
    'BoltsInvalidGroup', 'BoltsNoGroups', 'BoltsNoMat', 'BoltsPartialMats', 'BoltsSimple',
    'BoltsTruncated', 'BoltsZeroGroup', 'Frame', 'FrameB', 'NoMat', 'arm', 'beltPlain', 'pmesh',
  ].sort(),
  instancedTriangles: 96,
};

function ctxOf(assetId: string, extra: Record<string, unknown> = {}) {
  return {
    assetId, renamedNodes: new Map<Object3D, string>(), signatureState: 'none' as const,
    uber, isWebGPU: false, pickPort: inlinePickPort(), ...extra,
  };
}

/** Chunk keys with the material uuid of a textured bucket normalized away. */
function stableKeys(keys: readonly string[]): string[] {
  return keys.map((k) => k.replace(/tex:[0-9a-f-]+/i, 'tex:<uuid>')).sort();
}

describe('plan-582 Phase 1 — one role pass per bake (§2.4)', () => {
  it('Test_Bake_RoleClassification_RunsOncePerBake', async () => {
    const root = buildFixture();
    // `forceSplit` is called once per node BY THE ROLE PASS and by nothing
    // else — so the calls for one node ARE the number of role DFS passes.
    let passes = 0;
    const seen: string[] = [];
    const forceSplit = (n: Object3D): boolean => {
      if (n.name === 'Frame') passes++;
      seen.push(n.name);
      return false;
    };
    const asset = await prepareAndBake(root, ctxOf('once-per-bake', { forceSplit }));
    try {
      // Sanity: the predicate really did see the tree (an unreached predicate
      // would make `passes === 0` look like a pass).
      expect(seen).toContain('Frame');
      expect(
        passes,
        'the role DFS must run exactly once per bake — it ran twice before plan-582 '
        + '(computeSurvival + bake), and the recipe now hands `SurvivalModel.roles` to bake()',
      ).toBe(1);
    } finally {
      asset.dispose();
    }
  });

  it('Test_RoleClassification_EqualsTodaysResult', () => {
    expect(shapeOf(buildFixture())).toEqual(BASELINE);
  });

  it('the thin `classifyBakeTree` wrapper reports the same three fields', () => {
    const root = buildFixture();
    const wrapper = classifyBakeTree(root, { uberMaterial: uber });
    const roles = classifyRoles(root);
    expect(wrapper.keep.map((k) => k.name)).toEqual(roles.keep.map((k) => k.mesh.name));
    expect(wrapper.staged).toEqual(roles.staged);
    expect(wrapper.instancedTriangles).toBe(roles.instancedTriangles);
  });

  it('Test_RoleClassification_EdgeCases', () => {
    // Each case in its OWN tree, so the number is attributable (§6c M5).
    const only = (child: Object3D): RoleShape => {
      const root = node('One');
      root.add(child);
      return shapeOf(root);
    };

    // InstancedMesh expansion: 12 triangles × 3 instances.
    expect(only(instanced('i', matA)).instancedTriangles).toBe(36);
    // An ORDINARY mesh contributes nothing — instances are what is counted.
    expect(only(mesh('plain', matA)).instancedTriangles).toBe(0);
    // Mesh without material: staged (it is no keep mesh), but no item, no triangles.
    const noMat = mesh('noMat', matA);
    noMat.material = undefined as unknown as Material;
    expect(only(noMat)).toEqual({ keep: [], staged: ['noMat'], instancedTriangles: 0 });
    // InstancedMesh without material.
    const iNoMat = instanced('iNoMat', undefined);
    iNoMat.material = undefined as unknown as Material;
    expect(only(iNoMat).instancedTriangles).toBe(0);
    // Material array, no groups at all → the whole mesh counts.
    const noGroups = instanced('iNoGroups', [matA]);
    noGroups.geometry.clearGroups();
    expect(only(noGroups).instancedTriangles).toBe(36);
    // EMPTY material group → nothing.
    const zero = instanced('iZero', [matA]);
    zero.geometry.clearGroups();
    zero.geometry.addGroup(0, 0, 0);
    expect(only(zero).instancedTriangles).toBe(0);
    // INVALID material group (materialIndex without material) → nothing; the six
    // box groups still contribute their one valid group (index 0, 6 entries).
    const invalid = instanced('iInvalid', [matA]);
    invalid.geometry.clearGroups();
    invalid.geometry.addGroup(0, 36, 5);
    expect(only(invalid).instancedTriangles).toBe(0);
    // TRUNCATED triangles: 7 entries are 2 whole triangles, the 7th is dropped.
    const truncated = instanced('iTruncated', [matA]);
    truncated.geometry.clearGroups();
    truncated.geometry.addGroup(0, 7, 0);
    expect(only(truncated).instancedTriangles).toBe(6);

    // A TEXTURED mesh under a TransportSurface is a keep mesh, an untextured
    // sibling is staged — the `material.map` rule the role pass is allowed to read.
    const transport = node('Transport', { TransportSurface: { Speed: 100 } });
    transport.add(mesh('belt', new MeshStandardMaterial({ map: makeTexture() })));
    transport.add(mesh('beltPlain', matA, [1, 0, 0]));
    expect(only(transport)).toEqual({ keep: ['belt'], staged: ['beltPlain'], instancedTriangles: 0 });

    // Line / Points / Sprite are never baked.
    expect(only(line('edge'))).toEqual({ keep: ['edge'], staged: [], instancedTriangles: 0 });
  });

  it('Test_RoleClassification_InvariantUnderMaterialPhase', () => {
    // THE core test of §2.4 (§6c M4): the role pass reads `material.map`, so its
    // answer must not change when `dedup → uber` replaces the materials under it.
    // If this ever goes red the handoff is inadmissible and Phase 1 falls — the
    // fix is to revert the handoff, never to relax this assertion.
    const root = buildFixture();
    const before = shapeOf(root);
    const materials = prepareMaterials(root, uber, false);
    const after = shapeOf(root);
    expect(before).toEqual(BASELINE);
    expect(after).toEqual(before);
    // The phase really did something: the untextured meshes went onto the uber
    // material (otherwise the invariance above would be vacuous).
    expect(materials.uber.bakedMeshCount).toBeGreaterThan(0);
    expect(materials.uber.sharedMaterial).not.toBeNull();
    // …and the textured belt kept a map, which is why it is still `keep`.
    const belt = after.keep.find((n) => n === 'belt');
    expect(belt).toBe('belt');
  });

  it('Test_Bake_ChunkCount_UnchangedAfterSplit', async () => {
    // The draw-call contract (`contract-bake-picking.md` § 1.3): a chunk is a
    // boundary × group-combination × material, and the split must not move one.
    // Measured on the pre-split code with this fixture: 5 chunks, these keys.
    const asset = await prepareAndBake(buildFixture(), ctxOf('chunk-count'));
    try {
      expect(stableKeys(asset.chunks.map((c) => c.key))).toEqual([
        'grp:P1', 'mover:Drive-M', 'mover:Transport', 'static', 'tex:<uuid>',
      ]);
      expect(asset.chunks.length).toBe(5);
    } finally {
      asset.dispose();
    }
  });
});
