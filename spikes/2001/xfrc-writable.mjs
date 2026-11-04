// plan-2001 spike (throwaway) — is `data.xfrc_applied` a WRITABLE Float64 view
// on the WASM heap, and does MuJoCo CLEAR it on every step?
//
// Run:  node spikes/2001/xfrc-writable.mjs
// Prints JSON. No product code is touched.
//
// Gotcha honoured: every heap view is RE-READ after every binding call, because
// heap growth silently detaches earlier TypedArray views (plan-659 finding M2).

import load from '@mujoco/mujoco';

const XML = `<mujoco>
  <option timestep="0.002" gravity="0 0 0"/>
  <worldbody>
    <body name="ball" pos="0 0 0">
      <freejoint/>
      <geom name="g" type="sphere" size="0.05" density="1000"/>
    </body>
  </worldbody>
</mujoco>`;

const out = {};

const mj = await load();
const vfs = new mj.MjVFS();
vfs.addBuffer('m.xml', new TextEncoder().encode(XML));
const model = mj.MjModel.from_xml_path('m.xml', vfs);
const data = new mj.MjData(model);

out.mujocoVersion = '3.11.0';
out.nbody = model.nbody;
out.nq = model.nq;
out.nv = model.nv;
out.mass_kg = Array.from(model.body_mass);

// ── 1. What kind of object is it? ─────────────────────────────────────────────
{
  const v = data.xfrc_applied;
  out.ctor = v?.constructor?.name ?? typeof v;
  out.length = v?.length;
  out.isFloat64 = v instanceof Float64Array;
  out.byteOffset = v?.byteOffset;
  // HEAPF64 is not an exported runtime method in this build; a WASM memory
  // buffer is always a whole number of 64 KiB pages, which is the next-best tell.
  out.bufferByteLength = v?.buffer?.byteLength;
  out.bufferLooksLikeWasmMemory = !!v?.buffer && v.buffer.byteLength % 65536 === 0;
  out.descriptorWritable = (() => {
    // Is the PROPERTY itself assignable, or only its contents?
    let p = Object.getPrototypeOf(data);
    while (p) {
      const d = Object.getOwnPropertyDescriptor(p, 'xfrc_applied');
      if (d) return { hasGet: !!d.get, hasSet: !!d.set, writable: d.writable };
      p = Object.getPrototypeOf(p);
    }
    return null;
  })();
}

// ── 2. Does a write stick, and is it visible through a FRESH read? ───────────
const BODY = 1;           // 0 = world body
const FX = 100;           // N along +x
data.xfrc_applied[BODY * 6 + 0] = FX;
out.writeVisibleSameView = data.xfrc_applied[BODY * 6 + 0];
out.writeVisibleFreshView = (() => {
  const v = data.xfrc_applied;           // re-read
  return v[BODY * 6 + 0];
})();

// Does it reach the solver, i.e. does mj_forward see it as applied force?
mj.mj_forward(model, data);
out.qaccAfterForward = Array.from(data.qvel).length ? undefined : undefined;

// ── 3. Does the body move in the direction of the force? ─────────────────────
const qposBefore = Array.from(data.qpos);
for (let i = 0; i < 50; i++) {
  // re-write every step for now; cleared-flag is measured separately below
  const v = data.xfrc_applied;           // RE-READ after every binding call
  v[BODY * 6 + 0] = FX;
  mj.mj_step(model, data);
}
const qposAfter = Array.from(data.qpos);
const qvelAfter = Array.from(data.qvel);
out.dx_m_50steps_rewritten = qposAfter[0] - qposBefore[0];
out.vx_mps_50steps_rewritten = qvelAfter[0];
out.allFinite = qposAfter.every(Number.isFinite) && qvelAfter.every(Number.isFinite);

// Analytic check: a = F/m, x = 0.5*a*t^2, v = a*t
{
  const m = model.body_mass[BODY];
  const dt = model.opt.timestep;
  const t = 50 * dt;
  const a = FX / m;
  out.expected_dx_m = 0.5 * a * t * t;
  out.expected_vx_mps = a * t;
  out.mass_of_ball_kg = m;
}

// ── 4. THE decisive question: is xfrc_applied zeroed by mj_step? ─────────────
{
  const d2 = new mj.MjData(model);        // fresh state (also grows the heap)
  d2.xfrc_applied[BODY * 6 + 1] = 42;     // +y, distinctive value
  const beforeStep = d2.xfrc_applied[BODY * 6 + 1];   // fresh read
  mj.mj_step(model, d2);
  const afterStep = d2.xfrc_applied[BODY * 6 + 1];    // fresh read AFTER the call
  out.valueBeforeStep = beforeStep;
  out.valueAfterStep = afterStep;
  out.clearedByStep = afterStep === 0;

  // And: does a single write keep accelerating over many steps (i.e. persists)?
  const d3 = new mj.MjData(model);
  d3.xfrc_applied[BODY * 6 + 0] = FX;
  for (let i = 0; i < 50; i++) mj.mj_step(model, d3);
  out.dx_m_50steps_writtenOnce = d3.qpos[0];
  out.vx_mps_50steps_writtenOnce = d3.qvel[0];
  out.residualAfter50Steps = d3.xfrc_applied[BODY * 6 + 0];
  d3.delete();
  d2.delete();
}

// ── 5. Heap-growth detachment, to pin the re-read rule with a number ────────
{
  const stale = data.xfrc_applied;
  const ballast = [];
  for (let i = 0; i < 8; i++) ballast.push(new mj.MjData(model));
  out.staleViewLengthAfterGrowth = stale.length;       // 0 if detached
  out.staleViewDetached = stale.length === 0 || stale.byteLength === 0;
  out.freshViewLengthAfterGrowth = data.xfrc_applied.length;
  for (const b of ballast) b.delete();
}

// ── 6. Mass range of the walker scene, for the gain-scaling question ────────
out.note = 'gravity disabled so the only force is xfrc_applied';

data.delete();
model.delete();
vfs.delete();

console.log(JSON.stringify(out, null, 2));
