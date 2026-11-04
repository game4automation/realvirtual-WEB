// plan-659 scaling spike — ONE measured Microduck instance.
//
// Lifecycle, and the reason for it: everything that is a START cost happens
// BEFORE the instance reports `ready`, and the measured window only opens when
// the orchestrator releases the barrier. Excluded from the measurement by
// construction:
//   - process start / Node boot
//   - MJCF + 9 STL loads, MuJoCo model compile
//   - ONNX session construction (ORT graph optimisation)
//   - JIT warm-up (WARMUP_STEPS control steps, then the start state is restored)
//
// The measured work per instance is R episodes x STEPS_PER_EPISODE control
// steps, each episode from the SAME fixed start state. Phase 1 proved the chain
// is deterministic, so every instance performs bit-identical work — which is
// what makes an aggregate throughput number meaningful at all. Episodes are
// capped at 30 s sim time because that is inside the regime Phase 1 validated
// as fall-free (60 s); a long single run risks a fall, and a fallen duck has a
// different contact count and therefore a different cost.

import { RVMicroduckRuntime } from '../rv-microduck-runtime';
import { setOrtLibLoader } from '@rv-private/mujoco/rv-locomotion-policy';

interface Args {
  episodes: number;
  stepsPerEpisode: number;
  vx: number;
  pinThreads: boolean;
  warmupSteps: number;
  trackLatency: boolean;
  id: number;
}

function parseArgs(): Args {
  const get = (k: string, d: string) => {
    const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  return {
    episodes: Number(get('episodes', '32')),
    stepsPerEpisode: Number(get('steps', '1500')),
    vx: Number(get('vx', '0.25')),
    pinThreads: get('pin', '1') === '1',
    warmupSteps: Number(get('warmup', '300')),
    trackLatency: get('latency', '0') === '1',
    id: Number(get('id', '0')),
  };
}

/**
 * ORT with its thread pools pinned to one thread each.
 *
 * WHY this is not optional: the production loader (`defaultOrtLibLoader`) sets
 * no `intraOpNumThreads`, so ORT sizes its pool from the core count. One
 * process is harmless, but N processes each opening a 24-thread pool for a
 * 2-layer MLP oversubscribe the machine by an order of magnitude — the curve
 * would then measure the Windows scheduler, not the simulation. Injected
 * through the production seam `setOrtLibLoader`, so no production file changes.
 */
function pinOrtToOneThread(): void {
  setOrtLibLoader(async () => {
    const mod: any = await import('onnxruntime-node');
    const ort = mod.default?.InferenceSession ? mod.default : mod;
    return {
      createSession: async (model: any) =>
        await ort.InferenceSession.create(model, {
          executionProviders: ['cpu'],
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        }),
      createFloatTensor: (data: Float32Array, dims: readonly number[]) =>
        new ort.Tensor('float32', data, dims as number[]),
    };
  });
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Resolve once the orchestrator writes a line on stdin (the barrier). */
function waitForGo(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.pinThreads) pinOrtToOneThread();

  const t0 = performance.now();
  const rt = await RVMicroduckRuntime.create('walking');
  const loadMs = performance.now() - t0;

  try {
    rt.setForwardVelocity(args.vx);

    // Warm-up OUTSIDE the measured window: first-call ORT allocation, WASM
    // tier-up and the Node JIT all settle here.
    rt.initStartState();
    if (args.warmupSteps > 0) await rt.run(args.warmupSteps, { trackLatency: false });
    const warmMs = performance.now() - t0 - loadMs;

    emit({ ev: 'ready', id: args.id, loadMs, warmMs });
    await waitForGo();

    const dtControl = rt.contract.timestep * rt.contract.decimation;
    let simSeconds = 0;
    let wallS = 0;
    let physicsWallS = 0;
    let falls = 0;
    const displacements: number[] = [];
    const latencies: number[] = [];

    const wall0 = performance.now();
    for (let e = 0; e < args.episodes; e++) {
      // Fixed start state per episode — identical, deterministic work unit.
      rt.initStartState();
      rt.setForwardVelocity(args.vx);
      const s = await rt.run(args.stepsPerEpisode, { trackLatency: args.trackLatency });
      simSeconds += s.simTimeS;
      wallS += s.wallClockS;
      physicsWallS += s.physicsWallS;
      if (s.fallen) falls++;
      displacements.push(s.displacementXM);
      if (args.trackLatency) for (const l of s.policyLatenciesMs) latencies.push(l);
    }
    const windowS = (performance.now() - wall0) / 1000;

    emit({
      ev: 'done',
      id: args.id,
      episodes: args.episodes,
      stepsPerEpisode: args.stepsPerEpisode,
      controlSteps: args.episodes * args.stepsPerEpisode,
      dtControl,
      simSeconds,
      // Self-measured: sum of the in-loop wall clocks (excludes the per-episode
      // reset), and the whole barrier-to-finish window (includes resets).
      loopWallS: wallS,
      windowS,
      physicsWallS,
      selfThroughput: simSeconds / windowS,
      falls,
      displacementXFirst: displacements[0],
      displacementXAllEqual: displacements.every((d) => d === displacements[0]),
      latencyMedianMs: args.trackLatency ? median(latencies) : null,
      latencyP95Ms: args.trackLatency ? percentile(latencies, 95) : null,
      latencyCount: latencies.length,
    });
  } finally {
    await rt.dispose();
  }
}

function median(xs: number[]): number | null {
  return percentile(xs, 50);
}

function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

main().then(
  () => process.exit(0),
  (err) => {
    emit({ ev: 'error', message: String(err?.stack ?? err) });
    process.exit(1);
  },
);
