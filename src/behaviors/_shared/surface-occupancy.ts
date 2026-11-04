// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Surface-occupancy helper for auto-behaviors.
 *
 * Geometric occupancy supports transfer-clearance checks. Conveyor back-pressure
 * uses ownership instead: an upstream pallet grazing the next belt must not
 * make that belt block its own arrival.
 */

import type { Object3D } from 'three';
import {
  collectSurfacesUnder, anyMUOnSurfaces,
  type SurfaceLike, type MULike,
} from '../../core/engine/rv-source-placement';

interface TransportLike {
  surfaces: readonly SurfaceLike[];
  mus: readonly (MULike & { readonly currentSurface?: SurfaceLike | null })[];
}

/** Own-surface list per queried node, keyed on the manager's `surfaces` array
 *  identity + length (the manager's own self-heal signature): planner mutations
 *  reassign or grow that array, which invalidates the entry. Avoids the
 *  per-tick `collectSurfacesUnder` allocation + ancestor walk per conveyor. */
const _ownSurfaces = new WeakMap<Object3D, { src: readonly SurfaceLike[]; len: number; list: SurfaceLike[] }>();

function surfacesUnder(tm: TransportLike, node: Object3D): readonly SurfaceLike[] {
  let entry = _ownSurfaces.get(node);
  if (!entry || entry.src !== tm.surfaces || entry.len !== tm.surfaces.length) {
    entry = { src: tm.surfaces, len: tm.surfaces.length, list: collectSurfacesUnder(node, tm.surfaces) };
    _ownSurfaces.set(node, entry);
  }
  return entry.list;
}

/**
 * True if any live MU is physically on a transport surface under `node`.
 *
 * `host` is the behavior's `rv.viewer` (the RVViewer at runtime). Its `transportManager` is null
 * before the scene finishes loading and absent in minimal test hosts — both yield `false`.
 */
export function isSurfaceOccupied(host: unknown, node: Object3D): boolean {
  const tm = (host as { transportManager?: TransportLike | null }).transportManager;
  if (!tm) return false;
  const surfaces = surfacesUnder(tm, node);
  return surfaces.length > 0 && anyMUOnSurfaces(surfaces, tm.mus);
}

/** Conveyor back-pressure: only the surface assigned to a live MU is occupied.
 * `currentSurface` is a surface instance, not its Object3D node. No geometric
 * fallback: an unassigned or upstream-owned MU must not block its own entry. */
export function isSurfaceOccupiedByOwner(host: unknown, node: Object3D): boolean {
  const tm = (host as { transportManager?: TransportLike | null }).transportManager;
  if (!tm) return false;
  const surfaces = surfacesUnder(tm, node);
  for (const mu of tm.mus) {
    if (!mu.markedForRemoval && mu.currentSurface && surfaces.includes(mu.currentSurface)) return true;
  }
  return false;
}
