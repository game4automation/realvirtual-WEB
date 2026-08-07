// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.10 / Phase 5 — the 2 ms tick budget gate.
 *
 * Binding criterion (user decision): <= 2 ms MEDIAN additional tick time over
 * 600 ticks on the reference model, and the report must land in the same tick.
 *
 * The reference model is `public/models/DemoRobotIK.glb` (see
 * rv-collision-bvh-coverage.test.ts for why). Its nodes are split into six
 * role bodies, all moving every tick, so the measurement covers the real work:
 * per-tick union boxes over every mesh, the cross-pair broadphase and the
 * bvhcast narrowphase on the pairs that actually overlap.
 */

import { describe, it, expect } from 'vitest';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Object3D } from 'three';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { computeBVHAsync } from '../src/core/engine/rv-scene-loader';
import { createInlineBVHPort } from '../src/core/engine/rv-bvh-build-port';
import { FakeHighlightHost } from './collision-fixture';
import type { CollisionRoleName } from '../src/core/engine/rv-collision-role';

const MODEL = '/models/DemoRobotIK.glb';
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

describe('collision tick cost (plan-394 perf gate)', () => {
  it('stays within 2 ms median tick cost on the reference model', async () => {
    const gltf = await new GLTFLoader().loadAsync(MODEL);
    const root = gltf.scene;
    await computeBVHAsync(root, createInlineBVHPort());

    // Split the model into role bodies: take the top-level children (and, when
    // there are too few, their children) so every body carries real geometry.
    let candidates: Object3D[] = [...root.children];
    while (candidates.length < ROLES.length && candidates.some((c) => c.children.length > 0)) {
      candidates = candidates.flatMap((c) => (c.children.length > 0 ? [...c.children] : [c]));
    }
    // EVERY candidate becomes a body (roles round-robin) so the measurement
    // covers the whole model, not a slice of it.
    const chosen = candidates;
    expect(chosen.length).toBeGreaterThan(1);

    const manager = new RVCollisionManager();
    manager.setHighlightHost(new FakeHighlightHost());
    chosen.forEach((node, i) => manager.register(node, ROLES[i % ROLES.length]));
    manager.rebuild();

    const meshCount = manager.bodies.reduce((n, b) => n + b.meshes.length, 0);
    // Warm-up (JIT + first bvhcast allocations) outside the measurement.
    for (let i = 0; i < 30; i++) manager.update(1 / 60);
    manager.reset();

    const samples: number[] = [];
    for (let i = 0; i < TICKS; i++) {
      // Move every body a little so nothing can be cached away.
      const d = Math.sin(i * 0.05) * 0.02;
      for (const node of chosen) node.position.x += d;
      root.updateMatrixWorld(true);
      const t0 = performance.now();
      manager.update(1 / 60);
      samples.push(performance.now() - t0);
      manager.reset();     // keep the pair set from short-circuiting the work
    }

    const med = median(samples);
    const p95 = percentile(samples, 0.95);
    // eslint-disable-next-line no-console
    console.log(
      `[plan-394 Phase 5] ${MODEL}: bodies=${manager.bodies.length}, meshes=${meshCount}, `
      + `crossPairs=${manager.pairs.length}, ticks=${TICKS}, `
      + `median=${med.toFixed(3)} ms, p95=${p95.toFixed(3)} ms`,
    );

    expect(med).toBeLessThanOrEqual(BUDGET_MS);
  }, 180_000);
});
