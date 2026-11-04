// SPDX-License-Identifier: AGPL-3.0-only
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import '../../src/behaviors/ChainTransfer';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { runnerFixture } from './runner-fixture';
import { continuationWorld } from './continuation-world-fixture';

export function chainTransferWorld() {
  resetDESMUCounter();
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  add('Source', 'Source', { Interval: 1, LimitNumber: true, MaxNumberMUs: 12 });
  const transfer = add('Transfer', 'ChainTransfer');
  for (const name of ['Transport-Z', 'Transport-X']) {
    const mesh = new Mesh(new BoxGeometry(1, 0.1, 1)); mesh.name = name; transfer.add(mesh);
  }
  for (const name of ['Drive-Lin-Y', 'Sensor']) {
    const node = new Object3D(); node.name = name; transfer.add(node);
  }
  const station = add('Station', 'Station', { ProcessingTime: 7 });
  station.position.z = 1;
  add('Sink', 'Sink').position.z = 2;
  for (const [owner, name, z] of [[transfer, 'Snap-ZP-convroll', 0.5],
    [station, 'Snap-ZN-convroll', -0.5]] as const) {
    const snap = new Object3D(); snap.name = name; snap.position.z = z; owner.add(snap);
  }
  const f = runnerFixture(scene);
  const line = ['Source', 'Transfer', 'Station', 'Sink'].map(name => f.components.find(c => c.node.name === name)!);
  for (let i = 1; i < line.length; i++) {
    line[i - 1].nextComponents = [line[i]]; line[i].previousComponents = [line[i - 1]];
  }
  f.manager.statResetTime = 20;
  f.runner.start([], { root: scene, host: f.host });
  f.manager.scheduleCheckpoint(25);
  f.manager.onCheckpoint = time => f.manager.scheduleCheckpoint(time + 25);
  return { ...continuationWorld(f.runner), runner: f.runner };
}
