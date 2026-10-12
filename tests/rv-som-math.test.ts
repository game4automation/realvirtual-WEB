// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-som-math — Set-of-Mark placement (plan-740 §9.4).
 *
 * The whole value of a numbered mark is that the number sits ON the thing it
 * names. Every case below is a shape where the obvious answer (the centroid)
 * lands somewhere else: a ring's centroid is in the hole, an L's centroid is in
 * the notch, and a sliver has no interior at all. If these pass, a mark labels
 * the part an agent is looking at rather than whatever is behind it.
 */

import { describe, expect, it } from 'vitest';
import {
  SOM_NO_GROUP, computeMarks, poleOfInaccessibility,
} from '../src/plugins/mcp-bridge/rv-som-math';

/** Build an id mask from a predicate: `f(x,y)` returns a group index or null. */
function mask(w: number, h: number, f: (x: number, y: number) => number | null): Uint16Array {
  const id = new Uint16Array(w * h).fill(SOM_NO_GROUP);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = f(x, y);
      if (g !== null) id[y * w + x] = g;
    }
  }
  return id;
}

describe('computeMarks — placement', () => {
  it('puts the mark ON a ring, never in its hole', () => {
    const W = 200, H = 200, cx = 100, cy = 100;
    const id = mask(W, H, (x, y) => {
      const r = Math.hypot(x - cx, y - cy);
      return r > 55 && r < 85 ? 0 : null;
    });
    const [m] = computeMarks(id, W, H);
    expect(m).toBeDefined();
    // Inside the annulus, i.e. NOT at the centroid (which is the hole's centre).
    const r = Math.hypot(m.x - cx, m.y - cy);
    expect(r).toBeGreaterThan(55);
    expect(r).toBeLessThan(85);
    expect(id[Math.round(m.y) * W + Math.round(m.x)]).toBe(0);
    expect(m.n).toBe(1);
  });

  it('puts the mark inside the thicker limb of an L, not in the notch', () => {
    // A 200×200 L: a 60 px wide vertical limb and a 30 px tall horizontal one.
    const W = 200, H = 200;
    const id = mask(W, H, (x, y) => {
      if (x < 60 && y < 180) return 0;         // thick vertical limb
      if (y >= 150 && y < 180 && x < 180) return 0; // thin horizontal foot
      return null;
    });
    const [m] = computeMarks(id, W, H);
    // The deepest interior point of the L is in the WIDE limb, and the notch
    // (x>60, y<150) must not be chosen at all.
    expect(id[Math.round(m.y) * W + Math.round(m.x)]).toBe(0);
    expect(m.x).toBeLessThan(60);
  });

  it('caps at 24 marks and numbers by descending visible area', () => {
    // 30 vertical stripes of decreasing width — group 0 is the widest.
    const W = 900, H = 120;
    const widths = Array.from({ length: 30 }, (_, i) => 29 - i);
    const starts: number[] = [];
    let acc = 0;
    for (const w of widths) { starts.push(acc); acc += w; }
    const id = mask(W, H, (x) => {
      for (let g = 0; g < widths.length; g++) {
        if (x >= starts[g] && x < starts[g] + widths[g]) return g;
      }
      return null;
    });
    const marks = computeMarks(id, W, H);
    expect(marks).toHaveLength(24);
    expect(marks[0].n).toBe(1);
    expect(marks[0].groupIndex).toBe(0);         // widest stripe = largest area
    expect(marks[0].areaPx).toBeGreaterThan(marks[1].areaPx);
    // The 6 smallest stripes are dropped, not renumbered into the list.
    expect(marks.map((m) => m.groupIndex)).not.toContain(29);
  });

  it('never overlaps two mark discs, and gives the crowded one a leader', () => {
    // Two small neighbouring squares, each narrower than the mark disc and
    // closer together than 2×radius — the crowding case.
    const W = 200, H = 200;
    const id = mask(W, H, (x, y) => {
      if (x >= 92 && x < 100 && y >= 92 && y < 100) return 0;
      if (x >= 104 && x < 112 && y >= 92 && y < 100) return 1;
      return null;
    });
    const marks = computeMarks(id, W, H);
    expect(marks).toHaveLength(2);
    const d = Math.hypot(marks[0].x - marks[1].x, marks[0].y - marks[1].y);
    const radius = 0.022 * Math.min(W, H);
    expect(d).toBeGreaterThanOrEqual(radius * 2 - 1);
    // Both squares are narrower than the disc, so both get a leader anchored
    // inside their own pixels.
    for (const m of marks) {
      expect(m.leader).toBeDefined();
      const [lx, ly] = m.leader!;
      expect(id[Math.round(ly) * W + Math.round(lx)]).toBe(m.groupIndex);
    }
  });

  it('gives a segment smaller than the marker radius a leader into itself', () => {
    const W = 400, H = 400;
    const id = mask(W, H, (x, y) => (x >= 200 && x < 204 && y >= 100 && y < 300 ? 0 : null));
    const [m] = computeMarks(id, W, H);
    expect(m.leader).toBeDefined();
    const [lx, ly] = m.leader!;
    expect(id[Math.round(ly) * W + Math.round(lx)]).toBe(0);
    // bbox still describes the sliver itself.
    expect(m.bbox[0]).toBe(200);
    expect(m.bbox[2]).toBe(203);
  });

  it('labels the LARGEST connected component when a group is split', () => {
    const W = 300, H = 200;
    const id = mask(W, H, (x, y) => {
      if (x >= 10 && x < 110 && y >= 40 && y < 160) return 0; // big slab
      if (x >= 250 && x < 254 && y >= 98 && y < 102) return 0; // stray fragment
      return null;
    });
    const [m] = computeMarks(id, W, H);
    expect(m.x).toBeGreaterThan(10);
    expect(m.x).toBeLessThan(110);
    // The bbox still spans BOTH components — the group is one object.
    expect(m.bbox[2]).toBeGreaterThan(250);
  });

  it('returns [] for an empty mask', () => {
    expect(computeMarks(new Uint16Array(64 * 64).fill(SOM_NO_GROUP), 64, 64)).toEqual([]);
    expect(computeMarks(new Uint16Array(0), 0, 0)).toEqual([]);
  });

  it('halves a 2048-wide mask and scales the coordinates back up', () => {
    const W = 2048, H = 1024;
    const id = mask(W, H, (x, y) =>
      (x >= 1000 && x < 1400 && y >= 400 && y < 700 ? 0 : null));
    const [m] = computeMarks(id, W, H);
    // Coordinates are reported in FULL-resolution pixels even though the
    // transform ran on the halved raster.
    expect(m.x).toBeGreaterThan(1000);
    expect(m.x).toBeLessThan(1400);
    expect(m.y).toBeGreaterThan(400);
    expect(m.y).toBeLessThan(700);
    // Halving keeps every coordinate even — the tell that it happened.
    expect(m.x % 2).toBe(0);
  });
});

describe('poleOfInaccessibility', () => {
  it('finds the centre of a solid square and reports its inradius', () => {
    const w = 41, h = 41;
    const m = new Uint8Array(w * h).fill(1);
    const p = poleOfInaccessibility(m, w, h);
    expect(p.x).toBeGreaterThan(15);
    expect(p.x).toBeLessThan(25);
    // Chamfer 3-4 is within a few percent of the true inradius (21).
    expect(p.dist).toBeGreaterThan(18);
    expect(p.dist).toBeLessThan(24);
  });

  it('reports distance 0 for an empty mask', () => {
    expect(poleOfInaccessibility(new Uint8Array(16), 4, 4).dist).toBe(0);
  });
});
