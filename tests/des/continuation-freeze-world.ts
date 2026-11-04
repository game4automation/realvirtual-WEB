// SPDX-License-Identifier: AGPL-3.0-only
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import '../../src/behaviors/ChainTransfer';
import '../../src/behaviors/Conveyor';
import '../../src/plugins/des/material-flow/Downtime';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { runnerFixture } from './runner-fixture';
import { continuationWorld } from './continuation-world-fixture';

export function freezeWorld(type: 'Conveyor' | 'ChainTransfer', downtime: { MTBF: number; MTTR: number } = { MTBF: 7, MTTR: 10 }) {
  resetDESMUCounter();
  const scene = new Scene();
  const add = (name: string, type: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [type]: props }; scene.add(node); return node;
  };
  add('Source', 'Source', { Interval: 1, LimitNumber: true, MaxNumberMUs: 12 });
  // Eight seconds of transit: failure at 7, repair at 17, Arrival at 18.
  // The same MU is in flight at both cuts (10 and 17.25).
  const transfer = add('Transfer', type);
  for (const name of (type === 'ChainTransfer' ? ['Transport-Z', 'Transport-X'] : ['Transport-X'])) {
    const mesh = new Mesh(new BoxGeometry(1, 0.1, 4)); mesh.name = name; transfer.add(mesh);
  }
  for (const name of (type === 'ChainTransfer' ? ['Drive-Lin-Y', 'Sensor'] : ['Sensor'])) {
    const node = new Object3D(); node.name = name; transfer.add(node);
  }
  const station = add('Station', 'Station', { ProcessingTime: 7 });
  station.position.z = 4;
  add('Sink', 'Sink').position.z = 5;
  for (const [owner, name, z] of [[transfer, 'Snap-ZP-convroll', 2],
    [station, 'Snap-ZN-convroll', -2]] as const) {
    const snap = new Object3D(); snap.name = name; snap.position.z = z; owner.add(snap);
  }
  add('Failure', 'Downtime', { TargetComponentPath: 'Transfer', MTBF: downtime.MTBF, MTTR: downtime.MTTR, Stochastic: false });
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
