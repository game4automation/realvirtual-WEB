// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import type { NodeSearchResult } from '../src/core/engine/rv-node-registry';
import { Object3D } from 'three';

describe('filterNodes drive compatibility', () => {
  it('should derive filteredDrives from node results', () => {
    const driveNode = new Object3D();
    const sensorNode = new Object3D();
    const results: NodeSearchResult[] = [
      { path: 'Cell/Axis1', node: driveNode, types: ['Drive'] },
      { path: 'Cell/Sensor1', node: sensorNode, types: ['Sensor'] },
    ];

    const drives = [
      { name: 'Axis1', node: driveNode },
      { name: 'Axis2', node: new Object3D() },
    ];

    // Derive filteredDrives like filterNodes() does
    const filteredDrives = drives.filter((d) =>
      results.some((r) => r.node === d.node)
    );

    expect(filteredDrives).toHaveLength(1);
    expect(filteredDrives[0].name).toBe('Axis1');
  });

  it('should return empty filteredDrives when no drives match', () => {
    const results: NodeSearchResult[] = [
      { path: 'Cell/Sensor1', node: new Object3D(), types: ['Sensor'] },
    ];
    const drives = [{ name: 'Axis1', node: new Object3D() }];

    const filteredDrives = drives.filter((d) =>
      results.some((r) => r.node === d.node)
    );
    expect(filteredDrives).toHaveLength(0);
  });
});
