// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerCapabilities } from '../src/core/engine/rv-component-registry';
import {
  applyOmniverseSelection,
  resolveOmniversePrimPath,
} from '@rv-private/render-backends/omniverse-selection-bridge';

beforeAll(() => {
  registerCapabilities('Drive', { hoverable: true, selectable: true });
});

function makeViewer() {
  const scene = new Scene();
  const factory = new Object3D(); factory.name = 'Factory'; scene.add(factory);
  const robot = new Object3D(); robot.name = 'Robot'; factory.add(robot);
  const axis = new Object3D(); axis.name = 'Axis_1'; robot.add(axis);
  axis.userData.realvirtual = { Drive: {} };
  const mesh = new Object3D(); mesh.name = 'Visual'; axis.add(mesh);

  const registry = new NodeRegistry();
  factory.traverse((node) => registry.registerNode(NodeRegistry.computeNodePath(node), node));

  const selectionManager = {
    selectPaths: vi.fn(),
    clear: vi.fn(),
  };
  const emit = vi.fn();
  const viewer = {
    registry,
    currentModelRoot: factory,
    selectionManager,
    emit,
  } as unknown as RVViewer;
  return { viewer, registry, selectionManager, emit, axis };
}

describe('Omniverse selection bridge', () => {
  test('maps the full USD hierarchy and promotes a render prim to its WEB content owner', () => {
    const { viewer } = makeViewer();
    expect(resolveOmniversePrimPath(
      viewer,
      '/World/Model/ConverterRoot/Factory/Robot/Axis_1/Visual',
    )).toBe('Factory/Robot/Axis_1');
  });

  test('maps USD paths when asset_converter omits the GLB scene root', () => {
    const { viewer } = makeViewer();
    expect(resolveOmniversePrimPath(
      viewer,
      '/World/Model/Robot/Axis_1/Visual',
    )).toBe('Factory/Robot/Axis_1');
  });

  test('updates SelectionManager and emits backward-compatible click feedback', () => {
    const { viewer, selectionManager, emit, axis } = makeViewer();
    applyOmniverseSelection(viewer, [
      '/World/Model/ConverterRoot/Factory/Robot/Axis_1/Visual',
    ]);

    expect(selectionManager.selectPaths).toHaveBeenCalledWith(['Factory/Robot/Axis_1']);
    expect(emit).toHaveBeenCalledWith('object-clicked', {
      path: 'Factory/Robot/Axis_1',
      node: axis,
    });
  });

  test('clears WEB selection when Kit deselects or selects a wrapper-only prim', () => {
    const { viewer, selectionManager } = makeViewer();
    applyOmniverseSelection(viewer, []);
    applyOmniverseSelection(viewer, ['/World/HDRI']);
    expect(selectionManager.clear).toHaveBeenCalledTimes(2);
  });
});
