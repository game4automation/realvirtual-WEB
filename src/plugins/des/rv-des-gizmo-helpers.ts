// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-gizmo-helpers.ts — Shared helpers for creating DES component gizmos.
 *
 * Used by DESSource, DESSink, DESConveyor, DESStation etc. to create
 * their 3D visual representation (wireframe + transparent fill + entry/exit spheres).
 */

import {
  Group, BoxGeometry, EdgesGeometry, LineSegments, LineBasicMaterial,
  MeshBasicMaterial, Mesh, SphereGeometry,
} from 'three';
import type { Object3D } from 'three';

const MM_TO_M = 0.001;
const ENTRY_COLOR = 0x4caf50;   // green
const EXIT_COLOR = 0xf44336;    // red
const SPHERE_RADIUS = 0.03;     // 30mm in meters

export interface GizmoOptions {
  /** Show green sphere on -X face (entry point). Default: false */
  entrySphere?: boolean;
  /** Show red sphere on +X face (exit point). Default: false */
  exitSphere?: boolean;
  /** Fill opacity (0 = wireframe only, 0.15 = subtle fill). Default: 0.15 */
  fillOpacity?: number;
}

/**
 * Create a DES component gizmo: wireframe box + transparent fill + optional entry/exit spheres.
 * @param gizmoSize  Dimensions in mm [width, height, depth]
 * @param color      Box color (hex)
 * @param options    Entry/exit sphere visibility, fill opacity
 */
export function createDESGizmoBox(
  gizmoSize: [number, number, number],
  color: number,
  options: GizmoOptions = {},
): Object3D {
  const { entrySphere = false, exitSphere = false, fillOpacity = 0.15 } = options;
  const [w, h, d] = gizmoSize.map(v => v * MM_TO_M);
  const group = new Group();

  // Wireframe edges
  const boxGeo = new BoxGeometry(w, h, d);
  const edgesGeo = new EdgesGeometry(boxGeo);
  const wireframe = new LineSegments(edgesGeo, new LineBasicMaterial({ color }));
  wireframe.position.y = h / 2;
  wireframe.frustumCulled = false;
  group.add(wireframe);

  // Transparent fill
  if (fillOpacity > 0) {
    const fill = new Mesh(boxGeo.clone(), new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: fillOpacity,
      depthWrite: false,
    }));
    fill.position.y = h / 2;
    fill.frustumCulled = false;
    fill.renderOrder = 1;
    group.add(fill);
  }

  // Entry sphere (green, on -X face)
  if (entrySphere) {
    const sphereGeo = new SphereGeometry(SPHERE_RADIUS, 12, 8);
    const sphere = new Mesh(sphereGeo, new MeshBasicMaterial({ color: ENTRY_COLOR }));
    sphere.position.set(-w / 2, h * 0.1, 0);
    sphere.frustumCulled = false;
    group.add(sphere);
  }

  // Exit sphere (red, on +X face)
  if (exitSphere) {
    const sphereGeo = new SphereGeometry(SPHERE_RADIUS, 12, 8);
    const sphere = new Mesh(sphereGeo, new MeshBasicMaterial({ color: EXIT_COLOR }));
    sphere.position.set(w / 2, h * 0.1, 0);
    sphere.frustumCulled = false;
    group.add(sphere);
  }

  boxGeo.dispose();
  edgesGeo.dispose();
  return group;
}
