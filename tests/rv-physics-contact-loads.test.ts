// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-contact-loads.test.ts — plan-467 test 9.6 (Phase 4).
 *
 * The payload channel, measured against REAL Rapier WASM and driven
 * EXCLUSIVELY through the production provider API (`addKinematicBody` /
 * `addDynamicMU(…, massKg)` / `setKinematicPose` / `step` / `forEachContactLoad`).
 *
 * The two SOL-R2 COUNTEREXAMPLES come first (plan "Restrisiko"-table): they are
 * the reason F6 is a HYBRID channel instead of the MU momentum balance the
 * Phase-0 spike proposed. A pure `m·(g − a)` balance reports 9.81 N in both,
 * where the physical link load is 19.62 N (stacked MUs) and 4.905 N (half the
 * MU rests on static geometry). If these two fail, the channel is wrong — that
 * is a STOP, not something to paper over.
 *
 * SKIP POLICY (F15): identical to physics-spike-kinematic-push.test.ts — a
 * graceful skip without Rapier, but a hard FAILURE under
 * `RV_PHYSICS_REQUIRE_WASM=1` (`__RV_PHYSICS_REQUIRE_WASM__`).
 *
 * Runs only in the private build (imports `@rv-private/physics/*`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { setRapierLibLoader } from '@rv-private/physics/rapier-lib-loader';
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';
import type {
  PhysicsContactLoad, PhysicsPose, PhysicsQuat, PhysicsVec3,
} from '../src/core/engine/rv-physics-registry';

const DT = PHYSICS_FIXED_DT;
const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };
const ZONE_CFG = { friction: 0.8, restitution: 0, removeBelowY: -10 };
const G = 9.81;
/** Half-extent of the demo MU cube (0.2 m edge — the size the spike used). */
const MU_H: PhysicsVec3 = { x: 0.1, y: 0.1, z: 0.1 };

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

/** A kinematic PLATE (cuboid, no collider offset) at `center`. */
function addPlate(
  p: RapierPhysicsProvider,
  id: string,
  center: PhysicsVec3,
  half: PhysicsVec3,
  report = true,
): void {
  p.addKinematicBody(
    id,
    { kind: 'cuboid', halfExtents: half, localOffset: { x: 0, y: 0, z: 0 } },
    { pos: center, quat: Q_IDENT },
    report,
  );
}

/** Contact load of one body after the last `step()` (zeros when it reported none). */
function loadOf(p: RapierPhysicsProvider, bodyId: string): PhysicsContactLoad {
  const out: PhysicsContactLoad = { bodyId, fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 };
  p.forEachContactLoad((l) => {
    if (l.bodyId !== bodyId) return;
    out.fx = l.fx; out.fy = l.fy; out.fz = l.fz;
    out.mx = l.mx; out.my = l.my; out.mz = l.mz;
  });
  return out;
}

/** Step `n` fixed ticks, re-pushing every kinematic pose (order: push → step). */
function settle(p: RapierPhysicsProvider, poses: Array<[string, PhysicsPose]>, n: number): void {
  for (let i = 0; i < n; i++) {
    for (const [id, ps] of poses) p.setKinematicPose(id, ps);
    p.step(DT);
  }
}

beforeEach(() => setRapierLibLoader(null));
afterEach(() => setRapierLibLoader(null));

describe('plan-467 F6 — contact loads (SOL R2 counterexamples)', () => {
  it('two stacked MUs load the link with BOTH weights (19.62 N, not 9.81 N)', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      // Plate top at y = 0; two 1 kg cubes stacked on it.
      const plateCenter = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', plateCenter, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu-lower', pose(0, 0.1001, 0), MU_H, V0, 1);
      p.addDynamicMU('mu-upper', pose(0, 0.3005, 0), MU_H, V0, 1);

      settle(p, [['kin:plate', { pos: plateCenter, quat: Q_IDENT }]], 180);

      const load = loadOf(p, 'kin:plate');
      console.log(`[467 stacked] Fy = ${load.fy.toFixed(3)} N (expected -19.62)`);
      expect(Math.abs(load.fy)).toBeGreaterThan(2 * G * 0.95);
      expect(Math.abs(load.fy)).toBeLessThan(2 * G * 1.05);
      expect(load.fy).toBeLessThan(0); // pressing DOWN on the link
    } finally {
      p.dispose();
    }
  }, 30000);

  it('an MU resting half on static geometry loads the link with half its weight (4.905 N)', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      // Static slab covers x ∈ [−1, 0], the kinematic plate x ∈ [0, 1]; both
      // top out at y = 0. The MU straddles the seam at x = 0.
      p.addStaticBox('static:slab', { x: -0.5, y: -0.1, z: 0 }, { x: 0.5, y: 0.1, z: 0.5 }, Q_IDENT);
      const plateCenter = { x: 0.5, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', plateCenter, { x: 0.5, y: 0.1, z: 0.5 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);

      settle(p, [['kin:plate', { pos: plateCenter, quat: Q_IDENT }]], 180);

      const load = loadOf(p, 'kin:plate');
      console.log(`[467 half-static] Fy = ${load.fy.toFixed(3)} N (expected -4.905)`);
      expect(Math.abs(load.fy)).toBeGreaterThan(0.5 * G * 0.9);
      expect(Math.abs(load.fy)).toBeLessThan(0.5 * G * 1.1);
      expect(load.fy).toBeLessThan(0);
    } finally {
      p.dispose();
    }
  }, 30000);
});

describe('plan-467 F6 — contact loads (hybrid channel)', () => {
  it('a 1 kg MU at rest loads the link with its weight (−9.81 N)', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 60);

      const load = loadOf(p, 'kin:plate');
      console.log(`[467 rest] F=(${load.fx.toFixed(3)}, ${load.fy.toFixed(3)}, ${load.fz.toFixed(3)}) N`);
      expect(load.fy).toBeLessThan(-G * 0.95);
      expect(load.fy).toBeGreaterThan(-G * 1.05);
      expect(Math.abs(load.fx)).toBeLessThan(0.5);
      expect(Math.abs(load.fz)).toBeLessThan(0.5);
    } finally { p.dispose(); }
  }, 30000);

  it('a horizontally moving plate reports friction: 1 s mean −0.300 N, Coulomb per tick, transient peak', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c: PhysicsVec3 = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 4, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 60);

      // 1 s of travel at 0.3 m/s — the MU is taken along, so the tangential
      // IMPULSE over that second is exactly m·Δv and the mean force m·Δv / 1 s.
      const ticks = Math.round(1 / DT);
      const ps = { pos: { x: c.x, y: c.y, z: c.z }, quat: Q_IDENT };
      let sumFx = 0;
      let peak = 0;
      let coulombOk = true;
      for (let t = 1; t <= ticks; t++) {
        ps.pos.x = c.x + 0.3 * DT * t;
        p.setKinematicPose('kin:plate', ps);
        p.step(DT);
        const l = loadOf(p, 'kin:plate');
        sumFx += l.fx;
        peak = Math.max(peak, Math.abs(l.fx));
        // Coulomb: no tick may exceed μ·|Fn| (μ = 0.8, the zone friction).
        if (Math.abs(l.fx) > 0.8 * Math.max(Math.abs(l.fy), G) * 1.05 + 0.05) coulombOk = false;
      }
      const mean = sumFx / ticks;
      console.log(`[467 friction] 1 s mean Fx = ${mean.toFixed(4)} N, peak |Fx| = ${peak.toFixed(3)} N`);
      expect(mean).toBeLessThan(-0.300 * 0.9);
      expect(mean).toBeGreaterThan(-0.300 * 1.1);
      expect(coulombOk).toBe(true);
      expect(peak).toBeGreaterThan(5);
    } finally { p.dispose(); }
  }, 30000);

  it('a plate lifting at 0.5 m/s² reports m·(g + a) = 10.31 N', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c: PhysicsVec3 = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 60);

      const a = 0.5;
      const ps = { pos: { x: c.x, y: c.y, z: c.z }, quat: Q_IDENT };
      let fy = 0;
      for (let t = 1; t <= 60; t++) {
        ps.pos.y = c.y + 0.5 * a * (DT * t) * (DT * t);
        p.setKinematicPose('kin:plate', ps);
        p.step(DT);
        fy = loadOf(p, 'kin:plate').fy;
      }
      console.log(`[467 lift] Fy = ${fy.toFixed(3)} N (expected ≈ −10.31)`);
      expect(fy).toBeLessThan(-(G + a) * 0.95);
      expect(fy).toBeGreaterThan(-(G + a) * 1.05);
    } finally { p.dispose(); }
  }, 30000);

  it('an eccentric MU produces the lever moment about the WORLD ORIGIN (Mz = −2.943 N·m)', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0.3, 0.1001, 0), MU_H, V0, 1);
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 90);

      const load = loadOf(p, 'kin:plate');
      console.log(`[467 moment] M=(${load.mx.toFixed(3)}, ${load.my.toFixed(3)}, ${load.mz.toFixed(3)}) N·m`);
      expect(load.mz).toBeLessThan(-2.943 * 0.95);
      expect(load.mz).toBeGreaterThan(-2.943 * 1.05);
      expect(Math.abs(load.mx)).toBeLessThan(0.3);
    } finally { p.dispose(); }
  }, 30000);

  it('creation order (link first / MU first) does not change the reported load', async () => {
    const build = async (muFirst: boolean): Promise<number> => {
      const p = await makeProvider();
      if (!p) return NaN;
      try {
        const c = { x: 0, y: -0.1, z: 0 };
        if (muFirst) p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
        addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
        if (!muFirst) p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
        settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 60);
        return loadOf(p, 'kin:plate').fy;
      } finally { p.dispose(); }
    };
    const plateFirst = await build(false);
    const muFirst = await build(true);
    if (Number.isNaN(plateFirst)) return;
    console.log(`[467 order] plateFirst ${plateFirst.toFixed(3)} N · muFirst ${muFirst.toFixed(3)} N`);
    expect(Math.abs(plateFirst - muFirst)).toBeLessThan(0.05);
    expect(plateFirst).toBeLessThan(-G * 0.95);
  }, 60000);

  it('an MU bridging two link bodies splits its weight across both (sum = m·g)', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const left = { x: -0.5, y: -0.1, z: 0 };
      const right = { x: 0.5, y: -0.1, z: 0 };
      addPlate(p, 'kin:left', left, { x: 0.5, y: 0.1, z: 0.5 });
      addPlate(p, 'kin:right', right, { x: 0.5, y: 0.1, z: 0.5 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      settle(p, [
        ['kin:left', { pos: left, quat: Q_IDENT }],
        ['kin:right', { pos: right, quat: Q_IDENT }],
      ], 120);

      const sum = loadOf(p, 'kin:left').fy + loadOf(p, 'kin:right').fy;
      console.log(`[467 two links] sum Fy = ${sum.toFixed(3)} N`);
      expect(sum).toBeLessThan(-G * 0.95);
      expect(sum).toBeGreaterThan(-G * 1.05);
    } finally { p.dispose(); }
  }, 30000);

  it('a collider offset inside the body does not move the load off the link', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      // Body origin at y = 0, collider pushed 0.2 m DOWN — its top is y = −0.1.
      const c = { x: 0, y: 0, z: 0 };
      p.addKinematicBody(
        'kin:offset',
        { kind: 'cuboid', halfExtents: { x: 1, y: 0.1, z: 1 }, localOffset: { x: 0, y: -0.2, z: 0 } },
        { pos: c, quat: Q_IDENT },
        true,
      );
      p.addDynamicMU('mu', pose(0, 0.0001, 0), MU_H, V0, 1);
      settle(p, [['kin:offset', { pos: c, quat: Q_IDENT }]], 90);

      const load = loadOf(p, 'kin:offset');
      expect(load.fy).toBeLessThan(-G * 0.95);
      expect(load.fy).toBeGreaterThan(-G * 1.05);
    } finally { p.dispose(); }
  }, 30000);

  it('a SLEEPING MU keeps loading the link, and the wake-up tick shows the acceleration', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c: PhysicsVec3 = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      // 3 s standing still — Rapier parks the body around tick 120.
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 180);

      const asleep = loadOf(p, 'kin:plate').fy;
      console.log(`[467 sleep] Fy after 3 s = ${asleep.toFixed(3)} N`);
      expect(asleep).toBeLessThan(-G * 0.95);
      expect(asleep).toBeGreaterThan(-G * 1.05);

      // Wake-up: the plate starts lifting at 0.5 m/s. The first ticks must show
      // MORE than the static weight — the acceleration term must not be erased
      // by a v_prev taken after the step (SOL R2 #4).
      const ps = { pos: { x: c.x, y: c.y, z: c.z }, quat: Q_IDENT };
      let peak = 0;
      for (let t = 1; t <= 3; t++) {
        ps.pos.y = c.y + 0.5 * DT * t;
        p.setKinematicPose('kin:plate', ps);
        p.step(DT);
        peak = Math.min(peak, loadOf(p, 'kin:plate').fy);
      }
      console.log(`[467 wake] strongest Fy in the first 3 ticks = ${peak.toFixed(3)} N`);
      expect(peak).toBeLessThan(-G);
    } finally { p.dispose(); }
  }, 30000);

  it('first contact with an incoming MU peaks above its weight', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0, 0.25, 0), MU_H, { x: 0, y: -2, z: 0 }, 1);

      let peak = 0;
      for (let t = 0; t < 60; t++) {
        p.setKinematicPose('kin:plate', { pos: c, quat: Q_IDENT });
        p.step(DT);
        peak = Math.min(peak, loadOf(p, 'kin:plate').fy);
      }
      console.log(`[467 impact] peak Fy = ${peak.toFixed(3)} N`);
      expect(peak).toBeLessThan(-G * 1.5);
    } finally { p.dispose(); }
  }, 30000);

  it('removing the MU clears the load on the next tick', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 60);
      expect(loadOf(p, 'kin:plate').fy).toBeLessThan(-G * 0.95);

      p.removeBody('mu');
      settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 2);
      const load = loadOf(p, 'kin:plate');
      expect(Math.abs(load.fy)).toBeLessThan(0.05);
      expect(Math.abs(load.mz)).toBeLessThan(0.05);
    } finally { p.dispose(); }
  }, 30000);

  it('doubling numSolverIterations leaves the reported force unchanged', async () => {
    const measure = async (iterations: number): Promise<number> => {
      const p = await makeProvider();
      if (!p) return NaN;
      try {
        p.setSolverIterationsForTesting(iterations);
        const c = { x: 0, y: -0.1, z: 0 };
        addPlate(p, 'kin:plate', c, { x: 1, y: 0.1, z: 1 });
        p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
        settle(p, [['kin:plate', { pos: c, quat: Q_IDENT }]], 60);
        return loadOf(p, 'kin:plate').fy;
      } finally { p.dispose(); }
    };
    const four = await measure(4);
    const eight = await measure(8);
    if (Number.isNaN(four)) return;
    console.log(`[467 iterations] N=4 -> ${four.toFixed(4)} N · N=8 -> ${eight.toFixed(4)} N`);
    expect(four).toBeLessThan(-G * 0.95);
    expect(Math.abs(four - eight)).toBeLessThan(G * 0.05);
  }, 60000);

  it('a body registered WITHOUT reportContactForces never appears in forEachContactLoad', async () => {
    const p = await makeProvider();
    if (!p) return;
    try {
      const c = { x: 0, y: -0.1, z: 0 };
      addPlate(p, 'kin:silent', c, { x: 1, y: 0.1, z: 1 }, false);
      p.addDynamicMU('mu', pose(0, 0.1001, 0), MU_H, V0, 1);
      settle(p, [['kin:silent', { pos: c, quat: Q_IDENT }]], 60);

      const seen: string[] = [];
      p.forEachContactLoad((l) => { seen.push(l.bodyId); });
      expect(seen).toEqual([]);
    } finally { p.dispose(); }
  }, 30000);
});
