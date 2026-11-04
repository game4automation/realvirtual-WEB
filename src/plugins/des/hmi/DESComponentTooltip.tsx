// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DESComponentTooltip — Hover tooltip content for DES components.
 *
 * Shows component name, type, current state (color-coded), current load,
 * utilization percentage, output per hour, and blocked time.
 *
 * Follows DriveTooltipContent.tsx pattern: self-registers in the tooltip
 * content registry, receives typed data props from the tooltip store.
 *
 * State color-coding: the colors of `DES_STATE_STACK` (the same as the stats
 * chart and the in-scene badges, plan-644 D3) plus `Paused` (orange), which is
 * no stack state.
 *
 * A battery vehicle additionally shows a `SOC` row when its node carries a
 * numeric `userData[DES_SOC_USERDATA_KEY]` (plan-612); without it the row is absent.
 * Since plan-644 that row is the first KPI row provider (`registerDesKpiRowProvider`),
 * and states registered with `registerDesState` follow the built-in state rows
 * (shown when > 0, in their registered color). New registrations re-render the
 * tooltip through `useSyncExternalStore`.
 */

import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from '../../../core/hmi/tooltip/tooltip-registry';
import { tooltipRegistry } from '../../../core/hmi/tooltip/tooltip-registry';
import type { TooltipData } from '../../../core/hmi/tooltip/tooltip-store';
import { getActiveDesRunner, desComponentAt } from './des-active-runner';
import { MaterialFlowAdapter } from '../material-flow-adapter';
import {
  DES_STATE_STACK,
  desHmiExtensionsVersion,
  desStateLabel,
  desStatePercent,
  registeredDesStates,
  socOf,
  subscribeDesHmiExtensions,
} from './des-stat-colors';
import { desKpiRowsOf, type DesKpiRow } from './des-stats-gizmos';

// ── Constants ──

const REFRESH_MS = 200;

/** Color of `Paused` — a component state that is not part of the utilization stack. */
const PAUSED_COLOR = '#ffa726';

/** State color mapping: `DES_STATE_STACK` (one source with chart + badges) plus `Paused`. */
const STATE_COLORS: Record<string, string> = {
  ...Object.fromEntries(DES_STATE_STACK.map((s) => [s.label, s.color])),
  Paused: PAUSED_COLOR,
};

/** State of charge (%) the project wrote on the component's node, else null (shared with the in-scene badge). */
export { socOf };

// ── Data type ──

export interface DESComponentTooltipData extends TooltipData {
  type: 'des-component';
  componentPath: string;
}

// ── Row helper ──

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: color ?? '#fff', fontSize: 11, fontFamily: 'monospace' }}>
        {value}
      </Typography>
    </Box>
  );
}

// ── Content component ──

export function DESComponentTooltipContent({ data, viewer }: TooltipContentProps<DESComponentTooltipData>) {
  const [stats, setStats] = useState<{
    name: string;
    type: string;
    currentState: string;
    currentLoad: number;
    maxCapacity: number;
    utilization: number;
    workingPercent: number;
    chargingPercent: number;
    transportPercent: number;
    slowedPercent: number;
    stoppedPercent: number;
    setupPercent: number;
    blockedPercent: number;
    kpiRows: DesKpiRow[];
    /** Registered (non-stack) states with their share, registration order (plan-644). */
    extraStates: { name: string; label: string; color: string; percent: number }[];
    outputPerHour: number;
    totalProcessed: number;
    slotOccupancy: string | null;
    batchProgress: string | null;
  } | null>(null);
  // Registry version: a state / KPI provider registered after the mount
  // re-runs the tick at once (plan-644, SOL R2 #3).
  const extVersion = useSyncExternalStore(subscribeDesHmiExtensions, desHmiExtensionsVersion);

  useEffect(() => {
    const tick = () => {
      const source = getActiveDesRunner(viewer);
      if (!source) {
        setStats(null);
        return;
      }
      const comp = desComponentAt(source, data.componentPath);
      if (!comp) {
        setStats(null);
        return;
      }
      const s = comp.getStatistics();
      const name = comp.path.split('/').pop() ?? comp.path;
      const adapter = comp instanceof MaterialFlowAdapter ? comp : null;
      const type = adapter?.componentType
        ?? (comp.constructor as { type?: string }).type
        ?? 'DESComponent';
      const slots = adapter?.self.prop.slots;
      const slotOccupancy = Array.isArray(slots)
        ? `${slots.filter((slot) => slot !== null).length} / ${slots.length}`
        : null;
      const configuredBatchSize = adapter?.self.prop.batchSize;
      const activeCycle = adapter?.self.prop.cycle as { n?: unknown } | null | undefined;
      const batchProgress = typeof configuredBatchSize === 'number'
        ? `${typeof activeCycle?.n === 'number' ? activeCycle.n : 0} / ${configuredBatchSize}`
        : null;
      setStats({
        name,
        type,
        currentState: s.currentState,
        currentLoad: s.currentLoad,
        maxCapacity: comp.MaxCapacity,
        utilization: s.utilization,
        workingPercent: s.workingPercent,
        chargingPercent: s.chargingPercent ?? 0,
        transportPercent: s.transportPercent ?? 0,
        slowedPercent: s.slowedPercent ?? 0,
        stoppedPercent: s.stoppedPercent ?? 0,
        setupPercent: s.setupPercent,
        blockedPercent: s.blockedPercent,
        kpiRows: desKpiRowsOf(comp),
        extraStates: registeredDesStates().map((st) => ({
          name: st.name, label: desStateLabel(st.name), color: st.color, percent: desStatePercent(comp, st.name),
        })),
        outputPerHour: s.outputPerHour,
        totalProcessed: s.totalProcessed,
        slotOccupancy,
        batchProgress,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.componentPath, extVersion]);

  if (!stats) return null;

  const stateColor = STATE_COLORS[stats.currentState] ?? 'text.secondary';

  return (
    <>
      {/* Component name */}
      <Typography
        variant="subtitle2"
        sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {stats.name}
      </Typography>

      {/* Type */}
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        {stats.type}
      </Typography>

      {/* State */}
      <Row label="State" value={stats.currentState} color={stateColor} />

      {/* Load */}
      <Row label="Load" value={`${stats.currentLoad} / ${stats.maxCapacity}`} />
      {stats.slotOccupancy && <Row label="Slots" value={stats.slotOccupancy} />}
      {stats.batchProgress && <Row label="Batch" value={stats.batchProgress} />}
      {stats.kpiRows.map((r, i) => <Row key={`kpi-${i}`} label={r.label} value={r.value} color={r.color} />)}

      {/* Utilization */}
      <Row label="Utilization" value={`${stats.utilization.toFixed(1)}%`} color="#66bb6a" />

      {/* Working / Setup / Blocked */}
      <Row label="Working" value={`${stats.workingPercent.toFixed(1)}%`} color={STATE_COLORS.Working} />
      {stats.chargingPercent > 0 && (
        <Row label="Charging" value={`${stats.chargingPercent.toFixed(1)}%`} color={STATE_COLORS.Charging} />
      )}
      {stats.transportPercent > 0 && (
        <Row label="Transport" value={`${stats.transportPercent.toFixed(1)}%`} color={STATE_COLORS.Transport} />
      )}
      {stats.slowedPercent > 0 && (
        <Row label="Slowed" value={`${stats.slowedPercent.toFixed(1)}%`} color={STATE_COLORS.Slowed} />
      )}
      {stats.stoppedPercent > 0 && (
        <Row label="Stopped" value={`${stats.stoppedPercent.toFixed(1)}%`} color={STATE_COLORS.Stopped} />
      )}
      <Row label="Setup" value={`${stats.setupPercent.toFixed(1)}%`} color={STATE_COLORS.Setup} />
      <Row label="Blocked" value={`${stats.blockedPercent.toFixed(1)}%`} color={STATE_COLORS.Blocked} />
      {stats.extraStates.filter((st) => st.percent > 0).map((st) => (
        <Row key={`state-${st.name}`} label={st.label} value={`${st.percent.toFixed(1)}%`} color={st.color} />
      ))}

      {/* Throughput */}
      <Row label="Output" value={`${stats.outputPerHour.toFixed(0)} /h`} />
      <Row label="Total" value={`${stats.totalProcessed}`} />
    </>
  );
}

// ── Self-registration ──

tooltipRegistry.register({
  contentType: 'des-component',
  component: DESComponentTooltipContent as any,
});

// ── Data resolver for GenericTooltipController (plan-2030 F1) ──
// Null without an active DES runner or without an instance on the hovered node;
// `componentPath` is the DES component's own `path`, which the content compares
// in `desComponentAt`.
tooltipRegistry.registerDataResolver('des-component', (node, viewer) => {
  const runner = getActiveDesRunner(viewer);
  if (!runner) return null;
  const byNode = new Map<unknown, string>();
  for (const inst of runner.liveInstances) {
    const comp = inst.adapter as unknown as { node?: unknown; path: string };
    if (comp.node && !byNode.has(comp.node)) byNode.set(comp.node, comp.path);
  }
  // The hovered node itself, else its nearest ancestor that is a DES component's node
  // (hovering a child part such as `PalletSink` under `Sink_V2`).
  for (let n: { parent?: unknown } | null | undefined = node as { parent?: unknown }; n; n = n.parent as { parent?: unknown } | null) {
    const path = byNode.get(n);
    if (path !== undefined) return { type: 'des-component', componentPath: path };
  }
  return null;
});
