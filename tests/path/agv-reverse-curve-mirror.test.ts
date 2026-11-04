// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.8 (SOL #5) — the curve limit of a MIRRORED piece sits on the right
 * stretch.
 *
 * The stub S is ASYMMETRIC: a 4 m straight at the handling position, then a
 * quarter arc (R = 1.5 m) into the lane. A vehicle on the turn piece reverses
 * Turn → S to the start of S, so it meets the ARC first. Reverse speed is high
 * (1200 mm/s) so the curve limit √(aLat·R) = √(0.5·1.5) ≈ 0.866 m/s binds: on
 * the arc the planned speed stays at or below it, on the straight it exceeds it
 * (the limit is not misplaced there), and the reverse plan's static limits hold
 * the arc interval at its MIRRORED bounds as a sorted, contiguous list.
 *
 * Counter-probe: the same plan rebuilt with UNMIRRORED limits (the pre-595 code
 * path, intervals at e.x0 + s0 … e.x0 + s1) drives the arc above the limit —
 * which the authority's `violations` counter cannot see (it checks leader
 * separation only), so the speed oracle here is the independent check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultMovementAuthority, setReverseGateOpen, type MbPlan } from '../../src/core/engine/rv-movement-authority';
import { planProfile, positionAt, speedAt, type LimitPiece, type MotionProfile } from '../../src/core/engine/rv-motion-profile';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindContinuous, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

const J = new Vector3(10, 0, 0);
const R = 1.5;
const LINE = 4;
const A_LAT = 0.5;
const ACC = 0.5;
const VLIM = Math.sqrt(A_LAT * R);

/** Quarter arc ending at J with tangent +x (orientation convention found numerically). */
function arcSegment(): Record<string, unknown> {
  for (const startAngle of [0, 90, 180, 270]) {
    for (const clockwise of [false, true]) {
      for (const center of [[10, 0, -R], [10, 0, R]]) {
        const seg = { kind: 'arc', center, radius: R, startAngle, degrees: 90, clockwise, plane: 'XZ' };
        const p = parsePathExtras({ type: 'Path', version: 1, id: 'probe', segments: [seg] }, 'probe');
        if (!p) continue;
        const e = p.getAbsPosition(p.length, new Vector3());
        const d = p.getAbsDirection(p.length, new Vector3());
        if (e.distanceTo(J) < 1e-6 && d.distanceTo(new Vector3(1, 0, 0)) < 1e-6) return seg;
      }
    }
  }
  throw new Error('no arc orientation ends at J heading +x');
}

/** Lane L0 → Pre → Turn → L1, stub S (straight + arc) → Turn; Pre, Turn and S share the zone M. */
function layout(): { S: RVPath; Turn: RVPath } {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
  };
  const arc = arcSegment();
  const probe = parsePathExtras({ type: 'Path', version: 1, id: 'p2', segments: [arc] }, 'p2')!;
  const a0 = probe.getAbsPosition(0, new Vector3());
  const d0 = probe.getAbsDirection(0, new Vector3());
  const h = a0.clone().addScaledVector(d0, -LINE);
  add({ id: 'L0', segments: [{ kind: 'line', from: [0, 0, 0], to: [7, 0, 0] }], successors: ['Pre'] });
  add({ id: 'Pre', segments: [{ kind: 'line', from: [7, 0, 0], to: [10, 0, 0] }], successors: ['Turn'], zone: 'M', zoneCapacity: 1 });
  add({ id: 'Turn', segments: [{ kind: 'line', from: [10, 0, 0], to: [13, 0, 0] }], successors: ['L1'], zone: 'M', zoneCapacity: 1 });
  add({ id: 'L1', segments: [{ kind: 'line', from: [13, 0, 0], to: [40, 0, 0] }] });
  add({
    id: 'S', segments: [{ kind: 'line', from: [h.x, h.y, h.z], to: [a0.x, a0.y, a0.z] }, arc],
    successors: ['Turn'], zone: 'M', zoneCapacity: 1,
  });
  net.resolveGraph();
  return { S: net.get('S')!, Turn: net.get('Turn')! };
}

/** Max planned speed on the arc / on the straight of the mirrored stub, sampled at 1 ms. */
function sampleStub(plan: Readonly<MbPlan>, profile: MotionProfile, stub: RVPath, from: number): { arc: number; line: number; arcSamples: number } {
  const o = { arc: 0, line: 0, arcSamples: 0 };
  for (let tt = from; tt <= profile.tEnd; tt += 1e-3) {
    const x = positionAt(profile, tt);
    let k = 0;
    while (k + 1 < plan.route.length && x > plan.route[k + 1].x0 + 1e-9) k++;
    const e = plan.route[k];
    if (e.path !== stub) continue;
    const sGeo = e.path.length - (x - e.x0); // mirrored piece
    const v = speedAt(profile, tt);
    if (sGeo > LINE + 1e-6) { o.arc = Math.max(o.arc, v); o.arcSamples++; } else o.line = Math.max(o.line, v);
  }
  return o;
}

/** The static limits as the pre-595 code built them: curvature intervals NOT mirrored. */
function unmirroredLimits(plan: Readonly<MbPlan>, vmax: number): LimitPiece[] {
  const vmax2 = vmax * vmax;
  const out: LimitPiece[] = [];
  const push = (x0: number, x1: number, c0: number): void => {
    if (x1 - x0 <= 1e-12) return;
    const last = out[out.length - 1];
    if (last && last.c0 === c0 && Math.abs(last.x1 - x0) < 1e-12) { last.x1 = x1; return; }
    out.push({ x0, x1, c0, c1: 0 });
  };
  for (const e of plan.route) {
    const ivs = e.path.curvatureIntervals();
    if (ivs.length === 0) { push(e.x0, e.x0 + e.path.length, vmax2); continue; }
    for (const c of ivs) push(e.x0 + c.s0, e.x0 + c.s1, Number.isFinite(c.radiusM) ? Math.min(vmax2, A_LAT * c.radiusM) : vmax2);
  }
  return out;
}

interface Obs { arc: number; line: number; arcSamples: number; arrived: boolean; violations: number; first: Readonly<MbPlan> | null }

function drive(mode: 'continuous' | 'animated'): Obs {
  const { S, Turn } = layout();
  const host = makeHost();
  const root = makeAgvRoot('F', { PathId: 'Turn', StartPosition: 2000, TargetSpeed: 1200, ReverseSpeed: 1200, Acceleration: 500,
    Deceleration: 500, LateralAcceleration: 500, VehicleLength: 2000, VehicleWidth: 1000, ScannerFields: false });
  const mb = getDefaultMovementAuthority(mode === 'continuous' ? 'continuous' : 'des');
  let step: () => void;
  let now: () => number;
  let dispose = (): void => {};
  if (mode === 'continuous') {
    const h: BindContextHandle = bindContinuous(root, host);
    step = () => iterateFixedUpdate(h, TICK);
    now = () => mb.clock.now;
  } else {
    const runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    step = () => { runner.tick(TICK); runner.lateTick(TICK); };
    now = () => runner.getManager().currentTime;
    dispose = () => runner.dispose();
  }
  expect(mb.setDirection('F', -1, [Turn, S])).toBe(true);
  const obs: Obs = { arc: 0, line: 0, arcSamples: 0, arrived: false, violations: 0, first: null };
  let lastVer = -1;
  for (let f = 0; f < 60 * 60; f++) {
    step();
    const t = now();
    const plan = mb.planOf('F')!;
    if (plan.dir !== -1) continue;
    // Sample every APPLIED reverse plan analytically from its adoption on (DES jumps between events).
    const ver = mb.versionOf('F');
    if (ver !== lastVer) {
      lastVer = ver;
      if (!obs.first) obs.first = plan;
      const o = sampleStub(plan, plan.profile, S, t);
      obs.arc = Math.max(obs.arc, o.arc); obs.line = Math.max(obs.line, o.line); obs.arcSamples += o.arcSamples;
    }
    if (plan.stopCause === 'deadend' && t >= plan.profile.tEnd && root.position.distanceTo(S.getAbsPosition(0, new Vector3())) < 1e-6) {
      obs.arrived = true;
      break;
    }
  }
  obs.violations = mb.stats.violations;
  dispose();
  return obs;
}

describe('plan-595 9.8 — mirrored curve limit (asymmetric stub)', () => {
  for (const mode of ['continuous', 'animated'] as const) {
    it(`${mode}: the arc limit applies on the arc, not on the straight`, () => {
      const o = drive(mode);
      expect(o.arrived).toBe(true);
      expect(o.arcSamples).toBeGreaterThan(0);
      expect(o.arc).toBeLessThanOrEqual(VLIM + 1e-6);
      expect(o.line).toBeGreaterThan(VLIM + 0.05);
      expect(o.violations).toBe(0);
    }, 60000);
  }

  it('static limits: arc interval at the mirrored bounds, sorted; counter-probe unmirrored exceeds the limit', () => {
    const o = drive('continuous');
    const plan = o.first!;
    expect(plan).not.toBeNull();
    const e = plan.route.find((r) => r.path.id === 'S')!;
    const L = e.path.length;
    const arcIv = e.path.curvatureIntervals().find((c) => Number.isFinite(c.radiusM))!;
    // Mirrored arc bounds in route coordinates: [x0 + (L − s1), x0 + (L − s0)].
    const m0 = e.x0 + (L - arcIv.s1), m1 = e.x0 + (L - arcIv.s0);
    const lim = plan.staticLimits;
    for (let i = 0; i + 1 < lim.length; i++) expect(lim[i + 1].x0).toBeCloseTo(lim[i].x1, 9); // contiguous + sorted
    const onArc = lim.filter((p) => p.c0 < 1.2 * 1.2 - 1e-9);
    expect(onArc.length).toBe(1);
    expect(onArc[0].x0).toBeCloseTo(m0, 9);
    expect(onArc[0].x1).toBeCloseTo(m1, 9);
    expect(onArc[0].c0).toBeCloseTo(A_LAT * R, 9);
    // The unmirrored placement is a DIFFERENT stretch (the stub is asymmetric).
    expect(Math.abs(e.x0 + arcIv.s0 - m0)).toBeGreaterThan(1);

    // Counter-probe: rebuild the first reverse plan with the pre-595 (unmirrored) limits.
    const bad = unmirroredLimits(plan, 1.2);
    const p = plan.profile;
    const wrong = planProfile(p.t0, p.x0, p.v0, bad, ACC, ACC, p.xStop);
    const w = sampleStub(plan, wrong, e.path, p.t0);
    expect(w.arcSamples).toBeGreaterThan(0);
    expect(w.arc).toBeGreaterThan(VLIM + 0.1); // unmirrored: too fast in the arc …
    expect(o.violations).toBe(0);              // … while `violations` would stay 0 either way
  }, 60000);
});
