// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A vehicle that moves its own node must be its own bake chunk. Without a
 * declared role the material-flow registration fell back to `merge`, the
 * destructive bake welded the AGV bodies of scenes/AGVDemo.glb into the static
 * chunk, and Play moved nothing visible (plan-451 / LOP-142).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import '../src/behaviors/Agv';
import '../src/behaviors/Conveyor';
import { getCapabilities, bakeRoleOf } from '../src/core/engine/rv-component-registry';

describe('material-flow bake roles', () => {
  it('Agv registers as a chunk boundary', () => {
    expect(getCapabilities('Agv').bake).toBe('chunk');
  });

  it('a node carrying Agv extras bakes as its own chunk', () => {
    const node = new Object3D();
    node.userData.realvirtual = { CADLink: { File: 'AGV.glb' }, Agv: { PathId: 'PathSouth' } };
    expect(bakeRoleOf(node)).toBe('chunk');
  });

  it('a behaviour without a declared role keeps the merge default', () => {
    expect(getCapabilities('Conveyor').bake).toBe('merge');
  });
});
