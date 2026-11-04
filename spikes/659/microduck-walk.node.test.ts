// plan-659 test 9.9 — Microduck regression (Node, integration, mode `parity`).
//
// The fast test of every change to `RVMuJoCoWorld` / `RVLocomotionPolicy`:
// runs in seconds and checks walking, standing, the fall criterion with its
// recovery, and — because the WASM chain turned out to be deterministic
// (Phase 1 measurement) — the exact state after 500 control steps.
//
// Two corrections from Phase 0 are baked in:
//  - the command is vx = 0.25 m/s, NOT 0.2: below 0.25 the walking policy holds
//    a static stance, so "no fall" would pass trivially and the distance band
//    would be calibrated at ~1.3 cm.
//  - the distance band comes from the PYTHON reference run (1.0591 m in 10 s),
//    not from this port's own first green run.
//
// The exact `qpos` comparison uses a WASM-CHAIN golden, not the Python
// snapshot: inside the WASM chain the run is bit-identical, but WASM vs. native
// Python differs by up to 2.1e-1 after 500 steps (measured) — the same physics,
// a different compiler. Comparing across chains would be a false precision.
//
// plan-659 STAGE 2 — WHAT THE GOLDEN NOW PINS, AND WHY IT MOVED
// -------------------------------------------------------------
// The simulated scene is no longer the fixture's mesh scene: every collision
// hull is an original MuJoCo primitive (`duck/rv-duck-collision.xml`), so the
// CC BY-NC-SA 4.0 STL files are not needed to run the demo. A different hull is
// a different contact, so the trajectory moved and the golden was regenerated
// ONCE, deliberately. It still pins what it was for — that this chain is
// bit-deterministic and that nothing drifts unnoticed — but it is no longer
// evidence about the original geometry.
//
// The criterion that carries the geometry claim is BEHAVIOUR, and it is
// measured in `duck/compare-collision-walk.mjs`: integrated path length over
// 60 s, primitives against the mesh hull, +0.9 % at vx 0.25, −0.3 % at 0.30,
// −1.1 % at 0.35, and the same "no gait" stance below the 0.25 onset. The one
// deviation is the heading — the box sole gives the stance foot a 43 mm contact
// spread against the hull's 22 mm, so the duck walks the same distance at the
// same speed on a ~2.7 m arc instead of a straight line. The distance band
// below is on the 10 s net displacement, where that drift has not yet
// accumulated, so the Python anchor still applies and still holds (measured
// 1.0455 m against the Python 1.0591 m, −1.3 %).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FALL_GZ_THRESHOLD,
  loadMicroduckPolicy,
  loadReference,
  RVMicroduckRuntime,
} from './rv-microduck-runtime';

const VX_WALK = 0.25;
/** Python reference, 10 s at vx = 0.25 m/s (plan-659 Phase 0). */
const PYTHON_10S_X_M = 1.0590556514451412;
const DISTANCE_BAND = 0.1; // ±10 %
/** WASM-chain golden; regenerated with a log line when absent. */
const WASM_GOLDEN = resolve(__dirname, 'microduck-qpos-after-500-steps.wasm.json');
/** Recovery criterion (plan 9.9): upright again for 1 s. */
const RECOVERED_GZ = -0.85;
const RECOVERY_HOLD_S = 1;
const RECOVERY_GIVEUP_S = 6;

describe('9.9 Microduck regression', () => {
  it('walks 10 s at vx = 0.25 m/s inside the Python distance band, without falling', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      const stats = await runtime.run(500, { trackLatency: false });
      // eslint-disable-next-line no-console
      console.log(
        `[9.9] 10 s walk: x = ${stats.displacementXM.toFixed(4)} m ` +
          `(band ${(PYTHON_10S_X_M * (1 - DISTANCE_BAND)).toFixed(4)}..` +
          `${(PYTHON_10S_X_M * (1 + DISTANCE_BAND)).toFixed(4)} m), ` +
          `min height ${stats.baseHeightMinM.toFixed(4)} m, fallen = ${stats.fallen}`,
      );
      expect(stats.finite).toBe(true);
      expect(stats.fallen).toBe(false);
      expect(stats.displacementXM).toBeGreaterThan(PYTHON_10S_X_M * (1 - DISTANCE_BAND));
      expect(stats.displacementXM).toBeLessThan(PYTHON_10S_X_M * (1 + DISTANCE_BAND));
    } finally {
      await runtime.dispose();
    }
  });

  it('stands still for 3 s on command 0', async () => {
    const runtime = await RVMicroduckRuntime.create('stand');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(0);
      const stats = await runtime.run(150, { trackLatency: false });
      // eslint-disable-next-line no-console
      console.log(
        `[9.9] 3 s stand: drift = ${(stats.distanceXyM * 1000).toFixed(1)} mm, ` +
          `height end ${stats.baseHeightEndM.toFixed(4)} m, fallen = ${stats.fallen}`,
      );
      expect(stats.fallen).toBe(false);
      // Python reference: 2.3 mm. A loose cap still catches "walks away" and
      // "collapses" without pinning a cross-chain exact value.
      expect(stats.distanceXyM).toBeLessThan(0.05);
      expect(stats.baseHeightEndM).toBeGreaterThan(0.1);
    } finally {
      await runtime.dispose();
    }
  });

  // Plan deviation, measured: the plan's 0.5 m/s sideways push is ABSORBED by
  // the walking policy (sweep: 0.5 -> stays upright, worst gz never above 0;
  // 1.0 -> topples). The 0.5 m/s case is kept as the "detector does not fire
  // spuriously" half, and the fall + recovery path is exercised at 1.0 m/s.
  it('absorbs the 0.5 m/s sideways push without the fall detector firing', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      await runtime.run(100, { trackLatency: false }); // 2 s of settled gait
      runtime.pushBase(0, 0.5);
      const stats = await runtime.run(150, { trackLatency: false });
      // eslint-disable-next-line no-console
      console.log(
        `[9.9] push 0.5 m/s: fallen = ${stats.fallen}, gz = ${runtime.projectedGravityZ().toFixed(3)}, ` +
          `min height ${stats.baseHeightMinM.toFixed(4)} m`,
      );
      expect(stats.fallen).toBe(false);
      expect(runtime.projectedGravityZ()).toBeLessThan(FALL_GZ_THRESHOLD);
    } finally {
      await runtime.dispose();
    }
  });

  // plan-659 stage 2 re-anchoring: with the collision hulls replaced by
  // primitives, 1.0 m/s is ABSORBED too — the box sole hands the stance foot a
  // 43 mm contact spread against the mesh hull's 22 mm, so the duck is harder
  // to topple sideways. Measured sweep on the primitive scene: 1.0 -> stays up
  // (min height 97 mm), 1.5 / 2.0 / 2.5 / 3.0 -> falls and gets up again every
  // time. The fall-and-recovery path is therefore exercised at 1.5 m/s. The
  // mesh scene fell at 1.0; that is the one place the stiffer foot shows.
  it('detects a fall after a 1.5 m/s push and reports the recovery outcome', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    const standPolicy = await loadMicroduckPolicy('stand', loadReference().meta.contract);
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      await runtime.run(100, { trackLatency: false }); // 2 s of settled gait
      runtime.pushBase(0, 1.5);

      // Walking policy keeps control while the fall criterion is evaluated.
      const dtControl = runtime.contract.timestep * runtime.contract.decimation;
      let fellAt: number | null = null;
      let downSince: number | null = null;
      for (let k = 0; k < 300 && fellAt === null; k++) {
        await runtime.controlStep();
        const t = (k + 1) * dtControl;
        const down =
          runtime.projectedGravityZ() > FALL_GZ_THRESHOLD || runtime.basePosition()[2] < 0.02;
        if (down) {
          if (downSince === null) downSince = t;
          else if (t - downSince >= 0.2) fellAt = downSince;
        } else {
          downSince = null;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[9.9] push 1.5 m/s sideways: fall detected = ${fellAt !== null}` +
          (fellAt === null ? ' (duck stayed upright)' : ` at t = ${fellAt.toFixed(2)} s`),
      );
      expect(fellAt).not.toBeNull();

      // Recovery: swap in the stand-up policy (one tensor contract, Phase 0).
      runtime.usePolicy(standPolicy);
      standPolicy.setCommandAt(0, 0);
      let uprightSince: number | null = null;
      let recoveredAt: number | null = null;
      for (let k = 0; k < Math.ceil(RECOVERY_GIVEUP_S / dtControl) && recoveredAt === null; k++) {
        await runtime.controlStep();
        const t = (k + 1) * dtControl;
        if (runtime.projectedGravityZ() < RECOVERED_GZ) {
          if (uprightSince === null) uprightSince = t;
          else if (t - uprightSince >= RECOVERY_HOLD_S) recoveredAt = uprightSince;
        } else {
          uprightSince = null;
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `[9.9] recovery: ${
          recoveredAt === null
            ? `not upright within ${RECOVERY_GIVEUP_S} s -> reset required (gz = ` +
              `${runtime.projectedGravityZ().toFixed(3)})`
            : `upright from t = ${recoveredAt.toFixed(2)} s`
        }`,
      );
      // The plan allows either outcome: recovered, or give up and reset. What
      // must hold is that the state stays finite and a reset restores it.
      const qpos = Array.from(runtime.world.readQpos());
      expect(qpos.every(Number.isFinite)).toBe(true);
      runtime.initStartState();
      expect(runtime.projectedGravityZ()).toBeLessThan(RECOVERED_GZ);
    } finally {
      await standPolicy.dispose();
      await runtime.dispose();
    }
  });

  it('reproduces the WASM golden qpos after 500 control steps exactly', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      await runtime.run(500, { trackLatency: false });
      const qpos = Array.from(runtime.world.readQpos());

      if (!existsSync(WASM_GOLDEN)) {
        writeFileSync(
          WASM_GOLDEN,
          `${JSON.stringify(
            {
              meta: {
                plan: 659,
                phase: 1,
                chain: 'wasm',
                scene: 'spikes/659/duck/rv-duck-collision.xml',
                note:
                  'Golden of the WASM chain (@mujoco/mujoco + onnxruntime-node) on the ' +
                  'COLLISION-PRIMITIVE scene (plan-659 stage 2 — no CC BY-NC-SA mesh). The run ' +
                  'is bit-deterministic inside this chain; it is NOT bit-equal to the native ' +
                  'Python snapshot (max |delta| 2.1e-1 after 500 steps) and NOT bit-equal to ' +
                  'the mesh-hull scene either — do not compare across chains or across hulls. ' +
                  'The geometry claim is carried by duck/compare-collision-walk.mjs, not here.',
                versions: {
                  node: process.version,
                  '@mujoco/mujoco': '3.11.0',
                  'onnxruntime-node': '1.23.2',
                  platform: `${process.platform}-${process.arch}`,
                },
              },
              controlSteps: 500,
              command: [VX_WALK, ...new Array(12).fill(0)],
              qpos,
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`[9.9] WASM golden written: ${WASM_GOLDEN}`);
        return;
      }

      const golden = JSON.parse(readFileSync(WASM_GOLDEN, 'utf8')) as { qpos: number[] };
      let worst = 0;
      for (let i = 0; i < golden.qpos.length; i++) {
        worst = Math.max(worst, Math.abs(qpos[i] - golden.qpos[i]));
      }
      // eslint-disable-next-line no-console
      console.log(`[9.9] qpos vs WASM golden: max |delta| = ${worst.toExponential(3)}`);
      expect(qpos.length).toBe(golden.qpos.length);
      // Exact: the chain is bit-deterministic (Phase 1 determinism measurement).
      expect(golden.qpos.every((v, i) => Object.is(v, qpos[i]))).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
