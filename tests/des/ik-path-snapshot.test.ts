// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ikPathKeyTable } from '../../src/plugins/des/rv-des-ik-snapshot';
import { claimAxes, releaseAxes } from '../../src/core/engine/rv-axis-ownership';
import { assertContinuation, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { ikWorld, IKProSolverUnavailable, IK_WAIT, type IKWorld } from './continuation-ik-world';

type Kind = 'lin' | 'ptp' | 'wait';
const state = (w: IKWorld) => w.path as unknown as {
  _linActive: boolean; _linPos: number; _linDist: number; _linSpeed: number;
  _activeMoving: boolean; _ptpRampActive: boolean; _warm: Float64Array; _seed: number[]; _linDecel: boolean;
};
function atCut(w: IKWorld, kind: Kind): boolean {
  const s = state(w);
  if (!w.path.PathIsActive) return false;
  if (kind === 'lin') return s._linActive && s._linPos > 0 && s._linPos < s._linDist && s._linSpeed > 0;
  if (kind === 'wait') return w.path.WaitForSignal && w.v.signalStore!.get(IK_WAIT) === false;
  return !s._linActive && !s._ptpRampActive && s._activeMoving && w.drives.some(d =>
    d.isRunning && d.UseAcceleration && d.currentSpeed > 0 && d.currentSpeed < d.targetSpeed);
}

// Filled from the quarter-second probe below; guard each capture against drift.
const CUTS: Record<Kind, number> = { lin: 2.5, ptp: 0.25, wait: 11.75 };

/** The next representable float toward +infinity (no rounded decimal epsilon). */
function nextUp(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Expected finite perturbation source');
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + (value > 0 ? 1n : -1n));
  return view.getFloat64(0);
}

async function build(solver = true) {
  const w = await ikWorld({ solver });
  const step = w.step.bind(w);
  w.step = t => {
    step(t);
    for (const kind of ['lin', 'ptp', 'wait'] as const) {
      if (t === CUTS[kind] && (solver || kind === 'ptp')) expect(atCut(w, kind), `${kind} guard at ${t}`).toBe(true);
    }
  };
  const fullSnapshot = w.runner.fullSnapshot.bind(w.runner);
  w.runner.fullSnapshot = () => {
    const snapshot = fullSnapshot();
    const ik = snapshot.parts.find(p => p.key === 'core.ik');
    expect(ik).toBeDefined();
    expect(JSON.stringify(ik)).not.toContain('"_warm"');
    return snapshot;
  };
  return w;
}

describe('real WASM IK path snapshot continuation', () => {
  let unavailable: string | undefined;
  beforeAll(async () => {
    try { const w = await ikWorld({ solver: true }); w.dispose(); }
    catch (error) {
      if (!(error instanceof IKProSolverUnavailable)) throw error;
      unavailable = error.message; console.warn(unavailable);
    }
  }, 180_000);
  beforeEach(ctx => { if (unavailable) ctx.skip(unavailable); });

  it('probes the quarter-second cut grid and verifies LIN never falls back', async () => {
    const w = await ikWorld({ solver: true });
    try {
      const keys = [...ikPathKeyTable.stateKeys, ...ikPathKeyTable.services];
      expect(new Set(keys).size).toBe(keys.length);
      expect(Reflect.ownKeys(w.path).filter(key => !keys.includes(String(key)))).toEqual([]);
      const found = new Map<Kind, number>();
      for (let t = 0.25; t <= 36; t += 0.25) {
        w.step(t);
        for (const kind of ['lin', 'ptp', 'wait'] as const) {
          if (!found.has(kind) && atCut(w, kind)) {
            found.set(kind, t); console.info(`MATRIX_IK_CUT ${JSON.stringify({ kind, t })}`);
          }
          if (t === CUTS[kind]) expect(atCut(w, kind), `${kind} cut at ${t}`).toBe(true);
        }
      }
      expect([...found.keys()].sort()).toEqual(['lin', 'ptp', 'wait']);
      expect(w.runs.filter(e => e.type === 'lin-fallback')).toEqual([]);
      expect(w.runs.filter(e => e.type === 'finished').length).toBeGreaterThanOrEqual(2);
    } finally { w.dispose(); }
  }, 180_000);

  for (const kind of ['lin', 'ptp', 'wait'] as const) {
    for (const mode of ['A', 'B', 'B-immediate'] as const) {
      it(`${kind}: ${mode} continues bit-exactly`, async () => {
        const T = CUTS[kind];
        await assertContinuation({ buildWorld: () => build(), mode, T, TPrime: T + 6, T2: T + 12 });
      }, 180_000);
    }
  }

  it('rebuilds NaN warm-start and seed scratch from restored axes with WASM', async () => {
    await assertContinuation({ buildWorld: () => build(), mode: 'B', T: CUTS.lin,
      TPrime: CUTS.lin + 6, T2: CUTS.lin + 12,
      afterRestore(world) {
        for (const path of (world as IKWorld).paths) {
          const scratch = path as unknown as { _warm: Float64Array; _seed: number[] };
          scratch._warm.fill(NaN); scratch._seed.fill(NaN);
        }
      },
    });
  }, 180_000);

  it('LIN state not saved: detects lost segment state after continuing in B', async () => {
    const continuation = assertContinuation({ buildWorld: () => build(), mode: 'B', T: CUTS.lin,
      TPrime: CUTS.lin + 6, T2: CUTS.lin + 2,
      afterRestore(world) {
        const s = state(world as IKWorld);
        s._linPos = 0; s._linSpeed = 0; s._linDecel = false;
      },
    });
    await expect(continuation).rejects.toBeInstanceOf(ContinuationMismatch);
    await continuation.catch(error => {
      console.info('MATRIX_IK_LIN_MISMATCH', JSON.stringify(error));
    });
  }, 180_000);

  it('axis position off by one ulp: detects the fault after continuing in B before arrival', async () => {
    const T2 = 0.5;
    // Probe the same quarter-second grid as the continuation world. The first
    // moving axis is still on target 0 at T2, before its first arrival snap.
    const probe = await build();
    let axis: number;
    try {
      probe.step(CUTS.ptp);
      axis = probe.drives.findIndex(d => d.isRunning && !d.isAtTarget);
      expect(axis).toBe(1);
      let firstAtTarget: number | undefined;
      let positionAtT2: number | undefined;
      for (let t = CUTS.ptp + 0.25; t <= CUTS.ptp + 6; t += 0.25) {
        probe.step(t);
        if (t === T2) {
          expect(probe.drives[axis].isRunning).toBe(true);
          expect(probe.drives[axis].isAtTarget).toBe(false);
          expect(probe.path.NumTarget).toBe(0);
          positionAtT2 = probe.drives[axis].currentPosition;
        }
        if (probe.drives[axis].isAtTarget) { firstAtTarget = t; break; }
      }
      expect(firstAtTarget).toBeDefined();
      expect(T2).toBeLessThan(firstAtTarget!);
      console.info(`MATRIX_IK_ULP_T2 ${JSON.stringify({ T: CUTS.ptp, T2, axis, firstAtTarget, positionAtT2 })}`);
    } finally { probe.dispose(); }

    const continuation = assertContinuation({ buildWorld: async () => {
      const w = await build();
      const step = w.step.bind(w);
      w.step = t => {
        step(t);
        if (t === T2) {
          expect(w.runner.renderClock).toBe(T2);
          expect(w.path.NumTarget).toBe(0);
          expect(w.drives[axis].isRunning).toBe(true);
          expect(w.drives[axis].isAtTarget).toBe(false);
        }
      };
      return w;
    }, mode: 'B', T: CUTS.ptp, TPrime: CUTS.ptp + 6, T2,
      afterRestore(world) {
        const drive = (world as IKWorld).drives[axis];
        expect(drive.isRunning).toBe(true); expect(drive.isAtTarget).toBe(false);
        const before = drive.currentPosition;
        drive.currentPosition = nextUp(before);
        console.info(`MATRIX_IK_ULP_MUTATION ${JSON.stringify({ axis, before,
          after: drive.currentPosition, delta: drive.currentPosition - before })}`);
      },
    });
    await expect(continuation).rejects.toBeInstanceOf(ContinuationMismatch);
    await expect(continuation).rejects.toMatchObject({ participant: 'des.drives' });
    await continuation.catch(error => {
      console.info('MATRIX_IK_ULP_MISMATCH', JSON.stringify(error));
    });
  }, 180_000);

  for (const mode of ['A', 'B'] as const) {
    it(`AxisPos fallback without solver: ${mode}`, async () => {
      await assertContinuation({ buildWorld: () => build(false), mode, T: CUTS.ptp,
        TPrime: CUTS.ptp + 6, T2: CUTS.ptp + 12 });
    }, 180_000);
  }

  it('refuses capture while a real axis claim pauses the running path', async () => {
    const w = await build(); const owner = { name: 'IK continuation pause probe' };
    try {
      w.step(CUTS.lin); claimAxes(w.drives, owner);
      const address = w.v.registry!.getAddressForNode(w.path.node);
      expect(address).toBeTruthy();
      expect(() => w.runner.fullSnapshot()).toThrow('des-snapshot-unsupported-component');
      expect(() => w.runner.fullSnapshot()).toThrow(`IK path ${address} is paused by an axis owner`);
    } finally { releaseAxes(owner); w.dispose(); }
  }, 180_000);
});
