// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2061 Phase 5 - the plan-2051 random consumers under RNG v2.
 *
 * Downtime (`downtime:mtbf` / `downtime:mttr`) and the fleet TaktSource
 * (`takt:<outputId>`) must draw from the NAMED v2 streams, never from the legacy
 * stream: two runs with the same seed are bit-identical, another seed differs,
 * and a spy on `RngStreamHandle.next` records exactly the expected purposes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import type { MaterialFlowAdapter } from '../../src/plugins/des/material-flow-adapter';
import { Station } from '../../src/plugins/des/material-flow/Station';
import { Downtime } from '../../src/plugins/des/material-flow/Downtime';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { RngStreamHandle } from '../../src/core/rv-rng-streams';
import { TaktSource, type TaktPlan } from '../../src/core/fleet/core/order-sources';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { SFC32 } from '../../src/core/rv-rng-distribution';
import { deriveFleetRngFactory } from '../../src/plugins/fleet-plugin';

const runners: DESRunner[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const runner of runners.splice(0)) runner.dispose();
});

/** Records every v2 draw as `<id>|<purpose>` while still drawing for real. */
function spyDraws(): string[] {
  const draws: string[] = [];
  const original = RngStreamHandle.prototype.next;
  vi.spyOn(RngStreamHandle.prototype, 'next').mockImplementation(function (this: RngStreamHandle) {
    draws.push(`${this.id}|${this.purpose}`);
    return original.call(this);
  });
  return draws;
}

interface Cycle { fail: number; repair: number }

function downtimeRun(seed: number, version: 1 | 2, until = 20_000) {
  resetDESMUCounter();
  for (const def of [Station, Downtime] as unknown as MaterialFlowDefinition[]) registerMaterialFlow(def);
  const scene = new Scene();
  const stationNode = new Object3D(); stationNode.name = 'Station';
  const downtimeNode = new Object3D(); downtimeNode.name = 'Downtime';
  scene.add(stationNode, downtimeNode);
  stationNode.userData.realvirtual = { Station: {} };
  downtimeNode.userData.realvirtual = {
    Downtime: { MTBF: 100, MTTR: 10, Stochastic: true, TargetComponentPath: 'Station' },
  };
  scene.updateMatrixWorld(true);
  const registry = { getNode: () => null, getAddressForNode: (n: Object3D) => 'addr:' + n.name };
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(), getPlugin: () => undefined,
  };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: seed });
  runners.push(runner);
  bindSceneToRunner(runner, scene, host);
  for (const { adapter } of runner.liveInstances) { adapter.nextComponents = []; adapter.previousComponents = []; }
  const manager = runner.getManager();
  manager.setRngVersion(version);
  manager.duration = 100_000;
  runner.start([], { root: scene });
  const adapterOf = (node: Object3D): MaterialFlowAdapter => runner.liveInstances.find(i => i.adapter.node === node)!.adapter;
  const station = adapterOf(stationNode);
  const dt = adapterOf(downtimeNode);
  const cycles: Cycle[] = [];
  const setFailure = station.setFailure.bind(station);
  station.setFailure = (on: boolean) => {
    if (on) cycles.push({ fail: manager.currentTime, repair: NaN });
    else if (cycles.length) cycles[cycles.length - 1].repair = manager.currentTime;
    setFailure(on);
  };
  const legacy = (dt as unknown as { _rng: SFC32 | null })._rng;
  const legacyFresh = JSON.stringify(manager.createComponentRng(dt.entityId >= 0 ? dt.entityId : 0).getState());
  manager.duration = until;
  while (manager.currentTime < until) if (manager.processEvents(1000) === 0) break;
  const legacyTouched = legacy ? JSON.stringify(legacy.getState()) !== legacyFresh : false;
  return { cycles: cycles.filter(c => Number.isFinite(c.repair)), legacyTouched, desId: dt.desId };
}

describe('plan-2051 Downtime under RNG v2', () => {
  it('same seed bit-identical, other seed differs', () => {
    const a = downtimeRun(7, 2).cycles;
    const b = downtimeRun(7, 2).cycles;
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    const seqs = [1, 2, 3, 4, 5].map(s => JSON.stringify(downtimeRun(s, 2).cycles));
    expect(new Set(seqs).size).toBe(5);
  });

  it('draws downtime:mtbf and downtime:mttr from the v2 streams, not the legacy stream', () => {
    const draws = spyDraws();
    const r = downtimeRun(7, 2);
    expect(r.desId).toBeTruthy();
    const purposes = new Set(draws.filter(d => d.startsWith(r.desId + '|')).map(d => d.split('|').pop()));
    expect(purposes).toEqual(new Set(['downtime:mtbf', 'downtime:mttr']));
    expect(r.legacyTouched).toBe(false);
    // Station draws nothing: every draw belongs to the downtime component
    expect(draws.every(d => d.startsWith(r.desId + '|'))).toBe(true);
    expect(draws.filter(d => d.endsWith('downtime:mtbf')).length).toBeGreaterThanOrEqual(r.cycles.length);
  });

  it('v1 control: the legacy stream is drawn, no v2 handle is touched', () => {
    const draws = spyDraws();
    const r = downtimeRun(7, 1);
    expect(r.cycles.length).toBeGreaterThan(20);
    expect(draws).toEqual([]);
    expect(r.legacyTouched).toBe(true);
  });

  it('v2 differs from v1 for the same seed (the streams are really other streams)', () => {
    expect(JSON.stringify(downtimeRun(7, 2).cycles)).not.toEqual(JSON.stringify(downtimeRun(7, 1).cycles));
  });
});

// -- TaktSource -------------------------------------------------------------

const plan: TaktPlan = { intervalSec: 60, phaseSec: [0, 30], stochastic: true };

function taktRun(seed: number, afterSetup?: () => void, planOverride: Partial<TaktPlan> = {}, until = 3600) {
  const runner = new DESRunner({ subMode: 'animated', masterSeed: seed });
  runners.push(runner);
  runner.setRngVersion(2);
  const factory = deriveFleetRngFactory('plant-A', runner, new Object3D());
  const clock = new ContinuousSimClock();
  const log: number[][] = [[], []];
  const source = new TaktSource(clock, { ...plan, ...planOverride }, 2, {
    headFree: () => true,
    release: (i) => { log[i].push(clock.now()); },
    blocked: () => { throw new Error('unexpected blocked takt'); },
  }, factory, ['out1', 'out2']);
  afterSetup?.();
  source.start();
  clock.advanceTo(until);
  return log;
}

describe('plan-2051 TaktSource under RNG v2', () => {
  it('same seed bit-identical, other seed differs', () => {
    const a = taktRun(7);
    expect(a[0].length).toBeGreaterThan(10);
    expect(taktRun(7)).toEqual(a);
    const seqs = [1, 2, 3, 4, 5].map(s => JSON.stringify(taktRun(s)));
    expect(new Set(seqs).size).toBe(5);
  });

  it('draws takt:<outputId> from the plant v2 streams, not the legacy stream', () => {
    const draws = spyDraws();
    let legacyNext: ReturnType<typeof vi.spyOn> | null = null;
    taktRun(7, () => { legacyNext = vi.spyOn(SFC32.prototype, 'next'); });
    expect(new Set(draws)).toEqual(new Set(['plant-A|takt:out1', 'plant-A|takt:out2']));
    expect(legacyNext!).not.toHaveBeenCalled();
  });

  it('the outputs have independent streams: changing out2 draw count leaves out1 untouched', () => {
    const base = taktRun(7);
    const perturbed = taktRun(7, undefined, { intervalPerOutput: [60, 7] });
    expect(base[0].length).toBeGreaterThan(10);
    expect(perturbed[1].length).toBeGreaterThan(base[1].length * 3);
    expect(perturbed[0]).toEqual(base[0]);
  });
});
