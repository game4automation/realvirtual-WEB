// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `sim.clock.get` (plan-2237 F2) — the implementation of the read-only clock query. Its descriptor is
 * registered eagerly in `sim-commands.ts`; this body is loaded on its first call (it is not needed at
 * startup, and the demo entry chunk has a byte budget).
 */

import type { CommandImpl } from '../../core/hmi/rv-command-registry';
import type { SimDesControl } from '../../core/material-flow/simulation-kernel';

/**
 * The DES runner's clamp report (`DESRunner.clampReport`): the clamp of the last timed advance and
 * monotonic counts per kind. An optional STRUCTURAL member, declared here and not on
 * `SimDesControl` itself, so it costs the eager startup graph nothing (only this lazy reader uses it).
 */
type ClampReporting = { readonly clampReport?: { readonly at: 'budget' | 'end' | null; readonly budget: number; readonly end: number } };
import { getDriveSpeedOverride } from '../../core/engine/rv-speed-override';

/** DES sub-modes as `sim.clock.get` reports them. */
export type SimClockDesSubMode = 'animated' | 'hybrid' | 'step' | 'fastforward';

/** Result of `sim.clock.get` (plan-2237 F2). */
export interface SimClockReading {
  readonly mode: 'continuous' | 'des';
  readonly paused: boolean;
  /** `viewer.simTime` — the continuous clock, in DES the EVENT time. */
  readonly simTime: number;
  /** Monotonic fixed-step counter of the viewer (never reset). */
  readonly fixedStepCount: number;
  /**
   * Effective speed factor from the STATE (never from an observed rate). Continuous: the master
   * speed override in [0, 100]. DES: `animated` 1, `hybrid` max(1, multiplier), `step` 0 (hold),
   * `fastforward` null (jumps).
   */
  readonly factor: number | null;
  readonly factorSource: 'speedOverride' | 'des-subMode';
  readonly des?: {
    readonly subMode: SimClockDesSubMode;
    readonly multiplier: number;
    /** The continuous DES animation clock — the tempo clock of animated/hybrid. */
    readonly renderClock: number;
    readonly simTime: number;
    /** Sim end time; null when infinite. */
    readonly endTime: number | null;
    /** Clamp of the LAST fixed step's timed advance (`'budget'` | `'end'`), null when it ran free. */
    readonly clampedAt: 'budget' | 'end' | null;
    /** Monotonic clamp counters per kind (never reset): a reader sampling once per video frame
     *  detects a clamp in any of that frame's fixed steps from their delta. */
    readonly clampCounts: { readonly budget: number; readonly end: number };
  };
}

/** Effective DES factor of a sub-mode (plan-2237 F2). */
export function desFactorOf(subMode: string, multiplier: number): number | null {
  if (subMode === 'animated') return 1;
  if (subMode === 'hybrid') return Math.max(1, Number.isFinite(multiplier) ? multiplier : 1);
  if (subMode === 'step') return 0;
  return null; // fastforward: event jumps, no tempo
}

/**
 * Read-only domain query of the simulation clock state: mode, pause, sim time, fixed-step count and
 * the effective speed factor, plus the DES render clock and its clamp report. Used by the tutorial
 * recorder every frame and by agents through `web_query` (contract-commands-mcp rule 5).
 */
export const simClockGet: CommandImpl<Record<string, never>, SimClockReading | { error: string }> = {
  enabled: ({ viewer }) => (viewer ? true : { reason: 'No viewer' }),
  run: ({ viewer }) => {
    if (!viewer) return { error: 'No viewer' };
    const base = {
      paused: viewer.isSimulationPaused === true,
      simTime: viewer.simTime,
      fixedStepCount: viewer.fixedStepCount,
    };
    const ctl = viewer.simulationKernel?.desControl?.() ?? null;
    if (!ctl) {
      return { mode: 'continuous', ...base, factor: getDriveSpeedOverride(), factorSource: 'speedOverride' };
    }
    const subMode = String(ctl.subMode) as SimClockDesSubMode;
    const rc = ctl.renderClock;
    const end = ctl.endTime;
    const clamp = (ctl as SimDesControl & ClampReporting).clampReport;
    return {
      mode: 'des',
      ...base,
      factor: desFactorOf(subMode, ctl.multiplier),
      factorSource: 'des-subMode',
      des: {
        subMode,
        multiplier: ctl.multiplier,
        renderClock: typeof rc === 'number' && Number.isFinite(rc) ? rc : ctl.simTime,
        simTime: ctl.simTime,
        endTime: typeof end === 'number' && Number.isFinite(end) ? end : null,
        clampedAt: clamp?.at ?? null,
        clampCounts: { budget: clamp?.budget ?? 0, end: clamp?.end ?? 0 },
      },
    };
  },
};

/** `simClockGet` as the registry's descriptor expects it (the cast lives here, not in the eager file). */
export const simClockGetImpl = simClockGet as CommandImpl<never, unknown>;
