// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { exportRuntimeStage } from '../src/core/usd/runtime-stage-export';

describe('runtime stage sensor helpers', () => {
  it('exports authored geometry but no visible sensor ray prim or geometry, and excludes the ray from the baseline', async () => {
    const root = new Object3D(); root.name = 'Cell';
    const node = new Object3D(); node.name = 'Detector'; root.add(node);
    const housing = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    // A helper-looking authored name must still survive: exclusion uses the marker.
    housing.name = 'Housing_sensorRay'; node.add(housing);
    const sensor = new RVSensor(node, new AABB());
    sensor.UseRaycast = true;
    sensor.RayCastLength = 500;
    sensor.ShowGizmo = true;
    // Exercise the real public visualization builder without a simulated transport host.
    sensor.createRayVisualization();
    try {
      const ray = node.children.find((child) => child.name === 'Detector_sensorRay') as Mesh;
      expect(ray).toBeDefined();
      expect(ray.isMesh).toBe(true);
      expect(ray.visible).toBe(true);
      expect(ray.geometry.getAttribute('position').count).toBeGreaterThan(0);
      expect(ray.geometry).not.toBe(housing.geometry);

      const snapshot = await exportRuntimeStage({ root, templates: [], exclude: new Set(), preplaced: [] });
      const files = unzipSync(snapshot.usdz);
      const model = strFromU8(files['model.usda']);
      const primNames = Array.from(model.matchAll(/def Xform "([^"]+)"/g), (match) => match[1]);
      expect(primNames).toContain(node.name);
      expect(primNames).toContain(housing.name);
      expect(primNames).not.toContain(ray.name);
      expect(model).not.toContain(ray.name);
      // Read actual geometry references and archive paths; no dependency on isStageHelper.
      const references = Array.from(model.matchAll(/@\.\/(geometries\/[^@]+)@/g), (match) => match[1]);
      const geometryFiles = Object.keys(files).filter((path) => path.startsWith('geometries/'));
      expect(references).toHaveLength(1);
      expect(geometryFiles).toEqual(references);
      expect(strFromU8(files[references[0]])).toContain('def Mesh');

      expect(snapshot.structure).toBeDefined();
      const sensorIndex = snapshot.nodes.indexOf(node);
      expect(sensorIndex).toBeGreaterThanOrEqual(0);
      expect(snapshot.structure!.childCount[sensorIndex]).toBe(1);
      expect(snapshot.nodes).toContain(housing);
      expect(snapshot.nodes).not.toContain(ray);
    } finally {
      sensor.dispose();
      housing.geometry.dispose();
      housing.material.dispose();
    }
  });
});
