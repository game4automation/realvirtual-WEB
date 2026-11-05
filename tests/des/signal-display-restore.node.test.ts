// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene } from 'three';
import { RVLamp } from '../../src/core/engine/rv-lamp';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { wireDisplaySignal, wireValueSignal } from '../../src/core/engine/rv-signal-wiring';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';

describe('silent signal restore display consumers', () => {
  it('restores lamp on/flashing state and optics without replaying command inputs', () => {
    const scene = new Scene();
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    scene.add(mesh);
    const store = new SignalStore();
    store.register('on', 'Signals/on', false);
    store.register('flash', 'Signals/flash', false);
    const lamp = new RVLamp(mesh);
    lamp.SignalLampOn = 'Signals/on'; lamp.SingalLampFlashing = 'Signals/flash';
    lamp.init({ scene, root: scene, registry: new NodeRegistry(), signalStore: store,
      transportManager: new RVTransportManager() });
    const command = vi.fn();
    const offCommand = wireValueSignal(store, 'Signals/on', command).unsubscribe;
    command.mockClear();
    const writes = vi.fn(); store.observeWrites(writes);
    store.restoreValuesSilently(new Map([['on', true], ['flash', false]]));
    expect(lamp.LampOn).toBe(true); expect(lamp.isLit()).toBe(true);
    expect((mesh.material as MeshStandardMaterial).emissiveIntensity).toBe(2);
    store.restoreValuesSilently(new Map([['on', false], ['flash', true]]));
    expect(lamp.Flashing).toBe(true); expect(lamp.isLit()).toBe(true);
    lamp.updateBlink(0.75); expect(lamp.isLit()).toBe(false);
    store.restoreValuesSilently(new Map([['on', true], ['flash', false]]));
    expect(lamp.Flashing).toBe(false); expect(lamp.isLit()).toBe(true);
    expect(command).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    lamp.reapplyConfig();
    lamp.dispose();
    store.restoreValuesSilently(new Map([['on', false], ['flash', true]]));
    expect(lamp.LampOn).toBe(true); expect(lamp.Flashing).toBe(false);
    offCommand(); mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose();
  });

  it('refreshes raw display values and unsubscribes both subscriptions', () => {
    const store = new SignalStore(); store.register('value', 'Signals/value', 0);
    const display = vi.fn();
    const wire = wireDisplaySignal(store, 'Signals/value', display);
    store.restoreValuesSilently(new Map([['value', 42]]));
    expect(display).toHaveBeenLastCalledWith(42);
    wire.unsubscribe(); display.mockClear();
    store.restoreValuesSilently(new Map([['value', 7]])); store.set('value', 8);
    expect(display).not.toHaveBeenCalled();
  });
});
