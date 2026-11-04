// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Box3, Vector3, type Mesh, type Object3D } from 'three';
import type { AgentEye } from '../engine/rv-agent-eye';
import { fitPoseToPoints, type Vec3 as FitVec3 } from '../../plugins/mcp-bridge/rv-frame-fit-math';

const FIT_MESH_SAMPLE_CAP = 2000;

export function fitBox(
  eye: AgentEye, box: Box3, dir: Vector3, nodes?: readonly Object3D[],
): { eye: Vector3; target: Vector3 } {
  const p = eye.pose;
  const fit = fitPoseToPoints(
    fitPoints(box, nodes),
    [dir.x, dir.y, dir.z],
    p.fov, p.aspect,
  );
  return {
    eye: new Vector3(fit.eye[0], fit.eye[1], fit.eye[2]),
    target: new Vector3(fit.target[0], fit.target[1], fit.target[2]),
  };
}

/**
 * Points the fit should frame: the corners of each MESH's own box, falling
 * back to the subtree's single world AABB when there are no meshes.
 *
 * One world-axis AABB around a rotated assembly has large empty corners, so
 * centring its projection centres the empty box rather than the part — the
 * valve terminal still came out 122 px right of centre that way. Per-mesh
 * boxes follow each part's own placement and hug the geometry far more
 * tightly. Capped because this is per-corner arithmetic and a big assembly
 * can carry tens of thousands of meshes; the subsample keeps the extremes,
 * which is all an extent needs.
 */
function fitPoints(box: Box3, nodes?: readonly Object3D[]): FitVec3[] {
  const out: FitVec3[] = [];
  if (nodes && nodes.length > 0) {
    const meshes: Mesh[] = [];
    for (const n of nodes) {
      n.updateMatrixWorld(true);
      n.traverse((c) => { if ((c as Mesh).isMesh && (c as Mesh).geometry) meshes.push(c as Mesh); });
    }
    const step = Math.max(1, Math.ceil(meshes.length / FIT_MESH_SAMPLE_CAP));
    const corner = new Vector3();
    for (let i = 0; i < meshes.length; i += step) {
      const m = meshes[i];
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb || bb.isEmpty()) continue;
      for (let k = 0; k < 8; k++) {
        corner.set(
          k & 1 ? bb.max.x : bb.min.x,
          k & 2 ? bb.max.y : bb.min.y,
          k & 4 ? bb.max.z : bb.min.z,
        ).applyMatrix4(m.matrixWorld);
        out.push([corner.x, corner.y, corner.z]);
      }
    }
  }
  if (out.length === 0 && !box.isEmpty()) {
    for (let k = 0; k < 8; k++) {
      out.push([
        k & 1 ? box.max.x : box.min.x,
        k & 2 ? box.max.y : box.min.y,
        k & 4 ? box.max.z : box.min.z,
      ]);
    }
  }
  return out;
}

export function frameEyeToBox(
  eye: AgentEye, box: Box3, dir: Vector3, nodes?: readonly Object3D[],
): void {
  const fit = fitBox(eye, box, dir, nodes);
  eye.setPose({
    px: fit.eye.x, py: fit.eye.y, pz: fit.eye.z,
    tx: fit.target.x, ty: fit.target.y, tz: fit.target.z,
  });
}

