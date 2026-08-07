// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import {
  initializeComponents,
  processExtras,
  traverseAndRegister,
} from '../src/core/engine/rv-scene-loader';
import {
  attachDriveBehaviorByCode,
  type DriveBehaviorHostViewer,
} from '../src/core/engine/rv-signal-construction';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

afterEach(() => vi.restoreAllMocks());

function model() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {
    Drive: { Direction: 'LinearX' },
    Drive_Simple: {},
    Drive_Cylinder: {},
  };
  root.add(axis);
  return { scene, root, axis };
}

describe('one active Drive_* behavior', () => {
  it('main initializeComponents path keeps only the first authored behavior', () => {
    const { scene, root } = model();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const traversed = traverseAndRegister(root, registry, signalStore, new Map());
    initializeComponents(traversed.pending, {
      registry,
      signalStore,
      scene,
      root,
      transportManager: new RVTransportManager(),
    } as ComponentContext);

    expect(registry.getAll('Drive_Simple')).toHaveLength(1);
    expect(registry.getAll('Drive_Cylinder')).toHaveLength(0);
    expect(traversed.pending.filter((entry) => entry.type.startsWith('Drive_'))
      .map((entry) => entry.type)).toEqual(['Drive_Simple']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'keeping "Drive_Simple" and skipping "Drive_Cylinder"',
    ));
  });

  it('dynamic processExtras path keeps only the first authored behavior', () => {
    const { scene, root } = model();
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = processExtras(
      root,
      registry,
      signalStore,
      new RVTransportManager(),
      scene,
    );

    expect(result.componentsCreated).toBe(1);
    expect(registry.getAll('Drive_Simple')).toHaveLength(1);
    expect(registry.getAll('Drive_Cylinder')).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'keeping "Drive_Simple" and skipping "Drive_Cylinder"',
    ));
  });

  it('code attach is idempotent for the same type and rejects a different type', () => {
    const scene = new Scene();
    const axis = new Object3D();
    axis.name = 'Axis';
    axis.userData.realvirtual = { Drive: { Direction: 'LinearX' } };
    scene.add(axis);
    const registry = new NodeRegistry();
    const signalStore = new SignalStore();
    processExtras(axis, registry, signalStore, new RVTransportManager(), scene);
    const viewer = { registry, signalStore, scene } satisfies DriveBehaviorHostViewer;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = attachDriveBehaviorByCode(viewer, axis, 'Drive_Simple');
    const second = attachDriveBehaviorByCode(viewer, axis, 'Drive_Simple');
    const rejected = attachDriveBehaviorByCode(viewer, axis, 'Drive_DestinationMotor');

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(rejected).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      '"Drive_Simple" is already active',
    ));
  });
});
