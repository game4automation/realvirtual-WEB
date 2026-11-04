// SPDX-License-Identifier: AGPL-3.0-only
import '../../src/behaviors/Turntable';
import '../../src/behaviors/Conveyor';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import '../../src/behaviors/OverheadConveyor';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { RVDrive, DriveDirection } from '../../src/core/engine/rv-drive';
import { runnerFixture } from './runner-fixture';
import { continuationWorld } from './continuation-world-fixture';

export function buildWorld(type: 'Turntable' | 'Conveyor' | 'OverheadConveyor', withDrive = false) {
  resetDESMUCounter();
  const scene = new Scene();
  const add = (name: string, kind: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [kind]: props }; scene.add(node); return node;
  };
  const sourceRoot = add('Source', 'Source', { Interval: 1, LimitNumber: true, MaxNumberMUs: 12 });
  sourceRoot.position.z = -1;
  const root = add('Subject', type, { StartPhase: 1250, TargetSpeed: 900 });
  const belt = new Mesh(new BoxGeometry(1, 0.1, 1)); belt.name = 'Transport-X';
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(belt, sensor);
  if (type === 'Turntable') { const drive = new Object3D(); drive.name = 'Drive-Rot-Y'; root.add(drive); }
  if (type === 'OverheadConveyor') {
    const path = new Object3D(); path.name = 'Path-Test';
    path.userData.realvirtual = { Path: { type: 'Path', id: 'inventory-overhead',
      segments: [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }] } };
    const carrier = new Object3D(); carrier.name = 'Carrier-1'; root.add(path, carrier);
  }
  const sinkRoot1 = add('Sink1', 'Sink'); sinkRoot1.position.z = 1;
  const sinkRoot2 = add('Sink2', 'Sink'); sinkRoot2.position.x = 1;
  for (const [owner, name, x, z] of [
    [sourceRoot, 'Snap-ZP-convroll', 0, 0.5], [root, 'Snap-ZN-convroll', 0, -0.5],
    [root, 'Snap-ZP-convroll', 0, 0.5], [sinkRoot1, 'Snap-ZN-convroll', 0, -0.5],
    [root, 'Snap-XP-convroll', 0.5, 0], [sinkRoot2, 'Snap-XN-convroll', -0.5, 0],
  ] as const) { const snap = new Object3D(); snap.name = name; snap.position.set(x, 0, z); owner.add(snap); }

  const f = runnerFixture(scene);
  const driveNode = root.getObjectByName('Drive-Rot-Y');
  const drive = withDrive && driveNode ? new RVDrive(driveNode) : null;
  if (drive) {
    drive.Direction = DriveDirection.RotationY; drive.TargetSpeed = 45; drive.initDrive();
    Object.assign(f.host, { drives: [drive] });
  }
  const [source, subject, sink1, sink2] = ['Source', 'Subject', 'Sink1', 'Sink2'].map(name => f.components.find(c => c.node.name === name)!);
  source.nextComponents = [subject]; subject.previousComponents = [source];
  subject.nextComponents = [sink1, sink2]; sink1.previousComponents = [subject]; sink2.previousComponents = [subject];
  f.runner.start([], { root: scene, host: f.host });
  subject.MaxCapacity = type === 'Turntable' ? 1 : 10;
  const base = continuationWorld(f.runner);
  return { ...base, runner: f.runner, local: subject.self.local, drive,
    kpis: () => ({ ...base.kpis(), ...(drive ? { 'table.drive': drive.currentPosition } : {}) }) };

}

