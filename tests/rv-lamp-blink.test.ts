// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

function flashingLamp(period = 1) {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Lamp';
  node.userData.realvirtual = { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } };
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  node.add(mesh);
  scene.add(node);
  const registry = new NodeRegistry();
  registry.registerNode('Lamp', node);
  const manager = new LampManager();
  const lamp = new RVLamp(node);
  lamp.Flashing = true;
  lamp.Period = period;
  lamp.init({
    registry,
    signalStore: new SignalStore(),
    scene,
    root: scene,
    lampManager: manager,
  } as any);
  return { lamp, manager, mesh };
}

describe('LampManager symmetric blink cycle', () => {
  it('uses Period/2 for both halves including the first cycle', () => {
    const { lamp, manager } = flashingLamp(1);
    expect(lamp.isLit()).toBe(true);
    expect(manager.update(0.49)).toBe(false);
    expect(lamp.isLit()).toBe(true);
    expect(manager.update(0.01)).toBe(true);
    expect(lamp.isLit()).toBe(false);
    expect(manager.update(0.49)).toBe(false);
    expect(manager.update(0.01)).toBe(true);
    expect(lamp.isLit()).toBe(true);
  });

  it('treats non-positive periods as steady light', () => {
    const { lamp, manager } = flashingLamp(0);
    expect(lamp.isLit()).toBe(true);
    expect(manager.update(10)).toBe(false);
    lamp.Period = -2;
    expect(manager.update(10)).toBe(false);
    expect(lamp.isLit()).toBe(true);
  });

  it('reduces large dt by modulo without replaying missed cycles', () => {
    const { lamp, manager } = flashingLamp(1);
    expect(manager.update(2.75)).toBe(true);
    expect(lamp.isLit()).toBe(false);
  });

  it('restarts symmetrically when Period changes through reapplyConfig', () => {
    const { lamp, manager } = flashingLamp(1);
    manager.update(0.6);
    expect(lamp.isLit()).toBe(false);
    lamp.Period = 2;
    lamp.reapplyConfig();
    expect(lamp.isLit()).toBe(true);
    expect(manager.update(0.99)).toBe(false);
    expect(manager.update(0.01)).toBe(true);
    expect(lamp.isLit()).toBe(false);
  });
});
