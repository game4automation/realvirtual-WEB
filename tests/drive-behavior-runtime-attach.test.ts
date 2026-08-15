// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T1b of plan-411 — `addComponent Drive_<Behavior>` is its own case.
 *
 * A drive behavior cannot travel the `constructDrive()` path: it does not
 * CREATE anything, it ATTACHES to a drive that must already be there. The rules
 * this file pins down are the ones that decide whether the editor stays honest:
 * no silent drive creation, exactly one active behavior per drive, and a remove
 * that really unhooks the behavior from the drive it was ticking on.
 */

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  constructComponentOnNode,
  removeDriveComponentFromNode,
  type DriveLifecycleHost,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';

class FakeDriveHost implements DriveLifecycleHost {
  readonly drives: RVDrive[] = [];
  addDrive(drive: RVDrive): boolean {
    if (this.drives.includes(drive)) return false;
    this.drives.push(drive);
    return true;
  }
  removeDrive(drive: RVDrive): boolean {
    const i = this.drives.indexOf(drive);
    if (i < 0) return false;
    this.drives.splice(i, 1);
    return true;
  }
}

function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const events = new EventEmitter<ViewerEvents>();
  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager,
    driveHost: new FakeDriveHost(), events,
  };
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {};
  root.add(axis);
  registry.registerNode('Root/Axis', axis);
  return { scene, root, axis, registry, signalStore, events, deps };
}

describe('plan-411 T1b — drive behavior runtime attach', () => {
  it('refuses to attach without a parent Drive and creates NOTHING', () => {
    const h = harness();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = vi.fn();
    h.events.on('component-construction-failed', failed);

    const result = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});

    expect(result).toBeNull();
    // The important half: NO drive was invented on the way.
    expect(h.registry.getByPath('Drive', 'Root/Axis')).toBeNull();
    expect(h.registry.getByPath('Drive_FollowPosition', 'Root/Axis')).toBeNull();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      nodePath: 'Root/Axis',
      componentType: 'Drive_FollowPosition',
      reason: expect.stringContaining('no Drive'),
    }));
    err.mockRestore();
  });

  it('attaches to an existing Drive: registered, refs resolved, init() run', () => {
    const h = harness();
    const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', {
      Direction: 'LinearX',
    }) as RVDrive;

    // A signal the behavior's `Position` slot references — resolution of that
    // componentRef is what `init()` needs to subscribe.
    const sigNode = new Object3D();
    sigNode.name = 'Pos';
    h.axis.add(sigNode);
    h.registry.registerNode('Root/Axis/Pos', sigNode);
    h.registry.register('PLCOutputFloat', 'Root/Axis/Pos', { address: 'Root/Axis/Pos', signalName: 'Pos' });
    h.signalStore.register('Pos', 'Root/Axis/Pos', 0, 'PLCOutputFloat');
    h.signalStore.buildIndex();

    const behavior = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {
      Position: { type: 'ComponentReference', path: 'Root/Axis/Pos', componentType: 'PLCOutputFloat' },
      Scale: 2,
    }) as RVDriveFollowPosition;

    expect(behavior).toBeInstanceOf(RVDriveFollowPosition);
    expect(h.registry.getByPath('Drive_FollowPosition', 'Root/Axis')).toBe(behavior);
    // resolveComponentRefs ran: the raw ComponentReference became an address.
    expect(behavior.Position).toBe('Root/Axis/Pos');
    expect(behavior.Scale).toBe(2);
    // init() ran: the behavior hooked itself into the drive's behavior list.
    expect(drive.driveBehaviors).toContain(behavior);
    // The drive knows which behavior is active (drive-order + export read this).
    expect(drive.Behaviors).toEqual(['Drive_FollowPosition']);
  });

  it('is idempotent — a duplicate add returns the SAME instance', () => {
    const h = harness();
    constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' });
    const first = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});
    const second = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});

    expect(second).toBe(first);
    const drive = h.registry.getByPath<RVDrive>('Drive', 'Root/Axis')!;
    expect(drive.driveBehaviors).toHaveLength(1);
  });

  it('refuses a SECOND, different behavior on the same drive', () => {
    const h = harness();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});

    const second = constructComponentOnNode(h.deps, h.axis, 'Drive_Simple', {});

    expect(second).toBeNull();
    expect(h.registry.getByPath('Drive_Simple', 'Root/Axis')).toBeNull();
    expect(drive.Behaviors).toEqual(['Drive_FollowPosition']);
    err.mockRestore();
  });

  it('EXCHANGE works through remove → add (the editor path)', () => {
    const h = harness();
    const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    const follow = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {}) as RVDriveFollowPosition;

    expect(removeDriveComponentFromNode(h.deps, 'Root/Axis', 'Drive_FollowPosition')).toBe(true);
    // dispose() unhooked it from the drive — no phantom tick.
    expect(drive.driveBehaviors).not.toContain(follow);
    expect(drive.Behaviors).toEqual([]);
    expect(h.registry.getByPath('Drive_FollowPosition', 'Root/Axis')).toBeNull();

    const simple = constructComponentOnNode(h.deps, h.axis, 'Drive_Simple', {});
    expect(simple).not.toBeNull();
    expect(drive.Behaviors).toEqual(['Drive_Simple']);
  });

  it('UNDO of the drive takes its behavior with it', () => {
    const h = harness();
    const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    const follow = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {}) as RVDriveFollowPosition;

    expect(removeDriveComponentFromNode(h.deps, 'Root/Axis', 'Drive')).toBe(true);

    expect(h.registry.getByPath('Drive', 'Root/Axis')).toBeNull();
    // A behavior left registered would make a later re-add look like a duplicate.
    expect(h.registry.getByPath('Drive_FollowPosition', 'Root/Axis')).toBeNull();
    expect(drive.driveBehaviors).not.toContain(follow);

    // Redo: drive + behavior can be built again from scratch.
    const redoDrive = constructComponentOnNode(h.deps, h.axis, 'Drive', { Direction: 'LinearX' }) as RVDrive;
    const redoBehavior = constructComponentOnNode(h.deps, h.axis, 'Drive_FollowPosition', {});
    expect(redoBehavior).not.toBeNull();
    expect(redoBehavior).not.toBe(follow);
    expect(redoDrive.driveBehaviors).toHaveLength(1);
  });
});
