// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-724 §9.1 — "does THIS vertex lie on a circle?".
 *
 * ── What is actually at risk here ───────────────────────────────────────────
 * The fitting mathematics is tested by `mechanism-snap-cylinder.test.ts`; what
 * is NEW is the membership question. `computeSnapCandidates` answers "which
 * circle is nearest the hit point" and its loop ids never leave it, so the
 * failure this file guards is a circle that is perfectly well fitted and simply
 * the WRONG one — a plausible pivot, silently 20 mm off.
 *
 * The second half guards the memo. Caching on the vertex id alone looks obvious
 * and is wrong: two circle features can share one welded vertex, and the answer
 * then depends on which surface the ray hit. The rule is therefore
 * mesh + vertexId + "the new faceIndex is still inside the fitted region"
 * (F10), and the recompute across a seam is the test that keeps it honest.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Mesh, PerspectiveCamera, Vector3 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import {
  findCircleThroughVertex, nearestVertexCandidates, VERTEX_SNAP_RADIUS_PX,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-snap';
import {
  getVertexCircleMemoStats, queryVertexCircle, resetVertexCircleMemo,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-circle-vertex-query';
import {
  appendMesh, mantleData, plateWithBores, seamSplitCorner, toGeometry, type MeshData,
} from './helpers/mesh-fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => {
  resetVertexCircleMemo();
  while (cleanups.length) cleanups.pop()!();
});

// ─── Fixture inspection ─────────────────────────────────────────────────────
//
// `findCircleThroughVertex` takes a WELDED vertex id, which is an internal of
// `mechanism-snap.ts`. These helpers reproduce the weld the way the topology
// builder does it — first appearance wins — so a test can name a vertex by its
// POSITION and a face by its triangle number, which is what the fixtures make
// exactly predictable.

function weldRemap(data: MeshData, epsilon = 1e-4): Int32Array {
  const count = data.positions.length / 3;
  const remap = new Int32Array(count);
  const points: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = data.positions[i * 3], y = data.positions[i * 3 + 1], z = data.positions[i * 3 + 2];
    let id = -1;
    for (let k = 0; k < points.length / 3; k++) {
      const dx = points[k * 3] - x, dy = points[k * 3 + 1] - y, dz = points[k * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz <= epsilon * epsilon) { id = k; break; }
    }
    if (id < 0) { id = points.length / 3; points.push(x, y, z); }
    remap[i] = id;
  }
  return remap;
}

/** Welded id of the vertex nearest to `target`. */
function weldedIdNear(data: MeshData, remap: Int32Array, target: Vector3): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < remap.length; i++) {
    const dx = data.positions[i * 3] - target.x;
    const dy = data.positions[i * 3 + 1] - target.y;
    const dz = data.positions[i * 3 + 2] - target.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = remap[i]; }
  }
  return best;
}

/** Raw corner positions of triangle `t`. */
function cornersOf(data: MeshData, t: number): Vector3[] {
  return [0, 1, 2].map((k) => {
    const i = data.indices[t * 3 + k];
    return new Vector3(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]);
  });
}

/** The first triangle that carries welded id `id` and satisfies `accept`. */
function faceWith(
  data: MeshData, remap: Int32Array, id: number, accept: (corners: Vector3[]) => boolean,
): number {
  const triangles = data.indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const ids = [0, 1, 2].map((k) => remap[data.indices[t * 3 + k]]);
    if (!ids.includes(id)) continue;
    if (accept(cornersOf(data, t))) return t;
  }
  throw new Error(`no triangle carries welded id ${id} under the given predicate`);
}

/** A flat 3x3 vertex grid — the one fixture with a genuinely INTERIOR vertex. */
function flatGrid(step = 10): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) positions.push((i - 1) * step, (j - 1) * step, 0);
  }
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const a = j * 3 + i, b = a + 1, c = a + 3, d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions, indices };
}

/**
 * A shallow polygonal "fillet": `strips` flat strips, each turned `stepDeg` from
 * the last. With a step below the 1.5° coplanar tolerance but twice the step
 * above it, the coplanar region a seed grows depends on WHICH strip the seed is
 * — which is exactly the residual the memo rule has to survive (recheck R5).
 */
function shallowFan(strips: number, stepDeg: number, length = 4, halfWidth = 8): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  let x = 0, z = 0;
  positions.push(x, -halfWidth, z, x, halfWidth, z);
  for (let k = 0; k < strips; k++) {
    const angle = (k * stepDeg * Math.PI) / 180;
    x += Math.cos(angle) * length;
    z += Math.sin(angle) * length;
    positions.push(x, -halfWidth, z, x, halfWidth, z);
  }
  for (let k = 0; k < strips; k++) {
    const a = k * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  return { positions, indices };
}

/** A shaft along +Z with a flat cap on top — one rim vertex, two surfaces. */
function cappedShaft(radius: number, height: number, segments = 64): MeshData {
  const out = mantleData({ radiusBottom: radius, height, segments, rings: 4 });
  const cap: MeshData = { positions: [], indices: [] };
  const top = height / 2;
  cap.positions.push(0, 0, top);                                  // fan centre
  for (let s = 0; s < segments; s++) {
    const angle = (s / segments) * Math.PI * 2;
    cap.positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, top);
  }
  for (let s = 0; s < segments; s++) {
    cap.indices.push(0, 1 + s, 1 + ((s + 1) % segments));
  }
  appendMesh(out, cap);
  return out;
}

// ─── The membership question ────────────────────────────────────────────────

describe('findCircleThroughVertex', () => {
  it('returns the bore rim when the vertex lies on that rim', () => {
    const data = plateWithBores({ thickness: 6, bores: [{ x: 0, y: 0, radius: 4 }] });
    const remap = weldRemap(data);
    const rim = weldedIdNear(data, remap, new Vector3(4, 0, 3));
    // A triangle of the TOP FACE (all three corners at z = +3), not of the wall.
    const face = faceWith(data, remap, rim, (c) => c.every((p) => Math.abs(p.z - 3) < 1e-6));

    const result = findCircleThroughVertex(toGeometry(data), face, rim);
    expect(result.circle?.kind).toBe('rim');
    expect(result.circle!.radius).toBeCloseTo(4, 2);
    expect(result.circle!.center[2]).toBeCloseTo(3, 5);
    expect(Math.abs(result.circle!.axis[2])).toBeCloseTo(1, 6);
  });

  it('returns null for a vertex in the middle of a flat face (reason: no-loop)', () => {
    const data = flatGrid();
    // Vertex 4 is the grid's centre — the boundary loop is the outline and does
    // not contain it, which is the whole point of this fixture.
    const result = findCircleThroughVertex(toGeometry(data), 0, 4);
    expect(result.circle).toBeNull();
    expect(result.reason).toBe('no-loop');
    expect(result.regionTriangles).toBe(8);
  });

  it('picks the rim the vertex belongs to, not the nearest rim to the hit point', () => {
    const data = plateWithBores({
      thickness: 6,
      bores: [{ x: -14, y: 0, radius: 3 }, { x: 14, y: 0, radius: 3 }, { x: 0, y: 16, radius: 3 }],
    });
    const remap = weldRemap(data);
    const onA = weldedIdNear(data, remap, new Vector3(-11, 0, 3));   // bore A's rim
    const onB = weldedIdNear(data, remap, new Vector3(17, 0, 3));    // bore B's rim
    // The SEED triangle sits next to bore A; the vertex belongs to bore B. All
    // three rims are boundary loops of the same coplanar face, so only the
    // membership test can tell them apart.
    const nearA = faceWith(data, remap, onA, (c) => c.every((p) => Math.abs(p.z - 3) < 1e-6));

    const result = findCircleThroughVertex(toGeometry(data), nearA, onB);
    expect(result.circle?.kind).toBe('rim');
    expect(result.circle!.center[0]).toBeCloseTo(14, 2);
    expect(result.circle!.center[1]).toBeCloseTo(0, 2);
    expect(result.circle!.radius).toBeCloseTo(3, 2);
  });

  it('returns the cylinder end circle for a vertex on a mantle boundary', () => {
    const data = mantleData({ radiusBottom: 5, height: 10, segments: 64, rings: 4 });
    const remap = weldRemap(data);
    const rim = weldedIdNear(data, remap, new Vector3(5, 0, 5));
    const wall = faceWith(data, remap, rim, () => true);

    const result = findCircleThroughVertex(toGeometry(data), wall, rim);
    expect(result.circle?.kind).toBe('cylinder-end');
    expect(result.circle!.radius).toBeCloseTo(5, 2);
    expect(result.circle!.center[2]).toBeCloseTo(5, 5);
    expect(result.circle!.surface).toBe('shaft');
  });

  it('rejects a partial arc below 300° coverage (reason: coverage)', () => {
    // 200° of mantle: a real cylinder, and exactly the three-quarter arc the
    // hover snap would happily offer — but not a circle a pivot may sit on.
    const data = mantleData({ radiusBottom: 5, height: 10, segments: 64, rings: 4, sweepDeg: 200 });
    const remap = weldRemap(data);
    const angle = (100 * Math.PI) / 180;
    const mid = weldedIdNear(
      data, remap, new Vector3(Math.cos(angle) * 5, Math.sin(angle) * 5, 5));
    const wall = faceWith(data, remap, mid, () => true);

    const result = findCircleThroughVertex(toGeometry(data), wall, mid);
    expect(result.circle).toBeNull();
    expect(result.reason).toBe('coverage');
  });

  it('guards a degenerate seed triangle (reason: degenerate-seed)', () => {
    // Three collinear points: zero area, zero normal. Without the guard this
    // would seed the coplanar BFS and the Jacobi classification with garbage.
    const data: MeshData = { positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] };
    const result = findCircleThroughVertex(toGeometry(data), 0, 0);
    expect(result.circle).toBeNull();
    expect(result.reason).toBe('degenerate-seed');
    expect(result.regionTriangles).toBe(0);
  });

  it('reports regionTriangles far below the mesh triangle count (F9)', () => {
    const data = plateWithBores({
      thickness: 6,
      bores: [
        { x: -18, y: -18, radius: 3 }, { x: 18, y: -18, radius: 3 },
        { x: -18, y: 18, radius: 3 }, { x: 18, y: 18, radius: 3 },
      ],
    });
    const remap = weldRemap(data);
    const total = data.indices.length / 3;
    const rim = weldedIdNear(data, remap, new Vector3(-15, -18, 3));
    // A WALL triangle — the curved branch, whose region is one bore's mantle.
    const wall = faceWith(data, remap, rim, (c) => c.some((p) => Math.abs(p.z - 3) > 1e-6));

    const result = findCircleThroughVertex(toGeometry(data), wall, rim);
    expect(result.circle?.kind).toBe('cylinder-end');
    // Deterministic, not wall-clock: the search visited ONE bore's wall, not the
    // mesh. A regression that widened it to the whole part would show up here
    // long before anyone noticed a stutter.
    expect(result.regionTriangles).toBeGreaterThan(0);
    expect(result.regionTriangles).toBeLessThan(total / 3);
  });
});

// ─── The nearest vertex ─────────────────────────────────────────────────────

describe('nearestVertexCandidates', () => {
  const SEAM = seamSplitCorner();
  const geometry = toGeometry(SEAM);
  /** A plain orthographic projector — 10 px per local unit, y down. */
  const project = (p: Vector3) => ({ x: p.x * 10, y: -p.y * 10 });

  it('prefers a 1-ring neighbour when it is closer in screen space than all three corners', () => {
    // (1,-1) belongs to triangle B only, reached across the shared edge. The
    // cursor sits 2 px from it and 12 px from the nearest corner of triangle A.
    const best = nearestVertexCandidates(geometry, 0, project, { x: 10, y: 12 });
    expect(best).not.toBeNull();
    expect(best!.position.toArray()).toEqual([1, -1, 0]);
    expect(best!.distancePx).toBeCloseTo(2, 6);
  });

  it('resolves a seam-split corner to one welded id', () => {
    // (0,0,0) exists TWICE in the attribute array, once per triangle. Both
    // faces must resolve it to the same welded id, or the marker flickers.
    const fromA = nearestVertexCandidates(geometry, 0, project, { x: 0, y: 0 });
    const fromB = nearestVertexCandidates(geometry, 1, project, { x: 0, y: 0 });
    expect(fromA!.vertexId).toBe(fromB!.vertexId);
    expect(fromA!.position.toArray()).toEqual([0, 0, 0]);
    // Four welded ids out of six attribute vertices.
    expect(fromA!.vertexId).toBeLessThan(4);
  });

  it('breaks a sub-pixel tie deterministically (lower welded id wins)', () => {
    // (1,0) → px (10,0) is welded id 1, (1,-1) → px (10,10) is welded id 3.
    const tie = nearestVertexCandidates(geometry, 0, project, { x: 10, y: 5 });
    expect(tie!.vertexId).toBe(1);
    // …and it stays id 1 when sub-pixel camera noise makes id 3 marginally
    // CLOSER. Without the window the marker would flip here every frame.
    const nudged = nearestVertexCandidates(geometry, 0, project, { x: 10, y: 5.1 });
    expect(nudged!.vertexId).toBe(1);
  });

  it('returns null beyond the 14 px snap radius', () => {
    expect(nearestVertexCandidates(geometry, 0, project, { x: 200, y: 200 })).toBeNull();
    // The boundary itself, straight out along −x where (0,0) is the only
    // candidate in reach: 14 px away still snaps, a hair beyond does not.
    expect(nearestVertexCandidates(
      geometry, 0, project, { x: -VERTEX_SNAP_RADIUS_PX, y: 0 })).not.toBeNull();
    expect(nearestVertexCandidates(
      geometry, 0, project, { x: -VERTEX_SNAP_RADIUS_PX - 0.1, y: 0 })).toBeNull();
  });
});

// ─── The memo (F10) ─────────────────────────────────────────────────────────

const CANVAS_W = 400;
const CANVAS_H = 300;

interface MemoHarness {
  viewer: RVViewer;
  mesh: Mesh;
  camera: PerspectiveCamera;
  /** Canvas pixel of a world point — the canvas sits at (0,0), CSS = buffer size. */
  screenOf: (world: Vector3) => { x: number; y: number };
}

function memoHarness(data: MeshData, cameraPosition = new Vector3(0, 0, 40)): MemoHarness {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${CANVAS_W}px;height:${CANVAS_H}px`;
  document.body.appendChild(canvas);
  cleanups.push(() => canvas.remove());

  const camera = new PerspectiveCamera(50, CANVAS_W / CANVAS_H, 0.1, 1000);
  camera.position.copy(cameraPosition);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const mesh = new Mesh(toGeometry(data));
  mesh.name = 'Part';
  mesh.updateMatrixWorld(true);

  const viewer = { camera, renderer: { domElement: canvas } } as unknown as RVViewer;
  return {
    viewer, mesh, camera,
    screenOf: (world) => {
      const v = world.clone().project(camera);
      return { x: ((v.x + 1) / 2) * CANVAS_W, y: ((1 - v.y) / 2) * CANVAS_H };
    },
  };
}

describe('queryVertexCircle through the part', () => {
  it('reaches a circle on a face the target itself hides', () => {
    // A plate seen obliquely from above: the ray enters through the top face —
    // which offers no vertex within the snap radius here — and leaves through
    // the BOTTOM rim of the bore. With only the front hit examined this hover
    // was simply "nothing"; the x-ray edges now show that rim, so the query has
    // to be able to answer for it.
    const h = memoHarness(
      plateWithBores({ thickness: 6, bores: [{ x: 0, y: 0, radius: 4 }] }),
      new Vector3(0, -30, 40));
    resetVertexCircleMemo();

    const hover = queryVertexCircle(h.viewer, h.mesh, ...pixel(h, new Vector3(0, -4, -3)));
    expect(hover?.circle?.kind).toBe('cylinder-end');
    expect(hover!.worldVertex[2]).toBeCloseTo(-3, 5);   // the far face, not the near one
  });

  it('answers for a mask-0 BatchedMesh source — what every mesh in a Drive is', () => {
    // `rv-batch-table.ts` parks batch sources on `layers.mask = 0` and keeps
    // their geometry and matrixWorld valid on purpose, "for picking". A
    // raycaster cannot reach them through `intersectObject` — its layer test
    // needs a shared bit and mask 0 has none — so the hover has to call
    // `Mesh.raycast` itself. Inside a kinematic assembly this is the normal
    // case, not an edge case.
    const h = memoHarness(plateWithBores({ thickness: 6, bores: [{ x: 0, y: 0, radius: 4 }] }));
    h.mesh.layers.mask = 0;
    resetVertexCircleMemo();

    const hover = queryVertexCircle(h.viewer, h.mesh, ...pixel(h, new Vector3(4.4, 0, 3)));
    expect(hover?.circle?.kind).toBe('rim');
  });

  it('keeps the visible surface when a hidden vertex is merely nearer', () => {
    // The seam case from the memo tests, now with the interior in reach: the
    // smooth far wall carries a vertex practically ON the cursor but no circle,
    // and answering with it would be worse than the front rim it would displace.
    const h = memoHarness(cappedShaft(8, 20), new Vector3(0, -60, 45));
    resetVertexCircleMemo();

    const hover = queryVertexCircle(h.viewer, h.mesh, ...pixel(h, new Vector3(0, -7.2, 10)));
    expect(hover?.circle?.kind).toBe('rim');
  });
});

describe('queryVertexCircle memo (F10)', () => {
  it('reuses the result while the pointer stays inside the fitted region', () => {
    const h = memoHarness(plateWithBores({ thickness: 6, bores: [{ x: 0, y: 0, radius: 4 }] }));
    resetVertexCircleMemo();

    const first = queryVertexCircle(
      h.viewer, h.mesh, ...pixel(h, new Vector3(4.4, 0, 3)));
    expect(first?.circle?.kind).toBe('rim');

    const before = getVertexCircleMemoStats();
    // Still on the same coplanar top face, still nearest to the same rim vertex.
    const second = queryVertexCircle(h.viewer, h.mesh, ...pixel(h, new Vector3(5, 0, 3)));
    const after = getVertexCircleMemoStats();

    expect(second?.vertexId).toBe(first!.vertexId);
    expect(after.hits).toBe(before.hits + 1);
    expect(after.misses).toBe(before.misses);
  });

  it('RECOMPUTES when the face index leaves the region although the vertex id is unchanged', () => {
    // A capped shaft: its top rim vertex belongs to the flat cap AND to the
    // mantle. From an oblique camera the cap is a few pixels above the rim and
    // the wall a few below, so one vertex is reachable from two surfaces —
    // which is the seam a vertex-only memo key would sit straight through.
    const h = memoHarness(cappedShaft(8, 20), new Vector3(0, -60, 45));
    resetVertexCircleMemo();

    const onCap = queryVertexCircle(h.viewer, h.mesh, ...pixel(h, new Vector3(0, -7.2, 10)));
    expect(onCap?.circle?.kind).toBe('rim');

    const before = getVertexCircleMemoStats();
    const onWall = queryVertexCircle(h.viewer, h.mesh, ...pixel(h, new Vector3(0, -8, 9.2)));
    const after = getVertexCircleMemoStats();

    // Same welded vertex, different surface — and therefore a different fit.
    expect(onWall?.vertexId).toBe(onCap!.vertexId);
    expect(onWall?.circle?.kind).toBe('cylinder-end');
    expect(after.misses).toBe(before.misses + 1);
    expect(after.hits).toBe(before.hits);
  });

  it('resetVertexCircleMemo() drops the cached entry', () => {
    const h = memoHarness(plateWithBores({ thickness: 6, bores: [{ x: 0, y: 0, radius: 4 }] }));
    const at = pixel(h, new Vector3(4.4, 0, 3));
    resetVertexCircleMemo();

    expect(queryVertexCircle(h.viewer, h.mesh, ...at)?.circle?.kind).toBe('rim');
    const afterFirst = getVertexCircleMemoStats();
    queryVertexCircle(h.viewer, h.mesh, ...at);
    expect(getVertexCircleMemoStats().hits).toBe(afterFirst.hits + 1);

    resetVertexCircleMemo();
    const beforeThird = getVertexCircleMemoStats();
    queryVertexCircle(h.viewer, h.mesh, ...at);
    expect(getVertexCircleMemoStats().misses).toBe(beforeThird.misses + 1);
    expect(getVertexCircleMemoStats().hits).toBe(beforeThird.hits);
  });

  it('recomputes across a fillet transition where two seeds grow different regions', () => {
    // The narrow residual the recheck named (R5): the coplanar region is grown
    // against the SEED normal, so two seeds a strip apart on a shallow fillet
    // grow DIFFERENT regions. The memo survives it because the region it caches
    // is the one its own seed grew — a face outside it forces a recompute
    // rather than confirming a fit that was never made from there.
    const geometry = toGeometry(shallowFan(8, 1));
    const fromStrip2 = findCircleThroughVertex(geometry, 4, 4);
    const fromStrip4 = findCircleThroughVertex(geometry, 8, 8);

    expect([...fromStrip2.region].sort((a, b) => a - b))
      .not.toEqual([...fromStrip4.region].sort((a, b) => a - b));
    // Strip 4's triangles are outside strip 2's region, so the memo cannot
    // hand strip 2's answer to a sample that landed on strip 4.
    expect(fromStrip2.region.has(8)).toBe(false);
    expect(fromStrip2.region.has(4)).toBe(true);
  });
});

/** Canvas pixel of a world point, as the `(clientX, clientY)` pair the query takes. */
function pixel(h: MemoHarness, world: Vector3): [number, number] {
  const at = h.screenOf(world);
  return [at.x, at.y];
}
