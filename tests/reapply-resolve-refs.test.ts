// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T2 of plan-411 — `reapplySchemaForComponent()` must run loader STEP 2.
 *
 * `applySchema()` writes a `componentRef` field back as the RAW
 * `{type,path,componentType}` record. That is correct DURING construction (the
 * target may not exist yet) and wrong afterwards: every `setField` on a
 * reference — assigning a drive in the Quick Edit, re-pointing a signal — went
 * through this function, so the live instance ended up holding a plain object
 * where it expected an instance or an address string. The symptom was the
 * plan-404 one: the edit "worked" and nothing moved until the next reload.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { reapplySchemaForComponent } from '../src/core/hmi/scene/rv-scene-executors';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
// Side-effect import: `registerComponent({ type: 'TransportSurface' })` runs at
// module load, and the factory branch of reapplySchemaForComponent needs it.
import '../src/core/engine/rv-transport-surface';
import type { RVViewer } from '../src/core/rv-viewer';

function ref(path: string, componentType: string) {
  return { type: 'ComponentReference', path, componentType };
}

function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  // A viewer stand-in: `reapplySchemaForComponent` only ever touches `registry`.
  const viewer = { registry } as unknown as RVViewer;
  return { scene, root, registry, signalStore, viewer };
}

describe('plan-411 T2 — reapplySchemaForComponent resolves component refs', () => {
  it('turns a signal componentRef into the resolved address (class-schema path)', () => {
    const h = harness();
    const axis = new Object3D();
    axis.name = 'Axis';
    h.root.add(axis);
    h.registry.registerNode('Root/Axis', axis);

    const sig = new Object3D();
    sig.name = 'Pos';
    axis.add(sig);
    h.registry.registerNode('Root/Axis/Pos', sig);
    h.registry.register('PLCOutputFloat', 'Root/Axis/Pos', { address: 'Root/Axis/Pos', signalName: 'Pos' });

    const behavior = new RVDriveFollowPosition(axis);
    h.registry.register('Drive_FollowPosition', 'Root/Axis', behavior);
    axis.userData.realvirtual = {
      Drive_FollowPosition: { Position: ref('Root/Axis/Pos', 'PLCOutputFloat'), Scale: 3 },
    };

    reapplySchemaForComponent(h.viewer, 'Root/Axis', 'Drive_FollowPosition');

    // Raw record → address string. Before the fix this stayed an object.
    expect(behavior.Position).toBe('Root/Axis/Pos');
    expect(typeof behavior.Position).toBe('string');
    expect(behavior.Scale).toBe(3);
  });

  it('turns a Drive componentRef into the RVDrive instance (factory path)', () => {
    const h = harness();
    const driveNode = new Object3D();
    driveNode.name = 'Axis';
    h.root.add(driveNode);
    h.registry.registerNode('Root/Axis', driveNode);
    const drive = new RVDrive(driveNode);
    h.registry.register('Drive', 'Root/Axis', drive);

    const surfaceNode = new Object3D();
    surfaceNode.name = 'Belt';
    h.root.add(surfaceNode);
    h.registry.registerNode('Root/Belt', surfaceNode);

    // Any component whose schema carries a Drive reference does; TransportSurface
    // is the one every build has.
    const instance: Record<string, unknown> = { node: surfaceNode, DriveReference: null };
    h.registry.register('TransportSurface', 'Root/Belt', instance);
    surfaceNode.userData.realvirtual = {
      TransportSurface: { DriveReference: ref('Root/Axis', 'realvirtual.Drive') },
    };

    reapplySchemaForComponent(h.viewer, 'Root/Belt', 'TransportSurface');

    expect(instance.DriveReference).toBe(drive);
  });

  it('leaves an unresolvable reference as null instead of a raw record', () => {
    const h = harness();
    const axis = new Object3D();
    axis.name = 'Axis';
    h.root.add(axis);
    h.registry.registerNode('Root/Axis', axis);
    const behavior = new RVDriveFollowPosition(axis);
    h.registry.register('Drive_FollowPosition', 'Root/Axis', behavior);
    axis.userData.realvirtual = {
      Drive_FollowPosition: { Position: ref('Root/Nowhere', 'PLCOutputFloat') },
    };

    reapplySchemaForComponent(h.viewer, 'Root/Axis', 'Drive_FollowPosition');

    // Signal refs fall back to the raw path (the SignalStore may still know it);
    // what must NOT survive is the ComponentReference OBJECT.
    expect(typeof behavior.Position === 'string' || behavior.Position === null).toBe(true);
  });
});
