// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Path DSL for the DiscreteEventSimulation scene generators (plan-612).
 *
 * Extracted from `agv-factory-paths.mjs`, unchanged in arithmetic so that
 * generator still writes byte-identical output: segment specs (`line`, `arc`,
 * `sCurve`), splitting long paths into pieces (`splitSpec`, `buildGraph`),
 * capacity-1 merge zones (`applyMergeZones`), the rv_extras `Path` payload
 * (`pathExtras`) and the template clone used for fleets (`cloneNode`).
 *
 * Coordinates are metres in the glTF ground plane (X, Z; Y up). An arc is
 * `center + radius·(cos a, sin a)` in (x, z), starting at `startAngle` and
 * sweeping `degrees` (positive = increasing angle).
 */

export const round = (v) => Math.round(v * 1e6) / 1e6;
export const v3 = (x, z) => [round(x), 0, round(z)];
export const line = (x0, z0, x1, z1) => ({ kind: 'line', from: v3(x0, z0), to: v3(x1, z1) });

/** One arc segment spec (degrees, XZ plane). */
export const arc = (cx, cz, radius, startAngle, degrees) => ({
  kind: 'arc', center: v3(cx, cz), radius: round(radius),
  startAngle: round(startAngle), degrees: round(degrees), plane: 'XZ',
});

/**
 * S-curve from (x0,z0) heading along ±X (`hx`), shifting by `offset` toward ±Z
 * (`sz`) over the longitudinal length `sLen`, built from two equal arcs with
 * opposite sweep. Returns two arc specs that meet tangent-continuously at the
 * midpoint and leave parallel to X.
 */
export function sCurve(x0, z0, hx, sz, { sLen, offset }) {
  const R = (sLen * sLen + offset * offset) / (4 * offset);
  const theta = Math.asin(sLen / (2 * R)); // sweep of each arc (rad)
  const arcAt = (px, pz, cx, cz, tx, tz) => {
    const a = Math.atan2(pz - cz, px - cx);
    // Sweep sign: the +sweep tangent (-sin a, cos a) must match the heading.
    const sign = (-Math.sin(a) * tx + Math.cos(a) * tz) >= 0 ? 1 : -1;
    return {
      spec: {
        kind: 'arc', center: v3(cx, cz), radius: round(R),
        startAngle: round(a * 180 / Math.PI), degrees: round(sign * theta * 180 / Math.PI), plane: 'XZ',
      },
      end: [cx + R * Math.cos(a + sign * theta), cz + R * Math.sin(a + sign * theta)],
    };
  };
  const first = arcAt(x0, z0, x0, z0 + sz * R, hx, 0);
  const [mx, mz] = first.end;
  const x1 = x0 + hx * sLen;
  const z1 = z0 + sz * offset;
  const midTangent = [hx * Math.cos(theta), sz * Math.sin(theta)];
  const second = arcAt(mx, mz, x1, z1 - sz * R, ...midTangent);
  const err = Math.hypot(second.end[0] - x1, second.end[1] - z1);
  if (err > 1e-6) throw new Error(`S-curve does not close (${err})`);
  return [first.spec, second.spec];
}

/** Split one segment spec into `n` equal pieces (line or arc). */
export function splitSpec(spec, n) {
  if (spec.kind === 'line') {
    return Array.from({ length: n }, (_, i) => {
      const a = i / n, b = (i + 1) / n;
      const at = (t) => spec.from.map((f, k) => round(f + (spec.to[k] - f) * t));
      return { kind: 'line', from: at(a), to: at(b) };
    });
  }
  const step = spec.degrees / n;
  return Array.from({ length: n }, (_, i) => ({ ...spec, startAngle: round(spec.startAngle + i * step), degrees: round(step) }));
}

/** Length of one segment spec (m). */
export const specLength = (s) => s.kind === 'line'
  ? Math.hypot(s.to[0] - s.from[0], s.to[2] - s.from[2])
  : s.radius * Math.abs(s.degrees) * Math.PI / 180;

/**
 * Final graph `[{ id, segments, successors }]` in `paths` order. A path of ONE
 * segment longer than `maxPiece` is split into pieces of at most `maxPiece`; the
 * first piece keeps the id, the rest are `<id>_2`, `<id>_3`, … Paths whose id
 * matches `keepWhole` (and multi-segment paths) stay whole. `order` lists the
 * pieces of every path NOT matching `keepWhole`, in graph order.
 */
export function buildGraph(paths, successors, { maxPiece, keepWhole }) {
  const graph = [];
  const order = [];
  for (const [id, segs] of Object.entries(paths)) {
    const len = segs.reduce((a, s) => a + specLength(s), 0);
    const n = keepWhole.test(id) || segs.length !== 1 ? 1 : Math.max(1, Math.ceil(len / maxPiece - 1e-9));
    const pieces = n === 1 ? [segs] : splitSpec(segs[0], n).map((s) => [s]);
    pieces.forEach((pieceSegs, i) => {
      const pid = i === 0 ? id : `${id}_${i + 1}`;
      const last = i === pieces.length - 1;
      graph.push({ id: pid, segments: pieceSegs, successors: last ? successors[id] : [`${id}_${i + 2}`] });
      if (!keepWhole.test(id)) order.push(pid);
    });
  }
  return { graph, order };
}

/** Id of the last piece of path `id` in `graph`. */
export const lastPieceOf = (graph, id) => graph.filter((p) => p.id === id || p.id.startsWith(`${id}_`)).at(-1).id;

/**
 * One capacity-1 reservation zone per merge: `merges[out] = [incoming…]`
 * covers the piece `out` plus the LAST piece of every incoming path, zone name
 * `<prefix><out>`.
 */
export function applyMergeZones(graph, merges, prefix = 'Merge') {
  for (const [out, incoming] of Object.entries(merges)) {
    for (const pid of [out, ...incoming.map((id) => lastPieceOf(graph, id))]) {
      const p = graph.find((g) => g.id === pid);
      p.zone = `${prefix}${out}`;
      p.zoneCapacity = 1;
    }
  }
}

/** The rv_extras payload of one graph entry (`extras.realvirtual`). */
export const pathExtras = (p) => ({ Path: {
  version: 1, id: p.id, segments: p.segments, closed: false, successors: p.successors, align: [0, 1, 0],
  ...(p.zone ? { zone: p.zone, zoneCapacity: p.zoneCapacity } : {}),
} });

/** Deep clone of a node subtree into `doc` (meshes shared, extras copied). */
export function cloneNode(doc, src, name) {
  const n = doc.createNode(name)
    .setTranslation(src.getTranslation()).setRotation(src.getRotation()).setScale(src.getScale())
    .setExtras(structuredClone(src.getExtras()));
  if (src.getMesh()) n.setMesh(src.getMesh());
  for (const c of src.listChildren()) n.addChild(cloneNode(doc, c, c.getName()));
  return n;
}
