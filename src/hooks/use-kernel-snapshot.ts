// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * use-kernel-snapshot.ts — a `useSyncExternalStore`-backed snapshot of the
 * unified `SimulationKernel` state for the sim-control UI (Plan 194 §4.1).
 *
 * Extracted from `SimModeToggle` so the DES controller toolbar (and any future
 * sim UI) reads the same kernel state through one shared, throttled store: it
 * re-renders on `'simulation-mode-changed'` (mode / sub-mode switch) and on a
 * low-rate poll that tracks FastForward progress (which has no event of its own).
 *
 * Repo boundary (Plan 194 V7): imports ONLY the PUBLIC kernel facade. It never
 * touches the private `DESRunner` — the DES sub-mode / KPI surface is read
 * through the STRUCTURAL `SimDesControl` interface `kernel.desControl()` returns.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { RVViewer } from '../core/rv-viewer';
import type { SimulationMode, SimSubMode } from '../core/material-flow/simulation-kernel';

/**
 * Snapshot of the kernel state the sim UI renders. Compared field-by-field
 * (`sameSnapshot`) so `useSyncExternalStore` re-renders only on real changes.
 */
export interface KernelSnapshot {
  /** False when the unified kernel is not active (flag OFF / no model). */
  readonly available: boolean;
  readonly mode: SimulationMode;
  readonly hasDes: boolean;
  readonly switching: boolean;
  readonly subMode: SimSubMode | null;
  readonly multiplier: number;
  readonly ffProgress: number | null;
  /** DES sim clock in seconds (0 outside DES). For the toolbar time display. */
  readonly simTime: number;
  /** Total DES events processed (0 outside DES). */
  readonly processed: number;
  /** Pending DES events in the queue (0 outside DES). */
  readonly pending: number;
  /** Sim END time in seconds (Infinity = infinite). For the clock settings. */
  readonly endTime: number;
  /** Statistics-reset (warmup) time in seconds (0 = off). For the clock settings. */
  readonly statResetTime: number;
  readonly version: number;
}

interface KernelStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => KernelSnapshot;
}

/** Poll interval for FastForward progress (no dedicated event). */
const POLL_MS = 200;

const _storeCache = new WeakMap<object, KernelStore>();

/**
 * React hook: a memoised, throttled snapshot of the viewer's SimulationKernel.
 * One store per viewer instance (shared across all sim-control consumers).
 */
export function useKernelSnapshot(viewer: RVViewer): KernelSnapshot {
  const { subscribe, getSnapshot } = useMemo(() => makeStore(viewer), [viewer]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function makeStore(viewer: RVViewer): KernelStore {
  const cached = _storeCache.get(viewer);
  if (cached) return cached;

  let version = 0;
  let snapshot = readSnapshot(viewer, version);
  const listeners = new Set<() => void>();
  let pollId: ReturnType<typeof setInterval> | null = null;

  const refresh = (): void => {
    const next = readSnapshot(viewer, version + 1);
    // Only bump + notify when something the UI cares about actually changed.
    if (!sameSnapshot(snapshot, next)) {
      version++;
      snapshot = next;
      for (const l of listeners) l();
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const off = viewer.on('simulation-mode-changed', refresh as (data: unknown) => void);
    if (pollId === null) pollId = setInterval(refresh, POLL_MS);
    return () => {
      listeners.delete(listener);
      off();
      if (listeners.size === 0 && pollId !== null) {
        clearInterval(pollId);
        pollId = null;
      }
    };
  };

  const getSnapshot = (): KernelSnapshot => snapshot;

  const store: KernelStore = { subscribe, getSnapshot };
  _storeCache.set(viewer, store);
  return store;
}

function readSnapshot(viewer: RVViewer, version: number): KernelSnapshot {
  const kernel = viewer.simulationKernel;
  if (!kernel) {
    return {
      available: false, mode: 'continuous', hasDes: false, switching: false,
      subMode: null, multiplier: 1, ffProgress: null,
      simTime: 0, processed: 0, pending: 0, endTime: Infinity, statResetTime: 0, version,
    };
  }
  const ctl = kernel.desControl();
  const ff = ctl?.ffProgress;
  const stats = ctl?.eventStats?.();
  return {
    available: true,
    mode: kernel.mode,
    hasDes: kernel.hasDesRunner(),
    switching: kernel.isSwitching,
    subMode: ctl?.subMode ?? null,
    multiplier: ctl?.multiplier ?? 1,
    ffProgress: typeof ff === 'number' ? ff : null,
    simTime: stats?.currentTime ?? 0,
    processed: stats?.processed ?? 0,
    pending: stats?.pending ?? 0,
    endTime: ctl?.endTime ?? Infinity,
    statResetTime: ctl?.statResetTime ?? 0,
    version,
  };
}

function sameSnapshot(a: KernelSnapshot, b: KernelSnapshot): boolean {
  return a.available === b.available
    && a.mode === b.mode
    && a.hasDes === b.hasDes
    && a.switching === b.switching
    && a.subMode === b.subMode
    && a.multiplier === b.multiplier
    && a.ffProgress === b.ffProgress
    && a.simTime === b.simTime
    && a.processed === b.processed
    && a.pending === b.pending
    && a.endTime === b.endTime
    && a.statResetTime === b.statResetTime;
}
