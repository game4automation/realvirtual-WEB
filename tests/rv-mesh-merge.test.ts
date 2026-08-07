// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mesh merger — classification and geometry core (plan-372 section 9: tests 9.1, 9.2,
 * 9.4, 9.5, 9.6, 9.7, 9.10 and the parts of 9.12 that need no document).
 *
 * The op / executor half lives in `rv-mesh-merge-op.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import {
  MERGE_REASON_MULTI_MATERIAL,
  MERGE_REASON_ONLY_PROTECTED,
  MERGE_REASON_TOO_FEW,
  MeshMergeIncompatibleError,
  bakeIntoTargetSpace,
  bakeMatrixFor,
  bucketKeyOf,
  buildMergedGeometry,
  classifySubtree,
  groupNamesOf,
  isAnchor,
  isConventionName,
  materialFingerprint,
  mergeBucket,
  normalizeBucket,
  protectedReason,
} from '../src/core/editor/rv-mesh-merge';
import { triangleCount as triangleCountOf } from '../src/core/editor/rv-mesh-separator';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** A single triangle at the origin — the smallest usable source geometry. */
function triangleGeometry(offset = 0): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return geom;
}

function addMesh(parent: Object3D, name: string, geom = triangleGeometry(), material?: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geom, material ?? new MeshStandardMaterial({ name: 'Steel', color: 0x336699 }));
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

/** Registry-style path: names joined from the traversal root down. */
function pathOf(node: Object3D): string {
  const parts: string[] = [];
  for (let n: Object3D | null = node; n; n = n.parent) parts.unshift(n.name);
  return parts.join('/');
}

function classify(root: Object3D) {
  root.updateMatrixWorld(true);
  return classifySubtree(root, pathOf);
}

/** World-space face normal of the first triangle of a geometry. */
function faceNormal(geom: BufferGeometry, matrix = new Matrix4()): Vector3 {
  const pos = geom.getAttribute('position');
  const index = geom.index;
  const at = (i: number): Vector3 => {
    const vi = index ? (index.array as ArrayLike<number>)[i] : i;
    return new Vector3(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(matrix);
  };
  const a = at(0); const b = at(1); const c = at(2);
  return b.sub(a).cross(c.sub(a)).normalize();
}

// ─── 9.1 — carriers survive ─────────────────────────────────────────────

describe('9.1 carriers are kept, plain group nodes merge', () => {
  it('keeps a Drive-extras and a Sensor-extras node, merges the rest', () => {
    const root = new Group();
    root.name = 'Assembly';

    const drive = new Object3D();
    drive.name = 'Axis';
    drive.userData['realvirtual'] = { Drive: { Direction: 'LinearX' } };
    root.add(drive);

    const sensor = new Object3D();
    sensor.name = 'Eye';
    sensor.userData['realvirtual'] = { Sensor: {} };
    root.add(sensor);

    // Boilerplate + Group extras must NOT protect — otherwise nothing ever merges.
    const plainA = addMesh(root, 'PartA');
    plainA.userData['realvirtual'] = { layer: 0, tag: 'Untagged', Group: { GroupName: 'Frame' } };
    addMesh(root, 'PartB', triangleGeometry(5));

    const result = classify(root);
    expect(result.ineligibleReason).toBeNull();
    expect(result.candidates.map((c) => c.mesh.name).sort()).toEqual(['PartA', 'PartB']);
    const keptByName = new Map(result.kept.map((k) => [k.node.name, k]));
    expect(keptByName.get('Eye')?.role).toBe('protected');
    // The Drive node is an ANCHOR, not protected — it survives but opens its own zone.
    expect(keptByName.get('Axis')?.role).toBe('anchor');
  });

  it('a protected node exempts its WHOLE subtree', () => {
    const root = new Group();
    root.name = 'Assembly';
    const carrier = new Object3D();
    carrier.name = 'Gripper';
    carrier.userData['realvirtual'] = { Grip: {} };
    root.add(carrier);
    addMesh(carrier, 'Finger');       // inside the protected subtree
    addMesh(root, 'PartA');
    addMesh(root, 'PartB', triangleGeometry(5));

    const result = classify(root);
    expect(result.candidates.map((c) => c.mesh.name).sort()).toEqual(['PartA', 'PartB']);
    expect(result.kept.map((k) => k.node.name)).toEqual(['Gripper']);
  });

  it('reports a subtree that is only carriers', () => {
    const root = new Group();
    root.name = 'Assembly';
    const carrier = new Object3D();
    carrier.name = 'Eye';
    carrier.userData['realvirtual'] = { Sensor: {} };
    root.add(carrier);
    expect(classify(root).ineligibleReason).toBe(MERGE_REASON_ONLY_PROTECTED);
  });

  it('reports a single mergeable mesh as not worth merging', () => {
    const root = new Group();
    root.name = 'Assembly';
    addMesh(root, 'Only');
    expect(classify(root).ineligibleReason).toBe(MERGE_REASON_TOO_FEW);
  });
});

// ─── 9.2 — naming-convention protection ─────────────────────────────────

describe('9.2 naming convention protection (regression gate)', () => {
  it('exempts Transport-Z, Drive-Rot-Y, Sensor and Snap-* WITHOUT any rv_extras', () => {
    for (const name of ['Transport-Z', 'Drive-Rot-Y', 'Sensor', 'Sensor-Infeed', 'Snap-ZP-convroll', 'Carrier-1']) {
      expect(isConventionName(name), name).toBe(true);
      const node = new Object3D();
      node.name = name;
      expect(protectedReason(node), name).toMatch(/naming convention/);
    }
    for (const name of ['Housing', 'Bolt_12', 'Drive', 'Transport']) {
      expect(isConventionName(name), name).toBe(false);
    }
  });

  it('a conveyor library asset survives a merge over its root', () => {
    const root = new Group();
    root.name = 'Conveyor';
    const transport = addMesh(root, 'Transport-Z');
    addMesh(transport, 'Belt');           // inside the protected subtree
    const drive = new Object3D();
    drive.name = 'Drive-Rot-Y';
    root.add(drive);
    addMesh(root, 'Frame');
    addMesh(root, 'Leg', triangleGeometry(3));

    const result = classify(root);
    expect(result.kept.map((k) => k.node.name).sort()).toEqual(['Drive-Rot-Y', 'Transport-Z']);
    expect(result.kept.every((k) => k.role === 'protected')).toBe(true);
    // Only the two nameless parts merge — the belt below Transport-Z is untouched.
    expect(result.candidates.map((c) => c.mesh.name).sort()).toEqual(['Frame', 'Leg']);
  });
});

// ─── 9.3/9.4 — bake and winding ─────────────────────────────────────────

describe('9.3 transform bake', () => {
  it('bakes vertices into owner space and transforms normals exactly ONCE', () => {
    const owner = new Object3D();
    owner.position.set(3, -2, 7);
    owner.rotation.set(0.4, 1.1, -0.7);
    owner.scale.set(2, 1.5, 0.5);
    const source = new Object3D();
    source.position.set(0.25, 1, -0.5);
    source.rotation.set(-0.3, 0.2, 0.9);
    source.scale.set(2, 0.5, 1); // non-uniform, so the normal matrix is not a rotation
    owner.add(source);
    owner.updateMatrixWorld(true);

    const geom = triangleGeometry();
    const worldBefore = new Vector3(1, 0, 0).applyMatrix4(source.matrixWorld);

    const bake = bakeMatrixFor(owner.matrixWorld, source.matrixWorld);
    const baked = bakeIntoTargetSpace(geom, bake);

    const pos = baked.getAttribute('position');
    const worldAfter = new Vector3(pos.getX(1), pos.getY(1), pos.getZ(1)).applyMatrix4(owner.matrixWorld);
    expect(worldAfter.distanceTo(worldBefore)).toBeLessThan(1e-5);

    // The normal must be the source normal through the normal matrix EXACTLY ONCE.
    const normalMatrix = new Matrix3().getNormalMatrix(bake);
    const expected = new Vector3(0, 0, 1).applyMatrix3(normalMatrix).normalize();
    const twice = expected.clone().applyMatrix3(normalMatrix).normalize();
    const n = baked.getAttribute('normal');
    const actual = new Vector3(n.getX(0), n.getY(0), n.getZ(0)).normalize();
    expect(actual.angleTo(expected)).toBeLessThan(1e-4);
    // …and the double-transformed variant (the bug this guards) is measurably elsewhere.
    expect(actual.angleTo(twice)).toBeGreaterThan(1e-2);

    // The source geometry is untouched — the bake works on an independent copy.
    expect(geom.getAttribute('position').getX(1)).toBe(1);
  });

  it('works under a frozen parent (matrixWorldAutoUpdate = false)', () => {
    const owner = new Object3D();
    owner.position.set(1, 2, 3);
    owner.updateMatrixWorld(true);
    owner.matrixAutoUpdate = false;
    owner.matrixWorldAutoUpdate = false;
    const source = new Object3D();
    source.position.set(4, 0, 0);
    owner.add(source);
    source.updateMatrixWorld(true);

    const bake = bakeMatrixFor(owner.matrixWorld, source.matrixWorld);
    const baked = bakeIntoTargetSpace(triangleGeometry(), bake);
    const pos = baked.getAttribute('position');
    expect(pos.getX(0)).toBeCloseTo(4, 6);
  });
});

describe('9.4 winding at a negative determinant', () => {
  it('keeps the winding consistent with the shading normal for a mirrored source', () => {
    const owner = new Object3D();
    owner.updateMatrixWorld(true);
    const source = new Object3D();
    source.scale.set(-1, 1, 1); // mirrored
    owner.add(source);
    owner.updateMatrixWorld(true);

    const geom = triangleGeometry();
    const bake = bakeMatrixFor(owner.matrixWorld, source.matrixWorld);
    expect(bake.determinant()).toBeLessThan(0);
    const baked = bakeIntoTargetSpace(geom, bake);

    // The invariant that "not inside-out" actually means: the geometric winding
    // normal agrees with the (correctly transformed) vertex normal. The renderer
    // used to reconcile the two per mesh via gl.FrontFace; after a merge it cannot.
    const n = baked.getAttribute('normal');
    const shading = new Vector3(n.getX(0), n.getY(0), n.getZ(0)).normalize();
    expect(faceNormal(baked).dot(shading)).toBeGreaterThan(0.99);

    // Proof that the flip is what does it: the same bake without it is antiparallel.
    const unflipped = geom.clone();
    unflipped.applyMatrix4(bake);
    expect(faceNormal(unflipped).dot(shading)).toBeLessThan(-0.99);
  });

  it('inverts the tangent handedness w on a mirrored source', () => {
    const geom = triangleGeometry();
    geom.setAttribute('tangent', new BufferAttribute(new Float32Array([
      1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1,
    ]), 4));
    const mirror = new Matrix4().makeScale(-1, 1, 1);
    const baked = bakeIntoTargetSpace(geom, mirror);
    const tangent = baked.getAttribute('tangent');
    for (let i = 0; i < tangent.count; i++) expect(tangent.getW(i)).toBe(-1);
    // The untouched source keeps its handedness.
    expect(geom.getAttribute('tangent').getW(0)).toBe(1);
  });

  it('flips a non-indexed geometry too — across every attribute', () => {
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]), 3));
    geom.setAttribute('normal', new BufferAttribute(new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]), 3));
    // Distinct UVs so a broken per-attribute swap shows up as a mismatch.
    geom.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));

    const mirror = new Matrix4().makeScale(-1, 1, 1);
    const baked = bakeIntoTargetSpace(geom, mirror);
    const n = baked.getAttribute('normal');
    const shading = new Vector3(n.getX(0), n.getY(0), n.getZ(0)).normalize();
    expect(faceNormal(baked).dot(shading)).toBeGreaterThan(0.99);
    // Vertex 1 and 2 swapped together with their UVs (0,1) ↔ (1,0).
    const uv = baked.getAttribute('uv');
    expect([uv.getX(1), uv.getY(1)]).toEqual([0, 1]);
    expect([uv.getX(2), uv.getY(2)]).toEqual([1, 0]);
  });
});

// ─── 9.5 — bucket semantics ─────────────────────────────────────────────

describe('9.5 bucket semantics', () => {
  it('one mesh with color and one without land in ONE merged geometry', () => {
    const withColor = triangleGeometry();
    withColor.setAttribute('color', new BufferAttribute(new Float32Array([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]), 3));
    const withoutColor = triangleGeometry(5);

    const merged = buildMergedGeometry(
      [
        { geometry: withColor, worldMatrix: new Matrix4() },
        { geometry: withoutColor, worldMatrix: new Matrix4() },
      ],
      new Matrix4(),
    );
    expect(merged.getAttribute('color')).toBeDefined();
    expect(merged.getAttribute('position').count).toBe(6);
    // The synthesised half is white/opaque, not black.
    const color = merged.getAttribute('color');
    expect(color.getX(3)).toBe(1);
    expect(color.getY(3)).toBe(1);
    expect(color.getZ(3)).toBe(1);
  });

  it('synthesises a missing normal via computeVertexNormals', () => {
    const withNormal = triangleGeometry();
    const withoutNormal = new BufferGeometry();
    withoutNormal.setAttribute('position', new BufferAttribute(new Float32Array([
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ]), 3));
    withoutNormal.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
    const geoms = normalizeBucket([withNormal, withoutNormal]);
    expect(geoms[1].getAttribute('normal')).toBeDefined();
    expect(mergeBucket(geoms).getAttribute('position').count).toBe(6);
  });

  it('REFUSES a merge when an itemSize diverges — never a second mesh per material', () => {
    const a = triangleGeometry();
    a.setAttribute('color', new BufferAttribute(new Float32Array(9), 3));
    const b = triangleGeometry(5);
    b.setAttribute('color', new BufferAttribute(new Float32Array(12), 4));
    expect(() => normalizeBucket([a, b])).toThrow(MeshMergeIncompatibleError);
    expect(() => normalizeBucket([a, b])).toThrow(/incompatible layouts/);
  });

  it('REFUSES a merge when a non-reconstructable attribute is missing', () => {
    const a = triangleGeometry();
    a.setAttribute('tangent', new BufferAttribute(new Float32Array(12), 4));
    const b = triangleGeometry(5);
    expect(() => normalizeBucket([a, b])).toThrow(/cannot be reconstructed/);
  });

  it('unifies indexed and non-indexed sources', () => {
    const indexed = triangleGeometry();
    const nonIndexed = new BufferGeometry();
    nonIndexed.setAttribute('position', new BufferAttribute(new Float32Array([
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ]), 3));
    nonIndexed.setAttribute('normal', new BufferAttribute(new Float32Array([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]), 3));
    const geoms = normalizeBucket([indexed, nonIndexed]);
    expect(geoms.every((g) => g.index !== null)).toBe(true);
    expect(triangleCountOf(mergeBucket(geoms))).toBe(2);
  });

  it('mergeBucket throws instead of passing a null geometry on', () => {
    const a = triangleGeometry();
    const b = triangleGeometry(5);
    b.setAttribute('custom', new BufferAttribute(new Float32Array(3), 1));
    expect(() => mergeBucket([a, b])).toThrow(MeshMergeIncompatibleError);
  });

  it('keys buckets by owner, Group set and material — not by attribute layout', () => {
    const key = bucketKeyOf('Asset/Root', ['B', 'A'], 'ffff0000');
    expect(key).toBe('Asset/Root|A,B|ffff0000');
    // Order-independent for the group names.
    expect(bucketKeyOf('Asset/Root', ['A', 'B'], 'ffff0000')).toBe(key);
  });

  it('splits by Group as well as by material (binding user decision)', () => {
    const root = new Group();
    root.name = 'Assembly';
    const shared = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
    const a = addMesh(root, 'A', triangleGeometry(0), shared);
    a.userData['realvirtual'] = { Group: { GroupName: 'Left' } };
    const b = addMesh(root, 'B', triangleGeometry(2), shared);
    b.userData['realvirtual'] = { Group: { GroupName: 'Right' } };
    const c = addMesh(root, 'C', triangleGeometry(4), shared);
    c.userData['realvirtual'] = { Group: { GroupName: 'Right' } };

    const result = classify(root);
    const rootZone = result.zones.find((z) => z.isRoot)!;
    expect(rootZone.buckets).toHaveLength(2);
    expect(rootZone.buckets.map((x) => x.groupNames)).toEqual([['Left'], ['Right']]);
    expect(groupNamesOf(c)).toEqual(['Right']);
  });
});

// ─── 9.6 — index type is three's business ───────────────────────────────

describe('9.6 index type', () => {
  it('picks Uint32 by itself once the merged vertex count exceeds 65 536', () => {
    // 22 000 triangles per source, three sources → 66 000 vertices.
    const make = (offset: number): BufferGeometry => {
      const tris = 22000;
      const pos = new Float32Array(tris * 9);
      for (let t = 0; t < tris; t++) {
        const o = t * 9;
        pos[o] = offset + t; pos[o + 1] = 0; pos[o + 2] = 0;
        pos[o + 3] = offset + t + 0.5; pos[o + 4] = 0; pos[o + 5] = 0;
        pos[o + 6] = offset + t; pos[o + 7] = 1; pos[o + 8] = 0;
      }
      const geom = new BufferGeometry();
      geom.setAttribute('position', new BufferAttribute(pos, 3));
      const idx = new Uint32Array(tris * 3);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      geom.setIndex(new BufferAttribute(idx, 1));
      return geom;
    };
    const merged = mergeBucket(normalizeBucket([make(0), make(1e5), make(2e5)]));
    expect(merged.getAttribute('position').count).toBe(198000);
    expect(merged.index!.array).toBeInstanceOf(Uint32Array);
  });
});

// ─── 9.7 — anchors ──────────────────────────────────────────────────────

describe('9.7 anchor behaviour', () => {
  it('a JTData node survives AND its children merge into its OWN zone', () => {
    const root = new Group();
    root.name = 'Assembly';
    const anchor = new Object3D();
    anchor.name = 'Bracket';
    anchor.userData['realvirtual'] = { JTData: { PartName: 'B-4711' } };
    root.add(anchor);
    addMesh(anchor, 'Shell');
    addMesh(anchor, 'Rib', triangleGeometry(2));
    addMesh(root, 'Base', triangleGeometry(4));
    addMesh(root, 'Cover', triangleGeometry(6));

    const result = classify(root);
    expect(isAnchor(anchor)).toBe(true);
    expect(result.kept.map((k) => k.node.name)).toEqual(['Bracket']);
    expect(result.zones).toHaveLength(2);

    const rootZone = result.zones.find((z) => z.isRoot)!;
    const anchorZone = result.zones.find((z) => z.owner === anchor)!;
    expect(rootZone.buckets.flatMap((b) => b.candidates.map((c) => c.mesh.name)).sort())
      .toEqual(['Base', 'Cover']);
    expect(anchorZone.buckets.flatMap((b) => b.candidates.map((c) => c.mesh.name)).sort())
      .toEqual(['Rib', 'Shell']);
    // Nothing ever shares a bucket across the boundary.
    expect(rootZone.buckets[0].key).not.toBe(anchorZone.buckets[0].key);
  });

  it('treats Kinematic and Drive keys as anchors, CADLink too', () => {
    for (const key of ['Kinematic', 'Drive', 'Drive_1', 'CADLink', 'JTData']) {
      const node = new Object3D();
      node.userData['realvirtual'] = { [key]: {} };
      expect(isAnchor(node), key).toBe(true);
      expect(protectedReason(node), key).toBeNull();
    }
  });
});

// ─── 9.10 — triangle bookkeeping ────────────────────────────────────────

describe('9.10 triangle preservation', () => {
  it('the merged geometry has exactly the sum of the source triangles', () => {
    const sources = [triangleGeometry(0), triangleGeometry(3), triangleGeometry(6)];
    const total = sources.reduce((n, g) => n + triangleCountOf(g), 0);
    const merged = buildMergedGeometry(
      sources.map((geometry) => ({ geometry, worldMatrix: new Matrix4() })),
      new Matrix4(),
    );
    expect(triangleCountOf(merged)).toBe(total);
    expect(merged.boundingSphere).not.toBeNull();
    expect(merged.boundingBox).not.toBeNull();
  });
});

// ─── 9.12 — ineligibility (classification half) ─────────────────────────

describe('9.12 ineligibility', () => {
  it('a multi-material source blocks the whole merge with the separator hint', () => {
    const root = new Group();
    root.name = 'Assembly';
    const geom = triangleGeometry();
    geom.addGroup(0, 3, 0);
    const multi = new Mesh(geom, [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    multi.name = 'Plate';
    root.add(multi);
    addMesh(root, 'Base', triangleGeometry(4));

    const result = classify(root);
    expect(result.ineligibleReason).toBe(MERGE_REASON_MULTI_MATERIAL);
    expect(result.ineligibleReason).toMatch(/Separate/);
  });

  it('an instanced or skinned mesh blocks the merge with its own guard reason', () => {
    const root = new Group();
    root.name = 'Assembly';
    addMesh(root, 'Base');
    const exotic = addMesh(root, 'Bolts', triangleGeometry(4));
    (exotic as unknown as { isInstancedMesh: boolean }).isInstancedMesh = true;
    expect(classify(root).ineligibleReason).toMatch(/Instanced and skinned/);
  });
});

// ─── material fingerprint ───────────────────────────────────────────────

describe('material fingerprint', () => {
  it('is value-based, NOT uuid-based', () => {
    const a = new MeshStandardMaterial({ name: 'Steel', color: 0x336699, metalness: 0.8, roughness: 0.3 });
    const b = new MeshStandardMaterial({ name: 'Steel', color: 0x336699, metalness: 0.8, roughness: 0.3 });
    expect(a.uuid).not.toBe(b.uuid);
    expect(materialFingerprint(a)).toBe(materialFingerprint(b));
  });

  it('separates materials that differ in any hashed property', () => {
    const base = new MeshStandardMaterial({ name: 'Steel', color: 0x336699, metalness: 0.8, roughness: 0.3 });
    const key = materialFingerprint(base);
    const variants = [
      new MeshStandardMaterial({ name: 'Alu', color: 0x336699, metalness: 0.8, roughness: 0.3 }),
      new MeshStandardMaterial({ name: 'Steel', color: 0x996633, metalness: 0.8, roughness: 0.3 }),
      new MeshStandardMaterial({ name: 'Steel', color: 0x336699, metalness: 0.2, roughness: 0.3 }),
      new MeshStandardMaterial({ name: 'Steel', color: 0x336699, metalness: 0.8, roughness: 0.9 }),
      new MeshStandardMaterial({ name: 'Steel', color: 0x336699, metalness: 0.8, roughness: 0.3, transparent: true, opacity: 0.5 }),
    ];
    for (const v of variants) expect(materialFingerprint(v)).not.toBe(key);
  });

  it('tolerates materials without color or metalness', () => {
    expect(() => materialFingerprint({ type: 'MeshNormalMaterial' } as never)).not.toThrow();
    expect(materialFingerprint(null)).toBeTypeOf('string');
  });
});
