// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.10 / plan-781 §9.7 — the 2 ms tick budget gate, on the BAKED path.
 *
 * Binding criterion (user decision, unchanged by plan-781): <= 2 ms MEDIAN tick
 * time over 600 ticks, and the report must land in the same tick. p95 and the
 * rebuild time are REPORTED, not gated.
 *
 * Two cases:
 *
 *  1. The reference model `DemoRobotIK.glb` loaded the way production loads it
 *     (`loadBakedGLB`: destructive bake, pick structures) — skipped only when
 *     the private Development project is absent (`devAssetAvailable`). Its
 *     nodes are split into role bodies; the model root moves every tick, so
 *     EVERY pair is evaluated with the full narrowphase every tick (the motion
 *     skip never helps), and `reset()` keeps latched pairs from being skipped.
 *  2. A SYNTHETIC baked scene — 20 role bodies (static and movers) plus 100
 *     instanced MUs, all moving — so the gate also runs on a public checkout.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, InstancedMesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { RVCollisionManager, type CollisionMU, type CollisionMUQuery } from '../src/core/engine/rv-collision-manager';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import type { CollisionRoleName } from '../src/core/engine/rv-collision-role';
import type { IMUAccessor } from '../src/core/engine/rv-mu';
import { FakeHighlightHost, FakeMU, bakeCollisionScene, bodyNode, plainGroup } from './collision-fixture';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const DEV_ASSETS = await devAssetAvailable(DEV_GLB.robotIK);

const MODEL = DEV_GLB.robotIK;
const TICKS = 600;
const BUDGET_MS = 2;

const ROLES: CollisionRoleName[] = ['Robot', 'Machine', 'Tool', 'Workpiece', 'Environment', 'Machine'];

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function summary(manager: RVCollisionManager): string {
  let parts = 0;
  let segments = 0;
  let keep = 0;
  for (const b of manager.bodies) {
    parts += b.parts.length;
    for (const p of b.parts) { segments += p.segments; if (p.kind !== 'chunk') keep++; }
  }
  return `bodies=${manager.bodies.length}, parts=${parts}, segments=${segments}, keepParts=${keep}, crossPairs=${manager.pairs.length}`;
}

describe.skipIf(!DEV_ASSETS)('collision tick cost (plan-394 perf gate)', () => {
  it('stays within 2 ms median tick cost on the reference model', async () => {
    const scene = new Scene();
    const bakeRegistry = new BakeRegistry();
    const result = await loadBakedGLB(MODEL, scene, { bakeRegistry, loadKinematicsSidecar: false });
    const root = result.root;
    scene.updateMatrixWorld(true);

    // Role bodies: every MOVER (chunk boundary — robot axes, gripper, slides)
    // plus the static top-level survivors, so moving and static geometry both
    // take part and the robot's own chain is cut into nested bodies (F16).
    const isNode = (o: Object3D): boolean => o.userData?.[RV_BAKE_CHUNK_KEY] !== true && !(o as { isMesh?: boolean }).isMesh;
    const candidates: Object3D[] = root.children.filter(isNode);
    for (const chunk of result.bakedAsset!.chunks) {
      if (chunk.ownerPath !== null && !candidates.includes(chunk.owner)) candidates.push(chunk.owner);
    }
    expect(candidates.length).toBeGreaterThan(1);

    const manager = new RVCollisionManager();
    manager.setGeometrySource(bakeRegistry);
    manager.setHighlightHost(new FakeHighlightHost());
    candidates.forEach((node, i) => manager.register(node, ROLES[i % ROLES.length]));
    const r0 = performance.now();
    manager.rebuild();
    const rebuildMs = performance.now() - r0;
    expect(manager.bodies.some((b) => b.parts.length > 0)).toBe(true);

    // Warm-up (JIT) outside the measurement.
    for (let i = 0; i < 30; i++) { root.position.x += 1e-4; manager.update(1 / 60); manager.reset(); }

    const samples: number[] = [];
    manager.resetCounters();
    const tAll = performance.now();
    for (let i = 0; i < TICKS; i++) {
      // Move the whole model: every part moves, so every pair is re-tested.
      root.position.x += Math.sin(i * 0.05) * 0.002;
      const t0 = performance.now();
      manager.update(1 / 60);
      samples.push(performance.now() - t0);
      manager.reset();     // keep latched pairs from short-circuiting the work (F10)
    }
    const meanMs = (performance.now() - tAll) / TICKS;

    const med = median(samples);
    const p95 = percentile(samples, 0.95);
    const c = manager.counters;
    // eslint-disable-next-line no-console
    console.log(
      `[plan-781 perf] ${MODEL} (baked): ${summary(manager)}, ticks=${TICKS}, `
      + `median=${med.toFixed(3)} ms, p95=${p95.toFixed(3)} ms, mean=${meanMs.toFixed(3)} ms (incl. reset), rebuild=${rebuildMs.toFixed(2)} ms, `
      + `per tick: pairs=${(c.pairsEvaluated / TICKS).toFixed(1)}, partPairs=${(c.partPairs / TICKS).toFixed(1)}, `
      + `boxes=${(c.boxesTested / TICKS).toFixed(0)}, triangles=${(c.trianglesTested / TICKS).toFixed(0)}`,
    );

    expect(med).toBeLessThanOrEqual(BUDGET_MS);
  }, 180_000);
});

describe('collision tick cost on a synthetic baked scene (plan-781 perf gate)', () => {
  it('stays within 2 ms median with 20 bodies and 100 moving MUs', async () => {
    // The transport case: 16 conveyor bodies (static, ~430 triangles each, top
    // at y = 0.1) in four rows, and 4 movers (pushers) sweeping along the rows.
    const root = plainGroup('Line');
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        root.add(bodyNode(`Belt${r}_${c}`, { role: 'Machine', segments: 6, at: [c * 2.6, 0, r * 2.5], size: [2.4, 0.2, 1] }));
      }
      root.add(bodyNode(`Pusher${r}`, { role: 'Robot', mover: true, segments: 4, at: [0, 0.35, r * 2.5], size: [0.2, 0.5, 1.2] }));
    }
    const s = await bakeCollisionScene(root);
    const pushers: Object3D[] = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) s.manager.register(s.node(`Belt${r}_${c}`), 'Machine');
      const pusher = s.node(`Pusher${r}`);
      s.manager.register(pusher, 'Robot');
      pushers.push(pusher);
    }

    // 100 instanced MUs (768 triangles each: they get the KeepPick) riding FLUSH
    // on the belts; every tenth is pressed 2 cm into its belt (a real contact).
    const pool = new InstancedMesh(new BoxGeometry(0.3, 0.3, 0.3, 8, 8, 8), new MeshBasicMaterial(), 128);
    s.scene.add(pool);
    const mus: FakeMU[] = [];
    const muY = (i: number): number => (i % 10 === 0 ? 0.23 : 0.25);
    for (let i = 0; i < 100; i++) {
      const mu = new FakeMU(i + 1, pool, new Vector3(0.15, 0.15, 0.15), true);
      mu.moveTo((i % 25) * 0.4, muY(i), Math.floor(i / 25) * 2.5);
      mus.push(mu);
      s.manager.onMUSpawned(mu as unknown as CollisionMU, 'Workpiece');
    }
    const query: CollisionMUQuery = {
      queryMUsXZ(min, max, out: IMUAccessor[]): number {
        out.length = 0;
        for (const mu of mus) {
          const a = mu.aabb;
          if (a.max.x < min[0] || a.min.x > max[0] || a.max.z < min[2] || a.min.z > max[2]) continue;
          out.push(mu as unknown as IMUAccessor);
        }
        return out.length;
      },
    };
    s.manager.setMUQuery(query);

    s.manager.update(1 / 60);                         // apply spawns
    const r0 = performance.now();
    s.manager.invalidate();
    s.manager.rebuild();
    const rebuildMs = performance.now() - r0;
    for (let i = 0; i < 30; i++) s.manager.update(1 / 60);

    const samples: number[] = [];
    s.manager.resetCounters();
    const tAll = performance.now();
    for (let t = 0; t < TICKS; t++) {
      for (const [r, pusher] of pushers.entries()) pusher.position.x = ((t * 0.02 + r * 2) % 10);
      for (let i = 0; i < mus.length; i++) {
        const mu = mus[i];
        const p = mu.getPosition();
        mu.moveTo(((p.x + 0.01) % 10), muY(i), p.z);
      }
      const t0 = performance.now();
      s.manager.update(1 / 60);
      samples.push(performance.now() - t0);
      s.manager.reset();     // keep latched pairs from short-circuiting the work (F10)
    }
    const meanMs = (performance.now() - tAll) / TICKS;

    const med = median(samples);
    const p95 = percentile(samples, 0.95);
    const c = s.manager.counters;
    // eslint-disable-next-line no-console
    console.log(
      `[plan-781 perf] synthetic (baked): ${summary(s.manager)}, ticks=${TICKS}, `
      + `median=${med.toFixed(3)} ms, p95=${p95.toFixed(3)} ms, mean=${meanMs.toFixed(3)} ms (incl. moves + reset), rebuild=${rebuildMs.toFixed(2)} ms, `
      + `per tick: pairs=${(c.pairsEvaluated / TICKS).toFixed(1)}, gridSkipped=${(c.gridSkipped / TICKS).toFixed(1)}, `
      + `partPairs=${(c.partPairs / TICKS).toFixed(1)}, abutRejected=${(c.abutRejected / TICKS).toFixed(1)}, `
      + `runPairs=${(c.runPairs / TICKS).toFixed(1)}, triangles=${(c.trianglesTested / TICKS).toFixed(0)}`,
    );

    expect(s.manager.bodies).toHaveLength(120);
    expect(c.trianglesTested).toBeGreaterThan(0);          // the gate measured real narrowphase work
    expect(med).toBeLessThanOrEqual(BUDGET_MS);
  }, 180_000);
});
