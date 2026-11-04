// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parametric-examples.test.ts — plan-650 Phase 6: the shipped rule examples
 * (`examples/parametric/*.js`) run against SYNTHETIC base parts through the
 * real variant path (`buildVariant` = normalize → QuickJS generator → plan
 * validation → assembly incl. component validation). No SolidCraft, no app:
 * the synthetic parts follow the base-part conventions written in the example
 * headers and in `src/plugins/mcp-bridge/help/parametric.md` (web_help("parametric")).
 */

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import RM8110 from '../examples/parametric/rm8110.js?raw';
import RM8120 from '../examples/parametric/rm8120.js?raw';
import ALUPROFILE from '../examples/parametric/aluprofile.js?raw';
import { buildVariant, type VariantOk } from '../src/core/engine/rv-parametric-family';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { parseParametricComponent, type ParamDef } from '../src/core/engine/rv-parametric-component';
import { computeCodeHash, computePlanHash } from '../src/core/engine/rv-parametric-hash';

/** Wallclock brake out of reach: only the tick budget may stop a run here. */
const NO_WALLCLOCK = { deadlineMs: 60_000 };
const TOL = 0.1; // mm (A5)

// ─── synthetic base parts (mm, SolidCraft axes, feet on z = 0) ────────────

/** Box spanning [x0,x1] × [y0,y1] × [z0,z1]. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): BufferGeometry {
  return new BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** Roller along +Y from y = 0 to `len`, axis at (0, z). Conical when r0 ≠ r1 (r0 at y = 0). */
function roller(len: number, z: number, r0 = 25, r1 = r0): BufferGeometry {
  // CylinderGeometry: axis Y, radiusTop at +Y.
  return new CylinderGeometry(r1, r0, len, 24).translate(0, len / 2, z);
}

const PROFILE = (): BufferGeometry => box(0, 1000, 0, 50, 300, 420);
const GUIDE = (): BufferGeometry => box(0, 1000, 0, 10, 0, 40);
const STRIP = (): BufferGeometry => box(0, 1000, 0, 420, 0, 2);
const ROLLER_Z = 395; // top at 420
const ROLLER_TOP = 420;

/** Family node: `_Parts` carries the SolidCraft sync transform (−90° about X, 0.001), the part meshes stay in mm. */
async function family(code: string, parts: Record<string, BufferGeometry>, values?: Record<string, unknown>): Promise<Object3D> {
  const params = paramsOf(code);
  const node = new Group();
  node.name = 'Family';
  const partsRoot = new Group();
  partsRoot.name = '_Parts';
  partsRoot.rotation.x = -Math.PI / 2;
  partsRoot.scale.setScalar(0.001);
  const mat = new MeshStandardMaterial();
  for (const [name, geometry] of Object.entries(parts)) {
    const part = new Group();
    part.name = name;
    const mesh = new Mesh(geometry, mat);
    mesh.name = `${name}_body`;
    part.add(mesh);
    partsRoot.add(part);
  }
  node.add(partsRoot);
  const defaults = Object.fromEntries(params.map((p) => [p.Name, p.Default]));
  node.userData.realvirtual = {
    ParametricComponent: {
      ApiVersion: 1, Params: params, Values: { ...defaults, ...(values ?? {}) }, Code: code, CodeHash: await computeCodeHash(code),
    },
  };
  setNodeId(node, 'fam-example'); // generated nodes are stamped from the family identity (plan-2216)
  return node;
}

/** The example's PARAMS array — the schema an agent passes as `paramsJson`. */
function paramsOf(code: string): ParamDef[] {
  return new Function(`${code}\nreturn PARAMS;`)() as ParamDef[];
}

async function build(node: Object3D, values?: Record<string, unknown>): Promise<VariantOk> {
  const r = await buildVariant(node, values, NO_WALLCLOCK);
  if (!r.ok) throw new Error(`${r.error.stage}/${r.error.code}: ${r.error.message}`);
  return r;
}

/** Bounds of the meshes below `obj`, in the frame of `root` (mm here). */
function boundsIn(root: Object3D, obj: Object3D): { min: Vector3; max: Vector3 } {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  obj.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    const toRoot = inv.clone().multiply(m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      min.min(v);
      max.max(v);
    }
  });
  return { min, max };
}

/** Radial range (about the origin, XY plane) and angle range in degrees of the meshes below `obj`. */
function polarIn(root: Object3D, obj: Object3D): { rMin: number; rMax: number; aMin: number; aMax: number } {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  let rMin = Infinity, rMax = -Infinity, aMin = Infinity, aMax = -Infinity;
  const v = new Vector3();
  obj.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute('position');
    const toRoot = inv.clone().multiply(m.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      const r = Math.hypot(v.x, v.y);
      // Clockwise from +Y: angle 0 at (0, r), 90° at (r, 0).
      const a = (Math.atan2(v.x, v.y) * 180) / Math.PI;
      rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
      aMin = Math.min(aMin, a); aMax = Math.max(aMax, a);
    }
  });
  return { rMin, rMax, aMin, aMax };
}

function named(root: Object3D, name: string): Object3D {
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`no node "${name}" in the variant`);
  return o;
}

function rollersOf(root: Object3D): Object3D[] {
  return root.children.filter((c) => /^Roller_\d+$/.test(c.name));
}

// ─── schemas ──────────────────────────────────────────────────────────────

describe('examples/parametric — schemas are valid ParametricComponent params', () => {
  for (const [name, code] of [['rm8110', RM8110], ['rm8120', RM8120], ['aluprofile', ALUPROFILE]] as const) {
    it(`${name}: PARAMS parses, defaults normalize`, async () => {
      const params = paramsOf(code);
      const defaults = Object.fromEntries(params.map((p) => [p.Name, p.Default]));
      const parsed = parseParametricComponent({
        ApiVersion: 1, Params: params, Values: defaults, Code: code, CodeHash: await computeCodeHash(code),
      });
      expect(parsed.ok, parsed.ok ? '' : parsed.errors.join('; ')).toBe(true);
    });
  }
});

// ─── RM 8110 straight ─────────────────────────────────────────────────────

describe('examples/parametric/rm8110.js — straight roller conveyor', () => {
  const parts = (): Record<string, BufferGeometry> => ({
    Profile: PROFILE(), Roller: roller(420, ROLLER_Z), Guide: GUIDE(), Strip: STRIP(), Holder: box(0, 60, 0, 50, 0, 300),
  });

  it('defaults: 24 rollers, profiles 2160 mm, snaps at both ends, drive + transport surface', async () => {
    const node = await family(RM8110, parts());
    const v = await build(node);
    const root = v.root;
    expect(rollersOf(root)).toHaveLength(24);
    const prof = boundsIn(root, named(root, 'Profile_L'));
    expect(prof.min.x).toBeCloseTo(0, 3);
    expect(prof.max.x).toBeCloseTo(2160, 3);
    expect(prof.min.y).toBeCloseTo(210, 3);
    expect(prof.min.z).toBeCloseTo(300, 3); // heights stay as authored
    expect(boundsIn(root, named(root, 'Profile_R')).max.y).toBeCloseTo(-210, 3);
    const guide = boundsIn(root, named(root, 'Guide_L'));
    expect(guide.max.z).toBeCloseTo(ROLLER_TOP + 68, 3);
    expect(guide.max.x).toBeCloseTo(2160, 3);
    const strip = boundsIn(root, named(root, 'Transport-Surface'));
    expect(strip.min.z).toBeCloseTo(ROLLER_TOP, 3);
    expect(strip.max.y - strip.min.y).toBeCloseTo(420, 3);
    expect(named(root, 'Snap-XN-convroll').position.toArray()).toEqual([0, 0, ROLLER_TOP]);
    expect(named(root, 'Snap-XP-convroll').position.x).toBeCloseTo(2160, 6);
    const rv = named(root, 'Transport-Surface').userData.realvirtual;
    expect(rv.Drive).toMatchObject({ Direction: 'LinearX', JogForward: true });
    expect(rv.TransportSurface).toMatchObject({ Radial: false });
    // Holders: both ends + every ≤ 1500 mm, two sides → 2 bays → 3 stations × 2.
    expect(root.children.filter((c) => c.name.startsWith('Holder_'))).toHaveLength(6);
    // Rollers without stretch share ONE geometry (duplicate, not copy).
    const geoms = new Set(rollersOf(root).map((r) => (r.children[0] as Mesh).geometry));
    expect(geoms.size).toBe(1);
  });

  it('A1/A5 values BF 620 / ML 3240 / P 120: roller count, lengths and snap follow (0.1 mm)', async () => {
    const node = await family(RM8110, parts());
    const v = await build(node, { BF: 620, ML: 3240, P: 120, HSG: 50 });
    const root = v.root;
    const rollers = rollersOf(root);
    expect(rollers).toHaveLength(27);
    const r0 = boundsIn(root, rollers[0]);
    expect(r0.max.y - r0.min.y).toBeCloseTo(620, 3);
    expect(r0.min.y).toBeCloseTo(-310, 3);
    expect((r0.min.x + r0.max.x) / 2).toBeCloseTo((3240 - 26 * 120) / 2, 3);
    expect(boundsIn(root, named(root, 'Profile_L')).max.x).toBeCloseTo(3240, 3);
    expect(boundsIn(root, named(root, 'Guide_R')).max.z).toBeCloseTo(ROLLER_TOP + 50, 3);
    expect(Math.abs(named(root, 'Snap-XP-convroll').position.x - 3240)).toBeLessThan(TOL);
    // End regions of the stretched profile stay undistorted: cross-section unchanged.
    const prof = boundsIn(root, named(root, 'Profile_L'));
    expect(prof.max.y - prof.min.y).toBeCloseTo(50, 3);
    expect(prof.max.z - prof.min.z).toBeCloseTo(120, 3);
  });

  it('is deterministic and refuses an enum value outside the catalogue', async () => {
    const node = await family(RM8110, parts());
    const a = await build(node, { BF: 840, ML: 1500, P: 60 });
    const b = await build(node, { BF: 840, ML: 1500, P: 60 });
    expect(await computePlanHash(a.plan)).toBe(await computePlanHash(b.plan));
    expect(a.inputs.inputHash).toBe(b.inputs.inputHash);
    const bad = await buildVariant(node, { BF: 500 }, NO_WALLCLOCK);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.stage).toBe('input');
  });

  it('works without the optional Holder part and names a missing required part', async () => {
    const p = parts();
    delete p.Holder;
    const v = await build(await family(RM8110, p));
    expect(v.root.children.some((c) => c.name.startsWith('Holder_'))).toBe(false);
    const q = parts();
    delete q.Guide;
    const r = await buildVariant(await family(RM8110, q), undefined, NO_WALLCLOCK);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.stage).toBe('generator');
      expect(r.error.message).toContain('Guide');
    }
  });
});

// ─── Aluminium profile (A6) ───────────────────────────────────────────────

describe('examples/parametric/aluprofile.js — one part, one stretch (A6)', () => {
  // 40 × 40, 100 mm, with 5 mm end regions (a separate vertex ring at x = 5 / 95, like a chamfer).
  const parts = (): Record<string, BufferGeometry> => ({
    Profile: mergeGeometries([box(0, 5, -20, 20, 0, 40), box(5, 95, -20, 20, 0, 40), box(95, 100, -20, 20, 0, 40)])!,
  });

  it('length follows L, cross-section stays 40 × 40', async () => {
    const node = await family(ALUPROFILE, parts());
    for (const L of [60, 100, 2500, 6000]) {
      const v = await build(node, { L });
      const b = boundsIn(v.root, named(v.root, 'Profile'));
      expect(b.max.x - b.min.x).toBeCloseTo(L, 3);
      expect(b.max.y - b.min.y).toBeCloseTo(40, 3);
      expect(b.max.z - b.min.z).toBeCloseTo(40, 3);
    }
  });

  it('L below the minimum is clamped to 60 (normalization), never a broken mesh', async () => {
    const v = await build(await family(ALUPROFILE, parts()), { L: 10 });
    expect(v.inputs.values.L).toBe(60);
    const b = boundsIn(v.root, named(v.root, 'Profile'));
    expect(b.max.x - b.min.x).toBeCloseTo(60, 3);
  });

  it('the end regions are moved rigidly, not squeezed', async () => {
    const v = await build(await family(ALUPROFILE, parts()), { L: 2500 });
    const xs = new Set<number>();
    const pos = (named(v.root, 'Profile').children[0] as Mesh).geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) xs.add(Math.round(pos.getX(i) * 1000) / 1000);
    expect([...xs].sort((a, b) => a - b)).toEqual([0, 5, 2495, 2500]);
  });
});

// ─── RM 8120 curve ────────────────────────────────────────────────────────

describe('examples/parametric/rm8120.js — curve with bend (A9 without the viewer)', () => {
  // Curve base parts are 300 mm long (shorter than the shortest arc, see the example header).
  const parts = (): Record<string, BufferGeometry> => ({
    Profile: box(0, 300, 0, 50, 300, 420),
    Guide: box(0, 300, 0, 10, 0, 40),
    Strip: box(0, 300, 0, 420, 0, 2),
    Roller420: roller(420, ROLLER_Z, 22, 30),
    Roller620: roller(620, ROLLER_Z, 22, 34),
    Roller840: roller(840, ROLLER_Z, 22, 39),
  });
  const R_I = 825;
  const FW = 50;

  it('every catalogue combination (Angle × BF) builds', async () => {
    const node = await family(RM8120, parts());
    for (const Angle of [30, 45, 60, 90]) {
      for (const BF of [420, 620, 840]) {
        const v = await build(node, { Angle, BF });
        expect(rollersOf(v.root).length, `${Angle}/${BF}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('90° / BF 620: profiles bent on the right radii, rollers radial, surface pivot at the centre', async () => {
    const node = await family(RM8120, parts());
    const v = await build(node, { Angle: 90, BF: 620 });
    const root = v.root;
    const inner = polarIn(root, named(root, 'Profile_In'));
    expect(inner.rMin).toBeGreaterThan(R_I - TOL);
    expect(inner.rMin).toBeLessThan(R_I + 1);
    expect(inner.rMax).toBeLessThan(R_I + FW + TOL);
    expect(inner.aMin).toBeGreaterThan(-TOL);
    expect(inner.aMax).toBeCloseTo(90, 1);
    const outer = polarIn(root, named(root, 'Profile_Out'));
    expect(outer.rMax).toBeLessThan(R_I + 620 + 2 * FW + TOL);
    expect(outer.rMax).toBeGreaterThan(R_I + 620 + 2 * FW - 1);
    expect(outer.rMin).toBeGreaterThan(R_I + FW + 620 - TOL);

    // Rollers: count from the inner pitch, the small end on the inner conveying edge, axis radial.
    const rollers = rollersOf(root);
    expect(rollers).toHaveLength(Math.round(((R_I + FW) * Math.PI) / 2 / 72));
    for (const r of rollers) {
      const p = polarIn(root, r);
      expect(p.rMin).toBeGreaterThan(R_I + FW - 40);
      expect(p.rMax).toBeLessThan(R_I + FW + 620 + 40);
      // Axis direction = local +Y in the family frame must point away from the centre.
      const axis = new Vector3(0, 1, 0).applyQuaternion(r.quaternion);
      const radial = new Vector3(r.position.x, r.position.y, 0).normalize();
      expect(axis.dot(radial)).toBeGreaterThan(0.999);
    }

    // Radial surface: node origin = curve centre, strip covers the conveying width.
    const surf = named(root, 'Transport-Surface');
    expect(Math.hypot(surf.position.x, surf.position.y)).toBeLessThan(1e-9);
    const sp = polarIn(root, surf);
    expect(sp.rMin).toBeCloseTo(R_I + FW, 3);
    expect(sp.rMax).toBeCloseTo(R_I + FW + 620, 3);
    expect(surf.userData.realvirtual.TransportSurface).toMatchObject({ Radial: true });
    expect(surf.userData.realvirtual.Drive).toMatchObject({ Direction: 'RotationZ' });

    // Snaps at both ends on the centre line; 90° exit is cardinal (Z in the viewer frame).
    const rMid = R_I + FW + 310;
    const entry = named(root, 'Snap-XN-convroll').position;
    expect(entry.x).toBeCloseTo(0, 6);
    expect(entry.y).toBeCloseTo(rMid, 6);
    const exit = named(root, 'Snap-ZP-convroll').position;
    expect(exit.x).toBeCloseTo(rMid, 6);
    expect(Math.abs(exit.y)).toBeLessThan(1e-6);
  });

  it('BF selects the conical roller by name (not stretched), angle sets the arc', async () => {
    const node = await family(RM8120, parts());
    const v = await build(node, { Angle: 45, BF: 840 });
    const r0 = rollersOf(v.root)[0];
    const len = boundsIn(r0, r0);
    expect(len.max.y - len.min.y).toBeCloseTo(840, 3);
    expect(polarIn(v.root, named(v.root, 'Profile_In')).aMax).toBeCloseTo(45, 1);
    expect(v.root.getObjectByName('Snap-XP-convroll')).toBeTruthy();
    const missing = parts();
    delete missing.Roller840;
    const r = await buildVariant(await family(RM8120, missing), { BF: 840 }, NO_WALLCLOCK);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('Roller840');
  });
});
