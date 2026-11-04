// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

/** A Source holding back an MU (successor full) stores it as sourcePending.muRef;
 *  a forged or generation-less ref must be refused in the preflight, not after the
 *  live world was replaced (plan-2059 phase 7 review). */
function world() {
  const scene = new Scene();
  for (const [name, type, props, z] of [['Source', 'Source', { Interval: 1 }, 0], ['Gate', 'Station', { ProcessingTime: 10000 }, 1]] as const) {
    const node = new Object3D(); node.name = name; node.position.z = z;
    node.userData.realvirtual = { [type]: props }; scene.add(node);
  }
  const f = runnerFixture(scene);
  const [source, gate] = ['Source', 'Gate'].map(n => f.components.find(c => c.node.name === n)!);
  source.nextComponents = [gate]; gate.previousComponents = [source];
  f.runner.start([], { root: scene, host: f.host });
  f.manager.processAnimated(5);
  expect((source.self.local as unknown as { pending: unknown }).pending).not.toBeNull();
  return { ...f, source };
}

it.each([
  ['missing generation', (ref: { id: number; gen?: number }) => { delete ref.gen; }],
  ['wrong generation', (ref: { id: number; gen?: number }) => { ref.gen = 99; }],
  ['unknown MU', (ref: { id: number; gen?: number }) => { ref.id = 9999; }],
])('Source pending ref with %s is refused before the live run is touched', (_name, forge) => {
  const f = world();
  const before = f.runner.fullSnapshot();
  const snapshot: DESSnapshotV4 = JSON.parse(JSON.stringify(before));
  const part = snapshot.parts.find(p => (p.state as { sourcePending?: unknown })?.sourcePending);
  expect(part).toBeDefined();
  forge((part!.state as { sourcePending: { muRef: { id: number; gen?: number } } }).sourcePending.muRef);
  const reset = vi.spyOn(f.runner, 'reset');
  expect(() => f.runner.restoreFull(snapshot)).toThrow();
  expect(reset).not.toHaveBeenCalled();
  expect(f.runner.fullSnapshot()).toEqual(before);
});
