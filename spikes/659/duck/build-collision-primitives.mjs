// realvirtual.io (R) - plan-659, stage 2 of the geometry own-build.
//
// Builds `rv-duck-collision.xml`: the MJCF the demo actually simulates, with
// every collision hull an ORIGINAL MuJoCo primitive instead of a third-party
// mesh. Stage 1 (`build-duck.mjs`) did the same for the VISIBLE geometry.
//
// LICENCE PROVENANCE (read before touching this file)
// ---------------------------------------------------
// Inputs, both free of CC material:
//
//   ../fixtures/microduck/mjcf/prepared-scene.xml   Apache-2.0 XML TEXT: the body
//       tree, every joint, every <inertial>, the actuator classes, the sensors,
//       the sites, the option block and the STAND keyframe. Copied through
//       UNCHANGED except for the eleven collision geoms and the <mesh> assets.
//   collision-hulls.measured.json                   DIMENSIONS of the original
//       hulls - six numbers per part plus the soles' support plane. Produced
//       once by `measure-collision-hulls.mjs` from the CC BY-NC-SA 4.0 STL
//       fixture, which is gitignored, is not shipped, and is needed by nothing
//       else. Measuring an object is not copying it; a bounding box is a fact.
//
// What this script emits is therefore not a derivative of the original meshes:
// no mesh is read, loaded, simplified, decimated, convexified or converted
// here, and the output file references none. The STL files can be deleted and
// the demo still runs; they are needed only to re-derive the JSON.
//
// WHAT IS TAKEN BIT-EXACT FROM THE MJCF, because the ONNX policy is trained on
// it and because mass is not ours to invent:
//   * the 15-body tree, every body pos/quat and every parent link
//   * all 14 hinge joints, their axes, ranges, actuator classes and order
//   * EVERY <inertial>: mass, centre of mass and the full inertia tensor.
//     Those are Apache-2.0 numbers and they decide the gait at least as much as
//     the hulls do. Guessing them would have been the real error. They are also
//     what makes the hull swap safe: every body carries an explicit <inertial>,
//     so with compiler inertiafromgeom="auto" the geoms contribute NO mass and
//     changing them cannot change a single inertial property. The test asserts
//     that (body_mass / body_inertia / body_ipos identical to the mesh scene).
//   * the sites, the <sensor> block, the actuators, <option timestep> and the
//     STAND keyframe
//
// HOW A PRIMITIVE IS PLACED
// -------------------------
// MuJoCo re-frames a mesh at compile time (origin to the centre of mass, axes
// onto the inertia principal axes) and folds the inverse into geom_pos/geom_quat
// - which is why `model.geom_pos` does not match the document and why
// `model.geom_aabb` is NOT the CAD box. The measured boxes are in each mesh's
// CAD (file) frame, which is the frame the DOCUMENT's pos/quat apply to, so:
//
//   geom frame in body  =  (doc.pos, doc.quat (x) q_fit)
//   primitive pos       =  doc.pos + R(doc.quat (x) q_fit) * centre_in_fit_frame
//
// with q_fit = identity for every part except the two soles. The measurement
// tool verifies this composition against MuJoCo's own numbers (0.000 um).
//
// Usage:  node spikes/659/duck/build-collision-primitives.mjs
//         (--out <path> to write elsewhere; default: ./rv-duck-collision.xml)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENE = path.join(HERE, '..', 'fixtures', 'microduck', 'mjcf', 'prepared-scene.xml');
const MEASURED = path.join(HERE, 'collision-hulls.measured.json');
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 && process.argv[outArg + 1]
  ? path.resolve(process.argv[outArg + 1])
  : path.join(HERE, 'rv-duck-collision.xml');

// ───────────────────────────────────────────────────────────────────────────
// THE PRIMITIVE PER PART, AND WHY
// ───────────────────────────────────────────────────────────────────────────
//
// Decision rule, applied uniformly: take the primitive with the lower
// support-function RMS error against the real hull; when the two are within
// 1 mm of each other, take the one that OVERREACHES the hull less (a proxy
// that sticks out snags on things the real part would have passed). Both
// numbers are measured per part and recorded in the JSON as `fit_rms_mm` and
// `fit_max_overreach_mm`, over 800 directions of a Fibonacci sphere.
//
// One hard override: the soles are boxes whatever the numbers say, because the
// defining feature of a sole is a FLAT underside and no other MuJoCo primitive
// has one. See SOLE_BAND_MM below for the part that actually matters.
//
//   part                size (mm)              box rms/over   ell rms/over   -> taken
//   power_support   54.49 x 17.00 x 83.49        6.29 / 10.63   6.45 /  2.42    ellipsoid (tie on rms, far less overreach; self-collision only)
//   np_f970         38.61 x 20.57 x 70.81        1.51 /  3.35   8.70 / -0.42    box       (it is a rectangular camera battery - rms 1.5 mm is near-exact)
//   hip_l           32.45 x 34.50 x 19.00        6.68 / 20.22   4.04 / 11.84    ellipsoid (rounded hip bracket)
//   leg              7.95 x 20.00 x 58.00        3.99 /  6.36   1.55 /  0.47    ellipsoid (rounded shin strut; the best fit of all nine)
//   sole_left/right 41.19 x 54.00 x 13.49        3.64 /  7.79   5.23 /  0.81    box       (override: flat canted plate)
//   top_head_shell  91.60 x 122.69 x 46.33      15.28 / 35.31  11.98 /  9.30    ellipsoid (a dome; a box would stand 35 mm proud at the corners)
//   jaw             91.42 x 68.70 x 29.42        6.50 / 19.30  10.31 / 10.44    box       (blocky beak shell)
//   bottom_head_shell 91.74 x 116.74 x 20.13    10.71 / 20.38   8.90 /  4.30    ellipsoid (shallow lower shell)
//
// Primitives are also cheaper than convexified meshes in the collision phase.
// That is a side effect, not a goal.
const PRIMITIVE = {
  power_support: 'ellipsoid',
  np_f970: 'box',
  hip_l: 'ellipsoid',
  leg: 'ellipsoid',
  sole_left: 'box',
  sole_right: 'box',
  top_head_shell: 'ellipsoid',
  jaw: 'box',
  bottom_head_shell: 'ellipsoid',
};

// ───────────────────────────────────────────────────────────────────────────
// THE SOLES - the one number that decides whether the duck still walks
// ───────────────────────────────────────────────────────────────────────────
//
// The sole is NOT a plate lying flat in its own CAD frame, and it is NOT a
// rocker either. Its underside is a FLAT plane canted 5 deg about CAD Y
// (measured: 5.01 deg left, 5.26 deg right), and the default pose rolls the
// hips by exactly 0.08726646 rad = 5.0000 deg the other way - so at STAND the
// plate lies flat on the floor. The 5 deg is a design value, the fit residual
// is noise, so the box frame is built at exactly 5 deg and the two soles are
// exact mirrors. Getting that cant wrong by 5 deg would stand the duck on the
// edges of its feet.
//
// The second trap is the SIZE of that flat face. The sole's bounding box is
// 41.19 x 54.00 mm in the canted frame, but the plate's edges are chamfered
// upwards, so only part of it ever touches the floor. Measured as the extent of
// the hull band within h of the support plane:
//
//     h = 0.2 mm   29.44 x 40.99 mm      (MuJoCo's own contact depths while the
//     h = 0.5 mm   31.68 x 43.33 mm       duck stands are 0.04 .. 0.20 mm, and
//     h = 1.0 mm   33.76 x 45.46 mm       up to ~1 mm on footfall)
//     envelope     41.19 x 54.00 mm      <- WRONG: +62 % support-polygon area
//
// A box at the envelope gives the duck a 62 % larger support polygon than it
// was trained on: it would stand more stably, the gait would change, and the
// measurement would be worthless. So the box takes the +0.5 mm band - the
// middle of the load range, within 8 % of either end - and the FULL hull
// thickness, so the ankle sits at exactly its original height above the floor.
//
// Mirror-symmetrised from the left sole: the two CAD hulls are exact mirrors in
// X (29.455..70.547 vs -70.548..-29.455), so the 0.15 mm difference between the
// two measured bands is vertex-sampling noise, and letting it through would
// give the duck two slightly different feet. The result is in fact MORE
// symmetric than the original, whose two mesh hulls sit 0.3 mm out of mirror.
//
// WHY A BOX, AND THE ONE DEVIATION IT COSTS - measured, not assumed
// -----------------------------------------------------------------
// The sole is the only one of the eleven hulls that matters: a scene with the
// other nine replaced and the two mesh soles kept is BIT-IDENTICAL to the
// original over 60 s. Those nine never touch anything (zero non-floor contacts
// in 500 control steps), so they are free; the sole decides everything.
//
// The box reproduces the gait, and the measurements say so. Integrated path
// length over 60 s, box against the original mesh hull:
//
//     vx = 0.20   0.011 m vs  1.031 m   both "no gait" - the policy holds a
//                                        stance below 0.25, as Phase 0 found
//     vx = 0.25   9.683 m vs  9.618 m   +0.7 %
//     vx = 0.30  10.394 m vs 10.428 m   -0.3 %
//     vx = 0.35  11.233 m vs 11.376 m   -1.3 %
//
// It costs exactly one deviation: HEADING. The box duck walks the same distance
// at the same speed but on a slow left arc of about 2.7 m radius (yaw drift
// ~3.4 deg/s at vx 0.25) where the mesh duck holds its heading to +/- 20 deg.
// The cause is measured and it is NOT a dimension: MuJoCo's box-vs-plane
// collider puts contacts on the face corners, so the stance foot gets a 43 mm
// contact spread from the first micron of penetration, against the mesh hull's
// 22 mm (mean over a 10 s walk) - and a stance foot that cannot pivot leaves
// the policy, which has no absolute heading reference, no way to correct yaw.
// Confirmed by what does NOT change it: the ground band (0.2 mm .. envelope,
// a 30 % size range), the cant (0 .. 6 deg) and a face scaled to 30 % all curve
// the same way.
//
// The alternatives were measured and are worse, which is why the box stays:
//   * ellipsoid sole - no contact face to push off from. No thickness works
//     across the speed range (2 .. 6 mm swept at vx 0.20/0.25/0.30/0.35: each
//     value fails at some speed, non-monotonically), and EVERY thickness walks
//     at vx = 0.20 where the original holds a stance. Picking the one that
//     happened to look best at vx = 0.25 would have been fitting noise.
//   * tread + plate (a slightly proud ellipsoid lens over a box) - correct
//     stance at 0.20, but it barely advances at any other speed.
// The box is also the only candidate with NO free parameter left to fit.
//
// `--band <0.2|0.5|1|envelope>`, `--cant`, `--sole-kind`, `--sole-scale`,
// `--sole-thick`, `--sole-proud`, `--sole-tread-r`, `--only`, `--except` exist
// for exactly those sweeps and are DIAGNOSIS ONLY - the shipped scene is the
// one this script writes with no flags at all.
const prArg = process.argv.indexOf('--sole-proud');
const SOLE_PROUD_MM = prArg >= 0 && process.argv[prArg + 1] ? Number(process.argv[prArg + 1]) : 0.5;
const trArg = process.argv.indexOf('--sole-tread-r');
const SOLE_TREAD_R_MM = trArg >= 0 && process.argv[trArg + 1] ? Number(process.argv[trArg + 1]) : null;
const ssArg = process.argv.indexOf('--sole-scale');
const SOLE_SCALE = ssArg >= 0 && process.argv[ssArg + 1] ? Number(process.argv[ssArg + 1]) : 1;
const stArg = process.argv.indexOf('--sole-thick');
const SOLE_THICK_MM = stArg >= 0 && process.argv[stArg + 1] ? Number(process.argv[stArg + 1]) : null;
const skArg = process.argv.indexOf('--sole-kind');
const SOLE_KIND = skArg >= 0 && process.argv[skArg + 1] ? process.argv[skArg + 1] : null;
const cantArg = process.argv.indexOf('--cant');
const CANT = cantArg >= 0 && process.argv[cantArg + 1] ? process.argv[cantArg + 1] : null;
const bandArg = process.argv.indexOf('--band');
const SOLE_BAND_MM = bandArg >= 0 && process.argv[bandArg + 1] ? process.argv[bandArg + 1] : '0.5';

const scene = readFileSync(SCENE, 'utf8');
const measured = JSON.parse(readFileSync(MEASURED, 'utf8'));

// ── quaternion helpers, MuJoCo order (w, x, y, z) ──────────────────────────
function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
function qNorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return q.map((v) => v / n);
}
function qRot(q, v) {
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
}
/** 9 significant digits, no exponent, trailing zeros trimmed. */
const fmt = (v) => {
  const s = (Math.abs(v) < 1e-12 ? 0 : v).toPrecision(9);
  return String(Number(s));
};
const triple = (v) => v.map(fmt).join(' ');

/**
 * Half-extents (metres) and centre (metres, in the fit frame) of the primitive
 * that replaces `mesh`, plus the rotation from the CAD frame to that fit frame.
 */
function hullFor(mesh) {
  const rec = measured.parts[mesh];
  if (!rec) throw new Error(`no measurement for mesh "${mesh}"`);
  if (rec.sole) {
    // Mirror-symmetrise: the left sole is the reference, the right one is its
    // mirror in the fit frame's X. The two CAD hulls are exact mirrors, so the
    // 0.15 mm difference between the two measured bands is sampling noise.
    const left = measured.parts.sole_left;
    const envelope = {
      x_mm: [left.sole.plane_frame_min_mm[0], left.sole.plane_frame_max_mm[0]],
      y_mm: [left.sole.plane_frame_min_mm[1], left.sole.plane_frame_max_mm[1]],
    };
    // An ellipsoid is INSCRIBED in the hull (it overreaches by 0.8 mm at worst),
    // so it takes the full envelope; a box is circumscribed on its own face, so
    // it takes the ground band.
    const kind = SOLE_KIND ?? PRIMITIVE[mesh];
    const lb = (kind === 'ellipsoid' || SOLE_BAND_MM === 'envelope')
      ? envelope
      : left.sole.ground_band[SOLE_BAND_MM];
    if (!lb) throw new Error(`sole band "${SOLE_BAND_MM}" not measured`);
    const sign = mesh === 'sole_left' ? +1 : -1;
    // `--cant fitted|<deg>` overrides the 5 deg design value (diagnosis).
    let qFit = qNorm(rec.sole.q_cad_to_plane);
    if (CANT !== null) {
      const deg = CANT === 'fitted' ? Math.abs(rec.sole.cant_deg_fitted) : Number(CANT);
      const ang = sign * deg * Math.PI / 180;
      qFit = [Math.cos(ang / 2), 0, Math.sin(ang / 2), 0];
    }
    const xHalf = (lb.x_mm[1] - lb.x_mm[0]) / 2 * SOLE_SCALE;
    const xMid = sign * (lb.x_mm[0] + lb.x_mm[1]) / 2;
    const yHalf = (lb.y_mm[1] - lb.y_mm[0]) / 2 * SOLE_SCALE;
    const yMid = (lb.y_mm[0] + lb.y_mm[1]) / 2;
    // Bottom exactly on the measured support plane, so the ankle keeps its
    // height above the floor. Thickness from the FULL hull unless overridden.
    const zMin = left.sole.plane_frame_min_mm[2];
    const zHalf = SOLE_THICK_MM !== null
      ? SOLE_THICK_MM / 2
      : (left.sole.plane_frame_max_mm[2] - zMin) / 2;
    if (kind === 'composite') {
      // TREAD + PLATE, the measured shape of the underside in two primitives.
      //
      // The sole's underside is a flat plate whose face rises slightly towards
      // the rim: measured as the half-width of the hull band at depth h, it is
      // 15.84 x 21.67 mm at 0.5 mm, 16.88 x 22.73 mm at 1.0 mm and 18.14 x
      // 24.14 mm at 2.0 mm. So it is SLIGHTLY CONVEX and FLATTENS as it sinks,
      // and MuJoCo's convex collider reproduces exactly that: shallow contact
      // is localised near the middle, deep contact spreads over the face.
      // Neither primitive alone does both - a box is flat at every depth (and
      // hands the stance foot a 43 mm contact spread from the first micron,
      // against the hull's 22 mm, which locks it in yaw and steers the duck
      // into a 1.8 m circle), an ellipsoid is curved at every depth (and never
      // gets a flat face to push off from). Two geoms do:
      //   * ellipsoid TREAD, bottom on the support plane, as flat as the
      //     measured rim curvature (a^2/c = 256 mm across the foot, 439 mm
      //     fore-aft - the measured rise of 0.5 mm at the band edge);
      //   * box PLATE at the ground-band size, its face TREAD_PROUD_MM above
      //     the support plane, so it engages only once the foot has sunk that
      //     far - which is where the real face flattens out too.
      const c = (SOLE_TREAD_R_MM ?? 256);
      const treadHalfZ = (xHalf * xHalf) / c / 1000;
      return [
        {
          kind: 'ellipsoid',
          half: [xHalf / 1000, yHalf / 1000, treadHalfZ],
          centre: [xMid / 1000, yMid / 1000, zMin / 1000 + treadHalfZ],
          qFit,
          note: `sole tread, ellipsoid, rim radius ${c} mm`,
        },
        {
          kind: 'box',
          half: [xHalf / 1000, yHalf / 1000, zHalf / 1000],
          centre: [xMid / 1000, yMid / 1000, (zMin + SOLE_PROUD_MM) / 1000 + zHalf / 1000],
          qFit,
          note: `sole plate, box, face ${SOLE_PROUD_MM} mm above the support plane`,
        },
      ];
    }
    return [{
      kind,
      half: [xHalf, yHalf, zHalf].map((v) => v / 1000),
      centre: [xMid, yMid, zMin + zHalf].map((v) => v / 1000),
      qFit,
      note: kind === 'ellipsoid'
        ? `sole, hull envelope, cant ${rec.sole.cant_deg_used} deg`
        : `sole, +${SOLE_BAND_MM} mm ground band, cant ${rec.sole.cant_deg_used} deg`,
    }];
  }
  const mn = rec.cad_min_mm;
  const mx = rec.cad_max_mm;
  return [{
    kind: PRIMITIVE[mesh],
    half: [0, 1, 2].map((k) => (mx[k] - mn[k]) / 2000),
    centre: [0, 1, 2].map((k) => (mx[k] + mn[k]) / 2000),
    qFit: [1, 0, 0, 0],
    note: 'CAD bounding box',
  }];
}

// ── rewrite the eleven mesh geoms ──────────────────────────────────────────
const GEOM_RE = /<geom\b[^>]*\bmesh="[^"]+"[^>]*\/>/g;
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]+)"`).exec(tag);
  return m ? m[1] : null;
};
const nums = (tag, name) => {
  const v = attr(tag, name);
  return v ? v.trim().split(/\s+/).map(Number) : null;
};

// `--only a,b` / `--except a,b` build HYBRID scenes: only the named meshes (or
// all but them) become primitives, the rest stay meshes. Diagnosis only - it is
// how the steering-bias cause was isolated; a hybrid still needs the CC fixture.
const onlyArg = process.argv.indexOf('--only');
const exceptArg = process.argv.indexOf('--except');
const ONLY = onlyArg >= 0 && process.argv[onlyArg + 1] ? process.argv[onlyArg + 1].split(',') : null;
const EXCEPT = exceptArg >= 0 && process.argv[exceptArg + 1] ? process.argv[exceptArg + 1].split(',') : [];
const wanted = (mesh) => (ONLY ? ONLY.includes(mesh) : true) && !EXCEPT.includes(mesh);

const log = [];
let replaced = 0;
let out = scene.replace(GEOM_RE, (tag) => {
  const mesh = attr(tag, 'mesh');
  if (!wanted(mesh)) return tag;
  const docPos = nums(tag, 'pos') ?? [0, 0, 0];
  const docQuat = qNorm(nums(tag, 'quat') ?? [1, 0, 0, 0]);
  const name = attr(tag, 'name');
  const cls = attr(tag, 'class');
  const material = attr(tag, 'material');
  const prims = hullFor(mesh);

  const emitted = prims.map((h, i) => {
    // geom frame in body = doc pose composed with the fit frame; the primitive
    // is axis aligned in that frame and centred at h.centre.
    const quat = qNorm(qMul(docQuat, qConj(h.qFit)));
    const pos = qRot(quat, h.centre).map((v, k) => v + docPos[k]);
    const parts = [`<geom type="${h.kind}"`];
    // Only the FIRST primitive keeps the document's geom name: it is the one a
    // test or the runtime addresses (`left_foot_collision`), and for a
    // composite sole it is the tread, i.e. the one that touches first.
    if (name && i === 0) parts.push(`name="${name}"`);
    if (name && i > 0) parts.push(`name="${name}_${i}"`);
    if (cls) parts.push(`class="${cls}"`);
    parts.push(`size="${triple(h.half)}"`);
    parts.push(`pos="${triple(pos)}"`);
    parts.push(`quat="${triple(quat)}"`);
    if (material) parts.push(`material="${material}"`);
    parts.push('/>');
    log.push(`  ${mesh.padEnd(18)} -> ${h.kind.padEnd(9)} size `
      + `${h.half.map((v) => (v * 2000).toFixed(2)).join(' x ')} mm   (${h.note})`);
    return parts.join(' ');
  });
  replaced += 1;
  return emitted.join('\n      ');
});

const HYBRID = ONLY !== null || EXCEPT.length > 0;
if (!HYBRID && replaced !== measured.geoms.length) {
  throw new Error(`replaced ${replaced} geoms, the measurement knows ${measured.geoms.length}`);
}

// ── drop every mesh asset nothing references any more ──────────────────────
const stillUsed = new Set(
  [...out.matchAll(/<geom\b[^>]*\bmesh="([^"]+)"[^>]*\/>/g)].map((m) => m[1]),
);
const before = (out.match(/<mesh\b[^>]*\/>/g) ?? []).length;
out = out.replace(/\s*<mesh\b[^>]*\bfile="([^"]+)"[^>]*\/>/g, (tag, file) =>
  (stillUsed.has(file.replace(/\.stl$/i, '')) ? tag : ''));
const after = (out.match(/<mesh\b[^>]*\/>/g) ?? []).length;
if (!HYBRID && after !== 0) throw new Error(`${after} <mesh> assets survived`);

// ── contact stiffness: the ONE thing not passed through unchanged ──────────
//
// plan-673 O19. Thomas: *"sometimes the walker body sinks too much into bottom
// - please align more the body with the original dimensions - the collider."*
//
// The geometry was the first suspect and the measurement cleared it. In the
// stand pose the lowest VISUAL point of the duck is 2.90 mm and the lowest
// floor-colliding COLLIDER point is 2.82 mm — the soles match the shell to
// 0.08 mm — and the trunk's floor-colliding hull reaches 13.4 mm BELOW the
// visible trunk, i.e. it is larger downwards, not smaller. Nothing to align.
//
// What sinks is CONTACT COMPLIANCE, which is why Thomas saw it "sometimes": it
// is load-dependent. MuJoCo's own contact distances, robot geoms against the
// floor only, measured in the production build:
//
//                       stock          with the two attributes below
//     standing          1.64 mm        0.14 mm
//     walking           3.09 mm        1.22 mm
//     landing a push   10.22 mm        6.81 mm     (medians of 3 runs each;
//                                                   every stiffened run beat
//                                                   every stock run)
//
// 10 mm on a robot whose base stands at 120 mm, with a 13.5 mm thick sole, is a
// whole sole swallowed by the floor at a hard landing. The cause is that
// `prepared-scene.xml` declares only `<option timestep="0.005"/>`, so CONTACTS
// run on MuJoCo's stock `solimp` — width 1 mm, dmax 0.95, i.e. still 5 %
// compliant once saturated — and stock `solref` timeconst 0.02 s, four
// timesteps to correct an error.
//
// THE NUMBERS ARE NOT INVENTED HERE. The fixture already states exactly this
// stiffness one line further down, as `<equality solref="0.002 1"
// solimp="0.99 0.999 0.0005 0.5 2"/>` — and this model declares no equality
// constraint at all, so it has never done anything. Somebody tightened the
// wrong constraint class. The only change made to their intent is the time
// constant: 0.002 s is below a single timestep, where MuJoCo asks for at least
// two, so it becomes 0.01 s = 2 x 0.005.
//
// THE PRICE, MEASURED AND DELIBERATE: walking is unaffected (0 falls in three
// 12 s walks before and after, distance no worse) and the solver actually
// converges in FEWER iterations (20/25/5 -> 1/2/7, a better-conditioned
// contact), but a DELIBERATE push tips the duck about twice as often (1/2/2
// falls -> 3/4/3 after four pushes each). A stiffer floor transmits the shove
// more sharply and the policy was trained against the stock contact. Every fall
// is recovered by the stand policy in every run, and the demo text already
// invites the visitor to shove it and watch it get up — so the trade was taken
// knowingly: a body that visibly sinks is a defect, a duck that falls over when
// kicked is the demo. Reverse it by deleting CONTACT_STIFFNESS below.
const CONTACT_STIFFNESS = ' solref="0.01 1" solimp="0.99 0.999 0.0005 0.5 2"';
// Both sides of the pair, because MuJoCo mixes the two geoms' parameters: with
// only the floor stiffened the impact penetration fell by 17 % instead of 33 %.
// (Whitespace-tolerant on purpose — the fixture is CRLF, and a `\n` literal
// silently matched nothing the first time.)
const stiffenedCollision = out.replace(
  /(<default class="collision">\s*<geom\b[^>]*?)(\s*\/>)/,
  `$1${CONTACT_STIFFNESS}$2`,
);
if (stiffenedCollision === out) {
  throw new Error('the `collision` default class was not found — contact stiffness not applied');
}
out = stiffenedCollision;
const stiffenedFloor = out.replace(
  /(<geom\b[^>]*\bname="floor"[^>]*?)(\s*\/>)/,
  `$1${CONTACT_STIFFNESS}$2`,
);
if (stiffenedFloor === out) {
  throw new Error('the floor geom was not found — contact stiffness not applied to the floor');
}
out = stiffenedFloor;

// ── header ─────────────────────────────────────────────────────────────────
const header = `<!--
  GENERATED - do not edit. Source: spikes/659/duck/build-collision-primitives.mjs
  (node spikes/659/duck/build-collision-primitives.mjs)

  plan-659 stage 2: the Microduck scene with every collision hull replaced by an
  original MuJoCo primitive. Derived from two inputs that carry no CC material:

    fixtures/microduck/mjcf/prepared-scene.xml   Apache-2.0 XML text - the body
        tree, all 14 joints, EVERY <inertial> (mass, COM, full inertia tensor),
        the actuator classes, sensors, sites, <option> and the STAND keyframe,
        all copied through unchanged.
    spikes/659/duck/collision-hulls.measured.json  measured DIMENSIONS of the
        original hulls (bounding boxes, the soles' support plane and ground
        band). Dimensions are facts, not expressions.

  ${replaced} mesh collision geoms became primitives; ${before} <mesh> assets were
  dropped. This file references no mesh file and the demo needs none:

${log.join('\n')}

  The soles carry the load-bearing decision: their underside is a flat plane
  canted 5 deg about CAD Y, which the default pose's 5 deg hip roll cancels, and
  the box takes the +${SOLE_BAND_MM} mm ground band (31.68 x 43.33 mm) rather than the
  41.19 x 54.00 mm envelope - the envelope would hand the duck a 62 % larger
  support polygon than it was trained on. Full hull thickness is kept, so the
  ankle sits at its original height.

  Because every body has an explicit <inertial>, the geoms contribute no mass
  and this swap changes no inertial property at all. Contact behaviour DOES
  change, by design; see the plan for the new acceptance criterion.

  ONE attribute pair is added rather than passed through (plan-673 O19): the
  \`collision\` default class and the floor geom carry${CONTACT_STIFFNESS}.
  Contacts otherwise run on MuJoCo's stock solimp (width 1 mm, dmax 0.95), and
  the robot then sank 10.2 mm into the floor at a hard landing against 0.14 mm
  standing - load-dependent, which is why it only showed "sometimes". These are
  the fixture's OWN numbers: it states them on <equality>, which this model does
  not use. The time constant is 0.01 s rather than their 0.002 s because MuJoCo
  wants at least two timesteps. Price, measured: walking unchanged (0 falls
  either way), solver iterations lower, but a deliberate push tips it about
  twice as often. The generator throws if either site is missing.
-->
`;

out = out.replace(/^<mujoco\b/, `${header}<mujoco`);
writeFileSync(OUT, out);

console.log(`${replaced} collision geoms replaced, ${before} mesh assets dropped`);
console.log(log.join('\n'));
console.log(`written: ${OUT}`);
