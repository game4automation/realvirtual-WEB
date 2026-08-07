// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Texture } from 'three';
import { computeMaterialStats, formatBytes } from '../src/plugins/asset-editor/materials/material-stats';

function meshWith(name: string, mat: MeshStandardMaterial): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), mat);
  m.name = name;
  return m;
}

function texture(w: number, h: number, src: string): Texture {
  const t = new Texture();
  t.image = { width: w, height: h, src };
  return t;
}

describe('computeMaterialStats', () => {
  it('returns an empty summary for a null root', () => {
    const s = computeMaterialStats(null);
    expect(s.materialCount).toBe(0);
    expect(s.warnings).toEqual([]);
  });

  it('counts materials and meshes', () => {
    const root = new Group();
    root.name = 'Asset';
    root.add(meshWith('a', new MeshStandardMaterial({ color: 0xff0000 })));
    root.add(meshWith('b', new MeshStandardMaterial({ color: 0x00ff00 })));
    const s = computeMaterialStats(root);
    expect(s.meshCount).toBe(2);
    expect(s.materialCount).toBe(2);
    expect(s.uniqueByAppearance).toBe(2);
  });

  it('flags two distinct but identical-looking materials as duplicates', () => {
    const root = new Group();
    root.name = 'Asset';
    root.add(meshWith('a', new MeshStandardMaterial({ color: 0x808080, roughness: 0.5 })));
    root.add(meshWith('b', new MeshStandardMaterial({ color: 0x808080, roughness: 0.5 })));
    const s = computeMaterialStats(root);
    expect(s.materialCount).toBe(2);
    expect(s.uniqueByAppearance).toBe(1);
    const dup = s.warnings.find(w => w.id === 'duplicate-materials');
    expect(dup).toBeDefined();
    expect(dup!.label).toContain('1 duplicate material');
    expect(dup!.meshPaths.length).toBe(2);
  });

  it('does not flag duplicates when one material is shared', () => {
    const root = new Group();
    root.name = 'Asset';
    const shared = new MeshStandardMaterial({ color: 0x808080 });
    root.add(meshWith('a', shared));
    root.add(meshWith('b', shared));
    const s = computeMaterialStats(root);
    expect(s.materialCount).toBe(1);
    expect(s.warnings.find(w => w.id === 'duplicate-materials')).toBeUndefined();
  });

  it('flags non-power-of-two and oversized textures', () => {
    const root = new Group();
    root.name = 'Asset';
    const mat = new MeshStandardMaterial();
    mat.map = texture(1000, 1000, 'npot.png');
    mat.normalMap = texture(4096, 4096, 'big.png');
    root.add(meshWith('a', mat));
    const s = computeMaterialStats(root);
    expect(s.textureCount).toBe(2);
    expect(s.warnings.find(w => w.id === 'npot-textures')).toBeDefined();
    expect(s.warnings.find(w => w.id === 'oversized-textures')).toBeDefined();
  });

  it('flags transparency that has no visual effect', () => {
    const root = new Group();
    root.name = 'Asset';
    root.add(meshWith('a', new MeshStandardMaterial({ transparent: true, opacity: 1 })));
    const s = computeMaterialStats(root);
    expect(s.warnings.find(w => w.id === 'pointless-transparency')).toBeDefined();
  });

  it('skips runtime helper subtrees', () => {
    const root = new Group();
    root.name = 'Asset';
    root.add(meshWith('_highlightOverlay', new MeshStandardMaterial()));
    expect(computeMaterialStats(root).meshCount).toBe(0);
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
