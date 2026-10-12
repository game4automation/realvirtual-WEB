// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A Sensor's runtime visualisation must never become file content.
 *
 * The export pruned `_sensorViz` but not the ray tube `_sensorRay`, so every
 * save wrote the beam into the GLB and the next load built another one beside
 * it — Festo's funnel light barrier ended up with a dozen
 * `FunnelLightBarrier_sensorRay_1_1_1…` children that could not be deleted.
 * Covered here: the name rule, the export prune, the load-time strip before the
 * bake, and `init()` leaving exactly one beam.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import { isSensorRuntimeVizName } from '../src/core/engine/rv-sensor-viz-names';
import { pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';
import { stripPersistedSensorViz } from '../src/core/engine/rv-prepare-and-bake';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

const POLLUTED = [
  'FunnelLightBarrier_sensorRay',
  'FunnelLightBarrier_sensorRay_1',
  'FunnelLightBarrier_sensorRay_1_1_1_1',
  'FunnelLightBarrier_sensorViz_1',
  'FunnelLightBarrier_sensorViz_edges',
];

function mesh(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(0.01, 0.01, 0.1), new MeshBasicMaterial());
  m.name = name;
  return m;
}

function pollutedSensor(): { root: Group; sensor: Object3D } {
  const root = new Group(); root.name = 'Festo';
  const sensor = new Object3D(); sensor.name = 'FunnelLightBarrier';
  root.add(sensor);
  sensor.add(mesh('Housing'));
  for (const n of POLLUTED) sensor.add(mesh(n));
  return { root, sensor };
}

function childNames(node: Object3D): string[] {
  return node.children.map((c) => c.name);
}

function makeCtx(): ComponentContext {
  return {
    signalStore: { register: () => {}, set: () => {}, setByPath: () => {} },
    transportManager: { sensors: [] },
  } as unknown as ComponentContext;
}

describe('isSensorRuntimeVizName', () => {
  it('matches box, outline and ray with any dedup suffix', () => {
    for (const n of POLLUTED) expect(isSensorRuntimeVizName(n), n).toBe(true);
  });

  it('leaves authored names alone', () => {
    for (const n of ['Sensor', 'Ray', 'Ray_1', 'sensorRay', 'Light_sensorRayHolder', 'X_sensorRay_a', 'X_sensorViz_edges_b']) {
      expect(isSensorRuntimeVizName(n), n).toBe(false);
    }
  });
});

describe('GLB export prune', () => {
  it('drops every sensor visualisation, including the ray tube', () => {
    const { root, sensor } = pollutedSensor();
    pruneRuntimeHelpers(root);
    expect(childNames(sensor)).toEqual(['Housing']);
  });
});

describe('load-time strip before the bake', () => {
  it('removes persisted copies but keeps nodes that carry extras or children', () => {
    const { root, sensor } = pollutedSensor();
    const authored = mesh('Odd_sensorRay');
    authored.userData.realvirtual = { Sensor: {} };
    sensor.add(authored);
    const parent = new Object3D(); parent.name = 'Group_sensorRay';
    parent.add(mesh('Child'));
    sensor.add(parent);

    expect(stripPersistedSensorViz(root)).toBe(POLLUTED.length);
    expect(childNames(sensor)).toEqual(['Housing', 'Odd_sensorRay', 'Group_sensorRay']);
  });
});

describe('RVSensor.init', () => {
  function raycastSensor(node: Object3D): RVSensor {
    const s = new RVSensor(node, new AABB());
    s.UseRaycast = true;
    s.RayCastLength = 500;
    return s;
  }

  it('replaces persisted beams with exactly one fresh beam', () => {
    const { sensor: node } = pollutedSensor();
    raycastSensor(node).init(makeCtx());
    const beams = node.children.filter((c) => isSensorRuntimeVizName(c.name));
    expect(beams.map((c) => c.name)).toEqual(['FunnelLightBarrier_sensorRay']);
    expect(childNames(node)).toContain('Housing');
  });

  it('a second init does not stack a second beam', () => {
    const node = new Object3D(); node.name = 'Sensor';
    const s = raycastSensor(node);
    s.init(makeCtx());
    s.init(makeCtx());
    expect(node.children.filter((c) => isSensorRuntimeVizName(c.name))).toHaveLength(1);
  });
});
