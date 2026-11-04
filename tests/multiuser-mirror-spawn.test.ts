// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { computeTemplateAABBInfo, RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSource } from '../src/core/engine/rv-source';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { MultiuserPlugin, type MUSnapshot } from '../src/plugins/multiuser-plugin';

const managers: RVTransportManager[] = [];
afterEach(() => { for (const tm of managers.splice(0)) tm.reset(true); });

describe('multiuser mirrored source spawn', () => {
  it('preserves spawn count, template bounds and hook-free lifecycle through the real sync path', () => {
    const scene = new Scene();
    const tm = new RVTransportManager(); tm.scene = scene;
    managers.push(tm);
    const sourceNode = new Object3D(); sourceNode.name = 'Source'; scene.add(sourceNode);
    const source = new RVSource(sourceNode);
    const template = new Mesh(new BoxGeometry(.2, .3, .4).translate(.04, .08, -.02), new MeshBasicMaterial());
    template.name = 'Template';
    // Mirror spawning only needs these fields, as in the existing fake-viewer
    // fixture in mu-preplaced.test.ts; no session or network is started.
    source.muTemplate = template;
    source.spawnParent = scene;
    tm.sources.push(source);
    const onMUSpawned = vi.fn(), onMURemoved = vi.fn();
    tm.muLifecycleHook = { onMUSpawned, onMURemoved };
    tm.totalSpawned = 7;
    const plugin = new MultiuserPlugin();
    (plugin as any).viewer = { transportManager: tm, simulationKernel: null, registry: null, scene, emit: vi.fn() };
    const snapshot: MUSnapshot = {
      path: 'Model/Part_42', name: 'Part_42', source: 'Model/Source',
      pos: [2, 3, 4], rot: [0, 0, 0, 1],
    };
    (plugin as any)._applyMUSync([snapshot]);

    // These behavioral assertions also hold for the former push + counter code.
    expect(tm.mus).toHaveLength(1);
    const mu = tm.mus[0] as RVMovingUnit;
    expect(mu).toBeInstanceOf(RVMovingUnit);
    expect(mu.getName()).toBe('Part_42');
    expect(mu.node.parent).toBe(scene);
    expect(mu.node.position.toArray()).toEqual(snapshot.pos);
    expect(tm.totalSpawned).toBe(8);
    const info = computeTemplateAABBInfo(template);
    expect(info.halfSize.distanceTo(new Vector3(.1, .15, .2))).toBeLessThan(1e-6);
    const expected = AABB.fromHalfSize(mu.node, info.halfSize, info.localCenter);
    for (const key of ['halfSize', 'localCenter', 'center', 'min', 'max'] as const) {
      expect(mu.aabb[key].distanceTo(expected[key])).toBeLessThan(1e-6);
    }
    expect(mu.grow ?? null).toBeNull();
    expect(onMUSpawned).not.toHaveBeenCalled();
    expect(onMURemoved).not.toHaveBeenCalled();
    // Additional assertion for the manager's membership API.
    expect(tm.hasMU(mu)).toBe(true);

    (plugin as any)._applyMUSync([snapshot]);
    expect(tm.mus).toHaveLength(1);
    expect(tm.mus[0]).toBe(mu);
    expect(tm.totalSpawned).toBe(8);
    expect(mu.grow ?? null).toBeNull();
    expect(onMUSpawned).not.toHaveBeenCalled();
    expect(onMURemoved).not.toHaveBeenCalled();
  });
});
