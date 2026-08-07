// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-load-profiler.ts — Lightweight phase timer for model load.
 *
 * Measures the duration of each load phase using performance.now() deltas.
 * The only cost when the 'perf' debug category is inactive is the cheap
 * performance.now() call at each phase boundary; report() is a no-op.
 *
 * Enable via `?debug=perf` (or `localStorage.setItem('rv-debug', 'perf')`).
 */

import { isDebugEnabled, debug } from './rv-debug';

/** A single measured phase. */
export interface PhaseTiming {
  phase: string;
  ms: number;
}

/** Synchronous CPU self-time accumulated for one nested load operation. */
export type LoadSelfTimings = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** Profiler instance returned by createLoadProfiler(). */
export interface LoadProfiler {
  /** Record the elapsed time since the previous mark under `phase`. */
  mark(phase: string): void;
  /** Emit a duration-sorted table when 'perf' is enabled; no-op otherwise. */
  report(): void;
  /**
   * Structured access to the recorded phase timings (plan-274 Phase 0).
   * Unlike report() this is NOT gated on the 'perf' debug category — callers
   * (e.g. loadGLB filling LoadResult.mergeMs) read it programmatically.
   * Returns the live array in mark() order; treat as read-only.
   */
  getTimings(): readonly PhaseTiming[];
  /** Add synchronous CPU self-time for a nested operation/substep pair. */
  addSelfTime(operation: string, substep: string, ms: number): void;
  /** Structured snapshot of all accumulated synchronous CPU self-times. */
  getSelfTimings(): LoadSelfTimings;
}

/**
 * Create a load profiler. Call mark() at each phase boundary (NOT per element)
 * and report() at the end. Uses performance.now() exclusively.
 */
export function createLoadProfiler(label: string): LoadProfiler {
  const timings: PhaseTiming[] = [];
  const selfTimings: Record<string, Record<string, number>> = {};
  let last = performance.now();

  return {
    mark(phase: string): void {
      const now = performance.now();
      timings.push({ phase, ms: now - last });
      last = now;
    },

    getTimings(): readonly PhaseTiming[] {
      return timings;
    },

    addSelfTime(operation: string, substep: string, ms: number): void {
      let group = selfTimings[operation];
      if (!group) {
        group = {};
        selfTimings[operation] = group;
      }
      group[substep] = (group[substep] ?? 0) + ms;
    },

    getSelfTimings(): LoadSelfTimings {
      const snapshot: Record<string, Readonly<Record<string, number>>> = {};
      for (const [operation, values] of Object.entries(selfTimings)) {
        snapshot[operation] = { ...values };
      }
      return snapshot;
    },

    report(): void {
      if (!isDebugEnabled('perf')) return;
      const total = timings.reduce((sum, t) => sum + t.ms, 0);
      const rows = timings
        .slice()
        .sort((a, b) => b.ms - a.ms)
        .map((t) => ({
          phase: t.phase,
          ms: +t.ms.toFixed(2),
          pct: total > 0 ? +((t.ms / total) * 100).toFixed(1) : 0,
        }));
      debug('perf', `${label}: total ${total.toFixed(2)} ms`, rows);
      // console.table renders the sorted rows nicely in DevTools.
      if (typeof console !== 'undefined' && typeof console.table === 'function') {
        console.table(rows);
      }
      for (const [operation, values] of Object.entries(selfTimings)) {
        const selfTotal = Object.values(values).reduce((sum, ms) => sum + ms, 0);
        debug('perf', `${label}/${operation}: self ${selfTotal.toFixed(2)} ms`, values);
      }
    },
  };
}
