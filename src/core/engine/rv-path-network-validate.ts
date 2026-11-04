// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-network-validate — pure checks of a path network snapshot
 * (plan-628 Phase 4, §2.8). No viewer, no Problems panel: the result is a
 * sorted, input-order-independent issue list; the publisher lives in
 * `plugins/path-network/path-network-validation.ts`.
 *
 * | Code                                | Severity | Rule |
 * |-------------------------------------|----------|------|
 * | `path-open-end`                     | info     | end without successor, not closed (not for composition-owned paths) |
 * | `path-unreachable-start`            | info     | start without predecessor (no station, no vehicle start, not composition-owned) |
 * | `path-link-gap`                     | error    | successor listed, but end and start more than 5 mm apart |
 * | `path-kink`                         | error    | successor listed, ends meet, but the tangents differ by > `PATH_KINK_TOLERANCE_DEG` (plan-628 8.3) |
 * | `path-dangling-successor`           | warning  | successor id does not exist |
 * | `path-radius-too-tight`             | warning  | arc radius < `PATH_MIN_RADIUS_WIDTH_FACTOR` × body width (needs an envelope; plan-628 8.11g) |
 * | `path-block-transform-not-identity` | warning  | `PathNetwork` / block node transform is not the identity |
 * | `path-merge-zones-too-close`        | warning  | free run between two merge zones < `env.front` |
 * | `agv-merge-without-zone`            | warning  | merge adapter: `findUnzonedMerges` |
 * | `agv-merge-entry-too-short`         | warning  | merge adapter: `findShortMergeEntries` with the envelope |
 * | `agv-merge-check-skipped`           | info     | zoned merges but no envelope (fleet / explicit) |
 */

import { Vector3 } from 'three';
import { PATH_KINK_TOLERANCE_DEG, PATH_LINK_BOUND_EPS, PATH_LINK_TOLERANCE, tangentAngleDeg } from '../connect/path-link-tolerance';
import {
  findShortMergeEntries,
  findUnzonedMerges,
  isZonedMerge,
  type BodyEnvelope,
} from './rv-movement-authority';
import { parsePathExtras, type RVPath } from './rv-path';
import { arcPointAt, cloneSegmentSpecs, type Vec3Tuple } from './rv-path-edit';
import { RVPathNetwork } from './rv-path-network';
import { specEnds } from './rv-path-blocks';
import type { NetworkInput, PathGraphEntry } from './rv-path-network-ops';

export type PathNetworkIssueCode =
  | 'path-dock-misaligned'
  | 'path-dock-stub-missing'
  | 'path-open-end'
  | 'path-unreachable-start'
  | 'path-link-gap'
  | 'path-kink'
  | 'path-dangling-successor'
  | 'path-radius-too-tight'
  | 'path-block-transform-not-identity'
  | 'path-merge-zones-too-close'
  | 'agv-merge-without-zone'
  | 'agv-merge-entry-too-short'
  | 'agv-merge-check-skipped';

export type PathNetworkIssueSeverity = 'error' | 'warning' | 'info';

/** One finding. `key` is stable across runs (Problems id). */
export interface PathNetworkIssue {
  code: PathNetworkIssueCode;
  severity: PathNetworkIssueSeverity;
  key: string;
  pathId?: string;
  blockId?: string;
  /** World position (m) of the marker; absent = no place (e.g. skipped). */
  position?: Vec3Tuple;
  detail: string;
  /** plan-628 8.11g: short label shown next to the marker at the path (e.g. `Kink 5.0°`). */
  short?: string;
}

/** Where the envelope came from (P11: fleet > explicit > none). */
export type EnvelopeSource = 'fleet' | 'design' | 'explicit' | 'none';

export interface PathNetworkValidation {
  issues: PathNetworkIssue[];
  envelope: BodyEnvelope | null;
  envelopeSource: EnvelopeSource;
  /** Why the merge-entry check did not run; null = ran or nothing to test. */
  skipped: 'no-envelope' | null;
}

export interface ValidateOptions {
  /** Body envelope (m) for the merge checks; null/absent = merge-entry check skipped. */
  env?: BodyEnvelope | null;
  envelopeSource?: EnvelopeSource;
  /** Path ids whose start is served by a station (no `path-unreachable-start`). */
  stationPaths?: ReadonlySet<string>;
}

/** Codes this module can emit (the publisher clears exactly these). */
export const PATH_NETWORK_ISSUE_CODES: readonly PathNetworkIssueCode[] = [
  'path-open-end', 'path-unreachable-start', 'path-link-gap', 'path-kink', 'path-dangling-successor', 'path-radius-too-tight',
  'path-block-transform-not-identity', 'path-merge-zones-too-close',
  'agv-merge-without-zone', 'agv-merge-entry-too-short', 'agv-merge-check-skipped',
];

const SEVERITY_RANK: Record<PathNetworkIssueSeverity, number> = { error: 0, warning: 1, info: 2 };
/** Depth bound of the free-run walk between merge zones. */
const MAX_WALK = 64;

/**
 * plan-628 8.11g: smallest arc radius as a multiple of the body width (needs an
 * envelope — fleet or explicit, P11). At R = width / 2 the inner flank of the
 * body reaches the turn centre: the vehicle would pivot about its own side.
 * Without an envelope the check does not run (there is no other radius rule).
 */
export const PATH_MIN_RADIUS_WIDTH_FACTOR = 0.5;

/** Usable envelope: positive length and width. */
export function isUsableEnvelope(e: BodyEnvelope | null | undefined): e is BodyEnvelope {
  return !!e && e.front + e.rear > 0 && e.width > 0;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortIssues(list: PathNetworkIssue[]): PathNetworkIssue[] {
  return list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || cmp(a.code, b.code) || cmp(a.key, b.key));
}

/** Runtime network (id order) built from the graph entries — the merge adapter's input. */
function runtimeOf(paths: readonly PathGraphEntry[]): RVPathNetwork {
  const net = new RVPathNetwork();
  const sorted = [...paths].sort((a, b) => cmp(a.id, b.id));
  const seen = new Set<string>();
  for (const p of sorted) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const rp = parsePathExtras({
      id: p.id, segments: cloneSegmentSpecs(p.segments), successors: [...p.successors].sort(),
      zone: p.zone, zoneCapacity: p.zoneCapacity, closed: p.closed === true,
    }, p.id);
    if (rp) net.register(rp);
  }
  net.resolveGraph();
  return net;
}

const v3 = (t: Vec3Tuple): Vector3 => new Vector3(t[0], t[1], t[2]);
const startOf = (p: RVPath): Vec3Tuple => { const v = p.getAbsPosition(0, new Vector3()); return [v.x, v.y, v.z]; };

/**
 * Validate a network snapshot (§2.8). Deterministic: the issue list is sorted
 * (severity, code, key) and does not depend on the input order.
 */
export function validatePathNetwork(net: NetworkInput, opts: ValidateOptions = {}): PathNetworkValidation {
  const issues: PathNetworkIssue[] = [];
  const env = isUsableEnvelope(opts.env) ? opts.env : null;
  const byId = new Map<string, PathGraphEntry>();
  for (const p of net.paths) if (!byId.has(p.id)) byId.set(p.id, p);
  const ends = new Map<string, ReturnType<typeof specEnds>>();
  const endsOf = (p: PathGraphEntry): ReturnType<typeof specEnds> => {
    if (!ends.has(p.id)) ends.set(p.id, specEnds(p.segments));
    return ends.get(p.id)!;
  };
  const preds = new Map<string, number>();
  for (const p of byId.values()) for (const s of new Set(p.successors)) preds.set(s, (preds.get(s) ?? 0) + 1);

  // ── Invariant §2.3 ──
  if (net.rootTransformIdentity === false) {
    issues.push({
      code: 'path-block-transform-not-identity', severity: 'warning', key: 'PathNetwork', blockId: 'PathNetwork',
      detail: 'The PathNetwork node is moved, rotated or scaled — path segments are absolute; block actions are refused. Reset its transform.',
    });
  }
  for (const b of net.blocks ?? []) {
    if (b.transformIdentity !== false) continue;
    issues.push({
      code: 'path-block-transform-not-identity', severity: 'warning', key: b.id, blockId: b.id,
      position: [b.extras.pose[0], b.extras.y ?? 0, b.extras.pose[1]],
      detail: `Block '${b.id}' has a node transform — path segments are absolute; block actions are refused. Reset its transform.`,
    });
  }

  // ── Topology ──
  for (const p of byId.values()) {
    if (p.closed) continue;
    const e = endsOf(p);
    for (const sid of [...new Set(p.successors)].sort()) {
      const s = byId.get(sid);
      if (!s) {
        issues.push({
          code: 'path-dangling-successor', severity: 'warning', key: `${p.id}>${sid}`, pathId: p.id,
          ...(e ? { position: e.end.position } : {}),
          detail: `Path '${p.id}' lists successor '${sid}', which does not exist.`,
          short: 'Missing successor',
        });
        continue;
      }
      const se = endsOf(s);
      if (!e || !se) continue;
      // Gap (position) first; only ends that meet can be judged for a kink
      // (direction) — one finding per edge, never both.
      const gapM = v3(e.end.position).distanceTo(v3(se.start.position));
      if (gapM > PATH_LINK_TOLERANCE.distM + PATH_LINK_BOUND_EPS) {
        issues.push({
          code: 'path-link-gap', severity: 'error', key: `${p.id}>${sid}`, pathId: p.id, position: e.end.position,
          detail: `Path '${p.id}' → '${sid}': end and start are ${(gapM * 1000).toFixed(1)} mm apart — vehicles jump here.`,
          short: `Gap ${(gapM * 1000).toFixed(0)} mm`,
        });
        continue;
      }
      const kinkDeg = tangentAngleDeg(v3(e.end.tangent), v3(se.start.tangent));
      if (kinkDeg > PATH_KINK_TOLERANCE_DEG + PATH_LINK_BOUND_EPS) {
        issues.push({
          code: 'path-kink', severity: 'error', key: `${p.id}>${sid}`, pathId: p.id, position: e.end.position,
          detail: `Path '${p.id}' → '${sid}': kink of ${kinkDeg.toFixed(1)}° at the connection (max ${PATH_KINK_TOLERANCE_DEG}°) — vehicles turn on the spot here.`,
          short: `Kink ${kinkDeg.toFixed(1)}°`,
        });
      }
    }
    // A composition-owned path (`Generated.owner`, e.g. the PalletYard generator) is read-only:
    // its open ends / starts are the generator's design (dock stubs entered in reverse), and an
    // info the user cannot act on is noise. Errors and warnings still apply to it.
    const owned = !!p.owner;
    if (p.successors.length === 0 && e && !owned) {
      issues.push({
        code: 'path-open-end', severity: 'info', key: p.id, pathId: p.id, position: e.end.position,
        detail: `Path '${p.id}' ends without a successor.`,
        short: 'Open end',
      });
    }
    if (!preds.get(p.id) && !opts.stationPaths?.has(p.id) && e && !owned) {
      issues.push({
        code: 'path-unreachable-start', severity: 'info', key: p.id, pathId: p.id, position: e.start.position,
        detail: `Path '${p.id}' has no predecessor — only a vehicle starting on it reaches it.`,
        short: 'Open start',
      });
    }
  }

  // ── Turn radius (plan-628 8.11g): only with an envelope ──
  if (env) {
    const minR = env.width * PATH_MIN_RADIUS_WIDTH_FACTOR;
    for (const p of byId.values()) {
      p.segments.forEach((seg, i) => {
        if (seg.kind !== 'arc' || !(seg.radius < minR - 1e-9)) return;
        issues.push({
          code: 'path-radius-too-tight', severity: 'warning', key: `${p.id}:${i}`, pathId: p.id, position: arcPointAt(seg, 0.5),
          detail: `Path '${p.id}': curve radius ${seg.radius.toFixed(2)} m is below ${minR.toFixed(2)} m (half the body width ${env.width.toFixed(2)} m) — the vehicle cannot follow it.`,
          short: `R ${seg.radius.toFixed(2)} m < ${minR.toFixed(2)} m`,
        });
      });
    }
  }

  // ── Merge adapter (R1 #2: pure, never runMergeEntryCheck) ──
  const rt = runtimeOf([...byId.values()]);
  const all = [...rt.all()];
  for (const m of findUnzonedMerges(all)) {
    const p = rt.get(m.pathId);
    issues.push({
      code: 'agv-merge-without-zone', severity: 'warning', key: m.pathId, pathId: m.pathId,
      ...(p ? { position: startOf(p) } : {}),
      detail: `Paths ${m.incoming.map((id) => `'${id}'`).join(', ')} merge into '${m.pathId}' without a shared zone.`,
    });
  }
  const zonedMerges = all.filter(isZonedMerge);
  let skipped: PathNetworkValidation['skipped'] = null;
  if (zonedMerges.length > 0 && !env) {
    skipped = 'no-envelope';
    issues.push({
      code: 'agv-merge-check-skipped', severity: 'info', key: 'agv-merge-check-skipped',
      detail: `${zonedMerges.length} zoned merge(s) not checked: no vehicle in the fleet and no explicit envelope (front/rear/width).`,
    });
  } else if (env) {
    for (const m of findShortMergeEntries(all, env)) {
      const p = rt.get(m.mergePathId);
      issues.push({
        code: 'agv-merge-entry-too-short', severity: 'warning', key: `${m.mergePathId}:${m.branchId}`, pathId: m.branchId,
        ...(p ? { position: startOf(p) } : {}),
        detail: `Merge '${m.mergePathId}' (branch '${m.branchId}'): lead-in ${m.pre.toFixed(2)} m, a body reaches ${m.penetration.toFixed(2)} m into it.`,
      });
    }
    // Free run between the exit of one merge zone and the entry of the next (PalletYard gapM rule).
    const mergeZones = new Set(zonedMerges.map((p) => p.zoneId!));
    for (const p of all) {
      const z = p.zoneId;
      if (!z || !mergeZones.has(z)) continue;
      for (const s0 of p.successors) {
        if (s0.zoneId === z) continue;
        let free = 0;
        let q: RVPath | null = s0;
        for (let k = 0; q && k < MAX_WALK; k++) {
          if (q.zoneId && q.zoneId !== z && mergeZones.has(q.zoneId)) {
            if (free < env.front - 1e-9) {
              const e = endsOf(byId.get(p.id)!);
              issues.push({
                code: 'path-merge-zones-too-close', severity: 'warning', key: `${z}>${q.zoneId}:${p.id}`, pathId: p.id,
                ...(e ? { position: e.end.position } : {}),
                detail: `Only ${free.toFixed(2)} m free between merge zone '${z}' and '${q.zoneId}' — a vehicle (front ${env.front.toFixed(2)} m) waiting for the next zone blocks the previous one.`,
              });
            }
            break;
          }
          if (q.zoneId) break; // another (non-merge) zone ends the free run
          free += q.length;
          q = q.successors.length === 1 ? q.successors[0] : null;
        }
      }
    }
  }

  return { issues: sortIssues(issues), envelope: env, envelopeSource: env ? (opts.envelopeSource ?? 'explicit') : 'none', skipped };
}

