// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cad-glb-roundtrip.test.ts — the invariant behind the GLB-first import
 * pipeline: `objectToGlb` → `parseGlbSubtree` preserves everything the editor
 * depends on, so an import and a later reload of the same bytes agree.
 *
 * Guards, in order of how badly each would bite:
 *   1. occt's per-face colour bake (normalized Uint8 COLOR_0 + one shared
 *      vertexColors material) survives with the right VALUES — glTF stores
 *      COLOR_0 as linear, so this is where a colour-space shift would hide.
 *   2. Node names: purely-sanitized names (`Part.1`) come back verbatim via
 *      detectRenamedNodes; genuine collisions get a deterministic `_N`.
 *   3. No synthetic wrapper leaks through (GLTFExporter's `AuxScene`), and the
 *      content root keeps its own transform — `importCad` records that transform
 *      and `reimportCad` copies the old placement onto it.
 *   4. Determinism: the same bytes parsed twice give the same names/paths, which
 *      is what makes the asset op log (name-path addressed) stable across F5.
 */

import { describe, it, expect } from 'vitest';
import { Group, Mesh, Object3D, BufferAttribute } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { parseGlbSubtree } from '../src/core/engine/rv-glb-parse';
import { buildMesh, normalizeStepRoot, type OcctMeshData } from '@rv-private/plugins/step-import/occt-to-three';

/** A two-triangle occt body: each B-Rep face owns a private vertex block. */
function occtTwoFaceBody(): OcctMeshData {
  return {
    name: 'Body.1',
    color: [0.5, 0.5, 0.5], // body colour — overwritten on both coloured faces
    brep_faces: [
      { first: 0, last: 0, color: [1, 0, 0] }, // triangle 0 → red
      { first: 1, last: 1, color: [0, 0, 1] }, // triangle 1 → blue
    ],
    attributes: {
      position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0, /**/ 2, 0, 0, 3, 0, 0, 2, 1, 0] },
      normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1, /**/ 0, 0, 1, 0, 0, 1, 0, 0, 1] },
    },
    index: { array: [0, 1, 2, 3, 4, 5] },
  };
}

function firstMesh(root: Object3D): Mesh {
  let found: Mesh | null = null;
  root.traverse((n) => { if (!found && (n as Mesh).isMesh) found = n as Mesh; });
  if (!found) throw new Error('no mesh in parsed tree');
  return found;
}

/** Every node name in traversal order. */
function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

describe('objectToGlb → parseGlbSubtree (the GLB-first invariant)', () => {
  it('round-trips occt per-face vertex colours with correct values', async () => {
    const mesh = buildMesh(occtTwoFaceBody());
    // Precondition: the bake produced a normalized Uint8 COLOR_0, not groups.
    const src = mesh.geometry.getAttribute('color') as BufferAttribute;
    expect(src).toBeTruthy();
    expect(src.normalized).toBe(true);
    expect(mesh.geometry.groups.length).toBe(0);

    const parsed = await parseGlbSubtree(await objectToGlb(mesh));
    const out = firstMesh(parsed);
    const dst = out.geometry.getAttribute('color') as BufferAttribute;

    expect(dst).toBeTruthy();
    expect((out.material as { vertexColors: boolean }).vertexColors).toBe(true);
    expect(dst.count).toBe(src.count);

    // getX/getY/getZ de-normalize, so both sides are comparable in 0..1.
    for (let i = 0; i < src.count; i++) {
      expect(dst.getX(i)).toBeCloseTo(src.getX(i), 2);
      expect(dst.getY(i)).toBeCloseTo(src.getY(i), 2);
      expect(dst.getZ(i)).toBeCloseTo(src.getZ(i), 2);
    }
    // And the two faces really are different colours (the bake wasn't flattened).
    expect(dst.getX(0)).toBeCloseTo(1, 2); // red face
    expect(dst.getZ(0)).toBeCloseTo(0, 2);
    expect(dst.getX(3)).toBeCloseTo(0, 2); // blue face
    expect(dst.getZ(3)).toBeCloseTo(1, 2);
  });

  it('restores purely-sanitized node names (Part.1 stays Part.1)', async () => {
    const root = new Group();
    root.name = 'Assembly';
    for (const n of ['Part.1', 'Shaft 2', 'Plain']) {
      const child = new Object3D();
      child.name = n;
      root.add(child);
    }

    const parsed = await parseGlbSubtree(await objectToGlb(root));
    expect(names(parsed)).toEqual(['Assembly', 'Part.1', 'Shaft 2', 'Plain']);
  });

  it('keeps the content root (no AuxScene wrapper) and its normalize transform', async () => {
    // What threeToGlb hands the exporter: mm→m + Z-up→Y-up baked on the root.
    const content = new Group();
    content.name = 'Gearbox';
    content.add(buildMesh(occtTwoFaceBody()), buildMesh(occtTwoFaceBody()));
    const glb = await objectToGlb(normalizeStepRoot(content));

    const parsed = await parseGlbSubtree(glb);

    // GLTFExporter wraps a non-Scene input in a synthetic Scene named
    // 'AuxScene'. If that leaked through, the root's transform would sit one
    // level down and importCad would record an identity transform instead.
    expect(parsed.name).toBe('Gearbox');
    expect(parsed.scale.x).toBeCloseTo(0.001, 6);
    expect(parsed.rotation.x).toBeCloseTo(-Math.PI / 2, 6);
  });

  it('is deterministic: the same bytes parse to the same names twice', async () => {
    // Duplicate names across different parents — glTF dedups globally, three
    // appends `_N`. Whatever it picks must be stable, because the asset op log
    // addresses nodes by name-path.
    const root = new Group();
    root.name = 'Root';
    for (const parentName of ['A', 'B']) {
      const parent = new Group();
      parent.name = parentName;
      const screw = new Object3D();
      screw.name = 'Screw';
      parent.add(screw);
      root.add(parent);
    }

    const glb = await objectToGlb(root);
    const first = names(await parseGlbSubtree(glb));
    const second = names(await parseGlbSubtree(glb));
    expect(second).toEqual(first);
    // Both instances survive as distinct nodes (no silent collapse onto one).
    expect(first.filter((n) => n.startsWith('Screw'))).toHaveLength(2);
  });
});
