// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared sensor visualisation geometries (rv-shared-viz-geometry).
 *
 * Every placement of a library object with a sensor used to build its own ray
 * tube / collision box, so `renderer.info.memory.geometries` grew by one per
 * placement. Identical parameters now share ONE `BufferGeometry`, refcounted:
 * the geometry is disposed by the LAST `RVSensor.dispose()`, and the tree
 * dispose helpers skip it while another user is alive.
 */
import { describe, it, expect, vi } from 'vitest';
import { Object3D, Mesh, LineSegments } from 'three';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import { disposeSubtree } from '../src/core/engine/rv-traverse-utils';
import { disposeModelSubtree } from '../src/core/engine/rv-dispose-subtree';
import { sharedVizGeometries, sharedVizGeometryRefs } from '../src/core/engine/rv-shared-viz-geometry';

function raySensor(lengthMm: number, name = 'Sensor'): { node: Object3D; sensor: RVSensor; tube: Mesh } {
  const node = new Object3D(); node.name = name;
  const sensor = new RVSensor(node, new AABB());
  sensor.UseRaycast = true;
  sensor.RayCastLength = lengthMm;
  sensor.RayCastDirection = { x: 0, y: 0, z: 1 };
  sensor.createRayVisualization();
  const tube = node.children.find((c) => c.name === `${name}_sensorRay`) as Mesh;
  expect(tube).toBeInstanceOf(Mesh);
  return { node, sensor, tube };
}

function boxSensor(half: { x: number; y: number; z: number }, name = 'Sensor'): {
  node: Object3D; sensor: RVSensor; box: Mesh; edges: LineSegments;
} {
  const node = new Object3D(); node.name = name;
  const sensor = new RVSensor(node, new AABB());
  sensor.createVisualization({ x: 0, y: 0, z: 0 }, half);
  const box = node.children.find((c) => c.name === `${name}_sensorViz`) as Mesh;
  const edges = node.children.find((c) => c instanceof LineSegments) as LineSegments;
  expect(box).toBeInstanceOf(Mesh);
  expect(edges).toBeInstanceOf(LineSegments);
  return { node, sensor, box, edges };
}

describe('RVSensor shared ray-tube geometry', () => {
  it('two sensors with the same ray length share ONE BufferGeometry; a different length gets its own', () => {
    const a = raySensor(500, 'A');
    const b = raySensor(500, 'B');
    const c = raySensor(750, 'C');
    expect(a.tube.geometry).toBe(b.tube.geometry);
    expect(c.tube.geometry).not.toBe(a.tube.geometry);
    expect(sharedVizGeometryRefs(a.tube.geometry)).toBe(2);
    expect(sharedVizGeometryRefs(c.tube.geometry)).toBe(1);
    expect(sharedVizGeometries.has(a.tube.geometry)).toBe(true);
    // Pose/flags unchanged by the cache.
    expect(a.tube.frustumCulled).toBe(false);
    expect(a.tube.renderOrder).toBe(999);
    expect(a.tube.geometry.index).toBeNull(); // still non-indexed (WebGPU)
    a.sensor.dispose(); b.sensor.dispose(); c.sensor.dispose();
  });

  it('dispose() of the first user keeps the shared geometry, the last user frees it', () => {
    const a = raySensor(600, 'A');
    const b = raySensor(600, 'B');
    const geo = a.tube.geometry;
    const spy = vi.spyOn(geo, 'dispose');

    a.sensor.dispose();
    expect(spy).not.toHaveBeenCalled();
    expect(sharedVizGeometryRefs(geo)).toBe(1);
    expect(a.node.children).not.toContain(a.tube); // detached from its node

    b.sensor.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sharedVizGeometryRefs(geo)).toBe(0);
    expect(sharedVizGeometries.has(geo)).toBe(false);

    // Idempotent: a second dispose must not double-release.
    b.sensor.dispose();
    expect(spy).toHaveBeenCalledTimes(1);

    // A fresh acquire after the last release builds a NEW instance.
    const d = raySensor(600, 'D');
    expect(d.tube.geometry).not.toBe(geo);
    d.sensor.dispose();
  });

  it('disposeSubtree / disposeModelSubtree over a node with a ray tube leave the shared geometry intact', () => {
    const a = raySensor(400, 'A');
    const b = raySensor(400, 'B');
    const geo = a.tube.geometry;
    const spy = vi.spyOn(geo, 'dispose');
    const matSpy = vi.spyOn(a.tube.material as { dispose(): void }, 'dispose');

    disposeSubtree(a.node);
    disposeModelSubtree(b.node);
    expect(spy).not.toHaveBeenCalled();
    expect(matSpy).not.toHaveBeenCalled(); // shared ray material skipped too
    expect(sharedVizGeometryRefs(geo)).toBe(2);

    a.sensor.dispose();
    expect(spy).not.toHaveBeenCalled();
    b.sensor.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('RVSensor shared collision-box geometry', () => {
  it('same size shares box AND edges geometry; different size does not', () => {
    const a = boxSensor({ x: 0.1, y: 0.05, z: 0.2 }, 'A');
    const b = boxSensor({ x: 0.1, y: 0.05, z: 0.2 }, 'B');
    const c = boxSensor({ x: 0.1, y: 0.05, z: 0.3 }, 'C');
    expect(a.box.geometry).toBe(b.box.geometry);
    expect(a.edges.geometry).toBe(b.edges.geometry);
    expect(c.box.geometry).not.toBe(a.box.geometry);
    expect(c.edges.geometry).not.toBe(a.edges.geometry);
    expect(sharedVizGeometryRefs(a.box.geometry)).toBe(2);
    expect(sharedVizGeometryRefs(a.edges.geometry)).toBe(2);
    expect(a.box.renderOrder).toBe(999);
    expect(a.box.name).toBe('A_sensorViz');
    a.sensor.dispose(); b.sensor.dispose(); c.sensor.dispose();
  });

  it('tree dispose keeps box + edges while a second user lives; last dispose() frees both', () => {
    const a = boxSensor({ x: 0.2, y: 0.2, z: 0.2 }, 'A');
    const b = boxSensor({ x: 0.2, y: 0.2, z: 0.2 }, 'B');
    const boxSpy = vi.spyOn(a.box.geometry, 'dispose');
    const edgesSpy = vi.spyOn(a.edges.geometry, 'dispose');

    disposeSubtree(a.node);
    disposeModelSubtree(a.node);
    expect(boxSpy).not.toHaveBeenCalled();
    expect(edgesSpy).not.toHaveBeenCalled();

    a.sensor.dispose();
    expect(boxSpy).not.toHaveBeenCalled();
    expect(edgesSpy).not.toHaveBeenCalled();
    expect(a.node.children).toHaveLength(0);

    b.sensor.dispose();
    expect(boxSpy).toHaveBeenCalledTimes(1);
    expect(edgesSpy).toHaveBeenCalledTimes(1);
  });
});
