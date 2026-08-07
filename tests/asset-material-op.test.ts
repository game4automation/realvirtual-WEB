// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import {
  collectPaintableMeshes, materialToValue, materialForValue, materialValueKey,
  indexMeshPathsByMaterialValue,
} from '../src/core/editor/rv-asset-material';
import { canCoalesceAssetOps, mergeAssetOps, describeAssetOp, classifyAssetOpRaycastImpact } from '../src/core/editor/rv-asset-ops';
import type { SetMaterialOp, MaterialValue } from '../src/core/editor/rv-asset-ops';

const STEEL: MaterialValue = {
  name: 'Steel', color: '#8a8f94', metalness: 1, roughness: 0.45,
  opacity: 1, transparent: false,
};

function mesh(name: string, mat: MeshStandardMaterial): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), mat);
  m.name = name;
  return m;
}

function op(over: Partial<SetMaterialOp> = {}): SetMaterialOp {
  return {
    id: 'op_1', ts: 1000, schemaV: 1, kind: 'setMaterial',
    nodePaths: ['Asset/Part'], material: STEEL,
    prev: [{ meshPath: 'Asset/Part', material: null }],
    ...over,
  } as SetMaterialOp;
}

describe('material values', () => {
  it('round-trips an untextured standard material', () => {
    const mat = materialForValue(STEEL);
    const back = materialToValue(mat);
    expect(back).not.toBeNull();
    expect(back!.color).toBe('#8a8f94');
    expect(back!.metalness).toBeCloseTo(1);
    expect(back!.roughness).toBeCloseTo(0.45);
  });

  it('refuses to describe a textured material as a value', () => {
    const mat = new MeshStandardMaterial();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mat.map = {} as any;
    expect(materialToValue(mat)).toBeNull();
  });

  it('returns ONE shared instance per distinct value', () => {
    expect(materialForValue(STEEL)).toBe(materialForValue({ ...STEEL }));
    expect(materialForValue(STEEL)).not.toBe(materialForValue({ ...STEEL, roughness: 0.9 }));
  });

  it('treats opacity below 1 as transparent even without the flag', () => {
    const mat = materialForValue({ ...STEEL, opacity: 0.3, transparent: false });
    expect(mat.transparent).toBe(true);
  });

  it('keys ignore the display name', () => {
    expect(materialValueKey(STEEL)).toBe(materialValueKey({ ...STEEL, name: 'Other' }));
  });
});

describe('collectPaintableMeshes', () => {
  it('collects descendants but skips helpers and multi-material meshes', () => {
    const root = new Group();
    root.name = 'Asset';
    root.add(mesh('a', new MeshStandardMaterial()));
    const child = new Group();
    child.name = 'sub';
    child.add(mesh('b', new MeshStandardMaterial()));
    root.add(child);
    root.add(mesh('_overlay', new MeshStandardMaterial()));
    const multi = new Mesh(new BoxGeometry(), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    multi.name = 'multi';
    root.add(multi);
    const names = collectPaintableMeshes(root).map(m => m.name).sort();
    expect(names).toEqual(['a', 'b']);
  });
});

describe('setMaterial op semantics', () => {
  it('coalesces consecutive edits over the same selection', () => {
    const a = op();
    const b = op({ id: 'op_2', ts: 1100, material: { ...STEEL, roughness: 0.8 } });
    expect(canCoalesceAssetOps(a, b)).toBe(true);
    const merged = mergeAssetOps(a, b) as SetMaterialOp;
    // Forward payload from the later op, inverse payload from the earlier one.
    expect(merged.material.roughness).toBe(0.8);
    expect(merged.prev).toBe(a.prev);
    expect(merged.id).toBe('op_1');
  });

  it('does not coalesce across different selections', () => {
    const a = op();
    const b = op({ id: 'op_2', ts: 1100, nodePaths: ['Asset/Other'] });
    expect(canCoalesceAssetOps(a, b)).toBe(false);
  });

  it('does not coalesce outside the time window', () => {
    expect(canCoalesceAssetOps(op(), op({ id: 'op_2', ts: 99000 }))).toBe(false);
  });

  it('never invalidates the pick BVH', () => {
    const impact = classifyAssetOpRaycastImpact(op());
    expect(impact.rebuild).toBe(false);
    expect(impact.refitPaths).toEqual([]);
  });

  it('describes itself with the material name and mesh count', () => {
    expect(describeAssetOp(op())).toBe('Material Steel (1 mesh)');
    const many = op({ prev: [
      { meshPath: 'a', material: null },
      { meshPath: 'b', material: null },
    ] });
    expect(describeAssetOp(many)).toBe('Material Steel (2 meshes)');
  });
});

describe('indexMeshPathsByMaterialValue', () => {
  it('groups mesh paths by the value-key of their material', () => {
    const root = new Group();
    root.name = 'Asset';
    const grey = new MeshStandardMaterial({ color: 0x808080, roughness: 0.5 });
    // Two parts share the grey instance; a third is red.
    root.add(mesh('a', grey));
    root.add(mesh('b', grey));
    root.add(mesh('c', new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 })));

    const index = indexMeshPathsByMaterialValue(root);
    const greyKey = materialValueKey(materialToValue(grey)!);
    expect(index.get(greyKey)?.length).toBe(2);
    expect([...index.values()].reduce((n, p) => n + p.length, 0)).toBe(3);
  });

  it('omits textured meshes (a flat preset cannot match them)', () => {
    const root = new Group();
    root.name = 'Asset';
    const mat = new MeshStandardMaterial();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mat.map = {} as any;
    root.add(mesh('a', mat));
    expect(indexMeshPathsByMaterialValue(root).size).toBe(0);
  });

  it('returns an empty index for a null root', () => {
    expect(indexMeshPathsByMaterialValue(null).size).toBe(0);
  });
});
