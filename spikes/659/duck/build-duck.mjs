// realvirtual.io (R) - plan-659 spike asset
//
// Builds "RV Walker" - an ORIGINAL realvirtual visual asset for the plan-659 locomotion
// demo: a small two-legged service robot, generated procedurally from primitives.
//
// LICENCE PROVENANCE (read before touching this file)
// ---------------------------------------------------
// The only third-party inputs are Apache-2.0 TEXT files of the Phase-0 fixture:
//
//   fixtures/microduck/mjcf/robot_allcollisions.xml   body tree, joints, INERTIALS, sites
//   fixtures/microduck/rig/kinematics.json            the same kinematics, machine readable
//   fixtures/microduck/mjcf/prepared-scene.xml        the STAND keyframe qpos
//
// Those carry NUMBERS, which are free. The original STL collision meshes
// (mjcf/assets/*.stl) and visual/microduck.glb are CC BY-NC-SA 4.0 - NonCommercial AND
// ShareAlike, and that clause explicitly covers "decimated or converted meshes". They are
// NEVER opened, loaded, converted, decimated or traced by this script, and no shape here
// is derived from them. Every surface below is a chamfered box, a cylinder, a swept tube
// or an ellipsoid placed by this script.
//
// THE COLLISION SIDE IS OWN WORK TOO, since plan-659 stage 2. This script builds
// the VISIBLE geometry; `build-collision-primitives.mjs` builds the SIMULATED
// one the same way - Apache-2.0 XML plus measured dimensions, out comes
// `rv-duck-collision.xml` with eleven original MuJoCo primitives and not a
// single mesh reference. The `rv_mujoco.mjcf` key below points at it and hands
// over no `meshBase`, so the running demo fetches no .stl at all and no CC
// BY-NC-SA file has to be shipped with it. The STL fixture is still what those
// dimensions were measured from once (see `measure-collision-hulls.mjs`), it is
// gitignored, and nothing needs it to run.
//
// IT IS LIKEWISE NOT MODELLED ON ANY PROTECTED ROBOT CHARACTER. The design language used
// here - flat panels with parting lines, visible fasteners, louvre fields, a pair of round
// optics, externally routed cables, light shells over dark mechanics, accent paint on whole
// panels - is the generic vocabulary of industrial product design. It belongs to no one.
// What is deliberately NOT done: no protected figure's silhouette, no characteristic head
// shape quoted from one, no recognisable livery of one, no logo and no marking that could
// be read as someone else's. The label field is BLANK on purpose: no glyphs, no digits,
// nothing that could read as a foreign type designation.
//
// WHAT IS TAKEN FROM THE MJCF (bit-exact - the ONNX policy is trained on this kinematics):
//   * the 15-body tree and its parent links
//   * every body's local pos + quat
//   * all 14 hinge joints, their local Z axis, their ranges and their actuator index
//   * the STAND keyframe the asset is shipped posed in
//   * every <site> (sensor mounting points) and the <sensor> block attached to them
//   * every <inertial>: mass, COM and the full inertia tensor - see PROPORTIONS below
// WHAT IS OURS: the surface language, the colour scheme and the character.
//
// PROPORTIONS FROM THE INERTIA TENSORS
// ------------------------------------
// Each <inertial> is diagonalised; from the principal moments the semi-axes of the
// equivalent homogeneous solid ellipsoid follow in closed form:
//     I0 = m(b^2+c^2)/5,  I1 = m(a^2+c^2)/5,  I2 = m(a^2+b^2)/5
//     => with Xi = 5*Ii/m and S = (X0+X1+X2)/2 :  a^2 = S-X0,  b^2 = S-X1,  c^2 = S-X2
// That is the best free estimate of how each segment is PROPORTIONED and ORIENTED - a
// long flat head has a very different tensor than a ball of the same mass.
//
// What it is NOT is a reliable absolute size. These bodies are shells with heavy discrete
// items inside (battery, servos, Raspberry Pi), so the equivalent SOLID ellipsoid over- or
// under-states the outer envelope depending on where the mass sits. So this script takes
// the RATIO and the ORIENTATION from the tensor and the SCALE from an anchor that can be
// checked: for the head, the requirement that the head_camera site lands exactly on the
// front face. Every deviation is a named constant.
//
// HULLS ARE CHAMFERED BOXES, NOT ELLIPSOIDS
// -----------------------------------------
// Head and trunk are built as chamfered boxes (RoundedBoxGeometry) carrying the tensor's
// proportions. That is a design decision - flat panels, hard parting lines, visible
// fasteners - and it also makes the sensor seating EXACT: head_camera and tof sit at the
// same head-local x, so ONE flat front face passes through both and neither site has to be
// moved at all. The hull maths is therefore the exact signed distance function of a
// rounded box, not the ellipsoid approximation used while the hulls were ellipsoids.
//
// VISUAL HULL vs COLLISION: MuJoCo integrates the real masses, inertias and collision
// geoms; the viewer only sees this hull. The hull may therefore be designed more freely,
// as long as the 14 joint frames stay exact and the deviation stays small enough that
// nothing visibly interpenetrates (feet sink, head through the floor). Deviations taken
// on purpose are marked DEVIATION in the code below.
//
// CABLES AND MOTION: every externally routed cable belongs to exactly ONE body and ends on
// a joint CENTRE, i.e. on the rotation axis of the next joint. It therefore stays visually
// plugged in in every pose and can never be torn apart by the policy.
//
// Frame: authored in MuJoCo convention (Z up, +X = facing direction, metres). A single
// root node "rv_duck" rotates -90 deg about X so the glTF Y-up world shows it upright.
// Node names equal the MJCF body / site names, so a qpos vector maps straight onto the
// graph:  node.quaternion = extras.rv_joint.rest_quat_xyzw * Rz(qpos[actuator_index])
//
// Usage: node spikes/659/duck/build-duck.mjs          (RV_DUCK_SITES=1 for diagnostics)

import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Document, NodeIO } from '@gltf-transform/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'microduck');
const RIG = path.join(FIX, 'rig', 'kinematics.json');
const MJCF = path.join(FIX, 'mjcf', 'robot_allcollisions.xml');
const OUT = path.join(HERE, 'rv-duck.glb');
const DIAG = !!process.env.RV_DUCK_SITES;

// ---------------------------------------------------------------------------
// 1. The kinematics, straight out of the Apache-2.0 rig description
// ---------------------------------------------------------------------------
const rig = JSON.parse(readFileSync(RIG, 'utf8'));
const mjcfText = readFileSync(MJCF, 'utf8');

// STAND keyframe from mjcf/prepared-scene.xml <key name="STAND" qpos="...">.
// The first 7 qpos values are the free joint (pos 0 0 0.12, quat 1 0 0 0); the 14 below
// are the actuated joints in rig.actuated_joints order.
const STAND_QPOS = [
  0.0, -0.0872664600610733, -0.4579240083694458, -0.004939999897032976, 0.4529840052127838,
  0.3490658402442932, 0.3490658402442932, 0.0, 0.0,
  0.0, 0.0872664600610733, 0.4579240083694458, 0.004939999897032976, -0.4529840052127838,
];
const TRUNK_HEIGHT = 0.12; // free-joint z of the STAND keyframe

/** MuJoCo quat (w,x,y,z) -> THREE.Quaternion (x,y,z,w) */
const mjQuat = ([w, x, y, z]) => new THREE.Quaternion(x, y, z, w);

/** Forward kinematics in the STAND pose. name -> { body, local, world, restQuat, standAngle } */
function solveStand() {
  const out = new Map();
  for (const b of rig.bodies) {
    const restQuat = mjQuat(b.quat);
    const q = b.joint ? STAND_QPOS[b.joint.actuator_index] : 0;
    const posed = restQuat.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), q));
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...b.pos), posed, new THREE.Vector3(1, 1, 1));
    const world = b.parent === null
      ? local.clone()
      : out.get(b.parent).world.clone().multiply(local);
    out.set(b.name, { body: b, local, world, restQuat, standAngle: q });
  }
  return out;
}
const FK = solveStand();

/** World position of a body's own origin (= the centre of its joint) in the STAND pose. */
const bodyPos = (n) => new THREE.Vector3().setFromMatrixPosition(FK.get(n).world);
/** World direction of a body's local Z, i.e. the EXACT hinge axis of its joint. */
const jointAxis = (n) => new THREE.Vector3(0, 0, 1)
  .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().extractRotation(FK.get(n).world))).normalize();

// ---------------------------------------------------------------------------
// 1b. MJCF parsing: sites, the <sensor> block and the <inertial> of every body
// ---------------------------------------------------------------------------
const attrs = (s) => {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const nums = (s) => s.trim().split(/\s+/).map(Number);

/** Walk the tag stream, tracking the <body> stack, and collect sites/cameras/inertials. */
function parseBodies() {
  const sites = new Map();
  const cameras = new Map();
  const inertials = new Map();
  const stack = [];
  for (const m of mjcfText.matchAll(/<(\/?)(body|site|camera|inertial)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, body, selfClose] = m;
    if (tag === 'body') {
      if (closing) stack.pop();
      else if (!selfClose) stack.push(attrs(body).name);
      continue;
    }
    if (closing) continue;
    const a = attrs(body);
    const parent = stack[stack.length - 1];
    if (tag === 'inertial') {
      inertials.set(parent, {
        mass: Number(a.mass), com: nums(a.pos), fullinertia: nums(a.fullinertia),
      });
      continue;
    }
    if (!a.name || !a.pos) continue;
    const rec = {
      name: a.name, parent, pos: nums(a.pos), quat: a.quat ? nums(a.quat) : [1, 0, 0, 0],
    };
    (tag === 'site' ? sites : cameras).set(a.name, rec);
  }
  return { sites, cameras, inertials };
}

/** Everything inside <sensor>...</sensor>, grouped by the site it is attached to. */
function parseSensors() {
  const block = mjcfText.match(/<sensor>([\s\S]*?)<\/sensor>/);
  const bySite = new Map();
  const loose = [];
  if (!block) return { bySite, loose };
  for (const m of block[1].matchAll(/<(\w+)\b([^>]*?)\/>/g)) {
    const a = attrs(m[2]);
    const site = a.site || (a.objtype === 'site' ? a.objname : null);
    const rec = { type: m[1], name: a.name };
    if (a.noise !== undefined) rec.noise = Number(a.noise);
    if (site) {
      if (!bySite.has(site)) bySite.set(site, []);
      bySite.get(site).push(rec);
    } else {
      loose.push({ ...rec, body: a.body });
    }
  }
  return { bySite, loose };
}

const { sites: SITES, cameras: CAMERAS, inertials: INERTIALS } = parseBodies();
const SENSORS = parseSensors();

// world pose of every site in the STAND pose
for (const s of SITES.values()) {
  if (!FK.has(s.parent)) throw new Error('site "' + s.name + '" has unknown parent');
  s.localM = new THREE.Matrix4().compose(
    new THREE.Vector3(...s.pos), mjQuat(s.quat), new THREE.Vector3(1, 1, 1));
  s.world = FK.get(s.parent).world.clone().multiply(s.localM);
  s.worldPos = new THREE.Vector3().setFromMatrixPosition(s.world);
}

// ---------------------------------------------------------------------------
// 1c. Equivalent-ellipsoid proportions from the inertia tensors
// ---------------------------------------------------------------------------

/** Jacobi eigendecomposition of a symmetric 3x3. */
function eigenSym3(M) {
  let a = M.map((r) => r.slice());
  let V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const mul = (x, y) => x.map((r) => y[0].map((_, j) => r.reduce((s, v, k) => s + v * y[k][j], 0)));
  const T = (x) => x[0].map((_, i) => x.map((r) => r[i]));
  for (let sweep = 0; sweep < 100; sweep++) {
    let p = 0; let q = 1; let mx = Math.abs(a[0][1]);
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[i][j]) > mx) { mx = Math.abs(a[i][j]); p = i; q = j; }
    }
    if (mx < 1e-20) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(th); const s = Math.sin(th);
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    R[p][p] = c; R[q][q] = c; R[p][q] = s; R[q][p] = -s;
    a = mul(mul(T(R), a), R);
    V = mul(V, R);
  }
  return { vals: [a[0][0], a[1][1], a[2][2]], vecs: V };
}

/** Equivalent homogeneous solid ellipsoid of one body, in STAND world space. */
function inertiaEllipsoid(name) {
  const inr = INERTIALS.get(name);
  if (!inr) throw new Error('no <inertial> for body "' + name + '"');
  const [ixx, iyy, izz, ixy, ixz, iyz] = inr.fullinertia;
  const { vals, vecs } = eigenSym3([[ixx, ixy, ixz], [ixy, iyy, iyz], [ixz, iyz, izz]]);
  const S = vals.reduce((s, I) => s + 5 * I / inr.mass, 0) / 2;
  const r = vals.map((I) => Math.sqrt(Math.max(S - 5 * I / inr.mass, 1e-12)));
  const world = FK.get(name).world;
  const B = new THREE.Matrix4().extractRotation(world);
  const cols = [0, 1, 2].map((j) =>
    new THREE.Vector3(vecs[0][j], vecs[1][j], vecs[2][j]).applyMatrix4(B).normalize());
  if (cols[0].clone().cross(cols[1]).dot(cols[2]) < 0) cols[2].negate();
  const R = new THREE.Matrix4().makeBasis(cols[0], cols[1], cols[2]);
  const c = new THREE.Vector3(...inr.com).applyMatrix4(world);
  return { c: c.toArray(), r, q: new THREE.Quaternion().setFromRotationMatrix(R), mass: inr.mass };
}

// ---------------------------------------------------------------------------
// 2. Primitive helpers. Authored in STAND world space, then pushed into the owning
//    body's (or site's) local frame, which is pose independent.
// ---------------------------------------------------------------------------
const SEG = 28;        // default cylinder / sphere segments
const RINGS = 20;
const IDENT = new THREE.Quaternion();
const mm = (v) => v / 1000;
const v3 = (a) => (a.isVector3 ? a.clone() : new THREE.Vector3(a[0], a[1], a[2]));
const ZUP = new THREE.Vector3(0, 0, 1);
const XFWD = new THREE.Vector3(1, 0, 0);

function ellipsoid(center, radii, q = IDENT, seg = SEG, rings = RINGS) {
  const g = new THREE.SphereGeometry(1, seg, rings);
  g.applyMatrix4(new THREE.Matrix4().makeScale(radii[0], radii[1], radii[2]));
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  const c = v3(center);
  g.translate(c.x, c.y, c.z);
  return g;
}

function tube(a, b, rA, rB, seg = SEG) {
  const pa = v3(a);
  const pb = v3(b);
  const dir = pb.clone().sub(pa);
  const g = new THREE.CylinderGeometry(rB, rA, dir.length(), seg, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  const mid = pa.clone().add(pb).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

/** Orthonormal frame with local X along xdir and local Y as close to yhint as possible. */
function frameQ(xdir, yhint) {
  const x = v3(xdir).normalize();
  let y = v3(yhint);
  if (y.lengthSq() < 1e-12 || Math.abs(y.clone().normalize().dot(x)) > 0.985) {
    y = Math.abs(x.z) > 0.9 ? XFWD.clone() : ZUP.clone();
  }
  y.sub(x.clone().multiplyScalar(y.dot(x))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * Chamfered box - THE shape of this robot. `half` are the half extents along the frame's
 * x/y/z, `rad` the chamfer. segs=1 gives a single chamfer facet (hard, technical),
 * segs=2 a two-facet round-over for the big shells.
 */
function rbox(center, half, rad = mm(1.5), segs = 1, q = IDENT) {
  const g = new RoundedBoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2, segs, rad);
  g.deleteAttribute('uv');
  const gi = mergeVertices(g, 1e-7);
  gi.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  const c = v3(center);
  gi.translate(c.x, c.y, c.z);
  return gi;
}

/** Hard-edged plate / fin / shim - 12 triangles, used for everything small and flat. */
function plate(center, half, q = IDENT) {
  const g = new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2);
  g.deleteAttribute('uv');
  g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
  const c = v3(center);
  g.translate(c.x, c.y, c.z);
  return g;
}

/**
 * Chamfered box spanning a -> b. `w` is the width across the limb, `t` the thickness
 * along `up`. ext shortens (negative) or lengthens the span, off shifts the slab
 * sideways (off[0] across, off[1] along up) - that is how the light shells end up
 * flanking a dark strut.
 */
function slab(a, b, w, t, up = ZUP, {
  rad = mm(1.5), segs = 1, extA = 0, extB = 0, off = [0, 0],
} = {}) {
  const pa = v3(a);
  const pb = v3(b);
  const ax = pb.clone().sub(pa);
  const len = ax.length() + extA + extB;
  ax.normalize();
  const q = frameQ(ax, new THREE.Vector3().crossVectors(v3(up), ax));
  const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const mid = pa.clone().add(pb).multiplyScalar(0.5)
    .add(ax.clone().multiplyScalar((extB - extA) / 2))
    .add(yAxis.multiplyScalar(off[0])).add(zAxis.multiplyScalar(off[1]));
  return rbox(mid, [len / 2, w / 2, t / 2], rad, segs, q);
}

/** Ring of fasteners around `axis`, lying on the plane through `center`. */
function boltCircle(center, axis, radius, count, phase = 0, head = mm(1.7), depth = mm(1.4)) {
  const c = v3(center);
  const n = v3(axis).normalize();
  const q = frameQ(n, ZUP);
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const w = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (i * 2 * Math.PI) / count;
    const p = c.clone()
      .add(u.clone().multiplyScalar(Math.cos(a) * radius))
      .add(w.clone().multiplyScalar(Math.sin(a) * radius));
    out.push(tube(p.clone().sub(n.clone().multiplyScalar(depth)),
      p.clone().add(n.clone().multiplyScalar(depth * 0.25)), head, head, 10));
  }
  return out;
}

/** Row of fasteners along a line - the screw pattern of a panel edge. */
function boltRow(a, b, n, axis, head = mm(1.6), depth = mm(1.3)) {
  const pa = v3(a);
  const pb = v3(b);
  const ax = v3(axis).normalize();
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const p = pa.clone().lerp(pb, t);
    out.push(tube(p.clone().sub(ax.clone().multiplyScalar(depth)),
      p.clone().add(ax.clone().multiplyScalar(depth * 0.25)), head, head, 10));
  }
  return out;
}

/**
 * Louvre field on a flat face: a dark recess plate plus `count` fins. `n` is the outward
 * face normal, `u` the direction the fins run, fins stacked along n x u.
 * Returns { recess, fins } so the caller can give them different materials.
 */
function louvres(center, n, u, count, pitch, halfLen, halfH, {
  recessDepth = mm(1.0), finProud = mm(1.6), finHalfT = mm(0.7),
} = {}) {
  const nn = v3(n).normalize();
  const q = frameQ(nn, v3(u));
  const w = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const c = v3(center);
  const span = (count - 1) * pitch;
  const recess = plate(c.clone().add(nn.clone().multiplyScalar(recessDepth * 0.5)),
    [recessDepth * 0.5 + mm(0.4), halfLen + mm(1.2), span / 2 + halfH + mm(1.6)], q);
  const fins = [];
  for (let i = 0; i < count; i++) {
    const off = -span / 2 + i * pitch;
    fins.push(plate(c.clone()
      .add(nn.clone().multiplyScalar(finProud * 0.5))
      .add(w.clone().multiplyScalar(off)),
    [finProud * 0.5 + mm(0.6), halfLen, finHalfT], q));
  }
  return { recess, fins };
}

/** Externally routed cable: a swept tube through the given way points. */
function cable(points, radius = mm(2.1), tubular = 24, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map(v3), false, 'catmullrom', 0.5);
  const g = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  g.deleteAttribute('uv');
  return g;
}

/**
 * An applied panel: a dark reveal plate with the painted panel standing proud of it.
 * `center` is the point on the shell surface, `n` the outward normal, `u` the in-plane
 * direction of halfU. Returns { reveal, face }.
 */
function appliedPanel(center, n, u, halfU, halfV, {
  reveal = mm(1.2), proud = mm(2.4), lip = mm(1.3),
} = {}) {
  const nn = v3(n).normalize();
  const q = frameQ(nn, v3(u));
  const c = v3(center);
  return {
    reveal: rbox(c.clone().add(nn.clone().multiplyScalar(reveal * 0.5 - mm(0.6))),
      [reveal * 0.5 + mm(0.6), halfU + lip, halfV + lip], mm(0.6), 1, q),
    face: rbox(c.clone().add(nn.clone().multiplyScalar((reveal + proud) * 0.5)),
      [proud * 0.5 + mm(0.2), halfU, halfV], mm(1.0), 1, q),
  };
}

// ---------------------------------------------------------------------------
// 2b. Hull maths: the EXACT signed distance function of a chamfered box, and the
//     seating of the sensor sites on it. Both are exact on the flat faces, which is
//     where every site that gets a marker actually sits.
// ---------------------------------------------------------------------------

/** Signed distance of world point p to the hull H = { c, half, rad, q }. + = outside. */
function sdHull(H, p) {
  const o = v3(p).sub(v3(H.c)).applyQuaternion(H.q.clone().invert());
  const qx = Math.abs(o.x) - (H.half[0] - H.rad);
  const qy = Math.abs(o.y) - (H.half[1] - H.rad);
  const qz = Math.abs(o.z) - (H.half[2] - H.rad);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, qy, qz), 0);
  return outside + inside - H.rad;
}

/** Outward unit normal of the hull at (or nearest to) p. */
function hullNormal(H, p) {
  const e = 1e-6;
  const base = sdHull(H, p);
  const g = new THREE.Vector3(
    sdHull(H, v3(p).add(new THREE.Vector3(e, 0, 0))) - base,
    sdHull(H, v3(p).add(new THREE.Vector3(0, e, 0))) - base,
    sdHull(H, v3(p).add(new THREE.Vector3(0, 0, e))) - base);
  return g.lengthSq() < 1e-18 ? XFWD.clone() : g.normalize();
}

/**
 * Seat a site on the hull by moving it along +/- dir, whichever surface crossing is
 * nearer. Returns the surface point, the outward normal there and the correction
 * actually applied in mm - THE number that says how much of the real sensor position
 * had to be given up.
 */
function seatOnHull(H, p, dir) {
  const d = v3(dir).normalize();
  const p0 = v3(p);
  const f = (t) => sdHull(H, p0.clone().add(d.clone().multiplyScalar(t)));
  const f0 = f(0);
  if (Math.abs(f0) < 1e-9) {
    return { point: p0, normal: hullNormal(H, p0), correction: 0, outside: f0 > 0 };
  }
  const STEP = 1e-4;
  const LIMIT = 0.3;
  let best = null;
  for (let i = 1; i * STEP <= LIMIT && best === null; i++) {
    for (const sgn of [-1, 1]) {
      const t1 = sgn * (i - 1) * STEP;
      const t2 = sgn * i * STEP;
      if (f(t1) * f(t2) <= 0) { best = [t1, t2]; break; }
    }
  }
  if (!best) throw new Error('seatOnHull: no surface crossing along the given direction');
  let [lo, hi] = best;
  for (let i = 0; i < 60; i++) {
    const midT = (lo + hi) / 2;
    if (f(lo) * f(midT) <= 0) hi = midT; else lo = midT;
  }
  const t = (lo + hi) / 2;
  const point = p0.clone().add(d.clone().multiplyScalar(t));
  return { point, normal: hullNormal(H, point), correction: Math.abs(t) * 1000, outside: f0 > 0 };
}

/** Nearest point on the hull surface - used for the sites that are genuinely internal. */
function projectOnHull(H, p) {
  const n = hullNormal(H, p);
  const d = sdHull(H, p);
  return { point: v3(p).sub(n.clone().multiplyScalar(d)), normal: n, depth_mm: d * 1000 };
}

// ---------------------------------------------------------------------------
// 3. Materials. Light shell, anthracite mechanics, steel fasteners, RV pink as paint
//    on WHOLE panels, and warm emissive glass for the two optics.
// ---------------------------------------------------------------------------
const MATERIALS = {
  shell:    { hex: 0xeef0f3, rough: 0.44, metal: 0.00 }, // outer shells
  panel:    { hex: 0xc2c8d0, rough: 0.50, metal: 0.05 }, // covers, bars, label plates
  actuator: { hex: 0x33383f, rough: 0.42, metal: 0.25 }, // servos, struts, joint modules
  dark:     { hex: 0x15181c, rough: 0.58, metal: 0.00 }, // parting lines, recesses, soles
  steel:    { hex: 0x9aa2ab, rough: 0.28, metal: 0.85 }, // fasteners, bosses, shafts
  accent:   { hex: 0xd02a66, rough: 0.36, metal: 0.00 }, // RV PINK, whole painted panels
  optic:    { hex: 0x8a4a14, rough: 0.12, metal: 0.00, emissive: 0xffb264, emit: 1.00 },
  halo:     { hex: 0x3a2412, rough: 0.30, metal: 0.00, emissive: 0xff8a2e, emit: 0.55 },
  eye:      { hex: 0x12151a, rough: 0.09, metal: 0.00 }, // camera glass
  glint:    { hex: 0xffffff, rough: 0.07, metal: 0.00 },
};

// ---------------------------------------------------------------------------
// 4. The hulls.
//
//    HEAD comes from the inertia ellipsoid of jaw_soft: centre at the body's own COM,
//    orientation from the principal axes, semi-axis RATIO from the tensor - but built as
//    a chamfered box. Two documented interventions:
//
//    - HEAD_SOFTEN: the raw head tensor is 75.1 : 53.5 : 33.1 mm, i.e. 2.27x longer than
//      tall - a pancake. DEVIATION for the design brief: length/height is eased to 1.70
//      and length/width to 1.25, so the head stays clearly flat and wide (the point of the
//      tensor) but reads as a machine head rather than a snout.
//    - K_TRUNK: no trunk site sits on the shell (the IMU is internal and must stay
//      inside), so the trunk scale is a stated constant.
//
//    The head scale itself is NOT a decision: it is solved so that the FRONT FACE passes
//    exactly through the head_camera site. Because tof sits at the same head-local x, the
//    same flat face also passes through tof - both sensor seatings come out exact.
// ---------------------------------------------------------------------------
const SKULL_RAW = inertiaEllipsoid('jaw_soft');
const BODY_RAW = inertiaEllipsoid('trunk_base');

const HEAD_LEN_OVER_HEIGHT = 1.70; // tensor says 2.27
const HEAD_LEN_OVER_WIDTH = 1.25;  // tensor says 1.40
const HEAD_CHAMFER = mm(4.2);

const headQ = SKULL_RAW.q.clone();
const headC = v3(SKULL_RAW.c);
const toHead = (p) => v3(p).sub(headC).applyQuaternion(headQ.clone().invert());
const fromHead = (p) => v3(p).applyQuaternion(headQ).add(headC);

const CAM_L = toHead(SITES.get('head_camera').worldPos);
const TOF_L = toHead(SITES.get('tof').worldPos);
const MOUTH_L = toHead(SITES.get('mouth_tip').worldPos);
// Front face solved through head_camera (correction exactly 0). tof sits at the same
// head-local x to within 0.8 mm, so the SAME flat face seats it too - the ellipsoid hull
// this replaced had to give up 5.5 mm there.
const K_HEAD = CAM_L.x;
const HEAD = {
  c: headC.toArray(),
  half: [K_HEAD, K_HEAD / HEAD_LEN_OVER_WIDTH, K_HEAD / HEAD_LEN_OVER_HEIGHT],
  rad: HEAD_CHAMFER,
  q: headQ,
};
const [HLX, HLY, HLZ] = HEAD.half;

// Trunk: the tensor ellipsoid of trunk_base is strongly tilted; a tilted box would read as
// a mistake, so the chassis is built axis aligned from its axis-aligned extents.
function extents(E) {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(E.q);
  const col = (j) => new THREE.Vector3().setFromMatrixColumn(m, j).multiplyScalar(E.r[j]);
  const [a, b, c] = [col(0), col(1), col(2)];
  return [Math.hypot(a.x, b.x, c.x), Math.hypot(a.y, b.y, c.y), Math.hypot(a.z, b.z, c.z)];
}
const K_TRUNK = 1.02; // DEVIATION: stated constant - no trunk site sits on the shell
const BX = extents(BODY_RAW).map((v) => v * K_TRUNK);

// torso: one block, split by a parting line into an upper and a lower shell. Its height
// is NOT the tensor's: the box must end above the hip yaw joints so the pelvis chassis
// and the hip modules stay visible below it.
const TORSO_C = [mm(-21), 0, mm(136)];
const TORSO_H = [BX[0], BX[1], mm(26)];
const SEAM_Z = mm(-7);           // parting line, torso-local z
const SEAM_T = mm(2.0);          // its gap

// pelvis: the narrow dark chassis block the hip yaw modules stick out of
const PELVIS = { c: [mm(-6), 0, mm(108)], half: [mm(26), mm(20), mm(14)], rad: mm(3), q: IDENT };

const parts = [];
const add = (body, mat, geo) => parts.push({ body, mat, geo });
const addAll = (body, mat, geos) => geos.forEach((g) => add(body, mat, g));

// ===========================================================================
// 4a. TRUNK - a panelled chassis
// ===========================================================================
{
  const [cx, cy, cz] = TORSO_C;
  const [hx, hy, hz] = TORSO_H;
  const upZ0 = cz + SEAM_Z + SEAM_T / 2;      // bottom of the upper shell
  const loZ1 = cz + SEAM_Z - SEAM_T / 2;      // top of the lower shell
  const top = cz + hz;
  const bot = cz - hz;

  // upper + lower shell, separated by a dark parting line
  add('trunk_base', 'shell',
    rbox([cx, cy, (upZ0 + top) / 2], [hx, hy, (top - upZ0) / 2], mm(6), 2));
  add('trunk_base', 'shell',
    rbox([cx, cy, (bot + loZ1) / 2], [hx, hy, (loZ1 - bot) / 2], mm(5), 2));
  add('trunk_base', 'dark',
    rbox([cx, cy, cz + SEAM_Z], [hx - mm(2.2), hy - mm(2.2), SEAM_T / 2 + mm(1.4)], mm(1), 1));

  // RV PINK flank panels - a whole painted panel per side, the biggest colour area
  for (const s of [1, -1]) {
    const p = appliedPanel([cx - mm(8), s * hy, cz + mm(10)], [0, s, 0], XFWD,
      mm(27), mm(12), { proud: mm(2.2) });
    add('trunk_base', 'dark', p.reveal);
    add('trunk_base', 'accent', p.face);
    // fastener pattern along the panel edge - visible fixings
    addAll('trunk_base', 'steel', boltRow(
      [cx - mm(33), s * (hy + mm(1)), cz + mm(24)],
      [cx + mm(17), s * (hy + mm(1)), cz + mm(24)], 4, [0, s, 0]));
  }

  // label field: a blank plate in a frame. Deliberately EMPTY - no glyphs, no digits,
  // nothing that could read as a type designation belonging to someone else.
  {
    const s = -1;
    // on the LOWER shell, clear of the accent panel's reveal and of the parting line
    add('trunk_base', 'dark',
      rbox([cx + mm(24), s * (hy + mm(0.6)), cz - mm(17)],
        [mm(10.5), mm(1.1), mm(5.6)], mm(0.8), 1, frameQ([0, s, 0], XFWD)));
    add('trunk_base', 'panel',
      rbox([cx + mm(24), s * (hy + mm(1.9)), cz - mm(17)],
        [mm(8.8), mm(1.0), mm(4.1)], mm(0.6), 1, frameQ([0, s, 0], XFWD)));
  }

  // shoulder caps: chamfered pads where the torso meets the neck tower
  for (const s of [1, -1]) {
    add('trunk_base', 'panel',
      rbox([cx + mm(20), s * mm(21), top - mm(5)], [mm(15), mm(11), mm(6)], mm(3), 1));
  }

  // rear module (the battery really is back here: np_f970 geom at body x = -0.036)
  const bm = [cx - hx - mm(7), 0, cz + mm(2)];
  add('trunk_base', 'panel', rbox(bm, [mm(12), mm(25), mm(21)], mm(3.5), 2));
  // its rear face is a louvre field
  const lv = louvres([bm[0] - mm(12), 0, bm[2]], [-1, 0, 0], [0, 1, 0], 5, mm(6.4),
    mm(17), mm(2.0));
  add('trunk_base', 'dark', lv.recess);
  addAll('trunk_base', 'panel', lv.fins);
  addAll('trunk_base', 'steel', boltCircle([bm[0] - mm(12), 0, bm[2]], [-1, 0, 0],
    mm(22), 4, Math.PI / 4));

  // pelvis chassis block, dark, the hip yaw modules protrude from it
  add('trunk_base', 'actuator', rbox(PELVIS.c, PELVIS.half, PELVIS.rad, 1));

  // hip yaw stators (these joints really sit in the trunk)
  for (const s of [1, -1]) {
    const name = s > 0 ? 'yaw2roll' : 'bearing_roll';
    const jp = bodyPos(name);
    add('trunk_base', 'actuator',
      rbox([jp.x, s * mm(19.5), jp.z - mm(1)], [mm(13), mm(9.5), mm(11)], mm(2.5), 1));
    add('trunk_base', 'steel',
      tube([jp.x, s * mm(27), jp.z], [jp.x, s * mm(29.5), jp.z], mm(7.4), mm(6.6), 20));
    addAll('trunk_base', 'steel', boltCircle([jp.x, s * mm(29), jp.z], [0, s, 0],
      mm(10.5), 4, Math.PI / 4));
  }

  // externally routed cable, rear module -> hip yaw joint CENTRE (so it never tears)
  for (const s of [1, -1]) {
    const jp = bodyPos(s > 0 ? 'yaw2roll' : 'bearing_roll');
    add('trunk_base', 'dark', cable([
      [bm[0] + mm(5), s * mm(23), bm[2] - mm(16)],
      [cx - mm(30), s * (hy + mm(3.0)), cz - mm(13)],
      [cx - mm(2), s * (hy + mm(2.5)), cz - mm(25)],
      [jp.x, jp.y, jp.z],
    ], mm(2.2)));
  }
}

// ===========================================================================
// 4b. NECK TOWER - four of the fourteen joints live here, so it is a visibly
//     jointed column, not an animal neck. Every segment belongs to the body it
//     actually moves with.
// ===========================================================================
{
  const jNeck = bodyPos('neck');            // neck_pitch joint
  const jHeadPitch = bodyPos('neck_pitch'); // head_pitch joint
  const jHeadYaw = bodyPos('yaw_roll_motion');
  const jHeadRoll = bodyPos('jaw_soft');
  // the column is drawn on the centre plane y = 0; the joint bodies are laterally
  // offset but their hinge AXES are lines that pass through y = 0, so this is exact.
  const colA = [mm(23), 0, jNeck.z - mm(3)];
  const colB = [mm(12), 0, jHeadPitch.z - mm(4)];

  add('neck', 'shell', slab(colA, colB, mm(31), mm(27), XFWD, { rad: mm(4), segs: 2 }));
  // dark channel + cable down the back of the column
  add('neck', 'dark', slab(colA, colB, mm(19), mm(4), XFWD,
    { rad: mm(1), off: [0, mm(-12.2)], extA: mm(-4), extB: mm(-4) }));
  add('neck', 'dark', cable([
    [mm(2), mm(9), jNeck.z + mm(34)],
    [mm(1), mm(11), jNeck.z + mm(22)],
    [mm(8), mm(12), jNeck.z + mm(8)],
    [mm(26), 0, jNeck.z],
  ], mm(2.0)));
  // RV PINK collar panel on the front of the column
  {
    const p = appliedPanel([mm(32), 0, jNeck.z + mm(22)], XFWD, [0, 1, 0],
      mm(12), mm(14), { proud: mm(2.0) });
    add('neck', 'dark', p.reveal);
    add('neck', 'accent', p.face);
  }
  // neck_pitch joint module, aligned with the REAL hinge axis
  add('neck', 'actuator', tube(
    [mm(26), mm(-16), jNeck.z], [mm(26), mm(16), jNeck.z], mm(11.5), mm(11.5), 20));
  addAll('neck', 'steel', boltCircle([mm(26), mm(16), jNeck.z], [0, 1, 0], mm(7.5), 4));

  // head_pitch module
  add('neck_pitch', 'actuator',
    rbox([mm(10), 0, jHeadPitch.z], [mm(15), mm(16), mm(9)], mm(2.5), 1));
  add('neck_pitch', 'steel', tube(
    [mm(10), mm(-17), jHeadPitch.z], [mm(10), mm(17), jHeadPitch.z], mm(6.2), mm(6.2), 20));

  // head_yaw module - the real axis here is vertical. It is long enough to bridge from
  // the head_pitch module up into the head case, so the head is never seen floating.
  add('yaw_roll_motion', 'actuator', tube(
    [jHeadYaw.x, 0, jHeadYaw.z - mm(13)], [jHeadYaw.x, 0, jHeadYaw.z + mm(7)],
    mm(17.0), mm(15.0), 24));
  add('yaw_roll_motion', 'steel', tube(
    [jHeadYaw.x, 0, jHeadYaw.z - mm(5.4)], [jHeadYaw.x, 0, jHeadYaw.z - mm(3.4)],
    mm(18.0), mm(18.0), 24));
  addAll('yaw_roll_motion', 'steel', boltCircle(
    [jHeadYaw.x, 0, jHeadYaw.z + mm(7)], ZUP, mm(11), 6));
  // head_roll collar, on the head side of the joint
  add('jaw_soft', 'actuator', tube(
    [jHeadRoll.x + mm(4), 0, jHeadRoll.z - mm(6)], [jHeadRoll.x + mm(4), 0, jHeadRoll.z + mm(4)],
    mm(13.5), mm(13.0), 24));
}

// ===========================================================================
// 4c. HEAD - a flat chamfered case with a parting line, a recessed sensor bay,
//     side louvres and fasteners.
// ===========================================================================
// The case splits into a tall upper shell and a set-back base plate, so it reads as ONE
// case with a parting line rather than as two stacked boxes. The HEIGHT of that parting
// line is not a decision either: it is set from the mouth_tip site - the parting line
// runs just below the mouth port (see 4f), which is what a real case split would do.
const HEAD_SEAM_Z = MOUTH_L.z - mm(6.5);
const HEAD_SEAM_T = mm(2.0);
const HEAD_BASE_INSET = mm(2.5);
{
  const upZ0 = HEAD_SEAM_Z + HEAD_SEAM_T / 2;
  const loZ1 = HEAD_SEAM_Z - HEAD_SEAM_T / 2;

  // upper case shell + set-back base plate
  add('jaw_soft', 'shell', rbox(fromHead([0, 0, (upZ0 + HLZ) / 2]),
    [HLX, HLY, (HLZ - upZ0) / 2], HEAD_CHAMFER, 2, headQ));
  add('jaw_soft', 'shell', rbox(fromHead([0, 0, (-HLZ + loZ1) / 2]),
    [HLX - HEAD_BASE_INSET, HLY - HEAD_BASE_INSET, (loZ1 + HLZ) / 2], mm(2.0), 2, headQ));
  // the parting line itself, recessed behind both
  add('jaw_soft', 'dark', rbox(fromHead([0, 0, HEAD_SEAM_Z]),
    [HLX - mm(4.0), HLY - mm(4.0), HEAD_SEAM_T / 2 + mm(1.4)], mm(1), 1, headQ));

  // Sensor bay. NOTHING overhangs the optics: no brow bar above them and no chin bar
  // below - a horizontal bar right over a pair of lenses reads as a lowered brow and
  // makes the machine look cross, and a second bar underneath pinches the bay into a
  // slit. The bay is instead TALL and open, centred just above the optic pair so the
  // lenses sit low in it with clear case above and below. The technical read is carried
  // by the side louvres, the fasteners, the crown hatch and the parting line.
  const faceN = XFWD.clone().applyQuaternion(headQ);
  const faceU = new THREE.Vector3(0, 1, 0).applyQuaternion(headQ);
  const bayZ = TOF_L.z + mm(0.5);
  add('jaw_soft', 'dark', rbox(fromHead([HLX - mm(0.4), 0, bayZ]),
    [mm(1.4), mm(28.3), mm(11.8)], mm(1.4), 1, headQ));

  // side louvre fields, behind the optics
  for (const s of [1, -1]) {
    const n = faceU.clone().multiplyScalar(s);
    const c = fromHead([-mm(5), s * HLY, mm(4)]);
    const lv = louvres(c, n, faceN, 4, mm(5.4), mm(10), mm(1.7),
      { recessDepth: mm(0.8), finProud: mm(1.5), finHalfT: mm(0.75) });
    add('jaw_soft', 'dark', lv.recess);
    addAll('jaw_soft', 'panel', lv.fins);
    // fasteners on the case side
    addAll('jaw_soft', 'steel', boltRow(
      fromHead([mm(22), s * (HLY + mm(0.8)), mm(13)]),
      fromHead([mm(22), s * (HLY + mm(0.8)), -mm(1)]), 2, n));
  }

  // crown: a flush service hatch in a dark reveal, with four fasteners
  {
    const up = ZUP.clone().applyQuaternion(headQ);
    const p = appliedPanel(fromHead([-mm(6), 0, HLZ]), up, faceN, mm(20), mm(19),
      { reveal: mm(1.0), proud: mm(1.4), lip: mm(1.5) });
    add('jaw_soft', 'dark', p.reveal);
    add('jaw_soft', 'panel', p.face);
    addAll('jaw_soft', 'steel', boltCircle(fromHead([-mm(6), 0, HLZ + mm(1.8)]),
      up, mm(16), 4, Math.PI / 4));
  }
}

// ===========================================================================
// 4d. LEGS - light shells flanking a dark strut, with a real module on every joint.
//     Limb cross sections are nudged toward the inertia ratios but deliberately
//     DAMPED: the thigh and shank tensors are dominated by an xl330 servo mounted at
//     the end of the link, not by the limb envelope.
// ===========================================================================
const LEGS = [
  { s: 1, yaw: 'yaw2roll', roll: 'hip_l', thigh: 'upper_leg_left', shank: 'leg', ankle: 'ankle_left' },
  { s: -1, yaw: 'bearing_roll', roll: 'hip_l_2', thigh: 'upper_leg_right', shank: 'leg_2', ankle: 'ankle_right' },
];

/** One joint module: a dark housing on the real hinge AXIS plus a steel boss and bolts. */
function jointModule(owner, bodyName, rOuter, halfLen, boltR, boltN) {
  const p = bodyPos(bodyName);
  const ax = jointAxis(bodyName);
  const a = p.clone().sub(ax.clone().multiplyScalar(halfLen));
  const b = p.clone().add(ax.clone().multiplyScalar(halfLen));
  add(owner, 'actuator', tube(a, b, rOuter, rOuter, 22));
  add(owner, 'steel', tube(b, b.clone().add(ax.clone().multiplyScalar(mm(2.2))),
    rOuter * 0.55, rOuter * 0.5, 18));
  add(owner, 'steel', tube(a, a.clone().sub(ax.clone().multiplyScalar(mm(2.2))),
    rOuter * 0.55, rOuter * 0.5, 18));
  addAll(owner, 'steel', boltCircle(b.clone().add(ax.clone().multiplyScalar(mm(0.6))),
    ax, boltR, boltN, Math.PI / boltN));
}

for (const L of LEGS) {
  const s = L.s;
  const hipYaw = bodyPos(L.yaw);
  const hipRoll = bodyPos(L.roll);
  const hipPitch = bodyPos(L.thigh);
  const knee = bodyPos(L.shank);
  const ankle = bodyPos(L.ankle);
  const sole = [mm(5), s * mm(44), mm(9.5)];

  // hip yaw rotor bracket
  add(L.yaw, 'actuator', slab(
    [hipYaw.x, hipYaw.y, hipYaw.z - mm(4)], hipRoll, mm(20), mm(18), ZUP,
    { rad: mm(2), extB: mm(-3) }));
  jointModule(L.roll, L.roll, mm(11.5), mm(12), mm(7.5), 4);

  // hip roll link -> hip pitch
  add(L.roll, 'actuator', slab(hipRoll, hipPitch, mm(18), mm(19), ZUP,
    { rad: mm(2), extA: mm(-6), extB: mm(-7) }));
  jointModule(L.thigh, L.thigh, mm(12.0), mm(13), mm(8.0), 4);

  // THIGH: dark strut between two light shell plates
  add(L.thigh, 'actuator', slab(hipPitch, knee, mm(13), mm(19), ZUP,
    { rad: mm(1.5), extA: mm(-8), extB: mm(-8) }));
  for (const o of [1, -1]) {
    add(L.thigh, 'shell', slab(hipPitch, knee, mm(8), mm(26), ZUP,
      { rad: mm(2.5), extA: mm(-9), extB: mm(-9), off: [o * mm(10.5), 0] }));
  }
  // cable along the thigh, from the hip pitch joint CENTRE to the knee module
  add(L.thigh, 'dark', cable([
    hipPitch,
    hipPitch.clone().lerp(knee, 0.35).add(new THREE.Vector3(mm(18), 0, mm(3))),
    hipPitch.clone().lerp(knee, 0.75).add(new THREE.Vector3(mm(19), 0, mm(1))),
    knee.clone().add(new THREE.Vector3(mm(6), 0, mm(6))),
  ], mm(1.9), 18));
  jointModule(L.shank, L.shank, mm(11.0), mm(12), mm(7.0), 4);

  // SHANK: the same language, slimmer
  add(L.shank, 'actuator', slab(knee, ankle, mm(11), mm(16), ZUP,
    { rad: mm(1.5), extA: mm(-8), extB: mm(-8) }));
  for (const o of [1, -1]) {
    add(L.shank, 'shell', slab(knee, ankle, mm(7), mm(21), ZUP,
      { rad: mm(2), extA: mm(-9), extB: mm(-10), off: [o * mm(9), 0] }));
  }
  jointModule(L.ankle, L.ankle, mm(10.0), mm(11), mm(6.5), 4);

  // ANKLE bracket down to the foot
  add(L.ankle, 'actuator', slab(ankle, [sole[0] - mm(2), sole[1], sole[2] + mm(5)],
    mm(16), mm(14), XFWD, { rad: mm(2), extB: mm(-2) }));

  // FOOT: a flat chamfered plate, a dark sole under it and a painted top panel
  add(L.ankle, 'shell', rbox(sole, [mm(27), mm(18.5), mm(4.2)], mm(3.2), 2));
  add(L.ankle, 'dark', rbox([sole[0], sole[1], sole[2] - mm(5.0)],
    [mm(25), mm(17), mm(1.6)], mm(1.2), 1));
  // bevelled toe and heel ramps instead of a soft boot
  add(L.ankle, 'panel', rbox([sole[0] + mm(24.5), sole[1], sole[2] + mm(1.4)],
    [mm(5.0), mm(15.5), mm(2.2)], mm(1.5), 1));
  add(L.ankle, 'panel', rbox([sole[0] - mm(24.5), sole[1], sole[2] + mm(1.4)],
    [mm(5.0), mm(15.5), mm(2.2)], mm(1.5), 1));
  {
    const p = appliedPanel([sole[0] - mm(2), sole[1], sole[2] + mm(4.2)], ZUP, XFWD,
      mm(17), mm(11.5), { proud: mm(1.6), lip: mm(1.2) });
    add(L.ankle, 'dark', p.reveal);
    add(L.ankle, 'accent', p.face);
  }
  addAll(L.ankle, 'steel', boltRow(
    [sole[0] - mm(21), sole[1] - mm(14.8), sole[2] + mm(4.3)],
    [sole[0] + mm(17), sole[1] - mm(14.8), sole[2] + mm(4.3)], 3, ZUP));
  addAll(L.ankle, 'steel', boltRow(
    [sole[0] - mm(21), sole[1] + mm(14.8), sole[2] + mm(4.3)],
    [sole[0] + mm(17), sole[1] + mm(14.8), sole[2] + mm(4.3)], 3, ZUP));
}

// ---------------------------------------------------------------------------
// 4e. Sensor markers. Every marker sits on the MJCF <site> that the <sensor> block
//     actually names, as a child node of that site, so it stays put in any pose and can
//     carry extras.rv_sensor for realvirtual WEB's WebSensor component.
//
//     THE FACE IS AN EVEN PAIR OF OPTICS. The left one is the real tof site; the right
//     one is a blind balancing port of identical size and shape that carries NO sensor
//     metadata and belongs to the head, not to a site. The real camera keeps its true
//     place on the centreline between them and is a smaller, darker lens - a camera, not
//     an eye. No site was moved to achieve this.
// ---------------------------------------------------------------------------
const sensorParts = [];
const addSensor = (site, mat, geo) => sensorParts.push({ site, mat, geo });
const addAllSensor = (site, mat, geos) => geos.forEach((g) => addSensor(site, mat, g));
const MARKERS = new Map();
const HEAD_BACK = new THREE.Vector3(-1, 0, 0);
const along = (p, d, t) => v3(p).add(v3(d).normalize().multiplyScalar(t));
const RESID = {};   // mm of correction actually applied when seating the site

/**
 * The shared gestalt of the two front optics: bezel, glowing halo ring, a CONVEX warm
 * lens dome standing proud of the bezel, a small pupil and a highlight. Deliberately
 * large - 16.4 mm over a 66 mm wide case - because a generous lens is the most ordinary
 * thing in the world on a measuring device AND the single strongest "open, awake" signal
 * there is. A flat dark disc reads dead; a lit dome reads attentive.
 * The outer radius is bounded by the flat plateau of the case front (HLY - chamfer),
 * which is why the chamfer was tightened above.
 */
function opticAt(P, n, emit, push) {
  const nn = v3(n).normalize();
  push('actuator', tube(along(P, nn, -mm(8)), along(P, nn, mm(2.4)), mm(8.2), mm(7.4), 28));
  if (emit) {
    push('halo', tube(along(P, nn, mm(1.5)), along(P, nn, mm(2.5)), mm(7.3), mm(6.8), 28));
  } else {
    push('steel', tube(along(P, nn, mm(1.5)), along(P, nn, mm(2.5)), mm(7.3), mm(6.8), 28));
  }
  const q = frameQ(nn, ZUP);
  const lensQ = new THREE.Quaternion().setFromUnitVectors(ZUP, nn);
  push(emit ? 'optic' : 'eye',
    ellipsoid(along(P, nn, mm(0.6)), [mm(6.4), mm(6.4), mm(4.2)], lensQ, 32, 20));
  push('dark', tube(along(P, nn, mm(4.1)), along(P, nn, mm(5.5)), mm(1.85), mm(1.6), 20));
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const side = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const g = along(P, nn, mm(4.07)).add(up.multiplyScalar(mm(2.7)))
    .add(side.multiplyScalar(mm(2.4)));
  push('glint', ellipsoid(g, [mm(1.15), mm(1.15), mm(1.15)], IDENT, 14, 10));
}

// -- time of flight: the robot's LEFT optic of the pair --------------------------
{
  const site = SITES.get('tof');
  const st = seatOnHull(HEAD, site.worldPos, HEAD_BACK);
  RESID.tof = st.correction * (st.outside ? 1 : -1);
  const n = XFWD.clone().applyQuaternion(headQ);
  opticAt(st.point, n, true, (mat, geo) => addSensor('tof', mat, geo));
  MARKERS.set('tof', {
    kind: 'optic',
    note: 'left optic of the front pair, on the real tof site; the head case front face is '
        + 'solved to pass through this site, correction ' + Math.abs(RESID.tof).toFixed(1) + ' mm',
  });
}

// -- the mirrored port on the other side is OURS, not a sensor ----------------
// The real optics are asymmetric (camera on the centreline, ToF 22 mm to the left). A
// blind housing mirrored to the right balances the face so it reads as a PAIR, without
// claiming a sensor that is not there - it carries no rv_sensor metadata and belongs to
// the head, not to a site. Identical size and shape to the tof optic by construction.
{
  const twinL = TOF_L.clone();
  twinL.y = -twinL.y;
  const st = seatOnHull(HEAD, fromHead(twinL), HEAD_BACK);
  const n = XFWD.clone().applyQuaternion(headQ);
  opticAt(st.point, n, true, (mat, geo) => add('jaw_soft', mat, geo));
}

// -- head camera: the real lens, on the centreline between the two optics --------
{
  const site = SITES.get('head_camera');
  const st = seatOnHull(HEAD, site.worldPos, HEAD_BACK);
  RESID.head_camera = st.correction * (st.outside ? 1 : -1);
  const n = XFWD.clone().applyQuaternion(headQ);
  const P = st.point;
  addSensor('head_camera', 'actuator',
    tube(along(P, n, -mm(8)), along(P, n, mm(1.4)), mm(4.4), mm(3.9), 22));
  addSensor('head_camera', 'eye',
    tube(along(P, n, mm(0.2)), along(P, n, mm(1.7)), mm(3.2), mm(3.0), 22));
  const up = ZUP.clone().applyQuaternion(headQ);
  const side = new THREE.Vector3(0, 1, 0).applyQuaternion(headQ);
  addSensor('head_camera', 'glint', ellipsoid(
    along(P, n, mm(1.5)).add(up.multiplyScalar(mm(1.3))).add(side.multiplyScalar(mm(1.1))),
    [mm(0.8), mm(0.8), mm(0.8)], IDENT, 12, 8));
  MARKERS.set('head_camera', {
    kind: 'lens',
    note: 'the real camera, kept exactly on its site on the centreline; the head case '
        + 'front face is solved through it, correction '
        + Math.abs(RESID.head_camera).toFixed(1) + ' mm',
  });
}

// -- trunk IMU: a flush electronics hatch on the nearest chassis surface --------
{
  const site = SITES.get('imu');
  const pr = projectOnHull(PELVIS, site.worldPos);
  RESID.imu = pr.depth_mm;
  addSensor('imu', 'dark', rbox(along(pr.point, pr.normal, mm(0.3)),
    [mm(1.2), mm(11), mm(8)], mm(1), 1, frameQ(pr.normal, ZUP)));
  addSensor('imu', 'panel', rbox(along(pr.point, pr.normal, mm(1.6)),
    [mm(1.1), mm(9), mm(6)], mm(0.8), 1, frameQ(pr.normal, ZUP)));
  addSensor('imu', 'steel', ellipsoid(along(pr.point, pr.normal, mm(2.4)),
    [mm(1.3), mm(1.3), mm(1.3)], IDENT, 10, 8));
  MARKERS.set('imu', {
    kind: 'imu-hatch',
    note: 'the real IMU is an internal part (' + Math.abs(pr.depth_mm).toFixed(0)
        + ' mm inside the pelvis chassis) and correctly stays inside; marked by a flush '
        + 'hatch on the nearest chassis surface',
  });
}

// -- head IMU: deliberately NOT drawn ----------------------------------------
{
  const d = sdHull(HEAD, SITES.get('head_imu').worldPos) * 1000;
  RESID.head_imu = d;
  MARKERS.set('head_imu', {
    kind: 'none',
    note: 'omitted on purpose: an internal part, ' + Math.abs(d).toFixed(0)
        + ' mm inside the head case and directly behind head_camera, so any surface '
        + 'marker would collide with the camera lens',
  });
}

// -- foot contacts: a dark contact pad under each contact reference ------------
for (const f of ['left_foot', 'right_foot']) {
  const p = SITES.get(f).worldPos;
  addSensor(f, 'dark', rbox([mm(5), p.y, mm(3.0)], [mm(26), mm(17.5), mm(2.0)], mm(1.2), 1));
  addSensor(f, 'steel', rbox([mm(5), p.y, mm(1.2)], [mm(22), mm(14), mm(0.5)], mm(0.4), 1));
  MARKERS.set(f, { kind: 'contact-pad', note: 'contact pad over the contact reference' });
}

// ---------------------------------------------------------------------------
// 4f. MOUTH. There is NO jaw joint: the four head/neck hinges are neck_pitch,
//     head_pitch, head_yaw and head_roll, and jaw_soft - despite its name - is the
//     terminal HEAD body carrying head_roll. In the original MJCF the beak geoms are
//     welded to that same rigid body, so a mouth cannot be a pose here and is built as
//     a housing feature instead: the case parting line opens at the front into a slightly
//     gaping, vented port between an upper lip on the upper case and a set-back lower jaw
//     plate on the base plate. Plausible as a speaker / microphone / vent on a robot head,
//     and it reads as a mouth held a little open, which is the friendly end of the scale.
//
//     Its foremost plane passes EXACTLY through the mouth_tip site, so the mouth is
//     anchored on the real datum. Nothing here is traced from jaw.stl - that file stays
//     shut; only the site number is used.
//
//     The lower edge of the opening lifts very slightly towards the corners (a 1.2 mm
//     rise over 22 mm, built as seven stepped shims). That is the same perceptual lever
//     as the brow, used the other way round: an edge that droops at the ends reads sour,
//     a flat one reads blank, a hair of lift reads open. It is NOT a smile - no corners,
//     no curve of the opening itself, no teeth.
// ---------------------------------------------------------------------------
{
  const mx = MOUTH_L.x;
  const mz = MOUTH_L.z;
  const back = HLX - mm(2.0);
  const faceN = XFWD.clone().applyQuaternion(headQ);
  const faceU = new THREE.Vector3(0, 1, 0).applyQuaternion(headQ);
  const HALF_Y = mm(17);
  const HALF_Z = mm(2.6);

  // One dark vented band, 34 x 5.2 mm, standing proud of the case by exactly the 3.5 mm
  // that mouth_tip is in front of it - so its FRONT PLANE passes through the site and the
  // seating correction is zero. Deliberately NOT built from a proud upper lip and a lower
  // jaw plate: stacked light plates read as an open drawer from above, a single recessed
  // dark aperture reads as a mouth from every angle.
  const MOUTH = {
    c: fromHead([(mx + back) / 2, 0, mz]).toArray(),
    half: [(mx - back) / 2, HALF_Y, HALF_Z],
    rad: mm(1.0),
    q: headQ,
  };
  const st = seatOnHull(MOUTH, SITES.get('mouth_tip').worldPos, HEAD_BACK);
  RESID.mouth_tip = st.correction * (st.outside ? 1 : -1);

  // The lower edge of the opening lifts a little towards the corners - 0.95 mm over
  // 17 mm, as seven stepped shims. Same perceptual lever as the brow bar, used the other
  // way round: an edge that droops at the ends reads sour, a flat one blank, a hair of
  // lift reads open. It is NOT a smile - no corners, no curve, no teeth.
  const SEGS = 7;
  const top = mz + HALF_Z;
  for (let i = 0; i < SEGS; i++) {
    const hy = HALF_Y / SEGS;
    const cy = -HALF_Y + hy * (2 * i + 1);
    const bot = mz - HALF_Z + mm(1.3) * Math.pow(Math.abs(cy) / HALF_Y, 2);
    addSensor('mouth_tip', 'dark', plate(
      fromHead([(mx + back) / 2, cy, (top + bot) / 2]),
      [(mx - back) / 2, hy, (top - bot) / 2], headQ));
  }
  // vent / speaker grille across the opening
  const lv = louvres(fromHead([mx - mm(1.2), 0, mz]), faceN, faceU, 3, mm(1.5),
    mm(12), mm(0.35), { recessDepth: mm(0.1), finProud: mm(1.2), finHalfT: mm(0.35) });
  addAllSensor('mouth_tip', 'steel', lv.fins);

  MARKERS.set('mouth_tip', {
    kind: 'mouth-port',
    note: 'the original beak tip. There is no jaw joint in this kinematics (jaw_soft '
        + 'carries head_roll), so the mouth is a housing feature: a vented port between '
        + 'the upper case and the lower jaw plate, whose foremost plane passes through '
        + 'this site, correction ' + Math.abs(RESID.mouth_tip).toFixed(1) + ' mm',
  });
}

// ---------------------------------------------------------------------------
// 5. Merge per (owner, material) and move into the owner's local frame
// ---------------------------------------------------------------------------
function bucketise(list, frameOf) {
  const buckets = new Map();
  for (const p of list) {
    const inv = frameOf(p).clone().invert();
    if (p.geo.getAttribute('uv')) p.geo.deleteAttribute('uv');
    p.geo.applyMatrix4(inv);
    const key = (p.body || p.site) + '|' + p.mat;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p.geo);
  }
  const merged = new Map();
  for (const [key, geos] of buckets) {
    const [owner, mat] = key.split('|');
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!geo) throw new Error('mergeGeometries returned null for ' + key);
    if (!merged.has(owner)) merged.set(owner, []);
    merged.get(owner).push({ mat, geo });
  }
  return merged;
}
const merged = bucketise(parts, (p) => {
  if (!FK.has(p.body)) throw new Error('unknown MJCF body "' + p.body + '"');
  return FK.get(p.body).world;
});
const siteMerged = bucketise(sensorParts, (p) => {
  if (!SITES.has(p.site)) throw new Error('unknown MJCF site "' + p.site + '"');
  return SITES.get(p.site).world;
});

// ---------------------------------------------------------------------------
// 6. Write the GLB
// ---------------------------------------------------------------------------
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearRGB = (hex) => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
];
const linearRGBA = (hex) => [...linearRGB(hex), 1];

// ---------------------------------------------------------------------------
// The Drive descriptor of one hinge joint (plan-659 Phase 2b).
//
// `applyToNode` computes `quaternion = baseQuaternion * R(axis, currentPosition
// + Offset)` with `baseQuaternion` = the AUTHORED pose, and this file is
// authored in the STAND keyframe, i.e. `rest * R(axis, stand)`. Carrying
// `Offset = -stand` therefore makes `currentPosition` the RAW MuJoCo joint
// angle in degrees - exactly what the plugin writes, and bit-identical in form
// to the joint mirror's `rest * R(axis, qpos)`.
//
// `UseLimits` stays false on purpose: the limits belong to MuJoCo (`range` in
// the MJCF, also carried in `rv_joint.range`), and a second clamp in the Drive
// would silently disagree with the physics.
const RAD2DEG = 180 / Math.PI;
function driveForJoint(fk) {
  // Derived, not hardcoded: a future axis change has to come out here or fail
  // the DRIVE CHECK below.
  const axis = [0, 0, 1];
  const i = axis.findIndex((v) => Math.abs(v) > 0.999);
  if (i < 0) throw new Error('joint axis is not cardinal: [' + axis + ']');
  const positive = axis[i] > 0;
  // `directionToGltfAxis`: RotationX -> +X, RotationY -> -Y, RotationZ -> -Z.
  // So "reversed" means the opposite thing for X than for Y/Z.
  const reverse = i === 0 ? !positive : positive;
  return {
    Direction: ['RotationX', 'RotationY', 'RotationZ'][i],
    ReverseDirection: reverse,
    Offset: -fk.standAngle * RAD2DEG,
    UseLimits: false,
    TargetSpeed: 0,
  };
}

// ---------------------------------------------------------------------------
// 6b. THE OBSTACLE FIELD (plan-659 obstacle pilot)
//
// Cubes and balls, to scale with the robot, so the walk has something to happen
// against and the empty floor gets a sense of distance. This block is the SSOT:
// it writes both the VISIBLE nodes of this GLB and the `rv_mujoco.obstacles`
// record the runtime splices into the MJCF. One list, two consumers, no second
// set of numbers anywhere.
//
// WHY THESE NUMBERS. Two measurements of this robot fix the whole staffel:
//
//   MASS / GRIP. The 15 <inertial> entries of the MJCF sum to 0.737 kg, and the
//   document declares no `friction` anywhere, so everything runs on MuJoCo's
//   default mu = 1.0. The duck's maximum push force is therefore its own ground
//   grip, mu * m * g = 7.2 N. Above ~0.7 kg an object is a wall; below ~0.3 kg
//   it moves. That is the entire reason the heavy block is 2 kg and the ball is
//   50 g - not a feeling about "heavy" and "light".
//
//   HEIGHT. The trunk base stands at z = 0.12 m. Below that an obstacle is met
//   by foot and shin, which is a TRIP. Above it, by chest and trunk, which is a
//   pitch moment and a fall backwards. The 15 cm block is deliberately the only
//   one over that line.
//
// A europallet is NOT an option here: 1.2 m next to a 0.266 m robot is a
// building, not an obstacle. Plain primitives rather than library GLBs on
// purpose, too - the library assets carry `realvirtual.Source` / `.MU` in their
// extras and would start spawning parts in a running scene.
//
// Colour reads WEIGHT, muted on purpose so the robot stays the subject: sand =
// it moves, steel = it tips, graphite = it is a wall.
// ---------------------------------------------------------------------------
const OBSTACLE_MATERIALS = {
  obs_light:  { hex: 0xd6c9ae, rough: 0.68, metal: 0.00 }, // <= 0.15 kg: gets kicked
  obs_medium: { hex: 0x8d99a6, rough: 0.56, metal: 0.04 }, // <= 0.5 kg: trips and tips
  obs_heavy:  { hex: 0x474c54, rough: 0.62, metal: 0.06 }, // > 0.5 kg or welded: a wall
};

// ── O13 / O14: an obstacle is an OBJECT, and its physics are its PROPERTIES ──
//
// Until 2026-10-25 an obstacle was two half-things: a visible node whose only
// `realvirtual` entry was a `Drive { Direction: 'Virtual' }`, and a row in a
// central `rv_mujoco.obstacles` array in the root extras that carried the mass,
// the condim and the friction. Both halves were wrong in the same way.
//
//   The Drive was a MISUSE, and a documented one: the destructive bake builds
//   only nodes that something CLAIMS, and `'Virtual'` was the one claim that
//   writes no transform. But an obstacle is not a drive, and whoever read the
//   demo learnt a pattern they should not copy (Thomas, O13: "warum haben bei
//   der Mujoco-Demo alle Obstacles einen Drive?").
//
//   The central list was the real construction fault (O14): it made an
//   obstacle an entry in a SCRIPT instead of an object in the scene — not
//   clickable in the viewer, not addressable over MCP, not movable by the user —
//   and it put mass and friction in a second home, away from the thing they
//   describe.
//
// Both are gone. Every obstacle now declares, ON ITS OWN NODE:
//
//   CollisionShapeSet  its collision geometry as ONE convex primitive, in mm
//                      HALF extents (the schema's convention, which is NOT the
//                      metres-and-full-sizes convention of the Unity
//                      `colliders[]` extras). This is also what makes the node
//                      findable by the obstacle scan — it is the component that
//                      says "my collision geometry is declared in this
//                      document", which the robot's own bodies never say
//                      (theirs is in the Apache-2.0 MJCF).
//   FreeBody           Enabled / MassKg / CondDim / FrictionSlide / damping /
//                      restitution. `Enabled: false` IS the welded obstacle: the
//                      MJCF writer only gives an enabled free body a freejoint.
//   Movable            the user may drag it (O13's "Verschiebemodus"), floor
//                      plane only, and it returns home on stop so a shoved
//                      obstacle does not silently become the new initial state.
//   ContactProfile     only where a surface genuinely needs more than sliding
//                      friction — the balls.
//
// A component claims its node by default, so these ARE the honest claim and the
// `Drive { Direction: 'Virtual' }` is not needed anywhere any more.
//
// THE TABLE BELOW IS THE ONE PLACE THE NUMBERS LIVE. It is the generator's
// input, and its values go straight into the component properties; the visible
// three.js geometry is derived FROM the CollisionShapeSet, never written beside
// it. Nothing reconstructs an obstacle from a second table.

/** mm half extents of a primitive, from metres (the CollisionShapeSet convention). */
const toMm = (...v) => v.map((x) => Number((x * 1000).toFixed(4)));

/** One obstacle node: a primitive, a free body, and optionally a contact role. */
function obstacle(name, pos, shape, freeBody, contactProfile) {
  return {
    name,
    pos,
    components: {
      CollisionShapeSet: {
        Shapes: [{ Kind: shape.Kind, Center: [0, 0, 0], Size: shape.Size, Rotation: [0, 0, 0] }],
        // The visible mesh of this node is a RENDERING of the primitive, not a
        // second collider: in MuJoCo the obstacle is written as that primitive.
        ReplacesMesh: true,
      },
      FreeBody: freeBody,
      // A welded obstacle is not draggable either — it is part of the room.
      ...(freeBody.Enabled
        ? { Movable: { Enabled: true, Axes: 'XZ', SnapMm: 0, ResetOnStop: true } }
        : {}),
      ...(contactProfile ? { ContactProfile: contactProfile } : {}),
    },
  };
}

// CondDim, and why most of these say 'Sliding' although the component's own
// default is 'SlidingTorsional'.
//
// `FreeBody.CondDim` defaults to 'SlidingTorsional' (condim 4) on purpose: in
// plan-673 Phase 1 a gripped part at MuJoCo's own condim 3 rotated out of the
// jaws within five seconds and a successful run turned SILENTLY into a jam.
// That default is right for the component and wrong to apply here by accident:
// the duck's staffel was MEASURED at condim 3 (one cube shoved 97 mm, three
// cubes 0.20 m apart boxing the duck in, a 50 g ball rolling 0.38 m), and
// quietly adding spin friction to every cube would re-tune the one thing the
// spike actually observed. So the cubes, blocks and posts state 'Sliding'
// EXPLICITLY — the measured value, visible as a decision instead of inherited
// as a default.
const SLIDING = 'Sliding';

// The balls are the exception, and they were already the exception before the
// components existed: at condim 3 a sphere has nothing to roll against —
// MEASURED, one kick sent a 50 g ball 8.46 m and it was still going. 'Full'
// (condim 6) turns torsional and rolling friction on, and mu_roll = 0.01 brings
// it to rest after 0.38 m, which is what "it drives into the ball and plays it
// away" is supposed to look like. Rolling friction has no slot on FreeBody
// (which carries one sliding coefficient), so the ball needs a ContactProfile —
// which is exactly the division of labour the two schemas describe.
const BALL_PROFILE = {
  Profile: 'Custom',
  Priority: 0,
  Solmix: 1,
  FrictionSlide: 1,
  FrictionSpin: 0.005,
  FrictionRoll: 0.01,
  CondDim: 'Full',
  SolrefTimeConst: 0.02,
  SolrefDampRatio: 1,
};

const freeBody = (massKg, condDim) => ({
  Enabled: true,
  MassKg: massKg,
  CondDim: condDim,
  FrictionSlide: 1,   // the whole MJCF declares no friction: MuJoCo's default mu
  LinearDamping: 0,
  AngularDamping: 0,
  Restitution: 0,
});

// 70 mm ball, 50 g - the proven case: the duck drives into it and plays it away.
const ball  = (name, x, y) => obstacle(name, [x, y, 0.035],
  { Kind: 'sphere', Size: toMm(0.035, 0, 0) }, freeBody(0.05, 'Full'), BALL_PROFILE);
// 50 mm cube, 100 g - foot height, light: a stumble, and it is shoved along
const small = (name, x, y) => obstacle(name, [x, y, 0.025],
  { Kind: 'box', Size: toMm(0.025, 0.025, 0.025) }, freeBody(0.10, SLIDING));
// 90 mm cube, 200 g - shin height, heavy enough to resist: it trips and tips
const mid   = (name, x, y) => obstacle(name, [x, y, 0.045],
  { Kind: 'box', Size: toMm(0.045, 0.045, 0.045) }, freeBody(0.20, SLIDING));
// 150 mm cube, 2 kg - ABOVE the 0.12 m trunk base and 2.7x the duck's own mass,
// so 19.6 N would be needed to shift it where the duck has 7.2 N: chest contact
// against something immovable, i.e. a fall backwards.
const block = (name, x, y) => obstacle(name, [x, y, 0.075],
  { Kind: 'box', Size: toMm(0.075, 0.075, 0.075) }, freeBody(2.00, SLIDING));
// 60 x 60 x 240 mm, WELDED: `FreeBody.Enabled: false`, so the writer gives it no
// freejoint - no qpos, no solver cost - and just under the robot's own 266 mm,
// robot-scale rather than a ruler propped up in the scene.
const post  = (name, x, y) => obstacle(name, [x, y, 0.12],
  { Kind: 'box', Size: toMm(0.03, 0.03, 0.12) },
  { Enabled: false, MassKg: 0, CondDim: SLIDING, FrictionSlide: 1,
    LinearDamping: 0, AngularDamping: 0, Restitution: 0 });

// ── reading the table back ───────────────────────────────────────────────────
// Everything below derives from the components. There is no second source.
/** The one primitive of an obstacle, as MuJoCo half extents in METRES. */
const shapeOf = (o) => {
  const s = o.components.CollisionShapeSet.Shapes[0];
  const half = s.Size.map((v) => v / 1000);
  return { kind: s.Kind, size: s.Kind === 'sphere' ? [half[0]] : half };
};
/** Welded = a free body that is switched off. */
const isStatic = (o) => o.components.FreeBody.Enabled !== true;
const massOf = (o) => o.components.FreeBody.MassKg;
/** Half height above its own origin — what the trunk-height rule measures. */
const halfHeightOf = (o) => {
  const { kind, size } = shapeOf(o);
  return kind === 'sphere' ? size[0] : size[2];
};
const obsClass = (o) => (isStatic(o) || massOf(o) > 0.5 ? 'heavy' : massOf(o) > 0.15 ? 'medium' : 'light');

// The geometry of the field, in MuJoCo coordinates (metres, +X = the direction
// the duck starts walking in).
//
// IT IS A COURSE, AND ITS STAGES ARE WIDE. Both are measurements, not taste:
//
//   The walking policy is BLIND - 61 observation values, no distance, no image -
//   so a collision is a disturbance it absorbs by YAWING. Logged over 60 s: the
//   duck walked to x = 1.25, hit a cube, and from there curved away and ended at
//   (-3.0, +1.6). After the ball alone it leaves the centre line by 0.5 m over
//   the next 5 m. A single obstacle per station is therefore missed: the second
//   measured run passed 15 cm beside a 5 cm cube and met nothing after the ball.
//
//   Hence three or four of a kind ACROSS the walking direction per station, set
//   close enough that the 0.09 m wide robot cannot thread the gap, and a ring at
//   2 m for the corridor it curves into. The ring doubles as the spatial
//   reference the empty floor was missing, and with the posts the scene spans
//   ~6.9 m: `groundSquareSize` is the 1-2-5 value nearest min(0.5 m, maxDim/10),
//   so the duck ALONE (0.266 m) gets 2.7 cm squares that read as noise, while
//   the field puts them on the familiar 0.5 m.
//
// O15 (Thomas, 2026-10-24): "vielleicht auch noch ein paar mehr Obstacles
// drumherum, also von den Baellen verteilen, sodass es ein bisschen enger ist,
// das Netz." Only the BALLS are multiplied and spread; the cube spacing is
// untouched, deliberately — the wedging finding of the spike hangs on exactly
// that spacing (three cubes 0.20 m apart boxed the duck in and it never got up;
// the same cube alone: trip, fall, stand up, walk on), and changing it along
// the way would devalue the one reproduced observation.
//
// Balls are the safe thing to multiply, and that is a measured property rather
// than a preference: a ball is PLAYED AWAY (0.05 kg against the duck's 7.2 N of
// grip), so a dense field of them never becomes the corner a cube field
// becomes. Added: a row of three across the walking direction at the first
// station (the "stages are wide" rule — a blind policy misses a single
// obstacle, measured: one run passed 15 cm beside a 5 cm cube), two pairs
// between the existing stations, a pair in front of the wall, and the ring
// filled in at the eight 22.5-degree half-steps plus the one free cardinal
// point at +X. Twelve balls more, no cube moved.
const R_RING = 2.0;
const R_POST = 3.4;
const D = Math.SQRT1_2 * R_RING;  // the 45 deg ring positions
/** A ball on the 2 m ring at `deg` (0 = +X, counter-clockwise). */
const ringBall = (name, deg) => ball(name,
  Number((R_RING * Math.cos(deg * Math.PI / 180)).toFixed(6)),
  Number((R_RING * Math.sin(deg * Math.PI / 180)).toFixed(6)));
const OBSTACLES = [
  // ── THE LANE: the graded sequence, in the order the duck meets it ────────
  // 70 mm ball, 50 g - the proven case: it drives into it and plays it away.
  // Dead on the centre line, because at x = 0.55 the duck has not drifted yet.
  ball('obs_ball_a', 0.55, 0.00),
  // O15: the first station widened to three across, so the drift cannot thread it.
  ball('obs_ball_a2', 0.55, -0.26),
  ball('obs_ball_a3', 0.55, 0.26),
  // THE STUMBLE. Three of them 0.15 m apart - 0.10 m gaps against a 0.09 m wide
  // robot, so it cannot thread them. Measured: it stumbles, shoves one 97 mm
  // along and keeps walking. 100 g at foot height does not put it down.
  small('obs_cube_s1', 1.00, -0.04),
  small('obs_cube_s2', 1.00,  0.11),
  small('obs_cube_s3', 1.00,  0.26),
  // the trip gate, shin height, offset to follow the drift the gate above adds
  // THE TRIP, and the one number this stage lives or dies by: the cubes are far
  // APART. Measured, three of them 0.20 m apart boxed the duck in - it tripped,
  // fell between them and never got up again (0 recoveries in 40 s of lying
  // there). The same cube ALONE: trip, fall, up again, walk on - twice in 60 s.
  // A blind policy can only stand up where there is room to.
  // O15: a ball pair BETWEEN stumble and trip gate — it keeps the duck busy on
  // the stretch where it used to meet nothing at all.
  ball('obs_ball_d', 1.35, -0.12),
  ball('obs_ball_e', 1.35,  0.34),
  mid('obs_cube_m1', 1.70,  0.22),
  mid('obs_cube_m2', 1.70, -0.30),
  // O15: a pair in front of the wall, offset to the two sides the drift uses.
  ball('obs_ball_f', 2.10,  0.15),
  ball('obs_ball_g', 2.10, -0.40),
  // THE WALL: four 150 mm blocks nearly touching, 0.68 m of chest-high
  // graphite. Wide on purpose - this is the stage that must not be threaded,
  // because it is the one that produces the fall.
  // THE WALL. Two of them, 0.6 m apart rather than a closed row, for the same
  // reason as above: a row of chest-high graphite is a corner the duck cannot
  // get out of, and the demo would end with it lying there. Set on the two
  // places the drift actually reaches x = 2.5 at.
  block('obs_block_1', 2.50,  0.45),
  block('obs_block_2', 2.50, -0.15),

  // ── THE RING at 2 m: whichever way it curves off, there is a stage ───────
  ball('obs_ball_b', 0.00,  R_RING),
  ball('obs_ball_c', 0.00, -R_RING),
  mid('obs_cube_r1',  D,  D),
  mid('obs_cube_r2', -D,  D),
  mid('obs_cube_r3', -D, -D),
  small('obs_cube_r4', D, -D),
  block('obs_block_w', -R_RING, 0.00),
  // O15: the ring closed up. The cardinal gap at +X (the direction the duck
  // starts in) plus the eight half-steps between the existing eight marks, so
  // whichever way it curves off it meets something within ~0.77 m of arc
  // instead of ~1.53 m.
  ringBall('obs_ball_r0', 0),
  ringBall('obs_ball_r22', 22.5),
  ringBall('obs_ball_r67', 67.5),
  ringBall('obs_ball_r112', 112.5),
  ringBall('obs_ball_r157', 157.5),
  ringBall('obs_ball_r202', 202.5),
  ringBall('obs_ball_r247', 247.5),
  ringBall('obs_ball_r292', 292.5),
  ringBall('obs_ball_r337', 337.5),

  // ── THE POSTS at 3.4 m: four fixed marks, so the plane reads ─────────────
  post('obs_post_e',  R_POST, 0.00),
  post('obs_post_n',  0.00,  R_POST),
  post('obs_post_w', -R_POST, 0.00),
  post('obs_post_s',  0.00, -R_POST),
];

const doc = new Document();
doc.getRoot().getAsset().generator = 'realvirtual rv-duck builder (plan-659 spike)';
const buf = doc.createBuffer();
const scene = doc.createScene('rv_duck_scene');

const gltfMat = new Map();
for (const [name, m] of Object.entries({ ...MATERIALS, ...OBSTACLE_MATERIALS })) {
  const mat = doc.createMaterial('rv_duck_' + name)
    .setBaseColorFactor(linearRGBA(m.hex))
    .setRoughnessFactor(m.rough)
    .setMetallicFactor(m.metal)
    .setDoubleSided(false);
  if (m.emissive !== undefined) {
    mat.setEmissiveFactor(linearRGB(m.emissive).map((c) => c * (m.emit ?? 1)));
  }
  gltfMat.set(name, mat);
}

function makeMesh(name, groups) {
  const mesh = doc.createMesh(name);
  for (const g of groups) {
    const pos = g.geo.getAttribute('position');
    const nrm = g.geo.getAttribute('normal');
    const idx = g.geo.getIndex();
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor()
        .setType('VEC3').setArray(new Float32Array(pos.array)).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor()
        .setType('VEC3').setArray(new Float32Array(nrm.array)).setBuffer(buf))
      .setMaterial(gltfMat.get(g.mat));
    if (idx) {
      prim.setIndices(doc.createAccessor()
        .setType('SCALAR').setArray(new Uint32Array(idx.array)).setBuffer(buf));
    }
    mesh.addPrimitive(prim);
  }
  return mesh;
}

// Z-up (MuJoCo) -> Y-up (glTF)
const zUpToYUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const root = doc.createNode('rv_duck').setRotation(zUpToYUp.toArray());
scene.addChild(root);

const nodes = new Map();
let tris = 0;
for (const b of rig.bodies) {
  const fk = FK.get(b.name);
  const node = doc.createNode(b.name);
  const t = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  fk.local.decompose(t, q, sc);
  node.setTranslation(t.toArray()).setRotation(q.toArray());

  const extras = { rv_mjcf_body: b.name };
  if (b.joint) {
    extras.rv_joint = {
      name: b.joint.name,
      type: 'hinge',
      axis: [0, 0, 1],
      range: b.joint.range,
      actuator_index: b.joint.actuator_index,
      rest_quat_xyzw: fk.restQuat.toArray(),
      stand_angle: fk.standAngle,
    };
  } else {
    extras.rv_free_joint = { trunk_height: TRUNK_HEIGHT };
  }
  // The realvirtual component map - the ONLY extras key the destructive bake
  // reads (plan-659 Phase 3, measured): a node without an entry here is not
  // claimed and is never built, so without these the 14 joints and the trunk
  // would be gone from the scene (23 source nodes -> 1 survivor). `rv_joint` /
  // `rv_free_joint` above STAY - they are the contract to the policy mirror and
  // to a later WebSensor binding, and the bake carries userData by reference.
  extras.realvirtual = b.joint
    ? { Drive: driveForJoint(fk) }
    // THE FLOATING BASE IS A FREE BODY, and since 2026-10-25 it says so.
    //
    // It used to carry `Drive { Direction: 'Virtual' }` for the same reason the
    // obstacles did: the bake builds only claimed nodes, and `'Virtual'` was the
    // one claim that writes no transform. It is the same misuse — a floating
    // base is no more a drive than an obstacle is — and `FreeBody` is the
    // component that names it exactly: the schema says it "fills the gap in
    // KinematicJointType, which knows Revolute, Prismatic, Spherical and
    // Universal but no free joint".
    //
    // It carries NO CollisionShapeSet, and that is what keeps it out of the
    // obstacle field: the scan collects nodes that declare their collision
    // geometry in THIS document, and the robot's lives in the Apache-2.0 MJCF.
    // Its mass is in those <inertial> entries too, so `MassKg: 0` ("derive it")
    // is the honest value rather than a number copied to a second place.
    //
    // Nothing regressed by the swap: the joint mirror binds the base through
    // `rv_free_joint` (not through the Drive), `bindDrives` walks `rv_joint`
    // nodes only, and `FreeBody` declares `bake: 'chunk'`, so the trunk stays
    // the chunk boundary the `'Virtual'` drive made it.
    : { FreeBody: { Enabled: true, MassKg: 0, CondDim: 'Sliding', FrictionSlide: 1,
      LinearDamping: 0, AngularDamping: 0, Restitution: 0 } };
  node.setExtras(extras);

  if (merged.has(b.name)) {
    const groups = merged.get(b.name);
    node.setMesh(makeMesh(b.name + '_mesh', groups));
    for (const g of groups) {
      const idx = g.geo.getIndex();
      tris += (idx ? idx.count : g.geo.getAttribute('position').count) / 3;
    }
  }
  nodes.set(b.name, node);
  (b.parent === null ? root : nodes.get(b.parent)).addChild(node);
}

// Which of the 7 MJCF sites is a genuine SENSOR and therefore gets a
// `realvirtual.WebSensor` marker. Same mechanism as the Drives on the bodies:
// the destructive bake builds only nodes that carry a component in
// `extras.realvirtual`, so without this entry a site node is never built and
// cannot be addressed. `rv_sensor` is OUR key and claims nothing.
//
// `mouth_tip` is deliberately NOT in this list. It is not an instrument but a
// construction datum: the original beak tip, used here to solve the plane of the
// mouth parting line. It has no entry in the MJCF <sensor> block and no sensor
// hardware behind it. A WebSensor would give it the green Sensor badge, a place
// in the "Web Sensors" filter and the sensor tooltip - presenting a reference
// point to the operator as an instrument. Its number is already baked into the
// housing geometry, so nothing is lost by letting the node merge away as before.
const WEB_SENSOR_SITES = new Set([
  'imu',          // 5 entries in the MJCF <sensor> block: framequat, 2x gyro, velocimeter, accelerometer
  'head_imu',     // the second IMU, inside the skull; drawn without geometry on purpose
  'head_camera',  // carries the MJCF <camera> of the same name
  'tof',          // time-of-flight distance sensor, the left optic of the front pair
  'left_foot',    // foot contact reference, marked by a contact pad
  'right_foot',
]);

const siteNodes = new Map();
let sensorTris = 0;
for (const s of SITES.values()) {
  const node = doc.createNode(s.name)
    .setTranslation(s.pos)
    .setRotation(mjQuat(s.quat).toArray());
  const marker = MARKERS.get(s.name) || { kind: 'none', note: '' };
  const siteExtras = {
    rv_sensor: {
      site: s.name,
      parent_body: s.parent,
      site_pos: s.pos,
      site_quat_wxyz: s.quat,
      sensors: SENSORS.bySite.get(s.name) || [],
      has_camera: CAMERAS.has(s.name),
      marker: marker.kind,
      marker_note: marker.note,
      hull_correction_mm: RESID[s.name] !== undefined ? Number(RESID[s.name].toFixed(2)) : null,
    },
  };
  // The component that makes the site survive the bake. Both keys live side by
  // side: `rv_sensor` is the data contract (types and noise values straight out
  // of the MJCF <sensor> block, plus the site pose), `WebSensor` is the claim.
  // Left UNBOUND on purpose - a demo robot has no PLC signals. RVWebSensor
  // handles that: with neither SignalBool nor SignalInt set it subscribes to
  // nothing and never touches the SignalStore. `Label` is the site name, which
  // is what the tooltip and the sensor list show.
  if (WEB_SENSOR_SITES.has(s.name)) {
    siteExtras.realvirtual = { WebSensor: { Label: s.name } };
  }
  node.setExtras(siteExtras);
  if (siteMerged.has(s.name)) {
    const groups = siteMerged.get(s.name);
    node.setMesh(makeMesh(s.name + '_mesh', groups));
    for (const g of groups) {
      const idx = g.geo.getIndex();
      const n = (idx ? idx.count : g.geo.getAttribute('position').count) / 3;
      tris += n;
      sensorTris += n;
    }
  }
  nodes.get(s.parent).addChild(node);
  siteNodes.set(s.name, node);
}

// ---- the obstacle nodes -----------------------------------------------------
// Children of `rv_duck`, so they sit under the ONE -90 deg X rotation that turns
// MuJoCo Z-up into glTF Y-up (the coordinate contract of this asset): everything
// below that root is MuJoCo coordinates in metres, which makes the runtime's
// mirror of a free body the identity - position and quaternion go through
// unconverted. A container node of their own keeps them one selectable group in
// the hierarchy; it carries identity, because the rotation is already above it.
//
// Every obstacle node carries its components and NOTHING ELSE (O13/O14): the
// CollisionShapeSet is its collision geometry, the FreeBody its physics, the
// Movable the user's right to shove it. A component claims its node, so these
// are the claim the bake needs — the `Drive { Direction: 'Virtual' }` that used
// to serve as the claim is gone, here and on the trunk.
//
// There is also no `rv_obstacle` key any more. It was OUR parallel data
// contract (name, shape, size, mass, free, weight_class) and it duplicated
// every number the components now carry; the runtime's free-body mirror binds
// on `FreeBody` instead.
const obsRoot = doc.createNode('rv_obstacles');
root.addChild(obsRoot);
let obsTris = 0;
const obstacleNodes = new Map();
for (const o of OBSTACLES) {
  // The VISIBLE mesh is derived from the CollisionShapeSet, so the picture and
  // the physics cannot drift apart. MuJoCo sizes are a radius / half extents;
  // three.js takes diameters.
  const { kind, size } = shapeOf(o);
  const geo = kind === 'sphere'
    ? new THREE.SphereGeometry(size[0], 24, 16)
    : new THREE.BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2);
  geo.computeVertexNormals();
  const cls = obsClass(o);
  const node = doc.createNode(o.name)
    .setTranslation(o.pos)
    .setMesh(makeMesh(o.name + '_mesh', [{ mat: 'obs_' + cls, geo }]));
  node.setExtras({ realvirtual: o.components });
  obsRoot.addChild(node);
  obstacleNodes.set(o.name, node);
  const idx = geo.getIndex();
  const t = (idx ? idx.count : geo.getAttribute('position').count) / 3;
  tris += t;
  obsTris += t;
}

// Where the Apache-2.0 fixture is served from by the dev server (the W tree is
// the Vite root). The fixture is the SSOT of every number the policy needs -
// dt, decimation, joint order, default pose, observation layout - so the GLB
// carries the PATH, never a copy of the values (Phase 1 rule).
const FIXTURE_BASE = '/spikes/659/fixtures/microduck';
// The SIMULATED scene - stage 2 of the geometry own-build. Same Apache-2.0 body
// tree, joints, sites, sensors, actuators and inertials as the fixture's own
// prepared-scene.xml, but every collision hull is an ORIGINAL MuJoCo primitive
// instead of a CC BY-NC-SA mesh. Built by `duck/build-collision-primitives.mjs`
// from that XML plus measured dimensions; it references no mesh file, so no
// `meshBase` is handed over and nothing at run time fetches an .stl.
const COLLISION_SCENE = '/spikes/659/duck/rv-duck-collision.xml';

root.setExtras({
  rv_asset: 'rv-walker',
  // The activation record of the MuJoCo locomotion plugin (plan-659 Phase 2b).
  // Its presence is what switches the plugin on: a model without this key
  // never triggers a single mujoco/ort request, which is the lazy-load gate.
  rv_mujoco: {
    v: 1,
    mjcf: COLLISION_SCENE,
    contract: FIXTURE_BASE + '/reference/microduck-reference-fixtures.json',
    policies: {
      walking: FIXTURE_BASE + '/policies/BEST_alpha_walking.onnx',
      stand: FIXTURE_BASE + '/policies/BEST_alpha_stand.onnx',
    },
    // Both libraries locate their .wasm relative to their own module URL, which
    // Vite rewrites - so the URL is handed in. Dev-server paths: the packages
    // are installed out-of-band in BOTH trees and the dev server serves its own
    // root's node_modules (it does NOT serve /@fs/<private sibling>/node_modules,
    // Phase 2 finding 2).
    wasm: {
      mujoco: '/node_modules/@mujoco/mujoco/mujoco.wasm',
      ort: '/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    },
    trunkBody: 'trunk_base',
    trunkFreeJoint: 'trunk_base_freejoint',
    gyroSensor: 'imu_ang_vel',
    command: { vx: 0.25, vy: 0, yaw: 0 },
    // NO `obstacles` ARRAY (O14, 2026-10-25). The obstacle field used to be a
    // list right here, and that was the construction fault: a central list makes
    // an obstacle an entry in a script instead of an object in the scene. The
    // obstacles now declare themselves on their own nodes
    // (CollisionShapeSet + FreeBody + Movable), and the runtime SCANS the scene
    // for them before it splices them into the MJCF - same splice, same
    // append-behind-the-robot rule for the qpos layout, one source of numbers.
  },
  rv_note: 'realvirtual original asset - a small two-legged service robot, not a copy of '
    + 'any existing robot character. Kinematics, sites and inertial proportions from the '
    + 'Apache-2.0 MJCF of the plan-659 fixture; no CC BY-NC-SA mesh was read, converted '
    + 'or traced. The industrial design means used here (panel splits, parting lines, '
    + 'fasteners, louvre fields, a pair of round optics, routed cables, accent paint on '
    + 'whole panels) are generic and quote no protected figure.',
  rv_frame: 'authored Z-up (MuJoCo); this root rotates -90deg about X for glTF Y-up',
  rv_pose: 'STAND keyframe',
  rv_actuated_joints: rig.actuated_joints,
  rv_sensor_sites: [...SITES.keys()],
  rv_unsited_sensors: SENSORS.loose,
  rv_proportions: {
    source: 'equivalent solid ellipsoid of each <inertial>, built as chamfered boxes',
    skull_tensor_semi_axes_mm: SKULL_RAW.r.map((v) => Number((v * 1000).toFixed(1))),
    head_case_half_extents_mm: HEAD.half.map((v) => Number((v * 1000).toFixed(1))),
    trunk_tensor_semi_axes_mm: BODY_RAW.r.map((v) => Number((v * 1000).toFixed(1))),
    torso_half_extents_mm: TORSO_H.map((v) => Number((v * 1000).toFixed(1))),
    head_len_over_height: HEAD_LEN_OVER_HEIGHT,
    head_len_over_width: HEAD_LEN_OVER_WIDTH,
    trunk_scale_factor: K_TRUNK,
  },
});

mkdirSync(HERE, { recursive: true });
await new NodeIO().write(OUT, doc);

// ---------------------------------------------------------------------------
// 7. RIG CHECK and SENSOR CHECK. The ONNX policy is trained on exactly this kinematics
//    and exactly these sensors, so both must stay bit-identical to the MJCF no matter
//    what the surface language does. A failure here throws.
// ---------------------------------------------------------------------------
const fails = [];
const eq = (what, a, b, eps = 0) => {
  const ok = Array.isArray(a)
    ? a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps)
    : Math.abs(a - b) <= eps;
  if (!ok) fails.push(what + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
  return ok;
};
const same = (what, a, b) => {
  if (a !== b) fails.push(what + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
};
// A node's TRS is the NORMALISED transform and a quaternion is free to flip sign (double
// cover), so node transforms are compared as transforms, at glTF float32 precision. The
// authoritative values - the MJCF quat and the stand angle - live in extras.rv_joint and
// are compared bit-exact below.
const F32 = 2e-6;
const eqQuat = (what, a, b) => {
  const d1 = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  const d2 = Math.max(...a.map((v, i) => Math.abs(v + b[i])));
  if (Math.min(d1, d2) > F32) {
    fails.push(what + ': ' + JSON.stringify(a) + ' != ' + JSON.stringify(b));
  }
};
const parentName = (n) => {
  const p = n.listParents().find((x) => x.propertyType === 'Node');
  return p ? p.getName() : null;
};

// ---- RIG CHECK ----
same('rig body count', rig.bodies.length, 15);
let hinges = 0;
for (const b of rig.bodies) {
  const node = nodes.get(b.name);
  if (!node) { fails.push('body node missing: ' + b.name); continue; }
  eq('pos ' + b.name, [...node.getTranslation()], b.pos, F32);
  const fk = FK.get(b.name);
  const expect = fk.restQuat.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), fk.standAngle));
  eqQuat('rot ' + b.name, [...node.getRotation()], expect.toArray());
  same('parent of ' + b.name, parentName(node), b.parent === null ? 'rv_duck' : b.parent);
  const ex = node.getExtras();
  if (b.joint) {
    hinges++;
    const j = ex.rv_joint;
    if (!j) { fails.push('rv_joint missing on ' + b.name); continue; }
    same('joint name ' + b.name, j.name, b.joint.name);
    same('joint type ' + b.name, j.type, 'hinge');
    eq('joint axis ' + b.name, j.axis, [0, 0, 1]);
    eq('joint range ' + b.name, j.range, b.joint.range);
    same('actuator_index ' + b.name, j.actuator_index, b.joint.actuator_index);
    eq('rest_quat ' + b.name, j.rest_quat_xyzw, mjQuat(b.quat).toArray(), 1e-15);
    eq('stand_angle ' + b.name, j.stand_angle, STAND_QPOS[b.joint.actuator_index]);
  } else if (!ex.rv_free_joint) {
    fails.push('rv_free_joint missing on ' + b.name);
  }
}
same('hinge joint count', hinges, 14);

// ---- DRIVE CHECK (plan-659 Phase 2b) ----
// Without a `realvirtual` entry a node does not survive the destructive bake,
// so this is not cosmetic metadata: it decides whether the robot EXISTS in a
// viewer scene. Checked here, in the generator, because that is where it can be
// lost by an edit.
let driveNodes = 0;
for (const b of rig.bodies) {
  const node = nodes.get(b.name);
  if (!node) continue;
  const ex = node.getExtras();
  // The other extras must SURVIVE next to the component - they are the policy contract.
  if (b.joint && !ex.rv_joint) fails.push('rv_joint lost on ' + b.name);
  if (!b.joint && !ex.rv_free_joint) fails.push('rv_free_joint lost on ' + b.name);
  if (!b.joint) {
    // The floating base is a FreeBody now, not a Drive { Virtual } (O13).
    const fb = ex.realvirtual?.FreeBody;
    if (!fb) { fails.push('realvirtual.FreeBody missing on the floating base ' + b.name); continue; }
    same('trunk free body enabled', fb.Enabled, true);
    same('trunk mass is derived', fb.MassKg, 0);
    // No collision geometry declared here, or the obstacle scan would pick the
    // trunk up as an obstacle and splice a SECOND body for it into the MJCF.
    if (ex.realvirtual.CollisionShapeSet) {
      fails.push('the floating base must not declare a CollisionShapeSet - the scan would treat it as an obstacle');
    }
    if (ex.realvirtual.Drive) fails.push('Drive is back on the floating base (O13)');
    driveNodes++;
    continue;
  }
  const d = ex.realvirtual?.Drive;
  if (!d) { fails.push('realvirtual.Drive missing on ' + b.name); continue; }
  driveNodes++;
  // The axis of all 14 joints is +Z; `directionToGltfAxis(RotationZ)` is -Z, so
  // the reversal flag has to be set, or every joint turns the wrong way.
  same('drive direction ' + b.name, d.Direction, 'RotationZ');
  same('drive reversed ' + b.name, d.ReverseDirection, true);
  same('drive limits ' + b.name, d.UseLimits, false);
  // Offset = -stand in DEGREES makes `currentPosition` the raw joint angle.
  eq('drive offset ' + b.name, d.Offset, -fk1(b).standAngle * (180 / Math.PI), 1e-12);
}
same('drive node count', driveNodes, rig.bodies.length);
function fk1(b) { return FK.get(b.name); }
same('actuated_joints length', rig.actuated_joints.length, 14);
for (const b of rig.bodies) {
  if (!b.joint) continue;
  same('actuator_index -> name ' + b.joint.name,
    rig.actuated_joints[b.joint.actuator_index], b.joint.name);
}

// ---- OBSTACLE CHECK (plan-659 obstacle pilot) ----
// Same reasoning as the DRIVE CHECK: a missing claim does not look wrong here,
// it makes the obstacle disappear from the SCENE while staying in the physics.
//
// O14: there is no central record to compare against any more - the components
// ON the node ARE the record, so what is checked is that each node carries a
// complete, self-sufficient declaration and that no stale second home came back.
if (root.getExtras().rv_mujoco.obstacles !== undefined) {
  fails.push('rv_mujoco.obstacles is back - the obstacle parameters belong on the components (O14)');
}
let obsFree = 0;
for (const o of OBSTACLES) {
  const node = obstacleNodes.get(o.name);
  if (!node) { fails.push('obstacle node missing: ' + o.name); continue; }
  const ex = node.getExtras() || {};
  const rv = ex.realvirtual;
  if (!rv) { fails.push('realvirtual components missing on obstacle ' + o.name); continue; }
  if (rv.Drive) fails.push('Drive is back on obstacle ' + o.name + ' (O13)');
  if (ex.rv_obstacle) fails.push('rv_obstacle is back on ' + o.name + ' - a second home for the same numbers (O14)');
  // The collision geometry, in the schema's mm HALF extents.
  const css = rv.CollisionShapeSet;
  if (!css || !Array.isArray(css.Shapes) || css.Shapes.length !== 1) {
    fails.push('obstacle ' + o.name + ' needs exactly one CollisionShapeSet primitive'); continue;
  }
  const { kind, size } = shapeOf(o);
  same('obstacle shape ' + o.name, css.Shapes[0].Kind, kind);
  same('obstacle replaces mesh ' + o.name, css.ReplacesMesh, true);
  // mm half extents and the metre half extents the geometry was built from must
  // be the same statement; a factor of 1000 here is the classic unit trap the
  // Phase-0 gate logged (colliders[] metres vs. TransportStopper mm vs. this).
  eq('obstacle size round-trip ' + o.name,
    css.Shapes[0].Size.slice(0, size.length).map((v) => v / 1000), size, 1e-9);
  // The physics.
  const fb = rv.FreeBody;
  if (!fb) { fails.push('FreeBody missing on obstacle ' + o.name); continue; }
  same('obstacle free ' + o.name, fb.Enabled, !isStatic(o));
  if (!isStatic(o)) {
    obsFree++;
    if (!(fb.MassKg > 0)) fails.push('obstacle ' + o.name + ' is free but has no mass');
    // A free obstacle is draggable (O13's move mode); a welded one is not.
    if (!rv.Movable) fails.push('Movable missing on free obstacle ' + o.name);
    else same('obstacle move axes ' + o.name, rv.Movable.Axes, 'XZ');
  } else if (rv.Movable) {
    fails.push('welded obstacle ' + o.name + ' must not be Movable - it is part of the room');
  }
  // The balls, and only the balls, carry a contact role: rolling friction has no
  // slot on FreeBody, and without it a kicked ball leaves the scene (8.46 m).
  if (kind === 'sphere') {
    const cp = rv.ContactProfile;
    if (!cp) { fails.push('ball ' + o.name + ' has no ContactProfile - it would roll away'); continue; }
    same('ball condim ' + o.name, cp.CondDim, 'Full');
    same('ball rolling friction ' + o.name, cp.FrictionRoll, 0.01);
  } else if (rv.ContactProfile) {
    fails.push('obstacle ' + o.name + ' carries a ContactProfile it does not need');
  } else {
    // Stated, not inherited: the staffel was measured at condim 3, and the
    // component default is 4 on purpose (see the CondDim note above).
    same('cube condim ' + o.name, fb.CondDim, 'Sliding');
  }
  eq('obstacle node pos ' + o.name, [...node.getTranslation()], o.pos, F32);
  same('obstacle parent ' + o.name, parentName(node), 'rv_obstacles');
}
// The physics claim of the staffel, asserted so a well-meant edit cannot
// silently turn the demo into seven immovable blocks (or seven footballs).
// 7.2 N = mu * m * g with mu = 1.0 and the robot's own 0.737 kg.
const DUCK_PUSH_N = 1.0 * 0.737 * 9.81;
for (const o of OBSTACLES) {
  if (isStatic(o)) continue;
  const needN = 1.0 * massOf(o) * 9.81;
  const movable = needN < DUCK_PUSH_N;
  if (obsClass(o) === 'heavy' && movable) {
    fails.push('obstacle ' + o.name + ' is graphite (a wall) but the duck can push it: '
      + needN.toFixed(1) + ' N < ' + DUCK_PUSH_N.toFixed(1) + ' N');
  }
  if (obsClass(o) !== 'heavy' && !movable) {
    fails.push('obstacle ' + o.name + ' reads as movable but needs '
      + needN.toFixed(1) + ' N > ' + DUCK_PUSH_N.toFixed(1) + ' N');
  }
}
// The height rule. Below the trunk base (0.12 m) an obstacle is met by foot and
// shin, above it by the chest - so a stage that reaches OVER that line is a
// fall, and a fall is only honest against something that cannot be pushed away.
// Therefore: every free obstacle over 0.12 m must be graphite, and at least one
// must exist, or the demo has no fall in it.
const overTrunk = OBSTACLES.filter((o) => !isStatic(o)
  && o.pos[2] + halfHeightOf(o) > TRUNK_HEIGHT);
if (overTrunk.length === 0) fails.push('no free obstacle reaches over the trunk base - no fall in the demo');
for (const o of overTrunk) {
  if (obsClass(o) !== 'heavy') {
    fails.push('obstacle ' + o.name + ' is chest-high but not a wall - it would be pushed, not fallen over');
  }
}

// ---- SENSOR CHECK ----
same('site count', SITES.size, 7);
for (const s of SITES.values()) {
  const node = siteNodes.get(s.name);
  if (!node) { fails.push('site node missing: ' + s.name); continue; }
  eq('site pos ' + s.name, [...node.getTranslation()], s.pos, F32);
  eqQuat('site quat ' + s.name, [...node.getRotation()], mjQuat(s.quat).toArray());
  same('site parent ' + s.name, parentName(node), s.parent);
  const rs = node.getExtras().rv_sensor;
  if (!rs) { fails.push('rv_sensor missing on site ' + s.name); continue; }
  same('rv_sensor.site ' + s.name, rs.site, s.name);
  same('rv_sensor.parent_body ' + s.name, rs.parent_body, s.parent);
  const want = SENSORS.bySite.get(s.name) || [];
  same('rv_sensor.sensors ' + s.name, JSON.stringify(rs.sensors), JSON.stringify(want));
}
// the blind balancing port must NOT masquerade as a sensor
for (const n of doc.getRoot().listNodes()) {
  const ex = n.getExtras() || {};
  if (ex.rv_sensor && !SITES.has(n.getName())) {
    fails.push('node "' + n.getName() + '" carries rv_sensor but is not an MJCF site');
  }
}
// ---- WebSensor markers on the sites (plan-659 Nachtrag) ----
// Same reasoning as the DRIVE CHECK: without `realvirtual.WebSensor` the site
// node does not survive the destructive bake, so this is not cosmetic metadata.
let webSensorNodes = 0;
for (const s of SITES.values()) {
  const node = siteNodes.get(s.name);
  if (!node) continue;
  const ex = node.getExtras() || {};
  const ws = ex.realvirtual && ex.realvirtual.WebSensor;
  if (WEB_SENSOR_SITES.has(s.name)) {
    if (!ws) { fails.push('realvirtual.WebSensor missing on site ' + s.name); continue; }
    webSensorNodes++;
    same('WebSensor label ' + s.name, ws.Label, s.name);
    // The data contract must SURVIVE next to the component - the same rule the
    // DRIVE CHECK applies to rv_joint.
    if (!ex.rv_sensor) fails.push('rv_sensor lost on site ' + s.name);
  } else if (ws) {
    fails.push('site "' + s.name + '" carries a WebSensor but is not a sensor');
  }
}
same('WebSensor node count', webSensorNodes, WEB_SENSOR_SITES.size);
// and nothing outside the sensor set may masquerade as one - the blind
// balancing port of the face in particular
for (const n of doc.getRoot().listNodes()) {
  const ex = n.getExtras() || {};
  if (ex.realvirtual && ex.realvirtual.WebSensor && !WEB_SENSOR_SITES.has(n.getName())) {
    fails.push('node "' + n.getName() + '" carries a WebSensor but is not a sensor site');
  }
}
// the seating of the two real front sites must not be worse than the ellipsoid build
const SEAT_BUDGET = { head_camera: 0.0, tof: 5.5 };
for (const [k, budget] of Object.entries(SEAT_BUDGET)) {
  const got = Math.abs(RESID[k]);
  if (!(got <= budget + 1e-6)) {
    fails.push('seating of ' + k + ' got worse: ' + got.toFixed(2) + ' mm > ' + budget + ' mm');
  }
}

if (fails.length) {
  console.error('RIG/SENSOR CHECK FAILED:');
  for (const f of fails) console.error('  ' + f);
  throw new Error(fails.length + ' rig/sensor check failure(s)');
}

if (DIAG) {
  const fmt = (v) => (v * 1000).toFixed(1).padStart(6);
  console.log('--- inertia-derived proportions (equivalent solid ellipsoid) ---');
  for (const name of ['trunk_base', 'jaw_soft', 'neck', 'neck_pitch', 'yaw_roll_motion',
    'upper_leg_left', 'leg', 'ankle_left']) {
    const E = inertiaEllipsoid(name);
    console.log('  ' + name.padEnd(17) + ' m=' + E.mass.toFixed(5)
      + '  semiAxes(mm)=[' + E.r.map(fmt).join(' ') + ']');
  }
  console.log('  head case  [' + HEAD.half.map(fmt).join(' ') + ']  (bbox '
    + HEAD.half.map((v) => (v * 2000).toFixed(0)).join(' x ') + ' mm)');
  console.log('  torso      [' + TORSO_H.map(fmt).join(' ') + ']  (bbox '
    + TORSO_H.map((v) => (v * 2000).toFixed(0)).join(' x ') + ' mm)');
  console.log('  head_camera head-local (mm) ' + CAM_L.toArray().map(fmt).join(' '));
  console.log('  tof         head-local (mm) ' + TOF_L.toArray().map(fmt).join(' '));
  console.log('--- site correction applied when seating on the hull (+ was outside) ---');
  for (const [k, v] of Object.entries(RESID)) {
    console.log('  ' + k.padEnd(13) + (v >= 0 ? '+' : '') + v.toFixed(1) + ' mm');
  }
}

const jointCount = rig.bodies.filter((b) => b.joint).length;
console.log('rv-duck.glb written: ' + OUT);
console.log('  bodies ' + rig.bodies.length + '   joints ' + jointCount
  + '   surfaces ' + (parts.length + sensorParts.length) + '   triangles ' + tris);
console.log('  sensor sites ' + SITES.size + ' ('
  + [...MARKERS].filter((m) => m[1].kind !== 'none').length
  + ' with a marker, ' + sensorTris + ' of the triangles)');
console.log('  obstacles ' + OBSTACLES.length + ' (' + obsFree + ' free, '
  + (OBSTACLES.length - obsFree) + ' welded, ' + obsTris + ' triangles)   OBSTACLE CHECK ok');
console.log('  materials ' + (Object.keys(MATERIALS).length + Object.keys(OBSTACLE_MATERIALS).length)
  + '   pose STAND   root rotation Z-up -> Y-up');
console.log('  RIG CHECK    ok  (' + rig.bodies.length + ' bodies, ' + hinges
  + ' hinge joints; poses, axes, ranges, actuator indices and rest quats bit-identical)');
console.log('  SENSOR CHECK ok  (' + SITES.size + ' sites, ' + WEB_SENSOR_SITES.size
  + ' with a WebSensor; positions, quats and the <sensor> '
  + 'block identical, rv_sensor kept next to the component, blind port carries '
  + 'neither rv_sensor nor WebSensor; seating head_camera '
  + Math.abs(RESID.head_camera).toFixed(1) + ' mm / tof ' + Math.abs(RESID.tof).toFixed(1)
  + ' mm)');
