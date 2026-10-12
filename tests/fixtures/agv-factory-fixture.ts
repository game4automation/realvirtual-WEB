// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Headless AGVFactory topology + work plan (plan-558 acceptance fixture).
 *
 * Geometry ported 1:1 from the private generator
 * `projects/DiscreteEventSimulation/tools/agv-factory-paths.mjs` (PATHS,
 * SUCCESSORS, ≤2.5 m splitting, MERGES zones, DRIVE_ORDER placement) and the
 * work plan from `plugins/agv-factory.ts` (Load → WS1/WS2 → WS3). No GLB.
 */

import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type AgvTask } from '../../src/core/engine/rv-agv-fleet';

type Spec = Record<string, unknown> & { kind: string };

const X_END = 11, Z_MAIN = 4, OFFSET = 2.5, S_LEN = 3, DOCK = 2;
const round = (v: number): number => Math.round(v * 1e6) / 1e6;
const v3 = (x: number, z: number): number[] => [round(x), 0, round(z)];
const line = (x0: number, z0: number, x1: number, z1: number): Spec =>
  ({ kind: 'line', from: v3(x0, z0), to: v3(x1, z1) });

function sCurve(x0: number, z0: number, hx: number, sz: number): Spec[] {
  const R = (S_LEN * S_LEN + OFFSET * OFFSET) / (4 * OFFSET);
  const theta = Math.asin(S_LEN / (2 * R));
  const arc = (px: number, pz: number, cx: number, cz: number, tx: number, tz: number) => {
    const a = Math.atan2(pz - cz, px - cx);
    const sign = (-Math.sin(a) * tx + Math.cos(a) * tz) >= 0 ? 1 : -1;
    return {
      spec: {
        kind: 'arc', center: v3(cx, cz), radius: round(R),
        startAngle: round(a * 180 / Math.PI), degrees: round(sign * theta * 180 / Math.PI), plane: 'XZ',
      } as Spec,
      end: [cx + R * Math.cos(a + sign * theta), cz + R * Math.sin(a + sign * theta)],
    };
  };
  const first = arc(x0, z0, x0, z0 + sz * R, hx, 0);
  const [mx, mz] = first.end;
  const x1 = x0 + hx * S_LEN;
  const z1 = z0 + sz * OFFSET;
  const second = arc(mx, mz, x1, z1 - sz * R, hx * Math.cos(theta), sz * Math.sin(theta));
  return [first.spec, second.spec];
}

const zS = -Z_MAIN, zN = Z_MAIN;
const zSD = zS - OFFSET, zND = zN + OFFSET;
const ws1In = -9, ws2In = 1, loadIn = 9, ws3In = -3;

const PATHS: Record<string, Spec[]> = {
  SouthA: [line(-X_END, zS, ws1In, zS)],
  WS1In: sCurve(ws1In, zS, +1, -1),
  WS1: [line(ws1In + S_LEN, zSD, ws1In + S_LEN + DOCK, zSD)],
  WS1Out: sCurve(ws1In + S_LEN + DOCK, zSD, +1, +1),
  SouthB: [line(ws1In, zS, ws1In + 2 * S_LEN + DOCK, zS)],
  SouthC: [line(ws1In + 2 * S_LEN + DOCK, zS, ws2In, zS)],
  WS2In: sCurve(ws2In, zS, +1, -1),
  WS2: [line(ws2In + S_LEN, zSD, ws2In + S_LEN + DOCK, zSD)],
  WS2Out: sCurve(ws2In + S_LEN + DOCK, zSD, +1, +1),
  SouthD: [line(ws2In, zS, ws2In + 2 * S_LEN + DOCK, zS)],
  SouthE: [line(ws2In + 2 * S_LEN + DOCK, zS, X_END, zS)],
  East: [{ kind: 'arc', center: v3(X_END, 0), radius: Z_MAIN, startAngle: -90, degrees: 180, plane: 'XZ' }],
  NorthA: [line(X_END, zN, loadIn, zN)],
  LoadIn: sCurve(loadIn, zN, -1, +1),
  LoadQueue: [line(loadIn - S_LEN, zND, loadIn - S_LEN - DOCK, zND)],
  Load: [line(loadIn - S_LEN - DOCK, zND, loadIn - S_LEN - 2 * DOCK, zND)],
  LoadOut: sCurve(loadIn - S_LEN - 2 * DOCK, zND, -1, -1),
  NorthB: [line(loadIn, zN, loadIn - 2 * S_LEN - 2 * DOCK, zN)],
  NorthC: [line(loadIn - 2 * S_LEN - 2 * DOCK, zN, ws3In, zN)],
  WS3In: sCurve(ws3In, zN, -1, +1),
  WS3: [line(ws3In - S_LEN, zND, ws3In - S_LEN - DOCK, zND)],
  WS3Out: sCurve(ws3In - S_LEN - DOCK, zND, -1, -1),
  NorthD: [line(ws3In, zN, -X_END, zN)],
  West: [{ kind: 'arc', center: v3(-X_END, 0), radius: Z_MAIN, startAngle: 90, degrees: 180, plane: 'XZ' }],
};

const SUCCESSORS: Record<string, string[]> = {
  SouthA: ['SouthB', 'WS1In'], WS1In: ['WS1'], WS1: ['WS1Out'], WS1Out: ['SouthC'],
  SouthB: ['SouthC'], SouthC: ['SouthD', 'WS2In'], WS2In: ['WS2'], WS2: ['WS2Out'],
  WS2Out: ['SouthE'], SouthD: ['SouthE'], SouthE: ['East'], East: ['NorthA'],
  NorthA: ['NorthB', 'LoadIn'], LoadIn: ['LoadQueue'], LoadQueue: ['Load'], Load: ['LoadOut'],
  LoadOut: ['NorthC'], NorthB: ['NorthC'], NorthC: ['NorthD', 'WS3In'], WS3In: ['WS3'],
  WS3: ['WS3Out'], WS3Out: ['West'], NorthD: ['West'], West: ['SouthA'],
};

const MAX_PIECE = 2.5;
const KEEP_WHOLE = /^(WS\d|Load)/;

function splitSpec(spec: Spec, n: number): Spec[] {
  if (spec.kind === 'line') {
    const from = spec.from as number[], to = spec.to as number[];
    return Array.from({ length: n }, (_, i) => {
      const at = (t: number) => from.map((f, k) => round(f + (to[k] - f) * t));
      return { kind: 'line', from: at(i / n), to: at((i + 1) / n) };
    });
  }
  const step = (spec.degrees as number) / n;
  return Array.from({ length: n }, (_, i) => ({
    ...spec, startAngle: round((spec.startAngle as number) + i * step), degrees: round(step),
  }));
}
const specLength = (s: Spec): number => s.kind === 'line'
  ? Math.hypot((s.to as number[])[0] - (s.from as number[])[0], (s.to as number[])[2] - (s.from as number[])[2])
  : (s.radius as number) * Math.abs(s.degrees as number) * Math.PI / 180;

interface GraphNode { id: string; segments: Spec[]; successors: string[]; zone?: string; zoneCapacity?: number }

export interface FactoryLayout { graph: GraphNode[]; driveOrder: string[] }

export function buildFactoryLayout(): FactoryLayout {
  const graph: GraphNode[] = [];
  const ovalOrder: string[] = [];
  for (const [id, segs] of Object.entries(PATHS)) {
    const len = segs.reduce((a, s) => a + specLength(s), 0);
    const n = KEEP_WHOLE.test(id) || segs.length !== 1 ? 1 : Math.max(1, Math.ceil(len / MAX_PIECE - 1e-9));
    const pieces = n === 1 ? [segs] : splitSpec(segs[0], n).map((s) => [s]);
    pieces.forEach((pieceSegs, i) => {
      const pid = i === 0 ? id : `${id}_${i + 1}`;
      const last = i === pieces.length - 1;
      graph.push({ id: pid, segments: pieceSegs, successors: last ? SUCCESSORS[id] : [`${id}_${i + 2}`] });
      if (!KEEP_WHOLE.test(id)) ovalOrder.push(pid);
    });
  }
  const driveOrder = ['SouthA', 'SouthB', 'SouthC', 'SouthD', 'SouthE', 'East', 'NorthA', 'NorthB', 'NorthC', 'NorthD', 'West']
    .flatMap((id) => ovalOrder.filter((p) => p === id || p.startsWith(`${id}_`)));
  const MERGES: Record<string, string[]> = {
    SouthC: ['SouthB', 'WS1Out'], SouthE: ['SouthD', 'WS2Out'], NorthC: ['NorthB', 'LoadOut'], West: ['NorthD', 'WS3Out'],
  };
  const lastPieceOf = (id: string): string =>
    graph.filter((p) => p.id === id || p.id.startsWith(`${id}_`)).at(-1)!.id;
  for (const [out, incoming] of Object.entries(MERGES)) {
    for (const pid of [out, ...incoming.map(lastPieceOf)]) {
      const p = graph.find((g) => g.id === pid)!;
      p.zone = `Merge${out}`;
      p.zoneCapacity = 1;
    }
  }
  return { graph, driveOrder };
}

/** Register the factory graph into the shared path network. */
export function registerFactory(): FactoryLayout {
  const layout = buildFactoryLayout();
  const net = getDefaultPathNetwork();
  for (const p of layout.graph) {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id: p.id, segments: p.segments, closed: false,
      successors: p.successors, align: [0, 1, 0],
      ...(p.zone ? { zone: p.zone, zoneCapacity: p.zoneCapacity } : {}),
    }, p.id)!);
  }
  net.resolveGraph();
  return layout;
}

/** AGV configs as the generator places them (StartPosition offset so the body is on its piece). */
export function factoryAgvConfigs(
  layout: FactoryLayout, count: number, extra: Record<string, unknown> = {},
): Array<[string, Record<string, unknown>]> {
  const stride = layout.driveOrder.length / count;
  const out: Array<[string, Record<string, unknown>]> = [];
  for (let i = 0; i < count; i++) {
    out.push([`AGV_${i + 1}`, {
      PathId: layout.driveOrder[Math.floor(i * stride)], StartPosition: 600, TargetSpeed: 1000, ...extra,
    }]);
  }
  return out;
}

// ── Work plan (plugins/agv-factory.ts, offsets keyed by vehicle NAME, not bind order) ──

const ROUTES: Record<'A' | 'B', Array<{ destination: string; serviceSec: number }>> = {
  A: [{ destination: 'Load', serviceSec: 4 }, { destination: 'WS1', serviceSec: 8 }, { destination: 'WS3', serviceSec: 5 }],
  B: [{ destination: 'Load', serviceSec: 4 }, { destination: 'WS2', serviceSec: 8 }, { destination: 'WS3', serviceSec: 5 }],
};

export interface WorkPlanStats {
  jobsDone: Map<string, number>;
  services: Map<string, number>;
  log: string[];
}

export function installWorkPlan(): { dispatch: () => void; stats: WorkPlanStats } {
  const stats: WorkPlanStats = { jobsDone: new Map(), services: new Map(), log: [] };
  const nextOrder = new Map<string, number>();
  const task = (agvId: string, order: number, step: number): AgvTask => {
    const route = ROUTES[order % 2 === 0 ? 'A' : 'B'];
    return {
      ...route[step],
      onServiceEnd: () => {
        stats.services.set(route[step].destination, (stats.services.get(route[step].destination) ?? 0) + 1);
        const last = step + 1 >= route.length;
        if (last) {
          stats.jobsDone.set(agvId, (stats.jobsDone.get(agvId) ?? 0) + 1);
          nextOrder.set(agvId, order + 1);
        }
        getDefaultAgvFleet().get(agvId)?.assign(last ? task(agvId, order + 1, 0) : task(agvId, order, step + 1));
      },
    };
  };
  const dispatch = (): void => {
    const fleet = getDefaultAgvFleet();
    const all = [...fleet.all()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const agv of all) {
      if (agv.task) continue;
      const idx = Number(agv.id.replace(/\D/g, '')) - 1;
      if (!nextOrder.has(agv.id)) nextOrder.set(agv.id, idx);
      agv.assign(task(agv.id, nextOrder.get(agv.id)!, 0));
    }
  };
  return { dispatch, stats };
}
