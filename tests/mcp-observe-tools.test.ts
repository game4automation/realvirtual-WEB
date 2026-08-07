// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { eigenSymmetric3, analyzeShapePoints } from '../src/plugins/mcp-bridge/rv-shape-descriptor';
import { runSceneQuery, idmaskColor, buildQueryLib } from '../src/plugins/mcp-bridge/rv-mcp-observe-tools';
import { buildSceneSnapshot, type SceneNodeSnapshot } from '../src/plugins/mcp-bridge/rv-scene-snapshot';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── eigen / shape math ─────────────────────────────────────────────────

describe('eigenSymmetric3', () => {
  it('recovers the eigenvalues of a diagonal matrix, descending', () => {
    const { values, vectors } = eigenSymmetric3([[4, 0, 0], [0, 1, 0], [0, 0, 9]]);
    expect(values.map((v) => +v.toFixed(6))).toEqual([9, 4, 1]);
    // Strongest eigenvector points along z (sign-agnostic).
    expect(Math.abs(vectors[0][2])).toBeCloseTo(1, 5);
  });
});

function cylinderPoints(radius: number, length: number, axis: 'x' | 'y' | 'z', n = 4000): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * length - length / 2;
    const a = (i * 2.399963) % (Math.PI * 2);
    const u = radius * Math.cos(a);
    const w = radius * Math.sin(a);
    if (axis === 'x') pts.push(t, u, w);
    else if (axis === 'y') pts.push(u, t, w);
    else pts.push(u, w, t);
  }
  return pts;
}

describe('analyzeShapePoints', () => {
  it('classifies a long thin cylinder along X with the right functional axis', () => {
    const d = analyzeShapePoints(cylinderPoints(0.05, 2, 'x'));
    expect(d.shapeClass).toBe('cylinder-like');
    expect(Math.abs(d.functionalAxis![0])).toBeGreaterThan(0.99);
    expect(d.extents[0]).toBeGreaterThan(1.8);
  });

  it('classifies a thin plate with the normal as functional axis', () => {
    const pts: number[] = [];
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        pts.push(i / 40 - 0.5, (Math.sin(i * 7 + j) * 0.005), j / 40 - 0.5);
      }
    }
    const d = analyzeShapePoints(pts);
    expect(['plate-like', 'disc-like']).toContain(d.shapeClass);
    expect(Math.abs(d.functionalAxis![1])).toBeGreaterThan(0.99); // normal ≈ Y
  });

  it('classifies a cube point cloud as compact with no functional axis', () => {
    const pts: number[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) for (let k = 0; k < 12; k++) {
      pts.push(i / 12 - 0.5, j / 12 - 0.5, k / 12 - 0.5);
    }
    const d = analyzeShapePoints(pts);
    expect(d.shapeClass).toBe('compact');
    expect(d.functionalAxis).toBeNull();
  });

  it('returns degenerate for tiny clouds', () => {
    expect(analyzeShapePoints([0, 0, 0, 1, 1, 1]).shapeClass).toBe('degenerate');
  });
});

// ─── read-only scene query ──────────────────────────────────────────────

function fakeSnapshot(): SceneNodeSnapshot[] {
  const mk = (path: string, size: [number, number, number], cy: number, color: string | null): SceneNodeSnapshot => ({
    path, name: path.split('/').pop()!, depth: 1, parentPath: null,
    components: [], isMesh: true, meshCount: 1, triangles: 12,
    bounds: {
      center: [0, cy, 0], size,
      min: [-size[0] / 2, cy - size[1] / 2, -size[2] / 2],
      max: [size[0] / 2, cy + size[1] / 2, size[2] / 2],
    },
    material: color ? { name: 'm', color, metalness: 0, roughness: 0.5, opacity: 1 } : null,
    visible: true,
  });
  return [
    mk('A/Big', [2, 2, 2], 1, '#ff0000'),
    mk('A/Small', [0.1, 0.1, 0.1], 0.05, '#00ff00'),
    mk('A/Low', [1.5, 0.2, 1.5], 0.1, null),
  ];
}

describe('runSceneQuery', () => {
  it('filters with the lib helpers', () => {
    const result = runSceneQuery(
      'nodes.filter(n => lib.maxDim(n) > 1 && n.bounds.center[1] < 0.5).map(n => n.path)',
      fakeSnapshot(),
    );
    expect(result).toEqual(['A/Low']);
  });

  it('supports statement bodies with return', () => {
    const result = runSceneQuery('const r = nodes.length; return r * 2;', fakeSnapshot());
    expect(result).toBe(6);
  });

  it('cannot mutate the frozen snapshot (strict mode throws)', () => {
    const snap = fakeSnapshot();
    Object.freeze(snap);
    snap.forEach((n) => { Object.freeze(n); Object.freeze(n.bounds); });
    expect(() => runSceneQuery('nodes[0].path = "hacked"; return 1;', snap)).toThrow();
    expect(snap[0].path).toBe('A/Big');
  });

  it('lib.centerDist measures between snapshot nodes', () => {
    const lib = buildQueryLib();
    const [a, , c] = fakeSnapshot();
    expect(lib.centerDist(a, c)).toBeCloseTo(0.9, 5);
  });
});

// ─── idmask palette ─────────────────────────────────────────────────────

describe('idmaskColor', () => {
  it('produces distinct colors for the first 24 groups', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) seen.add(idmaskColor(i).getHexString());
    expect(seen.size).toBe(24);
  });
});

// ─── scene snapshot ─────────────────────────────────────────────────────

function makeViewerWithScene(): { viewer: RVViewer; root: Group } {
  const root = new Group();
  root.name = 'Model';
  const sub = new Group();
  sub.name = 'Sub';
  const m1 = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#ff0000' }));
  m1.name = 'Box';
  m1.position.set(2, 0.5, 0);
  const m2 = new Mesh(new CylinderGeometry(0.1, 0.1, 3), new MeshStandardMaterial({ color: '#0000ff' }));
  m2.name = 'Rod';
  sub.add(m1, m2);
  root.add(sub);
  root.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  registry.registerNode('Model', root);
  registry.registerNode('Model/Sub', sub);
  registry.registerNode('Model/Sub/Box', m1);
  registry.registerNode('Model/Sub/Rod', m2);
  const viewer = { registry, currentModelRoot: root } as unknown as RVViewer;
  return { viewer, root };
}

describe('buildSceneSnapshot', () => {
  it('aggregates bounds, mesh counts and triangles bottom-up in one pass', () => {
    const { viewer } = makeViewerWithScene();
    const snap = buildSceneSnapshot(viewer);
    const byPath = new Map(snap.map((s) => [s.path, s]));
    const rootSnap = byPath.get('Model')!;
    expect(rootSnap.meshCount).toBe(2);
    expect(rootSnap.triangles).toBeGreaterThan(0);
    // Union spans the offset box (x≈2.5) and the tall rod (y≈1.5).
    expect(rootSnap.bounds!.max[0]).toBeCloseTo(2.5, 2);
    expect(rootSnap.bounds!.max[1]).toBeCloseTo(1.5, 2);
    const box = byPath.get('Model/Sub/Box')!;
    expect(box.isMesh).toBe(true);
    expect(box.material!.color).toBe('#ff0000');
    expect(box.bounds!.size[0]).toBeCloseTo(1, 3);
    const sub = byPath.get('Model/Sub')!;
    expect(sub.isMesh).toBe(false);
    expect(sub.meshCount).toBe(2);
  });

  it('scopes to a subtree root path', () => {
    const { viewer } = makeViewerWithScene();
    const snap = buildSceneSnapshot(viewer, 'Model/Sub/Box');
    expect(snap.map((s) => s.path)).toEqual(['Model/Sub/Box']);
  });
});
