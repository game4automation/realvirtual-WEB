// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-tier.test.ts — IK solver tier model + 1-robot free-limit (plan-233 Phase 0/1).
 *
 * Pure-TS tests against the public ikSolverRegistry with an injectable MOCK
 * provider (no real WASM). Covers:
 * - `available` backward-compat alias derived from `tier`
 * - `solveCobot` returns null in the free tier (no pro)
 * - `maxRobots===1` in free; per-robot live-solve claim (first robot wins,
 *   second falls back to replay)
 * - `tier==='none'` → `solvePieper` returns null (replay fallback), scene logic
 *   does not break
 * - per-robot reset after a clearModel-equivalent re-frees robot #1
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ikSolverRegistry,
  type IKSolverProvider,
  type IKTier,
  type IKSolution,
  type OpwParams,
  type JointChainParams,
} from '../src/core/engine/rv-ik-solver';

/** Minimal OPW params — values are irrelevant; the mock ignores them. */
const PARAMS: OpwParams = {
  a1: 0, a2: 0, b: 0, c1: 0, c2: 0, c3: 0, c4: 0,
  elbowInUnityX: false, toolOffset: [0, 0, 0],
};
const POS: [number, number, number] = [0, 0, 0];
const QUAT: [number, number, number, number] = [0, 0, 0, 1];

function makeChain(): JointChainParams {
  return {
    axisHomePos: new Float64Array(18),
    axisHomeRot: new Float64Array(24),
    axisDir: new Float64Array(18),
    tcpLocalOffset: [0, 0, 0],
    tcpLocalRot: [0, 0, 0, 1],
  };
}

/** Injectable mock provider — parametrized by tier / limits / cobot capability. */
class MockProvider implements IKSolverProvider {
  pieperCalls = 0;
  cobotCalls = 0;
  constructor(
    readonly tier: IKTier,
    readonly maxRobots: number,
    readonly canBlend: boolean,
    private readonly withCobot: boolean,
  ) {
    if (withCobot) {
      // Attach solveCobot only for pro-capable mocks (free providers omit it).
      this.solveCobot = (
        _chain: JointChainParams,
        _pos: [number, number, number],
        _quat: [number, number, number, number],
      ): IKSolution[] => {
        this.cobotCalls++;
        return [{ angles: [1, 2, 3, 4, 5, 6], reachable: true }];
      };
    }
  }

  solvePieper(): IKSolution[] {
    this.pieperCalls++;
    return [{ angles: [0, 0, 0, 0, 0, 0], reachable: true }];
  }

  solveCobot?: (
    chain: JointChainParams,
    pos: [number, number, number],
    quat: [number, number, number, number],
  ) => IKSolution[];
}

function freeProvider(maxRobots = 1): MockProvider {
  return new MockProvider('free', maxRobots, false, false);
}
function proProvider(): MockProvider {
  return new MockProvider('pro', Number.POSITIVE_INFINITY, true, true);
}

describe('IK tier model — registry', () => {
  beforeEach(() => {
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
  });
  afterEach(() => {
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
  });

  // ── available alias ──────────────────────────────────────────────

  it('tier=none with no provider → available=false (open-source/replay)', () => {
    expect(ikSolverRegistry.tier).toBe('none');
    expect(ikSolverRegistry.available).toBe(false);
    expect(ikSolverRegistry.maxRobots).toBe(0);
    expect(ikSolverRegistry.canBlend).toBe(false);
  });

  it('free provider → tier=free, available=true (alias preserved for plugins)', () => {
    ikSolverRegistry.register(freeProvider());
    expect(ikSolverRegistry.tier).toBe('free');
    expect(ikSolverRegistry.available).toBe(true);
    expect(ikSolverRegistry.maxRobots).toBe(1);
    expect(ikSolverRegistry.canBlend).toBe(false);
  });

  it('pro provider → tier=pro, available=true, canBlend=true', () => {
    ikSolverRegistry.register(proProvider());
    expect(ikSolverRegistry.tier).toBe('pro');
    expect(ikSolverRegistry.available).toBe(true);
    expect(ikSolverRegistry.canBlend).toBe(true);
  });

  // ── solveCobot gating ────────────────────────────────────────────

  it('free tier → solveCobot returns null (no Cobot solver)', () => {
    ikSolverRegistry.register(freeProvider());
    expect(ikSolverRegistry.canSolveCobot).toBe(false);
    expect(ikSolverRegistry.solveCobot(makeChain(), POS, QUAT)).toBeNull();
  });

  it('none tier → solveCobot returns null', () => {
    expect(ikSolverRegistry.solveCobot(makeChain(), POS, QUAT)).toBeNull();
  });

  it('pro tier → solveCobot delegates to the provider', () => {
    const p = proProvider();
    ikSolverRegistry.register(p);
    expect(ikSolverRegistry.canSolveCobot).toBe(true);
    const sols = ikSolverRegistry.solveCobot(makeChain(), POS, QUAT);
    expect(sols).not.toBeNull();
    expect(sols!.length).toBe(1);
    expect(p.cobotCalls).toBe(1);
  });

  // ── solvePieper / replay fallback ────────────────────────────────

  it('none tier → solvePieper returns null (replay fallback, no crash)', () => {
    expect(ikSolverRegistry.solvePieper(PARAMS, POS, QUAT)).toBeNull();
  });

  it('free tier → solvePieper returns solutions', () => {
    ikSolverRegistry.register(freeProvider());
    const sols = ikSolverRegistry.solvePieper(PARAMS, POS, QUAT);
    expect(sols).not.toBeNull();
    expect(sols!.length).toBeGreaterThan(0);
  });

  // ── per-robot free limit (maxRobots=1) ───────────────────────────

  it('free maxRobots=1 → first robot claims live-solve, second is denied', () => {
    ikSolverRegistry.register(freeProvider(1));
    expect(ikSolverRegistry.claimLiveSolve('robot-A')).toBe(true);  // first wins
    expect(ikSolverRegistry.claimLiveSolve('robot-B')).toBe(false); // second denied → replay
    // First robot keeps its claim across repeated calls (idempotent, per frame).
    expect(ikSolverRegistry.claimLiveSolve('robot-A')).toBe(true);
  });

  it('none tier → claimLiveSolve always false (no solver to live-solve with)', () => {
    expect(ikSolverRegistry.claimLiveSolve('robot-A')).toBe(false);
  });

  it('pro tier (unlimited) → multiple robots all claim live-solve', () => {
    ikSolverRegistry.register(proProvider());
    expect(ikSolverRegistry.claimLiveSolve('robot-A')).toBe(true);
    expect(ikSolverRegistry.claimLiveSolve('robot-B')).toBe(true);
    expect(ikSolverRegistry.claimLiveSolve('robot-C')).toBe(true);
  });

  it('releaseLiveSolve frees a slot so another robot can claim it', () => {
    ikSolverRegistry.register(freeProvider(1));
    expect(ikSolverRegistry.claimLiveSolve('robot-A')).toBe(true);
    expect(ikSolverRegistry.claimLiveSolve('robot-B')).toBe(false);
    ikSolverRegistry.releaseLiveSolve('robot-A');
    expect(ikSolverRegistry.claimLiveSolve('robot-B')).toBe(true); // slot reused
  });

  // ── per-robot reset on model clear (1→2→1) ───────────────────────

  it('resetLiveSolveClaims re-frees robot #1 after a scene switch', () => {
    ikSolverRegistry.register(freeProvider(1));
    // Scene 1: robot A claims the single slot, B falls back to replay.
    expect(ikSolverRegistry.claimLiveSolve('robot-A')).toBe(true);
    expect(ikSolverRegistry.claimLiveSolve('robot-B')).toBe(false);
    // clearModel-equivalent: drop all claims.
    ikSolverRegistry.resetLiveSolveClaims();
    // Scene 2 (a different first robot) must get the slot — no stale leak.
    expect(ikSolverRegistry.claimLiveSolve('robot-C')).toBe(true);
    expect(ikSolverRegistry.claimLiveSolve('robot-D')).toBe(false);
  });
});
