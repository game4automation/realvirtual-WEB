// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { SignalBindPlugin } from '../src/plugins/signal-bind/SignalBindPlugin';
import { signalBindStore } from '../src/plugins/signal-bind/signal-bind-store';
import {
  _resetSignalLinkModeStoreForTests,
  setSignalLinkModeExplicit,
} from '../src/plugins/signal-bind/signal-link-mode-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

function makeHarness() {
  const root = new Scene();
  const machine = new Object3D();
  machine.name = 'Machine';
  machine.userData.realvirtual = {
    Conveyor: {},
    SignalLinks: {
      Mappings: [{
        slot: 'Flow.Run', signal: 'External.Run', interfaceId: 'mqtt-main',
        direction: 'plcInput', enabled: true,
      }],
    },
  };
  root.add(machine);

  const registry = new NodeRegistry();
  registry.registerNode('Machine', machine);
  const store = new SignalStore();
  store.register('Flow.Run', 'Machine/Signals/Flow.Run', false, 'PLCInputBool');
  store.register('External.Run', 'Connect/External.Run', true, 'PLCInputBool');
  const manager = new SignalBindingManager(store, registry);
  const listeners = new Map<string, Set<(event: { node: Object3D }) => void>>();
  const viewer = {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    gizmoManager: {
      create: () => ({
        id: 'signal-badge',
        root: new Object3D(),
        update: () => {},
        setVisible: () => {},
        dispose: () => {},
      }),
    },
    markRenderDirty: () => {},
    getPlugin: () => undefined,
    on: (event: string, callback: (payload: { node: Object3D }) => void) => {
      let callbacks = listeners.get(event);
      if (!callbacks) { callbacks = new Set(); listeners.set(event, callbacks); }
      callbacks.add(callback);
      return () => callbacks!.delete(callback);
    },
  } as unknown as RVViewer;
  const result = { root } as unknown as LoadResult;
  const emitClick = () => {
    for (const callback of listeners.get('object-clicked') ?? []) callback({ node: machine });
  };
  return { viewer, result, machine, manager, listeners, emitClick };
}

describe('SignalBindPlugin lifecycle', () => {
  beforeEach(() => {
    signalBindStore.clear();
    localStorage.clear();
    _resetSignalLinkModeStoreForTests();
  });

  it('is core so selective rv_plugins mode cannot omit it', () => {
    expect(new SignalBindPlugin().core).toBe(true);
  });

  it('restores node mappings, opens on click, tears down, and installs exactly once after reload', () => {
    const h = makeHarness();
    const plugin = new SignalBindPlugin();
    plugin.init(h.viewer);

    plugin.onModelLoaded(h.result, h.viewer);
    h.manager.tick(0.02);
    expect(h.manager.getElementState('Machine')).toBe('live');
    expect(h.listeners.get('object-clicked')?.size).toBe(1);

    // Outside the signal-link mode a scene click must NOT surface the popover —
    // the click-to-open path belongs to the link workflow only.
    h.emitClick();
    expect(signalBindStore.getSnapshot()).toBeNull();

    setSignalLinkModeExplicit(true);
    h.emitClick();
    expect(signalBindStore.getSnapshot()).toMatchObject({ kind: 'node', nodePath: 'Machine' });

    plugin.onModelCleared();
    expect(h.listeners.get('object-clicked')?.size ?? 0).toBe(0);
    expect(signalBindStore.getSnapshot()).toBeNull();

    // Reload with link mode still on: plugin + badge controller each install their
    // click listener exactly once (2 total — not 3, not 4).
    plugin.onModelLoaded(h.result, h.viewer);
    expect(h.listeners.get('object-clicked')?.size).toBe(2);
    h.emitClick();
    expect(signalBindStore.getSnapshot()).toMatchObject({ kind: 'node', nodePath: 'Machine' });

    plugin.dispose();
    expect(h.listeners.get('object-clicked')?.size ?? 0).toBe(0);
  });
});
