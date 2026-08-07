// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { computeBeamFromBounds, findRayChild, RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

describe('computeBeamFromBounds — sensor auto-ray', () => {
  it('beams along the longest box edge (Z), from min-face centre to max-face centre', () => {
    const mesh = new Mesh(new BoxGeometry(0.1, 0.1, 0.5), new MeshBasicMaterial());
    const beam = computeBeamFromBounds(mesh);
    expect(beam).not.toBeNull();
    expect(beam!.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(beam!.lengthMm).toBeCloseTo(500);          // 0.5 m extent
    expect(beam!.originOffset.x).toBeCloseTo(0);       // centred on the short axes
    expect(beam!.originOffset.y).toBeCloseTo(0);
    expect(beam!.originOffset.z).toBeCloseTo(-0.25);   // centre of the min face
  });

  it('picks X when X is the longest edge', () => {
    const mesh = new Mesh(new BoxGeometry(0.8, 0.1, 0.2), new MeshBasicMaterial());
    const beam = computeBeamFromBounds(mesh)!;
    expect(beam.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(beam.lengthMm).toBeCloseTo(800);
    expect(beam.originOffset.x).toBeCloseTo(-0.4);
  });

  it('aggregates geometry across child meshes (node-local bounds)', () => {
    const root = new Object3D();
    const a = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    a.position.set(0, 0, -0.2);
    const b = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    b.position.set(0, 0, 0.2);
    root.add(a, b);
    const beam = computeBeamFromBounds(root)!;
    // Combined span on Z: -0.25 .. 0.25 → 0.5 m, longest axis Z.
    expect(beam.direction).toEqual({ x: 0, y: 0, z: 1 });
    expect(beam.lengthMm).toBeCloseTo(500);
    expect(beam.originOffset.z).toBeCloseTo(-0.25);
  });

  it('returns null for a node with no geometry', () => {
    expect(computeBeamFromBounds(new Object3D())).toBeNull();
  });
});

describe('computeBeamFromBounds — Ray child override', () => {
  function makeSensorWithRay(): { root: Object3D; ray: Mesh } {
    // Housing geometry is longest on X (would beam along X if used).
    const root = new Object3D(); root.name = 'Sensor';
    const housing = new Mesh(new BoxGeometry(0.8, 0.1, 0.2), new MeshBasicMaterial());
    root.add(housing);
    // Ray marker is longest on Z and offset off-centre.
    const ray = new Mesh(new BoxGeometry(0.05, 0.05, 0.4), new MeshBasicMaterial());
    ray.name = 'Ray';
    ray.position.set(0, 0, 0.1);
    root.add(ray);
    return { root, ray };
  }

  it('uses the Ray child bounds, ignoring the housing geometry', () => {
    const { root, ray } = makeSensorWithRay();
    const beam = computeBeamFromBounds(root, findRayChild(root))!;
    expect(beam.direction).toEqual({ x: 0, y: 0, z: 1 });   // Ray axis, not housing X
    expect(beam.lengthMm).toBeCloseTo(400);                  // 0.4 m Ray extent
    expect(beam.originOffset.x).toBeCloseTo(0);
    expect(beam.originOffset.y).toBeCloseTo(0);
    expect(beam.originOffset.z).toBeCloseTo(-0.1);           // min face: 0.1 - 0.2
    void ray;
  });

  it('falls back to full-node bounds when the Ray marker has no geometry', () => {
    const root = new Object3D(); root.name = 'Sensor';
    const housing = new Mesh(new BoxGeometry(0.8, 0.1, 0.2), new MeshBasicMaterial());
    root.add(housing);
    const ray = new Object3D(); ray.name = 'Ray'; root.add(ray);   // empty marker
    const beam = computeBeamFromBounds(root, findRayChild(root))!;
    expect(beam.direction).toEqual({ x: 1, y: 0, z: 0 });   // housing X axis
    expect(beam.lengthMm).toBeCloseTo(800);
  });

  it('findRayChild locates the Ray node and returns null when absent', () => {
    const { root, ray } = makeSensorWithRay();
    expect(findRayChild(root)).toBe(ray);
    const bare = new Object3D(); bare.name = 'Sensor';
    bare.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.5), new MeshBasicMaterial()));
    expect(findRayChild(bare)).toBeNull();
  });

  it('findRayChild tolerates glTF/Unity duplicate-name suffixes on the Ray child', () => {
    // Two sensors each authored a "Ray" child → the glTF loader renames the
    // second to "Ray_1". A node named just "Ray" must NOT be required.
    for (const rayName of ['Ray_1', 'Ray_2', 'Ray (1)', 'Ray_(1)']) {
      const s = new Object3D(); s.name = 'Sensor-2';
      const ray = new Mesh(new BoxGeometry(0.05, 0.05, 0.4), new MeshBasicMaterial());
      ray.name = rayName;
      s.add(ray);
      expect(findRayChild(s)).toBe(ray);
    }
    // Guard against over-matching unrelated names.
    const s = new Object3D(); s.name = 'Sensor';
    s.add(Object.assign(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial()), { name: 'RayCast' }));
    s.add(Object.assign(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial()), { name: 'Ray_Beam' }));
    expect(findRayChild(s)).toBeNull();
  });
});

describe('RVSensor — signal-free loading (plan-317)', () => {
  function makeCtx() {
    const registered: { name: string; path: string }[] = [];
    const ctx = {
      signalStore: {
        register: (name: string, path: string) => { registered.push({ name, path }); },
        set: () => {},
        setByPath: () => {},
      },
      transportManager: { sensors: [] },
    } as unknown as ComponentContext;
    return { ctx, registered };
  }

  it('registers no signal when inside a LayoutObject root', () => {
    const root = new Object3D(); root.name = 'RollConveyor2m_2';
    root.userData.realvirtual = { LayoutObject: { Label: 'x', CatalogId: 'c', Locked: false } };
    const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; root.add(sensorNode);
    const sensor = new RVSensor(sensorNode, new AABB());
    const { ctx, registered } = makeCtx();
    sensor.init(ctx);
    // plan-317 §2.1: loading registers NO sensor signal; the occupancy is
    // exposed as a bindable direct-feedback slot instead.
    expect(registered).toEqual([]);
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(false);
    expect(sensor.readFeedbackSlot('SensorNotOccupied')).toBe(true);
  });

  it('registers no signal when standalone (no LayoutObject)', () => {
    const root = new Object3D(); root.name = 'Scene';
    const sensorNode = new Object3D(); sensorNode.name = 'Sensor'; root.add(sensorNode);
    const sensor = new RVSensor(sensorNode, new AABB());
    const { ctx, registered } = makeCtx();
    sensor.init(ctx);
    expect(registered).toEqual([]);
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(false);
  });

  it('AutoRay derives the beam from a Ray child and hides the marker', () => {
    const sensorNode = new Object3D(); sensorNode.name = 'Sensor';
    const housing = new Mesh(new BoxGeometry(0.8, 0.1, 0.2), new MeshBasicMaterial());
    sensorNode.add(housing);
    const ray = new Mesh(new BoxGeometry(0.05, 0.05, 0.4), new MeshBasicMaterial());
    ray.name = 'Ray';
    sensorNode.add(ray);

    const sensor = new RVSensor(sensorNode, new AABB());
    sensor.AutoRay = true;
    const { ctx } = makeCtx();
    sensor.init(ctx);

    expect(sensor.UseRaycast).toBe(true);
    expect(sensor.RayCastDirection).toEqual({ x: 0, y: 0, z: 1 }); // Ray axis, not housing X
    expect(sensor.RayCastLength).toBeCloseTo(400);
    expect(ray.visible).toBe(false); // marker hidden once used
  });
});
