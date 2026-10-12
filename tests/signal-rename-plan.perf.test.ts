// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 NFR "Performance": planning a rename takes < 100 ms at 20 000
 * signals. Measured here as the MEDIAN of several runs after a warm-up (the
 * usage index is built once and cached, exactly as in the viewer); the
 * assertion carries a 2× tolerance for CI machines (plan §9).
 */

import { describe, expect, it } from 'vitest';
import { SignalUsageService, installCoreSignalUsageProviders } from '../src/core/engine/rv-signal-usage-index';
import { planSignalRename } from '../src/core/engine/rv-signal-rename';
import { makeRenameFixture, node, plc } from './helpers/signal-rename-fixture';

const SIGNALS = 20_000;
const BUDGET_MS = 100;
const TOLERANCE = 2;

describe('planSignalRename performance', () => {
  it(`plans in < ${BUDGET_MS} ms (median, ×${TOLERANCE} tolerance) at ${SIGNALS} signals`, async () => {
    const f = makeRenameFixture((root) => {
      for (let g = 0; g < SIGNALS / 100; g++) {
        const group = node(`G${g}`, root);
        for (let i = 0; i < 100; i++) {
          const n = node(`S${i}`, group, plc(i % 2 ? 'PLCInputBool' : 'PLCOutputInt', `G${g}.S${i}`));
          if (i === 0) n.userData.realvirtual.WebSensor = { SignalBool: `G${g}.S1` };
        }
      }
      node('Panel', root, { WebOperatorPanel: { Config: JSON.stringify({ buttons: [{ signal: 'G7.S3' }] }) } });
      node('Info', root, { RuntimeMetadata: { content: '<signal>G7.S3</signal>' } });
    }, { connectNames: ['G7.S3'] });
    expect(f.store.registeredPaths('G199.S99')).toEqual(['Asset/G199/S99']);
    const usage = new SignalUsageService();
    installCoreSignalUsageProviders(usage, f.viewer);
    const viewer = { ...f.viewer, registry: f.registry, signalStore: f.store, scene: f.scene, signalUsage: usage };
    f.placed.placements = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`, signalMappings: [{ sourceKind: 'internal' as const, signal: `G${i}.S2` }],
    }));
    f.historian.selection = ['G7.S3', 'G8.S3'];

    const run = () => planSignalRename(viewer, 'Asset/G7/S3', 'Renamed.Signal', f.env);
    for (let i = 0; i < 3; i++) await run(); // warm-up (JIT + usage index build)
    const times: number[] = [];
    let last = null;
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      last = await run();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.info(`[perf] planSignalRename @ ${SIGNALS} signals: median ${median.toFixed(1)} ms (min ${times[0].toFixed(1)}, max ${times[times.length - 1].toFixed(1)})`);
    expect(last!.ok).toBe(true);
    expect(last!.counts['operator-panel']).toBe(1);
    expect(last!.counts.metadata).toBe(1);
    expect(last!.counts.connect).toBe(1);
    expect(median).toBeLessThan(BUDGET_MS * TOLERANCE);
  }, 120_000);
});
