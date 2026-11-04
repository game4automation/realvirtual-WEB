// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * pallet-yard-soak-bounds.ts — upper bounds of a long PalletYard run (plan-612 Phase 6).
 *
 * The soak samples a few resource figures at a fixed sim-time grid (event queue, live MUs,
 * MU slots, scene-graph nodes, statistics size, JS heap) and this module judges the series:
 *   - every sample must be a finite number >= 0 — a figure the harness cannot read is a
 *     VIOLATION, never a silently skipped check (#211: the former queue assert read an
 *     accessor the manager did not have, got -1, filtered it away and never ran);
 *   - an absolute cap per figure;
 *   - no growth: the maximum of the last third of the run may exceed the maximum of the
 *     first third only by `slackRel` (relative) plus `slackAbs` (absolute). A leak grows
 *     with sim time; a bounded figure plateaus after the warm-up.
 * Pure (no three, no DOM) so the node test can prove each check bites.
 */

export interface SoakSample {
  /** Sim time of the sample (s). */
  t: number;
  /** Events held by the DES event queue (`DESManager.queuedEventCount`). */
  queue: number;
  /** MUs currently alive (`DESManager.liveMuCount`). */
  liveMus: number;
  /** MU slots ever allocated (`DESManager.muCount`) — WIP high-water mark. */
  muSlots: number;
  /** Object3D nodes below the scene root. */
  nodes: number;
  /** Bytes of the serialised statistics (component statistics, job log, problems). */
  statsBytes: number;
  /** JS heap after a forced GC (bytes), null when the platform cannot measure it. */
  heapBytes: number | null;
}

export type SoakFigure = Exclude<keyof SoakSample, 't'>;

export interface FigureCap {
  /** Absolute maximum over the whole series. */
  max: number;
  /** Allowed growth of the late-window maximum over the early-window maximum, relative. */
  slackRel: number;
  /** ... plus this absolute amount. */
  slackAbs: number;
}

export type SoakCaps = Record<SoakFigure, FigureCap>;

/**
 * Caps of the PalletYard (3 stackers, 2 outputs, 2 shipping inputs, 6 floor slots).
 * Measured 2026-10-24 over 7 sim days FastForward (judged samples every 6 h from 6 h on):
 * queue 7-22, live MUs 8-10, MU slots 30, scene nodes 381 (458 in Animated, pallets
 * materialised), statistics 16.9-17.4 KB, heap after GC 60.6-61.2 MB - flat from the first
 * to the last day. The absolute caps sit at roughly 2-4x the observed maximum, the growth
 * slack well above the noise between the first and the last third of the run.
 */
export const PALLET_YARD_CAPS: SoakCaps = {
  queue: { max: 64, slackRel: 0.5, slackAbs: 16 },
  liveMus: { max: 32, slackRel: 0.25, slackAbs: 4 },
  muSlots: { max: 64, slackRel: 0.25, slackAbs: 4 },
  nodes: { max: 2_000, slackRel: 0.05, slackAbs: 100 },
  statsBytes: { max: 64 * 1024, slackRel: 0.25, slackAbs: 8 * 1024 },
  heapBytes: { max: 256 * 1024 * 1024, slackRel: 0.15, slackAbs: 16 * 1024 * 1024 },
};

const FIGURES: SoakFigure[] = ['queue', 'liveMus', 'muSlots', 'nodes', 'statsBytes', 'heapBytes'];

/** Minimum samples for the growth check (fewer: the absolute cap still applies). */
export const MIN_GROWTH_SAMPLES = 6;

/**
 * Violations of `caps` in `samples` (empty = within bounds). `samples` must already exclude
 * the warm-up. `heapBytes: null` throughout is accepted only when `allowMissingHeap` is set
 * (a platform without CDP); a partially missing heap series is always a violation.
 */
export function checkSoakBounds(samples: readonly SoakSample[], caps: SoakCaps = PALLET_YARD_CAPS, allowMissingHeap = false): string[] {
  const out: string[] = [];
  if (samples.length === 0) return ['no samples'];
  for (const f of FIGURES) {
    const raw = samples.map((s) => s[f]);
    if (f === 'heapBytes' && allowMissingHeap && raw.every((v) => v === null)) continue;
    const bad = raw.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0);
    if (bad >= 0) { out.push(`${f}: unreadable sample ${String(raw[bad])} at t=${samples[bad].t}`); continue; }
    const v = raw as number[];
    const cap = caps[f];
    const peak = Math.max(...v);
    if (peak > cap.max) out.push(`${f}: peak ${peak} > cap ${cap.max}`);
    if (v.length >= MIN_GROWTH_SAMPLES) {
      const third = Math.floor(v.length / 3);
      const early = Math.max(...v.slice(0, third));
      const late = Math.max(...v.slice(v.length - third));
      const allowed = early * (1 + cap.slackRel) + cap.slackAbs;
      if (late > allowed) out.push(`${f}: grows — late max ${late} > early max ${early} * ${1 + cap.slackRel} + ${cap.slackAbs} = ${allowed.toFixed(0)}`);
    }
  }
  return out;
}

/** One-line summary per figure (min / max / first / last) for the log. */
export function summariseSoak(samples: readonly SoakSample[]): Record<string, { min: number; max: number; first: number; last: number } | null> {
  const r: Record<string, { min: number; max: number; first: number; last: number } | null> = {};
  for (const f of FIGURES) {
    const v = samples.map((s) => s[f]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    r[f] = v.length ? { min: Math.min(...v), max: Math.max(...v), first: v[0], last: v[v.length - 1] } : null;
  }
  return r;
}

export { expectNoWaitTimeouts } from '../fleet/expect-no-wait-timeouts';
