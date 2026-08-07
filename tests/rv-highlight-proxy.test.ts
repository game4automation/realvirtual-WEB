// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProxyOverlayProvider — §4.2 zero-copy drawRange highlight proxies.
 *
 * Synthetic RaycastGroups (hand-built quads with known face/edge counts):
 * one quad = 4 verts, 2 coplanar triangles sharing a diagonal — the edge
 * arena keeps exactly the 4 boundary edges (diagonal dot=1 > cos 30 deg).
 *
 * Under test:
 *   - face-window derivation (leaf, ancestor merge, multi-group span);
 *   - DFS-contiguity assertion (violation: canHandle false + warn);
 *   - fill proxy drawRange values + SHARED (===) position attribute;
 *   - edge arena segment windows (monotonic, hand-computable counts);
 *   - pooling on release() (second acquire reuses the wrapper object);
 *   - overlay object contracts on every proxy.
 */
import { describe, it, expect, vi } from 'vitest';
import { Object3D, Mesh, BufferGeometry, BufferAttribute } from 'three';
import {
  ProxyOverlayProvider,
  deriveFaceWindow,
} from '../src/core/engine/rv-highlight-proxy';
import type { PathResolver } from '../src/core/engine/rv-highlight-proxy';
import type {
  RaycastGeometrySet,
  RaycastGroup,
  FaceRange,
} from '../src/core/engine/rv-raycast-geometry';
import type { HighlightStyle } from '../src/core/engine/rv-highlight-manager';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';

// ─── Fixtures ───────────────────────────────────────────────────────

const STYLE: HighlightStyle = {
  overlayColor: 0x4aa3ff,
  overlayOpacity: 0.1,
  overlayWireframe: false,
  edgeColor: 0x4aa3ff,
  edgeOpacity: 0.4,
  showOverlay: true,
  showEdges: true,
};

/**
 * Build a merged RaycastGroup: per entry quadCount unit quads (2 faces
 * each), all offset so no positions coincide across quads. Mesh is added
 * under parent, mirroring the builders in rv-raycast-geometry.ts.
 */
function buildGroup(
  entries: { path: string; quadCount: number }[],
  parent: Object3D,
): RaycastGroup {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceRanges: FaceRange[] = [];
  let face = 0;
  let quadNo = 0;
  for (const { path, quadCount } of entries) {
    const startFace = face;
    for (let q = 0; q < quadCount; q++, quadNo++) {
      const base = positions.length / 3;
      const ox = quadNo * 10; // separate quads — no accidental welding
      positions.push(ox, 0, 0, ox + 1, 0, 0, ox + 1, 1, 0, ox, 1, 0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      face += 2;
    }
    faceRanges.push({ startFace, endFace: face, objectPath: path });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  const mesh = new Mesh(geometry);
  mesh.name = '__raycastBVH_test';
  mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  parent.add(mesh);
  // `sources` feeds only the transform-refit fast path — irrelevant here.
  return { mesh, faceRanges, sources: [] };
}

/** Standard fixture: static group (A / B-x / B-y) + one kinematic group (K). */
function makeFixture() {
  const modelRoot = new Object3D();
  const driveNode = new Object3D();
  modelRoot.add(driveNode);

  const staticGroup = buildGroup(
    [
      { path: 'Root/A', quadCount: 1 },   // faces [0,2)  -> segs [0,4)
      { path: 'Root/B/x', quadCount: 1 }, // faces [2,4)  -> segs [4,8)
      { path: 'Root/B/y', quadCount: 1 }, // faces [4,6)  -> segs [8,12)
    ],
    modelRoot,
  );
  const kinGroup = buildGroup([{ path: 'Root/K', quadCount: 1 }], driveNode);

  const set: RaycastGeometrySet = {
    staticGroup,
    kinematicGroups: new Map([[driveNode, kinGroup]]),
  };

  const nodeA = new Object3D();
  const nodeB = new Object3D();
  const nodeRoot = new Object3D();
  const nodeK = new Object3D();
  const paths = new Map<Object3D, string>([
    [nodeA, 'Root/A'],
    [nodeB, 'Root/B'],
    [nodeRoot, 'Root'],
    [nodeK, 'Root/K'],
  ]);
  const registry: PathResolver = {
    getPathForNode: (n) => paths.get(n) ?? null,
  };

  const provider = new ProxyOverlayProvider(registry, set);
  return { provider, set, staticGroup, kinGroup, modelRoot, driveNode, nodeA, nodeB, nodeRoot, nodeK };
}

function fillsOf(parent: Object3D): Mesh[] {
  return parent.children.filter((c) => c.name === '__hlProxyFill') as Mesh[];
}
function edgesOf(parent: Object3D): Object3D[] {
  return parent.children.filter((c) => c.name === '__hlProxyEdge');
}

// ─── deriveFaceWindow (pure) ────────────────────────────────────────

describe('deriveFaceWindow', () => {
  const ranges: FaceRange[] = [
    { startFace: 0, endFace: 2, objectPath: 'Root/A' },
    { startFace: 2, endFace: 4, objectPath: 'Root/B/x' },
    { startFace: 4, endFace: 6, objectPath: 'Root/B/y' },
  ];

  it('derives a leaf path window', () => {
    expect(deriveFaceWindow(ranges, 'Root/A'))
      .toEqual({ startFace: 0, endFace: 2, firstRange: 0, lastRange: 0 });
  });

  it('merges consecutive ranges for an ancestor path', () => {
    expect(deriveFaceWindow(ranges, 'Root/B'))
      .toEqual({ startFace: 2, endFace: 6, firstRange: 1, lastRange: 2 });
  });

  it('merges the whole table for the common root', () => {
    expect(deriveFaceWindow(ranges, 'Root'))
      .toEqual({ startFace: 0, endFace: 6, firstRange: 0, lastRange: 2 });
  });

  it('returns null for an uncovered path', () => {
    expect(deriveFaceWindow(ranges, 'Root/Z')).toBeNull();
  });

  it('does not prefix-match sibling names sharing a prefix string', () => {
    // 'Root/B' must NOT match a hypothetical 'Root/Bx' (needs the / boundary)
    const tricky: FaceRange[] = [{ startFace: 0, endFace: 2, objectPath: 'Root/Bx' }];
    expect(deriveFaceWindow(tricky, 'Root/B')).toBeNull();
  });

  it('flags non-contiguous matches as a violation', () => {
    const broken: FaceRange[] = [
      { startFace: 0, endFace: 2, objectPath: 'Root/C' },
      { startFace: 2, endFace: 4, objectPath: 'Root/D' },
      { startFace: 4, endFace: 6, objectPath: 'Root/C' },
    ];
    expect(deriveFaceWindow(broken, 'Root/C')).toBe('violation');
  });
});

// ─── canHandle gating ───────────────────────────────────────────────

describe('ProxyOverlayProvider — canHandle', () => {
  it('is false before the edge arena is ready, true after', async () => {
    const { provider, nodeA } = makeFixture();
    expect(provider.canHandle(nodeA)).toBe(false); // arena pending -> legacy path
    provider.startEdgeArenaBuild();
    await provider.whenReady;
    expect(provider.canHandle(nodeA)).toBe(true);
  });

  it('is false for unregistered nodes', async () => {
    const { provider } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;
    expect(provider.canHandle(new Object3D())).toBe(false);
  });

  it('requires ALL contributing groups ready for a multi-group span', async () => {
    const { provider, set, staticGroup, kinGroup, nodeRoot } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;
    expect(provider.isReady(staticGroup)).toBe(true);
    expect(provider.isReady(kinGroup)).toBe(true);
    expect(set.kinematicGroups.size).toBe(1);
    expect(provider.canHandle(nodeRoot)).toBe(true);
  });

  it('contiguity violation: canHandle false + console.warn (never a throw)', async () => {
    const modelRoot = new Object3D();
    // Hand-built NON-contiguous table (C, D, C) — violates the DFS invariant.
    const group = buildGroup(
      [
        { path: 'Root/C', quadCount: 1 },
        { path: 'Root/D', quadCount: 1 },
        { path: 'Root/C', quadCount: 1 },
      ],
      modelRoot,
    );
    const nodeC = new Object3D();
    const registry: PathResolver = {
      getPathForNode: (n) => (n === nodeC ? 'Root/C' : null),
    };
    const set: RaycastGeometrySet = { staticGroup: group, kinematicGroups: new Map() };
    const provider = new ProxyOverlayProvider(registry, set);
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(provider.canHandle(nodeC)).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain('non-contiguous');
      // Cached: a second query neither warns again nor throws.
      expect(provider.canHandle(nodeC)).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── Fill proxies ───────────────────────────────────────────────────

describe('ProxyOverlayProvider — fill proxies', () => {
  it('sets drawRange to the face window (start*3, count*3) and SHARES the position attribute', async () => {
    const { provider, staticGroup, modelRoot, nodeB } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    provider.acquire(nodeB, 'hover', STYLE);
    const fills = fillsOf(modelRoot);
    expect(fills.length).toBe(1);
    const geo = fills[0].geometry;
    // 'Root/B' = ranges x+y = faces [2,6): start 2*3=6, count 4*3=12
    expect(geo.drawRange).toEqual({ start: 6, count: 12 });
    // ZERO-COPY: identical attribute + index instances, never copies
    expect(geo.getAttribute('position')).toBe(staticGroup.mesh.geometry.getAttribute('position'));
    expect(geo.getIndex()).toBe(staticGroup.mesh.geometry.getIndex());
    expect(geo.boundingSphere).not.toBeNull();
  });

  it('spans multiple groups: proxies parented exactly like each group BVH mesh', async () => {
    const { provider, modelRoot, driveNode, nodeRoot } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    provider.acquire(nodeRoot, 'selection', STYLE);
    // Static window [0,6) under modelRoot, kinematic window [0,2) under driveNode
    expect(fillsOf(modelRoot).length).toBe(1);
    expect(fillsOf(driveNode).length).toBe(1);
    expect(fillsOf(modelRoot)[0].geometry.drawRange).toEqual({ start: 0, count: 18 });
    expect(fillsOf(driveNode)[0].geometry.drawRange).toEqual({ start: 0, count: 6 });
  });

  it('respects showOverlay / showEdges', async () => {
    const { provider, modelRoot, nodeA } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    provider.acquire(nodeA, 'hover', { ...STYLE, showEdges: false });
    expect(fillsOf(modelRoot).length).toBe(1);
    expect(edgesOf(modelRoot).length).toBe(0);

    provider.acquire(nodeA, 'hover', { ...STYLE, showOverlay: false });
    expect(edgesOf(modelRoot).length).toBe(1);
    expect(fillsOf(modelRoot).length).toBe(1); // still the first acquire's fill
  });
});

// ─── Edge arena + edge proxies ──────────────────────────────────────

describe('ProxyOverlayProvider — edge arena', () => {
  it('maps face ranges to contiguous segment windows (4 boundary edges per quad)', async () => {
    const { provider, staticGroup, modelRoot, nodeA, nodeB } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    provider.acquire(nodeA, 'hover', STYLE);
    provider.acquire(nodeB, 'selection', STYLE);
    const edges = edgesOf(modelRoot) as Mesh[];
    expect(edges.length).toBe(2);

    // Every quad contributes exactly 4 boundary segments; the coplanar
    // diagonal is dropped (dot = 1 > cos 30 deg). Static arena = 3 quads
    // = 12 segments = 24 index entries.
    const arena = edges[0].geometry.getIndex();
    expect(arena).not.toBeNull();
    expect(arena!.count).toBe(24);
    expect(edges[1].geometry.getIndex()).toBe(arena); // ONE arena per group

    // 'Root/A' -> segs [0,4): drawRange (0, 8); 'Root/B' -> segs [4,12): (8, 16)
    expect(edges[0].geometry.drawRange).toEqual({ start: 0, count: 8 });
    expect(edges[1].geometry.drawRange).toEqual({ start: 8, count: 16 });
    // Windows are monotonic, non-overlapping, and total the arena length.
    expect(0 + 8 + 16).toBe(arena!.count);

    // Segments reference the SHARED position attribute (original indices).
    expect(edges[0].geometry.getAttribute('position'))
      .toBe(staticGroup.mesh.geometry.getAttribute('position'));
  });
});

// ─── Pooling + release ──────────────────────────────────────────────

describe('ProxyOverlayProvider — pooling', () => {
  it('release() removes proxies from the scene and pools the wrappers', async () => {
    const { provider, modelRoot, nodeA } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    const handle = provider.acquire(nodeA, 'hover', STYLE);
    const fill = fillsOf(modelRoot)[0];
    const edge = edgesOf(modelRoot)[0];
    expect(fill).toBeDefined();
    expect(edge).toBeDefined();

    handle.release();
    expect(fill.parent).toBeNull();
    expect(edge.parent).toBeNull();
    handle.release(); // idempotent

    const handle2 = provider.acquire(nodeA, 'hover', STYLE);
    expect(fillsOf(modelRoot)[0]).toBe(fill); // SAME wrapper object reused
    expect(edgesOf(modelRoot)[0]).toBe(edge);
    handle2.release();
  });

  it('dispose() removes live proxies and further acquires are no-ops', async () => {
    const { provider, modelRoot, nodeA } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    provider.acquire(nodeA, 'hover', STYLE);
    expect(fillsOf(modelRoot).length).toBe(1);
    provider.dispose();
    expect(fillsOf(modelRoot).length).toBe(0);
    expect(provider.canHandle(nodeA)).toBe(false);
    provider.acquire(nodeA, 'hover', STYLE);
    expect(fillsOf(modelRoot).length).toBe(0);
  });
});

// ─── Overlay object contracts ───────────────────────────────────────

describe('ProxyOverlayProvider — overlay contracts', () => {
  it('every proxy satisfies the doc-render-picking overlay contract', async () => {
    const { provider, modelRoot, nodeA } = makeFixture();
    provider.startEdgeArenaBuild();
    await provider.whenReady;

    provider.acquire(nodeA, 'hover', STYLE);
    const proxies = [...fillsOf(modelRoot), ...edgesOf(modelRoot)] as Mesh[];
    expect(proxies.length).toBe(2);
    for (const p of proxies) {
      expect(p.userData._highlightOverlay).toBe(true);
      expect(p.layers.mask).toBe(1 << HIGHLIGHT_OVERLAY_LAYER);
      expect(p.frustumCulled).toBe(false);
      expect(p.matrixAutoUpdate).toBe(false);
      expect(p.geometry.boundingSphere).not.toBeNull();
      const mat = p.material as { depthTest: boolean; depthWrite: boolean; transparent: boolean };
      expect(mat.depthTest).toBe(false);
      expect(mat.depthWrite).toBe(false);
      expect(mat.transparent).toBe(true);
      // raycast noop — never a pick target
      const hits: unknown[] = [];
      (p.raycast as (r: unknown, i: unknown[]) => void)({}, hits);
      expect(hits.length).toBe(0);
    }
  });
});
