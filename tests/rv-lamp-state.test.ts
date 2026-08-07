// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

function setup(signal: string | null, lampOn = false) {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Lamp';
  node.userData.realvirtual = {
    Lamp: { OnColor: { r: 0.1, g: 0.5, b: 1, a: 1 } },
  };
  scene.add(node);

  const registry = new NodeRegistry();
  registry.registerNode('Lamp', node);
  const signalStore = new SignalStore();
  if (signal) signalStore.register('LampOn', signal, false);

  const lamp = new RVLamp(node);
  lamp.SignalLampOn = signal;
  lamp.LampOn = lampOn;
  lamp.init({ scene, root: scene, registry, signalStore } as any);
  return { lamp, signalStore };
}

describe('RVLamp state binding', () => {
  it('tracks its bool signal and parses OnColor from raw rv_extras', () => {
    const { lamp, signalStore } = setup('Signals/LampOn');
    expect(lamp.getOnColorHex()).toBe(0x1a80ff);
    expect(lamp.isLit()).toBe(false);
    signalStore.set('LampOn', true);
    expect(lamp.isLit()).toBe(true);
    signalStore.set('LampOn', false);
    expect(lamp.isLit()).toBe(false);
  });

  it('keeps the authored LampOn state without a bound signal', () => {
    const { lamp } = setup(null, true);
    expect(lamp.isLit()).toBe(true);
  });
});
