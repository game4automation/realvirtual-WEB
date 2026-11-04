// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-robot-link-geometry.mjs (plan-673 Phase 4b). */

import type { Mesh, Object3D } from 'three';

/** Weld tolerances the boundary-edge count is reported at, millimetres. */
export const WELD_TOLERANCES_MM: readonly number[];

/** Meshes `body` owns: its subtree, cut at every other body. */
export function ownedMeshes(body: Object3D, allBodies: readonly Object3D[]): Mesh[];

export interface BodyMeasurement {
  node: string;
  meshes: number;
  triangles: number;
  /** Divergence-theorem ENVELOPE volume, mm^3 (a hollow housing counts as full). */
  shellVolumeMm3: number;
  /** Bounding-box centre in the body's local frame, mm. */
  centreMm: [number, number, number];
  /** Bounding-box half extents in the body's local frame, mm. */
  halfMm: [number, number, number];
  /** Weld tolerance (mm, as a string) -> directed edges that do not cancel; 0 = closed. */
  boundaryEdges: Record<string, number>;
}

/** Measure one body: bounding box, envelope volume and the closedness evidence. */
export function measureBody(
  body: Object3D,
  allBodies: readonly Object3D[],
  opts?: { weld?: boolean },
): BodyMeasurement;

/** {@link measureBody} for every body, in input order. */
export function measureBodies(
  bodies: readonly Object3D[],
  opts?: { weld?: boolean },
): BodyMeasurement[];

/** Envelope volumes normalised to a datasheet mass sum, plus that effective density. */
export function massesFromDatasheetSum(
  measured: readonly BodyMeasurement[],
  datasheetMassKg: number,
): { densityKgM3: number; totalVolumeMm3: number; massKg: number[] };
