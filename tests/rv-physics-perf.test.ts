// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-perf.test.ts — plan-276 Phase 6 performance measurement.
 *
 * Measures the pure step+sync cost of the RapierPhysicsProvider (the exact
 * per-tick work the PhysicsZonePlugin does) against REAL Rapier WASM with
 * 50 dynamic MU boxes dropping into a zone and settling on a static floor:
 *
 *  1. Steady run: 600 fixed ticks (10 s sim time — drop, impact, settle,
 *     sleep), per-tick `performance.now()` around step()+syncPoses().
 *     Assertion is DELIBERATELY generous (avg < 5 ms/tick) — CI machines
 *     vary; the measured numbers are reported via console.log.
 *  2. Accumulator worst case: 100 frames × 6 substeps (the simulation loop's
 *     maxSubSteps cap, rv-simulation-loop.ts) on a fresh 50-box drop —
 *     per-frame cost of a full catch-up frame, reported via console.log.
 *
 * Uses the default (out-of-band URL) Rapier loader and skips gracefully when
 * `@dimforge/rapier3d-compat` is not installed (pattern:
 * physics-spike-handover.test.ts / rv-physics-lifecycle.test.ts).
 * NOTE: keep the out-of-band install on 0.19.3 — a plain `npm install` can
 * revert it to the 0.12 package-lock legacy (plan-276 gotcha 23).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RapierPhysicsProvider } from '@rv-private/physics/rv-rapier-provider';
import { setRapierLibLoader } from '@rv-private/physics/rapier-lib-loader';
import { PHYSICS_FIXED_DT } from '../src/core/engine/rv-physics-constants';
import type { PhysicsQuat, PhysicsVec3 } from '../src/core/engine/rv-physics-registry';

const Q_IDENT: PhysicsQuat = { x: 0, y: 0, z: 0, w: 1 };
const HE: PhysicsVec3 = { x: 0.1, y: 0.1, z: 0.1 }; // MU half extents (0.2 m cube)
const V0: PhysicsVec3 = { x: 0, y: 0, z: 0 };
const BODY_COUNT = 50;

/** Zone + floor + a BODY_COUNT grid of dynamic boxes dropping from ≥ 0.5 m. */
async function buildScene(): Promise<RapierPhysicsProvider | null> {
  const provider = new RapierPhysicsProvider();
  provider.addZone(
    'perf-zone',
    { min: { x: -6, y: -1, z: -6 }, max: { x: 6, y: 6, z: 6 } },
    { friction: 0.8, restitution: 0, removeBelowY: -10 },
  );
  try {
    await provider.init(); // default URL loader — rejects when not installed
  } catch {
    console.warn('[physics-perf] @dimforge/rapier3d-compat not installed (out-of-band) — skipping');
    return null;
  }
  provider.addStaticBox('floor', { x: 0, y: -0.1, z: 0 }, { x: 6, y: 0.1, z: 6 }, Q_IDENT);
  // 10 × 5 grid, 0.5 m spacing (loose enough to land side by side, dense
  // enough for neighbour contacts), staggered drop heights 0.5–1.5 m.
  let i = 0;
  for (let gx = 0; gx < 10; gx++) {
    for (let gz = 0; gz < 5; gz++) {
      const y = 0.5 + ((i % 5) * 0.25);
      provider.addDynamicMU(
        `mu${i++}`,
        { pos: { x: -2.25 + gx * 0.5, y, z: -1 + gz * 0.5 }, quat: Q_IDENT },
        HE,
        V0,
      );
    }
  }
  return provider;
}

/** One plugin-equivalent physics tick: step + zero-GC pose readback. */
function tick(provider: RapierPhysicsProvider): void {
  provider.step(PHYSICS_FIXED_DT);
  provider.syncPoses(noopSync);
}

let syncCount = 0;
function noopSync(_muId: string, pos: PhysicsVec3, _quat: PhysicsQuat): void {
  // Touch the reused objects like the real _applyPose does (no retention).
  if (pos.y > -1000) syncCount++;
}

function stats(samples: number[]): { avg: number; max: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    avg,
    max: sorted[sorted.length - 1],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

describe('physics performance — 50 dynamic bodies (real Rapier WASM, out-of-band)', () => {
  beforeEach(() => {
    setRapierLibLoader(null); // default URL-import loader
    syncCount = 0;
  });
  afterEach(() => setRapierLibLoader(null));

  it('600 ticks drop+settle: average step+sync stays under 5 ms/tick', async () => {
    const provider = await buildScene();
    if (!provider) return; // graceful skip (package not installed)
    try {
      const perTick: number[] = [];
      for (let t = 0; t < 600; t++) {
        const t0 = performance.now();
        tick(provider);
        perTick.push(performance.now() - t0);
      }
      expect(provider.failed).toBe(false);
      expect(syncCount).toBeGreaterThan(0); // bodies were actually synced

      // All 50 bodies must still be alive (nothing fell out of the world).
      let alive = 0;
      provider.syncPoses(() => alive++);
      expect(alive).toBe(BODY_COUNT);

      const s = stats(perTick);
      console.log(
        `[physics-perf] ${BODY_COUNT} bodies, 600 ticks — ` +
        `avg ${s.avg.toFixed(3)} ms, p95 ${s.p95.toFixed(3)} ms, max ${s.max.toFixed(3)} ms per tick (step+sync)`,
      );
      // Generous bound — CI machines vary; local reference values are in the
      // plan document (Phase 6 result).
      expect(s.avg).toBeLessThan(5);
    } finally {
      provider.dispose();
    }
  }, 60000);

  it('accumulator worst case: 100 frames × 6 substeps (maxSubSteps cap)', async () => {
    const provider = await buildScene();
    if (!provider) return; // graceful skip (package not installed)
    try {
      const perFrame: number[] = [];
      for (let f = 0; f < 100; f++) {
        const t0 = performance.now();
        for (let s = 0; s < 6; s++) tick(provider); // full catch-up frame
        perFrame.push(performance.now() - t0);
      }
      expect(provider.failed).toBe(false);

      const s = stats(perFrame);
      console.log(
        `[physics-perf] ${BODY_COUNT} bodies, 6-substep worst case — ` +
        `avg ${s.avg.toFixed(3)} ms, p95 ${s.p95.toFixed(3)} ms, max ${s.max.toFixed(3)} ms per frame (6× step+sync)`,
      );
      // 6 × the generous per-tick bound.
      expect(s.avg).toBeLessThan(30);
    } finally {
      provider.dispose();
    }
  }, 60000);
});
