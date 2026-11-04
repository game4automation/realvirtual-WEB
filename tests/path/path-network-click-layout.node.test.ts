// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9m / §9.9n / §9.9r (pure part) — the click-layout geometry
 * (8.11b), the typed-dimension parser (8.11c) and the turn-radius check of the
 * live markers (8.11g):
 *
 *  - a click within 5° of the travel direction → ONE straight, length on the
 *    0.25 m raster;
 *  - a click to the side → a tangential curve (15° raster, catalog radius) and
 *    the straight towards the click; the chain is tangent-continuous;
 *  - a foreign free start → an exact tangential connection (straight, or
 *    curve + straight with the radius solved), else null (open end);
 *  - typed length / angle override the plan; `m` / `°` suffixes, `,` decimal;
 *  - `path-radius-too-tight` with an envelope only, below width / 2.
 */

import { describe, expect, it } from 'vitest';
import {
  CLICK_LAYOUT_ANGLE_STEP_DEG,
  CLICK_LAYOUT_LENGTH_STEP_M,
  clickConnectPlan,
  clickLayoutDefaultRadius,
  clickLayoutPlan,
  clickStepArgs,
  parseTypedDimension,
  type FreePort,
} from '../../src/plugins/path-network/path-network-ui-model';
import { PATH_BLOCK_DEFAULTS, specEnds, headingOf } from '../../src/core/engine/rv-path-blocks';
import { PATH_MIN_RADIUS_WIDTH_FACTOR, validatePathNetwork } from '../../src/core/engine/rv-path-network-validate';
import { isPathLink } from '../../src/core/connect/path-link-tolerance';
import { Vector3 } from 'three';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';

const origin: FreePort = { pathId: 'PN_S1', end: 'end', position: [2, 0, 0], headingDeg: 0 };
const R = clickLayoutDefaultRadius();

/** Every consecutive segment pair of a spec chain is tangent-continuous (the 633 link rule). */
function tangentChain(specs: readonly PathSegmentSpec[]): boolean {
  for (let i = 1; i < specs.length; i++) {
    const a = specEnds([specs[i - 1]])!;
    const b = specEnds([specs[i]])!;
    const v = (t: readonly number[]): Vector3 => new Vector3(t[0], t[1], t[2]);
    if (!isPathLink(v(a.end.position), v(a.end.tangent), v(b.start.position), v(b.start.tangent))) return false;
  }
  return true;
}

describe('plan-628 9.9m click layout geometry (pure)', () => {
  it('the curve radius is the library curve entry default', () => {
    expect(R).toBe(PATH_BLOCK_DEFAULTS.radiusM);
  });

  it('a click within 5° ahead places ONE straight on the 0.25 m raster', () => {
    const p = clickLayoutPlan(origin, [2 + 3.37, 0, 0.2], R)!; // 3.4° off travel
    expect(p.steps).toEqual([{ kind: 'straight', lengthM: 3.25 }]);
    expect(p.end.position[0]).toBeCloseTo(5.25, 6);
    expect(p.end.headingDeg).toBeCloseTo(0, 6);
    expect(p.side).toBeUndefined();
  });

  it('a click to the side places a tangential curve (15° raster) + straight towards it', () => {
    // Far to the side: a 90° turn, then the straight.
    const left = clickLayoutPlan(origin, [2 + R, 0, -5], R)!;
    expect(left.steps[0]).toMatchObject({ kind: 'curve', radiusM: R, side: 'left' });
    expect((left.steps[0].degrees ?? 0) % CLICK_LAYOUT_ANGLE_STEP_DEG).toBe(0);
    expect(left.steps[0].degrees).toBe(90);
    expect(left.steps[1]?.kind).toBe('straight');
    expect(((left.steps[1].lengthM ?? 0) / CLICK_LAYOUT_LENGTH_STEP_M) % 1).toBeCloseTo(0, 9);
    expect(tangentChain(left.specs)).toBe(true);
    // The end of the run lies within one raster step of the click.
    expect(Math.hypot(left.end.position[0] - (2 + R), left.end.position[2] + 5)).toBeLessThan(CLICK_LAYOUT_LENGTH_STEP_M);
    const right = clickLayoutPlan(origin, [2 + R, 0, 5], R)!;
    expect(right.side).toBe('right');
    expect(right.steps[0].degrees).toBe(90);
    // 45°: a click on the 45° diagonal.
    const d45 = clickLayoutPlan(origin, [2 + 6, 0, 6], R)!;
    expect(d45.steps[0].degrees).toBe(45);
    expect(tangentChain(d45.specs)).toBe(true);
  });

  it('a foreign free start: exact tangential connection (straight / curve + straight), else null', () => {
    const ahead: FreePort = { pathId: 'X', end: 'start', position: [6, 0, 0], headingDeg: 0 };
    expect(clickConnectPlan(origin, ahead, R)!.steps).toEqual([{ kind: 'straight', lengthM: 4 }]);
    // 90° turn to the right (+Z with heading 90°), offset so a straight follows the curve.
    const side: FreePort = { pathId: 'Y', end: 'start', position: [2 + 2, 0, 5], headingDeg: 90 };
    const c = clickConnectPlan(origin, side, R)!;
    expect(c).not.toBeNull();
    expect(c.target).toBe(side);
    expect(c.steps.some((s) => s.kind === 'curve')).toBe(true);
    expect(Math.hypot(c.end.position[0] - 4, c.end.position[2] - 5)).toBeLessThan(1e-3);
    expect(c.end.headingDeg).toBeCloseTo(90, 3);
    expect(tangentChain(c.specs)).toBe(true);
    // An S-bend (parallel but offset) has no curve + straight solution.
    expect(clickConnectPlan(origin, { pathId: 'Z', end: 'start', position: [8, 0, 2], headingDeg: 0 }, R)).toBeNull();
    // A free END is never a target.
    expect(clickConnectPlan(origin, { ...ahead, end: 'end' }, R)).toBeNull();
  });

  it('step args attach every step at the END of the previous path', () => {
    expect(clickStepArgs({ kind: 'curve', radiusM: 1.23456, degrees: 90, side: 'left' }, 'PN_S1'))
      .toEqual({ block: 'curve', atPath: 'PN_S1', atEnd: 'end', radiusM: 1.2346, degrees: 90, side: 'left' });
  });
});

describe('plan-628 9.9n typed dimensions (pure)', () => {
  it('parse: field from the context, m / ° / d suffix forces it, comma decimal, garbage → null', () => {
    expect(parseTypedDimension('3.5', 'length')).toEqual({ field: 'length', value: 3.5 });
    expect(parseTypedDimension('90', 'angle')).toEqual({ field: 'angle', value: 90 });
    expect(parseTypedDimension('90°', 'length')).toEqual({ field: 'angle', value: 90 });
    expect(parseTypedDimension('45d', 'length')).toEqual({ field: 'angle', value: 45 });
    expect(parseTypedDimension('2m', 'angle')).toEqual({ field: 'length', value: 2 });
    expect(parseTypedDimension('1,5', 'length')).toEqual({ field: 'length', value: 1.5 });
    expect(parseTypedDimension('.', 'length')).toBeNull();
    expect(parseTypedDimension('1.2.3', 'length')).toBeNull();
  });

  it('typed length sets the straight; typed angle sets the curve (angle 0 = straight)', () => {
    const ahead = clickLayoutPlan(origin, [5, 0, 0.1], R, { lengthM: 3.5 })!;
    expect(ahead.steps).toEqual([{ kind: 'straight', lengthM: 3.5 }]);
    const turn = clickLayoutPlan(origin, [4, 0, -3], R, { degrees: 90 })!;
    expect(turn.steps).toEqual([{ kind: 'curve', radiusM: R, degrees: 90, side: 'left' }]);
    expect(turn.end.headingDeg).toBeCloseTo(-90, 6);
    const both = clickLayoutPlan(origin, [4, 0, 3], R, { degrees: 45, lengthM: 2 })!;
    expect(both.steps).toEqual([{ kind: 'curve', radiusM: R, degrees: 45, side: 'right' }, { kind: 'straight', lengthM: 2 }]);
    // On a curve preview, a typed length replaces only the straight after it.
    const side = clickLayoutPlan(origin, [2 + R, 0, -5], R, { lengthM: 1 })!;
    expect(side.steps[0]).toMatchObject({ kind: 'curve', degrees: 90 });
    expect(side.steps[1]).toEqual({ kind: 'straight', lengthM: 1 });
  });
});

describe('plan-628 9.9r turn radius check (pure)', () => {
  const curve = (radius: number): PathSegmentSpec => ({ kind: 'arc', center: [0, 0, radius], radius, startAngle: -90, degrees: 90 } as PathSegmentSpec);
  const net = (radius: number) => ({ paths: [{ id: 'C', nodeName: 'C', block: '', segments: [curve(radius)], successors: [] }] });
  it('below width × factor → path-radius-too-tight (warning, with a short label); none without an envelope', () => {
    const env = { front: 0.6, rear: 0.6, width: 1.0 };
    const min = env.width * PATH_MIN_RADIUS_WIDTH_FACTOR;
    const tight = validatePathNetwork(net(min - 0.1) as never, { env }).issues.filter((i) => i.code === 'path-radius-too-tight');
    expect(tight).toHaveLength(1);
    expect(tight[0].severity).toBe('warning');
    expect(tight[0].short).toMatch(/^R 0\.40 m < 0\.50 m$/);
    expect(tight[0].position).toBeDefined();
    expect(validatePathNetwork(net(min + 0.1) as never, { env }).issues.some((i) => i.code === 'path-radius-too-tight')).toBe(false);
    expect(validatePathNetwork(net(0.1) as never, {}).issues.some((i) => i.code === 'path-radius-too-tight')).toBe(false);
    // headingOf is the shared convention the plans use (sanity).
    expect(headingOf([0, 0, 1])).toBeCloseTo(90, 9);
  });
});
