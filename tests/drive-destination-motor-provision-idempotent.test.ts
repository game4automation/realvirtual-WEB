// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  attachDriveBehaviorByCode,
  type DriveBehaviorHostViewer,
} from '../src/core/engine/rv-signal-construction';

function fixture() {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Axis';
  scene.add(node);
  node.userData.realvirtual = { Drive: { Direction: 'LinearX' } };
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Axis', node);
  registry.register('Drive', 'Axis', new RVDrive(node));
  const viewer: DriveBehaviorHostViewer = { scene, registry, signalStore: store };
  return { scene, node, registry, store, viewer };
}

describe('code-attached drive behavior without implicit wiring', () => {
  it('is idempotent and leaves all slots empty', () => {
    const f = fixture();
    const first = attachDriveBehaviorByCode(f.viewer, f.node, 'Drive_DestinationMotor');
    const second = attachDriveBehaviorByCode(f.viewer, f.node, 'Drive_DestinationMotor');
    expect(first).toBeInstanceOf(RVDriveDestinationMotor);
    expect(second).toBe(first);
    expect(f.node.children.find(child => child.name === 'Signals')).toBeUndefined();
    expect([...f.store.getAll().keys()]).toEqual([]);
    expect(first!.Destination).toBeNull();
    expect(first!.IsDriving).toBeNull();
    expect((f.node.userData.realvirtual.Drive_DestinationMotor as Record<string, unknown>).Destination)
      .toBeUndefined();
  });

  it('refuses a second, different Drive_* behavior', () => {
    const f = fixture();
    expect(attachDriveBehaviorByCode(f.viewer, f.node, 'Drive_Simple')).not.toBeNull();
    expect(attachDriveBehaviorByCode(f.viewer, f.node, 'Drive_DestinationMotor')).toBeNull();
    expect(f.registry.getByPath('Drive_DestinationMotor', 'Axis')).toBeNull();
  });
});
