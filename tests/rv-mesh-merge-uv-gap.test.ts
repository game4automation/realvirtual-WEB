// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 Phase 1 — merge diagnosis: a textured bucket that mixes sources with
 * and without `uv` is reported instead of being zero-filled silently.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, DataTexture, Group, Mesh, MeshStandardMaterial, RGBAFormat } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { classifySubtree, materialHasTextureMap } from '../src/core/editor/rv-mesh-merge';
import { reportMergeUVGaps } from '../src/core/editor/rv-asset-document';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

function tex(): DataTexture { return new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat); }

function cell(textured: boolean, stripFirstUV: boolean, stripAll = false): Group {
  const root = new Group(); root.name = 'Cell';
  const mat = new MeshStandardMaterial({ name: 'Mantle', ...(textured ? { map: tex() } : {}) });
  for (let i = 0; i < 3; i++) {
    const g = new BoxGeometry(1, 1, 1);
    if ((stripFirstUV && i === 0) || stripAll) g.deleteAttribute('uv');
    const m = new Mesh(g, mat); m.name = `Part${i}`; m.position.x = i * 2;
    root.add(m);
  }
  return root;
}

const pathOf = (n: import('three').Object3D): string => NodeRegistry.computeNodePath(n);

beforeEach(() => resetProblemsForTests());

describe('plan-675 merge UV diagnosis', () => {
  it('a textured bucket with one source without uv is a gap', () => {
    const c = classifySubtree(cell(true, true), pathOf);
    expect(c.uvGaps).toHaveLength(1);
    expect(c.uvGaps[0].missing.map((m) => m.name)).toEqual(['Part0']);
    expect(c.uvGaps[0].total).toBe(3);
    reportMergeUVGaps('Cell', c);
    const p = getProblems().filter((x) => x.code === 'merge-uv-missing');
    expect(p).toHaveLength(1);
    expect(p[0].detail).toMatch(/Part0/);
    expect(p[0].detail).toMatch(/editor\.generateUVs/);
  });

  it('no gap: untextured material, all sources with uv, or all without (nothing would sample a texture differently)', () => {
    expect(classifySubtree(cell(false, true), pathOf).uvGaps).toHaveLength(0);
    expect(classifySubtree(cell(true, false), pathOf).uvGaps).toHaveLength(0);
    expect(classifySubtree(cell(true, false, true), pathOf).uvGaps).toHaveLength(0);
  });

  it('materialHasTextureMap looks at every map slot', () => {
    expect(materialHasTextureMap(new MeshStandardMaterial())).toBe(false);
    expect(materialHasTextureMap(new MeshStandardMaterial({ normalMap: tex() }))).toBe(true);
    expect(materialHasTextureMap(new MeshStandardMaterial({ roughnessMap: tex() }))).toBe(true);
  });
});
