// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 M7 — the pure distance kernel of `rv-mesh-gap.ts` and the measured
 * cost behind `GAP_TRIANGLE_BUDGET`.
 */

import { describe, expect, it } from 'vitest';
import { BoxGeometry, PlaneGeometry, SphereGeometry } from 'three';
import { GAP_TRIANGLE_BUDGET, measureGap } from '../src/plugins/mcp-bridge/rv-mesh-gap';

function soup(g: import('three').BufferGeometry, x = 0, y = 0, z = 0): Float32Array {
  const n = g.index ? g.toNonIndexed() : g;
  n.translate(x, y, z);
  return (n.getAttribute('position').array as Float32Array).slice();
}

describe('measureGap', () => {
  it('separated boxes: exact gap in mm with closest points', () => {
    const r = measureGap(soup(new BoxGeometry(1, 1, 1)), soup(new BoxGeometry(1, 1, 1), 1.005));
    expect(r.gapMm).toBeCloseTo(5, 3);
    expect(r).toMatchObject({ overlap: false, contained: false, contact: false });
    expect(r.closestA![0]).toBeCloseTo(500, 3);
    expect(r.closestB![0]).toBeCloseTo(505, 3);
  });

  it('crossing → overlap, enclosed → contained', () => {
    expect(measureGap(soup(new BoxGeometry(1, 1, 1)), soup(new BoxGeometry(1, 1, 1), 0.5, 0.2)))
      .toMatchObject({ gapMm: 0, overlap: true, contact: true, contained: false });
    expect(measureGap(soup(new BoxGeometry(1, 1, 1)), soup(new BoxGeometry(0.1, 0.1, 0.1))))
      .toMatchObject({ gapMm: 0, overlap: true, contained: true, containedIn: 'b' });
  });

  it('measured cost of a budget-sized check (logged; the budget in rv-mesh-gap.ts comes from here)', () => {
    const a = soup(new SphereGeometry(0.1, 314, 160));
    const b = soup(new SphereGeometry(0.1, 314, 160), 0.25);
    const tris = (a.length + b.length) / 9;
    const t0 = performance.now();
    const r = measureGap(a, b);
    const ms = performance.now() - t0;
    console.info(`[plan-641 budget] ${tris} triangles: ${ms.toFixed(0)} ms, gap ${r.gapMm} mm`);
    expect(r.gapMm).toBeCloseTo(50, 0);
    expect(tris).toBeLessThanOrEqual(GAP_TRIANGLE_BUDGET);
  }, 120_000);

  it('measured worst case: two dense parallel plates 0.05 mm apart at the budget (weak pruning)', () => {
    const a = soup(new PlaneGeometry(0.2, 0.2, 223, 223));
    const b = soup(new PlaneGeometry(0.2, 0.2, 223, 223), 0, 0, 0.00005);
    const tris = (a.length + b.length) / 9;
    const t0 = performance.now();
    const r = measureGap(a, b);
    const ms = performance.now() - t0;
    console.info(`[plan-641 budget] parallel plates ${tris} triangles: ${ms.toFixed(0)} ms, gap ${r.gapMm} mm`);
    expect(r.gapMm).toBeCloseTo(0.05, 3);
    expect(r.contact).toBe(true);
    expect(tris).toBeLessThanOrEqual(GAP_TRIANGLE_BUDGET);
  }, 300_000);
});
