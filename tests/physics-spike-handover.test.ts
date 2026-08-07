// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
//
// plan-276 Phase 0 — handover spike against REAL Rapier WASM.
//
// Explores the kinematic→dynamic→kinematic handover moment (conveyor end,
// settle detection, pose read-back, upright discriminator, conveyor friction)
// and empirically fixes the constants in src/core/engine/rv-physics-constants.ts.
//
// @dimforge/rapier3d-compat is installed OUT-OF-BAND (plan-276 § 2.8, Omniverse
// pattern: `npm i --no-save @dimforge/rapier3d-compat@^0.19.3`, no package.json
// entry). Import strategy (empirically verified in Phase 0):
//  - A literal `import('@dimforge/rapier3d-compat')` is HARD-rejected by Vite at
//    transform time when the package is missing ("Failed to resolve import") —
//    the whole test file would fail instead of skipping.
//  - A variable-indirection bare specifier is left untouched by Vite and then
//    fails natively in the browser even when the package IS installed.
//  - A variable-indirection `/node_modules/...` URL import works in vitest
//    browser mode when installed AND rejects at runtime when missing → the
//    only form that supports the required graceful skip. Used below.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  PHYSICS_SETTLE_LIN_VEL,
  PHYSICS_SETTLE_FRAMES,
  PHYSICS_UPRIGHT_TOLERANCE_DEG,
  PHYSICS_FIXED_DT,
} from '../src/core/engine/rv-physics-constants';

// ── Minimal structural types for the API surface used by this spike ─────────
// Deliberately local: the out-of-band package must not be a type dependency —
// `npx tsc --noEmit` has to pass on machines without the package installed
// (plan-276 § 2.8). Do NOT replace with `typeof import('@dimforge/rapier3d-compat')`.

interface Vec3 { x: number; y: number; z: number }
interface Quat { x: number; y: number; z: number; w: number }

interface SpikeRigidBody {
  translation(): Vec3;
  rotation(): Quat;
  linvel(): Vec3;
  setLinvel(vel: Vec3, wakeUp: boolean): void;
}

interface SpikeRigidBodyDesc {
  setTranslation(x: number, y: number, z: number): SpikeRigidBodyDesc;
  setRotation(q: Quat): SpikeRigidBodyDesc;
  setLinvel(x: number, y: number, z: number): SpikeRigidBodyDesc;
}

interface SpikeColliderDesc {
  setFriction(f: number): SpikeColliderDesc;
  setFrictionCombineRule(rule: number): SpikeColliderDesc;
  setRestitution(r: number): SpikeColliderDesc;
}

interface SpikeWorld {
  /** Fixed timestep in seconds — set once; step() itself takes NO dt. */
  timestep: number;
  /** step() optionally takes an EventQueue, never a dt (Rapier 0.19 API). */
  step(): void;
  createRigidBody(desc: SpikeRigidBodyDesc): SpikeRigidBody;
  createCollider(desc: SpikeColliderDesc, parent?: SpikeRigidBody): unknown;
  removeRigidBody(body: SpikeRigidBody): void;
  /** WASM heap is not JS-GC managed — free() is mandatory at the end. */
  free(): void;
}

interface SpikeRapier {
  init(): Promise<void>;
  World: new (gravity: Vec3) => SpikeWorld;
  RigidBodyDesc: {
    dynamic(): SpikeRigidBodyDesc;
    fixed(): SpikeRigidBodyDesc;
    kinematicVelocityBased(): SpikeRigidBodyDesc;
  };
  ColliderDesc: {
    cuboid(hx: number, hy: number, hz: number): SpikeColliderDesc;
  };
  CoefficientCombineRule: { Max: number };
}

const FIXED_DT = PHYSICS_FIXED_DT;

/** Out-of-band import seam — URL path, resolved by the vitest browser dev server. */
const RAPIER_MJS_URL = '/node_modules/@dimforge/rapier3d-compat/rapier.mjs';

let RAPIER: SpikeRapier | null = null;

beforeAll(async () => {
  try {
    const mod = (await import(/* @vite-ignore */ RAPIER_MJS_URL)) as SpikeRapier;
    await mod.init();
    RAPIER = mod;
  } catch {
    RAPIER = null; // package not installed (out-of-band) — tests skip gracefully
  }
}, 30000);

function requireRapier(): boolean {
  if (!RAPIER) {
    console.warn('[spike] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
    return false;
  }
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeWorld(): SpikeWorld {
  const world = new RAPIER!.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  return world;
}

/** Fixed ground cuboid whose top surface sits at world y = topY. */
function addGround(world: SpikeWorld, topY = 0, halfX = 5, halfZ = 5): SpikeRigidBody {
  const halfY = 0.1;
  const body = world.createRigidBody(
    RAPIER!.RigidBodyDesc.fixed().setTranslation(0, topY - halfY, 0)
  );
  world.createCollider(RAPIER!.ColliderDesc.cuboid(halfX, halfY, halfZ), body);
  return body;
}

/** Dynamic cube (half extent 0.1 m) — the spike's stand-in for an MU. */
function addCube(
  world: SpikeWorld,
  pos: Vec3,
  vel: Vec3 = { x: 0, y: 0, z: 0 },
  opts: { friction?: number; rot?: Quat } = {}
): SpikeRigidBody {
  let desc = RAPIER!.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z)
    .setLinvel(vel.x, vel.y, vel.z);
  if (opts.rot) desc = desc.setRotation(opts.rot);
  const body = world.createRigidBody(desc);
  let col = RAPIER!.ColliderDesc.cuboid(0.1, 0.1, 0.1).setRestitution(0);
  if (opts.friction !== undefined) {
    col = col
      .setFriction(opts.friction)
      .setFrictionCombineRule(RAPIER!.CoefficientCombineRule.Max);
  }
  world.createCollider(col, body);
  return body;
}

function speedOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * First tick index at which |linvel| has been < threshold for `frames`
 * CONSECUTIVE ticks (index of the tick completing the streak), or null.
 */
function firstSettleTick(speedHist: number[], threshold: number, frames: number): number | null {
  let streak = 0;
  for (let t = 0; t < speedHist.length; t++) {
    streak = speedHist[t] < threshold ? streak + 1 : 0;
    if (streak >= frames) return t;
  }
  return null;
}

/** Angle in degrees between the body-local up axis (0,1,0) and world up. */
function upAngleDeg(q: Quat): number {
  // (0,1,0) rotated by q — standard quaternion rotation, y column of the matrix
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return (Math.acos(Math.min(1, Math.max(-1, upY))) * 180) / Math.PI;
}

// ── Spike scenarios ───────────────────────────────────────────────────────────

describe('physics spike: kinematic↔dynamic handover (plan-276 Phase 0)', () => {
  it('a) velocity handover kinematic→dynamic: belt-end throw with 0.5 m/s lands and settles', () => {
    if (!requireRapier()) return;
    const world = makeWorld();
    try {
      addGround(world, 0); // 0.5 m below the cube center (cube rests at y=0.1)
      const cube = addCube(world, { x: 0, y: 0.5, z: 0 }, { x: 0.5, y: 0, z: 0 });

      const pos: Vec3[] = [];
      const speed: number[] = [];
      for (let t = 0; t < 120; t++) {
        world.step();
        pos.push({ ...cube.translation() });
        speed.push(speedOf(cube.linvel()));
      }

      // Parabolic flight: moves in +X AND falls simultaneously (tick 12 ≈ 0.2 s,
      // still airborne — touchdown is ~tick 17 for a 0.4 m drop)
      expect(pos[12].x).toBeGreaterThan(0.05);
      expect(pos[12].y).toBeLessThan(0.45);
      // y decreases monotonically during early flight
      for (let t = 1; t <= 12; t++) expect(pos[t].y).toBeLessThanOrEqual(pos[t - 1].y + 1e-9);

      // Lands on the ground: rest center = half extent 0.1 (±1 cm solver slack)
      const last = pos[pos.length - 1];
      expect(Math.abs(last.y - 0.1)).toBeLessThan(0.01);

      // Comes to rest
      expect(speed[speed.length - 1]).toBeLessThan(0.01);

      // Empirical basis for settleFrames: first tick with |linvel| < 0.01
      const landingTick = pos.findIndex((p) => p.y < 0.11);
      const firstCalm = speed.findIndex((s) => s < 0.01);
      console.log(
        `[spike] a) landingTick=${landingTick} firstCalmTick(|v|<0.01)=${firstCalm} ` +
          `finalSpeed=${speed[speed.length - 1].toExponential(2)} finalY=${last.y.toFixed(4)}`
      );
      expect(landingTick).toBeGreaterThan(0);
      expect(firstCalm).toBeGreaterThan(landingTick); // never "calm" mid-flight
      expect(firstCalm).toBeLessThan(120);
    } finally {
      world.free();
    }
  });

  it('b) v=0 handover (stopped belt): cube falls straight down and settles', () => {
    if (!requireRapier()) return;
    const world = makeWorld();
    try {
      addGround(world, 0);
      const cube = addCube(world, { x: 0, y: 0.5, z: 0 }); // zero initial velocity

      const speed: number[] = [];
      for (let t = 0; t < 120; t++) {
        world.step();
        speed.push(speedOf(cube.linvel()));
      }

      const p = cube.translation();
      expect(Math.abs(p.x)).toBeLessThan(0.001); // no lateral drift (< 1 mm)
      expect(Math.abs(p.z)).toBeLessThan(0.001);
      expect(Math.abs(p.y - 0.1)).toBeLessThan(0.01); // rests on ground
      expect(speed[speed.length - 1]).toBeLessThan(0.01);
      console.log(
        `[spike] b) v=0 handover: finalX=${p.x.toExponential(2)} finalY=${p.y.toFixed(4)} ` +
          `firstCalmTick=${speed.findIndex((s) => s < 0.01)}`
      );
    } finally {
      world.free();
    }
  });

  it('c) settle detection: threshold × consecutive-frames matrix (basis for the constants)', () => {
    if (!requireRapier()) return;
    const world = makeWorld();
    try {
      addGround(world, 0);
      const cube = addCube(world, { x: 0, y: 0.5, z: 0 }, { x: 0.5, y: 0, z: 0 });

      const pos: Vec3[] = [];
      const speed: number[] = [];
      for (let t = 0; t < 150; t++) {
        world.step();
        pos.push({ ...cube.translation() });
        speed.push(speedOf(cube.linvel()));
      }
      const landingTick = pos.findIndex((p) => p.y < 0.11);
      expect(landingTick).toBeGreaterThan(0);

      const thresholds = [0.005, 0.01, 0.02, 0.05];
      const frameCounts = [5, 10, 15];
      for (const thr of thresholds) {
        for (const frames of frameCounts) {
          const fire = firstSettleTick(speed, thr, frames);
          console.log(
            `[spike] c) settle matrix thr=${thr} frames=${frames} -> ` +
              `fire@${fire === null ? 'never' : fire} (landing@${landingTick})`
          );
          if (fire !== null) {
            // No combination may fire during flight/impact (before touchdown)
            expect(fire).toBeGreaterThan(landingTick);
          }
        }
      }

      // Chosen combination (rv-physics-constants.ts): must fire reliably —
      // never during flight (asserted above) and within 60 ticks of touchdown.
      const chosen = firstSettleTick(speed, PHYSICS_SETTLE_LIN_VEL, PHYSICS_SETTLE_FRAMES);
      expect(chosen).not.toBeNull();
      expect(chosen! - landingTick).toBeLessThanOrEqual(60);
    } finally {
      world.free();
    }
  });

  it('d) pose read-back without jitter: settled pose is stable, body removal is clean', () => {
    if (!requireRapier()) return;
    const world = makeWorld();
    try {
      addGround(world, 0);
      const cube = addCube(world, { x: 0, y: 0.5, z: 0 }, { x: 0.5, y: 0, z: 0 });

      const pos: Vec3[] = [];
      for (let t = 0; t < 150; t++) {
        world.step();
        pos.push({ ...cube.translation() });
      }

      // Last 10 ticks before removal: positional drift < 1 mm ("pose 1:1, no snap")
      let maxDrift = 0;
      const tail = pos.slice(-10);
      for (let i = 1; i < tail.length; i++) {
        const dx = tail[i].x - tail[0].x;
        const dy = tail[i].y - tail[0].y;
        const dz = tail[i].z - tail[0].z;
        maxDrift = Math.max(maxDrift, Math.sqrt(dx * dx + dy * dy + dz * dz));
      }
      console.log(`[spike] d) pose drift over last 10 ticks: ${(maxDrift * 1000).toFixed(4)} mm`);
      expect(maxDrift).toBeLessThan(0.001);

      // Read final pose, then remove the body (handover back to kinematics)
      const finalPos = { ...cube.translation() };
      const finalRot = { ...cube.rotation() };
      expect(Number.isFinite(finalPos.x + finalPos.y + finalPos.z)).toBe(true);
      expect(Number.isFinite(finalRot.x + finalRot.y + finalRot.z + finalRot.w)).toBe(true);
      // Pose read-back matches the last synced tick exactly (same-tick snapshot)
      expect(finalPos.x).toBe(pos[pos.length - 1].x);
      expect(finalPos.y).toBe(pos[pos.length - 1].y);

      world.removeRigidBody(cube);
      // World keeps stepping cleanly after removal
      for (let t = 0; t < 10; t++) world.step();
    } finally {
      world.free();
    }
  });

  it('e) upright check: 30° ramp rest vs flat rest — 25° tolerance discriminates', () => {
    if (!requireRapier()) return;
    if (!RAPIER) return;
    const world = makeWorld();
    try {
      addGround(world, -0.4, 10, 10); // safety floor below the ramp

      // 30° ramp: fixed cuboid rotated about Z (quaternion for 30° = 2*15°)
      const s15 = Math.sin((15 * Math.PI) / 180);
      const c15 = Math.cos((15 * Math.PI) / 180);
      const rampRot: Quat = { x: 0, y: 0, z: s15, w: c15 };
      const ramp = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0).setRotation(rampRot)
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(1.5, 0.05, 0.75)
          .setFriction(2.0)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max),
        ramp
      );

      // Tipped case: cube dropped onto the tilted face (pre-aligned with the
      // ramp so the rest state is deterministic), high friction keeps it there.
      // Surface normal of the 30° face: (-sin30, cos30, 0).
      const n: Vec3 = { x: -0.5, y: Math.cos((30 * Math.PI) / 180), z: 0 };
      const spawn: Vec3 = {
        x: (0.05 + 0.1 + 0.02) * n.x, // face offset + cube half + 2 cm drop gap
        y: (0.05 + 0.1 + 0.02) * n.y,
        z: 0,
      };
      const tipped = addCube(world, spawn, { x: 0, y: 0, z: 0 }, { friction: 2.0, rot: rampRot });

      // Flat case: cube dropped on the flat floor far from the ramp
      const flat = addCube(world, { x: 3, y: -0.25, z: 0 });

      for (let t = 0; t < 300; t++) world.step();

      const tippedDeg = upAngleDeg(tipped.rotation());
      const flatDeg = upAngleDeg(flat.rotation());
      console.log(
        `[spike] e) upright angles: ramp-rest=${tippedDeg.toFixed(2)}° flat-rest=${flatDeg.toFixed(2)}° ` +
          `(tolerance ${PHYSICS_UPRIGHT_TOLERANCE_DEG}°)`
      );
      // Both bodies still settled where expected
      expect(speedOf(tipped.linvel())).toBeLessThan(0.05);
      expect(speedOf(flat.linvel())).toBeLessThan(0.05);
      // 25° discriminates: tilted rest is clearly above, flat rest clearly below
      expect(tippedDeg).toBeGreaterThan(PHYSICS_UPRIGHT_TOLERANCE_DEG);
      expect(flatDeg).toBeLessThan(PHYSICS_UPRIGHT_TOLERANCE_DEG);
    } finally {
      world.free();
    }
  });

  it('f) conveyor preview: kinematic velocity-based belt drags the cube via friction', () => {
    if (!requireRapier()) return;
    if (!RAPIER) return;
    const world = makeWorld();
    try {
      // Belt: KinematicVelocityBased cuboid, top at y=0, friction 1.5 (Max rule)
      const belt = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(0, -0.05, 0)
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(2, 0.05, 0.5)
          .setFriction(1.5)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max),
        belt
      );
      belt.setLinvel({ x: 0.3, y: 0, z: 0 }, true);

      // Cube resting 1 mm above the belt, zero velocity
      const cube = addCube(world, { x: 0, y: 0.101, z: 0 });

      const xs: number[] = [];
      const vxs: number[] = [];
      for (let t = 0; t < 180; t++) {
        world.step();
        xs.push(cube.translation().x);
        vxs.push(cube.linvel().x);
      }

      // Friction take-along: x grows monotonically (within numeric epsilon)
      for (let t = 1; t < xs.length; t++) {
        expect(xs[t]).toBeGreaterThanOrEqual(xs[t - 1] - 1e-6);
      }
      // Cube approaches belt speed 0.3 m/s
      const finalVx = vxs[vxs.length - 1];
      expect(finalVx).toBeGreaterThan(0.27); // within 10 %

      // Slip metric: ticks until 95 % / 99 % of belt speed
      const t95 = vxs.findIndex((v) => v >= 0.285);
      const t99 = vxs.findIndex((v) => v >= 0.297);
      console.log(
        `[spike] f) conveyor slip: t95%=${t95} t99%=${t99} finalVx=${finalVx.toFixed(4)} ` +
          `beltDrift(kinematic body translates!)=${(0.3 * 180 * FIXED_DT).toFixed(2)} m`
      );
      expect(t95).toBeGreaterThan(-1);
      expect(t95).toBeLessThan(120);
    } finally {
      world.free();
    }
  });
});
