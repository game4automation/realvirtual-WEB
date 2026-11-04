// realvirtual.io (R) - plan-659 stage 2 measurement.
//
// Walks the duck in the primitive scene and, when the gitignored CC BY-NC-SA
// STL fixture happens to be present, in the original mesh scene too, and prints
// the behavioural comparison that is the acceptance criterion of this stage.
//
// WHY THE CRITERION CHANGED. Stage 2 replaces every collision hull, so the
// trajectory changes and the old bit-exact `qpos` golden cannot apply - a
// different hull is a different contact, and demanding the same numbers would
// be demanding that the work had not been done. What must hold is BEHAVIOUR:
// the same gait at the same speed, the same stance below the gait-onset
// command, no sinking, no explosion, and recovery after a fall. Integrated PATH
// LENGTH is the honest measure of "the gait is the same" - net displacement
// mixes the gait with the heading, and the heading is the one thing that did
// change (see build-collision-primitives.mjs).
//
// It runs the control loop directly on `@mujoco/mujoco` + `onnxruntime-node`,
// reproducing `make-microduck-fixtures.py::Loop`, so the measurement does not
// depend on the TypeScript port it is meant to judge.
//
//   node spikes/659/duck/compare-collision-walk.mjs [--seconds 60] [--runs 3]
//   node spikes/659/duck/compare-collision-walk.mjs --scene <path>   (extra scene)

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '..', 'fixtures', 'microduck');
const numArg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const strArg = (n) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const SECONDS = numArg('seconds', 60);
const RUNS = numArg('runs', 3);
const VXS = (strArg('vx') ?? '0.2,0.25,0.3,0.35').split(',').map(Number);

const JOINTS = 14;
const DECIMATION = 4;
const DEFAULT_POSE = Float32Array.from([
  0.0, -0.08726646259971647, -0.457924, -0.004940, 0.452984,
  0.3490658503988659, 0.3490658503988659, 0.0, 0.0,
  0.0, 0.08726646259971647, 0.457924, 0.004940, -0.452984,
]);
const INIT_BASE_Z = 0.125;
/** plan 9.9 fall criterion. */
const FALL_GZ = -0.7;
const FALL_HEIGHT = 0.08;

const mod = await import('@mujoco/mujoco');
const factory = mod.default ?? mod;
const lib = typeof factory === 'function' ? await factory() : factory;
const ortm = await import('onnxruntime-node');
const ORT = ortm.default ?? ortm;

function compile(xmlPath) {
  const xml = readFileSync(xmlPath, 'utf8');
  const names = [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
  const vfs = new lib.MjVFS();
  for (const n of names) {
    vfs.addBuffer(n, new Uint8Array(readFileSync(path.join(FIX, 'mjcf', 'assets', n))));
  }
  vfs.addBuffer('s.xml', new TextEncoder().encode(xml));
  const model = lib.MjModel.from_xml_path('s.xml', vfs);
  vfs.delete();
  return model;
}

function quatRotateInverse(q, v) {
  const w = q[0];
  const qv = [q[1], q[2], q[3]];
  const dot = qv[0] * v[0] + qv[1] * v[1] + qv[2] * v[2];
  const cr = [
    qv[1] * v[2] - qv[2] * v[1],
    qv[2] * v[0] - qv[0] * v[2],
    qv[0] * v[1] - qv[1] * v[0],
  ];
  return [0, 1, 2].map((i) => v[i] * (2 * w * w - 1) + cr[i] * (-2 * w) + qv[i] * dot * 2);
}

/** One run. `pushVy` applies a sideways base velocity after 2 s, to exercise
 *  the fall and the recovery with the stand policy. */
async function walk(model, sessions, { vx, steps, dz = 0, pushVy = 0 }) {
  const data = new lib.MjData(model);
  const arr = (v) => Array.from(v);
  const trnid = arr(model.actuator_trnid);
  const jq = arr(model.jnt_qposadr);
  const jd = arr(model.jnt_dofadr);
  const qi = [];
  const vi = [];
  for (let i = 0; i < model.nu; i++) { qi.push(jq[trnid[i * 2]]); vi.push(jd[trnid[i * 2]]); }
  const trunk = lib.mj_name2id(model, lib.mjtObj.mjOBJ_BODY.value, 'trunk_base');
  const gAdr = arr(model.sensor_adr)[
    lib.mj_name2id(model, lib.mjtObj.mjOBJ_SENSOR.value, 'imu_ang_vel')];
  const fj = lib.mj_name2id(model, lib.mjtObj.mjOBJ_JOINT.value, 'trunk_base_freejoint');
  const a = jq[fj];
  const dofA = jd[fj];

  let qp = data.qpos;
  qp[a] = 0; qp[a + 1] = 0; qp[a + 2] = INIT_BASE_Z;
  qp[a + 3] = 1; qp[a + 4] = 0; qp[a + 5] = 0; qp[a + 6] = 0;
  for (let i = 0; i < model.nu; i++) qp[qi[i]] = DEFAULT_POSE[i];
  qp[a + 2] += dz;
  let ct = data.ctrl;
  for (let i = 0; i < model.nu; i++) ct[i] = DEFAULT_POSE[i];
  lib.mj_forward(model, data);

  const lastAction = new Float32Array(JOINTS);
  const cmd = new Float32Array(13);
  cmd[0] = vx;
  const dt = model.opt.timestep * DECIMATION;
  let pathLen = 0;
  let px = data.qpos[a];
  let py = data.qpos[a + 1];
  let minH = data.qpos[a + 2];
  let falls = 0;
  let recoveries = 0;
  let fallen = false;
  let below = 0;
  let above = 0;
  let maxNcon = 0;
  let usingStand = false;

  for (let k = 0; k < steps; k++) {
    if (pushVy !== 0 && k === Math.round(2 / dt)) {
      const qv = data.qvel;
      qv[dofA + 1] += pushVy;
    }
    const kind = (usingStand && sessions.stand) ? 'stand' : 'walking';
    const session = sessions[kind];
    const sd = data.sensordata;
    const xq = data.xquat;
    const grav = quatRotateInverse(
      [xq[trunk * 4], xq[trunk * 4 + 1], xq[trunk * 4 + 2], xq[trunk * 4 + 3]], [0, 0, -1]);
    const q = data.qpos;
    const v = data.qvel;
    const obs = new Float32Array(61);
    let o = 0;
    for (let i = 0; i < 3; i++) obs[o++] = sd[gAdr + i];
    for (let i = 0; i < 3; i++) obs[o++] = grav[i];
    for (let i = 0; i < JOINTS; i++) obs[o++] = q[qi[i]] - DEFAULT_POSE[i];
    for (let i = 0; i < JOINTS; i++) obs[o++] = v[vi[i]];
    for (let i = 0; i < JOINTS; i++) obs[o++] = lastAction[i];
    // The stand policy gets command 0, the walking policy the commanded vx.
    for (let i = 0; i < 13; i++) obs[o++] = kind === 'stand' ? 0 : cmd[i];
    const res = await session.run({ [session.inputNames[0]]: new ORT.Tensor('float32', obs, [1, 61]) });
    const action = res[session.outputNames[0]].data;
    for (let i = 0; i < JOINTS; i++) lastAction[i] = action[i];
    ct = data.ctrl;
    for (let i = 0; i < JOINTS; i++) ct[i] = DEFAULT_POSE[i] + action[i];
    for (let s = 0; s < DECIMATION; s++) lib.mj_step(model, data);

    const qq = data.qpos;
    pathLen += Math.hypot(qq[a] - px, qq[a + 1] - py);
    px = qq[a]; py = qq[a + 1];
    const h = qq[a + 2];
    if (h < minH) minH = h;
    if (data.ncon > maxNcon) maxNcon = data.ncon;

    const down = grav[2] > FALL_GZ || h < FALL_HEIGHT;
    if (down) { below += dt; above = 0; } else { above += dt; below = 0; }
    if (!fallen && below >= 0.5) { fallen = true; falls += 1; usingStand = true; }
    if (fallen && above >= 1) { fallen = false; recoveries += 1; usingStand = false; }
  }
  const qq = data.qpos;
  const w = qq[a + 3];
  const x = qq[a + 4];
  const y = qq[a + 5];
  const z = qq[a + 6];
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * 180 / Math.PI;
  const finite = Array.from(qq).every(Number.isFinite)
    && Array.from(data.qvel).every(Number.isFinite);
  const out = {
    pathM: pathLen,
    displacementXM: qq[a],
    displacementYM: qq[a + 1],
    yawDeg: yaw,
    baseHeightEndM: qq[a + 2],
    baseHeightMinM: minH,
    falls, recoveries, finite, maxNcon,
    stillFallen: fallen,
  };
  data.delete();
  return out;
}

const PRIM = path.join(HERE, 'rv-duck-collision.xml');
const MESH = path.join(FIX, 'mjcf', 'prepared-scene.xml');
const meshXml = existsSync(MESH) ? readFileSync(MESH, 'utf8') : '';
const meshNames = [...meshXml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
const haveMeshes = meshNames.length > 0
  && meshNames.every((n) => existsSync(path.join(FIX, 'mjcf', 'assets', n)));

const sessions = {
  walking: await ORT.InferenceSession.create(path.join(FIX, 'policies', 'BEST_alpha_walking.onnx')),
  stand: await ORT.InferenceSession.create(path.join(FIX, 'policies', 'BEST_alpha_stand.onnx')),
};

const scenes = [['primitives', PRIM]];
const extra = strArg('scene');
if (extra) scenes.push([path.basename(extra), path.resolve(extra)]);
if (haveMeshes) scenes.push(['CC meshes', MESH]);
else console.log('NOTE: mesh scene skipped - the gitignored STL fixture is not present.\n');

const steps = Math.round(SECONDS / 0.02);
const report = { seconds: SECONDS, runs: RUNS, scenes: {} };

// Start-height perturbations: a gait whose heading only survives one exact
// start state would not be a result. RUNS spread over +/- 0.2 mm.
const dzs = RUNS === 1 ? [0] : Array.from({ length: RUNS }, (_, i) => (i / (RUNS - 1) - 0.5) * 0.0004);

console.log(`${SECONDS} s per run, ${RUNS} start-height perturbations over +/- 0.2 mm\n`);
console.log('path = integrated distance walked; x/y = net displacement; yaw = final heading\n');

for (const [label, xmlPath] of scenes) {
  const model = compile(xmlPath);
  report.scenes[label] = {};
  console.log(label);
  for (const vx of VXS) {
    const rows = [];
    for (const dz of dzs) rows.push(await walk(model, sessions, { vx, steps, dz }));
    const f = (k, d = 3) => rows.map((r) => r[k].toFixed(d)).join(' ');
    report.scenes[label]['vx' + vx] = {
      pathM: rows.map((r) => +r.pathM.toFixed(4)),
      displacementXM: rows.map((r) => +r.displacementXM.toFixed(4)),
      yawDeg: rows.map((r) => +r.yawDeg.toFixed(1)),
      baseHeightMinM: rows.map((r) => +r.baseHeightMinM.toFixed(4)),
      falls: rows.map((r) => r.falls),
      finite: rows.every((r) => r.finite),
    };
    console.log(`  vx ${vx.toFixed(2)}  path ${f('pathM')} m   x ${f('displacementXM')} m`
      + `   yaw ${f('yawDeg', 1)} deg   minH ${f('baseHeightMinM', 4)} m`
      + `   falls ${rows.map((r) => r.falls).join(' ')}`);
  }
  // Fall and recovery: the most sensitive probe on the head and trunk hulls.
  const push = await walk(model, sessions, { vx: 0.25, steps: Math.round(20 / 0.02), pushVy: 1.0 });
  report.scenes[label].push1ms = {
    falls: push.falls, recoveries: push.recoveries, stillFallen: push.stillFallen,
    baseHeightEndM: +push.baseHeightEndM.toFixed(4), finite: push.finite,
  };
  console.log(`  push 1.0 m/s sideways, 20 s: falls ${push.falls}, recoveries ${push.recoveries}`
    + `, still down at the end ${push.stillFallen}, end height ${push.baseHeightEndM.toFixed(4)} m`
    + `, finite ${push.finite}`);
  console.log('');
  model.delete();
}

const P = report.scenes.primitives;
const M = report.scenes['CC meshes'];
if (M) {
  console.log('primitives vs mesh hull, integrated path length:');
  for (const vx of VXS) {
    const a = P['vx' + vx].pathM.reduce((x, y) => x + y, 0) / RUNS;
    const b = M['vx' + vx].pathM.reduce((x, y) => x + y, 0) / RUNS;
    console.log(`  vx ${vx.toFixed(2)}  ${a.toFixed(3)} m vs ${b.toFixed(3)} m`
      + `  (${(100 * (a / b - 1)).toFixed(1)} %)`);
  }
}
console.log('');
console.log(JSON.stringify(report, null, 1));
