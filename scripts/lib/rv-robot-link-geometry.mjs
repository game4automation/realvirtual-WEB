// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-link-geometry.mjs — what a link's own geometry says about it
 * (plan-673 Phase 4b).
 *
 * Three measurements per body, all expressed in the BODY's own local frame and
 * in millimetres, which is the frame and the unit every component this plan
 * authors uses (`CollisionShapeSet.Center`/`Size`, `MechanismBody.ComOverride`):
 *
 *   - `halfMm` / `centreMm` — the axis-aligned bounding box. That box IS the
 *     authored collision primitive: one convex box per body, no inflation and no
 *     judgement call. A capsule would fit a cobot's round arms better, but its
 *     radius has to be CHOSEN from the box (max of the two smaller half extents
 *     under-covers the corners, the diagonal over-covers by up to 41 %), and a
 *     chosen number with no measurement behind it is the thing this plan avoids.
 *
 *   - `shellVolumeMm3` — the divergence-theorem volume of the triangle soup.
 *     This is the ENVELOPE volume (a hollow housing counts as full), which is
 *     exactly what a per-link mass wants when the datasheet fixes the sum.
 *
 *   - `boundaryEdges` — how many directed edges do NOT appear exactly twice, at
 *     several weld tolerances. This is the EVIDENCE, not a detail: a closed
 *     surface nets to zero at every tolerance, and
 *     `computeLinkMassProperties` refuses a non-closed one and falls back to the
 *     bounding box. Reporting the count per tolerance is what separates "the CAD
 *     shells are genuinely open" from "the weld tolerance is finer than the
 *     Draco position quantisation" — measured on the CRX library part, the count
 *     does not drop to zero at ANY tolerance, so the shells are open.
 *
 * Ownership follows `collectOwnedMeshes` (rv-mechanism-mass-props.ts): a body
 * owns its subtree minus every other body's subtree.
 */

import { Box3, Matrix4, Vector3 } from 'three';

/** Weld tolerances the boundary-edge count is reported at, in millimetres. */
export const WELD_TOLERANCES_MM = [0.0001, 0.001, 0.01, 0.1, 1];

/** Meshes `body` owns: its subtree, cut at every other body. */
export function ownedMeshes(body, allBodies) {
  const blockers = new Set(allBodies.filter((n) => n !== body));
  const out = [];
  const walk = (n) => {
    if (n !== body && blockers.has(n)) return;
    if (n.isMesh && n.geometry?.getAttribute('position')) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(body);
  return out;
}

function forEachOwnedTriangle(body, meshes, cb) {
  const toBodyMm = new Matrix4().copy(body.matrixWorld).invert()
    .premultiply(new Matrix4().makeScale(1000, 1000, 1000));
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let triangles = 0;
  for (const mesh of meshes) {
    const m = new Matrix4().multiplyMatrices(toBodyMm, mesh.matrixWorld);
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex();
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      cb(a, b, c);
      triangles++;
    }
  }
  return triangles;
}

/** Directed edges that do not cancel, at one weld tolerance (mm). 0 = closed. */
function boundaryEdgeCount(body, meshes, toleranceMm) {
  const q = 1 / toleranceMm;
  const key = (v) => `${Math.round(v.x * q)},${Math.round(v.y * q)},${Math.round(v.z * q)}`;
  const use = new Map();
  forEachOwnedTriangle(body, meshes, (a, b, c) => {
    const ka = key(a);
    const kb = key(b);
    const kc = key(c);
    for (const [from, to] of [[ka, kb], [kb, kc], [kc, ka]]) {
      const f = `${from}|${to}`;
      const r = `${to}|${from}`;
      use.set(f, (use.get(f) ?? 0) + 1);
      use.set(r, (use.get(r) ?? 0) - 1);
    }
  });
  let bad = 0;
  for (const v of use.values()) if (v !== 0) bad++;
  return bad;
}

/**
 * Measure one body: bounding box, envelope volume and the closedness evidence.
 *
 * @param {import('three').Object3D} body
 * @param {readonly import('three').Object3D[]} allBodies
 * @param {{ weld?: boolean }} [opts] `weld: false` skips the (slower) boundary-edge scan
 */
export function measureBody(body, allBodies, opts = {}) {
  const meshes = ownedMeshes(body, allBodies);
  const box = new Box3();
  let volume = 0;
  const cross = new Vector3();
  const triangles = forEachOwnedTriangle(body, meshes, (a, b, c) => {
    box.expandByPoint(a);
    box.expandByPoint(b);
    box.expandByPoint(c);
    volume += a.dot(cross.crossVectors(b, c)) / 6;
  });
  const size = box.isEmpty() ? new Vector3() : box.getSize(new Vector3());
  const centre = box.isEmpty() ? new Vector3() : box.getCenter(new Vector3());
  const boundaryEdges = {};
  if (opts.weld !== false) {
    for (const t of WELD_TOLERANCES_MM) boundaryEdges[String(t)] = boundaryEdgeCount(body, meshes, t);
  }
  return {
    node: body.name,
    meshes: meshes.length,
    triangles,
    shellVolumeMm3: volume,
    centreMm: [centre.x, centre.y, centre.z],
    halfMm: [size.x / 2, size.y / 2, size.z / 2],
    boundaryEdges,
  };
}

/** {@link measureBody} for every body, in input order. */
export function measureBodies(bodies, opts = {}) {
  return bodies.map((b) => measureBody(b, bodies, opts));
}

/**
 * Per-body mass, kg: the envelope volumes normalised so their SUM is
 * `datasheetMassKg`. Returns the effective envelope density with it — the number
 * the plan's calibration step asks for. It is NOT a material density: a hollow
 * housing counts as full, so the figure is well below the density of the alloy
 * or polymer the part is actually made of.
 */
export function massesFromDatasheetSum(measured, datasheetMassKg) {
  const totalMm3 = measured.reduce((s, m) => s + m.shellVolumeMm3, 0);
  const densityKgM3 = datasheetMassKg / (totalMm3 * 1e-9);
  return {
    densityKgM3,
    totalVolumeMm3: totalMm3,
    massKg: measured.map((m) => m.shellVolumeMm3 * 1e-9 * densityKgM3),
  };
}
