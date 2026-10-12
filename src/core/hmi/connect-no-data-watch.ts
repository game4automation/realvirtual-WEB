// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-no-data-watch — "connected, but the PLC delivers nothing" (plan-562 F10).
 *
 * The silent half of the customer case this plan came from: CONNECT reported a
 * healthy connection, the viewer kept showing SIM, and nothing said that not one
 * PLC output had ever arrived. CONNECT now reports a read health per interface
 * (bound read tags, tags that delivered a valid value, a monotonic receive
 * counter and the worker generation); this watch turns that into one of two
 * verdicts.
 *
 * Why SIM time and not wall-clock: a paused simulation produces no viewer writes
 * and expects no PLC traffic, so a wall-clock window would accuse the PLC of
 * being silent while it is the viewer that stopped. The window therefore advances
 * with `viewer.simTime` only, which also makes a sim reset (simTime jumping back)
 * a natural reason to start the observation over.
 *
 * Two rules, both per interface AND per worker generation:
 *
 *  - **A, "no valid data"**: after {@link NO_DATA_WINDOW_S} seconds of sim time
 *    the worker has no bound read tags at all, or none of them ever delivered a
 *    valid value.
 *  - **B, "data stopped"**: data DID arrive and then stopped for the same window.
 *    Only for workers whose `progress` rises periodically
 *    (`progressIsPeriodic`) — on a pure on-change path (TwinCAT OnChange, and
 *    OPC UA without a single polled signal) a standing value is normal operation,
 *    not a fault, and accusing it would be a false alarm.
 *
 * A worker that reports no read health at all (`readHealth` absent) is never
 * judged: the notice would be a guess, and a wrong "no data" is worse than none.
 */

/** Sim-time seconds an interface may stay silent before the notice appears. */
export const NO_DATA_WINDOW_S = 10;

/** Why an interface counts as silent. One sentence each, rendered by the notice. */
export type NoDataReason = 'no-readable-tags' | 'no-valid-values' | 'data-stopped';

/** Operator-facing phrase per reason (English, as every UI text here). */
export const NO_DATA_REASON_TEXT: Readonly<Record<NoDataReason, string>> = {
  'no-readable-tags': 'no readable tags bound',
  'no-valid-values': 'no valid values received',
  'data-stopped': 'data stopped',
};

/** One silent interface, as the notice renders it. */
export interface NoDataHit {
  interfaceId: string;
  reason: NoDataReason;
  /** Worker generation the verdict belongs to — the identity a dismissal uses. */
  workerGeneration: number;
  /** Configured signals the gateway knows can never decode (context, not cause). */
  signalIssues: number;
}

/** What the watch needs to know about one interface on a given tick. */
export interface NoDataInterfaceInput {
  id: string;
  /** Worker status string from `/status` (only `Connected` is observed). */
  status: string;
  boundReadTags: number;
  tagsWithValidValue: number;
  progress: number;
  workerGeneration: number;
  progressIsPeriodic: boolean;
  signalIssues?: number;
}

export interface NoDataWatchInput {
  /** `viewer.simTime` in seconds — the only clock this watch has. */
  simTime: number;
  /** Is the gateway connection itself up? A disconnect clears everything. */
  connected: boolean;
  /** Only interfaces that actually report a read health belong in here. */
  interfaces: readonly NoDataInterfaceInput[];
}

interface WindowState {
  generation: number;
  /** Sim time at which this generation was first seen connected. */
  windowStart: number;
  lastProgress: number;
  /** Sim time of the last observed `progress` increase. */
  lastProgressAt: number;
  sawProgress: boolean;
}

/**
 * Per-interface observation windows. Instantiable (so the tests can drive a
 * clock without touching a module singleton) with one shared instance for the
 * notice, since a second instance would open a second window per interface and
 * both would fire.
 */
export class ConnectNoDataWatch {
  private readonly windows = new Map<string, WindowState>();
  /** Dismissed verdicts, keyed `id|generation` — once per interface and generation. */
  private readonly dismissed = new Set<string>();
  private lastSimTime = 0;

  /**
   * Fold one tick into the windows and return every interface that is currently
   * silent. The result is recomputed from scratch on every call, which is what
   * makes the notice disappear by itself the moment data flows again.
   */
  update(input: NoDataWatchInput): readonly NoDataHit[] {
    if (!input.connected) {
      this.windows.clear();
      this.lastSimTime = input.simTime;
      return [];
    }
    // A sim reset rewinds the clock. Every window would otherwise measure
    // against a start that now lies in the future, i.e. never elapse again.
    const reset = input.simTime < this.lastSimTime;
    this.lastSimTime = input.simTime;

    const seen = new Set<string>();
    const hits: NoDataHit[] = [];
    for (const iface of input.interfaces) {
      if (iface.status !== 'Connected') continue;
      seen.add(iface.id);
      let state = this.windows.get(iface.id);
      if (!state || state.generation !== iface.workerGeneration || reset) {
        state = {
          generation: iface.workerGeneration,
          windowStart: input.simTime,
          lastProgress: iface.progress,
          lastProgressAt: input.simTime,
          sawProgress: false,
        };
        this.windows.set(iface.id, state);
      } else if (iface.progress > state.lastProgress) {
        state.lastProgress = iface.progress;
        state.lastProgressAt = input.simTime;
        state.sawProgress = true;
      }

      const reason = this.verdict(iface, state, input.simTime);
      if (!reason) continue;
      if (this.dismissed.has(hitKey(iface.id, iface.workerGeneration))) continue;
      hits.push({
        interfaceId: iface.id,
        reason,
        workerGeneration: iface.workerGeneration,
        signalIssues: iface.signalIssues ?? 0,
      });
    }
    // An interface that disappeared or left `Connected` keeps no window: its next
    // connect is a fresh observation, not the continuation of an old one.
    for (const id of [...this.windows.keys()]) if (!seen.has(id)) this.windows.delete(id);
    return hits;
  }

  /** Rule A then rule B, or null while the interface is still within its window. */
  private verdict(
    iface: NoDataInterfaceInput,
    state: WindowState,
    simTime: number,
  ): NoDataReason | null {
    if (simTime - state.windowStart >= NO_DATA_WINDOW_S) {
      if (iface.boundReadTags === 0) return 'no-readable-tags';
      if (iface.tagsWithValidValue === 0) return 'no-valid-values';
    }
    if (
      state.sawProgress
      && iface.progressIsPeriodic
      && simTime - state.lastProgressAt >= NO_DATA_WINDOW_S
    ) {
      return 'data-stopped';
    }
    return null;
  }

  /** Close the notice for this interface and worker generation (once each). */
  dismiss(interfaceId: string, workerGeneration: number): void {
    this.dismissed.add(hitKey(interfaceId, workerGeneration));
  }

  /** @internal Forget every window and dismissal (tests, dispose). */
  reset(): void {
    this.windows.clear();
    this.dismissed.clear();
    this.lastSimTime = 0;
  }
}

function hitKey(interfaceId: string, workerGeneration: number): string {
  return `${interfaceId}|${workerGeneration}`;
}

/** The one watch the no-data notice reads. */
export const connectNoDataWatch = new ConnectNoDataWatch();
