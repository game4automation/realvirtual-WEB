// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-integration.test.ts — plan-417 §9.6.
 *
 * The real demo hierarchy, end to end: a pointer event has to reach the
 * `SceneButtonBase` through the ComponentEventDispatcher's parent walk — even
 * on the emergency button, whose node carries `SceneButtonMoveable` AND
 * `SceneButtonBase` at once (the registry used to keep only the first). Plus
 * the lifecycle edges: a button placed at runtime, and a model reload.
 */

import { describe, expect, it, vi } from 'vitest';
import { Mesh, Object3D } from 'three';
import { ComponentEventDispatcher } from '../src/core/engine/rv-component-event-dispatcher';
import {
  getComponentInstances,
  removeComponentInstance,
  setComponentInstance,
} from '../src/core/engine/rv-component-registry';
import { constructComponentOnNode, type RuntimeNodeDeps } from '../src/core/engine/rv-scene-loader';
import { RVSceneButtonBase } from '../src/core/engine/rv-scene-button-base';
import { RVSceneButtonMoveable } from '../src/core/engine/rv-scene-button-moveable';
import type { ViewerHost } from '../src/core/engine/rv-viewer-host';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { buildButtonScene, PATHS } from './scene-button-fixture';

function mockViewer() {
  const listeners: Record<string, Array<(data: unknown) => void>> = {};
  return {
    on(ev: string, cb: (data: unknown) => void) {
      (listeners[ev] ||= []).push(cb);
      return () => {
        const arr = listeners[ev] || [];
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(ev: string, data: unknown) {
      (listeners[ev] || []).forEach((cb) => cb(data));
    },
  } as unknown as ViewerHost & { emit(ev: string, data: unknown): void };
}

describe('SceneButton integration with the real demo hierarchy', () => {
  it('routes a click on the base node to the SceneButtonBase', () => {
    const h = buildButtonScene();
    const viewer = mockViewer();
    new ComponentEventDispatcher(viewer, h.registry);

    const base = h.base(PATHS.pushBase);
    viewer.emit('object-clicked', { node: base.node, path: PATHS.pushBase });
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);
  });

  it('reaches the SceneButtonBase on a node that ALSO carries a Moveable', () => {
    const h = buildButtonScene();
    const viewer = mockViewer();
    new ComponentEventDispatcher(viewer, h.registry);

    const node = h.base(PATHS.emergencyNode).node;
    // Both components live on this one node — the ordered instance list is the
    // reason the click is not swallowed by the Moveable (which has no onClick).
    const instances = getComponentInstances(node);
    expect(instances).toHaveLength(2);
    expect(instances.some((i) => i instanceof RVSceneButtonMoveable)).toBe(true);
    expect(instances.some((i) => i instanceof RVSceneButtonBase)).toBe(true);

    viewer.emit('object-clicked', { node, path: PATHS.emergencyNode });
    expect(h.signalStore.getByPath(PATHS.emergencySignal)).toBe(true);
  });

  it('routes hover to the base and drives the cap hover offset', () => {
    const h = buildButtonScene();
    const viewer = mockViewer();
    new ComponentEventDispatcher(viewer, h.registry);
    const cap = h.cap(PATHS.pushCap);
    const base = h.base(PATHS.pushBase);

    viewer.emit('object-hover', { node: base.node });
    for (let i = 0; i < 60; i++) h.sceneButtonManager.update(1 / 60);
    expect(cap.currentOffset).toBeCloseTo(cap.hoverOffset, 6);

    viewer.emit('object-unhover', {});
    for (let i = 0; i < 60; i++) h.sceneButtonManager.update(1 / 60);
    expect(cap.currentOffset).toBeCloseTo(0, 6);
  });

  it('a click on a mesh below the base still finds it via the parent walk', () => {
    const h = buildButtonScene();
    const viewer = mockViewer();
    new ComponentEventDispatcher(viewer, h.registry);

    const child = new Object3D();
    child.name = 'Sticker';
    h.base(PATHS.pushBase).node.add(child);

    viewer.emit('object-clicked', { node: child, path: `${PATHS.pushBase}/Sticker` });
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);
  });

  it('a real click visibly moves the frozen cap, not just its logical pose', () => {
    const h = buildButtonScene();
    const viewer = mockViewer();
    new ComponentEventDispatcher(viewer, h.registry);
    const cap = h.cap(PATHS.pushCap);
    const capMesh = cap.capMesh!;

    h.scene.updateMatrixWorld();
    const before = capMesh.matrixWorld.clone();

    viewer.emit('object-clicked', { node: h.base(PATHS.pushBase).node, path: PATHS.pushBase });
    // The signal firing is NOT proof the user saw anything — the matrix is.
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);

    // Stay inside the 0.3 s momentary hold, then do what the renderer does.
    for (let i = 0; i < 15; i++) h.sceneButtonManager.update(1 / 60);
    h.scene.updateMatrixWorld();

    expect(cap.currentOffset).not.toBe(0);
    expect(capMesh.matrixWorld.equals(before)).toBe(false);
  });

  it('a cap placed at runtime animates and cleans up again', () => {
    const h = buildButtonScene();
    const deps: RuntimeNodeDeps = {
      registry: h.registry,
      signalStore: h.signalStore,
      scene: h.scene,
      transportManager: h.transportManager,
      sceneButtonManager: h.sceneButtonManager,
    };
    const before = h.sceneButtonManager.size;

    const node = new Object3D();
    node.name = 'LateCap';
    h.root.add(node);
    h.registry.registerNode('DemoCell/LateCap', node);
    const capMesh = new Mesh();
    capMesh.name = 'Cap';
    node.add(capMesh);

    const cap = constructComponentOnNode(deps, node, 'SceneButtonMoveable', {
      axis: { x: 0, y: 0, z: 1 },
      moveSpeed: 30,
      hoverOffset: 0.01,
      activeOffset: 0,
    }) as RVSceneButtonMoveable;

    expect(h.sceneButtonManager.size).toBe(before + 1);
    expect(capMesh.userData._rvSceneButtonMesh).toBe(true);

    cap.hover();
    for (let i = 0; i < 60; i++) h.sceneButtonManager.update(1 / 60);
    expect(cap.currentOffset).toBeCloseTo(0.01, 6);

    cap.dispose();
    expect(h.sceneButtonManager.size).toBe(before);
    expect(capMesh.userData._rvSceneButtonMesh).toBeUndefined();
  });

  it('a model reload leaves no registered members and no stale references', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);
    const capNode = h.cap(PATHS.pushCap).capMesh!;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    h.sceneButtonManager.clear();
    expect(h.sceneButtonManager.size).toBe(0);
    expect(capNode.userData._rvSceneButtonMesh).toBeUndefined();
    // Instances detached themselves from their nodes.
    expect(getComponentInstances(base.node)).toHaveLength(0);

    // Ticking and clicking a torn-down button must stay silent.
    expect(h.sceneButtonManager.update(1 / 60)).toBe(false);
    expect(() => base.onClick()).not.toThrow();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('removeComponentInstance promotes the next instance of a shared node', () => {
    const node = new Object3D();
    const a = { node, isOwner: true, init: () => {} };
    const b = { node, isOwner: true, init: () => {} };
    setComponentInstance(node, a);
    setComponentInstance(node, b);
    expect(node.userData._rvComponentInstance).toBe(a);   // first-writer wins
    expect(getComponentInstances(node)).toEqual([a, b]);

    removeComponentInstance(node, a);
    expect(node.userData._rvComponentInstance).toBe(b);
    removeComponentInstance(node, b);
    expect(node.userData._rvComponentInstance).toBeUndefined();
    expect(getComponentInstances(node)).toHaveLength(0);
  });

  it('the dispatcher still works for a node stamped without the instance list', () => {
    const viewer = mockViewer();
    new ComponentEventDispatcher(viewer, {} as NodeRegistry);
    const node = new Object3D();
    const onClick = vi.fn();
    // Components that define `_rvComponentInstance` themselves (WebSensor & co).
    node.userData._rvComponentInstance = { node, isOwner: true, init: () => {}, onClick };

    viewer.emit('object-clicked', { node, path: 'x' });
    expect(onClick).toHaveBeenCalled();
  });
});
