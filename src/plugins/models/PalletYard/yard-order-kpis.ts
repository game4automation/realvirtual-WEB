// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Snapshottable } from '../../des/rv-snapshot-registry';
import type { OrderPool } from '@rv/core/fleet/core/orders';
import { FleetJobRunner } from '@rv/core/fleet/exec/job-runner';

/** One run's completion observations; independent of executor counters and KPI polling. */
export class YardOrderKpis {
  private off: (() => void) | null = null;
  private sumSec = 0;
  private count = 0;

  /** Release the previous subscription and begin an empty run, even when the pool is reused. */
  reset(pool: Pick<OrderPool, 'onComplete'> | null = null): void {
    this.off?.();
    this.off = null;
    this.sumSec = 0;
    this.count = 0;
    if (pool) this.off = pool.onComplete((order, now) => {
      this.sumSec += now - order.times.created;
      this.count++;
    });
  }

  exportState(): { sumSec: number; count: number } { return { sumSec: this.sumSec, count: this.count }; }

  validateState(json: unknown): string[] {
    if (!json || typeof json !== 'object') return ['fleet.kpis: expected state'];
    const s = json as { sumSec: number; count: number };
    return Object.keys(s).sort().join(',') === 'count,sumSec' && Number.isFinite(s.sumSec)
      && s.sumSec >= 0 && Number.isSafeInteger(s.count) && s.count >= 0 ? [] : ['fleet.kpis: invalid state'];
  }

  prepareState(json: unknown): { sumSec: number; count: number } {
    const errors = this.validateState(json);
    if (errors.length) throw new Error(errors.join('; '));
    return { ...(json as { sumSec: number; count: number }) };
  }

  swapState(state: { sumSec: number; count: number }): void { this.sumSec = state.sumSec; this.count = state.count; }

  meanOrderSec(): number | null { return this.count ? this.sumSec / this.count : null; }
}

/** Project-owned observation lifecycle; fleet execution and its counter shape stay unchanged. */
// Observation only: every override calls its super unconditionally and in the same place, so the
// job runner's behaviour — and the M3/soak counters — are exactly those of FleetJobRunner.
export class YardKpiRun extends FleetJobRunner {
  readonly orderKpis = new YardOrderKpis();

  override start(): void {
    // Subscribe before start can dispatch. OrderPool.reset deliberately preserves this hook.
    this.orderKpis.reset(this.dispatcher.orders);
    super.start();
  }

  override prepareReset(): void {
    this.orderKpis.reset();
    super.prepareReset();
  }

  override dispose(): void {
    this.orderKpis.reset();
    super.dispose();
  }
}

export function yardMeanOrderSec(run: FleetJobRunner | null): number | null {
  return run instanceof YardKpiRun ? run.orderKpis.meanOrderSec() : null;
}

export function fleetKpiParticipant(kpis: YardOrderKpis): Snapshottable {
  return { key: 'fleet.kpis', version: 1, dependencies: ['fleet.orders'], owner: kpis,
    stateKeys: ['sumSec', 'count'], services: ['off'], capture: () => kpis.exportState(),
    validate: json => kpis.validateState(json), prepare: json => kpis.prepareState(json),
    commit: p => kpis.swapState(p as { sumSec: number; count: number }) };
}
