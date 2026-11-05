// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Test world for the plan-595 stub manoeuvre (reverse travel), shared by the
 * agv-reverse-* tests.
 *
 * Layout: a one-way rectangle ring (travel +x on z = 0) with THREE stubs at
 * the junctions J_i = (10·i, 0, 0). Each stub is authored from its handling
 * position TOWARD the lane (plan-595 §2.3). Split zones (default): the stub
 * `S_i` has its own capacity-1 zone `K_i`, a short mouth piece `Mouth_i` and
 * the lane pieces `Pre_i` / `Turn_i` share the merge zone `M_i`. `Turn_i` is
 * the merge piece (>= 2 predecessors) — the turn point is its END.
 * `twinAt` adds a second stub `S_ib` (zone `K_ib`) from the other side into the
 * same merge zone — a shared waiting place of two stubs.
 *
 * One driver for the three kernels (continuous, DES Animated, DES
 * FastForward). FastForward drains the run inside one tick, so its geometry is
 * checked by MATERIALISATION: every applied plan is recorded with its adoption
 * time and the poses are re-computed from the plans afterwards.
 */

import { Object3D, Vector3 } from 'three';
import type { BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority, type MbPlan, type MovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { positionAt } from '../../src/core/engine/rv-motion-profile';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import { DESRunner } from '@rv/plugins/des/des-runner';
import type { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import type { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import {
  TICK, makeHost, makeAgvRoot, bindContinuous, bindDes, footprint, satOverlap, stepFleet,
  type AgvTestHost, type BodyExtents, type TestBody,
} from './agv-harness';

export type Mode = 'continuous' | 'animated' | 'fastforward';

/** Parked timer vehicles (`Clock0…`) — {@link delay} runs up to this many timers at once. */
const CLOCKS = 4;

export interface StubLayoutOptions {
  /** Length (m) of the merge-zone piece before each junction (default 3). */
  preLen?: number;
  /** Own stub zone K_i + mouth piece in M_i (default true); false = the stub lies in M_i. */
  split?: boolean;
  /** Junction index with a second stub from the other side into the same merge zone. */
  twinAt?: number;
}

/** Register the ring with three stubs (see the module doc). */
export function stubLayout(opts: StubLayoutOptions = {}): void {
  const preLen = opts.preLen ?? 3;
  const split = opts.split ?? true;
  const net = getDefaultPathNetwork();
  const add = (id: string, from: number[], to: number[], succ: string[], zone?: string): void => {
    net.register(parsePathExtras({
      type: 'Path', version: 1, closed: false, align: [0, 1, 0], id,
      segments: [{ kind: 'line', from, to }], successors: succ, ...(zone ? { zone, zoneCapacity: 1 } : {}),
    }, id)!);
  };
  add('L0', [0, 0, 0], [10 - preLen, 0, 0], ['Pre1']);
  for (let i = 1; i <= 3; i++) {
    const j = 10 * i;
    add(`Pre${i}`, [j - preLen, 0, 0], [j, 0, 0], [`Turn${i}`], `M${i}`);
    add(`Turn${i}`, [j, 0, 0], [j + 3, 0, 0], [`L${i}`], `M${i}`);
    const stub = (id: string, side: number, k: string): void => {
      // handling position (j-4, side·4) -> junction (j, 0): authored toward the lane
      if (split) {
        add(id, [j - 4, 0, side * 4], [j - 1, 0, side * 1], [`Mouth${id.slice(1)}`], k);
        add(`Mouth${id.slice(1)}`, [j - 1, 0, side * 1], [j, 0, 0], [`Turn${i}`], `M${i}`);
      } else {
        add(id, [j - 4, 0, side * 4], [j, 0, 0], [`Turn${i}`], `M${i}`);
      }
    };
    stub(`S${i}`, -1, `K${i}`);
    if (opts.twinAt === i) stub(`S${i}b`, 1, `K${i}b`);
    add(`L${i}`, [j + 3, 0, 0], [i < 3 ? j + 10 - preLen : 40, 0, 0], [i < 3 ? `Pre${i + 1}` : 'R1']);
  }
  add('R1', [40, 0, 0], [40, 0, 10], ['R2']);
  add('R2', [40, 0, 10], [0, 0, 10], ['R3']);
  add('R3', [0, 0, 10], [0, 0, 0], ['L0']);
  for (let k = 0; k < CLOCKS; k++) add(`Park${k}`, [0, 0, 30 + 3 * k], [4, 0, 30 + 3 * k], []);
  net.resolveGraph();
}

/** Forklift body: forks at the rear (front 0.8 m, rear 1.6 m, width 1.0 m). */
export const FORK: BodyExtents = { front: 0.8, rear: 1.6, width: 1.0 };
/** Mesh producing {@link FORK}: root 0.4 m ahead of the body centre. */
export const FORK_MESH: TestBody = { length: 2.4, width: 1.0, rootOffset: -0.4 };
/** A plain cart (centred body). */
export const CAR: BodyExtents = { front: 0.6, rear: 0.6, width: 0.8 };

/** A forklift config (AllowReverse, ReverseSpeed 300 mm/s). */
export function forkCfg(pathId: string, startMm: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { PathId: pathId, StartPosition: startMm, TargetSpeed: 1200, AllowReverse: true, ReverseSpeed: 300,
    ScannerFields: true, VehicleLength: 0, VehicleWidth: 0, ...extra };
}

/** A cart config (centred 1.2 m × 0.8 m body). */
export function carCfg(pathId: string, startMm: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { PathId: pathId, StartPosition: startMm, TargetSpeed: 1000, VehicleLength: 1200, VehicleWidth: 800, ...extra };
}

export interface VehicleSpec { name: string; cfg: Record<string, unknown>; mesh?: TestBody; body: BodyExtents }

interface Snapshot { t: number; plan: MbPlan }

export interface StubWorld {
  mode: Mode;
  mb: MovementAuthority;
  roots: Record<string, Object3D>;
  bodies: Record<string, BodyExtents>;
  /** Observed vehicles (the Clock helper excluded). */
  names: string[];
  /** The signal / event host the vehicles are bound to. */
  hostOf(): AgvTestHost;
  /**
   * Stop `name` for `sec` s of sim time and let it go on — a re-plan disturbance
   * that works in every kernel: Run off/on (continuous), a DES failure/repair.
   */
  pause(name: string, sec: number): void;
  now(): number;
  step(): void;
  done(): boolean;
  /**
   * DES modes: attach the runner's push diagnostics to `ledger`/`registry`, as every start does with
   * the viewer's (plan-2241): DES vehicles are then the units `des:<name>`, never sampled fleet ids.
   */
  bindDiagnostics?(ledger: ProgressLedger, registry: WaitRegistry): void;
  /** DES statistics state of a vehicle (DES modes only). */
  desState?(name: string): string;
  /** FastForward: SAT overlap frames re-computed from the recorded plans (sample step `dt`). */
  materialisedOverlap(dt?: number): { frames: number; samples: number; maxPen: number; pairs: Set<string> };
  dispose(): void;
}

/**
 * Bind the vehicles (plus parked `Clock<k>` vehicles on `Park<k>` that
 * {@link delay} uses as sim-time timers) in one kernel. `simLimit` bounds the run (s).
 */
export function makeStubWorld(mode: Mode, specs: VehicleSpec[], simLimit = 900): StubWorld {
  const host = makeHost();
  const roots: Record<string, Object3D> = {};
  const bodies: Record<string, BodyExtents> = {};
  for (const s of specs) { roots[s.name] = makeAgvRoot(s.name, s.cfg, s.mesh); bodies[s.name] = s.body; }
  for (let k = 0; k < CLOCKS; k++) {
    roots[`Clock${k}`] = makeAgvRoot(`Clock${k}`, { PathId: `Park${k}`, StartPosition: 4000, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
  }
  const all = Object.keys(roots);
  const names = specs.map((s) => s.name);
  const rec = new Map<string, Snapshot[]>();
  let restore = (): void => {};
  const record = (mb: MovementAuthority): void => {
    // Materialisation seam (test only): every applied plan with its adoption time.
    const m = mb as unknown as { applyEvents: (v: { id: string; plan: MbPlan }, now: number) => void };
    const orig = m.applyEvents;
    m.applyEvents = function (this: unknown, v, now) { rec.get(v.id)?.push({ t: now, plan: v.plan }); orig.call(this, v, now); };
    restore = () => { m.applyEvents = orig; };
    for (const n of names) rec.set(n, [{ t: 0, plan: mb.planOf(n)! as MbPlan }]);
  };
  const materialisedOverlap = (dt = 0.05): { frames: number; samples: number; maxPen: number; pairs: Set<string> } => {
    const out = { frames: 0, samples: 0, maxPen: 0, pairs: new Set<string>() };
    let tEnd = 0;
    for (const n of names) for (const sn of rec.get(n)!) tEnd = Math.max(tEnd, sn.t, sn.plan.profile.tEnd);
    const o = names.map(() => new Object3D());
    const idx = names.map(() => 0);
    for (let t = 0; t <= tEnd + 1e-9; t += dt) {
      for (let i = 0; i < names.length; i++) {
        const snaps = rec.get(names[i])!;
        while (idx[i] + 1 < snaps.length && snaps[idx[i] + 1].t <= t + 1e-12) idx[i]++;
        planPose(snaps[idx[i]].plan, t, o[i]);
      }
      out.samples++;
      let hit = false;
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const pen = satOverlap(footprint(o[i], bodies[names[i]]), footprint(o[j], bodies[names[j]]));
          if (pen > 1e-6) { hit = true; out.pairs.add(`${names[i]}|${names[j]}`); out.maxPen = Math.max(out.maxPen, pen); }
        }
      }
      if (hit) out.frames++;
    }
    return out;
  };
  if (mode === 'continuous') {
    const handles: BindContextHandle[] = all.map((n) => bindContinuous(roots[n], host));
    const mb = getDefaultMovementAuthority('continuous');
    let t = 0;
    return {
      mode, mb, roots, bodies, names, hostOf: () => host,
      pause: (name, sec) => {
        host.signalStore!.set(`${name}.Agv.Run`, false);
        delay(sec, () => host.signalStore!.set(`${name}.Agv.Run`, true));
      },
      now: () => mb.clock.now,
      // One host fixed step (plan-632): the step key once, then every vehicle.
      step: () => { stepFleet(host, handles, TICK); t += TICK; },
      done: () => t > simLimit,
      materialisedOverlap,
      dispose: () => restore(),
    };
  }
  const runner = new DESRunner(mode === 'fastforward'
    ? { subMode: 'fastforward', durationSeconds: simLimit }
    : { subMode: 'animated' });
  // A common parent gives every vehicle a node path (`des:<name>`); identity transform.
  const layout = new Object3D();
  for (const n of all) { layout.add(roots[n]); bindDes(runner, roots[n], host); }
  runner.start([], { root: new Object3D() });
  const mgr = runner.getManager();
  const mb = getDefaultMovementAuthority('des');
  if (mode === 'fastforward') record(mb);
  return {
    mode, mb, roots, bodies, names, hostOf: () => host,
    pause: (name, sec) => {
      const adapter = runner.liveInstances.find((i) => i.self.root === roots[name])!.adapter as unknown as { setFailure(f: boolean): void };
      adapter.setFailure(true);
      delay(sec, () => adapter.setFailure(false));
    },
    bindDiagnostics: (progressLedger, waitRegistry) => (runner as unknown as { _bindDiagnostics(t: unknown): void })
      ._bindDiagnostics({ root: layout, host: { ...host, progressLedger, waitRegistry } }),
    now: () => mgr.currentTime,
    step: () => { runner.tick(TICK); runner.lateTick(TICK); },
    done: () => mgr.isComplete || mgr.currentTime > simLimit,
    desState: (name) => (runner.liveInstances.find((i) => i.self.root === roots[name])!.adapter as unknown as DESComponent)
      .getStatistics().currentState,
    materialisedOverlap,
    dispose: () => { restore(); runner.dispose(); },
  };
}

const _dir = new Vector3();
const _z = new Vector3(0, 0, 1);

/** Pose of a vehicle root on `plan` at time t (route coordinate → arc length per the plan's direction). */
export function planPose(plan: MbPlan, t: number, out: Object3D): void {
  const x = positionAt(plan.profile, t);
  let k = 0;
  while (k + 1 < plan.route.length && x > plan.route[k + 1].x0 + 1e-9) k++;
  const e = plan.route[k];
  const local = Math.min(Math.max(0, x - e.x0), e.path.length);
  const s = plan.dir === -1 ? e.path.length - local : local;
  e.path.getAbsPosition(s, out.position);
  e.path.getAbsDirection(s, _dir);
  out.quaternion.setFromUnitVectors(_z, _dir.normalize());
}

/** Sim-time delay through the dwell of a free parked Clock vehicle (works in every kernel). */
export function delay(sec: number, fn: () => void): void {
  const fleet = getDefaultAgvFleet();
  for (let k = 0; k < CLOCKS; k++) {
    const c = fleet.get(`Clock${k}`)!;
    if (c.task) continue;
    c.assign({ destination: `Park${k}`, serviceSec: sec, onServiceEnd: () => { c.clear(); fn(); } });
    return;
  }
  throw new Error('delay(): all timer vehicles are busy');
}

/** SAT overlap of all observed vehicle pairs in the current frame (penetration > 1 µm). */
export function frameOverlap(w: StubWorld): { hit: boolean; maxPen: number; pairs: string[] } {
  const pairs: string[] = [];
  let maxPen = 0;
  for (let i = 0; i < w.names.length; i++) {
    for (let j = i + 1; j < w.names.length; j++) {
      const a = w.names[i], b = w.names[j];
      const pen = satOverlap(footprint(w.roots[a], w.bodies[a]), footprint(w.roots[b], w.bodies[b]));
      if (pen > 1e-6) { pairs.push(`${a}|${b}`); maxPen = Math.max(maxPen, pen); }
    }
  }
  return { hit: pairs.length > 0, maxPen, pairs };
}

/** The stub piece ids of junction i (stub + mouth with split zones). */
export function stubPieces(id: string): string[] {
  const net = getDefaultPathNetwork();
  const out: string[] = [];
  for (let q: RVPath | null = net.get(id); q && out.length < 8;) {
    out.push(q.id);
    q = q.successors.length === 1 && q.successors[0].predecessors.length < 2 ? q.successors[0] : null;
  }
  return out;
}
