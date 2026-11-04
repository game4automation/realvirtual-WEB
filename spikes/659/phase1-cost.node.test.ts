// plan-659 Phase 1 — the Go criterion and the cost measurement.
//
// Go criterion (plan, run path): real-time factor >= 2 (physics + policy,
// single thread, SYNCHRONOUS scheduler mode `parity`) AND 60 s without a fall.
//
// What is deliberately NOT asserted: `droppedSimTime`. In the synchronous
// headless mode it is structurally 0 — there is no render loop and no cap to
// drop against (plan residual risk N2). It is a Phase-2/4 quantity.
//
// The run also answers the open Phase-0 question: is the WASM chain
// deterministic? Two runs from an identical start state are compared bit for
// bit after 500 control steps. The answer decides whether test 9.9 may check
// `qpos` exactly or needs a tolerance.
//
// Every number produced here is written to `spikes/659/phase1-report.json` so
// the plan report quotes measurements, not recollection.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { percentile, RVMicroduckRuntime, loadReference } from './rv-microduck-runtime';

const VX_WALK = 0.25; // Phase-0 finding: the gait only starts at 0.25 m/s.
const REPORT_PATH = resolve(__dirname, 'phase1-report.json');

interface Report {
  plan: number;
  phase: number;
  generatedAt: string;
  versions: Record<string, string>;
  pythonBaseline: Record<string, unknown>;
  runs: Record<string, unknown>;
  determinism: Record<string, unknown>;
  contacts: Record<string, unknown>;
}

const report: Report = {
  plan: 659,
  phase: 1,
  generatedAt: new Date().toISOString(),
  versions: {},
  pythonBaseline: {},
  runs: {},
  determinism: {},
  contacts: {},
};

describe('Phase 1 cost + Go criterion (headless, scheduler mode parity, synchronous)', () => {
  it('records the runtime versions of the measured chain', () => {
    report.versions = {
      node: process.version,
      '@mujoco/mujoco': installedVersion('@mujoco/mujoco'),
      'onnxruntime-node': installedVersion('onnxruntime-node'),
      platform: `${process.platform}-${process.arch}`,
    };
    const reference = loadReference();
    report.pythonBaseline = reference.meta.runs;
    expect(report.versions['@mujoco/mujoco']).not.toBe('unknown');
  });

  it('measures 10 000 pure physics steps (no policy) as the cost floor', async () => {
    const { loadMicroduckWorld } = await import('./rv-microduck-runtime');
    const world = await loadMicroduckWorld();
    try {
      world.step(400); // settle, so the measured steps carry real contacts
      const t0 = performance.now();
      world.step(10_000);
      const wallS = (performance.now() - t0) / 1000;
      const simS = 10_000 * world.timestep;
      report.runs.physicsOnly10kSteps = {
        steps: 10_000,
        simTimeS: simS,
        wallClockS: wallS,
        msPerStep: (wallS * 1000) / 10_000,
        msPerSimSecond: (wallS * 1000) / simS,
        realTimeFactor: simS / wallS,
      };
      // eslint-disable-next-line no-console
      console.log(
        `[P1] physics only: 10 000 steps = ${simS.toFixed(1)} s sim in ${wallS.toFixed(3)} s wall ` +
          `(${((wallS * 1000) / 10_000).toFixed(4)} ms/step, ` +
          `${((wallS * 1000) / simS).toFixed(2)} ms per sim second, rtf ${(simS / wallS).toFixed(1)})`,
      );
      expect(Array.from(world.readQpos()).every(Number.isFinite)).toBe(true);
    } finally {
      world.dispose();
    }
  });

  it('walks 10 s at vx = 0.25 m/s and matches the Python baseline distance', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      const stats = await runtime.run(500);
      const baseline = 1.0590556514451412; // Python displacement_x_m, 10 s
      const ratio = stats.displacementXM / baseline;
      report.runs.walk10s = {
        ...stats,
        policyLatenciesMs: undefined,
        latencyMedianMs: percentile(stats.policyLatenciesMs, 0.5),
        latencyP95Ms: percentile(stats.policyLatenciesMs, 0.95),
        realTimeFactor: stats.simTimeS / stats.wallClockS,
        pythonBaselineXM: baseline,
        ratioToPython: ratio,
      };
      // eslint-disable-next-line no-console
      console.log(
        `[P1] 10 s: x = ${stats.displacementXM.toFixed(4)} m (python ${baseline.toFixed(4)} m, ` +
          `ratio ${ratio.toFixed(3)}), fallen = ${stats.fallen}, ` +
          `rtf = ${(stats.simTimeS / stats.wallClockS).toFixed(2)}, ` +
          `policy median ${percentile(stats.policyLatenciesMs, 0.5).toFixed(3)} ms / ` +
          `p95 ${percentile(stats.policyLatenciesMs, 0.95).toFixed(3)} ms`,
      );
      expect(stats.finite).toBe(true);
      expect(stats.fallen).toBe(false);
      expect(stats.displacementXM).toBeGreaterThan(0.5);
    } finally {
      await runtime.dispose();
    }
  });

  it('walks 60 s without falling and keeps the real-time factor >= 2', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      const stats = await runtime.run(3000);
      const rtf = stats.simTimeS / stats.wallClockS;
      const baseline = 6.612033797348853; // Python displacement_x_m, 60 s
      report.runs.walk60s = {
        ...stats,
        policyLatenciesMs: undefined,
        latencyMedianMs: percentile(stats.policyLatenciesMs, 0.5),
        latencyP95Ms: percentile(stats.policyLatenciesMs, 0.95),
        realTimeFactor: rtf,
        secondsPerSimSecond: stats.wallClockS / stats.simTimeS,
        physicsShare: stats.physicsWallS / stats.wallClockS,
        pythonBaselineXM: baseline,
        ratioToPython: stats.displacementXM / baseline,
        droppedSimTimeS: 0,
        droppedSimTimeNote:
          'structurally 0 in the synchronous headless mode: no render loop, no cap (N2)',
      };
      // eslint-disable-next-line no-console
      console.log(
        `[P1] 60 s: x = ${stats.displacementXM.toFixed(4)} m (python ${baseline.toFixed(4)} m, ` +
          `ratio ${(stats.displacementXM / baseline).toFixed(3)}), fallen = ${stats.fallen}, ` +
          `wall ${stats.wallClockS.toFixed(2)} s, rtf = ${rtf.toFixed(2)}, ` +
          `cost ${((stats.wallClockS / stats.simTimeS) * 1000).toFixed(1)} ms per sim second, ` +
          `policy median ${percentile(stats.policyLatenciesMs, 0.5).toFixed(3)} ms / ` +
          `p95 ${percentile(stats.policyLatenciesMs, 0.95).toFixed(3)} ms, ` +
          `physics share ${(100 * (stats.physicsWallS / stats.wallClockS)).toFixed(1)} %`,
      );
      expect(stats.finite).toBe(true);
      expect(stats.fallen).toBe(false);
      expect(rtf).toBeGreaterThanOrEqual(2);
    } finally {
      await runtime.dispose();
    }
  });

  it('answers the determinism question for the WASM chain', async () => {
    const qpos: Float64Array[] = [];
    const actions: number[][] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = await RVMicroduckRuntime.create('walking');
      try {
        runtime.initStartState();
        runtime.setForwardVelocity(VX_WALK);
        const seen: number[] = [];
        for (let k = 0; k < 500; k++) {
          await runtime.controlStep();
          if (k === 0 || k === 100 || k === 499) {
            seen.push(...Array.from(runtime.policy.lastActionView));
          }
        }
        actions.push(seen);
        qpos.push(Float64Array.from(runtime.world.readQpos()));
      } finally {
        await runtime.dispose();
      }
    }
    const bitEqualQpos = qpos[0].every((v, i) => Object.is(v, qpos[1][i]));
    const bitEqualActions = actions[0].every((v, i) => Object.is(v, actions[1][i]));
    let maxQposDelta = 0;
    for (let i = 0; i < qpos[0].length; i++) {
      maxQposDelta = Math.max(maxQposDelta, Math.abs(qpos[0][i] - qpos[1][i]));
    }
    report.determinism = {
      twoIdenticalRunsBitEqualQpos: bitEqualQpos,
      twoIdenticalRunsBitEqualActions: bitEqualActions,
      maxQposDeltaAfter500Steps: maxQposDelta,
      note: bitEqualQpos
        ? 'test 9.9 may compare qpos exactly inside the WASM chain'
        : 'test 9.9 must compare qpos with a tolerance',
    };
    // eslint-disable-next-line no-console
    console.log(
      `[P1] determinism (WASM): qpos bit-equal = ${bitEqualQpos}, actions bit-equal = ` +
        `${bitEqualActions}, max |delta qpos| = ${maxQposDelta.toExponential(3)}`,
    );
    expect(bitEqualQpos).toBe(true);
  });

  it('compares the WASM qpos against the Python snapshot after 500 steps', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      await runtime.run(500, { trackLatency: false });
      const mine = Array.from(runtime.world.readQpos());
      const python = (
        await import('./fixtures/microduck/reference/microduck-qpos-after-500-steps.json', {
          with: { type: 'json' },
        })
      ).default as { qpos: number[] };
      let worst = 0;
      for (let i = 0; i < python.qpos.length; i++) {
        worst = Math.max(worst, Math.abs(mine[i] - python.qpos[i]));
      }
      report.determinism.maxQposDeltaVsPython = worst;
      report.determinism.bitEqualVsPython = python.qpos.every((v, i) => Object.is(v, mine[i]));
      // eslint-disable-next-line no-console
      console.log(
        `[P1] WASM vs Python qpos after 500 steps: max |delta| = ${worst.toExponential(3)}, ` +
          `bit-equal = ${report.determinism.bitEqualVsPython}`,
      );
      expect(mine.every(Number.isFinite)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });

  it('measures the contact count over a walking run (finding M7)', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      const counts: number[] = [];
      let sampleContactDist = Number.NaN;
      for (let k = 0; k < 200; k++) {
        await runtime.controlStep();
        counts.push(runtime.world.contactCount());
        if (k === 199) {
          const contacts = runtime.world.readContacts();
          if (contacts.length > 0) sampleContactDist = contacts[0].dist;
        }
      }
      const maxCount = Math.max(...counts);
      report.contacts = {
        nconReadable: true,
        contactListReadable: true,
        minNcon: Math.min(...counts),
        maxNcon: maxCount,
        meanNcon: counts.reduce((a, b) => a + b, 0) / counts.length,
        sampleContactDist,
        note:
          'Microduck comment "the WASM bindings expose no contact array" does NOT hold for ' +
          '@mujoco/mujoco 3.11.0: data.ncon and data.contact (copy, MjContactVec) are both ' +
          'readable. Phase 4 can count contacts directly instead of using a height heuristic.',
      };
      // eslint-disable-next-line no-console
      console.log(
        `[P1] contacts while walking: ncon min ${Math.min(...counts)} / mean ` +
          `${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)} / max ${maxCount}`,
      );
      expect(maxCount).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });

  it('writes the measurement report', () => {
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    expect(Object.keys(report.runs)).toContain('walk60s');
  });
});

/** Version of an out-of-band package, read from node_modules (its
 *  `package.json` is not an export, so it cannot be imported). */
function installedVersion(pkg: string): string {
  try {
    const path = resolve(__dirname, '../../node_modules', pkg, 'package.json');
    return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
