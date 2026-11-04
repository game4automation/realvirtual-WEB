// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import Source from '../../src/behaviors/Source';
import { getMaterialFlow, registerMaterialFlow } from '../../src/core/material-flow/registry';
import { RVSource, registerEngineSourceForNode } from '../../src/core/engine/rv-source';
import { sceneFixture } from './phase6-scene-fixture';

void Source;
const sourceDef = getMaterialFlow('Source')!;

it('9.26 visual factories belong only to the current source UUIDs after three rebinds', () => {
  registerMaterialFlow(sourceDef);
  const scene = new Scene();
  const addSource = () => {
    const node = new Object3D(); node.name = 'Source';
    node.userData.realvirtual = { Source: { Interval: 1000 } };
    scene.add(node);
    registerEngineSourceForNode(node, new RVSource(node));
    return node;
  };
  let source = addSource();
  const f = sceneFixture(scene);
  const factories = (f.runner as unknown as { _muVisualFactories: Map<string, unknown> })._muVisualFactories;
  expect(factories.size).toBe(1);
  for (let i = 0; i < 3; i++) {
    scene.remove(source);
    source = addSource();
    f.runner.rebindScene();
    expect(f.runner.liveInstances.filter(x => x.def.kind === 'source')).toHaveLength(1);
    expect.soft(factories.size, `rebind ${i + 1}`).toBe(1);
    // plan-2059: the template id is the reload-stable DES id of the CURRENT source.
    const current = f.runner.liveInstances.find(x => x.def.kind === 'source')!;
    expect(current.adapter.node).toBe(source);
    expect.soft([...factories.keys()]).toEqual([`source:${current.desId ?? source.uuid}`]);
  }
});
