// plan-659 test 9.3 — policy scheduler: beat, modes, NaN guard, reset, pause.
//
// Runs on a FAKE driver: no MuJoCo, no ORT, no fixture. That is the point —
// the properties under test are properties of the scheduler, and a fake policy
// that returns its own step index makes "action k was applied to exactly the
// substeps after observation k" directly checkable from a log.

import { describe, expect, it } from 'vitest';
import {
  RVMuJoCoScheduler,
  type RVMuJoCoPolicyDriver,
} from '@rv-private/mujoco/rv-mujoco-scheduler';

const DT = 0.005;
const DECIMATION = 4;
const PERIOD = DT * DECIMATION; // 0.02 s = 50 Hz

interface FakeLog {
  /** One entry per physics batch: the action value `ctrl` held during it. */
  steps: number[];
  observations: number[];
  applied: number[];
}

/** A driver whose "policy" returns the index of the observation it was given,
 *  after an optional delay. `ctrl` is simply the last accepted action. */
function makeFakeDriver(options: {
  delayMs?: number;
  action?: (k: number) => number | null;
  throwOnStep?: number;
  throwInInfer?: boolean;
} = {}): { driver: RVMuJoCoPolicyDriver; log: FakeLog; bumpGeneration: () => void } {
  const log: FakeLog = { steps: [], observations: [], applied: [] };
  let k = 0;
  let ctrl = -1;
  let generation = 0;
  const driver: RVMuJoCoPolicyDriver = {
    decimation: DECIMATION,
    physicsDt: DT,
    get generation() {
      return generation;
    },
    buildObservation() {
      const obs = new Float32Array([k]);
      log.observations.push(k);
      k++;
      return obs;
    },
    async infer(observation) {
      const index = observation[0];
      if (options.throwInInfer) throw new Error('inference exploded');
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      const value = options.action ? options.action(index) : index;
      return value === null ? null : new Float32Array([value]);
    },
    applyAction(action) {
      if (!Number.isFinite(action[0])) return false;
      ctrl = action[0];
      log.applied.push(ctrl);
      return true;
    },
    step(steps) {
      if (options.throwOnStep !== undefined && log.steps.length === options.throwOnStep) {
        throw new Error('injected WASM trap');
      }
      expect(steps).toBe(DECIMATION);
      log.steps.push(ctrl);
    },
  };
  return { driver, log, bumpGeneration: () => generation++ };
}

/** Let every queued microtask and timer run. */
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('9.3 policy scheduler', () => {
  it('runs exactly one policy step per policy period, without drift', async () => {
    const { driver, log } = makeFakeDriver();
    const scheduler = new RVMuJoCoScheduler(driver);
    // 200 frames at 60 Hz = 3.333 s → 166 policy steps at 50 Hz.
    for (let i = 0; i < 200; i++) {
      scheduler.advance(1 / 60);
      await settle();
    }
    const stats = scheduler.stats();
    expect(stats.policySteps).toBe(log.steps.length);
    expect(log.steps.length).toBeGreaterThanOrEqual(165);
    expect(log.steps.length).toBeLessThanOrEqual(167);
    expect(stats.simTimeS).toBeCloseTo(log.steps.length * PERIOD, 10);
    expect(stats.droppedSimTimeS).toBe(0);
    // No drift: what is left over is always less than one period.
    expect(stats.backlogS).toBeLessThan(PERIOD);
  });

  it('parity: action k is applied to exactly the substeps after observation k', async () => {
    for (const delayMs of [0, 15, 60]) {
      const { driver, log } = makeFakeDriver({ delayMs });
      const scheduler = new RVMuJoCoScheduler(driver, { mode: 'parity' });
      for (let i = 0; i < 30; i++) {
        scheduler.advance(1 / 60);
        await settle(delayMs + 2);
      }
      // The fake policy returns the observation index, so the ctrl held during
      // physics batch k MUST be k — for every delay, by construction of parity.
      expect(log.steps.length).toBeGreaterThan(5);
      log.steps.forEach((value, index) => expect(value).toBe(index));
    }
  });

  it('parity keeps at most one inference in flight and catches the backlog up', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { driver, log } = makeFakeDriver({ delayMs: 5 });
    const original = driver.infer.bind(driver);
    const watched: RVMuJoCoPolicyDriver = {
      ...driver,
      get decimation() { return driver.decimation; },
      get physicsDt() { return driver.physicsDt; },
      get generation() { return driver.generation; },
      buildObservation: () => driver.buildObservation(),
      applyAction: (a) => driver.applyAction(a),
      step: (n) => driver.step(n),
      infer: async (obs) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await original(obs);
        } finally {
          inFlight--;
        }
      },
    };
    const scheduler = new RVMuJoCoScheduler(watched, { mode: 'parity' });
    // One big frame: 100 ms of wall clock = 5 policy periods owed at once.
    scheduler.advance(0.1);
    await settle(200);
    expect(maxInFlight).toBe(1);
    expect(log.steps.length).toBe(5);
    expect(scheduler.stats().droppedSimTimeS).toBe(0);
  });

  it('hold: the world keeps stepping on the previous action while inference runs', async () => {
    const { driver, log } = makeFakeDriver({ delayMs: 30 });
    const scheduler = new RVMuJoCoScheduler(driver, { mode: 'hold' });
    for (let i = 0; i < 20; i++) {
      scheduler.advance(1 / 60);
      await settle(2);
    }
    expect(log.steps.length).toBeGreaterThan(3);
    // The first batch runs before ANY action has arrived (ctrl still -1), and
    // later batches lag behind their observation — that lag is what `hold`
    // exists to measure.
    expect(log.steps[0]).toBe(-1);
    expect(log.steps.some((value, index) => value < index)).toBe(true);
  });

  it('counts dropped simulation time once the backlog cap is hit', async () => {
    const { driver } = makeFakeDriver();
    const scheduler = new RVMuJoCoScheduler(driver, { maxBacklogSteps: 6, maxFrameDt: 10 });
    scheduler.advance(1.0); // 50 policy periods owed, cap is 6
    const dropped = scheduler.stats().droppedSimTimeS;
    expect(dropped).toBeCloseTo(1.0 - 6 * PERIOD, 10);
    await settle(20);
    expect(scheduler.stats().policySteps).toBe(6);
  });

  it('never writes a non-finite action and keeps running', async () => {
    const { driver, log } = makeFakeDriver({ action: (k) => (k === 2 ? Number.NaN : k) });
    const scheduler = new RVMuJoCoScheduler(driver);
    for (let i = 0; i < 20; i++) {
      scheduler.advance(1 / 60);
      await settle();
    }
    expect(scheduler.stats().nonFiniteActions).toBe(1);
    expect(log.applied).not.toContain(Number.NaN);
    // Step 2 ran with the PREVIOUS target (1), and the run continued.
    expect(log.steps[2]).toBe(1);
    expect(log.steps.length).toBeGreaterThan(10);
  });

  it('discards a result whose generation moved on (reset during inference)', async () => {
    const { driver, log, bumpGeneration } = makeFakeDriver({ delayMs: 30 });
    const scheduler = new RVMuJoCoScheduler(driver);
    scheduler.advance(PERIOD);
    bumpGeneration(); // "reset" while the inference is in flight
    await settle(60);
    expect(scheduler.stats().staleResults).toBe(1);
    expect(log.steps.length).toBe(0);
    expect(log.applied.length).toBe(0);
  });

  it('pause stops the world, resume continues it', async () => {
    const { driver, log } = makeFakeDriver();
    const scheduler = new RVMuJoCoScheduler(driver);
    scheduler.advance(0.1);
    await settle(10);
    const after = log.steps.length;
    expect(after).toBeGreaterThan(0);
    scheduler.stop();
    scheduler.advance(0.1);
    await settle(10);
    expect(log.steps.length).toBe(after);
    scheduler.start();
    scheduler.advance(0.1);
    await settle(20);
    expect(log.steps.length).toBeGreaterThan(after);
  });

  it('fails off on a trap in the physics and on a rejecting inference', async () => {
    const trapped: unknown[] = [];
    const { driver } = makeFakeDriver({ throwOnStep: 3 });
    const scheduler = new RVMuJoCoScheduler(driver, { onError: (e) => trapped.push(e) });
    for (let i = 0; i < 20; i++) {
      scheduler.advance(1 / 60);
      await settle();
    }
    expect(trapped).toHaveLength(1);
    expect(scheduler.hasFailed).toBe(true);
    expect(scheduler.isRunning).toBe(false);

    const rejected: unknown[] = [];
    const bad = makeFakeDriver({ throwInInfer: true });
    const second = new RVMuJoCoScheduler(bad.driver, { onError: (e) => rejected.push(e) });
    second.advance(0.1);
    await settle(20);
    expect(rejected).toHaveLength(1);
    expect(second.hasFailed).toBe(true);
  });
});
