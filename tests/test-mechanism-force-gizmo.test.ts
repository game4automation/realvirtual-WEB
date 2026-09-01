// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Force arrow maths — the testable half of the 3D overlay (plan-412 test 9.6,
 * pattern `mechanism-interaction.test.ts`).
 *
 * The GESTURE (raycast, pointer capture, teardown on mode change) is a browser
 * behaviour and is covered in the Playwright spec. What is covered here is the
 * part that can be silently wrong on screen: an arrow whose length runs off the
 * viewport, a colour ramp that saturates at the wrong end, and an anchor taken
 * from the wrong field of the joint view.
 *
 * No DOM, no viewer, no wasm.
 */

import { describe, it, expect } from 'vitest';
import {
  ARROW_MIN_FRACTION,
  ARROW_SCREEN_FRACTION,
  FORCE_RAMP,
  arrowTargetsFromSnapshot,
  forceArrowColor,
  forceArrowLength,
  referenceMagnitude,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-force-gizmo';
import type { MechanismForcesSnapshot } from '../src/core/engine/rv-kinematic-registry';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function snapshot(overrides: Partial<MechanismForcesSnapshot> = {}): MechanismForcesSnapshot {
  return {
    mechanismPath: 'Cell/Lift',
    status: 0,
    statusText: 'ok',
    dynamicsValid: true,
    redundant: false,
    channels: [
      { id: 'Cell/Lift|dof0', label: 'Lift', kind: 'drive', unit: 'N·m', value: 12, linkPath: null },
      { id: 'Cell/Lift|joint0|F', label: 'J0 · bearing force', kind: 'joint-force', unit: 'N', value: 5, linkPath: null },
      { id: 'Cell/Lift|joint0|M', label: 'J0 · bearing moment', kind: 'joint-torque', unit: 'N·m', value: 1, linkPath: null },
      { id: 'Cell/Lift|joint1|F', label: 'J1 · bearing force', kind: 'joint-force', unit: 'N', value: 13, linkPath: null },
      { id: 'Cell/Lift|joint1|M', label: 'J1 · bearing moment', kind: 'joint-torque', unit: 'N·m', value: 2, linkPath: null },
    ],
    joints: [
      {
        jointPath: 'Cell/Lift/J0', name: 'J0',
        forceWorld: [3, 4, 0], torqueWorld: [0, 1, 0],
        originWorld: [1, 2, 3], axisWorld: [0, 0, 1],
      },
      {
        jointPath: 'Cell/Lift/J1', name: 'J1',
        forceWorld: [0, -13, 0], torqueWorld: [0, 0, 2],
        originWorld: [4, 5, 6], axisWorld: [0, 1, 0],
      },
    ],
    ...overrides,
  };
}

// ─── Length capping ─────────────────────────────────────────────────────────

describe('forceArrowLength', () => {
  const distance = 10;
  const max = distance * ARROW_SCREEN_FRACTION;

  it('caps the strongest arrow at the screen-relative maximum', () => {
    expect(forceArrowLength(500, 500, distance)).toBeCloseTo(max, 12);
    // Anything above the reference is still capped — an outlier must not leave
    // the viewport and take the rest of the machine off screen with it.
    expect(forceArrowLength(5000, 500, distance)).toBeCloseTo(max, 12);
  });

  it('keeps a lightly loaded joint visible instead of shrinking it to nothing', () => {
    const tiny = forceArrowLength(0.5, 500, distance);
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeCloseTo(max * ARROW_MIN_FRACTION, 2);
  });

  it('is monotonic in magnitude', () => {
    const lengths = [1, 10, 100, 400, 500].map((m) => forceArrowLength(m, 500, distance));
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
    }
  });

  it('scales with the distance to the camera (screen-constant size)', () => {
    expect(forceArrowLength(500, 500, 20)).toBeCloseTo(2 * forceArrowLength(500, 500, 10), 12);
  });

  it('draws nothing for an unloaded joint or an empty reference', () => {
    expect(forceArrowLength(0, 500, distance)).toBe(0);
    expect(forceArrowLength(5, 0, distance)).toBe(0);
    expect(forceArrowLength(-5, 500, distance)).toBe(0);
  });
});

// ─── Colour ramp ────────────────────────────────────────────────────────────

describe('forceArrowColor', () => {
  it('ends of the ramp are the ramp ends', () => {
    expect(forceArrowColor(0, 100)).toBe(FORCE_RAMP[0]);
    expect(forceArrowColor(100, 100)).toBe(FORCE_RAMP[FORCE_RAMP.length - 1]);
    expect(forceArrowColor(1000, 100)).toBe(FORCE_RAMP[FORCE_RAMP.length - 1]);
  });

  it('hits the intermediate stops exactly at their fractions', () => {
    // Four stops → thirds.
    expect(forceArrowColor(100 / 3, 100)).toBe(FORCE_RAMP[1]);
    expect(forceArrowColor(200 / 3, 100)).toBe(FORCE_RAMP[2]);
  });

  it('interpolates between two stops rather than stepping', () => {
    const mid = forceArrowColor(100 / 6, 100);
    expect(mid).not.toBe(FORCE_RAMP[0]);
    expect(mid).not.toBe(FORCE_RAMP[1]);
    // Still a valid 24-bit colour.
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThanOrEqual(0xffffff);
  });

  it('falls back to the calm end when there is no reference', () => {
    expect(forceArrowColor(42, 0)).toBe(FORCE_RAMP[0]);
  });
});

// ─── Anchors from the joint view ────────────────────────────────────────────

describe('arrowTargetsFromSnapshot', () => {
  it('anchors on originWorld and points along forceWorld', () => {
    const targets = arrowTargetsFromSnapshot(snapshot());
    expect(targets).toHaveLength(2);
    expect(targets[0].origin.toArray()).toEqual([1, 2, 3]);
    expect(targets[0].force.toArray()).toEqual([3, 4, 0]);
    // 3-4-5 — the magnitude is |F|, not a component.
    expect(targets[0].magnitude).toBeCloseTo(5, 12);
    expect(targets[1].magnitude).toBeCloseTo(13, 12);
  });

  it('ties each arrow to its bearing-force SERIES by position, not by name', () => {
    const targets = arrowTargetsFromSnapshot(snapshot());
    expect(targets[0].channelId).toBe('Cell/Lift|joint0|F');
    expect(targets[1].channelId).toBe('Cell/Lift|joint1|F');
    // A renamed joint must not break the click-to-select path.
    const renamed = snapshot();
    renamed.joints[0].name = 'completely different';
    expect(arrowTargetsFromSnapshot(renamed)[0].channelId).toBe('Cell/Lift|joint0|F');
  });

  it('draws nothing while the dynamics is not valid', () => {
    expect(arrowTargetsFromSnapshot(snapshot({ dynamicsValid: false, status: 3 }))).toEqual([]);
    expect(arrowTargetsFromSnapshot(null)).toEqual([]);
  });

  it('skips a joint whose force is not finite', () => {
    const broken = snapshot();
    broken.joints[0].forceWorld = [Number.NaN, 0, 0];
    const targets = arrowTargetsFromSnapshot(broken);
    expect(targets).toHaveLength(1);
    expect(targets[0].name).toBe('J1');
  });
});

describe('referenceMagnitude', () => {
  it('is the largest magnitude on screen', () => {
    expect(referenceMagnitude(arrowTargetsFromSnapshot(snapshot()))).toBeCloseTo(13, 12);
    expect(referenceMagnitude([])).toBe(0);
  });
});
