// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import Source from '../../src/behaviors/Source';
import { getMaterialFlow, registerMaterialFlow } from '../../src/core/material-flow/registry';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { DESComponent } from '../../src/plugins/des/rv-des-component';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import { runScopeStore } from '../../src/core/material-flow/rv-run-history-store';
import type { DESMU } from '../../src/plugins/des/rv-des-mu';

void Source;
const sourceDef = getMaterialFlow('Source')!;
const runners: DESRunner[] = [];
afterEach(() => { for (const r of runners.splice(0)) r.dispose(); });
function fixture(name: string) {
  __resetDesRunSettingsForTest(); runScopeStore.set(null); registerMaterialFlow(sourceDef);
  const runner = new DESRunner({ subMode: 'animated' }); runners.push(runner);
  const scene = new Scene();
  const add = (name: string) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { Source: { Interval: 1000 } }; scene.add(node); return node;
  };
  const node = add(name);
  const progressLedger = new ProgressLedger({ clock: { now: () => runner.getManager().currentTime } });
  const waitRegistry = new WaitRegistry();
  const host = { signalStore: new SignalStore(), registry: null, drives: [], on: () => () => {},
    contextMenu: new ContextMenuStore(), getPlugin: () => undefined, progressLedger, waitRegistry };
  const topology = { root: scene, host };
  runner.start([], topology);
  // The same teardown operations owned by clearModel, without constructing WebGL/DOM.
  const clearModel = () => { runner.dispose(); waitRegistry.clear(); progressLedger.reset(); };
  return { runner, scene, node, add, host, topology, progressLedger, waitRegistry, clearModel };
}
function check(f: ReturnType<typeof fixture>) {
  const adapters = f.runner.liveInstances.map(i => i.adapter);
  expect(adapters).toHaveLength(1);
  const a = adapters[0];
  expect(f.waitRegistry.sources()).toEqual(['des']);
  expect(f.progressLedger.adapterSources()).toEqual(['des']);
  expect(f.progressLedger.sample(0).coverage.bySource).toEqual({ des: 1 });
  a.currentLoad = 1;
  expect(f.progressLedger.sample(0).coverage.armed).toBe(1);
  const before = f.progressLedger.entry(a.progressUnitId)!.count;
  a.recordOutput(); a.resetStatistics(); a.recordOutput();
  expect(f.progressLedger.entry(a.progressUnitId)!.count).toBe(before + 2);
  a.currentLoad = 0;
  expect(f.progressLedger.sample(0).coverage.inactive).toBe(1);
  return a;
}
it('DES A -> clearModel -> DES B has one current source and no old progress subscription', () => {
  const a = fixture('A'); const old = check(a); a.clearModel();
  expect(a.waitRegistry.sources()).toEqual([]);
  expect(a.progressLedger.adapterSources()).toEqual([]);
  expect(a.progressLedger.sample(0).coverage.expected).toBe(0);
  old.recordOutput(); expect(a.progressLedger.entry(old.progressUnitId)).toBeNull();
  const b = fixture('B'); check(b);
  expect(b.progressLedger.entry(old.progressUnitId)).toBeNull();
});
it('rebindScene and repeated start/reset replace all three subscriptions on the same runner', () => {
  const f = fixture('A'); const old = check(f);
  f.scene.remove(f.node); f.add('B'); f.runner.rebindScene();
  check(f); old.recordOutput(); expect(f.progressLedger.entry(old.progressUnitId)).toBeNull();
  f.runner.reset(); check(f);
  f.runner.reset(); check(f);
});
it('DES blocked output exposes a dependency while the protected map stays encapsulated', () => {
  class Blocked extends DESComponent {
    block(target: DESComponent) { this.blockedMUs.set(target, [{} as DESMU]); }
  }
  const nodeA = new Object3D(); nodeA.name = 'A';
  const nodeB = new Object3D(); nodeB.name = 'B';
  const a = new Blocked(nodeA), b = new Blocked(nodeB); a.block(b);
  expect(a.progressArmed).toBe(true);
  expect(a.waitEdges(5)).toEqual([{ waiterId: a.progressUnitId, resourceId: b.path,
    ownerIds: [b.progressUnitId], kind: 'des-exit', sinceSimSec: NaN, analysed: true, nodePath: a.path }]);
});
