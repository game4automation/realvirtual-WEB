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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb, pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';
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
  sensor.userData.realvirtual = { Sensor: {} }; // the legacy rule needs the Sensor on the parent
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
  it('drops MARKED sensor visualisation, keeps unmarked names (authored, or legacy migrated on load)', () => {
    const { root, sensor } = pollutedSensor();
    const live = mesh('FunnelLightBarrier_sensorViz_2');
    live.userData._rvRuntimeVisual = true;
    sensor.add(live);
    pruneRuntimeHelpers(root);
    expect(childNames(sensor)).toEqual(['Housing', ...POLLUTED]);
  });
});

describe('load-time strip before the bake', () => {
  it('removes persisted copies under the Sensor node but keeps nodes that carry extras or children', () => {
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

  it('load path: the loader strip removes persisted beams, init adds exactly one fresh, marked beam', () => {
    const { root, sensor: node } = pollutedSensor();
    stripPersistedSensorViz(root); // prepareAndBake runs it before any init
    raycastSensor(node).init(makeCtx());
    const beams = node.children.filter((c) => isSensorRuntimeVizName(c.name));
    expect(beams.map((c) => c.name)).toEqual(['FunnelLightBarrier_sensorRay']);
    expect(beams[0].userData._rvRuntimeVisual).toBe(true);
    expect(childNames(node)).toContain('Housing');
  });

  it('init removes only its MARKED viz; legacy copies are the job of the load strip, authored names stay', () => {
    const { sensor: node } = pollutedSensor();
    node.add(mesh('Other_sensorRay'));
    raycastSensor(node).init(makeCtx());
    // init also runs when the editor ADDS a Sensor: it must never take an authored
    // child, so it touches the marker only (the load strip migrated old files before).
    for (const n of [...POLLUTED, 'Other_sensorRay']) expect(childNames(node), n).toContain(n);
    const marked = node.children.filter((c) => c.userData._rvRuntimeVisual === true);
    expect(marked.map((c) => c.name)).toEqual(['FunnelLightBarrier_sensorRay']);
  });

  it('a second init does not stack a second beam', () => {
    const node = new Object3D(); node.name = 'Sensor';
    const s = raycastSensor(node);
    s.init(makeCtx());
    s.init(makeCtx());
    expect(node.children.filter((c) => isSensorRuntimeVizName(c.name))).toHaveLength(1);
  });
});

describe('the runtime marker is never saved', () => {
  it('save + reload: no viz node and no marker in the file; a fresh init draws a new, marked beam', async () => {
    const root = new Group(); root.name = 'Asset';
    const node = new Object3D(); node.name = 'Barrier';
    node.userData.realvirtual = { Sensor: { UseRaycast: true, RayCastLength: 500 } };
    node.add(mesh('Housing'));
    root.add(node);
    const s = new RVSensor(node, new AABB());
    s.UseRaycast = true;
    s.RayCastLength = 500;
    s.init(makeCtx());
    expect(node.children.some((c) => c.userData._rvRuntimeVisual === true)).toBe(true);

    const glb = await exportAssetGlb(root, 'Asset');
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    let vizNodes = 0;
    let marked = 0;
    gltf.scene.traverse((n) => {
      if (isSensorRuntimeVizName(n.name)) vizNodes++;
      if ((n.userData as Record<string, unknown>)._rvRuntimeVisual !== undefined) marked++;
    });
    expect({ vizNodes, marked }).toEqual({ vizNodes: 0, marked: 0 });

    let reloaded: Object3D | null = null;
    gltf.scene.traverse((n) => { if (!reloaded && n.name === 'Barrier') reloaded = n; });
    expect(reloaded).not.toBeNull();
    const again = new RVSensor(reloaded!, new AABB());
    again.UseRaycast = true;
    again.RayCastLength = 500;
    again.init(makeCtx());
    const beams = reloaded!.children.filter((c) => isSensorRuntimeVizName(c.name));
    expect(beams.map((c) => c.name)).toEqual(['Barrier_sensorRay']);
    expect(beams[0].userData._rvRuntimeVisual).toBe(true);
  });
});
