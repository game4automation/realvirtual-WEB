// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-597 §9.8 — count-walk measurement on a synthetic 20 000-node scene.
 *
 * 5 warm-up runs, 20 measured runs, median logged. Deliberately NO hard time
 * limit (CI jitter): the test is a regression-free smoke that the walk still
 * counts what it should; the before/after numbers live in the plan.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { collectTypeCounts, type SceneRowContext } from '../src/core/hmi/hierarchy-rows';
import { buildSyntheticTypeScene, registerSyntheticTypes } from './helpers/synthetic-type-scene';

describe('count walk on 20 000 nodes (§9.8)', () => {
  beforeAll(() => registerSyntheticTypes());

  it('counts the synthetic scene and reports the median', () => {
    const { scene, paths } = buildSyntheticTypeScene();
    const ctx: SceneRowContext = {
      getPathForNode: (n) => paths.get(n) ?? null,
      overlay: null,
      modelRoot: scene,
      hideRuntime: false,
    };
    for (let i = 0; i < 5; i++) collectTypeCounts(scene, ctx);
    const times: number[] = [];
    let counts = collectTypeCounts(scene, ctx);
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      counts = collectTypeCounts(scene, ctx);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = (times[9]! + times[10]!) / 2;
    console.log(`[plan-597 §9.8] collectTypeCounts 20000 nodes: median ${median.toFixed(2)} ms (min ${times[0]!.toFixed(2)}, max ${times[19]!.toFixed(2)})`);
    expect(counts.total).toBe(20_001);
  });
});
