// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import { sceneFixture } from './phase6-scene-fixture';

it('9.25 five resets do not accumulate owner paths for a forced signal', () => {
  const signals = { Run: 'PLCInputBool' } as const;
  const def = defineMaterialFlow<MaterialFlowSelf<Record<string, never>, typeof signals>, typeof signals>({
    type: 'Phase6SignalOwner', kind: 'station', schema: {},
    signals, continuous: {}, des: {},
    setup(self) { self.sig.Run.set(true); },
  });
  registerMaterialFlow(def as unknown as MaterialFlowDefinition);
  const scene = new Scene();
  const node = new Object3D(); node.name = 'Owner';
  node.userData.realvirtual = { [def.type]: {} }; scene.add(node);
  const f = sceneFixture(scene);
  // Read the declared name from the actual binding, avoiding scope assumptions.
  const names = [...f.signalStore.getAllPaths().values()];
  const name = names.find(n => f.signalStore.registeredPaths(n).some(p => p.startsWith('__des-owner__/')))!;
  expect(name).toBeDefined();
  f.signalStore.forceSignal(name, false);
  const count = () => f.signalStore.registeredPaths(name).length;
  const baseline = count();
  expect(baseline).toBeGreaterThan(0);
  for (let i = 0; i < 5; i++) {
    f.runner.reset();
    expect.soft(count(), `reset ${i + 1}`).toBe(baseline);
    expect(f.signalStore.isForced(name)).toBe(true);
    expect(f.signalStore.get(name)).toBe(false);
  }
});
