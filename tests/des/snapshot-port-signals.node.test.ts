// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { compareFullSnapshots } from '../helpers/des-continuation-harness';

function world() {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Transfer'; scene.add(root);
  const snap = new Object3D(); snap.name = 'Snap-X'; root.add(snap);
  const f = runnerFixture(scene);
  f.runner.start([], { root: scene, host: f.host });
  const key = `Transfer.Flow.Occupied@${snap.uuid}`;
  f.signalStore.set(key, true);
  return { ...f, snap, key };
}
it('ChainTransfer/Turntable per-port signals remap to the new load UUID', () => {
  const a = world();
  const saved = a.runner.fullSnapshot();
  expect(JSON.stringify(saved)).not.toContain(a.snap.uuid);
  a.runner.dispose();
  const b = world();
  expect(b.snap.uuid).not.toBe(a.snap.uuid);
  b.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
  expect(b.signalStore.get(b.key)).toBe(true);
  compareFullSnapshots(saved, b.runner.fullSnapshot());
});
