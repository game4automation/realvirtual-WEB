// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-686 §9.3e — independent geometric safety check of the orphaned-claim
 * release (step 4 of `planZones`), shared by the WEB regression test and the
 * PalletYard takt runs.
 *
 * The movement authority instance is wrapped (test seam, no source change):
 * every zone that `releaseStaleClaims` gives back (plan build step 4 and the reverse direction change) is checked at the release
 * time against
 *  - the zone CORRIDOR: every piece of the zone sampled every <= 2 cm, a disc
 *    of radius w_max / 2 + 1 cm per sample (covers the sampling error), against
 *    the vehicle's EFFECTIVE body OBB (`mb.bodyOf` — the extents the authority
 *    plans with, fallback dimensions included — at the authority's pose);
 *  - the OBBs of all other vehicles standing on a piece of that zone.
 * Any overlap is a violation. Independent of the engine's own occupancy check.
 */

import { Vector3 } from 'three';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import type { MovementAuthority } from '../../src/core/engine/rv-movement-authority';

export interface Obb { cx: number; cz: number; ux: number; uz: number; half: number; hw: number }

const _p = new Vector3();
const _d = new Vector3();

/** Effective body OBB of a vehicle at time t: `mb.bodyOf` extents, pose from the authority (path tangent). */
export function obbOf(mb: MovementAuthority, id: string, t: number): Obb | null {
  const b = mb.bodyOf(id);
  const l = mb.locate(id, t);
  if (!b || !l) return null;
  l.path.getAbsPosition(l.s, _p);
  l.path.getAbsDirection(l.s, _d);
  const n = Math.hypot(_d.x, _d.z) || 1;
  const ux = _d.x / n, uz = _d.z / n;
  const off = (b.front - b.rear) / 2;
  return { cx: _p.x + ux * off, cz: _p.z + uz * off, ux, uz, half: (b.front + b.rear) / 2, hw: b.width / 2 };
}

/** Distance (m) from a point to an OBB (0 inside). */
export function pointObb(o: Obb, x: number, z: number): number {
  const dx = x - o.cx, dz = z - o.cz;
  const a = dx * o.ux + dz * o.uz;
  const c = -dx * o.uz + dz * o.ux;
  return Math.hypot(Math.max(0, Math.abs(a) - o.half), Math.max(0, Math.abs(c) - o.hw));
}

/** SAT overlap of two OBBs (> 0 = penetration depth). */
export function obbOverlap(a: Obb, b: Obb): number {
  const axes = [[a.ux, a.uz], [-a.uz, a.ux], [b.ux, b.uz], [-b.uz, b.ux]];
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  let min = Infinity;
  for (const [x, z] of axes) {
    const ra = Math.abs(a.half * (a.ux * x + a.uz * z)) + Math.abs(a.hw * (-a.uz * x + a.ux * z));
    const rb = Math.abs(b.half * (b.ux * x + b.uz * z)) + Math.abs(b.hw * (-b.uz * x + b.ux * z));
    const pen = ra + rb - Math.abs(dx * x + dz * z);
    if (pen <= 0) return pen;
    min = Math.min(min, pen);
  }
  return min;
}

export interface StaleReleaseLog {
  /** Every zone released by step 4: sim time, vehicle, zone. */
  releases: { t: number; id: string; zone: string }[];
  /** One line per unsafe release (empty = all safe). */
  violations: string[];
  /** Undo the instance wrapping. */
  restore(): void;
}

interface Internals {
  releaseStaleClaims: (v: { id: string }, route: unknown, now: number, ...rest: unknown[]) => void;
  releaseHeld: (v: { id: string }, z: string) => void;
}

/** Wrap `mb` so every step-4 release is recorded and checked (see the module doc). */
export function watchStaleReleases(mb: MovementAuthority, ids: () => string[]): StaleReleaseLog {
  const m = mb as unknown as Internals;
  const hadOwnStale = Object.prototype.hasOwnProperty.call(m, 'releaseStaleClaims');
  const hadOwnRel = Object.prototype.hasOwnProperty.call(m, 'releaseHeld');
  const origStale = m.releaseStaleClaims, origRel = m.releaseHeld;
  const log: StaleReleaseLog = {
    releases: [], violations: [],
    restore: () => {
      if (hadOwnStale) m.releaseStaleClaims = origStale; else delete (m as Partial<Internals>).releaseStaleClaims;
      if (hadOwnRel) m.releaseHeld = origRel; else delete (m as Partial<Internals>).releaseHeld;
    },
  };
  let step4At: number | null = null;
  m.releaseStaleClaims = function (this: unknown, v, route, now, ...rest) {
    step4At = now;
    try { origStale.call(this, v, route, now, ...rest); } finally { step4At = null; }
  };
  m.releaseHeld = function (this: unknown, v, z) {
    if (step4At !== null) check(step4At, v.id, z);
    origRel.call(this, v, z);
  };
  const check = (t: number, id: string, z: string): void => {
    log.releases.push({ t, id, zone: z });
    const me = obbOf(mb, id, t);
    if (!me) return;
    let wMax = 0;
    for (const u of ids()) wMax = Math.max(wMax, mb.bodyOf(u)?.width ?? 0);
    const r = wMax / 2 + 0.01;
    for (const piece of getDefaultPathNetwork().all()) {
      if (piece.zoneId !== z) continue;
      const k = Math.max(1, Math.ceil(piece.length / 0.02));
      for (let i = 0; i <= k; i++) {
        piece.getAbsPosition((i * piece.length) / k, _p);
        const d = pointObb(me, _p.x, _p.z);
        if (d < r) {
          log.violations.push(`${t.toFixed(3)} ${id} released ${z}: body ${d.toFixed(3)} m from '${piece.id}' (< ${r.toFixed(3)})`);
          break;
        }
      }
    }
    for (const other of ids()) {
      if (other === id) continue;
      const lo = mb.locate(other, t);
      if (!lo || lo.path.zoneId !== z) continue;
      const ob = obbOf(mb, other, t);
      if (ob && obbOverlap(me, ob) > 1e-6) log.violations.push(`${t.toFixed(3)} ${id} released ${z}: overlaps '${other}'`);
    }
  };
  return log;
}
