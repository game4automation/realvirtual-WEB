// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-473 §9.3 — the instanced AABB cache (F2) changes no AABB.
 *
 * `InstancedMovingUnit.updateAABB` rebuilds the rotated half-extent from the
 * MU world quaternion on every single tick, which is 9.2 % of the transport
 * step. The cache recomputes only when the four stored quaternion FLOATS (or
 * the pool slot they live in) actually changed.
 *
 * The comparison side is NOT the cached code with the cache warmed differently
 * — it is the same call with `rvProtoFlags.refAabb = true`, which restores the
 * unconditional recompute of the reference path. Every scenario below runs both
 * sides over the same mutation sequence and compares the AABB bit-for-bit.
 *
 * The deliberately awkward cases: a DIRECT write into `pool.quaternions` (which
 * a `setQuaternion` dirty flag would miss — §2.4) and a slot change after a
 * release (swap-and-pop moves an MU onto a slot holding a different
 * orientation).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import {
  MUInstancePool, rvProtoFlags, rvAabbCacheStats, resetAabbCacheStats,
  type InstancedMovingUnit,
} from '../src/core/engine/rv-mu';

/** A deliberately non-cubic MU: the rotated extent of a cube is nearly
 *  invariant, which would hide a stale cache. */
const HALF = new Vector3(0.5, 0.1, 0.25);

function makePool(max = 8): MUInstancePool {
  return new MUInstancePool(
    new BoxGeometry(1, 0.2, 0.5),
    new MeshBasicMaterial(),
    'testbox',
    HALF,
    undefined,
    max,
  );
}

function spawn(pool: MUInstancePool, id: string, x = 0): InstancedMovingUnit {
  return pool.spawn(new Vector3(x, 0, 0), new Quaternion(), id, 'src');
}

/** AABB as plain numbers, at full precision. */
function snap(mu: InstancedMovingUnit): string[] {
  const a = mu.aabb;
  return [
    a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z,
    a.halfSize.x, a.halfSize.y, a.halfSize.z,
  ].map((n) => n.toFixed(12));
}

/** Drive one scenario and collect the AABB after every mutation step. */
type Step = (pool: MUInstancePool, mus: InstancedMovingUnit[]) => void;

function runScenario(steps: Step[], muCount: number, cached: boolean): string[][] {
  rvProtoFlags.refAabb = !cached;
  const pool = makePool();
  const mus: InstancedMovingUnit[] = [];
  for (let i = 0; i < muCount; i++) mus.push(spawn(pool, `mu${i}`, i));
  const out: string[][] = [];
  for (const step of steps) {
    step(pool, mus);
    // Every live MU is refreshed each tick, exactly like the transport step.
    for (const mu of mus) { if (mu.slotIndex >= 0) mu.updateAABB(); }
    for (const mu of mus) out.push(mu.slotIndex >= 0 ? snap(mu) : ['released']);
  }
  rvProtoFlags.refAabb = false;
  return out;
}

function expectParity(steps: Step[], muCount = 1): void {
  const ref = runScenario(steps, muCount, false);
  const cachedRun = runScenario(steps, muCount, true);
  expect(cachedRun).toEqual(ref);
}

const move = (dx: number): Step => (_p, mus) => {
  for (const mu of mus) {
    const p = mu.getPosition().clone();
    mu.setPosition(p.set(p.x + dx, p.y, p.z));
  }
};
const idle: Step = () => { /* no mutation at all */ };

describe('plan-473 §9.3 — instanced AABB cache parity', () => {
  beforeEach(() => { rvProtoFlags.refAabb = false; resetAabbCacheStats(); });

  it('straight travel: identical AABBs over 600 ticks', () => {
    expectParity(Array.from({ length: 600 }, () => move(0.01)));
  });

  it('turntable: continuous rotation via setQuaternion', () => {
    const steps: Step[] = [];
    for (let i = 0; i < 200; i++) {
      const angle = (i * Math.PI) / 97; // fine step, never repeats within the run
      steps.push((_p, mus) => {
        for (const mu of mus) {
          mu.setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle));
        }
      });
    }
    expectParity(steps);
  });

  it('rotateOnAxis (read-modify-write through the accessor)', () => {
    const steps: Step[] = Array.from({ length: 120 }, () => (_p: MUInstancePool, mus: InstancedMovingUnit[]) => {
      for (const mu of mus) mu.rotateOnAxis(new Vector3(0, 0, 1), 0.017);
    });
    expectParity(steps);
  });

  it('DIRECT write into pool.quaternions (a setter dirty flag would miss this)', () => {
    const steps: Step[] = [];
    for (let i = 0; i < 60; i++) {
      const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), i * 0.05);
      steps.push((pool, mus) => {
        const o = mus[0].slotIndex * 4;
        pool.quaternions[o] = q.x;
        pool.quaternions[o + 1] = q.y;
        pool.quaternions[o + 2] = q.z;
        pool.quaternions[o + 3] = q.w;
      });
    }
    expectParity(steps);
  });

  it('handover: rotate, hold, rotate back — the cache must re-arm both ways', () => {
    const rot = (a: number): Step => (_p, mus) => {
      for (const mu of mus) mu.setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a));
    };
    expectParity([
      ...Array.from({ length: 20 }, () => move(0.01)),
      rot(Math.PI / 3), idle, idle, idle,
      ...Array.from({ length: 20 }, () => move(0.01)),
      rot(0), idle, idle,
      rot(Math.PI / 2), ...Array.from({ length: 20 }, () => move(0.01)),
    ]);
  });

  it('slot change after release: the survivor inherits a slot with another orientation', () => {
    const steps: Step[] = [
      // Give the three MUs clearly different orientations.
      (_p, mus) => {
        mus[0].setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4));
        mus[1].setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3));
        mus[2].setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 5));
      },
      idle,
      // Release the FIRST one: swap-and-pop drags the last MU onto slot 0,
      // whose cached quaternion belonged to the released MU.
      (pool, mus) => { pool.release(mus[0]); },
      idle, idle,
      move(0.02), move(0.02),
    ];
    expectParity(steps, 3);
  });

  it('spawn into a slot a released MU used: the fresh MU starts invalid', () => {
    const steps: Step[] = [
      (_p, mus) => {
        for (const mu of mus) mu.setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.1));
      },
      idle,
      (pool, mus) => { pool.release(mus[1]); mus.splice(1, 1); },
      idle,
      (pool, mus) => { mus.push(spawn(pool, 'fresh', 9)); },
      idle, move(0.01),
    ];
    expectParity(steps, 3);
  });

  it('counts: the recompute is skipped on a straight run, and fires on rotation', () => {
    rvProtoFlags.refAabb = false;
    const pool = makePool();
    const mu = spawn(pool, 'a');
    resetAabbCacheStats();

    mu.updateAABB();                      // first call: always recomputes
    expect(rvAabbCacheStats.recompute).toBe(1);
    expect(rvAabbCacheStats.skip).toBe(0);

    for (let i = 0; i < 100; i++) {       // straight travel: position only
      mu.setPosition(new Vector3(i * 0.01, 0, 0));
      mu.updateAABB();
    }
    expect(rvAabbCacheStats.recompute).toBe(1);
    expect(rvAabbCacheStats.skip).toBe(100);

    mu.setQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4));
    mu.updateAABB();
    expect(rvAabbCacheStats.recompute).toBe(2);

    mu.updateAABB();                      // unchanged again → skip
    expect(rvAabbCacheStats.recompute).toBe(2);
    expect(rvAabbCacheStats.skip).toBe(101);
  });

  it('the reference switch really disables the cache', () => {
    rvProtoFlags.refAabb = true;
    const pool = makePool();
    const mu = spawn(pool, 'a');
    resetAabbCacheStats();
    for (let i = 0; i < 10; i++) mu.updateAABB();
    expect(rvAabbCacheStats.recompute).toBe(10);
    expect(rvAabbCacheStats.skip).toBe(0);
    rvProtoFlags.refAabb = false;
  });
});
