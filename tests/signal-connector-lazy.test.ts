// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 2 (bundle) — the SignalConnector loads ON DEMAND: this file
 * imports none of its modules. A real viewer loads a GLB with a SignalConnector;
 * the `signal-connector` feature activates before the bake, the component is
 * built and couples the signals, its nodes survive the bake.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { bootRealLoaderViewer, type Booted } from './helpers/nested-placement-fixture';

let booted: Booted | null = null;
afterEach(() => {
  booted?.h.dispose();
  booted = null;
  resetSlotAuthority();
  resetProblemsForTests();
});

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

const ref = (path: string) => ({ type: 'ComponentReference', path });

describe('SignalConnector on demand', () => {
  it('a model with a connector activates the feature before the bake; the connector couples', async () => {
    const root = new Group();
    root.name = 'Cell';
    const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    body.name = 'Body';
    root.add(body);
    const signals = child(root, 'Signals');
    child(signals, 'RobotReady', { PLCOutputBool: { Name: 'RobotReady', Status: { Value: false } } });
    child(signals, 'Rob_Ready', { PLCInputBool: { Name: 'Rob_Ready', Status: { Value: false } } });
    child(root, 'Coupler', { SignalConnector: { Mode: 'Copy', SourceBool: ref('Signals/RobotReady'), TargetBool: ref('Signals/Rob_Ready') } });

    booted = await bootRealLoaderViewer();
    const viewer = booted.h.viewer;
    expect(viewer.features.isDeclared('signal-connector')).toBe(true);
    await viewer.loadModel('cell.glb', { data: await objectToGlb(root) });
    await viewer.whenSceneReady();

    expect(viewer.features.isActive('signal-connector')).toBe(true);
    const registry = viewer.registry!;
    const found: Array<{ path: string; inst: { isActive?: boolean } }> = [];
    viewer.scene.traverse((node) => {
      const path = registry.getPathForNode(node);
      const inst = path ? registry.getComponentsAt(path)?.find(([t]) => t === 'SignalConnector')?.[1] : undefined;
      if (path && inst && !found.some((f) => f.inst === inst)) found.push({ path, inst: inst as { isActive?: boolean } });
    });
    expect(found.map((f) => f.path)).toEqual([expect.stringMatching(/Coupler$/)]);
    expect(found[0].inst.isActive).toBe(true);
    const store = viewer.signalStore!;
    store.set('RobotReady', true);
    expect(store.get('Rob_Ready')).toBe(true);
  }, 60_000);
});
