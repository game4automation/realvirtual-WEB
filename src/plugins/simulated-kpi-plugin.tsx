// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimulatedKpiPlugin — KPI chips in the top KPI bar, fed by a deterministic,
 * smoothly varying simulated source (`simulated-kpi.ts`).
 *
 * Meant for presentation models without live KPI data: each chip shows a base
 * value with a bounded, slow drift (value noise over wall-clock time) and a
 * sparkline of the recent course. Configuration only — no model-specific code:
 *
 * ```ts
 * viewer.use(new SimulatedKpiPlugin({
 *   kpis: [{ label: 'OEE', base: 95, amplitude: 0.4, unit: '%', decimals: 1 }],
 *   showInModes: ['commissioning'],
 * }));
 * ```
 *
 * A click on a chip opens a trend window of the same source over the chip's
 * `historyHours` (default 8 h) with a target line at `base` and a tolerance band
 * `base ± tolerance` (default `amplitude`) — see `simulated-kpi-chart.tsx`.
 *
 * `showInModes` lifts the KPI bar's default hiding for those modes while the
 * plugin is registered (the bar is hidden in commissioning by default); the
 * previous rule is restored on dispose.
 */

import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { ModeId } from '../core/rv-mode-manager';
import { KpiCard } from '../core/hmi/KpiCard';
import { KPI_BAR_DEFAULT_RULE } from '../core/hmi/KpiBar';
import {
  getUIElementRule,
  registerUIElement,
  type UIVisibilityRule,
} from '../core/hmi/ui-context-store';
import {
  formatSimulatedKpi,
  simulatedKpiSeries,
  simulatedKpiValue,
  type SimulatedKpiDef,
} from '../core/hmi/simulated-kpi';

import {
  SIMULATED_KPI_CHIP_ATTR,
  SimulatedKpiChartStore,
  SimulatedKpiChartWindow,
  simulatedKpiNowSec,
} from './simulated-kpi-chart';

export type { SimulatedKpiDef } from '../core/hmi/simulated-kpi';

export interface SimulatedKpiPluginOptions {
  /** Plugin id (unique per viewer). Default 'simulated-kpi'. */
  id?: string;
  /** The chips, left to right. */
  kpis: SimulatedKpiDef[];
  /** Modes in which the KPI bar is shown although its default rule hides it (e.g. 'commissioning'). */
  showInModes?: ModeId[];
  /** Refresh interval of the chips in ms. Default 1000. */
  refreshMs?: number;
  /** Slot order of the first chip; following chips +10 each. Default 10. */
  order?: number;
}

const KPI_BAR_ID = 'kpi-bar';
const SPARK_POINTS = 15;

/** Clock of the simulated source, in seconds. Wall clock: same value in every tab at the same moment. */
const nowSec = simulatedKpiNowSec;

/** The KPI bar rule with the given modes' contexts removed from `hiddenIn`. */
export function kpiBarRuleShowingModes(base: UIVisibilityRule, modes: readonly ModeId[]): UIVisibilityRule {
  const lift = new Set(modes.map((m) => `mode:${m}`));
  return { ...base, hiddenIn: (base.hiddenIn ?? []).filter((c) => !lift.has(c)) };
}

function makeChip(def: SimulatedKpiDef, index: number, refreshMs: number, store: SimulatedKpiChartStore) {
  const step = Math.max(1, (def.period ?? 20) / 4);
  function SimulatedKpiChip(_props: UISlotProps) {
    const [t, setT] = useState(nowSec);
    useEffect(() => {
      const h = setInterval(() => setT(nowSec()), refreshMs);
      return () => clearInterval(h);
    }, []);
    const value = simulatedKpiValue(def, t);
    const chipAttr = { [SIMULATED_KPI_CHIP_ATTR]: def.label };
    return (
      <Box component="span" sx={{ display: 'contents' }} {...chipAttr}>
        <KpiCard
          label={def.label}
          value={formatSimulatedKpi(def, value)}
          unit={def.unit}
          color={def.color}
          secondary={def.secondary}
          sparkline={simulatedKpiSeries(def, t, SPARK_POINTS, step)}
          animate={false}
          onClick={() => store.open(index)}
        />
      </Box>
    );
  }
  SimulatedKpiChip.displayName = `SimulatedKpiChip(${def.label})`;
  return SimulatedKpiChip;
}

export class SimulatedKpiPlugin implements RVViewerPlugin {
  readonly id: string;
  readonly slots: UISlotEntry[];
  private readonly showInModes: readonly ModeId[];
  private previousRule: UIVisibilityRule | null = null;
  /** Which chip's trend window is open. */
  readonly chartStore = new SimulatedKpiChartStore();

  constructor(options: SimulatedKpiPluginOptions) {
    this.id = options.id ?? 'simulated-kpi';
    const refreshMs = options.refreshMs ?? 1000;
    const order0 = options.order ?? 10;
    const store = this.chartStore;
    const kpis = [...options.kpis];
    const panelId = `${this.id}-chart`;
    function SimulatedKpiChartSlot(_props: UISlotProps) {
      return <SimulatedKpiChartWindow store={store} kpis={kpis} refreshMs={refreshMs} panelId={panelId} />;
    }
    this.slots = [
      ...kpis.map((def, i) => ({
        slot: 'kpi-bar' as const,
        component: makeChip(def, i, refreshMs, store),
        order: order0 + i * 10,
      })),
      { slot: 'overlay' as const, component: SimulatedKpiChartSlot, order: 80 },
    ];
    this.showInModes = options.showInModes ?? [];
  }

  init(): void {
    if (this.showInModes.length === 0) return;
    const current = getUIElementRule(KPI_BAR_ID) ?? KPI_BAR_DEFAULT_RULE;
    this.previousRule = current;
    registerUIElement(KPI_BAR_ID, kpiBarRuleShowingModes(current, this.showInModes));
  }

  dispose(): void {
    this.chartStore.close();
    if (!this.previousRule) return;
    registerUIElement(KPI_BAR_ID, this.previousRule);
    this.previousRule = null;
  }
}
