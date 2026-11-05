// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { buildRuntimeStageTree } from '../src/core/usd/runtime-stage-export';
import { SiblingNameAllocator, sanitizePrimName, RESERVED_PRIM_NAMES } from '../src/core/usd/usd-prim-names';

describe('sibling USD names', () => {
  it('transliterates, sanitizes leading digits and supplies an empty-name default', () => {
    expect(sanitizePrimName('Ärger Öl süß')).toBe('AergerOelsuess');
    expect(sanitizePrimName('12 a!')).toBe('_12a'); expect(sanitizePrimName('!')).toBe('Object');
  });
  it('names are independent by parent, duplicates start at 2, reserved names at 1', () => {
    const a = {}, b = {}, alloc = new SiblingNameAllocator();
    expect(alloc.allocate(a, 'Body')).toBe('Body'); expect(alloc.allocate(b, 'Body')).toBe('Body');
    expect(alloc.allocate(a, 'Body')).toBe('Body_2'); expect(alloc.allocate(a, 'Body_2')).toBe('Body_2_2');
    for (const n of RESERVED_PRIM_NAMES) expect(alloc.allocate(a, n)).toBe(`${n}_1`);
  });
  it('snapshot placeholders are global but final paths are sibling-local and deterministic', () => {
    const root = new Object3D(); root.name = 'Cell';
    for (const name of ['A', 'B']) {
      const p = new Object3D(); p.name = name; root.add(p);
      for (const childName of ['Body', 'Body', 'Geometry']) { const c = new Object3D(); c.name = childName; p.add(c); }
    }
    const input = { root, templates: [], exclude: new Set<Object3D>(), preplaced: [] };
    const a = buildRuntimeStageTree(input, { primNames: 'sibling' }), b = buildRuntimeStageTree(input, { primNames: 'sibling' });
    expect(a.finalNames).toEqual(['Cell', 'A', 'Body', 'Body_2', 'Geometry_1', 'B', 'Body', 'Body_2', 'Geometry_1']);
    expect(a.finalNames).toEqual(b.finalNames); expect(a.primPaths).toEqual(b.primPaths);
    const names: string[] = []; a.scene.children[0].traverse((n) => names.push(n.name));
    expect(names).toEqual(a.nodes.map((_, i) => `_rvN${i}`));
    expect(a.primPaths[6]).toBe('/Root/Scenes/Scene/Cell/B/Body');
    expect(root.name).toBe('Cell'); expect(root.children[0].children[0].name).toBe('Body');
    const global = buildRuntimeStageTree(input);
    expect(global.finalNames).toBeUndefined();
    expect(global.primPaths[6]).toBe('/Root/Scenes/Scene/Cell/B/Body_2');
  });
});
