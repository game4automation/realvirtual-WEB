// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/** plan-663: worker/Node kernel. Inputs are immutable, column-major, and in metres.
 * Load this module lazily; do not import it from the HMI entry. Contact ids use
 * ORIGINAL accessor numbering, so preprocessing cannot silently invalidate locks.
 */
import { surface } from './rv-mesh-simplify-bvh';
export interface SimplifyOptions {
  errorMm: number;
  ratio?: number;
  lockBorder: boolean;
  normalWeight?: number;
}
export interface SimplifyInput {
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  index: Uint32Array;
  worldStretchMax: number;
}
export type SimplifyResult = SimplifyInput;
export type GeometryClass = 'small' | 'barely-reducible' | 'reducible';
export interface GeometryResult {
  status: 'simplified' | 'skipped' | 'kept';
  reason: string;
  /** Unsupported geometry is skipped without probing; only triangle inputs get a class. */
  classification: GeometryClass | null;
  mesh: SimplifyResult;
  attempts: number;
}
export interface EligibilityDescriptor {
  materialCount: number;
  hasColor?: boolean;
  hasTangent?: boolean;
  hasUv1?: boolean;
  isInstanced?: boolean;
  isSkinned?: boolean;
  hasMorph?: boolean;
  interleaved?: boolean;
  nonTriangle?: boolean;
}
export function eligibility(d: EligibilityDescriptor): string | null {
  if (d.materialCount !== 1)
    return 'multi-material';
  const flags = ['hasColor', 'hasTangent', 'hasUv1', 'isInstanced', 'isSkinned', 'hasMorph', 'interleaved', 'nonTriangle'] as const;
  const reasons = ['vertex-color', 'tangent', 'uv1', 'instanced', 'skinned', 'morph', 'interleaved', 'non-triangle'];
  return reasons[flags.findIndex(k => d[k])] ?? null;
}
export type Matrix = ArrayLike<number>;
function transform(m: Matrix, x: number, y: number, z: number, out: Float64Array | Float32Array, offset = 0): void {
  out[offset] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[offset + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[offset + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}
/** Jacobi eigenvalues of A^T A avoid the single-start power iteration blind spot. */
export function worldStretchMax(m: Matrix): number {
  if (m.length !== 9 && m.length !== 16)
    throw new Error('Expected a 3x3 or 4x4 matrix');
  const stride = m.length === 9 ? 3 : 4;
  const a = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => m[i * stride] * m[j * stride] + m[i * stride + 1] * m[j * stride + 1] + m[i * stride + 2] * m[j * stride + 2]));
  for (let iter = 0; iter < 32; iter++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]])
      if (Math.abs(a[i][j]) > Math.abs(a[p][q])) {
        p = i;
        q = j;
      }
    if (Math.abs(a[p][q]) <= Number.EPSILON * Math.max(...a.map((r, i) => Math.abs(r[i]))))
      break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(angle), s = Math.sin(angle), pp = a[p][p], qq = a[q][q], pq = a[p][q];
    a[p][p] = c * c * pp - 2 * s * c * pq + s * s * qq;
    a[q][q] = s * s * pp + 2 * s * c * pq + c * c * qq;
    a[p][q] = a[q][p] = 0;
    for (let k = 0; k < 3; k++)
      if (k !== p && k !== q) {
        const kp = a[k][p], kq = a[k][q];
        a[k][p] = a[p][k] = c * kp - s * kq;
        a[k][q] = a[q][k] = s * kp + c * kq;
      }
  }
  return Math.sqrt(Math.max(0, a[0][0], a[1][1], a[2][2]));
}
export function maxWorldStretch(users: readonly Matrix[]): number {
  return users.reduce((max, m) => Math.max(max, worldStretchMax(m)), 0);
}
export function localErrorBound(errorMm: number, stretch: number): number {
  if (!(errorMm >= 0 && Number.isFinite(errorMm) && stretch > 0 && Number.isFinite(stretch)))
    throw new Error('Invalid error or world stretch');
  return errorMm / 1000 / stretch;
}
async function simplifier() {
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;
  return MeshoptSimplifier;
}
function take(g: SimplifyInput, first: number[], index: Uint32Array): SimplifyInput {
  const copy = (a: Float32Array | undefined, n: number) => {
    if (!a)
      return undefined;
    const out = new Float32Array(first.length * n);
    for (let i = 0; i < first.length; i++)
      for (let c = 0; c < n; c++) out[i * n + c] = a[first[i] * n + c];
    return out;
  };
  return { positions: copy(g.positions, 3)!, normals: copy(g.normals, 3), uvs: copy(g.uvs, 2), index, worldStretchMax: g.worldStretchMax };
}
/** Compact FIRST; hash only referenced vertices, preserving all attribute bits. */
export interface PreparedGeometry {
  mesh: SimplifyInput;
  remap: Int32Array;
}
export function prepareGeometry(g: SimplifyInput): PreparedGeometry {
  const remap = new Int32Array(g.positions.length / 3).fill(-1), used: number[] = [];
  // First compact only referenced vertices, in first-index order. This also
  // preserves the old deterministic output order and excludes foreign accessors.
  for (let i = 0; i < g.index.length; i++) {
    const v = g.index[i];
    if (remap[v] < 0) { remap[v] = used.length; used.push(v); }
  }
  const compact = take(g, used, g.index);
  const arrays = [compact.positions, compact.normals, compact.uvs].filter((a): a is Float32Array => !!a);
  const bits = arrays.map(a => new Uint32Array(a.buffer, a.byteOffset, a.length));
  const components = arrays.map(a => a.length / used.length);
  let capacity = 1;
  while (capacity < used.length * 2) capacity *= 2;
  const table = new Int32Array(capacity).fill(-1), ids = new Int32Array(used.length), first: number[] = [];
  const same = (a: number, b: number) => {
    for (let k = 0; k < bits.length; k++)
      for (let c = 0; c < components[k]; c++)
        if (bits[k][a * components[k] + c] !== bits[k][b * components[k] + c]) return false;
    return true;
  };
  for (let v = 0; v < used.length; v++) {
    let hash = 2166136261;
    for (let k = 0; k < bits.length; k++)
      for (let c = 0; c < components[k]; c++) hash = Math.imul(hash ^ bits[k][v * components[k] + c], 16777619);
    // Fold high float bits into the table mask too: integer/dyadic grids have
    // zero low mantissa bits and otherwise form quadratic linear-probe chains.
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    let slot = (hash >>> 0) & (capacity - 1);
    while (table[slot] >= 0 && !same(table[slot], v)) slot = (slot + 1) & (capacity - 1);
    if (table[slot] < 0) {
      table[slot] = v; ids[v] = first.length; first.push(used[v]);
    } else {
      ids[v] = ids[table[slot]];
    }
    remap[used[v]] = ids[v];
  }
  return { mesh: take(g, first, g.index.map(v => remap[v])), remap };
}
async function probe(g: SimplifyInput, o: SimplifyOptions, lock: Uint8Array | null, bound: number) {
  const ms = await simplifier(), nw = o.normalWeight ?? 1;
  if (nw < 0 || !Number.isFinite(nw) || (o.ratio !== undefined && !(o.ratio >= 0 && o.ratio <= 1)))
    throw new Error('Invalid simplify options');
  return ms.simplifyWithAttributes(g.index, g.positions, 3, g.normals ?? new Float32Array(0), g.normals ? 3 : 0, g.normals ? [nw, nw, nw] : [], lock, Math.floor(g.index.length * (o.ratio ?? 0) / 3) * 3, bound, o.lockBorder ? ['ErrorAbsolute', 'LockBorder'] : ['ErrorAbsolute'])[0];
}
export async function classifyGeometry(input: SimplifyInput, errorMm: number): Promise<GeometryClass> {
  return classifyPreparedGeometry(prepareGeometry(input), errorMm);
}
/** Worker-internal path: reuse preparation without changing the standalone API. */
export async function classifyPreparedGeometry(prepared: PreparedGeometry, errorMm: number): Promise<GeometryClass> {
  const g = prepared.mesh;
  if (g.index.length / 3 < 500)
    return 'small';
  const index = await probe(g, { errorMm, lockBorder: true, normalWeight: 1 }, null, localErrorBound(errorMm, g.worldStretchMax));
  return index.length / g.index.length > .5 ? 'barely-reducible' : 'reducible';
}
export interface ContactProbe {
  points: Float64Array;
  /** Original distances, capped at 2 mm / stretch, computed once at detection. */
  originalDistances?: Float64Array;
  /** Optional local-to-world matrix for non-uniform users. Points then use world space. */
  world?: Matrix;
  stretch: number;
}
const bary4 = [[1 / 3, 1 / 3, 1 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6], [1 / 6, 1 / 6, 2 / 3]];
const bary7 = [...bary4, [.5, .5, 0], [0, .5, .5], [.5, 0, .5]];
function samples(g: SimplifyInput, bars: number[][], visit: (x: number, y: number, z: number) => boolean): boolean {
  const p = g.positions;
  for (let t = 0; t < g.index.length; t += 3) {
    const a = 3 * g.index[t], c = 3 * g.index[t + 1], d = 3 * g.index[t + 2];
    for (const b of bars) {
      if (!visit(b[0] * p[a] + b[1] * p[c] + b[2] * p[d],
        b[0] * p[a + 1] + b[1] * p[c + 1] + b[2] * p[d + 1],
        b[0] * p[a + 2] + b[1] * p[c + 2] + b[2] * p[d + 2]))
        return false;
    }
  }
  return true;
}
const transformedMeshes = new WeakMap<SimplifyInput, Map<string, SimplifyInput>>();
function transformed(g: SimplifyInput, m: Matrix): SimplifyInput {
  let cache = transformedMeshes.get(g);
  if (!cache) { cache = new Map(); transformedMeshes.set(g, cache); }
  const key = Array.from(m).join(',');
  const previous = cache.get(key);
  if (previous) return previous;
  const p = new Float32Array(g.positions.length);
  for (const v of referencedVertices(g)) {
    const i = v * 3;
    transform(m, g.positions[i], g.positions[i + 1], g.positions[i + 2], p, i);
  }
  const result = { ...g, positions: p };
  cache.set(key, result);
  return result;
}
const probeDistances = new WeakMap<ContactProbe, WeakMap<SimplifyInput, Float64Array>>();
/** Conservative world deviation (largest stretch), with deterministic 4/7 sampling. */
export function verifyGeometry(original: SimplifyInput, result: SimplifyInput, errorMm: number, probes: readonly ContactProbe[] = []): string | null {
  const before = cachedSurface(original), after = cachedSurface(result);
  const bound = localErrorBound(errorMm, original.worldStretchMax);
  const minT = .9 * bound;
  const within = (s: ReturnType<typeof surface>, x: number, y: number, z: number) =>
    s.withinLast(x, y, z, minT) || s(x, y, z, minT, bound).distance <= bound;
  if (!samples(original, bary4, (x, y, z) => within(after, x, y, z)) || !samples(result, bary7, (x, y, z) => within(before, x, y, z)))
    return 'deviation';
  for (const pr of probes) {
    const a = pr.world ? transformed(original, pr.world) : original, b = pr.world ? transformed(result, pr.world) : result;
    const sa = cachedSurface(a), sb = cachedSurface(b), cap = .002 / pr.stretch;
    let distances = pr.originalDistances;
    if (!distances) {
      let cache = probeDistances.get(pr);
      if (!cache) { cache = new WeakMap(); probeDistances.set(pr, cache); }
      distances = cache.get(original);
      if (!distances) {
        distances = new Float64Array(pr.points.length / 3);
        for (let i = 0; i < pr.points.length; i += 3)
          distances[i / 3] = Math.min(sa(pr.points[i], pr.points[i + 1], pr.points[i + 2], 0, cap).distance, cap);
        cache.set(original, distances);
      }
    }
    for (let i = 0; i < pr.points.length; i += 3) {
      const p = pr.points;
      if (Math.abs(distances[i / 3] - Math.min(sb(p[i], p[i + 1], p[i + 2], 0, cap).distance, cap)) > .000009 / pr.stretch)
        return 'contact';
    }
  }
  return null;
}
export async function simplifyGeometry(input: SimplifyInput, options: SimplifyOptions, descriptor: EligibilityDescriptor = { materialCount: 1 }, locks?: Uint8Array, probes: readonly ContactProbe[] = []): Promise<GeometryResult> {
  const skip = eligibility(descriptor);
  if (skip)
    return { status: 'skipped', reason: skip, classification: null, mesh: input, attempts: 0 };
  const prepared = prepareGeometry(input);
  return simplifyPreparedGeometry(input, options, prepared, await classifyPreparedGeometry(prepared, options.errorMm), locks, probes);
}
/** Cached worker path; locks still use original accessor ids. */
export async function simplifyPreparedGeometry(input: SimplifyInput, options: SimplifyOptions, prepared: PreparedGeometry,
  classification: GeometryClass, locks?: Uint8Array, probes: readonly ContactProbe[] = []): Promise<GeometryResult> {
  const { mesh: g, remap } = prepared;
  const lock = locks ? new Uint8Array(g.positions.length / 3) : null;
  if (lock && locks)
    for (let v = 0; v < remap.length; v++)
      if (remap[v] >= 0 && locks[v])
        lock[remap[v]] = 1;
  let bound = localErrorBound(options.errorMm, g.worldStretchMax), reason = 'not-reduced';
  for (let attempts = 1; attempts <= 5; attempts++, bound /= 2) {
    const index = await probe(g, options, lock, bound), candidate = { ...g, index };
    if (index.length >= g.index.length)
      return { status: 'kept', reason: 'not-reduced', classification, mesh: input, attempts };
    reason = verifyGeometry(g, candidate, options.errorMm, probes) ?? '';
    if (!reason) {
      const ms = await simplifier(), out = index.slice(), [map, unique] = ms.compactMesh(out), first = new Array<number>(unique);
      for (let v = 0; v < map.length; v++)
        if (map[v] < unique)
          first[map[v]] = v;
      return { status: 'simplified', reason: 'verified', classification, mesh: take(g, first, out), attempts };
    }
  }
  return { status: 'kept', reason, classification, mesh: input, attempts: 5 };
}
export interface GeometryJob {
  geometryId: string;
  input: SimplifyInput;
  descriptor?: EligibilityDescriptor;
  locks?: Uint8Array;
  probes?: ContactProbe[];
}
/** One job per interned geometry. Repeated ids must refer to the same job data. */
export async function simplifyGeometries(jobs: readonly GeometryJob[], options: SimplifyOptions): Promise<Map<string, GeometryResult>> {
  const results = new Map<string, GeometryResult>();
  for (const j of jobs)
    if (!results.has(j.geometryId))
      results.set(j.geometryId, await simplifyGeometry(j.input, options, j.descriptor, j.locks, j.probes));
  return results;
}
export interface GeometryInstance {
  geometryId: string;
  mesh: SimplifyInput;
  world: Matrix;
}
export interface ContactTask {
  p: GeometryInstance;
  q: GeometryInstance;
  relTransform: Matrix;
  stretchQ: number;
  worldSpace: boolean;
}
export interface ContactResult {
  pLocks: Uint32Array;
  qLocks: Uint32Array;
  probe: ContactProbe;
}
function inverse(m: Matrix): Float64Array {
  const a = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => c < 4 ? m[c * 4 + r] : +(c - 4 === r)));
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[pivot][c]))
        pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const d = a[c][c];
    if (!d)
      throw new Error('Singular world matrix');
    for (let j = 0; j < 8; j++)
      a[c][j] /= d;
    for (let r = 0; r < 4; r++)
      if (r !== c) {
        const f = a[r][c];
        for (let j = 0; j < 8; j++)
          a[r][j] -= f * a[c][j];
      }
  }
  return Float64Array.from({ length: 16 }, (_, i) => a[i % 4][4 + Math.floor(i / 4)]);
}
function multiply(a: Matrix, b: Matrix): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
function uniform(m: Matrix): boolean {
  const s = worldStretchMax(m);
  if (!s)
    return false;
  for (let i = 0; i < 3; i++)
    for (let j = i; j < 3; j++) {
      let d = 0;
      for (let k = 0; k < 3; k++)
        d += m[i * 4 + k] * m[j * 4 + k];
      if (Math.abs(d - (i === j ? s * s : 0)) > s * s * 1e-8)
        return false;
    }
  return true;
}
/** Sweep world AABBs, then dedupe directed geometry/relative-transform tasks. */
export function planContactTasks(instances: readonly GeometryInstance[]): ContactTask[] {
  const list = instances.map(instance => {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const local = localBox(instance.mesh), p = new Float64Array(3);
    for (let corner = 0; local[0] !== Infinity && corner < 8; corner++) {
      transform(instance.world, local[corner & 1 ? 3 : 0], local[corner & 2 ? 4 : 1], local[corner & 4 ? 5 : 2], p);
      for (let k = 0; k < 3; k++) {
        box[k] = Math.min(box[k], p[k]);
        box[k + 3] = Math.max(box[k + 3], p[k]);
      }
    }
    return { instance, box, inverse: inverse(instance.world), stretch: worldStretchMax(instance.world), uniform: uniform(instance.world) };
  }).sort((a, b) => a.box[0] - b.box[0]);
  const tasks = new Map<string, ContactTask>(), e = .00005;
  const keyMatrix = (m: Matrix) => Array.from({ length: 16 }, (_, k) => Math.round(m[k] * (k >= 12 ? 1e8 : 1e7)));
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length && list[j].box[0] <= list[i].box[3] + e; j++) {
      const a = list[i], b = list[j];
      if ([0, 1, 2].some(k => a.box[k] > b.box[k + 3] + e || b.box[k] > a.box[k + 3] + e))
        continue;
      for (const [from, to] of [[a, b], [b, a]]) {
        const p = from.instance, q = to.instance;
        const relTransform = multiply(to.inverse, p.world), stretchQ = to.stretch, worldSpace = !from.uniform || !to.uniform;
        const key = JSON.stringify([p.geometryId, q.geometryId, keyMatrix(relTransform), Math.round(stretchQ * 1e7), worldSpace ? [keyMatrix(p.world), keyMatrix(q.world)] : null]);
        if (!tasks.has(key))
          tasks.set(key, { p, q, relTransform, stretchQ, worldSpace });
      }
    }
  return [...tasks.values()];
}
// Identity-keyed cache: inputs must remain immutable during a kernel run. Weak keys
// allow the worker to release geometries without a global teardown protocol.
const surfaces = new WeakMap<SimplifyInput, ReturnType<typeof surface>>();
const vertices = new WeakMap<SimplifyInput, Uint32Array>();
const vertexOffsets = new WeakMap<SimplifyInput, Int32Array>();
const boxes = new WeakMap<SimplifyInput, Float64Array>();
function referencedVertices(mesh: SimplifyInput): Uint32Array {
  let used = vertices.get(mesh);
  if (!used) {
    const offsets = new Int32Array(mesh.positions.length / 3), ids: number[] = [];
    for (let i = 0; i < mesh.index.length; i++) {
      const v = mesh.index[i];
      if (!offsets[v]) { ids.push(v); offsets[v] = ids.length; }
    }
    used = Uint32Array.from(ids); vertices.set(mesh, used); vertexOffsets.set(mesh, offsets);
  }
  return used;
}
function localBox(mesh: SimplifyInput): Float64Array {
  let box = boxes.get(mesh);
  if (!box) {
    box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const v of referencedVertices(mesh)) for (let c = 0; c < 3; c++) {
      const value = mesh.positions[v * 3 + c];
      box[c] = Math.min(box[c], value); box[c + 3] = Math.max(box[c + 3], value);
    }
    boxes.set(mesh, box);
  }
  return box;
}
function cachedSurface(mesh: SimplifyInput): ReturnType<typeof surface> {
  let nearest = surfaces.get(mesh);
  if (!nearest) {
    nearest = surface(mesh.positions, mesh.index);
    surfaces.set(mesh, nearest);
  }
  return nearest;
}
export function detectContacts(task: ContactTask): ContactResult {
  const { p, q } = task, target = task.worldSpace ? transformed(q.mesh, q.world) : q.mesh;
  const nearest = cachedSurface(target);
  const matrix = task.worldSpace ? p.world : task.relTransform, stretch = task.worldSpace ? 1 : task.stretchQ;
  const E = .00005 / stretch, DMAX = .005 / stretch, box = localBox(target);
  const pLocks: number[] = [], qLocks = new Set<number>(), points: number[] = [], distances: number[] = [];
  const used = referencedVertices(p.mesh), offsets = vertexOffsets.get(p.mesh)!;
  // Shared accessors can contain huge foreign vertex ranges. Allocate per-task
  // scratch only for this primitive's referenced vertices, retaining original ids.
  const coords = new Float64Array(used.length * 3), touching = new Uint8Array(used.length);
  // Face ids address the BVH's reordered COPY, never the caller's index.
  const record = (x: number, y: number, z: number, distance: number, face: number) => {
    const f = face * 3;
    qLocks.add(nearest.index[f]); qLocks.add(nearest.index[f + 1]); qLocks.add(nearest.index[f + 2]);
    points.push(x, y, z); distances.push(distance);
  };
  let rx = 0, ry = 0, rz = 0, lower = -1;
  for (let k = 0; k < used.length; k++) {
    const v = used[k], i = 3 * v, j = 3 * k, pp = p.mesh.positions;
    transform(matrix, pp[i], pp[i + 1], pp[i + 2], coords, j);
    const x = coords[j], y = coords[j + 1], z = coords[j + 2];
    if (x < box[0] - E || x > box[3] + E || y < box[1] - E || y > box[4] + E || z < box[2] - E || z > box[5] + E) continue;
    if (lower > E) {
      const dx = x - rx, dy = y - ry, dz = z - rz;
      if (lower - Math.sqrt(dx * dx + dy * dy + dz * dz) > E) continue;
    }
    const hit = nearest(x, y, z, 0, DMAX);
    // A hit beyond maxThreshold need not be nearest. Only its capped distance
    // is a valid Lipschitz lower bound for rejecting a later point.
    rx = x; ry = y; rz = z; lower = Math.min(hit.distance, DMAX);
    if (hit.distance <= E) {
      pLocks.push(v); touching[k] = 1;
      record(x, y, z, hit.distance, hit.face);
    }
  }
  if (pLocks.length) for (let t = 0; t < p.mesh.index.length; t += 3) {
    const a = offsets[p.mesh.index[t]] - 1, b = offsets[p.mesh.index[t + 1]] - 1, c = offsets[p.mesh.index[t + 2]] - 1;
    if (!(touching[a] && touching[b] && touching[c])) continue;
    const x = (coords[3 * a] + coords[3 * b] + coords[3 * c]) / 3;
    const y = (coords[3 * a + 1] + coords[3 * b + 1] + coords[3 * c + 1]) / 3;
    const z = (coords[3 * a + 2] + coords[3 * b + 2] + coords[3 * c + 2]) / 3;
    const hit = nearest(x, y, z, 0, E);
    if (hit.distance <= E) record(x, y, z, hit.distance, hit.face);
  }
  return { pLocks: Uint32Array.from(pLocks), qLocks: Uint32Array.from(qLocks), probe: {
    points: Float64Array.from(points), originalDistances: Float64Array.from(distances), stretch, world: task.worldSpace ? q.world : undefined,
  } };
}
