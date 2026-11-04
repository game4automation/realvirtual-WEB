// plan-2001 spike part 3 (throwaway) — the CORRECTED spring measurement.
//
// Why this file exists: `xfrc-spring-gains.mjs` wrote a SECOND, unclamped force
// channel every step (`xf[1*6+2] = mass*9.81`) to "hold the body up so gravity
// does not drop it out of the test". That compensated gravity away, so what it
// measured was a gravity-free 1-D controller — and its "0 mm error for every
// mass" is an artifact of that setup, not a property of the gain formula.
//
// This run removes the compensation and adds the case the requirement is
// actually about: the dragged body TOUCHES another body.
//
// Measured, at the walker timestep dt = 5 ms, omega = 20 rad/s, zeta = 1,
// Fmax = n*m*g with n = 20:
//   S1  free in the air, gravity ON, 3-D PD pull   -> the steady-state SAG
//       (a) plan formula as written:  F = k*dx - c*v
//       (b) with gravity feedforward: F = m*g*zhat + k*dx - c*v  (clamp counts it)
//   S2  resting on the floor, dragged sideways INTO a neighbour box
//       -> tracking error under contact load, and whether the neighbour moves
//   S3  omega sweep at dt = 1/60 (the Rapier PHYSICS_FIXED_DT) -> where the
//       explicit spring loses stability. Analytic bound: omega < 2/dt.
//
// Views are RE-READ after every binding call (plan-659 finding M2).
import load from '@mujoco/mujoco';

const G = 9.81;
const OM = 20;      // rad/s  (= DragResponseHz 3.2 Hz * 2pi)
const ZETA = 1;
const NG = 20;      // Fmax = NG * m * g
const MASSES = [0.05, 0.1, 0.2, 2.0];

// ─────────────────────────────────────────────────────────────────────────────
// S1 — free body in the air, gravity ON. No floor contact, no compensation.
// ─────────────────────────────────────────────────────────────────────────────
const XML_AIR = (m, dt) => `<mujoco>
  <option timestep="${dt}"/>
  <worldbody>
    <body name="b" pos="0 0 1">
      <freejoint/>
      <geom type="sphere" size="0.05" mass="${m}"/>
    </body>
  </worldbody>
</mujoco>`;

/**
 * Pull body 1 to `target` (3-D) with a PD spring for `secs`.
 * @param gFeedforward add m*g on +z INSIDE the clamp
 */
function pullInAir(mj, mass, dt, secs, target, gFeedforward) {
  const vfs = new mj.MjVFS();
  vfs.addBuffer('m.xml', new TextEncoder().encode(XML_AIR(mass, dt)));
  const model = mj.MjModel.from_xml_path('m.xml', vfs);
  const data = new mj.MjData(model);
  const k = mass * OM * OM;
  const c = 2 * ZETA * mass * OM;
  const fmax = NG * mass * G;
  const steps = Math.round(secs / dt);
  let finite = true, peakF = 0, clampedSteps = 0;
  for (let i = 0; i < steps; i++) {
    const q = data.qpos, v = data.qvel;            // re-read
    const f = [0, 0, 0];
    for (let a = 0; a < 3; a++) f[a] = k * (target[a] - q[a]) - c * v[a];
    if (gFeedforward) f[2] += mass * G;
    const mag = Math.hypot(f[0], f[1], f[2]);
    if (mag > fmax) { const s = fmax / mag; f[0] *= s; f[1] *= s; f[2] *= s; clampedSteps++; }
    peakF = Math.max(peakF, Math.min(mag, fmax));
    const xf = data.xfrc_applied;                  // re-read
    xf[1 * 6 + 0] = f[0]; xf[1 * 6 + 1] = f[1]; xf[1 * 6 + 2] = f[2];
    mj.mj_step(model, data);
    const q2 = data.qpos;                          // re-read
    if (!Number.isFinite(q2[0]) || !Number.isFinite(q2[2])) { finite = false; break; }
  }
  const q = data.qpos, v = data.qvel;
  const res = {
    mass, dt, k: +k.toFixed(2), c: +c.toFixed(3), fmax_N: +fmax.toFixed(2), finite,
    err_x_mm: finite ? +((target[0] - q[0]) * 1000).toFixed(2) : null,
    sag_z_mm: finite ? +((target[2] - q[2]) * 1000).toFixed(2) : null,
    v_end_mps: finite ? +Math.hypot(v[0], v[1], v[2]).toFixed(4) : null,
    peakF_N: +peakF.toFixed(2), clampedSteps,
  };
  data.delete(); model.delete(); vfs.delete();
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// S2 — on the floor, dragged sideways into a neighbour. THE required case.
//      Body 1 = dragged box, body 2 = neighbour box. Gravity ON, no
//      compensation; the floor carries the weight, the pull is horizontal.
// ─────────────────────────────────────────────────────────────────────────────
const H = 0.05;                         // box half-extent
const X_NEIGHBOUR = 0.25;
const XML_FLOOR = (m, mb, dt) => `<mujoco>
  <option timestep="${dt}"/>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" friction="1 0.005 0.0001"/>
    <body name="a" pos="0 0 ${H}">
      <freejoint/>
      <geom type="box" size="${H} ${H} ${H}" mass="${m}" friction="1 0.005 0.0001"/>
    </body>
    <body name="b" pos="${X_NEIGHBOUR} 0 ${H}">
      <freejoint/>
      <geom type="box" size="${H} ${H} ${H}" mass="${mb}" friction="1 0.005 0.0001"/>
    </body>
  </worldbody>
</mujoco>`;

function dragIntoNeighbour(mj, mass, massB, dt, secs, targetX, gFeedforward) {
  const vfs = new mj.MjVFS();
  vfs.addBuffer('m.xml', new TextEncoder().encode(XML_FLOOR(mass, massB, dt)));
  const model = mj.MjModel.from_xml_path('m.xml', vfs);
  const data = new mj.MjData(model);
  const k = mass * OM * OM;
  const c = 2 * ZETA * mass * OM;
  const fmax = NG * mass * G;
  const steps = Math.round(secs / dt);
  // qpos layout: body a free joint at 0..6, body b free joint at 7..13
  const target = [targetX, 0, H];
  let finite = true, peakF = 0, clampedSteps = 0, maxContacts = 0, aPastB = false;
  for (let i = 0; i < steps; i++) {
    const q = data.qpos, v = data.qvel;            // re-read
    const f = [0, 0, 0];
    for (let a = 0; a < 3; a++) f[a] = k * (target[a] - q[a]) - c * v[a];
    if (gFeedforward) f[2] += mass * G;
    const mag = Math.hypot(f[0], f[1], f[2]);
    if (mag > fmax) { const s = fmax / mag; f[0] *= s; f[1] *= s; f[2] *= s; clampedSteps++; }
    peakF = Math.max(peakF, Math.min(mag, fmax));
    const xf = data.xfrc_applied;                  // re-read
    xf[1 * 6 + 0] = f[0]; xf[1 * 6 + 1] = f[1]; xf[1 * 6 + 2] = f[2];
    mj.mj_step(model, data);
    const q2 = data.qpos;                          // re-read
    if (!Number.isFinite(q2[0]) || !Number.isFinite(q2[7])) { finite = false; break; }
    if (typeof data.ncon === 'number') maxContacts = Math.max(maxContacts, data.ncon);
    if (q2[0] > q2[7]) aPastB = true;              // dragged body passed through
  }
  const q = data.qpos, v = data.qvel;
  const res = {
    mass, massB, dt, k: +k.toFixed(2), fmax_N: +fmax.toFixed(2), finite,
    a_x_m: finite ? +q[0].toFixed(4) : null,
    err_x_mm: finite ? +((targetX - q[0]) * 1000).toFixed(2) : null,
    sag_z_mm: finite ? +((H - q[2]) * 1000).toFixed(2) : null,
    b_x_m: finite ? +q[7].toFixed(4) : null,
    b_moved_mm: finite ? +((q[7] - X_NEIGHBOUR) * 1000).toFixed(2) : null,
    a_passed_through_b: aPastB,
    v_a_mps: finite ? +Math.hypot(v[0], v[1], v[2]).toFixed(4) : null,
    peakF_N: +peakF.toFixed(2), clampedSteps, maxContacts,
  };
  data.delete(); model.delete(); vfs.delete();
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
const mj = await load();
const DT_W = 0.005;        // walker / MuJoCo timestep
const DT_R = 1 / 60;       // PHYSICS_FIXED_DT of the Rapier loop

const out = { omega_rad_s: OM, zeta: ZETA, n_g: NG, g: G };

// S1 — the sag, with and without gravity feedforward.
out.S1_air_no_feedforward = MASSES.map((m) => pullInAir(mj, m, DT_W, 2.0, [0.3, 0, 1.0], false));
out.S1_air_with_feedforward = MASSES.map((m) => pullInAir(mj, m, DT_W, 2.0, [0.3, 0, 1.0], true));
out.S1_predicted_sag_mm = +((G / (OM * OM)) * 1000).toFixed(2);   // g/omega^2

// S2 — contact. Neighbour is the SAME mass and ten times the mass.
out.S2_contact_no_feedforward = MASSES.map((m) => dragIntoNeighbour(mj, m, m, DT_W, 2.0, 0.35, false));
out.S2_contact_heavy_neighbour = MASSES.map((m) => dragIntoNeighbour(mj, m, 10 * m, DT_W, 2.0, 0.35, false));
out.S2_contact_with_feedforward = MASSES.map((m) => dragIntoNeighbour(mj, m, m, DT_W, 2.0, 0.35, true));

// S3 — omega sweep at the Rapier timestep: where does the explicit spring go?
out.S3_omega_sweep_dt60 = [];
for (const om of [20, 60, 100, 115, 120, 140, 200]) {
  const save = OM;
  // temporary override via closure-free recomputation
  const k = 0.2 * om * om, c = 2 * 0.2 * om;
  const vfs = new mj.MjVFS();
  vfs.addBuffer('m.xml', new TextEncoder().encode(XML_AIR(0.2, DT_R)));
  const model = mj.MjModel.from_xml_path('m.xml', vfs);
  const data = new mj.MjData(model);
  const fmax = NG * 0.2 * G;
  let finite = true, maxAbs = 0;
  for (let i = 0; i < Math.round(2.0 / DT_R); i++) {
    const q = data.qpos, v = data.qvel;
    const f = [0, 0, 0];
    const tgt = [0.3, 0, 1.0];
    for (let a = 0; a < 3; a++) f[a] = k * (tgt[a] - q[a]) - c * v[a];
    const mag = Math.hypot(f[0], f[1], f[2]);
    if (mag > fmax) { const s = fmax / mag; f[0] *= s; f[1] *= s; f[2] *= s; }
    const xf = data.xfrc_applied;
    xf[1 * 6 + 0] = f[0]; xf[1 * 6 + 1] = f[1]; xf[1 * 6 + 2] = f[2];
    mj.mj_step(model, data);
    const q2 = data.qpos;
    if (!Number.isFinite(q2[0])) { finite = false; break; }
    maxAbs = Math.max(maxAbs, Math.abs(q2[0]));
  }
  const q = data.qpos;
  out.S3_omega_sweep_dt60.push({
    omega: om, omega_dt: +(om * DT_R).toFixed(3), hz: +(om / (2 * Math.PI)).toFixed(2),
    finite, err_x_mm: finite ? +((0.3 - q[0]) * 1000).toFixed(2) : null,
    overshoot_pct: finite ? +(((maxAbs - 0.3) / 0.3) * 100).toFixed(1) : null,
    clamp_binding_note: fmax,
  });
  data.delete(); model.delete(); vfs.delete();
  void save;
}
// S4 — sag AND overshoot as a function of DragResponseHz, at both timesteps.
//      The sag is what a user sees; the overshoot is what the timestep costs.
out.S4_hz_tradeoff = [];
for (const hz of [3.2, 5, 8, 10, 15, 20]) {
  const om = hz * 2 * Math.PI;
  const e = { hz, omega: +om.toFixed(1), predicted_sag_mm: +((G / (om * om)) * 1000).toFixed(2) };
  for (const [tag, dt] of [['walker_dt5ms', DT_W], ['rapier_dt16_7ms', DT_R]]) {
    const vfs = new mj.MjVFS();
    vfs.addBuffer('m.xml', new TextEncoder().encode(XML_AIR(0.2, dt)));
    const model = mj.MjModel.from_xml_path('m.xml', vfs);
    const data = new mj.MjData(model);
    const k = 0.2 * om * om, c = 2 * 0.2 * om, fmax = NG * 0.2 * G;
    let finite = true, maxAbs = 0, clamped = 0;
    for (let i = 0; i < Math.round(2.0 / dt); i++) {
      const q = data.qpos, v = data.qvel;
      const tgt = [0.3, 0, 1.0], f = [0, 0, 0];
      for (let a = 0; a < 3; a++) f[a] = k * (tgt[a] - q[a]) - c * v[a];
      const mag = Math.hypot(f[0], f[1], f[2]);
      if (mag > fmax) { const s = fmax / mag; f[0] *= s; f[1] *= s; f[2] *= s; clamped++; }
      const xf = data.xfrc_applied;
      xf[1 * 6 + 0] = f[0]; xf[1 * 6 + 1] = f[1]; xf[1 * 6 + 2] = f[2];
      mj.mj_step(model, data);
      const q2 = data.qpos;
      if (!Number.isFinite(q2[0])) { finite = false; break; }
      maxAbs = Math.max(maxAbs, Math.abs(q2[0]));
    }
    const q = data.qpos;
    e[tag] = {
      omega_dt: +(om * dt).toFixed(3), finite,
      sag_z_mm: finite ? +((1.0 - q[2]) * 1000).toFixed(2) : null,
      overshoot_pct: finite ? +(((maxAbs - 0.3) / 0.3) * 100).toFixed(1) : null,
      clampedSteps: clamped,
    };
    data.delete(); model.delete(); vfs.delete();
  }
  out.S4_hz_tradeoff.push(e);
}

out.S3_analytic_bound = { dt_walker: DT_W, omega_max_walker: +(2 / DT_W).toFixed(0), hz_max_walker: +(2 / DT_W / (2 * Math.PI)).toFixed(1), dt_rapier: +DT_R.toFixed(5), omega_max_rapier: +(2 / DT_R).toFixed(0), hz_max_rapier: +(2 / DT_R / (2 * Math.PI)).toFixed(1) };

console.log(JSON.stringify(out, null, 2));
