// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Pure station docking geometry in meters, projected onto XZ (plan-636). */
import { headingOf, placedTemplate, poseAtArcLength } from './rv-path-blocks';
import { segmentLength } from './rv-path-edit';
import type { PathGraphEntry } from './rv-path-network-ops';
import type { PathNetworkIssue } from './rv-path-network-validate';

/** The fixed 90-degree mouth permits only a small port orientation discrepancy. */
export const DOCK_PERP_TOL_DEG = 1.0;
/** A load centre more than 10 mm from the seat needs an authoring warning. */
export const DOCK_POS_TOL_M = 0.010;
/** Keep at least 100 mm of usable straight dock before the mouth. */
export const DOCK_MIN_STRAIGHT_M = 0.10;

type XZ = [number, number];
export interface StubDockInput {
  host: PathGraphEntry;
  seat: XZ;
  portDir: XZ;
  loadOffsetM: number;
  radiusM: number;
}
export type StubDockResult =
  | { ok: true; pathId: string; s: number; side: 'left' | 'right'; stubStraightM: number; perpErrDeg: number }
  | { ok: false; reason: 'dock-host-not-straight' | 'dock-not-perpendicular' | 'dock-too-close' | 'dock-internal-mismatch'; detail: string };

function unit(v: XZ): XZ {
  const length = Math.hypot(...v);
  return length > 0 ? [v[0] / length, v[1] / length] : [0, 0];
}
function angle(a: XZ, b: XZ): number {
  const u = unit(a), v = unit(b);
  return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) * 180 / Math.PI;
}
const cross = (a: XZ, b: XZ): number => a[0] * b[1] - a[1] * b[0];

export function computeStubDock(i: StubDockInput): StubDockResult {
  const reject = (reason: Extract<StubDockResult, { ok: false }>['reason'], detail: string): StubDockResult => ({ ok: false, reason, detail });
  let offset = 0;
  const candidates: { s0: number; length: number; foot: number; lateral: number; normal: XZ }[] = [];
  for (const spec of i.host.segments) {
    const length = segmentLength(spec);
    if (spec.kind === 'line' && length > 0) {
      const t = unit([spec.to[0] - spec.from[0], spec.to[2] - spec.from[2]]);
      const v: XZ = [i.seat[0] - spec.from[0], i.seat[1] - spec.from[2]];
      const foot = v[0] * t[0] + v[1] * t[1];
      // Left = up cross travel, hence -Z for a +X host (the block convention).
      const normal: XZ = [t[1], -t[0]];
      if (foot >= 0 && foot <= length) candidates.push({ s0: offset, length, foot, lateral: v[0] * normal[0] + v[1] * normal[1], normal });
    }
    offset += length;
  }
  candidates.sort((a, b) => Math.abs(a.lateral) - Math.abs(b.lateral) || a.s0 - b.s0);
  const c = candidates[0];
  if (!c) return reject('dock-host-not-straight', 'The seat has no foot on a straight host segment.');
  const sign = c.lateral >= 0 ? 1 : -1;
  const a: XZ = [-sign * c.normal[0], -sign * c.normal[1]];
  const perpErrDeg = angle(i.portDir, a);
  if (perpErrDeg > DOCK_PERP_TOL_DEG) return reject('dock-not-perpendicular', `Port differs from the stub axis by ${perpErrDeg.toFixed(1)}°.`);
  const h: XZ = [i.seat[0] + a[0] * i.loadOffsetM, i.seat[1] + a[1] * i.loadOffsetM];
  const lat = Math.abs(c.lateral) - i.loadOffsetM;
  const stubStraightM = lat - i.radiusM;
  if (stubStraightM < DOCK_MIN_STRAIGHT_M) return reject('dock-too-close', 'The dock straight would be shorter than 0.10 m.');
  const s = c.s0 + c.foot + i.radiusM;
  if (c.foot + i.radiusM > c.length) return reject('dock-host-not-straight', 'The foot and mouth must lie on the same straight segment.');
  const side = sign > 0 ? 'left' : 'right';
  const at = poseAtArcLength(i.host.segments, s);
  if (!at) return reject('dock-internal-mismatch', 'Cannot resolve the host pose.');
  // Exactly the pose/elevation construction used by placeJunction.
  const stub = placedTemplate({ kind: 'stub', radiusM: i.radiusM, stubStraightM, side },
    [at.position[0], at.position[2], headingOf(at.tangent)], at.position[1])
    .find(piece => piece.role === 'stub')?.specs[0];
  if (!stub || stub.kind !== 'line'
    || Math.hypot(stub.from[0] - h[0], stub.from[2] - h[1]) > 0.001
    || Math.hypot(stub.from[0] - a[0] * i.loadOffsetM - i.seat[0], stub.from[2] - a[1] * i.loadOffsetM - i.seat[1]) > 0.001) {
    return reject('dock-internal-mismatch', 'The placed stub does not reproduce the root and load seat within 1 mm.');
  }
  return { ok: true, pathId: i.host.id, s, side, stubStraightM, perpErrDeg };
}

/** First forward ray hit, including arcs so a curved foreground host cannot be skipped. */
export function hostByRay(paths: readonly PathGraphEntry[], from: XZ, dir: XZ, maxDepthM: number):
  { pathId: string; lambda: number } | { reason: 'dock-no-host' | 'dock-host-not-straight' } {
  const d = unit(dir);
  if (Math.hypot(...d) === 0) return { reason: 'dock-no-host' };
  const hits: { pathId: string; lambda: number; arc: boolean }[] = [];
  const add = (pathId: string, lambda: number, arc: boolean) => {
    if (lambda > 0 && lambda <= maxDepthM) hits.push({ pathId, lambda, arc });
  };
  for (const path of paths) for (const spec of path.segments) {
    if (spec.kind === 'line') {
      const v: XZ = [spec.to[0] - spec.from[0], spec.to[2] - spec.from[2]];
      const q: XZ = [spec.from[0] - from[0], spec.from[2] - from[1]];
      const denominator = cross(d, v);
      if (Math.abs(denominator) < 1e-12) continue;
      const t = cross(q, d) / denominator;
      if (t >= -1e-12 && t <= 1 + 1e-12) add(path.id, cross(q, v) / denominator, false);
    } else if ((spec.plane ?? 'XZ') === 'XZ') {
      const q: XZ = [from[0] - spec.center[0], from[1] - spec.center[2]];
      const b = q[0] * d[0] + q[1] * d[1];
      const disc = b * b - (q[0] ** 2 + q[1] ** 2 - spec.radius ** 2);
      if (disc < -1e-12) continue;
      const sweep = (spec.clockwise ? -1 : 1) * spec.degrees;
      for (const lambda of [-b - Math.sqrt(Math.max(0, disc)), -b + Math.sqrt(Math.max(0, disc))]) {
        const theta = Math.atan2(q[1] + lambda * d[1], q[0] + lambda * d[0]) * 180 / Math.PI;
        const delta = ((Math.sign(sweep) * (theta - spec.startAngle)) % 360 + 360) % 360;
        if (delta <= Math.abs(sweep) + 1e-9 || 360 - delta < 1e-9) add(path.id, lambda, true);
      }
    }
  }
  if (!hits.length) return { reason: 'dock-no-host' };
  const nearest = Math.min(...hits.map(hit => hit.lambda));
  const hit = hits.filter(h => h.lambda - nearest < 0.001)
    .sort((a, b) => (a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : a.lambda - b.lambda))[0];
  return hit.arc ? { reason: 'dock-host-not-straight' } : { pathId: hit.pathId, lambda: hit.lambda };
}

export interface StationDockCheck {
  stationId: string;
  stubPathId: string | null;
  seat: XZ;
  portDir: XZ;
  loadOffsetM: number;
}

/** Compare the load centre and port direction against the actual stub line, never the port-derived offset. */
export function validateStationDocks(checks: readonly StationDockCheck[], paths: readonly PathGraphEntry[]): PathNetworkIssue[] {
  const byId = new Map(paths.map(path => [path.id, path]));
  const issues: PathNetworkIssue[] = [];
  for (const check of checks) {
    if (!check.stubPathId) continue;
    const path = byId.get(check.stubPathId);
    const base = { severity: 'warning' as const, key: check.stationId, pathId: check.stubPathId };
    if (!path) {
      issues.push({ ...base, code: 'path-dock-stub-missing', position: [check.seat[0], 0, check.seat[1]], short: 'Dock missing', detail: `Station ${check.stationId}: docked path ${check.stubPathId} is missing.` });
      continue;
    }
    const stub = path.segments[0];
    if (!stub || stub.kind !== 'line') continue;
    const a = unit([stub.to[0] - stub.from[0], stub.to[2] - stub.from[2]]);
    const distance = Math.hypot(stub.from[0] - a[0] * check.loadOffsetM - check.seat[0], stub.from[2] - a[1] * check.loadOffsetM - check.seat[1]);
    const degrees = angle(check.portDir, a);
    const short = distance > DOCK_POS_TOL_M ? `Dock ${Math.round(distance * 1000)} mm`
      : degrees > DOCK_PERP_TOL_DEG ? `Dock ${degrees.toFixed(1)}°` : null;
    if (short) issues.push({ ...base, code: 'path-dock-misaligned', position: [...stub.from], short,
      detail: `Station ${check.stationId}: load centre differs by ${Math.round(distance * 1000)} mm; port angle ${degrees.toFixed(1)}°.` });
  }
  return issues.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
