// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-520 §9.1 — the pure "Follow agent" decision (rules 1-7) and the
 * 8-corner screen-rect projection.
 */

import { describe, it, expect } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import {
  decideFollow,
  computeScreenRect,
  type FollowInput,
} from '../src/plugins/mcp-bridge/rv-mcp-follow-policy';

const base: FollowInput = {
  enabled: true, idle: true, hidden: false, xrPresenting: false, cameraFollowMode: 'off',
  targetKey: 'A', lastTargetKey: null, now: 10_000, lastFlightAt: -Infinity,
  rect: { cx: 0, cy: 0, w: 0.1, h: 0.1, behind: false },
};

describe('decideFollow', () => {
  it('flies to a small centered target when idle', () => expect(decideFollow(base)).toBe('fly'));
  it('stays when target is large and centered', () =>
    expect(decideFollow({ ...base, rect: { cx: 0, cy: 0, w: 0.8, h: 0.6, behind: false } })).toBe('none'));
  it('flies when large but off-center', () =>
    expect(decideFollow({ ...base, rect: { cx: 0.7, cy: 0, w: 0.8, h: 0.6, behind: false } })).toBe('fly'));
  it('falls back when user is active', () => expect(decideFollow({ ...base, idle: false })).toBe('fallback'));
  it('falls back when disabled', () => expect(decideFollow({ ...base, enabled: false })).toBe('fallback'));
  it('does not fly twice to the same target', () => expect(decideFollow({ ...base, lastTargetKey: 'A' })).toBe('none'));
  it('respects cooldown', () => expect(decideFollow({ ...base, lastFlightAt: 9_000 })).toBe('none'));
  it('never flies while camera follow mode is active', () =>
    expect(decideFollow({ ...base, cameraFollowMode: 'follow' })).toBe('none'));
  it('flies to an offscreen / behind target', () =>
    expect(decideFollow({ ...base, rect: { cx: 0, cy: 0, w: 0.5, h: 0.5, behind: true } })).toBe('fly'));
  it('flies to a target whose center is outside the viewport', () =>
    expect(decideFollow({ ...base, rect: { cx: 1.4, cy: 0, w: 0.5, h: 0.5, behind: false } })).toBe('fly'));
  it('stays on a hidden tab, in WebXR and without bounds', () => {
    expect(decideFollow({ ...base, hidden: true })).toBe('none');
    expect(decideFollow({ ...base, xrPresenting: true })).toBe('none');
    expect(decideFollow({ ...base, rect: null })).toBe('none');
  });
  it('rule 1 wins over every guard (user active on a hidden tab = fallback)', () =>
    expect(decideFollow({ ...base, idle: false, hidden: true, rect: null })).toBe('fallback'));
});

describe('computeScreenRect', () => {
  const cam = new PerspectiveCamera(50, 1, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);

  it('returns null for an empty box', () => {
    expect(computeScreenRect(cam, new Box3())).toBeNull();
  });

  it('centers a box at the origin and reports its size', () => {
    const r = computeScreenRect(cam, new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)))!;
    expect(r.cx).toBeCloseTo(0, 5);
    expect(r.cy).toBeCloseTo(0, 5);
    expect(r.w).toBeGreaterThan(0.3);
    expect(r.behind).toBe(false);
  });

  it('flags a box behind the camera', () => {
    const r = computeScreenRect(cam, new Box3(new Vector3(-1, -1, 20), new Vector3(1, 1, 22)))!;
    expect(r.behind).toBe(true);
  });

  it('places an off-axis box off-center', () => {
    const r = computeScreenRect(cam, new Box3(new Vector3(3, -0.5, -0.5), new Vector3(4, 0.5, 0.5)))!;
    expect(r.cx).toBeGreaterThan(0.5);
  });
});
