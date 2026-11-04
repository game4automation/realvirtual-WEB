// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../rv-viewer';
import type { SimDesControl } from '../material-flow/simulation-kernel';
import type { StatsRow } from '../stats/rv-stats-registry';
import { getStatsHubSnapshot, subscribeStatsHub } from '../stats/stats-hub-store';

// Shown as the section caption, so the marking is visible without "Group by group" and also when the
// section is the only one (no tab bar). Measured values never feed determinism or parity checks.
export const MEASURED_CAPTION = 'Measured — not deterministic: these values depend on this machine and browser.';
const SECTION_ID = 'system.performance';
const round = (value: number): number => Math.round(value * 10) / 10;

/** Pure rate calculation; wall timestamps are milliseconds, counters are cumulative. */
export function measuredRate(current: number | undefined, previous: number | undefined, wallMs: number): number | null {
  if (current === undefined || previous === undefined || wallMs <= 0
    || !Number.isFinite(wallMs) || !Number.isFinite(current) || !Number.isFinite(previous)
    || current < previous) return null;
  return round((current - previous) * 1000 / wallMs);
}

/** Chromium's optional heap API; other browsers deliberately report no value. */
export function measuredHeapMb(source: { memory?: { usedJSHeapSize: number } } = globalThis.performance as Performance & {
  memory?: { usedJSHeapSize: number };
}): number | null {
  const bytes = source.memory?.usedJSHeapSize;
  return bytes === undefined || !Number.isFinite(bytes) ? null : round(bytes / 2 ** 20);
}

interface Sample {
  control: SimDesControl;
  generation: number | undefined;
  wall: number;
  processed: number | undefined;
  simTime: number;
  fastForward: boolean;
}

/** One lightweight hub contribution. Sampling happens only when the hub polls rows. */
export function registerPerformanceStats(viewer: RVViewer, now: () => number = () => performance.now()): () => void {
  let previous: Sample | undefined;
  return viewer.stats.register({
    id: SECTION_ID, title: 'Performance', description: MEASURED_CAPTION, order: 80, owner: 'system',
    isAvailable: () => viewer.currentModelRoot !== null,
    subscribe: notify => {
      const changed = () => { previous = undefined; notify(); };
      let hub = getStatsHubSnapshot();
      const offs = [
        viewer.on('model-loaded', changed), viewer.on('model-cleared', changed),
        subscribeStatsHub(() => {
          const next = getStatsHubSnapshot();
          if (hub.open !== next.open || hub.activeSection !== next.activeSection) previous = undefined;
          hub = next;
        }),
      ];
      return () => { previous = undefined; offs.forEach(off => off()); };
    },
    rows: () => {
      const row = (key: string, label: string, value: number | null, unit?: string): StatsRow =>
        ({ key, label, value, unit, owner: 'system' });
      const rows = [row('fps', 'FPS', viewer.currentFps, 'fps')];
      const control = viewer.simulationKernel?.desControl();
      if (control) {
        const sample: Sample = {
          control, generation: control.lifecycleGeneration, wall: now(),
          processed: control.eventStats?.().processed, simTime: control.simTime,
          fastForward: control.subMode === 'fastforward',
        };
        const before = previous?.control === control && previous.generation === sample.generation ? previous : undefined;
        const wallMs = before ? sample.wall - before.wall : 0;
        rows.push(row('events-per-second', 'DES events per wall-second',
          measuredRate(sample.processed, before?.processed, wallMs), '1/s'));
        rows.push(row('fastforward-rate', 'FastForward sim-seconds per wall-second',
          sample.fastForward && before?.fastForward
            ? measuredRate(sample.simTime, before.simTime, wallMs) : null, '×'));
        previous = sample;
      } else previous = undefined;
      // RVViewer exposes both backends through renderer (typed as the WebGPU Renderer).
      // WebGPU render.calls is cumulative; drawCalls is its per-frame WebGL calls equivalent.
      const info = viewer.renderer?.info as {
        render?: { calls?: number; drawCalls?: number };
        memory?: { geometries?: number };
      } | undefined;
      rows.push(row('heap-mb', 'JS heap', measuredHeapMb(), 'MB'));
      rows.push(row('draw-calls', 'Draw calls',
        (viewer.rendererKind === 'webgl' ? info?.render?.calls : info?.render?.drawCalls) ?? null));
      rows.push(row('geometries', 'Geometries', info?.memory?.geometries ?? null));
      return rows;
    },
  });
}
