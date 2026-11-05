// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * plan-2241a test 9.6 - benchmark of the event-driven progress lifecycle (NF1). OPT-IN ONLY.
 *
 * Skipped unless RV_PERF_2241=1, so it never burdens the normal suite. It is driven by
 * `.docs/planfeature/assets/plan-2241/phase3/run-phase3.mjs`, which copies this ONE file into the
 * `tests/des/` folder of two throwaway worktrees (base = 6f7dfb2d~1, new = origin/main) and runs one
 * process per measurement. The file therefore only uses API that exists on BOTH trees: "bound" is
 * the host with `progressLedger` + `waitRegistry` - today's sampling binding on the base tree, the
 * push binding (onProgress) on the new tree.
 *
 * One run = one variant of one world, FastForward over SIM seconds of DES time:
 *   world idle   = IDLE isolated Stations (never get an MU) + one Source -> Station -> Sink line
 *   world active = LINES x (Source -> 8 Stations with a bottleneck -> Sink), congested
 *   variant off   = no consumer attached (host without ledger)
 *   variant bound = ledger + wait registry bound like the production viewer
 * Result: one JSON line `RV2241_PERF {...}` on stdout and, when RV_PERF_2241_OUT is set, appended to that file.
 * Results (events, simTime, KPIs, processed) must be identical across variants and trees - the driver checks it.
 *
 * Env: RV_PERF_2241=1 (enable), RV_PERF_2241_VARIANT=off|bound, RV_PERF_2241_WORLD=idle|active,
 *      RV_PERF_2241_SIM (default 86400), RV_PERF_2241_IDLE (1000), RV_PERF_2241_LINES (100),
 *      RV_PERF_2241_INSPECT (inspection repetitions at the end state, bound only, default 50),
 *      RV_PERF_2241_OUT (jsonl file), RV_PERF_2241_COMMIT (label, default `git rev-parse --short HEAD`),
 *      RV_PERF_2241_TREE (label, e.g. base/new),
 *      RV_PERF_2241_SAMPLE=1 (sampling mode: V8 HeapProfiler sampling, interval 4096, incl. minor/major-GC-collected objects;
 *      emits `sampledBytes`. Sampling distorts the time - use it ONLY in separate runs, never for ms).
 *      Every run emits minorGc / majorGc (GC events split by detail.kind: 1 = minor/scavenge, 4 = major) next to gc.count.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { PerformanceObserver } from 'node:perf_hooks';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { Object3D, Scene } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { bindSceneToRunner } from '@rv/plugins/des/des-scene-binding';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { Station } from '@rv/plugins/des/material-flow/Station';
import Source from '@rv/behaviors/Source';
import Sink from '@rv/behaviors/Sink';
import { getMaterialFlow, registerMaterialFlow } from '@rv/core/material-flow/registry';
import type { MaterialFlowDefinition } from '@rv/core/material-flow/define-material-flow';
import { SignalStore } from '@rv/core/engine/rv-signal-store';
import { ContextMenuStore } from '@rv/core/hmi/context-menu-store';
import { ProgressLedger } from '@rv/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '@rv/core/diagnostics/rv-wait-registry';
import { BudgetResolver } from '@rv/core/diagnostics/rv-blockage-budget';
import { runBlockageChecker } from '@rv/core/diagnostics/rv-blockage-checker';
import { __resetDesRunSettingsForTest } from '@rv/core/hmi/des-run-settings-store';
import { runScopeStore } from '@rv/core/material-flow/rv-run-history-store';
import { testAddressRegistry } from '../helpers/test-address-registry';

void Source; void Sink;

type Variant = 'off' | 'bound';
type World = 'idle' | 'active';
const ENABLED = process.env.RV_PERF_2241 === '1';
const env = (k: string, d: string) => process.env[`RV_PERF_2241_${k}`] ?? d;

function buildScene(world: World, idle: number, lineCount: number): { scene: Scene; lines: string[][] } {
  const scene = new Scene();
  const lines: string[][] = [];
  let idx = 0;
  const add = (name: string, type: string, props: Record<string, unknown>) => {
    const n = new Object3D(); n.name = name; n.userData.realvirtual = { [type]: { ...props, AutoConnect: false } };
    n.position.set((idx % 100) * 50, Math.floor(idx / 100) * 50, 0); idx++; scene.add(n);
  };
  if (world === 'idle') {
    for (let i = 0; i < idle; i++) add(`Idle${i}`, 'Station', { ProcessingTime: 5 });
    add('L0_Src', 'Source', { Interval: 10 }); add('L0_St0', 'Station', { ProcessingTime: 5 }); add('L0_Snk', 'Sink', {});
    lines.push(['L0_Src', 'L0_St0', 'L0_Snk']);
  } else {
    for (let l = 0; l < lineCount; l++) {
      const names = [`L${l}_Src`];
      add(names[0], 'Source', { Interval: 20 });
      for (let s = 0; s < 8; s++) {
        const nm = `L${l}_St${s}`; names.push(nm);
        add(nm, 'Station', { ProcessingTime: s === 6 ? 25 : 10 + s });
      }
      names.push(`L${l}_Snk`); add(`L${l}_Snk`, 'Sink', {});
      lines.push(names);
    }
  }
  return { scene, lines };
}

/** Forced GC without --expose-gc: the flag is switched on at runtime, the function is fetched from a fresh context. */
function gcFn(): (() => void) | null {
  try { setFlagsFromString('--expose-gc'); return runInNewContext('gc') as () => void; } catch { return null; }
}
interface SamplingNode { selfSize: number; children: SamplingNode[] }
interface SamplingProfile { head: SamplingNode }
function sumSelfSize(n: SamplingNode): number { let t = n.selfSize; for (const c of n.children) t += sumSelfSize(c); return t; }
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

describe.skipIf(!ENABLED)('plan-2241a 9.6 progress lifecycle benchmark (opt-in: RV_PERF_2241=1)', () => {
  it('runs one variant and emits one JSON line', async () => {
    const variant = env('VARIANT', 'off') as Variant;
    const world = env('WORLD', 'idle') as World;
    const sim = Number(env('SIM', '86400'));
    const idle = Number(env('IDLE', '1000'));
    const lineCount = Number(env('LINES', '100'));
    const inspectReps = Number(env('INSPECT', '50'));
    expect(['off', 'bound']).toContain(variant);
    const gc = gcFn();

    __resetDesRunSettingsForTest(); runScopeStore.set(null); _resetDesHookCache(); resetDESMUCounter();
    for (const def of [getMaterialFlow('Source')!, getMaterialFlow('Sink')!, Station] as MaterialFlowDefinition[]) registerMaterialFlow(def);
    const { scene, lines } = buildScene(world, idle, lineCount);
    scene.updateMatrixWorld(true);
    const runner = new DESRunner({ subMode: 'animated', durationSeconds: sim, masterSeed: 42 });
    const progressLedger = variant === 'off' ? null : new ProgressLedger({ clock: { now: () => runner.getManager().currentTime } });
    const waitRegistry = variant === 'off' ? null : new WaitRegistry();
    const host = { signalStore: new SignalStore(), registry: null, desAddresses: testAddressRegistry(scene), drives: [],
      on: () => () => {}, contextMenu: new ContextMenuStore(), getPlugin: () => undefined,
      ...(progressLedger ? { progressLedger, waitRegistry } : {}) };
    bindSceneToRunner(runner, scene, host as never);
    const byName = new Map(runner.liveInstances.map(i => [i.adapter.node.name, i.adapter] as const));
    for (const c of byName.values()) { c.nextComponents = []; c.previousComponents = []; }
    for (const names of lines) for (let i = 0; i < names.length - 1; i++) {
      const a = byName.get(names[i])!, b = byName.get(names[i + 1])!;
      a.nextComponents = [b]; b.previousComponents = [a];
    }

    let gcCount = 0, gcMs = 0, minorGc = 0, majorGc = 0, otherGc = 0;
    const obs = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        gcCount++; gcMs += e.duration;
        const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind;
        if (kind === 1) minorGc++; else if (kind === 4) majorGc++; else otherGc++;
      }
    });
    const SAMPLE = process.env.RV_PERF_2241_SAMPLE === '1';
    const session = SAMPLE ? new Session() : null;
    session?.connect();
    const post = (m: string, p?: object) => new Promise<{ profile?: SamplingProfile }>((res, rej) =>
      session!.post(m, p ?? {}, (err: unknown, r: unknown) => (err ? rej(err) : res(r as { profile?: SamplingProfile }))));
    try { obs.observe({ entryTypes: ['gc'] }); } catch { /* gc entries unavailable */ }
    try {
      runner.start([], { root: scene, host } as never);
      const mgr = runner.getManager();
      gc?.(); gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      gcCount = 0; gcMs = 0; minorGc = 0; majorGc = 0; otherGc = 0;
      if (SAMPLE) {
        await post('HeapProfiler.enable');
        await post('HeapProfiler.startSampling', { samplingInterval: 4096, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
      }
      const t0 = performance.now();
      const done = await runner.runFastForward();
      let sampledBytes: number | undefined;
      if (SAMPLE) {
        const { profile } = await post('HeapProfiler.stopSampling');
        sampledBytes = sumSelfSize(profile!.head);
        session!.disconnect();
      }
      const wallMs = performance.now() - t0;
      const heapRaw = process.memoryUsage().heapUsed - heap0;       // retained + not yet collected garbage
      await new Promise(r => setTimeout(r, 50));                       // let the observer deliver pending gc entries
      const gcDuring = { count: gcCount, ms: Math.round(gcMs * 10) / 10, minorGc, majorGc, otherGc }; // allocation-pressure proxy
      gc?.(); gc?.();
      const heapRetained = process.memoryUsage().heapUsed - heap0;   // after forced GC
      const stats = runner.statistics();
      const out: Record<string, unknown> = {
        variant, world, sim, idle, lines: lineCount,
        tree: env('TREE', ''), commit: env('COMMIT', '') || (() => { try { return execSync('git rev-parse --short HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
        done, ms: Math.round(wallMs * 10) / 10, events: mgr.totalEventsProcessed, simTime: mgr.currentTime,
        components: runner.liveInstances.length,
        heapDeltaRawBytes: heapRaw, minorGc, majorGc, sample: SAMPLE, ...(sampledBytes !== undefined ? { sampledBytes } : {}), heapDeltaRetainedBytes: heapRetained, gc: gcDuring, gcForced: gc !== null,
        kpi: { throughputPerHour: stats.throughputPerHour, meanUtilization: stats.meanUtilization },
        processed: runner.liveInstances.reduce((s, i) => s + i.adapter.totalProcessed, 0),
      };
      if (progressLedger && waitRegistry && inspectReps > 0) {
        // Cost of one read-only inspection at the end state (what the Batch check / the watch pays per inspect).
        const budgets = new BudgetResolver({});
        const times: number[] = [];
        let rep = runBlockageChecker({ ledger: progressLedger, registry: waitRegistry, budgets, now: mgr.currentTime, readOnly: true });
        for (let k = 0; k < inspectReps; k++) {
          const a = performance.now();
          rep = runBlockageChecker({ ledger: progressLedger, registry: waitRegistry, budgets, now: mgr.currentTime, readOnly: true });
          times.push(performance.now() - a);
        }
        Object.assign(out, { inspectMedianMs: +median(times).toFixed(3), inspectMinMs: +Math.min(...times).toFixed(3), inspectReps,
          endFindings: rep.findings.length, endCoverage: rep.coverage,
          armedNow: runner.liveInstances.filter(i => i.adapter.progressArmed).length });
      }
      const line = JSON.stringify(out);
      console.log(`RV2241_PERF ${line}`);
      if (process.env.RV_PERF_2241_OUT) appendFileSync(process.env.RV_PERF_2241_OUT, line + '\n');
      expect(done).toBe(true);
      expect(mgr.currentTime).toBe(sim);
    } finally {
      obs.disconnect();
      runner.dispose();
    }
  }, 1_800_000);
});
