// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, afterEach, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import { runnerFixture } from './runner-fixture';

beforeEach(() => { __resetDesRunSettingsForTest(); });
afterEach(() => { __resetDesRunSettingsForTest(); });

let nextType = 0;
export function flow(def: Partial<MaterialFlowDefinition> = {}): MaterialFlowDefinition {
  return defineMaterialFlow({
    type: `Plan2006Transfer${nextType++}`, kind: 'station', schema: {}, continuous: {},
    ...def,
  });
}

/** Real scene binding supplies self.mus, scheduling and the runner transfer backend. */
export function transferFixture(entries: Array<{
  type: string | MaterialFlowDefinition;
  props?: Record<string, unknown>;
}>) {
  const scene = new Scene();
  const nodes = entries.map(({ type, props }, i) => {
    if (typeof type !== 'string') registerMaterialFlow(type);
    const node = new Object3D();
    node.name = `Part${i}`;
    node.userData.realvirtual = { [typeof type === 'string' ? type : type.type]: props ?? {} };
    scene.add(node);
    return node;
  });
  const fixture = runnerFixture(scene);
  const parts = nodes.map(node => fixture.components.find(c => c.node === node)!);
  expect(parts.every(Boolean)).toBe(true);
  for (let i = 0; i < parts.length - 1; i++) {
    parts[i].nextComponents = [parts[i + 1]];
    parts[i + 1].previousComponents = [parts[i]];
  }
  fixture.manager.statResetTime = 0;
  fixture.runner.start([], { root: scene });
  return {
    ...fixture, parts,
    advance(time: number) {
      expect(time).toBeGreaterThanOrEqual(fixture.manager.currentTime);
      fixture.manager.processAnimated(time - fixture.manager.currentTime);
      expect(fixture.manager.currentTime).toBe(time);
    },
  };
}
