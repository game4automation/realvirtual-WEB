// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { AgvFlow } from '../../src/behaviors/Agv';
import { registerMaterialFlow } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { runnerFixture } from './runner-fixture';
import { clearShared } from '../helpers/agv-harness';
afterEach(() => clearShared());

it('allows Agv capture and restore with an empty queue', () => {
  registerMaterialFlow(AgvFlow as unknown as MaterialFlowDefinition);
  const scene = new Scene(), node = new Object3D(); node.name = 'Transfer';
  node.userData.realvirtual = { Agv: { Active: false } };
  const path = new Object3D(); path.name = 'Path';
  path.userData.realvirtual = { Path: { type: 'Path', id: 'SnapshotProbePath',
    segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 3] }] } };
  node.add(path); scene.add(node);
  const { runner, manager, host } = runnerFixture(scene);
  runner.start([], { root: scene, host });
  expect(runner.liveInstances.some(i => i.def.type === 'Agv')).toBe(true);
  const before = JSON.stringify(manager.snapshot());
  const snapshot = runner.fullSnapshot();
  expect(() => runner.restoreFull(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();

  expect(JSON.stringify(manager.snapshot())).toBe(before);
});
