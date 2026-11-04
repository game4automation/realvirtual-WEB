// realvirtual.io (R) - plan-659 PROVENANCE TOOL, not part of any build.
//
// Measures the nine collision meshes of fixtures/microduck/mjcf/prepared-scene.xml
// and writes `collision-hulls.measured.json` next to this file. That JSON is the
// input of `build-collision-primitives.mjs`, and it is the audit trail for
// "where did those numbers come from".
//
// This is the ONLY script in the spike that still needs the CC BY-NC-SA 4.0 STL
// files. They are gitignored and procured out of band, so on most checkouts this
// tool cannot run - by design. The numbers it produced are committed; the meshes
// are not, and are not needed by anything else.
//
// WHAT IT TAKES FROM THE MESHES: dimensions only - bounding boxes in the author
// (CAD) frame, the soles' support plane and the in-plane extent of their
// ground-facing band. A dimension is a fact about an object, not an expression
// of it. No vertex, triangle, hull or normal is copied, stored, emitted,
// simplified, decimated or converted; the JSON holds 6 numbers per part.
//
// WHY IT MEASURES INSIDE MUJOCO
// -----------------------------
// MuJoCo's compiler does not keep a mesh in its file frame: it moves the origin
// to the mesh centre of mass, rotates the axes onto the inertia principal axes,
// and folds the inverse of that into geom_pos/geom_quat so the world placement
// is unchanged (mesh_pos/mesh_quat record what it did). Two consequences this
// tool exists to handle:
//
//  * model.geom_aabb is the box in the PRINCIPAL-AXES frame. For a part whose
//    CAD axes are oblique to its principal axes that box is substantially
//    larger than the CAD box - hip_l measures 20.1 x 25.3 x 43.2 mm there
//    versus 32.45 x 34.50 x 19.00 mm in CAD. Using geom_aabb would silently
//    inflate those hulls, so every box is measured in the CAD frame (verts
//    mapped back through mesh_pos/mesh_quat) and authored with the MJCF's own
//    pos/quat. The per-geom self-check proves the two placements agree.
//  * "Down" is not a mesh axis. The soles are measured in their own fitted
//    support plane, not along whichever mesh axis happens to be thinnest.
//
// Run from the W tree (that is where @mujoco/mujoco is installed out of band):
//   node spikes/659/duck/measure-collision-hulls.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'microduck');
const OUT = path.join(HERE, 'collision-hulls.measured.json');
const mm = (v) => +(v * 1000).toFixed(3);
const f2 = (v) => (v * 1000).toFixed(2);

// The soles' designed cant. The fitted support plane measures 5.01 deg (left)
// and 5.26 deg (right) about CAD Y; the default pose rolls the hips by exactly
// 0.08726646 rad = 5.0000 deg in the opposite sense, which is what puts the
// plate flat on the ground in the STAND pose. 5 deg is therefore the design
// value and the fit residual is noise - so the frame is built at EXACTLY 5 deg
// and both soles get the exact mirror of one another.
const SOLE_CANT_DEG = 5;

// quaternion helpers, MuJoCo order (w, x, y, z)
function qRot(q, v) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}
const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
const qNorm = (q) => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return q.map((v) => v / n);
};

const mod = await import('@mujoco/mujoco');
const factory = mod.default ?? mod;
const lib = typeof factory === 'function' ? await factory() : factory;

const xml = readFileSync(path.join(FIX, 'mjcf', 'prepared-scene.xml'), 'utf8');
const meshFiles = [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);

const vfs = new lib.MjVFS();
for (const name of meshFiles) {
  vfs.addBuffer(name, new Uint8Array(readFileSync(path.join(FIX, 'mjcf', 'assets', name))));
}
vfs.addBuffer('scene.xml', new TextEncoder().encode(xml));
const model = lib.MjModel.from_xml_path('scene.xml', vfs);
vfs.delete();

const arr = (v) => Array.from(v);
const geomType = arr(model.geom_type);
const geomDataId = arr(model.geom_dataid);
const geomBodyId = arr(model.geom_bodyid);
const mGeomPos = arr(model.geom_pos);
const mGeomQuat = arr(model.geom_quat);
const meshVertAdr = arr(model.mesh_vertadr);
const meshVertNum = arr(model.mesh_vertnum);
const meshVert = arr(model.mesh_vert);
const meshPos = arr(model.mesh_pos);
const meshQuat = arr(model.mesh_quat);

const OBJ_GEOM = lib.mjtObj.mjOBJ_GEOM.value;
const OBJ_BODY = lib.mjtObj.mjOBJ_BODY.value;
const OBJ_MESH = lib.mjtObj.mjOBJ_MESH.value;
const MESH_TYPE = lib.mjtGeom.mjGEOM_MESH.value;
const nameOf = (kind, id) => lib.mj_id2name(model, kind, id) || ('#' + id);

/** Vertices of mesh `d`, mapped back into its CAD (file) frame. */
function cadVerts(d) {
  const n = meshVertNum[d];
  const base = meshVertAdr[d] * 3;
  const mp = meshPos.slice(d * 3, d * 3 + 3);
  const mq = qNorm(meshQuat.slice(d * 4, d * 4 + 4));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = [meshVert[base + i * 3], meshVert[base + i * 3 + 1], meshVert[base + i * 3 + 2]];
    const c = qRot(mq, v);
    out[i] = [c[0] + mp[0], c[1] + mp[1], c[2] + mp[2]];
  }
  return out;
}

function bbox(pts) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) {
    if (p[k] < mn[k]) mn[k] = p[k];
    if (p[k] > mx[k]) mx[k] = p[k];
  }
  return { mn, mx };
}

/** Least-squares support plane z = a*x + b*y + c, pushed down until no vertex
 *  lies below it. Iterated so only the ground-facing face drives the fit. */
function fitSupportPlane(pts) {
  let a = 0, b = 0, c = Math.min(...pts.map((p) => p[2]));
  for (let it = 0; it < 40; it++) {
    const sel = pts.filter((p) => p[2] - (a * p[0] + b * p[1] + c) < 0.0015);
    let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, S1 = 0, Sxz = 0, Syz = 0, Sz = 0;
    for (const p of sel) {
      Sxx += p[0] * p[0]; Sxy += p[0] * p[1]; Syy += p[1] * p[1];
      Sx += p[0]; Sy += p[1]; S1 += 1;
      Sxz += p[0] * p[2]; Syz += p[1] * p[2]; Sz += p[2];
    }
    const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, S1]];
    const r = [Sxz, Syz, Sz];
    const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
      - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
      + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const cof = (i, j) => {
      const ri = [0, 1, 2].filter((k) => k !== j);
      const ci = [0, 1, 2].filter((k) => k !== i);
      const s = ((i + j) % 2 === 0) ? 1 : -1;
      return s * (M[ri[0]][ci[0]] * M[ri[1]][ci[1]] - M[ri[0]][ci[1]] * M[ri[1]][ci[0]]) / det;
    };
    const na = cof(0, 0) * r[0] + cof(0, 1) * r[1] + cof(0, 2) * r[2];
    const nb = cof(1, 0) * r[0] + cof(1, 1) * r[1] + cof(1, 2) * r[2];
    const nc = cof(2, 0) * r[0] + cof(2, 1) * r[1] + cof(2, 2) * r[2];
    if (!Number.isFinite(na)) break;
    let worst = Infinity;
    for (const p of pts) worst = Math.min(worst, p[2] - (na * p[0] + nb * p[1] + nc));
    a = na; b = nb; c = nc + worst;
  }
  return { a, b, c };
}

/** Support function of the hull, box and ellipsoid over a direction sphere -
 *  the measurement behind each primitive choice in the generator. */
const DIRS = [];
for (let i = 0, N = 800; i < N; i++) {
  const z = 1 - (2 * i + 1) / N;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const th = i * Math.PI * (3 - Math.sqrt(5));
  DIRS.push([r * Math.cos(th), r * Math.sin(th), z]);
}
function primitiveFitError(pts, mn, mx) {
  const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
  const half = [0, 1, 2].map((k) => (mx[k] - mn[k]) / 2);
  const loc = pts.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  const hull = DIRS.map((u) => Math.max(...loc.map((p) => u[0] * p[0] + u[1] * p[1] + u[2] * p[2])));
  const stat = (f) => {
    let s = 0, over = -Infinity;
    for (let i = 0; i < DIRS.length; i++) {
      const e = f(DIRS[i]) - hull[i];
      s += e * e;
      if (e > over) over = e;
    }
    return { rms: Math.sqrt(s / DIRS.length), maxOver: over };
  };
  return {
    box: stat((u) => Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2]),
    ellipsoid: stat((u) => Math.hypot(u[0] * half[0], u[1] * half[1], u[2] * half[2])),
  };
}

const parts = {};
const geoms = [];
const seen = new Set();

// The MJCF's own geom poses, in document order of the mesh geoms. model.geom_pos
// / geom_quat are the COMPOSED ones (mesh frame folded in); a CAD-frame box has
// to be authored with the poses as the document states them.
const xmlGeoms = [...xml.matchAll(/<geom\b[^>]*\bmesh="[^"]+"[^>]*\/>/g)].map((m) => {
  const tag = m[0];
  const num = (a) => {
    const r = new RegExp('\\b' + a + '="([^"]+)"').exec(tag);
    return r ? r[1].trim().split(/\s+/).map(Number) : null;
  };
  const str = (a) => {
    const r = new RegExp('\\b' + a + '="([^"]+)"').exec(tag);
    return r ? r[1] : null;
  };
  return {
    mesh: str('mesh'), name: str('name'), cls: str('class'), material: str('material'),
    pos: num('pos') ?? [0, 0, 0], quat: num('quat') ?? [1, 0, 0, 0],
  };
});

let cursor = 0;
console.log('model: ngeom=' + model.ngeom + ' nmesh=' + model.nmesh + '\n');

for (let g = 0; g < model.ngeom; g++) {
  if (geomType[g] !== MESH_TYPE) continue;
  const d = geomDataId[g];
  const mname = nameOf(OBJ_MESH, d);
  const bname = nameOf(OBJ_BODY, geomBodyId[g]);
  const doc = xmlGeoms[cursor++];
  const cad = cadVerts(d);
  const { mn, mx } = bbox(cad);

  // Self-check: the CAD box centre, placed with the DOCUMENT pose, must land
  // exactly where MuJoCo puts it with its composed pose.
  const centre = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2);
  const mp = meshPos.slice(d * 3, d * 3 + 3);
  const mq = qNorm(meshQuat.slice(d * 4, d * 4 + 4));
  const viaDoc = qRot(qNorm(doc.quat), centre).map((v, i) => v + doc.pos[i]);
  const viaMj = qRot(qNorm(mGeomQuat.slice(g * 4, g * 4 + 4)),
    qRot(qConj(mq), centre.map((v, i) => v - mp[i])))
    .map((v, i) => v + mGeomPos.slice(g * 3, g * 3 + 3)[i]);
  const selfCheckUm = Math.max(...viaDoc.map((v, i) => Math.abs(v - viaMj[i]))) * 1e6;

  geoms.push({
    mesh: mname, body: bname, name: doc.name, class: doc.cls, selfCheckUm: +selfCheckUm.toFixed(3),
  });

  if (seen.has(mname)) continue;
  seen.add(mname);

  const fit = primitiveFitError(cad, mn, mx);
  const rec = {
    verts: cad.length,
    cad_min_mm: mn.map(mm),
    cad_max_mm: mx.map(mm),
    cad_size_mm: [0, 1, 2].map((k) => mm(mx[k] - mn[k])),
    fit_rms_mm: { box: mm(fit.box.rms), ellipsoid: mm(fit.ellipsoid.rms) },
    fit_max_overreach_mm: { box: mm(fit.box.maxOver), ellipsoid: mm(fit.ellipsoid.maxOver) },
  };

  console.log(mname.padEnd(20) + ' size ' + rec.cad_size_mm.map((v) => v.toFixed(2)).join(' x ').padEnd(26)
    + '  fit rms box ' + rec.fit_rms_mm.box.toFixed(2) + ' / ellipsoid ' + rec.fit_rms_mm.ellipsoid.toFixed(2)
    + '  max-overreach box ' + rec.fit_max_overreach_mm.box.toFixed(2)
    + ' / ellipsoid ' + rec.fit_max_overreach_mm.ellipsoid.toFixed(2) + ' mm');

  // ── the soles get their support plane and their ground band ──────────────
  if (mname === 'sole_left' || mname === 'sole_right') {
    const sign = mname === 'sole_left' ? +1 : -1;
    const plane = fitSupportPlane(cad);
    const fittedCantDeg = Math.atan(plane.a) * 180 / Math.PI;
    // Frame: CAD rotated by +/- SOLE_CANT_DEG about CAD Y, so the plate's
    // underside normal lands on +Z and the box's -Z face IS that underside.
    const ang = sign * SOLE_CANT_DEG * Math.PI / 180;
    const q = [Math.cos(ang / 2), 0, Math.sin(ang / 2), 0];
    const rot = cad.map((p) => qRot(q, p));
    const rb = bbox(rot);
    const bands = {};
    for (const h of [0.0002, 0.0005, 0.001]) {
      const sel = rot.filter((p) => p[2] <= rb.mn[2] + h);
      bands[String(h * 1000)] = {
        x_mm: [mm(Math.min(...sel.map((p) => p[0]))), mm(Math.max(...sel.map((p) => p[0])))],
        y_mm: [mm(Math.min(...sel.map((p) => p[1]))), mm(Math.max(...sel.map((p) => p[1])))],
        verts: sel.length,
      };
    }
    rec.sole = {
      cant_deg_used: sign * SOLE_CANT_DEG,
      cant_deg_fitted: +fittedCantDeg.toFixed(3),
      q_cad_to_plane: q.map((v) => +v.toFixed(9)),
      plane_frame_min_mm: rb.mn.map(mm),
      plane_frame_max_mm: rb.mx.map(mm),
      plane_frame_size_mm: [0, 1, 2].map((k) => mm(rb.mx[k] - rb.mn[k])),
      ground_band: bands,
    };
    console.log('  ' + mname + ' support plane: fitted cant ' + fittedCantDeg.toFixed(3)
      + ' deg, used ' + (sign * SOLE_CANT_DEG) + ' deg');
    console.log('    plane-frame size ' + rec.sole.plane_frame_size_mm.map((v) => v.toFixed(2)).join(' x ') + ' mm');
    for (const [k, v] of Object.entries(bands)) {
      console.log('    ground band +' + k + 'mm: ' + (v.x_mm[1] - v.x_mm[0]).toFixed(2)
        + ' x ' + (v.y_mm[1] - v.y_mm[0]).toFixed(2) + ' mm (' + v.verts + ' verts)');
    }
  }
  parts[mname] = rec;
}

model.delete();

const out = {
  _comment: [
    'plan-659 - MEASURED DIMENSIONS of the Microduck collision meshes. Dimensions only;',
    'no geometry. Produced by spikes/659/duck/measure-collision-hulls.mjs from the',
    'CC BY-NC-SA 4.0 STL fixture, which is gitignored and not shipped. This file is the',
    'input of build-collision-primitives.mjs, which needs no mesh. Lengths in millimetres,',
    'in each mesh\'s own CAD (file) frame; the MJCF geom pos/quat place that frame.',
  ],
  generated_by: 'spikes/659/duck/measure-collision-hulls.mjs',
  source_scene: 'fixtures/microduck/mjcf/prepared-scene.xml',
  sole_cant_deg: SOLE_CANT_DEG,
  geoms,
  parts,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log('\nwritten: ' + OUT);
console.log('placement self-check, worst of ' + geoms.length + ' geoms: '
  + Math.max(...geoms.map((g) => g.selfCheckUm)).toFixed(3) + ' um');
