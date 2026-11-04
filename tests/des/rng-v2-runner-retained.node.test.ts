// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import { Station } from '../../src/plugins/des/material-flow/Station';
import { Downtime } from '../../src/plugins/des/material-flow/Downtime';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { RngStreamHandle } from '../../src/core/rv-rng-streams';

// Codex review finding: ordinary runner restarts (clearComponents) must not drop
// binding-owned stream handles.
it('keeps the same stream objects across real runner.reset() and reseeds them', () => {
  for (const def of [Station, Downtime] as unknown as MaterialFlowDefinition[]) registerMaterialFlow(def);
  const root = new Scene();
  const station = new Object3D(); station.name = 'S';
  station.userData.realvirtual = { Station: {} };
  const dt = new Object3D(); dt.name = 'D';
  dt.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 10, Stochastic: true, TargetComponentPath: 'S' } };
  root.add(station, dt);
  root.updateMatrixWorld(true);
  const registry = { getNode: () => null, getAddressForNode: (n: Object3D) => 'addr:' + n.name };
  const host: BindContextHost = { signalStore: new SignalStore(), registry, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(), getPlugin: () => undefined };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: 7 });
  try {
    bindSceneToRunner(runner, root, host);
    for (const { adapter } of runner.liveInstances) { adapter.nextComponents = []; adapter.previousComponents = []; }
    runner.getManager().setRngVersion(2);
    runner.start([], { root });
    const adapter = runner.liveInstances.find(i => i.adapter.node.name === 'D')!.adapter;
    const held = adapter.rngFor('downtime:mtbf')!;
    runner.reset();
    expect(adapter.rngFor('downtime:mtbf')).toBe(held);
    runner.setMasterSeed(9);
    runner.reset();
    expect(adapter.rngFor('downtime:mtbf')).toBe(held);
    const id = adapter.desId!;
    const fresh = new RngStreamHandle(9, id, 'downtime:mtbf');
    fresh.next(); // the restarted run already drew the first MTBF delay from the held stream
    expect([held.next(), held.next()]).toEqual([fresh.next(), fresh.next()]);
  } finally { runner.dispose(); }
});
