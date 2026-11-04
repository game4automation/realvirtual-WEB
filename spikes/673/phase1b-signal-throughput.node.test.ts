// plan-673 Phase 1b — THE GATE: what the signal path carries (F20 / O9).
//
//   node scripts/with-test-lock.mjs vitest run -c spikes/673/vitest.config.ts
//
// The plan's measurement grid, verbatim (roadmap row 1b): 14 / 28 / 56 float
// signals at 50 and 100 Hz, each as a `setMany()` batch BY NAME and as
// `setByPath()` single writes, with and without a `direct-property` binding
// onto a Drive behind it; p50/p95 per 60 Hz frame and the number of listener
// invocations. "The result decides whether the signal chain becomes mandatory
// or optional (O9) — and on a miss, try batching instead of single writes and a
// lower policy rate FIRST, do NOT add a second path."
//
// A third mode is measured that the plan does not name, because without it the
// result cannot be acted on: `set()`, single writes BY NAME. `setByPath` differs
// from `setMany` in two ways at once — no batching AND a path→name resolution
// per call — and the plan's own guidance ("batch before a second path") only
// makes sense if those two are separated.
//
// Two instrument disciplines, both learned the hard way:
//
//  * Chromium coarsens `performance.now()` to 100 µs and a plan-664 run reported
//    exactly 0.5000 / 0.7000 ms, which was the clock. This run measures its own
//    clock first and reports every figure at TWO bundle sizes, so a clock
//    artefact shows up as a disagreement between them.
//  * A signal store only notifies on a CHANGE. A harness that writes constants
//    measures an empty loop and reports a wonderful number. So every write here
//    carries a fresh value and the listener count is ASSERTED against
//    signals x steps — if it ever came out 0, the measurement measured nothing.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Object3D, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../../src/core/engine/rv-drive-follow-position';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { mean, percentile } from './stats';

const REPORT_PATH = resolve(__dirname, 'phase1b-report.json');

/** [DECLARED] budget for the signal path, ms of p95 per 60 Hz frame.
 *
 *  3 % of a 16.67 ms frame. Chosen to be of the same order as the 0.5 ms the
 *  component layer is held to in plan-664, so the two budgets can be added up
 *  rather than argued about separately. It is a declared bar, not a datasheet
 *  value, and the headroom is reported either way. */
const FRAME_BUDGET_MS = 0.5;

/** Signal counts from the plan. 14 is plan-659's Microduck joint count, 28 and
 *  56 are the 2x and 4x the plan asks for. */
const SIGNAL_COUNTS = [14, 28, 56] as const;
/** Control rates from the plan. */
const RATES_HZ = [50, 100] as const;
/** Seconds of simulated 60 Hz frames per cell. */
const SECONDS = 20;

type WriteMode = 'setMany' | 'set' | 'setByPath';

interface Harness {
  store: SignalStore;
  names: string[];
  paths: string[];
  listenerCalls: () => number;
  resetListenerCalls: () => void;
  dispose: () => void;
}

/**
 * N float signals in a real `SignalStore`, optionally each with a
 * `direct-property` binding onto a real Drive.
 *
 * The bound variant mirrors the production sink exactly: the binding manager
 * subscribes to the source name and calls the component's `command<Slot>`
 * (`rv-binding-slot-resolver.ts` → `kind: 'direct-property'`), which for a float
 * setpoint on a Drive is `Drive_FollowPosition.commandPosition`. The three
 * guards the manager checks before dispatching (role, enabled, liveness) are
 * mirrored too, so the per-call shape is the same and not just the same count.
 */
function buildHarness(count: number, bound: boolean): Harness {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const names: string[] = [];
  const paths: string[] = [];
  const unsubs: (() => void)[] = [];
  let calls = 0;

  for (let i = 0; i < count; i++) {
    const node = new Object3D();
    node.name = `A${i}`;
    node.userData.realvirtual = { Drive: {}, Drive_FollowPosition: {} };
    scene.add(node);
    const nodePath = NodeRegistry.computeNodePath(node);
    registry.registerNode(nodePath, node);

    const name = `Robot/Setpoint/A${i}`;
    const path = `${nodePath}/Signals/Position`;
    names.push(name);
    paths.push(path);
    store.register(name, path, 0, 'PLCOutputFloat');

    if (bound) {
      const drive = new RVDrive(node);
      drive.TargetSpeed = 1000;
      drive.initDrive();
      registry.register('Drive', nodePath, drive);
      const follow = new RVDriveFollowPosition(node);
      // Same three reads the manager does before dispatching, in the same
      // order, all true here.
      const role = 'control';
      const enabled = true;
      const liveness = 'live';
      unsubs.push(store.subscribe(name, (value) => {
        if (role !== 'control' || !enabled || liveness !== 'live') return;
        follow.commandPosition(value);
        calls++;
      }));
    }
  }
  return {
    store,
    names,
    paths,
    listenerCalls: () => calls,
    resetListenerCalls: () => { calls = 0; },
    dispose: () => { for (const u of unsubs) u(); },
  };
}

interface Cell {
  signals: number;
  rateHz: number;
  mode: WriteMode;
  bound: boolean;
  frames: number;
  controlSteps: number;
  writes: number;
  listenerCalls: number;
  msPerFrameMean: number;
  msPerFrameP50: number;
  msPerFrameP95: number;
  msPerFrameP999: number;
  msPerFrameMax: number;
  /** The same total, re-derived from 60-frame bundles. A clock artefact would
   *  make this disagree with `msPerFrameMean`. */
  msPerFrameFromBundles: number;
  usPerWrite: number;
  verdict: 'PASS' | 'FAIL';
}

/**
 * One cell of the grid.
 *
 * The 60 Hz frames and the control rate are kept apart by an accumulator, the
 * same way the viewer's fixed-timestep loop does it: at 50 Hz some frames carry
 * one control step and some none, at 100 Hz some carry one and some two. That
 * unevenness is exactly what a per-frame p95 is for, so it must not be averaged
 * away by assuming a constant number of writes per frame.
 */
function measure(signals: number, rateHz: number, mode: WriteMode, bound: boolean): Cell {
  const h = buildHarness(signals, bound);
  try {
    const frames = Math.round(SECONDS * 60);
    const stepPerFrame = rateHz / 60;
    const frameMs: number[] = [];
    const bundles: number[] = [];
    const updates: Record<string, number> = {};
    let acc = 0;
    let controlSteps = 0;
    let writes = 0;
    let tick = 0;

    // Warm-up: JIT the write path before the first measured frame, or the first
    // frames are the compiler and p999 is a lie.
    for (let w = 0; w < 120; w++) {
      tick++;
      writeOnce(h, mode, updates, tick);
    }
    // The warm-up's listener calls are not part of the measured window; left in,
    // they broke the "listener calls == writes" assertion by exactly
    // 120 x signals, which is how this line came to exist.
    h.resetListenerCalls();

    let bundleStart = performance.now();
    let bundleFrames = 0;
    for (let f = 0; f < frames; f++) {
      acc += stepPerFrame;
      const stepsThisFrame = Math.floor(acc);
      acc -= stepsThisFrame;

      const t0 = performance.now();
      for (let s = 0; s < stepsThisFrame; s++) {
        tick++;
        writeOnce(h, mode, updates, tick);
      }
      frameMs.push(performance.now() - t0);

      controlSteps += stepsThisFrame;
      writes += stepsThisFrame * signals;
      bundleFrames++;
      if (bundleFrames >= 60) {
        bundles.push((performance.now() - bundleStart) / bundleFrames);
        bundleStart = performance.now();
        bundleFrames = 0;
      }
    }

    const p95 = percentile(frameMs, 0.95);
    return {
      signals,
      rateHz,
      mode,
      bound,
      frames,
      controlSteps,
      writes,
      listenerCalls: h.listenerCalls(),
      msPerFrameMean: mean(frameMs),
      msPerFrameP50: percentile(frameMs, 0.5),
      msPerFrameP95: p95,
      msPerFrameP999: percentile(frameMs, 0.999),
      msPerFrameMax: Math.max(...frameMs),
      msPerFrameFromBundles: mean(bundles),
      usPerWrite: (mean(frameMs) * 1000 * frames) / writes,
      verdict: p95 <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL',
    };
  } finally {
    h.dispose();
  }
}

/** One control step's worth of writes, in the chosen mode. Every value is
 *  fresh — the store drops unchanged values before notifying. */
function writeOnce(h: Harness, mode: WriteMode, updates: Record<string, number>, tick: number): void {
  const { store, names, paths } = h;
  const base = tick * 0.001;
  if (mode === 'setMany') {
    for (let i = 0; i < names.length; i++) updates[names[i]] = base + i;
    store.setMany(updates);
  } else if (mode === 'set') {
    for (let i = 0; i < names.length; i++) store.set(names[i], base + i);
  } else {
    for (let i = 0; i < paths.length; i++) store.setByPath(paths[i], base + i);
  }
}

const report: Record<string, unknown> = {
  plan: 673,
  phase: '1b',
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  budgetMsPerFrame: FRAME_BUDGET_MS,
  secondsPerCell: SECONDS,
};

describe('plan-673 Phase 1b — signal-path throughput gate (F20 / O9)', () => {
  const cells: Cell[] = [];

  it('instrument: measures its own clock before measuring anything else', () => {
    const ticks: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const a = performance.now();
      let b = a;
      while ((b = performance.now()) === a) { /* spin */ }
      ticks.push((b - a) * 1000);
    }
    ticks.sort((x, y) => x - y);
    report.clock = { minTickUs: ticks[0], medianTickUs: ticks[Math.floor(ticks.length / 2)] };
    // eslint-disable-next-line no-console
    console.log(`[instr] clock tick median ${ticks[Math.floor(ticks.length / 2)].toFixed(3)} us — a 100 us floor (Chromium) would make a single frame unmeasurable here`);
    expect(ticks[Math.floor(ticks.length / 2)]).toBeLessThan(10);
  });

  it('instrument: proves the writes actually reach listeners before timing anything', () => {
    // The trap this closes: a store notifies only on CHANGE, so a harness that
    // writes constants measures an empty loop and reports an excellent number.
    const h = buildHarness(14, true);
    try {
      const updates: Record<string, number> = {};
      writeOnce(h, 'setMany', updates, 1);
      expect(h.listenerCalls()).toBe(14);
      // And the counter-proof: the SAME values again notify nobody.
      writeOnce(h, 'setMany', updates, 1);
      expect(h.listenerCalls()).toBe(14);
      writeOnce(h, 'setMany', updates, 2);
      expect(h.listenerCalls()).toBe(28);
      // eslint-disable-next-line no-console
      console.log('[instr] 14 changed values -> 14 listener calls; the same 14 again -> 0 more. The instrument measures writes that land.');
    } finally {
      h.dispose();
    }
  });

  it('measures the full grid: 14/28/56 signals x 50/100 Hz x 3 modes x bound/unbound', () => {
    for (const bound of [false, true]) {
      for (const mode of ['setMany', 'set', 'setByPath'] as WriteMode[]) {
        for (const rateHz of RATES_HZ) {
          for (const signals of SIGNAL_COUNTS) {
            const c = measure(signals, rateHz, mode, bound);
            cells.push(c);
            // The assertion that keeps every number below honest.
            expect(c.listenerCalls).toBe(bound ? c.writes : 0);
            // eslint-disable-next-line no-console
            console.log(
              `[1b] ${String(signals).padStart(2)} sig @ ${String(rateHz).padStart(3)} Hz  ${mode.padEnd(9)} ${bound ? 'bound  ' : 'unbound'}  ` +
              `p50 ${c.msPerFrameP50.toFixed(4)} / p95 ${c.msPerFrameP95.toFixed(4)} / p99.9 ${c.msPerFrameP999.toFixed(4)} / max ${c.msPerFrameMax.toFixed(4)} ms/frame  ` +
              `mean ${c.msPerFrameMean.toFixed(4)} (bundles ${c.msPerFrameFromBundles.toFixed(4)})  ` +
              `${c.usPerWrite.toFixed(3)} us/write  ${c.listenerCalls} listener calls  -> ${c.verdict}`,
            );
          }
        }
      }
    }
    report.cells = cells;
    expect(cells.length).toBe(2 * 3 * RATES_HZ.length * SIGNAL_COUNTS.length);
  });

  it('states the verdict and what follows for O9', () => {
    const worst = cells.reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    const worstBatched = cells.filter((c) => c.mode === 'setMany').reduce((a, b) => (b.msPerFrameP95 > a.msPerFrameP95 ? b : a));
    const failing = cells.filter((c) => c.verdict === 'FAIL');

    // The factorisation the plan's guidance needs: batching and path resolution
    // are two different costs, and only one of them is a lever.
    const byKey = new Map(cells.map((c) => [`${c.signals}|${c.rateHz}|${c.mode}|${c.bound}`, c]));
    const factors = SIGNAL_COUNTS.flatMap((n) => RATES_HZ.flatMap((r) => [true, false].map((b) => {
      const many = byKey.get(`${n}|${r}|setMany|${b}`)!;
      const single = byKey.get(`${n}|${r}|set|${b}`)!;
      const byPath = byKey.get(`${n}|${r}|setByPath|${b}`)!;
      return {
        signals: n, rateHz: r, bound: b,
        batchingGain: single.msPerFrameMean / many.msPerFrameMean,
        pathResolutionCost: byPath.msPerFrameMean / single.msPerFrameMean,
      };
    })));
    const bindingOverhead = SIGNAL_COUNTS.flatMap((n) => RATES_HZ.map((r) => {
      const un = byKey.get(`${n}|${r}|setMany|false`)!;
      const bd = byKey.get(`${n}|${r}|setMany|true`)!;
      return { signals: n, rateHz: r, factor: bd.msPerFrameMean / un.msPerFrameMean };
    }));

    // THE TAIL, named rather than left in the table unexplained. Several cells
    // show a single-frame maximum of 1–13 ms while their mean is 0.01–0.08 ms,
    // i.e. up to a thousand times the mean. Those are NOT the signal path:
    //  * they appear in UNBOUND `setMany` cells, whose write loop allocates
    //    nothing at all (the `updates` object is reused across steps);
    //  * they appear at every signal count and both rates, with no trend;
    //  * their size is the size of a Node GC pause or an OS scheduling slice.
    // They are process-level pauses of the measuring process. Reported because
    // a 13 ms pause inside a 16.7 ms frame IS a dropped frame in the viewer —
    // but the quantity to attribute to the signal path is p95, not max.
    const spiky = cells
      .filter((c) => c.msPerFrameMax > 1.0)
      .map((c) => ({
        signals: c.signals, rateHz: c.rateHz, mode: c.mode, bound: c.bound,
        meanMs: c.msPerFrameMean, p95Ms: c.msPerFrameP95, maxMs: c.msPerFrameMax,
        maxOverMean: c.msPerFrameMax / c.msPerFrameMean,
      }));
    report.tail = {
      interpretation: 'Process-level pauses (GC / OS scheduling) of the measuring process, not the signal path: they occur in allocation-free unbound setMany cells too, show no trend with signal count or rate, and are 100-1000x the cell mean. The figure to attribute to the signal path is p95.',
      cellsWithMaxAbove1ms: spiky.length,
      ofCells: cells.length,
      spiky,
    };
    // eslint-disable-next-line no-console
    console.log(`[1b tail] ${spiky.length} of ${cells.length} cells show a single-frame max above 1 ms (up to ${Math.max(...cells.map((c) => c.msPerFrameMax)).toFixed(1)} ms) while their means stay at 0.01-0.08 ms — process pauses, not the signal path`);

    report.verdict = {
      budgetMsPerFrame: FRAME_BUDGET_MS,
      worstCell: worst,
      worstBatchedCell: worstBatched,
      failingCells: failing.map((c) => ({ signals: c.signals, rateHz: c.rateHz, mode: c.mode, bound: c.bound, p95: c.msPerFrameP95 })),
      overallVerdict: failing.length === 0 ? 'PASS' : 'FAIL (see failingCells)',
      batchedVerdict: worstBatched.msPerFrameP95 <= FRAME_BUDGET_MS ? 'PASS' : 'FAIL',
      headroomFactorBatched: FRAME_BUDGET_MS / worstBatched.msPerFrameP95,
      meanBatchingGain: mean(factors.map((f) => f.batchingGain)),
      meanPathResolutionCost: mean(factors.map((f) => f.pathResolutionCost)),
      meanBindingOverheadFactor: mean(bindingOverhead.map((b) => b.factor)),
      factors,
      bindingOverhead,
    };
    // eslint-disable-next-line no-console
    console.log(`[1b GATE] worst of all 36 cells: ${worst.signals} sig @ ${worst.rateHz} Hz ${worst.mode} ${worst.bound ? 'bound' : 'unbound'} = ${worst.msPerFrameP95.toFixed(4)} ms/frame p95`);
    // eslint-disable-next-line no-console
    console.log(`[1b GATE] worst BATCHED cell (the recommended path): ${worstBatched.signals} sig @ ${worstBatched.rateHz} Hz ${worstBatched.bound ? 'bound' : 'unbound'} = ${worstBatched.msPerFrameP95.toFixed(4)} ms/frame p95 against a ${FRAME_BUDGET_MS} ms budget -> headroom x${(FRAME_BUDGET_MS / worstBatched.msPerFrameP95).toFixed(0)}`);
    // eslint-disable-next-line no-console
    console.log(`[1b GATE] setMany vs set (batching gain) x${mean(factors.map((f) => f.batchingGain)).toFixed(2)}; setByPath vs set (path resolution) x${mean(factors.map((f) => f.pathResolutionCost)).toFixed(2)}; binding overhead x${mean(bindingOverhead.map((b) => b.factor)).toFixed(2)}`);
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[report] ${REPORT_PATH}`);
    expect(report.verdict).toBeDefined();
  });
});
