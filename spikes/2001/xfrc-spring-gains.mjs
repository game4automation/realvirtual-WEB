// !!! SUPERSEDED / INVALID — see `xfrc-spring-gravity-contact.mjs` (plan-2001, M6). !!!
//
// Line 44 below writes a SECOND, unclamped force channel (`xf[1*6+2] = mass*9.81`)
// to hold the body up. That compensates gravity away, so this run measured a
// gravity-FREE 1-D controller: its "0 mm error for every mass" is an artifact of
// the setup, not a property of the gain formula. The real PD pull sags by
// g/omega^2 (= 24.5 mm at omega = 20 rad/s, mass-independent, measured in M6).
// It also never touches another body, i.e. it omits the case the requirement is
// about. Kept only so the mistake stays traceable. Do not cite its numbers.
//
// plan-2001 spike part 2 (throwaway) — can ONE spring gain serve the walker
// scene's mass range (0.05 kg ... 2 kg, factor 40) at the walker timestep?
//
// Model: one free body per run, gravity ON (as in the real scene), a PD spring
// pulling the body to a target that moves 0.3 m sideways at t=0.
//   F = k*(target - x) - c*v,  clamped to |F| <= Fmax
// Measured per (mass, gain law): tracking error after 1 s, overshoot, and
// whether the state stayed finite.
//
// Views are RE-READ after every binding call (plan-659 finding M2).
import load from '@mujoco/mujoco';

const DT = 0.005;                       // the walker timestep
const XML = (m) => `<mujoco>
  <option timestep="${DT}"/>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05"/>
    <body name="b" pos="0 0 1">
      <freejoint/>
      <geom type="sphere" size="0.05" mass="${m}"/>
    </body>
  </worldbody>
</mujoco>`;

const MASSES = [0.05, 0.1, 0.2, 2.0];
const TARGET = 0.3;                      // m sideways
const STEPS = Math.round(1.0 / DT);      // 1 s

function run(mj, mass, k, c, fmax) {
  const vfs = new mj.MjVFS();
  vfs.addBuffer('m.xml', new TextEncoder().encode(XML(mass)));
  const model = mj.MjModel.from_xml_path('m.xml', vfs);
  const data = new mj.MjData(model);
  let maxX = 0, finite = true, peakF = 0;
  for (let i = 0; i < STEPS; i++) {
    const q = data.qpos, v = data.qvel;            // re-read
    const x = q[0], vx = v[0];
    let f = k * (TARGET - x) - c * vx;
    if (f > fmax) f = fmax; else if (f < -fmax) f = -fmax;
    peakF = Math.max(peakF, Math.abs(f));
    const xf = data.xfrc_applied;                  // re-read
    xf[1 * 6 + 0] = f;
    // Hold it up too, so gravity does not drop it out of the test.
    xf[1 * 6 + 2] = mass * 9.81;
    mj.mj_step(model, data);
    const q2 = data.qpos;                          // re-read
    if (!Number.isFinite(q2[0])) { finite = false; break; }
    if (Math.abs(q2[0]) > Math.abs(maxX)) maxX = q2[0];
  }
  const q = data.qpos, v = data.qvel;
  const res = {
    mass, k: +k.toFixed(1), c: +c.toFixed(2), fmax,
    finite,
    x_end_m: finite ? +q[0].toFixed(4) : null,
    err_mm: finite ? +((TARGET - q[0]) * 1000).toFixed(1) : null,
    overshoot_pct: finite ? +(((maxX - TARGET) / TARGET) * 100).toFixed(1) : null,
    v_end_mps: finite ? +v[0].toFixed(3) : null,
    peakF_N: +peakF.toFixed(2),
  };
  data.delete(); model.delete(); vfs.delete();
  return res;
}

const mj = await load();
const out = { dt: DT, target_m: TARGET, duration_s: 1.0, runs: {} };

// Law A — ONE fixed gain for every mass (what a literal in the code would do).
// Tuned to be snappy for the 0.2 kg cube: omega = 20 rad/s -> k = 0.2*400 = 80.
out.runs.fixed_k80 = MASSES.map((m) => run(mj, m, 80, 2 * Math.sqrt(80 * 0.2), 50));

// Law B — mass-scaled: k = m*omega^2, c = 2*zeta*m*omega (zeta = 1, omega = 20).
const OM = 20, ZETA = 1;
out.runs.massScaled_omega20 = MASSES.map((m) =>
  run(mj, m, m * OM * OM, 2 * ZETA * m * OM, Math.max(5, 20 * m * 9.81)));

// Law C — mass-scaled, pushed to the integrator limit (omega*dt ~ 0.5 -> om=100).
out.runs.massScaled_omega100 = MASSES.map((m) =>
  run(mj, m, m * 100 * 100, 2 * m * 100, Math.max(5, 20 * m * 9.81)));

// Law D — fixed gain sized for the LIGHT end instead (omega 20 at 0.05 kg).
out.runs.fixed_k20 = MASSES.map((m) => run(mj, m, 20, 2 * Math.sqrt(20 * 0.05), 50));

// Stability bound of an explicit spring: k_max ~ 4*m/dt^2.
out.kmax_explicit = Object.fromEntries(MASSES.map((m) => [m, +(4 * m / (DT * DT)).toFixed(0)]));

console.log(JSON.stringify(out, null, 2));
