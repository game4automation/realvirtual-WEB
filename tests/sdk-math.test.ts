// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-math.test.ts — plan-210 §6 appendix (value math on POJOs).
 *
 * The library is a single JS source (SSOT) evaluated both host-side and in
 * the VM; these tests exercise the host build (identical semantics by
 * construction) against three.js as the reference implementation where
 * useful.
 */

import { describe, it, expect } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { buildSdkMathHost, type Vec3, type Quat } from '../src/core/sdk/rv-sdk-math';

const M = buildSdkMathHost();
const { vec3, quat, mat4, aabb } = M;

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
function expectVec(v: Vec3, x: number, y: number, z: number, eps = 1e-9): void {
  expect(close(v.x, x, eps) && close(v.y, y, eps) && close(v.z, z, eps),
    `(${v.x},${v.y},${v.z}) != (${x},${y},${z})`).toBe(true);
}

describe('vec3', () => {
  it('constructor defaults + add/sub/scale/negate', () => {
    expectVec(vec3(), 0, 0, 0);
    expectVec(vec3.add(vec3(1, 2, 3), vec3(4, 5, 6)), 5, 7, 9);
    expectVec(vec3.sub(vec3(4, 5, 6), vec3(1, 2, 3)), 3, 3, 3);
    expectVec(vec3.scale(vec3(1, -2, 3), 2), 2, -4, 6);
    expectVec(vec3.negate(vec3(1, -2, 3)), -1, 2, -3);
  });

  it('dot / cross / length / normalize / distance', () => {
    expect(vec3.dot(vec3(1, 2, 3), vec3(4, -5, 6))).toBe(12);
    expectVec(vec3.cross(vec3(1, 0, 0), vec3(0, 1, 0)), 0, 0, 1);
    expect(vec3.length(vec3(3, 4, 0))).toBe(5);
    expect(vec3.lengthSq(vec3(3, 4, 0))).toBe(25);
    expectVec(vec3.normalize(vec3(0, 0, 5)), 0, 0, 1);
    expectVec(vec3.normalize(vec3(0, 0, 0)), 0, 0, 0); // degenerate safe
    expect(vec3.distance(vec3(1, 1, 1), vec3(1, 1, 3))).toBe(2);
  });

  it('lerp / project / reflect / equals', () => {
    expectVec(vec3.lerp(vec3(0, 0, 0), vec3(10, 20, 30), 0.5), 5, 10, 15);
    expectVec(vec3.project(vec3(2, 3, 0), vec3(1, 0, 0)), 2, 0, 0);
    expectVec(vec3.reflect(vec3(1, -1, 0), vec3(0, 1, 0)), 1, 1, 0);
    expect(vec3.equals(vec3(1, 2, 3), vec3(1 + 1e-12, 2, 3))).toBe(true);
    expect(vec3.equals(vec3(1, 2, 3), vec3(1.1, 2, 3))).toBe(false);
  });

  it('angleTo — atan2-grade angles incl. orthogonal and degenerate', () => {
    expect(close(vec3.angleTo(vec3(1, 0, 0), vec3(0, 1, 0)), Math.PI / 2)).toBe(true);
    expect(close(vec3.angleTo(vec3(1, 0, 0), vec3(-1, 0, 0)), Math.PI)).toBe(true);
    expect(close(vec3.angleTo(vec3(1, 0, 0), vec3(1, 0, 0)), 0)).toBe(true);
    expect(close(vec3.angleTo(vec3(0, 0, 0), vec3(1, 0, 0)), Math.PI / 2)).toBe(true); // three.js convention
  });

  it('applyQuat matches three.js', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
    const ref = new Vector3(1, 2, 3).applyQuaternion(q);
    const got = vec3.applyQuat(vec3(1, 2, 3), { x: q.x, y: q.y, z: q.z, w: q.w });
    expectVec(got, ref.x, ref.y, ref.z, 1e-12);
  });

  it('applyMat4 matches three.js (incl. translation)', () => {
    const m = new Matrix4().compose(
      new Vector3(1, 2, 3),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.7),
      new Vector3(2, 2, 2),
    );
    const ref = new Vector3(4, -5, 6).applyMatrix4(m);
    const got = vec3.applyMat4(vec3(4, -5, 6), [...m.elements]);
    expectVec(got, ref.x, ref.y, ref.z, 1e-9);
  });
});

describe('quat', () => {
  it('identity default + fromAxisAngle matches three.js', () => {
    const q = quat();
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const ref = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1.1);
    const got = quat.fromAxisAngle(vec3(0, 0, 1), 1.1);
    expect(close(got.x, ref.x) && close(got.y, ref.y) && close(got.z, ref.z) && close(got.w, ref.w)).toBe(true);
  });

  it('fromEuler matches three.js for XYZ and ZYX orders', () => {
    for (const order of ['XYZ', 'ZYX'] as const) {
      const ref = new Quaternion().setFromEuler(new Euler(0.3, -0.5, 1.2, order));
      const got = quat.fromEuler(0.3, -0.5, 1.2, order);
      expect(close(got.x, ref.x, 1e-12)).toBe(true);
      expect(close(got.w, ref.w, 1e-12)).toBe(true);
    }
  });

  it('mul / conjugate / invert / normalize behave like three.js', () => {
    const a = quat.fromAxisAngle(vec3(0, 1, 0), 0.6);
    const b = quat.fromAxisAngle(vec3(1, 0, 0), -0.4);
    const refMul = new Quaternion(a.x, a.y, a.z, a.w).multiply(new Quaternion(b.x, b.y, b.z, b.w));
    const gotMul = quat.mul(a, b);
    expect(close(gotMul.x, refMul.x, 1e-12) && close(gotMul.w, refMul.w, 1e-12)).toBe(true);

    // invert(q) ∘ q rotates nothing
    const v = vec3(1, 2, 3);
    const roundtrip = vec3.applyQuat(vec3.applyQuat(v, a), quat.invert(a));
    expectVec(roundtrip, 1, 2, 3, 1e-12);
  });

  it('slerp boundary values return the endpoints; midpoint is normalized', () => {
    const a = quat.fromAxisAngle(vec3(0, 1, 0), 0);
    const b = quat.fromAxisAngle(vec3(0, 1, 0), Math.PI / 2);
    expect(quat.slerp(a, b, 0)).toEqual(a);
    expect(quat.slerp(a, b, 1)).toEqual(b);
    const mid = quat.slerp(a, b, 0.5);
    const refMid = new Quaternion(a.x, a.y, a.z, a.w).slerp(new Quaternion(b.x, b.y, b.z, b.w), 0.5);
    expect(close(mid.y, refMid.y, 1e-12) && close(mid.w, refMid.w, 1e-12)).toBe(true);
    const len = Math.sqrt(mid.x ** 2 + mid.y ** 2 + mid.z ** 2 + mid.w ** 2);
    expect(close(len, 1, 1e-12)).toBe(true);
  });

  it('slerp of (nearly) identical quaternions is stable (no NaN)', () => {
    const a = quat.fromAxisAngle(vec3(0, 1, 0), 0.5);
    const m = quat.slerp(a, a, 0.5);
    expect(Number.isNaN(m.w)).toBe(false);
    expect(close(quat.angleTo(a, m), 0, 1e-6)).toBe(true);
  });

  it('angleTo is double-cover safe (q and -q are the same rotation)', () => {
    const a = quat.fromAxisAngle(vec3(0, 1, 0), 0.5);
    const neg: Quat = { x: -a.x, y: -a.y, z: -a.z, w: -a.w };
    // acos has an unbounded derivative at 1 — a 1-ulp dot error already gives
    // ~3e-8 rad, so the double-cover zero is asserted at 1e-6.
    expect(close(quat.angleTo(a, neg), 0, 1e-6)).toBe(true);
  });

  it('lookRotation rotates +Z onto the forward direction', () => {
    const fwd = vec3.normalize(vec3(1, 0, 1));
    const q = quat.lookRotation(fwd);
    const rotated = vec3.applyQuat(vec3(0, 0, 1), q);
    expectVec(rotated, fwd.x, fwd.y, fwd.z, 1e-9);
  });
});

describe('mat4', () => {
  it('identity / compose / transformPoint round-trip against three.js', () => {
    const pos = vec3(10, -2, 4);
    const rot = quat.fromAxisAngle(vec3(0, 1, 0), 1.3);
    const scl = vec3(1, 2, 0.5);
    const m = mat4.compose(pos, rot, scl);
    const ref = new Matrix4().compose(
      new Vector3(pos.x, pos.y, pos.z),
      new Quaternion(rot.x, rot.y, rot.z, rot.w),
      new Vector3(scl.x, scl.y, scl.z),
    );
    for (let i = 0; i < 16; i++) expect(close(m[i], ref.elements[i], 1e-12)).toBe(true);

    const p = vec3(3, 4, 5);
    const refP = new Vector3(3, 4, 5).applyMatrix4(ref);
    expectVec(mat4.transformPoint(m, p), refP.x, refP.y, refP.z, 1e-9);
  });

  it('invert: M * M⁻¹ maps points to themselves', () => {
    const m = mat4.compose(vec3(5, 6, 7), quat.fromAxisAngle(vec3(1, 1, 0), 0.8), vec3(2, 3, 4));
    const inv = mat4.invert(m);
    const p = vec3(1, 2, 3);
    const roundtrip = mat4.transformPoint(inv, mat4.transformPoint(m, p));
    expectVec(roundtrip, 1, 2, 3, 1e-9);
  });

  it('multiply matches three.js order', () => {
    const a = mat4.compose(vec3(1, 0, 0), quat.fromAxisAngle(vec3(0, 1, 0), 0.5), vec3(1, 1, 1));
    const b = mat4.compose(vec3(0, 2, 0), quat.fromAxisAngle(vec3(1, 0, 0), -0.3), vec3(1, 1, 1));
    const got = mat4.multiply(a, b);
    const ref = new Matrix4().fromArray(a).multiply(new Matrix4().fromArray(b));
    for (let i = 0; i < 16; i++) expect(close(got[i], ref.elements[i], 1e-12)).toBe(true);
  });

  it('transformDir ignores translation and normalizes', () => {
    const m = mat4.compose(vec3(100, 100, 100), quat.fromAxisAngle(vec3(0, 1, 0), Math.PI / 2), vec3(3, 3, 3));
    const d = mat4.transformDir(m, vec3(0, 0, 1));
    expectVec(d, 1, 0, 0, 1e-9);
    expect(close(vec3.length(d), 1)).toBe(true);
  });
});

describe('aabb', () => {
  const box = { min: vec3(-1, 0, -2), max: vec3(1, 4, 2) };

  it('size / center / longestAxis', () => {
    expectVec(aabb.size(box), 2, 4, 4);
    expectVec(aabb.center(box), 0, 2, 0);
    expect(aabb.longestAxis(box)).toBe('y');
    expect(aabb.longestAxis({ min: vec3(0, 0, 0), max: vec3(5, 1, 1) })).toBe('x');
  });

  it('overlaps / contains', () => {
    expect(aabb.overlaps(box, { min: vec3(0.5, 3, 0), max: vec3(3, 5, 1) })).toBe(true);
    expect(aabb.overlaps(box, { min: vec3(2, 0, 0), max: vec3(3, 1, 1) })).toBe(false);
    expect(aabb.contains(box, vec3(0, 1, 0))).toBe(true);
    expect(aabb.contains(box, vec3(0, 5, 0))).toBe(false);
  });

  it('fromNodes unions bounds() of node handles', () => {
    const nodes = [
      { bounds: () => ({ min: vec3(0, 0, 0), max: vec3(1, 1, 1) }) },
      { bounds: () => ({ min: vec3(-2, 0, 0), max: vec3(0, 3, 0) }) },
    ];
    const u = aabb.fromNodes(nodes);
    expectVec(u.min, -2, 0, 0);
    expectVec(u.max, 1, 3, 1);
  });
});

describe('helpers', () => {
  it('clamp / DEG2RAD / RAD2DEG', () => {
    expect(M.clamp(5, 0, 3)).toBe(3);
    expect(M.clamp(-5, 0, 3)).toBe(0);
    expect(M.clamp(2, 0, 3)).toBe(2);
    expect(close(180 * M.DEG2RAD, Math.PI)).toBe(true);
    expect(close(Math.PI * M.RAD2DEG, 180)).toBe(true);
  });
});
