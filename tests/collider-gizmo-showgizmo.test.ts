// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * collider-gizmo-showgizmo.test.ts — the Inspector `ShowGizmo` toggle of a
 * Sensor / WebPhysicsZone also hides the BoxCollider box on the same node, and
 * a WebPhysicsZone field edit creates / removes its own wireframe live.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVBoxCollider } from '../src/core/engine/rv-box-collider';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import { setComponentInstance } from '../src/core/engine/rv-component-registry';
import type { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

interface FakeHandle { root: Object3D; visible: boolean; disposed: boolean; setVisible(v: boolean): void; dispose(): void }

function fakeGizmoManager(): { gm: GizmoOverlayManager; handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const gm = {
    create: () => {
      const h: FakeHandle = {
        root: new Object3D(), visible: true, disposed: false,
        setVisible(v: boolean) { this.visible = v; },
        dispose() { this.disposed = true; },
      };
      handles.push(h);
      return h;
    },
  } as unknown as GizmoOverlayManager;
  return { gm, handles };
}

function colliderOn(node: Object3D, gm: GizmoOverlayManager): RVBoxCollider {
  const col = new RVBoxCollider(node);
  setComponentInstance(node, col);
  col.attachGizmo(gm);
  return col;
}

const BOX = { x: 0.2, y: 0.2, z: 0.2 };

describe('BoxCollider gizmo follows the owner ShowGizmo', () => {
  it('a collider without an owner always shows its box', () => {
    const { gm } = fakeGizmoManager();
    const col = colliderOn(new Object3D(), gm);
    expect((col.gizmo.edges as unknown as FakeHandle).visible).toBe(true);
  });

  it('Sensor.ShowGizmo hides and shows the collider box', () => {
    const { gm } = fakeGizmoManager();
    const node = new Object3D();
    const sensor = new RVSensor(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, BOX));
    setComponentInstance(node, sensor);
    const col = colliderOn(node, gm);
    const edges = col.gizmo.edges as unknown as FakeHandle;
    const faces = col.gizmo.faces as unknown as FakeHandle;

    sensor.ShowGizmo = false;
    expect(edges.visible).toBe(false);
    expect(faces.visible).toBe(false);
    sensor.ShowGizmo = true;
    expect(edges.visible).toBe(true);
    expect(faces.visible).toBe(true);
  });

  it('a collider built after a hidden Sensor starts hidden', () => {
    const { gm } = fakeGizmoManager();
    const node = new Object3D();
    const sensor = new RVSensor(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, BOX));
    setComponentInstance(node, sensor);
    sensor.ShowGizmo = false;
    const col = colliderOn(node, gm);
    expect((col.gizmo.edges as unknown as FakeHandle).visible).toBe(false);
  });

  it('WebPhysicsZone.reapplyConfig removes / recreates its wireframe and toggles the collider box', () => {
    const { gm, handles } = fakeGizmoManager();
    const node = new Object3D();
    const zone = new RVPhysicsZone(node, AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, BOX));
    setComponentInstance(node, zone);
    const col = colliderOn(node, gm);
    zone.attachGizmo(gm);
    const zoneGizmo = handles[handles.length - 1];
    expect(zoneGizmo.disposed).toBe(false);

    zone.ShowGizmo = false;
    zone.reapplyConfig();
    expect(zoneGizmo.disposed).toBe(true);
    expect((col.gizmo.edges as unknown as FakeHandle).visible).toBe(false);

    const before = handles.length;
    zone.ShowGizmo = true;
    zone.reapplyConfig();
    expect(handles.length).toBe(before + 1);
    expect((col.gizmo.edges as unknown as FakeHandle).visible).toBe(true);
  });
});
