// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * perf-des-script.ts — plan-2212 Phase 4: the Model-Script of the `perf:des`
 * with-script variant (`npm run perf:des -- --script both`).
 *
 * Adds ONE ShippingMonitor-like `WebComponent` to a loaded PalletYard scene:
 * it listens to DES sinks (`self.sink(path).on`, Phase 2), keeps
 * `self.statValue` KPIs (late shipments, longest gap) and runs a `self.every`
 * audit timer — the shape of the Phase 6 demo script. Two densities
 * (plan-2212 Phase 4b, {@link PERF_SCRIPT_VARIANTS}): `dense` (every sink,
 * 60 s audit; `--script on|both`) and `realistic` (one sink, 600 s audit,
 * ~1 % of the events; `--script realistic`). The script is
 * wired by a real `WebComponentPlugin` and found by the runner the production
 * way (`host.getPlugin('web-component')`), so the measured FastForward includes
 * the per-run rebuild, the sink fan-out and the script hooks on the DES queue.
 *
 * Call {@link attachPerfScript} BEFORE `runner.start()`. Without it the
 * scenario is unchanged (the plain `yard:<size>` measurement).
 */

import { Object3D } from 'three';
import type { LoadResult } from '../../src/core/engine/rv-scene-loader';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import type { LoadedYardScene } from './pallet-yard-scene-load';

export const PERF_SCRIPT_NODE = 'ShippingMonitorPerf';

/**
 * The two with-script variants of `perf:des` (plan-2212 Phase 4b):
 *  - `dense`: listens to EVERY yard sink, audits every 60 s - the original
 *    Phase-4 fixture (~3-4 % of the events reach the script);
 *  - `realistic`: listens to ONE sink, audits every 600 s (~1 % of the events).
 */
export type PerfScriptVariant = 'dense' | 'realistic';

export const PERF_SCRIPT_VARIANTS: Record<PerfScriptVariant, { auditSec: number; allSinks: boolean }> = {
  dense: { auditSec: 60, allSinks: true },
  realistic: { auditSec: 600, allSinks: false },
};

/** Late = gap between two shipments above `lateGapSec`. */
export function shippingMonitorCode(sinks: readonly string[], lateGapSec = 600, auditSec = 60): string {
  // No setup bindings besides persist and SDK handles (a DES snapshot refuses
  // undeclared closure state); one block per sink, each guarded like the
  // ShippingMonitor demo (an unresolved sink is null, not a crash).
  const subscribe = sinks.map(p => `  { const sink = self.sink(${JSON.stringify(p)}); if (sink) sink.on(onShipment); }`).join(String.fromCharCode(10));
  return `
function setup(self) {
  const st = self.persist({ arrivals: 0, late: 0, last: -1, gap: 0, audits: 0 });
  self.statValue('Late shipments', 0);
  function onShipment() {
    st.arrivals++;
    if (st.last >= 0) {
      const g = self.now - st.last;
      if (g > st.gap) { st.gap = g; self.statValue('Longest shipping gap', g, 's'); }
      if (g > ${lateGapSec}) { st.late++; self.statValue('Late shipments', st.late); }
    }
    st.last = self.now;
  }
${subscribe}
  self.every(${auditSec}, 'audit');
  return {
    des: { on(hook) { if (hook === 'audit') { st.audits++; self.statValue('Arrivals', st.arrivals); } } },
    state() { return st; },
  };
}`;
}

/**
 * The yard's shipping sinks, addressed by placement name `Sink_<drop id>` - the
 * way the yard itself addresses them (`bindDesYard`). The script resolves the
 * same DES sink through the regular setup-time lookup; no rebind is needed
 * (see pallet-yard-script-sink.test.ts for the app lifecycle).
 */
export function yardSinkNames(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => {
    if (!/^Sink_/.test(n.name)) return;
    if (n.children.some(c => 'Sink' in ((c.userData as { realvirtual?: Record<string, unknown> }).realvirtual ?? {}))) out.push(n.name);
  });
  return [...new Set(out)].sort();
}

export interface AttachedPerfScript {
  readonly plugin: WebComponentPlugin;
  readonly sinks: string[];
  /** The script's persist state after the run (throws when the script is not running). */
  state(): { arrivals: number; late: number; gap: number; audits: number };
  /**
   * Host→VM invocations the run made into the script: one per sink arrival
   * (sink callback) plus one per audit (`self.every` slice → `des.on`).
   */
  invocations(): number;
  dispose(): void;
}

/**
 * Add the monitor script to the loaded yard and make the runner's topology
 * host find its plugin. The node gets an authored `NodeId` and is registered
 * in the viewer's NodeRegistry, so it has a DES address (run seed, snapshot).
 */
export async function attachPerfScript(y: LoadedYardScene, variant: PerfScriptVariant = 'dense'): Promise<AttachedPerfScript> {
  const all = yardSinkNames(y.root);
  if (!all.length) throw new Error('perf script: no Sink_* nodes in the yard');
  const { auditSec, allSinks } = PERF_SCRIPT_VARIANTS[variant];
  const sinks = allSinks ? all : all.slice(0, 1);
  const node = new Object3D();
  node.name = PERF_SCRIPT_NODE;
  node.userData.realvirtual = { NodeId: 'perf-des-shipping-monitor', WebComponent: { Code: shippingMonitorCode(sinks, 600, auditSec) } };
  y.root.add(node);
  y.root.updateMatrixWorld(true);
  const path = `${y.root.name}/${PERF_SCRIPT_NODE}`;
  const registry = y.viewer.registry;
  if (!registry) throw new Error('perf script: the viewer has no node registry');
  registry.registerNode(path, node);
  registry.registerNodeId(node);

  const plugin = new WebComponentPlugin({ allowScripts: true, createHost: () => RVScriptHost.create() });
  plugin.init(y.viewer);
  const load = { root: y.root, registry: y.viewer.registry, signalStore: y.viewer.signalStore } as unknown as LoadResult;
  plugin.onModelLoaded(load, y.viewer);
  await plugin.whenWired();
  if (plugin.wiringError()) throw new Error(`perf script wiring failed: ${plugin.wiringError()}`);
  (y.host as unknown as { getPlugin(id: string): unknown }).getPlugin = (id: string) => id === 'web-component' ? plugin : undefined;
  const attached: AttachedPerfScript = {
    plugin, sinks,
    state() {
      const inst = plugin.instances.find(i => i.node === node);
      const r = inst?.component?.callHandler('state');
      if (!inst?.ok || !r?.ok) throw new Error(`perf script not running: ${inst?.disabledReason ?? inst?.error?.message ?? r?.error?.message ?? 'no instance'}`);
      return r.value as { arrivals: number; late: number; gap: number; audits: number };
    },
    invocations() { const st = attached.state(); return st.arrivals + st.audits; },
    dispose() { plugin.dispose(); node.removeFromParent(); },
  };
  return attached;
}
