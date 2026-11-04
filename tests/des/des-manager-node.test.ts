// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  findDesManager,
  readDesManagerSettings,
  DES_MANAGER_NODE,
  DES_MANAGER_COMPONENT,
  DES_END_TIME_FIELD,
  DES_STAT_RESET_FIELD,
} from '../../src/core/material-flow/des-manager-node';

function sceneWithDesManager(endTime: number, statReset: number): Object3D {
  const root = new Object3D();
  root.name = 'Root';
  const node = new Object3D();
  node.name = DES_MANAGER_NODE;
  node.userData.realvirtual = {
    [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: endTime, [DES_STAT_RESET_FIELD]: statReset },
  };
  root.add(node);
  return root;
}

describe('findDesManager — DES clock settings as a scene component', () => {
  it('reads a one-day live default without a node', () => {
    const settings = readDesManagerSettings({ scene: new Object3D(), registry: null });
    expect(settings.endTime).toBe(86400);
    expect(settings.rawEndTime).toBe(86400);
  });
  it('returns null when no DESManager node exists', () => {
    const root = new Object3D();
    root.add(new Object3D());
    expect(findDesManager(root)).toBeNull();
  });

  it('parses a finite EndTime and StatisticsResetTime in seconds', () => {
    const ds = findDesManager(sceneWithDesManager(86400, 600));
    expect(ds).not.toBeNull();
    expect(ds!.endTime).toBe(86400);
    expect(ds!.statResetTime).toBe(600);
    expect(ds!.rawEndTime).toBe(86400);
  });

  it.each([0, -1])('maps EndTime %s to infinite (run until the queue empties)', (endTime) => {
    const ds = findDesManager(sceneWithDesManager(endTime, 0));
    expect(ds!.endTime).toBe(Infinity);
    expect(ds!.statResetTime).toBe(0);
    expect(ds!.rawEndTime).toBe(endTime); // the JSON-safe "infinite" sentinel
  });

  it('treats a non-positive StatisticsResetTime as off (0)', () => {
    const ds = findDesManager(sceneWithDesManager(3600, -5));
    expect(ds!.statResetTime).toBe(0);
  });

  it('exposes the node path for durable setField persistence', () => {
    const ds = findDesManager(sceneWithDesManager(3600, 0));
    expect(ds!.path).toContain(DES_MANAGER_NODE);
  });
});
