import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { computeMeshIslands, resolveWeldResolution, weldVertexIds, DEFAULT_WELD_THRESHOLD } from '../src/core/editor/rv-mesh-separator';

function geo(v: number[]) { const g = new BufferGeometry(); g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3)); return g; }

describe('mesh separator robustness (geometry loss + grid overflow)', () => {
  it('keeps sub-resolution triangles instead of dropping them', () => {
    // island A: a normal triangle + a sub-resolution sliver sharing its corner
    // island B: a normal triangle far away
    const g = geo([
      0,0,0, 1,0,0, 0,1,0,
      0,0,0, 0.000001,0,0, 0,0.000001,0,
      10,0,0, 11,0,0, 10,1,0,
    ]);
    const parts = computeMeshIslands(g, DEFAULT_WELD_THRESHOLD);
    expect(parts.length).toBe(2);
    expect(parts.flat().length).toBe(3);        // no triangle lost
    expect(parts[0]).toEqual([0, 1]);           // sliver joined its island
    expect(parts[1]).toEqual([2]);
  });

  it('separates a model whose coordinates overflow the fixed grid', () => {
    const g = geo([
      500000,0,0, 500001,0,0, 500000,1,0,
      600000,0,0, 600001,0,0, 600000,1,0,
    ]);
    expect(() => weldVertexIds(g, resolveWeldResolution(g))).not.toThrow();
    expect(computeMeshIslands(g).length).toBe(2);
  });

  it('leaves the requested resolution alone for ordinary models', () => {
    const g = geo([0,0,0, 1,0,0, 0,1,0]);
    expect(resolveWeldResolution(g)).toBe(DEFAULT_WELD_THRESHOLD);
  });
});
