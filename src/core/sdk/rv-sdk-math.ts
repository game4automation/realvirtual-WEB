// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sdk-math.ts — the SDK value-math library (`vec3/quat/mat4/aabb` on POJOs,
 * plan-210 §6 appendix).
 *
 * DESIGN DECISION (documented per plan §9 phase 1): the math library is
 * **injected into the QuickJS VM as JS source**, NOT exposed as host
 * functions. Pure POJO math would pay a marshal/dump roundtrip per call as a
 * host function — evaluating the source once per context makes every
 * subsequent call a plain in-VM call (zero boundary cost). To guarantee
 * IDENTICAL semantics on both sides (host-side tests, later host-side
 * consumers), the implementation lives in ONE self-contained JS source string
 * (`SDK_MATH_SOURCE`) that is (a) evaluated in the guest context and (b)
 * built host-side via `buildSdkMathHost()`. There is no second
 * implementation to drift.
 *
 * All types are plain data: `Vec3 = {x,y,z}`, `Quat = {x,y,z,w}`,
 * `Mat4 = number[16]` (column-major, three.js convention),
 * `AABB = {min,max}`. Nothing three.js crosses the boundary (S1).
 */

// ─── Value types (POJOs) ───────────────────────────────────────────────────

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
/** Column-major 4×4 matrix (three.js element order). */
export type Mat4 = number[];
export interface AABB { min: Vec3; max: Vec3 }

/** Euler application order (subset matching three.js). */
export type EulerOrder = 'XYZ' | 'YXZ' | 'ZXY' | 'ZYX' | 'YZX' | 'XZY';

/** Minimal node surface `aabb.fromNodes` reads (a NodeHandle satisfies it). */
export interface BoundsSource { bounds(): AABB }

// ─── Library interfaces (§6 appendix) ──────────────────────────────────────

export interface Vec3Lib {
  (x?: number, y?: number, z?: number): Vec3;
  add(a: Vec3, b: Vec3): Vec3;
  sub(a: Vec3, b: Vec3): Vec3;
  scale(a: Vec3, s: number): Vec3;
  dot(a: Vec3, b: Vec3): number;
  cross(a: Vec3, b: Vec3): Vec3;
  length(a: Vec3): number;
  lengthSq(a: Vec3): number;
  normalize(a: Vec3): Vec3;
  distance(a: Vec3, b: Vec3): number;
  lerp(a: Vec3, b: Vec3, t: number): Vec3;
  angleTo(a: Vec3, b: Vec3): number;
  project(a: Vec3, onto: Vec3): Vec3;
  reflect(a: Vec3, n: Vec3): Vec3;
  applyQuat(a: Vec3, q: Quat): Vec3;
  applyMat4(a: Vec3, m: Mat4): Vec3;
  negate(a: Vec3): Vec3;
  equals(a: Vec3, b: Vec3, eps?: number): boolean;
}

export interface QuatLib {
  (x?: number, y?: number, z?: number, w?: number): Quat;
  fromAxisAngle(axis: Vec3, rad: number): Quat;
  fromEuler(x: number, y: number, z: number, order?: EulerOrder): Quat;
  mul(a: Quat, b: Quat): Quat;
  conjugate(q: Quat): Quat;
  invert(q: Quat): Quat;
  normalize(q: Quat): Quat;
  slerp(a: Quat, b: Quat, t: number): Quat;
  angleTo(a: Quat, b: Quat): number;
  lookRotation(forward: Vec3, up?: Vec3): Quat;
}

export interface Mat4Lib {
  identity(): Mat4;
  multiply(a: Mat4, b: Mat4): Mat4;
  invert(m: Mat4): Mat4;
  compose(pos: Vec3, rot: Quat, scale: Vec3): Mat4;
  transformPoint(m: Mat4, p: Vec3): Vec3;
  transformDir(m: Mat4, d: Vec3): Vec3;
}

export interface AABBLib {
  fromNodes(nodes: BoundsSource[]): AABB;
  size(b: AABB): Vec3;
  center(b: AABB): Vec3;
  longestAxis(b: AABB): 'x' | 'y' | 'z';
  overlaps(a: AABB, b: AABB): boolean;
  contains(b: AABB, p: Vec3): boolean;
}

/** The full math bundle as produced by `__rvMathBuild()` on either side. */
export interface SdkMathLib {
  vec3: Vec3Lib;
  quat: QuatLib;
  mat4: Mat4Lib;
  aabb: AABBLib;
  DEG2RAD: number;
  RAD2DEG: number;
  clamp(x: number, lo: number, hi: number): number;
}

// ─── The single-source implementation ──────────────────────────────────────

/**
 * Self-contained JS source defining `__rvMathBuild()` (no imports, no host
 * calls, conservative syntax — runs in QuickJS AND host `new Function`).
 * This string is the SSOT; there is intentionally NO parallel TS impl.
 */
export const SDK_MATH_SOURCE = String.raw`
function __rvMathBuild() {
  'use strict';
  var DEG2RAD = Math.PI / 180;
  var RAD2DEG = 180 / Math.PI;
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // ── vec3 ──
  function vec3(x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; }
  vec3.add = function (a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; };
  vec3.sub = function (a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; };
  vec3.scale = function (a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; };
  vec3.dot = function (a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; };
  vec3.cross = function (a, b) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  };
  vec3.lengthSq = function (a) { return a.x * a.x + a.y * a.y + a.z * a.z; };
  // Function.prototype.length is non-writable — install the lib method via
  // defineProperty (length IS configurable), identical in QuickJS and host.
  Object.defineProperty(vec3, 'length', {
    value: function (a) { return Math.sqrt(vec3.lengthSq(a)); },
    writable: true,
    configurable: true,
  });
  vec3.normalize = function (a) {
    var l = vec3.length(a);
    return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
  };
  vec3.distance = function (a, b) { return vec3.length(vec3.sub(a, b)); };
  vec3.lerp = function (a, b, t) {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  vec3.angleTo = function (a, b) {
    var d = Math.sqrt(vec3.lengthSq(a) * vec3.lengthSq(b));
    if (d === 0) return Math.PI / 2;
    return Math.acos(clamp(vec3.dot(a, b) / d, -1, 1));
  };
  vec3.project = function (a, onto) {
    var lsq = vec3.lengthSq(onto);
    if (lsq === 0) return { x: 0, y: 0, z: 0 };
    return vec3.scale(onto, vec3.dot(a, onto) / lsq);
  };
  vec3.reflect = function (a, n) {
    return vec3.sub(a, vec3.scale(n, 2 * vec3.dot(a, n)));
  };
  vec3.applyQuat = function (a, q) {
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
    var qv = { x: q.x, y: q.y, z: q.z };
    var t = vec3.scale(vec3.cross(qv, a), 2);
    return vec3.add(a, vec3.add(vec3.scale(t, q.w), vec3.cross(qv, t)));
  };
  vec3.applyMat4 = function (a, m) {
    var w = m[3] * a.x + m[7] * a.y + m[11] * a.z + m[15];
    var iw = w !== 0 ? 1 / w : 1;
    return {
      x: (m[0] * a.x + m[4] * a.y + m[8] * a.z + m[12]) * iw,
      y: (m[1] * a.x + m[5] * a.y + m[9] * a.z + m[13]) * iw,
      z: (m[2] * a.x + m[6] * a.y + m[10] * a.z + m[14]) * iw,
    };
  };
  vec3.negate = function (a) { return { x: -a.x, y: -a.y, z: -a.z }; };
  vec3.equals = function (a, b, eps) {
    var e = eps === undefined ? 1e-9 : eps;
    return Math.abs(a.x - b.x) <= e && Math.abs(a.y - b.y) <= e && Math.abs(a.z - b.z) <= e;
  };

  // ── quat ──
  function quat(x, y, z, w) {
    return { x: x || 0, y: y || 0, z: z || 0, w: w === undefined ? 1 : w };
  }
  quat.fromAxisAngle = function (axis, rad) {
    var n = vec3.normalize(axis);
    var h = rad / 2, s = Math.sin(h);
    return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(h) };
  };
  quat.fromEuler = function (x, y, z, order) {
    // Mirrors three.js Quaternion.setFromEuler (intrinsic rotations).
    var o = order || 'XYZ';
    var c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    var s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    switch (o) {
      case 'XYZ': return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
      case 'YXZ': return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 };
      case 'ZXY': return { x: s1 * c2 * c3 - c1 * s2 * s3, y: c1 * s2 * c3 + s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
      case 'ZYX': return { x: s1 * c2 * c3 - c1 * s2 * s3, y: c1 * s2 * c3 + s1 * c2 * s3, z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 };
      case 'YZX': return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 + s1 * c2 * s3, z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 - s1 * s2 * s3 };
      case 'XZY': return { x: s1 * c2 * c3 - c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 + s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 };
      default: throw new Error('quat.fromEuler: unknown order ' + o);
    }
  };
  quat.mul = function (a, b) {
    return {
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
  };
  quat.conjugate = function (q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; };
  quat.normalize = function (q) {
    var l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (l === 0) return { x: 0, y: 0, z: 0, w: 1 };
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
  };
  quat.invert = function (q) { return quat.conjugate(quat.normalize(q)); };
  quat.slerp = function (a, b, t) {
    if (t <= 0) return { x: a.x, y: a.y, z: a.z, w: a.w };
    if (t >= 1) return { x: b.x, y: b.y, z: b.z, w: b.w };
    var cosHalf = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    var bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (cosHalf < 0) { cosHalf = -cosHalf; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (cosHalf >= 1) return { x: a.x, y: a.y, z: a.z, w: a.w };
    var sqrSinHalf = 1 - cosHalf * cosHalf;
    if (sqrSinHalf <= Number.EPSILON) {
      var s0 = 1 - t;
      return quat.normalize({ x: s0 * a.x + t * bx, y: s0 * a.y + t * by, z: s0 * a.z + t * bz, w: s0 * a.w + t * bw });
    }
    var sinHalf = Math.sqrt(sqrSinHalf);
    var half = Math.atan2(sinHalf, cosHalf);
    var rA = Math.sin((1 - t) * half) / sinHalf;
    var rB = Math.sin(t * half) / sinHalf;
    return { x: a.x * rA + bx * rB, y: a.y * rA + by * rB, z: a.z * rA + bz * rB, w: a.w * rA + bw * rB };
  };
  quat.angleTo = function (a, b) {
    var d = clamp(Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w), 0, 1);
    return 2 * Math.acos(d);
  };
  quat.lookRotation = function (forward, up) {
    // Basis with +Z = forward (three.js lookAt convention for objects).
    var u = up || { x: 0, y: 1, z: 0 };
    var z = vec3.normalize(forward);
    if (vec3.lengthSq(z) === 0) z = { x: 0, y: 0, z: 1 };
    var x = vec3.cross(u, z);
    if (vec3.lengthSq(x) < 1e-12) {
      // forward parallel to up — pick another reference
      x = vec3.cross(Math.abs(z.z) < 0.999 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, z);
    }
    x = vec3.normalize(x);
    var y = vec3.cross(z, x);
    return quatFromBasis(x, y, z);
  };
  function quatFromBasis(x, y, z) {
    // Rotation matrix columns x,y,z → quaternion (Shepperd's method).
    var m00 = x.x, m01 = y.x, m02 = z.x;
    var m10 = x.y, m11 = y.y, m12 = z.y;
    var m20 = x.z, m21 = y.z, m22 = z.z;
    var trace = m00 + m11 + m22, s;
    if (trace > 0) {
      s = 0.5 / Math.sqrt(trace + 1);
      return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
    } else if (m00 > m11 && m00 > m22) {
      s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
    } else if (m11 > m22) {
      s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
    }
    s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
  }

  // ── mat4 (column-major, three.js element order) ──
  var mat4 = {
    identity: function () {
      return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    },
    multiply: function (a, b) {
      var r = new Array(16);
      for (var col = 0; col < 4; col++) {
        for (var row = 0; row < 4; row++) {
          r[col * 4 + row] =
            a[0 * 4 + row] * b[col * 4 + 0] +
            a[1 * 4 + row] * b[col * 4 + 1] +
            a[2 * 4 + row] * b[col * 4 + 2] +
            a[3 * 4 + row] * b[col * 4 + 3];
        }
      }
      return r;
    },
    invert: function (m) {
      // General 4x4 inverse (three.js Matrix4.invert algorithm).
      var n11 = m[0], n21 = m[1], n31 = m[2], n41 = m[3];
      var n12 = m[4], n22 = m[5], n32 = m[6], n42 = m[7];
      var n13 = m[8], n23 = m[9], n33 = m[10], n43 = m[11];
      var n14 = m[12], n24 = m[13], n34 = m[14], n44 = m[15];
      var t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
      var t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
      var t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
      var t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
      var det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
      if (det === 0) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      var di = 1 / det;
      var r = new Array(16);
      r[0] = t11 * di;
      r[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * di;
      r[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * di;
      r[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * di;
      r[4] = t12 * di;
      r[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * di;
      r[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * di;
      r[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * di;
      r[8] = t13 * di;
      r[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * di;
      r[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * di;
      r[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * di;
      r[12] = t14 * di;
      r[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * di;
      r[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * di;
      r[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * di;
      return r;
    },
    compose: function (pos, rot, scale) {
      var x = rot.x, y = rot.y, z = rot.z, w = rot.w;
      var x2 = x + x, y2 = y + y, z2 = z + z;
      var xx = x * x2, xy = x * y2, xz = x * z2;
      var yy = y * y2, yz = y * z2, zz = z * z2;
      var wx = w * x2, wy = w * y2, wz = w * z2;
      var sx = scale.x, sy = scale.y, sz = scale.z;
      return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        pos.x, pos.y, pos.z, 1,
      ];
    },
    transformPoint: function (m, p) { return vec3.applyMat4(p, m); },
    transformDir: function (m, d) {
      return vec3.normalize({
        x: m[0] * d.x + m[4] * d.y + m[8] * d.z,
        y: m[1] * d.x + m[5] * d.y + m[9] * d.z,
        z: m[2] * d.x + m[6] * d.y + m[10] * d.z,
      });
    },
  };

  // ── aabb ──
  var aabb = {
    fromNodes: function (nodes) {
      var min = { x: Infinity, y: Infinity, z: Infinity };
      var max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i].bounds();
        if (!b) continue;
        min.x = Math.min(min.x, b.min.x); min.y = Math.min(min.y, b.min.y); min.z = Math.min(min.z, b.min.z);
        max.x = Math.max(max.x, b.max.x); max.y = Math.max(max.y, b.max.y); max.z = Math.max(max.z, b.max.z);
      }
      return { min: min, max: max };
    },
    size: function (b) {
      return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
    },
    center: function (b) {
      return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
    },
    longestAxis: function (b) {
      var s = aabb.size(b);
      if (s.x >= s.y && s.x >= s.z) return 'x';
      return s.y >= s.z ? 'y' : 'z';
    },
    overlaps: function (a, b) {
      return a.min.x <= b.max.x && a.max.x >= b.min.x &&
             a.min.y <= b.max.y && a.max.y >= b.min.y &&
             a.min.z <= b.max.z && a.max.z >= b.min.z;
    },
    contains: function (b, p) {
      return p.x >= b.min.x && p.x <= b.max.x &&
             p.y >= b.min.y && p.y <= b.max.y &&
             p.z >= b.min.z && p.z <= b.max.z;
    },
  };

  return {
    vec3: vec3, quat: quat, mat4: mat4, aabb: aabb,
    DEG2RAD: DEG2RAD, RAD2DEG: RAD2DEG, clamp: clamp,
  };
}
`;

/** Guest install snippet: evaluates the SSOT and pins it on the VM global. */
export const SDK_MATH_INSTALL_SOURCE = `${SDK_MATH_SOURCE}\nglobalThis.__rvMath = __rvMathBuild();\n'ok';`;

let hostLib: SdkMathLib | null = null;

/**
 * Build the math library HOST-side from the same source string (identical
 * semantics to the VM copy by construction). Cached module-wide.
 */
export function buildSdkMathHost(): SdkMathLib {
  if (!hostLib) {
    // Deliberate: evaluate the SSOT source host-side (identical semantics to
    // the VM copy). The string is a build-time constant, not user input.
    const factory = new Function(`${SDK_MATH_SOURCE}; return __rvMathBuild();`);
    hostLib = factory() as SdkMathLib;
  }
  return hostLib;
}
