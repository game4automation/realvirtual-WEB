// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { planMove, moveDuration } from '../scripts/tutorial/lib/cursor-path.mjs';

const FPS = 30;
const FPS_25 = 25;

describe('cursor-path', () => {
  it('Test_PlanMove_EndsExactlyOnTarget', () => {
    const samples = planMove({ x: 100, y: 100 }, { x: 900, y: 500 }, 40, 'step-a:0', FPS);
    expect(samples.at(-1)).toMatchObject({ x: 900, y: 500 });
    expect(samples[0]).toMatchObject({ x: 100, y: 100 });
  });

  it('Test_MoveDuration_ClampedToRange', () => {
    expect(moveDuration(1, 1000)).toBeGreaterThanOrEqual(0.35);
    expect(moveDuration(5000, 2)).toBeLessThanOrEqual(1.2);
  });

  it('Test_PlanMove_SameSeed_SamePath', () => {
    expect(planMove({ x: 0, y: 0 }, { x: 500, y: 300 }, 30, 'x:0', FPS))
      .toEqual(planMove({ x: 0, y: 0 }, { x: 500, y: 300 }, 30, 'x:0', FPS));
  });

  it('Test_PlanMove_TimeMonotonic_NoNaN', () => {
    const samples = planMove({ x: 0, y: 0 }, { x: 10, y: 0 }, 20, 'y:0', FPS);
    samples.forEach((point, index) => {
      expect(Number.isFinite(point.x + point.y + point.t)).toBe(true);
      if (index > 0) expect(point.t).toBeGreaterThan(samples[index - 1].t);
    });
  });

  it('Test_PlanMove_MissingFps_Throws', () => {
    // @ts-expect-error fps is required so an omitted frame rate cannot silently select a default.
    expect(() => planMove({ x: 0, y: 0 }, { x: 10, y: 0 }, 20, 'y:0')).toThrow();
  });

  // At 30 fps the canonical bounds equal the buggy literal [11, 36]. At 25 fps they are [9, 30],
  // so these cases must remain separate to make a literal-clamp implementation fail.
  it('Test_PlanMove_SampleCount_ScalesWithFps_UpperClamp', () => {
    const far = { x: 1900, y: 1040 };
    expect(planMove({ x: 0, y: 0 }, far, 2, 'far:0', FPS).length).toBe(36);
    expect(planMove({ x: 0, y: 0 }, far, 2, 'far:0', FPS_25).length).toBe(30);
  });

  it('Test_PlanMove_SampleCount_ScalesWithFps_LowerClamp', () => {
    const near = { x: 12, y: 0 };
    expect(planMove({ x: 0, y: 0 }, near, 400, 'near:0', FPS).length).toBe(11);
    expect(planMove({ x: 0, y: 0 }, near, 400, 'near:0', FPS_25).length).toBe(9);
  });

  it('Test_PlanMove_EndsExactlyOnTarget_AtTwentyFiveFps', () => {
    const samples = planMove({ x: 100, y: 100 }, { x: 900, y: 500 }, 40, 'step-a:0', FPS_25);
    expect(samples.at(-1)).toMatchObject({ x: 900, y: 500 });
  });
});
