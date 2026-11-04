// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { DESManager, type IDESComponent } from '../../src/plugins/des/rv-des-manager';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import { Station } from '../../src/plugins/des/material-flow/Station';
import { Downtime } from '../../src/plugins/des/material-flow/Downtime';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { TaktSource, type RngFactory } from '../../src/core/fleet/core/order-sources';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { RngStreamHandle } from '../../src/core/rv-rng-streams';
import type { RngStream } from '../../src/core/rv-rng-distribution';
import { deriveFleetRngFactory } from '../../src/plugins/fleet-plugin';

const draws = (rng: RngStream) => Array.from({ length: 32 }, () => rng.next());
interface Cycle { fail: number; repair: number }

function downtimeRun(order: string[], bMttr = 10) {
  for (const def of [Station, Downtime] as unknown as MaterialFlowDefinition[]) registerMaterialFlow(def);
  const root = new Scene();
  for (const id of order) {
    const station = new Object3D(); station.name = id;
    station.userData.realvirtual = { Station: {} };
    const dt = new Object3D(); dt.name = id + 'Downtime';
    dt.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: id === 'B' ? bMttr : 10,
      Stochastic: true, TargetComponentPath: id } };
    root.add(station, dt);
  }
  root.updateMatrixWorld(true);
  const registry = { getNode: () => null, getAddressForNode: (n: Object3D) => 'addr:' + n.name };
  const host: BindContextHost = { signalStore: new SignalStore(), registry, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(), getPlugin: () => undefined };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: 7 });
  try {
    bindSceneToRunner(runner, root, host);
    for (const { adapter } of runner.liveInstances) { adapter.nextComponents = []; adapter.previousComponents = []; }
    const manager = runner.getManager();
    manager.setRngVersion(2);
    runner.start([], { root });
    const cycles: Record<string, Cycle[]> = {};
    for (const id of order) {
      cycles[id] = [];
      const station = runner.liveInstances.find(i => i.adapter.node.name === id)!.adapter;
      const original = station.setFailure.bind(station);
      station.setFailure = on => {
        if (on) cycles[id].push({ fail: manager.currentTime, repair: NaN });
        else if (cycles[id].length) cycles[id][cycles[id].length - 1].repair = manager.currentTime;
        original(on);
      };
    }
    manager.duration = 2000;
    while (manager.currentTime < 2000) if (!manager.processEvents(1000)) break;
    return cycles;
  } finally { runner.dispose(); }
}

function component(id: string): IDESComponent {
  return { desId: id, entityId: -1, path: id, attachManager: () => {}, resetStatistics: () => {} };
}

function fleetRun(ids: string[], disturb = false) {
  const clock = new ContinuousSimClock();
  const streams = new Map<string, RngStream>();
  const factory: RngFactory = purpose => {
    let stream = streams.get(purpose);
    if (!stream) { stream = new RngStreamHandle(7, 'Plant', purpose); streams.set(purpose, stream); }
    return stream;
  };
  const releases: Record<string, number[]> = Object.fromEntries(ids.map(id => [id, []]));
  const plan = { intervalSec: 60, phaseSec: ids.map(() => 0), stochastic: true };
  const source = new TaktSource(clock, plan, ids.length, {
    headFree: i => !disturb || ids[i] !== 'C' || clock.now() > 120,
    release: i => { releases[ids[i]].push(clock.now()); }, blocked: () => {},
  }, factory, ids);
  source.start();
  if (disturb) {
    clock.advanceTo(100);
    source.retime(ids.indexOf('C'));
    clock.advanceTo(130);
    source.headFreed(ids.indexOf('C'));
    source.retime(ids.indexOf('C'));
  }
  clock.advanceTo(1000);
  const first = structuredClone(releases);
  source.stop(); clock.reset();
  for (const xs of Object.values(releases)) xs.length = 0;
  source.start(); clock.advanceTo(1000); source.stop();
  if (!disturb) expect(releases).toEqual(first);
  return first;
}

describe('v2 common random numbers', () => {
  it('insertion and registration order preserve A/B failure and repair cycles', () => {
    const base = downtimeRun(['A', 'B']);
    expect(base.A.length).toBeGreaterThan(3);
    for (const variant of [downtimeRun(['C', 'A', 'B']), downtimeRun(['B', 'A'])]) {
      expect(variant.A).toEqual(base.A);
      expect(variant.B).toEqual(base.B);
    }
  });

  it('changing only B MTTR preserves A cycles', () => {
    const base = downtimeRun(['A', 'B']);
    const variant = downtimeRun(['A', 'B'], 40);
    expect(variant.A).toEqual(base.A);
    expect(variant.B).not.toEqual(base.B);
  });

  it('isolates MTBF and MTTR regardless of other-purpose draw order', () => {
    const m = new DESManager(); m.setRngVersion(2);
    const mtbf = m.stream('A', 'downtime:mtbf');
    const mttr = m.stream('A', 'downtime:mttr');
    const failures = draws(mtbf), repairs = draws(mttr);
    expect(failures).not.toEqual(repairs);
    m.reset();
    const interleaved = Array.from({ length: 32 }, () => { mttr.next(); mttr.next(); return mtbf.next(); });
    expect(interleaved).toEqual(failures);
    m.reset(); draws(mtbf); draws(mtbf);
    expect(draws(mttr)).toEqual(repairs);
    m.dispose();
  });

  it('rejects duplicate IDs both on version selection and registration', () => {
    const m = new DESManager();
    m.registerComponent(component('same')); m.registerComponent(component('same'));
    expect(() => m.setRngVersion(2)).toThrow('des-rng-duplicate-id: same');
    expect(m.rngVersion).toBe(1);
    m.clearComponents(); m.setRngVersion(2);
    m.registerComponent(component('same'));
    expect(() => m.registerComponent(component('same'))).toThrow('des-rng-duplicate-id: same');
    expect(m.componentCount).toBe(1);
    m.dispose();
  });

  it('insertion, reordering, blocking and retiming C preserve other fleet outputs', () => {
    const base = fleetRun(['A', 'B', 'C']);
    for (const variant of [fleetRun(['X', 'A', 'B', 'C']), fleetRun(['C', 'B', 'A']), fleetRun(['A', 'B', 'C'], true)]) {
      expect(variant.A).toEqual(base.A);
      expect(variant.B).toEqual(base.B);
    }
  });

  it('derives fleet factories through the manager in v2 and shares the legacy plant stream', () => {
    const runner = new DESRunner({ masterSeed: 7 });
    try {
      const legacy = deriveFleetRngFactory('Plant', runner, new Object3D());
      expect(legacy('takt:A')).toBe(legacy('takt:B'));
      runner.getManager().setRngVersion(2);
      const factory = deriveFleetRngFactory('Plant', runner, new Object3D());
      expect(factory('takt:A')).toBe(runner.getManager().stream('Plant', 'takt:A'));
      expect(factory('takt:A')).not.toBe(factory('takt:B'));
    } finally { runner.dispose(); }
  });
});
