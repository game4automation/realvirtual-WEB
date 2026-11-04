// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-statistics.ts -- Statistics collection for DES components.
 *
 * Two-Tier Architecture:
 * - Tier 1: Current state (in snapshot) — per-component state time tracking
 * - Tier 2: Time-series (InfluxDB) — batch line-protocol via fetch()
 *
 * DESComponentStats provides dynamic string-based state tracking with
 * convenience shortcuts for common states (Working%, Blocked%, etc.).
 *
 * InfluxDB writer batches line-protocol entries and flushes via fetch().
 * Includes run/seed tags from DESManager config for multi-run comparison.
 */

import type { DESComponent, StateTimingEntry } from './rv-des-component';
import type { DESManager } from './rv-des-manager';

// ── Configuration ──

export interface DESStatisticsConfig {
  influxUrl: string;            // e.g., "http://localhost:8086"
  influxToken: string;
  influxOrg: string;
  influxBucket: string;         // e.g., "des-simulations"
  sampleInterval: number;       // seconds between samples (default: 60)
  batchSize: number;            // points per write batch (default: 100)
  enabled: boolean;             // default: false (opt-in)
}

export const DEFAULT_STATISTICS_CONFIG: DESStatisticsConfig = {
  influxUrl: '',
  influxToken: '',
  influxOrg: '',
  influxBucket: 'des-simulations',
  sampleInterval: 60,
  batchSize: 100,
  enabled: false,
};

// ── DESComponentStatsSnapshot (Tier 1 — saved in DES snapshot) ──

export interface DESComponentStatsSnapshot {
  currentState: string;
  stateTimings: Record<string, { duration: number; entries: number }>;
  totalProcessed: number;
  currentLoad: number;
  outputPerHour: number;
}

// ── DESComponentStats (full computed stats for API consumers) ──

export interface DESComponentStats {
  /** State time distribution (dynamic — includes ALL states ever set). */
  states: Record<string, { duration: number; percent: number; entries: number }>;
  /** Convenience shortcuts for common states. */
  workingPercent: number;
  blockedPercent: number;
  emptyPercent: number;
  setupPercent: number;
  failurePercent: number;
  /** Driving between stops (vehicles). Optional — older producers omit it. */
  transportPercent?: number;
  /** plan-558: vehicles driving below their free profile because of traffic. Optional. */
  slowedPercent?: number;
  /** plan-558: vehicles standing at a traffic stop (free time). Optional. */
  stoppedPercent?: number;
  /** Utilization = 100% - freeStatesPercent. */
  utilization: number;
  /** States NOT counted as utilized. */
  freeStates: string[];
  /** Counters. */
  totalProcessed: number;
  currentLoad: number;
  outputPerHour: number;
  outputPer24Hours: number;
  /** Current state name. */
  currentState: string;
}

// ── Statistics helper functions ──

/**
 * Compute full statistics for a component.
 * Calls component.getStatistics() and enriches with additional fields.
 */
export function computeComponentStats(comp: DESComponent): DESComponentStats {
  const raw = comp.getStatistics();
  return {
    ...raw,
    freeStates: comp.freeStates,
    outputPer24Hours: raw.outputPerHour * 24,
  };
}

/**
 * Compute all component statistics for a manager.
 */
export function computeAllStatistics(
  manager: DESManager,
  components: DESComponent[],
): Record<string, DESComponentStats> {
  const result: Record<string, DESComponentStats> = {};
  for (const comp of components) {
    result[comp.path] = computeComponentStats(comp);
  }
  return result;
}

/**
 * Extract Tier 1 snapshot data for all components.
 */
export function snapshotStatistics(
  components: DESComponent[],
): Record<string, DESComponentStatsSnapshot> {
  const result: Record<string, DESComponentStatsSnapshot> = {};
  for (const comp of components) {
    const stats = comp.getStatistics();
    result[comp.path] = {
      currentState: stats.currentState,
      stateTimings: {},
      totalProcessed: stats.totalProcessed,
      currentLoad: stats.currentLoad,
      outputPerHour: stats.outputPerHour,
    };
    // Copy state timings (duration + entries only, no percent)
    for (const [name, data] of Object.entries(stats.states)) {
      result[comp.path].stateTimings[name] = {
        duration: data.duration,
        entries: data.entries,
      };
    }
  }
  return result;
}

// ── InfluxDB Writer (Tier 2) ──

/**
 * InfluxDB line-protocol writer for DES time-series data.
 * Batches entries and flushes via fetch() when batch is full.
 */
export class InfluxDBWriter {
  private buffer: string[] = [];
  private config: DESStatisticsConfig;
  private runName: string;
  private masterSeed: number;
  private _lastSampleTime = -Infinity;

  constructor(
    config: DESStatisticsConfig,
    runName: string,
    masterSeed: number,
  ) {
    this.config = config;
    this.runName = runName;
    this.masterSeed = masterSeed;
  }

  /** Check if it's time to sample based on simulation time. */
  shouldSample(simTime: number): boolean {
    if (!this.config.enabled) return false;
    if (simTime - this._lastSampleTime < this.config.sampleInterval) return false;
    return true;
  }

  /**
   * Sample statistics for all components and add to buffer.
   * Call this periodically at sampleInterval.
   */
  sampleComponents(components: DESComponent[], simTime: number): void {
    if (!this.config.enabled) return;
    this._lastSampleTime = simTime;

    const run = escapeTag(this.runName);
    const seed = String(this.masterSeed);
    const timestamp = Math.floor(simTime * 1e9); // nanosecond timestamp

    for (const comp of components) {
      const stats = comp.getStatistics();
      const compPath = escapeTag(comp.path);
      const compType = escapeTag(
        (comp.constructor as { type?: string }).type ?? 'DESComponent',
      );

      this.buffer.push(
        `des_component,run=${run},seed=${seed},component=${compPath},type=${compType} ` +
        `working_pct=${stats.workingPercent.toFixed(2)},` +
        `blocked_pct=${stats.blockedPercent.toFixed(2)},` +
        `empty_pct=${stats.emptyPercent.toFixed(2)},` +
        `setup_pct=${stats.setupPercent.toFixed(2)},` +
        `failure_pct=${stats.failurePercent.toFixed(2)},` +
        `utilization=${stats.utilization.toFixed(2)},` +
        `total_processed=${stats.totalProcessed}i,` +
        `current_load=${stats.currentLoad}i,` +
        `output_per_hour=${stats.outputPerHour.toFixed(2)} ` +
        `${timestamp}`,
      );
    }

    // Flush if batch is full
    if (this.buffer.length >= this.config.batchSize) {
      this.flush();
    }
  }

  /**
   * Flush buffered line-protocol entries to InfluxDB via fetch().
   * Non-blocking — errors are logged but don't stop the simulation.
   */
  flush(): void {
    if (this.buffer.length === 0 || !this.config.enabled) return;
    if (!this.config.influxUrl) return;

    const body = this.buffer.join('\n');
    this.buffer.length = 0;

    const url = `${this.config.influxUrl}/api/v2/write?org=${encodeURIComponent(this.config.influxOrg)}&bucket=${encodeURIComponent(this.config.influxBucket)}`;

    // Fire-and-forget — don't await, don't block simulation
    fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.config.influxToken}`,
        'Content-Type': 'text/plain',
      },
      body,
    }).catch(() => {
      // Silently ignore InfluxDB errors — simulation continues
    });
  }

  /** Get the number of buffered entries (for testing). */
  get bufferedCount(): number { return this.buffer.length; }

  /** Clear the buffer without flushing (for testing). */
  clearBuffer(): void { this.buffer.length = 0; }

  /** Get the last sample time (for testing). */
  get lastSampleTime(): number { return this._lastSampleTime; }
}

// ── Helpers ──

/** Escape InfluxDB tag value (no spaces, commas, equals). */
function escapeTag(value: string): string {
  return value.replace(/ /g, '\\ ').replace(/,/g, '\\,').replace(/=/g, '\\=');
}
