// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-roller-spin — the animated roller mantle (plan-675 Phase 3).
 *
 * Rollers of a conveyor turn visibly with the conveying speed WITHOUT a Drive
 * per roller and WITHOUT extra draw calls: the rollers stay in their chunk, and
 * the maps of the chunk's mantle material scroll along U (UVs: u = revolutions
 * around the roller axis, `editor.generateUVs` cylindrical). Architecture from
 * spike S1 and the SOL round-2 decisions:
 *
 * PRE-BAKE ({@link prepareRollerSpin}, run by the `TransportSurface` pre-bake
 * hook on the raw tree, before `dedup → uber → bake`):
 *  - every mesh whose material carries the spin marker
 *    (`userData.rvMaterialPreset.spin === 'roller'`) is measured: axis, centre
 *    and mantle radius ρ (PCA of its vertices), the direction its U grows;
 *  - its U is canonicalised (negated where needed) so U grows in the physical
 *    turning direction for a POSITIVE conveyor speed — one offset can then
 *    drive every roller of a group;
 *  - rollers are grouped by transmission ratio k (radial: r_mid/ρ, linear:
 *    1/ρ; 5 % tolerance). Every group gets its own material (`rvSpinGroup`) —
 *    the dedup fingerprint keeps groups apart, so one group = one chunk;
 *  - the per-group figures are written as plain data onto the node of the ONE
 *    TransportSurface of the asset (`userData.rvRollerSpin`) — a component node
 *    that survives the bake and is cloned with every instance. Nothing of this
 *    is stored in the GLB.
 *
 * RUNTIME ({@link bindRollerSpin} / {@link installRollerSpin}): per placement
 * (`layout-content-added`) and for the main model (`model-loaded`), the chunk
 * and keep meshes wearing a spin material get a placement-owned material clone
 * with cloned maps (shared image), bound to the placement's TransportSurface;
 * the surface ticks it with its texture animation. Released with the instance
 * (`BakeRegistry.onRelease`): the template material is restored, the clones are
 * disposed. Phase φ (revolutions) and texture offset are separate:
 * `offset.x = frac(−φ · repeatU)` on every animated map.
 *
 * Problems: `roller-spin-unbound` (no / several TransportSurface, or a mantle
 * without UVs), `roller-spin-mixed` (rollers of one material turn at different
 * ratios → one material per group, +1 draw call each), `roller-spin-under-surface`
 * (spin rollers under the surface node: the belt scroll owns them).
 */

import { Matrix4, Vector3 } from 'three';
import type { BufferGeometry, Material, Mesh, Object3D, Texture } from 'three';
import { analyzeShapePoints } from '../editor/rv-shape-analysis';
import { cloneMaterialWithScrollableMaps } from './rv-texture-scroll';
import { reportProblem, clearProblem } from '../hmi/problems-store';

// ─── Markers and data ──────────────────────────────────────────────────

/** Surface-node userData key of the pre-bake roller figures. */
export const RV_ROLLER_SPIN_KEY = 'rvRollerSpin';
/** Material userData key of a roller speed group. */
export const RV_SPIN_GROUP_KEY = 'rvSpinGroup';
/** Ratio tolerance inside one group (SOL R2-1). */
export const SPIN_GROUP_TOLERANCE = 0.05;

/** One speed group: rollers of one material turning at one ratio. */
export interface RollerSpinGroup {
  group: number;
  /** Mean mantle radius in mm. */
  rhoMm: number;
  /** Radial surfaces: mean distance roller centre → rotation axis in mm; 0 linear. */
  rMidMm: number;
  /** Transmission ratio: radial r_mid/ρ, linear 1/ρ (1/mm). */
  k: number;
  /** Rollers in the group. */
  count: number;
}

/** What the pre-bake hook leaves on the surface node. */
export interface RollerSpinData {
  radial: boolean;
  groups: RollerSpinGroup[];
  /** One material had rollers with ratios more than 5 % apart. */
  mixed: boolean;
  /** Spin rollers below the surface node (left to the belt scroll). */
  underSurface: number;
  /** Spin meshes that could not be measured (no UVs / degenerate). */
  unmeasured: number;
}

/** True for a material carrying the animated-mantle marker. */
export function isSpinMaterial(m: Material | null | undefined): boolean {
  const preset = (m?.userData as Record<string, unknown> | undefined)?.['rvMaterialPreset'] as { spin?: string } | undefined;
  return preset?.spin === 'roller';
}

// ─── Pre-bake: measure, canonicalise, group ────────────────────────────

const _m = new Matrix4();
const _v = new Vector3();
const UP = new Vector3(0, 1, 0);
const SAMPLE_CAP = 4000;

interface RollerMeasure { centre: Vector3; axis: Vector3; rhoMm: number; flip: boolean }

/**
 * Axis, centre and radius of one roller in the metric frame `toFrame`, and
 * whether its U must be negated so it grows with the physical turning sense
 * `aPhys` (right-handed). `null` without UVs or for degenerate geometry.
 */
function measureRoller(mesh: Mesh, toFrame: Matrix4, physAxisOf: (centre: Vector3) => Vector3 | null): RollerMeasure | null {
  const g = mesh.geometry as BufferGeometry;
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  if (!pos || !uv || pos.count < 8) return null;
  _m.multiplyMatrices(toFrame, mesh.matrixWorld);
  const stride = Math.max(1, Math.ceil(pos.count / SAMPLE_CAP));
  const pts: number[] = [];
  for (let i = 0; i < pos.count; i += stride) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
    pts.push(_v.x, _v.y, _v.z);
  }
  const shape = analyzeShapePoints(pts);
  const fa = shape.functionalAxis ?? shape.axes[0];
  const axis = new Vector3(fa[0], fa[1], fa[2]).normalize();
  // Exact centroid (the descriptor's is rounded to mm).
  const centre = new Vector3();
  const n = pts.length / 3;
  for (let i = 0; i < n; i++) centre.x += pts[i * 3], centre.y += pts[i * 3 + 1], centre.z += pts[i * 3 + 2];
  centre.multiplyScalar(1 / n);
  let rSum = 0;
  const d = new Vector3();
  for (let i = 0; i < n; i++) {
    d.set(pts[i * 3] - centre.x, pts[i * 3 + 1] - centre.y, pts[i * 3 + 2] - centre.z);
    d.addScaledVector(axis, -d.dot(axis));
    rSum += d.length();
  }
  const rho = rSum / n;
  if (!(rho > 1e-6)) return null;

  // Turning sense of growing U: dP/du on sampled triangles, r × t against the axis.
  const index = g.getIndex();
  const triCount = Math.floor((index ? index.count : pos.count) / 3);
  const step = Math.max(1, Math.floor(triCount / 96));
  const p0 = new Vector3(), p1 = new Vector3(), p2 = new Vector3();
  const e1 = new Vector3(), e2 = new Vector3(), t = new Vector3(), r = new Vector3();
  let vote = 0;
  for (let tri = 0; tri < triCount; tri += step) {
    const i0 = index ? index.getX(tri * 3) : tri * 3;
    const i1 = index ? index.getX(tri * 3 + 1) : tri * 3 + 1;
    const i2 = index ? index.getX(tri * 3 + 2) : tri * 3 + 2;
    const u0 = uv.getX(i0), u1 = uv.getX(i1), u2 = uv.getX(i2);
    const v0 = uv.getY(i0), v1 = uv.getY(i1), v2 = uv.getY(i2);
    const du1 = u1 - u0, du2 = u2 - u0, dv1 = v1 - v0, dv2 = v2 - v0;
    if (Math.abs(du1) > 0.5 || Math.abs(du2) > 0.5) continue; // seam
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    p0.fromBufferAttribute(pos, i0).applyMatrix4(_m);
    p1.fromBufferAttribute(pos, i1).applyMatrix4(_m);
    p2.fromBufferAttribute(pos, i2).applyMatrix4(_m);
    e1.subVectors(p1, p0);
    e2.subVectors(p2, p0);
    t.copy(e1).multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(1 / det); // dP/du
    r.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3).sub(centre);
    r.addScaledVector(axis, -r.dot(axis));
    vote += Math.sign(axis.dot(r.cross(t)));
  }
  if (vote === 0) return null;
  // U grows right-handed about `uAxis`.
  const uAxis = axis.clone().multiplyScalar(Math.sign(vote));
  const phys = physAxisOf(centre);
  if (!phys) return null;
  return { centre, axis: uAxis, rhoMm: rho * 1000, flip: uAxis.dot(phys) < 0 };
}

/** The node carries a TransportSurface (or a `TransportSurface_N`) block. */
function surfaceExtrasOf(node: Object3D): Record<string, unknown> | null {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const key of Object.keys(rv)) {
    if (key === 'TransportSurface' || /^TransportSurface_\d+$/.test(key)) {
      const data = rv[key] as Record<string, unknown> | undefined;
      if (data && data['_enabled'] !== false) return data;
    }
  }
  return null;
}

function isUnder(node: Object3D, ancestor: Object3D): boolean {
  for (let c: Object3D | null = node; c; c = c.parent) if (c === ancestor) return true;
  return false;
}

/**
 * The pre-bake step (see module doc). Runs on the raw tree `root` for the
 * surface node `surfaceNode`; writes `userData.rvRollerSpin` onto it and
 * returns the data, or `null` when the asset has no spin mantle or not exactly
 * one TransportSurface (the runtime reports that as `roller-spin-unbound`).
 * Runs once per bake (the hook dispatcher calls it once per surface node).
 */
export function prepareRollerSpin(root: Object3D, surfaceNode: Object3D, surfaceExtras: Record<string, unknown>): RollerSpinData | null {
  const spinMeshes: Mesh[] = [];
  const surfaces: Object3D[] = [];
  root.traverse((node) => {
    if (surfaceExtrasOf(node)) surfaces.push(node);
    const mesh = node as Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && isSpinMaterial(mesh.material as Material)) spinMeshes.push(mesh);
  });
  // Never trust figures that arrived with the file (a runtime tree exported as
  // GLB would carry them as extras): they are recomputed on every bake.
  delete surfaceNode.userData[RV_ROLLER_SPIN_KEY];
  if (spinMeshes.length === 0 || surfaces.length !== 1 || surfaces[0] !== surfaceNode) return null;

  root.updateMatrixWorld(true);
  // Metric frame: the parent frame of `root` (the GLB scene frame — Y up, metres).
  const toFrame = new Matrix4();
  if (root.parent) toFrame.copy(root.parent.matrixWorld).invert();
  const sm = new Matrix4().multiplyMatrices(toFrame, surfaceNode.matrixWorld);
  const pivot = new Vector3().setFromMatrixPosition(sm);
  const raw = surfaceExtras['TransportDirection'] as { x?: number; y?: number; z?: number } | undefined;
  // Unity coordinates (negate X), like the component schema.
  const localDir = raw ? new Vector3(-(raw.x ?? 0), raw.y ?? 0, raw.z ?? 0) : new Vector3(1, 0, 0);
  if (localDir.lengthSq() === 0) localDir.set(1, 0, 0);
  const axisW = localDir.transformDirection(sm); // normalised
  const radial = surfaceExtras['Radial'] === true;

  const rMidOf = (c: Vector3): number => {
    _v.copy(c).sub(pivot);
    _v.addScaledVector(axisW, -_v.dot(axisW));
    return _v.length() * 1000;
  };
  // Physical turning axis for a POSITIVE speed: the top of the roller moves with
  // the goods (direction d), v_top = ω a × up  →  a = up × d.
  const physAxisOf = (c: Vector3): Vector3 | null => {
    let d: Vector3;
    if (radial) {
      const rv = new Vector3().subVectors(c, pivot);
      rv.addScaledVector(axisW, -rv.dot(axisW));
      if (rv.lengthSq() < 1e-12) return null;
      d = new Vector3().crossVectors(axisW, rv).normalize(); // MU velocity: ω A × (p − c)
    } else {
      d = axisW.clone();
    }
    const a = new Vector3().crossVectors(UP, d);
    return a.lengthSq() < 1e-12 ? null : a.normalize();
  };

  let underSurface = 0;
  let unmeasured = 0;
  interface Entry { mesh: Mesh; m: RollerMeasure; k: number; rMidMm: number; base: Material }
  const entries: Entry[] = [];
  for (const mesh of spinMeshes) {
    if (isUnder(mesh, surfaceNode)) { underSurface++; continue; }
    const m = measureRoller(mesh, toFrame, physAxisOf);
    if (!m) { unmeasured++; continue; }
    const rMidMm = radial ? rMidOf(m.centre) : 0;
    const k = radial ? rMidMm / m.rhoMm : 1 / m.rhoMm;
    entries.push({ mesh, m, k, rMidMm, base: mesh.material as Material });
  }

  // ── canonicalise U (negate) — a geometry shared with a mesh that keeps its
  // sense is cloned first.
  const users = new Map<BufferGeometry, Mesh[]>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry as BufferGeometry;
    const list = users.get(g);
    if (list) list.push(mesh); else users.set(g, [mesh]);
  });
  const flipped = new Set<BufferGeometry>();
  for (const e of entries) {
    if (!e.m.flip) continue;
    let g = e.mesh.geometry as BufferGeometry;
    const all = users.get(g) ?? [];
    const allFlip = all.every((u) => entries.some((x) => x.mesh === u && x.m.flip));
    if (!allFlip) { g = g.clone(); e.mesh.geometry = g; }
    if (flipped.has(g)) continue;
    flipped.add(g);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, -uv.getX(i));
    uv.needsUpdate = true;
  }

  // ── group by (material, ratio).
  let nextGroup = 0;
  const groups: RollerSpinGroup[] = [];
  const sums = new Map<number, { rho: number; rMid: number; k: number; n: number }>();
  const groupsOfBase = new Map<Material, Array<{ group: number; k: number; material: Material }>>();
  let mixed = false;
  for (const e of entries) {
    let list = groupsOfBase.get(e.base);
    if (!list) { list = []; groupsOfBase.set(e.base, list); }
    let hit = list.find((x) => Math.abs(e.k - x.k) / x.k <= SPIN_GROUP_TOLERANCE);
    if (!hit) {
      const material = list.length === 0 ? e.base : e.base.clone();
      if (list.length > 0) mixed = true;
      hit = { group: nextGroup++, k: e.k, material };
      material.userData[RV_SPIN_GROUP_KEY] = hit.group;
      list.push(hit);
    }
    if (hit.material !== e.mesh.material) e.mesh.material = hit.material;
    const s = sums.get(hit.group) ?? { rho: 0, rMid: 0, k: 0, n: 0 };
    s.rho += e.m.rhoMm; s.rMid += e.rMidMm; s.k += e.k; s.n++;
    sums.set(hit.group, s);
  }
  for (const [group, s] of sums) {
    groups.push({ group, rhoMm: s.rho / s.n, rMidMm: s.rMid / s.n, k: s.k / s.n, count: s.n });
  }
  groups.sort((a, b) => a.group - b.group);
  const data: RollerSpinData = { radial, groups, mixed, underSurface, unmeasured };
  surfaceNode.userData[RV_ROLLER_SPIN_KEY] = data;
  return data;
}

// ─── Runtime: per-placement binding ────────────────────────────────────

/** What the binding reads from the TransportSurface each tick (an `RVTransportSurface` satisfies it). */
export interface SpinSurface {
  readonly speed: number;
  readonly Radial: boolean;
  rollerSpin?: RollerSpinBinding | null;
}

interface SpinEntry {
  maps: Texture[];
  rhoMm: number;
  rMidMm: number;
  repeatU: number;
  /** Revolutions turned (wrapped to [0,1) when repeatU is an integer). */
  phase: number;
  wrap: boolean;
}

/** A placement's animated mantles, ticked by its TransportSurface. */
export class RollerSpinBinding {
  /** The materials this binding created (one per spin group / source material). */
  readonly materials: Material[] = [];
  /** Every cloned map (shared images). */
  readonly maps: Texture[] = [];
  /** Meshes whose material was swapped, with the material they wore. */
  private readonly _swapped: Array<{ mesh: Mesh; original: Material }> = [];
  private readonly _entries: SpinEntry[] = [];
  private _disposed = false;

  constructor(readonly surface: SpinSurface, readonly root: Object3D) {}

  /** @internal */ _add(entry: SpinEntry, material: Material): void {
    this._entries.push(entry);
    this.materials.push(material);
    for (const t of entry.maps) this.maps.push(t);
  }
  /** @internal */ _swap(mesh: Mesh, original: Material, material: Material): void {
    this._swapped.push({ mesh, original });
    mesh.material = material;
  }

  /** Meshes driven by this binding. */
  get meshes(): Mesh[] { return this._swapped.map((s) => s.mesh); }

  /**
   * Advance by `dt` seconds at the surface's current speed (mm/s linear, °/s
   * radial). Allocation-free; a standing surface leaves the offsets alone.
   */
  tick(dt: number): void {
    const speed = this.surface.speed;
    if (speed === 0 || dt === 0) return;
    const radial = this.surface.Radial;
    for (let i = 0; i < this._entries.length; i++) {
      const e = this._entries[i];
      // ω_roll [rad/s]: radial ω_s·r_mid/ρ, linear v/ρ.
      const omega = radial ? (speed * Math.PI / 180) * e.rMidMm / e.rhoMm : speed / e.rhoMm;
      let phase = e.phase + (omega * dt) / (2 * Math.PI);
      if (e.wrap) phase -= Math.floor(phase);
      e.phase = phase;
      // U grows with the turning sense; a turned pattern samples at u − φ.
      let x = -phase * e.repeatU;
      x -= Math.floor(x);
      const maps = e.maps;
      for (let j = 0; j < maps.length; j++) maps[j].offset.x = x;
    }
  }

  /** Back to the authored look (sim reset). */
  reset(): void {
    for (const e of this._entries) {
      e.phase = 0;
      for (const t of e.maps) t.offset.x = 0;
    }
  }

  /** Revolutions turned by the first group (tests / diagnostics). */
  get phase(): number { return this._entries[0]?.phase ?? 0; }

  /** Restore the template material on the meshes and dispose every clone. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const { mesh, original } of this._swapped) {
      if (this.materials.includes(mesh.material as Material)) mesh.material = original;
    }
    for (const t of this.maps) t.dispose();
    for (const m of this.materials) m.dispose();
    this._swapped.length = 0;
    this._entries.length = 0;
    if (this.surface.rollerSpin === this) this.surface.rollerSpin = null;
  }
}

/** Find the surface node (with the pre-bake figures) of a placement root. */
function spinSurfaceNodesUnder(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((n) => { if (n.userData?.[RV_ROLLER_SPIN_KEY]) out.push(n); });
  return out;
}

/** A mesh's own material, also while toon mode wears a stand-in. */
function sourceMaterialOf(mesh: Mesh): Material | null {
  const toonOriginal = mesh.userData?._rvToonOriginal as Material | Material[] | undefined;
  const m = (toonOriginal ?? mesh.material) as Material | Material[];
  return Array.isArray(m) ? null : m;
}

export interface BindRollerSpinOptions {
  /** The TransportSurface instance of a node (registry / transport manager). */
  surfaceOf(node: Object3D): SpinSurface | null;
  /** Path for Problems entries. */
  pathOf?(node: Object3D): string;
  /** Re-apply the active render mode (toon) after a material swap. */
  reapplyRenderMode?(root: Object3D): void;
  /** Report Problems (default true). */
  problems?: boolean;
}

/**
 * Bind the spin mantles of ONE placement instance (`root` with its chunk and
 * keep meshes). Returns null when nothing animates; Problems entries name why.
 */
export function bindRollerSpin(root: Object3D, meshes: readonly Mesh[], opts: BindRollerSpinOptions): RollerSpinBinding | null {
  const spin = meshes.filter((m) => isSpinMaterial(sourceMaterialOf(m)));
  const path = opts.pathOf?.(root) ?? root.name;
  const report = opts.problems !== false;
  const ids = {
    unbound: `roller-spin-unbound:${path}`,
    mixed: `roller-spin-mixed:${path}`,
    under: `roller-spin-under-surface:${path}`,
  };
  if (report) { clearProblem(ids.unbound); clearProblem(ids.mixed); clearProblem(ids.under); }
  if (spin.length === 0) return null;

  const nodes = spinSurfaceNodesUnder(root);
  const surface = nodes.length === 1 ? opts.surfaceOf(nodes[0]) : null;
  const data = nodes.length === 1 ? nodes[0].userData[RV_ROLLER_SPIN_KEY] as RollerSpinData : null;
  if (!surface || !data || data.groups.length === 0) {
    if (report) {
      reportProblem({
        id: ids.unbound, severity: 'warning', code: 'roller-spin-unbound', nodePath: path,
        title: 'Animated roller mantle without a conveyor',
        detail: !data
          ? `${spin.length} mesh(es) with "Roller mantle ↻" in ${path} found no single TransportSurface in the same part `
            + '(none, or several) — the rollers stand still. Give the part exactly one TransportSurface.'
          : `The rollers of ${path} could not be measured (no UVs or degenerate geometry) — run editor.generateUVs (cylindrical) on them.`,
      });
    }
    return null;
  }
  if (report && data.unmeasured > 0) {
    reportProblem({
      id: ids.unbound, severity: 'warning', code: 'roller-spin-unbound', nodePath: path,
      title: 'Some animated rollers stand still',
      detail: `${data.unmeasured} mantle mesh(es) in ${path} have no UVs or are degenerate — run editor.generateUVs (cylindrical) on them.`,
    });
  }
  if (report && data.mixed) {
    reportProblem({
      id: ids.mixed, severity: 'info', code: 'roller-spin-mixed', nodePath: path,
      title: 'Rollers turn at different speeds',
      detail: `The rollers of ${path} form ${data.groups.length} speed groups (ratios more than 5 % apart); `
        + 'each group is its own material — one extra draw call per group.',
    });
  }
  if (report && data.underSurface > 0) {
    reportProblem({
      id: ids.under, severity: 'warning', code: 'roller-spin-under-surface', nodePath: path,
      title: 'Animated rollers under the TransportSurface node',
      detail: `${data.underSurface} roller(s) in ${path} sit below the TransportSurface node — the belt scroll owns their texture `
        + 'and every one costs a draw call. Put the rollers beside the surface node.',
    });
  }

  const byGroup = new Map<number, RollerSpinGroup>(data.groups.map((g) => [g.group, g]));
  const binding = new RollerSpinBinding(surface, root);
  const cloneOf = new Map<Material, Material>();
  let undidToon = false;
  for (const mesh of spin) {
    const original = sourceMaterialOf(mesh)!;
    const group = byGroup.get((original.userData?.[RV_SPIN_GROUP_KEY] as number | undefined) ?? 0) ?? data.groups[0];
    let clone = cloneOf.get(original);
    if (!clone) {
      const { material, maps } = cloneMaterialWithScrollableMaps(original);
      material.userData = { ...material.userData, _rvSpinOwned: true };
      clone = material;
      cloneOf.set(original, clone);
      const repeatU = maps[0]?.repeat.x ?? 1;
      binding._add({
        maps, rhoMm: group.rhoMm, rMidMm: group.rMidMm, repeatU,
        phase: 0, wrap: Number.isInteger(repeatU),
      }, material);
    }
    if (mesh.userData?._rvToonOriginal !== undefined) {
      // Toon mode converted this mesh already: hand it back, swap, re-convert below.
      delete mesh.userData._rvToonOriginal;
      undidToon = true;
    }
    binding._swap(mesh, original, clone);
  }
  if (undidToon) opts.reapplyRenderMode?.(root);
  surface.rollerSpin?.dispose();
  surface.rollerSpin = binding;
  return binding;
}

// ─── Viewer wiring ──────────────────────────────────────────────────────

/** The narrow viewer surface {@link installRollerSpin} needs. */
export interface RollerSpinHost {
  on(event: 'layout-content-added', cb: (e: { root: Object3D }) => void): () => void;
  on(event: 'model-loaded' | 'placements-materialized', cb: () => void): () => void;
  readonly bakeRegistry?: {
    instanceOf(root: Object3D): { root: Object3D; chunks: Mesh[]; keep: Mesh[]; released: boolean } | null;
    readonly instances: ReadonlySet<{ root: Object3D; chunks: Mesh[]; keep: Mesh[]; released: boolean }>;
    onRelease(listener: (instance: { root: Object3D }) => void): () => void;
  } | null;
  readonly transportManager?: { surfaces: ReadonlyArray<SpinSurface & { node: Object3D }> } | null;
  readonly registry?: { getPathForNode(node: Object3D): string | null } | null;
  applyRenderModeToSubtree?(root: Object3D): void;
}

/**
 * Wire the roller spin into a viewer: bind every placement on
 * `layout-content-added`, the main model and any missed instance on
 * `model-loaded` / `placements-materialized`, release with the bake registry.
 * Returns the uninstaller.
 */
export function installRollerSpin(host: RollerSpinHost): () => void {
  const bindings = new Map<Object3D, RollerSpinBinding>();
  const subscribedTo = new WeakSet<object>();
  const offs: Array<() => void> = [];

  const ensureReleaseHook = (): void => {
    const reg = host.bakeRegistry;
    if (!reg || subscribedTo.has(reg)) return;
    subscribedTo.add(reg);
    offs.push(reg.onRelease((inst) => {
      const b = bindings.get(inst.root);
      if (!b) return;
      b.dispose();
      bindings.delete(inst.root);
    }));
  };

  const bindInstance = (inst: { root: Object3D; chunks: Mesh[]; keep: Mesh[]; released: boolean } | null): void => {
    if (!inst || inst.released || bindings.has(inst.root)) return;
    ensureReleaseHook();
    const b = bindRollerSpin(inst.root, [...inst.chunks, ...inst.keep], {
      surfaceOf: (node) => host.transportManager?.surfaces.find((s) => s.node === node) ?? null,
      pathOf: (node) => host.registry?.getPathForNode(node) ?? node.name,
      reapplyRenderMode: (root) => host.applyRenderModeToSubtree?.(root),
    });
    if (b) bindings.set(inst.root, b);
  };
  const sweep = (): void => {
    const reg = host.bakeRegistry;
    if (!reg) return;
    for (const inst of reg.instances) bindInstance(inst);
  };

  offs.push(host.on('layout-content-added', (e) => bindInstance(host.bakeRegistry?.instanceOf(e.root) ?? null)));
  offs.push(host.on('model-loaded', sweep));
  offs.push(host.on('placements-materialized', sweep));
  return () => {
    for (const off of offs) off();
    for (const b of bindings.values()) b.dispose();
    bindings.clear();
  };
}
