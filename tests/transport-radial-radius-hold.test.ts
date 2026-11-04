// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 D3 — an MU on a radial TransportSurface keeps its radius.
 *
 * Phase 0 measurement turned into a regression test.
 *
 *  1. The REAL Interroll RM 8320 curve (private Development project) loaded
 *     through `loadBakedGLB` (destructive bake, as production) four times and
 *     arranged exactly as the "Demo Kurvenkreis" document arranges its
 *     placements (placement matrices copied from the document, asset shifted
 *     to the floor centre of its bounds as the planner pivots it). One MU
 *     circles four laps with the real Drives ticking.
 *     Finding: the document's pivots are 2 mm apart per seam — the asset's snap
 *     ports sit 1 mm OUTSIDE the radial end planes — so the four quarter turns
 *     compose to a net translation per lap and the MU walks. Coinciding pivots
 *     hold the radius; library placements now ease the MU onto the mid radius.
 *  2. Synthetic frames: a clone MU below a rotated + translated parent — the
 *     radial step mixed PARENT-local MU positions with the WORLD pivot / axis.
 */
import { describe, it, expect } from 'vitest';
import { Box3, Group, Mesh, MeshBasicMaterial, Object3D, RingGeometry, Scene, Vector3 } from 'three';
import { type LoadResult } from '../src/core/engine/rv-scene-loader';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const CURVE_URL = '/private-assets/Development/library/Interroll/RM8320-Kurve-BF620-90.glb';
const HAS_CURVE = await devAssetAvailable(CURVE_URL);
const DT = 1 / 60;

/** The four placement matrices of "Demo Kurvenkreis.glb" (column-major, as stored). */
const PLACEMENTS: number[][] = [
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  [2.2204460492503126e-16, 0, -0.9999999999999998, 0, 0, 1, 0, 0, 0.9999999999999998, 0, 2.2204460492503126e-16, 0, -1.4361171188354498, 0, 1.6653345369377348e-16, 1],
  [-0.9999999999999993, 1.2246467991473535e-16, -6.661338147750935e-16, 0, 1.2246467991473532e-16, 1, 1.2246467991473542e-16, 0, 6.661338147750935e-16, 1.2246467991473525e-16, -0.9999999999999993, 0, -1.4361171188354502, 0, 1.4361171188354498, 1],
  [2.2204460492503099e-16, 0, 0.9999999999999986, 0, 0, 1, 0, 0, -0.9999999999999986, 0, 2.2204460492503099e-16, 0, -1.6653345369377348e-15, 0, 1.4361171188354513, 1],
];

/** Pivot (floor centre of the bounds) → arc centre distance of the RM 8320 asset along X and Z, metres. */
const ARC_FROM_PIVOT = 0.717059;

interface Placed { result: LoadResult; holder: Group; surface: RVTransportSurface }

async function placeCurve(bytes: ArrayBuffer, scene: Scene, matrix: number[], index: number, library: boolean): Promise<Placed> {
  // Planner frame: placement root (document matrix) → pivot group that shifts the
  // floor centre of the asset bounds to the placement origin → asset root.
  const result = await loadBakedGLB(`curve-${index}.glb`, scene, { data: bytes.slice(0), loadKinematicsSidecar: false });
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(result.root);
  const holder = new Group();
  holder.name = `Placement_${index}`;
  scene.add(holder);
  const pivot = new Group();
  pivot.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  holder.add(pivot);
  pivot.add(result.root);
  holder.matrix.fromArray(matrix);
  holder.matrix.decompose(holder.position, holder.quaternion, holder.scale);
  scene.updateMatrixWorld(true);
  const surface = result.transportManager.surfaces[0];
  // A library placement: the planner stamps the LayoutObject marker before the
  // components init, which is what `init()` resolves this flag from.
  if (library) (surface as unknown as { _belongsToLibraryObject: boolean })._belongsToLibraryObject = true;
  return { result, holder, surface };
}

function radius(p: Vector3, c: Vector3): number { return Math.hypot(p.x - c.x, p.z - c.z); }

interface RingTrace {
  pivotSpreadMm: number; laps: number; lapRadii: number[]; lapDriftMm: number; ownMidDevMm: number; ownerChanges: number; rMid: number;
}

/** Circle one MU `laps` times over four surfaces (they share one manager); radii around the mean pivot. */
function circle(surfaces: RVTransportSurface[], drives: Array<{ update(dt: number): void }>, scene: Scene, mu: RVMovingUnit, rMid: number, laps: number): RingTrace {
  const manager = new RVTransportManager();
  manager.scene = scene;
  manager.surfaces.push(...surfaces);
  manager.mus.push(mu);
  const pivots = surfaces.map((s) => s.node.getWorldPosition(new Vector3()));
  const centre = pivots.reduce((a, b) => a.add(b), new Vector3()).multiplyScalar(1 / pivots.length);
  const pivotSpreadMm = Math.max(...pivots.map((p) => radius(p, centre))) * 1000;
  const pos = new Vector3().copy(mu.getPosition());
  const lapRadii = [radius(pos, centre)];
  let ownMidDev = 0; let ownerChanges = 0; let lastOwner: unknown = null;
  let angle = 0; let last = Math.atan2(pos.z - centre.z, pos.x - centre.x);
  const pv = new Vector3();
  for (let ticks = 0; Math.abs(angle) < laps * 2 * Math.PI && ticks < 60 * 60 * 30; ticks++) {
    for (const d of drives) d.update(DT);
    manager.update(DT);
    pos.copy(mu.getPosition());
    const a = Math.atan2(pos.z - centre.z, pos.x - centre.x);
    let da = a - last; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    const before = Math.floor(Math.abs(angle) / (2 * Math.PI));
    angle += da; last = a;
    if (Math.floor(Math.abs(angle) / (2 * Math.PI)) > before) lapRadii.push(radius(pos, centre));
    const owner = mu.currentSurface;
    if (owner !== lastOwner) { ownerChanges++; lastOwner = owner; }
    // After the first lap: distance from the OWNING curve's own mid radius.
    if (Math.abs(angle) > 2 * Math.PI && owner) {
      owner.node.getWorldPosition(pv);
      ownMidDev = Math.max(ownMidDev, Math.abs(radius(pos, pv) - rMid));
    }
  }
  let lapDrift = 0;
  for (let i = 1; i < lapRadii.length; i++) lapDrift = Math.max(lapDrift, Math.abs(lapRadii[i] - lapRadii[i - 1]));
  return { pivotSpreadMm, laps: angle / (2 * Math.PI), lapRadii, lapDriftMm: lapDrift * 1000, ownMidDevMm: ownMidDev * 1000, ownerChanges, rMid };
}

async function runRing(matrices: number[][], library: boolean, laps = 4): Promise<RingTrace> {
  const bytes = await (await fetch(CURVE_URL)).arrayBuffer();
  const scene = new Scene();
  const placed: Placed[] = [];
  for (let i = 0; i < 4; i++) placed.push(await placeCurve(bytes, scene, matrices[i], i, library));
  expect(placed.every((p) => p.surface.Radial)).toBe(true);
  const sector = placed[0].surface.getRadialSector();
  expect(sector).not.toBeNull();
  const rMid = (sector!.rMin + sector!.rMax) / 2;
  // MU on the mid radius in the middle of curve 0 (it lies towards the placement origin), on the conveying plane.
  const top = new Box3().setFromObject(placed[0].result.root).max.y;
  const p0 = placed[0].surface.node.getWorldPosition(new Vector3());
  const toMid = new Vector3().sub(p0).setY(0).normalize();
  const node = new Object3D(); node.name = 'Carton';
  node.position.copy(p0).addScaledVector(toMid, rMid).setY(top - 0.03);
  scene.add(node);
  scene.updateMatrixWorld(true);
  const mu = new RVMovingUnit(node, 'probe', new Vector3(0.15, 0.1, 0.2));
  return circle(placed.map((p) => p.surface), placed.flatMap((p) => p.result.drives), scene, mu, rMid, laps);
}

/** The document ring with the seams closed: placements spaced 2 × ARC_FROM_PIVOT so the pivots coincide. */
function coincidentRing(): number[][] {
  const d = 2 * ARC_FROM_PIVOT;
  const out = PLACEMENTS.map((m) => m.slice());
  out[1][12] = -d; out[1][14] = 0;
  out[2][12] = -d; out[2][14] = d;
  out[3][12] = 0; out[3][14] = d;
  return out;
}

describe.skipIf(!HAS_CURVE)('plan-675 D3 — real RM 8320 curve keeps the MU radius', () => {
  it('Phase-0 measurement: the document ring has pivots 2 mm apart per seam (snap ports 1 mm outside the end planes)', async () => {
    const raw = await runRing(PLACEMENTS, false);
    console.log('[plan-675 D3] document ring, scene-authored (no centring)', JSON.stringify(raw));
    expect(raw.pivotSpreadMm).toBeGreaterThan(1);
    expect(Math.abs(raw.laps)).toBeGreaterThan(3.9);
  }, 240000);

  it('pivots coinciding: no drift per lap (< 1 mm) without any centring', async () => {
    const t = await runRing(coincidentRing(), false);
    console.log('[plan-675 D3] coincident ring', JSON.stringify(t));
    expect(t.pivotSpreadMm).toBeLessThan(0.05);
    expect(Math.abs(t.laps)).toBeGreaterThan(3.9);
    expect(t.lapDriftMm).toBeLessThan(1);
  }, 240000);

  it('the document ring as LIBRARY placements: the curves ease the MU onto their mid radius — drift < 1 mm per lap', async () => {
    const t = await runRing(PLACEMENTS, true);
    console.log('[plan-675 D3] document ring, library placements', JSON.stringify(t));
    expect(Math.abs(t.laps)).toBeGreaterThan(3.9);
    expect(t.lapDriftMm).toBeLessThan(1);
    expect(t.ownMidDevMm).toBeLessThan(3);
  }, 240000);
});

// ── Part 2: synthetic surfaces (no private asset needed) ─────────────────────

const R_IN = 0.82;
const R_OUT = 1.44;
const R_MID = (R_IN + R_OUT) / 2;
const TOP = 0.7;
const CENTER = new Vector3(-0.718, 0, 0.718);

/** Quarter curve `index` (0..3), rotated about the common centre; `pivotError` shifts its pivot (m). */
function quarter(index: number, speed: number, opts: { pivotError?: Vector3; library?: boolean } = {}): RVTransportSurface {
  const node = new Object3D();
  node.name = `Curve${index}`;
  node.position.copy(CENTER).setY(TOP);
  if (opts.pivotError) node.position.add(opts.pivotError);
  node.rotation.y = -index * Math.PI / 2;
  // The quarter-annulus belt mesh (canonical angle 0..−90° = +X towards +Z).
  const ring = new RingGeometry(R_IN, R_OUT, 24, 1, -Math.PI / 2, Math.PI / 2);
  ring.rotateX(-Math.PI / 2);
  node.add(new Mesh(ring, new MeshBasicMaterial()));
  node.updateMatrixWorld(true);
  const aabb = AABB.fromHalfSize(node, new Vector3(R_OUT / 2, 0.02, R_OUT / 2), new Vector3(R_OUT / 2, -0.02, R_OUT / 2));
  const s = new RVTransportSurface(node, aabb);
  s.TransportDirection.set(0, 1, 0);
  s.Radial = true;
  s.reapplyConfig();
  s.initTransport();
  if (opts.library) (s as unknown as { _belongsToLibraryObject: boolean })._belongsToLibraryObject = true;
  s.drive = { currentSpeed: speed, name: `drive${index}` } as never;
  return s;
}

function muAtWorld(parent: Object3D, world: Vector3): RVMovingUnit {
  const node = new Object3D(); node.name = 'Carton';
  parent.add(node);
  parent.updateMatrixWorld(true);
  node.position.copy(parent.worldToLocal(world.clone()));
  node.updateMatrixWorld(true);
  return new RVMovingUnit(node, 'probe', new Vector3(0.15, 0.1, 0.2));
}

describe('plan-675 D3 — radial step frames and centring (synthetic)', () => {
  it('a clone MU under a rotated + translated parent keeps its WORLD radius around the pivot', () => {
    const scene = new Scene();
    const parent = new Group();
    parent.position.set(0.0846, 0, -0.0846);
    parent.rotation.y = Math.PI / 4;
    scene.add(parent);
    const a = Math.PI / 4;
    const mu = muAtWorld(parent, new Vector3(CENTER.x + R_MID * Math.cos(a), TOP + 0.05, CENTER.z + R_MID * Math.sin(a)));
    const surfaces = [0, 1, 2, 3].map((i) => quarter(i, 25));
    const manager = new RVTransportManager();
    manager.scene = scene;
    manager.surfaces.push(...surfaces);
    manager.mus.push(mu);
    let minR = Infinity; let maxR = -Infinity;
    const w = new Vector3();
    const node = (mu as unknown as { node: Object3D }).node;
    // 25°/s → 14.4 s per lap; two laps.
    for (let i = 0; i < Math.round(28.8 / DT); i++) {
      manager.update(DT);
      node.updateMatrixWorld(true);
      node.getWorldPosition(w);
      const r = radius(w, CENTER);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    }
    expect((maxR - minR) * 1000).toBeLessThan(1);
  });

  it('the MU yaw follows the travelled angle about the WORLD axis (parent rotated)', () => {
    const scene = new Scene();
    const parent = new Group();
    parent.rotation.y = Math.PI / 3;
    scene.add(parent);
    const world = new Vector3(CENTER.x + R_MID * Math.cos(0.3), TOP + 0.05, CENTER.z + R_MID * Math.sin(0.3));
    const mu = muAtWorld(parent, world);
    const node = (mu as unknown as { node: Object3D }).node;
    const x0 = new Vector3(1, 0, 0).transformDirection(node.matrixWorld);
    const manager = new RVTransportManager();
    manager.scene = scene;
    manager.surfaces.push(quarter(0, 45));
    manager.mus.push(mu);
    for (let i = 0; i < 30; i++) manager.update(DT);
    node.updateMatrixWorld(true);
    const p = node.getWorldPosition(new Vector3());
    const dPos = Math.atan2(p.z - CENTER.z, p.x - CENTER.x) - Math.atan2(world.z - CENTER.z, world.x - CENTER.x);
    const x1 = new Vector3(1, 0, 0).transformDirection(node.matrixWorld);
    const dYaw = Math.atan2(x1.z, x1.x) - Math.atan2(x0.z, x0.x);
    const wrap = (v: number): number => Math.atan2(Math.sin(v), Math.cos(v));
    expect(Math.abs(wrap(dPos))).toBeGreaterThan(0.1);
    expect(Math.abs(wrap(dYaw) - wrap(dPos))).toBeLessThan(1e-6);
  });

  it('a library TURNTABLE (full ring) never pulls its MUs to a mid radius', () => {
    const node = new Object3D(); node.name = 'Turntable';
    node.position.set(1, TOP, 1);
    const disc = new RingGeometry(0.05, 1.2, 32); disc.rotateX(-Math.PI / 2);
    node.add(new Mesh(disc, new MeshBasicMaterial()));
    node.updateMatrixWorld(true);
    const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(1.2, 0.02, 1.2), new Vector3(0, -0.02, 0)));
    s.TransportDirection.set(0, 1, 0); s.Radial = true; s.reapplyConfig(); s.initTransport();
    (s as unknown as { _belongsToLibraryObject: boolean })._belongsToLibraryObject = true;
    s.drive = { currentSpeed: 90, name: 'tt' } as never;
    const scene = new Scene();
    const mu = muAtWorld(scene, new Vector3(2, TOP + 0.05, 1)); // r = 1.0 m
    const manager = new RVTransportManager(); manager.scene = scene;
    manager.surfaces.push(s); manager.mus.push(mu);
    for (let i = 0; i < 120; i++) manager.update(DT);
    const p = mu.getPosition();
    expect(Math.hypot(p.x - 1, p.z - 1)).toBeCloseTo(1, 6);
  });

  it('pivots off by ±1 mm per seam: scene-authored curves drift per lap, library curves hold < 1 mm', () => {
    // Pivot errors like the demo: the error is part of the ASSET, so it rotates
    // with each placement (curve i's pivot error = R_i · d, |d| = 1.41 mm).
    const d = new Vector3(0.001, 0, -0.001);
    const err = [0, 1, 2, 3].map((i) => d.clone().applyAxisAngle(new Vector3(0, 1, 0), -i * Math.PI / 2));
    const run = (library: boolean, speed: number): RingTrace => {
      const scene = new Scene();
      const a = Math.PI / 4; // middle of curve 0 (+X towards +Z)
      const mu = muAtWorld(scene, new Vector3(CENTER.x + R_MID * Math.cos(a), TOP + 0.05, CENTER.z + R_MID * Math.sin(a)));
      const surfaces = [0, 1, 2, 3].map((i) => quarter(i, speed, { pivotError: err[i], library }));
      return circle(surfaces, [], scene, mu, R_MID, 4);
    };
    const out: Record<string, unknown> = {};
    for (const speed of [25, -25]) {
      const raw = run(false, speed);
      const lib = run(true, speed);
      out[`speed${speed}`] = { raw: { lapDriftMm: raw.lapDriftMm, laps: raw.laps }, lib: { lapDriftMm: lib.lapDriftMm, ownMidDevMm: lib.ownMidDevMm, laps: lib.laps } };
      expect(Math.abs(raw.laps)).toBeGreaterThan(3.9);
      expect(Math.abs(lib.laps)).toBeGreaterThan(3.9);
      expect(lib.lapDriftMm).toBeLessThan(1);
      expect(lib.ownMidDevMm).toBeLessThan(3);
    }
    console.log('[plan-675 D3] synthetic pivot error', JSON.stringify(out));
  });
});
