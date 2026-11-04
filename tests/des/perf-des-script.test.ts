// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 4 — functional check of the `perf:des --script` fixture
 * (NOT a measurement): on the real PalletYard scene the monitor script binds
 * through the runner's production path, runs on the DES clock, sees every
 * sink arrival, and the run can still be snapshotted (the perf harness
 * measures `fullSnapshot()` after the run). Short horizon on purpose.
 */

import { describe, it, expect } from 'vitest';
import type { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { bindDesYard, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { composeYard } from '@rv/plugins/models/PalletYard/yard-compose';
import type { PalletYardConfig } from '@rv/plugins/models/PalletYard/layout';
import { loadPalletYardScene, nodeNamed } from './pallet-yard-scene-load';
import { attachPerfScript } from './perf-des-script';

const SIM_SEC = 1800;

describe('plan-2212 Phase 4 — perf:des with-script fixture', () => {
  it.each([
    ['dense', 60],
    ['realistic', 600],
  ] as const)('%s: binds on the DES clock, sees sink arrivals, keeps the run snapshot-able, settle stays off', async (variant, auditSec) => {
    const y = await loadPalletYardScene();
    let runner: DESRunner | undefined;
    const script = await attachPerfScript(y, variant);
    try {
      const cfg = nodeNamed(y.root, 'PalletYardRoot')?.userData.realvirtual?.PalletYard as (PalletYardConfig & { Size: number }) | undefined;
      if (!cfg) throw new Error('Missing PalletYard scene config');
      const yard = composeYard(cfg.Size);
      runner = new DESRunner({ subMode: 'fastforward', durationSeconds: SIM_SEC });
      runner.start([], { root: y.root, host: y.host as never });
      const bound = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry(), cfg, geometry: yard.geometry });
      if (!bound.ok) throw new Error(`bind: ${bound.missing.join(', ')}`);
      for (const inst of runner.liveInstances) {
        const lift = y.drives.find(d => { for (let n: Object3D | null = d.node; n; n = n.parent) if (n === inst.self.root) return d.node.name === 'Lift'; return false; });
        if (lift) (inst.adapter as unknown as { _drives: Map<string, unknown> })._drives.set('Lift', lift);
      }
      const rt = startDesRuntime(bound.backend, () => {}, { cfg, yard });

      expect(script.sinks.length).toBeGreaterThan(0);
      expect(script.plugin.desBound).toBe(true);
      const inst = script.plugin.instances.find(i => i.node.name === 'ShippingMonitorPerf')!;
      expect(inst.adapter!.mode).toBe('des');

      const manager = runner.getManager();
      // plan-2212 Phase 4b (A): the monitor reads no geometry - no per-event settle.
      expect(manager.onTimeAdvance).toBeNull();
      if (variant === 'realistic') expect(script.sinks).toHaveLength(1);
      for (let i = 0; i < 100_000 && !manager.isComplete; i++) { runner.tick(1 / 60); runner.lateTick(1 / 60); rt.frame(); }
      expect(manager.isComplete).toBe(true);

      const st = script.state();
      expect(st.arrivals).toBeGreaterThan(0);
      expect(st.audits).toBe(Math.floor(SIM_SEC / auditSec));
      expect(script.invocations()).toBe(st.arrivals + st.audits);
      expect(() => runner!.fullSnapshot()).not.toThrow();
    } finally { runner?.dispose(); script.dispose(); y.dispose(); }
  }, 120_000);
});
