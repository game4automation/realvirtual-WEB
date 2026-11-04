// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-trace-tools — `web_trace_top` / `web_trace_set` (plan-629 Phase 3):
 * the congestion trace along the path network as numbers.
 *
 * `web_trace_top` lists the N highest 2 m buckets of one view (blocked =
 * standing although it wants to move, utilization = occupied by a vehicle
 * body) in one time range (sliding window or since start), measured in sim
 * time by the `PathTracePlugin`. `web_trace_set` switches the two overlay
 * categories and the time range — the same stores the Display panel's eye
 * toggles and range chip write.
 *
 * Query implementation only (plan-2007 Phase 4C); no MCP delegate.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { TraceRange, TraceRow, TraceView } from '../../core/engine/rv-path-trace';
import type { PathTracePlugin } from '../path-trace-plugin';
import { getTraceSettings } from '../../core/trace-settings-store';

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

function parseView(v: unknown): TraceView | null {
  const s = String(v ?? 'blocked').trim().toLowerCase();
  return s === 'blocked' || s === 'utilization' ? s : null;
}

function parseRange(v: unknown): TraceRange | null {
  const s = String(v).trim().toLowerCase();
  return s === 'window' || s === 'start' ? s : null;
}

export class TraceQueries {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private plugin(): PathTracePlugin | undefined {
    return this.getViewer()?.getPlugin<PathTracePlugin>('path-trace');
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryTraceTop(
    view?: string,
    range?: string,
    n?: number,
  ): Promise<string> {
    const p = this.plugin();
    if (!p) return JSON.stringify({ error: 'Path trace plugin not loaded' });
    const v = parseView(view);
    if (!v) return JSON.stringify({ error: `Unknown view "${view}" — use blocked or utilization` });
    const settings = getTraceSettings();
    const r = range === undefined || range === null || range === '' ? settings.range : parseRange(range);
    if (!r) return JSON.stringify({ error: `Unknown range "${range}" — use window or start` });
    const lim = Math.min(100, Math.max(1, Math.floor(Number.isFinite(Number(n)) && n !== undefined ? Number(n) : 10)));
    const rows: TraceRow[] = [];
    p.trace.topN(v, r, lim, rows);
    return JSON.stringify({
      view: v,
      simTime: round4(p.trace.simTime),
      range: r,
      windowSec: p.trace.windowSec,
      samples: r === 'window' ? p.trace.samplesWindow : p.trace.samplesTotal,
      rows: rows.map((row) => ({
        pathId: row.pathId,
        fromM: round4(row.fromM),
        toM: round4(row.toM),
        value: round4(row.value),
        pos: [round4(row.pos[0]), round4(row.pos[1]), round4(row.pos[2])],
      })),
    });
  }

}
