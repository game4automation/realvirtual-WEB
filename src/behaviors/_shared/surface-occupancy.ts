// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Surface-occupancy helper for auto-behaviors.
 *
 * "Occupied" for a conveyor / turntable zone means a good (MU) is physically on its belt surface —
 * not merely at a point sensor. This thin wrapper reuses the pure primitives added for the Source
 * placement feature (`collectSurfacesUnder` + `anyMUOnSurfaces`) so the occupancy semantics stay
 * identical across Source, Conveyor and Turntable.
 */

import type { Object3D } from 'three';
import {
  collectSurfacesUnder, anyMUOnSurfaces,
  type SurfaceLike, type MULike,
} from '../../core/engine/rv-source-placement';

interface TransportLike {
  surfaces: readonly SurfaceLike[];
  mus: readonly MULike[];
}

/** Own-surface list per queried node, keyed on the manager's `surfaces` array
 *  identity + length (the manager's own self-heal signature): planner mutations
 *  reassign or grow that array, which invalidates the entry. Avoids the
 *  per-tick `collectSurfacesUnder` allocation + ancestor walk per conveyor. */
const _ownSurfaces = new WeakMap<Object3D, { src: readonly SurfaceLike[]; len: number; list: SurfaceLike[] }>();

/**
 * True if any live MU is physically on a transport surface under `node`.
 *
 * `host` is the behavior's `rv.viewer` (the RVViewer at runtime). Its `transportManager` is null
 * before the scene finishes loading and absent in minimal test hosts — both yield `false`.
 */
export function isSurfaceOccupied(host: unknown, node: Object3D): boolean {
  const tm = (host as { transportManager?: TransportLike | null }).transportManager;
  if (!tm) return false;
  let entry = _ownSurfaces.get(node);
  if (!entry || entry.src !== tm.surfaces || entry.len !== tm.surfaces.length) {
    entry = { src: tm.surfaces, len: tm.surfaces.length, list: collectSurfacesUnder(node, tm.surfaces) };
    _ownSurfaces.set(node, entry);
  }
  return entry.list.length > 0 && anyMUOnSurfaces(entry.list, tm.mus);
}
