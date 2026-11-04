// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, it } from 'vitest';
import { commands } from 'vitest/browser';
import { Object3D, Scene } from 'three';
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
import { heapUsedAfterGc } from '../helpers/heap-sampling';
import { runnerFixture } from './runner-fixture';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { registerAction, ACTION_INDEX } from '@rv/plugins/des/rv-des-named-actions';
import { attachPerfScript, type AttachedPerfScript } from './perf-des-script';

declare const __RV_PERF_DES__: { enabled: boolean; scenario: string; simSec: number; script?: '' | 'dense' | 'realistic'; timing?: boolean };
declare module 'vitest/browser' {
  interface BrowserCommands {
    writePerfDesResult(json: string): Promise<void>;
  }
}

const options = typeof __RV_PERF_DES__ === 'undefined' ? undefined : __RV_PERF_DES__;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[2];
const heap = (): number => {
  const value = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  if (value === undefined || !Number.isFinite(value)) throw new Error('Chromium performance.memory unavailable');
  return value;
};

// Main browser include matches *.perf.test.ts; only the dedicated config enables it.
describe.skipIf(!options?.enabled)('DES performance (explicit opt-in only)', () => {
  it('writes one scenario result', async () => {
    const { scenario, simSec } = options!;
    if (!['yard', 'warehouse'].includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
    if (!Number.isFinite(simSec) || simSec <= 0) throw new Error('RV_PERF_DES_SIM_SEC must be positive');
    let runner: DESRunner | undefined;
    let disposeScene = (): void => {};
    let frame = (): void => {};
    let vehicles = 0, stations = 0, size = 0;
    // plan-2212 Phase 4: the with-script variant (`perf:des -- --script on|both`);
    // Phase 4b: `realistic` density (`--script realistic|all`).
    const variant = scenario === 'yard' && (options!.script === 'dense' || options!.script === 'realistic') ? options!.script : null;
    const withScript = variant !== null;
    let script: AttachedPerfScript | null = null;
    // Startup timing (only in `--script` invocations, both variants alike, so the
    // default-off output is unchanged): `startupMs` = runner.start (the per-run
    // script rebuild happens there) + yard bind + runtime start; `scriptAttachMs`
    // = the one-time script load/wiring before it (with-script variant only).
    const timing = scenario === 'yard' && options!.timing === true;
    let startupMs = 0, scriptAttachMs = 0;
    let vehicleSource = 'synthetic warehouse: no vehicles';
    let stationSource = 'synthetic Storage components';
    try {
      if (scenario === 'yard') {
        const y = await loadPalletYardScene({ url: '/__perf-des/PalletYard.glb' });
        disposeScene = () => y.dispose();
        const cfg = nodeNamed(y.root, 'PalletYardRoot')?.userData.realvirtual?.PalletYard as (PalletYardConfig & { Size: number }) | undefined;
        if (!cfg) throw new Error('Missing PalletYard scene config');
        size = cfg.Size;
        if (withScript) {
          const attachStart = performance.now();
          script = await attachPerfScript(y, variant!);
          scriptAttachMs = performance.now() - attachStart;
        }
        const yard = composeYard(size);
        const startupStart = performance.now();
        runner = new DESRunner({ subMode: 'fastforward', durationSeconds: simSec });
        runner.start([], { root: y.root, host: y.host as never });
        const bound = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry(), cfg, geometry: yard.geometry });
        if (!bound.ok) throw new Error(`bind: ${bound.missing.join(', ')}`);
        // As in the scene (and tests/des/pallet-yard-harness.ts): a vehicle's Lift drive belongs to its DES adapter, so the
        // snapshot's des.drives participant claims it. Without this fullSnapshot() refuses with des-state-not-declared.
        for (const inst of runner.liveInstances) {
          const lift = y.drives.find(d => { for (let n: Object3D | null = d.node; n; n = n.parent) if (n === inst.self.root) return d.node.name === 'Lift'; return false; });
          if (lift) (inst.adapter as unknown as { _drives: Map<string, unknown> })._drives.set('Lift', lift);
        }
        const rt = startDesRuntime(bound.backend, () => {}, { cfg, yard });
        startupMs = performance.now() - startupStart;
        frame = () => rt.frame();
        vehicles = cfg.vehicles.filter(id => nodeNamed(y.root, id) !== null).length;
        stations = cfg.stations.length;
        vehicleSource = 'PalletYardRoot.PalletYard.vehicles resolved in loaded scene (successful bind)';
        stationSource = 'PalletYardRoot.PalletYard.stations (pick, drop, buffer, charger; excludes wait points)';
      } else {
        // Minimal copy of the UNEXPORTED builder in rv-des-snapshot-scale.test.ts.
        // Keep that test untouched: 300 Storage components, 3000 MUs, 2000 pending events.
        resetDESMUCounter();
        if (!ACTION_INDEX.has('ScaleTest.Noop')) registerAction('ScaleTest.Noop', () => {}, { owner: 'component', payload: 'none' });
        const scene = new Scene();
        for (let i = 0; i < 300; i++) {
          const node = new Object3D(); node.name = `Storage-${i}`;
          node.userData.realvirtual = { Storage: { MaxCapacity: 3000, AutoRelease: false } };
          scene.add(node);
        }
        const fixture = runnerFixture(scene);
        runner = fixture.runner;
        runner.start([], { root: scene });
        fixture.components.forEach((c, i) => { c.prop['zone'] = `Z${i % 12}`; });
        const mus = Array.from({ length: 3000 }, (_, i) => {
          const mu = runner!.createMU();
          mu.prop['sku'] = `SKU-${i % 500}`; mu.prop['weight'] = (i % 37) * 0.5;
          fixture.components[i % 300].acceptMU(mu);
          return mu;
        });
        for (let i = 0; i < 2000; i++) fixture.manager.scheduleEvent(10 + i, 'ScaleTest.Noop', i % 300, mus[i % 3000].id, 0);
        stations = fixture.components.length;
      }
      const manager = runner.getManager();
      let heapPeakBytes = heap(), heapSamples = 1;
      const wallStart = performance.now();
      if (scenario === 'yard') {
        let idle = 0;
        while (!manager.isComplete) {
          const before = manager.totalEventsProcessed;
          runner.tick(1 / 60); runner.lateTick(1 / 60); frame();
          heapPeakBytes = Math.max(heapPeakBytes, heap()); heapSamples++;
          idle = manager.totalEventsProcessed === before ? idle + 1 : 0;
          if (idle >= 3 && !manager.isComplete) throw new Error(`DES stalled at ${manager.currentTime}s`);
        }
        if (runner.lastFfError) throw runner.lastFfError;
        if (!Number.isFinite(manager.nextModelEventTime)) throw new Error(`DES queue exhausted at ${manager.currentTime}s`);
      }
      // Warehouse is a snapshot-only workload: pending events deliberately stay queued.
      const wallMs = scenario === 'yard' ? performance.now() - wallStart : 0;
      // All events through the fixed horizon were processed; the last event may precede it.
      const simSeconds = scenario === 'yard' ? simSec : 0;
      const totalEventsProcessed = manager.totalEventsProcessed;
      const componentCount = manager.componentCount, muCount = manager.muCount, liveMuCount = manager.liveMuCount;
      // A with-script run whose script did not run would be a false measurement.
      const scriptState = script ? script.state() : null;
      if (scriptState && !(scriptState.arrivals > 0 && scriptState.audits > 0)) {
        throw new Error(`perf script saw no work: ${JSON.stringify(scriptState)}`);
      }
      const heapAfterGcBytes = await heapUsedAfterGc();
      const snapshotTimes: number[] = [], restoreTimes: number[] = [];
      let snapshotBytes = 0;
      {
        let snapshot = runner.fullSnapshot();
        for (let i = 0; i < 5; i++) {
          const start = performance.now(); snapshot = runner.fullSnapshot();
          snapshotTimes.push(performance.now() - start);
        }
        const serialized = JSON.stringify(snapshot);
        snapshotBytes = new TextEncoder().encode(serialized).byteLength;
        for (let i = 0; i < 5; i++) {
          const parsed = JSON.parse(serialized);
          const start = performance.now(); runner.restoreFull(parsed);
          restoreTimes.push(performance.now() - start);
        }
      }
      const metrics: Record<string, number> = {
        wallMs, simSeconds, lastEventTimeSeconds: manager.currentTime, totalEventsProcessed,
        eventsPerSecond: scenario === 'yard' ? totalEventsProcessed / (wallMs / 1000) : 0,
        simHoursPerWallHour: scenario === 'yard' ? simSeconds / (wallMs / 1000) : 0,
        componentCount, muCount, liveMuCount, vehicles, stations,
        heapPeakBytes, heapSamples,
        snapshotMs: median(snapshotTimes), snapshotBytes,
        restoreMs: median(restoreTimes),
        ...(heapAfterGcBytes === null ? {} : { heapAfterGcBytes }),
        ...(scriptState ? { scriptSinkArrivals: scriptState.arrivals, scriptAudits: scriptState.audits,
          // Host→VM invocations (sink callbacks + audit dispatches) - the divisor of the µs/invocation budget.
          scriptInvocations: scriptState.arrivals + scriptState.audits } : {}),
        ...(timing ? { startupMs, runMs: startupMs + wallMs } : {}),
        ...(timing && withScript ? { scriptAttachMs } : {}),
      };
      for (const [key, value] of Object.entries(metrics)) if (!Number.isFinite(value)) throw new Error(`Non-finite metric: ${key}`);
      await commands.writePerfDesResult(JSON.stringify({
        scenario: scenario === 'yard' ? `${variant === 'dense' ? 'yard+script' : variant === 'realistic' ? 'yard+script-realistic' : 'yard'}:${size}` : 'warehouse-synthetic',
        kind: scenario === 'yard' ? 'fastforward' : 'snapshot-only', size,
        requestedSimSeconds: scenario === 'yard' ? simSec : 0, metrics,
        sources: {
          heapPeakBytes: 'performance.memory.usedJSHeapSize; sampled before run and after every tick (sampled peak, not allocation high-water mark)',
          heapAfterGcBytes: heapAfterGcBytes === null ? 'unavailable' : 'CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage',
          componentCount: 'DESManager.componentCount', muCount: 'DESManager.muCount (allocated MU slots)',
          liveMuCount: 'DESManager.liveMuCount', vehicles: vehicleSource, stations: stationSource,
        },
      }));
    } finally { runner?.dispose(); script?.dispose(); disposeScene(); }
  }, 3_600_000);
});
