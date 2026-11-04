// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { toSnapshotData, fromSnapshotData, type SnapshotJson, type SnapshotSchema } from './rv-snapshot-contract';
import type { MotionProfile, LimitPiece } from './rv-motion-profile';
import type { RouteEntry } from './rv-movement-authority';
import { getDefaultPathNetwork } from './rv-path-network';

export function snapshotError(reason: string): never {
  throw Object.assign(new Error(`fleet.authority: ${reason}`), { code: 'des-snapshot-authority-state' });
}

/** Exact numeric paths, including tagged numbers. No implicit JSON reviver. */
export function authorityNumberSchema(value: unknown): SnapshotSchema {
  const codecs: Record<string, 'number-tags'> = {};
  const visit = (v: unknown, path: string): void => {
    if (typeof v === 'number' || v && typeof v === 'object' && Object.hasOwn(v, '$num')) {
      codecs[path] = 'number-tags'; return;
    }
    if (Array.isArray(v)) v.forEach((item, i) => visit(item, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) {
      const next = /^[A-Za-z_$][\w$]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}[${JSON.stringify(k)}]`;
      visit(item, next);
    }
  };
  visit(value, '');
  return { codecs };
}
export function encodeAuthorityData(value: unknown): SnapshotJson {
  return toSnapshotData(value, { participant: 'fleet.authority', ...authorityNumberSchema(value) });
}
export function decodeAuthorityData(value: unknown): unknown {
  return fromSnapshotData(value, { participant: 'fleet.authority', ...authorityNumberSchema(value) });
}
export function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) snapshotError('expected record');
  return value as Record<string, any>;
}
export function numeric(value: unknown, finite = false): asserts value is number {
  if (typeof value !== 'number' || finite && !Number.isFinite(value)) snapshotError('invalid number');
}
export function decodeMotionProfile(value: unknown): MotionProfile {
  const p = record(decodeAuthorityData(value));
  for (const k of ['t0', 'x0', 'v0', 'xStop', 'tEnd', 'vEnd']) numeric(p[k], true);
  if (typeof p.feasible !== 'boolean' || !Array.isArray(p.phases) || p.v0 < 0 || p.vEnd < 0 || p.tEnd < p.t0 || p.xStop < p.x0) snapshotError('invalid profile');
  let t = p.t0, x = p.x0, v = p.v0;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  for (const phase of p.phases) {
    const q = record(phase);
    for (const k of ['t0', 'x0', 'v0', 'a', 'dt', 'x1']) numeric(q[k], true);
    if (q.dt < 0 || !near(q.t0, t) || !near(q.x0, x) || !near(q.v0, v)
      || !near(q.x1, q.x0 + q.v0 * q.dt + 0.5 * q.a * q.dt ** 2)) snapshotError('inconsistent profile phase');
    t += q.dt; x = q.x1; v = q.v0 + q.a * q.dt;
  }
  if (!near(t, p.tEnd) || !near(x, p.xStop) || !near(v, p.vEnd)) snapshotError('inconsistent profile end');
  return p as unknown as MotionProfile;
}
export const encodeMotionProfile = (p: MotionProfile): SnapshotJson => encodeAuthorityData(p);
export const encodeLimitPieces = (p: readonly LimitPiece[]): SnapshotJson => encodeAuthorityData(p);
export function decodeLimitPieces(value: unknown): LimitPiece[] {
  const pieces = decodeAuthorityData(value);
  if (!Array.isArray(pieces)) snapshotError('invalid limits');
  for (const p of pieces) {
    for (const k of ['x0', 'x1', 'c0', 'c1']) numeric(record(p)[k]);
    if (p.x1 < p.x0) snapshotError('reversed limit');
  }
  return pieces as LimitPiece[];
}
export function encodeRoute(route: readonly RouteEntry[]): { pathId: string; x0: number }[] {
  return route.map(e => ({ pathId: e.path.id, x0: e.x0 }));
}
export function resolveSnapshotPath(id: unknown) {
  const path = typeof id === 'string' && getDefaultPathNetwork().get(id);
  if (!path) snapshotError(`unknown path '${id}'`);
  return path;
}
export function decodeRoute(value: unknown): RouteEntry[] {
  if (!Array.isArray(value) || !value.length) snapshotError('invalid route');
  return value.map(e => { const r = record(e); numeric(r.x0, true); return { path: resolveSnapshotPath(r.pathId), x0: r.x0 }; });
}

/** Ordered tuples are deliberate: waiter insertion order is causal state. */
export function tupleMap(value: unknown): Map<string, any> {
  if (!Array.isArray(value)) snapshotError('expected tuple list');
  const map = new Map<string, any>();
  for (const e of value) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || map.has(e[0])) snapshotError('invalid or duplicate map key');
    map.set(e[0], e[1]);
  }
  return map;
}
