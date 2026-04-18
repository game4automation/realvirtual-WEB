// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import { RVSafetyDoor } from '../src/core/engine/rv-safety-door';

function makeDoorNode(): Object3D {
  const root = new Object3D();
  root.name = 'TestDoor';
  const mesh = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshStandardMaterial());
  root.add(mesh);
  return root;
}

describe('RVSafetyDoor (demo)', () => {
  it('uses default schema values', () => {
    const c = new RVSafetyDoor(makeDoorNode());
    expect(c.HazardZoneRadius).toBe(1500);
    expect(c.LabelHeight).toBe(200);
  });

  it('init() creates an empty overlay group (outline + gizmos deferred to onSceneReady)', () => {
    const node = makeDoorNode();
    const c = new RVSafetyDoor(node);
    c.init({} as never);
    const overlay = node.children.find(ch => ch.name.startsWith('safetydoor:'));
    expect(overlay).toBeDefined();
    // init alone adds nothing — outline waits for onSceneReady (post-kinematic)
    expect(overlay!.children.length).toBe(0);
  });

  it('onSceneReady() builds the outline once children are in their final hierarchy', () => {
    const node = makeDoorNode();
    const c = new RVSafetyDoor(node);
    c.init({} as never);
    c.onSceneReady({} as never);
    const overlay = node.children.find(ch => ch.name.startsWith('safetydoor:'));
    expect(overlay).toBeDefined();
    // With a mesh present and gizmoManager omitted, only the outline is added locally
    expect(overlay!.children.length).toBe(1);
  });

  it('dispose() removes overlay and disposes geometries', () => {
    const node = makeDoorNode();
    const c = new RVSafetyDoor(node);
    c.init({} as never);
    c.dispose();
    const overlay = node.children.find(ch => ch.name.startsWith('safetydoor:'));
    expect(overlay).toBeUndefined();
  });

  it('handles a door node with no mesh children gracefully', () => {
    const node = new Object3D();
    node.name = 'EmptyDoor';
    const c = new RVSafetyDoor(node);
    expect(() => { c.init({} as never); c.dispose(); }).not.toThrow();
  });

  it('init+dispose can be called repeatedly without leaks', () => {
    const node = makeDoorNode();
    const c = new RVSafetyDoor(node);
    c.init({} as never);
    c.dispose();
    c.init({} as never); // re-init OK
    c.dispose();
    expect(node.children.find(ch => ch.name.startsWith('safetydoor:'))).toBeUndefined();
  });
});
