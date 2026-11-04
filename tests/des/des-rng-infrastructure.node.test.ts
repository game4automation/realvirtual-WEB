// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2051 Phase 0 (§9.0): `self.rng` end to end —
 * DESManager.masterSeed -> DESComponent.rng -> createSelf() thunk -> self.rng.
 * Taken over from the spike (spike/plan-2051-rng) unchanged in substance.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

interface ProbeLocal { draws: number[] }
const RngProbe = defineMaterialFlow<MaterialFlowSelf<ProbeLocal>>({
  type: 'RngProbe', kind: 'station', models: ['*RngProbe*'],
  schema: {},
  state: (): ProbeLocal => ({ draws: [] }),
  setup(self) { self.local.draws = []; },
  continuous: {},
  des: {
    onGenerate(self) { self.in(1, 'ProcessComplete', null); },
    onProcessComplete(self) {
      self.local.draws.push(self.rng ? self.rng.next() : -1);
      if (self.local.draws.length < 5) self.in(1, 'ProcessComplete', null);
    },
  },
}) as unknown as MaterialFlowDefinition;

function runOnce(seed: number): number[] {
  registerMaterialFlow(RngProbe);
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Probe';
  node.userData.realvirtual = { RngProbe: {} };
  scene.add(node);
  scene.updateMatrixWorld(true);
  const host: BindContextHost = {
    signalStore: new SignalStore(), registry: null, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  };
  const runner = new DESRunner({ subMode: 'animated', masterSeed: seed });
  bindSceneToRunner(runner, scene, host);
  const manager = runner.getManager();
  manager.duration = 100;
  runner.start([], { root: scene });
  manager.processEvents(1000);
  const adapter = runner.liveInstances.find(i => i.adapter.node === node)!.adapter;
  const draws = (adapter.self as unknown as { local: ProbeLocal }).local.draws;
  runner.dispose();
  return draws;
}

describe('plan-2051: self.rng end to end', () => {
  it('self.rng is non-null in DES mode and draws from the seeded SFC32', () => {
    const draws = runOnce(42);
    expect(draws.length).toBe(5);
    expect(draws.every(d => d >= 0 && d < 1)).toBe(true); // SFC32.next() in [0,1)
  });

  it('same seed -> identical draw sequence', () => {
    const a = runOnce(7);
    const b = runOnce(7);
    expect(b).toEqual(a);
  });

  it('different seed -> different draw sequence', () => {
    const a = runOnce(1);
    const b = runOnce(2);
    expect(b).not.toEqual(a);
  });
});
