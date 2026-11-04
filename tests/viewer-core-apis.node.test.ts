// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion, Scene, Vector3 } from 'three';
import { EntityPool } from '@rv/core/engine/rv-entity-pool';
import { GroupRegistry } from '@rv/core/engine/rv-group-registry';
import { LineSegment, RVPath } from '@rv/core/engine/rv-path';
import { applyRenderHints } from '@rv/core/engine/rv-scene-loader';

describe('viewer core entity APIs', () => {
  it('getAbsPose equals the separate path queries', () => {
    const path = new RVPath('p', [new LineSegment(new Vector3(), new Vector3(10, 0, 5))]);
    const position = new Vector3(), direction = new Vector3();
    path.getAbsPose(3, position, direction);
    expect(position).toEqual(path.getAbsPosition(3));
    expect(direction).toEqual(path.getAbsDirection(3));
  });

  it('grows, maps picks and refreshes pick targets without a transport manager', () => {
    const refresh = vi.fn();
    const host = {
      scene: new Scene(), groups: null as GroupRegistry | null, refreshInstancedPickTargets: refresh,
      ensureGroups() { return this.groups ??= new GroupRegistry(); },
    };
    const pool = new EntityPool(host, {
      geometry: new BoxGeometry(), material: new MeshBasicMaterial(), initialCapacity: 1,
      growth: 2, groupName: 'External',
    });
    pool.set('a', new Vector3(), new Quaternion());
    pool.set('b', new Vector3(1, 0, 0), new Quaternion());
    pool.flush();
    expect(pool.count).toBe(2);
    expect(pool.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 32 }]);
    expect([pool.idAt(0), pool.idAt(1)].sort()).toEqual(['a', 'b']);
    pool.remove('a');
    expect(pool.idAt(0)).toBe('b');
    pool.dispose();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('applies scene suppression and inherited node depth bias', () => {
    const root = new Object3D();
    root.userData['realvirtual.SuppressGround'] = true;
    const carrier = new Object3D();
    carrier.userData['realvirtual.DepthBias'] = { factor: 2, units: 8 };
    const material = new MeshBasicMaterial();
    carrier.add(new Mesh(new BoxGeometry(), material)); root.add(carrier);
    expect(applyRenderHints(root).suppressGround).toBe(true);
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(2);
    expect(material.polygonOffsetUnits).toBe(8);
  });
});
