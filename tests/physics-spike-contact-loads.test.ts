// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// plan-467 Phase 0 — contact-load spike against REAL Rapier WASM (0.19.3).
//
// Question: does a MANIFOLD-based contact channel
//   F_i = (impulse_i · n + tangentImpulse_i · t) / dt   per contact point
// deliver the FULL wrench (including friction drag, Fx ≠ 0 while the plate
// travels horizontally) that `TempContactForceEvent.totalForce()` does not?
//
// ANSWER (measured below, all six scenarios):
//  1. The NORMAL part is exact — but only with a solver-iteration correction:
//        F = Σ impulse_i · N / ((N + 1) · dt),  N = numSolverIterations
//     The naive `/dt` overstates by (N+1)/N (1.25 at rapier's default N = 4 —
//     exactly the 12.26 N SOL saw for a 1 kg MU).
//  2. The TANGENT part is NOT AVAILABLE: `contactTangentImpulseX/Y()` return
//     hard 0 in 0.19.3, even under sustained slip. The manifold channel is
//     therefore just as friction-blind as `totalForce()`.
//  3. Friction IS observable through the MU's own momentum balance
//     (scenario g), which is the channel plan-467 F6 has to switch to.
//
// Unlike tests/physics-spike-handover.test.ts this spike does NOT skip
// gracefully: the package is a hard precondition (plan-467 F15), a missing
// install must FAIL loudly.
//
// @dimforge/rapier3d-compat is installed OUT-OF-BAND
// (`npm i --no-save @dimforge/rapier3d-compat@0.19.3`, see
// ../realvirtual-WebViewer-Private~/src/physics/README.md). Import strategy is
// the one empirically fixed in plan-276 Phase 0: a variable-indirection
// `/node_modules/...` URL import, the only form Vite leaves untouched.

import { describe, it, expect, beforeAll } from 'vitest';
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';

// ── Minimal structural types for the API surface used by this spike ─────────
// Deliberately local: the out-of-band package must not be a type dependency —
// `npx tsc --noEmit` has to pass on machines without the package installed.

interface Vec3 { x: number; y: number; z: number }

interface SpikeRigidBody {
  translation(): Vec3;
  linvel(): Vec3;
  mass(): number;
  isSleeping(): boolean;
  setNextKinematicTranslation(t: Vec3): void;
}

interface SpikeRigidBodyDesc {
  setTranslation(x: number, y: number, z: number): SpikeRigidBodyDesc;
}

interface SpikeColliderDesc {
  setFriction(f: number): SpikeColliderDesc;
  setRestitution(r: number): SpikeColliderDesc;
  setMass(m: number): SpikeColliderDesc;
  setActiveEvents(e: number): SpikeColliderDesc;
  setContactForceEventThreshold(t: number): SpikeColliderDesc;
}

interface SpikeManifold {
  normal(): Vec3;
  numContacts(): number;
  numSolverContacts(): number;
  solverContactPoint(i: number): Vec3;
  contactImpulse(i: number): number;
  contactTangentImpulseX(i: number): number;
  contactTangentImpulseY(i: number): number;
}

interface SpikeCollider {
  handle: number;
  parent(): SpikeRigidBody | null;
}

interface SpikeForceEvent {
  totalForce(): Vec3;
}

interface SpikeEventQueue {
  drainContactForceEvents(cb: (e: SpikeForceEvent) => void): void;
  free(): void;
}

interface SpikeIntegrationParameters {
  numSolverIterations: number;
}

interface SpikeWorld {
  timestep: number;
  integrationParameters: SpikeIntegrationParameters;
  step(events?: SpikeEventQueue): void;
  createRigidBody(desc: SpikeRigidBodyDesc): SpikeRigidBody;
  createCollider(desc: SpikeColliderDesc, parent?: SpikeRigidBody): SpikeCollider;
  contactPairsWith(collider1: SpikeCollider, cb: (other: SpikeCollider) => void): void;
  contactPair(
    c1: SpikeCollider,
    c2: SpikeCollider,
    cb: (m: SpikeManifold, flipped: boolean) => void
  ): void;
  free(): void;
}

interface SpikeRapier {
  init(): Promise<void>;
  World: new (gravity: Vec3) => SpikeWorld;
  EventQueue: new (autoDrain: boolean) => SpikeEventQueue;
  RigidBodyDesc: {
    dynamic(): SpikeRigidBodyDesc;
    kinematicPositionBased(): SpikeRigidBodyDesc;
  };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): SpikeColliderDesc;
  };
  ActiveEvents: { CONTACT_FORCE_EVENTS: number };
}

const DT = PHYSICS_FIXED_DT;
const G = 9.81;
const MU_MASS = 1; // kg
const MU_HALF = 0.1; // m  → 0.2 m cube
const PLATE_HALF_Y = 0.025; // m → 0.05 m thick plate, top face at y = 0
const PLATE_Y = -PLATE_HALF_Y;
const FRICTION = 0.8;

/** Out-of-band import seam — URL path, resolved by the vitest browser dev server. */
const RAPIER_MJS_URL = '/node_modules/@dimforge/rapier3d-compat/rapier.mjs';

let RAPIER: SpikeRapier;

beforeAll(async () => {
  // NO graceful skip (plan-467 F15): a missing package is a hard failure.
  let mod: SpikeRapier;
  try {
    mod = (await import(/* @vite-ignore */ RAPIER_MJS_URL)) as SpikeRapier;
  } catch (err) {
    throw new Error(
      '@dimforge/rapier3d-compat is NOT installed. This spike requires the real WASM. ' +
        'Run `npm i --no-save @dimforge/rapier3d-compat@0.19.3` in ' +
        'Assets/realvirtual-WebViewer~ (see ' +
        '../realvirtual-WebViewer-Private~/src/physics/README.md). Original error: ' +
        String(err)
    );
  }
  await mod.init();
  RAPIER = mod;
}, 60000);

// ── Vector helpers ───────────────────────────────────────────────────────────

const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const fmt = (a: Vec3): string =>
  `(${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${a.z.toFixed(3)})`;

/**
 * Impulse→force normalisation of rapier's small-steps (TGS-Soft) solver.
 *
 * Measured law (exact for N ∈ {1,2,3,4,8}, independent of dt and of
 * `numInternalPgsIterations`): the accumulated `contactImpulse` corresponds to
 * (N+1) substeps of dt/N, so the effective integration window is
 * dt·(N+1)/N, NOT dt.
 */
function impulseScale(world: SpikeWorld, dt: number): number {
  const n = world.integrationParameters.numSolverIterations;
  return n / ((n + 1) * dt);
}

// ── Channel 1: the manifold channel under test (plan-467 F6 as planned) ─────

interface Wrench {
  F: Vec3; // force ON the target collider (N)
  M: Vec3; // moment about the WORLD ORIGIN (N·m)
  tangentSum: number; // Σ |tangentImpulseX| + |tangentImpulseY| — 0 ⇒ no friction data
  points: number;
  manifolds: number;
  flipped: boolean | null;
  numContacts: number;
  numSolverContacts: number;
  normal: Vec3 | null;
}

/**
 * Sums the contact wrench acting ON `target` from every collider in contact.
 *
 *   dir1        = -manifold.normal()                (rapier's `force_dir1`)
 *   [t0, t1]    = orthonormalBasis(dir1)            (nalgebra Duff ONB)
 *   F_body1_i   = (dir1·imp_i + t0·tix_i + t1·tiy_i) · N/((N+1)·dt)
 *   F_target_i  = flipped ? -F_body1_i : F_body1_i
 *   M          += p_i × F_target_i                  (p_i = solverContactPoint, world)
 *
 * `flipped === true` means the manifold's own collider1 is the collider passed
 * as the SECOND argument, i.e. our target is the manifold's body2.
 */
function contactWrenchOn(world: SpikeWorld, target: SpikeCollider, dt: number): Wrench {
  const out: Wrench = {
    F: v3(), M: v3(), tangentSum: 0, points: 0, manifolds: 0,
    flipped: null, numContacts: 0, numSolverContacts: 0, normal: null,
  };
  const k = impulseScale(world, dt);
  world.contactPairsWith(target, (other) => {
    world.contactPair(target, other, (m, flipped) => {
      out.manifolds++;
      const n = m.normal();
      out.normal = v3(n.x, n.y, n.z);
      const dir1 = scale(n, -1);
      const [t0, t1] = orthonormalBasis(dir1);
      const nc = m.numContacts();
      const ns = m.numSolverContacts();
      out.numContacts += nc;
      out.numSolverContacts += ns;
      out.flipped = flipped;
      const sgn = flipped ? -1 : 1;
      for (let i = 0; i < nc; i++) {
        const ni = m.contactImpulse(i);
        const tix = m.contactTangentImpulseX(i);
        const tiy = m.contactTangentImpulseY(i);
        out.tangentSum += Math.abs(tix) + Math.abs(tiy);
        if (ni === 0 && tix === 0 && tiy === 0) continue;
        const Fi = scale(add(add(scale(dir1, ni), scale(t0, tix)), scale(t1, tiy)), sgn * k);
        const p = i < ns ? m.solverContactPoint(i) : v3();
        out.F = add(out.F, Fi);
        out.M = add(out.M, cross(v3(p.x, p.y, p.z), Fi));
        out.points++;
      }
    });
  });
  return out;
}

/**
 * Orthonormal tangent basis of `n`, reproducing nalgebra's
 * `Vector3::orthonormal_subspace_basis` (branchless Duff et al. ONB) — the
 * basis rapier's contact solver expresses `tangent_impulse` in. Rapier builds
 * it from `force_dir1 = -normal`.
 */
function orthonormalBasis(n: Vec3): [Vec3, Vec3] {
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  return [
    v3(1 + sign * n.x * n.x * a, sign * b, -sign * n.x),
    v3(b, sign + n.y * n.y * a, -n.y),
  ];
}

// ── Channel 2: momentum balance of the contacting dynamic bodies ────────────

/**
 * The wrench a set of dynamic bodies exerts ON `target`, derived from THEIR
 * momentum balance instead of from solver impulses:
 *
 *   F_contact_on_MU  = m · (a − g)          Newton, a = Δv/dt of this tick
 *   F_on_target      = −F_contact_on_MU = m·g − m·a
 *   M_on_target      = Σ w_i · (p_i × F_on_target), w_i = imp_i / Σ imp
 *
 * Friction is INCLUDED by construction — this is the only channel in
 * rapier3d-compat 0.19.3 that sees it. The normal impulses are still used, but
 * only as WEIGHTS to distribute the force over the contact points (moment arm).
 */
function newtonWrenchOn(
  world: SpikeWorld,
  target: SpikeCollider,
  prevVel: Map<number, Vec3>,
  dt: number
): { F: Vec3; M: Vec3; bodies: number } {
  let F = v3();
  let M = v3();
  let bodies = 0;
  world.contactPairsWith(target, (other) => {
    const body = other.parent();
    if (!body) return;
    bodies++;
    const v = body.linvel();
    const p0 = prevVel.get(other.handle) ?? v3();
    const a = v3((v.x - p0.x) / dt, (v.y - p0.y) / dt, (v.z - p0.z) / dt);
    const m = body.mass();
    // Force the body exerts ON the target: m·g − m·a
    const Fb = v3(-m * a.x, -m * G - m * a.y, -m * a.z);
    F = add(F, Fb);
    // Distribute over the contact points of THIS pair, weighted by normal impulse
    const pts: Vec3[] = [];
    const w: number[] = [];
    let wsum = 0;
    world.contactPair(target, other, (mf) => {
      const nc = Math.min(mf.numContacts(), mf.numSolverContacts());
      for (let i = 0; i < nc; i++) {
        const imp = mf.contactImpulse(i);
        const sp = mf.solverContactPoint(i);
        pts.push(v3(sp.x, sp.y, sp.z));
        w.push(imp);
        wsum += imp;
      }
    });
    if (pts.length > 0 && wsum > 0) {
      for (let i = 0; i < pts.length; i++) M = add(M, cross(pts[i], scale(Fb, w[i] / wsum)));
    }
  });
  return { F, M, bodies };
}

function snapshotVel(world: SpikeWorld, target: SpikeCollider, into: Map<number, Vec3>): void {
  into.clear();
  world.contactPairsWith(target, (other) => {
    const b = other.parent();
    if (b) {
      const v = b.linvel();
      into.set(other.handle, v3(v.x, v.y, v.z));
    }
  });
}

// ── Scene builder ────────────────────────────────────────────────────────────

interface Rig {
  world: SpikeWorld;
  plate: SpikeRigidBody;
  plateCol: SpikeCollider;
  mu: SpikeRigidBody;
  events: SpikeEventQueue;
}

function makeRig(opts: { muX?: number; muFirst?: boolean; friction?: number } = {}): Rig {
  const muX = opts.muX ?? 0;
  const fr = opts.friction ?? FRICTION;
  const world = new RAPIER.World(v3(0, -G, 0));
  world.timestep = DT;
  const events = new RAPIER.EventQueue(true);

  const mkPlate = (): [SpikeRigidBody, SpikeCollider] => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, PLATE_Y, 0)
    );
    const col = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, PLATE_HALF_Y, 0.5)
        .setFriction(fr)
        .setRestitution(0)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      body
    );
    return [body, col];
  };
  const mkMu = (): SpikeRigidBody => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(muX, MU_HALF + 0.002, 0)
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(MU_HALF, MU_HALF, MU_HALF)
        .setMass(MU_MASS) // ColliderDesc.setMass → RigidBody.mass() === 1 exactly
        .setFriction(fr)
        .setRestitution(0),
      body
    );
    return body;
  };

  // Creation ORDER decides which collider becomes rapier's collider1 in a pair.
  let plate: SpikeRigidBody, plateCol: SpikeCollider, mu: SpikeRigidBody;
  if (opts.muFirst) {
    mu = mkMu();
    [plate, plateCol] = mkPlate();
  } else {
    [plate, plateCol] = mkPlate();
    mu = mkMu();
  }
  return { world, plate, plateCol, mu, events };
}

function freeRig(rig: Rig): void {
  rig.events.free();
  rig.world.free();
}

// ── Spike scenarios ─────────────────────────────────────────────────────────

describe('physics spike: manifold contact loads (plan-467 Phase 0)', () => {
  it('a) REST: normalised manifold wrench on a kinematic plate is (0, -9.81, 0) N', () => {
    const rig = makeRig();
    try {
      expect(rig.mu.mass()).toBeCloseTo(1, 6); // ColliderDesc.setMass(1) path
      const N = rig.world.integrationParameters.numSolverIterations;

      // Warm-up + settle detection
      const fyHist: number[] = [];
      for (let t = 0; t < 120; t++) {
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        fyHist.push(contactWrenchOn(rig.world, rig.plateCol, DT).F.y);
      }
      const settleTick = fyHist.findIndex(
        (_fy, i) =>
          i + 10 <= fyHist.length &&
          fyHist.slice(i, i + 10).every((f) => Math.abs(f + G) < 0.05 * G)
      );

      // Measure over 60 ticks
      let sum = v3();
      let sumM = v3();
      let tangentSum = 0;
      let diag: Wrench | null = null;
      let tfSum = v3();
      let tfCount = 0;
      for (let t = 0; t < 60; t++) {
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents((e) => {
          const f = e.totalForce();
          tfSum = add(tfSum, v3(f.x, f.y, f.z));
          tfCount++;
        });
        const w = contactWrenchOn(rig.world, rig.plateCol, DT);
        sum = add(sum, w.F);
        sumM = add(sumM, w.M);
        tangentSum += w.tangentSum;
        diag = w;
      }
      const F = scale(sum, 1 / 60);
      const M = scale(sumM, 1 / 60);
      const tfAvg = tfCount > 0 ? scale(tfSum, 1 / tfCount) : v3();
      const rawFy = F.y * ((N + 1) / N); // what a naive impulse/dt would report

      console.log(
        `[spike-467 a] REST F=${fmt(F)} N  M=${fmt(M)} N·m  settleTick(|Fy+9.81|<5%)=${settleTick}\n` +
          `             numSolverIterations=${N} → scale N/((N+1)·dt); naive impulse/dt would give ` +
          `Fy=${rawFy.toFixed(4)} N (= SOL's 12.26 N)\n` +
          `             manifolds=${diag!.manifolds} numContacts=${diag!.numContacts} ` +
          `numSolverContacts=${diag!.numSolverContacts} flipped=${diag!.flipped} ` +
          `normal=${fmt(diag!.normal!)} Σ|tangentImpulse|=${tangentSum}\n` +
          `             totalForce() avg=${fmt(tfAvg)} (${tfCount} events / 60 ticks)`
      );

      expect(diag!.manifolds).toBe(1);
      expect(diag!.numContacts).toBe(4); // box-on-box → 4 corner points
      expect(Math.abs(F.y + G)).toBeLessThan(0.05 * G);
      expect(Math.abs(F.x)).toBeLessThan(0.05 * G);
      expect(Math.abs(F.z)).toBeLessThan(0.05 * G);
      // MU is centred → no moment about the world origin
      expect(Math.abs(M.x)).toBeLessThan(0.15);
      expect(Math.abs(M.z)).toBeLessThan(0.15);
      expect(settleTick).toBeGreaterThanOrEqual(0);
      expect(settleTick).toBeLessThan(60);
      // Documented: the naive /dt normalisation is off by exactly (N+1)/N
      expect(Math.abs(rawFy + G * ((N + 1) / N))).toBeLessThan(0.05 * G);
    } finally {
      freeRig(rig);
    }
  }, 60000);

  it('b) FRICTION: the manifold channel is BLIND to it — tangentImpulse is hard 0', () => {
    const rig = makeRig();
    const prev = new Map<number, Vec3>();
    try {
      for (let t = 0; t < 120; t++) rig.world.step(rig.events);
      rig.events.drainContactForceEvents(() => {});

      const x0 = rig.mu.translation().x;
      const fxHist: number[] = [];
      const nxHist: number[] = [];
      const tfxHist: number[] = [];
      let tangentSum = 0;
      const ticks = 60; // 1 s
      for (let t = 0; t < ticks; t++) {
        snapshotVel(rig.world, rig.plateCol, prev);
        rig.plate.setNextKinematicTranslation(v3(0.3 * (t + 1) * DT, PLATE_Y, 0));
        rig.world.step(rig.events);
        let tfx = 0;
        rig.events.drainContactForceEvents((e) => {
          tfx += e.totalForce().x;
        });
        const w = contactWrenchOn(rig.world, rig.plateCol, DT);
        const nw = newtonWrenchOn(rig.world, rig.plateCol, prev, DT);
        tangentSum += w.tangentSum;
        nxHist.push(w.F.x); // manifold channel
        fxHist.push(nw.F.x); // momentum channel
        tfxHist.push(tfx);
      }
      const dx = rig.mu.translation().x - x0;
      const iPeak = fxHist.reduce((b, f, i) => (Math.abs(f) > Math.abs(fxHist[b]) ? i : b), 0);

      console.log(
        `[spike-467 b] FRICTION Δx(MU, 1 s)=${dx.toFixed(4)} m  finalVx=${rig.mu.linvel().x.toFixed(4)} m/s\n` +
          `             MANIFOLD Fx first 30 = [${nxHist.slice(0, 30).map((f) => f.toFixed(2)).join(', ')}]\n` +
          `             Σ|tangentImpulse| over 60 ticks = ${tangentSum}  ← hard zero, no friction data\n` +
          `             MOMENTUM Fx first 30 = [${fxHist.slice(0, 30).map((f) => f.toFixed(2)).join(', ')}]\n` +
          `             peak tick=${iPeak} Fx=${fxHist[iPeak].toFixed(3)} N\n` +
          `             totalForce().x first 30 = [${tfxHist.slice(0, 30).map((f) => f.toFixed(3)).join(', ')}]`
      );

      // The MU IS dragged along — friction is physically active…
      expect(dx).toBeGreaterThan(0.05);
      // …but the manifold channel reports no tangential impulse whatsoever
      expect(tangentSum).toBe(0);
      expect(Math.abs(nxHist[iPeak])).toBeLessThan(0.05);
      // …and `totalForce()` is friction-blind too (SOL R1 #1, re-verified)
      expect(Math.abs(tfxHist[iPeak])).toBeLessThan(0.5);
      // The momentum channel DOES see it, with the reaction pointing −x
      // (the MU drags the plate backwards while being accelerated forwards)
      expect(fxHist[iPeak]).toBeLessThan(-0.5);
    } finally {
      freeRig(rig);
    }
  }, 60000);

  it('c) ACCELERATION: plate lifting at 0.5 m/s² reports Fy ≈ -10.31 N', () => {
    const rig = makeRig();
    try {
      for (let t = 0; t < 120; t++) rig.world.step(rig.events);
      rig.events.drainContactForceEvents(() => {});

      const A = 0.5; // m/s²
      const fyHist: number[] = [];
      for (let t = 0; t < 120; t++) {
        const tau = (t + 1) * DT;
        rig.plate.setNextKinematicTranslation(v3(0, PLATE_Y + 0.5 * A * tau * tau, 0));
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        fyHist.push(contactWrenchOn(rig.world, rig.plateCol, DT).F.y);
      }
      const tail = fyHist.slice(-30);
      const Fy = tail.reduce((s, f) => s + f, 0) / tail.length;
      const expected = -(G + A);
      console.log(
        `[spike-467 c] ACCEL Fy(last 30 ticks avg)=${Fy.toFixed(3)} N  expected=${expected.toFixed(3)} N  ` +
          `err=${(((Fy - expected) / expected) * 100).toFixed(2)} %\n` +
          `             Fy first 20 = [${fyHist.slice(0, 20).map((f) => f.toFixed(2)).join(', ')}]`
      );
      expect(Math.abs(Fy - expected)).toBeLessThan(Math.abs(expected) * 0.05);
    } finally {
      freeRig(rig);
    }
  }, 60000);

  it('d) MOMENT: eccentric MU at x=0.3 m gives Mz ≈ -2.943 N·m about the world origin', () => {
    const rig = makeRig({ muX: 0.3 });
    try {
      for (let t = 0; t < 120; t++) rig.world.step(rig.events);
      rig.events.drainContactForceEvents(() => {});

      let sumM = v3();
      let sumF = v3();
      for (let t = 0; t < 60; t++) {
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        const w = contactWrenchOn(rig.world, rig.plateCol, DT);
        sumM = add(sumM, w.M);
        sumF = add(sumF, w.F);
      }
      const M = scale(sumM, 1 / 60);
      const F = scale(sumF, 1 / 60);
      const expectedMz = 0.3 * -G; // p × F with p=(0.3,0,0), F=(0,-9.81,0)
      console.log(
        `[spike-467 d] MOMENT M=${fmt(M)} N·m  F=${fmt(F)} N  expected Mz=${expectedMz.toFixed(3)} N·m  ` +
          `muX=${rig.mu.translation().x.toFixed(4)}`
      );
      expect(Math.abs(M.z - expectedMz)).toBeLessThan(Math.abs(expectedMz) * 0.05);
      expect(Math.abs(M.x)).toBeLessThan(0.15);
      expect(Math.abs(M.y)).toBeLessThan(0.15);
    } finally {
      freeRig(rig);
    }
  }, 60000);

  it('e) SLEEP: manifold and impulses SURVIVE sleep with the correct value; plate motion wakes the MU', () => {
    const rig = makeRig();
    try {
      let sleptAt = -1;
      for (let t = 0; t < 180; t++) {
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        if (sleptAt < 0 && rig.mu.isSleeping()) sleptAt = t;
      }
      const sleeping = rig.mu.isSleeping();
      const w = contactWrenchOn(rig.world, rig.plateCol, DT);

      // Do force events still fire while asleep?
      let eventsWhileAsleep = 0;
      for (let t = 0; t < 10; t++) {
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {
          eventsWhileAsleep++;
        });
      }
      const wAfter = contactWrenchOn(rig.world, rig.plateCol, DT);

      console.log(
        `[spike-467 e] SLEEP isSleeping=${sleeping} (first at tick ${sleptAt})\n` +
          `             manifolds=${w.manifolds} numContacts=${w.numContacts} ` +
          `numSolverContacts=${w.numSolverContacts} pointsWithImpulse=${w.points}\n` +
          `             F=${fmt(w.F)} N (10 ticks later: ${fmt(wAfter.F)} N)  ` +
          `contactForceEvents in 10 ticks=${eventsWhileAsleep}`
      );

      // Wake-up: lift the plate at 0.2 m/s and see whether the MU follows
      const y0 = rig.mu.translation().y;
      const follow: number[] = [];
      let wokeAt = -1;
      for (let t = 0; t < 5; t++) {
        rig.plate.setNextKinematicTranslation(v3(0, PLATE_Y + 0.2 * (t + 1) * DT, 0));
        rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        if (wokeAt < 0 && !rig.mu.isSleeping()) wokeAt = t;
        follow.push(rig.mu.translation().y - y0);
      }
      const wLift = contactWrenchOn(rig.world, rig.plateCol, DT);
      console.log(
        `[spike-467 e] WAKE wokeAtTick=${wokeAt} Δy after 5 ticks=${(follow[4] * 1000).toFixed(3)} mm  ` +
          `(plate moved ${(0.2 * 5 * DT * 1000).toFixed(3)} mm)  F=${fmt(wLift.F)} N`
      );

      // Documented behaviour (asserted so a regression is loud):
      expect(sleeping).toBe(true);
      expect(w.manifolds).toBe(1); // manifold SURVIVES sleep
      expect(w.numContacts).toBe(4); // …and so do the contact points
      expect(w.points).toBe(4); // …and the impulses are non-zero
      expect(Math.abs(w.F.y + G)).toBeLessThan(0.05 * G); // …and still correct
      expect(Math.abs(wAfter.F.y + G)).toBeLessThan(0.05 * G); // frozen, not decaying
      expect(wokeAt).toBeGreaterThanOrEqual(0);
      expect(wokeAt).toBeLessThan(5);
      expect(follow[4]).toBeGreaterThan(0); // follows the plate
    } finally {
      freeRig(rig);
    }
  }, 60000);

  it('f) SIGN / ROLE SWAP: creation order (plate first vs MU first) does not change the wrench', () => {
    const measure = (muFirst: boolean) => {
      const rig = makeRig({ muFirst });
      try {
        for (let t = 0; t < 120; t++) rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        let sum = v3();
        let flipped: boolean | null = null;
        let normal: Vec3 | null = null;
        for (let t = 0; t < 60; t++) {
          rig.world.step(rig.events);
          rig.events.drainContactForceEvents(() => {});
          const w = contactWrenchOn(rig.world, rig.plateCol, DT);
          sum = add(sum, w.F);
          flipped = w.flipped;
          normal = w.normal;
        }
        return { F: scale(sum, 1 / 60), flipped, normal };
      } finally {
        freeRig(rig);
      }
    };

    const plateFirst = measure(false);
    const muFirst = measure(true);
    console.log(
      `[spike-467 f] plateFirst: F=${fmt(plateFirst.F)} flipped=${plateFirst.flipped} normal=${fmt(plateFirst.normal!)}\n` +
        `             muFirst   : F=${fmt(muFirst.F)} flipped=${muFirst.flipped} normal=${fmt(muFirst.normal!)}`
    );
    expect(Math.abs(plateFirst.F.y + G)).toBeLessThan(0.05 * G);
    expect(Math.abs(muFirst.F.y + G)).toBeLessThan(0.05 * G);
    expect(Math.abs(plateFirst.F.y - muFirst.F.y)).toBeLessThan(0.05 * G);
  }, 90000);

  it('g) MOMENTUM CHANNEL: Newton balance of the MU delivers the full wrench incl. friction', () => {
    // Frictionless reference vs. μ = 0.8 — a real (non-tautological) check that
    // the momentum channel picks up friction and obeys the Coulomb bound.
    const run = (friction: number) => {
      const rig = makeRig({ friction });
      const prev = new Map<number, Vec3>();
      try {
        for (let t = 0; t < 120; t++) rig.world.step(rig.events);
        rig.events.drainContactForceEvents(() => {});
        const x0 = rig.mu.translation().x;
        let sumF = v3();
        let sumM = v3();
        for (let t = 0; t < 60; t++) {
          snapshotVel(rig.world, rig.plateCol, prev);
          rig.plate.setNextKinematicTranslation(v3(0.3 * (t + 1) * DT, PLATE_Y, 0));
          rig.world.step(rig.events);
          rig.events.drainContactForceEvents(() => {});
          const nw = newtonWrenchOn(rig.world, rig.plateCol, prev, DT);
          sumF = add(sumF, nw.F);
          sumM = add(sumM, nw.M);
        }
        return {
          F: scale(sumF, 1 / 60),
          M: scale(sumM, 1 / 60),
          dx: rig.mu.translation().x - x0,
          vx: rig.mu.linvel().x,
        };
      } finally {
        freeRig(rig);
      }
    };

    const slick = run(0);
    const grippy = run(0.8);
    console.log(
      `[spike-467 g] μ=0.0: F=${fmt(slick.F)} N  Δx=${slick.dx.toFixed(4)} m  vx=${slick.vx.toFixed(4)}\n` +
        `             μ=0.8: F=${fmt(grippy.F)} N  M=${fmt(grippy.M)} N·m  Δx=${grippy.dx.toFixed(4)} m  vx=${grippy.vx.toFixed(4)}\n` +
        `             Coulomb bound |Fx| ≤ μ·|Fy| = ${(0.8 * Math.abs(grippy.F.y)).toFixed(3)} N`
    );
    // Frictionless: MU stays put, no tangential load
    expect(Math.abs(slick.dx)).toBeLessThan(0.01);
    expect(Math.abs(slick.F.x)).toBeLessThan(0.05);
    // With friction: MU is dragged and a tangential load appears, pointing −x
    expect(grippy.dx).toBeGreaterThan(0.05);
    expect(grippy.F.x).toBeLessThan(-0.02);
    // Coulomb bound holds
    expect(Math.abs(grippy.F.x)).toBeLessThanOrEqual(0.8 * Math.abs(grippy.F.y) + 1e-6);
    // Normal component stays the static weight in both cases
    expect(Math.abs(slick.F.y + G)).toBeLessThan(0.15 * G);
    expect(Math.abs(grippy.F.y + G)).toBeLessThan(0.15 * G);
  }, 90000);
});
