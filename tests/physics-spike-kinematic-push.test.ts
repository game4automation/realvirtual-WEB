// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-spike-kinematic-push.test.ts — plan-467 test 9.5 (Phase 2).
 *
 * The point of the whole plan, measured against REAL Rapier WASM and driven
 * EXCLUSIVELY through the production provider API (`addKinematicBody` /
 * `setKinematicPose` / `addDynamicMU(…, massKg)` / `step` / `syncPoses`) — not
 * against raw Rapier. A green raw-Rapier spike proves the engine can do it; only
 * the provider path proves OUR code does.
 *
 * Four claims:
 *  1. a moving part PUSHES an MU (pose push → contact velocity, F1/F3),
 *  2. a lifting plate CARRIES an MU up,
 *  3. a fast part does not TUNNEL through a thin MU (CCD on the MU, rapier#303),
 *  4. an MU that fell ASLEEP on a stationary part is WOKEN by the pose push
 *     alone — no manual `wakeUp()` (F5; Rapier ≥ 0.19.2).
 *
 * SKIP POLICY (F15): normally this skips gracefully when the out-of-band
 * `@dimforge/rapier3d-compat` is missing (public CI has no such install, pattern
 * from physics-spike-handover.test.ts). In the PRIVATE acceptance run —
 * `RV_PHYSICS_REQUIRE_WASM=1 npx vitest run …`, surfaced to the browser as the
 * `__RV_PHYSICS_REQUIRE_WASM__` define — a skip is a FAILURE: a silent skip here
 * would hide exactly the behaviour the plan exists for (SOL R1 #11: the machine
 * had Rapier 0.12 installed and every physics suite skipped unnoticed).
 *
 * Runs only in the private build (imports `@rv-private/physics/*`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { setRapierLibLoader } from '@rv-private/physics/rapier-lib-loader';
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';
import type { PhysicsPose, PhysicsQuat, PhysicsVec3 } from '../src/core/engine/rv-physics-registry';

const DT = PHYSICS_FIXED_DT;
const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };
const ZONE_CFG = { friction: 0.8, restitution: 0, removeBelowY: -10 };

/** F15 gate — see the skip policy in the file header. */
const REQUIRE_WASM = typeof __RV_PHYSICS_REQUIRE_WASM__ !== 'undefined' && __RV_PHYSICS_REQUIRE_WASM__;

let rapierAvailable = false;

beforeAll(async () => {
  const probe = new RapierPhysicsProvider();
  try {
    await probe.init();
    rapierAvailable = probe.ready;
  } catch {
    rapierAvailable = false;
  }
  probe.dispose();
}, 30000);

/** Build a provider with a zone, or null when Rapier is unavailable. */
async function makeProvider(): Promise<RapierPhysicsProvider | null> {
  if (!rapierAvailable) {
    if (REQUIRE_WASM) {
      throw new Error(
        '[plan-467 F15] RV_PHYSICS_REQUIRE_WASM=1 but @dimforge/rapier3d-compat is not usable — ' +
        'run `npm install` in Assets/realvirtual-WebViewer-Private~ instead of skipping',
      );
    }
    console.warn('[physics-467] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
    return null;
  }
  const provider = new RapierPhysicsProvider();
  provider.addZone('zone', { min: { x: -20, y: -5, z: -20 }, max: { x: 20, y: 20, z: 20 } }, ZONE_CFG);
  await provider.init();
  return provider;
}

function pose(x: number, y: number, z: number): PhysicsPose {
  return { pos: { x, y, z }, quat: Q_IDENT };
}

/** Current world position of a dynamic MU, read through `syncPoses`. */
function muPos(provider: RapierPhysicsProvider, muId: string): PhysicsVec3 {
  const out: PhysicsVec3 = { x: NaN, y: NaN, z: NaN };
  provider.syncPoses((id, p) => {
    if (id !== muId) return;
    out.x = p.x; out.y = p.y; out.z = p.z;
  });
  return out;
}

/** Move a kinematic body along a straight line for `ticks` fixed steps. */
function run(
  provider: RapierPhysicsProvider,
  bodyId: string,
  from: PhysicsVec3,
  vel: PhysicsVec3,
  ticks: number,
): void {
  const p = pose(from.x, from.y, from.z);
  for (let t = 1; t <= ticks; t++) {
    p.pos.x = from.x + vel.x * DT * t;
    p.pos.y = from.y + vel.y * DT * t;
    p.pos.z = from.z + vel.z * DT * t;
    // ORDER IS THE CONTRACT (F3/F4): pose push BEFORE step, never after.
    provider.setKinematicPose(bodyId, p);
    provider.step(DT);
  }
}

beforeEach(() => setRapierLibLoader(null)); // real out-of-band URL loader
afterEach(() => setRapierLibLoader(null));

describe('kinematic moving parts move real MUs (real Rapier WASM, plan-467 9.5)', () => {
  it('a plate driving sideways PUSHES a 1 kg MU along with it', async () => {
    const provider = await makeProvider();
    if (!provider) return;
    try {
      // Floor, a pusher plate to the left of the MU, and the MU itself.
      provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 10, y: 0.1, z: 10 }, Q_IDENT);
      // The plate starts 10 mm short of the MU's left face (MU half 0.1, plate
      // half 0.05 → faces meet at x = -0.15), so almost the whole 0.30 m stroke
      // is actual PUSHING and the assertion measures the take-along rather than
      // an approach gap.
      const plateStart = { x: -0.16, y: 0.2, z: 0 };
      provider.addKinematicBody(
        'kin:pusher',
        { kind: 'cuboid', halfExtents: { x: 0.05, y: 0.2, z: 0.5 }, localOffset: V0 },
        pose(plateStart.x, plateStart.y, plateStart.z),
        false,
      );
      provider.addDynamicMU('mu', pose(0, 0.1, 0), { x: 0.1, y: 0.1, z: 0.1 }, V0, 1);

      // Settle the MU on the floor first, then push for 1 s at 0.3 m/s.
      for (let t = 0; t < 30; t++) provider.step(DT);
      const x0 = muPos(provider, 'mu').x;
      run(provider, 'kin:pusher', plateStart, { x: 0.3, y: 0, z: 0 }, 60);

      const moved = muPos(provider, 'mu').x - x0;
      console.log(`[physics-467 9.5] push: MU travelled ${moved.toFixed(4)} m in 1 s at 0.3 m/s`);
      // Plan 9.5: > 0.25 m of the plate's 0.30 m stroke.
      expect(moved).toBeGreaterThan(0.25);
      expect(provider.failed).toBe(false);
    } finally {
      provider.dispose();
    }
  }, 60000);

  it('a lifting plate CARRIES a resting MU upwards', async () => {
    const provider = await makeProvider();
    if (!provider) return;
    try {
      provider.addKinematicBody(
        'kin:lift',
        { kind: 'cuboid', halfExtents: { x: 0.5, y: 0.05, z: 0.5 }, localOffset: V0 },
        pose(0, 0, 0),
        false,
      );
      provider.addDynamicMU('mu', pose(0, 0.16, 0), { x: 0.1, y: 0.1, z: 0.1 }, V0, 1);

      for (let t = 0; t < 30; t++) provider.step(DT); // land on the plate
      const y0 = muPos(provider, 'mu').y;
      // 0.2 m of travel at 0.4 m/s.
      run(provider, 'kin:lift', { x: 0, y: 0, z: 0 }, { x: 0, y: 0.4, z: 0 }, 30);
      // A couple of settle ticks at the top (the plate holds its last pose).
      const top = pose(0, 0.4 * DT * 30, 0);
      for (let t = 0; t < 10; t++) { provider.setKinematicPose('kin:lift', top); provider.step(DT); }

      const dy = muPos(provider, 'mu').y - y0;
      console.log(`[physics-467 9.5] lift: MU rose ${dy.toFixed(4)} m for a 0.2000 m plate stroke`);
      expect(dy).toBeGreaterThan(0.19);
      expect(dy).toBeLessThan(0.21);
    } finally {
      provider.dispose();
    }
  }, 60000);

  it('a 2 m/s part does NOT tunnel through a thin MU (CCD on the MU, rapier#303)', async () => {
    const provider = await makeProvider();
    if (!provider) return;
    try {
      provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 10, y: 0.1, z: 10 }, Q_IDENT);
      provider.addKinematicBody(
        'kin:fast',
        { kind: 'cuboid', halfExtents: { x: 0.05, y: 0.15, z: 0.5 }, localOffset: V0 },
        pose(-1, 0.15, 0),
        false,
      );
      // 0.05 m thin MU: at 2 m/s the plate covers 33 mm per tick, so a
      // discrete-step solver without CCD steps clean past it.
      provider.addDynamicMU('mu', pose(0, 0.025, 0), { x: 0.025, y: 0.025, z: 0.25 }, V0, 1);

      for (let t = 0; t < 20; t++) provider.step(DT);
      run(provider, 'kin:fast', { x: -1, y: 0.15, z: 0 }, { x: 2, y: 0, z: 0 }, 60);

      const mu = muPos(provider, 'mu');
      const plateX = -1 + 2 * DT * 60;
      console.log(`[physics-467 9.5] tunneling: plate x=${plateX.toFixed(3)}, MU x=${mu.x.toFixed(3)}`);
      // The MU must be AHEAD of the plate's leading face — a tunnelled MU would
      // sit behind it, still near x = 0.
      expect(mu.x).toBeGreaterThan(plateX);
      expect(mu.x).toBeGreaterThan(0.5); // …and have been carried a real distance
    } finally {
      provider.dispose();
    }
  }, 60000);

  it('an MU asleep on a stationary part is woken by the pose push alone (F5, no wakeUp())', async () => {
    const provider = await makeProvider();
    if (!provider) return;
    try {
      const start = pose(0, 0, 0);
      provider.addKinematicBody(
        'kin:table',
        { kind: 'cuboid', halfExtents: { x: 0.5, y: 0.05, z: 0.5 }, localOffset: V0 },
        start,
        false,
      );
      provider.addDynamicMU('mu', pose(0, 0.16, 0), { x: 0.1, y: 0.1, z: 0.1 }, V0, 1);

      // 3 s of standing still — well past Rapier's sleep threshold. The pose is
      // pushed every tick (as production does), it simply never changes.
      for (let t = 0; t < 180; t++) { provider.setKinematicPose('kin:table', start); provider.step(DT); }
      const yAsleep = muPos(provider, 'mu').y;

      // Now the table starts moving. Within 5 ticks the MU must follow.
      run(provider, 'kin:table', { x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 }, 5);
      const dy = muPos(provider, 'mu').y - yAsleep;
      const plateStroke = 0.5 * DT * 5;
      console.log(`[physics-467 9.5] wake: MU rose ${(dy * 1000).toFixed(3)} mm for a ${(plateStroke * 1000).toFixed(3)} mm stroke`);
      expect(dy).toBeGreaterThan(plateStroke * 0.9);
    } finally {
      provider.dispose();
    }
  }, 60000);

  it('a plate moved while NO dynamic body exists does not fling the first MU that arrives (accumulated travel must not become velocity)', async () => {
    // step() skips world.step() with an empty MU map, so Rapier keeps the plate at its old pose while
    // the poses accumulate; the provider resyncs the parts before the first MU (Codex review). Measured on
    // 0.20: the unsynced variant is ALSO harmless for this scene - this pins the behaviour, not a regression.
    const provider = await makeProvider();
    if (!provider) return;
    try {
      provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 10, y: 0.1, z: 10 }, Q_IDENT);
      provider.addKinematicBody(
        'kin:fast',
        { kind: 'cuboid', halfExtents: { x: 0.05, y: 0.15, z: 0.5 }, localOffset: V0 },
        pose(-1, 0.15, 0),
        false,
      );
      run(provider, 'kin:fast', { x: -1, y: 0.15, z: 0 }, { x: 2, y: 0, z: 0 }, 60); // no MU yet
      provider.addDynamicMU('mu', pose(1, 0.3251, 0), { x: 0.025, y: 0.025, z: 0.25 }, V0, 1); // resting ON the plate's final pose
      const hold = pose(1, 0.15, 0);
      for (let t = 0; t < 30; t++) { provider.setKinematicPose('kin:fast', hold); provider.step(DT); }
      const mu = muPos(provider, 'mu');
      console.log(`[physics-467 9.5] empty-world transition: MU x=${mu.x.toFixed(3)}`);
      expect(Math.abs(mu.x - 1)).toBeLessThan(0.05); // rides on the plate, was not flung by 2 m of accumulated travel
    } finally {
      provider.dispose();
    }
  }, 60000);
});
