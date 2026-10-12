// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GLB-free harness for drive behaviour ports: one `Root/Axis` node carrying a
 * Drive, plus the behaviour's PLC signals registered like a GLB export would.
 * Same primitives as tests/drive-sew-movilink.test.ts (`constructComponentOnNode`).
 */

import { Object3D, Scene } from 'three';
import {
  constructComponentOnNode,
  type DriveLifecycleHost,
  type RuntimeNodeDeps,
} from '../../src/core/engine/rv-scene-loader';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { EventEmitter } from '../../src/core/rv-events';
import type { ViewerEvents } from '../../src/core/rv-viewer-events';

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

export type SignalSpec = Record<string, 'PLCOutputBool' | 'PLCOutputInt' | 'PLCOutputFloat' | 'PLCInputBool' | 'PLCInputInt' | 'PLCInputFloat'>;

export interface BehaviorRig<T> {
  drive: RVDrive;
  behavior: T;
  signalStore: SignalStore;
  /** Signal path of a slot (`Root/Axis/<slot>`). */
  path(slot: string): string;
  /** Write a command signal. */
  set(slot: string, value: number | boolean): void;
  /** Read a feedback signal as number. */
  num(slot: string): number;
  /** Read a feedback signal as boolean. */
  bool(slot: string): boolean;
}

/**
 * Build a Drive + behaviour of `type` on `Root/Axis`, with every slot of
 * `signals` registered and wired through a ComponentReference.
 */
export function buildBehaviorRig<T>(
  type: string,
  signals: SignalSpec,
  overrides: Record<string, unknown> = {},
  driveOverrides: Record<string, unknown> = {},
): BehaviorRig<T> {
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

  const path = (slot: string) => `Root/Axis/${slot}`;
  for (const [slot, sigType] of Object.entries(signals)) {
    const node = new Object3D();
    node.name = slot;
    axis.add(node);
    registry.registerNode(path(slot), node);
    registry.register(sigType, path(slot), { address: path(slot), signalName: slot });
    signalStore.register(slot, path(slot), sigType.endsWith('Bool') ? false : 0, sigType);
  }
  signalStore.buildIndex();

  const drive = constructComponentOnNode(deps, axis, 'Drive', {
    Direction: 'LinearX',
    ...driveOverrides,
  }) as RVDrive;

  const refs = Object.fromEntries(Object.entries(signals).map(([slot, sigType]) => [
    slot,
    { type: 'ComponentReference', path: path(slot), componentType: sigType },
  ]));
  const behavior = constructComponentOnNode(deps, axis, type, { ...refs, ...overrides }) as T;

  return {
    drive, behavior, signalStore, path,
    set: (slot, value) => signalStore.setByPath(path(slot), value),
    num: (slot) => signalStore.getFloatByPath(path(slot)),
    bool: (slot) => signalStore.getBoolByPath(path(slot)),
  };
}
