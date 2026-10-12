// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-som-math — Set-of-Mark placement (plan-740 P2.4 / D-U12).
 *
 * Set-of-Mark prompting (Yang et al. 2023, arXiv:2310.11441) is the finding
 * that a vision model asked "which part is the drive shaft" answers far better
 * when the candidates carry NUMBERED marks than when it has to describe a
 * position in words. The paper's own ablation: number + colour area beats
 * number alone, and exact masks beat boxes. We have exact masks — the idmask
 * `idBuffer` is the segmentation, not an estimate of one.
 *
 * The hard part is not numbering, it is WHERE to put the number. A centroid is
 * wrong for anything non-convex: the centroid of a ring, a C-bracket or an
 * L-profile lands outside the part, on whatever is behind it. The mark then
 * labels the wrong object, which is worse than no mark. So each mark goes at
 * the **pole of inaccessibility** — the interior point furthest from any
 * boundary (the polylabel idea, computed here on the raster with a Chamfer
 * distance transform because we already have pixels and want no dependency).
 *
 * PURE MODULE. No DOM, no three.js, no canvas — the geometry is testable on a
 * hand-built `Uint16Array`, and the drawing lives in `rv-annotate.ts`.
 */

/** Default cap on marks. ~20-25 is the readability limit (Roboflow, §8). */
export const SOM_DEFAULT_CAP = 24;

/** Above this long edge the mask is halved before labelling (§2.4.5). */
export const SOM_MAX_EDGE = 1024;

/**
 * Mark radius as a fraction of the SHORT image edge.
 *
 * Halved from 0.022 on 2026-09-14. Legibility is an ABSOLUTE property — a
 * two-digit label needs its ~12 px of type and not one pixel more — while the
 * disc was scaled relative to the frame, so raising the capture floor to 1024
 * made every marker 45 px across and it started hiding the part it pointed at.
 * The floor below is what keeps it readable; the fraction only lets marks grow
 * with genuinely large sheets (an ortho mosaic is downscaled for transport, so
 * its marks have to be drawn oversized to survive that).
 */
export const SOM_RADIUS_FRACTION = 0.011;

/** Absolute floor: under ~10 px the two-digit label stops being legible. */
export const SOM_RADIUS_MIN_PX = 10;

/**
 * The radius BOTH placement and drawing must use.
 *
 * They used to compute it separately — same fraction, different floors (6 vs 9)
 * — so on a small frame the discs were drawn larger than the spacing that had
 * been reserved for them and overlapped.
 */
export function somRadius(width: number, height: number): number {
  return Math.max(SOM_RADIUS_MIN_PX, SOM_RADIUS_FRACTION * Math.min(width, height));
}

/** Sentinel for "no group owns this pixel" — mirrors `IDMASK_NO_GROUP`. */
export const SOM_NO_GROUP = 0xFFFF;

export interface SomMark {
  /** 1-based label, assigned by descending visible area. */
  n: number;
  /** Index into the idmask palette / legend. */
  groupIndex: number;
  /** Mark centre in image pixels (the pole of inaccessibility, or moved). */
  x: number;
  y: number;
  /** Visible pixel count of the whole group (not just the labelled blob). */
  areaPx: number;
  /** Screen box of the whole group: [x0, y0, x1, y1] in pixels. */
  bbox: [number, number, number, number];
  /**
   * When the group is too small (or too crowded) to hold the disc, the mark
   * sits outside and a leader line points here — a point INSIDE the group.
   */
  leader?: [number, number];
}

export interface SomOptions {
  cap?: number;
  /** Radius override in pixels (default `SOM_RADIUS_FRACTION · min(w,h)`). */
  radius?: number;
}

/**
 * Place numbered marks on the groups of an ID mask.
 *
 * `id` is one entry per pixel, row-major, top-down; `SOM_NO_GROUP` = background.
 * Returns marks ordered by descending visible area, numbered from 1. An empty
 * (all-background) mask yields `[]` rather than an error — "nothing visible" is
 * a legitimate answer for a camera pointing at the sky.
 */
export function computeMarks(
  id: Uint16Array, w: number, h: number, cap: number = SOM_DEFAULT_CAP,
  options: SomOptions = {},
): SomMark[] {
  if (w <= 0 || h <= 0 || id.length < w * h) return [];

  // Halve oversized masks: the distance transform and the component labelling
  // are both O(pixels), and 2048² is four times the work for a mark position
  // that moves by half a pixel. Coordinates scale back up at the end.
  let src = id, W = w, H = h, upscale = 1;
  while (Math.max(W, H) > SOM_MAX_EDGE) {
    const nw = Math.max(1, W >> 1), nh = Math.max(1, H >> 1);
    const half = new Uint16Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) half[y * nw + x] = src[(y * 2) * W + x * 2];
    }
    src = half; W = nw; H = nh; upscale *= 2;
  }

  // ── 1. Pixel count + bbox per group ──
  const areas = new Map<number, number>();
  const boxes = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const g = src[y * W + x];
      if (g === SOM_NO_GROUP) continue;
      areas.set(g, (areas.get(g) ?? 0) + 1);
      const b = boxes.get(g);
      if (!b) boxes.set(g, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
  }
  if (areas.size === 0) return [];

  // ── 2. Top `cap` by visible area ──
  const ranked = [...areas.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, Math.max(0, Math.round(cap)));

  const radius = options.radius ?? somRadius(W, H);
  const placed: Array<{ x: number; y: number }> = [];
  const marks: SomMark[] = [];

  for (let rank = 0; rank < ranked.length; rank++) {
    const [group, areaPx] = ranked[rank];
    const box = boxes.get(group)!;
    // ── 3. Largest connected component (4-neighbourhood, union-find free:
    //      a scanline flood fill is simpler and allocates one queue). ──
    const blob = largestComponent(src, W, H, group, box);
    // ── 4. Chamfer 3-4 distance transform → the deepest interior pixel. ──
    const pole = poleOfInaccessibility(blob.mask, blob.w, blob.h);
    let x = blob.x0 + pole.x;
    let y = blob.y0 + pole.y;
    let leader: [number, number] | undefined;

    // ── 5. Too thin to hold the disc → the mark moves out, a leader points in.
    if (pole.dist < radius) {
      leader = [x, y];
    }
    // ── 6. Greedy overlap resolution: slide DOWN the distance gradient (still
    //      inside the blob) before giving up and turning it into a leader.
    if (!leader && overlapsAny(x, y, placed, radius * 2)) {
      const moved = relocate(blob, x, y, placed, radius);
      if (moved) { x = moved.x; y = moved.y; }
      else leader = [x, y];
    }
    if (leader) {
      const spot = freeSpotNear(leader[0], leader[1], placed, radius, W, H);
      x = spot.x; y = spot.y;
    }
    placed.push({ x, y });
    marks.push({
      n: rank + 1,
      groupIndex: group,
      x: x * upscale,
      y: y * upscale,
      areaPx: areaPx * upscale * upscale,
      bbox: [box[0] * upscale, box[1] * upscale, box[2] * upscale, box[3] * upscale],
      ...(leader ? { leader: [leader[0] * upscale, leader[1] * upscale] as [number, number] } : {}),
    });
  }
  return marks;
}

// ─── Internals ──────────────────────────────────────────────────────────

interface Blob {
  /** 1 = inside the component, 0 = outside. */
  mask: Uint8Array;
  w: number; h: number;
  /** Offset of the blob's sub-raster inside the full image. */
  x0: number; y0: number;
}

/**
 * The largest 4-connected component of `group`, cropped to its own bounding
 * box.
 *
 * The largest component and not the union: a part split by an occluder into a
 * big slab and three stray pixels must be labelled on the slab, and a distance
 * transform over the union would happily pick a spot the eye cannot associate
 * with the number.
 */
function largestComponent(
  src: Uint16Array, W: number, H: number, group: number,
  box: [number, number, number, number],
): Blob {
  const [bx0, by0, bx1, by1] = box;
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const label = new Int32Array(bw * bh).fill(-1);
  const queue = new Int32Array(bw * bh);
  let best = -1, bestSize = -1;
  let next = 0;
  for (let i = 0; i < bw * bh; i++) {
    const x = bx0 + (i % bw), y = by0 + Math.floor(i / bw);
    if (src[y * W + x] !== group || label[i] !== -1) continue;
    const id = next++;
    let head = 0, tail = 0;
    queue[tail++] = i;
    label[i] = id;
    let size = 0;
    while (head < tail) {
      const cur = queue[head++];
      size++;
      const cx = cur % bw, cy = (cur / bw) | 0;
      for (const [dx, dy] of NEIGHBOURS4) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const ni = ny * bw + nx;
        if (label[ni] !== -1) continue;
        if (src[(by0 + ny) * W + (bx0 + nx)] !== group) continue;
        label[ni] = id;
        queue[tail++] = ni;
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  const mask = new Uint8Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) mask[i] = label[i] === best ? 1 : 0;
  return { mask, w: bw, h: bh, x0: bx0, y0: by0 };
}

const NEIGHBOURS4: ReadonlyArray<readonly [number, number]> =
  [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Chamfer 3-4 distance transform of `mask`, scaled back to pixel units, and
 * the position of its maximum.
 *
 * Chamfer 3-4 (two passes, integer arithmetic) is within ~2 % of the true
 * Euclidean distance — far better than the ~8 % of a city-block transform, and
 * three orders of magnitude cheaper than an exact one. Outside pixels start at
 * 0, so the transform measures distance to the nearest boundary, which is
 * exactly the polylabel objective.
 */
export function poleOfInaccessibility(
  mask: Uint8Array, w: number, h: number,
): { x: number; y: number; dist: number } {
  const INF = 1 << 28;
  const d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number): number =>
    (x < 0 || y < 0 || x >= w || y >= h) ? 0 : d[y * w + x];
  // Forward pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      m = Math.min(m, at(x - 1, y) + 3, at(x, y - 1) + 3);
      m = Math.min(m, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
      d[i] = m;
    }
  }
  // Backward pass.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      m = Math.min(m, at(x + 1, y) + 3, at(x, y + 1) + 3);
      m = Math.min(m, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
      d[i] = m;
    }
  }
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = d[y * w + x];
      if (v > best) { best = v; bx = x; by = y; }
    }
  }
  return { x: bx, y: by, dist: best <= 0 ? 0 : best / 3 };
}

function overlapsAny(
  x: number, y: number, placed: ReadonlyArray<{ x: number; y: number }>, minDist: number,
): boolean {
  for (const p of placed) {
    if (Math.hypot(p.x - x, p.y - y) < minDist) return true;
  }
  return false;
}

/**
 * Find another interior pixel of the same blob that clears every placed mark,
 * preferring deep interior points. Returns null when the blob has no free spot.
 */
function relocate(
  blob: Blob, _x: number, _y: number,
  placed: ReadonlyArray<{ x: number; y: number }>, radius: number,
): { x: number; y: number } | null {
  const cand: Array<{ x: number; y: number; d: number }> = [];
  const dt = poleField(blob.mask, blob.w, blob.h);
  for (let y = 0; y < blob.h; y++) {
    for (let x = 0; x < blob.w; x++) {
      const v = dt[y * blob.w + x];
      if (v < radius) continue;
      const gx = blob.x0 + x, gy = blob.y0 + y;
      if (overlapsAny(gx, gy, placed, radius * 2)) continue;
      cand.push({ x: gx, y: gy, d: v });
    }
  }
  if (cand.length === 0) return null;
  cand.sort((a, b) => b.d - a.d);
  return { x: cand[0].x, y: cand[0].y };
}

/** The distance field alone (same transform as `poleOfInaccessibility`). */
function poleField(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1 << 28;
  const d = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  const at = (x: number, y: number): number =>
    (x < 0 || y < 0 || x >= w || y >= h) ? 0 : d[y * w + x];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] / 3;
  return out;
}

/**
 * A spot for a leader-line mark: spiral outwards from the anchor until the disc
 * clears every placed mark and still sits inside the image.
 */
function freeSpotNear(
  ax: number, ay: number, placed: ReadonlyArray<{ x: number; y: number }>,
  radius: number, w: number, h: number,
): { x: number; y: number } {
  const step = radius * 1.6;
  for (let ring = 1; ring <= 8; ring++) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
      const x = Math.round(ax + Math.cos(a) * step * ring);
      const y = Math.round(ay + Math.sin(a) * step * ring);
      if (x < radius || y < radius || x > w - radius || y > h - radius) continue;
      if (!overlapsAny(x, y, placed, radius * 2)) return { x, y };
    }
  }
  // Nowhere free: clamp into the frame and accept the overlap rather than
  // dropping the mark — an unlabelled group is invisible to the agent.
  return {
    x: Math.min(Math.max(ax, radius), w - radius),
    y: Math.min(Math.max(ay, radius), h - radius),
  };
}
